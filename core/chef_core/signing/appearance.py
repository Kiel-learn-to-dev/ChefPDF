"""Signature appearance renderer (T3.09, features I10-I18).

The box shown for a visible signature is drawn here with reportlab and embedded as a form XObject
by pyHanko (``StaticStampStyle``). pyHanko's own text-box styles stretch TrueType glyphs (spike
S1, section 5), so they are not used.

``render_signature_appearance`` is a pure function of (template, data, box size). The Studio
(T3.10) previews with the same function, so what the user sees is what gets signed.

Text is laid out with fixed proportions per line: the first baseline sits 1.2 em below the top of
the block and each further line is 1.2 em lower; the block ends 0.25 em below the last baseline.
Auto-shrink uses the same proportions, so a block that fits in the layout also fits the box.
"""

from __future__ import annotations

import datetime as dt
import io
import re
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal

from PIL import Image
from pydantic import Field, model_validator
from pyhanko.pdf_utils import content
from pyhanko.pdf_utils import layout as pdf_layout
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.stamp import BaseStampStyle, StaticStampStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.models import WireModel
from chef_core.signing.fonts import font_path
from chef_core.signing.pades import AppearanceInfo

LEAD = 1.2  # line advance in em; also the distance from the block top to the first baseline
DESCENT = 0.25  # em below the last baseline that the block keeps
GAP = 4.0  # points between columns
LOGO_MAX_SHARE = 0.3  # the logo column is at most this share of the content width
CHECK_MAX = 20.0  # points: the check mark never grows beyond this
SHRINK_STEP = 0.25

SignatureLayout = Literal["text-only", "image-left", "image-right", "image-background"]
LineSource = Literal[
    "signerName",
    "organization",
    "taxCode",
    "citizenId",
    "reason",
    "location",
    "contact",
    "date",
    "custom",
]
FitMode = Literal["contain", "cover", "stretch"]
HexColor = Annotated[str, Field(pattern=r"^#[0-9A-Fa-f]{6}$")]
BUNDLED_FAMILY = "BeVietnamPro"


# -- template (wire model; the UI edits this shape) ---------------------------------------


class TemplateLine(WireModel):
    """One line of text in the box. Lines are drawn in list order; disabled lines are skipped."""

    source: LineSource = Field(description="Which value fills the line.")
    label: str | None = Field(default=None, max_length=60, description='E.g. "Ký bởi:".')
    text: str | None = Field(
        default=None,
        max_length=500,
        description="Custom text (source custom, required there). For other sources it replaces "
        "the value from the certificate or the signing parameters.",
    )
    font_size: float | None = Field(
        default=None, ge=1, le=72, description="Size of this line; default: the template size."
    )
    enabled: bool = True

    @model_validator(mode="after")
    def _custom_needs_text(self) -> TemplateLine:
        if self.source == "custom" and not (self.text and self.text.strip()):
            raise ValueError("a custom line needs text")
        return self


class BorderStyle(WireModel):
    color: HexColor = "#1F3A93"
    width: float = Field(default=0.8, gt=0, le=10, description="Points.")


class BackgroundStyle(WireModel):
    color: HexColor = "#FFFFFF"
    opacity: float = Field(default=0.0, ge=0, le=1, description="0 = transparent.")


class ImageSlot(WireModel):
    path: str = Field(min_length=1, description="PNG or JPEG file (PNG alpha is kept).")
    fit: FitMode = "contain"
    opacity: float = Field(default=1.0, ge=0, le=1)


def _default_lines() -> list[TemplateLine]:
    return [TemplateLine(source="signerName"), TemplateLine(source="date")]


