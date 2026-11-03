"""T10.01: rule-based analysis (N1): reading order, headings, lists, repeated furniture, joins,
captions, figures, warnings, determinism and speed. Fixtures are generated PDFs (see
layout_support.py); real-world documents are not covered by these tests."""

from __future__ import annotations

import time
import unicodedata
from pathlib import Path

import pikepdf
from layout_support import (
    articles_pdf,
    drawn_figure_pdf,
    paragraph_pages_pdf,
    report_pdf,
    scanned_page_pdf,
)
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from text_support import BOLD, REG, register_fonts

from chef_core.layout.detect import DetectOptions, build_doc_model
from chef_core.layout.model import DocModel, Heading, ListBlock, Paragraph, Table, dump_json

MID_X = 300.0  # the two columns of the report are left of, and right of, this x


def _doc(path: Path, pages: list[int] | None = None, **kw: bool) -> DocModel:
    with pikepdf.open(path) as pdf:
        return build_doc_model(pdf, pages, DetectOptions(**kw)).model


def _text(block: object) -> str:
    runs = getattr(block, "runs", [])
    return "".join(r.text for r in runs)


def _page(model: DocModel, index: int) -> list[object]:
    return list(model.pages[index].blocks)


def _find(model: DocModel, kind: str, contains: str) -> object:
    for page in model.pages:
        for block in page.blocks:
            if block.kind == kind and contains in _text(block):
                return block
    raise AssertionError(f"no {kind} containing {contains!r}")


def _kinds(blocks: list[object]) -> list[str]:
    return [b.kind for b in blocks]  # type: ignore[attr-defined]


# -- two-column report with furniture -----------------------------------------------------


def test_report_has_six_pages_and_two_columns(tmp_path: Path) -> None:
    path = report_pdf(tmp_path / "report.pdf", pages=6)
    with pikepdf.open(path) as pdf:
        assert len(pdf.pages) == 6
        analysis = build_doc_model(pdf)
    assert analysis.model.source.page_count == 6
    assert [analysis.columns[i] for i in range(5)] == [2, 2, 2, 2, 2]


def test_reading_order_is_left_column_then_right_column(tmp_path: Path) -> None:
    model = _doc(report_pdf(tmp_path / "report.pdf", pages=6))
    blocks = _page(model, 2)
    body = [b for b in blocks if b.kind not in ("header", "footer", "pageNumber")]
    left = [i for i, b in enumerate(body) if b.bbox[0] < MID_X - 20]
    right = [i for i, b in enumerate(body) if b.bbox[0] > MID_X - 20 and b.bbox[2] < 560]
    assert left and right
    assert max(left) < min(right), "every left-column block comes before the right column"
    orders = [b.reading_order for b in blocks]
    assert orders == sorted(orders)


def test_title_comes_first_and_is_heading_level_one(tmp_path: Path) -> None:
    model = _doc(report_pdf(tmp_path / "report.pdf", pages=6))
    first = model.pages[0].blocks[1]  # after the running header
    assert first.kind == "heading" and first.level == 1
    assert "Báo cáo thường niên" in _text(first)
    assert first.reading_order == 1
    below = [b.bbox[1] for b in model.pages[0].blocks[2:] if b.kind not in ("footer", "pageNumber")]
    assert first.bbox[3] <= min(below), "the title ends above the columns"


def test_heading_levels_follow_font_size_clusters(tmp_path: Path) -> None:
    model = _doc(report_pdf(tmp_path / "report.pdf", pages=6))
    h1 = _find(model, "heading", "1. Giới thiệu")
    h2 = _find(model, "heading", "1.1 Phạm vi báo cáo")
    end = _find(model, "heading", "2. Kết luận")
    assert isinstance(h1, Heading) and isinstance(h2, Heading) and isinstance(end, Heading)
    assert h1.level == end.level == 2
    assert h2.level == 3
    assert h1.level < h2.level


