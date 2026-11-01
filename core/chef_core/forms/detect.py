"""EXPERIMENTAL (H2, "tạo ô điền từ chỗ trống"): propose text-field rectangles from blank lines.

Read only. Finds text lines that end in a run of underscores ("____"), dots ("......") or
ellipses, and proposes a text field over that run. The label is the text before the run. Each
proposal carries a confidence (0 to 1): it is higher for longer runs that follow a label.

Not covered: boxes drawn as vector rectangles, table cells, and blanks that are not in the text
layer (scans). The result is a suggestion for the user to accept, never applied by itself.
"""

from __future__ import annotations

import re
from typing import Any

from chef_core.forms.model import FormDoc
from chef_core.text.build import build_text_page

BLANK = re.compile(r"(_{4,}|\.{6,}|…{3,})")
LABEL_TRIM = " :.…_\t"


def detect(fd: FormDoc, pages: set[int] | None = None) -> list[dict[str, Any]]:
    proposals: list[dict[str, Any]] = []
    for index, page in enumerate(fd.pdf.pages):
        if pages is not None and index not in pages:
            continue
        tp = build_text_page(fd.pdf, page, index)
        for line in tp.lines:
            for match in BLANK.finditer(line.text):
                proposal = _proposal(fd, tp, line, index, match.start(), match.end())
                if proposal is not None:
                    proposals.append(proposal)
    return proposals


def _proposal(
    fd: FormDoc, tp: Any, line: Any, index: int, start: int, end: int
) -> dict[str, Any] | None:
    chars = [
        line.chars[line.display_map[i]]
        for i in range(start, end)
        if i < len(line.display_map) and line.display_map[i] is not None
    ]
    if not chars:
        return None
    x0 = min(c.x0 for c in chars)
    x1 = max(c.x1 for c in chars)
    size = line.font_size or max(c.size for c in chars) or 10.0
    baseline = line.baseline
    user = (x0, baseline - 0.2 * size, x1, baseline + 1.0 * size)
    rect = tp.display_box(user)
    label = line.text[:start].strip(LABEL_TRIM)
    run = end - start
    confidence = 0.5 + min(0.3, 0.05 * run) + (0.2 if label else 0.0)
    return {
        "page": index,
        "rect": [round(v, 3) for v in rect],
        "label": label or None,
        "text": line.text.strip(),
        "confidence": round(min(confidence, 0.95), 2),
        "source": "blank-line",
        "experimental": True,
    }
