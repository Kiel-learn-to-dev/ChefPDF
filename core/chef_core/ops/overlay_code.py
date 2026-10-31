"""QR codes and barcodes (T4.08, F10): overlay.qrCode and overlay.barcode.

Both are drawn as vectors: every dark run of modules is one filled rectangle, and the whole
symbol is one path in the overlay (no raster image). The matrix comes from ``segno`` (BSD) for QR
codes and the bit pattern from ``python-barcode`` (MIT) for Code 128, EAN-13 and Code 39. Both
libraries are imported when an op runs, so a missing package does not stop the core from starting.

``size`` of a QR code is the full side of the box, quiet zone included. ``moduleWidth`` and
``height`` of a barcode are the width of one module and the height of the bars; the quiet zone
is counted in modules on both sides. ``content`` and ``label`` take the page variables of
``chef_core.overlay.variables``, so each page can carry its own number.

Kind ``qr`` for both, so F12 lists and removes them together.
"""

from __future__ import annotations

import uuid
from typing import Literal

import pikepdf
from pydantic import Field

from chef_core.errors import invalid_params
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.ops.overlay import (
    HexColor,
    PageSelection,
    Placed,
    Unit,
    hex_color,
    page_selection,
    to_points,
)
from chef_core.ops.overlay_header import document_vars
from chef_core.overlay.engine import Color, OverlayWriter, Piece, Placement, TextStyle
from chef_core.overlay.geometry import number
from chef_core.overlay.variables import check_template

QrLevel = Literal["L", "M", "Q", "H"]
BarcodeKind = Literal["code128", "ean13", "code39"]
Rect = tuple[float, float, float, float]
MAX_CONTENT = 2000
MAX_LABEL = 200


# -- parameters -------------------------------------------------------------------------


class QrParams(PageSelection, Placed):
    """A QR code. ``size`` is the side of the whole box, quiet zone included. The default unit is
    millimetres. ``content`` may use page variables such as {page} or {filename}."""

    unit: Unit = Field(default="mm")
    content: str = Field(min_length=1, max_length=MAX_CONTENT)
    error_correction: QrLevel = Field(default="M", description="L, M, Q or H.")
    quiet_zone: int = Field(default=4, ge=0, le=20, description="Modules of white border.")
    size: float = Field(default=25.0, gt=0, le=2000)
    color: HexColor = Field(default="#000000")
    background: HexColor | None = Field(default=None, description="None: transparent.")
    label: str | None = Field(default=None, max_length=MAX_LABEL, description="Text below.")
    label_font_size: float = Field(default=8.0, gt=0, le=72)
    font_name: Literal["BeVietnamPro"] = Field(default="BeVietnamPro")
    start_number: int = Field(default=1, ge=0, le=1_000_000_000)
    date_format: str = Field(default="dd/MM/yyyy", min_length=1, max_length=40)


class BarcodeParams(PageSelection, Placed):
    """A linear barcode: Code 128 (any ASCII), EAN-13 (12 or 13 digits) or Code 39 (no check
    digit added). ``moduleWidth`` is the width of the narrowest bar; ``height`` the bar height."""

    unit: Unit = Field(default="mm")
    kind: BarcodeKind = Field(default="code128")
    content: str = Field(min_length=1, max_length=MAX_CONTENT)
    module_width: float = Field(default=0.33, gt=0, le=20)
    height: float = Field(default=15.0, gt=0, le=2000)
    quiet_zone: int = Field(default=10, ge=0, le=50, description="Modules of white border.")
    color: HexColor = Field(default="#000000")
    background: HexColor | None = Field(default=None, description="None: transparent.")
    label: str | None = Field(default=None, max_length=MAX_LABEL, description="Text below.")
    label_font_size: float = Field(default=8.0, gt=0, le=72)
    font_name: Literal["BeVietnamPro"] = Field(default="BeVietnamPro")
    start_number: int = Field(default=1, ge=0, le=1_000_000_000)
    date_format: str = Field(default="dd/MM/yyyy", min_length=1, max_length=40)


