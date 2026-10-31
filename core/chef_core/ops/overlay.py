"""Overlay operations (group overlay): add text (D1), add image (D2), watermark (F1), letterhead
(F11), and list and remove what Chef PDF added (F12).

Every op that writes to the document is destructive: it rewrites page content, so a signed
document refuses it (BLOCKED_BY_SIGNATURE). Listing is read-only.

Units: positions and sizes are in ``unit`` (``pt`` or ``mm``), measured on the displayed page
(after /Rotate and CropBox). Watermark sizes are always points.
"""

from __future__ import annotations

import math
import uuid
from pathlib import Path
from typing import Annotated, Literal

import pikepdf
from pydantic import Field, model_validator

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.ops.file import parse_ranges
from chef_core.overlay.engine import (
    OverlayWriter,
    Piece,
    Placement,
    Resources,
    TextStyle,
    image_piece,
    letterhead_matrix,
    make_form,
    page_centre_matrix,
    text_piece,
    tiled_body,
)
from chef_core.overlay.images import PX_TO_PT
from chef_core.overlay.pagecontent import page_frame
from chef_core.overlay.registry import list_overlays, remove_overlays
from chef_core.pdf.io import open_pdf
from chef_core.pdf.pages import check_indices

PageIndex = Annotated[int, Field(ge=0)]
Points = Annotated[float, Field(gt=0, le=14400)]
HexColor = Annotated[str, Field(pattern=r"^#[0-9A-Fa-f]{6}$")]
Unit = Literal["pt", "mm"]
Anchor = Literal[
    "top-left",
    "top-center",
    "top-right",
    "center-left",
    "center",
    "center-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
]
FontName = Literal["BeVietnamPro"]
Kind = Literal[
    "text",
    "image",
    "watermark",
    "stamp",
    "header",
    "footer",
    "number",
    "qr",
    "letterhead",
]
MM_TO_PT = 72.0 / 25.4
WATERMARK_IMAGE_WIDTH = 300.0
DEFAULT_WATERMARK_COLOR = (0.5, 0.5, 0.5)
MIN_OPACITY = 0.0
MAX_TEXT = 20_000


# -- shared parameter parts ---------------------------------------------------------------


class PageSelection(WireModel):
    """Pages to change. ``pages`` (0-based) and ``pageRange`` (1-based, "1-3,5,odd,even") are
    combined. Neither given means every page."""

    pages: list[PageIndex] | None = Field(
        default=None, min_length=1, description="0-based pages; default all."
    )
    page_range: str | None = Field(
        default=None,
        min_length=1,
        max_length=200,
        description='1-based ranges such as "1-3,5,7-" or "odd" / "even" / "all".',
    )


class Placed(WireModel):
    """Where an object goes. ``x``/``y`` are the anchor point from the top-left of the displayed
    page, in ``unit``."""

    x: float = Field(description="Anchor point, from the left edge of the displayed page.")
    y: float = Field(description="Anchor point, from the top edge of the displayed page.")
    unit: Unit = Field(default="pt")
    anchor: Anchor = Field(default="top-left", description="Which point of the object is at x, y.")
    rotation: float = Field(default=0.0, ge=-360, le=360, description="Degrees, counter-clockwise.")
    opacity: float = Field(default=1.0, ge=MIN_OPACITY, le=1.0)
    under: bool = Field(default=False, description="True puts it beneath the page content.")


class AddTextParams(PageSelection, Placed):
    """Add a text box. Line breaks in ``text`` are kept; ``width`` wraps lines to a box width."""

    text: str = Field(min_length=1, max_length=MAX_TEXT)
    font_name: FontName = Field(default="BeVietnamPro")
    font_size: float = Field(default=12.0, gt=0, le=400)
    bold: bool = Field(default=False)
    color: HexColor = Field(default="#000000")
    align: Literal["left", "center", "right"] = Field(default="left")
    line_height: float = Field(default=1.2, gt=0, le=5)
    width: float | None = Field(default=None, gt=0, description="Box width in unit; wraps lines.")


