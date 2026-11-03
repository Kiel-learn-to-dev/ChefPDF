"""Defect 2 of the core review: doc.repair on damaged files, including embedded TrueType fonts.

The document is four pages drawn with Be Vietnam Pro (embedded by reportlab). Its layout puts the
font program before the content streams, the Catalog and the Pages tree, so a cut in the middle
of the file loses the page content first. A page is recovered when its own objects (the page
dictionary and its content stream) are in the surviving bytes, and then it must render its text.
"""

from __future__ import annotations

import re
from pathlib import Path

import pikepdf
import pytest
from conftest import Harness, RpcFailure
from content_support import ink_bbox, is_dark
from pdf_media import page_text, render
from text_support import canvas_pdf, put

PAGES = 4


def _vn4(path: Path) -> Path:
    def draw(cv, i: int) -> None:  # type: ignore[no-untyped-def]
        put(cv, 60, 700, f"Trang {i + 1} tiếng Việt ắằẳẵặ", 14)
        put(cv, 60, 650, "Dòng chữ thử nghiệm để nhúng font.", 11)

    return canvas_pdf(path, draw, pages=PAGES)


def _complete_pages(data: bytes, cut: int) -> int:
    """Pages whose content stream data is whole before ``cut`` (the page dictionaries come first).

    A stream whose ``endstream`` survives is complete even when its ``endobj`` was cut off."""
    count = 0
    for match in re.finditer(rb"/Contents (\d+) 0 R", data):
        num = match.group(1)
        header = re.search(rb"(?<![0-9])" + num + rb" 0 obj", data)
        if header is None:
            continue
        end = data.find(b"endstream", header.end())
        if end >= 0 and end + len(b"endstream") <= cut:
            count += 1
    return count


def _repair(harness: Harness, src: Path, out: Path) -> dict:
    result: dict = harness.op("doc.repair", {"inputPath": str(src), "outputPath": str(out)})
    return result["data"]


def _assert_pages_draw(out: Path, count: int) -> None:
    for index in range(count):
        assert ink_bbox(render(out, index), is_dark) is not None, f"page {index} is blank"
        assert f"Trang {index + 1}" in page_text(out, index), f"page {index} lost its text"


def test_stream_cut_before_its_endobj_keeps_the_page_content(
    harness: Harness, tmp_path: Path
) -> None:
    """qpdf drops a stream that lacks its endobj; the page must not silently turn blank."""
    src = _vn4(tmp_path / "vn4.pdf")
    data = src.read_bytes()
    last = data.rfind(b"endstream")
    cut = last + len(b"endstream") + 1  # the newline after endstream, no endobj
    damaged = tmp_path / "no-endobj.pdf"
    damaged.write_bytes(data[:cut])
    assert _complete_pages(data, cut) == PAGES
    out = tmp_path / "fixed.pdf"
    result = _repair(harness, damaged, out)
    assert result["pageCount"] == PAGES
    assert not result["lostPages"]
    _assert_pages_draw(out, PAGES)


@pytest.mark.parametrize("cut", [17200, 17500, 18000])
def test_truncated_file_keeps_every_complete_page(
    harness: Harness, tmp_path: Path, cut: int
) -> None:
    src = _vn4(tmp_path / "vn4.pdf")
    data = src.read_bytes()
    damaged = tmp_path / f"cut{cut}.pdf"
    damaged.write_bytes(data[:cut])
    expected = _complete_pages(data, cut)
    assert 0 < expected <= PAGES
    out = tmp_path / f"fixed{cut}.pdf"
    result = _repair(harness, damaged, out)
    assert result["pageCount"] == expected
    assert result["recovered"] is True
    assert len(result["lostPages"]) == PAGES - expected
    assert all("content" in item["reason"] for item in result["lostPages"])
    _assert_pages_draw(out, expected)


def test_cut_inside_the_font_program_has_no_complete_page(harness: Harness, tmp_path: Path) -> None:
    """At two thirds the cut is inside the font program: every page content is lost, so nothing
    can be drawn and the file is not repairable (the Helvetica file is, because its content
    streams come before the cut)."""
    data = _vn4(tmp_path / "vn4.pdf").read_bytes()
    damaged = tmp_path / "cut67.pdf"
    damaged.write_bytes(data[: int(len(data) * 0.67)])
    assert _complete_pages(data, int(len(data) * 0.67)) == 0
    with pytest.raises(RpcFailure) as exc:
        _repair(harness, damaged, tmp_path / "never.pdf")
    assert exc.value.kind == "INVALID_PDF"
    assert not (tmp_path / "never.pdf").exists()


