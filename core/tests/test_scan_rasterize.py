"""Scan conversion (K1-K3, K7, K9): scan.rasterize and the rasterize_page helper."""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
import pytest
from conftest import Harness, RpcFailure
from reportlab.lib.pagesizes import A4, letter
from reportlab.pdfgen import canvas

from chef_core.errors import CancelledError
from chef_core.ops import load_builtin_ops, scan
from chef_core.ops.base import OpContext, get_op
from chef_core.pdf.rasterize import rasterize_page

RASTER = "scan.rasterize"


# -- helpers --------------------------------------------------------------------------


def _rich_pdf(path: Path, pages: int = 3, *, links: bool = True, form: bool = True) -> Path:
    """Text on every page; optionally a link, a bookmark and a form field per page."""
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setTitle("Rich sample")
    for i in range(pages):
        c.setFont("Helvetica", 24)
        c.drawString(72, 700, f"Hello text page {i + 1}")
        if links:
            c.linkURL("https://example.com/", (72, 500, 300, 520), relative=0)
        c.bookmarkPage(f"p{i}")
        c.addOutlineEntry(f"Section {i + 1}", f"p{i}", level=0)
        if form:
            c.acroForm.textfield(name=f"field{i}", x=72, y=300, width=200, height=20)
        c.showPage()
    c.save()
    return path


def _text_only_pdf(path: Path, pages: int = 2) -> Path:
    c = canvas.Canvas(str(path), pagesize=letter)
    for i in range(pages):
        c.setFont("Helvetica", 24)
        c.drawString(72, 700, f"Plain text {i + 1}")
        c.showPage()
    c.save()
    return path


def _gray_page_pdf(path: Path, gray: float) -> Path:
    """One page filled with a flat gray (0..1), for threshold tests."""
    c = canvas.Canvas(str(path), pagesize=(200, 200))
    c.setFillGray(gray)
    c.rect(0, 0, 200, 200, stroke=0, fill=1)
    c.showPage()
    c.save()
    return path


def _text(path: Path, index: int) -> str:
    doc = pdfium.PdfDocument(str(path))
    try:
        return str(doc[index].get_textpage().get_text_range())
    finally:
        doc.close()


def _page_count(path: Path) -> int:
    doc = pdfium.PdfDocument(str(path))
    try:
        return len(doc)
    finally:
        doc.close()


def _same_sizes(a: list[tuple[float, float]], b: list[tuple[float, float]], tol: float) -> bool:
    return len(a) == len(b) and all(
        abs(x0 - y0) <= tol and abs(x1 - y1) <= tol for (x0, x1), (y0, y1) in zip(a, b, strict=True)
    )


def _sizes_pt(path: Path) -> list[tuple[float, float]]:
    with pikepdf.open(path) as pdf:
        out: list[tuple[float, float]] = []
        for page in pdf.pages:
            x0, y0, x1, y1 = (float(v) for v in page.mediabox)
            out.append((x1 - x0, y1 - y0))
        return out


def _displayed_sizes(path: Path) -> list[tuple[float, float]]:
    """Page sizes as pdfium displays them (CropBox, /Rotate applied)."""
    doc = pdfium.PdfDocument(str(path))
    try:
        return [tuple(page.get_size()) for page in doc]  # type: ignore[misc]
    finally:
        doc.close()


def _rev(h: Harness, sid: str) -> Path:
    return Path(h.call("session.state", {"sessionId": sid})["revisionPath"])


def _open(h: Harness, path: Path) -> str:
    sid: str = h.open(path)["state"]["sessionId"]
    return sid


def _image_info(path: Path, index: int) -> list[dict[str, Any]]:
    """Filter, colour space, bit depth, size and leading stream bytes of each page image."""
    with pikepdf.open(path) as pdf:
        infos: list[dict[str, Any]] = []
        for img in pdf.pages[index].get_images().values():
            params = img.get("/DecodeParms")
            if isinstance(params, pikepdf.Array):
                params = params[0]
            filters = img.get("/Filter")
            if isinstance(filters, pikepdf.Array):
                filters = filters[0]
            infos.append(
                {
                    "filter": str(filters),
                    "colorspace": str(img.get("/ColorSpace")),
                    "bpc": int(img.BitsPerComponent),
                    "width": int(img.Width),
                    "height": int(img.Height),
                    "k": int(params.K) if isinstance(params, pikepdf.Dictionary) else None,
                    "head": bytes(img.read_raw_bytes()[:2]),
                }
            )
        return infos


