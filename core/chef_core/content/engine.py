"""Page content engine (T6.01): reads a page into paint objects with geometry.

The engine interprets the content stream operator by operator with a graphics state machine
(q/Q, cm, text matrices and text state, colours, alpha, clipping, marked content). Every paint
operation that makes ink becomes a ``PageObject``:

- ``text``: one text-showing operator (Tj, TJ, ', ") with its string, font, size and colour.
  Its box is the run's glyph box (font ascent/descent) in user space.
- ``image``: a Do of an image XObject, or an inline image. Its box is the unit square under CTM.
- ``path``: a path construction followed by a painting operator (f, S, B, ...). ``W``/``W*``
  set a clip for the rest of the q level; a path that only clips makes no object.
- ``shading``: sh. Its box is the clip in effect (or the page box).
- ``form``: a Do of a form XObject. With ``include children`` (always computed, so ids are
  stable) the objects drawn by the form follow it with ``parent_id`` set.

Coordinates are in the page's default user space. ``chef_core.overlay.pagecontent.page_frame``
maps them to the displayed frame (after /Rotate and CropBox) for the UI.

``build_model(..., flatten=True)`` inlines every form of the page into the page's own content
(resource names are renamed, ActualText spans are dropped). Objects that were children of a form
keep their origin keys, so the editor can find them again after flattening.
"""

from __future__ import annotations

import math
from contextlib import suppress
from dataclasses import dataclass, field
from itertools import pairwise
from typing import Any, Literal

import pikepdf
from pikepdf import Dictionary, Name

from chef_core.content.fonts import APPROX_WIDTH, FontInfo
from chef_core.content.model import (
    Colour,
    Ins,
    Key,
    Matrix,
    PageModel,
    PageObject,
    Rect,
    make_id,
)
from chef_core.overlay.pagecontent import (
    category,
    content_bytes,
    inherited,
    own_resources,
    page_frame,
)
from chef_core.pdf.content import IDENTITY, as_matrix, mul

MAX_DEPTH = 12
CONSTRUCT_OPS = {"m", "l", "c", "v", "y", "re"}
FILL_OPS = {"f", "F", "f*", "B", "B*", "b", "b*"}
STROKE_OPS = {"S", "s", "B", "B*", "b", "b*"}
PAINT_OPS = FILL_OPS | STROKE_OPS | {"n"}
# operator -> (resource category, index of the operand that names the resource)
NAMED_OPS: dict[str, str] = {
    "Tf": "Font",
    "Do": "XObject",
    "gs": "ExtGState",
    "cs": "ColorSpace",
    "CS": "ColorSpace",
    "sh": "Shading",
}
Mode = Literal["intersect", "contain"]


# -- small helpers ----------------------------------------------------------------------------


def inverse(m: Matrix) -> Matrix:
    a, b, c, d, e, f = m
    det = a * d - b * c
    if abs(det) < 1e-12:
        raise ValueError("singular matrix")
    return (d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det)


def apply(m: Matrix, x: float, y: float) -> tuple[float, float]:
    return (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])


def _rect_of(points: list[tuple[float, float]]) -> Rect:
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return (min(xs), min(ys), max(xs), max(ys))


def intersect(a: Rect | None, b: Rect) -> Rect:
    if a is None:
        return b
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    if x1 < x0:
        x1 = x0
    if y1 < y0:
        y1 = y0
    return (x0, y0, x1, y1)


def _float(value: Any) -> float:
    return float(value)


def _lookup(res: Any, kind: str, name: str) -> Any:
    if not isinstance(res, Dictionary):
        return None
    table = res.get("/" + kind)
    if not isinstance(table, Dictionary):
        return None
    return table.get(name)


def _colour_of(state: tuple[str, str | None, tuple[float, ...]]) -> Colour | None:
    op, _space, comps = state
    if op == "g":
        return ("gray", comps)
    if op == "rg":
        return ("rgb", comps)
    if op == "k":
        return ("cmyk", comps)
    if op == "scn":
        return ("named", comps)
    return None


