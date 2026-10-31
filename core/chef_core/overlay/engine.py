"""Overlay engine (T4.01): draws text, images and shapes on top of or under the pages of a PDF.

How an overlay is built
-----------------------
A *piece* is a drawing in its own box (origin bottom-left, size ``width`` x ``height``). A
*placement* puts the box on a displayed page: the anchor point goes to (x, y) measured from the
top-left corner of the displayed page, and the box is rotated about that anchor. The matrix of
that placement is composed with the page frame (``geometry.placed_box_matrix``), so /Rotate and
CropBox are handled once, for every kind of piece.

Each placement becomes one marked chunk on the page (``markers.overlay_block``). Fonts, images,
soft masks and ExtGStates are shared objects: one embedded subset per document and font, one
XObject per distinct image, and one Form XObject per watermark or letterhead, whatever the number
of pages. The page only gets a name for each of them.

Resource names are ``Chef<overlay id><F|X|G><n>``, so every name belongs to one overlay and
removal can find it (``registry.remove_overlays``).
"""

from __future__ import annotations

import hashlib
import math
import unicodedata
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

import pikepdf
from pikepdf import Array, Dictionary, Name

from chef_core.errors import invalid_params
from chef_core.overlay.fonts import FontFace, Subset, face, to_unicode_cmap
from chef_core.overlay.geometry import (
    Affine,
    display_to_user,
    fmt,
    mul,
    number,
    placed_box_matrix,
    rotate,
    scale,
    translate,
    user_to_display,
)
from chef_core.overlay.images import PX_TO_PT, DecodedImage, decode_image
from chef_core.overlay.markers import KINDS, TAG_WRAP, WRAP_BEGIN, WRAP_END, overlay_block
from chef_core.overlay.pagecontent import (
    category,
    content_bytes,
    own_resources,
    page_frame,
    set_content,
)
from chef_core.overlay.registry import append_entry, cache_dict
from chef_core.signing.anchors import PageFrame

Align = Literal["left", "center", "right"]
Blend = Literal["Normal", "Multiply", "Screen", "Darken", "Lighten"]
Color = tuple[float, float, float]
WarnFn = Callable[[str], None]

CATEGORY_LETTERS = {"Font": "F", "XObject": "X", "ExtGState": "G"}
MAX_TILES = 4000
DEFAULT_IMAGE_WIDTH = 150.0
MISSING_GLYPH_CONTROL = frozenset("\n\r\t")


@dataclass(frozen=True)
class TextStyle:
    font_family: str = "BeVietnamPro"
    font_size: float = 12.0
    bold: bool = False
    color: Color = (0.0, 0.0, 0.0)
    align: Align = "left"
    line_height: float = 1.2


@dataclass(frozen=True)
class Placement:
    """Where a piece goes: anchor point (x, y) from the top-left of the displayed page (points)."""

    x: float
    y: float
    anchor: str = "top-left"
    rotation: float = 0.0  # degrees, counter-clockwise on screen, about the anchor
    opacity: float = 1.0
    blend: Blend = "Normal"


@dataclass(frozen=True)
class Piece:
    width: float
    height: float
    body: str  # drawing operators in the box's own coordinates


class Resources:
    """Named resources of one overlay (or of one form). Objects are deduplicated by identity."""

    def __init__(self, prefix: str) -> None:
        self.prefix = prefix
        self.entries: dict[str, dict[str, pikepdf.Object]] = {cat: {} for cat in CATEGORY_LETTERS}
        self._names: dict[tuple[str, tuple[int, int] | int], str] = {}

    def add(self, cat: str, obj: pikepdf.Object) -> str:
        """Name (without slash) of ``obj`` in category ``cat``, registering it on first use."""
        ident: tuple[int, int] | int = obj.objgen if obj.objgen != (0, 0) else id(obj)
        found = self._names.get((cat, ident))
        if found is not None:
            return found
        name = f"{self.prefix}{CATEGORY_LETTERS[cat]}{len(self.entries[cat])}"
        self.entries[cat][name] = obj
        self._names[(cat, ident)] = name
        return name

    def as_dictionary(self) -> pikepdf.Dictionary:
        """A /Resources dictionary with these entries (for forms)."""
        res = Dictionary()
        for cat, items in self.entries.items():
            if items:
                res[f"/{cat}"] = Dictionary({f"/{name}": obj for name, obj in items.items()})
        return res


# -- document-level caches --------------------------------------------------------------


