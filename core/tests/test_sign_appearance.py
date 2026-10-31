"""T3.09: signature appearance renderer (features I15-I18).

The renderer draws the box with reportlab and the tests read the result back the way a user
would see it: text extraction with PDFium (real glyphs, not folded ASCII), page renders for
the box, border and text placement, and the signed document itself (pyHanko validation).
Pixel checks use wide tolerances so they hold on any machine.
"""

from __future__ import annotations

import datetime as dt
import unicodedata
from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
import pytest
from conftest import Harness, RpcFailure, make_numbered_pdf
from PIL import Image, ImageDraw
from pydantic import ValidationError
from signing_support import PASSWORD_A, PASSWORD_B, validate_pdf_signatures

from chef_core.signing.appearance import (
    SignatureData,
    SignatureTemplate,
    TemplateAppearance,
    TemplateLine,
    format_date,
    render_signature_appearance,
)
from chef_core.signing.fonts import BUNDLED_FONT_FAMILIES, font_path
from chef_core.signing.pades import AppearanceInfo

NAME_VN = unicodedata.normalize("NFC", "Nguyễn Văn Ạ")
HEADER_VN = unicodedata.normalize("NFC", "Đã ký")
REASON_VN = unicodedata.normalize("NFC", "Phê duyệt hợp đồng")
SIGNED_AT = dt.datetime(2026, 10, 31, 10, 0, 5, tzinfo=dt.timezone(dt.timedelta(hours=7)))


def _data(**overrides: Any) -> SignatureData:
    values: dict[str, Any] = {
        "signer_name": NAME_VN,
        "organization": "Công ty TNHH Thử Nghiệm",
        "tax_code": "0101234567",
        "citizen_id": "001234567890",
        "reason": REASON_VN,
        "location": "Hà Nội",
        "contact": "0912 345 678",
        "signed_at": SIGNED_AT,
    }
    values.update(overrides)
    return SignatureData(**values)


def _render(
    template: SignatureTemplate, width: float, height: float, data: SignatureData | None = None
) -> bytes:
    return render_signature_appearance(template, data or _data(), width, height).pdf


def _page_image(pdf_bytes: bytes, scale: float = 3.0) -> Image.Image:
    pdf = pdfium.PdfDocument(pdf_bytes)
    pdf.init_forms()  # PDFium draws signature widgets only with a form environment
    try:
        bitmap = pdf[0].render(scale=scale, draw_annots=True)
        image: Image.Image = bitmap.to_pil().convert("RGB")
        return image
    finally:
        pdf.close()


def _text(pdf_bytes: bytes) -> str:
    pdf = pdfium.PdfDocument(pdf_bytes)
    try:
        return str(pdf[0].get_textpage().get_text_range())
    finally:
        pdf.close()


def _ink_bbox(img: Image.Image, *, skip: int = 0) -> tuple[int, int, int, int] | None:
    """Bounding box (pixels) of everything that is not white. ``skip`` ignores a frame."""
    w, h = img.size
    xs: list[int] = []
    ys: list[int] = []
    px = img.load()
    assert px is not None
    for y in range(skip, h - skip):
        for x in range(skip, w - skip):
            r, g, b = px[x, y]
            if min(r, g, b) < 235:
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    return min(xs), min(ys), max(xs), max(ys)


def _count_color(img: Image.Image, rgb: tuple[int, int, int], tol: int = 40) -> int:
    px = img.load()
    assert px is not None
    w, h = img.size
    return sum(
        1
        for y in range(h)
        for x in range(w)
        if all(abs(px[x, y][i] - rgb[i]) <= tol for i in range(3))
    )


def _png(path: Path, *, mode: str = "RGBA", color: tuple[int, ...] = (20, 60, 180, 255)) -> Path:
    img = Image.new(mode, (120, 60), (0, 0, 0, 0) if mode == "RGBA" else (255, 255, 255))
    draw = ImageDraw.Draw(img)
    draw.ellipse((10, 10, 110, 50), outline=color, width=6)
    img.save(path)
    return path


# -- resources --------------------------------------------------------------------------


def test_bundled_fonts_and_licence_ship_with_the_package() -> None:
    assert "BeVietnamPro" in BUNDLED_FONT_FAMILIES
    assert font_path("BeVietnamPro", bold=False).is_file()
    assert font_path("BeVietnamPro", bold=True).is_file()
    assert font_path("BeVietnamPro", bold=False).parent.joinpath("OFL.txt").is_file()


# -- layouts and sizes ------------------------------------------------------------------