def _parse(source: Any, chain: Key) -> list[Ins]:
    return [
        Ins(list(ins.operands), str(ins.operator), (*chain, j))
        for j, ins in enumerate(pikepdf.parse_content_stream(source))
    ]


def _digest(page: pikepdf.Page) -> str:
    import hashlib

    return hashlib.sha1(content_bytes(page)).hexdigest()[:12]


# -- graphics state ---------------------------------------------------------------------------

ColourState = tuple[str, str | None, tuple[float, ...]]


@dataclass
class GState:
    ctm: Matrix = IDENTITY
    fill: ColourState = ("g", None, (0.0,))
    stroke: ColourState = ("g", None, (0.0,))
    fa: float = 1.0
    sa: float = 1.0
    lw: float = 1.0
    dash: tuple[Any, Any] | None = None
    clip: Rect | None = None
    pend_clip: bool = False
    tc: float = 0.0
    tw: float = 0.0
    th: float = 1.0
    tl: float = 0.0
    ts: float = 0.0
    tr: int = 0
    tf: str | None = None
    tfs: float = 0.0

    def copy(self) -> GState:
        return GState(**self.__dict__)


@dataclass
class _Path:
    start: int
    ctm: Matrix
    polylines: list[list[tuple[float, float]]] = field(default_factory=list)
    cur: tuple[float, float] = (0.0, 0.0)
    segs: int = 0

    def bbox(self) -> Rect | None:
        pts = [p for line in self.polylines for p in line]
        return _rect_of(pts) if pts else None


def _cubic(p0: tuple[float, float], p1: Any, p2: Any, p3: Any) -> list[tuple[float, float]]:
    out = []
    for k in range(1, 9):
        t = k / 8
        u = 1 - t
        out.append(
            (
                u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
                u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1],
            )
        )
    return out