@dataclass(frozen=True)
class FontHandle:
    obj: pikepdf.Object
    face: FontFace

    def supports(self, cp: int) -> bool:
        return self.face.supports(cp)

    def width(self, text: str, size: float) -> float:
        total = sum(self.face.advance(ord(ch)) for ch in text)
        return total * size / self.face.units_per_em

    def hex_for(self, text: str) -> str:
        out = []
        for ch in text:
            gid = self.face.gid(ord(ch))
            if gid is not None:
                out.append(f"{gid:04X}")
        return "".join(out)


@dataclass(frozen=True)
class ImageHandle:
    obj: pikepdf.Object
    width_px: int
    height_px: int


class DocCache:
    """Fonts, images and ExtGStates of one document, shared by every overlay in it."""

    def __init__(self, pdf: pikepdf.Pdf) -> None:
        self.pdf = pdf
        self._fonts: dict[str, FontHandle] = {}
        self._images: dict[str, ImageHandle] = {}
        self._gstates: dict[tuple[float, str], pikepdf.Object] = {}

    def font(self, family: str, bold: bool, codepoints: set[int]) -> FontHandle:
        font_face = face(family, bold)
        base = font_face.base_codepoints()
        extra = {cp for cp in codepoints if font_face.supports(cp)} - base
        key = f"{family}-{'B' if bold else 'R'}"
        wanted = set(base)
        if extra:
            digest = hashlib.sha1(",".join(str(c) for c in sorted(extra)).encode()).hexdigest()
            key = f"{key}-x{digest[:8]}"
            wanted |= extra
        found = self._fonts.get(key)
        if found is not None:
            return found
        fonts = cache_dict(self.pdf, "Fonts")
        ref = fonts.get(f"/{key}")
        if not isinstance(ref, pikepdf.Object):
            ref = _embed_font(self.pdf, font_face, font_face.subset(wanted), key)
            fonts[f"/{key}"] = ref
        handle = FontHandle(ref, font_face)
        self._fonts[key] = handle
        return handle

    def image(self, raw: bytes) -> ImageHandle:
        key = hashlib.sha256(raw).hexdigest()
        found = self._images.get(key)
        if found is not None:
            return found
        images = cache_dict(self.pdf, "Images")
        ref = images.get(f"/{key}")
        if not isinstance(ref, pikepdf.Object):
            ref = _embed_image(self.pdf, decode_image(raw))
            images[f"/{key}"] = ref
        handle = ImageHandle(ref, int(ref.Width), int(ref.Height))
        self._images[key] = handle
        return handle

    def gstate(self, opacity: float, blend: str) -> pikepdf.Object:
        key = (round(opacity, 4), blend)
        found = self._gstates.get(key)
        if found is None:
            found = self.pdf.make_indirect(
                Dictionary(Type=Name.ExtGState, CA=key[0], ca=key[0], BM=Name(f"/{blend}"))
            )
            self._gstates[key] = found
        return found


def _tag(key: str) -> str:
    digest = hashlib.sha1(key.encode()).digest()
    return "".join(chr(ord("A") + b % 26) for b in digest[:6])


def _embed_font(pdf: pikepdf.Pdf, font_face: FontFace, sub: Subset, key: str) -> pikepdf.Object:
    per_em = 1000.0 / font_face.units_per_em
    name = f"{_tag(key)}+{font_face.postscript_name.replace(' ', '')}"
    program = pdf.make_stream(sub.program)
    descriptor = pdf.make_indirect(
        Dictionary(
            Type=Name.FontDescriptor,
            FontName=Name(f"/{name}"),
            Flags=32,
            FontBBox=Array([round(v * per_em) for v in font_face.bbox]),
            ItalicAngle=0,
            Ascent=round(font_face.ascent * 1000),
            Descent=round(font_face.descent * 1000),
            CapHeight=round(font_face.cap_height * per_em),
            StemV=80,
            FontFile2=program,
        )
    )
    widths = Array()
    for gid, cp in sorted(sub.gid_to_cp.items()):
        widths.append(gid)
        widths.append(Array([round(font_face.advance(cp) * per_em)]))
    descendant = pdf.make_indirect(
        Dictionary(
            Type=Name.Font,
            Subtype=Name.CIDFontType2,
            BaseFont=Name(f"/{name}"),
            CIDSystemInfo=Dictionary(
                Registry=pikepdf.String("Adobe"), Ordering=pikepdf.String("Identity"), Supplement=0
            ),
            FontDescriptor=descriptor,
            DW=1000,
            W=widths,
            CIDToGIDMap=Name.Identity,
        )
    )
    to_unicode = pdf.make_stream(to_unicode_cmap(sub.gid_to_cp))
    return pdf.make_indirect(
        Dictionary(
            Type=Name.Font,
            Subtype=Name.Type0,
            BaseFont=Name(f"/{name}"),
            Encoding=Name("/Identity-H"),
            DescendantFonts=Array([descendant]),
            ToUnicode=to_unicode,
        )
    )


