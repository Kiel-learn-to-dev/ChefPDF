"""T6.07: redaction. Find (built-in patterns), apply (real removal), independent verification,
annotations, metadata, image areas, split text, form text and the 50-page performance bound."""

from __future__ import annotations

import time
from pathlib import Path

import pikepdf
import pytest
from conftest import Harness, RpcFailure
from content_support import FONT_FILE, FONT_NAME, ink_bbox, is_dark, pdfium_chars, raw_pdf, render
from pdf_media import image_xobject, page_text
from pikepdf import Array, Dictionary, Name
from PIL import Image, ImageDraw
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from chef_core.content import erase
from chef_core.content.redact import verify
from chef_core.content.textfind import norm

PAGE_H = 792.0
LINES = [
    "Họ tên: Nguyễn Văn An - CCCD: 012 345 678 901",
    "Điện thoại: 0912 345 678, email: an.nguyen@example.com",
    "Số tài khoản: 1234567890123 tại Vietcombank",
    "Mã số thuế 0101234567-001, ngày 12/03/2024 tại Hà Nội",
    "Dòng không nhạy cảm giữ nguyên",
]


def _vn_pdf(path: Path, pages: int = 1, lines: list[str] | None = None) -> Path:
    if FONT_NAME not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(FONT_NAME, str(FONT_FILE)))
    cv = canvas.Canvas(str(path), pagesize=(612, 792))
    for _ in range(pages):
        cv.setFont(FONT_NAME, 12)
        for i, line in enumerate(lines or LINES):
            cv.drawString(72, 700 - 20 * i, line)
        cv.showPage()
    cv.save()
    return path


def _sid(harness: Harness, path: Path) -> str:
    return str(harness.open(path)["state"]["sessionId"])


def _revision(harness: Harness, sid: str) -> Path:
    return Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])


def _find(harness: Harness, sid: str, *kinds: str) -> list[dict]:
    patterns = [{"kind": k} for k in kinds]
    return list(harness.op("redact.find", {"patterns": patterns}, sid)["data"]["matches"])


def _all_builtin() -> tuple[str, ...]:
    return ("cccd", "phone", "email", "bankAccount", "taxCode", "date")


def test_find_builtin_patterns(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, _vn_pdf(tmp_path / "find.pdf"))
    by_kind: dict[str, list[str]] = {}
    for m in _find(harness, sid, *_all_builtin()):
        by_kind.setdefault(m["pattern"], []).append(m["text"])
        assert m["rects"] and len(m["rects"][0]) == 4
    assert any("012 345 678 901" in t for t in by_kind["cccd"])
    assert any("0912 345 678" in t for t in by_kind["phone"])
    assert any("an.nguyen@example.com" in t for t in by_kind["email"])
    assert any("1234567890123" in t for t in by_kind["bankAccount"])
    assert any("0101234567-001" in t for t in by_kind["taxCode"])
    assert any("12/03/2024" in t for t in by_kind["date"])


def test_literal_search_ignores_diacritics_when_asked(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, _vn_pdf(tmp_path / "lit.pdf"))
    loose = harness.op(
        "redact.find", {"patterns": [{"kind": "literal", "value": "nguyen van an"}]}, sid
    )["data"]["matches"]
    strict = harness.op(
        "redact.find",
        {"patterns": [{"kind": "literal", "value": "nguyen van an", "ignoreDiacritics": False}]},
        sid,
    )["data"]["matches"]
    assert len(loose) == 1 and strict == []


