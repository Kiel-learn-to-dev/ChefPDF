"""Watched folders (T9.05 core): find new files that are complete, and never hand one out twice.

A file is *ready* when its size and modification time have not changed for ``settle_seconds``,
it can be opened for writing (no other program is still writing it), its name is not a temporary
or partial download, and it is not an output the engine wrote. A ready file goes to a queue and
is not returned again until ``markDone`` records its result, or until the queue entry is older
than ``QUEUE_TIMEOUT_SECONDS`` (a crashed run must not block the file for ever).

The state (pending observations, queue, processed files, outputs) is a small JSON ledger, written
atomically. A corrupt ledger starts empty. Time is passed in (``now``), so tests need no sleeping.
"""

from __future__ import annotations

import fnmatch
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from chef_core.pdf.io import write_json_atomic

log = logging.getLogger(__name__)

LEDGER_VERSION = 1
QUEUE_TIMEOUT_SECONDS = 3600.0
TEMP_SUFFIXES = (".crdownload", ".part", ".tmp", ".download", ".partial", ".opdownload", ".~")
MAX_PROCESSED = 50_000


def is_temp_name(name: str) -> bool:
    lowered = name.lower()
    return (
        name.startswith("~$")
        or name.startswith(".")
        or lowered.endswith(TEMP_SUFFIXES)
        or name.endswith("~")
    )


def is_file_locked(path: Path) -> bool:
    """True when another program holds the file (it cannot be opened for appending)."""
    try:
        with open(path, "ab"):
            return False
    except OSError:
        return True


@dataclass(frozen=True)
class ReadyFile:
    path: str
    size: int
    mtime_ns: int


@dataclass
class _Observation:
    size: int
    mtime_ns: int
    since: float
    queued_at: float | None = None


@dataclass
class WatchState:
    """What the watcher knows about one folder. Call :meth:`scan`, then :meth:`mark_done`."""

    is_locked: Callable[[Path], bool] = field(default=is_file_locked)
    pending: dict[str, _Observation] = field(default_factory=dict)
    processed: dict[str, dict[str, Any]] = field(default_factory=dict)
    ignored: set[str] = field(default_factory=set)

    # -- scanning -----------------------------------------------------------------------

    def scan(
        self,
        directory: Path,
        *,
        settle_seconds: float,
        now: float,
        pattern: str = "*.pdf",
        exclude: set[str] | None = None,
    ) -> list[ReadyFile]:
        """Files of ``directory`` (not recursive) that are ready now, marked as queued."""
        excluded = exclude or set()
        ready: list[ReadyFile] = []
        seen_now: set[str] = set()
        for entry in sorted(directory.iterdir()):
            if not entry.is_file() or is_temp_name(entry.name):
                continue
            if not fnmatch.fnmatch(entry.name.lower(), pattern.lower()):
                continue
            key = str(entry)
            if key in self.ignored or key in excluded:
                continue
            try:
                stat = entry.stat()
            except OSError:
                continue
            seen_now.add(key)
            size, mtime_ns = stat.st_size, stat.st_mtime_ns
            if self._is_processed(entry, size, mtime_ns):
                continue
            obs = self.pending.get(key)
            if obs is None or obs.size != size or obs.mtime_ns != mtime_ns:
                obs = _Observation(size=size, mtime_ns=mtime_ns, since=now)
                self.pending[key] = obs
            if obs.queued_at is not None:
                if now - obs.queued_at < QUEUE_TIMEOUT_SECONDS:
                    continue
                obs.queued_at = None  # a run that never reported back: offer it again
            if now - obs.since < settle_seconds:
                continue
            if self.is_locked(entry):
                continue
            obs.queued_at = now
            ready.append(ReadyFile(path=key, size=size, mtime_ns=mtime_ns))
        for key in list(self.pending):
            if key not in seen_now and Path(key).parent == directory:
                del self.pending[key]  # gone or renamed: start over if it comes back
        return ready

    def _is_processed(self, path: Path, size: int, mtime_ns: int) -> bool:
        return f"{path}|{size}|{mtime_ns}" in self.processed

    # -- results ------------------------------------------------------------------------

    def mark_done(
        self,
        path: Path,
        *,
        output_path: Path | None,
        status: str,
        now: float = 0.0,
    ) -> None:
        """Record the result of a file. Its output is ignored by later scans."""
        key = str(path)
        obs = self.pending.pop(key, None)
        # The queued fingerprint identifies the version the workflow received. The
        # file may be replaced while that workflow is running; recording its current
        # stat here would incorrectly mark the newer version as processed as well.
        if obs is not None:
            size, mtime_ns = obs.size, obs.mtime_ns
        else:
            try:
                stat = path.stat()
                size, mtime_ns = stat.st_size, stat.st_mtime_ns
            except OSError:
                size, mtime_ns = (-1, -1)
        self.processed[f"{path}|{size}|{mtime_ns}"] = {
            "path": key,
            "size": size,
            "mtimeNs": mtime_ns,
            "status": status,
            "outputPath": str(output_path) if output_path is not None else None,
            "at": now,
        }
        if output_path is not None:
            self.ignored.add(str(output_path))
        if len(self.processed) > MAX_PROCESSED:
            for old in list(self.processed)[: len(self.processed) - MAX_PROCESSED]:
                del self.processed[old]

    def release(self, paths: list[Path]) -> int:
        """Release unprocessed queue leases after an orderly stop."""
        released = 0
        for path in paths:
            obs = self.pending.get(str(path))
            if obs is not None and obs.queued_at is not None:
                obs.queued_at = None
                released += 1
        return released

    # -- ledger -------------------------------------------------------------------------

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": LEDGER_VERSION,
            "processed": self.processed,
            "ignored": sorted(self.ignored),
            "pending": {
                key: {
                    "size": obs.size,
                    "mtimeNs": obs.mtime_ns,
                    "since": obs.since,
                    "queuedAt": obs.queued_at,
                }
                for key, obs in self.pending.items()
            },
        }

    def save(self, ledger: Path) -> None:
        ledger.parent.mkdir(parents=True, exist_ok=True)
        write_json_atomic(ledger, json.dumps(self.to_dict(), ensure_ascii=False, indent=2))

    @classmethod
    def load(cls, ledger: Path, is_locked: Callable[[Path], bool] = is_file_locked) -> WatchState:
        state = cls(is_locked=is_locked)
        if not ledger.is_file():
            return state
        try:
            data = json.loads(ledger.read_text(encoding="utf-8"))
            if not isinstance(data, dict) or data.get("version") != LEDGER_VERSION:
                raise ValueError("unknown ledger version")
            state.processed = dict(data.get("processed", {}))
            state.ignored = set(data.get("ignored", []))
            for key, row in dict(data.get("pending", {})).items():
                state.pending[key] = _Observation(
                    size=int(row["size"]),
                    mtime_ns=int(row["mtimeNs"]),
                    since=float(row["since"]),
                    queued_at=row.get("queuedAt"),
                )
        except (OSError, ValueError, KeyError, TypeError) as exc:
            log.warning("watch ledger %s is unreadable, starting empty: %s", ledger, exc)
            state = cls(is_locked=is_locked)
        return state
