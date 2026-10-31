"""Scan effects (K4), preview and estimate (K5, K6), presets (K8) and size fit (K10)."""

from __future__ import annotations

import hashlib
import io
import random
from pathlib import Path
from typing import Any, get_args

import img2pdf
import pikepdf
import pytest
from conftest import Harness, RpcFailure
from PIL import Image
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from chef_core.imaging.effects import EFFECT_PRESETS
from chef_core.ops import load_builtin_ops, scan, scan_fit, scan_presets, scan_preview
from chef_core.ops.scan import EffectPresetName, RasterizeParams
from chef_core.pdf.rasterize import encode_image_page, rasterize_page

RASTER = "scan.rasterize"
PREVIEW = "scan.preview"
FIT = "scan.fitSize"
PRESET_NAMES = {"email-light", "archive", "fax-bw", "photocopy", "old-document"}


@pytest.fixture(autouse=True)
def _builtins() -> None:
    load_builtin_ops()


# -- helpers --------------------------------------------------------------------------


def _rich_pdf(path: Path, pages: int = 3) -> Path:
    """A4 pages with text, a link, a bookmark and a form field."""
    c = canvas.Canvas(str(path), pagesize=A4)
    for i in range(pages):
        c.setFont("Helvetica", 24)
        c.drawString(72, 700, f"Hello text page {i + 1}")
        c.linkURL("https://example.com/", (72, 500, 300, 520), relative=0)
        c.bookmarkPage(f"p{i}")
        c.addOutlineEntry(f"Section {i + 1}", f"p{i}", level=0)
        c.acroForm.textfield(name=f"field{i}", x=72, y=300, width=200, height=20)
        c.showPage()
    c.save()
    return path


def _photo_like_pdf(path: Path, pages: int) -> Path:
    """Pages of 400 x 500 pt, each a JPEG of a gradient with strong grain (photo-like)."""
    rng = random.Random(1234)
    gradient = Image.linear_gradient("L").resize((800, 1000)).convert("RGB")
    jpegs: list[bytes] = []
    for _ in range(pages):
        grain = Image.frombytes("L", (800, 1000), rng.randbytes(800 * 1000)).point(
            lambda v: 64 + v // 2
        )
        photo = Image.blend(gradient, Image.merge("RGB", (grain, grain, grain)), 0.5)
        buf = io.BytesIO()
        photo.save(buf, format="JPEG", quality=92)
        jpegs.append(buf.getvalue())
    layout = img2pdf.get_fixed_dpi_layout_fun((144, 144))  # 800 px at 144 dpi = 400 pt
    path.write_bytes(bytes(img2pdf.convert(*jpegs, layout_fun=layout)))
    return path


def _open(h: Harness, path: Path) -> str:
    sid: str = h.open(path)["state"]["sessionId"]
    return sid


def _rev(h: Harness, sid: str) -> Path:
    return Path(h.call("session.state", {"sessionId": sid})["revisionPath"])


def _raw_images(path: Path, index: int) -> list[bytes]:
    with pikepdf.open(path) as pdf:
        return [bytes(img.read_raw_bytes()) for img in pdf.pages[index].get_images().values()]


def _all_raw_images(path: Path) -> list[list[bytes]]:
    with pikepdf.open(path) as pdf:
        count = len(pdf.pages)
    return [_raw_images(path, i) for i in range(count)]


def _direct_images(src: Path, tmp_path: Path, dpi: int, color: str, quality: int) -> list[bytes]:
    """The plain pipeline without the op: rasterize_page + encode_image_page, page 0."""
    out = tmp_path / "direct.pdf"
    mode: Any = color
    img = rasterize_page(src, 0, dpi, mode)
    out.write_bytes(encode_image_page(img, dpi, mode, quality))
    return _raw_images(out, 0)


def _embedded(path: Path, index: int) -> Image.Image:
    """The first image of a page, decoded to pixels from the stored stream."""
    with pikepdf.open(path) as pdf:
        image = next(iter(pdf.pages[index].images.values()))
        decoded: Image.Image = pikepdf.PdfImage(image).as_pil_image()
    return decoded


def _filter_name(path: Path) -> str:
    with pikepdf.open(path) as pdf:
        image = next(iter(pdf.pages[0].get_images().values()))
        filters = image.get("/Filter")
        if isinstance(filters, pikepdf.Array):
            filters = filters[0]
        return str(filters)


