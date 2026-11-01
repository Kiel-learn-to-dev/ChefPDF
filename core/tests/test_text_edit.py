"""T7.02: text.editLine, text.checkText, text.getLines, text.listFonts (RPC level).

The classic trap: a Vietnamese line in an embedded subset font that does not contain the new
letters. The result must show the new text (text extraction and pixels), warn about the font
change, and leave everything outside the line as it was.
"""

from __future__ import annotations

from pathlib import Path

import pikepdf
import pytest
from conftest import Harness, RpcFailure
from content_support import raw_pdf, vietnamese_pdf
from text_support import (
    cid_hex,
    cid_subset_pdf,
    form_text_pdf,
    helvetica_pdf,
    pdf_text,
    squash,
    two_column_pdf,
    vi_page,
)

from chef_core.content.verify import assert_unchanged_outside

PAGE_H = 792.0


def _sid(harness: Harness, path: Path) -> str:
    return str(harness.open(path)["state"]["sessionId"])


def _revision(harness: Harness, sid: str) -> Path:
    return Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])


def _lines(harness: Harness, sid: str, page: int = 0) -> list[dict]:
    data = harness.op("text.getLines", {"pageIndex": page}, sid)["data"]
    return list(data["lines"])


def _find(lines: list[dict], prefix: str) -> dict:
    (found,) = [ln for ln in lines if ln["text"].startswith(prefix)]
    return found


def _user_box(line: dict) -> tuple[float, float, float, float]:
    x0, top, x1, bottom = line["bbox"]
    return (x0, PAGE_H - bottom, x1, PAGE_H - top)


def _edit(harness: Harness, sid: str, line: dict, text: str, **kw: object) -> dict:
    params = {"pageIndex": line["pageIndex"], "lineId": line["id"], "newText": text, **kw}
    return harness.op("text.editLine", params, sid)


def test_get_lines_and_check_text_on_a_vietnamese_page(harness: Harness, tmp_path: Path) -> None:
    src = vietnamese_pdf(tmp_path / "vi.pdf")
    sid = _sid(harness, src)
    lines = _lines(harness, sid)
    assert [ln["text"] for ln in lines] == [
        "Tiếng Việt có dấu: Hà Nội",
        "Chef PDF sửa nội dung trang",
    ]
    first = lines[0]
    assert first["fontSize"] == pytest.approx(24, abs=0.01)
    assert first["canEncodeAny"] is True
    ok = harness.op("text.checkText", {"lineId": first["id"], "newText": "Hà Nội"}, sid)["data"]
    assert ok == {"supported": True, "missing": [], "willSubstituteWith": None}
    bad = harness.op("text.checkText", {"lineId": first["id"], "newText": "Ạ ạ"}, sid)["data"]
    assert bad["supported"] is False
    assert bad["missing"] == ["Ạ", "ạ"]
    assert bad["willSubstituteWith"] == "BeVietnamPro-Regular"


def test_the_classic_trap_replaces_the_font_and_shows_the_new_text(
    harness: Harness, tmp_path: Path
) -> None:
    src = vietnamese_pdf(tmp_path / "vi.pdf")
    sid = _sid(harness, src)
    line = _find(_lines(harness, sid), "Tiếng Việt")
    new = "Ẩm thực Việt Nam ạ"
    result = _edit(harness, sid, line, new)
    assert result["data"]["action"] == "substitute"
    assert result["data"]["fontTo"] == "BeVietnamPro-Regular"
    assert any("Đã thay font" in w for w in result["warnings"])
    out = _revision(harness, sid)
    assert squash(new) in squash(pdf_text(out))
    assert "Tiếng Việt" not in pdf_text(out)
    # the accent of the new capital letter rises above the old line box: pad by 8 pt
    assert_unchanged_outside(
        src, out, 0, [_user_box(line), (60, 400, 300, 560)], tolerance=0, pad=8
    )
    lines_after = _lines(harness, sid)
    assert _find(lines_after, "Ẩm thực")["fontSize"] == pytest.approx(24, abs=0.01)


