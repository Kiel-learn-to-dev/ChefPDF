"""Scan conversion (group K): scan.rasterize turns the document into an image-only PDF.

Pages are rendered in a process pool (PDFium is not thread-safe). Each worker writes the encoded
page image (JPEG or TIFF G4 bytes) into the job work directory, so the parent never holds encoded
pages in RAM. When every page is ready, img2pdf assembles the images into one PDF file, streamed
to disk. Unselected pages are copied from the source document. The number of workers is capped
by a RAM budget (worker_count), so big pages mean fewer workers.
"""

from __future__ import annotations

import contextlib
import math
import os
import sys
from collections import deque
from collections.abc import Generator
from concurrent.futures import Future, ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal

import pikepdf
import pypdfium2 as pdfium
from PIL import Image
from pydantic import Field

from chef_core.errors import invalid_params
from chef_core.imaging.effects import ScanEffects, apply_scan_effects, get_preset
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.pdf.outline import read_bookmarks
from chef_core.pdf.pages import check_indices, display_size, replace_page_order, unique_sorted
from chef_core.pdf.rasterize import (
    ColorMode,
    assemble_image_pdf,
    convert_mode,
    encode_image_bytes,
    encode_image_page,
    image_suffix,
    rasterize_page,
)
from chef_core.session.info import has_signatures

PageIndex = Annotated[int, Field(ge=0)]
EffectPresetName = Literal["none", "light", "photocopy", "old-paper"]

# Rendering is CPU-bound and PDFium is single-threaded, so processes, not threads.
MAX_WORKER_PROCESSES = 4
MAX_WORKERS = min(os.cpu_count() or 1, MAX_WORKER_PROCESSES)
POOL_MIN_PAGES = 8  # below this, rendering inline is cheaper than starting workers
# The worker pool never starts its workers inside the packaged core (PyInstaller, Windows): the job
# waits forever on a 40-page merge (NOTES 2026-11-04). The packaged app renders inline, which took
# 1.0 s for 40 pages at 200 dpi here; the pool stays on in dev, where it works.
POOL_ENABLED = not getattr(sys, "frozen", False)
# Largest rendered page accepted (about 200 MB as RGBA). A4 is about 720 dpi at this limit.
MAX_PAGE_PIXELS = 50_000_000
# Memory guard: the bitmaps of all workers together should fit in this budget.
RAM_BUDGET_BYTES = int(1.5 * 1024**3)
RAM_BUDGET_ENV = "CHEF_SCAN_RAM_MB"  # overrides RAM_BUDGET_BYTES, in MiB (used by tests)
BITMAP_BYTES_PER_PIXEL = 4  # PDFium renders BGRA
BITMAP_COPY_FACTOR = 2  # the render and the converted copy are alive at the same time
# Catalog entries that do not refer to pages: kept from the source (the rest is dropped).
CARRIED_CATALOG_KEYS = ("/Lang", "/PageLayout", "/PageMode", "/PageLabels", "/ViewerPreferences")

TEXT_SHOW_OPERATORS = frozenset({"Tj", "TJ", "'", '"'})


@dataclass(frozen=True)
class EncodeOptions:
    dpi: int
    color: ColorMode
    threshold: int
    dithering: bool
    jpeg_quality: int
    effects: ScanEffects | None = None
    seed: int = 0


# -- loss warnings --------------------------------------------------------------------


def _has_text(pdf: pikepdf.Pdf) -> bool:
    for page in pdf.pages:
        for instruction in pikepdf.parse_content_stream(page):
            if isinstance(instruction, pikepdf.ContentStreamInstruction) and (
                str(instruction.operator) in TEXT_SHOW_OPERATORS
            ):
                return True
    return False


def _has_links(pdf: pikepdf.Pdf) -> bool:
    for page in pdf.pages:
        for annot in page.obj.get("/Annots", []):
            if isinstance(annot, pikepdf.Dictionary) and annot.get("/Subtype") == "/Link":
                return True
    return False


def _has_form_fields(pdf: pikepdf.Pdf) -> bool:
    acro_form = pdf.Root.get("/AcroForm")
    return isinstance(acro_form, pikepdf.Dictionary) and len(acro_form.get("/Fields", [])) > 0


def scan_loss_warnings(pdf: pikepdf.Pdf) -> list[str]:
    """Warnings for the content that a conversion to images drops, only for what is present."""
    warnings: list[str] = []
    if _has_text(pdf):
        warnings.append("Text will be lost: converted pages become images without text.")
    if _has_links(pdf):
        warnings.append("Links will be lost.")
    if read_bookmarks(pdf):
        warnings.append("Bookmarks will be lost.")
    if _has_form_fields(pdf):
        warnings.append("Form fields will be lost.")
    if has_signatures(pdf):
        warnings.append("Digital signatures will be lost.")
    return warnings


