"""PAdES signing engine (feature I28): B-B, B-T, B-LT and B-LTA with pyHanko.

The signature is appended to the current revision file (incremental update): bytes written by
earlier signatures are never rewritten, so those signatures stay valid.

Visible signatures are drawn by an ``AppearanceStreamProvider`` (appearance.py, T3.09). The
``PlaceholderAppearance`` class is kept for compatibility only and is no longer the default.

Certification (DocMDP, T3.07) is requested with ``certify`` on the first signature. A document
certified "no changes" accepts no further signatures; "form filling" accepts signatures only
in fields that already exist.
"""

from __future__ import annotations

import datetime as dt
import math
import re
import unicodedata
from dataclasses import dataclass
from itertools import count
from pathlib import Path
from typing import Literal, Protocol

from asn1crypto import x509 as asn1_x509
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.pdf_utils.text import TextBoxStyle
from pyhanko.sign.fields import MDPPerm, SigFieldSpec, SigSeedSubFilter, enumerate_sig_fields
from pyhanko.sign.signers.pdf_signer import PdfSignatureMetadata, PdfSigner
from pyhanko.stamp import BaseStampStyle, TextStampStyle
from pyhanko_certvalidator import ValidationContext

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.pdf.io import opened_pdf
from chef_core.signing.certinfo import describe_identity
from chef_core.signing.fields import certification_level, list_signature_fields
from chef_core.signing.pfx import PfxCertificate
from chef_core.signing.trust import default_trust_store
from chef_core.signing.tsa import FallbackTimeStamper
from chef_core.signing.verify import KEY_POLICY

SigningLevel = Literal["B-B", "B-T", "B-LT", "B-LTA"]
DigestName = Literal["sha256", "sha384", "sha512"]
TIMESTAMP_LEVELS: frozenset[str] = frozenset({"B-T", "B-LT", "B-LTA"})
VALIDATION_LEVELS: frozenset[str] = frozenset({"B-LT", "B-LTA"})
FIELD_PREFIX = "Signature"


# -- visible appearance hook --------------------------------------------------------------


@dataclass(frozen=True)
class AppearanceInfo:
    """What a visible signature may show. Values come from the certificate unless overridden."""

    signer_name: str
    organization: str | None
    reason: str | None
    location: str | None
    signed_at: dt.datetime
    tax_code: str | None = None
    citizen_id: str | None = None
    contact: str | None = None


class AppearanceStreamProvider(Protocol):
    """Builds the look of a visible signature box (the hook that T3.09 implements).

    ``width`` and ``height`` are the box size in PDF points.
    """

    def stamp_style(self, info: AppearanceInfo, width: float, height: float) -> BaseStampStyle:
        """Return the stamp style to draw inside the signature box."""
        ...


_ASCII_ONLY = re.compile(r"[^\x20-\x7e]")


def _ascii(value: str) -> str:
    """ASCII approximation of a Vietnamese string (the built-in font has no Vietnamese glyphs)."""
    folded = unicodedata.normalize("NFKD", value).replace("đ", "d").replace("Đ", "D")
    folded = "".join(ch for ch in folded if not unicodedata.combining(ch))
    return _ASCII_ONLY.sub("?", folded).replace("%", " ")


class PlaceholderAppearance:
    """Plain ASCII box with name, date and reason. Temporary; replaced by T3.09."""

    def stamp_style(self, info: AppearanceInfo, width: float, height: float) -> BaseStampStyle:
        lines = ["Digitally signed by", _ascii(info.signer_name)]
        if info.organization:
            lines.append(_ascii(info.organization))
        lines.append(info.signed_at.strftime("%Y-%m-%d %H:%M UTC"))
        if info.reason:
            lines.append("Reason: " + _ascii(info.reason))
        return TextStampStyle(
            stamp_text="\n".join(lines),
            text_box_style=TextBoxStyle(font_size=8),
            border_width=1,
            border_color=(0.2, 0.2, 0.2),
        )


# -- request --------------------------------------------------------------------------------


@dataclass(frozen=True)
class VisibleSpot:
    page: int  # 0-based
    rect: tuple[float, float, float, float]  # x1, y1, x2, y2 in PDF points


