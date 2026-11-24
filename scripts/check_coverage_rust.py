#!/usr/bin/env python3
"""Độ phủ tính năng của bản Rust (TASKS_RUST R9.11): mỗi mã tính năng trong phạm vi (FEATURES.md) có task nào,
và các task đó xong đến đâu.

Phạm vi: mã có mức v0.1 đến v0.10 hoặc v1.0, v1.1 trong FEATURES.md (mã "Đã bỏ" tự loại).
Một mã được xếp: "đạt" khi mọi task của nó là ✅ (bỏ qua ❌); "một phần" khi có task ✅ hoặc 🔄 nhưng chưa hết;
"chưa làm" khi mọi task đều ⬜; "không có task" khi không task nào nhắc tới.

Dùng: python3 scripts/check_coverage_rust.py [--list]   (--list in từng mã). Thoát 1 khi có mã không có task.
"""

from __future__ import annotations

import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_coverage import expand_feature_references, markdown_cells  # noqa: E402

FEATURE_CODE = re.compile(r"[A-Q]\d+")
IN_SCOPE = re.compile(r"v0\.(?:[1-9]|10)|v1\.0|v1\.1")
TASK_HEAD = re.compile(r"^### (R\d+\.\d+[a-z]?) · ", re.M)
STATUS = re.compile(r"\*\*Trạng thái:\*\* (\S+)")
FEATURE_LINE = re.compile(r"^- \*\*Tính năng:\*\* (.*)$", re.M)


def parse_features(markdown: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in markdown.splitlines():
        if not line.lstrip().startswith("|"):
            continue
        cells = markdown_cells(line)
        if len(cells) >= 3 and FEATURE_CODE.fullmatch(cells[0]):
            out[cells[0]] = cells[-1]
    return out


def parse_tasks(markdown: str) -> dict[str, list[tuple[str, str]]]:
    """Mã tính năng -> [(mã task, trạng thái)]."""
    heads = list(TASK_HEAD.finditer(markdown))
    cover: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for i, h in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(markdown)
        body = markdown[h.end() : end]
        st = STATUS.search(body)
        feat = FEATURE_LINE.search(body)
        if not st or not feat:
            continue
        for code in expand_feature_references(feat.group(1)):
            cover[code].append((h.group(1), st.group(1)))
    return cover


def classify(tasks: list[tuple[str, str]]) -> str:
    live = [s for _, s in tasks if s != "❌"]
    if not tasks:
        return "không có task"
    if not live:
        return "đã bỏ"
    if all(s == "✅" for s in live):
        return "đạt"
    if any(s in ("✅", "🔄") for s in live):
        return "một phần"
    return "chưa làm"


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    features = parse_features((root / "docs" / "FEATURES.md").read_text(encoding="utf-8"))
    scope = sorted((c for c, lvl in features.items() if IN_SCOPE.fullmatch(lvl)), key=lambda c: (c[0], int(c[1:])))
    cover = parse_tasks((root / "docs" / "TASKS_RUST.md").read_text(encoding="utf-8"))
    groups: dict[str, list[str]] = defaultdict(list)
    for code in scope:
        groups[classify(cover.get(code, []))].append(code)
    print(f"Phạm vi: {len(scope)} mã")
    for name in ("đạt", "một phần", "chưa làm", "đã bỏ", "không có task"):
        print(f"  {name}: {len(groups[name])}")
    if "--list" in sys.argv:
        for name in ("một phần", "chưa làm", "không có task"):
            print(f"\n{name}: " + ", ".join(groups[name]))
    return 1 if groups["không có task"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