def test_apply_removes_text_boxes_and_keeps_the_rest(harness: Harness, tmp_path: Path) -> None:
    path = _vn_pdf(tmp_path / "apply.pdf")
    before_text, before_boxes = pdfium_chars(path)
    keep_idx = before_text.index("Dòng")
    keep_box = before_boxes[keep_idx]
    sid = _sid(harness, path)
    matches = _find(harness, sid, *_all_builtin())
    ids = [m["id"] for m in matches]
    result = harness.op(
        "redact.apply", {"matchIds": ids, "patterns": [{"kind": k} for k in _all_builtin()]}, sid
    )
    assert result["data"]["verification"] == {"ok": True, "leaks": []}
    after = _revision(harness, sid)
    text_after = norm(page_text(after))
    for secret in ("012 345 678 901", "0912 345 678", "an.nguyen@example.com", "1234567890123"):
        assert norm(secret) not in text_after
    assert "Dòng không nhạy cảm" in page_text(after)
    _, boxes_after = pdfium_chars(after)
    text_after_chars, _ = pdfium_chars(after)
    idx = text_after_chars.index("Dòng")
    assert all(abs(a - b) < 0.05 for a, b in zip(keep_box, boxes_after[idx], strict=True))
    img = render(after)
    for m in matches:
        for x0, y0, x1, y1 in m["rects"]:
            crop = img.crop((int(x0) + 1, int(y0) + 1, int(x1) - 1, int(y1) - 1))
            assert ink_bbox(crop, is_dark) is not None  # the black box is painted
    assert ink_bbox(img, is_dark) is not None


def test_text_split_over_tj_pieces_is_removed(harness: Harness, tmp_path: Path) -> None:
    content = b"BT /F1 24 Tf 60 500 Td [(0123) -300 (4567) -300 (89)] TJ 0 -40 Td (keep) Tj ET"
    path = raw_pdf(tmp_path / "split.pdf", content)
    sid = _sid(harness, path)
    pattern = {"kind": "literal", "value": "0123456789"}
    matches = harness.op("redact.find", {"patterns": [pattern]}, sid)["data"]["matches"]
    assert len(matches) == 1
    harness.op("redact.apply", {"matchIds": [matches[0]["id"]], "patterns": [pattern]}, sid)
    text = page_text(_revision(harness, sid))
    assert "0123" not in text and "4567" not in text and "89" not in text.replace("keep", "")
    assert "keep" in text


def test_text_inside_a_form_is_redacted(harness: Harness, tmp_path: Path) -> None:
    def setup(pdf: pikepdf.Pdf, page: pikepdf.Page) -> None:
        font = pdf.make_indirect(
            Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
        )
        form = pdf.make_stream(b"BT /F1 24 Tf 60 500 Td (SECRETCODE) Tj ET")
        form.Type = Name.XObject
        form.Subtype = Name.Form
        form.BBox = Array([0, 0, 612, 792])
        form.Resources = Dictionary(Font=Dictionary(F1=font))
        page.obj.Resources.XObject = Dictionary(Fm0=form)

    path = raw_pdf(
        tmp_path / "formtext.pdf", b"/Fm0 Do BT /F1 24 Tf 60 300 Td (Keep me) Tj ET", setup=setup
    )
    sid = _sid(harness, path)
    harness.op("redact.apply", {"patterns": [{"kind": "literal", "value": "SECRETCODE"}]}, sid)
    text = page_text(_revision(harness, sid))
    assert "SECRET" not in text and "Keep me" in text


def _scan_pdf(path: Path) -> Path:
    img = Image.new("RGB", (400, 200), (255, 255, 255))
    draw = ImageDraw.Draw(img)
    draw.rectangle((40, 40, 160, 120), fill=(0, 0, 0))
    draw.text((200, 90), "SCAN", fill=(0, 0, 0))
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    stream = image_xobject(pdf, img, codec="flate")
    pdf.pages[0].obj.Resources = Dictionary(XObject=Dictionary(Im1=stream))
    pdf.pages[0].obj.Contents = pdf.make_stream(b"q 400 0 0 200 72 400 cm /Im1 Do Q")
    pdf.save(path)
    pdf.close()
    return path


def test_image_only_area_is_baked_and_painted(harness: Harness, tmp_path: Path) -> None:
    path = _scan_pdf(tmp_path / "scan.pdf")
    before = render(path)
    sid = _sid(harness, path)
    # the black block sits at image pixels 40..160 x 40..120: page points 72+40 .. 72+160
    harness.op(
        "redact.apply",
        {"rects": [{"pageIndex": 0, "rect": [110, 110, 200, 200]}], "fill": "#ff0000"},
        sid,
    )
    after = render(_revision(harness, sid))
    red = ink_bbox(after, lambda px: px[0] > 200 and px[1] < 60 and px[2] < 60)
    assert red is not None
    assert red[0] >= 105 and red[2] <= 205
    # outside the area the scan is unchanged
    left = before.crop((0, 0, 100, 792))
    assert ink_bbox(left, is_dark) == ink_bbox(after.crop((0, 0, 100, 792)), is_dark)


