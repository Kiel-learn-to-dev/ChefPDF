"""Runs demo-v10 (docs/TASKS.md v0.10) on the REAL core: a two-column report with a ruled table is
analysed (layout.analyze) and exported to DOCX "giữ bố cục" (layout), DOCX "dễ chỉnh sửa"
(editable) and Markdown (export.document). Run with the core environment.

Usage: python demo_v10_export.py OUT_DIR   -> prints JSON with the output paths.

The report is the generated fixture of the layout tests (core/tests/layout_support.py): a title,
headings, lists, a table with a header row, an image with a caption, running header and footer
with page numbers, and two columns on most pages.
"""

import json
import os
import subprocess
import sys
import threading
import queue
from pathlib import Path

import chef_core

CORE_DIR = Path(chef_core.__file__).resolve().parent.parent
TESTS_DIR = CORE_DIR / "tests"


class Core:
    """Minimal JSON-RPC client (one JSON object per line), the same protocol the app uses."""

    def __init__(self, data_dir: Path) -> None:
        self.proc = subprocess.Popen(
            ["uv", "run", "--project", str(CORE_DIR), "python", "-m", "chef_core", "--data-dir", str(data_dir)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            encoding="utf-8",
        )
        self.lines: queue.Queue[dict] = queue.Queue()
        self.next_id = 0
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self) -> None:
        assert self.proc.stdout is not None
        for line in self.proc.stdout:
            if line.strip():
                self.lines.put(json.loads(line))
        self.lines.put({"closed": True})

    def _send(self, message: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.proc.stdin.flush()

    def call(self, method: str, params: dict | None = None, timeout: float = 300) -> dict:
        self.next_id += 1
        req = self.next_id
        self._send({"jsonrpc": "2.0", "id": req, "method": method, "params": params or {}})
        while True:
            msg = self.lines.get(timeout=timeout)
            if msg.get("id") == req:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg["result"]

    def op(self, op_id: str, params: dict, session_id: str | None = None, timeout: float = 300) -> dict:
        body: dict = {"opId": op_id, "params": params}
        if session_id:
            body["sessionId"] = session_id
        job = self.call("ops.run", body, timeout=timeout)["jobId"]
        while True:
            msg = self.lines.get(timeout=timeout)
            if msg.get("method") == "job.finished" and msg["params"]["jobId"] == job:
                return msg["params"]["result"]
            if msg.get("method") in ("job.failed", "job.cancelled") and msg["params"]["jobId"] == job:
                raise RuntimeError(f"{op_id} did not finish: {msg}")

    def close(self) -> None:
        try:
            self.call("system.shutdown", {}, timeout=30)
        except Exception:
            pass
        self.proc.wait(timeout=30)


def main() -> None:
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(TESTS_DIR))
    from layout_support import report_pdf  # the two-column report fixture of the layout tests

    source = report_pdf(out / "report.pdf", pages=6)
    core = Core(out / "data")
    try:
        sid = core.call("session.open", {"path": str(source)})["state"]["sessionId"]
        analysis = core.op("layout.analyze", {}, session_id=sid)
        model = analysis["data"]["modelPath"]
        results = {"summary": analysis["data"]["summary"], "files": {}}
        for key, fmt, options, name in [
            ("layoutDocx", "docx", {"mode": "layout"}, "giu-bo-cuc.docx"),
            ("editableDocx", "docx", {"mode": "editable"}, "de-chinh-sua.docx"),
            ("markdown", "md", {}, "bao-cao.md"),
        ]:
            target = out / name
            core.op(
                "export.document",
                {"format": fmt, "outputPath": str(target), "options": options, "modelPath": model},
                session_id=sid,
            )
            results["files"][key] = str(target)
        core.call("session.close", {"sessionId": sid})
    finally:
        core.close()
    print(json.dumps(results, ensure_ascii=False))


if __name__ == "__main__":
    os.environ.setdefault("PYTHONUTF8", "1")
    main()
