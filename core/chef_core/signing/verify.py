"""Signature verification (feature I34) and the signed-revision view (I35).

``verify_document`` reads every signature of a file and reports, for each one, what it covers,
who signed, when, whether the timestamp holds, whether the certificate chain is trusted and what
revocation data says. It never raises for a bad signature: a damaged signature is reported as
``invalid`` with reasons. Only a file that cannot be opened at all is an error.

Method. pyHanko does the cryptography (integrity, chain building, DocMDP and difference analysis).
This module collects the revocation data itself: it reads the DSS of the file first, then fetches
CRLs and OCSP responses that are missing. The result is handed to pyHanko as fixed data
(``allow_fetching=False``), so the answer is known to be the one shown here. A failed fetch is
``REVOCATION_UNKNOWN``: a warning in soft mode, ``unknown`` in hard mode or with ``allowOffline``
false. The timestamp authority's certificates are checked too, but a missing answer for them is
not a warning (only revocation of the signer's chain affects the status).

``extract_revision`` writes the bytes a signature covers: the file cut at the end of its ByteRange.
"""

from __future__ import annotations

import datetime as dt
import io
import urllib.request
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import pikepdf
from asn1crypto import x509 as asn1_x509
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.x509 import ocsp
from cryptography.x509.oid import AuthorityInformationAccessOID, ExtendedKeyUsageOID
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.diff_analysis import ModificationLevel, SuspiciousModification
from pyhanko.sign.fields import MDPPerm
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko.sign.validation.status import PdfSignatureStatus, SignatureCoverageLevel
from pyhanko_certvalidator import ValidationContext

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.pdf.io import atomic_write, opened_pdf
from chef_core.signing.certinfo import cert_info
from chef_core.signing.fields import certification_level, list_signature_fields
from chef_core.signing.trust import TrustStore, fingerprint_of

CheckMode = Literal["none", "soft", "hard"]
FetchFn = Callable[..., bytes]  # fetch(url, timeout, body=None) -> bytes
MAX_RESPONSE_BYTES = 5 * 1024 * 1024

# Machine reasons. Invalid reasons make the status "invalid"; trust reasons make it "unknown".
INVALID_REASONS = frozenset(
    {
        "INTEGRITY_FAILED",
        "CERT_REVOKED",
        "CERT_EXPIRED_AT_SIGNING",
        "DOCMDP_VIOLATION",
        "TIMESTAMP_INVALID",
        "SIGNATURE_UNREADABLE",
    }
)

REASON_TEXT: dict[str, tuple[str, str]] = {
    "INTEGRITY_FAILED": ("nội dung đã ký bị thay đổi", "the signed content was changed"),
    "MODIFIED_AFTER_SIGNING": (
        "tài liệu được sửa sau khi ký",
        "the document changed after signing",
    ),
    "CERT_UNTRUSTED": ("chứng thư không thuộc kho tin cậy", "the certificate is not trusted"),
    "CERT_REVOKED": ("chứng thư đã bị thu hồi", "the certificate has been revoked"),
    "CERT_EXPIRED_AT_SIGNING": (
        "chứng thư đã hết hạn tại thời điểm ký",
        "the certificate had expired when it was signed",
    ),
    "CERT_EXPIRED_NOW": (
        "chứng thư đã hết hạn và không có dấu thời gian",
        "the certificate has expired and there is no timestamp",
    ),
    "REVOCATION_UNKNOWN": (
        "chưa kiểm tra được trạng thái thu hồi",
        "revocation status could not be checked",
    ),
    "DOCMDP_VIOLATION": (
        "thay đổi vi phạm quyền của chữ ký chứng nhận",
        "a change breaks the certification permissions",
    ),
    "TIMESTAMP_INVALID": ("dấu thời gian không hợp lệ", "the timestamp is not valid"),
    "UNSIGNED_FIELD": ("ô chữ ký chưa được ký", "the signature field is not signed"),
    "SIGNATURE_UNREADABLE": ("không đọc được dữ liệu chữ ký", "the signature data cannot be read"),
}

STATUS_HEAD: dict[str, tuple[str, str]] = {
    "valid": ("Chữ ký hợp lệ.", "The signature is valid."),
    "valid-with-warnings": (
        "Chữ ký hợp lệ nhưng có cảnh báo.",
        "The signature is valid with warnings.",
    ),
    "invalid": ("Chữ ký KHÔNG hợp lệ.", "The signature is NOT valid."),
    "unknown": (
        "Chưa xác định được độ tin cậy của chữ ký.",
        "The signature could not be confirmed.",
    ),
    "unsigned": ("Ô chữ ký chưa được ký.", "The signature field is not signed."),
}


