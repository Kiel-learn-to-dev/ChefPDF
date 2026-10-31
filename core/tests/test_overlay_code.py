"""T4.08 ops: overlay.qrCode and overlay.barcode (F10).

The symbols are drawn as vector rectangles. There is no decoder dependency, so the check is
structural: the page is rendered by PDFium at 4 pixels per module (the module is 1 point in these
tests) and the pixel at each module centre is compared with the matrix of segno (QR) or the bit
pattern of python-barcode (Code128, EAN-13, Code 39).
"""

from __future__ import annotations

from pathlib import Path

import barcode
import pikepdf
import pypdfium2 as pdfium
import segno
from conftest import Harness, RpcFailure
from PIL import Image

PX = 4  # pixels per point when rendering
X0, Y0 = 10.0, 10.0  # top-left of the symbol, in points from the top-left of the page


def _blank(path: Path, count: int = 1, size: tuple[int, int] = (300, 400)) -> Path:
    doc = pikepdf.new()
    for _ in range(count):
        doc.add_blank_page(page_size=size)
    doc.save(path)
    return path


def _open(h: Harness, path: Path) -> str:
    return str(h.open(path)["state"]["sessionId"])


def _rev(h: Harness, sid: str) -> Path:
    return Path(h.call("session.state", {"sessionId": sid})["revisionPath"])


def _render(path: Path, index: int = 0) -> Image.Image:
    doc = pdfium.PdfDocument(str(path))
    try:
        return doc[index].render(scale=PX).to_pil().convert("RGB")
    finally:
        doc.close()


def _dark(img: Image.Image, x_pt: float, y_pt: float) -> bool:
    """True when the pixel at a point (from the top-left) is dark."""
    r, g, b = img.getpixel((int((x_pt) * PX), int((y_pt) * PX)))
    return r < 128 and g < 128 and b < 128


def _qr_matrix(content: str, level: str) -> list[list[int]]:
    qr = segno.make(content, error=level, micro=False)
    return [[int(v) for v in row] for row in qr.matrix]


def test_qr_modules_match_the_segno_matrix(harness: Harness, tmp_path: Path) -> None:
    content = "HS-2026/0001"
    matrix = _qr_matrix(content, "M")
    n = len(matrix)
    quiet = 4
    sid = _open(harness, _blank(tmp_path / "qr.pdf"))
    result = harness.op(
        "overlay.qrCode",
        {
            "content": content,
            "errorCorrection": "M",
            "quietZone": quiet,
            "size": n + 2 * quiet,
            "unit": "pt",
            "x": X0,
            "y": Y0,
        },
        sid,
    )
    assert result["changedPages"] == [0]
    img = _render(_rev(harness, sid))
    m = 1.0  # one module per point
    for r in range(n):
        for c in range(n):
            cx = X0 + (quiet + c + 0.5) * m
            cy = Y0 + (quiet + r + 0.5) * m
            assert _dark(img, cx, cy) == bool(matrix[r][c]), (r, c)
    # The quiet zone stays white.
    assert not _dark(img, X0 + 1, Y0 + 1)


def test_qr_is_tagged_as_qr_and_listed(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "qrtag.pdf"))
    harness.op(
        "overlay.qrCode", {"content": "https://example.com/hs/1", "size": 20, "x": 5, "y": 5}, sid
    )
    listed = harness.op("overlay.listOverlays", {}, sid)["data"]["overlays"]
    assert [o["kind"] for o in listed] == ["qr"]
    with pikepdf.open(_rev(harness, sid)) as doc:
        contents = doc.pages[0].obj.Contents
        streams = list(contents) if isinstance(contents, pikepdf.Array) else [contents]
        raw = b"\n".join(bytes(s.read_bytes()) for s in streams)
    assert b"/Kind (qr)" in raw


def test_qr_background_fills_the_quiet_zone(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "qrbg.pdf"))
    harness.op(
        "overlay.qrCode",
        {"content": "AB", "size": 40, "unit": "pt", "x": X0, "y": Y0, "background": "#FFFF00"},
        sid,
    )
    img = _render(_rev(harness, sid))
    r, g, b = img.getpixel((int((X0 + 1) * PX), int((Y0 + 1) * PX)))
    assert r > 200 and g > 200 and b < 80


def test_qr_template_variables_are_filled_per_page(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "qrvar.pdf", 2))
    result = harness.op(
        "overlay.qrCode",
        {"content": "HS-{page}", "size": 40, "unit": "pt", "x": X0, "y": Y0},
        sid,
    )
    assert result["changedPages"] == [0, 1]
    rev = _rev(harness, sid)
    first = _render(rev, 0).tobytes()
    second = _render(rev, 1).tobytes()
    assert first != second


