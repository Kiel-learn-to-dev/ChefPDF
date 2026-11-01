"""Shared helpers of links and annotations (milestone v0.7, D11, G1-G5).

Ids. A link id is ``K<page>:<digest>:<n>`` and an annotation id ``A<page>:<digest>:<n>``, where
``n`` is the position of the annotation in the page's /Annots array and ``digest`` covers the page
content and every annotation dictionary of the page. Any change to the page's annotations gives
new ids; an id of an older revision is refused as stale.

Geometry. Public parameters use the displayed frame (points, origin top-left, y down), like the
rest of the text and content API. Stored objects use user space; ``PageFrame`` converts.

Text strings. PDF text strings are written as UTF-16BE with a byte order mark (Vietnamese needs
it) and read back from PDFDocEncoding, UTF-16 or UTF-8.
"""

from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

import pikepdf
from pikepdf import Array, Dictionary

from chef_core.content.engine import page_digest
from chef_core.errors import invalid_params
from chef_core.signing.anchors import PageFrame

Rect = tuple[float, float, float, float]
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
LINK_PREFIX = "K"
ANNOT_PREFIX = "A"


# -- ids ----------------------------------------------------------------------------------


def page_annots(page: pikepdf.Page) -> list[Dictionary]:
    """The annotation dictionaries of a page, in /Annots order (direct or indirect)."""
    arr = page.obj.get("/Annots")
    if not isinstance(arr, pikepdf.Array):
        return []
    return [a for a in arr if isinstance(a, Dictionary)]


def canonical(obj: Any, depth: int = 0) -> str:
    """A text form of a PDF object that does not depend on how the file was written: numbers
    rounded, keys sorted, references by object number. Stable across save and reopen."""
    if depth > 12:
        return "…"
    if isinstance(obj, bool):
        return "true" if obj else "false"
    if isinstance(obj, (int, float, Decimal)):
        return repr(round(float(obj), 3))
    if isinstance(obj, pikepdf.Name):
        return str(obj)
    if isinstance(obj, pikepdf.String):
        return bytes(obj).hex()
    if isinstance(obj, pikepdf.Array):
        return "[" + " ".join(canonical(v, depth + 1) for v in obj) + "]"
    if isinstance(obj, Dictionary):
        keys = sorted(str(k) for k in obj)
        body = " ".join(f"{k}={canonical(obj[k], depth + 1)}" for k in keys)
        return "<<" + body + ">>"
    if obj is None:
        return "null"
    if isinstance(obj, pikepdf.Stream):
        return "stream"
    return f"ref{getattr(obj, 'objgen', '')}"


def annot_digest(page: pikepdf.Page) -> str:
    """Digest of the page content and of its annotation dictionaries (12 hex digits)."""
    h = hashlib.sha1(page_digest(page).encode())
    for annot in page_annots(page):
        h.update(canonical(annot).encode("utf-8"))
    return h.hexdigest()[:12]


def make_id(prefix: str, page_index: int, digest: str, index: int) -> str:
    return f"{prefix}{page_index}:{digest}:{index}"


def parse_id(prefix: str, value: str) -> tuple[int, str, int] | None:
    m = re.match(rf"^{prefix}(\d+):([0-9a-f]{{12}}):(\d+)$", value)
    return None if m is None else (int(m.group(1)), m.group(2), int(m.group(3)))


def resolve_annot(
    pdf: pikepdf.Pdf, prefix: str, ident: str
) -> tuple[pikepdf.Page, int, Dictionary]:
    """The page, /Annots index and dictionary of an id of the current revision."""
    parsed = parse_id(prefix, ident)
    if parsed is None:
        raise invalid_params("INVALID_ID", {"id": ident})
    page_index, digest, index = parsed
    if page_index >= len(pdf.pages):
        raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": page_index})
    page = pdf.pages[page_index]
    if annot_digest(page) != digest:
        raise invalid_params("STALE_OBJECT_IDS", {"ids": [ident]})
    annots = page.obj.get("/Annots")
    if not isinstance(annots, pikepdf.Array) or index >= len(annots):
        raise invalid_params("ANNOTATION_NOT_FOUND", {"id": ident})
    target = annots[index]
    if not isinstance(target, Dictionary):
        raise invalid_params("ANNOTATION_NOT_FOUND", {"id": ident})
    return page, index, target


def annots_array(page: pikepdf.Page) -> Array:
    """The /Annots array of a page (created when missing)."""
    arr = page.obj.get("/Annots")
    if isinstance(arr, pikepdf.Array):
        return arr
    arr = Array()
    page.obj.Annots = arr
    return arr