def test_list_items_nest_by_indent_with_markers(tmp_path: Path) -> None:
    model = _doc(report_pdf(tmp_path / "report.pdf", pages=6))
    lists = [b for p in model.pages for b in p.blocks if b.kind == "list"]
    assert len(lists) == 1
    lst = lists[0]
    assert isinstance(lst, ListBlock) and lst.ordered is True
    assert [item.marker for item in lst.items] == ["1.", "2.", "3."]
    assert all(item.bbox is not None for item in lst.items)
    nested = lst.items[1].children
    assert [item.marker for item in nested] == ["a.", "b."]
    assert all(item.bbox is not None for item in nested)
    assert "".join(r.text for r in nested[0].runs).startswith("a. con a")


def test_table_cells_and_header_row(tmp_path: Path) -> None:
    model = _doc(report_pdf(tmp_path / "report.pdf", pages=6))
    tables = [b for p in model.pages for b in p.blocks if b.kind == "table"]
    assert len(tables) == 1
    table = tables[0]
    assert isinstance(table, Table) and table.has_header_row and table.columns == 4
    texts = [
        [" ".join(r.text for blk in cell.blocks for r in blk.runs) for cell in row]
        for row in table.rows
    ]
    assert texts == [
        ["Quý", "Doanh thu", "Chi phí", "Lợi nhuận"],
        ["Quý 1", "120", "80", "40"],
        ["Quý 2", "135", "86", "49"],
    ]


def test_image_takes_its_caption(tmp_path: Path) -> None:
    model = _doc(report_pdf(tmp_path / "report.pdf", pages=6))
    images = [b for p in model.pages for b in p.blocks if b.kind == "image"]
    assert len(images) == 1
    assert images[0].caption == "Hình 1. Doanh thu theo quý"
    assert images[0].image_ref and images[0].image_ref.startswith("p")


def test_repeated_header_footer_and_page_numbers_are_removed_from_the_flow(tmp_path: Path) -> None:
    model = _doc(report_pdf(tmp_path / "report.pdf", pages=6))
    headers = [b for p in model.pages for b in p.blocks if b.kind == "header"]
    footers = [b for p in model.pages for b in p.blocks if b.kind == "footer"]
    numbers = [b for p in model.pages for b in p.blocks if b.kind == "pageNumber"]
    assert len(headers) == len(footers) == len(numbers) == 6
    assert [_text(n) for n in numbers] == [f"Trang {i}" for i in range(1, 7)]
    for page in model.pages:
        for block in page.blocks:
            if block.kind not in ("header", "footer", "pageNumber"):
                assert "Bí mật nội bộ" not in _text(block)
                assert "Báo cáo thường niên 2026" not in _text(block)


def test_keeping_repeated_lines_leaves_them_in_the_flow(tmp_path: Path) -> None:
    model = _doc(report_pdf(tmp_path / "report.pdf", pages=6), drop_repeated=False)
    assert not any(b.kind in ("header", "footer") for p in model.pages for b in p.blocks)
    texts = [_text(b) for b in _page(model, 1) if b.kind == "paragraph"]
    assert any("Bí mật nội bộ" in t for t in texts)


def test_paragraph_continues_across_the_page_break(tmp_path: Path) -> None:
    model = _doc(report_pdf(tmp_path / "report.pdf", pages=6))
    joined = [
        b for p in model.pages for b in p.blocks if isinstance(b, Paragraph) and b.joined_pages
    ]
    assert joined, "a paragraph running over a break is one block"
    first = joined[0]
    assert first.joined_pages[0] > 0
    assert len(_text(first)) > 200


def test_vietnamese_text_is_nfc_and_language_is_vi(tmp_path: Path) -> None:
    model = _doc(report_pdf(tmp_path / "report.pdf", pages=6))
    assert model.meta.lang == "vi"
    for page in model.pages:
        for block in page.blocks:
            for run in getattr(block, "runs", []):
                assert unicodedata.is_normalized("NFC", run.text)


def test_styles_describe_the_body_and_heading_levels(tmp_path: Path) -> None:
    model = _doc(report_pdf(tmp_path / "report.pdf", pages=6))
    assert model.styles["body"].size == 10
    assert model.styles["heading2"].size == 16


def test_analysis_is_deterministic(tmp_path: Path) -> None:
    path = report_pdf(tmp_path / "report.pdf", pages=6)
    with pikepdf.open(path) as pdf:
        first = dump_json(build_doc_model(pdf).model)
        second = dump_json(build_doc_model(pdf).model)
    assert first == second


