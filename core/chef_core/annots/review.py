"""Reading and changing annotations (milestone v0.7, G2-G4): list, update, remove, reply, status.

Annotation ids (``A<page>:<digest>:<n>``) follow ``chef_core.annots.common``: a change to any
annotation of a page gives new ids for that page. Links (/Subtype /Link) and pop-ups are not
annotations here; see ``chef_core.annots.links``. Form widgets are listed as "Widget" but are not
changed by these operations.

Replies are Text annotations with /IRT (the parent) and /RT /R. Review status is /State with
/StateModel /Review on the annotation that carries it (usually the reply that answers).
"""

from __future__ import annotations

from typing import Any

import pikepdf
from pikepdf import Array, Dictionary

from chef_core.annots.common import (
    ANNOT_PREFIX,
    add_annot,
    annot_digest,
    colour_array,
    date_text,
    display_point,
    display_rect,
    hex_of_array,
    make_id,
    name_of,
    normalised,
    pdf_date,
    remove_index,
    resolve_annot,
    text_of,
    text_string,
    user_rect,
)
from chef_core.annots.markup import (
    build_appearance,
    quads_of,
    reply_dict,
    set_state,
)
from chef_core.errors import invalid_params
from chef_core.overlay.pagecontent import page_frame

HIDDEN_FROM_LIST = frozenset({"Link", "Popup"})
UPDATABLE = frozenset(
    {
        "Highlight",
        "Underline",
        "StrikeOut",
        "Squiggly",
        "Text",
        "FreeText",
        "Ink",
        "Line",
        "Square",
        "Circle",
    }
)


def entries(page: pikepdf.Page) -> list[tuple[int, Dictionary]]:
    arr = page.obj.get("/Annots")
    if not isinstance(arr, pikepdf.Array):
        return []
    return [(i, a) for i, a in enumerate(arr) if isinstance(a, Dictionary)]


def ids_by_objgen(page_index: int, page: pikepdf.Page) -> dict[tuple[int, int], str]:
    digest = annot_digest(page)
    out: dict[tuple[int, int], str] = {}
    for i, annot in entries(page):
        if annot.objgen != (0, 0):
            out[annot.objgen] = make_id(ANNOT_PREFIX, page_index, digest, i)
    return out


def describe(
    pdf: pikepdf.Pdf,
    page_index: int,
    index: int,
    annot: Dictionary,
    ids: dict[tuple[int, int], str],
) -> dict[str, Any]:
    page = pdf.pages[page_index]
    frame = page_frame(page)
    subtype = name_of(annot.get("/Subtype")) or "Unknown"
    own_id = make_id(ANNOT_PREFIX, page_index, annot_digest(page), index)
    replies: list[str] = []
    if annot.objgen != (0, 0):
        for _i, other in entries(page):
            parent_ref = other.get("/IRT")
            if (
                isinstance(parent_ref, Dictionary)
                and parent_ref.objgen == annot.objgen
                and other.objgen in ids
            ):
                replies.append(ids[other.objgen])
    parent = annot.get("/IRT")
    in_reply_to = ids.get(parent.objgen) if isinstance(parent, Dictionary) else None
    state = name_of(annot.get("/State"))
    state_model = name_of(annot.get("/StateModel"))
    rect = [round(v, 3) for v in display_rect(frame, normalised(annot["/Rect"]))]
    quads: list[list[float]] = []
    for quad in quads_of(annot):
        flat: list[float] = []
        for x, y in quad:
            left, top = display_point(frame, x, y)
            flat += [round(left, 3), round(top, 3)]
        quads.append(flat)
    return {
        "id": own_id,
        "pageIndex": page_index,
        "subtype": subtype,
        "rect": rect,
        "contents": text_of(annot.get("/Contents")),
        "author": text_of(annot.get("/T")),
        "modified": date_text(annot.get("/M")),
        "colour": hex_of_array(annot.get("/C")),
        "opacity": round(float(annot.get("/CA", 1.0)), 4),
        "replies": replies,
        "inReplyTo": in_reply_to,
        "status": state.lower() if state else None,
        "stateModel": state_model,
        "appearance": isinstance(annot.get("/AP"), Dictionary) and "/N" in annot["/AP"],
        "quads": quads,
        "icon": name_of(annot.get("/Name")),
        "lineEnding": name_of(_item(annot.get("/LE"), 1)),
        "hidden": bool(int(annot.get("/F", 4)) & 2),
    }


def _item(obj: Any, index: int) -> Any:
    if isinstance(obj, Array) and len(obj) > index:
        return obj[index]
    return None


