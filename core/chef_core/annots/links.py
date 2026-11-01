"""Links (milestone v0.7, D11): list, add, update, remove and detect web links.

- A link is a /Subtype /Link annotation. A page target is a /Dest array (never /A GoTo), built
  from the target page's own frame, so that it is right on rotated pages. A web target is an /A
  URI action. Named and file actions are listed, not created.
- JavaScript actions are listed and flagged, and never created.
- Appearance: /Border and /BS (solid, width) and /C for the border colour; /H is the highlight
  mode (none, invert, outline).
- Detection reads the text model of each page: http(s) and www. addresses and e-mail addresses
  become URI links over the characters that spell them.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

import pikepdf
from pikepdf import Array, Dictionary, Name

from chef_core.annots.common import (
    LINK_PREFIX,
    add_annot,
    annot_digest,
    colour_array,
    display_point,
    display_rect,
    hex_of_array,
    make_id,
    name_of,
    overlap_ratio,
    page_annots,
    remove_index,
    resolve_annot,
    text_of,
    user_point,
    user_rect,
)
from chef_core.errors import invalid_params
from chef_core.overlay.pagecontent import page_frame
from chef_core.text.build import build_text_page
from chef_core.text.edit import real_char_indices

HIGHLIGHT = {"none": "N", "invert": "I", "outline": "O", "push": "P"}
FORBIDDEN_URI = re.compile(r"^\s*(javascript|vbscript|file)\s*:", re.IGNORECASE)
URL_PATTERN = re.compile(
    r"(?P<url>(?:https?://|www\.)[^\s<>\"']+)|(?P<mail>[\w.+-]+@[\w-]+(?:\.[\w-]+)+)"
)
TRAILING = ".,;:!?)]}\"'"


@dataclass(frozen=True)
class LinkTarget:
    kind: str  # uri | page | named | file | javascript | other
    target: Any = None
    view: str | None = None
    top: float | None = None
    left: float | None = None
    flagged: bool = False


def _index_of(pdf: pikepdf.Pdf, page: pikepdf.Page) -> int:
    for i, candidate in enumerate(pdf.pages):
        if candidate.obj.objgen == page.obj.objgen:
            return i
    raise invalid_params("PAGE_OUT_OF_RANGE", {})


def _page_index_map(pdf: pikepdf.Pdf) -> dict[tuple[int, int], int]:
    return {p.obj.objgen: i for i, p in enumerate(pdf.pages)}


def _dest_target(pdf: pikepdf.Pdf, dest: Any, index_of: dict[tuple[int, int], int]) -> LinkTarget:
    if isinstance(dest, pikepdf.Array) and len(dest) >= 2:
        ref = dest[0]
        if isinstance(ref, int):
            page_index = int(ref)
        elif isinstance(ref, Dictionary) and ref.objgen in index_of:
            page_index = index_of[ref.objgen]
        else:
            return LinkTarget(kind="other", target=None)
        view = name_of(dest[1]) or "Fit"
        left = top = None
        if view == "XYZ" and len(dest) >= 4:
            target_page = pdf.pages[page_index]
            frame = page_frame(target_page)
            x = dest[2] if isinstance(dest[2], (int, float)) else 0.0
            y = dest[3] if isinstance(dest[3], (int, float)) else frame.y1
            left, top = (round(v, 3) for v in display_point(frame, float(x), float(y)))
        return LinkTarget(kind="page", target=page_index, view=view.lower(), top=top, left=left)
    if isinstance(dest, (pikepdf.Name, pikepdf.String)):
        return LinkTarget(kind="named", target=text_of(dest))
    return LinkTarget(kind="other", target=None)


def link_target(
    pdf: pikepdf.Pdf, annot: Dictionary, index_of: dict[tuple[int, int], int]
) -> LinkTarget:
    action = annot.get("/A")
    if isinstance(action, Dictionary):
        kind = name_of(action.get("/S")) or ""
        if kind == "URI":
            return LinkTarget(kind="uri", target=text_of(action.get("/URI")))
        if kind == "GoTo":
            return _dest_target(pdf, action.get("/D"), index_of)
        if kind == "Named":
            return LinkTarget(kind="named", target=name_of(action.get("/N")) or "")
        if kind in ("GoToR", "Launch"):
            return LinkTarget(kind="file", target=text_of(action.get("/F")))
        if kind == "JavaScript":
            return LinkTarget(kind="javascript", target=None, flagged=True)
        return LinkTarget(kind="other", target=kind)
    if "/Dest" in annot:
        return _dest_target(pdf, annot.get("/Dest"), index_of)
    return LinkTarget(kind="other", target=None)


def _links_on(pdf: pikepdf.Pdf, page_index: int) -> list[tuple[int, Dictionary]]:
    page = pdf.pages[page_index]
    arr = page.obj.get("/Annots")
    if not isinstance(arr, pikepdf.Array):
        return []
    out: list[tuple[int, Dictionary]] = []
    for i, item in enumerate(arr):
        if isinstance(item, Dictionary) and name_of(item.get("/Subtype")) == "Link":
            out.append((i, item))
    return out


def list_links(pdf: pikepdf.Pdf, page_index: int) -> list[dict[str, Any]]:
    page = pdf.pages[page_index]
    digest = annot_digest(page)
    frame = page_frame(page)
    index_of = _page_index_map(pdf)
    out: list[dict[str, Any]] = []
    for i, annot in _links_on(pdf, page_index):
        target = link_target(pdf, annot, index_of)
        rect = [round(v, 3) for v in display_rect(frame, _rect(annot))]
        border = annot.get("/BS")
        width = (
            float(border.get("/W", 1)) if isinstance(border, Dictionary) else _border_width(annot)
        )
        highlight = name_of(annot.get("/H")) or "I"
        out.append(
            {
                "id": make_id(LINK_PREFIX, page_index, digest, i),
                "pageIndex": page_index,
                "kind": target.kind,
                "target": target.target,
                "view": target.view,
                "left": target.left,
                "top": target.top,
                "rect": rect,
                "borderWidth": width,
                "color": hex_of_array(annot.get("/C")),
                "highlight": {v: k for k, v in HIGHLIGHT.items()}.get(highlight, "invert"),
                "flagged": target.flagged,
            }
        )
    return out


def _rect(annot: Dictionary) -> tuple[float, float, float, float]:
    x0, y0, x1, y1 = (float(v) for v in annot["/Rect"])
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


def _border_width(annot: Dictionary) -> float:
    border = annot.get("/Border")
    if isinstance(border, pikepdf.Array) and len(border) >= 3:
        return float(border[2])
    return 1.0


def _border(annot: Dictionary, width: float) -> None:
    annot.Border = Array([0, 0, width])
    annot.BS = Dictionary(W=width, S=Name.S)


def _new_link(
    pdf: pikepdf.Pdf, page: pikepdf.Page, rect: tuple[float, float, float, float]
) -> Dictionary:
    return Dictionary(
        Type=Name.Annot,
        Subtype=Name.Link,
        Rect=Array([round(v, 4) for v in rect]),
        F=4,
    )


def set_target(
    pdf: pikepdf.Pdf,
    annot: Dictionary,
    *,
    page: pikepdf.Page,
    uri: str | None,
    target_page: int | None,
    view: str,
    left: float | None,
    top: float | None,
) -> None:
    """Make ``annot`` a web link (uri) or a page link (target_page). Replaces the old target."""
    if uri is not None:
        if FORBIDDEN_URI.match(uri):
            raise invalid_params("LINK_ACTION_REFUSED", {"uri": uri})
        for key in ("/Dest", "/A"):
            if key in annot:
                del annot[key]
        annot.A = Dictionary(S=Name.URI, URI=pikepdf.String(uri.encode("utf-8")))
        return
    if target_page is None:
        raise invalid_params("LINK_TARGET_MISSING", {})
    if target_page >= len(pdf.pages):
        raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": target_page})
    if view not in ("fit", "xyz"):
        raise invalid_params("INVALID_VIEW", {"view": view})
    target = pdf.pages[target_page]
    if "/A" in annot:
        del annot["/A"]
    if view == "fit":
        dest: Array = Array([target.obj, Name.Fit])
    else:
        frame = page_frame(target)
        height = frame.display_size[1]
        x, y = user_point(frame, left or 0.0, height if top is None else top)
        dest = Array([target.obj, Name.XYZ, round(x, 4), round(y, 4), None])
    annot.Dest = dest


def add_link(
    pdf: pikepdf.Pdf,
    page_index: int,
    box: tuple[float, float, float, float],
    *,
    uri: str | None,
    target_page: int | None,
    view: str,
    left: float | None,
    top: float | None,
    border_width: float,
    colour: str | None,
    highlight: str,
) -> str:
    page = pdf.pages[page_index]
    frame = page_frame(page)
    rect = user_rect(frame, box)
    if highlight not in HIGHLIGHT:
        raise invalid_params("INVALID_HIGHLIGHT", {"highlight": highlight})
    annot = _new_link(pdf, page, rect)
    set_target(
        pdf,
        annot,
        page=page,
        uri=uri,
        target_page=target_page,
        view=view,
        left=left,
        top=top,
    )
    _border(annot, border_width)
    annot.H = Name("/" + HIGHLIGHT[highlight])
    if colour is not None:
        annot.C = colour_array(colour)
    index = add_annot(pdf, page, annot)
    return make_id(LINK_PREFIX, page_index, annot_digest(page), index)


def update_link(
    pdf: pikepdf.Pdf,
    ident: str,
    *,
    box: tuple[float, float, float, float] | None,
    uri: str | None,
    target_page: int | None,
    view: str | None,
    left: float | None,
    top: float | None,
    border_width: float | None,
    colour: str | None,
    highlight: str | None,
) -> str:
    page, index, annot = resolve_annot(pdf, LINK_PREFIX, ident)
    if name_of(annot.get("/Subtype")) != "Link":
        raise invalid_params("NOT_A_LINK", {"id": ident})
    if box is not None:
        frame = page_frame(page)
        annot.Rect = Array([round(v, 4) for v in user_rect(frame, box)])
    if uri is not None or target_page is not None:
        set_target(
            pdf,
            annot,
            page=page,
            uri=uri,
            target_page=target_page,
            view=view or "fit",
            left=left,
            top=top,
        )
    if border_width is not None:
        _border(annot, border_width)
    if colour is not None:
        annot.C = colour_array(colour)
    if highlight is not None:
        if highlight not in HIGHLIGHT:
            raise invalid_params("INVALID_HIGHLIGHT", {"highlight": highlight})
        annot.H = Name("/" + HIGHLIGHT[highlight])
    page_index = _index_of(pdf, page)
    return make_id(LINK_PREFIX, page_index, annot_digest(page), index)


def remove_links(pdf: pikepdf.Pdf, ids: list[str] | None, page_index: int | None) -> int:
    """Remove the named links (ids) or every link of one page (page_index) or the document."""
    removed = 0
    if ids is not None:
        resolved = []
        for ident in ids:
            page, index, _annot = resolve_annot(pdf, LINK_PREFIX, ident)
            resolved.append((_index_of(pdf, page), index, page))
        for _pi, index, page in sorted(resolved, key=lambda t: (t[0], -t[1])):
            remove_index(page, index)
            removed += 1
        return removed
    indices = [page_index] if page_index is not None else list(range(len(pdf.pages)))
    for pi in indices:
        page = pdf.pages[pi]
        arr = page.obj.get("/Annots")
        if not isinstance(arr, pikepdf.Array):
            continue
        for i in reversed([i for i, _a in _links_on(pdf, pi)]):
            remove_index(page, i)
            removed += 1
    return removed


def _existing_rects(pdf: pikepdf.Pdf, page_index: int) -> list[tuple[float, float, float, float]]:
    out = []
    for annot in page_annots(pdf.pages[page_index]):
        if name_of(annot.get("/Subtype")) == "Link" and "/Rect" in annot:
            out.append(_rect(annot))
    return out


def detect_links(
    pdf: pikepdf.Pdf, pages: list[int] | None, skip_existing: bool
) -> list[dict[str, Any]]:
    """Create URI links for the web and e-mail addresses of the text of each page."""
    indices = pages if pages is not None else list(range(len(pdf.pages)))
    created: list[dict[str, Any]] = []
    for pi in indices:
        if pi >= len(pdf.pages):
            raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": pi})
        tp = build_text_page(pdf, pdf.pages[pi], pi)
        existing = _existing_rects(pdf, pi)
        for line in tp.lines:
            if line.artifact:
                continue
            for m in URL_PATTERN.finditer(line.text):
                start, end = m.span()
                while end > start and line.text[end - 1] in TRAILING:
                    end -= 1
                if end <= start:
                    continue
                text = line.text[start:end]
                chars = [line.chars[i] for i in real_char_indices(line, start, end)]
                if not chars:
                    continue
                box = (
                    min(c.x0 for c in chars),
                    min(c.y0 for c in chars),
                    max(c.x1 for c in chars),
                    max(c.y1 for c in chars),
                )
                if skip_existing and any(overlap_ratio(box, r) > 0.5 for r in existing):
                    continue
                if m.group("mail") is not None:
                    uri = "mailto:" + text
                elif text.lower().startswith("www."):
                    uri = "https://" + text
                else:
                    uri = text
                page = pdf.pages[pi]
                annot = _new_link(pdf, page, box)
                set_target(
                    pdf,
                    annot,
                    page=page,
                    uri=uri,
                    target_page=None,
                    view="fit",
                    left=None,
                    top=None,
                )
                _border(annot, 0.0)
                annot.H = Name.I
                index = add_annot(pdf, page, annot)
                existing.append(box)
                created.append(
                    {
                        "id": make_id(LINK_PREFIX, pi, annot_digest(page), index),
                        "pageIndex": pi,
                        "uri": uri,
                        "text": text,
                    }
                )
    return created
