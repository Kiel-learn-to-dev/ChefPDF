"""Page editing (C6-C10): replace, crop / trim / resize, blank pages, split, smart file split."""

from __future__ import annotations

import random
from pathlib import Path

import pikepdf
import pytest
from conftest import Harness, RpcFailure
from pdf_media import new_pdf, place, render, save
from PIL import Image

from chef_core.ops.pageedit import display_to_user, piece_boxes


def _doc(path: Path, pages: list[dict[str, object]]) -> Path:
    """One page per entry: optional 'rect' (x, y, w, h, colour), 'text', 'rotate', 'width'."""
    pdf = new_pdf(0)
    for spec in pages:
        width = float(spec.get("width", 612))  # type: ignore[arg-type]
        page = pdf.add_blank_page(page_size=(width, 792))
        text = str(spec["text"]) if "text" in spec else None
        place(pdf, page, [], text=text)
        if "rect" in spec:
            x, y, w, h, colour = spec["rect"]  # type: ignore[misc]
            drawing = f"{colour} rg {x} {y} {w} {h} re f\n".encode("latin-1")
            page.obj.Contents = pdf.make_stream(drawing + page.obj.Contents.read_bytes())
        if "rotate" in spec:
            page.obj.Rotate = spec["rotate"]
    return save(pdf, path)


def _sid(h: Harness, path: Path) -> str:
    return str(h.open(path)["state"]["sessionId"])


def _rev(h: Harness, sid: str) -> Path:
    return Path(h.call("session.state", {"sessionId": sid})["revisionPath"])


def _widths(path: Path) -> list[float]:
    with pikepdf.open(path) as pdf:
        return [round(float(p.mediabox[2]) - float(p.mediabox[0]), 2) for p in pdf.pages]


def _cropbox(path: Path, index: int = 0) -> tuple[float, ...]:
    with pikepdf.open(path) as pdf:
        return tuple(round(float(v), 2) for v in pdf.pages[index].cropbox)


def _ink_bbox(img: Image.Image) -> tuple[int, int, int, int] | None:
    return img.convert("L").point(lambda v: 255 if v < 200 else 0).getbbox()


# -- mapping ----------------------------------------------------------------------------


def test_display_mapping_corners() -> None:
    box = (0.0, 0.0, 612.0, 792.0)
    assert display_to_user(box, 0, 0, 0) == (0.0, 792.0)  # displayed top-left
    assert display_to_user(box, 90, 0, 0) == (0.0, 0.0)  # clockwise: bottom-left
    assert display_to_user(box, 180, 0, 0) == (612.0, 0.0)
    assert display_to_user(box, 270, 0, 0) == (612.0, 792.0)


def test_piece_boxes_reading_order() -> None:
    box = (0.0, 0.0, 600.0, 400.0)
    ltr = piece_boxes(box, 0, 1, 2, 0, "ltr")
    rtl = piece_boxes(box, 0, 1, 2, 0, "rtl")
    assert ltr[0][0] == 0 and ltr[0][2] == 300 and ltr[1][0] == 300
    assert rtl[0][0] == 300 and rtl[1][0] == 0


# -- C6 replace -------------------------------------------------------------------------


def test_replace_with_a_different_count(harness: Harness, tmp_path: Path) -> None:
    main = _doc(tmp_path / "main.pdf", [{"width": 100}, {"width": 101}, {"width": 102}])
    other = _doc(tmp_path / "other.pdf", [{"width": 200}, {"width": 201}])
    sid = _sid(harness, main)
    harness.op("page.replace", {"pages": [1], "path": str(other)}, sid)
    assert _widths(_rev(harness, sid)) == [100, 200, 201, 102]


def test_replace_uses_source_selection_order(harness: Harness, tmp_path: Path) -> None:
    main = _doc(tmp_path / "main.pdf", [{"width": 100}, {"width": 101}])
    other = _doc(tmp_path / "other.pdf", [{"width": 300}, {"width": 301}, {"width": 302}])
    sid = _sid(harness, main)
    harness.op("page.replace", {"pages": [0], "path": str(other), "sourcePages": [2, 0]}, sid)
    assert _widths(_rev(harness, sid)) == [302, 300, 101]


def test_replace_rejects_bad_index(harness: Harness, tmp_path: Path) -> None:
    main = _doc(tmp_path / "main.pdf", [{"width": 100}])
    other = _doc(tmp_path / "other.pdf", [{"width": 200}])
    sid = _sid(harness, main)
    with pytest.raises(RpcFailure) as exc:
        harness.op("page.replace", {"pages": [4], "path": str(other)}, sid)
    assert exc.value.kind == "INVALID_PARAMS"