# -- symbol matrices --------------------------------------------------------------------


def qr_matrix(content: str, level: str) -> list[list[int]]:
    """Dark (1) and light (0) modules of a QR code, row 0 at the top."""
    import segno

    try:
        qr = segno.make(content, error=level, micro=False)
    except Exception as exc:  # segno raises its own errors for too much data
        raise invalid_params(f"The content does not fit a QR code at level {level}") from exc
    return [[int(v) for v in row] for row in qr.matrix]


def barcode_bits(kind: str, content: str) -> str:
    """Bars of a linear barcode as '1' (bar) and '0' (space); no quiet zone."""
    import barcode
    from barcode.errors import BarcodeError

    options = {"add_checksum": False} if kind == "code39" else None
    try:
        symbol = barcode.get(kind, content, options=options)
        bits = symbol.build()[0]
    except (BarcodeError, ValueError) as exc:
        raise invalid_params(f"The content cannot be encoded as {kind}: {exc}") from exc
    return str(bits)


# -- pieces -----------------------------------------------------------------------------


def _fill(rects: list[Rect], color: Color) -> str:
    rgb = " ".join(number(c) for c in color)
    lines = [f"{rgb} rg"]
    for x, y, w, h in rects:
        lines.append(f"{number(x)} {number(y)} {number(w)} {number(h)} re")
    lines.append("f")
    return "\n".join(lines)


def _with_label(
    writer: OverlayWriter,
    symbol: Piece,
    label: str | None,
    *,
    font: str,
    size: float,
    color: Color,
) -> Piece:
    """The symbol, with an optional centred label below it (same width as the symbol)."""
    if not label:
        return symbol
    text = writer.text(
        label,
        TextStyle(font_family=font, font_size=size, color=color, align="center"),
        width=symbol.width,
    )
    gap = size * 0.25
    shift = text.height + gap
    body = "\n".join(["q", f"1 0 0 1 0 {number(shift)} cm", symbol.body, "Q", text.body])
    return Piece(width=max(symbol.width, text.width), height=symbol.height + shift, body=body)


def qr_piece(
    writer: OverlayWriter,
    matrix: list[list[int]],
    *,
    size: float,
    quiet: int,
    color: Color,
    background: Color | None,
    label: str | None,
    label_size: float,
    font: str,
) -> Piece:
    n = len(matrix)
    module = size / (n + 2 * quiet)
    rects: list[Rect] = []
    for r, row in enumerate(matrix):
        c = 0
        while c < n:
            if not row[c]:
                c += 1
                continue
            start = c
            while c < n and row[c]:
                c += 1
            rects.append(
                (
                    (quiet + start) * module,
                    (quiet + n - 1 - r) * module,
                    (c - start) * module,
                    module,
                )
            )
    parts = ["q"]
    if background is not None:
        parts.append(_fill([(0.0, 0.0, size, size)], background))
    parts.append(_fill(rects, color))
    parts.append("Q")
    symbol = Piece(width=size, height=size, body="\n".join(parts))
    return _with_label(writer, symbol, label, font=font, size=label_size, color=color)


def barcode_piece(
    writer: OverlayWriter,
    bits: str,
    *,
    module: float,
    bar_height: float,
    quiet: int,
    color: Color,
    background: Color | None,
    label: str | None,
    label_size: float,
    font: str,
) -> Piece:
    rects: list[Rect] = []
    i = 0
    while i < len(bits):
        if bits[i] != "1":
            i += 1
            continue
        start = i
        while i < len(bits) and bits[i] == "1":
            i += 1
        rects.append(((quiet + start) * module, 0.0, (i - start) * module, bar_height))
    width = (len(bits) + 2 * quiet) * module
    parts = ["q"]
    if background is not None:
        parts.append(_fill([(0.0, 0.0, width, bar_height)], background))
    parts.append(_fill(rects, color))
    parts.append("Q")
    symbol = Piece(width=width, height=bar_height, body="\n".join(parts))
    return _with_label(writer, symbol, label, font=font, size=label_size, color=color)


