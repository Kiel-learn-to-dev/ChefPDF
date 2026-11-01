"""Crash recovery of document sessions (feature A9, task T5.10).

A session whose core stopped without a clean close keeps its directory
(``userData/sessions/<id>``) with ``meta.json`` ``closed: false``. A clean close or a discard
marks ``closed: true`` and then deletes the directory, so only leftovers are ever listed.

- ``list_recoverable``: the sessions of an earlier run that were not closed (never live ones).
- ``restore``: reopens one from its newest readable revision. A damaged newest revision falls
  back to the previous one. Protection (passwords, pending encryption) is never stored, so it
  cannot come back: the restore says so in ``warnings``.
- ``discard``: deletes one.
- ``cleanup``: deletes cleanly closed leftovers older than ``RETENTION_SECONDS`` (7 days), and
  crashed sessions (never closed, not restored or discarded) older than ``max_age_days`` (30 by
  default). Live sessions and unreadable leftovers are kept.

Session ids are validated as 32 lowercase hex digits before any path is built, since discard
deletes a directory.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pikepdf

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.pdf.io import opened_pdf, write_json_atomic
from chef_core.session.info import has_signatures
from chef_core.session.manager import Session, SessionManager

log = logging.getLogger(__name__)

RETENTION_SECONDS = 7 * 24 * 3600  # cleanly closed leftovers
CRASHED_MAX_AGE_DAYS = 30.0  # crashed sessions nobody restored or discarded
_ID_RE = re.compile(r"[0-9a-f]{32}")
_REV_RE = re.compile(r"rev-(\d{4})\.pdf")


def _not_found(session_id: Any) -> ChefError:
    return ChefError(ErrorKind.SESSION_NOT_FOUND, "Session not found", {"sessionId": session_id})


def _iso(timestamp: float) -> str:
    return (
        datetime.fromtimestamp(timestamp, UTC).isoformat(timespec="seconds").replace("+00:00", "Z")
    )


def _session_dir(manager: SessionManager, session_id: Any) -> Path:
    if not isinstance(session_id, str) or not _ID_RE.fullmatch(session_id):
        raise _not_found(session_id)
    return manager.sessions_dir / session_id


def _read_meta(directory: Path) -> dict[str, Any] | None:
    try:
        data = json.loads((directory / "meta.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _live_ids(manager: SessionManager) -> set[str]:
    return {s.id for s in manager.all() if not s.closed}


def _revision_numbers(directory: Path) -> list[int]:
    numbers = []
    for entry in directory.iterdir():
        match = _REV_RE.fullmatch(entry.name)
        if match:
            numbers.append(int(match.group(1)))
    return sorted(numbers)


def _page_count(path: Path) -> int | None:
    try:
        with pikepdf.open(path) as pdf:
            return len(pdf.pages)
    except Exception:
        return None


def _last_modified(directory: Path) -> float:
    return max((entry.stat().st_mtime for entry in directory.iterdir()), default=0.0)


def list_recoverable(manager: SessionManager) -> list[dict[str, Any]]:
    """Sessions of an earlier run that were not closed, newest first."""
    live = _live_ids(manager)
    entries: list[dict[str, Any]] = []
    for directory in manager.sessions_dir.iterdir():
        if not directory.is_dir() or not _ID_RE.fullmatch(directory.name):
            continue
        if directory.name in live:
            continue
        meta = _read_meta(directory)
        if meta is None or meta.get("closed"):
            continue
        revision = meta.get("revision")
        saved = meta.get("savedRevision")
        dirty = revision != saved or meta.get("pendingProtection") is not None
        pages = None
        if isinstance(revision, int):
            pages = _page_count(directory / f"rev-{revision:04d}.pdf")
        entries.append(
            {
                "sessionId": directory.name,
                "sourcePath": meta.get("sourcePath"),
                "openedAt": meta.get("openedAt"),
                "lastModified": _iso(_last_modified(directory)),
                "revision": revision,
                "dirty": dirty,
                "pages": pages,
                "hasUnsavedChanges": dirty,
            }
        )
    entries.sort(key=lambda e: str(e["lastModified"]), reverse=True)
    return entries


def restore(manager: SessionManager, session_id: Any) -> dict[str, Any]:
    """Reopen a crashed session. Returns ``{state, info, warnings}``."""
    directory = _session_dir(manager, session_id)
    meta = _read_meta(directory) if directory.is_dir() else None
    if meta is None or meta.get("closed"):
        raise _not_found(session_id)
    if session_id in _live_ids(manager):
        raise invalid_params("Session is already open", {"sessionId": session_id})

    warnings: list[str] = []
    numbers = _revision_numbers(directory)
    recorded = meta.get("revisions")
    candidates = (
        [r for r in recorded if isinstance(r, int) and r in numbers]
        if isinstance(recorded, list)
        else numbers
    )
    chosen: int | None = None
    for pos in range(len(candidates) - 1, -1, -1):
        rev = candidates[pos]
        try:
            with opened_pdf(directory / f"rev-{rev:04d}.pdf"):
                pass
        except ChefError:
            warnings.append(f"Revision {rev} is damaged and was skipped.")
            continue
        chosen = pos
        break
    if chosen is None:
        raise ChefError(
            ErrorKind.INVALID_PDF,
            "No readable revision of this session",
            {"sessionId": session_id},
        )
    for rev in candidates[chosen + 1 :]:
        (directory / f"rev-{rev:04d}.pdf").unlink(missing_ok=True)
    for stray in directory.glob(".pending-*.pdf"):
        stray.unlink(missing_ok=True)
    kept = candidates[: chosen + 1]

    source = meta.get("sourcePath")
    session = Session(
        session_id,
        directory,
        source_path=Path(source) if isinstance(source, str) and source else None,
        encryption=None,
        signed=False,
    )
    if isinstance(meta.get("openedAt"), str):
        session.opened_at = meta["openedAt"]
    session.revisions = kept
    session.index = len(kept) - 1
    session.next_rev = max(numbers, default=0) + 1
    saved = meta.get("savedRevision")
    session.saved_rev = saved if isinstance(saved, int) and saved in kept else None
    session.signed = has_signatures_at(session)
    if meta.get("encrypted") or meta.get("pendingProtection") is not None:
        warnings.append(
            "The encryption and password settings of this session were not restored. "
            "Saving writes an unencrypted file unless you set the protection again."
        )
    manager._register(session)
    log.info("session %s restored at revision %d", session_id, session.current_rev)
    return {"state": session.state(), "info": session.info(), "warnings": warnings}


def has_signatures_at(session: Session) -> bool:
    with opened_pdf(session.current_path) as pdf:
        return has_signatures(pdf)


def discard(manager: SessionManager, session_id: Any) -> None:
    """Delete a crashed session. Live sessions are refused."""
    directory = _session_dir(manager, session_id)
    meta = _read_meta(directory) if directory.is_dir() else None
    if meta is None or meta.get("closed"):
        raise _not_found(session_id)
    if session_id in _live_ids(manager):
        raise invalid_params("Session is already open", {"sessionId": session_id})
    meta["closed"] = True
    write_json_atomic(directory / "meta.json", json.dumps(meta, ensure_ascii=False, indent=2))
    shutil.rmtree(directory, ignore_errors=True)


def cleanup(
    manager: SessionManager,
    now: float | None = None,
    *,
    max_age_days: float = CRASHED_MAX_AGE_DAYS,
) -> int:
    """Delete session leftovers past their age limit: 7 days for a cleanly closed session,
    ``max_age_days`` for a crashed one. Returns the count removed."""
    current = now if now is not None else datetime.now(UTC).timestamp()
    live = _live_ids(manager)
    removed = 0
    for directory in manager.sessions_dir.iterdir():
        if not directory.is_dir() or not _ID_RE.fullmatch(directory.name):
            continue
        if directory.name in live:
            continue
        meta = _read_meta(directory)
        if meta is None:
            continue
        limit = RETENTION_SECONDS if meta.get("closed") else max_age_days * 24 * 3600
        age = current - (directory / "meta.json").stat().st_mtime
        if age < limit:
            continue
        shutil.rmtree(directory, ignore_errors=True)
        removed += 1
    return removed
