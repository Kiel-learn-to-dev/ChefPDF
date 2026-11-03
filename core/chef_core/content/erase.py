"""Cutting regions out of a page's content (T6.03; shared with redaction T6.07).

``cut_page`` plans the removal of everything painted inside one or more rectangles (page user
space) on one page, through the content engine's ``PageEditor``:

- text: a glyph whose centre lies in a rectangle is removed from its TJ array. The advance of a
  removed glyph stays as a kerning number, so the text after it does not move. A run whose
  glyphs are all removed becomes an advance-only TJ. ``'`` and ``"`` are rewritten as T* + TJ.
- images: the pixels inside the rectangles are made transparent (new SMask), white, or painted
  with a colour. The result is a new image XObject used by this placement only. Inline images
  become XObjects. An image wholly inside a rectangle is deleted.
- vectors and shadings: the object is wrapped in ``q`` ... ``Q`` with even-odd clips that exclude
  each rectangle from the page box. A path that sets its own clip (W) inside its range is not
  cut (reported as skipped).
- an object wholly inside a rectangle is deleted.

``partial=False`` only touches objects that lie completely inside a rectangle; partly covered
objects are left alone and reported.

``paint_rects`` paints filled rectangles at the end of the page content (redaction boxes,
covers). ``sample_background`` reads the colour around a rectangle from a render.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

import pikepdf
import pypdfium2 as pdfium
from pikepdf import Array, Dictionary, Name
from PIL import Image, ImageChops, ImageDraw

from chef_core.content.editor import PageEditor
from chef_core.content.engine import apply, build_model, inverse
from chef_core.content.fonts import APPROX_WIDTH, FontInfo
from chef_core.content.model import Ins, PageObject, Rect
from chef_core.ops.content_image import _decode, _new_xobject, _register
from chef_core.pdf.content import mul
from chef_core.signing.anchors import PageFrame

ImageFill = Literal["transparent", "white", "color"]
EPS = 1e-6
_FILL_KEY = (-9,)


@dataclass(frozen=True)
class CutOptions:
    text: bool = True
    images: bool = True
    vectors: bool = True
    partial: bool = True
    image_fill: ImageFill = "transparent"
    colour: tuple[int, int, int] = (0, 0, 0)  # used by image_fill == "color"
    secure_image_sources: bool = False  # redaction must prove source bytes have no other refs


@dataclass
class CutStats:
    removed: int = 0  # objects deleted outright
    split: int = 0  # text runs with some glyphs removed
    images: int = 0  # image placements whose pixels were cut
    clipped: int = 0  # vector objects wrapped in an exclusion clip
    skipped: list[str] = field(default_factory=list)  # "<id>: <reason>"

    def add(self, other: CutStats) -> None:
        self.removed += other.removed
        self.split += other.split
        self.images += other.images
        self.clipped += other.clipped
        self.skipped.extend(other.skipped)


# -- geometry -----------------------------------------------------------------------------


def rect_user_from_display(frame: PageFrame, rect: Sequence[float]) -> Rect:
    """A rectangle in the displayed frame (points, origin top-left) as page user space."""
    x0, y0, x1, y1 = (float(v) for v in rect)
    height = frame.display_size[1]
    ax, ay = frame.rect_from_display((x0, height - y0, x0, height - y0))[:2]
    bx, by = frame.rect_from_display((x1, height - y1, x1, height - y1))[:2]
    return (min(ax, bx), min(ay, by), max(ax, bx), max(ay, by))


def rect_display_from_user(frame: PageFrame, rect: Rect) -> tuple[float, float, float, float]:
    """A user-space rectangle as the displayed frame (points, origin top-left, y down)."""
    x0, y0, x1, y1 = frame.rect_to_display(rect)
    height = frame.display_size[1]
    return (x0, height - y1, x1, height - y0)


def _corners(r: Rect) -> list[tuple[float, float]]:
    return [(r[0], r[1]), (r[2], r[1]), (r[2], r[3]), (r[0], r[3])]


def _inside(box: Rect, r: Rect) -> bool:
    return (
        box[0] >= r[0] - EPS
        and box[1] >= r[1] - EPS
        and box[2] <= r[2] + EPS
        and box[3] <= r[3] + EPS
    )


def _overlaps(box: Rect, r: Rect) -> bool:
    return box[0] < r[2] and box[2] > r[0] and box[1] < r[3] and box[3] > r[1]


def _point_in(r: Rect, x: float, y: float) -> bool:
    return r[0] <= x <= r[2] and r[1] <= y <= r[3]


# -- text -----------------------------------------------------------------------------------


@dataclass
class _Tok:
    chunk: bytes = b""  # glyph bytes (glyph tokens)
    adv: float = 0.0  # advance in displayed units (th applied)
    centre: tuple[float, float] = (0.0, 0.0)  # user-space centre of the glyph
    value: float | None = None  # kerning number (adjustment tokens)
    gone: bool = False


def _font_for(res: Any, name: str | None, cache: dict[str, FontInfo | None]) -> FontInfo | None:
    if name is None:
        return None
    if name not in cache:
        fonts = res.get("/Font") if isinstance(res, Dictionary) else None
        fd = fonts.get(name) if isinstance(fonts, Dictionary) else None
        cache[name] = FontInfo(fd) if isinstance(fd, Dictionary) else None
    return cache[name]


def _chunks(font: FontInfo | None, data: bytes) -> list[bytes]:
    if font is not None and font.is_cid:
        return [data[i : i + 2] for i in range(0, len(data), 2)]
    return [bytes([b]) for b in data]


def _text_tokens(obj: PageObject, items: list[Any], font: FontInfo | None) -> list[_Tok]:
    """Glyphs and kerning numbers of one text run, with the same advances as the engine."""
    tfs, th, tc, tw, ts = obj.font_size, obj.th, obj.tc, obj.tw, obj.ts
    asc = (font.ascent if font is not None else 800.0) / 1000
    desc = (font.descent if font is not None else -200.0) / 1000
    ymid = ts + (asc + desc) / 2 * tfs
    m = mul(obj.tm, obj.ctm)
    pos = 0.0
    toks: list[_Tok] = []
    for item in items:
        if isinstance(item, pikepdf.String):
            data = bytes(item)
            codes = font.codes(data) if font is not None else list(data)
            for code, chunk in zip(codes, _chunks(font, data), strict=False):
                width = (font.width(code) if font is not None else APPROX_WIDTH) / 1000
                space = tw if (font is None or not font.is_cid) and code == 32 else 0.0
                adv = (width * tfs + tc + space) * th
                cx, cy = apply(m, pos + adv / 2, ymid)
                toks.append(_Tok(chunk=chunk, adv=adv, centre=(cx, cy)))
                pos += adv
        else:
            try:
                value = float(item)
            except (TypeError, ValueError):
                continue
            toks.append(_Tok(value=value))
            pos += -value / 1000 * tfs * th
    return toks


def _rewrite_text(node: Ins, toks: list[_Tok], obj: PageObject) -> list[Ins]:
    """The instructions that replace one text-showing operator."""
    out: list[Any] = []
    cur = bytearray()
    for tok in toks:
        if tok.value is not None:
            if cur:
                out.append(pikepdf.String(bytes(cur)))
                cur = bytearray()
            out.append(tok.value)
        elif tok.gone:
            if cur:
                out.append(pikepdf.String(bytes(cur)))
                cur = bytearray()
            out.append(-tok.adv * 1000 / (obj.font_size * obj.th))
        else:
            cur += tok.chunk
    if cur:
        out.append(pikepdf.String(bytes(cur)))
    tj = Ins([Array(out)], "TJ", node.key)
    if node.op == "'":
        return [Ins([], "T*", node.key), tj]
    if node.op == '"':
        return [
            Ins([node.operands[0]], "Tw", node.key),
            Ins([node.operands[1]], "Tc", node.key),
            Ins([], "T*", node.key),
            tj,
        ]
    return [tj]


def _cut_text(
    editor: PageEditor,
    obj: PageObject,
    regions: list[Rect],
    opts: CutOptions,
    res: Any,
    fonts: dict[str, FontInfo | None],
    stats: CutStats,
) -> None:
    node = editor.model.nodes[obj.start]
    if node.op not in ("Tj", "TJ", "'", '"') or obj.font_size * obj.th == 0:
        stats.skipped.append(f"{obj.id}: text operator not supported")
        return
    if node.op == "TJ":
        items = list(node.operands[0]) if node.operands else []
    elif node.op == '"':
        items = [node.operands[2]]
    else:
        items = [node.operands[0]] if node.operands else []
    toks = _text_tokens(obj, items, _font_for(res, obj.font, fonts))
    glyphs = [t for t in toks if t.chunk]
    if not glyphs:
        return
    for tok in glyphs:
        tok.gone = any(_point_in(r, *tok.centre) for r in regions)
    gone = sum(1 for t in glyphs if t.gone)
    if gone == 0:
        return
    if not opts.partial and gone != len(glyphs):
        stats.skipped.append(f"{obj.id}: partly inside, not cut (partial off)")
        return
    if gone == len(glyphs):
        stats.removed += 1
    else:
        stats.split += 1
    editor.replace[obj.start] = _rewrite_text(node, toks, obj)


# -- images ---------------------------------------------------------------------------------


def _image_mask(size: tuple[int, int], ctm: Any, regions: list[Rect]) -> Image.Image | None:
    width, height = size
    inv = inverse(ctm)
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    for r in regions:
        pts = []
        for x, y in _corners(r):
            u, v = apply(inv, x, y)
            pts.append((u * width, (1 - v) * height))
        draw.polygon(pts, fill=255)
    return mask if mask.getbbox() is not None else None


def _image_placement_count(model: Any, target: pikepdf.Stream) -> int:
    """Count paint placements of an image on this flattened page model.

    Redaction writes a private replacement for one placement. If the source is shared, the
    original bytes remain reachable through the other placement and can still be extracted.
    Structural reference counting separately detects references from other pages/resources.
    """
    target_id = target.objgen
    count = 0
    xobjects = model.res.get("/XObject")
    if not isinstance(xobjects, Dictionary):
        return count
    for obj in model.objects:
        if obj.kind != "image" or obj.image_name is None:
            continue
        stream = xobjects.get(Name(obj.image_name))
        if isinstance(stream, pikepdf.Stream) and stream.objgen == target_id:
            count += 1
            if count > 1:
                return count
    return count


def _image_reference_count(pdf: pikepdf.Pdf, target: pikepdf.Stream) -> int:
    """Count structural references to an image, including unused resources and appearances."""
    target_id = target.objgen
    count = 0

    def visit(value: Any) -> None:
        nonlocal count
        children: Iterable[tuple[Any, Any]]
        if isinstance(value, (pikepdf.Stream, Dictionary)):
            children = value.items()
        elif isinstance(value, Array):
            children = enumerate(value)
        else:
            return
        for _key, child in children:
            if isinstance(child, pikepdf.Stream) and child.objgen == target_id:
                count += 1
            elif isinstance(child, (pikepdf.Stream, Dictionary, Array)) and child.objgen == (0, 0):
                visit(child)

    for obj in pdf.objects:
        if obj.objgen != target_id:
            visit(obj)
    return count


def _image_source(editor: PageEditor, obj: PageObject) -> pikepdf.Stream | None:
    table = editor.res.get("/XObject")
    if obj.image_name is None or table is None or Name(obj.image_name) not in table:
        return None
    stream = table[Name(obj.image_name)]
    return stream if isinstance(stream, pikepdf.Stream) else None


def _image_source_private(pdf: pikepdf.Pdf, model: Any, stream: pikepdf.Stream) -> bool:
    return _image_placement_count(model, stream) <= 1 and _image_reference_count(pdf, stream) == 1


def _cut_image(
    pdf: pikepdf.Pdf,
    editor: PageEditor,
    obj: PageObject,
    regions: list[Rect],
    opts: CutOptions,
) -> bool:
    node = editor.model.nodes[obj.start]
    alpha: Image.Image | None = None
    if obj.inline:
        inline = node.operands[0]
        img = inline.as_pil_image()
        img = img.convert("L" if img.mode in ("L", "1") else "RGB")
    else:
        table = editor.res.get("/XObject")
        if obj.image_name is None or table is None or Name(obj.image_name) not in table:
            return False
        stream = table[Name(obj.image_name)]
        if not isinstance(stream, pikepdf.Stream):
            return False
        if opts.secure_image_sources and not _image_source_private(pdf, editor.model, stream):
            # Refuse the whole redaction: the source image would remain extractable from its
            # other placement even though this placement received a sanitized replacement.
            return False
        img, alpha = _decode(stream)
    try:
        mask = _image_mask(img.size, obj.ctm, regions)
    except ValueError:
        return False
    if mask is None:
        return False
    base = alpha if alpha is not None else Image.new("L", img.size, 255)
    if opts.image_fill == "transparent":
        new_alpha: Image.Image | None = ImageChops.multiply(base, ImageChops.invert(mask))
        pixels = img
    else:
        rgb = (255, 255, 255) if opts.image_fill == "white" else opts.colour
        value: Any = rgb
        if img.mode == "L":
            value = round(0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2])
        pixels = img.copy()
        pixels.paste(value, mask=mask)
        new_alpha = ImageChops.lighter(base, mask) if alpha is not None else None
    name = _register(editor, _new_xobject(pdf, pixels, new_alpha, None))
    editor.replace_object(obj, [Ins([name], "Do", obj.key)])
    if obj.image_name:
        editor.drop_candidates.add(obj.image_name)
    return True


# -- vectors --------------------------------------------------------------------------------


def _clip_wrap(editor: PageEditor, obj: PageObject, regions: list[Rect]) -> bool:
    """Wrap the object in clips that exclude each region (even-odd, page box minus region)."""
    nodes = editor.model.nodes
    if any(nodes[i].op in ("W", "W*") for i in range(obj.start, obj.end + 1)):
        return False
    try:
        inv = inverse(obj.ctm)
    except ValueError:
        return False
    frame = editor.model.frame
    page_box: Rect = (frame.x0, frame.y0, frame.x1, frame.y1)
    key = obj.key
    ops: list[Ins] = [Ins([], "q", key)]
    for region in regions:
        for poly in (_corners(page_box), _corners(region)):
            pts = [apply(inv, x, y) for x, y in poly]
            ops.append(Ins([pts[0][0], pts[0][1]], "m", key))
            ops += [Ins([x, y], "l", key) for x, y in pts[1:]]
            ops.append(Ins([], "h", key))
        ops += [Ins([], "W*", key), Ins([], "n", key)]
    editor._add(editor.ins_at, obj.start, ops)
    editor._add(editor.ins_at, obj.end + 1, [Ins([], "Q", key)])
    return True


# -- the page --------------------------------------------------------------------------------


def _wanted(obj: PageObject, opts: CutOptions) -> bool:
    if obj.kind == "text":
        return opts.text
    if obj.kind == "image":
        return opts.images
    return obj.kind in ("path", "shading") and opts.vectors


def cut_page(
    pdf: pikepdf.Pdf,
    page: pikepdf.Page,
    page_index: int,
    regions: list[Rect],
    opts: CutOptions,
    *,
    flatten: bool = False,
) -> tuple[PageEditor, CutStats]:
    """Plan the cut of ``regions`` (user space) on one page. Nothing is written here: the caller
    calls ``editor.write()`` when ``editor.changed()``. ``flatten`` inlines the page's forms even
    when no form is hit (redaction always does: it also drops ActualText spans)."""
    base = build_model(pdf, page, page_index)
    hit = [o for o in base.objects if any(_overlaps(o.bbox, r) for r in regions)]
    needs_flat = flatten or any(o.kind == "form" or o.parent_id is not None for o in hit)
    model = build_model(pdf, page, page_index, flatten=True) if needs_flat else base
    editor = PageEditor(pdf, page, model)
    stats = CutStats()
    fonts: dict[str, FontInfo | None] = {}
    for obj in model.objects:
        if not obj.in_page or not _wanted(obj, opts):
            continue
        if not any(_overlaps(obj.bbox, r) for r in regions):
            continue
        if obj.kind == "text":
            _cut_text(editor, obj, regions, opts, model.res, fonts, stats)
            continue
        inside = any(_inside(obj.bbox, r) for r in regions)
        if not inside and not opts.partial:
            stats.skipped.append(f"{obj.id}: partly inside, not cut (partial off)")
            continue
        if inside:
            if obj.kind == "image" and opts.secure_image_sources and not obj.inline:
                source = _image_source(editor, obj)
                if (
                    obj.image_name is None
                    or source is None
                    or not _image_source_private(pdf, editor.model, source)
                ):
                    stats.skipped.append(f"{obj.id}: image source is shared")
                    continue
                editor.drop_candidates.add(obj.image_name)
            editor._remove(obj)
            stats.removed += 1
        elif obj.kind == "image":
            if _cut_image(pdf, editor, obj, regions, opts):
                stats.images += 1
            else:
                stats.skipped.append(f"{obj.id}: image not readable")
        elif _clip_wrap(editor, obj, regions):
            stats.clipped += 1
        else:
            stats.skipped.append(f"{obj.id}: clipped vector object not cut")
    return editor, stats


def paint_rects(
    editor: PageEditor,
    rects: Sequence[Rect],
    rgb: tuple[float, float, float],
    *,
    bottom: bool = False,
) -> None:
    """Paint filled rectangles on top of the page (or under everything with ``bottom``)."""
    clean = [p for p in range(editor.n + 1) if editor.model.clean_at[p]]
    pos = 0 if bottom else (clean[-1] if clean else editor.n)
    r, g, b = rgb
    ops: list[Ins] = [Ins([], "q", _FILL_KEY), Ins([r, g, b], "rg", _FILL_KEY)]
    for x0, y0, x1, y1 in rects:
        ops.append(Ins([x0, y0, x1 - x0, y1 - y0], "re", _FILL_KEY))
        ops.append(Ins([], "f", _FILL_KEY))
    ops.append(Ins([], "Q", _FILL_KEY))
    editor._add(editor.ins_at, pos, ops)


def sample_background(
    path: str, page_index: int, rect: tuple[float, float, float, float]
) -> tuple[int, int, int]:
    """Median colour of a ring of pixels around a display rectangle (points, top-left origin)."""
    doc = pdfium.PdfDocument(path)
    try:
        page = doc[page_index]
        try:
            img = page.render(scale=1.0).to_pil().convert("RGB")
        finally:
            page.close()
    finally:
        doc.close()
    x0, y0, x1, y1 = (int(v) for v in rect)
    pad = 6
    samples: list[tuple[int, int, int]] = []
    width, height = img.size
    for yy in range(max(0, y0 - pad), min(height, y1 + pad)):
        for xx in range(max(0, x0 - pad), min(width, x1 + pad)):
            if x0 <= xx < x1 and y0 <= yy < y1:
                continue
            samples.append(img.getpixel((xx, yy)))
    if not samples:
        return (255, 255, 255)
    med = []
    for channel in range(3):
        values = sorted(s[channel] for s in samples)
        med.append(values[len(values) // 2])
    return (med[0], med[1], med[2])


__all__ = [
    "CutOptions",
    "CutStats",
    "cut_page",
    "paint_rects",
    "rect_display_from_user",
    "rect_user_from_display",
    "sample_background",
]
