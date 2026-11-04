"""Page-image operations for scanned pages and phone photos (v0.8: L1-L19).

Every operation works on the *dominant image* of a page: the largest image placement that covers
at least half of the page. A page without one is skipped with ``NO_DOMINANT_IMAGE``. Pixels come
from ``chef_core.imaging.pageimg``; the result is written as a new JPEG XObject (``jpegQuality``,
default 80), the same way as ``content.replaceImage``.

Two ways of writing a result:

- in place (``deskew``, ``enhance`` without ``resizePage``, ``removeFingers``, ``erase``,
  ``removeStains``): the placement keeps its box, the other objects of the page stay;
- rebuilt (``crop``, ``autoCrop``, ``splitSpread``, ``enhance`` with ``resizePage``): the page
  becomes the image alone (its content and annotations are replaced). The page size follows the
  image at its resolution, or keeps its size with ``keepPageSize``. Objects other than the image
  are dropped and reported with the ``OTHER_CONTENT_REMOVED`` warning.

Operations that rewrite pages are ``destructive`` (blocked on signed documents). The detection
operations (``pageimg.detectQuad``, ``pageimg.proposeFingerMask``) are read-only.

Pages are reported per page as ``{pageIndex, status, reason?, ...}`` where status is ``done``,
``skipped`` (nothing to do or no suitable image) or ``review`` (the detection is not confident
enough; the page is left as it is and listed in ``needsReview``).
"""

from __future__ import annotations

import base64
import binascii
import io
import itertools
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Any, Literal

import numpy as np
import pikepdf
from pikepdf import Array, Dictionary, Name
from PIL import Image
from pydantic import Field

from chef_core.content.engine import build_model
from chef_core.content.model import PageObject
from chef_core.errors import invalid_params
from chef_core.imaging import docaligner as da
from chef_core.imaging import pageimg as pi
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.ops.content_image import (
    _decode,
    _drop_old,
    _image_object,
    _new_xobject,
    _place,
    _register,
)
from chef_core.ops.scan import selected_pages
from chef_core.overlay.pagecontent import inherited

log = logging.getLogger(__name__)

PageIndex = Annotated[int, Field(ge=0)]
Quality = Annotated[int, Field(ge=1, le=100)]
FillPattern = Annotated[str, Field(pattern=r"^(paper|#[0-9A-Fa-f]{6})$")]
Unit = Annotated[float, Field(ge=0, le=1)]
PAPER_OUT = Literal["auto", "A4", "A5", "Letter"]
DEFAULT_PPI = 150.0
PAGE_IMAGE_DIR = "pageimg"


# -- the dominant image of a page ----------------------------------------------------------


@dataclass
class _Dominant:
    obj: PageObject
    stream: pikepdf.Stream
    px: tuple[int, int]  # width, height of the stored image
    box: tuple[float, float]  # placement size in points
    others: int  # paintable objects of the page that are not the image

    @property
    def ppi(self) -> float:
        bw, bh = self.box
        if bw <= 0 or bh <= 0:
            return DEFAULT_PPI
        return (self.px[0] / (bw / 72) + self.px[1] / (bh / 72)) / 2


def _page_area(page: pikepdf.Page) -> tuple[float, float, float, float]:
    x0, y0, x1, y1 = (float(v) for v in page.cropbox)
    return min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)


def _dominant(pdf: pikepdf.Pdf, index: int) -> _Dominant | str:
    """The dominant image of page ``index``, or the reason it has none."""
    page = pdf.pages[index]
    model = build_model(pdf, page, index)
    x0, y0, x1, y1 = _page_area(page)
    page_area = max((x1 - x0) * (y1 - y0), 1.0)
    best: PageObject | None = None
    best_area = 0.0
    for obj in model.objects:
        if obj.kind != "image" or not obj.in_page or obj.inline or obj.image_name is None:
            continue
        bx0, by0, bx1, by1 = obj.bbox
        area = max(0.0, bx1 - bx0) * max(0.0, by1 - by0)
        if area >= 0.5 * page_area and area > best_area:
            best, best_area = obj, area
    if best is None or best.image_name is None:
        return "NO_DOMINANT_IMAGE"
    resources = inherited(page.obj, "/Resources")
    table = resources.get("/XObject") if isinstance(resources, Dictionary) else None
    if table is None or Name(best.image_name) not in table:
        return "IMAGE_NOT_FOUND"
    stream = table[Name(best.image_name)]
    if not isinstance(stream, pikepdf.Stream):
        return "IMAGE_NOT_FOUND"
    if "/SMask" in stream or "/Mask" in stream:
        return "IMAGE_HAS_ALPHA"
    bw = float(np.hypot(best.ctm[0], best.ctm[1]))
    bh = float(np.hypot(best.ctm[2], best.ctm[3]))
    px = (int(stream.Width), int(stream.Height))
    others = sum(1 for o in model.objects if o is not best and o.kind != "form")
    return _Dominant(obj=best, stream=stream, px=px, box=(bw, bh), others=others)


def _pixels(dom: _Dominant) -> np.ndarray:
    img, _alpha = _decode(dom.stream)
    return np.asarray(img)


def _pil(arr: np.ndarray) -> Image.Image:
    if arr.ndim == 2:
        return Image.fromarray(np.ascontiguousarray(arr), mode="L")
    return Image.fromarray(np.ascontiguousarray(arr), mode="RGB")


def _xobject(pdf: pikepdf.Pdf, arr: np.ndarray, quality: int) -> pikepdf.Stream:
    pil = _pil(arr)
    buf = io.BytesIO()
    pil.save(buf, format="JPEG", quality=quality)
    return _new_xobject(pdf, pil, None, buf.getvalue())


def _replace_in_place(
    pdf: pikepdf.Pdf, index: int, dom: _Dominant, arr: np.ndarray, quality: int
) -> None:
    editor, obj = _image_object(pdf, index, dom.obj.id)
    xobj = _xobject(pdf, arr, quality)
    name = _register(editor, xobj)
    _place(editor, obj, name, (arr.shape[1], arr.shape[0]), "stretch", True)
    _drop_old(editor, obj)
    editor.write()


