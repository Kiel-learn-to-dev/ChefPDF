"""Compress to a target size (K10): ``scan.fitSize`` searches JPEG quality, then dpi.

At the base dpi the JPEG quality is binary-searched from the base down to ``minJpegQuality``.
If even the lowest quality is too big, the dpi steps down (see ``dpi_ladder``) and the search
repeats. The first fit wins, so the highest dpi and then the highest quality are kept. Sizes
come from the same sampled estimator as ``scan.preview``.
"""

from __future__ import annotations

from typing import Any, Final

import pypdfium2 as pdfium
from pydantic import Field

from chef_core.errors import invalid_params
from chef_core.ops import scan
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.ops.scan import RasterizeParams
from chef_core.ops.scan_preview import (
    default_samples,
    estimate_bytes,
    measure_pages,
    source_document,
)

DPI_STEPS: Final = (300, 250, 200, 150, 120)


def dpi_ladder(base: int, min_dpi: int) -> list[int]:
    """Descending dpi values to try: the base, the usual steps below it, then ``min_dpi``."""
    candidates = {base, *DPI_STEPS, min_dpi}
    return sorted((d for d in candidates if min_dpi <= d <= base), reverse=True)


class FitSizeParams(RasterizeParams):
    """Rasterize parameters are the starting point; the search only lowers dpi and quality."""

    target_bytes: int = Field(gt=0, description="Largest acceptable size of the result in bytes.")
    min_dpi: int = Field(default=100, ge=72, le=1200, description="Lowest dpi to try.")
    min_jpeg_quality: int = Field(default=30, ge=1, le=100, description="Lowest JPEG quality.")


def _with(base: RasterizeParams, dpi: int, quality: int) -> RasterizeParams:
    data: dict[str, Any] = {name: getattr(base, name) for name in RasterizeParams.model_fields}
    data.update(dpi=dpi, jpeg_quality=quality)
    return RasterizeParams.model_validate(data)


class _Search:
    def __init__(
        self,
        ctx: OpContext,
        source: pdfium.PdfDocument,
        samples: list[int],
        pages: int,
        base: FitSizeParams,
    ) -> None:
        self.ctx = ctx
        self.source = source
        self.samples = samples
        self.pages = pages
        self.base = base
        self.steps = 0
        self._cache: dict[tuple[int, int], int] = {}
        self._smallest: tuple[int, RasterizeParams] | None = None

    def estimate(self, dpi: int, quality: int) -> int:
        """Estimated size of the whole selection at (dpi, quality); each pair is measured once."""
        key = (dpi, quality)
        if key in self._cache:
            return self._cache[key]
        self.ctx.check_cancelled()
        self.steps += 1
        params = _with(self.base, dpi, quality)
        sizes, _ = measure_pages(self.source, self.samples, scan.encode_options(params))
        value = estimate_bytes(sizes, self.pages)
        self._cache[key] = value
        if self._smallest is None or value < self._smallest[0]:
            self._smallest = (value, params)
        return value

    def run(self, target: int) -> tuple[bool, RasterizeParams, int]:
        """Return (reachable, params, estimate); unreachable gives the smallest one tried."""
        top = self.base.jpeg_quality
        floor = self.base.min_jpeg_quality
        for dpi in dpi_ladder(self.base.dpi, self.base.min_dpi):
            value = self.estimate(dpi, top)
            if value <= target:
                return True, _with(self.base, dpi, top), value
            if self.base.color == "bw" or self.estimate(dpi, floor) > target:
                continue  # bw has no quality to trade; or even the lowest quality is too big
            # Invariant: quality `ok` fits the target, quality `bad` does not.
            ok, bad = floor, top
            while bad - ok > 1:
                mid = (ok + bad) // 2
                if self.estimate(dpi, mid) <= target:
                    ok = mid
                else:
                    bad = mid
            return True, _with(self.base, dpi, ok), self.estimate(dpi, ok)
        assert self._smallest is not None
        value, params = self._smallest
        return False, params, value


@operation(
    id="scan.fitSize",
    title="Compress to a target size",
    group="scan",
    params=FitSizeParams,
)
def fit_size(ctx: OpContext, p: FitSizeParams) -> OpOutput:
    if p.min_dpi > p.dpi:
        raise invalid_params("minDpi must not be above dpi", {"field": "minDpi"})
    if p.min_jpeg_quality > p.jpeg_quality:
        raise invalid_params(
            "minJpegQuality must not be above jpegQuality", {"field": "minJpegQuality"}
        )
    with ctx.open_input() as pdf:
        count = len(pdf.pages)
        selected = scan.selected_pages(p.pages, count)
        scan.check_page_budget(pdf, selected, p.dpi)
    source = source_document(ctx)
    try:
        search = _Search(ctx, source, default_samples(selected), len(selected), p)
        reachable, params, estimate = search.run(p.target_bytes)
    finally:
        source.close()
    return OpOutput(
        changed_pages=[],
        data={
            "params": params.model_dump(by_alias=True, mode="json"),
            "estimatedBytes": estimate,
            "reachable": reachable,
            "steps": search.steps,
        },
    )
