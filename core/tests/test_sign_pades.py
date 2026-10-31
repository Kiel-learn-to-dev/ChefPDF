"""T3.06: PAdES signing (feature I28): levels B-B/B-T/B-LT/B-LTA, TSA fallback, incremental saves.

Every signature produced here is checked with pyHanko's validator (signing_support). The TSA and
the CRLs are served by a loopback server, so no test reaches the internet.
"""

from __future__ import annotations

import datetime as dt
import uuid
from pathlib import Path
from typing import Any

import pikepdf
import pytest
from conftest import Harness, RpcFailure, make_numbered_pdf
from signing_support import dead_url, validate_pdf_signatures

from chef_core.signing.pades import AppearanceInfo, PlaceholderAppearance

PASSWORD_A = "Mật-khẩu-A-2026"
PASSWORD_B = "second-pass-B-2026"


def _open(harness: Harness, tmp_path: Path, pages: int = 2) -> str:
    sample = make_numbered_pdf(tmp_path / f"doc-{uuid.uuid4().hex[:8]}.pdf", pages)
    state: dict[str, Any] = harness.open(sample)["state"]
    return str(state["sessionId"])


def _sign(harness: Harness, sid: str, **params: Any) -> dict[str, Any]:
    return harness.op("sign.pades", params, sid)


def _revision(harness: Harness, sid: str) -> bytes:
    state = harness.call("session.state", {"sessionId": sid})
    return Path(state["revisionPath"]).read_bytes()


def _save(harness: Harness, sid: str, dest: Path) -> Path:
    harness.call("session.save", {"sessionId": sid, "path": str(dest)})
    return dest


