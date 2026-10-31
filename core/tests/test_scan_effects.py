"""Scanner effects for page images (K4): identity, geometry, determinism and each effect."""

from __future__ import annotations

import time

import pytest
from PIL import Image, ImageStat
from pydantic import ValidationError

from chef_core.imaging.effects import (
    EFFECT_PRESETS,
    ScanEffects,
    apply_scan_effects,
    get_preset,
    skew,
)


def _sample_rgb(width: int, height: int) -> Image.Image:
    """Deterministic colourful test content built from Pillow gradients only."""
    ramp = Image.linear_gradient("L").resize((width, height))
    vertical = Image.linear_gradient("L").transpose(Image.Transpose.ROTATE_90)
    rad = Image.radial_gradient("L").resize((width, height))
    return Image.merge("RGB", (ramp, vertical.resize((width, height)), rad))


def _all_effects(**overrides: object) -> ScanEffects:
    base: dict[str, object] = {
        "rotation_degrees": 2.0,
        "noise": 0.3,
        "paper_tint": 0.5,
        "edge_shadow": 0.5,
        "blur": 1.0,
        "contrast": 1.2,
        "brightness": 1.1,
    }
    base.update(overrides)
    return ScanEffects.model_validate(base)


def _mean_rgb(img: Image.Image) -> tuple[float, ...]:
    return tuple(ImageStat.Stat(img).mean)


# --- identity and shape ---------------------------------------------------------------


@pytest.mark.parametrize("mode", ["RGB", "L", "1"])
def test_neutral_params_are_pixel_identical(mode: str) -> None:
    src = _sample_rgb(120, 160).convert(mode)
    out = apply_scan_effects(src, ScanEffects(), page_index=3, base_seed=7)
    assert out.size == src.size
    assert out.mode == src.mode
    assert out.tobytes() == src.tobytes()


def test_neutral_jitter_stays_identity() -> None:
    src = _sample_rgb(64, 80)
    out = apply_scan_effects(src, ScanEffects(jitter=True), page_index=1, base_seed=1)
    assert out.tobytes() == src.tobytes()


@pytest.mark.parametrize("mode", ["RGB", "L", "1"])
def test_size_and_mode_preserved(mode: str) -> None:
    src = _sample_rgb(150, 210).convert(mode)
    out = apply_scan_effects(src, _all_effects(), page_index=0, base_seed=42)
    assert out.size == src.size
    assert out.mode == src.mode


def test_bilevel_skips_non_geometric_effects() -> None:
    src = _sample_rgb(100, 100).convert("1")
    fx = _all_effects(rotation_degrees=0.0)
    out = apply_scan_effects(src, fx, page_index=0, base_seed=5)
    assert out.mode == "1"
    assert out.tobytes() == src.tobytes()


def test_input_is_not_mutated() -> None:
    src = _sample_rgb(120, 120)
    before = src.tobytes()
    apply_scan_effects(src, _all_effects(), page_index=2, base_seed=9)
    assert src.tobytes() == before


# --- determinism -----------------------------------------------------------------------


def test_same_seed_and_page_is_deterministic() -> None:
    src = _sample_rgb(120, 160)
    fx = _all_effects(jitter=True)
    a = apply_scan_effects(src, fx, page_index=4, base_seed=11)
    b = apply_scan_effects(src, fx, page_index=4, base_seed=11)
    assert a.tobytes() == b.tobytes()


def test_different_pages_differ_with_jitter() -> None:
    src = _sample_rgb(120, 160)
    fx = _all_effects(jitter=True)
    a = apply_scan_effects(src, fx, page_index=0, base_seed=11)
    b = apply_scan_effects(src, fx, page_index=1, base_seed=11)
    assert a.tobytes() != b.tobytes()


def test_different_base_seeds_differ() -> None:
    src = Image.new("L", (120, 160), 128)
    fx = ScanEffects(noise=0.5)
    a = apply_scan_effects(src, fx, page_index=0, base_seed=1)
    b = apply_scan_effects(src, fx, page_index=0, base_seed=2)
    assert a.tobytes() != b.tobytes()


def test_fx_seed_changes_result() -> None:
    src = Image.new("L", (120, 160), 128)
    a = apply_scan_effects(src, ScanEffects(noise=0.5, seed=1), page_index=0, base_seed=0)
    b = apply_scan_effects(src, ScanEffects(noise=0.5, seed=2), page_index=0, base_seed=0)
    assert a.tobytes() != b.tobytes()


# --- individual effects ----------------------------------------------------------------


def test_edge_shadow_darkens_borders_more_than_centre() -> None:
    src = Image.new("RGB", (300, 300), (255, 255, 255))
    out = apply_scan_effects(src, ScanEffects(edge_shadow=0.8), page_index=0, base_seed=0)
    centre = out.getpixel((150, 150))
    left_edge = out.getpixel((0, 150))
    top_edge = out.getpixel((150, 0))
    assert centre == (255, 255, 255)
    assert left_edge[0] < 160
    assert top_edge[0] < 160
    assert _mean_rgb(out)[0] < 255


