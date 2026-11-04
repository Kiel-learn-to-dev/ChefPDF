"""Paragraph edits (T7.03, D9): re-flow a paragraph inside its box, or restyle it.

A paragraph of the text model is replaced as a whole. Its old runs become advance-only (the text
after them keeps its place, as in ``text.editLine``) and the new lines are drawn in one BT block
after the last old run, with the origin, reference scale and rise of the first old run.

Layout, in user space (points, y up):

- the first baseline is the old first baseline; the pitch is the old leading ratio times the new
  size (``lineSpacing: keep``), or the given value in points;
- the box starts at the paragraph's left edge and is ``boxWidth`` wide (default: up to the right
  edge of the text block the paragraph belongs to);
- lines break only at spaces, with the advance widths of the font that draws them. A word wider
  than the box is broken between characters and reported;
- a list item keeps its marker (the one of the old first line when the new text has none); lines
  after the first hang under the text that follows the marker;
- justified lines (all but the last one of a paragraph or before a hard break) get the extra width
  as word spacing, written as TJ kerning after each space, so that it also works with two-byte
  fonts (where Tw does not apply);
- fit: the glyph box of the new paragraph is compared with the top of the nearest line below it
  that shares its horizontal span, or with the bottom margin of the page. ``overflow`` is how far
  the new text reaches past that limit; ``overlapsBlockIds`` lists the blocks whose lines the new
  glyph boxes touch.

Fonts: the paragraph's own font when it writes every character and keeps its style; otherwise a
registry font (see ``chef_core.text.fonts``). Bold or italic changes need a registry font.
"""

from __future__ import annotations

import math
import re
import statistics
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

import pikepdf
from pikepdf import Array, Name

from chef_core.content.editor import PageEditor, colour_ins, hex_colour
from chef_core.content.engine import inverse
from chef_core.content.model import Ins, Matrix, PageObject
from chef_core.errors import invalid_params
from chef_core.pdf.content import mul
from chef_core.text.build import LIST_MARKER, matrix_of
from chef_core.text.edit import FontBook, advance_only, find_et, font_cap, resource_name
from chef_core.text.fontcap import FontCapability
from chef_core.text.fonts import FontEntry, Wanted, covers, entry, load_registry, pick
from chef_core.text.model import TextLine, TextPage, TextParagraph

STRATEGIES = ("auto", "keep", "replace")
ALIGNS = ("keep", "left", "right", "center", "justify")
MARGIN_BOTTOM = 18.0  # points kept free at the bottom of the page
FIT_TOLERANCE = 0.5  # points
MIN_FIRST_ROW_EMS = 4.0  # the first row keeps at least this many em after an indent
EPS = 1e-6
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
FillState = tuple[str, str | None, tuple[float, ...]]  # as colour_ins takes it
_PARAGRAPH_ID = re.compile(r"^P(\d+):([0-9a-f]{12}):(\d+)$")


@dataclass(frozen=True)
class ParagraphOptions:
    font_strategy: str = "auto"
    font_name: str | None = None
    keep_style: bool = True
    align: str = "keep"
    line_spacing: float | None = None  # None: keep the leading ratio
    font_size: float | None = None  # None: keep
    color: str | None = None  # '#rrggbb' or None: keep
    bold: bool | None = None
    italic: bool | None = None
    box_width: float | None = None  # None: up to the block's right edge
    indent: float | None = None  # None: keep the indent of the first line (points, >= 0)

    def validate(self) -> None:
        if self.font_strategy not in STRATEGIES:
            raise invalid_params("INVALID_FONT_STRATEGY", {"value": self.font_strategy})
        if self.align not in ALIGNS:
            raise invalid_params("INVALID_ALIGN", {"value": self.align})
        if self.color is not None and not HEX.match(self.color):
            raise invalid_params("INVALID_COLOUR", {"value": self.color})
        for name, value in (
            ("lineSpacing", self.line_spacing),
            ("fontSize", self.font_size),
            ("boxWidth", self.box_width),
        ):
            if value is not None and not value > 0:
                raise invalid_params("INVALID_VALUE", {"name": name, "value": value})
        if self.indent is not None and not self.indent >= 0:
            raise invalid_params("INVALID_VALUE", {"name": "indent", "value": self.indent})


