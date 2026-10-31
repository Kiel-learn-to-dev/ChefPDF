"""Page content operations (T6.01): list and hit-test paint objects, edit them.

- ``content.listObjects`` (read-only): objects of one page with ids, boxes in the displayed frame
  (points, origin top-left, y down) and in user space, kinds, colours and marks.
- ``content.hitTest`` (read-only): objects under a point, topmost first.
- ``content.delete``, ``content.move``, ``content.transform``, ``content.setColor``,
  ``content.setOpacity``, ``content.reorder``, ``content.duplicate``: destructive (blocked on
  signed documents). They take object ids of the current revision, possibly on several pages.

Ids are ``p<page>:<digest>:<ordinal>`` (see chef_core.content.model). An id whose digest does not
match the page's current content is refused with INVALID_PARAMS ``STALE_OBJECT_IDS``.
``flattenForms`` lets an edit act on an object drawn by a form: the page's forms are inlined
first, which changes the content of the page (the forms are then no longer objects).

Move and duplicate take the displacement in the displayed frame (points, y downwards); transform
takes a matrix in page user space.
"""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Any, Literal

from pydantic import Field

from chef_core.content.editor import PageEditor, hex_colour, prepare
from chef_core.content.engine import build_model, objects_at_point
from chef_core.content.model import PageObject, parse_id
from chef_core.errors import invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.overlay.pagecontent import page_frame
from chef_core.signing.anchors import PageFrame

Kind = Literal["text", "image", "path", "shading", "form"]
ReorderMode = Literal["front", "back", "forward", "backward"]
_HEX = re.compile(r"^#?[0-9a-fA-F]{6}$")


def _user_vector(frame: PageFrame, dx: float, dy: float) -> tuple[float, float]:
    """A displacement in the displayed frame (y down) as a displacement in user space."""
    origin = frame.rect_from_display((0.0, 0.0, 0.0, 0.0))[:2]
    moved = frame.rect_from_display((dx, -dy, dx, -dy))[:2]
    return moved[0] - origin[0], moved[1] - origin[1]


def _display_to_user(frame: PageFrame, x: float, y_top: float) -> tuple[float, float]:
    """A point of the displayed frame (points, y downwards) as a point of user space."""
    height = frame.display_size[1]
    return frame.rect_from_display((x, height - y_top, x, height - y_top))[:2]


def _colour_arg(value: str | None) -> Any:
    if value is None:
        return None
    if _HEX.match(value) is None:
        raise invalid_params("INVALID_COLOUR", {"value": value})
    return hex_colour(value)


def _pages_of(ids: list[str]) -> dict[int, list[str]]:
    grouped: dict[int, list[str]] = defaultdict(list)
    for ident in dict.fromkeys(ids):  # keeps the order, drops repeats
        parsed = parse_id(ident)
        if parsed is None:
            raise invalid_params("INVALID_OBJECT_ID", {"id": ident})
        grouped[parsed[0]].append(ident)
    return dict(grouped)


# -- read-only -----------------------------------------------------------------------------


class ContentListObjectsParams(WireModel):
    """List the paint objects of one page."""

    page_index: int = Field(ge=0, description="0-based page.")
    include_forms: bool = Field(default=False, description="Also list objects drawn by forms.")
    kinds: list[Kind] | None = Field(default=None, description="Only these kinds.")


