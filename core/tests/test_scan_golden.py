"""Golden images for scan.rasterize (T2.08): rendered output compared with stored PNGs.

The source document is generated in the test (vector text in Be Vietnam Pro, a line drawing,
a gradient image). Each case runs the operation, renders page 1 of the output with PDFium at
the same dpi, scales it down to GOLDEN_WIDTH px and compares it with ``tests/golden``.

The comparison tolerates small differences between machines and library patch versions:
the mean absolute difference must stay below MEAN_TOLERANCE and no 8x8 block (in the scaled
image) may differ by more than BLOCK_TOLERANCE on average.

Regenerate the goldens with ``CHEF_UPDATE_GOLDEN=1 uv run pytest tests/test_scan_golden.py``.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pypdfium2 as pdfium
import pytest
from PIL import Image, ImageChops, ImageStat
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from chef_core.ops import load_builtin_ops
from chef_core.ops.base import OpContext, get_op

REPO_ROOT = Path(__file__).resolve().parents[2]
FONTS = REPO_ROOT / "tests" / "corpus" / "fonts"
GOLDEN_DIR = Path(__file__).resolve().parent / "golden"
GOLDEN_WIDTH = 300
BLOCK = 8
MEAN_TOLERANCE = 1.0  # mean absolute difference, 0..255 levels
BLOCK_TOLERANCE = 16.0  # worst 8x8 block mean absolute difference, 0..255 levels
GOLDEN_BUDGET_BYTES = 300 * 1024
UPDATE_ENV = "CHEF_UPDATE_GOLDEN"
RASTER = "scan.rasterize"


@dataclass(frozen=True)
class GoldenCase:
    name: str
    params: dict[str, Any] = field(default_factory=dict)
    dpi: int = 150
    mode: str = "L"  # "L" for gray and bw, "RGB" for color


CASES: list[GoldenCase] = [
    GoldenCase("gray_150", {"dpi": 150, "color": "gray"}, 150, "L"),
    GoldenCase(
        "bw_200_threshold_dither",
        {"dpi": 200, "color": "bw", "threshold": 128, "dithering": True},
        200,
        "L",
    ),
    GoldenCase("color_100", {"dpi": 100, "color": "color"}, 100, "RGB"),
    GoldenCase(
        "preset_photocopy_seed7",
        {"dpi": 150, "color": "gray", "effectsPreset": "photocopy", "seed": 7},
        150,
        "L",
    ),
    GoldenCase(
        "preset_old_paper_seed7",
        {"dpi": 150, "color": "gray", "effectsPreset": "old-paper", "seed": 7},
        150,
        "L",
    ),
]


# -- source document -------------------------------------------------------------------


def build_source(path: Path) -> Path:
    """One A4 page: title and paragraphs in vector text, a line drawing, a gradient image."""
    if "BeVietnamPro" not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont("BeVietnamPro", str(FONTS / "BeVietnamPro-Regular.ttf")))
    width, height = A4
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setTitle("Golden source")
    c.setFont("BeVietnamPro", 26)
    c.drawString(60, height - 90, "Chef PDF: bản scan mẫu")
    c.setFont("BeVietnamPro", 11)
    lines = [
        "Đây là đoạn văn bản dùng để kiểm tra độ rõ của chữ sau khi chuyển thành ảnh.",
        "Các dấu thanh như ắ, ệ, ồ, ử, ỹ và chữ đ phải còn nguyên hình dạng.",
        "Dòng chữ nhỏ 8 điểm: 0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz.",
    ]
    c.setFont("BeVietnamPro", 11)
    y = height - 130
    for line in lines:
        c.drawString(60, y, line)
        y -= 18
    c.setFont("BeVietnamPro", 8)
    c.drawString(60, y - 6, "0123456789 ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz.")

    # Line drawing: a grid, a sine-like curve and a few strokes.
    c.setLineWidth(0.6)
    for i in range(8):
        x = 60 + i * 60
        c.line(x, 330, x, 520)
    for j in range(6):
        y0 = 330 + j * 32
        c.line(60, y0, 420, y0)
    c.setLineWidth(1.4)
    path_obj = c.beginPath()
    path_obj.moveTo(60, 620)
    for k in range(1, 40):
        path_obj.lineTo(60 + k * 9, 620 + 25 * ((k % 4) - 2))
    c.drawPath(path_obj, stroke=1, fill=0)

    # Gradient image: a linear ramp under a radial one, as a PIL image.
    ramp = Image.linear_gradient("L").resize((360, 200)).convert("RGB")
    radial = Image.radial_gradient("L").resize((360, 200)).convert("RGB")
    picture = Image.blend(ramp, radial, 0.5)
    c.drawImage(
        ImageReader(picture),
        60,
        width - 60 - 360 - 60,
        width=360,
        height=200,
    )
    c.showPage()
    c.save()
    return path


@pytest.fixture(scope="module")
def source_pdf(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return build_source(tmp_path_factory.mktemp("golden_src") / "source.pdf")


# -- rendering and comparison ----------------------------------------------------------


def render_scaled(pdf_path: Path, dpi: int, mode: str) -> Image.Image:
    """Page 1 of ``pdf_path`` rendered with PDFium at ``dpi``, scaled to GOLDEN_WIDTH wide."""
    doc = pdfium.PdfDocument(str(pdf_path))
    try:
        page = doc[0]
        try:
            bitmap = page.render(scale=dpi / 72, fill_color=(255, 255, 255, 255))
            try:
                rgb: Image.Image = bitmap.to_pil().convert("RGB")
            finally:
                bitmap.close()
        finally:
            page.close()
    finally:
        doc.close()
    height = round(rgb.height * GOLDEN_WIDTH / rgb.width)
    scaled = rgb.resize((GOLDEN_WIDTH, height), Image.Resampling.BOX)
    return scaled.convert("L") if mode == "L" else scaled


def compare(actual: Image.Image, golden: Image.Image) -> tuple[float, float]:
    """Return (mean absolute difference, worst 8x8 block mean), both on 0..255 levels."""
    if actual.size != golden.size or actual.mode != golden.mode:
        raise AssertionError(
            f"image mismatch: got {actual.size} {actual.mode}, golden {golden.size} {golden.mode}"
        )
    diff = ImageChops.difference(actual, golden)
    if diff.mode == "RGB":
        diff = diff.convert("L")
    mean = float(ImageStat.Stat(diff).mean[0])
    blocks = diff.resize(
        (max(1, diff.width // BLOCK), max(1, diff.height // BLOCK)), Image.Resampling.BOX
    )
    worst = float(max(blocks.tobytes()))
    return mean, worst


def golden_path(name: str) -> Path:
    return GOLDEN_DIR / f"{name}.png"


def check_against_golden(name: str, actual: Image.Image) -> None:
    path = golden_path(name)
    if os.environ.get(UPDATE_ENV) == "1":
        GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
        actual.save(path, optimize=True)
        return
    if not path.exists():
        pytest.fail(
            f"golden image missing: {path}. Generate it with "
            f"{UPDATE_ENV}=1 uv run pytest tests/test_scan_golden.py, then review and commit it."
        )
    golden = Image.open(path)
    golden.load()
    mean, worst = compare(actual, golden)
    assert mean < MEAN_TOLERANCE, f"{name}: mean difference {mean:.3f} >= {MEAN_TOLERANCE}"
    assert worst < BLOCK_TOLERANCE, (
        f"{name}: worst block difference {worst:.2f} >= {BLOCK_TOLERANCE}"
    )


def run_op(source: Path, tmp_path: Path, params: dict[str, Any]) -> Path:
    load_builtin_ops()
    spec = get_op(RASTER)
    assert spec is not None
    model = spec.params_model.model_validate(params)
    work = tmp_path / "work"
    work.mkdir(exist_ok=True)
    out = tmp_path / "out.pdf"
    ctx = OpContext(job_id="golden", work_dir=work, input_path=source, result_path=out)
    spec.run(ctx, model)
    return out


# -- tests ----------------------------------------------------------------------------


@pytest.mark.parametrize("case", CASES, ids=[c.name for c in CASES])
def test_golden_image(case: GoldenCase, source_pdf: Path, tmp_path: Path) -> None:
    out = run_op(source_pdf, tmp_path, case.params)
    actual = render_scaled(out, case.dpi, case.mode)
    check_against_golden(case.name, actual)


def test_golden_files_are_small() -> None:
    files = sorted(GOLDEN_DIR.glob("*.png"))
    if os.environ.get(UPDATE_ENV) != "1":
        assert {c.name for c in CASES} <= {f.stem for f in files}
    total = sum(f.stat().st_size for f in files)
    assert total < GOLDEN_BUDGET_BYTES, f"goldens take {total} bytes"
    for f in files:
        with Image.open(f) as img:
            assert img.width <= GOLDEN_WIDTH, f


def test_missing_golden_fails_with_hint(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """A missing golden must fail loudly and say how to regenerate it, never pass silently."""
    monkeypatch.delenv(UPDATE_ENV, raising=False)
    monkeypatch.setattr(_this_module(), "GOLDEN_DIR", tmp_path)
    actual = Image.new("L", (GOLDEN_WIDTH, 100), 255)
    with pytest.raises(pytest.fail.Exception, match=UPDATE_ENV):
        check_against_golden("does_not_exist", actual)


def test_update_env_writes_golden(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv(UPDATE_ENV, "1")
    monkeypatch.setattr(_this_module(), "GOLDEN_DIR", tmp_path)
    actual = Image.new("L", (GOLDEN_WIDTH, 40), 200)
    check_against_golden("written", actual)
    assert (tmp_path / "written.png").exists()


def test_compare_detects_real_differences() -> None:
    base = Image.new("L", (GOLDEN_WIDTH, 200), 255)
    assert compare(base, base.copy()) == (0.0, 0.0)
    shifted = base.copy()
    shifted.paste(0, (0, 0, 80, 80))  # one dark 80x80 block
    mean, worst = compare(shifted, base)
    assert mean > MEAN_TOLERANCE
    assert worst > BLOCK_TOLERANCE


def _this_module() -> Any:
    return sys.modules[__name__]
