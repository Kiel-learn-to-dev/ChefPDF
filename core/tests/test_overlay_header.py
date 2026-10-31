"""T4.07 ops: overlay.headerFooter (F7), overlay.pageNumbers (F8, nd30 preset, page labels).

Text placement is checked with PDFium: the text inside a region of the rendered page.
Regions are in points, origin bottom-left. Pages are 300 x 400 points.
"""

from __future__ import annotations

from pathlib import Path

import pikepdf
import pypdfium2 as pdfium
import pytest
from conftest import Harness, RpcFailure

W, H = 300.0, 400.0
TOP_BAND = (0.0, H - 60, W, H)  # bottom, top of the page strip used for header checks
BOTTOM_BAND = (0.0, 0.0, W, 60.0)


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


def _region(path: Path, index: int, box: tuple[float, float, float, float]) -> str:
    doc = pdfium.PdfDocument(str(path))
    try:
        left, bottom, right, top = box
        return str(doc[index].get_textpage().get_text_bounded(left, bottom, right, top)).strip()
    finally:
        doc.close()


def _content(path: Path) -> bytes:
    with pikepdf.open(path) as pdf:
        contents = pdf.pages[0].obj.Contents
        streams = list(contents) if isinstance(contents, pikepdf.Array) else [contents]
        return b"\n".join(bytes(s.read_bytes()) for s in streams)


def _left_half(band: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    left, bottom, right, top = band
    return (left, bottom, right / 3, top)


def _center_third(band: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    _left, bottom, right, top = band
    return (right / 3, bottom, 2 * right / 3, top)


def _right_third(band: tuple[float, float, float, float]) -> tuple[float, float, float, float]:
    _left, bottom, right, top = band
    return (right / 2, bottom, right, top)


# -- overlay.headerFooter -----------------------------------------------------------------


def test_header_zones_draw_their_templates_on_every_page(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "hf.pdf", 3))
    result = harness.op(
        "overlay.headerFooter",
        {
            "header": {"left": "Hồ sơ {filename}", "center": "", "right": "Trang {page}/{pages}"},
            "footer": {"center": "Lưu hành nội bộ"},
            "margins": {"top": 10, "bottom": 10, "left": 15, "right": 15},
        },
        sid,
    )
    assert result["changedPages"] == [0, 1, 2]
    rev = _rev(harness, sid)
    left_header = _region(rev, 1, _left_half(TOP_BAND))
    right_header = _region(rev, 1, _right_third(TOP_BAND))
    assert "Hồ sơ" in left_header and "hf" in left_header
    assert right_header == "Trang 2/3"
    assert _region(rev, 2, _center_third(BOTTOM_BAND)) == "Lưu hành nội bộ"
    listed = harness.op("overlay.listOverlays", {}, sid)["data"]["overlays"]
    kinds = sorted(o["kind"] for o in listed)
    assert kinds == ["footer", "header"]
    assert listed[0]["group"] == listed[1]["group"]


def test_header_and_footer_tags_use_the_pagination_artifact(
    harness: Harness, tmp_path: Path
) -> None:
    sid = _open(harness, _blank(tmp_path / "tag.pdf", 1))
    harness.op("overlay.headerFooter", {"header": {"left": "A"}}, sid)
    raw = _content(_rev(harness, sid))
    assert b"/Pagination" in raw and b"/Header" in raw and b"/Kind (header)" in raw


def test_skip_first_leaves_the_first_page_alone(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "skip.pdf", 3))
    result = harness.op(
        "overlay.headerFooter", {"footer": {"center": "{page}"}, "skipFirst": True}, sid
    )
    assert result["changedPages"] == [1, 2]
    rev = _rev(harness, sid)
    assert _region(rev, 0, _center_third(BOTTOM_BAND)) == ""
    assert _region(rev, 1, _center_third(BOTTOM_BAND)) == "2"


def test_start_number_offsets_the_page_variables(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "start.pdf", 2))
    harness.op(
        "overlay.headerFooter",
        {"footer": {"right": "{page} / {pages}"}, "startNumber": 10},
        sid,
    )
    rev = _rev(harness, sid)
    assert _region(rev, 0, _right_third(BOTTOM_BAND)) == "10 / 11"
    assert _region(rev, 1, _right_third(BOTTOM_BAND)) == "11 / 11"


def test_mirror_odd_even_swaps_left_and_right_on_even_pages(
    harness: Harness, tmp_path: Path
) -> None:
    sid = _open(harness, _blank(tmp_path / "mirror.pdf", 2))
    harness.op(
        "overlay.headerFooter",
        {"header": {"left": "TRAI", "right": "PHAI"}, "mirrorOddEven": True},
        sid,
    )
    rev = _rev(harness, sid)
    assert _region(rev, 0, _left_half(TOP_BAND)) == "TRAI"
    assert _region(rev, 0, _right_third(TOP_BAND)) == "PHAI"
    assert _region(rev, 1, _left_half(TOP_BAND)) == "PHAI"
    assert _region(rev, 1, _right_third(TOP_BAND)) == "TRAI"


def test_sections_supply_the_section_variable(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "sec.pdf", 3))
    harness.op(
        "overlay.headerFooter",
        {
            "header": {"left": "{section}"},
            "sections": [{"page": 0, "title": "Phần I"}, {"page": 2, "title": "Phần II"}],
        },
        sid,
    )
    rev = _rev(harness, sid)
    assert _region(rev, 1, _left_half(TOP_BAND)) == "Phần I"
    assert _region(rev, 2, _left_half(TOP_BAND)) == "Phần II"


