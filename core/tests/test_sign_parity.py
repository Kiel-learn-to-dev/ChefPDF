"""Parity of sign.padesToken with sign.pades (review gap): one params base, one request path.

The token op must draw the same visible templates and support certification like the PFX op.
Everything runs with the fake token backend and the test PKI (no driver, no network).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pikepdf
import pytest
from conftest import Harness, RpcFailure, make_numbered_pdf
from signing_support import PASSWORD_A, validate_pdf_signatures
from token_support import (
    FakeBackend,
    FakeCert,
    FakeSlot,
    FakeToken,
    fake_cert_chain,
    make_module_file,
    windows_environment,
)

from chef_core.ops.sign import SignPadesParams
from chef_core.ops.sign_common import SignCommonParams
from chef_core.ops.sign_token import SignPadesTokenParams
from chef_core.signing.pkcs11 import use_backend

SECRET_PIN = "PARITY-PIN-42"
CERT_ID = "01"
RECT = [72.0, 600.0, 292.0, 680.0]
# The wire shape of sign.pades must not change (the UI and the existing tests depend on it).
PFX_WIRE_PROPERTIES = {
    "pfxPath",
    "password",
    "level",
    "digest",
    "tsaUrls",
    "trustRootPaths",
    "reason",
    "location",
    "contactInfo",
    "fieldName",
    "page",
    "rect",
    "certify",
    "template",
}


@pytest.fixture(autouse=True)
def _windows_env() -> Iterator[None]:
    with windows_environment():
        yield


@pytest.fixture
def backend() -> Iterator[FakeBackend]:
    fake = FakeBackend()
    with use_backend(fake):
        yield fake


@pytest.fixture
def module(tmp_path: Path, backend: FakeBackend, pki: Any) -> str:
    path = make_module_file(tmp_path, "parity-token.dll")
    token = FakeToken(pin=SECRET_PIN)
    token.certs = [
        FakeCert(
            cka_id=bytes.fromhex(CERT_ID), certificate=pki.signer_a.cert, key=pki.signer_a.key
        ),
        *fake_cert_chain(pki.inter.cert, pki.root.cert),
    ]
    backend.add_module(path, FakeSlot(slot_id=0, token=token, description="Parity reader"))
    return path


def _open(harness: Harness, tmp_path: Path) -> str:
    sample = make_numbered_pdf(tmp_path / f"doc-{uuid.uuid4().hex[:8]}.pdf", 2)
    return str(harness.open(sample)["state"]["sessionId"])


def _token(module: str, **overrides: Any) -> dict[str, Any]:
    params: dict[str, Any] = {
        "modulePath": module,
        "slotId": 0,
        "certId": CERT_ID,
        "pin": SECRET_PIN,
    }
    params.update(overrides)
    return params


def _font_base_names(path: Path) -> set[str]:
    """BaseFont names of every font dictionary in the file (signature appearances included)."""
    names: set[str] = set()
    with pikepdf.open(path) as pdf:
        for obj in pdf.objects:
            if isinstance(obj, pikepdf.Dictionary) and obj.get("/Type") == "/Font":
                names.add(str(obj.get("/BaseFont", "")))
    return names


def _docmdp_level(path: Path) -> int | None:
    with pikepdf.open(path) as pdf:
        for field in pdf.Root.AcroForm.Fields:
            value = field.get("/V")
            if value is None:
                continue
            for ref in value.get("/Reference", []):
                if ref.get("/TransformMethod") == "/DocMDP":
                    return int(ref["/TransformParams"].get("/P", 2))
    return None


# -- one params base ------------------------------------------------------------------------


def test_both_sign_ops_inherit_one_common_params_base() -> None:
    assert issubclass(SignPadesParams, SignCommonParams)
    assert issubclass(SignPadesTokenParams, SignCommonParams)
    common = set(SignCommonParams.model_fields)
    assert {"template", "certify", "field_name", "page", "rect"} <= common
    assert {"level", "digest", "tsa_urls", "trust_root_paths", "reason"} <= common
    assert set(SignPadesParams.model_fields) - common == {"pfx_path", "password"}
    assert set(SignPadesTokenParams.model_fields) - common == {
        "module_path",
        "slot_id",
        "token_serial",
        "cert_id",
        "pin",
        "confirm_final_try",
    }


def test_sign_pades_wire_shape_is_unchanged() -> None:
    schema = SignPadesParams.model_json_schema(by_alias=True)
    assert set(schema["properties"]) == PFX_WIRE_PROPERTIES
    assert set(schema["required"]) == {"pfxPath"}


# -- token path renders the template and certifies ----------------------------------------


def test_token_path_draws_the_vietnamese_template(
    harness: Harness, backend: FakeBackend, module: str, pki: Any, tmp_path: Path
) -> None:
    sid = _open(harness, tmp_path)
    template = {
        "header": "Ký số bởi",
        "lines": [
            {"source": "signerName", "label": "Người ký:"},
            {"source": "reason", "label": "Lý do:"},
        ],
    }
    result = harness.op(
        "sign.padesToken",
        _token(module, rect=RECT, page=1, reason="Phê duyệt", template=template),
        sid,
    )
    assert result["changedPages"] == [1]
    saved = tmp_path / "token-template.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(saved)})
    fonts = _font_base_names(saved)
    assert any("BeVietnamPro" in name for name in fonts), fonts
    assert validate_pdf_signatures(saved, pki.root.cert).signatures[0].valid


def test_token_and_pfx_paths_use_the_same_default_look(
    harness: Harness, pki: Any, module: str, backend: FakeBackend, tmp_path: Path
) -> None:
    sid_pfx = _open(harness, tmp_path)
    sid_tok = _open(harness, tmp_path)
    visible = {"page": 0, "rect": RECT}
    harness.op(
        "sign.pades", {"pfxPath": str(pki.pfx_a()), "password": PASSWORD_A, **visible}, sid_pfx
    )
    harness.op("sign.padesToken", _token(module, **visible), sid_tok)
    harness.call("session.save", {"sessionId": sid_pfx, "path": str(tmp_path / "pfx.pdf")})
    harness.call("session.save", {"sessionId": sid_tok, "path": str(tmp_path / "tok.pdf")})
    assert any("BeVietnamPro" in n for n in _font_base_names(tmp_path / "pfx.pdf"))
    assert any("BeVietnamPro" in n for n in _font_base_names(tmp_path / "tok.pdf"))


def test_token_path_certify_writes_docmdp(
    harness: Harness, backend: FakeBackend, module: str, pki: Any, tmp_path: Path
) -> None:
    sid = _open(harness, tmp_path)
    harness.op("sign.padesToken", _token(module, certify="no-changes"), sid)
    saved = tmp_path / "token-certified.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(saved)})
    assert _docmdp_level(saved) == 1
    assert validate_pdf_signatures(saved, pki.root.cert).signatures[0].valid


def test_token_path_refuses_certify_on_a_signed_document(
    harness: Harness, backend: FakeBackend, module: str, pki: Any, tmp_path: Path
) -> None:
    sid = _open(harness, tmp_path)
    harness.op("sign.pades", {"pfxPath": str(pki.pfx_a()), "password": PASSWORD_A}, sid)
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.padesToken", _token(module, certify="form-fill"), sid)
    assert exc.value.kind == "INVALID_PARAMS"
    assert backend.login_attempts == []


def test_token_path_rejects_the_same_bad_params_as_pfx(
    harness: Harness, backend: FakeBackend, module: str, tmp_path: Path
) -> None:
    sid = _open(harness, tmp_path)
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.padesToken", _token(module, page=0), sid)
    assert exc.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as exc2:
        harness.op("sign.padesToken", _token(module, level="B-T"), sid)
    assert exc2.value.kind == "INVALID_PARAMS"
    assert backend.login_attempts == []


def test_token_path_rejects_unknown_certify_value(
    harness: Harness, backend: FakeBackend, module: str, tmp_path: Path
) -> None:
    sid = _open(harness, tmp_path)
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.padesToken", _token(module, certify="everything"), sid)
    assert exc.value.kind == "INVALID_PARAMS"
    assert backend.login_attempts == []
