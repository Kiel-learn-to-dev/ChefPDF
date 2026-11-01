"""Editing form fields: fill (H1), create (H2), and the property, name, removal and tab-order edits.

Every value goes through one path: ``normalize`` validates it against the field kind (max length,
read-only, the choices of a list or radio group), ``store`` writes /V and /AS, and ``draw`` builds
the widget appearances again. Validation of a whole batch happens before anything is written, so
a bad value leaves the document untouched.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass, field, replace
from typing import Any

import pikepdf
from pikepdf import Array, Dictionary, Name

from chef_core.errors import invalid_params
from chef_core.forms.appearance import (
    font_resource,
    list_stream,
    look_of,
    mark_stream,
    text_stream,
)
from chef_core.forms.model import (
    FF_COMB,
    FF_COMBO,
    FF_EDIT,
    FF_MULTILINE,
    FF_MULTISELECT,
    FF_NOTOGGLE,
    FF_PUSH,
    FF_RADIO,
    FF_READONLY,
    FF_REQUIRED,
    TEXT_KINDS,
    FieldRef,
    FormDoc,
    attr,
    da_of,
    flags_of,
    objgen_of,
    on_states,
    options_of,
    parse_da,
    text_of,
    text_string,
    value_of,
)
from chef_core.overlay.geometry import number

NAME_PART = re.compile(r"^[^\s.\[\]()<>{}/%]+$")
ON_DEFAULT = "Yes"
RADIO_DEFAULT_PREFIX = "Option"
KINDS = frozenset(
    {"text", "multiline", "comb", "checkbox", "radio", "dropdown", "listbox", "button", "signature"}
)


# -- value normalisation ----------------------------------------------------------------


def _check_writable(ref: FieldRef, force: bool) -> None:
    if ref.read_only and not force:
        raise invalid_params(
            f"Field {ref.name} is read-only", {"field": ref.name, "reason": "readOnly"}
        )


def normalize(ref: FieldRef, value: Any, *, force: bool = False) -> Any:
    """The canonical value to store for ``ref``; raises INVALID_PARAMS when it does not fit."""
    kind = ref.kind
    if kind in ("button", "signature", "unknown"):
        raise invalid_params(f"Field {ref.name} cannot hold a value ({kind})", {"field": ref.name})
    _check_writable(ref, force)
    if kind in TEXT_KINDS:
        if value is None:
            return ""
        if not isinstance(value, str):
            raise invalid_params(f"Field {ref.name} takes text", {"field": ref.name})
        if ref.max_len is not None and len(value) > ref.max_len:
            raise invalid_params(
                f"Field {ref.name} accepts at most {ref.max_len} characters",
                {"field": ref.name, "maxLen": ref.max_len},
            )
        return value
    if kind == "checkbox":
        return _checkbox_bool(ref, value)
    if kind == "radio":
        if value is None or value in ("", "Off"):
            return None
        states = [o["export"] for o in options_of(ref)]
        if value not in states:
            raise invalid_params(
                f"{value} is not an option of {ref.name}",
                {"field": ref.name, "options": states},
            )
        return value
    if kind == "dropdown":
        if value is None or value == "":
            return None
        return _choice_values(ref, [value], single=True)
    if kind == "listbox":
        if value in (None, "", []):
            return None
        items = list(value) if isinstance(value, list) else [value]
        if len(items) > 1 and not ref.flags & FF_MULTISELECT:
            raise invalid_params(f"{ref.name} allows one choice", {"field": ref.name})
        return _choice_values(ref, items, single=False)
    raise invalid_params(f"Unsupported field kind {kind}", {"field": ref.name})


def _checkbox_bool(ref: FieldRef, value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, str):
        on = {s for w in ref.widgets for s in on_states(w)} or {ON_DEFAULT}
        if value in on:
            return True
        if value in ("Off", ""):
            return False
    raise invalid_params(f"{value!r} is not a value of check box {ref.name}", {"field": ref.name})


def _choice_values(ref: FieldRef, items: list[Any], *, single: bool) -> list[str]:
    exports = [o["export"] for o in options_of(ref)]
    editable = bool(ref.flags & FF_EDIT)
    out: list[str] = []
    for item in items:
        if not isinstance(item, str):
            raise invalid_params(f"{ref.name} takes text choices", {"field": ref.name})
        if item not in exports and not (editable and single):
            raise invalid_params(
                f"{item} is not an option of {ref.name}",
                {"field": ref.name, "options": exports},
            )
        out.append(item)
    return out


# -- storing and drawing ----------------------------------------------------------------


def store(fd: FormDoc, ref: FieldRef, value: Any) -> None:
    """Write /V (and /AS for buttons). ``value`` is already normalised."""
    node = ref.node
    kind = ref.kind
    if kind in TEXT_KINDS:
        node["/V"] = text_string(value or "")
    elif kind == "checkbox":
        on = _on_name(ref)
        name = Name(f"/{on}") if value else Name.Off
        node["/V"] = name
        for widget in ref.widgets:
            widget["/AS"] = Name(f"/{_widget_on(widget, on)}") if value else Name.Off
    elif kind == "radio":
        node["/V"] = Name(f"/{value}") if value else Name.Off
        for widget in ref.widgets:
            states = on_states(widget)
            widget["/AS"] = Name(f"/{value}") if value and value in states else Name.Off
    elif kind == "dropdown":
        _set(node, "/V", text_string(value[0]) if value else None)
    elif kind == "listbox":
        if value is None or value == []:
            _set(node, "/V", None)
        elif ref.flags & FF_MULTISELECT:
            node["/V"] = Array([text_string(v) for v in value])
        else:
            node["/V"] = text_string(value[0])


def _set(node: Dictionary, key: str, value: Any) -> None:
    if value is None:
        if key in node:
            del node[key]
    else:
        node[key] = value


def _on_name(ref: FieldRef) -> str:
    for widget in ref.widgets:
        states = on_states(widget)
        if states:
            return states[0]
    return ON_DEFAULT


def _widget_on(widget: Dictionary, default: str) -> str:
    states = on_states(widget)
    return states[0] if states else default


def _set_da_font(node: Dictionary, name: str) -> None:
    """Point the field's /DA at the embedded font (size and colour are kept)."""
    da = da_of(node)
    if re.search(r"/[^\s/]+\s+[\d.]+\s+Tf", da):
        new = re.sub(r"/[^\s/]+(\s+[\d.]+\s+Tf)", lambda m: f"/{name}{m.group(1)}", da, count=1)
    else:
        new = f"/{name} 0 Tf 0 g"
    node["/DA"] = pikepdf.String(new)


