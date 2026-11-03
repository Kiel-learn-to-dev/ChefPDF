"""H1: listing, filling and data files for AcroForms (pikepdf and reportlab conventions).

Ops run directly on files through ``forms_support.Runner``. Rendering uses PDFium, so a filled
widget must show ink inside its rectangle, not only carry a /V value.
"""

from __future__ import annotations

import unicodedata
from pathlib import Path

import pikepdf
import pytest
from forms_support import (
    Runner,
    dark_pixels,
    expect_error,
    pikepdf_form,
    render,
    reportlab_form,
)

from chef_core.errors import ChefError

VI = "Nguyễn Thị Hà ệ ơ ư"


@pytest.fixture
def runner(tmp_path: Path) -> Runner:
    return Runner(tmp_path)


def _fields(runner: Runner, src: Path) -> dict[str, dict]:
    result = runner.data("forms.list", {}, src)
    return {f["name"]: f for f in result["fields"]}


def test_listing_reports_types_names_geometry_and_flags(runner: Runner, tmp_path: Path) -> None:
    src = pikepdf_form(tmp_path / "f.pdf")
    listing = runner.data("forms.list", {}, src)
    fields = {f["name"]: f for f in listing["fields"]}
    assert set(fields) == {
        "hoten",
        "ten",
        "cmnd",
        "ghichu",
        "dongy",
        "gioitinh",
        "tinh",
        "ngonngu",
        "ma",
        "tong",
        "nguoithue.hoten",
    }
    assert fields["hoten"]["type"] == "text"
    assert fields["hoten"]["tooltip"] == "Họ và tên"
    assert fields["cmnd"]["type"] == "comb" and fields["cmnd"]["flags"]["maxLen"] == 9
    assert fields["ghichu"]["type"] == "multiline"
    assert fields["dongy"]["type"] == "checkbox"
    assert fields["gioitinh"]["type"] == "radio"
    assert [o["export"] for o in fields["gioitinh"]["options"]] == ["nam", "nu"]
    assert fields["tinh"]["type"] == "dropdown"
    assert fields["tinh"]["options"] == [
        {"export": "HN", "display": "Ha Noi"},
        {"export": "HCM", "display": "HCM"},
    ]
    assert fields["ngonngu"]["type"] == "listbox"
    assert fields["ngonngu"]["flags"]["multiSelect"] is True
    assert fields["ma"]["flags"]["readOnly"] is True and fields["ma"]["value"] == "MA-01"
    assert fields["tong"]["javascript"] == ["calculate"]
    assert fields["nguoithue.hoten"]["partialName"] == "hoten"
    # widget rectangles are reported top-left: [x0, top, x1, bottom] on a 300 pt page
    assert fields["hoten"]["widgets"][0]["rect"] == [20.0, 20.0, 180.0, 40.0]
    assert fields["hoten"]["page"] == 0
    assert listing["xfa"] is False and listing["needAppearances"] is False


def test_listing_of_reportlab_form(runner: Runner, tmp_path: Path) -> None:
    src = reportlab_form(tmp_path / "rl.pdf")
    listing = runner.data("forms.list", {}, src)
    fields = {f["name"]: f for f in listing["fields"]}
    assert fields["hoten"]["type"] == "text"
    assert fields["hoten"]["value"] == "Nguyen Van A"
    assert fields["dongy"]["type"] == "checkbox"
    assert fields["dongy"]["value"] is True
    assert fields["gioi"]["type"] == "radio"
    assert fields["gioi"]["value"] == "nam"
    assert [o["export"] for o in fields["gioi"]["options"]] == ["nam", "nu"]
    assert fields["tinh"]["type"] == "dropdown"
    assert fields["tinh"]["value"] == "HN"
    assert fields["tinh"]["options"][0] == {"export": "HN", "display": "Ha Noi"}


def test_fill_vietnamese_text_checkbox_radio_choices_and_read_back(
    runner: Runner, tmp_path: Path
) -> None:
    src = pikepdf_form(tmp_path / "f.pdf")
    values = {
        "hoten": VI,
        "dongy": True,
        "gioitinh": "nu",
        "tinh": "HCM",
        "ngonngu": ["Vi", "En"],
        "cmnd": "123456789",
        "ghichu": "Dòng 1\nDòng 2 có dấu: ệ ơ ư",
        "nguoithue.hoten": "Trần",
    }
    out = runner.step("forms.fill", {"values": values}, src)
    assert out != src
    got = runner.data("forms.getValues", {}, out)["values"]
    assert got["hoten"] == VI
    assert got["dongy"] is True
    assert got["gioitinh"] == "nu"
    assert got["tinh"] == "HCM"
    assert got["ngonngu"] == ["Vi", "En"]
    assert got["cmnd"] == "123456789"
    assert got["ghichu"] == values["ghichu"]
    assert got["nguoithue.hoten"] == "Trần"
    assert unicodedata.normalize("NFC", got["hoten"]) == unicodedata.normalize("NFC", VI)


