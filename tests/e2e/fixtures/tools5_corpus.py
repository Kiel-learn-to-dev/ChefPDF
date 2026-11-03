"""Generates the PDFs and PNGs of tools5.spec.ts (run with the core environment: uv run).

Usage: python tools5_corpus.py OUT_DIR
"""

import io
import random
import sys
from pathlib import Path

import pikepdf
from PIL import Image, ImageDraw

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)

COLOUR = (
    b"1 0 0 rg 60 500 240 200 re f 0 0 1 rg 320 500 240 200 re f 0 0.6 0 rg 60 150 500 200 re f"
)


def colour_page(pdf: pikepdf.Pdf, content: bytes = COLOUR) -> None:
    pdf.add_blank_page(page_size=(612, 792))
    pdf.pages[-1].Contents = pdf.make_stream(content)


def write(name: str, build) -> None:
    pdf = pikepdf.new()
    build(pdf)
    pdf.save(out / name)


# A one-page colour document (colour conversion, security).
write("colour.pdf", colour_page)
write("secure.pdf", colour_page)


def with_author(pdf: pikepdf.Pdf) -> None:
    colour_page(pdf)
    pdf.docinfo["/Author"] = "Chef Test Author"
    pdf.docinfo["/Producer"] = "Chef Test Producer"


write("meta.pdf", with_author)


def mixed(pdf: pikepdf.Pdf) -> None:
    colour_page(pdf)
    pdf.add_blank_page(page_size=(612, 792))  # blank: no content at all
    colour_page(pdf)


write("blank_mixed.pdf", mixed)
write("preflight_mixed.pdf", mixed)  # its own copy: the blank-pages test saves over blank_mixed


def heavy(pdf: pikepdf.Pdf) -> None:
    # A large, noisy JPEG: the 'screen' preset resamples it, so the file gets smaller.
    rnd = random.Random(7)
    img = Image.new("RGB", (1500, 1500))
    draw = ImageDraw.Draw(img)
    for y in range(0, 1500, 3):
        draw.line([(0, y), (1500, y)], fill=(rnd.randrange(256), rnd.randrange(256), y % 256))
    for _ in range(4000):
        x, y = rnd.randrange(1500), rnd.randrange(1500)
        draw.point((x, y), fill=(rnd.randrange(256), rnd.randrange(256), rnd.randrange(256)))
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=95)
    pdf.add_blank_page(page_size=(612, 792))
    xobj = pdf.make_stream(
        buf.getvalue(),
        Type=pikepdf.Name.XObject,
        Subtype=pikepdf.Name.Image,
        Width=1500,
        Height=1500,
        ColorSpace=pikepdf.Name.DeviceRGB,
        BitsPerComponent=8,
        Filter=pikepdf.Name.DCTDecode,
    )
    pdf.pages[-1].Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im1=xobj))
    pdf.pages[-1].Contents = pdf.make_stream(b"q 612 0 0 792 0 0 cm /Im1 Do Q")


write("image_heavy.pdf", heavy)


def big_scan(pdf: pikepdf.Pdf) -> None:
    # Three pages of pure noise JPEG: well over 2 MB in total, and it shrinks a lot when resampled.
    rnd = random.Random(11)
    for _ in range(3):
        img = Image.frombytes("RGB", (1600, 1600), rnd.randbytes(1600 * 1600 * 3))
        buf = io.BytesIO()
        img.save(buf, "JPEG", quality=90)
        pdf.add_blank_page(page_size=(612, 792))
        xobj = pdf.make_stream(
            buf.getvalue(),
            Type=pikepdf.Name.XObject,
            Subtype=pikepdf.Name.Image,
            Width=1600,
            Height=1600,
            ColorSpace=pikepdf.Name.DeviceRGB,
            BitsPerComponent=8,
            Filter=pikepdf.Name.DCTDecode,
        )
        pdf.pages[-1].Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im1=xobj))
        pdf.pages[-1].Contents = pdf.make_stream(b"q 612 0 0 792 0 0 cm /Im1 Do Q")


write("big_scan.pdf", big_scan)


def separated(pdf: pikepdf.Pdf) -> None:
    # Two pages, a blank separator, two more pages: smart split by blank page gives 3 + 2 pages.
    colour_page(pdf)
    colour_page(pdf)
    pdf.add_blank_page(page_size=(612, 792))
    colour_page(pdf)
    colour_page(pdf)


write("separated.pdf", separated)

for name, colour in (("a.png", (200, 40, 40)), ("b.png", (40, 90, 200))):
    Image.new("RGB", (400, 300), colour).save(out / name)

print("ok")
