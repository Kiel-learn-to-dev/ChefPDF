"""Checks of textedit.spec.ts and annots.spec.ts on a saved file. Prints one JSON object.

Usage: python textedit_check.py FILE MODE [ARGS]
  MODE 'text PAGE'            : the text of a page (0-based), as pdfium extracts it.
  MODE 'links'                : the URI of every /Link annotation of page 1.
  MODE 'annots PAGE'          : the subtypes of the annotations of a page (links excluded).
  MODE 'yellow PAGE X0 Y0 X1 Y1' : number of yellow pixels in a box (points, top-left origin) of a
                                page rendered at 1 pt = 1 px. A highlight over white paper gives
                                many; black text and white paper give none.
"""

import json
import sys

import pikepdf
import pypdfium2 as pdfium
import pypdfium2.raw as pdfium_raw

path, mode = sys.argv[1], sys.argv[2]

if mode == "font-size":
    page_index = int(sys.argv[3])
    needle = sys.argv[4]
    doc = pdfium.PdfDocument(path)
    page = doc[page_index]
    tp = page.get_textpage()
    chars = "".join(chr(pdfium_raw.FPDFText_GetUnicode(tp.raw, i)) for i in range(tp.count_chars()))
    index = chars.index(needle)
    size = pdfium_raw.FPDFText_GetFontSize(tp.raw, index)
    tp.close()
    page.close()
    doc.close()
    print(json.dumps({"size": size}))
elif mode == "text":
    page_index = int(sys.argv[3])
    doc = pdfium.PdfDocument(path)
    page = doc[page_index]
    tp = page.get_textpage()
    text = tp.get_text_range()
    tp.close()
    page.close()
    doc.close()
    print(json.dumps({"text": text}))
elif mode == "links":
    with pikepdf.open(path) as pdf:
        uris = []
        for annot in pdf.pages[0].obj.get("/Annots", []):
            if annot.get("/Subtype") == "/Link":
                action = annot.get("/A")
                if action is not None and action.get("/S") == "/URI":
                    uris.append(str(action.get("/URI")))
        print(json.dumps({"uris": uris}))
elif mode == "annots":
    index = int(sys.argv[3])
    with pikepdf.open(path) as pdf:
        subtypes = [
            str(a.get("/Subtype"))[1:]
            for a in pdf.pages[index].obj.get("/Annots", [])
            if a.get("/Subtype") != "/Link"
        ]
        print(json.dumps({"subtypes": subtypes}))
elif mode == "yellow":
    index = int(sys.argv[3])
    x0, y0, x1, y1 = (int(v) for v in sys.argv[4:8])
    doc = pdfium.PdfDocument(path)
    bitmap = doc[index].render(scale=1).to_pil().convert("RGB")
    count = 0
    for x in range(x0, x1):
        for y in range(y0, y1):
            r, g, b = bitmap.getpixel((x, y))
            if r > 200 and g > 180 and b < 170:
                count += 1
    doc.close()
    print(json.dumps({"yellow": count}))
else:
    raise SystemExit(f"unknown mode {mode}")
