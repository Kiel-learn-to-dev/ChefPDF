"""Markdown (CommonMark + GFM tables and footnotes), T10.04, N4.

- Headings are ATX (``#``..``######``) with the level of the model.
- Bold, italic, links (``https`` only), super- and subscript (``<sup>``/``<sub>``).
- Lists nest with the indentation the marker needs (2 spaces after ``-``, 3 after ``1.``).
- Tables are GFM pipe tables. The first row is the header (GFM needs one). Cells with several
  paragraphs join them with ``<br>``. Merged cells cannot be expressed: the anchor keeps its text,
  covered positions are empty, and a warning says so.
- Images go to ``<name>_files/`` next to the file, with relative links. Vector figures are PNG
  renders of their region.
- Footnotes are GFM footnote definitions (``[^n]:``) at the end of the document.
- Markdown specials in the text are escaped; the output is deterministic.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from pathlib import Path
from urllib.parse import quote

from chef_core.export.files import (
    assets_folder,
    create_assets_folder,
    image_name,
    write_bytes,
    write_text,
)
from chef_core.export.ir import (
    CellIR,
    DocIR,
    ExportResult,
    Heading,
    ImageBlock,
    ListBlock,
    ListNode,
    Para,
    Rule,
    TableBlock,
)
from chef_core.export.text import md_escape, md_line_start, merge_runs, squash, wrap_marks
from chef_core.layout.model import Run

FOOTNOTE_LABEL = re.compile(r"^\s*(\d{1,3}|[*†‡]+)[.)]?\s+")
SAFE_URL = re.compile(r"^https?://\S+$")


def _run_md(run: Run) -> str:
    text = md_escape(run.text)
    if run.sup:
        text = f"<sup>{text}</sup>"
    elif run.sub:
        text = f"<sub>{text}</sub>"
    if run.bold and run.italic:
        text = wrap_marks(text, "***")
    elif run.bold:
        text = wrap_marks(text, "**")
    elif run.italic:
        text = wrap_marks(text, "*")
    if run.link and SAFE_URL.match(run.link):
        url = run.link.replace(" ", "%20").replace("(", "%28").replace(")", "%29")
        text = f"[{text}]({url})"
    return text


def inline(runs: Sequence[Run]) -> str:
    return "".join(_run_md(r) for r in merge_runs(runs))


def _list_lines(nodes: list[ListNode], ordered: bool, prefix: str) -> list[str]:
    lines: list[str] = []
    for number, node in enumerate(nodes, start=1):
        marker = f"{number}." if ordered else "-"
        text = inline(node.runs)
        lines.append(f"{prefix}{marker} {text}".rstrip())
        lines.extend(_list_lines(node.children, ordered, prefix + " " * (len(marker) + 1)))
    return lines


def _cell(cell: CellIR) -> str:
    if cell.covered:
        return ""
    return "<br>".join(inline(p) for p in cell.paras).replace("\n", " ")


def _table(block: TableBlock) -> str:
    rows = [[_cell(c) for c in row] for row in block.rows]
    width = block.columns
    head = rows[0]
    lines = [
        "| " + " | ".join(head) + " |",
        "| " + " | ".join(["---"] * width) + " |",
    ]
    lines.extend("| " + " | ".join(row) + " |" for row in rows[1:])
    return "\n".join(lines)


def _para(item: Para) -> str:
    text = md_line_start(inline(item.runs))
    if item.role in ("header", "footer", "pagenumber"):
        return f"*{inline(item.runs)}*"
    if item.role == "caption":
        return f"*{text}*"
    return text


def render(ir: DocIR, folder: str | None) -> tuple[str, list[tuple[str, bytes]], list[str]]:
    """The Markdown text, the image files to write (name, bytes) and the warnings."""
    blocks: list[str] = []
    notes: list[str] = []
    files: list[tuple[str, bytes]] = []
    warnings: list[str] = []
    counter = 0
    for index, item in enumerate(ir.items):
        if isinstance(item, Heading):
            plain_runs = [r.model_copy(update={"bold": False}) for r in item.runs]
            blocks.append("#" * item.level + " " + squash(inline(plain_runs)))
        elif isinstance(item, Para):
            if item.role == "footnote":
                notes.append(_footnote(item, index))
            else:
                blocks.append(_para(item))
        elif isinstance(item, ListBlock):
            blocks.append("\n".join(_list_lines(item.items, item.ordered, "")))
        elif isinstance(item, TableBlock):
            if item.merged:
                warnings.append("MERGED_CELLS_FLATTENED")
            blocks.append(_table(item))
        elif isinstance(item, ImageBlock):
            blocks.append(_image(item, folder, files, counter))
            if item.asset is not None:
                counter += 1
        elif isinstance(item, Rule):
            blocks.append("---")
    if notes:
        blocks.append("\n".join(notes))
    text = "\n\n".join(b for b in blocks if b) + "\n"
    return text, files, warnings


def _footnote(item: Para, index: int) -> str:
    """``[^n]: text``; the printed label (1, 2, *) is taken out of the text."""
    runs = list(item.runs)
    label = f"f{index}"
    if runs:
        match = FOOTNOTE_LABEL.match(runs[0].text)
        if match:
            raw = match.group(1)
            if raw.isdigit():
                label = raw
            runs[0] = runs[0].model_copy(update={"text": runs[0].text[match.end() :]})
            runs = [r for r in runs if r.text]
    return f"[^{label}]: {inline(runs)}"


def _image(item: ImageBlock, folder: str | None, files: list[tuple[str, bytes]], n: int) -> str:
    alt = md_escape(squash(item.caption or "")) if item.caption else ""
    if item.asset is None:
        note = "*[Hình không trích được]*"
        return note if not item.caption else f"{note}\n\n*{md_escape(squash(item.caption))}*"
    name = image_name(n + 1, item.asset.ext)
    files.append((name, item.asset.data))
    link = f"{quote(folder or '')}/{quote(name)}" if folder else name
    out = f"![{alt}]({link})"
    if item.caption:
        out += f"\n\n*{md_escape(squash(item.caption))}*"
    return out


def write_markdown(ir: DocIR, out: Path, include_images: bool = True) -> ExportResult:
    folder = assets_folder(out)
    text, files, warnings = render(ir, folder.name)
    outputs: list[str] = []
    if files and include_images:
        create_assets_folder(folder)
        for name, data in files:
            target = folder / name
            write_bytes(target, data)
            outputs.append(str(target))
    write_text(out, text)
    outputs.insert(0, str(out))
    return ExportResult(
        outputs=outputs,
        warnings=sorted(set(ir.warnings + warnings)),
        stats={
            "blocks": len(ir.items),
            "images": len(files),
            "tables": len(ir.blocks_of(TableBlock)),
        },
    )
