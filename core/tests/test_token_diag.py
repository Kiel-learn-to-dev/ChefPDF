"""T3.03: token diagnostics. Every branch of the step ladder, on the fake backend."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from token_support import FakeBackend, FakeCert, FakeSlot, FakeToken, make_module_file

from chef_core.signing.diag import run_diagnostics
from chef_core.signing.drivers import (
    OsFileSystem,
    TokenEnvironment,
    load_database,
    use_environment,
)
from chef_core.signing.pkcs11 import use_backend

STEP_IDS = [
    "driver_found",
    "driver_loads",
    "token_present",
    "token_initialized",
    "certificate_readable",
    "certificate_validity",
    "pin_state",
    "signing_self_test",
]


@pytest.fixture
def backend() -> Iterator[FakeBackend]:
    fake = FakeBackend()
    with use_backend(fake):
        yield fake


@pytest.fixture
def module(tmp_path: Path) -> str:
    return make_module_file(tmp_path)


@pytest.fixture(autouse=True)
def _windows_env() -> Iterator[None]:
    env = TokenEnvironment(fs=OsFileSystem(), os_name="windows", database=load_database())
    with use_environment(env):
        yield


def _diag(module: str | None, slot_id: int | None = None) -> dict[str, dict[str, Any]]:
    steps = run_diagnostics(module_path=module, slot_id=slot_id)
    assert [s["id"] for s in steps] == STEP_IDS
    return {s["id"]: s for s in steps}


def _assert_bilingual_fix(step: dict[str, Any]) -> None:
    assert step["titleVi"] and step["titleEn"]
    assert step["fixVi"] and step["fixEn"], step["id"]


def _ok_token(backend: FakeBackend, module: str, pki: Any, **token_kwargs: Any) -> FakeToken:
    token = FakeToken(**token_kwargs)
    token.certs = [
        FakeCert(cka_id=b"\x01", certificate=pki.signer_a.cert, key=pki.signer_a.key),
        FakeCert(cka_id=b"\x02", certificate=pki.inter.cert),
    ]
    backend.add_module(module, FakeSlot(slot_id=0, token=token))
    return token


def test_all_green_path_reports_ok_and_skips_the_signing_test(
    backend: FakeBackend, module: str, pki: Any
) -> None:
    _ok_token(backend, module, pki)
    steps = _diag(module)
    for sid in STEP_IDS[:-1]:
        assert steps[sid]["status"] == "ok", sid
        assert steps[sid]["fixVi"] is None
    assert steps["signing_self_test"]["status"] == "skipped"
    assert "PIN" in steps["signing_self_test"]["fixEn"]
    assert backend.login_attempts == []  # diagnostics never log in


class _EmptyFileSystem:
    def __init__(self) -> None:
        self.environ: dict[str, str] = {}

    def is_file(self, path: str) -> bool:
        return False

    def list_dir(self, path: str) -> list[str]:
        return []


def test_no_driver_anywhere_fails_first_step(backend: FakeBackend) -> None:
    empty = TokenEnvironment(fs=_EmptyFileSystem(), os_name="windows", database=load_database())  # type: ignore[arg-type]
    with use_environment(empty):
        steps = _diag(None)
    assert steps["driver_found"]["status"] == "fail"
    _assert_bilingual_fix(steps["driver_found"])
    for sid in STEP_IDS[1:]:
        assert steps[sid]["status"] == "skipped", sid


def test_driver_path_that_does_not_exist_fails_first_step(
    backend: FakeBackend, tmp_path: Path
) -> None:
    steps = _diag(str(tmp_path / "gone.dll"))
    assert steps["driver_found"]["status"] == "fail"
    _assert_bilingual_fix(steps["driver_found"])
    assert steps["driver_loads"]["status"] == "skipped"


def test_architecture_mismatch_has_its_own_fix(backend: FakeBackend, module: str) -> None:
    backend.add_module(module, load_error="architecture")
    steps = _diag(module)
    assert steps["driver_loads"]["status"] == "fail"
    assert "64-bit" in steps["driver_loads"]["fixEn"]
    assert "64-bit" in steps["driver_loads"]["fixVi"] or "64" in steps["driver_loads"]["fixVi"]
    assert steps["token_present"]["status"] == "skipped"


def test_other_load_error_gets_the_generic_driver_fix(backend: FakeBackend, module: str) -> None:
    backend.add_module(module, load_error="load_failed")
    steps = _diag(module)
    assert steps["driver_loads"]["status"] == "fail"
    _assert_bilingual_fix(steps["driver_loads"])
    assert steps["driver_loads"]["detail"] == "load_failed"


def test_no_token_plugged_in_fails_with_replug_advice(backend: FakeBackend, module: str) -> None:
    backend.add_module(module, FakeSlot(slot_id=0, token=None))
    steps = _diag(module)
    assert steps["token_present"]["status"] == "fail"
    assert "USB" in steps["token_present"]["fixEn"] or "plug" in steps["token_present"]["fixEn"]
    _assert_bilingual_fix(steps["token_present"])
    assert steps["certificate_readable"]["status"] == "skipped"


def test_multiple_tokens_warn_and_use_the_first(
    backend: FakeBackend, module: str, pki: Any
) -> None:
    _ok_token(backend, module, pki)
    backend.modules[module].slots.append(FakeSlot(slot_id=5, token=FakeToken(label="OTHER")))
    steps = _diag(module)
    assert steps["token_present"]["status"] == "warn"
    _assert_bilingual_fix(steps["token_present"])
    assert steps["certificate_readable"]["status"] == "ok"


def test_selected_slot_must_exist(backend: FakeBackend, module: str, pki: Any) -> None:
    _ok_token(backend, module, pki)
    steps = _diag(module, slot_id=42)
    assert steps["token_present"]["status"] == "fail"


def test_selected_slot_is_used_when_several_tokens(
    backend: FakeBackend, module: str, pki: Any
) -> None:
    _ok_token(backend, module, pki)
    backend.modules[module].slots.append(FakeSlot(slot_id=5, token=FakeToken(initialized=False)))
    steps = _diag(module, slot_id=0)
    assert steps["token_initialized"]["status"] == "ok"
    steps_other = _diag(module, slot_id=5)
    assert steps_other["token_initialized"]["status"] == "fail"


def test_uninitialized_token_fails(backend: FakeBackend, module: str) -> None:
    backend.add_module(module, FakeSlot(slot_id=0, token=FakeToken(initialized=False)))
    steps = _diag(module)
    assert steps["token_initialized"]["status"] == "fail"
    _assert_bilingual_fix(steps["token_initialized"])
    assert steps["certificate_readable"]["status"] == "skipped"


def test_slot_that_cannot_be_read_fails_with_close_other_apps(
    backend: FakeBackend, module: str
) -> None:
    backend.add_module(module, FakeSlot(slot_id=0, token=FakeToken(), read_error="device"))
    steps = _diag(module)
    assert steps["token_present"]["status"] == "fail"
    assert (
        "close" in steps["token_present"]["fixEn"].lower()
        or "đóng" in steps["token_present"]["fixVi"].lower()
    )


def test_no_certificate_on_token_fails(backend: FakeBackend, module: str) -> None:
    backend.add_module(module, FakeSlot(slot_id=0, token=FakeToken(certs=[])))
    steps = _diag(module)
    assert steps["certificate_readable"]["status"] == "fail"
    _assert_bilingual_fix(steps["certificate_readable"])


def test_only_ca_certificates_fails(backend: FakeBackend, module: str, pki: Any) -> None:
    token = FakeToken(certs=[FakeCert(cka_id=b"\x02", certificate=pki.inter.cert)])
    backend.add_module(module, FakeSlot(slot_id=0, token=token))
    steps = _diag(module)
    assert steps["certificate_readable"]["status"] == "fail"
    assert steps["certificate_validity"]["status"] == "skipped"


def test_unreadable_extra_objects_only_warn(backend: FakeBackend, module: str, pki: Any) -> None:
    token = FakeToken(
        certs=[
            FakeCert(cka_id=b"\x01", certificate=pki.signer_a.cert, key=pki.signer_a.key),
            FakeCert(cka_id=b"\x03", certificate=pki.root.cert, readable=False),
        ]
    )
    backend.add_module(module, FakeSlot(slot_id=0, token=token))
    steps = _diag(module)
    assert steps["certificate_readable"]["status"] == "warn"
    _assert_bilingual_fix(steps["certificate_readable"])


def test_expired_certificate_fails_validity(backend: FakeBackend, module: str, pki: Any) -> None:
    token = FakeToken(
        certs=[FakeCert(cka_id=b"\x04", certificate=pki.expired.cert, key=pki.expired.key)]
    )
    backend.add_module(module, FakeSlot(slot_id=0, token=token))
    steps = _diag(module)
    assert steps["certificate_validity"]["status"] == "fail"
    _assert_bilingual_fix(steps["certificate_validity"])


def test_certificate_expiring_within_30_days_warns(
    backend: FakeBackend, module: str, pki: Any
) -> None:
    token = FakeToken(
        certs=[FakeCert(cka_id=b"\x05", certificate=pki.expiring.cert, key=pki.expiring.key)]
    )
    backend.add_module(module, FakeSlot(slot_id=0, token=token))
    steps = _diag(module)
    assert steps["certificate_validity"]["status"] == "warn"
    _assert_bilingual_fix(steps["certificate_validity"])


def test_pin_count_low_warns_without_a_number(backend: FakeBackend, module: str, pki: Any) -> None:
    token = _ok_token(backend, module, pki)
    token.wrong_attempts = 1
    steps = _diag(module)
    pin = steps["pin_state"]
    assert pin["status"] == "warn"
    assert "nhập sai" in pin["fixVi"] or "nhập sai" in pin["titleVi"] or "sai" in pin["detail"]
    assert "may lock it" in pin["fixEn"] or "may lock it" in pin["titleEn"]
    _assert_bilingual_fix(pin)


def test_final_try_warns_only_one_try_left(backend: FakeBackend, module: str, pki: Any) -> None:
    token = _ok_token(backend, module, pki)
    token.tries_left = 1
    token.wrong_attempts = 9
    pin = _diag(module)["pin_state"]
    assert pin["status"] == "warn"
    assert "Only 1 try left, a wrong PIN may lock it." in pin["fixEn"]
    assert "chỉ còn 1 lần thử, nhập sai PIN có thể khóa token" in pin["fixVi"]


def test_locked_token_fails_and_tells_user_to_stop(
    backend: FakeBackend, module: str, pki: Any
) -> None:
    token = _ok_token(backend, module, pki)
    token.tries_left = 0
    pin = _diag(module)["pin_state"]
    assert pin["status"] == "fail"
    assert "Không nhập PIN nữa" in pin["fixVi"]
    assert "Stop entering the PIN" in pin["fixEn"]


def test_token_requiring_pin_change_warns(backend: FakeBackend, module: str, pki: Any) -> None:
    token = _ok_token(backend, module, pki)
    token.to_be_changed = True
    pin = _diag(module)["pin_state"]
    assert pin["status"] == "warn"
    _assert_bilingual_fix(pin)


def test_diagnostics_without_any_token_support_fails_step_two(
    module: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    from chef_core.signing import pkcs11 as p11

    def missing() -> None:
        raise ImportError("no pkcs11")

    monkeypatch.setattr(p11, "_import_support", missing)
    steps = _diag(module)
    assert steps["driver_loads"]["status"] == "fail"
    assert steps["driver_loads"]["detail"] == "TOKEN_SUPPORT_UNAVAILABLE"
