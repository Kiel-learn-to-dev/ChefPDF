"""PDF builders and measurements for the page content engine (T6.01, T6.04).

Pages are written as raw content streams so that every operator scenario (forms, inline
images, nested q/Q, clipping, TJ kerning, shadings) is on purpose. Text metrics come from
Be Vietnam Pro through reportlab, so that PDFium's character boxes can be compared with ours.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium
from pdf_media import image_xobject, render
from pikepdf import Array, Dictionary, Name
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

import chef_core

FONT_FILE = Path(chef_core.__file__).parent / "resources" / "fonts" / "BeVietnamPro-Regular.ttf"
FONT_NAME = "BeVietnamPro"


def helvetica(pdf: pikepdf.Pdf) -> pikepdf.Object:
    return pdf.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
    )


def raw_pdf(
    path: Path,
    content: bytes | list[bytes],
    *,
    pages: int = 1,
    rotate: int = 0,
    setup: Callable[[pikepdf.Pdf, pikepdf.Page], None] | None = None,
    width: float = 612.0,
    height: float = 792.0,
) -> Path:
    """One or more pages with ``content`` drawn by raw operators. F1 is Helvetica and the
    resources of the page are F1 plus whatever ``setup`` adds (called once per page)."""
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=(width, height))
    for page in pdf.pages:
        page.obj.Resources = Dictionary(Font=Dictionary(F1=helvetica(pdf)))
        if rotate:
            page.obj.Rotate = rotate
        if setup is not None:
            setup(pdf, page)
        if isinstance(content, list):
            page.obj.Contents = Array([pdf.make_stream(c) for c in content])
        else:
            page.obj.Contents = pdf.make_stream(content)
    pdf.save(path)
    pdf.close()
    return path


def form_xobject(
    pdf: pikepdf.Pdf,
    content: bytes,
    bbox: tuple[float, float, float, float],
    *,
    matrix: tuple[float, ...] = (1, 0, 0, 1, 0, 0),
    resources: Dictionary | None = None,
) -> pikepdf.Stream:
    stream = pdf.make_stream(content)
    stream.Type = Name.XObject
    stream.Subtype = Name.Form
    stream.BBox = Array(list(bbox))
    stream.Matrix = Array(list(matrix))
    if resources is not None:
        stream.Resources = resources
    return stream


def vietnamese_pdf(path: Path, rotate: int = 0) -> Path:
    """A reportlab page with Vietnamese lines (subset TrueType, ToUnicode), a red box and a
    blue circle. Coordinates are the ones the tests use; the page is 612 x 792."""
    if FONT_NAME not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(FONT_NAME, str(FONT_FILE)))
    cv = canvas.Canvas(str(path), pagesize=(612, 792))
    cv.setFont(FONT_NAME, 24)
    cv.setFillColorRGB(0, 0, 0)
    cv.drawString(72, 700, "Tiếng Việt có dấu: Hà Nội")
    cv.setFont(FONT_NAME, 14)
    cv.drawString(72, 640, "Chef PDF sửa nội dung trang")
    cv.setFillColorRGB(1, 0, 0)
    cv.rect(72, 420, 200, 120, stroke=0, fill=1)
    cv.setFillColorRGB(0, 0, 1)
    cv.circle(400, 480, 40, stroke=0, fill=1)
    cv.showPage()
    cv.save()
    if rotate:
        with pikepdf.open(path, allow_overwriting_input=True) as pdf:
            pdf.pages[0].obj.Rotate = rotate
            pdf.save(path)
    return path


def pdfium_chars(path: Path, index: int = 0) -> tuple[str, list[tuple[float, float, float, float]]]:
    """Text of a page and PDFium's *loose* character boxes (l, b, r, t): advance-based boxes,
    the same definition as the engine's glyph boxes (tight boxes exclude side bearings).
    Line-break entries that PDFium adds between text runs are left out."""
    doc = pdfium.PdfDocument(str(path))
    try:
        page = doc[index]
        tp = page.get_textpage()
        text = tp.get_text_range()
        boxes = [tp.get_charbox(i, loose=True) for i in range(tp.count_chars())]
        tp.close()
        # PDFium puts zero-size CR/LF entries between runs; keep the glyphs only
        kept = [(c, b) for c, b in zip(text, boxes, strict=False) if c not in "\r\n"]
        return "".join(c for c, _ in kept), [(b[0], b[1], b[2], b[3]) for _, b in kept]
    finally:
        doc.close()


def pdfium_image_bounds(path: Path, index: int = 0) -> list[tuple[float, float, float, float]]:
    doc = pdfium.PdfDocument(str(path))
    try:
        page = doc[index]
        out = [
            tuple(float(v) for v in obj.get_bounds())
            for obj in page.get_objects()
            if obj.type == pdfium.raw.FPDF_PAGEOBJ_IMAGE
        ]
        return out
    finally:
        doc.close()


def ink_bbox(
    img: object, predicate: Callable[[tuple[int, int, int]], bool]
) -> tuple[int, int, int, int] | None:
    """Bounding box (left, top, right, bottom) in pixels of pixels matching ``predicate``."""
    from PIL import Image

    assert isinstance(img, Image.Image)
    rgb = img.convert("RGB")
    xs: list[int] = []
    ys: list[int] = []
    w, h = rgb.size
    data = rgb.load()
    assert data is not None
    for y in range(h):
        for x in range(w):
            if predicate(data[x, y]):
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def is_red(px: tuple[int, int, int]) -> bool:
    return px[0] > 200 and px[1] < 80 and px[2] < 80


def is_blue(px: tuple[int, int, int]) -> bool:
    return px[2] > 200 and px[0] < 80 and px[1] < 80


def is_dark(px: tuple[int, int, int]) -> bool:
    return max(px) < 90


def render_png(path: Path, index: int = 0) -> object:
    return render(path, index)


__all__ = [
    "FONT_FILE",
    "form_xobject",
    "image_xobject",
    "ink_bbox",
    "is_blue",
    "is_dark",
    "is_red",
    "pdfium_chars",
    "pdfium_image_bounds",
    "raw_pdf",
    "render_png",
    "vietnamese_pdf",
]