class _Walker:
    def __init__(self, page_box: Rect, page_res: Any) -> None:
        self.objects: list[PageObject] = []
        self.clean_at: list[bool] = []
        self.ctm_at: list[Matrix] = []
        self.page_box = page_box
        self.page_res = page_res
        self._fonts: dict[Any, FontInfo] = {}
        self._active: set[tuple[int, int]] = set()

    # -- resources ----------------------------------------------------------------------

    def _font(self, res: Any, name: str | None) -> FontInfo | None:
        if name is None:
            return None
        fd = _lookup(res, "Font", name)
        if not isinstance(fd, Dictionary):
            return None
        cache_key: Any = fd.objgen if fd.is_indirect else id(fd)
        if cache_key not in self._fonts:
            self._fonts[cache_key] = FontInfo(fd)
        return self._fonts[cache_key]

    @staticmethod
    def _layer(res: Any, props: Any) -> str | None:
        target: Any = None
        if isinstance(props, Name):
            target = _lookup(res, "Properties", str(props))
        elif isinstance(props, Dictionary):
            target = props
        if isinstance(target, Dictionary) and "/Name" in target:
            return str(target["/Name"])
        return None

    # -- the interpreter ----------------------------------------------------------------

    def run(
        self,
        nodes: list[Ins],
        res: Any,
        gs: GState,
        depth: int,
        *,
        page_level: bool,
        parent_key: Key | None = None,
    ) -> None:
        stack: list[GState] = []
        marks: list[Ins] = []
        in_bt = False
        tm: Matrix = IDENTITY
        tlm: Matrix = IDENTITY
        path: _Path | None = None
        for i, ins in enumerate(nodes):
            if page_level:
                self.clean_at.append(
                    not stack and gs.clip is None and not in_bt and not marks and path is None
                )
                self.ctm_at.append(gs.ctm)
            op, ops = ins.op, ins.operands
            if op in CONSTRUCT_OPS:
                if path is None:
                    path = _Path(start=i, ctm=gs.ctm)
                self._construct(path, op, ops, gs.ctm)
            elif op == "h":
                if path is not None and path.polylines:
                    path.polylines[-1].append(path.polylines[-1][0])
                    path.cur = path.polylines[-1][0]
            elif op in ("W", "W*"):
                gs.pend_clip = True
            elif op in PAINT_OPS:
                if path is not None:
                    if op in FILL_OPS or op in STROKE_OPS:
                        self._paint(
                            path, i, op, gs, marks, nodes, res, page_level, parent_key, depth
                        )
                    if gs.pend_clip:
                        box = path.bbox()
                        if box is not None:
                            gs.clip = intersect(gs.clip, box)
                    gs.pend_clip = False
                    path = None
            elif op == "q":
                stack.append(gs.copy())
            elif op == "Q":
                if stack:
                    gs = stack.pop()
            elif op == "cm":
                m = as_matrix(ops)
                if m is not None:
                    gs.ctm = mul(m, gs.ctm)
            elif op == "BT":
                in_bt = True
                tm = tlm = IDENTITY
            elif op == "ET":
                in_bt = False
            elif op == "Tf":
                gs.tf = str(ops[0])
                gs.tfs = _float(ops[1])
            elif op == "Td":
                tlm = mul((1.0, 0.0, 0.0, 1.0, _float(ops[0]), _float(ops[1])), tlm)
                tm = tlm
            elif op == "TD":
                gs.tl = -_float(ops[1])
                tlm = mul((1.0, 0.0, 0.0, 1.0, _float(ops[0]), _float(ops[1])), tlm)
                tm = tlm
            elif op == "Tm":
                tlm = tm = as_matrix(ops) or IDENTITY
            elif op == "T*":
                tlm = mul((1.0, 0.0, 0.0, 1.0, 0.0, -gs.tl), tlm)
                tm = tlm
            elif op == "TL":
                gs.tl = _float(ops[0])
            elif op == "Tc":
                gs.tc = _float(ops[0])
            elif op == "Tw":
                gs.tw = _float(ops[0])
            elif op == "Tz":
                gs.th = _float(ops[0]) / 100
            elif op == "Ts":
                gs.ts = _float(ops[0])
            elif op == "Tr":
                gs.tr = int(_float(ops[0]))
            elif op in ("Tj", "TJ", "'", '"'):
                items: list[Any]
                if op == "TJ":
                    items = list(ops[0]) if ops else []
                elif op == '"':
                    gs.tw, gs.tc = _float(ops[0]), _float(ops[1])
                    items = [ops[2]]
                else:
                    items = [ops[0]] if ops else []
                if op in ("'", '"'):
                    tlm = mul((1.0, 0.0, 0.0, 1.0, 0.0, -gs.tl), tlm)
                    tm = tlm
                obj, advance = self._show(
                    ins.key, i, items, res, gs, tm, marks, page_level, parent_key
                )
                if obj is not None:
                    self.objects.append(obj)
                tm = mul((1.0, 0.0, 0.0, 1.0, advance, 0.0), tm)
            elif op == "Do":
                self._do(i, ins, res, gs, marks, page_level, parent_key, depth)
            elif op == "INLINE IMAGE":
                self._inline_image(i, ins, gs, marks, page_level, parent_key)
            elif op == "sh":
                box = intersect(gs.clip, self.page_box) if gs.clip is not None else self.page_box
                self.objects.append(
                    self._base(ins.key, i, "shading", box, gs, marks, page_level, parent_key)
                )
            elif op in ("g", "rg", "k"):
                gs.fill = (op, None, tuple(_float(v) for v in ops))
            elif op in ("G", "RG", "K"):
                gs.stroke = (op.lower(), None, tuple(_float(v) for v in ops))
            elif op in ("cs", "CS"):
                name = str(ops[0]) if ops else None
                state: ColourState = ("scn", name, (0.0,))
                if op == "cs":
                    gs.fill = state
                else:
                    gs.stroke = state
            elif op in ("sc", "scn", "SC", "SCN"):
                is_stroke = op in ("SC", "SCN")
                current = gs.stroke if is_stroke else gs.fill
                if ops and isinstance(ops[-1], Name):
                    new_state: ColourState = ("pattern", str(ops[-1]), ())
                else:
                    new_state = ("scn", current[1], tuple(_float(v) for v in ops))
                if is_stroke:
                    gs.stroke = new_state
                else:
                    gs.fill = new_state
            elif op == "gs":
                state_dict = _lookup(res, "ExtGState", str(ops[0])) if ops else None
                if isinstance(state_dict, Dictionary):
                    if "/ca" in state_dict:
                        gs.fa = _float(state_dict["/ca"])
                    if "/CA" in state_dict:
                        gs.sa = _float(state_dict["/CA"])
                    if "/LW" in state_dict:
                        gs.lw = _float(state_dict["/LW"])
            elif op == "w":
                gs.lw = _float(ops[0])
            elif op == "d" and len(ops) == 2:
                gs.dash = (ops[0], ops[1])
            elif op in ("BDC", "BMC"):
                marks.append(ins)
            elif op == "EMC":
                if marks:
                    marks.pop()
        if page_level:
            self.clean_at.append(
                not stack and gs.clip is None and not in_bt and not marks and path is None
            )
            self.ctm_at.append(gs.ctm)

    # -- geometry -----------------------------------------------------------------------

    def _construct(self, path: _Path, op: str, ops: list[Any], ctm: Matrix) -> None:
        pts = [_float(v) for v in ops]
        if op == "m":
            p = apply(ctm, pts[0], pts[1])
            path.polylines.append([p])
            path.cur = p
            path.segs += 1
        elif op == "l":
            p = apply(ctm, pts[0], pts[1])
            if not path.polylines:
                path.polylines.append([path.cur])
            path.polylines[-1].append(p)
            path.cur = p
            path.segs += 1
        elif op in ("c", "v", "y"):
            if op == "c":
                p1, p2, p3 = (pts[0], pts[1]), (pts[2], pts[3]), (pts[4], pts[5])
            elif op == "v":
                p1, p2, p3 = path.cur, (pts[0], pts[1]), (pts[2], pts[3])
            else:
                p1, p2, p3 = (pts[0], pts[1]), (pts[2], pts[3]), (pts[2], pts[3])
            p1u, p2u, p3u = apply(ctm, *p1), apply(ctm, *p2), apply(ctm, *p3)
            if not path.polylines:
                path.polylines.append([path.cur])
            path.polylines[-1].extend(_cubic(path.cur, p1u, p2u, p3u))
            path.cur = p3u
            path.segs += 1
        elif op == "re":
            x, y, w, h = pts
            corners = [
                apply(ctm, x, y),
                apply(ctm, x + w, y),
                apply(ctm, x + w, y + h),
                apply(ctm, x, y + h),
                apply(ctm, x, y),
            ]
            path.polylines.append(corners)
            path.cur = corners[0]
            path.segs += 4

    def _paint(
        self,
        path: _Path,
        i: int,
        op: str,
        gs: GState,
        marks: list[Ins],
        nodes: list[Ins],
        res: Any,
        page_level: bool,
        parent_key: Key | None,
        depth: int,
    ) -> None:
        box = path.bbox()
        if box is None:
            return
        fill = op in FILL_OPS
        stroke = op in STROKE_OPS
        bbox = box
        if stroke:
            pad = abs(gs.lw) / 2
            bbox = (box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad)
        clipped = gs.clip is not None or gs.pend_clip
        if gs.clip is not None:
            bbox = intersect(gs.clip, bbox)
        obj = self._make(
            "path",
            nodes[path.start].key,
            bbox,
            page_level,
            parent_key,
            gs,
            marks,
            start=path.start,
            end=i,
            ctm=path.ctm,
            clipped=clipped,
        )
        obj.fill = fill
        obj.stroke = stroke
        obj.segments = path.segs
        obj.stroke_width = gs.lw
        obj.polylines = [list(line) for line in path.polylines]
        obj.fill_color = _colour_of(gs.fill) if fill else None
        obj.stroke_color = _colour_of(gs.stroke) if stroke else None
        self.objects.append(obj)

    def _make(
        self,
        kind: str,
        key: Key,
        bbox: Rect,
        page_level: bool,
        parent_key: Key | None,
        gs: GState,
        marks: list[Ins],
        *,
        start: int = -1,
        end: int = -1,
        ctm: Matrix | None = None,
        clipped: bool | None = None,
    ) -> PageObject:
        names = []
        layer: str | None = None
        for mk in marks:
            names.append(str(mk.operands[0]).lstrip("/") if mk.operands else "")
            if mk.op == "BDC" and len(mk.operands) > 1 and str(mk.operands[0]) == "/OC":
                layer = self._layer(self.page_res, mk.operands[1])
        return PageObject(
            kind=kind,
            key=key,
            bbox=bbox,
            in_page=page_level,
            start=start,
            end=end,
            parent_key=parent_key,
            marks=names,
            layer=layer,
            mark_ins=list(marks),
            ctm=ctm if ctm is not None else gs.ctm,
            clipped=(gs.clip is not None) if clipped is None else clipped,
            fill_op=gs.fill,
            stroke_op=gs.stroke,
            fa=gs.fa,
            sa=gs.sa,
            lw=gs.lw,
            dash=gs.dash,
        )

    def _base(
        self,
        key: Key,
        index: int,
        kind: str,
        bbox: Rect,
        gs: GState,
        marks: list[Ins],
        page_level: bool,
        parent_key: Key | None,
    ) -> PageObject:
        return self._make(
            kind, key, bbox, page_level, parent_key, gs, marks, start=index, end=index
        )

    @staticmethod
    def _unit_box(ctm: Matrix) -> Rect:
        return _rect_of([apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 1, 1), apply(ctm, 0, 1)])

    # -- text ---------------------------------------------------------------------------

    def _show(
        self,
        key: Key,
        index: int,
        items: list[Any],
        res: Any,
        gs: GState,
        tm: Matrix,
        marks: list[Ins],
        page_level: bool,
        parent_key: Key | None,
    ) -> tuple[PageObject | None, float]:
        font = self._font(res, gs.tf)
        tfs, th = gs.tfs, gs.th
        chars: list[str] = []
        codes_all: list[int] = []
        pos = 0.0
        for item in items:
            if isinstance(item, pikepdf.String):
                data = bytes(item)
                codes = font.codes(data) if font is not None else list(data)
                for code in codes:
                    width = (font.width(code) if font is not None else APPROX_WIDTH) / 1000
                    word_space = gs.tw if (font is None or not font.is_cid) and code == 32 else 0.0
                    pos += (width * tfs + gs.tc + word_space) * th
                    chars.append(font.text(code) if font is not None else chr(code))
                    codes_all.append(code)
            else:
                with suppress(TypeError, ValueError):
                    pos += -_float(item) / 1000 * tfs * th
        if not codes_all:
            return None, pos
        asc = (font.ascent if font else 800.0) / 1000
        desc = (font.descent if font else -200.0) / 1000
        y0, y1 = desc * tfs + gs.ts, asc * tfs + gs.ts
        m = mul(tm, gs.ctm)
        quad = tuple(apply(m, x, y) for x, y in ((0.0, y0), (pos, y0), (pos, y1), (0.0, y1)))
        bbox = _rect_of(list(quad))
        if gs.clip is not None:
            bbox = intersect(gs.clip, bbox)
        obj = self._make(
            "text", key, bbox, page_level, parent_key, gs, marks, start=index, end=index
        )
        obj.string = "".join(chars)
        obj.font = gs.tf
        obj.font_name = font.base if font is not None else ""
        obj.font_size = tfs
        obj.tm = tm
        obj.advance = pos
        obj.tc, obj.tw, obj.th, obj.tl, obj.ts, obj.tr = gs.tc, gs.tw, th, gs.tl, gs.ts, gs.tr
        obj.quad = quad
        obj.fill_color = _colour_of(gs.fill)
        obj.stroke_color = _colour_of(gs.stroke)
        return obj, pos

    # -- XObjects -----------------------------------------------------------------------

    def _do(
        self,
        i: int,
        ins: Ins,
        res: Any,
        gs: GState,
        marks: list[Ins],
        page_level: bool,
        parent_key: Key | None,
        depth: int,
    ) -> None:
        name = str(ins.operands[0]) if ins.operands else ""
        xo = _lookup(res, "XObject", name)
        if not isinstance(xo, pikepdf.Stream):
            return
        subtype = str(xo.get("/Subtype", ""))
        if subtype == "/Image":
            obj = self._base(
                ins.key, i, "image", self._unit_box(gs.ctm), gs, marks, page_level, parent_key
            )
            obj.bbox = intersect(gs.clip, obj.bbox) if gs.clip is not None else obj.bbox
            obj.quad = tuple(apply(gs.ctm, x, y) for x, y in ((0, 0), (1, 0), (1, 1), (0, 1)))
            obj.image_name = name
            obj.pixel_size = (int(xo.get("/Width", 0)), int(xo.get("/Height", 0)))
            obj.smask = "/SMask" in xo or "/Mask" in xo
            self.objects.append(obj)
        elif subtype == "/Form":
            self._form(i, ins, xo, res, gs, marks, page_level, parent_key, depth)

    def _form(
        self,
        i: int,
        ins: Ins,
        xo: Any,
        res: Any,
        gs: GState,
        marks: list[Ins],
        page_level: bool,
        parent_key: Key | None,
        depth: int,
    ) -> None:
        matrix = as_matrix(xo.get("/Matrix")) or IDENTITY
        inner_ctm = mul(matrix, gs.ctm)
        bx = [_float(v) for v in xo.get("/BBox", [0, 0, 0, 0])]
        bbox_user = _rect_of(
            [
                apply(inner_ctm, bx[0], bx[1]),
                apply(inner_ctm, bx[2], bx[1]),
                apply(inner_ctm, bx[2], bx[3]),
                apply(inner_ctm, bx[0], bx[3]),
            ]
        )
        clip = intersect(gs.clip, bbox_user) if gs.clip is not None else bbox_user
        obj = self._base(ins.key, i, "form", clip, gs, marks, page_level, parent_key)
        obj.ctm = gs.ctm
        self.objects.append(obj)
        ident = xo.objgen if xo.is_indirect else (id(xo), 0)
        if depth >= MAX_DEPTH or ident in self._active:
            return
        self._active.add(ident)
        try:
            inner_res = xo.get("/Resources")
            child_gs = gs.copy()
            child_gs.ctm = inner_ctm
            child_gs.clip = clip
            child_gs.pend_clip = False
            nodes = _parse(xo, ins.key)
            self.run(
                nodes,
                inner_res if inner_res is not None else res,
                child_gs,
                depth + 1,
                page_level=False,
                parent_key=ins.key,
            )
        finally:
            self._active.discard(ident)

    def _inline_image(
        self,
        i: int,
        ins: Ins,
        gs: GState,
        marks: list[Ins],
        page_level: bool,
        parent_key: Key | None,
    ) -> None:
        inl = ins.operands[0] if ins.operands else None
        obj = self._base(
            ins.key, i, "image", self._unit_box(gs.ctm), gs, marks, page_level, parent_key
        )
        obj.inline = True
        obj.quad = tuple(apply(gs.ctm, x, y) for x, y in ((0, 0), (1, 0), (1, 1), (0, 1)))
        if inl is not None:
            obj.pixel_size = (int(inl.width), int(inl.height))
        if gs.clip is not None:
            obj.bbox = intersect(gs.clip, obj.bbox)
        self.objects.append(obj)


