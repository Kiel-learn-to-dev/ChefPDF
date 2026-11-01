"""Watermarks, repeated objects and page backgrounds (T6.06, E3, E4, E5).

- ``watermark.detect`` (read-only): ranked candidates (see ``chef_core.content.watermark``), each
  with confidence, evidence, pages, object/annotation/layer/overlay references and display boxes
  for a preview. Nothing is removed by detection.
- ``watermark.remove`` ({candidateIds | all, pages?}): removes the chosen candidates: objects
  (tiers 1 and 5), annotations (3), Chef overlays (4, ``overlay.remove``), optional-content groups
  (2, with their content). With ``pages`` the objects and annotations are limited to those pages;
  layers and overlays, which are document-wide, are only removed when all their pages are chosen.
- ``content.removeSimilar`` ({pageIndex, objectId, scope, toleranceMm, dryRun}, E4): the objects
  that look like one object (same content, centre and size within the tolerance). ``dryRun``
  (default) only lists them.
- ``background.detect`` (read-only, E5): full-page fills or images under all text, per page.
- ``background.remove`` ({mode: remove | replaceColor, color, pages?}): deletes the background, or
  paints it with ``color`` (a filled path is recoloured, an image is replaced by a rectangle).
"""

from __future__ import annotations

from collections import defaultdict
from typing import Literal

from pikepdf import Array
from pydantic import Field

from chef_core.content.editor import hex_colour, prepare
from chef_core.content.erase import paint_rects
from chef_core.content.layers import remove_layers
from chef_core.content.watermark import Candidate, detect, detect_backgrounds, find_similar
from chef_core.errors import invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.overlay.pagecontent import page_frame
from chef_core.overlay.registry import remove_overlays

_HEX = r"^#?[0-9a-fA-F]{6}$"


class WatermarkDetectParams(WireModel):
    """List the watermark candidates of the document (nothing is changed)."""


class WatermarkRemoveParams(WireModel):
    """Remove chosen watermark candidates (from watermark.detect)."""

    candidate_ids: list[str] | None = Field(default=None, description="Candidate ids to remove.")
    all: bool = Field(default=False, description="Remove every candidate.")
    pages: list[int] | None = Field(default=None, description="Limit to these 0-based pages.")


class ContentRemoveSimilarParams(WireModel):
    """Find or remove the objects that look like one object of a page."""

    page_index: int = Field(ge=0)
    object_id: str
    scope: Literal["all", "others"] = "all"
    tolerance_mm: float = Field(default=2.0, ge=0, le=20)
    dry_run: bool = Field(default=True, description="True lists the matches and changes nothing.")


class BackgroundDetectParams(WireModel):
    """Full-page backgrounds (filled rectangles or images under all text)."""

    pages: list[int] | None = None


class BackgroundRemoveParams(WireModel):
    """Remove or recolour the page backgrounds."""

    mode: Literal["remove", "replaceColor"] = "remove"
    color: str | None = Field(default=None, pattern=_HEX, description="#rrggbb for replaceColor.")
    pages: list[int] | None = None


def _candidate_json(cands: list[Candidate]) -> list[dict[str, object]]:
    return [c.to_json() for c in cands]


