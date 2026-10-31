"""T6.01: content.* operations (list, hit test, delete, move, transform, colour, z-order,
duplicate, opacity), stale ids, signed documents, undo, forms and resource sharing."""

from __future__ import annotations

from pathlib import Path

import pikepdf
import pytest
from conftest import Harness, RpcFailure
from content_support import (
    form_xobject,
    ink_bbox,
    is_blue,
    is_red,
    pdfium_chars,
    raw_pdf,
    render,
    vietnamese_pdf,
)
from pdf_media import page_text

from chef_core.content.verify import assert_unchanged_outside

RED_BOX = b"q 1 0 0 rg 100 100 200 150 re f Q"
TWO_BOXES = b"q 0 0 1 rg 100 100 200 150 re f Q q 1 0 0 rg 200 180 200 150 re f Q"


def _sid(harness: Harness, path: Path) -> str:
    return str(harness.open(path)["state"]["sessionId"])


def _revision(harness: Harness, sid: str) -> Path:
    return Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])


def _objects(harness: Harness, sid: str, page: int = 0, **params: object) -> list[dict]:
    result = harness.op("content.listObjects", {"pageIndex": page, **params}, sid)
    return list(result["data"]["objects"])


def _by_kind(objs: list[dict], kind: str) -> list[dict]:
    return [o for o in objs if o["kind"] == kind]


def _pick_colour(objs: list[dict], hex_colour: str) -> dict:
    (found,) = [o for o in objs if o.get("fillColor") == hex_colour]
    return found


def _same_boxes(actual: list, expected: list, tol: float = 0.01) -> None:
    assert len(actual) == len(expected)
    for a, e in zip(actual, expected, strict=True):
        assert all(abs(x - y) <= tol for x, y in zip(a, e, strict=True)), (a, e)


def _pixel(path: Path, x: float, y: float) -> tuple[int, int, int]:
    img = render(path, 0)
    px = img.convert("RGB").getpixel((int(x), int(792 - y)))
    return int(px[0]), int(px[1]), int(px[2])


def test_list_objects_reports_ids_bboxes_and_kinds(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, vietnamese_pdf(tmp_path / "vn.pdf"))
    objs = _objects(harness, sid)
    assert [o["kind"] for o in objs] == ["text", "text", "path", "path"]
    assert all(o["id"].startswith("p0:") for o in objs)
    red = _pick_colour(objs, "#ff0000")
    # display frame: origin top-left, y down; the red box is 72..272 x 420..540 in user space
    assert red["bbox"] == pytest.approx([72.0, 252.0, 272.0, 372.0], abs=1e-3)
    assert red["bboxUser"] == pytest.approx([72.0, 420.0, 272.0, 540.0], abs=1e-3)
    assert red["editable"] is True and red["parentId"] is None


def test_hit_test_op_returns_topmost_first(harness: Harness, tmp_path: Path) -> None:
    path = raw_pdf(tmp_path / "z.pdf", TWO_BOXES)
    sid = _sid(harness, path)
    # user (250, 200) is inside both boxes; the red one is painted last
    res = harness.op(
        "content.hitTest", {"pageIndex": 0, "x": 250, "y": 792 - 200, "unit": "pt"}, sid
    )
    colours = [o["fillColor"] for o in res["data"]["objects"]]
    assert colours == ["#ff0000", "#0000ff"]


def test_delete_removes_ink_and_keeps_other_pixels(harness: Harness, tmp_path: Path) -> None:
    src = vietnamese_pdf(tmp_path / "vn.pdf")
    sid = _sid(harness, src)
    red = _pick_colour(_objects(harness, sid), "#ff0000")
    res = harness.op("content.delete", {"ids": [red["id"]]}, sid)
    assert res["changedPages"] == [0]
    out = _revision(harness, sid)
    assert _pixel(out, 150, 480) == (255, 255, 255)
    assert_unchanged_outside(src, out, 0, [red["bboxUser"]], tolerance=0)
    assert _kinds_of(_objects(harness, sid)) == ["text", "text", "path"]


