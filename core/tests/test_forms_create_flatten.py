"""H2 and H3: creating fields, editing them, page rotation, flattening and detection (experimental).

Flattening is checked three ways: the filled and flattened pages render alike (pixels), the
fields are gone (listing and AcroForm), and the typed Vietnamese text can be extracted from the
page content once it is no longer a widget.
"""

from __future__ import annotations

import unicodedata
from pathlib import Path

import pikepdf
import pytest
from forms_support import (
    Runner,
    blank,
    dark_pixels,
    diff_count,
    expect_error,
    pikepdf_form,
    render,
    reportlab_form,
)
from pypdfium2 import PdfDocument

from chef_core.forms.detect import detect
from chef_core.forms.model import FormDoc
from chef_core.text.build import build_text_page

VI = "Nguyễn Thị Hà ệ ơ ư"


@pytest.fixture
def runner(tmp_path: Path) -> Runner:
    return Runner(tmp_path)


def _by_name(runner: Runner, src: Path) -> dict[str, dict]:
    return {f["name"]: f for f in runner.data("forms.list", {}, src)["fields"]}


def _add(runner: Runner, src: Path, **params: object) -> Path:
    return runner.step("forms.addField", dict(params), src)


def test_add_each_kind_then_list_them(runner: Runner, tmp_path: Path) -> None:
    src = blank(tmp_path / "b.pdf")
    rev = _add(runner, src, kind="text", pageIndex=0, rect=[20, 20, 180, 40], name="hoten")
    rev = _add(runner, rev, kind="multiline", pageIndex=0, rect=[20, 50, 220, 110], name="ghichu")
    rev = _add(
        runner, rev, kind="comb", pageIndex=0, rect=[20, 120, 200, 140], name="cmnd", maxLen=9
    )
    rev = _add(runner, rev, kind="checkbox", pageIndex=0, rect=[20, 150, 34, 164], name="dongy")
    rev = _add(
        runner, rev, kind="radio", pageIndex=0, rect=[20, 170, 34, 184], name="gioi",
        exportValue="nam",
    )  # fmt: skip
    rev = _add(
        runner, rev, kind="radio", pageIndex=0, rect=[60, 170, 74, 184], name="gioi",
        exportValue="nu",
    )  # fmt: skip
    rev = _add(
        runner, rev, kind="dropdown", pageIndex=0, rect=[20, 190, 140, 210], name="tinh",
        options=["Ha Noi", "HCM"],
    )  # fmt: skip
    rev = _add(
        runner, rev, kind="listbox", pageIndex=0, rect=[160, 190, 280, 240], name="ngonngu",
        options=["Vi", "En"], multiSelect=True,
    )  # fmt: skip
    rev = _add(
        runner, rev, kind="button", pageIndex=0, rect=[20, 250, 100, 270], name="in", label="In"
    )  # fmt: skip
    rev = _add(
        runner, rev, kind="text", pageIndex=0, rect=[20, 280, 90, 295], name="cty.diachi.phuong"
    )

    fields = _by_name(runner, rev)
    assert fields["hoten"]["type"] == "text"
    assert fields["ghichu"]["type"] == "multiline"
    assert fields["cmnd"]["type"] == "comb" and fields["cmnd"]["flags"]["maxLen"] == 9
    assert fields["dongy"]["type"] == "checkbox"
    assert [o["export"] for o in fields["gioi"]["options"]] == ["nam", "nu"]
    assert fields["tinh"]["type"] == "dropdown"
    assert fields["ngonngu"]["flags"]["multiSelect"] is True
    assert fields["in"]["type"] == "button"
    assert "cty.diachi.phuong" in fields
    assert fields["hoten"]["widgets"][0]["rect"] == [20, 20, 180, 40]


def test_created_fields_take_vietnamese_fill_and_show_ink(runner: Runner, tmp_path: Path) -> None:
    rev = _add(
        runner, blank(tmp_path / "b.pdf"), kind="text", pageIndex=0,
        rect=[20, 20, 200, 44], name="hoten",
    )  # fmt: skip
    rev = _add(runner, rev, kind="checkbox", pageIndex=0, rect=[20, 60, 34, 74], name="dongy")
    filled = runner.step(
        "forms.fill", {"values": {"hoten": VI, "dongy": True}}, rev
    )  # fmt: skip
    got = runner.data("forms.getValues", {}, filled)["values"]
    assert got["hoten"] == VI and got["dongy"] is True
    img = render(filled)
    assert dark_pixels(img, (20, 20, 200, 44)) > 30  # text field, displayed top-left rectangle
    assert dark_pixels(img, (20, 60, 34, 74)) > 20  # check box mark


