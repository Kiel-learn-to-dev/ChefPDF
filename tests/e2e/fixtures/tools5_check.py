"""Checks of tools5.spec.ts on a saved file. Prints one JSON object.

Usage: python tools5_check.py FILE MODE [PAGE]
  MODE 'info'  : page count and whether the file opens.
  MODE 'gray'  : renders PAGE (1-based) and reports the largest colour difference of any pixel.
"""

import json
import sys

import pikepdf
import pypdfium2 as pdfium

path, mode = sys.argv[1], sys.argv[2]

if mode == "meta":
    with pikepdf.open(path) as pdf:
        author = pdf.docinfo.get("/Author")
        print(json.dumps({"author": str(author) if author is not None else None}))
elif mode == "info":
    with pikepdf.open(path) as pdf:
        print(json.dumps({"pages": len(pdf.pages), "opens": True}))
elif mode == "gray":
    page_no = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    doc = pdfium.PdfDocument(path)
    bitmap = doc[page_no - 1].render(scale=1).to_pil().convert("RGB")
    data = bitmap.tobytes()
    worst = 0
    for r, g, b in zip(data[0::3], data[1::3], data[2::3]):
        worst = max(worst, abs(r - g), abs(g - b), abs(r - b))
    print(json.dumps({"maxChannelSpread": worst, "pixels": bitmap.width * bitmap.height}))
else:
    raise SystemExit(f"unknown mode {mode}")