# -- building a model -------------------------------------------------------------------------


def _map_name(
    kind: str,
    name: str,
    fres: Any,
    res: Any,
    cache: dict[tuple[str, str], Name],
    counter: list[int],
) -> Name:
    key = (kind, name)
    if key in cache:
        return cache[key]
    table = fres.get("/" + kind) if isinstance(fres, Dictionary) else None
    if not isinstance(table, Dictionary) or name not in table:
        return Name(name)
    new = Name(f"/ChefI{counter[0]}")
    counter[0] += 1
    category(res, "/" + kind)[new] = table[name]
    cache[key] = new
    return new


def _renamed(
    ins: Ins, fres: Any, res: Any, cache: dict[tuple[str, str], Name], counter: list[int]
) -> Ins:
    ops = list(ins.operands)
    op = ins.op
    if op in NAMED_OPS and ops and isinstance(ops[0], Name):
        ops[0] = _map_name(NAMED_OPS[op], str(ops[0]), fres, res, cache, counter)
    elif op in ("scn", "SCN") and ops and isinstance(ops[-1], Name):
        ops[-1] = _map_name("Pattern", str(ops[-1]), fres, res, cache, counter)
    elif op in ("BDC", "DP") and len(ops) > 1 and isinstance(ops[1], Name):
        ops[1] = _map_name("Properties", str(ops[1]), fres, res, cache, counter)
    return Ins(ops, op, ins.key)


