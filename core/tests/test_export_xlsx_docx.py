"""T10.04 (XLSX) and T10.05 (DOCX, two modes). The files are reopened with openpyxl and python-docx,
and their XML is checked for the structure that matters (spans, frames, anchors, styles, language).
No Word or LibreOffice was available, so the rendering is not checked."""

from __future__ import annotations

import datetime as dt
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any

import docx
from docx.oxml.ns import qn
from export_support import LINK, reference_dict, reference_model, reference_pdf
from openpyxl import load_workbook

from chef_core.export.assets import Assets
from chef_core.export.docx import write_docx
from chef_core.export.ir import build_ir
from chef_core.export.options import ExportOptions
from chef_core.export.xlsx import write_xlsx
from chef_core.layout.model import DocModel

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _model_without_tables() -> DocModel:
    data: dict[str, Any] = reference_dict()
    for page in data["pages"]:
        page["blocks"] = [b for b in page["blocks"] if b["kind"] != "table"]
    return DocModel.model_validate(data)


def _model_with_dates() -> DocModel:
    data: dict[str, Any] = reference_dict()
    table = next(b for b in data["pages"][0]["blocks"] if b["kind"] == "table")
    table["rows"].append(
        [
            {
                "rowSpan": 1,
                "colSpan": 1,
                "blocks": [
                    {
                        "kind": "paragraph",
                        "bbox": [0, 0, 1, 1],
                        "readingOrder": 0,
                        "runs": [{"text": "31/12/2026"}],
                    }
                ],
            },
            {
                "rowSpan": 1,
                "colSpan": 1,
                "blocks": [
                    {
                        "kind": "paragraph",
                        "bbox": [0, 0, 1, 1],
                        "readingOrder": 0,
                        "runs": [{"text": "1.234,5"}],
                    }
                ],
            },
            {
                "rowSpan": 1,
                "colSpan": 1,
                "blocks": [
                    {
                        "kind": "paragraph",
                        "bbox": [0, 0, 1, 1],
                        "readingOrder": 0,
                        "runs": [{"text": "=SUM(A1)"}],
                    }
                ],
            },
        ]
    )
    return DocModel.model_validate(data)


# -- XLSX --------------------------------------------------------------------------------------


def test_xlsx_one_sheet_per_table_with_merges_and_values(tmp_path: Path) -> None:
    out = tmp_path / "t.xlsx"
    ir = build_ir(reference_model(), None, ExportOptions())
    result = write_xlsx(ir, out, parse_numbers=True)
    wb = load_workbook(out)
    assert wb.sheetnames == ["Bảng 1 - trang 1"]
    ws = wb["Bảng 1 - trang 1"]
    assert "A1:A2" in [str(r) for r in ws.merged_cells.ranges]
    assert "B1:C1" in [str(r) for r in ws.merged_cells.ranges]
    assert ws["A3"].value == "Ann\nLee"
    assert ws["B3"].value == 10 and ws["C3"].value == 20.5
    assert ws["A1"].font.bold and ws["B2"].value == "Q1"
    assert result.stats["tables"] == 1


def test_xlsx_numbers_and_dates_follow_vietnamese_formats(tmp_path: Path) -> None:
    out = tmp_path / "d.xlsx"
    ir = build_ir(_model_with_dates(), None, ExportOptions())
    write_xlsx(ir, out, parse_numbers=True)
    ws = load_workbook(out)["Bảng 1 - trang 1"]
    last = ws.max_row
    assert ws.cell(row=last, column=1).value == dt.datetime(2026, 12, 31)
    assert ws.cell(row=last, column=1).number_format == "dd/mm/yyyy"
    assert ws.cell(row=last, column=2).value == 1234.5
    assert ws.cell(row=last, column=3).value == "=SUM(A1)"
    assert ws.cell(row=last, column=3).data_type == "s"


def test_xlsx_keeps_text_when_parsing_is_off(tmp_path: Path) -> None:
    out = tmp_path / "raw.xlsx"
    ir = build_ir(reference_model(), None, ExportOptions())
    write_xlsx(ir, out, parse_numbers=False)
    ws = load_workbook(out)["Bảng 1 - trang 1"]
    assert ws["B3"].value == "10"


