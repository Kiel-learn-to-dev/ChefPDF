"""T6.04: replace, adjust and extract image placements (pixel checks on rendered output)."""

from __future__ import annotations

from pathlib import Path

import pikepdf
import pytest
from conftest import Harness, RpcFailure
from content_support import ink_bbox
from pdf_media import image_xobject, new_pdf, place, render, save
from PIL import Image

from chef_core.content.verify import assert_unchanged_outside

RED = (255, 0, 0)
PLACE = (100.0, 100.0, 200.0, 100.0)  # x, y, width, height of the placed image (points)
BOX = (100.0, 100.0, 300.0, 200.0)  # the same box as x0, y0, x1, y1


def _page_with_images(
    path: Path,
    *,
    shared: bool = False,
    codec: str = "flate",
    colour: tuple[int, int, int] = RED,
) -> Path:
    """One page with a 40 x 40 image in PLACE (and a second placement of it if shared)."""
    pdf = new_pdf(1)
    page = pdf.pages[0]
    img = image_xobject(pdf, Image.new("RGB", (40, 40), colour), codec=codec)
    items = [("Im1", img, *PLACE)]
    if shared:
        items.append(("Im1", img, 350, 100, 100, 100))
    place(pdf, page, items[:1])
    if shared:
        page.obj.Contents = pdf.make_stream(
            b"q 200 0 0 100 100 100 cm /Im1 Do Q q 100 0 0 100 350 100 cm /Im1 Do Q"
        )
    return save(pdf, path)


def _png(path: Path, colour: tuple[int, int, int], size: tuple[int, int] = (10, 10)) -> Path:
    Image.new("RGB", size, colour).save(path, format="PNG")
    return path


def _sid(harness: Harness, path: Path) -> str:
    return str(harness.open(path)["state"]["sessionId"])


def _revision(harness: Harness, sid: str) -> Path:
    return Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])


def _image_id(harness: Harness, sid: str, index: int = 0) -> str:
    objs = harness.op("content.listObjects", {"pageIndex": 0}, sid)["data"]["objects"]
    return str([o for o in objs if o["kind"] == "image"][index]["id"])


def _rgb(path: Path, x: float, y: float) -> tuple[int, int, int]:
    img = render(path, 0).convert("RGB")
    value = img.getpixel((int(x), int(792 - y)))
    return int(value[0]), int(value[1]), int(value[2])


def test_replace_image_contain_keeps_the_box_and_centres_the_new_image(
    harness: Harness, tmp_path: Path
) -> None:
    src = _page_with_images(tmp_path / "r.pdf")
    sid = _sid(harness, src)
    blue = _png(tmp_path / "blue.png", (0, 0, 255))
    res = harness.op(
        "content.replaceImage",
        {"pageIndex": 0, "objectId": _image_id(harness, sid), "path": str(blue), "fit": "contain"},
        sid,
    )
    assert res["changedPages"] == [0]
    out = _revision(harness, sid)
    # a square image in a 200 x 100 box: 100 x 100 in the middle of the box
    assert _rgb(out, 200, 150) == (0, 0, 255)
    assert _rgb(out, 120, 150) == (255, 255, 255)  # empty part of the box
    assert _rgb(out, 280, 150) == (255, 255, 255)
    assert_unchanged_outside(src, out, 0, [BOX])


def test_replace_image_stretch_fills_the_box(harness: Harness, tmp_path: Path) -> None:
    src = _page_with_images(tmp_path / "s.pdf")
    sid = _sid(harness, src)
    green = _png(tmp_path / "green.png", (0, 255, 0))
    harness.op(
        "content.replaceImage",
        {
            "pageIndex": 0,
            "objectId": _image_id(harness, sid),
            "path": str(green),
            "fit": "contain",
            "keepAspectBox": False,
        },
        sid,
    )
    out = _revision(harness, sid)
    assert _rgb(out, 120, 150) == (0, 255, 0)
    assert _rgb(out, 280, 150) == (0, 255, 0)


def test_replace_image_leaves_other_placements_of_a_shared_image(
    harness: Harness, tmp_path: Path
) -> None:
    src = _page_with_images(tmp_path / "sh.pdf", shared=True)
    sid = _sid(harness, src)
    blue = _png(tmp_path / "b2.png", (0, 0, 255))
    harness.op(
        "content.replaceImage",
        {
            "pageIndex": 0,
            "objectId": _image_id(harness, sid, 0),
            "path": str(blue),
            "fit": "stretch",
        },
        sid,
    )
    out = _revision(harness, sid)
    assert _rgb(out, 200, 150) == (0, 0, 255)  # the first placement changed
    assert _rgb(out, 400, 150) == RED  # the second still shows the original image


def test_replace_image_with_png_alpha_uses_an_smask(harness: Harness, tmp_path: Path) -> None:
    src = _page_with_images(tmp_path / "al.pdf")
    sid = _sid(harness, src)
    rgba = Image.new("RGBA", (10, 10), (0, 0, 255, 0))
    rgba.paste((0, 0, 255, 255), (0, 0, 5, 10))  # left half opaque
    path = tmp_path / "alpha.png"
    rgba.save(path)
    harness.op(
        "content.replaceImage",
        {"pageIndex": 0, "objectId": _image_id(harness, sid), "path": str(path), "fit": "stretch"},
        sid,
    )
    out = _revision(harness, sid)
    assert _rgb(out, 150, 150) == (0, 0, 255)
    assert _rgb(out, 280, 150) == (255, 255, 255)  # transparent part shows the page


