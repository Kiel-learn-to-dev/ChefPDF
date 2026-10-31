"""Convert: PDF to images (M2) and images to PDF (M3), all input and output formats."""

from __future__ import annotations

from pathlib import Path

import pikepdf
import pytest
from conftest import Harness, RpcFailure
from pdf_media import new_pdf, page_text, place, render, save
from PIL import Image, ImageDraw, features

from chef_core.pdf.pages import A4


def _text_pdf(path: Path, pages: int = 2) -> Path:
    pdf = new_pdf(pages)
    for i, page in enumerate(pdf.pages):
        place(pdf, page, [], text=f"Page {i + 1}")
    return save(pdf, path)


def _page_sizes(path: Path) -> list[tuple[float, float]]:
    with pikepdf.open(path) as pdf:
        out = []
        for page in pdf.pages:
            box = [float(v) for v in page.mediabox]
            out.append((round(box[2] - box[0], 2), round(box[3] - box[1], 2)))
        return out


def _shape(path: Path) -> Image.Image:
    img = Image.new("RGB", (120, 60), (255, 255, 255))
    ImageDraw.Draw(img).rectangle((10, 10, 60, 50), fill=(200, 30, 30))
    img.save(path)
    return img


# -- PDF to images --------------------------------------------------------------------


def test_pdf_to_png_one_file_per_page(harness: Harness, tmp_path: Path) -> None:
    src = _text_pdf(tmp_path / "doc.pdf")
    out = tmp_path / "out"
    result = harness.op("convert.pdfToImages", {"path": str(src), "outputDir": str(out), "dpi": 72})
    names = sorted(Path(p).name for p in result["outputs"])
    assert names == ["doc_1.png", "doc_2.png"]
    with Image.open(out / "doc_1.png") as img:
        assert img.size == (612, 792)


def test_jpeg_at_150_dpi_with_custom_template(harness: Harness, tmp_path: Path) -> None:
    src = _text_pdf(tmp_path / "doc.pdf", 3)
    out = tmp_path / "out"
    result = harness.op(
        "convert.pdfToImages",
        {
            "path": str(src),
            "outputDir": str(out),
            "format": "jpeg",
            "dpi": 150,
            "pages": [1],
            "nameTemplate": "{name}-p{page}",
        },
    )
    assert [Path(p).name for p in result["outputs"]] == ["doc-p2.jpg"]
    with Image.open(out / "doc-p2.jpg") as img:
        assert img.format == "JPEG"
        assert abs(img.size[0] - 1275) <= 1 and abs(img.size[1] - 1650) <= 1  # pdfium rounds


def test_tiff_bw_is_group4_one_bit(harness: Harness, tmp_path: Path) -> None:
    src = _text_pdf(tmp_path / "doc.pdf", 1)
    out = tmp_path / "out"
    result = harness.op(
        "convert.pdfToImages",
        {"path": str(src), "outputDir": str(out), "format": "tiff", "color": "bw", "dpi": 100},
    )
    with Image.open(result["outputs"][0]) as img:
        assert img.mode == "1" and img.format == "TIFF"


def test_multi_page_tiff_has_all_frames(harness: Harness, tmp_path: Path) -> None:
    src = _text_pdf(tmp_path / "doc.pdf", 3)
    out = tmp_path / "out"
    result = harness.op(
        "convert.pdfToImages",
        {
            "path": str(src),
            "outputDir": str(out),
            "format": "tiff",
            "multiPageTiff": True,
            "dpi": 72,
        },
    )
    assert len(result["outputs"]) == 1
    with Image.open(result["outputs"][0]) as img:
        assert img.n_frames == 3


def test_webp_and_gray(harness: Harness, tmp_path: Path) -> None:
    if not features.check("webp"):
        pytest.skip("Pillow without WebP support")
    src = _text_pdf(tmp_path / "doc.pdf", 1)
    out = tmp_path / "out"
    result = harness.op(
        "convert.pdfToImages",
        {"path": str(src), "outputDir": str(out), "format": "webp", "color": "gray", "dpi": 72},
    )
    with Image.open(result["outputs"][0]) as img:
        assert img.format == "WEBP" and img.size == (612, 792)


def test_names_never_overwrite(harness: Harness, tmp_path: Path) -> None:
    src = _text_pdf(tmp_path / "doc.pdf", 1)
    out = tmp_path / "out"
    args = {"path": str(src), "outputDir": str(out), "dpi": 72}
    first = harness.op("convert.pdfToImages", args)["outputs"][0]
    second = harness.op("convert.pdfToImages", args)["outputs"][0]
    assert first != second and Path(second).name == "doc_1 (2).png"


