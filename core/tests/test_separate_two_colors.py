"""T4.12 (I22): separate a red seal that overlaps a blue signature into two transparent layers.

Covers the explicit layer list (mode "layers") and the new automatic shortcut (mode "auto-two"),
both through the op. The truth is the drawing itself: which pixels were red, which were blue, and
which were both. Each pixel must go to at most one layer.
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from chef_core.imaging import sigimg
from chef_core.ops import load_builtin_ops
from chef_core.ops.base import OpContext, get_op

RED = (200, 30, 40)
BLUE = (25, 60, 170)
PAPER = (240, 236, 226)
SIZE = (320, 200)


@pytest.fixture(autouse=True)
def _builtins() -> None:
    load_builtin_ops()


def _scene() -> tuple[Image.Image, set[tuple[int, int]], set[tuple[int, int]]]:
    """A paper-coloured image with a red ring (seal) and a blue wave (signature) crossing it.

    Returns (image, red_only, blue_only) as pixel coordinates taken from the drawing masks, so
    the overlap (where the wave crosses the ring) is in neither set.
    """
    img = Image.new("RGB", SIZE, PAPER)
    red_mask = Image.new("L", SIZE, 0)
    blue_mask = Image.new("L", SIZE, 0)
    ImageDraw.Draw(red_mask).ellipse([60, 40, 200, 160], outline=255, width=12)
    points = [(x, 100 + 45 * math.sin(x / 18)) for x in range(20, 300, 2)]
    ImageDraw.Draw(blue_mask).line(points, fill=255, width=7)
    img.paste(RED, mask=red_mask)
    img.paste(BLUE, mask=blue_mask)
    red_px: set[tuple[int, int]] = set()
    blue_px: set[tuple[int, int]] = set()
    rm, bm = red_mask.load(), blue_mask.load()
    assert rm is not None and bm is not None
    for x in range(SIZE[0]):
        for y in range(SIZE[1]):
            in_red, in_blue = rm[x, y] == 255, bm[x, y] == 255
            if in_red and not in_blue:
                red_px.add((x, y))
            if in_blue and not in_red:
                blue_px.add((x, y))
    return img, red_px, blue_px


def _alpha_at(layer: Image.Image, points: set[tuple[int, int]]) -> float:
    alpha = layer.getchannel("A")
    hits = sum(1 for p in points if alpha.getpixel(p) > 128)
    return hits / len(points)


def _layers_op(inp: Path, out: Path, params: dict[str, object]) -> list[str]:
    spec = get_op("image.separateColors")
    assert spec is not None
    ctx = OpContext(job_id="t", work_dir=out.parent, input_path=inp, result_path=None)
    result = spec.run(
        ctx,
        spec.params_model.model_validate({"inputPath": str(inp), "outputDir": str(out), **params}),
    )
    return list(result.outputs)


def test_explicit_layers_split_seal_and_signature(tmp_path: Path) -> None:
    img, red_px, blue_px = _scene()
    src = tmp_path / "scene.png"
    img.save(src)
    out_dir = tmp_path / "layers"
    out_dir.mkdir()
    outputs = _layers_op(
        src,
        out_dir,
        {
            "layers": [
                {"name": "Con dấu", "colorHex": "#C81E28", "tolerance": 60},
                {"name": "Chữ ký", "colorHex": "#193CAA", "tolerance": 60},
            ]
        },
    )
    seal = Image.open(outputs[0])
    signature = Image.open(outputs[1])
    assert seal.mode == "RGBA" and signature.mode == "RGBA"
    assert _alpha_at(seal, red_px) > 0.95
    assert _alpha_at(signature, blue_px) > 0.95
    assert _alpha_at(seal, blue_px) < 0.05
    assert _alpha_at(signature, red_px) < 0.05


def test_auto_two_finds_both_inks_without_being_told_the_colours(tmp_path: Path) -> None:
    img, red_px, blue_px = _scene()
    src = tmp_path / "scene.png"
    img.save(src)
    out_dir = tmp_path / "auto"
    out_dir.mkdir()
    outputs = _layers_op(src, out_dir, {"mode": "auto-two"})
    assert len(outputs) == 2
    first, second = (Image.open(p) for p in outputs)
    layers = {"red": None, "blue": None}
    for layer in (first, second):
        if _alpha_at(layer, red_px) > 0.9:
            layers["red"] = layer
        if _alpha_at(layer, blue_px) > 0.9:
            layers["blue"] = layer
    assert layers["red"] is not None and layers["blue"] is not None
    assert _alpha_at(layers["red"], blue_px) < 0.05
    assert _alpha_at(layers["blue"], red_px) < 0.05


def test_auto_two_names_the_layers_by_colour(tmp_path: Path) -> None:
    img, _, _ = _scene()
    src = tmp_path / "scene.png"
    img.save(src)
    out_dir = tmp_path / "named"
    out_dir.mkdir()
    outputs = _layers_op(src, out_dir, {"mode": "auto-two"})
    names = sorted(Path(p).name for p in outputs)
    assert any("Con_dấu" in n for n in names)
    assert any("Chữ_ký" in n for n in names)


def test_auto_two_on_a_single_colour_fails_cleanly(tmp_path: Path) -> None:
    img = Image.new("RGB", (80, 80), PAPER)
    ImageDraw.Draw(img).rectangle([10, 10, 60, 60], fill=RED)
    assert sigimg.auto_two_colors(img) is None


def test_auto_two_colors_returns_two_distinct_inks() -> None:
    img, _, _ = _scene()
    colours = sigimg.auto_two_colors(img)
    assert colours is not None
    first, second = colours
    assert sigimg.colour_distance(first, second) >= 90
    reds = [c for c in colours if c[0] > c[2] + 60]
    blues = [c for c in colours if c[2] > c[0] + 60]
    assert len(reds) == 1 and len(blues) == 1


def test_layers_mode_still_needs_layers_and_auto_mode_refuses_them(tmp_path: Path) -> None:
    from pydantic import ValidationError

    spec = get_op("image.separateColors")
    assert spec is not None
    with pytest.raises(ValidationError):
        spec.params_model.model_validate({"inputPath": "a.png", "outputDir": str(tmp_path)})
    with pytest.raises(ValidationError):
        spec.params_model.model_validate(
            {
                "inputPath": "a.png",
                "outputDir": str(tmp_path),
                "mode": "auto-two",
                "layers": [{"name": "x", "colorHex": "#000000"}],
            }
        )
