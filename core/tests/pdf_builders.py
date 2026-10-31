"""Small PDF builders for tests: each one plants one kind of hidden data (no real documents)."""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import pikepdf
from pikepdf import Dictionary, Name
from PIL import Image

PAGE_W = 300
PAGE_H = 200


def _font(pdf: pikepdf.Pdf) -> pikepdf.Object:
    return pdf.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
    )


def add_page(
    pdf: pikepdf.Pdf,
    content: bytes,
    *,
    extra_resources: dict[str, Any] | None = None,
    width: int = PAGE_W,
    height: int = PAGE_H,
) -> pikepdf.Page:
    page = pdf.add_blank_page(page_size=(width, height))
    resources = Dictionary(Font=Dictionary(F1=_font(pdf)))
    for key, value in (extra_resources or {}).items():
        resources[key] = value
    page.obj.Resources = resources
    page.obj.Contents = pdf.make_stream(content)
    return page


VISIBLE = b"BT /F1 12 Tf 10 170 Td (Visible text) Tj ET"


def plain(path: Path, pages: int = 2) -> Path:
    pdf = pikepdf.new()
    for _ in range(pages):
        add_page(pdf, VISIBLE)
    pdf.save(path)
    return path


def with_metadata(path: Path) -> Path:
    pdf = plain(path, 1)
    with pikepdf.open(path, allow_overwriting_input=True) as doc:
        doc.docinfo["/Title"] = "Bao cao noi bo"
        doc.docinfo["/Author"] = "Nguyen Van A"
        with doc.open_metadata(set_pikepdf_as_editor=False) as xmp:
            xmp["dc:title"] = "Bao cao noi bo"
            xmp["dc:creator"] = ["Nguyen Van A"]
        doc.save(path)
    return pdf and path


def with_javascript(path: Path) -> Path:
    pdf = pikepdf.new()
    page = add_page(pdf, VISIBLE)
    script = pikepdf.String("app.alert('hi');")
    js_action = Dictionary(S=Name.JavaScript, JS=script)
    pdf.Root.OpenAction = Dictionary(S=Name.JavaScript, JS=script)
    pdf.Root.Names = Dictionary(
        JavaScript=Dictionary(Names=pikepdf.Array([pikepdf.String("hook"), js_action]))
    )
    annot = pdf.make_indirect(
        Dictionary(
            Type=Name.Annot,
            Subtype=Name.Link,
            Rect=pikepdf.Array([10, 10, 60, 30]),
            Border=pikepdf.Array([0, 0, 0]),
            A=Dictionary(S=Name.JavaScript, JS=script),
        )
    )
    page.obj.Annots = pikepdf.Array([annot])
    pdf.save(path)
    return path


def with_embedded(path: Path) -> Path:
    pdf = plain(path, 1)
    with pikepdf.open(path, allow_overwriting_input=True) as doc:
        doc.attachments["secret.txt"] = pikepdf.AttachedFileSpec(
            doc, b"internal notes", filename="secret.txt", description="notes"
        )
        doc.save(path)
    return pdf and path


def with_hidden_text(path: Path) -> Path:
    content = (
        VISIBLE
        + b" BT 3 Tr /F1 12 Tf 10 40 Td (Invisible one) Tj ET"
        + b" BT 3 Tr /F1 12 Tf 10 20 Td (Invisible two) Tj ET"
    )
    pdf = pikepdf.new()
    add_page(pdf, content)
    pdf.save(path)
    return path


def with_white_text(path: Path) -> Path:
    content = VISIBLE + b" 1 g BT /F1 12 Tf 10 100 Td (White text) Tj ET 0 g"
    pdf = pikepdf.new()
    add_page(pdf, content)
    pdf.save(path)
    return path


def with_offpage_text(path: Path) -> Path:
    content = VISIBLE + b" BT /F1 12 Tf 900 50 Td (Far away) Tj ET"
    pdf = pikepdf.new()
    add_page(pdf, content)
    pdf.save(path)
    return path


