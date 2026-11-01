"""Document deconstruction (milestone v0.10, N1-N2): read a PDF with text as a structured model.

Read-only operations (session):

- ``layout.analyze`` {pages?, dropRepeated, joinAcrossPages, detectTables, borderlessTables,
  joinTables, language?, includeModel}: the whole model is written to a JSON file in the session
  folder (``modelPath``), so that big documents do not pass through stdio. ``summary`` has the
  pages, blocks by kind, columns per page and warnings. ``includeModel`` also returns the model.
- ``layout.pageModel`` {pageIndex, context}: one page of the model inline, for the review screen.
  With ``context`` the whole document is analysed (repeated headers and footers are then known).

The model format and the block kinds are documented in ``chef_core/layout/README.md``.
Scanned pages (no text layer) are reported as ``PAGE_HAS_NO_TEXT_LAYER``; OCR is out of scope.
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

from pydantic import Field

from chef_core.layout.detect import DetectOptions, build_doc_model
from chef_core.layout.model import block_kinds, dump_json
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.pdf.pages import check_indices

LANGUAGE_MAX = 12


class AnalyzeParams(WireModel):
    """Options of the rule-based analysis. ``pages`` null means every page."""

    pages: list[int] | None = Field(default=None, description="0-based pages; null for all.")
    drop_repeated: bool = Field(default=True, description="Header, footer, page number lines.")
    join_across_pages: bool = Field(default=True, description="Join paragraphs across breaks.")
    detect_tables: bool = Field(default=True, description="Tables from ruling lines.")
    borderless_tables: bool = Field(default=False, description="Experimental; off by default.")
    join_tables: bool = Field(default=True, description="Continue a table on the next page.")
    language: str | None = Field(default=None, max_length=LANGUAGE_MAX)
    include_model: bool = Field(default=False, description="Also return the model inline.")


class PageModelParams(WireModel):
    page_index: int = Field(ge=0, description="0-based page.")
    context: bool = Field(
        default=False,
        description="Analyse the whole document, so repeated furniture is recognised.",
    )


def _options(p: AnalyzeParams) -> DetectOptions:
    return DetectOptions(
        drop_repeated=p.drop_repeated,
        join_across_pages=p.join_across_pages,
        detect_tables=p.detect_tables,
        borderless_tables=p.borderless_tables,
        join_tables=p.join_tables,
        language=p.language,
    )


def _model_path(ctx: OpContext, text: str) -> Path:
    if ctx.input_path is None:
        raise RuntimeError("layout.analyze needs a session but none was given")
    folder = ctx.input_path.parent / "layout"
    folder.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    return folder / f"model-{digest}.json"


@operation(
    id="layout.analyze", title="Analyse document structure", group="layout", params=AnalyzeParams
)
def analyze(ctx: OpContext, p: AnalyzeParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("layout.analyze needs a session")
    with ctx.open_input() as pdf:
        pages = check_indices(p.pages, len(pdf.pages)) if p.pages is not None else None
        ctx.progress(0, 1, "analyse")
        analysis = build_doc_model(pdf, pages, _options(p), name=ctx.doc_name)
        ctx.progress(1, 1, "analyse")
    text = dump_json(analysis.model)
    path = _model_path(ctx, text)
    path.write_text(text, encoding="utf-8", newline="\n")
    for w in analysis.warnings:
        ctx.warn(f"{w['code']}: page {w['page'] + 1}")
    summary: dict[str, Any] = {
        "pages": len(analysis.model.pages),
        "blocksByKind": block_kinds(analysis.model),
        "columnsPerPage": [
            {"page": index, "columns": n} for index, n in sorted(analysis.columns.items())
        ],
        "warnings": analysis.warnings,
    }
    data: dict[str, Any] = {"modelPath": str(path), "summary": summary}
    if p.include_model:
        data["model"] = analysis.model.model_dump(mode="json", by_alias=True)
    return OpOutput(changed_pages=[], data=data, outputs=[str(path)])


@operation(
    id="layout.pageModel", title="Structure of one page", group="layout", params=PageModelParams
)
def page_model(ctx: OpContext, p: PageModelParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("layout.pageModel needs a session")
    with ctx.open_input() as pdf:
        check_indices([p.page_index], len(pdf.pages), "pageIndex")
        pages = None if p.context else [p.page_index]
        analysis = build_doc_model(pdf, pages, DetectOptions())
    info = next(pg for pg in analysis.model.pages if pg.index == p.page_index)
    return OpOutput(
        changed_pages=[],
        data={
            "page": info.model_dump(mode="json", by_alias=True),
            "columns": analysis.columns.get(p.page_index, 1),
            "warnings": [w for w in analysis.warnings if w["page"] == p.page_index],
        },
    )


__all__ = ["AnalyzeParams", "PageModelParams", "analyze", "page_model"]