def _ctx(tmp_path: Path, src: Path, out: Path, event: Any = None, sink: Any = None) -> OpContext:
    work = tmp_path / "work"
    work.mkdir(exist_ok=True)
    return OpContext(
        job_id="test",
        work_dir=work,
        input_path=src,
        result_path=out,
        cancel_event=event,
        progress_sink=sink,
    )


@pytest.fixture(autouse=True)
def _builtins() -> None:
    load_builtin_ops()


# -- registration ---------------------------------------------------------------------


def test_registered_as_destructive_scan_op() -> None:
    spec = get_op(RASTER)
    assert spec is not None
    assert spec.group == "scan"
    assert spec.destructive is True
    assert spec.standalone is False


def test_invalid_params_rejected(harness: Harness, corpus: dict[str, Path]) -> None:
    sid = _open(harness, corpus["vietnamese_text.pdf"])
    for bad in ({"dpi": 71}, {"dpi": 1201}, {"color": "sepia"}, {"jpegQuality": 0}):
        with pytest.raises(RpcFailure) as exc:
            harness.call("ops.run", {"sessionId": sid, "opId": RASTER, "params": bad})
        assert exc.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as exc:
        harness.op(RASTER, {"pages": [9]}, sid)
    assert exc.value.kind == "INVALID_PARAMS"


# -- output geometry ------------------------------------------------------------------


@pytest.mark.parametrize("dpi", [100, 150, 200, 300])
def test_page_count_and_size_preserved(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path, dpi: int
) -> None:
    """Sizes in points (CropBox, /Rotate applied) survive within one pixel of rounding."""
    src = corpus["mixed_sizes.pdf"]
    sid = _open(harness, src)
    harness.op(RASTER, {"dpi": dpi}, sid)
    out = _rev(harness, sid)
    expected = _displayed_sizes(src)
    actual = _sizes_pt(out)
    assert len(actual) == len(expected) == _page_count(out)
    tolerance = 72 / dpi + 1e-3
    for (ew, eh), (aw, ah) in zip(expected, actual, strict=True):
        assert abs(aw - ew) <= tolerance and abs(ah - eh) <= tolerance, (ew, eh, aw, ah)
    # The page size is exactly pixels * 72 / dpi, i.e. the image defines the page size.
    for index, (aw, ah) in enumerate(actual):
        img = _image_info(out, index)[0]
        assert img["width"] * 72 / dpi == pytest.approx(aw, abs=1e-3)
        assert img["height"] * 72 / dpi == pytest.approx(ah, abs=1e-3)


def test_output_page_has_no_rotation(harness: Harness, corpus: dict[str, Path]) -> None:
    sid = _open(harness, corpus["inherited_rotate.pdf"])
    harness.op(RASTER, {"dpi": 100}, sid)
    with pikepdf.open(_rev(harness, sid)) as pdf:
        assert all(int(p.rotation) % 360 == 0 for p in pdf.pages)
        # Rotated source pages are landscape on display, so the image is wider than tall.
        assert float(pdf.pages[0].mediabox[2]) > float(pdf.pages[0].mediabox[3])


# -- color modes ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("color", "filter_name", "colorspace", "bpc"),
    [
        ("color", "/DCTDecode", "/DeviceRGB", 8),
        ("gray", "/DCTDecode", "/DeviceGray", 8),
        ("bw", "/CCITTFaxDecode", "/DeviceGray", 1),
    ],
)
def test_color_modes_embed_expected_image(
    harness: Harness,
    tmp_path: Path,
    color: str,
    filter_name: str,
    colorspace: str,
    bpc: int,
) -> None:
    sid = _open(harness, _rich_pdf(tmp_path / "rich.pdf", pages=1))
    harness.op(RASTER, {"dpi": 150, "color": color}, sid)
    images = _image_info(_rev(harness, sid), 0)
    assert len(images) == 1
    img = images[0]
    assert img["filter"] == filter_name
    assert img["colorspace"] == colorspace
    assert img["bpc"] == bpc
    if color == "bw":
        assert img["k"] == -1  # CCITT Group 4


