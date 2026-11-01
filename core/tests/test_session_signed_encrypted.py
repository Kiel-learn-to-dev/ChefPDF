"""Defect 3 of the core review: an encrypted document that already has signatures.

Saving an encrypted session re-encrypts the revision by rewriting the whole file, which would
change every byte under a signature's ByteRange. A signed, encrypted document that is saved
without edits is copied byte for byte from the original; if the save would have to rewrite it,
the save is refused with BLOCKED_BY_SIGNATURE and nothing is written.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pikepdf
import pytest
from conftest import Harness, RpcFailure, make_numbered_pdf
from signing_support import PASSWORD_A, PASSWORD_B

USER = "1234"
OWNER = "owner-9876"


@pytest.fixture
def services(sign_services: Any) -> Any:
    return sign_services


def _signed_then_encrypted(harness: Harness, pki: Any, tmp_path: Path) -> Path:
    """A plain document signed through the app, then encrypted with pikepdf (the encryption
    rewrites the file, so the signature in it is no longer intact; the signature is still there
    and ``has_signatures`` sees it)."""
    plain = make_numbered_pdf(tmp_path / "plain.pdf", 3)
    sid = str(harness.open(plain)["state"]["sessionId"])
    harness.op("sign.pades", {"pfxPath": str(pki.pfx_a()), "password": PASSWORD_A}, sid)
    signed = tmp_path / "signed.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(signed)})
    encrypted = tmp_path / "encrypted_signed.pdf"
    with pikepdf.open(signed) as pdf:
        pdf.save(
            encrypted,
            encryption=pikepdf.Encryption(user=USER, owner=OWNER, R=6),
        )
    return encrypted


def test_untouched_signed_encrypted_document_is_saved_byte_for_byte(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    encrypted = _signed_then_encrypted(harness, pki, tmp_path)
    opened = harness.open(encrypted, USER)
    sid = str(opened["state"]["sessionId"])
    assert opened["state"]["signed"] is True
    out = tmp_path / "resaved.pdf"
    state = harness.call("session.save", {"sessionId": sid, "path": str(out)})
    assert state["warnings"] == []
    assert out.read_bytes() == encrypted.read_bytes()  # no rewrite: the signature bytes stay
    with pikepdf.open(out, password=USER) as pdf:
        assert pdf.is_encrypted and len(pdf.pages) == 3


def test_new_signature_on_encrypted_document_blocks_the_save(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    encrypted = _signed_then_encrypted(harness, pki, tmp_path)
    sid = str(harness.open(encrypted, USER)["state"]["sessionId"])
    harness.op("sign.pades", {"pfxPath": str(pki.pfx_b()), "password": PASSWORD_B}, sid)
    out = tmp_path / "blocked.pdf"
    with pytest.raises(RpcFailure) as exc:
        harness.call("session.save", {"sessionId": sid, "path": str(out)})
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"
    assert not out.exists()  # nothing is written when the save is refused


def test_protection_change_on_a_signed_document_is_blocked(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    encrypted = _signed_then_encrypted(harness, pki, tmp_path)
    sid = str(harness.open(encrypted, USER)["state"]["sessionId"])
    with pytest.raises(RpcFailure) as exc:
        harness.op("security.encrypt", {"userPassword": "new-pass-1"}, sid)
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"
    with pytest.raises(RpcFailure) as exc:
        harness.op("security.decrypt", {"password": USER}, sid)
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"


def test_undo_back_to_the_original_keeps_the_byte_copy(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    encrypted = _signed_then_encrypted(harness, pki, tmp_path)
    sid = str(harness.open(encrypted, USER)["state"]["sessionId"])
    harness.op("sign.pades", {"pfxPath": str(pki.pfx_b()), "password": PASSWORD_B}, sid)
    harness.call("session.undo", {"sessionId": sid})
    out = tmp_path / "undone.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(out)})
    assert out.read_bytes() == encrypted.read_bytes()
