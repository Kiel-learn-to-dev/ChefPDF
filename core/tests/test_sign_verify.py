"""T3.08 (core): signature verification (I34), trust store (I35) and the signed-revision view (I35).

Documents are signed through the real ``sign.pades`` op and checked by ``sign.verify`` (session),
``sign.verifyFile`` (standalone) and ``sign.extractRevision``. Revocation and the timestamp server
run on the loopback services from signing_support, so nothing reaches the internet. Tampered and
appended files are produced by byte-level edits, which is how a real change looks to a reader.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Any

import pikepdf
import pytest
from conftest import Harness, RpcFailure
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from pyhanko.pdf_utils import generic
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.sign.timestamps.dummy_client import DummyTimeStamper
from signing_support import NOW, validate_pdf_signatures

from chef_core.errors import ChefError
from chef_core.signing.trust import BUNDLED_CERTS_DIR, TrustStore
from chef_core.signing.verify import VerifyOptions, extract_revision, verify_document

PASSWORD_A = "Mật-khẩu-A-2026"
PASSWORD_B = "second-pass-B-2026"
PASSWORD_EXPIRING = "expiring-2026"
PASSWORD_REVOKED = "revoked-2026"


# -- fixtures and helpers -------------------------------------------------------------------


@pytest.fixture
def services(sign_services: Any) -> Any:
    return sign_services


def make_text_pdf(path: Path, pages: int = 1) -> Path:
    """Uncompressed content streams, so byte-level edits in the file are possible."""
    pdf = pikepdf.new()
    for _ in range(pages):
        page = pdf.add_blank_page(page_size=(300, 400))
        page.Contents = pdf.make_stream(b"BT /F1 12 Tf 20 20 Td (Hello) Tj ET")
    pdf.save(path, compress_streams=False, object_stream_mode=pikepdf.ObjectStreamMode.disable)
    return path


def annotation_update(src: Path, dest: Path) -> None:
    """Add a note annotation to the first page, appended after the signature."""
    with src.open("rb") as fh:
        writer = IncrementalPdfFileWriter(fh)
        page = writer.root["/Pages"].get_object()["/Kids"][0].get_object()
        annot = generic.DictionaryObject(
            {
                generic.NameObject("/Type"): generic.NameObject("/Annot"),
                generic.NameObject("/Subtype"): generic.NameObject("/Text"),
                generic.NameObject("/Rect"): generic.ArrayObject(
                    [generic.NumberObject(v) for v in (10, 10, 40, 40)]
                ),
                generic.NameObject("/Contents"): generic.TextStringObject("Ghi chú"),
            }
        )
        page[generic.NameObject("/Annots")] = generic.ArrayObject([writer.add_object(annot)])
        writer.update_container(page)
        with dest.open("wb") as out:
            writer.write(out)


def write_cert(path: Path, cert: x509.Certificate, encoding: serialization.Encoding) -> Path:
    path.write_bytes(cert.public_bytes(encoding))
    return path


def _a(pki: Any) -> dict[str, Any]:
    return {"pfxPath": str(pki.pfx_a()), "password": PASSWORD_A}


def _b(pki: Any) -> dict[str, Any]:
    return {"pfxPath": str(pki.pfx_b()), "password": PASSWORD_B}


def _tsa(services: Any) -> str:
    return f"{services.base_url}/tsa"


def _root(pki: Any) -> list[str]:
    return [str(pki.root_pem)]


def _open(harness: Harness, path: Path) -> str:
    return str(harness.open(path)["state"]["sessionId"])


def _save(harness: Harness, sid: str, dest: Path) -> Path:
    harness.call("session.save", {"sessionId": sid, "path": str(dest)})
    return dest


def signed_copy(harness: Harness, tmp_path: Path, name: str, signs: list[dict[str, Any]]) -> Path:
    """A sample document with each ``sign.pades`` params applied in order, saved to a file."""
    sid = _open(harness, make_text_pdf(tmp_path / f"{name}-src.pdf"))
    for params in signs:
        harness.op("sign.pades", params, sid)
    return _save(harness, sid, tmp_path / f"{name}.pdf")


def verify_file(harness: Harness, path: Path, **params: Any) -> dict[str, Any]:
    data: dict[str, Any] = harness.op("sign.verifyFile", {"path": str(path), **params})["data"]
    return data


def no_network(url: str, timeout: float, body: bytes | None = None) -> bytes:
    raise OSError(f"network disabled in this test: {url}")


def verify_offline(
    path: Path, pki: Any, mode: str, allow_offline: bool, tmp_path: Path
) -> dict[str, Any]:
    """Core verification with every network fetch failing (revocation servers unreachable)."""
    report = verify_document(
        path,
        VerifyOptions(
            trust=TrustStore(user_dir=None, bundled_dir=tmp_path / "no-bundle"),
            extra_trust_roots=[pki.root.cert],
            check_revocation=mode,  # type: ignore[arg-type]
            allow_offline=allow_offline,
            timeout_seconds=2,
        ),
        fetch=no_network,
    )
    [sig] = report["signatures"]
    return dict(sig)


# -- trust store (I35) ----------------------------------------------------------------------


def test_bundled_directory_ships_a_readme_and_no_certificates() -> None:
    """Honest state: no real Vietnamese root is bundled yet (the owner drops them in)."""
    assert (BUNDLED_CERTS_DIR / "README.md").is_file()
    suffixes = {".pem", ".crt", ".cer", ".der"}
    assert [p for p in BUNDLED_CERTS_DIR.iterdir() if p.suffix.lower() in suffixes] == []


def test_add_pem_and_der_of_one_certificate_is_stored_once(pki: Any, tmp_path: Path) -> None:
    store = TrustStore(user_dir=tmp_path / "user", bundled_dir=tmp_path / "bundled")
    der = write_cert(tmp_path / "root.der", pki.root.cert, serialization.Encoding.DER)
    [first] = store.add(pki.root_pem)
    [second] = store.add(der)
    assert first["fingerprintSha256"] == second["fingerprintSha256"]
    [entry] = store.list()
    assert entry["source"] == "user"
    assert entry["group"] == "user"
    assert entry["subject"] == pki.root.cert.subject.rfc4514_string()
    assert entry["issuer"] == pki.root.cert.issuer.rfc4514_string()
    assert entry["notAfter"] == pki.root.cert.not_valid_after_utc.isoformat()
    assert len(entry["fingerprintSha256"].replace(":", "")) == 64


def test_user_store_survives_a_new_instance(pki: Any, tmp_path: Path) -> None:
    TrustStore(user_dir=tmp_path / "user", bundled_dir=tmp_path / "bundled").add(pki.root_pem)
    again = TrustStore(user_dir=tmp_path / "user", bundled_dir=tmp_path / "bundled")
    assert [e["subject"] for e in again.list()] == [pki.root.cert.subject.rfc4514_string()]


def test_remove_touches_only_user_entries(pki: Any, tmp_path: Path) -> None:
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    write_cert(bundled / "vn-gov-ca.root.pem", pki.root.cert, serialization.Encoding.PEM)
    store = TrustStore(user_dir=tmp_path / "user", bundled_dir=bundled)
    [entry] = store.add(
        write_cert(tmp_path / "inter.pem", pki.inter.cert, serialization.Encoding.PEM)
    )
    assert store.remove(entry["fingerprintSha256"]) is True
    assert store.remove(entry["fingerprintSha256"]) is False
    [left] = store.list()
    assert left["source"] == "bundled"
    with pytest.raises(ChefError) as exc:
        store.remove(left["fingerprintSha256"])
    assert exc.value.kind.value == "INVALID_PARAMS"


def test_bundled_group_comes_from_the_filename_prefix(pki: Any, tmp_path: Path) -> None:
    bundled = tmp_path / "bundled"
    bundled.mkdir()
    write_cert(bundled / "vn-public-ca.neac-root.pem", pki.root.cert, serialization.Encoding.PEM)
    [entry] = TrustStore(user_dir=None, bundled_dir=bundled).list()
    assert entry["source"] == "bundled"
    assert entry["group"] == "vn-public-ca"


def test_add_with_a_group_stores_it_in_the_file_name(pki: Any, tmp_path: Path) -> None:
    store = TrustStore(user_dir=tmp_path / "user", bundled_dir=tmp_path / "bundled")
    [entry] = store.add(pki.root_pem, group="vn-gov-ca")
    assert entry["group"] == "vn-gov-ca"
    assert [p.name.startswith("vn-gov-ca.") for p in (tmp_path / "user").iterdir()] == [True]


def test_add_rejects_a_group_outside_the_convention(pki: Any, tmp_path: Path) -> None:
    store = TrustStore(user_dir=tmp_path / "user", bundled_dir=tmp_path / "bundled")
    with pytest.raises(ChefError) as exc:
        store.add(pki.root_pem, group="../evil")
    assert exc.value.kind.value == "INVALID_PARAMS"


def test_add_rejects_non_certificates_and_missing_files(tmp_path: Path) -> None:
    store = TrustStore(user_dir=tmp_path / "user", bundled_dir=tmp_path / "bundled")
    garbage = tmp_path / "garbage.pem"
    garbage.write_bytes(b"not a certificate")
    with pytest.raises(ChefError) as bad:
        store.add(garbage)
    assert bad.value.kind.value == "SIGN_BAD_CERT"
    with pytest.raises(ChefError) as missing:
        store.add(tmp_path / "absent.pem")
    assert missing.value.kind.value == "FILE_NOT_FOUND"


def test_anchors_and_intermediates_are_separated(pki: Any, tmp_path: Path) -> None:
    store = TrustStore(user_dir=tmp_path / "user", bundled_dir=tmp_path / "bundled")
    store.add(pki.root_pem)
    store.add(write_cert(tmp_path / "inter.pem", pki.inter.cert, serialization.Encoding.PEM))
    assert [c.subject.rfc4514_string() for c in store.anchors()] == [
        pki.root.cert.subject.rfc4514_string()
    ]
    assert [c.subject.rfc4514_string() for c in store.intermediates()] == [
        pki.inter.cert.subject.rfc4514_string()
    ]


def test_a_missing_store_directory_is_just_empty(tmp_path: Path) -> None:
    store = TrustStore(user_dir=tmp_path / "never-made", bundled_dir=tmp_path / "also-missing")
    assert store.list() == []
    assert store.anchors() == []


# -- verification: basic states -------------------------------------------------------------


def test_b_b_signature_is_valid_with_full_details(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    signed = signed_copy(harness, tmp_path, "bb", [_a(pki)])
    [sig] = verify_file(harness, signed, trustRootPaths=_root(pki))["signatures"]
    assert sig["fieldName"] == "Signature1"
    assert sig["status"] == "valid"
    assert sig["reasons"] == []
    assert sig["level"] == "B-B"
    assert sig["signerName"] == "Nguyễn Văn A"
    assert sig["signerCert"]["identity"]["taxCode"] == "0101234567"
    assert sig["signerCert"]["identity"]["citizenId"] == "001234567890"
    assert sig["signingTime"] is not None
    assert sig["timestampTime"] is None and sig["timestampOk"] is None
    assert sig["digestAlgorithm"] == "sha256"
    assert sig["subFilter"] == "ETSI.CAdES.detached"
    assert sig["coversWholeDocument"] is True
    assert sig["modificationLevel"] == "none"
    assert sig["docMdp"] is None
    assert sig["revisionIndex"] == 1
    assert [c["trusted"] for c in sig["chain"]] == [True, True, True]
    assert sig["chain"][-1]["subject"] == pki.root.cert.subject.rfc4514_string()
    assert sig["revocation"][0]["source"] == "crl"
    assert sig["revocation"][0]["status"] == "good"
    assert sig["summaryVi"]
    assert "valid" in sig["summaryEn"].lower()


def test_one_thousand_twenty_four_bit_key_is_trusted_but_flagged_weak(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    """Older Vietnamese CA certificates use RSA 1024: valid and trusted, with a warning."""
    params = {"pfxPath": str(pki.pfx_weak()), "password": PASSWORD_A}
    signed = signed_copy(harness, tmp_path, "weak", [params])
    [sig] = verify_file(harness, signed, trustRootPaths=_root(pki))["signatures"]
    assert sig["status"] == "valid-with-warnings"
    assert sig["reasons"] == ["WEAK_KEY"]
    assert sig["signerCert"]["keySize"] == 1024
    assert [c["trusted"] for c in sig["chain"]] == [True, True, True]


def test_crl_published_as_pem_is_read_and_handed_to_the_validator_as_der(
    pki: Any, tmp_path: Path
) -> None:
    """The Vietnam National Root CA publishes its CRL as PEM; the intermediate was 'unknown'."""
    from cryptography.hazmat.primitives import hashes

    from chef_core.signing.verify import _revocation_for, load_crl

    builder = (
        x509.CertificateRevocationListBuilder()
        .issuer_name(pki.root.cert.subject)
        .last_update(NOW - dt.timedelta(days=1))
        .next_update(NOW + dt.timedelta(days=30))
    )
    crl = builder.sign(pki.root.key, hashes.SHA256())
    pem = crl.public_bytes(serialization.Encoding.PEM)
    der = crl.public_bytes(serialization.Encoding.DER)
    assert load_crl(pem).signature == load_crl(der).signature

    row = _revocation_for(
        pki.inter.cert,
        pki.root.cert,
        verify_embedded_none(),
        "soft",
        lambda url, timeout, body=None: pem,
        2.0,
        NOW,
    )
    assert (row.source, row.status) == ("crl", "good")
    assert row.crl == der


def verify_embedded_none() -> Any:
    from chef_core.signing.verify import _Embedded

    return _Embedded()


def test_session_verify_matches_the_standalone_verify(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, make_text_pdf(tmp_path / "session.pdf"))
    harness.op("sign.pades", _a(pki), sid)
    revision_before = Path(
        harness.call("session.state", {"sessionId": sid})["revisionPath"]
    ).read_bytes()
    session_report = harness.op("sign.verify", {"trustRootPaths": _root(pki)}, sid)
    revision_after = Path(
        harness.call("session.state", {"sessionId": sid})["revisionPath"]
    ).read_bytes()
    assert session_report["changedPages"] == []
    assert revision_after == revision_before
    saved = _save(harness, sid, tmp_path / "session-saved.pdf")
    file_report = verify_file(harness, saved, trustRootPaths=_root(pki))
    assert session_report["data"]["signatures"] == file_report["signatures"]


def test_two_signers_are_reported_in_order(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    signed = signed_copy(harness, tmp_path, "two", [_a(pki), _b(pki)])
    first, second = verify_file(harness, signed, trustRootPaths=_root(pki))["signatures"]
    assert [first["fieldName"], second["fieldName"]] == ["Signature1", "Signature2"]
    assert first["status"] == "valid-with-warnings"  # the second signature is a later change
    assert second["status"] == "valid"
    assert second["signerName"] == "Trần Thị B"
    assert second["signerCert"]["identity"]["taxCode"] == "0309876543"
    assert first["revisionIndex"] < second["revisionIndex"]


def test_unsigned_field_is_reported_as_unsigned(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, make_text_pdf(tmp_path / "unsigned-src.pdf"))
    harness.op("sign.addField", {"page": 0, "rect": [10.0, 10.0, 120.0, 60.0]}, sid)
    path = _save(harness, sid, tmp_path / "unsigned.pdf")
    [item] = verify_file(harness, path, trustRootPaths=_root(pki))["signatures"]
    assert item["status"] == "unsigned"
    assert item["fieldName"] == "Signature1"
    assert item["reasons"] == ["UNSIGNED_FIELD"]
    assert item["signerCert"] is None
    assert item["level"] is None


def test_plain_pdf_has_no_signature_items(harness: Harness, tmp_path: Path) -> None:
    assert verify_file(harness, make_text_pdf(tmp_path / "plain.pdf")) == {"signatures": []}


# -- verification: trust --------------------------------------------------------------------


def test_untrusted_root_gives_cert_untrusted(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    signed = signed_copy(harness, tmp_path, "untrusted", [_a(pki)])
    [sig] = verify_file(harness, signed)["signatures"]
    assert sig["status"] == "unknown"
    assert "CERT_UNTRUSTED" in sig["reasons"]
    assert sig["signerCert"] is not None  # the identity is still shown
    assert not any(c["trusted"] for c in sig["chain"])


def test_root_in_a_trust_folder_is_trusted(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    signed = signed_copy(harness, tmp_path, "folder", [_a(pki)])
    folder = tmp_path / "user-roots"
    TrustStore(user_dir=folder, bundled_dir=tmp_path / "none").add(pki.root_pem)
    [sig] = verify_file(harness, signed, trustRootPaths=[str(folder)])["signatures"]
    assert sig["status"] == "valid"


def test_revoked_signer_is_invalid(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    revoked = {"pfxPath": str(pki.pfx_revoked()), "password": PASSWORD_REVOKED}
    signed = signed_copy(harness, tmp_path, "revoked", [revoked])
    [sig] = verify_file(harness, signed, trustRootPaths=_root(pki))["signatures"]
    assert sig["status"] == "invalid"
    assert "CERT_REVOKED" in sig["reasons"]
    assert sig["revocation"][0]["status"] == "revoked"


def test_certificate_expired_at_signing_time_is_invalid(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    # The timestamp is dated 30 days from now, after the certificate's notAfter (10 days).
    late_tsa = DummyTimeStamper(
        tsa_cert=services.tsa.tsa_cert,
        tsa_key=services.tsa.tsa_key,
        fixed_dt=NOW + dt.timedelta(days=30),
    )
    original = services.tsa
    services.tsa = late_tsa
    try:
        signed = signed_copy(
            harness,
            tmp_path,
            "late",
            [
                {
                    "pfxPath": str(pki.pfx_expiring()),
                    "password": PASSWORD_EXPIRING,
                    "level": "B-T",
                    "tsaUrls": [_tsa(services)],
                }
            ],
        )
    finally:
        services.tsa = original
    [sig] = verify_file(harness, signed, trustRootPaths=_root(pki))["signatures"]
    assert sig["status"] == "invalid"
    assert "CERT_EXPIRED_AT_SIGNING" in sig["reasons"]
    assert sig["timestampOk"] is True


# -- verification: integrity and modification -----------------------------------------------


def test_tampered_content_is_invalid_and_modified(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    signed = signed_copy(harness, tmp_path, "tamper", [_a(pki)])
    data = signed.read_bytes()
    assert data.count(b"(Hello)") == 1
    signed.write_bytes(data.replace(b"(Hello)", b"(Hallo)"))
    [sig] = verify_file(harness, signed, trustRootPaths=_root(pki))["signatures"]
    assert sig["status"] == "invalid"
    assert "INTEGRITY_FAILED" in sig["reasons"]
    assert "MODIFIED_AFTER_SIGNING" in sig["reasons"]


def test_appended_change_is_valid_with_warnings_and_a_level(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    signed = signed_copy(harness, tmp_path, "appended", [_a(pki)])
    changed = tmp_path / "appended-change.pdf"
    annotation_update(signed, changed)
    [sig] = verify_file(harness, changed, trustRootPaths=_root(pki))["signatures"]
    assert sig["status"] == "valid-with-warnings"
    assert "MODIFIED_AFTER_SIGNING" in sig["reasons"]
    assert sig["coversWholeDocument"] is False
    assert sig["modificationLevel"] in {"form-fill", "annotations", "other"}


def test_certified_document_with_an_illegal_change_is_invalid(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    signed = signed_copy(harness, tmp_path, "certified", [{**_a(pki), "certify": "no-changes"}])
    [clean] = verify_file(harness, signed, trustRootPaths=_root(pki))["signatures"]
    assert clean["status"] == "valid"
    assert clean["docMdp"] == 1
    changed = tmp_path / "certified-change.pdf"
    annotation_update(signed, changed)
    [sig] = verify_file(harness, changed, trustRootPaths=_root(pki))["signatures"]
    assert sig["status"] == "invalid"
    assert "DOCMDP_VIOLATION" in sig["reasons"]
    assert sig["docMdp"] == 1


def test_first_signature_is_valid_with_warnings_after_a_second_signer(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    signed = signed_copy(harness, tmp_path, "cover", [_a(pki), _b(pki)])
    first, second = verify_file(harness, signed, trustRootPaths=_root(pki))["signatures"]
    assert first["coversWholeDocument"] is False
    assert second["coversWholeDocument"] is True
    assert first["status"] == "valid-with-warnings"
    assert second["status"] == "valid"


# -- verification: timestamps and levels ----------------------------------------------------


def test_b_t_has_a_timestamp(harness: Harness, pki: Any, tmp_path: Path, services: Any) -> None:
    signed = signed_copy(
        harness, tmp_path, "bt", [{**_a(pki), "level": "B-T", "tsaUrls": [_tsa(services)]}]
    )
    [sig] = verify_file(harness, signed, trustRootPaths=_root(pki))["signatures"]
    assert sig["level"] == "B-T"
    assert sig["timestampOk"] is True
    assert sig["timestampTime"] is not None
    assert sig["status"] == "valid"


def test_b_lt_is_detected_and_its_revocation_comes_from_the_dss(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    blt = {
        **_a(pki),
        "level": "B-LT",
        "tsaUrls": [_tsa(services)],
        "trustRootPaths": _root(pki),
    }
    signed = signed_copy(harness, tmp_path, "blt", [blt])
    hits = dict(services.hits)
    sig = verify_offline(signed, pki, "hard", True, tmp_path)
    assert sig["level"] == "B-LT"
    assert sig["status"] == "valid"
    signer_rows = sig["revocation"][:2]  # signer and intermediate: both answered by the DSS
    assert [r["source"] for r in signer_rows] == ["embedded", "embedded"]
    assert services.hits == hits  # nothing fetched: the DSS has everything
    # The timestamp authority has no revocation pointers, so its entry says so (no warning).
    assert sig["revocation"][-1]["status"] == "unknown"


def test_b_lta_is_detected_from_the_document_timestamp(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    blta = {**_a(pki), "level": "B-LTA", "tsaUrls": [_tsa(services)], "trustRootPaths": _root(pki)}
    signed = signed_copy(harness, tmp_path, "blta", [blta])
    [sig] = verify_file(harness, signed, trustRootPaths=_root(pki))["signatures"]
    assert sig["level"] == "B-LTA"
    assert sig["status"] == "valid"


# -- verification: revocation modes ---------------------------------------------------------


def test_offline_soft_mode_is_a_warning_with_unknown_revocation(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sig = verify_offline(
        signed_copy(harness, tmp_path, "soft", [_a(pki)]), pki, "soft", True, tmp_path
    )
    assert sig["status"] == "valid-with-warnings"
    assert "REVOCATION_UNKNOWN" in sig["reasons"]
    assert sig["revocation"][0]["source"] == "none"
    assert sig["revocation"][0]["status"] == "unknown"


def test_offline_hard_mode_makes_the_signature_unknown(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sig = verify_offline(
        signed_copy(harness, tmp_path, "hard", [_a(pki)]), pki, "hard", True, tmp_path
    )
    assert sig["status"] == "unknown"
    assert "REVOCATION_UNKNOWN" in sig["reasons"]


def test_allow_offline_false_behaves_like_hard_mode(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    signed = signed_copy(harness, tmp_path, "strict", [_a(pki)])
    assert verify_offline(signed, pki, "soft", False, tmp_path)["status"] == "unknown"


def test_revocation_none_makes_no_network_calls(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    signed = signed_copy(harness, tmp_path, "none-mode", [_a(pki)])
    hits = dict(services.hits)
    sig = verify_offline(signed, pki, "none", True, tmp_path)
    assert sig["status"] == "valid"
    assert sig["revocation"][0]["source"] == "none"
    assert services.hits == hits


def test_online_revocation_uses_the_crl_server(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    signed = signed_copy(harness, tmp_path, "crl-online", [_a(pki)])
    hits = services.hits["crl"]
    [sig] = verify_file(harness, signed, trustRootPaths=_root(pki), checkRevocation="hard")[
        "signatures"
    ]
    assert sig["status"] == "valid"
    assert services.hits["crl"] > hits
    assert {r["source"] for r in sig["revocation"]} == {"crl"}


# -- verification: parameters and files -----------------------------------------------------


@pytest.mark.parametrize(
    "params",
    [
        {"checkRevocation": "maybe"},
        {"timeoutSeconds": 0},
        {"timeoutSeconds": 999},
        {"unknownField": True},
    ],
)
def test_invalid_verify_params_are_rejected(
    harness: Harness, tmp_path: Path, params: dict[str, Any]
) -> None:
    path = make_text_pdf(tmp_path / "params.pdf")
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.verifyFile", {"path": str(path), **params})
    assert exc.value.kind == "INVALID_PARAMS"


def test_missing_file_is_file_not_found(harness: Harness, tmp_path: Path) -> None:
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.verifyFile", {"path": str(tmp_path / "absent.pdf")})
    assert exc.value.kind == "FILE_NOT_FOUND"


def test_damaged_file_is_invalid_pdf(harness: Harness, tmp_path: Path) -> None:
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"%PDF-1.4 this is not a real document")
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.verifyFile", {"path": str(bad)})
    assert exc.value.kind == "INVALID_PDF"


def test_verification_writes_nothing_next_to_the_file(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    signed = signed_copy(harness, tmp_path, "readonly", [_a(pki)])
    before = sorted(p.name for p in tmp_path.iterdir())
    verify_file(harness, signed, trustRootPaths=_root(pki))
    assert sorted(p.name for p in tmp_path.iterdir()) == before


# -- extractRevision (I35) ------------------------------------------------------------------


def test_extracted_revision_keeps_the_signed_bytes(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    signed = signed_copy(harness, tmp_path, "extract", [_a(pki), _b(pki)])
    out = tmp_path / "rev1.pdf"
    result = harness.op(
        "sign.extractRevision",
        {"path": str(signed), "fieldName": "Signature1", "outputPath": str(out)},
    )
    assert result["outputs"] == [str(out)]
    assert signed.read_bytes().startswith(out.read_bytes())
    assert len(out.read_bytes()) < len(signed.read_bytes())
    with pikepdf.open(out) as pdf:
        assert len(pdf.pages) == 1
    # The first signature still validates on the extracted revision: same signed bytes.
    [only] = validate_pdf_signatures(out, pki.root.cert).signatures
    assert only.field == "Signature1"
    assert only.intact and only.valid


def test_extracting_the_last_signature_gives_the_whole_file(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    signed = signed_copy(harness, tmp_path, "extract2", [_a(pki), _b(pki)])
    out = tmp_path / "rev2.pdf"
    harness.op(
        "sign.extractRevision",
        {"path": str(signed), "fieldName": "Signature2", "outputPath": str(out)},
    )
    assert out.read_bytes() == signed.read_bytes()


@pytest.mark.parametrize("field", ["NoSuchField", None])
def test_extract_needs_a_signed_field(
    harness: Harness, pki: Any, tmp_path: Path, services: Any, field: str | None
) -> None:
    signed = signed_copy(harness, tmp_path, "extract-bad", [_a(pki)])
    out = tmp_path / "never.pdf"
    params: dict[str, Any] = {"path": str(signed), "outputPath": str(out)}
    if field is not None:
        params["fieldName"] = field
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.extractRevision", params)
    assert exc.value.kind == "INVALID_PARAMS"
    assert not out.exists()


def test_extract_of_a_missing_file_is_file_not_found(harness: Harness, tmp_path: Path) -> None:
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "sign.extractRevision",
            {
                "path": str(tmp_path / "gone.pdf"),
                "fieldName": "Signature1",
                "outputPath": str(tmp_path / "o.pdf"),
            },
        )
    assert exc.value.kind == "FILE_NOT_FOUND"


def test_extract_core_function_refuses_an_unsigned_file(tmp_path: Path) -> None:
    with pytest.raises(ChefError):
        extract_revision(make_text_pdf(tmp_path / "plain2.pdf"), "Signature1", tmp_path / "n.pdf")


# -- fixtures for the helpers themselves ----------------------------------------------------


def test_annotation_fixture_appends_without_touching_earlier_bytes(tmp_path: Path) -> None:
    base = make_text_pdf(tmp_path / "base.pdf", pages=2)
    changed = tmp_path / "changed.pdf"
    annotation_update(base, changed)
    assert changed.read_bytes().startswith(base.read_bytes())
    with pikepdf.open(changed) as pdf:
        assert len(pdf.pages) == 2
        assert len(pdf.pages[0].Annots) == 1
