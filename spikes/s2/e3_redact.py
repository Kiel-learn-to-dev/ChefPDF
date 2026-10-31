"""S2-3: region erase / true redaction with PDFium (permissive stack).

Targets on page 1 of the corpus:
  R1  the CCCD number in the PII line (partial overlap of one text object)
  R2  "Tràng Tiền" in the CID-font line that lives inside a Form XObject
  R3  a corner of the photo image (pixels must be destroyed, not covered)

Algorithm (what T6.03/T6.07 would implement):
  * text: map every textpage char to its text object (FPDFText_GetTextObject); for an
    object with chars inside the region, delete it and re-create the kept chars as new
    text objects (one per word, positioned at the original char origin, same font/size/
    colour) with FPDFText_SetText. Kept glyphs already exist in the subset font.
  * images: decode bitmap, paint the region black, FPDFImageObj_SetBitmap.
  * paths fully inside: delete. Optional black boxes on top (J6) or none (D5).
  * FPDFPage_GenerateContent, save, then qpdf rewrite (drops unreferenced objects).
"""

from __future__ import annotations

import ctypes
import json
import time
from pathlib import Path

import pypdfium2 as pdfium
import pypdfium2.raw as pr

from common.render import render_page

from .common import CORPUS, OUT, pikepdf_gc
from .pdf_helpers import font_program_key, font_unicode_coverage, inline_forms
from .redact_verify import verify


def ptr(h) -> int:
    return ctypes.cast(h, ctypes.c_void_p).value or 0


def wstr(s: str):
    data = s.encode("utf-16-le") + b"\0\0"
    return ctypes.cast(ctypes.create_string_buffer(data, len(data)), ctypes.POINTER(pr.FPDF_WCHAR))


def find_rects(tp, needle: str) -> list[tuple[float, float, float, float]]:
    out = []
    searcher = tp.search(needle, match_case=True)
    while (hit := searcher.get_next()) is not None:
        i, n = hit
        boxes = [tp.get_charbox(j) for j in range(i, i + n)]
        out.append((min(b[0] for b in boxes) - 0.5, min(b[1] for b in boxes) - 0.5,
                    max(b[2] for b in boxes) + 0.5, max(b[3] for b in boxes) + 0.5))
    searcher.close()
    return out


def inside(box, rects) -> bool:
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    return any(r[0] <= cx <= r[2] and r[1] <= cy <= r[3] for r in rects)


def overlaps(a, b) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def font_data_key(font) -> str | None:
    """Hash of the embedded font program as PDFium sees it (FPDFFont_GetFontData)."""
    n = ctypes.c_size_t()
    if not pr.FPDFFont_GetFontData(font, None, 0, n) or not n.value:
        return None
    buf = (ctypes.c_uint8 * n.value)()
    pr.FPDFFont_GetFontData(font, buf, n.value, n)
    return font_program_key(bytes(buf))


def obj_matrix(h) -> pdfium.PdfMatrix:
    m = pr.FS_MATRIX()
    pr.FPDFPageObj_GetMatrix(h, m)
    return pdfium.PdfMatrix(m.a, m.b, m.c, m.d, m.e, m.f)


