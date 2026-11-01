"""Editing the text of one line (T7.02): plan first, then apply.

A plan says what happens to a line and writes nothing. ``apply_plan`` writes it into a page
editor (``chef_core.content.editor.PageEditor``), so a whole operation can plan every line, embed
its fonts once, and only then change the pages.

Actions:

- ``none``: the text is unchanged.
- ``delete``: empty text. Each run becomes an advance-only TJ, so the text after it keeps its place.
- ``inplace``: the original font writes every character. The run's string is rewritten with the
  operands of the unchanged prefix and suffix kept as they were (kerning included). A compensating
  kern keeps the text after the run where it was.
- ``substitute``: the original font cannot write the text. The old run becomes advance-only and a
  new BT block is drawn after the text object, in a bundled Unicode font (subset, ToUnicode), at
  the same origin, size, colour, rise, render mode and horizontal scale.

Width fitting (``fitWidth``): ``shrink`` lowers the font size to at most ``FONT_FLOOR`` of the
original; ``track`` lowers the character spacing to at most ``TRACK_FLOOR`` em. Whatever still
does not fit grows the line and is reported in ``overflow``.
"""

from __future__ import annotations

import difflib
import hashlib
import unicodedata
from dataclasses import dataclass, field
from typing import Any

import pikepdf
from pikepdf import Array, Name

from chef_core.content.editor import PageEditor, colour_ins
from chef_core.content.engine import inverse
from chef_core.content.model import Ins, PageObject
from chef_core.errors import invalid_params
from chef_core.overlay.engine import _embed_font
from chef_core.overlay.pagecontent import category
from chef_core.pdf.content import mul
from chef_core.text.build import Tok, matrix_of, show_items, tokens_of
from chef_core.text.fontcap import FontCapability
from chef_core.text.fonts import FontEntry, Wanted, covers, entry, load_registry, pick
from chef_core.text.model import TextLine, TextPage

FONT_FLOOR = 0.8  # shrink never goes below this share of the original size
TRACK_FLOOR = -0.03  # tracking never tighter than this share of the size (em)
OVERFLOW_TOLERANCE = 0.5  # points
EDGE_MARGIN = 2.0  # points
STRATEGIES = ("auto", "keep", "replace")
FITS = ("none", "shrink", "track")
RES_PREFIX = "ChefTx"


@dataclass(frozen=True)
class EditOptions:
    font_strategy: str = "auto"
    font_name: str | None = None
    keep_style: bool = True
    fit_width: str = "none"

    def validate(self) -> None:
        if self.font_strategy not in STRATEGIES:
            raise invalid_params("INVALID_FONT_STRATEGY", {"value": self.font_strategy})
        if self.fit_width not in FITS:
            raise invalid_params("INVALID_FIT_WIDTH", {"value": self.fit_width})


@dataclass
class Substitution:
    font_id: str
    size: float  # text-space font size
    tc: float
    th: float
    ts: float
    tr: int
    tm: tuple[float, ...]  # local text matrix (valid at ``pos``)
    pos: int  # node index where the new BT block is inserted
    fill: tuple[Any, ...]
    stroke: tuple[Any, ...]
    lw: float
    text: str
    codepoints: set[int] = field(default_factory=set)


@dataclass
class LinePlan:
    line_id: str
    page_index: int
    action: str  # none | delete | inplace | substitute
    old_text: str
    new_text: str
    font_from: str = ""
    font_to: str | None = None
    fit: str = "none"
    size: float = 0.0  # effective font size in points after the edit
    tracking: float = 0.0  # effective character spacing in points
    width: float = 0.0  # width of the new line in points
    overflow: float = 0.0
    missing: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    nodes: list[Ins] = field(default_factory=list)  # inplace: replacement for the run
    subst: Substitution | None = None


# -- helpers ----------------------------------------------------------------------------------


def font_cap(page: TextPage, font_name: str | None) -> FontCapability:
    """Capability of a font resource of the page (cached on the page)."""
    key = font_name or ""
    found = page.caps.get(key)
    if found is None:
        res = page.model.res
        fonts = res.get("/Font") if isinstance(res, pikepdf.Dictionary) else None
        font = fonts.get(key) if isinstance(fonts, pikepdf.Dictionary) and font_name else None
        found = FontCapability(font)
        page.caps[key] = found
    return found


