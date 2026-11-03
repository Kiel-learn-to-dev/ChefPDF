"""T6.03: content.eraseRegion (cut and cover) checked with PDFium renders and text boxes."""

from __future__ import annotations

from pathlib import Path

import pikepdf
import pytest
from conftest import Harness, RpcFailure
from content_support import ink_bbox, is_blue, is_dark, is_red, pdfium_chars, raw_pdf, render
from pdf_media import image_xobject
from PIL import Image

from chef_core.content.verify import assert_unchanged_outside

PAGE_H = 792.0
TEXT = b"BT /F1 24 Tf 40 300 Td [(Hel) -200 (lo) -100 (Wor) 50 (ld)] TJ ET"


def _sid(harness: Harness, path: Path) -> str:
    return str(harness.open(path)["state"]["sessionId"])


def _revision(harness: Harness, sid: str) -> Path:
    return Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])


def _erase(harness: Harness, sid: str, rect: list[float], **extra: object) -> dict:
    params: dict[str, object] = {"pageIndex": 0, "rect": rect, **extra}
    return harness.op("content.eraseRegion", params, sid)


def _user_to_display(box: tuple[float, float, float, float]) -> list[float]:
    left, bottom, right, top = box
    return [left, PAGE_H - top, right, PAGE_H - bottom]


def _glyph_boxes(path: Path, chars: str) -> dict[str, tuple[float, float, float, float]]:
    text, boxes = pdfium_chars(path)
    out: dict[str, tuple[float, float, float, float]] = {}
    for i, ch in enumerate(text):
        if ch in chars:
            out.setdefault(f"{ch}{i}", boxes[i])
    return out


def test_cut_removes_only_the_glyphs_inside_and_keeps_the_rest_in_place(
    harness: Harness, tmp_path: Path
) -> None:
    before = raw_pdf(tmp_path / "text.pdf", TEXT)
    text_before, boxes_before = pdfium_chars(before)
    # the glyphs W, o, r: their boxes give the rectangle to cut (display frame)
    wor = [boxes_before[i] for i, ch in enumerate(text_before) if ch in "Wor"][:3]
    rect_user = (
        min(b[0] for b in wor) + 0.5,
        min(b[1] for b in wor) - 0.5,
        max(b[2] for b in wor) - 0.5,
        max(b[3] for b in wor) + 0.5,
    )
    sid = _sid(harness, before)
    result = _erase(harness, sid, _user_to_display(rect_user))
    assert result["data"]["removedObjects"] == 0
    assert result["data"]["splitObjects"] == 1
    after = _revision(harness, sid)
    text_after, boxes_after = pdfium_chars(after)
    assert "Wor" not in text_after
    assert text_after.startswith("Hel") and text_after.endswith("ld")
    # the glyphs that stay did not move
    kept_before = [b for ch, b in zip(text_before, boxes_before, strict=True) if ch in "Helld"]
    kept_after = [b for ch, b in zip(text_after, boxes_after, strict=True) if ch in "Helld"]
    assert len(kept_before) == len(kept_after)
    for a, b in zip(kept_before, kept_after, strict=True):
        assert all(abs(x - y) < 0.05 for x, y in zip(a, b, strict=True)), (a, b)
    assert_unchanged_outside(before, after, 0, [rect_user], pad=2.0)
    # inside the rectangle nothing dark is left
    img = render(after)
    x0, top, x1, bottom = (
        int(v)
        for v in (rect_user[0], PAGE_H - rect_user[3], rect_user[2] + 1, PAGE_H - rect_user[1])
    )
    crop = img.crop((x0, top, x1, bottom))
    assert ink_bbox(crop, is_dark) is None


def test_fully_inside_objects_are_deleted_and_counted(harness: Harness, tmp_path: Path) -> None:
    content = b"q 1 0 0 rg 100 100 50 50 re f Q q 0 0 1 rg 300 300 80 80 re f Q"
    path = raw_pdf(tmp_path / "boxes.pdf", content)
    sid = _sid(harness, path)
    result = _erase(harness, sid, [90, PAGE_H - 170, 170, PAGE_H - 90])
    assert result["data"]["removedObjects"] == 1
    after = render(_revision(harness, sid))
    assert ink_bbox(after, is_red) is None
    assert ink_bbox(after, is_blue) is not None