def test_header_date_uses_the_date_format(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "date.pdf", 1))
    harness.op(
        "overlay.headerFooter",
        {"footer": {"left": "Ngày {date}"}, "dateFormat": "yyyy"},
        sid,
    )
    text = _region(_rev(harness, sid), 0, _left_half(BOTTOM_BAND))
    assert text.startswith("Ngày 20")
    assert "/" not in text


def test_escaped_braces_are_printed_literally(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "esc.pdf", 1))
    harness.op("overlay.headerFooter", {"footer": {"center": "{{page}} = {page}"}}, sid)
    assert _region(_rev(harness, sid), 0, _center_third(BOTTOM_BAND)) == "{page} = 1"


def test_unknown_variable_is_invalid_params_naming_it(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "bad.pdf", 1))
    with pytest.raises(RpcFailure) as exc:
        harness.op("overlay.headerFooter", {"header": {"left": "{ngay2}"}}, sid)
    assert exc.value.code == -32602
    assert exc.value.detail["variable"] == "ngay2"


def test_header_or_footer_is_required(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "none.pdf", 1))
    with pytest.raises(RpcFailure) as exc:
        harness.op("overlay.headerFooter", {}, sid)
    assert exc.value.code == -32602


# -- overlay.pageNumbers ------------------------------------------------------------------


def test_page_numbers_roman_template_at_bottom_right(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "pn.pdf", 4))
    result = harness.op(
        "overlay.pageNumbers",
        {"numberFormat": "roman", "template": "Trang {page}/{pages}", "position": "bottom-right"},
        sid,
    )
    assert result["changedPages"] == [0, 1, 2, 3]
    rev = _rev(harness, sid)
    assert _region(rev, 2, _right_third(BOTTOM_BAND)) == "Trang iii/iv"
    listed = harness.op("overlay.listOverlays", {}, sid)["data"]["overlays"]
    assert listed[0]["kind"] == "number"


def test_outside_alternating_puts_odd_pages_right_and_even_pages_left(
    harness: Harness, tmp_path: Path
) -> None:
    sid = _open(harness, _blank(tmp_path / "outside.pdf", 2))
    harness.op("overlay.pageNumbers", {"position": "outside-alternating"}, sid)
    rev = _rev(harness, sid)
    assert _region(rev, 0, _right_third(BOTTOM_BAND)) == "1"
    assert _region(rev, 1, _left_half(BOTTOM_BAND)) == "2"


def test_skip_pages_and_skip_first_are_not_numbered(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "skipp.pdf", 4))
    result = harness.op(
        "overlay.pageNumbers",
        {"skipFirst": True, "skipPages": [2]},
        sid,
    )
    assert result["changedPages"] == [1, 3]
    rev = _rev(harness, sid)
    assert _region(rev, 3, _center_third(BOTTOM_BAND)) == "4"


def test_nd30_preset_numbers_from_page_two_at_top_centre(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "nd30.pdf", 3))
    result = harness.op("overlay.pageNumbers", {"preset": "nd30"}, sid)
    assert result["changedPages"] == [1, 2]
    rev = _rev(harness, sid)
    assert _region(rev, 0, TOP_BAND) == ""
    assert _region(rev, 1, _center_third(TOP_BAND)) == "2"
    assert _region(rev, 2, _center_third(TOP_BAND)) == "3"
    assert _region(rev, 1, BOTTOM_BAND) == ""


def test_nd30_top_margin_is_ten_millimetres(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "nd30m.pdf", 2))
    harness.op("overlay.pageNumbers", {"preset": "nd30"}, sid)
    rev = _rev(harness, sid)
    ten_mm = 10 * 72 / 25.4
    # The number hangs just below the 10 mm line, so nothing lies within the top 8 points.
    assert _region(rev, 1, (0, H - ten_mm - 20, W, H)) == "2"
    assert _region(rev, 1, (0, H - 8, W, H)) == ""


def test_write_labels_sets_page_labels_for_the_number_format(
    harness: Harness, tmp_path: Path
) -> None:
    sid = _open(harness, _blank(tmp_path / "labels.pdf", 3))
    harness.op(
        "overlay.pageNumbers",
        {"numberFormat": "ROMAN", "startNumber": 2, "writeLabels": True},
        sid,
    )
    with pikepdf.open(_rev(harness, sid)) as pdf:
        nums = pdf.Root.PageLabels.Nums
        assert len(nums) == 2 and int(nums[0]) == 0
        assert str(nums[1].S) == "/R" and int(nums[1].St) == 2


def test_write_labels_needs_a_start_number_of_at_least_one(
    harness: Harness, tmp_path: Path
) -> None:
    sid = _open(harness, _blank(tmp_path / "labels0.pdf", 2))
    with pytest.raises(RpcFailure) as exc:
        harness.op("overlay.pageNumbers", {"startNumber": 0, "writeLabels": True}, sid)
    assert exc.value.code == -32602


def test_page_numbers_pages_selection(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "sel.pdf", 4))
    result = harness.op("overlay.pageNumbers", {"pageRange": "odd"}, sid)
    assert result["changedPages"] == [0, 2]