def _find_et(nodes: list[Ins], after: int) -> int:
    for i in range(after + 1, len(nodes)):
        if nodes[i].op == "ET":
            return i
    raise invalid_params("TEXT_TRANSFORM_UNSUPPORTED", {"reason": "no ET after the text"})


def _advance_only(run: PageObject, nodes: list[Ins]) -> list[Ins]:
    """The operators that replace a text run by its advance (keeps the text after it)."""
    node = nodes[run.start]
    key = run.key
    out: list[Ins] = []
    if node.op == "'":
        out.append(Ins([], "T*", key))
    elif node.op == '"':
        out += [
            Ins([node.operands[0]], "Tw", key),
            Ins([node.operands[1]], "Tc", key),
            Ins([], "T*", key),
        ]
    scale = run.font_size * run.th
    if abs(scale) > 1e-12 and abs(run.advance) > 1e-12:
        out.append(Ins([Array([-run.advance * 1000 / scale])], "TJ", key))
    return out


def _measure(toks: list[Tok]) -> tuple[float, int, int]:
    """(A, N, Ns): advance = th * (size * A + tc * N + tw * Ns) in text space."""
    a = 0.0
    n = 0
    ns = 0
    for t in toks:
        if t.is_glyph:
            a += t.width
            n += 1
            if t.space:
                ns += 1
        else:
            a -= (t.value or 0.0) / 1000
    return a, n, ns


def _to_items(toks: list[Tok]) -> list[Any]:
    """TJ operands: byte strings merged, kerning numbers as numbers."""
    items: list[Any] = []
    cur = bytearray()
    for t in toks:
        if t.is_glyph:
            cur += t.chunk
            continue
        if cur:
            items.append(pikepdf.String(bytes(cur)))
            cur = bytearray()
        items.append(float(t.value or 0.0))
    if cur:
        items.append(pikepdf.String(bytes(cur)))
    return items


def _geometry_warnings(page: TextPage, line: TextLine, width: float) -> list[str]:
    out: list[str] = []
    right = line.bbox[0] + width
    if right > page.frame.x1 - EDGE_MARGIN:
        out.append("Dòng chạm hoặc vượt mép phải của trang.")
    size = line.font_size
    for other in page.lines:
        if other.id == line.id or abs(other.baseline - line.baseline) >= 0.6 * size:
            continue
        if other.bbox[0] >= line.bbox[2] - 0.5 and other.bbox[0] < right:
            out.append(f"Có thể chồng lên dòng khác ({other.id}).")
            break
    return out


def _fit(
    opts: EditOptions,
    current: float,
    target: float,
    th: float,
    size0: float,
    tc0: float,
    tw: float,
    measure: tuple[float, int, int],
) -> tuple[str, float, float]:
    """(fit applied, size, tc) so that the advance fits ``target`` when asked to."""
    a, n, ns = measure
    if opts.fit_width == "shrink" and current > target + 1e-9 and a > 0:
        solved = (target / th - tc0 * n - tw * ns) / a
        size = max(solved, size0 * FONT_FLOOR)
        if size < size0:
            return "shrink", size, tc0
    elif opts.fit_width == "track" and current > target + 1e-9 and n > 0:
        solved = (target / th - size0 * a - tw * ns) / n
        tc = max(solved, TRACK_FLOOR * size0)
        if tc < tc0:
            return "track", size0, tc
    return "none", size0, tc0


def real_char_indices(line: TextLine, start: int, end: int) -> list[int]:
    """Indices (into line.chars) of the real characters shown between two display indices."""
    out: list[int] = []
    for k in range(start, end):
        index = line.display_map[k]
        if index is not None:
            out.append(index)
    return out


def _wanted(line: TextLine, opts: EditOptions) -> Wanted:
    """The style the replacement font should follow (none when keepStyle is off)."""
    if not opts.keep_style:
        return Wanted()
    return Wanted(style=line.style, bold=line.bold, italic=line.italic, family=line.font_name)


def _eff_scale(line: TextLine, run: PageObject) -> float:
    return line.font_size / run.font_size if run.font_size else 1.0


# -- planning ---------------------------------------------------------------------------------


