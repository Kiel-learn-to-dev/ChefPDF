"""Preview and size estimate for scan.rasterize (K5, K6).

``scan.preview`` renders a few sample pages with the real pipeline and extrapolates their size
and time. The same estimator drives ``scan.fitSize`` (scan_fit.py).

It is a session operation that is not destructive: it reads the current revision, writes PNG
files next to the session files and never commits a revision.
"""

from __future__ import annotations

import io
import shutil
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any, cast

import pikepdf
import pypdfium2 as pdfium
from PIL import Image
from pydantic import Field

from chef_core.ops import scan
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.ops.scan import EncodeOptions, PageIndex, RasterizeParams
from chef_core.pdf.pages import check_indices, unique_sorted
from chef_core.pdf.rasterize import encode_image_page, rasterize_page

PAGE_OVERHEAD_BYTES = 2048  # fixed cost per page: page dictionary, content stream, xref
MAX_SAMPLES = 3


def estimate_bytes(sample_sizes: Sequence[int], pages: int) -> int:
    """Mean sampled page size plus the fixed overhead, for ``pages`` pages."""
    mean = sum(sample_sizes) / len(sample_sizes)
    return round((mean + PAGE_OVERHEAD_BYTES) * pages)


def estimate_seconds(sample_seconds: Sequence[float], pages: int) -> float:
    """Mean sampled page time, divided by the workers the real op would use (at least 0.1 s)."""
    per_page = sum(sample_seconds) / len(sample_seconds)
    parallel = scan.MAX_WORKERS if pages >= scan.POOL_MIN_PAGES else 1
    return max(0.1, per_page * pages / parallel)


def default_samples(selected: list[int]) -> list[int]:
    """The first selected page and, with more than one page, the middle selected page."""
    picks = [selected[0]]
    if len(selected) > 1:
        picks.append(selected[len(selected) // 2])
    return picks


def sample_pages_for(requested: list[int] | None, selected: list[int], count: int) -> list[int]:
    if requested is None:
        return default_samples(selected)
    return unique_sorted(check_indices(requested, count, "samplePages"))


def measure_pages(
    source: pdfium.PdfDocument, pages: Sequence[int], opts: EncodeOptions
) -> tuple[list[int], list[float]]:
    """Encoded size in bytes and encode time in seconds of each page, as the real op makes them."""
    sizes: list[int] = []
    seconds: list[float] = []
    for index in pages:
        started = time.perf_counter()
        sizes.append(len(scan.encode_result_page(source, index, opts)))
        seconds.append(time.perf_counter() - started)
    return sizes, seconds


def source_document(ctx: OpContext) -> pdfium.PdfDocument:
    if ctx.input_path is None:
        raise RuntimeError("operation needs a session but none was given")
    return pdfium.PdfDocument(str(ctx.input_path))


# -- scan.preview ---------------------------------------------------------------------


class PreviewParams(RasterizeParams):
    """Rasterize parameters plus the pages to preview."""

    sample_pages: list[PageIndex] | None = Field(
        default=None,
        min_length=1,
        max_length=MAX_SAMPLES,
        description="0-based pages to preview (at most 3); default: first and middle selected.",
    )


def _preview_dir(ctx: OpContext) -> Path:
    """Per-session folder for preview images. Each run replaces the previous previews."""
    if ctx.input_path is None:
        raise RuntimeError("operation needs a session but none was given")
    directory = ctx.input_path.parent / "preview"
    shutil.rmtree(directory, ignore_errors=True)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def _decode(encoded: bytes) -> Image.Image:
    """The image embedded in a one-page image PDF, decoded to pixels (exactly as encoded)."""
    with pikepdf.open(io.BytesIO(encoded)) as pdf:
        image = cast(pikepdf.Stream, next(iter(pdf.pages[0].images.values())))
        decoded: Image.Image = pikepdf.PdfImage(image).as_pil_image()
    return decoded


@operation(
    id="scan.preview",
    title="Preview scan conversion",
    group="scan",
    params=PreviewParams,
)
def preview(ctx: OpContext, p: PreviewParams) -> OpOutput:
    with ctx.open_input() as pdf:
        count = len(pdf.pages)
        selected = scan.selected_pages(p.pages, count)
        scan.check_page_budget(pdf, selected, p.dpi)
        samples = sample_pages_for(p.sample_pages, selected, count)
        warnings = scan.scan_loss_warnings(pdf)

    out_dir = _preview_dir(ctx)
    opts = scan.encode_options(p)
    rows: list[dict[str, Any]] = []
    sizes: list[int] = []
    seconds: list[float] = []
    source = source_document(ctx)
    try:
        for done, index in enumerate(samples):
            ctx.progress(done, len(samples), "Preview")
            original = rasterize_page(source, index, p.dpi, p.color, p.threshold, p.dithering)
            original_path = out_dir / f"{ctx.job_id[:8]}-p{index}-original.png"
            original.save(original_path)

            started = time.perf_counter()
            img = scan.render_result_page(source, index, opts)
            encoded = encode_image_page(img, p.dpi, p.color, p.jpeg_quality)
            seconds.append(time.perf_counter() - started)
            sizes.append(len(encoded))

            result_path = out_dir / f"{ctx.job_id[:8]}-p{index}-result.png"
            _decode(encoded).save(result_path)
            rows.append(
                {
                    "pageIndex": index,
                    "originalPath": str(original_path),
                    "resultPath": str(result_path),
                    "widthPx": img.width,
                    "heightPx": img.height,
                    "encodedBytes": len(encoded),
                }
            )
    finally:
        source.close()

    pages = len(selected)
    estimate = {
        "estimatedBytes": estimate_bytes(sizes, pages),
        "estimatedSeconds": round(estimate_seconds(seconds, pages), 2),
        "lossWarnings": warnings,
    }
    return OpOutput(changed_pages=[], data={"samples": rows, "estimate": estimate})
