"""v0.8 page-image functions (imaging/pageimg.py, imaging/pagequad.py) on synthetic images."""

from __future__ import annotations

import time

import cv2
import numpy as np
import pytest
from pageimg_support import (
    photo_scene,
    project_quad,
    quad_error,
    rotate_ccw,
    scanner_page,
    text_page,
)

from chef_core.imaging import pageimg as pi
from chef_core.imaging.pageimg import PageQuad, detect_page_quad


def _gray(rgb: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)


# -- deskew ---------------------------------------------------------------------------------


@pytest.mark.parametrize("skew", [-6.0, -2.5, 0.7, 3.0, 9.0])
def test_deskew_recovers_known_angle(skew: float) -> None:
    page = rotate_ccw(text_page(1240, 1754, seed=4), skew)
    _, angle, confidence = pi.deskew(page)
    assert abs(angle - skew) < 0.3
    assert confidence > 0.5


def test_deskew_corrects_the_page_so_a_second_pass_finds_nothing() -> None:
    page = rotate_ccw(text_page(1240, 1754, seed=5), 4.0)
    fixed, _, _ = pi.deskew(page)
    _, again, _ = pi.deskew(fixed)
    assert abs(again) < 0.3


def test_deskew_blank_page_has_no_angle_and_no_confidence() -> None:
    blank = np.full((800, 600, 3), 250, np.uint8)
    _, angle, confidence = pi.deskew(blank)
    assert angle == 0.0
    assert confidence == 0.0


def _curved_text_page(curvature: float = 28.0) -> np.ndarray:
    """Synthetic page with text strokes following one shared cylindrical curve."""
    page = np.full((900, 700, 3), 248, np.uint8)
    for row, base_y in enumerate(range(120, 790, 82)):
        for x in range(75, 630, 12):
            xn = (x - 350) / 350
            y = int(base_y + curvature * xn * xn)
            cv2.rectangle(page, (x, y + (row % 2) * 2), (x + 7, y + 5), (30, 30, 30), -1)
    return page


def test_dewarp_flattens_shared_curvature_across_text_lines() -> None:
    page = _curved_text_page()
    flattened, confidence, correction = pi.dewarp(page)

    assert flattened.shape == page.shape
    assert confidence > 0.35
    assert correction > 8
    # The output should reduce the vertical drift of the line strokes across page width.
    before = _curvature_span(page)
    after = _curvature_span(flattened)
    assert after < before * 0.6


def _curvature_span(page: np.ndarray) -> float:
    gray = _gray(page)
    spans = []
    for y0 in range(110, 790, 82):
        centers = []
        for x0 in range(90, 610, 65):
            roi = gray[y0 - 35 : y0 + 55, x0 : x0 + 50]
            ys, _ = np.where(roi < 100)
            if len(ys):
                centers.append(float(np.median(ys)) + y0 - 35)
        if len(centers) >= 6:
            spans.append(max(centers) - min(centers))
    return float(np.median(spans))


def test_dewarp_leaves_blank_and_short_text_pages_unchanged() -> None:
    blank = np.full((600, 500, 3), 250, np.uint8)
    result, confidence, correction = pi.dewarp(blank)
    assert np.array_equal(result, blank)
    assert confidence == correction == 0.0

    short = np.full((600, 500, 3), 250, np.uint8)
    cv2.putText(short, "Short", (40, 300), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 0), 2)
    result, confidence, correction = pi.dewarp(short)
    assert np.array_equal(result, short)
    assert confidence == correction == 0.0


def test_rotate_keeps_size_and_fills_with_paper() -> None:
    img = np.zeros((300, 400, 3), np.uint8)
    out = pi.rotate(img, 3.0, fill=(250, 250, 250))
    assert out.shape == img.shape
    assert tuple(out[0, 0]) == (250, 250, 250)


# -- whiten, denoise, levels, curves, invert, dpi ------------------------------------------


