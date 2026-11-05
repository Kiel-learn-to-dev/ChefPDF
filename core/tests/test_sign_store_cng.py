"""T4.11: signing with a certificate from the Windows personal store through CNG (I8).

Windows only. The test creates a throwaway self-signed certificate in the current user's personal
store with PowerShell, signs a PDF through sign.padesStore, reads the file back with pyHanko, and
removes the certificate again. Other platforms skip the module.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from conftest import Harness, RpcFailure, make_numbered_pdf
from cryptography import x509
from signing_support import validate_pdf_signatures

pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="Windows certificate store only")


def _ps(script: str) -> str:
    done = subprocess.run(
        # pwsh (PowerShell 7) has the Cert: drive; Windows PowerShell 5.1 may not (see NOTES).
        [shutil.which("pwsh") or "powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True,
        text=True,
        timeout=120,
        check=True,
    )
    return done.stdout.strip()


@pytest.fixture
def store_cert(tmp_path: Path) -> Iterator[tuple[str, x509.Certificate]]:
    subject = f"ChefPDF CNG test {uuid.uuid4().hex[:8]}"
    thumb = (
        _ps(
            f"$c = New-SelfSignedCertificate -Subject 'CN={subject}' "
            r"-CertStoreLocation Cert:\CurrentUser\My -KeyUsage DigitalSignature "
            "-KeyAlgorithm RSA -KeyLength 2048 -NotAfter (Get-Date).AddDays(30); "
            "$c.Thumbprint"
        )
        .splitlines()[-1]
        .strip()
    )
    cer = tmp_path / "cng-test.cer"
    _ps(
        rf"Export-Certificate -Cert Cert:\CurrentUser\My\{thumb} "
        rf"-FilePath '{cer}' -Type CERT | Out-Null"
    )
    cert = x509.load_der_x509_certificate(cer.read_bytes())
    try:
        yield thumb, cert
    finally:
        _ps(rf"Remove-Item -Path Cert:\CurrentUser\My\{thumb} -ErrorAction SilentlyContinue")


def _open(harness: Harness, tmp_path: Path) -> str:
    sample = make_numbered_pdf(tmp_path / f"cng-{uuid.uuid4().hex[:8]}.pdf", 1)
    return str(harness.open(sample)["state"]["sessionId"])


def test_listing_shows_the_certificate_with_its_private_key(
    harness: Harness, store_cert: tuple[str, x509.Certificate]
) -> None:
    thumb, _ = store_cert
    data: dict[str, Any] = harness.op("sign.listStoreCertificates", {"store": "MY"})["data"]
    row = next(c for c in data["certificates"] if c["thumbprint"] == thumb)
    assert row["hasPrivateKey"] is True
    assert "ChefPDF CNG test" in row["subject"]


def test_signing_with_the_store_key_makes_a_valid_signature(
    harness: Harness,
    tmp_path: Path,
    store_cert: tuple[str, x509.Certificate],
) -> None:
    thumb, cert = store_cert
    sid = _open(harness, tmp_path)
    result = harness.op("sign.padesStore", {"thumbprint": thumb}, sid)
    assert result["state"]["signed"] is True
    saved = tmp_path / "signed-cng.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(saved)})
    [sig] = validate_pdf_signatures(saved, cert).signatures
    assert sig.intact and sig.valid and sig.trusted


def test_an_unknown_thumbprint_is_refused(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, tmp_path)
    with pytest.raises(RpcFailure):
        harness.op("sign.padesStore", {"thumbprint": "0" * 40}, sid)
