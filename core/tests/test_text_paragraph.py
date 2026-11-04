"""T7.03 (D9): text.editParagraph and text.styleParagraph (RPC level).

A paragraph is re-flowed inside its box with the metrics of the font that draws it. The other
column of the page must not move, justified lines must end at the same edge, Vietnamese words are
never split, and a text that does not fit before the next block is reported.
"""

from __future__ import annotations

import time
from collections import Counter
from pathlib import Path

import pytest
from conftest import Harness, RpcFailure
from text_support import canvas_pdf, pdf_text, put, squash, two_column_pdf
from text_support import justified as draw_justified

from chef_core.content.verify import assert_unchanged_outside

LEFT_PARAGRAPH_BOX = (60, 500, 320, 716)
ORIGINAL_PARAGRAPH = (
    "Hợp đồng này quy định việc cung cấp dịch vụ giữa các bên theo đúng các điều khoản"
)
NEW_PARAGRAPH = (
    "Hợp đồng này quy định chi tiết việc cung cấp dịch vụ giữa các bên, "
    "theo đúng các điều khoản được ghi trong văn bản này và có hiệu lực kể từ ngày ký "
    "kết, trừ khi hai bên có thỏa thuận bằng văn bản khác."
)


def _sid(harness: Harness, path: Path) -> str:
    return str(harness.open(path)["state"]["sessionId"])


def _revision(harness: Harness, sid: str) -> Path:
    return Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])


def _page(harness: Harness, sid: str, page: int = 0) -> dict:
    return harness.op("text.getLines", {"pageIndex": page}, sid)["data"]


def _paragraph_of(data: dict, prefix: str) -> dict:
    lines = {ln["id"]: ln for ln in data["lines"]}
    (line,) = [ln for ln in data["lines"] if ln["text"].startswith(prefix)]
    (para,) = [p for p in data["paragraphs"] if line["id"] in p["lineIds"]]
    return {"id": para["id"], "lines": [lines[i] for i in para["lineIds"]]}


def _body_lines(data: dict) -> list[dict]:
    """Lines of the left column body text (10 pt, starting at the column edge)."""
    out = [
        ln
        for ln in data["lines"]
        if 60 <= ln["bbox"][0] <= 80 and abs(ln["fontSize"] - 10) < 0.01 and ln["bbox"][0] < 330
    ]
    return sorted(out, key=lambda ln: ln["bbox"][1])


def _edit(harness: Harness, sid: str, para_id: str, text: str | None, **kw: object) -> dict:
    params: dict[str, object] = {"pageIndex": 0, "paragraphId": para_id, **kw}
    if text is None:
        return harness.op("text.styleParagraph", params, sid)
    return harness.op("text.editParagraph", {**params, "newText": text}, sid)


def _rows(path: Path, rows: list[tuple[float, float, float, str, bool]], rotate: int = 0) -> Path:
    def draw(cv, _i: int) -> None:  # type: ignore[no-untyped-def]
        for x, y, size, text, bold in rows:
            put(cv, x, y, text, size, bold)

    return canvas_pdf(path, draw, rotate=rotate)


def test_reflow_keeps_the_other_column_and_the_page_outside_the_box(
    harness: Harness, tmp_path: Path
) -> None:
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    para = _paragraph_of(_page(harness, sid), "Hợp đồng này")
    result = _edit(harness, sid, para["id"], NEW_PARAGRAPH)
    assert result["data"]["action"] == "reflow"
    out = _revision(harness, sid)
    assert "Điều 2" in pdf_text(out)
    assert squash(NEW_PARAGRAPH) in squash(pdf_text(out))
    assert "theo đúng các điều khoản" in pdf_text(out)
    assert_unchanged_outside(src, out, 0, [LEFT_PARAGRAPH_BOX], tolerance=0, pad=2)


def test_justified_lines_end_at_the_same_edge_except_the_last(
    harness: Harness, tmp_path: Path
) -> None:
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    para = _paragraph_of(_page(harness, sid), "Hợp đồng này")
    _edit(harness, sid, para["id"], NEW_PARAGRAPH, align="justify")
    body = _body_lines(_page(harness, sid))
    assert len(body) >= 4
    rights = [ln["bbox"][2] for ln in body[:-1]]
    assert max(rights) - min(rights) <= 1.0, rights