def test_jpeg_bytes_are_embedded_without_reencoding(harness: Harness, tmp_path: Path) -> None:
    """The stored stream is a JPEG (DCTDecode), so its bytes start with the JPEG SOI marker."""
    sid = _open(harness, _rich_pdf(tmp_path / "rich.pdf", pages=1))
    harness.op(RASTER, {"dpi": 150, "color": "color", "jpegQuality": 60}, sid)
    assert _image_info(_rev(harness, sid), 0)[0]["head"] == b"\xff\xd8"


# -- content loss ---------------------------------------------------------------------


def test_text_links_annotations_removed(harness: Harness, tmp_path: Path) -> None:
    src = _rich_pdf(tmp_path / "rich.pdf")
    sid = _open(harness, src)
    assert _text(src, 0).strip() != ""
    harness.op(RASTER, {}, sid)
    out = _rev(harness, sid)
    for index in range(_page_count(out)):
        assert _text(out, index).strip() == ""
    with pikepdf.open(out) as pdf:
        for page in pdf.pages:
            assert not page.obj.get("/Annots")


def test_selected_pages_only(harness: Harness, tmp_path: Path) -> None:
    src = _rich_pdf(tmp_path / "rich5.pdf", pages=5)
    sid = _open(harness, src)
    result = harness.op(RASTER, {"pages": [3, 1]}, sid)
    assert result["changedPages"] == [1, 3]
    out = _rev(harness, sid)
    assert _page_count(out) == 5
    for index in range(5):
        text = _text(out, index)
        if index in (1, 3):
            assert text.strip() == ""
        else:
            assert f"Hello text page {index + 1}" in text
    assert _same_sizes(_sizes_pt(out), _sizes_pt(src), 72 / 200 + 1e-3)  # one pixel at 200 dpi


# -- warnings -------------------------------------------------------------------------


def test_scan_loss_warnings_only_for_present_content(
    tmp_path: Path, corpus: dict[str, Path]
) -> None:
    rich = pikepdf.open(_rich_pdf(tmp_path / "rich.pdf"))
    try:
        warnings = scan.scan_loss_warnings(rich)
    finally:
        rich.close()
    assert len(warnings) == 4
    for word in ("text", "link", "bookmark", "form"):
        assert any(word in w.lower() for w in warnings), (word, warnings)

    text_only = pikepdf.open(_text_only_pdf(tmp_path / "plain.pdf"))
    try:
        only_text = scan.scan_loss_warnings(text_only)
    finally:
        text_only.close()
    assert len(only_text) == 1 and "text" in only_text[0].lower()

    with pikepdf.open(corpus["scanned_like.pdf"]) as scanned:
        assert scan.scan_loss_warnings(scanned) == []


def test_warnings_reported_by_op(harness: Harness, tmp_path: Path, corpus: dict[str, Path]) -> None:
    sid = _open(harness, _rich_pdf(tmp_path / "rich.pdf"))
    result = harness.op(RASTER, {}, sid)
    assert len(result["warnings"]) == 4
    sid2 = _open(harness, corpus["scanned_like.pdf"])
    assert harness.op(RASTER, {}, sid2)["warnings"] == []


# -- metadata & undo ------------------------------------------------------------------


def _with_xmp_title(path: Path) -> Path:
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        with pdf.open_metadata() as meta:
            meta["dc:title"] = "Secret title"
        pdf.save(path)
    return path


def test_metadata_stripped_by_default(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _with_xmp_title(_rich_pdf(tmp_path / "rich.pdf")))
    harness.op(RASTER, {}, sid)
    with pikepdf.open(_rev(harness, sid)) as pdf:
        assert "/Info" not in pdf.trailer
        assert "/Metadata" not in pdf.Root


def test_metadata_kept_when_requested(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _with_xmp_title(_rich_pdf(tmp_path / "rich.pdf")))
    harness.op(RASTER, {"stripMetadata": False}, sid)
    with pikepdf.open(_rev(harness, sid)) as pdf:
        # pikepdf mirrors the XMP title into the Info dictionary when the metadata is edited.
        assert str(pdf.docinfo.get("/Title")) == "Secret title"
        assert "/Metadata" in pdf.Root


def test_undo_restores_original(harness: Harness, tmp_path: Path) -> None:
    src = _rich_pdf(tmp_path / "rich.pdf")
    sid = _open(harness, src)
    harness.op(RASTER, {}, sid)
    assert _text(_rev(harness, sid), 0).strip() == ""
    undo = harness.call("session.undo", {"sessionId": sid})
    assert undo["state"]["revision"] == 0
    assert "Hello text page 1" in _text(_rev(harness, sid), 0)


