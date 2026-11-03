"""T10.08: generated contents pages, Vietnamese text, physical page numbers and links."""

from __future__ import annotations

from pathlib import Path

import pikepdf
import pypdfium2 as pdfium
import pytest
from conftest import Harness, RpcFailure
from layout_support import report_pdf

from chef_core.layout.toc_page import insert_contents


def _toc_text(path: Path, index: int) -> str:
    doc = pdfium.PdfDocument(path)
    try:
        return doc[index].get_textpage().get_text_range()
    finally:
        doc.close()


def test_insert_contents_page_has_vietnamese_text_correct_pages_and_internal_links(
    harness: Harness, tmp_path: Path
) -> None:
    source = report_pdf(tmp_path / "source.pdf", pages=6)
    sid = str(harness.open(source)["state"]["sessionId"])
    result = harness.op("toc.insertPage", {"maxLevel": 3}, sid)
    assert result["data"] == {
        "count": 4,
        "insertedPages": 1,
        "insertionIndex": 0,
    }

    output = harness.app.sessions.get(sid).current_path
    rendered = pdfium.PdfDocument(output)
    assert len(rendered) == 7
    text = rendered[0].get_textpage().get_text_range()
    assert "Mục lục" in text
    assert "1. Giới thiệu" in text
    assert "2. Kết luận" in text
    assert text.rstrip().endswith("4")  # original page 2 moves to physical page 4
    rendered.close()

    with pikepdf.Pdf.open(output) as pdf:
        links = [a for a in pdf.pages[0].obj["/Annots"] if a.get("/Subtype") == "/Link"]
        assert len(links) == 4
        destinations = [a["/A"]["/D"] for a in links]
        index_by_objgen = {page.obj.objgen: i for i, page in enumerate(pdf.pages)}
        target_pages = [index_by_objgen[destination[0].objgen] for destination in destinations]
        assert target_pages == [1, 1, 3, 3]


@pytest.mark.parametrize(("placement", "toc_index"), [("back", 6), ("afterPage", 1)])
def test_toc_placement_keeps_internal_links_targeting_original_pages(
    harness: Harness, tmp_path: Path, placement: str, toc_index: int
) -> None:
    source = report_pdf(tmp_path / "source.pdf", pages=6)
    sid = str(harness.open(source)["state"]["sessionId"])
    params: dict[str, object] = {"placement": placement}
    if placement == "afterPage":
        params["afterPage"] = 1
    harness.op("toc.insertPage", params, sid)
    output = harness.app.sessions.get(sid).current_path
    assert len(pdfium.PdfDocument(output)) == 7
    assert "Mục lục" in _toc_text(output, toc_index)
    with pikepdf.Pdf.open(output) as pdf:
        links = [
            a for a in pdf.pages[toc_index].obj.get("/Annots", []) if a.get("/Subtype") == "/Link"
        ]
        page_indices = {page.obj.objgen: i for i, page in enumerate(pdf.pages)}
        destinations = [a["/A"]["/D"][0] for a in links]
        assert len(links) == 4
        if placement == "back":
            assert [page_indices[d.objgen] for d in destinations] == [0, 0, 2, 2]
        else:
            assert [page_indices[d.objgen] for d in destinations] == [0, 0, 3, 3]


def test_toc_uses_source_page_size_and_a4_can_be_selected(
    harness: Harness, tmp_path: Path
) -> None:
    source = report_pdf(tmp_path / "source.pdf", pages=6)
    with pikepdf.Pdf.open(source, allow_overwriting_input=True) as pdf:
        pdf.pages[0].mediabox = [0, 0, 500, 700]
        pdf.save(source)
    sid = str(harness.open(source)["state"]["sessionId"])
    harness.op("toc.insertPage", {"pageSize": "source"}, sid)
    output = harness.app.sessions.get(sid).current_path
    with pikepdf.Pdf.open(output) as pdf:
        assert list(map(float, pdf.pages[0].mediabox[2:])) == [500.0, 700.0]

    sid = str(harness.open(report_pdf(tmp_path / "a4.pdf", pages=6))["state"]["sessionId"])
    harness.op("toc.insertPage", {"pageSize": "a4"}, sid)
    output = harness.app.sessions.get(sid).current_path
    with pikepdf.Pdf.open(output) as pdf:
        assert float(pdf.pages[0].mediabox[2]) == pytest.approx(595.28, abs=0.1)
        assert float(pdf.pages[0].mediabox[3]) == pytest.approx(841.89, abs=0.1)