def _sig_fields(path: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    with pikepdf.open(path) as pdf:
        for field in pdf.Root.AcroForm.Fields:
            if field.get("/FT") == pikepdf.Name.Sig:
                rect = [float(v) for v in field.get("/Rect", [])]
                out.append({"name": str(field.get("/T")), "rect": rect})
    return out


def _tsa(services: Any) -> str:
    return f"{services.base_url}/tsa"


@pytest.fixture
def services(sign_services: Any) -> Any:
    return sign_services


# -- invisible and visible signatures -----------------------------------------------------


def test_b_b_invisible_signature_validates(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    result = _sign(harness, sid, pfxPath=str(pki.pfx_a()), password=PASSWORD_A)
    assert result["state"]["signed"] is True
    assert result["changedPages"] == []
    assert result["data"]["fieldName"] == "Signature1"
    assert result["data"]["level"] == "B-B"
    assert result["data"]["tsaUrl"] is None
    assert services.hits["tsa"] == 0

    saved = _save(harness, sid, tmp_path / "bb.pdf")
    validation = validate_pdf_signatures(saved, pki.root.cert)
    assert validation.doc_timestamps == 0
    [sig] = validation.signatures
    assert sig.field == "Signature1"
    assert sig.intact and sig.valid and sig.trusted
    assert sig.has_timestamp is False
    assert sig.signer is not None and "Nguyễn Văn A" in sig.signer


def test_visible_signature_places_widget_at_rect(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    rect = [72.0, 600.0, 272.0, 680.0]
    result = _sign(harness, sid, pfxPath=str(pki.pfx_a()), password=PASSWORD_A, page=1, rect=rect)
    assert result["changedPages"] == [1]

    saved = _save(harness, sid, tmp_path / "visible.pdf")
    assert _sig_fields(saved) == [{"name": "Signature1", "rect": rect}]
    assert validate_pdf_signatures(saved, pki.root.cert).signatures[0].valid


def test_signing_appends_to_the_revision_file(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    before = _revision(harness, sid)
    _sign(harness, sid, pfxPath=str(pki.pfx_a()), password=PASSWORD_A)
    after = _revision(harness, sid)
    # Incremental update: the old bytes are a prefix of the new file, untouched.
    assert after.startswith(before)
    assert len(after) > len(before)


def test_second_signer_keeps_first_signature_valid(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    _sign(harness, sid, pfxPath=str(pki.pfx_a()), password=PASSWORD_A)
    after_first = _revision(harness, sid)

    second = _sign(harness, sid, pfxPath=str(pki.pfx_b()), password=PASSWORD_B)
    assert second["data"]["fieldName"] == "Signature2"
    after_second = _revision(harness, sid)
    # The first signature covers exactly the bytes it covered before the second signing.
    assert after_second.startswith(after_first)

    saved = _save(harness, sid, tmp_path / "two.pdf")
    validation = validate_pdf_signatures(saved, pki.root.cert)
    assert [s.field for s in validation.signatures] == ["Signature1", "Signature2"]
    assert all(s.intact and s.valid and s.trusted for s in validation.signatures)
    assert "Trần Thị B" in (validation.signatures[1].signer or "")


def test_field_name_collision_with_visible_rect_is_rejected(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    _sign(
        harness,
        sid,
        pfxPath=str(pki.pfx_a()),
        password=PASSWORD_A,
        page=0,
        rect=[10.0, 10.0, 110.0, 60.0],
    )
    with pytest.raises(RpcFailure) as exc:
        _sign(
            harness,
            sid,
            pfxPath=str(pki.pfx_b()),
            password=PASSWORD_B,
            page=0,
            rect=[10.0, 80.0, 110.0, 130.0],
            fieldName="Signature1",
        )
    assert exc.value.kind == "INVALID_PARAMS"


def test_placeholder_appearance_handles_vietnamese_name() -> None:
    info = AppearanceInfo(
        signer_name="Nguyễn Văn A",
        organization="Công ty TNHH Thử Nghiệm",
        reason="Phê duyệt 100% hợp đồng",
        location="Hà Nội",
        signed_at=dt.datetime(2026, 10, 31, 10, 0, tzinfo=dt.UTC),
    )
    style = PlaceholderAppearance().stamp_style(info, 200.0, 80.0)
    assert style is not None


# -- timestamps and levels --------------------------------------------------------------


def test_b_t_with_local_tsa_adds_timestamp(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    result = _sign(
        harness,
        sid,
        pfxPath=str(pki.pfx_a()),
        password=PASSWORD_A,
        level="B-T",
        tsaUrls=[_tsa(services)],
    )
    assert result["data"]["tsaUrl"] == _tsa(services)
    assert services.hits["tsa"] >= 1
    saved = _save(harness, sid, tmp_path / "bt.pdf")
    [sig] = validate_pdf_signatures(saved, pki.root.cert).signatures
    assert sig.valid and sig.has_timestamp


def test_tsa_fallback_uses_next_server(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    result = _sign(
        harness,
        sid,
        pfxPath=str(pki.pfx_a()),
        password=PASSWORD_A,
        level="B-T",
        tsaUrls=[dead_url(), _tsa(services)],
    )
    assert result["data"]["tsaUrl"] == _tsa(services)


def test_all_tsa_failing_is_an_error_not_a_downgrade(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    before = _revision(harness, sid)
    with pytest.raises(RpcFailure) as exc:
        _sign(
            harness,
            sid,
            pfxPath=str(pki.pfx_a()),
            password=PASSWORD_A,
            level="B-T",
            tsaUrls=[dead_url(), dead_url()],
        )
    assert exc.value.kind == "SIGN_TSA_FAILED"
    # Nothing was written and the document is still not signed.
    assert _revision(harness, sid) == before
    assert harness.call("session.state", {"sessionId": sid})["signed"] is False


def test_b_b_never_contacts_tsa(harness: Harness, pki: Any, tmp_path: Path, services: Any) -> None:
    sid = _open(harness, tmp_path)
    result = _sign(
        harness, sid, pfxPath=str(pki.pfx_a()), password=PASSWORD_A, tsaUrls=[dead_url()]
    )
    assert result["data"]["level"] == "B-B"


def test_b_lt_embeds_revocation_information(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    _sign(
        harness,
        sid,
        pfxPath=str(pki.pfx_a()),
        password=PASSWORD_A,
        level="B-LT",
        tsaUrls=[_tsa(services)],
    )
    saved = _save(harness, sid, tmp_path / "blt.pdf")
    with pikepdf.open(saved) as pdf:
        dss = pdf.Root.get("/DSS")
        assert dss is not None
        assert len(dss.get("/CRLs", [])) >= 1
        assert len(dss.get("/Certs", [])) >= 1
    assert validate_pdf_signatures(saved, pki.root.cert).signatures[0].valid


def test_b_lta_adds_document_timestamp(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    _sign(
        harness,
        sid,
        pfxPath=str(pki.pfx_a()),
        password=PASSWORD_A,
        level="B-LTA",
        tsaUrls=[_tsa(services)],
    )
    saved = _save(harness, sid, tmp_path / "blta.pdf")
    validation = validate_pdf_signatures(saved, pki.root.cert)
    assert validation.doc_timestamps == 1
    assert validation.signatures[0].valid


@pytest.mark.parametrize("digest", ["sha384", "sha512"])
def test_other_digests(
    harness: Harness, pki: Any, tmp_path: Path, services: Any, digest: str
) -> None:
    sid = _open(harness, tmp_path)
    _sign(harness, sid, pfxPath=str(pki.pfx_a()), password=PASSWORD_A, digest=digest)
    saved = _save(harness, sid, tmp_path / f"{digest}.pdf")
    assert validate_pdf_signatures(saved, pki.root.cert).signatures[0].valid


def test_b_lt_needs_a_trust_anchor(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    with pytest.raises(RpcFailure) as exc:
        _sign(
            harness,
            sid,
            pfxPath=str(pki.pfx_a_without_root()),
            password=PASSWORD_A,
            level="B-LT",
            tsaUrls=[_tsa(services)],
        )
    assert exc.value.kind == "INVALID_PARAMS"


def test_b_lt_with_explicit_trust_root(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    _sign(
        harness,
        sid,
        pfxPath=str(pki.pfx_a_without_root()),
        password=PASSWORD_A,
        level="B-LT",
        tsaUrls=[_tsa(services)],
        trustRootPaths=[str(pki.root_pem)],
    )
    saved = _save(harness, sid, tmp_path / "noroot.pdf")
    assert validate_pdf_signatures(saved, pki.root.cert).signatures[0].valid


def test_b_lt_with_revoked_signer_is_refused(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    with pytest.raises(RpcFailure) as exc:
        _sign(
            harness,
            sid,
            pfxPath=str(pki.pfx_revoked()),
            password="revoked-2026",
            level="B-LT",
            tsaUrls=[_tsa(services)],
        )
    assert exc.value.kind == "SIGN_FAILED"


# -- certificate checks -----------------------------------------------------------------


def test_expired_certificate_is_refused(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    with pytest.raises(RpcFailure) as exc:
        _sign(harness, sid, pfxPath=str(pki.pfx_expired()), password="expired-2020")
    assert exc.value.kind == "SIGN_CERT_EXPIRED"


def test_expiring_certificate_signs_with_warning(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    result = _sign(harness, sid, pfxPath=str(pki.pfx_expiring()), password="expiring-2026")
    assert any("expires" in w.lower() for w in result["warnings"])
    saved = _save(harness, sid, tmp_path / "expiring.pdf")
    assert validate_pdf_signatures(saved, pki.root.cert).signatures[0].valid


def test_wrong_password_fails_the_job(
    harness: Harness, pki: Any, tmp_path: Path, services: Any
) -> None:
    sid = _open(harness, tmp_path)
    with pytest.raises(RpcFailure) as exc:
        _sign(harness, sid, pfxPath=str(pki.pfx_a()), password="sai-mat-khau")
    assert exc.value.kind == "SIGN_BAD_PASSWORD"


# -- parameter validation ---------------------------------------------------------------


@pytest.mark.parametrize(
    "params",
    [
        {"page": 0},  # page without rect
        {"rect": [10.0, 10.0, 50.0, 50.0]},  # rect without page
        {"page": 0, "rect": [100.0, 100.0, 50.0, 50.0]},  # inverted rect
        {"page": 0, "rect": [10.0, 10.0, 50.0]},  # rect with 3 numbers
        {"page": 9, "rect": [10.0, 10.0, 50.0, 50.0]},  # page out of range
        {"level": "B-T"},  # timestamp level without any TSA
        {"level": "B-T", "tsaUrls": ["ftp://example.invalid/tsa"]},  # bad scheme
        {"level": "B-X"},
        {"digest": "md5"},
        {"page": -1, "rect": [10.0, 10.0, 50.0, 50.0]},
    ],
)
def test_invalid_params_are_rejected_without_changing_the_document(
    harness: Harness, pki: Any, tmp_path: Path, services: Any, params: dict[str, Any]
) -> None:
    sid = _open(harness, tmp_path)
    before = _revision(harness, sid)
    with pytest.raises(RpcFailure) as exc:
        _sign(harness, sid, pfxPath=str(pki.pfx_a()), password=PASSWORD_A, **params)
    assert exc.value.kind == "INVALID_PARAMS"
    assert _revision(harness, sid) == before
