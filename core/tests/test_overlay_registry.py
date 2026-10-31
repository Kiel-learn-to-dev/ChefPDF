"""T4.01 registry: list and remove tagged overlays exactly (F12), with the catalog index (D14)."""

from __future__ import annotations

import io
from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
from PIL import Image

from chef_core.overlay.engine import OverlayWriter, Placement, TextStyle
from chef_core.overlay.registry import list_overlays, remove_overlays

ORIGINAL = b"0 0 1 rg 10 10 50 50 re f\n/P <</MCID 0>> BDC\n1 0 0 rg 60 60 20 20 re f\nEMC\n"


def _pages(count: int, *, content: bytes = ORIGINAL) -> pikepdf.Pdf:
    pdf = pikepdf.new()
    for _ in range(count):
        pdf.add_blank_page(page_size=(300, 400))
    for page in pdf.pages:
        page.obj.Contents = pdf.make_stream(content)
    return pdf


def _instructions(page: pikepdf.Page) -> list[tuple[str, list[str]]]:
    out: list[tuple[str, list[str]]] = []
    for ins in pikepdf.parse_content_stream(page):
        if isinstance(ins, pikepdf.ContentStreamInstruction):
            out.append((str(ins.operator), [repr(op) for op in ins.operands]))
    return out


def _render_bytes(pdf: pikepdf.Pdf, tmp: Path, name: str) -> bytes:
    path = tmp / name
    pdf.save(path)
    doc = pdfium.PdfDocument(str(path))
    try:
        img = doc[0].render(scale=1.0).to_pil().convert("RGB")
    finally:
        doc.close()
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _add_watermark(pdf: pikepdf.Pdf, group: str = "grp-wm") -> str:
    writer = OverlayWriter(pdf, kind="watermark", group=group, label="Mật")
    piece = writer.text("MẬT", TextStyle(font_size=60, color=(0.5, 0.5, 0.5)))
    for i in range(len(pdf.pages)):
        writer.place(i, piece, Placement(x=150, y=200, anchor="center", rotation=45, opacity=0.3))
    writer.commit()
    return writer.overlay_id


def _page_names(page: pikepdf.Page) -> dict[str, list[str]]:
    res = page.obj.get("/Resources", pikepdf.Dictionary())
    return {
        cat: sorted(str(k) for k in res.get(cat, pikepdf.Dictionary()))
        for cat in ("/Font", "/XObject", "/ExtGState")
    }


def test_watermark_on_20_pages_is_listed_and_removed_exactly(tmp_path: Path) -> None:
    pdf = _pages(20)
    before_instr = [_instructions(p) for p in pdf.pages]
    before_names = [_page_names(p) for p in pdf.pages]
    before_png = _render_bytes(pdf, tmp_path, "before.pdf")

    pdf2 = _pages(20)
    oid = _add_watermark(pdf2)
    listed = list_overlays(pdf2)
    assert len(listed) == 1
    assert listed[0].id == oid
    assert listed[0].kind == "watermark"
    assert listed[0].group == "grp-wm"
    assert listed[0].pages == list(range(20))
    assert listed[0].label == "Mật"

    removed = remove_overlays(pdf2, ids=[oid])
    assert removed.removed_ids == [oid]
    assert removed.changed_pages == list(range(20))

    assert [_instructions(p) for p in pdf2.pages] == before_instr
    assert [_page_names(p) for p in pdf2.pages] == before_names
    assert list_overlays(pdf2) == []
    assert _render_bytes(pdf2, tmp_path, "after.pdf") == before_png
    assert pdf2.Root.get("/ChefPDF") is None or len(pdf2.Root.ChefPDF.Overlays) == 0
    for page in pdf2.pages:
        raw = page.obj.Contents.read_bytes()
        assert b"ChefOverlay" not in raw and b"ChefWrap" not in raw


def test_remove_then_save_leaves_no_fonts_or_tags_behind(tmp_path: Path) -> None:
    pdf = _pages(5)
    _add_watermark(pdf)
    remove_overlays(pdf, kind="watermark")
    path = tmp_path / "clean.pdf"
    pdf.save(path)
    with pikepdf.open(path) as reopened:
        fonts = [
            o
            for o in reopened.objects
            if isinstance(o, pikepdf.Dictionary) and o.get("/Subtype") == "/Type0"
        ]
        assert fonts == []
        assert len(reopened.Root.get("/ChefPDF", {}).get("/Fonts", {})) == 0
        assert path.stat().st_size < 4000


def test_selection_by_kind_and_by_group(tmp_path: Path) -> None:
    pdf = _pages(4)
    text = OverlayWriter(pdf, kind="text", group="g-text")
    text.place(0, text.text("Hello", TextStyle()), Placement(x=10, y=10))
    text.place(1, text.text("Hello", TextStyle()), Placement(x=10, y=10))
    text.commit()
    _add_watermark(pdf, group="g-wm")

    assert {o.kind for o in list_overlays(pdf)} == {"text", "watermark"}

    result = remove_overlays(pdf, kind="text")
    assert result.removed_ids == [text.overlay_id]
    assert result.changed_pages == [0, 1]
    assert [o.kind for o in list_overlays(pdf)] == ["watermark"]

    result = remove_overlays(pdf, group="g-wm")
    assert len(result.removed_ids) == 1
    assert list_overlays(pdf) == []


