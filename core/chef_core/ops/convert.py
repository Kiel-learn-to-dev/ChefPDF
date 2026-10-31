"""Convert between PDF and images (features M2, M3).

- ``convert.pdfToImages`` (M2): render pages to PNG, JPEG, TIFF (single or multi-page) or WebP.
  Standalone: it reads ``path`` (the UI passes the session's source file).
- ``convert.imagesToPdf`` (M3): one PDF page per image (one per frame for multi-frame TIFF).
  Standalone. JPEG data is embedded as it is (no re-encoding); other formats are embedded
  losslessly by img2pdf, or flattened onto white when img2pdf cannot take them (alpha, GIF, BMP,
  WebP). EXIF orientation is applied with a transformation matrix.

Inserting image pages into an open session is page.insertImages (ops/page.py).
"""

from __future__ import annotations

import io
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import pikepdf
import pypdfium2 as pdfium
from pikepdf import Array, Dictionary, Name
from PIL import Image
from pydantic import Field

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.imaging.images import _img2pdf_doc, _matrix, _orientation
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.pdf.io import atomic_save
from chef_core.pdf.pages import A4, LETTER
from chef_core.pdf.rasterize import ColorMode, rasterize_page

MM = 72 / 25.4
MAX_IMAGE_FILES = 2000
_BAD_CHARS = set('\\/:*?"<>|')


def _safe_name(text: str) -> str:
    cleaned = "".join("_" if (c in _BAD_CHARS or ord(c) < 32) else c for c in text)
    cleaned = cleaned.strip().rstrip(".")
    return cleaned or "output"


def _unique(path: Path, taken: set[str]) -> Path:
    """``name.ext``, then ``name (2).ext``...: never overwrite and never repeat in one run."""
    candidate = path
    number = 2
    while candidate.exists() or str(candidate).casefold() in taken:
        candidate = path.with_name(f"{path.stem} ({number}){path.suffix}")
        number += 1
    taken.add(str(candidate).casefold())
    return candidate


def _open_source(path: Path, password: str | None) -> pdfium.PdfDocument:
    if not path.is_file():
        raise ChefError(ErrorKind.FILE_NOT_FOUND, "File not found", {"path": str(path)})
    return pdfium.PdfDocument(str(path), password=password)


# -- convert.pdfToImages --------------------------------------------------------------

ImageFormat = Literal["png", "jpeg", "tiff", "webp"]
_SUFFIX: dict[str, str] = {"png": ".png", "jpeg": ".jpg", "tiff": ".tif", "webp": ".webp"}


class PdfToImagesParams(WireModel):
    """Render pages of a PDF to image files in ``outputDir``."""

    path: str = Field(min_length=1, description="PDF to render.")
    password: str | None = Field(default=None, description="Password of the PDF.")
    pages: list[int] | None = Field(
        default=None, min_length=1, description="0-based pages; default all."
    )
    format: ImageFormat = Field(default="png")
    dpi: int = Field(default=150, ge=36, le=600, description="Render resolution.")
    color: ColorMode = Field(
        default="color", description="'color' RGB, 'gray', or 'bw' (1-bit, threshold 128)."
    )
    jpeg_quality: int = Field(default=90, ge=1, le=100, description="JPEG and WebP quality.")
    multi_page_tiff: bool = Field(
        default=False, description="TIFF only: one file with all pages instead of one per page."
    )
    output_dir: str = Field(min_length=1, description="Directory for the image files.")
    name_template: str = Field(
        default="{name}_{page}",
        min_length=1,
        description="File name: {name} (PDF name) and {page} (1-based, zero-padded).",
    )


def _save_image(
    img: Image.Image, path: Path, fmt: ImageFormat, dpi: int, quality: int, color: ColorMode
) -> None:
    if fmt == "png":
        img.save(path, format="PNG", dpi=(dpi, dpi))
    elif fmt == "jpeg":
        (img.convert("L") if img.mode == "1" else img).save(
            path, format="JPEG", quality=quality, dpi=(dpi, dpi)
        )
    elif fmt == "webp":
        (img.convert("L") if img.mode == "1" else img).save(path, format="WEBP", quality=quality)
    elif color == "bw":
        img.save(path, format="TIFF", compression="group4", dpi=(dpi, dpi))
    else:
        img.save(path, format="TIFF", compression="tiff_lzw", dpi=(dpi, dpi))


def save_frames(frames: Sequence[Image.Image], target: Path, dpi: int, color: ColorMode) -> None:
    """One multi-page TIFF from already rendered pages."""
    compression = "group4" if color == "bw" else "tiff_lzw"
    frames[0].save(
        target,
        format="TIFF",
        compression=compression,
        dpi=(dpi, dpi),
        save_all=True,
        append_images=list(frames[1:]),
    )


