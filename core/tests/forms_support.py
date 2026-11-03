"""Form fixtures (H1-H3): forms built with pikepdf and with reportlab, and a direct op runner.

Two conventions are covered on purpose: pikepdf forms carry hand-written appearance streams, and
reportlab's acroform module writes its own (different) widget dictionaries and radio groups.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pikepdf
import pydantic
from pikepdf import Array, Dictionary, Name
from PIL import Image, ImageChops
from pypdfium2 import PdfDocument

from chef_core.errors import ChefError, from_validation_error
from chef_core.ops import load_builtin_ops
from chef_core.ops.base import OpContext, OpOutput, get_op

load_builtin_ops()

PAGE_W = 300
PAGE_H = 300


def _stream(pdf: pikepdf.Pdf, body: str, w: float, h: float) -> pikepdf.Object:
    s = pdf.make_stream(body.encode("ascii"))
    s.Type = Name.XObject
    s.Subtype = Name.Form
    s.BBox = Array([0, 0, w, h])
    return s


def pikepdf_form(path: Path, *, rotate: int = 0) -> Path:
    """One page with text, hierarchical, comb, check box, radio, combo, list and JS fields."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page.obj.Rotate = rotate
    font = pdf.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica)
    )
    dr = Dictionary(Font=Dictionary(Helv=font))
    acro = pdf.make_indirect(Dictionary(Fields=Array(), DR=dr, DA=pikepdf.String("/Helv 0 Tf 0 g")))
    pdf.Root.AcroForm = acro
    annots = Array()

    def widget(**kw: Any) -> pikepdf.Object:
        obj = pdf.make_indirect(
            Dictionary(Type=Name.Annot, Subtype=Name.Widget, F=4, P=page.obj, **kw)
        )
        annots.append(obj)
        return obj

    def rect(x: float, y: float, w: float, h: float) -> Array:
        return Array([x, y, x + w, y + h])

    da = pikepdf.String("/Helv 12 Tf 0 g")
    hoten = widget(
        FT=Name.Tx, T=pikepdf.String("hoten"), DA=da, Rect=rect(20, 260, 160, 20),
        MK=Dictionary(BC=Array([0, 0, 0])), BS=Dictionary(W=1, S=Name.S),
        TU=pikepdf.String("Họ và tên"),
    )  # fmt: skip
    ten = widget(FT=Name.Tx, T=pikepdf.String("ten"), DA=da, Rect=rect(20, 230, 160, 20), MaxLen=40)
    cmnd = widget(
        FT=Name.Tx, T=pikepdf.String("cmnd"), DA=da, Rect=rect(20, 200, 180, 20),
        Ff=1 << 24, MaxLen=9,
    )  # fmt: skip
    ghichu = widget(
        FT=Name.Tx, T=pikepdf.String("ghichu"), DA=da, Rect=rect(20, 150, 200, 40), Ff=1 << 12
    )  # fmt: skip
    on_state = _stream(pdf, "0 0 1 rg 2 2 10 10 re f", 14, 14)
    off_state = _stream(pdf, "", 14, 14)
    dongy = widget(
        FT=Name.Btn, T=pikepdf.String("dongy"), Rect=rect(20, 120, 14, 14), V=Name.Yes,
        AS=Name.Yes, AP=Dictionary(N=Dictionary(Yes=on_state, Off=off_state)),
    )  # fmt: skip
    nam_on = _stream(pdf, "0 0 1 rg 2 2 10 10 re f", 14, 14)
    nu_on = _stream(pdf, "0 0 1 rg 2 2 10 10 re f", 14, 14)
    gioitinh = pdf.make_indirect(
        Dictionary(
            FT=Name.Btn, T=pikepdf.String("gioitinh"), Ff=(1 << 15) | (1 << 14),
            V=Name.Off, Kids=Array(),
        )
    )  # fmt: skip
    for x, state, on in ((20, "nam", nam_on), (60, "nu", nu_on)):
        kid = pdf.make_indirect(
            Dictionary(
                Type=Name.Annot, Subtype=Name.Widget, F=4, P=page.obj, Parent=gioitinh,
                Rect=rect(x, 90, 14, 14), AS=Name.Off,
                AP=Dictionary(N=Dictionary({f"/{state}": on, "/Off": off_state})),
            )
        )  # fmt: skip
        gioitinh.Kids.append(kid)
        annots.append(kid)
    tinh = widget(
        FT=Name.Ch, T=pikepdf.String("tinh"), DA=da, Rect=rect(20, 60, 120, 20), Ff=1 << 17,
        Opt=Array([Array([pikepdf.String("HN"), pikepdf.String("Ha Noi")]), pikepdf.String("HCM")]),
    )  # fmt: skip
    ngonngu = widget(
        FT=Name.Ch, T=pikepdf.String("ngonngu"), DA=da, Rect=rect(160, 60, 120, 60), Ff=1 << 21,
        Opt=Array([pikepdf.String("Vi"), pikepdf.String("En"), pikepdf.String("Fr")]),
    )  # fmt: skip
    ma = widget(
        FT=Name.Tx,
        T=pikepdf.String("ma"),
        DA=da,
        Rect=rect(20, 30, 120, 20),
        V=pikepdf.String("MA-01"),
        Ff=1,
    )
    tong = widget(
        FT=Name.Tx, T=pikepdf.String("tong"), DA=da, Rect=rect(160, 30, 120, 20),
        AA=Dictionary(C=Dictionary(S=Name.JavaScript, JS=pikepdf.String("event.value = 1;"))),
    )  # fmt: skip
    acro.Fields = Array([hoten, ten, cmnd, ghichu, dongy, gioitinh, tinh, ngonngu, ma, tong])
    # hierarchical: nguoithue.hoten (a parent with the field as a child, no widgets of its own)
    ng = pdf.make_indirect(Dictionary(T=pikepdf.String("nguoithue"), Kids=Array()))
    ng_child = pdf.make_indirect(
        Dictionary(
            FT=Name.Tx, T=pikepdf.String("hoten"), DA=da, Rect=rect(20, 170, 160, 20),
            Type=Name.Annot, Subtype=Name.Widget, F=4, P=page.obj, Parent=ng,
        )
    )  # fmt: skip
    ng.Kids = Array([ng_child])
    annots.append(ng_child)
    acro.Fields.append(ng)
    page.obj.Annots = annots
    pdf.save(path)
    return path