def plan_line(page: TextPage, line: TextLine, new_text: str, opts: EditOptions) -> LinePlan:
    """What editing ``line`` to ``new_text`` does. Raises ChefError when it cannot."""
    opts.validate()
    new_text = unicodedata.normalize("NFC", new_text)
    if not line.editable:
        raise invalid_params("TEXT_NOT_EDITABLE", {"lineId": line.id})
    plan = LinePlan(
        line_id=line.id,
        page_index=line.page_index,
        action="none",
        old_text=line.text,
        new_text=new_text,
        font_from=line.font_name,
        width=line.width,
    )
    if not new_text.strip():
        plan.action = "delete"
        return plan
    if new_text == line.text:
        return plan
    cap = font_cap(page, line.runs[0].font)
    missing = cap.missing(new_text)
    plan.missing = missing
    if opts.font_name is None and opts.font_strategy != "replace":
        if not missing and len(line.runs) == 1 and cap.kind in ("cid", "simple"):
            return _plan_inplace(page, line, new_text, plan, cap, opts)
        if opts.font_strategy == "keep":
            if missing:
                raise invalid_params("TEXT_GLYPH_MISSING", {"lineId": line.id, "missing": missing})
            raise invalid_params("TEXT_KEEP_UNSUPPORTED", {"lineId": line.id})
    return _plan_substitute(page, line, new_text, plan, opts)


def _plan_inplace(
    page: TextPage,
    line: TextLine,
    new_text: str,
    plan: LinePlan,
    cap: FontCapability,
    opts: EditOptions,
) -> LinePlan:
    run = line.runs[0]
    node = page.model.nodes[run.start]
    toks = tokens_of(show_items(node.op, node.operands), cap.info)
    token_of_char = {i: c.tok for i, c in enumerate(line.chars)}
    old, new = line.text, new_text
    out: list[Tok] = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(
        None, old, new, autojunk=False
    ).get_opcodes():
        if tag == "equal":
            reals = real_char_indices(line, i1, i2)
            if not reals:
                continue
            lo = 0 if i1 == 0 else token_of_char[reals[0]]
            hi = len(toks) - 1 if i2 == len(old) else token_of_char[reals[-1]]
            out.extend(toks[lo : hi + 1])
        elif tag in ("replace", "insert"):
            for ch in new[j1:j2]:
                code = cap.code_for(ch)
                if code is None:  # cannot happen: the caller checked every character
                    raise invalid_params("TEXT_GLYPH_MISSING", {"lineId": line.id, "missing": [ch]})
                width = (cap.info.width(code) if cap.info is not None else 0.0) / 1000
                out.append(
                    Tok(
                        chunk=cap.chunk(code),
                        code=code,
                        width=width,
                        space=cap.kind == "simple" and code == 32,
                    )
                )
    th = run.th or 1.0
    sx = abs(matrix_of(run)[0]) or 1.0
    size0, tc0, tw = run.font_size, run.tc, run.tw
    measure = _measure(out)
    a, n, ns = measure
    current = th * (size0 * a + tc0 * n + tw * ns)
    target = line.width / sx
    fit, size, tc = _fit(opts, current, target, th, size0, tc0, tw, measure)
    new_total = th * (size * a + tc * n + tw * ns)
    comp = run.advance - new_total
    if abs(comp) > 1e-9 and size * th != 0:
        out.append(Tok(value=-comp * 1000 / (size * th)))
    key = run.key
    seq: list[Ins] = []
    if node.op == "'":
        seq.append(Ins([], "T*", key))
    if node.op == '"':
        seq += [
            Ins([node.operands[0]], "Tw", key),
            Ins([node.operands[1]], "Tc", key),
            Ins([], "T*", key),
        ]
    font_name = "/" + (run.font or "")
    if size != size0:
        seq.append(Ins([Name(font_name), size], "Tf", key))
    if tc != tc0:
        seq.append(Ins([tc], "Tc", key))
    seq.append(Ins([Array(_to_items(out))], "TJ", key))
    if tc != tc0:
        seq.append(Ins([tc0], "Tc", key))
    if size != size0:
        seq.append(Ins([Name(font_name), size0], "Tf", key))
    width = new_total * sx
    plan.action = "inplace"
    plan.nodes = seq
    plan.fit = fit
    plan.size = size * _eff_scale(line, run)
    plan.tracking = tc * _eff_scale(line, run)
    plan.width = width
    plan.overflow = max(0.0, width - line.width)
    plan.warnings = _warnings(page, line, plan, opts)
    return plan