def _embed_image(pdf: pikepdf.Pdf, decoded: DecodedImage) -> pikepdf.Object:
    image = pdf.make_stream(decoded.data)
    image.Type = Name.XObject
    image.Subtype = Name.Image
    image.Width = decoded.width
    image.Height = decoded.height
    image.ColorSpace = Name(f"/{decoded.color_space}")
    image.BitsPerComponent = 8
    if decoded.dct:
        image.Filter = Name.DCTDecode
    if decoded.alpha is not None:
        mask = pdf.make_stream(decoded.alpha)
        mask.Type = Name.XObject
        mask.Subtype = Name.Image
        mask.Width = decoded.width
        mask.Height = decoded.height
        mask.ColorSpace = Name.DeviceGray
        mask.BitsPerComponent = 8
        image.SMask = mask
    return image


# -- pieces -----------------------------------------------------------------------------


def _rgb(color: Color) -> str:
    return " ".join(number(c) for c in color)


def _wrap(paragraph: str, font: FontHandle, size: float, max_width: float) -> list[str]:
    lines: list[str] = []
    current = ""
    for word in paragraph.split(" "):
        candidate = word if not current else f"{current} {word}"
        if font.width(candidate, size) <= max_width:
            current = candidate
            continue
        if current:
            lines.append(current)
            current = ""
        if font.width(word, size) <= max_width:
            current = word
            continue
        chunk = ""
        for ch in word:  # a single word wider than the box is broken between characters
            if chunk and font.width(chunk + ch, size) > max_width:
                lines.append(chunk)
                chunk = ch
            else:
                chunk += ch
        current = chunk
    lines.append(current)
    return lines


def text_piece(
    res: Resources,
    doc: DocCache,
    text: str,
    style: TextStyle,
    *,
    width: float | None = None,
    warn: WarnFn | None = None,
) -> Piece:
    """A text box: lines are wrapped to ``width`` when given, aligned inside the box."""
    if style.font_size <= 0 or style.line_height <= 0:
        raise invalid_params("font size and line height must be positive")
    text = unicodedata.normalize("NFC", text)
    codepoints = {ord(ch) for ch in text}
    font = doc.font(style.font_family, style.bold, codepoints)
    if warn is not None:
        for cp in sorted(codepoints):
            if not font.supports(cp) and chr(cp) not in MISSING_GLYPH_CONTROL:
                warn(f"Font {style.font_family} has no glyph for U+{cp:04X}; it was skipped.")
    size = style.font_size
    lines: list[str] = []
    for paragraph in text.replace("\r\n", "\n").split("\n"):
        if width is None:
            lines.append(paragraph)
        else:
            lines.extend(_wrap(paragraph, font, size, width))
    ascent = font.face.ascent * size
    descent = -font.face.descent * size
    pitch = size * style.line_height
    height = ascent + (len(lines) - 1) * pitch + descent
    widths = [font.width(line, size) for line in lines]
    box_width = width if width is not None else max(max(widths, default=0.0), 1.0)
    font_name = res.add("Font", font.obj)
    parts = [
        "q",
        "BT",
        f"/{font_name} {number(size)} Tf",
        f"{_rgb(style.color)} rg",
    ]
    for i, line in enumerate(lines):
        glyphs = font.hex_for(line)
        if not glyphs:
            continue
        if style.align == "center":
            x = (box_width - widths[i]) / 2
        elif style.align == "right":
            x = box_width - widths[i]
        else:
            x = 0.0
        y = height - ascent - i * pitch
        parts.append(f"1 0 0 1 {number(x)} {number(y)} Tm")
        parts.append(f"<{glyphs}> Tj")
    parts += ["ET", "Q"]
    return Piece(width=box_width, height=height, body="\n".join(parts))


def image_piece(
    res: Resources,
    doc: DocCache,
    raw: bytes,
    *,
    width: float | None = None,
    height: float | None = None,
) -> Piece:
    """An image box. Missing sides follow the aspect ratio; both given means fit inside."""
    handle = doc.image(raw)
    natural_w = handle.width_px * PX_TO_PT
    natural_h = handle.height_px * PX_TO_PT
    if width is None and height is None:
        width = DEFAULT_IMAGE_WIDTH
    if width is not None and height is not None:
        factor = min(width / natural_w, height / natural_h)
    elif width is not None:
        factor = width / natural_w
    else:
        assert height is not None
        factor = height / natural_h
    box_w, box_h = natural_w * factor, natural_h * factor
    name = res.add("XObject", handle.obj)
    body = f"q\n{number(box_w)} 0 0 {number(box_h)} 0 0 cm\n/{name} Do\nQ"
    return Piece(width=box_w, height=box_h, body=body)


