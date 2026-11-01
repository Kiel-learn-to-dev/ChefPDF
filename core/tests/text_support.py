"""PDF builders for the text model and text edits (T7.01, T7.02, T7.04).

Vietnamese text is drawn with Be Vietnam Pro through reportlab (which embeds a subset holding only
the characters used) and, for Type0 partial subsets, through the overlay's own embedder.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pikepdf
from content_support import form_xobject, helvetica
from pikepdf import Dictionary
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

import chef_core
from chef_core.overlay.engine import _embed_font
from chef_core.overlay.fonts import face

FONT_DIR = Path(chef_core.__file__).parent / "resources" / "fonts"
REG = "TxtBeVN"
BOLD = "TxtBeVNBold"
PAGE_W = 612.0
PAGE_H = 792.0


def register_fonts() -> None:
    if REG not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(REG, str(FONT_DIR / "BeVietnamPro-Regular.ttf")))
        pdfmetrics.registerFont(TTFont(BOLD, str(FONT_DIR / "BeVietnamPro-Bold.ttf")))


def canvas_pdf(
    path: Path,
    draw: Callable[[canvas.Canvas, int], None],
    *,
    pages: int = 1,
    rotate: int = 0,
) -> Path:
    """A reportlab document of ``pages`` pages, drawn by ``draw(canvas, page_index)``."""
    register_fonts()
    cv = canvas.Canvas(str(path), pagesize=(PAGE_W, PAGE_H))
    for i in range(pages):
        draw(cv, i)
        cv.showPage()
    cv.save()
    if rotate:
        with pikepdf.open(path, allow_overwriting_input=True) as pdf:
            for page in pdf.pages:
                page.obj.Rotate = rotate
            pdf.save(path)
    return path


def put(
    cv: canvas.Canvas, x: float, y: float, text: str, size: float = 11, bold: bool = False
) -> None:
    cv.setFont(BOLD if bold else REG, size)
    cv.drawString(x, y, text)


def justified(
    cv: canvas.Canvas, x: float, y: float, width: float, text: str, size: float = 11
) -> None:
    """One line, stretched so that it ends at x + width (word spacing)."""
    natural = pdfmetrics.stringWidth(text, REG, size)
    spaces = text.count(" ")
    spacing = (width - natural) / spaces if spaces else 0.0
    obj = cv.beginText(x, y)
    obj.setFont(REG, size)
    obj.setWordSpace(spacing)
    obj.textOut(text)
    cv.drawText(obj)


def vi_page(path: Path, rows: list[tuple[float, float, float, str, bool]], rotate: int = 0) -> Path:
    """A page with the given rows: (x, baseline y, size, text, bold)."""

    def draw(cv: canvas.Canvas, _i: int) -> None:
        for x, y, size, text, bold in rows:
            put(cv, x, y, text, size, bold)

    return canvas_pdf(path, draw, rotate=rotate)


def helvetica_pdf(path: Path, rows: list[tuple[float, float, float, str]]) -> Path:
    """Standard-14 Helvetica (not embedded), ASCII text."""
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page = pdf.pages[0]
    page.obj.Resources = Dictionary(Font=Dictionary(F1=helvetica(pdf)))
    body = []
    for x, y, size, text in rows:
        body.append(f"BT /F1 {size} Tf {x} {y} Td ({_escape(text)}) Tj ET")
    page.obj.Contents = pdf.make_stream("\n".join(body).encode("latin-1"))
    pdf.save(path)
    pdf.close()
    return path


def _escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def cid_subset_pdf(path: Path, subset_text: str, content: str) -> Path:
    """A page whose font F2 is a Type0 Identity-H subset of Be Vietnam Pro holding only the
    characters of ``subset_text``. ``content`` is raw; use ``cid_hex`` for string operands."""
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page = pdf.pages[0]
    fam = face("BeVietnamPro", bold=False)
    font = _embed_font(pdf, fam, fam.subset({ord(c) for c in subset_text}), "test-subset")
    page.obj.Resources = Dictionary(Font=Dictionary(F1=helvetica(pdf), F2=font))
    page.obj.Contents = pdf.make_stream(content.encode("latin-1"))
    pdf.save(path)
    pdf.close()
    return path


def cid_hex(text: str) -> str:
    fam = face("BeVietnamPro", bold=False)
    return "".join(f"{fam.gid(ord(c)) or 0:04X}" for c in text)


def form_text_pdf(path: Path, text: str) -> Path:
    """Helvetica text drawn only inside a Form XObject (/Fm0) of the page."""

    def setup(pdf: pikepdf.Pdf, page: pikepdf.Page) -> None:
        inner = f"BT /F1 12 Tf 72 600 Td ({_escape(text)}) Tj ET".encode("latin-1")
        form = form_xobject(
            pdf,
            inner,
            (0, 0, PAGE_W, PAGE_H),
            resources=Dictionary(Font=Dictionary(F1=helvetica(pdf))),
        )
        page.obj.Resources.XObject = Dictionary(Fm0=form)

    from content_support import raw_pdf

    return raw_pdf(path, b"q /Fm0 Do Q", setup=setup)


def two_column_pdf(path: Path) -> Path:
    """Two text columns (left x 72..312, right x 330..570), a bold heading, a justified
    paragraph on the left and a bulleted list on the right."""

    def draw(cv: canvas.Canvas, _i: int) -> None:
        put(cv, 72, 730, "Điều 1. Phạm vi áp dụng", 14, bold=True)
        justified(cv, 72, 706, 240, "Hợp đồng này quy định việc cung cấp dịch vụ giữa các bên", 10)
        justified(cv, 72, 692, 240, "theo đúng các điều khoản được ghi trong văn bản này", 10)
        put(cv, 72, 678, "và có hiệu lực kể từ ngày ký.", 10)
        put(cv, 330, 730, "Điều 2. Thanh toán", 14, bold=True)
        put(cv, 330, 706, "- Thanh toán trong vòng 30 ngày", 10)
        put(cv, 330, 692, "- Phí dịch vụ theo bảng giá", 10)
        put(cv, 330, 678, "- Thuế giá trị gia tăng 10%", 10)

    return canvas_pdf(path, draw)


def contract_pdf(path: Path, pages: int, company: str = "Công ty ABC") -> Path:
    """A contract of ``pages`` pages; every page has the company name three times."""

    def draw(cv: canvas.Canvas, index: int) -> None:
        put(cv, 72, 740, f"Hợp đồng số {index + 1}", 14, bold=True)
        put(cv, 72, 710, f"Bên A là {company}, đại diện bởi giám đốc.", 11)
        put(cv, 72, 690, f"Bên B cam kết hợp tác cùng {company} trong dự án.", 11)
        put(cv, 72, 670, f"Mọi tranh chấp giữa {company} và bên B sẽ được giải quyết.", 11)
        put(cv, 72, 640, "Điều khoản chung không liên quan đến nội dung thay thế.", 11)

    return canvas_pdf(path, draw, pages=pages)


def pdf_text(path: Path, index: int = 0) -> str:
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(path))
    try:
        page = doc[index]
        tp = page.get_textpage()
        try:
            return str(tp.get_text_range())
        finally:
            tp.close()
            page.close()
    finally:
        doc.close()


def squash(text: str) -> str:
    return "".join(text.split())
