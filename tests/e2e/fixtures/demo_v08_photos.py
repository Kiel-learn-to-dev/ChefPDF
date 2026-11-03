"""Synthetic phone photos of a book for demo-v08.spec.ts. Nothing here is a real photo.

Usage: python demo_v08_photos.py OUTDIR

Writes p01.jpg .. p20.jpg (in upload order) and manifest.json next to them. The photos reuse the
synthetic scene helpers of core/tests/pageimg_support.py (perspective sheet, finger, low contrast).
Kinds: 18 single pages (tilted, one curved text block, one with a finger on the edge, one with a
very low contrast sheet) and 2 two-page spreads (landscape photos, two pages each after the split).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import cv2
import img2pdf
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "core" / "tests"))

from pageimg_support import A4_RATIO, photo_scene, project_quad, rotate_ccw, text_page

out_dir = Path(sys.argv[1])
out_dir.mkdir(parents=True, exist_ok=True)

PORTRAIT = (1200, 1600)
LANDSCAPE = (1600, 1200)
BACKGROUND = (92, 104, 118)


def curved_page(width: int, height: int, seed: int) -> np.ndarray:
    """A text page whose lines bend (like a book page held open): same shape as dewarp_corpus."""
    flat = text_page(width, height, seed=seed, lines=40)
    out = np.empty_like(flat)
    out[:] = (246, 244, 236)
    rows = flat.shape[0]
    for y in range(rows):
        for x in range(width):
            xn = (x - width / 2) / (width / 2)
            sy = int(y + 45 * xn * xn * (1 - abs(y / rows - 0.5) * 0.6))
            if 0 <= sy < rows:
                out[y, x] = flat[sy, x]
    return out


def spread_page(seed: int) -> np.ndarray:
    """Two A4 pages side by side with a shadowed gutter (2000 x 1414 px flat)."""
    left = text_page(1000, 1414, seed=seed, lines=40)
    right = text_page(1000, 1414, seed=seed + 1, lines=40)
    flat = np.concatenate([left, right], axis=1).astype(np.float32)
    xx = np.arange(2000, dtype=np.float32)
    gutter = 1 - 0.35 * np.exp(-((xx - 1000) ** 2) / (2 * 35**2))
    flat *= gutter[None, :, None]
    return np.clip(flat, 0, 255).astype(np.uint8)


def place(
    flat: np.ndarray, quad: np.ndarray, size: tuple[int, int], seed: int
) -> np.ndarray:
    """Composite a flat sheet onto a textured desk through a perspective quad (TL TR BR BL)."""
    w, h = size
    rng = np.random.default_rng(seed)
    bg = np.empty((h, w, 3), np.float32)
    bg[:] = BACKGROUND
    blot = rng.normal(0, 1, (h // 40 + 2, w // 40 + 2)).astype(np.float32)
    bg += cv2.resize(blot, (w, h), interpolation=cv2.INTER_CUBIC)[..., None] * 14
    fh, fw = flat.shape[:2]
    src = np.array([[0, 0], [fw - 1, 0], [fw - 1, fh - 1], [0, fh - 1]], np.float32)
    m = cv2.getPerspectiveTransform(src, np.asarray(quad, np.float32))
    warped = cv2.warpPerspective(flat, m, (w, h), flags=cv2.INTER_LINEAR).astype(
        np.float32
    )
    mask = (
        cv2.warpPerspective(np.full((fh, fw), 255, np.uint8), m, (w, h)).astype(
            np.float32
        )
        / 255.0
    )
    scene = bg * (1 - mask[..., None]) + warped * mask[..., None]
    scene += rng.normal(0, 2.5, scene.shape).astype(np.float32)
    return np.clip(scene, 0, 255).astype(np.uint8)


def save(name: str, rgb: np.ndarray) -> None:
    cv2.imwrite(
        str(out_dir / name),
        cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR),
        [cv2.IMWRITE_JPEG_QUALITY, 90],
    )


photos: list[dict[str, object]] = []
for n in range(1, 21):
    name = f"p{n:02d}.jpg"
    seed = 40 + n
    entry: dict[str, object] = {"file": name, "pages": 1, "kind": "single"}
    if n in (6, 15):
        # Spreads: landscape sheet, slight tilt; the core splits each into two pages.
        quad = project_quad(
            LANDSCAPE[0], LANDSCAPE[1], rect_w=2000 / 1414, pitch=5, yaw=-4, fill=0.66
        )
        rgb = place(spread_page(seed), quad, LANDSCAPE, seed)
        entry.update(pages=2, kind="spread")
    elif n == 10:
        # Very low contrast: paper nearly as dark as the desk, the core must not crop it.
        rgb = photo_scene(
            size=PORTRAIT,
            seed=seed,
            background="plain",
            bg_colour=(116, 116, 114),
            paper_colour=(122, 120, 115),
            noise=2,
        ).rgb
        entry.update(kind="lowContrast")
    elif n == 4:
        # A finger on the bottom edge, lying over the lower edge of the sheet (ground truth: the
        # skin blob in the photo). The sheet reaches below the photo's bottom third so the finger
        # is on the paper, not on the desk.
        sheet = np.array(
            [[150, 120], [1050, 130], [1060, 1560], [140, 1560]], np.float64
        )
        rgb = photo_scene(size=PORTRAIT, quad=sheet, seed=seed, skin_blob=True).rgb
        entry.update(kind="finger")
    elif n == 14:
        # Curved text block, tilted photo.
        quad = project_quad(
            PORTRAIT[0], PORTRAIT[1], rect_w=1 / A4_RATIO, pitch=6, yaw=4, fill=0.8
        )
        rgb = place(
            curved_page(1000, round(1000 * A4_RATIO), seed), quad, PORTRAIT, seed
        )
        entry.update(kind="curved")
    else:
        pitch = float((n * 3) % 9 - 4)
        yaw = float((n * 5) % 11 - 5)
        quad = project_quad(
            PORTRAIT[0],
            PORTRAIT[1],
            rect_w=1 / A4_RATIO,
            pitch=pitch,
            yaw=yaw,
            fill=0.8,
        )
        rgb = photo_scene(size=PORTRAIT, quad=quad, seed=seed).rgb
    if n % 4 == 0:
        # A whole-photo tilt (the user holds the phone a little crooked).
        angle = 2.0 + (n % 3)
        rgb = rotate_ccw(rgb, angle, fill=BACKGROUND)
        entry["tiltDegrees"] = angle
    save(name, rgb)
    photos.append(entry)

(out_dir / "manifest.json").write_text(
    json.dumps(
        {"photos": photos, "outputPages": sum(int(p["pages"]) for p in photos)},
        indent=2,
    ),
    encoding="utf-8",
)
# The finger photo as a one-page PDF: the finger is removed before the crop (see demo-v08.spec.ts).
finger_jpg = out_dir / "p04.jpg"
(out_dir / "finger-page.pdf").write_bytes(img2pdf.convert(str(finger_jpg)))
print(
    json.dumps(
        {"photos": len(photos), "outputPages": sum(int(p["pages"]) for p in photos)}
    )
)
