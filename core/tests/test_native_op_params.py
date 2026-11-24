"""Tham số mà các hộp thoại M5 của bản Rust gửi cho lõi (TASKS_RUST R5.03 đến R5.08).

`apps/native/crates/chef-app/testdata/op_params.json` là nguồn duy nhất. Test Rust
(`golden_tests.rs`) kiểm builder của hộp thoại dựng đúng JSON đó; file này chạy chính JSON đó trên
lõi thật. Cặp test chứng minh vỏ Rust và lõi đồng ý về dạng tham số.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pikepdf
import pytest
from conftest import Harness, page_count
from test_pageedit import _blank_fixture, _rev, _sid

GOLDEN = (
    Path(__file__).resolve().parents[2]
    / "apps"
    / "native"
    / "crates"
    / "chef-app"
    / "testdata"
    / "op_params.json"
)


def _golden() -> dict[str, dict[str, Any]]:
    data = json.loads(GOLDEN.read_text(encoding="utf-8"))
    return {k: v for k, v in data.items() if not k.startswith("_")}


def _fill(value: Any, paths: dict[str, str]) -> Any:
    """Thay {a}, {b}, {out}, {dir} bằng đường dẫn thật (không đụng {name}, {index}...)."""
    if isinstance(value, str):
        for key, real in paths.items():
            value = value.replace("{" + key + "}", real)
        return value
    if isinstance(value, list):
        return [_fill(v, paths) for v in value]
    if isinstance(value, dict):
        return {k: _fill(v, paths) for k, v in value.items()}
    return value


def _outputs(result: dict[str, Any]) -> list[str]:
    return [str(p) for p in result["outputs"]]


def test_golden_file_covers_every_dialog_operation() -> None:
    ops = {entry["op"] for entry in _golden().values()}
    assert ops == {
        "file.merge",
        "file.split",
        "file.splitSmart",
        "page.crop",
        "page.resize",
        "page.split",
        "page.findBlank",
        "page.removeBlank",
    }


def test_merge_params(harness: Harness, numbered: Callable[[int], Path], tmp_path: Path) -> None:
    a, b = numbered(10), tmp_path / "five.pdf"
    pdf = pikepdf.new()
    for _ in range(5):
        pdf.add_blank_page(page_size=(300, 400))
    pdf.save(b)
    out = tmp_path / "merged.pdf"
    entry = _golden()["merge"]
    result = harness.op(
        entry["op"], _fill(entry["params"], {"a": str(a), "b": str(b), "out": str(out)})
    )
    assert _outputs(result) == [str(out)]
    # 10 trang của a + trang 2 và 3 của b: số trang tổng đúng.
    assert page_count(out) == 12
    # Bookmark theo tên file: mỗi file một mục gốc.
    with pikepdf.open(out) as merged, merged.open_outline() as outline:
        assert [str(item.title) for item in outline.root] == ["numbered_10", "five"]
    # File nguồn không đổi.
    assert page_count(a) == 10
    assert page_count(b) == 5


@pytest.mark.parametrize(
    ("key", "expected_files", "expected_pages"),
    [
        ("split.ranges", 2, [2, 4]),
        ("split.everyN", 3, [2, 2, 2]),
        ("split.oddEven", 2, [3, 3]),
    ],
)
def test_split_params(
    harness: Harness,
    numbered: Callable[[int], Path],
    tmp_path: Path,
    key: str,
    expected_files: int,
    expected_pages: list[int],
) -> None:
    src = numbered(6)
    out_dir = tmp_path / "parts"
    sid = _sid(harness, src)
    entry = _golden()[key]
    result = harness.op(entry["op"], _fill(entry["params"], {"dir": str(out_dir)}), sid)
    files = _outputs(result)
    assert len(files) == expected_files
    assert [page_count(f) for f in files] == expected_pages
    assert page_count(src) == 6


def test_split_max_size_params(
    harness: Harness, numbered: Callable[[int], Path], tmp_path: Path
) -> None:
    src = numbered(6)
    sid = _sid(harness, src)
    entry = _golden()["split.maxSize"]
    result = harness.op(entry["op"], _fill(entry["params"], {"dir": str(tmp_path / "p")}), sid)
    # Mỗi trang rất nhỏ nên 1,5 MB chứa cả tài liệu.
    assert len(_outputs(result)) == 1
    assert page_count(_outputs(result)[0]) == 6


def test_smart_split_params(harness: Harness, corpus: dict[str, Path], tmp_path: Path) -> None:
    blank_src = _blank_fixture(tmp_path / "blank.pdf")
    entry = _golden()["smart.blank"]
    result = harness.op(
        entry["op"], _fill(entry["params"], {"a": str(blank_src), "dir": str(tmp_path / "blank")})
    )
    files = _outputs(result)
    # Trang trắng (1, 2) là dấu phân cách và bị bỏ: còn các trang 0, 3, 4 thành hai file.
    assert len(files) >= 2
    assert sum(page_count(f) for f in files) == 3
    assert all(Path(f).parent == tmp_path / "blank" for f in files)

    outline = corpus["outline_10p.pdf"]
    for key in ("smart.bookmarkLevel", "smart.pattern"):
        entry = _golden()[key]
        result = harness.op(
            entry["op"], _fill(entry["params"], {"a": str(outline), "dir": str(tmp_path / key)})
        )
        assert _outputs(result), key


@pytest.mark.parametrize(
    "key", ["crop.margins", "crop.autoTrim", "crop.box", "resize.a4", "resize.custom"]
)
def test_crop_and_resize_params(
    harness: Harness, numbered: Callable[[int], Path], key: str
) -> None:
    src = numbered(6)
    sid = _sid(harness, src)
    entry = _golden()[key]
    result = harness.op(entry["op"], entry["params"], sid)
    assert result["state"]["canUndo"] is True
    assert result["changedPages"] != []


def test_grid_split_params(harness: Harness, numbered: Callable[[int], Path]) -> None:
    src = numbered(3)
    sid = _sid(harness, src)
    entry = _golden()["grid.split"]
    result = harness.op(entry["op"], entry["params"], sid)
    # Trang đầu thành 2 × 2 = 4 phần: 3 - 1 + 4 = 6 trang.
    assert page_count(_rev(harness, sid)) == 6
    assert result["state"]["canUndo"] is True


def test_blank_page_params(harness: Harness, tmp_path: Path) -> None:
    src = _blank_fixture(tmp_path / "blank2.pdf")
    sid = _sid(harness, src)
    found = harness.op(_golden()["blank.find"]["op"], _golden()["blank.find"]["params"], sid)
    assert found["data"]["candidates"] == [1, 2]
    removed = harness.op(_golden()["blank.remove"]["op"], _golden()["blank.remove"]["params"], sid)
    assert removed["data"]["removed"] == [1, 2]
    assert page_count(_rev(harness, sid)) == 3
