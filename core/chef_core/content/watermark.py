"""Finding watermarks, repeated objects and page backgrounds (T6.06, E3, E4, E5). Read-only.

``detect`` returns candidates in this order (tier first, then confidence):

1. marked content ``/Artifact`` with ``/Subtype /Watermark`` (also ``/Type /Pagination``)  (0.95)
2. optional-content groups whose name looks like a watermark                              (0.90)
3. annotations of subtype ``/Watermark``                                                  (0.90)
4. watermarks added by Chef PDF (``/ChefOverlay`` blocks of kind watermark)               (1.00)
   Chef watermarks also carry the ``/Artifact`` wrapper, but they are reported as tier 4: the
   overlay registry names them exactly, so the tier-1 rule never applies to them.
5. heuristics: an object (same text, same image bytes, same path) drawn at the same place,
   the same size, on at least 60% of the pages (at least 3). Confidence starts at 0.40 and
   adds 0.25 for rotated text, 0.25 for low opacity (ca/CA < 1) and 0.10 for covering at least
   15% of the page.

Forms are not skipped by tiers 1, 2 and 4: a watermark drawn as a Form XObject (``Do``) is
tagged around the ``Do``, so the form object itself carries the tag. Objects drawn by a form
inherit the tags around its ``Do`` (see ``content.engine``); such a child is classified by its
own tags only and is reported through the outermost page-level object that draws it (the form).
Tier 4 also comes from the overlay registry (``overlay.registry.list_overlays``), which reads the
page content directly, so it does not depend on what the engine models.

Nothing is removed here. ``repeated_objects`` and ``detect_backgrounds`` serve E4 and E5.
Candidates carry object ids of the current revision, so a removal can find the objects again.
"""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass, field
from typing import Any

import pikepdf
from pikepdf import Dictionary, Name

from chef_core.content.engine import build_model
from chef_core.content.erase import rect_display_from_user
from chef_core.content.layers import groups_of, layer_id, objgen_of
from chef_core.content.model import Ins, PageModel, PageObject, Rect, hex_of
from chef_core.overlay.markers import TAG_OVERLAY, OverlayProps
from chef_core.overlay.pagecontent import inherited, page_frame
from chef_core.overlay.registry import list_overlays
from chef_core.pdf.content import mul

LAYER_NAME = re.compile(r"watermark|dấu chìm|chìm|bản quyền|draft|confidential", re.IGNORECASE)
REPEAT_MIN_PAGES = 3
REPEAT_SHARE = 0.6
TIER_LABEL = {1: "artifact", 2: "layer", 3: "annotation", 4: "overlay", 5: "repeated"}


@dataclass
class Candidate:
    id: str
    tier: int
    confidence: float
    pages: list[int] = field(default_factory=list)
    objects: dict[int, list[str]] = field(default_factory=dict)  # page -> object ids
    bboxes: dict[int, list[list[float]]] = field(default_factory=dict)  # page -> display boxes
    annots: dict[int, list[int]] = field(default_factory=dict)  # page -> annotation indices
    layers: list[tuple[int, int]] = field(default_factory=list)
    overlays: list[str] = field(default_factory=list)
    text: str = ""
    evidence: list[str] = field(default_factory=list)

    @property
    def kind(self) -> str:
        return TIER_LABEL[self.tier]

    def to_json(self) -> dict[str, Any]:
        first = self.pages[0] if self.pages else None
        sample = None
        if first is not None:
            box = self.bboxes.get(first, [[0, 0, 0, 0]])[0]
            sample = {"pageIndex": first, "bbox": box}
        count = (
            sum(len(v) for v in self.objects.values())
            + sum(len(v) for v in self.annots.values())
            + len(self.layers)
            + len(self.overlays)
        )
        return {
            "id": self.id,
            "kind": self.kind,
            "source": self.kind,
            "tier": self.tier,
            "confidence": round(self.confidence, 3),
            "pages": self.pages,
            "count": count,
            "sample": sample,
            "description": describe(self),
            "evidence": self.evidence,
            "objectRefs": [
                {"pageIndex": p, "id": oid}
                for p, ids in sorted(self.objects.items())
                for oid in ids
            ],
            "annotRefs": [
                {"pageIndex": p, "index": i} for p, idx in sorted(self.annots.items()) for i in idx
            ],
            "layerIds": [layer_id(og) for og in self.layers],
            "overlayIds": list(self.overlays),
            "preview": [
                {"pageIndex": p, "bboxes": boxes} for p, boxes in sorted(self.bboxes.items())
            ],
        }


