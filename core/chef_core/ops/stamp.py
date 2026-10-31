"""Stamps (group stamp): text stamps with dynamic lines (F2, F5), image stamps (F3), the giáp lai
seal cut across pages (F4), initials on pages (F6), and the built-in preset catalogue (F2).

Every stamp is an overlay of Kind ``stamp`` with its own Group, so ``overlay.remove`` undoes it.
Stamps change page content, so they are destructive: a signed document refuses them.

Dynamic lines: ``{date}``, ``{time}``, ``{datetime}`` and ``{user}`` are filled when the stamp is
made. Dates and times come from ``overlay/variables.py``, the engine used for page numbers.
"""

from __future__ import annotations

import datetime as dt
import json
import uuid
from importlib import resources
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, model_validator

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.ops.overlay import (
    Anchor,
    FontName,
    HexColor,
    PageSelection,
    Placed,
    hex_color,
    page_selection,
    to_points,
)
from chef_core.overlay.engine import OverlayWriter, Piece, Placement, TextStyle
from chef_core.overlay.geometry import number
from chef_core.overlay.images import PX_TO_PT
from chef_core.overlay.pagecontent import page_frame
from chef_core.overlay.variables import DocVars, Variable, parse_template

MM_TO_PT = 72.0 / 25.4
PRESETS_FILE = "stamps.json"
STAMP_VARIABLES = ("date", "time")
STAMP_DATE_FORMAT = "dd/MM/yyyy"
STAMP_LABEL_MAX = 60


# -- shared helpers ---------------------------------------------------------------------------


def _now() -> dt.datetime:
    """Local time. Tests replace this to get fixed dates."""
    return dt.datetime.now()


def expand_placeholders(text: str, now: dt.datetime, user: str | None) -> str:
    """Fill the dynamic lines of a stamp (F5).

    ``{date}`` and ``{time}`` are rendered by ``overlay/variables.py`` (dd/MM/yyyy, HH:mm).
    ``{datetime}`` is "{time} {date}". ``{user}`` is the given name, with braces escaped so it is
    inserted as typed. Any other variable (``{page}``, ``{filename}``...) is refused: a stamp is
    the same on every page, so page variables would be wrong.
    """
    text = text.replace("{datetime}", "{time} {date}")
    text = text.replace("{user}", (user or "").replace("{", "{{").replace("}", "}}"))
    for token in parse_template(text):
        if isinstance(token, Variable) and token.name not in STAMP_VARIABLES:
            raise invalid_params(
                "A stamp may use only {date}, {time}, {datetime} and {user}",
                {"field": "text", "variable": token.name},
            )
    values = DocVars(
        filename="",
        title="",
        author="",
        page_count=1,
        start_number=1,
        date_format=STAMP_DATE_FORMAT,
        now=now,
    )
    return values.render(text, 0)


def _read_image(path: str) -> bytes:
    candidate = Path(path).expanduser().absolute()
    if not candidate.is_file():
        raise ChefError(ErrorKind.FILE_NOT_FOUND, "File not found", {"path": str(candidate)})
    return candidate.read_bytes()


def _stamp_placement(p: Placed, blend_multiply: bool) -> Placement:
    return Placement(
        x=to_points(p.x, p.unit),
        y=to_points(p.y, p.unit),
        anchor=p.anchor,
        rotation=p.rotation,
        opacity=p.opacity,
        blend="Multiply" if blend_multiply else "Normal",
    )


def _shifted(body: str, dx: float, dy: float) -> str:
    return f"q\n1 0 0 1 {number(dx)} {number(dy)} cm\n{body}\nQ"


def _label(text: str) -> str:
    first = text.strip().splitlines()[0] if text.strip() else "Con dấu"
    return first[:STAMP_LABEL_MAX]


def _finish(ctx: OpContext, pdf: Any, writer: OverlayWriter) -> OpOutput:
    writer.commit()
    if writer.pages:
        ctx.save_document(pdf)
    return OpOutput(changed_pages=writer.pages, data={"overlayId": writer.overlay_id})


# -- stamp.text (F2, F5) ----------------------------------------------------------------------


