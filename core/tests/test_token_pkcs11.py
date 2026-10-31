"""T3.01: PKCS#11 layer on the fake backend. PIN policy, error kinds, session handling, no leaks."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import pytest
from pyhanko.sign.signers.pdf_cms import Signer
from token_support import FakeBackend, FakeCert, FakeSlot, FakeToken, make_module_file

from chef_core.errors import ChefError, ErrorKind
from chef_core.signing import pkcs11 as p11
from chef_core.signing.pkcs11 import (
    PinState,
    open_token_session,
    pin_state_from_flags,
    remaining_tries,
    use_backend,
)

SECRET_PIN = "PIN-LEAK-7319"


@pytest.fixture
def backend() -> FakeBackend:
    return FakeBackend()


@pytest.fixture
def module(tmp_path: Path, backend: FakeBackend) -> str:
    path = make_module_file(tmp_path)
    backend.add_module(path, FakeSlot(slot_id=3, token=FakeToken(pin=SECRET_PIN)))
    return path


def _token(backend: FakeBackend, module: str) -> FakeToken:
    return backend.token(module, 3)


def test_pin_state_priority_from_flags() -> None:
    assert pin_state_from_flags([]) is PinState.OK
    assert pin_state_from_flags(["TOKEN_INITIALIZED"]) is PinState.OK
    assert pin_state_from_flags(["USER_PIN_COUNT_LOW"]) is PinState.COUNT_LOW
    assert pin_state_from_flags(["USER_PIN_FINAL_TRY"]) is PinState.FINAL_TRY
    assert pin_state_from_flags(["USER_PIN_TO_BE_CHANGED"]) is PinState.TO_BE_CHANGED
    # locked wins over everything else
    flags = ["USER_PIN_LOCKED", "USER_PIN_FINAL_TRY", "USER_PIN_COUNT_LOW"]
    assert pin_state_from_flags(flags) is PinState.LOCKED


def test_remaining_tries_only_known_from_flags() -> None:
    assert remaining_tries(PinState.FINAL_TRY) == 1
    assert remaining_tries(PinState.LOCKED) == 0
    assert remaining_tries(PinState.COUNT_LOW) is None  # the counter is not exposed
    assert remaining_tries(PinState.OK) is None


def test_load_slots_reports_token_and_empty_slot(backend: FakeBackend, module: str) -> None:
    backend.modules[module].slots.append(FakeSlot(slot_id=7, token=None, description="Empty"))
    slots = {s.slot_id: s for s in backend.load_slots(module)}
    token = slots[3].token
    assert token is not None
    assert token.label == "CHEF-TEST-TOKEN"
    assert token.initialized is True
    assert token.pin_state is PinState.OK
    assert slots[7].token is None


def test_slot_read_error_is_reported_per_slot(backend: FakeBackend, tmp_path: Path) -> None:
    path = make_module_file(tmp_path)
    backend.add_module(path, FakeSlot(slot_id=1, token=FakeToken(), read_error="device"))
    (slot,) = backend.load_slots(path)
    assert slot.token is None
    assert slot.read_error == "device"


def test_unknown_driver_is_a_driver_error(backend: FakeBackend) -> None:
    with pytest.raises(ChefError) as exc:
        backend.load_slots("C:\\nowhere\\missing.dll")
    assert exc.value.kind is ErrorKind.TOKEN_DRIVER_ERROR
    assert exc.value.detail == {"reason": "not_found"}


def test_architecture_mismatch_is_a_driver_error(backend: FakeBackend, tmp_path: Path) -> None:
    path = make_module_file(tmp_path)
    backend.add_module(path, load_error="architecture")
    with pytest.raises(ChefError) as exc:
        backend.load_slots(path)
    assert exc.value.kind is ErrorKind.TOKEN_DRIVER_ERROR
    assert exc.value.detail == {"reason": "architecture"}


def test_certificates_listing_counts_unreadable_objects(
    backend: FakeBackend, module: str, pki: Any
) -> None:
    token = _token(backend, module)
    token.certs = [
        FakeCert(cka_id=b"\x01", certificate=pki.signer_a.cert, key=pki.signer_a.key),
        FakeCert(cka_id=b"\x02", certificate=pki.inter.cert),
        FakeCert(cka_id=b"\x03", certificate=pki.root.cert, readable=False),
    ]
    listing = backend.certificates(module, 3)
    assert [c.cka_id for c in listing.certificates] == [b"\x01", b"\x02"]
    assert listing.unreadable == 1
    assert listing.certificates[1].is_ca is True
    assert listing.certificates[0].is_ca is False


def test_locked_token_is_refused_without_a_login_attempt(backend: FakeBackend, module: str) -> None:
    _token(backend, module).tries_left = 0
    with pytest.raises(ChefError) as exc:
        open_token_session(backend, module, 3, SECRET_PIN, confirm_final_try=True)
    assert exc.value.kind is ErrorKind.TOKEN_PIN_LOCKED
    assert backend.login_attempts == []


def test_final_try_needs_explicit_confirmation(backend: FakeBackend, module: str) -> None:
    _token(backend, module).tries_left = 1
    with pytest.raises(ChefError) as exc:
        open_token_session(backend, module, 3, SECRET_PIN, confirm_final_try=False)
    assert exc.value.kind is ErrorKind.TOKEN_PIN_CONFIRM_REQUIRED
    assert exc.value.detail == {"pinState": "final_try", "remainingTries": 1}
    assert backend.login_attempts == []

    session = open_token_session(backend, module, 3, SECRET_PIN, confirm_final_try=True)
    session.close()
    assert len(backend.login_attempts) == 1


def test_wrong_pin_is_reported_once_and_never_retried(backend: FakeBackend, module: str) -> None:
    token = _token(backend, module)
    with pytest.raises(ChefError) as exc:
        open_token_session(backend, module, 3, "0000", confirm_final_try=False)
    assert exc.value.kind is ErrorKind.TOKEN_PIN_INVALID
    assert exc.value.detail["reason"] == "wrong_pin"
    assert exc.value.detail["pinState"] == "count_low"
    assert exc.value.detail["remainingTries"] == 9
    assert len(backend.login_attempts) == 1
    assert token.tries_left == 9  # one attempt, no hidden retry


def test_wrong_pin_that_locks_the_token_then_refuses(backend: FakeBackend, module: str) -> None:
    _token(backend, module).tries_left = 1
    with pytest.raises(ChefError) as exc:
        open_token_session(backend, module, 3, "0000", confirm_final_try=True)
    assert exc.value.kind is ErrorKind.TOKEN_PIN_INVALID
    assert exc.value.detail["pinState"] == "locked"
    with pytest.raises(ChefError) as again:
        open_token_session(backend, module, 3, SECRET_PIN, confirm_final_try=True)
    assert again.value.kind is ErrorKind.TOKEN_PIN_LOCKED
    assert len(backend.login_attempts) == 1


def test_correct_pin_after_wrong_one_resets_counter(backend: FakeBackend, module: str) -> None:
    token = _token(backend, module)
    with pytest.raises(ChefError):
        open_token_session(backend, module, 3, "0000", confirm_final_try=False)
    session = open_token_session(backend, module, 3, SECRET_PIN, confirm_final_try=False)
    session.close()
    assert token.tries_left == token.max_tries
    assert pin_state_from_flags(token.flag_names()) is PinState.OK


def test_pin_that_must_be_changed_is_refused(backend: FakeBackend, module: str) -> None:
    _token(backend, module).to_be_changed = True
    with pytest.raises(ChefError) as exc:
        open_token_session(backend, module, 3, SECRET_PIN, confirm_final_try=False)
    assert exc.value.kind is ErrorKind.TOKEN_PIN_INVALID
    assert exc.value.detail == {"reason": "must_change"}


def test_empty_pin_is_rejected_before_login(backend: FakeBackend, module: str) -> None:
    with pytest.raises(ChefError) as exc:
        open_token_session(backend, module, 3, "", confirm_final_try=False)
    assert exc.value.kind is ErrorKind.TOKEN_PIN_INVALID
    assert exc.value.detail == {"reason": "empty"}
    assert backend.login_attempts == []


def test_protected_authentication_path_needs_no_pin(backend: FakeBackend, module: str) -> None:
    _token(backend, module).protected_auth = True
    session = open_token_session(backend, module, 3, None, confirm_final_try=False)
    session.close()
    session.close()  # closing twice is harmless
    assert backend.open_sessions == 1
    assert backend.closed_sessions == 1


def test_session_signer_builds_a_pyhanko_signer(
    backend: FakeBackend, module: str, pki: Any
) -> None:
    _token(backend, module).certs = [
        FakeCert(cka_id=b"\x01", certificate=pki.signer_a.cert, key=pki.signer_a.key)
    ]
    session = open_token_session(backend, module, 3, SECRET_PIN, confirm_final_try=False)
    try:
        signer: Signer = session.signer(b"\x01")
        assert signer.signing_cert is not None
    finally:
        session.close()


def test_missing_python_pkcs11_gives_support_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    def missing() -> None:
        raise ImportError("No module named 'pkcs11'")

    monkeypatch.setattr(p11, "_import_support", missing)
    with pytest.raises(ChefError) as exc:
        p11.current_backend()
    assert exc.value.kind is ErrorKind.TOKEN_SUPPORT_UNAVAILABLE


def test_use_backend_overrides_the_default(backend: FakeBackend) -> None:
    with use_backend(backend):
        assert p11.current_backend() is backend
    assert p11.current_backend() is not backend


def test_pin_never_appears_in_logs_or_error_details(
    backend: FakeBackend, module: str, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    for pin in ("0000", SECRET_PIN):
        try:
            session = open_token_session(backend, module, 3, pin, confirm_final_try=False)
        except ChefError as exc:
            assert SECRET_PIN not in exc.message
            assert SECRET_PIN not in repr(exc.detail)
            assert SECRET_PIN not in str(exc.detail)
        else:
            session.close()
    assert SECRET_PIN not in caplog.text


def test_token_info_is_frozen(backend: FakeBackend, module: str) -> None:
    (slot,) = [s for s in backend.load_slots(module) if s.slot_id == 3]
    assert slot.token is not None
    with pytest.raises(AttributeError):
        slot.token.label = "changed"  # type: ignore[misc]
