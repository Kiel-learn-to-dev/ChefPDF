"""T3.04: loading .pfx / .p12 signing certificates (feature I2)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.serialization import pkcs12
from signing_support import PASSWORD_A

from chef_core.errors import ChefError, ErrorKind
from chef_core.signing.pfx import load_pfx

WRONG_PASSWORD = "Mật-khẩu-SAI-9999"


def test_loads_pfx_with_password(pki: Any) -> None:
    loaded = load_pfx(pki.pfx_a(), PASSWORD_A)
    assert loaded.certificate.serial_number == pki.signer_a.cert.serial_number
    # The chain stored in the archive (intermediate + root) is kept for the signer.
    assert len(loaded.chain) == 2
    assert loaded.signer.signing_cert.subject.human_friendly


def test_unencrypted_pfx_loads_without_password(pki: Any, tmp_path: Path) -> None:
    path = pki.pfx("plain", pki.signer_b, None, [pki.inter.cert])
    loaded = load_pfx(path, None)
    assert loaded.certificate.serial_number == pki.signer_b.cert.serial_number


def test_wrong_password_is_sign_bad_password(pki: Any) -> None:
    with pytest.raises(ChefError) as exc:
        load_pfx(pki.pfx_a(), WRONG_PASSWORD)
    assert exc.value.kind is ErrorKind.SIGN_BAD_PASSWORD


def test_missing_password_is_password_required(pki: Any) -> None:
    for missing in (None, ""):
        with pytest.raises(ChefError) as exc:
            load_pfx(pki.pfx_a(), missing)
        assert exc.value.kind is ErrorKind.PASSWORD_REQUIRED


def test_passwords_never_appear_in_errors(pki: Any) -> None:
    with pytest.raises(ChefError) as exc:
        load_pfx(pki.pfx_a(), WRONG_PASSWORD)
    rendered = repr(exc.value.to_rpc()) + str(exc.value) + repr(exc.value.detail)
    assert WRONG_PASSWORD not in rendered
    assert PASSWORD_A not in rendered


def test_garbage_file_is_sign_bad_cert(tmp_path: Path) -> None:
    bad = tmp_path / "garbage.pfx"
    bad.write_bytes(b"this is not a PKCS#12 archive at all")
    with pytest.raises(ChefError) as exc:
        load_pfx(bad, PASSWORD_A)
    assert exc.value.kind is ErrorKind.SIGN_BAD_CERT


def test_archive_without_private_key_is_sign_bad_cert(pki: Any, tmp_path: Path) -> None:
    data = pkcs12.serialize_key_and_certificates(
        name=b"cert-only",
        key=None,
        cert=pki.signer_a.cert,
        cas=None,
        encryption_algorithm=serialization.NoEncryption(),
    )
    path = tmp_path / "cert-only.p12"
    path.write_bytes(data)
    with pytest.raises(ChefError) as exc:
        load_pfx(path, None)
    assert exc.value.kind is ErrorKind.SIGN_BAD_CERT


def test_missing_file_is_file_not_found(tmp_path: Path) -> None:
    with pytest.raises(ChefError) as exc:
        load_pfx(tmp_path / "nope.pfx", PASSWORD_A)
    assert exc.value.kind is ErrorKind.FILE_NOT_FOUND
