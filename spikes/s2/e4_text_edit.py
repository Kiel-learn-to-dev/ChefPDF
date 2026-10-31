"""S2-4: edit an existing Vietnamese text line whose font is a subset missing the new glyphs.

Target: "Đơn vị: Công ty TNHH Thử Nghiệm Hà Nội" (reportlab simple TrueType subset).
New:    "Đơn vị: Công ty Cổ phần Ánh Dương Mỹ Kỳ – Quỹ ẵ Ợ" (several glyphs not in subset)

(0) glyph coverage detection: ToUnicode reverse map + cmap of the embedded program
(a) FPDFText_SetText in place with the subset font
(b) new text object with FPDFText_LoadFont(full TTF), same matrix/size/colour
(c) same as (b) but the TTF is first subset with fontTools to the needed glyphs
(PyMuPDF equivalent lives in pymupdf_compare.py)
"""

from __future__ import annotations

import ctypes
import io
import json
import time

import pypdfium2 as pdfium
import pypdfium2.raw as pr
from fontTools import subset as ft_subset
from fontTools.ttLib import TTFont

from common.fonts import regular_font
from common.render import render_page

from .common import CORPUS, OUT, page_text, pikepdf_gc, text_of
from .e3_redact import font_data_key, wstr
from .pdf_helpers import font_unicode_coverage

NEW_TEXT = "Đơn vị: Công ty Cổ phần Ánh Dương Mỹ Kỳ – Quỹ ẵ Ợ"
VIETNAMESE = ("aăâbcdđeêghiklmnoôơpqrstuưvxyAĂÂBCDĐEÊGHIKLMNOÔƠPQRSTUƯVXY"
              "àáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ"
              "ÀÁẢÃẠẰẮẲẴẶẦẤẨẪẬÈÉẺẼẸỀẾỂỄỆÌÍỈĨỊÒÓỎÕỌỒỐỔỖỘỜỚỞỠỢÙÚỦŨỤỪỨỬỮỰỲÝỶỸỴ"
              "fjwzFJWZ0123456789 .,;:!?()[]-–—/\"'%&+*=<>@#")


def find_line(page, tp, prefix):
    for o in page.get_objects():
        if o.type == pr.FPDF_PAGEOBJ_TEXT and text_of(o, tp).startswith(prefix):
            return o
    raise LookupError(prefix)


def font_program(font) -> bytes:
    n = ctypes.c_size_t()
    pr.FPDFFont_GetFontData(font, None, 0, n)
    buf = (ctypes.c_uint8 * n.value)()
    pr.FPDFFont_GetFontData(font, buf, n.value, n)
    return bytes(buf)


def cmap_coverage(program: bytes) -> set[str] | None:
    try:
        f = TTFont(io.BytesIO(program))
        cm = f.getBestCmap()
        return {chr(c) for c in cm} if cm else set()
    except Exception:  # noqa: BLE001 - CFF/Type1 or broken subset
        return None


def copy_style(src, dst):
    r, g, b, a = (ctypes.c_uint() for _ in range(4))
    pr.FPDFPageObj_GetFillColor(src, r, g, b, a)
    pr.FPDFPageObj_SetFillColor(dst, r.value, g.value, b.value, a.value)
    m = src.get_matrix()
    pr.FPDFPageObj_Transform(dst, m.a, m.b, m.c, m.d, m.e, m.f)


def load_ttf(doc, data: bytes):
    buf = (ctypes.c_uint8 * len(data)).from_buffer_copy(data)
    font = pr.FPDFText_LoadFont(doc, buf, len(data), pr.FPDF_FONT_TRUETYPE, 1)  # cid=1 -> Type0
    if not font:
        raise RuntimeError("FPDFText_LoadFont failed")
    return font, buf


def subset_ttf(path, chars: str) -> bytes:
    f = TTFont(str(path))
    opts = ft_subset.Options()
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    opts.layout_features = ["*"]  # keep mark positioning for stacked Vietnamese diacritics
    opts.drop_tables += ["FFTM"]  # FontForge timestamp table, not subsettable
    sub = ft_subset.Subsetter(opts)
    sub.populate(text=chars)
    sub.subset(f)
    out = io.BytesIO()
    f.save(out)
    return out.getvalue()


