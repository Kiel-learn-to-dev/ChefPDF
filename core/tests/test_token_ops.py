"""T3.01-T3.03 through the RPC harness: sign.driverScan, sign.listTokens, sign.diagnoseToken and
sign.padesToken (session op). Uses the fake backend, the test PKI and real PDFs."""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from conftest import Harness, RpcFailure, make_numbered_pdf
from signing_support import validate_pdf_signatures
from token_support import (
    FakeBackend,
    FakeCert,
    FakeFileSystem,
    FakeSlot,
    FakeToken,
    fake_cert_chain,
    make_module_file,
)

from chef_core import ops
from chef_core.signing import pkcs11 as p11
from chef_core.signing.drivers import OsFileSystem, TokenEnvironment, load_database, use_environment
from chef_core.signing.pkcs11 import use_backend

SECRET_PIN = "PIN-LEAK-7319"
WRONG_PIN = "0000"
CERT_ID = "01"
SYSTEM32_VIETTEL = "C:\\Windows\\System32\\viettel-ca_v6.dll"


@pytest.fixture(autouse=True)
def _windows_env() -> Iterator[None]:
    env = TokenEnvironment(fs=OsFileSystem(), os_name="windows", database=load_database())
    with use_environment(env):
        yield


@pytest.fixture
def backend() -> Iterator[FakeBackend]:
    fake = FakeBackend()
    with use_backend(fake):
        yield fake


@pytest.fixture
def module(tmp_path: Path, backend: FakeBackend, pki: Any) -> str:
    path = make_module_file(tmp_path, "chef-token.dll")
    token = FakeToken(pin=SECRET_PIN)
    token.certs = [
        FakeCert(
            cka_id=bytes.fromhex(CERT_ID), certificate=pki.signer_a.cert, key=pki.signer_a.key
        ),
        *fake_cert_chain(pki.inter.cert, pki.root.cert),
    ]
    backend.add_module(path, FakeSlot(slot_id=0, token=token, description="Test reader"))
    return path


def _open(harness: Harness, tmp_path: Path) -> str:
    sample = make_numbered_pdf(tmp_path / f"doc-{uuid.uuid4().hex[:8]}.pdf", 2)
    return str(harness.open(sample)["state"]["sessionId"])


def _pades(module: str, **overrides: Any) -> dict[str, Any]:
    params: dict[str, Any] = {
        "modulePath": module,
        "slotId": 0,
        "certId": CERT_ID,
        "pin": SECRET_PIN,
        "level": "B-B",
    }
    params.update(overrides)
    return params


def test_token_ops_are_registered_with_their_flags() -> None:
    ops.load_builtin_ops()
    reg = ops.registry()
    assert reg["sign.driverScan"].standalone
    assert reg["sign.listTokens"].standalone
    assert reg["sign.diagnoseToken"].standalone
    assert reg["sign.padesToken"].finalizing
    assert not reg["sign.padesToken"].standalone


def test_driver_scan_lists_candidates_without_probing(harness: Harness) -> None:
    data = harness.op("sign.driverScan", {})["data"]
    assert data["os"] == "windows"
    assert data["drivers"]
    first = data["drivers"][0]
    assert {"ca", "model", "path", "exists", "confidence", "bitness"} <= set(first)
    assert "probe" not in first


def test_driver_scan_probe_reports_which_driver_sees_a_token(
    harness: Harness, backend: FakeBackend
) -> None:
    fs = FakeFileSystem({SYSTEM32_VIETTEL}, {"WINDIR": "C:\\Windows"})
    backend.add_module(SYSTEM32_VIETTEL, FakeSlot(slot_id=2, token=FakeToken(label="VIETTEL-42")))
    env = TokenEnvironment(fs=fs, os_name="windows", database=load_database())  # type: ignore[arg-type]
    with use_environment(env):
        data = harness.op("sign.driverScan", {"probe": True})["data"]
    hit = next(d for d in data["drivers"] if d["path"] == SYSTEM32_VIETTEL)
    assert hit["exists"] is True
    assert hit["probe"]["status"] == "ok"
    assert hit["probe"]["tokenLabels"] == ["VIETTEL-42"]
    missing = next(d for d in data["drivers"] if not d["exists"])
    assert "probe" not in missing


