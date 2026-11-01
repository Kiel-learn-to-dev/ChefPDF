"""What a PDF font can write (T7.01): which characters it has a glyph for, and their codes.

- Type0 (Identity-H, CIDFontType2): the code is the CID; the glyph is CIDToGIDMap(cid). A character
  is writable when the ToUnicode map (or the cmap of the program) lists a code for it AND that
  glyph has an outline in the embedded program. Subset programs keep only the glyphs that were
  used, so an unused character shows up as missing (the case that breaks Vietnamese edits).
- Simple TrueType/Type1 with a base encoding and/or /Differences: the code is the byte. The
  characters come from ToUnicode, or from the encoding (names through the Adobe glyph list).
  Glyph outlines of simple programs are not checked: the subset's ToUnicode is trusted.
- Non-embedded standard-14 fonts: WinAnsi/MacRoman covers Latin-1 and nothing of Vietnamese.
- Type3, symbolic fonts without an encoding, and fonts that cannot be read: nothing is writable.
"""

from __future__ import annotations

import codecs
import io
import re
from dataclasses import dataclass
from typing import Any

import pikepdf
from fontTools import agl
from fontTools.ttLib import TTFont

from chef_core.content.fonts import FontInfo

FLAG_FIXED_PITCH = 1 << 0
FLAG_SERIF = 1 << 1
FLAG_SYMBOLIC = 1 << 2
FLAG_ITALIC = 1 << 6
FLAG_FORCE_BOLD = 1 << 18

_BOLD = re.compile(r"bold|black|heavy|semibold|demi", re.IGNORECASE)
_ITALIC = re.compile(r"italic|oblique", re.IGNORECASE)
_SERIF = re.compile(r"times|georgia|garamond|cambria|serif|roman|palatino|minion|caslon", re.I)
_SANS = re.compile(r"sans", re.IGNORECASE)
_MONO = re.compile(r"courier|mono|consol", re.IGNORECASE)
_ENCODINGS = {"WinAnsiEncoding": "cp1252", "MacRomanEncoding": "mac_roman"}


@dataclass(frozen=True)
class FontStyle:
    name: str  # BaseFont without the subset tag
    style: str  # sans | serif | mono
    bold: bool
    italic: bool
    embedded: bool


def _descriptor(font: Any) -> pikepdf.Dictionary | None:
    desc = font.get("/FontDescriptor")
    if desc is None and "/DescendantFonts" in font and len(font["/DescendantFonts"]):
        desc = font["/DescendantFonts"][0].get("/FontDescriptor")
    return desc if isinstance(desc, pikepdf.Dictionary) else None


def font_style(font: Any) -> FontStyle:
    """Style of a font dictionary, from its name and descriptor flags."""
    name = str(font.get("/BaseFont", "")).lstrip("/")
    if "+" in name:
        name = name.split("+", 1)[1]
    desc = _descriptor(font)
    flags = int(desc.get("/Flags", 0)) if desc is not None else 0
    stem = float(desc.get("/StemV", 0)) if desc is not None else 0.0
    angle = float(desc.get("/ItalicAngle", 0)) if desc is not None else 0.0
    embedded = desc is not None and any(
        k in desc for k in ("/FontFile", "/FontFile2", "/FontFile3")
    )
    bold = bool(_BOLD.search(name)) or bool(flags & FLAG_FORCE_BOLD) or stem >= 120
    italic = bool(_ITALIC.search(name)) or bool(flags & FLAG_ITALIC) or angle != 0
    if flags & FLAG_FIXED_PITCH or _MONO.search(name):
        style = "mono"
    elif (flags & FLAG_SERIF or _SERIF.search(name)) and not _SANS.search(name):
        style = "serif"
    else:
        style = "sans"
    return FontStyle(name=name, style=style, bold=bold, italic=italic, embedded=embedded)


def _encoding_name(font: Any) -> str | None:
    enc = font.get("/Encoding")
    if isinstance(enc, pikepdf.Name):
        return str(enc).lstrip("/")
    if isinstance(enc, pikepdf.Dictionary) and "/BaseEncoding" in enc:
        return str(enc["/BaseEncoding"]).lstrip("/")
    return None


def _differences(font: Any) -> dict[int, str]:
    enc = font.get("/Encoding")
    out: dict[int, str] = {}
    if not isinstance(enc, pikepdf.Dictionary) or "/Differences" not in enc:
        return out
    code = 0
    for item in enc["/Differences"]:
        if isinstance(item, pikepdf.Name):
            out[code] = str(item).lstrip("/")
            code += 1
        else:
            code = int(item)
    return out


def _simple_unicode(font: Any) -> dict[int, str]:
    """Code -> character from the base encoding and /Differences (used without ToUnicode)."""
    base = _encoding_name(font)
    desc = _descriptor(font)
    symbolic = desc is not None and bool(int(desc.get("/Flags", 0)) & FLAG_SYMBOLIC)
    if base in _ENCODINGS:
        codec: str | None = _ENCODINGS[base]
    elif base is None and not symbolic:
        codec = "cp1252"  # the standard encoding: ASCII and Latin-1 are what matter here
    else:
        codec = None
    out: dict[int, str] = {}
    if codec is not None:
        for code in range(256):
            try:
                out[code] = codecs.decode(bytes([code]), codec)
            except UnicodeDecodeError:
                continue
    for code, glyph in _differences(font).items():
        text = agl.toUnicode(glyph)
        if text:
            out[code] = text
    return out