@dataclass
class _Row:
    text: str
    last: bool  # last row of a hard-break segment (never justified)


@dataclass
class _Line:
    text: str
    x: float
    y: float
    word_space: float  # extra width per space, in points (justification)


class _Writer:
    """Measures and encodes characters with the font that draws the paragraph."""

    def __init__(self, cap: FontCapability | None, item: FontEntry | None) -> None:
        self.cap = cap
        self.item = item
        self.face = item.face() if item is not None else None

    def chunk(self, ch: str) -> bytes | None:
        if self.face is None:
            assert self.cap is not None
            code = self.cap.code_for(ch)
            return None if code is None else self.cap.chunk(code)
        gid = self.face.gid(ord(ch))
        return None if gid is None else gid.to_bytes(2, "big")

    def em(self, ch: str) -> float:
        if self.face is None:
            assert self.cap is not None
            code = self.cap.code_for(ch)
            if code is None or self.cap.info is None:
                return 0.0
            return self.cap.info.width(code) / 1000
        return self.face.advance(ord(ch)) / self.face.units_per_em

    def metrics(self) -> tuple[float, float]:
        """(ascent, descent) in em; the descent is negative."""
        if self.face is None:
            assert self.cap is not None and self.cap.info is not None
            return self.cap.info.ascent / 1000, self.cap.info.descent / 1000
        return self.face.ascent, self.face.descent

    def missing(self, text: str) -> list[str]:
        out: list[str] = []
        for ch in dict.fromkeys(text):
            if ch in "\r\n\t":
                continue
            if self.chunk(ch) is None:
                out.append(ch)
        return out


@dataclass
class ParagraphPlan:
    paragraph_id: str
    page_index: int
    action: str  # reflow | delete
    font_from: str
    font_to: str | None
    font_size: float
    line_count: int
    pitch: float
    box_left: float
    box_width: float
    height: float
    overflow: float
    overlaps_block_ids: list[str]
    missing: list[str]
    warnings: list[str]
    old_runs: list[PageObject] = field(default_factory=list)
    layout: list[_Line] = field(default_factory=list)
    writer: _Writer | None = None
    font_id: str | None = None
    codepoints: set[int] = field(default_factory=set)
    ref_font: str | None = None  # resource name of the original font (with slash)
    ref_matrix: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    insert_at: int = 0
    fill: FillState | None = None
    stroke: FillState | None = None
    render_mode: int = 0
    line_width: float = 1.0


def parse_paragraph_id(value: str) -> tuple[int, str] | None:
    m = _PARAGRAPH_ID.match(value)
    return None if m is None else (int(m.group(1)), m.group(2))


def _dominant_size(lines: list[TextLine]) -> float:
    weight: Counter[float] = Counter()
    for ln in lines:
        weight[round(ln.font_size, 1)] += len(ln.text)
    return weight.most_common(1)[0][0]


def _uncovered(text: str) -> list[str]:
    faces = [item.face() for item in load_registry()]
    out: list[str] = []
    for ch in dict.fromkeys(text):
        if ch in "\r\n\t":
            continue
        if not any(f.supports(ord(ch)) for f in faces) and ch not in out:
            out.append(ch)
    return out