# -- C7 crop ----------------------------------------------------------------------------


def test_crop_margins_in_mm(harness: Harness, tmp_path: Path) -> None:
    src = _doc(tmp_path / "m.pdf", [{}])
    sid = _sid(harness, src)
    harness.op("page.crop", {"margins": {"top": 10, "bottom": 10, "left": 5, "right": 5}}, sid)
    mm = 72 / 25.4
    box = _cropbox(_rev(harness, sid))
    assert box == pytest.approx((5 * mm, 10 * mm, 612 - 5 * mm, 792 - 10 * mm), abs=0.01)


@pytest.mark.parametrize("rotate", [0, 90, 180, 270])
def test_crop_margins_follow_rotation(harness: Harness, tmp_path: Path, rotate: int) -> None:
    src = _doc(tmp_path / f"r{rotate}.pdf", [{"rotate": rotate}])
    sid = _sid(harness, src)
    before = render(src).size
    harness.op("page.crop", {"margins": {"left": 20}}, sid)
    after = render(_rev(harness, sid)).size
    mm = 72 / 25.4
    # The render shows the displayed page: a 20 mm cut from its displayed left edge.
    assert abs(after[0] - (before[0] - 20 * mm)) <= 1.5
    assert after[1] == before[1]


def test_crop_absolute_box_and_mediabox_mode(harness: Harness, tmp_path: Path) -> None:
    src = _doc(tmp_path / "b.pdf", [{}, {}])
    sid = _sid(harness, src)
    harness.op("page.crop", {"scope": "pages", "pages": [1], "box": [100, 100, 400, 500]}, sid)
    assert _cropbox(_rev(harness, sid), 1) == (100.0, 100.0, 400.0, 500.0)
    assert _cropbox(_rev(harness, sid), 0) == (0.0, 0.0, 612.0, 792.0)
    harness.op("page.crop", {"mode": "mediabox", "scope": "odd", "box": [0, 0, 300, 300]}, sid)
    with pikepdf.open(_rev(harness, sid)) as pdf:
        assert [round(float(v)) for v in pdf.pages[0].obj.MediaBox] == [0, 0, 300, 300]


def test_crop_needs_exactly_one_method(harness: Harness, tmp_path: Path) -> None:
    src = _doc(tmp_path / "x.pdf", [{}])
    sid = _sid(harness, src)
    with pytest.raises(RpcFailure) as exc:
        harness.call(
            "ops.run",
            {
                "sessionId": sid,
                "opId": "page.crop",
                "params": {"autoTrim": True, "margins": {"top": 1}},
            },
        )
    assert exc.value.kind == "INVALID_PARAMS"


@pytest.mark.parametrize("rotate", [0, 90, 180, 270])
def test_auto_trim_removes_white_margins(harness: Harness, tmp_path: Path, rotate: int) -> None:
    # A dark block in the upper-left part of the page (user space), on a 612x792 page.
    src = _doc(
        tmp_path / f"t{rotate}.pdf",
        [{"rect": (40, 620, 150, 120, "0 0 0"), "rotate": rotate}],
    )
    sid = _sid(harness, src)
    harness.op("page.crop", {"autoTrim": True, "trimPaddingMm": 2, "trimDpi": 72}, sid)
    img = render(_rev(harness, sid))
    bbox = _ink_bbox(img)
    assert bbox is not None
    pad = 2 * 72 / 25.4
    # The block reaches the edges of the crop except for the padding on each side.
    assert bbox[0] <= pad + 2 and bbox[1] <= pad + 2
    assert img.size[0] - bbox[2] <= pad + 2 and img.size[1] - bbox[3] <= pad + 2
    assert img.size[0] < 612 and img.size[1] < 792


def test_auto_trim_on_blank_page_changes_nothing(harness: Harness, tmp_path: Path) -> None:
    src = _doc(tmp_path / "blank.pdf", [{}])
    sid = _sid(harness, src)
    result = harness.op("page.crop", {"autoTrim": True}, sid)
    assert any("blank" in w for w in result["warnings"])
    assert _cropbox(_rev(harness, sid)) == (0.0, 0.0, 612.0, 792.0)


