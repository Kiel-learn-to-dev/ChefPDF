"""Flattening (H3): burn the widget appearances into the page content and remove the fields.

Each widget's normal appearance (the state given by /AS) becomes a Form XObject that is drawn on
the page at the widget rectangle. The matrix follows PDF 12.5.5 (Rect from the transformed BBox
of the form): the form's /BBox under its /Matrix is mapped onto /Rect, and the result is drawn
inside the page content with the page's own graphics state kept intact.

Signature fields are kept by default (their widgets stay, so earlier signatures still validate).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pikepdf
from pikepdf import Array, Dictionary

from chef_core.forms.edit import _remove_annot, _remove_node, _same, refresh
from chef_core.forms.model import FormDoc
from chef_core.overlay.geometry import number
from chef_core.overlay.pagecontent import category, content_bytes, own_resources, set_content

FLAT_PREFIX = "ChefFlat"


@dataclass
class FlattenResult:
    pages: set[int] = field(default_factory=set)
    flattened: list[str] = field(default_factory=list)
    kept: list[str] = field(default_factory=list)
    skipped_without_appearance: list[str] = field(default_factory=list)


def form_matrix(form: Any, rect: list[float]) -> tuple[float, ...]:
    """Matrix that maps a Form XObject into ``rect`` (PDF 12.5.5, Rect from transformed BBox)."""
    bbox = [float(v) for v in form.get("/BBox", [0, 0, 0, 0])]
    m = [float(v) for v in form.get("/Matrix", [1, 0, 0, 1, 0, 0])]
    a, b, c, d, e, f = m
    xs, ys = [], []
    for x, y in ((bbox[0], bbox[1]), (bbox[2], bbox[1]), (bbox[0], bbox[3]), (bbox[2], bbox[3])):
        xs.append(a * x + c * y + e)
        ys.append(b * x + d * y + f)
    tx0, tx1, ty0, ty1 = min(xs), max(xs), min(ys), max(ys)
    rx0, ry0, rx1, ry1 = (min(rect[0], rect[2]), min(rect[1], rect[3]),
                          max(rect[0], rect[2]), max(rect[1], rect[3]))  # fmt: skip
    sx = (rx1 - rx0) / (tx1 - tx0) if tx1 > tx0 else 1.0
    sy = (ry1 - ry0) / (ty1 - ty0) if ty1 > ty0 else 1.0
    return (sx, 0.0, 0.0, sy, rx0 - tx0 * sx, ry0 - ty0 * sy)


def _normal_appearance(widget: Dictionary) -> pikepdf.Object | None:
    ap = widget.get("/AP")
    if not isinstance(ap, Dictionary):
        return None
    normal = ap.get("/N")
    if isinstance(normal, pikepdf.Stream):
        return normal
    if isinstance(normal, Dictionary):
        state = widget.get("/AS")
        if state is not None and str(state) in normal:
            return normal[str(state)]
        return None
    return None


def _draw_widget(fd: FormDoc, page_index: int, widget: Dictionary, counter: int) -> bool:
    form = _normal_appearance(widget)
    if form is None:
        return False
    rect = [float(v) for v in widget["/Rect"]]
    matrix = form_matrix(form, rect)
    page = fd.pdf.pages[page_index]
    res = own_resources(page)
    name = f"{FLAT_PREFIX}{counter}"
    category(res, "/XObject")[f"/{name}"] = form
    draw = f"q {' '.join(number(v) for v in matrix)} cm /{name} Do Q"
    original = content_bytes(page)
    set_content(fd.pdf, page, b"q\n" + original + b"\nQ\n" + draw.encode("ascii") + b"\n")
    return True


def flatten(
    fd: FormDoc,
    *,
    names: list[str] | None = None,
    pages: set[int] | None = None,
    keep_signatures: bool = True,
    remove_javascript: bool = True,
) -> FlattenResult:
    result = FlattenResult()
    counter = 0
    for ref in fd.fields():
        if names is not None and ref.name not in names:
            continue
        if ref.kind == "signature" and keep_signatures:
            result.kept.append(ref.name)
            continue
        targets = [w for w in ref.widgets if _on_pages(fd, w, pages)]
        if not targets:
            continue
        # Some PDFs defer widget rendering to the viewer with /NeedAppearances and
        # have no /AP at all. Build a stable appearance before flattening those fields.
        missing_appearances = [widget for widget in targets if _normal_appearance(widget) is None]
        if missing_appearances:
            refresh(fd, ref, widgets=missing_appearances)
        drawn_widgets: list[Dictionary] = []
        for widget in targets:
            index = fd.page_of(widget)
            if index is None:
                continue
            if _draw_widget(fd, index, widget, counter):
                drawn_widgets.append(widget)
                result.pages.add(index)
            else:
                result.skipped_without_appearance.append(ref.name)
            counter += 1
        if not drawn_widgets:
            continue
        result.flattened.append(ref.name)
        for widget in drawn_widgets:
            _remove_annot(fd, widget)
        if len(drawn_widgets) == len(ref.widgets):
            _remove_node(fd, ref.node)
        else:
            for widget in drawn_widgets:
                if _same(ref.node, widget):
                    continue
                kids = [k for k in ref.node.get("/Kids", []) if not _same(k, widget)]
                ref.node["/Kids"] = Array(kids)
    _clean_acroform(fd, result, remove_javascript=remove_javascript)
    return result


def _on_pages(fd: FormDoc, widget: Dictionary, pages: set[int] | None) -> bool:
    if pages is None:
        return True
    index = fd.page_of(widget)
    return index is not None and index in pages


def _clean_acroform(fd: FormDoc, result: FlattenResult, *, remove_javascript: bool) -> None:
    # An XFA-only document has no AcroForm widgets to flatten. Do not strip its
    # form packet or AcroForm dictionary just because the widget list is empty.
    if not result.flattened:
        return
    acro = fd.acroform
    if acro is None:
        return
    needs_deferred_appearances = any(
        _normal_appearance(widget) is None for ref in fd.fields() for widget in ref.widgets
    )
    if "/NeedAppearances" in acro and not needs_deferred_appearances:
        del acro["/NeedAppearances"]
    remaining = [f for f in acro.get("/Fields", []) if isinstance(f, Dictionary)]
    # XFA is the source of truth for hybrid forms. A partial flatten must not
    # discard it while editable fields remain; remove it only with the last field.
    if not remaining and "/XFA" in acro:
        del acro["/XFA"]
    if remove_javascript:
        if "/AA" in acro:
            del acro["/AA"]
        if "/CO" in acro:
            del acro["/CO"]
        _drop_javascript_actions(fd.pdf)
    if not remaining:
        del fd.pdf.Root["/AcroForm"]
    else:
        acro["/Fields"] = Array(remaining)
    _strip_widget_javascript(fd, remove_javascript)


def _drop_javascript_actions(pdf: pikepdf.Pdf) -> None:
    names = pdf.Root.get("/Names")
    if isinstance(names, Dictionary) and "/JavaScript" in names:
        del names["/JavaScript"]


def _strip_widget_javascript(fd: FormDoc, enabled: bool) -> None:
    if not enabled:
        return
    for page in fd.pdf.pages:
        for annot in page.obj.get("/Annots", []):
            if not isinstance(annot, Dictionary):
                continue
            if "/AA" in annot:
                del annot["/AA"]
            action = annot.get("/A")
            if isinstance(action, Dictionary) and str(action.get("/S", "")) == "/JavaScript":
                del annot["/A"]