def _registry(
    dom: TextLine, text: str, bold: bool, italic: bool, opts: ParagraphOptions, warnings: list[str]
) -> _Writer:
    cps = {ord(c) for c in text if c not in "\r\n\t"}
    want = Wanted(
        style=dom.style if opts.keep_style else "sans",
        bold=bold,
        italic=italic,
        family=dom.font_name if opts.keep_style else "",
    )
    item = pick(cps, want)
    if item is None:
        raise invalid_params("TEXT_GLYPH_MISSING", {"missing": _uncovered(text)})
    if item.bold != bold or item.italic != italic:
        warnings.append("Font thay thế không có đủ kiểu đậm/nghiêng được yêu cầu.")
    return _Writer(None, item)


def _choose(
    dom: TextLine,
    cap: FontCapability,
    text: str,
    opts: ParagraphOptions,
    bold: bool,
    italic: bool,
    warnings: list[str],
) -> _Writer:
    if opts.font_name is not None:
        item = entry(opts.font_name)
        if item is None:
            raise invalid_params("UNKNOWN_FONT", {"fontName": opts.font_name})
        cps = {ord(c) for c in text if c not in "\r\n\t"}
        if not covers(item, cps):
            raise invalid_params("TEXT_GLYPH_MISSING", {"missing": _uncovered(text)})
        if item.bold != bold or item.italic != italic:
            warnings.append("Font đã chọn không có đủ kiểu đậm/nghiêng được yêu cầu.")
        return _Writer(None, item)
    style_changed = bold != dom.bold or italic != dom.italic
    if opts.font_strategy == "replace" or (style_changed and opts.font_strategy != "keep"):
        return _registry(dom, text, bold, italic, opts, warnings)
    if opts.font_strategy == "keep" and style_changed:
        raise invalid_params("TEXT_KEEP_UNSUPPORTED", {"reason": "style"})
    own = _Writer(cap, None)
    missing = own.missing(text)
    if not missing and cap.kind in ("cid", "simple"):
        return own
    if opts.font_strategy == "keep":
        if missing:
            raise invalid_params("TEXT_GLYPH_MISSING", {"missing": missing})
        raise invalid_params("TEXT_KEEP_UNSUPPORTED", {"reason": "font"})
    sub = _registry(dom, text, bold, italic, opts, warnings)
    assert sub.item is not None
    if missing:
        warnings.append(
            f"Đã thay font {dom.font_name} bằng {sub.item.id} vì font gốc thiếu: {''.join(missing)}"
        )
    else:
        warnings.append(f"Đã thay font {dom.font_name} bằng {sub.item.id}.")
    return sub


def _wrap(text: str, measure: Any, avail: Any, warnings: list[str]) -> list[_Row]:
    """Greedy word wrap. ``avail(k)`` is the width left for row k; breaks only at spaces."""
    rows: list[_Row] = []
    broke = False
    for segment in text.split("\n"):
        words = segment.split()
        if not words:
            rows.append(_Row("", True))
            continue
        cur = ""
        for word in words:
            cand = word if not cur else f"{cur} {word}"
            if measure(cand) <= avail(len(rows)) + EPS:
                cur = cand
                continue
            if cur:
                rows.append(_Row(cur, False))
                cur = ""
            if measure(word) <= avail(len(rows)) + EPS:
                cur = word
                continue
            piece = ""
            for ch in word:
                if piece and measure(piece + ch) > avail(len(rows)) + EPS:
                    rows.append(_Row(piece, False))
                    broke = True
                    piece = ""
                piece += ch
            cur = piece
        rows.append(_Row(cur, True))
    if broke:
        warnings.append("Có từ dài hơn khung, đã ngắt giữa các chữ.")
    return rows


def _paragraph(page: TextPage, para_id: str) -> TextParagraph:
    parsed = parse_paragraph_id(para_id)
    if parsed is None:
        raise invalid_params("INVALID_PARAGRAPH_ID", {"paragraphId": para_id})
    if parsed[1] != page.digest:
        raise invalid_params("STALE_OBJECT_IDS", {"ids": [para_id]})
    for para in page.paragraphs:
        if para.id == para_id:
            return para
    raise invalid_params("PARAGRAPH_NOT_FOUND", {"paragraphId": para_id})


