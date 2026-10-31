"""T4.01 overlay engine: placement, rotation, fonts, images, opacity, under/over, isolation.

Ink is checked by rendering with PDFium (pypdfium2) at 72 dpi, so one pixel is one point and
coordinates are those of the displayed page (after /Rotate and CropBox).
"""

from __future__ import annotations

import io
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium
import pytest
from PIL import Image

from chef_core.overlay.engine import OverlayWriter, Placement, TextStyle


def _doc(pages: int = 1, size: tuple[float, float] = (300, 400)) -> pikepdf.Pdf:
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=size)
    return pdf


def _save(pdf: pikepdf.Pdf, path: Path) -> Path:
    pdf.save(path)
    return path


def _render(path: Path, index: int = 0) -> Image.Image:
    doc = pdfium.PdfDocument(str(path))
    try:
        return doc[index].render(scale=1.0).to_pil().convert("RGB")
    finally:
        doc.close()


def _bbox(img: Image.Image, predicate) -> tuple[int, int, int, int] | None:  # type: ignore[no-untyped-def]
    xs: list[int] = []
    ys: list[int] = []
    width, _ = img.size
    data = img.tobytes()
    for i in range(0, len(data), 3):
        if predicate(data[i], data[i + 1], data[i + 2]):
            xs.append((i // 3) % width)
            ys.append((i // 3) // width)
    if not xs:
        return None
    return min(xs), min(ys), max(xs) + 1, max(ys) + 1


def _is_red(r: int, g: int, b: int) -> bool:
    return r > 200 and g < 80 and b < 80


def _is_blue(r: int, g: int, b: int) -> bool:
    return b > 200 and r < 80 and g < 80


def _near(box: tuple[int, int, int, int] | None, expected: tuple[int, int, int, int]) -> bool:
    assert box is not None, "nothing was drawn"
    return all(abs(a - b) <= 1 for a, b in zip(box, expected, strict=True))


# -- coordinates: displayed frame, /Rotate and CropBox -----------------------------------


@pytest.mark.parametrize("rotate", [0, 90, 180, 270])
def test_top_left_placement_is_in_displayed_coordinates(tmp_path: Path, rotate: int) -> None:
    pdf = _doc()
    page = pdf.pages[0]
    page.obj.CropBox = pikepdf.Array([20, 30, 260, 330])  # 240 x 300 visible
    if rotate:
        page.obj.Rotate = rotate
    writer = OverlayWriter(pdf, kind="text", group="g1")
    rect = writer.rect(40, 20, fill=(1, 0, 0))
    writer.place(0, rect, Placement(x=50, y=60, anchor="top-left"))
    writer.commit()
    img = _render(_save(pdf, tmp_path / f"r{rotate}.pdf"))
    expected_size = (240, 300) if rotate in (0, 180) else (300, 240)
    assert img.size == expected_size
    # Displayed top-left origin: the box spans x 50..90 and y 60..80 on screen.
    assert _near(_bbox(img, _is_red), (50, 60, 90, 80))


@pytest.mark.parametrize("rotate", [0, 90, 180, 270])
def test_center_anchor_with_quarter_turn(tmp_path: Path, rotate: int) -> None:
    pdf = _doc()
    pdf.pages[0].obj.CropBox = pikepdf.Array([20, 30, 260, 330])
    if rotate:
        pdf.pages[0].obj.Rotate = rotate
    width, height = (240, 300) if rotate in (0, 180) else (300, 240)
    writer = OverlayWriter(pdf, kind="text", group="g1")
    rect = writer.rect(40, 20, fill=(1, 0, 0))
    writer.place(0, rect, Placement(x=width / 2, y=height / 2, anchor="center", rotation=90))
    writer.commit()
    img = _render(_save(pdf, tmp_path / f"c{rotate}.pdf"))
    cx, cy = width / 2, height / 2
    # A 40 x 20 box turned by 90 degrees is 20 wide and 40 tall, still centred.
    assert _near(
        _bbox(img, _is_red),
        (round(cx - 10), round(cy - 20), round(cx + 10), round(cy + 20)),
    )


def test_rotation_turns_counter_clockwise_on_screen(tmp_path: Path) -> None:
    pdf = _doc()
    writer = OverlayWriter(pdf, kind="text", group="g1")
    bar = writer.rect(120, 8, fill=(1, 0, 0))
    writer.place(0, bar, Placement(x=150, y=200, anchor="center", rotation=30))
    writer.commit()
    img = _render(_save(pdf, tmp_path / "ccw.pdf"))
    left = [
        (x, y)
        for y in range(img.height)
        for x in range(img.width)
        if _is_red(*img.getpixel((x, y))) and x < 150
    ]
    right = [
        (x, y)
        for y in range(img.height)
        for x in range(img.width)
        if _is_red(*img.getpixel((x, y))) and x >= 150
    ]
    assert left and right
    left_y = sum(y for _, y in left) / len(left)
    right_y = sum(y for _, y in right) / len(right)
    # Counter-clockwise: the right end of the bar is higher on screen (smaller y).
    assert right_y < left_y - 20


def test_content_leaking_graphics_state_does_not_move_the_overlay(tmp_path: Path) -> None:
    pdf = _doc()
    # The page leaves a scale and a colour set (no Q), which must not affect the overlay.
    pdf.pages[0].obj.Contents = pdf.make_stream(b"0.5 0 0 0.5 100 100 cm 1 0 0 rg")
    writer = OverlayWriter(pdf, kind="text", group="g1")
    writer.place(0, writer.rect(20, 20, fill=(0, 0, 1)), Placement(x=10, y=10))
    writer.commit()
    img = _render(_save(pdf, tmp_path / "leak.pdf"))
    assert _near(_bbox(img, _is_blue), (10, 10, 30, 30))


def test_under_draws_beneath_existing_content_and_over_draws_above(tmp_path: Path) -> None:
    pdf = _doc()
    pdf.pages[0].obj.Contents = pdf.make_stream(b"0 0 0 rg 0 0 300 400 re f")
    writer = OverlayWriter(pdf, kind="text", group="g1")
    yellow = writer.rect(50, 50, fill=(1, 1, 0))
    writer.place(0, yellow, Placement(x=0, y=0), under=True)
    writer.commit()
    img = _render(_save(pdf, tmp_path / "under.pdf"))
    assert img.getpixel((10, 10)) == (0, 0, 0)

    pdf = _doc()
    pdf.pages[0].obj.Contents = pdf.make_stream(b"0 0 0 rg 0 0 300 400 re f")
    writer = OverlayWriter(pdf, kind="text", group="g2")
    writer.place(0, writer.rect(50, 50, fill=(1, 1, 0)), Placement(x=0, y=0), under=False)
    writer.commit()
    img = _render(_save(pdf, tmp_path / "over.pdf"))
    assert img.getpixel((10, 10)) == (255, 255, 0)


def test_opacity_blends_with_the_page(tmp_path: Path) -> None:
    pdf = _doc()
    pdf.pages[0].obj.Contents = pdf.make_stream(b"0 0 0 rg 0 0 300 400 re f")
    writer = OverlayWriter(pdf, kind="text", group="g1")
    writer.place(0, writer.rect(50, 50, fill=(1, 0, 0)), Placement(x=0, y=0, opacity=0.5))
    writer.commit()
    img = _render(_save(pdf, tmp_path / "alpha.pdf"))
    r, g, b = img.getpixel((10, 10))
    assert abs(r - 128) <= 3 and g == 0 and b == 0


# -- text --------------------------------------------------------------------------------


VIETNAMESE = "Chào mừng đến Chef PDF: Đã duyệt, ₫ 1.000 đồng"


def test_vietnamese_text_is_extractable(tmp_path: Path) -> None:
    pdf = _doc()
    writer = OverlayWriter(pdf, kind="text", group="g1")
    piece = writer.text(VIETNAMESE, TextStyle(font_size=14))
    writer.place(0, piece, Placement(x=20, y=40))
    writer.commit()
    path = _save(pdf, tmp_path / "vi.pdf")
    doc = pdfium.PdfDocument(str(path))
    try:
        text = doc[0].get_textpage().get_text_range()
    finally:
        doc.close()
    assert "Chào mừng" in text
    assert "Đã duyệt" in text
    assert "₫" in text


def test_text_font_is_a_subset_and_shared_by_all_pages(tmp_path: Path) -> None:
    pdf = _doc(pages=50)
    writer = OverlayWriter(pdf, kind="text", group="g1")
    piece = writer.text(VIETNAMESE, TextStyle(font_size=12))
    for i in range(50):
        writer.place(i, piece, Placement(x=20, y=40))
    writer.commit()
    path = _save(pdf, tmp_path / "shared.pdf")
    with pikepdf.open(path) as reopened:
        fonts = [
            o
            for o in reopened.objects
            if isinstance(o, pikepdf.Dictionary) and o.get("/Subtype") == "/Type0"
        ]
        assert len(fonts) == 1
        cid = fonts[0].DescendantFonts[0]
        ff2 = cid.FontDescriptor.FontFile2
        assert len(ff2.read_bytes()) < 100_000
        assert str(fonts[0].Encoding) == "/Identity-H"
        assert "/ToUnicode" in fonts[0]


def test_font_is_reused_across_overlays_in_one_document(tmp_path: Path) -> None:
    pdf = _doc(pages=2)
    first = OverlayWriter(pdf, kind="text", group="g1")
    first.place(0, first.text("Xin chào", TextStyle()), Placement(x=10, y=10))
    first.commit()
    second = OverlayWriter(pdf, kind="text", group="g2")
    second.place(1, second.text("Tạm biệt", TextStyle()), Placement(x=10, y=10))
    second.commit()
    fonts = [
        o
        for o in pdf.objects
        if isinstance(o, pikepdf.Dictionary) and o.get("/Subtype") == "/Type0"
    ]
    assert len(fonts) == 1


def test_missing_glyph_is_reported_not_drawn(tmp_path: Path) -> None:
    pdf = _doc()
    warnings: list[str] = []
    writer = OverlayWriter(pdf, kind="text", group="g1", warn=warnings.append)
    writer.text("a中b", TextStyle())  # CJK ideograph is not in Be Vietnam Pro
    assert any("U+4E2D" in w for w in warnings)


# -- images ------------------------------------------------------------------------------


def _png(size: tuple[int, int], rgba: bool) -> bytes:
    mode = "RGBA" if rgba else "RGB"
    img = Image.new(mode, size, (255, 0, 0, 255) if rgba else (255, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def test_png_with_alpha_gets_an_smask_and_fits_its_box(tmp_path: Path) -> None:
    pdf = _doc()
    writer = OverlayWriter(pdf, kind="image", group="g1")
    piece = writer.image(_png((40, 30), rgba=True), width=80, height=60)
    writer.place(0, piece, Placement(x=50, y=60))
    writer.commit()
    path = _save(pdf, tmp_path / "png.pdf")
    with pikepdf.open(path) as reopened:
        images = [
            o
            for o in reopened.objects
            if isinstance(o, pikepdf.Stream) and o.get("/Subtype") == "/Image"
        ]
        assert len(images) == 2  # the picture and its soft mask
        assert any("/SMask" in img for img in images)
    img = _render(path)
    assert _near(_bbox(img, _is_red), (50, 60, 130, 120))


def test_jpeg_is_embedded_without_recompression(tmp_path: Path) -> None:
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (0, 0, 255)).save(buf, format="JPEG", quality=70)
    jpeg = buf.getvalue()
    pdf = _doc(pages=10)
    writer = OverlayWriter(pdf, kind="image", group="g1")
    piece = writer.image(jpeg, width=64, height=48)
    for i in range(10):
        writer.place(i, piece, Placement(x=0, y=0))
    writer.commit()
    path = _save(pdf, tmp_path / "jpg.pdf")
    with pikepdf.open(path) as reopened:
        images = [
            o
            for o in reopened.objects
            if isinstance(o, pikepdf.Stream) and o.get("/Subtype") == "/Image"
        ]
        assert len(images) == 1  # shared by all ten pages
        assert images[0].Filter == pikepdf.Name.DCTDecode
        assert images[0].read_raw_bytes() == jpeg
    assert _near(_bbox(_render(path), _is_blue), (0, 0, 64, 48))


# -- shapes ------------------------------------------------------------------------------


def test_stroked_path_draws_a_line_of_the_given_width(tmp_path: Path) -> None:
    pdf = _doc()
    writer = OverlayWriter(pdf, kind="text", group="g1")
    line = writer.path([(0, 0), (100, 0)], closed=False, stroke=(1, 0, 0), line_width=6)
    writer.place(0, line, Placement(x=50, y=100))
    writer.commit()
    img = _render(_save(pdf, tmp_path / "line.pdf"))
    assert _near(_bbox(img, _is_red), (50, 97, 150, 103))


def test_long_text_wraps_inside_the_given_width() -> None:
    pdf = _doc()
    writer = OverlayWriter(pdf, kind="text", group="g1")
    piece = writer.text("từ " * 60, TextStyle(font_size=12), width=120)
    assert piece.width <= 120 + 0.01
    assert piece.height > 3 * 12  # several lines


def test_blend_mode_multiply_darkens_the_page(tmp_path: Path) -> None:
    pdf = _doc()
    pdf.pages[0].obj.Contents = pdf.make_stream(b"0 0 1 rg 0 0 300 400 re f")  # blue page
    writer = OverlayWriter(pdf, kind="text", group="g1")
    writer.place(0, writer.rect(50, 50, fill=(1, 0, 0)), Placement(x=0, y=0, blend="Multiply"))
    writer.commit()
    img = _render(_save(pdf, tmp_path / "multiply.pdf"))
    # Red multiplied by blue is black: the overlap is no longer red.
    assert img.getpixel((10, 10)) == (0, 0, 0)
    assert img.getpixel((200, 200)) == (0, 0, 255)
