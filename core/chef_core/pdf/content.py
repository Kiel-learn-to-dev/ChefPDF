"""Reading page content: where images are placed, which resources are used, nested forms.

Used by the compression, colour and page-edit operations. The walk follows the graphics state
(``q``/``Q``/``cm``) and descends into form XObjects, tiling patterns and soft-mask groups, so
that the answers are *supersets*: a resource that might be used is always reported as used.
Anything the walk cannot parse marks the page as not fully known (``complete = False``).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

import pikepdf
from pikepdf import Name

Matrix = tuple[float, float, float, float, float, float]
IDENTITY: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
MAX_DEPTH = 16


def mul(first: Matrix, second: Matrix) -> Matrix:
    """Matrix product in PDF's row-vector convention: apply ``first``, then ``second``."""
    a1, b1, c1, d1, e1, f1 = first
    a2, b2, c2, d2, e2, f2 = second
    return (
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    )


def as_matrix(obj: Any) -> Matrix | None:
    try:
        values = tuple(float(v) for v in obj)
    except (TypeError, ValueError, pikepdf.PdfError):
        return None
    if len(values) != 6:
        return None
    return (values[0], values[1], values[2], values[3], values[4], values[5])


@dataclass
class Placement:
    """Smallest placed size (points) of an image: the binding one for resolution limits."""

    image: pikepdf.Object
    width: float
    height: float


@dataclass
class PageWalk:
    images: dict[tuple[int, int], Placement] = field(default_factory=dict)
    xobject_names: set[str] = field(default_factory=set)  # names used by Do (with slash)
    font_names: set[str] = field(default_factory=set)  # names used by Tf (with slash)
    complete: bool = True
    image_refs: set[tuple[int, int]] = field(default_factory=set)  # every image object seen


def _objgen(obj: Any) -> tuple[int, int] | None:
    return obj.objgen if isinstance(obj, pikepdf.Object) and obj.is_indirect else None


def _resource(resources: Any, kind: str, name: str | None = None) -> Any:
    if not isinstance(resources, pikepdf.Dictionary):
        return None
    table = resources.get("/" + kind)
    if not isinstance(table, pikepdf.Dictionary):
        return None
    if name is None:
        return table
    return table.get(name)


class _Walker:
    def __init__(self) -> None:
        self.result = PageWalk()
        self._seen: set[tuple[Any, ...]] = set()

    def run_stream(self, stream: pikepdf.Object, resources: Any, ctm: Matrix, depth: int) -> None:
        if depth > MAX_DEPTH:
            self.result.complete = False
            return
        try:
            instructions = pikepdf.parse_content_stream(stream)
        except (pikepdf.PdfError, RuntimeError, ValueError, TypeError):
            self.result.complete = False
            return
        stack: list[Matrix] = []
        for instruction in instructions:
            operands, operator = instruction.operands, instruction.operator
            op = str(operator)
            if op == "q":
                stack.append(ctm)
            elif op == "Q":
                ctm = stack.pop() if stack else IDENTITY
            elif op == "cm" and len(operands) == 6:
                cm = as_matrix(operands)
                if cm is not None:
                    ctm = mul(cm, ctm)
            elif op == "Tf" and operands:
                self.result.font_names.add(str(operands[0]))
            elif op == "Do" and operands:
                self._do(str(operands[0]), resources, ctm, depth)

    def _do(self, name: str, resources: Any, ctm: Matrix, depth: int) -> None:
        self.result.xobject_names.add(name)
        xobj = _resource(resources, "XObject", name)
        if not isinstance(xobj, pikepdf.Stream):
            return
        subtype = xobj.get("/Subtype")
        if subtype == Name.Image:
            self._image(xobj, ctm)
        elif subtype == Name.Form:
            key = (_objgen(xobj), tuple(round(v, 4) for v in ctm), depth)
            if key in self._seen:
                return
            self._seen.add(key)
            form_matrix = as_matrix(xobj.get("/Matrix")) or IDENTITY
            inner = xobj.get("/Resources")
            self.run_stream(
                xobj, inner if inner is not None else resources, mul(form_matrix, ctm), depth + 1
            )

    def _image(self, image: pikepdf.Object, ctm: Matrix) -> None:
        gen = _objgen(image)
        if gen is not None:
            self.result.image_refs.add(gen)
        width = math.hypot(ctm[0], ctm[1])
        height = math.hypot(ctm[2], ctm[3])
        if gen is None:
            return
        old = self.result.images.get(gen)
        if old is None or width * height < old.width * old.height:
            self.result.images[gen] = Placement(image, width, height)

    def walk_patterns_and_groups(self, resources: Any, depth: int) -> None:
        """Tiling patterns and soft-mask groups have content of their own."""
        patterns = _resource(resources, "Pattern")
        if isinstance(patterns, pikepdf.Dictionary):
            for pat in patterns.values():
                if isinstance(pat, pikepdf.Stream) and pat.get("/PatternType") == 1:
                    matrix = as_matrix(pat.get("/Matrix")) or IDENTITY
                    inner = pat.get("/Resources")
                    self.run_stream(
                        pat, inner if inner is not None else resources, matrix, depth + 1
                    )
        states = _resource(resources, "ExtGState")
        if isinstance(states, pikepdf.Dictionary):
            for state in states.values():
                if not isinstance(state, pikepdf.Dictionary):
                    continue
                smask = state.get("/SMask")
                group = smask.get("/G") if isinstance(smask, pikepdf.Dictionary) else None
                if isinstance(group, pikepdf.Stream):
                    inner = group.get("/Resources")
                    self.run_stream(
                        group, inner if inner is not None else resources, IDENTITY, depth + 1
                    )


def walk_page(page: pikepdf.Page) -> PageWalk:
    """Everything the page's content (and nested forms, patterns, soft masks) uses."""
    walker = _Walker()
    resources = page.obj.get("/Resources")
    if resources is None:
        resources = pikepdf.Dictionary()
    try:
        walker.run_stream(page.obj, resources, IDENTITY, 0)
        walker.walk_patterns_and_groups(resources, 0)
    except (pikepdf.PdfError, RuntimeError, ValueError, TypeError, IndexError, KeyError):
        walker.result.complete = False
    return walker.result


def page_xobject_images(page: pikepdf.Page) -> list[pikepdf.Object]:
    """Image XObjects listed in the page's own resources (placed or not)."""
    table = _resource(page.obj.get("/Resources"), "XObject")
    if not isinstance(table, pikepdf.Dictionary):
        return []
    images: list[pikepdf.Object] = []
    for value in table.values():
        if isinstance(value, pikepdf.Stream) and value.get("/Subtype") == Name.Image:
            images.append(value)
    return images