def reportlab_form(path: Path) -> Path:
    """A form written by reportlab's acroform module (its own appearance conventions)."""
    from reportlab.pdfgen import canvas

    c = canvas.Canvas(str(path), pagesize=(PAGE_W, PAGE_H))
    c.acroForm.textfield(
        name="hoten", x=20, y=250, width=160, height=20, value="Nguyen Van A", borderStyle="inset"
    )
    c.acroForm.checkbox(name="dongy", x=20, y=210, size=14, checked=True, buttonStyle="check")
    c.acroForm.radio(name="gioi", value="nam", x=20, y=180, size=14, selected=True)
    c.acroForm.radio(name="gioi", value="nu", x=60, y=180, size=14)
    c.acroForm.choice(
        name="tinh",
        value="HN",
        x=20,
        y=140,
        width=120,
        height=20,
        options=[("Ha Noi", "HN"), ("TPHCM", "HCM")],
    )  # fmt: skip
    c.showPage()
    c.save()
    return path


def blank(path: Path, *, rotate: int = 0) -> Path:
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(PAGE_W, PAGE_H))
    page.obj.Rotate = rotate
    pdf.save(path)
    return path


def render(path: Path, index: int = 0, scale: float = 1.0) -> Image.Image:
    """Render a page the way a viewer shows widgets: PDFium draws them only with forms set up."""
    doc = PdfDocument(str(path))
    try:
        doc.init_forms()
        page = doc[index]
        return (
            page.render(scale=scale, draw_annots=True, may_draw_forms=True).to_pil().convert("RGB")
        )
    finally:
        doc.close()


def dark_pixels(img: Image.Image, box: tuple[int, int, int, int]) -> int:
    """Pixels darker than mid gray inside a box (left, top, right, bottom) in pixels."""
    histogram = img.crop(box).convert("L").histogram()
    return sum(histogram[:128])


def diff_count(a: Image.Image, b: Image.Image, tol: int = 40) -> int:
    """Pixels whose colour differs by more than ``tol`` on any channel."""
    delta = ImageChops.difference(a.convert("RGB"), b.convert("RGB")).convert("L")
    return sum(delta.histogram()[tol + 1 :])


class Runner:
    """Runs registered ops directly on files (no session): each call writes a new file."""

    def __init__(self, work: Path) -> None:
        self.work = work
        self.count = 0

    def run(self, op_id: str, params: dict[str, Any], src: Path) -> OpOutput:
        output, _ctx = self.run_with_context(op_id, params, src)
        return output

    def run_with_context(
        self, op_id: str, params: dict[str, Any], src: Path
    ) -> tuple[OpOutput, OpContext]:
        spec = get_op(op_id)
        assert spec is not None, op_id
        try:
            model = spec.params_model.model_validate(params)
        except pydantic.ValidationError as exc:
            raise from_validation_error(exc) from exc
        dst = self.work / f"rev{self.count}.pdf"
        self.count += 1
        ctx = OpContext(
            job_id=f"t{self.count}",
            work_dir=self.work,
            input_path=src,
            result_path=dst,
        )
        return spec.run(ctx, model), ctx

    def step(self, op_id: str, params: dict[str, Any], src: Path) -> Path:
        """Run a destructive op and return the file it wrote (``src`` when nothing changed)."""
        dst = self.work / f"rev{self.count}.pdf"
        self.run(op_id, params, src)
        return dst if dst.exists() else src

    def data(self, op_id: str, params: dict[str, Any], src: Path) -> dict[str, Any]:
        result = self.run(op_id, params, src).data
        assert isinstance(result, dict)
        return result


def expect_error(fn: Any, kind: str | None = None) -> ChefError:
    try:
        fn()
    except ChefError as exc:
        if kind is not None:
            assert exc.kind == kind, exc
        return exc
    raise AssertionError("expected a ChefError")