def _draw_image_only(
    pdf: pikepdf.Pdf,
    page_obj: Dictionary,
    xobj: pikepdf.Stream,
    px: tuple[int, int],
    box: tuple[float, float, float, float],
    *,
    keep_box: bool,
) -> None:
    """Make the page show ``xobj`` alone. ``keep_box``: fit the image inside ``box`` (centred,
    proportions kept); otherwise the box is the image's own size. Annotations are removed."""
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    w, h = px
    if keep_box:
        scale = min(bw / w, bh / h)
        dw, dh = w * scale, h * scale
        ox, oy = x0 + (bw - dw) / 2, y0 + (bh - dh) / 2
    else:
        dw, dh, ox, oy = bw, bh, x0, y0
    content = f"q {dw:.4f} 0 0 {dh:.4f} {ox:.4f} {oy:.4f} cm /ChefImg0 Do Q".encode()
    page_obj.Resources = Dictionary(XObject=Dictionary(ChefImg0=xobj))
    page_obj.Contents = pdf.make_stream(content)
    page_obj.MediaBox = Array([x0, y0, x1, y1])
    page_obj.CropBox = Array([x0, y0, x1, y1])
    if "/Annots" in page_obj:
        del page_obj["/Annots"]


def _points_box(ppi: float, px: tuple[int, int]) -> tuple[float, float, float, float]:
    return (0.0, 0.0, px[0] * 72 / ppi, px[1] * 72 / ppi)


def _rebuild(
    pdf: pikepdf.Pdf,
    index: int,
    dom: _Dominant,
    arr: np.ndarray,
    quality: int,
    *,
    ppi: float,
    keep_page_size: bool,
) -> None:
    page = pdf.pages[index]
    px = (arr.shape[1], arr.shape[0])
    xobj = _xobject(pdf, arr, quality)
    box = _page_area(page) if keep_page_size else _points_box(ppi, px)
    _draw_image_only(pdf, page.obj, xobj, px, box, keep_box=keep_page_size)


def _other_content_warning(ctx: OpContext, index: int, dom: _Dominant) -> None:
    if dom.others:
        ctx.warn(f"OTHER_CONTENT_REMOVED: page {index + 1} lost {dom.others} object(s)")


def _mask_from_png(path: str, size: tuple[int, int]) -> np.ndarray:
    """A mask from a PNG (white = erase), resized with nearest neighbour to ``size``."""
    p = Path(path)
    if not p.is_file():
        raise invalid_params("FILE_NOT_FOUND", {"path": path})
    try:
        with Image.open(p) as im:
            gray = im.convert("L")
            if gray.size != size:
                gray = gray.resize(size, Image.Resampling.NEAREST)
            return np.asarray(gray) > 127
    except (OSError, ValueError) as exc:
        raise invalid_params("UNREADABLE_IMAGE", {"path": path, "error": str(exc)}) from exc


def _work_dir(ctx: OpContext) -> Path:
    if ctx.input_path is None:
        raise RuntimeError("operation needs a session but none was given")
    directory = ctx.input_path.parent / PAGE_IMAGE_DIR
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _rect_px(rect: tuple[float, float, float, float], w: int, h: int) -> tuple[int, int, int, int]:
    x, y, rw, rh = rect
    return (round(x * w), round(y * h), round((x + rw) * w), round((y + rh) * h))


def _corners_px(corners: list[tuple[float, float]], w: int, h: int) -> np.ndarray:
    return np.array([[x * w, y * h] for x, y in corners], np.float64)


def _paper_size(corners: np.ndarray, paper: str) -> tuple[int, int]:
    """Output size with the proportions of ``paper`` (the longer side of the quad is kept)."""
    top = float(np.linalg.norm(corners[1] - corners[0]))
    bottom = float(np.linalg.norm(corners[2] - corners[3]))
    left = float(np.linalg.norm(corners[3] - corners[0]))
    right = float(np.linalg.norm(corners[2] - corners[1]))
    w, h = (top + bottom) / 2, (left + right) / 2
    ratio = pi.LETTER_RATIO if paper == "Letter" else pi.A_RATIO
    long_side = max(w, h)
    short_side = long_side / ratio
    if h >= w:
        return max(1, round(short_side)), max(1, round(long_side))
    return max(1, round(long_side)), max(1, round(short_side))


def _quad_size(corners: np.ndarray) -> tuple[float, float]:
    top = float(np.linalg.norm(corners[1] - corners[0]))
    bottom = float(np.linalg.norm(corners[2] - corners[3]))
    left = float(np.linalg.norm(corners[3] - corners[0]))
    right = float(np.linalg.norm(corners[2] - corners[1]))
    return (top + bottom) / 2, (left + right) / 2


def _expand(corners: np.ndarray, padding: float) -> np.ndarray:
    if padding <= 0:
        return corners
    centre = corners.mean(axis=0)
    out = corners.copy()
    for i, c in enumerate(corners):
        d = c - centre
        n = float(np.linalg.norm(d))
        if n > 0:
            out[i] = c + d / n * padding
    return out


def _selected(pages: list[int] | None, count: int) -> list[int]:
    return selected_pages(pages, count)


def _best_quad(rgb: np.ndarray) -> pi.PageQuad:
    """Use the better confidence from the classical detector and bundled offline model."""
    classical = pi.detect_page_quad(rgb)
    try:
        learned = da.detect_page_quad(rgb)
    except Exception:  # the model only refines the classical result; never fail the page for it
        log.warning("DocAligner unavailable, using the classical detector", exc_info=True)
        learned = None
    return da.prefer_confident_quad(classical, learned)


# -- pageimg.detectQuad (read-only) ---------------------------------------------------------


class DetectQuadParams(WireModel):
    """Detect the corners of the sheet on each page (no change to the document)."""

    pages: list[PageIndex] | None = Field(default=None, description="0-based; default all.")


