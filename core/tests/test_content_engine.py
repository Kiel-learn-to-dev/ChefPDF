"""T6.01: page content model (objects, geometry, hit tests, z-order, performance)."""

from __future__ import annotations

import time
from pathlib import Path

import pikepdf
import pytest
from content_support import (
    form_xobject,
    ink_bbox,
    is_blue,
    is_red,
    pdfium_chars,
    pdfium_image_bounds,
    raw_pdf,
    render,
    vietnamese_pdf,
)
from pdf_media import image_xobject, noisy_rgb
from PIL import Image

from chef_core.content.engine import build_model, objects_at_point, objects_in_rect
from chef_core.content.model import PageObject


def _model(path: Path, index: int = 0, **kw: object) -> tuple[pikepdf.Pdf, object]:
    pdf = pikepdf.open(path)
    return pdf, build_model(pdf, pdf.pages[index], index, **kw)  # type: ignore[arg-type]


def _kinds(objs: list[PageObject]) -> list[str]:
    return [o.kind for o in objs]


MIXED = b"""
q 1 0 0 rg 40 500 200 200 re f Q
q 0 0 1 RG 4 w 300 500 m 500 700 l S Q
BT /F1 24 Tf 40 300 Td (Hello) Tj ET
BT /F1 24 Tf 40 250 Td [(W) 120 (orld)] TJ ET
q 150 0 0 100 40 100 cm /Im1 Do Q
q 0.5 g 100 40 m 200 40 l 200 80 l h f Q
"""


def _mixed(tmp_path: Path) -> Path:
    def setup(pdf: pikepdf.Pdf, page: pikepdf.Page) -> None:
        img = image_xobject(pdf, noisy_rgb(8, 8), codec="flate")
        page.obj.Resources.XObject = pikepdf.Dictionary(Im1=img)

    return raw_pdf(tmp_path / "mixed.pdf", MIXED, setup=setup)


def test_object_kinds_order_and_counts(tmp_path: Path) -> None:
    pdf, model = _model(_mixed(tmp_path))
    objs = model.objects  # type: ignore[attr-defined]
    assert _kinds(objs) == ["path", "path", "text", "text", "image", "path"]
    red, stroke, hello, world, image, grey = objs
    assert red.fill and not red.stroke and red.fill_color == ("rgb", (1.0, 0.0, 0.0))
    assert stroke.stroke and not stroke.fill and stroke.stroke_width == 4
    assert hello.string == "Hello" and hello.font == "/F1"
    assert world.string == "World"  # TJ kerning array: numbers are not shown
    assert image.image_name == "/Im1" and image.pixel_size == (8, 8)
    assert grey.fill_color == ("gray", (0.5,))
    pdf.close()


def test_inline_image_is_an_image_object(tmp_path: Path) -> None:
    content = b"q 100 0 0 50 10 10 cm BI /W 2 /H 2 /BPC 8 /CS /RGB ID " + bytes(12) + b" EI Q"
    path = raw_pdf(tmp_path / "inline.pdf", content)
    pdf, model = _model(path)
    (img,) = model.objects  # type: ignore[attr-defined]
    assert img.kind == "image" and img.inline and img.pixel_size == (2, 2)
    assert img.bbox == pytest.approx((10.0, 10.0, 110.0, 60.0), abs=1e-6)
    pdf.close()


def test_clip_only_path_is_not_an_object_and_clips_its_children(tmp_path: Path) -> None:
    content = b"q 0 0 100 100 re W n q 1 0 0 rg 0 0 300 300 re f Q Q 0 0 1 rg 0 0 50 50 re f"
    pdf, model = _model(raw_pdf(tmp_path / "clip.pdf", content))
    red, blue = model.objects  # type: ignore[attr-defined]
    assert red.clipped and red.bbox == pytest.approx((0.0, 0.0, 100.0, 100.0), abs=1e-6)
    assert not blue.clipped and blue.bbox == pytest.approx((0.0, 0.0, 50.0, 50.0), abs=1e-6)
    pdf.close()


