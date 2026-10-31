"""T4.03 ops (D3): bookmarks.get, bookmarks.set, bookmarks.fromPages, bookmarks.clear.

Titles with Vietnamese diacritics must survive the round trip through the outline and the file.
Changes go through the session, so undo and redo work like for any other operation.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pikepdf
import pytest
from conftest import Harness, RpcFailure
from pikepdf import OutlineItem, OutlineItemFlag

TITLE_A = "Phần I — Giới thiệu chung"
TITLE_B = "Mục 1.1 Đối tượng áp dụng"
TITLE_C = "Phụ lục: Biểu mẫu số 01/NĐ-CP"


def _pdf(path: Path, pages: int, *, outline: bool = False) -> Path:
    doc = pikepdf.new()
    for _ in range(pages):
        doc.add_blank_page(page_size=(300, 400))
    if outline:
        with doc.open_outline() as root:
            first = OutlineItem(TITLE_A, 0, color=(1.0, 0.0, 0.0), flags=OutlineItemFlag.Bold)
            first.children.append(OutlineItem(TITLE_B, 1))
            root.root.append(first)
            root.root.append(OutlineItem(TITLE_C, 2))
    doc.save(path)
    return path


def _open(h: Harness, path: Path) -> str:
    return str(h.open(path)["state"]["sessionId"])


def _rev(h: Harness, sid: str) -> Path:
    return Path(h.call("session.state", {"sessionId": sid})["revisionPath"])


def _get(h: Harness, sid: str) -> list[dict[str, Any]]:
    return list(h.op("bookmarks.get", {}, sid)["data"]["bookmarks"])


SAMPLE: list[dict[str, Any]] = [
    {
        "title": "Chương 1 — Đặt vấn đề",
        "page": 0,
        "open": False,
        "color": "#0055AA",
        "bold": True,
        "children": [
            {
                "title": "1.1 Bối cảnh",
                "page": 1,
                "view": {"type": "xyz", "left": 0, "top": 400, "zoom": 1.5},
                "italic": True,
                "children": [],
            }
        ],
    },
    {"title": "Phụ lục A — Biểu mẫu", "page": 2, "children": []},
]


def test_get_reads_titles_pages_children_and_style(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _pdf(tmp_path / "read.pdf", 3, outline=True))
    result = harness.op("bookmarks.get", {}, sid)
    assert result["state"]["revision"] == 0  # read-only
    first = result["data"]["bookmarks"][0]
    assert first["title"] == TITLE_A
    assert first["page"] == 0
    assert first["bold"] is True and first["italic"] is False
    assert first["color"] == "#FF0000"
    assert first["children"][0]["title"] == TITLE_B
    assert first["children"][0]["page"] == 1
    assert result["data"]["bookmarks"][1]["title"] == TITLE_C


def test_set_replaces_the_tree_and_round_trips(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _pdf(tmp_path / "set.pdf", 3, outline=True))
    result = harness.op("bookmarks.set", {"bookmarks": SAMPLE}, sid)
    assert result["state"]["revision"] == 1
    tree = _get(harness, sid)
    assert [n["title"] for n in tree] == ["Chương 1 — Đặt vấn đề", "Phụ lục A — Biểu mẫu"]
    chapter = tree[0]
    assert chapter["open"] is False and chapter["bold"] is True
    assert chapter["color"] == "#0055AA"
    child = chapter["children"][0]
    assert child["title"] == "1.1 Bối cảnh"
    assert child["page"] == 1 and child["italic"] is True
    assert child["view"] == {"type": "xyz", "left": 0.0, "top": 400.0, "zoom": 1.5}
    assert tree[1]["page"] == 2


def test_set_writes_the_titles_into_the_file(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _pdf(tmp_path / "file.pdf", 3))
    harness.op("bookmarks.set", {"bookmarks": SAMPLE}, sid)
    with pikepdf.open(_rev(harness, sid)) as doc, doc.open_outline() as outline:
        titles = [str(item.title) for item in outline.root]
    assert titles == ["Chương 1 — Đặt vấn đề", "Phụ lục A — Biểu mẫu"]


def test_set_rejects_a_page_out_of_range(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _pdf(tmp_path / "range.pdf", 2))
    with pytest.raises(RpcFailure) as exc:
        harness.op("bookmarks.set", {"bookmarks": [{"title": "X", "page": 5}]}, sid)
    assert exc.value.code == -32602


def test_empty_set_clears_the_outline(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _pdf(tmp_path / "empty.pdf", 3, outline=True))
    harness.op("bookmarks.set", {"bookmarks": []}, sid)
    assert _get(harness, sid) == []


def test_clear_op_removes_everything(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _pdf(tmp_path / "clear.pdf", 3, outline=True))
    result = harness.op("bookmarks.clear", {}, sid)
    assert result["state"]["revision"] == 1
    assert _get(harness, sid) == []


def test_from_pages_makes_one_bookmark_per_selected_page(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _pdf(tmp_path / "pages.pdf", 4))
    harness.op(
        "bookmarks.fromPages",
        {"template": "Trang {page}", "pageRange": "odd"},
        sid,
    )
    tree = _get(harness, sid)
    assert [(n["title"], n["page"]) for n in tree] == [("Trang 1", 0), ("Trang 3", 2)]


def test_from_pages_numbers_from_start_number_and_appends(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _pdf(tmp_path / "append.pdf", 3, outline=True))
    harness.op(
        "bookmarks.fromPages",
        {"template": "Tr. {page} / {pages}", "startNumber": 10, "mode": "append"},
        sid,
    )
    titles = [n["title"] for n in _get(harness, sid)]
    assert titles == [TITLE_A, TITLE_C, "Tr. 10 / 12", "Tr. 11 / 12", "Tr. 12 / 12"]


def test_from_pages_rejects_unknown_variables(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _pdf(tmp_path / "badvar.pdf", 1))
    with pytest.raises(RpcFailure) as exc:
        harness.op("bookmarks.fromPages", {"template": "{trang}"}, sid)
    assert exc.value.code == -32602
    assert exc.value.detail["variable"] == "trang"


def test_set_is_undoable_and_redoable(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _pdf(tmp_path / "undo.pdf", 3, outline=True))
    harness.op("bookmarks.set", {"bookmarks": SAMPLE}, sid)
    assert _get(harness, sid)[0]["title"] == "Chương 1 — Đặt vấn đề"
    undo = harness.call("session.undo", {"sessionId": sid})
    assert undo["state"]["revision"] == 0
    assert _get(harness, sid)[0]["title"] == TITLE_A
    redo = harness.call("session.redo", {"sessionId": sid})
    assert redo["state"]["revision"] == 1
    assert _get(harness, sid)[0]["title"] == "Chương 1 — Đặt vấn đề"


def test_bookmark_tree_is_limited_in_size(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _pdf(tmp_path / "big.pdf", 1))
    many = [{"title": f"Mục {i}", "page": 0} for i in range(5001)]
    with pytest.raises(RpcFailure) as exc:
        harness.op("bookmarks.set", {"bookmarks": many}, sid)
    assert exc.value.code == -32602
