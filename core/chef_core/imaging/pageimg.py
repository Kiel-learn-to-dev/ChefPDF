"""Page-image processing for scanned pages and phone photos (v0.8: L1-L19).

Pure functions on numpy arrays. Images are uint8, RGB (H x W x 3) or gray (H x W). Points are
(x, y) in pixels with the origin at the top-left corner. Corners are ordered TL, TR, BR, BL.

OpenCV is imported lazily (inside ``_cv2``) so that importing this module, and so the sidecar's
start-up, does not need it. Every function documents its failure modes; the operations in
``chef_core.ops.pageimg`` decide what to do with low confidence (they flag the page, they do not
apply the change).

Angle convention: ``deskew`` returns the *skew* of the content in degrees, counter-clockwise
positive (the value that ``rotate(img, -angle)`` removes). A page rotated counter-clockwise by 4
degrees gives 4.0.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Literal, TypedDict

import numpy as np

FillSpec = str | tuple[int, int, int]
PaperName = Literal["A4", "A5", "Letter"]

A_RATIO = 297 / 210  # height / width of A4 (and A5)
LETTER_RATIO = 11 / 8.5
RATIO_TOLERANCE = 0.03
MAX_SKEW = 15.0
_BORDER_SIDE = 0.25  # contrast credit of a quadrilateral side that lies on the image border


def _cv2() -> Any:
    """OpenCV, imported on first use only (see module docstring)."""
    import cv2

    return cv2


# -- small helpers --------------------------------------------------------------------------


def to_gray(img: np.ndarray) -> np.ndarray:
    if img.ndim == 2:
        return img
    return np.asarray(_cv2().cvtColor(img, _cv2().COLOR_RGB2GRAY))


def _fit(img: np.ndarray, max_side: int) -> tuple[np.ndarray, tuple[float, float]]:
    """Downscale so that the longer side is at most ``max_side``. Returns the image and the
    (x, y) factors that map its coordinates back to the input."""
    h, w = img.shape[:2]
    if max(h, w) <= max_side:
        return img, (1.0, 1.0)
    f = max_side / max(h, w)
    nw, nh = max(1, round(w * f)), max(1, round(h * f))
    small = _cv2().resize(img, (nw, nh), interpolation=_cv2().INTER_AREA)
    return small, (w / nw, h / nh)


def paper_colour(img: np.ndarray) -> tuple[int, int, int]:
    """Median colour of the lightest quarter of the pixels: the paper colour of a page.

    Failure mode: a page that is mostly dark (a photo, a black cover) returns a dark colour."""
    gray = to_gray(img)
    threshold = np.percentile(gray, 75)
    sel = img[gray >= threshold]
    if sel.size == 0:
        return (255, 255, 255)
    if img.ndim == 2:
        v = int(np.median(sel))
        return (v, v, v)
    med = np.median(sel.reshape(-1, 3), axis=0)
    return (int(med[0]), int(med[1]), int(med[2]))


def _colour_tuple(fill: tuple[int, int, int], ndim: int) -> tuple[int, ...]:
    return tuple(int(c) for c in fill) if ndim == 3 else (int(fill[0]),)


def _parse_fill(fill: FillSpec) -> tuple[int, int, int] | None:
    """``None`` for the paper colour, else the RGB colour of ``#rrggbb`` or a tuple."""
    if isinstance(fill, tuple):
        return (int(fill[0]), int(fill[1]), int(fill[2]))
    if fill == "paper":
        return None
    if fill.startswith("#") and len(fill) == 7:
        return (int(fill[1:3], 16), int(fill[3:5], 16), int(fill[5:7], 16))
    raise ValueError(f"fill must be 'paper', '#rrggbb' or an RGB tuple: {fill!r}")


# -- rotation and deskew (L1) ---------------------------------------------------------------


def rotate(
    img: np.ndarray, angle: float, fill: tuple[int, int, int] = (255, 255, 255)
) -> np.ndarray:
    """Rotate counter-clockwise (as displayed) about the centre. The canvas keeps its size; the
    corners that leave the canvas are lost and the new corners get ``fill``."""
    cv2 = _cv2()
    h, w = img.shape[:2]
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    return np.asarray(
        cv2.warpAffine(
            img,
            m,
            (w, h),
            flags=cv2.INTER_LINEAR,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=_colour_tuple(fill, img.ndim),
        )
    )