def register_font(fd: FormDoc, handle: Any) -> str:
    """Add an embedded font to the AcroForm /DR so that viewers can find it by name."""
    acro = ensure_acroform(fd.pdf)
    if "/DR" not in acro or not isinstance(acro["/DR"], Dictionary):
        acro["/DR"] = Dictionary(Font=Dictionary())
    dr = acro["/DR"]
    if "/Font" not in dr or not isinstance(dr["/Font"], Dictionary):
        dr["/Font"] = Dictionary()
    name = font_resource(handle)
    dr["/Font"][f"/{name}"] = handle.obj
    return name


def ensure_acroform(pdf: pikepdf.Pdf) -> Dictionary:
    acro = pdf.Root.get("/AcroForm")
    if not isinstance(acro, Dictionary):
        acro = pdf.make_indirect(Dictionary(Fields=Array()))
        pdf.Root.AcroForm = acro
    if "/Fields" not in acro:
        acro["/Fields"] = Array()
    return acro


def draw(
    fd: FormDoc, ref: FieldRef, *, highlight: bool = False, on_hint: str | None = None
) -> None:
    """Build the appearance streams of every widget of ``ref`` from its current value."""
    kind = ref.kind
    if kind in ("button", "signature", "unknown"):
        return
    value = value_of(ref)
    for widget in ref.widgets:
        if kind in TEXT_KINDS or kind == "dropdown":
            text = "" if value is None else str(value)
            if kind == "dropdown":
                text = _display_of(ref, text)
            if kind == "password":
                text = "*" * len(text)
            look = look_of(ref, widget, highlight=highlight, empty=text == "")
            stream, handle = text_stream(
                fd.pdf,
                fd.doc,
                w=_w(widget),
                h=_h(widget),
                text=text,
                look=look,
                multiline=kind == "multiline",
            )
            widget["/AP"] = Dictionary(N=stream)
            _set_da_font(ref.node, register_font(fd, handle))
        elif kind == "listbox":
            selected = value if isinstance(value, list) else ([value] if value else [])
            rows = [(o["display"], o["export"] in selected) for o in options_of(ref)]
            look = look_of(ref, widget, highlight=highlight)
            stream, handle = list_stream(
                fd.pdf, fd.doc, w=_w(widget), h=_h(widget), rows=rows, look=look
            )
            widget["/AP"] = Dictionary(N=stream)
            _set_da_font(ref.node, register_font(fd, handle))
        elif kind == "checkbox":
            on = _widget_on(widget, on_hint or _on_name(ref))
            _mark_widget(fd, ref, widget, on, checked=bool(value), mark_default="4")
        elif kind == "radio":
            on = _widget_on(widget, on_hint or "Yes")
            checked = value is not None and value in on_states(widget)
            _mark_widget(fd, ref, widget, on, checked=checked, mark_default="l")


