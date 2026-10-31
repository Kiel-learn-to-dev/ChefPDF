"""T4.02, T4.04, T4.09 and F12 ops: overlay.addText, addImage, watermark, letterhead, list, remove.

Ops run through the in-process RPC harness, like the other operation tests. Ink checks render
the revision with PDFium at 72 dpi (one pixel per point, displayed coordinates).
"""

from __future__ import annotations

import io
import os
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
import pytest
from conftest import Harness, RpcFailure
from PIL import Image

from chef_core.errors import ChefError, ErrorKind
from chef_core.ops.overlay import page_selection, to_points

Blank = Callable[..., Path]


def _blank(path: Path, count: int, size: tuple[int, int] = (300, 400)) -> Path:
    pdf = pikepdf.new()
    for _ in range(count):
        pdf.add_blank_page(page_size=size)
    pdf.save(path)
    return path


def _open(h: Harness, path: Path) -> str:
    return str(h.open(path)["state"]["sessionId"])


def _rev(h: Harness, sid: str) -> Path:
    return Path(h.call("session.state", {"sessionId": sid})["revisionPath"])


def _render(path: Path, index: int = 0) -> Image.Image:
    doc = pdfium.PdfDocument(str(path))
    try:
        return doc[index].render(scale=1.0).to_pil().convert("RGB")
    finally:
        doc.close()


def _count(img: Image.Image, predicate: Callable[[int, int, int], bool]) -> int:
    data = img.tobytes()
    return sum(1 for i in range(0, len(data), 3) if predicate(data[i], data[i + 1], data[i + 2]))


def _red(r: int, g: int, b: int) -> bool:
    return r > 200 and g < 80 and b < 80


def _png(size: tuple[int, int], color: tuple[int, int, int], alpha: bool = False) -> bytes:
    img = Image.new("RGBA" if alpha else "RGB", size, (*color, 255) if alpha else color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# -- helpers ----------------------------------------------------------------------------


def test_page_selection_parses_ranges_odd_even_and_pages() -> None:
    assert page_selection(None, None, 6) == [0, 1, 2, 3, 4, 5]
    assert page_selection(None, "odd", 6) == [0, 2, 4]
    assert page_selection(None, "even", 6) == [1, 3, 5]
    assert page_selection(None, "2-", 6) == [1, 2, 3, 4, 5]
    assert page_selection([0], "2-3,even", 6) == [0, 1, 2, 3, 5]
    with pytest.raises(ChefError) as exc:
        page_selection(None, "9", 6)
    assert exc.value.kind == ErrorKind.INVALID_PARAMS


def test_units_convert_to_points() -> None:
    assert to_points(10, "pt") == 10
    assert abs(to_points(10, "mm") - 28.3465) < 0.001


# -- overlay.addText --------------------------------------------------------------------


def test_add_text_reports_changed_pages_and_overlay_id(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "t.pdf", 6))
    result = harness.op(
        "overlay.addText",
        {"pageRange": "odd", "x": 20, "y": 30, "text": "Xin chào\nDòng 2"},
        sid,
    )
    assert result["changedPages"] == [0, 2, 4]
    assert result["state"]["revision"] == 1
    assert len(result["data"]["overlayId"]) == 32
    listed = harness.op("overlay.listOverlays", {}, sid)
    assert listed["state"]["revision"] == 1  # read-only: no new revision
    overlays = listed["data"]["overlays"]
    assert len(overlays) == 1
    assert overlays[0]["kind"] == "text"
    assert overlays[0]["pages"] == [0, 2, 4]


def test_add_text_draws_real_vietnamese_glyphs(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "vi.pdf", 1))
    harness.op(
        "overlay.addText",
        {"x": 20, "y": 40, "text": "Nghị định 30/2020/NĐ-CP", "fontSize": 16, "color": "#FF0000"},
        sid,
    )
    doc = pdfium.PdfDocument(str(_rev(harness, sid)))
    try:
        text = doc[0].get_textpage().get_text_range()
    finally:
        doc.close()
    assert "Nghị định" in text
    assert "NĐ-CP" in text


