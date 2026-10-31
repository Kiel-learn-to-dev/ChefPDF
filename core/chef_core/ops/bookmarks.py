"""Bookmarks / outline (T4.03, D3): bookmarks.get, set, fromPages and clear.

``bookmarks.get`` is read-only: a tree of ``{title, page, view, open, color, bold, italic,
children}``. ``page`` is a 0-based index (null for an item without a page). ``view`` is
``{type: fit|xyz, left, top, zoom}`` (null without a page); other fit types read back as ``fit``.

``bookmarks.set`` replaces the whole tree. A node without ``view`` (or with ``fit``) gets /Fit;
``xyz`` gets /XYZ with the given left, top and zoom (null keeps the viewer's value). ``open`` only
matters for a node with children. ``color`` is ``#RRGGBB``.

``bookmarks.fromPages`` makes one bookmark per selected page from a title template (``replace``
the tree, or ``append`` at the end). The variables are those of ``overlay.headerFooter``.

Every change goes through the session like other operations, so undo and redo work.
"""

from __future__ import annotations

from typing import Any, Literal

import pikepdf
from pikepdf import Array, Name, OutlineItem, OutlineItemFlag
from pydantic import Field, model_validator

from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.ops.overlay import HexColor, PageSelection, hex_color, page_selection
from chef_core.ops.overlay_header import document_vars
from chef_core.overlay.variables import check_template
from chef_core.pdf.outline import Bookmark, read_bookmarks, write_outline
from chef_core.pdf.pages import check_indices, page_objgen_index

MAX_BOOKMARKS = 5000
MAX_DEPTH = 20
MAX_TITLE = 500
Rgb = tuple[float, float, float]
NULL = pikepdf.Object.parse(b"null")


# -- parameters -------------------------------------------------------------------------


class BookmarkView(WireModel):
    """Where the bookmark opens the page. ``fit`` shows the whole page; ``xyz`` uses the position
    and zoom (null keeps the viewer's current value)."""

    type: Literal["fit", "xyz"] = Field(default="fit")
    left: float | None = Field(default=None)
    top: float | None = Field(default=None)
    zoom: float | None = Field(default=None, gt=0)


class BookmarkNode(WireModel):
    title: str = Field(min_length=1, max_length=MAX_TITLE)
    page: int | None = Field(default=None, ge=0, description="0-based page; null for none.")
    view: BookmarkView | None = Field(default=None)
    open: bool = Field(default=True, description="Shown expanded (only with children).")
    color: HexColor | None = Field(default=None)
    bold: bool = Field(default=False)
    italic: bool = Field(default=False)
    children: list[BookmarkNode] = Field(default_factory=list)


class GetBookmarksParams(WireModel):
    """No parameters: reads the outline of the current revision."""


class SetBookmarksParams(WireModel):
    """Replace the whole outline with ``bookmarks`` (an empty list clears it)."""

    bookmarks: list[BookmarkNode] = Field(default_factory=list)

    @model_validator(mode="after")
    def _limits(self) -> SetBookmarksParams:
        count, depth = _measure(self.bookmarks, 1)
        if count > MAX_BOOKMARKS:
            raise ValueError(f"at most {MAX_BOOKMARKS} bookmarks")
        if depth > MAX_DEPTH:
            raise ValueError(f"nesting deeper than {MAX_DEPTH} levels")
        return self


class ClearBookmarksParams(WireModel):
    """No parameters: removes every bookmark."""


class FromPagesParams(PageSelection):
    """One bookmark per selected page. ``template`` takes the page variables (default
    "Trang {page}"). ``mode`` replace drops the existing outline, append adds at the end."""

    template: str = Field(default="Trang {page}", min_length=1, max_length=MAX_TITLE)
    start_number: int = Field(default=1, ge=0, le=1_000_000_000)
    mode: Literal["replace", "append"] = Field(default="replace")
    date_format: str = Field(default="dd/MM/yyyy", min_length=1, max_length=40)


def _measure(nodes: list[BookmarkNode], depth: int) -> tuple[int, int]:
    count = len(nodes)
    deepest = depth if nodes else depth - 1
    for node in nodes:
        sub_count, sub_depth = _measure(node.children, depth + 1)
        count += sub_count
        deepest = max(deepest, sub_depth)
    return count, deepest


def _pages_of(nodes: list[BookmarkNode]) -> list[int]:
    found: list[int] = []
    for node in nodes:
        if node.page is not None:
            found.append(node.page)
        found.extend(_pages_of(node.children))
    return found


# -- conversions ------------------------------------------------------------------------


