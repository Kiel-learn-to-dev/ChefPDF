"""Colour conversion (M6): gray, black & white, ink saver, replace colour, undo, signed."""

from __future__ import annotations

from pathlib import Path

import pikepdf
import pytest
from conftest import Harness, RpcFailure
from pdf_media import (
    image_xobject,
    new_pdf,
    page_text,
    photo_like,
    place,
    render,
    save,
)
from PIL import Image, ImageStat

CONTENT = (
    b"1 0 0 rg 40 500 200 200 re f\n"  # red box (RGB)
    b"0 1 0 0 k 300 500 200 200 re f\n"  # green box (CMYK, cyan-free: magenta/yellow mix)
    b"0.5 g 40 250 200 200 re f\n"  # mid gray box
    b"0 0 1 rg BT /F1 40 Tf 40 120 Td (Hello Chef) Tj ET\n"  # blue text
)


def _colour_page(path: Path, extra: bytes = b"", pages: int = 1) -> Path:
    pdf = new_pdf(pages)
    for page in pdf.pages:
        place(pdf, page, [])
        page.obj.Contents = pdf.make_stream(CONTENT + extra)
    return save(pdf, path)


def _pixel(path: Path, x: float, y: float, page: int = 0) -> tuple[int, int, int]:
    """Pixel at PDF user-space coordinates (x, y) of a 612x792 page rendered at 72 dpi."""
    img = render(path, page)
    value = img.getpixel((int(x), int(792 - y)))
    return value[0], value[1], value[2]


def _mean_chroma(img: Image.Image) -> float:
    stat = ImageStat.Stat(img.convert("RGB"))
    r, g, b = stat.mean
    return max(abs(r - g), abs(g - b), abs(r - b))


def test_gray_mode_removes_all_colour(harness: Harness, tmp_path: Path) -> None:
    src = _colour_page(tmp_path / "c.pdf")
    sid = str(harness.open(src)["state"]["sessionId"])
    result = harness.op("color.convert", {"mode": "gray"}, sid)
    assert result["data"]["coloursChanged"] == 3  # red, CMYK green and blue text (gray stays)
    out = Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])
    img = render(out)
    assert _mean_chroma(img) < 1.0
    assert _pixel(out, 100, 600)[0] == _pixel(out, 100, 600)[1] == _pixel(out, 100, 600)[2]
    assert "Hello" in page_text(out)


def test_gray_mode_converts_images(harness: Harness, tmp_path: Path) -> None:
    pdf = new_pdf(1)
    photo = image_xobject(pdf, photo_like(600, 600, seed=2), quality=92)
    place(pdf, pdf.pages[0], [("Im0", photo, 0, 0, 300, 300)])
    src = save(pdf, tmp_path / "img.pdf")
    sid = str(harness.open(src)["state"]["sessionId"])
    result = harness.op("color.convert", {"mode": "gray"}, sid)
    assert result["data"]["imagesChanged"] == 1
    out = Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])
    assert _mean_chroma(render(out)) < 2.0


def test_blackwhite_is_binary(harness: Harness, tmp_path: Path) -> None:
    src = _colour_page(tmp_path / "bw.pdf")
    sid = str(harness.open(src)["state"]["sessionId"])
    harness.op("color.convert", {"mode": "blackwhite", "threshold": 128}, sid)
    out = Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])
    histogram = render(out).convert("L").histogram()
    mid = sum(histogram[21:235])
    assert mid / sum(histogram) < 0.03  # only anti-aliased edges are in between
    assert _pixel(out, 100, 600)[0] < 5  # the red box is black now (luminance 76)


def test_ink_saver_lightens_shapes_but_not_text(harness: Harness, tmp_path: Path) -> None:
    pdf = new_pdf(1)
    place(pdf, pdf.pages[0], [])
    pdf.pages[0].obj.Contents = pdf.make_stream(
        b"0 0 0 rg 40 500 500 200 re f\n"  # black box
        b"0 0 0 rg BT /F1 60 Tf 40 300 Td (Dark) Tj ET\n"  # black text
    )
    src = save(pdf, tmp_path / "ink.pdf")
    sid = str(harness.open(src)["state"]["sessionId"])
    harness.op("color.convert", {"mode": "ink-saver", "amount": 0.5}, sid)
    out = Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])
    box = _pixel(out, 200, 600)
    assert 100 < box[0] < 160  # lightened toward white
    # The text baseline is at PDF y=300, so image rows around 492 hold the text.
    text_img = render(out).convert("L").crop((40, 440, 300, 520))
    assert text_img.getextrema()[0] < 60  # the text is still dark


