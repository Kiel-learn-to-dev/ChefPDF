"""Excel workbook (XLSX, T10.04, N4) with openpyxl (MIT).

One sheet per table of the document, named ``Bảng <k> - trang <p>`` (Excel allows 31 characters). A
document without tables gets one sheet ``Toàn bộ`` with its text lines (headings, paragraphs and
list items, one per row). The first row of a table is bold (the header). Merged cells are merged in
the sheet: the anchor keeps its value.

Values: with ``parseNumbers`` a cell reading as a number in Vietnamese notation (``1.234,56``, or
``1234``) becomes a number, and ``dd/mm/yyyy`` a date. Anything else stays text. A leading ``=``
never becomes a formula (the text is stored as text). Leading zeros (codes) stay text.
"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Any

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font
from openpyxl.utils import get_column_letter

from chef_core.export.ir import DocIR, ExportResult, Heading, ListBlock, ListNode, Para, TableBlock
from chef_core.export.text import plain
from chef_core.pdf.io import atomic_write

SHEET_TEXT = "Toàn bộ"
SHEET_MAX = 31
NUM_THOUSANDS = re.compile(r"^-?\d{1,3}(\.\d{3})+(,\d+)?$")
NUM_DECIMAL = re.compile(r"^-?\d+,\d+$")
NUM_PLAIN = re.compile(r"^-?(0|[1-9]\d*)$")
DATE_VN = re.compile(r"^(\d{2})/(\d{2})/(\d{4})$")
MAX_WIDTH = 60


def parse_value(text: str, parse_numbers: bool) -> tuple[Any, str | None]:
    """The value to write for ``text`` and its number format (None: general)."""
    if not parse_numbers:
        return text, None
    value = text.strip()
    if NUM_THOUSANDS.match(value):
        number = value.replace(".", "").replace(",", ".")
        return _number(number), None
    if NUM_DECIMAL.match(value):
        return float(value.replace(",", ".")), None
    if NUM_PLAIN.match(value):
        return int(value), None
    match = DATE_VN.match(value)
    if match:
        day, month, year = (int(g) for g in match.groups())
        try:
            return datetime(year, month, day), "dd/mm/yyyy"
        except ValueError:
            return text, None
    return text, None


def _number(text: str) -> float | int:
    number = float(text)
    return int(number) if number.is_integer() and "." not in text else number


def _cell_text(paras: list[list[Any]]) -> str:
    return "\n".join(plain(p) for p in paras)


def _write_table(ws: Any, block: TableBlock, parse_numbers: bool) -> None:
    widths = [8.0] * block.columns
    for r, row in enumerate(block.rows, start=1):
        for c, cell in enumerate(row, start=1):
            if cell.covered:
                continue
            text = _cell_text(cell.paras)
            if r == 1:
                ws.cell(row=r, column=c).font = Font(bold=True)
            if len(cell.paras) == 1 and cell.paras[0] and r > 1:
                value, fmt = parse_value(text, parse_numbers)
            else:
                value, fmt = text, None
            target = ws.cell(row=r, column=c)
            target.value = value
            if isinstance(value, str) and value.startswith("="):
                target.data_type = "s"
            if fmt:
                target.number_format = fmt
            if "\n" in text:
                target.alignment = Alignment(wrap_text=True, vertical="top")
            if cell.row_span > 1 or cell.col_span > 1:
                ws.merge_cells(
                    start_row=r,
                    start_column=c,
                    end_row=r + cell.row_span - 1,
                    end_column=c + cell.col_span - 1,
                )
            if cell.col_span == 1:
                widths[c - 1] = max(widths[c - 1], min(MAX_WIDTH, len(text) * 1.1 + 2))
    for c, width in enumerate(widths, start=1):
        ws.column_dimensions[get_column_letter(c)].width = width


def _text_lines(nodes: list[ListNode], depth: int, ordered: bool, out: list[str]) -> None:
    for number, node in enumerate(nodes, start=1):
        marker = node.marker or (f"{number}." if ordered else "•")
        out.append(f"{'  ' * depth}{marker} {plain(node.runs)}".rstrip())
        _text_lines(node.children, depth + 1, ordered, out)


def _text_sheet(ws: Any, ir: DocIR) -> None:
    lines: list[str] = []
    for item in ir.items:
        if isinstance(item, Heading | Para):
            lines.append(plain(item.runs))
        elif isinstance(item, ListBlock):
            _text_lines(item.items, 0, item.ordered, lines)
    for row, text in enumerate((ln for ln in lines if ln), start=1):
        ws.cell(row=row, column=1).value = text
    ws.column_dimensions["A"].width = 100


def build_workbook(ir: DocIR, parse_numbers: bool) -> Workbook:
    wb = Workbook()
    wb.remove(wb.active)
    tables = [it for it in ir.items if isinstance(it, TableBlock)]
    if tables:
        for number, block in enumerate(tables, start=1):
            title = f"Bảng {number} - trang {block.page + 1}"[:SHEET_MAX]
            ws = wb.create_sheet(title=title)
            _write_table(ws, block, parse_numbers)
    else:
        _text_sheet(wb.create_sheet(title=SHEET_TEXT), ir)
    if not wb.worksheets:
        wb.create_sheet(title=SHEET_TEXT)
    wb.properties.title = ir.title or ir.name
    wb.properties.creator = ir.author or "Chef PDF"
    wb.properties.language = ir.language
    return wb


def write_xlsx(ir: DocIR, out: Path, parse_numbers: bool = True) -> ExportResult:
    wb = build_workbook(ir, parse_numbers)
    atomic_write(out, lambda tmp: wb.save(tmp))
    tables = len(ir.blocks_of(TableBlock))
    return ExportResult(
        outputs=[str(out)],
        warnings=list(ir.warnings),
        stats={"sheets": len(wb.worksheets), "tables": tables},
    )