@dataclass(frozen=True)
class VerifyOptions:
    trust: TrustStore
    extra_trust_roots: list[x509.Certificate] = field(default_factory=list)
    check_revocation: CheckMode = "soft"
    allow_offline: bool = True
    timeout_seconds: int = 15


@dataclass
class _Revocation:
    cert: x509.Certificate
    source: str  # "embedded" | "crl" | "ocsp" | "none"
    status: str  # "good" | "revoked" | "unknown" | "skipped"
    crl: bytes | None = None
    ocsp: bytes | None = None


@dataclass
class _Embedded:
    crls: list[tuple[bytes, x509.CertificateRevocationList]] = field(default_factory=list)
    ocsps: list[tuple[bytes, ocsp.OCSPResponse]] = field(default_factory=list)
    certs: list[x509.Certificate] = field(default_factory=list)

    @property
    def has_validation_info(self) -> bool:
        return bool(self.crls or self.ocsps or self.certs)


# -- network --------------------------------------------------------------------------------


def http_fetch(url: str, timeout: float, body: bytes | None = None) -> bytes:
    """GET (or POST ``body``) a CRL or OCSP responder. Raises ``OSError`` on any failure."""
    if not url.startswith(("http://", "https://")):
        raise OSError(f"unsupported revocation URL: {url}")
    headers = {"Content-Type": "application/ocsp-request"} if body is not None else {}
    request = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        data: bytes = response.read(MAX_RESPONSE_BYTES + 1)
    if len(data) > MAX_RESPONSE_BYTES:
        raise OSError("revocation response too large")
    return data


def _memoized(fetch: FetchFn) -> FetchFn:
    """Each URL is fetched at most once per verification (signatures share their CAs)."""
    cache: dict[tuple[str, bytes | None], bytes] = {}

    def cached(url: str, timeout: float, body: bytes | None = None) -> bytes:
        key = (url, body)
        if key not in cache:
            cache[key] = fetch(url, timeout, body)
        return cache[key]

    return cached


# -- certificate helpers ----------------------------------------------------------------------


def _as_crypto(cert: Any) -> x509.Certificate:
    if isinstance(cert, x509.Certificate):
        return cert
    return x509.load_der_x509_certificate(cert.dump())


def _as_asn1(cert: x509.Certificate) -> asn1_x509.Certificate:
    return asn1_x509.Certificate.load(cert.public_bytes(serialization.Encoding.DER))


def _is_root(cert: x509.Certificate) -> bool:
    return cert.subject == cert.issuer


def _dedupe(certs: Iterable[x509.Certificate]) -> list[x509.Certificate]:
    seen: set[str] = set()
    unique: list[x509.Certificate] = []
    for cert in certs:
        key = fingerprint_of(cert)
        if key not in seen:
            seen.add(key)
            unique.append(cert)
    return unique


def _issuer_of(cert: x509.Certificate, pool: list[x509.Certificate]) -> x509.Certificate | None:
    for candidate in pool:
        if candidate.subject != cert.issuer or candidate == cert:
            continue
        try:
            cert.verify_directly_issued_by(candidate)
        except (ValueError, TypeError):
            continue
        except Exception:  # unsupported key or signature algorithm
            continue
        return candidate
    return None


def _chain(leaf: x509.Certificate, pool: list[x509.Certificate]) -> list[x509.Certificate]:
    """The leaf and its issuers found in ``pool``, stopping at a self-issued certificate."""
    chain = [leaf]
    current = leaf
    while not _is_root(current):
        issuer = _issuer_of(current, pool)
        if issuer is None or any(issuer == c for c in chain):
            break
        chain.append(issuer)
        current = issuer
    return chain


def _aware(value: dt.datetime) -> dt.datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=dt.UTC)


def _cdp_urls(cert: x509.Certificate) -> list[str]:
    try:
        points = cert.extensions.get_extension_for_class(x509.CRLDistributionPoints).value
    except x509.ExtensionNotFound:
        return []
    urls: list[str] = []
    for point in points:
        for name in point.full_name or []:
            if isinstance(name, x509.UniformResourceIdentifier):
                urls.append(name.value)
    return urls