def describe(c: Candidate) -> dict[str, str]:
    n = len(c.pages)
    if c.tier == 1:
        return {
            "vi": "Watermark gắn nhãn chuẩn (Artifact/Watermark) trên " + str(n) + " trang",
            "en": "Tagged watermark (Artifact/Watermark) on " + str(n) + " page(s)",
        }
    if c.tier == 2:
        return {
            "vi": "Lớp có tên giống watermark: " + c.text,
            "en": "Layer with a watermark-like name: " + c.text,
        }
    if c.tier == 3:
        return {
            "vi": "Ghi chú kiểu Watermark trên " + str(n) + " trang",
            "en": "Watermark annotation on " + str(n) + " page(s)",
        }
    if c.tier == 4:
        return {
            "vi": "Watermark do Chef PDF thêm (đã gắn nhãn)",
            "en": "Watermark added by Chef PDF (tagged)",
        }
    return {
        "vi": "Lặp lại ở cùng vị trí trên " + str(n) + " trang: " + c.text,
        "en": "Repeated at the same place on " + str(n) + " page(s): " + c.text,
    }


# -- signatures ------------------------------------------------------------------------------


def image_digest(obj: PageObject, res: Any, cache: dict[str, str]) -> str:
    if obj.inline:
        return "inline:" + str(obj.pixel_size)
    name = obj.image_name or ""
    if name not in cache:
        table = res.get("/XObject") if isinstance(res, Dictionary) else None
        stream = table.get(name) if isinstance(table, Dictionary) else None
        if isinstance(stream, pikepdf.Stream):
            cache[name] = hashlib.sha1(stream.read_raw_bytes()).hexdigest()[:16]
        else:
            cache[name] = "missing"
    return cache[name]


def content_sig(obj: PageObject, res: Any, cache: dict[str, str]) -> tuple[Any, ...]:
    """What the object shows, without its place: text, image bytes, or path shape and colour."""
    if obj.kind == "text":
        return ("text", obj.string, obj.font_name, round(obj.font_size, 1))
    if obj.kind == "image":
        return ("image", image_digest(obj, res, cache))
    if obj.kind == "path":
        return ("path", hex_of(obj.fill_color), obj.fill, obj.stroke, obj.segments)
    return (obj.kind,)


def _centre(box: Rect) -> tuple[float, float]:
    return ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)


def _angle(m: tuple[float, ...]) -> float:
    return math.degrees(math.atan2(m[1], m[0]))


def _rotated(obj: PageObject) -> bool:
    angle = _angle(mul(obj.tm, obj.ctm) if obj.kind == "text" else obj.ctm)
    off = abs(angle) % 90
    return min(off, 90 - off) > 2.0


def _low_opacity(obj: PageObject) -> bool:
    return obj.fa < 0.999 or obj.sa < 0.999


def _page_area(model: PageModel) -> float:
    f = model.frame
    return max(1.0, (f.x1 - f.x0) * (f.y1 - f.y0))


def _text_of(obj: PageObject) -> str:
    if obj.kind == "text":
        return obj.string[:40]
    return {"image": "image", "path": "vector shape", "shading": "shading"}.get(obj.kind, obj.kind)


def _digest_id(tier: int, key: object) -> str:
    return f"{tier}-" + hashlib.sha1(repr(key).encode("utf-8")).hexdigest()[:10]


# -- detection -------------------------------------------------------------------------------


@dataclass
class _Group:
    tier: int
    key: object
    candidate: Candidate


def _group(groups: dict[object, _Group], tier: int, key: object) -> Candidate:
    entry = groups.get(key)
    if entry is None:
        cand = Candidate(id=_digest_id(tier, key), tier=tier, confidence=0.0)
        groups[key] = _Group(tier=tier, key=key, candidate=cand)
        return cand
    return entry.candidate


