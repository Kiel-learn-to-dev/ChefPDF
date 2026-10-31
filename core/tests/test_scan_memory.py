"""Memory of scan.rasterize on a larger job (T2.04). The slow benchmark-style test is opt-in.

Run it with ``CHEF_SLOW=1 uv run pytest tests/test_scan_memory.py -m slow``. The benchmark
itself (500 pages at 600 dpi, 100 pages at 200 dpi) is ``scripts/bench_scan.py``.
"""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from types import ModuleType

import pytest

from chef_core.ops import load_builtin_ops

REPO_ROOT = Path(__file__).resolve().parents[2]
BENCH = REPO_ROOT / "scripts" / "bench_scan.py"
# Loose bound: the render workers alone (four Python processes) take roughly 300 MB, and the
# 60 pages at 150 dpi add little. The old in-memory assembly grew with the output size.
PEAK_DELTA_LIMIT_MB = 900.0


def _load_bench() -> ModuleType:
    spec = importlib.util.spec_from_file_location("bench_scan", BENCH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture(autouse=True)
def _builtins() -> None:
    load_builtin_ops()


@pytest.mark.slow
@pytest.mark.skipif(os.environ.get("CHEF_SLOW") != "1", reason="set CHEF_SLOW=1 to run")
def test_sixty_pages_at_150dpi_peak_memory_is_bounded(tmp_path: Path) -> None:
    bench = _load_bench()
    src = bench.build_source(tmp_path / "source60.pdf", 60)
    result = bench.run_rasterize(src, tmp_path / "work", 60, 150, "gray")
    assert result["outputBytes"] > 0
    assert result["treePeakDeltaMB"] < PEAK_DELTA_LIMIT_MB, result