def _file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _rgb_bytes(path: Path) -> tuple[tuple[int, int], bytes]:
    with Image.open(path) as img:
        rgb = img.convert("RGB")
        return rgb.size, rgb.tobytes()


# -- K4: effects in scan.rasterize ----------------------------------------------------


def test_effects_literal_matches_effect_presets() -> None:
    assert set(get_args(EffectPresetName)) == set(EFFECT_PRESETS)


def test_no_effects_matches_plain_pipeline(harness: Harness, tmp_path: Path) -> None:
    src = _rich_pdf(tmp_path / "rich.pdf", pages=1)
    sid = _open(harness, src)
    harness.op(RASTER, {"dpi": 150, "color": "gray"}, sid)
    expected = _direct_images(src, tmp_path, 150, "gray", 75)
    assert _raw_images(_rev(harness, sid), 0) == expected


@pytest.mark.parametrize(
    "extra",
    [
        {"effects": None, "effectsPreset": None, "seed": 9},
        {"effectsPreset": "none", "seed": 9},
        {"effects": {}, "seed": 9},  # neutral ScanEffects defaults
    ],
)
def test_neutral_effects_equal_plain_output(
    harness: Harness, tmp_path: Path, extra: dict[str, Any]
) -> None:
    src = _rich_pdf(tmp_path / "rich.pdf", pages=2)
    plain = _open(harness, src)
    harness.op(RASTER, {"dpi": 120, "color": "gray"}, plain)
    expected = _all_raw_images(_rev(harness, plain))
    sid = _open(harness, src)
    harness.op(RASTER, {"dpi": 120, "color": "gray", **extra}, sid)
    assert _all_raw_images(_rev(harness, sid)) == expected


def test_effects_change_the_page_image(harness: Harness, tmp_path: Path) -> None:
    src = _rich_pdf(tmp_path / "rich.pdf", pages=1)
    plain = _open(harness, src)
    harness.op(RASTER, {"dpi": 120, "color": "gray"}, plain)
    sid = _open(harness, src)
    harness.op(RASTER, {"dpi": 120, "color": "gray", "effectsPreset": "photocopy"}, sid)
    assert _raw_images(_rev(harness, sid), 0) != _raw_images(_rev(harness, plain), 0)


def test_same_seed_gives_identical_output(harness: Harness, tmp_path: Path) -> None:
    src = _rich_pdf(tmp_path / "rich.pdf", pages=3)
    params = {"dpi": 120, "color": "gray", "effectsPreset": "photocopy", "seed": 3}
    a = _open(harness, src)
    harness.op(RASTER, params, a)
    b = _open(harness, src)
    harness.op(RASTER, params, b)
    assert _file_hash(_rev(harness, a)) == _file_hash(_rev(harness, b))


def test_different_seeds_differ(harness: Harness, tmp_path: Path) -> None:
    src = _rich_pdf(tmp_path / "rich.pdf", pages=2)
    results = []
    for seed in (1, 2):
        sid = _open(harness, src)
        harness.op(RASTER, {"dpi": 120, "effectsPreset": "photocopy", "seed": seed}, sid)
        results.append(_all_raw_images(_rev(harness, sid)))
    assert results[0] != results[1]


def test_explicit_effects_win_over_preset(harness: Harness, tmp_path: Path) -> None:
    src = _rich_pdf(tmp_path / "rich.pdf", pages=1)
    plain = _open(harness, src)
    harness.op(RASTER, {"dpi": 120, "color": "gray"}, plain)
    sid = _open(harness, src)
    harness.op(
        RASTER,
        {"dpi": 120, "color": "gray", "effects": {}, "effectsPreset": "photocopy"},
        sid,
    )
    assert _raw_images(_rev(harness, sid), 0) == _raw_images(_rev(harness, plain), 0)


def test_unknown_effects_preset_rejected(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _rich_pdf(tmp_path / "rich.pdf", pages=1))
    with pytest.raises(RpcFailure) as exc:
        harness.call(
            "ops.run",
            {"sessionId": sid, "opId": RASTER, "params": {"effectsPreset": "sepia"}},
        )
    assert exc.value.kind == "INVALID_PARAMS"


