"""scan.rasterize streaming and memory guard (T2.04): worker count, RAM budget, page assembly.

The assembly writes encoded page images to disk and builds the PDF with img2pdf; unselected
pages are copied from the source. These tests pin the observable results of that path.
"""

from __future__ import annotations

import math
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium
import pytest
from PIL import Image
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

from chef_core.ops import load_builtin_ops, scan
from chef_core.ops.base import OpContext, get_op
from chef_core.pdf.rasterize import assemble_image_pdf, encode_image_bytes

RASTER = "scan.rasterize"
MIB = 1024 * 1024
GIB = 1024 * MIB


@pytest.fixture(autouse=True)
def _builtins() -> None:
    load_builtin_ops()


# -- worker count and RAM budget (fake numbers) ----------------------------------------


@pytest.mark.parametrize(
    ("per_page", "cpus", "budget", "expected"),
    [
        (300 * MIB, 16, 1536 * MIB, 4),  # five pages fit, capped at 4 processes
        (600 * MIB, 16, 1536 * MIB, 2),  # two pages fit
        (1024 * MIB, 16, 1536 * MIB, 1),  # one page fits exactly
        (3 * GIB, 16, 1536 * MIB, 1),  # no page fits: still one worker
        (1 * MIB, 2, 1536 * MIB, 2),  # capped by the CPUs
        (1 * MIB, 1, 1536 * MIB, 1),
        (0, 8, 1536 * MIB, 4),  # degenerate size does not divide by zero
        (300 * MIB, 16, 0, 1),  # zero budget still allows one worker
    ],
)
def test_worker_count(per_page: int, cpus: int, budget: int, expected: int) -> None:
    assert scan.worker_count(per_page, cpus, budget) == expected


def test_worker_count_never_exceeds_the_budget() -> None:
    for per_page in (10 * MIB, 100 * MIB, 500 * MIB):
        for budget in (256 * MIB, 1536 * MIB):
            workers = scan.worker_count(per_page, 16, budget)
            assert workers == 1 or workers * per_page <= budget


def test_a4_at_600dpi_estimate() -> None:
    expected_pixels = math.ceil(595.2756 * 600 / 72) * math.ceil(841.8898 * 600 / 72)
    assert scan.page_bitmap_bytes(595.2756, 841.8898, 600) == expected_pixels * 8
    assert 270 * 10**6 < scan.page_bitmap_bytes(595.2756, 841.8898, 600) < 290 * 10**6


def test_default_ram_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(scan.RAM_BUDGET_ENV, raising=False)
    assert int(1.5 * GIB) == scan.RAM_BUDGET_BYTES
    assert scan.ram_budget_bytes() == int(1.5 * GIB)


@pytest.mark.parametrize("raw", ["64", " 64 "])
def test_ram_budget_env_overrides(monkeypatch: pytest.MonkeyPatch, raw: str) -> None:
    monkeypatch.setenv(scan.RAM_BUDGET_ENV, raw)
    assert scan.ram_budget_bytes() == 64 * MIB


@pytest.mark.parametrize("raw", ["", "abc", "0", "-5", "1.5"])
def test_ram_budget_env_invalid_falls_back(monkeypatch: pytest.MonkeyPatch, raw: str) -> None:
    monkeypatch.setenv(scan.RAM_BUDGET_ENV, raw)
    assert scan.ram_budget_bytes() == scan.RAM_BUDGET_BYTES


def test_largest_page_bytes_uses_the_biggest_selected_page() -> None:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(100, 200))
    pdf.add_blank_page(page_size=(1000, 2000))
    try:
        assert scan.largest_page_bytes(pdf, [0, 1], 72) == 1000 * 2000 * 8
        assert scan.largest_page_bytes(pdf, [0], 72) == 100 * 200 * 8
    finally:
        pdf.close()


def test_tiny_budget_runs_inline_with_same_result(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """With a 1 MiB budget the guard picks one worker: the inline path, same page sizes."""
    src = _text_pages(tmp_path / "text.pdf", pages=10)
    monkeypatch.setenv(scan.RAM_BUDGET_ENV, "1")
    monkeypatch.setattr(scan, "POOL_MIN_PAGES", 1)
    out = _run(src, tmp_path, {"dpi": 100})
    assert _page_count(out) == 10
    assert _same_sizes(_sizes(out), _sizes(src), 72 / 100 + 1e-3)  # one pixel at 100 dpi


# -- assembly helper ------------------------------------------------------------------


def test_assemble_image_pdf_sizes_follow_dpi(tmp_path: Path) -> None:
    files: list[Path] = []
    for index, (w, h) in enumerate([(120, 180), (240, 60)]):
        img = Image.new("L", (w, h), 40 + index * 80)
        path = tmp_path / f"img{index}.jpg"
        path.write_bytes(encode_image_bytes(img, 150, "gray", 80))
        files.append(path)
    dest = tmp_path / "assembled.pdf"
    assemble_image_pdf(files, 150, dest)
    with pikepdf.open(dest) as pdf:
        sizes = [
            (
                float(p.mediabox[2]) - float(p.mediabox[0]),
                float(p.mediabox[3]) - float(p.mediabox[1]),
            )
            for p in pdf.pages
        ]
    assert sizes == [
        pytest.approx((120 * 72 / 150, 180 * 72 / 150)),
        pytest.approx((240 * 72 / 150, 60 * 72 / 150)),
    ]


# -- partial selection -----------------------------------------------------------------


def test_unselected_pages_are_kept_as_they_were(tmp_path: Path) -> None:
    src = _text_pages(tmp_path / "text.pdf", pages=4)
    out = _run(src, tmp_path, {"dpi": 100, "pages": [1, 3]})
    assert _page_count(out) == 4
    for index in range(4):
        text = _text(out, index).strip()
        if index in (1, 3):
            assert text == ""
        else:
            assert f"Line on page {index + 1}" in text
    source_sizes, out_sizes = _sizes(src), _sizes(out)
    for index in range(4):
        if index in (1, 3):  # converted: sizes are whole pixels at 100 dpi
            assert abs(out_sizes[index][0] - source_sizes[index][0]) <= 72 / 100 + 1e-3
        else:  # copied: identical
            assert out_sizes[index] == source_sizes[index]


def test_unselected_pages_keep_inherited_rotation(tmp_path: Path) -> None:
    """A /Rotate and /MediaBox inherited from the page tree must survive being copied."""
    src = tmp_path / "inherited.pdf"
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(300, 400))
    pdf.add_blank_page(page_size=(300, 400))
    for page in pdf.pages:
        del page.obj["/MediaBox"]
    # MediaBox and Rotate live on the page tree node only, as some producers write them.
    pdf.Root.Pages.MediaBox = pikepdf.Array([0, 0, 300, 400])
    pdf.Root.Pages.Rotate = 90
    pdf.save(src)
    pdf.close()
    expected = _displayed(src)
    out = _run(src, tmp_path, {"dpi": 72, "pages": [0]})
    actual = _displayed(out)
    assert len(actual) == 2
    # Page 2 was copied: it keeps the displayed size it had in the source.
    assert actual[1] == pytest.approx(expected[1], abs=0.01)


