"""Generate the synthetic test corpus (no real documents).

Usage (from the repo root)::

    uv run --project core python scripts/gen_corpus.py [--out DIR]

Default output: ``tests/corpus/generated/`` (git-ignored). The pytest suite of the core
calls ``generate()`` itself, so tests are self-contained.

Files (deterministic, except the random salts of the encrypted ones):

- ``vietnamese_text.pdf``      3 pages of Vietnamese text, Be Vietnam Pro subset-embedded,
                               Vietnamese metadata.
- ``mixed_fonts.pdf``          Be Vietnam Pro Regular + Bold (subset) and Helvetica (not embedded).
- ``outline_10p.pdf``          10 numbered pages with a nested outline (chapters/sections).
- ``encrypted_1234.pdf``       AES-256, user password "1234", owner password "owner-5678".
- ``encrypted_owner_only.pdf`` AES-256, empty user password, owner password "owner-5678".
- ``mixed_sizes.pdf``          A4, A4 landscape, Letter, A5 with /Rotate 90, /Rotate 180,
                               a page with a CropBox.
- ``inherited_rotate.pdf``     3 pages whose /Rotate 90 and /MediaBox are inherited from /Pages.
- ``scanned_like.pdf``         2 image-only pages (noisy grayscale "scan").
- ``images_8p.pdf``            8 pages, each with its own ~40 KB JPEG (for size-based split).
- ``fake_signed.pdf``          a signature field with a /V value (not a valid signature).
- ``photo_exif6.jpg``          JPEG 400×200 stored, EXIF orientation 6 (display 200×400);
                               the stored top rows are red, so the red band shows on the right.
- ``photo_exif2.jpg``          JPEG with EXIF orientation 2 (mirrored); stored left = blue.
- ``logo_alpha.png``           RGBA PNG with transparency.
- ``corrupt_truncated.pdf``    a PDF cut off after its first few hundred bytes.
- ``corrupt_garbage.pdf``      random bytes with a .pdf name.
- ``damaged_recoverable.pdf``  ``outline_10p.pdf`` without its xref table and trailer
                               (qpdf can reconstruct it).
"""

from __future__ import annotations

import argparse
import io
import random
from pathlib import Path

import img2pdf
import pikepdf
from PIL import Image, ImageDraw, ImageFont
from reportlab.lib.pagesizes import A4, A5, landscape, letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

REPO = Path(__file__).resolve().parent.parent
FONTS = REPO / "tests" / "corpus" / "fonts"
DEFAULT_OUT = REPO / "tests" / "corpus" / "generated"
FONT_REGULAR = FONTS / "BeVietnamPro-Regular.ttf"
FONT_BOLD = FONTS / "BeVietnamPro-Bold.ttf"

USER_PASSWORD = "1234"
OWNER_PASSWORD = "owner-5678"

VI_PARAGRAPHS = [
    "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM",
    "Độc lập - Tự do - Hạnh phúc",
    "NGHỊ ĐỊNH số 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân.",
    "Điều 1. Phạm vi điều chỉnh: Nghị định này quy định về bảo vệ dữ liệu cá nhân",
    "và trách nhiệm bảo vệ dữ liệu cá nhân của cơ quan, tổ chức, cá nhân có liên quan.",
    "Điều 2. Giải thích từ ngữ: Dữ liệu cá nhân là thông tin dưới dạng ký hiệu, chữ viết,",
    "chữ số, hình ảnh, âm thanh hoặc dạng tương tự trên môi trường điện tử.",
    "Tiếng Việt có dấu: à á ả ã ạ ă ằ ắ ẳ ẵ ặ â ầ ấ ẩ ẫ ậ đ è é ẻ ẽ ẹ ê ề ế ể ễ ệ",
    "ì í ỉ ĩ ị ò ó ỏ õ ọ ô ồ ố ổ ỗ ộ ơ ờ ớ ở ỡ ợ ù ú ủ ũ ụ ư ừ ứ ử ữ ự ỳ ý ỷ ỹ ỵ",
]

_fonts_registered = False


def _register_fonts() -> None:
    global _fonts_registered
    if _fonts_registered:
        return
    pdfmetrics.registerFont(TTFont("BeVietnamPro", str(FONT_REGULAR)))
    pdfmetrics.registerFont(TTFont("BeVietnamPro-Bold", str(FONT_BOLD)))
    _fonts_registered = True


def _canvas(path: Path, pagesize: tuple[float, float] = A4) -> canvas.Canvas:
    return canvas.Canvas(str(path), pagesize=pagesize, invariant=1, pageCompression=1)


def vietnamese_text(path: Path) -> None:
    _register_fonts()
    c = _canvas(path)
    c.setTitle("Nghị định bảo vệ dữ liệu cá nhân")
    c.setAuthor("Chef PDF – bộ mẫu thử")
    c.setSubject("Văn bản tiếng Việt mẫu")
    c.setKeywords("nghị định, tiếng Việt, mẫu thử")
    c.setCreator("gen_corpus.py")
    for page in range(3):
        c.setFont("BeVietnamPro", 12)
        y = 800.0
        for line in VI_PARAGRAPHS:
            c.drawString(56, y, line)
            y -= 20
        c.drawString(56, 60, f"Trang {page + 1} / 3")
        c.showPage()
    c.save()