@dataclass(frozen=True)
class PadesRequest:
    source: Path  # revision file to sign (read only)
    destination: Path  # new revision file (written)
    signer: PfxCertificate
    level: SigningLevel
    digest: DigestName
    tsa_urls: tuple[str, ...]
    trust_roots: tuple[x509.Certificate, ...]
    field_name: str | None
    spot: VisibleSpot | None
    reason: str | None
    location: str | None
    contact_info: str | None
    appearance: AppearanceStreamProvider
    certify: MDPPerm | None = None


@dataclass(frozen=True)
class PadesResult:
    field_name: str
    tsa_url: str | None
    page: int | None  # page of the visible box (None when invisible)


def existing_field_names(writer: IncrementalPdfFileWriter) -> set[str]:
    return {str(name) for name, *_ in enumerate_sig_fields(writer)}


def next_field_name(existing: set[str]) -> str:
    """``Signature1``, ``Signature2``, … the first one not used yet."""
    for n in count(1):
        candidate = f"{FIELD_PREFIX}{n}"
        if candidate not in existing:
            return candidate
    raise AssertionError("unreachable")  # pragma: no cover


def _trust_anchors(req: PadesRequest) -> list[asn1_x509.Certificate]:
    """Explicit trust roots, the trust store's roots, and self-signed certificates of the signer."""
    candidates = list(req.trust_roots)
    candidates += default_trust_store().anchors()
    candidates += [c for c in (req.signer.certificate, *req.signer.chain) if c.subject == c.issuer]
    seen: set[bytes] = set()
    anchors: list[asn1_x509.Certificate] = []
    for cert in candidates:
        der = cert.public_bytes(serialization.Encoding.DER)
        if der not in seen:
            seen.add(der)
            anchors.append(asn1_x509.Certificate.load(der))
    if not anchors:
        raise invalid_params(
            "B-LT and B-LTA need a trust anchor: include the Root CA in the certificate file "
            "or pass its file in trustRootPaths",
            {"field": "trustRootPaths"},
        )
    return anchors


def _validation_context(req: PadesRequest) -> ValidationContext:
    # hard-fail: a signature must not be long-term without revocation data for its chain.
    return ValidationContext(
        trust_roots=_trust_anchors(req),
        allow_fetching=True,
        revocation_mode="hard-fail",
        algorithm_usage_policy=KEY_POLICY,
    )


def _appearance_info(req: PadesRequest) -> AppearanceInfo:
    identity = describe_identity(req.signer.certificate)
    name = (
        identity.person_name
        or identity.organization
        or req.signer.certificate.subject.rfc4514_string()
    )
    return AppearanceInfo(
        signer_name=name,
        organization=identity.organization,
        reason=req.reason,
        location=req.location,
        signed_at=dt.datetime.now(dt.UTC),
        tax_code=identity.tax_code,
        citizen_id=identity.citizen_id,
        contact=req.contact_info,
    )