@pytest.mark.parametrize("rect", [[100, 192, 150, 242], [90, 182, 210, 302]])
def test_redaction_refuses_shared_image_to_prevent_extractable_source_pixels(
    harness: Harness, tmp_path: Path, rect: list[int]
) -> None:
    pdf = pikepdf.new()
    pages = [pdf.add_blank_page(page_size=(612, 792)) for _ in range(2)]
    image = Image.new("RGB", (100, 100), "white")
    ImageDraw.Draw(image).rectangle((0, 0, 49, 99), fill="black")
    source = image_xobject(pdf, image, codec="flate")
    for page in pages:
        page.obj.Resources = Dictionary(XObject=Dictionary(Im1=source))
        page.obj.Contents = pdf.make_stream(b"q 100 0 0 100 100 500 cm /Im1 Do Q")
    path = tmp_path / "shared-image.pdf"
    pdf.save(path)
    pdf.close()

    sid = _sid(harness, path)
    before = _revision(harness, sid)
    with pytest.raises(RpcFailure) as error:
        harness.op(
            "redact.apply",
            {"rects": [{"pageIndex": 0, "rect": rect}]},
            sid,
        )
    assert error.value.kind == "REDACTION_VERIFY_FAILED"
    assert _revision(harness, sid) == before


def test_redaction_removes_image_resource_when_entire_image_is_covered(
    harness: Harness, tmp_path: Path
) -> None:
    sid = _sid(harness, _scan_pdf(tmp_path / "whole-image.pdf"))
    harness.op("redact.apply", {"rects": [{"pageIndex": 0, "rect": [60, 180, 500, 400]}]}, sid)
    with pikepdf.open(_revision(harness, sid)) as pdf:
        images = [
            obj for obj in pdf.objects
            if isinstance(obj, pikepdf.Stream) and obj.get("/Subtype") == Name.Image
        ]
        assert not images


def test_redaction_refuses_image_retained_by_unused_xobject_resource(
    harness: Harness, tmp_path: Path
) -> None:
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    image = Image.new("RGB", (100, 100), "black")
    source = image_xobject(pdf, image, codec="flate")
    page.obj.Resources = Dictionary(XObject=Dictionary(Im1=source, Unused=source))
    page.obj.Contents = pdf.make_stream(b"q 100 0 0 100 100 500 cm /Im1 Do Q")
    path = tmp_path / "unused-resource-image.pdf"
    pdf.save(path)
    pdf.close()

    sid = _sid(harness, path)
    before = _revision(harness, sid)
    with pytest.raises(RpcFailure) as error:
        harness.op(
            "redact.apply",
            {"rects": [{"pageIndex": 0, "rect": [100, 192, 150, 242]}]},
            sid,
        )
    assert error.value.kind == "REDACTION_VERIFY_FAILED"
    assert _revision(harness, sid) == before


def test_redaction_refuses_image_aliased_from_annotation_appearance_form(
    harness: Harness, tmp_path: Path
) -> None:
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    image = Image.new("RGB", (100, 100), "black")
    source = image_xobject(pdf, image, codec="flate")
    page.obj.Resources = Dictionary(XObject=Dictionary(Im1=source))
    page.obj.Contents = pdf.make_stream(b"q 100 0 0 100 100 500 cm /Im1 Do Q")
    appearance = pdf.make_stream(b"q 200 0 0 40 0 0 cm /ImAlias Do Q")
    appearance.Type = Name.XObject
    appearance.Subtype = Name.Form
    appearance.BBox = Array([0, 0, 200, 40])
    appearance.Resources = Dictionary(XObject=Dictionary(ImAlias=source))
    annot = pdf.make_indirect(
        Dictionary(
            Type=Name.Annot,
            Subtype=Name.Stamp,
            Rect=Array([300, 100, 500, 140]),
            AP=Dictionary(N=appearance),
        )
    )
    page.obj.Annots = Array([annot])
    path = tmp_path / "appearance-shared-image.pdf"
    pdf.save(path)
    pdf.close()

    sid = _sid(harness, path)
    before = _revision(harness, sid)
    with pytest.raises(RpcFailure) as error:
        harness.op(
            "redact.apply",
            {"rects": [{"pageIndex": 0, "rect": [100, 192, 150, 242]}]},
            sid,
        )
    assert error.value.kind == "REDACTION_VERIFY_FAILED"
    assert _revision(harness, sid) == before