@operation(
    id="overlay.addText",
    title="Add text",
    group="overlay",
    params=AddTextParams,
    destructive=True,
    batchable=True,
)
def add_text(ctx: OpContext, p: AddTextParams) -> OpOutput:
    with ctx.open_input() as pdf:
        pages = page_selection(p.pages, p.page_range, len(pdf.pages))
        writer = OverlayWriter(pdf, kind="text", group=_new_id(), warn=ctx.warn)
        style = TextStyle(
            font_family=p.font_name,
            font_size=p.font_size,
            bold=p.bold,
            color=hex_color(p.color),
            align=p.align,
            line_height=p.line_height,
        )
        width = to_points(p.width, p.unit) if p.width is not None else None
        piece = writer.text(p.text, style, width=width)
        placement = _placement(p)
        for index in ctx.steps(pages, len(pages), "Adding text"):
            writer.place(index, piece, placement, under=p.under)
        return _finish(ctx, pdf, writer)


class AddImageParams(PageSelection, Placed):
    """Add a PNG or JPEG. Give ``width`` or ``height`` (the other follows the aspect ratio, both
    fit inside), or ``scale`` (1.0 = natural size at 96 dpi). Default width is 150 pt."""

    path: str = Field(min_length=1, description="Absolute path of the image file.")
    width: float | None = Field(default=None, gt=0)
    height: float | None = Field(default=None, gt=0)
    scale: float | None = Field(default=None, gt=0, le=20)

    @model_validator(mode="after")
    def _one_size(self) -> AddImageParams:
        if self.scale is not None and (self.width is not None or self.height is not None):
            raise ValueError("give either scale or width/height, not both")
        return self


@operation(
    id="overlay.addImage",
    title="Add image",
    group="overlay",
    params=AddImageParams,
    destructive=True,
    batchable=True,
)
def add_image(ctx: OpContext, p: AddImageParams) -> OpOutput:
    raw = _read_file(p.path)
    with ctx.open_input() as pdf:
        pages = page_selection(p.pages, p.page_range, len(pdf.pages))
        writer = OverlayWriter(pdf, kind="image", group=_new_id(), warn=ctx.warn)
        width = to_points(p.width, p.unit) if p.width is not None else None
        height = to_points(p.height, p.unit) if p.height is not None else None
        if p.scale is not None:
            natural = writer.doc.image(raw)
            width = natural.width_px * PX_TO_PT * p.scale
        piece = writer.image(raw, width=width, height=height)
        placement = _placement(p)
        for index in ctx.steps(pages, len(pages), "Adding image"):
            writer.place(index, piece, placement, under=p.under)
        return _finish(ctx, pdf, writer)


# -- watermark (F1) ------------------------------------------------------------------------


class WatermarkParams(PageSelection):
    """A text or image watermark, rotated and faint by default. ``mode`` ``center`` puts one copy
    in the middle of each page; ``tiled`` repeats it over the page with ``spacing`` points
    between copies. Sizes and spacing are in points."""

    text: str | None = Field(default=None, min_length=1, max_length=500)
    path: str | None = Field(default=None, min_length=1)
    font_name: FontName = Field(default="BeVietnamPro")
    font_size: float = Field(default=60.0, gt=0, le=400)
    bold: bool = Field(default=False)
    color: HexColor = Field(default="#808080")
    opacity: float = Field(default=0.25, ge=MIN_OPACITY, le=1.0)
    rotation: float = Field(default=45.0, ge=-360, le=360)
    mode: Literal["center", "tiled"] = Field(default="center")
    spacing: float = Field(default=60.0, ge=0, le=2000)
    width: float | None = Field(default=None, gt=0, description="Image width in points.")
    height: float | None = Field(default=None, gt=0, description="Image height in points.")
    under: bool = Field(default=False)

    @model_validator(mode="after")
    def _one_source(self) -> WatermarkParams:
        if (self.text is None) == (self.path is None):
            raise ValueError("give exactly one of text or path")
        return self


