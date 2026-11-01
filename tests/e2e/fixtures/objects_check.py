"""Checks of objects.spec.ts on a saved file. Prints one JSON object.

Usage: python objects_check.py FILE MODE [ARGS]
  MODE 'pixel X Y'   : RGB of the pixel at X, Y (points from the top-left) of page 1, rendered at 1 pt = 1 px.
  MODE 'text'        : the text of page 1.
  MODE 'layeroff'    : the names of the optional-content groups that are OFF by default.
"""

import json
import sys

import pikepdf
import pypdfium2 as pdfium

path, mode = sys.argv[1], sys.argv[2]

if mode == "pixel":
    x, y = int(sys.argv[3]), int(sys.argv[4])
    doc = pdfium.PdfDocument(path)
    bitmap = doc[0].render(scale=1).to_pil().convert("RGB")
    r, g, b = bitmap.getpixel((x, y))
    print(json.dumps({"rgb": [r, g, b]}))
elif mode == "text":
    doc = pdfium.PdfDocument(path)
    text = doc[0].get_textpage().get_text_range()
    print(json.dumps({"text": text}))
elif mode == "layeroff":
    with pikepdf.open(path) as pdf:
        props = pdf.Root.get("/OCProperties")
        names = []
        if props is not None:
            d = props.get("/D")
            off = d.get("/OFF", []) if d is not None else []
            names = [str(g.get("/Name", "")) for g in off]
        print(json.dumps({"off": names}))
else:
    raise SystemExit(f"unknown mode {mode}")