def test_adjust_grayscale_and_invert(harness: Harness, tmp_path: Path) -> None:
    src = _page_with_images(tmp_path / "g.pdf", codec="dct")
    sid = _sid(harness, src)
    harness.op(
        "content.adjustImage",
        {"pageIndex": 0, "objectId": _image_id(harness, sid), "grayscale": True, "invert": True},
        sid,
    )
    out = _revision(harness, sid)
    r, g, b = _rgb(out, 200, 150)
    assert r == g == b  # gray
    assert abs(r - 179) <= 2  # red is 76 in gray; inverted it is 179
    assert_unchanged_outside(src, out, 0, [BOX], tolerance=2)


def test_adjust_rotate_swaps_the_pixel_size_and_keeps_the_box(
    harness: Harness, tmp_path: Path
) -> None:
    pdf = new_pdf(1)
    img = Image.new("RGB", (40, 20), (0, 0, 0))
    img.paste((255, 0, 0), (0, 0, 20, 20))  # red on the left half
    place(pdf, pdf.pages[0], [("Im1", image_xobject(pdf, img, codec="flate"), *PLACE)])
    src = save(pdf, tmp_path / "rot.pdf")
    sid = _sid(harness, src)
    res = harness.op(
        "content.adjustImage",
        {"pageIndex": 0, "objectId": _image_id(harness, sid), "rotate": 90},
        sid,
    )
    assert res["data"]["pixelSize"] == [20, 40]
    out = _revision(harness, sid)
    # rotated clockwise: the red left half is now the top half of the image, and the 20 x 40
    # image is centred (contain) in the 200 x 100 box: x 175..225, y 100..200 (pixels 592..692)
    box = ink_bbox(render(out, 0), lambda p: p[0] > 200 and p[1] < 80 and p[2] < 80)
    assert box is not None
    left, top, right, bottom = box
    assert max(abs(left - 175), abs(right - 225), abs(top - 592), abs(bottom - 642)) <= 1


def test_adjust_crop_in_pixels(harness: Harness, tmp_path: Path) -> None:
    src = _page_with_images(tmp_path / "c.pdf")
    sid = _sid(harness, src)
    res = harness.op(
        "content.adjustImage",
        {
            "pageIndex": 0,
            "objectId": _image_id(harness, sid),
            "crop": {"x": 0, "y": 0, "w": 20, "h": 10},
        },
        sid,
    )
    assert res["data"]["pixelSize"] == [20, 10]


def test_adjust_brightness_lightens_pixels(harness: Harness, tmp_path: Path) -> None:
    src = _page_with_images(tmp_path / "b.pdf", colour=(100, 100, 100))
    sid = _sid(harness, src)
    harness.op(
        "content.adjustImage",
        {"pageIndex": 0, "objectId": _image_id(harness, sid), "brightness": 50},
        sid,
    )
    out = _revision(harness, sid)
    assert abs(_rgb(out, 200, 150)[0] - 150) <= 2  # factor 1.5 on 100


def test_extract_writes_the_original_pixels(harness: Harness, tmp_path: Path) -> None:
    src = _page_with_images(tmp_path / "e.pdf")
    sid = _sid(harness, src)
    target = tmp_path / "out.png"
    harness.op(
        "content.extractImage",
        {"pageIndex": 0, "objectId": _image_id(harness, sid), "outputPath": str(target)},
        sid,
    )
    with Image.open(target) as got:
        assert got.size == (40, 40)
        assert got.convert("RGB").getpixel((5, 5)) == RED


def test_extract_jpeg_writes_the_original_bytes(harness: Harness, tmp_path: Path) -> None:
    src = _page_with_images(tmp_path / "j.pdf", codec="dct")
    sid = _sid(harness, src)
    with pikepdf.open(src) as pdf:
        original = bytes(pdf.pages[0].Resources.XObject["/Im1"].read_raw_bytes())
    target = tmp_path / "out.jpg"
    harness.op(
        "content.extractImage",
        {"pageIndex": 0, "objectId": _image_id(harness, sid), "outputPath": str(target)},
        sid,
    )
    assert target.read_bytes() == original


def test_replacing_an_image_on_a_signed_document_is_blocked(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path
) -> None:
    sid = _sid(harness, corpus["fake_signed.pdf"])
    blue = _png(tmp_path / "x.png", (0, 0, 255))
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "content.replaceImage",
            {"pageIndex": 0, "objectId": "p0:000000000000:0", "path": str(blue)},
            sid,
        )
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"


def test_undo_restores_the_original_image(harness: Harness, tmp_path: Path) -> None:
    src = _page_with_images(tmp_path / "u.pdf")
    sid = _sid(harness, src)
    blue = _png(tmp_path / "u.png", (0, 0, 255))
    harness.op(
        "content.replaceImage",
        {"pageIndex": 0, "objectId": _image_id(harness, sid), "path": str(blue), "fit": "stretch"},
        sid,
    )
    harness.call("session.undo", {"sessionId": sid})
    assert _rgb(_revision(harness, sid), 200, 150) == RED
