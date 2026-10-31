"""T4.14 (I36): sign.verifyBatch: verify many files and write a CSV (UTF-8 with BOM) or XLSX report.

Signed files come from the real PAdES engine and the test PKI; the report is read back with the
csv module and with openpyxl. The unsigned and corrupted rows, cancellation and the folder walk
are covered too.
"""

from __future__ import annotations

import csv
import threading
from pathlib import Path
from typing import Any

import openpyxl
import pikepdf
import pytest
from conftest import Harness, RpcFailure
from cryptography.hazmat.primitives import serialization
from signing_support import PASSWORD_A

from chef_core.errors import CancelledError
from chef_core.ops import load_builtin_ops
from chef_core.ops.base import OpContext, get_op

COLUMNS = [
    "file",
    "fieldName",
    "signerName",
    "organization",
    "taxCode",
    "status",
    "reasons",
    "signingTime",
    "level",
    "certValidityEnd",
    "trusted",
    "revocation",
    "modifiedAfterSigning",
]


@pytest.fixture(autouse=True)
def _builtins() -> None:
    load_builtin_ops()


def _blank(path: Path) -> Path:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(300, 400))
    pdf.save(path)
    return path


def _signed(h: Harness, pki: Any, src: Path, target: Path) -> Path:
    sid = str(h.open(src)["state"]["sessionId"])
    h.op(
        "sign.pades",
        {"pfxPath": str(pki.pfx_a()), "password": PASSWORD_A, "reason": "Duyệt"},
        sid,
    )
    h.call("session.save", {"sessionId": sid, "path": str(target)})
    return target


@pytest.fixture
def batch_files(harness: Harness, pki: Any, tmp_path: Path) -> dict[str, Path]:
    blank = _blank(tmp_path / "blank.pdf")
    signed = _signed(harness, pki, blank, tmp_path / "signed.pdf")
    unsigned = _blank(tmp_path / "unsigned.pdf")
    corrupt = tmp_path / "corrupt.pdf"
    corrupt.write_bytes(b"this is not a pdf at all")
    return {"signed": signed, "unsigned": unsigned, "corrupt": corrupt}


def _run(
    h: Harness,
    files: list[Path],
    report: Path,
    **extra: Any,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "files": [{"path": str(f)} for f in files],
        "reportPath": str(report),
        "format": "csv",
    }
    body.update(extra)
    return dict(h.op("sign.verifyBatch", body)["data"])


