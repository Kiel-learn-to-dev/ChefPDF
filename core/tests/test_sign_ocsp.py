"""OCSP revocation checks in signature verification (I34): AIA + POST against a loopback responder.

The test PKI serves CRLs for most leaves; the ``ocsp_*`` leaves have no CRL distribution point,
so OCSP is the only way their revocation can be answered. The responder is signed by the test
intermediate CA. Forged and stale responses are served to check that verify.py refuses them.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from conftest import Harness, make_numbered_pdf
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509 import ocsp
from cryptography.x509.oid import NameOID
from signing_support import NOW

from chef_core.signing.trust import TrustStore, fingerprint_of
from chef_core.signing.verify import VerifyOptions, verify_document

PWD_GOOD = "ocsp-good-2026"
PWD_REVOKED = "ocsp-revoked-2026"
PWD_UNKNOWN = "ocsp-unknown-2026"
PWD_DEAD = "ocsp-dead-2026"
PWD_SHORT = "short-2026"


@pytest.fixture
def responder(sign_services: Any) -> Iterator[Any]:
    """The loopback services with the OCSP handler restored after each test."""
    original = sign_services.ocsp_handler
    yield sign_services
    sign_services.ocsp_handler = original


def _open(harness: Harness, tmp_path: Path, name: str) -> str:
    sample = make_numbered_pdf(tmp_path / f"{name}-src.pdf", 1)
    return str(harness.open(sample)["state"]["sessionId"])


def _signed_with(
    harness: Harness, pki: Any, tmp_path: Path, name: str, identity: Any, password: str
) -> Path:
    """A one-page document signed (B-B) with ``identity``; the PFX has the full chain."""
    pfx = pki.pfx(name, identity, password, [pki.inter.cert, pki.root.cert])
    sid = _open(harness, tmp_path, name)
    harness.op("sign.pades", {"pfxPath": str(pfx), "password": password}, sid)
    dest = tmp_path / f"{name}.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(dest)})
    return dest


def _verify(harness: Harness, pki: Any, path: Path, **params: Any) -> dict[str, Any]:
    body = {"path": str(path), "trustRootPaths": [str(pki.root_pem)], **params}
    data: dict[str, Any] = harness.op("sign.verifyFile", body)["data"]
    [sig] = data["signatures"]
    return dict(sig)


def _ocsp_row(sig: dict[str, Any], pki: Any) -> dict[str, Any]:
    fingerprint = fingerprint_of(pki.ocsp_good.cert)
    rows = [r for r in sig["revocation"] if r["fingerprintSha256"] == fingerprint]
    assert rows, sig["revocation"]
    return dict(rows[0])


def _self_signed(key: rsa.RSAPrivateKey) -> x509.Certificate:
    """The attacker's own certificate: a responder id that matches the key that signs."""
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Kẻ giả mạo")])
    return (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(NOW - dt.timedelta(days=1))
        .not_valid_after(NOW + dt.timedelta(days=1))
        .sign(key, hashes.SHA256())
    )


def _response(
    *,
    cert: x509.Certificate,
    issuer: x509.Certificate,
    key: rsa.RSAPrivateKey,
    status: ocsp.OCSPCertStatus,
    this_update: dt.datetime,
    next_update: dt.datetime,
    responder_cert: x509.Certificate,
) -> bytes:
    response = (
        ocsp.OCSPResponseBuilder()
        .add_response(
            cert=cert,
            issuer=issuer,
            algorithm=hashes.SHA1(),
            cert_status=status,
            this_update=this_update,
            next_update=next_update,
            revocation_time=this_update if status == ocsp.OCSPCertStatus.REVOKED else None,
            revocation_reason=None,
        )
        .responder_id(ocsp.OCSPResponderEncoding.HASH, responder_cert)
        .sign(key, hashes.SHA256())
    )
    return response.public_bytes(serialization.Encoding.DER)


def test_good_certificate_is_confirmed_by_ocsp(
    harness: Harness, pki: Any, responder: Any, tmp_path: Path
) -> None:
    signed = _signed_with(harness, pki, tmp_path, "ocsp-good", pki.ocsp_good, PWD_GOOD)
    before = responder.hits["ocsp"]
    sig = _verify(harness, pki, signed)
    assert responder.hits["ocsp"] > before, "the OCSP responder was never asked"
    assert sig["status"] == "valid", sig["reasons"]
    assert sig["reasons"] == []
    row = _ocsp_row(sig, pki)
    assert row["source"] == "ocsp"
    assert row["status"] == "good"


def test_revoked_certificate_is_invalid_by_ocsp(
    harness: Harness, pki: Any, responder: Any, tmp_path: Path
) -> None:
    signed = _signed_with(harness, pki, tmp_path, "ocsp-revoked", pki.ocsp_revoked, PWD_REVOKED)
    sig = _verify(harness, pki, signed)
    assert sig["status"] == "invalid"
    assert "CERT_REVOKED" in sig["reasons"]


@pytest.mark.parametrize("mode", ["soft", "hard"])
def test_unknown_answer_is_a_warning_in_soft_and_unknown_in_hard(
    harness: Harness, pki: Any, responder: Any, tmp_path: Path, mode: str
) -> None:
    signed = _signed_with(harness, pki, tmp_path, "ocsp-unknown", pki.ocsp_unknown, PWD_UNKNOWN)
    sig = _verify(harness, pki, signed, checkRevocation=mode)
    assert "REVOCATION_UNKNOWN" in sig["reasons"]
    expected = "valid-with-warnings" if mode == "soft" else "unknown"
    assert sig["status"] == expected


