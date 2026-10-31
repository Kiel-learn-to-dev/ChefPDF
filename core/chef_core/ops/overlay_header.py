"""Header, footer and page numbers (T4.07): overlay.headerFooter (F7) and overlay.pageNumbers (F8).

Both draw text with the overlay engine, one marked chunk per zone and page, so F12 can list and
remove them (kinds ``header``, ``footer`` and ``number``). Templates use the variables of
``chef_core.overlay.variables`` (``{page}``, ``{pages}``, ``{date}``, ``{bates}``...).

Numbering: the number of a page is its 0-based index plus ``startNumber``. ``skipFirst`` and
``skipPages`` only leave pages unprinted; the numbers of the other pages do not move.

The ``nd30`` preset applies Nghị định 30/2020/NĐ-CP: Arabic numerals, centred in the top margin,
nothing on the first page, 13 pt Be Vietnam Pro (the bundled face; Times is not bundled). It
overrides the template, number format, position, skipFirst and font size of the request.

Page labels (``writeLabels``) store only the number format and start, so viewers show the same
numbers. They are set on the whole document and are not part of the overlay list.
"""

from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Sequence
from typing import Literal

import pikepdf
from pikepdf import Array, Dictionary, Name
from pydantic import Field, model_validator

from chef_core.errors import invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.ops.overlay import HexColor, PageIndex, PageSelection, hex_color, page_selection
from chef_core.overlay.engine import OverlayWriter, Placement, TextStyle
from chef_core.overlay.pagecontent import page_frame
from chef_core.overlay.variables import DocVars, NumberFormat, check_template
from chef_core.pdf.pages import check_indices
from chef_core.signing.anchors import PageFrame

FontName = Literal["BeVietnamPro"]
NumberPosition = Literal[
    "top-left",
    "top-center",
    "top-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
    "outside-alternating",
]
Zone = Literal["left", "center", "right"]
MAX_TEMPLATE = 500
MAX_SECTIONS = 500
ND30_FONT_SIZE = 13.0
PAGE_LABEL_STYLE: dict[NumberFormat, str] = {
    "arabic": "D",
    "roman": "r",
    "ROMAN": "R",
    "alpha": "a",
    "ALPHA": "A",
}
NUMBER_ALIGN: dict[str, Literal["left", "center", "right"]] = {
    "top-left": "left",
    "bottom-left": "left",
    "top-center": "center",
    "bottom-center": "center",
    "top-right": "right",
    "bottom-right": "right",
}
_MIRRORED_ZONE: dict[Zone, Zone] = {"left": "right", "center": "center", "right": "left"}


# -- parameter parts --------------------------------------------------------------------


class Margins(WireModel):
    """Distances from the page edges, in millimetres, on the displayed page."""

    top: float = Field(default=10.0, ge=0, le=200)
    bottom: float = Field(default=10.0, ge=0, le=200)
    left: float = Field(default=20.0, ge=0, le=200)
    right: float = Field(default=20.0, ge=0, le=200)


class TextZones(WireModel):
    """Up to three zones of one band (header or footer). Each zone is a template."""

    left: str = Field(default="", max_length=MAX_TEMPLATE)
    center: str = Field(default="", max_length=MAX_TEMPLATE)
    right: str = Field(default="", max_length=MAX_TEMPLATE)

    def filled(self) -> list[tuple[Zone, str]]:
        pairs: list[tuple[Zone, str]] = [
            ("left", self.left),
            ("center", self.center),
            ("right", self.right),
        ]
        return [(zone, text) for zone, text in pairs if text]


class Section(WireModel):
    page: PageIndex = Field(description="0-based page where the section starts.")
    title: str = Field(min_length=1, max_length=200)


class HeaderFooterParams(PageSelection):
    """Header and footer text on the selected pages. Each band has left, centre and right zones.
    Variables: {page} {pages} {page_roman} {page_alpha} {date} {time} {filename} {title}
    {author} {bates} {section}; ``{{`` writes a brace. ``mirrorOddEven`` swaps the left and right
    zones (and their margins) on even pages, for two-sided printing."""

    header: TextZones | None = Field(default=None)
    footer: TextZones | None = Field(default=None)
    margins: Margins = Field(default_factory=Margins)
    font_name: FontName = Field(default="BeVietnamPro")
    font_size: float = Field(default=10.0, gt=0, le=200)
    bold: bool = Field(default=False)
    color: HexColor = Field(default="#000000")
    opacity: float = Field(default=1.0, ge=0, le=1)
    date_format: str = Field(default="dd/MM/yyyy", min_length=1, max_length=40)
    skip_first: bool = Field(default=False, description="Leave the first page alone.")
    start_number: int = Field(default=1, ge=0, le=1_000_000_000)
    mirror_odd_even: bool = Field(default=False)
    sections: list[Section] | None = Field(default=None, max_length=MAX_SECTIONS)
    bates_prefix: str = Field(default="", max_length=40)
    bates_suffix: str = Field(default="", max_length=40)
    bates_digits: int = Field(default=6, ge=1, le=20)

    @model_validator(mode="after")
    def _one_band(self) -> HeaderFooterParams:
        if self.header is None and self.footer is None:
            raise ValueError("give a header, a footer or both")
        return self