class SignatureTemplate(WireModel):
    """Look of a visible signature (I10-I18). Defaults give a plain text box."""

    name: str = Field(default="Mặc định", max_length=80)
    layout: SignatureLayout = Field(
        default="text-only",
        description="text-only; image-left / image-right: image column beside the text; "
        "image-background: image behind the text. The image is ignored by text-only.",
    )
    header: str | None = Field(default="Ký số bởi", max_length=120)
    lines: list[TemplateLine] = Field(default_factory=_default_lines)
    date_format: str = Field(
        default="dd/MM/yyyy HH:mm:ss",
        min_length=1,
        max_length=80,
        description="Tokens: yyyy yy MM M dd d HH H mm m ss s. Text in single quotes is literal.",
    )
    show_timezone: bool = Field(default=False, description="Append (UTC+07:00).")
    font_name: Literal["BeVietnamPro"] = "BeVietnamPro"
    font_size: float = Field(default=9, ge=2, le=72, description="Points.")
    min_font_size: float = Field(default=5, ge=1, le=72, description="Floor for auto-shrink.")
    auto_shrink: bool = True
    bold: bool = False
    text_color: HexColor = "#000000"
    align: Literal["left", "center", "right"] = "left"
    valign: Literal["top", "middle", "bottom"] = "middle"
    padding: float = Field(default=4, ge=0, le=60, description="Inner margin in points.")
    border: BorderStyle | None = Field(default_factory=BorderStyle)
    background: BackgroundStyle = Field(default_factory=BackgroundStyle)
    checkmark: bool = Field(default=False, description="Vector check mark before the text.")
    check_color: HexColor = "#1E8E3E"
    image: ImageSlot | None = None
    image_ratio: float = Field(default=0.35, ge=0.1, le=0.9, description="Image column share.")
    logo: ImageSlot | None = Field(default=None, description="Logo in its own column at the right.")

    @model_validator(mode="after")
    def _sizes_consistent(self) -> SignatureTemplate:
        if self.min_font_size > self.font_size:
            raise ValueError("minFontSize must not be larger than fontSize")
        return self


# -- data ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class SignatureData:
    """Values a template can show. ``signed_at`` is shown in its own time zone."""

    signer_name: str
    organization: str | None
    tax_code: str | None
    citizen_id: str | None
    reason: str | None
    location: str | None
    contact: str | None
    signed_at: dt.datetime


def data_from_info(info: AppearanceInfo) -> SignatureData:
    """Values for the box: certificate facts, signing parameters and the local signing time."""
    return SignatureData(
        signer_name=info.signer_name,
        organization=info.organization,
        tax_code=info.tax_code,
        citizen_id=info.citizen_id,
        reason=info.reason,
        location=info.location,
        contact=info.contact,
        signed_at=info.signed_at.astimezone(),
    )


_DATE_TOKEN = re.compile(r"'(?:[^']|'')*'|yyyy|yy|MM|M|dd|d|HH|H|mm|m|ss|s")


def _date_tokens(value: dt.datetime) -> dict[str, str]:
    return {
        "yyyy": f"{value.year:04d}",
        "yy": f"{value.year % 100:02d}",
        "MM": f"{value.month:02d}",
        "M": str(value.month),
        "dd": f"{value.day:02d}",
        "d": str(value.day),
        "HH": f"{value.hour:02d}",
        "H": str(value.hour),
        "mm": f"{value.minute:02d}",
        "m": str(value.minute),
        "ss": f"{value.second:02d}",
        "s": str(value.second),
    }


