"""Certificate facts and Vietnamese identifiers (feature I3).

Vietnamese CAs write the tax code (MST) and the citizen or budget identifiers in several places:
the UID attribute (``UID=MST:0101234567``), inside CN/OU, in ``serialNumber``, or in
``organizationIdentifier`` following ETSI EN 319 412 (``VATVN-…``, ``TINVN-…``, ``PNOVN-…``).
Every subject attribute is scanned; the first match of each kind wins.
"""

from __future__ import annotations

import datetime as dt
import math
import re
import unicodedata

from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import dsa, ec, ed448, ed25519, rsa
from cryptography.x509.oid import NameOID

from chef_core.models import WireModel

EXPIRY_WARNING_DAYS = 30

# Prefixes are matched case-insensitively after NFC normalisation, so decomposed Vietnamese
# text (common in certificates) matches as well. The value is the run of letters, digits and
# hyphens after the separator (":", "=" or "-").
_TAX_RE = re.compile(
    r"(?<![A-Za-z])(?:MST|MÃ\s+SỐ\s+THUẾ|VATVN|TINVN)\s*[:=\-]\s*([0-9A-Za-z][0-9A-Za-z\-]*)",
    re.IGNORECASE,
)
_CITIZEN_RE = re.compile(
    r"(?<![A-Za-z])(?:CCCD|CMND|PNOVN)\s*[:=\-]\s*([0-9A-Za-z][0-9A-Za-z\-]*)",
    re.IGNORECASE,
)
_BUDGET_RE = re.compile(
    r"(?<![A-Za-z])MNS\s*[:=\-]\s*([0-9A-Za-z][0-9A-Za-z\-]*)",
    re.IGNORECASE,
)
# The whole identifier fragment, removed from display names.
_FRAGMENT_RE = re.compile(
    r"\(?\s*(?:(?<![A-Za-z])(?:MST|MÃ\s+SỐ\s+THUẾ|VATVN|TINVN|CCCD|CMND|PNOVN|MNS)"
    r"\s*[:=\-]\s*[0-9A-Za-z][0-9A-Za-z\-]*)\s*\)?",
    re.IGNORECASE,
)

_KEY_USAGE_NAMES = (
    "digitalSignature",
    "nonRepudiation",
    "keyEncipherment",
    "dataEncipherment",
    "keyAgreement",
    "keyCertSign",
    "cRLSign",
    "encipherOnly",
    "decipherOnly",
)


class IdentityInfo(WireModel):
    """Identifiers and names read from a certificate subject. Missing values are null."""

    tax_code: str | None = None
    citizen_id: str | None = None
    budget_code: str | None = None
    organization: str | None = None
    person_name: str | None = None


class CertInfo(WireModel):
    """What the UI shows about a signing certificate (``sign.certInfo``)."""

    subject_common_name: str | None
    issuer_common_name: str | None
    subject: str
    issuer: str
    serial: str
    not_before: str
    not_after: str
    days_until_expiry: int
    expired: bool
    expiring_soon: bool
    key_usage: list[str]
    key_algorithm: str
    key_size: int | None
    fingerprint_sha256: str
    identity: IdentityInfo


def _text(value: object) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _nfc(value: str) -> str:
    return unicodedata.normalize("NFC", value)


def _attribute_values(cert: x509.Certificate) -> list[str]:
    return [_nfc(_text(attr.value).strip()) for attr in cert.subject]


def _first(pattern: re.Pattern[str], values: list[str]) -> str | None:
    for value in values:
        match = pattern.search(value)
        if match:
            return match.group(1)
    return None


def _named(cert: x509.Certificate, oid: x509.ObjectIdentifier) -> str | None:
    attrs = cert.subject.get_attributes_for_oid(oid)
    if not attrs:
        return None
    return _nfc(_text(attrs[0].value).strip()) or None


def _without_identifiers(value: str) -> str:
    cleaned = _FRAGMENT_RE.sub(" ", value)
    return re.sub(r"\s+", " ", cleaned).strip(" -,;")


