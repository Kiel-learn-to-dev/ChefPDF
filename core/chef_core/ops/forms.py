"""Form operations (group forms, v0.9 H1-H3).

Read only: ``forms.list``, ``forms.getValues``, ``forms.exportData``, ``forms.detectFields``.
Destructive (refused on a signed document): fill, import, reset, add, update, rename, remove,
tab order and flatten. ``forms.addField`` with kind ``signature`` delegates to ``sign.addField``.

Positions are in the displayed frame of the page (after /Rotate and CropBox), origin at the top
left, in points: ``rect = [x0, top, x1, bottom]``.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Any, Literal, Self

from pydantic import Field, model_validator

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.forms import data as form_data
from chef_core.forms import edit
from chef_core.forms.detect import detect
from chef_core.forms.flatten import flatten
from chef_core.forms.listing import list_result
from chef_core.forms.model import FieldRef, FormDoc
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.ops.sign_fields import AddFieldParams as SigAddFieldParams
from chef_core.ops.sign_fields import add_field_op
from chef_core.pdf.io import opened_pdf

PageIndex = Annotated[int, Field(ge=0)]
HexColor = Annotated[str, Field(pattern=r"^#[0-9A-Fa-f]{6}$")]
FieldName = Annotated[str, Field(min_length=1, max_length=120)]
Rect = Annotated[list[float], Field(min_length=4, max_length=4)]
FillValue = bool | str | list[str]
FieldKind = Literal[
    "text", "multiline", "comb", "checkbox", "radio", "dropdown", "listbox", "button", "signature"
]
DataFormat = Literal["json", "fdf", "xfdf", "csv"]
ImportFormat = Literal["json", "fdf", "xfdf"]
PATH_TAIL = re.compile(r"\.(json|fdf|xfdf)$", re.IGNORECASE)


def _rgb(value: str | None) -> tuple[float, float, float] | None:
    if value is None:
        return None
    return tuple(int(value[i : i + 2], 16) / 255 for i in (1, 3, 5))  # type: ignore[return-value]


def _widget_pages(fd: FormDoc, ref: FieldRef) -> set[int]:
    return {index for index in (fd.page_of(w) for w in ref.widgets) if index is not None}


def _pages_arg(pages: list[PageIndex] | None, count: int) -> set[int] | None:
    if pages is None:
        return None
    if any(p >= count for p in pages):
        raise invalid_params("Page is out of range", {"field": "pages"})
    return set(pages)


def _check_rect(rect: list[float]) -> None:
    x0, top, x1, bottom = rect
    if x1 <= x0 or bottom <= top:
        raise ValueError("rect must be [x0, top, x1, bottom] with x1 > x0 and bottom > top")


def _edit(ctx: OpContext, fn: Callable[[FormDoc], tuple[set[int], Any]]) -> OpOutput:
    """Open the current revision, apply ``fn``, save when it changed something."""
    with ctx.open_input() as pdf:
        fd = FormDoc(pdf)
        pages, data = fn(fd)
        if pages:
            ctx.save_document(pdf)
    return OpOutput(changed_pages=sorted(pages), data=data)


class NoParams(WireModel):
    """No parameters."""


# -- read only --------------------------------------------------------------------------


@operation(id="forms.list", title="List form fields", group="forms", params=NoParams)
def list_op(ctx: OpContext, p: NoParams) -> OpOutput:
    with ctx.open_input() as pdf:
        return OpOutput(changed_pages=[], data=list_result(FormDoc(pdf)))


@operation(id="forms.getValues", title="Read form values", group="forms", params=NoParams)
def get_values_op(ctx: OpContext, p: NoParams) -> OpOutput:
    with ctx.open_input() as pdf:
        return OpOutput(changed_pages=[], data={"values": form_data.export_values(FormDoc(pdf))})


class ExportParams(WireModel):
    """Export the values of every field. Without ``path`` the text comes back in the result."""

    format: DataFormat = Field(default="json")
    path: str | None = Field(default=None, min_length=1, description="File to write.")


@operation(
    id="forms.exportData",
    title="Export form data",
    group="forms",
    params=ExportParams,
    standalone=True,
)
def export_op(ctx: OpContext, p: ExportParams) -> OpOutput:
    with ctx.open_input() as pdf:
        text = form_data.export_text(p.format, FormDoc(pdf))
    if p.path is None:
        return OpOutput(changed_pages=[], data={"format": p.format, "content": text})
    out = Path(p.path).expanduser().absolute()
    out.write_text(text, encoding="ascii", newline="\n")
    return OpOutput(changed_pages=[], outputs=[str(out)], data={"format": p.format})


class DetectParams(WireModel):
    """EXPERIMENTAL: proposals for text fields over blank lines of text. Changes nothing."""

    pages: list[PageIndex] | None = Field(default=None, min_length=1)


@operation(
    id="forms.detectFields",
    title="Suggest fields (experimental)",
    group="forms",
    params=DetectParams,
)
def detect_op(ctx: OpContext, p: DetectParams) -> OpOutput:
    with ctx.open_input() as pdf:
        pages = _pages_arg(p.pages, len(pdf.pages))
        proposals = detect(FormDoc(pdf), pages)
    return OpOutput(changed_pages=[], data={"proposals": proposals, "experimental": True})


# -- fill and data files (H1) -----------------------------------------------------------


class FillParams(WireModel):
    """Set field values. ``values`` maps the full field name to its value."""

    values: dict[FieldName, FillValue] = Field(
        description="Full field name to value: text, bool for check boxes, option text or list."
    )
    flatten: bool = Field(default=False, description="Flatten every field after filling (H3).")
    force: bool = Field(default=False, description="Allow writing to read-only fields.")
    highlight_required: bool = Field(
        default=False, description="Tint empty required fields so they are easy to find."
    )


@operation(
    id="forms.fill",
    title="Fill form fields",
    group="forms",
    params=FillParams,
    destructive=True,
)
def fill_op(ctx: OpContext, p: FillParams) -> OpOutput:
    if not p.values:
        raise invalid_params("No values given", {"field": "values"})

    def run(fd: FormDoc) -> tuple[set[int], Any]:
        result = edit.fill(fd, dict(p.values), force=p.force, highlight=p.highlight_required)
        pages = set(result.pages)
        if p.flatten:
            pages |= flatten(fd).pages
        return pages, {"applied": result.applied, "flattened": p.flatten}

    return _edit(ctx, run)


class ImportParams(WireModel):
    """Fill from a data file (JSON, FDF or XFDF). ``format`` defaults to the file extension."""

    path: str = Field(min_length=1)
    format: ImportFormat | None = Field(default=None)
    force: bool = Field(default=False)


@operation(
    id="forms.importData",
    title="Import form data",
    group="forms",
    params=ImportParams,
    destructive=True,
)
def import_op(ctx: OpContext, p: ImportParams) -> OpOutput:
    src = Path(p.path).expanduser().absolute()
    if not src.is_file():
        raise ChefError(ErrorKind.FILE_NOT_FOUND, "File not found", {"path": str(src)})
    fmt: str | None = p.format
    if fmt is None:
        match = PATH_TAIL.search(src.name)
        if match is None:
            raise invalid_params("Give the format of the data file", {"field": "format"})
        fmt = match.group(1).lower()
    values = form_data.parse_import(src.read_bytes(), fmt)

    def run(fd: FormDoc) -> tuple[set[int], Any]:
        known = {ref.name: ref for ref in fd.fields()}
        unknown = sorted(k for k in values if k not in known)
        locked = sorted(
            k for k in values if k in known and known[k].read_only and not p.force
        )  # a data file does not override read-only fields unless asked to
        usable = {k: v for k, v in values.items() if k in known and k not in locked}
        result = edit.fill(fd, usable, force=p.force) if usable else edit.FillResult()
        return set(result.pages), {
            "applied": result.applied,
            "unknown": unknown,
            "skippedReadOnly": locked,
        }

    return _edit(ctx, run)


# -- reset ------------------------------------------------------------------------------


class ResetParams(WireModel):
    names: list[FieldName] | None = Field(default=None, description="Default: every field.")
    pages: list[PageIndex] | None = Field(default=None, min_length=1)


@operation(
    id="forms.reset",
    title="Clear form values",
    group="forms",
    params=ResetParams,
    destructive=True,
)
def reset_op(ctx: OpContext, p: ResetParams) -> OpOutput:
    def run(fd: FormDoc) -> tuple[set[int], Any]:
        pages = _pages_arg(p.pages, len(fd.pdf.pages))
        result = edit.reset(fd, p.names, pages)
        return set(result.pages), {"reset": result.applied}

    return _edit(ctx, run)


# -- create, update, names, tab order (H2) ---------------------------------------------


class AddFieldParams(WireModel):
    """Create a field. ``kind: signature`` creates an empty signature field (sign.addField)."""

    kind: FieldKind
    page_index: PageIndex
    rect: Rect = Field(description="[x0, top, x1, bottom] in displayed points.")
    name: FieldName = Field(description="Dotted name allowed, e.g. nguoithue.hoten.")
    label: str | None = Field(default=None, max_length=300, description="Tooltip (TU).")
    value: FillValue | None = Field(default=None)
    options: list[str] | None = Field(default=None, description="Choices (dropdown/listbox).")
    required: bool = Field(default=False)
    read_only: bool = Field(default=False)
    max_len: int | None = Field(default=None, ge=1, le=100_000)
    font_size: float = Field(default=0.0, ge=0, le=400, description="0 = auto.")
    text_colour: HexColor = Field(default="#000000")
    border_colour: HexColor | None = Field(default="#000000")
    border_width: float = Field(default=1.0, ge=0, le=20)
    background: HexColor | None = Field(default=None)
    alignment: Literal[0, 1, 2] = Field(default=0, description="0 left, 1 centre, 2 right.")
    export_value: str | None = Field(default=None, max_length=120, description="check box/radio.")
    multi_select: bool = Field(default=False)

    @model_validator(mode="after")
    def _rect_ordered(self) -> Self:
        _check_rect(self.rect)
        return self


@operation(
    id="forms.addField",
    title="Add form field",
    group="forms",
    params=AddFieldParams,
    destructive=True,
)
def forms_add_field(ctx: OpContext, p: AddFieldParams) -> OpOutput:
    if p.kind == "signature":
        return _add_signature(ctx, p)

    def run(fd: FormDoc) -> tuple[set[int], Any]:
        spec = edit.NewField(
            kind=p.kind,
            page=p.page_index,
            rect=list(p.rect),
            name=p.name,
            label=p.label,
            value=p.value,
            options=p.options,
            required=p.required,
            read_only=p.read_only,
            max_len=p.max_len,
            font_size=p.font_size,
            text_colour=_rgb(p.text_colour) or (0.0, 0.0, 0.0),
            border_colour=_rgb(p.border_colour),
            border_width=p.border_width,
            background=_rgb(p.background),
            alignment=p.alignment,
            export_value=p.export_value,
            multi_select=p.multi_select,
        )
        created = edit.add_field(fd, spec)
        return _widget_pages(fd, created), {"fieldName": created.name}

    return _edit(ctx, run)


def _add_signature(ctx: OpContext, p: AddFieldParams) -> OpOutput:
    with opened_pdf(ctx.input_path) as pdf:  # type: ignore[arg-type]
        user = edit.user_rect(FormDoc(pdf), p.page_index, list(p.rect))
    delegated = SigAddFieldParams(
        page=p.page_index,
        rect=user,
        field_name=p.name,
        signer_label=p.label,
    )
    return add_field_op(ctx, delegated)


class UpdateProps(WireModel):
    """Properties to change. Only the keys present in the request are changed."""

    label: str | None = Field(default=None, max_length=300)
    required: bool | None = Field(default=None)
    read_only: bool | None = Field(default=None)
    max_len: int | None = Field(default=None, ge=1, le=100_000)
    font_size: float | None = Field(default=None, ge=0, le=400)
    text_colour: HexColor | None = Field(default=None)
    border_colour: HexColor | None = Field(default=None)
    border_width: float | None = Field(default=None, ge=0, le=20)
    background: HexColor | None = Field(default=None)
    alignment: Literal[0, 1, 2] | None = Field(default=None)
    options: list[str] | None = Field(default=None)
    rect: Rect | None = Field(default=None)
    value: FillValue | None = Field(default=None)


class UpdateParams(WireModel):
    name: FieldName
    properties: UpdateProps


_UPDATE_KEYS = {
    "label": "label",
    "required": "required",
    "read_only": "readOnly",
    "max_len": "maxLen",
    "font_size": "fontSize",
    "text_colour": "textColour",
    "border_colour": "borderColour",
    "border_width": "borderWidth",
    "background": "background",
    "alignment": "alignment",
    "options": "options",
    "rect": "rect",
    "value": "value",
}


@operation(
    id="forms.update",
    title="Change form field",
    group="forms",
    params=UpdateParams,
    destructive=True,
)
def update_op(ctx: OpContext, p: UpdateParams) -> OpOutput:
    given = p.properties.model_dump(exclude_unset=True)
    props: dict[str, Any] = {}
    for key, value in given.items():
        target = _UPDATE_KEYS[key]
        if target in ("textColour", "borderColour", "background"):
            value = _rgb(value)
        props[target] = value

    def run(fd: FormDoc) -> tuple[set[int], Any]:
        result = edit.update(fd, p.name, props)
        return set(result.pages), {"updated": p.name}

    return _edit(ctx, run)


class RemoveParams(WireModel):
    names: list[FieldName] = Field(min_length=1)


@operation(
    id="forms.remove",
    title="Remove form fields",
    group="forms",
    params=RemoveParams,
    destructive=True,
)
def remove_op(ctx: OpContext, p: RemoveParams) -> OpOutput:
    def run(fd: FormDoc) -> tuple[set[int], Any]:
        pages = edit.remove(fd, list(p.names))
        return pages, {"removed": list(p.names)}

    return _edit(ctx, run)


class RenameParams(WireModel):
    name: FieldName
    new_name: str = Field(min_length=1, max_length=120, description="New partial name (no dots).")


@operation(
    id="forms.rename",
    title="Rename form field",
    group="forms",
    params=RenameParams,
    destructive=True,
)
def rename_op(ctx: OpContext, p: RenameParams) -> OpOutput:
    def run(fd: FormDoc) -> tuple[set[int], Any]:
        full = edit.rename(fd, p.name, p.new_name)
        ref = fd.find(full)
        return (_widget_pages(fd, ref) if ref is not None else set()), {"fieldName": full}

    return _edit(ctx, run)


class TabOrderParams(WireModel):
    order: list[FieldName] = Field(min_length=1, description="Full names, in tab order.")


@operation(
    id="forms.setTabOrder",
    title="Set tab order",
    group="forms",
    params=TabOrderParams,
    destructive=True,
)
def tab_order_op(ctx: OpContext, p: TabOrderParams) -> OpOutput:
    def run(fd: FormDoc) -> tuple[set[int], Any]:
        return edit.tab_order(fd, list(p.order)), {"order": list(p.order)}

    return _edit(ctx, run)


# -- flatten (H3) -----------------------------------------------------------------------


class FlattenParams(WireModel):
    names: list[FieldName] | None = Field(default=None, description="Default: every field.")
    pages: list[PageIndex] | None = Field(default=None, min_length=1)
    keep_signatures: bool = Field(default=True)
    remove_javascript: bool = Field(default=True)


@operation(
    id="forms.flatten",
    title="Flatten form",
    group="forms",
    params=FlattenParams,
    destructive=True,
)
def flatten_op(ctx: OpContext, p: FlattenParams) -> OpOutput:
    def run(fd: FormDoc) -> tuple[set[int], Any]:
        pages = _pages_arg(p.pages, len(fd.pdf.pages))
        result = flatten(
            fd,
            names=p.names,
            pages=pages,
            keep_signatures=p.keep_signatures,
            remove_javascript=p.remove_javascript,
        )
        data = {
            "flattened": result.flattened,
            "kept": result.kept,
            "withoutAppearance": result.skipped_without_appearance,
        }
        return set(result.pages), data

    return _edit(ctx, run)