def format_date(value: dt.datetime, pattern: str, show_timezone: bool = False) -> str:
    """Format ``value`` with a token pattern (``dd/MM/yyyy HH:mm:ss``, ``'Ngày' d 'tháng' M``).

    The value is shown in the time zone it carries; the caller converts to local time.
    """
    tokens = _date_tokens(value)

    def piece(match: re.Match[str]) -> str:
        token = match.group(0)
        if token.startswith("'"):
            return token[1:-1].replace("''", "'")
        return tokens[token]

    text = _DATE_TOKEN.sub(piece, pattern)
    if show_timezone:
        offset = value.utcoffset() or dt.timedelta(0)
        minutes = int(offset.total_seconds() // 60)
        sign = "+" if minutes >= 0 else "-"
        hours, mins = divmod(abs(minutes), 60)
        text += f" (UTC{sign}{hours:02d}:{mins:02d})"
    return text


# -- fonts and images ---------------------------------------------------------------------


def _font_name(bold: bool) -> str:
    return f"Chef-{BUNDLED_FAMILY}-{'Bold' if bold else 'Regular'}"


def _register_fonts() -> None:
    registered = set(pdfmetrics.getRegisteredFontNames())
    for bold in (False, True):
        name = _font_name(bold)
        if name not in registered:
            pdfmetrics.registerFont(TTFont(name, str(font_path(BUNDLED_FAMILY, bold=bold))))


def _load_image(data: bytes, opacity: float = 1.0) -> Image.Image:
    """Decode a picture, keep its alpha channel and scale that alpha by ``opacity``."""
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception as exc:
        raise invalid_params("The picture file cannot be read") from exc
    rgba = img.convert("RGBA")
    if opacity < 1.0:
        alpha = rgba.getchannel("A").point(lambda v: round(v * opacity))
        rgba.putalpha(alpha)
    return rgba


def _read_asset(slot: ImageSlot | None) -> bytes | None:
    if slot is None:
        return None
    path = Path(slot.path)
    if not path.is_file():
        raise ChefError(ErrorKind.FILE_NOT_FOUND, "File not found", {"path": str(path)})
    return path.read_bytes()


Rect = tuple[float, float, float, float]  # x, y, width, height


def _draw_image(c: canvas.Canvas, img: Image.Image, box: Rect, fit: FitMode) -> None:
    x, y, w, h = box
    if w <= 0 or h <= 0:
        return
    iw, ih = img.size
    if fit == "stretch":
        dx, dy, dw, dh = x, y, w, h
    else:
        scale = min(w / iw, h / ih) if fit == "contain" else max(w / iw, h / ih)
        dw, dh = iw * scale, ih * scale
        dx, dy = x + (w - dw) / 2, y + (h - dh) / 2
    c.saveState()
    if fit == "cover":
        clip = c.beginPath()
        clip.rect(x, y, w, h)
        c.clipPath(clip, stroke=0, fill=0)
    c.drawImage(ImageReader(img), dx, dy, dw, dh, mask="auto")
    c.restoreState()


def _rgb(color: str) -> tuple[float, float, float]:
    r, g, b = (int(color[i : i + 2], 16) / 255 for i in (1, 3, 5))
    return r, g, b


# -- text layout --------------------------------------------------------------------------


@dataclass(frozen=True)
class _Entry:
    text: str
    override: float | None
    bold: bool


@dataclass(frozen=True)
class _Visual:
    text: str
    size: float
    bold: bool


def _wrap(text: str, bold: bool, size: float, width: float) -> list[str] | None:
    """Greedy word wrap; words wider than the box are split by character. None if a single
    character does not fit."""
    font = _font_name(bold)
    lines: list[str] = []
    current = ""
    for word in text.split():
        trial = f"{current} {word}" if current else word
        if pdfmetrics.stringWidth(trial, font, size) <= width:
            current = trial
            continue
        if current:
            lines.append(current)
            current = ""
        if pdfmetrics.stringWidth(word, font, size) <= width:
            current = word
            continue
        piece = ""
        for ch in word:
            if pdfmetrics.stringWidth(ch, font, size) > width:
                return None
            if pdfmetrics.stringWidth(piece + ch, font, size) > width:
                lines.append(piece)
                piece = ch
            else:
                piece += ch
        current = piece
    if current:
        lines.append(current)
    return lines


def _block_height(sizes: Sequence[float]) -> float:
    if not sizes:
        return 0.0
    return LEAD * sizes[0] + sum(LEAD * s for s in sizes[:-1]) + DESCENT * sizes[-1]


def _sizes_at(entries: Sequence[_Entry], scale: float, base: float, minimum: float) -> list[float]:
    """Line sizes when the template size is ``scale``. Per-line overrides scale with it."""
    sizes: list[float] = []
    for entry in entries:
        wanted = scale if entry.override is None else entry.override * scale / base
        sizes.append(max(minimum, round(wanted, 2)))
    return sizes


def _visual_lines(
    entries: Sequence[_Entry], sizes: Sequence[float], width: float
) -> tuple[list[_Visual], bool]:
    """Wrapped lines for every entry; entries that cannot be wrapped are skipped (flag)."""
    visual: list[_Visual] = []
    failed = False
    for entry, size in zip(entries, sizes, strict=True):
        wrapped = _wrap(entry.text, entry.bold, size, width)
        if wrapped is None:
            failed = True
            continue
        visual.extend(_Visual(text, size, entry.bold) for text in wrapped)
    return visual, failed


def _candidate_scales(base: float, minimum: float, auto: bool) -> list[float]:
    if not auto:
        return [base]
    scales: list[float] = []
    current = base
    while current > minimum + 1e-6:
        scales.append(round(current, 2))
        current -= SHRINK_STEP
    scales.append(minimum)
    return scales


@dataclass(frozen=True)
class _TextLayout:
    scale: float
    lines: list[_Visual]
    truncated: bool


def _lay_out_text(
    entries: Sequence[_Entry],
    *,
    base: float,
    minimum: float,
    auto: bool,
    width: float,
    height: float,
) -> _TextLayout:
    if not entries:
        return _TextLayout(base, [], False)
    if width <= 0 or height <= 0:
        return _TextLayout(base, [], True)
    scales = _candidate_scales(base, minimum, auto)
    for scale in scales:
        sizes = _sizes_at(entries, scale, base, minimum)
        visual, failed = _visual_lines(entries, sizes, width)
        if not failed and _block_height([v.size for v in visual]) <= height:
            return _TextLayout(scale, visual, False)
    # Nothing fits: keep the smallest candidate and drop the lines that do not fit.
    scale = scales[-1]
    visual, failed = _visual_lines(entries, _sizes_at(entries, scale, base, minimum), width)
    dropped = failed
    while visual and _block_height([v.size for v in visual]) > height:
        visual.pop()
        dropped = True
    return _TextLayout(scale, visual, dropped)


def _entries(template: SignatureTemplate, data: SignatureData) -> list[_Entry]:
    values: dict[str, str | None] = {
        "signerName": data.signer_name,
        "organization": data.organization,
        "taxCode": data.tax_code,
        "citizenId": data.citizen_id,
        "reason": data.reason,
        "location": data.location,
        "contact": data.contact,
        "date": format_date(data.signed_at, template.date_format, template.show_timezone),
    }
    entries: list[_Entry] = []
    if template.header and template.header.strip():
        entries.append(_Entry(" ".join(template.header.split()), None, True))
    for line in template.lines:
        if not line.enabled:
            continue
        value = line.text if line.source == "custom" else line.text or values[line.source]
        if value is None or not value.strip():
            continue
        text = " ".join(value.split())
        if line.label:
            text = f"{line.label.strip()} {text}"
        entries.append(_Entry(text, line.font_size, template.bold))
    return entries


# -- rendering ----------------------------------------------------------------------------


@dataclass(frozen=True)
class RenderedAppearance:
    pdf: bytes  # one page, MediaBox (0 0 width height)
    font_size: float  # the size chosen for the text (after auto-shrink)
    truncated: bool  # some text did not fit even at the smallest size and was left out


def render_signature_appearance(
    template: SignatureTemplate,
    data: SignatureData,
    width: float,
    height: float,
    *,
    image: bytes | None = None,
    logo: bytes | None = None,
) -> RenderedAppearance:
    """Draw the box as a one-page PDF of ``width`` x ``height`` points."""
    if width <= 0 or height <= 0:
        raise invalid_params("The signature box must have a positive size")
    _register_fonts()

    picture = _load_image(image, template.image.opacity) if image and template.image else None
    logo_img = _load_image(logo, template.logo.opacity) if logo and template.logo else None
    image_fit: FitMode = template.image.fit if template.image else "contain"
    logo_fit: FitMode = template.logo.fit if template.logo else "contain"

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(width, height), invariant=1)

    if template.background.opacity > 0:
        c.saveState()
        c.setFillColorRGB(*_rgb(template.background.color))
        c.setFillAlpha(template.background.opacity)
        c.rect(0, 0, width, height, stroke=0, fill=1)
        c.restoreState()

    border_width = template.border.width if template.border else 0.0
    inset = template.padding + border_width
    cx, cy = inset, inset
    cw, ch = width - 2 * inset, height - 2 * inset

    if picture is not None and template.layout == "image-background":
        _draw_image(c, picture, (0.0, 0.0, width, height), image_fit)

    # Columns: image (left or right), then the text, then the logo at the far right.
    left, right = cx, cx + cw
    image_share = 0.0
    if picture is not None and template.layout in ("image-left", "image-right"):
        image_share = cw * template.image_ratio
        if template.layout == "image-left":
            _draw_image(c, picture, (left, cy, image_share, ch), image_fit)
            left += image_share + GAP
        else:
            _draw_image(c, picture, (right - image_share, cy, image_share, ch), image_fit)
            right -= image_share + GAP
    if logo_img is not None and template.logo is not None:
        logo_w = min(ch, cw * LOGO_MAX_SHARE)
        _draw_image(c, logo_img, (right - logo_w, cy, logo_w, ch), logo_fit)
        right -= logo_w + GAP

    tx, tw = left, right - left
    th = ch
    slot = min(CHECK_MAX, th * 0.7)
    if template.checkmark and tw > 2 * slot + GAP:
        _draw_check(c, (tx, cy + (th - slot) / 2, slot, slot), template.check_color)
        tx += slot + GAP
        tw -= slot + GAP

    layout_result = _lay_out_text(
        _entries(template, data),
        base=template.font_size,
        minimum=template.min_font_size,
        auto=template.auto_shrink,
        width=tw,
        height=th,
    )
    _draw_text(c, layout_result.lines, template, (tx, cy, tw, th))

    if template.border is not None and border_width > 0:
        c.setStrokeColorRGB(*_rgb(template.border.color))
        c.setLineWidth(border_width)
        half = border_width / 2
        c.rect(half, half, width - border_width, height - border_width, stroke=1, fill=0)

    c.showPage()
    c.save()
    return RenderedAppearance(
        pdf=buf.getvalue(),
        font_size=layout_result.scale,
        truncated=layout_result.truncated,
    )