class TextStampParams(PageSelection, Placed):
    """A bordered text stamp such as "ĐÃ DUYỆT". Lines are separated by line breaks. The
    placeholders {date}, {time}, {datetime} and {user} are filled when the stamp is made."""

    text: str = Field(
        min_length=1,
        max_length=500,
        description="Lines separated by \\n. Placeholders: {date} {time} {datetime} {user}.",
    )
    font_name: FontName = Field(default="BeVietnamPro")
    font_size: float = Field(default=24.0, gt=0, le=200)
    bold: bool = Field(default=True)
    color: HexColor = Field(default="#C00000", description="Text and border colour.")
    fill: HexColor | None = Field(default=None, description="Box fill; none = transparent.")
    border_color: HexColor | None = Field(default=None, description="Default: the text colour.")
    border_width: float = Field(default=2.0, ge=0, le=20, description="Points; 0 = no border.")
    padding: float = Field(default=6.0, ge=0, le=100, description="Points inside the border.")
    line_height: float = Field(default=1.2, gt=0, le=3)
    user: str | None = Field(default=None, max_length=120, description="Value of {user}.")
    blend_multiply: bool = Field(default=False, description="Multiply: the ink darkens the text.")


@operation(
    id="stamp.text",
    title="Text stamp",
    group="stamp",
    params=TextStampParams,
    destructive=True,
    batchable=True,
)
def text_stamp(ctx: OpContext, p: TextStampParams) -> OpOutput:
    with ctx.open_input() as pdf:
        pages = page_selection(p.pages, p.page_range, len(pdf.pages))
        writer = OverlayWriter(
            pdf, kind="stamp", group=_new_id(), label=_label(p.text), warn=ctx.warn
        )
        piece = _text_stamp_piece(writer, p, _now())
        placement = _stamp_placement(p, p.blend_multiply)
        for index in ctx.steps(pages, len(pages), "Adding stamp"):
            writer.place(index, piece, placement, under=p.under)
        return _finish(ctx, pdf, writer)


def _text_stamp_piece(writer: OverlayWriter, p: TextStampParams, now: dt.datetime) -> Piece:
    text = writer.text(
        expand_placeholders(p.text, now, p.user),
        TextStyle(
            font_family=p.font_name,
            font_size=p.font_size,
            bold=p.bold,
            color=hex_color(p.color),
            align="center",
            line_height=p.line_height,
        ),
    )
    bw = p.border_width
    box_w = text.width + 2 * p.padding + bw
    box_h = text.height + 2 * p.padding + bw
    parts: list[str] = []
    if p.fill is not None or bw > 0:
        stroke = hex_color(p.border_color or p.color) if bw > 0 else None
        fill = hex_color(p.fill) if p.fill is not None else None
        frame = writer.rect(box_w - bw, box_h - bw, fill=fill, stroke=stroke, line_width=bw)
        parts.append(_shifted(frame.body, bw / 2, bw / 2))
    parts.append(_shifted(text.body, bw / 2 + p.padding, bw / 2 + p.padding))
    return Piece(width=box_w, height=box_h, body="\n".join(parts))


def _new_id() -> str:
    return uuid.uuid4().hex


# -- stamp.image (F3) -------------------------------------------------------------------------


class ImageStampParams(PageSelection, Placed):
    """A PNG (with alpha) or JPEG stamp. Give width or height; the other follows the aspect
    ratio. Default width is 150 pt. ``blendMultiply`` makes white transparent and lets the ink
    darken what is below, like a real seal."""

    path: str = Field(min_length=1, description="Absolute path of the image file.")
    width: float | None = Field(default=None, gt=0)
    height: float | None = Field(default=None, gt=0)
    blend_multiply: bool = Field(default=False)


@operation(
    id="stamp.image",
    title="Image stamp",
    group="stamp",
    params=ImageStampParams,
    destructive=True,
    batchable=True,
)
def image_stamp(ctx: OpContext, p: ImageStampParams) -> OpOutput:
    raw = _read_image(p.path)
    with ctx.open_input() as pdf:
        pages = page_selection(p.pages, p.page_range, len(pdf.pages))
        writer = OverlayWriter(
            pdf, kind="stamp", group=_new_id(), label="Con dấu ảnh", warn=ctx.warn
        )
        width = to_points(p.width, p.unit) if p.width is not None else None
        height = to_points(p.height, p.unit) if p.height is not None else None
        piece = writer.image(raw, width=width, height=height)
        placement = _stamp_placement(p, p.blend_multiply)
        for index in ctx.steps(pages, len(pages), "Adding stamp"):
            writer.place(index, piece, placement, under=p.under)
        return _finish(ctx, pdf, writer)


# -- stamp.initials (F6) ----------------------------------------------------------------------

_HORIZONTAL = {"left": 0, "center": 1, "right": 2}
_VERTICAL = {"top": 0, "center": 1, "bottom": 2}


