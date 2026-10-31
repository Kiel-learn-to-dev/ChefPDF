"""Font faces for overlays (T4.01): metrics, subsetting and ToUnicode maps (fontTools, MIT).

Subsets keep the glyph ids of the full font (``retain_gids``), so a CIDFontType2 with
``/CIDToGIDMap /Identity`` can use the original glyph ids as CIDs without any remapping.

Every subset of one font contains the Vietnamese base set (``BASE_RANGES``), so most documents
need one embedded font per family and weight. Other characters get an extra subset, keyed by
the extra characters, which is cached in the document too.
"""

from __future__ import annotations

import functools
import io
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

from chef_core.errors import ChefError, ErrorKind
from chef_core.signing.fonts import font_path

KNOWN_FAMILIES = frozenset({"BeVietnamPro"})

# Code points that every subset carries: printable ASCII, Latin-1, Latin Extended-A, the
# Vietnamese letters of Latin Extended-B (Ơ ơ Ư ư), Latin Extended Additional (Vietnamese
# vowels with tone marks), common punctuation, the euro and dong signs, and ™.
BASE_RANGES: tuple[tuple[int, int], ...] = (
    (0x20, 0x7E),
    (0xA0, 0xFF),
    (0x100, 0x17F),
    (0x1A0, 0x1A1),
    (0x1AF, 0x1B0),
    (0x1E00, 0x1EFF),
    (0x2010, 0x2027),
    (0x2030, 0x203A),
    (0x20AB, 0x20AC),
    (0x2116, 0x2116),
    (0x2122, 0x2122),
)

_DROP_TABLES = ["GSUB", "GPOS", "GDEF", "DSIG", "hdmx", "VDMX", "LTSH", "kern", "meta"]


@dataclass(frozen=True)
class Subset:
    """A subset font program and the glyph id to code point map of the glyphs it keeps."""

    program: bytes
    gid_to_cp: dict[int, int]


class FontFace:
    """One bundled font: metrics from the full font, subsets from the bundled file."""

    def __init__(self, family: str, *, bold: bool) -> None:
        if family not in KNOWN_FAMILIES:
            raise ChefError(ErrorKind.INVALID_PARAMS, f"Unknown font: {family}")
        self.family = family
        self.bold = bold
        self.path: Path = font_path(family, bold=bold)
        font = TTFont(self.path)
        try:
            self.units_per_em: int = int(font["head"].unitsPerEm)
            self.ascent: float = font["hhea"].ascent / self.units_per_em
            self.descent: float = font["hhea"].descent / self.units_per_em
            self.bbox: tuple[int, int, int, int] = (
                int(font["head"].xMin),
                int(font["head"].yMin),
                int(font["head"].xMax),
                int(font["head"].yMax),
            )
            os2 = font["OS/2"]
            cap = getattr(os2, "sCapHeight", 0) or int(0.7 * self.units_per_em)
            self.cap_height: int = int(cap)
            self.postscript_name: str = str(font["name"].getDebugName(6) or family)
            self._cmap: dict[int, int] = {}
            glyph_ids = {name: gid for gid, name in enumerate(font.getGlyphOrder())}
            for cp, name in font.getBestCmap().items():
                self._cmap[int(cp)] = glyph_ids[name]
            self._advance: list[int] = [0] * len(glyph_ids)
            for name, gid in glyph_ids.items():
                self._advance[gid] = int(font["hmtx"][name][0])
        finally:
            font.close()

    def supports(self, cp: int) -> bool:
        return cp in self._cmap

    def gid(self, cp: int) -> int | None:
        return self._cmap.get(cp)

    def advance(self, cp: int) -> int:
        """Advance width in font units (0 for characters the font does not have)."""
        gid = self._cmap.get(cp)
        return 0 if gid is None else self._advance[gid]

    def base_codepoints(self) -> set[int]:
        """The base set that this font supports."""
        return {cp for lo, hi in BASE_RANGES for cp in range(lo, hi + 1) if cp in self._cmap}

    def subset(self, codepoints: Iterable[int]) -> Subset:
        """Subset with the glyph ids of the full font. Unsupported code points are ignored."""
        wanted = sorted({cp for cp in codepoints if cp in self._cmap})
        font = TTFont(self.path)
        options = subset.Options()
        options.retain_gids = True
        options.hinting = False
        options.layout_features = []
        options.drop_tables += _DROP_TABLES
        options.notdef_outline = True
        options.name_IDs = [0, 1, 2, 3, 4, 5, 6]
        subsetter = subset.Subsetter(options=options)
        subsetter.populate(unicodes=wanted)
        subsetter.subset(font)
        buf = io.BytesIO()
        font.save(buf)
        font.close()
        gid_to_cp = {self._cmap[cp]: cp for cp in wanted}
        return Subset(program=buf.getvalue(), gid_to_cp=gid_to_cp)


@functools.lru_cache(maxsize=8)
def face(family: str, bold: bool) -> FontFace:
    """The shared, read-only face for a family and weight."""
    return FontFace(family, bold=bold)


def to_unicode_cmap(gid_to_cp: dict[int, int]) -> bytes:
    """ToUnicode CMap (2-byte glyph ids to UTF-16) so that text stays searchable and copyable."""
    lines = [
        "/CIDInit /ProcSet findresource begin",
        "12 dict begin",
        "begincmap",
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
        "/CMapName /Adobe-Identity-UCS def",
        "/CMapType 2 def",
        "1 begincodespacerange",
        "<0000> <FFFF>",
        "endcodespacerange",
    ]
    items = sorted(gid_to_cp.items())
    for start in range(0, len(items), 100):
        chunk = items[start : start + 100]
        lines.append(f"{len(chunk)} beginbfchar")
        for gid, cp in chunk:
            lines.append(f"<{gid:04X}> <{_utf16_hex(cp)}>")
        lines.append("endbfchar")
    lines += [
        "endcmap",
        "CMapName currentdict /CMap defineresource pop",
        "end",
        "end",
    ]
    return ("\n".join(lines) + "\n").encode("ascii")


def _utf16_hex(cp: int) -> str:
    return "".join(f"{unit:04X}" for unit in _utf16_units(cp))


def _utf16_units(cp: int) -> list[int]:
    if cp < 0x10000:
        return [cp]
    cp -= 0x10000
    return [0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF)]