def _ocsp_urls(cert: x509.Certificate) -> list[str]:
    try:
        access = cert.extensions.get_extension_for_class(x509.AuthorityInformationAccess).value
    except x509.ExtensionNotFound:
        return []
    return [
        desc.access_location.value
        for desc in access
        if desc.access_method == AuthorityInformationAccessOID.OCSP
        and isinstance(desc.access_location, x509.UniformResourceIdentifier)
    ]


# -- revocation -------------------------------------------------------------------------------


def _crl_status(
    crl: x509.CertificateRevocationList,
    cert: x509.Certificate,
    issuer: x509.Certificate,
    now: dt.datetime,
) -> str | None:
    """ "good" or "revoked" when ``crl`` is a current, signed CRL of ``issuer``; else None."""
    try:
        issuer_key: Any = issuer.public_key()
        if crl.issuer != issuer.subject or not crl.is_signature_valid(issuer_key):
            return None
        if crl.next_update_utc is not None and crl.next_update_utc < now:
            return None
    except Exception:
        return None
    return "revoked" if crl.get_revoked_certificate_by_serial_number(cert.serial_number) else "good"


def _signed_by(response: ocsp.OCSPResponse, signer: x509.Certificate) -> bool:
    """True when the response signature verifies with the public key of ``signer``."""
    try:
        hash_algorithm = response.signature_hash_algorithm
        if hash_algorithm is None:
            return False
        key: Any = signer.public_key()
        if isinstance(key, rsa.RSAPublicKey):
            key.verify(
                response.signature,
                response.tbs_response_bytes,
                padding.PKCS1v15(),
                hash_algorithm,
            )
        elif isinstance(key, ec.EllipticCurvePublicKey):
            key.verify(
                response.signature,
                response.tbs_response_bytes,
                ec.ECDSA(hash_algorithm),
            )
        else:
            return False
    except Exception:
        return False
    return True


def _is_ocsp_signer(cert: x509.Certificate, issuer: x509.Certificate) -> bool:
    """A certificate the issuer delegated to answer OCSP requests (id-kp-OCSPSigning)."""
    try:
        cert.verify_directly_issued_by(issuer)
        usage = cert.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value
    except Exception:
        return False
    return ExtendedKeyUsageOID.OCSP_SIGNING in usage


def _response_is_authentic(response: ocsp.OCSPResponse, issuer: x509.Certificate) -> bool:
    """Signed by the issuer itself, or by a delegated responder that the issuer certified."""
    if _signed_by(response, issuer):
        return True
    try:
        delegated = list(response.certificates)
    except Exception:
        return False
    return any(_is_ocsp_signer(c, issuer) and _signed_by(response, c) for c in delegated)


def _ocsp_status(
    response: ocsp.OCSPResponse,
    cert: x509.Certificate,
    issuer: x509.Certificate,
    now: dt.datetime,
) -> str | None:
    """ "good" or "revoked" for ``cert`` when the response is genuine and current; else None.

    A response that the issuer did not sign (forged, or from another CA) is ignored, and so is a
    response past its nextUpdate (an old "good" answer proves nothing about today).
    """
    try:
        if response.response_status != ocsp.OCSPResponseStatus.SUCCESSFUL:
            return None
        if response.serial_number != cert.serial_number:
            return None
        next_update = response.next_update_utc
        if next_update is None or next_update < now:
            return None
        if response.this_update_utc > now:
            return None
        if not _response_is_authentic(response, issuer):
            return None
        if response.certificate_status == ocsp.OCSPCertStatus.GOOD:
            return "good"
        if response.certificate_status == ocsp.OCSPCertStatus.REVOKED:
            return "revoked"
    except Exception:
        return None
    return None


def _ocsp_request(cert: x509.Certificate, issuer: x509.Certificate) -> bytes:
    builder = ocsp.OCSPRequestBuilder().add_certificate(cert, issuer, hashes.SHA1())
    return builder.build().public_bytes(serialization.Encoding.DER)


