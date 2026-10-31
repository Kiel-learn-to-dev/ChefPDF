"""Pure image processing for signature and stamp images (T3.11, features I19-I22).

Everything here works on Pillow images and takes plain Python values, so the operations in
``chef_core.ops.image_sig`` stay thin. Full-size images are only processed with Pillow's C-level
operations (point lookup tables, ``ImageChops``, filters, resampling). Per-pixel Python loops run
only on thumbnails of about 400 px, which keeps a 3000 x 2000 scan well under a second per step.

Colour distance is the Chebyshev distance (largest per-channel difference), so a tolerance is
the same as "every channel within +-tolerance".
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections import deque
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps

from chef_core.signing.fonts import font_path

Rgb = tuple[int, int, int]
StrokePoint = tuple[float, float, float]  # x, y, pressure (0..1)
RemovalMode = Literal["ink-color", "paper-white", "auto"]

HEX_RE = re.compile(r"^#?([0-9A-Fa-f]{6})$")
THUMB = 400  # longest side of thumbnails that are scanned pixel by pixel
PAPER_TARGET = 200  # short side of the image used to estimate the paper level
MIN_INK_RATIO = 0.0005  # below this share of ink, paper-white removal counts as failed
INK_CHROMA = 40  # pixels with a larger channel spread than this count as coloured ink
INK_DARK = 110  # ... and pixels darker than this count as dark ink
STROKE_SCALE = 4  # supersampling factor for strokes


def parse_hex(value: str) -> Rgb:
    match = HEX_RE.match(value.strip())
    if match is None:
        raise ValueError(f"not a hex colour: {value!r}")
    digits = match.group(1)
    return (int(digits[0:2], 16), int(digits[2:4], 16), int(digits[4:6], 16))


def hex_of(color: Rgb) -> str:
    return "#{:02X}{:02X}{:02X}".format(*color)


def bundled_font_path(name: str) -> Path:
    return font_path(name, bold=False)


# -- basic helpers --------------------------------------------------------------------------


def has_transparency(img: Image.Image) -> bool:
    if img.mode not in ("RGBA", "LA"):
        return False
    opaque = img.getchannel("A").histogram()[255]
    return opaque < img.width * img.height


def flatten_on_white(img: Image.Image) -> Image.Image:
    """RGB version of ``img``; transparent pixels become white (not black)."""
    if img.mode in ("RGBA", "LA", "PA") or (img.mode == "P" and "transparency" in img.info):
        rgba = img.convert("RGBA")
        base = Image.new("RGB", img.size, (255, 255, 255))
        base.paste(rgba, mask=rgba.getchannel("A"))
        return base
    return img.convert("RGB")


def to_rgba(img: Image.Image) -> Image.Image:
    """RGBA copy; an image without alpha becomes fully opaque."""
    return img.convert("RGBA")


def ink_mask(img: Image.Image) -> Image.Image:
    """0/255 mask of the ink: alpha >= 128 when the image has transparency, otherwise dark
    pixels (luminance below 128) of the image flattened on white."""
    if has_transparency(img):
        return img.getchannel("A").point(lambda v: 255 if v >= 128 else 0)
    gray = flatten_on_white(img).convert("L")
    return gray.point(lambda v: 255 if v < 128 else 0)


def _count_255(mask: Image.Image) -> int:
    return int(mask.histogram()[255])


def chebyshev(rgb: Image.Image, color: Rgb) -> Image.Image:
    """'L' image of the largest per-channel difference between each pixel and ``color``."""
    r, g, b = rgb.split()
    dr = ImageChops.difference(r, Image.new("L", rgb.size, color[0]))
    dg = ImageChops.difference(g, Image.new("L", rgb.size, color[1]))
    db = ImageChops.difference(b, Image.new("L", rgb.size, color[2]))
    return ImageChops.lighter(ImageChops.lighter(dr, dg), db)


def _lut(fn: Callable[[int], int]) -> list[int]:
    """Lookup table for ``Image.point`` built from ``fn``."""
    return [int(fn(v)) for v in range(256)]


def _score_lut(tolerance: int) -> list[int]:
    """Distances within ``tolerance`` are kept; anything else becomes 255 (no match)."""
    return _lut(lambda v: v if v <= tolerance else 255)


def _solid_colour(alpha: Image.Image, color: Rgb) -> Image.Image:
    """RGBA image of one colour whose alpha is ``alpha`` (an 'L' image of the same size)."""
    return Image.merge(
        "RGBA",
        (
            Image.new("L", alpha.size, color[0]),
            Image.new("L", alpha.size, color[1]),
            Image.new("L", alpha.size, color[2]),
            alpha,
        ),
    )


# -- colour detection -----------------------------------------------------------------------


def auto_ink_color(rgb: Image.Image) -> Rgb | None:
    """Dominant ink colour: the most common colour bin among coloured or dark pixels.

    Paper (bright, low chroma) is ignored. Returns None when no ink-like pixel exists."""
    thumb = flatten_on_white(rgb)
    thumb.thumbnail((THUMB, THUMB))
    bins: dict[tuple[int, int, int], list[int]] = {}
    raw = thumb.tobytes()
    for i in range(0, len(raw), 3):
        r, g, b = raw[i], raw[i + 1], raw[i + 2]
        chroma = max(r, g, b) - min(r, g, b)
        lum = (r * 299 + g * 587 + b * 114) // 1000
        if chroma < INK_CHROMA and lum > INK_DARK:
            continue
        key = (r >> 5, g >> 5, b >> 5)
        entry = bins.setdefault(key, [0, 0, 0, 0])
        entry[0] += 1
        entry[1] += r
        entry[2] += g
        entry[3] += b
    if not bins:
        return None
    count, sr, sg, sb = max(bins.values(), key=lambda e: e[0])
    return (sr // count, sg // count, sb // count)


# -- background removal (I20) ----------------------------------------------------------------


def paper_darkness(rgb: Image.Image) -> Image.Image:
    """How much darker each pixel is than the local paper level (0 = paper, larger = ink).

    The paper level is the local maximum of the luminance (ink is dark, so it never wins the
    maximum), estimated on a small copy and scaled back up. This follows uneven lighting."""
    lum = rgb.convert("L")
    w, h = lum.size
    scale = max(1, min(w, h) // PAPER_TARGET)
    small = lum.resize((max(1, round(w / scale)), max(1, round(h / scale))), Image.Resampling.BOX)
    paper = small.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.BoxBlur(2))
    paper_full = paper.resize((w, h), Image.Resampling.BILINEAR)
    return ImageChops.subtract(paper_full, lum)


def paper_alpha(rgb: Image.Image, sensitivity: int) -> Image.Image:
    """Alpha from the darkness against the paper level, with a soft ramp.

    Higher sensitivity lowers the thresholds, so fainter ink is kept (and more noise too)."""
    low = 10 + 0.3 * (100 - sensitivity)
    high = low + 25

    def ramp(v: int) -> int:
        if v <= low:
            return 0
        if v >= high:
            return 255
        return round((v - low) * 255 / (high - low))

    return paper_darkness(rgb).point(_lut(ramp))


def ink_color_alpha(rgb: Image.Image, color: Rgb, tolerance: int) -> Image.Image:
    return chebyshev(rgb, color).point(lambda v: 255 if v <= tolerance else 0)


def feather_alpha(alpha: Image.Image, px: float) -> Image.Image:
    """Soften the edge of an alpha mask over about ``px`` pixels."""
    if px <= 0:
        return alpha
    return alpha.filter(ImageFilter.GaussianBlur(px / 2))


def crop_to_content(rgba: Image.Image, padding: int) -> Image.Image:
    """Crop to the bounding box of the non-transparent pixels, then add ``padding`` transparent
    pixels on every side (exact, even at the image border)."""
    bbox = rgba.getchannel("A").getbbox()
    if bbox is None:
        return Image.new("RGBA", (1, 1), (0, 0, 0, 0))
    content = rgba.crop(bbox)
    out = Image.new(
        "RGBA", (content.width + 2 * padding, content.height + 2 * padding), (0, 0, 0, 0)
    )
    out.paste(content, (padding, padding))
    return out


@dataclass
class RemovalResult:
    image: Image.Image  # RGBA, cropped to the content with padding
    mode: str  # the mode that produced the result ("ink-color" or "paper-white")
    ink_color: Rgb | None
    ink_pixels: int  # pixels with alpha >= 128 before cropping
    warnings: list[str] = field(default_factory=list)

    @property
    def coverage(self) -> float:
        w, h = self.image.size
        return round(self.ink_pixels / (w * h), 6) if w * h else 0.0


def remove_background(
    img: Image.Image,
    *,
    mode: RemovalMode,
    ink_color: Rgb | None = None,
    tolerance: int = 60,
    sensitivity: int = 50,
    feather: float = 1.0,
    output_color: Rgb | None = None,
    padding: int = 4,
) -> RemovalResult:
    """Keep the ink, make the paper transparent.

    - ``ink-color``: keep pixels within ``tolerance`` of ``ink_color``; None means auto-detect.
    - ``paper-white``: keep pixels darker than the local paper level (see ``paper_darkness``).
    - ``auto``: paper-white, and ink-color when paper-white finds almost no ink.

    Ink pixels keep their colour unless ``output_color`` is given (then they all get that colour).
    """
    if mode not in ("ink-color", "paper-white", "auto"):
        raise ValueError(f"unknown mode: {mode}")
    rgb = flatten_on_white(img)
    warnings: list[str] = []
    used = mode
    if mode == "auto":
        alpha = paper_alpha(rgb, sensitivity)
        if (
            _count_255(alpha.point(lambda v: 255 if v >= 128 else 0))
            >= MIN_INK_RATIO * rgb.width * rgb.height
        ):
            used = "paper-white"
        else:
            used = "ink-color"
            warnings.append("Paper removal found little ink; the ink colour was used instead.")
    if used == "paper-white":
        alpha = paper_alpha(rgb, sensitivity)
        colour: Rgb | None = None
    else:
        colour = ink_color if ink_color is not None else auto_ink_color(rgb)
        if colour is None:
            alpha = Image.new("L", rgb.size, 0)
            warnings.append("No ink colour found; the result is empty.")
        else:
            alpha = ink_color_alpha(rgb, colour, tolerance)
    alpha = feather_alpha(alpha, feather)
    ink_pixels = _count_255(alpha.point(lambda v: 255 if v >= 128 else 0))
    colour_source = Image.new("RGB", rgb.size, output_color) if output_color else rgb
    rgba = Image.merge("RGBA", (*colour_source.split(), alpha))
    return RemovalResult(
        image=crop_to_content(rgba, padding),
        mode=used,
        ink_color=colour if used == "ink-color" else None,
        ink_pixels=ink_pixels,
        warnings=warnings,
    )


# -- cleanup (I21) --------------------------------------------------------------------------


def despeckle(mask: Image.Image, min_blob_px: int) -> tuple[Image.Image, int]:
    """Remove 8-connected ink blobs smaller than ``min_blob_px`` pixels.

    ``mask`` is a 0/255 image. Returns (keep mask 0/255, number of blobs removed)."""
    w, h = mask.size
    data = mask.point(lambda v: 255 if v >= 128 else 0).tobytes()
    keep = bytearray(b"\xff" * (w * h))
    seen = bytearray(w * h)
    removed = 0
    pos = data.find(b"\xff")
    while pos != -1:
        if seen[pos]:
            pos = data.find(b"\xff", pos + 1)
            continue
        component = [pos]
        seen[pos] = 1
        queue = deque([pos])
        while queue:
            i = queue.popleft()
            x, y = i % w, i // w
            for nx, ny in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if 0 <= nx < w and 0 <= ny < h:
                    j = ny * w + nx
                    if data[j] and not seen[j]:
                        seen[j] = 1
                        component.append(j)
                        queue.append(j)
        if len(component) < min_blob_px:
            removed += 1
            for i in component:
                keep[i] = 0
        pos = data.find(b"\xff", pos + 1)
    return Image.frombytes("L", (w, h), bytes(keep)), removed


def principal_angle(alpha: Image.Image) -> float | None:
    """Direction of the main axis of the ink, in degrees counter-clockwise from the horizontal
    (as seen on screen). None when the ink has no clear direction (round shapes, too little ink).
    """
    w, h = alpha.size
    scale = min(1.0, THUMB / max(w, h))
    small = alpha
    if scale < 1.0:
        small = alpha.resize(
            (max(1, round(w * scale)), max(1, round(h * scale))), Image.Resampling.BOX
        )
    sw, _ = small.size
    data = small.point(lambda v: 255 if v >= 64 else 0).tobytes()
    n = sxx = syy = sxy = sx = sy = 0
    pos = data.find(b"\xff")
    while pos != -1:
        x, y = pos % sw, pos // sw
        n += 1
        sx += x
        sy += y
        sxx += x * x
        syy += y * y
        sxy += x * y
        pos = data.find(b"\xff", pos + 1)
    if n < 20:
        return None
    mx, my = sx / n, sy / n
    cxx = sxx / n - mx * mx
    cyy = syy / n - my * my
    cxy = -(sxy / n - mx * my)  # flip y: image rows grow downwards, angles are measured up
    spread = math.sqrt(((cxx - cyy) / 2) ** 2 + cxy**2)
    lam_max = (cxx + cyy) / 2 + spread
    lam_min = (cxx + cyy) / 2 - spread
    if lam_min <= 1e-9 or math.sqrt(lam_max / lam_min) < 1.5:
        return None
    return math.degrees(0.5 * math.atan2(2 * cxy, cxx - cyy))


def deskew(img: Image.Image, max_tilt: float = 15.0) -> tuple[Image.Image, float, float | None]:
    """Turn the image so that the ink's main axis is horizontal.

    Only tilts up to ``max_tilt`` degrees are corrected. Returns (image, applied degrees,
    measured degrees). ``applied`` is 0 when nothing was turned."""
    rgba = to_rgba(img)
    measured = principal_angle(ink_mask(rgba))
    if measured is None or abs(measured) > max_tilt or abs(measured) < 0.3:
        return rgba, 0.0, measured
    turned = rgba.rotate(
        -measured,  # Pillow turns counter-clockwise for positive angles
        resample=Image.Resampling.BICUBIC,
        expand=True,
        fillcolor=(0, 0, 0, 0),
    )
    return turned, measured, measured


def grow_alpha(alpha: Image.Image, px: int) -> Image.Image:
    for _ in range(max(0, px)):
        alpha = alpha.filter(ImageFilter.MaxFilter(3))
    return alpha


def shrink_alpha(alpha: Image.Image, px: int) -> Image.Image:
    for _ in range(max(0, px)):
        alpha = alpha.filter(ImageFilter.MinFilter(3))
    return alpha


def adjust_tone(img: Image.Image, contrast: float = 1.0, brightness: int = 0) -> Image.Image:
    """Contrast around mid grey, then brightness. Alpha is kept."""
    rgba = to_rgba(img)
    if contrast == 1.0 and brightness == 0:
        return rgba

    def curve(v: int) -> int:
        return max(0, min(255, round((v - 128) * contrast + 128 + brightness)))

    r, g, b, a = rgba.split()
    lut = _lut(curve)
    return Image.merge("RGBA", (r.point(lut), g.point(lut), b.point(lut), a))


def fit_max(img: Image.Image, max_width: int | None, max_height: int | None) -> Image.Image:
    """Scale down (never up) so that the image fits inside max_width x max_height."""
    w, h = img.size
    scale = 1.0
    if max_width:
        scale = min(scale, max_width / w)
    if max_height:
        scale = min(scale, max_height / h)
    if scale >= 1.0:
        return img
    size = (max(1, round(w * scale)), max(1, round(h * scale)))
    return img.resize(size, Image.Resampling.LANCZOS)


def mirror(img: Image.Image) -> Image.Image:
    return ImageOps.mirror(img)


@dataclass
class CleanupResult:
    image: Image.Image
    removed_blobs: int
    applied_deg: float
    measured_deg: float | None
    warnings: list[str] = field(default_factory=list)


def cleanup(
    img: Image.Image,
    *,
    despeckle_px: int = 0,
    straighten: bool = False,
    max_tilt: float = 15.0,
    thicken: int = 0,
    contrast: float = 1.0,
    brightness: int = 0,
    max_width: int | None = None,
    max_height: int | None = None,
    flip_h: bool = False,
) -> CleanupResult:
    """Clean an image: straighten, remove specks, thicken (+) or thin (-) strokes, tone, resize.

    Thickening works on the alpha channel, so it needs a transparent image (run
    ``remove_background`` first). Specks are judged on the ink mask (see ``ink_mask``)."""
    warnings: list[str] = []
    rgba = to_rgba(img)
    applied = 0.0
    measured: float | None = None
    if straighten:
        rgba, applied, measured = deskew(rgba, max_tilt)
        if measured is None:
            warnings.append("The ink has no clear direction; it was not straightened.")
        elif applied == 0.0 and abs(measured) > max_tilt:
            warnings.append(f"The tilt ({measured:.1f} deg) is beyond the limit; not changed.")
    removed = 0
    if despeckle_px > 0:
        keep, removed = despeckle(ink_mask(rgba), despeckle_px)
        alpha = ImageChops.multiply(rgba.getchannel("A"), keep)
        rgba.putalpha(alpha)
    if thicken and not has_transparency(rgba):
        warnings.append("The image has no transparency; thickening had no effect.")
    alpha = rgba.getchannel("A")
    if thicken > 0:
        alpha = grow_alpha(alpha, thicken)
    elif thicken < 0:
        alpha = shrink_alpha(alpha, -thicken)
    rgba.putalpha(alpha)
    rgba = adjust_tone(rgba, contrast=contrast, brightness=brightness)
    rgba = fit_max(rgba, max_width, max_height)
    if flip_h:
        rgba = mirror(rgba)
    return CleanupResult(
        image=rgba,
        removed_blobs=removed,
        applied_deg=applied,
        measured_deg=measured,
        warnings=warnings,
    )


# -- colour separation (I22) ----------------------------------------------------------------


@dataclass(frozen=True)
class ColorLayer:
    name: str
    rgb: Rgb
    tolerance: int


@dataclass
class LayerResult:
    name: str
    image: Image.Image  # RGBA: original colours, alpha = pixels assigned to this layer
    pixels: int


def separate_layers(img: Image.Image, layers: Sequence[ColorLayer]) -> list[LayerResult]:
    """Split the image into one transparent layer per colour.

    A pixel belongs to the layer whose colour is nearest, provided it is within that layer's
    tolerance. Each pixel goes to at most one layer, so overlapping layers never share pixels
    (ties go to the earlier layer in the list)."""
    if not layers:
        raise ValueError("at least one layer is needed")
    rgb = flatten_on_white(img)
    size = rgb.size
    # Score per layer: distance if within tolerance, otherwise 255 (no match).
    scores = [chebyshev(rgb, layer.rgb).point(_score_lut(layer.tolerance)) for layer in layers]
    best = scores[0]
    for score in scores[1:]:
        best = ImageChops.darker(best, score)
    taken = Image.new("L", size, 0)
    results: list[LayerResult] = []
    for layer, score in zip(layers, scores, strict=True):
        is_best = ImageChops.difference(score, best).point(lambda v: 255 if v == 0 else 0)
        in_tolerance = score.point(lambda v: 255 if v < 255 else 0)
        mine = ImageChops.multiply(
            ImageChops.multiply(is_best, in_tolerance), ImageChops.invert(taken)
        )
        taken = ImageChops.lighter(taken, mine)
        results.append(
            LayerResult(
                name=layer.name,
                image=Image.merge("RGBA", (*rgb.split(), mine)),
                pixels=_count_255(mine),
            )
        )
    return results


# -- text signature (I19, I23: handwriting font slot) ----------------------------------------


def render_text(
    text: str,
    font_file: Path,
    *,
    size_px: int,
    color: Rgb,
    slant_deg: float = 0.0,
    padding: int = 4,
) -> Image.Image:
    """Typed text as a transparent RGBA image cropped to the glyphs (plus ``padding``).

    The text is NFC-normalised so that precomposed Vietnamese letters use the font's own glyphs.
    ``slant_deg`` leans the text to the right (positive) or left (negative)."""
    if not font_file.is_file():
        raise FileNotFoundError(str(font_file))
    line = unicodedata.normalize("NFC", text).strip()
    if not line:
        raise ValueError("text is empty")
    font = ImageFont.truetype(str(font_file), size_px)
    margin = size_px
    left, top, right, bottom = font.getbbox(line)
    width = int(right - left) + 2 * margin
    height = int(bottom - top) + 2 * margin
    mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask).text((margin - left, margin - top), line, font=font, fill=255)
    if slant_deg:
        k = math.tan(math.radians(slant_deg))
        mask = mask.transform(
            mask.size,
            Image.Transform.AFFINE,
            (1, k, -k * height / 2, 0, 1, 0),
            resample=Image.Resampling.BICUBIC,
        )
    bbox = mask.getbbox()
    if bbox is None:
        raise ValueError("the text produced no glyphs")
    alpha = mask.crop(bbox)
    out_alpha = Image.new("L", (alpha.width + 2 * padding, alpha.height + 2 * padding), 0)
    out_alpha.paste(alpha, (padding, padding))
    return _solid_colour(out_alpha, color)


# -- strokes (I19 pressure ink) --------------------------------------------------------------


def _catmull_rom(
    p0: StrokePoint, p1: StrokePoint, p2: StrokePoint, p3: StrokePoint, t: float
) -> tuple[float, float]:
    def axis(a: float, b: float, c: float, d: float) -> float:
        return 0.5 * (
            2 * b
            + (-a + c) * t
            + (2 * a - 5 * b + 4 * c - d) * t * t
            + (-a + 3 * b - 3 * c + d) * t * t * t
        )

    return axis(p0[0], p1[0], p2[0], p3[0]), axis(p0[1], p1[1], p2[1], p3[1])


def _stroke_samples(
    points: Sequence[StrokePoint], radius_of: Callable[[float], float]
) -> list[tuple[float, float, float]]:
    """Dense samples (x, y, radius) along a smooth curve through ``points`` (supersampled px)."""
    if len(points) == 1:
        x, y, p = points[0]
        return [(x, y, radius_of(p))]
    padded = [points[0], *points, points[-1]]
    samples: list[tuple[float, float, float]] = []
    for i in range(len(points) - 1):
        p0, p1, p2, p3 = padded[i], padded[i + 1], padded[i + 2], padded[i + 3]
        approx = math.dist(p1[:2], p2[:2])
        radius = radius_of((p1[2] + p2[2]) / 2)
        steps = max(1, math.ceil(approx / max(1.0, radius * 0.5)))
        for s in range(steps):
            t = s / steps
            x, y = _catmull_rom(p0, p1, p2, p3, t)
            pressure = p1[2] + (p2[2] - p1[2]) * t
            samples.append((x, y, radius_of(pressure)))
    last = points[-1]
    samples.append((last[0], last[1], radius_of(last[2])))
    return samples


def render_strokes(
    strokes: Sequence[Sequence[StrokePoint]],
    canvas_w: int,
    canvas_h: int,
    color: Rgb,
    *,
    min_width: float,
    max_width: float,
    padding: int,
) -> Image.Image:
    """Variable-width ink from pointer strokes.

    Coordinates are in canvas pixels: ``canvas_w`` x ``canvas_h`` is the frame the points refer
    to, and ink is never clipped to it. A round brush of width ``min_width`` (pressure 0) to
    ``max_width`` (pressure 1) is drawn along a Catmull-Rom curve through the points at 4x
    resolution, then averaged down. The drawing buffer covers only the ink, so a large canvas
    costs nothing. The result is cropped to the ink plus ``padding``."""
    del canvas_w, canvas_h  # the frame only documents the coordinates; the buffer is the ink's box
    usable = [list(s) for s in strokes if len(s) > 0]
    if not usable:
        raise ValueError("no strokes")
    if max_width < min_width:
        raise ValueError("max_width must not be smaller than min_width")
    s = STROKE_SCALE

    def radius_of(pressure: float) -> float:
        p = min(1.0, max(0.0, pressure))
        return (min_width + (max_width - min_width) * p) / 2 * s

    dabs: list[tuple[float, float, float]] = []
    for stroke in usable:
        scaled = [(x * s, y * s, min(1.0, max(0.0, p))) for x, y, p in stroke]
        dabs.extend(_stroke_samples(scaled, radius_of))
    left = math.floor(min(x - r for x, _, r in dabs)) - 1
    top = math.floor(min(y - r for _, y, r in dabs)) - 1
    width = math.ceil(max(x + r for x, _, r in dabs)) - left + 1
    height = math.ceil(max(y + r for _, y, r in dabs)) - top + 1
    width += -width % s  # whole supersampled blocks only
    height += -height % s
    mask = Image.new("L", (width, height), 0)
    draw = ImageDraw.Draw(mask)
    for x, y, r in dabs:
        cx, cy = x - left, y - top
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=255)
    small = mask.reduce(s)
    bbox = small.getbbox()
    if bbox is None:
        raise ValueError("the strokes produced no ink")
    alpha = small.crop(bbox)
    out_alpha = Image.new("L", (alpha.width + 2 * padding, alpha.height + 2 * padding), 0)
    out_alpha.paste(alpha, (padding, padding))
    return _solid_colour(out_alpha, color)
