"""OpenDocument text (ODT, T10.04, N4), written by hand with zipfile and xml.

Package: ``mimetype`` (first entry, stored, no compression), ``META-INF/manifest.xml``,
``content.xml`` (body and automatic styles), ``styles.xml`` (named styles: Standard, Heading 1-6,
Furniture, Rule; A4 page), ``meta.xml`` (title, author, language). Pictures under ``Pictures/``.

Headings are ``text:h`` with an outline level and the Heading styles. Runs use automatic text
styles (bold, italic, super/subscript, colour, size). Lists are ``text:list`` with a bullet or a
number list style. Tables are ``table:table`` with the spans as ``table:covered-table-cell``, and
the first row is a header row when the model says so.
"""

from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image as PILImage

from chef_core.export.fonts import installed_name
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
from chef_core.export.text import clean, merge_runs, xml_escape
from chef_core.layout.model import Run
from chef_core.pdf.io import atomic_write_new

# XML templates are clearer as whole string literals.
# ruff: noqa: E501

MIMETYPE = "application/vnd.oasis.opendocument.text"
TEXT_WIDTH_CM = 16.0
PT_TO_CM = 2.54 / 72
SAFE_URL = re.compile(r"^https?://\S+$")
NS = (
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" '
    'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" '
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" '
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" '
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" '
    'xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" '
    'xmlns:xlink="http://www.w3.org/1999/xlink" '
    'xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" '
    'xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0" '
    'xmlns:dc="http://purl.org/dc/elements/1.1/" '
    'xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"'
)
XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n'
SPACES = re.compile(r" {2,}")
HEADING_SIZES = {1: 20, 2: 16, 3: 14, 4: 12, 5: 11, 6: 10.5}


def _text(value: str) -> str:
    """Escaped text with the spacing ODF keeps: a run of spaces is one space and ``text:s``."""
    escaped = xml_escape(value)

    def spaces(match: re.Match[str]) -> str:
        return " " + "<text:s/>" * (len(match.group(0)) - 1)

    return (
        SPACES.sub(spaces, escaped).replace("\t", "<text:tab/>").replace("\n", "<text:line-break/>")
    )


@dataclass
class _Spans:
    names: dict[tuple[object, ...], str] = field(default_factory=dict)

    def name_of(self, run: Run) -> str | None:
        colour = run.color if run.color and run.color.lower() != "#000000" else None
        key: tuple[object, ...] = (run.bold, run.italic, run.sup, run.sub, colour, run.size)
        if key == (False, False, False, False, None, None):
            return None
        if key not in self.names:
            self.names[key] = f"T{len(self.names) + 1}"
        return self.names[key]

    def xml(self) -> str:
        out: list[str] = []
        for key, name in self.names.items():
            bold, italic, sup, sub, colour, size = key
            props = []
            if bold:
                props.append('fo:font-weight="bold" style:font-weight-asian="bold"')
            if italic:
                props.append('fo:font-style="italic" style:font-style-asian="italic"')
            if sup:
                props.append('style:text-position="super 58%"')
            elif sub:
                props.append('style:text-position="sub 58%"')
            if colour:
                props.append(f'fo:color="{xml_escape(str(colour))}"')
            if size:
                props.append(f'fo:font-size="{float(str(size)):g}pt"')
            out.append(
                f'<style:style style:name="{name}" style:family="text">'
                f"<style:text-properties {' '.join(props)}/></style:style>"
            )
        return "".join(out)


