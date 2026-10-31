"""Page operations: rotate, delete, duplicate, reorder, extract, insert*."""

from __future__ import annotations

import base64
from collections.abc import Callable
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium
import pytest
from conftest import Harness, RpcFailure, page_count, page_widths

from chef_core.pdf.outline import read_bookmarks
from chef_core.pdf.pages import page_objgen_index


def _open(h: Harness, path: Path, password: str | None = None) -> tuple[str, dict[str, object]]:
    opened = h.open(path, password)
    return opened["state"]["sessionId"], opened["state"]


def _rev(h: Harness, sid: str) -> Path:
    return Path(h.call("session.state", {"sessionId": sid})["revisionPath"])


def _bookmarks(path: Path) -> list[tuple[str, int | None, list[tuple[str, int | None]]]]:
    """[(title, page index, [(child title, child page index)])]."""
    with pikepdf.open(path) as pdf:
        index = page_objgen_index(pdf)
        return [
            (
                bm.title,
                index.get(bm.page) if bm.page else None,
                [(c.title, index.get(c.page) if c.page else None) for c in bm.children],
            )
            for bm in read_bookmarks(pdf)
        ]


def _rotations(path: Path) -> list[int]:
    with pikepdf.open(path) as pdf:
        return [int(p.rotation) % 360 for p in pdf.pages]


# -- rotate ---------------------------------------------------------------------------


def test_rotate(harness: Harness, numbered: Callable[[int], Path]) -> None:
    sid, _ = _open(harness, numbered(4))
    result = harness.op("page.rotate", {"pages": [2, 0, 2], "angle": 90}, sid)
    assert result["changedPages"] == [0, 2]
    assert result["state"]["revision"] == 1
    assert _rotations(_rev(harness, sid)) == [90, 0, 90, 0]
    harness.op("page.rotate", {"pages": [0], "angle": 270}, sid)
    harness.op("page.rotate", {"pages": [3], "angle": 180}, sid)
    assert _rotations(_rev(harness, sid)) == [0, 0, 90, 180]


def test_rotate_inherited(harness: Harness, corpus: dict[str, Path]) -> None:
    sid, _ = _open(harness, corpus["inherited_rotate.pdf"])
    harness.op("page.rotate", {"pages": [1], "angle": 90}, sid)
    assert _rotations(_rev(harness, sid)) == [90, 180, 90]


def test_rotate_invalid(harness: Harness, numbered: Callable[[int], Path]) -> None:
    sid, _ = _open(harness, numbered(2))
    with pytest.raises(RpcFailure) as exc:
        harness.call(
            "ops.run",
            {"sessionId": sid, "opId": "page.rotate", "params": {"pages": [0], "angle": 45}},
        )
    assert exc.value.code == -32602 and exc.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as exc:
        harness.op("page.rotate", {"pages": [5], "angle": 90}, sid)
    assert exc.value.kind == "INVALID_PARAMS"


# -- delete ---------------------------------------------------------------------------


def test_delete(harness: Harness, numbered: Callable[[int], Path]) -> None:
    sid, _ = _open(harness, numbered(5))
    result = harness.op("page.delete", {"pages": [3, 1]}, sid)
    assert result["changedPages"] == "all"
    assert page_widths(_rev(harness, sid)) == [100, 102, 104]


def test_delete_all_pages_refused(harness: Harness, numbered: Callable[[int], Path]) -> None:
    sid, _ = _open(harness, numbered(2))
    with pytest.raises(RpcFailure) as exc:
        harness.op("page.delete", {"pages": [0, 1]}, sid)
    assert exc.value.kind == "INVALID_PARAMS"
    assert harness.call("session.state", {"sessionId": sid})["revision"] == 0


def test_delete_keeps_outline(harness: Harness, corpus: dict[str, Path]) -> None:
    sid, _ = _open(harness, corpus["outline_10p.pdf"])
    assert _bookmarks(_rev(harness, sid)) == [
        ("Chương 1", 0, [("Mục 1.1", 1), ("Mục 1.2", 2)]),
        ("Chương 2", 4, []),
        ("Chương 3", 7, []),
    ]
    harness.op("page.delete", {"pages": [1, 4]}, sid)
    # "Mục 1.1" and "Chương 2" pointed at deleted pages; the rest is shifted.
    assert _bookmarks(_rev(harness, sid)) == [
        ("Chương 1", 0, [("Mục 1.2", 1)]),
        ("Chương 3", 5, []),
    ]


# -- duplicate ------------------------------------------------------------------------