@pytest.mark.parametrize(
    ("mode", "expected"), [("soft", "valid-with-warnings"), ("hard", "unknown")]
)
def test_unreachable_responder_follows_the_mode(
    harness: Harness, pki: Any, responder: Any, tmp_path: Path, mode: str, expected: str
) -> None:
    signed = _signed_with(harness, pki, tmp_path, "ocsp-dead", pki.ocsp_dead, PWD_DEAD)
    sig = _verify(harness, pki, signed, checkRevocation=mode)
    assert sig["status"] == expected
    assert "REVOCATION_UNKNOWN" in sig["reasons"]
    assert sig["status"] != "invalid"


def test_allow_offline_false_behaves_like_hard_mode(
    harness: Harness, pki: Any, responder: Any, tmp_path: Path
) -> None:
    signed = _signed_with(harness, pki, tmp_path, "ocsp-dead2", pki.ocsp_dead, PWD_DEAD)
    sig = _verify(harness, pki, signed, allowOffline=False)
    assert sig["status"] == "unknown"


def test_forged_good_answer_for_a_revoked_certificate_is_ignored(
    harness: Harness, pki: Any, responder: Any, tmp_path: Path
) -> None:
    """The responder URL answers "good", but the answer is not signed by the issuer."""
    signed = _signed_with(harness, pki, tmp_path, "ocsp-forged", pki.ocsp_revoked, PWD_REVOKED)
    attacker = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    forged = _response(
        cert=pki.ocsp_revoked.cert,
        issuer=pki.inter.cert,
        key=attacker,
        status=ocsp.OCSPCertStatus.GOOD,
        this_update=NOW - dt.timedelta(hours=1),
        next_update=NOW + dt.timedelta(days=1),
        responder_cert=_self_signed(attacker),
    )
    responder.ocsp_handler = lambda _body: forged
    sig = _verify(harness, pki, signed)
    assert "CERT_REVOKED" not in sig["reasons"]
    assert sig["status"] != "valid"
    assert "REVOCATION_UNKNOWN" in sig["reasons"]


def test_forged_revoked_answer_for_a_good_certificate_is_ignored(
    harness: Harness, pki: Any, responder: Any, tmp_path: Path
) -> None:
    signed = _signed_with(harness, pki, tmp_path, "ocsp-spoof", pki.ocsp_good, PWD_GOOD)
    attacker = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    forged = _response(
        cert=pki.ocsp_good.cert,
        issuer=pki.inter.cert,
        key=attacker,
        status=ocsp.OCSPCertStatus.REVOKED,
        this_update=NOW - dt.timedelta(hours=1),
        next_update=NOW + dt.timedelta(days=1),
        responder_cert=_self_signed(attacker),
    )
    responder.ocsp_handler = lambda _body: forged
    sig = _verify(harness, pki, signed)
    assert "CERT_REVOKED" not in sig["reasons"]
    assert sig["status"] != "invalid"


def test_stale_signed_answer_is_not_accepted(
    harness: Harness, pki: Any, responder: Any, tmp_path: Path
) -> None:
    """A correctly signed "good" answer whose nextUpdate has passed proves nothing now."""
    signed = _signed_with(harness, pki, tmp_path, "ocsp-stale", pki.ocsp_good, PWD_GOOD)
    stale = _response(
        cert=pki.ocsp_good.cert,
        issuer=pki.inter.cert,
        key=pki.inter.key,
        status=ocsp.OCSPCertStatus.GOOD,
        this_update=NOW - dt.timedelta(days=10),
        next_update=NOW - dt.timedelta(days=3),
        responder_cert=pki.inter.cert,
    )
    responder.ocsp_handler = lambda _body: stale
    sig = _verify(harness, pki, signed)
    assert "REVOCATION_UNKNOWN" in sig["reasons"]
    assert sig["status"] == "valid-with-warnings"


def test_certificate_expired_now_without_timestamp_is_a_warning(
    harness: Harness, pki: Any, responder: Any, tmp_path: Path
) -> None:
    """Signed while valid, checked after its notAfter, with no timestamp: CERT_EXPIRED_NOW."""
    pfx = pki.pfx("short", pki.short, PWD_SHORT, [pki.inter.cert, pki.root.cert])
    sid = _open(harness, tmp_path, "short")
    harness.op("sign.pades", {"pfxPath": str(pfx), "password": PWD_SHORT}, sid)
    signed = tmp_path / "short.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(signed)})

    options = VerifyOptions(
        trust=TrustStore(user_dir=None),
        extra_trust_roots=[pki.root.cert],
        check_revocation="soft",
        allow_offline=True,
        timeout_seconds=5,
    )
    later = NOW + dt.timedelta(days=3)
    [sig] = verify_document(signed, options, now=later)["signatures"]
    assert "CERT_EXPIRED_NOW" in sig["reasons"]
    assert sig["status"] == "valid-with-warnings"

    [today] = verify_document(signed, options)["signatures"]
    assert "CERT_EXPIRED_NOW" not in today["reasons"]
