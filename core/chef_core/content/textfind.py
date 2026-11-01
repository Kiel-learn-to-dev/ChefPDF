"""Text search for redaction (T6.07, J6): characters with boxes, folded text, built-in patterns.

Characters come from PDFium's text page (the same text the viewer shows). The search runs on a
folded copy of the page text: lower case, no diacritics (unless a literal search keeps them),
``đ`` as ``d``, every whitespace run as one space. Each folded character keeps the index of the
character it came from, so a match maps back to boxes. A match that spans several lines gives one
rectangle per line.

Built-in patterns (checksum-free, strict shapes):

- ``cccd``: 12 digits (or the 9-digit CMND), spaces or dots allowed between groups of three.
- ``phone``: Vietnamese mobile numbers ``0[35789]xx xxx xxx`` and ``+84`` forms.
- ``email``, ``date`` (dd/mm/yyyy), ``taxCode`` (10 digits, or 10-3 with a hyphen).
- ``bankAccount``: 8 to 19 digits after a keyword (STK, số tài khoản, account); only the digits
  are matched.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

import pypdfium2 as pdfium

from chef_core.content.erase import rect_display_from_user
from chef_core.content.model import Rect
from chef_core.errors import invalid_params
from chef_core.signing.anchors import PageFrame

BuiltinKind = Literal["cccd", "phone", "email", "bankAccount", "taxCode", "date"]
PatternKind = Literal[
    "literal", "regex", "cccd", "phone", "email", "bankAccount", "taxCode", "date"
]

BUILTIN: dict[str, str] = {
    "cccd": r"(?<!\d)(?:\d{3}[ .]?\d{3}[ .]?\d{3}[ .]?\d{3}|\d{3}[ .]?\d{3}[ .]?\d{3})(?!\d)",
    "phone": r"(?<![\d+])(?:\+84[ .-]?|0)[35789][ .-]?\d{2}[ .-]?\d{3}[ .-]?\d{3}(?!\d)",
    "email": r"[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}",
    "bankAccount": r"(?:so\s*tai\s*khoan|stk|account|tk)[\s:.#-]*((?:\d[ -]?){7,18}\d)",
    "taxCode": r"(?<!\d)\d{10}(?:-\d{3})?(?![\d-])",
    "date": r"(?<!\d)(?:0?[1-9]|[12]\d|3[01])[/.-](?:0?[1-9]|1[0-2])[/.-](?:19|20)\d{2}(?!\d)",
}


@dataclass(frozen=True)
class PatternSpec:
    kind: PatternKind
    value: str | None = None
    ignore_diacritics: bool = True

    def validate(self) -> None:
        if self.kind in ("literal", "regex") and not (self.value or "").strip():
            raise invalid_params("PATTERN_VALUE_REQUIRED", {"kind": self.kind})
        if self.kind == "regex":
            try:
                re.compile(self.value or "")
            except re.error as exc:
                raise invalid_params("INVALID_REGEX", {"error": str(exc)}) from exc


@dataclass
class PageChars:
    index: int
    chars: list[str]
    boxes: list[Rect | None]  # user space, None when PDFium has no box
    frame: PageFrame


def _fold(chars: list[str], keep_marks: bool) -> tuple[str, list[int]]:
    out: list[str] = []
    origin: list[int] = []
    for i, ch in enumerate(chars):
        if ch.isspace():
            if out and out[-1] == " ":
                continue
            out.append(" ")
            origin.append(i)
            continue
        if keep_marks:
            for c in unicodedata.normalize("NFC", ch).lower():
                out.append(c)
                origin.append(i)
            continue
        for part in unicodedata.normalize("NFD", ch):
            if unicodedata.combining(part):
                continue
            part = {"đ": "d", "Đ": "d"}.get(part, part)
            for c in part.lower():
                out.append(c)
                origin.append(i)
    return "".join(out), origin


def norm(text: str) -> str:
    """Letters and digits only, lower case, no diacritics: the comparison used for leak checks."""
    out: list[str] = []
    for ch in unicodedata.normalize("NFD", text.lower()):
        if unicodedata.combining(ch):
            continue
        ch = {"đ": "d"}.get(ch, ch)
        if ch.isalnum():
            out.append(ch)
    return "".join(out)


def read_page(doc: pdfium.PdfDocument, index: int, frame: PageFrame) -> PageChars:
    """Characters and boxes of one page. ``frame`` is the page's frame (``page_frame``)."""
    page = doc[index]
    textpage = page.get_textpage()
    try:
        count = textpage.count_chars()
        chars: list[str] = []
        boxes: list[Rect | None] = []
        for i in range(count):
            chars.append(textpage.get_text_range(i, 1))
            try:
                left, bottom, right, top = textpage.get_charbox(i, loose=False)
            except Exception:  # PDFium reports no box for some generated characters
                boxes.append(None)
                continue
            boxes.append((left, bottom, right, top) if right > left and top > bottom else None)
    finally:
        textpage.close()
        page.close()
    return PageChars(index=index, chars=chars, boxes=boxes, frame=frame)