def _mark_widget(
    fd: FormDoc, ref: FieldRef, widget: Dictionary, on: str, *, checked: bool, mark_default: str
) -> None:
    look = look_of(ref, widget)
    mk = widget.get("/MK")
    if not (isinstance(mk, Dictionary) and "/CA" in mk):
        look = replace(look, mark=mark_default)
    w, h = _w(widget), _h(widget)
    widget["/AP"] = Dictionary(
        N=Dictionary(
            {
                f"/{on}": mark_stream(fd.pdf, w=w, h=h, look=look, on=True),
                "/Off": mark_stream(fd.pdf, w=w, h=h, look=look, on=False),
            }
        )
    )
    widget["/AS"] = Name(f"/{on}") if checked else Name.Off


def _display_of(ref: FieldRef, export: str) -> str:
    for option in options_of(ref):
        if option["export"] == export:
            return option["display"]
    return export


def _w(widget: Dictionary) -> float:
    rect = [float(v) for v in widget["/Rect"]]
    return abs(rect[2] - rect[0])


def _h(widget: Dictionary) -> float:
    rect = [float(v) for v in widget["/Rect"]]
    return abs(rect[3] - rect[1])


def refresh(fd: FormDoc, ref: FieldRef, *, highlight: bool = False) -> None:
    draw(fd, ref, highlight=highlight)


# -- fill, reset ------------------------------------------------------------------------


@dataclass
class FillResult:
    pages: set[int] = field(default_factory=set)
    applied: list[str] = field(default_factory=list)


def resolve(fd: FormDoc, names: Iterable[str]) -> dict[str, FieldRef]:
    by_name = {ref.name: ref for ref in fd.fields()}
    missing = sorted(n for n in names if n not in by_name)
    if missing:
        raise invalid_params("Unknown form field", {"fields": missing})
    return by_name


