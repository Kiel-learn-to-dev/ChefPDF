"""pikepdf helpers that fill gaps in the PDFium edit API (found in S2-3/S2-4).

* inline_forms(): PDFium edits Form XObject children in memory but never rewrites the
  form's stream (and prunes its resources). Inlining the forms into the page content
  first turns every object into a page-level object that FPDFPage_GenerateContent owns.
* tounicode_map(): reverse ToUnicode CMap, to produce char codes for
  FPDFText_SetCharcodes when FPDFText_SetText picks wrong codes (CID subset fonts).
"""

from __future__ import annotations

import re
from pathlib import Path

import pikepdf

RES_KINDS = ("/Font", "/XObject", "/ExtGState", "/ColorSpace", "/Pattern", "/Shading", "/Properties")
# operator -> (resource kind, operand index holding the name)
NAME_OPS = {"Tf": ("/Font", 0), "Do": ("/XObject", 0), "gs": ("/ExtGState", 0),
            "cs": ("/ColorSpace", 0), "CS": ("/ColorSpace", 0), "sh": ("/Shading", 0)}


def _rename_tokens(tokens, mapping: dict[tuple[str, str], pikepdf.Name]):
    out = []
    for operands, op in tokens:
        o = str(op)
        ops = list(operands)
        if o in NAME_OPS:
            kind, idx = NAME_OPS[o]
            if idx < len(ops) and isinstance(ops[idx], pikepdf.Name):
                ops[idx] = mapping.get((kind, str(ops[idx])), ops[idx])
        elif o in ("scn", "SCN") and ops and isinstance(ops[-1], pikepdf.Name):
            ops[-1] = mapping.get(("/Pattern", str(ops[-1])), ops[-1])
        elif o in ("BDC", "DP") and len(ops) > 1 and isinstance(ops[1], pikepdf.Name):
            ops[1] = mapping.get(("/Properties", str(ops[1])), ops[1])
        out.append((ops, op))
    return out


def _strip_actualtext(tokens):
    """Drop `/Span <</ActualText ...>> BDC` ... matching `EMC` (keep the content inside).
    PDFium's textpage replaces the glyphs of such a span by the ActualText string
    *without per-glyph positions* (all chars report the span's origin), which breaks
    char-level redaction/editing. Verified on the pyHanko-stamped corpus line."""
    out, stack = [], []
    for operands, op in tokens:
        o = str(op)
        if o in ("BDC", "BMC"):
            drop = (o == "BDC" and len(operands) > 1 and isinstance(operands[1], pikepdf.Dictionary)
                    and "/ActualText" in operands[1])
            stack.append(drop)
            if drop:
                continue
        elif o == "EMC":
            if stack and stack.pop():
                continue
        out.append((operands, op))
    return out


def inline_forms(src: Path, dst: Path, page_index: int, only=None, *, strip_actualtext: bool = True) -> int:
    """Replace `/Fm Do` on one page by `q [Matrix] cm [BBox clip] <form ops> Q`.
    Nested forms are handled recursively. Returns the number of forms inlined.
    Optionally strips ActualText spans (see _strip_actualtext)."""
    count = 0
    with pikepdf.open(src) as pdf:
        page = pdf.pages[page_index]
        res = page.Resources

        def sub(d, key):  # pikepdf.Dictionary has no setdefault
            if key not in d:
                d[key] = pikepdf.Dictionary()
            return d[key]

        def expand(tokens, resources, depth=0):
            nonlocal count
            out = []
            for operands, op in tokens:
                if str(op) == "Do":
                    xo = resources.get("/XObject", {}).get(operands[0])
                    if xo is not None and xo.get("/Subtype") == "/Form" and depth < 8 and (
                            only is None or str(operands[0]) in only):
                        count += 1
                        fres = xo.get("/Resources", resources)
                        mapping = {}
                        for kind in RES_KINDS:
                            for k, v in fres.get(kind, {}).items():
                                new = pikepdf.Name(f"/I{count}_{k[1:]}")
                                sub(res, kind)[new] = v
                                mapping[(kind, k)] = new
                        inner = _rename_tokens(pikepdf.parse_content_stream(xo), mapping)
                        out.append(([], pikepdf.Operator("q")))
                        m = xo.get("/Matrix", [1, 0, 0, 1, 0, 0])
                        out.append(([*m], pikepdf.Operator("cm")))
                        x0, y0, x1, y1 = (float(v) for v in xo.BBox)
                        out.append(([x0, y0, x1 - x0, y1 - y0], pikepdf.Operator("re")))
                        out.append(([], pikepdf.Operator("W")))
                        out.append(([], pikepdf.Operator("n")))
                        out += expand(inner, res, depth + 1)
                        out.append(([], pikepdf.Operator("Q")))
                        continue
                out.append((operands, op))
            return out

        tokens = expand(pikepdf.parse_content_stream(page), res)
        if strip_actualtext:
            tokens = _strip_actualtext(tokens)
        page.Contents = pdf.make_stream(pikepdf.unparse_content_stream(tokens))
        # drop the now-unused form entries so the old form streams become unreachable
        pdf.remove_unreferenced_resources()
        pdf.save(dst)
    return count