def test_nested_forms_have_parent_chain_and_child_bbox(tmp_path: Path) -> None:
    def setup(pdf: pikepdf.Pdf, page: pikepdf.Page) -> None:
        inner = form_xobject(pdf, b"0 1 0 rg 0 0 50 50 re f", (0, 0, 50, 50))
        outer = form_xobject(
            pdf,
            b"/Fm1 Do",
            (0, 0, 200, 200),
            matrix=(1, 0, 0, 1, 10, 10),
            resources=pikepdf.Dictionary(XObject=pikepdf.Dictionary(Fm1=inner)),
        )
        page.obj.Resources.XObject = pikepdf.Dictionary(Fm0=outer)

    path = raw_pdf(tmp_path / "forms.pdf", b"q 1 0 0 1 100 100 cm /Fm0 Do Q", setup=setup)
    pdf, model = _model(path)
    objs = model.objects  # type: ignore[attr-defined]
    assert _kinds(objs) == ["form", "form", "path"]
    outer, inner, leaf = objs
    assert outer.parent_id is None and inner.parent_id == outer.id and leaf.parent_id == inner.id
    assert leaf.bbox == pytest.approx((110.0, 110.0, 160.0, 160.0), abs=1e-6)
    assert leaf.editable is False  # children of a form can only be edited after flattening
    pdf.close()


def test_forms_not_opened_hide_children_from_hit_tests(tmp_path: Path) -> None:
    def setup(pdf: pikepdf.Pdf, page: pikepdf.Page) -> None:
        inner = form_xobject(pdf, b"0 1 0 rg 0 0 50 50 re f", (0, 0, 50, 50))
        page.obj.Resources.XObject = pikepdf.Dictionary(Fm0=inner)

    path = raw_pdf(tmp_path / "f2.pdf", b"/Fm0 Do", setup=setup)
    pdf, model = _model(path)
    objs = model.objects  # type: ignore[attr-defined]
    hits = objects_at_point(objs, 10, 10, include_forms=False)
    assert [o.kind for o in hits] == ["form"]
    hits = objects_at_point(objs, 10, 10)
    assert [o.kind for o in hits] == ["path"]
    pdf.close()


def test_text_bbox_matches_pdfium_char_boxes(tmp_path: Path) -> None:
    path = vietnamese_pdf(tmp_path / "vn.pdf")
    pdf, model = _model(path)
    texts = [o for o in model.objects if o.kind == "text"]  # type: ignore[attr-defined]
    assert [t.string for t in texts] == ["Tiếng Việt có dấu: Hà Nội", "Chef PDF sửa nội dung trang"]
    pdf_text, boxes = pdfium_chars(path)
    for t in texts:
        start = pdf_text.index(t.string)
        group = boxes[start : start + len(t.string)]
        left = min(b[0] for b in group)
        bottom = min(b[1] for b in group)
        right = max(b[2] for b in group)
        top = max(b[3] for b in group)
        lft, bot, rgt, top_ = t.bbox
        for ours, theirs in ((lft, left), (bot, bottom), (rgt, right), (top_, top)):
            assert abs(ours - theirs) <= 1.0, (t.string, t.bbox, (left, bottom, right, top))
    pdf.close()


def test_image_bbox_matches_pdfium(tmp_path: Path) -> None:
    pdf, model = _model(_mixed(tmp_path))
    (img,) = [o for o in model.objects if o.kind == "image"]  # type: ignore[attr-defined]
    (bounds,) = pdfium_image_bounds(tmp_path / "mixed.pdf")
    assert img.bbox == pytest.approx(bounds, abs=0.5)
    pdf.close()


def test_ink_bbox_matches_object_bbox(tmp_path: Path) -> None:
    path = vietnamese_pdf(tmp_path / "vn2.pdf")
    pdf, model = _model(path)
    (box,) = [
        o for o in model.objects if o.kind == "path" and o.fill_color == ("rgb", (1.0, 0.0, 0.0))
    ]  # type: ignore[attr-defined]
    img = render(path, 0, dpi=72)
    left, top, right, bottom = ink_bbox(img, is_red) or (0, 0, 0, 0)
    x0, y0, x1, y1 = box.bbox
    assert abs(left - x0) <= 1 and abs(right - x1) <= 1
    assert abs((792 - bottom) - y0) <= 1 and abs((792 - top) - y1) <= 1
    pdf.close()


def test_rotated_page_display_bbox_matches_rendering(tmp_path: Path) -> None:
    path = vietnamese_pdf(tmp_path / "rot.pdf", rotate=90)
    pdf, model = _model(path)
    box = next(
        o
        for o in model.objects
        if o.kind == "path" and o.fill_color == ("rgb", (1.0, 0.0, 0.0))  # type: ignore[attr-defined]
    )
    disp = box.display_bbox(model.frame)  # type: ignore[attr-defined]
    img = render(path, 0, dpi=72)
    assert img.size == (792, 612)
    left, top, right, bottom = ink_bbox(img, is_red) or (0, 0, 0, 0)
    assert abs(left - disp[0]) <= 1 and abs(top - disp[1]) <= 1
    assert abs(right - disp[2]) <= 1 and abs(bottom - disp[3]) <= 1
    pdf.close()