def fill(
    fd: FormDoc,
    values: dict[str, Any],
    *,
    force: bool = False,
    highlight: bool = False,
) -> FillResult:
    """Set several fields at once. All values are checked before the first write."""
    refs = resolve(fd, values.keys())
    plan = [(refs[name], normalize(refs[name], values[name], force=force)) for name in values]
    result = FillResult()
    for ref, value in plan:
        store(fd, ref, value)
        draw(fd, ref, highlight=highlight)
        result.applied.append(ref.name)
        result.pages.update(p for p in _pages(fd, ref) if p is not None)
    if highlight:
        for ref in fd.fields():
            if ref.required and not ref.read_only and ref.name not in values:
                draw(fd, ref, highlight=True)
    return result


def _pages(fd: FormDoc, ref: FieldRef) -> list[int | None]:
    return [fd.page_of(w) for w in ref.widgets]


def reset(fd: FormDoc, names: list[str] | None, pages: set[int] | None) -> FillResult:
    """Clear values (back to /DV when the field has one). Read-only fields are skipped."""
    result = FillResult()
    for ref in fd.fields():
        if names is not None and ref.name not in names:
            continue
        page_list = _pages(fd, ref)
        if pages is not None and not any(p in pages for p in page_list):
            continue
        if ref.read_only or ref.kind in ("button", "signature", "unknown"):
            continue
        default = attr(ref.node, "/DV")
        if default is not None and ref.kind in ("text", "multiline", "password", "comb"):
            ref.node["/V"] = default
        else:
            _clear(ref)
        draw(fd, ref)
        result.applied.append(ref.name)
        result.pages.update(p for p in page_list if p is not None)
    return result


def _clear(ref: FieldRef) -> None:
    _set(ref.node, "/V", None)
    if ref.kind == "checkbox":
        for widget in ref.widgets:
            widget["/AS"] = Name.Off
        ref.node["/V"] = Name.Off
    if ref.kind == "radio":
        ref.node["/V"] = Name.Off
        for widget in ref.widgets:
            widget["/AS"] = Name.Off


# -- create (H2) -----------------------------------------------------------------------


@dataclass(frozen=True)
class NewField:
    """A field to create. ``rect`` is [x0, top, x1, bottom] in the displayed frame (points)."""

    kind: str
    page: int
    rect: list[float]
    name: str
    label: str | None = None
    value: Any = None
    options: list[str] | None = None
    required: bool = False
    read_only: bool = False
    max_len: int | None = None
    font_size: float = 0.0
    text_colour: tuple[float, float, float] = (0.0, 0.0, 0.0)
    border_colour: tuple[float, float, float] | None = (0.0, 0.0, 0.0)
    border_width: float = 1.0
    background: tuple[float, float, float] | None = None
    alignment: int = 0
    export_value: str | None = None
    multi_select: bool = False


def validate_name(name: str) -> None:
    parts = name.split(".")
    if len(name) > 120 or any(not NAME_PART.match(p) for p in parts):
        raise invalid_params(
            "Field name must be dotted parts without spaces, e.g. hoten or nguoiky.ten",
            {"field": "name"},
        )


def user_rect(fd: FormDoc, page: int, rect: list[float]) -> list[float]:
    frame = fd.frame(page)
    _, height = frame.display_size
    x0, top, x1, bottom = rect
    if x1 <= x0 or bottom <= top:
        raise invalid_params("rect must be [x0, top, x1, bottom] with positive size")
    user = frame.rect_from_display((x0, height - bottom, x1, height - top))
    return [round(v, 4) for v in user]


def _widget_base(fd: FormDoc, page: int, rect: list[float]) -> Dictionary:
    page_obj = fd.pdf.pages[page].obj
    return Dictionary(
        Type=Name.Annot,
        Subtype=Name.Widget,
        Rect=Array(user_rect(fd, page, rect)),
        F=4,
        P=page_obj,
    )


