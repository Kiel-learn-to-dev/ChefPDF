"""Password and permissions (J1, J2, T5.01): security.encrypt, decrypt and encryptFile."""

from __future__ import annotations

import json
from pathlib import Path

import pikepdf
import pytest
from conftest import Harness, RpcFailure

PERMS_OFF_PRINT = {
    "printLowRes": True,
    "printHighRes": False,
    "copyContent": False,
    "modify": True,
    "annotate": True,
    "fillForms": False,
    "assemble": False,
    "accessibility": True,
}


def _session_dir(h: Harness, sid: str) -> Path:
    return h.data_dir / "sessions" / sid


def _encrypt_params(**overrides: object) -> dict[str, object]:
    params: dict[str, object] = {
        "userPassword": "user-pw-1",
        "ownerPassword": "owner-pw-2",
        "permissions": PERMS_OFF_PRINT,
    }
    params.update(overrides)
    return params


def test_encrypt_is_applied_on_save(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path
) -> None:
    sid = harness.open(corpus["vietnamese_text.pdf"])["state"]["sessionId"]
    result = harness.op("security.encrypt", _encrypt_params(), sid)
    assert result["state"]["pendingEncryption"] is True
    assert result["state"]["dirty"] is True
    assert result["state"]["revision"] == 0  # no new revision: protection is applied on save

    out = tmp_path / "locked.pdf"
    state = harness.call("session.save", {"sessionId": sid, "path": str(out)})
    assert state["warnings"] == [] and state["dirty"] is False
    assert "pendingEncryption" not in state

    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(out)
    with pikepdf.open(out, password="user-pw-1") as pdf:
        assert pdf.encryption.R == 6 and pdf.encryption.bits == 256
        assert pdf.allow.print_lowres is True
        assert pdf.allow.print_highres is False
        assert pdf.allow.extract is False
        assert pdf.allow.modify_form is False
        assert pdf.allow.modify_assembly is False
        assert pdf.allow.accessibility is True
        assert len(pdf.pages) == 3
    with pikepdf.open(out, password="owner-pw-2") as pdf:
        assert pdf.owner_password_matched


def test_reopen_with_user_password_and_wrong_password(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path
) -> None:
    sid = harness.open(corpus["vietnamese_text.pdf"])["state"]["sessionId"]
    harness.op("security.encrypt", _encrypt_params(), sid)
    out = tmp_path / "locked.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(out)})

    opened = harness.open(out, "user-pw-1")
    assert opened["info"]["encrypted"] is True and opened["info"]["pageCount"] == 3
    with pytest.raises(RpcFailure) as exc:
        harness.open(out, "wrong-password")
    assert exc.value.kind == "PASSWORD_INVALID"
    with pytest.raises(RpcFailure) as exc:
        harness.open(out)
    assert exc.value.kind == "PASSWORD_REQUIRED"


def test_later_saves_keep_the_protection(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path
) -> None:
    sid = harness.open(corpus["vietnamese_text.pdf"])["state"]["sessionId"]
    harness.op("security.encrypt", _encrypt_params(), sid)
    first = tmp_path / "first.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(first)})
    harness.op("page.delete", {"pages": [0]}, sid)
    second = tmp_path / "second.pdf"
    state = harness.call("session.save", {"sessionId": sid, "path": str(second)})
    assert state["warnings"] == []
    with pikepdf.open(second, password="user-pw-1") as pdf:
        assert len(pdf.pages) == 2


def test_journal_and_meta_never_hold_passwords(harness: Harness, corpus: dict[str, Path]) -> None:
    sid = harness.open(corpus["vietnamese_text.pdf"])["state"]["sessionId"]
    harness.op("security.encrypt", _encrypt_params(), sid)
    journal = (_session_dir(harness, sid) / "journal.jsonl").read_text(encoding="utf-8")
    meta = (_session_dir(harness, sid) / "meta.json").read_text(encoding="utf-8")
    for text in (journal, meta):
        assert "user-pw-1" not in text and "owner-pw-2" not in text
    entries = [json.loads(line) for line in journal.splitlines()]
    assert entries[-1]["opId"] == "security.encrypt"
    assert entries[-1]["params"]["permissions"]["copyContent"] is False
    assert "userPassword" not in entries[-1]["params"]
    profile = json.loads(meta)["pendingProtection"]
    assert profile["action"] == "encrypt"
    assert profile["userPasswordSet"] is True and profile["ownerPasswordSet"] is True


def test_owner_only_restrictions(harness: Harness, corpus: dict[str, Path], tmp_path: Path) -> None:
    sid = harness.open(corpus["vietnamese_text.pdf"])["state"]["sessionId"]
    harness.op("security.encrypt", {"ownerPassword": "owner-only"}, sid)
    out = tmp_path / "owner.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(out)})
    with pikepdf.open(out) as pdf:  # opens without a password
        assert pdf.is_encrypted and pdf.allow.extract is True
    with pikepdf.open(out, password="owner-only") as pdf:
        assert pdf.owner_password_matched


