"""Reads a PDF back for spine.spec.ts: page count and, per page, which marker colour is present.

Usage: python spine_check.py FILE.pdf   (run with the core environment). Prints JSON:
{"pages": 2, "markers": ["red", "blue"]}, where a page without a marker reports null.
"""

import json
import sys

import numpy as np
import pypdfium2 as pdfium


def marker(rgb: np.ndarray) -> str | None:
    r, b = rgb[..., 0].astype(int), rgb[..., 2].astype(int)
    if float(((r - b) > 40).mean()) > 0.02:
        return "red"
    if float(((b - r) > 40).mean()) > 0.02:
        return "blue"
    return None


pdf = pdfium.PdfDocument(sys.argv[1])
markers = []
for index in range(len(pdf)):
    bitmap = pdf[index].render(scale=72 / 72).to_pil().convert("RGB")
    markers.append(marker(np.asarray(bitmap)))
print(json.dumps({"pages": len(pdf), "markers": markers}))
