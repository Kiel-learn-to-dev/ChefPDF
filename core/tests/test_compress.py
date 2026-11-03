"""Compress PDF (M1): presets, image rules, clean-up, estimate, fit-to-size, standalone file."""

from __future__ import annotations

from pathlib import Path

import pikepdf
import pytest
from conftest import Harness, RpcFailure
from pdf_media import (
    bilevel_xobject,
    image_dims,
    image_xobject,
    mean_abs_diff,
    new_pdf,
    noisy_rgb,
    page_text,
    pdf_size,
    photo_like,
    place,
    render,
    save,
)
from PIL import Image

from chef_core.ops.compress import dpi_ladder


def _open(h: Harness, path: Path) -> str:
    return str(h.open(path)["state"]["sessionId"])


def _rev(h: Harness, sid: str) -> Path:
    return Path(h.call("session.state", {"sessionId": sid})["revisionPath"])


def _big_photo_pdf(path: Path, width: int = 2400, height: int = 1800) -> Path:
    """One full-page noisy JPEG (about 290 dpi on A4-ish page) with a line of text."""
    pdf = new_pdf(1, 612, 792)
    photo = image_xobject(pdf, photo_like(width, height, seed=3), quality=95)
    place(pdf, pdf.pages[0], [("Im0", photo, 0, 0, 612, 792)], text="Hello Chef")
    return save(pdf, path)


# -- presets and image resampling -----------------------------------------------------


def test_ebook_downsamples_large_jpeg_and_keeps_look(harness: Harness, tmp_path: Path) -> None:
    src = _big_photo_pdf(tmp_path / "photo.pdf")
    sid = _open(harness, src)
    result = harness.op("compress.pdf", {"preset": "ebook"}, sid)
    data = result["data"]
    assert data["imagesProcessed"] == 1
    assert data["bytesAfter"] < data["bytesBefore"] * 0.5
    out = _rev(harness, sid)
    ((width, height),) = image_dims(out)
    assert width <= 150 * 612 / 72 + 1 and height <= 150 * 792 / 72 + 1
    before, after = render(src, dpi=72), render(out, dpi=72)
    assert mean_abs_diff(before, after) < 6.0
    assert "Hello" in page_text(out)


def test_screen_is_smaller_than_ebook(harness: Harness, tmp_path: Path) -> None:
    src = _big_photo_pdf(tmp_path / "photo.pdf")
    sid = _open(harness, src)
    ebook = harness.op("compress.estimate", {"preset": "ebook"}, sid)["data"]["bytesAfter"]
    screen = harness.op("compress.estimate", {"preset": "screen"}, sid)["data"]["bytesAfter"]
    assert screen < ebook


def test_print_keeps_images_within_300_dpi(harness: Harness, tmp_path: Path) -> None:
    src = _big_photo_pdf(tmp_path / "photo.pdf", 1200, 1600)
    sid = _open(harness, src)
    harness.op("compress.pdf", {"preset": "print"}, sid)
    # 1200 px over 8.5 in is 141 dpi: under 300, so the size is kept (only JPEG quality changes)
    assert image_dims(_rev(harness, sid)) == image_dims(src)


def test_archive_light_never_resamples(harness: Harness, tmp_path: Path) -> None:
    src = _big_photo_pdf(tmp_path / "photo.pdf")
    sid = _open(harness, src)
    result = harness.op("compress.pdf", {"preset": "archive-light"}, sid)
    assert result["data"]["imagesProcessed"] == 0
    assert image_dims(_rev(harness, sid)) == [(2400, 1800)]
    assert "Hello" in page_text(_rev(harness, sid))


def test_custom_max_dpi_overrides_preset(harness: Harness, tmp_path: Path) -> None:
    src = _big_photo_pdf(tmp_path / "photo.pdf")
    sid = _open(harness, src)
    harness.op("compress.pdf", {"preset": "print", "maxImageDpi": 100}, sid)
    ((width, _),) = image_dims(_rev(harness, sid))
    assert width <= 100 * 612 / 72 + 1


