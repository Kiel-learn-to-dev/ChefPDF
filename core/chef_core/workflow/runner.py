"""Runs a workflow over a list of files (T9.02 workflow.run, T9.04 batch).

For each file a working session is opened on a private :class:`SessionManager` (no UI session),
the steps run in order through the same path as ``ops.run``, the result is saved to its output
name, and the session is closed again, also after an error or a cancel. Nothing is left behind:
``sessions.all()`` is empty when the run returns.

Per-file errors do not stop the run unless ``stop_on_error`` is set. A cancel stops it at the next
step boundary and raises :class:`CancelledError`.

Secrets come from the run request only. They are substituted into a copy of the step params just
before the step runs, and every message that leaves this module is scrubbed of them.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from chef_core.errors import CancelledError, ChefError, ErrorKind, to_chef_error
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpSpec, get_op
from chef_core.pdf.io import open_pdf
from chef_core.session.manager import Session, SessionManager
from chef_core.workflow.model import Workflow, WorkflowOutput, WorkflowStep, validate_workflow
from chef_core.workflow.naming import NameValues, render_template, sanitize_base, unique_target
from chef_core.workflow.placeholders import (
    BUILTIN_VARIABLES,
    MissingValue,
    expand,
    is_secret,
    scrub,
    secret_name,
)

log = logging.getLogger(__name__)

ProgressFn = Callable[[int, int, str | None], None]
MAX_PARALLEL = 4
SESSION_CLOSE_WAIT = 5.0


def _no_progress(done: int, total: int, message: str | None) -> None:
    return None


def _no_cancel() -> None:
    return None


@dataclass(frozen=True)
class FileRequest:
    path: str
    password: str | None = None


def pdf_facts(path: Path, password: str | None) -> tuple[int | None, str | None]:
    """Page count and /Title of a PDF; (None, None) when it cannot be read."""
    try:
        with open_pdf(path, password) as pdf:
            title = str(pdf.docinfo.get("/Title", "")) or None
            return len(pdf.pages), title
    except (ChefError, OSError, ValueError):
        return None, None


def check_run_inputs(
    flow: Workflow, secrets: Mapping[str, str], variables: Mapping[str, str]
) -> None:
    """Refuse the run when the workflow is invalid or a secret / variable has no value.

    Only names are reported, never values.
    """
    report = validate_workflow(flow, variables=dict(variables))
    if report.errors:
        raise ChefError(
            ErrorKind.INVALID_PARAMS,
            "Quy trình có lỗi, chưa thể chạy.",
            {"errors": [e.to_dict() for e in report.errors]},
        )
    missing_secrets = [n for n in report.required_secrets if not secrets.get(n)]
    missing_vars = [n for n in report.required_variables if not variables.get(n)]
    if missing_secrets or missing_vars:
        names = [f"bí mật {n}" for n in missing_secrets] + [f"biến {n}" for n in missing_vars]
        raise ChefError(
            ErrorKind.INVALID_PARAMS,
            "Thiếu giá trị khi chạy: " + ", ".join(names),
            {"missingSecrets": missing_secrets, "missingVariables": missing_vars},
        )


def _lookup(
    path: Path,
    index: int,
    when: datetime,
    variables: Mapping[str, str],
    secrets: Mapping[str, str],
) -> Callable[[str], str]:
    builtin = {
        "name": path.stem,
        "filename": path.name,
        "date": when.strftime("%Y-%m-%d"),
        "time": when.strftime("%H%M%S"),
        "index": str(index),
        "parent": path.parent.name,
    }

    def lookup(name: str) -> str:
        if is_secret(name):
            key = secret_name(name)
            if key in secrets:
                return secrets[key]
            raise MissingValue(name)
        if name in BUILTIN_VARIABLES:
            return builtin[name]
        if name in variables:
            return variables[name]
        raise MissingValue(name)

    return lookup


def prepare_step(step: WorkflowStep, spec: OpSpec, lookup: Callable[[str], str]) -> WireModel:
    """The typed params of a step with its placeholders filled in."""
    try:
        raw = expand(step.params, lookup)
    except MissingValue as exc:
        raise ChefError(
            ErrorKind.INVALID_PARAMS,
            f"Thiếu giá trị cho {{{{{exc.name}}}}}",
            {"placeholder": exc.name},
        ) from exc
    try:
        return spec.params_model.model_validate(raw)
    except ValidationError as exc:
        first = exc.errors(include_url=False, include_input=False)[0]
        where = ".".join(str(p) for p in first["loc"])
        raise ChefError(
            ErrorKind.INVALID_PARAMS,
            f"Tham số không hợp lệ: {where}: {first['msg']}",
            {"field": where, "errors": len(exc.errors())},
        ) from exc


class _Run:
    def __init__(
        self,
        flow: Workflow,
        *,
        sessions: SessionManager,
        work_dir: Path,
        secrets: Mapping[str, str],
        variables: Mapping[str, str],
        dry_run: bool,
        stop_on_error: bool,
        now: datetime,
        progress: ProgressFn,
        check_cancel: Callable[[], None],
    ) -> None:
        self.flow = flow
        self.output: WorkflowOutput = flow.output
        self.sessions = sessions
        self.work_dir = work_dir
        self.secrets = dict(secrets)
        self.variables = dict(variables)
        self.dry_run = dry_run
        self.stop_on_error = stop_on_error
        self.now = now
        self.progress = progress
        self.check_cancel = check_cancel
        self.reserved: set[str] = set()
        self.lock = threading.Lock()  # guards reserved names and the progress counter
        self.units_done = 0
        self.units_total = 0
        self.stop_requested = threading.Event()

    # -- progress, names, sessions ------------------------------------------------------

    def _scrub(self, text: str) -> str:
        return scrub(text, self.secrets)

    def _advance(self, message: str) -> None:
        with self.lock:
            self.units_done += 1
            self.progress(self.units_done, self.units_total, message)

    def _output_path(self, source: Path, working: Path, index: int) -> Path:
        """A free output name for ``source``. Callers must hold no lock (this takes it)."""
        mode = self.output.mode
        if mode == "overwrite":
            return source
        folder = Path(self.output.folder) if mode == "folder" and self.output.folder else None
        folder = folder or source.parent
        if self.output.name_template:
            pages, title = pdf_facts(working, None)
            values = NameValues(
                name=source.stem,
                index=index,
                when=self.now,
                pages=pages,
                parent=source.parent.name,
                title=title,
                counter=index,
            )
            text = render_template(self.output.name_template, values)
        else:
            text = source.stem + (self.output.suffix if mode == "suffix" else "")
        base = sanitize_base(text)
        with self.lock:
            folder.mkdir(parents=True, exist_ok=True)
            target = unique_target(folder, base, "suffix", self.reserved)
        if target is None:  # the suffix policy never returns None
            raise ChefError(ErrorKind.INTERNAL, "no output name")
        return target

    def _close(self, session_id: str) -> None:
        try:
            self.sessions.close(session_id).result(timeout=SESSION_CLOSE_WAIT)
        except (ChefError, OSError, TimeoutError) as exc:
            log.warning("workflow session %s could not be closed: %s", session_id, exc)
        deadline = time.monotonic() + SESSION_CLOSE_WAIT
        # The manager forgets a session in a callback that runs just after the close resolves.
        while time.monotonic() < deadline and any(s.id == session_id for s in self.sessions.all()):
            time.sleep(0.002)

    # -- one file -----------------------------------------------------------------------

    def run_file(self, index: int, request: FileRequest) -> dict[str, Any]:
        started = time.monotonic()
        row: dict[str, Any] = {
            "path": request.path,
            "outputPath": None,
            "status": "failed",
            "failedStep": None,
            "errorKind": None,
            "message": None,
            "warnings": [],
            "stepResults": [],
            "durationMs": 0,
        }
        ticks = [0]

        def tick(message: str) -> None:
            ticks[0] += 1
            self._advance(message)

        per_file = 1 if self.dry_run else sum(1 for s in self.flow.steps if s.enabled) + 1
        try:
            if self.dry_run:
                self._dry_run_file(index, request, row)
            else:
                self._run_file_body(index, request, row, tick)
        finally:
            for _ in range(per_file - ticks[0]):
                self._advance(Path(request.path).name)
            row["durationMs"] = int((time.monotonic() - started) * 1000)
        log.info("workflow file %d finished: %s", index, row["status"])
        return row

    def _run_file_body(
        self,
        index: int,
        request: FileRequest,
        row: dict[str, Any],
        tick: Callable[[str], None],
    ) -> None:
        source = Path(request.path)
        session_id: str | None = None
        try:
            self.check_cancel()
            opened = self.sessions.open(request.path, request.password)
            session_id = str(opened["state"]["sessionId"])
            session = self.sessions.get(session_id)
            lookup = _lookup(source, index, self.now, self.variables, self.secrets)
            for step_index, step in enumerate(self.flow.steps):
                if not step.enabled:
                    continue
                self.check_cancel()
                spec = get_op(step.op)
                if spec is None:  # validated before the run; kept as a guard
                    raise ChefError(ErrorKind.OP_NOT_FOUND, f"Unknown operation: {step.op}")
                label = step.label or spec.title
                outcome = self._run_step(session, index, step_index, step, spec, lookup)
                if outcome is None:  # failed, and the step says skip
                    row["warnings"].append(
                        f"Bước {step_index + 1} ({spec.id}) lỗi và đã được bỏ qua."
                    )
                    tick(f"{source.name}: {label} (bỏ qua)")
                    continue
                tick(f"{source.name}: {label}")
                if outcome.get("failed"):
                    row["failedStep"] = step_index
                    row["errorKind"] = outcome["errorKind"]
                    row["message"] = outcome["message"]
                    return
                row["stepResults"].append(
                    {
                        "index": step_index,
                        "op": spec.id,
                        "label": label,
                        "changedPages": outcome["changedPages"],
                        "warnings": [self._scrub(w) for w in outcome["warnings"]],
                    }
                )
            self.check_cancel()
            target = self._output_path(source, session.current_path, index)
            saved = session.submit(lambda: session.save(str(target))).result()
            row["warnings"].extend(self._scrub(w) for w in saved.get("warnings", []))
            row["outputPath"] = str(target)
            row["status"] = "done"
            tick(f"{source.name}: đã lưu")
        except CancelledError:
            raise
        except Exception as exc:
            error = to_chef_error(exc)
            if error.kind is ErrorKind.CANCELLED:
                raise CancelledError() from exc
            if error.kind is ErrorKind.INTERNAL:
                log.exception("workflow file %d crashed", index)
            row["errorKind"] = error.kind.value
            row["message"] = self._scrub(error.message)
        finally:
            if session_id is not None:
                self._close(session_id)

    def _run_step(
        self,
        session: Session,
        index: int,
        step_index: int,
        step: WorkflowStep,
        spec: OpSpec,
        lookup: Callable[[str], str],
    ) -> dict[str, Any] | None:
        """The step's result. A failure gives ``{"failed": True, ...}``; None means the failed
        step is skipped (``onError: skip``)."""
        child = OpContext(job_id=f"wf-{index}-{step_index}", work_dir=self.work_dir)
        try:
            params = prepare_step(step, spec, lookup)
            out = session.submit(lambda: session.run_op(spec, params, child)).result()
        except CancelledError:
            raise
        except Exception as exc:
            error = to_chef_error(exc)
            if error.kind is ErrorKind.CANCELLED:
                raise CancelledError() from exc
            if step.on_error == "skip":
                return None
            return {
                "failed": True,
                "errorKind": error.kind.value,
                "message": self._scrub(error.message),
            }
        return {
            "changedPages": out.get("changedPages", []),
            "warnings": [str(w) for w in out.get("warnings", [])],
        }

    def _dry_run_file(self, index: int, request: FileRequest, row: dict[str, Any]) -> None:
        self.check_cancel()
        source = Path(request.path)
        try:
            planned = self._output_path(source, source, index)
        except ChefError as exc:
            row["errorKind"] = exc.kind.value
            row["message"] = self._scrub(exc.message)
            return
        row["plannedOutputPath"] = str(planned)
        row["status"] = "skipped"
        row["message"] = "Chạy thử: chưa xử lý và chưa ghi file."

    # -- all files ----------------------------------------------------------------------

    def run(self, files: Sequence[FileRequest], parallel: int) -> dict[str, Any]:
        per_file = 1 if self.dry_run else sum(1 for s in self.flow.steps if s.enabled) + 1
        self.units_total = per_file * len(files)
        if parallel <= 1:
            rows = [self._one(index, request) for index, request in enumerate(files, start=1)]
        else:
            rows = self._run_parallel(files, parallel)
        return self._report(rows)

    def _one(self, index: int, request: FileRequest) -> dict[str, Any]:
        if self.stop_requested.is_set():
            return self._skipped(request)
        row = self.run_file(index, request)
        if row["status"] == "failed" and self.stop_on_error:
            self.stop_requested.set()
        return row

    @staticmethod
    def _skipped(request: FileRequest) -> dict[str, Any]:
        return {
            "path": request.path,
            "outputPath": None,
            "status": "skipped",
            "failedStep": None,
            "errorKind": None,
            "message": "Dừng vì lỗi ở file trước.",
            "warnings": [],
            "stepResults": [],
            "durationMs": 0,
        }

    def _run_parallel(self, files: Sequence[FileRequest], parallel: int) -> list[dict[str, Any]]:
        futures: list[Future[dict[str, Any]]] = []
        with ThreadPoolExecutor(max_workers=parallel, thread_name_prefix="wf") as pool:
            try:
                for index, request in enumerate(files, start=1):
                    futures.append(pool.submit(self._one, index, request))
                return [f.result() for f in futures]
            except BaseException:
                self.stop_requested.set()
                for future in futures:
                    future.cancel()
                raise

    def _report(self, rows: list[dict[str, Any]]) -> dict[str, Any]:
        counts = {"done": 0, "failed": 0, "skipped": 0}
        for row in rows:
            counts[row["status"]] = counts.get(row["status"], 0) + 1
        return {
            "results": rows,
            "summary": {
                "total": len(rows),
                "done": counts["done"],
                "failed": counts["failed"],
                "skipped": counts["skipped"],
            },
            "dryRun": self.dry_run,
        }


def run_workflow(
    flow: Workflow,
    files: Sequence[FileRequest],
    *,
    sessions: SessionManager,
    work_dir: Path,
    secrets: Mapping[str, str] | None = None,
    variables: Mapping[str, str] | None = None,
    output: WorkflowOutput | None = None,
    stop_on_error: bool = False,
    dry_run: bool = False,
    parallel: int = 1,
    progress: ProgressFn | None = None,
    check_cancel: Callable[[], None] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Run ``flow`` over ``files``. Raises INVALID_PARAMS before any file opens when the workflow
    is invalid or a secret / required variable is missing. Returns the per-file report."""
    if not 1 <= parallel <= MAX_PARALLEL:
        raise ChefError(ErrorKind.INVALID_PARAMS, "parallel must be between 1 and 4")
    given_secrets = dict(secrets or {})
    given_vars = dict(variables or {})
    effective = flow.model_copy(update={"output": output}) if output is not None else flow
    check_run_inputs(effective, given_secrets, given_vars)
    run = _Run(
        effective,
        sessions=sessions,
        work_dir=work_dir,
        secrets=given_secrets,
        variables={**effective.variables, **given_vars},
        dry_run=dry_run,
        stop_on_error=stop_on_error,
        now=now or datetime.now(),
        progress=progress or _no_progress,
        check_cancel=check_cancel or _no_cancel,
    )
    try:
        return run.run(list(files), parallel)
    finally:
        for session in sessions.all():  # never leave a session behind, even after a cancel
            run._close(session.id)