def path_piece(
    res: Resources,
    points: list[tuple[float, float]],
    *,
    closed: bool = False,
    fill: Color | None = None,
    stroke: Color | None = None,
    line_width: float = 1.0,
) -> Piece:
    """A polyline or polygon in the box (points are relative to the bottom-left corner)."""
    if len(points) < 2:
        raise invalid_params("a path needs at least two points")
    if fill is None and stroke is None:
        raise invalid_params("a path needs a fill or a stroke colour")
    parts = ["q"]
    if fill is not None:
        parts.append(f"{_rgb(fill)} rg")
    if stroke is not None:
        parts.append(f"{_rgb(stroke)} RG {number(line_width)} w")
    x0, y0 = points[0]
    parts.append(f"{number(x0)} {number(y0)} m")
    for x, y in points[1:]:
        parts.append(f"{number(x)} {number(y)} l")
    if closed:
        parts.append("h")
    if fill is not None and stroke is not None:
        op = "b" if closed else "B"
    elif fill is not None:
        op = "f"
    else:
        op = "s" if closed else "S"
    parts += [op, "Q"]
    width = max(x for x, _ in points)
    height = max(y for _, y in points)
    return Piece(width=width, height=height, body="\n".join(parts))


def rect_piece(
    res: Resources,
    width: float,
    height: float,
    *,
    fill: Color | None = None,
    stroke: Color | None = None,
    line_width: float = 1.0,
) -> Piece:
    corners = [(0.0, 0.0), (width, 0.0), (width, height), (0.0, height)]
    return path_piece(res, corners, closed=True, fill=fill, stroke=stroke, line_width=line_width)


# -- forms: one object for many pages ----------------------------------------------------


def make_form(
    pdf: pikepdf.Pdf, body: str, bbox: tuple[float, float, float, float], res: Resources
) -> pikepdf.Object:
    form = pdf.make_stream(body.encode("ascii"))
    form.Type = Name.XObject
    form.Subtype = Name.Form
    form.BBox = Array(list(bbox))
    form.Resources = res.as_dictionary()
    return form


MAX_TILES_MESSAGE = "too many watermark copies: increase the spacing or the font size"


def tiled_body(
    piece: Piece,
    *,
    res: Resources,
    doc: DocCache,
    mode: Literal["center", "tiled"],
    spacing: float,
    rotation: float,
    opacity: float,
    extent: float,
) -> str:
    """Centred copies of ``piece`` in form space (origin at the page centre, y up).

    ``center`` draws one copy; ``tiled`` repeats it on a grid that covers ``extent`` in every
    direction, with ``spacing`` points between copies. Each copy is rotated about its own centre.
    """
    gs = ""
    if opacity < 1:
        gs = f"/{res.add('ExtGState', doc.gstate(opacity, 'Normal'))} gs\n"
    if mode == "center":
        centres = [(0.0, 0.0)]
    else:
        step_x = piece.width + spacing
        step_y = piece.height + spacing
        if step_x <= 0 or step_y <= 0:
            raise invalid_params("spacing must make room for the watermark")
        nx = math.ceil(extent / step_x)
        ny = math.ceil(extent / step_y)
        if (2 * nx + 1) * (2 * ny + 1) > MAX_TILES:
            raise invalid_params(MAX_TILES_MESSAGE)
        centres = [(i * step_x, j * step_y) for i in range(-nx, nx + 1) for j in range(-ny, ny + 1)]
    parts: list[str] = []
    for cx, cy in centres:
        matrix = mul(
            translate(-piece.width / 2, -piece.height / 2),
            mul(rotate(rotation), translate(cx, cy)),
        )
        parts.append(f"q\n{gs}{fmt(matrix)} cm\n{piece.body}\nQ")
    return "\n".join(parts)


def letterhead_matrix(
    source: PageFrame,
    target: PageFrame,
    scaling: Literal["none", "fit"],
) -> Affine:
    """Matrix from the user space of a source page to the user space of a target page."""
    src_w, src_h = source.display_size
    dst_w, dst_h = target.display_size
    if scaling == "fit":
        factor = min(dst_w / src_w, dst_h / src_h)
        shift_x = (dst_w - src_w * factor) / 2
        shift_y = (dst_h - src_h * factor) / 2
    else:
        factor, shift_x, shift_y = 1.0, 0.0, dst_h - src_h
    place = mul(scale(factor, factor), translate(shift_x, shift_y))
    return mul(mul(user_to_display(source), place), display_to_user(target))


