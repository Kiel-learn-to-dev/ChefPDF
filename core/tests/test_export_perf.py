"""Performance of the exporters on a 50-page document: each under 25 s (T10.04, T10.05)."""

from __future__ import annotations

import time
from pathlib import Path

import pikepdf
from layout_support import report_pdf

from chef_core.export.options import ExportOptions
from chef_core.export.run import load_model, run_export

LIMIT_SECONDS = 25.0


def test_fifty_pages_md_html_docx_each_under_the_limit(tmp_path: Path) -> None:
    src = report_pdf(tmp_path / "big.pdf", pages=50)
    assert len(pikepdf.open(src).pages) == 50
    model = load_model(src, None, None, "big")
    cases = [
        ("md", "big.md", ExportOptions()),
        ("html", "big.html", ExportOptions()),
        ("docx", "big-editable.docx", ExportOptions(mode="editable")),
        ("docx", "big-layout.docx", ExportOptions(mode="layout")),
    ]
    timings: dict[str, float] = {}
    for fmt, name, opts in cases:
        started = time.monotonic()
        run_export(model, src, None, fmt, tmp_path / name, None, opts, name="big")  # type: ignore[arg-type]
        timings[name] = time.monotonic() - started
    slow = {name: round(t, 2) for name, t in timings.items() if t >= LIMIT_SECONDS}
    assert not slow, f"over {LIMIT_SECONDS} s: {slow} (all: {timings})"
