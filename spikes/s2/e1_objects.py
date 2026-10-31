"""S2-1: enumerate page objects with PDFium, hit-test, move/scale/delete, regenerate content.

Also checks what FPDFPage_GenerateContent preserves (marked content, ExtGState alpha,
Form XObjects, untouched pages) and whether the old content stream survives the save.
"""

from __future__ import annotations

import ctypes
import hashlib
import json
import time
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium
import pypdfium2.raw as pr

from common.render import render_page

from .common import CORPUS, OUT, fill_alpha, marks_of, obj_type, page_text, pikepdf_gc, rotation_deg, text_of


def walk(page):
    """Yield (obj, parent_matrix) where parent_matrix maps the object's space to page space."""
    stack: list[tuple[int, pdfium.PdfMatrix]] = []
    for obj in page.get_objects(max_depth=4):
        while stack and stack[-1][0] >= obj.level:
            stack.pop()
        parent = stack[-1][1] if stack else pdfium.PdfMatrix()
        yield obj, parent
        if obj.type == pr.FPDF_PAGEOBJ_FORM:
            stack.append((obj.level, obj.get_matrix().multiply(parent)))


def page_quad(obj, parent: pdfium.PdfMatrix):
    try:
        q = obj.get_quad_points()  # rotated bounds (text, image)
    except Exception:  # noqa: BLE001 - paths/forms: axis-aligned bounds
        l, b, r, t = obj.get_bounds()
        q = ((l, b), (r, b), (r, t), (l, t))
    return [parent.on_point(x, y) for x, y in q]


def in_quad(pt, quad) -> bool:
    # point-in-convex-polygon (consistent cross product sign)
    x, y = pt
    sign = 0
    for i in range(4):
        (x1, y1), (x2, y2) = quad[i], quad[(i + 1) % 4]
        c = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)
        if c != 0:
            s = 1 if c > 0 else -1
            if sign and s != sign:
                return False
            sign = s
    return True


def near_stroke(obj, parent, x, y, tol=3.0) -> bool:
    """For stroke-only paths: is (x, y) within tol of a straight segment? (Beziers are
    approximated by their end points, good enough for a spike.)"""
    m = obj.get_matrix().multiply(parent)
    pts, start = [], None
    for i in range(pr.FPDFPath_CountSegments(obj)):
        seg = pr.FPDFPath_GetPathSegment(obj, i)
        px, py = ctypes.c_float(), ctypes.c_float()
        pr.FPDFPathSegment_GetPoint(seg, px, py)
        p = m.on_point(px.value, py.value)
        if pr.FPDFPathSegment_GetType(seg) == pr.FPDF_SEGMENT_MOVETO:
            start = p
        elif pts:
            yield_seg = (pts[-1], p)
            if _dist_seg((x, y), *yield_seg) <= tol:
                return True
        pts.append(p)
        if pr.FPDFPathSegment_GetClose(seg) and start and _dist_seg((x, y), p, start) <= tol:
            return True
    return False