def _style(node: Dictionary, widget: Dictionary, props: dict[str, Any]) -> None:
    """Apply appearance properties (MK, BS, DA, Q, TU, Ff) of a field or of an update."""
    mk = widget.get("/MK")
    mk = mk if isinstance(mk, Dictionary) else Dictionary()
    if "background" in props:
        colour = props["background"]
        mk["/BG"] = Array(list(colour)) if colour else Array()
    if "borderColour" in props:
        colour = props["borderColour"]
        mk["/BC"] = Array(list(colour)) if colour else Array()
    if "caption" in props and props["caption"] is not None:
        mk["/CA"] = text_string(props["caption"])
    if "exportMark" in props and props["exportMark"] is not None:
        mk["/CA"] = text_string(props["exportMark"])
    widget["/MK"] = mk
    if "borderWidth" in props:
        widget["/BS"] = Dictionary(W=float(props["borderWidth"]), S=Name.S)
    if "label" in props and props["label"] is not None:
        widget["/TU"] = text_string(props["label"])
    if "alignment" in props and props["alignment"] is not None:
        node["/Q"] = int(props["alignment"])
    if "maxLen" in props and props["maxLen"] is not None:
        node["/MaxLen"] = int(props["maxLen"])
    if "required" in props or "readOnly" in props:
        ff = flags_of(node)
        for key, bit in (("required", FF_REQUIRED), ("readOnly", FF_READONLY)):
            if key in props:
                ff = ff | bit if props[key] else ff & ~bit
        node["/Ff"] = ff
    if "fontSize" in props or "textColour" in props:
        size, colour = parse_da(da_of(node))
        if "fontSize" in props and props["fontSize"] is not None:
            size = float(props["fontSize"])
        if "textColour" in props and props["textColour"] is not None:
            colour = tuple(props["textColour"])
        r, g, b = colour
        node["/DA"] = pikepdf.String(
            f"/Helv {number(size)} Tf {number(r)} {number(g)} {number(b)} rg"
        )


def _ff_for(spec: NewField) -> int:
    ff = FF_REQUIRED if spec.required else 0
    if spec.read_only:
        ff |= FF_READONLY
    if spec.kind == "multiline":
        ff |= FF_MULTILINE
    if spec.kind == "comb":
        ff |= FF_COMB
    if spec.kind == "radio":
        ff |= FF_RADIO | FF_NOTOGGLE
    if spec.kind == "button":
        ff |= FF_PUSH
    if spec.kind == "dropdown":
        ff |= FF_COMBO
    if spec.kind == "listbox" and spec.multi_select:
        ff |= FF_MULTISELECT
    return ff


def _ft_for(kind: str) -> str:
    if kind in ("text", "multiline", "comb"):
        return "/Tx"
    if kind == "dropdown" or kind == "listbox":
        return "/Ch"
    return "/Btn"


def _props_of(spec: NewField) -> dict[str, Any]:
    return {
        "label": spec.label,
        "required": spec.required,
        "readOnly": spec.read_only,
        "maxLen": spec.max_len,
        "fontSize": spec.font_size,
        "textColour": spec.text_colour,
        "borderColour": spec.border_colour,
        "borderWidth": spec.border_width,
        "background": spec.background,
        "alignment": spec.alignment,
        "caption": spec.label if spec.kind == "button" else None,
        "exportMark": None,
    }


