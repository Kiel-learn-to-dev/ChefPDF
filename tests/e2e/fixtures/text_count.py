"""Counts the text characters of every page of a PDF, read with pypdfium2 (the same measure as the
demo checks). Prints JSON {"pages": n, "textChars": m}. Usage: python text_count.py FILE.pdf"""

import json
import sys

import pypdfium2 as pdfium

pdf = pdfium.PdfDocument(sys.argv[1])
chars = sum(len(pdf[i].get_textpage().get_text_range()) for i in range(len(pdf)))
print(json.dumps({"pages": len(pdf), "textChars": chars}))