def test_copied_pages_keep_catalog_language_and_metadata(tmp_path: Path) -> None:
    src = _text_pages(tmp_path / "text.pdf", pages=3)
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        pdf.Root.Lang = "vi-VN"
        with pdf.open_metadata() as meta:
            meta["dc:title"] = "Kept title"
        pdf.save(src)
    out = _run(src, tmp_path, {"dpi": 72, "pages": [0], "stripMetadata": False})
    with pikepdf.open(out) as pdf:
        assert str(pdf.Root.Lang) == "vi-VN"
        assert str(pdf.docinfo.get("/Title")) == "Kept title"
        assert "/Metadata" in pdf.Root


@pytest.mark.parametrize("gray", [0.0, 1.0])
def test_bw_output_keeps_polarity(tmp_path: Path, gray: float) -> None:
    """CCITT payloads are copied, not re-encoded: black must stay black and white stay white."""
    src = tmp_path / "flat.pdf"
    c = canvas.Canvas(str(src), pagesize=(200, 200))
    c.setFillGray(gray)
    c.rect(0, 0, 200, 200, stroke=0, fill=1)
    c.showPage()
    c.save()
    out = _run(src, tmp_path, {"dpi": 72, "color": "bw", "threshold": 128})
    doc = pdfium.PdfDocument(str(out))
    try:
        mean = sum(doc[0].render(scale=1).to_pil().convert("L").tobytes()) / (200 * 200)
    finally:
        doc.close()
    assert (mean < 16) if gray == 0.0 else (mean > 239)


def test_partial_output_is_deterministic(tmp_path: Path) -> None:
    src = _text_pages(tmp_path / "text.pdf", pages=5)
    first = _run(src, tmp_path / "a", {"dpi": 100, "pages": [0, 2, 4]})
    second = _run(src, tmp_path / "b", {"dpi": 100, "pages": [0, 2, 4]})
    assert first.read_bytes() == second.read_bytes()


def test_no_temporary_files_left_in_work_dir(tmp_path: Path) -> None:
    src = _text_pages(tmp_path / "text.pdf", pages=3)
    work = tmp_path / "work"
    _run(src, tmp_path, {"dpi": 100, "pages": [1]}, work=work)
    assert [p.name for p in work.iterdir()] == []


# -- helpers ----------------------------------------------------------------------------


def _text_pages(path: Path, pages: int) -> Path:
    c = canvas.Canvas(str(path), pagesize=A4)
    for index in range(pages):
        c.setFont("Helvetica", 14)
        c.drawString(72, 700, f"Line on page {index + 1}")
        c.showPage()
    c.save()
    return path


def _run(src: Path, tmp_path: Path, params: dict[str, object], work: Path | None = None) -> Path:
    spec = get_op(RASTER)
    assert spec is not None
    model = spec.params_model.model_validate(params)
    tmp_path.mkdir(parents=True, exist_ok=True)
    work_dir = work or tmp_path / "work"
    work_dir.mkdir(parents=True, exist_ok=True)
    out = tmp_path / "out.pdf"
    ctx = OpContext(job_id="stream", work_dir=work_dir, input_path=src, result_path=out)
    spec.run(ctx, model)
    return out


def _text(path: Path, index: int) -> str:
    doc = pdfium.PdfDocument(str(path))
    try:
        return str(doc[index].get_textpage().get_text_range())
    finally:
        doc.close()


def _page_count(path: Path) -> int:
    with pikepdf.open(path) as pdf:
        return len(pdf.pages)


def _sizes(path: Path) -> list[tuple[float, float]]:
    with pikepdf.open(path) as pdf:
        return [
            (
                round(float(p.mediabox[2]) - float(p.mediabox[0]), 2),
                round(float(p.mediabox[3]) - float(p.mediabox[1]), 2),
            )
            for p in pdf.pages
        ]


def _same_sizes(a: list[tuple[float, float]], b: list[tuple[float, float]], tol: float) -> bool:
    return len(a) == len(b) and all(
        abs(x0 - y0) <= tol and abs(x1 - y1) <= tol for (x0, x1), (y0, y1) in zip(a, b, strict=True)
    )


def _displayed(path: Path) -> list[tuple[float, float]]:
    doc = pdfium.PdfDocument(str(path))
    try:
        return [tuple(page.get_size()) for page in doc]  # type: ignore[misc]
    finally:
        doc.close()
