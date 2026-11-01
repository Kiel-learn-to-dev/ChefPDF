"""Redaction helpers (T6.07, J6): scrubbing annotations, metadata and thumbnails, and the
independent check that the redacted text is gone (spike S2 section 4.3).

The check reads the saved file with two other readers than the one that edited it:

1. PDFium text of every page (whole page, and the characters whose centre lies in a redacted
   rectangle).
2. pikepdf: the text of every content stream, form XObject and annotation appearance, decoded
   through the fonts' ToUnicode (so a string split across TJ pieces is joined again), plus the
   decoded bytes of every non-image stream, the document information and the XMP metadata.

Text is compared after ``norm``: letters and digits only, lower case, no diacritics. A leak is
reported with its place only (page, stream, metadata), never with the text itself.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
from pikepdf import Array, Dictionary

from chef_core.content.fonts import FontInfo
from chef_core.content.model import Rect
from chef_core.content.textfind import norm
from chef_core.overlay.pagecontent import inherited

_MAX_DEPTH = 8


# -- annotations ------------------------------------------------------------------------------


def _intersects(annot_rect: Any, regions: list[Rect]) -> bool:
    try:
        x0, y0, x1, y1 = (float(v) for v in annot_rect)
    except (TypeError, ValueError):
        return False
    lo_x, hi_x = min(x0, x1), max(x0, x1)
    lo_y, hi_y = min(y0, y1), max(y0, y1)
    return any(lo_x < r[2] and hi_x > r[0] and lo_y < r[3] and hi_y > r[1] for r in regions)


def remove_annotations(page: pikepdf.Page, regions: list[Rect]) -> int:
    """Delete the annotations whose rectangle meets a region. Form values of the removed widgets
    are deleted as well (the field and its parent)."""
    annots = page.obj.get("/Annots")
    if not isinstance(annots, Array):
        return 0
    kept: list[Any] = []
    removed = 0
    for annot in annots:
        if isinstance(annot, Dictionary) and _intersects(annot.get("/Rect"), regions):
            removed += 1
            for holder in (annot, annot.get("/Parent")):
                if isinstance(holder, Dictionary) and "/V" in holder:
                    del holder["/V"]
            continue
        kept.append(annot)
    if removed:
        page.obj["/Annots"] = Array(kept)
    return removed


# -- metadata ---------------------------------------------------------------------------------


def scrub_metadata(pdf: pikepdf.Pdf, texts: list[str]) -> dict[str, int]:
    """Remove the redacted strings from the document information, the outline titles and the
    XMP metadata (the XMP stream is deleted when it holds one of them)."""
    counts = {"info": 0, "bookmarks": 0, "xmp": 0}
    targets = [norm(t) for t in texts if norm(t)]
    if not targets:
        return counts
    for key in list(pdf.docinfo.keys()):
        value = pdf.docinfo[key]
        if isinstance(value, pikepdf.String) and any(t in norm(str(value)) for t in targets):
            del pdf.docinfo[key]
            counts["info"] += 1
    root_meta = pdf.Root.get("/Metadata")
    if isinstance(root_meta, pikepdf.Stream):
        xmp = norm(root_meta.read_bytes().decode("utf-8", errors="ignore"))
        if any(t in xmp for t in targets):
            del pdf.Root["/Metadata"]
            counts["xmp"] += 1
    outlines = pdf.Root.get("/Outlines")
    if isinstance(outlines, Dictionary):
        counts["bookmarks"] = _scrub_outline(outlines, targets)
    return counts


def _scrub_outline(node: Any, targets: list[str], depth: int = 0) -> int:
    if depth > 64 or not isinstance(node, Dictionary):
        return 0
    changed = 0
    item = node.get("/First")
    seen = 0
    while isinstance(item, Dictionary) and seen < 100000:
        seen += 1
        title = item.get("/Title")
        if isinstance(title, pikepdf.String) and any(t in norm(str(title)) for t in targets):
            item["/Title"] = pikepdf.String("[redacted]")
            changed += 1
        changed += _scrub_outline(item, targets, depth + 1)
        item = item.get("/Next")
    return changed


def remove_thumbnails(pdf: pikepdf.Pdf) -> int:
    count = 0
    for page in pdf.pages:
        if "/Thumb" in page.obj:
            del page.obj["/Thumb"]
            count += 1
    return count


# -- independent verification -----------------------------------------------------------------


@dataclass(frozen=True)
class Leak:
    where: str  # "page 2 text", "page 2 region", "stream 12", "content page 3", ...
    pattern: str  # the redacted string's label (never its text)

    def to_json(self) -> dict[str, str]:
        return {"where": self.where, "pattern": self.pattern}


def _is_text_stream(stream: pikepdf.Stream) -> bool:
    if str(stream.get("/Subtype", "")) in ("/Image", "/Type1C", "/CIDFontType0C", "/OpenType"):
        return False
    if str(stream.get("/Type", "")) in ("/XRef", "/ObjStm"):
        return False
    return not any(k in stream for k in ("/Length1", "/Length2", "/Length3"))


def _decoded_text(stream: pikepdf.Stream, fonts: dict[Any, FontInfo]) -> str:
    """The text a content stream shows, joined: glyphs decoded with the fonts' ToUnicode."""
    res = stream.get("/Resources")
    out: list[str] = []
    current: FontInfo | None = None
    try:
        instructions = list(pikepdf.parse_content_stream(stream))
    except pikepdf.PdfError:
        return ""
    for ins in instructions:
        op = str(ins.operator)
        if op == "Tf" and ins.operands:
            current = _font(res, str(ins.operands[0]), fonts)
            continue
        strings: list[bytes] = []
        if op in ("Tj", "'") and ins.operands and isinstance(ins.operands[0], pikepdf.String):
            strings = [bytes(ins.operands[0])]
        elif op == '"' and len(ins.operands) == 3 and isinstance(ins.operands[2], pikepdf.String):
            strings = [bytes(ins.operands[2])]
        elif op == "TJ" and ins.operands and isinstance(ins.operands[0], Array):
            strings = [bytes(x) for x in ins.operands[0] if isinstance(x, pikepdf.String)]
        for data in strings:
            if current is None:
                out.append(data.decode("latin-1"))
                continue
            codes = current.codes(data)
            out.append("".join(current.text(c) for c in codes))
    return "".join(out)