# -- cancellation & pipeline ----------------------------------------------------------


def test_cancelled_mid_run_writes_nothing(tmp_path: Path) -> None:
    src = _rich_pdf(tmp_path / "rich5.pdf", pages=5)
    out = tmp_path / "out.pdf"
    event = threading.Event()

    def sink(done: int, total: int, message: str | None) -> None:
        if done >= 1:
            event.set()

    ctx = _ctx(tmp_path, src, out, event=event, sink=sink)
    spec = get_op(RASTER)
    assert spec is not None
    params = spec.params_model.model_validate({})
    with pytest.raises(CancelledError):
        spec.run(ctx, params)
    assert not out.exists()


@pytest.mark.parametrize(("workers", "pool_min"), [(1, 8), (2, 1)])
def test_inline_and_pool_paths_agree(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, workers: int, pool_min: int
) -> None:
    """Page order and sizes are the same whether rendering runs inline or in the pool."""
    src = _rich_pdf(tmp_path / "rich6.pdf", pages=6)
    monkeypatch.setattr(scan, "MAX_WORKERS", workers)
    monkeypatch.setattr(scan, "POOL_MIN_PAGES", pool_min)
    out = tmp_path / "out.pdf"
    spec = get_op(RASTER)
    assert spec is not None
    spec.run(_ctx(tmp_path, src, out), spec.params_model.model_validate({"dpi": 100}))
    assert _page_count(out) == 6
    assert _same_sizes(_sizes_pt(out), _sizes_pt(src), 1.0)


def test_twenty_pages_at_150dpi_stays_small(harness: Harness, tmp_path: Path) -> None:
    """Pages are streamed through temp files; the result must be a sane size and complete."""
    src = _rich_pdf(tmp_path / "rich20.pdf", pages=20)
    sid = _open(harness, src)
    start = time.monotonic()
    result = harness.op(RASTER, {"dpi": 150, "color": "color"}, sid)
    assert result["state"]["revision"] == 1
    out = _rev(harness, sid)
    assert _page_count(out) == 20
    assert out.stat().st_size < 20 * 1024 * 1024
    assert time.monotonic() - start < 60


# -- rasterize_page helper ------------------------------------------------------------


def test_rasterize_page_sizes_and_modes(tmp_path: Path) -> None:
    src = _text_only_pdf(tmp_path / "plain.pdf", pages=1)
    rgb = rasterize_page(src, 0, 100, "color")
    assert rgb.mode == "RGB"
    assert abs(rgb.width - round(612 * 100 / 72)) <= 1
    assert abs(rgb.height - round(792 * 100 / 72)) <= 1
    assert rasterize_page(src, 0, 100, "gray").mode == "L"
    assert rasterize_page(src, 0, 100, "bw").mode == "1"


def test_rasterize_page_accepts_open_document(tmp_path: Path) -> None:
    src = _text_only_pdf(tmp_path / "plain.pdf", pages=2)
    doc = pdfium.PdfDocument(str(src))
    try:
        img = rasterize_page(doc, 1, 72, "gray")
        assert img.size == (612, 792)
    finally:
        doc.close()


def test_rasterize_page_bw_threshold(tmp_path: Path) -> None:
    src = _gray_page_pdf(tmp_path / "gray.pdf", 0.5)  # about 128 after rendering
    low = rasterize_page(src, 0, 72, "bw", threshold=100).convert("L")
    high = rasterize_page(src, 0, 72, "bw", threshold=200).convert("L")
    assert low.getextrema() == (255, 255)
    assert high.getextrema() == (0, 0)


def test_rasterize_page_bw_dithering(tmp_path: Path) -> None:
    src = _gray_page_pdf(tmp_path / "gray.pdf", 0.5)
    img = rasterize_page(src, 0, 72, "bw", threshold=128, dithering=True).convert("L")
    data = img.tobytes()
    assert set(data) == {0, 255}
    assert 100 < sum(data) / len(data) < 155


def test_rasterize_page_rejects_bad_index(tmp_path: Path) -> None:
    src = _text_only_pdf(tmp_path / "plain.pdf", pages=1)
    with pytest.raises(IndexError):
        rasterize_page(src, 3, 72, "gray")
