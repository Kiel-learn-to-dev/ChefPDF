"""JSON (T10.04, N4): the document model as it is, plus a ``text`` field (reading order).

The model keeps every block (furniture included), so that nothing is lost. ``pages`` keeps only the
selected pages. ``text`` follows the same rules as the TXT export (furniture only when asked).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from chef_core.export.files import write_text
from chef_core.export.ir import DocIR, ExportResult
from chef_core.export.txt import render_text
from chef_core.layout.model import DocModel


def render_json(model: DocModel, ir: DocIR, pages: list[int] | None) -> str:
    data: dict[str, Any] = model.model_dump(mode="json", by_alias=True)
    if pages is not None:
        keep = set(pages)
        data["pages"] = [p for p in data["pages"] if p["index"] in keep]
    data["version"] = model.version
    data["text"] = render_text(ir, page_markers=False)
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def write_json(model: DocModel, ir: DocIR, out: Path, pages: list[int] | None) -> ExportResult:
    write_text(out, render_json(model, ir, pages))
    return ExportResult(
        outputs=[str(out)],
        warnings=list(ir.warnings),
        stats={"blocks": len(ir.items)},
    )
