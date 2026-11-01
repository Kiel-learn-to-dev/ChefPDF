"""T10.04 (N4): the intermediate representation and the Markdown exporter."""

from __future__ import annotations

import unicodedata
from pathlib import Path

import pytest
from export_support import LINK, reference_model, reference_pdf

from chef_core.errors import ChefError
from chef_core.export.assets import Assets
from chef_core.export.ir import (
    DocIR,
    Heading,
    ImageBlock,
    ListBlock,
    Para,
    TableBlock,
    build_ir,
    grid_of,
)
from chef_core.export.markdown import write_markdown
from chef_core.export.options import ExportOptions
from chef_core.layout import model as m


def _ir(
    opts: ExportOptions | None = None,
    pages: list[int] | None = None,
    assets: Assets | None = None,
) -> DocIR:
    return build_ir(reference_model(), assets, opts or ExportOptions(), pages)


def test_items_follow_reading_order_and_furniture_is_left_out() -> None:
    ir = _ir()
    roles = [it.role for it in ir.items if isinstance(it, Para)]
    assert "header" not in roles and "pagenumber" not in roles and "footer" not in roles
    headings = [it for it in ir.items if isinstance(it, Heading)]
    assert [h.level for h in headings] == [1, 2, 1]
    assert headings[0].runs[0].text == "Chương 1: Tổng quan"


def test_furniture_is_kept_with_role_when_asked() -> None:
    ir = _ir(ExportOptions(include_headers_footers=True))
    roles = {it.role for it in ir.items if isinstance(it, Para)}
    assert {"header", "pagenumber", "footer"} <= roles


def test_every_block_kind_is_represented() -> None:
    ir = _ir()
    assert any(isinstance(it, ListBlock) for it in ir.items)
    assert any(isinstance(it, TableBlock) for it in ir.items)
    assert any(isinstance(it, ImageBlock) and it.kind == "image" for it in ir.items)
    assert any(isinstance(it, ImageBlock) and it.kind == "figure" for it in ir.items)
    assert sum(isinstance(it, Para) and it.role == "footnote" for it in ir.items) == 2
    assert any(isinstance(it, Para) and it.role == "unknown" for it in ir.items)
    assert any(type(it).__name__ == "Rule" for it in ir.items)


def test_list_markers_are_not_duplicated_in_the_text() -> None:
    ir = _ir()
    first = next(it for it in ir.items if isinstance(it, ListBlock))
    assert [n.runs[0].text for n in first.items] == ["Mục một", "Mục hai"]
    child = first.items[0].children[0]
    assert child.marker == "a."
    assert child.runs[0].text == "Mục con a"


def test_merged_table_grid_places_spans() -> None:
    ir = _ir()
    table = next(it for it in ir.items if isinstance(it, TableBlock))
    assert table.columns == 3 and len(table.rows) == 3
    anchor = table.rows[0][0]
    assert (anchor.row_span, anchor.col_span) == (2, 1)
    assert table.rows[1][0].covered
    assert table.rows[0][2].covered
    assert table.rows[1][1].paras[0][0].text == "Q1"
    assert table.merged


def test_grid_of_pads_short_rows() -> None:
    block = m.Table(
        bbox=(0, 0, 1, 1),
        columns=2,
        rows=[[m.TableCell(blocks=[])], [m.TableCell(blocks=[]), m.TableCell(blocks=[])]],
    )
    rows, width = grid_of(block)
    assert width == 2
    assert len(rows) == 2 and all(len(r) == 2 for r in rows)


def test_page_selection_and_unknown_page_error() -> None:
    ir = _ir(pages=[1])
    assert ir.page_indices == [1]
    heads = [it.runs[0].text for it in ir.items if isinstance(it, Heading)]
    assert heads == ["Chương 2: Kết luận"]
    with pytest.raises(ChefError) as exc:
        _ir(pages=[9])
    assert exc.value.kind.value == "INVALID_PARAMS"