def test_add_text_wraps_to_the_given_width(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "wrap.pdf", 1))
    long = "từ " * 60
    harness.op("overlay.addText", {"x": 10, "y": 10, "width": 120, "text": long}, sid)
    doc = pdfium.PdfDocument(str(_rev(harness, sid)))
    try:
        text = doc[0].get_textpage().get_text_range()
    finally:
        doc.close()
    assert text.count("từ") == 60


def test_add_text_rejects_unknown_font_and_bad_color(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "bad.pdf", 1))
    for params in ({"text": "a", "fontName": "Comic"}, {"text": "a", "color": "red"}, {"text": ""}):
        with pytest.raises(RpcFailure) as exc:
            harness.call(
                "ops.run",
                {"sessionId": sid, "opId": "overlay.addText", "params": {"x": 1, "y": 1, **params}},
            )
        assert exc.value.kind == "INVALID_PARAMS"


def test_text_on_a_signed_document_is_blocked(harness: Harness, corpus: dict[str, Path]) -> None:
    sid = _open(harness, corpus["fake_signed.pdf"])
    with pytest.raises(RpcFailure) as exc:
        harness.op("overlay.addText", {"x": 1, "y": 1, "text": "x"}, sid)
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"
    with pytest.raises(RpcFailure) as exc:
        harness.op("overlay.watermark", {"text": "MẬT"}, sid)
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"
    assert harness.op("overlay.listOverlays", {}, sid)["data"]["overlays"] == []


# -- overlay.addImage -------------------------------------------------------------------


def test_add_image_keeps_aspect_ratio_when_only_width_is_given(
    harness: Harness, tmp_path: Path
) -> None:
    sid = _open(harness, _blank(tmp_path / "img.pdf", 1))
    png = tmp_path / "red.png"
    png.write_bytes(_png((40, 30), (255, 0, 0)))
    harness.op(
        "overlay.addImage", {"path": str(png), "x": 10, "y": 10, "width": 80, "under": False}, sid
    )
    img = _render(_rev(harness, sid))
    xs = [x for x in range(img.width) for y in range(img.height) if _red(*img.getpixel((x, y)))]
    ys = [y for x in range(img.width) for y in range(img.height) if _red(*img.getpixel((x, y)))]
    assert (min(xs), min(ys), max(xs) + 1, max(ys) + 1) == pytest.approx((10, 10, 90, 70), abs=1)


def test_add_image_missing_file_is_file_not_found(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "miss.pdf", 1))
    with pytest.raises(RpcFailure) as exc:
        harness.op("overlay.addImage", {"path": str(tmp_path / "nope.png"), "x": 1, "y": 1}, sid)
    assert exc.value.kind == "FILE_NOT_FOUND"


# -- list and remove (F12) --------------------------------------------------------------


def test_remove_by_id_then_undo_brings_it_back(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "rm.pdf", 3))
    added = harness.op("overlay.addText", {"x": 5, "y": 5, "text": "Bản nháp"}, sid)
    oid = added["data"]["overlayId"]
    removed = harness.op("overlay.remove", {"ids": [oid]}, sid)
    assert removed["data"]["removedIds"] == [oid]
    assert removed["changedPages"] == [0, 1, 2]
    assert harness.op("overlay.listOverlays", {}, sid)["data"]["overlays"] == []
    harness.call("session.undo", {"sessionId": sid})
    assert [o["id"] for o in harness.op("overlay.listOverlays", {}, sid)["data"]["overlays"]] == [
        oid
    ]


def test_remove_with_no_match_creates_no_revision(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "none.pdf", 2))
    result = harness.op("overlay.remove", {"kind": "letterhead"}, sid)
    assert result["changedPages"] == []
    assert result["state"]["revision"] == 0


def test_remove_needs_a_selector(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "sel.pdf", 1))
    with pytest.raises(RpcFailure) as exc:
        harness.call("ops.run", {"sessionId": sid, "opId": "overlay.remove", "params": {}})
    assert exc.value.kind == "INVALID_PARAMS"