def test_crop_is_undoable(harness: Harness, tmp_path: Path) -> None:
    src = _doc(tmp_path / "u.pdf", [{}])
    sid = _sid(harness, src)
    harness.op("page.crop", {"margins": {"top": 50}}, sid)
    harness.call("session.undo", {"sessionId": sid})
    assert _cropbox(_rev(harness, sid)) == (0.0, 0.0, 612.0, 792.0)


# -- C7 resize --------------------------------------------------------------------------


def test_resize_to_a4_keeps_orientation(harness: Harness, tmp_path: Path) -> None:
    src = _doc(tmp_path / "rs.pdf", [{}, {"width": 800}])
    sid = _sid(harness, src)
    harness.op("page.resize", {"size": "A4"}, sid)
    with pikepdf.open(_rev(harness, sid)) as pdf:
        assert round(float(pdf.pages[0].mediabox[2]), 1) == 595.3  # portrait stays portrait
        assert round(float(pdf.pages[1].mediabox[2]), 1) == 841.9  # landscape stays landscape


def test_resize_on_rotated_page_keeps_rotation(harness: Harness, tmp_path: Path) -> None:
    src = _doc(tmp_path / "rot.pdf", [{"rotate": 90}])
    sid = _sid(harness, src)
    harness.op("page.resize", {"size": "A4"}, sid)
    out = _rev(harness, sid)
    with pikepdf.open(out) as pdf:
        assert int(pdf.pages[0].obj.Rotate) == 90
    width, height = render(out).size
    assert abs(width - 842) <= 1 and abs(height - 595) <= 1  # displayed landscape A4


def test_resize_centre_keeps_scale(harness: Harness, tmp_path: Path) -> None:
    src = _doc(tmp_path / "small.pdf", [{"rect": (0, 0, 100, 100, "1 0 0")}])
    sid = _sid(harness, src)
    harness.op("page.resize", {"size": "Letter", "fit": "center"}, sid)
    img = render(_rev(harness, sid))
    assert img.size == (612, 792)
    pixel = img.getpixel((10, 792 - 10))  # the 100 pt square stays at the bottom-left corner
    assert pixel[0] > 200 and pixel[1] < 60


def test_resize_scale_fit_scales_content_to_page(harness: Harness, tmp_path: Path) -> None:
    src = _doc(tmp_path / "scale.pdf", [{"rect": (0, 0, 100, 100, "1 0 0")}])
    sid = _sid(harness, src)
    harness.op("page.resize", {"size": "A4", "fit": "scale"}, sid)
    img = render(_rev(harness, sid))
    assert abs(img.size[0] - 595) <= 1 and abs(img.size[1] - 842) <= 1  # pdfium rounds
    bbox = _ink_bbox(img)
    assert bbox is not None
    # A 612 pt page is scaled by 595/612: the 100 pt square is about 97 px at bottom-left.
    assert bbox[0] <= 2 and abs((bbox[2] - bbox[0]) - 97) <= 2
    # The scaled page (770 pt tall) is centred vertically: a gap of about 36 px below the square.
    assert abs((img.size[1] - bbox[3]) - 36) <= 2


def test_resize_custom_requires_size(harness: Harness, tmp_path: Path) -> None:
    src = _doc(tmp_path / "c.pdf", [{}])
    sid = _sid(harness, src)
    with pytest.raises(RpcFailure) as exc:
        harness.call(
            "ops.run", {"sessionId": sid, "opId": "page.resize", "params": {"size": "custom"}}
        )
    assert exc.value.kind == "INVALID_PARAMS"


# -- C8 blank pages ---------------------------------------------------------------------


def _noise_image(pdf: pikepdf.Pdf) -> pikepdf.Stream:
    """400x400 scanner-like noise with values 215..255 (never darker than the 200 cut-off)."""
    data = bytes(215 + (b % 41) for b in random.Random(3).randbytes(400 * 400))
    stream = pdf.make_stream(data)
    stream.Type = pikepdf.Name.XObject
    stream.Subtype = pikepdf.Name.Image
    stream.Width, stream.Height = 400, 400
    stream.BitsPerComponent = 8
    stream.ColorSpace = pikepdf.Name.DeviceGray
    return stream