def with_hidden_layer(path: Path) -> Path:
    """Visible text plus a layer (OCG) that is switched off and carries text."""
    pdf = pikepdf.new()
    ocg = pdf.make_indirect(Dictionary(Type=Name.OCG, Name=pikepdf.String("Ban nhap")))
    content = VISIBLE + b" /OC /L1 BDC BT /F1 12 Tf 10 100 Td (Layer secret) Tj ET EMC"
    add_page(pdf, content, extra_resources={"/Properties": Dictionary(L1=ocg)})
    pdf.Root.OCProperties = Dictionary(
        OCGs=pikepdf.Array([ocg]),
        D=Dictionary(Order=pikepdf.Array([ocg]), OFF=pikepdf.Array([ocg])),
    )
    pdf.save(path)
    return path


def with_comments(path: Path) -> Path:
    pdf = plain(path, 1)
    with pikepdf.open(path, allow_overwriting_input=True) as doc:
        page = doc.pages[0]
        note = doc.make_indirect(
            Dictionary(
                Type=Name.Annot,
                Subtype=Name.Text,
                Rect=pikepdf.Array([20, 20, 40, 40]),
                Contents=pikepdf.String("Sua lai so lieu nay"),
                T=pikepdf.String("Reviewer"),
            )
        )
        highlight = doc.make_indirect(
            Dictionary(
                Type=Name.Annot,
                Subtype=Name.Highlight,
                Rect=pikepdf.Array([10, 160, 120, 180]),
                QuadPoints=pikepdf.Array([10, 180, 120, 180, 10, 160, 120, 160]),
            )
        )
        page.obj.Annots = pikepdf.Array([note, highlight])
        doc.save(path)
    return pdf and path


def with_form(path: Path) -> Path:
    pdf = plain(path, 1)
    with pikepdf.open(path, allow_overwriting_input=True) as doc:
        field = doc.make_indirect(
            Dictionary(
                FT=Name.Tx,
                T=pikepdf.String("hoten"),
                V=pikepdf.String("Nguyen Van A"),
                Type=Name.Annot,
                Subtype=Name.Widget,
                Rect=pikepdf.Array([10, 60, 150, 80]),
            )
        )
        empty = doc.make_indirect(
            Dictionary(
                FT=Name.Tx,
                T=pikepdf.String("ghichu"),
                Type=Name.Annot,
                Subtype=Name.Widget,
                Rect=pikepdf.Array([10, 90, 150, 110]),
            )
        )
        doc.pages[0].obj.Annots = pikepdf.Array([field, empty])
        doc.Root.AcroForm = Dictionary(Fields=pikepdf.Array([field, empty]))
        doc.save(path)
    return pdf and path


def with_bookmarks(path: Path) -> Path:
    pdf = plain(path, 2)
    with pikepdf.open(path, allow_overwriting_input=True) as doc:
        with doc.open_outline() as outline:
            outline.root.append(pikepdf.OutlineItem("Chuong 1", 0))
            outline.root.append(pikepdf.OutlineItem("Chuong 2", 1))
        doc.save(path)
    return pdf and path


def with_thumbnail(path: Path) -> Path:
    pdf = plain(path, 1)
    with pikepdf.open(path, allow_overwriting_input=True) as doc:
        thumb = pikepdf.Stream(doc, bytes(8 * 8))
        thumb.Type = Name.XObject
        thumb.Subtype = Name.Image
        thumb.Width = 8
        thumb.Height = 8
        thumb.ColorSpace = Name.DeviceGray
        thumb.BitsPerComponent = 8
        doc.pages[0].obj.Thumb = thumb
        doc.save(path)
    return pdf and path


