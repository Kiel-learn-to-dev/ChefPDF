"""USB token access over PKCS#11 (feature I1, task T3.01).

Layers:

- ``Pkcs11Backend`` is the small interface the rest of the core uses: list slots and tokens,
  list certificates (no PIN needed), log in. ``RealBackend`` implements it with python-pkcs11;
  tests use an in-memory fake with the same behaviour.
- ``open_token_session`` applies the PIN policy in one place: re-read the PIN flags, refuse a
  locked token, require explicit confirmation on the final try, refuse an empty PIN, then log in
  exactly once. A wrong PIN is never retried (feature I7).

python-pkcs11 is an optional dependency (extra ``token``). It is imported lazily: when it is
missing, every token operation fails with ``TOKEN_SUPPORT_UNAVAILABLE`` and the app still runs.

The PIN is passed to the driver and dropped; it is never logged, stored in a journal or put in an
error. Python strings cannot be wiped from memory, so the PIN lives only for the login call.
"""

from __future__ import annotations

import contextlib
import errno
import logging
from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, Any, Protocol

from cryptography import x509
from cryptography.x509.oid import ExtensionOID
from pyhanko.sign.signers.pdf_cms import Signer

from chef_core.errors import ChefError, ErrorKind

if TYPE_CHECKING:  # pragma: no cover - typing only
    from pkcs11 import Session as P11Session
    from pkcs11 import Slot as P11Slot

log = logging.getLogger(__name__)

PIN_FLAG_NAMES = (
    "USER_PIN_LOCKED",
    "USER_PIN_FINAL_TRY",
    "USER_PIN_COUNT_LOW",
    "USER_PIN_TO_BE_CHANGED",
)


class PinState(StrEnum):
    OK = "ok"
    COUNT_LOW = "count_low"  # at least one wrong PIN recorded; the number left is not exposed
    FINAL_TRY = "final_try"  # exactly one try left
    LOCKED = "locked"
    TO_BE_CHANGED = "to_be_changed"


def pin_state_from_flags(flags: Iterable[str]) -> PinState:
    """The most serious PIN state among the token flags (locked beats everything)."""
    names = set(flags)
    if "USER_PIN_LOCKED" in names:
        return PinState.LOCKED
    if "USER_PIN_FINAL_TRY" in names:
        return PinState.FINAL_TRY
    if "USER_PIN_COUNT_LOW" in names:
        return PinState.COUNT_LOW
    if "USER_PIN_TO_BE_CHANGED" in names:
        return PinState.TO_BE_CHANGED
    return PinState.OK


def remaining_tries(state: PinState) -> int | None:
    """Tries left when the flags make it certain; ``None`` when PKCS#11 does not say."""
    if state is PinState.FINAL_TRY:
        return 1
    if state is PinState.LOCKED:
        return 0
    return None


@dataclass(frozen=True)
class TokenInfo:
    slot_id: int
    label: str
    manufacturer: str
    model: str
    serial: str
    initialized: bool
    flags: tuple[str, ...]
    pin_state: PinState
    protected_auth_path: bool
    sha256_rsa: bool  # CKM_SHA256_RSA_PKCS available
    raw_rsa: bool  # CKM_RSA_PKCS available (hash on the computer, pyHanko builds DigestInfo)


@dataclass(frozen=True)
class SlotInfo:
    slot_id: int
    description: str
    token: TokenInfo | None
    read_error: str | None  # set when the slot exists but C_GetTokenInfo failed


@dataclass(frozen=True)
class TokenCertificate:
    cka_id: bytes
    label: str | None
    certificate: x509.Certificate

    @property
    def is_ca(self) -> bool:
        return is_ca(self.certificate)


@dataclass(frozen=True)
class CertListing:
    certificates: tuple[TokenCertificate, ...]
    unreadable: int  # certificate objects that could not be parsed


def is_ca(cert: x509.Certificate) -> bool:
    try:
        ext = cert.extensions.get_extension_for_oid(ExtensionOID.BASIC_CONSTRAINTS)
    except x509.ExtensionNotFound:
        return False
    value = ext.value
    return isinstance(value, x509.BasicConstraints) and value.ca