# -- single column contract ---------------------------------------------------------------


def test_articles_are_headings_with_their_bodies(tmp_path: Path) -> None:
    model = _doc(articles_pdf(tmp_path / "articles.pdf", articles=4))
    blocks = _page(model, 0)
    heads = [b for b in blocks if b.kind == "heading"]
    assert [_text(h).split(".")[0] for h in heads[1:]] == ["Điều 1", "Điều 2", "Điều 3", "Điều 4"]
    assert all(h.level == 2 for h in heads[1:])
    assert heads[0].level == 1
    paragraphs = [b for b in blocks if b.kind == "paragraph"]
    assert len(paragraphs) == 4
    assert all("cam kết thực hiện" in _text(p) for p in paragraphs)
    orders = [b.reading_order for b in blocks]
    assert orders == list(range(len(blocks)))


# -- scanned, figures, rotated -------------------------------------------------------------


def test_scanned_page_is_reported_and_kept_as_an_image(tmp_path: Path) -> None:
    path = scanned_page_pdf(tmp_path / "scan.pdf")
    with pikepdf.open(path) as pdf:
        analysis = build_doc_model(pdf)
    codes = [w["code"] for w in analysis.warnings]
    assert "PAGE_HAS_NO_TEXT_LAYER" in codes
    blocks = analysis.model.pages[0].blocks
    assert [b.kind for b in blocks] == ["image"]


def test_vector_chart_is_a_figure_with_its_caption(tmp_path: Path) -> None:
    model = _doc(drawn_figure_pdf(tmp_path / "fig.pdf"))
    blocks = _page(model, 0)
    assert _kinds(blocks) == ["paragraph", "figure"]
    assert blocks[1].caption == "Hình 2. Doanh thu theo tháng"


def test_rotated_text_is_skipped_with_a_warning(tmp_path: Path) -> None:
    register_fonts()
    path = tmp_path / "rot.pdf"
    cv = canvas.Canvas(str(path), pagesize=A4)
    cv.setFont(REG, 10)
    cv.drawString(72, 700, "Đoạn văn nằm ngang bình thường.")
    cv.saveState()
    cv.translate(200, 300)
    cv.rotate(90)
    cv.setFont(BOLD, 12)
    cv.drawString(0, 0, "Chữ xoay đứng")
    cv.restoreState()
    cv.showPage()
    cv.save()
    with pikepdf.open(path) as pdf:
        analysis = build_doc_model(pdf)
    assert any(w["code"] == "ROTATED_TEXT_SKIPPED" for w in analysis.warnings)
    assert "Chữ xoay" not in " ".join(_text(b) for b in analysis.model.pages[0].blocks)


def test_empty_page_has_no_warning(tmp_path: Path) -> None:
    path = paragraph_pages_pdf(tmp_path / "p.pdf", 1, lambda i: "Trang đầu\nNội dung")
    with pikepdf.open(path) as pdf:
        analysis = build_doc_model(pdf)
    assert analysis.warnings == []


# -- performance ----------------------------------------------------------------------------


def test_fifty_pages_analyse_in_under_twenty_seconds(tmp_path: Path) -> None:
    def body(i: int) -> str:
        return (
            f"Chương {i + 1} Tổng quan\n"
            "Đoạn văn thứ nhất của trang có dấu tiếng Việt đầy đủ và dài đủ để xuống dòng.\n"
            "Đoạn văn thứ hai tiếp tục nội dung của trang này."
        )

    path = paragraph_pages_pdf(tmp_path / "fifty.pdf", 50, body)
    started = time.monotonic()
    with pikepdf.open(path) as pdf:
        model = build_doc_model(pdf).model
    elapsed = time.monotonic() - started
    assert len(model.pages) == 50
    assert elapsed < 20, f"50 pages took {elapsed:.1f} s"


def test_options_are_respected(tmp_path: Path) -> None:
    model = _doc(report_pdf(tmp_path / "report.pdf", pages=6), detect_tables=False)
    assert not any(b.kind == "table" for p in model.pages for b in p.blocks)
    model = _doc(report_pdf(tmp_path / "report.pdf", pages=6), join_across_pages=False)
    assert not any(b.kind == "paragraph" and b.joined_pages for p in model.pages for b in p.blocks)