def test_redaction_refuses_partially_clipped_vector(harness: Harness, tmp_path: Path) -> None:
    # A clipping path hides part of a vector but leaves its original geometry in the PDF.
    path = raw_pdf(tmp_path / "vector-secret.pdf", b"0 0 0 rg 100 500 m 300 500 l 200 580 l f")
    sid = _sid(harness, path)
    before = _revision(harness, sid)
    with pytest.raises(RpcFailure) as error:
        harness.op(
            "redact.apply",
            {"rects": [{"pageIndex": 0, "rect": [150, 220, 200, 270]}]},
            sid,
        )
    assert error.value.kind == "REDACTION_VERIFY_FAILED"
    assert _revision(harness, sid) == before


def test_redaction_keeps_a_plain_rectangle_backdrop_and_warns(
    harness: Harness, tmp_path: Path
) -> None:
    content = b"0.9 g 0 0 612 792 re f 0 g BT /F1 12 Tf 100 700 Td (SECRET 123) Tj ET"
    sid = _sid(harness, raw_pdf(tmp_path / "backdrop.pdf", content))
    result = harness.op(
        "redact.apply", {"rects": [{"pageIndex": 0, "rect": [90, 80, 220, 105]}]}, sid
    )
    assert any("nền hình chữ nhật" in warning for warning in result["warnings"])
    assert "SECRET" not in page_text(_revision(harness, sid))


def test_redaction_refuses_a_rectangle_the_region_only_partly_covers(
    harness: Harness, tmp_path: Path
) -> None:
    # The region crosses the rectangle's edge, so the clip would leave that edge in the file.
    sid = _sid(harness, raw_pdf(tmp_path / "edge.pdf", b"0 0 0 rg 100 500 200 80 re f"))
    with pytest.raises(RpcFailure) as error:
        harness.op("redact.apply", {"rects": [{"pageIndex": 0, "rect": [80, 200, 150, 270]}]}, sid)
    assert error.value.kind == "REDACTION_VERIFY_FAILED"


