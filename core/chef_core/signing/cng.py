"""Signing with a certificate from the Windows certificate store through CNG (T4.11, I8).

The private key stays in the key storage provider (for example a smart card minidriver or the
Microsoft Software Key Storage Provider). Only the hash leaves the store: ``NCryptSignHash`` signs
the digest with RSA PKCS#1 v1.5. Keys that only the legacy CryptoAPI provider can use are refused.

Windows only. On other systems every entry point raises ``UNSUPPORTED_PLATFORM``. The Windows
calls go through ctypes (crypt32 and ncrypt), so no extra dependency is needed.
"""

from __future__ import annotations

import ctypes
import hashlib
import sys
import warnings
from ctypes import wintypes
from dataclasses import dataclass
from typing import Any

from asn1crypto import x509 as asn1_x509
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from pyhanko.sign.signers.pdf_cms import Signer
from pyhanko_certvalidator.registry import SimpleCertificateStore

from chef_core.errors import ChefError, ErrorKind
from chef_core.signing.pfx import PfxCertificate

CERT_HASH_PROP_ID = 3
CRYPT_ACQUIRE_SILENT_FLAG = 0x40
CRYPT_ACQUIRE_ALLOW_NCRYPT_KEY_FLAG = 0x10000
CERT_NCRYPT_KEY_SPEC = 0xFFFFFFFF
BCRYPT_PAD_PKCS1 = 0x2
X509_ASN_ENCODING = 0x1
PKCS_7_ASN_ENCODING = 0x10000
CERT_ENCODING = X509_ASN_ENCODING | PKCS_7_ASN_ENCODING
STORES_FOR_CHAIN = ("CA", "ROOT")
HASH_ALGORITHM_NAMES = {"sha1": "SHA1", "sha256": "SHA256", "sha384": "SHA384", "sha512": "SHA512"}


def _unsupported() -> ChefError:
    return ChefError(
        ErrorKind.SIGN_FAILED,
        "The Windows certificate store is only available on Windows.",
        {"platform": sys.platform},
    )


class _CertContext(ctypes.Structure):
    _fields_ = [
        ("dwCertEncodingType", wintypes.DWORD),
        ("pbCertEncoded", ctypes.POINTER(ctypes.c_ubyte)),
        ("cbCertEncoded", wintypes.DWORD),
        ("pCertInfo", ctypes.c_void_p),
        ("hCertStore", ctypes.c_void_p),
    ]


class _PkcsPaddingInfo(ctypes.Structure):
    _fields_ = [("pszAlgId", wintypes.LPCWSTR)]


_CertCtxPtr = ctypes.POINTER(_CertContext)


def _load_api() -> tuple[Any, Any]:
    if sys.platform != "win32":
        raise _unsupported()
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    ncrypt = ctypes.WinDLL("ncrypt", use_last_error=True)
    crypt32.CertOpenSystemStoreW.restype = ctypes.c_void_p
    crypt32.CertOpenSystemStoreW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    crypt32.CertEnumCertificatesInStore.restype = _CertCtxPtr
    crypt32.CertEnumCertificatesInStore.argtypes = [ctypes.c_void_p, _CertCtxPtr]
    crypt32.CertGetCertificateContextProperty.restype = wintypes.BOOL
    crypt32.CertGetCertificateContextProperty.argtypes = [
        _CertCtxPtr,
        wintypes.DWORD,
        ctypes.c_void_p,
        ctypes.POINTER(wintypes.DWORD),
    ]
    crypt32.CertCloseStore.restype = wintypes.BOOL
    crypt32.CertCloseStore.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    crypt32.CertFreeCertificateContext.restype = wintypes.BOOL
    crypt32.CertFreeCertificateContext.argtypes = [_CertCtxPtr]
    crypt32.CryptAcquireCertificatePrivateKey.restype = wintypes.BOOL
    crypt32.CryptAcquireCertificatePrivateKey.argtypes = [
        _CertCtxPtr,
        wintypes.DWORD,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(wintypes.DWORD),
        ctypes.POINTER(wintypes.BOOL),
    ]
    ncrypt.NCryptSignHash.restype = ctypes.c_long
    ncrypt.NCryptSignHash.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.POINTER(ctypes.c_ubyte),
        wintypes.DWORD,
        ctypes.POINTER(ctypes.c_ubyte),
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
        wintypes.DWORD,
    ]
    ncrypt.NCryptFreeObject.restype = ctypes.c_long
    ncrypt.NCryptFreeObject.argtypes = [ctypes.c_void_p]
    return crypt32, ncrypt


