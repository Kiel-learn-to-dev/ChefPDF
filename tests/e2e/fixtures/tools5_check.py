"""Checks of tools5.spec.ts on a saved file. Prints one JSON object.

Usage: python tools5_check.py FILE MODE [PAGE]
  MODE 'info'  : page count and whether the file opens.
  MODE 'meta'  : the /Author of the document, or null.
  MODE 'title' : the /Title of the document, or null.
  MODE 'attachments': names of the embedded files.
  MODE 'linear': whether the file is linearized, and its page count.
  MODE 'pagetexts': the text of every page.
  MODE 'sizes' : the visible size of every page in points.
  MODE 'clean' : whether the file reads without recovery, and its page count.
  MODE 'encrypted': whether the file needs a password to open.
  MODE 'images': image files of a folder with format and pixel size.
  MODE 'dir'   : FILE is a folder; lists its PDFs with page counts.
  MODE 'gray'  : renders PAGE (1-based) and reports the largest colour difference of any pixel.
"""

import json
import sys
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium

path, mode = sys.argv[1], sys.argv[2]

if mode == "meta":
    with pikepdf.open(path) as pdf:
        author = pdf.docinfo.get("/Author")
        print(json.dumps({"author": str(author) if author is not None else None}))
elif mode == "title":
    with pikepdf.open(path) as pdf:
        title = pdf.docinfo.get("/Title")
        print(json.dumps({"title": str(title) if title is not None else None}))
elif mode == "attachments":
    with pikepdf.open(path) as pdf:
        print(json.dumps({"names": sorted(pdf.attachments.keys())}))
elif mode == "linear":
    with pikepdf.open(path) as pdf:
        print(json.dumps({"linearized": pdf.is_linearized, "pages": len(pdf.pages)}))
elif mode == "pagetexts":
    doc = pdfium.PdfDocument(path)
    texts = [doc[i].get_textpage().get_text_range().strip() for i in range(len(doc))]
    print(json.dumps({"texts": texts}))
elif mode == "sizes":
    # Visible size of every page (CropBox and rotation included), rounded to whole points.
    doc = pdfium.PdfDocument(path)
    print(json.dumps({"sizes": [[round(v) for v in doc[i].get_size()] for i in range(len(doc))]}))
elif mode == "clean":
    # Whether the file reads without any recovery (qpdf would otherwise rebuild its xref table).
    try:
        with pikepdf.open(path, attempt_recovery=False) as pdf:
            print(json.dumps({"clean": True, "pages": len(pdf.pages)}))
    except pikepdf.PdfError:
        print(json.dumps({"clean": False, "pages": None}))
elif mode == "encrypted":
    try:
        with pikepdf.open(path) as pdf:
            print(json.dumps({"encrypted": pdf.is_encrypted, "pages": len(pdf.pages)}))
    except pikepdf.PasswordError:
        print(json.dumps({"encrypted": True, "pages": None}))
elif mode == "images":
    # Every image file of the folder PATH: name, format and pixel size.
    from PIL import Image

    found = []
    for item in sorted(Path(path).iterdir()):
        with Image.open(item) as img:
            found.append({"name": item.name, "format": img.format, "size": list(img.size)})
    print(json.dumps({"images": found}))
elif mode == "info":
    with pikepdf.open(path) as pdf:
        print(json.dumps({"pages": len(pdf.pages), "opens": True}))
elif mode == "dir":
    # Every PDF of the folder PATH with its page count, sorted by file name.
    folder = Path(path)
    found = []
    for item in sorted(folder.glob("*.pdf")):
        with pikepdf.open(item) as pdf:
            found.append({"name": item.name, "pages": len(pdf.pages)})
    print(json.dumps({"files": found}))
elif mode == "gray":
    page_no = int(sys.argv[3]) if len(sys.argv) > 3 else 1
    doc = pdfium.PdfDocument(path)
    bitmap = doc[page_no - 1].render(scale=1).to_pil().convert("RGB")
    data = bitmap.tobytes()
    worst = 0
    for r, g, b in zip(data[0::3], data[1::3], data[2::3]):
        worst = max(worst, abs(r - g), abs(g - b), abs(r - b))
    print(json.dumps({"maxChannelSpread": worst, "pixels": bitmap.width * bitmap.height}))
else:
    raise SystemExit(f"unknown mode {mode}")
