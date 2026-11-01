"""Markup, notes, drawings and review (milestone v0.7, G1-G4). See ``chef_core.annots``.

Read-only: ``annots.list`` {pageIndex?, kinds?, author?, status?}. Each annotation has an id
(``A<page>:<digest>:<n>``), subtype, rect (displayed frame, points, origin top-left), contents,
author, modified (ISO), colour, opacity, replies (ids), inReplyTo, status (review state), quads
(displayed, eight numbers per quad), icon, lineEnding, appearance (true when /AP /N exists).

Destructive (each returns the new id, or ids of the page, which change with every edit):

- ``annots.addTextMarkup`` {pageIndex, kind highlight|underline|strike|squiggly, rects? | find?,
  allMatches, color, opacity, contents, author}: rects are displayed boxes; find takes the text of
  the page (text model) and marks it. Result: count, ids.
- ``annots.addNote`` {pageIndex, left, top, contents, author, icon, color, opacity}.
- ``annots.addFreeText`` {pageIndex, rect, text, fontSize, color, background?, borderColor,
  borderWidth, author}.
- ``annots.addInk`` {pageIndex, strokes: [[[x, y], ...], ...], color, width, opacity, author}.
- ``annots.addShape`` {pageIndex, kind line|arrow|rect|ellipse, rect? | points?, color, fill?,
  width, author}. points is [x1, y1, x2, y2].
- ``annots.update`` {id, contents?, author?, color?, opacity?, rect?}.
- ``annots.remove`` {ids}; ``annots.removeAll`` {kinds?, pageIndex?}.
- ``annots.reply`` {id, text, author, color?}: a Text annotation answering the parent.
- ``annots.setStatus`` {id, status accepted|rejected|cancelled|completed|none}.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import Field

from chef_core.annots.common import (
    ANNOT_PREFIX,
    add_annot,
    annot_digest,
    make_id,
    user_point,
    user_rect,
)
from chef_core.annots.markup import (
    free_text_dict,
    ink_dict,
    markup_dict,
    note_dict,
    shape_dict,
)
from chef_core.annots.review import (
    list_annots,
    remove_all,
    remove_annots,
    reply,
    set_status,
    update_annot,
)
from chef_core.errors import invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.overlay.pagecontent import page_frame
from chef_core.text.build import build_text_page
from chef_core.text.edit import real_char_indices
from chef_core.text.find import find_spans

HEX_PATTERN = r"^#[0-9a-fA-F]{6}$"
_STATE = {
    "accepted": "Accepted",
    "rejected": "Rejected",
    "cancelled": "Cancelled",
    "completed": "Completed",
    "none": "None",
}
MarkupKind = Literal["highlight", "underline", "strike", "squiggly"]
ShapeKind = Literal["line", "arrow", "rect", "ellipse"]
NoteIcon = Literal["Note", "Comment", "Key", "Help", "NewParagraph", "Paragraph", "Insert"]
Status = Literal["accepted", "rejected", "cancelled", "completed", "none"]


def _need(ctx: OpContext, name: str) -> None:
    if ctx.input_path is None or ctx.result_path is None:
        raise RuntimeError(f"{name} needs a session")


def _page_check(pdf: Any, index: int) -> None:
    if index >= len(pdf.pages):
        raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": index})


def _user_quad(
    frame: Any, left: float, top: float, right: float, bottom: float
) -> list[tuple[float, float]]:
    return [
        user_point(frame, left, top),
        user_point(frame, right, top),
        user_point(frame, left, bottom),
        user_point(frame, right, bottom),
    ]


def _find_quads(
    pdf: Any, page_index: int, query: str, all_matches: bool
) -> list[list[tuple[float, float]]]:
    """One quad per match and line, from the text model (boxes of the matched characters)."""
    page = pdf.pages[page_index]
    tp = build_text_page(pdf, page, page_index)
    frame = page_frame(page)
    out: list[list[tuple[float, float]]] = []
    for line in tp.lines:
        spans = find_spans(
            line.text,
            line.display_map,
            query,
            regex=False,
            case_sensitive=False,
            ignore_diacritics=False,
            whole_word=False,
        )
        for span in spans:
            chars = [line.chars[i] for i in real_char_indices(line, span.start, span.end)]
            if not chars:
                continue
            box = tp.display_box(
                (
                    min(c.x0 for c in chars),
                    min(c.y0 for c in chars),
                    max(c.x1 for c in chars),
                    max(c.y1 for c in chars),
                )
            )
            out.append(_user_quad(frame, *box))
            if not all_matches:
                return out
    return out


# -- read-only --------------------------------------------------------------------------------


class AnnotsListParams(WireModel):
    """Annotations (not links) of one page, or of every page."""

    page_index: int | None = Field(default=None, ge=0)
    kinds: list[str] | None = Field(default=None, description="Subtypes, e.g. Highlight, Text.")
    author: str | None = Field(default=None, description="Case-insensitive part of the name.")
    status: Status | None = None


@operation(id="annots.list", title="List annotations", group="annots", params=AnnotsListParams)
def annots_list(ctx: OpContext, p: AnnotsListParams) -> OpOutput:
    _need(ctx, "annots.list")
    with ctx.open_input() as pdf:
        indices = [p.page_index] if p.page_index is not None else list(range(len(pdf.pages)))
        for i in indices:
            _page_check(pdf, i)
        items = list_annots(pdf, indices, set(p.kinds) if p.kinds else None, p.author, p.status)
    return OpOutput(changed_pages=[], data={"annots": items})


# -- markup -----------------------------------------------------------------------------------


class AnnotsAddTextMarkupParams(WireModel):
    """Highlight, underline, strike-out or squiggly under rects or under found text."""

    page_index: int = Field(ge=0)
    kind: MarkupKind
    rects: list[list[float]] | None = Field(
        default=None, description="Displayed boxes [left, top, right, bottom], one per line."
    )
    find: str | None = Field(default=None, min_length=1, description="Text to mark (text model).")
    all_matches: bool = False
    color: str | None = Field(default=None, pattern=HEX_PATTERN)
    opacity: float = Field(default=1.0, ge=0, le=1)
    contents: str = ""
    author: str = ""


@operation(
    id="annots.addTextMarkup",
    title="Mark text",
    group="annots",
    params=AnnotsAddTextMarkupParams,
    destructive=True,
)
def annots_add_text_markup(ctx: OpContext, p: AnnotsAddTextMarkupParams) -> OpOutput:
    _need(ctx, "annots.addTextMarkup")
    if (p.rects is None) == (p.find is None):
        raise invalid_params("MARKUP_NEEDS_RECTS_OR_FIND", {})
    ids: list[str] = []
    with ctx.open_input() as pdf:
        _page_check(pdf, p.page_index)
        if p.find is not None:
            groups = _find_quads(pdf, p.page_index, p.find, p.all_matches)
        else:
            frame = page_frame(pdf.pages[p.page_index])
            groups = [_user_quad(frame, *map(float, r)) for r in p.rects or []]
        for quad in groups:
            annot = markup_dict(
                pdf,
                p.kind,
                [quad],
                colour=p.color,
                opacity=p.opacity,
                contents=p.contents,
                author=p.author,
            )
            index = add_annot(pdf, pdf.pages[p.page_index], annot)
            ids.append(
                make_id(ANNOT_PREFIX, p.page_index, annot_digest(pdf.pages[p.page_index]), index)
            )
        if groups:
            ctx.save_document(pdf)
    return OpOutput(
        changed_pages=[p.page_index] if groups else [], data={"count": len(groups), "ids": ids}
    )


# -- notes, free text, ink, shapes ----------------------------------------------------------


class AnnotsAddNoteParams(WireModel):
    """A sticky note at a displayed point (its icon is 20 x 20 points)."""

    page_index: int = Field(ge=0)
    left: float
    top: float
    contents: str = Field(min_length=1)
    author: str = ""
    icon: NoteIcon = "Note"
    color: str | None = Field(default=None, pattern=HEX_PATTERN)
    opacity: float = Field(default=1.0, ge=0, le=1)


@operation(
    id="annots.addNote",
    title="Add a note",
    group="annots",
    params=AnnotsAddNoteParams,
    destructive=True,
)
def annots_add_note(ctx: OpContext, p: AnnotsAddNoteParams) -> OpOutput:
    _need(ctx, "annots.addNote")
    with ctx.open_input() as pdf:
        _page_check(pdf, p.page_index)
        page = pdf.pages[p.page_index]
        frame = page_frame(page)
        box = user_rect(frame, (p.left, p.top, p.left + 20, p.top + 20))
        annot = note_dict(
            pdf,
            box,
            contents=p.contents,
            author=p.author,
            colour=p.color,
            icon=p.icon,
            opacity=p.opacity,
        )
        index = add_annot(pdf, page, annot)
        new_id = make_id(ANNOT_PREFIX, p.page_index, annot_digest(page), index)
        ctx.save_document(pdf)
    return OpOutput(changed_pages=[p.page_index], data={"id": new_id})


class AnnotsAddFreeTextParams(WireModel):
    """A text box with a Unicode font. rect is displayed (left, top, right, bottom)."""

    page_index: int = Field(ge=0)
    rect: list[float] = Field(min_length=4, max_length=4)
    text: str = Field(min_length=1)
    font_size: float = Field(default=12.0, ge=4, le=200)
    color: str = Field(default="#000000", pattern=HEX_PATTERN)
    background: str | None = Field(default=None, pattern=HEX_PATTERN)
    border_color: str = Field(default="#000000", pattern=HEX_PATTERN)
    border_width: float = Field(default=0.0, ge=0, le=20)
    author: str = ""


@operation(
    id="annots.addFreeText",
    title="Add a text box",
    group="annots",
    params=AnnotsAddFreeTextParams,
    destructive=True,
)
def annots_add_free_text(ctx: OpContext, p: AnnotsAddFreeTextParams) -> OpOutput:
    _need(ctx, "annots.addFreeText")
    x0, t, x1, b = p.rect
    if x1 <= x0 or b <= t:
        raise invalid_params("INVALID_RECT", {"rect": p.rect})
    with ctx.open_input() as pdf:
        _page_check(pdf, p.page_index)
        page = pdf.pages[p.page_index]
        frame = page_frame(page)
        annot = free_text_dict(
            pdf,
            user_rect(frame, (x0, t, x1, b)),
            text=p.text,
            size=p.font_size,
            colour=p.color,
            background=p.background,
            border_colour=p.border_color,
            border_width=p.border_width,
            author=p.author,
        )
        index = add_annot(pdf, page, annot)
        new_id = make_id(ANNOT_PREFIX, p.page_index, annot_digest(page), index)
        ctx.save_document(pdf)
    return OpOutput(changed_pages=[p.page_index], data={"id": new_id})


class AnnotsAddInkParams(WireModel):
    """Freehand strokes; each point is a displayed [x, y] pair."""

    page_index: int = Field(ge=0)
    strokes: list[list[list[float]]] = Field(min_length=1)
    color: str | None = Field(default=None, pattern=HEX_PATTERN)
    width: float = Field(default=2.0, gt=0, le=40)
    opacity: float = Field(default=1.0, ge=0, le=1)
    author: str = ""


@operation(
    id="annots.addInk",
    title="Add a drawing",
    group="annots",
    params=AnnotsAddInkParams,
    destructive=True,
)
def annots_add_ink(ctx: OpContext, p: AnnotsAddInkParams) -> OpOutput:
    _need(ctx, "annots.addInk")
    with ctx.open_input() as pdf:
        _page_check(pdf, p.page_index)
        page = pdf.pages[p.page_index]
        frame = page_frame(page)
        strokes = []
        for stroke in p.strokes:
            pts = [user_point(frame, float(pt[0]), float(pt[1])) for pt in stroke if len(pt) == 2]
            if len(pts) >= 2:
                strokes.append(pts)
        if not strokes:
            raise invalid_params("INK_NEEDS_TWO_POINTS", {})
        annot = ink_dict(
            pdf, strokes, colour=p.color, width=p.width, opacity=p.opacity, author=p.author
        )
        index = add_annot(pdf, page, annot)
        new_id = make_id(ANNOT_PREFIX, p.page_index, annot_digest(page), index)
        ctx.save_document(pdf)
    return OpOutput(changed_pages=[p.page_index], data={"id": new_id})


class AnnotsAddShapeParams(WireModel):
    """A line, an arrow, a rectangle or an ellipse. Give points (line, arrow) or rect."""

    page_index: int = Field(ge=0)
    kind: ShapeKind
    rect: list[float] | None = Field(default=None, min_length=4, max_length=4)
    points: list[float] | None = Field(default=None, min_length=4, max_length=4)
    color: str | None = Field(default=None, pattern=HEX_PATTERN)
    fill: str | None = Field(default=None, pattern=HEX_PATTERN)
    width: float = Field(default=1.5, gt=0, le=40)
    author: str = ""


@operation(
    id="annots.addShape",
    title="Add a shape",
    group="annots",
    params=AnnotsAddShapeParams,
    destructive=True,
)
def annots_add_shape(ctx: OpContext, p: AnnotsAddShapeParams) -> OpOutput:
    _need(ctx, "annots.addShape")
    with ctx.open_input() as pdf:
        _page_check(pdf, p.page_index)
        page = pdf.pages[p.page_index]
        frame = page_frame(page)
        rect = None
        if p.rect is not None:
            rect = user_rect(frame, (p.rect[0], p.rect[1], p.rect[2], p.rect[3]))
        points = None
        if p.points is not None:
            x1, y1, x2, y2 = p.points
            points = [user_point(frame, x1, y1), user_point(frame, x2, y2)]
        annot = shape_dict(
            pdf,
            p.kind,
            rect=rect,
            points=points,
            colour=p.color,
            fill=p.fill,
            width=p.width,
            author=p.author,
            arrow=p.kind == "arrow",
        )
        index = add_annot(pdf, page, annot)
        new_id = make_id(ANNOT_PREFIX, p.page_index, annot_digest(page), index)
        ctx.save_document(pdf)
    return OpOutput(changed_pages=[p.page_index], data={"id": new_id})


# -- change and review ------------------------------------------------------------------------


class AnnotsUpdateParams(WireModel):
    """Change the text, author, colour, opacity or (for notes, free text, ink, shapes) the rect."""

    id: str
    contents: str | None = None
    author: str | None = None
    color: str | None = Field(default=None, pattern=HEX_PATTERN)
    opacity: float | None = Field(default=None, ge=0, le=1)
    rect: list[float] | None = Field(default=None, min_length=4, max_length=4)


@operation(
    id="annots.update",
    title="Change an annotation",
    group="annots",
    params=AnnotsUpdateParams,
    destructive=True,
)
def annots_update(ctx: OpContext, p: AnnotsUpdateParams) -> OpOutput:
    _need(ctx, "annots.update")
    box = None
    if p.rect is not None:
        x0, t, x1, b = p.rect
        if x1 <= x0 or b <= t:
            raise invalid_params("INVALID_RECT", {"rect": p.rect})
        box = (x0, t, x1, b)
    with ctx.open_input() as pdf:
        new_id = update_annot(
            pdf,
            p.id,
            contents=p.contents,
            author=p.author,
            colour=p.color,
            opacity=p.opacity,
            box=box,
        )
        ctx.save_document(pdf)
    return OpOutput(changed_pages="all", data={"id": new_id})


class AnnotsRemoveParams(WireModel):
    """Remove annotations by id."""

    ids: list[str] = Field(min_length=1)


@operation(
    id="annots.remove",
    title="Remove annotations",
    group="annots",
    params=AnnotsRemoveParams,
    destructive=True,
)
def annots_remove(ctx: OpContext, p: AnnotsRemoveParams) -> OpOutput:
    _need(ctx, "annots.remove")
    with ctx.open_input() as pdf:
        removed = remove_annots(pdf, p.ids)
        ctx.save_document(pdf)
    return OpOutput(changed_pages="all", data={"removed": removed})


class AnnotsRemoveAllParams(WireModel):
    """Remove every annotation of the given subtypes (default: all but links and form fields)."""

    kinds: list[str] | None = None
    page_index: int | None = Field(default=None, ge=0)


@operation(
    id="annots.removeAll",
    title="Remove annotations by kind",
    group="annots",
    params=AnnotsRemoveAllParams,
    destructive=True,
)
def annots_remove_all(ctx: OpContext, p: AnnotsRemoveAllParams) -> OpOutput:
    _need(ctx, "annots.removeAll")
    with ctx.open_input() as pdf:
        indices = [p.page_index] if p.page_index is not None else list(range(len(pdf.pages)))
        for i in indices:
            _page_check(pdf, i)
        removed = remove_all(pdf, set(p.kinds) if p.kinds else None, indices)
        if removed:
            ctx.save_document(pdf)
    return OpOutput(changed_pages="all" if removed else [], data={"removed": removed})


class AnnotsReplyParams(WireModel):
    """Answer an annotation with a text reply (threaded through /IRT)."""

    id: str
    text: str = Field(min_length=1)
    author: str = ""
    color: str | None = Field(default=None, pattern=HEX_PATTERN)


@operation(
    id="annots.reply",
    title="Reply to an annotation",
    group="annots",
    params=AnnotsReplyParams,
    destructive=True,
)
def annots_reply(ctx: OpContext, p: AnnotsReplyParams) -> OpOutput:
    _need(ctx, "annots.reply")
    with ctx.open_input() as pdf:
        new_id = reply(pdf, p.id, text=p.text, author=p.author, colour=p.color)
        ctx.save_document(pdf)
    return OpOutput(changed_pages="all", data={"id": new_id})


class AnnotsSetStatusParams(WireModel):
    """Review status of an annotation (/State with /StateModel /Review)."""

    id: str
    status: Status


@operation(
    id="annots.setStatus",
    title="Set review status",
    group="annots",
    params=AnnotsSetStatusParams,
    destructive=True,
)
def annots_set_status(ctx: OpContext, p: AnnotsSetStatusParams) -> OpOutput:
    _need(ctx, "annots.setStatus")
    with ctx.open_input() as pdf:
        new_id = set_status(pdf, p.id, p.status)
        ctx.save_document(pdf)
    return OpOutput(changed_pages="all", data={"id": new_id})


__all__ = [
    "AnnotsAddFreeTextParams",
    "AnnotsAddInkParams",
    "AnnotsAddNoteParams",
    "AnnotsAddShapeParams",
    "AnnotsAddTextMarkupParams",
    "AnnotsListParams",
    "AnnotsRemoveAllParams",
    "AnnotsRemoveParams",
    "AnnotsReplyParams",
    "AnnotsSetStatusParams",
    "AnnotsUpdateParams",
]