def _font(res: Any, name: str, fonts: dict[Any, FontInfo]) -> FontInfo | None:
    if not isinstance(res, Dictionary):
        return None
    table = res.get("/Font")
    if not isinstance(table, Dictionary):
        return None
    fd = table.get(name)
    if not isinstance(fd, Dictionary):
        return None
    key = fd.objgen if fd.is_indirect else id(fd)
    if key not in fonts:
        fonts[key] = FontInfo(fd)
    return fonts[key]


def _resources_streams(
    res: Any, seen: set[tuple[int, int]], depth: int, out: list[pikepdf.Stream]
) -> None:
    """Form XObjects reachable from a resources dictionary."""
    if depth > _MAX_DEPTH or not isinstance(res, Dictionary):
        return
    table = res.get("/XObject")
    if not isinstance(table, Dictionary):
        return
    for value in table.values():
        if isinstance(value, pikepdf.Stream) and str(value.get("/Subtype", "")) == "/Form":
            if value.is_indirect and value.objgen in seen:
                continue
            if value.is_indirect:
                seen.add(value.objgen)
            out.append(value)
            _resources_streams(value.get("/Resources"), seen, depth + 1, out)


def content_units(pdf: pikepdf.Pdf) -> Iterator[tuple[str, pikepdf.Stream]]:
    """Every stream that paints text: page contents, forms and annotation appearances."""
    seen: set[tuple[int, int]] = set()
    for index, page in enumerate(pdf.pages):
        contents = page.obj.get("/Contents")
        streams = list(contents) if isinstance(contents, Array) else [contents]
        for s in streams:
            if isinstance(s, pikepdf.Stream):
                yield f"content page {index}", s
        forms: list[pikepdf.Stream] = []
        _resources_streams(inherited(page.obj, "/Resources"), seen, 0, forms)
        for annot in page.obj.get("/Annots") or []:
            if isinstance(annot, Dictionary) and isinstance(annot.get("/AP"), Dictionary):
                normal = annot["/AP"].get("/N")
                if isinstance(normal, pikepdf.Stream):
                    forms.append(normal)
        for form in forms:
            yield f"form on page {index}", form


