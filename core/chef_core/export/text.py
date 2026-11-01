"""Text helpers shared by the exporters: NFC cleaning, XML-safe text, escaping for Markdown, HTML
and XML, and merging of adjacent runs with the same style."""

from __future__ import annotations

import html
import re
import unicodedata
from collections.abc import Iterable, Sequence

from chef_core.layout.model import Run

XML_INVALID = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]")
MD_SPECIAL = re.compile(r"([\\`*_\[\]<>|~])")
SPACES = re.compile(r"\s+")


def clean(text: str) -> str:
    """NFC, and without the characters XML 1.0 does not allow (they break every XML writer)."""
    return XML_INVALID.sub("", unicodedata.normalize("NFC", text))


def squash(text: str) -> str:
    """One line: runs of whitespace (line breaks included) become one space."""
    return SPACES.sub(" ", clean(text)).strip()


def md_escape(text: str) -> str:
    return MD_SPECIAL.sub(r"\\\1", text)


def md_line_start(text: str) -> str:
    """Escape what would start a Markdown block (heading, quote, list, ordered list)."""
    text = re.sub(r"^(\d+)([.)])(\s)", r"\1\\\2\3", text)
    return re.sub(r"^([#>+\-])(\s)", r"\\\1\2", text)


def html_escape(text: str) -> str:
    return html.escape(text, quote=True)


def xml_escape(text: str) -> str:
    return html.escape(clean(text), quote=True)


def wrap_marks(text: str, marker: str) -> str:
    """``marker`` around the visible part of ``text``; spaces at the edges stay outside."""
    core = text.strip()
    if not core:
        return text
    lead = text[: len(text) - len(text.lstrip())]
    trail = text[len(text.rstrip()) :]
    return f"{lead}{marker}{core}{marker}{trail}"


def _lstrip_runs(runs: list[Run]) -> list[Run]:
    out = list(runs)
    while out:
        text = out[0].text.lstrip()
        if text:
            out[0] = out[0].model_copy(update={"text": text})
            break
        out.pop(0)
    return out


def _rstrip_runs(runs: list[Run]) -> list[Run]:
    out = list(runs)
    while out:
        text = out[-1].text.rstrip()
        if text:
            out[-1] = out[-1].model_copy(update={"text": text})
            break
        out.pop()
    return out


def clean_runs(runs: Iterable[Run]) -> list[Run]:
    """Runs with cleaned text, collapsed spaces, no empty runs and no spaces at the block edges."""
    out: list[Run] = []
    for run in runs:
        text = SPACES.sub(" ", clean(run.text))
        if text:
            out.append(run.model_copy(update={"text": text}))
    return _rstrip_runs(_lstrip_runs(out))


def style_key(run: Run) -> tuple[object, ...]:
    return (
        run.bold,
        run.italic,
        run.underline,
        run.size,
        run.font,
        run.color,
        run.link,
        run.sup,
        run.sub,
    )


def merge_runs(runs: Sequence[Run]) -> list[Run]:
    """Adjacent runs with the same style become one run (keeps Markdown emphasis well formed)."""
    out: list[Run] = []
    for run in runs:
        if out and style_key(out[-1]) == style_key(run):
            out[-1] = out[-1].model_copy(update={"text": out[-1].text + run.text})
        else:
            out.append(run)
    return out


def plain(runs: Iterable[Run]) -> str:
    return squash("".join(r.text for r in runs))


def run_text(runs: Iterable[Run]) -> str:
    """The text of runs joined, without collapsing (for runs that are already cleaned)."""
    return "".join(r.text for r in runs)