def test_paper_tint_shifts_mean_colour_toward_tint() -> None:
    src = Image.new("RGB", (100, 100), (255, 255, 255))
    out = apply_scan_effects(
        src, ScanEffects(paper_tint=1.0, tint_color="#f4efe1"), page_index=0, base_seed=0
    )
    r, _, b = _mean_rgb(out)
    assert out.getpixel((50, 50)) == (0xF4, 0xEF, 0xE1)
    assert r - b > 15


def test_paper_tint_on_grayscale_darkens_paper() -> None:
    src = Image.new("L", (100, 100), 255)
    out = apply_scan_effects(
        src, ScanEffects(paper_tint=1.0, tint_color="#808080"), page_index=0, base_seed=0
    )
    assert abs(out.getpixel((50, 50)) - 128) <= 1  # type: ignore[operator]


def test_noise_raises_std_dev_on_flat_image() -> None:
    src = Image.new("RGB", (200, 200), (128, 128, 128))
    out = apply_scan_effects(src, ScanEffects(noise=0.5), page_index=0, base_seed=0)
    stddev = ImageStat.Stat(out).stddev
    assert min(stddev) > 5
    assert all(abs(m - 128) < 3 for m in ImageStat.Stat(out).mean)


def test_skew_rotates_corner_content() -> None:
    src = Image.new("RGB", (400, 400), (0, 0, 0))
    out = skew(src, 5.0)
    assert out.size == src.size
    assert out.getpixel((0, 0)) == (255, 255, 255)  # corner now falls outside the page


def test_rotation_moves_content_through_apply() -> None:
    src = Image.new("RGB", (400, 400), (0, 0, 0))
    out = apply_scan_effects(src, ScanEffects(rotation_degrees=5.0), page_index=0, base_seed=3)
    assert out.size == src.size
    assert out.tobytes() != src.tobytes()


def test_blur_softens_hard_edge() -> None:
    src = Image.new("L", (100, 100), 0)
    src.paste(255, (50, 0, 100, 100))
    out = apply_scan_effects(src, ScanEffects(blur=2.0), page_index=0, base_seed=0)
    assert 0 < out.getpixel((49, 50)) < 255  # type: ignore[operator]
    assert out.getpixel((10, 50)) == 0  # type: ignore[operator]


def test_brightness_and_contrast_change_levels() -> None:
    src = _sample_rgb(80, 80)
    brighter = apply_scan_effects(src, ScanEffects(brightness=1.3), page_index=0, base_seed=0)
    assert sum(_mean_rgb(brighter)) > sum(_mean_rgb(src))
    flatter = apply_scan_effects(src, ScanEffects(contrast=0.5), page_index=0, base_seed=0)
    assert sum(ImageStat.Stat(flatter).stddev) < sum(ImageStat.Stat(src).stddev)


# --- validation ------------------------------------------------------------------------


@pytest.mark.parametrize(
    "field,value",
    [
        ("rotation_degrees", -0.1),
        ("rotation_degrees", 5.5),
        ("noise", 1.5),
        ("paper_tint", -1.0),
        ("edge_shadow", 2.0),
        ("blur", 3.5),
        ("contrast", 0.4),
        ("contrast", 1.6),
        ("brightness", 0.49),
        ("brightness", 1.51),
        ("tint_color", "red"),
        ("tint_color", "#fff"),
    ],
)
def test_out_of_range_values_are_rejected(field: str, value: object) -> None:
    with pytest.raises(ValidationError):
        ScanEffects.model_validate({field: value})


def test_camel_case_aliases_and_unknown_fields() -> None:
    fx = ScanEffects.model_validate({"rotationDegrees": 1.5, "edgeShadow": 0.3})
    assert fx.rotation_degrees == 1.5
    assert fx.edge_shadow == 0.3
    with pytest.raises(ValidationError):
        ScanEffects.model_validate({"unknownField": 1})


# --- presets ---------------------------------------------------------------------------


def test_presets_cover_the_four_names() -> None:
    assert set(EFFECT_PRESETS) == {"none", "light", "photocopy", "old-paper"}
    assert get_preset("none") == ScanEffects()
    for name in ("light", "photocopy", "old-paper"):
        assert get_preset(name) != ScanEffects()


def test_unknown_preset_raises_value_error() -> None:
    with pytest.raises(ValueError):
        get_preset("does-not-exist")


# --- performance -----------------------------------------------------------------------


def test_a4_200dpi_page_is_fast() -> None:
    src = _sample_rgb(1654, 2339)
    fx = _all_effects(jitter=True)
    start = time.perf_counter()
    out = apply_scan_effects(src, fx, page_index=0, base_seed=1)
    elapsed = time.perf_counter() - start
    assert out.size == src.size
    assert elapsed < 3.0, f"scan effects took {elapsed:.2f}s"
