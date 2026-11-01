"""Word (DOCX, T10.05, N5) with python-docx (MIT). Two modes, chosen by ``options.mode``:

``editable`` ("dễ chỉnh sửa"): a flowing document. Headings use the built-in Heading 1-6 styles,
the body uses Normal with the dominant font and size of the source, lists are Word lists (List
Bullet / List Number styles, nesting by level, a new number sequence per ordered list), tables are
real tables with merged cells and a repeated header row, images are inline. Repeated header and
footer text goes into the section header and footer (when ``includeHeadersFooters``), with a PAGE
field for page numbers. ``pageBreaks`` starts a new page at each source page. Language vi-VN.

``layout`` ("giữ bố cục"): one section per source page, with the source page size and zero
margins. Every block is a set of paragraphs with a ``w:framePr`` at its position (one frame per
block; a list is one frame), tables are floating tables (``w:tblpPr``) with fixed widths, images
are anchored pictures (``wp:anchor``) relative to the page. Fonts: the source font mapped to Times
New Roman, Courier New or Arial (``fonts.installed_name``); Be Vietnam Pro is kept when used.

Vietnamese: every run gets rFonts for ascii, hAnsi, eastAsia and cs, and the Normal style is vi-VN.
"""

from __future__ import annotations

import io
from collections.abc import Sequence
from copy import deepcopy
from pathlib import Path
from typing import Any

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.text import WD_BREAK, WD_LINE_SPACING
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import nsdecls, qn
from docx.shared import Pt, RGBColor
from docx.table import Table as DocxTable
from docx.text.paragraph import Paragraph
from docx.text.run import Run as DocxRun