def test_missing_xref_and_trailer_recovers_all_pages(harness: Harness, tmp_path: Path) -> None:
    data = _vn4(tmp_path / "vn4.pdf").read_bytes()
    damaged = tmp_path / "noxref.pdf"
    damaged.write_bytes(data[: data.rindex(b"xref")])
    out = tmp_path / "noxref_fixed.pdf"
    result = _repair(harness, damaged, out)
    assert result["pageCount"] == PAGES
    _assert_pages_draw(out, PAGES)


def test_broken_stream_lengths_recover_every_page(harness: Harness, tmp_path: Path) -> None:
    data = _vn4(tmp_path / "vn4.pdf").read_bytes()
    damaged = tmp_path / "badlen.pdf"
    damaged.write_bytes(re.sub(rb"/Length (\d+) >> stream", b"/Length 7 >> stream", data))
    out = tmp_path / "badlen_fixed.pdf"
    result = _repair(harness, damaged, out)
    assert result["pageCount"] == PAGES
    _assert_pages_draw(out, PAGES)


def test_missing_endobj_recovers_every_page(harness: Harness, tmp_path: Path) -> None:
    data = _vn4(tmp_path / "vn4.pdf").read_bytes()
    cut = data.index(b"14 0 obj")
    damaged = tmp_path / "noendobj.pdf"
    damaged.write_bytes(data[:cut] + data[cut:].replace(b"endobj", b""))
    out = tmp_path / "noendobj_fixed.pdf"
    result = _repair(harness, damaged, out)
    assert result["pageCount"] == PAGES
    _assert_pages_draw(out, PAGES)


def test_damaged_object_stream_keeps_the_pages_before_the_damage(
    harness: Harness, tmp_path: Path
) -> None:
    """The page dictionaries live in an object stream. Corrupting its compressed tail leaves the
    members before the damage readable: those pages are recovered and draw their text."""
    base = _vn4(tmp_path / "vn4.pdf")
    with pikepdf.open(base) as pdf:
        objstm = tmp_path / "vn4_objstm.pdf"
        pdf.save(objstm, object_stream_mode=pikepdf.ObjectStreamMode.generate)
    raw = bytearray(objstm.read_bytes())
    start = raw.index(b"/Type /ObjStm")
    body = raw.index(b"stream", start) + len(b"stream") + 2
    end = raw.index(b"endstream", body)
    tail = body + (end - body) * 3 // 4
    for k in range(tail, tail + 60):
        raw[k] ^= 0xFF
    damaged = tmp_path / "objstm_damaged.pdf"
    damaged.write_bytes(bytes(raw))
    out = tmp_path / "objstm_fixed.pdf"
    result = _repair(harness, damaged, out)
    # member 10 (the font dictionary) is inside the damage: its pages keep their content and
    # draw with the standard font instead
    assert result["pageCount"] == PAGES
    assert result["salvaged"] is True
    assert any("replaced by Helvetica" in w for w in result["warnings"])
    _assert_pages_draw(out, PAGES)


def test_missing_font_program_is_replaced_by_a_standard_font(
    harness: Harness, tmp_path: Path
) -> None:
    data = _vn4(tmp_path / "vn4.pdf").read_bytes()
    damaged = tmp_path / "nofont.pdf"
    # the font program (object 8) is renamed: the descriptor points at a missing object
    damaged.write_bytes(data.replace(b"\n8 0 obj", b"\n8 0 xyz", 1))
    out = tmp_path / "nofont_fixed.pdf"
    result = _repair(harness, damaged, out)
    assert result["pageCount"] == PAGES
    assert any("replaced by Helvetica" in w for w in result["warnings"])
    _assert_pages_draw(out, PAGES)


def test_truncated_before_any_page_is_still_invalid(harness: Harness, tmp_path: Path) -> None:
    data = _vn4(tmp_path / "vn4.pdf").read_bytes()
    damaged = tmp_path / "tiny.pdf"
    damaged.write_bytes(data[:300])
    with pytest.raises(RpcFailure) as exc:
        _repair(harness, damaged, tmp_path / "tiny_fixed.pdf")
    assert exc.value.kind == "INVALID_PDF"