def redact_page(doc, page, rects, *, black_boxes: bool, coverage: dict | None = None) -> dict:
    stats = {"text_objs_rebuilt": 0, "text_objs_deleted": 0, "chars_removed": 0,
             "images_painted": 0, "paths_deleted": 0, "new_text_objs": 0}
    # ---- 1. collect parents: raw ptr -> (form handle or None, parent matrix)
    parent_of: dict[int, tuple] = {}
    top = [pr.FPDFPage_GetObject(page, i) for i in range(pr.FPDFPage_CountObjects(page))]

    def visit(form, h, pm):
        parent_of[ptr(h)] = (form, pm)
        if pr.FPDFPageObj_GetType(h) == pr.FPDF_PAGEOBJ_FORM:
            fm = obj_matrix(h).multiply(pm)
            for k in range(pr.FPDFFormObj_CountObjects(h)):
                visit(h, pr.FPDFFormObj_GetObject(h, k), fm)

    for h in top:
        visit(None, h, pdfium.PdfMatrix())

    # ---- 2. text: chars -> owning text object
    tp = page.get_textpage()
    per_obj: dict[int, dict] = {}
    for i in range(tp.count_chars()):
        h = pr.FPDFText_GetTextObject(tp, i)
        if not h:
            continue  # generated char (e.g. inserted space)
        box = tp.get_charbox(i)
        x, y = ctypes.c_double(), ctypes.c_double()
        pr.FPDFText_GetCharOrigin(tp, i, x, y)
        e = per_obj.setdefault(ptr(h), {"h": h, "chars": []})
        e["chars"].append((chr(pr.FPDFText_GetUnicode(tp, i)), (x.value, y.value), inside(box, rects)))
    jobs = []
    for key, e in per_obj.items():
        if not any(c[2] for c in e["chars"]):
            continue
        h = e["h"]
        form, pm = parent_of.get(key, (None, pdfium.PdfMatrix()))
        size = ctypes.c_float()
        pr.FPDFTextObj_GetFontSize(h, size)
        r, g, b, a = (ctypes.c_uint() for _ in range(4))
        pr.FPDFPageObj_GetFillColor(h, r, g, b, a)
        m = obj_matrix(h).multiply(pm)
        # word runs of kept chars
        runs, cur = [], []
        for ch, org, ins in e["chars"]:
            if ins or ch.isspace():
                if cur:
                    runs.append(cur)
                cur = []
                stats["chars_removed"] += int(ins)
            else:
                cur.append((ch, org))
        if cur:
            runs.append(cur)
        font = pr.FPDFTextObj_GetFont(h)
        jobs.append(dict(h=h, form=form, font=font, base=font_data_key(font), size=size.value,
                         color=(r.value, g.value, b.value, a.value), lin=(m.a, m.b, m.c, m.d),
                         mode=pr.FPDFTextObj_GetTextRenderMode(h), runs=runs))
    # ---- 3. images: paint pixels (done through pypdfium2 wrappers, objects are kept)
    for obj in page.get_objects(max_depth=1):
        if obj.type != pr.FPDF_PAGEOBJ_IMAGE:
            continue
        bounds = obj.get_bounds()
        hits = [rr for rr in rects if overlaps(bounds, rr)]
        if not hits:
            continue
        mx = obj.get_matrix()
        bmp = obj.get_bitmap(render=False)
        img = bmp.to_pil().convert("RGB")
        w, hgt = img.size
        from PIL import ImageDraw

        d = ImageDraw.Draw(img)
        for rr in hits:
            u0, u1 = (rr[0] - mx.e) / mx.a, (rr[2] - mx.e) / mx.a
            v0, v1 = (rr[1] - mx.f) / mx.d, (rr[3] - mx.f) / mx.d
            d.rectangle((u0 * w, (1 - v1) * hgt, u1 * w, (1 - v0) * hgt), fill=(0, 0, 0))
        obj.set_bitmap(pdfium.PdfBitmap.from_pil(img))
        stats["images_painted"] += 1
        del obj, bmp
    # ---- 4. paths fully inside a region
    for h in list(top):
        if pr.FPDFPageObj_GetType(h) == pr.FPDF_PAGEOBJ_PATH:
            lb, bb, rb, tb = (ctypes.c_float() for _ in range(4))
            pr.FPDFPageObj_GetBounds(h, lb, bb, rb, tb)
            if any(rr[0] <= lb.value and rr[1] <= bb.value and rb.value <= rr[2] and tb.value <= rr[3]
                   for rr in rects):
                pr.FPDFPage_RemoveObject(page, h)
                pr.FPDFPageObj_Destroy(h)
                stats["paths_deleted"] += 1
    # ---- 5. rebuild text
    for j in jobs:
        anchor = j["form"] or j["h"]
        idx = next(k for k in range(pr.FPDFPage_CountObjects(page))
                   if ptr(pr.FPDFPage_GetObject(page, k)) == ptr(anchor))
        insert_at = idx + 1
        codes_map = (coverage or {}).get(j["base"], {}).get("codes")
        for run in j["runs"]:
            t = pr.FPDFPageObj_CreateTextObj(doc, j["font"], j["size"])
            s = "".join(c for c, _ in run)
            if codes_map and all(ch in codes_map for ch in s):
                # char codes from the font's own ToUnicode: correct for CID subsets too
                arr = (ctypes.c_uint32 * len(s))(*[codes_map[ch] for ch in s])
                pr.FPDFText_SetCharcodes(t, arr, len(s))
                stats["runs_via_charcodes"] = stats.get("runs_via_charcodes", 0) + 1
            else:
                pr.FPDFText_SetText(t, wstr(s))
                stats["runs_via_settext"] = stats.get("runs_via_settext", 0) + 1
            a, b, c, d = j["lin"]
            ox, oy = run[0][1]
            pr.FPDFPageObj_Transform(t, a, b, c, d, ox, oy)
            pr.FPDFPageObj_SetFillColor(t, *j["color"])
            pr.FPDFTextObj_SetTextRenderMode(t, j["mode"])
            pr.FPDFPage_InsertObjectAtIndex(page, t, insert_at)
            insert_at += 1
            stats["new_text_objs"] += 1
        if j["form"]:
            pr.FPDFFormObj_RemoveObject(j["form"], j["h"])
        else:
            pr.FPDFPage_RemoveObject(page, j["h"])
        pr.FPDFPageObj_Destroy(j["h"])
        stats["text_objs_rebuilt" if j["runs"] else "text_objs_deleted"] += 1
    # ---- 6. optional black boxes (J6); D5 "tẩy vùng" leaves the area blank
    if black_boxes:
        for rr in rects:
            box = pr.FPDFPageObj_CreateNewRect(rr[0], rr[1], rr[2] - rr[0], rr[3] - rr[1])
            pr.FPDFPageObj_SetFillColor(box, 0, 0, 0, 255)
            pr.FPDFPath_SetDrawMode(box, pr.FPDF_FILLMODE_WINDING, 0)
            pr.FPDFPage_InsertObject(page, box)
    tp.close()
    stats["generate_content_ok"] = bool(pr.FPDFPage_GenerateContent(page))
    return stats