def with_external_links(path: Path) -> Path:
    pdf = plain(path, 1)
    with pikepdf.open(path, allow_overwriting_input=True) as doc:
        link = doc.make_indirect(
            Dictionary(
                Type=Name.Annot,
                Subtype=Name.Link,
                Rect=pikepdf.Array([10, 10, 80, 30]),
                A=Dictionary(S=Name.URI, URI=pikepdf.String("https://example.com/a")),
            )
        )
        doc.pages[0].obj.Annots = pikepdf.Array([link])
        doc.save(path)
    return pdf and path


def with_launch(path: Path) -> Path:
    pdf = plain(path, 1)
    with pikepdf.open(path, allow_overwriting_input=True) as doc:
        launch = doc.make_indirect(
            Dictionary(
                Type=Name.Annot,
                Subtype=Name.Link,
                Rect=pikepdf.Array([10, 10, 80, 30]),
                A=Dictionary(S=Name.Launch, F=pikepdf.String("cmd.exe")),
            )
        )
        doc.pages[0].obj.Annots = pikepdf.Array([launch])
        doc.save(path)
    return pdf and path


def with_xfa(path: Path) -> Path:
    pdf = plain(path, 1)
    with pikepdf.open(path, allow_overwriting_input=True) as doc:
        datasets = doc.make_stream(b"<xfa:datasets/>")
        doc.Root.AcroForm = Dictionary(
            Fields=pikepdf.Array([]),
            XFA=pikepdf.Array([pikepdf.String("datasets"), datasets]),
        )
        doc.save(path)
    return pdf and path


def with_revisions(path: Path) -> Path:
    """Append a second %%EOF section (what an incremental save leaves behind)."""
    plain(path, 1)
    with path.open("ab") as fh:
        fh.write(b"\n% incremental update\n%%EOF\n")
    return path


