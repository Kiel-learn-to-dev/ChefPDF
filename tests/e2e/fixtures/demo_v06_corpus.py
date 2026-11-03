"""Generates the files of demo-v06.spec.ts (run with the core environment: uv run).

Usage: python demo_v06_corpus.py OUT_DIR FONT_PATH
  demo.pdf : three A4 pages. Page 1 has a line to erase, page 2 has a national ID number
             (CCCD), page 3 has plain text that must survive every step.
  logo.png : the logo that the test stamps on every page as a watermark.
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

out = Path(sys.argv[1])
pdfmetrics.registerFont(TTFont("BeVietnamPro", sys.argv[2]))

PAGES = [
    ["Trang một: dòng này sẽ được tẩy đi.", "Trang một: nội dung giữ lại."],
    ["Trang hai: Số CCCD: 012345678901", "Trang hai: nội dung khác giữ lại."],
    ["Trang ba: nội dung cuối cùng giữ lại."],
]

c = canvas.Canvas(str(out / "demo.pdf"), pagesize=A4)
for lines in PAGES:
    c.setFont("BeVietnamPro", 12)
    y = 700
    for line in lines:
        c.drawString(72, y, line)
        y -= 24
    c.showPage()
c.save()

logo = Image.new("RGB", (240, 120), (255, 255, 255))
draw = ImageDraw.Draw(logo)
draw.rectangle([10, 10, 230, 110], outline=(200, 30, 30), width=8)
draw.ellipse([60, 35, 180, 85], fill=(200, 30, 30))
logo.save(out / "logo.png")
print("ok")
