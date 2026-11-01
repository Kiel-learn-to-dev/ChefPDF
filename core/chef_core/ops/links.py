"""Links (milestone v0.7, D11). See ``chef_core.annots.links`` for the model.

- ``links.list`` (read-only) {pageIndex?}: every link annotation (of one page, or all). Each has an
  id (``K<page>:<digest>:<n>``), kind (uri | page | named | file | javascript), target, view and
  top/left for page targets, rect (displayed frame, points, origin top-left), borderWidth, colour,
  highlight, and flagged (true for JavaScript actions, which are listed but never created).
- ``links.add`` (destructive) {pageIndex, rect, kind: uri|page, uri | targetPage, view fit|xyz,
  left, top, borderWidth, color, highlight}: a link. rect is the displayed frame. A page link is
  a /Dest in the target page's frame; xyz uses left and top (displayed points) on that page.
- ``links.update`` (destructive) {id, rect?, uri?, targetPage?, view?, left?, top?, borderWidth?,
  color?, highlight?}: returns the new id (ids change with the page's annotations).
- ``links.remove`` (destructive) {ids? | all?, pageIndex?}: by id, or every link (of one page when
  pageIndex is given).
- ``links.autoDetect`` (destructive) {pages?, skipExisting}: URI links for http(s)://, www. and
  e-mail addresses in the text of the pages. Result: created (count) and links (ids).

JavaScript URIs (javascript:, vbscript:, file:) are refused as link targets.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import Field

from chef_core.annots.links import add_link, detect_links, list_links, remove_links, update_link
from chef_core.errors import invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation

Highlight = Literal["none", "invert", "outline"]
View = Literal["fit", "xyz"]
HEX_PATTERN = r"^#[0-9a-fA-F]{6}$"


def _need_session(ctx: OpContext, name: str) -> None:
    if ctx.input_path is None:
        raise RuntimeError(f"{name} needs a session")


def _box(rect: list[float]) -> tuple[float, float, float, float]:
    x0, t, x1, b = rect
    if x1 <= x0 or b <= t:
        raise invalid_params("INVALID_RECT", {"rect": rect})
    return (x0, t, x1, b)


class LinksListParams(WireModel):
    """Links of one page, or of every page when pageIndex is left out."""

    page_index: int | None = Field(default=None, ge=0)


@operation(id="links.list", title="List links", group="links", params=LinksListParams)
def links_list(ctx: OpContext, p: LinksListParams) -> OpOutput:
    _need_session(ctx, "links.list")
    assert ctx.input_path is not None

    with ctx.open_input() as pdf:
        indices = [p.page_index] if p.page_index is not None else list(range(len(pdf.pages)))
        for i in indices:
            if i >= len(pdf.pages):
                raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": i})
        links: list[dict[str, Any]] = []
        for i in indices:
            links += list_links(pdf, i)
    return OpOutput(changed_pages=[], data={"links": links})


class LinksAddParams(WireModel):
    """A link on one page. rect is (left, top, right, bottom) in the displayed frame."""

    page_index: int = Field(ge=0)
    rect: list[float] = Field(min_length=4, max_length=4)
    kind: Literal["uri", "page"]
    uri: str | None = Field(default=None, min_length=1, max_length=2000)
    target_page: int | None = Field(default=None, ge=0)
    view: View = "fit"
    left: float | None = Field(default=None, description="xyz: displayed x (points).")
    top: float | None = Field(default=None, description="xyz: displayed y (points), default top.")
    border_width: float = Field(default=0.0, ge=0, le=20)
    color: str | None = Field(default=None, pattern=HEX_PATTERN)
    highlight: Highlight = "invert"


@operation(
    id="links.add", title="Add a link", group="links", params=LinksAddParams, destructive=True
)
def links_add(ctx: OpContext, p: LinksAddParams) -> OpOutput:
    _need_session(ctx, "links.add")
    assert ctx.input_path is not None and ctx.result_path is not None
    if p.kind == "uri" and not p.uri:
        raise invalid_params("LINK_URI_MISSING", {})
    if p.kind == "page" and p.target_page is None:
        raise invalid_params("LINK_TARGET_MISSING", {})
    box = _box(p.rect)
    with ctx.open_input() as pdf:
        if p.page_index >= len(pdf.pages):
            raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": p.page_index})
        new_id = add_link(
            pdf,
            p.page_index,
            box,
            uri=p.uri if p.kind == "uri" else None,
            target_page=p.target_page if p.kind == "page" else None,
            view=p.view,
            left=p.left,
            top=p.top,
            border_width=p.border_width,
            colour=p.color,
            highlight=p.highlight,
        )
        ctx.save_document(pdf)
    return OpOutput(changed_pages=[p.page_index], data={"id": new_id})


class LinksUpdateParams(WireModel):
    """Change one link. Give uri or targetPage to change its target."""

    id: str
    rect: list[float] | None = Field(default=None, min_length=4, max_length=4)
    uri: str | None = Field(default=None, min_length=1, max_length=2000)
    target_page: int | None = Field(default=None, ge=0)
    view: View | None = None
    left: float | None = None
    top: float | None = None
    border_width: float | None = Field(default=None, ge=0, le=20)
    color: str | None = Field(default=None, pattern=HEX_PATTERN)
    highlight: Highlight | None = None


@operation(
    id="links.update",
    title="Change a link",
    group="links",
    params=LinksUpdateParams,
    destructive=True,
)
def links_update(ctx: OpContext, p: LinksUpdateParams) -> OpOutput:
    _need_session(ctx, "links.update")
    assert ctx.input_path is not None and ctx.result_path is not None
    if p.uri is not None and p.target_page is not None:
        raise invalid_params("LINK_TWO_TARGETS", {})
    box = _box(p.rect) if p.rect is not None else None
    with ctx.open_input() as pdf:
        new_id = update_link(
            pdf,
            p.id,
            box=box,
            uri=p.uri,
            target_page=p.target_page,
            view=p.view,
            left=p.left,
            top=p.top,
            border_width=p.border_width,
            colour=p.color,
            highlight=p.highlight,
        )
        ctx.save_document(pdf)
    return OpOutput(changed_pages="all", data={"id": new_id})


class LinksRemoveParams(WireModel):
    """Remove links by id, or every link (of one page when pageIndex is given)."""

    ids: list[str] | None = None
    all: bool = False
    page_index: int | None = Field(default=None, ge=0)


@operation(
    id="links.remove",
    title="Remove links",
    group="links",
    params=LinksRemoveParams,
    destructive=True,
)
def links_remove(ctx: OpContext, p: LinksRemoveParams) -> OpOutput:
    _need_session(ctx, "links.remove")
    assert ctx.input_path is not None and ctx.result_path is not None
    if (p.ids is None) == (not p.all):
        raise invalid_params("LINKS_REMOVE_NEEDS_IDS_OR_ALL", {})
    with ctx.open_input() as pdf:
        removed = remove_links(pdf, p.ids, p.page_index if p.all else None)
        ctx.save_document(pdf)
    return OpOutput(changed_pages="all", data={"removed": removed})


class LinksAutoDetectParams(WireModel):
    """URI links for the web and e-mail addresses in the text."""

    pages: list[int] | None = Field(default=None, description="0-based pages; default all.")
    skip_existing: bool = Field(
        default=True, description="Do not add a link where a link already covers the text."
    )


@operation(
    id="links.autoDetect",
    title="Detect web links in the text",
    group="links",
    params=LinksAutoDetectParams,
    destructive=True,
)
def links_auto_detect(ctx: OpContext, p: LinksAutoDetectParams) -> OpOutput:
    _need_session(ctx, "links.autoDetect")
    assert ctx.input_path is not None and ctx.result_path is not None
    with ctx.open_input() as pdf:
        created = detect_links(pdf, p.pages, p.skip_existing)
        changed = sorted({c["pageIndex"] for c in created})
        if created:
            ctx.save_document(pdf)
    return OpOutput(
        changed_pages=changed,
        data={"created": len(created), "links": created},
    )


__all__ = [
    "LinksAddParams",
    "LinksAutoDetectParams",
    "LinksListParams",
    "LinksRemoveParams",
    "LinksUpdateParams",
    "links_add",
    "links_auto_detect",
    "links_list",
    "links_remove",
    "links_update",
]