def test_in_place_edit_keeps_unchanged_prefix_and_kerning(harness: Harness, tmp_path: Path) -> None:
    # TJ with a kerning number inside the unchanged part; subset holds every letter used
    text = "Nguyễn An"
    content = f"BT /F2 20 Tf 72 700 Td [<{cid_hex('Nguy')}> -150 <{cid_hex('ễn An')}>] TJ ET"
    src = cid_subset_pdf(tmp_path / "kern.pdf", text + "Ấ", content)
    sid = _sid(harness, src)
    line = _find(_lines(harness, sid), "Nguyễn")
    result = _edit(harness, sid, line, "Nguyễn Ấn")
    assert result["data"]["action"] == "inplace"
    assert result["data"]["fontTo"] is None
    with pikepdf.open(_revision(harness, sid)) as pdf:
        ops = pikepdf.parse_content_stream(pdf.pages[0])
        arrays = [o.operands[0] for o in ops if str(o.operator) == "TJ"]
    assert any(isinstance(item, (int, float)) and abs(item + 150) < 1e-6 for item in arrays[0]), (
        "the kerning of the unchanged prefix is kept"
    )
    assert squash("Nguyễn Ấn") in squash(pdf_text(_revision(harness, sid)))


def test_cid_subset_missing_letters_are_substituted(harness: Harness, tmp_path: Path) -> None:
    text = "Nguyễn Văn An"
    content = f"BT /F2 20 Tf 72 700 Td <{cid_hex(text)}> Tj ET"
    src = cid_subset_pdf(tmp_path / "cid.pdf", text, content)
    sid = _sid(harness, src)
    line = _find(_lines(harness, sid), "Nguyễn")
    result = _edit(harness, sid, line, "Nguyễn Văn Ạ")
    assert result["data"]["action"] == "substitute"
    assert any("Ạ" in w for w in result["warnings"])
    assert squash("Nguyễn Văn Ạ") in squash(pdf_text(_revision(harness, sid)))


def test_standard_font_page_gets_a_unicode_font(harness: Harness, tmp_path: Path) -> None:
    src = helvetica_pdf(tmp_path / "h.pdf", [(72, 700, 16, "Nguyen Van A")])
    sid = _sid(harness, src)
    line = _find(_lines(harness, sid), "Nguyen")
    result = _edit(harness, sid, line, "Nguyễn Văn Ạ")
    assert result["data"]["action"] == "substitute"
    assert result["data"]["fontFrom"] == "Helvetica"
    assert squash("Nguyễn Văn Ạ") in squash(pdf_text(_revision(harness, sid)))


def test_keep_strategy_refuses_to_substitute(harness: Harness, tmp_path: Path) -> None:
    src = vietnamese_pdf(tmp_path / "vi.pdf")
    sid = _sid(harness, src)
    line = _find(_lines(harness, sid), "Tiếng Việt")
    with pytest.raises(RpcFailure) as exc:
        _edit(harness, sid, line, "Ạ", fontStrategy="keep")
    assert exc.value.error["message"] == "TEXT_GLYPH_MISSING"
    assert exc.value.detail["missing"] == ["Ạ"]


def test_a_character_no_font_has_is_an_error_with_the_list(
    harness: Harness, tmp_path: Path
) -> None:
    src = vietnamese_pdf(tmp_path / "vi.pdf")
    sid = _sid(harness, src)
    line = _find(_lines(harness, sid), "Tiếng Việt")
    with pytest.raises(RpcFailure) as exc:
        _edit(harness, sid, line, "Hà 中文")
    assert exc.value.error["message"] == "TEXT_GLYPH_MISSING"
    assert exc.value.detail["missing"] == ["中", "文"]


def test_empty_text_deletes_the_line(harness: Harness, tmp_path: Path) -> None:
    src = vietnamese_pdf(tmp_path / "vi.pdf")
    sid = _sid(harness, src)
    line = _find(_lines(harness, sid), "Chef PDF")
    result = _edit(harness, sid, line, "")
    assert result["data"]["action"] == "delete"
    remaining = [ln["text"] for ln in _lines(harness, sid)]
    assert remaining == ["Tiếng Việt có dấu: Hà Nội"]


def test_stale_line_id_is_refused_after_an_edit(harness: Harness, tmp_path: Path) -> None:
    src = vietnamese_pdf(tmp_path / "vi.pdf")
    sid = _sid(harness, src)
    line = _find(_lines(harness, sid), "Chef PDF")
    _edit(harness, sid, line, "Chef PDF đã sửa")
    with pytest.raises(RpcFailure) as exc:
        _edit(harness, sid, line, "Lần hai")
    assert exc.value.error["message"] == "STALE_OBJECT_IDS"