def test_bad_page_index_rejected(harness: Harness, tmp_path: Path) -> None:
    src = _text_pdf(tmp_path / "doc.pdf", 1)
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "convert.pdfToImages",
            {"path": str(src), "outputDir": str(tmp_path / "o"), "pages": [5]},
        )
    assert exc.value.kind == "INVALID_PARAMS"


# -- images to PDF --------------------------------------------------------------------


def _all_formats(tmp_path: Path) -> dict[str, Path]:
    files: dict[str, Path] = {}
    rgb = Image.new("RGB", (120, 80), (10, 120, 200))
    files["png"] = tmp_path / "a.png"
    rgb.save(files["png"])
    files["jpg"] = tmp_path / "b.jpg"
    rgb.save(files["jpg"], quality=90)
    files["bmp"] = tmp_path / "c.bmp"
    rgb.save(files["bmp"])
    files["gif"] = tmp_path / "d.gif"
    rgb.convert("P").save(files["gif"])
    frames = [Image.new("RGB", (50, 70), c) for c in ((255, 0, 0), (0, 255, 0), (0, 0, 255))]
    files["tif"] = tmp_path / "e.tif"
    frames[0].save(files["tif"], save_all=True, append_images=frames[1:])
    if features.check("webp"):
        files["webp"] = tmp_path / "f.webp"
        rgb.save(files["webp"])
    return files


def test_all_input_formats_one_page_each(harness: Harness, tmp_path: Path) -> None:
    files = _all_formats(tmp_path)
    order = [files[k] for k in ("png", "jpg", "bmp", "gif", "tif")]
    if "webp" in files:
        order.append(files["webp"])
    out = tmp_path / "out.pdf"
    result = harness.op(
        "convert.imagesToPdf",
        {
            "images": [str(p) for p in order],
            "outputPath": str(out),
            "pageSize": "fit-image",
            "dpi": 72,
            "marginMm": 0,
        },
    )
    assert result["outputs"] == [str(out)]
    # At 72 dpi each page is its pixel size. The TIFF contributes one page per frame (50x70).
    expected = [(120.0, 80.0), (120.0, 80.0), (120.0, 80.0), (120.0, 80.0)]
    expected += [(50.0, 70.0)] * 3
    if "webp" in files:
        expected.append((120.0, 80.0))
    assert _page_sizes(out) == expected


def test_jpeg_is_embedded_without_reencoding(harness: Harness, tmp_path: Path) -> None:
    src = tmp_path / "photo.jpg"
    Image.new("RGB", (300, 200), (90, 90, 90)).save(src, quality=80)
    out = tmp_path / "photo.pdf"
    harness.op("convert.imagesToPdf", {"images": [str(src)], "outputPath": str(out)})
    with pikepdf.open(out) as pdf:
        image = pdf.pages[0].obj.Resources.XObject.Im0
        assert str(image.Filter) == "/DCTDecode"
        assert len(image.read_raw_bytes()) == src.stat().st_size


def test_exif_orientation_swaps_natural_size(harness: Harness, tmp_path: Path) -> None:
    src = tmp_path / "rotated.jpg"
    img = Image.new("RGB", (200, 100), (255, 0, 0))
    exif = Image.Exif()
    exif[0x0112] = 6  # rotate 90 degrees clockwise to display
    img.save(src, exif=exif.tobytes(), quality=95)
    out = tmp_path / "rotated.pdf"
    harness.op(
        "convert.imagesToPdf",
        {
            "images": [str(src)],
            "outputPath": str(out),
            "pageSize": "fit-image",
            "dpi": 72,
            "marginMm": 0,
        },
    )
    assert _page_sizes(out) == [(100.0, 200.0)]
    pixel = render(out).getpixel((50, 100))
    assert pixel[0] > 200 and pixel[1] < 80  # still red


def test_alpha_is_flattened_onto_white(harness: Harness, tmp_path: Path) -> None:
    src = tmp_path / "alpha.png"
    Image.new("RGBA", (100, 100), (255, 0, 0, 0)).save(src)  # fully transparent red
    out = tmp_path / "alpha.pdf"
    harness.op(
        "convert.imagesToPdf",
        {
            "images": [str(src)],
            "outputPath": str(out),
            "pageSize": "fit-image",
            "dpi": 72,
            "marginMm": 0,
        },
    )
    pixel = render(out).getpixel((50, 50))
    assert min(pixel) > 250  # white, not red and not black


def test_a4_landscape_for_landscape_image(harness: Harness, tmp_path: Path) -> None:
    src = tmp_path / "wide.png"
    Image.new("RGB", (400, 200), (0, 0, 0)).save(src)
    out = tmp_path / "wide.pdf"
    harness.op("convert.imagesToPdf", {"images": [str(src)], "outputPath": str(out)})
    width, height = _page_sizes(out)[0]
    assert round(width) == round(A4[1]) and round(height) == round(A4[0])