def _inline_forms(
    nodes: list[Ins],
    fres: Any,
    res: Any,
    chain_depth: int,
    counter: list[int],
    inlined: set[str],
    out: list[Ins],
    *,
    top: bool,
) -> None:
    """Expand the Do of every form XObject into its operators (ActualText spans dropped)."""
    cache: dict[tuple[str, str], Name] = {}
    drops: list[bool] = []
    for ins in nodes:
        op, ops, key = ins.op, ins.operands, ins.key
        if op in ("BDC", "BMC"):
            drop = (
                op == "BDC"
                and len(ops) > 1
                and isinstance(ops[1], Dictionary)
                and "/ActualText" in ops[1]
            )
            drops.append(drop)
            if drop:
                continue
        elif op == "EMC":
            if drops and drops.pop():
                continue
        if op == "Do" and ops:
            name = str(ops[0])
            xo = _lookup(fres, "XObject", name)
            if (
                isinstance(xo, pikepdf.Stream)
                and str(xo.get("/Subtype", "")) == "/Form"
                and chain_depth < MAX_DEPTH
            ):
                if top:
                    inlined.add(name)
                matrix = as_matrix(xo.get("/Matrix")) or IDENTITY
                bx = [_float(v) for v in xo.get("/BBox", [0, 0, 0, 0])]
                out.append(Ins([], "q", (*key, -1)))
                out.append(Ins([*matrix], "cm", (*key, -2)))
                out.append(Ins([bx[0], bx[1], bx[2] - bx[0], bx[3] - bx[1]], "re", (*key, -3)))
                out.append(Ins([], "W", (*key, -4)))
                out.append(Ins([], "n", (*key, -5)))
                form_res = xo.get("/Resources")
                inner_res = form_res if form_res is not None else fres
                inner = _parse(xo, key)
                _inline_forms(
                    inner, inner_res, res, chain_depth + 1, counter, inlined, out, top=False
                )
                out.append(Ins([], "Q", (*key, -6)))
                continue
        out.append(_renamed(ins, fres, res, cache, counter) if not top else ins)