def page_centre_matrix(frame: PageFrame) -> Affine:
    """Matrix that maps form space (origin at the page centre) to user space of the page."""
    width, height = frame.display_size
    return mul(translate(width / 2, height / 2), display_to_user(frame))


# -- the writer -------------------------------------------------------------------------


class OverlayWriter:
    """Adds the chunks of one overlay object (one Id, one Group) to the pages of a document.

    Call ``place`` or ``place_form`` for every page, then ``commit`` once: the registry entry
    (Id, Kind, Group, Pages, Label) is only written when at least one page was changed.
    """

    def __init__(
        self,
        pdf: pikepdf.Pdf,
        *,
        kind: str,
        group: str,
        label: str | None = None,
        warn: WarnFn | None = None,
    ) -> None:
        if kind not in KINDS:
            raise invalid_params(f"Unknown overlay kind: {kind}")
        self.pdf = pdf
        self.kind = kind
        self.group = group
        self.label = label
        self.overlay_id = uuid.uuid4().hex
        self.res = Resources(prefix=f"Chef{self.overlay_id[:8]}")
        self.doc = DocCache(pdf)
        self.warn: WarnFn = warn or (lambda _message: None)
        self._pages: set[int] = set()

    @property
    def pages(self) -> list[int]:
        return sorted(self._pages)

    # pieces (page independent)

    def text(self, text: str, style: TextStyle, *, width: float | None = None) -> Piece:
        return text_piece(self.res, self.doc, text, style, width=width, warn=self.warn)

    def image(
        self, raw: bytes, *, width: float | None = None, height: float | None = None
    ) -> Piece:
        return image_piece(self.res, self.doc, raw, width=width, height=height)

    def rect(
        self,
        width: float,
        height: float,
        *,
        fill: Color | None = None,
        stroke: Color | None = None,
        line_width: float = 1.0,
    ) -> Piece:
        return rect_piece(self.res, width, height, fill=fill, stroke=stroke, line_width=line_width)

    def path(
        self,
        points: list[tuple[float, float]],
        *,
        closed: bool = False,
        fill: Color | None = None,
        stroke: Color | None = None,
        line_width: float = 1.0,
    ) -> Piece:
        return path_piece(
            self.res, points, closed=closed, fill=fill, stroke=stroke, line_width=line_width
        )

    # placement

    def place(
        self, page_index: int, piece: Piece, placement: Placement, *, under: bool = False
    ) -> None:
        page = self.pdf.pages[page_index]
        frame = page_frame(page)
        matrix = placed_box_matrix(
            frame,
            x=placement.x,
            y=placement.y,
            anchor=placement.anchor,
            width=piece.width,
            height=piece.height,
            rotation=placement.rotation,
        )
        gs = ""
        if placement.opacity < 1 or placement.blend != "Normal":
            name = self.res.add("ExtGState", self.doc.gstate(placement.opacity, placement.blend))
            gs = f"/{name} gs\n"
        body = f"q\n{gs}{fmt(matrix)} cm\n{piece.body}\nQ"
        self._add_chunk(page_index, body, under)

    def place_form(
        self, page_index: int, form: pikepdf.Object, matrix: Affine, *, under: bool = False
    ) -> None:
        name = self.res.add("XObject", form)
        self._add_chunk(page_index, f"q\n{fmt(matrix)} cm\n/{name} Do\nQ", under)

    def _add_chunk(self, page_index: int, body: str, under: bool) -> None:
        page = self.pdf.pages[page_index]
        res = own_resources(page)
        for cat, items in self.res.entries.items():
            if not items:
                continue
            target = category(res, f"/{cat}")
            for name, obj in items.items():
                target[f"/{name}"] = obj
        block = overlay_block(
            overlay_id=self.overlay_id, group=self.group, kind=self.kind, body=body
        )
        raw = content_bytes(page)
        if f"/{TAG_WRAP}".encode() in raw:
            new = block.encode() + raw if under else raw + block.encode()
        else:
            wrapped = WRAP_BEGIN.encode() + raw + WRAP_END.encode()
            new = block.encode() + wrapped if under else wrapped + block.encode()
        set_content(self.pdf, page, new)
        self._pages.add(page_index)

    def commit(self) -> None:
        if not self._pages:
            return
        append_entry(
            self.pdf,
            overlay_id=self.overlay_id,
            kind=self.kind,
            group=self.group,
            pages=self.pages,
            label=self.label,
        )
