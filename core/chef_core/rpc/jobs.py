"""Job runner: every ``ops.run`` call becomes a job with an id.

Lifecycle notifications: ``job.progress``* then exactly one of ``job.finished``,
``job.failed`` or ``job.cancelled``.

Session jobs run on the session's serial executor (no concurrent work on one document);
standalone jobs run on a shared thread pool. Operations only exchange file paths with the
runner, so CPU-heavy operations can later be dispatched to a process pool from here.
"""

from __future__ import annotations

import contextlib
import logging
import os
import shutil
import threading
import uuid
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Any

import pydantic

from chef_core.errors import (
    CancelledError,
    ChefError,
    ErrorKind,
    from_validation_error,
    invalid_params,
    to_chef_error,
)
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpSpec, get_op
from chef_core.rpc.server import Deferred
from chef_core.session.manager import Session, SessionManager

log = logging.getLogger(__name__)

Notify = Callable[[str, dict[str, Any]], None]


@dataclass
class Job:
    id: str
    spec: OpSpec
    params: WireModel
    session: Session | None
    cancel_event: threading.Event = field(default_factory=threading.Event)
    finished: bool = False


class JobRunner:
    def __init__(self, notify: Notify, sessions: SessionManager, max_workers: int | None = None):
        self._notify = notify
        self._sessions = sessions
        self._pool = ThreadPoolExecutor(
            max_workers=max_workers or min(8, os.cpu_count() or 2), thread_name_prefix="job"
        )
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._idle = threading.Condition(self._lock)
        self._jobs_dir = sessions.cache_dir / "jobs"

    # -- public API ---------------------------------------------------------------------

    def run(self, op_id: Any, raw_params: Any, session_id: Any) -> Deferred:
        """Validate and queue a job; the job starts after the response has been written."""
        if not isinstance(op_id, str):
            raise invalid_params("opId must be a string")
        spec = get_op(op_id)
        if spec is None:
            raise ChefError(ErrorKind.OP_NOT_FOUND, f"Unknown operation: {op_id}", {"opId": op_id})
        if raw_params is None:
            raw_params = {}
        try:
            params = spec.params_model.model_validate(raw_params)
        except pydantic.ValidationError as exc:
            raise from_validation_error(exc) from exc

        session: Session | None = None
        if session_id is not None:
            session = self._sessions.get(session_id)
        elif not spec.standalone:
            raise invalid_params(f"Operation {op_id} needs a sessionId")

        job = Job(id=uuid.uuid4().hex, spec=spec, params=params, session=session)
        with self._lock:
            self._jobs[job.id] = job

        def start() -> None:
            try:
                if session is not None and not spec.standalone:
                    session.submit(lambda: self._execute(job), guarded=False)
                else:
                    self._pool.submit(self._execute, job)
            except Exception as exc:  # session closed or pool shut down meanwhile
                self._finish(job, "job.failed", {"error": to_chef_error(exc).to_rpc()})

        log.info("job %s queued: %s", job.id, op_id)
        return Deferred({"jobId": job.id}, start)

    def cancel(self, job_id: Any) -> None:
        if not isinstance(job_id, str):
            raise invalid_params("jobId must be a string")
        with self._lock:
            job = self._jobs.get(job_id)
        if job is not None:
            job.cancel_event.set()
            log.info("job %s cancel requested", job_id)

    def cancel_session(self, session_id: str) -> None:
        with self._lock:
            jobs = [j for j in self._jobs.values() if j.session and j.session.id == session_id]
        for job in jobs:
            job.cancel_event.set()

    def cancel_all(self) -> None:
        with self._lock:
            jobs = list(self._jobs.values())
        for job in jobs:
            job.cancel_event.set()

    def wait_idle(self, timeout: float) -> bool:
        with self._idle:
            return self._idle.wait_for(lambda: not self._jobs, timeout=timeout)

    def shutdown(self) -> None:
        self._pool.shutdown(wait=False, cancel_futures=True)

    # -- execution ----------------------------------------------------------------------

    def _finish(self, job: Job, method: str, payload: dict[str, Any]) -> None:
        with self._lock:
            if job.finished:
                return
            job.finished = True
            self._jobs.pop(job.id, None)
            self._idle.notify_all()
        self._notify(method, {"jobId": job.id, **payload})

    def _progress(self, job: Job) -> Callable[[int, int, str | None], None]:
        def sink(done: int, total: int, message: str | None) -> None:
            payload: dict[str, Any] = {"jobId": job.id, "done": done, "total": total}
            if message:
                payload["message"] = message
            self._notify("job.progress", payload)

        return sink

    def _execute(self, job: Job) -> None:
        if job.cancel_event.is_set():
            self._finish(job, "job.cancelled", {})
            return
        if job.session is not None and job.session.closed:
            error = ChefError(
                ErrorKind.SESSION_NOT_FOUND, "Session not found", {"sessionId": job.session.id}
            )
            self._finish(job, "job.failed", {"error": error.to_rpc()})
            return
        work_dir = self._jobs_dir / job.id
        try:
            work_dir.mkdir(parents=True, exist_ok=True)
            ctx = OpContext(
                job_id=job.id,
                work_dir=work_dir,
                cancel_event=job.cancel_event,
                progress_sink=self._progress(job),
            )
            if job.session is not None and not job.spec.standalone:
                result = job.session.run_op(job.spec, job.params, ctx)
            else:
                result = self._run_standalone(job, ctx)
        except CancelledError:
            log.info("job %s cancelled", job.id)
            self._finish(job, "job.cancelled", {})
        except Exception as exc:
            error = to_chef_error(exc)
            if error.kind is ErrorKind.INTERNAL:
                log.exception("job %s (%s) crashed", job.id, job.spec.id)
            else:
                log.info("job %s failed: %s %s", job.id, error.kind, error.message)
            self._finish(job, "job.failed", {"error": error.to_rpc()})
        else:
            log.info("job %s finished", job.id)
            self._finish(job, "job.finished", {"result": result})
        finally:
            with contextlib.suppress(OSError):
                shutil.rmtree(work_dir, ignore_errors=True)

    def _run_standalone(self, job: Job, ctx: OpContext) -> dict[str, Any]:
        output = job.spec.run(ctx, job.params)
        ctx.check_cancelled()
        state = job.session.state() if job.session is not None else None
        result: dict[str, Any] = {
            "state": state,
            "changedPages": [],
            "warnings": list(ctx.warnings),
            "outputs": list(output.outputs),
        }
        if output.data is not None:
            result["data"] = output.data
        return result
