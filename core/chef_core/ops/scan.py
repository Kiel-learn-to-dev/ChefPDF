"""Scan conversion (group K): scan.rasterize turns the document into an image-only PDF.

Pages are rendered one at a time. Each rendered page is encoded into a one-page PDF in the job
work directory and copied into the document as soon as it is ready, so bitmaps never pile up.
PDFium is not thread-safe, so with several pages the rendering runs in a process pool (bounded
window of in-flight pages, results consumed in page order).
"""

from __future__ import annotations

import contextlib
import os
from collections import deque
from collections.abc import Generator
from concurrent.futures import Future, ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated

import pikepdf
import pypdfium2 as pdfium
from pydantic import Field

from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.pdf.outline import read_bookmarks
from chef_core.pdf.pages import check_indices, replace_page_order, unique_sorted
from chef_core.pdf.rasterize import ColorMode, encode_image_page, rasterize_page

PageIndex = Annotated[int, Field(ge=0)]

# Rendering is CPU-bound and PDFium is single-threaded, so processes, not threads.
MAX_WORKERS = min(os.cpu_count() or 1, 4)
POOL_MIN_PAGES = 8  # below this, rendering inline is cheaper than starting workers

TEXT_SHOW_OPERATORS = frozenset({"Tj", "TJ", "'", '"'})


@dataclass(frozen=True)
class EncodeOptions:
    dpi: int
    color: ColorMode
    threshold: int
    dithering: bool
    jpeg_quality: int


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
    return warnings


# -- rendering ------------------------------------------------------------------------


def _render_to_file(source: pdfium.PdfDocument, index: int, opts: EncodeOptions, out: Path) -> Path:
    img = rasterize_page(source, index, opts.dpi, opts.color, opts.threshold, opts.dithering)
    out.write_bytes(encode_image_page(img, opts.dpi, opts.color, opts.jpeg_quality))
    return out


# Per worker process: the source document stays open while the pool lives (one pool per job).
_worker_doc: tuple[str, pdfium.PdfDocument] | None = None


def _render_worker(source: str, index: int, opts: EncodeOptions, out: str) -> str:
    global _worker_doc
    if _worker_doc is None or _worker_doc[0] != source:
        if _worker_doc is not None:
            _worker_doc[1].close()
        _worker_doc = (source, pdfium.PdfDocument(source))
    return str(_render_to_file(_worker_doc[1], index, opts, Path(out)))


def _rasterized_pages(
    ctx: OpContext, source: Path, pages: list[int], opts: EncodeOptions
) -> Generator[tuple[int, Path], None, None]:
    """Yield ``(page index, one-page PDF path)`` in page order."""
    total = len(pages)
    if total < POOL_MIN_PAGES or MAX_WORKERS <= 1:
        doc = pdfium.PdfDocument(str(source))
        try:
            for done, index in enumerate(pages):
                ctx.progress(done, total, "Rasterizing")
                out = ctx.work_dir / f"page-{index:05d}.pdf"
                yield index, _render_to_file(doc, index, opts, out)
        finally:
            doc.close()
        ctx.progress(total, total)
        return

    window = MAX_WORKERS * 2
    pool = ProcessPoolExecutor(max_workers=MAX_WORKERS)
    pending: deque[tuple[int, Future[str], Path]] = deque()
    queue = iter(pages)

    def submit_next() -> None:
        index = next(queue, None)
        if index is None:
            return
        out = ctx.work_dir / f"page-{index:05d}.pdf"
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


@operation(
    id="scan.rasterize",
    title="Convert to scanned PDF",
    group="scan",
    params=RasterizeParams,
    destructive=True,
)
def rasterize(ctx: OpContext, p: RasterizeParams) -> OpOutput:
    opts = EncodeOptions(
        dpi=p.dpi,
        color=p.color,
        threshold=p.threshold,
        dithering=p.dithering,
        jpeg_quality=p.jpeg_quality,
    )
    with ctx.open_input() as pdf:
        count = len(pdf.pages)
        selected = (
            unique_sorted(check_indices(p.pages, count))
            if p.pages is not None
            else list(range(count))
        )
        for message in scan_loss_warnings(pdf):
            ctx.warn(message)
        originals = [page.obj for page in pdf.pages]
        replacements: dict[int, pikepdf.Object] = {}

        source = Path(ctx.input_path or "")
        with contextlib.closing(_rasterized_pages(ctx, source, selected, opts)) as pages_iter:
            for index, page_file in pages_iter:
                with pikepdf.open(page_file) as one_page:
                    pdf.pages.append(one_page.pages[0])
                    replacements[index] = pdf.pages[-1].obj
                page_file.unlink()

        order = [replacements.get(i, originals[i]) for i in range(count)]
        replace_page_order(pdf, order)
        _drop_document_content(pdf, p.strip_metadata)
        ctx.save_document(pdf)
    return OpOutput(changed_pages=selected)


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
