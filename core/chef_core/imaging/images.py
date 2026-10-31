"""Turning image files into PDF pages.

img2pdf builds the image XObjects (JPEG / JPEG 2000 are embedded without re-encoding,
PNG and others losslessly). The page itself is laid out here so that EXIF orientation
(all 8 values, including mirrored ones) is applied with a transformation matrix instead of
re-encoding the pixels.
"""

from __future__ import annotations

import base64
import binascii
import io
import logging
import re
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import img2pdf
import pikepdf
from pikepdf import Array, Dictionary, Name
from PIL import Image, ImageOps, UnidentifiedImageError

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.pdf.pages import A4, LETTER

log = logging.getLogger(__name__)

PageSize = Literal["image", "a4", "letter"]
EXIF_ORIENTATION = 0x0112
_DATA_URL_RE = re.compile(r"^data:(?P<mime>[^;,]*)(?P<params>(?:;[^;,]*)*),(?P<data>.*)$", re.S)

Image.MAX_IMAGE_PIXELS = 300_000_000  # scans can be large; still guard decompression bombs


def decode_data_url(url: str) -> bytes:
    m = _DATA_URL_RE.match(url.strip())
    if not m:
        raise invalid_params("Invalid data URL")
    payload = m.group("data")
    if ";base64" in m.group("params").lower():
        try:
            return base64.b64decode(payload, validate=False)
        except (binascii.Error, ValueError) as exc:
            raise invalid_params("Invalid base64 in data URL") from exc
    return urllib.parse.unquote_to_bytes(payload)


def read_image_file(path: str) -> bytes:
    p = Path(path)
    if not p.is_file():
        raise ChefError(ErrorKind.FILE_NOT_FOUND, "Image file not found", {"path": path})
    return p.read_bytes()


@dataclass
class _Xobj:
    image: pikepdf.Object  # image XObject (in the source img2pdf document)
    width: float  # natural size in points (stored pixel orientation)
    height: float


def _orientation(data: bytes) -> int:
    try:
        with Image.open(io.BytesIO(data)) as im:
            value = im.getexif().get(EXIF_ORIENTATION, 1)
    except Exception:
        return 1
    return value if isinstance(value, int) and 1 <= value <= 8 else 1


def _flatten_to_png(data: bytes) -> bytes:
    """Fallback for images img2pdf refuses (alpha channel, exotic modes): RGB PNG on white.

    EXIF orientation is applied here already because the PNG carries no EXIF.
    """
    try:
        with Image.open(io.BytesIO(data)) as im:
            frames = []
            for index in range(getattr(im, "n_frames", 1)):
                im.seek(index)
                frame = ImageOps.exif_transpose(im.copy()) or im.copy()
                if frame.mode in ("RGBA", "LA", "PA") or (
                    frame.mode == "P" and "transparency" in frame.info
                ):
                    rgba = frame.convert("RGBA")
                    background = Image.new("RGB", rgba.size, (255, 255, 255))
                    background.paste(rgba, mask=rgba.getchannel("A"))
                    frame = background
                elif frame.mode not in ("RGB", "L", "1"):
                    frame = frame.convert("RGB")
                frames.append(frame)
            buf = io.BytesIO()
            if len(frames) == 1:
                frames[0].save(buf, format="PNG")
            else:
                frames[0].save(buf, format="TIFF", save_all=True, append_images=frames[1:])
            return buf.getvalue()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise invalid_params("Unsupported or damaged image") from exc


def _img2pdf_doc(data: bytes) -> tuple[bytes, bool]:
    """Return (pdf bytes, orientation_already_applied)."""
    try:
        return img2pdf.convert(data, rotation=img2pdf.Rotation.none), False
    except Exception as exc:
        log.info("img2pdf could not embed image directly (%s); converting", type(exc).__name__)
    flattened = _flatten_to_png(data)
    try:
        return img2pdf.convert(flattened, rotation=img2pdf.Rotation.none), True
    except Exception as exc:
        raise invalid_params("Unsupported or damaged image") from exc


def _matrix(
    orientation: int, x: float, y: float, w: float, h: float
) -> tuple[float, float, float, float, float, float]:
    """``cm`` matrix that draws the unit-square image into the box (x, y, w, h) so that it
    appears as EXIF ``orientation`` prescribes. ``w``/``h`` are the *displayed* size."""
    return {
        1: (w, 0, 0, h, x, y),
        2: (-w, 0, 0, h, x + w, y),
        3: (-w, 0, 0, -h, x + w, y + h),
        4: (w, 0, 0, -h, x, y + h),
        5: (0, -h, -w, 0, x + w, y + h),
        6: (0, -h, w, 0, x, y + h),
        7: (0, h, w, 0, x, y),
        8: (0, h, -w, 0, x + w, y),
    }[orientation]


def _page_box(
    page_size: PageSize, img_w: float, img_h: float, margin: float
) -> tuple[float, float, float, float, float, float]:
    """(page_w, page_h, x, y, w, h) for an image of displayed size img_w × img_h."""
    if page_size == "image":
        return img_w + 2 * margin, img_h + 2 * margin, margin, margin, img_w, img_h
    pw, ph = A4 if page_size == "a4" else LETTER
    if img_w > img_h:
        pw, ph = ph, pw  # landscape page for a landscape image
    avail_w, avail_h = pw - 2 * margin, ph - 2 * margin
    if avail_w <= 1 or avail_h <= 1:
        raise invalid_params("margin is too large for the page size", {"field": "margin"})
    scale = min(avail_w / img_w, avail_h / img_h)
    w, h = img_w * scale, img_h * scale
    return pw, ph, (pw - w) / 2, (ph - h) / 2, w, h


def image_pages(
    target: pikepdf.Pdf, data: bytes, page_size: PageSize, margin: float
) -> list[pikepdf.Page]:
    """Build (not insert) one page per image frame of ``data`` for ``target``."""
    orientation = _orientation(data)
    pdf_bytes, applied = _img2pdf_doc(data)
    if applied:
        orientation = 1
    pages: list[pikepdf.Page] = []
    with pikepdf.open(io.BytesIO(pdf_bytes)) as src:
        for src_page in src.pages:
            xobjects = src_page.resources.get("/XObject")
            if not isinstance(xobjects, pikepdf.Dictionary) or not xobjects.keys():
                continue
            image = xobjects[next(iter(xobjects.keys()))]
            box = [float(v) for v in src_page.mediabox]
            item = _Xobj(image=image, width=box[2] - box[0], height=box[3] - box[1])
            disp_w, disp_h = item.width, item.height
            if orientation >= 5:
                disp_w, disp_h = disp_h, disp_w
            pw, ph, x, y, w, h = _page_box(page_size, disp_w, disp_h, margin)
            a, b, c, d, e, f = _matrix(orientation, x, y, w, h)
            content = f"q {a:.4f} {b:.4f} {c:.4f} {d:.4f} {e:.4f} {f:.4f} cm /Im0 Do Q\n"
            copied = target.copy_foreign(item.image)
            page_dict = Dictionary(
                Type=Name.Page,
                MediaBox=Array([0, 0, round(pw, 4), round(ph, 4)]),
                Resources=Dictionary(XObject=Dictionary(Im0=copied)),
                Contents=target.make_stream(content.encode("ascii")),
            )
            pages.append(pikepdf.Page(target.make_indirect(page_dict)))
    if not pages:
        raise invalid_params("Image could not be converted")
    return pages