class InitialsParams(PageSelection):
    """Initials (text or a small image) at the same corner or edge of every selected page.
    For alternate pages use ``pageRange`` "odd" or "even"."""

    text: str | None = Field(default=None, min_length=1, max_length=40)
    path: str | None = Field(default=None, min_length=1, description="PNG or JPEG of the initials.")
    position: Anchor = Field(default="bottom-right", description="Corner or edge of the page.")
    margin_mm: float = Field(default=10.0, ge=0, le=200)
    width_mm: float = Field(default=25.0, gt=0, le=200, description="Image width (image only).")
    font_size: float = Field(default=14.0, gt=0, le=200, description="Text size (text only).")
    font_name: FontName = Field(default="BeVietnamPro")
    bold: bool = Field(default=False)
    color: HexColor = Field(default="#1F4E9A")
    opacity: float = Field(default=1.0, ge=0, le=1)
    blend_multiply: bool = Field(default=False)

    @model_validator(mode="after")
    def _one_source(self) -> InitialsParams:
        if (self.text is None) == (self.path is None):
            raise ValueError("give exactly one of text or path")
        return self


@operation(
    id="stamp.initials",
    title="Initials on pages",
    group="stamp",
    params=InitialsParams,
    destructive=True,
    batchable=True,
)
def initials(ctx: OpContext, p: InitialsParams) -> OpOutput:
    raw = _read_image(p.path) if p.path is not None else None
    with ctx.open_input() as pdf:
        pages = page_selection(p.pages, p.page_range, len(pdf.pages))
        writer = OverlayWriter(
            pdf, kind="stamp", group=_new_id(), label="Chữ ký nháy", warn=ctx.warn
        )
        if raw is not None:
            piece = writer.image(raw, width=p.width_mm * MM_TO_PT)
        else:
            piece = writer.text(
                p.text or "",
                TextStyle(
                    font_family=p.font_name,
                    font_size=p.font_size,
                    bold=p.bold,
                    color=hex_color(p.color),
                ),
            )
        margin = p.margin_mm * MM_TO_PT
        for index in ctx.steps(pages, len(pages), "Adding initials"):
            width, height = page_frame(pdf.pages[index]).display_size
            x, y = _corner(p.position, margin, width, height)
            placement = Placement(
                x=x,
                y=y,
                anchor=p.position,
                opacity=p.opacity,
                blend="Multiply" if p.blend_multiply else "Normal",
            )
            writer.place(index, piece, placement)
        return _finish(ctx, pdf, writer)


def _corner(position: str, margin: float, width: float, height: float) -> tuple[float, float]:
    """Anchor point for ``position`` inset by ``margin`` from the page edges (top-left origin)."""
    vertical, _, horizontal = position.partition("-")
    if position == "center":
        return width / 2, height / 2
    h_pos = {"left": margin, "center": width / 2, "right": width - margin}[horizontal]
    v_pos = {"top": margin, "center": height / 2, "bottom": height - margin}[vertical]
    return h_pos, v_pos


# -- stamp.presets ----------------------------------------------------------------------------


class StampPresetsParams(WireModel):
    """No parameters: the built-in text stamp presets."""


def load_presets() -> list[dict[str, Any]]:
    text = resources.files("chef_core.resources").joinpath(PRESETS_FILE).read_text(encoding="utf-8")
    data: dict[str, Any] = json.loads(text)
    presets: list[dict[str, Any]] = data["presets"]
    return presets


@operation(
    id="stamp.presets",
    title="Stamp presets",
    group="stamp",
    params=StampPresetsParams,
    standalone=True,
)
def presets(ctx: OpContext, p: StampPresetsParams) -> OpOutput:
    del ctx, p
    return OpOutput(changed_pages=[], data={"presets": load_presets()})


# -- stamp.seam: dấu giáp lai (F4) ------------------------------------------------------------


class SeamParams(PageSelection):
    """Dấu giáp lai: one seal image cut into N vertical strips, one strip flush against the
    right (or left) edge of each selected page. Fanned out, the pages show the whole seal.

    N is the number of selected pages, or ``groupSize`` pages per set (a 30-page document with
    groupSize 10 gives three sets of ten strips). ``cutFirstPage`` false leaves the first page of
    each set without a strip, so the strips go to the remaining pages.
    ``overlapMm`` widens every strip into its neighbour by that amount (a shared band).
    ``scaleWidthMm`` is the width of the whole seal across all strips (default: natural size at
    96 dpi). ``vertical`` is "center", "top", "bottom", or a number of mm from the top edge."""

    path: str = Field(min_length=1, description="Absolute path of the seal image (PNG or JPEG).")
    side: Literal["right", "left"] = Field(default="right")
    slice_mode: Literal["even"] = Field(
        default="even", description="Equal strips: the seal width is split into N equal parts."
    )
    group_size: int | None = Field(default=None, ge=1, le=10_000)
    cut_first_page: bool = Field(default=True)
    vertical: Literal["center", "top", "bottom"] | float = Field(default="center")
    overlap_mm: float = Field(default=0.0, ge=0, le=50)
    scale_width_mm: float | None = Field(default=None, gt=0, le=1000)
    opacity: float = Field(default=1.0, ge=0, le=1)
    blend_multiply: bool = Field(default=False)


