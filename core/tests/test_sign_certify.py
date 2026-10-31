"""T3.07: certification (DocMDP), several signers, empty signature fields (I29, I30).

Every saved file is checked with pyHanko's validator (intact, valid, trusted). The DocMDP level
is read from the file itself, so the tests do not trust the op's own report.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
import pytest
from conftest import Harness, RpcFailure, make_numbered_pdf
from signing_support import (
    PASSWORD_A,
    PASSWORD_B,
    PASSWORD_EXPIRING,
    validate_pdf_signatures,
)


def _open(harness: Harness, tmp_path: Path, pages: int = 2) -> str:
    sample = make_numbered_pdf(tmp_path / f"doc-{uuid.uuid4().hex[:8]}.pdf", pages)
    return str(harness.open(sample)["state"]["sessionId"])


def _save(harness: Harness, sid: str, dest: Path) -> Path:
    harness.call("session.save", {"sessionId": sid, "path": str(dest)})
    return dest


def _revision(harness: Harness, sid: str) -> bytes:
    state = harness.call("session.state", {"sessionId": sid})
    return Path(state["revisionPath"]).read_bytes()


def _docmdp_level(path: Path) -> int | None:
    """The P value of the DocMDP signature (the certification), read from the file."""
    with pikepdf.open(path) as pdf:
        for field in pdf.Root.AcroForm.Fields:
            value = field.get("/V")
            if value is None:
                continue
            for ref in value.get("/Reference", []):
                if ref.get("/TransformMethod") == "/DocMDP":
                    return int(ref["/TransformParams"].get("/P", 2))
    return None


def _fields(harness: Harness, sid: str) -> list[dict[str, Any]]:
    result = harness.op("sign.listFields", {}, sid)
    fields: list[dict[str, Any]] = result["data"]["fields"]
    return fields


# -- certification (DocMDP) ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("level", "expected_p"),
    [("no-changes", 1), ("form-fill", 2), ("annotate", 3)],
)
def test_certify_writes_the_requested_docmdp_level(
    harness: Harness,
    pki: Any,
    tmp_path: Path,
    sign_services: Any,
    level: str,
    expected_p: int,
) -> None:
    sid = _open(harness, tmp_path)
    result = harness.op(
        "sign.pades",
        {"pfxPath": str(pki.pfx_a()), "password": PASSWORD_A, "certify": level},
        sid,
    )
    assert result["state"]["signed"] is True
    saved = _save(harness, sid, tmp_path / f"certified-{level}.pdf")
    assert _docmdp_level(saved) == expected_p
    if expected_p != 3:  # pyHanko does not validate the ANNOTATE level yet
        [sig] = validate_pdf_signatures(saved, pki.root.cert).signatures
        assert sig.intact and sig.valid and sig.trusted


def test_certify_rejected_when_the_document_is_already_signed(
    harness: Harness, pki: Any, tmp_path: Path, sign_services: Any
) -> None:
    sid = _open(harness, tmp_path)
    harness.op("sign.pades", {"pfxPath": str(pki.pfx_a()), "password": PASSWORD_A}, sid)
    before = _revision(harness, sid)
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "sign.pades",
            {"pfxPath": str(pki.pfx_b()), "password": PASSWORD_B, "certify": "form-fill"},
            sid,
        )
    assert exc.value.kind == "INVALID_PARAMS"
    assert _revision(harness, sid) == before


def test_form_fill_certification_allows_a_later_approval(
    harness: Harness, pki: Any, tmp_path: Path, sign_services: Any
) -> None:
    sid = _open(harness, tmp_path)
    # An empty field for the approver is created before certifying (adding a field is an
    # incremental change that the certification itself does not forbid).
    harness.op(
        "sign.addField",
        {"page": 1, "rect": [60.0, 20.0, 160.0, 60.0], "fieldName": "Approver"},
        sid,
    )
    harness.op(
        "sign.pades",
        {
            "pfxPath": str(pki.pfx_a()),
            "password": PASSWORD_A,
            "certify": "form-fill",
            "page": 0,
            "rect": [10.0, 10.0, 60.0, 40.0],
            "fieldName": "Certifier",
        },
        sid,
    )
    approval = harness.op(
        "sign.pades",
        {"pfxPath": str(pki.pfx_b()), "password": PASSWORD_B, "fieldName": "Approver"},
        sid,
    )
    assert approval["data"]["fieldName"] == "Approver"

    saved = _save(harness, sid, tmp_path / "approved.pdf")
    assert _docmdp_level(saved) == 2
    validation = validate_pdf_signatures(saved, pki.root.cert)
    assert [s.field for s in validation.signatures] == ["Certifier", "Approver"]
    assert all(s.intact and s.valid and s.trusted for s in validation.signatures)
    assert "Trần Thị B" in (validation.signatures[1].signer or "")


def test_no_changes_certification_blocks_every_later_change(
    harness: Harness, pki: Any, tmp_path: Path, sign_services: Any
) -> None:
    sid = _open(harness, tmp_path)
    harness.op(
        "sign.pades",
        {"pfxPath": str(pki.pfx_a()), "password": PASSWORD_A, "certify": "no-changes"},
        sid,
    )
    before = _revision(harness, sid)

    with pytest.raises(RpcFailure) as signing:
        harness.op("sign.pades", {"pfxPath": str(pki.pfx_b()), "password": PASSWORD_B}, sid)
    assert signing.value.kind == "BLOCKED_BY_SIGNATURE"

    with pytest.raises(RpcFailure) as adding:
        harness.op("sign.addField", {"page": 0, "rect": [10.0, 10.0, 60.0, 40.0]}, sid)
    assert adding.value.kind == "BLOCKED_BY_SIGNATURE"

    with pytest.raises(RpcFailure) as rotating:
        harness.op("page.rotate", {"pages": [0], "angle": 90}, sid)
    assert rotating.value.kind == "BLOCKED_BY_SIGNATURE"

    assert _revision(harness, sid) == before


# -- several signers ------------------------------------------------------------------------


def test_three_signers_with_fields_all_pass_the_integrity_checks(
    harness: Harness, pki: Any, tmp_path: Path, sign_services: Any
) -> None:
    sid = _open(harness, tmp_path)
    first = harness.op(
        "sign.pades",
        {
            "pfxPath": str(pki.pfx_a()),
            "password": PASSWORD_A,
            "page": 0,
            "rect": [10.0, 10.0, 90.0, 50.0],
        },
        sid,
    )
    second = harness.op(
        "sign.pades",
        {
            "pfxPath": str(pki.pfx_b()),
            "password": PASSWORD_B,
            "page": 0,
            "rect": [10.0, 60.0, 90.0, 100.0],
        },
        sid,
    )
    third = harness.op(
        "sign.pades",
        {
            "pfxPath": str(pki.pfx_expiring()),
            "password": PASSWORD_EXPIRING,
            "page": 1,
            "rect": [10.0, 10.0, 90.0, 50.0],
        },
        sid,
    )
    assert [
        first["data"]["fieldName"],
        second["data"]["fieldName"],
        third["data"]["fieldName"],
    ] == [
        "Signature1",
        "Signature2",
        "Signature3",
    ]
    assert third["changedPages"] == [1]
    assert any("expires" in w.lower() for w in third["warnings"])

    saved = _save(harness, sid, tmp_path / "three.pdf")
    validation = validate_pdf_signatures(saved, pki.root.cert)
    assert [s.field for s in validation.signatures] == ["Signature1", "Signature2", "Signature3"]
    assert all(s.intact and s.valid and s.trusted for s in validation.signatures)
    signers = [s.signer or "" for s in validation.signatures]
    assert "Nguyễn Văn A" in signers[0] and "Trần Thị B" in signers[1]
    assert "Hết Hạn Sớm" in signers[2]


def test_content_changes_are_blocked_after_signing_but_more_signatures_are_not(
    harness: Harness, pki: Any, tmp_path: Path, sign_services: Any
) -> None:
    sid = _open(harness, tmp_path)
    harness.op("sign.pades", {"pfxPath": str(pki.pfx_a()), "password": PASSWORD_A}, sid)
    before = _revision(harness, sid)

    for op_id, params in (
        ("page.rotate", {"pages": [0], "angle": 90}),
        ("page.delete", {"pages": [1]}),
        ("page.insertBlank", {"at": 0, "count": 1}),
    ):
        with pytest.raises(RpcFailure) as exc:
            harness.op(op_id, params, sid)
        assert exc.value.kind == "BLOCKED_BY_SIGNATURE", op_id
    assert _revision(harness, sid) == before

    harness.op("sign.pades", {"pfxPath": str(pki.pfx_b()), "password": PASSWORD_B}, sid)
    saved = _save(harness, sid, tmp_path / "blocked.pdf")
    assert all(s.valid for s in validate_pdf_signatures(saved, pki.root.cert).signatures)


# -- empty signature fields (sign.addField, sign.listFields) ---------------------------------


def test_adding_an_empty_field_does_not_invalidate_earlier_signatures(
    harness: Harness, pki: Any, tmp_path: Path, sign_services: Any
) -> None:
    sid = _open(harness, tmp_path)
    harness.op(
        "sign.pades",
        {
            "pfxPath": str(pki.pfx_a()),
            "password": PASSWORD_A,
            "page": 0,
            "rect": [10.0, 10.0, 90.0, 50.0],
        },
        sid,
    )
    before = _revision(harness, sid)
    added = harness.op(
        "sign.addField",
        {"page": 0, "rect": [10.0, 60.0, 90.0, 100.0], "signerLabel": "Giám đốc"},
        sid,
    )
    assert added["data"] == {"fieldName": "Signature2"}
    assert added["changedPages"] == [0]
    assert _revision(harness, sid).startswith(before)

    saved = _save(harness, sid, tmp_path / "with-empty.pdf")
    validation = validate_pdf_signatures(saved, pki.root.cert)
    assert [s.field for s in validation.signatures] == ["Signature1"]
    assert validation.signatures[0].intact and validation.signatures[0].valid

    fields = {f["fieldName"]: f for f in _fields(harness, sid)}
    assert fields["Signature1"]["signed"] is True
    assert fields["Signature2"]["signed"] is False


def test_added_field_carries_the_signer_label_as_its_tooltip(
    harness: Harness, pki: Any, tmp_path: Path, sign_services: Any
) -> None:
    sid = _open(harness, tmp_path)
    harness.op(
        "sign.addField",
        {
            "page": 1,
            "rect": [10.0, 10.0, 90.0, 50.0],
            "fieldName": "Approver",
            "signerLabel": "Người duyệt: Giám đốc",
        },
        sid,
    )
    saved = _save(harness, sid, tmp_path / "labelled.pdf")
    with pikepdf.open(saved) as pdf:
        field = next(f for f in pdf.Root.AcroForm.Fields if str(f.get("/T")) == "Approver")
        assert str(field.get("/TU")) == "Người duyệt: Giám đốc"
        assert field.get("/FT") == "/Sig"


def test_sign_into_an_added_field_by_name(
    harness: Harness, pki: Any, tmp_path: Path, sign_services: Any
) -> None:
    sid = _open(harness, tmp_path)
    rect = [30.0, 40.0, 130.0, 80.0]
    harness.op("sign.addField", {"page": 0, "rect": rect, "fieldName": "Approver"}, sid)
    result = harness.op(
        "sign.pades",
        {"pfxPath": str(pki.pfx_b()), "password": PASSWORD_B, "fieldName": "Approver"},
        sid,
    )
    assert result["data"]["fieldName"] == "Approver"
    assert result["changedPages"] == [0]

    saved = _save(harness, sid, tmp_path / "filled.pdf")
    [sig] = validate_pdf_signatures(saved, pki.root.cert).signatures
    assert sig.field == "Approver" and sig.valid and "Trần Thị B" in (sig.signer or "")
    [entry] = [f for f in _fields(harness, sid) if f["fieldName"] == "Approver"]
    assert entry["signed"] is True
    assert entry["rect"] == rect
    assert entry["page"] == 0


def test_signing_an_already_signed_field_is_refused(
    harness: Harness, pki: Any, tmp_path: Path, sign_services: Any
) -> None:
    sid = _open(harness, tmp_path)
    harness.op(
        "sign.addField", {"page": 0, "rect": [10.0, 10.0, 90.0, 50.0], "fieldName": "Once"}, sid
    )
    harness.op(
        "sign.pades",
        {"pfxPath": str(pki.pfx_a()), "password": PASSWORD_A, "fieldName": "Once"},
        sid,
    )
    before = _revision(harness, sid)
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "sign.pades",
            {"pfxPath": str(pki.pfx_b()), "password": PASSWORD_B, "fieldName": "Once"},
            sid,
        )
    assert exc.value.kind == "INVALID_PARAMS"
    assert _revision(harness, sid) == before


def test_add_field_names_and_validation(
    harness: Harness, pki: Any, tmp_path: Path, sign_services: Any
) -> None:
    sid = _open(harness, tmp_path)
    first = harness.op("sign.addField", {"page": 0, "rect": [10.0, 10.0, 90.0, 50.0]}, sid)
    second = harness.op("sign.addField", {"page": 0, "rect": [10.0, 60.0, 90.0, 100.0]}, sid)
    assert (first["data"]["fieldName"], second["data"]["fieldName"]) == ("Signature1", "Signature2")

    bad_params: list[dict[str, Any]] = [
        {"page": 0, "rect": [10.0, 10.0, 90.0, 50.0], "fieldName": "Signature1"},  # taken
        {"page": 0, "rect": [90.0, 10.0, 10.0, 50.0]},  # inverted
        {"page": 0, "rect": [10.0, 10.0, 90.0]},  # three numbers
        {"page": 9, "rect": [10.0, 10.0, 90.0, 50.0]},  # no such page
    ]
    before = _revision(harness, sid)
    for params in bad_params:
        with pytest.raises(RpcFailure) as exc:
            harness.op("sign.addField", params, sid)
        assert exc.value.kind == "INVALID_PARAMS", params
    assert _revision(harness, sid) == before


def test_list_fields_reports_each_field_and_does_not_change_the_document(
    harness: Harness, pki: Any, tmp_path: Path, sign_services: Any
) -> None:
    sid = _open(harness, tmp_path)
    assert _fields(harness, sid) == []

    harness.op(
        "sign.addField", {"page": 0, "rect": [10.0, 10.0, 90.0, 50.0], "fieldName": "A"}, sid
    )
    harness.op(
        "sign.addField", {"page": 1, "rect": [20.0, 30.0, 70.0, 60.0], "fieldName": "B"}, sid
    )
    harness.op(
        "sign.pades", {"pfxPath": str(pki.pfx_a()), "password": PASSWORD_A, "fieldName": "A"}, sid
    )
    before = _revision(harness, sid)
    state_before = harness.call("session.state", {"sessionId": sid})

    listed = _fields(harness, sid)
    assert listed == [
        {"fieldName": "A", "page": 0, "rect": [10.0, 10.0, 90.0, 50.0], "signed": True},
        {"fieldName": "B", "page": 1, "rect": [20.0, 30.0, 70.0, 60.0], "signed": False},
    ]
    assert _revision(harness, sid) == before
    assert harness.call("session.state", {"sessionId": sid}) == state_before


def test_rendered_added_field_appearance_is_drawn_for_a_visible_fill(
    harness: Harness, pki: Any, tmp_path: Path, sign_services: Any
) -> None:
    """Signing into a visible empty field draws the appearance inside that field's rect."""
    sid = _open(harness, tmp_path)
    harness.op(
        "sign.addField", {"page": 0, "rect": [30.0, 40.0, 130.0, 80.0], "fieldName": "V"}, sid
    )
    harness.op(
        "sign.pades", {"pfxPath": str(pki.pfx_a()), "password": PASSWORD_A, "fieldName": "V"}, sid
    )
    saved = _save(harness, sid, tmp_path / "visible-fill.pdf")
    pdf = pdfium.PdfDocument(saved.read_bytes())
    pdf.init_forms()
    try:
        image = pdf[0].render(scale=2, draw_annots=True).to_pil().convert("RGB")
    finally:
        pdf.close()
    top = int((200.0 - 80.0) * 2)
    bottom = int((200.0 - 40.0) * 2)
    box = image.crop((60, top, 260, bottom))
    pixels = box.load()
    assert pixels is not None
    assert any(min(pixels[x, y]) < 200 for x in range(box.width) for y in range(box.height))