def add_field(fd: FormDoc, spec: NewField) -> FieldRef:
    """Create a field (and its widget) on a page. Returns the new field."""
    if spec.kind not in KINDS:
        raise invalid_params(f"Unknown field kind {spec.kind}", {"field": "kind"})
    if spec.kind == "signature":
        raise invalid_params("Signature fields are created by sign.addField", {"field": "kind"})
    if not 0 <= spec.page < len(fd.pdf.pages):
        raise invalid_params("Page is out of range", {"field": "pageIndex"})
    validate_name(spec.name)
    if spec.kind == "comb" and not spec.max_len:
        raise invalid_params("A comb field needs maxLen", {"field": "maxLen"})
    if spec.kind in ("dropdown", "listbox") and not spec.options:
        raise invalid_params("A choice field needs options", {"field": "options"})
    existing = {ref.name: ref for ref in fd.fields()}
    parts = spec.name.split(".")
    group = existing.get(spec.name)
    if group is not None and not (spec.kind == "radio" and group.kind == "radio"):
        raise invalid_params(f"A field named {spec.name} already exists", {"field": "name"})
    acro = ensure_acroform(fd.pdf)
    container = acro["/Fields"]
    parent: Dictionary | None = None
    for part in parts[:-1]:
        found = _child_named(container, part)
        if found is not None and "/Kids" not in found:
            raise invalid_params(f"{part} is a field, not a group", {"field": "name"})
        if found is None:
            found = fd.pdf.make_indirect(Dictionary(T=text_string(part), Kids=Array()))
            container.append(found)
        parent = found
        container = found["/Kids"]
    leaf = parts[-1]
    if group is None and parent is not None and _child_named(container, leaf) is not None:
        raise invalid_params(f"A field named {spec.name} already exists", {"field": "name"})
    if spec.kind == "radio":
        if group is None:
            group_node = fd.pdf.make_indirect(
                Dictionary(
                    T=text_string(leaf),
                    FT=Name.Btn,
                    Ff=_ff_for(spec),
                    Kids=Array(),
                )
            )
            container.append(group_node)
        else:
            group_node = group.node
        widget = fd.pdf.make_indirect(_widget_base(fd, spec.page, spec.rect))
        widget["/Parent"] = group_node
        group_node["/Kids"].append(widget)
        node = group_node
        widgets = [widget]
        export = spec.export_value or f"{RADIO_DEFAULT_PREFIX}{len(group_node['/Kids'])}"
        for other in group.widgets if group is not None else []:
            if export in on_states(other):
                raise invalid_params(
                    f"Export value {export} already used", {"field": "exportValue"}
                )
    else:
        widget = fd.pdf.make_indirect(_widget_base(fd, spec.page, spec.rect))
        widget["/T"] = text_string(leaf)
        widget["/FT"] = Name(_ft_for(spec.kind))
        widget["/Ff"] = _ff_for(spec)
        if spec.kind in ("dropdown", "listbox"):
            widget["/Opt"] = Array([text_string(o) for o in spec.options or []])
        node = widget
        widgets = [widget]
        export = spec.export_value or ON_DEFAULT
        container.append(widget)
        if parent is not None:
            widget["/Parent"] = parent
    _style(node, widgets[0], _props_of(spec))
    if spec.kind == "radio":
        widgets[0]["/MK"]["/CA"] = text_string("l")
    page_obj = fd.pdf.pages[spec.page].obj
    if "/Annots" not in page_obj:
        page_obj["/Annots"] = Array()
    page_obj["/Annots"].append(widgets[0])
    created = FieldRef(spec.name, leaf, node, widgets)
    if spec.kind in ("checkbox", "radio"):
        if spec.kind == "checkbox":
            node["/V"] = Name.Off
        draw(fd, created, on_hint=export)
    else:
        draw(fd, created)
    if spec.value is not None:
        store(fd, created, normalize(created, spec.value))
        draw(fd, created)
    return created


def _child_named(container: Any, name: str) -> Dictionary | None:
    for node in container:
        if isinstance(node, Dictionary) and "/T" in node and text_of(node["/T"]) == name:
            return node
    return None


# -- properties, rename, remove, tab order ----------------------------------------------


