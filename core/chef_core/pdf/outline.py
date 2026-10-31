"""Outline (bookmark) helpers.

Destinations are resolved to page objects so bookmarks can be kept valid when pages are
deleted, reordered or copied into another document.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

import pikepdf
from pikepdf import Array, Name, OutlineItem, OutlineItemFlag

log = logging.getLogger(__name__)

ObjGen = tuple[int, int]


class _NamedDests:
    """Lazy lookup of named destinations (/Names /Dests name tree and legacy /Dests)."""

    def __init__(self, pdf: pikepdf.Pdf) -> None:
        self._pdf = pdf
        self._tree: pikepdf.NameTree | None = None
        self._legacy: pikepdf.Object | None = None
        root = pdf.Root
        names = root.get("/Names")
        if isinstance(names, pikepdf.Dictionary) and "/Dests" in names:
            try:
                self._tree = pikepdf.NameTree(names.Dests)
            except Exception:  # pragma: no cover - malformed tree
                self._tree = None
        legacy = root.get("/Dests")
        if isinstance(legacy, pikepdf.Dictionary):
            self._legacy = legacy

    def lookup(self, key: pikepdf.Object) -> pikepdf.Object | None:
        value: pikepdf.Object | None = None
        if isinstance(key, pikepdf.Name) and self._legacy is not None:
            value = self._legacy.get(key)
        elif isinstance(key, pikepdf.String) and self._tree is not None:
            try:
                value = self._tree.get(str(key))
            except Exception:
                value = None
        if isinstance(value, pikepdf.Dictionary):
            value = value.get("/D")
        return value


def _explicit_dest(item: OutlineItem, named: _NamedDests) -> pikepdf.Array | None:
    dest: pikepdf.Object | int | None = item.destination
    if dest is None and item.action is not None:
        action = item.action
        if action.get("/S") == Name.GoTo:
            dest = action.get("/D")
    if isinstance(dest, pikepdf.Name | pikepdf.String):
        dest = named.lookup(dest)
    if isinstance(dest, pikepdf.Array) and len(dest) >= 1:
        return dest
    return None


def _dest_page(dest: pikepdf.Array | None) -> pikepdf.Object | None:
    if dest is None:
        return None
    target = dest[0]
    if isinstance(target, pikepdf.Dictionary):
        return target
    return None  # page given as a number (remote-style) or garbage


@dataclass
class Bookmark:
    """A resolved outline node detached from any document."""

    title: str
    page: ObjGen | None
    view: list[pikepdf.Object]
    is_open: bool
    children: list[Bookmark] = field(default_factory=list)
    color: tuple[float, float, float] | None = None
    bold: bool = False
    italic: bool = False
    # Original destination/action when no page could be resolved (e.g. a URI action).
    # Only reused when rewriting the outline of the same document.
    raw_destination: pikepdf.Array | pikepdf.String | pikepdf.Name | int | None = None
    raw_action: pikepdf.Dictionary | None = None


def read_bookmarks(pdf: pikepdf.Pdf) -> list[Bookmark]:
    """Read the outline tree, resolving each destination to a page objgen (or None)."""
    named = _NamedDests(pdf)

    def convert(items: list[OutlineItem]) -> list[Bookmark]:
        result = []
        for item in items:
            dest = _explicit_dest(item, named)
            page = _dest_page(dest)
            view = list(dest[1:]) if dest is not None else []
            result.append(
                Bookmark(
                    title=str(item.title or ""),
                    page=page.objgen if page is not None else None,
                    view=view,
                    is_open=bool(item.is_closed is False),
                    children=convert(list(item.children)),
                    raw_destination=item.destination if page is None else None,
                    raw_action=item.action if page is None else None,
                    color=_colour(item.color),
                    bold=bool(item.bold),
                    italic=bool(item.italic),
                )
            )
        return result

    try:
        with pdf.open_outline() as outline:
            return convert(list(outline.root))
    except Exception as exc:
        log.warning("could not read outline: %s", exc)
        return []


def _colour(value: object) -> tuple[float, float, float] | None:
    """The /C colour of an outline item as RGB floats, or None when absent or malformed."""
    if value is None:
        return None
    try:
        red, green, blue = (float(v) for v in value)  # type: ignore[attr-defined]
    except (TypeError, ValueError):
        return None
    return (red, green, blue)


def _style(bm: Bookmark) -> dict[str, Any]:
    """Colour and style keywords for an outline item (the /C and /F entries)."""
    flags = OutlineItemFlag.NONE
    if bm.bold:
        flags |= OutlineItemFlag.Bold
    if bm.italic:
        flags |= OutlineItemFlag.Italic
    return {"color": bm.color, "flags": flags}


def _copy_view(view: list[pikepdf.Object]) -> list[pikepdf.Object]:
    # Only keep simple values (numbers, names, null) so nothing foreign leaks in.
    out: list[pikepdf.Object] = []
    for value in view:
        if isinstance(value, pikepdf.Name):
            out.append(pikepdf.Name(str(value)))
        elif isinstance(value, pikepdf.Object) and value.is_indirect:
            out.append(pikepdf.Object.parse(b"null"))
        else:
            out.append(value)
    return out or [Name.Fit]


def build_items(
    bookmarks: list[Bookmark],
    page_map: Mapping[ObjGen, pikepdf.Object],
    *,
    same_document: bool = False,
) -> list[OutlineItem]:
    """Create outline items for a target document.

    ``page_map`` maps source page objgens to target page objects. Bookmarks whose page is
    not in the map are dropped, but their children are kept (promoted one level).
    Bookmarks without a resolvable page keep their original destination/action when
    ``same_document`` is true; otherwise they are kept (without target) only if they still
    have children.
    """
    result: list[OutlineItem] = []
    for bm in bookmarks:
        children = build_items(bm.children, page_map, same_document=same_document)
        target = page_map.get(bm.page) if bm.page is not None else None
        if target is None and bm.page is not None:
            result.extend(children)
            continue
        if target is not None:
            item = OutlineItem(bm.title, Array([target, *_copy_view(bm.view)]), **_style(bm))
        elif same_document and (bm.raw_destination is not None or bm.raw_action is not None):
            item = OutlineItem(bm.title, bm.raw_destination, action=bm.raw_action, **_style(bm))
        elif children:
            item = OutlineItem(bm.title, **_style(bm))
        else:
            continue
        item.children.extend(children)
        if children and bm.is_open is False:
            item.is_closed = True
        result.append(item)
    return result


def write_outline(pdf: pikepdf.Pdf, items: list[OutlineItem]) -> None:
    """Replace the whole outline of ``pdf`` with ``items``."""
    with pdf.open_outline() as outline:
        outline.root.clear()
        outline.root.extend(items)


def remap_outline(pdf: pikepdf.Pdf, bookmarks: list[Bookmark]) -> None:
    """Rewrite the outline of ``pdf`` after its page set changed.

    ``bookmarks`` were read before the change; pages are matched by object identity.
    """
    if not bookmarks:
        return
    page_map = {page.obj.objgen: page.obj for page in pdf.pages}
    write_outline(pdf, build_items(bookmarks, page_map, same_document=True))