def test_vector_is_clipped_outside_the_rectangle(harness: Harness, tmp_path: Path) -> None:
    content = b"q 0 0 1 rg 100 100 300 200 re f Q"
    path = raw_pdf(tmp_path / "vec.pdf", content)
    sid = _sid(harness, path)
    rect_user = (200.0, 150.0, 300.0, 250.0)
    result = _erase(harness, sid, _user_to_display(rect_user))
    assert result["data"]["clippedObjects"] == 1
    after = _revision(harness, sid)
    assert_unchanged_outside(path, after, 0, [rect_user], pad=2.0)
    img = render(after)
    assert ink_bbox(img.crop((200, 792 - 250, 300, 792 - 150)), is_blue) is None
    assert ink_bbox(img, is_blue) is not None


def test_partial_off_leaves_partly_covered_objects(harness: Harness, tmp_path: Path) -> None:
    path = raw_pdf(tmp_path / "partial.pdf", b"q 1 0 0 rg 100 100 200 150 re f Q")
    sid = _sid(harness, path)
    result = _erase(harness, sid, [250, PAGE_H - 300, 400, PAGE_H - 200], partial=False)
    assert result["data"]["removedObjects"] == 0 and result["data"]["clippedObjects"] == 0
    assert result["warnings"] and "partly inside" in result["warnings"][0]
    assert ink_bbox(render(_revision(harness, sid)), is_red) is not None


def _image_page(path: Path) -> Path:
    img = Image.new("RGB", (100, 100), (0, 0, 0))
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    page = pdf.pages[0]
    stream = image_xobject(pdf, img, codec="flate")
    page.obj.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im1=stream))
    page.obj.Contents = pdf.make_stream(b"q 200 0 0 200 100 300 cm /Im1 Do Q")
    pdf.save(path)
    pdf.close()
    return path


@pytest.mark.parametrize("fill", ["transparent", "white"])
def test_image_pixels_inside_are_removed_and_the_rest_kept(
    harness: Harness, tmp_path: Path, fill: str
) -> None:
    path = _image_page(tmp_path / "img.pdf")
    sid = _sid(harness, path)
    rect_user = (150.0, 350.0, 250.0, 450.0)
    result = _erase(harness, sid, _user_to_display(rect_user), imageFill=fill)
    assert result["data"]["modifiedImages"] == 1
    after = _revision(harness, sid)
    assert_unchanged_outside(path, after, 0, [rect_user], pad=2.0)
    img = render(after)
    inside = img.crop((150, 792 - 450, 250, 792 - 350))
    if fill == "white":
        assert ink_bbox(inside, is_dark) is None
    else:
        assert ink_bbox(inside, is_dark) is None  # transparent over the white page is white
    assert ink_bbox(img.crop((100, 792 - 500, 300, 792 - 300)), is_dark) is not None


def test_ordinary_erase_keeps_existing_behavior_for_shared_image(
    harness: Harness, tmp_path: Path
) -> None:
    pdf = pikepdf.new()
    pages = [pdf.add_blank_page(page_size=(612, 792)) for _ in range(2)]
    image = Image.new("RGB", (100, 100), "black")
    stream = image_xobject(pdf, image, codec="flate")
    for page in pages:
        page.obj.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im1=stream))
        page.obj.Contents = pdf.make_stream(b"q 200 0 0 200 100 300 cm /Im1 Do Q")
    path = tmp_path / "shared-image.pdf"
    pdf.save(path)
    pdf.close()

    sid = _sid(harness, path)
    result = _erase(harness, sid, _user_to_display((150, 350, 250, 450)))
    assert result["data"]["modifiedImages"] == 1
    after = _revision(harness, sid)
    with pikepdf.open(path) as original, pikepdf.open(after) as redacted:
        actual = redacted.pages[1].obj.Contents.read_bytes()
        expected = original.pages[1].obj.Contents.read_bytes()
        assert actual == expected


