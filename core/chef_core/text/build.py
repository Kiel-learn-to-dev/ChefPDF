"""Build the text model of a page (T7.01). See ``chef_core.text.model`` for what it holds.

Pipeline: text objects of the flattened page model -> glyph tokens with positions (the same
advance rules as the content engine) -> characters -> rows by baseline -> segments split at
gutters -> lines (spaces inferred from gaps) -> blocks by recursive XY-cut -> paragraphs (indent,
spacing, font change, list markers) -> alignment and roles.
"""

from __future__ import annotations

import itertools
import math
import re
import statistics
from collections import Counter
from dataclasses import dataclass
from typing import Any

import pikepdf

from chef_core.content.engine import apply, build_model
from chef_core.content.fonts import APPROX_WIDTH, FontInfo
from chef_core.content.model import Matrix, PageModel, PageObject, hex_of
from chef_core.pdf.content import mul
from chef_core.signing.anchors import PageFrame
from chef_core.text.fontcap import FontCapability
from chef_core.text.model import (
    TextBlock,
    TextChar,
    TextLine,
    TextPage,
    TextParagraph,
    make_block_id,
    make_line_id,
    make_paragraph_id,
)

SHOW_OPS = ("Tj", "TJ", "'", '"')
ROW_TOLERANCE = 0.3  # of the font size
SPACE_GAP = 0.25  # of the font size: a gap wider than this is a space
GUTTER = 1.5  # of the font size: a gap wider than this splits a row into segments
LIST_MARKER = r"^\s*(?:[-•·▪●◦*–]|\d{1,3}[.)]|[a-zA-Z][.)]|[ivxIVX]{1,4}[.)])\s"


@dataclass
class Tok:
    """A glyph (``value`` is None) or a kerning number of a text-showing operator."""

    chunk: bytes = b""
    code: int = -1
    width: float = 0.0  # advance in em (glyphs)
    space: bool = False  # a one-byte space: Tw applies to it
    value: float | None = None

    @property
    def is_glyph(self) -> bool:
        return self.value is None


def show_items(op: str, operands: list[Any]) -> list[Any]:
    """The string and kerning operands of a text-showing operator."""
    if op == "TJ":
        return list(operands[0]) if operands else []
    if op == '"':
        return [operands[2]] if len(operands) > 2 else []
    return [operands[0]] if operands else []


def _chunks(font: FontInfo, data: bytes) -> list[bytes]:
    if font.is_cid:
        return [data[i : i + 2] for i in range(0, len(data), 2)]
    return [bytes([b]) for b in data]


def tokens_of(items: list[Any], font: FontInfo | None) -> list[Tok]:
    """Glyph and kerning tokens of one operator, with the widths the engine uses."""
    out: list[Tok] = []
    for item in items:
        if isinstance(item, pikepdf.String):
            data = bytes(item)
            if font is None:
                codes = list(data)
                chunks = [bytes([b]) for b in data]
            else:
                codes = font.codes(data)
                chunks = _chunks(font, data)
            for code, chunk in zip(codes, chunks, strict=False):
                width = (font.width(code) if font is not None else APPROX_WIDTH) / 1000
                space = (font is None or not font.is_cid) and code == 32
                out.append(Tok(chunk=chunk, code=code, width=width, space=space))
        else:
            try:
                out.append(Tok(value=float(item)))
            except (TypeError, ValueError):
                continue
    return out


def matrix_of(obj: PageObject) -> Matrix:
    return mul(obj.tm, obj.ctm)


def is_rotated(m: Matrix) -> bool:
    return abs(m[1]) > 1e-6 or abs(m[2]) > 1e-6