# -- rendering ------------------------------------------------------------------------


def resolve_effects(p: RasterizeParams) -> ScanEffects | None:
    """Explicit ``effects`` win over ``effectsPreset``; neither given means no effects."""
    if p.effects is not None:
        return p.effects
    if p.effects_preset is not None:
        return get_preset(p.effects_preset)
    return None


def encode_options(p: RasterizeParams) -> EncodeOptions:
    return EncodeOptions(
        dpi=p.dpi,
        color=p.color,
        threshold=p.threshold,
        dithering=p.dithering,
        jpeg_quality=p.jpeg_quality,
        effects=resolve_effects(p),
        seed=p.seed,
    )


def render_result_page(source: pdfium.PdfDocument, index: int, opts: EncodeOptions) -> Image.Image:
    """The page image that scan.rasterize encodes: rendered, optionally with effects."""
    if opts.effects is None:
        return rasterize_page(source, index, opts.dpi, opts.color, opts.threshold, opts.dithering)
    # Effects need grey levels, so they run before a bw threshold, never on the 1-bit result.
    grey_mode: ColorMode = "color" if opts.color == "color" else "gray"
    img = rasterize_page(source, index, opts.dpi, grey_mode)
    img = apply_scan_effects(img, opts.effects, index, opts.seed)
    return convert_mode(img, opts.color, opts.threshold, opts.dithering)


def encode_result_page(source: pdfium.PdfDocument, index: int, opts: EncodeOptions) -> bytes:
    """One page as a one-page image PDF (used by previews and size estimates)."""
    img = render_result_page(source, index, opts)
    return encode_image_page(img, opts.dpi, opts.color, opts.jpeg_quality)


def encode_result_image(source: pdfium.PdfDocument, index: int, opts: EncodeOptions) -> bytes:
    """The encoded page image (JPEG or TIFF G4 bytes) that the final PDF embeds unchanged."""
    img = render_result_page(source, index, opts)
    return encode_image_bytes(img, opts.dpi, opts.color, opts.jpeg_quality)


def _render_to_file(source: pdfium.PdfDocument, index: int, opts: EncodeOptions, out: Path) -> Path:
    out.write_bytes(encode_result_image(source, index, opts))
    return out


def page_bitmap_bytes(width_pt: float, height_pt: float, dpi: int) -> int:
    """Estimated RAM needed to render one page: pixels x bytes per pixel x copies alive."""
    pixels = math.ceil(width_pt * dpi / 72) * math.ceil(height_pt * dpi / 72)
    return pixels * BITMAP_BYTES_PER_PIXEL * BITMAP_COPY_FACTOR


def largest_page_bytes(pdf: pikepdf.Pdf, pages: list[int], dpi: int) -> int:
    """The biggest per-page estimate over the selected pages (1 when there are none)."""
    sizes: list[int] = []
    for index in pages:
        width, height, _ = display_size(pdf.pages[index])
        if width > 0 and height > 0:
            sizes.append(page_bitmap_bytes(width, height, dpi))
    return max(sizes, default=1)


def ram_budget_bytes() -> int:
    """RAM_BUDGET_BYTES, or CHEF_SCAN_RAM_MB (MiB) when that variable holds a positive integer."""
    raw = os.environ.get(RAM_BUDGET_ENV, "")
    try:
        mebibytes = int(raw)
    except ValueError:
        return RAM_BUDGET_BYTES
    return mebibytes * 1024 * 1024 if mebibytes > 0 else RAM_BUDGET_BYTES