@operation(
    id="pageimg.detectQuad", title="Detect page corners", group="pageimg", params=DetectQuadParams
)
def detect_quad(ctx: OpContext, p: DetectQuadParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("pageimg.detectQuad needs a session")
    rows: list[dict[str, Any]] = []
    with ctx.open_input() as pdf:
        selected = _selected(p.pages, len(pdf.pages))
        for done, index in enumerate(selected):
            ctx.progress(done, len(selected), "Detect corners")
            dom = _dominant(pdf, index)
            if isinstance(dom, str):
                rows.append({"pageIndex": index, "status": "skipped", "reason": dom})
                continue
            rgb = _pixels(dom)
            quad = _best_quad(rgb)
            h, w = rgb.shape[:2]
            corners = quad.corners
            cw, ch = _quad_size(corners)
            paper = pi.detect_paper_size(round(min(cw, ch)), round(max(cw, ch)), dom.ppi)
            rows.append(
                {
                    "pageIndex": index,
                    "status": "done",
                    "corners": [[round(float(x), 2), round(float(y), 2)] for x, y in corners],
                    "cornersFraction": [
                        [round(float(x) / w, 5), round(float(y) / h, 5)] for x, y in corners
                    ],
                    "confidence": quad.confidence,
                    "method": quad.method,
                    "paperSize": paper,
                    "imageSize": [w, h],
                    "needsReview": quad.confidence < 0.6,
                }
            )
    return OpOutput(changed_pages=[], data={"pages": rows})


class QuadPreviewParams(WireModel):
    pages: list[PageIndex] = Field(min_length=1, max_length=3)


@operation(
    id="pageimg.quadPreview",
    title="Preview page corners",
    group="pageimg",
    params=QuadPreviewParams,
)
def quad_preview(ctx: OpContext, p: QuadPreviewParams) -> OpOutput:
    """Show detected corners on the actual embedded image, without modifying the PDF."""
    if ctx.input_path is None:
        raise RuntimeError("pageimg.quadPreview needs a session")
    folder = ctx.input_path.parent / "preview" / "pageimg-quad"
    folder.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    with ctx.open_input() as pdf:
        selected = _selected(p.pages, len(pdf.pages))
        for index in ctx.steps(selected, len(selected), "Preview page corners"):
            dom = _dominant(pdf, index)
            if isinstance(dom, str):
                rows.append({"pageIndex": index, "status": "skipped", "reason": dom})
                continue
            rgb = _pixels(dom)
            h, w = rgb.shape[:2]
            quad = _best_quad(rgb)
            preview = _pil(rgb)
            preview.thumbnail((1400, 1400), Image.Resampling.LANCZOS)
            out = folder / f"{ctx.job_id[:8]}-p{index}.png"
            preview.save(out)
            rows.append(
                {
                    "pageIndex": index,
                    "status": "done",
                    "imagePath": str(out),
                    "sourceSizePx": [w, h],
                    "ppi": dom.ppi,
                    "cornersFraction": [
                        [
                            round(float(np.clip(x / w, 0, 1)), 5),
                            round(float(np.clip(y / h, 0, 1)), 5),
                        ]
                        for x, y in quad.corners
                    ],
                    "confidence": quad.confidence,
                    "method": quad.method,
                }
            )
    return OpOutput(changed_pages=[], data={"pages": rows})


# -- pageimg.deskew -------------------------------------------------------------------------


class DeskewParams(WireModel):
    """Straighten the text of scanned pages (L1)."""

    pages: list[PageIndex] | None = Field(default=None, description="0-based; default all.")
    mode: Literal["auto", "angle"] = "auto"
    angle: float = Field(
        default=0.0,
        ge=-15,
        le=15,
        description="mode angle: skew to remove, degrees counter-clockwise "
        "(as mode auto reports it).",
    )
    min_confidence: float = Field(
        default=0.5, ge=0, le=1, description="mode auto: below this the page is only reported."
    )
    jpeg_quality: Quality = 80


class DewarpParams(WireModel):
    """Flatten gently curved text lines on scanned pages (L13)."""

    pages: list[PageIndex] | None = Field(default=None, description="0-based; default all.")
    min_confidence: float = Field(
        default=0.35, ge=0, le=1, description="Below this confidence the page is only reported."
    )
    jpeg_quality: Quality = 88


@operation(
    id="pageimg.deskew",
    title="Straighten page",
    group="pageimg",
    params=DeskewParams,
    destructive=True,
)
def deskew(ctx: OpContext, p: DeskewParams) -> OpOutput:
    rows: list[dict[str, Any]] = []
    changed: list[int] = []
    with ctx.open_input() as pdf:
        selected = _selected(p.pages, len(pdf.pages))
        for index in ctx.steps(selected, len(selected), "Straighten"):
            dom = _dominant(pdf, index)
            if isinstance(dom, str):
                rows.append({"pageIndex": index, "status": "skipped", "reason": dom})
                continue
            rgb = _pixels(dom)
            if p.mode == "auto":
                out, angle, conf = pi.deskew(rgb)
                if conf < p.min_confidence:
                    rows.append(
                        {
                            "pageIndex": index,
                            "status": "review",
                            "reason": "LOW_CONFIDENCE",
                            "angle": angle,
                            "confidence": conf,
                        }
                    )
                    continue
                if angle == 0.0:
                    rows.append(
                        {
                            "pageIndex": index,
                            "status": "skipped",
                            "reason": "ALREADY_STRAIGHT",
                            "angle": 0.0,
                            "confidence": conf,
                        }
                    )
                    continue
            else:
                if p.angle == 0:
                    rows.append(
                        {
                            "pageIndex": index,
                            "status": "skipped",
                            "reason": "NO_CHANGE",
                            "angle": 0.0,
                        }
                    )
                    continue
                angle = round(p.angle, 2)
                conf = None
                out = pi.rotate(rgb, -angle, fill=pi.paper_colour(rgb))
            _replace_in_place(pdf, index, dom, out, p.jpeg_quality)
            changed.append(index)
            rows.append({"pageIndex": index, "status": "done", "angle": angle, "confidence": conf})
        if changed:
            ctx.save_document(pdf)
    return OpOutput(changed_pages=changed, data={"pages": rows})


@operation(
    id="pageimg.dewarp",
    title="Flatten curved page",
    group="pageimg",
    params=DewarpParams,
    destructive=True,
)
def dewarp(ctx: OpContext, p: DewarpParams) -> OpOutput:
    """Apply L13 only when enough long text lines support a stable curvature estimate."""
    rows: list[dict[str, Any]] = []
    changed: list[int] = []
    with ctx.open_input() as pdf:
        selected = _selected(p.pages, len(pdf.pages))
        for index in ctx.steps(selected, len(selected), "Flatten curved pages"):
            dom = _dominant(pdf, index)
            if isinstance(dom, str):
                rows.append({"pageIndex": index, "status": "skipped", "reason": dom})
                continue
            out, confidence, correction = pi.dewarp(_pixels(dom))
            if confidence < p.min_confidence:
                rows.append(
                    {
                        "pageIndex": index,
                        "status": "review",
                        "reason": "LOW_CONFIDENCE",
                        "confidence": confidence,
                        "correctionPx": correction,
                    }
                )
                continue
            if correction == 0.0:
                rows.append(
                    {
                        "pageIndex": index,
                        "status": "skipped",
                        "reason": "NO_CURVATURE",
                        "confidence": confidence,
                        "correctionPx": correction,
                    }
                )
                continue
            _replace_in_place(pdf, index, dom, out, p.jpeg_quality)
            changed.append(index)
            rows.append(
                {
                    "pageIndex": index,
                    "status": "done",
                    "confidence": confidence,
                    "correctionPx": correction,
                }
            )
        if changed:
            ctx.save_document(pdf)
    return OpOutput(changed_pages=changed, data={"pages": rows})


class DewarpPreviewParams(WireModel):
    """Read-only before/after previews for up to three pages."""

    pages: list[PageIndex] = Field(min_length=1, max_length=3)


@operation(
    id="pageimg.dewarpPreview",
    title="Preview curved page correction",
    group="pageimg",
    params=DewarpPreviewParams,
)
def dewarp_preview(ctx: OpContext, p: DewarpPreviewParams) -> OpOutput:
    """Write before/after PNGs without changing the current document revision."""
    if ctx.input_path is None:
        raise RuntimeError("pageimg.dewarpPreview needs a session")
    rows: list[dict[str, Any]] = []
    out_dir = ctx.input_path.parent / "preview" / "pageimg-dewarp"
    out_dir.mkdir(parents=True, exist_ok=True)
    with ctx.open_input() as pdf:
        selected = _selected(p.pages, len(pdf.pages))
        for done, index in enumerate(selected):
            ctx.progress(done, len(selected), "Preview page flattening")
            dom = _dominant(pdf, index)
            if isinstance(dom, str):
                rows.append({"pageIndex": index, "status": "skipped", "reason": dom})
                continue
            original = _pixels(dom)
            result, confidence, correction = pi.dewarp(original)
            stem = f"{ctx.job_id[:8]}-p{index}"
            original_path = out_dir / f"{stem}-original.png"
            result_path = out_dir / f"{stem}-result.png"
            _pil(original).save(original_path)
            _pil(result).save(result_path)
            rows.append(
                {
                    "pageIndex": index,
                    "status": "done",
                    "originalPath": str(original_path),
                    "resultPath": str(result_path),
                    "confidence": confidence,
                    "correctionPx": correction,
                }
            )
    return OpOutput(changed_pages=[], data={"pages": rows})


# -- pageimg.enhance ------------------------------------------------------------------------


class Levels(WireModel):
    black: int = Field(default=0, ge=0, le=254)
    white: int = Field(default=255, ge=1, le=255)
    gamma: float = Field(default=1.0, gt=0.1, le=10)


class CurvePoint(WireModel):
    """One control point of the tone curve: input and output level, 0..255."""

    input: int = Field(ge=0, le=255)
    output: int = Field(ge=0, le=255)


class EnhanceParams(WireModel):
    """Clean up scanned pages: background, specks, levels, colour, resolution (L3, L4, L12)."""

    pages: list[PageIndex] | None = Field(default=None, description="0-based; default all.")
    whiten: bool = False
    whiten_strength: float = Field(default=0.8, ge=0, le=1)
    denoise: bool = False
    denoise_strength: float = Field(default=0.5, ge=0, le=1)
    levels: Levels | None = None
    curve: list[CurvePoint] | None = Field(
        default=None,
        min_length=2,
        max_length=16,
        description="Tone curve after levels: points sorted by input, inputs unique.",
    )
    invert: bool = False
    grayscale: bool = False
    contrast: float = Field(default=0, ge=-100, le=100)
    brightness: float = Field(default=0, ge=-100, le=100)
    dpi: int | None = Field(
        default=None,
        ge=72,
        le=1200,
        description="Resolution in dpi. Resamples the pixels (page keeps its size) "
        "unless resizePage is set.",
    )
    resize_page: bool = Field(
        default=False,
        description="With dpi: keep the pixels and change the page size so that the image has dpi.",
    )
    jpeg_quality: Quality = 80


def _apply_curve(pixels: np.ndarray, points: list[CurvePoint]) -> np.ndarray:
    """Map every level through the curve (linear between the points, flat beyond the ends)."""
    xs = np.array([pt.input for pt in points], dtype=np.float64)
    ys = np.array([pt.output for pt in points], dtype=np.float64)
    lut = np.clip(np.round(np.interp(np.arange(256), xs, ys)), 0, 255).astype(np.uint8)
    mapped: np.ndarray = lut[pixels]
    return mapped


def _enhance_pixels(rgb: np.ndarray, p: EnhanceParams) -> np.ndarray:
    out = rgb
    if p.whiten:
        out = pi.whiten_background(out, p.whiten_strength)
    if p.denoise:
        out = pi.denoise(out, p.denoise_strength)
    if p.levels is not None:
        out = pi.adjust_levels(out, p.levels.black, p.levels.white, p.levels.gamma)
    if p.curve is not None:
        out = _apply_curve(out, p.curve)
    if p.contrast or p.brightness:
        out = pi.tone(out, brightness=p.brightness, contrast=p.contrast)
    if p.grayscale and out.ndim == 3:
        out = pi.to_gray(out)
    if p.invert:
        out = pi.invert(out)
    return out


@operation(
    id="pageimg.enhance",
    title="Enhance scanned page",
    group="pageimg",
    params=EnhanceParams,
    destructive=True,
)
def enhance(ctx: OpContext, p: EnhanceParams) -> OpOutput:
    if p.levels is not None and p.levels.white <= p.levels.black:
        raise invalid_params("INVALID_LEVELS", {"black": p.levels.black, "white": p.levels.white})
    if p.curve is not None:
        inputs = [pt.input for pt in p.curve]
        if any(b <= a for a, b in itertools.pairwise(inputs)):
            raise invalid_params("CURVE_NOT_INCREASING", {"inputs": inputs})
    rows: list[dict[str, Any]] = []
    changed: list[int] = []
    with ctx.open_input() as pdf:
        selected = _selected(p.pages, len(pdf.pages))
        for index in ctx.steps(selected, len(selected), "Enhance"):
            dom = _dominant(pdf, index)
            if isinstance(dom, str):
                rows.append({"pageIndex": index, "status": "skipped", "reason": dom})
                continue
            rgb = _pixels(dom)
            out = _enhance_pixels(rgb, p)
            if p.dpi is not None and p.resize_page:
                _rebuild(
                    pdf, index, dom, out, p.jpeg_quality, ppi=float(p.dpi), keep_page_size=False
                )
                _other_content_warning(ctx, index, dom)
            else:
                if p.dpi is not None and abs(p.dpi - dom.ppi) > 0.5:
                    out = pi.set_dpi(out, float(p.dpi), current_dpi=dom.ppi)
                _replace_in_place(pdf, index, dom, out, p.jpeg_quality)
            changed.append(index)
            rows.append(
                {
                    "pageIndex": index,
                    "status": "done",
                    "pixelSize": [out.shape[1], out.shape[0]],
                    "dpi": round(dom.ppi if p.dpi is None else float(p.dpi), 1),
                }
            )
        if changed:
            ctx.save_document(pdf)
    return OpOutput(changed_pages=changed, data={"pages": rows})


class EnhancePreviewParams(EnhanceParams):
    """The enhance settings applied to one page, written as a PNG and not saved (T8.02)."""

    page_index: PageIndex


@operation(
    id="pageimg.enhancePreview",
    title="Preview enhanced page",
    group="pageimg",
    params=EnhancePreviewParams,
)
def enhance_preview(ctx: OpContext, p: EnhancePreviewParams) -> OpOutput:
    """Write the adjusted page as a PNG (at most 900 px wide); the document does not change."""
    if ctx.input_path is None:
        raise RuntimeError("pageimg.enhancePreview needs a session")
    if p.levels is not None and p.levels.white <= p.levels.black:
        raise invalid_params("INVALID_LEVELS", {"black": p.levels.black, "white": p.levels.white})
    with ctx.open_input() as pdf:
        if p.page_index >= len(pdf.pages):
            raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": p.page_index})
        dom = _dominant(pdf, p.page_index)
        if isinstance(dom, str):
            return OpOutput(
                changed_pages=[],
                data={"pageIndex": p.page_index, "status": "skipped", "reason": dom},
            )
        rgb = _pixels(dom)
    out = _enhance_pixels(rgb, p)
    image = _pil(out)
    h, w = out.shape[:2]
    scale = min(1.0, 900 / w)
    if scale < 1.0:
        image = image.resize((round(w * scale), round(h * scale)))
    out_dir = ctx.input_path.parent / "preview" / "pageimg-enhance"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{ctx.job_id[:8]}-p{p.page_index}.png"
    image.save(path, format="PNG")
    return OpOutput(
        changed_pages=[],
        data={"pageIndex": p.page_index, "status": "done", "previewPath": str(path)},
    )


# -- pageimg.crop ---------------------------------------------------------------------------


class CropPoint(WireModel):
    x: Unit
    y: Unit


class CropPage(WireModel):
    """Corners TL, TR, BR, BL as fractions (0..1) of the page image."""

    page_index: PageIndex
    corners: list[CropPoint] = Field(min_length=4, max_length=4)
    angle: float = Field(
        default=0,
        ge=-15,
        le=15,
        description="Fine rotation in degrees counter-clockwise after cropping.",
    )
    out_size: list[int] | None = Field(
        default=None,
        min_length=2,
        max_length=2,
        description="Output pixels [w, h]; default from the corners.",
    )


class CropParams(WireModel):
    """Crop a page image by 4 corners, with perspective correction (L2, L16, L17)."""

    pages: list[CropPage] = Field(min_length=1)
    keep_page_size: bool = Field(
        default=False, description="False: the page follows the new image at its resolution."
    )
    jpeg_quality: Quality = 80


class CropPreviewParams(WireModel):
    """A page and four normalized corners, in TL, TR, BR, BL order."""

    page_index: PageIndex
    corners: list[CropPoint] = Field(min_length=4, max_length=4)
    angle: float = Field(
        default=0,
        ge=-15,
        le=15,
        description="Fine rotation in degrees counter-clockwise after cropping.",
    )
    out_size: list[int] | None = Field(default=None, min_length=2, max_length=2)


@operation(
    id="pageimg.cropPreview",
    title="Preview crop and straighten",
    group="pageimg",
    params=CropPreviewParams,
)
def crop_preview(ctx: OpContext, p: CropPreviewParams) -> OpOutput:
    """Create a bounded preview without writing a new document revision."""
    if ctx.input_path is None:
        raise RuntimeError("pageimg.cropPreview needs a session")
    with ctx.open_input() as pdf:
        if p.page_index >= len(pdf.pages):
            raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": p.page_index})
        dom = _dominant(pdf, p.page_index)
        if isinstance(dom, str):
            raise invalid_params(dom, {"pageIndex": p.page_index})
        image = _pil(_pixels(dom))
        image.thumbnail((1400, 1400), Image.Resampling.LANCZOS)
        rgb = np.asarray(image)
        height, width = rgb.shape[:2]
        corners = _corners_px([(point.x, point.y) for point in p.corners], width, height)
        _require_valid_quad(corners, width, height, p.page_index)
        preview_size = _preview_crop_size(p.out_size)
        corrected = _pil(_cut_and_rotate(rgb, corners, preview_size, p.angle))
        corrected.thumbnail((1400, 1400), Image.Resampling.LANCZOS)
        folder = ctx.input_path.parent / "preview" / "pageimg-crop"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"{ctx.job_id}-p{p.page_index}.png"
        corrected.save(path)
    return OpOutput(
        changed_pages=[],
        data={"imagePath": str(path)},
    )


@operation(
    id="pageimg.crop",
    title="Crop and straighten",
    group="pageimg",
    params=CropParams,
    destructive=True,
)
def crop(ctx: OpContext, p: CropParams) -> OpOutput:
    rows: list[dict[str, Any]] = []
    changed: list[int] = []
    with ctx.open_input() as pdf:
        count = len(pdf.pages)
        for item in p.pages:
            if item.page_index >= count:
                raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": item.page_index})
        for entry in ctx.steps(p.pages, len(p.pages), "Crop"):
            index = entry.page_index
            dom = _dominant(pdf, index)
            if isinstance(dom, str):
                rows.append({"pageIndex": index, "status": "skipped", "reason": dom})
                continue
            rgb = _pixels(dom)
            h, w = rgb.shape[:2]
            corners = _corners_px([(c.x, c.y) for c in entry.corners], w, h)
            _require_valid_quad(corners, w, h, index)
            out = _cut_and_rotate(rgb, corners, entry.out_size, entry.angle)
            _rebuild(
                pdf, index, dom, out, p.jpeg_quality, ppi=dom.ppi, keep_page_size=p.keep_page_size
            )
            _other_content_warning(ctx, index, dom)
            changed.append(index)
            rows.append(
                {"pageIndex": index, "status": "done", "pixelSize": [out.shape[1], out.shape[0]]}
            )
        if changed:
            ctx.save_document(pdf)
    return OpOutput(changed_pages=changed, data={"pages": rows})


def _require_valid_quad(corners: np.ndarray, width: int, height: int, page_index: int) -> None:
    """Reject crossed, concave or nearly empty quads before passing them to OpenCV."""
    edges = np.roll(corners, -1, axis=0) - corners
    following = np.roll(edges, -1, axis=0)
    crosses = edges[:, 0] * following[:, 1] - edges[:, 1] * following[:, 0]
    x, y = corners[:, 0], corners[:, 1]
    area = abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))) / 2
    if area < width * height * 0.01 or not (np.all(crosses > 0) or np.all(crosses < 0)):
        raise invalid_params("INVALID_CROP_QUAD", {"pageIndex": page_index})