@operation(
    id="convert.pdfToImages",
    title="PDF to images",
    group="convert",
    params=PdfToImagesParams,
    standalone=True,
)
def pdf_to_images(ctx: OpContext, p: PdfToImagesParams) -> OpOutput:
    src_path = Path(p.path).expanduser().absolute()
    out_dir = Path(p.output_dir).expanduser().absolute()
    if out_dir.exists() and not out_dir.is_dir():
        raise invalid_params("outputDir is not a directory", {"field": "outputDir"})
    out_dir.mkdir(parents=True, exist_ok=True)
    doc = _open_source(src_path, p.password)
    try:
        count = len(doc)
        if p.pages is None:
            selected = list(range(count))
        else:
            bad = [i for i in p.pages if i >= count]
            if bad:
                raise invalid_params(
                    "page index out of range", {"field": "pages", "pageCount": count}
                )
            selected = sorted(set(p.pages))
        width = len(str(count))
        taken: set[str] = set()
        outputs: list[str] = []
        name = src_path.stem
        if p.format == "tiff" and p.multi_page_tiff:
            frames: list[Image.Image] = []
            for index in ctx.steps(selected, len(selected), "rendering"):
                frames.append(rasterize_page(doc, index, p.dpi, p.color))
            stem = _safe_name(
                p.name_template.replace("{name}", name).replace(
                    "{page}", f"{selected[0] + 1}-{selected[-1] + 1}"
                )
            )
            target = _unique(out_dir / f"{stem}.tif", taken)
            ctx.check_cancelled()
            save_frames(frames, target, p.dpi, p.color)
            outputs.append(str(target))
        else:
            for index in ctx.steps(selected, len(selected), "rendering"):
                ctx.check_cancelled()
                img = rasterize_page(doc, index, p.dpi, p.color)
                page = str(index + 1).zfill(width)
                stem = _safe_name(p.name_template.replace("{name}", name).replace("{page}", page))
                target = _unique(out_dir / f"{stem}{_SUFFIX[p.format]}", taken)
                _save_image(img, target, p.format, p.dpi, p.jpeg_quality, p.color)
                outputs.append(str(target))
    finally:
        doc.close()
    return OpOutput(changed_pages=[], outputs=outputs, data={"pages": len(selected)})


# -- convert.imagesToPdf --------------------------------------------------------------

PageSizeMode = Literal["fit-image", "a4", "letter", "custom"]


class ImagesToPdfParams(WireModel):
    """Make a PDF with one page per image, in the order given."""

    images: list[str] = Field(
        min_length=1, max_length=MAX_IMAGE_FILES, description="Image files, in page order."
    )
    output_path: str = Field(min_length=1, description="PDF to write.")
    page_size: PageSizeMode = Field(
        default="a4",
        description="'fit-image': page = image plus margin; 'a4' / 'letter' / 'custom': image "
        "placed on that page.",
    )
    custom_width_mm: float | None = Field(default=None, gt=0, le=2000)
    custom_height_mm: float | None = Field(default=None, gt=0, le=2000)
    margin_mm: float = Field(default=10, ge=0, le=100)
    orientation: Literal["auto", "portrait", "landscape"] = Field(
        default="auto", description="auto: landscape page for landscape images."
    )
    fit: Literal["fit", "fill", "center"] = Field(
        default="fit",
        description="fit: whole image inside the page; fill: cover the page (overflow clipped); "
        "center: natural size, centred and clipped to the page.",
    )
    dpi: int | None = Field(
        default=None, ge=36, le=2400, description="Natural size in dpi; default: image metadata."
    )


@dataclass
class _Frame:
    """One image frame, ready to be placed: its XObject and the displayed size in points."""

    image: pikepdf.Object
    orientation: int
    width: float
    height: float


def _frames(data: bytes, dpi: int | None) -> tuple[pikepdf.Pdf, list[_Frame]]:
    """Frames of an image file as an img2pdf document, with their natural sizes."""
    orientation = _orientation(data)
    pdf_bytes, applied = _img2pdf_doc(data)
    if applied:
        orientation = 1
    src = pikepdf.open(io.BytesIO(pdf_bytes))
    frames: list[_Frame] = []
    for page in src.pages:
        xobjects = page.resources.get("/XObject")
        if not isinstance(xobjects, Dictionary) or not xobjects.keys():
            continue
        image = xobjects[next(iter(xobjects.keys()))]
        if dpi is None:
            box = [float(v) for v in page.mediabox]
            width, height = box[2] - box[0], box[3] - box[1]
        else:
            width = int(image.Width) * 72 / dpi
            height = int(image.Height) * 72 / dpi
        frames.append(_Frame(image, orientation, width, height))
    if not frames:
        src.close()
        raise invalid_params("Image could not be converted")
    return src, frames


