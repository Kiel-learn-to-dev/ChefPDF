"""Measure the horizontal curl in embedded image pages of a PDF."""

from __future__ import annotations

import json
import sys

import numpy as np
import pikepdf
from PIL import Image


def span(img: Image.Image) -> float:
    gray = np.asarray(img.convert("L"))
    height, width = gray.shape
    results = []
    for base_y in range(120, 790, 82):
        centers = []
        for x0 in range(90, 610, 65):
            # Fixture pages use the same aspect ratio; compare centres in normalized coordinates.
            x = round(x0 * width / 700)
            y = round(base_y * height / 900)
            roi = gray[max(0, y - round(35 * height / 900)) : y + round(55 * height / 900),
                       x : x + round(50 * width / 700)]
            ys, _ = np.where(roi < 100)
            if len(ys):
                centers.append(float(np.median(ys)))
        if len(centers) >= 6:
            results.append(max(centers) - min(centers))
    return float(np.median(results)) if results else 0.0


with pikepdf.open(sys.argv[1]) as pdf:
    rows = []
    for page in pdf.pages:
        resources = page.obj.get("/Resources", pikepdf.Dictionary())
        xobjects = resources.get("/XObject", pikepdf.Dictionary())
        stream = next((x for x in xobjects.values() if x.get("/Subtype") == "/Image"), None)
        if stream is None:
            rows.append({"hasImage": False, "span": 0.0})
        else:
            rows.append({"hasImage": True, "span": round(span(pikepdf.PdfImage(stream).as_pil_image()), 2)})
    print(json.dumps({"pages": len(pdf.pages), "rows": rows}))