def test_shared_image_is_processed_once(harness: Harness, tmp_path: Path) -> None:
    pdf = new_pdf(2)
    photo = image_xobject(pdf, photo_like(2000, 2000, seed=5), quality=95)
    for page in pdf.pages:
        place(pdf, page, [("Im0", photo, 0, 0, 612, 792)])
    src = save(pdf, tmp_path / "shared.pdf")
    sid = _open(harness, src)
    result = harness.op("compress.pdf", {"preset": "ebook"}, sid)
    assert result["data"]["imagesProcessed"] == 1
    out = _rev(harness, sid)
    assert image_dims(out, 0) == image_dims(out, 1)
    assert mean_abs_diff(render(src, 1), render(out, 1)) < 8.0


def test_alpha_image_keeps_soft_mask_resampled(harness: Harness, tmp_path: Path) -> None:
    pdf = new_pdf(1)
    rgb = photo_like(1800, 1800, seed=4)
    alpha = Image.new("L", (1800, 1800), 255)
    alpha.paste(0, (0, 0, 900, 1800))  # left half transparent
    picture = image_xobject(pdf, rgb, codec="flate", alpha=alpha)
    place(pdf, pdf.pages[0], [("Im0", picture, 0, 0, 612, 792)])
    src = save(pdf, tmp_path / "alpha.pdf")
    sid = _open(harness, src)
    harness.op("compress.pdf", {"preset": "ebook"}, sid)
    out = _rev(harness, sid)
    with pikepdf.open(out) as doc:
        image = doc.pages[0].obj.Resources.XObject.Im0
        mask = image.SMask
        assert int(mask.Width) == int(image.Width) and int(mask.Height) == int(image.Height)
        assert int(image.Width) < 1800
    assert mean_abs_diff(render(src), render(out)) < 6.0


def test_cmyk_jpeg_keeps_colour(harness: Harness, tmp_path: Path) -> None:
    pdf = new_pdf(1)
    cmyk = Image.new("CMYK", (1600, 1600), (255, 0, 0, 0))  # pure cyan
    obj = image_xobject(pdf, cmyk, quality=95)
    place(pdf, pdf.pages[0], [("Im0", obj, 0, 0, 612, 792)])
    src = save(pdf, tmp_path / "cmyk.pdf")
    sid = _open(harness, src)
    result = harness.op("compress.pdf", {"preset": "ebook"}, sid)
    assert result["data"]["imagesProcessed"] == 1
    out = _rev(harness, sid)
    with pikepdf.open(out) as doc:
        assert str(doc.pages[0].obj.Resources.XObject.Im0.ColorSpace) == "/DeviceCMYK"
    # Compare with the original's own rendering: whatever the CMYK convention, it must not change.
    assert mean_abs_diff(render(src), render(out)) < 3.0


def test_grayscale_option_converts_images(harness: Harness, tmp_path: Path) -> None:
    src = _big_photo_pdf(tmp_path / "photo.pdf", 800, 800)
    sid = _open(harness, src)
    harness.op("compress.pdf", {"preset": "custom", "grayscale": True}, sid)
    with pikepdf.open(_rev(harness, sid)) as doc:
        assert str(doc.pages[0].obj.Resources.XObject.Im0.ColorSpace) == "/DeviceGray"


def test_bilevel_line_art_is_untouched(harness: Harness, tmp_path: Path) -> None:
    pdf = new_pdf(1)
    scan = bilevel_xobject(pdf, (4000, 5600))
    place(pdf, pdf.pages[0], [("Im0", scan, 0, 0, 612, 792)], text="Scan")
    src = save(pdf, tmp_path / "bilevel.pdf")
    sid = _open(harness, src)
    result = harness.op("compress.pdf", {"preset": "screen"}, sid)
    assert result["data"]["skippedReasons"].get("1-bit line art") == 1
    assert image_dims(_rev(harness, sid)) == [(4000, 5600)]
    assert "Scan" in page_text(_rev(harness, sid))


def test_never_enlarges_small_images(harness: Harness, tmp_path: Path) -> None:
    pdf = new_pdf(1)
    tiny = image_xobject(pdf, noisy_rgb(40, 40, seed=9), quality=40)
    place(pdf, pdf.pages[0], [("Im0", tiny, 0, 0, 100, 100)])
    src = save(pdf, tmp_path / "tiny.pdf")
    sid = _open(harness, src)
    result = harness.op("compress.pdf", {"preset": "screen"}, sid)
    assert result["data"]["imagesProcessed"] == 0
    assert image_dims(_rev(harness, sid)) == [(40, 40)]


