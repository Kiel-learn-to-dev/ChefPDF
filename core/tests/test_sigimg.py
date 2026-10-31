"""Signature and stamp image processing (T3.11, features I19-I22).

All images are synthetic and built inside the test. Expectations are checked against the known
drawing geometry, not against exact pixel values, so small resampling differences do not matter.
"""

from __future__ import annotations

import io
import math
import random
import time
from collections.abc import Callable
from pathlib import Path

import pytest
from conftest import Harness, RpcFailure
from PIL import Image, ImageChops, ImageDraw, ImageFilter

from chef_core.imaging import sigimg
from chef_core.ops import load_builtin_ops

RED = (200, 30, 40)
INK_BLUE = (25, 60, 170)
PAPER = (238, 234, 222)


@pytest.fixture(autouse=True)
def _builtins() -> None:
    load_builtin_ops()


# -- synthetic images --------------------------------------------------------------------


def _uniform_noise(size: tuple[int, int], amplitude: int, seed: int) -> Image.Image:
    """Deterministic zero-centred noise in 'L' mode (128 = no change), |offset| <= amplitude."""
    rng = random.Random(seed)
    raw = Image.frombytes("L", size, rng.randbytes(size[0] * size[1]))
    return raw.point(lambda v: 128 + round((v - 128) / 128 * amplitude))


def _add_noise(img: Image.Image, amplitude: int, seed: int) -> Image.Image:
    if amplitude == 0:
        return img
    noise = _uniform_noise(img.size, amplitude, seed)
    channels = [ImageChops.add(c, noise, 1.0, -128) for c in img.split()]
    return Image.merge("RGB", channels)


