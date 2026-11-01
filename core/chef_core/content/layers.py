"""Optional content groups (layers) of a document (T6.05, E1).

The configuration is ``/OCProperties``: ``/OCGs`` (every group), ``/D`` (the default
configuration: ``/BaseState``, ``/ON``, ``/OFF``, ``/Order``, ``/Locked``).

- ``list_layers`` reads the groups with their default visibility, order, intent and usage, and
  how many page objects (and pages) use each one (page content only: a group used by an
  annotation or by a form XObject is listed but not counted).
- ``set_visibility`` changes the default configuration (``/ON`` and ``/OFF`` arrays).
- ``remove_layers`` removes the groups. With ``delete_content`` the marked content of the group is
  deleted; otherwise the content is kept and becomes plain content.
- ``flatten_layers`` makes all content visible: every optional-content block is unwrapped and the
  whole ``/OCProperties`` structure is removed.

Only the page content streams are rewritten. Marked content inside form XObjects is left as it is.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import pikepdf
from pikepdf import Array, Dictionary, Name

from chef_core.content.engine import build_model
from chef_core.errors import invalid_params
from chef_core.overlay.pagecontent import inherited, set_content

ObjGen = tuple[int, int]


def objgen_of(obj: Any) -> ObjGen | None:
    if isinstance(obj, pikepdf.Object) and obj.is_indirect:
        return obj.objgen
    return None


def layer_id(og: ObjGen) -> str:
    return f"{og[0]}:{og[1]}"


def parse_layer_id(value: str) -> ObjGen:
    try:
        num, gen = value.split(":", 1)
        return int(num), int(gen)
    except ValueError as exc:
        raise invalid_params("INVALID_LAYER_ID", {"id": value}) from exc


def props_of(pdf: pikepdf.Pdf) -> Dictionary | None:
    props = pdf.Root.get("/OCProperties")
    return props if isinstance(props, Dictionary) else None


def groups_of(pdf: pikepdf.Pdf) -> list[pikepdf.Object]:
    props = props_of(pdf)
    if props is None or not isinstance(props.get("/OCGs"), Array):
        return []
    return [g for g in props["/OCGs"] if isinstance(g, Dictionary)]


def default_config(pdf: pikepdf.Pdf) -> Dictionary:
    props = props_of(pdf)
    if props is None or not isinstance(props.get("/D"), Dictionary):
        raise invalid_params("NO_LAYERS", {"hint": "the document has no optional content"})
    config = props["/D"]
    assert isinstance(config, Dictionary)
    return config


def _group_set(array: Any) -> set[ObjGen]:
    out: set[ObjGen] = set()
    if isinstance(array, Array):
        for item in array:
            og = objgen_of(item)
            if og is not None:
                out.add(og)
    return out


def base_visible(config: Dictionary, og: ObjGen) -> bool:
    base = str(config.get("/BaseState", "/ON"))
    if base == "/OFF":
        return og in _group_set(config.get("/ON"))
    return og not in _group_set(config.get("/OFF"))


def _order(node: Any, out: list[dict[str, Any]]) -> None:
    if not isinstance(node, Array):
        return
    for item in node:
        og = objgen_of(item)
        if og is not None:
            out.append({"id": layer_id(og), "children": []})
        elif isinstance(item, Array):
            children: list[dict[str, Any]] = []
            _order(item, children)
            if out and out[-1].get("id") is None:
                out[-1]["children"].extend(children)
            else:
                out.append({"id": None, "label": None, "children": children})


def order_tree(config: Dictionary) -> list[dict[str, Any]]:
    tree: list[dict[str, Any]] = []
    _order(config.get("/Order"), tree)
    return tree


def _resolve_props(page: pikepdf.Page, operand: Any) -> ObjGen | None:
    if isinstance(operand, Name):
        table = inherited(page.obj, "/Resources")
        if isinstance(table, Dictionary) and isinstance(table.get("/Properties"), Dictionary):
            return objgen_of(table["/Properties"].get(str(operand)))
    return None


@dataclass
class Usage:
    objects: int = 0
    pages: set[int] = field(default_factory=set)


def usage_counts(pdf: pikepdf.Pdf) -> dict[ObjGen, Usage]:
    """How many page objects each group marks (BDC /OC blocks of the page content)."""
    counts: dict[ObjGen, Usage] = {}
    for index, page in enumerate(pdf.pages):
        model = build_model(pdf, page, index)
        for obj in model.objects:
            for mk in obj.mark_ins:
                if mk.op != "BDC" or len(mk.operands) < 2 or str(mk.operands[0]) != "/OC":
                    continue
                og = _resolve_props(page, mk.operands[1])
                if og is None:
                    continue
                usage = counts.setdefault(og, Usage())
                usage.objects += 1
                usage.pages.add(index)
    return counts


def list_layers(pdf: pikepdf.Pdf) -> dict[str, Any]:
    props = props_of(pdf)
    if props is None:
        return {"baseState": None, "layers": [], "order": []}
    config = props.get("/D") if isinstance(props.get("/D"), Dictionary) else Dictionary()
    assert isinstance(config, Dictionary)
    locked = _group_set(config.get("/Locked"))
    counts = usage_counts(pdf)
    layers: list[dict[str, Any]] = []
    for group in groups_of(pdf):
        og = objgen_of(group)
        if og is None:
            continue
        intent = group.get("/Intent")
        if isinstance(intent, Array):
            intents = [str(i).lstrip("/") for i in intent]
        else:
            intents = [str(intent).lstrip("/")] if intent is not None else ["View"]
        usage = group.get("/Usage")
        categories = [str(k).lstrip("/") for k in usage] if isinstance(usage, Dictionary) else []
        use = counts.get(og, Usage())
        layers.append(
            {
                "id": layer_id(og),
                "name": str(group.get("/Name", "")),
                "intent": intents,
                "usage": categories,
                "visible": base_visible(config, og),
                "locked": og in locked,
                "objectCount": use.objects,
                "pageCount": len(use.pages),
                "pages": sorted(use.pages),
            }
        )
    return {
        "baseState": str(config.get("/BaseState", "/ON")).lstrip("/"),
        "layers": layers,
        "order": order_tree(config),
    }


def set_visibility(pdf: pikepdf.Pdf, groups: list[ObjGen], visible: bool) -> list[str]:
    """Change the default visibility of the groups. Returns the ids that were named."""
    config = default_config(pdf)
    known = {objgen_of(g) for g in groups_of(pdf)}
    base_off = str(config.get("/BaseState", "/ON")) == "/OFF"
    for og in groups:
        if og not in known:
            raise invalid_params("LAYER_NOT_FOUND", {"id": layer_id(og)})
    on = [o for o in (config.get("/ON") or []) if objgen_of(o) not in groups]
    off = [o for o in (config.get("/OFF") or []) if objgen_of(o) not in groups]
    by_og = {objgen_of(g): g for g in groups_of(pdf)}
    for og in groups:
        if visible and base_off:
            on.append(by_og[og])
        if not visible and not base_off:
            off.append(by_og[og])
    config["/ON"] = Array(on)
    config["/OFF"] = Array(off)
    return [layer_id(og) for og in groups]


_BLOCK_OPS = ("BDC", "BMC")


def rewrite_page(
    pdf: pikepdf.Pdf, page: pikepdf.Page, *, targets: set[ObjGen] | None, delete: bool
) -> bool:
    """Unwrap (or delete with ``delete``) the optional-content blocks of a page.

    ``targets`` None selects every /OC block. Returns True when the content changed."""
    instructions = list(pikepdf.parse_content_stream(page))
    out: list[Any] = []
    stack: list[str] = []  # 'drop' | 'unwrap' | 'keep'
    changed = False
    for ins in instructions:
        op = str(ins.operator)
        if op in _BLOCK_OPS:
            if "drop" in stack:
                stack.append("drop")
                changed = True
                continue
            selected = False
            if op == "BDC" and len(ins.operands) >= 2 and str(ins.operands[0]) == "/OC":
                og = _resolve_props(page, ins.operands[1])
                selected = targets is None or (og is not None and og in targets)
            if selected:
                stack.append("drop" if delete else "unwrap")
                changed = True
                continue
            stack.append("keep")
            out.append(ins)
            continue
        if op == "EMC":
            kind = stack.pop() if stack else "keep"
            if kind == "keep":
                out.append(ins)
            continue
        if "drop" in stack:
            changed = True
            continue
        out.append(ins)
    if changed:
        set_content(pdf, page, pikepdf.unparse_content_stream(out))
    return changed


def _prune_refs(array: Any, drop: set[ObjGen]) -> Array:
    kept: list[Any] = []
    for item in array:
        if isinstance(item, Array):
            kept.append(_prune_refs(item, drop))
            continue
        if objgen_of(item) in drop:
            continue
        kept.append(item)
    return Array(kept)


def _drop_groups(pdf: pikepdf.Pdf, drop: set[ObjGen]) -> None:
    props = props_of(pdf)
    if props is None:
        return
    if isinstance(props.get("/OCGs"), Array):
        props["/OCGs"] = Array([g for g in props["/OCGs"] if objgen_of(g) not in drop])
    config = props.get("/D")
    if isinstance(config, Dictionary):
        for key in ("/ON", "/OFF", "/Locked"):
            if isinstance(config.get(key), Array):
                config[key] = _prune_refs(config[key], drop)
        if isinstance(config.get("/Order"), Array):
            config["/Order"] = _prune_refs(config["/Order"], drop)


def remove_layers(
    pdf: pikepdf.Pdf, groups: list[ObjGen], *, delete_content: bool
) -> dict[str, int]:
    """Remove groups. Returns the number of pages whose content changed."""
    known = {objgen_of(g) for g in groups_of(pdf)}
    for og in groups:
        if og not in known:
            raise invalid_params("LAYER_NOT_FOUND", {"id": layer_id(og)})
    target = set(groups)
    pages = 0
    for page in pdf.pages:
        if rewrite_page(pdf, page, targets=target, delete=delete_content):
            pages += 1
    _drop_groups(pdf, target)
    if not groups_of(pdf) and props_of(pdf) is not None:
        del pdf.Root["/OCProperties"]
    return {"pages": pages, "groups": len(groups)}


def flatten_layers(pdf: pikepdf.Pdf) -> dict[str, int]:
    """Unwrap every optional-content block and remove the optional-content structure."""
    if props_of(pdf) is None:
        return {"pages": 0, "groups": 0}
    groups = len(groups_of(pdf))
    pages = 0
    for page in pdf.pages:
        if rewrite_page(pdf, page, targets=None, delete=False):
            pages += 1
        annots = page.obj.get("/Annots")
        if isinstance(annots, Array):
            for annot in annots:
                if isinstance(annot, Dictionary) and "/OC" in annot:
                    del annot["/OC"]
    del pdf.Root["/OCProperties"]
    return {"pages": pages, "groups": groups}


__all__ = [
    "ObjGen",
    "base_visible",
    "default_config",
    "flatten_layers",
    "groups_of",
    "layer_id",
    "list_layers",
    "order_tree",
    "parse_layer_id",
    "remove_layers",
    "set_visibility",
    "usage_counts",
]