@operation(
    id="overlay.watermark",
    title="Add watermark",
    group="overlay",
    params=WatermarkParams,
    destructive=True,
    batchable=True,
)
def watermark(ctx: OpContext, p: WatermarkParams) -> OpOutput:
    with ctx.open_input() as pdf:
        pages = page_selection(p.pages, p.page_range, len(pdf.pages))
        writer = OverlayWriter(
            pdf, kind="watermark", group=_new_id(), label=_label(p), warn=ctx.warn
        )
        form_res = Resources(prefix="")
        if p.text is not None:
            style = TextStyle(
                font_family=p.font_name,
                font_size=p.font_size,
                bold=p.bold,
                color=hex_color(p.color),
                align="center",
            )
            piece = text_piece(form_res, writer.doc, p.text, style, warn=ctx.warn)
        else:
            raw = _read_file(p.path or "")
            width = p.width
            if width is None and p.height is None:
                width = WATERMARK_IMAGE_WIDTH
            piece = image_piece(form_res, writer.doc, raw, width=width, height=p.height)
        extent = _extent(pdf, pages, piece)
        body = tiled_body(
            piece,
            res=form_res,
            doc=writer.doc,
            mode=p.mode,
            spacing=p.spacing,
            rotation=p.rotation,
            opacity=p.opacity,
            extent=extent,
        )
        form = make_form(pdf, body, (-extent, -extent, extent, extent), form_res)
        for index in ctx.steps(pages, len(pages), "Adding watermark"):
            matrix = page_centre_matrix(page_frame(pdf.pages[index]))
            writer.place_form(index, form, matrix, under=p.under)
        return _finish(ctx, pdf, writer)


def _extent(pdf: pikepdf.Pdf, pages: list[int], piece: Piece) -> float:
    """Half-size of the area the tiles must cover: half the diagonal of the largest page, plus
    the size of one copy so that copies at the edge are included."""
    sizes = [page_frame(pdf.pages[i]).display_size for i in pages]
    diagonal = max(math.hypot(w, h) for w, h in sizes) / 2
    return diagonal + max(piece.width, piece.height)


# -- letterhead (F11) ----------------------------------------------------------------------


class LetterheadParams(PageSelection):
    """Place a page of another PDF (the letterhead) on the selected pages. ``sourcePage`` (0-based)
    is used for every page. ``first``, ``odd``, ``even`` and ``rest`` (0-based source pages)
    choose by target page: the first page, odd-numbered pages (1, 3, 5...), even-numbered pages,
    and any other page. Mapping fields take priority over ``sourcePage``."""

    source_path: str = Field(min_length=1, description="PDF that holds the letterhead.")
    source_page: int | None = Field(default=None, ge=0)
    first: int | None = Field(default=None, ge=0)
    odd: int | None = Field(default=None, ge=0)
    even: int | None = Field(default=None, ge=0)
    rest: int | None = Field(default=None, ge=0)
    scaling: Literal["none", "fit"] = Field(default="fit")
    under: bool = Field(default=True)

    def mapping_given(self) -> bool:
        return any(v is not None for v in (self.first, self.odd, self.even, self.rest))


@operation(
    id="overlay.letterhead",
    title="Add letterhead",
    group="overlay",
    params=LetterheadParams,
    destructive=True,
)
def letterhead(ctx: OpContext, p: LetterheadParams) -> OpOutput:
    source_path = _existing_file(p.source_path)
    with open_pdf(source_path) as source, ctx.open_input() as pdf:
        pages = page_selection(p.pages, p.page_range, len(pdf.pages))
        fallback = p.source_page
        if fallback is None and not p.mapping_given():
            fallback = 0
        chosen: dict[int, int] = {}
        for index in pages:
            source_index = _letterhead_source(index, p, fallback)
            if source_index is not None:
                chosen[index] = source_index
        if not chosen:
            raise invalid_params(
                "No letterhead page for the selected pages", {"field": "sourcePage"}
            )
        check_indices(sorted(set(chosen.values())), len(source.pages), "sourcePage")
        writer = OverlayWriter(
            pdf, kind="letterhead", group=_new_id(), label="Giấy tiêu đề", warn=ctx.warn
        )
        forms: dict[int, pikepdf.Object] = {}
        targets = sorted(chosen)
        for index in ctx.steps(targets, len(targets), "Adding letterhead"):
            source_index = chosen[index]
            if source_index not in forms:
                forms[source_index] = _letterhead_form(pdf, source.pages[source_index])
            matrix = letterhead_matrix(
                page_frame(source.pages[source_index]),
                page_frame(pdf.pages[index]),
                p.scaling,
            )
            writer.place_form(index, forms[source_index], matrix, under=p.under)
        return _finish(ctx, pdf, writer)


def _letterhead_source(index: int, p: LetterheadParams, fallback: int | None) -> int | None:
    if index == 0 and p.first is not None:
        return p.first
    odd_numbered = index % 2 == 0  # 0-based even index = 1-based odd page
    if odd_numbered and p.odd is not None:
        return p.odd
    if not odd_numbered and p.even is not None:
        return p.even
    if p.rest is not None:
        return p.rest
    return fallback