def test_shrink_fit_reduces_the_size_to_the_floor_and_warns(
    harness: Harness, tmp_path: Path
) -> None:
    src = vi_page(tmp_path / "fit.pdf", [(72, 700, 14, "Bên A là Công ty ABC", False)])
    sid = _sid(harness, src)
    line = _find(_lines(harness, sid), "Bên A")
    long_text = "Bên A là Công ty TNHH Phát Triển Số Đại Việt Toàn Cầu Hợp Nhất"
    result = _edit(harness, sid, line, long_text, fitWidth="shrink")
    data = result["data"]
    assert data["fit"] == "shrink"
    assert 14 * 0.8 - 0.01 <= data["fontSize"] < 14
    assert data["overflow"] > 0, "the floor is reached, the rest of the text still overflows"
    assert any("cỡ chữ" in w for w in result["warnings"])


def test_track_fit_reduces_spacing(harness: Harness, tmp_path: Path) -> None:
    src = vi_page(tmp_path / "track.pdf", [(72, 700, 14, "Công ty ABC và các bên", False)])
    sid = _sid(harness, src)
    line = _find(_lines(harness, sid), "Công ty")
    result = _edit(harness, sid, line, "Công ty ABC và các bên hợp tác", fitWidth="track")
    data = result["data"]
    assert data["fit"] == "track"
    assert data["tracking"] < 0
    assert data["tracking"] >= -0.03 * 14 - 0.01, "tracking stops at the floor"
    if data["overflow"] <= 0.5:
        assert data["width"] <= line["bbox"][2] - line["bbox"][0] + 0.5


def test_undo_and_redo_restore_the_text(harness: Harness, tmp_path: Path) -> None:
    src = vietnamese_pdf(tmp_path / "vi.pdf")
    sid = _sid(harness, src)
    line = _find(_lines(harness, sid), "Chef PDF")
    _edit(harness, sid, line, "Đã sửa dòng này")
    assert "Đã sửa" in pdf_text(_revision(harness, sid))
    harness.call("session.undo", {"sessionId": sid})
    assert "Chef PDF sửa" in pdf_text(_revision(harness, sid))
    harness.call("session.redo", {"sessionId": sid})
    assert "Đã sửa" in pdf_text(_revision(harness, sid))


def test_rotated_page_edit_works(harness: Harness, tmp_path: Path) -> None:
    src = vietnamese_pdf(tmp_path / "rot.pdf", rotate=90)
    sid = _sid(harness, src)
    lines = _lines(harness, sid)
    assert lines and lines[0]["bbox"][0] < lines[0]["bbox"][2]
    line = _find(lines, "Chef PDF")
    _edit(harness, sid, line, "Trang xoay được sửa")
    assert squash("Trang xoay được sửa") in squash(pdf_text(_revision(harness, sid)))


def test_text_inside_a_form_is_listed_and_editable(harness: Harness, tmp_path: Path) -> None:
    src = form_text_pdf(tmp_path / "form.pdf", "Original form text")
    sid = _sid(harness, src)
    line = _find(_lines(harness, sid), "Original")
    _edit(harness, sid, line, "Changed form text")
    assert "Changed form text" in pdf_text(_revision(harness, sid))


def test_two_columns_editing_one_leaves_the_other_untouched(
    harness: Harness, tmp_path: Path
) -> None:
    src = two_column_pdf(tmp_path / "cols.pdf")
    sid = _sid(harness, src)
    lines = _lines(harness, sid)
    line = _find(lines, "Hợp đồng")
    _edit(harness, sid, line, "Hợp đồng số 7 ạ nhé")
    out = _revision(harness, sid)
    # the right column (x from 330) is outside the boxes checked below
    assert_unchanged_outside(
        src, out, 0, [_user_box(line), (60, 600, 318, 740)], tolerance=0, pad=3
    )
    assert "Hợp đồng số 7" in pdf_text(out)


def test_signed_document_blocks_text_edits(harness: Harness, corpus: dict[str, Path]) -> None:
    sid = _sid(harness, corpus["fake_signed.pdf"])
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "text.editLine",
            {"pageIndex": 0, "lineId": "L0:000000000000:0", "newText": "x"},
            sid,
        )
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"