# -- overlay.watermark (F1) --------------------------------------------------------------


def _watermark_ink(img: Image.Image) -> int:
    # The default opacity (0.25) makes the grey a light tint: anything not white is ink.
    return _count(img, lambda r, g, b: r < 250 or g < 250 or b < 250)


def test_center_and_tiled_watermarks(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "wm.pdf", 3))
    harness.op("overlay.watermark", {"text": "BẢN NHÁP", "mode": "center", "fontSize": 40}, sid)
    center = _render(_rev(harness, sid))
    assert _watermark_ink(center) > 100
    sid2 = _open(harness, _blank(tmp_path / "wm2.pdf", 3))
    harness.op(
        "overlay.watermark",
        {"text": "BẢN NHÁP", "mode": "tiled", "fontSize": 40, "spacing": 30},
        sid2,
    )
    tiled = _render(_rev(harness, sid2))
    assert _watermark_ink(tiled) > 3 * _watermark_ink(center)


def test_watermark_under_stays_beneath_content(harness: Harness, tmp_path: Path) -> None:
    path = tmp_path / "black.pdf"
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300, 400))
    page.Contents = pdf.make_stream(b"0 0 0 rg 0 0 300 400 re f")
    pdf.save(path)
    sid = _open(harness, path)
    harness.op(
        "overlay.watermark",
        {
            "text": "MẬT",
            "fontSize": 90,
            "color": "#FFFFFF",
            "opacity": 1,
            "rotation": 0,
            "under": True,
        },
        sid,
    )
    under = _render(_rev(harness, sid))
    assert _count(under, lambda r, g, b: r > 200) == 0  # white text is hidden under black

    sid2 = _open(harness, path)
    harness.op(
        "overlay.watermark",
        {"text": "MẬT", "fontSize": 90, "color": "#FFFFFF", "opacity": 1, "rotation": 0},
        sid2,
    )
    over = _render(_rev(harness, sid2))
    assert _count(over, lambda r, g, b: r > 200) > 200


def test_image_watermark(harness: Harness, tmp_path: Path) -> None:
    png = tmp_path / "logo.png"
    png.write_bytes(_png((60, 60), (0, 0, 255), alpha=True))
    sid = _open(harness, _blank(tmp_path / "imgwm.pdf", 2))
    result = harness.op(
        "overlay.watermark", {"path": str(png), "width": 100, "opacity": 1, "rotation": 0}, sid
    )
    assert result["changedPages"] == [0, 1]
    img = _render(_rev(harness, sid))
    assert _count(img, lambda r, g, b: b > 200 and r < 80) > 1000


def test_watermark_needs_exactly_one_source(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "one.pdf", 1))
    with pytest.raises(RpcFailure) as exc:
        harness.call("ops.run", {"sessionId": sid, "opId": "overlay.watermark", "params": {}})
    assert exc.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as exc:
        harness.call(
            "ops.run",
            {
                "sessionId": sid,
                "opId": "overlay.watermark",
                "params": {"text": "a", "path": str(tmp_path / "x.png")},
            },
        )
    assert exc.value.kind == "INVALID_PARAMS"


def _size_after(harness: Harness, tmp_path: Path, pages: int, name: str) -> tuple[int, float]:
    src = _blank(tmp_path / f"{name}.pdf", pages)
    sid = _open(harness, src)
    started = time.perf_counter()
    harness.op("overlay.watermark", {"text": "BẢN SAO", "mode": "tiled", "spacing": 40}, sid)
    elapsed = time.perf_counter() - started
    return _rev(harness, sid).stat().st_size, elapsed


def test_watermark_on_100_pages_is_fast_and_shares_one_form(
    harness: Harness, tmp_path: Path
) -> None:
    small, _ = _size_after(harness, tmp_path, 10, "w10")
    big, elapsed = _size_after(harness, tmp_path, 100, "w100")
    assert elapsed < 10
    # Each page adds its marked chunk, a wrap and one resource name (about 0.5 KB before
    # compression), but not a copy of the watermark: the form and the font are stored once.
    assert (big - small) / 90 < 700