def test_repeated_placement_size_uses_smallest(harness: Harness, tmp_path: Path) -> None:
    """One image drawn large and small: the small placement (higher dpi) sets the size."""
    pdf = new_pdf(1)
    photo = image_xobject(pdf, noisy_rgb(1500, 1500, seed=11), quality=95)
    place(pdf, pdf.pages[0], [("Im0", photo, 0, 0, 612, 792), ("Im0", photo, 0, 0, 72, 72)])
    src = save(pdf, tmp_path / "twice.pdf")
    sid = _open(harness, src)
    harness.op("compress.pdf", {"preset": "ebook"}, sid)
    ((width, _),) = image_dims(_rev(harness, sid))
    assert width <= 150 * 72 / 72 + 2  # 1 inch placement at 150 dpi


# -- clean-up -------------------------------------------------------------------------


def test_metadata_and_thumbnails_removed(harness: Harness, tmp_path: Path) -> None:
    pdf = new_pdf(1)
    pdf.docinfo["/Title"] = "Secret title"
    pdf.pages[0].obj["/Thumb"] = pdf.make_stream(b"")
    place(pdf, pdf.pages[0], [], text="Text")
    src = save(pdf, tmp_path / "meta.pdf")
    sid = _open(harness, src)
    harness.op(
        "compress.pdf",
        {"preset": "custom", "removeMetadata": True, "removeThumbnails": True},
        sid,
    )
    with pikepdf.open(_rev(harness, sid)) as doc:
        assert "/Title" not in doc.docinfo
        assert "/Thumb" not in doc.pages[0].obj


def test_unused_resources_and_fonts_dropped(harness: Harness, tmp_path: Path) -> None:
    pdf = new_pdf(1)
    spare = image_xobject(pdf, noisy_rgb(200, 200, seed=2), quality=90)
    place(pdf, pdf.pages[0], [("Im0", spare, 0, 0, 10, 10)], text="A")
    pdf.pages[0].Resources.XObject.Im9 = spare  # listed but never drawn
    pdf.pages[0].Resources.Font.F9 = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Courier
        )
    )
    src = save(pdf, tmp_path / "unused.pdf")
    sid = _open(harness, src)
    result = harness.op("compress.pdf", {"preset": "custom"}, sid)
    assert result["data"]["resourcesDropped"] >= 1
    assert result["data"]["fontsDropped"] >= 1
    with pikepdf.open(_rev(harness, sid)) as doc:
        assert "/Im9" not in doc.pages[0].obj.Resources.XObject
        assert "/F9" not in doc.pages[0].obj.Resources.Font
        assert "/F1" in doc.pages[0].obj.Resources.Font
    assert "A" in page_text(_rev(harness, sid))


def test_annotations_removed_but_widgets_kept(harness: Harness, tmp_path: Path) -> None:
    pdf = new_pdf(1)
    place(pdf, pdf.pages[0], [], text="Form")
    note = pdf.make_indirect(
        pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Text, Rect=[0, 0, 10, 10])
    )
    widget = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Annot,
            Subtype=pikepdf.Name.Widget,
            Rect=[0, 0, 10, 10],
            FT=pikepdf.Name.Tx,
            T=pikepdf.String("f1"),
        )
    )
    pdf.pages[0].obj["/Annots"] = pikepdf.Array([note, widget])
    src = save(pdf, tmp_path / "annots.pdf")
    sid = _open(harness, src)
    result = harness.op("compress.pdf", {"preset": "custom", "removeAnnotations": True}, sid)
    assert any("form fields" in w for w in result["warnings"])
    with pikepdf.open(_rev(harness, sid)) as doc:
        annots = doc.pages[0].obj.Annots
        assert len(annots) == 1 and annots[0].Subtype == pikepdf.Name.Widget


# -- estimate, fit to size, standalone ------------------------------------------------


def test_estimate_matches_real_result(harness: Harness, tmp_path: Path) -> None:
    src = _big_photo_pdf(tmp_path / "photo.pdf")
    sid = _open(harness, src)
    estimated = harness.op("compress.estimate", {"preset": "ebook"}, sid)
    assert estimated["changedPages"] == []
    real = harness.op("compress.pdf", {"preset": "ebook"}, sid)["data"]
    assert estimated["data"]["bytesAfter"] == real["bytesAfter"]
    assert _rev(harness, sid).exists()