def test_redaction_refuses_an_image_it_cannot_modify(
    harness: Harness, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _scan_pdf(tmp_path / "unreadable-image.pdf")
    sid = _sid(harness, path)
    before = _revision(harness, sid)
    monkeypatch.setattr(erase, "_cut_image", lambda *args: False)
    with pytest.raises(RpcFailure) as error:
        harness.op("redact.apply", {"rects": [{"pageIndex": 0, "rect": [110, 110, 200, 200]}]}, sid)
    assert error.value.kind == "REDACTION_VERIFY_FAILED"
    assert _revision(harness, sid) == before


def test_annotation_in_the_area_is_removed(harness: Harness, tmp_path: Path) -> None:
    path = _vn_pdf(tmp_path / "annot.pdf")
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        ap_stream = pdf.make_stream(b"BT /F1 12 Tf 0 0 Td (0912 345 678) Tj ET")
        ap_stream.Type = Name.XObject
        ap_stream.Subtype = Name.Form
        ap_stream.BBox = Array([0, 0, 200, 40])
        ap_stream.Resources = Dictionary(
            Font=Dictionary(
                F1=pdf.make_indirect(
                    Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
                )
            )
        )
        annot = pdf.make_indirect(
            Dictionary(
                Type=Name.Annot,
                Subtype=Name.FreeText,
                Rect=Array([60, 500, 260, 540]),
                AP=Dictionary(N=ap_stream),
                Contents=pikepdf.String("note"),
            )
        )
        pdf.pages[0].obj.Annots = Array([annot])
        pdf.save(path)
    sid = _sid(harness, path)
    result = harness.op(
        "redact.apply",
        {"rects": [{"pageIndex": 0, "rect": [50, 240, 300, 300]}]},  # display frame: y 492..552
        sid,
    )
    assert result["data"]["removedAnnotations"] == 1
    with pikepdf.open(_revision(harness, sid)) as pdf:
        assert not pdf.pages[0].obj.get("/Annots")


def _form_pdf(path: Path) -> Path:
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    secret_ap = pdf.make_stream(b"(SECRET-4411) Tj")
    secret_ap.Type = Name.XObject
    secret_ap.Subtype = Name.Form
    secret_ap.BBox = Array([0, 0, 200, 40])
    secret = pdf.make_indirect(
        Dictionary(
            Type=Name.Annot,
            Subtype=Name.Widget,
            FT=Name.Tx,
            T=pikepdf.String("secret"),
            Rect=Array([60, 500, 260, 540]),
            V=pikepdf.String("SECRET-4411"),
            DV=pikepdf.String("SECRET-4411"),
            AP=Dictionary(N=secret_ap),
        )
    )
    other = pdf.make_indirect(
        Dictionary(
            Type=Name.Annot,
            Subtype=Name.Widget,
            FT=Name.Tx,
            T=pikepdf.String("other"),
            Rect=Array([60, 400, 260, 440]),
            V=pikepdf.String("KEEP-ME"),
            DV=pikepdf.String("KEEP-ME"),
        )
    )
    page.obj.Annots = Array([secret, other])
    pdf.Root.AcroForm = pdf.make_indirect(Dictionary(Fields=Array([secret, other])))
    pdf.save(path)
    pdf.close()
    return path


def test_redaction_scrubs_widget_defaults_and_keeps_other_fields(
    harness: Harness, tmp_path: Path
) -> None:
    sid = _sid(harness, _form_pdf(tmp_path / "form.pdf"))
    result = harness.op(
        "redact.apply", {"rects": [{"pageIndex": 0, "rect": [50, 240, 300, 300]}]}, sid
    )
    assert result["data"]["verification"] == {"ok": True, "leaks": []}
    with pikepdf.open(_revision(harness, sid)) as pdf:
        fields = pdf.Root.AcroForm.Fields
        assert [str(field.T) for field in fields] == ["other"]
        assert str(fields[0].V) == "KEEP-ME" and str(fields[0].DV) == "KEEP-ME"
        assert len(pdf.pages[0].obj.Annots) == 1


def test_redaction_refuses_to_keep_annotation_with_secret_value(
    harness: Harness, tmp_path: Path
) -> None:
    sid = _sid(harness, _form_pdf(tmp_path / "form-kept.pdf"))
    before = _revision(harness, sid)
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "redact.apply",
            {
                "rects": [{"pageIndex": 0, "rect": [50, 240, 300, 300]}],
                "removeFromAnnotations": False,
            },
            sid,
        )
    assert exc.value.kind == "REDACTION_VERIFY_FAILED"
    assert _revision(harness, sid) == before