@operation(
    id="content.listObjects",
    title="List page objects",
    group="content",
    params=ContentListObjectsParams,
)
def list_objects(ctx: OpContext, p: ContentListObjectsParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("content.listObjects needs a session")
    with ctx.open_input() as pdf:
        if p.page_index >= len(pdf.pages):
            raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": p.page_index})
        page = pdf.pages[p.page_index]
        model = build_model(pdf, page, p.page_index)
        frame = model.frame
        objs = [
            o
            for o in model.objects
            if (p.include_forms or o.parent_id is None) and (p.kinds is None or o.kind in p.kinds)
        ]
        display_w, display_h = frame.display_size
        return OpOutput(
            changed_pages=[],
            data={
                "pageIndex": p.page_index,
                "digest": model.digest,
                "displayWidth": display_w,
                "displayHeight": display_h,
                "rotation": frame.rotation,
                "objects": model.to_json(objs),
            },
        )


class ContentHitTestParams(WireModel):
    """Objects under a point of a page."""

    page_index: int = Field(ge=0)
    x: float
    y: float = Field(description="Points from the top (unit 'pt') or user space y (unit 'user').")
    unit: Literal["pt", "user"] = Field(default="pt", description="Coordinates to use.")
    include_forms: bool = Field(default=True, description="Test the objects of forms.")


@operation(
    id="content.hitTest",
    title="Objects at a point",
    group="content",
    params=ContentHitTestParams,
)
def hit_test(ctx: OpContext, p: ContentHitTestParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("content.hitTest needs a session")
    with ctx.open_input() as pdf:
        if p.page_index >= len(pdf.pages):
            raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": p.page_index})
        page = pdf.pages[p.page_index]
        model = build_model(pdf, page, p.page_index)
        if p.unit == "pt":
            ux, uy = _display_to_user(model.frame, p.x, p.y)
        else:
            ux, uy = p.x, p.y
        hits = objects_at_point(model.objects, ux, uy, include_forms=p.include_forms)
        return OpOutput(
            changed_pages=[],
            data={
                "pageIndex": p.page_index,
                "object": model.to_json(hits[:1])[0] if hits else None,
                "objects": model.to_json(hits),
            },
        )


# -- destructive edits ---------------------------------------------------------------------


class _EditBase(WireModel):
    ids: list[str] = Field(min_length=1, description="Object ids of the current revision.")
    flatten_forms: bool = Field(
        default=False,
        description="Allow editing objects drawn by forms (the page's forms are inlined).",
    )


class ContentDeleteParams(_EditBase):
    """Delete objects. Text keeps the position of the text after it."""


class ContentMoveParams(_EditBase):
    """Move objects by a displacement in the displayed frame (points, y downwards)."""

    dx: float = 0.0
    dy: float = 0.0


class ContentTransformParams(_EditBase):
    """Transform objects by a matrix in page user space (PDF order a b c d e f)."""

    matrix: list[float] = Field(min_length=6, max_length=6)


class ContentSetColorParams(_EditBase):
    """Set the fill and/or stroke colour of text and paths ('#rrggbb')."""

    fill: str | None = None
    stroke: str | None = None


class ContentSetOpacityParams(_EditBase):
    """Set the opacity of objects (0 transparent .. 1 opaque)."""

    opacity: float = Field(ge=0, le=1)


class ContentReorderParams(_EditBase):
    """Change the stacking order: front, back, one step forward or one step backward."""

    mode: ReorderMode


class ContentDuplicateParams(_EditBase):
    """Copy objects, displaced by dx, dy (displayed frame, points, y downwards)."""

    dx: float = 0.0
    dy: float = 0.0


def _run_edit(
    ctx: OpContext,
    ids: list[str],
    flatten: bool,
    action: Any,
) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("content edits need a session")
    changed: list[int] = []
    counts: dict[str, int] = {"objects": 0}
    skipped: list[str] = []
    with ctx.open_input() as pdf:
        for page_index, page_ids in sorted(_pages_of(ids).items()):
            if page_index >= len(pdf.pages):
                raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": page_index})
            page = pdf.pages[page_index]
            editor, targets = prepare(pdf, page, page_index, page_ids, flatten_forms=flatten)
            counts["objects"] += len(targets)
            action(editor, targets)
            skipped.extend(editor.skipped)
            if editor.changed():
                editor.write()
                changed.append(page_index)
        if changed:
            ctx.save_document(pdf)
    for ident in skipped:
        ctx.warn(f"not applicable to {ident}")
    return OpOutput(
        changed_pages=changed,
        data={"objects": counts["objects"], "skipped": skipped},
    )


@operation(
    id="content.delete",
    title="Delete objects",
    group="content",
    params=ContentDeleteParams,
    destructive=True,
)
def delete(ctx: OpContext, p: ContentDeleteParams) -> OpOutput:
    return _run_edit(ctx, p.ids, p.flatten_forms, lambda ed, objs: ed.delete(objs))


def _frame_of(ctx: OpContext, ids: list[str]) -> dict[int, PageFrame]:
    """The displayed frame of each page named by ids (for displacements)."""
    frames: dict[int, PageFrame] = {}
    if ctx.input_path is None:
        return frames
    with ctx.open_input() as pdf:
        for index in _pages_of(ids):
            frames[index] = page_frame(pdf.pages[index])
    return frames


@operation(
    id="content.move",
    title="Move objects",
    group="content",
    params=ContentMoveParams,
    destructive=True,
)
def move(ctx: OpContext, p: ContentMoveParams) -> OpOutput:
    frames = _frame_of(ctx, p.ids)

    def action(ed: PageEditor, objs: list[PageObject]) -> None:
        frame = frames[ed.model.page_index]
        ux, uy = _user_vector(frame, p.dx, p.dy)
        ed.move(objs, ux, uy)

    return _run_edit(ctx, p.ids, p.flatten_forms, action)


@operation(
    id="content.transform",
    title="Transform objects",
    group="content",
    params=ContentTransformParams,
    destructive=True,
)
def transform(ctx: OpContext, p: ContentTransformParams) -> OpOutput:
    m = tuple(p.matrix)
    if abs(m[0] * m[3] - m[1] * m[2]) < 1e-12:
        raise invalid_params("SINGULAR_MATRIX", {"matrix": p.matrix})

    def action(ed: PageEditor, objs: list[PageObject]) -> None:
        ed.transform(objs, (m[0], m[1], m[2], m[3], m[4], m[5]))

    return _run_edit(ctx, p.ids, p.flatten_forms, action)


@operation(
    id="content.setColor",
    title="Set object colour",
    group="content",
    params=ContentSetColorParams,
    destructive=True,
)
def set_color(ctx: OpContext, p: ContentSetColorParams) -> OpOutput:
    fill = _colour_arg(p.fill)
    stroke = _colour_arg(p.stroke)
    if fill is None and stroke is None:
        raise invalid_params("NOTHING_TO_SET", {})
    return _run_edit(ctx, p.ids, p.flatten_forms, lambda ed, objs: ed.set_color(objs, fill, stroke))


@operation(
    id="content.setOpacity",
    title="Set object opacity",
    group="content",
    params=ContentSetOpacityParams,
    destructive=True,
)
def set_opacity(ctx: OpContext, p: ContentSetOpacityParams) -> OpOutput:
    return _run_edit(ctx, p.ids, p.flatten_forms, lambda ed, objs: ed.set_opacity(objs, p.opacity))


@operation(
    id="content.reorder",
    title="Change stacking order",
    group="content",
    params=ContentReorderParams,
    destructive=True,
)
def reorder(ctx: OpContext, p: ContentReorderParams) -> OpOutput:
    return _run_edit(ctx, p.ids, p.flatten_forms, lambda ed, objs: ed.reorder(objs, p.mode))


@operation(
    id="content.duplicate",
    title="Duplicate objects",
    group="content",
    params=ContentDuplicateParams,
    destructive=True,
)
def duplicate(ctx: OpContext, p: ContentDuplicateParams) -> OpOutput:
    frames = _frame_of(ctx, p.ids)

    def action(ed: PageEditor, objs: list[PageObject]) -> None:
        frame = frames[ed.model.page_index]
        ux, uy = _user_vector(frame, p.dx, p.dy)
        ed.duplicate(objs, ux, uy)

    return _run_edit(ctx, p.ids, p.flatten_forms, action)