def describe_identity(cert: x509.Certificate) -> IdentityInfo:
    """Read MST / CCCD / CMND / MNS and the names from the subject of ``cert``.

    ``organization`` is the O attribute. ``personName`` is the CN without identifier text; it is
    only given for people (a citizen identifier is present, or there is no organization).
    """
    values = _attribute_values(cert)
    tax = _first(_TAX_RE, values)
    citizen = _first(_CITIZEN_RE, values)
    budget = _first(_BUDGET_RE, values)

    organization = _named(cert, NameOID.ORGANIZATION_NAME)
    common_name = _named(cert, NameOID.COMMON_NAME)
    person: str | None = None
    if common_name is not None and (citizen is not None or organization is None):
        person = _without_identifiers(common_name) or None

    return IdentityInfo(
        tax_code=tax,
        citizen_id=citizen,
        budget_code=budget,
        organization=organization,
        person_name=person,
    )


def _key_facts(cert: x509.Certificate) -> tuple[str, int | None]:
    key = cert.public_key()
    if isinstance(key, rsa.RSAPublicKey):
        return "RSA", key.key_size
    if isinstance(key, ec.EllipticCurvePublicKey):
        return "EC", key.curve.key_size
    if isinstance(key, dsa.DSAPublicKey):
        return "DSA", key.key_size
    if isinstance(key, ed25519.Ed25519PublicKey):
        return "Ed25519", 256
    if isinstance(key, ed448.Ed448PublicKey):
        return "Ed448", 448
    return type(key).__name__, None


def _key_usage(cert: x509.Certificate) -> list[str]:
    try:
        usage = cert.extensions.get_extension_for_class(x509.KeyUsage).value
    except x509.ExtensionNotFound:
        return []
    assert isinstance(usage, x509.KeyUsage)
    flags = {
        "digitalSignature": usage.digital_signature,
        "nonRepudiation": usage.content_commitment,
        "keyEncipherment": usage.key_encipherment,
        "dataEncipherment": usage.data_encipherment,
        "keyAgreement": usage.key_agreement,
        "keyCertSign": usage.key_cert_sign,
        "cRLSign": usage.crl_sign,
    }
    if usage.key_agreement:  # the two only exist when keyAgreement is set
        flags["encipherOnly"] = usage.encipher_only
        flags["decipherOnly"] = usage.decipher_only
    return [name for name in _KEY_USAGE_NAMES if flags.get(name)]


def _issuer_common_name(cert: x509.Certificate) -> str | None:
    attrs = cert.issuer.get_attributes_for_oid(NameOID.COMMON_NAME)
    return _nfc(_text(attrs[0].value)) if attrs else None


def cert_info(cert: x509.Certificate, now: dt.datetime | None = None) -> CertInfo:
    """Facts about ``cert`` as shown in the UI. ``now`` is injectable for tests."""
    current = now or dt.datetime.now(dt.UTC)
    not_after = cert.not_valid_after_utc
    not_before = cert.not_valid_before_utc
    days = math.floor((not_after - current).total_seconds() / 86400)
    expired = not_after <= current
    key_algorithm, key_size = _key_facts(cert)
    fingerprint = cert.fingerprint(hashes.SHA256()).hex().upper()
    return CertInfo(
        subject_common_name=_named(cert, NameOID.COMMON_NAME),
        issuer_common_name=_issuer_common_name(cert),
        subject=cert.subject.rfc4514_string(),
        issuer=cert.issuer.rfc4514_string(),
        serial=format(cert.serial_number, "X"),
        not_before=not_before.isoformat(),
        not_after=not_after.isoformat(),
        days_until_expiry=days,
        expired=expired,
        expiring_soon=not expired and days < EXPIRY_WARNING_DAYS,
        key_usage=_key_usage(cert),
        key_algorithm=key_algorithm,
        key_size=key_size,
        fingerprint_sha256=":".join(fingerprint[i : i + 2] for i in range(0, len(fingerprint), 2)),
        identity=describe_identity(cert),
    )
