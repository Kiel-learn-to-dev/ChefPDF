"""Editing the paint objects of a page (T6.01).

The editor never edits bytes. It keeps the page's instruction list (``PageModel.nodes``) and
records a plan: instructions to replace at a node index, and instructions to insert before a
node index (index n means the end). ``render()`` assembles the new list and ``write()`` stores
it as the page's single content stream. Everything the plan does not touch is kept as it was.

How each edit keeps the rest of the page intact:

- ``delete``: a text run becomes an advance-only ``TJ`` (the following text keeps its place).
  A clipped path keeps its ``W``/``W*`` and paints with ``n`` so that later objects keep the
  clip. Other objects are removed.
- ``transform`` / ``move``: a path has its points rewritten (its clip moves with it); every other
  object is wrapped in ``q <cm> ... Q``. The matrix is given in page space and converted to the
  object's own space with its CTM, so it is right inside ``cm`` groups too.
- ``set_color`` / ``set_opacity``: the new colour or ExtGState is set before the object and the
  old one restored after it, so later objects keep their state.
- ``reorder``: the object is moved as a self-contained block (own ``q``, CTM, colours, alpha,
  marked content and, for text, its own ``BT``/``ET``) to a position where the graphics state
  is neutral (outside every q level, clip, text object and marked-content block).
- ``duplicate``: a copy goes right after the object, moved by the offset. A text copy first
  rewinds the text matrix so that the text after it does not move.
"""

from __future__ import annotations

from collections.abc import Iterable
from itertools import pairwise
from typing import Any

import pikepdf
from pikepdf import Array, Dictionary, Name

from chef_core.content.engine import apply, build_model, inverse
from chef_core.content.model import Ins, Key, Matrix, PageModel, PageObject, parse_id
from chef_core.errors import invalid_params
from chef_core.overlay.pagecontent import category, own_resources
from chef_core.pdf.content import IDENTITY, mul

Colour = tuple[str, str | None, tuple[float, ...]]


def translate(dx: float, dy: float) -> Matrix:
    return (1.0, 0.0, 0.0, 1.0, dx, dy)


def local_matrix(page_matrix: Matrix, ctm: Matrix) -> Matrix:
    """The matrix to write inside an object's own space so that it acts as ``page_matrix``
    does in page space: ctm, then the page matrix, then the inverse of ctm."""
    return mul(mul(ctm, page_matrix), inverse(ctm))


def _is_identity(m: Matrix) -> bool:
    return all(abs(a - b) < 1e-12 for a, b in zip(m, IDENTITY, strict=True))


def colour_ins(stroke: bool, state: Colour, key: Key) -> list[Ins]:
    """Instructions that set a colour state (device colours or a named space)."""
    op, space, comps = state
    if op in ("g", "rg", "k"):
        name = {"g": "G", "rg": "RG", "k": "K"}[op] if stroke else op
        return [Ins([*comps], name, key)]
    if op == "scn" and space is not None:
        return [
            Ins([Name(space)], "CS" if stroke else "cs", key),
            Ins([*comps], "SCN" if stroke else "scn", key),
        ]
    return []


def hex_colour(value: str) -> Colour:
    text = value.lstrip("#")
    r, g, b = (int(text[i : i + 2], 16) / 255 for i in (0, 2, 4))
    return ("rg", None, (r, g, b))


def _numbers(ins: Ins) -> list[float]:
    return [float(v) for v in ins.operands]


def _is_translation(m: Matrix) -> bool:
    return abs(m[0] - 1) < 1e-9 and abs(m[1]) < 1e-9 and abs(m[2]) < 1e-9 and abs(m[3] - 1) < 1e-9


def _to_text_space(tm: Matrix, ex: float, ey: float) -> tuple[float, float]:
    """A translation (ex, ey) in the space after the text matrix, as text space units."""
    inv = inverse((tm[0], tm[1], tm[2], tm[3], 0.0, 0.0))
    return apply(inv, ex, ey)