def _ink_mask(gray: np.ndarray) -> np.ndarray:
    cv2 = _cv2()
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    block = max(15, (min(gray.shape) // 40) | 1)
    return np.asarray(
        cv2.adaptiveThreshold(
            blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, block, 12
        )
    )


def _projection_scores(ink: np.ndarray, angles: np.ndarray) -> np.ndarray:
    """Variance of the row profile after un-rotating the ink by each candidate skew.

    Computed from the ink pixel coordinates (no image rotation): a point maps to the row
    ``x sin(a) + y cos(a)`` when the content is un-rotated by ``a``."""
    ys, xs = np.nonzero(ink)
    if xs.size > 300_000:
        step = xs.size // 300_000 + 1
        ys, xs = ys[::step], xs[::step]
    h, w = ink.shape
    cx, cy = w / 2.0, h / 2.0
    xs = xs.astype(np.float64) - cx
    ys = ys.astype(np.float64) - cy
    radius = math.ceil(math.hypot(w, h) / 2) + 1
    out = np.empty(len(angles))
    for i, a in enumerate(angles):
        t = math.radians(float(a))
        rows = xs * math.sin(t) + ys * math.cos(t)
        hist = np.bincount(np.floor(rows + radius).astype(np.int64), minlength=2 * radius + 1)
        out[i] = np.var(hist[: 2 * radius + 1].astype(np.float64))
    return out


def _hough_skew(ink: np.ndarray, max_angle: float) -> float | None:
    """Skew from the long segments of the text lines (ink joined horizontally)."""
    cv2 = _cv2()
    small, _ = _fit(ink, 700)
    small = (small > 127).astype(np.uint8) * 255
    _, w = small.shape
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(9, w // 40), 1))
    joined = cv2.dilate(small, kernel)
    segs = cv2.HoughLinesP(
        joined,
        1,
        math.pi / 720,
        threshold=max(30, w // 5),
        minLineLength=int(w * 0.25),
        maxLineGap=max(3, w // 60),
    )
    if segs is None:
        return None
    angles: list[float] = []
    weights: list[float] = []
    for seg in segs.reshape(-1, 4):
        x1, y1, x2, y2 = (float(v) for v in seg)
        length = math.hypot(x2 - x1, y2 - y1)
        a = math.degrees(math.atan2(y2 - y1, x2 - x1))
        if a > 90:
            a -= 180
        if a < -90:
            a += 180
        # image y points down: a line that falls to the right is a clockwise skew
        skew = -a
        if abs(skew) <= max_angle:
            angles.append(skew)
            weights.append(length)
    if not angles:
        return None
    order = np.argsort(angles)
    cum = np.cumsum(np.asarray(weights)[order])
    return float(np.asarray(angles)[order][np.searchsorted(cum, cum[-1] / 2)])


def deskew(img: np.ndarray, *, max_angle: float = MAX_SKEW) -> tuple[np.ndarray, float, float]:
    """Find the skew of the text lines and rotate the page back. Returns (image, angle, confidence).

    The search is a projection profile (variance of the row sums of the ink) on a copy scaled to
    at most 1000 px, coarse 0.5 degree steps then 0.05 degree steps, limited to +/- ``max_angle``.
    A Hough pass on the joined text lines is a cross-check; disagreement lowers the confidence.
    Confidence is 0 when there is almost no ink (blank page, photo) and drops when the profile has
    no clear peak (a page of figures, a table, text in columns of different skew).
    Failure modes: a page border or lid edge (the outer 4 % is ignored), a skew of more than
    ``max_angle``, upright text at a steep angle (a rotated page, 90 degrees, is not detected)."""
    gray = to_gray(img)
    h, w = gray.shape
    mh, mw = int(h * 0.04), int(w * 0.04)
    core = gray[mh : h - mh, mw : w - mw]
    small, _ = _fit(core, 1000)
    ink = _ink_mask(small)
    fill_share = float(ink.mean()) / 255.0
    if fill_share < 0.002 or fill_share > 0.5:
        return img.copy(), 0.0, 0.0
    coarse = np.arange(-max_angle, max_angle + 1e-9, 0.5)
    scores = _projection_scores(ink, coarse)
    best_c = float(coarse[int(np.argmax(scores))])
    fine = np.arange(max(-max_angle, best_c - 0.5), min(max_angle, best_c + 0.5) + 1e-9, 0.05)
    fine_scores = _projection_scores(ink, fine)
    best = float(fine[int(np.argmax(fine_scores))])
    peak = float(fine_scores.max())
    baseline = float(np.median(scores)) + 1e-9
    ratio = peak / baseline
    confidence = float(np.clip((ratio - 1.5) / 3.5, 0.0, 1.0))
    hough = _hough_skew(ink, max_angle)
    if hough is None:
        confidence *= 0.85
    elif abs(hough - best) > 0.6:
        confidence *= 0.6
    angle = round(best, 2)
    if abs(angle) < 0.05:
        return img.copy(), 0.0, round(confidence, 3)
    corrected = rotate(img, -angle, fill=paper_colour(img))
    return corrected, angle, round(confidence, 3)


# -- illumination, denoise, tone (L3, L4, L12) ------------------------------------------------


def whiten_background(img: np.ndarray, strength: float) -> np.ndarray:
    """Divide each channel by a large-scale estimate of the paper level (morphological closing
    removes dark text, then a wide blur). Shadows and uneven light are flattened, the paper
    becomes white. ``strength`` 0..1 blends with the original (0 returns the input unchanged).

    Failure modes: a page that is mostly ink (a heavy figure, a dark photo) gets a wrong
    estimate; a photo whose background is also light (a sheet on a white table) is brightened."""
    if strength <= 0:
        return img
    cv2 = _cv2()
    h, w = img.shape[:2]
    small, _ = _fit(img, 500)
    sh, sw = small.shape[:2]
    k = max(5, min(sh, sw) // 12) | 1
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
    sigma = max(2.0, k / 2)
    channels = small.reshape(sh, sw, -1)
    out = np.empty(img.shape, np.float32)
    flat_src = img.reshape(h, w, -1).astype(np.float32)
    for c in range(channels.shape[2]):
        closed = cv2.morphologyEx(channels[:, :, c], cv2.MORPH_CLOSE, kernel)
        bg = cv2.GaussianBlur(closed.astype(np.float32), (0, 0), sigma)
        bg_full = cv2.resize(bg, (w, h), interpolation=cv2.INTER_CUBIC)
        norm = flat_src[:, :, c] * 255.0 / np.maximum(bg_full, 1.0)
        out.reshape(h, w, -1)[:, :, c] = norm
    result = np.clip(out, 0, 255)
    blended = flat_src * (1 - strength) + result.reshape(h, w, -1) * strength
    blended = np.clip(blended, 0, 255).astype(np.uint8)
    return blended.reshape(img.shape)


def denoise(
    img: np.ndarray, strength: float, *, method: Literal["bilateral", "nlmeans"] = "bilateral"
) -> np.ndarray:
    """Remove dust specks and grain. ``strength`` 0..1 (0 returns the input unchanged).

    Specks (isolated pixels) are removed with a 3x3 median when strength is above 0.3; grain is
    smoothed with a bilateral filter (edges kept). ``nlmeans`` is slower and removes more grain.
    Failure modes: fine text strokes (about 1 px) are thinned by the median at high strength."""
    if strength <= 0:
        return img
    cv2 = _cv2()
    s = float(min(1.0, strength))
    out = img
    if s > 0.3:
        out = cv2.medianBlur(out, 3)
    if method == "nlmeans":
        h_param = 3 + 12 * s
        if out.ndim == 3:
            out = cv2.fastNlMeansDenoisingColored(out, None, h_param, h_param, 5, 11)
        else:
            out = cv2.fastNlMeansDenoising(out, None, h_param, 5, 11)
    else:
        out = cv2.bilateralFilter(out, 5, 10 + 60 * s, 5)
    if s < 1.0:
        out = np.clip(img.astype(np.float32) * (1 - s) + out.astype(np.float32) * s, 0, 255).astype(
            np.uint8
        )
    return np.asarray(out)


def _lut_apply(img: np.ndarray, lut: np.ndarray) -> np.ndarray:
    return np.asarray(lut.astype(np.uint8)[img])


def adjust_levels(img: np.ndarray, black: int, white: int, gamma: float) -> np.ndarray:
    """Input levels: ``black`` maps to 0, ``white`` to 255, then gamma (>1 brightens the mids).
    Failure mode: ``white`` must be above ``black``; a ValueError is raised otherwise."""
    if white <= black:
        raise ValueError("white must be greater than black")
    if gamma <= 0:
        raise ValueError("gamma must be positive")
    x = np.arange(256, dtype=np.float64)
    t = np.clip((x - black) / (white - black), 0.0, 1.0)
    lut = np.round(255.0 * t ** (1.0 / gamma))
    return _lut_apply(img, lut)


def curves(img: np.ndarray, points: list[tuple[float, float]]) -> np.ndarray:
    """A tone curve through ``points`` (input, output), 0..255. The ends default to (0,0) and
    (255,255). Points between are joined by straight segments (no spline, so no overshoot)."""
    pts = sorted({(float(x), float(y)) for x, y in points})
    if pts[0][0] > 0:
        pts.insert(0, (0.0, 0.0))
    if pts[-1][0] < 255:
        pts.append((255.0, 255.0))
    xs = np.array([p[0] for p in pts])
    ys = np.array([p[1] for p in pts])
    lut = np.clip(np.round(np.interp(np.arange(256), xs, ys)), 0, 255)
    return _lut_apply(img, lut)


def invert(img: np.ndarray) -> np.ndarray:
    return np.asarray((255 - img.astype(np.int16)).astype(np.uint8))


def tone(img: np.ndarray, brightness: float = 0.0, contrast: float = 0.0) -> np.ndarray:
    """Brightness and contrast, -100..100 each. Contrast scales around mid grey."""
    x = img.astype(np.float32)
    f = 1.0 + contrast / 100.0
    x = (x - 128.0) * f + 128.0 + brightness * 2.55
    return np.clip(np.round(x), 0, 255).astype(np.uint8)


def set_dpi(img: np.ndarray, dpi: float, *, current_dpi: float) -> np.ndarray:
    """Resample so that the image has ``dpi`` where it had ``current_dpi`` for the same paper
    size (pixels scale by dpi / current_dpi). Down-sampling uses area averaging."""
    cv2 = _cv2()
    f = dpi / current_dpi
    h, w = img.shape[:2]
    nw, nh = max(1, round(w * f)), max(1, round(h * f))
    interp = cv2.INTER_AREA if f < 1 else cv2.INTER_CUBIC
    return np.asarray(cv2.resize(img, (nw, nh), interpolation=interp))


# -- page quad and perspective (L15, L16, L17, L19) -------------------------------------------


@dataclass(frozen=True)
class PageQuad:
    corners: np.ndarray  # 4 x 2 float, TL TR BR BL, pixels of the input image
    confidence: float  # 0..1; below about 0.6 the page should be reviewed by hand
    method: str  # "scanner-threshold", "scanner-lines", "photo-threshold" or "photo-lines"
    score: float  # raw score of the chosen quadrilateral


def order_corners(points: np.ndarray) -> np.ndarray:
    """Sort four points as TL, TR, BR, BL (by sum and difference of the coordinates)."""
    pts = np.asarray(points, np.float64).reshape(4, 2)
    s = pts.sum(axis=1)
    d = pts[:, 0] - pts[:, 1]
    tl = pts[int(np.argmin(s))]
    br = pts[int(np.argmax(s))]
    tr = pts[int(np.argmax(d))]
    bl = pts[int(np.argmin(d))]
    return np.array([tl, tr, br, bl])


def detect_paper_size(width_px: int, height_px: int, dpi: float | None) -> PaperName | None:
    """A paper name when the proportions are within 3 % of A4/A5 (height/width 1.414) or Letter
    (1.294). With ``dpi``, A5 is told from A4 by the physical size (148 mm vs 210 mm). Without it,
    any A-series match is reported as A4. Returns None for other proportions."""
    long_side, short_side = max(width_px, height_px), min(width_px, height_px)
    if short_side <= 0:
        return None
    ratio = long_side / short_side
    if abs(ratio / A_RATIO - 1) <= RATIO_TOLERANCE:
        if dpi is None:
            return "A4"
        short_mm = short_side / dpi * 25.4
        return "A5" if short_mm < 179 else "A4"
    if abs(ratio / LETTER_RATIO - 1) <= RATIO_TOLERANCE:
        return "Letter"
    return None


def warp_perspective(
    img: np.ndarray,
    corners: np.ndarray,
    out_size: tuple[int, int] | None = None,
    *,
    snap_paper: bool = True,
    dpi: float | None = None,
) -> np.ndarray:
    """Map the quadrilateral ``corners`` (TL TR BR BL) onto a rectangle.

    Without ``out_size`` the size comes from the edge lengths (the mean of the two opposite
    edges). With ``snap_paper`` a size that is within 3 % of A4, A5 or Letter proportions is set to
    the exact paper ratio (the longer side is kept). Pixels outside the image get the paper colour.
    Failure modes: a quadrilateral that is far from a rectangle (a folded or curled sheet) gives a
    skewed result; the caller should check the confidence first."""
    cv2 = _cv2()
    c = order_corners(corners).astype(np.float32)
    if out_size is None:
        top = float(np.linalg.norm(c[1] - c[0]))
        bottom = float(np.linalg.norm(c[2] - c[3]))
        left = float(np.linalg.norm(c[3] - c[0]))
        right = float(np.linalg.norm(c[2] - c[1]))
        w = (top + bottom) / 2
        h = (left + right) / 2
        if snap_paper and w > 0 and h > 0:
            name = detect_paper_size(round(w), round(h), dpi)
            if name is not None:
                ratio = LETTER_RATIO if name == "Letter" else A_RATIO
                long_side = max(w, h)
                short_side = long_side / ratio
                w, h = (short_side, long_side) if h >= w else (long_side, short_side)
        out_w, out_h = max(1, round(w)), max(1, round(h))
    else:
        out_w, out_h = out_size
    dst = np.array([[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]], np.float32)
    m = cv2.getPerspectiveTransform(c, dst)
    fill = paper_colour(img)
    return np.asarray(
        cv2.warpPerspective(
            img,
            m,
            (out_w, out_h),
            flags=cv2.INTER_CUBIC,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=_colour_tuple(fill, img.ndim),
        )
    )


def _quad_is_plausible(q: np.ndarray, w: int, h: int) -> bool:
    if not np.all(np.isfinite(q)):
        return False
    if q[:, 0].min() < -0.1 * w or q[:, 0].max() > 1.1 * w:
        return False
    if q[:, 1].min() < -0.1 * h or q[:, 1].max() > 1.1 * h:
        return False
    cross = []
    for i in range(4):
        a, b, c3 = q[i], q[(i + 1) % 4], q[(i + 2) % 4]
        cross.append((b[0] - a[0]) * (c3[1] - b[1]) - (b[1] - a[1]) * (c3[0] - b[0]))
    cross_arr = np.asarray(cross)
    return bool(np.all(cross_arr > 0) or np.all(cross_arr < 0))


def _polygon_area(q: np.ndarray) -> float:
    x, y = q[:, 0], q[:, 1]
    return float(abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2)


def _side_samples(q: np.ndarray, centroid: np.ndarray) -> list[tuple[np.ndarray, np.ndarray]]:
    """For each side: sample points along it and the inward unit normal."""
    out = []
    for i in range(4):
        p0, p1 = q[i], q[(i + 1) % 4]
        length = float(np.linalg.norm(p1 - p0))
        n = max(16, int(length / 4))
        t = np.linspace(0.04, 0.96, n)
        pts = p0[None, :] + t[:, None] * (p1 - p0)[None, :]
        d = (p1 - p0) / max(length, 1e-9)
        nrm = np.array([-d[1], d[0]])
        mid = (p0 + p1) / 2
        if float(np.dot(nrm, centroid - mid)) < 0:
            nrm = -nrm
        out.append((pts, nrm))
    return out


def _bilinear(arr: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    h, w = arr.shape
    xi = np.clip(np.round(x).astype(int), 0, w - 1)
    yi = np.clip(np.round(y).astype(int), 0, h - 1)
    return np.asarray(arr[yi, xi])


def _score_quad(
    gray: np.ndarray, grad: np.ndarray, grad_thr: float, q: np.ndarray
) -> tuple[float, float, float]:
    """(score, edge support, contrast) of a quadrilateral in the working image.

    edge support: share of samples along the sides where the gradient is strong.
    contrast: for each side, the signed difference between the sample 8 px inside and 8 px
    outside, at every sample along it. A true edge has a large difference with the same sign at
    almost every sample; text lines and texture have a small or changing difference. A side on the
    image border has no outside and is not counted (it cannot be checked)."""
    h, w = gray.shape
    centroid = q.mean(axis=0)
    edge_hits: list[float] = []
    side_contrast: list[float] = []
    depth = 8.0
    for pts, nrm in _side_samples(q, centroid):
        edge_hits.append(float((_bilinear(grad, pts[:, 0], pts[:, 1]) > grad_thr).mean()))
        inside = pts + nrm[None, :] * depth
        outside = pts - nrm[None, :] * depth
        in_ok = (
            (inside[:, 0] >= 0)
            & (inside[:, 0] < w - 1)
            & (inside[:, 1] >= 0)
            & (inside[:, 1] < h - 1)
        )
        out_ok = (
            (outside[:, 0] >= 0)
            & (outside[:, 0] < w - 1)
            & (outside[:, 1] >= 0)
            & (outside[:, 1] < h - 1)
        )
        if in_ok.mean() < 0.8 or out_ok.mean() < 0.8:
            # a side on the image border cannot be checked: it earns only a weak share
            side_contrast.append(_BORDER_SIDE)
            continue
        diff = _bilinear(gray, inside[:, 0], inside[:, 1]) - _bilinear(
            gray, outside[:, 0], outside[:, 1]
        )
        sign = 1.0 if float(np.median(diff)) >= 0 else -1.0
        consistent = float(np.mean(sign * diff > 18))
        magnitude = float(np.clip(np.median(np.abs(diff)) / 50.0, 0.0, 1.0))
        side_contrast.append(magnitude * consistent)
    edge = float(np.mean(edge_hits)) if edge_hits else 0.0
    contrast = float(np.mean(side_contrast)) if side_contrast else 0.0
    # corner angles: a sheet is a rectangle seen from above
    cos_vals = []
    for i in range(4):
        a, b, c3 = q[i - 1], q[i], q[(i + 1) % 4]
        v1, v2 = a - b, c3 - b
        denom = float(np.linalg.norm(v1) * np.linalg.norm(v2)) + 1e-9
        cos_vals.append(abs(float(np.dot(v1, v2)) / denom))
    shape = float(np.clip(1 - max(cos_vals) / 0.5, 0.0, 1.0))
    area_frac = _polygon_area(q) / float(h * w)
    if area_frac < 0.08:
        return 0.0, edge, contrast
    score = 0.35 * edge + 0.5 * contrast + 0.15 * shape
    return float(score), edge, contrast


def _quads_from_contours(mask: np.ndarray, min_area: float) -> list[np.ndarray]:
    cv2 = _cv2()
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    out: list[np.ndarray] = []
    for cnt in sorted(contours, key=cv2.contourArea, reverse=True)[:4]:
        if cv2.contourArea(cnt) < min_area:
            continue
        peri = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.02 * peri, True)
        if len(approx) == 4:
            out.append(order_corners(approx.reshape(4, 2).astype(np.float64)))
        rect = cv2.boxPoints(cv2.minAreaRect(cnt))
        out.append(order_corners(rect.astype(np.float64)))
    return out


def _hough_quads(gray: np.ndarray) -> list[np.ndarray]:
    """Quadrilaterals from the outermost near-horizontal and near-vertical lines."""
    cv2 = _cv2()
    h, w = gray.shape
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    v = float(np.median(blur))
    edges = cv2.Canny(blur, max(0.0, 0.66 * v), min(255.0, 1.33 * v))
    m = min(h, w)
    segs = cv2.HoughLinesP(
        edges,
        1,
        math.pi / 720,
        threshold=max(30, int(0.12 * m)),
        minLineLength=int(0.3 * m),
        maxLineGap=int(0.02 * m),
    )
    if segs is None:
        return []
    horiz: list[tuple[float, np.ndarray]] = []
    vert: list[tuple[float, np.ndarray]] = []
    for seg in segs.reshape(-1, 4):
        x1, y1, x2, y2 = (float(t) for t in seg)
        length = math.hypot(x2 - x1, y2 - y1)
        ang = math.degrees(math.atan2(y2 - y1, x2 - x1)) % 180.0
        line = np.array([x1, y1, x2, y2])
        if ang < 35 or ang > 145:
            horiz.append((length, line))
        elif 55 < ang < 125:
            vert.append((length, line))
    if len(horiz) < 2 or len(vert) < 2:
        return []

    def pick(
        lines: list[tuple[float, np.ndarray]], key: int, split: float
    ) -> tuple[list[np.ndarray], list[np.ndarray]]:
        lo = [
            ln
            for _, ln in sorted(lines, key=lambda t: -t[0])
            if (ln[key] + ln[key + 2]) / 2 < split
        ]
        hi = [
            ln
            for _, ln in sorted(lines, key=lambda t: -t[0])
            if (ln[key] + ln[key + 2]) / 2 >= split
        ]
        return lo[:4], hi[:4]

    tops, bottoms = pick(horiz, 1, h / 2)
    lefts, rights = pick(vert, 0, w / 2)

    def inter(a: np.ndarray, b: np.ndarray) -> np.ndarray | None:
        x1, y1, x2, y2 = a
        x3, y3, x4, y4 = b
        den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
        if abs(den) < 1e-9:
            return None
        px = ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / den
        py = ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / den
        return np.array([px, py])

    out: list[np.ndarray] = []
    for t in tops:
        for b in bottoms:
            for lf in lefts:
                for rt in rights:
                    pts = [inter(t, lf), inter(t, rt), inter(b, rt), inter(b, lf)]
                    if any(p is None for p in pts):
                        continue
                    out.append(np.asarray(pts, np.float64))
    return out


def _dark_border(gray: np.ndarray, paper: float) -> bool:
    h, w = gray.shape
    mh, mw = max(2, int(h * 0.02)), max(2, int(w * 0.02))
    ring = np.concatenate(
        [
            gray[:mh, :].ravel(),
            gray[-mh:, :].ravel(),
            gray[:, :mw].ravel(),
            gray[:, -mw:].ravel(),
        ]
    )
    return float(np.median(ring)) < paper - 60


def detect_page_quad(img: np.ndarray) -> PageQuad:
    """The four corners of the sheet in ``img``, with a confidence.

    Candidates: (a) the largest bright region (Otsu threshold, text holes closed) and (b) the
    lines of a Canny + Hough pass joined into quadrilaterals. Each candidate is scored by the
    edge strength along its sides, the contrast between the inside and the outside band, and how
    close its corners are to right angles. The best one wins. Confidence is lowered when the
    runner-up is almost as good (ambiguous), when the contrast is weak, and when the sheet is
    very small. Work is done on an image of at most 1200 px and the corners are mapped back.

    Failure modes (low confidence or wrong corners): paper and background of similar colour;
    a sheet that is cut by the image edge; a finger across a corner; a curled or folded sheet;
    text or a picture frame with straight lines as strong as the sheet's edges.
    Time: about 0.2 s on a 1200 px working image."""
    cv2 = _cv2()
    gray_full = to_gray(img)
    gray, (sx, sy) = _fit(gray_full, 1200)
    gh, gw = gray.shape
    blur = cv2.GaussianBlur(gray, (5, 5), 0)
    _, bright = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    paper_level = float(np.percentile(blur[bright > 0], 50)) if bright.any() else 200.0
    k = max(3, min(gh, gw) // 30) | 1
    close_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (k, k))
    closed = cv2.morphologyEx(bright, cv2.MORPH_CLOSE, close_kernel)
    closed = cv2.morphologyEx(closed, cv2.MORPH_OPEN, close_kernel)
    threshold_quads = _quads_from_contours(closed, 0.05 * gh * gw)
    grad_x = cv2.Sobel(blur, cv2.CV_32F, 1, 0, ksize=3)
    grad_y = cv2.Sobel(blur, cv2.CV_32F, 0, 1, ksize=3)
    grad = np.hypot(grad_x, grad_y)
    # a side may be a pixel or two off the ridge: edge support uses the local maximum
    grad = cv2.dilate(grad, np.ones((5, 5), np.uint8))
    grad_thr = float(np.percentile(grad, 97)) * 0.5 + 1e-6
    line_quads = _hough_quads(gray)
    candidates: list[tuple[np.ndarray, str]] = []
    for q in threshold_quads:
        candidates.append((q, "threshold"))
    for q in line_quads:
        candidates.append((q, "lines"))
    scored: list[tuple[float, float, float, np.ndarray, str]] = []
    for q, source in candidates:
        if not _quad_is_plausible(q, gw, gh):
            continue
        score, edge, contrast = _score_quad(blur.astype(np.float32), grad, grad_thr, q)
        scored.append((score, edge, contrast, q, source))
    if not scored:
        return PageQuad(
            corners=_full_frame(img),
            confidence=0.0,
            method="photo-none",
            score=0.0,
        )
    scored.sort(key=lambda t: -t[0])
    best_score, _, best_contrast, best_q, best_source = scored[0]
    confidence = float(np.clip((best_score - 0.5) / 0.45, 0.0, 1.0))
    # ambiguity: a clearly different quadrilateral with almost the same score
    for score, _, _, q, _ in scored[1:]:
        if float(np.abs(q - best_q).max()) > 0.03 * max(gw, gh) and score >= 0.92 * best_score:
            confidence *= 0.75
            break
    if best_contrast < 0.25:
        confidence *= 0.6
    corners = best_q * np.array([sx, sy])
    covers = _polygon_area(best_q) / float(gh * gw)
    scanner = covers > 0.6 and _dark_border(gray, paper_level)
    family = "scanner" if scanner else "photo"
    return PageQuad(
        corners=corners,
        confidence=round(confidence, 3),
        method=f"{family}-{best_source}",
        score=round(float(best_score), 3),
    )


def _full_frame(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    return np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], np.float64)


def crop_rect(img: np.ndarray, corners: np.ndarray) -> np.ndarray | None:
    """Plain pixel crop when the corners form an axis-aligned rectangle (within 1 px); else None.
    Keeps the pixels as they are (no resampling)."""
    c = order_corners(corners)
    xs = np.sort(c[:, 0])
    ys = np.sort(c[:, 1])
    tl, tr, br, bl = c
    aligned = (
        abs(tl[1] - tr[1]) <= 1
        and abs(bl[1] - br[1]) <= 1
        and abs(tl[0] - bl[0]) <= 1
        and abs(tr[0] - br[0]) <= 1
    )
    if not aligned:
        return None
    x0, x1 = round(xs[0]), round(xs[-1])
    y0, y1 = round(ys[0]), round(ys[-1])
    h, w = img.shape[:2]
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(w, x1), min(h, y1)
    if x1 <= x0 or y1 <= y0:
        return None
    return img[y0:y1, x0:x1].copy()


# -- split spread (L6) -----------------------------------------------------------------------


class SplitResult(TypedDict):
    split_x: int
    confidence: float
    left: np.ndarray
    right: np.ndarray


def _gauss1d(v: np.ndarray, sigma: float) -> np.ndarray:
    cv2 = _cv2()
    return np.asarray(cv2.GaussianBlur(v.reshape(1, -1).astype(np.float32), (0, 0), sigma).ravel())


def split_spread(img: np.ndarray, *, x: float | None = None) -> SplitResult:
    """Split a two-page spread at its gutter.

    Auto: the gutter is the column, in the middle 40 % of the width, with the lowest paper level
    (the shadow of the binding) and no ink. Confidence is the depth of that valley relative to the
    paper level; a flat spread without a shadow gets a low confidence. Manual: ``x`` is the split
    as a fraction of the width (0 < x < 1), confidence 1.
    Failure modes: a spread without a visible shadow (the valley is then a margin), an unequal
    split (a page of another size), a black background, a cover photo."""
    _, w = img.shape[:2]
    if x is not None:
        sx = round(float(x) * w)
        confidence = 1.0
    else:
        gray = to_gray(img)
        small, (fx, _) = _fit(gray, 1000)
        sh, sw = small.shape
        rows = small[int(sh * 0.03) : int(sh * 0.97)].astype(np.float32)
        col = rows.mean(axis=0)
        paper = float(np.percentile(rows, 80))
        ink = (rows < paper - 60).mean(axis=0).astype(np.float32)
        sigma = max(2.0, sw * 0.01)
        col_s = _gauss1d(col, sigma)
        ink_s = _gauss1d(ink, sigma)
        score = col_s + 300.0 * ink_s
        lo, hi = int(sw * 0.3), int(sw * 0.7)
        idx = lo + int(np.argmin(score[lo:hi]))
        depth = paper - float(col_s[idx])
        confidence = float(np.clip(depth / 25.0, 0.0, 1.0))
        # a gutter has no ink: a column with text under it is not a gutter
        confidence *= float(np.clip(1.0 - float(ink_s[idx]) / 0.02, 0.0, 1.0))
        if idx - lo < 0.04 * sw or hi - idx < 0.04 * sw:
            confidence *= 0.5
        sx = round(idx * fx)
    sx = min(max(sx, 1), w - 1)
    return {
        "split_x": sx,
        "confidence": round(float(confidence), 3),
        "left": img[:, :sx].copy(),
        "right": img[:, sx:].copy(),
    }


# -- fingers, erase, stains (L10, L11, L14) ---------------------------------------------------


def find_skin_regions(img: np.ndarray) -> np.ndarray:
    """A mask (uint8 0/255, full size) of skin-coloured regions that touch the image border.

    Skin = YCrCb (Cr 133..173, Cb 77..127) and HSV (hue <= 25 of 180, 40 <= S <= 200, V 60..250),
    cleaned with a small opening, components smaller than 0.05 % of the image dropped, the rest
    dilated by about 1 % of the short side (the shadow around a finger). Only regions touching
    the border are kept: a finger sits on the edge of the page, a face in a photo does not.
    Failure modes: a yellowed or brown paper or desk that touches the border (proposed wrongly;
    the user corrects the mask), skin-coloured clothing at the border, a finger that does not
    reach the border (not proposed)."""
    if img.ndim == 2:  # a grey page has no skin colour
        return np.zeros(img.shape, np.uint8)
    cv2 = _cv2()
    small, _ = _fit(img, 1200)
    sh, sw = small.shape[:2]
    ycc = cv2.cvtColor(small, cv2.COLOR_RGB2YCrCb)
    hsv = cv2.cvtColor(small, cv2.COLOR_RGB2HSV)
    cr, cb = ycc[:, :, 1], ycc[:, :, 2]
    hue, sat, val = hsv[:, :, 0], hsv[:, :, 1], hsv[:, :, 2]
    skin = (
        (cr >= 133)
        & (cr <= 173)
        & (cb >= 77)
        & (cb <= 127)
        & (hue <= 25)
        & (sat >= 40)
        & (sat <= 200)
        & (val >= 60)
        & (val <= 250)
    )
    mask = skin.astype(np.uint8) * 255
    open_k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, open_k)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    keep = np.zeros(n, bool)
    min_area = 0.0005 * sh * sw
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        touches = x == 0 or y == 0 or x + bw >= sw or y + bh >= sh
        if touches and area >= min_area:
            keep[i] = True
    selected = keep[labels].astype(np.uint8) * 255
    radius = max(1, round(0.012 * min(sh, sw)))
    dil = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1, 2 * radius + 1))
    grown = cv2.dilate(selected, dil)
    # the shadow ring may grow over paper, not over dark ink (text under the finger's edge)
    gray_small = to_gray(small)
    ink_level = 0.5 * float(np.percentile(gray_small, 80))
    selected = np.where((grown > 0) & (gray_small >= ink_level) | (selected > 0), 255, 0).astype(
        np.uint8
    )
    h, w = img.shape[:2]
    if (sh, sw) != (h, w):
        selected = cv2.resize(selected, (w, h), interpolation=cv2.INTER_NEAREST)
    return np.asarray(selected)


def _ring(mask: np.ndarray, width: int) -> np.ndarray:
    cv2 = _cv2()
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * width + 1, 2 * width + 1))
    grown = cv2.dilate(mask, k)
    return np.asarray((grown > 0) & ~(mask > 0))