def test_duplicate(harness: Harness, numbered: Callable[[int], Path]) -> None:
    sid, _ = _open(harness, numbered(3))
    harness.op("page.duplicate", {"pages": [2, 0]}, sid)
    rev = _rev(harness, sid)
    assert page_widths(rev) == [100, 100, 101, 102, 102]
    with pikepdf.open(rev) as pdf:
        objgens = {p.obj.objgen for p in pdf.pages}
        assert len(objgens) == 5  # copies are distinct page objects


# -- reorder --------------------------------------------------------------------------


def test_reorder(harness: Harness, numbered: Callable[[int], Path]) -> None:
    sid, _ = _open(harness, numbered(4))
    harness.op("page.reorder", {"order": [2, 0, 3, 1]}, sid)
    assert page_widths(_rev(harness, sid)) == [102, 100, 103, 101]


@pytest.mark.parametrize("order", [[0, 1], [0, 0, 1], [0, 1, 3], [2, 1, 0, 0]])
def test_reorder_rejects_non_permutation(
    harness: Harness, numbered: Callable[[int], Path], order: list[int]
) -> None:
    sid, _ = _open(harness, numbered(3))
    with pytest.raises(RpcFailure) as exc:
        harness.op("page.reorder", {"order": order}, sid)
    assert exc.value.kind == "INVALID_PARAMS"


def test_reorder_keeps_outline(harness: Harness, corpus: dict[str, Path]) -> None:
    sid, _ = _open(harness, corpus["outline_10p.pdf"])
    harness.op("page.reorder", {"order": list(range(9, -1, -1))}, sid)
    assert _bookmarks(_rev(harness, sid)) == [
        ("Chương 1", 9, [("Mục 1.1", 8), ("Mục 1.2", 7)]),
        ("Chương 2", 5, []),
        ("Chương 3", 2, []),
    ]


def test_reorder_keeps_inherited_attributes(harness: Harness, corpus: dict[str, Path]) -> None:
    sid, _ = _open(harness, corpus["inherited_rotate.pdf"])
    harness.op("page.reorder", {"order": [2, 1, 0]}, sid)
    info = harness.call("session.info", {"sessionId": sid})
    assert [p["rotation"] for p in info["pages"]] == [90, 90, 90]
    assert {(p["width"], p["height"]) for p in info["pages"]} == {(600.0, 400.0)}
    with pikepdf.open(_rev(harness, sid)) as pdf:
        assert all("/F1" in p.resources.Font for p in pdf.pages)


# -- extract --------------------------------------------------------------------------


def test_extract(harness: Harness, numbered: Callable[[int], Path], tmp_path: Path) -> None:
    sid, _ = _open(harness, numbered(4))
    out = tmp_path / "out" / "extract.pdf"
    out.parent.mkdir()
    result = harness.op("page.extract", {"pages": [3, 1], "outputPath": str(out)}, sid)
    assert result["outputs"] == [str(out)]
    assert result["changedPages"] == []
    assert result["state"]["revision"] == 0 and not result["state"]["dirty"]
    assert page_widths(out) == [103, 101]
    assert page_widths(_rev(harness, sid)) == [100, 101, 102, 103]


def test_extract_keeps_relevant_bookmarks(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path
) -> None:
    sid, _ = _open(harness, corpus["outline_10p.pdf"])
    out = tmp_path / "chapter2.pdf"
    harness.op("page.extract", {"pages": [4, 5, 6], "outputPath": str(out)}, sid)
    assert page_count(out) == 3
    assert _bookmarks(out) == [("Chương 2", 0, [])]


def test_extract_missing_dir(
    harness: Harness, numbered: Callable[[int], Path], tmp_path: Path
) -> None:
    sid, _ = _open(harness, numbered(2))
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "page.extract", {"pages": [0], "outputPath": str(tmp_path / "no" / "x.pdf")}, sid
        )
    assert exc.value.kind == "FILE_NOT_FOUND"


# -- insertBlank ----------------------------------------------------------------------


def test_insert_blank(harness: Harness, corpus: dict[str, Path]) -> None:
    sid, _ = _open(harness, corpus["mixed_sizes.pdf"])
    harness.op("page.insertBlank", {"at": 2, "count": 2}, sid)
    info = harness.call("session.info", {"sessionId": sid})
    assert info["pageCount"] == 8
    # Same displayed size as the page before (A4 landscape).
    assert [(p["width"], p["height"]) for p in info["pages"][2:4]] == [(841.89, 595.276)] * 2
    harness.op("page.insertBlank", {"at": 0, "count": 1}, sid)
    harness.op("page.insertBlank", {"at": 9, "count": 1, "width": 200, "height": 300}, sid)
    info = harness.call("session.info", {"sessionId": sid})
    assert info["pageCount"] == 10
    assert (info["pages"][0]["width"], info["pages"][0]["height"]) == (595.276, 841.89)
    assert (info["pages"][9]["width"], info["pages"][9]["height"]) == (200.0, 300.0)