def _letterhead_form(pdf: pikepdf.Pdf, source_page: pikepdf.Page) -> pikepdf.Object:
    form = source_page.as_form_xobject(handle_transformations=False)
    box = source_page.cropbox
    form.BBox = pikepdf.Array([float(v) for v in box])
    copied = pdf.copy_foreign(form)
    if copied.objgen == (0, 0):
        copied = pdf.make_indirect(copied)
    return copied


# -- list and remove (F12) -----------------------------------------------------------------


class ListOverlaysParams(WireModel):
    """No parameters: lists the overlays of the current revision."""


@operation(
    id="overlay.listOverlays", title="List overlays", group="overlay", params=ListOverlaysParams
)
def list_op(ctx: OpContext, p: ListOverlaysParams) -> OpOutput:
    del p
    with ctx.open_input() as pdf:
        found = list_overlays(pdf)
    overlays = [
        {"id": o.id, "kind": o.kind, "group": o.group, "pages": o.pages, "label": o.label}
        for o in found
    ]
    return OpOutput(changed_pages=[], data={"overlays": overlays})


class RemoveOverlaysParams(WireModel):
    """Remove overlays added by Chef PDF. Give at least one selector; all given selectors must
    match."""

    ids: list[str] | None = Field(default=None, min_length=1)
    group: str | None = Field(default=None, min_length=1)
    kind: Kind | None = Field(default=None)

    @model_validator(mode="after")
    def _one_selector(self) -> RemoveOverlaysParams:
        if self.ids is None and self.group is None and self.kind is None:
            raise ValueError("give ids, group or kind")
        return self


@operation(
    id="overlay.remove",
    title="Remove overlays",
    group="overlay",
    params=RemoveOverlaysParams,
    destructive=True,
)
def remove(ctx: OpContext, p: RemoveOverlaysParams) -> OpOutput:
    with ctx.open_input() as pdf:
        result = remove_overlays(pdf, ids=p.ids, group=p.group, kind=p.kind)
        if result.changed_pages:
            ctx.save_document(pdf)
    return OpOutput(changed_pages=result.changed_pages, data={"removedIds": result.removed_ids})


# -- helpers -------------------------------------------------------------------------------


def page_selection(pages: list[int] | None, page_range: str | None, count: int) -> list[int]:
    """Sorted 0-based pages from ``pages`` and ``page_range`` (all pages when neither is given)."""
    if pages is None and page_range is None:
        return list(range(count))
    selected: set[int] = set()
    if pages is not None:
        selected.update(check_indices(pages, count))
    if page_range is not None:
        for token in page_range.split(","):
            word = token.strip().lower()
            if not word:
                continue
            if word == "all":
                selected.update(range(count))
            elif word == "odd":
                selected.update(range(0, count, 2))
            elif word == "even":
                selected.update(range(1, count, 2))
            else:
                for part in parse_ranges(token, count):
                    selected.update(part.pages)
    if not selected:
        raise invalid_params("No pages selected", {"field": "pageRange"})
    return sorted(selected)


def to_points(value: float, unit: str) -> float:
    return value * MM_TO_PT if unit == "mm" else value


def hex_color(text: str) -> tuple[float, float, float]:
    r, g, b = (int(text[i : i + 2], 16) / 255 for i in (1, 3, 5))
    return (r, g, b)


def _placement(p: Placed) -> Placement:
    return Placement(
        x=to_points(p.x, p.unit),
        y=to_points(p.y, p.unit),
        anchor=p.anchor,
        rotation=p.rotation,
        opacity=p.opacity,
    )


def _new_id() -> str:
    return uuid.uuid4().hex


def _label(p: WatermarkParams) -> str:
    return (p.text or "Hình mờ")[:60]


def _finish(ctx: OpContext, pdf: pikepdf.Pdf, writer: OverlayWriter) -> OpOutput:
    writer.commit()
    if writer.pages:
        ctx.save_document(pdf)
    return OpOutput(changed_pages=writer.pages, data={"overlayId": writer.overlay_id})


def _existing_file(path: str) -> Path:
    candidate = Path(path).expanduser().absolute()
    if not candidate.is_file():
        raise ChefError(ErrorKind.FILE_NOT_FOUND, "File not found", {"path": str(candidate)})
    return candidate


def _read_file(path: str) -> bytes:
    return _existing_file(path).read_bytes()
