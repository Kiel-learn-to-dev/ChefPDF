"""T7.06 / T7.07 (G1-G5): markup, notes, free text, ink, shapes, review, export, flatten.

Every appearance is checked with PDFium, the renderer the viewer uses: the annotations must show
(pixels where expected), a highlight must not hide the text under it (multiply), and flattening
must keep the pixels while removing the annotations.
"""

from __future__ import annotations

import csv
import ctypes
import json
from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
import pypdfium2.raw as raw
import pytest
from conftest import Harness, RpcFailure
from content_support import vietnamese_pdf
from text_support import canvas_pdf, put

from chef_core.content.verify import render_rgb


def _sid(harness: Harness, path: Path) -> str:
    return str(harness.open(path)["state"]["sessionId"])


def _revision(harness: Harness, sid: str) -> Path:
    return Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])


def _annots(harness: Harness, sid: str, **kw: Any) -> list[dict[str, Any]]:
    return harness.op("annots.list", {"pageIndex": 0, **kw}, sid)["data"]["annots"]


def _pdfium_subtypes(path: Path, index: int = 0) -> list[int]:
    doc = pdfium.PdfDocument(str(path))
    try:
        page = doc[index]
        out = []
        for i in range(raw.FPDFPage_GetAnnotCount(page.raw)):
            annot = raw.FPDFPage_GetAnnot(page.raw, i)
            out.append(int(raw.FPDFAnnot_GetSubtype(annot)))
            raw.FPDFPage_CloseAnnot(annot)
        page.close()
        return out
    finally:
        doc.close()