def build_model(
    pdf: pikepdf.Pdf, page: pikepdf.Page, page_index: int, *, flatten: bool = False
) -> PageModel:
    """The objects of one page. With ``flatten`` the forms are inlined into the page first
    (this changes the page's resources; the result is then only meant for editing)."""
    digest = _digest(page)
    frame = page_frame(page)
    box: Rect = (frame.x0, frame.y0, frame.x1, frame.y1)
    inlined: set[str] = set()
    if flatten:
        res: Any = own_resources(page)
        raw = _parse(page, ())
        nodes: list[Ins] = []
        _inline_forms(raw, res, res, 0, [0], inlined, nodes, top=True)
    else:
        res = inherited(page.obj, "/Resources")
        if res is None:
            res = Dictionary()
        nodes = _parse(page, ())
    walker = _Walker(box, res)
    walker.run(nodes, res, GState(), 0, page_level=True)
    objects = walker.objects
    by_key: dict[Key, PageObject] = {}
    by_id: dict[str, PageObject] = {}
    for ordinal, obj in enumerate(objects):
        obj.ordinal = ordinal
        obj.id = make_id(page_index, digest, ordinal)
        by_key.setdefault(obj.key, obj)
        by_id[obj.id] = obj
    for obj in objects:
        if obj.parent_key is not None and obj.parent_key in by_key:
            obj.parent_id = by_key[obj.parent_key].id
    return PageModel(
        page_index=page_index,
        digest=digest,
        nodes=nodes,
        objects=objects,
        frame=frame,
        clean_at=walker.clean_at,
        ctm_at=walker.ctm_at,
        res=res,
        res_owned=flatten,
        flattened=flatten,
        inlined=inlined,
        by_id=by_id,
        by_key=by_key,
    )