@pytest.mark.parametrize("layout", ["text-only", "image-left", "image-right", "image-background"])
@pytest.mark.parametrize("size", [(240, 90), (300, 60), (120, 130)])
def test_every_layout_renders_one_page_of_the_requested_size(
    layout: str, size: tuple[int, int], tmp_path: Path
) -> None:
    image = _png(tmp_path / "sig.png")
    template = SignatureTemplate(layout=layout, image={"path": str(image)})  # type: ignore[arg-type]
    width, height = size
    rendered = render_signature_appearance(
        template, _data(), width, height, image=image.read_bytes()
    )
    pdf = pdfium.PdfDocument(rendered.pdf)
    try:
        assert len(pdf) == 1
        page_w, page_h = pdf[0].get_size()
        assert round(page_w) == width and round(page_h) == height
    finally:
        pdf.close()


# -- Vietnamese text ---------------------------------------------------------------------


def test_vietnamese_text_is_real_text_not_folded_ascii() -> None:
    template = SignatureTemplate(
        header="Đã ký",
        lines=[
            TemplateLine(source="signerName", label="Ký bởi:"),
            TemplateLine(source="reason", label="Lý do:"),
        ],
    )
    text = unicodedata.normalize("NFC", _text(_render(template, 240, 90)))
    assert NAME_VN in text
    assert HEADER_VN in text
    assert REASON_VN in text
    assert "Nguyen Van" not in text


# -- box, border, background, check mark ------------------------------------------------


def test_box_is_not_blank_and_the_border_is_drawn() -> None:
    template = SignatureTemplate(border={"color": "#FF0000", "width": 2})  # type: ignore[arg-type]
    img = _page_image(_render(template, 240, 90))
    assert _ink_bbox(img) is not None
    # The border is red: a column of red pixels on the left edge.
    assert _count_color(img, (255, 0, 0)) > 3 * 90


def test_no_border_and_transparent_background_leave_the_edges_blank() -> None:
    template = SignatureTemplate(border=None)
    img = _page_image(_render(template, 240, 90))
    assert _count_color(img, (255, 0, 0)) == 0
    assert _ink_bbox(img, skip=6) is not None  # text is still there, away from the edges


def test_opaque_background_fills_the_box() -> None:
    template = SignatureTemplate(
        border=None,
        background={"color": "#00FF00", "opacity": 1.0},  # type: ignore[arg-type]
        lines=[],
        header=None,
    )
    img = _page_image(_render(template, 200, 80))
    assert _count_color(img, (0, 255, 0), tol=10) > 0.9 * 200 * 80 * 9  # scale 3 pixels


def test_check_mark_is_drawn_as_vector_when_enabled() -> None:
    plain = _page_image(_render(SignatureTemplate(), 240, 90))
    marked = _page_image(_render(SignatureTemplate(checkmark=True), 240, 90))
    green = (30, 142, 62)
    assert _count_color(plain, green) == 0
    assert _count_color(marked, green, tol=30) > 50


# -- auto-shrink -------------------------------------------------------------------------

LONG_REASON = (
    "Phê duyệt toàn bộ nội dung hợp đồng khung số 12/2026 giữa các bên, "
    "kèm phụ lục kỹ thuật và biên bản nghiệm thu từng giai đoạn của dự án"
)


def test_auto_shrink_fits_long_text_in_the_box() -> None:
    template = SignatureTemplate(
        border=None,
        font_size=12,
        min_font_size=4,
        lines=[
            TemplateLine(source="signerName", label="Ký bởi:"),
            TemplateLine(source="custom", text=LONG_REASON),
        ],
        header="Đã ký",
    )
    rendered = render_signature_appearance(template, _data(), 150, 60)
    assert rendered.font_size < 12
    assert rendered.truncated is False
    img = _page_image(rendered.pdf, scale=4)
    bbox = _ink_bbox(img)
    assert bbox is not None
    width_px, height_px = img.size
    # Every glyph stays inside the padded box: nothing reaches the outer 2 pt.
    margin = 2 * 4
    x0, y0, x1, y1 = bbox
    assert x0 >= margin and y0 >= margin
    assert x1 <= width_px - margin and y1 <= height_px - margin


def test_without_auto_shrink_overflow_is_dropped_and_reported() -> None:
    template = SignatureTemplate(
        border=None,
        font_size=10,
        auto_shrink=False,
        lines=[TemplateLine(source="custom", text=LONG_REASON)] * 6,
        header=None,
    )
    rendered = render_signature_appearance(template, _data(), 150, 60)
    assert rendered.font_size == 10
    assert rendered.truncated is True
    img = _page_image(rendered.pdf, scale=4)
    bbox = _ink_bbox(img)
    assert bbox is not None and bbox[3] <= img.size[1] - 8


