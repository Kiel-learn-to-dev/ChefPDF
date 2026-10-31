"""T4.06 giáp lai (stamp.seam, F4): one seal cut into strips, one strip per page edge.

The check renders the revision with PDFium, cuts the right (or left) edge strip out of every
page, and compares the strips side by side with the original seal. Odd widths (N does not divide
the width) and single-page documents are covered, plus sets (groupSize) and file size.
"""

from __future__ import annotations

import random
from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
import pytest
from conftest import Harness, RpcFailure
from PIL import Image, ImageChops, ImageStat

from chef_core.ops import load_builtin_ops

PT_TO_PX = 4  # render scale: 4 pixels per point
MM = 72.0 / 25.4
PAGE = (300, 400)  # points
SEAL_PT = 90.0  # 120 px at 96 dpi
SEAL_H_PT = 45.0


@pytest.fixture(autouse=True)
def _builtins() -> None:
    load_builtin_ops()


def _gradient_seal(path: Path, size: tuple[int, int]) -> Path:
    """Every column has its own colour, so a wrong slice is easy to spot."""
    w, h = size
    img = Image.new("RGB", size)
    for x in range(w):
        for y in range(h):
            img.putpixel((x, y), (x * 255 // max(w - 1, 1), 255 - y * 255 // max(h - 1, 1), 90))
    img.save(path)
    return path


def _blank(path: Path, count: int, size: tuple[int, int] = PAGE) -> Path:
    pdf = pikepdf.new()
    for _ in range(count):
        pdf.add_blank_page(page_size=size)
    pdf.save(path)
    return path


def _open(h: Harness, path: Path) -> str:
    return str(h.open(path)["state"]["sessionId"])


def _rev(h: Harness, sid: str) -> Path:
    return Path(h.call("session.state", {"sessionId": sid})["revisionPath"])


def _render_all(path: Path) -> list[Image.Image]:
    doc = pdfium.PdfDocument(str(path))
    try:
        return [doc[i].render(scale=PT_TO_PX).to_pil().convert("RGB") for i in range(len(doc))]
    finally:
        doc.close()


def _strips(result: dict[str, Any]) -> list[dict[str, Any]]:
    return list(result["data"]["strips"])


def _mean_abs_diff(a: Image.Image, b: Image.Image) -> float:
    assert a.size == b.size, (a.size, b.size)
    return sum(ImageStat.Stat(ImageChops.difference(a, b)).mean) / 3


def _lowest(img: Image.Image) -> int:
    """Darkest channel value in the image (255 means only white paper)."""
    return min(lo for lo, _ in img.getextrema())


def _expected_strip(seal: Image.Image, x0: int, x1: int, w_px: int, h_px: int) -> Image.Image:
    return seal.crop((x0, 0, x1, seal.height)).resize((w_px, h_px), Image.Resampling.LANCZOS)


def _right_strip(
    page: Image.Image, width_pt: float, height_pt: float, top_pt: float
) -> Image.Image:
    right = page.width
    return page.crop(
        (
            right - round(width_pt * PT_TO_PX),
            round(top_pt * PT_TO_PX),
            right,
            round((top_pt + height_pt) * PT_TO_PX),
        )
    )


def test_right_strips_recompose_the_seal_across_pages(harness: Harness, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 4)
    seal_path = _gradient_seal(tmp_path / "seal.png", (120, 60))
    sid = _open(harness, src)
    # Natural size: 120 px at 96 dpi = 90 pt wide, 45 pt high, centred vertically.
    result = harness.op("stamp.seam", {"path": str(seal_path)}, sid)
    assert result["changedPages"] == [0, 1, 2, 3]
    assert [s["strip"] for s in _strips(result)] == [1, 2, 3, 4]
    assert all(s["of"] == 4 for s in _strips(result))

    seal = Image.open(seal_path)
    strip_pt = SEAL_PT / 4
    top = (PAGE[1] - SEAL_H_PT) / 2
    pieces = [_right_strip(p, strip_pt, SEAL_H_PT, top) for p in _render_all(_rev(harness, sid))]
    composed = Image.new("RGB", (sum(p.width for p in pieces), pieces[0].height))
    x = 0
    for piece in pieces:
        composed.paste(piece, (x, 0))
        x += piece.width
    expected = _expected_strip(seal, 0, 120, composed.width, composed.height)
    assert _mean_abs_diff(composed, expected) < 25


def test_strips_sit_on_the_edge_and_nothing_else_is_drawn(harness: Harness, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 2)
    seal_path = _gradient_seal(tmp_path / "seal.png", (120, 60))
    sid = _open(harness, src)
    harness.op("stamp.seam", {"path": str(seal_path)}, sid)
    page = _render_all(_rev(harness, sid))[0]
    assert _lowest(page.crop((0, 0, page.width // 2, page.height))) == 255
    assert _lowest(page.crop((page.width - 2, 0, page.width, page.height // 3))) == 255
    assert (
        _lowest(page.crop((page.width - 2, page.height // 2 - 2, page.width, page.height // 2 + 2)))
        < 200
    )


def test_odd_width_is_split_into_strips_that_cover_the_seal(
    harness: Harness, tmp_path: Path
) -> None:
    # 101 px across 3 strips: bounds 0, 34, 67, 101. Each strip must show its own columns.
    src = _blank(tmp_path / "in.pdf", 3)
    seal_path = _gradient_seal(tmp_path / "seal.png", (101, 60))
    sid = _open(harness, src)
    harness.op("stamp.seam", {"path": str(seal_path), "scaleWidthMm": 60}, sid)
    total_w = 60 * MM
    ppx = total_w / 101
    bounds = [round(k * 101 / 3) for k in range(4)]
    assert bounds == [0, 34, 67, 101]
    seal = Image.open(seal_path)
    height_pt = 60 * ppx
    top = (PAGE[1] - height_pt) / 2
    for k, page in enumerate(_render_all(_rev(harness, sid))):
        width_pt = (bounds[k + 1] - bounds[k]) * ppx
        strip = _right_strip(page, width_pt, height_pt, top)
        expected = _expected_strip(seal, bounds[k], bounds[k + 1], strip.width, strip.height)
        assert _mean_abs_diff(strip, expected) < 25, k


def test_sets_restart_the_sequence_every_group_size_pages(harness: Harness, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 30)
    seal_path = _gradient_seal(tmp_path / "seal.png", (120, 60))
    sid = _open(harness, src)
    result = harness.op("stamp.seam", {"path": str(seal_path), "groupSize": 10}, sid)
    strips = _strips(result)
    assert len(strips) == 30
    assert [s["strip"] for s in strips[:10]] == list(range(1, 11))
    assert [s["strip"] for s in strips[10:20]] == list(range(1, 11))
    assert all(s["of"] == 10 for s in strips)
    assert [s["page"] for s in strips] == list(range(30))


def test_cut_first_page_false_skips_the_first_page_of_each_set(
    harness: Harness, tmp_path: Path
) -> None:
    src = _blank(tmp_path / "in.pdf", 6)
    seal_path = _gradient_seal(tmp_path / "seal.png", (120, 60))
    sid = _open(harness, src)
    result = harness.op(
        "stamp.seam",
        {"path": str(seal_path), "groupSize": 3, "cutFirstPage": False},
        sid,
    )
    assert result["changedPages"] == [1, 2, 4, 5]
    assert all(s["of"] == 2 for s in _strips(result))


def test_single_page_document_gets_the_whole_seal(harness: Harness, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 1)
    seal_path = _gradient_seal(tmp_path / "seal.png", (120, 60))
    sid = _open(harness, src)
    result = harness.op("stamp.seam", {"path": str(seal_path)}, sid)
    assert _strips(result) == [{"page": 0, "strip": 1, "of": 1}]
    page = _render_all(_rev(harness, sid))[0]
    strip = _right_strip(page, SEAL_PT, SEAL_H_PT, (PAGE[1] - SEAL_H_PT) / 2)
    expected = _expected_strip(Image.open(seal_path), 0, 120, strip.width, strip.height)
    assert _mean_abs_diff(strip, expected) < 25


def test_left_side_strips_sit_on_the_left_edge(harness: Harness, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 2)
    seal_path = _gradient_seal(tmp_path / "seal.png", (120, 60))
    sid = _open(harness, src)
    harness.op("stamp.seam", {"path": str(seal_path), "side": "left"}, sid)
    page = _render_all(_rev(harness, sid))[0]
    assert _lowest(page.crop((page.width // 2, 0, page.width, page.height))) == 255
    assert _lowest(page.crop((0, page.height // 2 - 2, 2, page.height // 2 + 2))) < 200


def test_vertical_top_and_bottom(harness: Harness, tmp_path: Path) -> None:
    seal_path = _gradient_seal(tmp_path / "seal.png", (120, 60))
    src = _blank(tmp_path / "top.pdf", 1)
    sid = _open(harness, src)
    harness.op("stamp.seam", {"path": str(seal_path), "vertical": "top"}, sid)
    page = _render_all(_rev(harness, sid))[0]
    assert _lowest(page.crop((page.width - 4, 0, page.width, 20))) < 200
    assert _lowest(page.crop((page.width - 4, page.height - 20, page.width, page.height))) == 255

    src2 = _blank(tmp_path / "bottom.pdf", 1)
    sid2 = _open(harness, src2)
    harness.op("stamp.seam", {"path": str(seal_path), "vertical": "bottom"}, sid2)
    page2 = _render_all(_rev(harness, sid2))[0]
    assert (
        _lowest(page2.crop((page2.width - 4, page2.height - 20, page2.width, page2.height))) < 200
    )
    assert _lowest(page2.crop((page2.width - 4, 0, page2.width, 20))) == 255


def test_mm_offset_from_top(harness: Harness, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 1)
    seal_path = _gradient_seal(tmp_path / "seal.png", (120, 60))
    sid = _open(harness, src)
    harness.op("stamp.seam", {"path": str(seal_path), "vertical": 50.0}, sid)
    page = _render_all(_rev(harness, sid))[0]
    top_row = round(50 * MM * PT_TO_PX)
    assert _lowest(page.crop((page.width - 4, top_row + 5, page.width, top_row + 20))) < 200
    assert _lowest(page.crop((page.width - 4, 0, page.width, top_row - 5))) == 255


def test_overlap_extends_each_strip_into_its_neighbour(harness: Harness, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 2)
    seal_path = _gradient_seal(tmp_path / "seal.png", (120, 60))
    sid = _open(harness, src)
    harness.op("stamp.seam", {"path": str(seal_path), "overlapMm": 3}, sid)
    first, second = _render_all(_rev(harness, sid))
    row = round((PAGE[1] - SEAL_H_PT) / 2 * PT_TO_PX) + 5
    strip_px = round(SEAL_PT / 2 * PT_TO_PX)
    overlap_px = round(3 * MM * PT_TO_PX)
    # Page 2 shows the first half's last columns in its overlap band (the neighbour's ink).
    band = second.crop(
        (second.width - strip_px - overlap_px, row, second.width - strip_px, row + 1)
    )
    assert _lowest(band) < 200
    # Page 1 has no neighbour on its left, so its band is outside the seal and stays blank.
    assert (
        _lowest(
            first.crop((first.width - strip_px - overlap_px, row, first.width - strip_px, row + 1))
        )
        == 255
    )


def test_file_grows_by_about_one_image_not_one_per_page(harness: Harness, tmp_path: Path) -> None:
    rnd = random.Random(7)
    noise = Image.frombytes("RGB", (400, 200), rnd.randbytes(400 * 200 * 3))
    seal_path = tmp_path / "noise.png"
    noise.save(seal_path)
    raw_bytes = 400 * 200 * 3
    src = _blank(tmp_path / "in.pdf", 30)
    sid = _open(harness, src)
    before = src.stat().st_size
    harness.op("stamp.seam", {"path": str(seal_path), "groupSize": 10}, sid)
    grown = _rev(harness, sid).stat().st_size - before
    assert grown < raw_bytes * 2 + 200_000  # one embedded image, plus per-page references


def test_seam_is_one_group_and_can_be_undone(harness: Harness, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 3)
    seal_path = _gradient_seal(tmp_path / "seal.png", (120, 60))
    sid = _open(harness, src)
    harness.op("stamp.seam", {"path": str(seal_path)}, sid)
    overlays = harness.op("overlay.listOverlays", {}, sid)["data"]["overlays"]
    seam_rows = [o for o in overlays if o["label"] == "Dấu giáp lai"]
    assert len(seam_rows) == 1 and seam_rows[0]["pages"] == [0, 1, 2]
    harness.op("overlay.remove", {"group": seam_rows[0]["group"]}, sid)
    page = _render_all(_rev(harness, sid))[0]
    assert _lowest(page.crop((page.width - 4, 0, page.width, page.height))) == 255


def test_bad_parameters_are_rejected(harness: Harness, tmp_path: Path) -> None:
    src = _blank(tmp_path / "in.pdf", 2)
    seal_path = _gradient_seal(tmp_path / "seal.png", (120, 60))
    sid = _open(harness, src)
    with pytest.raises(RpcFailure) as exc:
        harness.op("stamp.seam", {"path": str(seal_path), "side": "top"}, sid)
    assert exc.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as exc:
        harness.op("stamp.seam", {"path": str(seal_path), "groupSize": 0}, sid)
    assert exc.value.kind == "INVALID_PARAMS"