# -- ops --------------------------------------------------------------------------------


def _placement(p: Placed) -> Placement:
    return Placement(
        x=to_points(p.x, p.unit),
        y=to_points(p.y, p.unit),
        anchor=p.anchor,
        rotation=p.rotation,
        opacity=p.opacity,
    )


def _finish(ctx: OpContext, pdf: pikepdf.Pdf, writer: OverlayWriter) -> OpOutput:
    writer.commit()
    if writer.pages:
        ctx.save_document(pdf)
    return OpOutput(changed_pages=writer.pages, data={"overlayId": writer.overlay_id})


@operation(
    id="overlay.qrCode",
    title="QR code",
    group="overlay",
    params=QrParams,
    destructive=True,
    batchable=True,
)
def qr_code(ctx: OpContext, p: QrParams) -> OpOutput:
    check_template(p.content)
    if p.label is not None:
        check_template(p.label)
    color = hex_color(p.color)
    background = hex_color(p.background) if p.background else None
    with ctx.open_input() as pdf:
        pages = page_selection(p.pages, p.page_range, len(pdf.pages))
        writer = OverlayWriter(pdf, kind="qr", group=uuid.uuid4().hex, warn=ctx.warn)
        values = document_vars(
            pdf, doc_name=ctx.doc_name, start_number=p.start_number, date_format=p.date_format
        )
        cache: dict[tuple[str, str | None], Piece] = {}
        for index in ctx.steps(pages, len(pages), "Adding QR code"):
            content = values.render(p.content, index)
            if not content:
                raise invalid_params("The QR content is empty on this page", {"page": index + 1})
            label = values.render(p.label, index) if p.label else None
            key = (content, label)
            piece = cache.get(key)
            if piece is None:
                matrix = qr_matrix(content, p.error_correction)
                piece = qr_piece(
                    writer,
                    matrix,
                    size=to_points(p.size, p.unit),
                    quiet=p.quiet_zone,
                    color=color,
                    background=background,
                    label=label,
                    label_size=p.label_font_size,
                    font=p.font_name,
                )
                cache[key] = piece
            writer.place(index, piece, _placement(p), under=p.under)
        return _finish(ctx, pdf, writer)


@operation(
    id="overlay.barcode",
    title="Barcode",
    group="overlay",
    params=BarcodeParams,
    destructive=True,
    batchable=True,
)
def barcode_op(ctx: OpContext, p: BarcodeParams) -> OpOutput:
    check_template(p.content)
    if p.label is not None:
        check_template(p.label)
    color = hex_color(p.color)
    background = hex_color(p.background) if p.background else None
    with ctx.open_input() as pdf:
        pages = page_selection(p.pages, p.page_range, len(pdf.pages))
        writer = OverlayWriter(pdf, kind="qr", group=uuid.uuid4().hex, warn=ctx.warn)
        values = document_vars(
            pdf, doc_name=ctx.doc_name, start_number=p.start_number, date_format=p.date_format
        )
        cache: dict[tuple[str, str | None], Piece] = {}
        for index in ctx.steps(pages, len(pages), "Adding barcode"):
            content = values.render(p.content, index)
            if not content:
                raise invalid_params(
                    "The barcode content is empty on this page", {"page": index + 1}
                )
            label = values.render(p.label, index) if p.label else None
            key = (content, label)
            piece = cache.get(key)
            if piece is None:
                bits = barcode_bits(p.kind, content)
                piece = barcode_piece(
                    writer,
                    bits,
                    module=to_points(p.module_width, p.unit),
                    bar_height=to_points(p.height, p.unit),
                    quiet=p.quiet_zone,
                    color=color,
                    background=background,
                    label=label,
                    label_size=p.label_font_size,
                    font=p.font_name,
                )
                cache[key] = piece
            writer.place(index, piece, _placement(p), under=p.under)
        return _finish(ctx, pdf, writer)