def test_list_tokens_returns_tokens_and_certificates(
    harness: Harness, module: str, pki: Any
) -> None:
    data = harness.op("sign.listTokens", {"modulePath": module})["data"]
    (token,) = data["tokens"]
    assert token["slotId"] == 0
    assert token["label"] == "CHEF-TEST-TOKEN"
    assert token["pinState"] == "ok"
    certs = {c["ckaId"]: c for c in token["certificates"]}
    signer = certs[CERT_ID]
    assert signer["isCa"] is False
    assert signer["cert"]["identity"] is not None
    assert "daysUntilExpiry" in signer["cert"]
    assert len(certs) == 3
    assert certs["c0"]["isCa"] is True


def test_list_tokens_rejects_missing_and_wrong_extension(harness: Harness, tmp_path: Path) -> None:
    with pytest.raises(RpcFailure) as missing:
        harness.op("sign.listTokens", {"modulePath": str(tmp_path / "nope.dll")})
    assert missing.value.kind == "FILE_NOT_FOUND"
    text = tmp_path / "driver.txt"
    text.write_text("x", encoding="utf-8")
    with pytest.raises(RpcFailure) as wrong:
        harness.op("sign.listTokens", {"modulePath": str(text)})
    assert wrong.value.kind == "INVALID_PARAMS"


def test_diagnose_token_op_returns_ordered_steps(harness: Harness, module: str) -> None:
    data = harness.op("sign.diagnoseToken", {"modulePath": module})["data"]
    ids = [s["id"] for s in data["steps"]]
    assert ids == [
        "driver_found",
        "driver_loads",
        "token_present",
        "token_initialized",
        "certificate_readable",
        "certificate_validity",
        "pin_state",
        "signing_self_test",
    ]
    assert data["overall"] in {"ok", "warn"}


def test_pades_token_signs_with_the_token_key(
    harness: Harness, backend: FakeBackend, module: str, pki: Any, tmp_path: Path
) -> None:
    sid = _open(harness, tmp_path)
    result = harness.op("sign.padesToken", _pades(module, reason="Duyệt"), sid)
    assert result["data"]["fieldName"] == "Signature1"
    assert result["state"]["signed"] is True
    assert SECRET_PIN not in json.dumps(result, ensure_ascii=False)
    saved = tmp_path / "token-signed.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(saved)})
    validation = validate_pdf_signatures(saved, pki.root.cert)
    assert len(validation.signatures) == 1
    assert all(s.intact and s.valid and s.trusted for s in validation.signatures)
    assert backend.open_sessions == backend.closed_sessions == 1


def test_pades_token_selects_by_serial(
    harness: Harness, backend: FakeBackend, module: str, tmp_path: Path
) -> None:
    sid = _open(harness, tmp_path)
    params = _pades(module, tokenSerial=backend.token(module, 0).serial)
    del params["slotId"]
    result = harness.op("sign.padesToken", params, sid)
    assert result["data"]["fieldName"] == "Signature1"


def test_wrong_pin_is_reported_and_not_retried(
    harness: Harness, backend: FakeBackend, module: str, tmp_path: Path
) -> None:
    sid = _open(harness, tmp_path)
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.padesToken", _pades(module, pin=WRONG_PIN), sid)
    assert exc.value.kind == "TOKEN_PIN_INVALID"
    assert exc.value.detail["remainingTries"] == 9
    assert exc.value.detail["pinState"] == "count_low"
    assert len(backend.login_attempts) == 1
    assert harness.call("session.state", {"sessionId": sid})["signed"] is False


def test_locked_token_is_refused_without_login(
    harness: Harness, backend: FakeBackend, module: str, tmp_path: Path
) -> None:
    backend.token(module, 0).tries_left = 0
    sid = _open(harness, tmp_path)
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.padesToken", _pades(module), sid)
    assert exc.value.kind == "TOKEN_PIN_LOCKED"
    assert backend.login_attempts == []


def test_final_try_needs_confirm_flag(
    harness: Harness, backend: FakeBackend, module: str, tmp_path: Path
) -> None:
    backend.token(module, 0).tries_left = 1
    sid = _open(harness, tmp_path)
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.padesToken", _pades(module), sid)
    assert exc.value.kind == "TOKEN_PIN_CONFIRM_REQUIRED"
    assert backend.login_attempts == []
    result = harness.op("sign.padesToken", _pades(module, confirmFinalTry=True), sid)
    assert result["data"]["fieldName"] == "Signature1"


