"""T3.06 + session rules: the signed flag, blocked destructive ops, and no password on disk."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import pytest
from conftest import Harness, RpcFailure, make_numbered_pdf
from signing_support import PASSWORD_A, PASSWORD_B, validate_pdf_signatures


@pytest.fixture
def services(sign_services: Any) -> Any:
    return sign_services


def _open(harness: Harness, tmp_path: Path) -> str:
    sample = make_numbered_pdf(tmp_path / f"doc-{uuid.uuid4().hex[:8]}.pdf", 3)
    return str(harness.open(sample)["state"]["sessionId"])


def test_signed_flag_and_blocked_destructive_ops(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    assert harness.call("session.state", {"sessionId": sid})["signed"] is False

    result = harness.op("sign.pades", {"pfxPath": str(pki.pfx_a()), "password": PASSWORD_A}, sid)
    assert result["state"]["signed"] is True
    assert result["state"]["revision"] == 1

    with pytest.raises(RpcFailure) as exc:
        harness.op("page.rotate", {"pages": [0], "angle": 90}, sid)
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"

    # Signing again is allowed: it is incremental, not destructive.
    again = harness.op("sign.pades", {"pfxPath": str(pki.pfx_b()), "password": PASSWORD_B}, sid)
    assert again["state"]["revision"] == 2
    assert again["data"]["fieldName"] == "Signature2"


def test_undo_restores_unsigned_state(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    harness.op("sign.pades", {"pfxPath": str(pki.pfx_a()), "password": PASSWORD_A}, sid)
    harness.call("session.undo", {"sessionId": sid})
    assert harness.call("session.state", {"sessionId": sid})["signed"] is False


def test_signed_file_is_reported_as_signed_when_opened(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    harness.op("sign.pades", {"pfxPath": str(pki.pfx_a()), "password": PASSWORD_A}, sid)
    saved = tmp_path / "signed-copy.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(saved)})

    reopened = harness.open(saved)
    assert reopened["state"]["signed"] is True
    assert reopened["info"]["hasSignatures"] is True


def test_saved_document_validates(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    harness.op("sign.pades", {"pfxPath": str(pki.pfx_a()), "password": PASSWORD_A}, sid)
    harness.op("sign.pades", {"pfxPath": str(pki.pfx_b()), "password": PASSWORD_B}, sid)
    saved = tmp_path / "two-signers.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(saved)})

    validation = validate_pdf_signatures(saved, pki.root.cert)
    assert len(validation.signatures) == 2
    assert all(s.intact and s.valid and s.trusted for s in validation.signatures)


def test_no_password_reaches_disk_or_the_wire(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    harness.op("sign.pades", {"pfxPath": str(pki.pfx_a()), "password": PASSWORD_A}, sid)
    harness.op("sign.pades", {"pfxPath": str(pki.pfx_b()), "password": PASSWORD_B}, sid)
    with pytest.raises(RpcFailure):
        harness.op("sign.pades", {"pfxPath": str(pki.pfx_a()), "password": "sai-mat-khau"}, sid)
    harness.op("sign.certInfo", {"pfxPath": str(pki.pfx_b()), "password": PASSWORD_B})

    secrets = [PASSWORD_A, PASSWORD_B, "sai-mat-khau"]
    for path in harness.data_dir.rglob("*"):
        if path.is_file():
            content = path.read_bytes()
            for secret in secrets:
                assert secret.encode("utf-8") not in content, path
                assert secret.encode("utf-16-le") not in content, path

    wire = json.dumps(harness.out.messages, ensure_ascii=False)
    for secret in secrets:
        assert secret not in wire


def test_journal_records_the_operation_without_password(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    harness.op(
        "sign.pades", {"pfxPath": str(pki.pfx_a()), "password": PASSWORD_A, "reason": "Đồng ý"}, sid
    )
    journal = (harness.data_dir / "sessions" / sid / "journal.jsonl").read_text(encoding="utf-8")
    entry = json.loads(journal.splitlines()[-1])
    assert entry["opId"] == "sign.pades"
    assert "password" not in entry["params"]
    assert entry["params"]["reason"] == "Đồng ý"
