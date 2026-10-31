"""PAdES signing engine (feature I28): B-B, B-T, B-LT and B-LTA with pyHanko.

The signature is appended to the current revision file (incremental update): bytes written by
earlier signatures are never rewritten, so those signatures stay valid.

Visible signatures are drawn by an ``AppearanceStreamProvider``. ``PlaceholderAppearance`` is the
stand-in until the real appearance engine (T3.09, reportlab based) replaces it.
"""

from __future__ import annotations

import datetime as dt
import math
import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import count
from pathlib import Path
from typing import Literal, Protocol

from asn1crypto import x509 as asn1_x509
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.pdf_utils.text import TextBoxStyle
from pyhanko.sign.fields import SigFieldSpec, SigSeedSubFilter, enumerate_sig_fields
from pyhanko.sign.signers.pdf_signer import PdfSignatureMetadata, PdfSigner
from pyhanko.stamp import BaseStampStyle, TextStampStyle
from pyhanko_certvalidator import ValidationContext

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.signing.certinfo import describe_identity
from chef_core.signing.pfx import PfxCertificate
from chef_core.signing.tsa import FallbackTimeStamper

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


@dataclass(frozen=True)
class PadesResult:
    field_name: str
    tsa_url: str | None


def existing_field_names(writer: IncrementalPdfFileWriter) -> set[str]:
    return {str(name) for name, *_ in enumerate_sig_fields(writer)}


def next_field_name(existing: set[str]) -> str:
    """``Signature1``, ``Signature2``, … the first one not used yet."""
    for n in count(1):
        candidate = f"{FIELD_PREFIX}{n}"
        if candidate not in existing:
            return candidate
    raise AssertionError("unreachable")  # pragma: no cover


def load_certificate_files(paths: Sequence[str | Path]) -> tuple[x509.Certificate, ...]:
    """Read PEM or DER certificates from files (used for extra trust roots)."""
    certs: list[x509.Certificate] = []
    for raw in paths:
        path = Path(raw)
        if not path.is_file():
            raise ChefError(ErrorKind.FILE_NOT_FOUND, "File not found", {"path": str(path)})
        data = path.read_bytes()
        try:
            certs.append(
                x509.load_pem_x509_certificate(data)
                if b"-----BEGIN" in data
                else x509.load_der_x509_certificate(data)
            )
        except ValueError as exc:
            raise ChefError(
                ErrorKind.SIGN_BAD_CERT, "Not a certificate file", {"path": str(path)}
            ) from exc
    return tuple(certs)


def _trust_anchors(req: PadesRequest) -> list[asn1_x509.Certificate]:
    """Explicit trust roots, plus self-signed certificates that came with the signer."""
    candidates = list(req.trust_roots)
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
        trust_roots=_trust_anchors(req), allow_fetching=True, revocation_mode="hard-fail"
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
    )


def sign_pades(req: PadesRequest) -> PadesResult:
    """Sign ``req.source`` into ``req.destination``. Raises ``ChefError`` on every failure."""
    timestamper = FallbackTimeStamper(req.tsa_urls) if req.level in TIMESTAMP_LEVELS else None
    if timestamper is None and req.level != "B-B":  # pragma: no cover - guarded by params
        raise invalid_params("This level needs a timestamp server")
    validation = _validation_context(req) if req.level in VALIDATION_LEVELS else None

    with req.source.open("rb") as src:
        writer = IncrementalPdfFileWriter(src, strict=False)
        existing = existing_field_names(writer)
        field_name = req.field_name or next_field_name(existing)
        spec: SigFieldSpec | None = None
        stamp: BaseStampStyle | None = None
        if req.spot is not None:
            if field_name in existing:
                raise invalid_params(
                    f"A signature field named {field_name} already exists",
                    {"field": "fieldName"},
                )
            x1, y1, x2, y2 = req.spot.rect
            # pyHanko takes whole points; round outwards so the widget covers the request.
            box = (math.floor(x1), math.floor(y1), math.ceil(x2), math.ceil(y2))
            spec = SigFieldSpec(field_name, on_page=req.spot.page, box=box)
            stamp = req.appearance.stamp_style(_appearance_info(req), x2 - x1, y2 - y1)

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
    )
