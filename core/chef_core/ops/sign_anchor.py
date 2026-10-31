"""Find text anchors and place signature boxes next to them (T3.12, I26).

Both ops are session operations that change nothing: they read the current revision and never
commit a new one. Rectangles are PDF user-space ``[x1, y1, x2, y2]`` (see
``chef_core.signing.anchors`` for the rotation rules).

- ``sign.findAnchors`` returns the matches of a text, with their rectangles and context.
- ``sign.placeFromAnchor`` turns matches (from ``sign.findAnchors``) into signature boxes. The UI
  can preview the boxes and pass the same list to the signing op.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

from chef_core.errors import invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.signing import anchors

PageIndex = Annotated[int, Field(ge=0)]
Rect4 = Annotated[list[float], Field(min_length=4, max_length=4)]


def _session_path(ctx: OpContext) -> str:
    if ctx.input_path is None:
        raise RuntimeError("operation needs a session but none was given")
    return str(ctx.input_path)


# -- sign.findAnchors ------------------------------------------------------------------------


class FindAnchorsParams(WireModel):
    """Search the document for a text (I26)."""

    text: str = Field(
        min_length=1,
        max_length=200,
        description="The text to find, e.g. 'GIÁM ĐỐC'. Spacing between words is normalised.",
    )
    case_sensitive: bool = False
    ignore_diacritics: bool = Field(
        default=True, description="'giam doc' also finds 'GIÁM ĐỐC'. đ and Đ count as d and D."
    )
    whole_word: bool = Field(default=True, description="Do not match inside longer words.")
    pages: list[PageIndex] | None = Field(
        default=None, min_length=1, description="0-based pages to search; default all."
    )
    max_results: int = Field(default=200, ge=1, le=1000)


@operation(
    id="sign.findAnchors",
    title="Find anchor text",
    group="sign",
    params=FindAnchorsParams,
)
def find_anchors_op(ctx: OpContext, p: FindAnchorsParams) -> OpOutput:
    if not p.text.strip():
        raise invalid_params("text must not be blank", {"field": "text"})
    found = anchors.search_anchors(
        _session_path(ctx),
        p.text,
        case_sensitive=p.case_sensitive,
        ignore_diacritics=p.ignore_diacritics,
        whole_word=p.whole_word,
        pages=p.pages,
        max_results=p.max_results,
    )
    rows = [
        {
            "pageIndex": m.page_index,
            "rect": list(m.rect),
            "contextBefore": m.context_before,
            "contextAfter": m.context_after,
        }
        for m in found.matches
    ]
    if found.truncated:
        ctx.warn(f"More matches than maxResults ({p.max_results}); only the first are returned.")
    return OpOutput(changed_pages=[], data={"matches": rows, "truncated": found.truncated})


# -- sign.placeFromAnchor --------------------------------------------------------------------


class AnchorRef(WireModel):
    """An anchor as returned by sign.findAnchors (only the parts that placement needs)."""

    page_index: PageIndex
    rect: Rect4


class PlaceFromAnchorParams(WireModel):
    """Signature boxes next to anchors (I26). Positions are in the displayed frame."""

    anchors: list[AnchorRef] = Field(min_length=1, max_length=5000)
    width: float = Field(gt=0, le=2000, description="Displayed width in points.")
    height: float = Field(gt=0, le=2000, description="Displayed height in points.")
    position: Literal["below", "above", "right", "left", "over"] = "below"
    offset_x: float = Field(default=0.0, ge=-2000, le=2000, description="Moves the box right.")
    offset_y: float = Field(default=0.0, ge=-2000, le=2000, description="Moves the box up.")
    align: Literal["left", "center", "right"] = Field(
        default="center", description="For 'below' and 'above': how the box lines up with the text."
    )
    gap: float = Field(default=4.0, ge=0, le=200, description="Distance from the text, points.")
    clamp_to_page: bool = Field(
        default=True,
        description="Move boxes inside the page. When false, boxes crossing the edge are skipped.",
    )


@operation(
    id="sign.placeFromAnchor",
    title="Place signature from anchor",
    group="sign",
    params=PlaceFromAnchorParams,
)
def place_from_anchor_op(ctx: OpContext, p: PlaceFromAnchorParams) -> OpOutput:
    frames = anchors.page_frames(_session_path(ctx))
    refs = [
        anchors.Match(
            page_index=ref.page_index,
            rect=(ref.rect[0], ref.rect[1], ref.rect[2], ref.rect[3]),
            context_before="",
            context_after="",
        )
        for ref in p.anchors
    ]
    for ref in refs:
        if ref.page_index not in frames:
            raise invalid_params(
                "Anchor refers to a page that does not exist", {"field": "anchors"}
            )
    placed, skipped = anchors.place(
        refs,
        frames,
        width=p.width,
        height=p.height,
        position=p.position,
        offset_x=p.offset_x,
        offset_y=p.offset_y,
        align=p.align,
        gap=p.gap,
        clamp=p.clamp_to_page,
    )
    if skipped:
        ctx.warn(f"{skipped} box(es) would cross the page edge and were skipped.")
    rows = [
        {"pageIndex": item.page_index, "rect": list(item.rect), "anchorIndex": item.anchor_index}
        for item in placed
    ]
    return OpOutput(changed_pages=[], data={"placements": rows, "skipped": skipped})
