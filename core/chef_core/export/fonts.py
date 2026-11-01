"""Mapping of the fonts detected in the source to fonts that a reader or Word has.

The source fonts cannot be reused (they are subsets and not installed). The rule: a serif name maps
to Times New Roman, a monospace name to Courier New, anything else to Arial. A name that is already
Be Vietnam Pro (the font Chef PDF ships) is kept.
"""

from __future__ import annotations

SERIF_HINTS = (
    "times",
    "georgia",
    "garamond",
    "cambria",
    "roman",
    "serif",
    "minion",
    "palatino",
    "bodoni",
    "century",
    "book",
)
MONO_HINTS = ("courier", "mono", "consol", "typewriter")
BE_VIETNAM = "Be Vietnam Pro"
FALLBACK_SANS = "Arial"
FALLBACK_SERIF = "Times New Roman"
FALLBACK_MONO = "Courier New"


def font_class(name: str | None) -> str:
    """``serif``, ``mono``, ``sans`` (unknown names count as sans)."""
    if not name:
        return "sans"
    lower = name.lower()
    if any(h in lower for h in MONO_HINTS):
        return "mono"
    if any(h in lower for h in SERIF_HINTS):
        return "serif"
    return "sans"


def installed_name(name: str | None) -> str:
    """The name to write into a document (Word, ODT, HTML) for the source font ``name``."""
    if name and BE_VIETNAM.replace(" ", "").lower() in name.replace(" ", "").lower():
        return BE_VIETNAM
    return {"serif": FALLBACK_SERIF, "mono": FALLBACK_MONO}.get(font_class(name), FALLBACK_SANS)


def css_stack(name: str | None) -> str:
    """A CSS font-family list: the mapped font, then Be Vietnam Pro, then a generic family."""
    mapped = installed_name(name)
    generic = {"serif": "serif", "mono": "monospace"}.get(font_class(name), "sans-serif")
    parts = [f"'{mapped}'"]
    if mapped != BE_VIETNAM:
        parts.append(f"'{BE_VIETNAM}'")
    parts.append(generic)
    return ", ".join(parts)