def test_cover_paints_a_hex_rectangle_and_keeps_content(harness: Harness, tmp_path: Path) -> None:
    path = raw_pdf(tmp_path / "cover.pdf", b"q 0 0 1 rg 100 100 300 200 re f Q")
    sid = _sid(harness, path)
    rect_user = (150.0, 150.0, 250.0, 250.0)
    result = _erase(harness, sid, _user_to_display(rect_user), mode="cover", color="#00ff00")
    assert result["data"]["covered"] == 1
    after = _revision(harness, sid)
    img = render(after)
    assert img.getpixel((200, 792 - 200)) == (0, 255, 0)
    assert img.getpixel((120, 792 - 120)) == (0, 0, 255)
    assert_unchanged_outside(path, after, 0, [rect_user], pad=2.0)


def test_cover_auto_takes_the_colour_around_the_rectangle(harness: Harness, tmp_path: Path) -> None:
    path = raw_pdf(
        tmp_path / "auto.pdf", b"q 1 1 0 rg 0 0 612 792 re f Q q 0 0 1 rg 200 200 40 40 re f Q"
    )
    sid = _sid(harness, path)
    _erase(harness, sid, _user_to_display((200.0, 200.0, 240.0, 240.0)), mode="cover")
    px = render(_revision(harness, sid)).getpixel((220, 792 - 220))
    assert px[0] > 200 and px[1] > 200 and px[2] < 60  # yellow, the colour around it


def test_text_inside_a_form_is_cut_after_flattening(harness: Harness, tmp_path: Path) -> None:
    def setup(pdf: pikepdf.Pdf, page: pikepdf.Page) -> None:
        font = pdf.make_indirect(
            pikepdf.Dictionary(
                Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica
            )
        )
        form = pdf.make_stream(b"BT /F1 24 Tf 100 300 Td (SECRET) Tj ET")
        form.Type = pikepdf.Name.XObject
        form.Subtype = pikepdf.Name.Form
        form.BBox = pikepdf.Array([0, 0, 612, 792])
        form.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
        page.obj.Resources.XObject = pikepdf.Dictionary(Fm0=form)

    path = raw_pdf(
        tmp_path / "form.pdf", b"/Fm0 Do BT /F1 24 Tf 100 500 Td (Keep) Tj ET", setup=setup
    )
    text, boxes = pdfium_chars(path)
    sec = [boxes[i] for i, ch in enumerate(text) if ch in "SECRET"]
    rect_user = (
        min(b[0] for b in sec) - 1,
        min(b[1] for b in sec) - 1,
        max(b[2] for b in sec) + 1,
        max(b[3] for b in sec) + 1,
    )
    sid = _sid(harness, path)
    result = _erase(harness, sid, _user_to_display(rect_user))
    assert result["data"]["splitObjects"] + result["data"]["removedObjects"] >= 1
    text_after, _ = pdfium_chars(_revision(harness, sid))
    assert "SECRET" not in text_after and "Keep" in text_after


def test_several_pages_and_argument_checks(harness: Harness, tmp_path: Path) -> None:
    path = raw_pdf(tmp_path / "pages.pdf", b"q 1 0 0 rg 100 100 50 50 re f Q", pages=3)
    sid = _sid(harness, path)
    result = harness.op(
        "content.eraseRegion",
        {"pages": [0, 2], "rect": [90, PAGE_H - 160, 160, PAGE_H - 90]},
        sid,
    )
    assert result["changedPages"] == [0, 2]
    with pytest.raises(RpcFailure) as both:
        harness.op("content.eraseRegion", {"pageIndex": 0, "pages": [1], "rect": [0, 0, 1, 1]}, sid)
    assert both.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as empty:
        harness.op("content.eraseRegion", {"pageIndex": 0, "rect": [5, 5, 5, 9]}, sid)
    assert empty.value.kind == "INVALID_PARAMS"
