"""Document properties (feature B7): ``DocumentInfo`` in rpc.ts."""

from __future__ import annotations

import logging
import re
from typing import Any

import pikepdf

from chef_core.pdf.pages import display_size

log = logging.getLogger(__name__)

_SUBSET_RE = re.compile(r"^[A-Z]{6}\+")
_DATE_RE = re.compile(
    r"^(?:D:)?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?"
    r"\s*(?:(Z)|([+-])(\d{2})'?(\d{2})?'?)?"
)
_DATE_KEYS = {"CreationDate", "ModDate"}
_FONT_FILE_KEYS = ("/FontFile", "/FontFile2", "/FontFile3")
_MAX_FONT_SCAN_DEPTH = 8


def pdf_date_to_iso(value: str) -> str:
    """Convert a PDF date (``D:YYYYMMDDHHmmSSOHH'mm'``) to ISO 8601; unknown → unchanged."""
    m = _DATE_RE.match(value.strip())
    if not m:
        return value
    year, month, day, hour, minute, second, zulu, sign, tzh, tzm = m.groups()
    text = f"{year}-{month or '01'}-{day or '01'}T{hour or '00'}:{minute or '00'}:{second or '00'}"
    if zulu:
        text += "Z"
    elif sign:
        text += f"{sign}{tzh}:{tzm or '00'}"
    return text


def _metadata(pdf: pikepdf.Pdf) -> dict[str, str]:
    result: dict[str, str] = {}
    try:
        docinfo = pdf.trailer.get("/Info")
    except Exception:
        return result
    if not isinstance(docinfo, pikepdf.Dictionary):
        return result
    for key, value in docinfo.items():
        name = key.lstrip("/")
        if isinstance(value, pikepdf.String):
            text = str(value)
        elif isinstance(value, pikepdf.Name):
            text = str(value).lstrip("/")
        else:
            continue
        if name in _DATE_KEYS:
            text = pdf_date_to_iso(text)
        result[name] = text
    return result


def _font_entry(font: pikepdf.Dictionary) -> tuple[str, bool, bool]:
    base = font.get("/BaseFont")
    name = str(base).lstrip("/") if isinstance(base, pikepdf.Name) else ""
    subtype = font.get("/Subtype")
    descriptor = font.get("/FontDescriptor")
    if subtype == pikepdf.Name.Type0:
        descendants = font.get("/DescendantFonts")
        if isinstance(descendants, pikepdf.Array) and len(descendants) > 0:
            child = descendants[0]
            if isinstance(child, pikepdf.Dictionary):
                descriptor = child.get("/FontDescriptor")
    embedded = False
    if subtype == pikepdf.Name.Type3:
        embedded = True  # glyphs are defined inside the PDF
        if not name:
            font_name = font.get("/Name")
            name = str(font_name).lstrip("/") if isinstance(font_name, pikepdf.Name) else "Type3"
    elif isinstance(descriptor, pikepdf.Dictionary):
        embedded = any(k in descriptor for k in _FONT_FILE_KEYS)
    subset = bool(_SUBSET_RE.match(name))
    if subset:
        name = name[7:]
    return name or "(unnamed)", embedded, subset


def _collect_fonts(
    resources: pikepdf.Object | None,
    seen_objects: set[tuple[int, int]],
    fonts: dict[tuple[str, bool, bool], None],
    depth: int = 0,
) -> None:
    if not isinstance(resources, pikepdf.Dictionary) or depth > _MAX_FONT_SCAN_DEPTH:
        return
    font_dict = resources.get("/Font")
    if isinstance(font_dict, pikepdf.Dictionary):
        for _key, font in font_dict.items():
            if not isinstance(font, pikepdf.Dictionary):
                continue
            if font.is_indirect:
                if font.objgen in seen_objects:
                    continue
                seen_objects.add(font.objgen)
            fonts[_font_entry(font)] = None
    xobjects = resources.get("/XObject")
    if isinstance(xobjects, pikepdf.Dictionary):
        for _key, xobj in xobjects.items():
            if not isinstance(xobj, pikepdf.Stream) or xobj.get("/Subtype") != pikepdf.Name.Form:
                continue
            if xobj.is_indirect:
                if xobj.objgen in seen_objects:
                    continue
                seen_objects.add(xobj.objgen)
            _collect_fonts(xobj.get("/Resources"), seen_objects, fonts, depth + 1)


def _fonts(pdf: pikepdf.Pdf) -> list[dict[str, Any]]:
    fonts: dict[tuple[str, bool, bool], None] = {}
    seen: set[tuple[int, int]] = set()
    seen_resources: set[tuple[int, int]] = set()
    for page in pdf.pages:
        try:
            resources = page.resources
        except Exception:
            continue
        if resources.is_indirect:
            if resources.objgen in seen_resources:
                continue
            seen_resources.add(resources.objgen)
        _collect_fonts(resources, seen, fonts)
    entries = sorted(fonts, key=lambda f: (f[0].lower(), f[1], f[2]))
    return [{"name": n, "embedded": e, "subset": s} for n, e, s in entries]


def _iter_fields(fields: pikepdf.Object, depth: int = 0) -> list[pikepdf.Dictionary]:
    out: list[pikepdf.Dictionary] = []
    if not isinstance(fields, pikepdf.Array) or depth > 32:
        return out
    for f in fields:
        if not isinstance(f, pikepdf.Dictionary):
            continue
        out.append(f)
        kids = f.get("/Kids")
        if kids is not None:
            out.extend(_iter_fields(kids, depth + 1))
    return out


def has_signatures(pdf: pikepdf.Pdf) -> bool:
    """True if the AcroForm contains at least one *signed* signature field."""
    acroform = pdf.Root.get("/AcroForm")
    if not isinstance(acroform, pikepdf.Dictionary):
        return False
    for f in _iter_fields(acroform.get("/Fields", pikepdf.Array())):
        if f.get("/FT") == pikepdf.Name.Sig and isinstance(f.get("/V"), pikepdf.Dictionary):
            return True
    return False


def document_info(pdf: pikepdf.Pdf, *, encrypted: bool, file_size: int) -> dict[str, Any]:
    pages = []
    for page in pdf.pages:
        try:
            width, height, rotation = display_size(page)
        except Exception as exc:
            log.warning("could not read page size: %s", exc)
            width, height, rotation = 0.0, 0.0, 0
        pages.append({"width": width, "height": height, "rotation": rotation})
    try:
        fonts = _fonts(pdf)
    except Exception as exc:
        log.warning("could not list fonts: %s", exc)
        fonts = []
    return {
        "pageCount": len(pdf.pages),
        "pdfVersion": str(pdf.pdf_version),
        "encrypted": encrypted,
        "fileSize": file_size,
        "metadata": _metadata(pdf),
        "pages": pages,
        "fonts": fonts,
        "hasSignatures": has_signatures(pdf),
    }
