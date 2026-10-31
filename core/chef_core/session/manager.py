"""Document sessions: working copy, revisions, journal, undo/redo and safe save.

Storage layout (docs/CONTRACTS.md §4)::

    <data-dir>/sessions/<sessionId>/
      meta.json        { sourcePath, openedAt, signed, revision, ... } (never the password)
      rev-0000.pdf     working copy at open time (always unencrypted)
      rev-0001.pdf ...
      journal.jsonl    one line per op: { rev, opId, params, at }

Concurrency: every session owns a single-thread executor. Jobs and state-changing session
requests (undo, redo, save, close) are queued on it, so a session is never operated on
concurrently and requests are applied in the order they arrived.
"""

from __future__ import annotations

import contextlib
import json
import logging
import shutil
import threading
import uuid
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pikepdf

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.ops.base import OpContext, OpSpec
from chef_core.pdf.io import atomic_copy, atomic_save, open_pdf, opened_pdf, write_json_atomic
from chef_core.session.info import document_info, has_signatures

log = logging.getLogger(__name__)

MAX_REVISIONS = 50
DEFAULT_DOC_NAME = "document"


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def journal_params(value: Any) -> Any:
    """Params as stored in journal.jsonl: passwords removed, data URLs elided."""
    if isinstance(value, dict):
        return {k: journal_params(v) for k, v in value.items() if k != "password"}
    if isinstance(value, list):
        return [journal_params(v) for v in value]
    if isinstance(value, str) and value.startswith("data:") and len(value) > 200:
        return f"{value[:40]}...<{len(value)} chars>"
    return value


@dataclass(frozen=True)
class EncryptionState:
    """How the source document was encrypted. Kept in memory only, never written."""

    allow: pikepdf.Permissions
    user_password: str = field(repr=False)
    # None when the owner password is unknown (the file was opened with the user password).
    owner_password: str | None = field(repr=False)


def _encryption_state(pdf: pikepdf.Pdf, source: Path, password: str | None) -> EncryptionState:
    if not password:
        owner = "" if pdf.owner_password_matched else None
        return EncryptionState(allow=pdf.allow, user_password="", owner_password=owner)
    try:
        with pikepdf.open(source, password=""):
            user = ""  # the user password is empty, the given one is the owner password
    except pikepdf.PasswordError:
        user = password
    except Exception:
        user = password
    owner = password if pdf.owner_password_matched else None
    return EncryptionState(allow=pdf.allow, user_password=user, owner_password=owner)


