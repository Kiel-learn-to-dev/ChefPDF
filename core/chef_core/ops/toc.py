"""Table of contents from detected headings (milestone v0.10, D12).

- ``toc.preview`` (read-only) {maxLevel, minConfidence, includeNumbering}: the bookmark tree that
  ``toc.fromHeadings`` would write, in the shape of ``bookmarks.get``.
- ``toc.fromHeadings`` (destructive) {maxLevel, minConfidence, mode, includeNumbering}: writes the
  tree as bookmarks. ``mode`` replace drops the existing outline; append adds the tree at the end.
  Destinations are /XYZ at the top of each heading.

Headings come from ``chef_core.layout.detect`` (font size clusters, bold lines, numbering). Only
headings at or above ``minConfidence`` and at most ``maxLevel`` deep are used; a heading that is
filtered out does not break the nesting of the ones kept.

``toc.insertPage`` inserts a generated Vietnamese contents page at the front of the PDF.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import Field, model_validator

from chef_core.errors import invalid_params
from chef_core.layout.detect import DetectOptions, HeadingRef, build_doc_model
from chef_core.layout.toc_page import insert_contents
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.ops.bookmarks import MAX_TITLE, BookmarkNode, _items
from chef_core.pdf.outline import write_outline

NUMBERING = re.compile(
    r"^\s*(?:\d+(?:\.\d+)*[.)]?|[IVXLC]+[.)]"
    r"|(?:chương|phần|mục|điều|chapter|article|section|part)\s+[\dIVXLC]+[.:]?)\s*",
    re.IGNORECASE,
)


class TocParams(WireModel):
    max_level: int = Field(default=3, ge=1, le=6)
    min_confidence: float = Field(default=0.6, ge=0.0, le=1.0)
    include_numbering: bool = Field(default=True, description="Keep '1.2' or 'Điều 3.' in titles.")


class TocFromHeadingsParams(TocParams):
    mode: Literal["replace", "append"] = Field(default="replace")


class TocInsertPageParams(TocParams):
    title: str = Field(default="Mục lục", min_length=1, max_length=100)
    placement: Literal["front", "back", "afterPage"] = "front"
    after_page: int | None = Field(default=None, ge=1, description="1-based page number")
    page_size: Literal["source", "a4"] = "source"
    dot_leader: bool = True
    page_number_offset: int = Field(default=0, ge=-100_000, le=100_000)
    font_scale: float = Field(default=1.0, ge=0.5, le=2.0)
    link_entries: bool = True
    add_bookmark: bool = Field(
        default=False,
        description="Append generated heading bookmarks to the existing outline.",
    )

    @model_validator(mode="after")
    def _placement_page(self) -> TocInsertPageParams:
        if self.placement == "afterPage" and self.after_page is None:
            raise ValueError("afterPage placement requires afterPage")
        if self.placement != "afterPage" and self.after_page is not None:
            raise ValueError("afterPage is only valid with afterPage placement")
        return self


def _title(text: str, include_numbering: bool) -> str:
    if include_numbering:
        return text[:MAX_TITLE]
    stripped = NUMBERING.sub("", text, count=1).strip()
    return (stripped or text)[:MAX_TITLE]


def _selected(headings: list[HeadingRef], p: TocParams) -> list[HeadingRef]:
    return [h for h in headings if h.level <= p.max_level and h.confidence >= p.min_confidence]


def _tree(headings: list[HeadingRef], p: TocParams) -> list[dict[str, Any]]:
    """Nest the headings by level (a stack): each heading goes under the last one that is higher."""
    roots: list[dict[str, Any]] = []
    stack: list[tuple[int, dict[str, Any]]] = []
    for h in _selected(headings, p):
        node: dict[str, Any] = {
            "title": _title(h.text, p.include_numbering),
            "page": h.page,
            "view": {"type": "xyz", "left": None, "top": round(h.top, 3), "zoom": None},
            "open": True,
            "color": None,
            "bold": False,
            "italic": False,
            "children": [],
        }
        while stack and stack[-1][0] >= h.level:
            stack.pop()
        (stack[-1][1]["children"] if stack else roots).append(node)
        stack.append((h.level, node))
    return roots


def _count(tree: list[dict[str, Any]]) -> int:
    return sum(1 + _count(node["children"]) for node in tree)


def _analysis(ctx: OpContext) -> list[HeadingRef]:
    with ctx.open_input() as pdf:
        return build_doc_model(pdf, None, DetectOptions(), name=ctx.doc_name).headings


@operation(id="toc.preview", title="Preview table of contents", group="toc", params=TocParams)
def preview(ctx: OpContext, p: TocParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("toc.preview needs a session")
    tree = _tree(_analysis(ctx), p)
    return OpOutput(changed_pages=[], data={"bookmarks": tree, "count": _count(tree)})


@operation(
    id="toc.fromHeadings",
    title="Bookmarks from headings",
    group="toc",
    params=TocFromHeadingsParams,
    destructive=True,
)
def from_headings(ctx: OpContext, p: TocFromHeadingsParams) -> OpOutput:
    tree = _tree(_analysis(ctx), p)
    nodes = [BookmarkNode.model_validate(node) for node in tree]
    with ctx.open_input() as pdf:
        items = _items(pdf, nodes)
        if p.mode == "replace":
            write_outline(pdf, items)
        else:
            with pdf.open_outline() as outline:
                outline.root.extend(items)
        ctx.save_document(pdf)
    return OpOutput(changed_pages=[], data={"count": _count(tree)})


@operation(
    id="toc.insertPage",
    title="Insert a table of contents page",
    group="toc",
    params=TocInsertPageParams,
    destructive=True,
)
def insert_page(ctx: OpContext, p: TocInsertPageParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("toc.insertPage needs a session")
    headings = _tree(_analysis(ctx), p)
    with ctx.open_input() as pdf:
        original_page_count = len(pdf.pages)
        if p.placement == "front":
            insertion_index = 0
        elif p.placement == "back":
            insertion_index = original_page_count
        else:
            assert p.after_page is not None
            if p.after_page > original_page_count:
                raise invalid_params("afterPage is outside the document", {"field": "afterPage"})
            insertion_index = p.after_page
        count = insert_contents(
            pdf,
            headings,
            title=p.title,
            insertion_index=insertion_index,
            page_size=p.page_size,
            dot_leader=p.dot_leader,
            page_number_offset=p.page_number_offset,
            font_scale=p.font_scale,
            link_entries=p.link_entries,
        )
        if p.add_bookmark:
            node = BookmarkNode(title=p.title, page=insertion_index)
            items = _items(pdf, [node])
            with pdf.open_outline() as outline:
                outline.root.extend(items)
        ctx.save_document(pdf)
    return OpOutput(
        changed_pages="all",
        data={"count": _count(headings), "insertedPages": count, "insertionIndex": insertion_index},
    )


__all__ = [
    "TocFromHeadingsParams",
    "TocInsertPageParams",
    "TocParams",
    "from_headings",
    "insert_page",
    "preview",
]