def worker_count(per_page_bytes: int, cpus: int, budget_bytes: int) -> int:
    """min(cpus, 4, max(1, budget // per_page)): never zero, never more than the budget allows."""
    if not POOL_ENABLED:
        return 1
    fitting = max(1, budget_bytes // max(1, per_page_bytes))
    return max(1, min(cpus, MAX_WORKER_PROCESSES, fitting))


def check_page_budget(pdf: pikepdf.Pdf, pages: list[int], dpi: int) -> None:
    """Refuse a dpi whose rendered pages would exceed MAX_PAGE_PIXELS."""
    max_dpi = 1200.0
    for index in pages:
        width, height, _ = display_size(pdf.pages[index])
        if width <= 0 or height <= 0:
            continue
        allowed = 72 * (MAX_PAGE_PIXELS / (width * height)) ** 0.5
        max_dpi = min(max_dpi, allowed)
    if dpi > max_dpi:
        limit = int(max_dpi)
        raise invalid_params(
            f"Pages are too large for {dpi} dpi (at most {limit} dpi for this document).",
            {"field": "dpi", "maxDpi": limit},
        )


# Per worker process: the source document stays open while the pool lives (one pool per job).
_worker_doc: tuple[str, pdfium.PdfDocument] | None = None


def _render_worker(source: str, index: int, opts: EncodeOptions, out: str) -> str:
    global _worker_doc
    if _worker_doc is None or _worker_doc[0] != source:
        if _worker_doc is not None:
            _worker_doc[1].close()
        _worker_doc = (source, pdfium.PdfDocument(source))
    return str(_render_to_file(_worker_doc[1], index, opts, Path(out)))


def _image_path(ctx: OpContext, index: int, opts: EncodeOptions) -> Path:
    return ctx.work_dir / f"page-{index:05d}{image_suffix(opts.color)}"


def _rasterized_pages(
    ctx: OpContext, source: Path, pages: list[int], opts: EncodeOptions, workers: int
) -> Generator[tuple[int, Path], None, None]:
    """Yield ``(page index, encoded page image path)`` in page order."""
    total = len(pages)
    if total < POOL_MIN_PAGES or workers <= 1:
        doc = pdfium.PdfDocument(str(source))
        try:
            for done, index in enumerate(pages):
                ctx.progress(done, total, "Rasterizing")
                yield index, _render_to_file(doc, index, opts, _image_path(ctx, index, opts))
        finally:
            doc.close()
        ctx.progress(total, total)
        return

    window = workers * 2
    pool = ProcessPoolExecutor(max_workers=workers)
    pending: deque[tuple[int, Future[str], Path]] = deque()
    queue = iter(pages)

    def submit_next() -> None:
        index = next(queue, None)
        if index is None:
            return
        out = _image_path(ctx, index, opts)
        future = pool.submit(_render_worker, str(source), index, opts, str(out))
        pending.append((index, future, out))

    try:
        for _ in range(window):
            submit_next()
        done = 0
        while pending:
            ctx.progress(done, total, "Rasterizing")
            index, future, out = pending.popleft()
            future.result()
            submit_next()
            done += 1
            yield index, out
        ctx.progress(total, total)
    finally:
        # Cancels queued pages; running ones finish (one page each) before the pool is gone.
        pool.shutdown(wait=True, cancel_futures=True)


# -- operation ------------------------------------------------------------------------


class RasterizeParams(WireModel):
    """Convert pages to images. Selected pages lose their text, links and form fields."""

    dpi: int = Field(default=200, ge=72, le=1200, description="Render resolution in dpi.")
    color: ColorMode = Field(
        default="gray", description="'color' (JPEG RGB), 'gray' (JPEG gray) or 'bw' (1-bit G4)."
    )
    threshold: int = Field(
        default=128, ge=0, le=255, description="bw only: gray level from which a pixel is white."
    )
    dithering: bool = Field(default=False, description="bw only: Floyd-Steinberg dithering.")
    jpeg_quality: int = Field(default=75, ge=1, le=100, description="JPEG quality (color, gray).")
    pages: list[PageIndex] | None = Field(
        default=None, min_length=1, description="0-based pages to convert; default all."
    )
    strip_metadata: bool = Field(
        default=True, description="Remove the document information dictionary and XMP."
    )
    effects: ScanEffects | None = Field(
        default=None, description="Scanner look applied to each page before encoding."
    )
    effects_preset: EffectPresetName | None = Field(
        default=None, description="Name of a built-in effects preset; ignored if effects is set."
    )
    seed: int = Field(
        default=0, ge=0, description="Seed for the effects' randomness: same seed, same output."
    )


def selected_pages(pages: list[int] | None, count: int) -> list[int]:
    """Validated, sorted 0-based pages; all pages when ``pages`` is None."""
    if pages is None:
        return list(range(count))
    return unique_sorted(check_indices(pages, count))


@operation(
    id="scan.rasterize",
    title="Convert to scanned PDF",
    group="scan",
    params=RasterizeParams,
    destructive=True,
)
def rasterize(ctx: OpContext, p: RasterizeParams) -> OpOutput:
    opts = encode_options(p)
    with ctx.open_input() as source_pdf:
        count = len(source_pdf.pages)
        selected = selected_pages(p.pages, count)
        check_page_budget(source_pdf, selected, p.dpi)
        for message in scan_loss_warnings(source_pdf):
            ctx.warn(message)
        workers = worker_count(
            largest_page_bytes(source_pdf, selected, p.dpi), MAX_WORKERS, ram_budget_bytes()
        )

        source = Path(ctx.input_path or "")
        images: list[Path] = []
        assembled = ctx.work_dir / "scan-pages.pdf"
        try:
            with contextlib.closing(
                _rasterized_pages(ctx, source, selected, opts, workers)
            ) as pages_iter:
                for _, image in pages_iter:
                    images.append(image)
            ctx.check_cancelled()
            assemble_image_pdf(images, p.dpi, assembled)
            with pikepdf.open(assembled) as pdf:
                _arrange_pages(pdf, source_pdf, selected, count)
                _carry_document_parts(pdf, source_pdf, p.strip_metadata)
                _drop_document_content(pdf, p.strip_metadata)
                ctx.save_document(pdf)
        finally:
            for image in images:
                image.unlink(missing_ok=True)
            assembled.unlink(missing_ok=True)
    return OpOutput(changed_pages=selected)


def _arrange_pages(pdf: pikepdf.Pdf, source: pikepdf.Pdf, selected: list[int], count: int) -> None:
    """Page order of the result: the converted pages (in ``pdf``) at the selected positions and
    the source pages copied in everywhere else."""
    converted = dict(zip(selected, (page.obj for page in pdf.pages), strict=True))
    order: list[pikepdf.Object] = []
    for index in range(count):
        if index in converted:
            order.append(converted[index])
            continue
        original = source.pages[index]
        _materialize_inherited(original)
        pdf.pages.append(original)
        order.append(pdf.pages[-1].obj)
    replace_page_order(pdf, order)


def _materialize_inherited(page: pikepdf.Page) -> None:
    """Write inherited page attributes into the page itself, so they survive being copied."""
    if "/MediaBox" not in page.obj:
        page.obj.MediaBox = pikepdf.Array([float(v) for v in page.mediabox])
    if "/CropBox" not in page.obj:
        page.obj.CropBox = pikepdf.Array([float(v) for v in page.cropbox])
    if "/Rotate" not in page.obj:
        page.obj.Rotate = page.rotation
    if "/Resources" not in page.obj:
        inherited = page.obj.Parent.get("/Resources") if "/Parent" in page.obj else None
        if inherited is not None:
            page.obj.Resources = inherited


def _foreign_copy(pdf: pikepdf.Pdf, value: pikepdf.Object) -> pikepdf.Object:
    """A copy of ``value`` (from another document) that can be stored in ``pdf``."""
    return pdf.copy_foreign(value) if value.is_indirect else value


def _carry_document_parts(pdf: pikepdf.Pdf, source: pikepdf.Pdf, strip_metadata: bool) -> None:
    """Keep the catalog entries that do not refer to pages; metadata only when not stripped."""
    # img2pdf derives its file ID from the time it wrote; atomic_save makes a content-based one.
    if "/ID" in pdf.trailer:
        del pdf.trailer["/ID"]
    for key in CARRIED_CATALOG_KEYS:
        if key in source.Root:
            pdf.Root[key] = _foreign_copy(pdf, source.Root[key])
    if strip_metadata:
        return
    if "/Info" in source.trailer:
        pdf.trailer["/Info"] = _foreign_copy(pdf, source.trailer["/Info"])
    elif "/Info" in pdf.trailer:
        del pdf.trailer["/Info"]
    if "/Metadata" in source.Root:
        pdf.Root.Metadata = _foreign_copy(pdf, source.Root.Metadata)
    elif "/Metadata" in pdf.Root:
        del pdf.Root["/Metadata"]


def _drop_document_content(pdf: pikepdf.Pdf, strip_metadata: bool) -> None:
    """Remove what refers to the removed text, links, bookmarks and fields, and metadata."""
    for key in ("/Outlines", "/AcroForm", "/StructTreeRoot"):
        if key in pdf.Root:
            del pdf.Root[key]
    for page in pdf.pages:
        annots = page.obj.get("/Annots")
        if isinstance(annots, pikepdf.Array):
            kept = [
                a
                for a in annots
                if not (
                    isinstance(a, pikepdf.Dictionary) and a.get("/Subtype") in ("/Link", "/Widget")
                )
            ]
            if kept:
                page.obj.Annots = pikepdf.Array(kept)
            else:
                del page.obj["/Annots"]
        if strip_metadata and "/Metadata" in page.obj:
            del page.obj["/Metadata"]
    if strip_metadata:
        if "/Info" in pdf.trailer:
            del pdf.trailer["/Info"]
        if "/Metadata" in pdf.Root:
            del pdf.Root["/Metadata"]
