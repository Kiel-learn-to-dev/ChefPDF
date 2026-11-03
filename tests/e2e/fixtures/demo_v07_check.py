"""Checks of demo-v07.spec.ts on a saved file. Prints one JSON object.

Usage: python demo_v07_check.py FILE MODE [ARGS]
  MODE 'glyphs PAGE TEXT' : characters of TEXT (spaces ignored) that NO embedded font of the page
                            has in its cmap. The text can read right in pdfium while the glyph is
                            missing (a notdef box), so this reads the font programs themselves.
  MODE 'opens'            : the file opens with pikepdf and pdfium; prints the page count.
"""

import io
import json
import sys

import pikepdf
import pypdfium2 as pdfium
from fontTools.ttLib import TTFont

path, mode = sys.argv[1], sys.argv[2]


def embedded_cmap_chars(page_obj: pikepdf.Object) -> tuple[set[int], int]:
    """Unicode code points that the embedded font programs of one page map to a glyph."""
    codes: set[int] = set()
    fonts = 0
    resources = page_obj.get("/Resources", {})
    for font in resources.get("/Font", {}).values():
        if font.get("/Subtype") == "/Type0":
            font = font.DescendantFonts[0]
        descriptor = font.get("/FontDescriptor")
        if descriptor is None:
            continue
        for key in ("/FontFile2", "/FontFile3"):
            stream = descriptor.get(key)
            if stream is None:
                continue
            # A font program that cannot be parsed raises: the check must fail, not pass silently.
            ttf = TTFont(io.BytesIO(stream.read_bytes()), lazy=True)
            for table in ttf["cmap"].tables:
                codes.update(table.cmap.keys())
            fonts += 1
    return codes, fonts


if mode == "glyphs":
    index = int(sys.argv[3])
    text = sys.argv[4]
    with pikepdf.open(path) as pdf:
        codes, fonts = embedded_cmap_chars(pdf.pages[index].obj)
    missing = sorted({c for c in text if not c.isspace() and ord(c) not in codes})
    print(json.dumps({"missing": missing, "fonts": fonts}, ensure_ascii=False))
elif mode == "opens":
    with pikepdf.open(path) as pdf:
        pikepdf_pages = len(pdf.pages)
    doc = pdfium.PdfDocument(path)
    pdfium_pages = len(doc)
    doc.close()
    print(json.dumps({"pikepdf_pages": pikepdf_pages, "pdfium_pages": pdfium_pages}))
else:
    raise SystemExit(f"unknown mode {mode}")