def _revocation_for(
    cert: x509.Certificate,
    issuer: x509.Certificate | None,
    embedded: _Embedded,
    mode: CheckMode,
    fetch: FetchFn,
    timeout: float,
    now: dt.datetime,
) -> _Revocation:
    if issuer is not None:
        for raw, crl in embedded.crls:
            status = _crl_status(crl, cert, issuer, now)
            if status is not None:
                return _Revocation(cert, "embedded", status, crl=raw)
        for raw, response in embedded.ocsps:
            status = _ocsp_status(response, cert, issuer, now)
            if status is not None:
                return _Revocation(cert, "embedded", status, ocsp=raw)
    if mode == "none":
        return _Revocation(cert, "none", "skipped")
    if issuer is None:
        return _Revocation(cert, "none", "unknown")
    for url in _cdp_urls(cert):
        try:
            raw = fetch(url, timeout)
            crl = x509.load_der_x509_crl(raw)
        except Exception:
            continue
        status = _crl_status(crl, cert, issuer, now)
        if status is not None:
            return _Revocation(cert, "crl", status, crl=raw)
    for url in _ocsp_urls(cert):
        try:
            raw = fetch(url, timeout, _ocsp_request(cert, issuer))
            response = ocsp.load_der_ocsp_response(raw)
        except Exception:
            continue
        status = _ocsp_status(response, cert, issuer, now)
        if status is not None:
            return _Revocation(cert, "ocsp", status, ocsp=raw)
    return _Revocation(cert, "none", "unknown")


def _chain_revocation(
    chain: list[x509.Certificate],
    embedded: _Embedded,
    mode: CheckMode,
    fetch: FetchFn,
    timeout: float,
    now: dt.datetime,
) -> list[_Revocation]:
    rows: list[_Revocation] = []
    for index, cert in enumerate(chain):
        if _is_root(cert):
            continue
        issuer = chain[index + 1] if index + 1 < len(chain) else None
        rows.append(_revocation_for(cert, issuer, embedded, mode, fetch, timeout, now))
    return rows


def _read_dss(pdf: pikepdf.Pdf) -> _Embedded:
    """Validation information stored in the document (DSS): CRLs, OCSP responses, certificates."""
    embedded = _Embedded()
    dss = pdf.Root.get("/DSS")
    if dss is None:
        return embedded
    for stream in dss.get("/CRLs", []):
        raw = bytes(stream.read_bytes())
        try:
            embedded.crls.append((raw, x509.load_der_x509_crl(raw)))
        except ValueError:
            continue
    for stream in dss.get("/OCSPs", []):
        raw = bytes(stream.read_bytes())
        try:
            embedded.ocsps.append((raw, ocsp.load_der_ocsp_response(raw)))
        except ValueError:
            continue
    for stream in dss.get("/Certs", []):
        try:
            embedded.certs.append(x509.load_der_x509_certificate(bytes(stream.read_bytes())))
        except ValueError:
            continue
    return embedded


def _context(
    anchors: list[x509.Certificate],
    others: list[x509.Certificate],
    revocations: list[_Revocation],
    embedded: _Embedded,
    mode: CheckMode,
) -> ValidationContext:
    crls = [raw for raw, _ in embedded.crls] + [r.crl for r in revocations if r.crl]
    ocsps = [raw for raw, _ in embedded.ocsps] + [r.ocsp for r in revocations if r.ocsp]
    return ValidationContext(
        trust_roots=[_as_asn1(c) for c in anchors],
        other_certs=[_as_asn1(c) for c in others],
        crls=[bytes(c) for c in crls],
        ocsps=[bytes(o) for o in ocsps],
        allow_fetching=False,
        revocation_mode="hard-fail" if mode == "hard" else "soft-fail",
    )


# -- one signature ----------------------------------------------------------------------------


def _modification(status: PdfSignatureStatus) -> str:
    level = status.modification_level
    if level is None or level == ModificationLevel.OTHER:
        return "other"
    if level == ModificationLevel.FORM_FILLING:
        return "form-fill"
    if level == ModificationLevel.ANNOTATIONS:
        return "annotations"
    return "none"  # NONE, and LTA_UPDATES (only validation data or timestamps were added)


def _level(has_ts: bool, has_dss: bool, doc_ts_after: bool) -> str:
    if has_ts and doc_ts_after:
        return "B-LTA"
    if has_ts and has_dss:
        return "B-LT"
    if has_ts:
        return "B-T"
    return "B-B"


