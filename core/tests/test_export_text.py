"""T10.04 helpers: text cleaning, escaping, run merging, font mapping, XLSX value parsing."""

from __future__ import annotations

import unicodedata

from chef_core.export.fonts import css_stack, font_class, installed_name
from chef_core.export.html import inline as html_inline
from chef_core.export.markdown import inline as md_inline
from chef_core.export.text import (
    clean,
    clean_runs,
    html_escape,
    md_escape,
    md_line_start,
    merge_runs,
    squash,
    wrap_marks,
)
from chef_core.export.xlsx import parse_value
from chef_core.layout.model import Run


def test_clean_is_nfc_and_drops_xml_invalid_characters() -> None:
    decomposed = unicodedata.normalize("NFD", "Nguyễn")
    assert clean(decomposed) == "Nguyễn"
    assert clean("a\x00b\x0bc") == "abc"


def test_squash_collapses_whitespace_and_line_breaks() -> None:
    assert squash("  một\n  hai\t ba ") == "một hai ba"


def test_md_escape_protects_markdown_specials() -> None:
    assert md_escape("*a* _b_ [c] <d> | e ~f~ `g` \\h") == (
        "\\*a\\* \\_b\\_ \\[c\\] \\<d\\> \\| e \\~f\\~ \\`g\\` \\\\h"
    )


def test_md_line_start_escapes_block_markers() -> None:
    assert md_line_start("# không tiêu đề") == "\\# không tiêu đề"
    assert md_line_start("- gạch") == "\\- gạch"
    assert md_line_start("3. mục") == "3\\. mục"
    assert md_line_start("> trích") == "\\> trích"
    assert md_line_start("bình thường") == "bình thường"


def test_html_escape_escapes_markup() -> None:
    assert html_escape('a<b>&"c"') == "a&lt;b&gt;&amp;&quot;c&quot;"


def test_wrap_marks_keeps_edge_spaces_outside() -> None:
    assert wrap_marks(" đậm ", "**") == " **đậm** "
    assert wrap_marks("   ", "**") == "   "


def test_merge_runs_joins_neighbours_with_the_same_style() -> None:
    runs = [Run(text="a"), Run(text="b"), Run(text="c", bold=True), Run(text="d", bold=True)]
    merged = merge_runs(runs)
    assert [(r.text, r.bold) for r in merged] == [("ab", False), ("cd", True)]


def test_clean_runs_drops_empty_and_trims_the_block_edges() -> None:
    runs = clean_runs([Run(text="  "), Run(text=" xin  chào "), Run(text=" ")])
    assert [r.text for r in runs] == ["xin chào"]


def test_inline_markdown_and_html_agree_on_emphasis_and_links() -> None:
    runs = [
        Run(text="đậm", bold=True),
        Run(text=" & ", italic=False),
        Run(text="link", link="https://example.com/a"),
    ]
    md = md_inline(runs)
    html = html_inline(runs)
    assert md == "**đậm** & [link](https://example.com/a)"
    assert html == '<strong>đậm</strong> &amp; <a href="https://example.com/a">link</a>'


def test_non_web_links_are_not_turned_into_links() -> None:
    assert "](" not in md_inline([Run(text="x", link="page:3")])
    assert "<a " not in html_inline([Run(text="x", link="file.pdf")])


def test_font_mapping_keeps_be_vietnam_pro_and_maps_by_class() -> None:
    assert installed_name("BeVietnamPro-Regular") == "Be Vietnam Pro"
    assert installed_name("Times-Roman") == "Times New Roman"
    assert installed_name("Courier") == "Courier New"
    assert installed_name("Helvetica") == "Arial"
    assert installed_name(None) == "Arial"
    assert font_class("Georgia-Bold") == "serif"
    assert "Be Vietnam Pro" in css_stack("Arial")
    assert css_stack("Times").endswith("serif")


def test_parse_value_vietnamese_numbers_and_dates() -> None:
    assert parse_value("1.234,56", True) == (1234.56, None)
    assert parse_value("1.234", True) == (1234, None)
    assert parse_value("12,5", True) == (12.5, None)
    assert parse_value("42", True) == (42, None)
    value, fmt = parse_value("31/12/2026", True)
    assert fmt == "dd/mm/yyyy" and value.year == 2026
    assert parse_value("31/02/2026", True) == ("31/02/2026", None)


def test_parse_value_keeps_codes_and_formulas_as_text() -> None:
    assert parse_value("007", True) == ("007", None)
    assert parse_value("=SUM(A1)", True) == ("=SUM(A1)", None)
    assert parse_value("1.234,56", False) == ("1.234,56", None)
    assert parse_value("12-3", True) == ("12-3", None)
