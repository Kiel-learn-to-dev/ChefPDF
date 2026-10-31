"""file.merge and file.split."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import pikepdf
import pytest
from conftest import Harness, RpcFailure, page_count, page_widths

from chef_core.ops.file import Part, parse_ranges, render_name
from chef_core.pdf.outline import read_bookmarks
from chef_core.pdf.pages import page_objgen_index


def _tree(path: Path) -> list[tuple[str, int | None, list[str]]]:
    with pikepdf.open(path) as pdf:
        index = page_objgen_index(pdf)
        return [
            (bm.title, index.get(bm.page) if bm.page else None, [c.title for c in bm.children])
            for bm in read_bookmarks(pdf)
        ]


# -- merge ----------------------------------------------------------------------------


def test_merge_with_filename_bookmarks(
    harness: Harness, numbered: Callable[[int], Path], corpus: dict[str, Path], tmp_path: Path
) -> None:
    out = tmp_path / "merged.pdf"
    params = {
        "inputs": [
            {"path": str(numbered(3))},
            {"path": str(corpus["mixed_sizes.pdf"]), "pages": [2]},
            {"path": str(corpus["encrypted_1234.pdf"]), "password": "1234"},
            {"path": str(corpus["outline_10p.pdf"])},
        ],
        "outputPath": str(out),
        "bookmarksFromFilenames": True,
    }
    result = harness.op("file.merge", params)  # standalone: no sessionId
    assert result["outputs"] == [str(out)]
    assert result["state"] is None
    assert page_count(out) == 3 + 1 + 3 + 10
    assert page_widths(out)[:4] == [100, 101, 102, 612]
    assert _tree(out) == [
        ("numbered_3", 0, []),
        ("mixed_sizes", 3, []),
        ("encrypted_1234", 4, []),
        ("outline_10p", 7, ["Chương 1", "Chương 2", "Chương 3"]),
    ]
    with pikepdf.open(out) as pdf:
        assert not pdf.is_encrypted


def test_merge_keeps_original_bookmarks(
    harness: Harness, numbered: Callable[[int], Path], corpus: dict[str, Path], tmp_path: Path
) -> None:
    out = tmp_path / "merged.pdf"
    harness.op(
        "file.merge",
        {
            "inputs": [{"path": str(numbered(2))}, {"path": str(corpus["outline_10p.pdf"])}],
            "outputPath": str(out),
            "bookmarksFromFilenames": False,
        },
    )
    assert _tree(out) == [
        ("Chương 1", 2, ["Mục 1.1", "Mục 1.2"]),
        ("Chương 2", 6, []),
        ("Chương 3", 9, []),
    ]


def test_merge_errors(harness: Harness, corpus: dict[str, Path], tmp_path: Path) -> None:
    out = tmp_path / "merged.pdf"
    params: dict[str, Any] = {
        "inputs": [
            {"path": str(corpus["outline_10p.pdf"])},
            {"path": str(corpus["encrypted_1234.pdf"])},
        ],
        "outputPath": str(out),
        "bookmarksFromFilenames": True,
    }
    with pytest.raises(RpcFailure) as exc:
        harness.op("file.merge", params)
    assert exc.value.kind == "PASSWORD_REQUIRED"
    assert exc.value.detail["inputIndex"] == 1
    assert not out.exists()
    params["inputs"] = [{"path": str(corpus["outline_10p.pdf"]), "pages": [10]}]
    with pytest.raises(RpcFailure) as exc:
        harness.op("file.merge", params)
    assert exc.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as exc:
        harness.call("ops.run", {"opId": "file.merge", "params": {"inputs": [], "outputPath": "x"}})
    assert exc.value.code == -32602


def test_merge_can_overwrite_an_input(
    harness: Harness, numbered: Callable[[int], Path], tmp_path: Path
) -> None:
    a = numbered(2)
    b = numbered(3)
    harness.op(
        "file.merge",
        {
            "inputs": [{"path": str(a)}, {"path": str(b)}],
            "outputPath": str(a),
            "bookmarksFromFilenames": False,
        },
    )
    assert page_widths(a) == [100, 101, 100, 101, 102]


# -- split ----------------------------------------------------------------------------


def _split(h: Harness, path: Path, out_dir: Path, **params: Any) -> dict[str, Any]:
    sid = h.open(path)["state"]["sessionId"]
    result = h.op("file.split", {"outputDir": str(out_dir), **params}, sid)
    assert result["state"]["revision"] == 0
    return result


def test_split_ranges(harness: Harness, corpus: dict[str, Path], tmp_path: Path) -> None:
    result = _split(
        harness, corpus["outline_10p.pdf"], tmp_path / "out", mode="ranges", ranges="1-3, 5,7-"
    )
    names = [Path(p).name for p in result["outputs"]]
    assert names == ["outline_10p_1.pdf", "outline_10p_2.pdf", "outline_10p_3.pdf"]
    assert [page_count(p) for p in result["outputs"]] == [3, 1, 4]
    # Bookmarks of the copied pages come along.
    assert _tree(Path(result["outputs"][0])) == [("Chương 1", 0, ["Mục 1.1", "Mục 1.2"])]


def test_split_ranges_template(
    harness: Harness, numbered: Callable[[int], Path], tmp_path: Path
) -> None:
    result = _split(
        harness,
        numbered(6),
        tmp_path,
        mode="ranges",
        ranges="4-6,1-2",
        nameTemplate="{name} p{start}-{end} ({index})",
    )
    assert [Path(p).name for p in result["outputs"]] == [
        "numbered_6 p4-6 (1).pdf",
        "numbered_6 p1-2 (2).pdf",
    ]
    assert page_widths(result["outputs"][0]) == [103, 104, 105]


@pytest.mark.parametrize("ranges", ["0-2", "abc", "5-20", "2-x", ",,"])
def test_split_bad_ranges(
    harness: Harness, numbered: Callable[[int], Path], tmp_path: Path, ranges: str
) -> None:
    sid = harness.open(numbered(6))["state"]["sessionId"]
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "file.split", {"mode": "ranges", "ranges": ranges, "outputDir": str(tmp_path)}, sid
        )
    assert exc.value.kind == "INVALID_PARAMS"


def test_split_mode_params_required(
    harness: Harness, numbered: Callable[[int], Path], tmp_path: Path
) -> None:
    sid = harness.open(numbered(2))["state"]["sessionId"]
    for mode in ("ranges", "everyN", "maxSize"):
        with pytest.raises(RpcFailure) as exc:
            harness.call(
                "ops.run",
                {
                    "sessionId": sid,
                    "opId": "file.split",
                    "params": {"mode": mode, "outputDir": str(tmp_path)},
                },
            )
        assert exc.value.code == -32602 and exc.value.kind == "INVALID_PARAMS"


def test_split_every_n(harness: Harness, numbered: Callable[[int], Path], tmp_path: Path) -> None:
    result = _split(harness, numbered(10), tmp_path / "a", mode="everyN", n=4)
    assert [page_count(p) for p in result["outputs"]] == [4, 4, 2]
    assert Path(result["outputs"][2]).name == "numbered_10_3.pdf"
    result = _split(harness, numbered(10), tmp_path / "b", mode="everyN", n=1)
    names = [Path(p).name for p in result["outputs"]]
    assert names[0] == "numbered_10_01.pdf" and names[-1] == "numbered_10_10.pdf"
    assert page_widths(result["outputs"][9]) == [109]


def test_split_by_bookmarks(harness: Harness, corpus: dict[str, Path], tmp_path: Path) -> None:
    result = _split(
        harness,
        corpus["outline_10p.pdf"],
        tmp_path,
        mode="bookmarks",
        nameTemplate="{index}_{start}-{end}",
    )
    assert [Path(p).name for p in result["outputs"]] == ["1_1-4.pdf", "2_5-7.pdf", "3_8-10.pdf"]
    assert [page_count(p) for p in result["outputs"]] == [4, 3, 3]


def test_split_by_bookmarks_without_outline(
    harness: Harness, numbered: Callable[[int], Path], tmp_path: Path
) -> None:
    result = _split(harness, numbered(3), tmp_path, mode="bookmarks")
    assert len(result["outputs"]) == 1 and result["warnings"]


def test_split_max_size(harness: Harness, corpus: dict[str, Path], tmp_path: Path) -> None:
    limit = 100_000
    result = _split(
        harness, corpus["images_8p.pdf"], tmp_path / "a", mode="maxSize", maxBytes=limit
    )
    counts = [page_count(p) for p in result["outputs"]]
    assert sum(counts) == 8 and len(counts) > 1
    assert all(Path(p).stat().st_size <= limit for p in result["outputs"])
    assert not result["warnings"]
    # Greedy: adding the next page to any part would exceed the limit.
    assert max(counts) >= 2

    result = _split(harness, corpus["images_8p.pdf"], tmp_path / "b", mode="maxSize", maxBytes=1000)
    assert len(result["outputs"]) == 8 and result["warnings"]

    result = _split(
        harness, corpus["images_8p.pdf"], tmp_path / "c", mode="maxSize", maxBytes=50_000_000
    )
    assert [page_count(p) for p in result["outputs"]] == [8]


def test_split_odd_even(harness: Harness, numbered: Callable[[int], Path], tmp_path: Path) -> None:
    result = _split(harness, numbered(5), tmp_path, mode="oddEven")
    assert [page_widths(p) for p in result["outputs"]] == [[100, 102, 104], [101, 103]]
    result = _split(harness, numbered(1), tmp_path / "single", mode="oddEven")
    assert len(result["outputs"]) == 1 and result["warnings"]


def test_split_creates_output_dir(
    harness: Harness, numbered: Callable[[int], Path], tmp_path: Path
) -> None:
    out = tmp_path / "deep" / "er"
    result = _split(harness, numbered(2), out, mode="everyN", n=1)
    assert all(Path(p).parent == out for p in result["outputs"])


def test_parse_ranges_unit() -> None:
    assert [p.pages for p in parse_ranges("1-3,5,7-", 9)] == [[0, 1, 2], [4], [6, 7, 8]]
    assert [p.pages for p in parse_ranges("3-1", 5)] == [[2, 1, 0]]


def test_render_name_unit() -> None:
    part = Part([4, 5, 6])
    assert render_name("{name}_{index}", name="a", index=3, total=120, part=part) == "a_003.pdf"
    assert render_name("{start}-{end}.PDF", name="a", index=1, total=1, part=part) == "5-7.PDF"
    assert render_name("x/y:{name}", name="a", index=1, total=1, part=part) == "x_y_a.pdf"
    assert render_name("{unknown}", name="a", index=1, total=1, part=part) == "{unknown}.pdf"