def test_toc_can_append_bookmarks_and_undo_redo(harness: Harness, tmp_path: Path) -> None:
    sid = str(harness.open(report_pdf(tmp_path / "source.pdf", pages=6))["state"]["sessionId"])
    harness.op("bookmarks.fromPages", {"template": "Existing {page}"}, sid)
    before = harness.op("bookmarks.get", {}, sid)["data"]["count"]
    harness.op("toc.insertPage", {"addBookmark": True}, sid)
    tree = harness.op("bookmarks.get", {}, sid)["data"]["bookmarks"]
    titles = [node["title"] for node in tree]
    assert "Existing 1" in titles
    toc_bookmark = next(node for node in tree if node["title"] == "Mục lục")
    assert toc_bookmark["page"] == 0
    assert "Báo cáo thường niên" not in titles
    count = harness.op("bookmarks.get", {}, sid)["data"]["count"]
    assert count > before
    harness.call("session.undo", {"sessionId": sid})
    assert harness.op("bookmarks.get", {}, sid)["data"]["count"] == before
    harness.call("session.redo", {"sessionId": sid})
    assert harness.op("bookmarks.get", {}, sid)["data"]["count"] == count


def test_toc_is_blocked_on_signed_documents(
    harness: Harness, corpus: dict[str, Path]
) -> None:
    sid = str(harness.open(corpus["fake_signed.pdf"])["state"]["sessionId"])
    with pytest.raises(RpcFailure) as exc:
        harness.op("toc.insertPage", {}, sid)
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"


def test_many_headings_create_multiple_toc_pages_and_keep_every_link() -> None:
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(595.28, 841.89))
    nodes = [
        {
            "title": f"Mục {index}: Nội dung tiếng Việt",
            "page": 0,
            "children": [],
        }
        for index in range(50)
    ]
    inserted = insert_contents(pdf, nodes)
    assert inserted > 1
    assert len(pdf.pages) == inserted + 1
    link_count = sum(
        1
        for page in pdf.pages[:inserted]
        for annotation in page.obj.get("/Annots", [])
        if annotation.get("/Subtype") == "/Link"
    )
    assert link_count == len(nodes)


def test_after_page_requires_a_valid_page_number(harness: Harness, tmp_path: Path) -> None:
    sid = str(harness.open(report_pdf(tmp_path / "source.pdf", pages=6))["state"]["sessionId"])
    with pytest.raises(RpcFailure) as missing:
        harness.op("toc.insertPage", {"placement": "afterPage"}, sid)
    assert missing.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as outside:
        harness.op("toc.insertPage", {"placement": "afterPage", "afterPage": 99}, sid)
    assert outside.value.kind == "INVALID_PARAMS"


def test_no_headings_after_filtering_is_an_invalid_request(
    harness: Harness, tmp_path: Path
) -> None:
    sid = str(harness.open(report_pdf(tmp_path / "source.pdf", pages=3))["state"]["sessionId"])
    with pytest.raises(RpcFailure) as exc:
        harness.op("toc.insertPage", {"minConfidence": 1.0, "maxLevel": 1}, sid)
    assert exc.value.kind == "INVALID_PARAMS"


def test_toc_formatting_options_control_offset_scale_leaders_and_links(
    harness: Harness, tmp_path: Path
) -> None:
    sid = str(harness.open(report_pdf(tmp_path / "source.pdf", pages=6))["state"]["sessionId"])
    harness.op(
        "toc.insertPage",
        {
            "pageNumberOffset": 10,
            "fontScale": 1.5,
            "dotLeader": False,
            "linkEntries": False,
        },
        sid,
    )
    output = harness.app.sessions.get(sid).current_path
    text = _toc_text(output, 0)
    assert text.rstrip().endswith("14")
    assert "..." not in text
    with pikepdf.Pdf.open(output) as pdf:
        contents = pdf.pages[0].obj["/Contents"].read_bytes()
        assert b"27 Tf" in contents and b"15.75 Tf" in contents
        assert not pdf.pages[0].obj.get("/Annots")

    sid = str(harness.open(report_pdf(tmp_path / "leaders.pdf", pages=6))["state"]["sessionId"])
    harness.op("toc.insertPage", {"dotLeader": True}, sid)
    assert "..." in _toc_text(harness.app.sessions.get(sid).current_path, 0)


def test_toc_title_longer_than_two_lines_is_not_truncated(tmp_path: Path) -> None:
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(595.28, 841.89))
    title = "Dài " * 100
    nodes = [{"title": title, "page": 0, "children": []}]
    insert_contents(pdf, nodes)
    output = tmp_path / "long-title.pdf"
    pdf.save(output)
    assert _toc_text(output, 0).count("Dài") == 100