def test_min_font_size_is_a_floor() -> None:
    template = SignatureTemplate(
        font_size=12, min_font_size=9, lines=[TemplateLine(source="custom", text=LONG_REASON)]
    )
    rendered = render_signature_appearance(template, _data(), 120, 40)
    assert rendered.font_size == pytest.approx(9)


# -- lines, labels, overrides, dates ------------------------------------------------------


def test_line_override_text_and_per_line_font_size_are_used() -> None:
    template = SignatureTemplate(
        header=None,
        lines=[
            TemplateLine(source="location", label="Nơi ký:", font_size=7),
            TemplateLine(source="signerName", text="Người được ủy quyền"),
            TemplateLine(source="contact", enabled=False),
        ],
    )
    text = unicodedata.normalize("NFC", _text(_render(template, 240, 90)))
    assert "Nơi ký: Hà Nội" in text
    assert "Người được ủy quyền" in text
    assert NAME_VN not in text  # the override replaces the certificate name
    assert "0912" not in text  # disabled line


def test_lines_without_value_are_skipped() -> None:
    template = SignatureTemplate(
        header=None,
        lines=[TemplateLine(source="citizenId", label="CCCD:"), TemplateLine(source="signerName")],
    )
    text = _text(_render(template, 240, 90, _data(citizen_id=None)))
    assert "CCCD" not in text
    assert NAME_VN in unicodedata.normalize("NFC", text)


def test_date_format_tokens_and_timezone() -> None:
    assert format_date(SIGNED_AT, "dd/MM/yyyy HH:mm:ss") == "31/10/2026 10:00:05"
    assert (
        format_date(SIGNED_AT, "dd/MM/yyyy HH:mm:ss", show_timezone=True)
        == "31/10/2026 10:00:05 (UTC+07:00)"
    )
    assert format_date(SIGNED_AT, "'Ngày' d 'tháng' M 'năm' yyyy") == "Ngày 31 tháng 10 năm 2026"


def test_date_line_uses_the_template_format() -> None:
    template = SignatureTemplate(
        header=None,
        lines=[TemplateLine(source="date", label="Ngày ký:")],
        date_format="dd/MM/yyyy",
    )
    assert "Ngày ký: 31/10/2026" in _text(_render(template, 240, 90))


# -- images --------------------------------------------------------------------------------


@pytest.mark.parametrize("layout", ["image-left", "image-right", "image-background"])
def test_transparent_png_is_embedded_with_a_soft_mask(layout: str, tmp_path: Path) -> None:
    image = _png(tmp_path / "alpha.png")
    template = SignatureTemplate(layout=layout, image={"path": str(image)})  # type: ignore[arg-type]
    rendered = render_signature_appearance(template, _data(), 240, 90, image=image.read_bytes())
    with pikepdf.open(_as_file(tmp_path, rendered.pdf)) as pdf:
        masks = [
            obj
            for obj in pdf.objects
            if isinstance(obj, pikepdf.Stream)
            and obj.get("/Subtype") == "/Image"
            and "/SMask" in obj
        ]
    assert masks, "the transparent PNG must be drawn with an SMask"


def test_image_fit_modes_and_opacity_render(tmp_path: Path) -> None:
    image = _png(tmp_path / "fit.png", mode="RGB", color=(200, 0, 0))
    for fit in ("contain", "cover", "stretch"):
        template = SignatureTemplate(
            layout="image-left",
            image={"path": str(image), "fit": fit, "opacity": 0.5},  # type: ignore[arg-type]
        )
        rendered = render_signature_appearance(template, _data(), 240, 90, image=image.read_bytes())
        assert _ink_bbox(_page_image(rendered.pdf)) is not None


def test_logo_is_drawn_in_the_box(tmp_path: Path) -> None:
    logo = _png(tmp_path / "logo.png", color=(0, 0, 0, 255))
    template = SignatureTemplate(logo={"path": str(logo)}, border=None)  # type: ignore[arg-type]
    with_logo = render_signature_appearance(template, _data(), 240, 90, logo=logo.read_bytes())
    without = _render(SignatureTemplate(border=None), 240, 90)
    assert _ink_bbox(_page_image(with_logo.pdf)) != _ink_bbox(_page_image(without))


# -- template validation (the UI builds templates from this shape) ------------------------


def test_template_wire_shape_is_camel_case() -> None:
    schema = SignatureTemplate.model_json_schema(by_alias=True)
    props = schema["properties"]
    for key in ("layout", "header", "lines", "dateFormat", "autoShrink", "minFontSize"):
        assert key in props, key
    assert "fontName" in props and "textColor" in props and "imageRatio" in props