def _dist_seg(p, a, b) -> float:
    (px, py), (ax, ay), (bx, by) = p, a, b
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return ((px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2) ** 0.5


def is_stroke_only(obj) -> bool:
    fill, stroke = ctypes.c_int(), ctypes.c_int()
    pr.FPDFPath_GetDrawMode(obj, fill, stroke)
    return fill.value == pr.FPDF_FILLMODE_NONE and bool(stroke.value)


def hit_test(page, x, y, *, rotated=True):
    """Topmost object under (x, y). Later objects paint on top -> iterate and keep last."""
    hit = None
    for obj, parent in walk(page):
        if obj.type == pr.FPDF_PAGEOBJ_FORM:
            continue  # prefer the leaf objects inside forms
        if obj.type == pr.FPDF_PAGEOBJ_PATH and is_stroke_only(obj):
            if near_stroke(obj, parent, x, y):
                hit = obj
            continue
        if rotated:
            ok = in_quad((x, y), page_quad(obj, parent))
        else:
            l, b, r, t = obj.get_bounds()
            (l, b), (r, t) = parent.on_point(l, b), parent.on_point(r, t)
            ok = l <= x <= r and b <= y <= t
        if ok:
            hit = obj
    return hit


def describe(obj, tp) -> dict:
    d = {"type": obj_type(obj), "level": obj.level,
         "bounds": [round(v, 1) for v in obj.get_bounds()],
         "matrix": [round(v, 3) for v in obj.get_matrix().get()],
         "rotation": rotation_deg(obj), "fill_alpha": fill_alpha(obj), "marks": marks_of(obj)}
    if obj.type == pr.FPDF_PAGEOBJ_TEXT:
        d["text"] = text_of(obj, tp)
        font = obj.get_font()  # get_objects() already yields PdfTextObj / PdfImage
        d["font"] = font.get_base_name()
        d["font_embedded"] = font.is_embedded
        d["font_size"] = round(obj.get_font_size(), 2)
    if obj.type == pr.FPDF_PAGEOBJ_IMAGE:
        d["px_size"] = obj.get_px_size()
        d["filters"] = obj.get_filters()
        d["raw_sha1"] = hashlib.sha1(bytes(obj.get_data(decode_simple=False))).hexdigest()[:12]
    if obj.type == pr.FPDF_PAGEOBJ_PATH:
        d["segments"] = pr.FPDFPath_CountSegments(obj)
    return d


def content_hashes(path: Path) -> list[str]:
    with pikepdf.open(path) as p:
        out = []
        for pg in p.pages:
            data = b"".join(cs.read_bytes() for cs in (
                pg.Contents if isinstance(pg.Contents, pikepdf.Array) else [pg.Contents]))
            out.append(hashlib.sha1(data).hexdigest()[:12])
        return out


def bdc_tags(path: Path, page_index: int) -> list[str]:
    with pikepdf.open(path) as p:
        pg = p.pages[page_index]
        tags = []
        for operands, op in pikepdf.parse_content_stream(pg):
            if str(op) == "BDC":
                tags.append(f"{operands[0]} {dict(operands[1]) if isinstance(operands[1], pikepdf.Dictionary) else operands[1]}")
        return tags


def all_stream_count(path: Path) -> int:
    with pikepdf.open(path) as p:
        return sum(1 for o in p.objects if isinstance(o, pikepdf.Stream))


def main() -> None:
    res: dict = {}
    doc = pdfium.PdfDocument(str(CORPUS))
    page = doc[0]
    tp = page.get_textpage()
    t = time.perf_counter()
    objs = [describe(o, tp) for o, _ in walk(page)]
    res["enumerate_ms"] = round((time.perf_counter() - t) * 1000, 1)
    res["object_count"] = len(objs)
    res["by_type"] = {k: sum(1 for o in objs if o["type"] == k) for k in {o["type"] for o in objs}}
    res["sample_objects"] = [o for o in objs if o["type"] != "text"] + [o for o in objs if o["type"] == "text"][:4] \
        + [o for o in objs if o["type"] == "text" and (o["rotation"] or o["marks"] or o["level"])]

    # Hit tests
    probes = {
        "header line (200,767)": (200, 767),
        "watermark centre (297,421)": (297, 421),
        "inside watermark AABB but outside its rotated quad (120,600)": (120, 600),
        "CID line in Form XObject (150,738)": (150, 738),
        "logo (60,770)": (60, 770),
        "empty margin (15,15)": (15, 15),
    }
    res["hit_tests"] = {}
    for name, (x, y) in probes.items():
        for rotated in (True, False):
            h = hit_test(page, x, y, rotated=rotated)
            res["hit_tests"][f"{name} [{'quad' if rotated else 'aabb'}]"] = (
                None if h is None else f"{obj_type(h)} L{h.level}: {text_of(h, tp)[:40] if h.type == pr.FPDF_PAGEOBJ_TEXT else ''}")
    tp.close()

    # Edits on page 1: move logo, scale circle, delete PII line.
    render_page(CORPUS, 0, OUT / "e1_before.png", scale=0.8)
    t = time.perf_counter()
    logo = hit_test(page, 60, 770)
    logo.transform(pdfium.PdfMatrix().translate(380, -40))
    circle = hit_test(page, 515, 782)
    l, b, r, tt = circle.get_bounds()
    cx, cy = (l + r) / 2, (b + tt) / 2
    circle.transform(pdfium.PdfMatrix().translate(-cx, -cy).scale(1.8, 1.8).translate(cx - 420, cy - 10))
    pii = hit_test(page, 100, 720)
    page.remove_obj(pii)
    ok = pr.FPDFPage_GenerateContent(page)
    res["edit_and_generate_ms"] = round((time.perf_counter() - t) * 1000, 1)
    res["generate_content_ok"] = bool(ok)
    edited = OUT / "e1_edited_pdfium.pdf"
    doc.save(str(edited))
    del logo, circle, pii, page  # drop child wrappers before closing their document
    doc.close()
    render_page(edited, 0, OUT / "e1_after.png", scale=0.8)
    gc = OUT / "e1_edited_pdfium_gc.pdf"
    pikepdf_gc(edited, gc)

    # Integrity checks
    before_text, after_text = page_text(CORPUS), page_text(edited)
    truth = json.loads((OUT / "corpus_truth.json").read_text())
    res["checks"] = {
        "pii_text_gone_page1": truth["pii_line"] not in after_text[0],
        "pii_text_still_on_page2": truth["pii_line"] in after_text[1],
        "other_text_unchanged_page1": before_text[0].replace(truth["pii_line"], "").split() == after_text[0].split(),
        "content_hash_before": content_hashes(CORPUS),
        "content_hash_after": content_hashes(edited),
        "bdc_tags_before_p1": bdc_tags(CORPUS, 0),
        "bdc_tags_after_p1": bdc_tags(edited, 0),
        "streams_in_file_before": all_stream_count(CORPUS),
        "streams_in_file_after_pdfium_save": all_stream_count(edited),
        "streams_after_qpdf_rewrite": all_stream_count(gc),
        "size_before": CORPUS.stat().st_size,
        "size_after_pdfium": edited.stat().st_size,
        "size_after_qpdf": gc.stat().st_size,
    }
    # Did pdfium keep the *old* page-1 content stream as an orphan object?
    with pikepdf.open(CORPUS) as p:
        c = p.pages[0].Contents
        # page 1 has several content streams (reportlab + pyHanko stamp); the
        # largest one holds the deleted PII line.
        old = max((s.read_bytes() for s in (c if isinstance(c, pikepdf.Array) else [c])), key=len)
    with pikepdf.open(edited) as p:
        res["checks"]["old_content_stream_still_in_file_after_pdfium_save"] = any(
            isinstance(o, pikepdf.Stream) and o.read_bytes() == old for o in p.objects)
    with pikepdf.open(gc) as p:
        res["checks"]["old_content_stream_still_in_file_after_qpdf"] = any(
            isinstance(o, pikepdf.Stream) and o.read_bytes() == old for o in p.objects)
    (OUT / "e1_results.json").write_text(json.dumps(res, ensure_ascii=False, indent=2))
    print(json.dumps({k: v for k, v in res.items() if k != "sample_objects"}, ensure_ascii=False, indent=2))



if __name__ == "__main__":
    main()
