"""Markup annotations and their appearance streams (milestone v0.7, G1-G3).

Each annotation has a normal appearance (/AP /N) built here, so that every viewer draws it the
same way, and so that flattening (G5) can turn it into page content. Geometry is in user space:
the appearance's BBox is the annotation's /Rect and its matrix is the identity, so the content is
drawn at page coordinates.

- highlight: a filled quad per line with blend mode Multiply (the text under it stays visible);
- underline, strike-out, squiggly: stroked lines on the quad;
- note (Text): a 20 x 20 icon; free text: the text drawn with the overlay's Unicode font, with an
  optional background and border; ink: stroked polylines with round caps;
- line (optionally with an open arrow head), square and circle: the usual shapes.

Quad points follow the PDF order: upper left, upper right, lower left, lower right.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from typing import Any

import pikepdf
from pikepdf import Array, Dictionary, Name

from chef_core.annots.common import (
    colour_array,
    hex_of_array,
    name_of,
    normalised,
    pdf_date,
    text_of,
    text_string,
)
from chef_core.errors import invalid_params
from chef_core.overlay.engine import DocCache, Resources, TextStyle, text_piece

Rect = tuple[float, float, float, float]
Point = tuple[float, float]

MARKUP_SUBTYPES = {
    "highlight": "Highlight",
    "underline": "Underline",
    "strike": "StrikeOut",
    "squiggly": "Squiggly",
}
DEFAULT_COLOUR = {
    "Highlight": "#ffff00",
    "Underline": "#0066ff",
    "StrikeOut": "#e00000",
    "Squiggly": "#e00000",
    "Text": "#ffc107",
    "Ink": "#0000ff",
    "Line": "#0000ff",
    "Square": "#00aa00",
    "Circle": "#00aa00",
    "FreeText": "#000000",
}
NOTE_ICONS = ("Note", "Comment", "Key", "Help", "NewParagraph", "Paragraph", "Insert")
LINE_ENDINGS = ("None", "OpenArrow")
STATES = {
    "accepted": "Accepted",
    "rejected": "Rejected",
    "cancelled": "Cancelled",
    "completed": "Completed",
    "none": "None",
}
ICON_SIZE = 20.0


def rgb_of(value: str) -> tuple[float, float, float]:
    if len(value) != 7 or not value.startswith("#"):
        raise invalid_params("INVALID_COLOUR", {"value": value})
    return tuple(int(value[i : i + 2], 16) / 255 for i in (1, 3, 5))  # type: ignore[return-value]


def _num(v: float) -> str:
    return f"{v:.4f}".rstrip("0").rstrip(".") if abs(v) > 1e-9 else "0"


def _fill_ops(value: str) -> str:
    r, g, b = rgb_of(value)
    return f"{_num(r)} {_num(g)} {_num(b)} rg"


def _stroke_ops(value: str) -> str:
    r, g, b = rgb_of(value)
    return f"{_num(r)} {_num(g)} {_num(b)} RG"


def _pts(points: Sequence[Point]) -> str:
    return " ".join(f"{_num(x)} {_num(y)}" for x, y in points)


def _opacity_resources(pdf: pikepdf.Pdf, opacity: float, blend: str) -> Dictionary:
    gs = pdf.make_indirect(
        Dictionary(Type=Name.ExtGState, CA=opacity, ca=opacity, BM=Name("/" + blend))
    )
    return Dictionary(ExtGState=Dictionary(GS0=gs))


def _form(
    pdf: pikepdf.Pdf, rect: Rect, content: bytes, resources: Dictionary | None = None
) -> pikepdf.Stream:
    stream = pdf.make_stream(content)
    stream.Type = Name.XObject
    stream.Subtype = Name.Form
    stream.BBox = Array([round(v, 4) for v in rect])
    stream.Resources = resources if resources is not None else Dictionary()
    return stream


def quad_of(box: Rect) -> list[float]:
    """Quad points of an axis-aligned user-space box: UL, UR, LL, LR."""
    x0, y0, x1, y1 = box
    return [x0, y1, x1, y1, x0, y0, x1, y0]


def quads_of(annot: Dictionary) -> list[list[Point]]:
    """Quads of an annotation as lists of four (x, y) points (user space)."""
    raw = annot.get("/QuadPoints")
    if not isinstance(raw, pikepdf.Array):
        return []
    vals = [float(v) for v in raw]
    out: list[list[Point]] = []
    for k in range(0, len(vals) - 7, 8):
        out.append([(vals[k + 2 * i], vals[k + 2 * i + 1]) for i in range(4)])
    return out


def pad_rect(points: Sequence[Point], pad: float) -> Rect:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return (min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)


def _markup_appearance(pdf: pikepdf.Pdf, annot: Dictionary) -> tuple[Rect, bytes, Dictionary]:
    subtype = name_of(annot.get("/Subtype")) or ""
    colour = hex_of_array(annot.get("/C")) or DEFAULT_COLOUR[subtype]
    opacity = float(annot.get("/CA", 1.0))
    ops: list[str] = []
    quads = quads_of(annot)
    blend = "Multiply" if subtype == "Highlight" else "Normal"
    res = _opacity_resources(pdf, opacity, blend)
    if subtype == "Highlight":
        ops.append("/GS0 gs")
        ops.append(_fill_ops(colour))
        for ul, ur, ll, lr in quads:
            ops.append(
                f"{_num(ul[0])} {_num(ul[1])} m {_num(ur[0])} {_num(ur[1])} l "
                f"{_num(lr[0])} {_num(lr[1])} l {_num(ll[0])} {_num(ll[1])} l h f"
            )
    else:
        ops.append("/GS0 gs")
        ops.append(_stroke_ops(colour))
        for ul, ur, ll, lr in quads:
            height = max(ul[1] - ll[1], 1.0)
            if subtype == "Underline":
                width = max(0.6, height * 0.07)
                y = ll[1] + width / 2
                ops.append(f"{_num(width)} w {_num(ll[0])} {_num(y)} m {_num(lr[0])} {_num(y)} l S")
            elif subtype == "StrikeOut":
                width = max(0.6, height * 0.06)
                y = (ul[1] + ll[1]) / 2
                ops.append(f"{_num(width)} w {_num(ul[0])} {_num(y)} m {_num(ur[0])} {_num(y)} l S")
            else:  # Squiggly
                amp = max(0.8, height * 0.08)
                step = max(1.4, height * 0.16)
                y0 = ll[1] + amp / 2
                pts: list[Point] = []
                x = ll[0]
                k = 0
                while x < lr[0]:
                    pts.append((x, y0 + (amp if k % 2 else 0.0)))
                    x += step
                    k += 1
                pts.append((lr[0], y0 + (amp if k % 2 else 0.0)))
                path = f"{_num(pts[0][0])} {_num(pts[0][1])} m"
                path += "".join(f" {_num(px)} {_num(py)} l" for px, py in pts[1:])
                ops.append(f"{_num(max(0.5, height * 0.05))} w {path} S")
    rect = pad_rect([p for quad in quads for p in quad], 1.0)
    return rect, "\n".join(ops).encode(), res


def _ink_appearance(pdf: pikepdf.Pdf, annot: Dictionary) -> tuple[Rect, bytes, Dictionary]:
    colour = hex_of_array(annot.get("/C")) or DEFAULT_COLOUR["Ink"]
    width = _border_width(annot, 1.0)
    opacity = float(annot.get("/CA", 1.0))
    res = _opacity_resources(pdf, opacity, "Normal")
    ops = ["/GS0 gs", _stroke_ops(colour), f"{_num(width)} w 1 J 1 j"]
    points: list[Point] = []
    for stroke in annot.get("/InkList") or []:
        vals = [float(v) for v in stroke]
        pts = [(vals[k], vals[k + 1]) for k in range(0, len(vals) - 1, 2)]
        if not pts:
            continue
        points += pts
        ops.append(f"{_num(pts[0][0])} {_num(pts[0][1])} m")
        ops += [f"{_num(x)} {_num(y)} l" for x, y in pts[1:]]
        ops.append("S" if len(pts) > 1 else "")
    rect = pad_rect(points or [(0.0, 0.0)], width)
    return rect, "\n".join(o for o in ops if o).encode(), res


def _border_width(annot: Dictionary, default: float) -> float:
    bs = annot.get("/BS")
    if isinstance(bs, Dictionary) and "/W" in bs:
        return float(bs["/W"])
    border = annot.get("/Border")
    if isinstance(border, pikepdf.Array) and len(border) >= 3:
        return float(border[2])
    return default


def _line_appearance(pdf: pikepdf.Pdf, annot: Dictionary) -> tuple[Rect, bytes, Dictionary]:
    colour = hex_of_array(annot.get("/C")) or DEFAULT_COLOUR["Line"]
    width = _border_width(annot, 1.0)
    coords = [float(v) for v in annot["/L"]]
    x1, y1, x2, y2 = coords[:4]
    res = _opacity_resources(pdf, float(annot.get("/CA", 1.0)), "Normal")
    ops = ["/GS0 gs", _stroke_ops(colour), f"{_num(width)} w 1 J 1 j"]
    ops.append(f"{_num(x1)} {_num(y1)} m {_num(x2)} {_num(y2)} l S")
    points: list[Point] = [(x1, y1), (x2, y2)]
    ending = name_of(_item(annot.get("/LE"), 1)) or "None"
    if ending == "OpenArrow":
        length = math.hypot(x2 - x1, y2 - y1) or 1.0
        ux, uy = (x2 - x1) / length, (y2 - y1) / length
        head = max(6.0, 4.0 * width)
        heads: list[Point] = []
        for angle in (math.radians(155), math.radians(-155)):
            cos, sin = math.cos(angle), math.sin(angle)
            hx = ux * cos - uy * sin
            hy = ux * sin + uy * cos
            heads.append((x2 + head * hx, y2 + head * hy))
        ops.append(f"{_num(heads[0][0])} {_num(heads[0][1])} m {_num(x2)} {_num(y2)} l")
        ops.append(f"{_num(heads[1][0])} {_num(heads[1][1])} l S")
        points += heads
    rect = pad_rect(points, width + 2)
    return rect, "\n".join(ops).encode(), res


def _item(obj: Any, index: int) -> Any:
    if isinstance(obj, pikepdf.Array) and len(obj) > index:
        return obj[index]
    return None


def _ellipse_path(cx: float, cy: float, rx: float, ry: float) -> str:
    """An ellipse as four Bezier curves (path construction only; the caller paints it)."""
    k = 0.5523
    curves = [
        ((cx + rx, cy + k * ry), (cx + k * rx, cy + ry), (cx, cy + ry)),
        ((cx - k * rx, cy + ry), (cx - rx, cy + k * ry), (cx - rx, cy)),
        ((cx - rx, cy - k * ry), (cx - k * rx, cy - ry), (cx, cy - ry)),
        ((cx + k * rx, cy - ry), (cx + rx, cy - k * ry), (cx + rx, cy)),
    ]
    parts = [f"{_num(cx + rx)} {_num(cy)} m"]
    for c1, c2, end in curves:
        parts.append(" ".join(_num(v) for pt in (c1, c2, end) for v in pt) + " c")
    return " ".join(parts)


def _shape_appearance(pdf: pikepdf.Pdf, annot: Dictionary) -> tuple[Rect, bytes, Dictionary]:
    subtype = name_of(annot.get("/Subtype")) or "Square"
    stroke = hex_of_array(annot.get("/C")) or DEFAULT_COLOUR[subtype]
    fill = hex_of_array(annot.get("/IC"))
    width = _border_width(annot, 1.0)
    rect = normalised(annot["/Rect"])
    res = _opacity_resources(pdf, float(annot.get("/CA", 1.0)), "Normal")
    ops = ["/GS0 gs", _stroke_ops(stroke), f"{_num(width)} w"]
    if fill is not None:
        ops.append(_fill_ops(fill))
    x0, y0, x1, y1 = rect
    inset = width / 2
    if subtype == "Circle":
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        rx, ry = (x1 - x0) / 2 - inset, (y1 - y0) / 2 - inset
        ops.append(_ellipse_path(cx, cy, rx, ry))
    else:
        ops.append(
            f"{_num(x0 + inset)} {_num(y0 + inset)} {_num(x1 - x0 - 2 * inset)} "
            f"{_num(y1 - y0 - 2 * inset)} re"
        )
    ops.append("b" if fill is not None else "S")
    return rect, "\n".join(ops).encode(), res


def _note_appearance(pdf: pikepdf.Pdf, annot: Dictionary) -> tuple[Rect, bytes, Dictionary]:
    rect = normalised(annot["/Rect"])
    colour = hex_of_array(annot.get("/C")) or DEFAULT_COLOUR["Text"]
    x0, y0, x1, y1 = rect
    ops = [
        "q",
        _fill_ops(colour),
        "0 G 0.6 w",
        f"{_num(x0 + 0.5)} {_num(y0 + 0.5)} {_num(x1 - x0 - 1)} {_num(y1 - y0 - 1)} re b",
        "0.25 G",
    ]
    for frac in (0.3, 0.5, 0.7):
        yy = y0 + (y1 - y0) * frac
        ops.append(f"{_num(x0 + 4)} {_num(yy)} m {_num(x1 - 4)} {_num(yy)} l S")
    ops.append("Q")
    return rect, "\n".join(ops).encode(), Dictionary()


def _free_text_appearance(
    pdf: pikepdf.Pdf, annot: Dictionary, doc: DocCache | None = None
) -> tuple[Rect, bytes, Dictionary]:
    rect = normalised(annot["/Rect"])
    x0, y0, x1, y1 = rect
    size = float(_da_size(annot))
    colour = _da_colour(annot)
    bg = hex_of_array(annot.get("/IC"))
    border = hex_of_array(annot.get("/C"))
    width = _border_width(annot, 0.0)
    cache = doc or DocCache(pdf)
    pad = 4.0
    res = Resources("ChefAnn")
    text = _contents(annot)
    piece = text_piece(
        res,
        cache,
        text,
        TextStyle(font_family="BeVietnamPro", font_size=size, color=colour, line_height=1.2),
        width=max(x1 - x0 - 2 * pad, 1.0),
    )
    ops = ["q"]
    if bg is not None:
        ops.append(f"{_fill_ops(bg)} {_num(x0)} {_num(y0)} {_num(x1 - x0)} {_num(y1 - y0)} re f")
    if width > 0 and border is not None:
        ops.append(f"{_stroke_ops(border)} {_num(width)} w")
        ops.append(
            f"{_num(x0 + width / 2)} {_num(y0 + width / 2)} "
            f"{_num(x1 - x0 - width)} {_num(y1 - y0 - width)} re S"
        )
    ops.append("Q")
    ops.append(f"q 1 0 0 1 {_num(x0 + pad)} {_num(y0 + pad)} cm")
    ops.append(piece.body)
    ops.append("Q")
    resources = res.as_dictionary()
    return rect, "\n".join(ops).encode(), resources


def _contents(annot: Dictionary) -> str:
    return text_of(annot.get("/Contents"))


def _da_size(annot: Dictionary) -> float:
    da = str(annot.get("/DA", "")).split()
    for i, token in enumerate(da):
        if token == "Tf" and i >= 1:
            try:
                return float(da[i - 1])
            except ValueError:
                break
    return 12.0


def _da_colour(annot: Dictionary) -> tuple[float, float, float]:
    da = str(annot.get("/DA", "")).split()
    for i, token in enumerate(da):
        if token == "rg" and i >= 3:
            try:
                return (float(da[i - 3]), float(da[i - 2]), float(da[i - 1]))
            except ValueError:
                break
    return (0.0, 0.0, 0.0)


def build_appearance(pdf: pikepdf.Pdf, annot: Dictionary) -> None:
    """(Re)write /AP /N of a markup annotation from its own fields."""
    subtype = name_of(annot.get("/Subtype")) or ""
    if subtype in ("Highlight", "Underline", "StrikeOut", "Squiggly"):
        rect, content, res = _markup_appearance(pdf, annot)
    elif subtype == "Ink":
        rect, content, res = _ink_appearance(pdf, annot)
    elif subtype == "Line":
        rect, content, res = _line_appearance(pdf, annot)
    elif subtype in ("Square", "Circle"):
        rect, content, res = _shape_appearance(pdf, annot)
    elif subtype == "Text":
        rect, content, res = _note_appearance(pdf, annot)
    elif subtype == "FreeText":
        rect, content, res = _free_text_appearance(pdf, annot)
    else:
        raise invalid_params("NO_APPEARANCE", {"subtype": subtype})
    if subtype in (
        "Highlight",
        "Underline",
        "StrikeOut",
        "Squiggly",
        "Ink",
        "Line",
        "Square",
        "Circle",
    ):
        annot.Rect = Array([round(v, 4) for v in rect])
    stream = _form(pdf, rect, content, res)
    annot.AP = Dictionary(N=stream)


def _base(subtype: str, rect: Rect, author: str, contents: str, colour: str | None) -> Dictionary:
    annot = Dictionary(
        Type=Name.Annot,
        Subtype=Name("/" + subtype),
        Rect=Array([round(v, 4) for v in rect]),
        F=4,
        T=text_string(author),
        Contents=text_string(contents),
        M=pdf_date(),
    )
    annot.C = colour_array(colour or DEFAULT_COLOUR[subtype])
    return annot


def markup_dict(
    pdf: pikepdf.Pdf,
    kind: str,
    quads: list[list[Point]],
    *,
    colour: str | None,
    opacity: float,
    contents: str,
    author: str,
) -> Dictionary:
    if kind not in MARKUP_SUBTYPES:
        raise invalid_params("INVALID_MARKUP_KIND", {"kind": kind})
    subtype = MARKUP_SUBTYPES[kind]
    flat = [p for quad in quads for p in quad]
    rect = pad_rect(flat, 1.0)
    annot = _base(subtype, rect, author, contents, colour)
    annot.QuadPoints = Array([round(v, 4) for quad in quads for p in quad for v in p])
    annot.CA = round(opacity, 4)
    build_appearance(pdf, annot)
    return annot


def note_dict(
    pdf: pikepdf.Pdf,
    box: Rect,
    *,
    contents: str,
    author: str,
    colour: str | None,
    icon: str,
    opacity: float,
) -> Dictionary:
    if icon not in NOTE_ICONS:
        raise invalid_params("INVALID_ICON", {"icon": icon})
    annot = _base("Text", box, author, contents, colour)
    annot.Name = Name("/" + icon)
    annot.Open = False
    annot.CA = round(opacity, 4)
    build_appearance(pdf, annot)
    return annot


def free_text_dict(
    pdf: pikepdf.Pdf,
    box: Rect,
    *,
    text: str,
    size: float,
    colour: str,
    background: str | None,
    border_colour: str,
    border_width: float,
    author: str,
) -> Dictionary:
    annot = _base("FreeText", box, author, text, border_colour)
    annot.DA = pikepdf.String(f"/ChefF0 {_num(size)} Tf {_fill_ops(colour)}")
    if background is not None:
        annot.IC = colour_array(background)
    annot.BS = Dictionary(W=border_width, S=Name.S)
    build_appearance(pdf, annot)
    return annot


def ink_dict(
    pdf: pikepdf.Pdf,
    strokes: list[list[Point]],
    *,
    colour: str | None,
    width: float,
    opacity: float,
    author: str,
) -> Dictionary:
    points = [p for stroke in strokes for p in stroke]
    rect = pad_rect(points, width)
    annot = _base("Ink", rect, author, "", colour)
    annot.InkList = Array([Array([round(v, 4) for p in s for v in p]) for s in strokes])
    annot.BS = Dictionary(W=width, S=Name.S)
    annot.CA = round(opacity, 4)
    build_appearance(pdf, annot)
    return annot


def shape_dict(
    pdf: pikepdf.Pdf,
    kind: str,
    *,
    rect: Rect | None,
    points: list[Point] | None,
    colour: str | None,
    fill: str | None,
    width: float,
    author: str,
    arrow: bool,
) -> Dictionary:
    if kind in ("line", "arrow"):
        if points is None or len(points) != 2:
            raise invalid_params("SHAPE_NEEDS_TWO_POINTS", {"kind": kind})
        (x1, y1), (x2, y2) = points
        box = pad_rect(points, width + 2)
        annot = _base("Line", box, author, "", colour)
        annot.L = Array([x1, y1, x2, y2])
        annot.LE = Array(
            [Name("/None"), Name("/OpenArrow" if arrow or kind == "arrow" else "/None")]
        )
    elif kind in ("rect", "ellipse"):
        if rect is None:
            raise invalid_params("SHAPE_NEEDS_RECT", {"kind": kind})
        box = normalised(rect)
        annot = _base("Square" if kind == "rect" else "Circle", box, author, "", colour)
        if fill is not None:
            annot.IC = colour_array(fill)
    else:
        raise invalid_params("INVALID_SHAPE", {"kind": kind})
    annot.BS = Dictionary(W=width, S=Name.S)
    build_appearance(pdf, annot)
    return annot


def reply_dict(
    pdf: pikepdf.Pdf,
    parent: Dictionary,
    parent_rect: Rect,
    *,
    text: str,
    author: str,
    colour: str | None,
) -> Dictionary:
    x1 = parent_rect[2]
    y1 = parent_rect[3]
    box = (x1 - ICON_SIZE / 2, y1 - ICON_SIZE / 2, x1 + ICON_SIZE / 2, y1 + ICON_SIZE / 2)
    annot = _base("Text", box, author, text, colour or hex_of_array(parent.get("/C")))
    annot.Name = Name.Note
    annot.Open = False
    annot.IRT = parent
    annot.RT = Name.R
    build_appearance(pdf, annot)
    return annot


def set_state(annot: Dictionary, status: str) -> None:
    if status not in STATES:
        raise invalid_params("INVALID_STATUS", {"status": status})
    annot.StateModel = Name("/Review")
    annot.State = Name("/" + STATES[status])


__all__ = [
    "DEFAULT_COLOUR",
    "LINE_ENDINGS",
    "MARKUP_SUBTYPES",
    "NOTE_ICONS",
    "STATES",
    "build_appearance",
    "free_text_dict",
    "ink_dict",
    "markup_dict",
    "note_dict",
    "quad_of",
    "quads_of",
    "reply_dict",
    "rgb_of",
    "set_state",
    "shape_dict",
]
