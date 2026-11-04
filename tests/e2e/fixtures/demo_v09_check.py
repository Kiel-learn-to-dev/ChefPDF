"""Checks one demo-v09 output from the file itself, not from the app (run with the core environment).

Usage:
  python demo_v09_check.py pdf FILE.pdf CERT.der   -> pages, bytes, text characters, signatures
  python demo_v09_check.py docx FILE.docx          -> paragraphs and tables of a Word file

For a PDF, each signature is validated with pyHanko against CERT.der as the only trust root:
intact = the signed bytes did not change; trusted = the chain reaches the trust root.
Text characters 0 means every page is an image: the scan step ran before the signature.
"""

import json
import sys
from pathlib import Path

import pypdfium2 as pdfium


def check_pdf(path: Path, cert_path: Path) -> dict:
    from asn1crypto import x509 as ax509
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign.validation import validate_pdf_signature
    from pyhanko_certvalidator import ValidationContext

    pdf = pdfium.PdfDocument(str(path))
    text_chars = 0
    for index in range(len(pdf)):
        text_chars += len(pdf[index].get_textpage().get_text_range())
    report = {"pages": len(pdf), "bytes": path.stat().st_size, "textChars": text_chars}
    trust_root = ax509.Certificate.load(cert_path.read_bytes())
    with path.open("rb") as handle:
        reader = PdfFileReader(handle)
        signatures = []
        for embedded in reader.embedded_signatures:
            status = validate_pdf_signature(
                embedded, ValidationContext(trust_roots=[trust_root], allow_fetching=False)
            )
            signatures.append(
                {
                    "field": embedded.field_name,
                    "intact": bool(status.intact),
                    "valid": bool(status.valid),
                    "trusted": bool(status.trusted),
                }
            )
    report["signatures"] = signatures
    return report


def check_docx(path: Path) -> dict:
    import docx

    document = docx.Document(str(path))
    return {
        "bytes": path.stat().st_size,
        "paragraphs": len([p for p in document.paragraphs if p.text.strip()]),
        "tables": len(document.tables),
    }


if __name__ == "__main__":
    kind, target = sys.argv[1], Path(sys.argv[2])
    if kind == "pdf":
        result = check_pdf(target, Path(sys.argv[3]))
    elif kind == "docx":
        result = check_docx(target)
    else:
        raise SystemExit(f"unknown kind: {kind}")
    print(json.dumps(result, ensure_ascii=False))
