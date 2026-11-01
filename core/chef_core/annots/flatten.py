"""Flattening annotations into page content (milestone v0.7, G5).

Each annotation with a normal appearance becomes a Form XObject placed on the page. The placement
follows the rule of the PDF specification (section 12.5.5): the appearance's BBox, transformed by
its Matrix, is mapped onto the annotation's /Rect. The original page content is wrapped in q/Q,
so that the appended placements start from the graphics state the page ends with.

Kept as annotations: links (keepLinks, default true) and form widgets (keepFormFields, default
true). Hidden annotations are dropped, pop-ups are dropped (they are never drawn), and an
annotation without an appearance stream is left alone (it cannot be drawn into the page).
"""

from __future__ import annotations

from dataclasses import dataclass

import pikepdf
from pikepdf import Array, Dictionary, Name

from chef_core.annots.common import flag_hidden, name_of, normalised
from chef_core.overlay.pagecontent import category, content_bytes, own_resources, set_content

IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


@dataclass
class FlattenStats:
    flattened: int = 0
    dropped: int = 0
    kept: int = 0


def _appearance(annot: Dictionary) -> pikepdf.Stream | None:
    ap = annot.get("/AP")
    if not isinstance(ap, Dictionary):
        return None
    normal = ap.get("/N")
    if isinstance(normal, Dictionary):
        state = name_of(annot.get("/AS"))
        normal = normal.get("/" + state) if state else None
    return normal if isinstance(normal, pikepdf.Stream) else None


def _matrix(stream: pikepdf.Stream) -> tuple[float, ...]:
    raw = stream.get("/Matrix")
    if isinstance(raw, Array) and len(raw) == 6:
        return tuple(float(v) for v in raw)
    return IDENTITY


def placement(stream: pikepdf.Stream, rect: tuple[float, float, float, float]) -> tuple[float, ...]:
    """The matrix that maps the appearance's user space onto the annotation rect."""
    bbox = [float(v) for v in stream.BBox]
    x0, y0, x1, y1 = (
        min(bbox[0], bbox[2]),
        min(bbox[1], bbox[3]),
        max(bbox[0], bbox[2]),
        max(bbox[1], bbox[3]),
    )
    a, b, c, d, e, f = _matrix(stream)
    corners = [(x0, y0), (x1, y0), (x0, y1), (x1, y1)]
    pts = [(a * x + c * y + e, b * x + d * y + f) for x, y in corners]
    tx0 = min(p[0] for p in pts)
    tx1 = max(p[0] for p in pts)
    ty0 = min(p[1] for p in pts)
    ty1 = max(p[1] for p in pts)
    rx0, ry0, rx1, ry1 = rect
    sx = (rx1 - rx0) / (tx1 - tx0) if tx1 - tx0 > 1e-9 else 1.0
    sy = (ry1 - ry0) / (ty1 - ty0) if ty1 - ty0 > 1e-9 else 1.0
    return (sx, 0.0, 0.0, sy, rx0 - tx0 * sx, ry0 - ty0 * sy)


def flatten_page(
    pdf: pikepdf.Pdf,
    page: pikepdf.Page,
    *,
    kinds: set[str] | None,
    keep_links: bool,
    keep_forms: bool,
) -> FlattenStats:
    stats = FlattenStats()
    arr = page.obj.get("/Annots")
    if not isinstance(arr, pikepdf.Array) or len(arr) == 0:
        return stats
    keep: list[Dictionary] = []
    placements: list[bytes] = []
    res: Dictionary | None = None
    for item in list(arr):
        if not isinstance(item, Dictionary):
            continue
        subtype = name_of(item.get("/Subtype")) or ""
        if subtype == "Popup":
            stats.dropped += 1
            continue
        if (subtype == "Link" and keep_links) or (subtype == "Widget" and keep_forms):
            keep.append(item)
            stats.kept += 1
            continue
        if kinds is not None and subtype not in kinds:
            keep.append(item)
            stats.kept += 1
            continue
        if flag_hidden(item):
            stats.dropped += 1
            continue
        stream = _appearance(item)
        if stream is None or "/Rect" not in item:
            keep.append(item)
            stats.kept += 1
            continue
        if res is None:
            res = own_resources(page)
        xobjects = category(res, "/XObject")
        n = len(xobjects)
        while f"/ChefFlat{n}" in xobjects:
            n += 1
        name = f"ChefFlat{n}"
        xobjects[Name("/" + name)] = stream
        rect = normalised(item["/Rect"])
        a, b, c, d, e, f = placement(stream, rect)
        placements.append(
            f"q {a:.6f} {b:.6f} {c:.6f} {d:.6f} {e:.6f} {f:.6f} cm /{name} Do Q".encode()
        )
        stats.flattened += 1
    if stats.flattened == 0 and stats.dropped == 0:
        return stats
    if keep:
        page.obj.Annots = Array(keep)
    elif "/Annots" in page.obj:
        del page.obj["/Annots"]
    if placements:
        body = b"q\n" + content_bytes(page) + b"\nQ\n" + b"\n".join(placements) + b"\n"
        set_content(pdf, page, body)
    return stats


def flatten(
    pdf: pikepdf.Pdf,
    page_indices: list[int],
    *,
    kinds: set[str] | None,
    keep_links: bool,
    keep_forms: bool,
) -> FlattenStats:
    total = FlattenStats()
    for pi in page_indices:
        got = flatten_page(
            pdf, pdf.pages[pi], kinds=kinds, keep_links=keep_links, keep_forms=keep_forms
        )
        total.flattened += got.flattened
        total.dropped += got.dropped
        total.kept += got.kept
    return total


__all__ = ["FlattenStats", "flatten", "flatten_page", "placement"]
