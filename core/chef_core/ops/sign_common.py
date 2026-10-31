"""Signing options shared by sign.pades, sign.padesToken and sign.batch (one field set, one path).

``SignOptions`` holds what every signature needs: level, digest, timestamp servers, trust roots,
reason / location / contact, the visible look (template) and certification. ``SignCommonParams``
adds where a visible box goes (fieldName, page, rect); both single-signature ops inherit it.
``sign.batch`` uses ``SignOptions`` directly and decides placement per file.

``build_request`` is the only place a ``PadesRequest`` is built, so the PFX and token paths can
not drift apart again.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Literal, Self

from cryptography import x509
from pydantic import Field, field_validator, model_validator
from pyhanko.sign.fields import MDPPerm

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext
from chef_core.pdf.io import opened_pdf
from chef_core.signing.appearance import SignatureTemplate, TemplateAppearance
from chef_core.signing.certinfo import CertInfo, cert_info
from chef_core.signing.pades import (
    DigestName,
    PadesRequest,
    SigningLevel,
    VisibleSpot,
)
from chef_core.signing.pfx import PfxCertificate
from chef_core.signing.trust import load_trust_paths
from chef_core.signing.tsa import ALLOWED_SCHEMES

PageIndex = Annotated[int, Field(ge=0)]
Rect4 = Annotated[list[float], Field(min_length=4, max_length=4)]
CERTIFY_LEVELS = {
    "no-changes": MDPPerm.NO_CHANGES,
    "form-fill": MDPPerm.FILL_FORMS,
    "annotate": MDPPerm.ANNOTATE,
}
CertifyLevel = Literal["no-changes", "form-fill", "annotate"]
LEVEL_DOC = (
    "B-B: signature only. B-T: + timestamp. B-LT: + revocation data. "
    "B-LTA: + document timestamp for long-term validity."
)
CERTIFY_DOC = (
    "Certify the document (DocMDP) with this signature. Only for the first signature of a "
    "document. no-changes: P=1; form-fill: P=2; annotate: P=3."
)
TRUST_DOC = (
    "Extra trust roots (PEM or DER files, or folders of them) for B-LT and B-LTA. The bundled "
    "and user trust stores are always used."
)


class SignOptions(WireModel):
    """Options of one signature, without any placement."""

    level: Literal["B-B", "B-T", "B-LT", "B-LTA"] = Field(default="B-B", description=LEVEL_DOC)
    digest: Literal["sha256", "sha384", "sha512"] = "sha256"
    tsa_urls: list[str] = Field(
        default_factory=list,
        description="Timestamp servers, tried in order. Required for B-T and above.",
    )
    trust_root_paths: list[str] = Field(default_factory=list, description=TRUST_DOC)
    reason: str | None = None
    location: str | None = None
    contact_info: str | None = None
    template: SignatureTemplate | None = Field(
        default=None,
        description="Look of a visible signature. Default: a plain text box.",
    )
    certify: CertifyLevel | None = Field(default=None, description=CERTIFY_DOC)

    @field_validator("tsa_urls")
    @classmethod
    def _tsa_schemes(cls, urls: list[str]) -> list[str]:
        for url in urls:
            if not url.startswith(ALLOWED_SCHEMES):
                raise ValueError("timestamp server URLs must start with http:// or https://")
        return urls

    @model_validator(mode="after")
    def _level_needs_timestamp_server(self) -> Self:
        if self.level != "B-B" and not self.tsa_urls:
            raise ValueError(f"level {self.level} needs at least one tsaUrls entry")
        return self


class SignCommonParams(SignOptions):
    """Options of a single signature that is placed by fieldName / page / rect."""

    field_name: str | None = Field(
        default=None,
        description="Signature field name. Default: the first free Signature<N>.",
    )
    page: PageIndex | None = Field(
        default=None, description="0-based page for a visible signature. Needs rect."
    )
    rect: Rect4 | None = Field(
        default=None,
        description="[x1, y1, x2, y2] in PDF points. Needs page. Also draws into an existing "
        "empty field of that name.",
    )

    @model_validator(mode="after")
    def _visible_box_is_complete(self) -> Self:
        if (self.page is None) != (self.rect is None):
            raise ValueError("page and rect must be given together for a visible signature")
        if self.rect is not None:
            x1, y1, x2, y2 = self.rect
            if x2 <= x1 or y2 <= y1:
                raise ValueError("rect must be [x1, y1, x2, y2] with x2 > x1 and y2 > y1")
        return self


def certify_permission(certify: CertifyLevel | None) -> MDPPerm | None:
    return CERTIFY_LEVELS[certify] if certify is not None else None


def visible_spot(source: Path, page: int | None, rect: list[float] | None) -> VisibleSpot | None:
    """The page and box of a visible signature, or None. Refuses a page outside the document."""
    if page is None or rect is None:
        return None
    with opened_pdf(source) as doc:
        count = len(doc.pages)
    if page >= count:
        raise invalid_params("Page is out of range", {"field": "page"})
    return VisibleSpot(page=page, rect=(rect[0], rect[1], rect[2], rect[3]))


def check_signer(ctx: OpContext, certificate: x509.Certificate) -> CertInfo:
    """Refuse an expired signing certificate; warn when it expires soon. Returns its details."""
    info = cert_info(certificate)
    if info.expired:
        raise ChefError(
            ErrorKind.SIGN_CERT_EXPIRED,
            "The certificate has expired",
            {"notAfter": info.not_after},
        )
    if info.expiring_soon:
        ctx.warn(f"The certificate expires in {info.days_until_expiry} day(s).")
    return info


def build_request(
    options: SignOptions,
    *,
    source: Path,
    destination: Path,
    signer: PfxCertificate,
    spot: VisibleSpot | None,
    field_name: str | None,
) -> PadesRequest:
    """The one request every signing path uses. Reads the template and trust files it names."""
    level: SigningLevel = options.level
    digest: DigestName = options.digest
    return PadesRequest(
        source=source,
        destination=destination,
        signer=signer,
        level=level,
        digest=digest,
        tsa_urls=tuple(options.tsa_urls),
        trust_roots=tuple(load_trust_paths(options.trust_root_paths)),
        field_name=field_name,
        spot=spot,
        reason=options.reason,
        location=options.location,
        contact_info=options.contact_info,
        appearance=TemplateAppearance(options.template or SignatureTemplate()),
        certify=certify_permission(options.certify),
    )