def _kinds_of(objs: list[dict]) -> list[str]:
    return [o["kind"] for o in objs]


def test_delete_text_run_keeps_the_following_text_in_place(
    harness: Harness, tmp_path: Path
) -> None:
    # two runs on one line: BBBB starts where AAAA ended, so the gap must stay
    content = b"BT /F1 24 Tf 40 500 Td (AAAA) Tj (BBBB) Tj ET BT /F1 24 Tf 40 300 Td (C) Tj ET"
    src = raw_pdf(tmp_path / "t.pdf", content)
    sid = _sid(harness, src)
    first = _objects(harness, sid)[0]
    harness.op("content.delete", {"ids": [first["id"]]}, sid)
    out = _revision(harness, sid)
    before = pdfium_chars(src)[1]
    after = pdfium_chars(out)[1]
    _same_boxes(after[0:4], before[4:8])  # BBBB did not move
    _same_boxes([after[4]], [before[8]])  # the line below too
    assert "BBBB" in page_text(out) and "AAAA" not in page_text(out)


def test_move_shifts_the_ink_by_the_displayed_delta(harness: Harness, tmp_path: Path) -> None:
    src = vietnamese_pdf(tmp_path / "vn.pdf")
    sid = _sid(harness, src)
    red = _pick_colour(_objects(harness, sid), "#ff0000")
    before = ink_bbox(render(src, 0), is_red)
    # displayed frame: +30 right, +20 down (y grows downwards on screen)
    harness.op("content.move", {"ids": [red["id"]], "dx": 30, "dy": 20}, sid)
    out = _revision(harness, sid)
    after = ink_bbox(render(out, 0), is_red)
    assert before and after
    assert after == pytest.approx(
        tuple(v + d for v, d in zip(before, (30, 20, 30, 20), strict=True)), abs=1
    )
    moved = [102.0, 400.0, 302.0, 520.0]  # user space: the box moved by (+30, -20)
    assert_unchanged_outside(src, out, 0, [red["bboxUser"], moved], tolerance=0)


def test_move_of_an_object_inside_a_cm_group(harness: Harness, tmp_path: Path) -> None:
    content = b"q 2 0 0 2 0 0 cm 1 0 0 rg 25 25 50 50 re f Q"  # ink at 50..150
    src = raw_pdf(tmp_path / "cm.pdf", content)
    sid = _sid(harness, src)
    (obj,) = _objects(harness, sid)
    harness.op("content.move", {"ids": [obj["id"]], "dx": 10, "dy": 0}, sid)
    out = _revision(harness, sid)
    box = ink_bbox(render(out, 0), is_red)
    assert box and box[0] == 60 and box[2] == 160


def test_transform_scales_and_set_colour_restores_the_state(
    harness: Harness, tmp_path: Path
) -> None:
    content = b"q 1 0 0 rg 100 100 50 50 re f Q 0 1 0 rg 300 300 10 10 re f"
    src = raw_pdf(tmp_path / "tr.pdf", content)
    sid = _sid(harness, src)
    objs = _objects(harness, sid)
    harness.op("content.transform", {"ids": [objs[0]["id"]], "matrix": [2, 0, 0, 2, 0, 0]}, sid)
    out = _revision(harness, sid)
    box = ink_bbox(render(out, 0), is_red)
    assert box and (box[2] - box[0]) == pytest.approx(100, abs=1)
    red = _pick_colour(_objects(harness, sid), "#ff0000") if False else _objects(harness, sid)[0]
    harness.op("content.setColor", {"ids": [red["id"]], "fill": "#0000ff"}, sid)
    out2 = _revision(harness, sid)
    assert is_blue(render(out2, 0).convert("RGB").getpixel((250, 792 - 250)))
    # the green box after the object keeps its colour
    assert ink_bbox(render(out2, 0), lambda p: p[1] > 200 and p[0] < 50)


