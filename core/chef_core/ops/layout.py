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
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Literal

from pydantic import Field

from chef_core.errors import ChefError, ErrorKind
from chef_core.layout.detect import DetectOptions, build_doc_model
from chef_core.layout.model import DocModel, Run, block_kinds, dump_json
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.pdf.pages import check_indices

LANGUAGE_MAX = 12
MAX_DIFF_MATCH_LENGTH = 4096


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


class ReviewChange(WireModel):
    page_index: int = Field(ge=0)
    block_index: int = Field(ge=0)
    kind: Literal["heading", "paragraph", "header", "footer", "pageNumber", "footnote", "unknown"]
    level: int = Field(default=1, ge=1, le=6)
    text: str | None = Field(default=None, max_length=100_000)


class ReviewParams(WireModel):
    model_path: str = Field(min_length=1, max_length=1024)
    changes: list[ReviewChange] = Field(max_length=5000)


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


def _replace_run_text(runs: list[dict[str, Any]], text: str) -> list[dict[str, Any]]:
    """Replace visible block text while keeping formatting on unchanged text spans.

    Inserted text inherits the style at the edit point; a wholly new block inherits the first run.
    """
    old_runs = [Run.model_validate(run) for run in runs]
    old_text = "".join(run.text for run in old_runs)
    if old_text == text:
        return runs
    if not old_runs:
        return [Run(text=text).model_dump(mode="json", by_alias=True)] if text else []

    spans: list[tuple[int, int, Run]] = []
    cursor = 0
    for run in old_runs:
        spans.append((cursor, cursor + len(run.text), run))
        cursor += len(run.text)

    def style_at(position: int) -> Run:
        for start, end, run in spans:
            if start <= position < end:
                return run
        for start, end, run in spans:
            if start < position <= end:
                return run
        return old_runs[-1] if position >= len(old_text) else old_runs[0]

    output: list[Run] = []

    def append(run: Run, value: str) -> None:
        if not value:
            return
        if output and output[-1].model_dump(exclude={"text"}) == run.model_dump(exclude={"text"}):
            output[-1] = output[-1].model_copy(update={"text": output[-1].text + value})
        else:
            output.append(run.model_copy(update={"text": value}))

    def append_range(start: int, end: int) -> None:
        for run_start, run_end, run in spans:
            left, right = max(run_start, start), min(run_end, end)
            if left < right:
                append(run, old_text[left:right])

    if max(len(old_text), len(text)) > MAX_DIFF_MATCH_LENGTH:
        # SequenceMatcher with autojunk disabled has quadratic worst cases on repeated text.
        # For large blocks preserve the common prefix and suffix exactly and style only the
        # replaced middle from the run at the edit point. This is linear in the input length.
        prefix = 0
        prefix_limit = min(len(old_text), len(text))
        while prefix < prefix_limit and old_text[prefix] == text[prefix]:
            prefix += 1
        suffix = 0
        suffix_limit = min(len(old_text) - prefix, len(text) - prefix)
        while suffix < suffix_limit and old_text[-suffix - 1] == text[-suffix - 1]:
            suffix += 1
        append_range(0, prefix)
        middle_end = len(text) - suffix
        append(style_at(prefix), text[prefix:middle_end])
        if suffix:
            append_range(len(old_text) - suffix, len(old_text))
        return [run.model_dump(mode="json", by_alias=True) for run in output]

    matcher = SequenceMatcher(None, old_text, text, autojunk=False)
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            for start, end, run in spans:
                left, right = max(start, i1), min(end, i2)
                if left < right:
                    append(run, old_text[left:right])
        elif tag in ("insert", "replace"):
            append(style_at(i1), text[j1:j2])
    return [run.model_dump(mode="json", by_alias=True) for run in output]


@operation(
    id="layout.review", title="Review document structure", group="layout", params=ReviewParams
)
def review(ctx: OpContext, p: ReviewParams) -> OpOutput:
    """Write a validated reviewed model alongside this session's analysis, never the PDF."""
    if ctx.input_path is None:
        raise RuntimeError("layout.review needs a session")
    folder = (ctx.input_path.parent / "layout").resolve()
    path = Path(p.model_path).resolve()
    if path.parent != folder or not path.name.startswith("model-") or path.suffix != ".json":
        raise ChefError(ErrorKind.INVALID_PARAMS, "Model must belong to this session")
    try:
        model = DocModel.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ChefError(ErrorKind.INVALID_PARAMS, "Invalid document model") from exc
    data = model.model_dump(mode="json", by_alias=True)
    pages = {page["index"]: page for page in data["pages"]}
    for change in p.changes:
        page = pages.get(change.page_index)
        if page is None or change.block_index >= len(page["blocks"]):
            raise ChefError(ErrorKind.INVALID_PARAMS, "Block not found")
        block = page["blocks"][change.block_index]
        if "runs" not in block:
            raise ChefError(ErrorKind.INVALID_PARAMS, "Only text blocks can change type")
        replacement = {
            key: block[key] for key in ("bbox", "readingOrder", "sourceRefs", "confidence", "runs")
        }
        replacement["kind"] = change.kind
        if change.text is not None:
            replacement["runs"] = _replace_run_text(block["runs"], change.text)
        if change.kind == "heading":
            replacement["level"] = change.level
        page["blocks"][change.block_index] = replacement
    reviewed = DocModel.model_validate(data)
    text = dump_json(reviewed)
    output = _model_path(ctx, text)
    output.write_text(text, encoding="utf-8", newline="\n")
    return OpOutput(
        changed_pages=[], data={"modelPath": str(output), "model": data}, outputs=[str(output)]
    )


__all__ = ["AnalyzeParams", "PageModelParams", "analyze", "page_model"]