def line_positions(path: Path, y_band: tuple[float, float]) -> list[tuple[str, float]]:
    doc = pdfium.PdfDocument(str(path))
    tp = doc[0].get_textpage()
    out = []
    for i in range(tp.count_chars()):
        b = tp.get_charbox(i)
        cy = (b[1] + b[3]) / 2
        ch = chr(pr.FPDFText_GetUnicode(tp, i))
        if y_band[0] <= cy <= y_band[1] and not ch.isspace() and pr.FPDFText_IsGenerated(tp, i) != 1:
            out.append((ch, round(b[0], 2)))
    tp.close()
    doc.close()
    return out


TARGETS = ("001234567890", "Tràng Tiền")


def target_rects(path: Path) -> list[tuple]:
    doc = pdfium.PdfDocument(str(path))
    page = doc[0]
    tp = page.get_textpage()
    rects = [r for s in TARGETS for r in find_rects(tp, s)]
    tp.close()
    del page
    doc.close()
    # + lower-right corner of the photo (470..525 x 690..756)
    return rects + [(495.0, 690.0, 530.0, 725.0)]


def run_variant(name: str, *, inline: bool, use_charcodes: bool) -> dict:
    """naive  = PDFium only, SetText (shows the Form XObject + CID font failures)
    recommended = pikepdf inlines forms first, char codes from ToUnicode, qpdf rewrite."""
    truth = json.loads((OUT / "corpus_truth.json").read_text())
    src = CORPUS
    t = time.perf_counter()
    if inline:
        src = OUT / f"_e3_{name}_inlined.pdf"
        inline_forms(CORPUS, src, 0)
    coverage = font_unicode_coverage(src, 0) if use_charcodes else None
    rects = target_rects(src)
    doc = pdfium.PdfDocument(str(src))
    page = doc[0]
    stats = redact_page(doc, page, rects, black_boxes=True, coverage=coverage)
    raw = OUT / f"_e3_{name}_raw.pdf"
    doc.save(str(raw))
    del page
    doc.close()
    final = OUT / f"e3_{name}.pdf"
    pikepdf_gc(raw, final)
    stats["total_ms"] = round((time.perf_counter() - t) * 1000, 1)

    pii_band = (rects[0][1], rects[0][3])
    before = line_positions(CORPUS, pii_band)
    after = line_positions(final, pii_band)
    kept_before = [c for c in before if not inside((c[1] + 1, pii_band[0], c[1] + 1, pii_band[1]), rects[:1])]
    drift = max((abs(a[1] - b[1]) for a, b in zip(kept_before, after, strict=False) if a[0] == b[0]),
                default=None)
    render_page(final, 0, OUT / f"e3_{name}.png", scale=2, crop_pt=(30, 680, 560, 760))
    return {
        "rects": [[round(v, 1) for v in r] for r in rects],
        "stats": stats,
        "verify": verify(CORPUS, final, must_be_gone=list(TARGETS),
                         must_remain=["Họ tên: Nguyễn Văn A", "SĐT: 0912 345 678", "Hoàn Kiếm",
                                      truth["paragraphs"][0][:40]],
                         img_rect=rects[-1]),
        "kept_chars_max_x_drift_pt": drift,
        "kept_chars_same_sequence": [c[0] for c in kept_before] == [c[0] for c in after],
    }


def main() -> None:
    render_page(CORPUS, 0, OUT / "e3_before.png", scale=2, crop_pt=(30, 680, 560, 760))
    res = {
        "naive_pdfium": run_variant("naive_pdfium", inline=False, use_charcodes=False),
        "recommended_pdfium_pikepdf": run_variant("recommended_pdfium_pikepdf", inline=True, use_charcodes=True),
    }
    (OUT / "e3_results.json").write_text(json.dumps(res, ensure_ascii=False, indent=2))
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