def run_chars(
    run: int,
    obj: PageObject,
    items: list[Any],
    cap: FontCapability,
) -> list[TextChar]:
    """Characters of one text object, positioned in user space."""
    m = matrix_of(obj)
    tfs, th, tc, tw, ts = obj.font_size, obj.th, obj.tc, obj.tw, obj.ts
    size = tfs * math.sqrt(abs(m[0] * m[3] - m[1] * m[2]))
    font = cap.info
    tokens = tokens_of(items, font)
    asc = (font.ascent if font is not None else 800.0) / 1000
    desc = (font.descent if font is not None else -200.0) / 1000
    chars: list[TextChar] = []
    pos = 0.0
    for ti, tok in enumerate(tokens):
        if tok.value is not None:
            pos += -tok.value / 1000 * tfs * th
            continue
        adv = (tok.width * tfs + tc + (tw if tok.space else 0.0)) * th
        start = apply(m, pos, ts)
        end = apply(m, pos + adv, ts)
        chars.append(
            TextChar(
                ch=cap.text_of(tok.code) if cap.kind != "none" else chr(tok.code),
                run=run,
                tok=ti,
                x0=min(start[0], end[0]),
                x1=max(start[0], end[0]),
                baseline=start[1],
                size=size,
                y0=start[1] + desc * size,
                y1=start[1] + asc * size,
                code=tok.code,
                bold=cap.style.bold,
                italic=cap.style.italic,
                font=cap.style.name,
                colour=hex_of(obj.fill_color),
            )
        )
        pos += adv
    return chars


def _rows(chars: list[TextChar]) -> list[list[TextChar]]:
    rows: list[list[TextChar]] = []
    for c in sorted(chars, key=lambda c: (-c.baseline, c.x0)):
        if rows and abs(rows[-1][0].baseline - c.baseline) <= ROW_TOLERANCE * c.size:
            rows[-1].append(c)
        else:
            rows.append([c])
    return rows


def _segments(chars: list[TextChar]) -> list[list[TextChar]]:
    segments: list[list[TextChar]] = []
    for row in _rows(chars):
        row.sort(key=lambda c: c.x0)
        cur = [row[0]]
        for c in row[1:]:
            prev = cur[-1]
            if c.x0 - prev.x1 > GUTTER * max(c.size, prev.size):
                segments.append(cur)
                cur = [c]
            else:
                cur.append(c)
        segments.append(cur)
    return segments


def _display(chars: list[TextChar]) -> tuple[str, list[int | None]]:
    """Text as the user sees it: a space is inferred where a gap is wider than SPACE_GAP."""
    text: list[str] = []
    mapping: list[int | None] = []
    prev: TextChar | None = None
    for i, c in enumerate(chars):
        if (
            prev is not None
            and prev.ch != " "
            and c.ch != " "
            and c.x0 - prev.x1 > SPACE_GAP * c.size
        ):
            text.append(" ")
            mapping.append(None)
        text.append(c.ch)
        mapping.append(i)
        prev = c
    return "".join(text), mapping


def _line(
    segment: list[TextChar],
    page_index: int,
    digest: str,
    index: int,
    runs: list[PageObject],
    caps: list[FontCapability],
) -> TextLine:
    segment.sort(key=lambda c: c.x0)
    text, mapping = _display(segment)
    used = sorted({c.run for c in segment})
    objs = [runs[r] for r in used]
    names = Counter(caps[c.run].style.name for c in segment)
    name = names.most_common(1)[0][0] if names else ""
    style_cap = caps[segment[0].run]
    sizes = Counter(round(c.size, 1) for c in segment)
    size = sizes.most_common(1)[0][0]
    colour = objs[0].fill_color
    x0 = min(c.x0 for c in segment)
    x1 = max(c.x1 for c in segment)
    y0 = min(c.y0 for c in segment)
    y1 = max(c.y1 for c in segment)
    baseline = statistics.median(c.baseline for c in segment)
    artifact = any(m.startswith("Artifact") for o in objs for m in o.marks)
    return TextLine(
        id=make_line_id(page_index, digest, index),
        page_index=page_index,
        index=index,
        text=text,
        chars=segment,
        display_map=mapping,
        runs=objs,
        font_name=name,
        font_size=size,
        bold=style_cap.style.bold,
        italic=style_cap.style.italic,
        style=style_cap.style.style,
        colour=hex_of(colour),
        render_mode=objs[0].tr,
        artifact=artifact,
        bbox=(x0, y0, x1, y1),
        baseline=baseline,
    )