class PageNumbersParams(PageSelection):
    """Page numbers. ``template`` may hold other variables; {page} and {pages} use
    ``numberFormat``. ``preset: nd30`` applies the Nghị định 30/2020/NĐ-CP rule (see module)."""

    preset: Literal["nd30"] | None = Field(default=None)
    number_format: Literal["arabic", "roman", "ROMAN", "alpha", "ALPHA"] = Field(default="arabic")
    template: str = Field(default="{page}", min_length=1, max_length=MAX_TEMPLATE)
    position: NumberPosition = Field(default="bottom-center")
    margins: Margins = Field(default_factory=Margins)
    font_name: FontName = Field(default="BeVietnamPro")
    font_size: float = Field(default=12.0, gt=0, le=200)
    bold: bool = Field(default=False)
    color: HexColor = Field(default="#000000")
    opacity: float = Field(default=1.0, ge=0, le=1)
    start_number: int = Field(default=1, ge=0, le=1_000_000_000)
    skip_first: bool = Field(default=False)
    skip_pages: list[PageIndex] | None = Field(default=None, max_length=100_000)
    write_labels: bool = Field(default=False, description="Also set /PageLabels on the document.")
    date_format: str = Field(default="dd/MM/yyyy", min_length=1, max_length=40)


# -- helpers ----------------------------------------------------------------------------


def _info_text(pdf: pikepdf.Pdf, key: str) -> str:
    info = pdf.trailer.get("/Info")
    if not isinstance(info, pikepdf.Dictionary):
        return ""
    value = info.get(f"/{key}")
    return str(value) if isinstance(value, pikepdf.String) else ""


def document_vars(
    pdf: pikepdf.Pdf,
    *,
    doc_name: str,
    start_number: int,
    date_format: str,
    sections: Sequence[tuple[int, str]] = (),
    bates_prefix: str = "",
    bates_suffix: str = "",
    bates_digits: int = 6,
) -> DocVars:
    """Document-level variable values for one open document (metadata is read here)."""
    return DocVars(
        filename=doc_name,
        title=_info_text(pdf, "Title"),
        author=_info_text(pdf, "Author"),
        page_count=len(pdf.pages),
        start_number=start_number,
        date_format=date_format,
        now=dt.datetime.now(dt.UTC).astimezone(),
        sections=tuple(sections),
        bates_prefix=bates_prefix,
        bates_suffix=bates_suffix,
        bates_digits=bates_digits,
    )


def _commit(
    ctx: OpContext, pdf: pikepdf.Pdf, writers: Sequence[OverlayWriter], *, force_save: bool = False
) -> OpOutput:
    pages: set[int] = set()
    for writer in writers:
        writer.commit()
        pages.update(writer.pages)
    if pages or force_save:
        ctx.save_document(pdf)
    return OpOutput(
        changed_pages=sorted(pages),
        data={"overlayIds": [w.overlay_id for w in writers if w.pages]},
    )


def zone_placement(
    zone: Zone,
    frame: PageFrame,
    margins: Margins,
    *,
    footer: bool,
    mirror: bool,
    opacity: float,
) -> Placement:
    """Where a header or footer zone goes. ``mirror`` swaps left and right, with their margins."""
    width, height = frame.display_size
    left = margins.left
    right = margins.right
    if mirror:
        left, right = right, left
        zone = _MIRRORED_ZONE[zone]
    vertical = "bottom" if footer else "top"
    y = height - _mm(margins.bottom) if footer else _mm(margins.top)
    if zone == "left":
        return Placement(x=_mm(left), y=y, anchor=f"{vertical}-left", opacity=opacity)
    if zone == "right":
        return Placement(x=width - _mm(right), y=y, anchor=f"{vertical}-right", opacity=opacity)
    return Placement(x=width / 2, y=y, anchor=f"{vertical}-center", opacity=opacity)


def number_placement(
    position: str, frame: PageFrame, margins: Margins, index: int, opacity: float
) -> Placement:
    """Where a page number goes. ``outside-alternating``: odd pages right, even pages left."""
    width, height = frame.display_size
    if position == "outside-alternating":
        position = "bottom-right" if index % 2 == 0 else "bottom-left"
    vertical, horizontal = position.split("-", 1)
    y = height - _mm(margins.bottom) if vertical == "bottom" else _mm(margins.top)
    if horizontal == "left":
        x = _mm(margins.left)
    elif horizontal == "right":
        x = width - _mm(margins.right)
    else:
        x = width / 2
    return Placement(x=x, y=y, anchor=f"{vertical}-{horizontal}", opacity=opacity)


def _mm(value: float) -> float:
    return value * 72.0 / 25.4


# -- overlay.headerFooter ---------------------------------------------------------------