def test_fit_size_finds_params_that_fit(harness: Harness, tmp_path: Path) -> None:
    src = _big_photo_pdf(tmp_path / "photo.pdf")
    sid = _open(harness, src)
    target = pdf_size(src) // 4
    data = harness.op("compress.fitSize", {"preset": "print", "targetBytes": target}, sid)["data"]
    assert data["reachable"] is True
    assert data["estimatedBytes"] <= target
    assert data["params"]["maxImageDpi"] <= 300 and data["params"]["jpegQuality"] <= 85
    assert data["steps"] >= 2


def test_fit_size_unreachable(harness: Harness, tmp_path: Path) -> None:
    src = _big_photo_pdf(tmp_path / "photo.pdf", 400, 400)
    sid = _open(harness, src)
    data = harness.op("compress.fitSize", {"targetBytes": 10, "minDpi": 72}, sid)["data"]
    assert data["reachable"] is False
    assert data["estimatedBytes"] > 10


def test_fit_and_apply_size_writes_a_revision_within_target(
    harness: Harness, tmp_path: Path
) -> None:
    src = _big_photo_pdf(tmp_path / "photo.pdf")
    sid = _open(harness, src)
    target = pdf_size(src) // 2
    result = harness.op("compress.toSize", {"preset": "print", "targetBytes": target}, sid)
    assert result["state"]["revision"] == 1
    assert _rev(harness, sid).stat().st_size <= target


def test_fit_and_apply_size_refuses_unreachable_target(harness: Harness, tmp_path: Path) -> None:
    src = _big_photo_pdf(tmp_path / "photo.pdf", 400, 400)
    sid = _open(harness, src)
    with pytest.raises(RpcFailure) as exc:
        harness.op("compress.toSize", {"targetBytes": 10, "minDpi": 72}, sid)
    assert exc.value.kind == "INVALID_PARAMS"
    assert _rev(harness, sid).read_bytes() == src.read_bytes()


def test_fit_size_validation(harness: Harness, tmp_path: Path) -> None:
    src = _big_photo_pdf(tmp_path / "photo.pdf", 400, 400)
    sid = _open(harness, src)
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "compress.fitSize", {"targetBytes": 1000, "minDpi": 400, "maxImageDpi": 150}, sid
        )
    assert exc.value.kind == "INVALID_PARAMS"


def test_standalone_file_leaves_input_untouched(harness: Harness, tmp_path: Path) -> None:
    src = _big_photo_pdf(tmp_path / "photo.pdf")
    before = src.read_bytes()
    out = tmp_path / "small.pdf"
    result = harness.op(
        "compress.file",
        {"inputPath": str(src), "outputPath": str(out), "preset": "ebook"},
    )
    assert result["outputs"] == [str(out)]
    assert src.read_bytes() == before
    assert out.stat().st_size < src.stat().st_size
    assert "Hello" in page_text(out)


def test_standalone_file_in_place(harness: Harness, tmp_path: Path) -> None:
    src = _big_photo_pdf(tmp_path / "photo.pdf")
    harness.op("compress.file", {"inputPath": str(src), "outputPath": str(src), "preset": "ebook"})
    assert image_dims(src)[0][0] <= 150 * 612 / 72 + 1


def test_pdf_result_has_report(harness: Harness, tmp_path: Path) -> None:
    src = _big_photo_pdf(tmp_path / "photo.pdf")
    sid = _open(harness, src)
    data = harness.op("compress.pdf", {"preset": "ebook"}, sid)["data"]
    assert data["ratio"] == round(data["bytesAfter"] / data["bytesBefore"], 4)
    assert set(data) >= {"bytesBefore", "bytesAfter", "ratio", "imagesProcessed", "imagesSkipped"}


def test_dpi_ladder_bounds() -> None:
    assert dpi_ladder(300, 72) == [300, 250, 200, 150, 120, 96, 72]
    assert dpi_ladder(150, 100) == [150, 120, 100]


def test_signed_document_is_blocked(harness: Harness, corpus: dict[str, Path]) -> None:
    sid = _open(harness, corpus["fake_signed.pdf"])
    with pytest.raises(RpcFailure) as exc:
        harness.op("compress.pdf", {"preset": "ebook"}, sid)
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"