def _plan_substitute(
    page: TextPage, line: TextLine, new_text: str, plan: LinePlan, opts: EditOptions
) -> LinePlan:
    cps = {ord(c) for c in new_text if c not in "\r\n\t"}
    want = _wanted(line, opts)
    if opts.font_name is not None:
        item = entry(opts.font_name)
        if item is None:
            raise invalid_params("UNKNOWN_FONT", {"fontName": opts.font_name})
        if not covers(item, cps):
            raise invalid_params(
                "TEXT_GLYPH_MISSING", {"lineId": line.id, "missing": _uncovered(new_text, [item])}
            )
    else:
        choice = pick(cps, want)
        if choice is None:
            raise invalid_params(
                "TEXT_GLYPH_MISSING",
                {"lineId": line.id, "missing": _uncovered(new_text, list(load_registry()))},
            )
        item = choice
    face = item.face()
    upem = face.units_per_em
    chars = [c for c in new_text if c not in "\r\n\t"]
    a = sum(face.advance(ord(c)) / upem for c in chars)
    n = len(chars)
    run = line.runs[0]
    th = run.th or 1.0
    sx = abs(matrix_of(run)[0]) or 1.0
    size0 = run.font_size
    tc0 = run.tc if opts.keep_style else 0.0
    target = line.width / sx
    current = th * (size0 * a + tc0 * n)
    fit, size, tc = _fit(opts, current, target, th, size0, tc0, 0.0, (a, n, 0))
    new_total = th * (size * a + tc * n)
    width = new_total * sx
    pos = _find_et(page.model.nodes, max(r.end for r in line.runs)) + 1
    ctm_pos = page.model.ctm_at[pos]
    local = mul(mul(run.tm, run.ctm), inverse(ctm_pos))
    fill = run.fill_op if run.fill_op[0] != "pattern" else ("g", None, (0.0,))
    stroke = run.stroke_op if run.stroke_op[0] != "pattern" else ("g", None, (0.0,))
    plan.action = "substitute"
    plan.font_to = item.id
    plan.fit = fit
    plan.size = size * _eff_scale(line, run)
    plan.tracking = tc * _eff_scale(line, run)
    plan.width = width
    plan.overflow = max(0.0, width - line.width)
    plan.subst = Substitution(
        font_id=item.id,
        size=size,
        tc=tc,
        th=th,
        ts=run.ts,
        tr=run.tr,
        tm=tuple(local),
        pos=pos,
        fill=fill,
        stroke=stroke,
        lw=run.lw,
        text=new_text,
        codepoints=cps,
    )
    if plan.missing:
        plan.warnings.append(
            f"Đã thay font {line.font_name} bằng {item.id} "
            f"vì font gốc thiếu: {''.join(plan.missing)}"
        )
    else:
        plan.warnings.append(f"Đã thay font {line.font_name} bằng {item.id}.")
    plan.warnings += _warnings(page, line, plan, opts)
    return plan


def _uncovered(text: str, items: list[FontEntry]) -> list[str]:
    faces = [item.face() for item in items]
    out: list[str] = []
    for ch in dict.fromkeys(text):
        if ch in "\r\n\t":
            continue
        if not any(f.supports(ord(ch)) for f in faces):
            out.append(ch)
    return out


def _warnings(page: TextPage, line: TextLine, plan: LinePlan, opts: EditOptions) -> list[str]:
    out: list[str] = []
    if plan.fit != "none":
        out.append(
            f"Đã thu {'cỡ chữ' if plan.fit == 'shrink' else 'khoảng cách chữ'} để vừa độ rộng gốc."
        )
    if plan.overflow > OVERFLOW_TOLERANCE:
        out.append(f"Dòng dài thêm {plan.overflow:.1f} pt so với bản gốc.")
    out += _geometry_warnings(page, line, plan.width)
    return out