def _draw_check(c: canvas.Canvas, box: Rect, color: str) -> None:
    """A check mark as a vector path (no glyph): the familiar "valid" tick."""
    x, y, w, h = box
    points = ((0.12, 0.52), (0.38, 0.2), (0.9, 0.82))
    path = c.beginPath()
    for index, (px, py) in enumerate(points):
        target = (x + px * w, y + py * h)
        if index == 0:
            path.moveTo(*target)
        else:
            path.lineTo(*target)
    c.saveState()
    c.setStrokeColorRGB(*_rgb(color))
    c.setLineWidth(max(1.2, min(w, h) * 0.14))
    c.setLineCap(1)
    c.setLineJoin(1)
    c.drawPath(path, stroke=1, fill=0)
    c.restoreState()


def _draw_text(
    c: canvas.Canvas, lines: Sequence[_Visual], template: SignatureTemplate, box: Rect
) -> None:
    if not lines:
        return
    x, y, w, h = box
    sizes = [line.size for line in lines]
    block = _block_height(sizes)
    if template.valign == "top":
        top = y + h
    elif template.valign == "bottom":
        top = y + block
    else:
        top = y + (h + block) / 2
    baseline = top - LEAD * sizes[0]
    c.setFillColorRGB(*_rgb(template.text_color))
    for index, line in enumerate(lines):
        font = _font_name(line.bold)
        text_w = pdfmetrics.stringWidth(line.text, font, line.size)
        if template.align == "center":
            left = x + (w - text_w) / 2
        elif template.align == "right":
            left = x + w - text_w
        else:
            left = x
        c.setFont(font, line.size)
        c.drawString(left, baseline, line.text)
        if index + 1 < len(lines):
            baseline -= LEAD * line.size


