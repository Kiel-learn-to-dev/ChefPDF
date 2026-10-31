"""Rendering PDF pages to bitmaps with PDFium (K1, K2) and encoding them as image PDFs (K3).

``rasterize_page`` is pure (no session, no document writes) so effects and previews can reuse it.
``encode_image_page`` builds a one-page PDF whose page size is ``pixels * 72 / dpi``; JPEG
bytes are embedded as they are (DCTDecode), 1-bit bitmaps as CCITT Group 4 (CCITTFaxDecode).
"""

from __future__ import annotations

import io
from pathlib import Path
from typing import Literal

import img2pdf
import pypdfium2 as pdfium
from PIL import Image

ColorMode = Literal["color", "gray", "bw"]

WHITE = (255, 255, 255, 255)


def rasterize_page(
    source: str | Path | pdfium.PdfDocument,
    page_index: int,
    dpi: int,
    color: ColorMode = "color",
    threshold: int = 128,
    dithering: bool = False,
) -> Image.Image:
    """Render one page at ``dpi`` and convert it to the requested color mode.

    ``source`` is a file path (opened and closed here) or an open ``PdfDocument`` (left open).
    The page is rendered as displayed (CropBox and /Rotate applied) on a white background.
    Result modes: ``color`` → RGB, ``gray`` → L, ``bw`` → 1-bit. For ``bw`` a pixel is white when
    its gray value is at least ``threshold``; with ``dithering`` the threshold becomes the
    midpoint of Floyd-Steinberg error diffusion instead.
    """
    if isinstance(source, pdfium.PdfDocument):
        rgb = _render_rgb(source, page_index, dpi)
    else:
        doc = pdfium.PdfDocument(str(source))
        try:
            rgb = _render_rgb(doc, page_index, dpi)
        finally:
            doc.close()
    return convert_mode(rgb, color, threshold, dithering)


def _render_rgb(doc: pdfium.PdfDocument, page_index: int, dpi: int) -> Image.Image:
    if not 0 <= page_index < len(doc):
        raise IndexError(f"page index {page_index} out of range")
    page = doc[page_index]
    try:
        bitmap = page.render(scale=dpi / 72, fill_color=WHITE, draw_annots=True)
        try:
            rgb: Image.Image = bitmap.to_pil().convert("RGB")
            return rgb
        finally:
            bitmap.close()
    finally:
        page.close()


def convert_mode(
    rgb: Image.Image, color: ColorMode, threshold: int = 128, dithering: bool = False
) -> Image.Image:
    """Convert an RGB bitmap to ``color``, ``gray`` or 1-bit (``bw``)."""
    if color == "color":
        return rgb
    gray = rgb.convert("L")
    if color == "gray":
        return gray
    if dithering:
        # Error diffusion thresholds at 128: shift the levels so that ``threshold`` maps there.
        shifted = gray.point(lambda v: min(255, max(0, v - threshold + 128)))
        return shifted.convert("1", dither=Image.Dither.FLOYDSTEINBERG)
    binary = gray.point(lambda v: 255 if v >= threshold else 0)
    return binary.convert("1", dither=Image.Dither.NONE)


def encode_image_page(img: Image.Image, dpi: int, color: ColorMode, jpeg_quality: int) -> bytes:
    """Return a one-page PDF showing ``img`` at ``dpi`` (page size = pixels * 72 / dpi)."""
    buf = io.BytesIO()
    if color == "bw":
        img.save(buf, format="TIFF", compression="group4", dpi=(dpi, dpi))
    else:
        img.save(buf, format="JPEG", quality=jpeg_quality, dpi=(dpi, dpi))
    layout = img2pdf.get_fixed_dpi_layout_fun((dpi, dpi))
    return bytes(img2pdf.convert(buf.getvalue(), layout_fun=layout))