@pytest.mark.slow
@pytest.mark.skipif(os.environ.get("CHEF_SLOW") != "1", reason="set CHEF_SLOW=1 to run")
def test_watermark_on_500_pages_under_20_seconds(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "w500.pdf", 500))
    started = time.perf_counter()
    harness.op("overlay.watermark", {"text": "BẢN SAO", "mode": "tiled"}, sid)
    assert time.perf_counter() - started < 20


# -- overlay.letterhead (F11) -----------------------------------------------------------


def _letterhead_source(path: Path, bands: list[tuple[float, float, float]]) -> Path:
    """One page per entry: a band of colour (r, g, b) across the top 50 points."""
    pdf = pikepdf.new()
    for r, g, b in bands:
        page = pdf.add_blank_page(page_size=(300, 400))
        page.Contents = pdf.make_stream(f"{r} {g} {b} rg 0 350 300 50 re f".encode())
    pdf.save(path)
    return path


def test_letterhead_under_and_mapped_pages(harness: Harness, tmp_path: Path) -> None:
    head = _letterhead_source(tmp_path / "head.pdf", [(1, 0, 0), (0, 0, 1)])
    target = tmp_path / "body.pdf"
    pdf = pikepdf.new()
    for i in range(3):
        page = pdf.add_blank_page(page_size=(300, 400))
        if i == 0:  # only the first body page has its own black band (drawn above the letterhead)
            page.Contents = pdf.make_stream(b"0 0 0 rg 0 350 300 50 re f")
    pdf.save(target)
    sid = _open(harness, target)
    result = harness.op(
        "overlay.letterhead",
        {"sourcePath": str(head), "first": 0, "rest": 1, "scaling": "none"},
        sid,
    )
    assert result["changedPages"] == [0, 1, 2]
    first = _render(_rev(harness, sid), 0)
    second = _render(_rev(harness, sid), 1)
    third = _render(_rev(harness, sid), 2)
    # Under (the default): the body band hides the red letterhead on page 1.
    assert first.getpixel((10, 10)) == (0, 0, 0)
    assert _count(first, lambda r, g, b: r > 200 and g < 80) == 0
    # Pages 2 and 3 get the "rest" source (blue) because only "first" was mapped to page 1.
    assert second.getpixel((10, 10)) == (0, 0, 255)
    assert third.getpixel((10, 10)) == (0, 0, 255)


def test_letterhead_over_the_body(harness: Harness, tmp_path: Path) -> None:
    head = _letterhead_source(tmp_path / "head2.pdf", [(1, 0, 0)])
    target = tmp_path / "body2.pdf"
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300, 400))
    page.Contents = pdf.make_stream(b"0 0 0 rg 0 350 300 50 re f")
    pdf.save(target)
    sid = _open(harness, target)
    harness.op(
        "overlay.letterhead",
        {"sourcePath": str(head), "sourcePage": 0, "scaling": "none", "under": False},
        sid,
    )
    img = _render(_rev(harness, sid))
    assert img.getpixel((10, 10)) == (255, 0, 0)


def test_letterhead_fit_scales_into_a_shorter_page(harness: Harness, tmp_path: Path) -> None:
    head = _letterhead_source(tmp_path / "head3.pdf", [(1, 0, 0)])
    sid = _open(harness, _blank(tmp_path / "short.pdf", 1, size=(300, 200)))
    harness.op(
        "overlay.letterhead",
        {"sourcePath": str(head), "sourcePage": 0, "scaling": "fit"},
        sid,
    )
    img = _render(_rev(harness, sid))
    xs = [x for x in range(img.width) for y in range(img.height) if _red(*img.getpixel((x, y)))]
    ys = [y for x in range(img.width) for y in range(img.height) if _red(*img.getpixel((x, y)))]
    # Source 300x400 scales by 0.5 to 150x200 and is centred horizontally: band 150 x 25.
    assert (min(xs), min(ys), max(xs) + 1, max(ys) + 1) == pytest.approx((75, 0, 225, 25), abs=1)