def test_hit_test_returns_topmost_first(tmp_path: Path) -> None:
    content = b"0 0 1 rg 0 0 200 200 re f  1 0 0 rg 50 50 100 100 re f"
    pdf, model = _model(raw_pdf(tmp_path / "z.pdf", content))
    objs = model.objects  # type: ignore[attr-defined]
    hits = objects_at_point(objs, 60, 60)
    assert [o.fill_color[1] for o in hits] == [(1.0, 0.0, 0.0), (0.0, 0.0, 1.0)]
    assert objects_at_point(objs, 150, 150)[0].fill_color[1] == (0.0, 0.0, 1.0)  # type: ignore[index]
    assert objects_at_point(objs, 300, 300) == []
    pdf.close()


def test_stroke_only_path_is_hit_only_near_the_stroke(tmp_path: Path) -> None:
    content = b"0 0 1 RG 3 w 100 100 m 300 100 l S"
    pdf, model = _model(raw_pdf(tmp_path / "s.pdf", content))
    objs = model.objects  # type: ignore[attr-defined]
    assert objects_at_point(objs, 200, 101)
    assert objects_at_point(objs, 200, 140) == []
    pdf.close()


def test_rect_query_intersect_and_contain(tmp_path: Path) -> None:
    pdf, model = _model(_mixed(tmp_path))
    objs = model.objects  # type: ignore[attr-defined]
    inter = objects_in_rect(objs, (0, 0, 260, 560), "intersect")
    assert [o.kind for o in inter].count("path") == 2
    contain = objects_in_rect(objs, (30, 90, 260, 560), "contain")
    assert all(o.bbox[0] >= 30 for o in contain)
    assert len(contain) < len(inter)
    pdf.close()


def test_ids_are_deterministic_and_tied_to_the_revision(tmp_path: Path) -> None:
    path = _mixed(tmp_path)
    pdf1, m1 = _model(path)
    pdf2, m2 = _model(path)
    assert [o.id for o in m1.objects] == [o.id for o in m2.objects]  # type: ignore[attr-defined]
    assert m1.objects[0].id.startswith("p0:")  # type: ignore[attr-defined]
    assert len({o.id for o in m1.objects}) == len(m1.objects)  # type: ignore[attr-defined]
    pdf1.close()
    pdf2.close()


def test_marked_content_and_layers_are_reported(tmp_path: Path) -> None:
    content = (
        b"/Artifact <</Type /Pagination /Subtype /Watermark>> BDC "
        b"q 0.5 g 10 10 20 20 re f Q EMC "
        b"/OC /oc1 BDC q 0 0 1 rg 100 100 20 20 re f Q EMC"
    )

    def setup(pdf: pikepdf.Pdf, page: pikepdf.Page) -> None:
        ocg = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.OCG, Name="Stamps"))
        page.obj.Resources.Properties = pikepdf.Dictionary(oc1=ocg)

    pdf, model = _model(raw_pdf(tmp_path / "mc.pdf", content, setup=setup))
    wm, layer = model.objects  # type: ignore[attr-defined]
    assert wm.marks == ["Artifact"] and wm.layer is None
    assert layer.layer == "Stamps" and layer.marks == ["OC"]
    pdf.close()


def test_shading_object(tmp_path: Path) -> None:
    def setup(pdf: pikepdf.Pdf, page: pikepdf.Page) -> None:
        shading = pdf.make_indirect(
            pikepdf.Dictionary(
                ShadingType=2,
                ColorSpace=pikepdf.Name.DeviceRGB,
                Coords=pikepdf.Array([0, 0, 612, 0]),
                Function=pikepdf.Dictionary(
                    FunctionType=2,
                    Domain=pikepdf.Array([0, 1]),
                    C0=pikepdf.Array([1, 0, 0]),
                    C1=pikepdf.Array([0, 0, 1]),
                    N=1,
                ),
            )
        )
        page.obj.Resources.Shading = pikepdf.Dictionary(Sh1=shading)

    pdf, model = _model(
        raw_pdf(tmp_path / "sh.pdf", b"q 0 0 300 300 re W n /Sh1 sh Q", setup=setup)
    )
    (sh,) = model.objects  # type: ignore[attr-defined]
    assert sh.kind == "shading" and sh.bbox == pytest.approx((0, 0, 300, 300), abs=1e-6)
    pdf.close()


