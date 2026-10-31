"""Test double for the PKCS#11 layer (T3.01 / T3.03).

``FakeBackend`` implements the ``Pkcs11Backend`` protocol without any driver. It models slots,
tokens with PIN counters (flags are derived from the counter, like a real token), certificates
that are readable without a PIN, and sessions that sign with a real RSA key from the test PKI.
A wrong PIN decrements the counter and is never retried by the code under test; the fake counts
every C_Login attempt so tests can assert that.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from pyhanko.sign.signers.pdf_cms import Signer, SimpleSigner

from chef_core.errors import ChefError, ErrorKind
from chef_core.signing.pkcs11 import (
    CertListing,
    SlotInfo,
    TokenCertificate,
    TokenInfo,
    is_ca,
    pin_state_from_flags,
)


@dataclass
class FakeCert:
    cka_id: bytes
    certificate: x509.Certificate
    key: rsa.RSAPrivateKey | None = None  # None: no private key (CA certificate)
    label: str | None = None
    readable: bool = True


@dataclass
class FakeToken:
    label: str = "CHEF-TEST-TOKEN"
    serial: str = "0123456789ABCDEF"
    manufacturer: str = "Fake Manufacturer"
    model: str = "FakeToken v6"
    pin: str = "1234"
    max_tries: int = 10
    tries_left: int = 10
    wrong_attempts: int = 0
    initialized: bool = True
    protected_auth: bool = False
    sha256_rsa: bool = True
    to_be_changed: bool = False
    certs: list[FakeCert] = field(default_factory=list)

    def flag_names(self) -> tuple[str, ...]:
        names: list[str] = []
        if self.initialized:
            names.append("TOKEN_INITIALIZED")
        if self.tries_left <= 0:
            names.append("USER_PIN_LOCKED")
        elif self.tries_left == 1:
            names.append("USER_PIN_FINAL_TRY")
        elif self.wrong_attempts > 0:
            names.append("USER_PIN_COUNT_LOW")
        if self.to_be_changed:
            names.append("USER_PIN_TO_BE_CHANGED")
        if self.protected_auth:
            names.append("PROTECTED_AUTHENTICATION_PATH")
        return tuple(names)

    def info(self, slot_id: int) -> TokenInfo:
        flags = self.flag_names()
        return TokenInfo(
            slot_id=slot_id,
            label=self.label,
            manufacturer=self.manufacturer,
            model=self.model,
            serial=self.serial,
            initialized="TOKEN_INITIALIZED" in flags,
            flags=flags,
            pin_state=pin_state_from_flags(flags),
            protected_auth_path=self.protected_auth,
            sha256_rsa=self.sha256_rsa,
            raw_rsa=True,
        )


@dataclass
class FakeSlot:
    slot_id: int
    token: FakeToken | None = None
    description: str = "Fake reader"
    read_error: str | None = None  # set when C_GetTokenInfo would fail


@dataclass
class FakeModule:
    slots: list[FakeSlot] = field(default_factory=list)
    load_error: str | None = None  # "architecture", "load_failed" or "not_found"


class FakeSession:
    def __init__(self, backend: FakeBackend, token: FakeToken) -> None:
        self._backend = backend
        self._token = token
        self.closed = False

    def signer(self, cka_id: bytes) -> Signer:
        for cert in self._token.certs:
            if cert.cka_id == cka_id and cert.key is not None:
                chain = [c.certificate for c in self._token.certs if c.key is None]
                data = pkcs12.serialize_key_and_certificates(
                    name=None,
                    key=cert.key,
                    cert=cert.certificate,
                    cas=chain,
                    encryption_algorithm=serialization.NoEncryption(),
                )
                return SimpleSigner.load_pkcs12_data(data, other_certs=(), passphrase=None)
        raise ChefError(ErrorKind.TOKEN_NOT_FOUND, "No signing key", {"reason": "certificate"})

    def close(self) -> None:
        if not self.closed:
            self.closed = True
            self._backend.closed_sessions += 1


class FakeBackend:
    """In-memory Pkcs11Backend. Modules are keyed by the path the code under test passes in."""

    def __init__(self) -> None:
        self.modules: dict[str, FakeModule] = {}
        self.login_attempts: list[tuple[str, int]] = []
        self.open_sessions = 0
        self.closed_sessions = 0

    # -- setup helpers -------------------------------------------------------------------

    def add_module(self, path: str, *slots: FakeSlot, load_error: str | None = None) -> FakeModule:
        module = FakeModule(slots=list(slots), load_error=load_error)
        self.modules[path] = module
        return module

    def token(self, path: str, slot_id: int = 0) -> FakeToken:
        slot = self._slot(path, slot_id)
        if slot.token is None:
            raise AssertionError("fake slot has no token")
        return slot.token

    # -- Pkcs11Backend ---------------------------------------------------------------------

    def _module(self, path: str) -> FakeModule:
        module = self.modules.get(path)
        if module is None:
            raise ChefError(
                ErrorKind.TOKEN_DRIVER_ERROR, "Driver cannot be loaded", {"reason": "not_found"}
            )
        if module.load_error is not None:
            raise ChefError(
                ErrorKind.TOKEN_DRIVER_ERROR,
                "Driver cannot be loaded",
                {"reason": module.load_error},
            )
        return module

    def _slot(self, path: str, slot_id: int) -> FakeSlot:
        for slot in self._module(path).slots:
            if slot.slot_id == slot_id:
                return slot
        raise ChefError(ErrorKind.TOKEN_NOT_FOUND, "No such slot", {"reason": "slot"})

    def load_slots(self, module_path: str) -> list[SlotInfo]:
        out: list[SlotInfo] = []
        for slot in self._module(module_path).slots:
            if slot.read_error is not None:
                out.append(
                    SlotInfo(
                        slot_id=slot.slot_id,
                        description=slot.description,
                        token=None,
                        read_error=slot.read_error,
                    )
                )
                continue
            info = slot.token.info(slot.slot_id) if slot.token is not None else None
            out.append(
                SlotInfo(
                    slot_id=slot.slot_id,
                    description=slot.description,
                    token=info,
                    read_error=None,
                )
            )
        return out

    def certificates(self, module_path: str, slot_id: int) -> CertListing:
        slot = self._slot(module_path, slot_id)
        if slot.token is None or not slot.token.initialized:
            return CertListing(certificates=(), unreadable=0)
        readable: list[TokenCertificate] = []
        unreadable = 0
        for cert in slot.token.certs:
            if not cert.readable:
                unreadable += 1
                continue
            readable.append(
                TokenCertificate(cka_id=cert.cka_id, label=cert.label, certificate=cert.certificate)
            )
        return CertListing(certificates=tuple(readable), unreadable=unreadable)

    def login(self, module_path: str, slot_id: int, pin: str | None) -> FakeSession:
        self.login_attempts.append((module_path, slot_id))
        slot = self._slot(module_path, slot_id)
        if slot.token is None:
            raise ChefError(ErrorKind.TOKEN_NOT_FOUND, "No token", {"reason": "no_token"})
        token = slot.token
        if token.tries_left <= 0:
            raise ChefError(ErrorKind.TOKEN_PIN_LOCKED, "PIN locked", {"pinState": "locked"})
        if token.to_be_changed:
            raise ChefError(
                ErrorKind.TOKEN_PIN_INVALID, "PIN must be changed", {"reason": "must_change"}
            )
        if not token.protected_auth and not pin:
            raise ChefError(ErrorKind.TOKEN_PIN_INVALID, "PIN is empty", {"reason": "empty"})
        if not token.protected_auth and pin != token.pin:
            token.tries_left -= 1
            token.wrong_attempts += 1
            state = pin_state_from_flags(token.flag_names())
            raise ChefError(
                ErrorKind.TOKEN_PIN_INVALID,
                "Wrong PIN",
                {
                    "reason": "wrong_pin",
                    "pinState": state.value,
                    "remainingTries": max(token.tries_left, 0),
                },
            )
        token.tries_left = token.max_tries
        token.wrong_attempts = 0
        self.open_sessions += 1
        return FakeSession(self, token)


class FakeFileSystem:
    """Files are exact path strings; directory listings come from the file set."""

    def __init__(self, files: set[str], environ: Mapping[str, str]) -> None:
        self.files = files
        self.environ = dict(environ)

    def is_file(self, path: str) -> bool:
        return path in self.files

    def list_dir(self, path: str) -> list[str]:
        prefix = path.rstrip("\\/") + "\\"
        names = []
        for file in self.files:
            if file.startswith(prefix) and "\\" not in file[len(prefix) :]:
                names.append(file[len(prefix) :])
        return names


def fake_cert_chain(*chain: x509.Certificate) -> list[FakeCert]:
    """CA certificates stored on the token (no private key), as CA tokens usually carry."""
    return [
        FakeCert(cka_id=bytes([0xC0 + i]), certificate=cert, label=f"CA {i}")
        for i, cert in enumerate(chain)
    ]


def is_ca_certificate(cert: x509.Certificate) -> bool:
    return is_ca(cert)


def make_module_file(directory: Any, name: str = "viettel-ca_v6.dll") -> str:
    """A real (empty) file, so that path checks pass. The fake backend never loads it."""
    path = directory / name
    path.write_bytes(b"MZ-fake-driver")
    return str(path)
