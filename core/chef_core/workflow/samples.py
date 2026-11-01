"""Built-in sample workflows (T9.07): JSON data under ``chef_core/resources/workflows``.

The files are ours, so a sample that does not validate is a bug: :func:`load_samples` raises.
"""

from __future__ import annotations

import functools
from pathlib import Path

from chef_core.workflow.model import Workflow, from_json

SAMPLE_DIR = Path(__file__).resolve().parents[1] / "resources" / "workflows"


@functools.cache
def load_samples() -> tuple[Workflow, ...]:
    """Every sample, in file-name order (the numbers in the names keep the menu order)."""
    flows: list[Workflow] = []
    for path in sorted(SAMPLE_DIR.glob("*.json")):
        flows.append(from_json(path.read_text(encoding="utf-8")))
    return tuple(flows)