def _xy_cut(lines: list[TextLine], depth: int = 0) -> list[list[TextLine]]:
    """Leaf blocks in reading order: vertical gutters first, then large vertical gaps."""
    if len(lines) <= 1 or depth > 20:
        return [lines]
    spans = sorted((ln.bbox[0], ln.bbox[2]) for ln in lines)
    reach = spans[0][1]
    for x0, x1 in spans[1:]:
        size = max(ln.font_size for ln in lines)
        if x0 - reach > max(6.0, 1.2 * size):
            left = [ln for ln in lines if ln.bbox[2] <= reach + 0.1]
            right = [ln for ln in lines if ln.bbox[0] >= x0 - 0.1]
            if left and right:
                return _xy_cut(left, depth + 1) + _xy_cut(right, depth + 1)
        reach = max(reach, x1)
    ordered = sorted(lines, key=lambda ln: -ln.baseline)
    gaps = [(ordered[i].baseline - ordered[i + 1].baseline, i) for i in range(len(ordered) - 1)]
    if gaps:
        med = statistics.median(g for g, _ in gaps)
        big = [i for g, i in gaps if g > 2.5 * med and g > 20]
        if big:
            i = big[0]
            return _xy_cut(ordered[: i + 1], depth + 1) + _xy_cut(ordered[i + 1 :], depth + 1)
    return [ordered]


def _is_list_item(line: TextLine) -> bool:
    return re.match(LIST_MARKER, line.text) is not None


def _paragraphs(block: list[TextLine]) -> list[list[TextLine]]:
    if not block:
        return []
    left = min(ln.bbox[0] for ln in block)
    gaps = [block[i].baseline - block[i + 1].baseline for i in range(len(block) - 1)]
    lead = statistics.median(gaps) if gaps else None
    groups: list[list[TextLine]] = [[block[0]]]
    for prev, ln in itertools.pairwise(block):
        pitch = prev.baseline - ln.baseline
        tall = lead is not None and pitch > 1.35 * lead
        indented = ln.bbox[0] - left > 0.8 * ln.font_size
        changed = abs(ln.font_size - prev.font_size) > 0.5 or ln.bold != prev.bold
        if indented or tall or changed or _is_list_item(ln):
            groups.append([ln])
        else:
            groups[-1].append(ln)
    return groups


def _align(lines: list[TextLine]) -> str:
    if len(lines) < 2:
        return "left"
    tol = max(1.0, 0.5 * max(ln.font_size for ln in lines))
    x0s = [ln.bbox[0] for ln in lines]
    x1s = [ln.bbox[2] for ln in lines]
    centres = [(a + b) / 2 for a, b in zip(x0s, x1s, strict=True)]
    inner_right = [ln.bbox[2] for ln in lines[:-1]]
    if max(inner_right) - min(inner_right) <= tol and max(x0s) - min(x0s) <= tol:
        return "justify"
    if max(x0s) - min(x0s) <= tol:
        return "left"
    if max(x1s) - min(x1s) <= tol:
        return "right"
    if max(centres) - min(centres) <= tol:
        return "center"
    return "left"


