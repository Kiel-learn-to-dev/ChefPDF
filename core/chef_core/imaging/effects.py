"""Scanner-like effects for page images (K4).

Everything runs on Pillow's C paths; there are no per-pixel Python loops. numpy is not a
dependency of chef-core, so it is not used. Randomness comes only from ``random.Random``
seeded per (seed, page): the same inputs always produce the same pixels.
"""

from __future__ import annotations

import random
from typing import Final

from PIL import Image, ImageChops, ImageEnhance, ImageFilter
from pydantic import Field

from chef_core.models import WireModel

HEX_COLOR_PATTERN: Final = r"^#[0-9A-Fa-f]{6}$"
GRAIN_AMPLITUDE: Final = 0.35  # grain=1 spans about +-45 levels around the paper value
JITTER_SPREAD: Final = 0.3  # jitter moves each value by up to +-30%

_RADIAL: Final = Image.radial_gradient("L")  # 256x256, 0 at centre, ~181 at the edge midpoints


class ScanEffects(WireModel):
    """Parameters for one scanner look. The defaults are neutral (no effect)."""

    rotation_degrees: float = Field(default=0.0, ge=0.0, le=5.0)  # max random skew
    noise: float = Field(default=0.0, ge=0.0, le=1.0)  # grain amount
    paper_tint: float = Field(default=0.0, ge=0.0, le=1.0)  # yellowing / grey cast strength
    tint_color: str = Field(default="#f4efe1", pattern=HEX_COLOR_PATTERN)
    edge_shadow: float = Field(default=0.0, ge=0.0, le=1.0)  # darkening at the page borders
    blur: float = Field(default=0.0, ge=0.0, le=3.0)  # gaussian radius in px
    contrast: float = Field(default=1.0, ge=0.5, le=1.5)
    brightness: float = Field(default=1.0, ge=0.5, le=1.5)
    jitter: bool = False  # each page gets slightly different values within the ranges
    seed: int | None = None  # mixed into the per-page random seed when set


EFFECT_PRESETS: Final[dict[str, ScanEffects]] = {
    "none": ScanEffects(),
    "light": ScanEffects(rotation_degrees=0.5, noise=0.1, jitter=True),
    "photocopy": ScanEffects(
        rotation_degrees=0.8,
        noise=0.15,
        paper_tint=0.5,
        tint_color="#d9d9d9",
        edge_shadow=0.3,
        blur=0.5,
        contrast=1.3,
        jitter=True,
    ),
    "old-paper": ScanEffects(
        rotation_degrees=0.5,
        noise=0.25,
        paper_tint=0.8,
        edge_shadow=0.2,
        blur=0.6,
        contrast=0.95,
        jitter=True,
    ),
}


def get_preset(name: str) -> ScanEffects:
    """Return the named preset, or raise ValueError for an unknown name."""
    if name not in EFFECT_PRESETS:
        raise ValueError(f"Unknown scan preset: {name}")
    return EFFECT_PRESETS[name]


def skew(img: Image.Image, degrees: float) -> Image.Image:
    """Rotate around the centre, keeping the page size; uncovered corners become white."""
    fill: int | tuple[int, int, int] = 255 if img.mode == "L" else (255, 255, 255)
    return img.rotate(degrees, resample=Image.Resampling.BICUBIC, expand=False, fillcolor=fill)


def _is_neutral(fx: ScanEffects, angle: float) -> bool:
    return (
        angle == 0.0
        and fx.noise == 0.0
        and fx.paper_tint == 0.0
        and fx.edge_shadow == 0.0
        and fx.blur == 0.0
        and fx.contrast == 1.0
        and fx.brightness == 1.0
    )