def test_redaction_scrubs_shared_multi_widget_field_but_keeps_sibling_widget(
    harness: Harness, tmp_path: Path
) -> None:
    pdf = pikepdf.new()
    first_page = pdf.add_blank_page(page_size=(612, 792))
    second_page = pdf.add_blank_page(page_size=(612, 792))
    field = pdf.make_indirect(
        Dictionary(
            FT=Name.Tx,
            T=pikepdf.String("shared"),
            V=pikepdf.String("SECRET-4411"),
            DV=pikepdf.String("SECRET-4411"),
            Kids=Array(),
        )
    )
    target = pdf.make_indirect(
        Dictionary(
            Type=Name.Annot,
            Subtype=Name.Widget,
            Rect=Array([60, 500, 260, 540]),
            Parent=field,
            AP=Dictionary(N=pdf.make_stream(b"(SECRET-4411) Tj")),
        )
    )
    sibling = pdf.make_indirect(
        Dictionary(
            Type=Name.Annot,
            Subtype=Name.Widget,
            Rect=Array([60, 500, 260, 540]),
            Parent=field,
            AP=Dictionary(N=pdf.make_stream(b"(SECRET-4411) Tj")),
        )
    )
    target.AP.N.Type = Name.XObject
    target.AP.N.Subtype = Name.Form
    target.AP.N.BBox = Array([0, 0, 200, 40])
    sibling.AP.N.Type = Name.XObject
    sibling.AP.N.Subtype = Name.Form
    sibling.AP.N.BBox = Array([0, 0, 200, 40])
    field.Kids = Array([target, sibling])
    first_page.obj.Annots = Array([target])
    second_page.obj.Annots = Array([sibling])
    pdf.Root.AcroForm = pdf.make_indirect(Dictionary(Fields=Array([field])))
    path = tmp_path / "shared-field.pdf"
    pdf.save(path)
    pdf.close()

    sid = _sid(harness, path)
    result = harness.op(
        "redact.apply", {"rects": [{"pageIndex": 0, "rect": [50, 240, 300, 300]}]}, sid
    )
    assert result["data"]["verification"] == {"ok": True, "leaks": []}
    assert result["changedPages"] == [0, 1]
    assert any("trang khác" in warning for warning in result["warnings"])
    with pikepdf.open(_revision(harness, sid)) as redacted:
        remaining = redacted.Root.AcroForm.Fields[0]
        assert not remaining.get("/V") and not remaining.get("/DV")
        assert len(remaining.Kids) == 1
        assert "/AP" not in remaining.Kids[0]
        assert len(redacted.pages[0].obj.Annots) == 0
        assert len(redacted.pages[1].obj.Annots) == 1


def test_unsafe_annotation_outside_the_area_is_reported(harness: Harness, tmp_path: Path) -> None:
    path = _vn_pdf(tmp_path / "unsafe.pdf")
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        ap_stream = pdf.make_stream(b"BT /F1 12 Tf 0 0 Td (0912 345 678) Tj ET")
        ap_stream.Type = Name.XObject
        ap_stream.Subtype = Name.Form
        ap_stream.BBox = Array([0, 0, 200, 40])
        ap_stream.Resources = Dictionary(
            Font=Dictionary(
                F1=pdf.make_indirect(
                    Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
                )
            )
        )
        annot = pdf.make_indirect(
            Dictionary(
                Type=Name.Annot,
                Subtype=Name.Stamp,
                Rect=Array([300, 100, 500, 140]),
                AP=Dictionary(N=ap_stream),
            )
        )
        pdf.pages[0].obj.Annots = Array([annot])
        pdf.save(path)
    sid = _sid(harness, path)
    before = _revision(harness, sid)
    with pytest.raises(RpcFailure) as exc:
        harness.op("redact.apply", {"patterns": [{"kind": "phone"}]}, sid)
    assert exc.value.kind == "REDACTION_VERIFY_FAILED"
    assert exc.value.detail["leaks"]
    assert _revision(harness, sid) == before  # the session is unchanged


def test_metadata_is_scrubbed_or_reported(harness: Harness, tmp_path: Path) -> None:
    path = _vn_pdf(tmp_path / "meta.pdf")
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        pdf.docinfo["/Subject"] = pikepdf.String("CCCD 012 345 678 901")
        pdf.save(path)
    sid = _sid(harness, path)
    cccd_id = _find(harness, sid, "cccd")[0]["id"]
    base = {"patterns": [{"kind": "cccd"}], "matchIds": [cccd_id]}
    with pytest.raises(RpcFailure) as exc:
        harness.op("redact.apply", {**base, "alsoMetadata": False}, sid)
    assert exc.value.kind == "REDACTION_VERIFY_FAILED"
    result = harness.op("redact.apply", base, sid)
    assert result["data"]["verification"]["ok"] is True
    with pikepdf.open(_revision(harness, sid)) as pdf:
        assert "/Subject" not in pdf.docinfo


def test_invalid_arguments_are_refused(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, _vn_pdf(tmp_path / "args.pdf"))
    with pytest.raises(RpcFailure) as nothing:
        harness.op("redact.apply", {}, sid)
    assert nothing.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as missing:
        harness.op(
            "redact.apply", {"matchIds": ["r0-99-deadbeef"], "patterns": [{"kind": "phone"}]}, sid
        )
    assert missing.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as regex:
        harness.op("redact.find", {"patterns": [{"kind": "regex", "value": "("}]}, sid)
    assert regex.value.kind == "INVALID_PARAMS"