def test_encrypt_validation(harness: Harness, corpus: dict[str, Path]) -> None:
    sid = harness.open(corpus["vietnamese_text.pdf"])["state"]["sessionId"]
    with pytest.raises(RpcFailure) as exc:
        harness.op("security.encrypt", {"permissions": PERMS_OFF_PRINT}, sid)
    assert exc.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "security.encrypt",
            _encrypt_params(
                permissions={**PERMS_OFF_PRINT, "printLowRes": False, "printHighRes": True}
            ),
            sid,
        )
    assert exc.value.kind == "INVALID_PARAMS"


def test_signed_document_cannot_be_encrypted_or_decrypted(
    harness: Harness, corpus: dict[str, Path]
) -> None:
    sid = harness.open(corpus["fake_signed.pdf"])["state"]["sessionId"]
    with pytest.raises(RpcFailure) as exc:
        harness.op("security.encrypt", _encrypt_params(), sid)
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"
    with pytest.raises(RpcFailure) as exc:
        harness.op("security.decrypt", {}, sid)
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"


def test_decrypt_removes_protection_on_save(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path
) -> None:
    sid = harness.open(corpus["encrypted_1234.pdf"], "1234")["state"]["sessionId"]
    with pytest.raises(RpcFailure) as exc:
        harness.op("security.decrypt", {"password": "wrong"}, sid)
    assert exc.value.kind == "PASSWORD_INVALID"

    result = harness.op("security.decrypt", {"password": "1234"}, sid)
    assert result["state"]["pendingEncryption"] is True
    out = tmp_path / "plain.pdf"
    state = harness.call("session.save", {"sessionId": sid, "path": str(out)})
    assert state["warnings"] == []
    with pikepdf.open(out) as pdf:
        assert not pdf.is_encrypted and len(pdf.pages) == 3


def test_decrypt_without_password_uses_the_opened_password(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path
) -> None:
    sid = harness.open(corpus["encrypted_owner_only.pdf"], "owner-5678")["state"]["sessionId"]
    harness.op("security.decrypt", {}, sid)
    out = tmp_path / "plain.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(out)})
    with pikepdf.open(out) as pdf:
        assert not pdf.is_encrypted


def test_decrypt_of_plain_document_is_a_noop(harness: Harness, corpus: dict[str, Path]) -> None:
    sid = harness.open(corpus["vietnamese_text.pdf"])["state"]["sessionId"]
    result = harness.op("security.decrypt", {}, sid)
    assert "pendingEncryption" not in result["state"]
    assert result["state"]["dirty"] is False
    assert any("not protected" in w for w in result["warnings"])


def test_encrypt_then_decrypt_cancels_the_change(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path
) -> None:
    sid = harness.open(corpus["vietnamese_text.pdf"])["state"]["sessionId"]
    harness.op("security.encrypt", _encrypt_params(), sid)
    harness.op("security.decrypt", {}, sid)
    out = tmp_path / "plain.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(out)})
    with pikepdf.open(out) as pdf:
        assert not pdf.is_encrypted


def test_encrypt_file_standalone(harness: Harness, corpus: dict[str, Path], tmp_path: Path) -> None:
    out = tmp_path / "file_locked.pdf"
    result = harness.op(
        "security.encryptFile",
        {
            "inputPath": str(corpus["vietnamese_text.pdf"]),
            "outputPath": str(out),
            **_encrypt_params(),
        },
    )
    assert result["outputs"] == [str(out)]
    assert corpus["vietnamese_text.pdf"].read_bytes() != out.read_bytes()
    with pikepdf.open(out, password="user-pw-1") as pdf:
        assert pdf.encryption.R == 6 and len(pdf.pages) == 3


def test_encrypt_file_input_password_and_errors(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path
) -> None:
    out = tmp_path / "again.pdf"
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "security.encryptFile",
            {
                "inputPath": str(corpus["encrypted_1234.pdf"]),
                "outputPath": str(out),
                **_encrypt_params(),
            },
        )
    assert exc.value.kind == "PASSWORD_REQUIRED"
    harness.op(
        "security.encryptFile",
        {
            "inputPath": str(corpus["encrypted_1234.pdf"]),
            "inputPassword": "1234",
            "outputPath": str(out),
            **_encrypt_params(),
        },
    )
    with pikepdf.open(out, password="user-pw-1") as pdf:
        assert len(pdf.pages) == 3

    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "security.encryptFile",
            {
                "inputPath": str(corpus["fake_signed.pdf"]),
                "outputPath": str(out),
                **_encrypt_params(),
            },
        )
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"


def test_encrypt_file_in_place_is_allowed(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path
) -> None:
    target = tmp_path / "inplace.pdf"
    target.write_bytes(corpus["vietnamese_text.pdf"].read_bytes())
    harness.op(
        "security.encryptFile",
        {"inputPath": str(target), "outputPath": str(target), **_encrypt_params()},
    )
    with pikepdf.open(target, password="user-pw-1") as pdf:
        assert len(pdf.pages) == 3