def test_filled_widgets_show_ink_inside_their_rectangles(runner: Runner, tmp_path: Path) -> None:
    src = pikepdf_form(tmp_path / "f.pdf")
    out = runner.step("forms.fill", {"values": {"hoten": "Nguyễn Văn A", "dongy": True}}, src)
    img = render(out)
    # widget hoten: displayed [20, 20, 180, 40]; the text must leave ink inside it
    assert dark_pixels(img, (20, 20, 180, 40)) > 30
    # the empty widget "ten" (top 300-250=50, bottom 70) stays blank apart from its border
    assert dark_pixels(img, (22, 52, 178, 68)) < 5
    # the check box (display top 166, bottom 180) has its mark
    assert dark_pixels(img, (20, 166, 34, 180)) > 20


def test_fill_rejects_bad_values_and_writes_nothing(runner: Runner, tmp_path: Path) -> None:
    src = pikepdf_form(tmp_path / "f.pdf")
    dst = tmp_path / "rev0.pdf"
    before = dst.exists()

    expect_error(
        lambda: runner.run("forms.fill", {"values": {"hoten": "x", "tinh": "BAD"}}, src),
        "INVALID_PARAMS",
    )
    assert not dst.exists() and not before
    expect_error(
        lambda: runner.run("forms.fill", {"values": {"cmnd": "1234567890"}}, src), "INVALID_PARAMS"
    )
    expect_error(lambda: runner.run("forms.fill", {"values": {"ma": "NEW"}}, src), "INVALID_PARAMS")
    expect_error(lambda: runner.run("forms.fill", {"values": {"nope": "x"}}, src), "INVALID_PARAMS")
    expect_error(
        lambda: runner.run("forms.fill", {"values": {"gioitinh": "khac"}}, src), "INVALID_PARAMS"
    )
    expect_error(
        lambda: runner.run("forms.fill", {"values": {"dongy": "maybe"}}, src), "INVALID_PARAMS"
    )
    expect_error(
        lambda: runner.run("forms.fill", {"values": {"hoten": True}}, src), "INVALID_PARAMS"
    )
    expect_error(
        lambda: runner.run("forms.fill", {"values": {"ngonngu": ["Vi", "XX"]}}, src),
        "INVALID_PARAMS",
    )  # fmt: skip


def test_read_only_needs_force(runner: Runner, tmp_path: Path) -> None:
    src = pikepdf_form(tmp_path / "f.pdf")
    out = runner.step("forms.fill", {"values": {"ma": "MA-02"}, "force": True}, src)
    assert runner.data("forms.getValues", {}, out)["values"]["ma"] == "MA-02"


def test_fill_reports_changed_pages(runner: Runner, tmp_path: Path) -> None:
    src = pikepdf_form(tmp_path / "f.pdf")
    result = runner.run("forms.fill", {"values": {"hoten": "A"}}, src)
    assert result.changed_pages == [0]
    assert result.data == {"applied": ["hoten"], "flattened": False}


def test_fill_reportlab_form(runner: Runner, tmp_path: Path) -> None:
    src = reportlab_form(tmp_path / "rl.pdf")
    out = runner.step(
        "forms.fill", {"values": {"hoten": VI, "gioi": "nu", "dongy": False, "tinh": "HCM"}}, src
    )
    got = runner.data("forms.getValues", {}, out)["values"]
    assert got["hoten"] == VI
    assert got["gioi"] == "nu"
    assert got["dongy"] is False
    assert got["tinh"] == "HCM"
    img = render(out)
    assert dark_pixels(img, (20, 30, 180, 50)) > 30  # hoten sits at y=250, height 20


def test_export_and_import_round_trip_in_every_format(runner: Runner, tmp_path: Path) -> None:
    filled = runner.step(
        "forms.fill",
        {"values": {"hoten": VI, "dongy": True, "gioitinh": "nam", "tinh": "HN"}},
        pikepdf_form(tmp_path / "a.pdf"),
    )
    expected = runner.data("forms.getValues", {}, filled)["values"]
    for fmt in ("json", "fdf", "xfdf"):
        path = tmp_path / f"data.{fmt}"
        runner.run("forms.exportData", {"format": fmt, "path": str(path)}, filled)
        text = path.read_bytes()
        assert text.isascii(), fmt  # safe to return through JSON-RPC
        blank_form = pikepdf_form(tmp_path / f"blank_{fmt}.pdf")
        out = runner.step("forms.importData", {"path": str(path)}, blank_form)
        got = runner.data("forms.getValues", {}, out)["values"]
        for key in ("hoten", "dongy", "gioitinh", "tinh"):
            assert got[key] == expected[key], (fmt, key)


def test_export_without_path_returns_content(runner: Runner, tmp_path: Path) -> None:
    src = pikepdf_form(tmp_path / "f.pdf")
    result = runner.data("forms.exportData", {"format": "json"}, src)
    assert '"hoten"' in result["content"]
    fdf = runner.data("forms.exportData", {"format": "fdf"}, src)["content"]
    assert fdf.startswith("%FDF-1.2")
    csv_text = runner.data("forms.exportData", {"format": "csv"}, src)["content"]
    assert csv_text.splitlines()[0].startswith("hoten,")