class _Body:
    def __init__(self) -> None:
        self.spans = _Spans()
        self.pictures: list[tuple[str, bytes]] = []
        self.tables = 0
        self.col_widths: set[int] = set()

    def inline(self, runs: list[Run]) -> str:
        out: list[str] = []
        for run in merge_runs(runs):
            text = _text(run.text)
            name = self.spans.name_of(run)
            if name:
                text = f'<text:span text:style-name="{name}">{text}</text:span>'
            if run.link and SAFE_URL.match(run.link):
                text = f'<text:a xlink:type="simple" xlink:href="{xml_escape(run.link)}">{text}</text:a>'
            out.append(text)
        return "".join(out)

    def para(self, runs: list[Run], style: str = "Standard") -> str:
        return f'<text:p text:style-name="{style}">{self.inline(runs)}</text:p>'

    def list(self, nodes: list[ListNode], ordered: bool) -> str:
        style = "LNumber" if ordered else "LBullet"
        items = []
        for node in nodes:
            inner = self.para(node.runs)
            if node.children:
                inner += self.list(node.children, ordered)
            items.append(f"<text:list-item>{inner}</text:list-item>")
        return f'<text:list text:style-name="{style}">' + "".join(items) + "</text:list>"

    def cell(self, cell: CellIR) -> str:
        if cell.covered:
            return "<table:covered-table-cell/>"
        attrs = ""
        if cell.col_span > 1:
            attrs += f' table:number-columns-spanned="{cell.col_span}"'
        if cell.row_span > 1:
            attrs += f' table:number-rows-spanned="{cell.row_span}"'
        paras = "".join(self.para(p) for p in cell.paras) or '<text:p text:style-name="Standard"/>'
        return f'<table:table-cell table:style-name="Cell"{attrs}>{paras}</table:table-cell>'

    def table(self, block: TableBlock) -> str:
        self.tables += 1
        self.col_widths.add(block.columns)
        head = ""
        rows = block.rows
        body_rows = rows
        if block.rows and block.header:
            head = "<table:table-header-rows>" + _row(rows[0], self) + "</table:table-header-rows>"
            body_rows = rows[1:]
        body = "".join(_row(r, self) for r in body_rows)
        cols = f'<table:table-column table:style-name="Col{block.columns}" table:number-columns-repeated="{block.columns}"/>'
        return (
            f'<table:table table:name="Bảng {self.tables}" table:style-name="Tbl">'
            f"{cols}{head}{body}</table:table>"
        )

    def picture(self, item: ImageBlock) -> str:
        if item.asset is None:
            return self.para([Run(text="[Hình không trích được]")], "Furniture")
        ext = "jpg" if item.asset.ext == "jpg" else "png"
        name = f"Pictures/img-{len(self.pictures) + 1:03d}.{ext}"
        self.pictures.append((name, item.asset.data))
        width, height = _picture_size(item)
        frame = (
            f'<draw:frame draw:name="img{len(self.pictures)}" text:anchor-type="as-char" '
            f'svg:width="{width:.2f}cm" svg:height="{height:.2f}cm" draw:z-index="0">'
            f'<draw:image xlink:href="{name}" xlink:type="simple" xlink:show="embed" '
            'xlink:actuate="onLoad"/></draw:frame>'
        )
        return f'<text:p text:style-name="Standard">{frame}</text:p>'


def _row(cells: list[CellIR], body: _Body) -> str:
    return "<table:table-row>" + "".join(body.cell(c) for c in cells) + "</table:table-row>"


def _picture_size(item: ImageBlock) -> tuple[float, float]:
    width = item.width * PT_TO_CM
    height = item.height * PT_TO_CM
    if width <= 0 or height <= 0:
        width, height = 8.0, 8.0
        if item.asset is not None:
            with PILImage.open(io.BytesIO(item.asset.data)) as im:
                width, height = 8.0, 8.0 * im.size[1] / max(1, im.size[0])
    if width > TEXT_WIDTH_CM:
        height *= TEXT_WIDTH_CM / width
        width = TEXT_WIDTH_CM
    return width, height