# -- pyHanko stamp adapter ----------------------------------------------------------------


class _EmbeddedPage(content.PdfContent):
    """Imports the one-page appearance PDF as a form XObject (the same way pyHanko imports a
    background page from a file, but from memory)."""

    def __init__(self, data: bytes, width: int, height: int) -> None:
        super().__init__(box=pdf_layout.BoxConstraints(width=width, height=height))
        self._data = data

    def render(self) -> bytes:
        writer = self._ensure_writer
        reader = PdfFileReader(io.BytesIO(self._data))
        xobj = writer.import_page_as_xobject(reader, page_ix=0)
        name = "/SigAppearance"
        self.resources.xobject[name] = xobj
        return f"{name} Do".encode("ascii")


class TemplateAppearance:
    """``AppearanceStreamProvider`` (pades.py) that draws the box from a ``SignatureTemplate``.

    Image files are read and checked when the object is made, so a bad file stops the operation
    before anything is signed.
    """

    def __init__(
        self,
        template: SignatureTemplate,
        *,
        image: bytes | None = None,
        logo: bytes | None = None,
    ) -> None:
        self.template = template
        self.image = image if image is not None else _read_asset(template.image)
        self.logo = logo if logo is not None else _read_asset(template.logo)
        for data in (self.image, self.logo):
            if data is not None:
                _load_image(data)

    def stamp_style(self, info: AppearanceInfo, width: float, height: float) -> BaseStampStyle:
        box_w, box_h = round(width), round(height)
        rendered = render_signature_appearance(
            self.template,
            data_from_info(info),
            box_w,
            box_h,
            image=self.image,
            logo=self.logo,
        )
        return StaticStampStyle(
            background=_EmbeddedPage(rendered.pdf, box_w, box_h),
            background_layout=pdf_layout.SimpleBoxLayoutRule(
                x_align=pdf_layout.AxisAlignment.ALIGN_MIN,
                y_align=pdf_layout.AxisAlignment.ALIGN_MIN,
                margins=pdf_layout.Margins.uniform(0),  # type: ignore[no-untyped-call]
                inner_content_scaling=pdf_layout.InnerScaling.NO_SCALING,
            ),
            background_opacity=1.0,
            border_width=0,
        )


__all__ = [
    "BackgroundStyle",
    "BorderStyle",
    "ImageSlot",
    "RenderedAppearance",
    "SignatureData",
    "SignatureTemplate",
    "TemplateAppearance",
    "TemplateLine",
    "data_from_info",
    "format_date",
    "render_signature_appearance",
]