def _blank_fixture(path: Path) -> Path:
    """Pages: text, blank, near-white noise, half black, blank with an annotation."""
    pdf = new_pdf(0)
    for kind in ("text", "blank", "noise", "ink", "annot"):
        page = pdf.add_blank_page(page_size=(612, 792))
        if kind == "text":
            place(pdf, page, [], text="Real words here")
        elif kind == "noise":
            place(pdf, page, [("Im0", _noise_image(pdf), 0, 0, 612, 792)])
        elif kind == "ink":
            place(pdf, page, [])
            page.obj.Contents = pdf.make_stream(b"0 0 0 rg 0 0 612 400 re f")
        else:
            place(pdf, page, [])
            if kind == "annot":
                note = pdf.make_indirect(
                    pikepdf.Dictionary(
                        Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Text, Rect=[0, 0, 5, 5]
                    )
                )
                page.obj["/Annots"] = pikepdf.Array([note])
    return save(pdf, path)


def test_find_blank_candidates(harness: Harness, tmp_path: Path) -> None:
    src = _blank_fixture(tmp_path / "blank.pdf")
    sid = _sid(harness, src)
    data = harness.op("page.findBlank", {}, sid)["data"]
    rows = {row["index"]: row for row in data["pages"]}
    assert rows[0]["hasText"] and not rows[0]["blank"]
    assert rows[1]["blank"]
    assert rows[2]["blank"], "near-white noise must count as blank"
    assert not rows[3]["blank"]
    assert not rows[4]["blank"], "a page with annotations is kept by default"
    assert data["candidates"] == [1, 2]


def test_remove_blank_deletes_candidates(harness: Harness, tmp_path: Path) -> None:
    src = _blank_fixture(tmp_path / "blank2.pdf")
    sid = _sid(harness, src)
    result = harness.op("page.removeBlank", {"keepIfAnnotations": True}, sid)
    assert result["data"]["removed"] == [1, 2]
    with pikepdf.open(_rev(harness, sid)) as pdf:
        assert len(pdf.pages) == 3


def test_remove_blank_refuses_all_pages(harness: Harness, tmp_path: Path) -> None:
    src = _doc(tmp_path / "all.pdf", [{}, {}])
    sid = _sid(harness, src)
    with pytest.raises(RpcFailure) as exc:
        harness.op("page.removeBlank", {}, sid)
    assert exc.value.kind == "INVALID_PARAMS"


def test_blank_sensitivity_is_monotonic(harness: Harness, tmp_path: Path) -> None:
    src = _blank_fixture(tmp_path / "sens.pdf")
    sid = _sid(harness, src)
    strict = harness.op("page.findBlank", {"sensitivity": 0}, sid)["data"]["candidates"]
    loose = harness.op("page.findBlank", {"sensitivity": 1}, sid)["data"]["candidates"]
    assert set(strict) <= set(loose)


# -- C9 split ---------------------------------------------------------------------------


def test_split_halves_ltr(harness: Harness, tmp_path: Path) -> None:
    src = _doc(tmp_path / "spread.pdf", [{"rect": (0, 0, 300, 792, "1 0 0")}])
    sid = _sid(harness, src)
    harness.op("page.split", {"rows": 1, "cols": 2, "order": "ltr"}, sid)
    out = _rev(harness, sid)
    assert [round(c[2] - c[0], 2) for c in (_cropbox(out, 0), _cropbox(out, 1))] == [306.0, 306.0]
    left = render(out, 0).getpixel((10, 400))
    right = render(out, 1).getpixel((10, 400))
    assert left[1] < 60  # the red left half is on the first piece
    assert right[1] > 200  # the second piece shows white


def test_split_halves_rtl_reverses_reading_order(harness: Harness, tmp_path: Path) -> None:
    src = _doc(tmp_path / "book.pdf", [{"rect": (0, 0, 300, 792, "1 0 0")}])
    sid = _sid(harness, src)
    harness.op("page.split", {"rows": 1, "cols": 2, "order": "rtl"}, sid)
    out = _rev(harness, sid)
    assert render(out, 0).getpixel((10, 400))[1] > 200  # first piece is the right half
    assert render(out, 1).getpixel((10, 400))[1] < 60  # second piece is the red left half


def test_split_grid_and_overlap(harness: Harness, tmp_path: Path) -> None:
    src = _doc(tmp_path / "grid.pdf", [{}, {}])
    sid = _sid(harness, src)
    result = harness.op("page.split", {"rows": 2, "cols": 2, "overlapMm": 10, "pages": [0]}, sid)
    assert result["changedPages"] == "all"
    with pikepdf.open(_rev(harness, sid)) as pdf:
        assert len(pdf.pages) == 2 + 4 - 1  # page 0 became four pieces
    first = _cropbox(_rev(harness, sid), 0)  # top-left piece
    half_overlap = 5 * 72 / 25.4
    assert first[2] == pytest.approx(306 + half_overlap, abs=0.5)
    assert first[1] == pytest.approx(396 - half_overlap, abs=0.5)