def _cut_and_rotate(
    rgb: np.ndarray, corners: np.ndarray, out_size: list[int] | None, angle: float
) -> np.ndarray:
    result = _cut(rgb, corners, out_size)
    return pi.rotate(result, angle, fill=pi.paper_colour(result)) if angle else result


def _cut(rgb: np.ndarray, corners: np.ndarray, out_size: list[int] | None) -> np.ndarray:
    if out_size is not None:
        _validate_crop_size(out_size)
    if out_size is None:
        rect = pi.crop_rect(rgb, corners)
        if rect is not None:
            return rect
        return pi.warp_perspective(rgb, corners, snap_paper=False)
    return pi.warp_perspective(rgb, corners, (out_size[0], out_size[1]))


def _validate_crop_size(out_size: list[int]) -> None:
    width, height = out_size
    if width < 1 or height < 1 or width > 20_000 or height > 20_000 or width * height > 50_000_000:
        raise invalid_params("CROP_OUTPUT_TOO_LARGE", {"width": width, "height": height})


def _preview_crop_size(out_size: list[int] | None) -> list[int] | None:
    """Keep preview warps bounded while preserving the requested output aspect ratio."""
    if out_size is None:
        return None
    _validate_crop_size(out_size)
    width, height = out_size
    scale = min(1.0, 1400 / max(width, height))
    return [max(1, round(width * scale)), max(1, round(height * scale))]