def test_xlsx_text_sheet_when_there_are_no_tables(tmp_path: Path) -> None:
    out = tmp_path / "text.xlsx"
    ir = build_ir(_model_without_tables(), None, ExportOptions())
    write_xlsx(ir, out, parse_numbers=True)
    wb = load_workbook(out)
    assert wb.sheetnames == ["Toàn bộ"]
    values = [c.value for c in wb["Toàn bộ"]["A"] if c.value]
    assert "Chương 1: Tổng quan" in values
    assert "  a. Mục con a" in values


# -- DOCX: editable ----------------------------------------------------------------------------


def _docx(
    tmp_path: Path,
    name: str,
    mode: str = "editable",
    pdf: Path | None = None,
    model: DocModel | None = None,
    **opts: Any,
) -> docx.document.Document:
    assets = Assets(pdf) if pdf else None
    try:
        ir = build_ir(model or reference_model(), assets, ExportOptions(mode=mode, **opts))
        out = tmp_path / name
        write_docx(ir, out, ExportOptions(mode=mode, **opts))
    finally:
        if assets is not None:
            assets.close()
    return docx.Document(str(out))


def _xml_of(path: Path, part: str) -> ET.Element:
    with zipfile.ZipFile(path) as zf:
        return ET.fromstring(zf.read(part))


def test_docx_editable_headings_lists_and_tables(tmp_path: Path) -> None:
    doc = _docx(tmp_path, "e.docx")
    styles = [p.style.name for p in doc.paragraphs]
    assert styles.count("Heading 1") == 2
    assert styles.count("Heading 2") == 1
    assert "List Number" in styles and "List Bullet" in styles
    assert len(doc.tables) == 1
    table = doc.tables[0]
    assert table.rows[0].cells[0].text.strip() == "Tên"
    tbl = table._tbl
    assert tbl.findall(f".//{W}vMerge"), "a vertical merge for the row span"
    assert tbl.findall(f".//{W}gridSpan"), "a horizontal merge for the column span"
    assert tbl.find(f".//{W}trPr/{W}tblHeader") is not None, "the header row repeats"


def test_docx_editable_text_language_fonts_and_properties(tmp_path: Path) -> None:
    doc = _docx(tmp_path, "lang.docx")
    assert doc.core_properties.title == "Tài liệu mẫu"
    assert doc.core_properties.author == "Nguyễn Văn A"
    normal = doc.styles["Normal"].element
    lang = normal.find(f".//{W}lang")
    assert lang is not None and lang.get(qn("w:val")) == "vi-VN"
    fonts = normal.find(f".//{W}rFonts")
    assert fonts is not None and fonts.get(qn("w:eastAsia")) == "Arial"
    text = "\n".join(p.text for p in doc.paragraphs)
    assert "Chương 1: Tổng quan" in text and "đoạn đậm" in text
    assert "Ann" in doc.tables[0].rows[2].cells[0].text


def test_docx_editable_hyperlink_and_numbering_restart(tmp_path: Path) -> None:
    doc = _docx(tmp_path, "h.docx")
    rels = [r for r in doc.part.rels.values() if r.is_external]
    assert any(r.target_ref == LINK for r in rels)
    numbering = doc.part.numbering_part.element
    nums = numbering.findall(f"{W}num")
    assert len(nums) >= 2, "a new w:num is created for the ordered list"
    ordered = [p for p in doc.paragraphs if p.style.name == "List Number"]
    assert ordered
    num_ids = {p._p.pPr.numPr.numId.val for p in ordered}  # type: ignore[union-attr]
    assert len(num_ids) == 1


def test_docx_editable_furniture_goes_to_header_and_footer(tmp_path: Path) -> None:
    doc = _docx(tmp_path, "f.docx", include_headers_footers=True)
    section = doc.sections[0]
    assert "Báo cáo mẫu" in section.header.paragraphs[0].text
    footer_xml = ET.tostring(section.footer._element, encoding="unicode")
    assert "Chân trang" in section.footer.paragraphs[0].text
    assert "PAGE" in footer_xml


