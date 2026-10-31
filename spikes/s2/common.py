"""Shared paths and helpers for spike S2."""

from __future__ import annotations

import ctypes
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium
import pypdfium2.raw as pr

S2_DIR = Path(__file__).resolve().parent
OUT = S2_DIR / "out"
CORPUS = OUT / "corpus.pdf"
TRUTH = OUT / "corpus_truth.json"

OBJ_TYPES = {
    pr.FPDF_PAGEOBJ_TEXT: "text",
    pr.FPDF_PAGEOBJ_PATH: "path",
    pr.FPDF_PAGEOBJ_IMAGE: "image",
    pr.FPDF_PAGEOBJ_SHADING: "shading",
    pr.FPDF_PAGEOBJ_FORM: "form",
}


def obj_type(obj) -> str:
    return OBJ_TYPES.get(obj.type, f"?{obj.type}")


def text_of(obj, textpage) -> str:
    n = pr.FPDFTextObj_GetText(obj, textpage, None, 0)
    if n <= 2:
        return ""
    buf = ctypes.create_string_buffer(n)
    pr.FPDFTextObj_GetText(obj, textpage, ctypes.cast(buf, ctypes.POINTER(pr.FPDF_WCHAR)), n)
    return buf.raw[: n - 2].decode("utf-16-le")


def marks_of(obj) -> list[str]:
    """Marked-content tags around a page object, e.g. ['Artifact{Subtype=Watermark}']."""
    out = []
    for i in range(pr.FPDFPageObj_CountMarks(obj)):
        m = pr.FPDFPageObj_GetMark(obj, i)
        n = ctypes.c_ulong()
        pr.FPDFPageObjMark_GetName(m, None, 0, ctypes.byref(n))
        buf = ctypes.create_string_buffer(n.value)
        pr.FPDFPageObjMark_GetName(m, ctypes.cast(buf, ctypes.POINTER(pr.FPDF_WCHAR)), n.value, ctypes.byref(n))
        name = buf.raw[: n.value - 2].decode("utf-16-le")
        params = {}
        for j in range(pr.FPDFPageObjMark_CountParams(m)):
            kn = ctypes.c_ulong()
            pr.FPDFPageObjMark_GetParamKey(m, j, None, 0, ctypes.byref(kn))
            kb = ctypes.create_string_buffer(kn.value)
            pr.FPDFPageObjMark_GetParamKey(m, j, ctypes.cast(kb, ctypes.POINTER(pr.FPDF_WCHAR)), kn.value, ctypes.byref(kn))
            key = kb.raw[: kn.value - 2].decode("utf-16-le")
            vtype = pr.FPDFPageObjMark_GetParamValueType(m, key.encode())
            vn = ctypes.c_ulong()
            if vtype == pr.FPDF_OBJECT_STRING and pr.FPDFPageObjMark_GetParamStringValue(
                    m, key.encode(), None, 0, ctypes.byref(vn)):
                vb = ctypes.create_string_buffer(vn.value)
                pr.FPDFPageObjMark_GetParamStringValue(
                    m, key.encode(), ctypes.cast(vb, ctypes.POINTER(pr.FPDF_WCHAR)), vn.value, ctypes.byref(vn))
                params[key] = vb.raw[: vn.value - 2].decode("utf-16-le")
            else:
                # Verified: PDFium's mark API cannot return *name* values such as
                # /Subtype /Watermark (String/Blob getters both fail). Use pikepdf.
                params[key] = "<name?>" if vtype == pr.FPDF_OBJECT_NAME else f"<type {vtype}>"
        out.append(name + (("{" + ",".join(f"{k}={v}" for k, v in params.items()) + "}") if params else ""))
    return out


def fill_alpha(obj) -> int:
    r, g, b, a = (ctypes.c_uint() for _ in range(4))
    if pr.FPDFPageObj_GetFillColor(obj, r, g, b, a):
        return a.value
    return 255


def rotation_deg(obj) -> float:
    import math

    m = obj.get_matrix()
    return round(math.degrees(math.atan2(m.b, m.a)), 1)


def page_text(pdf_path: Path) -> list[str]:
    doc = pdfium.PdfDocument(str(pdf_path))
    try:
        out = []
        for page in doc:
            tp = page.get_textpage()
            out.append(tp.get_text_range())
        return out
    finally:
        doc.close()


def pikepdf_gc(src: Path, dst: Path) -> None:
    """Full rewrite through qpdf: only objects reachable from the trailer survive."""
    with pikepdf.open(src) as p:
        p.save(dst, compress_streams=True, object_stream_mode=pikepdf.ObjectStreamMode.generate)
