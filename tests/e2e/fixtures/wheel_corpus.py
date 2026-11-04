"""Writes long.pdf (text, 30 pages) and scan_long.pdf (image only, 30 pages) for wheel.spec.ts.

Usage: python wheel_corpus.py OUT_DIR   (run with the core environment)
"""

import io
import subprocess
import sys
from pathlib import Path

import img2pdf
import numpy as np
import pikepdf
from PIL import Image

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
here = Path(__file__).resolve().parent
subprocess.run([sys.executable, "-I", str(here / "textedit_corpus.py"), str(out)], check=True)
src = pikepdf.open(out / "contract.pdf")
long_pdf = pikepdf.new()
for _ in range(10):
    long_pdf.pages.extend(src.pages)
long_pdf.save(out / "long.pdf")

frame = np.full((1754, 1240, 3), 240, dtype=np.uint8)
frame[200:1500, 150:1100] = 60
buf = io.BytesIO()
Image.fromarray(frame).save(buf, format="PNG")
(out / "scan_long.pdf").write_bytes(img2pdf.convert([buf.getvalue()] * 30))
print("ok", out)
