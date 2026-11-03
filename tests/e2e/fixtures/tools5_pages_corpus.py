"""Generates the PDFs of tools5-pages.spec.ts (run with the core environment: uv run).

Every page carries a short text (T1, S1, ...) so the tests can tell the pages apart.

Usage: python tools5_pages_corpus.py OUT_DIR
"""

import sys
from pathlib import Path

import pikepdf

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)


def build(name: str, labels: list[str]) -> None:
    pdf = pikepdf.new()
    font = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica
        )
    )
    for label in labels:
        pdf.add_blank_page(page_size=(612, 792))
        page = pdf.pages[-1]
        page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
        page.Contents = pdf.make_stream(f"BT /F1 48 Tf 100 400 Td ({label}) Tj ET".encode())
    pdf.save(out / name)


build("rep_target.pdf", ["T1", "T2", "T3"])
build("rep_source.pdf", ["S1"])
build("crop.pdf", ["C1"])
build("resize.pdf", ["R1"])
build("split.pdf", ["P1", "P2"])
build("menu_pages.pdf", ["M1", "M2", "M3", "M4"])
print("ok")
