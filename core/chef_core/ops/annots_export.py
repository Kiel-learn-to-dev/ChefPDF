"""Export and flatten annotations (milestone v0.7, G4-G5).

- ``annots.export`` (read-only, writes a file) {outputPath, format txt|md|html|csv|xlsx|json,
  pages?, kinds?}: one row per annotation (page 1-based, type, author, date, quoted_text under a
  markup annotation, contents, status, replies, id). Result: outputs (the file), count.
- ``annots.flatten`` (destructive) {pages?, kinds?, keepLinks, keepFormFields}: each annotation's
  appearance becomes page content and the annotation is removed. Links and form widgets stay
  unless the flags say otherwise. Result: flattened, dropped, kept.
"""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import Field

from chef_core.annots.export import FORMATS, collect, write
from chef_core.annots.flatten import flatten
from chef_core.errors import invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation

ExportFormat = Literal["txt", "md", "html", "csv", "xlsx", "json"]


def _need(ctx: OpContext, name: str) -> None:
    if ctx.input_path is None:
        raise RuntimeError(f"{name} needs a session")


def _pages(count: int, pages: list[int] | None) -> list[int]:
    indices = sorted(set(pages)) if pages is not None else list(range(count))
    for i in indices:
        if i >= count:
            raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": i})
    return indices


class AnnotsExportParams(WireModel):
    """Write a summary of the annotations to a file. The document is not changed."""

    output_path: str = Field(min_length=1, description="File to write.")
    format: ExportFormat = "txt"
    pages: list[int] | None = Field(default=None, description="0-based pages; default all.")
    kinds: list[str] | None = Field(default=None, description="Subtypes; default all.")


@operation(
    id="annots.export", title="Export annotations", group="annots", params=AnnotsExportParams
)
def annots_export(ctx: OpContext, p: AnnotsExportParams) -> OpOutput:
    _need(ctx, "annots.export")
    if p.format not in FORMATS:
        raise invalid_params("INVALID_EXPORT_FORMAT", {"format": p.format})
    target = Path(p.output_path).expanduser().absolute()
    with ctx.open_input() as pdf:
        indices = _pages(len(pdf.pages), p.pages)
        rows = collect(pdf, indices, set(p.kinds) if p.kinds else None)
    write(rows, p.format, target)
    return OpOutput(changed_pages=[], outputs=[str(target)], data={"count": len(rows)})


class AnnotsFlattenParams(WireModel):
    """Burn annotations into the page content and remove them."""

    pages: list[int] | None = Field(default=None, description="0-based pages; default all.")
    kinds: list[str] | None = Field(default=None, description="Subtypes; default all.")
    keep_links: bool = True
    keep_form_fields: bool = True


@operation(
    id="annots.flatten",
    title="Flatten annotations",
    group="annots",
    params=AnnotsFlattenParams,
    destructive=True,
)
def annots_flatten(ctx: OpContext, p: AnnotsFlattenParams) -> OpOutput:
    _need(ctx, "annots.flatten")
    assert ctx.result_path is not None
    with ctx.open_input() as pdf:
        indices = _pages(len(pdf.pages), p.pages)
        stats = flatten(
            pdf,
            indices,
            kinds=set(p.kinds) if p.kinds else None,
            keep_links=p.keep_links,
            keep_forms=p.keep_form_fields,
        )
        if stats.flattened or stats.dropped:
            ctx.save_document(pdf)
    changed = indices if (stats.flattened or stats.dropped) else []
    return OpOutput(
        changed_pages=changed,
        data={"flattened": stats.flattened, "dropped": stats.dropped, "kept": stats.kept},
    )


__all__ = ["AnnotsExportParams", "AnnotsFlattenParams", "annots_export", "annots_flatten"]
