"""PKCS#12 signing certificates (``.pfx`` / ``.p12``), feature I2.

Passwords are only ever handed to cryptography and never stored, logged or put into an error.
A wrong password and a damaged archive look the same to cryptography, so the archive structure
is checked first with asn1crypto: a well-formed archive that does not open is a wrong password.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from asn1crypto import pkcs12 as asn1_pkcs12
from cryptography import x509
from cryptography.hazmat.primitives.serialization import pkcs12
from pyhanko.sign.signers.pdf_cms import Signer, SimpleSigner

from chef_core.errors import ChefError, ErrorKind


@dataclass(frozen=True)
class PfxCertificate:
    """A loaded signing identity. Holds key material: keep it in memory only.

    ``signer`` is any pyHanko signer: a PFX ``SimpleSigner`` or a token signer (T3.01).
    """

    signer: Signer
    certificate: x509.Certificate
    # Other certificates in the archive (the issuing chain), leaf excluded.
    chain: tuple[x509.Certificate, ...]


def load_pfx(path: str | Path, password: str | None = None) -> PfxCertificate:
    """Open a PKCS#12 archive that holds a private key and its certificate.

    - missing file -> ``FILE_NOT_FOUND``
    - unreadable, not PKCS#12, or without a private key or certificate -> ``SIGN_BAD_CERT``
    - encrypted and no password given -> ``PASSWORD_REQUIRED``
    - encrypted and the password is wrong -> ``SIGN_BAD_PASSWORD``
    """
    source = Path(path)
    if not source.is_file():
        raise ChefError(ErrorKind.FILE_NOT_FOUND, "File not found", {"path": str(source)})
    try:
        data = source.read_bytes()
    except OSError as exc:
        raise ChefError(
            ErrorKind.SIGN_BAD_CERT, "Certificate file cannot be read", {"path": str(source)}
        ) from exc
    try:
        _structure = asn1_pkcs12.Pfx.load(data).native  # raises on a malformed archive
    except Exception as exc:
        raise ChefError(
            ErrorKind.SIGN_BAD_CERT, "Not a PKCS#12 certificate file", {"path": str(source)}
        ) from exc

    passphrase = password.encode("utf-8") if password else None
    try:
        key, cert, others = pkcs12.load_key_and_certificates(data, passphrase)
    except ValueError as exc:
        if passphrase is None:
            raise ChefError(
                ErrorKind.PASSWORD_REQUIRED,
                "The certificate file is protected by a password",
                {"path": str(source)},
            ) from exc
        raise ChefError(
            ErrorKind.SIGN_BAD_PASSWORD,
            "Wrong password for the certificate file",
            {"path": str(source)},
        ) from exc

    if key is None or cert is None:
        raise ChefError(
            ErrorKind.SIGN_BAD_CERT,
            "The certificate file has no private key or certificate",
            {"path": str(source)},
        )

    signer = SimpleSigner.load_pkcs12_data(data, other_certs=(), passphrase=passphrase)
    return PfxCertificate(signer=signer, certificate=cert, chain=tuple(others or ()))