def test_set_colour_on_a_path_with_clip_keeps_the_clip(harness: Harness, tmp_path: Path) -> None:
    content = b"q 0 0 100 100 re W n 1 0 0 rg 50 50 100 100 re f Q 0 1 0 rg 60 60 10 10 re f"
    src = raw_pdf(tmp_path / "cl.pdf", content)
    sid = _sid(harness, src)
    objs = _objects(harness, sid)
    harness.op("content.setColor", {"ids": [objs[0]["id"]], "fill": "#0000ff"}, sid)
    out = _revision(harness, sid)
    assert is_blue(render(out, 0).convert("RGB").getpixel((90, 792 - 90)))
    assert render(out, 0).convert("RGB").getpixel((120, 792 - 120)) == (255, 255, 255)


def test_reorder_front_and_back_changes_the_top_object(harness: Harness, tmp_path: Path) -> None:
    src = raw_pdf(tmp_path / "ro.pdf", TWO_BOXES)
    sid = _sid(harness, src)
    overlap = (250, 200)
    before = _pixel(src, *overlap)
    assert before == (255, 0, 0)  # red is on top
    blue = _pick_colour(_objects(harness, sid), "#0000ff")
    harness.op("content.reorder", {"ids": [blue["id"]], "mode": "front"}, sid)
    out = _revision(harness, sid)
    assert _pixel(out, *overlap) == (0, 0, 255)
    blue = _pick_colour(_objects(harness, sid), "#0000ff")
    harness.op("content.reorder", {"ids": [blue["id"]], "mode": "back"}, sid)
    assert _pixel(_revision(harness, sid), *overlap) == (255, 0, 0)


def test_reorder_forward_and_backward_step_past_neighbours(
    harness: Harness, tmp_path: Path
) -> None:
    content = (
        b"q 0 0 1 rg 100 100 200 150 re f Q q 1 0 0 rg 200 180 200 150 re f Q "
        b"q 0 1 0 rg 250 200 50 50 re f Q"
    )
    src = raw_pdf(tmp_path / "step.pdf", content)
    sid = _sid(harness, src)
    blue = _pick_colour(_objects(harness, sid), "#0000ff")
    harness.op("content.reorder", {"ids": [blue["id"]], "mode": "forward"}, sid)
    out = _revision(harness, sid)
    kinds = [o["fillColor"] for o in _objects(harness, sid)]
    assert kinds == ["#ff0000", "#0000ff", "#00ff00"]  # blue moved one step up
    assert _pixel(out, 220, 220) == (0, 0, 255)  # blue now overlaps red at this point
    blue = _pick_colour(_objects(harness, sid), "#0000ff")  # ids change with each revision
    harness.op("content.reorder", {"ids": [blue["id"]], "mode": "backward"}, sid)
    assert [o["fillColor"] for o in _objects(harness, sid)] == ["#0000ff", "#ff0000", "#00ff00"]


def test_duplicate_places_a_copy_without_moving_later_text(
    harness: Harness, tmp_path: Path
) -> None:
    content = b"BT /F1 24 Tf 40 500 Td (AAAA) Tj (BBBB) Tj ET"
    src = raw_pdf(tmp_path / "dup.pdf", content)
    sid = _sid(harness, src)
    first = _objects(harness, sid)[0]
    harness.op("content.duplicate", {"ids": [first["id"]], "dx": 0, "dy": 100}, sid)
    out = _revision(harness, sid)
    texts = pdfium_chars(out)[1]  # AAAA, the copy of AAAA, BBBB
    original = pdfium_chars(src)[1]
    _same_boxes(texts[8:12], original[4:8])  # BBBB did not move
    assert page_text(out).count("AAAA") == 2
    # the copy is 100 pt lower on the displayed page (dy is measured downwards)
    assert texts[4][1] == pytest.approx(original[0][1] - 100, abs=0.5)