def test_docx_editable_without_furniture_has_no_header_text(tmp_path: Path) -> None:
    doc = _docx(tmp_path, "nf.docx")
    assert "Báo cáo mẫu" not in doc.sections[0].header.paragraphs[0].text


def test_docx_editable_page_breaks_on_request(tmp_path: Path) -> None:
    flowing = _docx(tmp_path, "flow.docx")
    broken = _docx(tmp_path, "pages.docx", page_breaks=True)
    count = lambda d: len(d.element.body.findall(f".//{W}br[@{W}type='page']"))  # noqa: E731
    assert count(flowing) == 0
    assert count(broken) == 1


def test_docx_editable_images_inline(tmp_path: Path) -> None:
    pdf = reference_pdf(tmp_path / "ref.pdf")
    doc = _docx(tmp_path, "img.docx", pdf=pdf)
    assert len(doc.inline_shapes) == 1


# -- DOCX: layout ------------------------------------------------------------------------------


def test_docx_layout_one_section_per_page_with_frames(tmp_path: Path) -> None:
    out = tmp_path / "l.docx"
    _docx(tmp_path, "l.docx", mode="layout")
    doc = docx.Document(str(out))
    assert len(doc.sections) == 2
    for section in doc.sections:
        assert abs(section.page_width.pt - 595.0) < 1.0
        assert abs(section.page_height.pt - 842.0) < 1.0
        assert section.left_margin.pt == 0
    frames = doc.element.body.findall(f".//{W}framePr")
    assert len(frames) >= 10, "every block is positioned in a frame"
    first = frames[0]
    assert first.get(qn("w:hAnchor")) == "page" and first.get(qn("w:vAnchor")) == "page"
    assert first.get(qn("w:x")) is not None and first.get(qn("w:y")) is not None


def test_docx_layout_table_is_floating_with_fixed_width(tmp_path: Path) -> None:
    out = tmp_path / "lt.docx"
    _docx(tmp_path, "lt.docx", mode="layout")
    doc = docx.Document(str(out))
    tbl = doc.tables[0]._tbl
    tblpr = tbl.find(f"{W}tblPr")
    assert tblpr is not None
    assert tblpr.find(f"{W}tblpPr") is not None
    assert tblpr.find(f"{W}tblLayout").get(qn("w:type")) == "fixed"
    assert tbl.findall(f".//{W}gridSpan") and tbl.findall(f".//{W}vMerge")


def test_docx_layout_pictures_are_anchored_to_the_page(tmp_path: Path) -> None:
    pdf = reference_pdf(tmp_path / "ref.pdf")
    out = tmp_path / "la.docx"
    ir = build_ir(reference_model(), Assets(pdf), ExportOptions(mode="layout"))
    write_docx(ir, out, ExportOptions(mode="layout"))
    root = _xml_of(out, "word/document.xml")
    anchors = root.findall(
        ".//{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}anchor"
    )
    assert len(anchors) == 1
    pos = anchors[0].find(
        "{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}positionH"
    )
    assert pos is not None and pos.get("relativeFrom") == "page"


def test_docx_parts_are_well_formed(tmp_path: Path) -> None:
    for mode in ("editable", "layout"):
        out = tmp_path / f"parts-{mode}.docx"
        ir = build_ir(reference_model(), None, ExportOptions(mode=mode))
        write_docx(ir, out, ExportOptions(mode=mode))
        with zipfile.ZipFile(out) as zf:
            names = zf.namelist()
            for required in (
                "[Content_Types].xml",
                "_rels/.rels",
                "word/document.xml",
                "word/styles.xml",
            ):
                assert required in names
            for name in names:
                if name.endswith((".xml", ".rels")):
                    ET.fromstring(zf.read(name))
            assert zf.testzip() is None


def test_docx_outputs_are_utf8_vietnamese_text(tmp_path: Path) -> None:
    out = tmp_path / "vn.docx"
    ir = build_ir(reference_model(), None, ExportOptions())
    write_docx(ir, out, ExportOptions())
    with zipfile.ZipFile(out) as zf:
        body = zf.read("word/document.xml").decode("utf-8")
    assert "Chương 2: Kết luận" in body