def variant(name: str, mode: str) -> dict:
    truth = json.loads((OUT / "corpus_truth.json").read_text())
    t = time.perf_counter()
    doc = pdfium.PdfDocument(str(CORPUS))
    page = doc[0]
    tp = page.get_textpage()
    obj = find_line(page, tp, "Đơn vị")
    info: dict = {}
    size = obj.get_font_size()
    if mode == "settext":
        pr.FPDFText_SetText(obj, wstr(NEW_TEXT))
    else:
        data = regular_font().read_bytes() if mode == "fullfont" else subset_ttf(regular_font(), VIETNAMESE + NEW_TEXT)
        info["embedded_font_bytes"] = len(data)
        font, keep = load_ttf(doc, data)
        new = pr.FPDFPageObj_CreateTextObj(doc, font, size)
        pr.FPDFText_SetText(new, wstr(NEW_TEXT))
        copy_style(obj, new)
        pr.FPDFPage_InsertObject(page, new)
        page.remove_obj(obj)
        info["_keep"] = keep
    tp.close()
    pr.FPDFPage_GenerateContent(page)
    raw = OUT / f"_e4_{name}_raw.pdf"
    doc.save(str(raw))
    del page, obj, tp
    doc.close()
    out = OUT / f"e4_{name}.pdf"
    pikepdf_gc(raw, out)
    info.pop("_keep", None)
    info["ms"] = round((time.perf_counter() - t) * 1000, 1)
    txt = " ".join(page_text(out)[0].split())
    info.update({
        "new_text_extractable": NEW_TEXT in txt,
        "old_text_gone": truth["edit_line"] not in txt,
        "size": out.stat().st_size,
        "size_delta_vs_corpus": out.stat().st_size - CORPUS.stat().st_size,
    })
    render_page(out, 0, OUT / f"e4_{name}.png", scale=2, crop_pt=(90, 750, 420, 800))
    return info


def coverage_report() -> dict:
    doc = pdfium.PdfDocument(str(CORPUS))
    page = doc[0]
    tp = page.get_textpage()
    obj = find_line(page, tp, "Đơn vị")
    font = pr.FPDFTextObj_GetFont(obj)
    key = font_data_key(font)
    cov = font_unicode_coverage(CORPUS, 0)[key]
    tounicode_chars = set(cov["codes"])
    cmap_chars = cmap_coverage(font_program(font))
    fam_n = pr.FPDFFont_GetFamilyName(font, None, 0)
    fam = ctypes.create_string_buffer(fam_n)
    pr.FPDFFont_GetFamilyName(font, fam, fam_n)
    res = {
        "font_base": cov["base"], "font_subtype": cov["subtype"], "subset": cov["subset"],
        "family": fam.value.decode(), "weight": pr.FPDFFont_GetWeight(font),
        "chars_via_tounicode": len(tounicode_chars),
        "missing_for_new_text_tounicode": "".join(sorted(set(NEW_TEXT) - tounicode_chars)),
        "chars_via_embedded_cmap": None if cmap_chars is None else len(cmap_chars),
        "missing_for_new_text_cmap": None if cmap_chars is None else "".join(sorted(set(NEW_TEXT) - cmap_chars)),
        "full_vietnamese_covered_by_subset": set(VIETNAMESE) <= tounicode_chars,
    }
    tp.close()
    del obj, page
    doc.close()
    return res


def main() -> None:
    res = {"coverage": coverage_report()}
    for name, mode in (("a_settext_subset_font", "settext"), ("b_loadfont_full_ttf", "fullfont"),
                       ("c_loadfont_fonttools_subset", "subset")):
        res[name] = variant(name, mode)
    render_page(CORPUS, 0, OUT / "e4_before.png", scale=2, crop_pt=(90, 750, 420, 800))
    (OUT / "e4_results.json").write_text(json.dumps(res, ensure_ascii=False, indent=2))
    print(json.dumps(res, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
