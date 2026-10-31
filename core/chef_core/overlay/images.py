"""Image decoding for overlays (T4.02, D2): PNG, JPEG and other Pillow formats.

JPEG files are embedded unchanged (DCTDecode) when they need no transformation. Everything else
is decoded to raw 8-bit samples, with transparency split into a soft mask (SMask).
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from typing import Literal

from PIL import Image, ImageOps, UnidentifiedImageError

from chef_core.errors import ChefError, ErrorKind

MAX_PIXELS = 50_000_000  # the same bound as the scan rasterizer
EXIF_ORIENTATION = 0x0112
PX_TO_PT = 72.0 / 96.0  # natural size of an image: 96 dpi pixels


@dataclass(frozen=True)
class DecodedImage:
    width: int
    height: int
    color_space: Literal["DeviceRGB", "DeviceGray"]
    data: bytes  # raw samples, or the JPEG file when ``dct`` is True
    dct: bool
    alpha: bytes | None  # one byte per pixel when the image has transparency


def decode_image(raw: bytes) -> DecodedImage:
    try:
        with Image.open(io.BytesIO(raw)) as opened:
            opened.load()
            fmt = opened.format
            orientation = opened.getexif().get(EXIF_ORIENTATION, 1)
            rotated = orientation not in (1, None)
            transposed = ImageOps.exif_transpose(opened) if rotated else None
            image: Image.Image = transposed if transposed is not None else opened
            width, height = image.size
            if width * height > MAX_PIXELS:
                raise ChefError(ErrorKind.INVALID_PARAMS, "Image is too large")
            if fmt == "JPEG" and not rotated and image.mode in ("RGB", "L"):
                space: Literal["DeviceRGB", "DeviceGray"]
                space = "DeviceRGB" if image.mode == "RGB" else "DeviceGray"
                return DecodedImage(width, height, space, raw, dct=True, alpha=None)
            if _has_transparency(image):
                rgba = image.convert("RGBA")
                return DecodedImage(
                    width,
                    height,
                    "DeviceRGB",
                    rgba.convert("RGB").tobytes(),
                    dct=False,
                    alpha=rgba.getchannel("A").tobytes(),
                )
            if image.mode in ("L", "1"):
                gray = image.convert("L")
                return DecodedImage(width, height, "DeviceGray", gray.tobytes(), False, None)
            rgb = image.convert("RGB")
            return DecodedImage(width, height, "DeviceRGB", rgb.tobytes(), False, None)
    except ChefError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
        raise ChefError(ErrorKind.INVALID_PARAMS, f"Not a supported image: {exc}") from exc


def _has_transparency(image: Image.Image) -> bool:
    if image.mode in ("RGBA", "LA", "PA"):
        return True
    return "transparency" in image.info


def natural_size_pt(image: DecodedImage) -> tuple[float, float]:
    return image.width * PX_TO_PT, image.height * PX_TO_PT