def _layout(
    frame: _Frame, p: ImagesToPdfParams
) -> tuple[float, float, list[str], tuple[float, float, float, float, float, float]]:
    """(page width, page height, clip operators, cm matrix) for one frame."""
    disp_w, disp_h = frame.width, frame.height
    if frame.orientation >= 5:
        disp_w, disp_h = disp_h, disp_w
    margin = p.margin_mm * MM
    if p.page_size == "fit-image":
        pw, ph = disp_w + 2 * margin, disp_h + 2 * margin
        matrix = _matrix(frame.orientation, margin, margin, disp_w, disp_h)
        return pw, ph, [], matrix
    if p.page_size == "custom":
        if p.custom_width_mm is None or p.custom_height_mm is None:
            raise invalid_params(
                "customWidthMm and customHeightMm are required", {"field": "pageSize"}
            )
        pw, ph = p.custom_width_mm * MM, p.custom_height_mm * MM
    else:
        pw, ph = A4 if p.page_size == "a4" else LETTER
    landscape_image = disp_w > disp_h
    if p.page_size == "custom":
        # The size given is the page: 'auto' keeps it, an explicit orientation turns it.
        if p.orientation == "landscape":
            pw, ph = max(pw, ph), min(pw, ph)
        elif p.orientation == "portrait":
            pw, ph = min(pw, ph), max(pw, ph)
    elif p.orientation == "landscape" or (p.orientation == "auto" and landscape_image):
        pw, ph = max(pw, ph), min(pw, ph)
    else:
        pw, ph = min(pw, ph), max(pw, ph)
    avail_w, avail_h = pw - 2 * margin, ph - 2 * margin
    if avail_w <= 1 or avail_h <= 1:
        raise invalid_params("margin is too large for the page size", {"field": "marginMm"})
    if p.fit == "fit":
        scale = min(avail_w / disp_w, avail_h / disp_h)
    elif p.fit == "fill":
        scale = max(avail_w / disp_w, avail_h / disp_h)
    else:
        scale = 1.0
    w, h = disp_w * scale, disp_h * scale
    x, y = (pw - w) / 2, (ph - h) / 2
    matrix = _matrix(frame.orientation, x, y, w, h)
    clip: list[str] = []
    if p.fit != "fit":
        clip = [f"{margin:.4f} {margin:.4f} {avail_w:.4f} {avail_h:.4f} re W n"]
    return pw, ph, clip, matrix


def _build_page(dst: pikepdf.Pdf, frame: _Frame, p: ImagesToPdfParams) -> pikepdf.Page:
    pw, ph, clip, (a, b, c, d, e, f) = _layout(frame, p)
    ops = ["q", *clip, f"{a:.4f} {b:.4f} {c:.4f} {d:.4f} {e:.4f} {f:.4f} cm", "/Im0 Do", "Q"]
    page_dict = Dictionary(
        Type=Name.Page,
        MediaBox=Array([0, 0, round(pw, 4), round(ph, 4)]),
        Resources=Dictionary(XObject=Dictionary(Im0=dst.copy_foreign(frame.image))),
        Contents=dst.make_stream(("\n".join(ops) + "\n").encode("ascii")),
    )
    return pikepdf.Page(dst.make_indirect(page_dict))


@operation(
    id="convert.imagesToPdf",
    title="Images to PDF",
    group="convert",
    params=ImagesToPdfParams,
    standalone=True,
)
def images_to_pdf(ctx: OpContext, p: ImagesToPdfParams) -> OpOutput:
    out_path = Path(p.output_path).expanduser().absolute()
    if p.page_size == "custom" and (p.custom_width_mm is None or p.custom_height_mm is None):
        raise invalid_params("customWidthMm and customHeightMm are required", {"field": "pageSize"})
    dst = pikepdf.new()
    sources: list[pikepdf.Pdf] = []
    try:
        for index, path_text in enumerate(ctx.steps(p.images, len(p.images), "images")):
            path = Path(path_text).expanduser().absolute()
            if not path.is_file():
                raise ChefError(
                    ErrorKind.FILE_NOT_FOUND,
                    "Image file not found",
                    {"path": str(path), "inputIndex": index},
                )
            src, frames = _frames(path.read_bytes(), p.dpi)
            sources.append(src)
            for frame in frames:
                dst.pages.append(_build_page(dst, frame, p))

        def close_sources() -> None:
            for src_pdf in sources:
                src_pdf.close()

        atomic_save(dst, out_path, before_replace=close_sources)
    finally:
        for src in sources:
            src.close()
        dst.close()
    return OpOutput(changed_pages=[], outputs=[str(out_path)], data={"pages": len(p.images)})
