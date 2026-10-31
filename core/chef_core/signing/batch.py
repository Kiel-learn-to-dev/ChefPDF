"""Batch signing helpers (T3.13, I31, I32): output names, source preparation and outcomes.

These are the parts of ``sign.batch`` that do not depend on how the signer or the placement was
chosen (ops/sign_batch.py does that). Nothing here logs or keeps a password or a PIN.

- ``resolve_output_path``: where a result goes. Names never overwrite a file that exists:
  ``name.pdf``, then ``name (2).pdf``, ``name (3).pdf``…
- ``prepare_source``: an encrypted input is opened with its password and decrypted into a
  working copy. A document that carries signatures cannot be re-saved without breaking them, so
  an encrypted document with signatures is refused.
- ``verify_output``: the check of ``verifyAfter`` (the same engine as sign.verifyFile).
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from chef_core.errors import ChefError, ErrorKind
from chef_core.pdf.io import atomic_copy, open_pdf
from chef_core.pdf.outnames import (
    OutputMode,
    OutputRule,
    common_folder,
    resolve_output_path,
)
from chef_core.session.info import has_signatures
from chef_core.signing.trust import default_trust_store, load_trust_paths
from chef_core.signing.verify import VerifyOptions, verify_document

__all__ = [
    "OutputMode",
    "OutputRule",
    "common_folder",
    "resolve_output_path",
]
STATUS_ORDER = ("invalid", "unknown", "valid-with-warnings", "valid")
ENCRYPTED_NOTE = (
    "The input was encrypted: the output is not encrypted (signing needs the plain document)."
)


def prepare_source(source: Path, password: str | None, work_dir: Path) -> tuple[Path, bool]:
    """The file to sign for ``source``: (path, was_encrypted).

    An unencrypted source is returned as it is (it is only read). An encrypted one is decrypted
    into ``work_dir``. Errors: PASSWORD_REQUIRED, PASSWORD_INVALID, FILE_NOT_FOUND, INVALID_PDF,
    and BLOCKED_BY_SIGNATURE for an encrypted document that already carries signatures.
    """
    with open_pdf(source, password) as pdf:
        if not pdf.is_encrypted:
            return source, False
        if has_signatures(pdf):
            raise ChefError(
                ErrorKind.BLOCKED_BY_SIGNATURE,
                "An encrypted document with signatures cannot be signed: re-saving it would "
                "break its signatures",
                {"path": str(source)},
            )
        decrypted = work_dir / "decrypted.pdf"
        pdf.save(decrypted, encryption=False)
    return decrypted, True


def copy_to_target(work_file: Path, target: Path) -> None:
    """Publish a finished result: an atomic replace, so the target is never half written."""
    atomic_copy(work_file, target)


def worst_status(statuses: Sequence[str]) -> str:
    for status in STATUS_ORDER:
        if status in statuses:
            return status
    return "unknown"


def verify_output(
    path: Path, field_names: Sequence[str], extra_trust_paths: Sequence[str]
) -> dict[str, Any]:
    """``{status, reasons}`` of the signatures added in ``field_names`` (the worst one)."""
    options = VerifyOptions(
        trust=default_trust_store(),
        extra_trust_roots=load_trust_paths(list(extra_trust_paths)),
        check_revocation="soft",
        allow_offline=True,
        timeout_seconds=15,
    )
    report = verify_document(path, options)
    wanted = [s for s in report["signatures"] if s["fieldName"] in field_names]
    if not wanted:
        return {"status": "unknown", "reasons": []}
    reasons: list[str] = []
    for sig in wanted:
        for reason in sig["reasons"]:
            if reason not in reasons:
                reasons.append(reason)
    return {"status": worst_status([s["status"] for s in wanted]), "reasons": reasons}


@dataclass
class FileOutcome:
    """What happened to one input file. ``to_wire`` is the result item the UI reads."""

    path: str
    status: Literal["signed", "failed", "skipped"] = "failed"
    output_path: str | None = None
    error_kind: str | None = None
    message: str | None = None
    field_name: str | None = None
    page: int | None = None
    verification: dict[str, Any] | None = None
    warnings: list[str] = field(default_factory=list)

    def to_wire(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "outputPath": self.output_path,
            "status": self.status,
            "errorKind": self.error_kind,
            "message": self.message,
            "fieldName": self.field_name,
            "page": self.page,
            "verification": self.verification,
            "warnings": list(self.warnings),
        }


def failure_of(path: str, exc: ChefError) -> FileOutcome:
    return FileOutcome(path=path, status="failed", error_kind=exc.kind.value, message=exc.message)


def skipped(path: str, message: str) -> FileOutcome:
    return FileOutcome(path=path, status="skipped", message=message)