@pytest.mark.parametrize(
    "kwargs",
    [
        {"layout": "text-over-nothing"},
        {"font_size": 4, "min_font_size": 6},
        {"font_name": "Comic Sans"},
        {"text_color": "red"},
        {"lines": [{"source": "custom"}]},  # custom needs text
        {"lines": [{"source": "passport"}]},  # type: ignore[list-item]
    ],
)
def test_invalid_templates_are_rejected(kwargs: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        SignatureTemplate(**kwargs)


def test_template_round_trips_through_json() -> None:
    template = SignatureTemplate(layout="image-right", checkmark=True, header=None)
    dumped = template.model_dump(by_alias=True, mode="json")
    assert SignatureTemplate.model_validate(dumped) == template


# -- the signature engine uses the renderer -----------------------------------------------


def test_appearance_provider_builds_a_static_stamp_from_certificate_data() -> None:
    info = AppearanceInfo(
        signer_name=NAME_VN,
        organization="Công ty TNHH Thử Nghiệm",
        reason=REASON_VN,
        location="Hà Nội",
        signed_at=SIGNED_AT,
        tax_code="0101234567",
        citizen_id=None,
        contact="0912 345 678",
    )
    style = TemplateAppearance(SignatureTemplate()).stamp_style(info, 240.0, 90.0)
    assert style.border_width == 0


def test_signed_document_shows_the_template_and_still_validates(
    harness: Harness, pki: Any, tmp_path: Path, sign_services: Any
) -> None:
    sample = make_numbered_pdf(tmp_path / "visible.pdf", 2)
    sid = str(harness.open(sample)["state"]["sessionId"])
    rect = [10.0, 20.0, 90.0, 80.0]
    template = {
        "header": "Đã ký",
        "lines": [{"source": "signerName", "label": "Ký bởi:"}, {"source": "date"}],
        "border": {"color": "#FF0000", "width": 1},
        "checkmark": True,
    }
    result = harness.op(
        "sign.pades",
        {
            "pfxPath": str(pki.pfx_a()),
            "password": PASSWORD_A,
            "page": 0,
            "rect": rect,
            "template": template,
        },
        sid,
    )
    assert result["changedPages"] == [0]
    saved = tmp_path / "visible-signed.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(saved)})

    assert validate_pdf_signatures(saved, pki.root.cert).signatures[0].valid

    img = _page_image(saved.read_bytes(), scale=2)
    page_h = 200.0  # make_numbered_pdf pages are 200 pt high
    px_x0, px_x1 = int(rect[0] * 2), int(rect[2] * 2)
    top = int((page_h - rect[3]) * 2)
    bottom = int((page_h - rect[1]) * 2)
    inside = img.crop((px_x0, top, px_x1, bottom))
    assert _ink_bbox(inside) is not None  # the box is not blank
    assert _count_color(inside, (255, 0, 0)) > 20  # red border drawn
    # Nothing is drawn outside the box (the page itself is blank).
    margin = 3
    outside = [
        (x, y)
        for y in range(img.size[1])
        for x in range(img.size[0])
        if not (px_x0 - margin <= x <= px_x1 + margin and top - margin <= y <= bottom + margin)
        and min(img.getpixel((x, y))) < 235
    ]
    assert outside == []


def test_default_template_is_used_when_none_is_given(
    harness: Harness, pki: Any, tmp_path: Path, sign_services: Any
) -> None:
    sample = make_numbered_pdf(tmp_path / "default.pdf", 1)
    sid = str(harness.open(sample)["state"]["sessionId"])
    result = harness.op(
        "sign.pades",
        {
            "pfxPath": str(pki.pfx_b()),
            "password": PASSWORD_B,
            "page": 0,
            "rect": [10.0, 10.0, 90.0, 60.0],
        },
        sid,
    )
    assert result["data"]["fieldName"] == "Signature1"


def test_missing_image_file_is_refused_before_signing(
    harness: Harness, pki: Any, tmp_path: Path, sign_services: Any
) -> None:
    sample = make_numbered_pdf(tmp_path / "noimg.pdf", 1)
    sid = str(harness.open(sample)["state"]["sessionId"])
    with pytest.raises(RpcFailure) as exc:
        harness.op(
            "sign.pades",
            {
                "pfxPath": str(pki.pfx_a()),
                "password": PASSWORD_A,
                "page": 0,
                "rect": [10.0, 10.0, 90.0, 60.0],
                "template": {"image": {"path": str(tmp_path / "nope.png")}},
            },
            sid,
        )
    assert exc.value.kind == "FILE_NOT_FOUND"
    assert harness.call("session.state", {"sessionId": sid})["signed"] is False


def _as_file(tmp_path: Path, data: bytes) -> Path:
    path = tmp_path / f"render-{abs(hash(data))}.pdf"
    path.write_bytes(data)
    return path