class TokenSession(Protocol):
    """A logged-in (or public) session. ``close`` must always be called."""

    def signer(self, cka_id: bytes) -> Signer:
        """A pyHanko signer that signs with the private key with this CKA_ID."""
        ...

    def close(self) -> None: ...


class Pkcs11Backend(Protocol):
    def load_slots(self, module_path: str) -> list[SlotInfo]:
        """Slots and tokens with fresh flags. Needs no PIN. Raises ``TOKEN_DRIVER_ERROR``."""
        ...

    def certificates(self, module_path: str, slot_id: int) -> CertListing:
        """Certificates on the token. Needs no PIN."""
        ...

    def login(self, module_path: str, slot_id: int, pin: str | None) -> TokenSession:
        """Log in as the user. ``pin`` None means the PIN is entered on the device itself."""
        ...


# -- policy shared by every backend ------------------------------------------------------


def select_token(
    backend: Pkcs11Backend,
    module_path: str,
    *,
    slot_id: int | None,
    serial: str | None,
) -> TokenInfo:
    """The one initialised token in ``slot_id`` (or with ``serial``)."""
    tokens = [s.token for s in backend.load_slots(module_path) if s.token is not None]
    if slot_id is not None:
        matches = [t for t in tokens if t.slot_id == slot_id]
        reason = "slot"
    else:
        matches = [t for t in tokens if t.serial == serial]
        reason = "serial"
    if not matches:
        raise ChefError(
            ErrorKind.TOKEN_NOT_FOUND,
            "No token matches the selection",
            {"reason": reason},
        )
    token = matches[0]
    if not token.initialized:
        raise ChefError(
            ErrorKind.TOKEN_NOT_FOUND,
            "The token is not initialised",
            {"reason": "not_initialized", "slotId": token.slot_id},
        )
    return token


def open_token_session(
    backend: Pkcs11Backend,
    module_path: str,
    slot_id: int,
    pin: str | None,
    *,
    confirm_final_try: bool,
) -> TokenSession:
    """Log in once, after the PIN policy has been applied to the freshly read flags."""
    token = select_token(backend, module_path, slot_id=slot_id, serial=None)
    state = token.pin_state
    if state is PinState.LOCKED:
        raise ChefError(
            ErrorKind.TOKEN_PIN_LOCKED,
            "The token PIN is locked",
            {"pinState": state.value},
        )
    if state is PinState.FINAL_TRY and not confirm_final_try:
        raise ChefError(
            ErrorKind.TOKEN_PIN_CONFIRM_REQUIRED,
            "Only one try left: confirm before entering the PIN",
            {"pinState": state.value, "remainingTries": 1},
        )
    if token.protected_auth_path:
        return backend.login(module_path, slot_id, None)
    if not pin:
        raise ChefError(ErrorKind.TOKEN_PIN_INVALID, "The PIN is empty", {"reason": "empty"})
    return backend.login(module_path, slot_id, pin)


# -- current backend ----------------------------------------------------------------------

_OVERRIDE: Pkcs11Backend | None = None


def _import_support() -> None:
    """Raises ImportError when the optional token stack is not installed."""
    import pkcs11  # noqa: F401
    import pyhanko.sign.pkcs11  # noqa: F401


def current_backend() -> Pkcs11Backend:
    """The backend for this process: the override (tests), else python-pkcs11."""
    if _OVERRIDE is not None:
        return _OVERRIDE
    try:
        _import_support()
    except ImportError as exc:
        raise ChefError(
            ErrorKind.TOKEN_SUPPORT_UNAVAILABLE,
            "USB token support is not available in this build",
            {"module": exc.name},
        ) from exc
    return RealBackend()


@contextlib.contextmanager
def use_backend(backend: Pkcs11Backend) -> Iterator[Pkcs11Backend]:
    """Route every token operation to ``backend`` (used by tests)."""
    global _OVERRIDE
    previous = _OVERRIDE
    _OVERRIDE = backend
    try:
        yield backend
    finally:
        _OVERRIDE = previous


