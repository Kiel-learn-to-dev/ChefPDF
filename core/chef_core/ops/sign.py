"""Digital signature operations (group I): sign.certInfo and sign.pades.

sign.pades is ``finalizing``: after it runs the session is marked as signed (see session manager).
It only appends to the document, so it stays allowed on signed documents.
"""

from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import Field, field_validator, model_validator

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.pdf.io import opened_pdf
from chef_core.signing.certinfo import cert_info
from chef_core.signing.pades import (
    AppearanceStreamProvider,
    DigestName,
    PadesRequest,
    PlaceholderAppearance,
    SigningLevel,
    VisibleSpot,
    load_certificate_files,
    sign_pades,
)
from chef_core.signing.pfx import load_pfx
from chef_core.signing.tsa import ALLOWED_SCHEMES

PageIndex = Annotated[int, Field(ge=0)]
PASSWORD_DOC = "Password of the certificate file. Never stored, logged or echoed back."


class SignCertInfoParams(WireModel):
    """Read the certificate in a .pfx / .p12 file without signing anything."""

    pfx_path: str = Field(min_length=1, description="Path to the .pfx or .p12 file.")
    password: str | None = Field(default=None, repr=False, description=PASSWORD_DOC)


@operation(
    id="sign.certInfo",
    title="Certificate information",
    group="sign",
    params=SignCertInfoParams,
    standalone=True,
)
def cert_info_op(ctx: OpContext, p: SignCertInfoParams) -> OpOutput:
    loaded = load_pfx(p.pfx_path, p.password)
    info = cert_info(loaded.certificate)
    if info.expired:
        ctx.warn("The certificate has expired.")
    elif info.expiring_soon:
        ctx.warn(f"The certificate expires in {info.days_until_expiry} day(s).")
    return OpOutput(data=info.model_dump(by_alias=True, mode="json"))


class SignPadesParams(WireModel):
    """Sign the document with a certificate file (PAdES)."""

    pfx_path: str = Field(min_length=1, description="Path to the .pfx or .p12 file.")
    password: str | None = Field(default=None, repr=False, description=PASSWORD_DOC)
    level: Literal["B-B", "B-T", "B-LT", "B-LTA"] = Field(
        default="B-B",
        description="B-B: signature only. B-T: + timestamp. B-LT: + revocation data. "
        "B-LTA: + document timestamp for long-term validity.",
    )
    digest: Literal["sha256", "sha384", "sha512"] = "sha256"
    tsa_urls: list[str] = Field(
        default_factory=list,
        description="Timestamp servers, tried in order. Required for B-T and above.",
    )
    trust_root_paths: list[str] = Field(
        default_factory=list,
        description="Extra trust roots (PEM or DER) for B-LT and B-LTA.",
    )
    reason: str | None = None
    location: str | None = None
    contact_info: str | None = None
    field_name: str | None = Field(
        default=None,
        description="Signature field name. Default: the first free Signature<N>.",
    )
    page: PageIndex | None = Field(
        default=None, description="0-based page for a visible signature. Needs rect."
    )
    rect: Annotated[list[float], Field(min_length=4, max_length=4)] | None = Field(
        default=None, description="[x1, y1, x2, y2] in PDF points. Needs page."
    )

    @field_validator("tsa_urls")
    @classmethod
    def _tsa_schemes(cls, urls: list[str]) -> list[str]:
        for url in urls:
            if not url.startswith(ALLOWED_SCHEMES):
                raise ValueError("timestamp server URLs must start with http:// or https://")
        return urls

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if (self.page is None) != (self.rect is None):
            raise ValueError("page and rect must be given together for a visible signature")
        if self.rect is not None:
            x1, y1, x2, y2 = self.rect
            if x2 <= x1 or y2 <= y1:
                raise ValueError("rect must be [x1, y1, x2, y2] with x2 > x1 and y2 > y1")
        if self.level != "B-B" and not self.tsa_urls:
            raise ValueError(f"level {self.level} needs at least one tsaUrls entry")
        return self


@operation(
    id="sign.pades",
    title="Sign with a certificate (PAdES)",
    group="sign",
    params=SignPadesParams,
    finalizing=True,
)
def sign_pades_op(ctx: OpContext, p: SignPadesParams) -> OpOutput:
    if ctx.input_path is None or ctx.result_path is None:
        raise RuntimeError("sign.pades needs a session")
    ctx.check_cancelled()
    loaded = load_pfx(p.pfx_path, p.password)
    info = cert_info(loaded.certificate)
    if info.expired:
        raise ChefError(
            ErrorKind.SIGN_CERT_EXPIRED,
            "The certificate has expired",
            {"notAfter": info.not_after},
        )
    if info.expiring_soon:
        ctx.warn(f"The certificate expires in {info.days_until_expiry} day(s).")

    spot: VisibleSpot | None = None
    if p.page is not None and p.rect is not None:
        with opened_pdf(ctx.input_path) as doc:
            count = len(doc.pages)
        if p.page >= count:
            raise invalid_params("Page is out of range", {"field": "page"})
        spot = VisibleSpot(page=p.page, rect=(p.rect[0], p.rect[1], p.rect[2], p.rect[3]))

    level: SigningLevel = p.level
    digest: DigestName = p.digest
    appearance: AppearanceStreamProvider = PlaceholderAppearance()
    result = sign_pades(
        PadesRequest(
            source=ctx.input_path,
            destination=ctx.result_path,
            signer=loaded,
            level=level,
            digest=digest,
            tsa_urls=tuple(p.tsa_urls),
            trust_roots=load_certificate_files(p.trust_root_paths),
            field_name=p.field_name,
            spot=spot,
            reason=p.reason,
            location=p.location,
            contact_info=p.contact_info,
            appearance=appearance,
        )
    )
    ctx.modified = True
    changed = [p.page] if p.page is not None and spot is not None else []
    return OpOutput(
        changed_pages=changed,
        data={
            "fieldName": result.field_name,
            "level": level,
            "tsaUrl": result.tsa_url,
            "signer": info.model_dump(by_alias=True, mode="json"),
        },
    )