def _paper_pixels(img: np.ndarray, ring: np.ndarray) -> np.ndarray:
    gray = to_gray(img)
    vals = gray[ring]
    if vals.size == 0:
        return np.zeros((0,), np.int64)
    thr = np.percentile(vals, 60)
    return np.flatnonzero(ring & (gray >= thr))


def paper_fill(img: np.ndarray, rect: tuple[int, int, int, int]) -> tuple[int, int, int]:
    """The paper colour around a rectangle (x0, y0, x1, y1): median of the light pixels in a
    ring of about 6 px around it."""
    h, w = img.shape[:2]
    x0, y0, x1, y1 = rect
    mask = np.zeros((h, w), np.uint8)
    mask[max(0, y0) : min(h, y1), max(0, x0) : min(w, x1)] = 255
    return _ring_colour(img, mask)


def _ring_colour(img: np.ndarray, mask: np.ndarray) -> tuple[int, int, int]:
    ring = _ring(mask, max(4, int(0.02 * min(img.shape[:2]))))
    if not ring.any():
        ring = np.ones(mask.shape, bool) & ~(mask > 0)
    idx = _paper_pixels(img, ring)
    if idx.size == 0:
        return (255, 255, 255)
    flat = img.reshape(img.shape[0] * img.shape[1], -1)[idx]
    med = np.median(flat, axis=0)
    if img.ndim == 2:
        v = int(med[0])
        return (v, v, v)
    return (int(med[0]), int(med[1]), int(med[2]))


