#!/usr/bin/env python3
"""Create reproducible 1,000-page PDF fixtures for R1.37/R1.38 memory runs."""

from __future__ import annotations

import argparse
import shutil
import tempfile
from pathlib import Path

from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


def create_pdf(destination: Path, pages: int) -> None:
    pdf = canvas.Canvas(str(destination), pagesize=letter, pageCompression=1)
    width, height = letter
    for page in range(1, pages + 1):
        pdf.setFont("Helvetica", 11)
        pdf.drawString(48, height - 52, f"Chef PDF memory fixture — page {page:04d} of {pages}")
        pdf.setStrokeColorRGB(0.72, 0.75, 0.8)
        pdf.line(48, height - 64, width - 48, height - 64)
        pdf.setFont("Helvetica", 9)
        for row in range(12):
            pdf.drawString(
                48,
                height - 92 - row * 34,
                f"Page {page:04d}; sample row {row + 1:02d}; text and vector content for scrolling/rendering.",
            )
        pdf.showPage()
    pdf.save()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="stable output directory outside the repository and temp")
    parser.add_argument("--force", action="store_true", help="replace files already in the output directory")
    args = parser.parse_args()

    output = args.output.expanduser().resolve()
    repo = Path(__file__).resolve().parents[1]
    temp = Path(tempfile.gettempdir()).resolve()
    if output == repo or repo in output.parents:
        parser.error(f"output must be outside the repository: {output}")
    if output == temp or temp in output.parents:
        parser.error(f"output must be outside the temporary directory: {output}")

    names = ["pages1000.pdf", *(f"tab{i}.pdf" for i in range(1, 6))]
    existing = [output / name for name in names if (output / name).exists()]
    if existing and not args.force:
        parser.error("refusing to overwrite existing fixtures; pass --force: " + ", ".join(map(str, existing)))

    output.mkdir(parents=True, exist_ok=True)
    source = output / names[0]
    create_pdf(source, 1000)
    for name in names[1:]:
        shutil.copyfile(source, output / name)
    print(f"Created 1,000-page fixture and five tab copies in {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