def update(fd: FormDoc, name: str, props: dict[str, Any]) -> FillResult:
    refs = resolve(fd, [name])
    ref = refs[name]
    result = FillResult(pages=set(p for p in _pages(fd, ref) if p is not None), applied=[name])
    if "options" in props and props["options"] is not None:
        if ref.kind not in ("dropdown", "listbox"):
            raise invalid_params("Only choice fields have options", {"field": name})
        ref.node["/Opt"] = Array([text_string(o) for o in props["options"]])
        ref = fd.find(name) or ref
    if "rect" in props and props["rect"] is not None:
        if len(ref.widgets) != 1:
            raise invalid_params("Only a single widget can be moved", {"field": name})
        page = _pages(fd, ref)[0]
        if page is None:
            raise invalid_params("The field has no page", {"field": name})
        ref.widgets[0]["/Rect"] = Array(user_rect(fd, page, props["rect"]))
    style = {k: v for k, v in props.items() if k not in ("options", "rect", "value")}
    for widget in ref.widgets:
        _style(ref.node, widget, style)
    ref = fd.find(name) or ref
    if "maxLen" in style and style["maxLen"] is not None and ref.kind in TEXT_KINDS:
        current = value_of(ref)
        if isinstance(current, str) and len(current) > int(style["maxLen"]):
            raise invalid_params("The current value is longer than maxLen", {"field": name})
    if props.get("value") is not None:
        store(fd, ref, normalize(ref, props["value"]))
    draw(fd, ref)
    return result


def rename(fd: FormDoc, name: str, new_partial: str) -> str:
    refs = resolve(fd, [name])
    ref = refs[name]
    if not NAME_PART.match(new_partial):
        raise invalid_params("A partial name cannot contain dots or spaces", {"field": "newName"})
    prefix = name.rsplit(".", 1)[0] if "." in name else ""
    new_full = f"{prefix}.{new_partial}" if prefix else new_partial
    if new_full != name and new_full in {r.name for r in fd.fields()}:
        raise invalid_params(f"A field named {new_full} already exists", {"field": "newName"})
    ref.node["/T"] = text_string(new_partial)
    return new_full


def remove(fd: FormDoc, names: list[str]) -> set[int]:
    refs = resolve(fd, names)
    pages: set[int] = set()
    for name in names:
        ref = refs[name]
        pages.update(p for p in _pages(fd, ref) if p is not None)
        for widget in ref.widgets:
            _remove_annot(fd, widget)
        _remove_node(fd, ref.node)
    return pages


def _same(a: Any, b: Any) -> bool:
    if a is b:
        return True
    ga, gb = objgen_of(a), objgen_of(b)
    return ga is not None and ga == gb


def _remove_annot(fd: FormDoc, widget: Dictionary) -> None:
    for page in fd.pdf.pages:
        annots = page.obj.get("/Annots")
        if annots is None:
            continue
        kept = [a for a in annots if not _same(a, widget)]
        if len(kept) != len(annots):
            page.obj["/Annots"] = Array(kept)


def _remove_node(fd: FormDoc, node: Dictionary) -> None:
    parent = node.get("/Parent")
    if isinstance(parent, Dictionary):
        kept = [k for k in parent.get("/Kids", []) if not _same(k, node)]
        parent["/Kids"] = Array(kept)
        if not kept:
            _remove_node(fd, parent)
        return
    acro = fd.acroform
    if acro is None:
        return
    acro["/Fields"] = Array([f for f in acro.get("/Fields", []) if not _same(f, node)])


def tab_order(fd: FormDoc, order: list[str]) -> set[int]:
    refs = resolve(fd, order)
    pages: set[int] = set()
    by_page: dict[int, list[Dictionary]] = {}
    for name in order:
        for widget in refs[name].widgets:
            index = fd.page_of(widget)
            if index is None:
                continue
            by_page.setdefault(index, []).append(widget)
    for index, widgets in by_page.items():
        page = fd.pdf.pages[index].obj
        annots = list(page.get("/Annots", []))
        listed = [a for a in annots if any(_same(a, w) for w in widgets)]
        ordered: list[Any] = []
        for w in widgets:
            for a in listed:
                if _same(a, w) and not any(_same(a, o) for o in ordered):
                    ordered.append(a)
        rest = [a for a in annots if not any(_same(a, o) for o in ordered)]
        page["/Annots"] = Array(ordered + rest)
        page["/Tabs"] = Name.S
        pages.add(index)
    return pages
