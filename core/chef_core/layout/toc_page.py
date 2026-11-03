"""Render and insert a linked contents page from detected PDF headings."""

from __future__ import annotations

from io import BytesIO
from typing import Any

import pikepdf
from pikepdf import Array, Dictionary, Name
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import simpleSplit
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from chef_core.errors import invalid_params
from chef_core.pdf.pages import display_size
from chef_core.signing.fonts import font_path

_REG, _BOLD = "ChefTocBeVietnam", "ChefTocBeVietnamBold"
_TITLE_SIZE = 18.0
_ROW_SIZE = 10.5
_LEADING = 14.0
_PAGE_LABEL_WIDTH = 34.0


def _register_fonts() -> None:
    if _REG not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(_REG, str(font_path("BeVietnamPro", bold=False))))
    if _BOLD not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(_BOLD, str(font_path("BeVietnamPro", bold=True))))


def _flat(nodes: list[dict[str, Any]], depth: int = 0) -> list[tuple[dict[str, Any], int]]:
    result: list[tuple[dict[str, Any], int]] = []
    for node in nodes:
        result.append((node, depth))
        result.extend(_flat(node["children"], depth + 1))
    return result


def insert_contents(
    pdf: pikepdf.Pdf,
    nodes: list[dict[str, Any]],
    *,
    title: str = "Mục lục",
    insertion_index: int = 0,
    page_size: str = "source",
    dot_leader: bool = True,
    page_number_offset: int = 0,
    font_scale: float = 1.0,
    link_entries: bool = True,
) -> int:
    """Generate linked contents pages and insert them at a 0-based boundary in the document."""
    rows = _flat(nodes)
    if not rows:
        raise invalid_params(
            "No detected headings meet the table of contents filters", {"code": "NO_HEADINGS"}
        )
    _register_fonts()
    if insertion_index < 0 or insertion_index > len(pdf.pages):
        raise ValueError("Contents insertion position is outside the document")
    if page_size == "a4":
        width, height = A4
    else:
        width, height, _ = display_size(pdf.pages[0])
    margin = min(48.0, width * 0.1, height * 0.1)
    top = height - margin
    usable = top - 34.0 - margin
    font_size = _ROW_SIZE * font_scale
    leading = _LEADING * font_scale
    title_size = _TITLE_SIZE * font_scale
    pages: list[list[tuple[list[str], int, int, int]]] = [[]]
    used = [0.0]
    for node, depth in rows:
        entry_title = str(node["title"])
        page_index = int(node["page"])
        if page_index < 0 or page_index >= len(pdf.pages):
            raise ValueError(f"Heading page index out of range: {page_index}")
        x = margin + min(depth, 5) * 16.0
        text_width = width - x - margin - _PAGE_LABEL_WIDTH - 10.0
        lines = simpleSplit(entry_title, _REG, font_size, text_width) or [""]
        while lines:
            room = int(max(0.0, usable - used[-1] - 4.0) // leading)
            if room <= 0:
                pages.append([])
                used.append(0.0)
                room = max(1, int((usable - 4.0) // leading))
            chunk = lines[:room]
            lines = lines[room:]
            pages[-1].append((chunk, page_index, depth, 1 if not lines else 0))
            used[-1] += len(chunk) * leading + 4.0
            if lines:
                pages.append([])
                used.append(0.0)

    page_count = len(pages)
    buffers: list[BytesIO] = []
    link_rects: list[list[tuple[tuple[float, float, float, float], int]]] = []
    for page_rows in pages:
        buffer = BytesIO()
        c = canvas.Canvas(buffer, pagesize=(width, height), invariant=1)
        c.setTitle(title)
        c.setFont(_BOLD, title_size)
        c.drawString(margin, top, title)
        y = top - 34.0
        refs: list[tuple[tuple[float, float, float, float], int]] = []
        for lines, page_index, depth, is_last_chunk in page_rows:
            x = margin + min(depth, 5) * 16.0
            physical_index = page_index + (page_count if page_index >= insertion_index else 0)
            label = f"{physical_index + 1 + page_number_offset}"
            c.setFont(_REG, font_size)
            for line_i, line in enumerate(lines):
                line_y = y - line_i * leading
                c.drawString(x, line_y, line)
                if dot_leader and is_last_chunk and line_i == len(lines) - 1:
                    text_end = x + pdfmetrics.stringWidth(line, _REG, font_size)
                    number_start = width - margin - pdfmetrics.stringWidth(label, _REG, font_size)
                    dot_width = pdfmetrics.stringWidth(".", _REG, font_size)
                    if dot_width > 0 and number_start - text_end > dot_width * 2:
                        dots = "." * int((number_start - text_end) / dot_width)
                        c.drawString(text_end, line_y, dots)
            if is_last_chunk:
                c.drawRightString(width - margin, y - (len(lines) - 1) * leading, label)
            row_top = y + 3.0
            row_bottom = y - (len(lines) - 1) * leading - font_size + 2.0
            refs.append(((x, row_bottom, width - margin, row_top), page_index))
            y -= len(lines) * leading + 4.0
        c.showPage()
        c.save()
        buffers.append(buffer)
        link_rects.append(refs)

    for index, buffer in enumerate(buffers):
        with pikepdf.Pdf.open(BytesIO(buffer.getvalue())) as generated:
            page_obj = pdf.copy_foreign(generated.pages[0].obj)
            pdf.pages.insert(insertion_index + index, pikepdf.Page(page_obj))

    for toc_index, refs in enumerate(link_rects):
        annots = Array()
        for rect, original_index in refs if link_entries else []:
            target_index = original_index + (page_count if original_index >= insertion_index else 0)
            destination_page = pdf.pages[target_index].obj
            annots.append(
                pdf.make_indirect(
                    Dictionary(
                        {
                            "/Type": Name.Annot,
                            "/Subtype": Name.Link,
                            "/Rect": Array(rect),
                            "/Border": Array([0, 0, 0]),
                            "/A": Dictionary(
                                {
                                    "/S": Name.GoTo,
                                    "/D": Array([destination_page, Name.XYZ, None, None, None]),
                                }
                            ),
                        }
                    )
                )
            )
        if annots:
            pdf.pages[insertion_index + toc_index].obj["/Annots"] = annots
    return page_count