def _add_object(cand: Candidate, page: int, obj: PageObject, model: PageModel) -> None:
    if page not in cand.pages:
        cand.pages.append(page)
    ids = cand.objects.setdefault(page, [])
    if obj.id in ids:  # several children of one form stand for the same page object
        return
    ids.append(obj.id)
    cand.bboxes.setdefault(page, []).append(list(obj.display_bbox(model.frame)))


def _representative(model: PageModel, obj: PageObject) -> PageObject:
    """The page-level object that stands for ``obj``: itself, or the outermost form drawing it."""
    cur = obj
    for _ in range(64):
        if cur.in_page or cur.parent_id is None or cur.parent_id not in model.by_id:
            break
        cur = model.by_id[cur.parent_id]
    return cur


def _own_marks(model: PageModel, obj: PageObject) -> list[Ins]:
    """The marks that ``obj`` adds itself. The marks of its form (inherited) are left out: the
    form is the object that carries them."""
    if obj.in_page or obj.parent_id is None or obj.parent_id not in model.by_id:
        return obj.mark_ins
    parent = model.by_id[obj.parent_id]
    return obj.mark_ins[len(parent.mark_ins) :]


def _artifact_mark(marks: list[Ins]) -> bool:
    for mk in marks:
        if mk.op == "BDC" and mk.operands and str(mk.operands[0]) == "/Artifact":
            props = mk.operands[1] if len(mk.operands) > 1 else None
            if isinstance(props, Dictionary) and str(props.get("/Subtype", "")) == "/Watermark":
                return True
    return False


def _overlay_mark(marks: list[Ins]) -> OverlayProps | None:
    for mk in marks:
        if mk.op == "BDC" and mk.operands and str(mk.operands[0]) == f"/{TAG_OVERLAY}":
            props = OverlayProps.from_dict(mk.operands[1]) if len(mk.operands) > 1 else None
            if props is not None and props.kind == "watermark":
                return props
    return None


def _layer_of(page: pikepdf.Page, marks: list[Ins]) -> tuple[int, int] | None:
    for mk in marks:
        if mk.op == "BDC" and len(mk.operands) > 1 and str(mk.operands[0]) == "/OC":
            operand = mk.operands[1]
            if isinstance(operand, Name):
                table = inherited(page.obj, "/Resources")
                if isinstance(table, Dictionary) and isinstance(
                    table.get("/Properties"), Dictionary
                ):
                    return objgen_of(table["/Properties"].get(str(operand)))
    return None


def _annot_key(annot: Dictionary) -> tuple[Any, ...]:
    rect = [float(v) for v in annot.get("/Rect", [0, 0, 0, 0])]
    contents = str(annot.get("/Contents", ""))
    return (contents, round(rect[2] - rect[0]), round(rect[3] - rect[1]))