def test_creation_rules_are_enforced(runner: Runner, tmp_path: Path) -> None:
    src = blank(tmp_path / "b.pdf")
    rev = _add(runner, src, kind="text", pageIndex=0, rect=[20, 20, 100, 40], name="a")
    expect_error(
        lambda: runner.run(
            "forms.addField",
            {"kind": "text", "pageIndex": 0, "rect": [20, 60, 100, 80], "name": "a"},
            rev,
        ),
        "INVALID_PARAMS",
    )
    expect_error(
        lambda: runner.run(
            "forms.addField",
            {"kind": "text", "pageIndex": 0, "rect": [20, 60, 100, 80], "name": "ten co dau cach"},
            rev,
        ),
        "INVALID_PARAMS",
    )
    expect_error(
        lambda: runner.run(
            "forms.addField",
            {"kind": "comb", "pageIndex": 0, "rect": [20, 60, 100, 80], "name": "b"},
            rev,
        ),
        "INVALID_PARAMS",
    )  # fmt: skip
    expect_error(
        lambda: runner.run(
            "forms.addField",
            {"kind": "dropdown", "pageIndex": 0, "rect": [20, 60, 100, 80], "name": "c"},
            rev,
        ),
        "INVALID_PARAMS",
    )  # fmt: skip
    expect_error(
        lambda: runner.run(
            "forms.addField",
            {"kind": "text", "pageIndex": 3, "rect": [20, 60, 100, 80], "name": "d"},
            rev,
        ),
        "INVALID_PARAMS",
    )  # fmt: skip
    expect_error(
        lambda: runner.run(
            "forms.addField",
            {"kind": "text", "pageIndex": 0, "rect": [100, 60, 20, 80], "name": "e"},
            rev,
        ),
        "INVALID_PARAMS",
    )  # fmt: skip


