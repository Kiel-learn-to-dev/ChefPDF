"""Locate Unicode TrueType fonts that cover Vietnamese, across OSes.

The spikes must not download fonts at run time (GitHub is not always
reachable), so we look for well-known system fonts. Override with the
environment variables CHEF_SPIKE_FONT / CHEF_SPIKE_FONT_BOLD /
CHEF_SPIKE_FONT_ALT (alternate face used as "replacement" font in S2).
"""

from __future__ import annotations

import os
from pathlib import Path

_REGULAR = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
]
_BOLD = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
]
_ALT = [
    "/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf",
    "/usr/share/fonts/liberation/LiberationSerif-Regular.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
    "C:/Windows/Fonts/times.ttf",
    "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
]


def _pick(env: str, candidates: list[str]) -> Path:
    override = os.environ.get(env)
    if override:
        p = Path(override)
        if not p.is_file():
            raise FileNotFoundError(f"{env}={override} does not exist")
        return p
    for c in candidates:
        p = Path(c)
        if p.is_file():
            return p
    raise FileNotFoundError(
        f"No Vietnamese-capable TTF found; set {env} to a .ttf path "
        "(e.g. DejaVuSans.ttf, Arial, Be Vietnam Pro, Noto Sans)."
    )


def regular_font() -> Path:
    return _pick("CHEF_SPIKE_FONT", _REGULAR)


def bold_font() -> Path:
    return _pick("CHEF_SPIKE_FONT_BOLD", _BOLD)


def alt_font() -> Path:
    return _pick("CHEF_SPIKE_FONT_ALT", _ALT)


def font_1000_upm(src: Path, out_dir: Path) -> Path:
    """Copy of `src` rescaled to unitsPerEm=1000.

    Workaround for a pyHanko 0.38 bug (verified in spike S1): its OpenType
    embedding (GlyphAccumulator) writes /W widths and TJ adjustments in raw font
    units, i.e. it silently assumes unitsPerEm == 1000. TrueType fonts such as
    DejaVu, Arial or Times use 2048, so glyphs are drawn far apart.
    """
    from fontTools.ttLib import TTFont
    from fontTools.ttLib.scaleUpem import scale_upem

    dst = out_dir / f"_{src.stem}-1000upm.ttf"
    if not dst.exists():
        out_dir.mkdir(parents=True, exist_ok=True)
        f = TTFont(str(src))
        if f["head"].unitsPerEm != 1000:
            scale_upem(f, 1000)
        f.save(str(dst))
    return dst