def test_vietnamese_words_are_never_split(harness: Harness, tmp_path: Path) -> None:
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    para = _paragraph_of(_page(harness, sid), "Hợp đồng này")
    _edit(harness, sid, para["id"], NEW_PARAGRAPH)
    words = set(NEW_PARAGRAPH.split())
    body = _body_lines(_page(harness, sid))
    assert body
    for ln in body:
        for word in ln["text"].split():
            assert word in words, word


def test_substitution_warning_when_the_subset_lacks_the_new_letters(
    harness: Harness, tmp_path: Path
) -> None:
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    para = _paragraph_of(_page(harness, sid), "Hợp đồng này")
    result = _edit(harness, sid, para["id"], "Ạ ệ ộ ự ẫ tiếng Việt mới.")
    assert result["data"]["fontTo"] == "BeVietnamPro-Regular"
    assert result["data"]["missing"]
    assert any("Đã thay font" in w for w in result["warnings"])


def test_overflow_is_reported_and_blocks_are_listed(harness: Harness, tmp_path: Path) -> None:
    def draw(cv, _i):  # type: ignore[no-untyped-def]
        draw_justified(cv, 72, 706, 240, "Đoạn văn ngắn thứ nhất của trang này nằm ở đây", 10)
        put(cv, 72, 678, "và dòng cuối của đoạn này.", 10)
        put(cv, 72, 640, "Khối bên dưới không được chạm vào.", 12, bold=True)

    src = canvas_pdf(tmp_path / "over.pdf", draw)
    sid = _sid(harness, src)
    para = _paragraph_of(_page(harness, sid), "Đoạn văn")
    long_text = " ".join(["Nội dung bổ sung để đoạn văn dài ra đáng kể."] * 8)
    result = _edit(harness, sid, para["id"], long_text)
    assert result["data"]["overflow"] > 10
    assert result["data"]["overlapsBlockIds"]
    assert any("tràn" in w or "chồng" in w for w in result["warnings"])


def test_rotated_page_reflows_in_user_space(harness: Harness, tmp_path: Path) -> None:
    src = two_column_pdf(tmp_path / "rot.pdf")
    rotated = tmp_path / "rot90.pdf"
    import pikepdf

    with pikepdf.open(src) as pdf:
        pdf.pages[0].obj.Rotate = 90
        pdf.save(rotated)
    sid = _sid(harness, rotated)
    para = _paragraph_of(_page(harness, sid), "Hợp đồng này")
    _edit(harness, sid, para["id"], NEW_PARAGRAPH)
    words = Counter(pdf_text(_revision(harness, sid)).split())
    assert not Counter(NEW_PARAGRAPH.split()) - words


def test_list_item_keeps_marker_and_hangs_its_continuation(
    harness: Harness, tmp_path: Path
) -> None:
    # the last bullet: nothing below it, so the longer text can grow without overlapping
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    para = _paragraph_of(_page(harness, sid), "- Thuế giá trị")
    _edit(
        harness,
        sid,
        para["id"],
        "Thuế giá trị gia tăng là mười phần trăm trên giá trị hàng hóa dịch vụ "
        "theo quy định của pháp luật hiện hành.",
    )
    items = sorted(
        (
            ln
            for ln in _page(harness, sid)["lines"]
            if 325 < ln["bbox"][0] < 345 and ln["fontSize"] < 11 and ln["bbox"][1] >= 100
        ),
        key=lambda ln: ln["bbox"][1],
    )
    first = items[0]
    assert first["text"].startswith("- Thuế giá trị")
    continuation = items[1:]
    assert len(continuation) >= 2, "the new text wraps"
    assert all(ln["bbox"][0] > first["bbox"][0] for ln in continuation)
    assert all(not ln["text"].startswith("- ") for ln in continuation)


def test_hard_break_makes_a_new_line(harness: Harness, tmp_path: Path) -> None:
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    para = _paragraph_of(_page(harness, sid), "Hợp đồng này")
    _edit(harness, sid, para["id"], "Dòng một ngắn.\nDòng hai ngắn.")
    texts = [ln["text"] for ln in _body_lines(_page(harness, sid))]
    assert "Dòng một ngắn." in texts
    assert "Dòng hai ngắn." in texts


