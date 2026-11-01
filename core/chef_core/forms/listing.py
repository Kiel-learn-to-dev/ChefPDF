"""Read-only description of form fields for ``forms.list`` (H1 listing)."""

from __future__ import annotations

from typing import Any

from pikepdf import Dictionary

from chef_core.forms.model import (
    FF_COMB,
    FF_COMBO,
    FF_MULTILINE,
    FF_MULTISELECT,
    FF_NOEXPORT,
    FF_PASSWORD,
    FieldRef,
    FormDoc,
    attr,
    javascript_hooks,
    maxlen_of,
    options_of,
    text_of,
    value_of,
    xfa_present,
)


def _display(fd: FormDoc, index: int | None, rect: list[float] | None) -> list[float] | None:
    if index is None or rect is None:
        return None
    return fd.display_rect(index, (rect[0], rect[1], rect[2], rect[3]))


def describe(fd: FormDoc, ref: FieldRef) -> dict[str, Any]:
    flags = ref.flags
    widgets = []
    tooltip = None
    for widget in ref.widgets:
        index = fd.page_of(widget)
        rect = [float(v) for v in widget["/Rect"]] if "/Rect" in widget else None
        widgets.append(
            {
                "page": index,
                "rect": _display(fd, index, rect),
                "hasAppearance": "/AP" in widget,
            }
        )
        if tooltip is None and "/TU" in widget:
            tooltip = text_of(widget["/TU"])
    if tooltip is None and "/TU" in ref.node:
        tooltip = text_of(ref.node["/TU"])
    first_page = next((w["page"] for w in widgets if w["page"] is not None), None)
    default = attr(ref.node, "/DV")
    return {
        "name": ref.name,
        "partialName": ref.partial,
        "type": ref.kind,
        "page": first_page,
        "widgets": widgets,
        "value": value_of(ref),
        "default": None if default is None else text_of(default),
        "options": options_of(ref),
        "tooltip": tooltip,
        "flags": {
            "readOnly": bool(flags & 1),
            "required": bool(flags & 2),
            "noExport": bool(flags & FF_NOEXPORT),
            "maxLen": maxlen_of(ref.node),
            "multiSelect": bool(flags & FF_MULTISELECT),
            "comb": bool(flags & FF_COMB),
            "multiline": bool(flags & FF_MULTILINE),
            "password": bool(flags & FF_PASSWORD),
            "combo": bool(flags & FF_COMBO),
        },
        "javascript": javascript_hooks(ref),
    }


def list_result(fd: FormDoc) -> dict[str, Any]:
    acro = fd.acroform
    need = bool(acro is not None and acro.get("/NeedAppearances", False))
    refs = fd.fields()
    return {
        "fields": [describe(fd, ref) for ref in refs],
        "xfa": xfa_present(fd.pdf),
        "needAppearances": need,
        "hasForm": acro is not None and "/Fields" in acro,
    }


def is_dictionary(obj: Any) -> bool:
    return isinstance(obj, Dictionary)