def _summaries(status: str, reasons: list[str]) -> tuple[str, str]:
    head_vi, head_en = STATUS_HEAD[status]
    if not reasons:
        return head_vi, head_en
    vi = "; ".join(REASON_TEXT[r][0] for r in reasons)
    en = "; ".join(REASON_TEXT[r][1] for r in reasons)
    return f"{head_vi} {vi[:1].upper()}{vi[1:]}.", f"{head_en} {en[:1].upper()}{en[1:]}."


def _status_of(reasons: list[str], strict_revocation: bool) -> str:
    if any(r in INVALID_REASONS for r in reasons):
        return "invalid"
    if "CERT_UNTRUSTED" in reasons or (strict_revocation and "REVOCATION_UNKNOWN" in reasons):
        return "unknown"
    return "valid-with-warnings" if reasons else "valid"


def _rev_rows(rows: list[_Revocation]) -> list[dict[str, Any]]:
    return [
        {
            "cert": r.cert.subject.rfc4514_string(),
            "fingerprintSha256": fingerprint_of(r.cert),
            "source": r.source,
            "status": r.status,
        }
        for r in rows
    ]


def _chain_rows(
    chain: list[x509.Certificate], trusted_path: bool, anchors: set[str]
) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for cert in chain:
        trusted = fingerprint_of(cert) in anchors if _is_root(cert) else trusted_path
        rows.append(
            {
                "subject": cert.subject.rfc4514_string(),
                "issuer": cert.issuer.rfc4514_string(),
                "notBefore": cert.not_valid_before_utc.isoformat(),
                "notAfter": cert.not_valid_after_utc.isoformat(),
                "trusted": trusted,
            }
        )
    return rows


@dataclass
class _Context:
    anchors: list[x509.Certificate]
    pool: list[x509.Certificate]
    embedded: _Embedded
    mode: CheckMode
    fetch: FetchFn
    timeout: float
    now: dt.datetime
    doc_timestamp_revisions: list[int]
    docmdp: MDPPerm | None
    allow_offline: bool


def _examine(emb: Any, c: _Context) -> dict[str, Any]:
    name = str(emb.field_name)
    signer = _as_crypto(emb.signer_cert)
    pool = _dedupe(c.pool + [_as_crypto(x) for x in emb.other_embedded_certs])
    chain = _chain(signer, _dedupe(c.anchors + pool))
    revs = _chain_revocation(chain, c.embedded, c.mode, c.fetch, c.timeout, c.now)
    anchors_fp = {fingerprint_of(a) for a in c.anchors}
    try:
        status = validate_pdf_signature(
            emb,
            signer_validation_context=_context(c.anchors, pool, revs, c.embedded, c.mode),
            ts_validation_context=_context(c.anchors, pool, revs, c.embedded, c.mode),
        )
        ts = status.timestamp_validity
        ts_revs: list[_Revocation] = []
        if ts is not None and ts.validation_path is not None:
            ts_chain = [_as_crypto(x) for x in ts.validation_path.iter_certs(include_root=True)]
            ts_revs = _chain_revocation(ts_chain, c.embedded, c.mode, c.fetch, c.timeout, c.now)
            if ts_revs:
                all_revs = revs + ts_revs
                status = validate_pdf_signature(
                    emb,
                    signer_validation_context=_context(
                        c.anchors, pool, all_revs, c.embedded, c.mode
                    ),
                    ts_validation_context=_context(c.anchors, pool, all_revs, c.embedded, c.mode),
                )
    except Exception:
        return _unreadable_item(name, signer, chain, revs, anchors_fp)

    return _signature_item(
        name=name,
        emb=emb,
        status=status,
        signer=signer,
        chain=chain,
        revs=revs,
        ts_revs=ts_revs,
        anchors_fp=anchors_fp,
        c=c,
    )


