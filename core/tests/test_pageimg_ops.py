"""v0.8 page-image operations (ops/pageimg.py) on generated image PDFs: scans and photos."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import cv2
import numpy as np
import pikepdf
import pytest
from conftest import Harness, RpcFailure
from pageimg_support import (
    photo_scene,
    quad_error,
    rotate_ccw,
    scanner_page,
    text_page,
)
from pdf_media import image_dims, image_xobject, new_pdf, place, render, save
from PIL import Image

from chef_core.imaging import pageimg as pi
from chef_core.ops import load_builtin_ops
from chef_core.ops import pageimg as pageimg_ops
from chef_core.ops.base import registry

DPI = 150
A4_W, A4_H = 595.0, 842.0  # points: the page size of the generated image pages


def _image_pdf(path: Path, frames: list[np.ndarray], *, page_w_pt: float = A4_W) -> Path:
    """One page per frame, the frame drawn full-page as a JPEG (scan-like)."""
    pdf = pikepdf.new()
    for rgb in frames:
        h, w = rgb.shape[:2]
        page_h_pt = page_w_pt * h / w
        pdf.add_blank_page(page_size=(page_w_pt, page_h_pt))
        page = pdf.pages[-1]
        img = image_xobject(pdf, Image.fromarray(rgb), codec="dct", quality=92)
        place(pdf, page, [("Im1", img, 0.0, 0.0, page_w_pt, page_h_pt)])
    return save(pdf, path)


def _sid(harness: Harness, path: Path) -> str:
    return str(harness.open(path)["state"]["sessionId"])


def _revision(harness: Harness, sid: str) -> Path:
    return Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])


def _rgb(path: Path, index: int = 0, dpi: int = DPI) -> np.ndarray:
    return np.asarray(render(path, index, dpi=dpi).convert("RGB"))


def _pages(result: dict[str, Any]) -> dict[int, dict[str, Any]]:
    return {row["pageIndex"]: row for row in result["data"]["pages"]}


def _page_size(path: Path, index: int = 0) -> tuple[float, float]:
    with pikepdf.open(path) as pdf:
        x0, y0, x1, y1 = (float(v) for v in pdf.pages[index].mediabox)
        return x1 - x0, y1 - y0


def _page_count(path: Path) -> int:
    with pikepdf.open(path) as pdf:
        return len(pdf.pages)


def test_crop_preview_returns_corrected_image_without_changing_document(
    harness: Harness, tmp_path: Path
) -> None:
    src = _image_pdf(tmp_path / "crop-preview.pdf", [text_page(700, 900)])
    sid = _sid(harness, src)
    revision = _revision(harness, sid)
    before = revision.read_bytes()
    points = [
        {"x": 0.1, "y": 0.1},
        {"x": 0.9, "y": 0.15},
        {"x": 0.85, "y": 0.9},
        {"x": 0.15, "y": 0.85},
    ]
    result = harness.op("pageimg.cropPreview", {"pageIndex": 0, "corners": points}, sid)
    assert result["changedPages"] == []
    path = Path(result["data"]["imagePath"])
    with Image.open(path) as image:
        assert image.width > 10 and image.height > 10
        assert max(image.size) <= 1400
    assert _revision(harness, sid) == revision
    assert revision.read_bytes() == before
    sized = harness.op(
        "pageimg.cropPreview", {"pageIndex": 0, "corners": points, "outSize": [320, 480]}, sid
    )
    with Image.open(sized["data"]["imagePath"]) as image:
        assert image.size == (320, 480)
    with pytest.raises(RpcFailure):
        harness.op(
            "pageimg.cropPreview",
            {"pageIndex": 0, "corners": points, "outSize": [20_000, 20_000]},
            sid,
        )
    crossed = [points[0], points[2], points[1], points[3]]
    with pytest.raises(RpcFailure):
        harness.op("pageimg.cropPreview", {"pageIndex": 0, "corners": crossed}, sid)
    assert _revision(harness, sid) == revision


def test_crop_fine_rotation_changes_preview_and_output_without_changing_page_size(
    harness: Harness, tmp_path: Path
) -> None:
    src = _image_pdf(tmp_path / "fine-rotate.pdf", [text_page(700, 900)])
    sid = _sid(harness, src)
    corners = [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 1, "y": 1}, {"x": 0, "y": 1}]
    original_revision = _revision(harness, sid)
    base = harness.op("pageimg.cropPreview", {"pageIndex": 0, "corners": corners}, sid)
    rotated = harness.op(
        "pageimg.cropPreview", {"pageIndex": 0, "corners": corners, "angle": 2.5}, sid
    )
    a = np.asarray(Image.open(base["data"]["imagePath"]).convert("RGB"))
    b = np.asarray(Image.open(rotated["data"]["imagePath"]).convert("RGB"))
    assert a.shape == b.shape
    assert np.mean(np.abs(a.astype(float) - b.astype(float))) > 1
    assert _revision(harness, sid) == original_revision
    harness.op("pageimg.crop", {"pages": [{"pageIndex": 0, "corners": corners, "angle": 2.5}]}, sid)
    rotated_revision = _revision(harness, sid)
    assert rotated_revision != original_revision
    plain_sid = _sid(harness, src)
    harness.op("pageimg.crop", {"pages": [{"pageIndex": 0, "corners": corners}]}, plain_sid)
    plain_revision = _revision(harness, plain_sid)
    assert _page_size(rotated_revision) == _page_size(plain_revision)
    rotated_page = _rgb(rotated_revision)
    plain_page = _rgb(plain_revision)
    assert rotated_page.shape == plain_page.shape
    assert np.mean(np.abs(rotated_page.astype(float) - plain_page.astype(float))) > 1


def test_large_crop_preview_warps_only_bounded_aspect_preserving_size(
    harness: Harness, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = _image_pdf(tmp_path / "crop-preview-large.pdf", [text_page(700, 900)])
    sid = _sid(harness, src)
    points = [
        {"x": 0.1, "y": 0.1},
        {"x": 0.9, "y": 0.1},
        {"x": 0.9, "y": 0.9},
        {"x": 0.1, "y": 0.9},
    ]
    seen_sizes: list[list[int] | None] = []
    original_cut = pageimg_ops._cut

    def track_cut(rgb: np.ndarray, corners: np.ndarray, out_size: list[int] | None) -> np.ndarray:
        seen_sizes.append(out_size)
        return original_cut(rgb, corners, out_size)

    monkeypatch.setattr(pageimg_ops, "_cut", track_cut)
    result = harness.op(
        "pageimg.cropPreview",
        {"pageIndex": 0, "corners": points, "outSize": [5_000, 10_000]},
        sid,
    )
    assert seen_sizes == [[700, 1400]]
    assert max(seen_sizes[0] or []) <= 1400
    assert (seen_sizes[0] or [0, 0])[0] / (seen_sizes[0] or [1, 1])[1] == 0.5
    with Image.open(result["data"]["imagePath"]) as image:
        assert image.size == (700, 1400)


# -- registration -----------------------------------------------------------------------------


def test_page_image_ops_are_registered_with_the_right_flags() -> None:
    load_builtin_ops()
    reg = registry()
    for op in (
        "pageimg.deskew",
        "pageimg.dewarp",
        "pageimg.enhance",
        "pageimg.crop",
        "pageimg.autoCrop",
        "pageimg.splitSpread",
        "pageimg.removeFingers",
        "pageimg.erase",
        "pageimg.removeStains",
    ):
        assert reg[op].destructive, op
    for op in ("pageimg.detectQuad", "pageimg.proposeFingerMask"):
        assert not reg[op].destructive, op
    assert not reg["pageimg.dewarpPreview"].destructive


def _curved_text_page() -> np.ndarray:
    page = np.full((900, 700, 3), 248, np.uint8)
    for row, base_y in enumerate(range(120, 790, 82)):
        for x in range(75, 630, 12):
            xn = (x - 350) / 350
            y = int(base_y + 28 * xn * xn)
            cv2.rectangle(page, (x, y + (row % 2) * 2), (x + 7, y + 5), (30, 30, 30), -1)
    return page


def _stroke_curve_span(rgb: np.ndarray) -> float:
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
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


def test_dewarp_rpc_flattens_curved_page_and_skips_blank_page(
    harness: Harness, tmp_path: Path
) -> None:
    src = _image_pdf(
        tmp_path / "curved.pdf",
        [_curved_text_page(), np.full((900, 700, 3), 250, np.uint8)],
    )
    sid = _sid(harness, src)
    rows = _pages(harness.op("pageimg.dewarp", {}, sid))
    assert rows[0]["status"] == "done"
    assert rows[0]["confidence"] >= 0.35
    assert rows[0]["correctionPx"] > 8
    assert rows[1]["status"] == "review"
    assert rows[1]["reason"] == "LOW_CONFIDENCE"
    result = _rgb(_revision(harness, sid))
    result_small = np.asarray(Image.fromarray(result).resize((700, 900), Image.Resampling.LANCZOS))
    assert _stroke_curve_span(result_small) < _stroke_curve_span(_curved_text_page()) * 0.6


def test_dewarp_preview_is_rpc_read_only_and_returns_before_after_images(
    harness: Harness, tmp_path: Path
) -> None:
    src = _image_pdf(tmp_path / "preview.pdf", [_curved_text_page()])
    sid = _sid(harness, src)
    revision_before = _revision(harness, sid)
    result = harness.op("pageimg.dewarpPreview", {"pages": [0]}, sid)
    row = _pages(result)[0]
    assert result["changedPages"] == []
    assert row["status"] == "done"
    before = Path(row["originalPath"])
    after = Path(row["resultPath"])
    assert before.is_file() and after.is_file()
    assert Image.open(before).size == Image.open(after).size
    assert revision_before == _revision(harness, sid)
    assert (
        _stroke_curve_span(np.asarray(Image.open(after).convert("RGB")))
        < _stroke_curve_span(np.asarray(Image.open(before).convert("RGB"))) * 0.6
    )


# -- deskew (L1) ------------------------------------------------------------------------------


def test_deskew_op_straightens_rotated_scans(harness: Harness, tmp_path: Path) -> None:
    frames = [
        rotate_ccw(text_page(1240, 1754, seed=50), 4.0),
        rotate_ccw(text_page(1240, 1754, seed=51), -3.0),
    ]
    src = _image_pdf(tmp_path / "skew.pdf", frames)
    sid = _sid(harness, src)
    res = harness.op("pageimg.deskew", {"mode": "auto"}, sid)
    rows = _pages(res)
    assert rows[0]["status"] == "done" and abs(rows[0]["angle"] - 4.0) < 0.3
    assert rows[1]["status"] == "done" and abs(rows[1]["angle"] + 3.0) < 0.3
    out = _revision(harness, sid)
    for index in (0, 1):
        _, again, _ = pi.deskew(_rgb(out, index))
        assert abs(again) < 0.5


def test_deskew_works_on_grey_scans(harness: Harness, tmp_path: Path) -> None:
    grey = np.ascontiguousarray(
        cv2.cvtColor(rotate_ccw(text_page(1240, 1754, seed=53), -2.0), cv2.COLOR_RGB2GRAY)
    )
    src = _image_pdf(tmp_path / "grey.pdf", [np.dstack([grey] * 3)])
    sid = _sid(harness, src)
    rows = _pages(harness.op("pageimg.deskew", {"mode": "auto"}, sid))
    assert rows[0]["status"] == "done" and abs(rows[0]["angle"] + 2.0) < 0.3


def test_deskew_reports_a_blank_page_instead_of_changing_it(
    harness: Harness, tmp_path: Path
) -> None:
    src = _image_pdf(tmp_path / "blank.pdf", [np.full((1754, 1240, 3), 250, np.uint8)])
    sid = _sid(harness, src)
    rows = _pages(harness.op("pageimg.deskew", {"mode": "auto"}, sid))
    assert rows[0]["status"] == "review"
    assert rows[0]["reason"] == "LOW_CONFIDENCE"


def test_deskew_with_a_given_angle(harness: Harness, tmp_path: Path) -> None:
    src = _image_pdf(tmp_path / "manual.pdf", [rotate_ccw(text_page(1240, 1754, seed=52), 2.5)])
    sid = _sid(harness, src)
    rows = _pages(harness.op("pageimg.deskew", {"mode": "angle", "angle": 2.5}, sid))
    assert rows[0]["status"] == "done"
    _, again, _ = pi.deskew(_rgb(_revision(harness, sid)))
    assert abs(again) < 0.5


# -- enhance (L3, L4, L12) -------------------------------------------------------------------


def test_enhance_whitens_and_keeps_size_and_dpi(harness: Harness, tmp_path: Path) -> None:
    page = text_page(1240, 1754, seed=60).astype(np.float32)
    shade = 1 - 0.4 * np.linspace(0, 1, 1240, dtype=np.float32)[None, :, None]
    frame = np.clip(page * shade, 0, 255).astype(np.uint8)
    src = _image_pdf(tmp_path / "enh.pdf", [frame])
    before = _page_size(src)
    sid = _sid(harness, src)
    res = harness.op("pageimg.enhance", {"whiten": True, "whitenStrength": 1.0}, sid)
    assert _pages(res)[0]["status"] == "done"
    out = _revision(harness, sid)
    assert _page_size(out) == before
    assert image_dims(out)[0] == (1240, 1754)
    assert float(np.median(_rgb(out).mean(axis=2)[300:1400, 100:1100])) > 230


def test_enhance_dpi_resamples_pixels_and_keeps_the_page(harness: Harness, tmp_path: Path) -> None:
    src = _image_pdf(tmp_path / "dpi.pdf", [text_page(1240, 1754, seed=61)])
    sid = _sid(harness, src)
    before = _page_size(src)
    harness.op("pageimg.enhance", {"dpi": 75}, sid)
    out = _revision(harness, sid)
    assert _page_size(out) == before
    assert image_dims(out)[0] == (620, 877)


def test_enhance_resize_page_changes_the_page_size_to_the_dpi(
    harness: Harness, tmp_path: Path
) -> None:
    src = _image_pdf(tmp_path / "rp.pdf", [text_page(1200, 1600, seed=62)])
    sid = _sid(harness, src)
    harness.op("pageimg.enhance", {"dpi": 300, "resizePage": True}, sid)
    out = _revision(harness, sid)
    w, h = _page_size(out)
    assert abs(w - 1200 * 72 / 300) < 0.5 and abs(h - 1600 * 72 / 300) < 0.5
    assert image_dims(out)[0] == (1200, 1600)


def test_enhance_rejects_inverted_levels(harness: Harness, tmp_path: Path) -> None:
    src = _image_pdf(tmp_path / "lv.pdf", [text_page(400, 560, seed=63)])
    sid = _sid(harness, src)
    with pytest.raises(RpcFailure):
        harness.op("pageimg.enhance", {"levels": {"black": 200, "white": 100}}, sid)


# -- detectQuad (read-only) and crop (L2, L15-L17) ------------------------------------------


def test_quad_preview_returns_original_pixels_and_detected_corners_without_changing_revision(
    harness: Harness, tmp_path: Path
) -> None:
    source = _image_pdf(tmp_path / "preview.pdf", [scanner_page().rgb])
    sid = _sid(harness, source)
    revision = _revision(harness, sid)
    before = revision.read_bytes()
    result = harness.op("pageimg.quadPreview", {"pages": [0]}, sid)
    row = result["data"]["pages"][0]
    assert row["status"] == "done"
    assert len(row["cornersFraction"]) == 4
    assert Path(row["imagePath"]).is_file()
    assert _revision(harness, sid).read_bytes() == before


def test_detect_quad_is_read_only_and_finds_the_sheet(harness: Harness, tmp_path: Path) -> None:
    scene = photo_scene(size=(1240, 1754), seed=70, background="plain", shadow=0.2)
    src = _image_pdf(tmp_path / "quad.pdf", [scene.rgb])
    sid = _sid(harness, src)
    before = _revision(harness, sid).read_bytes()
    rows = _pages(harness.op("pageimg.detectQuad", {}, sid))
    assert _revision(harness, sid).read_bytes() == before
    row = rows[0]
    assert row["status"] == "done"
    assert quad_error(np.array(row["corners"]), scene.quad, (1240, 1754)) < 0.015
    assert len(row["cornersFraction"]) == 4
    assert row["paperSize"] in ("A4", "A5", None)


def test_crop_by_corners_gives_a_portrait_page_with_horizontal_text(
    harness: Harness, tmp_path: Path
) -> None:
    scene = photo_scene(size=(1240, 1754), seed=71)
    src = _image_pdf(tmp_path / "crop.pdf", [scene.rgb])
    sid = _sid(harness, src)
    rows = _pages(harness.op("pageimg.detectQuad", {}, sid))
    frac = rows[0]["cornersFraction"]
    harness.op(
        "pageimg.crop",
        {"pages": [{"pageIndex": 0, "corners": [{"x": x, "y": y} for x, y in frac]}]},
        sid,
    )
    out = _revision(harness, sid)
    w_pt, h_pt = _page_size(out)
    assert abs(w_pt / h_pt - 210 / 297) < 0.03  # the page follows the sheet
    _, angle, _ = pi.deskew(_rgb(out))
    assert abs(angle) < 0.3


def test_crop_refuses_a_crossed_quad_without_changing_the_document(
    harness: Harness, tmp_path: Path
) -> None:
    scene = photo_scene(size=(1240, 1754), seed=73)
    sid = _sid(harness, _image_pdf(tmp_path / "crossed.pdf", [scene.rgb]))
    before = _revision(harness, sid)
    points = [(0.1, 0.1), (0.9, 0.9), (0.9, 0.1), (0.1, 0.9)]
    crossed = [{"x": x, "y": y} for x, y in points]
    with pytest.raises(RpcFailure) as exc:
        harness.op("pageimg.crop", {"pages": [{"pageIndex": 0, "corners": crossed}]}, sid)
    assert exc.value.kind == "INVALID_PARAMS"
    assert _revision(harness, sid) == before


def test_crop_keep_page_size_fits_the_image_in_the_old_page(
    harness: Harness, tmp_path: Path
) -> None:
    scene = photo_scene(size=(1240, 1754), seed=72)
    src = _image_pdf(tmp_path / "keep.pdf", [scene.rgb])
    sid = _sid(harness, src)
    frac = _pages(harness.op("pageimg.detectQuad", {}, sid))[0]["cornersFraction"]
    harness.op(
        "pageimg.crop",
        {
            "keepPageSize": True,
            "pages": [{"pageIndex": 0, "corners": [{"x": x, "y": y} for x, y in frac]}],
        },
        sid,
    )
    w_pt, h_pt = _page_size(_revision(harness, sid))
    assert abs(w_pt - A4_W) < 0.5 and abs(h_pt - A4_H) < 0.5


def test_axis_aligned_crop_keeps_the_pixels(harness: Harness, tmp_path: Path) -> None:
    src = _image_pdf(tmp_path / "rect.pdf", [scanner_page().rgb])
    sid = _sid(harness, src)
    x0, y0, x1, y1 = 100, 120, 1100, 1600  # pixels of the 1240 x 1754 scan
    corners = [
        {"x": x0 / 1240, "y": y0 / 1754},
        {"x": x1 / 1240, "y": y0 / 1754},
        {"x": x1 / 1240, "y": y1 / 1754},
        {"x": x0 / 1240, "y": y1 / 1754},
    ]
    harness.op("pageimg.crop", {"pages": [{"pageIndex": 0, "corners": corners}]}, sid)
    assert image_dims(_revision(harness, sid))[0] == (x1 - x0, y1 - y0)


# -- autoCrop (L15, L18, L19) ---------------------------------------------------------------


def test_auto_crop_crops_confident_pages_and_flags_low_contrast(
    harness: Harness, tmp_path: Path
) -> None:
    scan = scanner_page(lid_shadow=0.1)
    good = photo_scene(size=(1240, 1754), seed=80, background="plain")
    weak = photo_scene(
        size=(1240, 1754),
        seed=81,
        background="plain",
        bg_colour=(192, 190, 182),
        paper_colour=(199, 197, 189),
        noise=1.0,
    )
    src = _image_pdf(tmp_path / "auto.pdf", [scan.rgb, good.rgb, weak.rgb])
    sid = _sid(harness, src)
    res = harness.op("pageimg.autoCrop", {"minConfidence": 0.6}, sid)
    rows = _pages(res)
    assert res["data"]["needsReview"] == [2]
    assert rows[2]["status"] == "review"
    assert rows[0]["status"] == "done" and rows[1]["status"] == "done"
    out = _revision(harness, sid)
    assert _page_count(out) == 3
    w0, h0 = _page_size(out, 0)
    assert w0 < A4_W * 0.99 or h0 < A4_H * 0.99  # the border was cut away


def test_workflow_surfaces_low_confidence_auto_crop_review(
    harness: Harness, tmp_path: Path
) -> None:
    weak = photo_scene(
        size=(1240, 1754),
        seed=81,
        background="plain",
        bg_colour=(192, 190, 182),
        paper_colour=(199, 197, 189),
        noise=1.0,
    )
    src = _image_pdf(tmp_path / "workflow-review.pdf", [weak.rgb])
    result = harness.op(
        "workflow.run",
        {
            "workflow": {
                "id": "review-crop",
                "name": "Review crop",
                "steps": [{"op": "pageimg.autoCrop", "params": {"minConfidence": 0.6}}],
            },
            "files": [{"path": str(src)}],
        },
    )["data"]["results"][0]
    warning = "Bước pageimg.autoCrop: cần duyệt thủ công trang 1."
    assert result["status"] == "done"
    assert result["stepResults"][0]["warnings"] == [warning]
    assert result["warnings"] == [warning]


@pytest.mark.parametrize(
    ("op", "frame"),
    [
        ("pageimg.splitSpread", text_page(1240, 1754, seed=97)),
        ("pageimg.dewarp", np.full((900, 700, 3), 250, np.uint8)),
    ],
)
def test_workflow_surfaces_review_status_rows(
    harness: Harness, tmp_path: Path, op: str, frame: np.ndarray
) -> None:
    src = _image_pdf(tmp_path / f"{op.rsplit('.', 1)[-1]}-review.pdf", [frame])
    result = harness.op(
        "workflow.run",
        {
            "workflow": {
                "id": "review-step",
                "name": "Review step",
                "steps": [{"op": op}],
            },
            "files": [{"path": str(src)}],
        },
    )["data"]["results"][0]
    warning = f"Bước {op}: cần duyệt thủ công trang 1."
    assert result["status"] == "done"
    assert result["stepResults"][0]["warnings"] == [warning]
    assert result["warnings"] == [warning]


def test_auto_crop_paper_size_sets_the_proportions(harness: Harness, tmp_path: Path) -> None:
    good = photo_scene(size=(1240, 1754), seed=82, background="plain")
    src = _image_pdf(tmp_path / "paper.pdf", [good.rgb])
    sid = _sid(harness, src)
    harness.op("pageimg.autoCrop", {"paperSize": "A4"}, sid)
    w_pt, h_pt = _page_size(_revision(harness, sid))
    assert abs(h_pt / w_pt - 297 / 210) < 0.03


# -- splitSpread (L6) -------------------------------------------------------------------------


def _spread_frame(seed: int, *, shadow: bool) -> np.ndarray:
    left = text_page(900, 1400, seed=seed)
    right = text_page(900, 1400, seed=seed + 1)
    left[120:420, 90:390] = (220, 30, 30)  # red marker: top-left of the left page
    right[120:420, 90:390] = (30, 30, 220)  # blue marker: top-left of the right page
    spread = np.concatenate([left, right], axis=1).astype(np.float32)
    if shadow:
        w = spread.shape[1]
        x = np.arange(w, dtype=np.float32)
        valley = np.exp(-((x - w / 2) ** 2) / (2 * (w * 0.035) ** 2))
        spread *= (1 - 60 / 255.0 * valley)[None, :, None]
    return np.clip(spread, 0, 255).astype(np.uint8)


def _is_red(rgb: np.ndarray) -> bool:
    r, b = rgb[..., 0].astype(int), rgb[..., 2].astype(int)
    return float(((r - b) > 40).mean()) > 0.02


def _is_blue(rgb: np.ndarray) -> bool:
    r, b = rgb[..., 0].astype(int), rgb[..., 2].astype(int)
    return float(((b - r) > 40).mean()) > 0.02


def test_split_spread_turns_two_pages_into_four_in_ltr_order(
    harness: Harness, tmp_path: Path
) -> None:
    src = _image_pdf(
        tmp_path / "ltr.pdf", [_spread_frame(90, shadow=False), _spread_frame(92, shadow=False)]
    )
    sid = _sid(harness, src)
    res = harness.op("pageimg.splitSpread", {"mode": "x", "x": 0.5, "order": "ltr"}, sid)
    assert res["changedPages"] == "all"
    out = _revision(harness, sid)
    assert _page_count(out) == 4
    pages = [_rgb(out, i, dpi=72) for i in range(4)]
    assert _is_red(pages[0]) and not _is_blue(pages[0])
    assert _is_blue(pages[1]) and not _is_red(pages[1])
    assert _is_red(pages[2]) and _is_blue(pages[3])


def test_split_spread_rtl_puts_the_right_half_first(harness: Harness, tmp_path: Path) -> None:
    src = _image_pdf(tmp_path / "rtl.pdf", [_spread_frame(94, shadow=False)])
    sid = _sid(harness, src)
    harness.op("pageimg.splitSpread", {"mode": "x", "x": 0.5, "order": "rtl"}, sid)
    out = _revision(harness, sid)
    assert _page_count(out) == 2
    assert _is_blue(_rgb(out, 0, dpi=72)) and _is_red(_rgb(out, 1, dpi=72))


def test_split_spread_auto_finds_the_shadow_gutter(harness: Harness, tmp_path: Path) -> None:
    src = _image_pdf(tmp_path / "auto_split.pdf", [_spread_frame(96, shadow=True)])
    sid = _sid(harness, src)
    res = harness.op("pageimg.splitSpread", {}, sid)
    row = _pages(res)[0]
    assert row["status"] == "done"
    assert abs(row["splitX"] - 900) <= 36  # within 2 % of the 1800 px spread
    assert _page_count(_revision(harness, sid)) == 2


def test_split_spread_without_a_gutter_is_not_split(harness: Harness, tmp_path: Path) -> None:
    src = _image_pdf(tmp_path / "nogutter.pdf", [text_page(1240, 1754, seed=97)])
    sid = _sid(harness, src)
    rows = _pages(harness.op("pageimg.splitSpread", {}, sid))
    assert rows[0]["status"] == "review"
    assert _page_count(_revision(harness, sid)) == 1


# -- fingers and erase (L10, L14) -------------------------------------------------------------


def test_finger_proposal_then_removal_with_the_edited_mask(
    harness: Harness, tmp_path: Path
) -> None:
    scene = photo_scene(size=(1240, 1754), seed=100, skin_blob=True)
    src = _image_pdf(tmp_path / "finger.pdf", [scene.rgb])
    sid = _sid(harness, src)
    proposal = harness.op("pageimg.proposeFingerMask", {"pageIndex": 0}, sid)["data"]
    mask_path = Path(proposal["maskPath"])
    assert mask_path.is_file()
    assert proposal["coverage"] > 0
    harness.op(
        "pageimg.removeFingers",
        {"mode": "mask", "maskPng": str(mask_path), "pages": [0]},
        sid,
    )
    out = _rgb(_revision(harness, sid))
    assert out.shape[0] > 0
    skin = (np.abs(out.astype(int) - np.array([224, 172, 140])).sum(axis=2)) < 60
    assert float(skin.mean()) < 0.001


def test_erase_fills_the_rectangle_with_paper(harness: Harness, tmp_path: Path) -> None:
    frame = np.full((1754, 1240, 3), 240, np.uint8)
    frame[300:500, 300:900] = 20  # black block
    src = _image_pdf(tmp_path / "erase.pdf", [frame])
    sid = _sid(harness, src)
    rect = {"x": 300 / 1240, "y": 300 / 1754, "w": 600 / 1240, "h": 200 / 1754}
    harness.op("pageimg.erase", {"pageIndex": 0, "rects": [rect], "fill": "paper"}, sid)
    out = _rgb(_revision(harness, sid))
    assert int(out[400, 600].mean()) > 200


def test_erase_with_a_hex_colour(harness: Harness, tmp_path: Path) -> None:
    frame = np.full((1754, 1240, 3), 240, np.uint8)
    src = _image_pdf(tmp_path / "hex.pdf", [frame])
    sid = _sid(harness, src)
    rect = {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.1}
    harness.op("pageimg.erase", {"pageIndex": 0, "rects": [rect], "fill": "#0000ff"}, sid)
    out = _rgb(_revision(harness, sid))
    assert int(out[int(0.15 * 1754), int(0.2 * 1240), 2]) > 200
    assert int(out[int(0.15 * 1754), int(0.2 * 1240), 0]) < 60


def test_remove_stains_op_removes_a_blue_line(harness: Harness, tmp_path: Path) -> None:
    frame = text_page(1240, 1754, seed=110)
    cv2.line(frame, (100, 600), (1100, 610), (30, 60, 220), 8)
    src = _image_pdf(tmp_path / "stain.pdf", [frame])
    sid = _sid(harness, src)
    rows = _pages(
        harness.op(
            "pageimg.removeStains", {"hueMin": 200, "hueMax": 260, "minSaturation": 0.4}, sid
        )
    )
    assert rows[0]["status"] == "done"
    out = _rgb(_revision(harness, sid))
    assert not _is_blue(out[600:612, 200:1000])


# -- enhance undo, signed and skipped pages ----------------------------------------------------


def test_undo_restores_the_original_page_image(harness: Harness, tmp_path: Path) -> None:
    src = _image_pdf(tmp_path / "undo.pdf", [text_page(1240, 1754, seed=120)])
    sid = _sid(harness, src)
    before = _rgb(_revision(harness, sid))
    harness.op("pageimg.enhance", {"levels": {"black": 60, "white": 200, "gamma": 1.0}}, sid)
    harness.call("session.undo", {"sessionId": sid})
    after = _rgb(_revision(harness, sid))
    assert np.abs(before.astype(int) - after.astype(int)).mean() < 1.0
    harness.call("session.redo", {"sessionId": sid})
    redone = _rgb(_revision(harness, sid))
    assert np.abs(redone.astype(int) - before.astype(int)).mean() > 5.0


def test_page_image_ops_are_blocked_on_a_signed_document(
    harness: Harness, corpus: dict[str, Path]
) -> None:
    sid = _sid(harness, corpus["fake_signed.pdf"])
    with pytest.raises(RpcFailure) as exc:
        harness.op("pageimg.deskew", {"mode": "auto"}, sid)
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"


def test_page_without_a_dominant_image_is_skipped(harness: Harness, tmp_path: Path) -> None:
    pdf = new_pdf(1)
    place(pdf, pdf.pages[0], [], text="Chu ky so")
    src = save(pdf, tmp_path / "text.pdf")
    sid = _sid(harness, src)
    rows = _pages(harness.op("pageimg.enhance", {}, sid))
    assert rows[0]["status"] == "skipped"
    assert rows[0]["reason"] == "NO_DOMINANT_IMAGE"


def test_output_file_size_stays_sane(harness: Harness, tmp_path: Path) -> None:
    src = _image_pdf(tmp_path / "size.pdf", [text_page(1240, 1754, seed=130)])
    sid = _sid(harness, src)
    harness.op("pageimg.enhance", {"whiten": True, "denoise": True}, sid)
    assert _revision(harness, sid).stat().st_size < src.stat().st_size * 2 + 100_000


# -- spinePreview (T8.08) ---------------------------------------------------------------------


def test_spine_preview_reports_the_automatic_gutter_and_leaves_the_document(
    harness: Harness, tmp_path: Path
) -> None:
    src = _image_pdf(tmp_path / "spine_preview.pdf", [_spread_frame(98, shadow=True)])
    sid = _sid(harness, src)
    before = _revision(harness, sid)
    res = harness.op("pageimg.spinePreview", {"pages": [0]}, sid)
    row = _pages(res)[0]
    assert row["status"] == "done"
    assert (
        abs(row["autoX"] - 0.5) <= 0.02
    )  # the shadow gutter of an 1800 px spread is in the middle
    assert row["confidence"] > 0.4
    preview = Path(row["previewPath"])
    assert preview.exists() and preview.stat().st_size > 0
    # The preview is read only: the page count and the current revision are unchanged.
    assert _page_count(_revision(harness, sid)) == 1
    assert Path(_revision(harness, sid)).read_bytes() == Path(before).read_bytes()


def test_spine_preview_skips_pages_out_of_range(harness: Harness, tmp_path: Path) -> None:
    src = _image_pdf(tmp_path / "spine_range.pdf", [_spread_frame(100, shadow=True)])
    sid = _sid(harness, src)
    res = harness.op("pageimg.spinePreview", {"pages": [5]}, sid)
    assert _pages(res)[5] == {
        "pageIndex": 5,
        "status": "skipped",
        "reason": "PAGE_OUT_OF_RANGE",
    }
