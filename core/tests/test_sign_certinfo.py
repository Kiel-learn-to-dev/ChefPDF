"""T3.05: certificate information and Vietnamese identifiers (MST, CCCD/CMND/MNS)."""

from __future__ import annotations

import datetime as dt
import unicodedata
from typing import Any

import pytest
from conftest import Harness, RpcFailure
from cryptography import x509
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID, ObjectIdentifier

from chef_core.signing.certinfo import cert_info, describe_identity

UID = ObjectIdentifier("0.9.2342.19200300.100.1.1")
ORG_ID = ObjectIdentifier("2.5.4.97")
NOW = dt.datetime.now(dt.UTC).replace(microsecond=0)


def _self_signed(attrs: list[tuple[ObjectIdentifier, str]]) -> x509.Certificate:
    """A quick EC self-signed certificate with the given subject attributes (one per RDN)."""
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.RelativeDistinguishedName([x509.NameAttribute(o, v)]) for o, v in attrs])
    return (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(NOW - dt.timedelta(days=1))
        .not_valid_after(NOW + dt.timedelta(days=365))
        .sign(key, hashes.SHA256())
    )


# -- identifiers: every spelling we know ----------------------------------------------------


@pytest.mark.parametrize(
    ("attrs", "tax", "citizen", "budget"),
    [
        # UID carrying MST / CCCD / CMND with ":" and "=" separators (Viettel, VNPT style)
        ([(UID, "MST:0101234567")], "0101234567", None, None),
        ([(UID, "MST=0101234567")], "0101234567", None, None),
        ([(UID, "CCCD:001234567890")], None, "001234567890", None),
        ([(UID, "CMND:012345678")], None, "012345678", None),
        # branch suffix on the tax code is kept
        ([(UID, "MST:0101234567-001")], "0101234567-001", None, None),
        # ETSI EN 319 412 organizationIdentifier: VATVN-/TINVN- (tax), PNOVN- (person)
        ([(ORG_ID, "VATVN-0101234567")], "0101234567", None, None),
        ([(ORG_ID, "TINVN-0101234567")], "0101234567", None, None),
        ([(NameOID.SERIAL_NUMBER, "PNOVN-001234567890")], None, "001234567890", None),
        # identifier written inside OU, CN or serialNumber
        ([(NameOID.ORGANIZATIONAL_UNIT_NAME, "MST:0101234567")], "0101234567", None, None),
        ([(NameOID.COMMON_NAME, "Nguyen Van A (CCCD: 001234567890)")], None, "001234567890", None),
        ([(NameOID.ORGANIZATIONAL_UNIT_NAME, "MNS:1234567")], None, None, "1234567"),
        ([(NameOID.ORGANIZATIONAL_UNIT_NAME, "MNS-7654321")], None, None, "7654321"),
        # Vietnamese label for the tax code, in decomposed (NFD) Unicode
        (
            [
                (
                    NameOID.ORGANIZATIONAL_UNIT_NAME,
                    unicodedata.normalize("NFD", "Mã số thuế: 0101234567"),
                )
            ],
            "0101234567",
            None,
            None,
        ),
    ],
)
def test_identifier_spellings(
    attrs: list[tuple[ObjectIdentifier, str]],
    tax: str | None,
    citizen: str | None,
    budget: str | None,
) -> None:
    identity = describe_identity(_self_signed(attrs))
    assert identity.tax_code == tax
    assert identity.citizen_id == citizen
    assert identity.budget_code == budget


def test_person_name_drops_identifier_text() -> None:
    cert = _self_signed(
        [
            (NameOID.COUNTRY_NAME, "VN"),
            (NameOID.ORGANIZATION_NAME, "Công ty TNHH Thử Nghiệm"),
            (NameOID.COMMON_NAME, "Nguyễn Văn A (CCCD: 001234567890)"),
        ]
    )
    identity = describe_identity(cert)
    assert identity.person_name == "Nguyễn Văn A"
    assert identity.citizen_id == "001234567890"
    assert identity.organization == "Công ty TNHH Thử Nghiệm"