class Session:
    def __init__(
        self,
        session_id: str,
        directory: Path,
        *,
        source_path: Path | None,
        encryption: EncryptionState | None,
        signed: bool,
    ) -> None:
        self.id = session_id
        self.dir = directory
        self.source_path = source_path
        self.encryption = encryption  # holds the passwords: memory only, never logged
        self.signed = signed
        self.opened_at = _now()
        self.revisions: list[int] = [0]
        self.index = 0
        self.next_rev = 1
        self.saved_rev: int | None = 0
        self.closed = False
        self._lock = threading.RLock()
        self._executor = ThreadPoolExecutor(
            max_workers=1, thread_name_prefix=f"session-{session_id[:8]}"
        )

    # -- basic state --------------------------------------------------------------------

    def __repr__(self) -> str:
        return f"<Session {self.id} rev={self.current_rev}>"

    def revision_path(self, rev: int) -> Path:
        return self.dir / f"rev-{rev:04d}.pdf"

    @property
    def current_rev(self) -> int:
        return self.revisions[self.index]

    @property
    def current_path(self) -> Path:
        return self.revision_path(self.current_rev)

    @property
    def encrypted(self) -> bool:
        return self.encryption is not None

    @property
    def doc_name(self) -> str:
        return self.source_path.stem if self.source_path is not None else DEFAULT_DOC_NAME

    def state(self) -> dict[str, Any]:
        with self._lock:
            return {
                "sessionId": self.id,
                "sourcePath": str(self.source_path) if self.source_path is not None else None,
                "revisionPath": str(self.current_path),
                "revision": self.current_rev,
                "canUndo": self.index > 0,
                "canRedo": self.index < len(self.revisions) - 1,
                "dirty": self.current_rev != self.saved_rev,
                "signed": self.signed,
            }

    def info(self) -> dict[str, Any]:
        with self._lock:
            path = self.current_path
            dirty = self.current_rev != self.saved_rev
            source = self.source_path
        size_path = source if (not dirty and source is not None and source.is_file()) else path
        with opened_pdf(path) as pdf:
            return document_info(pdf, encrypted=self.encrypted, file_size=size_path.stat().st_size)

    def write_meta(self) -> None:
        with self._lock:
            meta = {
                "sourcePath": str(self.source_path) if self.source_path is not None else None,
                "openedAt": self.opened_at,
                "signed": self.signed,
                "revision": self.current_rev,
                "revisions": list(self.revisions),
                "savedRevision": self.saved_rev,
                "encrypted": self.encrypted,
            }
        write_json_atomic(self.dir / "meta.json", json.dumps(meta, ensure_ascii=False, indent=2))

    # -- executor -----------------------------------------------------------------------

    def submit[T](self, fn: Callable[[], T], *, guarded: bool = True) -> Future[T]:
        """Run ``fn`` on this session's serial executor.

        When ``guarded``, ``fn`` is skipped with ``SESSION_NOT_FOUND`` if the session got
        closed while it was queued; unguarded callers must check ``closed`` themselves.
        """
        with self._lock:
            if self.closed:
                raise _not_found(self.id)
            return self._executor.submit(self._guard(fn) if guarded else fn)

    def _guard[T](self, fn: Callable[[], T]) -> Callable[[], T]:
        def wrapped() -> T:
            if self.closed:
                raise _not_found(self.id)
            return fn()

        return wrapped

    # -- operations (run on the session executor) ---------------------------------------

    def run_op(self, spec: OpSpec, params: Any, ctx: OpContext) -> dict[str, Any]:
        if spec.destructive and self.signed:
            raise ChefError(
                ErrorKind.BLOCKED_BY_SIGNATURE,
                f"Operation {spec.id} would invalidate the digital signatures",
                {"opId": spec.id},
            )
        ctx.input_path = self.current_path
        ctx.result_path = self.dir / f".pending-{ctx.job_id}.pdf"
        ctx.doc_name = self.doc_name
        try:
            output = spec.run(ctx, params)
            ctx.check_cancelled()
            if ctx.modified:
                self._commit(ctx.result_path, spec.id, params)
                changed = output.changed_pages
            else:
                changed = []
        finally:
            with contextlib.suppress(OSError):
                ctx.result_path.unlink(missing_ok=True)
        return {
            "state": self.state(),
            "changedPages": changed,
            "warnings": list(ctx.warnings),
            "outputs": list(output.outputs),
            **({"data": output.data} if output.data is not None else {}),
        }

    def _commit(self, new_file: Path, op_id: str, params: Any) -> None:
        with self._lock:
            rev = self.next_rev
            new_file.replace(self.revision_path(rev))
            self.next_rev += 1
            dropped = self.revisions[self.index + 1 :]  # redo branch is discarded
            self.revisions = [*self.revisions[: self.index + 1], rev]
            while len(self.revisions) > MAX_REVISIONS:
                dropped.append(self.revisions.pop(1))  # rev-0000 is always kept
            self.index = len(self.revisions) - 1
        for old in dropped:
            with contextlib.suppress(OSError):
                self.revision_path(old).unlink(missing_ok=True)
        params_json = params.model_dump(by_alias=True, mode="json") if params is not None else {}
        entry = {"rev": rev, "opId": op_id, "params": journal_params(params_json), "at": _now()}
        with open(self.dir / "journal.jsonl", "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
        self.write_meta()

    def undo(self) -> dict[str, Any]:
        with self._lock:
            if self.index == 0:
                raise invalid_params("Nothing to undo")
            self.index -= 1
        self.write_meta()
        return self._move_result()

    def redo(self) -> dict[str, Any]:
        with self._lock:
            if self.index >= len(self.revisions) - 1:
                raise invalid_params("Nothing to redo")
            self.index += 1
        self.write_meta()
        return self._move_result()

    def _move_result(self) -> dict[str, Any]:
        return {"state": self.state(), "changedPages": "all", "warnings": [], "outputs": []}

    def save(self, path: str | None) -> dict[str, Any]:
        if path:
            dest = Path(path).expanduser().absolute()
        elif self.source_path is not None:
            dest = self.source_path
        else:
            raise invalid_params("This document has no file yet; a path is required")
        if dest.is_dir():
            raise invalid_params("Save path is a directory", {"path": str(dest)})
        if not dest.parent.is_dir():
            raise ChefError(
                ErrorKind.FILE_NOT_FOUND, "Output directory does not exist", {"path": str(dest)}
            )
        warnings: list[str] = []
        src = self.current_path
        enc = self.encryption
        if enc is not None and (enc.user_password or enc.owner_password is not None):
            owner = enc.owner_password
            if owner is None:
                owner = enc.user_password
                warnings.append(
                    "The original owner password could not be preserved; the document "
                    "password is now also the owner password."
                )
            encryption = pikepdf.Encryption(
                user=enc.user_password, owner=owner, R=6, allow=enc.allow
            )
            with opened_pdf(src) as pdf:
                atomic_save(pdf, dest, encryption=encryption)
        else:
            if enc is not None:
                warnings.append(
                    "The document had only an unknown owner password (restrictions); "
                    "it was saved without encryption."
                )
            atomic_copy(src, dest)
        with self._lock:
            self.source_path = dest
            self.saved_rev = self.current_rev
        self.write_meta()
        log.info("session %s saved (rev %d)", self.id, self.current_rev)
        return {**self.state(), "warnings": warnings}

    def close(self) -> None:
        """Delete the session directory (runs on the executor after queued work)."""
        with self._lock:
            self.closed = True
        shutil.rmtree(self.dir, ignore_errors=True)

    def shutdown_executor(self, wait: bool, cancel_pending: bool = False) -> None:
        self._executor.shutdown(wait=wait, cancel_futures=cancel_pending)


def _not_found(session_id: str) -> ChefError:
    return ChefError(ErrorKind.SESSION_NOT_FOUND, "Session not found", {"sessionId": session_id})


class SessionManager:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.sessions_dir = data_dir / "sessions"
        self.cache_dir = data_dir / "cache"
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()

    def get(self, session_id: Any) -> Session:
        if not isinstance(session_id, str):
            raise invalid_params("sessionId must be a string")
        with self._lock:
            session = self._sessions.get(session_id)
        if session is None or session.closed:
            raise _not_found(session_id)
        return session

    def all(self) -> list[Session]:
        with self._lock:
            return list(self._sessions.values())

    def _new_dir(self) -> tuple[str, Path]:
        session_id = uuid.uuid4().hex
        directory = self.sessions_dir / session_id
        directory.mkdir(parents=True)
        return session_id, directory

    def _register(self, session: Session) -> None:
        session.write_meta()
        (session.dir / "journal.jsonl").touch()
        with self._lock:
            self._sessions[session.id] = session

    def open(self, path: str, password: str | None = None) -> dict[str, Any]:
        source = Path(path).expanduser().absolute()
        pdf = open_pdf(source, password)
        session_id, directory = self._new_dir()
        try:
            with pdf:
                encryption: EncryptionState | None = None
                if pdf.is_encrypted:
                    encryption = _encryption_state(pdf, source, password)
                rev0 = directory / "rev-0000.pdf"
                if encryption is not None or pdf.get_warnings():
                    # Decrypt (or normalise a repaired file) into the working copy.
                    pdf.save(rev0, encryption=False)
                else:
                    shutil.copyfile(source, rev0)
                session = Session(
                    session_id,
                    directory,
                    source_path=source,
                    encryption=encryption,
                    signed=has_signatures(pdf),
                )
                info = document_info(
                    pdf, encrypted=encryption is not None, file_size=source.stat().st_size
                )
        except BaseException:
            shutil.rmtree(directory, ignore_errors=True)
            raise
        self._register(session)
        log.info("session %s opened (%d pages)", session_id, info["pageCount"])
        return {"state": session.state(), "info": info}

    def create(self) -> dict[str, Any]:
        session_id, directory = self._new_dir()
        try:
            with pikepdf.new() as pdf:
                pdf.save(directory / "rev-0000.pdf")
                info = document_info(pdf, encrypted=False, file_size=0)
            session = Session(
                session_id,
                directory,
                source_path=None,
                encryption=None,
                signed=False,
            )
            info["fileSize"] = session.current_path.stat().st_size
        except BaseException:
            shutil.rmtree(directory, ignore_errors=True)
            raise
        self._register(session)
        return {"state": session.state(), "info": info}

    def close(self, session_id: str) -> Future[None]:
        session = self.get(session_id)
        future = session.submit(session.close)

        def done(_: Future[None]) -> None:
            with self._lock:
                self._sessions.pop(session_id, None)
            session.shutdown_executor(wait=False)

        future.add_done_callback(done)
        return future

    def close_all(self, timeout: float = 10.0) -> None:
        """Close every session (graceful shutdown). Waits for queued work up to ``timeout``."""
        futures = []
        for session in self.all():
            try:
                futures.append(self.close(session.id))
            except ChefError:
                continue
        for fut in futures:
            with contextlib.suppress(Exception):
                fut.result(timeout=timeout)

    def stop_executors(self, wait: bool) -> None:
        """Stop all session executors; with ``wait``, queued requests run first."""
        for session in self.all():
            session.shutdown_executor(wait=wait, cancel_pending=not wait)

    def cleanup_stale(self) -> None:
        """Remove leftover directories that can never be recovered (no meta.json)."""
        for entry in self.sessions_dir.iterdir():
            if entry.is_dir() and not (entry / "meta.json").is_file():
                shutil.rmtree(entry, ignore_errors=True)