def test_letterhead_source_page_is_one_shared_form(harness: Harness, tmp_path: Path) -> None:
    head = _letterhead_source(tmp_path / "head4.pdf", [(1, 0, 0)])
    small_sid = _open(harness, _blank(tmp_path / "l10.pdf", 10))
    harness.op("overlay.letterhead", {"sourcePath": str(head), "sourcePage": 0}, small_sid)
    small = _rev(harness, small_sid).stat().st_size
    big_sid = _open(harness, _blank(tmp_path / "l100.pdf", 100))
    harness.op("overlay.letterhead", {"sourcePath": str(head), "sourcePage": 0}, big_sid)
    big = _rev(harness, big_sid).stat().st_size
    assert (big - small) / 90 < 700  # per page: marks and a resource name, not a copy


def test_letterhead_rejects_a_missing_source(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "lh.pdf", 1))
    with pytest.raises(RpcFailure) as exc:
        harness.op("overlay.letterhead", {"sourcePath": str(tmp_path / "x.pdf")}, sid)
    assert exc.value.kind == "FILE_NOT_FOUND"


def test_ops_are_registered_with_their_flags() -> None:
    from chef_core.ops import get_op, load_builtin_ops

    load_builtin_ops()
    for op_id in (
        "overlay.addText",
        "overlay.addImage",
        "overlay.watermark",
        "overlay.letterhead",
        "overlay.remove",
    ):
        spec = get_op(op_id)
        assert spec is not None and spec.destructive and not spec.finalizing
    listing = get_op("overlay.listOverlays")
    assert listing is not None and not listing.destructive
    descriptor: dict[str, Any] = get_op("overlay.watermark").descriptor()  # type: ignore[union-attr]
    assert descriptor["group"] == "overlay"


def test_watermark_is_centred_on_a_rotated_cropped_page_and_tagged(
    harness: Harness, tmp_path: Path
) -> None:
    path = tmp_path / "rot.pdf"
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300, 400))
    page.CropBox = pikepdf.Array([20, 30, 260, 330])  # visible 240 x 300
    page.Rotate = 90  # displayed 300 x 240
    pdf.save(path)
    sid = _open(harness, path)
    harness.op(
        "overlay.watermark",
        {"text": "MMM", "fontSize": 40, "color": "#FF0000", "opacity": 1, "rotation": 0},
        sid,
    )
    rev = _rev(harness, sid)
    img = _render(rev)
    assert img.size == (300, 240)
    xs: list[int] = []
    ys: list[int] = []
    for y in range(img.height):
        for x in range(img.width):
            if _red(*img.getpixel((x, y))):
                xs.append(x)
                ys.append(y)
    assert xs, "the watermark was not drawn"
    assert abs(sum(xs) / len(xs) - 150) < 3
    assert abs(sum(ys) / len(ys) - 120) < 3
    with pikepdf.open(rev) as reopened:
        raw = reopened.pages[0].obj.Contents.read_bytes()
    assert b"/Subtype /Watermark" in raw and b"/ChefOverlay" in raw


def test_letterhead_follows_the_rotation_of_its_source(harness: Harness, tmp_path: Path) -> None:
    head = tmp_path / "rot_head.pdf"
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300, 400))
    page.Rotate = 90  # displayed 400 x 300; the source top edge becomes the right edge
    page.Contents = pdf.make_stream(b"1 0 0 rg 0 350 300 50 re f")
    pdf.save(head)
    target = _blank(tmp_path / "rot_body.pdf", 1, size=(400, 300))
    sid = _open(harness, target)
    harness.op(
        "overlay.letterhead", {"sourcePath": str(head), "sourcePage": 0, "scaling": "none"}, sid
    )
    img = _render(_rev(harness, sid))
    xs = [x for x in range(img.width) for y in range(img.height) if _red(*img.getpixel((x, y)))]
    ys = [y for x in range(img.width) for y in range(img.height) if _red(*img.getpixel((x, y)))]
    assert (min(xs), min(ys), max(xs) + 1, max(ys) + 1) == pytest.approx((350, 0, 400, 300), abs=1)