def test_list_fonts_has_the_bundled_faces(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, vietnamese_pdf(tmp_path / "fonts.pdf"))
    fonts = harness.op("text.listFonts", {}, sid)["data"]["fonts"]
    assert [f["id"] for f in fonts] == ["BeVietnamPro-Regular", "BeVietnamPro-Bold"]
    assert all(f["coverage"] == "vietnamese" for f in fonts)


def test_raw_content_still_renders_after_an_edit(harness: Harness, tmp_path: Path) -> None:
    src = raw_pdf(tmp_path / "plain.pdf", b"BT /F1 12 Tf 72 700 Td (Plain line) Tj ET")
    sid = _sid(harness, src)
    line = _find(_lines(harness, sid), "Plain")
    _edit(harness, sid, line, "Plain line edited")
    assert "Plain line edited" in pdf_text(_revision(harness, sid))


def test_a_line_made_of_two_runs_is_replaced_as_one(harness: Harness, tmp_path: Path) -> None:
    # two text-showing operators on the same baseline (typical for Word exports)
    src = raw_pdf(tmp_path / "runs.pdf", b"BT /F1 12 Tf 72 700 Td (Hello ) Tj (World) Tj ET")
    sid = _sid(harness, src)
    line = _find(_lines(harness, sid), "Hello")
    result = _edit(harness, sid, line, "Xin chào thế giới")
    assert result["data"]["action"] == "substitute"
    assert squash("Xin chào thế giới") in squash(pdf_text(_revision(harness, sid)))
    assert "World" not in pdf_text(_revision(harness, sid))


def test_quote_operator_runs_keep_the_line_move(harness: Harness, tmp_path: Path) -> None:
    # ' moves to the next line before it shows its text; deleting the text must keep that move
    content = b"BT /F1 12 Tf 14 TL 72 700 Td (First) Tj (Second) ' (Third) ' ET"
    src = raw_pdf(tmp_path / "quote.pdf", content)
    sid = _sid(harness, src)
    line = _find(_lines(harness, sid), "Second")
    _edit(harness, sid, line, "")
    text = pdf_text(_revision(harness, sid))
    assert "Second" not in text
    assert "Third" in text, "the line after keeps its place"


def test_explicit_font_name_forces_the_replacement(harness: Harness, tmp_path: Path) -> None:
    src = vi_page(tmp_path / "forced.pdf", [(72, 700, 14, "Tiêu đề chính", False)])
    sid = _sid(harness, src)
    line = _find(_lines(harness, sid), "Tiêu")
    result = _edit(harness, sid, line, "Tiêu đề mới", fontName="BeVietnamPro-Bold")
    assert result["data"]["action"] == "substitute"
    assert result["data"]["fontTo"] == "BeVietnamPro-Bold"
    assert "Tiêu đề mới" in pdf_text(_revision(harness, sid))


def test_unknown_font_name_is_refused(harness: Harness, tmp_path: Path) -> None:
    src = vi_page(tmp_path / "unk.pdf", [(72, 700, 14, "Tiêu đề", False)])
    sid = _sid(harness, src)
    line = _find(_lines(harness, sid), "Tiêu")
    with pytest.raises(RpcFailure) as exc:
        _edit(harness, sid, line, "Mới", fontName="NoSuchFont")
    assert exc.value.error["message"] == "UNKNOWN_FONT"


def test_keep_style_follows_the_bold_of_the_line_or_not(harness: Harness, tmp_path: Path) -> None:
    bold_src = vi_page(tmp_path / "bold.pdf", [(72, 700, 14, "Tiêu đề in đậm", True)])
    sid = _sid(harness, bold_src)
    line = _find(_lines(harness, sid), "Tiêu")
    assert line["bold"] is True
    kept = _edit(harness, sid, line, "Tiêu đề ạ đậm")
    assert kept["data"]["fontTo"] == "BeVietnamPro-Bold"

    plain_src = vi_page(tmp_path / "plain.pdf", [(72, 700, 14, "Tiêu đề in đậm", True)])
    sid2 = _sid(harness, plain_src)
    line2 = _find(_lines(harness, sid2), "Tiêu")
    off = _edit(harness, sid2, line2, "Tiêu đề ạ đậm", keepStyle=False)
    assert off["data"]["fontTo"] == "BeVietnamPro-Regular"