def test_expired_certificate_is_blocked_before_the_pin_is_used(
    harness: Harness, backend: FakeBackend, module: str, pki: Any, tmp_path: Path
) -> None:
    backend.token(module, 0).certs.append(
        FakeCert(cka_id=b"\x04", certificate=pki.expired.cert, key=pki.expired.key)
    )
    sid = _open(harness, tmp_path)
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.padesToken", _pades(module, certId="04"), sid)
    assert exc.value.kind == "SIGN_CERT_EXPIRED"
    assert backend.login_attempts == []


def test_unknown_certificate_is_token_not_found(
    harness: Harness, backend: FakeBackend, module: str, tmp_path: Path
) -> None:
    sid = _open(harness, tmp_path)
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.padesToken", _pades(module, certId="ff"), sid)
    assert exc.value.kind == "TOKEN_NOT_FOUND"
    assert backend.login_attempts == []


def test_token_selector_must_be_exactly_one(harness: Harness, module: str, tmp_path: Path) -> None:
    sid = _open(harness, tmp_path)
    both = _pades(module, tokenSerial="0123456789ABCDEF")
    with pytest.raises(RpcFailure) as exc_both:
        harness.op("sign.padesToken", both, sid)
    assert exc_both.value.kind == "INVALID_PARAMS"
    neither = _pades(module)
    del neither["slotId"]
    with pytest.raises(RpcFailure) as exc_none:
        harness.op("sign.padesToken", neither, sid)
    assert exc_none.value.kind == "INVALID_PARAMS"


def test_absent_slot_is_token_not_found(harness: Harness, module: str, tmp_path: Path) -> None:
    sid = _open(harness, tmp_path)
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.padesToken", _pades(module, slotId=9), sid)
    assert exc.value.kind == "TOKEN_NOT_FOUND"


def test_session_is_closed_when_signing_fails_after_login(
    harness: Harness, backend: FakeBackend, module: str, tmp_path: Path
) -> None:
    from signing_support import dead_url

    sid = _open(harness, tmp_path)
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "sign.padesToken",
            _pades(module, level="B-T", tsaUrls=[dead_url()]),
            sid,
        )
    assert exc.value.kind == "SIGN_TSA_FAILED"
    assert backend.open_sessions == 1
    assert backend.closed_sessions == 1


def test_pin_never_reaches_disk_wire_journal_or_logs(
    harness: Harness,
    backend: FakeBackend,
    module: str,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    sid = _open(harness, tmp_path)
    with pytest.raises(RpcFailure):
        harness.op("sign.padesToken", _pades(module, pin=SECRET_PIN + "-X"), sid)
    harness.op("sign.padesToken", _pades(module, reason="Đồng ý"), sid)
    harness.op("sign.listTokens", {"modulePath": module})
    logins_before = len(backend.login_attempts)
    harness.op("sign.diagnoseToken", {"modulePath": module})  # no PIN: must not log in
    assert len(backend.login_attempts) == logins_before

    secrets = [SECRET_PIN, SECRET_PIN + "-X"]
    for path in harness.data_dir.rglob("*"):
        if path.is_file():
            content = path.read_bytes()
            for secret in secrets:
                assert secret.encode("utf-8") not in content, path
    wire = json.dumps(harness.out.messages, ensure_ascii=False)
    for secret in secrets:
        assert secret not in wire
        assert secret not in caplog.text

    journal = (harness.data_dir / "sessions" / sid / "journal.jsonl").read_text(encoding="utf-8")
    entry = json.loads(journal.splitlines()[-1])
    assert entry["opId"] == "sign.padesToken"
    assert "pin" not in entry["params"]
    assert entry["params"]["reason"] == "Đồng ý"
    assert entry["params"]["modulePath"] == module


def test_pades_token_without_support_gives_support_unavailable(
    harness: Harness, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def missing() -> None:
        raise ImportError("no pkcs11")

    monkeypatch.setattr(p11, "_import_support", missing)
    module = make_module_file(tmp_path, "chef-token.dll")
    sid = _open(harness, tmp_path)
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.padesToken", _pades(module), sid)
    assert exc.value.kind == "TOKEN_SUPPORT_UNAVAILABLE"
    with pytest.raises(RpcFailure) as exc2:
        harness.op("sign.listTokens", {"modulePath": module})
    assert exc2.value.kind == "TOKEN_SUPPORT_UNAVAILABLE"