def test_import_reports_unknown_fields_and_rejects_bad_files(
    runner: Runner, tmp_path: Path
) -> None:
    src = pikepdf_form(tmp_path / "f.pdf")
    json_path = tmp_path / "in.json"
    json_path.write_text('{"hoten": "Lan", "khong_co": "x"}', encoding="utf-8")
    out = runner.step("forms.importData", {"path": str(json_path)}, src)
    assert runner.data("forms.getValues", {}, out)["values"]["hoten"] == "Lan"
    result = runner.data("forms.importData", {"path": str(json_path)}, src)
    assert result["unknown"] == ["khong_co"]

    xfdf = tmp_path / "evil.xfdf"
    xfdf.write_text('<!DOCTYPE x [<!ENTITY a "b">]><xfdf><fields/></xfdf>', encoding="utf-8")
    expect_error(lambda: runner.run("forms.importData", {"path": str(xfdf)}, src), "INVALID_PARAMS")
    notfdf = tmp_path / "x.fdf"
    notfdf.write_text("hello", encoding="ascii")
    expect_error(
        lambda: runner.run("forms.importData", {"path": str(notfdf), "format": "fdf"}, src),
        "INVALID_PARAMS",
    )
    with pytest.raises(ChefError):
        runner.run("forms.importData", {"path": str(tmp_path / "missing.json")}, src)


def test_fdf_with_unicode_values_is_hex_utf16(runner: Runner, tmp_path: Path) -> None:
    src = pikepdf_form(tmp_path / "f.pdf")
    out = runner.step("forms.fill", {"values": {"hoten": VI}}, src)
    path = tmp_path / "v.fdf"
    runner.run("forms.exportData", {"format": "fdf", "path": str(path)}, out)
    assert b"<FEFF" in path.read_bytes()
    assert runner.data("forms.getValues", {}, out)["values"]["hoten"] == VI


def test_reset_clears_values(runner: Runner, tmp_path: Path) -> None:
    src = pikepdf_form(tmp_path / "f.pdf")
    filled = runner.step("forms.fill", {"values": {"hoten": "A", "dongy": True}}, src)
    cleared = runner.step("forms.reset", {"names": ["hoten", "dongy"]}, filled)
    got = runner.data("forms.getValues", {}, cleared)["values"]
    assert got["hoten"] in (None, "")
    assert got["dongy"] is False


def test_reset_restores_choice_field_default_value(runner: Runner, tmp_path: Path) -> None:
    src = pikepdf_form(tmp_path / "f.pdf")
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        dropdown = next(
            field for field in pdf.Root.AcroForm.Fields if str(field.get("/T", "")) == "tinh"
        )
        dropdown["/DV"] = pikepdf.String("HN")
        pdf.save(src)

    filled = runner.step("forms.fill", {"values": {"tinh": "HCM"}}, src)
    reset = runner.step("forms.reset", {"names": ["tinh"]}, filled)
    assert runner.data("forms.getValues", {}, reset)["values"]["tinh"] == "HN"


def test_reset_restores_button_and_multiselect_defaults(runner: Runner, tmp_path: Path) -> None:
    src = pikepdf_form(tmp_path / "defaults.pdf")
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        fields = {str(field.get("/T", "")): field for field in pdf.Root.AcroForm.Fields}
        fields["dongy"]["/DV"] = pikepdf.Name.Yes
        fields["gioitinh"]["/DV"] = pikepdf.Name("/nu")
        fields["ngonngu"]["/DV"] = pikepdf.Array([pikepdf.String("Vi"), pikepdf.String("Fr")])
        pdf.save(src)
    filled = runner.step(
        "forms.fill", {"values": {"dongy": False, "gioitinh": "nam", "ngonngu": ["En"]}}, src
    )
    reset = runner.step("forms.reset", {"names": ["dongy", "gioitinh", "ngonngu"]}, filled)
    values = runner.data("forms.getValues", {}, reset)["values"]
    assert values["dongy"] is True
    assert values["gioitinh"] == "nu"
    assert values["ngonngu"] == ["Vi", "Fr"]


def test_fill_is_destructive_and_listing_is_not() -> None:
    from chef_core.ops.base import get_op

    assert get_op("forms.fill").destructive is True  # type: ignore[union-attr]
    assert get_op("forms.list").destructive is False  # type: ignore[union-attr]
    assert get_op("forms.getValues").destructive is False  # type: ignore[union-attr]
    assert get_op("forms.exportData").destructive is False  # type: ignore[union-attr]


def test_document_without_form_lists_nothing(runner: Runner, tmp_path: Path) -> None:
    path = tmp_path / "plain.pdf"
    pdf = pikepdf.new()
    pdf.add_blank_page()
    pdf.save(path)
    listing = runner.data("forms.list", {}, path)
    assert listing["fields"] == [] and listing["hasForm"] is False