def _resolve(
    fx: ScanEffects, base_seed: int, page_index: int
) -> tuple[random.Random, float, ScanEffects]:
    """Per-page random source, skew angle and the effective (jittered) parameters."""
    key = f"{base_seed}:{page_index}" if fx.seed is None else f"{base_seed}:{fx.seed}:{page_index}"
    rng = random.Random(key)
    angle = rng.uniform(-fx.rotation_degrees, fx.rotation_degrees) if fx.rotation_degrees else 0.0
    if not fx.jitter:
        return rng, angle, fx

    def wobble(value: float, low: float, high: float) -> float:
        return min(high, max(low, value * rng.uniform(1 - JITTER_SPREAD, 1 + JITTER_SPREAD)))

    def around_one(value: float) -> float:
        factor = rng.uniform(1 - JITTER_SPREAD, 1 + JITTER_SPREAD)
        return min(1.5, max(0.5, 1.0 + (value - 1.0) * factor))

    effective = fx.model_copy(
        update={
            "noise": wobble(fx.noise, 0.0, 1.0),
            "paper_tint": wobble(fx.paper_tint, 0.0, 1.0),
            "edge_shadow": wobble(fx.edge_shadow, 0.0, 1.0),
            "blur": wobble(fx.blur, 0.0, 3.0),
            "contrast": around_one(fx.contrast),
            "brightness": around_one(fx.brightness),
        }
    )
    return rng, angle, effective


def _tint(img: Image.Image, amount: float, color: str) -> Image.Image:
    """Multiply the page by a colour lerped from white towards the tint colour."""
    red, green, blue = (int(color[i : i + 2], 16) for i in (1, 3, 5))
    if img.mode == "L":
        luma = round(0.299 * red + 0.587 * green + 0.114 * blue)
        level = round(255 + amount * (luma - 255))
        return ImageChops.multiply(img, Image.new("L", img.size, level))
    layer = tuple(round(255 + amount * (c - 255)) for c in (red, green, blue))
    return ImageChops.multiply(img, Image.new("RGB", img.size, layer))


def _edge_shadow(img: Image.Image, amount: float) -> Image.Image:
    """Darken toward the borders. The centre stays untouched; the ramp starts at half radius."""
    ramp = _RADIAL.resize(img.size, Image.Resampling.BILINEAR)
    # Ramp values run from 90 (half radius) to 181 (edge midpoint); corners clip to 1.
    lut = [round(255 - 255 * amount * min(1.0, max(0.0, (v - 90) / 91))) for v in range(256)]
    mask = ramp.point(lut)
    if img.mode == "RGB":
        mask = Image.merge("RGB", (mask, mask, mask))
    return ImageChops.multiply(img, mask)


def _grain(img: Image.Image, amount: float, rng: random.Random) -> Image.Image:
    """Zero-mean monochrome grain from the seeded generator, added to every channel."""
    width, height = img.size
    raw = Image.frombytes("L", img.size, rng.randbytes(width * height))
    lut = [min(255, max(0, round(128 + (v - 128) * amount * GRAIN_AMPLITUDE))) for v in range(256)]
    grain = raw.point(lut)
    if img.mode == "RGB":
        grain = Image.merge("RGB", (grain, grain, grain))
    return ImageChops.add(img, grain, scale=1.0, offset=-128)


def apply_scan_effects(
    img: Image.Image, fx: ScanEffects, page_index: int, base_seed: int
) -> Image.Image:
    """Return a scanner-looking copy of ``img`` with the same size and mode family.

    Only RGB, L and 1 are processed natively; other modes are converted to RGB first.
    Mode "1" gets the skew only (blur, tint, shadow, tone and grain need grey levels).
    The input is never modified.
    """
    rng, angle, params = _resolve(fx, base_seed, page_index)
    if _is_neutral(params, angle):
        return img.copy()

    if img.mode == "1":
        if angle == 0.0:
            return img.copy()
        grey = skew(img.convert("L"), angle)
        return grey.convert("1", dither=Image.Dither.NONE)

    work = img if img.mode in ("RGB", "L") else img.convert("RGB")
    if angle != 0.0:
        work = skew(work, angle)
    if params.blur > 0.0:
        work = work.filter(ImageFilter.GaussianBlur(params.blur))
    if params.paper_tint > 0.0:
        work = _tint(work, params.paper_tint, fx.tint_color)
    if params.edge_shadow > 0.0:
        work = _edge_shadow(work, params.edge_shadow)
    if params.contrast != 1.0:
        work = ImageEnhance.Contrast(work).enhance(params.contrast)
    if params.brightness != 1.0:
        work = ImageEnhance.Brightness(work).enhance(params.brightness)
    if params.noise > 0.0:
        work = _grain(work, params.noise, rng)
    return work