def _program_of(descendant: Any) -> TTFont | None:
    desc = descendant.get("/FontDescriptor")
    if not isinstance(desc, pikepdf.Dictionary) or "/FontFile2" not in desc:
        return None
    try:
        return TTFont(io.BytesIO(desc["/FontFile2"].read_bytes()), lazy=True)
    except Exception:
        return None


class FontCapability:
    """Writable characters of one font dictionary (None: the text cannot name a font)."""

    def __init__(self, font: Any) -> None:
        self.font = font
        self.kind = "none"
        self.style = FontStyle("", "sans", False, False, False)
        self._codes: dict[str, list[int]] = {}
        self._program: TTFont | None = None
        self._cid_map: bytes | None = None
        self._outline: dict[int, bool] = {}
        self._text_by_code: dict[int, str] = {}
        self.info: FontInfo | None = None
        if font is None:
            return
        self.style = font_style(font)
        subtype = str(font.get("/Subtype", ""))
        if subtype == "/Type3":
            self.kind = "unsupported"
            return
        self.info = FontInfo(font)
        if subtype == "/Type0":
            self.kind = "cid"
            self._build_cid(font)
        else:
            self.kind = "simple"
            mapping = self.info.to_unicode or _simple_unicode(font)
            self._text_by_code = dict(mapping)
            for code, text in mapping.items():
                if 0 <= code <= 255 and len(text) == 1:
                    self._codes.setdefault(text, []).append(code)

    def _build_cid(self, font: Any) -> None:
        kids = font.get("/DescendantFonts")
        descendant = kids[0] if kids is not None and len(kids) else None
        if descendant is None:
            return
        self._program = _program_of(descendant)
        cid_map = descendant.get("/CIDToGIDMap")
        if isinstance(cid_map, pikepdf.Stream):
            self._cid_map = cid_map.read_bytes()
        assert self.info is not None
        if self.info.to_unicode:
            self._text_by_code = dict(self.info.to_unicode)
            for code, text in self.info.to_unicode.items():
                if len(text) == 1:
                    self._codes.setdefault(text, []).append(code)
        elif self._program is not None and "cmap" in self._program:
            for cp, glyph in self._program.getBestCmap().items():
                gid = self._program.getGlyphID(glyph)
                self._codes.setdefault(chr(cp), []).append(gid)
                self._text_by_code.setdefault(gid, chr(cp))

    def _cid_gid(self, cid: int) -> int:
        if self._cid_map is None:
            return cid
        pos = cid * 2
        if pos + 1 >= len(self._cid_map):
            return 0
        return int.from_bytes(self._cid_map[pos : pos + 2], "big")

    def _glyph_has_outline(self, gid: int) -> bool:
        """True when the embedded program has an outline for ``gid`` (no program: True)."""
        if self._program is None or "glyf" not in self._program:
            return True
        found = self._outline.get(gid)
        if found is None:
            names = self._program.getGlyphOrder()
            if gid >= len(names):
                found = False
            else:
                glyph = self._program["glyf"][names[gid]]
                found = glyph.isComposite() or glyph.numberOfContours != 0
            self._outline[gid] = found
        return found

    def code_for(self, ch: str) -> int | None:
        """The code that writes ``ch`` in this font, or None when it cannot."""
        if self.kind not in ("cid", "simple"):
            return None
        for code in self._codes.get(ch, []):
            if self.kind == "simple":
                return code
            if ch == " " or self._glyph_has_outline(self._cid_gid(code)):
                return code
        return None

    def text_of(self, code: int) -> str:
        """The character a code shows (ToUnicode first); '?' when nothing is known."""
        return self._text_by_code.get(code, "?")

    def chunk(self, code: int) -> bytes:
        """The bytes of one code in a string operand."""
        return code.to_bytes(2, "big") if self.kind == "cid" else bytes([code])

    def can(self, ch: str) -> bool:
        return self.code_for(ch) is not None

    def missing(self, text: str) -> list[str]:
        """Characters of ``text`` this font cannot write, each listed once, in order."""
        seen: list[str] = []
        for ch in text:
            if ch in seen or ch in "\r\n\t":
                continue
            if not self.can(ch):
                seen.append(ch)
        return seen


def check_font_supports(font: Any, text: str) -> dict[str, Any]:
    """Can this font write ``text``? Result: supported, missing (unique characters), hints.

    Hints are short codes the UI can show: 'keep' when the font writes everything, otherwise
    'substitute' followed by a message for the user."""
    cap = FontCapability(font)
    missing = cap.missing(text)
    name = cap.style.name or "(không rõ font)"
    hints: list[str] = ["keep"] if not missing else ["substitute"]
    if missing:
        if cap.kind == "unsupported" or cap.kind == "none":
            hints.append(f"{name}: kiểu font này không sửa được")
        elif not cap.style.embedded:
            hints.append(f"{name} không nhúng trong file: bảng mã chuẩn không có các ký tự này")
        else:
            hints.append(f"{name} là font nhúng (thường là bản con), thiếu: {''.join(missing)}")
    return {"supported": not missing, "missing": missing, "hints": hints}