def test_whiten_removes_the_shadow_from_the_paper() -> None:
    page = text_page(1200, 900, seed=2).astype(np.float32)
    shadow = 1 - 0.45 * np.linspace(0, 1, 1200, dtype=np.float32)[None, :, None]
    shaded = np.clip(page * shadow, 0, 255).astype(np.uint8)
    gray_before = _gray(shaded)
    paper = gray_before > 150  # the sheet, text excluded
    out = pi.whiten_background(shaded, 1.0)
    gray_after = _gray(out)
    assert float(np.std(gray_after[paper])) < 0.5 * float(np.std(gray_before[paper]))
    assert float(np.median(gray_after[paper])) > 235


def test_whiten_strength_zero_is_identity() -> None:
    img = text_page(300, 400, seed=2)
    assert np.array_equal(pi.whiten_background(img, 0.0), img)


def test_denoise_reduces_speckle() -> None:
    rng = np.random.default_rng(3)
    base = text_page(600, 800, seed=3)
    noisy = base.copy()
    mask = rng.random((800, 600)) < 0.01
    noisy[mask] = 0
    out = pi.denoise(noisy, 0.8)
    paper = _gray(base) >= 200  # speck positions are paper, not ink
    before = int(((_gray(noisy) < 60) & paper).sum())
    after = int(((_gray(out) < 60) & paper).sum())
    assert after < 0.3 * before


def test_levels_maps_black_and_white_points() -> None:
    img = np.array([[[0, 0, 0], [50, 50, 50], [200, 200, 200], [255, 255, 255]]], np.uint8)
    out = pi.adjust_levels(img, black=50, white=200, gamma=1.0)
    assert out[0, 0, 0] == 0 and out[0, 1, 0] == 0
    assert out[0, 2, 0] == 255 and out[0, 3, 0] == 255
    gamma = pi.adjust_levels(np.full((2, 2, 3), 64, np.uint8), 0, 255, 2.0)
    assert abs(int(gamma[0, 0, 0]) - 128) <= 1


def test_curves_maps_points_linearly_between_anchors() -> None:
    img = np.array([[0, 64, 128, 255]], np.uint8)
    out = pi.curves(img, [(0, 0), (128, 200), (255, 255)])
    assert out[0, 0] == 0
    assert abs(int(out[0, 2]) - 200) <= 1
    assert out[0, 3] == 255


def test_invert_and_set_dpi() -> None:
    img = np.full((10, 20, 3), 30, np.uint8)
    assert int(pi.invert(img)[0, 0, 0]) == 225
    resized = pi.set_dpi(np.zeros((300, 200, 3), np.uint8), 300, current_dpi=300)
    assert resized.shape == (300, 200, 3)
    down = pi.set_dpi(np.zeros((300, 200, 3), np.uint8), 150, current_dpi=300)
    assert down.shape == (150, 100, 3)


# -- page quad ------------------------------------------------------------------------------

SCANNER_TOL = 0.005
PHOTO_TOL = 0.015


def test_scanner_page_quad_is_found_with_high_confidence() -> None:
    scene = scanner_page(shift=(6, -4), lid_shadow=0.12)
    found = detect_page_quad(scene.rgb)
    assert isinstance(found, PageQuad)
    assert found.method.startswith("scanner")
    assert quad_error(found.corners, scene.quad, scene.rgb.shape[1::-1]) < SCANNER_TOL
    assert found.confidence >= 0.6


@pytest.mark.parametrize(
    "kwargs",
    [
        {"background": "plain"},
        {"background": "plain", "shadow": 0.35},
        {"background": "texture"},
        {"background": "dark", "shadow": 0.2},
        {"pitch": 18, "yaw": -12},
        {"pitch": -22, "yaw": 14},
    ],
    ids=["plain", "shadowed", "texture", "dark-bg", "perspective-18", "perspective-22"],
)
def test_photo_quad_corners_within_tolerance(kwargs: dict[str, object]) -> None:
    size = (1600, 1200)
    kw = dict(kwargs)
    if "pitch" in kw:
        kw["quad"] = project_quad(
            size[0],
            size[1],
            rect_w=210 / 297,
            pitch=float(kw.pop("pitch")),  # type: ignore[arg-type]
            yaw=float(kw.pop("yaw")),  # type: ignore[arg-type]
        )
    scene = photo_scene(size=size, **kw)  # type: ignore[arg-type]
    found = detect_page_quad(scene.rgb)
    assert quad_error(found.corners, scene.quad, size) < PHOTO_TOL
    assert found.confidence >= 0.6
    assert found.method.startswith("photo")


