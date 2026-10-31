"""Overlay registry and removal (T4.01, F12): list and remove what Chef PDF added.

The page content is the source of truth. ``list_overlays`` scans the marked blocks of the pages
and ``remove_overlays`` strips them exactly: the tagged block (and its artifact wrapper) goes,
the source content inside the page wrap is untouched, the page wrap goes with the last overlay
of the page, and resource names that only the removed blocks used are deleted from the page.

The catalog entry ``/ChefPDF`` is a small index: ``/Overlays`` (one dictionary per overlay: Id,
Kind, Group, Pages at creation time, Label), and two caches of shared objects, ``/Fonts`` and
``/Images``. Cached objects that no page uses any more are dropped, and so are their bytes.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import pikepdf

from chef_core.overlay.markers import TAG_OVERLAY, TAG_WRAP, OverlayProps
from chef_core.overlay.pagecontent import content_bytes, inherited, own_resources, set_content

REGISTRY_KEY = "/ChefPDF"
CACHE_KEYS = ("Fonts", "Images")
RESOURCE_OPERATORS = {"Tf": "/Font", "Do": "/XObject", "gs": "/ExtGState"}


@dataclass(frozen=True)
class OverlayInfo:
    id: str
    kind: str
    group: str
    pages: list[int]
    label: str | None


@dataclass(frozen=True)
class RemoveResult:
    removed_ids: list[str] = field(default_factory=list)
    changed_pages: list[int] = field(default_factory=list)


# -- catalog index ----------------------------------------------------------------------


def registry_dict(pdf: pikepdf.Pdf, *, create: bool) -> pikepdf.Dictionary | None:
    """The ``/ChefPDF`` dictionary of the catalog, created on request."""
    reg = pdf.Root.get(REGISTRY_KEY)
    if not isinstance(reg, pikepdf.Dictionary):
        if not create:
            return None
        pdf.Root.ChefPDF = pikepdf.Dictionary(
            V=1,
            Overlays=pikepdf.Array(),
            Fonts=pikepdf.Dictionary(),
            Images=pikepdf.Dictionary(),
        )
        reg = pdf.Root.get(REGISTRY_KEY)
    assert isinstance(reg, pikepdf.Dictionary)
    for key in ("Overlays", *CACHE_KEYS):
        if f"/{key}" not in reg:
            reg[f"/{key}"] = pikepdf.Array() if key == "Overlays" else pikepdf.Dictionary()
    return reg


def cache_dict(pdf: pikepdf.Pdf, name: str) -> pikepdf.Dictionary:
    reg = registry_dict(pdf, create=True)
    assert reg is not None
    value = reg[f"/{name}"]
    assert isinstance(value, pikepdf.Dictionary)
    return value


def _text_string(value: str) -> pikepdf.String:
    if value.isascii():
        return pikepdf.String(value)
    return pikepdf.String(b"\xfe\xff" + value.encode("utf-16-be"))


def _read_text(value: pikepdf.Object) -> str:
    raw = bytes(value) if isinstance(value, pikepdf.String) else b""
    if raw.startswith(b"\xfe\xff"):
        return raw[2:].decode("utf-16-be", errors="replace")
    return raw.decode("utf-8", errors="replace") or str(value)


def append_entry(
    pdf: pikepdf.Pdf,
    *,
    overlay_id: str,
    kind: str,
    group: str,
    pages: list[int],
    label: str | None,
) -> None:
    reg = registry_dict(pdf, create=True)
    assert reg is not None
    entry = pikepdf.Dictionary(
        Id=pikepdf.String(overlay_id),
        Kind=pikepdf.String(kind),
        Group=pikepdf.String(group),
        Pages=pikepdf.Array(pages),
    )
    if label:
        entry.Label = _text_string(label)
    overlays = reg["/Overlays"]
    assert isinstance(overlays, pikepdf.Array)
    overlays.append(entry)


def _entries(pdf: pikepdf.Pdf) -> list[pikepdf.Dictionary]:
    reg = registry_dict(pdf, create=False)
    if reg is None or not isinstance(reg.get("/Overlays"), pikepdf.Array):
        return []
    return [e for e in reg["/Overlays"] if isinstance(e, pikepdf.Dictionary)]


# -- content scanning -------------------------------------------------------------------


def _op(ins: Any) -> str | None:
    if isinstance(ins, pikepdf.ContentStreamInstruction):
        return str(ins.operator)
    return None


def _overlay_props(ins: Any) -> OverlayProps | None:
    if _op(ins) != "BDC" or not ins.operands or str(ins.operands[0]) != f"/{TAG_OVERLAY}":
        return None
    return OverlayProps.from_dict(ins.operands[1])


def _is_artifact(ins: Any) -> bool:
    return _op(ins) == "BDC" and bool(ins.operands) and str(ins.operands[0]) == "/Artifact"


def _matching_end(instructions: list[Any], start: int) -> int | None:
    """Index of the EMC that closes the marked block opened at ``start``."""
    depth = 0
    for j in range(start, len(instructions)):
        op = _op(instructions[j])
        if op in ("BMC", "BDC"):
            depth += 1
        elif op == "EMC":
            depth -= 1
            if depth == 0:
                return j
    return None


def _instructions(page: pikepdf.Page) -> list[Any]:
    return list(pikepdf.parse_content_stream(page))


def _resource_names(instructions: list[Any]) -> dict[str, set[str]]:
    names: dict[str, set[str]] = {cat: set() for cat in RESOURCE_OPERATORS.values()}
    for ins in instructions:
        op = _op(ins)
        if op in RESOURCE_OPERATORS and ins.operands:
            names[RESOURCE_OPERATORS[op]].add(str(ins.operands[0]).lstrip("/"))
    return names


def list_overlays(pdf: pikepdf.Pdf) -> list[OverlayInfo]:
    """Overlays present in the content of the pages, in order of first appearance."""
    found: dict[str, dict[str, Any]] = {}
    for index, page in enumerate(pdf.pages):
        if f"/{TAG_OVERLAY}".encode() not in content_bytes(page):
            continue
        for ins in _instructions(page):
            props = _overlay_props(ins)
            if props is None:
                continue
            info = found.setdefault(
                props.overlay_id, {"kind": props.kind, "group": props.group, "pages": []}
            )
            if index not in info["pages"]:
                info["pages"].append(index)
    labels = {
        _entry_text(e, "Id"): _read_text(e["/Label"]) if "/Label" in e else None
        for e in _entries(pdf)
    }
    return [
        OverlayInfo(
            id=overlay_id,
            kind=info["kind"],
            group=info["group"],
            pages=info["pages"],
            label=labels.get(overlay_id),
        )
        for overlay_id, info in found.items()
    ]


def _entry_text(entry: pikepdf.Dictionary, key: str) -> str:
    value = entry.get(f"/{key}")
    return _read_text(value) if value is not None else ""


# -- removal ----------------------------------------------------------------------------


def _strip_blocks(
    instructions: list[Any], match: Callable[[OverlayProps], bool]
) -> tuple[list[Any], set[str]]:
    drop: set[int] = set()
    removed: set[str] = set()
    i = 0
    while i < len(instructions):
        props = _overlay_props(instructions[i])
        if props is None or not match(props):
            i += 1
            continue
        end = _matching_end(instructions, i)
        if end is None:
            i += 1
            continue
        start = i
        if i > 0 and _is_artifact(instructions[i - 1]):
            outer = _matching_end(instructions, i - 1)
            if outer is not None and outer == end + 1:
                start, end = i - 1, outer
        drop.update(range(start, end + 1))
        removed.add(props.overlay_id)
        i = end + 1
    kept = [ins for k, ins in enumerate(instructions) if k not in drop]
    return kept, removed


def _strip_wrap(instructions: list[Any]) -> list[Any]:
    """Remove the ``/ChefWrap BMC q ... Q EMC`` wrapper and keep the source content."""
    for w, ins in enumerate(instructions):
        if _op(ins) == "BMC" and ins.operands and str(ins.operands[0]) == f"/{TAG_WRAP}":
            end = _matching_end(instructions, w)
            if end is None:
                return instructions
            drop = {w, end}
            if (
                end - w >= 3
                and _op(instructions[w + 1]) == "q"
                and _op(instructions[end - 1]) == "Q"
            ):
                drop |= {w + 1, end - 1}
            return [x for k, x in enumerate(instructions) if k not in drop]
    return instructions


def remove_overlays(
    pdf: pikepdf.Pdf,
    *,
    ids: list[str] | None = None,
    group: str | None = None,
    kind: str | None = None,
) -> RemoveResult:
    """Remove every overlay block that matches all the given selectors (at least one is needed)."""
    wanted_ids = set(ids) if ids is not None else None

    def match(props: OverlayProps) -> bool:
        if wanted_ids is not None and props.overlay_id not in wanted_ids:
            return False
        if group is not None and props.group != group:
            return False
        return kind is None or props.kind == kind

    removed: list[str] = []
    changed: list[int] = []
    for index, page in enumerate(pdf.pages):
        if f"/{TAG_OVERLAY}".encode() not in content_bytes(page):
            continue
        before = _instructions(page)
        kept, found = _strip_blocks(before, match)
        if not found:
            continue
        if not any(_overlay_props(ins) is not None for ins in kept):
            kept = _strip_wrap(kept)
        for oid in sorted(found):
            if oid not in removed:
                removed.append(oid)
        names_before = _resource_names(before)
        names_after = _resource_names(kept)
        set_content(pdf, page, pikepdf.unparse_content_stream(kept))
        res = own_resources(page)
        for cat, names in names_before.items():
            if cat not in res:
                continue
            category_dict = res[cat]
            for name in names - names_after[cat]:
                if f"/{name}" in category_dict:
                    del category_dict[f"/{name}"]
        changed.append(index)
    if changed:
        live = {o.id for o in list_overlays(pdf)}
        reg = registry_dict(pdf, create=False)
        if reg is not None:
            reg["/Overlays"] = pikepdf.Array(
                [e for e in _entries(pdf) if _entry_text(e, "Id") in live]
            )
        prune_caches(pdf)
    return RemoveResult(removed_ids=removed, changed_pages=changed)


# -- caches -----------------------------------------------------------------------------


def _referenced(resources: pikepdf.Object | None, out: set[tuple[int, int]], depth: int) -> None:
    if not isinstance(resources, pikepdf.Dictionary) or depth > 8:
        return
    for key in list(resources.keys()):
        items = resources[key]
        if not isinstance(items, pikepdf.Dictionary):
            continue
        for value in items.values():
            if isinstance(value, pikepdf.Object) and value.objgen != (0, 0):
                out.add(value.objgen)
            if isinstance(value, pikepdf.Stream) and value.get("/Subtype") == "/Form":
                _referenced(value.get("/Resources"), out, depth + 1)


def prune_caches(pdf: pikepdf.Pdf) -> None:
    """Drop cached fonts and images that no page reaches, and the index when it is empty."""
    reg = registry_dict(pdf, create=False)
    if reg is None:
        return
    used: set[tuple[int, int]] = set()
    for page in pdf.pages:
        _referenced(inherited(page.obj, "/Resources"), used, 0)
    for name in CACHE_KEYS:
        cache = reg[f"/{name}"]
        assert isinstance(cache, pikepdf.Dictionary)
        for key in list(cache.keys()):
            value = cache[key]
            if not isinstance(value, pikepdf.Object) or value.objgen not in used:
                del cache[key]
    if not _entries(pdf) and not any(len(reg[f"/{name}"]) for name in CACHE_KEYS):
        del pdf.Root[REGISTRY_KEY]
