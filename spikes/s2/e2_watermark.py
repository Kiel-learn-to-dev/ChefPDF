"""S2-2: detect repeated watermark/logo across pages and remove it.

Detection layers (NOTES.md "Dò watermark"):
  1. tagged: marked content /Artifact with /Subtype /Watermark  -> pikepdf (PDFium can't read name values)
  2. OCG named "watermark" / 3. /Watermark annotations          -> not in corpus (trivial with pikepdf)
  4. heuristic: same object (same image data / same text+font+matrix) on most pages,
     boosted by rotation, transparency, size.
Removal A: PDFium (remove objects + FPDFPage_GenerateContent), then qpdf rewrite.
Removal B: pikepdf content-stream filter for the tagged watermark (byte-surgical).
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict

import pikepdf
import pypdfium2 as pdfium
import pypdfium2.raw as pr

from common.render import render_page

from .common import CORPUS, OUT, fill_alpha, marks_of, obj_type, page_text, rotation_deg, text_of
from .e1_objects import walk


def signature(obj, parent, tp) -> tuple:
    b = tuple(round(v) for v in parent.on_rect(*obj.get_bounds()))
    if obj.type == pr.FPDF_PAGEOBJ_IMAGE:
        return ("image", hashlib.sha1(bytes(obj.get_data(decode_simple=False))).hexdigest()[:12], b)
    if obj.type == pr.FPDF_PAGEOBJ_TEXT:
        m = tuple(round(v, 1) for v in obj.get_matrix().multiply(parent).get())
        return ("text", text_of(obj, tp), obj.get_font().get_base_name(), round(obj.get_font_size(), 1), m)
    if obj.type == pr.FPDF_PAGEOBJ_PATH:
        return ("path", pr.FPDFPath_CountSegments(obj), b)
    return (obj_type(obj), b)


def heuristic_candidates(doc) -> list[dict]:
    n_pages = len(doc)
    seen: dict[tuple, dict] = defaultdict(lambda: {"pages": set()})
    for pi in range(n_pages):
        page = doc[pi]
        tp = page.get_textpage()
        pw, ph = page.get_size()
        for obj, parent in walk(page):
            if obj.type == pr.FPDF_PAGEOBJ_FORM:
                continue  # its children are visited (level 1)
            sig = signature(obj, parent, tp)
            e = seen[sig]
            e["pages"].add(pi)
            l, b, r, t = parent.on_rect(*obj.get_bounds())
            e.update(type=obj_type(obj), rotation=rotation_deg(obj), alpha=fill_alpha(obj),
                     marks=marks_of(obj), area_ratio=round((r - l) * (t - b) / (pw * ph), 3),
                     label=sig[1] if sig[0] == "text" else f"{sig[0]} {sig[1]}")
    out = []
    for sig, e in seen.items():
        ratio = len(e["pages"]) / n_pages
        if ratio < 0.6 or n_pages < 2:
            continue
        score, why = 1, [f"lặp trên {len(e['pages'])}/{n_pages} trang"]
        if abs(e["rotation"]) not in (0.0, 90.0, 180.0):
            score += 2
            why.append(f"xoay {e['rotation']}°")
        if e["alpha"] < 255:
            score += 2
            why.append(f"trong suốt (alpha {e['alpha']})")
        if any(m.startswith("Artifact") for m in e["marks"]):
            score += 3
            why.append("marked content /Artifact")
        if e["area_ratio"] > 0.15:
            score += 1
            why.append(f"chiếm {int(e['area_ratio'] * 100)}% trang")
        out.append({"sig": sig, "label": str(e["label"])[:50], "type": e["type"], "score": score, "why": why})
    out.sort(key=lambda d: -d["score"])
    return out


def tagged_watermarks(path) -> list[dict]:
    """Find BDC /Artifact with /Subtype /Watermark (inline dict or /Properties ref)."""
    found = []
    with pikepdf.open(path) as p:
        for pi, pg in enumerate(p.pages):
            props = pg.Resources.get("/Properties", {})
            for operands, op in pikepdf.parse_content_stream(pg):
                if str(op) != "BDC" or operands[0] != "/Artifact":
                    continue
                d = operands[1]
                if isinstance(d, pikepdf.Name):
                    d = props.get(d, {})
                if d.get("/Subtype") == "/Watermark":
                    found.append({"page": pi, "props": {k: str(v) for k, v in d.items()}})
    return found


def strip_tagged_watermarks(src, dst) -> int:
    """pikepdf: drop every BDC /Artifact <</Subtype /Watermark>> ... EMC block."""
    removed = 0
    with pikepdf.open(src) as p:
        for pg in p.pages:
            props = pg.Resources.get("/Properties", {})
            out, depth_skip, depth = [], None, 0
            for operands, op in pikepdf.parse_content_stream(pg):
                o = str(op)
                if o in ("BDC", "BMC"):
                    depth += 1
                    if depth_skip is None and o == "BDC" and operands[0] == "/Artifact":
                        d = operands[1]
                        if isinstance(d, pikepdf.Name):
                            d = props.get(d, {})
                        if d.get("/Subtype") == "/Watermark":
                            depth_skip = depth
                            removed += 1
                            continue
                elif o == "EMC":
                    depth -= 1
                    if depth_skip is not None and depth + 1 == depth_skip:
                        depth_skip = None
                        continue
                if depth_skip is None:
                    out.append((operands, op))
            pg.Contents = p.make_stream(pikepdf.unparse_content_stream(out))
        p.remove_unreferenced_resources()
        p.save(dst)
    return removed


def main() -> None:
    res: dict = {}
    truth = json.loads((OUT / "corpus_truth.json").read_text())
    with pikepdf.open(CORPUS) as p:
        res["xobject_resource_entries_before"] = sum(
            len(pg.Resources.get("/XObject", {}).keys()) for pg in p.pages)
    doc = pdfium.PdfDocument(str(CORPUS))
    cands = heuristic_candidates(doc)
    res["heuristic_candidates"] = [{k: v for k, v in c.items() if k != "sig"} for c in cands]
    res["tagged_watermarks_pikepdf"] = tagged_watermarks(CORPUS)

    # Removal A (PDFium): user ticks the rotated+transparent text and the logo image.
    chosen = [c["sig"] for c in cands if c["type"] == "text" and c["label"] == truth["watermark"]]
    chosen += [c["sig"] for c in cands if c["type"] == "image"]
    removed = 0
    for pi in range(len(doc)):
        page = doc[pi]
        tp = page.get_textpage()
        victims = [o for o, parent in walk(page) if o.type != pr.FPDF_PAGEOBJ_FORM
                   and o.level == 0 and signature(o, parent, tp) in chosen]
        for o in victims:
            page.remove_obj(o)
            removed += 1
        pr.FPDFPage_GenerateContent(page)
        tp.close()
        del victims, tp, page
        o = None  # noqa: F841 - release the last wrapper before doc.close()
    out_a = OUT / "e2_removed_pdfium.pdf"
    doc.save(str(out_a))
    doc.close()
    res["pdfium_removed_objects"] = removed

    # qpdf rewrite + prune resources no longer used by the content streams
    out_a2 = OUT / "e2_removed_pdfium_pruned.pdf"
    with pikepdf.open(out_a) as p:
        logo_refs_before = sum(1 for pg in p.pages for k in pg.Resources.get("/XObject", {}).keys())
        p.remove_unreferenced_resources()
        logo_refs_after = sum(1 for pg in p.pages for k in pg.Resources.get("/XObject", {}).keys())
        p.save(out_a2)
    res["xobject_resource_entries_after_pdfium"] = logo_refs_before
    res["xobject_resource_entries_after_prune"] = logo_refs_after
    texts = page_text(out_a2)
    res["watermark_text_left"] = sum(t.count(truth["watermark"]) for t in texts)
    res["body_text_kept"] = all(p[:30] in "".join(texts).replace("\r\n", " ").replace("\n", " ")
                                for p in truth["paragraphs"][:3])
    with pikepdf.open(out_a2) as p:
        res["image_streams_left"] = sum(1 for o in p.objects if isinstance(o, pikepdf.Stream)
                                        and o.get("/Subtype") == "/Image")
    with pikepdf.open(CORPUS) as p:
        res["image_streams_before"] = sum(1 for o in p.objects if isinstance(o, pikepdf.Stream)
                                          and o.get("/Subtype") == "/Image")
    # Removal B (pikepdf): tagged watermark only
    out_b = OUT / "e2_removed_tagged_pikepdf.pdf"
    res["pikepdf_tagged_blocks_removed"] = strip_tagged_watermarks(CORPUS, out_b)
    res["tagged_text_left_after_B"] = sum(t.count(truth["tagged_watermark"]) for t in page_text(out_b))

    render_page(out_a2, 1, OUT / "e2_after_page2.png", scale=0.8)
    render_page(CORPUS, 1, OUT / "e2_before_page2.png", scale=0.8)
    (OUT / "e2_results.json").write_text(json.dumps(res, ensure_ascii=False, indent=2))
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