def _content(ir: DocIR) -> tuple[str, list[tuple[str, bytes]]]:
    body = _Body()
    parts: list[str] = []
    for item in ir.items:
        if isinstance(item, PageMark):
            continue
        if isinstance(item, Heading):
            parts.append(
                f'<text:h text:style-name="Heading_20_{item.level}" '
                f'text:outline-level="{item.level}">{body.inline(item.runs)}</text:h>'
            )
        elif isinstance(item, Para):
            style = {"body": "Standard", "footnote": "Furniture", "unknown": "Standard"}.get(
                item.role, "Furniture" if item.role != "caption" else "Caption"
            )
            parts.append(body.para(item.runs, style))
        elif isinstance(item, ListBlock):
            parts.append(body.list(item.items, item.ordered))
        elif isinstance(item, TableBlock):
            parts.append(body.table(item))
            parts.append('<text:p text:style-name="Standard"/>')
        elif isinstance(item, ImageBlock):
            parts.append(body.picture(item))
            if item.caption:
                parts.append(body.para([Run(text=clean(item.caption))], "Caption"))
        elif isinstance(item, Rule):
            parts.append('<text:p text:style-name="Rule"/>')
    tables_styles = "".join(
        f'<style:style style:name="Col{n}" style:family="table-column">'
        f'<style:table-column-properties style:column-width="{TEXT_WIDTH_CM / n:.2f}cm"/>'
        "</style:style>"
        for n in sorted(body.col_widths)
    )
    automatic = (
        body.spans.xml() + tables_styles + '<style:style style:name="Tbl" style:family="table">'
        f'<style:table-properties style:width="{TEXT_WIDTH_CM:.2f}cm" table:align="margins"/>'
        "</style:style>"
        '<style:style style:name="Cell" style:family="table-cell">'
        '<style:table-cell-properties fo:padding="0.1cm" fo:border="0.5pt solid #888888"/>'
        "</style:style>"
        '<text:list-style style:name="LBullet">'
        '<text:list-level-style-bullet text:level="1" text:bullet-char="•">'
        '<style:list-level-properties text:space-before="0.5cm" text:min-label-width="0.5cm"/>'
        "</text:list-level-style-bullet>"
        '<text:list-level-style-bullet text:level="2" text:bullet-char="–">'
        '<style:list-level-properties text:space-before="1cm" text:min-label-width="0.5cm"/>'
        "</text:list-level-style-bullet></text:list-style>"
        '<text:list-style style:name="LNumber">'
        '<text:list-level-style-number text:level="1" style:num-format="1" style:num-suffix=".">'
        '<style:list-level-properties text:space-before="0.5cm" text:min-label-width="0.6cm"/>'
        "</text:list-level-style-number>"
        '<text:list-level-style-number text:level="2" style:num-format="a" style:num-suffix=".">'
        '<style:list-level-properties text:space-before="1cm" text:min-label-width="0.6cm"/>'
        "</text:list-level-style-number></text:list-style>"
        '<style:style style:name="Rule" style:family="paragraph" style:parent-style-name="Standard">'
        '<style:paragraph-properties fo:border-bottom="0.5pt solid #888888" fo:margin-bottom="0.3cm"/>'
        "</style:style>"
    )
    xml = (
        XML_HEAD
        + f'<office:document-content {NS} office:version="1.2">'
        + "<office:automatic-styles>"
        + automatic
        + "</office:automatic-styles><office:body><office:text>"
        + "".join(parts)
        + "</office:text></office:body></office:document-content>\n"
    )
    return xml, body.pictures


