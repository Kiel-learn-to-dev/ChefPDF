"""Export of the document model (milestone v0.10: N4, N5, N6).

Session operations, read-only on the document (they write only the output file):

- ``export.document`` {format, outputPath, pages?, options, modelPath?}: Markdown, HTML, TXT, JSON,
  EPUB, ODT, XLSX or DOCX (``options.mode`` editable | layout). The model is ``modelPath`` (a
  reviewed model from ``layout.analyze``) or, without it, the analysis of the document now.
- ``export.refresh`` {outputPath, pages?, options, modelPath?}: a new clean PDF typeset from the
  model (N6, "Làm mới tài liệu"): page size, font scale, margins, bookmarks from headings.

Batch exports (N7) are in ``chef_core.ops.export_batch``. Options are described in
``chef_core/export/options.py`` (one flat options model; each format reads the fields it needs).
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from pydantic import Field

from chef_core.errors import ChefError, ErrorKind
from chef_core.export.files import assets_folder
from chef_core.export.options import ExportOptions, Format
from chef_core.export.run import load_model, run_export, run_refresh
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.pdf.io import track_created_outputs

MAX_PAGES = 5000


class ExportDocumentParams(WireModel):
    format: Format
    output_path: str = Field(min_length=1, max_length=1024, description="File to write.")
    pages: list[int] | None = Field(
        default=None, max_length=MAX_PAGES, description="0-based pages; null for all."
    )
    options: ExportOptions = Field(default_factory=ExportOptions)
    model_path: str | None = Field(
        default=None,
        max_length=1024,
        description="Reviewed model (layout.analyze modelPath). Null: analyse the document now.",
    )


class ExportRefreshParams(WireModel):
    output_path: str = Field(min_length=1, max_length=1024, description="PDF to write.")
    pages: list[int] | None = Field(default=None, max_length=MAX_PAGES)
    options: ExportOptions = Field(default_factory=ExportOptions)
    model_path: str | None = Field(default=None, max_length=1024)


def _output(path: str, ctx: OpContext, fmt: str) -> Path:
    target = Path(path).expanduser()
    if not target.is_absolute():
        raise ChefError(
            ErrorKind.INVALID_PARAMS, "outputPath must be absolute", {"field": "outputPath"}
        )
    if target.is_dir():
        raise ChefError(ErrorKind.INVALID_PARAMS, "outputPath is a folder", {"field": "outputPath"})
    if target.exists() or (fmt in ("md", "html") and assets_folder(target).exists()):
        raise ChefError(
            ErrorKind.INVALID_PARAMS,
            "Export output already exists",
            {"field": "outputPath"},
        )
    for protected in (ctx.input_path, ctx.source_path):
        if protected is None:
            continue
        try:
            same_file = os.path.samefile(target, protected)
        except OSError:
            same_file = False
        if target.resolve() == protected.resolve() or same_file:
            raise ChefError(
                ErrorKind.INVALID_PARAMS,
                "Export cannot replace the source or current document revision",
                {"field": "outputPath"},
            )
    return target


def _cleanup_created_outputs(outputs: list[tuple[Path, int, int]]) -> None:
    """Remove only paths whose current inode is the one atomically created by this job."""
    for path, device, inode in reversed(outputs):
        try:
            current = path.stat()
            if current.st_dev != device or current.st_ino != inode:
                continue
            if path.is_dir():
                path.rmdir()
            else:
                path.unlink()
        except OSError:
            continue


@contextmanager
def _cleanup_on_failure(ctx: OpContext) -> Iterator[None]:
    """Remove every file the export created if it is cancelled or fails half-way."""
    created: list[tuple[Path, int, int]] = []
    ctx.on_cancel(lambda: _cleanup_created_outputs(created))
    try:
        with track_created_outputs(
            lambda path, stat: created.append((path, stat.st_dev, stat.st_ino))
        ):
            yield
    except BaseException:
        _cleanup_created_outputs(created)
        raise


def _result_data(result: Any, fmt: str | None = None) -> dict[str, Any]:
    data: dict[str, Any] = {
        "outputPath": result.outputs[0],
        "outputs": list(result.outputs),
        "warnings": list(result.warnings),
        "stats": dict(result.stats),
    }
    if fmt is not None:
        data["format"] = fmt
    return data


@operation(
    id="export.document",
    title="Xuất tài liệu",
    group="export",
    params=ExportDocumentParams,
)
def export_document(ctx: OpContext, p: ExportDocumentParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("export.document needs a session")
    out = _output(p.output_path, ctx, p.format)
    ctx.progress(0, 2, "Đọc mô hình")
    model = load_model(ctx.input_path, None, p.model_path, ctx.doc_name)
    ctx.progress(1, 2, "Xuất")
    with _cleanup_on_failure(ctx):
        result = run_export(
            model, ctx.input_path, None, p.format, out, p.pages, p.options, name=ctx.doc_name
        )
    ctx.progress(2, 2, "Xuất")
    for warning in result.warnings:
        ctx.warn(warning)
    return OpOutput(changed_pages=[], outputs=result.outputs, data=_result_data(result, p.format))


@operation(
    id="export.refresh",
    title="Làm mới tài liệu",
    group="export",
    params=ExportRefreshParams,
)
def export_refresh(ctx: OpContext, p: ExportRefreshParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("export.refresh needs a session")
    out = _output(p.output_path, ctx, "pdf")
    ctx.progress(0, 2, "Đọc mô hình")
    model = load_model(ctx.input_path, None, p.model_path, ctx.doc_name)
    ctx.progress(1, 2, "Dàn trang")
    with _cleanup_on_failure(ctx):
        result = run_refresh(
            model, ctx.input_path, None, out, p.pages, p.options, name=ctx.doc_name
        )
    ctx.progress(2, 2, "Dàn trang")
    for warning in result.warnings:
        ctx.warn(warning)
    data = _result_data(result)
    data["pages"] = result.stats.get("pages", 0)
    return OpOutput(changed_pages=[], outputs=result.outputs, data=data)


__all__ = ["ExportDocumentParams", "ExportRefreshParams", "export_document", "export_refresh"]
