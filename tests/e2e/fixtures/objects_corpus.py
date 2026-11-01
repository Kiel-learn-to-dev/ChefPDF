"""Generates the PDFs of objects.spec.ts (run with the core environment: uv run).

Usage: python objects_corpus.py OUT_DIR

objects.pdf : a red rectangle (user x 100..300, y 500..650), a line of Helvetica text at
              user y 300 and a 100 x 100 pt blue-green image at user (320, 100).
layers.pdf  : the same rectangle inside the optional-content group 'Watermark' (visible).
"""

import sys
from pathlib import Path

import pikepdf
from pikepdf import Dictionary, Name, String
from PIL import Image

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)

TEXT = "Hello object editing"


def image_xobject(pdf: pikepdf.Pdf) -> pikepdf.Stream:
    img = Image.new("RGB", (100, 100), (0, 128, 96))
    return _make_image(pdf, img)


def _make_image(pdf: pikepdf.Pdf, img: Image.Image) -> pikepdf.Stream:
    stream = pikepdf.Stream(pdf, img.tobytes())
    stream.Type = Name.XObject
    stream.Subtype = Name.Image
    stream.Width = img.width
    stream.Height = img.height
    stream.ColorSpace = Name.DeviceRGB
    stream.BitsPerComponent = 8
    return stream


def base_page(pdf: pikepdf.Pdf, content: bytes, resources: Dictionary) -> None:
    pdf.add_blank_page(page_size=(612, 792))
    page = pdf.pages[-1]
    page.Contents = pdf.make_stream(content)
    page.Resources = resources


def objects_pdf(pdf: pikepdf.Pdf) -> None:
    font = pdf.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
    )
    xobj = pdf.make_indirect(image_xobject(pdf))
    content = (
        b"1 0 0 rg 100 500 200 150 re f "
        + ("BT /F1 14 Tf 60 300 Td (%s) Tj ET " % TEXT).encode("ascii")
        + b"q 100 0 0 100 320 100 cm /Im1 Do Q"
    )
    resources = Dictionary(
        Font=Dictionary(F1=font),
        XObject=Dictionary(Im1=xobj),
    )
    base_page(pdf, content, resources)


def layers_pdf(pdf: pikepdf.Pdf) -> None:
    ocg = pdf.make_indirect(Dictionary(Type=Name.OCG, Name=String("Watermark")))
    pdf.Root.OCProperties = Dictionary(OCGs=[ocg], D=Dictionary(Order=[ocg], ON=[ocg]))
    content = b"/OC /MC0 BDC 1 0 0 rg 100 500 200 150 re f EMC"
    resources = Dictionary(Properties=Dictionary(MC0=ocg))
    base_page(pdf, content, resources)


def write(name: str, build) -> None:
    pdf = pikepdf.new()
    build(pdf)
    pdf.save(out / name)


write("objects.pdf", objects_pdf)
write("layers.pdf", layers_pdf)
print("ok")