def test_style_only_changes_size_colour_and_keeps_the_text(
    harness: Harness, tmp_path: Path
) -> None:
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    before = _paragraph_of(_page(harness, sid), "Hợp đồng này")
    before_text = " ".join(ln["text"] for ln in before["lines"])
    result = _edit(harness, sid, before["id"], None, fontSize=11, color="#ff0000")
    assert result["data"]["fontSize"] == pytest.approx(11, abs=0.01)
    assert result["data"]["changed"] is True
    after = _page(harness, sid)
    styled = [ln for ln in after["lines"] if ln["fontSize"] == pytest.approx(11, abs=0.01)]
    assert styled and all(ln["colour"] == "#ff0000" for ln in styled)
    assert squash(before_text) == squash(" ".join(ln["text"] for ln in styled))


def test_bold_switches_to_the_bold_face(harness: Harness, tmp_path: Path) -> None:
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    para = _paragraph_of(_page(harness, sid), "Hợp đồng này")
    result = _edit(harness, sid, para["id"], None, bold=True)
    assert result["data"]["fontTo"] == "BeVietnamPro-Bold"


def test_keep_strategy_refuses_missing_letters(harness: Harness, tmp_path: Path) -> None:
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    para = _paragraph_of(_page(harness, sid), "Hợp đồng này")
    with pytest.raises(RpcFailure) as exc:
        _edit(harness, sid, para["id"], "Ạ mới", fontStrategy="keep")
    assert exc.value.error["message"] == "TEXT_GLYPH_MISSING"


def test_undo_and_redo_restore_the_paragraph(harness: Harness, tmp_path: Path) -> None:
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    para = _paragraph_of(_page(harness, sid), "Hợp đồng này")
    _edit(harness, sid, para["id"], NEW_PARAGRAPH)
    assert squash(NEW_PARAGRAPH) in squash(pdf_text(_revision(harness, sid)))
    harness.call("session.undo", {"sessionId": sid})
    assert "theo đúng các điều khoản được ghi" in pdf_text(_revision(harness, sid))
    harness.call("session.redo", {"sessionId": sid})
    assert squash(NEW_PARAGRAPH) in squash(pdf_text(_revision(harness, sid)))


def test_signed_document_is_blocked(harness: Harness, corpus: dict[str, Path]) -> None:
    sid = _sid(harness, corpus["fake_signed.pdf"])
    with pytest.raises(RpcFailure) as exc:
        _edit(harness, sid, "P0:000000000000:0", "Mới.")
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"


def test_stale_paragraph_id_is_refused(harness: Harness, tmp_path: Path) -> None:
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    with pytest.raises(RpcFailure) as exc:
        _edit(harness, sid, "P0:000000000000:0", "Mới.")
    assert exc.value.error["message"] == "STALE_OBJECT_IDS"


def test_one_paragraph_takes_under_two_seconds(harness: Harness, tmp_path: Path) -> None:
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    para = _paragraph_of(_page(harness, sid), "Hợp đồng này")
    started = time.perf_counter()
    _edit(harness, sid, para["id"], NEW_PARAGRAPH)
    assert time.perf_counter() - started < 2.0


def test_bold_on_a_short_heading_still_works_without_an_indent(
    harness: Harness, tmp_path: Path
) -> None:
    # A one-word heading is narrower than four em: a style change must not ask for an indent room.
    src = _rows(tmp_path / "heading.pdf", [(60, 700, 10, "Điều 2", False)])
    sid = _sid(harness, src)
    para = _paragraph_of(_page(harness, sid), "Điều 2")
    result = _edit(harness, sid, para["id"], None, bold=True)
    assert result["data"]["action"] == "reflow"
    # The box keeps its width, so the bolder text may wrap; every line is bold and all words stay.
    lines = [ln for ln in _page(harness, sid)["lines"] if ln["text"] in ("Điều", "2")]
    assert [ln["bold"] for ln in lines] == [True, True]


