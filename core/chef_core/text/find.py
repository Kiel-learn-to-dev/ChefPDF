"""Finding text in the lines of a page (T7.04, D10).

Matches are searched inside one line at a time (multi-line matches are not supported: a phrase
that wraps across two lines is not found). Spaces inferred from gaps are skipped while matching,
so a phrase still matches when the layout put a gap inside it.

Options: case sensitivity, ignoring diacritics (``đ`` counts as ``d``), whole words (no letter or
digit next to the match), and Python regular expressions. With a regular expression the match is
run on the line text as the user sees it, and the replacement may use group references
(``\\1``); diacritics are then significant.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from chef_core.errors import invalid_params


@dataclass(frozen=True)
class Span:
    """A match in display text: [start, end) display indices and the regex match, if any."""

    start: int
    end: int
    match: re.Match[str] | None = None


def _fold_char(ch: str, *, case_sensitive: bool, ignore_diacritics: bool) -> str:
    if ignore_diacritics:
        out = "".join(p for p in unicodedata.normalize("NFD", ch) if not unicodedata.combining(p))
        out = out.replace("đ", "d").replace("Đ", "D")
    else:
        out = unicodedata.normalize("NFC", ch)
    return out if case_sensitive else out.lower()


def _folded(
    text: str, mapping: list[int | None], *, case_sensitive: bool, ignore: bool
) -> tuple[str, list[int]]:
    """Folded text without inferred spaces, and for each folded char its display index."""
    chars: list[str] = []
    origin: list[int] = []
    for i, ch in enumerate(text):
        if mapping[i] is None:
            continue
        for part in _fold_char(ch, case_sensitive=case_sensitive, ignore_diacritics=ignore):
            chars.append(part)
            origin.append(i)
    return "".join(chars), origin


def _is_word(ch: str) -> bool:
    return ch.isalnum()


def find_spans(
    text: str,
    mapping: list[int | None],
    query: str,
    *,
    regex: bool = False,
    case_sensitive: bool = False,
    ignore_diacritics: bool = False,
    whole_word: bool = False,
) -> list[Span]:
    """All non-overlapping matches of ``query`` in one line's display text."""
    if not query:
        raise invalid_params("FIND_REQUIRED", {})
    if regex:
        try:
            pattern = re.compile(query, 0 if case_sensitive else re.IGNORECASE)
        except re.error as exc:
            raise invalid_params("INVALID_REGEX", {"error": str(exc)}) from exc
        found: list[Span] = []
        for m in pattern.finditer(text):
            if m.end() == m.start():
                continue
            if whole_word and not _word_bounds(text, m.start(), m.end()):
                continue
            found.append(Span(m.start(), m.end(), m))
        return found
    folded, origin = _folded(text, mapping, case_sensitive=case_sensitive, ignore=ignore_diacritics)
    needle, _ = _folded(
        query, [0] * len(query), case_sensitive=case_sensitive, ignore=ignore_diacritics
    )
    if not needle:
        raise invalid_params("FIND_REQUIRED", {})
    out: list[Span] = []
    pos = 0
    while True:
        at = folded.find(needle, pos)
        if at < 0:
            break
        end = at + len(needle)
        if whole_word and not _word_edges(folded, at, end):
            pos = at + 1
            continue
        out.append(Span(origin[at], origin[end - 1] + 1))
        pos = end
    return out


def _word_edges(folded: str, start: int, end: int) -> bool:
    before = folded[start - 1] if start > 0 else " "
    after = folded[end] if end < len(folded) else " "
    return not _is_word(before) and not _is_word(after)


def _word_bounds(text: str, start: int, end: int) -> bool:
    before = text[start - 1] if start > 0 else " "
    after = text[end] if end < len(text) else " "
    return not _is_word(before) and not _is_word(after)


def replacement_for(span: Span, text: str, replace: str, regex: bool) -> str:
    """The text that replaces one match (group references expanded for regular expressions)."""
    if not regex:
        return replace
    assert span.match is not None
    try:
        return span.match.expand(replace)
    except (re.error, IndexError) as exc:
        raise invalid_params("INVALID_REPLACEMENT", {"error": str(exc)}) from exc


def apply_spans(text: str, spans: list[Span], replacements: list[str]) -> str:
    """``text`` with each span replaced (spans must be sorted and non-overlapping)."""
    out: list[str] = []
    pos = 0
    for span, new in zip(spans, replacements, strict=True):
        out.append(text[pos : span.start])
        out.append(new)
        pos = span.end
    out.append(text[pos:])
    return "".join(out)