def _signature_item(
    *,
    name: str,
    emb: Any,
    status: PdfSignatureStatus,
    signer: x509.Certificate,
    chain: list[x509.Certificate],
    revs: list[_Revocation],
    ts_revs: list[_Revocation],
    anchors_fp: set[str],
    c: _Context,
) -> dict[str, Any]:
    intact = bool(status.intact)
    ts = status.timestamp_validity
    has_ts = ts is not None
    ts_ok = ts is not None and bool(ts.intact and ts.valid and ts.trusted)
    claimed = emb.self_reported_timestamp
    claimed_dt = _aware(claimed) if claimed is not None else None
    ts_dt = _aware(ts.timestamp) if ts is not None and ts_ok else None
    signing_time = ts_dt or claimed_dt

    reasons: list[str] = []

    def add(reason: str) -> None:
        if reason not in reasons:
            reasons.append(reason)

    revoked = any(r.status == "revoked" for r in revs) or status.revocation_details is not None
    if not intact:
        add("INTEGRITY_FAILED")
        add("MODIFIED_AFTER_SIGNING")
    if intact and revoked:
        add("CERT_REVOKED")
    if (
        intact
        and signing_time is not None
        and not (signer.not_valid_before_utc <= signing_time <= signer.not_valid_after_utc)
    ):
        add("CERT_EXPIRED_AT_SIGNING")
    if intact and has_ts and not ts_ok:
        add("TIMESTAMP_INVALID")
    if intact and c.docmdp is not None and status.docmdp_ok is False:
        add("DOCMDP_VIOLATION")
        add("MODIFIED_AFTER_SIGNING")
    level_text = _modification(status)
    suspicious = isinstance(status.diff_result, SuspiciousModification)
    if intact and (level_text != "none" or suspicious):
        add("MODIFIED_AFTER_SIGNING")
    if any(r.status == "unknown" for r in revs):
        add("REVOCATION_UNKNOWN")
    untrusted_explained = {"REVOCATION_UNKNOWN", "CERT_EXPIRED_AT_SIGNING"}
    if intact and not status.trusted and not revoked and not untrusted_explained & set(reasons):
        add("CERT_UNTRUSTED")
    if intact and not ts_ok and claimed_dt is not None and signer.not_valid_after_utc <= c.now:
        add("CERT_EXPIRED_NOW")

    strict = c.mode == "hard" or not c.allow_offline
    state = _status_of(reasons, strict_revocation=strict)
    summary_vi, summary_en = _summaries(state, reasons)

    doc_ts_after = any(rev >= int(emb.signed_revision) for rev in c.doc_timestamp_revisions)
    info = cert_info(signer, c.now).model_dump(by_alias=True, mode="json")
    identity = info["identity"]
    signer_name = (
        identity.get("personName")
        or identity.get("organization")
        or signer.subject.rfc4514_string()
    )
    sub_filter = emb.sig_object.get("/SubFilter")
    trusted_path = bool(status.validation_path is not None and status.trusted)
    chain_rows = _chain_rows(chain, trusted_path, anchors_fp)
    return {
        "fieldName": name,
        "status": state,
        "reasons": reasons,
        "summaryVi": summary_vi,
        "summaryEn": summary_en,
        "revisionIndex": int(emb.signed_revision),
        "subFilter": str(sub_filter)[1:] if sub_filter is not None else None,
        "level": _level(has_ts, c.embedded.has_validation_info, doc_ts_after),
        "digestAlgorithm": str(status.md_algorithm),
        "signerName": signer_name,
        "signerCert": info,
        "signingTime": claimed_dt.isoformat() if claimed_dt is not None else None,
        "timestampTime": ts.timestamp.isoformat() if ts is not None else None,
        "timestampOk": ts_ok if has_ts else None,
        "coversWholeDocument": status.coverage == SignatureCoverageLevel.ENTIRE_FILE,
        "modificationLevel": level_text,
        "docMdp": c.docmdp.value if c.docmdp is not None else None,
        "chain": chain_rows,
        "revocation": _rev_rows(revs + ts_revs),
    }


def _unreadable_item(
    name: str,
    signer: x509.Certificate,
    chain: list[x509.Certificate],
    revs: list[_Revocation],
    anchors_fp: set[str],
) -> dict[str, Any]:
    summary_vi, summary_en = _summaries("invalid", ["SIGNATURE_UNREADABLE"])
    return {
        "fieldName": name,
        "status": "invalid",
        "reasons": ["SIGNATURE_UNREADABLE"],
        "summaryVi": summary_vi,
        "summaryEn": summary_en,
        "revisionIndex": None,
        "subFilter": None,
        "level": None,
        "digestAlgorithm": None,
        "signerName": None,
        "signerCert": None,
        "signingTime": None,
        "timestampTime": None,
        "timestampOk": None,
        "coversWholeDocument": None,
        "modificationLevel": None,
        "docMdp": None,
        "chain": _chain_rows(chain, False, anchors_fp),
        "revocation": _rev_rows(revs),
    }