# -- hit tests and queries (user space) -------------------------------------------------------


def _point_in_polygon(pts: list[tuple[float, float]], x: float, y: float) -> bool:
    inside = False
    n = len(pts)
    if n < 3:
        return False
    j = n - 1
    for i in range(n):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def _near_segments(
    polylines: list[list[tuple[float, float]]], x: float, y: float, tol: float
) -> bool:
    for line in polylines:
        for (ax, ay), (bx, by) in pairwise(line):
            dx, dy = bx - ax, by - ay
            seg = dx * dx + dy * dy
            t = 0.0 if seg == 0 else max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / seg))
            if math.hypot(x - (ax + t * dx), y - (ay + t * dy)) <= tol:
                return True
    return False


def _hits(obj: PageObject, x: float, y: float) -> bool:
    if obj.kind == "path":
        if obj.fill:
            # even-odd over all sub-paths (each closed by the fill)
            parity = 0
            for line in obj.polylines:
                if _point_in_polygon(line, x, y):
                    parity ^= 1
            if parity:
                return True
        if obj.stroke:
            return _near_segments(obj.polylines, x, y, max(obj.stroke_width / 2, 2.0))
        return False
    if obj.quad:
        return _point_in_polygon(list(obj.quad), x, y)
    x0, y0, x1, y1 = obj.bbox
    return x0 <= x <= x1 and y0 <= y <= y1