def test_effects_identical_in_pool_workers(
    harness: Harness, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Effects run in the process pool too (parameters must pickle) and match inline output."""
    src = _rich_pdf(tmp_path / "rich4.pdf", pages=4)
    params = {"dpi": 100, "color": "gray", "effectsPreset": "old-paper", "seed": 5}
    inline = _open(harness, src)
    monkeypatch.setattr(scan, "MAX_WORKERS", 1)
    harness.op(RASTER, params, inline)
    pooled = _open(harness, src)
    monkeypatch.setattr(scan, "MAX_WORKERS", 2)
    monkeypatch.setattr(scan, "POOL_MIN_PAGES", 1)
    harness.op(RASTER, params, pooled)
    assert _all_raw_images(_rev(harness, pooled)) == _all_raw_images(_rev(harness, inline))


def test_effects_apply_before_bw_threshold(harness: Harness, tmp_path: Path) -> None:
    """A bw page with effects is still 1-bit CCITT, and its grey levels were thresholded."""
    sid = _open(harness, _rich_pdf(tmp_path / "rich.pdf", pages=1))
    harness.op(RASTER, {"dpi": 100, "color": "bw", "effectsPreset": "photocopy"}, sid)
    assert _filter_name(_rev(harness, sid)) == "/CCITTFaxDecode"
    with pikepdf.open(_rev(harness, sid)) as pdf:
        image = next(iter(pdf.pages[0].get_images().values()))
        assert int(image.BitsPerComponent) == 1


# -- K5, K6: scan.preview -------------------------------------------------------------


def test_preview_default_samples_first_and_middle(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _rich_pdf(tmp_path / "rich3.pdf", pages=3))
    data = harness.op(PREVIEW, {"dpi": 100}, sid)["data"]
    assert [s["pageIndex"] for s in data["samples"]] == [0, 1]


def test_preview_single_page_has_one_sample(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _rich_pdf(tmp_path / "rich1.pdf", pages=1))
    data = harness.op(PREVIEW, {"dpi": 100}, sid)["data"]
    assert [s["pageIndex"] for s in data["samples"]] == [0]


def test_preview_samples_come_from_selected_pages(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _rich_pdf(tmp_path / "rich3.pdf", pages=3))
    data = harness.op(PREVIEW, {"dpi": 100, "pages": [2]}, sid)["data"]
    assert [s["pageIndex"] for s in data["samples"]] == [2]


def test_preview_explicit_samples(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _rich_pdf(tmp_path / "rich3.pdf", pages=3))
    data = harness.op(PREVIEW, {"dpi": 100, "samplePages": [2, 0, 2]}, sid)["data"]
    assert [s["pageIndex"] for s in data["samples"]] == [0, 2]


def test_preview_sample_shapes_and_files(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _rich_pdf(tmp_path / "rich3.pdf", pages=3))
    data = harness.op(PREVIEW, {"dpi": 200, "color": "color"}, sid)["data"]
    session_dir = _rev(harness, sid).parent
    for sample in data["samples"]:
        assert set(sample) == {
            "pageIndex",
            "originalPath",
            "resultPath",
            "widthPx",
            "heightPx",
            "encodedBytes",
        }
        original, result = Path(sample["originalPath"]), Path(sample["resultPath"])
        assert original.is_file() and result.is_file()
        assert session_dir in original.parents and session_dir in result.parents
        assert sample["encodedBytes"] > 0
        width_pt = 595.2756  # A4
        assert abs(sample["widthPx"] - width_pt * 200 / 72) <= 1.5
        with Image.open(result) as img:
            assert img.size == (sample["widthPx"], sample["heightPx"])
        with Image.open(original) as img:
            assert img.size == (sample["widthPx"], sample["heightPx"])


def test_preview_original_is_plain_rasterization(harness: Harness, tmp_path: Path) -> None:
    src = _rich_pdf(tmp_path / "rich.pdf", pages=1)
    sid = _open(harness, src)
    sample = harness.op(PREVIEW, {"dpi": 120, "color": "gray", "effectsPreset": "photocopy"}, sid)[
        "data"
    ]["samples"][0]
    expected = rasterize_page(src, 0, 120, "gray")
    assert _rgb_bytes(Path(sample["originalPath"]))[1] == expected.convert("RGB").tobytes()


def test_preview_result_matches_real_output(harness: Harness, tmp_path: Path) -> None:
    """The result image is what scan.rasterize produces for the same parameters and page."""
    src = _rich_pdf(tmp_path / "rich.pdf", pages=2)
    params = {"dpi": 120, "color": "gray", "effectsPreset": "photocopy", "seed": 4}
    sid = _open(harness, src)
    sample = harness.op(PREVIEW, {**params, "samplePages": [1]}, sid)["data"]["samples"][0]
    harness.op(RASTER, {**params, "pages": [1]}, sid)
    real = _embedded(_rev(harness, sid), 1)
    assert _rgb_bytes(Path(sample["resultPath"])) == (real.size, real.convert("RGB").tobytes())


def test_preview_does_not_modify_session(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _rich_pdf(tmp_path / "rich.pdf", pages=2))
    before_state = harness.call("session.state", {"sessionId": sid})
    before_hash = _file_hash(_rev(harness, sid))
    harness.op(PREVIEW, {"dpi": 150, "effectsPreset": "photocopy"}, sid)
    after_state = harness.call("session.state", {"sessionId": sid})
    assert after_state == before_state
    assert _file_hash(_rev(harness, sid)) == before_hash


def test_preview_estimate_matches_real_size(harness: Harness, tmp_path: Path) -> None:
    src = _rich_pdf(tmp_path / "rich6.pdf", pages=6)
    params = {"dpi": 150, "color": "gray", "jpegQuality": 75}
    sid = _open(harness, src)
    estimate = harness.op(PREVIEW, params, sid)["data"]["estimate"]
    sid2 = _open(harness, src)
    harness.op(RASTER, params, sid2)
    actual = _rev(harness, sid2).stat().st_size
    assert 0.75 * actual <= estimate["estimatedBytes"] <= 1.25 * actual


def test_preview_estimate_fields(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _rich_pdf(tmp_path / "rich3.pdf", pages=3))
    estimate = harness.op(PREVIEW, {"dpi": 100}, sid)["data"]["estimate"]
    assert set(estimate) == {"estimatedBytes", "estimatedSeconds", "lossWarnings"}
    assert estimate["estimatedBytes"] > 0
    assert estimate["estimatedSeconds"] >= 0.1
    assert len(estimate["lossWarnings"]) == 4  # text, links, bookmarks, form fields


def test_preview_warns_about_signatures(harness: Harness, corpus: dict[str, Path]) -> None:
    sid = _open(harness, corpus["fake_signed.pdf"])
    warnings = harness.op(PREVIEW, {"dpi": 100}, sid)["data"]["estimate"]["lossWarnings"]
    assert any("signature" in w.lower() for w in warnings), warnings


def test_preview_refuses_oversized_pages(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _rich_pdf(tmp_path / "rich.pdf", pages=1))
    with pytest.raises(RpcFailure) as exc:
        harness.op(PREVIEW, {"dpi": 1200}, sid)
    assert exc.value.kind == "INVALID_PARAMS"
    assert 72 <= exc.value.detail["maxDpi"] < 1200


def test_preview_rejects_bad_sample_pages(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _rich_pdf(tmp_path / "rich3.pdf", pages=3))
    with pytest.raises(RpcFailure) as exc:
        harness.op(PREVIEW, {"samplePages": [9]}, sid)
    assert exc.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as exc:
        harness.call(
            "ops.run",
            {"sessionId": sid, "opId": PREVIEW, "params": {"samplePages": [0, 1, 2, 0]}},
        )
    assert exc.value.kind == "INVALID_PARAMS"


def test_preview_needs_a_session(harness: Harness) -> None:
    with pytest.raises(RpcFailure) as exc:
        harness.call("ops.run", {"opId": PREVIEW, "params": {}})
    assert exc.value.kind == "INVALID_PARAMS"


# -- K8: presets ----------------------------------------------------------------------


def test_presets_rpc_lists_builtin_presets(harness: Harness) -> None:
    presets = harness.call("scan.presets")
    assert {p["name"] for p in presets} == PRESET_NAMES
    for preset in presets:
        assert preset["labelVi"] and preset["labelEn"]
        assert isinstance(preset["params"], dict)


def test_every_preset_validates_as_rasterize_params(harness: Harness) -> None:
    for preset in harness.call("scan.presets"):
        params = RasterizeParams.model_validate(preset["params"])
        if params.effects_preset is not None:
            assert params.effects_preset in EFFECT_PRESETS


def test_every_preset_rasterizes_a_corpus_document(harness: Harness, tmp_path: Path) -> None:
    src = _rich_pdf(tmp_path / "rich2.pdf", pages=2)
    for preset in harness.call("scan.presets"):
        sid = _open(harness, src)
        result = harness.op(RASTER, preset["params"], sid)
        assert result["state"]["revision"] == 1, preset["name"]
        with pikepdf.open(_rev(harness, sid)) as pdf:
            assert len(pdf.pages) == 2, preset["name"]


def test_fax_preset_is_ccitt_bw(harness: Harness, tmp_path: Path) -> None:
    fax = next(p for p in harness.call("scan.presets") if p["name"] == "fax-bw")
    assert fax["params"]["color"] == "bw"
    assert fax["params"]["threshold"] == 140
    assert fax["params"]["dithering"] is False
    sid = _open(harness, _rich_pdf(tmp_path / "rich1.pdf", pages=1))
    harness.op(RASTER, fax["params"], sid)
    assert _filter_name(_rev(harness, sid)) == "/CCITTFaxDecode"


def test_presets_module_is_plain_data() -> None:
    assert {p.name for p in scan_presets.PRESETS} == PRESET_NAMES


# -- K10: compress to a target size ---------------------------------------------------


def test_estimator_extrapolates_samples_with_overhead() -> None:
    assert scan_preview.estimate_bytes([1000, 3000], 4) == (2000 + 2048) * 4


def test_dpi_ladder_steps_down_from_base() -> None:
    assert scan_fit.dpi_ladder(200, 100) == [200, 150, 120, 100]
    assert scan_fit.dpi_ladder(400, 100) == [400, 300, 250, 200, 150, 120, 100]
    assert scan_fit.dpi_ladder(200, 150) == [200, 150]


@pytest.fixture(scope="module")
def photo_doc(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return _photo_like_pdf(tmp_path_factory.mktemp("photo") / "photos20.pdf", pages=20)


BASE_FIT = {"dpi": 200, "color": "gray", "jpegQuality": 90}


def _fit(h: Harness, path: Path, target: int, **extra: Any) -> dict[str, Any]:
    sid = _open(h, path)
    result: dict[str, Any] = h.op(FIT, {"targetBytes": target, **BASE_FIT, **extra}, sid)["data"]
    return result


def test_fit_keeps_base_when_already_small_enough(harness: Harness, photo_doc: Path) -> None:
    result = _fit(harness, photo_doc, 10**12)
    assert result["reachable"] is True
    assert result["steps"] == 1
    assert result["params"]["dpi"] == 200
    assert result["params"]["jpegQuality"] == 90


def test_fit_reachable_target_meets_estimate_and_real_size(
    harness: Harness, photo_doc: Path
) -> None:
    base = _fit(harness, photo_doc, 10**12)["estimatedBytes"]
    target = int(base * 0.5)
    result = _fit(harness, photo_doc, target)
    assert result["reachable"] is True
    assert result["estimatedBytes"] <= target * 1.1
    assert result["steps"] > 1
    assert result["params"]["dpi"] <= 200

    sid = _open(harness, photo_doc)
    harness.op(RASTER, result["params"], sid)
    assert _page_count(_rev(harness, sid)) == 20
    actual = _rev(harness, sid).stat().st_size
    assert 0.75 * result["estimatedBytes"] <= actual <= 1.25 * result["estimatedBytes"]


def test_fit_prefers_quality_before_dpi(harness: Harness, photo_doc: Path) -> None:
    base = _fit(harness, photo_doc, 10**12)["estimatedBytes"]
    result = _fit(harness, photo_doc, int(base * 0.9))
    assert result["reachable"] is True
    assert result["params"]["dpi"] == 200
    assert result["params"]["jpegQuality"] < 90


def test_fit_unreachable_reports_smallest_found(harness: Harness, photo_doc: Path) -> None:
    result = _fit(harness, photo_doc, 1)
    assert result["reachable"] is False
    assert result["estimatedBytes"] > 1
    assert result["params"]["dpi"] == 100
    assert result["params"]["jpegQuality"] == 30


def test_fit_rejects_bad_params(harness: Harness, photo_doc: Path) -> None:
    sid = _open(harness, photo_doc)
    for bad in ({"targetBytes": 0}, {"targetBytes": 10, "minDpi": 300}):  # dpi is 200
        with pytest.raises(RpcFailure) as exc:
            harness.op(FIT, {**BASE_FIT, **bad}, sid)
        assert exc.value.kind == "INVALID_PARAMS"


def _page_count(path: Path) -> int:
    with pikepdf.open(path) as pdf:
        return len(pdf.pages)
