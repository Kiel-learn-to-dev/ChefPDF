"""Preview and commit share one plan (text.previewParagraph vs text.editParagraph).

The parity test is the guard: for each text, the rows the preview returns must be the lines that
getLines reads back after the commit with the same text.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from conftest import Harness
from test_text_paragraph import _edit, _page, _paragraph_of, _sid
from text_support import squash, two_column_pdf

LEFT = "Hợp đồng này"
TEXTS = [
    "Hợp đồng này quy định việc cung cấp dịch vụ giữa các bên theo đúng các điều khoản.",
    "Hợp đồng này có hiệu lực từ ngày ký, trừ khi hai bên có thỏa thuận bằng văn bản khác.",
    "Hợp đồng này gồm hai dòng\ncó xuống dòng cứng.",
    "Hợp đồng này rất ngắn.",
]


def _preview(harness: Harness, sid: str, pid: str, text: str) -> dict:
    return harness.op(
        "text.previewParagraph",
        {"pageIndex": 0, "paragraphId": pid, "newText": text},
        sid,
    )["data"]


@pytest.mark.parametrize("text", TEXTS)
def test_preview_rows_are_the_lines_after_the_commit(
    harness: Harness, tmp_path: Path, text: str
) -> None:
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    pid = _paragraph_of(_page(harness, sid), LEFT)["id"]
    preview = _preview(harness, sid, pid, text)
    rows = preview["rows"]
    assert rows, "a preview must have rows for a non-empty text"

    _edit(harness, sid, pid, text)
    after = _paragraph_of(_page(harness, sid), LEFT)["lines"]
    assert [squash(r["text"]) for r in rows] == [squash(ln["text"]) for ln in after]
    for row, ln in zip(rows, after, strict=True):
        assert abs(row["x"] - ln["bbox"][0]) <= 0.6, (row["x"], ln["bbox"][0])


def test_preview_writes_nothing(harness: Harness, tmp_path: Path) -> None:
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    before = _page(harness, sid)
    pid = _paragraph_of(before, LEFT)["id"]
    _preview(harness, sid, pid, TEXTS[0])
    assert _page(harness, sid) == before


def test_preview_char_positions_match_the_row_width(harness: Harness, tmp_path: Path) -> None:
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    pid = _paragraph_of(_page(harness, sid), LEFT)["id"]
    for row in _preview(harness, sid, pid, TEXTS[0])["rows"]:
        assert len(row["charX"]) == len(row["text"]) + 1
        assert row["charX"][0] == 0.0
        assert all(b >= a for a, b in zip(row["charX"], row["charX"][1:], strict=False))


def test_a_two_line_block_that_stops_short_is_not_justified(tmp_path: Path) -> None:
    # A signature block: both lines start at one x and the first line stops short of the other.
    # It must not be read as justified, or a re-flow would stretch it.
    import pikepdf
    from text_support import canvas_pdf, put

    from chef_core.text.build import build_text_page

    def draw(cv, _i):  # type: ignore[no-untyped-def]
        put(cv, 300, 300, "KT. THỦ TRƯỞNG", 10, True)
        put(cv, 300, 286, "PHÓ THỦ TRƯỞNG CHẤP HÀNH", 10, True)

    src = canvas_pdf(tmp_path / "sign.pdf", draw)
    with pikepdf.open(src) as pdf:
        tp = build_text_page(pdf, pdf.pages[0], 0)
    lines = {ln.id: ln for ln in tp.lines}
    (para,) = [p for p in tp.paragraphs if any(lines[i].text.startswith("KT.") for i in p.line_ids)]
    assert para.align == "left"


@pytest.mark.parametrize(
    "text",
    [
        TEXTS[0],
        "Hợp đồng  này có  khoảng trắng kép\nvà xuống dòng cứng, rồi thêm một câu dài để xuống dòng.",
    ],
)
def test_every_row_character_points_at_its_own_character_in_the_text(
    harness: Harness, tmp_path: Path, text: str
) -> None:
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    pid = _paragraph_of(_page(harness, sid), LEFT)["id"]
    previous = -1
    for row in _preview(harness, sid, pid, text)["rows"]:
        assert len(row["index"]) == len(row["text"])
        for ch, i in zip(row["text"], row["index"], strict=True):
            assert i > previous, (ch, i, previous)
            previous = i
            assert text[i] == ch or (ch == " " and text[i].isspace()), (ch, i, text[i])