from chef_core.export.fonts import installed_name
from chef_core.export.ir import (
    BBox,
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
from chef_core.export.text import squash
from chef_core.layout.model import Run
from chef_core.pdf.io import atomic_write

PT_TO_EMU = 12700
PT_TO_TWIPS = 20
A4_W, A4_H = 595.28, 841.89
MARGIN_PT = 56.7
BLACK = "000000"
LIST_LEVEL_STYLES = {
    False: ["List Bullet", "List Bullet 2", "List Bullet 3"],
    True: ["List Number", "List Number 2", "List Number 3"],
}
MAX_LEVEL = 8
LIST_INDENT_PT = 14.0


# -- fonts, runs and paragraph helpers ---------------------------------------------------------


def set_fonts(rpr: Any, name: str) -> None:
    """rFonts for every script: the eastAsia and cs slots are set too, so that Word does not pick
    another font for some characters of the Vietnamese text."""
    rfonts = rpr.get_or_add_rFonts()
    for attr in ("w:ascii", "w:hAnsi", "w:eastAsia", "w:cs"):
        rfonts.set(qn(attr), name)


def _hex(colour: str | None) -> str | None:
    if colour and len(colour) == 7 and colour.startswith("#") and colour.lower() != "#000000":
        return colour[1:].upper()
    return None


def style_run(run: DocxRun, src: Run, font: str, size: float | None, layout: bool) -> None:
    """Formatting of one source run. ``layout`` writes explicit values (bold and italic off are
    written too), so that a heading style does not leak into a frame."""
    if layout or src.bold:
        run.bold = bool(src.bold)
    if layout or src.italic:
        run.italic = bool(src.italic)
    if src.sup:
        run.font.superscript = True
    elif src.sub:
        run.font.subscript = True
    chosen = src.size or size
    if chosen:
        run.font.size = Pt(float(chosen))
    colour = _hex(src.color)
    if colour:
        run.font.color.rgb = RGBColor.from_string(colour)
    elif layout:
        run.font.color.rgb = RGBColor.from_string(BLACK)
    name = installed_name(src.font) if src.font else font
    set_fonts(run._r.get_or_add_rPr(), name)


def add_link(paragraph: Paragraph, src: Run, font: str, size: float | None, layout: bool) -> None:
    """A run inside a ``w:hyperlink`` pointing to an external target (blue, underlined)."""
    assert src.link is not None
    rid = paragraph.part.relate_to(src.link, RT.HYPERLINK, is_external=True)
    run = paragraph.add_run(src.text)
    element = run._r
    paragraph._p.remove(element)
    link = OxmlElement("w:hyperlink")
    link.set(qn("r:id"), rid)
    link.append(element)
    paragraph._p.append(link)
    style_run(run, src, font, size, layout)
    rpr = element.get_or_add_rPr()
    color = OxmlElement("w:color")
    color.set(qn("w:val"), "0563C1")
    rpr.append(color)
    underline = OxmlElement("w:u")
    underline.set(qn("w:val"), "single")
    rpr.append(underline)


def write_runs(
    paragraph: Paragraph, runs: Sequence[Run], font: str, size: float | None, layout: bool
) -> None:
    for src in runs:
        if not src.text:
            continue
        if src.link and src.link.startswith(("http://", "https://")):
            add_link(paragraph, src, font, size, layout)
        else:
            style_run(paragraph.add_run(src.text), src, font, size, layout)


def page_field(paragraph: Paragraph) -> None:
    """A PAGE field (the page number) at the end of ``paragraph``."""
    field = OxmlElement("w:fldSimple")
    field.set(qn("w:instr"), " PAGE ")
    run = OxmlElement("w:r")
    text = OxmlElement("w:t")
    text.text = "1"
    run.append(text)
    field.append(run)
    paragraph._p.append(field)


def _core(doc: Any, ir: DocIR) -> None:
    props = doc.core_properties
    props.title = ir.title or ir.name
    if ir.author:
        props.author = ir.author
    props.language = "vi-VN" if ir.language.startswith("vi") else ir.language


def _normal(doc: Any, ir: DocIR) -> str:
    """Normal: the dominant font and size of the source, language vi-VN. Returns the font name."""
    font = installed_name(ir.body_font)
    normal = doc.styles["Normal"]
    normal.font.name = font
    normal.font.size = Pt(ir.body_size or 11)
    rpr = normal.element.get_or_add_rPr()
    set_fonts(rpr, font)
    lang = OxmlElement("w:lang")
    lang.set(qn("w:val"), "vi-VN")
    lang.set(qn("w:eastAsia"), "vi-VN")
    rpr.append(lang)
    return font


def _heading_styles(doc: Any, ir: DocIR, font: str) -> None:
    for level in range(1, 7):
        style = doc.styles[f"Heading {level}"]
        style.font.name = font
        size = ir.heading_sizes.get(level)
        if size:
            style.font.size = Pt(size)
        set_fonts(style.element.get_or_add_rPr(), font)


def _style_numbering(doc: Any, style_name: str) -> int | None:
    pPr = doc.styles[style_name].element.pPr
    if pPr is None or pPr.numPr is None or pPr.numPr.numId is None:
        return None
    return int(pPr.numPr.numId.val)


def _restart_numbering(doc: Any, base_num_id: int) -> int:
    """A new w:num on the abstract numbering of ``base_num_id``, starting again at 1."""
    numbering = doc.part.numbering_part.element
    abstract_id: str | None = None
    max_id = 0
    for num in numbering.findall(qn("w:num")):
        num_id = int(num.get(qn("w:numId")))
        max_id = max(max_id, num_id)
        if num_id == base_num_id:
            abstract = num.find(qn("w:abstractNumId"))
            abstract_id = abstract.get(qn("w:val")) if abstract is not None else None
    if abstract_id is None:
        return base_num_id
    new = OxmlElement("w:num")
    new.set(qn("w:numId"), str(max_id + 1))
    ref = OxmlElement("w:abstractNumId")
    ref.set(qn("w:val"), abstract_id)
    new.append(ref)
    override = OxmlElement("w:lvlOverride")
    override.set(qn("w:ilvl"), "0")
    start = OxmlElement("w:startOverride")
    start.set(qn("w:val"), "1")
    override.append(start)
    new.append(override)
    numbering.append(new)
    return max_id + 1


def _set_numpr(paragraph: Paragraph, num_id: int, level: int) -> None:
    pPr = paragraph._p.get_or_add_pPr()
    numpr = pPr.get_or_add_numPr()
    numpr.get_or_add_ilvl().val = min(level, MAX_LEVEL)
    numpr.get_or_add_numId().val = num_id


def _bottom_border(paragraph: Paragraph) -> None:
    pPr = paragraph._p.get_or_add_pPr()
    borders = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    for attr, value in (
        ("w:val", "single"),
        ("w:sz", "4"),
        ("w:space", "1"),
        ("w:color", "888888"),
    ):
        bottom.set(qn(attr), value)
    borders.append(bottom)
    frame = pPr.find(qn("w:framePr"))
    if frame is not None:
        frame.addnext(borders)
    else:
        pPr.append(borders)


def _fill_cell(target: Any, cell: CellIR, font: str, layout: bool) -> None:
    for number, para_runs in enumerate(cell.paras):
        paragraph = target.paragraphs[0] if number == 0 else target.add_paragraph()
        write_runs(paragraph, para_runs, font, None, layout)


def _merge_spans(table: DocxTable, block: TableBlock) -> None:
    for r, row in enumerate(block.rows):
        for c, cell in enumerate(row):
            if not cell.covered and (cell.row_span > 1 or cell.col_span > 1):
                table.cell(r, c).merge(table.cell(r + cell.row_span - 1, c + cell.col_span - 1))


# -- editable mode -----------------------------------------------------------------------------


def _list_paragraphs(
    doc: Any, nodes: list[ListNode], ordered: bool, depth: int, num_id: int | None, font: str
) -> None:
    levels = LIST_LEVEL_STYLES[ordered]
    style = levels[min(depth, len(levels) - 1)]
    for node in nodes:
        paragraph = doc.add_paragraph(style=style)
        if num_id is not None:
            _set_numpr(paragraph, num_id, depth)
        write_runs(paragraph, node.runs, font, None, layout=False)
        _list_paragraphs(doc, node.children, ordered, depth + 1, num_id, font)


def _editable_table(doc: Any, block: TableBlock, font: str, width_pt: float) -> None:
    table: DocxTable = doc.add_table(rows=len(block.rows), cols=block.columns)
    table.style = doc.styles["Table Grid"]
    table.autofit = True
    _merge_spans(table, block)
    if block.header and block.rows:
        trpr = table.rows[0]._tr.get_or_add_trPr()
        trpr.append(OxmlElement("w:tblHeader"))
    col_w = width_pt / max(1, block.columns)
    for r, row in enumerate(block.rows):
        for c, cell in enumerate(row):
            if cell.covered:
                continue
            target = table.cell(r, c)
            target.width = Pt(col_w * cell.col_span)
            _fill_cell(target, cell, font, layout=False)


def _picture_paragraph(doc: Any, item: ImageBlock, max_width: float) -> None:
    if item.asset is None:
        note = doc.add_paragraph()
        note.add_run("[Hình không trích được]").italic = True
        return
    width = min(item.width or max_width, max_width)
    paragraph = doc.add_paragraph()
    paragraph.add_run().add_picture(io.BytesIO(item.asset.data), width=Pt(width))


def _furniture(section: Any, ir: DocIR, font: str) -> None:
    """Repeated header and footer text of the source, when they are in the model."""
    header = next((it for it in ir.items if isinstance(it, Para) and it.role == "header"), None)
    footer = next((it for it in ir.items if isinstance(it, Para) and it.role == "footer"), None)
    numbered = any(isinstance(it, Para) and it.role == "pagenumber" for it in ir.items)
    if header is not None:
        section.header.is_linked_to_previous = False
        write_runs(section.header.paragraphs[0], header.runs, font, 8, layout=False)
    if footer is not None or numbered:
        section.footer.is_linked_to_previous = False
        paragraph = section.footer.paragraphs[0]
        if footer is not None:
            write_runs(paragraph, footer.runs, font, 8, layout=False)
        if numbered:
            if footer is not None:
                paragraph.add_run("  ")
            page_field(paragraph)


def write_editable(ir: DocIR, out: Path, opts: ExportOptions) -> ExportResult:
    doc = Document()
    _core(doc, ir)
    font = _normal(doc, ir)
    _heading_styles(doc, ir, font)
    section = doc.sections[0]
    section.page_width, section.page_height = Pt(A4_W), Pt(A4_H)
    for side in ("left_margin", "right_margin", "top_margin", "bottom_margin"):
        setattr(section, side, Pt(MARGIN_PT))
    text_width = A4_W - 2 * MARGIN_PT
    _furniture(section, ir, font)
    first_page = True
    for item in ir.items:
        if isinstance(item, PageMark):
            if opts.page_breaks and not first_page:
                doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
            first_page = False
        elif isinstance(item, Heading):
            paragraph = doc.add_paragraph(style=f"Heading {item.level}")
            write_runs(paragraph, item.runs, font, None, layout=False)
        elif isinstance(item, Para):
            if item.role in ("header", "footer", "pagenumber"):
                continue  # the section header and footer carry the furniture
            paragraph = doc.add_paragraph(style="Caption" if item.role == "caption" else None)
            size = 9.0 if item.role in ("footnote", "caption") else None
            write_runs(paragraph, item.runs, font, size, layout=False)
        elif isinstance(item, ListBlock):
            base = _style_numbering(doc, LIST_LEVEL_STYLES[item.ordered][0])
            num_id = _restart_numbering(doc, base) if (item.ordered and base) else base
            _list_paragraphs(doc, item.items, item.ordered, 0, num_id, font)
        elif isinstance(item, TableBlock):
            _editable_table(doc, item, font, text_width)
            doc.add_paragraph()
        elif isinstance(item, ImageBlock):
            _picture_paragraph(doc, item, text_width)
            if item.caption:
                paragraph = doc.add_paragraph(style="Caption")
                write_runs(paragraph, [Run(text=squash(item.caption), italic=True)], font, 9, False)
        elif isinstance(item, Rule):
            _bottom_border(doc.add_paragraph())
    atomic_write(out, lambda tmp: doc.save(str(tmp)))
    return _result(ir, out)


# -- layout mode -------------------------------------------------------------------------------


def _twips(value: float) -> int:
    return max(1, round(value * PT_TO_TWIPS))


def _frame(paragraph: Paragraph, box: BBox) -> None:
    """Position ``paragraph`` on the page. Consecutive paragraphs with the same frame form one."""
    x0, y0, x1, y1 = box
    pPr = paragraph._p.get_or_add_pPr()
    frame = OxmlElement("w:framePr")
    frame.set(qn("w:w"), str(_twips(max(1.0, x1 - x0))))
    frame.set(qn("w:h"), str(_twips(max(1.0, y1 - y0))))
    frame.set(qn("w:hRule"), "atLeast")
    frame.set(qn("w:wrap"), "around")
    frame.set(qn("w:vAnchor"), "page")
    frame.set(qn("w:hAnchor"), "page")
    frame.set(qn("w:x"), str(_twips(x0)))
    frame.set(qn("w:y"), str(_twips(y0)))
    style = pPr.find(qn("w:pStyle"))
    if style is not None:
        style.addnext(frame)
    else:
        pPr.insert(0, frame)


def _frame_paragraph(doc: Any, box: BBox, line_size: float) -> Paragraph:
    paragraph: Paragraph = doc.add_paragraph()
    fmt = paragraph.paragraph_format
    fmt.space_before = Pt(0)
    fmt.space_after = Pt(0)
    fmt.line_spacing_rule = WD_LINE_SPACING.AT_LEAST
    fmt.line_spacing = Pt(max(1.0, line_size * 1.2))
    _frame(paragraph, box)
    return paragraph


def _line_size(runs: Sequence[Run], default: float) -> float:
    sizes = [r.size for r in runs if r.size]
    return max(sizes) if sizes else default


def _layout_table(doc: Any, block: TableBlock, font: str, body: float) -> None:
    x0, _, x1, _ = block.bbox
    width = max(1.0, x1 - x0)
    table: DocxTable = doc.add_table(rows=len(block.rows), cols=block.columns)
    tbl = table._tbl
    new = OxmlElement("w:tblPr")
    style = OxmlElement("w:tblStyle")
    style.set(qn("w:val"), "TableGrid")
    new.append(style)
    pos = OxmlElement("w:tblpPr")
    for attr, value in (
        ("w:leftFromText", "0"),
        ("w:rightFromText", "0"),
        ("w:topFromText", "0"),
        ("w:bottomFromText", "0"),
        ("w:vertAnchor", "page"),
        ("w:horzAnchor", "page"),
        ("w:tblpX", str(_twips(x0))),
        ("w:tblpY", str(_twips(block.bbox[1]))),
    ):
        pos.set(qn(attr), value)
    new.append(pos)
    tblw = OxmlElement("w:tblW")
    tblw.set(qn("w:w"), str(_twips(width)))
    tblw.set(qn("w:type"), "dxa")
    new.append(tblw)
    layout = OxmlElement("w:tblLayout")
    layout.set(qn("w:type"), "fixed")
    new.append(layout)
    tbl.replace(tbl.tblPr, new)
    col_w = width / max(1, block.columns)
    for gc in tbl.tblGrid.findall(qn("w:gridCol")):
        gc.set(qn("w:w"), str(_twips(col_w)))
    _merge_spans(table, block)
    for r, row in enumerate(block.rows):
        for c, cell in enumerate(row):
            if cell.covered:
                continue
            target = table.cell(r, c)
            target.width = Pt(col_w * cell.col_span)
            _fill_cell(target, cell, font, layout=True)


def _anchored_picture(doc: Any, item: ImageBlock) -> None:
    """The picture as a floating image at its bbox (relative to the page). The paragraph that
    holds it is a 1-point frame at the same place, so it takes no room in the flow."""
    x0, y0, x1, y1 = item.bbox
    host = _frame_paragraph(doc, (x0, y0, x0 + 1.0, y0 + 1.0), 1.0)
    ox, oy = int(x0 * PT_TO_EMU), int(y0 * PT_TO_EMU)
    width = max(1.0, x1 - x0)
    height = max(1.0, y1 - y0)
    run = host.add_run()
    run.add_picture(
        io.BytesIO(item.asset.data if item.asset else b""), width=Pt(width), height=Pt(height)
    )
    inline = run._r.find(".//" + qn("wp:inline"))
    if inline is None:
        return
    docpr = inline.find(qn("wp:docPr"))
    graphic = inline.find(qn("a:graphic"))
    anchor = parse_xml(
        f'<wp:anchor {nsdecls("wp", "a", "pic", "r")} distT="0" distB="0" distL="0" '
        'distR="0" simplePos="0" relativeHeight="251659264" behindDoc="0" locked="0" '
        'layoutInCell="1" allowOverlap="1">'
        '<wp:simplePos x="0" y="0"/>'
        f'<wp:positionH relativeFrom="page"><wp:posOffset>{ox}</wp:posOffset></wp:positionH>'
        f'<wp:positionV relativeFrom="page"><wp:posOffset>{oy}</wp:posOffset></wp:positionV>'
        f'<wp:extent cx="{int(width * PT_TO_EMU)}" cy="{int(height * PT_TO_EMU)}"/>'
        '<wp:effectExtent l="0" t="0" r="0" b="0"/>'
        "<wp:wrapNone/>"
        "</wp:anchor>"
    )
    if docpr is not None:
        anchor.append(deepcopy(docpr))
    anchor.append(OxmlElement("wp:cNvGraphicFramePr"))
    if graphic is not None:
        anchor.append(deepcopy(graphic))
    drawing = inline.getparent()
    if drawing is not None:
        drawing.remove(inline)
        drawing.append(anchor)


def _layout_items(doc: Any, items: list[Item], font: str, body: float) -> None:
    for item in items:
        if isinstance(item, Heading):
            paragraph = _frame_paragraph(doc, item.bbox, _line_size(item.runs, body))
            paragraph.style = doc.styles[f"Heading {item.level}"]
            write_runs(paragraph, item.runs, font, body, layout=True)
        elif isinstance(item, Para):
            paragraph = _frame_paragraph(doc, item.bbox, _line_size(item.runs, body))
            size = body if item.role == "body" else 9.0
            write_runs(paragraph, item.runs, font, size, layout=True)
        elif isinstance(item, ListBlock):
            _layout_list(doc, item, font, body)
        elif isinstance(item, TableBlock):
            _layout_table(doc, item, font, body)
        elif isinstance(item, ImageBlock):
            if item.asset is None:
                note = _frame_paragraph(doc, item.bbox, body)
                write_runs(note, [Run(text="[Hình không trích được]", italic=True)], font, 9, True)
            else:
                _anchored_picture(doc, item)
            if item.caption:
                x0, _, x1, y1 = item.bbox
                caption = _frame_paragraph(doc, (x0, y1 + 2, x1, y1 + 14), 9.0)
                write_runs(caption, [Run(text=squash(item.caption), italic=True)], font, 9, True)
        elif isinstance(item, Rule):
            _bottom_border(_frame_paragraph(doc, item.bbox, 2.0))


def _layout_list(doc: Any, block: ListBlock, font: str, body: float) -> None:
    """A list is one frame: every item is a paragraph with its marker as text and an indent."""

    def walk(nodes: list[ListNode], depth: int) -> None:
        for number, node in enumerate(nodes, start=1):
            paragraph = _frame_paragraph(doc, block.bbox, body)
            paragraph.paragraph_format.left_indent = Pt(LIST_INDENT_PT * depth)
            marker = node.marker or (f"{number}." if block.ordered else "•")
            write_runs(paragraph, [Run(text=marker + " "), *node.runs], font, body, True)
            walk(node.children, depth + 1)

    walk(block.items, 0)


def _page_groups(ir: DocIR) -> list[tuple[PageMark, list[Item]]]:
    groups: list[tuple[PageMark, list[Item]]] = []
    for item in ir.items:
        if isinstance(item, PageMark):
            groups.append((item, []))
        elif groups:
            groups[-1][1].append(item)
    return groups


def write_layout(ir: DocIR, out: Path) -> ExportResult:
    doc = Document()
    _core(doc, ir)
    font = _normal(doc, ir)
    _heading_styles(doc, ir, font)
    body = ir.body_size or 11.0
    pages = _page_groups(ir)
    for number, (mark, items) in enumerate(pages):
        section = doc.sections[0] if number == 0 else doc.add_section(WD_SECTION.NEW_PAGE)
        section.page_width = Pt(mark.width)
        section.page_height = Pt(mark.height)
        for side in ("left_margin", "right_margin", "top_margin", "bottom_margin"):
            setattr(section, side, Pt(0))
        section.header_distance = Pt(0)
        section.footer_distance = Pt(0)
        _layout_items(doc, items, font, body)
    if not pages:
        doc.add_paragraph()
    atomic_write(out, lambda tmp: doc.save(str(tmp)))
    return _result(ir, out)


def _result(ir: DocIR, out: Path) -> ExportResult:
    return ExportResult(
        outputs=[str(out)],
        warnings=list(ir.warnings),
        stats={
            "blocks": len(ir.items),
            "tables": len(ir.blocks_of(TableBlock)),
            "images": len(ir.blocks_of(ImageBlock)),
            "headings": len(ir.blocks_of(Heading)),
        },
    )


def write_docx(ir: DocIR, out: Path, opts: ExportOptions) -> ExportResult:
    if opts.mode == "layout":
        return write_layout(ir, out)
    return write_editable(ir, out, opts)
