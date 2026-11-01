"""T7.01: text model (characters -> lines -> paragraphs -> blocks) and font capability."""

from __future__ import annotations

from pathlib import Path

import pikepdf
from content_support import raw_pdf, vietnamese_pdf
from text_support import (
    cid_hex,
    cid_subset_pdf,
    helvetica_pdf,
    pdf_text,
    two_column_pdf,
    vi_page,
)

from chef_core.text.build import build_text_page
from chef_core.text.fontcap import FontCapability, check_font_supports
from chef_core.text.model import parse_line_id


def _lines(path: Path) -> list[str]:
    with pikepdf.open(path) as pdf:
        return [ln.text for ln in build_text_page(pdf, pdf.pages[0], 0).lines]


def test_vietnamese_lines_keep_their_text_and_sizes(tmp_path: Path) -> None:
    path = vietnamese_pdf(tmp_path / "vi.pdf")
    with pikepdf.open(path) as pdf:
        tp = build_text_page(pdf, pdf.pages[0], 0)
    assert [ln.text for ln in tp.lines] == [
        "Tiếng Việt có dấu: Hà Nội",
        "Chef PDF sửa nội dung trang",
    ]
    assert [round(ln.font_size) for ln in tp.lines] == [24, 14]
    assert all(ln.editable for ln in tp.lines)
    assert all(
        ln.font_name.endswith("BeVietnamPro") or "BeVietnam" in ln.font_name for ln in tp.lines
    )
    parsed = parse_line_id(tp.lines[0].id)
    assert parsed is not None and parsed[0] == 0 and parsed[1] == tp.digest


def test_two_columns_form_two_blocks_read_left_then_right(tmp_path: Path) -> None:
    path = two_column_pdf(tmp_path / "cols.pdf")
    with pikepdf.open(path) as pdf:
        tp = build_text_page(pdf, pdf.pages[0], 0)
    assert len(tp.blocks) == 2
    left, right = (
        [
            tp.by_id[i].text
            for i in [lid for p in tp.paragraphs if p.block_id == b.id for lid in p.line_ids]
        ]
        for b in tp.blocks
    )
    assert left[0] == "Điều 1. Phạm vi áp dụng"
    assert right[0] == "Điều 2. Thanh toán"
    left_block = [ln for ln in tp.lines if ln.block_id == tp.blocks[0].id]
    assert all(ln.bbox[2] <= 320 for ln in left_block), "the left column stays left of the gutter"


def test_paragraph_and_justified_alignment(tmp_path: Path) -> None:
    path = two_column_pdf(tmp_path / "cols.pdf")
    with pikepdf.open(path) as pdf:
        tp = build_text_page(pdf, pdf.pages[0], 0)
    body = [ln for ln in tp.lines if ln.text.startswith("Hợp đồng")]
    assert len(body) == 1
    rest = [
        ln
        for ln in tp.lines
        if ln.text.startswith("theo đúng") or ln.text.startswith("và có hiệu lực")
    ]
    para_ids = {ln.paragraph_id for ln in body + rest}
    assert len(para_ids) == 1, "the three lines of the justified paragraph form one paragraph"
    paragraph = next(p for p in tp.paragraphs if p.id in para_ids)
    assert paragraph.align == "justify"
    assert paragraph.role == "body"


def test_headings_are_larger_or_bold_and_body_is_body(tmp_path: Path) -> None:
    path = two_column_pdf(tmp_path / "cols.pdf")
    with pikepdf.open(path) as pdf:
        tp = build_text_page(pdf, pdf.pages[0], 0)
    heading = next(ln for ln in tp.lines if ln.text.startswith("Điều 1"))
    body = next(ln for ln in tp.lines if ln.text.startswith("Hợp đồng"))
    assert heading.font_size > body.font_size
    assert heading.bold and not body.bold
    assert heading.role == "heading"
    assert body.role == "body"


def test_bullet_lines_are_list_items(tmp_path: Path) -> None:
    path = two_column_pdf(tmp_path / "cols.pdf")
    with pikepdf.open(path) as pdf:
        tp = build_text_page(pdf, pdf.pages[0], 0)
    items = [ln for ln in tp.lines if ln.text.startswith("- ")]
    assert len(items) == 3
    assert all(ln.list_marker and ln.role == "list" for ln in items)


