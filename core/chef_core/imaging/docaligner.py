"""Offline DocAligner inference (LCNet100 heatmap, Apache-2.0 weights).

The model and its provenance are bundled under ``chef_core/resources/models``. Its SHA-256 is
checked before ONNX Runtime loads it, so no network download path is involved.
"""

from __future__ import annotations

import hashlib
from functools import lru_cache
from importlib import resources
from pathlib import Path
from typing import Any

import numpy as np

from chef_core.imaging.pageimg import PageQuad

MODEL_FILE = "lcnet100_h_e_bifpn_256_fp32.onnx"
MODEL_SHA256 = "f4117b786e3a18470f3865c93f3c2bd69d9b998edd60f385574a5c665e79594e"
_INPUT_SIZE = 256
_HEATMAP_THRESHOLD = 0.3


def _model_path() -> Path:
    return Path(
        str(
            resources.files("chef_core.resources")
            .joinpath("models")
            .joinpath("docaligner-1.1.1")
            .joinpath(MODEL_FILE)
        )
    )


@lru_cache(maxsize=1)
def _session() -> Any:
    path = _model_path()
    if not path.is_file():
        raise FileNotFoundError(f"Bundled DocAligner model is missing: {path}")
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != MODEL_SHA256:
        raise RuntimeError("Bundled DocAligner model failed its SHA-256 check")
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    return ort.InferenceSession(str(path), sess_options=options, providers=["CPUExecutionProvider"])


def _largest_centroid(mask: np.ndarray) -> tuple[float, float] | None:
    import cv2

    count, _labels, stats, centroids = cv2.connectedComponentsWithStats(
        np.ascontiguousarray(mask.astype(np.uint8)), connectivity=8
    )
    if count <= 1:
        return None
    component = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    if stats[component, cv2.CC_STAT_AREA] <= 0:
        return None
    x, y = centroids[component]
    return float(x), float(y)


def _plausible(corners: np.ndarray, width: int, height: int) -> bool:
    if corners.shape != (4, 2) or not np.all(np.isfinite(corners)):
        return False
    if corners[:, 0].min() < -0.1 * width or corners[:, 0].max() > 1.1 * width:
        return False
    if corners[:, 1].min() < -0.1 * height or corners[:, 1].max() > 1.1 * height:
        return False
    edges = np.roll(corners, -1, axis=0) - corners
    crosses = edges[:, 0] * np.roll(edges[:, 1], -1) - edges[:, 1] * np.roll(edges[:, 0], -1)
    if not (np.all(crosses > 0) or np.all(crosses < 0)):
        return False
    x, y = corners[:, 0], corners[:, 1]
    area = abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))) / 2
    return 0.08 <= area / (width * height) <= 1.21


def detect_page_quad(img: np.ndarray, *, session: Any | None = None) -> PageQuad | None:
    """Predict sheet corners from RGB pixels; return ``None`` when heatmaps are inconclusive.

    The source model expects BGR floats in [0, 1], resized to 256×256. Its four 128×128 heatmaps
    are resized to the input dimensions and thresholded at 0.3, matching the upstream inference
    procedure. The confidence is the mean corner peak multiplied by geometric plausibility.
    """
    import cv2

    if img.ndim == 2:
        rgb = cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)
    elif img.ndim == 3 and img.shape[2] == 3:
        rgb = img
    else:
        raise ValueError("DocAligner expects a grayscale or RGB image")
    if rgb.dtype != np.uint8:
        raise ValueError("DocAligner expects uint8 pixels")
    height, width = rgb.shape[:2]
    if width < 2 or height < 2:
        return None

    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    resized = cv2.resize(bgr, (_INPUT_SIZE, _INPUT_SIZE), interpolation=cv2.INTER_LINEAR)
    tensor = np.ascontiguousarray(resized.transpose(2, 0, 1)[None], dtype=np.float32) / 255.0
    runner = session if session is not None else _session()
    output = runner.run(["heatmap"], {"img": tensor})[0]
    if output.ndim != 4 or output.shape[0] != 1 or output.shape[1] != 4:
        raise RuntimeError(f"Unexpected DocAligner heatmap shape: {output.shape}")

    corners: list[tuple[float, float]] = []
    peaks: list[float] = []
    for heatmap in output[0]:
        full = cv2.resize(
            heatmap.astype(np.float32), (width, height), interpolation=cv2.INTER_LINEAR
        )
        peak = float(full.max())
        point = _largest_centroid(full >= _HEATMAP_THRESHOLD)
        if point is None or peak < _HEATMAP_THRESHOLD:
            return None
        corners.append(point)
        peaks.append(float(np.clip(peak, 0.0, 1.0)))

    quad = np.asarray(corners, dtype=np.float64)
    if not _plausible(quad, width, height):
        return None
    # Heatmap peaks alone are overconfident on low-contrast pages. Calibrate them against the
    # same local edge/inside-outside evidence used for the classical candidates.
    from chef_core.imaging import pageimg as pi

    gray = pi.to_gray(rgb)
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    grad_x = cv2.Sobel(blur, cv2.CV_32F, 1, 0, ksize=3)
    grad_y = cv2.Sobel(blur, cv2.CV_32F, 0, 1, ksize=3)
    grad = cv2.dilate(np.hypot(grad_x, grad_y), np.ones((5, 5), np.uint8))
    grad_threshold = float(np.percentile(grad, 97)) * 0.5 + 1e-6
    evidence_score, _edge, _contrast = pi._score_quad(
        blur.astype(np.float32), grad, grad_threshold, quad
    )
    evidence_confidence = float(np.clip((evidence_score - 0.5) / 0.45, 0.0, 1.0))
    confidence = min(float(np.mean(peaks)), evidence_confidence)
    return PageQuad(
        corners=quad,
        confidence=round(confidence, 3),
        method="docaligner-lcnet100",
        score=round(evidence_score, 3),
    )


def prefer_confident_quad(classical: PageQuad, learned: PageQuad | None) -> PageQuad:
    """Pick the candidate with the higher confidence; ties keep the classical detector."""
    if learned is not None and learned.confidence > classical.confidence:
        return learned
    return classical
