"""Builders and measurements for the media operations (compress, convert, colour, page edit).

Pages are built from raw image XObjects so that every codec and colour space can be made on
purpose (JPEG, Flate, CMYK JPEG, soft masks, 1-bit bitmaps, shared images). ``render`` and
``page_text`` read the result back through PDFium, the same engine the viewer uses.
"""

from __future__ import annotations

import io
import random
import zlib
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
from pikepdf import Array, Dictionary, Name
from PIL import Image, ImageChops, ImageStat

PAGE_W, PAGE_H = 612.0, 792.0


def noisy_rgb(width: int, height: int, seed: int = 1) -> Image.Image:
    """Incompressible colour noise: JPEG at any quality is large."""
    data = random.Random(seed).randbytes(width * height * 3)
    return Image.frombytes("RGB", (width, height), data)


def smooth_rgb(width: int, height: int) -> Image.Image:
    """A smooth colour gradient (compresses well, so resampling it is visually harmless)."""
    vertical = Image.linear_gradient("L").resize((width, height))
    horizontal = vertical.transpose(Image.Transpose.ROTATE_90).resize((width, height))
    blue = Image.new("L", (width, height), 128)
    return Image.merge("RGB", (horizontal, vertical, blue))


def photo_like(width: int, height: int, seed: int = 1) -> Image.Image:
    """A gradient with moderate grain: large as JPEG, and resampling it keeps the look."""
    base = smooth_rgb(width, height)
    noise = Image.frombytes(
        "RGB", (width, height), random.Random(seed).randbytes(width * height * 3)
    )
    grain = noise.point(lambda v: v * 40 // 256)
    return ImageChops.add(base, grain, scale=1.0, offset=-20)


@dataclass
class Placement:
    name: str
    image: pikepdf.Object
    x: float
    y: float
    w: float
    h: float


def new_pdf(pages: int = 1, width: float = PAGE_W, height: float = PAGE_H) -> pikepdf.Pdf:
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=(width, height))
    return pdf


def _stream(pdf: pikepdf.Pdf, data: bytes, filt: Name | None) -> pikepdf.Stream:
    stream = pdf.make_stream(b"")
    if filt is None:
        stream.write(data)
    else:
        stream.write(data, filter=filt)
    return stream


def image_xobject(
    pdf: pikepdf.Pdf,
    img: Image.Image,
    *,
    codec: str = "dct",
    quality: int = 92,
    alpha: Image.Image | None = None,
    colour_space: Name | None = None,
) -> pikepdf.Stream:
    """An image XObject: ``codec`` is ``dct`` (JPEG) or ``flate``; ``alpha`` becomes /SMask."""
    mode_space = {"L": Name.DeviceGray, "RGB": Name.DeviceRGB, "CMYK": Name.DeviceCMYK}
    if codec == "dct":
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=quality)
        stream = _stream(pdf, buf.getvalue(), Name.DCTDecode)
    else:
        stream = _stream(pdf, zlib.compress(img.tobytes(), 9), Name.FlateDecode)
    stream.Type = Name.XObject
    stream.Subtype = Name.Image
    stream.Width, stream.Height = img.size
    stream.BitsPerComponent = 8
    stream.ColorSpace = colour_space or mode_space[img.mode]
    if alpha is not None:
        mask = _stream(pdf, zlib.compress(alpha.convert("L").tobytes(), 9), Name.FlateDecode)
        mask.Type = Name.XObject
        mask.Subtype = Name.Image
        mask.Width, mask.Height = img.size
        mask.BitsPerComponent = 8
        mask.ColorSpace = Name.DeviceGray
        stream.SMask = mask
    return stream


def bilevel_xobject(pdf: pikepdf.Pdf, size: tuple[int, int]) -> pikepdf.Stream:
    """A 1-bit Flate bitmap with a text-like pattern (line art: must be kept untouched)."""
    width, height = size
    row_bytes = (width + 7) // 8
    rows = bytearray()
    for y in range(height):
        row = bytearray(row_bytes)
        for x in range(width):
            if (x // 6 + y // 6) % 2 == 0 and y % 9 < 4:
                row[x // 8] |= 0x80 >> (x % 8)
        rows += row
    stream = _stream(pdf, zlib.compress(bytes(rows), 9), Name.FlateDecode)
    stream.Type = Name.XObject
    stream.Subtype = Name.Image
    stream.Width, stream.Height = width, height
    stream.BitsPerComponent = 1
    stream.ColorSpace = Name.DeviceGray
    return stream


def place(
    pdf: pikepdf.Pdf,
    page: pikepdf.Page,
    images: Sequence[tuple[str, pikepdf.Object, float, float, float, float]],
    text: str | None = None,
) -> None:
    """Draw images (name, object, x, y, w, h in points) and optional text on ``page``."""
    xobjects = Dictionary()
    parts: list[str] = []
    for name, obj, x, y, w, h in images:
        xobjects[f"/{name}"] = obj
        parts.append(f"q {w} 0 0 {h} {x} {y} cm /{name} Do Q")
    font = Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
    resources = Dictionary(XObject=xobjects, Font=Dictionary(F1=font))
    if text is not None:
        parts.append(f"BT /F1 30 Tf 40 40 Td ({text}) Tj ET")
    page.obj.Resources = resources
    page.obj.Contents = pdf.make_stream("\n".join(parts).encode("latin-1"))


def save(pdf: pikepdf.Pdf, path: Path) -> Path:
    pdf.save(path)
    pdf.close()
    return path


def render(path: Path | str, index: int = 0, dpi: int = 72) -> Image.Image:
    doc = pdfium.PdfDocument(str(path))
    try:
        page = doc[index]
        try:
            return (
                page.render(scale=dpi / 72, fill_color=(255, 255, 255, 255)).to_pil().convert("RGB")
            )
        finally:
            page.close()
    finally:
        doc.close()


def page_text(path: Path | str, index: int = 0) -> str:
    doc = pdfium.PdfDocument(str(path))
    try:
        page = doc[index]
        try:
            textpage = page.get_textpage()
            try:
                return str(textpage.get_text_range())
            finally:
                textpage.close()
        finally:
            page.close()
    finally:
        doc.close()


def mean_abs_diff(a: Image.Image, b: Image.Image) -> float:
    """Mean absolute difference per channel (0..255) of two renders of the same size."""
    if a.size != b.size:
        b = b.resize(a.size, Image.Resampling.LANCZOS)
    diff = ImageChops.difference(a.convert("RGB"), b.convert("RGB"))
    return float(sum(ImageStat.Stat(diff).mean) / 3)


def image_dims(path: Path | str, index: int = 0) -> list[tuple[int, int]]:
    """(width, height) of every image XObject the page lists in its resources."""
    with pikepdf.open(path) as pdf:
        res = pdf.pages[index].obj.get("/Resources")
        xobjects = res.get("/XObject") if res is not None else None
        out: list[tuple[int, int]] = []
        if isinstance(xobjects, Dictionary):
            for value in xobjects.values():
                if value.get("/Subtype") == Name.Image:
                    out.append((int(value.Width), int(value.Height)))
        return out


def pdf_size(path: Path | str) -> int:
    return Path(path).stat().st_size


def array_of(*values: Any) -> Array:
    return Array(list(values))