def _grain_sigma(img: np.ndarray, mask: np.ndarray) -> float:
    ring = _ring(mask, max(4, int(0.02 * min(img.shape[:2]))))
    gray = to_gray(img).astype(np.float32)
    idx = _paper_pixels(img, ring)
    if idx.size < 16:
        return 0.0
    vals = gray.ravel()[idx]
    return float(min(6.0, np.std(vals)))


def _fill_mask(img: np.ndarray, mask: np.ndarray, fill: FillSpec, seed: int = 0) -> np.ndarray:
    """Fill the mask with the paper colour (plus grain) or a colour. Small specs next to dark ink
    are inpainted (Telea) so that a letter under a finger's edge is not cut by a flat patch."""
    cv2 = _cv2()
    out = img.copy()
    colour = _parse_fill(fill)
    if colour is None:
        colour = _ring_colour(img, mask)
        sigma = _grain_sigma(img, mask)
        rng = np.random.default_rng(seed)
    else:
        sigma = 0.0
        rng = None
    binary = (mask > 0).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
    near_ink = np.zeros(n, bool)
    gray = to_gray(img)
    thr = np.percentile(gray[_ring(binary, 4)], 30) if _ring(binary, 4).any() else 0
    for i in range(1, n):
        comp = labels == i
        ring = _ring(comp.astype(np.uint8), 4)
        if (
            stats[i, cv2.CC_STAT_AREA] < 2000
            and ring.any()
            and (gray[ring] < thr - 60).mean() > 0.08
        ):
            near_ink[i] = True
    inpaint_mask = near_ink[labels].astype(np.uint8) * 255
    flat_mask = (binary > 0) & ~(inpaint_mask > 0)
    if inpaint_mask.any():
        out = cv2.inpaint(out, inpaint_mask, 4, cv2.INPAINT_TELEA)
    if flat_mask.any():
        count = int(flat_mask.sum())
        if rng is not None and sigma > 0:
            noise = rng.normal(0.0, sigma, (count, 1))
        else:
            noise = np.zeros((count, 1))
        base = np.array(colour, np.float64)[None, :]
        values = base[:, :1] + noise if img.ndim == 2 else base + noise
        out[flat_mask] = (
            np.clip(np.round(values), 0, 255).astype(np.uint8).reshape(out[flat_mask].shape)
        )
    return out