def mixed_fonts(path: Path) -> None:
    _register_fonts()
    c = _canvas(path)
    c.setFont("BeVietnamPro-Bold", 16)
    c.drawString(56, 780, "Tiêu đề in đậm: Quyết định phê duyệt")
    c.setFont("BeVietnamPro", 12)
    c.drawString(56, 750, "Nội dung văn bản: căn cứ Luật Giao dịch điện tử.")
    c.setFont("Helvetica", 12)
    c.drawString(56, 720, "Helvetica (not embedded) - plain ASCII")
    c.showPage()
    c.save()


def outline_10p(path: Path) -> None:
    _register_fonts()
    c = _canvas(path)
    c.setTitle("Outline sample")
    chapters = {0: ("Chương 1", 0), 1: ("Mục 1.1", 1), 2: ("Mục 1.2", 1), 4: ("Chương 2", 0)}
    chapters[7] = ("Chương 3", 0)
    for i in range(10):
        c.setFont("BeVietnamPro", 48)
        c.drawString(150, 420, f"Trang {i + 1}")
        key = f"p{i}"
        c.bookmarkPage(key)
        if i in chapters:
            title, level = chapters[i]
            c.addOutlineEntry(title, key, level=level)
        c.showPage()
    c.save()


def _sample_pdf_bytes(pages: int = 3) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=A4, invariant=1)
    for i in range(pages):
        c.setFont("Helvetica", 36)
        c.drawString(150, 420, f"Secret page {i + 1}")
        c.showPage()
    c.save()
    return buf.getvalue()


def encrypted(path: Path, user: str, owner: str) -> None:
    with pikepdf.open(io.BytesIO(_sample_pdf_bytes())) as pdf:
        allow = pikepdf.Permissions(extract=False, modify_other=False)
        pdf.save(
            path,
            encryption=pikepdf.Encryption(user=user, owner=owner, R=6, allow=allow),
            static_id=True,
        )


def mixed_sizes(path: Path) -> None:
    sizes = [A4, landscape(A4), letter, A5, A4, A4]
    c = _canvas(path)
    for i, size in enumerate(sizes):
        c.setPageSize(size)
        c.setFont("Helvetica", 24)
        c.drawString(40, size[1] / 2, f"Page {i + 1}: {size[0]:.0f} x {size[1]:.0f}")
        c.showPage()
    c.save()
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        pdf.pages[3].obj.Rotate = 90
        pdf.pages[4].obj.Rotate = 180
        pdf.pages[5].obj.CropBox = pikepdf.Array([50, 50, 350, 450])
        pdf.save(path, static_id=True)


def inherited_rotate(path: Path) -> None:
    pdf = pikepdf.new()
    for i in range(3):
        content = f"BT /F1 24 Tf 40 300 Td (Inherited {i + 1}) Tj ET".encode()
        page_dict = pikepdf.Dictionary(
            Type=pikepdf.Name.Page,
            Contents=pdf.make_stream(content),
        )
        pdf.pages.append(pikepdf.Page(page_dict))
    pages_root = pdf.Root.Pages
    pages_root.Rotate = 90
    pages_root.MediaBox = pikepdf.Array([0, 0, 400, 600])
    pages_root.Resources = pikepdf.Dictionary(
        Font=pikepdf.Dictionary(
            F1=pikepdf.Dictionary(
                Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica
            )
        )
    )
    for page in pdf.pages:
        for key in ("/MediaBox", "/Rotate", "/Resources"):
            if key in page.obj:
                del page.obj[key]
    pdf.save(path, static_id=True)