def build_text_page(pdf: pikepdf.Pdf, page: pikepdf.Page, page_index: int) -> TextPage:
    """The text model of one page (forms flattened, so their text is part of it)."""
    model: PageModel = build_model(pdf, page, page_index, flatten=True)
    frame: PageFrame = model.frame
    caps: dict[str, FontCapability] = {}
    runs: list[PageObject] = []
    run_caps: list[FontCapability] = []
    chars: list[TextChar] = []
    for obj in model.objects:
        if obj.kind != "text" or not obj.in_page:
            continue
        node = model.nodes[obj.start]
        if node.op not in SHOW_OPS:
            continue
        m = matrix_of(obj)
        if is_rotated(m):
            continue
        if obj.font not in caps:
            fd = model.res.get("/Font") if isinstance(model.res, pikepdf.Dictionary) else None
            font_dict = (
                fd.get(obj.font) if isinstance(fd, pikepdf.Dictionary) and obj.font else None
            )
            caps[obj.font or ""] = FontCapability(font_dict)
        cap = caps[obj.font or ""]
        run = len(runs)
        runs.append(obj)
        run_caps.append(cap)
        chars.extend(run_chars(run, obj, show_items(node.op, node.operands), cap))
    segments = _segments(chars)
    raw_lines: list[TextLine] = []
    for segment in segments:
        line = _line(
            segment,
            page_index,
            model.digest,
            0,
            runs,
            run_caps,
        )
        raw_lines.append(line)
    # reading order: blocks by XY-cut, lines top to bottom within each block
    ordered_blocks = _xy_cut(raw_lines) if raw_lines else []
    lines: list[TextLine] = []
    paragraphs: list[TextParagraph] = []
    blocks: list[TextBlock] = []
    body_size, body_bold = _body_style(raw_lines)
    for block in ordered_blocks:
        block.sort(key=lambda ln: -ln.baseline)
        block_id = make_block_id(page_index, model.digest, len(blocks))
        block_lines: list[TextLine] = []
        block_paragraph_ids: list[str] = []
        for group in _paragraphs(block):
            para_id = make_paragraph_id(page_index, model.digest, len(paragraphs))
            align = _align(group)
            role = _role(group, body_size, body_bold)
            indent = group[0].bbox[0] - min(ln.bbox[0] for ln in group) if len(group) > 1 else 0.0
            for ln in group:
                ln.index = len(lines)
                ln.id = make_line_id(page_index, model.digest, len(lines))
                ln.paragraph_id = para_id
                ln.block_id = block_id
                ln.role = "list" if _is_list_item(ln) and role == "body" else role
                ln.list_marker = _is_list_item(ln)
                ln.align = align
                lines.append(ln)
                block_lines.append(ln)
            paragraphs.append(
                TextParagraph(
                    id=para_id,
                    line_ids=[ln.id for ln in group],
                    align=align,
                    indent=round(max(indent, 0.0), 3),
                    role=role,
                    block_id=block_id,
                )
            )
            block_paragraph_ids.append(para_id)
        bbox = (
            min(ln.bbox[0] for ln in block_lines),
            min(ln.bbox[1] for ln in block_lines),
            max(ln.bbox[2] for ln in block_lines),
            max(ln.bbox[3] for ln in block_lines),
        )
        blocks.append(TextBlock(id=block_id, paragraph_ids=block_paragraph_ids, bbox=bbox))
    for ln in lines:
        ln.editable = all(not is_rotated(matrix_of(r)) for r in ln.runs)
    return TextPage(
        page_index=page_index,
        digest=model.digest,
        frame=frame,
        lines=lines,
        paragraphs=paragraphs,
        blocks=blocks,
        model=model,
        by_id={ln.id: ln for ln in lines},
        caps=caps,
    )


def _body_style(lines: list[TextLine]) -> tuple[float, bool]:
    """The body font size (most characters) and whether body text is bold."""
    weight: Counter[float] = Counter()
    bold: Counter[bool] = Counter()
    for ln in lines:
        weight[round(ln.font_size, 1)] += len(ln.text)
    size = weight.most_common(1)[0][0] if weight else 0.0
    for ln in lines:
        if round(ln.font_size, 1) == size:
            bold[ln.bold] += len(ln.text)
    return size, bool(bold and bold.most_common(1)[0][0])


def _role(group: list[TextLine], body: float, body_bold: bool) -> str:
    size = max(ln.font_size for ln in group)
    if body and size >= body * 1.15:
        return "heading"
    if len(group) <= 2 and all(ln.bold for ln in group) and not body_bold:
        return "heading"
    if all(_is_list_item(ln) for ln in group):
        return "list"
    return "body"


__all__ = ["Tok", "build_text_page", "run_chars", "show_items", "tokens_of"]