def erase_region(
    img: np.ndarray,
    region: tuple[int, int, int, int] | np.ndarray,
    *,
    fill: FillSpec = "paper",
) -> np.ndarray:
    """Erase inside a rectangle (x0, y0, x1, y1) or a mask (uint8, non-zero = erase) and fill it
    with the paper colour (default) or a colour. Failure mode: a rectangle over a photo or a
    picture fills with a flat colour (the picture is not reconstructed)."""
    if isinstance(region, np.ndarray):
        mask = (region > 0).astype(np.uint8) * 255
    else:
        h, w = img.shape[:2]
        x0, y0, x1, y1 = region
        mask = np.zeros((h, w), np.uint8)
        mask[max(0, y0) : min(h, y1), max(0, x0) : min(w, x1)] = 255
    if not mask.any():
        return img.copy()
    return _fill_mask(img, mask, fill)


def remove_fingers(
    img: np.ndarray,
    mask: np.ndarray | None = None,
    *,
    fill: FillSpec = "paper",
) -> tuple[np.ndarray, np.ndarray]:
    """Erase finger regions. Without ``mask`` the proposal of ``find_skin_regions`` is used.
    Returns (image, mask used): the mask is always returned so the caller can show and edit it.
    Failure mode: whatever is under the finger is lost; see ``find_skin_regions``."""
    used = find_skin_regions(img) if mask is None else (np.asarray(mask) > 0).astype(np.uint8) * 255
    if used.shape != img.shape[:2]:
        raise ValueError("mask size does not match the image")
    if not used.any():
        return img.copy(), used
    return _fill_mask(img, used, fill), used


