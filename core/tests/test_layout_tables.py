"""T10.02: tables from ruling lines (N2), merged cells, continuation across pages, borderless
tables (off by default) and false-positive checks. Generated PDFs only (layout_support.py)."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pikepdf
from layout_support import articles_pdf, ruled_table_pages_pdf, ruled_table_pdf
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from text_support import REG, register_fonts

from chef_core.layout.detect import DetectOptions, build_doc_model
from chef_core.layout.model import Table, TableCell


def _tables(path: Path, **kw: bool) -> list[Table]:
    with pikepdf.open(path) as pdf:
        model = build_doc_model(pdf, None, DetectOptions(**kw)).model
    return [b for p in model.pages for b in p.blocks if isinstance(b, Table)]


def _cell_text(cell: TableCell) -> str:
    return " ".join(r.text for blk in cell.blocks for r in blk.runs)


def _grid(table: Table) -> list[list[str]]:
    return [[_cell_text(c) for c in row] for row in table.rows]


def _draw(path: Path, draw: Callable[[canvas.Canvas], None]) -> Path:
    register_fonts()
    cv = canvas.Canvas(str(path), pagesize=A4)
    draw(cv)
    cv.showPage()
    cv.save()
    return path


def test_ruled_grid_is_three_rows_by_four_columns(tmp_path: Path) -> None:
    tables = _tables(ruled_table_pdf(tmp_path / "t.pdf", merged_header=False))
    assert len(tables) == 1
    table = tables[0]
    assert table.columns == 4
    assert len(table.rows) == 3
    assert all(len(row) == 4 for row in table.rows)
    assert _grid(table) == [
        ["Công ty", "", "Doanh thu", "Chi phí"],
        ["Quý 1", "120", "80", "40"],
        ["Quý 2", "135", "86", "49"],
    ]
    assert all(c.row_span == 1 and c.col_span == 1 for row in table.rows for c in row)


def test_merged_header_cell_spans_two_columns(tmp_path: Path) -> None:
    table = _tables(ruled_table_pdf(tmp_path / "m.pdf", merged_header=True))[0]
    first = table.rows[0][0]
    assert first.col_span == 2 and first.row_span == 1
    assert _cell_text(first) == "Công ty"
    assert len(table.rows[0]) == 3
    assert [c.col_span for c in table.rows[1]] == [1, 1, 1, 1]


def test_header_row_is_detected_from_shading_and_bold(tmp_path: Path) -> None:
    table = _tables(ruled_table_pdf(tmp_path / "h.pdf"))[0]
    assert table.has_header_row is True


def test_vietnamese_cell_text_is_intact(tmp_path: Path) -> None:
    table = _tables(ruled_table_pdf(tmp_path / "vi.pdf", text="Công ty Chef PDF"))[0]
    assert _cell_text(table.rows[0][0]) == "Công ty Chef PDF"


def test_table_continues_on_the_next_page_with_the_same_grid(tmp_path: Path) -> None:
    path = ruled_table_pages_pdf(tmp_path / "pages.pdf")
    with pikepdf.open(path) as pdf:
        model = build_doc_model(pdf).model
    tables = [b for p in model.pages for b in p.blocks if isinstance(b, Table)]
    assert len(tables) == 1, "the two pieces are one table"
    assert _grid(tables[0]) == [
        ["Mục", "Q1", "Q2", "Q3"],
        ["Doanh", "10", "11", "12"],
        ["Chi", "5", "6", "7"],
        ["Lãi", "1", "2", "3"],
        ["Thuế", "4", "5", "6"],
    ], "the repeated header row of the continuation is dropped"


def test_joining_tables_can_be_turned_off(tmp_path: Path) -> None:
    path = ruled_table_pages_pdf(tmp_path / "pages.pdf")
    assert len(_tables(path, join_tables=False)) == 2


def test_a_paragraph_is_not_a_table(tmp_path: Path) -> None:
    assert _tables(articles_pdf(tmp_path / "a.pdf", articles=3)) == []


def test_a_single_rule_under_a_heading_is_not_a_table(tmp_path: Path) -> None:
    def draw(cv: canvas.Canvas) -> None:
        cv.setFont(REG, 11)
        cv.drawString(72, 700, "Tiêu đề phần một")
        cv.line(72, 690, 540, 690)
        cv.drawString(72, 670, "Nội dung của phần này nằm ngay bên dưới đường kẻ.")

    assert _tables(_draw(tmp_path / "rule.pdf", draw)) == []


def test_two_rules_that_do_not_cross_are_not_a_table(tmp_path: Path) -> None:
    def draw(cv: canvas.Canvas) -> None:
        cv.line(72, 700, 300, 700)
        cv.line(72, 600, 300, 600)
        cv.drawString(72, 650, "Hai đường kẻ song song không tạo thành lưới.")

    assert _tables(_draw(tmp_path / "parallel.pdf", draw)) == []


def _aligned_columns(cv: canvas.Canvas) -> None:
    cv.setFont(REG, 10)
    rows = [("Hạng mục", "Số lượng"), ("Bàn ghế", "12"), ("Tủ sách", "4"), ("Máy in", "2")]
    y = 700
    for left, right in rows:
        cv.drawString(72, y, left)
        cv.drawString(300, y, right)
        y -= 16


def test_borderless_tables_are_off_by_default(tmp_path: Path) -> None:
    assert _tables(_draw(tmp_path / "bl.pdf", _aligned_columns)) == []


def test_borderless_heuristic_finds_aligned_columns_when_asked(tmp_path: Path) -> None:
    tables = _tables(_draw(tmp_path / "bl2.pdf", _aligned_columns), borderless_tables=True)
    assert len(tables) == 1
    table = tables[0]
    assert table.columns == 2
    assert _grid(table)[0] == ["Hạng mục", "Số lượng"]
    assert _grid(table)[3] == ["Máy in", "2"]
    assert table.rows[0][0].blocks[0].runs, "cells keep their runs"
