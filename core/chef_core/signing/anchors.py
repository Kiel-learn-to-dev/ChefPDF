"""Text anchors and signature placement next to them (T3.12, I26, I27).

Coordinates
-----------
Every rectangle returned here is ``[x1, y1, x2, y2]`` in PDF **user space**: origin at the bottom
left of the unrotated page, which is the space of annotation ``/Rect`` entries and of the
signature field rectangles. A page's ``/Rotate`` (inherited, normalised to 0/90/180/270) does not
change user space, so a rectangle found on a rotated page is the same as on the unrotated page.

Text search uses pypdfium2 character boxes, which are also in user space (verified by tests).

Placement works in the *displayed* frame, which is what the reader shows after /Rotate:
``position`` ("below", "left", ...), ``width`` and ``height`` refer to the screen. The result is
converted back to user space (``PageFrame.rect_from_display``), so with /Rotate 90 the displayed
bottom edge is the user-space right edge and a box placed "below" appears at larger x.

Diacritics
----------
Text is folded before comparison: NFD decomposition, combining marks removed (when
``ignore_diacritics``), and "đ"/"Đ" mapped to "d"/"D". Precomposed and decomposed input therefore
match each other. With ``ignore_diacritics=False`` marks are kept and both sides are compared in
NFD, so the search is still independent of the input normalisation.
"""

from __future__ import annotations

import unicodedata
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import pypdfium2 as pdfium

from chef_core.errors import invalid_params
from chef_core.pdf.io import opened_pdf
from chef_core.pdf.pages import check_indices, normalized_rotation, unique_sorted

Rect = tuple[float, float, float, float]
Position = Literal["below", "above", "right", "left", "over"]
Align = Literal["left", "center", "right"]
Corner = Literal["top-left", "top-right", "bottom-left", "bottom-right"]
CONTEXT_CHARS = 40


# -- page geometry --------------------------------------------------------------------------


@dataclass(frozen=True)
class PageFrame:
    """Crop box of a page (user space) and its /Rotate, with the mapping to the displayed frame.

    Displayed frame: origin at the bottom left of the screen image, x to the right, y up.
    ``rotation`` is clockwise, as /Rotate is defined."""

    x0: float
    y0: float
    x1: float
    y1: float
    rotation: int

    @property
    def user_width(self) -> float:
        return self.x1 - self.x0

    @property
    def user_height(self) -> float:
        return self.y1 - self.y0

    @property
    def display_size(self) -> tuple[float, float]:
        if self.rotation in (90, 270):
            return self.user_height, self.user_width
        return self.user_width, self.user_height

    def _to_display(self, x: float, y: float) -> tuple[float, float]:
        u, v = x - self.x0, y - self.y0
        w, h = self.user_width, self.user_height
        if self.rotation == 90:
            return v, w - u
        if self.rotation == 180:
            return w - u, h - v
        if self.rotation == 270:
            return h - v, u
        return u, v

    def _from_display(self, dx: float, dy: float) -> tuple[float, float]:
        w, h = self.user_width, self.user_height
        if self.rotation == 90:
            u, v = w - dy, dx
        elif self.rotation == 180:
            u, v = w - dx, h - dy
        elif self.rotation == 270:
            u, v = dy, h - dx
        else:
            u, v = dx, dy
        return self.x0 + u, self.y0 + v

    def rect_to_display(self, rect: Sequence[float]) -> Rect:
        return _normalised(self._to_display(rect[0], rect[1]), self._to_display(rect[2], rect[3]))

    def rect_from_display(self, rect: Sequence[float]) -> Rect:
        return _normalised(
            self._from_display(rect[0], rect[1]), self._from_display(rect[2], rect[3])
        )


def _normalised(a: tuple[float, float], b: tuple[float, float]) -> Rect:
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))


def page_frames(path: str | Path) -> dict[int, PageFrame]:
    """Crop box and rotation of every page, keyed by 0-based index."""
    frames: dict[int, PageFrame] = {}
    with opened_pdf(path) as pdf:
        for index, page in enumerate(pdf.pages):
            x0, y0, x1, y1 = (float(v) for v in page.cropbox)
            frames[index] = PageFrame(
                x0=min(x0, x1),
                y0=min(y0, y1),
                x1=max(x0, x1),
                y1=max(y0, y1),
                rotation=normalized_rotation(page),
            )
    return frames


# -- text search ----------------------------------------------------------------------------


@dataclass(frozen=True)
class Match:
    page_index: int
    rect: Rect
    context_before: str
    context_after: str


@dataclass
class AnchorSearch:
    matches: list[Match] = field(default_factory=list)
    truncated: bool = False


