"""Generates the PDFs of redact.spec.ts (run with the core environment: uv run).

Usage: python redact_corpus.py OUT_DIR FONT_PATH
"""

import sys
from pathlib import Path

import pikepdf
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

out = Path(sys.argv[1])
pdfmetrics.registerFont(TTFont("BeVietnamPro", sys.argv[2]))


def text_pdf(name: str, lines: list[str]) -> None:
    c = canvas.Canvas(str(out / name), pagesize=A4)
    c.setFont("BeVietnamPro", 12)
    y = 700
    for line in lines:
        c.drawString(72, y, line)
        y -= 24
    c.showPage()
    c.save()


# A page with a national ID number among other text (redaction).
text_pdf(
    "cccd.pdf",
    ["Họ tên: Nguyễn Văn An", "Số CCCD: 012345678901", "Nội dung khác của hợp đồng."],
)
# A plain text page, the base of the watermark test.
text_pdf("wm-base.pdf", ["Nội dung trang một của tài liệu."])

# A page with a full-page light rectangle under a dark bar (background detection).
bg = pikepdf.new()
bg.add_blank_page(page_size=(612, 792))
bg.pages[-1].Contents = bg.make_stream(
    b"0.95 0.95 0.9 rg 0 0 612 792 re f 0 0 0 rg 72 400 468 40 re f"
)
bg.save(out / "bg.pdf")
print("ok")
