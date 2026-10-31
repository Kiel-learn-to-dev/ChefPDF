"""T4.05 and T4.06 stamp ops: stamp.text (F2, F5 dynamic lines), stamp.image (F3), stamp.initials
(F6), stamp.presets (F2 catalogue). Rendered with PDFium at 1 px per point (displayed coordinates).
The giáp lai op (stamp.seam) is tested in test_stamp_seam.py.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
import pytest
from conftest import Harness, RpcFailure
from PIL import Image, ImageDraw

from chef_core.errors import ChefError, ErrorKind
from chef_core.ops import load_builtin_ops
from chef_core.ops.base import get_op
from chef_core.ops.stamp import expand_placeholders

RED_STAMP = (220, 20, 20)


@pytest.fixture(autouse=True)
def _builtins() -> None:
    load_builtin_ops()


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


def _render(path: Path, index: int = 0, scale: float = 1.0) -> Image.Image:
    doc = pdfium.PdfDocument(str(path))
    try:
        return doc[index].render(scale=scale).to_pil().convert("RGB")
    finally:
        doc.close()


def _count(
    img: Image.Image,
    predicate: Callable[[int, int, int], bool],
    box: tuple[int, int, int, int] | None = None,
) -> int:
    region = img.crop(box) if box is not None else img
    data = region.tobytes()
    return sum(1 for i in range(0, len(data), 3) if predicate(data[i], data[i + 1], data[i + 2]))


def _red(r: int, g: int, b: int) -> bool:
    return r > 180 and g < 90 and b < 90


def _png(path: Path, size: tuple[int, int], color: tuple[int, int, int, int]) -> Path:
    Image.new("RGBA", size, color).save(path)
    return path


def _ring_png(path: Path) -> Path:
    """Transparent PNG with a red ring: alpha outside the ring is 0."""
    img = Image.new("RGBA", (120, 120), (0, 0, 0, 0))
    ImageDraw.Draw(img).ellipse([4, 4, 115, 115], outline=(220, 20, 20, 255), width=10)
    img.save(path)
    return path


def _jpeg(path: Path, size: tuple[int, int], color: tuple[int, int, int]) -> Path:
    Image.new("RGB", size, color).save(path, "JPEG", quality=95)
    return path


def _stamp_overlays(h: Harness, sid: str) -> list[dict[str, Any]]:
    data = h.op("overlay.listOverlays", {}, sid)["data"]
    return [o for o in data["overlays"] if o["kind"] == "stamp"]


# -- pure helpers ---------------------------------------------------------------------------


def test_placeholders_expand_to_local_date_time_and_user() -> None:
    now = dt.datetime(2026, 10, 31, 14, 30)
    text = "ĐÃ NHẬN – {time} {date} – {user}"
    assert expand_placeholders(text, now, "Nguyễn A") == "ĐÃ NHẬN – 14:30 31/10/2026 – Nguyễn A"
    assert expand_placeholders("{datetime}", now, None) == "14:30 31/10/2026"
    assert expand_placeholders("{user}|{date}", now, "A {B}") == "A {B}|31/10/2026"
    with pytest.raises(ChefError) as exc:
        expand_placeholders("{user}|{page}", now, None)
    assert exc.value.kind == ErrorKind.INVALID_PARAMS
    with pytest.raises(ChefError):
        expand_placeholders("{unknown}", now, None)


# -- stamp.presets --------------------------------------------------------------------------


def test_presets_are_built_in_vietnamese_and_english(harness: Harness) -> None:
    result = harness.op("stamp.presets", {})
    rows = result["data"]["presets"]
    by_id = {row["id"]: row for row in rows}
    assert by_id["approved-vi"]["text"] == "ĐÃ DUYỆT"
    texts = {row["text"] for row in rows}
    for wanted in ("ĐÃ KIỂM TRA", "BẢN SAO", "BẢN SAO Y", "SAO Y BẢN CHÍNH", "KHẨN", "MẬT"):
        assert wanted in texts, wanted
    assert {"DRAFT", "APPROVED", "CONFIDENTIAL"} <= texts
    assert {row["lang"] for row in rows} == {"vi", "en"}
    assert all(row["color"].startswith("#") and len(row["color"]) == 7 for row in rows)


def test_stamp_presets_is_standalone_and_read_only() -> None:
    spec = get_op("stamp.presets")
    assert spec is not None and spec.standalone and not spec.destructive


# -- stamp.text (F2) ------------------------------------------------------------------------


def test_text_stamp_draws_a_bordered_box_on_every_selected_page(
    harness: Harness, tmp_path: Path
) -> None:
    src = _blank(tmp_path / "in.pdf", 3)
    sid = _open(harness, src)
    result = harness.op(
        "stamp.text",
        {"text": "ĐÃ DUYỆT", "x": 50, "y": 50, "fontSize": 24, "borderWidth": 2},
        sid,
    )
    assert result["changedPages"] == [0, 1, 2]
    assert result["warnings"] == []  # every Vietnamese glyph is in the bundled font
    overlays = _stamp_overlays(harness, sid)
    assert len(overlays) == 1 and overlays[0]["pages"] == [0, 1, 2]
    img = _render(_rev(harness, sid), 0)
    # The left border is red, the inside is empty (no fill), and the box is in the right place.
    assert _count(img, _red, (50, 50, 53, 90)) > 10
    assert _count(img, _red, (0, 0, 300, 50)) == 0
    inner = (52, 52, 56, 56)  # inside the border, left of the text: paper shows through
    assert _count(img, lambda r, g, b: r > 240 and g > 240 and b > 240, inner) == 16


def test_text_stamp_fill_colour_fills_the_box(harness: Harness, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 1)
    sid = _open(harness, src)
    harness.op(
        "stamp.text",
        {"text": "KHẨN", "x": 40, "y": 40, "fontSize": 30, "fill": "#FFFF00"},
        sid,
    )
    img = _render(_rev(harness, sid))
    yellow = _count(img, lambda r, g, b: r > 230 and g > 230 and b < 60, (40, 40, 60, 60))
    assert yellow > 150


def test_text_stamp_opacity_lightens_the_border(harness: Harness, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 1)
    sid = _open(harness, src)
    harness.op(
        "stamp.text",
        {"text": "MẬT", "x": 40, "y": 40, "borderWidth": 4, "opacity": 0.5},
        sid,
    )
    pixel = _render(_rev(harness, sid)).getpixel((42, 60))
    assert pixel[0] > 200  # the stamp colour (#C00000) stays red
    assert 100 < pixel[1] < 160  # but is faded to about half over the white paper


def test_text_stamp_rotation_moves_pixels(harness: Harness, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 1)
    sid = _open(harness, src)
    harness.op("stamp.text", {"text": "BẢN SAO", "x": 150, "y": 200, "rotation": 45}, sid)
    assert _count(_render(_rev(harness, sid)), _red) > 50


def test_text_stamp_rejects_missing_text(harness: Harness, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 1)
    sid = _open(harness, src)
    with pytest.raises(RpcFailure) as exc:
        harness.op("stamp.text", {"x": 10, "y": 10}, sid)
    assert exc.value.kind == "INVALID_PARAMS"


def test_stamps_are_removed_by_kind_with_overlay_remove(harness: Harness, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 2)
    sid = _open(harness, src)
    harness.op("stamp.text", {"text": "KHẨN", "x": 40, "y": 40, "borderWidth": 3}, sid)
    assert _count(_render(_rev(harness, sid), 0), _red) > 0
    removed = harness.op("overlay.remove", {"kind": "stamp"}, sid)
    assert removed["changedPages"] == [0, 1]
    assert _count(_render(_rev(harness, sid), 0), _red) == 0


# -- stamp.image (F3) -----------------------------------------------------------------------


def test_png_stamp_keeps_its_transparent_background(harness: Harness, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 1)
    png = _ring_png(tmp_path / "ring.png")
    sid = _open(harness, src)
    harness.op("stamp.image", {"path": str(png), "x": 60, "y": 60, "width": 120}, sid)
    img = _render(_rev(harness, sid))
    assert img.getpixel((62, 62)) == (255, 255, 255)  # transparent corner shows the paper
    assert _count(img, _red, (60, 60, 180, 180)) > 200  # the ring is drawn


def test_jpeg_stamp_scales_to_the_requested_width(harness: Harness, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 1)
    jpg = _jpeg(tmp_path / "seal.jpg", (200, 100), RED_STAMP)
    sid = _open(harness, src)
    harness.op("stamp.image", {"path": str(jpg), "x": 0, "y": 0, "width": 100}, sid)
    img = _render(_rev(harness, sid))
    # 100 pt wide, 50 pt high at the top-left corner of the displayed page
    assert _count(img, _red, (0, 0, 99, 49)) > 4000
    assert _count(img, _red, (105, 0, 300, 60)) == 0


def test_multiply_darkens_the_text_below_like_ink(harness: Harness, tmp_path: Path) -> None:
    # A black block on the page, then a red seal over it, once normal and once multiply.
    base = pikepdf.new()
    page = base.add_blank_page(page_size=(300, 400))
    page.contents_add(base.make_stream(b"0 g 50 150 200 200 re f"), prepend=False)
    src = tmp_path / "block.pdf"
    base.save(src)
    seal = tmp_path / "seal.png"
    Image.new("RGB", (100, 100), RED_STAMP).save(seal)
    overlap = (220, 220)  # inside both the seal and the block (display coordinates)
    outside = (280, 280)  # seal only

    sid = _open(harness, src)
    harness.op("stamp.image", {"path": str(seal), "x": 200, "y": 200, "width": 100}, sid)
    plain = _render(_rev(harness, sid)).getpixel(overlap)
    assert plain[0] > 180 and plain[1] < 90  # opaque red over black

    sid2 = _open(harness, src)
    harness.op(
        "stamp.image",
        {"path": str(seal), "x": 200, "y": 200, "width": 100, "blendMultiply": True},
        sid2,
    )
    rev2 = _render(_rev(harness, sid2))
    assert max(rev2.getpixel(overlap)) < 60  # multiply: black stays black under the ink
    assert rev2.getpixel(outside)[0] > 180  # outside the block the seal is still red


def test_stamp_image_rejects_a_missing_file(harness: Harness, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 1)
    sid = _open(harness, src)
    with pytest.raises(RpcFailure) as exc:
        harness.op("stamp.image", {"path": str(tmp_path / "nope.png"), "x": 1, "y": 1}, sid)
    assert exc.value.kind == "FILE_NOT_FOUND"


# -- stamp.initials (F6) --------------------------------------------------------------------


def test_initials_on_odd_pages_only(harness: Harness, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 4)
    sid = _open(harness, src)
    result = harness.op(
        "stamp.initials",
        {"text": "NA", "position": "bottom-right", "marginMm": 10, "pageRange": "odd"},
        sid,
    )
    assert result["changedPages"] == [0, 2]
    corner = (300 - 60, 400 - 60, 300 - 5, 400 - 5)  # bottom-right, inside the 10 mm margin
    assert _count(_render(_rev(harness, sid), 0), lambda r, g, b: r < 200, corner) > 0
    assert _count(_render(_rev(harness, sid), 1), lambda r, g, b: r < 200, corner) == 0


def test_initials_image_at_top_left_on_every_page(harness: Harness, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 3)
    png = _png(tmp_path / "ini.png", (60, 30), (30, 60, 170, 255))
    sid = _open(harness, src)
    result = harness.op(
        "stamp.initials",
        {"path": str(png), "position": "top-left", "marginMm": 5, "widthMm": 20, "opacity": 0.8},
        sid,
    )
    assert result["changedPages"] == [0, 1, 2]
    img = _render(_rev(harness, sid), 2)
    assert _count(img, lambda r, g, b: b > r + 40, (0, 0, 80, 60)) > 300


def test_initials_need_exactly_one_source(harness: Harness, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 1)
    sid = _open(harness, src)
    with pytest.raises(RpcFailure) as exc:
        harness.op("stamp.initials", {"position": "top-left"}, sid)
    assert exc.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as exc:
        harness.op("stamp.initials", {"text": "A", "path": "x.png"}, sid)
    assert exc.value.kind == "INVALID_PARAMS"


def test_stamp_ops_are_destructive_flagged() -> None:
    for op_id in ("stamp.text", "stamp.image", "stamp.initials", "stamp.seam"):
        spec = get_op(op_id)
        assert spec is not None, op_id
        assert spec.destructive, op_id
        assert spec.group == "stamp"