def _styles(ir: DocIR) -> str:
    body_font = installed_name(ir.body_font)
    body_size = ir.body_size or 11.0
    heads = "".join(
        f'<style:style style:name="Heading_20_{n}" style:display-name="Heading {n}" '
        'style:family="paragraph" style:parent-style-name="Heading" '
        'style:default-outline-level="' + str(n) + '">'
        f'<style:text-properties fo:font-size="{float(ir.heading_sizes.get(n, HEADING_SIZES[n])):g}pt" '
        'fo:font-weight="bold"/></style:style>'
        for n in range(1, 7)
    )
    return (
        XML_HEAD
        + f'<office:document-styles {NS} office:version="1.2">'
        + "<office:font-face-decls>"
        + f'<style:font-face style:name="{xml_escape(body_font)}" svg:font-family="{xml_escape(body_font)}"/>'
        + "</office:font-face-decls><office:styles>"
        + '<style:default-style style:family="paragraph">'
        + f'<style:text-properties style:font-name="{xml_escape(body_font)}" fo:font-size="{body_size:g}pt" '
        + 'fo:language="vi" fo:country="VN" style:font-name-asian="'
        + xml_escape(body_font)
        + '"/>'
        + "</style:default-style>"
        + '<style:style style:name="Standard" style:family="paragraph" style:class="text">'
        + '<style:paragraph-properties fo:margin-top="0cm" fo:margin-bottom="0.2cm"/></style:style>'
        + '<style:style style:name="Heading" style:family="paragraph" style:parent-style-name="Standard" '
        + 'style:class="text"><style:paragraph-properties fo:margin-top="0.4cm" fo:margin-bottom="0.2cm" '
        + 'fo:keep-with-next="always"/><style:text-properties fo:font-weight="bold"/></style:style>'
        + heads
        + '<style:style style:name="Caption" style:family="paragraph" style:parent-style-name="Standard">'
        + '<style:text-properties fo:font-size="9pt" fo:color="#555555"/></style:style>'
        + '<style:style style:name="Furniture" style:family="paragraph" style:parent-style-name="Standard">'
        + '<style:text-properties fo:font-size="9pt" fo:color="#666666"/></style:style>'
        + "</office:styles>"
        + '<office:automatic-styles><style:page-layout style:name="pm1">'
        + '<style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm" '
        + 'fo:margin-top="2cm" fo:margin-bottom="2cm" fo:margin-left="2.5cm" fo:margin-right="2.5cm"/>'
        + "</style:page-layout></office:automatic-styles>"
        + '<office:master-styles><style:master-page style:name="Standard" '
        + 'style:page-layout-name="pm1"/></office:master-styles>'
        + "</office:document-styles>\n"
    )


def _meta(ir: DocIR) -> str:
    title = f"<dc:title>{xml_escape(ir.title)}</dc:title>" if ir.title else ""
    author = (
        f"<meta:initial-creator>{xml_escape(ir.author)}</meta:initial-creator>" if ir.author else ""
    )
    return (
        XML_HEAD
        + f'<office:document-meta {NS} office:version="1.2"><office:meta>'
        + title
        + author
        + f"<dc:language>{xml_escape(ir.language)}</dc:language>"
        + "<meta:generator>Chef PDF</meta:generator>"
        + "</office:meta></office:document-meta>\n"
    )


def _manifest(pictures: list[tuple[str, bytes]]) -> str:
    entries = [
        '<manifest:file-entry manifest:full-path="/" manifest:version="1.2" '
        f'manifest:media-type="{MIMETYPE}"/>',
        '<manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/>',
        '<manifest:file-entry manifest:full-path="styles.xml" manifest:media-type="text/xml"/>',
        '<manifest:file-entry manifest:full-path="meta.xml" manifest:media-type="text/xml"/>',
    ]
    for name, _ in pictures:
        mime = "image/jpeg" if name.endswith(".jpg") else "image/png"
        entries.append(
            f'<manifest:file-entry manifest:full-path="{name}" manifest:media-type="{mime}"/>'
        )
    return (
        XML_HEAD
        + f'<manifest:manifest manifest:version="1.2" {NS}>'
        + "".join(entries)
        + "</manifest:manifest>\n"
    )


def build_odt(ir: DocIR) -> bytes:
    content, pictures = _content(ir)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(zipfile.ZipInfo("mimetype"), MIMETYPE, compress_type=zipfile.ZIP_STORED)
        zf.writestr(
            "META-INF/manifest.xml", _manifest(pictures), compress_type=zipfile.ZIP_DEFLATED
        )
        zf.writestr("content.xml", content, compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("styles.xml", _styles(ir), compress_type=zipfile.ZIP_DEFLATED)
        zf.writestr("meta.xml", _meta(ir), compress_type=zipfile.ZIP_DEFLATED)
        for name, data in pictures:
            zf.writestr(name, data, compress_type=zipfile.ZIP_DEFLATED)
    return buf.getvalue()


def write_odt(ir: DocIR, out: Path) -> ExportResult:
    data = build_odt(ir)

    def write(tmp: Path) -> None:
        tmp.write_bytes(data)

    atomic_write_new(out, write)
    return ExportResult(
        outputs=[str(out)],
        warnings=list(ir.warnings),
        stats={"blocks": len(ir.items), "tables": sum(isinstance(i, TableBlock) for i in ir.items)},
    )


__all__ = ["Item", "build_odt", "write_odt"]