def transform_node(ins: Ins, m: Matrix) -> list[Ins]:
    """A path construction operator with its points moved by ``m`` (object space)."""
    op, key = ins.op, ins.key
    if op in ("m", "l"):
        x, y = apply(m, *_numbers(ins)[:2])
        return [Ins([x, y], op, key)]
    if op in ("c", "v", "y"):
        nums = _numbers(ins)
        pts: list[float] = []
        for k in range(0, len(nums), 2):
            pts.extend(apply(m, nums[k], nums[k + 1]))
        return [Ins(pts, op, key)]
    if op == "re":
        x, y, w, h = _numbers(ins)
        corners = [apply(m, x, y), apply(m, x + w, y), apply(m, x + w, y + h), apply(m, x, y + h)]
        out = [Ins(list(corners[0]), "m", key)]
        out += [Ins(list(c), "l", key) for c in corners[1:]]
        out.append(Ins([], "h", key))
        return out
    return [Ins(list(ins.operands), op, key)]


class PageEditor:
    """Plans and writes the edits of one page. The model must be the one the ids refer to."""

    def __init__(self, pdf: pikepdf.Pdf, page: pikepdf.Page, model: PageModel) -> None:
        self.pdf = pdf
        self.page = page
        self.model = model
        self.n = len(model.nodes)
        self.replace: dict[int, list[Ins]] = {}
        self.ins_at: dict[int, list[Ins]] = {}
        self.skipped: list[str] = []  # object kinds an edit did not apply to
        # XObject names that may become unused after the edit (removed from the page's resources)
        self.drop_candidates: set[str] = set()

    # -- resources ----------------------------------------------------------------------

    @property
    def res(self) -> Any:
        if not self.model.res_owned:
            self.model.res = own_resources(self.page)
            self.model.res_owned = True
        return self.model.res

    def _alpha_name(self, fa: float, sa: float) -> Name:
        name = Name(f"/ChefGS{round(fa * 1000)}_{round(sa * 1000)}")
        states = category(self.res, "/ExtGState")
        if name not in states:
            states[name] = Dictionary(Type=Name.ExtGState, ca=fa, CA=sa)
        return name

    # -- planning helpers ---------------------------------------------------------------

    def _check_disjoint(self, objs: list[PageObject]) -> list[PageObject]:
        ordered = sorted(objs, key=lambda o: o.start)
        for prev, cur in pairwise(ordered):
            if cur.start <= prev.end:
                raise invalid_params("OVERLAPPING_OBJECTS", {"ids": [prev.id, cur.id]})
        return ordered

    def _add(self, table: dict[int, list[Ins]], pos: int, items: list[Ins]) -> None:
        table.setdefault(pos, []).extend(items)

    def _shift(self, obj: PageObject, amount: float) -> list[Ins]:
        """A TJ that moves the text position by ``amount`` (text space, already scaled by Th)."""
        scale = obj.font_size * obj.th
        if abs(amount) < 1e-9 or abs(scale) < 1e-12:
            return []
        return [Ins([Array([-amount * 1000 / scale])], "TJ", obj.key)]

    def _rise(self, obj: PageObject, rise: float) -> list[Ins]:
        """Set the text rise (Ts): moves glyphs vertically in text space, leaves Tm alone."""
        return [Ins([rise], "Ts", obj.key)]

    def _text_moved(self, obj: PageObject, local: Matrix, key: Key) -> list[Ins]:
        """A text run moved by a translation: shifted with TJ and Ts, Tm and Tlm are kept."""
        ex, ey = local[4], local[5]
        vx, vy = _to_text_space(obj.tm, ex, ey)
        out = self._shift(obj, vx)
        if abs(vy) > 1e-9:
            out += self._rise(obj, obj.ts + vy)
        show = self.model.nodes[obj.start]
        out.append(Ins(list(show.operands), show.op, key))
        if abs(vy) > 1e-9:
            out += self._rise(obj, obj.ts)
        out += self._shift(obj, -vx)
        return out

    def _text_wrap_ok(self, obj: PageObject) -> None:
        """q/cm/Q around a text run is only safe when no text follows it in the same BT block:
        PDFium restores the text matrix at Q, the specification does not."""
        nodes = self.model.nodes
        for i in range(obj.end + 1, self.n):
            op = nodes[i].op
            if op == "ET":
                return
            if op in ("Tj", "TJ", "'", '"', "Td", "TD", "Tm", "T*", "BT"):
                raise invalid_params("TEXT_TRANSFORM_UNSUPPORTED", {"id": obj.id})
        raise invalid_params("TEXT_TRANSFORM_UNSUPPORTED", {"id": obj.id})

    def _remove(self, obj: PageObject) -> None:
        nodes = self.model.nodes
        if obj.kind == "text":
            self.replace[obj.start] = self._shift(obj, obj.advance)
        elif obj.kind == "path" and obj.clipped:
            for i in range(obj.start, obj.end):
                if nodes[i].op not in ("W", "W*"):
                    self.replace[i] = []
            self.replace[obj.end] = [Ins([], "n", obj.key)]
        else:
            for i in range(obj.start, obj.end + 1):
                self.replace[i] = []

    def _block(self, obj: PageObject, pos: int) -> list[Ins]:
        """A self-contained copy of the object for position ``pos`` (see module doc)."""
        nodes = self.model.nodes
        key = obj.key
        rel = mul(obj.ctm, inverse(self.model.ctm_at[pos]))
        out: list[Ins] = [Ins(list(m.operands), m.op, key) for m in obj.mark_ins]
        out.append(Ins([], "q", key))
        if not _is_identity(rel):
            out.append(Ins(list(rel), "cm", key))
        if obj.lw != 1.0:
            out.append(Ins([obj.lw], "w", key))
        if obj.dash is not None:
            out.append(Ins([obj.dash[0], obj.dash[1]], "d", key))
        if (obj.fa, obj.sa) != (1.0, 1.0):
            out.append(Ins([self._alpha_name(obj.fa, obj.sa)], "gs", key))
        out += colour_ins(False, obj.fill_op, key) + colour_ins(True, obj.stroke_op, key)
        if obj.kind == "text":
            out.append(Ins([], "BT", key))
            if obj.font is not None:
                out.append(Ins([Name(obj.font), obj.font_size], "Tf", key))
            out.append(Ins(list(obj.tm), "Tm", key))
            out.append(Ins([obj.tc], "Tc", key))
            out.append(Ins([obj.tw], "Tw", key))
            out.append(Ins([obj.th * 100], "Tz", key))
            out.append(Ins([obj.tl], "TL", key))
            out.append(Ins([obj.ts], "Ts", key))
            out.append(Ins([obj.tr], "Tr", key))
            out.append(Ins(list(nodes[obj.start].operands), nodes[obj.start].op, key))
            out.append(Ins([], "ET", key))
        else:
            out += [
                Ins(list(nodes[i].operands), nodes[i].op, nodes[i].key)
                for i in range(obj.start, obj.end + 1)
            ]
        out.append(Ins([], "Q", key))
        out += [Ins([], "EMC", key) for _ in obj.mark_ins]
        return out

    # -- edits --------------------------------------------------------------------------

    def delete(self, objs: Iterable[PageObject]) -> None:
        for obj in self._check_disjoint(list(objs)):
            self._remove(obj)

    def transform(self, objs: Iterable[PageObject], m: Matrix) -> None:
        nodes = self.model.nodes
        for obj in self._check_disjoint(list(objs)):
            local = local_matrix(m, obj.ctm)
            if obj.kind == "text":
                if _is_translation(local):
                    self.replace[obj.start] = self._text_moved(obj, local, obj.key)
                else:
                    self._text_wrap_ok(obj)
                    self.replace[obj.start] = [
                        Ins([], "q", obj.key),
                        Ins(list(local), "cm", obj.key),
                        Ins(list(nodes[obj.start].operands), nodes[obj.start].op, obj.key),
                        Ins([], "Q", obj.key),
                    ]
            elif obj.kind == "path":
                for i in range(obj.start, obj.end + 1):
                    self.replace[i] = transform_node(nodes[i], local)
            else:
                self._add(
                    self.ins_at, obj.start, [Ins([], "q", obj.key), Ins(list(local), "cm", obj.key)]
                )
                self._add(self.ins_at, obj.end + 1, [Ins([], "Q", obj.key)])

    def set_color(
        self, objs: Iterable[PageObject], fill: Colour | None, stroke: Colour | None
    ) -> None:
        for obj in self._check_disjoint(list(objs)):
            if obj.kind not in ("text", "path") or (
                (fill is not None and obj.fill_op[0] == "pattern")
                or (stroke is not None and obj.stroke_op[0] == "pattern")
            ):
                # a pattern colour cannot be restored after the object: leave it alone
                self.skipped.append(obj.id)
                continue
            pre: list[Ins] = []
            post: list[Ins] = []
            if fill is not None:
                pre += colour_ins(False, fill, obj.key)
                post += colour_ins(False, obj.fill_op, obj.key)
            if stroke is not None:
                pre += colour_ins(True, stroke, obj.key)
                post += colour_ins(True, obj.stroke_op, obj.key)
            self._add(self.ins_at, obj.start, pre)
            self._add(self.ins_at, obj.end + 1, post)

    def set_opacity(self, objs: Iterable[PageObject], opacity: float) -> None:
        new_name = self._alpha_name(opacity, opacity)
        for obj in self._check_disjoint(list(objs)):
            old_name = self._alpha_name(obj.fa, obj.sa)
            self._add(self.ins_at, obj.start, [Ins([new_name], "gs", obj.key)])
            self._add(self.ins_at, obj.end + 1, [Ins([old_name], "gs", obj.key)])

    def move(self, objs: Iterable[PageObject], dx: float, dy: float) -> None:
        """Move objects by (dx, dy) in page user space."""
        self.transform(objs, translate(dx, dy))

    def duplicate(self, objs: Iterable[PageObject], dx: float, dy: float) -> None:
        """Copy objects, the copies displaced by (dx, dy) in page user space."""
        m = translate(dx, dy)
        nodes = self.model.nodes
        for obj in self._check_disjoint(list(objs)):
            local = local_matrix(m, obj.ctm)
            copies: list[Ins] = []
            if obj.kind == "text":
                # back to the start of the run, then the copy (moved), then back to where the
                # original run ended, so that the text after it does not move
                if _is_translation(local):
                    vx, vy = _to_text_space(obj.tm, local[4], local[5])
                    copies += self._shift(obj, -obj.advance + vx)
                    copies += self._rise(obj, obj.ts + vy)
                    copies.append(
                        Ins(list(nodes[obj.start].operands), nodes[obj.start].op, obj.key)
                    )
                    copies += self._rise(obj, obj.ts)
                    copies += self._shift(obj, -vx)
                else:
                    self._text_wrap_ok(obj)
                    copies += [
                        Ins([], "q", obj.key),
                        Ins(list(local), "cm", obj.key),
                        Ins(list(nodes[obj.start].operands), nodes[obj.start].op, obj.key),
                        Ins([], "Q", obj.key),
                    ]
            else:
                body: list[Ins] = []
                for i in range(obj.start, obj.end + 1):
                    body += (
                        transform_node(nodes[i], local)
                        if obj.kind == "path"
                        else [Ins(list(nodes[i].operands), nodes[i].op, nodes[i].key)]
                    )
                copies += [Ins([], "q", obj.key)]
                if obj.kind != "path":
                    copies.append(Ins(list(local), "cm", obj.key))
                copies += [*body, Ins([], "Q", obj.key)]
            self._add(self.ins_at, obj.end + 1, copies)

    def replace_object(self, obj: PageObject, new: list[Ins]) -> None:
        """Replace the instructions of one object (an image placement) by ``new``."""
        self.replace[obj.start] = new
        for i in range(obj.start + 1, obj.end + 1):
            self.replace[i] = []

    def reorder(self, objs: Iterable[PageObject], mode: str) -> None:
        targets = self._check_disjoint(list(objs))
        for obj in targets:
            if obj.clipped:
                raise invalid_params("CLIPPED_OBJECT_REORDER", {"id": obj.id})
            if obj.fill_op[0] == "pattern" or obj.stroke_op[0] == "pattern":
                raise invalid_params("PATTERN_OBJECT_REORDER", {"id": obj.id})
        target_ids = {id(o) for o in targets}
        clean = [p for p in range(self.n + 1) if self.model.clean_at[p]]
        for obj in targets:
            others = [o for o in self.model.objects if o.in_page and id(o) not in target_ids]
            if mode == "front":
                pos = clean[-1]
            elif mode == "back":
                pos = clean[0]
            elif mode == "forward":
                after = [o for o in others if o.start > obj.end]
                nxt = min(after, key=lambda o: o.start, default=None)
                pos = next((c for c in clean if nxt is not None and c >= nxt.end + 1), clean[-1])
            elif mode == "backward":
                before = [o for o in others if o.end < obj.start]
                prv = max(before, key=lambda o: o.end, default=None)
                pos = max(
                    (c for c in clean if prv is not None and c <= prv.start), default=clean[0]
                )
            else:
                raise invalid_params("INVALID_REORDER_MODE", {"mode": mode})
            block = self._block(obj, pos)
            self._remove(obj)
            self._add(self.ins_at, pos, block)

    # -- output -------------------------------------------------------------------------

    def render(self) -> list[Ins]:
        out: list[Ins] = []
        nodes = self.model.nodes
        for i in range(self.n + 1):
            out += self.ins_at.get(i, [])
            if i < self.n:
                out += self.replace[i] if i in self.replace else [nodes[i]]
        return out

    def changed(self) -> bool:
        return bool(self.replace or self.ins_at)

    def write(self) -> None:
        out = self.render()
        data = pikepdf.unparse_content_stream(
            [(list(x.operands), pikepdf.Operator(x.op)) for x in out]
        )
        self.page.obj.Contents = self.pdf.make_stream(data)
        candidates = self.model.inlined | self.drop_candidates
        if candidates:
            used = {str(x.operands[0]) for x in out if x.op == "Do" and x.operands}
            table = self.res.get("/XObject")
            if isinstance(table, Dictionary):
                for name in candidates:
                    if name not in used and Name(name) in table:
                        del table[Name(name)]