def _unsigned_item(name: str) -> dict[str, Any]:
    summary_vi, summary_en = _summaries("unsigned", ["UNSIGNED_FIELD"])
    return {
        "fieldName": name,
        "status": "unsigned",
        "reasons": ["UNSIGNED_FIELD"],
        "summaryVi": summary_vi,
        "summaryEn": summary_en,
        "revisionIndex": None,
        "subFilter": None,
        "level": None,
        "digestAlgorithm": None,
        "signerName": None,
        "signerCert": None,
        "signingTime": None,
        "timestampTime": None,
        "timestampOk": None,
        "coversWholeDocument": None,
        "modificationLevel": None,
        "docMdp": None,
        "chain": [],
        "revocation": [],
    }


# -- the document -----------------------------------------------------------------------------


def verify_document(
    path: Path,
    options: VerifyOptions,
    fetch: FetchFn | None = None,
    now: dt.datetime | None = None,
) -> dict[str, Any]:
    """Verify every signature of ``path``. Returns ``{"signatures": [...]}``.

    ``fetch`` replaces the network (tests use it to simulate unreachable servers); ``now``
    replaces the clock (tests check a document at a later date). Raises ``ChefError`` only when
    the file cannot be opened or read as a PDF.
    """
    if options.check_revocation not in ("none", "soft", "hard"):
        raise invalid_params("checkRevocation must be none, soft or hard")
    now = now if now is not None else dt.datetime.now(dt.UTC)
    with opened_pdf(path) as pdf:
        fields = list_signature_fields(pdf)
        embedded = _read_dss(pdf)
        mdp = certification_level(pdf)
    extras = options.extra_trust_roots
    anchors = _dedupe(options.trust.anchors() + [c for c in extras if _is_root(c)])
    pool = _dedupe(
        options.trust.intermediates() + [c for c in extras if not _is_root(c)] + embedded.certs
    )
    ctx_fetch = _memoized(fetch or http_fetch)
    try:
        with path.open("rb") as handle:
            reader = PdfFileReader(handle)
            signatures = list(reader.embedded_regular_signatures)
            doc_timestamps = [int(t.signed_revision) for t in reader.embedded_timestamp_signatures]
            c = _Context(
                anchors=anchors,
                pool=pool,
                embedded=embedded,
                mode=options.check_revocation,
                fetch=ctx_fetch,
                timeout=float(options.timeout_seconds),
                now=now,
                doc_timestamp_revisions=doc_timestamps,
                docmdp=mdp,
                allow_offline=options.allow_offline,
            )
            items = [_examine(emb, c) for emb in signatures]
    except ChefError:
        raise
    except Exception as exc:
        raise ChefError(ErrorKind.INVALID_PDF, f"Not a readable signed PDF: {exc}") from exc
    items += [_unsigned_item(f.name) for f in fields if not f.signed]
    return {"signatures": items}


# -- signed revision (I35) --------------------------------------------------------------------


def extract_revision(source: Path, field_name: str, dest: Path) -> Path:
    """Write the bytes that signature ``field_name`` covers to ``dest`` and return ``dest``.

    The output is the source cut at the end of the signature's ByteRange: the revision as it was
    when that signature was applied. Later updates are left out.
    """
    if not source.is_file():
        raise ChefError(ErrorKind.FILE_NOT_FOUND, "File not found", {"path": str(source)})
    if dest.resolve() == source.resolve():
        raise invalid_params("outputPath must differ from the source file", {"field": "outputPath"})
    try:
        with source.open("rb") as handle:
            reader = PdfFileReader(handle)
            match = [
                e for e in reader.embedded_regular_signatures if str(e.field_name) == field_name
            ]
            if not match:
                raise invalid_params(f"No signed field named {field_name}", {"field": "fieldName"})
            byte_range = [int(v) for v in match[0].byte_range]
    except ChefError:
        raise
    except Exception as exc:
        raise ChefError(ErrorKind.INVALID_PDF, f"Not a readable signed PDF: {exc}") from exc
    end = byte_range[2] + byte_range[3]
    data = source.read_bytes()[:end]
    try:
        with pikepdf.open(io.BytesIO(data)) as pdf:
            _ = len(pdf.pages)
    except pikepdf.PdfError as exc:
        raise ChefError(ErrorKind.INVALID_PDF, f"Signed revision does not open: {exc}") from exc

    def write(tmp: Path) -> None:
        tmp.write_bytes(data)

    atomic_write(dest, write)
    return dest
