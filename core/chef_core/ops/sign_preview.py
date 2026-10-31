"""sign.templatePreview (template studio): the real signature appearance as a PNG.

The box is drawn by ``render_signature_appearance`` (signing/appearance.py), the same code that
draws visible signatures, so the preview shows what a signed document shows. The one-page PDF it
produces is rasterised with PDFium. Image slots (signature picture, logo) are not drawn here: the
preview needs no files.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import pypdfium2 as pdfium
from pydantic import Field

from chef_core.errors import invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.pdf.io import atomic_write
from chef_core.signing.appearance import (
    SignatureData,
    SignatureTemplate,
    render_signature_appearance,
)

MAX_TEXT = 300
MAX_BOX_PT = 2000.0


class PreviewValues(WireModel):
    """Values shown in the box. Missing values are left out, as in a real signature."""

    signer_name: str = Field(default="", max_length=MAX_TEXT)
    organization: str | None = Field(default=None, max_length=MAX_TEXT)
    tax_code: str | None = Field(default=None, max_length=MAX_TEXT)
    citizen_id: str | None = Field(default=None, max_length=MAX_TEXT)
    reason: str | None = Field(default=None, max_length=MAX_TEXT)
    location: str | None = Field(default=None, max_length=MAX_TEXT)
    contact: str | None = Field(default=None, max_length=MAX_TEXT)
    date: str | None = Field(
        default=None, description="ISO 8601 date and time. Default: now (local time)."
    )


class TemplatePreviewParams(WireModel):
    """Render a signature template with sample values to a PNG file."""

    template: SignatureTemplate = Field(default_factory=SignatureTemplate)
    values: PreviewValues = Field(default_factory=PreviewValues)
    width: float = Field(gt=0, le=MAX_BOX_PT, description="Box width in points.")
    height: float = Field(gt=0, le=MAX_BOX_PT, description="Box height in points.")
    output_path: str = Field(min_length=1, description="PNG file to write.")
    dpi: int = Field(default=144, ge=36, le=600)


def _when(value: str | None) -> dt.datetime:
    if value is None:
        return dt.datetime.now().astimezone()
    try:
        parsed = dt.datetime.fromisoformat(value)
    except ValueError as exc:
        raise invalid_params("date must be an ISO 8601 date and time", {"field": "date"}) from exc
    return parsed.astimezone()  # a naive value is taken as local time


def _data(values: PreviewValues) -> SignatureData:
    return SignatureData(
        signer_name=values.signer_name,
        organization=values.organization,
        tax_code=values.tax_code,
        citizen_id=values.citizen_id,
        reason=values.reason,
        location=values.location,
        contact=values.contact,
        signed_at=_when(values.date),
    )


@operation(
    id="sign.templatePreview",
    title="Preview a signature template",
    group="sign",
    params=TemplatePreviewParams,
    standalone=True,
)
def template_preview(ctx: OpContext, p: TemplatePreviewParams) -> OpOutput:
    ctx.check_cancelled()
    rendered = render_signature_appearance(p.template, _data(p.values), p.width, p.height)
    if rendered.truncated:
        ctx.warn("Some text did not fit in the box even at the smallest size and was left out.")
    doc = pdfium.PdfDocument(rendered.pdf)
    try:
        img = doc[0].render(scale=p.dpi / 72).to_pil().convert("RGB")
    finally:
        doc.close()
    out = Path(p.output_path).expanduser().absolute()
    atomic_write(out, lambda tmp: img.save(tmp, format="PNG"))
    return OpOutput(
        changed_pages=[],
        outputs=[str(out)],
        data={"outputPath": str(out), "widthPx": img.width, "heightPx": img.height},
    )