def _read_csv(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def test_csv_report_has_the_columns_and_vietnamese_text(
    harness: Harness, batch_files: dict[str, Path], tmp_path: Path
) -> None:
    report = tmp_path / "report.csv"
    data = _run(harness, list(batch_files.values()), report)
    assert data["files"] == 3
    assert data["signatures"] == 1
    assert data["reportPath"] == str(report)
    assert data["byStatus"]["unsigned"] == 1 and data["byStatus"]["error"] == 1
    raw = report.read_bytes()
    assert raw.startswith(b"\xef\xbb\xbf")  # BOM so Excel reads the Vietnamese diacritics
    assert raw.decode("utf-8-sig").splitlines()[0].split(",") == COLUMNS
    rows = _read_csv(report)
    signed = next(r for r in rows if r["file"].endswith("signed.pdf"))
    assert signed["signerName"] == "Nguyễn Văn A"
    assert signed["taxCode"] == "0101234567"
    assert signed["fieldName"] != ""
    assert signed["status"] in ("valid", "valid-with-warnings", "invalid", "unknown")
    assert signed["signingTime"] != "" and signed["level"] != ""
    assert signed["certValidityEnd"] != ""
    assert signed["modifiedAfterSigning"] in ("có", "không")


def test_unsigned_and_corrupted_files_get_their_own_rows(
    harness: Harness, batch_files: dict[str, Path], tmp_path: Path
) -> None:
    report = tmp_path / "report.csv"
    _run(harness, [batch_files["unsigned"], batch_files["corrupt"]], report)
    rows = _read_csv(report)
    assert len(rows) == 2
    unsigned = next(r for r in rows if r["file"].endswith("unsigned.pdf"))
    assert unsigned["status"] == "unsigned"
    assert unsigned["fieldName"] == "" and unsigned["signerName"] == ""
    assert "chưa có chữ ký" in unsigned["reasons"]
    corrupt = next(r for r in rows if r["file"].endswith("corrupt.pdf"))
    assert corrupt["status"] == "error"
    assert corrupt["reasons"].startswith("Không đọc được")


def test_missing_file_is_an_error_row_not_a_failed_run(harness: Harness, tmp_path: Path) -> None:
    report = tmp_path / "report.csv"
    data = _run(harness, [tmp_path / "gone.pdf"], report)
    assert data["byStatus"] == {"error": 1}
    assert _read_csv(report)[0]["status"] == "error"


def test_xlsx_report_opens_with_openpyxl_and_has_the_same_rows(
    harness: Harness, batch_files: dict[str, Path], tmp_path: Path
) -> None:
    csv_report = tmp_path / "report.csv"
    xlsx_report = tmp_path / "report.xlsx"
    files = list(batch_files.values())
    _run(harness, files, csv_report)
    data = _run(harness, files, xlsx_report, format="xlsx")
    assert data["reportPath"] == str(xlsx_report)
    workbook = openpyxl.load_workbook(xlsx_report)
    sheet = workbook.active
    assert sheet is not None
    rows = list(sheet.iter_rows(values_only=True))
    assert list(rows[0]) == COLUMNS
    assert len(rows) == 1 + 3
    by_file = {
        str(r[0]): dict(zip(COLUMNS, (str(v or "") for v in r), strict=True)) for r in rows[1:]
    }
    for csv_row in _read_csv(csv_report):
        assert by_file[csv_row["file"]] == csv_row


def test_folder_mode_walks_subfolders_only_when_recursive(
    harness: Harness, batch_files: dict[str, Path], tmp_path: Path
) -> None:
    folder = tmp_path / "scan"
    (folder / "deep").mkdir(parents=True)
    batch_files["unsigned"].replace(folder / "top.pdf")
    batch_files["signed"].replace(folder / "deep" / "inner.pdf")
    report = tmp_path / "flat.csv"
    flat = harness.op(
        "sign.verifyBatch",
        {"folder": str(folder), "reportPath": str(report), "format": "csv"},
        None,
    )["data"]
    assert flat["files"] == 1
    deep = harness.op(
        "sign.verifyBatch",
        {
            "folder": str(folder),
            "recursive": True,
            "reportPath": str(tmp_path / "deep.csv"),
            "format": "csv",
        },
        None,
    )["data"]
    assert deep["files"] == 2 and deep["signatures"] == 1


def test_trust_roots_change_the_trusted_column(
    harness: Harness, batch_files: dict[str, Path], pki: Any, tmp_path: Path
) -> None:
    root_pem = tmp_path / "root.pem"
    root_pem.write_bytes(pki.root.cert.public_bytes(serialization.Encoding.PEM))
    signed = [batch_files["signed"]]
    untrusted = tmp_path / "untrusted.csv"
    _run(harness, signed, untrusted)
    trusted = tmp_path / "trusted.csv"
    _run(harness, signed, trusted, trustRootPaths=[str(root_pem)])
    before = _read_csv(untrusted)[0]["trusted"]
    after = _read_csv(trusted)[0]["trusted"]
    assert before == "không"
    assert after == "có"


def test_cancel_stops_the_run_and_writes_no_report(
    batch_files: dict[str, Path], tmp_path: Path
) -> None:
    spec = get_op("sign.verifyBatch")
    assert spec is not None
    cancel = threading.Event()
    cancel.set()
    ctx = OpContext(job_id="cancel", work_dir=tmp_path, cancel_event=cancel)
    report = tmp_path / "never.csv"
    params = spec.params_model.model_validate(
        {
            "files": [{"path": str(batch_files["signed"])}],
            "reportPath": str(report),
        }
    )
    with pytest.raises(CancelledError):
        spec.run(ctx, params)
    assert not report.exists()


def test_bad_selection_and_format_are_refused(
    harness: Harness, batch_files: dict[str, Path], tmp_path: Path
) -> None:
    both = {
        "files": [{"path": str(batch_files["signed"])}],
        "folder": str(tmp_path),
        "reportPath": str(tmp_path / "x.csv"),
    }
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.verifyBatch", both, None)
    assert exc.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as exc:
        harness.op("sign.verifyBatch", {"reportPath": str(tmp_path / "x.csv")}, None)
    assert exc.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "sign.verifyBatch",
            {
                "files": [{"path": str(batch_files["signed"])}],
                "reportPath": str(tmp_path / "x.pdf"),
                "format": "pdf",
            },
            None,
        )
    assert exc.value.kind == "INVALID_PARAMS"