def test_duplicate_of_a_path(harness: Harness, tmp_path: Path) -> None:
    src = raw_pdf(tmp_path / "dp.pdf", RED_BOX)
    sid = _sid(harness, src)
    (obj,) = _objects(harness, sid)
    harness.op("content.duplicate", {"ids": [obj["id"]], "dx": 300, "dy": 0}, sid)
    out = _revision(harness, sid)
    assert _pixel(out, 400, 150) == (255, 0, 0)
    assert _pixel(out, 150, 150) == (255, 0, 0)
    assert len(_objects(harness, sid)) == 2


def test_set_opacity_blends_with_the_background(harness: Harness, tmp_path: Path) -> None:
    src = raw_pdf(tmp_path / "op.pdf", b"0 0 0 rg 100 100 200 150 re f")
    sid = _sid(harness, src)
    (obj,) = _objects(harness, sid)
    harness.op("content.setOpacity", {"ids": [obj["id"]], "opacity": 0.5}, sid)
    out = _revision(harness, sid)
    value = _pixel(out, 200, 175)[0]
    assert 120 <= value <= 136  # 50% black over white


def test_stale_ids_are_refused(harness: Harness, tmp_path: Path) -> None:
    src = raw_pdf(tmp_path / "st.pdf", TWO_BOXES)
    sid = _sid(harness, src)
    old = _objects(harness, sid)
    harness.op("content.setColor", {"ids": [old[0]["id"]], "fill": "#00ff00"}, sid)
    with pytest.raises(RpcFailure) as exc:
        harness.op("content.delete", {"ids": [old[1]["id"]]}, sid)
    assert exc.value.kind == "INVALID_PARAMS"
    assert "STALE_OBJECT_IDS" in str(exc.value)


def test_undo_and_redo_restore_the_objects(harness: Harness, tmp_path: Path) -> None:
    src = raw_pdf(tmp_path / "u.pdf", TWO_BOXES)
    sid = _sid(harness, src)
    objs = _objects(harness, sid)
    harness.op("content.delete", {"ids": [objs[0]["id"]]}, sid)
    assert len(_objects(harness, sid)) == 1
    harness.call("session.undo", {"sessionId": sid})
    assert len(_objects(harness, sid)) == 2
    harness.call("session.redo", {"sessionId": sid})
    assert len(_objects(harness, sid)) == 1


def test_signed_document_blocks_destructive_content_ops(
    harness: Harness, corpus: dict[str, Path]
) -> None:
    sid = _sid(harness, corpus["fake_signed.pdf"])
    for op, params in (
        ("content.delete", {"ids": ["p0:0:0"]}),
        ("content.move", {"ids": ["p0:0:0"], "dx": 1, "dy": 1}),
    ):
        with pytest.raises(RpcFailure) as exc:
            harness.op(op, params, sid)
        assert exc.value.kind == "BLOCKED_BY_SIGNATURE"
    assert _objects(harness, sid) is not None  # listing stays available


def test_editing_a_form_child_needs_flattening(harness: Harness, tmp_path: Path) -> None:
    def setup(pdf: pikepdf.Pdf, page: pikepdf.Page) -> None:
        inner = form_xobject(pdf, b"0 0 1 rg 0 0 50 50 re f", (0, 0, 50, 50))
        page.obj.Resources.XObject = pikepdf.Dictionary(Fm0=inner)

    src = raw_pdf(tmp_path / "fc.pdf", b"q 1 0 0 1 100 100 cm /Fm0 Do Q", setup=setup)
    sid = _sid(harness, src)
    objs = _objects(harness, sid, includeForms=True)
    child = next(o for o in objs if o["parentId"] is not None)
    with pytest.raises(RpcFailure) as exc:
        harness.op("content.delete", {"ids": [child["id"]]}, sid)
    assert "FORM_CHILD_NEEDS_FLATTEN" in str(exc.value)
    harness.op("content.delete", {"ids": [child["id"]], "flattenForms": True}, sid)
    out = _revision(harness, sid)
    assert _pixel(out, 125, 125) == (255, 255, 255)
    assert _pixel(src, 125, 125) == (0, 0, 255)


