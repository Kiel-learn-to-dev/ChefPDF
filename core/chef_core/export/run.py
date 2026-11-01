"""Dispatch of an export to its renderer, and the document model of a source.

``load_model``: the model of a reviewed file (``modelPath`` of ``layout.analyze``, after the N3
review), or, without one, the rules-based analysis of the PDF now (the same as ``layout.analyze``
with its defaults).
"""

from __future__ import annotations

from pathlib import Path

from pydantic import ValidationError

from chef_core.errors import ChefError, ErrorKind
from chef_core.export.assets import Assets
from chef_core.export.docx import write_docx
from chef_core.export.epub import write_epub
from chef_core.export.html import write_html
from chef_core.export.ir import ExportResult, build_ir
from chef_core.export.jsonout import write_json
from chef_core.export.markdown import write_markdown
from chef_core.export.odt import write_odt
from chef_core.export.options import ExportOptions, Format
from chef_core.export.refresh import write_refresh
from chef_core.export.txt import write_txt
from chef_core.export.xlsx import write_xlsx
from chef_core.layout.detect import DetectOptions, build_doc_model
from chef_core.layout.model import DocModel
from chef_core.pdf.io import open_pdf


def load_model(
    pdf_path: Path | None,
    password: str | None,
    model_path: str | None,
    name: str,
) -> DocModel:
    """The document model: from ``model_path`` when given, else analysed from ``pdf_path``."""
    if model_path is not None:
        path = Path(model_path)
        if not path.is_file():
            raise ChefError(ErrorKind.FILE_NOT_FOUND, "Model file not found", {"path": model_path})
        try:
            return DocModel.model_validate_json(path.read_text(encoding="utf-8"))
        except (ValidationError, ValueError) as exc:
            raise ChefError(
                ErrorKind.INVALID_PARAMS, "Model file is not a document model", {"path": model_path}
            ) from exc
    if pdf_path is None:
        raise ChefError(ErrorKind.INVALID_PARAMS, "No document to export")
    with open_pdf(pdf_path, password) as pdf:
        analysis = build_doc_model(pdf, None, DetectOptions(), name=name)
    return analysis.model


def run_export(
    model: DocModel,
    source: Path | None,
    password: str | None,
    fmt: Format,
    out: Path,
    pages: list[int] | None,
    opts: ExportOptions,
    name: str | None = None,
) -> ExportResult:
    """Write ``model`` as ``fmt`` to ``out``. ``source`` is the PDF the images come from."""
    with Assets(source, password) as assets:
        ir = build_ir(model, assets, opts, pages, name=name)
        if fmt == "md":
            return write_markdown(ir, out, opts.include_images)
        if fmt == "html":
            return write_html(ir, out, embed=opts.embed_images)
        if fmt == "txt":
            return write_txt(ir, out, page_markers=opts.page_markers)
        if fmt == "json":
            return write_json(model, ir, out, pages)
        if fmt == "epub":
            per = opts.pages_per_chapter
            return write_epub(ir, out, opts.chapter_mode, per)
        if fmt == "odt":
            return write_odt(ir, out)
        if fmt == "xlsx":
            return write_xlsx(ir, out, opts.parse_numbers)
        if fmt == "docx":
            return write_docx(ir, out, opts)
    raise ChefError(ErrorKind.INVALID_PARAMS, f"Unknown format: {fmt}")


def run_refresh(
    model: DocModel,
    source: Path | None,
    password: str | None,
    out: Path,
    pages: list[int] | None,
    opts: ExportOptions,
    name: str | None = None,
) -> ExportResult:
    """Typeset ``model`` as a new PDF (N6)."""
    with Assets(source, password) as assets:
        ir = build_ir(model, assets, opts, pages, name=name)
        return write_refresh(ir, out, opts)