def _fold_char(ch: str, *, ignore_diacritics: bool, case_sensitive: bool) -> str:
    """Normalised form of one character: NFD, optional mark removal, đ→d, optional lower case."""
    out: list[str] = []
    for part in unicodedata.normalize("NFD", ch):
        if unicodedata.combining(part):
            if not ignore_diacritics:
                out.append(part)
            continue
        if ignore_diacritics:
            part = {"đ": "d", "Đ": "D"}.get(part, part)
        out.append(part)
    text = "".join(out)
    if not case_sensitive:
        lowered = text.lower()
        if len(lowered) == len(text):  # some characters lower-case to two characters
            text = lowered
    return text


def fold_query(text: str, *, ignore_diacritics: bool, case_sensitive: bool) -> str:
    """Normalised search string: whitespace collapsed and trimmed."""
    pieces: list[str] = []
    for ch in text:
        if ch.isspace():
            pieces.append(" ")
        else:
            pieces.append(
                _fold_char(ch, ignore_diacritics=ignore_diacritics, case_sensitive=case_sensitive)
            )
    return " ".join("".join(pieces).split())


def _is_word_char(ch: str) -> bool:
    return ch.isalnum() or bool(unicodedata.combining(ch))


def _page_text(textpage: pdfium.PdfTextPage) -> tuple[list[str], list[Rect | None]]:
    """Original characters of a page and their boxes (None when a character has no box)."""
    count = textpage.count_chars()
    chars: list[str] = []
    boxes: list[Rect | None] = []
    for index in range(count):
        chars.append(textpage.get_text_range(index, 1))
        try:
            left, bottom, right, top = textpage.get_charbox(index, loose=False)
        except Exception:  # pdfium reports no box for some generated characters
            boxes.append(None)
            continue
        boxes.append((left, bottom, right, top) if right > left and top > bottom else None)
    return chars, boxes


def _search_page(
    chars: list[str],
    boxes: list[Rect | None],
    query: str,
    *,
    ignore_diacritics: bool,
    case_sensitive: bool,
    whole_word: bool,
    limit: int,
    page_index: int,
) -> list[Match]:
    """All matches of ``query`` on one page, as user-space rectangles."""
    folded: list[str] = []
    origin: list[int] = []
    for index, ch in enumerate(chars):
        if ch.isspace():
            if folded and folded[-1] == " ":
                continue
            folded.append(" ")
            origin.append(index)
            continue
        for out in _fold_char(
            ch, ignore_diacritics=ignore_diacritics, case_sensitive=case_sensitive
        ):
            folded.append(out)
            origin.append(index)
    text = "".join(folded)
    matches: list[Match] = []
    start = text.find(query)
    while start != -1 and len(matches) < limit:
        end = start + len(query)
        if whole_word and (
            (start > 0 and _is_word_char(text[start - 1]))
            or (end < len(text) and _is_word_char(text[end]))
        ):
            start = text.find(query, start + 1)
            continue
        first, last = origin[start], origin[end - 1]
        rect = _union([boxes[i] for i in range(first, last + 1)])
        if rect is not None:
            matches.append(
                Match(
                    page_index=page_index,
                    rect=rect,
                    context_before=_context("".join(chars[max(0, first - CONTEXT_CHARS) : first])),
                    context_after=_context("".join(chars[last + 1 : last + 1 + CONTEXT_CHARS])),
                )
            )
        start = text.find(query, end)
    return matches


def _union(boxes: Sequence[Rect | None]) -> Rect | None:
    present = [b for b in boxes if b is not None]
    if not present:
        return None
    return (
        min(b[0] for b in present),
        min(b[1] for b in present),
        max(b[2] for b in present),
        max(b[3] for b in present),
    )


def _context(text: str) -> str:
    return " ".join(text.split())


def search_anchors(
    path: str | Path,
    text: str,
    *,
    case_sensitive: bool = False,
    ignore_diacritics: bool = True,
    whole_word: bool = True,
    pages: Sequence[int] | None = None,
    max_results: int = 200,
) -> AnchorSearch:
    """Find ``text`` in the document. Returns at most ``max_results`` matches in page order."""
    query = fold_query(text, ignore_diacritics=ignore_diacritics, case_sensitive=case_sensitive)
    result = AnchorSearch()
    if not query:
        return result
    doc = pdfium.PdfDocument(str(path))
    try:
        count = len(doc)
        selected = (
            range(count) if pages is None else unique_sorted(check_indices(pages, count, "pages"))
        )
        for index in selected:
            page = doc[index]
            textpage = page.get_textpage()
            try:
                chars, boxes = _page_text(textpage)
                found = _search_page(
                    chars,
                    boxes,
                    query,
                    ignore_diacritics=ignore_diacritics,
                    case_sensitive=case_sensitive,
                    whole_word=whole_word,
                    limit=max_results - len(result.matches) + 1,
                    page_index=index,
                )
            finally:
                textpage.close()
                page.close()
            for match in found:
                if len(result.matches) == max_results:
                    result.truncated = True
                    return result
                result.matches.append(match)
    finally:
        doc.close()
    return result