@operation(
    id="overlay.headerFooter",
    title="Header and footer",
    group="overlay",
    params=HeaderFooterParams,
    destructive=True,
    batchable=True,
)
def header_footer(ctx: OpContext, p: HeaderFooterParams) -> OpOutput:
    bands = [(p.header, False), (p.footer, True)]
    for band, _footer in bands:
        if band is not None:
            for _zone, template in band.filled():
                check_template(template)
    color = hex_color(p.color)
    with ctx.open_input() as pdf:
        count = len(pdf.pages)
        pages = page_selection(p.pages, p.page_range, count)
        if p.skip_first:
            pages = [i for i in pages if i != 0]
        if not pages:
            raise invalid_params("No pages left to print on", {"field": "skipFirst"})
        sections = [(s.page, s.title) for s in p.sections or []]
        check_indices([start for start, _ in sections], count, "sections")
        values = document_vars(
            pdf,
            doc_name=ctx.doc_name,
            start_number=p.start_number,
            date_format=p.date_format,
            sections=sections,
            bates_prefix=p.bates_prefix,
            bates_suffix=p.bates_suffix,
            bates_digits=p.bates_digits,
        )
        group = uuid.uuid4().hex
        writers: list[OverlayWriter] = []
        targets: list[tuple[TextZones, OverlayWriter, bool]] = []
        for band, footer in bands:
            if band is None:
                continue
            kind = "footer" if footer else "header"
            writer = OverlayWriter(pdf, kind=kind, group=group, warn=ctx.warn)
            writers.append(writer)
            targets.append((band, writer, footer))
        for index in ctx.steps(pages, len(pages), "Adding header and footer"):
            frame = page_frame(pdf.pages[index])
            mirror = p.mirror_odd_even and index % 2 == 1
            for band, writer, footer in targets:
                for zone, template in band.filled():
                    text = values.render(template, index)
                    if not text:
                        continue
                    piece = writer.text(
                        text,
                        TextStyle(
                            font_family=p.font_name,
                            font_size=p.font_size,
                            bold=p.bold,
                            color=color,
                            align=zone,
                        ),
                    )
                    placement = zone_placement(
                        zone, frame, p.margins, footer=footer, mirror=mirror, opacity=p.opacity
                    )
                    writer.place(index, piece, placement)
        return _commit(ctx, pdf, writers)


# -- overlay.pageNumbers ----------------------------------------------------------------


@operation(
    id="overlay.pageNumbers",
    title="Page numbers",
    group="overlay",
    params=PageNumbersParams,
    destructive=True,
    batchable=True,
)
def page_numbers(ctx: OpContext, p: PageNumbersParams) -> OpOutput:
    template, number_format, position = p.template, p.number_format, p.position
    font_name, font_size, skip_first = p.font_name, p.font_size, p.skip_first
    if p.preset == "nd30":
        # Nghị định 30/2020/NĐ-CP: Arabic numerals, top centre, nothing on the first page.
        template, number_format, position = "{page}", "arabic", "top-center"
        font_name, font_size, skip_first = "BeVietnamPro", ND30_FONT_SIZE, True
    check_template(template)
    if p.write_labels and p.start_number < 1:
        raise invalid_params(
            "writeLabels needs startNumber of at least 1", {"field": "startNumber"}
        )
    color = hex_color(p.color)
    with ctx.open_input() as pdf:
        count = len(pdf.pages)
        pages = page_selection(p.pages, p.page_range, count)
        if p.skip_pages:
            skipped = set(check_indices(p.skip_pages, count, "skipPages"))
            pages = [i for i in pages if i not in skipped]
        if skip_first:
            pages = [i for i in pages if i != 0]
        if not pages and not p.write_labels:
            raise invalid_params("No pages left to number", {"field": "pages"})
        values = document_vars(
            pdf, doc_name=ctx.doc_name, start_number=p.start_number, date_format=p.date_format
        )
        writer = OverlayWriter(
            pdf, kind="number", group=uuid.uuid4().hex, label="Đánh số trang", warn=ctx.warn
        )
        align = NUMBER_ALIGN.get(position, "center")
        for index in ctx.steps(pages, len(pages), "Numbering pages"):
            frame = page_frame(pdf.pages[index])
            text = values.render(template, index, number_format=number_format)
            if not text:
                continue
            piece = writer.text(
                text,
                TextStyle(
                    font_family=font_name,
                    font_size=font_size,
                    bold=p.bold,
                    color=color,
                    align=align,
                ),
            )
            placement = number_placement(position, frame, p.margins, index, p.opacity)
            writer.place(index, piece, placement)
        if p.write_labels:
            pdf.Root.PageLabels = Dictionary(
                Nums=Array(
                    [
                        0,
                        Dictionary(
                            S=Name(f"/{PAGE_LABEL_STYLE[number_format]}"), St=p.start_number
                        ),
                    ]
                )
            )
        return _commit(ctx, pdf, [writer], force_save=p.write_labels)
