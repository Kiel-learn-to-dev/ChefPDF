"""sign.verifyBatch (I36): check many signed PDFs and write one report row per signature.

Each file is checked with the same verifier as sign.verifyFile (signing/verify.py). A file that
cannot be read gets an "error" row; a file with no signature gets an "unsigned" row. The report is
CSV (UTF-8 with a byte order mark, so Excel reads Vietnamese correctly) or XLSX (openpyxl).
Cancelling stops between files and writes nothing.
"""

from __future__ import annotations

import csv
from collections import Counter
from pathlib import Path
from typing import Any, Literal

from openpyxl import Workbook
from openpyxl.styles import Font
from pydantic import Field, model_validator

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.ops.sign_verify import VerifyParams
from chef_core.pdf.io import atomic_write
from chef_core.signing.trust import default_trust_store, load_trust_paths
from chef_core.signing.verify import VerifyOptions, verify_document

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
REVOCATION_TEXT = {
    "good": "không bị thu hồi",
    "revoked": "đã bị thu hồi",
    "unknown": "không xác định",
    "skipped": "không kiểm tra",
}
YES, NO = "có", "không"
MAX_FILES = 5000


class ReportFile(WireModel):
    """A file to check. Encrypted PDFs are reported as errors (no password is used here)."""

    path: str = Field(min_length=1)


class VerifyBatchParams(VerifyParams):
    """Check many PDFs and write the report. Give ``files`` or ``folder``, not both."""

    files: list[ReportFile] | None = Field(default=None, min_length=1, max_length=MAX_FILES)
    folder: str | None = Field(default=None, min_length=1)
    recursive: bool = Field(default=False, description="Folder mode: include subfolders.")
    report_path: str = Field(
        min_length=1, description="Report file to write (replaced atomically)."
    )
    format: Literal["csv", "xlsx"] = Field(default="csv")

    @model_validator(mode="after")
    def _one_source(self) -> VerifyBatchParams:
        if (self.files is None) == (self.folder is None):
            raise ValueError("give exactly one of files or folder")
        return self


def _collect(p: VerifyBatchParams) -> list[Path]:
    if p.files is not None:
        return [Path(f.path).expanduser().absolute() for f in p.files]
    assert p.folder is not None
    base = Path(p.folder).expanduser().absolute()
    if not base.is_dir():
        raise ChefError(
            ErrorKind.FILE_NOT_FOUND,
            "Folder not found",
            {"path": str(base)},
        )
    found = base.rglob("*") if p.recursive else base.glob("*")
    return sorted(f for f in found if f.is_file() and f.suffix.lower() == ".pdf")


def _plain_row(path: Path, status: str, reasons: str) -> dict[str, str]:
    row = {column: "" for column in COLUMNS}
    row["file"] = str(path)
    row["status"] = status
    row["reasons"] = reasons
    return row


def _item_row(path: Path, item: dict[str, Any]) -> dict[str, str]:
    cert: dict[str, Any] = item.get("signerCert") or {}
    identity: dict[str, Any] = cert.get("identity") or {}
    chain: list[dict[str, Any]] = item.get("chain") or []
    reasons = item.get("reasons") or []
    row = {column: "" for column in COLUMNS}
    row["file"] = str(path)
    row["fieldName"] = str(item.get("fieldName") or "")
    row["signerName"] = str(item.get("signerName") or "")
    row["organization"] = str(identity.get("organization") or "")
    row["taxCode"] = str(identity.get("taxCode") or "")
    row["status"] = str(item.get("status") or "")
    row["reasons"] = str(item.get("summaryVi") or "")
    row["signingTime"] = str(item.get("signingTime") or "")
    row["level"] = str(item.get("level") or "")
    row["certValidityEnd"] = str(cert.get("notAfter") or "")
    if chain:
        row["trusted"] = YES if any(r.get("trusted") for r in chain) else NO
    row["revocation"] = "; ".join(
        REVOCATION_TEXT.get(str(r.get("status")), str(r.get("status")))
        for r in item.get("revocation") or []
    )
    row["modifiedAfterSigning"] = YES if "MODIFIED_AFTER_SIGNING" in reasons else NO
    return row


def _rows_for(path: Path, options: VerifyOptions) -> tuple[list[dict[str, str]], int]:
    """Report rows of one file and how many signatures it has (unsigned fields do not count)."""
    try:
        result = verify_document(path, options)
    except ChefError as exc:
        text = f"Không đọc được tệp PDF ({exc.kind.value})."
        return [_plain_row(path, "error", text)], 0
    items: list[dict[str, Any]] = list(result.get("signatures") or [])
    if not items:
        return [_plain_row(path, "unsigned", "Tệp chưa có chữ ký số.")], 0
    signatures = sum(1 for item in items if item.get("status") != "unsigned")
    return [_item_row(path, item) for item in items], signatures


def _write_csv(dest: Path, rows: list[dict[str, str]]) -> None:
    def write(tmp: Path) -> None:
        with tmp.open("w", encoding="utf-8-sig", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=COLUMNS, extrasaction="ignore")
            writer.writeheader()
            writer.writerows(rows)

    atomic_write(dest, write)


def _write_xlsx(dest: Path, rows: list[dict[str, str]]) -> None:
    def write(tmp: Path) -> None:
        book = Workbook()
        sheet = book.active
        assert sheet is not None
        sheet.title = "Kiểm tra chữ ký"
        sheet.append(COLUMNS)
        for cell in sheet[1]:
            cell.font = Font(bold=True)
        for row in rows:
            sheet.append([row.get(column, "") for column in COLUMNS])
        sheet.freeze_panes = "A2"
        book.save(tmp)

    atomic_write(dest, write)


@operation(
    id="sign.verifyBatch",
    title="Verify many files and write a report",
    group="sign",
    params=VerifyBatchParams,
    standalone=True,
)
def verify_batch(ctx: OpContext, p: VerifyBatchParams) -> OpOutput:
    paths = _collect(p)
    if not paths:
        raise invalid_params("No PDF files to check", {"field": "files"})
    options = VerifyOptions(
        trust=default_trust_store(),
        extra_trust_roots=load_trust_paths(p.trust_root_paths),
        check_revocation=p.check_revocation,
        allow_offline=p.allow_offline,
        timeout_seconds=p.timeout_seconds,
    )
    rows: list[dict[str, str]] = []
    signatures = 0
    for path in ctx.steps(paths, len(paths), "Kiểm tra chữ ký"):
        found, count = _rows_for(path, options)
        rows.extend(found)
        signatures += count
    dest = Path(p.report_path).expanduser().absolute()
    ctx.check_cancelled()
    if p.format == "xlsx":
        _write_xlsx(dest, rows)
    else:
        _write_csv(dest, rows)
    by_status = Counter(row["status"] for row in rows)
    return OpOutput(
        changed_pages=[],
        outputs=[str(dest)],
        data={
            "files": len(paths),
            "signatures": signatures,
            "byStatus": dict(by_status),
            "reportPath": str(dest),
        },
    )
