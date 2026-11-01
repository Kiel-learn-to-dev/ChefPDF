"""T7.04: text.findReplace across a document (D10)."""

from __future__ import annotations

import time
from pathlib import Path

import pytest
from conftest import Harness, RpcFailure
from content_support import raw_pdf
from text_support import contract_pdf, pdf_text, squash, vi_page

OLD = "Công ty ABC"
NEW = "Công ty TNHH Phát Triển Số Đại Việt"


def _sid(harness: Harness, path: Path) -> str:
    return str(harness.open(path)["state"]["sessionId"])


def _revision(harness: Harness, sid: str) -> Path:
    return Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])


def _replace(harness: Harness, sid: str, find: str, replace: str, **kw: object) -> dict:
    return harness.op("text.findReplace", {"find": find, "replace": replace, **kw}, sid)


def test_company_name_replaced_on_every_page(harness: Harness, tmp_path: Path) -> None:
    pages = 30
    src = contract_pdf(tmp_path / "contract.pdf", pages)
    sid = _sid(harness, src)
    result = _replace(harness, sid, OLD, NEW)
    data = result["data"]
    assert data["replaced"] == pages * 3
    assert len(data["matches"]) == pages * 3
    assert len(data["fontSubstitutions"]) == pages * 3, "the source font lacks the new letters"
    assert len(result["changedPages"]) == pages
    out = _revision(harness, sid)
    for index in (0, pages - 1):
        text = squash(pdf_text(out, index))
        assert squash(NEW) in text
        assert squash(OLD) not in text
    assert all(m["before"] == OLD for m in data["matches"])
    assert all(m["after"] == NEW for m in data["matches"])
    assert all(len(m["rect"]) == 4 for m in data["matches"])


def test_width_growth_is_reported_per_match(harness: Harness, tmp_path: Path) -> None:
    src = contract_pdf(tmp_path / "contract.pdf", 2)
    sid = _sid(harness, src)
    data = _replace(harness, sid, OLD, NEW)["data"]
    fits = {m["fit"] for m in data["matches"]}
    assert fits <= {"none", "shrink", "track"}
    assert all(m["overflow"] >= 0 for m in data["matches"])
    assert any(m["overflow"] > 0 for m in data["matches"]), "the new name is longer"


def test_shrink_fit_applies_to_every_match(harness: Harness, tmp_path: Path) -> None:
    src = contract_pdf(tmp_path / "contract.pdf", 2)
    sid = _sid(harness, src)
    data = _replace(harness, sid, OLD, NEW, fitWidth="shrink")["data"]
    assert all(m["fit"] in ("shrink", "none") for m in data["matches"])
    assert all(m["fontSize"] <= 11 + 1e-6 for m in data["matches"] if m["fit"] == "shrink")


def test_preview_lists_matches_and_changes_nothing(harness: Harness, tmp_path: Path) -> None:
    src = contract_pdf(tmp_path / "contract.pdf", 3)
    sid = _sid(harness, src)
    before = pdf_text(src, 1)
    result = _replace(harness, sid, OLD, NEW, preview=True)
    data = result["data"]
    assert data["preview"] is True
    assert data["replaced"] == 0
    assert len(data["matches"]) == 9
    assert result["changedPages"] == []
    assert pdf_text(_revision(harness, sid), 1) == before


def test_whole_word_case_and_diacritics_options(harness: Harness, tmp_path: Path) -> None:
    src = vi_page(
        tmp_path / "opts.pdf",
        [
            (72, 700, 12, "ABC ABCD abc", False),
            (72, 680, 12, "Nguyễn nguyen", False),
        ],
    )
    sid = _sid(harness, src)
    base = _replace(harness, sid, "abc", "X", preview=True, wholeWord=True)["data"]
    assert [m["before"] for m in base["matches"]] == ["ABC", "abc"]
    exact = _replace(harness, sid, "ABC", "X", preview=True, caseSensitive=True, wholeWord=True)
    assert [m["before"] for m in exact["data"]["matches"]] == ["ABC"]
    folded = _replace(harness, sid, "nguyen", "X", preview=True, ignoreDiacritics=True)
    assert [m["before"] for m in folded["data"]["matches"]] == ["Nguyễn", "nguyen"]
    strict = _replace(harness, sid, "nguyen", "X", preview=True)
    assert [m["before"] for m in strict["data"]["matches"]] == ["nguyen"]


