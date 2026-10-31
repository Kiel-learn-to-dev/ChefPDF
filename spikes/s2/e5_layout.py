"""S2-5: chars (pypdfium2 textpage) -> lines -> columns (XY-cut) -> paragraphs.

Evaluated on the two-column body of all 3 corpus pages against corpus_truth.json:
  * line accuracy: extracted lines vs PDFium text objects (reportlab writes 1 object/line)
  * paragraph exact-match rate (after merging fragments that continue across columns/pages)
  * reading-order similarity (difflib ratio of the concatenated body text)
Also measures PDFium's own get_text_range() order for comparison.
"""

from __future__ import annotations

import ctypes
import difflib
import json
import statistics
import time
from dataclasses import dataclass, field

import pypdfium2 as pdfium
import pypdfium2.raw as pr

from .common import CORPUS, OUT, marks_of, text_of

BODY_Y = (55.0, 685.0)  # frames: y 60 .. H-160 (=681.9)


@dataclass
class Char:
    ch: str
    x0: float
    y0: float
    x1: float
    y1: float
    ox: float
    oy: float
    size: float


@dataclass
class Line:
    chars: list[Char] = field(default_factory=list)

    @property
    def x0(self):
        return min(c.x0 for c in self.chars)

    @property
    def x1(self):
        return max(c.x1 for c in self.chars)

    @property
    def y(self):
        return statistics.median(c.oy for c in self.chars)

    @property
    def size(self):
        return statistics.median(c.size for c in self.chars)

    @property
    def text(self):
        out, prev = [], None
        for c in sorted(self.chars, key=lambda c: c.x0):
            if prev and c.x0 - prev.x1 > 0.25 * c.size and c.ch != " " and prev.ch != " ":
                out.append(" ")  # gap without an explicit space char
            out.append(c.ch)
            prev = c
        return " ".join("".join(out).split())


def load_chars(page, skip_artifacts: bool = True) -> list[Char]:
    tp = page.get_textpage()
    chars = []
    for i in range(tp.count_chars()):
        if pr.FPDFText_IsGenerated(tp, i) == 1:
            continue
        u = chr(pr.FPDFText_GetUnicode(tp, i))
        if u in "\r\n":
            continue
        if abs(pr.FPDFText_GetCharAngle(tp, i)) > 0.01:
            continue  # rotated text (the diagonal watermark) is not body text
        if skip_artifacts:
            h = pr.FPDFText_GetTextObject(tp, i)
            if h and any(m.startswith("Artifact") for m in marks_of(h)):
                continue  # /Artifact marked content (watermarks, page numbers, D14)
        l, r, b, t = (ctypes.c_double() for _ in range(4))
        pr.FPDFText_GetCharBox(tp, i, l, r, b, t)
        ox, oy = ctypes.c_double(), ctypes.c_double()
        pr.FPDFText_GetCharOrigin(tp, i, ox, oy)
        size = pr.FPDFText_GetFontSize(tp, i)
        chars.append(Char(u, l.value, b.value, r.value, t.value, ox.value, oy.value, size))
    tp.close()
    return chars


def build_lines(chars: list[Char]) -> list[Line]:
    """Group by baseline, then split a baseline row at large horizontal gaps (gutters)."""
    rows: list[list[Char]] = []
    for c in sorted(chars, key=lambda c: (-c.oy, c.x0)):
        if rows and abs(rows[-1][0].oy - c.oy) <= 0.3 * c.size:
            rows[-1].append(c)
        else:
            rows.append([c])
    lines = []
    for row in rows:
        row.sort(key=lambda c: c.x0)
        cur = Line([row[0]])
        for c in row[1:]:
            prev = cur.chars[-1]
            if c.x0 - prev.x1 > 1.5 * c.size:  # column gutter
                lines.append(cur)
                cur = Line([c])
            else:
                cur.chars.append(c)
        lines.append(cur)
    return [ln for ln in lines if ln.text.strip()]


def xy_cut(lines: list[Line], depth=0) -> list[list[Line]]:
    """Recursive XY-cut on line boxes. Returns leaf blocks in reading order."""
    if len(lines) <= 1 or depth > 20:
        return [lines]
    # vertical cut first (columns): find an x gap not covered by any line
    spans = sorted((ln.x0, ln.x1) for ln in lines)
    reach = spans[0][1]
    for x0, x1 in spans[1:]:
        if x0 - reach > 8:  # gutter
            left = [ln for ln in lines if ln.x1 <= reach + 0.1]
            right = [ln for ln in lines if ln.x0 >= x0 - 0.1]
            return xy_cut(left, depth + 1) + xy_cut(right, depth + 1)
        reach = max(reach, x1)
    # horizontal cut: big vertical gap between consecutive lines
    ls = sorted(lines, key=lambda ln: -ln.y)
    gaps = [(ls[i].y - ls[i + 1].y, i) for i in range(len(ls) - 1)]
    med = statistics.median(g for g, _ in gaps) if gaps else 0
    big = [i for g, i in gaps if g > 2.5 * med and g > 20]
    if big:
        i = big[0]
        return xy_cut(ls[: i + 1], depth + 1) + xy_cut(ls[i + 1:], depth + 1)
    return [ls]


