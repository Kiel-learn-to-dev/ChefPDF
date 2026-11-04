"""JSON-RPC framing against a real ``python -m chef_core`` subprocess."""

from __future__ import annotations

import json
import queue
import subprocess
import sys
import threading
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

TIMEOUT = 30.0


class CoreProcess:
    def __init__(self, data_dir: Path) -> None:
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "chef_core", "--data-dir", str(data_dir)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.lines: queue.Queue[dict[str, Any]] = queue.Queue()
        self.raw_lines: list[bytes] = []
        self.stderr = b""
        self._reader = threading.Thread(target=self._read, daemon=True)
        self._reader.start()
        self._err_reader = threading.Thread(target=self._read_err, daemon=True)
        self._err_reader.start()
        self._next_id = 0

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            self.raw_lines.append(line)
            self.lines.put(json.loads(line))

    def _read_err(self) -> None:
        assert self.proc.stderr is not None
        self.stderr = self.proc.stderr.read()

    def send_raw(self, data: bytes) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def send(self, message: dict[str, Any]) -> None:
        self.send_raw(json.dumps(message).encode() + b"\n")

    def request(self, method: str, params: Any = None) -> int:
        self._next_id += 1
        message: dict[str, Any] = {"jsonrpc": "2.0", "id": self._next_id, "method": method}
        if params is not None:
            message["params"] = params
        self.send(message)
        return self._next_id

    def next(self) -> dict[str, Any]:
        return self.lines.get(timeout=TIMEOUT)

    def wait(self, predicate: Callable[[dict[str, Any]], bool]) -> dict[str, Any]:
        while True:
            msg = self.next()
            if predicate(msg):
                return msg

    def call(self, method: str, params: Any = None) -> dict[str, Any]:
        req = self.request(method, params)
        return self.wait(lambda m: m.get("id") == req)

    def close_stdin(self) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.close()


@pytest.fixture
def core(tmp_path: Path) -> Iterator[CoreProcess]:
    proc = CoreProcess(tmp_path / "data")
    try:
        yield proc
    finally:
        if proc.proc.poll() is None:
            proc.proc.kill()
        proc.proc.wait(timeout=TIMEOUT)


def test_ping(core: CoreProcess) -> None:
    response = core.call("system.ping", {})
    assert response["jsonrpc"] == "2.0"
    assert set(response["result"]) == {"version", "python"}
    assert response["result"]["python"].startswith("3.")


def test_parse_error(core: CoreProcess) -> None:
    core.send_raw(b"{not json\n")
    response = core.next()
    assert response["id"] is None
    assert response["error"]["code"] == -32700
    assert response["error"]["data"]["kind"] == "INVALID_PARAMS"
    # The server keeps working after garbage input, including invalid UTF-8.
    core.send_raw(b"\xff\xfe\n")
    assert core.next()["error"]["code"] == -32700
    assert "result" in core.call("system.ping")


def test_invalid_requests(core: CoreProcess) -> None:
    core.send_raw(b"[1, 2]\n")
    assert core.next()["error"]["code"] == -32600
    core.send({"jsonrpc": "1.0", "id": 5, "method": "system.ping"})
    response = core.next()
    assert response["id"] == 5 and response["error"]["code"] == -32600
    core.send({"jsonrpc": "2.0", "id": 6, "method": "system.ping", "params": [1]})
    response = core.next()
    assert response["id"] == 6 and response["error"]["code"] == -32602


def test_unknown_method(core: CoreProcess) -> None:
    response = core.call("nope.nothing", {})
    assert response["error"]["code"] == -32601
    assert response["error"]["data"]["kind"] == "OP_NOT_FOUND"


def test_invalid_params(core: CoreProcess) -> None:
    response = core.call("session.open", {"path": 42})
    assert response["error"]["code"] == -32602
    assert response["error"]["data"]["kind"] == "INVALID_PARAMS"
    response = core.call("ops.run", {"opId": "page.rotate", "sessionId": "x", "params": {}})
    assert response["error"]["code"] == -32602


def test_notifications_get_no_response(core: CoreProcess) -> None:
    core.send({"jsonrpc": "2.0", "method": "system.ping"})
    core.send({"jsonrpc": "2.0", "method": "nope.nothing"})
    req = core.request("system.ping")
    assert core.next()["id"] == req


def test_string_ids_and_unicode(core: CoreProcess, tmp_path: Path) -> None:
    core.send(
        {
            "jsonrpc": "2.0",
            "id": "abc",
            "method": "session.open",
            "params": {"path": str(tmp_path / "tài liệu không có.pdf")},
        }
    )
    response = core.next()
    assert response["id"] == "abc"
    assert response["error"]["data"]["kind"] == "FILE_NOT_FOUND"
    assert "tài liệu" in response["error"]["data"]["detail"]["path"]


