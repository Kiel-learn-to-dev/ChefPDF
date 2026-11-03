"""Generate a curved text page and a blank image page for the L13 Electron/core test."""

from __future__ import annotations

import io
import sys

import img2pdf
import pikepdf
from PIL import Image, ImageDraw

output = sys.argv[1]
page = Image.new("RGB", (700, 900), (248, 248, 248))
draw = ImageDraw.Draw(page)
for row, base_y in enumerate(range(120, 790, 82)):
    for x in range(75, 630, 12):
        xn = (x - 350) / 350
        y = int(base_y + 28 * xn * xn)
        offset = row % 2 * 2
        draw.rectangle((x, y + offset, x + 7, y + 5 + offset), fill=(30, 30, 30))

jpg = io.BytesIO()
page.save(jpg, format="JPEG", quality=94)
pdf = pikepdf.open(io.BytesIO(img2pdf.convert(jpg.getvalue())))
blank = Image.new("RGB", (700, 900), (250, 250, 250))
blank_jpg = io.BytesIO()
blank.save(blank_jpg, format="JPEG", quality=94)
second = pikepdf.open(io.BytesIO(img2pdf.convert(blank_jpg.getvalue())))
pdf.pages.append(second.pages[0])
pdf.save(output)