def test_regex_with_group_references(harness: Harness, tmp_path: Path) -> None:
    src = vi_page(tmp_path / "rx.pdf", [(72, 700, 12, "Điều 12 và Điều 34 đã ghi", False)])
    sid = _sid(harness, src)
    result = _replace(harness, sid, r"Điều (\d+)", r"Mục \1", regex=True)
    assert result["data"]["replaced"] == 2
    text = squash(pdf_text(_revision(harness, sid)))
    assert squash("Mục 12 và Mục 34") in text


def test_matches_in_one_line_are_grouped_into_one_rewrite(harness: Harness, tmp_path: Path) -> None:
    src = vi_page(tmp_path / "two.pdf", [(72, 700, 12, "ABC và ABC", False)])
    sid = _sid(harness, src)
    result = _replace(harness, sid, "ABC", "Đại Việt")
    data = result["data"]
    assert data["replaced"] == 2
    assert len({m["lineId"] for m in data["matches"]}) == 1
    assert squash("Đại Việt và Đại Việt") in squash(pdf_text(_revision(harness, sid)))


def test_artifact_text_is_skipped(harness: Harness, tmp_path: Path) -> None:
    content = (
        b"/Artifact <</Type /Pagination /Subtype /Watermark>> BDC "
        b"BT /F1 12 Tf 72 500 Td (ABC mark) Tj ET EMC "
        b"BT /F1 12 Tf 72 700 Td (ABC body) Tj ET"
    )
    src = raw_pdf(tmp_path / "wm.pdf", content)
    sid = _sid(harness, src)
    result = _replace(harness, sid, "ABC", "XYZ")
    data = result["data"]
    assert len(data["matches"]) == 1
    assert [s["reason"] for s in data["skipped"]] == ["ARTIFACT"]
    text = pdf_text(_revision(harness, sid))
    assert "XYZ body" in text and "ABC mark" in text, "the watermark is left as it is"


def test_text_no_font_has_is_skipped_with_the_reason(harness: Harness, tmp_path: Path) -> None:
    src = contract_pdf(tmp_path / "contract.pdf", 1)
    sid = _sid(harness, src)
    data = _replace(harness, sid, "Điều khoản", "中国 條款", preview=True)["data"]
    assert data["matches"] == []
    assert {s["reason"] for s in data["skipped"]} == {"TEXT_GLYPH_MISSING"}
    assert data["skipped"][0]["missing"] == ["中", "国", "條", "款"]


def test_keep_strategy_skips_lines_that_need_a_new_font(harness: Harness, tmp_path: Path) -> None:
    src = contract_pdf(tmp_path / "contract.pdf", 1)
    sid = _sid(harness, src)
    data = _replace(harness, sid, OLD, NEW, fontStrategy="keep", preview=True)["data"]
    assert data["matches"] == []
    assert {s["reason"] for s in data["skipped"]} == {"TEXT_GLYPH_MISSING"}


def test_empty_find_is_an_invalid_request(harness: Harness, tmp_path: Path) -> None:
    src = contract_pdf(tmp_path / "contract.pdf", 1)
    sid = _sid(harness, src)
    with pytest.raises(RpcFailure):
        _replace(harness, sid, "", "x")


def test_fifty_pages_finish_in_twenty_seconds(harness: Harness, tmp_path: Path) -> None:
    src = contract_pdf(tmp_path / "big.pdf", 50)
    sid = _sid(harness, src)
    started = time.perf_counter()
    result = _replace(harness, sid, OLD, NEW)
    elapsed = time.perf_counter() - started
    assert result["data"]["replaced"] == 150
    assert elapsed < 20, f"took {elapsed:.1f}s"