def test_full_flow_over_stdio(core: CoreProcess, corpus: dict[str, Path]) -> None:
    opened = core.call("session.open", {"path": str(corpus["outline_10p.pdf"])})["result"]
    sid = opened["state"]["sessionId"]
    assert opened["info"]["pageCount"] == 10
    req = core.request(
        "ops.run",
        {"sessionId": sid, "opId": "page.rotate", "params": {"pages": [0, 1], "angle": 90}},
    )
    response = core.next()  # the response comes before any job notification
    assert response["id"] == req
    job_id = response["result"]["jobId"]
    final = core.wait(lambda m: m.get("method") in ("job.finished", "job.failed"))
    assert final["method"] == "job.finished" and final["params"]["jobId"] == job_id
    assert final["params"]["result"]["changedPages"] == [0, 1]
    assert core.call("session.undo", {"sessionId": sid})["result"]["state"]["revision"] == 0


def test_shutdown(core: CoreProcess, numbered: Callable[[int], Path], tmp_path: Path) -> None:
    sid = core.call("session.open", {"path": str(numbered(1))})["result"]["state"]["sessionId"]
    response = core.call("system.shutdown", {})
    assert response["result"] is None
    assert core.proc.wait(timeout=TIMEOUT) == 0
    assert not (tmp_path / "data" / "sessions" / sid).exists()
    # Every line on stdout was JSON-RPC.
    assert all(json.loads(line)["jsonrpc"] == "2.0" for line in core.raw_lines)


def test_requests_in_flight_at_shutdown_are_answered(
    core: CoreProcess, corpus: dict[str, Path]
) -> None:
    lines = [
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "session.open",
            "params": {"path": str(corpus["scanned_like.pdf"])},
        },
        {"jsonrpc": "2.0", "id": 2, "method": "session.create"},
        {"jsonrpc": "2.0", "id": 3, "method": "system.shutdown"},
    ]
    core.send_raw(b"".join(json.dumps(m).encode() + b"\n" for m in lines))
    assert core.proc.wait(timeout=TIMEOUT) == 0
    core._reader.join(timeout=TIMEOUT)
    responses = {}
    while not core.lines.empty():
        msg = core.lines.get_nowait()
        responses[msg["id"]] = msg
    assert set(responses) == {1, 2, 3}
    assert all("result" in r for r in responses.values())


def test_eof_exits_cleanly(core: CoreProcess) -> None:
    assert "result" in core.call("system.ping")
    core.close_stdin()
    assert core.proc.wait(timeout=TIMEOUT) == 0
    core._err_reader.join(timeout=TIMEOUT)
    assert b"stdin closed" in core.stderr  # logs go to stderr


def test_missing_data_dir_argument() -> None:
    proc = subprocess.run(
        [sys.executable, "-m", "chef_core"], capture_output=True, timeout=TIMEOUT, check=False
    )
    assert proc.returncode != 0
    assert proc.stdout == b""


def test_stray_stdout_writes_go_to_stderr() -> None:
    script = (
        "import os, sys\n"
        "from chef_core.__main__ import _claim_stdout\n"
        "out = _claim_stdout()\n"
        "print('stray print')\n"
        "sys.stdout.flush()\n"
        "os.write(1, b'native write\\n')\n"
        'out.write(b\'{"jsonrpc":"2.0"}\\n\')\n'
        "out.flush()\n"
    )
    proc = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, timeout=TIMEOUT, check=True
    )
    assert proc.stdout == b'{"jsonrpc":"2.0"}\n'
    assert b"stray print" in proc.stderr and b"native write" in proc.stderr


def test_rasterize_with_worker_processes_finishes_while_stdin_is_open(
    core: CoreProcess, numbered: Callable[[int], Path]
) -> None:
    """Regression: the rasterize pool workers used to inherit the RPC stdin pipe and never started,
    so a rasterize of POOL_MIN_PAGES or more pages hung while the client kept stdin open (the app
    always does). The core now gives the workers the null device on stdin
    (__main__._claim_stdin)."""
    from chef_core.ops.scan import POOL_MIN_PAGES

    count = POOL_MIN_PAGES + 4
    sid = core.call("session.open", {"path": str(numbered(count))})["result"]["state"]["sessionId"]
    req = core.request(
        "ops.run",
        {"sessionId": sid, "opId": "scan.rasterize", "params": {"dpi": 72, "color": "gray"}},
    )
    job_id = core.wait(lambda m: m.get("id") == req)["result"]["jobId"]
    final = core.wait(
        lambda m: (
            m.get("method") in ("job.finished", "job.failed") and m["params"]["jobId"] == job_id
        )
    )
    assert final["method"] == "job.finished", final
    assert final["params"]["result"]["changedPages"] == list(range(count))
    assert "result" in core.call("session.close", {"sessionId": sid})
