"""Wires the RPC server to the session manager, job runner and operation registry."""

from __future__ import annotations

import logging
import platform
from concurrent.futures import Future, ThreadPoolExecutor
from pathlib import Path
from typing import Any, BinaryIO

import chef_core
from chef_core import ops
from chef_core.errors import invalid_params
from chef_core.ops.scan_presets import describe_presets
from chef_core.rpc.jobs import JobRunner
from chef_core.rpc.server import Deferred, JsonDict, RpcServer
from chef_core.session import recovery
from chef_core.session.manager import SessionManager
from chef_core.signing.trust import set_user_trust_dir

log = logging.getLogger(__name__)

SHUTDOWN_GRACE_SECONDS = 5.0


def _str_param(params: JsonDict, name: str, *, required: bool = True) -> str | None:
    value = params.get(name)
    if value is None:
        if required:
            raise invalid_params(f"{name} is required", {"field": name})
        return None
    if not isinstance(value, str) or (required and not value):
        raise invalid_params(f"{name} must be a non-empty string", {"field": name})
    return value


class CoreApp:
    def __init__(self, data_dir: Path, inp: BinaryIO, out: BinaryIO) -> None:
        ops.load_builtin_ops()
        self.server = RpcServer(inp, out)
        self.sessions = SessionManager(data_dir)
        set_user_trust_dir(data_dir / "trust")
        self.sessions.cleanup_stale()
        self.jobs = JobRunner(self.server.notify, self.sessions)
        # Requests that may take a while but do not belong to a session (open/create/info).
        self._requests = ThreadPoolExecutor(max_workers=4, thread_name_prefix="request")
        self._graceful = False
        self._register()

    def _register(self) -> None:
        r = self.server.register
        r("system.ping", self.ping)
        r("system.shutdown", self.shutdown)
        r("ops.list", self.ops_list)
        r("ops.run", self.ops_run)
        r("scan.presets", self.scan_presets)
        r("jobs.cancel", self.jobs_cancel)
        r("session.open", self.session_open)
        r("session.create", self.session_create)
        r("session.close", self.session_close)
        r("session.state", self.session_state)
        r("session.info", self.session_info)
        r("session.undo", self.session_undo)
        r("session.redo", self.session_redo)
        r("session.save", self.session_save)
        r("recovery.list", self.recovery_list)
        r("recovery.restore", self.recovery_restore)
        r("recovery.discard", self.recovery_discard)
        r("recovery.cleanup", self.recovery_cleanup)

    # -- system -------------------------------------------------------------------------

    def ping(self, _params: JsonDict) -> dict[str, str]:
        return {"version": chef_core.__version__, "python": platform.python_version()}

    def shutdown(self, _params: JsonDict) -> Deferred:
        self._graceful = True
        return Deferred(None, self.server.stop)

    # -- ops ----------------------------------------------------------------------------

    def ops_list(self, _params: JsonDict) -> list[dict[str, Any]]:
        return [spec.descriptor() for spec in ops.registry().values()]

    def ops_run(self, params: JsonDict) -> Deferred:
        return self.jobs.run(params.get("opId"), params.get("params"), params.get("sessionId"))

    def scan_presets(self, _params: JsonDict) -> list[dict[str, Any]]:
        return describe_presets()

    def jobs_cancel(self, params: JsonDict) -> None:
        self.jobs.cancel(params.get("jobId"))

    # -- sessions -----------------------------------------------------------------------

    def session_open(self, params: JsonDict) -> Future[dict[str, Any]]:
        path = _str_param(params, "path")
        password = _str_param(params, "password", required=False)
        assert path is not None
        return self._requests.submit(self.sessions.open, path, password)

    def session_create(self, _params: JsonDict) -> Future[dict[str, Any]]:
        return self._requests.submit(self.sessions.create)

    def session_close(self, params: JsonDict) -> Future[None]:
        session_id = _str_param(params, "sessionId")
        assert session_id is not None
        self.jobs.cancel_session(session_id)
        return self.sessions.close(session_id)

    def session_state(self, params: JsonDict) -> dict[str, Any]:
        return self.sessions.get(params.get("sessionId")).state()

    def session_info(self, params: JsonDict) -> Future[dict[str, Any]]:
        session = self.sessions.get(params.get("sessionId"))
        return self._requests.submit(session.info)

    def session_undo(self, params: JsonDict) -> Future[dict[str, Any]]:
        session = self.sessions.get(params.get("sessionId"))
        return session.submit(session.undo)

    def session_redo(self, params: JsonDict) -> Future[dict[str, Any]]:
        session = self.sessions.get(params.get("sessionId"))
        return session.submit(session.redo)

    def session_save(self, params: JsonDict) -> Future[dict[str, Any]]:
        session = self.sessions.get(params.get("sessionId"))
        path = _str_param(params, "path", required=False)
        return session.submit(lambda: session.save(path))

    # -- crash recovery -----------------------------------------------------------------

    def recovery_list(self, _params: JsonDict) -> list[dict[str, Any]]:
        return recovery.list_recoverable(self.sessions)

    def recovery_restore(self, params: JsonDict) -> Future[dict[str, Any]]:
        session_id = _str_param(params, "sessionId")
        assert session_id is not None
        return self._requests.submit(recovery.restore, self.sessions, session_id)

    def recovery_discard(self, params: JsonDict) -> None:
        session_id = _str_param(params, "sessionId")
        assert session_id is not None
        recovery.discard(self.sessions, session_id)

    def recovery_cleanup(self, _params: JsonDict) -> dict[str, int]:
        return {"removed": recovery.cleanup(self.sessions)}

    # -- lifecycle ----------------------------------------------------------------------

    def run(self) -> int:
        log.info("chef-core %s ready", chef_core.__version__)
        try:
            self.server.serve_forever()
        finally:
            self.close()
        return 0

    def close(self) -> None:
        """Stop jobs. A graceful shutdown also closes (deletes) all sessions; on a bare
        stdin EOF (e.g. the app crashed) sessions stay on disk for crash recovery.

        Requests already received (open, save, undo...) are completed and answered; only
        jobs are cancelled."""
        self.jobs.cancel_all()
        self._requests.shutdown(wait=True)  # in-flight open/create/info get their response
        idle = self.jobs.wait_idle(SHUTDOWN_GRACE_SECONDS)
        if not idle:
            log.warning("some jobs did not stop in time")
        if self._graceful:
            self.sessions.close_all(timeout=SHUTDOWN_GRACE_SECONDS)
        # Let queued session requests (e.g. a save) finish unless a job is stuck.
        self.sessions.stop_executors(wait=idle)
        self.jobs.shutdown()
        log.info("chef-core stopped")
