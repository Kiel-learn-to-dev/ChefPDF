"""Font registry for replacement text (T7.02).

The fonts are listed in ``chef_core/resources/fonts/manifest.json``. An entry gives the file, the
family, the style class (sans, serif or mono), the weight and slant, and the coverage. Adding a
font means copying the file there and adding an entry; nothing else changes.

``pick`` chooses the font that covers every character needed and is closest to the original
text: same style class first, then same weight, then same slant, then manifest order.
"""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from functools import cache
from importlib import resources
from pathlib import Path
from typing import Any

from chef_core.overlay.fonts import FontFace

MANIFEST_NAME = "manifest.json"
STYLES = frozenset({"sans", "serif", "mono"})


@dataclass(frozen=True)
class FontEntry:
    id: str
    file: Path
    family: str
    style: str  # sans | serif | mono
    bold: bool
    italic: bool
    coverage: str
    license: str

    def face(self) -> FontFace:
        return _face(str(self.file), self.family, self.bold)


@dataclass(frozen=True)
class Wanted:
    """The style of the text being replaced (from its font name and flags). ``family`` is the
    original BaseFont name: a registry family whose name it contains is preferred."""

    style: str = "sans"
    bold: bool = False
    italic: bool = False
    family: str = ""


def fonts_dir() -> Path:
    return Path(str(resources.files("chef_core.resources") / "fonts"))


@cache
def _face(path: str, family: str, bold: bool) -> FontFace:
    return FontFace(family, bold=bold, path=Path(path))


@cache
def load_registry() -> tuple[FontEntry, ...]:
    """All usable entries of the manifest, in manifest order. Missing files are skipped."""
    directory = fonts_dir()
    raw: dict[str, Any] = json.loads((directory / MANIFEST_NAME).read_text(encoding="utf-8"))
    out: list[FontEntry] = []
    seen: set[str] = set()
    for item in raw.get("fonts", []):
        style = str(item.get("style", "sans"))
        if style not in STYLES:
            raise ValueError(f"font {item.get('id')}: unknown style {style!r}")
        font_id = str(item["id"])
        if font_id in seen:
            raise ValueError(f"font {font_id}: listed twice in the manifest")
        seen.add(font_id)
        path = directory / str(item["file"])
        if not path.is_file():
            continue
        out.append(
            FontEntry(
                id=font_id,
                file=path,
                family=str(item.get("family", font_id)),
                style=style,
                bold=bool(item.get("bold", False)),
                italic=bool(item.get("italic", False)),
                coverage=str(item.get("coverage", "")),
                license=str(item.get("license", "")),
            )
        )
    return tuple(out)


def entry(font_id: str) -> FontEntry | None:
    """A bundled font by id, or a font installed on the computer (``sys:`` ids)."""
    if font_id.startswith("sys:"):
        from chef_core.text.system_fonts import system_entry

        return system_entry(font_id)
    for item in load_registry():
        if item.id == font_id:
            return item
    return None


def covers(item: FontEntry, codepoints: set[int]) -> bool:
    face = item.face()
    return all(face.supports(cp) for cp in codepoints)


def missing_in_all(codepoints: set[int]) -> set[int]:
    """Code points that no registry font covers."""
    faces = [item.face() for item in load_registry()]
    return {cp for cp in codepoints if not any(face.supports(cp) for face in faces)}


def _squash(name: str) -> str:
    return "".join(ch for ch in name.lower() if ch.isalnum())


def _score(item: FontEntry, want: Wanted) -> int:
    score = 0
    family = _squash(item.family)
    if family and family in _squash(want.family):
        score += 6
    if item.style == want.style:
        score += 4
    if item.bold == want.bold:
        score += 3
    if item.italic == want.italic:
        score += 2
    return score


def pick(codepoints: set[int], want: Wanted) -> FontEntry | None:
    """The closest font that covers every code point, or None."""
    best: FontEntry | None = None
    best_score = -1
    for item in load_registry():
        if not covers(item, codepoints):
            continue
        score = _score(item, want)
        if score > best_score:
            best, best_score = item, score
    return best


# ---------- Wording of the warnings (what people read, never an internal id) ----------

_CONTROL = ("Cc", "Cf", "Co", "Cn", "Cs", "Zl", "Zp", "Zs")


def display_name(font_id: str | None) -> str | None:
    """The family of a font for people to read: a bundled id or a ``sys:`` id gives its family."""
    if font_id is None:
        return None
    item = entry(font_id)
    return item.family if item is not None else font_id


def family_key(name: str) -> str:
    """Squashed family of a PDF BaseFont or family name (no subset tag, style or PS/MT)."""
    base = name.lstrip("/").split("+", 1)[-1]
    family = re.split(r"[-,]", base, maxsplit=1)[0]
    return re.sub(r"(ps|mt)+$", "", _squash(family))


def old_font_label(base_font: str) -> str:
    """The document's font for a message: the installed family when this computer has it, else the
    BaseFont with its subset tag, style and PS/MT suffixes removed ("TimesNewRomanPS-BoldMT" gives
    "TimesNewRoman")."""
    from chef_core.text.system_fonts import installed_match

    installed = installed_match(base_font, False, False)
    if installed is not None:
        return installed.family
    base = base_font.lstrip("/").split("+", 1)[-1]
    family = re.split(r"[-,]", base, maxsplit=1)[0]
    return re.sub(r"(PS|MT)+$", "", family) or base_font


def chars_label(chars: list[str] | str) -> str:
    """Characters for a message. An invisible or unprintable one is shown as its code point."""
    out: list[str] = []
    for ch in dict.fromkeys(chars):
        if unicodedata.category(ch) in _CONTROL or ch.isspace():
            out.append(f"U+{ord(ch):04X}")
        else:
            out.append(ch)
    return " ".join(out)


def substitution_note(old_name: str, new_family: str, missing: list[str] | str) -> str:
    """The warning for a text that takes another font. The same family is not a substitution: it
    says that the full version of the font writes the characters the document's subset lacks."""
    chars = chars_label(missing) if missing else ""
    if family_key(old_name) == _squash(new_family):
        if chars:
            return f"Đã dùng bản đầy đủ của font {new_family} cho ký tự: {chars}."
        return f"Đã dùng font {new_family}."
    if chars:
        return f"Đã thay font {old_name} bằng {new_family} vì font gốc thiếu: {chars}."
    return f"Đã thay font {old_name} bằng {new_family}."
