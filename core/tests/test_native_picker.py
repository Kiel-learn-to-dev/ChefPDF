"""Vòng liệt kê, chọn, gỡ của các hộp thoại danh sách chọn bản Rust (R5.19, R5.39, R5.40, R5.46).

`apps/native/crates/chef-app/testdata/picker_params.json` do test Rust sinh từ bảng `PICKERS`.
File này chạy đúng thao tác liệt kê và gỡ đó trên lõi thật, với định danh lấy từ chính kết quả
liệt kê.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from conftest import Harness
from pdf_media import new_pdf, place, save
from test_pageedit import _sid

GOLDEN = (
    Path(__file__).resolve().parents[2]
    / "apps"
    / "native"
    / "crates"
    / "chef-app"
    / "testdata"
    / "picker_params.json"
)


def _golden() -> dict[str, dict[str, str]]:
    return json.loads(GOLDEN.read_text(encoding="utf-8"))  # type: ignore[no-any-return]


def _rows(data: Any, pointer: str) -> list[dict[str, Any]]:
    node = data
    for part in [p for p in pointer.split("/") if p]:
        node = node[part]
    return list(node)


def _session(harness: Harness, tmp_path: Path) -> str:
    pdf = new_pdf(0)
    for i in range(3):
        place(pdf, pdf.add_blank_page(page_size=(612, 792)), [], text=f"Trang {i}")
    sid = _sid(harness, save(pdf, tmp_path / "a.pdf"))
    note = tmp_path / "ghi-chu.txt"
    note.write_text("x", encoding="utf-8")
    harness.op("doc.attachments.add", {"paths": [str(note)]}, sid)
    harness.op("overlay.watermark", {"text": "MAU", "opacity": 0.3}, sid)
    harness.op("stamp.text", {"x": 50, "y": 50, "text": "DAU"}, sid)
    return sid


def test_every_picker_is_covered() -> None:
    assert set(_golden()) == {"attachments", "overlays", "watermarks", "hidden"}


@pytest.mark.parametrize("key", sorted(_golden()))
def test_list_select_remove_round_trip(harness: Harness, tmp_path: Path, key: str) -> None:
    spec = _golden()[key]
    sid = _session(harness, tmp_path)
    listed = harness.op(spec["listOp"], {}, sid)["data"]
    rows = _rows(listed, spec["rowsPointer"])
    assert rows, key
    ids = [str(r[spec["idField"]]) for r in rows]
    if key == "hidden":
        # Chỉ các loại có thể gỡ và đang có nội dung (như PickerRow::selectable).
        ids = [str(r["category"]) for r in rows if r["fixAvailable"] and r["count"] > 0]
        assert ids == ["embeddedFiles"]
    result = harness.op(spec["applyOp"], {spec["applyField"]: ids}, sid)
    assert result["state"]["canUndo"] is True, key
    again = harness.op(spec["listOp"], {}, sid)["data"]
    remaining = {str(r[spec["idField"]]) for r in _rows(again, spec["rowsPointer"])}
    if key == "hidden":
        counts = {r["category"]: r["count"] for r in _rows(again, spec["rowsPointer"])}
        assert counts["embeddedFiles"] == 0
    else:
        assert not remaining & set(ids), key
