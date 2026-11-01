"""Synthetic page images for the page-image tests (v0.8). Nothing here is a real scan or photo.

Every generator is deterministic for a given seed and returns RGB uint8 arrays, with the ground
truth (paper corners, skin mask, skew) next to them so that tests can compare against it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np

A4_RATIO = 297 / 210  # height / width of an A4 sheet


@dataclass
class Scene:
    rgb: np.ndarray  # H x W x 3 uint8
    quad: np.ndarray | None  # 4 x 2 float, TL TR BR BL, ground truth paper corners in px
    skin: np.ndarray | None = None  # H x W bool, ground truth skin mask (fingers)


def text_page(
    width: int,
    height: int,
    *,
    seed: int = 1,
    paper: tuple[int, int, int] = (246, 244, 236),
    ink: int = 35,
    margin: float = 0.09,
    lines: int = 42,
) -> np.ndarray:
    """A4-like text page: rows of word-sized dark boxes on a paper colour, drawn left to right."""
    rng = np.random.default_rng(seed)
    img = np.empty((height, width, 3), np.uint8)
    img[:] = paper
    x0, x1 = int(width * margin), int(width * (1 - margin))
    top = int(height * 0.08)
    bottom = int(height * 0.92)
    step = (bottom - top) / lines
    for line in range(lines):
        y = int(top + line * step)
        h = max(3, int(step * 0.42))
        x = x0
        while x < x1:
            w = int(rng.integers(max(4, width // 40), max(8, width // 14)))
            if x + w > x1:
                w = x1 - x
            if w <= 0:
                break
            cv2.rectangle(img, (x, y), (x + w, y + h), (ink, ink, ink), -1)
            x += w + int(rng.integers(max(3, width // 80), max(6, width // 45)))
    return img


def rotate_ccw(
    img: np.ndarray, degrees: float, fill: tuple[int, int, int] = (255, 255, 255)
) -> np.ndarray:
    """Rotate counter-clockwise (as displayed) about the centre, keeping the canvas size."""
    h, w = img.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), degrees, 1.0)
    return cv2.warpAffine(
        img, m, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=fill
    )


def scanner_page(
    width: int = 1240,
    height: int = 1754,
    *,
    seed: int = 2,
    border: int = 38,
    shift: tuple[int, int] = (0, 0),
    lid_shadow: float = 0.0,
) -> Scene:
    """A flatbed scan: a paper sheet on the dark lid of the scanner. Ground truth: paper corners."""
    paper = text_page(width, height, seed=seed)
    canvas = np.full((height, width, 3), 34, np.uint8)
    canvas[:] = (34, 34, 36)
    x0, y0 = border + shift[0], border + shift[1]
    x1, y1 = width - border + shift[0], height - border + shift[1]
    canvas[y0:y1, x0:x1] = paper[y0:y1, x0:x1]
    if lid_shadow:
        ramp = np.linspace(1.0, 1.0 - lid_shadow, width, dtype=np.float32)[None, :, None]
        canvas = np.clip(canvas.astype(np.float32) * ramp, 0, 255).astype(np.uint8)
    quad = np.array([[x0, y0], [x1 - 1, y0], [x1 - 1, y1 - 1], [x0, y1 - 1]], np.float64)
    return Scene(rgb=canvas, quad=quad)


def project_quad(
    img_w: int,
    img_h: int,
    *,
    rect_w: float,
    pitch: float,
    yaw: float,
    fill: float = 0.62,
    dist: float = 2.4,
) -> np.ndarray:
    """Corners (TL, TR, BR, BL) of a sheet of width ``rect_w`` and height 1 (units), tilted by
    ``pitch`` and ``yaw`` degrees (about X and Y), with a pinhole camera at distance ``dist``.
    ``fill`` is the projected height of the sheet at distance ``dist`` as a fraction of img_h."""
    pts = np.array(
        [
            [-rect_w / 2, -0.5, 0.0],
            [rect_w / 2, -0.5, 0.0],
            [rect_w / 2, 0.5, 0.0],
            [-rect_w / 2, 0.5, 0.0],
        ]
    )
    px, py = math.radians(pitch), math.radians(yaw)
    rx = np.array([[1, 0, 0], [0, math.cos(px), -math.sin(px)], [0, math.sin(px), math.cos(px)]])
    ry = np.array([[math.cos(py), 0, math.sin(py)], [0, 1, 0], [-math.sin(py), 0, math.cos(py)]])
    pts = pts @ rx.T @ ry.T
    depth = pts[:, 2] + dist
    focal = fill * img_h * dist
    return np.column_stack(
        [img_w / 2 + focal * pts[:, 0] / depth, img_h / 2 + focal * pts[:, 1] / depth]
    )


def photo_scene(
    *,
    size: tuple[int, int] = (1600, 1200),
    quad: np.ndarray | None = None,
    seed: int = 3,
    background: str = "texture",
    bg_colour: tuple[int, int, int] = (92, 104, 118),
    paper_colour: tuple[int, int, int] = (238, 236, 228),
    shadow: float = 0.0,
    skin_blob: bool = False,
    noise: float = 2.5,
) -> Scene:
    """A phone photo of a sheet on a desk. ``quad`` (TL TR BR BL, px) places the sheet; by default
    a perspective-projected A4 sheet. ``background`` is ``plain``, ``texture`` (noise and blotches
    in blue-grey, no skin tones) or ``dark``. ``skin_blob`` adds a finger touching the bottom edge
    (ground truth in ``Scene.skin``)."""
    w, h = size
    rng = np.random.default_rng(seed)
    if quad is None:
        quad = project_quad(w, h, rect_w=1 / A4_RATIO, pitch=8, yaw=-6, fill=0.8)
    quad = np.asarray(quad, np.float64)
    bg = np.empty((h, w, 3), np.float32)
    bg[:] = bg_colour
    if background == "texture":
        blot = rng.normal(0, 1, (h // 40 + 2, w // 40 + 2)).astype(np.float32)
        blot = cv2.resize(blot, (w, h), interpolation=cv2.INTER_CUBIC)
        bg += blot[..., None] * 14
        grain = rng.normal(0, 9, (h, w, 1)).astype(np.float32)
        bg += grain
    elif background == "dark":
        bg *= 0.6
    flat_w, flat_h = 1000, round(1000 * A4_RATIO)
    flat = text_page(flat_w, flat_h, seed=seed + 7, paper=paper_colour, lines=40)
    src = np.array([[0, 0], [flat_w - 1, 0], [flat_w - 1, flat_h - 1], [0, flat_h - 1]], np.float32)
    m = cv2.getPerspectiveTransform(src, quad.astype(np.float32))
    warped = cv2.warpPerspective(flat, m, (w, h), flags=cv2.INTER_LINEAR).astype(np.float32)
    mask = (
        cv2.warpPerspective(
            np.full((flat_h, flat_w), 255, np.uint8), m, (w, h), flags=cv2.INTER_LINEAR
        ).astype(np.float32)
        / 255.0
    )
    scene = bg * (1 - mask[..., None]) + warped * mask[..., None]
    skin_mask: np.ndarray | None = None
    if skin_blob:
        skin_mask = np.zeros((h, w), bool)
        cx = int(w * 0.46)
        cy = h - 4
        skin_layer = np.zeros((h, w), np.uint8)
        cv2.ellipse(skin_layer, (cx, cy), (int(w * 0.07), int(h * 0.055)), 0, 0, 360, 255, -1)
        skin_mask = skin_layer > 0
        colour = np.array([224, 172, 140], np.float32)
        soft = cv2.GaussianBlur(skin_layer.astype(np.float32) / 255.0, (5, 5), 1.0)
        scene = scene * (1 - soft[..., None]) + colour * soft[..., None]
    if shadow:
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        gradient = 1 - shadow * np.clip((xx / w) * 1.1 - 0.15, 0, 1) * (0.6 + 0.4 * yy / h)
        scene *= gradient[..., None]
    if noise:
        scene += rng.normal(0, noise, scene.shape).astype(np.float32)
    rgb = np.clip(scene, 0, 255).astype(np.uint8)
    return Scene(rgb=rgb, quad=quad, skin=skin_mask)


def page_image_pdf_bytes(rgb: np.ndarray, dpi: int = 150) -> tuple[bytes, float, float]:
    """A one-page image PDF (via PIL, page size from dpi): returns (bytes, width_pt, height_pt)."""
    import io

    from PIL import Image

    pil = Image.fromarray(rgb)
    w_pt = rgb.shape[1] / dpi * 72
    h_pt = rgb.shape[0] / dpi * 72
    buf = io.BytesIO()
    pil.save(buf, format="PDF", resolution=float(dpi), quality=90)
    return buf.getvalue(), w_pt, h_pt


def quad_error(found: np.ndarray, truth: np.ndarray, size: tuple[int, int]) -> float:
    """Largest corner distance, as a fraction of the longer image side."""
    d = np.linalg.norm(np.asarray(found, float) - np.asarray(truth, float), axis=1)
    return float(d.max() / max(size))


def ink_fraction(rgb: np.ndarray) -> float:
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    return float((gray < 100).mean())
