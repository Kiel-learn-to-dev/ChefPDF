"""Batch export (milestone v0.10, N7): ``export.batch`` exports many PDFs in one format.

Each file gets its own private :class:`SessionManager` under the job's work folder. The file is
opened in that session, the export operation runs on it through the same path as ``ops.run``,
then the session and its manager are closed and the work folder is removed. Nothing is left
behind, also after an error or a cancel.

``format`` is an export format (``export.document``) or ``pdf`` for the refreshed PDF of N6
(``export.refresh``). Outputs are named after the source (suffix or folder mode, see
``chef_core/export/names.py``); an existing file is never overwritten. Per file: status (done or
failed or skipped), outputs, warnings, errorKind and message. A failed file does not stop the run
unless ``stopOnError`` is set; the remaining files are then skipped.

Standalone: the operation takes paths and passwords, like ``overlay.bates`` and ``workflow.run``.
"""

from __future__ import annotations

import contextlib
import shutil
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, model_validator

from chef_core.errors import CancelledError, ChefError, ErrorKind, to_chef_error
from chef_core.export.names import OutputRule, target_for
from chef_core.export.options import ExportOptions
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, get_op, operation
from chef_core.ops.export import ExportDocumentParams, ExportRefreshParams
from chef_core.session.manager import SessionManager

MAX_FILES = 1000
CLOSE_WAIT = 5.0
FILE_PASSWORD_DOC = "Password of this PDF, when it is encrypted. Never stored or echoed back."
BatchFormat = Literal["md", "html", "txt", "json", "epub", "odt", "xlsx", "docx", "pdf"]


class BatchExportFile(WireModel):
    path: str = Field(min_length=1, max_length=1024, description="PDF to export.")
    password: str | None = Field(default=None, repr=False, description=FILE_PASSWORD_DOC)


class BatchExportOutput(WireModel):
    mode: Literal["suffix", "folder"] = Field(
        default="suffix",
        description="suffix: next to each input, name + suffix. folder: all into one folder.",
    )
    suffix: str = Field(default="_export", max_length=40)
    folder: str | None = Field(default=None, min_length=1, max_length=1024)

    @model_validator(mode="after")
    def _consistent(self) -> BatchExportOutput:
        if self.mode == "folder" and not self.folder:
            raise ValueError("folder mode needs a folder")
        if any(ch in self.suffix for ch in "/\\"):
            raise ValueError("suffix must not contain a path separator")
        return self


class ExportBatchParams(WireModel):
    files: list[BatchExportFile] = Field(min_length=1, max_length=MAX_FILES)
    format: BatchFormat = Field(description="An export format, or 'pdf' for the refreshed PDF.")
    options: ExportOptions = Field(default_factory=ExportOptions)
    output: BatchExportOutput = Field(default_factory=BatchExportOutput)
    stop_on_error: bool = Field(default=False)


def _row(path: str, status: str, **extra: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "path": path,
        "status": status,
        "outputPath": None,
        "outputs": [],
        "warnings": [],
        "errorKind": None,
        "message": None,
    }
    row.update(extra)
    return row


def _close(manager: SessionManager, session_id: str | None) -> None:
    """Close the session and its executor, then wait until the manager has forgotten it."""
    if session_id is not None:
        with contextlib.suppress(ChefError, OSError, TimeoutError):
            manager.close(session_id).result(timeout=CLOSE_WAIT)
    manager.close_all(timeout=CLOSE_WAIT)
    manager.stop_executors(wait=True)


def _export_one(
    ctx: OpContext,
    index: int,
    entry: BatchExportFile,
    p: ExportBatchParams,
    rule: OutputRule,
    reserved: set[str],
) -> dict[str, Any]:
    source = Path(entry.path).expanduser().absolute()
    folder = ctx.work_dir / f"export-{index}"
    folder.mkdir(parents=True, exist_ok=True)
    manager = SessionManager(folder / "sessions")
    session_id: str | None = None
    try:
        target = target_for(source, p.format, rule, reserved)
        opened = manager.open(str(source), entry.password)
        session_id = str(opened["state"]["sessionId"])
        session = manager.get(session_id)
        child = OpContext(job_id=f"exp-{index}", work_dir=folder)
        if p.format == "pdf":
            spec = get_op("export.refresh")
            params: Any = ExportRefreshParams(output_path=str(target), options=p.options)
        else:
            spec = get_op("export.document")
            params = ExportDocumentParams(
                format=p.format, output_path=str(target), options=p.options
            )
        if spec is None:  # registered by this package; kept as a guard
            raise ChefError(ErrorKind.OP_NOT_FOUND, "export operation missing")
        out = session.submit(lambda: session.run_op(spec, params, child)).result()
        data = out.get("data", {})
        return _row(
            entry.path,
            "done",
            outputPath=str(target),
            outputs=[str(x) for x in out.get("outputs", [])],
            warnings=list(out.get("warnings", [])),
            stats=data.get("stats", {}),
        )
    except CancelledError:
        raise
    except Exception as exc:
        error = to_chef_error(exc)
        if error.kind is ErrorKind.CANCELLED:
            raise CancelledError() from exc
        return _row(entry.path, "failed", errorKind=error.kind.value, message=error.message)
    finally:
        _close(manager, session_id)
        shutil.rmtree(folder, ignore_errors=True)


@operation(
    id="export.batch",
    title="Xuất hàng loạt",
    group="export",
    params=ExportBatchParams,
    standalone=True,
)
def export_batch(ctx: OpContext, p: ExportBatchParams) -> OpOutput:
    rule = OutputRule(
        mode=p.output.mode,
        suffix=p.output.suffix,
        folder=Path(p.output.folder).expanduser().absolute() if p.output.folder else None,
    )
    if rule.mode == "folder" and rule.folder is not None:
        rule.folder.mkdir(parents=True, exist_ok=True)
    ctx.work_dir.mkdir(parents=True, exist_ok=True)
    reserved: set[str] = set()
    rows: list[dict[str, Any]] = []
    outputs: list[str] = []
    stopped = False
    total = len(p.files)
    for index, entry in enumerate(p.files, start=1):
        ctx.progress(index - 1, total, Path(entry.path).name)
        if stopped:
            rows.append(_row(entry.path, "skipped", message="Dừng vì lỗi ở file trước."))
            continue
        try:
            row = _export_one(ctx, index, entry, p, rule, reserved)
        except CancelledError:
            raise
        except ChefError as exc:
            row = _row(entry.path, "failed", errorKind=exc.kind.value, message=exc.message)
        rows.append(row)
        outputs.extend(row["outputs"])
        if row["status"] == "failed" and p.stop_on_error:
            stopped = True
    ctx.progress(total, total, None)
    counts = {"done": 0, "failed": 0, "skipped": 0}
    for row in rows:
        counts[row["status"]] = counts.get(row["status"], 0) + 1
    return OpOutput(
        changed_pages=[],
        outputs=outputs,
        data={
            "files": rows,
            "summary": {
                "total": len(rows),
                "done": counts["done"],
                "failed": counts["failed"],
                "skipped": counts["skipped"],
            },
            "format": p.format,
        },
    )


__all__ = ["ExportBatchParams", "export_batch"]