# -- real backend (python-pkcs11) ---------------------------------------------------------


def _text(value: object) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace").strip()
    return str(value).strip()


def _driver_error(module_path: str, exc: BaseException) -> ChefError:
    reason = "load_failed"
    if isinstance(exc, FileNotFoundError) or getattr(exc, "errno", None) == errno.ENOENT:
        reason = "not_found"
    elif getattr(exc, "winerror", None) == 193 or "not a valid Win32" in str(exc):
        reason = "architecture"  # 32-bit driver for a 64-bit process, or the reverse
    return ChefError(
        ErrorKind.TOKEN_DRIVER_ERROR,
        "The PKCS#11 driver cannot be used",
        {"reason": reason, "module": module_path},
    )


class _RealSession:
    def __init__(self, session: P11Session, sha256_rsa: bool) -> None:
        self._session = session
        self._raw = not sha256_rsa
        self._closed = False

    def signer(self, cka_id: bytes) -> Signer:
        from pyhanko.sign.pkcs11 import PKCS11Signer

        # other_certs_to_pull=None: pull the CA chain stored on the token, as the spike did.
        return PKCS11Signer(
            self._session,
            cert_id=cka_id,
            key_id=cka_id,
            other_certs_to_pull=None,
            use_raw_mechanism=self._raw,
        )

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._session.close()
        except Exception:  # the token may have been removed; closing is best effort
            log.info("token session close failed; the token may have been removed")