def test_photo_quad_with_a_finger_on_the_edge_stays_accurate() -> None:
    scene = photo_scene(size=(1600, 1200), skin_blob=True)
    found = detect_page_quad(scene.rgb)
    assert quad_error(found.corners, scene.quad, (1600, 1200)) < 0.03


def test_low_contrast_page_is_flagged_with_low_confidence() -> None:
    scene = photo_scene(
        size=(1600, 1200),
        background="plain",
        bg_colour=(192, 190, 182),
        paper_colour=(199, 197, 189),
        noise=1.0,
    )
    found = detect_page_quad(scene.rgb)
    assert found.confidence < 0.5


def test_detect_page_quad_is_fast_on_a_12_megapixel_photo() -> None:
    scene = photo_scene(size=(4000, 3000), seed=9)
    started = time.perf_counter()
    found = detect_page_quad(scene.rgb)
    elapsed = time.perf_counter() - started
    assert elapsed < 2.5
    assert quad_error(found.corners, scene.quad, (4000, 3000)) < PHOTO_TOL


def test_warp_gives_a_rectangle_with_horizontal_text_lines() -> None:
    scene = photo_scene(size=(1600, 1200), seed=11)
    found = detect_page_quad(scene.rgb)
    out = pi.warp_perspective(scene.rgb, found.corners)
    h, w = out.shape[:2]
    assert abs(w / h - 210 / 297) < 0.03  # portrait A4
    _, angle, _ = pi.deskew(out)
    assert abs(angle) < 0.3


def test_detect_paper_size() -> None:
    assert pi.detect_paper_size(2480, 3508, 300) == "A4"
    assert pi.detect_paper_size(1748, 2480, 300) == "A5"
    assert pi.detect_paper_size(2550, 3300, 300) == "Letter"
    assert pi.detect_paper_size(1000, 1000, 300) is None
    assert pi.detect_paper_size(2480, 3508, None) == "A4"


def test_warp_snaps_to_a4_when_the_quad_is_a4() -> None:
    corners = np.array([[10, 10], [1000, 12], [1004, 1420], [8, 1418]], np.float64)
    out = pi.warp_perspective(np.zeros((1500, 1100, 3), np.uint8), corners)
    h, w = out.shape[:2]
    assert abs(h / w - 297 / 210) < 0.01  # snapped to the A4 ratio


# -- split spread ---------------------------------------------------------------------------


def _spread(gutter_depth: float) -> np.ndarray:
    left = text_page(1000, 1400, seed=21)
    right = text_page(1000, 1400, seed=22)
    spread = np.concatenate([left, right], axis=1).astype(np.float32)
    w = spread.shape[1]
    x = np.arange(w, dtype=np.float32)
    valley = np.exp(-((x - w / 2) ** 2) / (2 * (w * 0.035) ** 2))
    spread *= (1 - gutter_depth / 255.0 * valley)[None, :, None]

    return np.clip(spread, 0, 255).astype(np.uint8)


def test_split_spread_finds_the_gutter_within_two_percent() -> None:
    spread = _spread(gutter_depth=60)
    result = pi.split_spread(spread)
    w = spread.shape[1]
    assert abs(result["split_x"] - w / 2) / w < 0.02
    assert result["confidence"] > 0.5
    assert result["left"].shape[1] + result["right"].shape[1] == w


def test_split_spread_with_a_deep_binding_shadow_is_still_found() -> None:
    # A book photographed open: the shadow takes ~35 % of the paper level, deeper than the
    # ink threshold of the old rule (paper - 60), which made the gutter column look like text.
    spread = _spread(gutter_depth=90)
    result = pi.split_spread(spread)
    w = spread.shape[1]
    assert abs(result["split_x"] - w / 2) / w < 0.02
    assert result["confidence"] > 0.5


def test_split_spread_manual_override() -> None:
    spread = _spread(gutter_depth=0)
    result = pi.split_spread(spread, x=0.45)
    assert result["split_x"] == round(0.45 * spread.shape[1])
    assert result["confidence"] == 1.0


def test_split_spread_without_a_gutter_is_low_confidence() -> None:
    flat = text_page(2000, 1400, seed=30)
    assert pi.split_spread(flat)["confidence"] < 0.5


