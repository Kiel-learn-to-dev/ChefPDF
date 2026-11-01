"""Refresh (N6, "Làm mới tài liệu"): a new, clean PDF typeset from the document model.

Platypus lays the items out in one column on A4, Letter or the source page size, with margins and a
font scale. Text is Be Vietnam Pro (regular and bold; the italic style has no italic face in the
bundled fonts, so italic runs are set in the regular face). Headings become outline (bookmark)
entries of their level. Tables are grid tables with merged cells and a repeated header row. Images
and vector figures are placed scaled to the width of the column. Every page has a page number; the
header and footer texts of the source are used only with ``includeHeadersFooters``.

The result is not a tagged PDF; the text is real text (selectable, searchable) in reading order.
"""

from __future__ import annotations

import html
import io
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.pdfmetrics import registerFontFamily
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    HRFlowable,
    Image,
    KeepTogether,
    ListFlowable,
    ListItem,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

from chef_core.export.ir import (
    CellIR,
    DocIR,
    ExportResult,
    Heading,
    ImageBlock,
    Item,
    ListBlock,
    ListNode,
    PageMark,
    Para,
    Rule,
    TableBlock,
)
from chef_core.export.options import ExportOptions
from chef_core.export.text import merge_runs, plain, squash
from chef_core.layout.model import Run
from chef_core.pdf.io import atomic_write
from chef_core.text.fonts import fonts_dir

REG = "ChefSans"
BOLD = "ChefSans-Bold"
PAGE_SIZES = {"A4": A4, "Letter": LETTER}
DEFAULT_BODY = 10.0
HEADING_FALLBACK = {1: 1.8, 2: 1.5, 3: 1.25, 4: 1.1, 5: 1.0, 6: 1.0}
MAX_IMAGE_HEIGHT_RATIO = 0.9


def _register_fonts() -> None:
    if REG in pdfmetrics.getRegisteredFontNames():
        return
    directory = fonts_dir()
    pdfmetrics.registerFont(TTFont(REG, str(directory / "BeVietnamPro-Regular.ttf")))
    pdfmetrics.registerFont(TTFont(BOLD, str(directory / "BeVietnamPro-Bold.ttf")))
    registerFontFamily(REG, normal=REG, bold=BOLD, italic=REG, boldItalic=BOLD)


def _hex(colour: str | None) -> str | None:
    if colour and len(colour) == 7 and colour.startswith("#") and colour.lower() != "#000000":
        return colour
    return None


def markup(runs: Sequence[Run]) -> str:
    """Platypus paragraph markup for runs (escaped; bold, super/subscript, colour, links)."""
    out: list[str] = []
    for run in merge_runs(runs):
        text = html.escape(run.text, quote=False)
        if run.sup:
            text = f"<super>{text}</super>"
        elif run.sub:
            text = f"<sub>{text}</sub>"
        if run.bold:
            text = f"<b>{text}</b>"
        if run.italic:
            text = f"<i>{text}</i>"
        colour = _hex(run.color)
        if colour:
            text = f'<font color="{colour}">{text}</font>'
        if run.link and run.link.startswith(("http://", "https://")):
            text = f'<link href="{html.escape(run.link, quote=True)}">{text}</link>'
        out.append(text)
    return "".join(out)


class _Heading(Paragraph):  # type: ignore[misc]
    """A heading paragraph that records its outline entry after it is placed."""

    def __init__(self, text: str, style: ParagraphStyle, level: int, key: str) -> None:
        super().__init__(text, style)
        self.level = level
        self.key = key
        self.title = squash(html.unescape(_strip_tags(text)))


def _strip_tags(text: str) -> str:
    out = []
    inside = False
    for ch in text:
        if ch == "<":
            inside = True
        elif ch == ">":
            inside = False
        elif not inside:
            out.append(ch)
    return "".join(out)


class _Doc(BaseDocTemplate):  # type: ignore[misc]
    def afterFlowable(self, flowable: Flowable) -> None:
        if isinstance(flowable, _Heading):
            self.canv.bookmarkPage(flowable.key)
            self.canv.addOutlineEntry(
                flowable.title or flowable.key,
                flowable.key,
                level=max(0, flowable.level - 1),
                closed=False,
            )