def test_replace_colour_in_vectors_and_images(harness: Harness, tmp_path: Path) -> None:
    pdf = new_pdf(1)
    picture = Image.new("RGB", (100, 100), (0, 255, 0))
    for x in range(50):
        for y in range(100):
            picture.putpixel((x, y), (255, 0, 0))
    obj = image_xobject(pdf, picture, codec="flate")
    place(pdf, pdf.pages[0], [("Im0", obj, 300, 100, 200, 200)])
    pdf.pages[0].obj.Contents = pdf.make_stream(
        b"1 0 0 rg 40 500 200 200 re f\n"  # red box
        b"0 1 0 rg 300 500 200 200 re f\n"  # green box, must not change
        + pdf.pages[0].obj.Contents.read_bytes()
    )
    src = save(pdf, tmp_path / "replace.pdf")
    sid = str(harness.open(src)["state"]["sessionId"])
    result = harness.op(
        "color.convert",
        {
            "mode": "replace-color",
            "sourceColor": "#ff0000",
            "targetColor": "#0000ff",
            "tolerance": 20,
        },
        sid,
    )
    assert result["data"]["coloursChanged"] >= 1 and result["data"]["imagesChanged"] == 1
    out = Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])
    assert _pixel(out, 100, 600)[2] > 200 and _pixel(out, 100, 600)[0] < 40  # blue now
    assert _pixel(out, 400, 600)[1] > 200 and _pixel(out, 400, 600)[0] < 40  # green kept
    assert _pixel(out, 350, 150)[2] > 200  # image red became blue


def test_replace_needs_colours(harness: Harness, tmp_path: Path) -> None:
    src = _colour_page(tmp_path / "x.pdf")
    sid = str(harness.open(src)["state"]["sessionId"])
    with pytest.raises(RpcFailure) as exc:
        harness.call(
            "ops.run",
            {"sessionId": sid, "opId": "color.convert", "params": {"mode": "replace-color"}},
        )
    assert exc.value.kind == "INVALID_PARAMS"


def test_only_selected_pages_change(harness: Harness, tmp_path: Path) -> None:
    src = _colour_page(tmp_path / "two.pdf", pages=2)
    sid = str(harness.open(src)["state"]["sessionId"])
    result = harness.op("color.convert", {"mode": "gray", "pages": [1]}, sid)
    assert result["changedPages"] == [1]
    out = Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])
    assert _mean_chroma(render(out, 1)) < 1.0
    assert _mean_chroma(render(out, 0)) > 20.0


def test_spot_colours_are_kept_with_warning(harness: Harness, tmp_path: Path) -> None:
    pdf = new_pdf(1)
    place(pdf, pdf.pages[0], [])
    separation = pikepdf.Array(
        [
            pikepdf.Name.Separation,
            pikepdf.Name("/Spot"),
            pikepdf.Name.DeviceCMYK,
            pikepdf.Dictionary(
                FunctionType=2, Domain=[0, 1], C0=[0, 0, 0, 0], C1=[0, 1, 0, 0], N=1
            ),
        ]
    )
    pdf.pages[0].obj.Resources.ColorSpace = pikepdf.Dictionary(CS0=pdf.make_indirect(separation))
    pdf.pages[0].obj.Contents = pdf.make_stream(b"/CS0 cs 1 scn 40 40 100 100 re f\n")
    src = save(pdf, tmp_path / "spot.pdf")
    sid = str(harness.open(src)["state"]["sessionId"])
    result = harness.op("color.convert", {"mode": "gray"}, sid)
    assert any("spot" in w for w in result["warnings"])


def test_colours_inside_forms_are_converted(harness: Harness, tmp_path: Path) -> None:
    pdf = new_pdf(1)
    form = pdf.make_stream(b"1 0 0 rg 0 0 300 300 re f")
    form.Type = pikepdf.Name.XObject
    form.Subtype = pikepdf.Name.Form
    form.BBox = [0, 0, 300, 300]
    place(pdf, pdf.pages[0], [])
    pdf.pages[0].obj.Resources.XObject = pikepdf.Dictionary(Fm0=form)
    pdf.pages[0].obj.Contents = pdf.make_stream(b"q 1 0 0 1 100 100 cm /Fm0 Do Q")
    src = save(pdf, tmp_path / "form.pdf")
    sid = str(harness.open(src)["state"]["sessionId"])
    result = harness.op("color.convert", {"mode": "gray"}, sid)
    assert result["data"]["coloursChanged"] == 1
    out = Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])
    assert _mean_chroma(render(out)) < 1.0


def test_undo_restores_colours(harness: Harness, tmp_path: Path) -> None:
    src = _colour_page(tmp_path / "undo.pdf")
    sid = str(harness.open(src)["state"]["sessionId"])
    harness.op("color.convert", {"mode": "gray"}, sid)
    harness.call("session.undo", {"sessionId": sid})
    out = Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])
    assert _mean_chroma(render(out)) > 20.0


def test_signed_document_is_blocked(harness: Harness, corpus: dict[str, Path]) -> None:
    sid = str(harness.open(corpus["fake_signed.pdf"])["state"]["sessionId"])
    with pytest.raises(RpcFailure) as exc:
        harness.op("color.convert", {"mode": "gray"}, sid)
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"