def test_insert_blank_bad_position(harness: Harness, numbered: Callable[[int], Path]) -> None:
    sid, _ = _open(harness, numbered(2))
    with pytest.raises(RpcFailure) as exc:
        harness.op("page.insertBlank", {"at": 3, "count": 1}, sid)
    assert exc.value.kind == "INVALID_PARAMS"


def test_insert_blank_into_new_document(harness: Harness, tmp_path: Path) -> None:
    created = harness.call("session.create", {})
    assert created["info"]["pageCount"] == 0
    sid = created["state"]["sessionId"]
    harness.op("page.insertBlank", {"at": 0, "count": 3}, sid)
    info = harness.call("session.info", {"sessionId": sid})
    assert info["pageCount"] == 3
    assert (info["pages"][0]["width"], info["pages"][0]["height"]) == (595.276, 841.89)


# -- insertFromFile -------------------------------------------------------------------


def test_insert_from_file(
    harness: Harness, numbered: Callable[[int], Path], corpus: dict[str, Path]
) -> None:
    sid, _ = _open(harness, numbered(3))
    harness.op(
        "page.insertFromFile",
        {"at": 1, "path": str(corpus["mixed_sizes.pdf"]), "pages": [2, 1]},
        sid,
    )
    assert page_widths(_rev(harness, sid)) == [100, 612, 842, 101, 102]
    harness.op("page.insertFromFile", {"at": 5, "path": str(corpus["outline_10p.pdf"])}, sid)
    assert page_count(_rev(harness, sid)) == 15


def test_insert_from_encrypted_file(
    harness: Harness, numbered: Callable[[int], Path], corpus: dict[str, Path]
) -> None:
    sid, _ = _open(harness, numbered(1))
    path = str(corpus["encrypted_1234.pdf"])
    with pytest.raises(RpcFailure) as exc:
        harness.op("page.insertFromFile", {"at": 0, "path": path}, sid)
    assert exc.value.kind == "PASSWORD_REQUIRED"
    with pytest.raises(RpcFailure) as exc:
        harness.op("page.insertFromFile", {"at": 0, "path": path, "password": "nope"}, sid)
    assert exc.value.kind == "PASSWORD_INVALID"
    harness.op("page.insertFromFile", {"at": 0, "path": path, "password": "1234"}, sid)
    rev = _rev(harness, sid)
    assert page_count(rev) == 4
    with pikepdf.open(rev) as pdf:
        assert not pdf.is_encrypted


def test_insert_from_missing_or_corrupt_file(
    harness: Harness, numbered: Callable[[int], Path], corpus: dict[str, Path], tmp_path: Path
) -> None:
    sid, _ = _open(harness, numbered(1))
    with pytest.raises(RpcFailure) as exc:
        harness.op("page.insertFromFile", {"at": 0, "path": str(tmp_path / "missing.pdf")}, sid)
    assert exc.value.kind == "FILE_NOT_FOUND"
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "page.insertFromFile", {"at": 0, "path": str(corpus["corrupt_garbage.pdf"])}, sid
        )
    assert exc.value.kind == "INVALID_PDF"


# -- insertImages ---------------------------------------------------------------------


def _render(path: Path, index: int) -> tuple[int, int, Callable[[float, float], tuple[int, ...]]]:
    """Render page ``index``; return (w, h, pixel(fx, fy)) with fractional coordinates."""
    doc = pdfium.PdfDocument(str(path))
    try:
        image = doc[index].render(scale=1).to_pil().convert("RGB")
    finally:
        doc.close()
    w, h = image.size

    def pixel(fx: float, fy: float) -> tuple[int, ...]:
        value = image.getpixel((min(int(fx * w), w - 1), min(int(fy * h), h - 1)))
        assert isinstance(value, tuple)
        return value

    return w, h, pixel


def _is_red(px: tuple[int, ...]) -> bool:
    return px[0] > 200 and px[1] < 80 and px[2] < 80


def _is_blue(px: tuple[int, ...]) -> bool:
    return px[2] > 200 and px[0] < 80 and px[1] < 80