def probe_text(page: TextPage, line: TextLine, new_text: str, opts: EditOptions) -> dict[str, Any]:
    """Live feedback for the editor: supported, missing, and the font that would be used."""
    new_text = unicodedata.normalize("NFC", new_text)
    cap = font_cap(page, line.runs[0].font)
    missing = cap.missing(new_text)
    substitute = None
    if missing:
        cps = {ord(c) for c in new_text if c not in "\r\n\t"}
        want = _wanted(line, opts)
        choice = pick(cps, want)
        substitute = choice.id if choice is not None else None
    return {
        "supported": not missing,
        "missing": missing,
        "willSubstituteWith": substitute,
    }


# -- fonts and writing ------------------------------------------------------------------------


class FontBook:
    """Embedded replacement fonts of one operation: one subset per font, covering every
    character the plans need. Call ``need`` for every plan, then ``build`` once."""

    def __init__(self, pdf: pikepdf.Pdf) -> None:
        self.pdf = pdf
        self._need: dict[str, set[int]] = {}
        self._objs: dict[str, pikepdf.Object] = {}

    def need(self, font_id: str, codepoints: set[int]) -> None:
        self._need.setdefault(font_id, set()).update(codepoints)

    def build(self) -> None:
        for font_id, cps in sorted(self._need.items()):
            if font_id in self._objs:
                continue
            item = entry(font_id)
            if item is None:
                raise invalid_params("UNKNOWN_FONT", {"fontName": font_id})
            face = item.face()
            digest = hashlib.sha1(",".join(str(c) for c in sorted(cps)).encode()).hexdigest()[:8]
            self._objs[font_id] = _embed_font(
                self.pdf, face, face.subset(cps), f"txt-{font_id}-{digest}"
            )

    def obj(self, font_id: str) -> pikepdf.Object:
        return self._objs[font_id]


def _resource_name(editor: PageEditor, obj: pikepdf.Object) -> str:
    fonts = category(editor.res, "/Font")
    for key, value in fonts.items():
        if obj.is_indirect and value.objgen == obj.objgen:
            return str(key).lstrip("/")
    taken = {str(k).lstrip("/") for k in fonts}
    n = 0
    while f"{RES_PREFIX}{n}" in taken:
        n += 1
    name = f"{RES_PREFIX}{n}"
    fonts[Name("/" + name)] = obj
    return name


def apply_plan(editor: PageEditor, page: TextPage, plan: LinePlan, book: FontBook | None) -> None:
    """Write one plan into the page editor. The editor's model must be ``page.model``."""
    if plan.action == "none":
        return
    line = page.line(plan.line_id)
    assert line is not None
    nodes = page.model.nodes
    if plan.action == "inplace":
        editor.replace[line.runs[0].start] = plan.nodes
        return
    for run in line.runs:
        editor.replace[run.start] = _advance_only(run, nodes)
    if plan.action == "delete" or plan.subst is None:
        return
    assert book is not None
    sub = plan.subst
    name = _resource_name(editor, book.obj(sub.font_id))
    run0 = line.runs[0]
    key = run0.key
    gids = bytearray()
    item = entry(sub.font_id)
    assert item is not None
    face = item.face()
    for ch in sub.text:
        if ch in "\r\n\t":
            continue
        gids += (face.gid(ord(ch)) or 0).to_bytes(2, "big")
    block: list[Ins] = [Ins([], "q", key)]
    block += colour_ins(False, sub.fill, key) + colour_ins(True, sub.stroke, key)
    if sub.tr in (1, 2):
        block.append(Ins([sub.lw], "w", key))
    block += [
        Ins([], "BT", key),
        Ins([Name("/" + name), sub.size], "Tf", key),
        Ins(list(sub.tm), "Tm", key),
        Ins([sub.th * 100], "Tz", key),
        Ins([sub.tc], "Tc", key),
        Ins([0.0], "Tw", key),
        Ins([sub.ts], "Ts", key),
        Ins([sub.tr], "Tr", key),
        Ins([pikepdf.String(bytes(gids))], "Tj", key),
        Ins([], "ET", key),
        Ins([], "Q", key),
    ]
    editor.ins_at.setdefault(sub.pos, []).extend(block)


# Public names for the helpers that the paragraph editor (T7.03) shares with this module.
advance_only = _advance_only
find_et = _find_et
resource_name = _resource_name


__all__ = [
    "EditOptions",
    "FontBook",
    "LinePlan",
    "advance_only",
    "apply_plan",
    "find_et",
    "font_cap",
    "plan_line",
    "probe_text",
    "resource_name",
]