@operation(
    id="watermark.detect",
    title="Detect watermarks",
    group="watermark",
    params=WatermarkDetectParams,
)
def watermark_detect(ctx: OpContext, p: WatermarkDetectParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("watermark.detect needs a session")
    with ctx.open_input() as pdf:
        cands = detect(pdf)
        return OpOutput(
            changed_pages=[],
            data={"pageCount": len(pdf.pages), "candidates": _candidate_json(cands)},
        )


def _chosen(cands: list[Candidate], p: WatermarkRemoveParams) -> list[Candidate]:
    if p.all:
        return cands
    if not p.candidate_ids:
        raise invalid_params("NOTHING_SELECTED", {"hint": "give candidateIds or all"})
    known = {c.id: c for c in cands}
    missing = [i for i in p.candidate_ids if i not in known]
    if missing:
        raise invalid_params("UNKNOWN_CANDIDATE", {"ids": missing})
    return [known[i] for i in dict.fromkeys(p.candidate_ids)]


@operation(
    id="watermark.remove",
    title="Remove watermarks",
    group="watermark",
    params=WatermarkRemoveParams,
    destructive=True,
)
def watermark_remove(ctx: OpContext, p: WatermarkRemoveParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("watermark.remove needs a session")
    scope = set(p.pages) if p.pages is not None else None
    counts = {
        "removedObjects": 0,
        "removedAnnotations": 0,
        "removedOverlays": 0,
        "removedLayers": 0,
    }
    with ctx.open_input() as pdf:
        n_pages = len(pdf.pages)
        if scope is not None and any(i < 0 or i >= n_pages for i in scope):
            raise invalid_params("PAGE_OUT_OF_RANGE", {"pages": sorted(scope)})
        chosen = _chosen(detect(pdf), p)
        changed = False

        def on_scope(page: int) -> bool:
            return scope is None or page in scope

        per_page: dict[int, set[str]] = defaultdict(set)
        annots: dict[int, set[int]] = defaultdict(set)
        overlays: list[str] = []
        layers: list[tuple[int, int]] = []
        for c in chosen:
            if c.tier in (1, 5):
                for page, ids in c.objects.items():
                    if on_scope(page):
                        per_page[page].update(ids)
            elif c.tier == 3:
                for page, idx in c.annots.items():
                    if on_scope(page):
                        annots[page].update(idx)
            elif c.tier == 4 and all(on_scope(pg) for pg in c.pages):
                overlays.extend(c.overlays)
            elif c.tier == 2 and all(on_scope(pg) for pg in c.pages):
                layers.extend(c.layers)
        for page_index in sorted(per_page):
            editor, targets = prepare(
                pdf,
                pdf.pages[page_index],
                page_index,
                sorted(per_page[page_index]),
                flatten_forms=True,
            )
            editor.delete(targets)
            counts["removedObjects"] += len(targets)
            if editor.changed():
                editor.write()
                changed = True
        for page_index in sorted(annots):
            array = pdf.pages[page_index].obj.get("/Annots")
            if isinstance(array, Array) and annots[page_index]:
                kept = [a for i, a in enumerate(array) if i not in annots[page_index]]
                counts["removedAnnotations"] += len(array) - len(kept)
                pdf.pages[page_index].obj["/Annots"] = Array(kept)
                changed = True
        if overlays:
            result = remove_overlays(pdf, ids=sorted(set(overlays)))
            counts["removedOverlays"] = len(result.removed_ids)
            changed = changed or bool(result.removed_ids)
        if layers:
            remove_layers(pdf, sorted(set(layers)), delete_content=True)
            counts["removedLayers"] = len(set(layers))
            changed = True
        if changed:
            ctx.save_document(pdf)
    return OpOutput(changed_pages=[], data={**counts, "candidates": [c.id for c in chosen]})


@operation(
    id="content.removeSimilar",
    title="Remove similar objects",
    group="content",
    params=ContentRemoveSimilarParams,
    destructive=True,
)
def remove_similar(ctx: OpContext, p: ContentRemoveSimilarParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("content.removeSimilar needs a session")
    with ctx.open_input() as pdf:
        if p.page_index >= len(pdf.pages):
            raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": p.page_index})
        try:
            _source, matches = find_similar(
                pdf,
                p.page_index,
                p.object_id,
                others_only=p.scope == "others",
                tolerance_mm=p.tolerance_mm,
            )
        except KeyError as exc:
            raise invalid_params("OBJECT_NOT_FOUND", {"id": p.object_id}) from exc
        listed = [{"pageIndex": m.page_index, "id": m.object_id, "bbox": m.bbox} for m in matches]
        if p.dry_run:
            return OpOutput(
                changed_pages=[],
                data={"dryRun": True, "matches": listed, "removedObjects": 0},
            )
        per_page: dict[int, list[str]] = defaultdict(list)
        for m in matches:
            per_page[m.page_index].append(m.object_id)
        changed: list[int] = []
        removed = 0
        for page_index in sorted(per_page):
            editor, targets = prepare(
                pdf, pdf.pages[page_index], page_index, per_page[page_index], flatten_forms=True
            )
            editor.delete(targets)
            removed += len(targets)
            if editor.changed():
                editor.write()
                changed.append(page_index)
        if changed:
            ctx.save_document(pdf)
    return OpOutput(
        changed_pages=changed,
        data={"dryRun": False, "matches": listed, "removedObjects": removed},
    )


@operation(
    id="background.detect",
    title="Detect backgrounds",
    group="background",
    params=BackgroundDetectParams,
)
def background_detect(ctx: OpContext, p: BackgroundDetectParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("background.detect needs a session")
    with ctx.open_input() as pdf:
        found = detect_backgrounds(pdf, p.pages)
        data = [
            {
                "pageIndex": b.page_index,
                "id": b.object_id,
                "kind": b.kind,
                "bbox": b.bbox,
                "coverage": b.coverage,
                "fill": b.fill,
            }
            for b in found
        ]
    return OpOutput(changed_pages=[], data={"backgrounds": data})


@operation(
    id="background.remove",
    title="Remove or recolour backgrounds",
    group="background",
    params=BackgroundRemoveParams,
    destructive=True,
)
def background_remove(ctx: OpContext, p: BackgroundRemoveParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("background.remove needs a session")
    if p.mode == "replaceColor" and p.color is None:
        raise invalid_params("COLOUR_REQUIRED", {"mode": p.mode})
    colour = hex_colour(p.color or "#ffffff")
    rgb = (colour[2][0], colour[2][1], colour[2][2])
    changed: list[int] = []
    removed = 0
    with ctx.open_input() as pdf:
        found = detect_backgrounds(pdf, p.pages)
        per_page: dict[int, list[str]] = defaultdict(list)
        for b in found:
            per_page[b.page_index].append(b.object_id)
        for page_index in sorted(per_page):
            page = pdf.pages[page_index]
            editor, targets = prepare(
                pdf, page, page_index, per_page[page_index], flatten_forms=False
            )
            if p.mode == "remove":
                editor.delete(targets)
            else:
                paths = [t for t in targets if t.kind == "path"]
                others = [t for t in targets if t.kind != "path"]
                if paths:
                    editor.set_color(paths, colour, None)
                if others:
                    editor.delete(others)
                    frame = page_frame(page)
                    box = (frame.x0, frame.y0, frame.x1, frame.y1)
                    paint_rects(editor, [box], rgb, bottom=True)
            removed += len(targets)
            if editor.changed():
                editor.write()
                changed.append(page_index)
        if changed:
            ctx.save_document(pdf)
    return OpOutput(changed_pages=changed, data={"objects": removed, "mode": p.mode})


__all__ = [
    "BackgroundDetectParams",
    "BackgroundRemoveParams",
    "ContentRemoveSimilarParams",
    "WatermarkDetectParams",
    "WatermarkRemoveParams",
    "background_detect",
    "background_remove",
    "remove_similar",
    "watermark_detect",
    "watermark_remove",
]
