"""B12 (1.1): text.layer counts the pages that have a text layer; a scan page has none."""

from __future__ import annotations

from pathlib import Path

from conftest import Harness
from text_support import canvas_pdf, put


def test_a_text_page_counts_and_a_blank_page_does_not(harness: Harness, tmp_path: Path) -> None:
    def draw(cv, i):  # type: ignore[no-untyped-def]
        if i == 0:
            put(cv, 72, 700, "Hợp đồng này có lớp chữ.", 12, False)

    src = canvas_pdf(tmp_path / "mixed.pdf", draw, pages=2)
    opened = harness.open(src)
    sid = str(opened["state"]["sessionId"])
    data = harness.op("text.layer", {}, sid)["data"]
    assert data == {"pages": 2, "textPages": 1}


def test_a_page_without_characters_is_a_scan_layer(harness: Harness, tmp_path: Path) -> None:
    src = canvas_pdf(tmp_path / "blank.pdf", lambda cv, i: None, pages=1)  # type: ignore[no-untyped-def]
    sid = str(harness.open(src)["state"]["sessionId"])
    assert harness.op("text.layer", {}, sid)["data"] == {"pages": 1, "textPages": 0}