# -- pageimg.autoCrop -----------------------------------------------------------------------


class AutoCropParams(WireModel):
    """Find the sheet on each page and crop to it; unsure pages are reported (L15, L18, L19)."""

    pages: list[PageIndex] | None = Field(default=None, description="0-based; default all.")
    min_confidence: float = Field(
        default=0.6, ge=0, le=1, description="Pages below this are left as they are and reported."
    )
    paper_size: PAPER_OUT = Field(
        default="auto", description="'auto' keeps the measured proportions."
    )
    padding: int = Field(default=0, ge=0, le=2000, description="Pixels added around the sheet.")
    keep_page_size: bool = False
    jpeg_quality: Quality = 80


@operation(
    id="pageimg.autoCrop",
    title="Auto crop pages",
    group="pageimg",
    params=AutoCropParams,
    destructive=True,
)
def auto_crop(ctx: OpContext, p: AutoCropParams) -> OpOutput:
    rows: list[dict[str, Any]] = []
    changed: list[int] = []
    review: list[int] = []
    with ctx.open_input() as pdf:
        selected = _selected(p.pages, len(pdf.pages))
        for index in ctx.steps(selected, len(selected), "Auto crop"):
            dom = _dominant(pdf, index)
            if isinstance(dom, str):
                rows.append({"pageIndex": index, "status": "skipped", "reason": dom})
                continue
            rgb = _pixels(dom)
            h, w = rgb.shape[:2]
            quad = _best_quad(rgb)
            if quad.confidence < p.min_confidence:
                review.append(index)
                rows.append(
                    {
                        "pageIndex": index,
                        "status": "review",
                        "reason": "LOW_CONFIDENCE",
                        "confidence": quad.confidence,
                        "method": quad.method,
                    }
                )
                continue
            corners = _expand(quad.corners, float(p.padding))
            if p.paper_size != "auto":
                out = pi.warp_perspective(rgb, corners, _paper_size(corners, p.paper_size))
            else:
                out = _cut(rgb, corners, None)
            _rebuild(
                pdf, index, dom, out, p.jpeg_quality, ppi=dom.ppi, keep_page_size=p.keep_page_size
            )
            _other_content_warning(ctx, index, dom)
            changed.append(index)
            rows.append(
                {
                    "pageIndex": index,
                    "status": "done",
                    "confidence": quad.confidence,
                    "method": quad.method,
                    "pixelSize": [out.shape[1], out.shape[0]],
                    "imageSize": [w, h],
                }
            )
        if changed:
            ctx.save_document(pdf)
    return OpOutput(changed_pages=changed, data={"pages": rows, "needsReview": review})


