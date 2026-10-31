"""Font metrics and text decoding for the content engine (T6.01).

Only what the geometry needs: how many bytes make a character code, the advance width of
each code (1/1000 em), the ascent and descent for the glyph boxes, and the Unicode text of the
codes (from /ToUnicode). Vertical writing is not handled: every CMap-based font is read as
2-byte codes with horizontal advances, which is right for Identity-H.
"""

from __future__ import annotations

import re
from functools import cache
from typing import Any

import pikepdf
from reportlab.pdfbase import _fontdata, pdfmetrics

# Advance used for a glyph whose width is unknown (non-embedded base-14 fonts without /Widths).
APPROX_WIDTH = 500.0
DEFAULT_ASCENT = 800.0
DEFAULT_DESCENT = -200.0


def _hex_to_str(h: bytes) -> str:
    return bytes.fromhex(h.decode()).decode("utf-16-be", errors="replace")


def parse_tounicode(data: bytes) -> dict[int, str]:
    """Code -> text from a ToUnicode CMap (bfchar, bfrange, and the array form of bfrange)."""
    out: dict[int, str] = {}
    for block in re.findall(rb"beginbfchar(.*?)endbfchar", data, re.S):
        for src, dst in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", block):
            out[int(src, 16)] = _hex_to_str(dst)
    for block in re.findall(rb"beginbfrange(.*?)endbfrange", data, re.S):
        for lo, hi, rest in re.findall(
            rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f]+>)", block
        ):
            lo_i, hi_i = int(lo, 16), int(hi, 16)
            if rest.startswith(b"["):
                for i, d in enumerate(re.findall(rb"<([0-9A-Fa-f]+)>", rest)):
                    out[lo_i + i] = _hex_to_str(d)
            else:
                base = bytes.fromhex(rest[1:-1].decode())
                for i in range(min(hi_i - lo_i + 1, 65536)):
                    last = int.from_bytes(base[-2:], "big") + i
                    if last > 0xFFFF:
                        break
                    val = base[:-2] + last.to_bytes(2, "big")
                    out[lo_i + i] = val.decode("utf-16-be", errors="replace")
    return out


_STANDARD_FONTS = frozenset(_fontdata.standardFonts)
_SYMBOLIC = frozenset({"Symbol", "ZapfDingbats"})


@cache
def standard_widths(base: str, encoding: str) -> dict[int, float]:
    """Advance widths (1/1000 em) of a standard-14 font, by code, in the named encoding.

    The tables are the AFM metrics that reportlab ships. Used when a base-14 font has no
    /Widths, which is how most generators write them."""
    table = _fontdata.widthsByFontGlyph.get(base)
    if table is None:
        return {}
    enc = pdfmetrics.getEncoding(encoding)
    return {code: float(table[enc[code]]) for code in range(256) if enc[code] in table}


def _standard_font_widths(base: str, font: Any) -> dict[int, float]:
    if base in _SYMBOLIC or base not in _STANDARD_FONTS:
        return {}
    encoding = "StandardEncoding"
    enc_obj = font.get("/Encoding")
    if isinstance(enc_obj, pikepdf.Name):
        name = str(enc_obj).lstrip("/")
        if name in ("WinAnsiEncoding", "MacRomanEncoding", "StandardEncoding"):
            encoding = name
    elif isinstance(enc_obj, pikepdf.Dictionary) and "/BaseEncoding" in enc_obj:
        name = str(enc_obj["/BaseEncoding"]).lstrip("/")
        if name in ("WinAnsiEncoding", "MacRomanEncoding", "StandardEncoding"):
            encoding = name
    return dict(standard_widths(base, encoding))


def _number(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


class FontInfo:
    """Metrics of one font dictionary (simple or Type0)."""

    def __init__(self, font: Any) -> None:
        self.base = str(font.get("/BaseFont", "")).lstrip("/")
        self.subtype = str(font.get("/Subtype", ""))
        self.is_cid = self.subtype == "/Type0"
        descendant: Any = None
        if self.is_cid:
            kids = font.get("/DescendantFonts")
            descendant = kids[0] if kids is not None and len(kids) else None
        metrics_owner = descendant if descendant is not None else font
        descriptor = metrics_owner.get("/FontDescriptor")
        if descriptor is None:
            descriptor = font.get("/FontDescriptor")
        scale = 1.0
        self.ascent = DEFAULT_ASCENT
        self.descent = DEFAULT_DESCENT
        self.embedded = False
        self.missing_width = 0.0
        if isinstance(descriptor, pikepdf.Dictionary):
            self.ascent = _number(descriptor.get("/Ascent"), DEFAULT_ASCENT) * scale
            self.descent = _number(descriptor.get("/Descent"), DEFAULT_DESCENT) * scale
            self.missing_width = _number(descriptor.get("/MissingWidth"), 0.0)
            self.embedded = any(k in descriptor for k in ("/FontFile", "/FontFile2", "/FontFile3"))
        self._widths: dict[int, float] = {}
        self._default_width = 1000.0 if self.is_cid else APPROX_WIDTH
        if self.is_cid and descendant is not None:
            self._default_width = _number(descendant.get("/DW"), 1000.0)
            self._read_w(descendant.get("/W"))
        elif not self.is_cid:
            first = int(_number(font.get("/FirstChar"), 0))
            widths = font.get("/Widths")
            if widths is not None:
                for i, w in enumerate(widths):
                    self._widths[first + i] = _number(w, 0.0)
                self._default_width = self.missing_width
            else:
                self._widths = _standard_font_widths(self.base, font)
                if self._widths:
                    self._default_width = 0.0
        self.to_unicode: dict[int, str] = {}
        tu = font.get("/ToUnicode")
        if isinstance(tu, pikepdf.Stream):
            self.to_unicode = parse_tounicode(tu.read_bytes())

    def _read_w(self, w: Any) -> None:
        if w is None:
            return
        items = list(w)
        i = 0
        while i < len(items):
            first = int(items[i])
            nxt = items[i + 1] if i + 1 < len(items) else None
            if isinstance(nxt, pikepdf.Array):
                for k, item in enumerate(nxt):
                    self._widths[first + k] = _number(item, 0.0)
                i += 2
            elif i + 2 < len(items):
                last = int(items[i + 1])
                span_width = _number(items[i + 2], 0.0)
                for code in range(first, min(last, first + 65535) + 1):
                    self._widths[code] = span_width
                i += 3
            else:
                break

    def codes(self, data: bytes) -> list[int]:
        if self.is_cid:
            return [int.from_bytes(data[i : i + 2], "big") for i in range(0, len(data) - 1, 2)] + (
                [data[-1]] if len(data) % 2 else []
            )
        return list(data)

    def width(self, code: int) -> float:
        """Advance of ``code`` in thousandths of text space."""
        return self._widths.get(code, self._default_width)

    def text(self, code: int) -> str:
        if code in self.to_unicode:
            return self.to_unicode[code]
        if self.is_cid:
            return "?"
        return chr(code) if code < 256 else "?"
