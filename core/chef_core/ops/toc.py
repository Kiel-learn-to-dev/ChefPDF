"""Table of contents from detected headings (milestone v0.10, D12).

- ``toc.preview`` (read-only) {maxLevel, minConfidence, includeNumbering}: the bookmark tree that
  ``toc.fromHeadings`` would write, in the shape of ``bookmarks.get``.
- ``toc.fromHeadings`` (destructive) {maxLevel, minConfidence, mode, includeNumbering}: writes the
  tree as bookmarks. ``mode`` replace drops the existing outline; append adds the tree at the end.
  Destinations are /XYZ at the top of each heading.

Headings come from ``chef_core.layout.detect`` (font size clusters, bold lines, numbering). Only
headings at or above ``minConfidence`` and at most ``maxLevel`` deep are used; a heading that is
filtered out does not break the nesting of the ones kept.

``toc.insertPage`` (a generated contents page with links) is not implemented in this milestone.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import Field

from chef_core.layout.detect import DetectOptions, HeadingRef, build_doc_model
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


__all__ = ["TocFromHeadingsParams", "TocParams", "from_headings", "preview"]