def test_portrait_forced_and_letter(harness: Harness, tmp_path: Path) -> None:
    src = tmp_path / "wide.png"
    Image.new("RGB", (400, 200), (0, 0, 0)).save(src)
    out = tmp_path / "letter.pdf"
    harness.op(
        "convert.imagesToPdf",
        {
            "images": [str(src)],
            "outputPath": str(out),
            "pageSize": "letter",
            "orientation": "portrait",
        },
    )
    assert _page_sizes(out) == [(612.0, 792.0)]


def test_custom_mm_and_fill_covers_page(harness: Harness, tmp_path: Path) -> None:
    src = tmp_path / "sq.png"
    Image.new("RGB", (100, 100), (0, 128, 0)).save(src)
    out = tmp_path / "fill.pdf"
    harness.op(
        "convert.imagesToPdf",
        {
            "images": [str(src)],
            "outputPath": str(out),
            "pageSize": "custom",
            "customWidthMm": 100,
            "customHeightMm": 50,
            "marginMm": 0,
            "fit": "fill",
        },
    )
    width, height = _page_sizes(out)[0]
    assert round(width, 0) == round(100 * 72 / 25.4) and round(height, 0) == round(50 * 72 / 25.4)
    pixel = render(out).getpixel((5, 5))
    assert pixel[1] > 100 and pixel[0] < 60  # the fill covers the corner


def test_center_keeps_natural_size(harness: Harness, tmp_path: Path) -> None:
    src = tmp_path / "small.png"
    Image.new("RGB", (72, 72), (0, 0, 255)).save(src)
    out = tmp_path / "center.pdf"
    harness.op(
        "convert.imagesToPdf",
        {"images": [str(src)], "outputPath": str(out), "fit": "center", "dpi": 72},
    )
    assert _page_sizes(out) == [(round(A4[0], 2), round(A4[1], 2))]
    pixel = render(out).getpixel((306, 396))
    assert pixel[2] > 200 and pixel[0] < 60


def test_pages_keep_input_order(harness: Harness, tmp_path: Path) -> None:
    paths = []
    for i, width in enumerate((30, 60, 90)):
        path = tmp_path / f"p{i}.png"
        Image.new("RGB", (width, 40), (0, 0, 0)).save(path)
        paths.append(str(path))
    out = tmp_path / "order.pdf"
    harness.op(
        "convert.imagesToPdf",
        {
            "images": paths[::-1],
            "outputPath": str(out),
            "pageSize": "fit-image",
            "dpi": 72,
            "marginMm": 0,
        },
    )
    assert [w for w, _ in _page_sizes(out)] == [90.0, 60.0, 30.0]


def test_missing_custom_size_and_huge_margin_rejected(harness: Harness, tmp_path: Path) -> None:
    src = tmp_path / "x.png"
    Image.new("RGB", (10, 10)).save(src)
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "convert.imagesToPdf",
            {"images": [str(src)], "outputPath": str(tmp_path / "a.pdf"), "pageSize": "custom"},
        )
    assert exc.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "convert.imagesToPdf",
            {
                "images": [str(src)],
                "outputPath": str(tmp_path / "b.pdf"),
                "pageSize": "custom",
                "customWidthMm": 10,
                "customHeightMm": 10,
                "marginMm": 10,
            },
        )
    assert exc.value.kind == "INVALID_PARAMS"


def test_multi_frame_tiff_pages(harness: Harness, tmp_path: Path) -> None:
    files = _all_formats(tmp_path)
    out = tmp_path / "tiff.pdf"
    harness.op(
        "convert.imagesToPdf",
        {
            "images": [str(files["tif"])],
            "outputPath": str(out),
            "pageSize": "fit-image",
            "dpi": 72,
            "marginMm": 0,
        },
    )
    assert len(_page_sizes(out)) == 3


def test_text_pdf_round_trip_through_images(harness: Harness, tmp_path: Path) -> None:
    """Render, then rebuild: the rebuilt PDF has the same page count and looks the same."""
    src = _text_pdf(tmp_path / "doc.pdf", 2)
    out_dir = tmp_path / "pics"
    images = harness.op(
        "convert.pdfToImages", {"path": str(src), "outputDir": str(out_dir), "dpi": 100}
    )["outputs"]
    rebuilt = tmp_path / "rebuilt.pdf"
    harness.op(
        "convert.imagesToPdf",
        {
            "images": images,
            "outputPath": str(rebuilt),
            "pageSize": "fit-image",
            "dpi": 100,
            "marginMm": 0,
        },
    )
    assert len(_page_sizes(rebuilt)) == 2
    assert "Page 1" in page_text(src, 0)  # the source keeps its text
    assert render(rebuilt, 1).size == render(src, 1).size