def test_multiple_content_streams_are_merged_on_edit(harness: Harness, tmp_path: Path) -> None:
    src = raw_pdf(
        tmp_path / "ms.pdf", [b"1 0 0 rg 10 10 20 20 re f", b"0 0 1 rg 300 300 20 20 re f"]
    )
    sid = _sid(harness, src)
    objs = _objects(harness, sid)
    harness.op("content.delete", {"ids": [objs[1]["id"]]}, sid)
    with pikepdf.open(_revision(harness, sid)) as pdf:
        assert not isinstance(pdf.pages[0].obj.Contents, pikepdf.Array)
    out = _revision(harness, sid)
    assert _pixel(out, 310, 310) == (255, 255, 255)
    assert _pixel(out, 20, 20) == (255, 0, 0)


def test_page_with_inherited_resources_is_copy_on_write(harness: Harness, tmp_path: Path) -> None:
    pdf = pikepdf.new()
    for _ in range(2):
        pdf.add_blank_page(page_size=(612, 792))
    font = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica
        )
    )
    pdf.Root.Pages.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
    for p in pdf.pages:
        if "/Resources" in p.obj:
            del p.obj["/Resources"]
        p.obj.Contents = pdf.make_stream(b"0 0 0 rg 100 100 200 150 re f")
    src = tmp_path / "inh.pdf"
    pdf.save(src)
    pdf.close()
    sid = _sid(harness, src)
    (obj,) = _objects(harness, sid, page=0)
    harness.op("content.setOpacity", {"ids": [obj["id"]], "opacity": 0.25}, sid)
    out = _revision(harness, sid)
    assert 180 <= _pixel(out, 200, 175)[0] <= 200  # page 0 is 25% black
    assert render(out, 1).convert("RGB").getpixel((200, 792 - 175)) == (0, 0, 0)  # page 1 untouched
    with pikepdf.open(out) as pdf2:
        assert pdf2.pages[1].obj.Contents.read_bytes() == b"0 0 0 rg 100 100 200 150 re f"
    assert ink_bbox(render(out, 1), is_red) is None


def test_move_a_text_run_keeps_the_text_after_it(harness: Harness, tmp_path: Path) -> None:
    src = raw_pdf(tmp_path / "mt.pdf", b"BT /F1 24 Tf 40 500 Td (AAAA) Tj (BBBB) Tj ET")
    sid = _sid(harness, src)
    first = _objects(harness, sid)[0]
    harness.op("content.move", {"ids": [first["id"]], "dx": 10, "dy": 20}, sid)
    out = _revision(harness, sid)
    before = pdfium_chars(src)[1]
    after = pdfium_chars(out)[1]
    moved = [(x0 + 10, y0 - 20, x1 + 10, y1 - 20) for x0, y0, x1, y1 in before[0:4]]
    _same_boxes(after[0:4], moved, tol=0.05)  # AAAA moved by (+10, -20)
    _same_boxes(after[4:8], before[4:8])  # BBBB stayed where it was
    assert "AAAA" in page_text(out) and "BBBB" in page_text(out)


def test_reorder_text_to_the_front_draws_it_over_a_box(harness: Harness, tmp_path: Path) -> None:
    content = b"BT /F1 60 Tf 100 300 Td (HHH) Tj ET q 1 0 0 rg 90 290 300 80 re f Q"
    src = raw_pdf(tmp_path / "tf.pdf", content)
    sid = _sid(harness, src)
    text = _objects(harness, sid)[0]
    assert text["kind"] == "text"
    harness.op("content.reorder", {"ids": [text["id"]], "mode": "front"}, sid)
    out = _revision(harness, sid)
    dark = ink_bbox(render(out, 0), lambda p: max(p) < 90)
    assert dark is not None  # the glyphs are visible on top of the red box
    assert dark[0] >= 100 and dark[2] <= 300 and dark[1] < 792 - 290  # inside the text area
    assert ink_bbox(render(src, 0), lambda p: max(p) < 90) is None  # hidden before