def add_annot(pdf: pikepdf.Pdf, page: pikepdf.Page, annot: Dictionary) -> int:
    """Append an annotation (as an indirect object) to a page; returns its /Annots index."""
    arr = annots_array(page)
    arr.append(pdf.make_indirect(annot))
    return len(arr) - 1


def remove_index(page: pikepdf.Page, index: int) -> None:
    arr = page.obj.Annots
    del arr[index]


# -- geometry ------------------------------------------------------------------------------


def display_rect(frame: PageFrame, rect: Rect) -> tuple[float, float, float, float]:
    """A user-space rect as (left, top, right, bottom) in the displayed frame."""
    x0, y0, x1, y1 = frame.rect_to_display(rect)
    height = frame.display_size[1]
    return (x0, height - y1, x1, height - y0)


def user_rect(frame: PageFrame, box: tuple[float, float, float, float]) -> Rect:
    """A displayed (left, top, right, bottom) box as a user-space rect."""
    height = frame.display_size[1]
    left, top, right, bottom = box
    x0, y0, x1, y1 = frame.rect_from_display((left, height - bottom, right, height - top))
    return (x0, y0, x1, y1)


def user_point(frame: PageFrame, left: float, top: float) -> tuple[float, float]:
    """A displayed point (left, top) as a user-space point."""
    height = frame.display_size[1]
    x0, y0, _x1, _y1 = frame.rect_from_display((left, height - top, left, height - top))
    return (x0, y0)


def display_point(frame: PageFrame, x: float, y: float) -> tuple[float, float]:
    """A user-space point as (left, top) in the displayed frame."""
    dx, dy, _x1, _y1 = frame.rect_to_display((x, y, x, y))
    return (dx, frame.display_size[1] - dy)


def normalised(rect: Any) -> Rect:
    x0, y0, x1, y1 = (float(v) for v in rect)
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


def rect_array(rect: Rect) -> Array:
    return Array([round(v, 4) for v in rect])


def overlap_ratio(a: Rect, b: Rect) -> float:
    """Intersection over union of two rects (0 when they do not meet)."""
    ix = min(a[2], b[2]) - max(a[0], b[0])
    iy = min(a[3], b[3]) - max(a[1], b[1])
    if ix <= 0 or iy <= 0:
        return 0.0
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


# -- values --------------------------------------------------------------------------------


def text_string(value: str) -> pikepdf.String:
    """A PDF text string (UTF-16BE with a byte order mark)."""
    return pikepdf.String(b"\xfe\xff" + value.encode("utf-16-be"))


def text_of(obj: Any) -> str:
    """The text of a PDF string object (UTF-16 with BOM, UTF-8 with BOM, or PDFDocEncoding)."""
    if obj is None:
        return ""
    if isinstance(obj, pikepdf.String):
        data = bytes(obj)
        if data.startswith(b"\xfe\xff"):
            return data[2:].decode("utf-16-be", errors="replace")
        if data.startswith(b"\xef\xbb\xbf"):
            return data[3:].decode("utf-8", errors="replace")
        return data.decode("latin-1", errors="replace")
    if isinstance(obj, pikepdf.Name):
        return str(obj).lstrip("/")
    return str(obj)


def pdf_date(now: datetime | None = None) -> pikepdf.String:
    """A PDF date for /M and /CreationDate (UTC)."""
    moment = now or datetime.now(UTC)
    return pikepdf.String(moment.strftime("D:%Y%m%d%H%M%S") + "Z")


def date_text(obj: Any) -> str:
    """A PDF date as ISO 8601 text (empty when absent or unreadable)."""
    raw = text_of(obj)
    m = re.match(r"^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?", raw)
    if m is None:
        return ""
    parts = [m.group(i) or ("01" if i in (2, 3) else "00") for i in range(1, 7)]
    return f"{parts[0]}-{parts[1]}-{parts[2]}T{parts[3]}:{parts[4]}:{parts[5]}"


def colour_array(value: str) -> Array:
    if not HEX.match(value):
        raise invalid_params("INVALID_COLOUR", {"value": value})
    return Array([int(value[i : i + 2], 16) / 255 for i in (1, 3, 5)])


def hex_of_array(obj: Any) -> str | None:
    if not isinstance(obj, pikepdf.Array):
        return None
    vals = [float(v) for v in obj]
    if len(vals) == 3:
        return "#" + "".join(f"{round(max(0.0, min(1.0, v)) * 255):02x}" for v in vals)
    if len(vals) == 1:
        g = f"{round(max(0.0, min(1.0, vals[0])) * 255):02x}"
        return f"#{g}{g}{g}"
    return None


def name_of(obj: Any) -> str | None:
    return str(obj).lstrip("/") if isinstance(obj, pikepdf.Name) else None


def flag_hidden(annot: Dictionary) -> bool:
    return bool(int(annot.get("/F", 0)) & 2)
