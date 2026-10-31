"""T4.07 op: overlay.bates (F9). Continuous numbers across files, output modes, signed and
encrypted inputs, and stop on error. Standalone: the op opens its own inputs."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
import pytest
from conftest import Harness, RpcFailure

W, H = 300.0, 400.0
BOTTOM_RIGHT = (W / 2, 0.0, W, 60.0)
PASSWORD = "mat-khau-2026"


def _pdf(path: Path, pages: int) -> Path:
    doc = pikepdf.new()
    for _ in range(pages):
        doc.add_blank_page(page_size=(300, 400))
    doc.save(path)
    return path


def _signed_pdf(path: Path, pages: int) -> Path:
    doc = pikepdf.new()
    for _ in range(pages):
        doc.add_blank_page(page_size=(300, 400))
    field = pikepdf.Dictionary(
        FT=pikepdf.Name.Sig,
        T=pikepdf.String("Sig1"),
        V=pikepdf.Dictionary(Type=pikepdf.Name.Sig, Filter=pikepdf.Name("/Adobe.PPKLite")),
    )
    doc.Root.AcroForm = pikepdf.Dictionary(Fields=pikepdf.Array([doc.make_indirect(field)]))
    doc.save(path)
    return path


def _encrypted_pdf(path: Path, pages: int) -> Path:
    doc = pikepdf.new()
    for _ in range(pages):
        doc.add_blank_page(page_size=(300, 400))
    doc.save(path, encryption=pikepdf.Encryption(user=PASSWORD, owner=PASSWORD, R=6))
    return path


Box = tuple[float, float, float, float]


def _region(path: Path, index: int, box: Box, password: str = "") -> str:
    doc = pdfium.PdfDocument(str(path), password=password or None)
    try:
        left, bottom, right, top = box
        return str(doc[index].get_textpage().get_text_bounded(left, bottom, right, top)).strip()
    finally:
        doc.close()


def _pages(path: Path, password: str = "") -> int:
    with pikepdf.open(path, password=password) as doc:
        return len(doc.pages)


def _run(harness: Harness, files: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    params: dict[str, Any] = {"files": files, "prefix": "HS-", "digits": 6}
    params.update(extra)
    return harness.op("overlay.bates", params)


def test_numbers_run_on_across_files_in_order(harness: Harness, tmp_path: Path) -> None:
    a = _pdf(tmp_path / "a.pdf", 2)
    b = _pdf(tmp_path / "b.pdf", 3)
    c = _pdf(tmp_path / "c.pdf", 1)
    result = _run(harness, [{"path": str(a)}, {"path": str(b)}, {"path": str(c)}])
    files = result["data"]["files"]
    spans = [(f["firstNumber"], f["lastNumber"]) for f in files]
    assert spans == [(1, 2), (3, 5), (6, 6)]
    assert all(f["status"] == "done" for f in files)
    assert files[0]["firstLabel"] == "HS-000001" and files[0]["lastLabel"] == "HS-000002"
    assert result["data"]["nextNumber"] == 7
    out_b = Path(files[1]["outputPath"])
    assert out_b.name == "b_bates.pdf"
    assert _region(out_b, 0, BOTTOM_RIGHT) == "HS-000003"
    assert _region(out_b, 2, BOTTOM_RIGHT) == "HS-000005"
    assert _region(Path(files[2]["outputPath"]), 0, BOTTOM_RIGHT) == "HS-000006"


def test_start_number_digits_and_suffix(harness: Harness, tmp_path: Path) -> None:
    a = _pdf(tmp_path / "x.pdf", 2)
    result = _run(
        harness,
        [{"path": str(a)}],
        startNumber=98,
        digits=3,
        prefix="",
        suffix="/VT",
        position="bottom-left",
    )
    first = result["data"]["files"][0]
    assert first["firstLabel"] == "098/VT"
    assert first["lastLabel"] == "099/VT"
    assert _region(Path(first["outputPath"]), 1, (0, 0, W / 2, 60)) == "099/VT"


def test_folder_mode_writes_into_a_new_folder(harness: Harness, tmp_path: Path) -> None:
    (tmp_path / "in").mkdir()
    a = _pdf(tmp_path / "in" / "a.pdf", 1)
    target = tmp_path / "out" / "bates"
    result = _run(harness, [{"path": str(a)}], output={"mode": "folder", "folder": str(target)})
    out = Path(result["data"]["files"][0]["outputPath"])
    assert out.parent == target and out.exists()
    assert _pages(out) == 1


def test_overwrite_mode_replaces_the_input(harness: Harness, tmp_path: Path) -> None:
    a = _pdf(tmp_path / "over.pdf", 1)
    result = _run(harness, [{"path": str(a)}], output={"mode": "overwrite"})
    assert Path(result["data"]["files"][0]["outputPath"]) == a
    assert _region(a, 0, BOTTOM_RIGHT) == "HS-000001"


def test_existing_output_names_get_a_number(harness: Harness, tmp_path: Path) -> None:
    a = _pdf(tmp_path / "dup.pdf", 1)
    _pdf(tmp_path / "dup_bates.pdf", 1)
    result = _run(harness, [{"path": str(a)}])
    assert Path(result["data"]["files"][0]["outputPath"]).name == "dup_bates (2).pdf"


def test_signed_file_fails_and_does_not_use_numbers(harness: Harness, tmp_path: Path) -> None:
    a = _pdf(tmp_path / "one.pdf", 2)
    signed = _signed_pdf(tmp_path / "signed.pdf", 3)
    b = _pdf(tmp_path / "two.pdf", 1)
    result = _run(harness, [{"path": str(a)}, {"path": str(signed)}, {"path": str(b)}])
    files = result["data"]["files"]
    assert files[1]["status"] == "failed"
    assert files[1]["errorKind"] == "BLOCKED_BY_SIGNATURE"
    assert (files[2]["firstNumber"], files[2]["lastNumber"]) == (3, 3)
    assert not (tmp_path / "signed_bates.pdf").exists()


def test_encrypted_file_needs_its_password(harness: Harness, tmp_path: Path) -> None:
    locked = _encrypted_pdf(tmp_path / "locked.pdf", 2)
    result = _run(
        harness,
        [{"path": str(locked)}, {"path": str(locked), "password": PASSWORD}],
    )
    first, second = result["data"]["files"]
    assert first["status"] == "failed" and first["errorKind"] == "PASSWORD_REQUIRED"
    assert second["status"] != "failed"
    out = Path(second["outputPath"])
    assert _pages(out) == 2  # the output is written without encryption
    assert _region(out, 1, BOTTOM_RIGHT) == "HS-000002"
    assert any("encrypted" in w.lower() for w in second["warnings"])


def test_wrong_password_fails_only_that_file(harness: Harness, tmp_path: Path) -> None:
    locked = _encrypted_pdf(tmp_path / "locked2.pdf", 1)
    result = _run(harness, [{"path": str(locked), "password": "sai"}])
    assert result["data"]["files"][0]["errorKind"] == "PASSWORD_INVALID"


def test_missing_file_is_reported_per_file(harness: Harness, tmp_path: Path) -> None:
    a = _pdf(tmp_path / "ok.pdf", 1)
    result = _run(harness, [{"path": str(tmp_path / "nope.pdf")}, {"path": str(a)}])
    files = result["data"]["files"]
    assert files[0]["errorKind"] == "FILE_NOT_FOUND"
    assert files[1]["firstNumber"] == 1


def test_stop_on_error_skips_the_rest(harness: Harness, tmp_path: Path) -> None:
    signed = _signed_pdf(tmp_path / "s.pdf", 1)
    a = _pdf(tmp_path / "later.pdf", 1)
    result = _run(harness, [{"path": str(signed)}, {"path": str(a)}], stopOnError=True)
    files = result["data"]["files"]
    assert files[0]["status"] == "failed"
    assert files[1]["status"] == "skipped"
    assert not (tmp_path / "later_bates.pdf").exists()


def test_bates_overlay_is_tagged_and_listable(harness: Harness, tmp_path: Path) -> None:
    a = _pdf(tmp_path / "tag.pdf", 1)
    result = _run(harness, [{"path": str(a)}])
    out = Path(result["data"]["files"][0]["outputPath"])
    with pikepdf.open(out) as doc:
        contents = doc.pages[0].obj.Contents
        streams = list(contents) if isinstance(contents, pikepdf.Array) else [contents]
        raw = b"\n".join(bytes(s.read_bytes()) for s in streams)
    assert b"/Kind (number)" in raw


def test_invalid_output_mode_is_rejected(harness: Harness, tmp_path: Path) -> None:
    a = _pdf(tmp_path / "bad.pdf", 1)
    with pytest.raises(RpcFailure) as exc:
        _run(harness, [{"path": str(a)}], output={"mode": "folder"})
    assert exc.value.code == -32602
