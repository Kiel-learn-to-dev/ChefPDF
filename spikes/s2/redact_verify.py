"""Library-independent checks that a redaction really removed content (page-scoped).

Uses three views: PDFium textpage, poppler pdftotext (if installed), and raw
stream bytes via pikepdf (orphan/unchanged original streams), plus pixel
inspection of image XObjects.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium


def pdfium_page_text(path: Path, page_index: int) -> str:
    doc = pdfium.PdfDocument(str(path))
    try:
        page = doc[page_index]
        tp = page.get_textpage()
        txt = tp.get_text_range()
        tp.close()
        del page
        return txt
    finally:
        doc.close()


def poppler_page_text(path: Path, page_index: int) -> tuple[str, list[str]]:
    if not shutil.which("pdftotext"):
        return "", ["pdftotext not installed"]
    n = str(page_index + 1)
    p = subprocess.run(["pdftotext", "-q", "-f", n, "-l", n, str(path), "-"], capture_output=True, text=True)
    errs = subprocess.run(["pdftotext", "-f", n, "-l", n, str(path), "/dev/null"],
                          capture_output=True, text=True).stderr
    return p.stdout, sorted({e for e in errs.splitlines() if e.strip()})


def _reach(obj, seen: set, depth: int = 0) -> None:
    """Collect objgens of indirect objects reachable from obj (not following /Parent)."""
    if depth > 50:
        return
    if isinstance(obj, (pikepdf.Dictionary, pikepdf.Stream)):
        if obj.is_indirect:
            if obj.objgen in seen:
                return
            seen.add(obj.objgen)
        for k in obj.keys():
            if k not in ("/Parent", "/P"):
                _reach(obj[k], seen, depth + 1)
    elif isinstance(obj, pikepdf.Array):
        for v in obj:
            _reach(v, seen, depth + 1)


def surviving_original_streams(original: Path, redacted: Path, page_index: int = 0) -> list[str]:
    """Which original streams of the page (content streams, Form XObjects) still exist
    byte-identical anywhere in the redacted file."""
    olds: dict[str, bytes] = {}
    with pikepdf.open(original) as p:
        pg = p.pages[page_index]
        c = pg.Contents
        for i, s in enumerate(c if isinstance(c, pikepdf.Array) else [c]):
            olds[f"page content #{i}"] = s.read_bytes()
        for k, x in pg.Resources.get("/XObject", {}).items():
            if x.get("/Subtype") == "/Form":
                olds[f"form {k}"] = x.read_bytes()
    olds = {k: v for k, v in olds.items() if len(v) > 100}  # ignore tiny q/Q wrappers
    found = []
    with pikepdf.open(redacted) as p:
        # Streams reachable from *other* pages may legitimately hold identical bytes
        # (the corpus repeats the same stamp form on every page): exclude them.
        other = set()
        for i, pg in enumerate(p.pages):
            if i != page_index:
                _reach(pg.obj, other)
        datas = []
        for o in p.objects:
            if isinstance(o, pikepdf.Stream) and o.objgen not in other:
                try:
                    datas.append(o.read_bytes())
                except pikepdf.PdfError:
                    pass
    for k, v in olds.items():
        if v in datas:
            found.append(k)
    return found


def image_region_stats(path: Path, page_index: int, rect) -> list[dict]:
    """For each image XObject drawn on the page, decode it and report the mean pixel
    value inside `rect` (page coords): ~0 means the pixels were painted black."""
    out = []
    with pikepdf.open(path) as p:
        pg = p.pages[page_index]
        ctm_stack, ctm = [], [1, 0, 0, 1, 0, 0]
        for operands, op in pikepdf.parse_content_stream(pg):
            o = str(op)
            if o == "q":
                ctm_stack.append(ctm[:])
            elif o == "Q":
                ctm = ctm_stack.pop() if ctm_stack else [1, 0, 0, 1, 0, 0]
            elif o == "cm":
                a, b, c, d, e, f = (float(x) for x in operands)
                A, B, C, D, E, F = ctm
                ctm = [a * A + b * C, a * B + b * D, c * A + d * C, c * B + d * D,
                       e * A + f * C + E, e * B + f * D + F]
            elif o == "Do":
                xo = pg.Resources.XObject.get(operands[0])
                if xo is None or xo.get("/Subtype") != "/Image":
                    continue
                img = pikepdf.PdfImage(xo).as_pil_image().convert("RGB")
                w, h = img.size
                a, _, _, d, e, f = ctm  # axis-aligned images only (enough for the corpus)
                x0, y0, x1, y1 = rect
                box = (max(0, int((x0 - e) / a * w)), max(0, int((1 - (y1 - f) / d) * h)),
                       min(w, int((x1 - e) / a * w)), min(h, int((1 - (y0 - f) / d) * h)))
                if box[2] <= box[0] or box[3] <= box[1]:
                    continue
                region = img.crop(box)
                mean = sum(sum(px) for px in region.getdata()) / (3 * region.width * region.height)
                out.append({"xobject": str(operands[0]), "px_box": box, "mean_in_region": round(mean, 1),
                            "size": (w, h)})
    return out


def verify(original: Path, path: Path, *, must_be_gone: list[str], must_remain: list[str],
           img_rect, page_index: int = 0) -> dict:
    norm = lambda s: " ".join(s.split())  # noqa: E731
    pd_txt = norm(pdfium_page_text(path, page_index))
    pop_txt, pop_errs = poppler_page_text(path, page_index)
    pop_txt = norm(pop_txt)
    return {
        "gone_pdfium": {s: s not in pd_txt for s in must_be_gone},
        "gone_poppler": {s: s not in pop_txt for s in must_be_gone},
        "kept_pdfium": {s: norm(s) in pd_txt for s in must_remain},
        "poppler_errors": pop_errs[:5],
        "image_region": image_region_stats(path, page_index, img_rect),
        "original_streams_still_in_file": surviving_original_streams(original, path, page_index),
        "size": path.stat().st_size,
    }