class RealBackend:
    """python-pkcs11 implementation. Libraries are cached per path by python-pkcs11 itself."""

    def __init__(self) -> None:
        self._libs: dict[str, Any] = {}

    def _lib(self, module_path: str) -> Any:
        import pkcs11

        lib = self._libs.get(module_path)
        if lib is None:
            try:
                lib = pkcs11.lib(module_path)
            except Exception as exc:
                raise _driver_error(module_path, exc) from exc
            self._libs[module_path] = lib
        return lib

    def _slot(self, module_path: str, slot_id: int) -> P11Slot:
        slots: list[P11Slot] = list(self._lib(module_path).get_slots())
        for slot in slots:
            if slot.slot_id == slot_id:
                return slot
        raise ChefError(ErrorKind.TOKEN_NOT_FOUND, "No such slot", {"reason": "slot"})

    def load_slots(self, module_path: str) -> list[SlotInfo]:
        import pkcs11

        try:
            slots = list(self._lib(module_path).get_slots())
        except pkcs11.exceptions.PKCS11Error as exc:
            raise _driver_error(module_path, exc) from exc
        out: list[SlotInfo] = []
        for slot in slots:
            description = _text(slot.slot_description)
            try:
                tok = slot.get_token()
            except (pkcs11.exceptions.TokenNotPresent, pkcs11.exceptions.NoSuchToken):
                out.append(SlotInfo(slot.slot_id, description, None, None))
                continue
            except pkcs11.exceptions.PKCS11Error:
                out.append(SlotInfo(slot.slot_id, description, None, "device"))
                continue
            flags = tuple(str(f.name) for f in _token_flags(tok))
            try:
                mechs = slot.get_mechanisms()
                sha256_rsa = pkcs11.Mechanism.SHA256_RSA_PKCS in mechs
                raw_rsa = pkcs11.Mechanism.RSA_PKCS in mechs
            except pkcs11.exceptions.PKCS11Error:
                sha256_rsa = raw_rsa = False
            info = TokenInfo(
                slot_id=slot.slot_id,
                label=_text(tok.label),
                manufacturer=_text(tok.manufacturer_id),
                model=_text(tok.model),
                serial=_text(tok.serial),
                initialized="TOKEN_INITIALIZED" in flags,
                flags=flags,
                pin_state=pin_state_from_flags(flags),
                protected_auth_path="PROTECTED_AUTHENTICATION_PATH" in flags,
                sha256_rsa=sha256_rsa,
                raw_rsa=raw_rsa,
            )
            out.append(SlotInfo(slot.slot_id, description, info, None))
        return out

    def certificates(self, module_path: str, slot_id: int) -> CertListing:
        import pkcs11
        from pkcs11 import Attribute, ObjectClass

        slot = self._slot(module_path, slot_id)
        try:
            tok = slot.get_token()
            if not tok.flags & pkcs11.TokenFlag.TOKEN_INITIALIZED:
                return CertListing(certificates=(), unreadable=0)
            found: list[TokenCertificate] = []
            unreadable = 0
            with tok.open() as sess:  # public session: certificates need no PIN
                for obj in sess.get_objects({Attribute.CLASS: ObjectClass.CERTIFICATE}):
                    try:
                        cert = x509.load_der_x509_certificate(obj[Attribute.VALUE])
                    except (KeyError, ValueError, pkcs11.exceptions.PKCS11Error):
                        unreadable += 1
                        continue
                    try:
                        cka_id = bytes(obj[Attribute.ID])
                    except (KeyError, pkcs11.exceptions.PKCS11Error):
                        unreadable += 1
                        continue
                    try:
                        label: str | None = _text(obj[Attribute.LABEL])
                    except (KeyError, pkcs11.exceptions.PKCS11Error):
                        label = None
                    found.append(TokenCertificate(cka_id=cka_id, label=label, certificate=cert))
        except pkcs11.exceptions.PKCS11Error as exc:
            raise _driver_error(module_path, exc) from exc
        return CertListing(certificates=tuple(found), unreadable=unreadable)

    def login(self, module_path: str, slot_id: int, pin: str | None) -> TokenSession:
        import pkcs11

        slot = self._slot(module_path, slot_id)
        tok = slot.get_token()
        sha256_rsa = pkcs11.Mechanism.SHA256_RSA_PKCS in slot.get_mechanisms()
        user_pin: Any = pkcs11.PROTECTED_AUTH if pin is None else pin
        try:
            session = tok.open(user_pin=user_pin)
        except pkcs11.exceptions.PinIncorrect as exc:
            raise self._wrong_pin(slot) from exc
        except pkcs11.exceptions.PinLocked as exc:
            raise ChefError(
                ErrorKind.TOKEN_PIN_LOCKED, "The token PIN is locked", {"pinState": "locked"}
            ) from exc
        except pkcs11.exceptions.PinExpired as exc:
            raise ChefError(
                ErrorKind.TOKEN_PIN_INVALID,
                "The PIN must be changed on the token",
                {"reason": "must_change"},
            ) from exc
        except (pkcs11.exceptions.PinLenRange, pkcs11.exceptions.PinInvalid) as exc:
            raise ChefError(
                ErrorKind.TOKEN_PIN_INVALID, "The PIN is not accepted", {"reason": "invalid"}
            ) from exc
        except pkcs11.exceptions.UserAlreadyLoggedIn as exc:
            raise ChefError(
                ErrorKind.TOKEN_DRIVER_ERROR,
                "The token is already in use by another login",
                {"reason": "already_logged_in"},
            ) from exc
        except pkcs11.exceptions.PKCS11Error as exc:
            raise _driver_error(module_path, exc) from exc
        return _RealSession(session, sha256_rsa)

    def _wrong_pin(self, slot: P11Slot) -> ChefError:
        """Re-read the flags after a wrong PIN, so the user sees the new state."""
        state: PinState | None
        try:
            flags = tuple(str(f.name) for f in _token_flags(slot.get_token()))
            state = pin_state_from_flags(flags)
        except Exception:  # the flags are a hint only
            state = None
        detail: dict[str, Any] = {
            "reason": "wrong_pin",
            "pinState": state.value if state is not None else None,
            "remainingTries": remaining_tries(state) if state is not None else None,
        }
        return ChefError(ErrorKind.TOKEN_PIN_INVALID, "The PIN is wrong", detail)


def _token_flags(tok: Any) -> list[Any]:
    from pkcs11 import TokenFlag

    return [f for f in TokenFlag if f and tok.flags & f]