def remove_color_stains(
    img: np.ndarray,
    *,
    hue_range: tuple[float, float],
    min_saturation: float = 0.4,
    fill: FillSpec = "paper",
) -> tuple[np.ndarray, np.ndarray]:
    """Erase pixels of one ink colour (ballpoint blue, highlighter yellow, a red stamp).

    ``hue_range`` in degrees (0..360); a range with start > end wraps around red. Only saturated
    pixels (saturation >= ``min_saturation``, 0..1) count, so black and grey text is kept. The
    mask is grown by one pixel to take the anti-aliased edge. Returns (image, mask).
    Failure modes: a coloured picture in the page, paper with a strong tint (a yellowed scan with
    a yellow highlighter), a stain that overlaps black text (the text under it is lost)."""
    if img.ndim == 2:  # a grey page has no ink colour
        return img.copy(), np.zeros(img.shape, np.uint8)
    cv2 = _cv2()
    hsv = cv2.cvtColor(img, cv2.COLOR_RGB2HSV)
    h_deg = hsv[:, :, 0].astype(np.float32) * 2.0
    lo, hi = float(hue_range[0]), float(hue_range[1])
    in_hue = (h_deg >= lo) & (h_deg <= hi) if lo <= hi else (h_deg >= lo) | (h_deg <= hi)
    sat = hsv[:, :, 1].astype(np.float32) / 255.0
    mask = (in_hue & (sat >= min_saturation)).astype(np.uint8) * 255
    mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    if not mask.any():
        return img.copy(), mask
    return _fill_mask(img, mask, fill), mask


__all__ = [
    "A_RATIO",
    "PageQuad",
    "SplitResult",
    "adjust_levels",
    "crop_rect",
    "curves",
    "denoise",
    "deskew",
    "detect_page_quad",
    "detect_paper_size",
    "erase_region",
    "find_skin_regions",
    "invert",
    "order_corners",
    "paper_colour",
    "paper_fill",
    "remove_color_stains",
    "remove_fingers",
    "rotate",
    "set_dpi",
    "split_spread",
    "to_gray",
    "tone",
    "warp_perspective",
    "whiten_background",
]
