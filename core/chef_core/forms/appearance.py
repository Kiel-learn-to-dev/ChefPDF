"""Appearance streams for form widgets (H1, H2): text, combs, check marks and choice lists.

We draw our own appearances and never rely on /NeedAppearances, so a filled form looks the same in
every viewer. Text uses the bundled Be Vietnam Pro through the overlay font embedding (subset,
ToUnicode), so Vietnamese diacritics render and copy. Check marks are vector paths, so no
ZapfDingbats font is needed.

Each stream is a Form XObject whose BBox is the widget size (origin at the lower left of the
widget, as the spec requires for /AP /N).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import pikepdf
from pikepdf import Dictionary, Name

from chef_core.forms.model import (
    Color,
    FieldRef,
    attr,
    border_width_of,
    colour_of_array,
    da_of,
    parse_da,
    text_of,
)
from chef_core.overlay.engine import DocCache, FontHandle, _wrap
from chef_core.overlay.geometry import number

FAMILY = "BeVietnamPro"
PAD = 2.0
LINE_PITCH = 1.2
HIGHLIGHT: Color = (1.0, 0.96, 0.7)
SELECTED_ROW: Color = (0.6, 0.75, 1.0)
MARK_CODES = frozenset(
    {"4", "8", "l", "n", "u", "H"}
)  # check, cross, circle, square, diamond, star


@dataclass(frozen=True)
class Look:
    """How a widget is drawn: from /DA, /MK and /BS of the field."""

    font_size: float = 0.0  # 0 = auto
    text: Color = (0.0, 0.0, 0.0)
    background: Color | None = None
    border: Color | None = None
    border_width: float = 1.0
    align: int = 0  # /Q: 0 left, 1 centre, 2 right
    mark: str = "4"  # /MK /CA of a check box or radio
    comb: int = 0  # number of comb cells (0: no comb)


def rgb_op(colour: Color, stroke: bool = False) -> str:
    r, g, b = colour
    return f"{number(r)} {number(g)} {number(b)} {'RG' if stroke else 'rg'}"


def look_of(ref: FieldRef, widget: Any, *, highlight: bool = False, empty: bool = True) -> Look:
    """The drawing style of one widget of a field."""
    size, text = parse_da(da_of(ref.node))
    mk = widget.get("/MK")
    mk = mk if isinstance(mk, Dictionary) else Dictionary()
    border = colour_of_array(mk.get("/BC"))
    background = colour_of_array(mk.get("/BG"))
    if highlight and ref.required and empty:
        background = HIGHLIGHT
    q = attr(ref.node, "/Q")
    mark = text_of(mk["/CA"]) if "/CA" in mk else ("l" if ref.kind == "radio" else "4")
    comb = (ref.max_len or 0) if ref.kind == "comb" else 0
    return Look(
        font_size=size,
        text=text,
        background=background,
        border=border,
        border_width=border_width_of(widget) if border is not None else 0.0,
        align=int(q) if q is not None else 0,
        mark=mark if mark in MARK_CODES else "4",
        comb=comb,
    )


def _frame(look: Look, w: float, h: float) -> list[str]:
    ops: list[str] = []
    bw = look.border_width if look.border is not None else 0.0
    if look.background is not None:
        ops.append(f"{rgb_op(look.background)} 0 0 {number(w)} {number(h)} re f")
    if look.border is not None and bw > 0:
        ops.append(
            f"{rgb_op(look.border, stroke=True)} {number(bw)} w "
            f"{number(bw / 2)} {number(bw / 2)} {number(w - bw)} {number(h - bw)} re S"
        )
    return ops


def _form(pdf: pikepdf.Pdf, body: str, w: float, h: float, fonts: dict[str, Any]) -> Any:
    stream = pdf.make_stream(body.encode("ascii"))
    stream.Type = Name.XObject
    stream.Subtype = Name.Form
    stream.BBox = pikepdf.Array([0.0, 0.0, float(w), float(h)])
    resources = Dictionary()
    if fonts:
        resources.Font = Dictionary({f"/{k}": v for k, v in fonts.items()})
    stream.Resources = resources
    return stream


def font_resource(handle: FontHandle) -> str:
    """Resource name of an embedded font in widget appearances and in /DR."""
    objgen = handle.obj.objgen
    return f"CF{objgen[0]}"


def _base_font(doc: DocCache, text: str) -> FontHandle:
    cps = {ord(ch) for ch in text} | {ord(" ")}
    return doc.font(FAMILY, False, cps)


def _x_for(look: Look, width: float, box_w: float, bw: float) -> float:
    if look.align == 1:
        return (box_w - width) / 2
    if look.align == 2:
        return box_w - bw - PAD - width
    return bw + PAD


def text_stream(
    pdf: pikepdf.Pdf,
    doc: DocCache,
    *,
    w: float,
    h: float,
    text: str,
    look: Look,
    multiline: bool = False,
) -> tuple[Any, FontHandle]:
    """Appearance of a text box. Returns the stream and the font it uses (for /DR)."""
    shown = text
    handle = _base_font(doc, shown or " ")
    name = font_resource(handle)
    face = handle.face
    asc, desc = face.ascent, face.descent  # em fractions, descent negative
    bw = look.border_width if look.border is not None else 0.0
    if look.font_size > 0:
        size = look.font_size
    elif multiline:
        size = 12.0
    else:
        size = max(1.0, (h - 2 * bw - 2) / (asc - desc))
    body = _frame(look, w, h)
    body.append(f"{number(bw)} {number(bw)} {number(w - 2 * bw)} {number(h - 2 * bw)} re W n")
    body += ["BT", f"/{name} {number(size)} Tf {rgb_op(look.text)}"]
    single_base = (h - (asc - desc) * size) / 2 - desc * size
    if look.comb > 0:
        cells = look.comb
        cell = (w - 2 * bw) / cells
        for i, ch in enumerate(shown[:cells]):
            glyphs = handle.hex_for(ch)
            if not glyphs:
                continue
            cwidth = handle.width(ch, size)
            x = bw + i * cell + (cell - cwidth) / 2
            body.append(f"1 0 0 1 {number(x)} {number(single_base)} Tm <{glyphs}> Tj")
    elif multiline:
        lines: list[str] = []
        for paragraph in shown.replace("\r\n", "\n").split("\n"):
            lines.extend(_wrap(paragraph, handle, size, w - 2 * bw - 2 * PAD))
        top = h - bw - PAD
        for i, line in enumerate(lines):
            glyphs = handle.hex_for(line)
            if not glyphs:
                continue
            x = _x_for(look, handle.width(line, size), w, bw)
            base = top - asc * size - i * size * LINE_PITCH
            body.append(f"1 0 0 1 {number(x)} {number(base)} Tm <{glyphs}> Tj")
    else:
        line = shown.replace("\r", " ").replace("\n", " ")
        glyphs = handle.hex_for(line)
        if glyphs:
            x = _x_for(look, handle.width(line, size), w, bw)
            body.append(f"1 0 0 1 {number(x)} {number(single_base)} Tm <{glyphs}> Tj")
    body += ["ET", "Q"]
    content = "q\n" + "\n".join(body) + "\nQ\n"
    return _form(pdf, content, w, h, {name: handle.obj}), handle


def list_stream(
    pdf: pikepdf.Pdf,
    doc: DocCache,
    *,
    w: float,
    h: float,
    rows: list[tuple[str, bool]],
    look: Look,
) -> tuple[Any, FontHandle]:
    """Appearance of a list box: one row per option, selected rows highlighted."""
    text = "".join(t for t, _ in rows) or " "
    handle = _base_font(doc, text)
    name = font_resource(handle)
    asc, desc = handle.face.ascent, handle.face.descent
    size = look.font_size if look.font_size > 0 else 12.0
    pitch = size * LINE_PITCH
    bw = look.border_width if look.border is not None else 0.0
    body = _frame(look, w, h)
    body.append(f"{number(bw)} {number(bw)} {number(w - 2 * bw)} {number(h - 2 * bw)} re W n")
    for i, (label, selected) in enumerate(rows):
        top = h - bw - i * pitch
        if top - pitch < 0 and i > 0:
            break
        if selected:
            body.append(f"{rgb_op(SELECTED_ROW)} {number(bw)} {number(top - pitch)} "
                        f"{number(w - 2 * bw)} {number(pitch)} re f")  # fmt: skip
        glyphs = handle.hex_for(label)
        if not glyphs:
            continue
        base = top - pitch + (pitch - (asc - desc) * size) / 2 - desc * size
        x = _x_for(look, handle.width(label, size), w, bw)
        body += [
            "BT",
            f"/{name} {number(size)} Tf {rgb_op(look.text)}",
            f"1 0 0 1 {number(x)} {number(base)} Tm <{glyphs}> Tj",
            "ET",
        ]
    content = "q\n" + "\n".join(body) + "\nQ\n"
    return _form(pdf, content, w, h, {name: handle.obj}), handle


def mark_stream(pdf: pikepdf.Pdf, *, w: float, h: float, look: Look, on: bool) -> Any:
    """Appearance of a check box or radio button; ``on`` draws its mark (from /MK /CA)."""
    body = _frame(look, w, h)
    if on:
        body.append(_mark_ops(look.mark, w, h, look.text))
    return _form(pdf, "q\n" + "\n".join(body) + "\nQ\n", w, h, {})


def _mark_ops(code: str, w: float, h: float, colour: Color) -> str:
    s = min(w, h)
    if code in ("4", "8"):
        lw = 0.14 * s if code == "4" else 0.12 * s
        if code == "4":
            pts = [(0.18 * w, 0.52 * h), (0.42 * w, 0.22 * h), (0.82 * w, 0.8 * h)]
            return _stroke(colour, lw, pts, round_caps=True)
        a = _stroke(colour, lw, [(0.22 * w, 0.22 * h), (0.78 * w, 0.78 * h)], round_caps=False)
        b = _stroke(colour, lw, [(0.22 * w, 0.78 * h), (0.78 * w, 0.22 * h)], round_caps=False)
        return f"{a}\n{b}"
    if code == "l":
        return _circle(w / 2, h / 2, 0.32 * s, colour)
    if code == "n":
        rect = f"{number(0.25 * w)} {number(0.25 * h)} {number(0.5 * w)} {number(0.5 * h)}"
        return f"{rgb_op(colour)} {rect} re f"
    if code == "u":
        pts = [(0.5 * w, 0.2 * h), (0.8 * w, 0.5 * h), (0.5 * w, 0.8 * h), (0.2 * w, 0.5 * h)]
        return _polygon(colour, pts)
    # star (H): five points, outer radius 0.4 of the short side
    cx, cy = w / 2, h / 2
    pts = []
    for i in range(10):
        radius = 0.4 * s if i % 2 == 0 else 0.17 * s
        angle = math.radians(-90 + 36 * i)
        pts.append((cx + radius * math.cos(angle), cy + radius * math.sin(angle)))
    return _polygon(colour, pts)


def _stroke(colour: Color, width: float, pts: list[tuple[float, float]], round_caps: bool) -> str:
    parts = [rgb_op(colour, stroke=True), f"{number(width)} w"]
    if round_caps:
        parts.append("1 J 1 j")
    parts.append(f"{number(pts[0][0])} {number(pts[0][1])} m")
    parts += [f"{number(x)} {number(y)} l" for x, y in pts[1:]]
    parts.append("S")
    return "\n".join(parts)


def _polygon(colour: Color, pts: list[tuple[float, float]]) -> str:
    parts = [rgb_op(colour), f"{number(pts[0][0])} {number(pts[0][1])} m"]
    parts += [f"{number(x)} {number(y)} l" for x, y in pts[1:]]
    parts.append("h f")
    return "\n".join(parts)


def _circle(cx: float, cy: float, r: float, colour: Color) -> str:
    k = 0.5523 * r

    def p(x: float, y: float) -> str:
        return f"{number(x)} {number(y)}"

    parts = [
        rgb_op(colour),
        f"{p(cx + r, cy)} m",
        f"{p(cx + r, cy + k)} {p(cx + k, cy + r)} {p(cx, cy + r)} c",
        f"{p(cx - k, cy + r)} {p(cx - r, cy + k)} {p(cx - r, cy)} c",
        f"{p(cx - r, cy - k)} {p(cx - k, cy - r)} {p(cx, cy - r)} c",
        f"{p(cx + k, cy - r)} {p(cx + r, cy - k)} {p(cx + r, cy)} c",
        "h f",
    ]
    return "\n".join(parts)
