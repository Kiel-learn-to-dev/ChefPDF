"""Checks of redact.spec.ts on a saved file. Prints one JSON object.

Usage: python redact_check.py FILE MODE [NEEDLE]
  MODE 'text'     : the text of every page.
  MODE 'contains' : whether NEEDLE (ASCII) is in the page content streams (overlay marker).
  MODE 'pages'    : for each page, how many times NEEDLE is in its page content streams.
"""

import json
import sys

import pikepdf
import pypdfium2 as pdfium

path, mode = sys.argv[1], sys.argv[2]

if mode == "text":
    doc = pdfium.PdfDocument(path)
    text = "\n".join(doc[i].get_textpage().get_text_range() for i in range(len(doc)))
    print(json.dumps({"text": text}))
elif mode == "contains":
    needle = sys.argv[3].encode()
    found = False
    with pikepdf.open(path) as pdf:
        for page in pdf.pages:
            page.contents_coalesce()
            if needle in bytes(page.Contents.read_bytes()):
                found = True
    print(json.dumps({"found": found}))
elif mode == "pages":
    needle = sys.argv[3].encode()
    counts = []
    with pikepdf.open(path) as pdf:
        for page in pdf.pages:
            page.contents_coalesce()
            counts.append(bytes(page.Contents.read_bytes()).count(needle))
    print(json.dumps({"counts": counts}))
else:
    raise SystemExit(f"unknown mode {mode}")
