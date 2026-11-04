"""Prints the state of a PDF as JSON: pages, text characters (pdfium), signature fields, annotations.

Usage (core environment): python -I pdf_state.py FILE
"""

import json
import sys

import pikepdf
import pypdfium2 as pdfium


def main() -> None:
    path = sys.argv[1]
    with pikepdf.open(path) as pdf:
        acro = pdf.Root.get("/AcroForm")
        sig_fields = 0
        if acro is not None and "/Fields" in acro:
            sig_fields = sum(1 for f in acro.Fields if f.get("/FT") == "/Sig")
        annots = sum(len(p.get("/Annots", [])) for p in pdf.pages)
        pages = len(pdf.pages)
    chars = 0
    with pdfium.PdfDocument(path) as doc:
        for i in range(len(doc)):
            chars += len(doc[i].get_textpage().get_text_range())
    print(
        json.dumps(
            {
                "pages": pages,
                "textChars": chars,
                "acroform": acro is not None,
                "sigFields": sig_fields,
                "annots": annots,
            }
        )
    )


if __name__ == "__main__":
    main()