def test_spaces_are_inferred_from_gaps(tmp_path: Path) -> None:
    # two runs one em apart with no space character between them (a gutter would split them)
    content = b"BT /F1 12 Tf 72 700 Td (Hello) Tj 42 0 Td (World) Tj ET"
    path = raw_pdf(tmp_path / "gap.pdf", content)
    with pikepdf.open(path) as pdf:
        tp = build_text_page(pdf, pdf.pages[0], 0)
    assert [ln.text for ln in tp.lines] == ["Hello World"]


def test_rotated_text_is_not_part_of_the_model(tmp_path: Path) -> None:
    content = b"BT /F1 12 Tf 0 1 -1 0 300 300 Tm (Quay) Tj ET BT /F1 12 Tf 72 700 Td (Thang) Tj ET"
    path = raw_pdf(tmp_path / "rot.pdf", content)
    with pikepdf.open(path) as pdf:
        tp = build_text_page(pdf, pdf.pages[0], 0)
    assert [ln.text for ln in tp.lines] == ["Thang"]


def test_lines_of_a_rotated_page_keep_user_space_and_display_boxes(tmp_path: Path) -> None:
    path = vietnamese_pdf(tmp_path / "rotated.pdf", rotate=90)
    with pikepdf.open(path) as pdf:
        tp = build_text_page(pdf, pdf.pages[0], 0)
    first = tp.lines[0]
    x0, y0, x1, y1 = tp.display_box(first.bbox)
    assert tp.frame.rotation == 90
    assert 0 <= x0 < x1 <= tp.frame.display_size[0] + 1e-6
    assert 0 <= y0 < y1 <= tp.frame.display_size[1] + 1e-6


def test_form_text_is_visible_to_the_model(tmp_path: Path) -> None:
    from text_support import form_text_pdf

    path = form_text_pdf(tmp_path / "form.pdf", "Text in a form")
    assert _lines(path) == ["Text in a form"]


def test_check_font_supports_standard_font_rejects_vietnamese(tmp_path: Path) -> None:
    path = helvetica_pdf(tmp_path / "h.pdf", [(72, 700, 12, "Hello")])
    with pikepdf.open(path) as pdf:
        font = pdf.pages[0].obj.Resources.Font.F1
        ok = check_font_supports(font, "Hello, world 123")
        bad = check_font_supports(font, "Nguyễn Văn Ạ")
    assert ok["supported"] is True and ok["missing"] == []
    assert bad["supported"] is False
    assert bad["missing"] == ["ễ", "ă", "Ạ"]
    assert bad["hints"][0] == "substitute"


def test_check_font_supports_latin1_standard_font(tmp_path: Path) -> None:
    path = helvetica_pdf(tmp_path / "h.pdf", [(72, 700, 12, "x")])
    with pikepdf.open(path) as pdf:
        font = pdf.pages[0].obj.Resources.Font.F1
        result = check_font_supports(font, "café")
    assert result["supported"] is True


def test_subset_type0_font_reports_the_missing_characters(tmp_path: Path) -> None:
    path = cid_subset_pdf(
        tmp_path / "cid.pdf",
        "Nguyễn Văn An",
        f"BT /F2 20 Tf 72 700 Td <{cid_hex('Nguyễn Văn An')}> Tj ET",
    )
    with pikepdf.open(path) as pdf:
        font = pdf.pages[0].obj.Resources.Font.F2
        cap = FontCapability(font)
        assert cap.kind == "cid"
        assert cap.missing("Nguyễn An") == []
        assert cap.missing("Ạ") == ["Ạ"]
        result = check_font_supports(font, "Nguyễn Bình")
    assert result["supported"] is False
    assert "B" in result["missing"] and "ì" in result["missing"]


def test_reportlab_subset_font_reports_unused_letters(tmp_path: Path) -> None:
    path = vi_page(tmp_path / "vi.pdf", [(72, 700, 14, "Hà Nội", False)])
    with pikepdf.open(path) as pdf:
        tp = build_text_page(pdf, pdf.pages[0], 0)
        font = tp.model.res["/Font"][tp.lines[0].runs[0].font]
        cap = FontCapability(font)
    assert cap.missing("Hà Nội") == []
    assert cap.missing("Ạ") == ["Ạ"]
    assert pdf_text(path).strip() == "Hà Nội"


def test_standard_font_font_name_and_style(tmp_path: Path) -> None:
    path = helvetica_pdf(tmp_path / "h.pdf", [(72, 700, 12, "Plain text")])
    with pikepdf.open(path) as pdf:
        tp = build_text_page(pdf, pdf.pages[0], 0)
    line = tp.lines[0]
    assert line.font_name == "Helvetica"
    assert line.style == "sans" and not line.bold and not line.italic