def test_split_is_undoable(harness: Harness, tmp_path: Path) -> None:
    src = _doc(tmp_path / "sp2.pdf", [{}])
    sid = _sid(harness, src)
    harness.op("page.split", {"rows": 1, "cols": 2}, sid)
    harness.call("session.undo", {"sessionId": sid})
    with pikepdf.open(_rev(harness, sid)) as pdf:
        assert len(pdf.pages) == 1


# -- C10 smart split --------------------------------------------------------------------


def test_split_at_blank_separators(harness: Harness, tmp_path: Path) -> None:
    src = _blank_fixture(tmp_path / "seps.pdf")  # text, blank, noise, ink, annot
    kept = harness.op(
        "file.splitSmart",
        {"path": str(src), "mode": "blank", "outputDir": str(tmp_path / "parts")},
    )
    # [text, blank] [noise(blank)] [ink, annot]: each separator closes a part.
    assert len(kept["outputs"]) == 3
    dropped = harness.op(
        "file.splitSmart",
        {
            "path": str(src),
            "mode": "blank",
            "outputDir": str(tmp_path / "parts2"),
            "dropSeparatorPages": True,
        },
    )
    assert len(dropped["outputs"]) == 2  # [text] and [ink, annot]
    assert sum(len(pikepdf.open(p).pages) for p in dropped["outputs"]) == 3


def test_split_by_bookmark_level(harness: Harness, tmp_path: Path) -> None:
    pdf = new_pdf(0)
    for i in range(4):
        page = pdf.add_blank_page(page_size=(612, 792))
        place(pdf, page, [], text=f"p{i}")
    with pdf.open_outline() as outline:
        chapter = pikepdf.OutlineItem("Chapter A", 0)
        chapter.children.append(pikepdf.OutlineItem("Section", 1))
        outline.root.append(chapter)
        outline.root.append(pikepdf.OutlineItem("Chapter B", 2))
    src = save(pdf, tmp_path / "book.pdf")
    top = harness.op(
        "file.splitSmart",
        {"path": str(src), "mode": "bookmarkLevel", "level": 1, "outputDir": str(tmp_path / "top")},
    )
    assert len(top["outputs"]) == 2  # [p0, p1] and [p2, p3]
    sub = harness.op(
        "file.splitSmart",
        {"path": str(src), "mode": "bookmarkLevel", "level": 2, "outputDir": str(tmp_path / "sub")},
    )
    assert len(sub["outputs"]) == 2  # [p0] and [p1, p2, p3]: the section starts at p1


def test_split_by_pattern(harness: Harness, tmp_path: Path) -> None:
    src = _doc(
        tmp_path / "chapters.pdf",
        [
            {"text": "Chapter 1 start"},
            {"text": "body"},
            {"text": "Chapter 2 start"},
            {"text": "end"},
        ],
    )
    result = harness.op(
        "file.splitSmart",
        {
            "path": str(src),
            "mode": "pattern",
            "pattern": r"^chapter \d",
            "outputDir": str(tmp_path / "ch"),
            "nameTemplate": "{name}-{start}-{end}",
        },
    )
    names = sorted(Path(p).name for p in result["outputs"])
    assert names == ["chapters-1-2.pdf", "chapters-3-4.pdf"]
    assert result["data"]["parts"] == 2


def test_split_smart_validates_pattern(harness: Harness, tmp_path: Path) -> None:
    src = _doc(tmp_path / "v.pdf", [{}])
    with pytest.raises(RpcFailure) as exc:
        harness.call(
            "ops.run",
            {
                "opId": "file.splitSmart",
                "params": {
                    "path": str(src),
                    "mode": "pattern",
                    "pattern": "(",
                    "outputDir": str(tmp_path / "o"),
                },
            },
        )
    assert exc.value.kind == "INVALID_PARAMS"


# -- signed --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "op_id,params",
    [
        ("page.crop", {"margins": {"top": 5}}),
        ("page.resize", {"size": "A4"}),
        ("page.removeBlank", {}),
        ("page.split", {}),
    ],
)
def test_signed_document_is_blocked(
    harness: Harness, corpus: dict[str, Path], op_id: str, params: dict[str, object]
) -> None:
    sid = _sid(harness, corpus["fake_signed.pdf"])
    with pytest.raises(RpcFailure) as exc:
        harness.op(op_id, params, sid)
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"
