"""Rendering PDF pages to bitmaps with PDFium (K1, K2) and encoding them as image PDFs (K3).

``rasterize_page`` is pure (no session, no document writes) so effects and previews can reuse it.
``encode_image_page`` builds a one-page PDF whose page size is ``pixels * 72 / dpi``; JPEG
bytes are embedded as they are (DCTDecode), 1-bit bitmaps as CCITT Group 4 (CCITTFaxDecode).
"""

from __future__ import annotations

import io
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Literal

import img2pdf
import pypdfium2 as pdfium
from PIL import Image, TiffImagePlugin

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


def image_suffix(color: ColorMode) -> str:
    """File suffix of the encoded page image: TIFF (CCITT G4) for bw, JPEG otherwise."""
    return ".tif" if color == "bw" else ".jpg"


def encode_image_bytes(img: Image.Image, dpi: int, color: ColorMode, jpeg_quality: int) -> bytes:
    """The encoded page image (JPEG or TIFF G4 bytes) carrying the ``dpi`` tag.

    A TIFF G4 is written as one strip (``strip_size`` above the bitmap size): the PDF writer
    copies the CCITT payload straight from the strip.
    """
    buf = io.BytesIO()
    if color == "bw":
        strip = max(65536, img.width * img.height)
        img.save(buf, format="TIFF", compression="group4", dpi=(dpi, dpi), strip_size=strip)
    else:
        img.save(buf, format="JPEG", quality=jpeg_quality, dpi=(dpi, dpi))
    return buf.getvalue()


def encode_image_page(img: Image.Image, dpi: int, color: ColorMode, jpeg_quality: int) -> bytes:
    """Return a one-page PDF showing ``img`` at ``dpi`` (page size = pixels * 72 / dpi)."""
    data = encode_image_bytes(img, dpi, color, jpeg_quality)
    layout = img2pdf.get_fixed_dpi_layout_fun((dpi, dpi))
    return bytes(img2pdf.convert(data, layout_fun=layout))


@dataclass(frozen=True)
class _ImagePayload:
    """Where an encoded page image sits in its file, and the dictionary entries that describe it."""

    path: Path
    offset: int
    length: int
    width: int
    height: int
    entries: str  # image XObject entries besides the size and length


def _payload(path: Path) -> _ImagePayload:
    with Image.open(path) as img:
        width, height = img.size
        if isinstance(img, TiffImagePlugin.TiffImageFile):
            tags = img.tag_v2
            offsets, counts = tags.get(273), tags.get(279)  # StripOffsets, StripByteCounts
            if offsets is None or counts is None or len(offsets) != 1:
                raise ValueError(f"{path.name}: TIFF G4 must be a single strip")
            photometric = int(tags.get(262, 1))  # 0 = WhiteIsZero, 1 = BlackIsZero
            if photometric not in (0, 1):
                raise ValueError(f"unsupported TIFF photometric interpretation: {photometric}")
            black_is_1 = "true" if photometric == 1 else "false"
            entries = (
                "/Filter /CCITTFaxDecode /ColorSpace /DeviceGray /BitsPerComponent 1 "
                f"/DecodeParms << /K -1 /Columns {width} /Rows {height} /BlackIs1 {black_is_1} >>"
            )
            return _ImagePayload(path, int(offsets[0]), int(counts[0]), width, height, entries)
        if img.format == "JPEG":
            space = {"L": "/DeviceGray", "RGB": "/DeviceRGB"}.get(img.mode)
            if space is None:
                raise ValueError(f"unsupported JPEG mode: {img.mode}")
            entries = f"/Filter /DCTDecode /ColorSpace {space} /BitsPerComponent 8"
            return _ImagePayload(path, 0, path.stat().st_size, width, height, entries)
    raise ValueError(f"{path.name}: not a JPEG or TIFF page image")


def _copy_payload(out: BinaryIO, payload: _ImagePayload) -> None:
    """Copy the payload bytes in blocks, so a page never sits in memory as a whole."""
    remaining = payload.length
    with payload.path.open("rb") as src:
        src.seek(payload.offset)
        while remaining > 0:
            block = src.read(min(1 << 20, remaining))
            if not block:
                raise OSError(f"{payload.path.name}: image data ends early")
            out.write(block)
            remaining -= len(block)


def assemble_image_pdf(images: Sequence[Path], dpi: int, dest: Path) -> None:
    """Write one page per encoded image file (in order) straight to ``dest``.

    The PDF is written object by object and the image data is copied from the files in blocks,
    so the memory used does not grow with the number of pages. Each page is sized from its
    pixels at ``dpi`` (pixels * 72 / dpi), as ``encode_image_page`` does. Output is deterministic.
    """
    payloads = [_payload(path) for path in images]
    count = len(payloads)
    if count == 0:
        raise ValueError("no page images to assemble")
    # Object numbers: 1 catalog, 2 page tree, then page, content and image for each page.
    kids = " ".join(f"{3 + 3 * i} 0 R" for i in range(count))
    offsets: dict[int, int] = {}
    with dest.open("wb") as out:
        out.write(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")

        def begin(num: int) -> None:
            offsets[num] = out.tell()
            out.write(f"{num} 0 obj\n".encode("ascii"))

        begin(1)
        out.write(b"<< /Type /Catalog /Pages 2 0 R >>\nendobj\n")
        for i, payload in enumerate(payloads):
            page_id, content_id, image_id = 3 + 3 * i, 4 + 3 * i, 5 + 3 * i
            width = f"{payload.width * 72 / dpi:.4f}"
            height = f"{payload.height * 72 / dpi:.4f}"
            begin(page_id)
            page = (
                "<< /Type /Page /Parent 2 0 R "
                f"/MediaBox [0 0 {width} {height}] "
                f"/Resources << /XObject << /Im0 {image_id} 0 R >> >> "
                f"/Contents {content_id} 0 R >>\nendobj\n"
            )
            out.write(page.encode("ascii"))
            content = f"q {width} 0 0 {height} 0 0 cm /Im0 Do Q\n".encode("ascii")
            begin(content_id)
            out.write(f"<< /Length {len(content)} >>\nstream\n".encode("ascii"))
            out.write(content)
            out.write(b"endstream\nendobj\n")
            begin(image_id)
            head = (
                f"<< /Type /XObject /Subtype /Image /Width {payload.width} "
                f"/Height {payload.height} {payload.entries} /Length {payload.length} >>\n"
                "stream\n"
            )
            out.write(head.encode("ascii"))
            _copy_payload(out, payload)
            out.write(b"\nendstream\nendobj\n")
        begin(2)
        out.write(f"<< /Type /Pages /Kids [{kids}] /Count {count} >>\nendobj\n".encode("ascii"))

        xref_at = out.tell()
        size = 3 + 3 * count
        out.write(f"xref\n0 {size}\n".encode("ascii"))
        out.write(b"0000000000 65535 f \n")
        for num in range(1, size):
            out.write(f"{offsets[num]:010d} 00000 n \n".encode("ascii"))
        trailer = f"trailer\n<< /Size {size} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n"
        out.write(trailer.encode("ascii"))
