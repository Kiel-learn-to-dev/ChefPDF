"""Template variables for overlay text (T4.07, F7, F8, F9, F10).

A template is plain text with ``{name}`` variables. ``{{`` and ``}}`` write a literal brace.
Unknown names and broken braces are INVALID_PARAMS, and the error names the variable.

Variables: ``{page}`` and ``{pages}`` (the displayed number of this page and of the last page,
both counted from ``startNumber``), ``{page_roman}`` and ``{page_alpha}`` (always upper case),
``{date}`` (``dateFormat``, with the same token letters as the signature appearance: yyyy yy MM
M dd d HH H mm m ss s and quoted literals), ``{time}`` (HH:mm), ``{filename}`` (the file name
without extension), ``{title}`` and ``{author}`` (document information), ``{bates}`` (prefix,
zero-padded page number and suffix), ``{section}`` (the section title that covers the page).

``{page}`` and ``{pages}`` follow the number format of the caller (arabic, roman, ROMAN, alpha,
ALPHA). Roman numerals stop at 3999; alpha numbering is A..Z, then AA, AB, and so on.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Literal

from chef_core.errors import invalid_params
from chef_core.signing.appearance import format_date

NumberFormat = Literal["arabic", "roman", "ROMAN", "alpha", "ALPHA"]
NUMBER_FORMATS: tuple[str, ...] = ("arabic", "roman", "ROMAN", "alpha", "ALPHA")
VARIABLES: tuple[str, ...] = (
    "page",
    "pages",
    "page_roman",
    "page_alpha",
    "date",
    "time",
    "filename",
    "title",
    "author",
    "bates",
    "section",
)
_ROMAN_TABLE: tuple[tuple[int, str], ...] = (
    (1000, "M"),
    (900, "CM"),
    (500, "D"),
    (400, "CD"),
    (100, "C"),
    (90, "XC"),
    (50, "L"),
    (40, "XL"),
    (10, "X"),
    (9, "IX"),
    (5, "V"),
    (4, "IV"),
    (1, "I"),
)
MAX_ROMAN = 3999


def to_roman(number: int) -> str:
    """Upper-case roman numeral; 1..3999 only."""
    if not 1 <= number <= MAX_ROMAN:
        raise ValueError(f"roman numerals cover 1..{MAX_ROMAN}, got {number}")
    out: list[str] = []
    rest = number
    for value, letters in _ROMAN_TABLE:
        count, rest = divmod(rest, value)
        out.append(letters * count)
    return "".join(out)


def to_alpha(number: int) -> str:
    """Upper-case bijective base-26 letters: 1 is A, 26 is Z, 27 is AA."""
    if number < 1:
        raise ValueError(f"alpha numbering starts at 1, got {number}")
    letters: list[str] = []
    rest = number
    while rest > 0:
        rest, remainder = divmod(rest - 1, 26)
        letters.append(chr(ord("A") + remainder))
    return "".join(reversed(letters))


def format_number(number: int, number_format: NumberFormat) -> str:
    """``number`` in the given format; invalid values are INVALID_PARAMS."""
    try:
        if number_format == "arabic":
            return str(number)
        if number_format == "roman":
            return to_roman(number).lower()
        if number_format == "ROMAN":
            return to_roman(number)
        if number_format == "alpha":
            return to_alpha(number).lower()
        return to_alpha(number)
    except ValueError as exc:
        raise invalid_params(str(exc), {"field": "numberFormat", "value": number}) from exc


# -- templates --------------------------------------------------------------------------


@dataclass(frozen=True)
class TextPart:
    text: str


@dataclass(frozen=True)
class Variable:
    name: str


Token = TextPart | Variable


def parse_template(template: str) -> list[Token]:
    """Split a template into literal text and variables. Raises INVALID_PARAMS."""
    tokens: list[Token] = []
    buf: list[str] = []
    i = 0
    n = len(template)
    while i < n:
        ch = template[i]
        if ch == "{":
            if template.startswith("{{", i):
                buf.append("{")
                i += 2
                continue
            end = template.find("}", i)
            if end == -1:
                raise invalid_params("Unclosed '{' in the template", {"position": i})
            name = template[i + 1 : end]
            if name not in VARIABLES:
                raise invalid_params(
                    f"Unknown variable: {{{name}}}", {"variable": name, "position": i}
                )
            if buf:
                tokens.append(TextPart("".join(buf)))
                buf = []
            tokens.append(Variable(name))
            i = end + 1
        elif ch == "}":
            if template.startswith("}}", i):
                buf.append("}")
                i += 2
                continue
            raise invalid_params(
                "A single '}' in the template; write '}}' for a literal brace", {"position": i}
            )
        else:
            buf.append(ch)
            i += 1
    if buf:
        tokens.append(TextPart("".join(buf)))
    return tokens


def check_template(template: str) -> None:
    """Validate a template without rendering it."""
    parse_template(template)


def _section_title(sections: Sequence[tuple[int, str]], index: int) -> str:
    title = ""
    for start, name in sections:
        if start <= index:
            title = name
    return title


@dataclass(frozen=True)
class DocVars:
    """Document-level values; ``render`` fills a template for the page at ``index`` (0-based).

    ``sections`` is a list of (0-based start page, title), in any order.
    """

    filename: str
    title: str
    author: str
    page_count: int
    start_number: int
    date_format: str
    now: dt.datetime
    sections: tuple[tuple[int, str], ...] = field(default=())
    bates_prefix: str = ""
    bates_suffix: str = ""
    bates_digits: int = 6

    def render(self, template: str, index: int, *, number_format: NumberFormat = "arabic") -> str:
        getters = self._getters(index, number_format)
        out: list[str] = []
        for token in parse_template(template):
            if isinstance(token, TextPart):
                out.append(token.text)
            else:
                out.append(getters[token.name]())
        return "".join(out)

    def _getters(self, index: int, number_format: NumberFormat) -> dict[str, Callable[[], str]]:
        page = index + self.start_number
        last = self.page_count - 1 + self.start_number
        ordered = sorted(self.sections, key=lambda s: s[0])
        return {
            "page": lambda: format_number(page, number_format),
            "pages": lambda: format_number(last, number_format),
            "page_roman": lambda: format_number(page, "ROMAN"),
            "page_alpha": lambda: format_number(page, "ALPHA"),
            "date": lambda: format_date(self.now, self.date_format),
            "time": lambda: f"{self.now.hour:02d}:{self.now.minute:02d}",
            "filename": lambda: self.filename,
            "title": lambda: self.title,
            "author": lambda: self.author,
            "bates": lambda: f"{self.bates_prefix}{page:0{self.bates_digits}d}{self.bates_suffix}",
            "section": lambda: _section_title(ordered, index),
        }