def test_indent_moves_only_the_first_line(harness: Harness, tmp_path: Path) -> None:
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    para = _paragraph_of(_page(harness, sid), "Hợp đồng này")
    left = min(ln["bbox"][0] for ln in para["lines"])
    _edit(harness, sid, para["id"], NEW_PARAGRAPH, indent=24)
    lines = _paragraph_of(_page(harness, sid), "Hợp đồng này")["lines"]
    assert len(lines) >= 3
    assert abs(lines[0]["bbox"][0] - left - 24) <= 1.0
    for ln in lines[1:]:
        assert abs(ln["bbox"][0] - left) <= 1.0


def test_indent_zero_puts_the_first_line_at_the_edge(harness: Harness, tmp_path: Path) -> None:
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    para = _paragraph_of(_page(harness, sid), "Hợp đồng này")
    left = min(ln["bbox"][0] for ln in para["lines"])
    _edit(harness, sid, para["id"], NEW_PARAGRAPH, indent=0)
    lines = _paragraph_of(_page(harness, sid), "Hợp đồng này")["lines"]
    assert abs(lines[0]["bbox"][0] - left) <= 1.0


def test_negative_indent_is_refused(harness: Harness, tmp_path: Path) -> None:
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    para = _paragraph_of(_page(harness, sid), "Hợp đồng này")
    with pytest.raises(RpcFailure) as exc:
        _edit(harness, sid, para["id"], NEW_PARAGRAPH, indent=-4)
    assert exc.value.kind == "INVALID_PARAMS"
    assert "indent" in str(exc.value.error)


def test_indent_leaving_no_room_in_the_first_row_is_refused(
    harness: Harness, tmp_path: Path
) -> None:
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    para = _paragraph_of(_page(harness, sid), "Hợp đồng này")
    with pytest.raises(RpcFailure) as exc:
        _edit(harness, sid, para["id"], NEW_PARAGRAPH, indent=900)
    assert "indent" in str(exc.value.error)
    # The refusal changes nothing: the paragraph is still there, unchanged.
    assert _paragraph_of(_page(harness, sid), "Hợp đồng này")["id"] == para["id"]


def _paragraph_text(data: dict, prefix: str) -> str:
    """Text of the paragraph that starts with prefix, its lines joined in reading order."""
    para = _paragraph_of(data, prefix)
    return " ".join(ln["text"] for ln in para["lines"])


@pytest.mark.parametrize(
    "style",
    [
        {"align": "left"},
        {"align": "center"},
        {"align": "right"},
        {"align": "justify"},
        {"indent": 24},
        {"bold": True},
        {"fontSize": 13},
    ],
    ids=["left", "center", "right", "justify", "indent", "bold", "size"],
)
def test_a_style_change_keeps_the_paragraph_whole(
    harness: Harness, tmp_path: Path, style: dict
) -> None:
    # After a style change the page must have the same paragraphs, and the edited paragraph must
    # still hold all of its lines: a centred or right-aligned second line is not a new paragraph.
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    before = _page(harness, sid)
    para = _paragraph_of(before, "Hợp đồng này")
    assert len(para["lines"]) >= 2
    text_before = _paragraph_text(before, "Hợp đồng này")
    count_before = len(before["paragraphs"])
    _edit(harness, sid, para["id"], None, **style)
    after = _page(harness, sid)
    assert len(after["paragraphs"]) == count_before
    assert _paragraph_text(after, "Hợp đồng này") == text_before


def test_an_indented_paragraph_after_a_justified_run_stays_separate(
    harness: Harness, tmp_path: Path
) -> None:
    # Two lines that start at one edge are a justified run; an indented line after them starts a
    # new paragraph even when its right edge matches the run (no right-aligned run here).
    src = _rows(
        tmp_path / "justified.pdf",
        [
            (60, 700, 10, "Điều một quy định về việc thanh toán", False),
            (60, 686, 10, "thanh toán theo hợp đồng này và các phụ lục", False),
            (84, 672, 10, "Điều hai quy định về trách nhiệm các bên", False),
        ],
    )
    sid = _sid(harness, src)
    page_lines = _page(harness, sid)["lines"]

    def para_of(prefix: str) -> str:
        (ln,) = [ln for ln in page_lines if ln["text"].startswith(prefix)]
        return ln["paragraphId"]

    first = para_of("Điều một")
    assert para_of("thanh toán theo") == first
    assert para_of("Điều hai") != first