def _rounded_box(rect: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
    """Whole points, rounded outwards (pyHanko widgets take integers)."""
    x1, y1, x2, y2 = rect
    return (math.floor(x1), math.floor(y1), math.ceil(x2), math.ceil(y2))


def check_changes_allowed(
    source: Path, *, creates_field: bool, certify: MDPPerm | None = None, op_id: str
) -> None:
    """Refuse a change the document's certification forbids (BLOCKED_BY_SIGNATURE).

    ``creates_field``: the change adds a signature field (needs ANNOTATE under FILL_FORMS).
    ``certify``: the signature to add certifies the document (only allowed if none is signed).
    """
    with opened_pdf(source) as pdf:
        fields = list_signature_fields(pdf)
        level = certification_level(pdf)
    if certify is not None and any(f.signed for f in fields):
        raise invalid_params(
            "Only the first signature of a document can certify it",
            {"field": "certify"},
        )
    if level == MDPPerm.NO_CHANGES:
        raise ChefError(
            ErrorKind.BLOCKED_BY_SIGNATURE,
            "The document is certified with no changes allowed",
            {"opId": op_id},
        )
    if creates_field and level == MDPPerm.FILL_FORMS:
        raise ChefError(
            ErrorKind.BLOCKED_BY_SIGNATURE,
            "The document is certified for form filling: new signature fields are not allowed",
            {"opId": op_id},
        )


def preflight_pades(
    source: Path,
    *,
    field_name: str | None,
    visible: bool,
    certify: MDPPerm | None,
    op_id: str,
) -> None:
    """Refuse a signing that the document cannot take, before anything is signed.

    Token operations call this before they log in, so a refused signing never uses the PIN.
    """
    with opened_pdf(source) as pdf:
        fields = {f.name: f for f in list_signature_fields(pdf)}
    target = fields.get(field_name) if field_name else None
    if target is not None and target.signed:
        raise invalid_params(
            f"The signature field {target.name} is already signed",
            {"field": "fieldName"},
        )
    check_changes_allowed(
        source,
        creates_field=visible or target is None,
        certify=certify,
        op_id=op_id,
    )


def sign_pades(req: PadesRequest) -> PadesResult:
    """Sign ``req.source`` into ``req.destination``. Raises ``ChefError`` on every failure."""
    timestamper = FallbackTimeStamper(req.tsa_urls) if req.level in TIMESTAMP_LEVELS else None
    if timestamper is None and req.level != "B-B":  # pragma: no cover - guarded by params
        raise invalid_params("This level needs a timestamp server")
    validation = _validation_context(req) if req.level in VALIDATION_LEVELS else None

    preflight_pades(
        req.source,
        field_name=req.field_name,
        visible=req.spot is not None,
        certify=req.certify,
        op_id="sign.pades",
    )
    with opened_pdf(req.source) as pdf:
        fields = {f.name: f for f in list_signature_fields(pdf)}
    target = fields.get(req.field_name) if req.field_name else None

    with req.source.open("rb") as src:
        writer = IncrementalPdfFileWriter(src, strict=False)
        existing = existing_field_names(writer)
        field_name = req.field_name or next_field_name(existing)
        spec: SigFieldSpec | None = None
        stamp: BaseStampStyle | None = None
        page: int | None = None
        info = _appearance_info(req)
        if req.spot is not None:
            if field_name in existing:
                raise invalid_params(
                    f"A signature field named {field_name} already exists",
                    {"field": "fieldName"},
                )
            box = _rounded_box(req.spot.rect)
            spec = SigFieldSpec(field_name, on_page=req.spot.page, box=box)
            stamp = req.appearance.stamp_style(info, float(box[2] - box[0]), float(box[3] - box[1]))
            page = req.spot.page
        elif target is not None and target.rect is not None and target.rect[2] > target.rect[0]:
            # An existing empty field with a visible widget: the box is drawn inside it.
            box = _rounded_box(target.rect)
            stamp = req.appearance.stamp_style(info, float(box[2] - box[0]), float(box[3] - box[1]))
            page = target.page

        metadata = PdfSignatureMetadata(
            field_name=field_name,
            md_algorithm=req.digest,
            subfilter=SigSeedSubFilter.PADES,
            reason=req.reason,
            location=req.location,
            contact_info=req.contact_info,
            embed_validation_info=validation is not None,
            validation_context=validation,
            use_pades_lta=req.level == "B-LTA",
            certify=req.certify is not None,
            docmdp_permissions=req.certify or MDPPerm.FILL_FORMS,
        )
        signer = PdfSigner(
            metadata,
            req.signer.signer,
            timestamper=timestamper,
            stamp_style=stamp,
            new_field_spec=spec,
        )
        try:
            with req.destination.open("wb") as out:
                signer.sign_pdf(writer, output=out)
        except ChefError:
            raise
        except Exception as exc:
            if timestamper is not None and timestamper.exhausted:
                raise ChefError(
                    ErrorKind.SIGN_TSA_FAILED,
                    "No timestamp server answered; the signature was not made",
                    {"servers": timestamper.failures},
                ) from exc
            raise ChefError(
                ErrorKind.SIGN_FAILED, f"Signing failed: {type(exc).__name__}: {exc}"
            ) from exc

    return PadesResult(
        field_name=field_name,
        tsa_url=timestamper.used_url if timestamper is not None else None,
        page=page,
    )