@operation(
    id="stamp.seam",
    title="Cross-page seal (giáp lai)",
    group="stamp",
    params=SeamParams,
    destructive=True,
)
def seam(ctx: OpContext, p: SeamParams) -> OpOutput:
    raw = _read_image(p.path)
    with ctx.open_input() as pdf:
        selected = page_selection(p.pages, p.page_range, len(pdf.pages))
        writer = OverlayWriter(
            pdf, kind="stamp", group=_new_id(), label="Dấu giáp lai", warn=ctx.warn
        )
        handle = writer.doc.image(raw)
        name = writer.res.add("XObject", handle.obj)
        total_w = (p.scale_width_mm * MM_TO_PT) if p.scale_width_mm else handle.width_px * PX_TO_PT
        ppx = total_w / handle.width_px  # points per image pixel
        total_h = handle.height_px * ppx
        overlap = p.overlap_mm * MM_TO_PT
        plan: list[tuple[int, int, int]] = []  # (page index, slice number, slices in the set)
        for group in _sets(selected, p.group_size):
            targets = group if p.cut_first_page else group[1:]
            for k, index in enumerate(targets):
                plan.append((index, k, len(targets)))
        if not plan:
            raise invalid_params("No page can take a strip", {"field": "cutFirstPage"})
        pieces: dict[tuple[int, int], Piece] = {}
        for index, k, count in ctx.steps(plan, len(plan), "Adding seal strips"):
            piece = pieces.get((k, count))
            if piece is None:
                piece = _strip(
                    name, handle.width_px, total_w, total_h, ppx, k, count, overlap, p.side
                )
                pieces[(k, count)] = piece
            width, height = page_frame(pdf.pages[index]).display_size
            placement = _strip_placement(
                p.side, p.vertical, width, height, p.opacity, p.blend_multiply
            )
            writer.place(index, piece, placement)
        result = _finish(ctx, pdf, writer)
        result.data = {
            **(result.data or {}),
            "strips": [{"page": idx, "strip": k + 1, "of": count} for idx, k, count in plan],
        }
        return result


def _sets(selected: list[int], group_size: int | None) -> list[list[int]]:
    if group_size is None:
        return [selected]
    return [selected[i : i + group_size] for i in range(0, len(selected), group_size)]


def _strip(
    name: str,
    width_px: int,
    total_w: float,
    total_h: float,
    ppx: float,
    k: int,
    count: int,
    overlap: float,
    side: str,
) -> Piece:
    """Strip ``k`` of ``count``: the image's k-th slice, clipped to its own box.

    The image is drawn once per strip with the same XObject (shared data); only the clip and the
    offset differ, so N strips cost one image plus a few bytes per page.
    """
    start_px = round(k * width_px / count)
    end_px = round((k + 1) * width_px / count)
    if end_px <= start_px:
        raise invalid_params("seal is too narrow for that many strips", {"field": "groupSize"})
    slice_w = (end_px - start_px) * ppx
    # the strip's left edge in image space: a right strip reaches left by the overlap
    origin = start_px * ppx - overlap if side == "right" else start_px * ppx
    box_w = slice_w + overlap
    body = (
        f"q\n0 0 {number(box_w)} {number(total_h)} re W n\n"
        f"{number(total_w)} 0 0 {number(total_h)} {number(-origin)} 0 cm\n"
        f"/{name} Do\nQ"
    )
    return Piece(width=box_w, height=total_h, body=body)


def _strip_placement(
    side: str,
    vertical: str | float,
    width: float,
    height: float,
    opacity: float,
    blend_multiply: bool,
) -> Placement:
    horizontal = "right" if side == "right" else "left"
    x = width if side == "right" else 0.0
    if vertical == "center":
        anchor, y = f"center-{horizontal}", height / 2
    elif vertical == "bottom":
        anchor, y = f"bottom-{horizontal}", height
    elif vertical == "top":
        anchor, y = f"top-{horizontal}", 0.0
    else:
        anchor, y = f"top-{horizontal}", float(vertical) * MM_TO_PT
    return Placement(
        x=x,
        y=y,
        anchor=anchor,
        opacity=opacity,
        blend="Multiply" if blend_multiply else "Normal",
    )


__all__ = [
    "expand_placeholders",
    "image_stamp",
    "initials",
    "load_presets",
    "presets",
    "seam",
    "text_stamp",
]