def _hand_written(path: Path) -> Path:
    """A one-page PDF written byte by byte, with an object that nothing refers to (object 4).

    qpdf drops unreferenced objects on save, so the file is written here with a real xref."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << >> >>",
        b"<< /Type /Note /Text (orphan) >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref_at = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        xref_at,
    )
    path.write_bytes(bytes(out))
    return path


def with_unused_object(path: Path) -> Path:
    return _hand_written(path)


def jpeg_image_pdf(path: Path) -> Path:
    """One 200x100 px JPEG shown at 2 x 1 inch: 100 dpi, plus a flate PNG-like image."""
    buf = io.BytesIO()
    Image.new("RGB", (200, 100), (200, 30, 30)).save(buf, format="JPEG", quality=85)
    pdf = pikepdf.new()
    jpeg = pdf.make_stream(buf.getvalue())
    jpeg.Type = Name.XObject
    jpeg.Subtype = Name.Image
    jpeg.Width = 200
    jpeg.Height = 100
    jpeg.ColorSpace = Name.DeviceRGB
    jpeg.BitsPerComponent = 8
    jpeg.Filter = Name.DCTDecode
    raw = bytes([0, 128, 255]) * (50 * 50)
    flate = pdf.make_stream(raw)
    flate.Type = Name.XObject
    flate.Subtype = Name.Image
    flate.Width = 50
    flate.Height = 50
    flate.ColorSpace = Name.DeviceRGB
    flate.BitsPerComponent = 8
    content = b"q 144 0 0 72 10 100 cm /Im1 Do Q q 300 0 0 300 0 0 cm /Im2 Do Q"
    add_page(
        pdf,
        content,
        extra_resources={"/XObject": Dictionary(Im1=jpeg, Im2=flate)},
        width=400,
        height=400,
    )
    pdf.save(path)
    return path


def everything(path: Path) -> Path:
    """A document with most kinds of hidden data at once (for the all-categories test)."""
    pdf = pikepdf.new()
    ocg = pdf.make_indirect(Dictionary(Type=Name.OCG, Name=pikepdf.String("Ban nhap")))
    page = add_page(
        pdf,
        VISIBLE
        + b" /OC /L1 BDC BT /F1 12 Tf 10 100 Td (Layer) Tj ET EMC"
        + b" BT 3 Tr /F1 12 Tf 10 40 Td (Hidden) Tj ET",
        extra_resources={"/Properties": Dictionary(L1=ocg)},
    )
    pdf.Root.OCProperties = Dictionary(
        OCGs=pikepdf.Array([ocg]), D=Dictionary(OFF=pikepdf.Array([ocg]))
    )
    script = pikepdf.String("app.alert(1)")
    pdf.Root.OpenAction = Dictionary(S=Name.JavaScript, JS=script)
    pdf.Root.Names = Dictionary(
        JavaScript=Dictionary(
            Names=pikepdf.Array([pikepdf.String("h"), Dictionary(S=Name.JavaScript, JS=script)])
        )
    )
    note = pdf.make_indirect(
        Dictionary(
            Type=Name.Annot,
            Subtype=Name.Text,
            Rect=pikepdf.Array([20, 20, 40, 40]),
            Contents=pikepdf.String("note"),
        )
    )
    url = pdf.make_indirect(
        Dictionary(
            Type=Name.Annot,
            Subtype=Name.Link,
            Rect=pikepdf.Array([10, 60, 80, 80]),
            A=Dictionary(S=Name.URI, URI=pikepdf.String("https://example.com")),
        )
    )
    page.obj.Annots = pikepdf.Array([note, url])
    field = pdf.make_indirect(
        Dictionary(
            FT=Name.Tx,
            T=pikepdf.String("f"),
            V=pikepdf.String("value"),
            Type=Name.Annot,
            Subtype=Name.Widget,
            Rect=pikepdf.Array([10, 100, 90, 120]),
        )
    )
    pdf.Root.AcroForm = Dictionary(Fields=pikepdf.Array([field]))
    with pdf.open_outline() as outline:
        outline.root.append(pikepdf.OutlineItem("Muc 1", 0))
    pdf.docinfo["/Author"] = "Nguyen Van A"
    pdf.make_indirect(Dictionary(Type=Name.Note))  # unused object
    pdf.save(path)
    with path.open("ab") as fh:
        fh.write(b"\n%%EOF\n")
    return path


def gray_image_at_dpi(path: Path, px: int, inches: float) -> Path:
    """One flate-coded gray image of ``px`` x ``px`` pixels shown ``inches`` wide."""
    pdf = pikepdf.new()
    image = pdf.make_stream(bytes([128]) * (px * px))
    image.Type = Name.XObject
    image.Subtype = Name.Image
    image.Width = px
    image.Height = px
    image.ColorSpace = Name.DeviceGray
    image.BitsPerComponent = 8
    size = inches * 72
    content = f"q {size} 0 0 {size} 10 10 cm /Im1 Do Q".encode()
    add_page(
        pdf,
        content,
        extra_resources={"/XObject": Dictionary(Im1=image)},
        width=int(size) + 20,
        height=int(size) + 20,
    )
    pdf.save(path)
    return path


def unsigned_signature_field(path: Path) -> Path:
    """A signature field with no value (nothing has been signed)."""
    plain(path, 1)
    with pikepdf.open(path, allow_overwriting_input=True) as doc:
        sig = doc.make_indirect(
            Dictionary(
                FT=Name.Sig,
                T=pikepdf.String("ky1"),
                Type=Name.Annot,
                Subtype=Name.Widget,
                Rect=pikepdf.Array([10, 10, 100, 40]),
            )
        )
        doc.pages[0].obj.Annots = pikepdf.Array([sig])
        doc.Root.AcroForm = Dictionary(Fields=pikepdf.Array([sig]))
        doc.save(path)
    return path


def blank_middle_page(path: Path) -> Path:
    """Three pages; the middle one has no content at all."""
    pdf = pikepdf.new()
    add_page(pdf, VISIBLE)
    pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    add_page(pdf, VISIBLE)
    pdf.save(path)
    return path
