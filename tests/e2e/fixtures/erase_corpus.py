"""Writes page.pdf for erase.spec.ts: one page image (1240 x 1754 px) with a black block (for the
rectangle eraser) and a blue block (for the colour-stain remover). Run with the core environment.

Usage: python erase_corpus.py OUT.pdf
"""

import io
import sys
from pathlib import Path

import img2pdf
import numpy as np
from PIL import Image

out = Path(sys.argv[1])
frame = np.full((1754, 1240, 3), 242, dtype=np.uint8)
frame[300:500, 300:900] = (20, 20, 20)  # black block: erase target
frame[1000:1100, 600:800] = (30, 60, 220)  # blue ink block: stain target
buf = io.BytesIO()
Image.fromarray(frame).save(buf, format="PNG")
out.write_bytes(img2pdf.convert(buf.getvalue()))
print("ok", out)
