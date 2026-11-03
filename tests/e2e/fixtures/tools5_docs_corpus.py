"""Generates the PDFs of tools5-docs.spec.ts (run with the core environment: uv run).

Each test gets its own copy, because the tests save over the file they open.

Usage: python tools5_docs_corpus.py OUT_DIR
"""

import sys
import zlib
from pathlib import Path

import pikepdf

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)

TEXT = b"BT /F1 24 Tf 72 700 Td (Hello Chef PDF) Tj ET q 200 0 0 100 72 500 cm /Im1 Do Q"


def build(path: Path, attachment: bool = False) -> None:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    page = pdf.pages[0]
    font = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica
        )
    )
    raw = bytes(v for y in range(40) for x in range(80) for v in (x * 3 % 256, y * 5 % 256, 128))
    image = pdf.make_stream(
        zlib.compress(raw),
        Type=pikepdf.Name.XObject,
        Subtype=pikepdf.Name.Image,
        Width=80,
        Height=40,
        ColorSpace=pikepdf.Name.DeviceRGB,
        BitsPerComponent=8,
        Filter=pikepdf.Name.FlateDecode,
    )
    page.Resources = pikepdf.Dictionary(
        Font=pikepdf.Dictionary(F1=font), XObject=pikepdf.Dictionary(Im1=image)
    )
    page.Contents = pdf.make_stream(TEXT)
    if attachment:
        pdf.attachments["note.txt"] = pikepdf.AttachedFileSpec(
            pdf, b"attached note", description="a note"
        )
    pdf.save(path)


build(out / "docs_meta.pdf")
build(out / "docs_attach.pdf", attachment=True)
build(out / "docs_extract.pdf")
build(out / "docs_web.pdf")
(out / "extra.txt").write_text("extra attachment", encoding="utf8")
print("ok")
