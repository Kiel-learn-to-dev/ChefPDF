"""Generates the files of content-v06.spec.ts (run with the core environment: uv run).

Usage: python content_v06_corpus.py OUT_DIR FONT_PATH
  similar.pdf : three A4 pages with the same header ("Logo mẫu") at the same place, and a body line
                that differs on each page.
  image.pdf   : one A4 page with a solid blue image block (40, 120, 200) at a known place.
  red.png     : a red image of the same size, the replacement picked in the test.
"""

import sys
from pathlib import Path

from PIL import Image
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

out = Path(sys.argv[1])
pdfmetrics.registerFont(TTFont("BeVietnamPro", sys.argv[2]))

c = canvas.Canvas(str(out / "similar.pdf"), pagesize=A4)
for number in (1, 2, 3):
    c.setFont("BeVietnamPro", 14)
    c.drawString(72, 800, "Logo mẫu")
    c.setFont("BeVietnamPro", 12)
    c.drawString(72, 700, f"Nội dung trang {number} giữ lại.")
    c.showPage()
c.save()

Image.new("RGB", (200, 100), (40, 120, 200)).save(out / "block.png")
Image.new("RGB", (200, 100), (200, 30, 30)).save(out / "red.png")
c = canvas.Canvas(str(out / "image.pdf"), pagesize=A4)
c.setFont("BeVietnamPro", 12)
c.drawString(72, 700, "Trang có ảnh.")
c.drawImage(str(out / "block.png"), 72, 500, width=200, height=100)
c.showPage()
c.save()
print("ok")