# -- fingers and erasing ----------------------------------------------------------------------


def test_finger_mask_covers_the_skin_blob_and_avoids_text() -> None:
    scene = photo_scene(size=(1600, 1200), skin_blob=True, seed=5)
    assert scene.skin is not None
    mask = pi.find_skin_regions(scene.rgb)
    hit = (mask > 0) & scene.skin
    assert hit.sum() / scene.skin.sum() > 0.9
    dark = _gray(scene.rgb) < 90
    assert (dark & (mask > 0)).sum() < 0.01 * (mask > 0).sum() + 1


def test_skin_not_touching_the_border_is_not_proposed() -> None:
    img = np.full((600, 800, 3), (238, 236, 228), np.uint8)
    cv2.ellipse(img, (400, 300), (60, 40), 0, 0, 360, (224, 172, 140), -1)
    assert int((pi.find_skin_regions(img) > 0).sum()) == 0


def test_remove_fingers_fills_with_the_surrounding_colour() -> None:
    scene = photo_scene(size=(1600, 1200), skin_blob=True, seed=6)
    out, mask = pi.remove_fingers(scene.rgb, None, fill="paper")
    assert mask.shape == scene.rgb.shape[:2]
    ring = cv2.dilate(mask, np.ones((31, 31), np.uint8)) > 0
    ring &= mask == 0
    around = np.median(scene.rgb[ring].astype(float), axis=0)
    inside = out[mask > 0].astype(float).mean(axis=0)
    skin = np.array([224.0, 172.0, 140.0])
    assert np.abs(inside - around).sum() < np.abs(inside - skin).sum()
    assert np.abs(inside - skin).sum() > 60  # no skin colour left


def test_remove_fingers_uses_a_supplied_mask() -> None:
    img = text_page(400, 500, seed=8)
    mask = np.zeros((500, 400), np.uint8)
    mask[100:150, 100:150] = 255
    out, used = pi.remove_fingers(img, mask, fill="#ff0000")
    assert np.array_equal(used, mask)
    assert tuple(out[120, 120]) == (255, 0, 0)


def test_erase_region_paper_and_colour() -> None:
    img = np.full((200, 200, 3), 230, np.uint8)
    img[10:60, 10:60] = 40
    out = pi.erase_region(img, (10, 10, 60, 60), fill="paper")
    assert int(out[30, 30, 0]) > 200
    assert int(out[150, 150, 0]) == 230
    out2 = pi.erase_region(img, (10, 10, 60, 60), fill=(0, 0, 255))
    assert tuple(out2[30, 30]) == (0, 0, 255)


def test_paper_fill_reads_the_surrounding_paper() -> None:
    img = np.full((200, 200, 3), (230, 228, 220), np.uint8)
    img[80:120, 80:120] = 10
    colour = pi.paper_fill(img, (80, 80, 120, 120))
    assert all(abs(int(c) - v) < 6 for c, v in zip(colour, (230, 228, 220), strict=True))


def test_remove_color_stains_removes_a_blue_pen_line() -> None:
    img = text_page(600, 400, seed=12)
    cv2.line(img, (20, 200), (580, 210), (30, 60, 220), 6)
    out, mask = pi.remove_color_stains(img, hue_range=(200, 260), min_saturation=0.4, fill="paper")
    assert mask[205, 300] > 0
    assert int(out[205, 300, 2]) > 200  # the pen line is gone: paper again


# -- time budgets on A4 at 300 dpi -----------------------------------------------------------


@pytest.fixture(scope="module")
def a4_300() -> np.ndarray:
    return text_page(2480, 3508, seed=40)


@pytest.mark.parametrize(
    "name",
    ["deskew", "whiten", "denoise", "levels", "split", "fingers"],
)
def test_a4_300dpi_budget(a4_300: np.ndarray, name: str) -> None:
    runners = {
        "deskew": lambda: pi.deskew(a4_300),
        "whiten": lambda: pi.whiten_background(a4_300, 0.8),
        "denoise": lambda: pi.denoise(a4_300, 0.5),
        "levels": lambda: pi.adjust_levels(a4_300, 10, 240, 1.1),
        "split": lambda: pi.split_spread(a4_300),
        "fingers": lambda: pi.find_skin_regions(a4_300),
    }
    started = time.perf_counter()
    runners[name]()
    assert time.perf_counter() - started < 1.5


