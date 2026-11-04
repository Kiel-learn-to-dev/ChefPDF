"""Reads the saved page back for erase.spec.ts. Prints JSON with the mean grey of the black block
centre (high after erasing), and the blue share of the blue block (low after the stain removal).

Usage: python erase_check.py FILE.pdf   (run with the core environment)
"""

import json
import sys

import numpy as np
import pypdfium2 as pdfium

pdf = pdfium.PdfDocument(sys.argv[1])
rgb = np.asarray(pdf[0].render(scale=1).to_pil().convert("RGB")).astype(int)
h, w = rgb.shape[:2]
block = rgb[int(h * 0.2) : int(h * 0.26), int(w * 0.4) : int(w * 0.6)]
blue = rgb[int(h * 0.58) : int(h * 0.62), int(w * 0.5) : int(w * 0.62)]
blue_share = float(((blue[..., 2] - blue[..., 0]) > 60).mean())
print(json.dumps({"blockMean": round(float(block.mean()), 1), "blueShare": round(blue_share, 4)}))
