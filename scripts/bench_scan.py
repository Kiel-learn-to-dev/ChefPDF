"""Benchmark scan.rasterize on a generated text-heavy document (T2.04).

Usage (from core/, so chef_core is importable through the project venv)::

    uv run python ../scripts/bench_scan.py --pages 500 --dpi 600 --color gray --json out.json

The source PDF is generated with reportlab (vector Be Vietnam Pro text, a few embedded
images) and cached next to the JSON output. The operation runs in this process; its render
workers are child processes. Memory is the peak RSS of the whole process tree, sampled every
50 ms (no psutil dependency): ctypes toolhelp + GetProcessMemoryInfo on Windows, ``ps`` on
POSIX. The main process peak is exact (PeakWorkingSetSize / ru_maxrss).
"""

from __future__ import annotations

import argparse
import contextlib
import ctypes
import io
import json
import os
import platform
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Self

REPO_ROOT = Path(__file__).resolve().parents[1]
FONTS = REPO_ROOT / "tests" / "corpus" / "fonts"
MIB = 1024 * 1024

SAMPLE_INTERVAL = 0.05

# -- process tree RSS -------------------------------------------------------------------


def _tree_rss_posix() -> dict[int, int]:
    """pid -> (ppid, rss bytes) for every process, via ps (macOS and Linux)."""
    out = subprocess.run(
        ["ps", "-A", "-o", "pid=,ppid=,rss="],
        capture_output=True,
        text=True,
        check=False,
    ).stdout
    table: dict[int, tuple[int, int]] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 3:
            table[int(parts[0])] = (int(parts[1]), int(parts[2]) * 1024)
    return table