def list_annots(
    pdf: pikepdf.Pdf,
    page_indices: list[int],
    kinds: set[str] | None,
    author: str | None,
    status: str | None,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for pi in page_indices:
        page = pdf.pages[pi]
        ids = ids_by_objgen(pi, page)
        for index, annot in entries(page):
            subtype = name_of(annot.get("/Subtype")) or ""
            if subtype in HIDDEN_FROM_LIST:
                continue
            if kinds is not None and subtype not in kinds:
                continue
            item = describe(pdf, pi, index, annot, ids)
            if author is not None and author.lower() not in item["author"].lower():
                continue
            if status is not None and item["status"] != status:
                continue
            out.append(item)
    return out


def _check_updatable(annot: Dictionary, ident: str) -> str:
    subtype = name_of(annot.get("/Subtype")) or ""
    if subtype not in UPDATABLE:
        raise invalid_params("ANNOTATION_NOT_EDITABLE", {"id": ident, "subtype": subtype})
    return subtype


def update_annot(
    pdf: pikepdf.Pdf,
    ident: str,
    *,
    contents: str | None,
    author: str | None,
    colour: str | None,
    opacity: float | None,
    box: tuple[float, float, float, float] | None,
) -> str:
    page, index, annot = resolve_annot(pdf, ANNOT_PREFIX, ident)
    subtype = _check_updatable(annot, ident)
    frame = page_frame(page)
    if contents is not None:
        annot.Contents = text_string(contents)
    if author is not None:
        annot.T = text_string(author)
    if colour is not None:
        annot.C = colour_array(colour)
    if opacity is not None:
        annot.CA = round(opacity, 4)
    if box is not None:
        if subtype in ("Text", "FreeText", "Square", "Circle", "Ink"):
            annot.Rect = Array([round(v, 4) for v in user_rect(frame, box)])
        else:
            raise invalid_params("RECT_NOT_EDITABLE", {"subtype": subtype})
    annot.M = pdf_date()
    build_appearance(pdf, annot)
    return make_id(ANNOT_PREFIX, _page_index(pdf, page), annot_digest(page), index)


def _page_index(pdf: pikepdf.Pdf, page: pikepdf.Page) -> int:
    for i, candidate in enumerate(pdf.pages):
        if candidate.obj.objgen == page.obj.objgen:
            return i
    raise invalid_params("PAGE_OUT_OF_RANGE", {})


def remove_annots(pdf: pikepdf.Pdf, ids: list[str]) -> int:
    resolved = []
    for ident in ids:
        page, index, _annot = resolve_annot(pdf, ANNOT_PREFIX, ident)
        resolved.append((_page_index(pdf, page), index, page))
    for _pi, index, page in sorted(resolved, key=lambda t: (t[0], -t[1])):
        remove_index(page, index)
    return len(resolved)


def remove_all(pdf: pikepdf.Pdf, kinds: set[str] | None, page_indices: list[int]) -> int:
    removed = 0
    for pi in page_indices:
        page = pdf.pages[pi]
        doomed = [
            i
            for i, annot in entries(page)
            if (name_of(annot.get("/Subtype")) or "") not in ("Link", "Widget", "Popup")
            and (kinds is None or (name_of(annot.get("/Subtype")) or "") in kinds)
        ]
        for i in sorted(doomed, reverse=True):
            remove_index(page, i)
            removed += 1
    return removed


def reply(pdf: pikepdf.Pdf, ident: str, *, text: str, author: str, colour: str | None) -> str:
    page, index, parent = resolve_annot(pdf, ANNOT_PREFIX, ident)
    if not text.strip():
        raise invalid_params("REPLY_EMPTY", {})
    if parent.objgen == (0, 0):
        # a reply refers to its parent as an indirect object: make the parent indirect in place
        indirect = pdf.make_indirect(parent)
        page.obj.Annots[index] = indirect
        parent = indirect
    parent_rect = normalised(parent["/Rect"])
    child = reply_dict(pdf, parent, parent_rect, text=text, author=author, colour=colour)
    new_index = add_annot(pdf, page, child)
    return make_id(ANNOT_PREFIX, _page_index(pdf, page), annot_digest(page), new_index)


def set_status(pdf: pikepdf.Pdf, ident: str, status: str) -> str:
    page, index, annot = resolve_annot(pdf, ANNOT_PREFIX, ident)
    _check_updatable(annot, ident)
    set_state(annot, status)
    return make_id(ANNOT_PREFIX, _page_index(pdf, page), annot_digest(page), index)


__all__ = [
    "describe",
    "list_annots",
    "remove_all",
    "remove_annots",
    "reply",
    "set_status",
    "update_annot",
]