def test_no_identifiers_gives_nothing() -> None:
    identity = describe_identity(_self_signed([(NameOID.COMMON_NAME, "Chung chi thu")]))
    assert identity.tax_code is None
    assert identity.citizen_id is None
    assert identity.budget_code is None
    assert identity.organization is None
    assert identity.person_name == "Chung chi thu"


# -- certificate facts ----------------------------------------------------------------------


def test_info_for_signer_a(pki: Any) -> None:
    info = cert_info(pki.signer_a.cert)
    assert info.subject_common_name == "Nguyễn Văn A"
    assert info.issuer_common_name == "Chef Test CA SHA-256"
    assert "CN=Nguyễn Văn A" in info.subject
    assert info.serial == format(pki.signer_a.cert.serial_number, "X")
    assert info.key_algorithm == "RSA"
    assert info.key_size == 2048
    assert "digitalSignature" in info.key_usage
    assert "nonRepudiation" in info.key_usage
    assert info.expired is False
    assert info.expiring_soon is False
    assert 360 <= info.days_until_expiry <= 365
    fingerprint = info.fingerprint_sha256.split(":")
    assert len(fingerprint) == 32
    assert info.fingerprint_sha256 == ":".join(
        f"{b:02X}" for b in pki.signer_a.cert.fingerprint(hashes.SHA256())
    )
    assert info.identity.tax_code == "0101234567"
    assert info.identity.citizen_id == "001234567890"
    assert info.identity.organization == "Công ty TNHH Thử Nghiệm"
    assert info.identity.person_name == "Nguyễn Văn A"


def test_info_for_company_certificate(pki: Any) -> None:
    identity = describe_identity(pki.signer_b.cert)
    assert identity.organization == "Công ty Cổ phần Ví Dụ"
    assert identity.tax_code == "0309876543"
    assert identity.citizen_id == "079123456789"
    assert identity.person_name == "Trần Thị B"


def test_expiring_soon_flag(pki: Any) -> None:
    info = cert_info(pki.expiring.cert)
    assert info.expiring_soon is True
    assert info.expired is False
    assert 0 < info.days_until_expiry < 30


def test_expired_flag(pki: Any) -> None:
    info = cert_info(pki.expired.cert)
    assert info.expired is True
    assert info.expiring_soon is False
    assert info.days_until_expiry < 0


def test_ec_key_reports_curve_size() -> None:
    info = cert_info(_self_signed([(NameOID.COMMON_NAME, "EC signer")]))
    assert info.key_algorithm == "EC"
    assert info.key_size == 256


# -- operation sign.certInfo ------------------------------------------------------------------


def test_op_returns_cert_info_and_expiry_warning(harness: Harness, pki: Any) -> None:
    result = harness.op(
        "sign.certInfo",
        {"pfxPath": str(pki.pfx_expiring()), "password": "expiring-2026"},
    )
    assert result["state"] is None
    data = result["data"]
    assert data["expiringSoon"] is True
    assert data["subjectCommonName"] == "Hết Hạn Sớm"
    assert data["identity"]["citizenId"] == "012345678"
    assert any("expires" in w.lower() for w in result["warnings"])


def test_op_without_expiry_has_no_warning(harness: Harness, pki: Any) -> None:
    result = harness.op(
        "sign.certInfo",
        {"pfxPath": str(pki.pfx_a()), "password": "Mật-khẩu-A-2026"},
    )
    assert result["data"]["expiringSoon"] is False
    assert result["warnings"] == []


def test_op_wrong_password(harness: Harness, pki: Any) -> None:
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.certInfo", {"pfxPath": str(pki.pfx_a()), "password": "sai"})
    assert exc.value.kind == "SIGN_BAD_PASSWORD"
