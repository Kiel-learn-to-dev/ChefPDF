"""Writes spread.pdf for spine.spec.ts: one two-page spread image (1800 x 2400 px) with a shadow
at the binding in the middle. The left page has a red marker at its top-left, the right page a blue
one, so the split order and the split position can be read back from the rendered pages.

Usage: python spine_corpus.py OUT.pdf   (run with the core environment)
"""

import io
import sys
from pathlib import Path

import img2pdf
import numpy as np
from PIL import Image

out = Path(sys.argv[1])
rng = np.random.default_rng(3)
h, w = 2400, 1800
left = np.full((h, w // 2, 3), 236, dtype=np.float32) + rng.normal(0, 3, (h, w // 2, 3))
right = np.full((h, w // 2, 3), 236, dtype=np.float32) + rng.normal(0, 3, (h, w // 2, 3))
left[120:420, 90:390] = (220, 30, 30)  # red: top-left of the left page
right[120:420, 90:390] = (30, 30, 220)  # blue: top-left of the right page
spread = np.concatenate([left, right], axis=1)
x = np.arange(w, dtype=np.float32)
valley = np.exp(-((x - w / 2) ** 2) / (2 * (w * 0.035) ** 2))
spread *= (1 - 60 / 255.0 * valley)[None, :, None]
buf = io.BytesIO()
Image.fromarray(np.clip(spread, 0, 255).astype(np.uint8)).save(buf, format="PNG")
out.write_bytes(img2pdf.convert(buf.getvalue()))
print("ok", out)