def _check_runs(page: TextPage, para: TextParagraph, lines: list[TextLine]) -> None:
    """A text object may not draw lines of this paragraph and of another one."""
    mine = {id(r) for ln in lines for r in ln.runs}
    members = set(para.line_ids)
    for other in page.lines:
        if other.id in members:
            continue
        if any(id(r) in mine for r in other.runs):
            raise invalid_params(
                "PARAGRAPH_SHARES_RUN", {"paragraphId": para.id, "lineId": other.id}
            )


def plan_paragraph(
    page: TextPage, para_id: str, new_text: str | None, opts: ParagraphOptions
) -> ParagraphPlan:
    """What re-flowing (or restyling, when ``new_text`` is None) the paragraph does."""
    opts.validate()
    para = _paragraph(page, para_id)
    lines = [ln for ln in (page.line(i) for i in para.line_ids) if ln is not None]
    if not lines:
        raise invalid_params("PARAGRAPH_NOT_FOUND", {"paragraphId": para_id})
    for ln in lines:
        if not ln.editable:
            raise invalid_params("TEXT_NOT_EDITABLE", {"lineId": ln.id})
    _check_runs(page, para, lines)
    dom = max(lines, key=lambda ln: len(ln.text))
    ref = dom.runs[0]
    cap = font_cap(page, ref.font)
    size0 = _dominant_size(lines)
    size = opts.font_size if opts.font_size is not None else size0
    bold = dom.bold if opts.bold is None else opts.bold
    italic = dom.italic if opts.italic is None else opts.italic
    source = " ".join(ln.text.strip() for ln in lines) if new_text is None else new_text
    text = unicodedata.normalize("NFC", source).replace("\t", " ")
    old_runs = sorted({r.start: r for ln in lines for r in ln.runs}.values(), key=lambda r: r.start)
    warnings: list[str] = []
    plan = ParagraphPlan(
        paragraph_id=para.id,
        page_index=page.page_index,
        action="delete",
        font_from=dom.font_name,
        font_to=None,
        font_size=size,
        line_count=0,
        pitch=0.0,
        box_left=0.0,
        box_width=0.0,
        height=0.0,
        overflow=0.0,
        overlaps_block_ids=[],
        missing=[],
        warnings=warnings,
        old_runs=old_runs,
    )
    if not text.strip():
        return plan
    # the list marker of the old first line is kept unless the new text has its own
    body = text
    old_marker = re.match(LIST_MARKER, lines[0].text) if lines[0].list_marker else None
    if old_marker is not None and re.match(LIST_MARKER, text) is None:
        body = old_marker.group(0) + text
    writer = _choose(dom, cap, body, opts, bold, italic, warnings)
    plan.action = "reflow"
    plan.writer = writer
    plan.font_id = writer.item.id if writer.item is not None else None
    plan.font_to = plan.font_id
    plan.missing = cap.missing(body)
    plan.codepoints = {ord(c) for c in body if c not in "\r\n\t"}
    plan.ref_font = ref.font
    plan.ref_matrix = matrix_of(ref)
    plan.insert_at = find_et(page.model.nodes, max(r.end for r in old_runs)) + 1
    plan.render_mode = ref.tr
    plan.fill = hex_colour(opts.color) if opts.color else _fill_of(ref)
    plan.stroke = ref.stroke_op if ref.stroke_op[0] != "pattern" else ("g", None, (0.0,))
    plan.line_width = ref.lw
    _layout(page, para, lines, body, writer, size, size0, opts, plan)
    return plan


def _fill_of(run: PageObject) -> FillState:
    return run.fill_op if run.fill_op[0] != "pattern" else ("g", None, (0.0,))