# -- grey pages (scans saved as gray) ---------------------------------------------------------


def test_grey_pages_are_supported_by_every_function() -> None:
    grey = np.ascontiguousarray(_gray(text_page(900, 1200, seed=5)))
    skewed = np.ascontiguousarray(_gray(rotate_ccw(text_page(900, 1200, seed=5), 3.0)))
    _, angle, _ = pi.deskew(skewed)
    assert abs(angle - 3.0) < 0.3
    assert pi.whiten_background(grey, 0.8).shape == grey.shape
    assert pi.denoise(grey, 0.6).shape == grey.shape
    assert pi.adjust_levels(grey, 10, 240, 1.2).shape == grey.shape
    assert pi.detect_page_quad(grey).corners.shape == (4, 2)
    assert pi.split_spread(grey)["split_x"] > 0
    assert int(pi.find_skin_regions(grey).sum()) == 0
    out, mask = pi.remove_fingers(grey)
    assert out.shape == grey.shape and not mask.any()
    erased = pi.erase_region(grey, (10, 10, 80, 80))
    assert erased.shape == grey.shape
    stains, none = pi.remove_color_stains(grey, hue_range=(0, 60))
    assert not none.any() and stains.shape == grey.shape

# -- v0.8 regressions found by Demo v0.8 (NOTES 2026-11-04) ------------------------------------


def test_quad_cut_by_the_image_edge_is_flagged_for_review() -> None:
    """(b) A sheet that runs past the frame has a side outside the image. The detector must not
    report it as a confident page (it used to report 0.68 with the wrong corners)."""
    size = (1600, 1200)
    quad = np.array([[-180, 120], [1200, 140], [1210, 1110], [-150, 1090]], np.float64)
    scene = photo_scene(size=size, quad=quad, background="plain", noise=1.0)
    found = detect_page_quad(scene.rgb)
    assert found.confidence < 0.6

_SHEET = np.array([[300, 120], [1300, 110], [1310, 1000], [290, 1010]], np.float64)
_SKIN = (224, 172, 140)


def _finger_over_the_bottom_edge(quad: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """A plain desk photo with a finger that starts on the sheet and runs past its bottom edge
    to the frame's bottom border (so it touches the border and is proposed)."""
    scene = photo_scene(size=size, quad=quad, background="plain", noise=0.0)
    img = scene.rgb.copy()
    cv2.ellipse(img, (800, 1000), (90, 220), 0, 0, 360, _SKIN, -1)
    return img


def _page_mask(quad: np.ndarray, shape: tuple[int, int]) -> np.ndarray:
    page = np.zeros(shape, np.uint8)
    cv2.fillConvexPoly(page, np.round(quad).astype(np.int32), 255)
    return page > 0


def test_finger_fill_stays_on_the_sheet_and_leaves_the_desk_alone() -> None:
    """(a) The paper colour used for a finger must not be painted on the desk outside the sheet,
    which made a white bulge outside the page."""
    img = _finger_over_the_bottom_edge(_SHEET, (1600, 1200))
    out, used = pi.remove_fingers(img, None, fill="paper")
    # the desk part of the finger may take the desk colour, but never the paper's; a 2 px band at
    # the nominal edge is the sheet's anti-aliased rim and is not judged
    page = _page_mask(_SHEET, used.shape)
    dist_outside = cv2.distanceTransform((~page).astype(np.uint8), cv2.DIST_L2, 3)
    desk = (used > 0) & ~page & (dist_outside > 2.0)
    assert desk.sum() > 500
    desk_px = out[desk].astype(np.float64)
    assert (np.abs(desk_px - np.array([238.0, 236.0, 228.0])).sum(axis=1) > 100).all()
    inside = (used > 0) & _page_mask(_SHEET, used.shape)
    assert inside.sum() > 500  # the finger on the sheet is still removed
    paper = np.array([238.0, 236.0, 228.0])
    assert np.abs(out[inside].astype(float).mean(axis=0) - paper).sum() < 60