def _process_table_windows() -> dict[int, tuple[int, int]]:  # pragma: no cover - Windows only
    from ctypes import wintypes

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_void_p),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", ctypes.c_wchar * 260),
        ]

    class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
            ("PrivateUsage", ctypes.c_size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.OpenProcess.restype = wintypes.HANDLE
    snap = kernel32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    entry = PROCESSENTRY32W()
    entry.dwSize = ctypes.sizeof(entry)
    table: dict[int, tuple[int, int]] = {}
    ok = kernel32.Process32FirstW(snap, ctypes.byref(entry))
    while ok:
        pid = int(entry.th32ProcessID)
        rss = 0
        handle = kernel32.OpenProcess(0x0410, False, pid)  # QUERY_INFORMATION | VM_READ
        if handle:
            counters = PROCESS_MEMORY_COUNTERS_EX()
            counters.cb = ctypes.sizeof(counters)
            if psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
                rss = int(counters.WorkingSetSize)
            kernel32.CloseHandle(handle)
        table[pid] = (int(entry.th32ParentProcessID), rss)
        ok = kernel32.Process32NextW(snap, ctypes.byref(entry))
    kernel32.CloseHandle(snap)
    return table


def _tree_rss() -> int:
    """Summed RSS of this process and all its descendants, in bytes."""
    table = _process_table_windows() if sys.platform == "win32" else _tree_rss_posix()
    children: dict[int, list[int]] = {}
    for pid, (ppid, _) in table.items():
        children.setdefault(ppid, []).append(pid)
    total = 0
    stack = [os.getpid()]
    seen: set[int] = set()
    while stack:
        pid = stack.pop()
        if pid in seen:
            continue
        seen.add(pid)
        if pid in table:
            total += table[pid][1]
        stack.extend(children.get(pid, []))
    return total


def main_peak_bytes() -> int:
    """Exact peak of this process: PeakWorkingSetSize on Windows, ru_maxrss elsewhere."""
    if sys.platform == "win32":  # pragma: no cover - Windows only
        from ctypes import wintypes

        class PMC(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD),
                ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        psapi = ctypes.WinDLL("psapi")
        counters = PMC()
        counters.cb = ctypes.sizeof(counters)
        current = ctypes.c_void_p(-1)  # pseudo-handle of the current process
        psapi.GetProcessMemoryInfo(current, ctypes.byref(counters), counters.cb)
        return int(counters.PeakWorkingSetSize)
    import resource

    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(peak) if sys.platform == "darwin" else int(peak) * 1024


class TreeSampler:
    """Context manager: samples the process-tree RSS in a thread and keeps the peak."""

    def __init__(self, interval: float = SAMPLE_INTERVAL) -> None:
        self.interval = interval
        self.baseline = 0
        self.peak = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.is_set():
            with contextlib.suppress(Exception):
                self.peak = max(self.peak, _tree_rss())
            self._stop.wait(self.interval)

    def __enter__(self) -> Self:
        self.baseline = _tree_rss()
        self.peak = self.baseline
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        self._thread.join()
        with contextlib.suppress(Exception):
            self.peak = max(self.peak, _tree_rss())


# -- source document ------------------------------------------------------------------

PARAGRAPH = (
    "Chef PDF là ứng dụng xử lý tài liệu PDF trên máy tính. Người dùng mở tệp, sắp xếp trang, "
    "ký số và chuyển thành bản scan với độ phân giải tùy chọn. Đoạn văn số {n} có nội dung "
    "dài để mô phỏng một trang văn bản đầy chữ, gồm nhiều dòng liên tiếp và các dấu thanh "
    "tiếng Việt như ắ, ệ, ồ, ử, ỹ để kiểm tra phông chữ. "
)


def build_source(path: Path, pages: int, image_every: int = 100) -> Path:
    """Text-heavy A4 pages (vector text, ~60 lines each) with a few embedded images."""
    from PIL import Image
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    pdfmetrics.registerFont(TTFont("BeVietnamPro", str(FONTS / "BeVietnamPro-Regular.ttf")))
    gradient = Image.linear_gradient("L").resize((1200, 800)).convert("RGB")
    gradient_path = path.with_suffix(".gradient.png")
    gradient.save(gradient_path)

    _width, height = A4
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setTitle("Chef PDF benchmark source")
    for index in range(pages):
        c.setFont("BeVietnamPro", 9.5)
        y = height - 50
        for line_no in range(60):
            text = PARAGRAPH.format(n=index * 60 + line_no)[: 78 + (line_no % 7) * 2]
            c.drawString(50, y, f"{index + 1}.{line_no + 1} {text}")
            y -= 13.5
        if index % image_every == 0:
            c.drawImage(str(gradient_path), 50, 80, width=300, height=200)
        c.showPage()
    c.save()
    gradient_path.unlink(missing_ok=True)
    return path


# -- run ------------------------------------------------------------------------------


def run_rasterize(src: Path, work: Path, pages: int, dpi: int, color: str) -> dict[str, Any]:
    import pikepdf

    from chef_core.ops import load_builtin_ops, scan
    from chef_core.ops.base import OpContext, get_op

    load_builtin_ops()
    spec = get_op("scan.rasterize")
    assert spec is not None
    params = spec.params_model.model_validate({"dpi": dpi, "color": color})
    work.mkdir(parents=True, exist_ok=True)
    out = work / "out.pdf"
    out.unlink(missing_ok=True)
    ctx = OpContext(job_id="bench", work_dir=work, input_path=src, result_path=out)

    with TreeSampler() as sampler:
        start = time.perf_counter()
        spec.run(ctx, params)
        elapsed = time.perf_counter() - start
    workers = scan.MAX_WORKERS  # code before the RAM guard: every worker renders a page at once
    if hasattr(scan, "worker_count"):
        with pikepdf.open(src) as pdf:
            per_page = scan.largest_page_bytes(pdf, list(range(len(pdf.pages))), dpi)
        workers = scan.worker_count(per_page, scan.MAX_WORKERS, scan.ram_budget_bytes())
    return {
        "seconds": round(elapsed, 3),
        "outputBytes": out.stat().st_size,
        "treePeakRssMB": round(sampler.peak / MIB, 1),
        "treeBaselineRssMB": round(sampler.baseline / MIB, 1),
        "treePeakDeltaMB": round((sampler.peak - sampler.baseline) / MIB, 1),
        "mainPeakRssMB": round(main_peak_bytes() / MIB, 1),
        "maxWorkers": workers,
        "ramBudgetMB": round(getattr(scan, "ram_budget_bytes", lambda: 0)() / MIB),
        "pagesPerSecond": round(pages / elapsed, 3) if elapsed else None,
    }


def bench(pages: int, dpi: int, color: str, cache: Path) -> dict[str, Any]:
    cache.mkdir(parents=True, exist_ok=True)
    src = cache / f"bench_src_{pages}p.pdf"
    if not src.exists():
        build_source(src, pages)
    result = run_rasterize(src, cache / f"work_{pages}p_{dpi}dpi_{color}", pages, dpi, color)
    return {
        "pages": pages,
        "dpi": dpi,
        "color": color,
        "platform": platform.platform(),
        "python": platform.python_version(),
        "cpuCount": os.cpu_count(),
        "sourceBytes": src.stat().st_size,
        **result,
    }


def summary_line(r: dict[str, Any]) -> str:
    return (
        f"{r['pages']}p @ {r['dpi']}dpi {r['color']}: {r['seconds']:.1f} s, "
        f"tree peak RSS {r['treePeakRssMB']:.0f} MB (delta {r['treePeakDeltaMB']:.0f} MB), "
        f"main peak {r['mainPeakRssMB']:.0f} MB, output {r['outputBytes'] / MIB:.2f} MB, "
        f"workers {r['maxWorkers']}"
    )


def _parse(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--pages", type=int, default=500)
    parser.add_argument("--dpi", type=int, default=600)
    parser.add_argument("--color", choices=["color", "gray", "bw"], default="gray")
    parser.add_argument("--cache", type=Path, default=Path("bench_cache"))
    parser.add_argument("--json", type=Path, default=None, help="write the result as JSON")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse(argv)
    result = bench(args.pages, args.dpi, args.color, args.cache)
    print(summary_line(result))
    if args.json is not None:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
    raise SystemExit(main())
