"""Trust-store operations (I35 follow-up): sign.trustList, sign.trustAdd, sign.trustRemove.

The user trust folder is ``<data-dir>/trust`` (set by CoreApp). Adding a root there makes every
verification and every B-LT signing trust it, without passing trustRootPaths.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

import pytest
from conftest import Harness, RpcFailure, make_numbered_pdf
from signing_support import PASSWORD_A

from chef_core import ops
from chef_core.signing.trust import fingerprint_of


def _trust_dir(harness: Harness) -> Path:
    return harness.data_dir / "trust"


def _root_fingerprint(pki: Any) -> str:
    return fingerprint_of(pki.root.cert)


def _signed_a(harness: Harness, pki: Any, tmp_path: Path, name: str) -> Path:
    sample = make_numbered_pdf(tmp_path / f"{name}-src.pdf", 1)
    sid = str(harness.open(sample)["state"]["sessionId"])
    harness.op("sign.pades", {"pfxPath": str(pki.pfx_a()), "password": PASSWORD_A}, sid)
    out = tmp_path / f"{name}.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(out)})
    return out


def _status(harness: Harness, path: Path, **params: Any) -> dict[str, Any]:
    data = harness.op("sign.verifyFile", {"path": str(path), **params})["data"]
    [sig] = data["signatures"]
    return dict(sig)


# -- registration -----------------------------------------------------------------------


def test_trust_ops_are_standalone_and_registered() -> None:
    ops.load_builtin_ops()
    reg = ops.registry()
    for op_id in ("sign.trustList", "sign.trustAdd", "sign.trustRemove"):
        assert reg[op_id].standalone, op_id
        assert not reg[op_id].finalizing, op_id


# -- list / add / remove ----------------------------------------------------------------


def test_list_starts_with_no_user_entries(harness: Harness) -> None:
    rows = harness.op("sign.trustList", {})["data"]["certificates"]
    assert all(row["source"] == "bundled" for row in rows)


def test_add_then_list_shows_the_group_and_source(harness: Harness, pki: Any) -> None:
    added = harness.op("sign.trustAdd", {"path": str(pki.root_pem), "group": "vn-public-ca"})[
        "data"
    ]["added"]
    assert [row["fingerprintSha256"] for row in added] == [_root_fingerprint(pki)]
    rows = harness.op("sign.trustList", {})["data"]["certificates"]
    mine = [r for r in rows if r["fingerprintSha256"] == _root_fingerprint(pki)]
    assert len(mine) == 1
    assert mine[0]["source"] == "user"
    assert mine[0]["group"] == "vn-public-ca"
    assert mine[0]["subject"].startswith("CN=Chef Test Root CA")
    assert any(p.name.startswith("vn-public-ca.") for p in _trust_dir(harness).iterdir())


def test_add_defaults_to_the_user_group(harness: Harness, pki: Any) -> None:
    harness.op("sign.trustAdd", {"path": str(pki.root_pem)})
    rows = harness.op("sign.trustList", {})["data"]["certificates"]
    assert {r["group"] for r in rows if r["source"] == "user"} == {"user"}


def test_add_rejects_unknown_group_and_missing_or_bad_files(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    with pytest.raises(RpcFailure) as group:
        harness.op("sign.trustAdd", {"path": str(pki.root_pem), "group": "everyone"})
    assert group.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as missing:
        harness.op("sign.trustAdd", {"path": str(tmp_path / "nope.pem")})
    assert missing.value.kind == "FILE_NOT_FOUND"
    text = tmp_path / "not-a-cert.pem"
    text.write_text("hello", encoding="utf-8")
    with pytest.raises(RpcFailure) as bad:
        harness.op("sign.trustAdd", {"path": str(text)})
    assert bad.value.kind == "SIGN_BAD_CERT"


def test_remove_deletes_only_the_user_copy(harness: Harness, pki: Any) -> None:
    harness.op("sign.trustAdd", {"path": str(pki.root_pem)})
    harness.op("sign.trustRemove", {"fingerprintSha256": _root_fingerprint(pki)})
    rows = harness.op("sign.trustList", {})["data"]["certificates"]
    assert all(r["fingerprintSha256"] != _root_fingerprint(pki) for r in rows)


def test_remove_of_an_unknown_fingerprint_is_refused(harness: Harness, pki: Any) -> None:
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.trustRemove", {"fingerprintSha256": _root_fingerprint(pki)})
    assert exc.value.kind == "INVALID_PARAMS"


def test_trust_op_params_are_validated(harness: Harness, pki: Any) -> None:
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.trustRemove", {"fingerprintSha256": ""})
    assert exc.value.kind == "INVALID_PARAMS"


# -- the store is used by verification and by B-LT signing ------------------------------


def test_user_trusted_root_makes_verification_trusted_without_trust_paths(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    signed = _signed_a(harness, pki, tmp_path, "trust-default")
    before = _status(harness, signed)
    assert "CERT_UNTRUSTED" in before["reasons"]

    harness.op("sign.trustAdd", {"path": str(pki.root_pem), "group": "vn-public-ca"})
    after = _status(harness, signed)
    assert "CERT_UNTRUSTED" not in after["reasons"]
    assert after["status"] == "valid"

    harness.op("sign.trustRemove", {"fingerprintSha256": _root_fingerprint(pki)})
    again = _status(harness, signed)
    assert "CERT_UNTRUSTED" in again["reasons"]


def test_b_lt_uses_the_user_trust_store_as_its_anchor(
    harness: Harness, pki: Any, tmp_path: Path, sign_services: Any
) -> None:
    # The loopback counters are shared by the whole session: put them back afterwards.
    counters = dict(sign_services.hits)
    try:
        _b_lt_with_user_root(harness, pki, tmp_path, sign_services)
    finally:
        sign_services.hits.update(counters)


def _b_lt_with_user_root(harness: Harness, pki: Any, tmp_path: Path, sign_services: Any) -> None:
    harness.op("sign.trustAdd", {"path": str(pki.root_pem)})
    sample = make_numbered_pdf(tmp_path / "blt-src.pdf", 1)
    sid = str(harness.open(sample)["state"]["sessionId"])
    result = harness.op(
        "sign.pades",
        {
            "pfxPath": str(pki.pfx_a_without_root()),
            "password": PASSWORD_A,
            "level": "B-LT",
            "tsaUrls": [f"{sign_services.base_url}/tsa"],
        },
        sid,
    )
    assert result["data"]["level"] == "B-LT"


def test_b_lt_without_any_anchor_still_refuses(
    harness: Harness, pki: Any, tmp_path: Path, sign_services: Any
) -> None:
    sample = make_numbered_pdf(tmp_path / f"noanchor-{uuid.uuid4().hex[:6]}.pdf", 1)
    sid = str(harness.open(sample)["state"]["sessionId"])
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "sign.pades",
            {
                "pfxPath": str(pki.pfx_a_without_root()),
                "password": PASSWORD_A,
                "level": "B-LT",
                "tsaUrls": [f"{sign_services.base_url}/tsa"],
            },
            sid,
        )
    assert exc.value.kind == "INVALID_PARAMS"
