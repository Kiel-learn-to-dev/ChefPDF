"""T4.13 (I33): sign.stampAndSign and sign.stampAndSignToken, one revision, all or nothing.

Signatures are made by the real PAdES engine (PFX signer from the test PKI, or the fake PKCS#11
backend for tokens) and checked with pyHanko. The stamps are read back from the signed revision
and from the revision the signature covers (extract_revision), so "the stamp is covered" is
tested, not assumed.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
import pytest
from conftest import Harness, RpcFailure
from PIL import Image
from signing_support import PASSWORD_A, validate_pdf_signatures
from token_support import (
    FakeBackend,
    FakeCert,
    FakeSlot,
    FakeToken,
    fake_cert_chain,
    make_module_file,
)

from chef_core.ops import load_builtin_ops
from chef_core.signing.pkcs11 import use_backend
from chef_core.signing.verify import extract_revision

SECRET_PIN = "STAMP-PIN-4417"
CERT_ID = "01"
RED = (220, 20, 20)


@pytest.fixture(autouse=True)
def _builtins() -> None:
    load_builtin_ops()


@pytest.fixture
def backend() -> Iterator[FakeBackend]:
    fake = FakeBackend()
    with use_backend(fake):
        yield fake


@pytest.fixture
def token_module(tmp_path: Path, backend: FakeBackend, pki: Any) -> str:
    path = make_module_file(tmp_path, "stamp-token.dll")
    token = FakeToken(pin=SECRET_PIN)
    token.certs = [
        FakeCert(
            cka_id=bytes.fromhex(CERT_ID), certificate=pki.signer_a.cert, key=pki.signer_a.key
        ),
        *fake_cert_chain(pki.inter.cert, pki.root.cert),
    ]
    backend.add_module(path, FakeSlot(slot_id=0, token=token, description="Stamp reader"))
    return path


def _blank(path: Path, count: int) -> Path:
    pdf = pikepdf.new()
    for _ in range(count):
        pdf.add_blank_page(page_size=(300, 400))
    pdf.save(path)
    return path


def _open(h: Harness, path: Path) -> str:
    return str(h.open(path)["state"]["sessionId"])


def _rev(h: Harness, sid: str) -> Path:
    return Path(h.call("session.state", {"sessionId": sid})["revisionPath"])


def _red_pixels(pdf_path: Path, page: int = 0) -> int:
    doc = pdfium.PdfDocument(str(pdf_path))
    try:
        img = doc[page].render(scale=1.0).to_pil().convert("RGB")
    finally:
        doc.close()
    data = img.tobytes()
    return sum(
        1 for i in range(0, len(data), 3) if data[i] > 180 and data[i + 1] < 90 and data[i + 2] < 90
    )


def _stamps() -> list[dict[str, Any]]:
    return [
        {
            "op": "stamp.text",
            "params": {"text": "ĐÃ DUYỆT", "x": 40, "y": 40, "borderWidth": 3, "fontSize": 24},
        },
        {
            "op": "stamp.initials",
            "params": {"text": "NA", "position": "bottom-right", "marginMm": 5},
        },
    ]


def _pfx_sign(pki: Any, **extra: Any) -> dict[str, Any]:
    sign: dict[str, Any] = {
        "pfxPath": str(pki.pfx_a()),
        "password": PASSWORD_A,
        "reason": "Duyệt hồ sơ",
    }
    sign.update(extra)
    return sign


def _journal_text(h: Harness) -> str:
    return "\n".join(p.read_text(encoding="utf-8") for p in h.data_dir.rglob("journal.jsonl"))


# -- one revision, stamps then signature ---------------------------------------------------


def test_stamps_and_signature_land_in_one_revision_and_cover_each_other(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    src = _blank(tmp_path / "in.pdf", 2)
    sid = _open(harness, src)
    result = harness.op("sign.stampAndSign", {"stamps": _stamps(), "sign": _pfx_sign(pki)}, sid)
    assert [row["op"] for row in result["data"]["stamps"]] == ["stamp.text", "stamp.initials"]
    state = harness.call("session.state", {"sessionId": sid})
    assert state["revision"] == 1  # the whole pipeline is a single revision
    assert state["signed"] is True
    rev = _rev(harness, sid)
    assert _red_pixels(rev) > 50  # the stamp is visible in the signed revision

    statuses = validate_pdf_signatures(rev, pki.root.cert).signatures
    assert len(statuses) == 1
    assert statuses[0].intact and statuses[0].valid
    assert statuses[0].modification_level in (None, "NONE")

    covered = tmp_path / "covered.pdf"
    extract_revision(rev, result["data"]["sign"]["fieldName"], covered)
    assert _red_pixels(covered) > 50  # what the signature covers already has the stamp


def test_undo_takes_the_whole_pipeline_back(harness: Harness, pki: Any, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 1)
    sid = _open(harness, src)
    harness.op("sign.stampAndSign", {"stamps": _stamps(), "sign": _pfx_sign(pki)}, sid)
    harness.call("session.undo", {"sessionId": sid})
    state = harness.call("session.state", {"sessionId": sid})
    assert state["revision"] == 0 and state["signed"] is False
    assert _red_pixels(_rev(harness, sid)) == 0


# -- all or nothing ------------------------------------------------------------------------


def test_a_failed_signature_leaves_no_stamp_behind(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    src = _blank(tmp_path / "in.pdf", 2)
    sid = _open(harness, src)
    bad = _pfx_sign(pki, password="wrong-password")
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.stampAndSign", {"stamps": _stamps(), "sign": bad}, sid)
    assert exc.value.kind is not None
    state = harness.call("session.state", {"sessionId": sid})
    assert state["revision"] == 0 and state["signed"] is False
    assert _red_pixels(_rev(harness, sid)) == 0
    assert list(harness.data_dir.rglob(".pending-*")) == []
    assert "wrong-password" not in _journal_text(harness)


def test_the_session_still_works_after_a_failed_pipeline(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    src = _blank(tmp_path / "in.pdf", 1)
    sid = _open(harness, src)
    with pytest.raises(RpcFailure):
        harness.op(
            "sign.stampAndSign",
            {"stamps": _stamps(), "sign": _pfx_sign(pki, password="nope")},
            sid,
        )
    result = harness.op("sign.stampAndSign", {"stamps": _stamps(), "sign": _pfx_sign(pki)}, sid)
    assert result["state"]["revision"] == 1
    assert validate_pdf_signatures(_rev(harness, sid), pki.root.cert).signatures[0].valid


# -- order: a signature first blocks stamps ------------------------------------------------


def test_stamps_after_a_signature_are_blocked(harness: Harness, pki: Any, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 1)
    sid = _open(harness, src)
    harness.op("sign.pades", _pfx_sign(pki), sid)
    with pytest.raises(RpcFailure) as exc:
        harness.op("stamp.text", {"text": "KHẨN", "x": 10, "y": 10}, sid)
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.stampAndSign", {"stamps": _stamps(), "sign": _pfx_sign(pki)}, sid)
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"
    assert exc.value.detail is not None


def test_only_the_listed_stamp_ops_are_accepted(harness: Harness, pki: Any, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 1)
    sid = _open(harness, src)
    for bad in ([{"op": "sign.pades", "params": {}}], [{"op": "page.rotate", "params": {}}]):
        with pytest.raises(RpcFailure) as exc:
            harness.op("sign.stampAndSign", {"stamps": bad, "sign": _pfx_sign(pki)}, sid)
        assert exc.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "sign.stampAndSign",
            {"stamps": [{"op": "stamp.text", "params": {"x": 1}}], "sign": _pfx_sign(pki)},
            sid,
        )
    assert exc.value.kind == "INVALID_PARAMS"  # the stamp's own params are checked too


def test_stamp_list_must_not_be_empty(harness: Harness, pki: Any, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 1)
    sid = _open(harness, src)
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.stampAndSign", {"stamps": [], "sign": _pfx_sign(pki)}, sid)
    assert exc.value.kind == "INVALID_PARAMS"


def test_the_password_is_never_journaled(harness: Harness, pki: Any, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 1)
    sid = _open(harness, src)
    harness.op("sign.stampAndSign", {"stamps": _stamps(), "sign": _pfx_sign(pki)}, sid)
    text = _journal_text(harness)
    assert "sign.stampAndSign" in text
    assert PASSWORD_A not in text


# -- token variant -------------------------------------------------------------------------


def test_token_variant_stamps_then_signs_with_one_login(
    harness: Harness, backend: FakeBackend, token_module: str, pki: Any, tmp_path: Path
) -> None:
    src = _blank(tmp_path / "in.pdf", 2)
    sid = _open(harness, src)
    result = harness.op(
        "sign.stampAndSignToken",
        {
            "stamps": _stamps(),
            "sign": {
                "modulePath": token_module,
                "slotId": 0,
                "certId": CERT_ID,
                "pin": SECRET_PIN,
                "reason": "Duyệt",
            },
        },
        sid,
    )
    assert result["data"]["sign"]["slotId"] == 0
    assert len(backend.login_attempts) == 1
    rev = _rev(harness, sid)
    assert validate_pdf_signatures(rev, pki.root.cert).signatures[0].intact
    assert _red_pixels(rev) > 50


def test_token_pin_is_never_journaled_or_logged(
    harness: Harness, backend: FakeBackend, token_module: str, pki: Any, tmp_path: Path
) -> None:
    src = _blank(tmp_path / "in.pdf", 1)
    sid = _open(harness, src)
    harness.op(
        "sign.stampAndSignToken",
        {
            "stamps": _stamps(),
            "sign": {"modulePath": token_module, "slotId": 0, "certId": CERT_ID, "pin": SECRET_PIN},
        },
        sid,
    )
    assert SECRET_PIN not in _journal_text(harness)


def test_token_wrong_pin_rolls_everything_back(
    harness: Harness, backend: FakeBackend, token_module: str, pki: Any, tmp_path: Path
) -> None:
    src = _blank(tmp_path / "in.pdf", 1)
    sid = _open(harness, src)
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "sign.stampAndSignToken",
            {
                "stamps": _stamps(),
                "sign": {
                    "modulePath": token_module,
                    "slotId": 0,
                    "certId": CERT_ID,
                    "pin": "0000",
                },
            },
            sid,
        )
    assert exc.value.kind == "TOKEN_PIN_INVALID"
    state = harness.call("session.state", {"sessionId": sid})
    assert state["revision"] == 0 and state["signed"] is False
    assert _red_pixels(_rev(harness, sid)) == 0


def test_stamped_image_is_visible_in_the_signed_copy(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    seal = tmp_path / "seal.png"
    Image.new("RGB", (60, 60), RED).save(seal)
    src = _blank(tmp_path / "in.pdf", 1)
    sid = _open(harness, src)
    stamps = [{"op": "stamp.image", "params": {"path": str(seal), "x": 10, "y": 10, "width": 60}}]
    harness.op("sign.stampAndSign", {"stamps": stamps, "sign": _pfx_sign(pki)}, sid)
    assert _red_pixels(_rev(harness, sid)) > 3000