def test_form_fill_refuses_new_fields_but_fills_existing_ones(
    harness: Harness, pki: Any, tmp_path: Path, sign_services: Any
) -> None:
    """P=2 allows filling existing fields. Creating a field is annotation work (P=3)."""
    sid = _open(harness, tmp_path)
    harness.op(
        "sign.addField", {"page": 0, "rect": [10.0, 10.0, 60.0, 40.0], "fieldName": "Pre"}, sid
    )
    harness.op(
        "sign.pades",
        {"pfxPath": str(pki.pfx_a()), "password": PASSWORD_A, "certify": "form-fill"},
        sid,
    )
    before = _revision(harness, sid)
    with pytest.raises(RpcFailure) as adding:
        harness.op("sign.addField", {"page": 0, "rect": [10.0, 60.0, 60.0, 90.0]}, sid)
    assert adding.value.kind == "BLOCKED_BY_SIGNATURE"
    with pytest.raises(RpcFailure) as creating:
        harness.op("sign.pades", {"pfxPath": str(pki.pfx_b()), "password": PASSWORD_B}, sid)
    assert creating.value.kind == "BLOCKED_BY_SIGNATURE"
    assert _revision(harness, sid) == before

    harness.op(
        "sign.pades", {"pfxPath": str(pki.pfx_b()), "password": PASSWORD_B, "fieldName": "Pre"}, sid
    )
    saved = _save(harness, sid, tmp_path / "form-fill-existing.pdf")
    assert all(s.valid for s in validate_pdf_signatures(saved, pki.root.cert).signatures)


def test_annotate_certification_allows_new_fields(
    harness: Harness, pki: Any, tmp_path: Path, sign_services: Any
) -> None:
    sid = _open(harness, tmp_path)
    harness.op(
        "sign.pades",
        {"pfxPath": str(pki.pfx_a()), "password": PASSWORD_A, "certify": "annotate"},
        sid,
    )
    added = harness.op("sign.addField", {"page": 0, "rect": [10.0, 60.0, 60.0, 90.0]}, sid)
    assert added["data"]["fieldName"] == "Signature2"
    saved = _save(harness, sid, tmp_path / "annotate-add.pdf")
    assert _docmdp_level(saved) == 3