# -- pageimg.splitSpread --------------------------------------------------------------------


class SplitParams(WireModel):
    """Split each page image (a two-page spread) into two pages (L6)."""

    pages: list[PageIndex] | None = Field(default=None, description="0-based; default all.")
    mode: Literal["auto", "x"] = "auto"
    x: float | None = Field(default=None, gt=0, lt=1, description="mode x: split at this fraction.")
    order: Literal["ltr", "rtl"] = Field(
        default="ltr",
        description="ltr: left half first. rtl: right half first (Japanese, Arabic books).",
    )
    gutter_margin: float = Field(
        default=0.01,
        ge=0,
        le=0.1,
        description="Fraction of the width removed on each side of the split.",
    )
    min_confidence: float = Field(
        default=0.4, ge=0, le=1, description="mode auto: below this, not split."
    )
    jpeg_quality: Quality = 80


@operation(
    id="pageimg.splitSpread",
    title="Split two-page spread",
    group="pageimg",
    params=SplitParams,
    destructive=True,
)
def split_spread(ctx: OpContext, p: SplitParams) -> OpOutput:
    if p.mode == "x" and p.x is None:
        raise invalid_params("SPLIT_X_REQUIRED", {"mode": "x"})
    rows: list[dict[str, Any]] = []
    plan: dict[int, tuple[int, dict[str, Any]]] = {}
    with ctx.open_input() as pdf:
        selected = _selected(p.pages, len(pdf.pages))
        doms: dict[int, _Dominant] = {}
        pix: dict[int, np.ndarray] = {}
        for index in ctx.steps(selected, len(selected), "Split"):
            dom = _dominant(pdf, index)
            if isinstance(dom, str):
                rows.append({"pageIndex": index, "status": "skipped", "reason": dom})
                continue
            rgb = _pixels(dom)
            if p.mode == "x":
                result = pi.split_spread(rgb, x=p.x)
            else:
                result = pi.split_spread(rgb)
                if result["confidence"] < p.min_confidence:
                    rows.append(
                        {
                            "pageIndex": index,
                            "status": "review",
                            "reason": "LOW_CONFIDENCE",
                            "confidence": result["confidence"],
                        }
                    )
                    continue
            doms[index] = dom
            pix[index] = rgb
            plan[index] = (result["split_x"], {"confidence": result["confidence"]})
        if plan:
            margin_of = {i: round(p.gutter_margin * pix[i].shape[1]) for i in plan}
            # from the back, so earlier indices stay valid; each split inserts one page after
            for index in sorted(plan, reverse=True):
                sx, meta = plan[index]
                rgb = pix[index]
                w = rgb.shape[1]
                m = margin_of[index]
                left = rgb[:, : max(1, sx - m)]
                right = rgb[:, min(w - 1, sx + m) :]
                first, second = (left, right) if p.order == "ltr" else (right, left)
                dom = doms[index]
                ppi = dom.ppi
                pdf.pages.insert(index + 1, pdf.pages[index])
                _rebuild(pdf, index, dom, first, p.jpeg_quality, ppi=ppi, keep_page_size=False)
                _rebuild(pdf, index + 1, dom, second, p.jpeg_quality, ppi=ppi, keep_page_size=False)
                _other_content_warning(ctx, index, dom)
                plan[index] = (sx, {**meta, "splits": True})
            ctx.save_document(pdf)
    out_rows: list[dict[str, Any]] = []
    for shift, index in enumerate(sorted(plan)):
        sx, meta = plan[index]
        out_rows.append(
            {
                "pageIndex": index,
                "status": "done",
                "splitX": sx,
                "confidence": meta["confidence"],
                "newPageIndexes": [index + shift, index + shift + 1],
            }
        )
    rows.extend(out_rows)
    rows.sort(key=lambda r: r["pageIndex"])
    changed: list[int] | Literal["all"] = "all" if plan else []
    return OpOutput(changed_pages=changed, data={"pages": rows})