def prepare(
    pdf: pikepdf.Pdf,
    page: pikepdf.Page,
    page_index: int,
    ids: list[str],
    *,
    flatten_forms: bool,
) -> tuple[PageEditor, list[PageObject]]:
    """The editor for one page and the objects named by ``ids`` (ids of this page's revision).

    Ids from another revision are refused as stale. An object inside a form needs
    ``flatten_forms``; the page is then inlined and the object is looked up again by its origin.
    """
    base = build_model(pdf, page, page_index)
    targets: list[PageObject] = []
    for ident in ids:
        parsed = parse_id(ident)
        if parsed is None or parsed[0] != page_index or parsed[1] != base.digest:
            raise invalid_params("STALE_OBJECT_IDS", {"ids": [ident]})
        obj = base.by_id.get(ident)
        if obj is None:
            raise invalid_params("OBJECT_NOT_FOUND", {"id": ident})
        targets.append(obj)
    if all(o.in_page for o in targets):
        return PageEditor(pdf, page, base), targets
    if not flatten_forms:
        raise invalid_params("FORM_CHILD_NEEDS_FLATTEN", {"ids": ids})
    if any(o.kind == "form" for o in targets):
        raise invalid_params("FORM_NOT_EDITABLE_WHEN_FLATTENED", {"ids": ids})
    model = build_model(pdf, page, page_index, flatten=True)
    flat: list[PageObject] = []
    for o in targets:
        found = model.by_key.get(o.key)
        if found is None:
            raise invalid_params("OBJECT_NOT_FOUND", {"id": o.id})
        flat.append(found)
    return PageEditor(pdf, page, model), flat


__all__ = [
    "PageEditor",
    "colour_ins",
    "hex_colour",
    "local_matrix",
    "prepare",
    "transform_node",
    "translate",
]
