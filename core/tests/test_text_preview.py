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
        "Hợp đồng  này có  khoảng trắng kép\nvà xuống dòng cứng, "
        "rồi thêm một câu dài để xuống dòng.",
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


def test_every_line_has_a_glyph_pair_per_character_in_reading_order(
    harness: Harness, tmp_path: Path
) -> None:
    """The session maps a selection on the page to text indices through these pairs (D65)."""
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    for ln in _page(harness, sid)["lines"]:
        glyphs = ln["glyphs"]
        assert len(glyphs) == len(ln["text"]), ln["text"]
        lefts = [g[0] for g in glyphs]
        assert lefts == sorted(lefts), ln["text"]
        for left, right in glyphs:
            assert left <= right


def test_preview_names_the_font_the_commit_keeps(harness: Harness, tmp_path: Path) -> None:
    """A session draws its text with the font the commit writes: the document's own font keeps its
    style (and its family only when it is installed), a changed text keeps the same font."""
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    before = _page(harness, sid)
    pid = _paragraph_of(before, LEFT)["id"]
    shorter = TEXTS[3]
    render = _preview(harness, sid, pid, shorter)["render"]
    assert render["style"] in ("sans", "serif", "mono")
    assert render["bold"] is False and render["italic"] is False
    assert render["family"] is None or isinstance(render["family"], str)
    # A deletion keeps the font: the text without its last character is drawn the same way.
    assert _preview(harness, sid, pid, TEXTS[3][:-1])["render"] == render


ARIAL = Path("C:/Windows/Fonts/arial.ttf")


@pytest.mark.skipif(not ARIAL.exists(), reason="Arial is not installed on this computer")
def test_preview_draws_an_embedded_font_with_its_installed_family(
    harness: Harness, tmp_path: Path
) -> None:
    """The document's own font (embedded, subset) is drawn with the family of the same name on this
    computer; the session then shows the text in that family, not in a generic one (D65)."""
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    pdfmetrics.registerFont(TTFont("Arial", str(ARIAL)))
    text = "Hợp đồng này có hiệu lực từ ngày ký."
    path = tmp_path / "arial.pdf"
    cv = canvas.Canvas(str(path))
    cv.setFont("Arial", 11)
    cv.drawString(72, 700, text)
    cv.save()

    sid = _sid(harness, path)
    line = _page(harness, sid)["lines"][0]
    render = _preview(harness, sid, line["paragraphId"], line["text"])["render"]
    assert render["family"] == "Arial"
    assert render["style"] == "sans"
    assert render["bold"] is False and render["italic"] is False


def _no_internal_name(warnings: list[str]) -> None:
    """Warnings name fonts by family: no installed-font id, no subset tag, no 'X bằng X'."""
    for w in warnings:
        assert "sys:" not in w, w
        assert "+" not in w, w
        assert "BeVietnamPro-Regular bằng BeVietnamPro-Regular" not in w, w


def test_warnings_name_the_family_and_never_an_internal_id(
    harness: Harness, tmp_path: Path
) -> None:
    """A character the subset lacks is written by the full font of the same family: the warning says
    so once, with the family name and the characters, and never with an internal id (D66)."""
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    pid = _paragraph_of(_page(harness, sid), LEFT)["id"]
    warnings = _preview(harness, sid, pid, "Hợp đồng này có ớ và ệ mới.")["warnings"]
    _no_internal_name(warnings)
    assert any("Đã dùng bản đầy đủ của font Be Vietnam Pro cho ký tự:" in w for w in warnings), (
        warnings
    )
    assert any(w.endswith("cho ký tự: ớ.") for w in warnings), warnings


@pytest.mark.skipif(not ARIAL.exists(), reason="Arial is not installed on this computer")
def test_installed_family_warning_says_full_font_once(harness: Harness, tmp_path: Path) -> None:
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    pdfmetrics.registerFont(TTFont("Arial", str(ARIAL)))
    path = tmp_path / "arial2.pdf"
    cv = canvas.Canvas(str(path))
    cv.setFont("Arial", 11)
    cv.drawString(72, 700, "Hợp đồng này có hiệu lực.")
    cv.save()
    sid = _sid(harness, path)
    line = _page(harness, sid)["lines"][0]
    data = _preview(harness, sid, line["paragraphId"], line["text"] + " ớ")
    _no_internal_name(data["warnings"])
    assert data["render"]["family"] == "Arial"
    assert "Đã dùng bản đầy đủ của font Arial cho ký tự: ớ." in data["warnings"], data["warnings"]
