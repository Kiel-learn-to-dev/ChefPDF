"""T10.06 (N6): "Làm mới tài liệu": a new PDF typeset from the model. Checked with pypdfium2 (text,
page count, sizes) and pikepdf (outline entries, images)."""

from __future__ import annotations

from pathlib import Path

import pikepdf
import pypdfium2 as pdfium
from export_support import reference_model, reference_pdf
from layout_support import report_pdf

from chef_core.export.assets import Assets
from chef_core.export.ir import build_ir
from chef_core.export.options import ExportOptions
from chef_core.export.refresh import write_refresh
from chef_core.export.run import run_refresh
from chef_core.layout.detect import build_doc_model
from chef_core.pdf.io import open_pdf


def _text(path: Path) -> str:
    doc = pdfium.PdfDocument(str(path))
    try:
        return "\n".join(doc[i].get_textpage().get_text_range() for i in range(len(doc)))
    finally:
        doc.close()


def _refresh(
    tmp_path: Path, name: str, opts: ExportOptions | None = None, pdf: Path | None = None
) -> Path:
    out = tmp_path / name
    model = reference_model()
    run_refresh(model, pdf, None, out, None, opts or ExportOptions(), name="tai-lieu-mau")
    return out


def test_refresh_writes_a_pdf_with_the_model_pages(tmp_path: Path) -> None:
    out = _refresh(tmp_path, "r.pdf")
    with pikepdf.open(out) as pdf:
        # reflow: the content of two source pages is typeset on one A4 page (no forced breaks)
        assert len(pdf.pages) == 1
        box = pdf.pages[0].MediaBox
        assert abs(float(box[2]) - 595.28) < 1 and abs(float(box[3]) - 841.89) < 1


def test_refresh_text_is_in_reading_order_and_vietnamese(tmp_path: Path) -> None:
    out = _refresh(tmp_path, "r.pdf")
    text = _text(out)
    assert "Chương 1: Tổng quan" in text
    assert "đoạn đậm" in text
    assert "Kết luận" in text
    assert text.index("Chương 1") < text.index("Chương 2")
    assert "Q1" in text and "Ann" in text
    assert "Trang 1" in text


def test_refresh_bookmarks_come_from_headings(tmp_path: Path) -> None:
    out = _refresh(tmp_path, "r.pdf")
    with pikepdf.open(out) as pdf, pdf.open_outline() as outline:
        top = [item.title for item in outline.root]
        assert top == ["Chương 1: Tổng quan", "Chương 2: Kết luận"]
        children = [c.title for c in outline.root[0].children]
        assert children == ["1.1 Danh sách"]


def test_refresh_letter_and_source_page_sizes(tmp_path: Path) -> None:
    letter = _refresh(tmp_path, "letter.pdf", ExportOptions(page_size="Letter"))
    with pikepdf.open(letter) as pdf:
        assert abs(float(pdf.pages[0].MediaBox[2]) - 612) < 1
    source = _refresh(tmp_path, "source.pdf", ExportOptions(page_size="source"))
    with pikepdf.open(source) as pdf:
        assert abs(float(pdf.pages[0].MediaBox[2]) - 595) < 1


def test_refresh_includes_images_and_figures(tmp_path: Path) -> None:
    pdf_src = reference_pdf(tmp_path / "ref.pdf")
    out = _refresh(tmp_path, "img.pdf", pdf=pdf_src)
    with pikepdf.open(out) as pdf:
        images = 0
        for page in pdf.pages:
            xobjects = page.get("/Resources", {}).get("/XObject", {})
            images += sum(1 for name in xobjects if xobjects[name].get("/Subtype") == "/Image")
    assert images >= 1


def test_refresh_header_and_footer_only_when_asked(tmp_path: Path) -> None:
    plain = _text(_refresh(tmp_path, "plain.pdf"))
    assert "Báo cáo mẫu" not in plain
    with_furniture = _text(
        _refresh(tmp_path, "furn.pdf", ExportOptions(include_headers_footers=True))
    )
    assert "Báo cáo mẫu" in with_furniture


def test_refresh_font_scale_changes_the_layout(tmp_path: Path) -> None:
    small = _refresh(tmp_path, "s.pdf", ExportOptions(font_scale=0.8))
    large = _refresh(tmp_path, "l.pdf", ExportOptions(font_scale=1.4))
    with pikepdf.open(small) as a, pikepdf.open(large) as b:
        assert len(b.pages) >= len(a.pages)
    assert small.stat().st_size != large.stat().st_size


def test_refresh_of_a_two_column_report_keeps_the_text(tmp_path: Path) -> None:
    src = report_pdf(tmp_path / "report.pdf", pages=3)
    with open_pdf(src) as pdf:
        model = build_doc_model(pdf, None, name="report").model
    ir = build_ir(model, None, ExportOptions())
    out = tmp_path / "report-r.pdf"
    write_refresh(ir, out, ExportOptions())
    text = _text(out)
    headings = [
        "".join(r.text for r in it.runs) for it in ir.items if type(it).__name__ == "Heading"
    ]
    assert headings, "the report has headings"
    positions = [text.find(h) for h in headings]
    assert all(p >= 0 for p in positions), headings
    assert positions == sorted(positions), "headings keep their reading order"


def test_refresh_with_assets_keeps_one_page_per_reflow(tmp_path: Path) -> None:
    pdf_src = reference_pdf(tmp_path / "ref.pdf")
    with Assets(pdf_src) as assets:
        ir = build_ir(reference_model(), assets, ExportOptions())
    first = tmp_path / "1.pdf"
    write_refresh(ir, first, ExportOptions())
    with pikepdf.open(first) as pdf:
        assert len(pdf.pages) == 1
