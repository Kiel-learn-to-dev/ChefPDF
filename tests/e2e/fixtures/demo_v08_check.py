"""Independent checks of a saved PDF for demo-v08.spec.ts. Prints one JSON object.

Usage: python demo_v08_check.py FILE

Per page, measured from the rendered pixels (not from the core's own reports):
  width, height   page size in points
  skewDeg         text-line angle from the row profile of the ink (0 when straight)
  cornerMean      mean grey of the four corners (near 255 when the paper was whitened)
  skinBorder      skin-coloured pixels touching the page border (a finger left on the edge)
  skinShare       skin-coloured share of the whole page
  inkShare        share of dark pixels (text is still there after the finger was removed)
"""

from __future__ import annotations

import json
import sys

import cv2
import numpy as np
import pypdfium2 as pdfium


def skin_mask(rgb: np.ndarray) -> np.ndarray:
    """Skin tones of the synthetic finger (224,172,140) and similar: hue 0-25, moderate saturation."""
    hsv = cv2.cvtColor(rgb, cv2.COLOR_RGB2HSV)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    return (h <= 25) & (s >= 40) & (s <= 200) & (v >= 60)


def skew_degrees(gray: np.ndarray) -> float:
    ink = (gray < 110).astype(np.uint8) * 255
    h, w = ink.shape
    ink = ink[int(h * 0.1) : int(h * 0.9), int(w * 0.1) : int(w * 0.9)]
    best_angle, best_score = 0.0, -1.0
    for angle in np.arange(-3.0, 3.01, 0.25):
        m = cv2.getRotationMatrix2D(
            (ink.shape[1] / 2, ink.shape[0] / 2), float(angle), 1.0
        )
        rot = cv2.warpAffine(ink, m, (ink.shape[1], ink.shape[0]))
        profile = rot.sum(axis=1).astype(np.float64)
        score = float(profile.var())
        if score > best_score:
            best_angle, best_score = float(angle), score
    return round(best_angle, 2)


def page_report(page: pdfium.PdfPage) -> dict[str, float]:
    width, height = page.get_size()
    rgb = np.asarray(page.render(scale=1.5).to_pil().convert("RGB"))
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    k = max(4, min(gray.shape) // 20)
    corners = np.concatenate(
        [
            gray[:k, :k].ravel(),
            gray[:k, -k:].ravel(),
            gray[-k:, :k].ravel(),
            gray[-k:, -k:].ravel(),
        ]
    )
    border = np.zeros(gray.shape, bool)
    border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True
    skin = skin_mask(rgb)
    return {
        "width": round(float(width), 2),
        "height": round(float(height), 2),
        "skewDeg": skew_degrees(gray),
        "cornerMean": round(float(corners.mean()), 1),
        "skinBorder": int((skin & border).sum()),
        "skinShare": round(float(skin.mean()), 5),
        "inkShare": round(float((gray < 110).mean()), 4),
    }


doc = pdfium.PdfDocument(sys.argv[1])
pages = [page_report(doc[i]) for i in range(len(doc))]
print(json.dumps({"pages": len(doc), "rows": pages}))
