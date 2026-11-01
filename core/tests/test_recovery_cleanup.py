"""Defect 5a of the core review: recovery.cleanup age limits.

Cleanly closed leftovers go after 7 days. Crashed sessions (never closed, not restored or
discarded) used to stay for ever; they now go after ``max_age_days`` (30 by default).
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from conftest import Harness

from chef_core.session import recovery
from chef_core.session.recovery import RETENTION_SECONDS

DAY = 86400


def _leftover(sessions: Path, sid: str, *, closed: bool) -> Path:
    directory = sessions / sid
    directory.mkdir()
    (directory / "rev-0000.pdf").write_bytes(b"x")
    meta = {
        "sourcePath": None,
        "openedAt": "2000-01-01T00:00:00Z",
        "signed": False,
        "revision": 0,
        "revisions": [0],
        "savedRevision": 0,
        "encrypted": False,
        "closed": closed,
    }
    (directory / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    return directory


def _aged(directory: Path, days: float, now: float) -> Path:
    old = now - days * DAY
    for entry in [directory, *directory.glob("*")]:
        os.utime(entry, (old, old))
    return directory


def _sessions(harness: Harness) -> Path:
    sessions = harness.data_dir / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    return sessions


def test_closed_leftovers_go_after_seven_days(harness: Harness) -> None:
    sessions = _sessions(harness)
    now = time.time()
    six = _aged(_leftover(sessions, "a" * 32, closed=True), 6, now)
    eight = _aged(_leftover(sessions, "b" * 32, closed=True), 8, now)
    assert recovery.cleanup(harness.app.sessions, now=now) == 1
    assert six.is_dir() and not eight.exists()
    assert RETENTION_SECONDS == 7 * DAY


def test_crashed_sessions_are_kept_for_thirty_days_by_default(harness: Harness) -> None:
    sessions = _sessions(harness)
    now = time.time()
    twenty_nine = _aged(_leftover(sessions, "c" * 32, closed=False), 29, now)
    thirty_one = _aged(_leftover(sessions, "d" * 32, closed=False), 31, now)
    assert recovery.cleanup(harness.app.sessions, now=now) == 1
    assert twenty_nine.is_dir() and not thirty_one.exists()


def test_max_age_days_sets_the_limit_for_crashed_sessions(harness: Harness) -> None:
    sessions = _sessions(harness)
    now = time.time()
    crashed_old = _aged(_leftover(sessions, "e" * 32, closed=False), 11, now)
    crashed_young = _aged(_leftover(sessions, "f" * 32, closed=False), 9, now)
    closed_old = _aged(_leftover(sessions, "1" * 32, closed=True), 8, now)
    removed = recovery.cleanup(harness.app.sessions, now=now, max_age_days=10)
    assert removed == 2  # the crashed one past 10 days and the closed one past 7 days
    assert not crashed_old.exists() and not closed_old.exists()
    assert crashed_young.is_dir()


def test_live_and_unreadable_leftovers_are_never_removed(harness: Harness) -> None:
    sessions = _sessions(harness)
    now = time.time()
    unreadable = sessions / ("2" * 32)
    unreadable.mkdir()
    (unreadable / "meta.json").write_text("{ not json", encoding="utf-8")
    _aged(unreadable, 400, now)
    assert recovery.cleanup(harness.app.sessions, now=now) == 0
    assert unreadable.is_dir()


def test_rpc_cleanup_accepts_max_age_days(harness: Harness) -> None:
    sessions = _sessions(harness)
    now = time.time()
    crashed = _aged(_leftover(sessions, "3" * 32, closed=False), 12, now)
    result = harness.call("recovery.cleanup", {"maxAgeDays": 10})
    assert result == {"removed": 1}
    assert not crashed.exists()