# -- pageimg.spinePreview (read-only) -------------------------------------------------------


class SpinePreviewParams(WireModel):
    """Read-only preview of the automatic spine position for up to three spreads (L2, T8.08)."""

    pages: list[PageIndex] = Field(min_length=1, max_length=3)


@operation(
    id="pageimg.spinePreview",
    title="Preview spine position",
    group="pageimg",
    params=SpinePreviewParams,
)
def spine_preview(ctx: OpContext, p: SpinePreviewParams) -> OpOutput:
    """Write a PNG per spread with the automatic split drawn as a line; no change to the document.

    ``autoX`` is the automatic split as a fraction of the width, so the dialog can start from it and
    send the user's adjusted value to ``pageimg.splitSpread`` with ``mode: "x"``."""
    if ctx.input_path is None:
        raise RuntimeError("pageimg.spinePreview needs a session")
    rows: list[dict[str, Any]] = []
    out_dir = ctx.input_path.parent / "preview" / "pageimg-spine"
    out_dir.mkdir(parents=True, exist_ok=True)
    with ctx.open_input() as pdf:
        for index in p.pages:
            if index >= len(pdf.pages):
                rows.append(
                    {"pageIndex": index, "status": "skipped", "reason": "PAGE_OUT_OF_RANGE"}
                )
                continue
            dom = _dominant(pdf, index)
            if isinstance(dom, str):
                rows.append({"pageIndex": index, "status": "skipped", "reason": dom})
                continue
            rgb = _pixels(dom)
            result = pi.split_spread(rgb)
            h, w = rgb.shape[:2]
            image = _pil(rgb)
            # The preview is scaled to 900 px wide; the line is drawn at the scaled position.
            scale = min(1.0, 900 / w)
            if scale < 1.0:
                image = image.resize((round(w * scale), round(h * scale)))
            from PIL import ImageDraw

            draw = ImageDraw.Draw(image)
            x_line = round(result["split_x"] * scale)
            draw.line([(x_line, 0), (x_line, image.height)], fill=(220, 30, 30), width=3)
            path = out_dir / f"{ctx.job_id[:8]}-p{index}-spine.png"
            image.save(path)
            rows.append(
                {
                    "pageIndex": index,
                    "status": "done",
                    "previewPath": str(path),
                    "autoX": round(result["split_x"] / w, 4),
                    "confidence": result["confidence"],
                }
            )
    return OpOutput(changed_pages=[], data={"pages": rows})


# -- pageimg.pagePreview (read-only) -------------------------------------------------------


class PagePreviewParams(WireModel):
    """Read-only picture of one page image, for the editors that draw on it (T8.03)."""

    page_index: PageIndex


@operation(
    id="pageimg.pagePreview",
    title="Preview page image",
    group="pageimg",
    params=PagePreviewParams,
)
def page_preview(ctx: OpContext, p: PagePreviewParams) -> OpOutput:
    """Write the page image as a PNG at most 900 px wide; the document does not change."""
    if ctx.input_path is None:
        raise RuntimeError("pageimg.pagePreview needs a session")
    with ctx.open_input() as pdf:
        if p.page_index >= len(pdf.pages):
            raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": p.page_index})
        dom = _dominant(pdf, p.page_index)
        if isinstance(dom, str):
            return OpOutput(
                changed_pages=[],
                data={"pageIndex": p.page_index, "status": "skipped", "reason": dom},
            )
        rgb = _pixels(dom)
    h, w = rgb.shape[:2]
    image = _pil(rgb)
    scale = min(1.0, 900 / w)
    if scale < 1.0:
        image = image.resize((round(w * scale), round(h * scale)))
    out_dir = ctx.input_path.parent / "preview" / "pageimg-page"
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"{ctx.job_id[:8]}-p{p.page_index}.png"
    image.save(path, format="PNG")
    return OpOutput(
        changed_pages=[],
        data={
            "pageIndex": p.page_index,
            "status": "done",
            "previewPath": str(path),
            "pixelSize": [w, h],
        },
    )


# -- pageimg.proposeFingerMask (read-only) and pageimg.removeFingers ------------------------


class ProposeFingerMaskParams(WireModel):
    """Propose the finger regions of a page as a mask image (no change to the document)."""

    page_index: PageIndex


@operation(
    id="pageimg.proposeFingerMask",
    title="Propose finger mask",
    group="pageimg",
    params=ProposeFingerMaskParams,
)
def propose_finger_mask(ctx: OpContext, p: ProposeFingerMaskParams) -> OpOutput:
    with ctx.open_input() as pdf:
        if p.page_index >= len(pdf.pages):
            raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": p.page_index})
        dom = _dominant(pdf, p.page_index)
        if isinstance(dom, str):
            return OpOutput(
                changed_pages=[],
                data={"pageIndex": p.page_index, "status": "skipped", "reason": dom},
            )
        rgb = _pixels(dom)
    mask = pi.find_skin_regions(rgb)
    out = _work_dir(ctx) / f"p{p.page_index}-fingers-{ctx.job_id[:8]}.png"
    Image.fromarray(mask, mode="L").save(out, format="PNG")
    # The page itself, for the editor's background (the mask has the same pixel size).
    page_path = _work_dir(ctx) / f"p{p.page_index}-page-{ctx.job_id[:8]}.png"
    _pil(rgb).save(page_path, format="PNG")
    h, w = mask.shape
    return OpOutput(
        changed_pages=[],
        outputs=[str(out)],
        data={
            "pageIndex": p.page_index,
            "status": "done",
            "maskPath": str(out),
            "pagePath": str(page_path),
            "pixelSize": [w, h],
            "coverage": round(float((mask > 0).mean()), 5),
        },
    )


