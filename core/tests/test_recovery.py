"""Crash recovery (A9, T5.10): recovery.list, restore, discard and cleanup.

A session that was not closed (the core died, stdin EOF) keeps its directory with a meta.json
whose ``closed`` flag is false. Clean closes delete the directory.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pikepdf
import pytest
from conftest import Harness, RpcFailure
from test_rpc_stdio import CoreProcess

from chef_core.session.recovery import RETENTION_SECONDS


def _session_dir(data_dir: Path, sid: str) -> Path:
    return data_dir / "sessions" / sid


def _meta(data_dir: Path, sid: str) -> dict[str, Any]:
    result: dict[str, Any] = json.loads(
        (_session_dir(data_dir, sid) / "meta.json").read_text(encoding="utf-8")
    )
    return result


def _crash(h: Harness) -> None:
    """Stop the core without closing sessions, as a crash would leave them."""
    h.close()


def test_list_reports_unclosed_sessions_after_a_crash(
    tmp_path: Path, numbered: Callable[[int], Path]
) -> None:
    src = numbered(3)
    h = Harness(tmp_path / "data")
    sid = h.open(src)["state"]["sessionId"]
    h.op("page.delete", {"pages": [0]}, sid)
    _crash(h)

    h2 = Harness(tmp_path / "data")
    try:
        entries = h2.call("recovery.list", {})
        assert len(entries) == 1
        entry = entries[0]
        assert entry["sessionId"] == sid
        assert entry["sourcePath"] == str(src)
        assert entry["revision"] == 1 and entry["pages"] == 2
        assert entry["dirty"] is True and entry["hasUnsavedChanges"] is True
        assert entry["openedAt"] and entry["lastModified"]
    finally:
        h2.close()


def test_clean_close_and_discard_are_not_listed(
    tmp_path: Path, numbered: Callable[[int], Path]
) -> None:
    h = Harness(tmp_path / "data")
    closed_sid = h.open(numbered(1))["state"]["sessionId"]
    h.call("session.close", {"sessionId": closed_sid})
    discarded_sid = h.open(numbered(1))["state"]["sessionId"]
    _crash(h)

    h2 = Harness(tmp_path / "data")
    try:
        assert [e["sessionId"] for e in h2.call("recovery.list", {})] == [discarded_sid]
        h2.call("recovery.discard", {"sessionId": discarded_sid})
        assert h2.call("recovery.list", {}) == []
    finally:
        h2.close()


def test_live_sessions_are_not_listed(harness: Harness, numbered: Callable[[int], Path]) -> None:
    harness.open(numbered(1))
    assert harness.call("recovery.list", {}) == []


def test_restore_reopens_the_last_revision(tmp_path: Path, numbered: Callable[[int], Path]) -> None:
    src = numbered(3)
    h = Harness(tmp_path / "data")
    sid = h.open(src)["state"]["sessionId"]
    h.op("page.delete", {"pages": [0]}, sid)
    h.op("page.rotate", {"pages": [0], "angle": 90}, sid)
    _crash(h)

    h2 = Harness(tmp_path / "data")
    try:
        restored = h2.call("recovery.restore", {"sessionId": sid})
        assert restored["warnings"] == []
        assert restored["state"]["sessionId"] == sid
        assert restored["state"]["revision"] == 2
        assert restored["state"]["canUndo"] is True and restored["state"]["dirty"] is True
        assert restored["info"]["pageCount"] == 2
        assert h2.call("recovery.list", {}) == []  # now live again

        h2.call("session.undo", {"sessionId": sid})
        out = tmp_path / "restored.pdf"
        state = h2.call("session.save", {"sessionId": sid, "path": str(out)})
        assert state["dirty"] is False
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == 2
    finally:
        h2.close()


def test_restore_falls_back_to_the_previous_valid_revision(
    tmp_path: Path, numbered: Callable[[int], Path]
) -> None:
    h = Harness(tmp_path / "data")
    sid = h.open(numbered(3))["state"]["sessionId"]
    h.op("page.delete", {"pages": [0]}, sid)
    h.op("page.delete", {"pages": [0]}, sid)  # rev 2 has one page
    _crash(h)
    data = tmp_path / "data"
    (_session_dir(data, sid) / "rev-0002.pdf").write_bytes(b"%PDF-1.4 truncated garbage")

    h2 = Harness(data)
    try:
        restored = h2.call("recovery.restore", {"sessionId": sid})
        assert restored["state"]["revision"] == 1
        assert restored["info"]["pageCount"] == 2
        assert any("damaged" in w for w in restored["warnings"])
        assert not (_session_dir(data, sid) / "rev-0002.pdf").exists()
    finally:
        h2.close()


def test_restore_fails_when_no_revision_is_readable(
    tmp_path: Path, numbered: Callable[[int], Path]
) -> None:
    h = Harness(tmp_path / "data")
    sid = h.open(numbered(1))["state"]["sessionId"]
    _crash(h)
    data = tmp_path / "data"
    (_session_dir(data, sid) / "rev-0000.pdf").write_bytes(b"not a pdf")

    h2 = Harness(data)
    try:
        with pytest.raises(RpcFailure) as exc:
            h2.call("recovery.restore", {"sessionId": sid})
        assert exc.value.kind == "INVALID_PDF"
        assert h2.call("recovery.list", {})[0]["sessionId"] == sid  # still recoverable
    finally:
        h2.close()


def test_restore_loses_protection_with_a_warning(tmp_path: Path, corpus: dict[str, Path]) -> None:
    h = Harness(tmp_path / "data")
    sid = h.open(corpus["vietnamese_text.pdf"])["state"]["sessionId"]
    h.op(
        "security.encrypt",
        {"userPassword": "secret-1", "permissions": {"copyContent": False}},
        sid,
    )
    _crash(h)
    data = tmp_path / "data"
    text = (_session_dir(data, sid) / "meta.json").read_text(encoding="utf-8")
    assert "secret-1" not in text

    h2 = Harness(data)
    try:
        restored = h2.call("recovery.restore", {"sessionId": sid})
        assert "pendingEncryption" not in restored["state"]
        assert any("encryption" in w.lower() for w in restored["warnings"])
        out = tmp_path / "out.pdf"
        saved = h2.call("session.save", {"sessionId": sid, "path": str(out)})
        assert saved["warnings"] == []
        with pikepdf.open(out) as pdf:
            assert not pdf.is_encrypted  # the protection was not carried over
    finally:
        h2.close()


def test_restore_of_an_encrypted_source_warns(tmp_path: Path, corpus: dict[str, Path]) -> None:
    h = Harness(tmp_path / "data")
    sid = h.open(corpus["encrypted_1234.pdf"], "1234")["state"]["sessionId"]
    _crash(h)
    h2 = Harness(tmp_path / "data")
    try:
        restored = h2.call("recovery.restore", {"sessionId": sid})
        assert any("encryption" in w.lower() for w in restored["warnings"])
        assert restored["info"]["encrypted"] is False
    finally:
        h2.close()


def test_restore_errors(tmp_path: Path, numbered: Callable[[int], Path]) -> None:
    h = Harness(tmp_path / "data")
    sid = h.open(numbered(1))["state"]["sessionId"]
    with pytest.raises(RpcFailure) as exc:  # already live
        h.call("recovery.restore", {"sessionId": sid})
    assert exc.value.kind == "INVALID_PARAMS"
    for bad in ("does-not-exist", "../escape", "a" * 32 + "/x"):
        with pytest.raises(RpcFailure) as exc:
            h.call("recovery.restore", {"sessionId": bad})
        assert exc.value.kind == "SESSION_NOT_FOUND"
    _crash(h)
    h2 = Harness(tmp_path / "data")
    try:
        with pytest.raises(RpcFailure) as exc:
            h2.call("recovery.restore", {})
        assert exc.value.kind == "INVALID_PARAMS"
    finally:
        h2.close()


def test_discard(tmp_path: Path, numbered: Callable[[int], Path]) -> None:
    h = Harness(tmp_path / "data")
    sid = h.open(numbered(1))["state"]["sessionId"]
    other = h.open(numbered(1))["state"]["sessionId"]
    _crash(h)
    data = tmp_path / "data"
    h2 = Harness(data)
    try:
        assert h2.call("recovery.discard", {"sessionId": sid}) is None
        assert not _session_dir(data, sid).exists()
        assert _session_dir(data, other).is_dir()
        with pytest.raises(RpcFailure) as exc:
            h2.call("recovery.discard", {"sessionId": sid})
        assert exc.value.kind == "SESSION_NOT_FOUND"
        with pytest.raises(RpcFailure) as exc:
            h2.call("recovery.discard", {"sessionId": "../../etc"})
        assert exc.value.kind == "SESSION_NOT_FOUND"
        live = h2.open(numbered(1))["state"]["sessionId"]
        with pytest.raises(RpcFailure) as exc:
            h2.call("recovery.discard", {"sessionId": live})
        assert exc.value.kind == "INVALID_PARAMS"
    finally:
        h2.close()


def _age(path: Path, days: float) -> None:
    old = time.time() - days * 86400
    for entry in [path, *path.glob("*")]:
        os.utime(entry, (old, old))


def test_cleanup_removes_old_closed_and_discarded_leftovers(
    harness: Harness, numbered: Callable[[int], Path]
) -> None:
    data = harness.data_dir
    live_sid = harness.open(numbered(1))["state"]["sessionId"]
    sessions = data / "sessions"

    def leftover(sid: str, closed: bool) -> Path:
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

    old_closed = leftover("a" * 32, closed=True)
    old_crashed = leftover("b" * 32, closed=False)
    fresh_closed = leftover("c" * 32, closed=True)
    _age(old_closed, RETENTION_SECONDS / 86400 + 1)
    _age(old_crashed, RETENTION_SECONDS / 86400 + 1)
    _age(sessions / live_sid, RETENTION_SECONDS / 86400 + 1)

    result = harness.call("recovery.cleanup", {})
    assert result == {"removed": 1}
    assert not old_closed.exists()
    assert old_crashed.is_dir() and fresh_closed.is_dir() and (sessions / live_sid).is_dir()


def test_session_and_recovery_survive_a_real_process_crash(
    tmp_path: Path, numbered: Callable[[int], Path]
) -> None:
    data = tmp_path / "data"
    src = numbered(4)
    first = CoreProcess(data)
    try:
        opened = first.call("session.open", {"path": str(src)})["result"]
        sid = opened["state"]["sessionId"]
        job = first.call(
            "ops.run", {"opId": "page.delete", "params": {"pages": [0]}, "sessionId": sid}
        )["result"]["jobId"]
        first.wait(lambda m: m.get("method") == "job.finished" and m["params"]["jobId"] == job)
        first.proc.kill()  # no system.shutdown: a crash
        first.proc.wait(timeout=30)
    finally:
        if first.proc.poll() is None:
            first.proc.kill()

    second = CoreProcess(data)
    try:
        listed = second.call("recovery.list", {})["result"]
        assert [e["sessionId"] for e in listed] == [sid]
        assert listed[0]["pages"] == 3 and listed[0]["hasUnsavedChanges"] is True
        restored = second.call("recovery.restore", {"sessionId": sid})
        assert "error" not in restored, restored
        assert restored["result"]["state"]["revision"] == 1
        assert restored["result"]["info"]["pageCount"] == 3
        second.call("system.shutdown", {})
        second.proc.wait(timeout=30)
    finally:
        if second.proc.poll() is None:
            second.proc.kill()
