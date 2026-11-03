"""Generates the PDFs of tools5-convert.spec.ts (run with the core environment: uv run).

Usage: python tools5_convert_corpus.py OUT_DIR
"""

import sys
from pathlib import Path

import pikepdf

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)

RED = b"1 0 0 rg 60 500 240 200 re f"
BLUE = b"0 0 1 rg 320 500 240 200 re f"


def build(name: str, contents: list[bytes], **save_args) -> None:
    pdf = pikepdf.new()
    for content in contents:
        pdf.add_blank_page(page_size=(612, 792))
        pdf.pages[-1].Contents = pdf.make_stream(content)
    pdf.save(out / name, **save_args)


# Two pages, one red and one blue, for PDF -> images.
build("two_pages.pdf", [RED, BLUE])

# A password-protected file (AES-256) whose protection the test removes.
build(
    "locked.pdf",
    [RED],
    encryption=pikepdf.Encryption(user="chefpass1", owner="chefowner1", R=6),
)

# A damaged file: a good 2-page file whose cross-reference table and trailer were cut off.
build("broken_source.pdf", [RED, BLUE])
data = (out / "broken_source.pdf").read_bytes()
cut = data.rfind(b"xref")
if cut < 0:
    raise SystemExit("no xref table found; the damaged sample cannot be made")
(out / "broken.pdf").write_bytes(data[:cut])
(out / "broken_source.pdf").unlink()
print("ok")