def test_nothing_matches_means_nothing_changes(tmp_path: Path) -> None:
    pdf = _pages(2)
    _add_watermark(pdf)
    result = remove_overlays(pdf, kind="letterhead")
    assert result.removed_ids == []
    assert result.changed_pages == []
    assert len(list_overlays(pdf)) == 1


def test_nested_marked_content_of_the_source_is_kept(tmp_path: Path) -> None:
    pdf = _pages(1)
    before = _instructions(pdf.pages[0])
    writer = OverlayWriter(pdf, kind="header", group="g1")
    writer.place(0, writer.text("Trên", TextStyle()), Placement(x=10, y=10), under=True)
    writer.place(0, writer.text("Dưới", TextStyle()), Placement(x=10, y=380), under=False)
    writer.commit()
    assert len(list_overlays(pdf)) == 1
    remove_overlays(pdf, ids=[writer.overlay_id])
    assert _instructions(pdf.pages[0]) == before


def test_inherited_resources_are_copied_not_shared(tmp_path: Path) -> None:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(300, 400))
    pdf.add_blank_page(page_size=(300, 400))
    for page in pdf.pages:
        del page.obj["/Resources"]
        page.obj.Contents = pdf.make_stream(b"0 0 1 rg 10 10 50 50 re f")
    shared = pdf.make_indirect(pikepdf.Dictionary(Font=pikepdf.Dictionary()))
    pdf.Root.Pages.Resources = shared

    writer = OverlayWriter(pdf, kind="text", group="g1")
    writer.place(0, writer.text("Chỉ trang 1", TextStyle()), Placement(x=10, y=10))
    writer.commit()

    names_page0 = _page_names(pdf.pages[0])
    names_page1 = _page_names(pdf.pages[1])
    assert any(n.startswith("/Chef") for n in names_page0["/Font"])
    assert names_page1["/Font"] == []
    assert len(shared.Font) == 0  # the inherited dictionary itself is untouched


def test_overlays_survive_a_save_and_reopen(tmp_path: Path) -> None:
    pdf = _pages(3)
    oid = _add_watermark(pdf)
    path = tmp_path / "saved.pdf"
    pdf.save(path)
    with pikepdf.open(path) as reopened:
        listed: list[Any] = list_overlays(reopened)
        assert [o.id for o in listed] == [oid]
        assert listed[0].pages == [0, 1, 2]
        remove_overlays(reopened, ids=[oid])
        reopened.save(tmp_path / "removed.pdf")
    with pikepdf.open(tmp_path / "removed.pdf") as final:
        assert list_overlays(final) == []


def test_removal_keeps_a_shared_image_used_by_another_overlay(tmp_path: Path) -> None:
    buf = io.BytesIO()
    Image.new("RGB", (20, 20), (0, 255, 0)).save(buf, format="PNG")
    png = buf.getvalue()
    pdf = _pages(2)
    first = OverlayWriter(pdf, kind="image", group="g1")
    first.place(0, first.image(png, width=20, height=20), Placement(x=10, y=10))
    first.commit()
    second = OverlayWriter(pdf, kind="image", group="g2")
    second.place(1, second.image(png, width=20, height=20), Placement(x=10, y=10))
    second.commit()
    remove_overlays(pdf, ids=[first.overlay_id])
    images = [
        o for o in pdf.objects if isinstance(o, pikepdf.Stream) and o.get("/Subtype") == "/Image"
    ]
    assert images  # still used by page 1
    assert [o.id for o in list_overlays(pdf)] == [second.overlay_id]


def test_removing_an_under_overlay_keeps_the_wrap_for_the_others(tmp_path: Path) -> None:
    pdf = _pages(1)
    before = _instructions(pdf.pages[0])
    under = OverlayWriter(pdf, kind="letterhead", group="g-under")
    under.place(0, under.text("Dưới", TextStyle()), Placement(x=10, y=380), under=True)
    under.commit()
    over = OverlayWriter(pdf, kind="text", group="g-over")
    over.place(0, over.text("Trên", TextStyle()), Placement(x=10, y=30), under=False)
    over.commit()

    remove_overlays(pdf, ids=[under.overlay_id])
    names = [op for op, _ in _instructions(pdf.pages[0])]
    wrap_start = names.index("BMC")
    wrap_end = len(names) - 1 - names[::-1].index("EMC")
    # The remaining overlay still sits after the source content, inside no wrap of its own.
    assert names.count("BDC") == 2  # the Artifact-less text block plus the nested source BDC
    assert len(list_overlays(pdf)) == 1
    assert _instructions(pdf.pages[0])[wrap_start + 1] == ("q", [])
    assert wrap_end > wrap_start
    remove_overlays(pdf, ids=[over.overlay_id])
    assert _instructions(pdf.pages[0]) == before