def verify(path: Path, texts: list[str], regions: dict[int, list[Rect]]) -> list[Leak]:
    """Leaks of the redacted texts in the saved file (empty when there are none)."""
    leaks: list[Leak] = []
    targets = [(t, norm(t)) for t in dict.fromkeys(texts) if norm(t)]
    doc = pdfium.PdfDocument(str(path))
    try:
        for index in range(len(doc)):
            page = doc[index]
            textpage = page.get_textpage()
            try:
                whole = norm(textpage.get_text_range())
                if any(key in whole for _text, key in targets):
                    leaks.append(Leak(f"page {index} text", "text"))
                for rect in regions.get(index, []):
                    leaks.extend(_region_leaks(textpage, index, rect))
            finally:
                textpage.close()
                page.close()
    finally:
        doc.close()
    with pikepdf.open(path) as pdf:
        fonts: dict[Any, FontInfo] = {}
        for where, stream in content_units(pdf):
            text = norm(_decoded_text(stream, fonts))
            if any(key in text for _t, key in targets):
                leaks.append(Leak(where, "text"))
        for obj in pdf.objects:
            if not isinstance(obj, pikepdf.Stream) or not _is_text_stream(obj):
                continue
            try:
                raw = obj.read_bytes()
            except pikepdf.PdfError:
                continue
            flats = [norm(raw.decode("latin-1")), norm(raw.decode("utf-8", errors="ignore"))]
            if any(key in flat for flat in flats for _t, key in targets):
                leaks.append(Leak(f"stream {obj.objgen[0]}", "bytes"))
        info_values = [str(v) for v in pdf.docinfo.values() if isinstance(v, pikepdf.String)]
        if any(key in norm(value) for value in info_values for _t, key in targets):
            leaks.append(Leak("document information", "info"))
        meta = pdf.Root.get("/Metadata")
        if isinstance(meta, pikepdf.Stream):
            flat = norm(meta.read_bytes().decode("utf-8", errors="ignore"))
            if any(key in flat for _t, key in targets):
                leaks.append(Leak("xmp metadata", "xmp"))
    return _unique(leaks)


def _region_leaks(textpage: pdfium.PdfTextPage, index: int, rect: Rect) -> list[Leak]:
    count = textpage.count_chars()
    for i in range(count):
        ch = textpage.get_text_range(i, 1)
        if not ch.strip():
            continue
        try:
            left, bottom, right, top = textpage.get_charbox(i, loose=False)
        except Exception:
            continue
        cx, cy = (left + right) / 2, (bottom + top) / 2
        if rect[0] <= cx <= rect[2] and rect[1] <= cy <= rect[3]:
            return [Leak(f"page {index} region", "region")]
    return []


def _unique(leaks: list[Leak]) -> list[Leak]:
    seen: set[tuple[str, str]] = set()
    out: list[Leak] = []
    for leak in leaks:
        key = (leak.where, leak.pattern)
        if key not in seen:
            seen.add(key)
            out.append(leak)
    return out


__all__ = [
    "Leak",
    "content_units",
    "remove_annotations",
    "remove_thumbnails",
    "scrub_metadata",
    "verify",
]