class _Styles:
    def __init__(self, base: float, heads: dict[int, float], scale: float) -> None:
        self.body = ParagraphStyle(
            "body", fontName=REG, fontSize=base, leading=base * 1.4, spaceAfter=base * 0.5
        )
        self.small = ParagraphStyle(
            "small",
            parent=self.body,
            fontSize=base * 0.85,
            leading=base * 1.2,
            spaceAfter=base * 0.2,
        )
        self.cell = ParagraphStyle(
            "cell", parent=self.body, fontSize=base * 0.9, leading=base * 1.2, spaceAfter=0
        )
        self.cell_head = ParagraphStyle("cellhead", parent=self.cell, fontName=BOLD)
        self.heads: dict[int, ParagraphStyle] = {}
        for level in range(1, 7):
            size = heads.get(level, base * HEADING_FALLBACK[level]) * scale
            self.heads[level] = ParagraphStyle(
                f"h{level}",
                fontName=BOLD,
                fontSize=size,
                leading=size * 1.25,
                spaceBefore=size * 0.6,
                spaceAfter=size * 0.3,
            )


def _list_flow(nodes: list[ListNode], ordered: bool, styles: _Styles, size: float) -> ListFlowable:
    items: list[Any] = []
    for node in nodes:
        content: list[Flowable] = [Paragraph(markup(node.runs) or "&nbsp;", styles.body)]
        if node.children:
            content.append(_list_flow(node.children, ordered, styles, size))
        items.append(ListItem(content, leftIndent=size * 1.2))
    kind = "1" if ordered else "bullet"
    return ListFlowable(
        items,
        bulletType=kind,
        bulletFormat="%s." if ordered else None,
        leftIndent=size * 1.2,
        bulletFontName=REG,
        bulletFontSize=size,
        start="1" if ordered else None,
    )


def _table_flow(block: TableBlock, styles: _Styles, avail: float) -> Table:
    grid = block.rows
    data: list[list[Any]] = []
    commands: list[tuple[Any, ...]] = [
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#8a8a8a")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 3),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3),
    ]
    width = max(1, block.columns)
    for r, row in enumerate(grid):
        line: list[Any] = []
        for c, cell in enumerate(row):
            if cell.covered:
                line.append("")
                continue
            line.append(_cell_flow(cell, styles, bold=block.header and r == 0))
            if cell.row_span > 1 or cell.col_span > 1:
                commands.append(("SPAN", (c, r), (c + cell.col_span - 1, r + cell.row_span - 1)))
        data.append(line)
    if block.header and grid:
        commands.append(("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#e9eef7")))
    table = Table(data, colWidths=[avail / width] * width, repeatRows=1 if block.header else 0)
    table.setStyle(TableStyle(commands))
    return table


def _cell_flow(cell: CellIR, styles: _Styles, bold: bool) -> Any:
    style = styles.cell_head if bold else styles.cell
    paras = [Paragraph(markup(p) or "&nbsp;", style) for p in cell.paras]
    if not paras:
        return ""
    return paras if len(paras) > 1 else paras[0]


def _image_flow(item: ImageBlock, avail: float, max_height: float) -> Flowable | None:
    if item.asset is None:
        return None
    width = min(item.width or avail, avail)
    height = item.height * (width / item.width) if item.width else width
    if height > max_height:
        width *= max_height / height
        height = max_height
    picture = Image(io.BytesIO(item.asset.data), width=width, height=height)
    picture.hAlign = "CENTER"
    return picture


def _story(
    ir: DocIR, styles: _Styles, avail: float, max_height: float, base: float
) -> list[Flowable]:
    story: list[Flowable] = []
    counter = 0
    for item in ir.items:
        if isinstance(item, PageMark):
            continue
        if isinstance(item, Heading):
            counter += 1
            story.append(
                _Heading(markup(item.runs), styles.heads[item.level], item.level, f"h{counter}")
            )
        elif isinstance(item, Para):
            if item.role in ("header", "footer", "pagenumber"):
                continue
            style = styles.small if item.role in ("footnote", "caption") else styles.body
            story.append(Paragraph(markup(item.runs), style))
        elif isinstance(item, ListBlock):
            story.append(_list_flow(item.items, item.ordered, styles, base))
        elif isinstance(item, TableBlock):
            story.append(_table_flow(item, styles, avail))
            story.append(Spacer(1, base * 0.6))
        elif isinstance(item, ImageBlock):
            picture = _image_flow(item, avail, max_height)
            block: list[Flowable] = (
                [picture]
                if picture is not None
                else [Paragraph("[Hình không trích được]", styles.small)]
            )
            if item.caption:
                block.append(Paragraph(markup([Run(text=squash(item.caption))]), styles.small))
            story.append(KeepTogether(block))
        elif isinstance(item, Rule):
            story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#888888")))
            story.append(Spacer(1, base * 0.4))
    return story


