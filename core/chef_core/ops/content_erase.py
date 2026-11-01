"""Erase a rectangle of a page (T6.03, D5 'tẩy vùng').

``content.eraseRegion`` takes one page (``pageIndex``) or several (``pages``) and a rectangle in the
displayed frame (points, origin top-left):

- ``mode='cut'`` removes what is painted inside (text glyphs, image pixels, vector parts), see
  ``chef_core.content.erase``. Pixels outside the rectangle keep their values.
- ``mode='cover'`` paints a filled rectangle over it and leaves the content underneath. ``color``
  is ``'auto'`` (median of the pixels around the rectangle in a render) or ``#rrggbb``.

``partial=false`` only removes objects lying completely inside the rectangle.
"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from chef_core.content.editor import PageEditor
from chef_core.content.engine import build_model
from chef_core.content.erase import (
    CutOptions,
    CutStats,
    cut_page,
    paint_rects,
    rect_user_from_display,
    sample_background,
)
from chef_core.errors import invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.overlay.pagecontent import page_frame

_HEX_LEN = 7


class ContentEraseRegionParams(WireModel):
    """Erase a rectangle (displayed frame, points, origin top-left) on one or more pages."""

    page_index: int | None = Field(default=None, ge=0, description="One 0-based page.")
    pages: list[int] | None = Field(default=None, description="Several 0-based pages.")
    rect: list[float] = Field(min_length=4, max_length=4, description="x0, y0, x1, y1 in points.")
    mode: Literal["cut", "cover"] = "cut"
    color: str = Field(default="auto", description="'cover' only: 'auto' or '#rrggbb'.")
    include_text: bool = True
    include_images: bool = True
    include_vectors: bool = True
    partial: bool = Field(
        default=True,
        description="False: only objects lying completely inside the rectangle are removed.",
    )
    image_fill: Literal["transparent", "white", "auto"] = Field(
        default="transparent",
        description="What the cut image pixels become. 'auto' means transparent.",
    )


def _page_list(p: ContentEraseRegionParams) -> list[int]:
    if (p.page_index is None) == (p.pages is None):
        raise invalid_params("PAGE_SELECTION", {"hint": "give pageIndex or pages"})
    pages = [p.page_index] if p.page_index is not None else list(p.pages or [])
    if not pages:
        raise invalid_params("PAGE_SELECTION", {"hint": "no pages"})
    return sorted(set(pages))


def _hex_rgb(value: str) -> tuple[float, float, float]:
    text = value.lstrip("#")
    if len(value) != _HEX_LEN or any(c not in "0123456789abcdefABCDEF" for c in text):
        raise invalid_params("INVALID_COLOUR", {"value": value})
    r, g, b = (int(text[i : i + 2], 16) / 255 for i in (0, 2, 4))
    return (r, g, b)


@operation(
    id="content.eraseRegion",
    title="Erase region",
    group="content",
    params=ContentEraseRegionParams,
    destructive=True,
)
def erase_region(ctx: OpContext, p: ContentEraseRegionParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("content.eraseRegion needs a session")
    x0, y0, x1, y1 = p.rect
    if x1 <= x0 or y1 <= y0:
        raise invalid_params("EMPTY_REGION", {"rect": p.rect})
    pages = _page_list(p)
    fixed: tuple[float, float, float] | None = None
    if p.mode == "cover" and p.color.lower() != "auto":
        fixed = _hex_rgb(p.color)
    opts = CutOptions(
        text=p.include_text,
        images=p.include_images,
        vectors=p.include_vectors,
        partial=p.partial,
        image_fill="white" if p.image_fill == "white" else "transparent",
    )
    totals = CutStats()
    changed: list[int] = []
    with ctx.open_input() as pdf:
        for index in pages:
            if index >= len(pdf.pages):
                raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": index})
            page = pdf.pages[index]
            region = rect_user_from_display(page_frame(page), p.rect)
            editor: PageEditor
            if p.mode == "cut":
                editor, stats = cut_page(pdf, page, index, [region], opts)
            else:
                editor = PageEditor(pdf, page, build_model(pdf, page, index))
                stats = CutStats()
                if fixed is None:
                    x0d, y0d, x1d, y1d = p.rect
                    r8, g8, b8 = sample_background(str(ctx.input_path), index, (x0d, y0d, x1d, y1d))
                    fixed = (r8 / 255, g8 / 255, b8 / 255)
                paint_rects(editor, [region], fixed)
            totals.add(stats)
            for reason in stats.skipped:
                ctx.warn(reason)
            if editor.changed():
                editor.write()
                changed.append(index)
        if changed:
            ctx.save_document(pdf)
    return OpOutput(
        changed_pages=changed,
        data={
            "removedObjects": totals.removed,
            "splitObjects": totals.split,
            "modifiedImages": totals.images,
            "clippedObjects": totals.clipped,
            "covered": len(pages) if p.mode == "cover" else 0,
            "skipped": totals.skipped,
        },
    )


__all__ = ["ContentEraseRegionParams", "erase_region"]
