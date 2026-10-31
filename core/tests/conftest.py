"""Shared fixtures: generated corpus, an in-process RPC harness and small PDF builders."""

from __future__ import annotations

import importlib.util
import io
import json
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pikepdf
import pytest

from chef_core.app import CoreApp

REPO_ROOT = Path(__file__).resolve().parents[2]
GEN_CORPUS = REPO_ROOT / "scripts" / "gen_corpus.py"


def _load_generator() -> Any:
    spec = importlib.util.spec_from_file_location("gen_corpus", GEN_CORPUS)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="session")
def corpus(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    """Generate the corpus once per test session into a temp dir."""
    out = tmp_path_factory.mktemp("corpus")
    files: dict[str, Path] = _load_generator().generate(out)
    return files


@pytest.fixture(scope="session")
def gen_corpus_module() -> Any:
    return _load_generator()


class RpcFailure(Exception):
    def __init__(self, error: dict[str, Any]) -> None:
        super().__init__(error.get("message"))
        self.error = error
        self.code: int = error["code"]
        self.kind: str | None = (error.get("data") or {}).get("kind")
        self.detail: Any = (error.get("data") or {}).get("detail")


class _Capture:
    """File-like sink for the server output; parses each line as JSON."""

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

    def wait_for(
        self, predicate: Callable[[dict[str, Any]], bool], timeout: float = 60.0
    ) -> dict[str, Any]:
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


class Harness:
    """Drives a ``CoreApp`` in-process through its JSON-RPC dispatcher."""

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.out = _Capture()
        self.app = CoreApp(data_dir, io.BytesIO(), self.out)  # type: ignore[arg-type]
        self._next_id = 0
        self._lock = threading.Lock()

    def send(self, method: str, params: dict[str, Any] | None = None) -> int:
        with self._lock:
            self._next_id += 1
            req_id = self._next_id
        message: dict[str, Any] = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            message["params"] = params
        self.app.server.handle_message(message)
        return req_id

    def response(self, req_id: int, timeout: float = 60.0) -> Any:
        msg = self.out.wait_for(lambda m: m.get("id") == req_id and "method" not in m, timeout)
        if "error" in msg:
            raise RpcFailure(msg["error"])
        return msg["result"]

    def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        return self.response(self.send(method, params))

    def notifications(self, job_id: str) -> list[dict[str, Any]]:
        with self.out.cond:
            return [
                m
                for m in self.out.messages
                if m.get("method", "").startswith("job.")
                and m.get("params", {}).get("jobId") == job_id
            ]

    def wait_job(self, job_id: str, timeout: float = 60.0) -> dict[str, Any]:
        terminal = {"job.finished", "job.failed", "job.cancelled"}
        return self.out.wait_for(
            lambda m: m.get("method") in terminal and m["params"]["jobId"] == job_id, timeout
        )

    def start_op(self, op_id: str, params: dict[str, Any], session_id: str | None = None) -> str:
        body: dict[str, Any] = {"opId": op_id, "params": params}
        if session_id is not None:
            body["sessionId"] = session_id
        job_id: str = self.call("ops.run", body)["jobId"]
        return job_id

    def op(
        self, op_id: str, params: dict[str, Any], session_id: str | None = None
    ) -> dict[str, Any]:
        """Run an op and return its OpResult; raise RpcFailure if the job failed."""
        msg = self.wait_job(self.start_op(op_id, params, session_id))
        if msg["method"] == "job.failed":
            raise RpcFailure(msg["params"]["error"])
        assert msg["method"] == "job.finished", msg
        result: dict[str, Any] = msg["params"]["result"]
        return result

    def open(self, path: Path, password: str | None = None) -> dict[str, Any]:
        params: dict[str, Any] = {"path": str(path)}
        if password is not None:
            params["password"] = password
        result: dict[str, Any] = self.call("session.open", params)
        return result

    def close(self) -> None:
        self.app.close()


@pytest.fixture
def harness(tmp_path: Path) -> Iterator[Harness]:
    h = Harness(tmp_path / "data")
    try:
        yield h
    finally:
        h.close()


def make_numbered_pdf(path: Path, count: int) -> Path:
    """Pages whose MediaBox width is 100 + index, to identify pages after edits."""
    pdf = pikepdf.new()
    for i in range(count):
        pdf.add_blank_page(page_size=(100 + i, 200))
    pdf.save(path)
    return path


def page_widths(path: Path | str, password: str = "") -> list[int]:
    with pikepdf.open(path, password=password) as pdf:
        return [round(float(p.mediabox[2]) - float(p.mediabox[0])) for p in pdf.pages]


def page_count(path: Path | str, password: str = "") -> int:
    with pikepdf.open(path, password=password) as pdf:
        return len(pdf.pages)


@pytest.fixture
def numbered(tmp_path: Path) -> Callable[[int], Path]:
    def build(count: int) -> Path:
        return make_numbered_pdf(tmp_path / f"numbered_{count}.pdf", count)

    return build