def _hex_to_int(h: bytes) -> int:
    return int(h, 16)


def _hex_to_str(h: bytes) -> str:
    return bytes.fromhex(h.decode()).decode("utf-16-be", errors="replace")


def tounicode_map(cmap: bytes) -> dict[int, str]:
    """Minimal ToUnicode CMap parser (bfchar + bfrange, incl. array form)."""
    m: dict[int, str] = {}
    for block in re.findall(rb"beginbfchar(.*?)endbfchar", cmap, re.S):
        for src, dst in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", block):
            m[_hex_to_int(src)] = _hex_to_str(dst)
    for block in re.findall(rb"beginbfrange(.*?)endbfrange", cmap, re.S):
        for lo, hi, rest in re.findall(rb"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[^\]]*\]|<[0-9A-Fa-f]+>)", block):
            lo_i, hi_i = _hex_to_int(lo), _hex_to_int(hi)
            if rest.startswith(b"["):
                for i, d in enumerate(re.findall(rb"<([0-9A-Fa-f]+)>", rest)):
                    m[lo_i + i] = _hex_to_str(d)
            else:
                base = bytes.fromhex(rest[1:-1].decode())
                for i in range(hi_i - lo_i + 1):
                    val = base[:-2] + (int.from_bytes(base[-2:], "big") + i).to_bytes(2, "big")
                    m[lo_i + i] = val.decode("utf-16-be", errors="replace")
    return m


def font_program_key(data: bytes) -> str:
    import hashlib

    return hashlib.sha1(data).hexdigest()[:16]


def _font_program(f) -> bytes | None:
    fd = f.get("/FontDescriptor")
    if fd is None and "/DescendantFonts" in f:
        fd = f.DescendantFonts[0].get("/FontDescriptor")
    if fd is None:
        return None
    for k in ("/FontFile2", "/FontFile3", "/FontFile"):
        if k in fd:
            return fd[k].read_bytes()
    return None


def font_unicode_coverage(pdf_path: Path, page_index: int) -> dict[str, dict]:
    """Embedded-font-program hash -> {'codes': {unicode_char: code}, 'base', 'subset', 'subtype'}.
    Keyed by the font program (not the name): PDFium's FPDFFont_GetBaseFontName strips
    the subset tag of simple fonts and returns the descendant name for Type0 fonts, so
    two different fonts can report the same name (verified on the corpus). Match with
    FPDFFont_GetFontData instead. Covers fonts of Form XObjects used by the page too."""
    out: dict[str, dict] = {}
    with pikepdf.open(pdf_path) as pdf:
        def scan(resources):
            for _, f in resources.get("/Font", {}).items():
                base = str(f.get("/BaseFont", ""))[1:]
                prog = _font_program(f)
                if prog is None:
                    continue  # non-embedded font: cannot reuse safely
                info = out.setdefault(font_program_key(prog), {
                    "codes": {}, "base": base, "subtype": str(f.get("/Subtype")),
                    "subset": bool(re.match(r"^[A-Z]{6}\+", base))})
                tu = f.get("/ToUnicode")
                if isinstance(tu, pikepdf.Stream):
                    for code, s in tounicode_map(tu.read_bytes()).items():
                        if len(s) == 1:
                            info["codes"].setdefault(s, code)
            for _, x in resources.get("/XObject", {}).items():
                if x.get("/Subtype") == "/Form" and "/Resources" in x:
                    scan(x.Resources)

        scan(pdf.pages[page_index].Resources)
    return out