def test_insert_image_exif_rotation(
    harness: Harness, numbered: Callable[[int], Path], corpus: dict[str, Path]
) -> None:
    sid, _ = _open(harness, numbered(1))
    jpg = corpus["photo_exif6.jpg"]
    harness.op(
        "page.insertImages",
        {"at": 1, "images": [{"path": str(jpg)}], "pageSize": "image", "margin": 0},
        sid,
    )
    rev = _rev(harness, sid)
    info = harness.call("session.info", {"sessionId": sid})
    page = info["pages"][1]
    assert page["rotation"] == 0
    assert page["height"] == pytest.approx(page["width"] * 2, rel=0.01)  # 200×400 displayed
    w, h, px = _render(rev, 1)
    assert h > w
    # Stored top rows (red) must appear on the right after orientation 6 (90° CW).
    assert _is_red(px(0.95, 0.5)) and not _is_red(px(0.05, 0.5))
    # Stored left columns (blue) must appear at the top.
    assert _is_blue(px(0.5, 0.05))
    # The JPEG is embedded as-is (no re-encoding).
    with pikepdf.open(rev) as pdf:
        xobj = next(iter(pdf.pages[1].get_images().values()))
        assert xobj.Filter == pikepdf.Name.DCTDecode
        assert xobj.read_raw_bytes() == jpg.read_bytes()


def test_insert_image_mirrored_on_a4(
    harness: Harness, numbered: Callable[[int], Path], corpus: dict[str, Path]
) -> None:
    sid, _ = _open(harness, numbered(1))
    harness.op(
        "page.insertImages",
        {
            "at": 0,
            "images": [{"path": str(corpus["photo_exif2.jpg"])}],
            "pageSize": "a4",
            "margin": 36,
        },
        sid,
    )
    info = harness.call("session.info", {"sessionId": sid})
    # Landscape image (400×200) → landscape A4 page.
    assert (info["pages"][0]["width"], info["pages"][0]["height"]) == (841.89, 595.276)
    _, _, px = _render(_rev(harness, sid), 0)
    # Orientation 2 mirrors horizontally: stored left (blue) shows on the right.
    assert _is_blue(px(0.9, 0.6)) and not _is_blue(px(0.1, 0.6))
    assert _is_red(px(0.5, 0.22)) and px(0.5, 0.1) == (255, 255, 255)
    # Margin is kept white.
    assert px(0.01, 0.5) == (255, 255, 255)


def test_insert_images_letter_alpha_and_data_url(
    harness: Harness, numbered: Callable[[int], Path], corpus: dict[str, Path]
) -> None:
    sid, _ = _open(harness, numbered(2))
    png = corpus["logo_alpha.png"].read_bytes()
    data_url = "data:image/png;base64," + base64.b64encode(png).decode()
    harness.op(
        "page.insertImages",
        {
            "at": 1,
            "images": [{"path": str(corpus["logo_alpha.png"])}, {"dataUrl": data_url}],
            "pageSize": "letter",
            "margin": 18,
        },
        sid,
    )
    info = harness.call("session.info", {"sessionId": sid})
    assert info["pageCount"] == 4
    assert (info["pages"][1]["width"], info["pages"][1]["height"]) == (792.0, 612.0)
    assert page_widths(_rev(harness, sid))[0] == 100 and page_widths(_rev(harness, sid))[3] == 101
    _, _, px = _render(_rev(harness, sid), 2)
    assert px(0.5, 0.5)[1] > 100 and px(0.5, 0.5)[0] < 60  # green ellipse
    assert px(0.03, 0.03) == (255, 255, 255)  # transparent corner flattened on white


def test_insert_images_errors(
    harness: Harness, numbered: Callable[[int], Path], corpus: dict[str, Path], tmp_path: Path
) -> None:
    sid, _ = _open(harness, numbered(1))
    base = {"at": 0, "pageSize": "image", "margin": 0}
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "page.insertImages", {**base, "images": [{"path": str(tmp_path / "x.jpg")}]}, sid
        )
    assert exc.value.kind == "FILE_NOT_FOUND"
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "page.insertImages",
            {**base, "images": [{"path": str(corpus["corrupt_garbage.pdf"])}]},
            sid,
        )
    assert exc.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as exc:
        harness.op("page.insertImages", {**base, "images": [{"dataUrl": "not-a-data-url"}]}, sid)
    assert exc.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as exc:
        harness.call(
            "ops.run",
            {
                "sessionId": sid,
                "opId": "page.insertImages",
                "params": {**base, "images": [{"url": "x"}]},
            },
        )
    assert exc.value.code == -32602
    assert harness.call("session.state", {"sessionId": sid})["revision"] == 0