def seal_image(size: tuple[int, int] = (300, 300), noise: int = 6, seed: int = 1) -> Image.Image:
    """A red round seal on white: thick ring plus text-like bars, with speckle noise."""
    img = Image.new("RGB", size, (255, 255, 255))
    draw = ImageDraw.Draw(img)
    cx, cy, r = size[0] / 2, size[1] / 2, min(size) * 0.4
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=RED, width=14)
    for k in range(12):
        x = cx - r * 0.5 + (k % 3) * r * 0.36
        y = cy - r * 0.3 + (k // 3) * r * 0.2
        draw.rectangle([x, y, x + 16, y + 8], fill=RED)
    return _add_noise(img, noise, seed)


def _sine_points(size: tuple[int, int]) -> list[tuple[float, float]]:
    w, h = size
    return [(x, h / 2 + 40 * math.sin(x / 30)) for x in range(20, w - 20, 2)]


def blue_signature(
    size: tuple[int, int] = (400, 200), noise: int = 3, seed: int = 2
) -> tuple[Image.Image, Image.Image]:
    """Blue scribble on off-white with a left-to-right lighting gradient.

    Returns (photo, truth) where truth is the 'L' stroke mask before lighting.
    """
    w, h = size
    truth = Image.new("L", size, 0)
    ImageDraw.Draw(truth).line(_sine_points(size), fill=255, width=7)
    ink = Image.new("RGB", size, INK_BLUE)
    base = Image.new("RGB", size, PAPER)
    base.paste(ink, mask=truth)
    light = Image.new("L", size)
    for x in range(w):
        value = round(255 * (0.59 + 0.41 * x / (w - 1)))
        ImageDraw.Draw(light).line([(x, 0), (x, h)], fill=value)
    photo = Image.merge("RGB", [ImageChops.multiply(c, light) for c in base.split()])
    return _add_noise(photo, noise, seed), truth


def rotated_bar(size: tuple[int, int], angle_deg: float) -> Image.Image:
    """Opaque blue bar 300 px long, 10 px thick, turned counter-clockwise by ``angle_deg``."""
    w, h = size
    img = Image.new("RGBA", size, (0, 0, 0, 0))
    cx, cy = w / 2, h / 2
    a = math.radians(angle_deg)
    dx, dy = math.cos(a) * 150, -math.sin(a) * 150  # image y grows downward
    ImageDraw.Draw(img).line(
        [(cx - dx, cy - dy), (cx + dx, cy + dy)], fill=(*INK_BLUE, 255), width=10
    )
    return img


def _write_png(img: Image.Image, path: Path) -> Path:
    img.save(path, format="PNG")
    return path


def _alpha_values(img: Image.Image) -> set[int]:
    return set(img.getchannel("A").tobytes())


def _alpha_list(img: Image.Image) -> list[int]:
    """Alpha values of an RGBA image, or the values of an 'L' mask."""
    return list(img.tobytes() if img.mode == "L" else img.getchannel("A").tobytes())


def _pixels(img: Image.Image) -> list[tuple[int, ...]]:
    return list(zip(*(band.tobytes() for band in img.split()), strict=True))


def _count_alpha(img: Image.Image, predicate: Callable[[int], bool]) -> int:
    hist = img.getchannel("A").histogram()
    return sum(count for value, count in enumerate(hist) if predicate(value))


def _full_paper_rgba(photo: Image.Image, sensitivity: int = 50) -> Image.Image:
    """The uncropped result of paper-white removal, so pixel coordinates match the input."""
    rgb = sigimg.flatten_on_white(photo)
    return Image.merge("RGBA", (*rgb.split(), sigimg.paper_alpha(rgb, sensitivity)))


# -- background removal (I20) ------------------------------------------------------------


def test_ink_color_keeps_red_seal_and_drops_paper() -> None:
    img = seal_image()
    result = sigimg.remove_background(
        img, mode="ink-color", ink_color=RED, tolerance=70, feather=0, padding=0
    )
    assert result.image.mode == "RGBA"
    alpha = result.image.getchannel("A")
    # The seal is detected, the paper is transparent.
    assert result.ink_pixels > 2000
    assert _count_alpha(result.image, lambda v: v == 0) > 0
    # Every opaque pixel is red within the tolerance (speckle is +-6).
    px = _pixels(result.image)
    opaque = [p for p in px if p[3] == 255]
    assert opaque, "no opaque pixels"
    worst = max(max(abs(p[0] - RED[0]), abs(p[1] - RED[1]), abs(p[2] - RED[2])) for p in opaque)
    assert worst <= 70
    assert alpha.getpixel((0, 0)) == 0
    assert alpha.getpixel((150, 150)) in (0, 255)  # centre: inside the ring, paper


def test_ink_color_ring_pixels_are_opaque_and_keep_colour() -> None:
    img = seal_image(noise=0)
    # Uncropped result, so that the pixel coordinates match the input image.
    full = Image.merge("RGBA", (*img.split(), sigimg.ink_color_alpha(img, RED, 60)))
    # Ring drawn inside the bbox of radius 120 with width 14: its centre line is at radius 113
    cx = cy = 150
    for angle in range(0, 360, 15):
        x = round(cx + 113 * math.cos(math.radians(angle)))
        y = round(cy + 113 * math.sin(math.radians(angle)))
        pixel = full.getpixel((x, y))
        assert pixel[3] == 255
        assert all(abs(pixel[i] - RED[i]) <= 4 for i in range(3))


def test_paper_white_detects_blue_ink_under_uneven_light() -> None:
    photo, truth = blue_signature()
    out = _full_paper_rgba(photo)
    alpha = out.getchannel("A")
    inner = truth.filter(ImageFilter.MinFilter(3))
    outer = truth.filter(ImageFilter.MaxFilter(13))
    ink_hits = total_ink = bg_hits = total_bg = 0
    for y in range(out.height):
        for x in range(out.width):
            if inner.getpixel((x, y)) and x >= 0:
                total_ink += 1
                ink_hits += alpha.getpixel((x, y)) >= 250
            elif outer.getpixel((x, y)) == 0:
                total_bg += 1
                bg_hits += alpha.getpixel((x, y)) > 5
    assert total_ink > 300
    assert ink_hits / total_ink > 0.95
    assert bg_hits / total_bg < 0.01


def test_ink_pixels_keep_their_colour_in_paper_mode() -> None:
    photo, truth = blue_signature(noise=0)
    out = _full_paper_rgba(photo)
    inner = truth.filter(ImageFilter.MinFilter(3))
    mismatches = 0
    checked = 0
    for x in range(40, 360, 3):
        for y in range(0, out.height):
            if inner.getpixel((x, y)):
                factor = 0.59 + 0.41 * x / (photo.width - 1)
                expected = [INK_BLUE[i] * factor for i in range(3)]
                got = out.getpixel((x, y))
                checked += 1
                if any(abs(got[i] - expected[i]) > 25 for i in range(3)):
                    mismatches += 1
    assert checked > 100
    assert mismatches / checked < 0.05


def test_auto_ink_colour_finds_dominant_hue() -> None:
    photo, _ = blue_signature(noise=2)
    colour = sigimg.auto_ink_color(sigimg.flatten_on_white(photo))
    assert colour is not None
    r, g, b = colour
    assert b > r + 60 and b > g + 60  # blue family, lighting-adjusted


def test_auto_ink_colour_on_blank_paper_is_none() -> None:
    assert sigimg.auto_ink_color(Image.new("RGB", (120, 80), (250, 250, 248))) is None


def test_auto_mode_uses_paper_white_for_red_seal() -> None:
    result = sigimg.remove_background(seal_image(), mode="auto", padding=0)
    assert result.mode == "paper-white"
    assert result.ink_pixels > 2000


def test_auto_mode_falls_back_to_ink_colour_on_blank_page() -> None:
    blank = Image.new("RGB", (80, 60), (255, 255, 255))
    result = sigimg.remove_background(blank, mode="auto", padding=0)
    assert result.mode == "ink-color"
    assert result.ink_pixels == 0
    assert any("ink" in w.lower() for w in result.warnings)


def test_crop_to_content_bbox_with_padding() -> None:
    img = seal_image(noise=0)
    result = sigimg.remove_background(
        img, mode="ink-color", ink_color=RED, tolerance=60, feather=0, padding=5
    )
    bbox = result.image.getchannel("A").getbbox()
    assert bbox is not None
    left, top, right, bottom = bbox
    assert (left, top) == (5, 5)
    # The ring spans 240 px in both directions (outline drawn inside a 240 px box).
    content_w = right - left
    content_h = bottom - top
    assert 232 <= content_w <= 248
    assert 232 <= content_h <= 248
    assert result.image.size == (content_w + 10, content_h + 10)
    # Padding rows and columns are fully transparent.
    alpha = result.image.getchannel("A")
    assert alpha.crop((0, 0, result.image.width, 5)).getextrema() == (0, 0)
    assert alpha.crop((0, 0, 5, result.image.height)).getextrema() == (0, 0)


def test_feather_produces_intermediate_alpha() -> None:
    img = seal_image(noise=0)
    hard = sigimg.remove_background(
        img, mode="ink-color", ink_color=RED, tolerance=60, feather=0, padding=0
    ).image
    soft = sigimg.remove_background(
        img, mode="ink-color", ink_color=RED, tolerance=60, feather=2, padding=0
    ).image
    assert _alpha_values(hard) <= {0, 255}
    assert any(0 < v < 255 for v in _alpha_values(soft))


def test_output_colour_recolours_ink_only() -> None:
    result = sigimg.remove_background(
        seal_image(noise=0),
        mode="ink-color",
        ink_color=RED,
        tolerance=60,
        feather=0,
        padding=0,
        output_color=(10, 20, 150),
    )
    opaque = [p for p in _pixels(result.image) if p[3] == 255]
    assert opaque
    assert all(p[:3] == (10, 20, 150) for p in opaque)


def test_ink_colour_none_means_auto() -> None:
    result = sigimg.remove_background(
        seal_image(), mode="ink-color", ink_color=None, tolerance=70, padding=0
    )
    assert result.ink_color is not None
    assert result.ink_pixels > 2000


# -- cleanup (I21) ------------------------------------------------------------------------


def _solid_blob_image() -> Image.Image:
    """Transparent 120x90 canvas with one 40x20 blob and three 2x2 specks."""
    img = Image.new("RGBA", (120, 90), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rectangle([10, 10, 49, 29], fill=(*INK_BLUE, 255))
    for x, y in ((80, 20), (90, 60), (100, 75)):
        draw.rectangle([x, y, x + 1, y + 1], fill=(*INK_BLUE, 255))
    return img


def test_despeckle_removes_small_blobs_only() -> None:
    img = _solid_blob_image()
    cleaned, removed = sigimg.despeckle(img.getchannel("A"), min_blob_px=10)
    assert removed == 3
    assert cleaned.getpixel((30, 20)) == 255  # the big blob survives
    assert cleaned.getpixel((80, 20)) == 0
    assert cleaned.getpixel((90, 60)) == 0


def test_straighten_reduces_measured_angle() -> None:
    tilted = rotated_bar((400, 300), 10.0)
    measured = sigimg.principal_angle(tilted.getchannel("A"))
    assert measured is not None
    assert measured == pytest.approx(10.0, abs=1.5)
    straightened, applied, _ = sigimg.deskew(tilted, max_tilt=15.0)
    assert applied == pytest.approx(10.0, abs=1.5)
    after = sigimg.principal_angle(straightened.getchannel("A"))
    assert after is not None
    assert abs(after) < 1.5


def test_straighten_refuses_angles_beyond_limit() -> None:
    tilted = rotated_bar((400, 300), 30.0)
    _, applied, measured = sigimg.deskew(tilted, max_tilt=15.0)
    assert applied == 0.0
    assert measured is not None and abs(measured - 30.0) < 2.0


def test_straighten_skips_round_shapes() -> None:
    _, applied, measured = sigimg.deskew(seal_image(noise=0), max_tilt=15.0)
    assert applied == 0.0
    assert measured is None  # a ring has no principal direction


def test_thicken_and_thin_change_ink_area() -> None:
    img = _solid_blob_image()
    base = _count_alpha(img, lambda v: v == 255)
    thick = sigimg.grow_alpha(img.getchannel("A"), 2)
    thin = sigimg.shrink_alpha(img.getchannel("A"), 2)
    grown = sum(1 for v in _alpha_list(thick) if v == 255)
    shrunk = sum(1 for v in _alpha_list(thin) if v == 255)
    assert grown > base > shrunk


def test_tone_resize_and_flip() -> None:
    img = Image.new("RGBA", (200, 100), (100, 100, 100, 255))
    brighter = sigimg.adjust_tone(img, contrast=1.0, brightness=50)
    assert brighter.getpixel((0, 0))[0] == 150
    assert brighter.getpixel((0, 0))[3] == 255
    fitted = sigimg.fit_max(img, max_width=50, max_height=50)
    assert fitted.size == (50, 25)
    marked = Image.new("RGBA", (4, 2), (0, 0, 0, 0))
    marked.putpixel((0, 0), (255, 0, 0, 255))
    assert sigimg.mirror(marked).getpixel((3, 0)) == (255, 0, 0, 255)


# -- colour separation (I22) --------------------------------------------------------------


def _seal_and_signature() -> Image.Image:
    """Red seal on white with a blue signature drawn across it."""
    img = seal_image(size=(360, 300), noise=2, seed=5)
    draw = ImageDraw.Draw(img)
    draw.line(_sine_points((360, 300)), fill=INK_BLUE, width=6)
    return img


def test_separate_colors_writes_one_layer_per_colour(tmp_path: Path) -> None:
    img = _seal_and_signature()
    layers = [
        sigimg.ColorLayer(name="seal", rgb=RED, tolerance=70),
        sigimg.ColorLayer(name="signature", rgb=INK_BLUE, tolerance=70),
    ]
    results = sigimg.separate_layers(img, layers)
    assert [r.name for r in results] == ["seal", "signature"]
    seal, signature = results
    assert seal.pixels > 1500
    assert signature.pixels > 1000
    assert seal.image.mode == "RGBA"
    assert seal.image.getchannel("A").getextrema() == (0, 255)


def test_separated_layers_do_not_overlap_beyond_tolerance() -> None:
    img = _seal_and_signature()
    layers = [
        sigimg.ColorLayer(name="seal", rgb=RED, tolerance=70),
        sigimg.ColorLayer(name="signature", rgb=INK_BLUE, tolerance=70),
    ]
    seal, signature = sigimg.separate_layers(img, layers)
    a = seal.image.getchannel("A")
    b = signature.image.getchannel("A")
    both = ImageChops.multiply(a, b)
    assert sum(1 for v in _alpha_list(both) if v > 0) == 0


def test_separate_colors_nearest_colour_wins_in_overlap() -> None:
    # A pixel that is close to both colours goes to the nearer one only.
    img = Image.new("RGB", (4, 1), (0, 0, 0))
    img.putpixel((0, 0), (100, 0, 0))  # nearer to 'dark red' (90,0,0)
    img.putpixel((1, 0), (0, 0, 100))  # nearer to 'dark blue'
    img.putpixel((2, 0), (200, 200, 200))  # matches nothing
    img.putpixel((3, 0), (60, 0, 0))  # within both tolerances, nearer to 'red-ish' (50,0,0)
    layers = [
        sigimg.ColorLayer(name="red", rgb=(90, 0, 0), tolerance=40),
        sigimg.ColorLayer(name="red2", rgb=(50, 0, 0), tolerance=40),
        sigimg.ColorLayer(name="blue", rgb=(0, 0, 90), tolerance=40),
    ]
    results = {r.name: r for r in sigimg.separate_layers(img, layers)}
    assert results["red"].image.getchannel("A").getpixel((0, 0)) == 255
    assert results["red2"].image.getchannel("A").getpixel((0, 0)) == 0
    assert results["blue"].image.getchannel("A").getpixel((1, 0)) == 255
    assert results["red"].image.getchannel("A").getpixel((2, 0)) == 0
    assert results["red2"].image.getchannel("A").getpixel((3, 0)) == 255
    assert results["red"].image.getchannel("A").getpixel((3, 0)) == 0


# -- text signature (I19, I23 handwriting font slot) --------------------------------------


def test_text_signature_renders_vietnamese_diacritics() -> None:
    font = sigimg.bundled_font_path("BeVietnamPro")
    plain = sigimg.render_text("Nguyễn Văn A", font, size_px=80, color=INK_BLUE, slant_deg=0)
    marked = sigimg.render_text("Ậ", font, size_px=80, color=INK_BLUE, slant_deg=0)
    base = sigimg.render_text("A", font, size_px=80, color=INK_BLUE, slant_deg=0)
    assert plain.mode == "RGBA"
    assert plain.getchannel("A").getbbox() is not None
    width, height = plain.size
    assert 2.0 < width / height < 9.0
    # The marked glyph is taller than the plain one: diacritics are drawn, not dropped.
    assert marked.height > base.height * 1.2


def test_text_signature_name_with_full_vietnamese_sentence() -> None:
    font = sigimg.bundled_font_path("BeVietnamPro")
    img = sigimg.render_text("Nguyễn Văn Ạ", font, size_px=72, color=INK_BLUE, slant_deg=0)
    assert img.getchannel("A").getbbox() is not None


def test_text_signature_slant_widens_image() -> None:
    font = sigimg.bundled_font_path("BeVietnamPro")
    upright = sigimg.render_text("Hoàng", font, size_px=72, color=INK_BLUE, slant_deg=0)
    slanted = sigimg.render_text("Hoàng", font, size_px=72, color=INK_BLUE, slant_deg=20)
    assert slanted.width > upright.width


def test_text_signature_rejects_unknown_font(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        sigimg.render_text("A", tmp_path / "missing.ttf", size_px=40, color=INK_BLUE, slant_deg=0)


# -- strokes (I19 pressure-sensitive ink) ------------------------------------------------


def _line_stroke(y: float, pressure: float) -> list[tuple[float, float, float]]:
    return [(20 + i * 10.0, y + 8 * math.sin(i / 3), pressure) for i in range(30)]


def test_strokes_pressure_changes_width() -> None:
    thin = sigimg.render_strokes(
        [_line_stroke(60, 0.1)], 400, 200, INK_BLUE, min_width=1.0, max_width=10.0, padding=4
    )
    heavy = sigimg.render_strokes(
        [_line_stroke(60, 1.0)], 400, 200, INK_BLUE, min_width=1.0, max_width=10.0, padding=4
    )
    thin_ink = sum(1 for v in _alpha_list(thin) if v > 127)
    heavy_ink = sum(1 for v in _alpha_list(heavy) if v > 127)
    assert thin_ink > 0
    assert heavy_ink > thin_ink * 3


def test_strokes_are_cropped_and_deterministic() -> None:
    strokes = [_line_stroke(100, 0.8), [(200.0, 40.0, 0.5), (210.0, 60.0, 0.9)]]
    first = sigimg.render_strokes(strokes, 400, 200, INK_BLUE, min_width=1, max_width=6, padding=6)
    second = sigimg.render_strokes(strokes, 400, 200, INK_BLUE, min_width=1, max_width=6, padding=6)
    assert first.tobytes() == second.tobytes()
    bbox = first.getchannel("A").getbbox()
    assert bbox is not None
    assert bbox[0] == 6 and bbox[1] == 6
    assert bbox[2] == first.width - 6 and bbox[3] == first.height - 6
    assert first.mode == "RGBA"


def test_strokes_empty_input_is_rejected() -> None:
    with pytest.raises(ValueError):
        sigimg.render_strokes([], 100, 100, INK_BLUE, min_width=1, max_width=4, padding=2)


# -- ops ----------------------------------------------------------------------------------


def test_remove_background_op_writes_rgba_png(harness: Harness, tmp_path: Path) -> None:
    src = _write_png(seal_image(), tmp_path / "seal.png")
    out = tmp_path / "seal-clean.png"
    result = harness.op(
        "image.removeBackground",
        {
            "inputPath": str(src),
            "outputPath": str(out),
            "mode": "ink-color",
            "inkColor": "#C81E28",
            "tolerance": 70,
        },
    )
    assert result["outputs"] == [str(out)]
    assert result["data"]["inkPixels"] > 2000
    with Image.open(out) as png:
        assert png.format == "PNG" and png.mode == "RGBA"


def test_remove_background_op_validates_params(harness: Harness, tmp_path: Path) -> None:
    src = _write_png(seal_image(), tmp_path / "seal.png")
    with pytest.raises(RpcFailure) as exc:
        harness.call(
            "ops.run",
            {
                "opId": "image.removeBackground",
                "params": {
                    "inputPath": str(src),
                    "outputPath": str(tmp_path / "x.png"),
                    "mode": "ink-color",
                    "tolerance": 999,
                },
            },
        )
    assert exc.value.kind == "INVALID_PARAMS"


def test_missing_input_is_a_file_error(harness: Harness, tmp_path: Path) -> None:
    job = harness.start_op(
        "image.cleanup",
        {"inputPath": str(tmp_path / "nope.png"), "outputPath": str(tmp_path / "o.png")},
    )
    msg = harness.wait_job(job)
    assert msg["method"] == "job.failed"
    assert msg["params"]["error"]["data"]["kind"] == "FILE_NOT_FOUND"


def test_separate_colors_op_writes_layers(harness: Harness, tmp_path: Path) -> None:
    src = _write_png(_seal_and_signature(), tmp_path / "both.png")
    out_dir = tmp_path / "layers"
    out_dir.mkdir()
    result = harness.op(
        "image.separateColors",
        {
            "inputPath": str(src),
            "outputDir": str(out_dir),
            "layers": [
                {"name": "Con dau", "colorHex": "#C81E28", "tolerance": 70},
                {"name": "Chu ky", "colorHex": "#193CAA", "tolerance": 70},
            ],
        },
    )
    layers = result["data"]["layers"]
    assert [layer["name"] for layer in layers] == ["Con dau", "Chu ky"]
    assert all(layer["pixels"] > 0 for layer in layers)
    for layer in layers:
        assert Path(layer["path"]).is_file()
        assert Path(layer["path"]).parent == out_dir


def test_text_signature_op_renders_font_bundle(harness: Harness, tmp_path: Path) -> None:
    out = tmp_path / "name.png"
    result = harness.op(
        "image.textSignature",
        {
            "text": "Nguyễn Văn Ạ",
            "fontName": "BeVietnamPro",
            "sizePx": 96,
            "colorHex": "#193CAA",
            "slantDeg": 10,
            "outputPath": str(out),
        },
    )
    assert result["outputs"] == [str(out)]
    with Image.open(out) as png:
        assert png.mode == "RGBA"
        assert png.getchannel("A").getbbox() is not None


def test_strokes_op_writes_png(harness: Harness, tmp_path: Path) -> None:
    out = tmp_path / "stroke.png"
    result = harness.op(
        "image.fromStrokes",
        {
            "strokes": [
                {
                    "points": [
                        {"x": 10, "y": 20, "pressure": 0.2},
                        {"x": 80, "y": 60, "pressure": 0.9},
                        {"x": 140, "y": 30, "pressure": 0.5},
                    ]
                }
            ],
            "canvasWidth": 200,
            "canvasHeight": 100,
            "colorHex": "#193CAA",
            "minWidth": 1,
            "maxWidth": 6,
            "padding": 4,
            "outputPath": str(out),
        },
    )
    assert result["outputs"] == [str(out)]
    with Image.open(out) as png:
        assert png.mode == "RGBA"


def test_processed_png_renders_in_a_signature_appearance(tmp_path: Path) -> None:
    """The output is what SignatureTemplate.image takes: a PNG with alpha, rendered into the box."""
    from datetime import UTC, datetime

    from chef_core.signing.appearance import (
        ImageSlot,
        SignatureData,
        SignatureTemplate,
        render_signature_appearance,
    )

    out = tmp_path / "sig.png"
    sigimg.remove_background(blue_signature()[0], mode="paper-white", padding=3).image.save(
        out, format="PNG"
    )
    with Image.open(io.BytesIO(out.read_bytes())) as png:
        assert png.mode == "RGBA"
    template = SignatureTemplate(layout="image-left", image=ImageSlot(path=str(out)))
    data = SignatureData(
        signer_name="Nguyễn Văn A",
        organization=None,
        tax_code=None,
        citizen_id=None,
        reason=None,
        location=None,
        contact=None,
        signed_at=datetime(2026, 10, 31, 9, 0, tzinfo=UTC),
    )
    rendered = render_signature_appearance(template, data, 240, 80, image=out.read_bytes())
    assert rendered.pdf.startswith(b"%PDF")


# -- performance ---------------------------------------------------------------------------


def _big_photo() -> Image.Image:
    size = (3000, 2000)
    photo, _ = blue_signature(size=size, noise=4, seed=9)
    return photo


@pytest.mark.parametrize("mode", ["paper-white", "auto"])
def test_remove_background_3000x2000_is_fast(mode: str) -> None:
    photo = _big_photo()
    started = time.perf_counter()
    sigimg.remove_background(photo, mode=mode, padding=4)
    assert time.perf_counter() - started < 3.0


def test_cleanup_and_separation_3000x2000_are_fast() -> None:
    big = _big_photo()
    rgba = sigimg.remove_background(big, mode="paper-white", padding=0).image
    started = time.perf_counter()
    sigimg.cleanup(rgba, thicken=1, contrast=1.1, brightness=5, straighten=False)
    assert time.perf_counter() - started < 3.0
    started = time.perf_counter()
    layers = [sigimg.ColorLayer(name="a", rgb=INK_BLUE, tolerance=70)]
    sigimg.separate_layers(big, layers)
    assert time.perf_counter() - started < 3.0


def test_strokes_on_a_huge_canvas_use_only_the_ink_area() -> None:
    img = sigimg.render_strokes(
        [_line_stroke(5000, 0.7)], 10000, 10000, INK_BLUE, min_width=1, max_width=6, padding=2
    )
    assert img.width < 400 and img.height < 200


def test_straighten_3000x2000_is_fast() -> None:
    tilted = rotated_bar((3000, 2000), 8.0)
    started = time.perf_counter()
    result = sigimg.cleanup(tilted, straighten=True, despeckle_px=20, thicken=1)
    assert time.perf_counter() - started < 3.0
    assert result.applied_deg == pytest.approx(8.0, abs=1.5)
