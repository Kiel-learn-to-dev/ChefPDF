"""S2 comparison with PyMuPDF (AGPL). Run only via:  uv run --group agpl python -m s2.pymupdf_compare

Same redaction targets as e3 (verified with the same library-independent checks) and
the same Vietnamese text-edit task as e4, so the numbers are comparable.
"""

from __future__ import annotations

import json
import time

import pymupdf

from common.fonts import regular_font
from common.render import render_page

from .common import CORPUS, OUT, page_text
from .e3_redact import TARGETS, inside, line_positions, target_rects
from .redact_verify import verify

NEW_TEXT = "Đơn vị: Công ty Cổ phần Ánh Dương Mỹ Kỳ – Quỹ ẵ Ợ"


def redact() -> dict:
    truth = json.loads((OUT / "corpus_truth.json").read_text())
    # PDFium's boxes for ActualText chars inside the form are wrong (form-local), so the
    # text targets are located with PyMuPDF's own search; the photo rect is shared.
    rects = target_rects(CORPUS)
    t = time.perf_counter()
    doc = pymupdf.open(CORPUS)
    page = doc[0]
    h = page.rect.height
    mu_rects = [r for s in TARGETS for r in page.search_for(s)]
    x0, y0, x1, y1 = rects[-1]  # PDF (bottom-left) -> MuPDF (top-left) coords
    mu_rects.append(pymupdf.Rect(x0, h - y1, x1, h - y0))
    for r in mu_rects:
        page.add_redact_annot(r, fill=(0, 0, 0))
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_PIXELS,
                          graphics=pymupdf.PDF_REDACT_LINE_ART_REMOVE_IF_COVERED,
                          text=pymupdf.PDF_REDACT_TEXT_REMOVE)
    out = OUT / "e3_pymupdf.pdf"
    doc.save(out, garbage=4, deflate=True)
    doc.close()
    ms = round((time.perf_counter() - t) * 1000, 1)
    pii_band = (rects[0][1], rects[0][3])
    before = line_positions(CORPUS, pii_band)
    after = line_positions(out, pii_band)
    kept_before = [c for c in before if not inside((c[1] + 1, pii_band[0], c[1] + 1, pii_band[1]), rects[:1])]
    render_page(out, 0, OUT / "e3_pymupdf.png", scale=2, crop_pt=(30, 680, 560, 760))
    return {
        "ms": ms,
        "verify": verify(CORPUS, out, must_be_gone=list(TARGETS),
                         must_remain=["Họ tên: Nguyễn Văn A", "SĐT: 0912 345 678", "Hoàn Kiếm",
                                      truth["paragraphs"][0][:40]], img_rect=rects[-1]),
        "kept_chars_max_x_drift_pt": max((abs(a[1] - b[1]) for a, b in zip(kept_before, after, strict=False)
                                          if a[0] == b[0]), default=None),
        "kept_chars_same_sequence": [c[0] for c in kept_before] == [c[0] for c in after],
    }


def edit_text() -> dict:
    """PyMuPDF has no 'edit text in place' API either: redact the old line, then insert
    new text with a full Unicode TTF (MuPDF subsets it on save with subset_fonts())."""
    truth = json.loads((OUT / "corpus_truth.json").read_text())
    t = time.perf_counter()
    doc = pymupdf.open(CORPUS)
    page = doc[0]
    hits = page.search_for(truth["edit_line"])
    span = None
    for b in page.get_text("dict")["blocks"]:
        for ln in b.get("lines", []):
            for s in ln["spans"]:
                if s["text"].strip().startswith("Đơn vị"):
                    span = s
    r = hits[0]
    page.add_redact_annot(r)
    page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE)
    page.insert_font(fontname="vn", fontfile=str(regular_font()))
    page.insert_text(span["origin"], NEW_TEXT, fontname="vn", fontsize=span["size"], color=(0, 0, 0))
    doc.subset_fonts()
    out = OUT / "e4_pymupdf.pdf"
    doc.save(out, garbage=4, deflate=True)
    doc.close()
    ms = round((time.perf_counter() - t) * 1000, 1)
    render_page(out, 0, OUT / "e4_pymupdf.png", scale=2, crop_pt=(90, 750, 420, 800))
    txt = page_text(out)[0]
    return {"ms": ms, "new_text_extractable": NEW_TEXT in " ".join(txt.split()),
            "old_text_gone": truth["edit_line"] not in txt, "size": out.stat().st_size,
            "size_before": CORPUS.stat().st_size, "original_font": span["font"]}


def layout() -> dict:
    """Baseline: PyMuPDF text blocks as paragraphs, same merge + metrics as e5.
    sort=False keeps content-stream order, sort=True sorts blocks top-to-bottom."""
    import difflib

    from .e5_layout import BODY_Y, merge_continuations

    truth = json.loads((OUT / "corpus_truth.json").read_text())
    norm = lambda s: " ".join(s.split())  # noqa: E731
    truth_p = [norm(p) for p in truth["paragraphs"]]
    out = {}
    for sort in (False, True):
        doc = pymupdf.open(CORPUS)
        paras = []
        for page in doc:
            h = page.rect.height
            for _x0, y0, _x1, y1, text, *_ in page.get_text("blocks", sort=sort):
                if BODY_Y[0] <= h - y1 and h - y0 <= BODY_Y[1] + 15:
                    paras.append({"text": norm(text), "indented": False})
        merged = merge_continuations(paras)
        out[f"sort={sort}"] = {
            "blocks": len(paras), "paragraphs_after_merge": len(merged),
            "paragraphs_exact_match": sum(1 for p in merged if p in truth_p),
            "reading_order_similarity": round(difflib.SequenceMatcher(
                None, norm(" ".join(merged)), norm(" ".join(truth_p))).ratio(), 4),
        }
    return out


def main() -> None:
    res = {"pymupdf_version": pymupdf.__version__, "redact": redact(), "edit_text": edit_text(),
           "layout_blocks": layout()}
    (OUT / "pymupdf_results.json").write_text(json.dumps(res, ensure_ascii=False, indent=2))
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