def _number(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _view_dict(view: list[pikepdf.Object]) -> dict[str, Any]:
    kind = str(view[0]).lstrip("/") if view else "Fit"
    if kind == "XYZ":
        values = [_number(v) for v in view[1:4]] + [None, None, None]
        return {"type": "xyz", "left": values[0], "top": values[1], "zoom": values[2]}
    return {"type": "fit", "left": None, "top": None, "zoom": None}


def _hex(colour: Rgb) -> str:
    red, green, blue = (round(c * 255) for c in colour)
    return f"#{red:02X}{green:02X}{blue:02X}"


def _read_tree(pdf: pikepdf.Pdf) -> list[dict[str, Any]]:
    index = page_objgen_index(pdf)

    def convert(nodes: list[Bookmark]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for bm in nodes:
            page = index.get(bm.page) if bm.page is not None else None
            out.append(
                {
                    "title": bm.title,
                    "page": page,
                    "view": _view_dict(bm.view) if page is not None else None,
                    "open": bm.is_open if bm.children else True,
                    "color": _hex(bm.color) if bm.color is not None else None,
                    "bold": bm.bold,
                    "italic": bm.italic,
                    "children": convert(bm.children),
                }
            )
        return out

    return convert(read_bookmarks(pdf))


def _null_or(value: float | None) -> float | pikepdf.Object:
    return NULL if value is None else float(value)


def _destination(pdf: pikepdf.Pdf, node: BookmarkNode) -> pikepdf.Array | None:
    if node.page is None:
        return None
    page = pdf.pages[node.page].obj
    view = node.view
    if view is None or view.type == "fit":
        return Array([page, Name.Fit])
    return Array([page, Name.XYZ, _null_or(view.left), _null_or(view.top), _null_or(view.zoom)])


def _items(pdf: pikepdf.Pdf, nodes: list[BookmarkNode]) -> list[OutlineItem]:
    items: list[OutlineItem] = []
    for node in nodes:
        flags = OutlineItemFlag.NONE
        if node.bold:
            flags |= OutlineItemFlag.Bold
        if node.italic:
            flags |= OutlineItemFlag.Italic
        colour = hex_color(node.color) if node.color is not None else None
        item = OutlineItem(node.title, _destination(pdf, node), color=colour, flags=flags)
        children = _items(pdf, node.children)
        item.children.extend(children)
        if children and not node.open:
            item.is_closed = True
        items.append(item)
    return items


# -- ops --------------------------------------------------------------------------------


@operation(id="bookmarks.get", title="Read bookmarks", group="bookmarks", params=GetBookmarksParams)
def get_bookmarks(ctx: OpContext, p: GetBookmarksParams) -> OpOutput:
    del p
    with ctx.open_input() as pdf:
        tree = _read_tree(pdf)
    return OpOutput(changed_pages=[], data={"bookmarks": tree, "count": _count(tree)})


def _count(tree: list[dict[str, Any]]) -> int:
    return sum(1 + _count(node["children"]) for node in tree)


@operation(
    id="bookmarks.set",
    title="Edit bookmarks",
    group="bookmarks",
    params=SetBookmarksParams,
    destructive=True,
)
def set_bookmarks(ctx: OpContext, p: SetBookmarksParams) -> OpOutput:
    with ctx.open_input() as pdf:
        check_indices(_pages_of(p.bookmarks), len(pdf.pages), "page")
        write_outline(pdf, _items(pdf, p.bookmarks))
        ctx.save_document(pdf)
        count = _measure(p.bookmarks, 1)[0]
    return OpOutput(changed_pages=[], data={"count": count})


@operation(
    id="bookmarks.clear",
    title="Remove all bookmarks",
    group="bookmarks",
    params=ClearBookmarksParams,
    destructive=True,
)
def clear_bookmarks(ctx: OpContext, p: ClearBookmarksParams) -> OpOutput:
    del p
    with ctx.open_input() as pdf:
        write_outline(pdf, [])
        ctx.save_document(pdf)
    return OpOutput(changed_pages=[], data={"count": 0})


@operation(
    id="bookmarks.fromPages",
    title="Bookmarks from pages",
    group="bookmarks",
    params=FromPagesParams,
    destructive=True,
)
def from_pages(ctx: OpContext, p: FromPagesParams) -> OpOutput:
    check_template(p.template)
    with ctx.open_input() as pdf:
        count = len(pdf.pages)
        pages = page_selection(p.pages, p.page_range, count)
        values = document_vars(
            pdf, doc_name=ctx.doc_name, start_number=p.start_number, date_format=p.date_format
        )
        new = [
            OutlineItem(
                values.render(p.template, index)[:MAX_TITLE],
                Array([pdf.pages[index].obj, Name.Fit]),
            )
            for index in pages
        ]
        if p.mode == "replace":
            write_outline(pdf, new)
        else:
            with pdf.open_outline() as outline:
                outline.root.extend(new)
        ctx.save_document(pdf)
    return OpOutput(changed_pages=[], data={"count": len(new)})
