"""Runs core operations on a PDF in-process, for the steps demo-v08.spec.ts has no UI for.

Usage: python demo_v08_core.py STEPS_JSON

STEPS_JSON is a JSON object: {"input": PDF, "output": PDF, "steps": [{"op": ID, "params": {...}}]}.
The steps run in order in one session on the real core (the same ops the UI and workflows use),
then the result is saved to "output". A param string "$prev.KEY" takes KEY from the data of the
step before (the finger proposal gives "maskPath" for the removal). Prints one JSON object with
the data of each step.
Used for: pageimg.dewarp (curved page), pageimg.proposeFingerMask + pageimg.removeFingers.
"""

from __future__ import annotations

import io
import json
import sys
import threading
import time
from pathlib import Path
from typing import Any

from chef_core.app import CoreApp


class _Sink:
    """File-like output of the core: parses the JSON-RPC lines it writes."""

    def __init__(self) -> None:
        self.messages: list[dict[str, Any]] = []
        self.cond = threading.Condition()
        self._buf = b""

    def write(self, data: bytes) -> int:
        with self.cond:
            self._buf += data
            while b"\n" in self._buf:
                line, self._buf = self._buf.split(b"\n", 1)
                self.messages.append(json.loads(line))
            self.cond.notify_all()
        return len(data)

    def flush(self) -> None:
        pass

    def wait_for(self, predicate: Any, timeout: float = 300.0) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        with self.cond:
            while True:
                for msg in self.messages:
                    if predicate(msg):
                        return msg
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("message not received")
                self.cond.wait(remaining)


spec = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
data_dir = Path(spec["output"]).parent / "core-data"
sink = _Sink()
app = CoreApp(data_dir, io.BytesIO(), sink)  # type: ignore[arg-type]
_next = [0]


def call(method: str, params: dict[str, Any] | None = None) -> Any:
    _next[0] += 1
    req_id = _next[0]
    message: dict[str, Any] = {"jsonrpc": "2.0", "id": req_id, "method": method}
    if params is not None:
        message["params"] = params
    app.server.handle_message(message)
    msg = sink.wait_for(lambda m: m.get("id") == req_id and "method" not in m)
    if "error" in msg:
        raise SystemExit(f"{method} failed: {msg['error']}")
    return msg["result"]


def resolve(value: Any, prev: dict[str, Any]) -> Any:
    if isinstance(value, str) and value.startswith("$prev."):
        return prev[value[len("$prev.") :]]
    if isinstance(value, dict):
        return {k: resolve(v, prev) for k, v in value.items()}
    if isinstance(value, list):
        return [resolve(v, prev) for v in value]
    return value


def run_op(op_id: str, params: dict[str, Any], session_id: str) -> dict[str, Any]:
    job_id = call(
        "ops.run", {"opId": op_id, "params": params, "sessionId": session_id}
    )["jobId"]
    terminal = {"job.finished", "job.failed", "job.cancelled"}
    msg = sink.wait_for(
        lambda m: m.get("method") in terminal and m["params"]["jobId"] == job_id
    )
    if msg["method"] != "job.finished":
        raise SystemExit(f"{op_id} did not finish: {msg['params']}")
    result: dict[str, Any] = msg["params"]["result"]
    return result


try:
    opened = call("session.open", {"path": spec["input"]})
    sid = str(opened["state"]["sessionId"])
    results: list[dict[str, Any]] = []
    prev: dict[str, Any] = {}
    for step in spec["steps"]:
        result = run_op(step["op"], resolve(step.get("params", {}), prev), sid)
        prev = result.get("data") or {}
        results.append({"op": step["op"], "data": prev})
    saved = call("session.save", {"sessionId": sid, "path": spec["output"]})
    print(
        json.dumps(
            {"saved": saved.get("path", spec["output"]), "steps": results},
            ensure_ascii=False,
            default=str,
        )
    )
finally:
    app.close()