def paragraphs(block: list[Line]) -> list[dict]:
    """Split a column block into paragraphs: first-line indent or extra spacing."""
    if not block:
        return []
    left = min(ln.x0 for ln in block)
    gaps = [block[i].y - block[i + 1].y for i in range(len(block) - 1)]
    lead = statistics.median(gaps) if gaps else 14
    out, cur = [], [block[0]]
    for prev, ln in zip(block, block[1:], strict=False):
        indented = ln.x0 - left > 0.8 * ln.size
        spaced = prev.y - ln.y > 1.35 * lead
        if indented or spaced or abs(ln.size - prev.size) > 0.5:
            out.append(cur)
            cur = [ln]
        else:
            cur.append(ln)
    out.append(cur)
    res = []
    for p in out:
        text = ""
        for ln in p:
            t = ln.text
            text = text[:-1] + t if text.endswith("-") else (text + " " + t if text else t)
        res.append({"text": text, "indented": p[0].x0 - left > 0.8 * p[0].size})
    return res


def merge_continuations(paras: list[dict]) -> list[str]:
    """A fragment that starts unindented after a fragment without terminal punctuation
    continues the previous paragraph (column / page break)."""
    out: list[str] = []
    for p in paras:
        if out and not p["indented"] and not out[-1].rstrip().endswith((".", ":", "!", "?")):
            out[-1] = out[-1] + " " + p["text"]
        else:
            out.append(p["text"])
    return out


def main() -> None:
    truth = json.loads((OUT / "corpus_truth.json").read_text())
    norm = lambda s: " ".join(s.split())  # noqa: E731
    doc = pdfium.PdfDocument(str(CORPUS))
    t = time.perf_counter()
    all_paras, line_ok, line_total, builtin_text = [], 0, 0, []
    n_chars = 0
    for pi in range(len(doc)):
        page = doc[pi]
        chars = [c for c in load_chars(page) if BODY_Y[0] <= c.oy <= BODY_Y[1]]
        n_chars += len(chars)
        lines = build_lines(chars)
        blocks = xy_cut(lines)
        for b in blocks:
            all_paras += paragraphs(b)
        # ground-truth lines = text objects in the body (reportlab: one object per line)
        tp = page.get_textpage()
        truth_lines = {norm(text_of(o, tp)) for o in page.get_objects()
                       if o.type == pr.FPDF_PAGEOBJ_TEXT and BODY_Y[0] <= o.get_bounds()[1] <= BODY_Y[1]
                       and abs(o.get_matrix().b) < 1e-6}
        builtin_text.append(tp.get_text_range())
        tp.close()
        line_total += len(lines)
        line_ok += sum(1 for ln in lines if ln.text in truth_lines)
        del page
    ms = round((time.perf_counter() - t) * 1000, 1)
    merged = merge_continuations(all_paras)
    truth_p = [norm(p) for p in truth["paragraphs"]]
    exact = sum(1 for p in merged if norm(p) in truth_p)
    body_out = norm(" ".join(merged))
    body_truth = norm(" ".join(truth_p))
    builtin_norm = norm(" ".join(builtin_text))
    i0 = builtin_norm.find(truth_p[0][:20])
    res = {
        "pages": len(doc), "body_chars": n_chars, "ms_total": ms,
        "lines_extracted": line_total, "lines_matching_text_objects": line_ok,
        "paragraph_fragments_before_merge": len(all_paras),
        "paragraphs_after_merge": len(merged), "truth_paragraphs": len(truth_p),
        "paragraphs_exact_match": exact,
        "reading_order_similarity_ours": round(difflib.SequenceMatcher(None, body_out, body_truth).ratio(), 4),
        "reading_order_similarity_pdfium_builtin": round(
            difflib.SequenceMatcher(None, builtin_norm[i0:i0 + len(body_truth)], body_truth).ratio(), 4),
        "first_mismatches": [p for p in merged if norm(p) not in truth_p][:3],
    }
    doc.close()
    (OUT / "e5_results.json").write_text(json.dumps(res, ensure_ascii=False, indent=2))
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