def _noisy_scan(rng: random.Random, size: tuple[int, int], label: str) -> Image.Image:
    image = Image.new("L", size, 235)
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(FONT_REGULAR), size=18)
    y = 80
    for line in [label, *VI_PARAGRAPHS[:6]]:
        draw.text((50, y), line, fill=30, font=font)
        y += 32
    pixels = image.load()
    assert pixels is not None
    for _ in range(size[0] * size[1] // 60):
        x, yy = rng.randrange(size[0]), rng.randrange(size[1])
        pixels[x, yy] = rng.randrange(120, 255)
    return image


def _jpeg(image: Image.Image, quality: int = 80, exif: Image.Exif | None = None) -> bytes:
    buf = io.BytesIO()
    if exif is not None:
        image.save(buf, format="JPEG", quality=quality, exif=exif.tobytes())
    else:
        image.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def _write_static(path: Path, pdf_bytes: bytes) -> None:
    """Re-save without img2pdf's random /ID so the output is reproducible."""
    with pikepdf.open(io.BytesIO(pdf_bytes)) as pdf:
        if "/ID" in pdf.trailer:
            del pdf.trailer["/ID"]
        pdf.save(path, static_id=True)


def scanned_like(path: Path) -> None:
    rng = random.Random(42)
    jpegs = [_jpeg(_noisy_scan(rng, (827, 1170), f"Bản scan trang {i + 1}")) for i in range(2)]
    layout = img2pdf.get_layout_fun((img2pdf.mm_to_pt(210), img2pdf.mm_to_pt(297)))
    _write_static(path, img2pdf.convert(jpegs, layout_fun=layout, nodate=True))


def images_8p(path: Path) -> None:
    rng = random.Random(7)
    jpegs = []
    for i in range(8):
        image = Image.new("RGB", (300, 300))
        image.putdata(
            [(rng.randrange(256), rng.randrange(256), rng.randrange(256)) for _ in range(90000)]
        )
        ImageDraw.Draw(image).text((20, 20), f"{i + 1}", fill=(0, 0, 0))
        jpegs.append(_jpeg(image, quality=60))
    _write_static(path, img2pdf.convert(jpegs, nodate=True))


def fake_signed(path: Path) -> None:
    with pikepdf.open(io.BytesIO(_sample_pdf_bytes(1))) as pdf:
        sig_value = pdf.make_indirect(
            pikepdf.Dictionary(
                Type=pikepdf.Name.Sig,
                Filter=pikepdf.Name("/Adobe.PPKLite"),
                SubFilter=pikepdf.Name("/adbe.pkcs7.detached"),
                Contents=pikepdf.String(b"\x00" * 16),
                ByteRange=pikepdf.Array([0, 0, 0, 0]),
            )
        )
        widget = pdf.make_indirect(
            pikepdf.Dictionary(
                Type=pikepdf.Name.Annot,
                Subtype=pikepdf.Name.Widget,
                FT=pikepdf.Name.Sig,
                T=pikepdf.String("Signature1"),
                V=sig_value,
                Rect=pikepdf.Array([0, 0, 0, 0]),
                F=132,
                P=pdf.pages[0].obj,
            )
        )
        pdf.pages[0].obj.Annots = pikepdf.Array([widget])
        pdf.Root.AcroForm = pikepdf.Dictionary(Fields=pikepdf.Array([widget]), SigFlags=3)
        pdf.save(path, static_id=True)


def exif_jpeg(path: Path, orientation: int) -> None:
    """Stored 400×200; top 40 rows red, left 40 columns blue, rest light gray."""
    image = Image.new("RGB", (400, 200), (220, 220, 220))
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 399, 39), fill=(255, 0, 0))
    draw.rectangle((0, 40, 39, 199), fill=(0, 0, 255))
    exif = Image.Exif()
    exif[0x0112] = orientation
    path.write_bytes(_jpeg(image, quality=95, exif=exif))


def alpha_png(path: Path) -> None:
    image = Image.new("RGBA", (120, 80), (0, 0, 0, 0))
    ImageDraw.Draw(image).ellipse((10, 10, 110, 70), fill=(0, 128, 0, 255))
    image.save(path, format="PNG")


def corrupt_truncated(path: Path, source: Path) -> None:
    path.write_bytes(source.read_bytes()[:400])


def damaged_recoverable(path: Path, source: Path) -> None:
    data = source.read_bytes()
    path.write_bytes(data[: data.rindex(b"xref")])


def corrupt_garbage(path: Path) -> None:
    rng = random.Random(1)
    path.write_bytes(bytes(rng.randrange(256) for _ in range(4096)))


def generate(out: Path = DEFAULT_OUT) -> dict[str, Path]:
    """Write every corpus file into ``out`` and return {name: path}."""
    out.mkdir(parents=True, exist_ok=True)
    files: dict[str, Path] = {}

    def target(name: str) -> Path:
        files[name] = out / name
        return files[name]

    vietnamese_text(target("vietnamese_text.pdf"))
    mixed_fonts(target("mixed_fonts.pdf"))
    outline_10p(target("outline_10p.pdf"))
    encrypted(target("encrypted_1234.pdf"), USER_PASSWORD, OWNER_PASSWORD)
    encrypted(target("encrypted_owner_only.pdf"), "", OWNER_PASSWORD)
    mixed_sizes(target("mixed_sizes.pdf"))
    inherited_rotate(target("inherited_rotate.pdf"))
    scanned_like(target("scanned_like.pdf"))
    images_8p(target("images_8p.pdf"))
    fake_signed(target("fake_signed.pdf"))
    exif_jpeg(target("photo_exif6.jpg"), 6)
    exif_jpeg(target("photo_exif2.jpg"), 2)
    alpha_png(target("logo_alpha.png"))
    corrupt_truncated(target("corrupt_truncated.pdf"), files["outline_10p.pdf"])
    corrupt_garbage(target("corrupt_garbage.pdf"))
    damaged_recoverable(target("damaged_recoverable.pdf"), files["outline_10p.pdf"])
    return files


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()
    for name, path in generate(args.out).items():
        print(f"{path.stat().st_size:>9}  {name}")


if __name__ == "__main__":
    main()
