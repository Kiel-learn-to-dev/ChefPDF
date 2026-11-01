"""T10.04 (N4): HTML5, plain text and JSON exports."""

from __future__ import annotations

import json
from html.parser import HTMLParser
from pathlib import Path

from export_support import reference_model, reference_pdf

from chef_core.export.assets import Assets
from chef_core.export.html import write_html
from chef_core.export.ir import build_ir
from chef_core.export.jsonout import write_json
from chef_core.export.options import ExportOptions
from chef_core.export.txt import write_txt
from chef_core.layout.model import DocModel


class _Tags(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tags: list[str] = []
        self.attrs: list[dict[str, str | None]] = []
        self.stack: list[str] = []
        self.balanced = True

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.tags.append(tag)
        self.attrs.append(dict(attrs))
        if tag not in ("br", "hr", "img", "meta", "link"):
            self.stack.append(tag)

    def handle_endtag(self, tag: str) -> None:
        if not self.stack or self.stack[-1] != tag:
            self.balanced = False
        elif self.stack:
            self.stack.pop()


def _parse(text: str) -> _Tags:
    parser = _Tags()
    parser.feed(text)
    parser.close()
    return parser


def _ir(opts: ExportOptions | None = None, assets: Assets | None = None):  # type: ignore[no-untyped-def]
    return build_ir(reference_model(), assets, opts or ExportOptions())


def test_html_is_html5_with_lang_vi_and_embedded_css(tmp_path: Path) -> None:
    out = tmp_path / "doc.html"
    write_html(_ir(), out, embed=False)
    text = out.read_text(encoding="utf-8")
    assert text.startswith("<!DOCTYPE html>")
    assert '<html lang="vi">' in text
    assert '<meta charset="utf-8">' in text
    assert "<style>" in text and "Be Vietnam Pro" in text
    parsed = _parse(text)
    assert parsed.balanced
    assert {"h1", "h2", "ul", "ol", "table", "thead", "th", "td", "section", "figure"} <= set(
        parsed.tags
    )


def test_html_tables_keep_spans_and_header_row(tmp_path: Path) -> None:
    out = tmp_path / "t.html"
    write_html(_ir(), out, embed=False)
    text = out.read_text(encoding="utf-8")
    assert '<th rowspan="2">' in text
    assert '<th colspan="2">' in text
    assert "<thead>" in text and "<tbody>" in text
    assert "Lee" in text


def test_html_escapes_text_and_keeps_links(tmp_path: Path) -> None:
    out = tmp_path / "e.html"
    write_html(_ir(), out, embed=False)
    text = out.read_text(encoding="utf-8")
    assert "&lt;thẻ&gt;" in text
    assert 'href="https://example.com/ban-quyen"' in text
    assert "<sup>2</sup>" in text


def test_html_images_are_files_or_embedded(tmp_path: Path) -> None:
    pdf = reference_pdf(tmp_path / "ref.pdf")
    with Assets(pdf) as assets:
        ir = build_ir(reference_model(), assets, ExportOptions())
    out = tmp_path / "f.html"
    write_html(ir, out, embed=False)
    assert 'src="f_files/img-001.png"' in out.read_text(encoding="utf-8")
    assert (tmp_path / "f_files" / "img-001.png").is_file()
    embedded = tmp_path / "e.html"
    result = write_html(ir, embedded, embed=True)
    assert "data:image/png;base64," in embedded.read_text(encoding="utf-8")
    assert result.stats["images"] == 1
    assert not (tmp_path / "e_files").exists()


def test_html_sections_per_page(tmp_path: Path) -> None:
    out = tmp_path / "p.html"
    write_html(_ir(), out, embed=False)
    text = out.read_text(encoding="utf-8")
    assert text.count('<section class="page"') == 2


def test_txt_reading_order_tables_and_page_markers(tmp_path: Path) -> None:
    out = tmp_path / "t.txt"
    write_txt(_ir(), out, page_markers=True)
    text = out.read_text(encoding="utf-8")
    assert text.startswith("--- Trang 1 ---")
    assert "--- Trang 2 ---" in text
    assert text.index("Chương 1") < text.index("Chương 2")
    assert "Tên\tSố liệu\t" in text
    assert "Q1\tQ2" in text or "\tQ1\tQ2" in text
    assert "  1. Mục con a" not in text
    assert "  a. Mục con a" in text or "  1. Mục con a" in text
    assert "Ann Lee" in text


def test_txt_without_markers_and_utf8_lf(tmp_path: Path) -> None:
    out = tmp_path / "n.txt"
    write_txt(_ir(), out, page_markers=False)
    raw = out.read_bytes()
    assert b"\r" not in raw
    assert "--- Trang" not in raw.decode("utf-8")
    raw.decode("utf-8")


def test_json_is_the_model_with_version_and_text(tmp_path: Path) -> None:
    model = reference_model()
    out = tmp_path / "m.json"
    write_json(model, build_ir(model, None, ExportOptions()), out, None)
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["version"] == 1
    assert data["source"]["pageCount"] == 2
    assert len(data["pages"]) == 2
    assert "text" in data and "Chương 1: Tổng quan" in data["text"]
    assert data["pages"][0]["blocks"][0]["kind"] == "header", "the model is kept as it is"


def test_json_page_selection_filters_pages(tmp_path: Path) -> None:
    model = reference_model()
    out = tmp_path / "one.json"
    write_json(model, build_ir(model, None, ExportOptions(), [1]), out, [1])
    data = json.loads(out.read_text(encoding="utf-8"))
    assert [p["index"] for p in data["pages"]] == [1]
    assert "Chương 2" in data["text"] and "Chương 1" not in data["text"]


def test_text_formats_are_deterministic(tmp_path: Path) -> None:
    for name, writer in (("a.html", "html"), ("a.txt", "txt"), ("a.json", "json")):
        first = tmp_path / ("1" + name)
        second = tmp_path / ("2" + name)
        model = reference_model()
        for target in (first, second):
            ir = build_ir(model, None, ExportOptions())
            if writer == "html":
                write_html(ir, target, embed=False)
            elif writer == "txt":
                write_txt(ir, target)
            else:
                write_json(model, ir, target, None)
        assert first.read_bytes() == second.read_bytes(), name


def test_reference_model_round_trips_through_json() -> None:
    model = reference_model()
    again = DocModel.model_validate_json(model.model_dump_json(by_alias=True))
    assert again == model