def _line_rects(boxes: list[Rect | None], chars: list[str], first: int, last: int) -> list[Rect]:
    rects: list[Rect] = []
    cur: list[float] | None = None
    cur_h = 0.0
    for i in range(first, last + 1):
        box = boxes[i]
        if box is None or chars[i].isspace():
            continue
        cy = (box[1] + box[3]) / 2
        h = box[3] - box[1]
        if cur is not None and abs(cy - (cur[1] + cur[3]) / 2) < 0.5 * max(h, cur_h):
            cur = [
                min(cur[0], box[0]),
                min(cur[1], box[1]),
                max(cur[2], box[2]),
                max(cur[3], box[3]),
            ]
            cur_h = max(cur_h, h)
            continue
        if cur is not None:
            rects.append((cur[0], cur[1], cur[2], cur[3]))
        cur = [box[0], box[1], box[2], box[3]]
        cur_h = h
    if cur is not None:
        rects.append((cur[0], cur[1], cur[2], cur[3]))
    return rects


@dataclass(frozen=True)
class Hit:
    page_index: int
    start: int  # first original character
    end: int  # one past the last original character
    text: str
    pattern: str
    rects: tuple[Rect, ...]  # user space, one per line


def _spans(pc: PageChars, spec: PatternSpec) -> list[tuple[int, int, str]]:
    """(start, end) original-character spans for one pattern on one page."""
    raw = pc.chars
    if spec.kind == "literal":
        keep = not spec.ignore_diacritics
        text, origin = _fold(raw, keep_marks=keep)
        query, _ = _fold(list((spec.value or "").strip()), keep_marks=keep)
        query = " ".join(query.split())
        if not query:
            return []
        # PDFium may put spaces where a kerning gap is: the query matches with optional spaces
        body = r"\s*".join(re.escape(c) for c in query.replace(" ", ""))
        regex = re.compile(body)
        return [
            (origin[m.start()], origin[m.end() - 1] + 1, str(spec.kind))
            for m in regex.finditer(text)
            if m.end() > m.start()
        ]
    text, origin = _fold(raw, keep_marks=False)
    if spec.kind == "regex":
        pattern = re.compile(spec.value or "", re.IGNORECASE)
        group = 0
    else:
        pattern = re.compile(BUILTIN[spec.kind])
        group = 1 if spec.kind == "bankAccount" else 0
    out = []
    for m in pattern.finditer(text):
        if m.end(group) <= m.start(group):
            continue
        s, e = m.start(group), m.end(group)
        out.append((origin[s], origin[e - 1] + 1, str(spec.kind)))
    return out


def search(
    doc: pdfium.PdfDocument,
    frames: Callable[[int], PageFrame],
    specs: list[PatternSpec],
    pages: list[int] | None,
) -> list[Hit]:
    """All hits of the patterns (in page order, then by position, then by pattern order).
    ``frames(i)`` gives the frame of page i (``chef_core.overlay.pagecontent.page_frame``)."""
    for spec in specs:
        spec.validate()
    indices = range(len(doc)) if pages is None else sorted(set(pages))
    hits: list[Hit] = []
    for index in indices:
        pc = read_page(doc, index, frames(index))
        seen: set[tuple[int, int]] = set()
        found: list[tuple[int, int, int, str]] = []
        for order, spec in enumerate(specs):
            for start, end, _kind in _spans(pc, spec):
                if (start, end) in seen:
                    continue
                seen.add((start, end))
                found.append((start, end, order, spec.kind))
        found.sort()
        for start, end, _order, kind in found:
            text = "".join(pc.chars[start:end])
            rects = tuple(_line_rects(pc.boxes, pc.chars, start, end - 1))
            if not rects:
                continue
            hits.append(
                Hit(index, start, end, text, kind if kind != "regex" else f"regex#{order}", rects)
            )
    return hits


def match_id(page_index: int, ordinal: int, text: str) -> str:
    digest = hashlib.sha1(norm(text).encode("utf-8")).hexdigest()[:8]
    return f"r{page_index}-{ordinal}-{digest}"


def hit_ids(hits: list[Hit]) -> list[str]:
    ids: list[str] = []
    per_page: dict[int, int] = {}
    for hit in hits:
        ordinal = per_page.get(hit.page_index, 0)
        per_page[hit.page_index] = ordinal + 1
        ids.append(match_id(hit.page_index, ordinal, hit.text))
    return ids


def display_rects(frame: PageFrame, rects: tuple[Rect, ...]) -> list[list[float]]:
    return [list(rect_display_from_user(frame, r)) for r in rects]


__all__ = [
    "BUILTIN",
    "Hit",
    "PatternSpec",
    "display_rects",
    "hit_ids",
    "match_id",
    "norm",
    "read_page",
    "search",
]