def _layout(
    page: TextPage,
    para: TextParagraph,
    lines: list[TextLine],
    body: str,
    writer: _Writer,
    size: float,
    size0: float,
    opts: ParagraphOptions,
    plan: ParagraphPlan,
) -> None:
    left = min(ln.bbox[0] for ln in lines)
    block = next((b for b in page.blocks if b.id == para.block_id), None)
    right = max(ln.bbox[2] for ln in lines)
    if block is not None:
        right = max(right, block.bbox[2])
    box_w = opts.box_width if opts.box_width is not None else right - left
    if box_w <= 0:
        box_w = max(size, 1.0)
    marker = re.match(LIST_MARKER, body)
    hang = _width(writer, marker.group(0), size) if marker is not None else 0.0
    base = para.indent if opts.indent is None else opts.indent
    if base + hang > box_w - MIN_FIRST_ROW_EMS * size:
        raise invalid_params(
            "INVALID_VALUE",
            {
                "name": "indent",
                "value": base,
                "maxIndent": round(box_w - MIN_FIRST_ROW_EMS * size, 3),
            },
        )
    first_off = base
    cont_off = base + hang if marker is not None else 0.0

    def avail(k: int) -> float:
        return box_w - (first_off if k == 0 else cont_off)

    def measure(s: str) -> float:
        return _width(writer, s, size)

    rows = _wrap(body, measure, avail, plan.warnings)
    if opts.line_spacing is not None:
        pitch = opts.line_spacing
    elif len(lines) >= 2:
        gaps = [lines[i].baseline - lines[i + 1].baseline for i in range(len(lines) - 1)]
        pitch = statistics.median(gaps) / size0 * size
    else:
        pitch = 1.2 * size
    top = lines[0].baseline
    align = para.align if opts.align == "keep" else opts.align
    placed: list[_Line] = []
    for k, row in enumerate(rows):
        off = first_off if k == 0 else cont_off
        room = avail(k)
        natural = measure(row.text)
        spaces = row.text.count(" ")
        ws = 0.0
        shift = 0.0
        if align == "justify":
            if not row.last and spaces and room > natural:
                ws = (room - natural) / spaces
        elif align == "center":
            shift = (room - natural) / 2
        elif align == "right":
            shift = room - natural
        placed.append(_Line(row.text, left + off + shift, top - k * pitch, ws))
    plan.layout = placed
    plan.line_count = len(placed)
    plan.pitch = pitch
    plan.box_left = left
    plan.box_width = box_w
    ascent, descent = writer.metrics()
    plan.height = (len(placed) - 1) * pitch + (ascent - descent) * size
    _fit(page, para, lines, placed, size, ascent, descent, plan)


def _width(writer: _Writer, text: str, size: float) -> float:
    return sum(writer.em(ch) for ch in text) * size


def _fit(
    page: TextPage,
    para: TextParagraph,
    lines: list[TextLine],
    placed: list[_Line],
    size: float,
    ascent: float,
    descent: float,
    plan: ParagraphPlan,
) -> None:
    if not placed:
        return
    left = plan.box_left
    right = left + plan.box_width
    new_top = placed[0].y + ascent * size
    new_bottom = placed[-1].y + descent * size
    top_baseline = lines[0].baseline
    others = [ln for ln in page.lines if ln.paragraph_id != para.id and not ln.artifact]
    touched: set[str] = set()
    below_tops: list[float] = []
    for ln in others:
        if not (ln.bbox[0] < right and ln.bbox[2] > left):
            continue
        if ln.bbox[1] < new_top and ln.bbox[3] > new_bottom and ln.block_id is not None:
            touched.add(ln.block_id)
        if ln.baseline < top_baseline - 0.5:
            below_tops.append(ln.bbox[3])
    limit = max(below_tops) if below_tops else page.frame.y0 + MARGIN_BOTTOM
    plan.overflow = max(0.0, limit - new_bottom)
    plan.overlaps_block_ids = sorted(touched)
    if plan.overflow > FIT_TOLERANCE:
        plan.warnings.append(
            f"Đoạn dài thêm {plan.overflow:.1f} pt, tràn xuống khối bên dưới hoặc mép trang."
        )
    if plan.overlaps_block_ids:
        plan.warnings.append("Đoạn mới chồng lên khối: " + ", ".join(plan.overlaps_block_ids))
    if right > page.frame.x1 - 2.0:
        plan.warnings.append("Đoạn chạm hoặc vượt mép phải của trang.")


