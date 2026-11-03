"""T3.13 batch signing (I31, I32): sign.batch with one signer, many files, placement, outputs.

Files are signed by the real PAdES engine; PFX signers use the test PKI, token signers the fake
backend (login counted). Every output is checked with pyHanko's validator.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pikepdf
import pytest
from conftest import Harness, RpcFailure, make_numbered_pdf
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from signing_support import PASSWORD_A, PASSWORD_B, validate_pdf_signatures
from token_support import (
    FakeBackend,
    FakeCert,
    FakeSlot,
    FakeToken,
    fake_cert_chain,
    make_module_file,
    windows_environment,
)

from chef_core.signing.pkcs11 import use_backend

SECRET_PIN = "BATCH-PIN-8123"
FILE_PASSWORD = "FILE-PW-LEAK-7741"
CERT_ID = "01"
REPO_ROOT = Path(__file__).resolve().parents[2]
FONT = REPO_ROOT / "tests" / "corpus" / "fonts" / "BeVietnamPro-Regular.ttf"


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
def token_module(tmp_path: Path, backend: FakeBackend, pki: Any) -> str:
    path = make_module_file(tmp_path, "batch-token.dll")
    token = FakeToken(pin=SECRET_PIN)
    token.certs = [
        FakeCert(
            cka_id=bytes.fromhex(CERT_ID), certificate=pki.signer_a.cert, key=pki.signer_a.key
        ),
        *fake_cert_chain(pki.inter.cert, pki.root.cert),
    ]
    backend.add_module(path, FakeSlot(slot_id=0, token=token, description="Batch reader"))
    return path


def _pdfs(tmp_path: Path, count: int, prefix: str = "doc") -> list[Path]:
    folder = tmp_path / f"{prefix}-{uuid.uuid4().hex[:6]}"
    folder.mkdir()
    return [make_numbered_pdf(folder / f"{prefix}{i:02d}.pdf", 2) for i in range(count)]


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _pfx_signer(pki: Any, password: str = PASSWORD_A) -> dict[str, Any]:
    return {"kind": "pfx", "pfxPath": str(pki.pfx_a()), "password": password}


def _batch(
    harness: Harness,
    files: list[Path],
    signer: dict[str, Any],
    **extra: Any,
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "files": [{"path": str(p)} for p in files],
        "signer": signer,
        **extra,
    }
    data: dict[str, Any] = harness.op("sign.batch", params)["data"]
    return data


def _widgets(path: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    with pikepdf.open(path) as pdf:
        for field in pdf.Root.AcroForm.Fields:
            if field.get("/FT") == pikepdf.Name.Sig:
                out.append(
                    {
                        "name": str(field.get("/T")),
                        "rect": [float(v) for v in field.get("/Rect", [])],
                    }
                )
    return out


def _page_sizes(path: Path) -> list[tuple[float, float]]:
    with pikepdf.open(path) as pdf:
        return [
            (
                float(p.mediabox[2]) - float(p.mediabox[0]),
                float(p.mediabox[3]) - float(p.mediabox[1]),
            )
            for p in pdf.pages
        ]


# -- basic behaviour -----------------------------------------------------------------------


def test_batch_signs_each_file_and_writes_suffixed_outputs(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    files = _pdfs(tmp_path, 3)
    before = {p: _digest(p) for p in files}
    data = _batch(harness, files, _pfx_signer(pki), common={"reason": "Duyệt"})
    assert (data["signed"], data["failed"], data["skipped"]) == (3, 0, 0)
    assert data["openFolder"] == str(files[0].parent)
    for item in data["results"]:
        assert item["status"] == "signed"
        assert item["errorKind"] is None
        assert item["fieldName"] == "Signature1"
        assert item["verification"] is None
        out = Path(item["outputPath"])
        assert out.name == Path(item["path"]).stem + "_signed.pdf"
        assert validate_pdf_signatures(out, pki.root.cert).signatures[0].valid
    assert {p: _digest(p) for p in files} == before, "inputs must never change in suffix mode"


def test_ten_small_files_with_one_pfx_finish_in_under_ten_seconds(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    files = _pdfs(tmp_path, 10, prefix="perf")
    started = time.perf_counter()
    data = _batch(harness, files, _pfx_signer(pki))
    elapsed = time.perf_counter() - started
    assert data["signed"] == 10
    assert elapsed < 10.0, f"10 files took {elapsed:.1f}s"


def test_folder_mode_writes_into_the_folder_and_creates_it(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    files = _pdfs(tmp_path, 2)
    target = tmp_path / "out-folder" / "nested"
    data = _batch(
        harness, files, _pfx_signer(pki), output={"mode": "folder", "folder": str(target)}
    )
    assert data["openFolder"] == str(target)
    assert sorted(Path(r["outputPath"]).name for r in data["results"]) == [
        f"{p.stem}.pdf" for p in files
    ]
    assert all(Path(r["outputPath"]).parent == target for r in data["results"])


def test_output_names_never_overwrite_existing_files(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    folder_a = tmp_path / "a"
    folder_b = tmp_path / "b"
    folder_a.mkdir()
    folder_b.mkdir()
    first = make_numbered_pdf(folder_a / "same.pdf", 1)
    second = make_numbered_pdf(folder_b / "same.pdf", 1)
    out = tmp_path / "out"
    out.mkdir()
    (out / "same.pdf").write_bytes(b"keep me")
    data = _batch(
        harness, [first, second], _pfx_signer(pki), output={"mode": "folder", "folder": str(out)}
    )
    names = [Path(r["outputPath"]).name for r in data["results"]]
    assert names == ["same (2).pdf", "same (3).pdf"]
    assert (out / "same.pdf").read_bytes() == b"keep me"


def test_suffix_collision_gets_a_number(harness: Harness, pki: Any, tmp_path: Path) -> None:
    [src] = _pdfs(tmp_path, 1)
    (src.parent / f"{src.stem}_signed.pdf").write_bytes(b"old")
    data = _batch(harness, [src], _pfx_signer(pki))
    assert Path(data["results"][0]["outputPath"]).name == f"{src.stem}_signed (2).pdf"
    assert (src.parent / f"{src.stem}_signed.pdf").read_bytes() == b"old"


def test_overwrite_mode_replaces_the_input_atomically(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    [src] = _pdfs(tmp_path, 1)
    before = _digest(src)
    data = _batch(harness, [src], _pfx_signer(pki), output={"mode": "overwrite"})
    assert data["results"][0]["outputPath"] == str(src)
    assert _digest(src) != before
    assert validate_pdf_signatures(src, pki.root.cert).signatures[0].valid
    leftovers = [p for p in src.parent.iterdir() if p.name.endswith(".tmp")]
    assert leftovers == []


def test_already_signed_files_get_an_approval_signature(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    [src] = _pdfs(tmp_path, 1)
    first = harness.open(src)["state"]["sessionId"]
    harness.op("sign.pades", {"pfxPath": str(pki.pfx_b()), "password": PASSWORD_B}, first)
    signed = tmp_path / "already.pdf"
    harness.call("session.save", {"sessionId": first, "path": str(signed)})

    data = _batch(harness, [signed], _pfx_signer(pki))
    assert data["results"][0]["status"] == "signed"
    assert data["results"][0]["fieldName"] == "Signature2"
    out = Path(data["results"][0]["outputPath"])
    sigs = validate_pdf_signatures(out, pki.root.cert).signatures
    assert [s.field for s in sigs] == ["Signature1", "Signature2"]
    assert all(s.intact and s.valid for s in sigs)


def test_certified_file_refuses_a_signature_and_the_batch_goes_on(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    locked, free = _pdfs(tmp_path, 2)
    sid = harness.open(locked)["state"]["sessionId"]
    harness.op(
        "sign.pades",
        {"pfxPath": str(pki.pfx_b()), "password": PASSWORD_B, "certify": "no-changes"},
        sid,
    )
    certified = tmp_path / "certified.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(certified)})
    before = _digest(certified)

    data = _batch(harness, [certified, free], _pfx_signer(pki))
    first, second = data["results"]
    assert first["status"] == "failed"
    assert first["errorKind"] == "BLOCKED_BY_SIGNATURE"
    assert second["status"] == "signed"
    assert _digest(certified) == before


def test_stop_on_error_skips_the_remaining_files(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    good_a, bad, good_b = _pdfs(tmp_path, 3)
    sid = harness.open(bad)["state"]["sessionId"]
    harness.op(
        "sign.pades",
        {"pfxPath": str(pki.pfx_b()), "password": PASSWORD_B, "certify": "no-changes"},
        sid,
    )
    certified = tmp_path / "stop-certified.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(certified)})

    data = _batch(harness, [good_a, certified, good_b], _pfx_signer(pki), stopOnError=True)
    statuses = [r["status"] for r in data["results"]]
    assert statuses == ["signed", "failed", "skipped"]
    assert (data["signed"], data["failed"], data["skipped"]) == (1, 1, 1)
    assert data["results"][2]["outputPath"] is None


def test_wrong_pfx_password_fails_the_whole_job_before_any_file(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    files = _pdfs(tmp_path, 2)
    with pytest.raises(RpcFailure) as exc:
        _batch(harness, files, _pfx_signer(pki, password="sai-mat-khau-batch"))
    assert exc.value.kind == "SIGN_BAD_PASSWORD"
    assert not list(files[0].parent.glob("*_signed.pdf"))


def test_cancel_stops_between_files(harness: Harness, pki: Any, tmp_path: Path) -> None:
    files = _pdfs(tmp_path, 20, prefix="cancel")
    params = {
        "files": [{"path": str(p)} for p in files],
        "signer": _pfx_signer(pki),
    }
    job = harness.start_op("sign.batch", params)
    harness.out.wait_for(
        lambda m: (
            m.get("method") == "job.progress"
            and m["params"]["jobId"] == job
            and m["params"]["done"] >= 1
        ),
        timeout=60,
    )
    harness.call("jobs.cancel", {"jobId": job})
    terminal = harness.wait_job(job)
    assert terminal["method"] == "job.cancelled"
    written = [p for p in files[0].parent.glob("*_signed.pdf")]
    assert len(written) < len(files)


# -- placement -----------------------------------------------------------------------------


def test_rect_placement_draws_the_box_on_each_file(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    files = _pdfs(tmp_path, 2)
    rect = [72.0, 600.0, 272.0, 680.0]
    data = _batch(
        harness, files, _pfx_signer(pki), placement={"kind": "rect", "page": 1, "rect": rect}
    )
    assert all(r["page"] == 1 for r in data["results"])
    for item in data["results"]:
        assert _widgets(Path(item["outputPath"])) == [{"name": "Signature1", "rect": rect}]


def test_fixed_placement_uses_the_last_page_and_the_margin(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    [src] = _pdfs(tmp_path, 1)
    data = _batch(
        harness,
        [src],
        _pfx_signer(pki),
        placement={
            "kind": "fixed",
            "corner": "bottom-right",
            "width": 60,
            "height": 70,
            "margin": 10,
            "page": "last",
        },
    )
    item = data["results"][0]
    assert item["status"] == "signed", item
    assert item["page"] == 1
    width, _height = _page_sizes(src)[1]
    [widget] = _widgets(Path(item["outputPath"]))
    x1, y1, x2, y2 = widget["rect"]
    assert x2 == pytest.approx(width - 10, abs=1)
    assert x1 == pytest.approx(width - 10 - 60, abs=1)
    assert y1 == pytest.approx(10, abs=1)
    assert y2 == pytest.approx(10 + 70, abs=1)


def test_fixed_placement_on_a_missing_page_fails_only_that_file(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    files = _pdfs(tmp_path, 2)
    data = _batch(
        harness,
        files,
        _pfx_signer(pki),
        placement={
            "kind": "fixed",
            "corner": "top-left",
            "width": 100,
            "height": 40,
            "margin": 20,
            "page": 9,
        },
    )
    assert [r["status"] for r in data["results"]] == ["failed", "failed"]
    assert data["results"][0]["errorKind"] == "INVALID_PARAMS"


def _text_pdf(path: Path, lines: list[tuple[int, float, float, str]]) -> Path:
    """Pages of Be Vietnam Pro text: (page count fixed at max index + 1)."""
    if "BeVietnamPro" not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont("BeVietnamPro", str(FONT)))
    pages = max(page for page, *_ in lines) + 1
    c = canvas.Canvas(str(path), pagesize=A4)
    for index in range(pages):
        c.setFont("BeVietnamPro", 14)
        for page, x, y, text in lines:
            if page == index:
                c.drawString(x, y, text)
        c.showPage()
    c.save()
    return path


def test_anchor_placement_puts_the_box_below_the_text(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    src = _text_pdf(tmp_path / "anchor.pdf", [(0, 100.0, 300.0, "NGƯỜI KÝ")])
    data = _batch(
        harness,
        [src],
        _pfx_signer(pki),
        placement={
            "kind": "anchor",
            "text": "NGƯỜI KÝ",
            "position": "below",
            "width": 150,
            "height": 60,
            "align": "left",
        },
    )
    item = data["results"][0]
    assert item["status"] == "signed"
    assert item["page"] == 0
    [widget] = _widgets(Path(item["outputPath"]))
    x1, _y1, _x2, y2 = widget["rect"]
    assert x1 == pytest.approx(100.0, abs=3)
    assert y2 < 300.0
    assert y2 == pytest.approx(300.0 - 4.0, abs=8)


def test_anchor_all_matches_signs_once_per_match(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    src = _text_pdf(
        tmp_path / "many.pdf",
        [(0, 100.0, 300.0, "NGƯỜI KÝ"), (1, 100.0, 500.0, "NGƯỜI KÝ")],
    )
    data = _batch(
        harness,
        [src],
        _pfx_signer(pki),
        placement={
            "kind": "anchor",
            "text": "người ký",
            "position": "over",
            "width": 120,
            "height": 50,
            "whichMatch": "all",
        },
    )
    item = data["results"][0]
    assert item["status"] == "signed"
    names = [w["name"] for w in _widgets(Path(item["outputPath"]))]
    assert names == ["Signature1", "Signature2"]
    assert item["fieldName"] == "Signature1"
    assert item["page"] == 0


def test_anchor_missing_skips_by_default_and_can_fail_or_fall_back(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    src = _text_pdf(tmp_path / "noanchor.pdf", [(0, 100.0, 300.0, "Nội dung")])
    base = {"kind": "anchor", "text": "GIÁM ĐỐC", "position": "below", "width": 120, "height": 40}

    skip = _batch(harness, [src], _pfx_signer(pki), placement=base)["results"][0]
    assert skip["status"] == "skipped"
    assert skip["message"]

    fail = _batch(harness, [src], _pfx_signer(pki), placement={**base, "onMissing": "fail"})[
        "results"
    ][0]
    assert fail["status"] == "failed"
    assert fail["errorKind"] == "INVALID_PARAMS"

    fallback = _batch(
        harness,
        [src],
        _pfx_signer(pki),
        placement={
            **base,
            "onMissing": "fallback-fixed",
            "fallbackCorner": "bottom-right",
            "fallbackPage": "last",
            "fallbackMargin": 30,
        },
    )["results"][0]
    assert fallback["status"] == "signed"
    width, _ = _page_sizes(src)[0]
    [widget] = _widgets(Path(fallback["outputPath"]))
    assert widget["rect"][2] == pytest.approx(width - 30, abs=1)


def test_invisible_placement_draws_no_box(harness: Harness, pki: Any, tmp_path: Path) -> None:
    [src] = _pdfs(tmp_path, 1)
    data = _batch(harness, [src], _pfx_signer(pki), placement={"kind": "invisible"})
    item = data["results"][0]
    assert item["status"] == "signed"
    assert item["page"] is None
    for widget in _widgets(Path(item["outputPath"])):
        x1, y1, x2, y2 = widget["rect"]
        assert x2 - x1 == 0 and y2 - y1 == 0


def test_invalid_batch_params_are_rejected_before_any_file(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    files = _pdfs(tmp_path, 1)
    base: dict[str, Any] = {"files": [{"path": str(files[0])}], "signer": _pfx_signer(pki)}
    cases: list[dict[str, Any]] = [
        {"placement": {"kind": "teleport"}},
        {"placement": {"kind": "rect", "page": 0, "rect": [10, 10, 5, 5]}},
        {"output": {"mode": "folder"}},
        {"common": {"level": "B-T"}},
        {"files": []},
    ]
    for extra in cases:
        with pytest.raises(RpcFailure) as exc:
            harness.op("sign.batch", {**base, **extra})
        assert exc.value.kind == "INVALID_PARAMS", extra
    assert not list(files[0].parent.glob("*_signed.pdf"))


# -- verification after signing ------------------------------------------------------------


def test_verify_after_reports_each_output(harness: Harness, pki: Any, tmp_path: Path) -> None:
    files = _pdfs(tmp_path, 2)
    trusted = _batch(
        harness,
        files,
        _pfx_signer(pki),
        verifyAfter=True,
        common={"trustRootPaths": [str(pki.root_pem)]},
    )
    for item in trusted["results"]:
        assert item["verification"] == {"status": "valid", "reasons": []}

    untrusted_files = _pdfs(tmp_path, 1, prefix="untrusted")
    untrusted = _batch(harness, untrusted_files, _pfx_signer(pki), verifyAfter=True)
    verification = untrusted["results"][0]["verification"]
    assert verification["status"] == "unknown"
    assert "CERT_UNTRUSTED" in verification["reasons"]


# -- token signer ----------------------------------------------------------------------------


def _token_signer(module: str, **overrides: Any) -> dict[str, Any]:
    signer: dict[str, Any] = {
        "kind": "token",
        "modulePath": module,
        "slotId": 0,
        "certId": CERT_ID,
        "pin": SECRET_PIN,
    }
    signer.update(overrides)
    return signer


def test_token_batch_logs_in_exactly_once_for_ten_files(
    harness: Harness, backend: FakeBackend, token_module: str, tmp_path: Path
) -> None:
    files = _pdfs(tmp_path, 10, prefix="token")
    data = _batch(harness, files, _token_signer(token_module))
    assert data["signed"] == 10
    assert len(backend.login_attempts) == 1
    assert backend.open_sessions == backend.closed_sessions == 1


def test_token_wrong_pin_stops_the_batch_without_retry(
    harness: Harness, backend: FakeBackend, token_module: str, tmp_path: Path
) -> None:
    files = _pdfs(tmp_path, 4, prefix="pin")
    data = _batch(harness, files, _token_signer(token_module, pin="0000"))
    assert [r["status"] for r in data["results"]] == ["failed", "skipped", "skipped", "skipped"]
    assert data["results"][0]["errorKind"] == "TOKEN_PIN_INVALID"
    assert len(backend.login_attempts) == 1
    assert backend.open_sessions == 0
    assert backend.closed_sessions == 0


def test_token_batch_uses_the_template_and_certify(
    harness: Harness, backend: FakeBackend, token_module: str, pki: Any, tmp_path: Path
) -> None:
    files = _pdfs(tmp_path, 2, prefix="tpl")
    template = {"lines": [{"source": "signerName", "label": "Người ký:"}]}
    data = _batch(
        harness,
        files,
        _token_signer(token_module),
        placement={"kind": "rect", "page": 0, "rect": [72, 600, 272, 680]},
        common={"template": template, "certify": "no-changes"},
    )
    assert data["signed"] == 2
    out = Path(data["results"][0]["outputPath"])
    assert validate_pdf_signatures(out, pki.root.cert).signatures[0].valid
    assert _widgets(out) == [{"name": "Signature1", "rect": [72.0, 600.0, 272.0, 680.0]}]


# -- encrypted inputs --------------------------------------------------------------------------


def _encrypted_pdf(path: Path, password: str) -> Path:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    pdf.save(path, encryption=pikepdf.Encryption(user=password, owner=password, R=6))
    return path


def test_encrypted_input_needs_its_password(harness: Harness, pki: Any, tmp_path: Path) -> None:
    locked = _encrypted_pdf(tmp_path / "locked.pdf", FILE_PASSWORD)
    data = _batch(harness, [locked], _pfx_signer(pki))
    assert data["results"][0]["status"] == "failed"
    assert data["results"][0]["errorKind"] == "PASSWORD_REQUIRED"

    wrong = {"path": str(locked), "password": "wrong"}
    bad = harness.op(
        "sign.batch",
        {"files": [wrong], "signer": _pfx_signer(pki)},
    )["data"]
    assert bad["results"][0]["errorKind"] == "PASSWORD_INVALID"


def test_encrypted_input_with_its_password_is_signed(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    locked = _encrypted_pdf(tmp_path / "unlock.pdf", FILE_PASSWORD)
    data = harness.op(
        "sign.batch",
        {
            "files": [{"path": str(locked), "password": FILE_PASSWORD}],
            "signer": _pfx_signer(pki),
        },
    )["data"]
    item = data["results"][0]
    assert item["status"] == "signed"
    out = Path(item["outputPath"])
    assert validate_pdf_signatures(out, pki.root.cert).signatures[0].valid


# -- secrets never leak -------------------------------------------------------------------------


def test_passwords_and_pins_never_reach_results_logs_or_temp_dirs(
    harness: Harness,
    backend: FakeBackend,
    token_module: str,
    pki: Any,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.DEBUG)
    locked = _encrypted_pdf(tmp_path / "secret-in.pdf", FILE_PASSWORD)
    pfx = _pfx_signer(pki)
    ok = harness.op(
        "sign.batch",
        {"files": [{"path": str(locked), "password": FILE_PASSWORD}], "signer": pfx},
    )["data"]
    assert ok["signed"] == 1
    token_ok = _batch(harness, _pdfs(tmp_path, 1, prefix="leak"), _token_signer(token_module))
    assert token_ok["signed"] == 1
    harness.op(
        "sign.batch",
        {"files": [{"path": str(locked), "password": "not-the-password"}], "signer": pfx},
    )
    with pytest.raises(RpcFailure):
        _batch(harness, _pdfs(tmp_path, 1, prefix="leak2"), _pfx_signer(pki, "nope-nope"))
    _batch(harness, _pdfs(tmp_path, 1, prefix="leak3"), _token_signer(token_module, pin="9999"))

    secrets = [PASSWORD_A, FILE_PASSWORD, SECRET_PIN, "nope-nope", "9999", "not-the-password"]
    wire = json.dumps(harness.out.messages, ensure_ascii=False)
    for secret in secrets:
        assert secret not in wire, secret
        assert secret not in caplog.text, secret
    for root in (harness.data_dir, tmp_path):
        for path in root.rglob("*"):
            if path.is_file() and path.suffix not in {".pdf", ".pfx", ".p12", ".dll"}:
                content = path.read_bytes()
                for secret in secrets:
                    assert secret.encode("utf-8") not in content, (secret, path)


def test_progress_is_reported_per_file(harness: Harness, pki: Any, tmp_path: Path) -> None:
    files = _pdfs(tmp_path, 3, prefix="prog")
    job = harness.start_op(
        "sign.batch",
        {"files": [{"path": str(p)} for p in files], "signer": _pfx_signer(pki)},
    )
    harness.wait_job(job)
    progress = [m for m in harness.notifications(job) if m["method"] == "job.progress"]
    assert progress, "no progress reported"
    assert max(m["params"]["total"] for m in progress) == 3
