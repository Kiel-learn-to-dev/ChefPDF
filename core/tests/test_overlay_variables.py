"""Variable expansion for headers, footers, page numbers, Bates numbers and bookmark titles
(T4.07): templates, roman and alpha numbering, date tokens, escaping and errors."""

from __future__ import annotations

import datetime as dt

import pytest

from chef_core.errors import ChefError, ErrorKind
from chef_core.overlay.variables import (
    DocVars,
    check_template,
    format_number,
    parse_template,
    to_alpha,
    to_roman,
)
from chef_core.signing.appearance import format_date

NOW = dt.datetime(2026, 11, 1, 14, 5, 9, tzinfo=dt.timezone(dt.timedelta(hours=7)))


def _vars(**overrides: object) -> DocVars:
    base: dict[str, object] = {
        "filename": "HS-2026",
        "title": "Hồ sơ dự án",
        "author": "Nguyễn Văn A",
        "page_count": 10,
        "start_number": 1,
        "date_format": "dd/MM/yyyy",
        "now": NOW,
        "sections": (),
        "bates_prefix": "",
        "bates_suffix": "",
        "bates_digits": 6,
    }
    base.update(overrides)
    return DocVars(**base)  # type: ignore[arg-type]


# -- numbering -------------------------------------------------------------------------------


def test_roman_numerals_up_to_3999() -> None:
    cases = {
        1: "I",
        4: "IV",
        9: "IX",
        14: "XIV",
        40: "XL",
        90: "XC",
        400: "CD",
        1994: "MCMXCIV",
        3999: "MMMCMXCIX",
    }
    for number, text in cases.items():
        assert to_roman(number) == text
    with pytest.raises(ValueError):
        to_roman(0)
    with pytest.raises(ValueError):
        to_roman(4000)


def test_alpha_is_bijective_base_26() -> None:
    assert to_alpha(1) == "A"
    assert to_alpha(26) == "Z"
    assert to_alpha(27) == "AA"
    assert to_alpha(28) == "AB"
    assert to_alpha(52) == "AZ"
    assert to_alpha(53) == "BA"
    assert to_alpha(702) == "ZZ"
    assert to_alpha(703) == "AAA"
    with pytest.raises(ValueError):
        to_alpha(0)


def test_format_number_cases() -> None:
    assert format_number(4, "arabic") == "4"
    assert format_number(4, "roman") == "iv"
    assert format_number(4, "ROMAN") == "IV"
    assert format_number(4, "alpha") == "d"
    assert format_number(4, "ALPHA") == "D"
    assert format_number(28, "ALPHA") == "AB"


def test_format_number_errors_are_invalid_params() -> None:
    for number, fmt in ((4000, "roman"), (0, "alpha"), (0, "ROMAN")):
        with pytest.raises(ChefError) as exc:
            format_number(number, fmt)  # type: ignore[arg-type]
        assert exc.value.kind == ErrorKind.INVALID_PARAMS


# -- templates -------------------------------------------------------------------------------


def test_plain_text_is_kept() -> None:
    assert _vars().render("Tài liệu nội bộ", index=0) == "Tài liệu nội bộ"


def test_doubled_braces_are_literal_braces() -> None:
    assert _vars().render("{{page}} = {page}", index=2) == "{page} = 3"
    assert _vars().render("a }} b", index=0) == "a } b"


def test_page_and_pages_use_the_start_number() -> None:
    doc = _vars(start_number=5)
    assert doc.render("{page}/{pages}", index=0) == "5/14"
    assert doc.render("{page}/{pages}", index=2) == "7/14"


def test_number_format_applies_to_page_and_pages_only() -> None:
    doc = _vars(start_number=5)
    assert doc.render("{page}/{pages}", index=0, number_format="roman") == "v/xiv"
    assert doc.render("{page_roman}", index=0, number_format="alpha") == "V"
    assert doc.render("{page_alpha}", index=2, number_format="roman") == "G"


def test_roman_and_alpha_variables() -> None:
    doc = _vars()
    assert doc.render("{page_roman}", index=2) == "III"
    assert doc.render("{page_alpha}", index=26) == "AA"


def test_document_variables() -> None:
    doc = _vars()
    assert doc.render("{filename}", index=0) == "HS-2026"
    assert doc.render("{title}", index=0) == "Hồ sơ dự án"
    assert doc.render("{author}", index=0) == "Nguyễn Văn A"
    assert doc.render("{author}", index=0) != ""


def test_date_and_time() -> None:
    doc = _vars()
    assert doc.render("{date}", index=0) == "01/11/2026"
    assert doc.render("{time}", index=0) == "14:05"
    assert doc.render("{date}", index=0) == format_date(NOW, "dd/MM/yyyy")


def test_date_format_is_a_token_pattern() -> None:
    doc = _vars(date_format="dd 'tháng' MM 'năm' yyyy")
    assert doc.render("{date}", index=0) == "01 tháng 11 năm 2026"


def test_bates_variable_is_zero_padded_with_prefix_and_suffix() -> None:
    doc = _vars(bates_prefix="HS-", bates_suffix="/A", bates_digits=6)
    assert doc.render("{bates}", index=2) == "HS-000003/A"


def test_section_is_the_last_section_that_started() -> None:
    doc = _vars(sections=((0, "Phần I"), (4, "Phần II")))
    assert doc.render("{section}", index=2) == "Phần I"
    assert doc.render("{section}", index=4) == "Phần II"
    assert _vars().render("[{section}]", index=0) == "[]"


def test_unknown_variable_reports_its_name() -> None:
    with pytest.raises(ChefError) as exc:
        _vars().render("Trang {nam}", index=0)
    assert exc.value.kind == ErrorKind.INVALID_PARAMS
    assert exc.value.detail["variable"] == "nam"


def test_broken_templates_are_invalid_params() -> None:
    for template in ("{page", "page}", "{}", "x } y"):
        with pytest.raises(ChefError) as exc:
            check_template(template)
        assert exc.value.kind == ErrorKind.INVALID_PARAMS, template


def test_check_template_accepts_known_variables() -> None:
    parse_template("{page}/{pages} {{x}} {date} {page_roman} {section}")
    check_template("{page}")


def test_roman_overflow_only_fails_when_the_variable_is_used() -> None:
    doc = _vars(start_number=4000)
    assert doc.render("plain", index=0, number_format="roman") == "plain"
    with pytest.raises(ChefError):
        doc.render("{page}", index=0, number_format="roman")