def test_qr_content_too_long_for_the_level_is_invalid(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "long.pdf"))
    try:
        harness.op("overlay.qrCode", {"content": "x" * 2000, "errorCorrection": "H"}, sid)
    except RpcFailure as exc:
        assert exc.code == -32602
    else:  # pragma: no cover - the op must refuse
        raise AssertionError("expected INVALID_PARAMS")


def _bar_check(img: Image.Image, bits: str, x: float, y: float, bar_h: float) -> None:
    """Each module of ``bits`` (1 = bar) is 1 point wide; sample the middle of each module."""
    for j, bit in enumerate(bits):
        assert _dark(img, x + j + 0.5, y + bar_h / 2) == (bit == "1"), j


def test_code128_bars_match_python_barcode(harness: Harness, tmp_path: Path) -> None:
    content = "HS-000001"
    bits = barcode.get("code128", content).build()[0]
    quiet = 10
    sid = _open(harness, _blank(tmp_path / "c128.pdf"))
    harness.op(
        "overlay.barcode",
        {
            "kind": "code128",
            "content": content,
            "moduleWidth": 1,
            "height": 20,
            "quietZone": quiet,
            "unit": "pt",
            "x": X0,
            "y": Y0,
        },
        sid,
    )
    img = _render(_rev(harness, sid))
    _bar_check(img, bits, X0 + quiet, Y0, 20)
    assert not _dark(img, X0 + 2, Y0 + 10)


def test_ean13_adds_its_check_digit(harness: Harness, tmp_path: Path) -> None:
    bits = barcode.get("ean13", "590123412345").build()[0]
    sid = _open(harness, _blank(tmp_path / "ean.pdf"))
    harness.op(
        "overlay.barcode",
        {
            "kind": "ean13",
            "content": "590123412345",
            "moduleWidth": 1,
            "height": 20,
            "quietZone": 10,
            "unit": "pt",
            "x": X0,
            "y": Y0,
        },
        sid,
    )
    img = _render(_rev(harness, sid))
    _bar_check(img, bits, X0 + 10, Y0, 20)
    assert len(bits) == 95


def test_code39_bars_match_python_barcode(harness: Harness, tmp_path: Path) -> None:
    bits = barcode.get("code39", "HS-1", options={"add_checksum": False}).build()[0]
    sid = _open(harness, _blank(tmp_path / "c39.pdf"))
    harness.op(
        "overlay.barcode",
        {
            "kind": "code39",
            "content": "HS-1",
            "moduleWidth": 1,
            "height": 15,
            "unit": "pt",
            "x": X0,
            "y": Y0,
            "quietZone": 10,
        },
        sid,
    )
    img = _render(_rev(harness, sid))
    _bar_check(img, bits, X0 + 10, Y0, 15)


def test_barcode_label_sits_under_the_bars(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "label.pdf"))
    harness.op(
        "overlay.barcode",
        {
            "kind": "code128",
            "content": "HS-000001",
            "moduleWidth": 1,
            "height": 20,
            "unit": "pt",
            "x": X0,
            "y": Y0,
            "label": "Số hồ sơ {page}",
        },
        sid,
    )
    doc = pdfium.PdfDocument(str(_rev(harness, sid)))
    try:
        below = doc[0].get_textpage().get_text_bounded(0, 400 - 80, 300, 400 - 30)
    finally:
        doc.close()
    assert "Số hồ sơ 1" in str(below)


def test_barcode_rejects_characters_the_kind_cannot_encode(
    harness: Harness, tmp_path: Path
) -> None:
    sid = _open(harness, _blank(tmp_path / "bad.pdf"))
    try:
        harness.op("overlay.barcode", {"kind": "code128", "content": "Hồ sơ"}, sid)
    except RpcFailure as exc:
        assert exc.code == -32602
    else:  # pragma: no cover
        raise AssertionError("expected INVALID_PARAMS")


def test_barcode_ean13_needs_twelve_or_thirteen_digits(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _blank(tmp_path / "ean-bad.pdf"))
    try:
        harness.op("overlay.barcode", {"kind": "ean13", "content": "12345"}, sid)
    except RpcFailure as exc:
        assert exc.code == -32602
    else:  # pragma: no cover
        raise AssertionError("expected INVALID_PARAMS")