def _page_size(ir: DocIR, choice: str) -> tuple[float, float, bool]:
    """(width, height, mixed): the size of the output; ``mixed`` when source pages differ."""
    marks = [it for it in ir.items if isinstance(it, PageMark)]
    if choice in PAGE_SIZES:
        return PAGE_SIZES[choice][0], PAGE_SIZES[choice][1], False
    if not marks:
        return A4[0], A4[1], False
    first = marks[0]
    mixed = any(abs(m.width - first.width) > 1 or abs(m.height - first.height) > 1 for m in marks)
    return first.width, first.height, mixed


def build_pdf(path: Path, ir: DocIR, opts: ExportOptions) -> list[str]:
    """Typeset ``ir`` into ``path`` (a temp file when called from ``write_refresh``)."""
    _register_fonts()
    width, height, mixed = _page_size(ir, opts.page_size)
    margin = opts.margins
    base = (ir.body_size or DEFAULT_BODY) * opts.font_scale
    base = min(max(base, 6.0), 24.0)
    styles = _Styles(base, ir.heading_sizes, opts.font_scale)
    avail = width - 2 * margin
    max_height = (height - 2 * margin) * MAX_IMAGE_HEIGHT_RATIO
    story = _story(ir, styles, avail, max_height, base)
    header_text = _first_text(ir, "header") if opts.include_headers_footers else ""
    footer_text = _first_text(ir, "footer") if opts.include_headers_footers else ""

    def decorate(canv: Canvas, doc: BaseDocTemplate) -> None:
        canv.saveState()
        canv.setFont(REG, 8)
        canv.setFillColor(colors.HexColor("#555555"))
        if header_text:
            canv.drawString(margin, height - margin * 0.6, header_text)
        if footer_text:
            canv.drawString(margin, margin * 0.5, footer_text)
        canv.drawRightString(width - margin, margin * 0.5, f"Trang {canv.getPageNumber()}")
        canv.restoreState()

    doc = _Doc(
        str(path),
        pagesize=(width, height),
        leftMargin=margin,
        rightMargin=margin,
        topMargin=margin,
        bottomMargin=margin,
        title=ir.title or ir.name,
        author=ir.author or "Chef PDF",
    )
    frame = Frame(
        margin,
        margin,
        avail,
        height - 2 * margin,
        id="body",
        showBoundary=0,
        leftPadding=0,
        rightPadding=0,
        topPadding=0,
        bottomPadding=0,
    )
    doc.addPageTemplates([PageTemplate(id="page", frames=[frame], onPage=decorate)])
    doc.build(story or [Paragraph("&nbsp;", styles.body)])
    warnings = ["PAGE_SIZE_UNIFIED"] if mixed else []
    return warnings


def _first_text(ir: DocIR, role: str) -> str:
    for item in ir.items:
        if isinstance(item, Para) and item.role == role:
            return plain(item.runs)
    return ""


def write_refresh(ir: DocIR, out: Path, opts: ExportOptions) -> ExportResult:
    holder: dict[str, list[str]] = {}

    def write(tmp: Path) -> None:
        holder["warnings"] = build_pdf(tmp, ir, opts)

    atomic_write(out, write)
    warnings = sorted(set(ir.warnings + holder.get("warnings", [])))
    pages = len([it for it in ir.items if isinstance(it, PageMark)])
    return ExportResult(
        outputs=[str(out)],
        warnings=warnings,
        stats={"pages": pages, "blocks": len(ir.items)},
    )


__all__ = ["Canvas", "Item", "KeepTogether", "build_pdf", "markup", "write_refresh"]
