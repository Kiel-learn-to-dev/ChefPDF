#!/usr/bin/env python3
"""Check that every v1.0 feature in FEATURES.md is covered by a task in TASKS.md."""

from __future__ import annotations

import re
import sys
from collections import defaultdict
from pathlib import Path

FEATURE_CODE = re.compile(r"[A-Q]\d+")
FEATURE_REFERENCE = re.compile(r"(?<![A-Z0-9])([A-Q])(\d+)(?:\s*[–-]\s*([A-Q]?\d+))?")
TASK_CODE = re.compile(r"T\d{1,2}\.\d{2}")
IN_SCOPE_LEVEL = re.compile(r"v0\.(?:[1-9]|10)")


def markdown_cells(line: str) -> list[str]:
    """Split a simple Markdown table row into trimmed cells."""
    return [cell.strip() for cell in line.strip().strip("|").split("|")]


def parse_features(markdown: str) -> dict[str, str]:
    """Return feature codes and their release level from FEATURES.md."""
    features: dict[str, str] = {}
    for line_number, line in enumerate(markdown.splitlines(), start=1):
        if not line.lstrip().startswith("|"):
            continue
        cells = markdown_cells(line)
        if len(cells) < 3 or not FEATURE_CODE.fullmatch(cells[0]):
            continue
        code, level = cells[0], cells[-1]
        if code in features:
            raise ValueError(f"FEATURES.md:{line_number}: feature {code} appears more than once")
        features[code] = level
    return features


def expand_feature_references(cell: str) -> set[str]:
    """Extract feature references from a task cell, expanding ranges such as D4–D9."""
    found: set[str] = set()
    for match in FEATURE_REFERENCE.finditer(cell):
        letter, start_number, end = match.groups()
        start = int(start_number)
        found.add(f"{letter}{start}")
        if end:
            end_letter = end[0] if end[0].isalpha() else letter
            end_number = int(end[1:] if end[0].isalpha() else end)
            if end_letter != letter or end_number < start:
                continue
            found.update(f"{letter}{number}" for number in range(start + 1, end_number + 1))
    return found


def parse_task_coverage(markdown: str) -> dict[str, set[str]]:
    """Return feature code -> task codes from the feature column of TASKS.md."""
    coverage: dict[str, set[str]] = defaultdict(set)
    for line in markdown.splitlines():
        if not line.lstrip().startswith("|"):
            continue
        cells = markdown_cells(line)
        if len(cells) < 6 or not TASK_CODE.fullmatch(cells[0]):
            continue
        task_code = cells[0]
        for feature in expand_feature_references(cells[2]):
            coverage[feature].add(task_code)
    return coverage


def check_coverage(features_markdown: str, tasks_markdown: str) -> tuple[list[str], int, int]:
    """Return missing features, count of in-scope features, and covered count."""
    features = parse_features(features_markdown)
    in_scope = {code for code, level in features.items() if IN_SCOPE_LEVEL.fullmatch(level)}
    if not in_scope:
        raise ValueError("Không tìm thấy tính năng thuộc phạm vi 1.0 trong FEATURES.md")
    coverage = parse_task_coverage(tasks_markdown)
    missing = sorted(in_scope - coverage.keys(), key=lambda code: (code[0], int(code[1:])))
    covered = len(in_scope) - len(missing)
    return missing, len(in_scope), covered


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    features_path = root / "docs" / "FEATURES.md"
    tasks_path = root / "docs" / "TASKS.md"
    try:
        missing, total, covered = check_coverage(
            features_path.read_text(encoding="utf-8"), tasks_path.read_text(encoding="utf-8")
        )
    except (OSError, ValueError) as exc:
        print(f"Lỗi kiểm tra độ phủ: {exc}", file=sys.stderr)
        return 2

    print(f"Độ phủ tính năng v1.0: {covered}/{total}")
    if missing:
        print("Thiếu task cho: " + ", ".join(missing))
        return 1
    print("Tất cả tính năng trong phạm vi v1.0 đều có task.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
