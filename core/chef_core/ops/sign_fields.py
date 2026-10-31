"""Empty signature fields and their listing (T3.07, I30).

``sign.addField`` appends an empty signature field to the document. It is an incremental change
that does not touch earlier bytes, so earlier signatures stay valid. It is not ``finalizing``
(the document is not signed by adding a field) and it is refused by a certification that forbids
new fields (BLOCKED_BY_SIGNATURE).

``sign.listFields`` reads the fields of the current revision and changes nothing.
"""

from __future__ import annotations

import math
from typing import Annotated, Self

from pydantic import Field, model_validator
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign.fields import SigFieldSpec, append_signature_field

from chef_core.errors import invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.pdf.io import opened_pdf
from chef_core.signing.fields import list_signature_fields
from chef_core.signing.pades import check_changes_allowed, existing_field_names, next_field_name

PageIndex = Annotated[int, Field(ge=0)]


class AddFieldParams(WireModel):
    """Add an empty signature field to a page."""

    page: PageIndex = Field(description="0-based page of the field.")
    rect: Annotated[list[float], Field(min_length=4, max_length=4)] = Field(
        description="[x1, y1, x2, y2] in PDF points."
    )
    field_name: str | None = Field(
        default=None,
        min_length=1,
        max_length=120,
        description="Name of the field. Default: the first free Signature<N>.",
    )
    signer_label: str | None = Field(
        default=None,
        max_length=200,
        description="Who must sign here, e.g. 'Giám đốc'. Stored as the field's tooltip (/TU).",
    )

    @model_validator(mode="after")
    def _rect_is_ordered(self) -> Self:
        x1, y1, x2, y2 = self.rect
        if x2 <= x1 or y2 <= y1:
            raise ValueError("rect must be [x1, y1, x2, y2] with x2 > x1 and y2 > y1")
        return self


@operation(
    id="sign.addField",
    title="Add an empty signature field",
    group="sign",
    params=AddFieldParams,
)
def add_field_op(ctx: OpContext, p: AddFieldParams) -> OpOutput:
    if ctx.input_path is None or ctx.result_path is None:
        raise RuntimeError("sign.addField needs a session")
    ctx.check_cancelled()
    with opened_pdf(ctx.input_path) as pdf:
        count = len(pdf.pages)
    if p.page >= count:
        raise invalid_params("Page is out of range", {"field": "page"})
    check_changes_allowed(ctx.input_path, creates_field=True, op_id="sign.addField")

    x1, y1, x2, y2 = p.rect
    box = (math.floor(x1), math.floor(y1), math.ceil(x2), math.ceil(y2))
    with ctx.input_path.open("rb") as src:
        writer = IncrementalPdfFileWriter(src, strict=False)
        existing = existing_field_names(writer)
        name = p.field_name or next_field_name(existing)
        if name in existing:
            raise invalid_params(
                f"A signature field named {name} already exists", {"field": "fieldName"}
            )
        spec = SigFieldSpec(
            name,
            on_page=p.page,
            box=box,
            readable_field_name=p.signer_label,
        )
        append_signature_field(writer, spec)
        with ctx.result_path.open("wb") as out:
            writer.write(out)  # type: ignore[no-untyped-call]
    ctx.modified = True
    return OpOutput(changed_pages=[p.page], data={"fieldName": name})


class ListFieldsParams(WireModel):
    """No parameters: lists the signature fields of the current revision."""


@operation(
    id="sign.listFields",
    title="List signature fields",
    group="sign",
    params=ListFieldsParams,
)
def list_fields_op(ctx: OpContext, p: ListFieldsParams) -> OpOutput:
    with ctx.open_input() as pdf:
        infos = list_signature_fields(pdf)
    fields = [
        {
            "fieldName": info.name,
            "page": info.page,
            "rect": list(info.rect) if info.rect is not None else None,
            "signed": info.signed,
        }
        for info in infos
    ]
    return OpOutput(changed_pages=[], data={"fields": fields})
