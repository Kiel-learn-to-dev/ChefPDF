"""PDF builders for the document model tests (T10.01, T10.02).

Every fixture is generated here (reportlab Platypus or canvas, Be Vietnam Pro for Vietnamese text).
Only generated PDFs are used: real-world documents were not available to the tests.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pikepdf
from PIL import Image as PILImage
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfgen import canvas
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    Image,
    KeepTogether,
    ListFlowable,
    ListItem,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)
from text_support import BOLD, PAGE_H, PAGE_W, REG, register_fonts

W, H = A4
LEFT, RIGHT_EDGE = 60.0, W - 60.0
COL_W = (RIGHT_EDGE - LEFT - 24) / 2
HEADER_TEXT = "Báo cáo thường niên 2026 · Chef PDF"
FOOTER_TEXT = "Bí mật nội bộ"

SENTENCES = [
    "Doanh thu quý này tăng trưởng ổn định so với cùng kỳ năm trước.",
    "Chi phí vận hành được kiểm soát chặt chẽ theo kế hoạch đã duyệt.",
    "Các đơn vị thành viên tiếp tục mở rộng thị trường trong nước.",
    "Đội ngũ kỹ thuật hoàn thành đúng hạn ba dự án trọng điểm.",
]


def _styles() -> dict[str, ParagraphStyle]:
    register_fonts()
    return {
        "title": ParagraphStyle("title", fontName=BOLD, fontSize=20, leading=24),
        "h1": ParagraphStyle("h1", fontName=BOLD, fontSize=16, leading=20, spaceBefore=8),
        "h2": ParagraphStyle("h2", fontName=BOLD, fontSize=13, leading=16, spaceBefore=6),
        "body": ParagraphStyle("body", fontName=REG, fontSize=10, leading=13, spaceAfter=4),
        "caption": ParagraphStyle("caption", fontName=REG, fontSize=9, leading=11),
    }


def _png(path: Path) -> Path:
    img = PILImage.new("RGB", (240, 120), (235, 240, 250))
    for x in range(0, 240, 20):
        for y in range(120):
            img.putpixel((x, y), (30, 90, 180))
    img.save(path)
    return path


def _report_story(st: dict[str, ParagraphStyle], png: Path, filler: int) -> list:
    story: list = []
    story.append(Paragraph("1. Giới thiệu", st["h1"]))
    for i in range(filler):
        story.append(
            Paragraph(" ".join(SENTENCES[: 1 + i % 4]) + " " + SENTENCES[i % 4], st["body"])
        )
    story.append(Paragraph("1.1 Phạm vi báo cáo", st["h2"]))
    story.append(
        Paragraph(
            "Báo cáo này trình bày kết quả kinh doanh của công ty trong năm tài chính, "
            "gồm các chỉ tiêu chính và nhận định của ban điều hành về triển vọng sắp tới "
            "trong bối cảnh thị trường nhiều biến động.",
            st["body"],
        )
    )
    story.append(Paragraph("Các bước thực hiện:", st["body"]))
    story.append(
        ListFlowable(
            [
                ListItem(Paragraph("Bước một: thu thập số liệu", st["body"])),
                ListItem(
                    [
                        Paragraph("Bước hai: đối chiếu số liệu", st["body"]),
                        ListFlowable(
                            [
                                ListItem(Paragraph("con a: đối chiếu sổ sách", st["body"])),
                                ListItem(Paragraph("con b: kiểm tra chứng từ", st["body"])),
                            ],
                            bulletType="a",
                            bulletFormat="%s.",
                            leftIndent=12,
                            bulletFontName=REG,
                        ),
                    ]
                ),
                ListItem(Paragraph("Bước ba: lập báo cáo", st["body"])),
            ],
            bulletType="1",
            bulletFormat="%s.",
            leftIndent=14,
            bulletFontName=REG,
            bulletFontSize=10,
        )
    )
    story.append(Spacer(1, 6))
    rows = [
        ["Quý", "Doanh thu", "Chi phí", "Lợi nhuận"],
        ["Quý 1", "120", "80", "40"],
        ["Quý 2", "135", "86", "49"],
    ]
    table = Table(rows, colWidths=[52, 60, 60, 58])
    table.setStyle(
        TableStyle(
            [
                ("GRID", (0, 0), (-1, -1), 0.5, colors.black),
                ("FONTNAME", (0, 0), (-1, 0), BOLD),
                ("FONTNAME", (0, 1), (-1, -1), REG),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#DDE6F5")),
            ]
        )
    )
    story.append(
        KeepTogether(
            [
                table,
                Spacer(1, 4),
                Image(str(png), width=180, height=90),
                Paragraph("Hình 1. Doanh thu theo quý", st["caption"]),
            ]
        )
    )
    story.append(Spacer(1, 6))
    story.append(Paragraph("2. Kết luận", st["h1"]))
    for i in range(filler):
        story.append(Paragraph(" ".join(SENTENCES[i % 4 :] + SENTENCES[: i % 4]), st["body"]))
    return story


def report_pdf(path: Path, pages: int = 6) -> Path:
    """Two-column report on A4: a full-width title on page 1, repeated header and footer with a
    page number, headings, a long paragraph flowing across pages and columns, a nested list, a
    ruled table with a header row, and an image with a caption.

    The filler is tuned so that the document has ``pages`` pages."""
    st = _styles()
    png = _png(path.with_suffix(".png"))
    filler = 12
    for _ in range(8):
        out = _build_report(path, st, png, filler)
        count = len(pikepdf.open(out).pages)
        if count == pages:
            break
        filler = max(1, filler + (pages - count) * 6)
    return path


def _build_report(path: Path, st: dict[str, ParagraphStyle], png: Path, filler: int) -> Path:
    def furniture(cv: canvas.Canvas, doc: BaseDocTemplate) -> None:
        cv.saveState()
        cv.setFont(REG, 8)
        cv.drawString(LEFT, H - 36, HEADER_TEXT)
        cv.drawString(LEFT, 36, FOOTER_TEXT)
        cv.drawRightString(RIGHT_EDGE, 36, f"Trang {doc.page}")
        cv.restoreState()

    def first(cv: canvas.Canvas, doc: BaseDocTemplate) -> None:
        furniture(cv, doc)
        cv.saveState()
        cv.setFont(BOLD, 20)
        cv.drawString(LEFT, H - 80, "Báo cáo thường niên")
        cv.restoreState()

    top_first = H - 110
    top_later = H - 70
    bottom = 60
    frames_first = [
        Frame(LEFT, bottom, COL_W, top_first - bottom, id="a1", showBoundary=0),
        Frame(LEFT + COL_W + 24, bottom, COL_W, top_first - bottom, id="b1", showBoundary=0),
    ]
    frames_later = [
        Frame(LEFT, bottom, COL_W, top_later - bottom, id="a2", showBoundary=0),
        Frame(LEFT + COL_W + 24, bottom, COL_W, top_later - bottom, id="b2", showBoundary=0),
    ]
    doc = BaseDocTemplate(str(path), pagesize=A4, leftMargin=LEFT, rightMargin=60)
    doc.addPageTemplates(
        [
            PageTemplate(id="first", frames=frames_first, onPage=first),
            PageTemplate(id="later", frames=frames_later, onPage=furniture),
        ]
    )
    from reportlab.platypus import NextPageTemplate

    story = [NextPageTemplate("later"), *_report_story(st, png, filler)]
    doc.build(story)
    return path


def articles_pdf(path: Path, articles: int = 4) -> Path:
    """A single-column contract with 'Điều N.' articles (heading, then body paragraphs)."""
    register_fonts()
    cv = canvas.Canvas(str(path), pagesize=(PAGE_W, PAGE_H))
    y = PAGE_H - 80
    cv.setFont(BOLD, 14)
    cv.drawString(72, y, "HỢP ĐỒNG DỊCH VỤ")
    y -= 30
    for n in range(1, articles + 1):
        cv.setFont(BOLD, 12)
        cv.drawString(72, y, f"Điều {n}. Nội dung điều khoản số {n}")
        y -= 18
        cv.setFont(REG, 10)
        for text in (
            "Các bên cam kết thực hiện đúng nghĩa vụ đã thỏa thuận trong hợp đồng này",
            "và chịu trách nhiệm trước pháp luật về việc thực hiện các điều khoản đó.",
        ):
            cv.drawString(72, y, text)
            y -= 14
        y -= 10
    cv.showPage()
    cv.save()
    return path


def ruled_table_pdf(path: Path, merged_header: bool = True, text: str = "Công ty") -> Path:
    """A 3-row x 4-column ruled table. With ``merged_header`` the first row's first two cells are
    one cell (the inner rule is missing) and the header row has a grey fill."""
    register_fonts()
    cv = canvas.Canvas(str(path), pagesize=(PAGE_W, PAGE_H))
    x0, top = 72.0, 600.0
    widths = [110.0, 90.0, 90.0, 90.0]
    row_h = 24.0
    xs = [x0]
    for w in widths:
        xs.append(xs[-1] + w)
    ys = [top - i * row_h for i in range(4)]
    cv.setFillColor(colors.HexColor("#DDE6F5"))
    cv.rect(x0, ys[1], sum(widths), row_h, stroke=0, fill=1)
    cv.setFillColor(colors.black)
    cv.setStrokeColor(colors.black)
    cv.setLineWidth(0.8)
    for y in ys:
        cv.line(x0, y, xs[-1], y)
    for i, x in enumerate(xs):
        if merged_header and i == 1:
            cv.line(x, ys[1], x, ys[3])  # no rule in the header row: cells 0 and 1 are merged
        else:
            cv.line(x, ys[0], x, ys[3])
    _cell(cv, x0 + 6, ys[0] - 16, text, bold=True)
    _cell(cv, xs[2] + 6, ys[0] - 16, "Doanh thu", bold=True)
    _cell(cv, xs[3] + 6, ys[0] - 16, "Chi phí", bold=True)
    _cell(cv, x0 + 6, ys[1] - 16, "Quý 1")
    _cell(cv, xs[1] + 6, ys[1] - 16, "120")
    _cell(cv, xs[2] + 6, ys[1] - 16, "80")
    _cell(cv, xs[3] + 6, ys[1] - 16, "40")
    _cell(cv, x0 + 6, ys[2] - 16, "Quý 2")
    _cell(cv, xs[1] + 6, ys[2] - 16, "135")
    _cell(cv, xs[2] + 6, ys[2] - 16, "86")
    _cell(cv, xs[3] + 6, ys[2] - 16, "49")
    cv.showPage()
    cv.save()
    return path


def _cell(cv: canvas.Canvas, x: float, y: float, text: str, bold: bool = False) -> None:
    cv.setFont(BOLD if bold else REG, 9)
    cv.drawString(x, y, text)


def ruled_table_pages_pdf(path: Path) -> Path:
    """Two pages; a ruled table with the same grid is at the bottom of page 1 and at the top of
    page 2 (with a repeated header row). The continuation must merge into one table."""
    register_fonts()
    cv = canvas.Canvas(str(path), pagesize=(PAGE_W, PAGE_H))
    x0 = 72.0
    widths = [110.0, 90.0, 90.0, 90.0]
    xs = [x0]
    for w in widths:
        xs.append(xs[-1] + w)
    row_h = 24.0

    def grid(top: float, rows: list[list[str]], header: bool) -> None:
        ys = [top - i * row_h for i in range(len(rows) + 1)]
        cv.setLineWidth(0.8)
        for y in ys:
            cv.line(x0, y, xs[-1], y)
        for x in xs:
            cv.line(x, ys[0], x, ys[-1])
        for r, row in enumerate(rows):
            for c, text in enumerate(row):
                _cell(cv, xs[c] + 6, ys[r] - 16, text, bold=header and r == 0)

    grid(
        120.0,
        [["Mục", "Q1", "Q2", "Q3"], ["Doanh", "10", "11", "12"], ["Chi", "5", "6", "7"]],
        True,
    )
    cv.showPage()
    grid(
        PAGE_H - 80.0,
        [["Mục", "Q1", "Q2", "Q3"], ["Lãi", "1", "2", "3"], ["Thuế", "4", "5", "6"]],
        True,
    )
    cv.showPage()
    cv.save()
    return path


def scanned_page_pdf(path: Path) -> Path:
    """One page holding only an image (no text layer)."""
    img = path.with_suffix(".png")
    PILImage.new("L", (600, 800), 240).save(img)
    cv = canvas.Canvas(str(path), pagesize=(PAGE_W, PAGE_H))
    cv.drawImage(str(img), 0, 0, width=PAGE_W, height=PAGE_H)
    cv.showPage()
    cv.save()
    return path


def drawn_figure_pdf(path: Path) -> Path:
    """A text paragraph, then a vector drawing (a bar chart) with a caption below it."""
    register_fonts()
    cv = canvas.Canvas(str(path), pagesize=(PAGE_W, PAGE_H))
    cv.setFont(REG, 10)
    cv.drawString(72, 700, "Biểu đồ dưới đây cho thấy doanh thu theo tháng trong năm nay.")
    cv.setFillColor(colors.HexColor("#1E5AB4"))
    for i, h in enumerate([60, 90, 120, 80, 150]):
        cv.rect(90 + i * 60, 420, 40, h, stroke=0, fill=1)
    cv.setFillColor(colors.black)
    cv.setFont(REG, 9)
    cv.drawString(72, 400, "Hình 2. Doanh thu theo tháng")
    cv.showPage()
    cv.save()
    return path


def paragraph_pages_pdf(path: Path, pages: int, body: Callable[[int], str]) -> Path:
    """Plain pages of text lines (for timing tests): ``body(i)`` gives the text of page i."""
    register_fonts()
    cv = canvas.Canvas(str(path), pagesize=(PAGE_W, PAGE_H))
    for i in range(pages):
        y = PAGE_H - 72
        for k, line in enumerate(body(i).split("\n")):
            cv.setFont(BOLD if k == 0 else REG, 14 if k == 0 else 10)
            cv.drawString(72, y, line)
            y -= 16 if k == 0 else 13
        cv.showPage()
    cv.save()
    return path


__all__ = [
    "articles_pdf",
    "drawn_figure_pdf",
    "paragraph_pages_pdf",
    "report_pdf",
    "ruled_table_pages_pdf",
    "ruled_table_pdf",
    "scanned_page_pdf",
]