def detect(pdf: pikepdf.Pdf) -> list[Candidate]:
    groups: dict[object, _Group] = {}
    claimed: dict[int, set[str]] = {}  # page -> object ids already in tiers 1, 2, 4
    models: list[PageModel] = []
    layer_names = {objgen_of(g): str(g.get("/Name", "")) for g in groups_of(pdf)}
    n_pages = len(pdf.pages)
    for index, page in enumerate(pdf.pages):
        model = build_model(pdf, page, index)
        models.append(model)
        cache: dict[str, str] = {}
        for obj in model.objects:
            sig = content_sig(obj, model.res, cache)
            marks = _own_marks(model, obj)
            rep = _representative(model, obj)
            overlay = _overlay_mark(marks)
            if overlay is not None:
                cand = _group(groups, 4, ("overlay", overlay.overlay_id))
                if overlay.overlay_id not in cand.overlays:
                    cand.overlays.append(overlay.overlay_id)
                _add_object(cand, index, rep, model)
                claimed.setdefault(index, set()).add(rep.id)
                cand.confidence = 1.0
                cand.text = overlay.overlay_id
                continue
            if _artifact_mark(marks):
                cand = _group(groups, 1, ("artifact", sig))
                cand.confidence = 0.95
                cand.text = _text_of(obj)
                _add_object(cand, index, rep, model)
                claimed.setdefault(index, set()).add(rep.id)
                continue
            og = _layer_of(page, marks)
            if og is not None and og in layer_names and LAYER_NAME.search(layer_names[og]):
                cand = _group(groups, 2, ("layer", og))
                cand.confidence = 0.90
                cand.text = layer_names[og]
                if og not in cand.layers:
                    cand.layers.append(og)
                _add_object(cand, index, rep, model)
                claimed.setdefault(index, set()).add(rep.id)
        for ai, annot in enumerate(page.obj.get("/Annots") or []):
            if isinstance(annot, Dictionary) and str(annot.get("/Subtype", "")) == "/Watermark":
                cand = _group(groups, 3, ("annot", _annot_key(annot)))
                cand.confidence = 0.90
                cand.text = str(annot.get("/Contents", ""))[:40] or "annotation"
                if index not in cand.pages:
                    cand.pages.append(index)
                cand.annots.setdefault(index, []).append(ai)
                cand.bboxes.setdefault(index, []).append(_annot_display(model, annot))
    # tier 4 also comes from the registry: the page content is the source of truth (see module doc)
    for info in list_overlays(pdf):
        if info.kind != "watermark":
            continue
        cand = _group(groups, 4, ("overlay", info.id))
        cand.confidence = 1.0
        cand.text = info.id
        if info.id not in cand.overlays:
            cand.overlays.append(info.id)
        for page_index in info.pages:
            if page_index not in cand.pages:
                cand.pages.append(page_index)
    for cand_group in list(groups.values()):
        cand = cand_group.candidate
        cand.pages.sort()
        if cand.tier == 2 and cand.layers:
            cand.evidence = [f"layer name matches: {cand.text}"]
        elif cand.tier == 1:
            cand.evidence = ["marked content /Artifact /Subtype /Watermark"]
        elif cand.tier == 3:
            cand.evidence = ["annotation /Subtype /Watermark"]
        elif cand.tier == 4:
            cand.evidence = ["Chef PDF overlay registry: kind watermark"]
    result = [g.candidate for g in groups.values()]
    result.extend(_repeated(models, claimed, n_pages))
    result.sort(key=lambda c: (c.tier, -c.confidence, c.id))
    return result


def _annot_display(model: PageModel, annot: Dictionary) -> list[float]:
    raw = [float(v) for v in annot.get("/Rect", [0, 0, 0, 0])][:4]
    rect = (raw[0], raw[1], raw[2], raw[3])
    return list(rect_display_from_user(model.frame, rect))


def _repeated(
    models: list[PageModel], claimed: dict[int, set[str]], n_pages: int
) -> list[Candidate]:
    if n_pages < REPEAT_MIN_PAGES:
        return []
    need = max(REPEAT_MIN_PAGES, math.ceil(REPEAT_SHARE * n_pages))
    groups: dict[object, _Group] = {}
    for index, model in enumerate(models):
        cache: dict[str, str] = {}
        area = _page_area(model)
        for obj in model.objects:
            if not obj.in_page or obj.kind == "form" or obj.id in claimed.get(index, set()):
                continue
            if obj.kind not in ("text", "image", "path", "shading"):
                continue
            x0, y0, x1, y1 = obj.bbox
            cx, cy = _centre(obj.bbox)
            w, h = x1 - x0, y1 - y0
            key = (
                content_sig(obj, model.res, cache),
                round(cx / 2),
                round(cy / 2),
                round(w / 2),
                round(h / 2),
            )
            cand = _group(groups, 5, key)
            _add_object(cand, index, obj, model)
            if _rotated(obj):
                cand.evidence.append("rotated")
            if _low_opacity(obj):
                cand.evidence.append("low opacity")
            if w * h >= 0.15 * area:
                cand.evidence.append("large")
            cand.text = _text_of(obj)
    out: list[Candidate] = []
    for entry in groups.values():
        cand = entry.candidate
        if len(cand.pages) < need:
            continue
        cand.pages.sort()
        evidence = sorted(set(cand.evidence))
        score = 0.40
        score += 0.25 if "rotated" in evidence else 0.0
        score += 0.25 if "low opacity" in evidence else 0.0
        score += 0.10 if "large" in evidence else 0.0
        cand.confidence = min(0.9, score)
        cand.evidence = [f"repeated on {len(cand.pages)} of {n_pages} pages", *evidence]
        out.append(cand)
    return out