def _parse_or_none(encoded: bytes) -> x509.Certificate | None:
    """A store can hold certificates that a strict parser rejects; they are skipped, not fatal."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return x509.load_der_x509_certificate(encoded)
    except ValueError:
        return None


def _store_certificates(crypt32: Any, store_name: str) -> list[x509.Certificate]:
    store = crypt32.CertOpenSystemStoreW(None, store_name)
    if not store:
        return []
    certs: list[x509.Certificate] = []
    try:
        ctx = crypt32.CertEnumCertificatesInStore(store, None)
        while ctx:
            encoded = ctypes.string_at(ctx.contents.pbCertEncoded, ctx.contents.cbCertEncoded)
            cert = _parse_or_none(encoded)
            if cert is not None:
                certs.append(cert)
            # The enumeration frees the previous context itself when it is passed back in.
            ctx = crypt32.CertEnumCertificatesInStore(store, ctx)
    finally:
        crypt32.CertCloseStore(store, 0)
    return certs


def sha1_thumbprint(cert: x509.Certificate) -> str:
    """The thumbprint Windows shows for a certificate: SHA-1 of the DER encoding."""
    return cert.fingerprint(hashes.SHA1()).hex().upper()


@dataclass(frozen=True)
class StoreCertificate:
    subject: str
    issuer: str
    thumbprint: str
    not_after: str
    has_private_key: bool


def list_store_certificates(store_name: str = "MY") -> list[StoreCertificate]:
    """Certificates of one system store (default MY, the personal store) with their key status."""
    crypt32, ncrypt = _load_api()
    out: list[StoreCertificate] = []
    for cert in _store_certificates(crypt32, store_name):
        has_key = _has_usable_key(crypt32, ncrypt, cert)
        out.append(
            StoreCertificate(
                subject=cert.subject.rfc4514_string(),
                issuer=cert.issuer.rfc4514_string(),
                thumbprint=sha1_thumbprint(cert),
                not_after=cert.not_valid_after_utc.isoformat(),
                has_private_key=has_key,
            )
        )
    return out


def _find_context(crypt32: Any, store_name: str, thumbprint: str) -> tuple[Any, Any] | None:
    """The live context and its store for a thumbprint in one system store (caller frees both)."""
    store = crypt32.CertOpenSystemStoreW(None, store_name)
    if not store:
        return None
    wanted = thumbprint.upper()
    ctx = crypt32.CertEnumCertificatesInStore(store, None)
    while ctx:
        encoded = ctypes.string_at(ctx.contents.pbCertEncoded, ctx.contents.cbCertEncoded)
        if sha1_thumbprint(x509.load_der_x509_certificate(encoded)) == wanted:
            return ctx, store
        ctx = crypt32.CertEnumCertificatesInStore(store, ctx)
    crypt32.CertCloseStore(store, 0)
    return None


def _acquire_cng_key(crypt32: Any, ctx: Any) -> tuple[int, bool]:
    key = ctypes.c_void_p()
    key_spec = wintypes.DWORD()
    caller_free = wintypes.BOOL()
    ok = crypt32.CryptAcquireCertificatePrivateKey(
        ctx,
        CRYPT_ACQUIRE_SILENT_FLAG | CRYPT_ACQUIRE_ALLOW_NCRYPT_KEY_FLAG,
        None,
        ctypes.byref(key),
        ctypes.byref(key_spec),
        ctypes.byref(caller_free),
    )
    if not ok or not key.value:
        raise ChefError(ErrorKind.SIGN_BAD_CERT, "The certificate has no usable private key.")
    if key_spec.value != CERT_NCRYPT_KEY_SPEC:
        raise ChefError(
            ErrorKind.SIGN_BAD_CERT,
            "The key is a legacy CryptoAPI key; only CNG keys are supported.",
        )
    return int(key.value), bool(caller_free.value)


def _has_usable_key(crypt32: Any, ncrypt: Any, cert: x509.Certificate) -> bool:
    found = _find_context(crypt32, "MY", sha1_thumbprint(cert))
    if found is None:
        return False
    ctx, store = found
    try:
        key, free = _acquire_cng_key(crypt32, ctx)
    except ChefError:
        return False
    finally:
        crypt32.CertFreeCertificateContext(ctx)
        crypt32.CertCloseStore(store, 0)
    if free:
        ncrypt.NCryptFreeObject(key)
    return True


class CngKey:
    """A key in the key storage provider. Keeps the certificate context alive while it is used."""

    def __init__(self, crypt32: Any, ncrypt: Any, ctx: Any, store: Any, key: int, free: bool):
        self._crypt32 = crypt32
        self._ncrypt = ncrypt
        self._ctx = ctx
        self._store = store
        self._key = key
        self._free = free
        self._closed = False

    def sign(self, digest: bytes, digest_algorithm: str) -> bytes:
        name = HASH_ALGORITHM_NAMES.get(digest_algorithm.lower())
        if name is None:
            raise ChefError(ErrorKind.SIGN_BAD_CERT, "Unsupported digest for the CNG key.")
        padding = _PkcsPaddingInfo(name)
        digest_buf = (ctypes.c_ubyte * len(digest)).from_buffer_copy(digest)
        needed = wintypes.DWORD()
        status = self._ncrypt.NCryptSignHash(
            self._key,
            ctypes.byref(padding),
            digest_buf,
            len(digest),
            None,
            0,
            ctypes.byref(needed),
            BCRYPT_PAD_PKCS1,
        )
        if status != 0:
            raise ChefError(ErrorKind.SIGN_BAD_CERT, "The key store refused the signature.")
        out = (ctypes.c_ubyte * needed.value)()
        status = self._ncrypt.NCryptSignHash(
            self._key,
            ctypes.byref(padding),
            digest_buf,
            len(digest),
            out,
            needed.value,
            ctypes.byref(needed),
            BCRYPT_PAD_PKCS1,
        )
        if status != 0:
            raise ChefError(ErrorKind.SIGN_BAD_CERT, "The key store refused the signature.")
        return bytes(out[: needed.value])

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._free:
            self._ncrypt.NCryptFreeObject(self._key)
        self._crypt32.CertFreeCertificateContext(self._ctx)
        self._crypt32.CertCloseStore(self._store, 0)


class CngSigner(Signer):
    """A pyHanko signer whose key lives in the Windows key storage provider."""

    def __init__(
        self,
        *,
        key: CngKey,
        signing_cert: asn1_x509.Certificate,
        cert_registry: SimpleCertificateStore,
        key_bits: int,
    ) -> None:
        super().__init__(signing_cert=signing_cert, cert_registry=cert_registry)
        self._key = key
        self._key_bytes = key_bits // 8

    def sign_raw(self, data: bytes, digest_algorithm: str, dry_run: bool = False) -> bytes:
        if dry_run:
            return b"\x00" * self._key_bytes
        digest = hashlib.new(digest_algorithm, data).digest()
        return self._key.sign(digest, digest_algorithm)

    async def async_sign_raw(
        self, data: bytes, digest_algorithm: str, dry_run: bool = False
    ) -> bytes:
        return self.sign_raw(data, digest_algorithm, dry_run=dry_run)


def _asn1(cert: x509.Certificate) -> asn1_x509.Certificate:
    return asn1_x509.Certificate.load(cert.public_bytes(serialization.Encoding.DER))


def load_cng(thumbprint: str) -> PfxCertificate:
    """Open the certificate with this thumbprint from the personal store and its key."""
    crypt32, ncrypt = _load_api()
    found = _find_context(crypt32, "MY", thumbprint)
    if found is None:
        raise ChefError(
            ErrorKind.FILE_NOT_FOUND,
            "Certificate not found in the store.",
            {"thumbprint": thumbprint.upper()},
        )
    ctx, store = found
    try:
        key, free = _acquire_cng_key(crypt32, ctx)
    except ChefError:
        crypt32.CertFreeCertificateContext(ctx)
        crypt32.CertCloseStore(store, 0)
        raise
    encoded = ctypes.string_at(ctx.contents.pbCertEncoded, ctx.contents.cbCertEncoded)
    leaf = x509.load_der_x509_certificate(encoded)
    registry = SimpleCertificateStore()  # type: ignore[no-untyped-call]
    chain: list[x509.Certificate] = []
    for name in ("MY", *STORES_FOR_CHAIN):
        for cert in _store_certificates(crypt32, name):
            if cert != leaf:
                chain.append(cert)
    registry.register_multiple([_asn1(c) for c in chain])
    public = leaf.public_key()
    if not isinstance(public, rsa.RSAPublicKey):
        raise ChefError(ErrorKind.SIGN_BAD_CERT, "Only RSA certificates can sign from the store.")
    rsa_bits = public.key_size
    cng_key = CngKey(crypt32, ncrypt, ctx, store, key, free)
    signer = CngSigner(
        key=cng_key,
        signing_cert=_asn1(leaf),
        cert_registry=registry,
        key_bits=rsa_bits,
    )
    return PfxCertificate(signer=signer, certificate=leaf, chain=tuple(chain))