def test_rotated_page_maps_displayed_rectangles(runner: Runner, tmp_path: Path) -> None:
    """A landscape page shown with /Rotate 90: rectangles are given in the displayed frame."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300, 200))
    page.obj.Rotate = 90
    path = tmp_path / "rot.pdf"
    pdf.save(path)
    # displayed page is 200 wide and 300 high after the rotation
    rev = _add(runner, path, kind="text", pageIndex=0, rect=[30, 40, 150, 70], name="hoten")
    field = _by_name(runner, rev)["hoten"]
    assert field["widgets"][0]["rect"] == [30, 40, 150, 70]
    filled = runner.step("forms.fill", {"values": {"hoten": "Lan Anh"}}, rev)
    img = render(filled)
    assert img.size == (200, 300)
    assert dark_pixels(img, (30, 40, 150, 70)) > 20
    assert dark_pixels(img, (150, 40, 200, 70)) < 3


def test_update_properties_rename_and_remove(runner: Runner, tmp_path: Path) -> None:
    rev = _add(
        runner, blank(tmp_path / "b.pdf"), kind="text", pageIndex=0,
        rect=[20, 20, 200, 40], name="hoten",
    )  # fmt: skip
    rev = runner.step(
        "forms.update",
        {"name": "hoten", "properties": {"label": "Họ tên", "maxLen": 5, "required": True}},
        rev,
    )  # fmt: skip
    field = _by_name(runner, rev)["hoten"]
    assert field["tooltip"] == "Họ tên"
    assert field["flags"]["maxLen"] == 5 and field["flags"]["required"] is True
    expect_error(
        lambda: runner.run("forms.fill", {"values": {"hoten": "Nguyễn"}}, rev), "INVALID_PARAMS"
    )
    moved = runner.step(
        "forms.update", {"name": "hoten", "properties": {"rect": [40, 60, 220, 80]}}, rev
    )  # fmt: skip
    assert _by_name(runner, moved)["hoten"]["widgets"][0]["rect"] == [40, 60, 220, 80]
    renamed = runner.step("forms.rename", {"name": "hoten", "newName": "ho"}, moved)
    assert set(_by_name(runner, renamed)) == {"ho"}
    removed = runner.step("forms.remove", {"names": ["ho"]}, renamed)
    assert _by_name(runner, removed) == {}


def test_rename_refuses_existing_name_and_dotted_partials(runner: Runner, tmp_path: Path) -> None:
    rev = _add(
        runner, blank(tmp_path / "b.pdf"), kind="text", pageIndex=0, rect=[20, 20, 90, 40], name="a"
    )
    rev = _add(runner, rev, kind="text", pageIndex=0, rect=[20, 60, 90, 80], name="b")
    expect_error(
        lambda: runner.run("forms.rename", {"name": "a", "newName": "b"}, rev), "INVALID_PARAMS"
    )
    expect_error(
        lambda: runner.run("forms.rename", {"name": "a", "newName": "x.y"}, rev), "INVALID_PARAMS"
    )


def test_tab_order_sets_annotation_order_and_tabs(runner: Runner, tmp_path: Path) -> None:
    rev = _add(
        runner, blank(tmp_path / "b.pdf"), kind="text", pageIndex=0, rect=[20, 20, 90, 40], name="a"
    )
    rev = _add(runner, rev, kind="text", pageIndex=0, rect=[20, 60, 90, 80], name="b")
    rev = _add(runner, rev, kind="text", pageIndex=0, rect=[20, 100, 90, 120], name="c")
    ordered = runner.step("forms.setTabOrder", {"order": ["c", "a", "b"]}, rev)
    with pikepdf.open(ordered) as pdf:
        names = [str(a.get("/T", "")) for a in pdf.pages[0].obj.Annots]
        assert names == ["c", "a", "b"]
        assert str(pdf.pages[0].obj.Tabs) == "/S"


def test_a_created_text_field_takes_more_than_one_fill(runner: Runner, tmp_path: Path) -> None:
    rev = _add(
        runner, blank(tmp_path / "b.pdf"), kind="text", pageIndex=0, rect=[20, 20, 90, 40], name="a"
    )
    rev = runner.step("forms.fill", {"values": {"a": "xyz"}}, rev)
    assert runner.data("forms.getValues", {}, rev)["values"]["a"] == "xyz"


def test_signature_field_is_created_by_sign_add_field(runner: Runner, tmp_path: Path) -> None:
    rev = runner.step(
        "forms.addField",
        {
            "kind": "signature",
            "pageIndex": 0,
            "rect": [20, 20, 180, 60],
            "name": "NguoiKy1",
            "label": "Giám đốc",
        },
        blank(tmp_path / "b.pdf"),
    )  # fmt: skip
    listed = runner.data("sign.listFields", {}, rev)["fields"]
    assert [f["fieldName"] for f in listed] == ["NguoiKy1"]
    assert listed[0]["signed"] is False


def test_signature_fields_survive_form_fill_and_flatten(runner: Runner, tmp_path: Path) -> None:
    src = pikepdf_form(tmp_path / "f.pdf")
    rev = runner.step(
        "forms.addField",
        {"kind": "signature", "pageIndex": 0, "rect": [20, 240, 180, 290], "name": "NguoiKy1"},
        src,
    )  # fmt: skip
    filled = runner.step("forms.fill", {"values": {"hoten": "Lan"}, "flatten": True}, rev)
    names = {f["name"] for f in runner.data("forms.list", {}, filled)["fields"]}
    assert names == {"NguoiKy1"}


def test_flatten_matches_the_filled_form_and_removes_fields(runner: Runner, tmp_path: Path) -> None:
    src = pikepdf_form(tmp_path / "f.pdf")
    values = {"hoten": VI, "dongy": True, "gioitinh": "nu", "tinh": "HCM"}
    filled = runner.step("forms.fill", {"values": values}, src)
    before = render(filled)
    flat = runner.step("forms.flatten", {}, filled)
    after = render(flat)
    assert diff_count(before, after, tol=60) < 0.01 * before.width * before.height
    assert runner.data("forms.list", {}, flat)["fields"] == []
    with pikepdf.open(flat) as pdf:
        assert "/AcroForm" not in pdf.Root
        assert not pdf.pages[0].obj.get("/Annots")
    # the page text now carries the typed Vietnamese (extractable, not only as a widget)
    doc = PdfDocument(str(flat))
    try:
        text = unicodedata.normalize("NFC", doc[0].get_textpage().get_text_range())
    finally:
        doc.close()
    assert unicodedata.normalize("NFC", "Nguyễn Thị Hà") in text.replace("\r", "")


def test_flatten_by_name_and_page_keeps_other_fields(runner: Runner, tmp_path: Path) -> None:
    src = pikepdf_form(tmp_path / "f.pdf")
    filled = runner.step("forms.fill", {"values": {"hoten": "A", "ten": "B"}}, src)
    flat = runner.step("forms.flatten", {"names": ["hoten"]}, filled)
    names = set(_by_name(runner, flat))
    assert "hoten" not in names and "ten" in names


def test_partial_flatten_preserves_xfa_until_the_last_field_is_removed(
    runner: Runner, tmp_path: Path
) -> None:
    src = pikepdf_form(tmp_path / "hybrid.pdf")
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        acro = pdf.Root.AcroForm
        acro.XFA = pdf.make_stream(b"<template><subform/></template>")
        pdf.save(src)

    _partial_output, partial_ctx = runner.run_with_context(
        "forms.flatten", {"names": ["hoten"]}, src
    )
    partial = runner.work / f"rev{runner.count - 1}.pdf"
    assert any("XFA form remains" in warning for warning in partial_ctx.warnings)
    with pikepdf.open(partial) as pdf:
        assert "/XFA" in pdf.Root.AcroForm
        assert "ten" in {
            field["name"] for field in runner.data("forms.list", {}, partial)["fields"]
        }

    complete = runner.step("forms.flatten", {}, partial)
    with pikepdf.open(complete) as pdf:
        assert "/AcroForm" not in pdf.Root


def test_fill_and_flatten_warns_when_xfa_remains(runner: Runner, tmp_path: Path) -> None:
    src = pikepdf_form(tmp_path / "hybrid-fill.pdf")
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        pdf.Root.AcroForm.XFA = pdf.make_stream(b"<template/>")
        pdf.save(src)
    src = runner.step(
        "forms.addField",
        {"kind": "signature", "pageIndex": 0, "rect": [20, 20, 180, 60], "name": "sign"},
        src,
    )

    _output, ctx = runner.run_with_context(
        "forms.fill", {"values": {"hoten": "Lan"}, "flatten": True}, src
    )
    assert any("XFA form remains" in warning for warning in ctx.warnings)


def test_flatten_xfa_only_document_does_not_remove_form_packet(
    runner: Runner, tmp_path: Path
) -> None:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(300, 300))
    pdf.Root.AcroForm = pdf.make_indirect(
        pikepdf.Dictionary(XFA=pdf.make_stream(b"<template><subform/></template>"))
    )
    src = tmp_path / "xfa-only.pdf"
    pdf.save(src)

    output = runner.step("forms.flatten", {}, src)
    with pikepdf.open(output) as result:
        assert "/AcroForm" in result.Root
        assert "/XFA" in result.Root.AcroForm


def test_flatten_reportlab_form(runner: Runner, tmp_path: Path) -> None:
    src = reportlab_form(tmp_path / "rl.pdf")
    filled = runner.step("forms.fill", {"values": {"hoten": VI}}, src)
    flat = runner.step("forms.flatten", {}, filled)
    assert runner.data("forms.list", {}, flat)["fields"] == []


def test_flatten_generates_missing_appearance_before_removing_field(
    runner: Runner, tmp_path: Path
) -> None:
    src = pikepdf_form(tmp_path / "deferred.pdf")
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        pdf.Root.AcroForm.NeedAppearances = True
        pdf.save(src)

    filled = runner.step("forms.fill", {"values": {"hoten": VI}}, src)
    # Simulate a PDF whose viewer was expected to draw values: remove the generated /AP too.
    with pikepdf.open(filled, allow_overwriting_input=True) as pdf:
        hoten = next(a for a in pdf.pages[0].obj.Annots if str(a.get("/T", "")) == "hoten")
        del hoten["/AP"]
        pdf.save(filled)
    flat = runner.step("forms.flatten", {}, filled)
    assert "hoten" not in _by_name(runner, flat)
    assert dark_pixels(render(flat), (20, 20, 180, 40)) > 30


def test_flatten_keeps_widget_without_supported_appearance(runner: Runner, tmp_path: Path) -> None:
    src = blank(tmp_path / "button.pdf")
    rev = _add(runner, src, kind="button", pageIndex=0, rect=[20, 20, 100, 40], name="submit")
    flat = runner.step("forms.flatten", {}, rev)
    assert "submit" in _by_name(runner, flat)
    assert runner.data("forms.list", {}, flat)["fields"][0]["widgets"][0]["hasAppearance"] is False


def test_flatten_warning_is_reported_by_each_operation(runner: Runner, tmp_path: Path) -> None:
    src = blank(tmp_path / "button.pdf")
    with_text = _add(runner, src, kind="text", pageIndex=0, rect=[110, 20, 200, 40], name="other")
    with_button = _add(
        runner, with_text, kind="button", pageIndex=0, rect=[20, 20, 100, 40], name="submit"
    )

    _output, ctx = runner.run_with_context("forms.flatten", {}, with_button)
    assert any("could not be flattened" in warning for warning in ctx.warnings)

    output, ctx = runner.run_with_context(
        "forms.fill", {"values": {"other": "value"}, "flatten": True}, with_button
    )
    assert output.changed_pages == [0]
    assert any("could not be flattened" in warning for warning in ctx.warnings)


def test_page_limited_flatten_does_not_refresh_other_radio_widgets(
    runner: Runner, tmp_path: Path
) -> None:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(300, 300))
    pdf.add_blank_page(page_size=(300, 300))
    src = tmp_path / "two-pages.pdf"
    pdf.save(src)
    rev = _add(
        runner,
        src,
        kind="radio",
        pageIndex=0,
        rect=[20, 20, 34, 34],
        name="choice",
        exportValue="a",
    )
    rev = _add(
        runner,
        rev,
        kind="radio",
        pageIndex=1,
        rect=[20, 20, 34, 34],
        name="choice",
        exportValue="b",
    )
    with pikepdf.open(rev, allow_overwriting_input=True) as pdf:
        for page in pdf.pages:
            for annot in page.obj.Annots:
                if "/Parent" in annot:
                    del annot["/AP"]
        pdf.Root.AcroForm.NeedAppearances = True
        pdf.save(rev)

    output, _ctx = runner.run_with_context("forms.flatten", {"pages": [0]}, rev)
    assert output.changed_pages == [0]
    with pikepdf.open(runner.work / f"rev{runner.count - 1}.pdf") as pdf:
        assert "/AP" not in pdf.pages[1].obj.Annots[0]
        assert pdf.Root.AcroForm.NeedAppearances is True


def test_flatten_preserves_existing_radio_appearance_when_sibling_is_missing(
    runner: Runner, tmp_path: Path
) -> None:
    src = blank(tmp_path / "radio.pdf")
    rev = _add(
        runner,
        src,
        kind="radio",
        pageIndex=0,
        rect=[20, 20, 34, 34],
        name="choice",
        exportValue="a",
    )
    rev = _add(
        runner,
        rev,
        kind="radio",
        pageIndex=0,
        rect=[50, 20, 64, 34],
        name="choice",
        exportValue="b",
    )
    custom_appearance = b"0 1 0 rg 1 1 12 12 re f"
    with pikepdf.open(rev, allow_overwriting_input=True) as pdf:
        widgets = [annot for annot in pdf.pages[0].obj.Annots if "/Parent" in annot]
        widgets[0]["/AP"]["/N"]["/Off"] = pdf.make_stream(custom_appearance)
        del widgets[1]["/AP"]
        pdf.save(rev)

    flat = runner.step("forms.flatten", {}, rev)
    with pikepdf.open(flat) as pdf:
        xobjects = pdf.pages[0].obj.Resources.XObject
        assert xobjects["/ChefFlat0"].read_bytes() == custom_appearance


def test_flatten_drops_javascript_and_xfa_hooks(runner: Runner, tmp_path: Path) -> None:
    src = pikepdf_form(tmp_path / "f.pdf")
    flat = runner.step("forms.flatten", {"removeJavascript": True}, src)
    assert runner.data("forms.list", {}, flat)["fields"] == []


def test_detect_proposes_fields_over_blank_lines(tmp_path: Path) -> None:
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300, 200))
    font = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica
        )
    )
    page.obj.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
    page.obj.Contents = pdf.make_stream(
        b"BT /F1 12 Tf 20 150 Td (Ho ten: ______________________) Tj ET\n"
        b"BT /F1 12 Tf 20 120 Td (Plain sentence without blanks.) Tj ET\n"
    )
    path = tmp_path / "blank.pdf"
    pdf.save(path)
    with pikepdf.open(path) as src:
        proposals = detect(FormDoc(src))
    assert len(proposals) == 1
    p = proposals[0]
    assert p["label"] == "Ho ten" and p["experimental"] is True
    assert 0 < p["confidence"] <= 0.95
    x0, top, x1, bottom = p["rect"]
    assert x0 < x1 and top < bottom and 0 <= top <= 200 and bottom <= 200
    with pikepdf.open(path) as src:
        assert build_text_page(src, src.pages[0], 0).lines


def test_detect_op_changes_nothing(runner: Runner, tmp_path: Path) -> None:
    path = blank(tmp_path / "b.pdf")
    result = runner.data("forms.detectFields", {}, path)
    assert result["proposals"] == [] and result["experimental"] is True
