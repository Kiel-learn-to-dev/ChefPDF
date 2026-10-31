"""Signature and stamp image operations (T3.11, features I19-I22).

All ops here are standalone: they read PNG/JPEG files and write PNG files, and never touch a
PDF session. The image maths lives in ``chef_core.imaging.sigimg``.

- ``image.removeBackground`` (I20): keep the ink, make the paper transparent, crop.
- ``image.cleanup`` (I21): straighten, despeckle, thicken or thin, tone, resize, mirror.
- ``image.separateColors`` (I22): split a stamp + signature image into one layer per colour.
- ``image.textSignature`` (I19): typed text with a bundled or user-chosen TrueType font.
  A handwriting font is a resource drop for later (the owner chooses an OFL font); the bundled
  set is currently Be Vietnam Pro only.
- ``image.fromStrokes`` (I19): pressure-sensitive ink from pointer strokes.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Annotated, Literal, Self

from PIL import Image, ImageOps, UnidentifiedImageError
from pydantic import Field, model_validator

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.imaging import sigimg
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation

HexColor = Annotated[str, Field(pattern=r"^#[0-9A-Fa-f]{6}$")]
MAX_INPUT_PIXELS = 100_000_000  # refuse larger images before decoding them
FONT_FAMILIES = Literal["BeVietnamPro"]


# -- shared helpers ------------------------------------------------------------------------


def open_image(path: str) -> Image.Image:
    """Decode an image file (EXIF orientation applied), mapping failures to ChefError."""
    p = Path(path)
    if not p.is_file():
        raise ChefError(ErrorKind.FILE_NOT_FOUND, "Image file not found", {"path": path})
    try:
        with Image.open(p) as src:
            if src.width * src.height > MAX_INPUT_PIXELS:
                raise invalid_params("Image is too large", {"field": "inputPath"})
            img = ImageOps.exif_transpose(src)
            img.load()
    except ChefError:
        raise
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise invalid_params("Unsupported or damaged image", {"field": "inputPath"}) from exc
    return img


def save_png(img: Image.Image, path: str) -> str:
    out = Path(path).expanduser().absolute()
    if not out.parent.is_dir():
        raise ChefError(
            ErrorKind.FILE_NOT_FOUND, "Output directory does not exist", {"path": str(out.parent)}
        )
    img.save(out, format="PNG")
    return str(out)


def _rgb(color: str) -> sigimg.Rgb:
    return sigimg.parse_hex(color)


# -- image.removeBackground (I20) ----------------------------------------------------------


class RemoveBackgroundParams(WireModel):
    """Keep the ink and make the paper transparent (I20)."""

    input_path: str = Field(min_length=1, description="PNG or JPEG to process.")
    output_path: str = Field(min_length=1, description="PNG (RGBA) to write.")
    mode: Literal["ink-color", "paper-white", "auto"] = Field(
        default="auto",
        description="ink-color: keep pixels near the ink colour. paper-white: keep pixels darker "
        "than the local paper level. auto: paper-white, then ink-color when that finds little ink.",
    )
    ink_color: str = Field(
        default="auto",
        pattern=r"^(auto|#[0-9A-Fa-f]{6})$",
        description="Ink colour as #RRGGBB, or 'auto' for the dominant non-paper colour.",
    )
    tolerance: int = Field(default=60, ge=0, le=255, description="Colour distance for ink-color.")
    sensitivity: int = Field(
        default=50, ge=0, le=100, description="paper-white: higher keeps fainter ink."
    )
    feather: float = Field(default=1.0, ge=0, le=3, description="Soft edge width in pixels.")
    output_color: HexColor | None = Field(
        default=None, description="Recolour all ink to this colour (default: keep the colour)."
    )
    padding: int = Field(default=4, ge=0, le=200, description="Transparent margin in pixels.")


@operation(
    id="image.removeBackground",
    title="Remove background",
    group="image",
    params=RemoveBackgroundParams,
    standalone=True,
)
def remove_background_op(ctx: OpContext, p: RemoveBackgroundParams) -> OpOutput:
    img = open_image(p.input_path)
    ctx.check_cancelled()
    result = sigimg.remove_background(
        img,
        mode=p.mode,
        ink_color=None if p.ink_color == "auto" else _rgb(p.ink_color),
        tolerance=p.tolerance,
        sensitivity=p.sensitivity,
        feather=p.feather,
        output_color=_rgb(p.output_color) if p.output_color else None,
        padding=p.padding,
    )
    for message in result.warnings:
        ctx.warn(message)
    out = save_png(result.image, p.output_path)
    return OpOutput(
        changed_pages=[],
        outputs=[out],
        data={
            "mode": result.mode,
            "inkColor": sigimg.hex_of(result.ink_color) if result.ink_color else None,
            "inkPixels": result.ink_pixels,
            "coverage": result.coverage,
            "width": result.image.width,
            "height": result.image.height,
        },
    )


# -- image.cleanup (I21) ------------------------------------------------------------------


class CleanupParams(WireModel):
    """Clean up a signature or stamp image (I21). All steps are optional."""

    input_path: str = Field(min_length=1)
    output_path: str = Field(min_length=1)
    min_blob_px: int = Field(
        default=0, ge=0, le=500, description="Remove ink blobs smaller than this (0 = off)."
    )
    straighten: bool = Field(default=False, description="Turn the ink's main axis horizontal.")
    max_tilt: float = Field(
        default=15.0, gt=0, le=15, description="Tilts beyond this are not corrected (degrees)."
    )
    thicken: int = Field(
        default=0, ge=-5, le=5, description="Grow (+) or thin (-) the strokes by N pixels."
    )
    contrast: float = Field(default=1.0, ge=0.2, le=3.0)
    brightness: int = Field(default=0, ge=-100, le=100)
    max_width: int | None = Field(default=None, ge=1, le=20000)
    max_height: int | None = Field(default=None, ge=1, le=20000)
    flip_h: bool = Field(default=False, description="Mirror horizontally.")


@operation(
    id="image.cleanup",
    title="Clean up signature image",
    group="image",
    params=CleanupParams,
    standalone=True,
)
def cleanup_op(ctx: OpContext, p: CleanupParams) -> OpOutput:
    img = open_image(p.input_path)
    ctx.check_cancelled()
    result = sigimg.cleanup(
        img,
        despeckle_px=p.min_blob_px,
        straighten=p.straighten,
        max_tilt=p.max_tilt,
        thicken=p.thicken,
        contrast=p.contrast,
        brightness=p.brightness,
        max_width=p.max_width,
        max_height=p.max_height,
        flip_h=p.flip_h,
    )
    for message in result.warnings:
        ctx.warn(message)
    out = save_png(result.image, p.output_path)
    return OpOutput(
        changed_pages=[],
        outputs=[out],
        data={
            "removedBlobs": result.removed_blobs,
            "appliedDeg": round(result.applied_deg, 2),
            "measuredDeg": None if result.measured_deg is None else round(result.measured_deg, 2),
            "width": result.image.width,
            "height": result.image.height,
        },
    )


# -- image.separateColors (I22) -----------------------------------------------------------


class SeparationLayer(WireModel):
    name: str = Field(min_length=1, max_length=60, description='E.g. "Con dấu", "Chữ ký".')
    color_hex: HexColor = Field(description="Reference colour of the layer.")
    tolerance: int = Field(default=60, ge=0, le=255)


class SeparateColorsParams(WireModel):
    """Split an image into one transparent PNG per colour (I22).

    mode "layers": the colours are given in ``layers``. mode "auto-two": the two dominant ink
    colours are found by themselves (a red seal and a blue signature come out as two layers,
    named "Con dấu" and "Chữ ký" when the colours say so)."""

    input_path: str = Field(min_length=1)
    output_dir: str = Field(min_length=1, description="Existing folder for the layer files.")
    mode: Literal["layers", "auto-two"] = Field(default="layers")
    layers: list[SeparationLayer] | None = Field(
        default=None, min_length=1, max_length=8, description="Needed in mode layers."
    )

    @model_validator(mode="after")
    def _layers_for_mode(self) -> SeparateColorsParams:
        if self.mode == "layers" and not self.layers:
            raise ValueError("mode layers needs at least one entry in layers")
        if self.mode == "auto-two" and self.layers is not None:
            raise ValueError("mode auto-two finds the colours itself; do not give layers")
        return self


def _layer_file_name(index: int, name: str) -> str:
    slug = re.sub(r"[^\w\-]+", "_", name, flags=re.UNICODE).strip("_") or "layer"
    return f"{index + 1:02d}-{slug}.png"


def _auto_layers(img: Image.Image) -> list[sigimg.ColorLayer]:
    colours = sigimg.auto_two_colors(img)
    if colours is None:
        raise invalid_params("No two different ink colours were found", {"field": "mode"})
    named: list[sigimg.ColorLayer] = []
    for index, colour in enumerate(colours):
        r, g, b = colour
        if r > max(g, b) + 40:
            name = "Con dấu"
        elif b > max(r, g) + 40:
            name = "Chữ ký"
        else:
            name = f"Lớp {index + 1}"
        named.append(sigimg.ColorLayer(name=name, rgb=colour, tolerance=60))
    return named


@operation(
    id="image.separateColors",
    title="Separate colours into layers",
    group="image",
    params=SeparateColorsParams,
    standalone=True,
)
def separate_colors_op(ctx: OpContext, p: SeparateColorsParams) -> OpOutput:
    img = open_image(p.input_path)
    out_dir = Path(p.output_dir).expanduser().absolute()
    if not out_dir.is_dir():
        raise ChefError(
            ErrorKind.FILE_NOT_FOUND, "Output folder does not exist", {"path": str(out_dir)}
        )
    ctx.check_cancelled()
    if p.mode == "auto-two":
        layers = _auto_layers(img)
    else:
        layers = [
            sigimg.ColorLayer(name=layer.name, rgb=_rgb(layer.color_hex), tolerance=layer.tolerance)
            for layer in p.layers or []
        ]
    results = sigimg.separate_layers(img, layers)
    outputs: list[str] = []
    rows: list[dict[str, object]] = []
    for index, result in enumerate(results):
        path = out_dir / _layer_file_name(index, result.name)
        save_png(result.image, str(path))
        outputs.append(str(path))
        rows.append({"name": result.name, "path": str(path), "pixels": result.pixels})
        if result.pixels == 0:
            ctx.warn(f"No pixel matched the layer '{result.name}'.")
    return OpOutput(changed_pages=[], outputs=outputs, data={"layers": rows})


# -- image.textSignature (I19) ------------------------------------------------------------


class TextSignatureParams(WireModel):
    """Typed text rendered as a transparent signature image (I19)."""

    text: str = Field(min_length=1, max_length=200)
    font_name: FONT_FAMILIES | None = Field(
        default="BeVietnamPro", description="A bundled font. Ignored when fontPath is given."
    )
    font_path: str | None = Field(
        default=None, min_length=1, description="A TrueType/OpenType file of your choice."
    )
    size_px: int = Field(default=96, ge=16, le=400)
    color_hex: HexColor = "#1F3A93"
    slant_deg: float = Field(
        default=0.0, ge=-30, le=30, description="Positive leans right, like italics."
    )
    padding: int = Field(default=6, ge=0, le=100)
    output_path: str = Field(min_length=1)


@operation(
    id="image.textSignature",
    title="Typed text signature",
    group="image",
    params=TextSignatureParams,
    standalone=True,
)
def text_signature_op(ctx: OpContext, p: TextSignatureParams) -> OpOutput:
    if p.font_path:
        font_file = Path(p.font_path).expanduser()
    elif p.font_name:
        font_file = sigimg.bundled_font_path(p.font_name)
    else:
        raise invalid_params("Choose a font: fontName or fontPath", {"field": "fontName"})
    if not font_file.is_file():
        raise ChefError(ErrorKind.FILE_NOT_FOUND, "Font file not found", {"path": str(font_file)})
    try:
        img = sigimg.render_text(
            p.text,
            font_file,
            size_px=p.size_px,
            color=_rgb(p.color_hex),
            slant_deg=p.slant_deg,
            padding=p.padding,
        )
    except ValueError as exc:
        raise invalid_params(str(exc), {"field": "text"}) from exc
    except OSError as exc:
        raise invalid_params("The font file could not be read", {"field": "fontPath"}) from exc
    out = save_png(img, p.output_path)
    return OpOutput(
        changed_pages=[],
        outputs=[out],
        data={"width": img.width, "height": img.height},
    )


# -- image.fromStrokes (I19) --------------------------------------------------------------


class StrokePointParams(WireModel):
    x: float
    y: float
    pressure: float = Field(default=1.0, ge=0, le=1, description="0 = lightest, 1 = heaviest.")
    t: float | None = Field(default=None, description="Time stamp; not used for the drawing.")


class StrokeParams(WireModel):
    points: list[StrokePointParams] = Field(min_length=1, max_length=20000)


class StrokesParams(WireModel):
    """Pointer strokes drawn as smooth variable-width ink (I19)."""

    strokes: list[StrokeParams] = Field(min_length=1, max_length=500)
    canvas_width: int = Field(ge=1, le=10000, description="Canvas size the points refer to.")
    canvas_height: int = Field(ge=1, le=10000)
    color_hex: HexColor = "#1F3A93"
    min_width: float = Field(default=1.5, gt=0, le=50, description="Width at pressure 0, px.")
    max_width: float = Field(default=6.0, gt=0, le=100, description="Width at pressure 1, px.")
    padding: int = Field(default=8, ge=0, le=100)
    output_path: str = Field(min_length=1)

    @model_validator(mode="after")
    def _widths_ordered(self) -> Self:
        if self.max_width < self.min_width:
            raise ValueError("maxWidth must not be smaller than minWidth")
        return self


@operation(
    id="image.fromStrokes",
    title="Ink from strokes",
    group="image",
    params=StrokesParams,
    standalone=True,
)
def strokes_op(ctx: OpContext, p: StrokesParams) -> OpOutput:
    strokes = [[(pt.x, pt.y, pt.pressure) for pt in stroke.points] for stroke in p.strokes]
    try:
        img = sigimg.render_strokes(
            strokes,
            p.canvas_width,
            p.canvas_height,
            _rgb(p.color_hex),
            min_width=p.min_width,
            max_width=p.max_width,
            padding=p.padding,
        )
    except ValueError as exc:
        raise invalid_params(str(exc), {"field": "strokes"}) from exc
    out = save_png(img, p.output_path)
    return OpOutput(
        changed_pages=[], outputs=[out], data={"width": img.width, "height": img.height}
    )
