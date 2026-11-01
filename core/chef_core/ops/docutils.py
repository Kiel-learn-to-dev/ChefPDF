"""Document utilities (features M7-M11; T5.08).

Session operations (read-only unless noted):
- ``doc.extractImages``: the images of the selected pages, in their own format when the file
  holds JPEG or JPEG 2000 (bytes unchanged), PNG otherwise. Names follow ``nameTemplate``.
- ``doc.extractText``: plain text (UTF-8), optionally with a page marker before each page.
- ``doc.attachments.list`` / ``extract``: read-only. ``add`` / ``remove``: destructive.
- ``doc.setMetadata``: Info dictionary and XMP are written together. An empty string removes a
  field; ``clear`` removes everything first. Custom keys go to the Info dictionary only.

Standalone operations (files on disk):
- ``doc.optimizeWeb``: a linearized copy (the first page opens quickly over a network).
- ``doc.repair``: opens a damaged file with recovery and writes a clean copy. A file without a
  readable page is INVALID_PDF.
"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Any, cast

import pikepdf
import pypdfium2 as pdfium
from pydantic import Field, model_validator

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.pdf.io import atomic_save, open_pdf
from chef_core.pdf.pages import check_indices
from chef_core.pdf.salvage import NotRepairable, repair_file
from chef_core.session.info import document_info

_UNSAFE = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_VAR_RE = re.compile(r"\{(name|page|index)\}")
_CUSTOM_KEY = re.compile(r"^[A-Za-z][A-Za-z0-9 _-]{0,63}$")
# Info key -> XMP property (the mapping keeps the two in step).
_XMP_KEYS = {
    "Title": "dc:title",
    "Author": "dc:creator",
    "Subject": "dc:description",
    "Keywords": "pdf:Keywords",
    "Creator": "xmp:CreatorTool",
    "Producer": "pdf:Producer",
    "CreationDate": "xmp:CreateDate",
    "ModDate": "xmp:ModifyDate",
}


def _safe_name(text: str) -> str:
    cleaned = _UNSAFE.sub("_", text).strip().rstrip(".")
    return cleaned or "file"


def _render_name(template: str, *, name: str, page: int, index: int) -> str:
    values = {"name": name, "page": str(page), "index": str(index)}
    return _safe_name(_VAR_RE.sub(lambda m: values[m.group(1)], template))


# -- M7: images ----------------------------------------------------------------------------


class ExtractImagesParams(WireModel):
    """Extract the images of the selected pages into a folder (session document)."""

    output_dir: str = Field(min_length=1, description="Folder for the image files.")
    pages: list[int] | None = Field(
        default=None, min_length=1, description="0-based pages; default all."
    )
    name_template: str = Field(
        default="{page}_{index}",
        min_length=1,
        max_length=200,
        description="File name without extension: {name}, {page} (1-based), {index} (1-based "
        "on the page). The extension is .jpg, .jp2 or .png.",
    )


@operation(id="doc.extractImages", title="Extract images", group="doc", params=ExtractImagesParams)
def extract_images(ctx: OpContext, p: ExtractImagesParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("doc.extractImages needs a session")
    out_dir = Path(p.output_dir).expanduser().absolute()
    if out_dir.exists() and not out_dir.is_dir():
        raise invalid_params("outputDir is not a directory", {"field": "outputDir"})
    out_dir.mkdir(parents=True, exist_ok=True)
    outputs: list[str] = []
    seen: set[tuple[int, int]] = set()
    with ctx.open_input() as pdf:
        count = len(pdf.pages)
        pages = list(range(count)) if p.pages is None else check_indices(p.pages, count, "pages")
        for page_no in ctx.steps(pages, len(pages), "images"):
            resources = pdf.pages[page_no].obj.get("/Resources")
            if not isinstance(resources, pikepdf.Dictionary):
                continue
            xobjects = resources.get("/XObject")
            if not isinstance(xobjects, pikepdf.Dictionary):
                continue
            index = 0
            for key in sorted(xobjects, key=str):  # stable numbering
                xobj = cast(Any, xobjects)[key]
                if (
                    not isinstance(xobj, pikepdf.Stream)
                    or xobj.get("/Subtype") != pikepdf.Name.Image
                ):
                    continue
                if xobj.is_indirect:
                    if xobj.objgen in seen:  # the same image used on several pages
                        continue
                    seen.add(xobj.objgen)
                index += 1
                stem = _render_name(
                    p.name_template, name=ctx.doc_name, page=page_no + 1, index=index
                )
                try:
                    written = pikepdf.PdfImage(xobj).extract_to(fileprefix=str(out_dir / stem))
                except Exception as exc:  # encodings pikepdf cannot decode
                    ctx.warn(f"Image {key} on page {page_no + 1} was not extracted: {exc}")
                    continue
                outputs.append(str(written))
    return OpOutput(changed_pages=[], outputs=outputs, data={"count": len(outputs)})


# -- M7: text ------------------------------------------------------------------------------


class ExtractTextParams(WireModel):
    """Write the text of the session document to a UTF-8 file."""

    output_path: str = Field(min_length=1, description="Text file to write.")
    page_markers: bool = Field(default=False, description='Put "--- Trang N ---" before each page.')


@operation(id="doc.extractText", title="Extract text", group="doc", params=ExtractTextParams)
def extract_text(ctx: OpContext, p: ExtractTextParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("doc.extractText needs a session")
    dest = Path(p.output_path).expanduser().absolute()
    if dest.is_dir():
        raise invalid_params("outputPath is a directory", {"field": "outputPath"})
    ctx.check_cancelled()
    parts: list[str] = []
    doc = pdfium.PdfDocument(str(ctx.input_path))
    try:
        pages = len(doc)
        for index in ctx.steps(range(pages), pages, "text"):
            page = doc[index]
            try:
                text_page = page.get_textpage()
                try:
                    text = text_page.get_text_range()
                finally:
                    text_page.close()
            finally:
                page.close()
            if p.page_markers:
                parts.append(f"--- Trang {index + 1} ---\n")
            parts.append(text.rstrip() + "\n\n")
    finally:
        doc.close()
    content = "".join(parts)
    dest.write_text(content, encoding="utf-8")
    return OpOutput(
        changed_pages=[], outputs=[str(dest)], data={"pages": pages, "chars": len(content)}
    )


# -- M8: attachments -----------------------------------------------------------------------


class NoParams(WireModel):
    """No parameters."""


class AttachmentsExtractParams(WireModel):
    """Save attachments to a folder (all of them, or the named ones)."""

    output_dir: str = Field(min_length=1, description="Folder for the attached files.")
    names: list[str] | None = Field(default=None, min_length=1, description="Default: all.")


class AttachmentsAddParams(WireModel):
    """Attach files to the session document."""

    paths: list[str] = Field(min_length=1, description="Files to attach (absolute paths).")
    replace: bool = Field(default=False, description="Replace an attachment with the same name.")


class AttachmentsRemoveParams(WireModel):
    """Remove attachments by name."""

    names: list[str] = Field(min_length=1)


def _attachment_size(pdf: pikepdf.Pdf, name: str) -> tuple[int, str]:
    spec = pdf.attachments[name]
    return len(spec.get_file().read_bytes()), str(spec.description or "")


@operation(id="doc.attachments.list", title="List attachments", group="doc", params=NoParams)
def attachments_list(ctx: OpContext, p: NoParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("doc.attachments.list needs a session")
    items: list[dict[str, Any]] = []
    with ctx.open_input() as pdf:
        for name in pdf.attachments:
            size, description = _attachment_size(pdf, str(name))
            items.append({"name": str(name), "size": size, "description": description})
    return OpOutput(changed_pages=[], data=items)


@operation(
    id="doc.attachments.extract",
    title="Save attachments",
    group="doc",
    params=AttachmentsExtractParams,
)
def attachments_extract(ctx: OpContext, p: AttachmentsExtractParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("doc.attachments.extract needs a session")
    out_dir = Path(p.output_dir).expanduser().absolute()
    out_dir.mkdir(parents=True, exist_ok=True)
    outputs: list[str] = []
    with ctx.open_input() as pdf:
        available = [str(n) for n in pdf.attachments]
        names = available if p.names is None else p.names
        for name in names:
            if name not in available:
                raise invalid_params(f"No attachment named {name!r}", {"name": name})
            target = out_dir / _safe_name(Path(name).name)
            target.write_bytes(pdf.attachments[name].get_file().read_bytes())
            outputs.append(str(target))
    return OpOutput(changed_pages=[], outputs=outputs)


@operation(
    id="doc.attachments.add",
    title="Attach files",
    group="doc",
    params=AttachmentsAddParams,
    destructive=True,
)
def attachments_add(ctx: OpContext, p: AttachmentsAddParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("doc.attachments.add needs a session")
    sources = [Path(x).expanduser().absolute() for x in p.paths]
    for src in sources:
        if not src.is_file():
            raise ChefError(ErrorKind.FILE_NOT_FOUND, "File not found", {"path": str(src)})
    with ctx.open_input() as pdf:
        existing = {str(n) for n in pdf.attachments}
        for src in sources:
            if src.name in existing and not p.replace:
                raise invalid_params(
                    f"An attachment named {src.name!r} already exists", {"name": src.name}
                )
        for src in sources:
            pdf.attachments[src.name] = pikepdf.AttachedFileSpec.from_filepath(pdf, src)
        ctx.save_document(pdf)
    return OpOutput(changed_pages=[])


@operation(
    id="doc.attachments.remove",
    title="Remove attachments",
    group="doc",
    params=AttachmentsRemoveParams,
    destructive=True,
)
def attachments_remove(ctx: OpContext, p: AttachmentsRemoveParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("doc.attachments.remove needs a session")
    with ctx.open_input() as pdf:
        available = {str(n) for n in pdf.attachments}
        for name in dict.fromkeys(p.names):
            if name not in available:
                raise invalid_params(f"No attachment named {name!r}", {"name": name})
            del pdf.attachments[name]
        ctx.save_document(pdf)
    return OpOutput(changed_pages=[])


# -- M9: metadata --------------------------------------------------------------------------


class SetMetadataParams(WireModel):
    """Set document properties. Null: unchanged. Empty string: removed."""

    title: str | None = Field(default=None, max_length=1000)
    author: str | None = Field(default=None, max_length=1000)
    subject: str | None = Field(default=None, max_length=1000)
    keywords: str | None = Field(default=None, max_length=1000)
    creator: str | None = Field(default=None, max_length=1000)
    producer: str | None = Field(default=None, max_length=1000)
    creation_date: str | None = Field(
        default=None, description="ISO 8601 date, e.g. 2024-03-01T09:30:00+07:00. Empty: removed."
    )
    mod_date: str | None = Field(default=None, description="ISO 8601 date. Empty: removed.")
    custom: dict[str, str] | None = Field(
        default=None, description="Extra Info entries. Empty value removes the key."
    )
    clear: bool = Field(default=False, description="Remove all properties before applying.")

    @model_validator(mode="after")
    def _check_custom(self) -> SetMetadataParams:
        for key in self.custom or {}:
            if not _CUSTOM_KEY.match(key) or key in _XMP_KEYS:
                raise ValueError(f"invalid custom key: {key!r}")
        return self


def _pdf_date(value: str) -> str:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise invalid_params(f"Invalid date: {value!r}", {"value": value}) from exc
    text = "D:" + parsed.strftime("%Y%m%d%H%M%S")
    if parsed.tzinfo is not None:
        offset = parsed.strftime("%z")  # +0700
        text += f"{offset[:3]}'{offset[3:5]}'"
    return text


def _xmp_date(value: str) -> str:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.isoformat(timespec="seconds")


def _info_values(p: SetMetadataParams) -> dict[str, str | None]:
    return {
        "Title": p.title,
        "Author": p.author,
        "Subject": p.subject,
        "Keywords": p.keywords,
        "Creator": p.creator,
        "Producer": p.producer,
        "CreationDate": p.creation_date,
        "ModDate": p.mod_date,
    }


@operation(
    id="doc.setMetadata",
    title="Edit properties",
    group="doc",
    params=SetMetadataParams,
    destructive=True,
)
def set_metadata(ctx: OpContext, p: SetMetadataParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("doc.setMetadata needs a session")
    values = _info_values(p)
    with ctx.open_input() as pdf:
        info: Any = pdf.docinfo
        if p.clear:
            if "/Info" in pdf.trailer:
                for name in list(info.keys()):
                    del info[name]
            if "/Metadata" in pdf.Root:
                del pdf.Root["/Metadata"]
        xmp_changes: dict[str, str | None] = {}
        for field_name, value in values.items():
            if value is None:
                continue
            if value:
                if field_name in ("CreationDate", "ModDate"):
                    info[f"/{field_name}"] = pikepdf.String(_pdf_date(value))
                    xmp_changes[field_name] = _xmp_date(value)
                else:
                    info[f"/{field_name}"] = pikepdf.String(value)
                    xmp_changes[field_name] = value
            else:
                if f"/{field_name}" in info:
                    del info[f"/{field_name}"]
                xmp_changes[field_name] = None
        for custom_key, custom_value in (p.custom or {}).items():
            if custom_value:
                info[f"/{custom_key}"] = pikepdf.String(custom_value)
            elif f"/{custom_key}" in info:
                del info[f"/{custom_key}"]
        if xmp_changes:
            with pdf.open_metadata(set_pikepdf_as_editor=False, update_docinfo=False) as xmp:
                for field_name, xmp_value in xmp_changes.items():
                    prop = _XMP_KEYS[field_name]
                    if xmp_value is None:
                        if prop in xmp:
                            del xmp[prop]
                    elif field_name == "Author":
                        xmp[prop] = [xmp_value]
                    else:
                        xmp[prop] = xmp_value
        metadata = document_info(pdf, encrypted=False, file_size=0)["metadata"]
        ctx.save_document(pdf)
    return OpOutput(changed_pages=[], data={"metadata": metadata})


# -- M10: web optimisation (standalone) ----------------------------------------------------


class OptimizeWebParams(WireModel):
    """Write a linearized copy of a PDF file."""

    input_path: str = Field(min_length=1, description="PDF file to read.")
    input_password: str | None = Field(default=None, description="Password of the input file.")
    output_path: str = Field(min_length=1, description="Copy to write. May equal the input.")


@operation(
    id="doc.optimizeWeb",
    title="Optimise for web",
    group="doc",
    params=OptimizeWebParams,
    standalone=True,
    batchable=True,
)
def optimize_web(ctx: OpContext, p: OptimizeWebParams) -> OpOutput:
    src = Path(p.input_path).expanduser().absolute()
    dest = Path(p.output_path).expanduser().absolute()
    if dest.is_dir():
        raise invalid_params("outputPath is a directory", {"field": "outputPath"})
    before = src.stat().st_size
    pdf = open_pdf(src, p.input_password)
    try:
        if pdf.is_encrypted:
            ctx.warn("The copy is not encrypted: the protection of the input was not kept.")
        ctx.check_cancelled()
        atomic_save(pdf, dest, before_replace=pdf.close, linearize=True)
    finally:
        pdf.close()
    after = dest.stat().st_size
    return OpOutput(
        changed_pages=[],
        outputs=[str(dest)],
        data={"beforeBytes": before, "afterBytes": after, "linearized": True},
    )


# -- M11: repair (standalone) --------------------------------------------------------------


class RepairParams(WireModel):
    """Repair a damaged PDF file and write a clean copy."""

    input_path: str = Field(min_length=1, description="Damaged PDF file.")
    output_path: str = Field(min_length=1, description="Repaired copy to write.")


@operation(
    id="doc.repair",
    title="Repair damaged PDF",
    group="doc",
    params=RepairParams,
    standalone=True,
)
def repair(ctx: OpContext, p: RepairParams) -> OpOutput:
    """qpdf recovery, then a manual salvage when qpdf fails or its pages cannot be drawn (see
    ``chef_core.pdf.salvage``). The page checks are the same for both routes."""
    src = Path(p.input_path).expanduser().absolute()
    dest = Path(p.output_path).expanduser().absolute()
    if not src.is_file():
        raise ChefError(ErrorKind.FILE_NOT_FOUND, "File not found", {"path": str(src)})
    if dest.is_dir():
        raise invalid_params("outputPath is a directory", {"field": "outputPath"})
    ctx.check_cancelled()
    try:
        report = repair_file(src, dest)
    except pikepdf.PasswordError as exc:
        raise ChefError(
            ErrorKind.PASSWORD_REQUIRED, "Password required", {"path": str(src)}
        ) from exc
    except NotRepairable as exc:
        raise ChefError(ErrorKind.INVALID_PDF, "Not repairable", {"path": str(src)}) from exc
    for message in report.warnings:
        ctx.warn(message)
    return OpOutput(
        changed_pages=[],
        outputs=[str(dest)],
        data={
            "recovered": bool(report.warnings or report.lost or report.salvaged),
            "pageCount": report.pages,
            "warnings": report.warnings,
            "salvaged": report.salvaged,
            "lostPages": report.lost,
        },
    )
