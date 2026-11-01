"""Plain text (T10.04, N4): reading order, UTF-8, LF line endings.

Headings and paragraphs are separated by blank lines. Lists are indented two spaces per level with
their markers as printed. Tables are one line per row, cells separated by a tab. Images are a line
with their caption. ``pageMarkers`` adds a ``--- Trang n ---`` line at the start of each page.
"""

from __future__ import annotations

from pathlib import Path

from chef_core.export.files import write_text
from chef_core.export.ir import (
    DocIR,
    ExportResult,
    Heading,
    ImageBlock,
    ListBlock,
    ListNode,
    PageMark,
    Para,
    Rule,
    TableBlock,
)
from chef_core.export.text import plain, squash

RULE = "-" * 40


def _list_lines(nodes: list[ListNode], ordered: bool, depth: int) -> list[str]:
    lines: list[str] = []
    for number, node in enumerate(nodes, start=1):
        marker = node.marker or (f"{number}." if ordered else "•")
        lines.append(f"{'  ' * depth}{marker} {plain(node.runs)}".rstrip())
        lines.extend(_list_lines(node.children, ordered, depth + 1))
    return lines


def _table(block: TableBlock) -> str:
    rows = []
    for row in block.rows:
        cells = ["" if c.covered else squash(" ".join(plain(p) for p in c.paras)) for c in row]
        rows.append("\t".join(cells))
    return "\n".join(rows)


def render_text(ir: DocIR, page_markers: bool = False) -> str:
    blocks: list[str] = []
    for item in ir.items:
        if isinstance(item, PageMark):
            if page_markers:
                blocks.append(f"--- Trang {item.index + 1} ---")
        elif isinstance(item, Heading | Para):
            blocks.append(plain(item.runs))
        elif isinstance(item, ListBlock):
            blocks.append("\n".join(_list_lines(item.items, item.ordered, 0)))
        elif isinstance(item, TableBlock):
            blocks.append(_table(item))
        elif isinstance(item, ImageBlock):
            if item.asset is None:
                blocks.append(
                    "[Hình không trích được]"
                    if not item.caption
                    else f"[Hình không trích được: {squash(item.caption)}]"
                )
            else:
                blocks.append(f"[Hình: {squash(item.caption)}]" if item.caption else "[Hình]")
        elif isinstance(item, Rule):
            blocks.append(RULE)
    return "\n\n".join(b for b in blocks if b) + "\n"


def write_txt(ir: DocIR, out: Path, page_markers: bool = False) -> ExportResult:
    write_text(out, render_text(ir, page_markers))
    return ExportResult(
        outputs=[str(out)],
        warnings=list(ir.warnings),
        stats={"blocks": len(ir.items)},
    )