def test_multiple_content_streams_are_one_model(tmp_path: Path) -> None:
    path = raw_pdf(tmp_path / "two.pdf", [b"0 0 1 rg 0 0 10 10 re f", b"1 0 0 rg 20 20 10 10 re f"])
    pdf, model = _model(path)
    assert [o.fill_color[1] for o in model.objects] == [(0.0, 0.0, 1.0), (1.0, 0.0, 0.0)]  # type: ignore[attr-defined]
    pdf.close()


def test_parsing_a_hundred_objects_is_fast(tmp_path: Path) -> None:
    body = b"".join(
        b"q %d 0 0 rg %d 10 20 20 re f Q BT /F1 10 Tf %d 100 Td (x%d) Tj ET\n" % (i % 2, i, i, i)
        for i in range(50)
    )
    path = raw_pdf(tmp_path / "hundred.pdf", body)
    pdf = pikepdf.open(path)
    build_model(pdf, pdf.pages[0], 0)  # warm-up
    best = 1e9
    for _ in range(3):
        t = time.perf_counter()
        model = build_model(pdf, pdf.pages[0], 0)
        best = min(best, time.perf_counter() - t)
    assert len(model.objects) == 100  # type: ignore[attr-defined]
    assert best < 0.1, f"{best * 1000:.1f} ms"
    pdf.close()


def test_fifty_page_listing_is_fast(tmp_path: Path) -> None:
    path = raw_pdf(
        tmp_path / "many.pdf",
        b"0 0 1 rg 10 10 50 50 re f BT /F1 12 Tf 10 10 Td (a) Tj ET",
        pages=50,
    )
    pdf = pikepdf.open(path)
    t = time.perf_counter()
    total = sum(len(build_model(pdf, p, i).objects) for i, p in enumerate(pdf.pages))  # type: ignore[attr-defined]
    assert total == 100
    assert time.perf_counter() - t < 3.0
    pdf.close()


def test_pixels_of_a_rendered_blue_circle_are_hit(tmp_path: Path) -> None:
    path = vietnamese_pdf(tmp_path / "circle.pdf")
    pdf, model = _model(path)
    img = render(path, 0)
    assert isinstance(img, Image.Image)
    # the circle centre (400, 480) in user space is pixel (400, 312)
    assert is_blue(img.convert("RGB").getpixel((400, 312)))
    hits = objects_at_point(model.objects, 400, 480)  # type: ignore[attr-defined]
    assert hits and hits[0].fill_color == ("rgb", (0.0, 0.0, 1.0))
    pdf.close()


def test_flattening_renames_colliding_resources_and_drops_actualtext(tmp_path: Path) -> None:
    def setup(pdf: pikepdf.Pdf, page: pikepdf.Page) -> None:
        times = pdf.make_indirect(
            pikepdf.Dictionary(
                Type=pikepdf.Name.Font,
                Subtype=pikepdf.Name.Type1,
                BaseFont=pikepdf.Name("/Times-Roman"),
            )
        )
        inner = form_xobject(
            pdf,
            b"BT /F1 20 Tf 10 10 Td (Form) Tj ET "
            b"/Span <</ActualText (X)>> BDC 0 0 1 rg 0 0 5 5 re f EMC",
            (0, 0, 200, 200),
            resources=pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=times)),
        )
        page.obj.Resources.XObject = pikepdf.Dictionary(Fm0=inner)

    path = raw_pdf(
        tmp_path / "fl.pdf",
        b"BT /F1 12 Tf 10 300 Td (Page) Tj ET q 1 0 0 1 100 100 cm /Fm0 Do Q",
        setup=setup,
    )
    pdf = pikepdf.open(path)
    model = build_model(pdf, pdf.pages[0], 0, flatten=True)
    page_text, form_text, blue = model.objects
    assert page_text.font_name == "Helvetica" and page_text.string == "Page"
    assert form_text.font_name == "Times-Roman" and form_text.string == "Form"
    assert form_text.font != "/F1"  # renamed: it no longer collides with the page's F1
    assert form_text.bbox[0] == pytest.approx(110.0, abs=0.5)
    assert blue.marks == []  # the ActualText span was dropped by the flattening
    assert all("ActualText" not in str(ins.operands) for ins in model.nodes)
    assert blue.in_page and blue.parent_id is None
    pdf.close()


def test_object_json_has_the_operator_range(tmp_path: Path) -> None:
    pdf, model = _model(_mixed(tmp_path))
    frame = model.frame  # type: ignore[attr-defined]
    obj = model.objects[0]  # type: ignore[attr-defined]
    data = obj.to_json(frame, 0)
    assert data["opRange"] == [obj.start, obj.end]
    assert data["bbox"][0] == pytest.approx(40.0, abs=1e-6)
    pdf.close()