class RemoveFingersParams(WireModel):
    """Erase fingers on the edges of scanned pages (L14). Use proposeFingerMask first."""

    pages: list[PageIndex] | None = Field(default=None, description="0-based; default all.")
    mode: Literal["auto", "mask"] = "auto"
    mask_png: str | None = Field(
        default=None,
        description="mode mask: PNG from proposeFingerMask (edited); white = erase. One page.",
    )
    mask_png_base64: str | None = Field(
        default=None,
        max_length=8_000_000,
        description="mode mask: the same PNG as base64 (no file write needed). Wins over maskPng.",
    )
    fill: FillPattern = "paper"
    jpeg_quality: Quality = 80


@operation(
    id="pageimg.removeFingers",
    title="Remove fingers",
    group="pageimg",
    params=RemoveFingersParams,
    destructive=True,
)
def remove_fingers(ctx: OpContext, p: RemoveFingersParams) -> OpOutput:
    if p.mode == "mask" and p.mask_png is None and p.mask_png_base64 is None:
        raise invalid_params("MASK_REQUIRED", {"mode": "mask"})
    mask_file: str | None = p.mask_png
    if p.mode == "mask" and p.mask_png_base64 is not None:
        try:
            raw = base64.b64decode(p.mask_png_base64, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise invalid_params("MASK_NOT_BASE64", {"mode": "mask"}) from exc
        mask_path = ctx.work_dir / f"finger-mask-{ctx.job_id[:8]}.png"
        mask_path.write_bytes(raw)
        mask_file = str(mask_path)
    rows: list[dict[str, Any]] = []
    changed: list[int] = []
    with ctx.open_input() as pdf:
        selected = _selected(p.pages, len(pdf.pages))
        if p.mode == "mask" and len(selected) != 1:
            raise invalid_params("MASK_NEEDS_ONE_PAGE", {"pages": len(selected)})
        for index in ctx.steps(selected, len(selected), "Remove fingers"):
            dom = _dominant(pdf, index)
            if isinstance(dom, str):
                rows.append({"pageIndex": index, "status": "skipped", "reason": dom})
                continue
            rgb = _pixels(dom)
            mask = None
            if p.mode == "mask" and mask_file is not None:
                mask = _mask_from_png(mask_file, (rgb.shape[1], rgb.shape[0]))
            out, used = pi.remove_fingers(rgb, mask, fill=p.fill)
            if not used.any():
                rows.append({"pageIndex": index, "status": "skipped", "reason": "NO_FINGERS_FOUND"})
                continue
            _replace_in_place(pdf, index, dom, out, p.jpeg_quality)
            changed.append(index)
            rows.append(
                {
                    "pageIndex": index,
                    "status": "done",
                    "coverage": round(float((used > 0).mean()), 5),
                }
            )
        if changed:
            ctx.save_document(pdf)
    return OpOutput(changed_pages=changed, data={"pages": rows})


# -- pageimg.erase and pageimg.removeStains -------------------------------------------------


class Rect(WireModel):
    """A rectangle as fractions (0..1) of the page image."""

    x: Unit
    y: Unit
    w: Unit
    h: Unit


class EraseParams(WireModel):
    """Erase rectangles or a mask on one page image and fill them with paper (L10)."""

    page_index: PageIndex
    rects: list[Rect] | None = None
    mask_path: str | None = Field(
        default=None, description="PNG mask, white = erase (instead of rects)."
    )
    fill: FillPattern = "paper"
    jpeg_quality: Quality = 80


@operation(
    id="pageimg.erase",
    title="Erase and fill",
    group="pageimg",
    params=EraseParams,
    destructive=True,
)
def erase(ctx: OpContext, p: EraseParams) -> OpOutput:
    if not p.rects and p.mask_path is None:
        raise invalid_params("ERASE_REGION_REQUIRED", {})
    with ctx.open_input() as pdf:
        if p.page_index >= len(pdf.pages):
            raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": p.page_index})
        dom = _dominant(pdf, p.page_index)
        if isinstance(dom, str):
            return OpOutput(
                changed_pages=[],
                data={"pages": [{"pageIndex": p.page_index, "status": "skipped", "reason": dom}]},
            )
        rgb = _pixels(dom)
        h, w = rgb.shape[:2]
        if p.mask_path is not None:
            region: Any = _mask_from_png(p.mask_path, (w, h))
        else:
            region = None
        out = rgb
        for rect in p.rects or []:
            out = pi.erase_region(
                out, _rect_px((rect.x, rect.y, rect.w, rect.h), w, h), fill=p.fill
            )
        if region is not None:
            out = pi.erase_region(out, region, fill=p.fill)
        _replace_in_place(pdf, p.page_index, dom, out, p.jpeg_quality)
        ctx.save_document(pdf)
    return OpOutput(
        changed_pages=[p.page_index],
        data={"pages": [{"pageIndex": p.page_index, "status": "done"}]},
    )


class RemoveStainsParams(WireModel):
    """Erase one ink colour (blue pen, highlighter, red stamp) from page images (L11)."""

    pages: list[PageIndex] | None = Field(default=None, description="0-based; default all.")
    hue_min: float = Field(
        ge=0, le=360, description="Hue start in degrees (red 0, yellow 60, green 120, blue 240)."
    )
    hue_max: float = Field(
        ge=0, le=360, description="Hue end in degrees; less than hueMin wraps around red."
    )
    min_saturation: float = Field(default=0.4, ge=0, le=1)
    fill: FillPattern = "paper"
    jpeg_quality: Quality = 80


@operation(
    id="pageimg.removeStains",
    title="Remove colour stains",
    group="pageimg",
    params=RemoveStainsParams,
    destructive=True,
)
def remove_stains(ctx: OpContext, p: RemoveStainsParams) -> OpOutput:
    rows: list[dict[str, Any]] = []
    changed: list[int] = []
    with ctx.open_input() as pdf:
        selected = _selected(p.pages, len(pdf.pages))
        for index in ctx.steps(selected, len(selected), "Remove colour"):
            dom = _dominant(pdf, index)
            if isinstance(dom, str):
                rows.append({"pageIndex": index, "status": "skipped", "reason": dom})
                continue
            rgb = _pixels(dom)
            if rgb.ndim != 3:
                rows.append({"pageIndex": index, "status": "skipped", "reason": "GRAYSCALE_IMAGE"})
                continue
            out, mask = pi.remove_color_stains(
                rgb, hue_range=(p.hue_min, p.hue_max), min_saturation=p.min_saturation, fill=p.fill
            )
            if not mask.any():
                rows.append({"pageIndex": index, "status": "skipped", "reason": "NO_STAIN_FOUND"})
                continue
            _replace_in_place(pdf, index, dom, out, p.jpeg_quality)
            changed.append(index)
            rows.append(
                {
                    "pageIndex": index,
                    "status": "done",
                    "coverage": round(float((mask > 0).mean()), 5),
                }
            )
        if changed:
            ctx.save_document(pdf)
    return OpOutput(changed_pages=changed, data={"pages": rows})
