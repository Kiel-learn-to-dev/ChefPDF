"""Signature fields of a PDF (T3.07): listing, the certification level and where a field sits.

Everything here reads the file (pikepdf, read only) so the answers do not depend on what the
engine remembers. The certification level is the ``/DocMDP`` permission of the first signature
that carries one (the certifying signature).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pikepdf
from pyhanko.sign.fields import MDPPerm

Rect = tuple[float, float, float, float]


@dataclass(frozen=True)
class SignatureFieldInfo:
    name: str  # fully qualified field name
    page: int | None  # 0-based, None if the widget is not on any page
    rect: Rect | None  # None when the field has no widget
    signed: bool


def _objgen(obj: Any) -> tuple[int, int] | None:
    """Object number and generation of an indirect object, None for a direct one."""
    objgen = getattr(obj, "objgen", None)
    return (int(objgen[0]), int(objgen[1])) if objgen and objgen[0] else None


def _signature_nodes(pdf: pikepdf.Pdf) -> list[tuple[str, pikepdf.Dictionary]]:
    """Terminal signature fields (name, field dictionary), in field-tree order."""
    if "/AcroForm" not in pdf.Root or "/Fields" not in pdf.Root.AcroForm:
        return []
    found: list[tuple[str, pikepdf.Dictionary]] = []

    def walk(nodes: Any, prefix: str, inherited_type: str | None) -> None:
        for node in nodes:
            if not isinstance(node, pikepdf.Dictionary):
                continue
            own = str(node["/T"]) if "/T" in node else None
            name = f"{prefix}.{own}" if prefix and own else (own or prefix)
            field_type = str(node["/FT"]) if "/FT" in node else inherited_type
            if "/Kids" in node:
                walk(node["/Kids"], name, field_type)
            elif own is not None and field_type == "/Sig":
                found.append((name, node))

    walk(pdf.Root.AcroForm.Fields, "", None)
    return found


def _page_of(pdf: pikepdf.Pdf, node: pikepdf.Dictionary) -> int | None:
    index_of = {page.obj.objgen: i for i, page in enumerate(pdf.pages)}
    parent = node.get("/P")
    if parent is not None and _objgen(parent) in index_of:
        return index_of[_objgen(parent)]  # type: ignore[index]
    target = _objgen(node)
    for i, page in enumerate(pdf.pages):
        for annot in page.obj.get("/Annots", []):
            if target is not None and _objgen(annot) == target:
                return i
    return None


def _rect_of(node: pikepdf.Dictionary) -> Rect | None:
    if "/Rect" not in node:
        return None
    values = [float(v) for v in node["/Rect"]]
    if len(values) != 4:
        return None
    x1, y1, x2, y2 = values
    return (min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2))


def list_signature_fields(pdf: pikepdf.Pdf) -> list[SignatureFieldInfo]:
    """Every signature field with its page, rectangle and whether it is signed."""
    infos: list[SignatureFieldInfo] = []
    for name, node in _signature_nodes(pdf):
        infos.append(
            SignatureFieldInfo(
                name=name,
                page=_page_of(pdf, node),
                rect=_rect_of(node),
                signed="/V" in node and node["/V"] is not None,
            )
        )
    return infos


def certification_level(pdf: pikepdf.Pdf) -> MDPPerm | None:
    """The DocMDP permission of the certifying signature, or None if the file is not certified."""
    for _, node in _signature_nodes(pdf):
        value = node.get("/V")
        if value is None:
            continue
        for reference in value.get("/Reference", []):
            if str(reference.get("/TransformMethod")) != "/DocMDP":
                continue
            params = reference.get("/TransformParams")
            permission = int(params.get("/P", 2)) if params is not None else 2
            return MDPPerm(permission)
    return None