def _tj_items(text: str, writer: _Writer, size: float, word_space: float) -> list[Any]:
    items: list[Any] = []
    buf = bytearray()
    for ch in text:
        chunk = writer.chunk(ch)
        if chunk is None:  # the planner checked every character
            raise invalid_params("TEXT_GLYPH_MISSING", {"missing": [ch]})
        buf += chunk
        if ch == " " and word_space > 0:
            items.append(pikepdf.String(bytes(buf)))
            buf = bytearray()
            items.append(float(-word_space * 1000 / size))
    if buf:
        items.append(pikepdf.String(bytes(buf)))
    return items


def apply_paragraph(
    editor: PageEditor, page: TextPage, plan: ParagraphPlan, book: FontBook | None
) -> None:
    """Write one paragraph plan into the page editor (the editor's model must be page.model)."""
    nodes = page.model.nodes
    for run in plan.old_runs:
        editor.replace[run.start] = advance_only(run, nodes)
    if plan.action != "reflow" or plan.writer is None:
        return
    key = plan.old_runs[0].key
    if plan.font_id is None:
        assert plan.ref_font is not None
        font_name = Name(plan.ref_font)
    else:
        assert book is not None
        font_name = Name("/" + resource_name(editor, book.obj(plan.font_id)))
    r = plan.ref_matrix
    det = abs(r[0] * r[3] - r[1] * r[2])
    scale = math.sqrt(det) if det > 1e-12 else 1.0
    tf = plan.font_size / scale
    ctm = page.model.ctm_at[plan.insert_at]
    inv = inverse(ctm)
    block: list[Ins] = [Ins([], "q", key)]
    block += colour_ins(False, plan.fill or ("g", None, (0.0,)), key)
    if plan.render_mode in (1, 2):
        block += colour_ins(True, plan.stroke or ("g", None, (0.0,)), key)
        block.append(Ins([plan.line_width], "w", key))
    block += [
        Ins([], "BT", key),
        Ins([font_name, tf], "Tf", key),
        Ins([100.0], "Tz", key),
        Ins([0.0], "Tc", key),
        Ins([0.0], "Tw", key),
        Ins([0.0], "Ts", key),
        Ins([plan.render_mode], "Tr", key),
    ]
    for ln in plan.layout:
        if not ln.text:
            continue
        items = _tj_items(ln.text, plan.writer, plan.font_size, ln.word_space)
        local = mul((r[0], r[1], r[2], r[3], ln.x, ln.y), inv)
        block.append(Ins(list(local), "Tm", key))
        block.append(Ins([Array(items)], "TJ", key))
    block += [Ins([], "ET", key), Ins([], "Q", key)]
    editor.ins_at.setdefault(plan.insert_at, []).extend(block)


def plan_json(plan: ParagraphPlan) -> dict[str, Any]:
    return {
        "paragraphId": plan.paragraph_id,
        "action": plan.action,
        "fontFrom": plan.font_from,
        "fontTo": plan.font_to,
        "fontSize": round(plan.font_size, 3),
        "lineCount": plan.line_count,
        "pitch": round(plan.pitch, 3),
        "boxWidth": round(plan.box_width, 3),
        "height": round(plan.height, 3),
        "overflow": round(plan.overflow, 3),
        "overlapsBlockIds": plan.overlaps_block_ids,
        "missing": plan.missing,
        "warnings": plan.warnings,
    }


__all__ = [
    "ParagraphOptions",
    "ParagraphPlan",
    "apply_paragraph",
    "parse_paragraph_id",
    "plan_json",
    "plan_paragraph",
]
