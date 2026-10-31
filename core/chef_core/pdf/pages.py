"""Page helpers: geometry, index validation, blank pages."""

from __future__ import annotations

from collections.abc import Iterable

import pikepdf
from pikepdf import Array, Dictionary, Name

from chef_core.errors import invalid_params

A4 = (595.2756, 841.8898)
LETTER = (612.0, 792.0)


def normalized_rotation(page: pikepdf.Page) -> int:
    """Effective /Rotate (inherited) normalised to 0, 90, 180 or 270."""
    try:
        value = int(page.rotation)
    except (TypeError, ValueError, pikepdf.PdfError):
        value = 0
    return (value // 90 * 90) % 360


def _box(page: pikepdf.Page) -> tuple[float, float, float, float]:
    box = page.cropbox  # falls back to the (inherited) MediaBox
    x0, y0, x1, y1 = (float(v) for v in box)
    return min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)


def display_size(page: pikepdf.Page) -> tuple[float, float, int]:
    """(width, height, rotation) as displayed: CropBox × UserUnit, swapped for 90/270."""
    x0, y0, x1, y1 = _box(page)
    unit = 1.0
    raw_unit = page.obj.get("/UserUnit")
    if isinstance(raw_unit, int | float | pikepdf.Object):
        try:
            unit = float(raw_unit)
        except (TypeError, ValueError):
            unit = 1.0
    width, height = (x1 - x0) * unit, (y1 - y0) * unit
    rotation = normalized_rotation(page)
    if rotation in (90, 270):
        width, height = height, width
    return round(width, 3), round(height, 3), rotation


def check_indices(indices: Iterable[int], count: int, field: str = "pages") -> list[int]:
    """Validate 0-based indices against ``count`` and return them as a list."""
    result = list(indices)
    bad = [i for i in result if i < 0 or i >= count]
    if bad:
        raise invalid_params(
            f"{field}: page index out of range (document has {count} pages)",
            {"field": field, "invalid": bad[:20], "pageCount": count},
        )
    return result


def unique_sorted(indices: Iterable[int]) -> list[int]:
    return sorted(set(indices))


def make_blank_page(pdf: pikepdf.Pdf, width: float, height: float) -> pikepdf.Page:
    """A new (not yet inserted) blank page of the given size in points."""
    page_dict = Dictionary(
        Type=Name.Page,
        MediaBox=Array([0, 0, width, height]),
        Resources=Dictionary(),
        Contents=pdf.make_stream(b""),
    )
    return pikepdf.Page(pdf.make_indirect(page_dict))


def page_objgen_index(pdf: pikepdf.Pdf) -> dict[tuple[int, int], int]:
    """Map page object (objnum, gen) → 0-based page index."""
    return {page.obj.objgen: i for i, page in enumerate(pdf.pages)}


def replace_page_order(pdf: pikepdf.Pdf, page_objs: list[pikepdf.Object]) -> None:
    """Make the page tree contain exactly ``page_objs`` (same document) in this order.

    Pages are removed and re-added, so object identity (and therefore outline / link
    destinations pointing at them) is preserved. The same object must not appear twice.
    """
    while len(pdf.pages):
        del pdf.pages[len(pdf.pages) - 1]
    for obj in page_objs:
        pdf.pages.append(pikepdf.Page(obj))
