"""Layers and content views (T6.05, E1, E2).

- ``layers.list`` (read-only): optional-content groups with default visibility, locked flag,
  intent, usage, the number of page objects and pages that use each one, and the order tree.
- ``layers.setVisibility`` ({layerIds, visible}): changes the default configuration (undoable).
- ``layers.remove`` ({layerIds, deleteContent}): removes groups. ``deleteContent`` deletes their
  marked content too; otherwise the content stays and becomes plain content.
- ``layers.flatten``: makes all content visible and removes the optional-content structure.
- ``content.viewByType`` (read-only, E2): objects of one page grouped by kind (text, image, path,
  shading, form) with counts and display boxes, and render hints for a kind filter: ``showIds``
  (objects drawn) and ``hideIds`` (objects to hide). ``solo`` only tells the UI to show ``showIds``
  alone.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import Field

from chef_core.content.engine import build_model
from chef_core.content.layers import (
    flatten_layers,
    list_layers,
    parse_layer_id,
    remove_layers,
    set_visibility,
)
from chef_core.errors import invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation

Kind = Literal["text", "image", "path", "shading", "form"]


class LayersListParams(WireModel):
    """List the optional-content groups (layers) of the document."""


class LayersVisibilityParams(WireModel):
    """Make layers visible or hidden by default."""

    layer_ids: list[str] = Field(min_length=1, description="Layer ids from layers.list.")
    visible: bool


class LayersRemoveParams(WireModel):
    """Remove layers. With deleteContent the content of the layers is deleted too."""

    layer_ids: list[str] = Field(min_length=1, description="Layer ids from layers.list.")
    delete_content: bool = Field(
        default=False,
        description="True deletes the marked content; False keeps it as plain content.",
    )


class LayersFlattenParams(WireModel):
    """Make all content visible and remove the layer structure."""


@operation(id="layers.list", title="List layers", group="layers", params=LayersListParams)
def layers_list(ctx: OpContext, p: LayersListParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("layers.list needs a session")
    with ctx.open_input() as pdf:
        return OpOutput(changed_pages=[], data=list_layers(pdf))


@operation(
    id="layers.setVisibility",
    title="Set layer visibility",
    group="layers",
    params=LayersVisibilityParams,
    destructive=True,
)
def layers_set_visibility(ctx: OpContext, p: LayersVisibilityParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("layers.setVisibility needs a session")
    groups = [parse_layer_id(v) for v in p.layer_ids]
    with ctx.open_input() as pdf:
        ids = set_visibility(pdf, groups, p.visible)
        ctx.save_document(pdf)
    return OpOutput(changed_pages=[], data={"layerIds": ids, "visible": p.visible})


@operation(
    id="layers.remove",
    title="Remove layers",
    group="layers",
    params=LayersRemoveParams,
    destructive=True,
)
def layers_remove(ctx: OpContext, p: LayersRemoveParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("layers.remove needs a session")
    groups = [parse_layer_id(v) for v in p.layer_ids]
    with ctx.open_input() as pdf:
        result = remove_layers(pdf, groups, delete_content=p.delete_content)
        ctx.save_document(pdf)
    return OpOutput(
        changed_pages=[],
        data={"removedLayers": result["groups"], "pagesChanged": result["pages"]},
    )


@operation(
    id="layers.flatten",
    title="Flatten layers",
    group="layers",
    params=LayersFlattenParams,
    destructive=True,
)
def layers_flatten(ctx: OpContext, p: LayersFlattenParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("layers.flatten needs a session")
    with ctx.open_input() as pdf:
        result = flatten_layers(pdf)
        ctx.save_document(pdf)
    return OpOutput(
        changed_pages=[],
        data={"removedLayers": result["groups"], "pagesChanged": result["pages"]},
    )


class ContentViewByTypeParams(WireModel):
    """Objects of one page grouped by kind, with render hints for a kind filter."""

    page_index: int = Field(ge=0, description="0-based page.")
    kinds: list[Kind] | None = Field(default=None, description="Kinds to show (None: all).")
    solo: bool = Field(default=False, description="Show only the kinds in kinds.")


def _kind_summary(objs: list[dict[str, Any]]) -> dict[str, Any]:
    by_kind: dict[str, dict[str, Any]] = {}
    for o in objs:
        entry = by_kind.setdefault(o["kind"], {"count": 0, "bboxes": [], "ids": []})
        entry["count"] += 1
        entry["bboxes"].append(o["bbox"])
        entry["ids"].append(o["id"])
    return by_kind


@operation(
    id="content.viewByType",
    title="View objects by type",
    group="content",
    params=ContentViewByTypeParams,
)
def view_by_type(ctx: OpContext, p: ContentViewByTypeParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("content.viewByType needs a session")
    with ctx.open_input() as pdf:
        if p.page_index >= len(pdf.pages):
            raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": p.page_index})
        model = build_model(pdf, pdf.pages[p.page_index], p.page_index)
        objs = model.to_json()
        wanted = set(p.kinds) if p.kinds is not None else None
        show = [o for o in objs if wanted is None or o["kind"] in wanted]
        hide = [o for o in objs if wanted is not None and o["kind"] not in wanted]
        display_w, display_h = model.frame.display_size
        return OpOutput(
            changed_pages=[],
            data={
                "pageIndex": p.page_index,
                "displayWidth": display_w,
                "displayHeight": display_h,
                "kinds": _kind_summary(objs),
                "renderHint": {
                    "solo": bool(p.solo and wanted is not None),
                    "showIds": [o["id"] for o in show],
                    "hideIds": [o["id"] for o in hide],
                },
            },
        )


__all__ = [
    "LayersFlattenParams",
    "LayersListParams",
    "LayersRemoveParams",
    "LayersVisibilityParams",
    "layers_flatten",
    "layers_list",
    "layers_remove",
    "layers_set_visibility",
    "view_by_type",
]
