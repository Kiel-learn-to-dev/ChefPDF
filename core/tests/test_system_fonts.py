"""Fonts installed on the computer (1.1, D62): names, matching the document's font, and the choice.

The system list is replaced by a fake in these tests: the real list depends on the machine.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from conftest import Harness
from test_text_paragraph import _edit, _page, _paragraph_of, _sid
from text_support import pdf_text, two_column_pdf

from chef_core.text import system_fonts
from chef_core.text.fonts import FontEntry
from chef_core.text.fonts import entry as bundled_entry
from chef_core.text.system_fonts import (
    match_original,
    normalize_base_font,
    parse_display_name,
)


def test_registry_names_give_family_and_style() -> None:
    assert parse_display_name("Times New Roman (TrueType)") == ("Times New Roman", False, False)
    assert parse_display_name("Arial Bold Italic (TrueType)") == ("Arial", True, True)
    assert parse_display_name("Segoe UI Semibold (TrueType)") == ("Segoe UI", True, False)
    assert parse_display_name("Consolas (TrueType)") == ("Consolas", False, False)
    assert parse_display_name("(TrueType)") is None


def test_document_font_names_give_the_family_key() -> None:
    assert normalize_base_font("/ABCDEF+TimesNewRomanPS-BoldItalicMT") == (
        "timesnewroman",
        True,
        True,
    )
    assert normalize_base_font("Arial-BoldMT") == ("arial", True, False)
    assert normalize_base_font("ArialMT") == ("arial", False, False)
    assert normalize_base_font("Calibri,Bold") == ("calibri", True, False)


def _fake(path: Path, family: str, bold: bool = False) -> FontEntry:
    return FontEntry(
        id="sys:fake-" + family.replace(" ", "").lower() + ("-b" if bold else ""),
        file=path,
        family=family,
        style="sans",
        bold=bold,
        italic=False,
        coverage="system",
        license="test",
    )


@pytest.fixture
def regular_file() -> Path:
    item = bundled_entry("BeVietnamPro-Regular")
    assert item is not None
    return item.file


def test_match_prefers_the_same_weight_and_needs_every_character(
    regular_file: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake = (_fake(regular_file, "Be Vietnam Pro", bold=True), _fake(regular_file, "Be Vietnam Pro"))
    monkeypatch.setattr(system_fonts, "system_entries", lambda: fake)
    cps = {ord(c) for c in "Hợp đồng"}
    assert match_original("ABCDEF+BeVietnamPro-Regular", cps, False, False).bold is False  # type: ignore[union-attr]
    assert match_original("BeVietnamPro-Bold", cps, True, False).bold is True  # type: ignore[union-attr]
    assert match_original("Times-Roman", cps, False, False) is None


def test_a_missing_letter_takes_the_installed_font_of_the_same_family(
    harness: Harness, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    bundled = bundled_entry("BeVietnamPro-Regular")
    assert bundled is not None
    fake = _fake(bundled.file, "Be Vietnam Pro")
    monkeypatch.setattr(system_fonts, "system_entries", lambda: (fake,))
    src = two_column_pdf(tmp_path / "two.pdf")
    sid = _sid(harness, src)
    para = _paragraph_of(_page(harness, sid), "Hợp đồng này")
    result = _edit(harness, sid, para["id"], "Ạ ệ ộ ự ẫ tiếng Việt mới.")
    # The document's own font family is kept: it is installed, so it is used, not a bundled one.
    assert result["data"]["fontTo"] == "Be Vietnam Pro"
    assert any("bản đầy đủ của font" in w for w in result["warnings"])
    assert "tiếng Việt mới" in pdf_text(
        Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])
    )


def test_the_document_font_is_named_by_its_family_not_its_basefont() -> None:
    """Name the font by its installed family, or by BaseFont without subset and PS/MT suffixes (D66)."""
    from chef_core.text.fonts import old_font_label

    assert old_font_label("ABCDEF+NoSuchFontPS-BoldMT") == "NoSuchFont"
    if Path("C:/Windows/Fonts/times.ttf").exists():
        assert old_font_label("ABCDEF+TimesNewRomanPS-BoldMT") == "Times New Roman"