def _pdfium_contents(path: Path, index: int = 0) -> list[str]:
    """/Contents of every annotation, decoded the way PDFium reads it (UTF-16 with BOM)."""
    doc = pdfium.PdfDocument(str(path))
    try:
        page = doc[index]
        out = []
        for i in range(raw.FPDFPage_GetAnnotCount(page.raw)):
            annot = raw.FPDFPage_GetAnnot(page.raw, i)
            size = raw.FPDFAnnot_GetStringValue(annot, b"Contents", None, 0)
            buf = (ctypes.c_ushort * max(size // 2, 1))()
            raw.FPDFAnnot_GetStringValue(annot, b"Contents", buf, size)
            out.append(bytes(buf)[: max(size - 2, 0)].decode("utf-16-le", errors="replace"))
            raw.FPDFPage_CloseAnnot(annot)
        page.close()
        return out
    finally:
        doc.close()


def _pixels(path: Path, scale: float = 1.0) -> Any:
    return render_rgb(path, 0, dpi=int(72 * scale))


def _rgb_list(img: Any) -> list[tuple[int, int, int]]:
    data = img.convert("RGB").tobytes()
    return [(data[i], data[i + 1], data[i + 2]) for i in range(0, len(data), 3)]


def _find_rect(harness: Harness, sid: str, text: str) -> list[float]:
    lines = harness.op("text.getLines", {"pageIndex": 0}, sid)["data"]["lines"]
    (line,) = [ln for ln in lines if text in ln["text"]]
    return line["bbox"]


def test_highlight_by_find_is_listed_and_renders_without_hiding_text(
    harness: Harness, tmp_path: Path
) -> None:
    src = vietnamese_pdf(tmp_path / "vi.pdf")
    sid = _sid(harness, src)
    result = harness.op(
        "annots.addTextMarkup",
        {
            "pageIndex": 0,
            "kind": "highlight",
            "find": "Hà Nội",
            "color": "#ffff00",
            "author": "Minh",
            "contents": "Địa danh",
        },
        sid,
    )["data"]
    assert result["count"] == 1
    (annot,) = _annots(harness, sid)
    assert annot["subtype"] == "Highlight"
    assert annot["author"] == "Minh"
    assert annot["contents"] == "Địa danh"
    assert annot["appearance"] is True
    assert annot["quads"] and len(annot["quads"][0]) == 8
    out = _revision(harness, sid)
    assert raw.FPDF_ANNOT_HIGHLIGHT in _pdfium_subtypes(out)
    x0, top, x1, bottom = annot["rect"]
    img = _pixels(out, scale=1.0)
    box = img.crop((int(x0) + 1, int(top) + 1, int(x1) - 1, int(bottom) - 1)).convert("RGB")
    pixels = _rgb_list(box)
    yellow = [p for p in pixels if p[0] > 200 and p[1] > 200 and p[2] < 120]
    dark = [p for p in pixels if max(p) < 90]
    assert len(yellow) > len(pixels) * 0.2, "the highlight shows"
    assert dark, "the text under the highlight is still dark (multiply)"


def test_underline_strike_and_squiggly_are_real_annotations(
    harness: Harness, tmp_path: Path
) -> None:
    src = vietnamese_pdf(tmp_path / "vi.pdf")
    sid = _sid(harness, src)
    rect = _find_rect(harness, sid, "Chef PDF")
    for kind in ("underline", "strike", "squiggly"):
        harness.op(
            "annots.addTextMarkup",
            {"pageIndex": 0, "kind": kind, "rects": [rect]},
            sid,
        )
    subtypes = sorted(a["subtype"] for a in _annots(harness, sid))
    assert subtypes == ["Squiggly", "StrikeOut", "Underline"]
    pdfium_types = _pdfium_subtypes(_revision(harness, sid))
    assert raw.FPDF_ANNOT_UNDERLINE in pdfium_types
    assert raw.FPDF_ANNOT_STRIKEOUT in pdfium_types
    assert raw.FPDF_ANNOT_SQUIGGLY in pdfium_types


def test_sticky_note_with_vietnamese_contents_round_trips(harness: Harness, tmp_path: Path) -> None:
    src = vietnamese_pdf(tmp_path / "vi.pdf")
    sid = _sid(harness, src)
    note = harness.op(
        "annots.addNote",
        {
            "pageIndex": 0,
            "left": 300,
            "top": 100,
            "contents": "Kiểm tra lại số liệu ạ",
            "author": "Thắng",
        },
        sid,
    )["data"]
    assert note["id"].startswith("A0:")
    (annot,) = _annots(harness, sid)
    assert annot["subtype"] == "Text"
    assert annot["contents"] == "Kiểm tra lại số liệu ạ"
    assert annot["author"] == "Thắng"
    assert raw.FPDF_ANNOT_TEXT in _pdfium_subtypes(_revision(harness, sid))
    assert _pdfium_contents(_revision(harness, sid)) == ["Kiểm tra lại số liệu ạ"]


def test_free_text_box_uses_the_unicode_font_and_shows(harness: Harness, tmp_path: Path) -> None:
    src = canvas_pdf(tmp_path / "blank.pdf", lambda cv, i: put(cv, 72, 700, "x", 12))
    sid = _sid(harness, src)
    harness.op(
        "annots.addFreeText",
        {
            "pageIndex": 0,
            "rect": [100, 100, 360, 160],
            "text": "Ghi chú tiếng Việt: ạ ệ ơ",
            "fontSize": 14,
            "color": "#0000ff",
            "background": "#fff7d1",
            "borderWidth": 1,
        },
        sid,
    )
    (annot,) = _annots(harness, sid)
    assert annot["subtype"] == "FreeText"
    assert annot["contents"] == "Ghi chú tiếng Việt: ạ ệ ơ"
    out = _revision(harness, sid)
    img = _pixels(out)
    x0, top, x1, bottom = annot["rect"]
    crop = img.crop((int(x0) + 3, int(top) + 3, int(x1) - 3, int(bottom) - 3)).convert("RGB")
    blue = [p for p in _rgb_list(crop) if p[2] > 180 and p[0] < 120 and p[1] < 120]
    assert blue, "the text is drawn in the chosen colour"


def test_ink_strokes_render_in_colour(harness: Harness, tmp_path: Path) -> None:
    src = canvas_pdf(tmp_path / "blank.pdf", lambda cv, i: put(cv, 72, 700, "x", 12))
    sid = _sid(harness, src)
    harness.op(
        "annots.addInk",
        {
            "pageIndex": 0,
            "strokes": [[[100, 100], [200, 150], [300, 100]]],
            "color": "#ff0000",
            "width": 4,
        },
        sid,
    )
    (annot,) = _annots(harness, sid)
    assert annot["subtype"] == "Ink"
    assert raw.FPDF_ANNOT_INK in _pdfium_subtypes(_revision(harness, sid))
    img = _pixels(_revision(harness, sid))
    red = [p for p in _rgb_list(img) if p[0] > 200 and p[1] < 80 and p[2] < 80]
    assert len(red) > 100


def test_shapes_square_and_arrow(harness: Harness, tmp_path: Path) -> None:
    src = canvas_pdf(tmp_path / "blank.pdf", lambda cv, i: put(cv, 72, 700, "x", 12))
    sid = _sid(harness, src)
    harness.op(
        "annots.addShape",
        {
            "pageIndex": 0,
            "kind": "rect",
            "rect": [100, 100, 200, 160],
            "color": "#00aa00",
            "width": 3,
        },
        sid,
    )
    harness.op(
        "annots.addShape",
        {
            "pageIndex": 0,
            "kind": "arrow",
            "points": [300, 300, 400, 300],
            "color": "#0000ff",
            "width": 2,
        },
        sid,
    )
    subtypes = sorted(a["subtype"] for a in _annots(harness, sid))
    assert subtypes == ["Line", "Square"]
    arrow = next(a for a in _annots(harness, sid) if a["subtype"] == "Line")
    assert arrow["lineEnding"] == "OpenArrow"


def test_update_regenerates_the_appearance(harness: Harness, tmp_path: Path) -> None:
    src = vietnamese_pdf(tmp_path / "vi.pdf")
    sid = _sid(harness, src)
    rect = _find_rect(harness, sid, "Chef PDF")
    added = harness.op(
        "annots.addTextMarkup",
        {"pageIndex": 0, "kind": "highlight", "rects": [rect], "color": "#ffff00"},
        sid,
    )["data"]
    updated = harness.op(
        "annots.update",
        {"id": added["ids"][0], "color": "#00ff00", "contents": "Đã sửa", "opacity": 0.5},
        sid,
    )["data"]
    assert updated["id"] != added["ids"][0]
    (annot,) = _annots(harness, sid)
    assert annot["colour"] == "#00ff00"
    assert annot["contents"] == "Đã sửa"
    assert annot["opacity"] == pytest.approx(0.5, abs=0.01)
    img = _pixels(_revision(harness, sid)).convert("RGB")
    x0, top, x1, bottom = annot["rect"]
    crop = img.crop((int(x0) + 1, int(top) + 1, int(x1) - 1, int(bottom) - 1))
    assert any(p[1] > 200 and p[0] < 200 for p in _rgb_list(crop)), "green, not yellow"


def test_reply_threads_and_status_is_set(harness: Harness, tmp_path: Path) -> None:
    src = vietnamese_pdf(tmp_path / "vi.pdf")
    sid = _sid(harness, src)
    parent = harness.op(
        "annots.addNote",
        {"pageIndex": 0, "left": 300, "top": 100, "contents": "Gốc", "author": "A"},
        sid,
    )["data"]
    reply = harness.op(
        "annots.reply", {"id": parent["id"], "text": "Đã xử lý ạ", "author": "B"}, sid
    )["data"]
    harness.op("annots.setStatus", {"id": reply["id"], "status": "accepted"}, sid)
    annots = {a["id"]: a for a in _annots(harness, sid)}
    child = [a for a in annots.values() if a["contents"] == "Đã xử lý ạ"]
    assert len(child) == 1
    refreshed_parent = next(a for a in annots.values() if a["contents"] == "Gốc")
    assert child[0]["inReplyTo"] == refreshed_parent["id"]
    assert child[0]["status"] == "accepted"
    assert refreshed_parent["replies"] == [child[0]["id"]]
    with pikepdf.open(_revision(harness, sid)) as pdf:
        annotations = list(pdf.pages[0].obj.Annots)
        child_dict = [
            a for a in annotations if str(a.get("/Contents", "")) and a.get("/RT") == pikepdf.Name.R
        ]
        assert child_dict and child_dict[0].get("/StateModel") == pikepdf.Name("/Review")


def test_list_filters_by_author_and_kind(harness: Harness, tmp_path: Path) -> None:
    src = vietnamese_pdf(tmp_path / "vi.pdf")
    sid = _sid(harness, src)
    harness.op(
        "annots.addNote",
        {"pageIndex": 0, "left": 300, "top": 100, "contents": "a", "author": "Ann"},
        sid,
    )
    harness.op(
        "annots.addNote",
        {"pageIndex": 0, "left": 320, "top": 300, "contents": "b", "author": "Ben"},
        sid,
    )
    assert len(_annots(harness, sid, author="Ann")) == 1
    assert len(_annots(harness, sid, kinds=["Text"])) == 2
    assert _annots(harness, sid, kinds=["Highlight"]) == []


def test_remove_by_id_and_remove_all_by_kind(harness: Harness, tmp_path: Path) -> None:
    src = vietnamese_pdf(tmp_path / "vi.pdf")
    sid = _sid(harness, src)
    rect = _find_rect(harness, sid, "Chef PDF")
    harness.op("annots.addTextMarkup", {"pageIndex": 0, "kind": "highlight", "rects": [rect]}, sid)
    note = harness.op(
        "annots.addNote",
        {"pageIndex": 0, "left": 300, "top": 100, "contents": "n", "author": "A"},
        sid,
    )["data"]
    harness.op("annots.removeAll", {"pageIndex": 0, "kinds": ["Highlight"]}, sid)
    assert [a["subtype"] for a in _annots(harness, sid)] == ["Text"]
    # ids follow the page's annotations: the note has a new id after the removal above
    (current,) = _annots(harness, sid)
    harness.op("annots.remove", {"ids": [current["id"]]}, sid)
    assert _annots(harness, sid) == []
    assert note["id"].startswith("A0:")


def test_stale_annotation_id_is_refused(harness: Harness, tmp_path: Path) -> None:
    src = vietnamese_pdf(tmp_path / "vi.pdf")
    sid = _sid(harness, src)
    note = harness.op(
        "annots.addNote",
        {"pageIndex": 0, "left": 300, "top": 100, "contents": "n", "author": "A"},
        sid,
    )["data"]
    harness.op("annots.update", {"id": note["id"], "contents": "m"}, sid)
    with pytest.raises(RpcFailure) as exc:
        harness.op("annots.remove", {"ids": [note["id"]]}, sid)
    assert exc.value.error["message"] == "STALE_OBJECT_IDS"


def test_export_csv_xlsx_json_and_txt_carry_quotes_and_notes(
    harness: Harness, tmp_path: Path
) -> None:
    import openpyxl

    src = vietnamese_pdf(tmp_path / "vi.pdf")
    sid = _sid(harness, src)
    rect = _find_rect(harness, sid, "Hà Nội")
    harness.op(
        "annots.addTextMarkup",
        {
            "pageIndex": 0,
            "kind": "highlight",
            "rects": [rect],
            "contents": "Ý kiến",
            "author": "Minh",
        },
        sid,
    )
    harness.op(
        "annots.addNote",
        {"pageIndex": 0, "left": 300, "top": 100, "contents": "Ghi chú", "author": "Minh"},
        sid,
    )
    out_csv = tmp_path / "notes.csv"
    harness.op("annots.export", {"outputPath": str(out_csv), "format": "csv"}, sid)
    with out_csv.open(encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))
    assert len(rows) == 2
    highlight = next(r for r in rows if r["type"] == "Highlight")
    assert "Hà Nội" in highlight["quoted_text"]
    assert highlight["contents"] == "Ý kiến"
    out_xlsx = tmp_path / "notes.xlsx"
    harness.op("annots.export", {"outputPath": str(out_xlsx), "format": "xlsx"}, sid)
    sheet = openpyxl.load_workbook(out_xlsx).active
    assert sheet.max_row == 3
    out_json = tmp_path / "notes.json"
    harness.op("annots.export", {"outputPath": str(out_json), "format": "json"}, sid)
    assert len(json.loads(out_json.read_text(encoding="utf-8"))) == 2
    for fmt in ("txt", "md", "html"):
        target = tmp_path / f"notes.{fmt}"
        harness.op("annots.export", {"outputPath": str(target), "format": fmt}, sid)
        assert "Ghi chú" in target.read_text(encoding="utf-8")
    assert _annots(harness, sid)  # export does not change the document


def test_flatten_keeps_pixels_and_removes_the_annotations(harness: Harness, tmp_path: Path) -> None:
    src = vietnamese_pdf(tmp_path / "vi.pdf")
    sid = _sid(harness, src)
    rect = _find_rect(harness, sid, "Chef PDF")
    harness.op(
        "annots.addTextMarkup",
        {"pageIndex": 0, "kind": "highlight", "rects": [rect], "color": "#ffff00"},
        sid,
    )
    harness.op(
        "annots.addInk",
        {"pageIndex": 0, "strokes": [[[100, 500], [300, 560]]], "color": "#0000ff", "width": 3},
        sid,
    )
    before = _pixels(_revision(harness, sid)).convert("RGB")
    harness.op("annots.flatten", {"kinds": ["Highlight", "Ink"]}, sid)
    assert _annots(harness, sid) == []
    after = _pixels(_revision(harness, sid)).convert("RGB")
    from PIL import ImageChops

    diff = ImageChops.difference(before, after).convert("L")
    assert max(diff.getextrema()) <= 24, "flattened pixels match the annotated ones"


def test_flatten_keeps_links_by_default(harness: Harness, tmp_path: Path) -> None:
    src = vietnamese_pdf(tmp_path / "vi.pdf")
    sid = _sid(harness, src)
    rect = _find_rect(harness, sid, "Chef PDF")
    harness.op("annots.addTextMarkup", {"pageIndex": 0, "kind": "underline", "rects": [rect]}, sid)
    harness.op(
        "links.add",
        {"pageIndex": 0, "rect": [72, 100, 200, 120], "kind": "uri", "uri": "https://a.example"},
        sid,
    )
    harness.op("annots.flatten", {}, sid)
    subtypes = [a["subtype"] for a in _annots(harness, sid)]
    assert subtypes == []
    links = harness.op("links.list", {"pageIndex": 0}, sid)["data"]["links"]
    assert len(links) == 1


def test_signed_document_blocks_annotation_changes(
    harness: Harness, corpus: dict[str, Path]
) -> None:
    sid = _sid(harness, corpus["fake_signed.pdf"])
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "annots.addNote",
            {"pageIndex": 0, "left": 10, "top": 10, "contents": "x", "author": "A"},
            sid,
        )
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"


def test_annotation_op_rejects_unknown_kind(harness: Harness, tmp_path: Path) -> None:
    src = vietnamese_pdf(tmp_path / "vi.pdf")
    sid = _sid(harness, src)
    with pytest.raises(RpcFailure):
        harness.op(
            "annots.addTextMarkup",
            {"pageIndex": 0, "kind": "scribble", "rects": [[1, 1, 2, 2]]},
            sid,
        )