def find_anchors(
    path: str | Path,
    text: str,
    *,
    case_sensitive: bool = False,
    ignore_diacritics: bool = True,
    whole_word: bool = True,
    pages: Sequence[int] | None = None,
    max_results: int = 200,
) -> list[Match]:
    return search_anchors(
        path,
        text,
        case_sensitive=case_sensitive,
        ignore_diacritics=ignore_diacritics,
        whole_word=whole_word,
        pages=pages,
        max_results=max_results,
    ).matches


# -- placement ------------------------------------------------------------------------------


@dataclass(frozen=True)
class Placement:
    page_index: int
    rect: Rect  # user space
    anchor_index: int


def place(
    matches: Sequence[Match],
    frames: Mapping[int, PageFrame],
    *,
    width: float,
    height: float,
    position: Position,
    offset_x: float = 0.0,
    offset_y: float = 0.0,
    align: Align = "center",
    gap: float = 4.0,
    clamp: bool = True,
) -> tuple[list[Placement], int]:
    """Signature boxes next to each match.

    ``width`` and ``height`` are the displayed size. ``below``/``above`` align the box with the
    anchor by ``align`` (left edge, centre or right edge). ``left``/``right`` centre it vertically
    on the anchor. ``over`` centres it on the anchor. ``offset_x``/``offset_y`` move the box in
    the displayed frame (x right, y up). With ``clamp`` the box is moved inside the page; without
    it, boxes that would cross the page edge are skipped. Returns (placements, skipped count).
    """
    placements: list[Placement] = []
    skipped = 0
    for index, match in enumerate(matches):
        frame = frames.get(match.page_index)
        if frame is None:
            raise invalid_params(
                "Anchor refers to a page that does not exist", {"field": "anchors"}
            )
        page_w, page_h = frame.display_size
        ax1, ay1, ax2, ay2 = frame.rect_to_display(match.rect)
        acx, acy = (ax1 + ax2) / 2, (ay1 + ay2) / 2
        if position in ("below", "above"):
            left = _aligned_left(align, ax1, ax2, width)
            bottom = ay1 - gap - height if position == "below" else ay2 + gap
        elif position == "right":
            left = ax2 + gap
            bottom = acy - height / 2
        elif position == "left":
            left = ax1 - gap - width
            bottom = acy - height / 2
        else:  # over
            left = acx - width / 2
            bottom = acy - height / 2
        left += offset_x
        bottom += offset_y
        if clamp:
            left = _clamp(left, page_w, width)
            bottom = _clamp(bottom, page_h, height)
        elif left < 0 or bottom < 0 or left + width > page_w or bottom + height > page_h:
            skipped += 1
            continue
        rect = frame.rect_from_display((left, bottom, left + width, bottom + height))
        placements.append(
            Placement(
                page_index=match.page_index,
                rect=_rounded(rect),
                anchor_index=index,
            )
        )
    return placements, skipped


def _rounded(rect: Rect) -> Rect:
    x1, y1, x2, y2 = rect
    return (round(x1, 3), round(y1, 3), round(x2, 3), round(y2, 3))


def _aligned_left(align: Align, a1: float, a2: float, width: float) -> float:
    if align == "left":
        return a1
    if align == "right":
        return a2 - width
    return (a1 + a2) / 2 - width / 2


def _clamp(value: float, page_size: float, size: float) -> float:
    if size >= page_size:
        return 0.0
    return min(max(value, 0.0), page_size - size)


def fixed_rect(
    page_size: tuple[float, float],
    corner: Corner,
    width: float,
    height: float,
    margin: float,
) -> list[float]:
    """A box in a page corner, ``margin`` points from both edges (I27).

    ``page_size`` is (width, height) in the frame the box is used in. Returned as
    ``[x1, y1, x2, y2]`` with origin at the bottom left."""
    page_w, page_h = page_size
    if width + 2 * margin > page_w or height + 2 * margin > page_h:
        raise ValueError("the box does not fit on the page with this margin")
    x = margin if corner.endswith("left") else page_w - margin - width
    y = margin if corner.startswith("bottom") else page_h - margin - height
    return [x, y, x + width, y + height]


__all__ = [
    "AnchorSearch",
    "Match",
    "PageFrame",
    "Placement",
    "find_anchors",
    "fixed_rect",
    "fold_query",
    "page_frames",
    "place",
    "search_anchors",
]