def test_missing_image_is_reported_not_invented() -> None:
    ir = _ir()
    image = next(it for it in ir.items if isinstance(it, ImageBlock) and it.kind == "image")
    assert image.asset is None
    assert image.caption == "Hình 1. Ảnh minh họa"
    assert any(w.startswith("IMAGE_NOT_EXTRACTED") for w in ir.warnings)


def test_figure_is_rendered_from_the_page(tmp_path: Path) -> None:
    pdf = reference_pdf(tmp_path / "ref.pdf")
    with Assets(pdf) as assets:
        ir = build_ir(reference_model(), assets, ExportOptions())
    figure = next(it for it in ir.items if isinstance(it, ImageBlock) and it.kind == "figure")
    assert figure.asset is not None
    assert figure.asset.data.startswith(b"\x89PNG")


def test_text_is_nfc_and_free_of_xml_invalid_characters() -> None:
    ir = _ir()
    texts = [r.text for it in ir.items if isinstance(it, Heading | Para) for r in it.runs]
    assert texts and all(unicodedata.is_normalized("NFC", t) for t in texts)
    assert all("\x00" not in t for t in texts)


def test_markdown_structure(tmp_path: Path) -> None:
    out = tmp_path / "tai-lieu.md"
    result = write_markdown(_ir(), out)
    text = out.read_text(encoding="utf-8")
    assert text.startswith("# Chương 1: Tổng quan\n")
    assert "\n## 1.1 Danh sách\n" in text
    assert "**đoạn đậm**" in text
    assert "*nghiêng*" in text
    assert f"[liên kết]({LINK})" in text
    assert "<sup>2</sup>" in text
    assert "\\*sao\\*" in text and "\\[ngoặc\\]" in text and "\\| ống" in text
    assert "\\_gạch\\_" in text
    assert "\\<thẻ\\>" in text and "& " in text
    assert result.stats["images"] == 0
    assert any(w.startswith("IMAGE_NOT_EXTRACTED") for w in result.warnings)


def test_markdown_lists_nest_with_marker_width(tmp_path: Path) -> None:
    out = tmp_path / "a.md"
    write_markdown(_ir(), out)
    lines = out.read_text(encoding="utf-8").splitlines()
    assert "1. Mục một" in lines
    assert "   1. Mục con a" in lines  # child of an ordered item: 3 spaces for "1. "
    assert "2. Mục hai" in lines
    assert "- Gạch đầu dòng" in lines
    assert "  - Con" in lines


def test_gfm_tables_have_header_separator_and_rows(tmp_path: Path) -> None:
    out = tmp_path / "t.md"
    result = write_markdown(_ir(), out)
    lines = out.read_text(encoding="utf-8").splitlines()
    table = [ln for ln in lines if ln.startswith("|")]
    assert table == [
        "| **Tên** | **Số liệu** |  |",
        "| --- | --- | --- |",
        "|  | Q1 | Q2 |",
        "| Ann<br>Lee | 10 | 20,5 |",
    ]
    assert "MERGED_CELLS_FLATTENED" in result.warnings


def test_footnotes_and_rules(tmp_path: Path) -> None:
    out = tmp_path / "f.md"
    write_markdown(_ir(), out)
    text = out.read_text(encoding="utf-8")
    assert "[^1]: Chú thích đầu trang." in text
    assert "[^f" in text and "]: Ghi chú khác." in text
    assert "\n---\n" in text


def test_markdown_is_deterministic(tmp_path: Path) -> None:
    first = tmp_path / "1.md"
    second = tmp_path / "2.md"
    write_markdown(_ir(), first)
    write_markdown(_ir(), second)
    assert first.read_bytes() == second.read_bytes()


def test_markdown_images_go_to_a_folder_with_relative_links(tmp_path: Path) -> None:
    pdf = reference_pdf(tmp_path / "ref.pdf")
    with Assets(pdf) as assets:
        ir = build_ir(reference_model(), assets, ExportOptions())
    out = tmp_path / "doc.md"
    result = write_markdown(ir, out)
    text = out.read_text(encoding="utf-8")
    assert "![Hình 2. Hình vẽ](doc_files/img-001.png)" in text
    assert (tmp_path / "doc_files" / "img-001.png").is_file()
    assert result.stats["images"] == 1
