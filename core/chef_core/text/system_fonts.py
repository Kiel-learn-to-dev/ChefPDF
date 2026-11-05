"""Fonts installed on the computer (1.1, D62): listing them and matching a document's font to one.

The list comes from the font registry of the system (Windows: ``HKLM`` and ``HKCU`` under
``Windows NT\\CurrentVersion\\Fonts``), with a folder scan as the fallback. A system font is a
``FontEntry`` with the id ``sys:<hash of its path>``. Only TrueType files are used: the text engine
embeds subsets of TrueType outlines.

``match_original`` finds the installed font of a document's font name (``ABCDEF+ArialMT,Bold``
gives Arial, bold) that writes the characters needed. The text editor keeps a font the document
already has; a system font of the same family is the next choice, before a bundled font.
"""

from __future__ import annotations

import hashlib
import os
import re
from functools import cache
from pathlib import Path

from chef_core.text.fonts import FontEntry, covers

SYSTEM_PREFIX = "sys:"
# Words that end a registry name as style (not family): "Times New Roman" keeps "Roman".
_STYLE_WORDS = ("bold", "italic", "oblique", "regular")
_HEAVY = ("semibold", "demibold", "black", "heavy", "extrabold", "ultrabold")
_SERIF = ("times", "georgia", "cambria", "garamond", "palatino", "bookman", "serif")
_MONO = ("consol", "courier", "mono", "lucida console")
_EXTENSIONS = (".ttf",)


def _squash(name: str) -> str:
    return "".join(ch for ch in name.lower() if ch.isalnum())


def _style_class(family: str) -> str:
    low = family.lower()
    if any(word in low for word in _MONO):
        return "mono"
    if any(word in low for word in _SERIF):
        return "serif"
    return "sans"


def parse_display_name(display: str) -> tuple[str, bool, bool] | None:
    """Family, bold and italic of a registry name such as ``Arial Bold Italic (TrueType)``."""
    name = re.sub(r"\s*\((TrueType|OpenType|All res)[^)]*\)\s*$", "", display).strip()
    if not name:
        return None
    words = name.split()
    bold = False
    italic = False
    while words and words[-1].lower() in (*_STYLE_WORDS, *_HEAVY):
        last = words.pop().lower()
        if last in _HEAVY or last == "bold":
            bold = True
        elif last in ("italic", "oblique"):
            italic = True
    if not words:
        return None
    return " ".join(words), bold, italic


def _entry(path: Path, family: str, bold: bool, italic: bool) -> FontEntry:
    digest = hashlib.sha1(str(path).lower().encode()).hexdigest()[:12]
    return FontEntry(
        id=f"{SYSTEM_PREFIX}{digest}",
        file=path,
        family=family,
        style=_style_class(family),
        bold=bold,
        italic=italic,
        coverage="system",
        license="installed on this computer",
    )


def _windows_registry() -> list[tuple[str, Path]]:
    import winreg

    windows = Path(os.environ.get("SYSTEMROOT", r"C:\Windows"))
    roots = (
        (winreg.HKEY_LOCAL_MACHINE, windows / "Fonts"),
        (
            winreg.HKEY_CURRENT_USER,
            Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft/Windows/Fonts",
        ),
    )
    out: list[tuple[str, Path]] = []
    for hive, folder in roots:
        try:
            key = winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts")
        except OSError:
            continue
        with key:
            index = 0
            while True:
                try:
                    display, data, _ = winreg.EnumValue(key, index)
                except OSError:
                    break
                index += 1
                file = Path(str(data))
                out.append((str(display), file if file.is_absolute() else folder / file))
    return out


def _folder_scan() -> list[tuple[str, Path]]:
    dirs = [Path(os.environ.get("SYSTEMROOT", r"C:\Windows")) / "Fonts"]
    local = os.environ.get("LOCALAPPDATA")
    if local:
        dirs.append(Path(local) / "Microsoft/Windows/Fonts")
    dirs += [Path("/usr/share/fonts"), Path("/System/Library/Fonts"), Path.home() / ".fonts"]
    out: list[tuple[str, Path]] = []
    for folder in dirs:
        if not folder.is_dir():
            continue
        for file in folder.rglob("*"):
            if file.suffix.lower() in _EXTENSIONS and file.is_file():
                out.append((file.stem, file))
    return out


@cache
def system_entries() -> tuple[FontEntry, ...]:
    """Every TrueType font the system lists, once per process."""
    try:
        listed = _windows_registry() if os.name == "nt" else _folder_scan()
    except OSError:
        listed = _folder_scan()
    seen: set[str] = set()
    out: list[FontEntry] = []
    for display, path in listed:
        if path.suffix.lower() not in _EXTENSIONS or not path.is_file():
            continue
        parsed = parse_display_name(display)
        if parsed is None:
            continue
        family, bold, italic = parsed
        entry_ = _entry(path, family, bold, italic)
        if entry_.id in seen:
            continue
        seen.add(entry_.id)
        out.append(entry_)
    out.sort(key=lambda e: (e.family.lower(), e.bold, e.italic))
    return tuple(out)


def system_entry(font_id: str) -> FontEntry | None:
    for item in system_entries():
        if item.id == font_id:
            return item
    return None


def normalize_base_font(base_font: str) -> tuple[str, bool, bool]:
    """Family key, bold and italic of a PDF BaseFont name (``ABCDEF+TimesNewRomanPS-BoldMT``)."""
    name = base_font.lstrip("/")
    if "+" in name:
        name = name.split("+", 1)[1]
    if "," in name:
        family_part, style_part = name.split(",", 1)
    else:
        family_part, _, style_part = name.partition("-")
    style = style_part.lower()
    bold = any(word in style for word in ("bold", *_HEAVY))
    italic = "italic" in style or "oblique" in style
    family = _squash(family_part)
    # PostScript suffixes that the installed family name does not have.
    family = re.sub(r"(ps|mt)+$", "", family)
    return family, bold, italic


def match_original(
    base_font: str, codepoints: set[int], bold: bool, italic: bool
) -> FontEntry | None:
    """The installed font of the document's font that writes every character, same weight and
    slant first. None when the font is not installed or lacks a character."""
    family, _, _ = normalize_base_font(base_font)
    if not family:
        return None
    best: FontEntry | None = None
    best_score = -1
    for item in system_entries():
        if re.sub(r"(ps|mt)+$", "", _squash(item.family)) != family:
            continue
        if not covers(item, codepoints):
            continue
        score = (2 if item.bold == bold else 0) + (1 if item.italic == italic else 0)
        if score > best_score:
            best, best_score = item, score
    return best