def test_verify_helper_reports_leaks_by_place(tmp_path: Path) -> None:
    path = _vn_pdf(tmp_path / "verify.pdf")
    leaks = verify(path, ["Nguyễn Văn An"], {})
    assert any(
        leak.where.startswith("content page") or leak.where.startswith("page") for leak in leaks
    )


def test_fifty_pages_finish_quickly(harness: Harness, tmp_path: Path) -> None:
    path = _vn_pdf(tmp_path / "fifty.pdf", pages=50)
    sid = _sid(harness, path)
    started = time.perf_counter()
    result = harness.op("redact.apply", {"patterns": [{"kind": "phone"}, {"kind": "cccd"}]}, sid)
    elapsed = time.perf_counter() - started
    assert result["data"]["redacted"] == 100
    assert elapsed < 15, f"took {elapsed:.1f}s"


# -- the label drawn in each redacted box (overlayText) -----------------------------------


def _white(px: tuple[int, int, int]) -> bool:
    return min(px) > 200


def test_overlay_label_is_centred_in_each_box(harness: Harness, tmp_path: Path) -> None:
    path = _vn_pdf(tmp_path / "label.pdf")
    sid = _sid(harness, path)
    matches = _find(harness, sid, "phone")
    assert matches
    result = harness.op(
        "redact.apply",
        {
            "matchIds": [m["id"] for m in matches],
            "patterns": [{"kind": "phone"}],
            "overlayText": "ĐÃ CHE",
        },
        sid,
    )
    assert result["data"]["verification"] == {"ok": True, "leaks": []}
    assert result["data"]["labels"] == sum(len(m["rects"]) for m in matches)
    img = render(_revision(harness, sid))
    x0, y0, x1, y1 = matches[0]["rects"][0]
    left, top = int(x0) + 1, int(y0) + 1
    crop = img.crop((left, top, int(x1) - 1, int(y1) - 1))
    bbox = ink_bbox(crop, _white)
    assert bbox is not None, "the label is drawn in white on the black box"
    cx = left + (bbox[0] + bbox[2]) / 2
    cy = top + (bbox[1] + bbox[3]) / 2
    assert abs(cx - (x0 + x1) / 2) < 4 and abs(cy - (y0 + y1) / 2) < 4
    assert bbox[2] - bbox[0] <= (x1 - x0) and bbox[3] - bbox[1] <= (y1 - y0)


def test_overlay_label_shrinks_to_fit_a_small_box(harness: Harness, tmp_path: Path) -> None:
    path = _vn_pdf(tmp_path / "small.pdf")
    sid = _sid(harness, path)
    box = [100.0, 100.0, 160.0, 116.0]  # display frame: 60 x 16 points
    harness.op(
        "redact.apply",
        {
            "rects": [{"pageIndex": 0, "rect": box}],
            "overlayText": "ĐÃ CHE ĐÃ CHE DÀI",
            "fill": "#ffffff",
        },
        sid,
    )
    img = render(_revision(harness, sid))
    left, top, right, bottom = (int(v) for v in box)
    crop = img.crop((left + 1, top + 1, right - 1, bottom - 1))
    bbox = ink_bbox(crop, is_dark)  # the label is dark on the white box
    assert bbox is not None
    assert bbox[2] - bbox[0] <= (right - left) and bbox[3] - bbox[1] <= (bottom - top)


def test_label_does_not_fail_verification_when_it_repeats_a_secret_word(
    harness: Harness, tmp_path: Path
) -> None:
    path = _vn_pdf(tmp_path / "word.pdf", lines=["Mã CHE số 4411 để kiểm tra", "Dòng khác"])
    sid = _sid(harness, path)
    result = harness.op(
        "redact.apply",
        {"patterns": [{"kind": "literal", "value": "CHE"}], "overlayText": "ĐÃ CHE"},
        sid,
    )
    assert result["data"]["verification"] == {"ok": True, "leaks": []}
    assert result["data"]["redacted"] >= 1
    text = page_text(_revision(harness, sid))
    assert "số 4411" in text  # the rest of the line stays
    assert text.count("CHE") == 1  # only the label carries the word now