# -- backgrounds -----------------------------------------------------------------------------


@dataclass(frozen=True)
class BackgroundCandidate:
    page_index: int
    object_id: str
    kind: str
    bbox: list[float]  # display frame
    coverage: float
    fill: str | None


def detect_backgrounds(
    pdf: pikepdf.Pdf, pages: list[int] | None = None
) -> list[BackgroundCandidate]:
    """Full-page fills and images under all text (the background of a page), per page."""
    found: list[BackgroundCandidate] = []
    selected = set(pages) if pages is not None else None
    for index, page in enumerate(pdf.pages):
        if selected is not None and index not in selected:
            continue
        model = build_model(pdf, page, index)
        frame = page_frame(page)
        page_box: Rect = (frame.x0, frame.y0, frame.x1, frame.y1)
        area = _page_area(model)
        first_text = next((o.ordinal for o in model.objects if o.kind == "text"), None)
        for obj in model.objects:
            if not obj.in_page or obj.kind not in ("path", "image", "shading"):
                continue
            if obj.kind == "path" and not obj.fill:
                continue
            if first_text is not None and obj.ordinal > first_text:
                continue
            x0, y0 = max(obj.bbox[0], page_box[0]), max(obj.bbox[1], page_box[1])
            x1, y1 = min(obj.bbox[2], page_box[2]), min(obj.bbox[3], page_box[3])
            covered = max(0.0, x1 - x0) * max(0.0, y1 - y0)
            coverage = covered / area
            if coverage < 0.95:
                continue
            fill = hex_of(obj.fill_color) if obj.kind == "path" else None
            found.append(
                BackgroundCandidate(
                    page_index=index,
                    object_id=obj.id,
                    kind=obj.kind,
                    bbox=list(obj.display_bbox(model.frame)),
                    coverage=round(coverage, 4),
                    fill=fill,
                )
            )
    return found


# -- similar objects -------------------------------------------------------------------------


@dataclass(frozen=True)
class SimilarMatch:
    page_index: int
    object_id: str
    bbox: list[float]


def find_similar(
    pdf: pikepdf.Pdf,
    page_index: int,
    object_id: str,
    *,
    others_only: bool,
    tolerance_mm: float,
) -> tuple[PageObject, list[SimilarMatch]]:
    """Objects that look like ``object_id``: same content, centre and size within the tolerance,
    on every page (or, with ``others_only``, on the pages other than the source page). The source
    object itself is a match. Returns the source object of the current revision and the matches."""
    tol = tolerance_mm * 72 / 25.4
    source_page = build_model(pdf, pdf.pages[page_index], page_index)
    source = source_page.by_id.get(object_id)
    if source is None:
        raise KeyError(object_id)
    cache: dict[str, str] = {}
    src_sig = content_sig(source, source_page.res, cache)
    scx, scy = _centre(source.bbox)
    sw, sh = source.bbox[2] - source.bbox[0], source.bbox[3] - source.bbox[1]
    matches: list[SimilarMatch] = []
    for index, page in enumerate(pdf.pages):
        if others_only and index == page_index:
            continue
        model = source_page if index == page_index else build_model(pdf, page, index)
        page_cache: dict[str, str] = {}
        for obj in model.objects:
            if obj.kind == "form" or not obj.in_page:
                continue
            if obj.id == source.id and index == page_index:
                matches.append(SimilarMatch(index, obj.id, list(obj.display_bbox(model.frame))))
                continue
            if content_sig(obj, model.res, page_cache) != src_sig:
                continue
            cx, cy = _centre(obj.bbox)
            w, h = obj.bbox[2] - obj.bbox[0], obj.bbox[3] - obj.bbox[1]
            if abs(cx - scx) > tol or abs(cy - scy) > tol:
                continue
            if abs(w - sw) > tol or abs(h - sh) > tol:
                continue
            matches.append(SimilarMatch(index, obj.id, list(obj.display_bbox(model.frame))))
    return source, matches


__all__ = [
    "BackgroundCandidate",
    "Candidate",
    "SimilarMatch",
    "content_sig",
    "describe",
    "detect",
    "detect_backgrounds",
    "find_similar",
]