def objects_at_point(
    objects: list[PageObject], x: float, y: float, *, include_forms: bool = True
) -> list[PageObject]:
    """Objects under the point (user space), topmost first.

    With ``include_forms`` the objects a form draws are tested and the form itself is not;
    without it the forms are leaves and their children are ignored."""
    hits: list[PageObject] = []
    for obj in objects:
        if include_forms:
            if obj.kind == "form":
                continue
        elif obj.parent_id is not None:
            continue
        if _hits(obj, x, y):
            hits.append(obj)
    hits.reverse()
    return hits


def objects_in_rect(
    objects: list[PageObject], rect: Rect, mode: Mode = "intersect", *, include_forms: bool = True
) -> list[PageObject]:
    """Objects whose box meets (``intersect``) or lies inside (``contain``) the rectangle."""
    rx0, ry0, rx1, ry1 = rect
    out: list[PageObject] = []
    for obj in objects:
        if include_forms and obj.kind == "form":
            continue
        if not include_forms and obj.parent_id is not None:
            continue
        x0, y0, x1, y1 = obj.bbox
        if mode == "contain":
            ok = rx0 <= x0 and ry0 <= y0 and x1 <= rx1 and y1 <= ry1
        else:
            ok = x0 <= rx1 and x1 >= rx0 and y0 <= ry1 and y1 >= ry0
        if ok:
            out.append(obj)
    return out


def page_digest(page: pikepdf.Page) -> str:
    return _digest(page)


__all__ = [
    "GState",
    "build_model",
    "inverse",
    "objects_at_point",
    "objects_in_rect",
    "page_digest",
]
