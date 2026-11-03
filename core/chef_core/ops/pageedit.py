"""Page editing (features C6-C10): replace pages, crop and resize, remove blank pages, split pages
into parts (halves or a grid), and split a document into files at smart boundaries.

Geometry works in *displayed* coordinates (after /Rotate) and maps them back to user space with
``display_to_user``, so margins, trims and grid pieces are right on rotated pages too.

- ``page.replace`` (C6): the given pages are removed and the pages of another file are inserted at
  their position (the counts may differ).
- ``page.crop`` (C7): sets CropBox or MediaBox from margins, an absolute box, or a trim to the
  content found by rendering (``autoTrim``).
- ``page.resize`` (C7): puts each page on A4 / A3 / Letter / custom, scaled to fit or centred. The
  old page is kept as a form XObject, so no content is lost.
- ``page.findBlank`` (C8, read-only): lists the blank candidates with the ink ratio used.
  ``page.removeBlank`` deletes them.
- ``page.split`` (C9): each page becomes rows x cols pieces (overlap optional) with different
  CropBoxes; reading order left-to-right or right-to-left (for books).
- ``file.splitSmart`` (C10, standalone): split at blank separator pages, at a bookmark level, or
  at pages whose text matches a pattern (e.g. "Chương"). It does not read QR codes.
"""

from __future__ import annotations

import itertools
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import pikepdf
import pypdfium2 as pdfium
from PIL import Image
from pydantic import Field, model_validator

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.ops.file import Part, _build_part, render_name
from chef_core.ops.page import _unshare_annotations, copy_pages
from chef_core.pdf.io import atomic_save, open_pdf
from chef_core.pdf.outline import Bookmark, read_bookmarks, remap_outline
from chef_core.pdf.pages import A4, check_indices, normalized_rotation, unique_sorted

MM = 72 / 25.4
Box = tuple[float, float, float, float]
PageScope = Literal["all", "odd", "even", "pages"]


# -- geometry -------------------------------------------------------------------------


def _box_of(page: pikepdf.Page, key: str) -> Box:
    raw = page.obj.get(key)
    if raw is None:
        raw = page.mediabox if key == "/MediaBox" else page.cropbox
    x0, y0, x1, y1 = (float(v) for v in raw)
    return min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)


def display_to_user(box: Box, rotation: int, dx: float, dy: float) -> tuple[float, float]:
    """Map a point (dx, dy) measured from the top-left of the *displayed* box to user space.

    The displayed box has the size of ``box`` turned by ``rotation`` (/Rotate, clockwise).
    """
    x0, y0, x1, y1 = box
    if rotation == 90:
        return x0 + dy, y0 + dx
    if rotation == 180:
        return x1 - dx, y0 + dy
    if rotation == 270:
        return x1 - dy, y1 - dx
    return x0 + dx, y1 - dy


def display_rect_to_user(box: Box, rotation: int, rect: tuple[float, float, float, float]) -> Box:
    """A rectangle in displayed coordinates (left, top, right, bottom) as a user-space box."""
    left, top, right, bottom = rect
    xa, ya = display_to_user(box, rotation, left, top)
    xb, yb = display_to_user(box, rotation, right, bottom)
    return min(xa, xb), min(ya, yb), max(xa, xb), max(ya, yb)


def _displayed_size(box: Box, rotation: int) -> tuple[float, float]:
    width, height = box[2] - box[0], box[3] - box[1]
    return (height, width) if rotation in (90, 270) else (width, height)


def _selection(scope: PageScope, pages: list[int] | None, count: int) -> list[int]:
    if scope == "pages":
        if not pages:
            raise invalid_params("pages is required for scope 'pages'", {"field": "pages"})
        return unique_sorted(check_indices(pages, count))
    if scope == "odd":
        return [i for i in range(count) if i % 2 == 0]  # 1st, 3rd... (1-based odd)
    if scope == "even":
        return [i for i in range(count) if i % 2 == 1]
    return list(range(count))


# -- rendering helpers ----------------------------------------------------------------


def _render_gray(doc: pdfium.PdfDocument, index: int, dpi: int) -> Image.Image:
    page = doc[index]
    try:
        bitmap = page.render(scale=dpi / 72, fill_color=(255, 255, 255, 255))
        try:
            gray: Image.Image = bitmap.to_pil().convert("L")
            return gray
        finally:
            bitmap.close()
    finally:
        page.close()


def _open_render(path: Path, password: str | None) -> pdfium.PdfDocument:
    return pdfium.PdfDocument(str(path), password=password)


def _has_text(doc: pdfium.PdfDocument, index: int) -> bool:
    page = doc[index]
    try:
        textpage = page.get_textpage()
        try:
            return bool(str(textpage.get_text_range()).strip())
        finally:
            textpage.close()
    finally:
        page.close()


def _ink_bbox(gray: Image.Image, threshold: int) -> tuple[int, int, int, int] | None:
    ink = gray.point(lambda v: 255 if v < threshold else 0)
    return ink.getbbox()


# -- blank analysis (C8, C10) ---------------------------------------------------------

BLANK_DPI = 40
DARK_LEVEL = 200  # pixels darker than this are ink; near-white scan noise is ignored


def blank_limit(sensitivity: float) -> float:
    """Largest ink ratio still counted as blank.

    10^-4.3 at sensitivity 0, 10^-3.3 at 0.5 (default), 10^-2.3 at 1.
    """
    return 10 ** (-4.3 + 2 * sensitivity)


@dataclass
class PageInfo:
    index: int
    ink_ratio: float
    has_text: bool
    has_annotations: bool
    blank: bool


def analyse_blank(
    path: Path,
    password: str | None,
    pages: list[int],
    *,
    sensitivity: float,
    border_mm: float,
    keep_if_annotations: bool,
) -> list[PageInfo]:
    limit = blank_limit(sensitivity)
    doc = _open_render(path, password)
    pdf = open_pdf(path, password)
    infos: list[PageInfo] = []
    try:
        for index in pages:
            gray = _render_gray(doc, index, BLANK_DPI)
            border = round(border_mm * MM / 72 * BLANK_DPI)
            w, h = gray.size
            inner = gray.crop((border, border, max(border, w - border), max(border, h - border)))
            total = max(1, inner.size[0] * inner.size[1])
            ink = sum(inner.histogram()[:DARK_LEVEL])
            text = _has_text(doc, index)
            annots = bool(pdf.pages[index].obj.get("/Annots"))
            blank = ink / total <= limit and not text
            if keep_if_annotations and annots:
                blank = False
            infos.append(PageInfo(index, ink / total, text, annots, blank))
    finally:
        doc.close()
        pdf.close()
    return infos


# -- page.replace (C6) ----------------------------------------------------------------


class PageReplaceParams(WireModel):
    """Replace the given pages with pages of another file (counts may differ)."""

    pages: list[int] = Field(min_length=1, description="0-based pages to replace.")
    path: str = Field(min_length=1, description="PDF to take the pages from.")
    password: str | None = Field(default=None)
    source_pages: list[int] | None = Field(
        default=None, min_length=1, description="0-based pages of that file; default all."
    )


@operation(
    id="page.replace",
    title="Replace pages",
    group="page",
    params=PageReplaceParams,
    destructive=True,
)
def replace(ctx: OpContext, p: PageReplaceParams) -> OpOutput:
    with ctx.open_input() as pdf, open_pdf(p.path, p.password) as src:
        targets = unique_sorted(check_indices(p.pages, len(pdf.pages)))
        sources = (
            list(range(len(src.pages)))
            if p.source_pages is None
            else check_indices(p.source_pages, len(src.pages), "sourcePages")
        )
        position = targets[0]
        bookmarks = read_bookmarks(pdf)
        for i in ctx.steps(sorted(targets, reverse=True), len(targets), "removing"):
            del pdf.pages[i]
        copy_pages(ctx, src, pdf, sources, keep_outline=False, at=position)
        remap_outline(pdf, bookmarks)
        ctx.save_document(pdf)
    return OpOutput()


# -- page.crop (C7) -------------------------------------------------------------------


class PageMargins(WireModel):
    top: float = Field(default=0, ge=0, le=2000, description="mm")
    bottom: float = Field(default=0, ge=0, le=2000, description="mm")
    left: float = Field(default=0, ge=0, le=2000, description="mm")
    right: float = Field(default=0, ge=0, le=2000, description="mm")


class PageCropParams(WireModel):
    """Set the page box of the selected pages. Give exactly one of margins, box or autoTrim."""

    scope: PageScope = Field(default="all")
    pages: list[int] | None = Field(default=None, description="For scope 'pages'.")
    mode: Literal["cropbox", "mediabox"] = Field(default="cropbox")
    margins: PageMargins | None = Field(
        default=None, description="Cut from the displayed page edges."
    )
    box: list[float] | None = Field(
        default=None, min_length=4, max_length=4, description="x0, y0, x1, y1 in points."
    )
    auto_trim: bool = Field(default=False, description="Cut the blank margins around content.")
    trim_padding_mm: float = Field(default=3, ge=0, le=100)
    trim_threshold: int = Field(default=240, ge=1, le=254, description="Pixels darker count.")
    trim_dpi: int = Field(default=50, ge=20, le=150)

    @model_validator(mode="after")
    def _one_method(self) -> PageCropParams:
        given = [self.margins is not None, self.box is not None, self.auto_trim]
        if sum(given) != 1:
            raise ValueError("give exactly one of margins, box or autoTrim")
        return self


@operation(
    id="page.crop",
    title="Crop pages",
    group="page",
    params=PageCropParams,
    destructive=True,
    batchable=True,
)
def crop(ctx: OpContext, p: PageCropParams) -> OpOutput:
    assert ctx.input_path is not None
    with ctx.open_input() as pdf:
        selected = _selection(p.scope, p.pages, len(pdf.pages))
        key = "/CropBox" if p.mode == "cropbox" else "/MediaBox"
        doc = _open_render(ctx.input_path, None) if p.auto_trim else None
        warned = False
        try:
            for index in ctx.steps(selected, len(selected), "cropping"):
                page = pdf.pages[index]
                box = _box_of(page, "/CropBox")
                rotation = normalized_rotation(page)
                width, height = _displayed_size(box, rotation)
                if p.margins is not None:
                    m = p.margins
                    rect = (
                        m.left * MM,
                        m.top * MM,
                        width - m.right * MM,
                        height - m.bottom * MM,
                    )
                elif p.box is not None:
                    new = (p.box[0], p.box[1], p.box[2], p.box[3])
                    user = (
                        min(new[0], new[2]),
                        min(new[1], new[3]),
                        max(new[0], new[2]),
                        max(new[1], new[3]),
                    )
                    if user[2] - user[0] <= 1 or user[3] - user[1] <= 1:
                        raise invalid_params(
                            "the box must be wider and taller than 1 pt", {"field": "box"}
                        )
                    _write_box(page, key, user)
                    continue
                else:
                    assert doc is not None
                    gray = _render_gray(doc, index, p.trim_dpi)
                    bbox = _ink_bbox(gray, p.trim_threshold)
                    if bbox is None:
                        if not warned:
                            ctx.warn("Some pages are blank; their box was not changed.")
                            warned = True
                        continue
                    scale_x = width / gray.size[0]
                    scale_y = height / gray.size[1]
                    pad = p.trim_padding_mm * MM
                    rect = (
                        max(0.0, bbox[0] * scale_x - pad),
                        max(0.0, bbox[1] * scale_y - pad),
                        min(width, bbox[2] * scale_x + pad),
                        min(height, bbox[3] * scale_y + pad),
                    )
                if rect[2] - rect[0] <= 1 or rect[3] - rect[1] <= 1:
                    raise invalid_params("the margins leave no page", {"field": "margins"})
                _write_box(page, key, display_rect_to_user(box, rotation, rect))
        finally:
            if doc is not None:
                doc.close()
        ctx.save_document(pdf)
    return OpOutput(changed_pages=selected)


def _write_box(page: pikepdf.Page, key: str, box: Box) -> None:
    page.obj[key] = pikepdf.Array([round(v, 4) for v in box])


# -- page.resize (C7) -----------------------------------------------------------------

SizeName = Literal["A3", "A4", "Letter", "custom"]
_STANDARD = {"A3": (842.0, 1191.0), "A4": A4, "Letter": (612.0, 792.0)}


class PageResizeParams(WireModel):
    """Put pages on a standard or custom size; the content is scaled to fit or centred."""

    scope: PageScope = Field(default="all")
    pages: list[int] | None = Field(default=None)
    size: SizeName = Field(default="A4")
    custom_width_mm: float | None = Field(default=None, gt=0, le=2000)
    custom_height_mm: float | None = Field(default=None, gt=0, le=2000)
    fit: Literal["scale", "center"] = Field(default="scale")

    @model_validator(mode="after")
    def _custom(self) -> PageResizeParams:
        if self.size == "custom" and (
            self.custom_width_mm is None or self.custom_height_mm is None
        ):
            raise ValueError("customWidthMm and customHeightMm are required for size 'custom'")
        return self


@operation(
    id="page.resize",
    title="Resize pages",
    group="page",
    params=PageResizeParams,
    destructive=True,
    batchable=True,
)
def resize(ctx: OpContext, p: PageResizeParams) -> OpOutput:
    if p.size == "custom":
        assert p.custom_width_mm is not None and p.custom_height_mm is not None
        target = (p.custom_width_mm * MM, p.custom_height_mm * MM)
    else:
        target = _STANDARD[p.size]
    with ctx.open_input() as pdf:
        selected = _selection(p.scope, p.pages, len(pdf.pages))
        for index in ctx.steps(selected, len(selected), "resizing"):
            _resize_page(pdf, pdf.pages[index], target, p.fit, ctx)
        ctx.save_document(pdf)
    return OpOutput(changed_pages=selected)


def _resize_page(
    pdf: pikepdf.Pdf, page: pikepdf.Page, target: tuple[float, float], fit: str, ctx: OpContext
) -> None:
    box = _box_of(page, "/CropBox")
    rotation = normalized_rotation(page)
    disp_w, disp_h = _displayed_size(box, rotation)
    tw, th = target
    if (disp_w > disp_h) != (tw > th):
        tw, th = th, tw  # the page's own orientation decides
    # The page keeps its /Rotate, so the user-space size is the displayed size turned back.
    uw, uh = (th, tw) if rotation in (90, 270) else (tw, th)
    w, h = box[2] - box[0], box[3] - box[1]
    scale = 1.0 if fit == "center" else min(uw / w, uh / h)
    tx = (uw - w * scale) / 2 - box[0] * scale
    ty = (uh - h * scale) / 2 - box[1] * scale
    if page.obj.get("/Annots"):
        ctx.warn("Annotations were not moved when the page was resized.")
    content = bytes(pikepdf.unparse_content_stream(list(pikepdf.parse_content_stream(page))))
    form = pdf.make_stream(content)
    form.Type = pikepdf.Name.XObject
    form.Subtype = pikepdf.Name.Form
    form.BBox = pikepdf.Array([*box])
    form.Resources = page.resources
    new_res = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Fm0=form))
    page.obj.Resources = new_res
    page.obj.Contents = pdf.make_stream(
        f"q {scale:.6f} 0 0 {scale:.6f} {tx:.4f} {ty:.4f} cm /Fm0 Do Q\n".encode("ascii")
    )
    page.obj.MediaBox = pikepdf.Array([0, 0, round(uw, 4), round(uh, 4)])
    page.obj.CropBox = pikepdf.Array([0, 0, round(uw, 4), round(uh, 4)])


# -- page.findBlank / page.removeBlank (C8) -------------------------------------------


class BlankParams(WireModel):
    pages: list[int] | None = Field(default=None, description="0-based; default all.")
    sensitivity: float = Field(
        default=0.5, ge=0, le=1, description="0 = only pure blank; 1 = tolerant of specks."
    )
    border_mm: float = Field(default=5, ge=0, le=50, description="Border ignored (edge marks).")
    keep_if_annotations: bool = Field(default=True, description="Pages with annotations stay.")


def _blank_request(ctx: OpContext, p: BlankParams) -> list[PageInfo]:
    assert ctx.input_path is not None
    with open_pdf(ctx.input_path) as pdf:
        count = len(pdf.pages)
    pages = list(range(count)) if p.pages is None else unique_sorted(check_indices(p.pages, count))
    return analyse_blank(
        ctx.input_path,
        None,
        pages,
        sensitivity=p.sensitivity,
        border_mm=p.border_mm,
        keep_if_annotations=p.keep_if_annotations,
    )


def _info_row(info: PageInfo) -> dict[str, object]:
    return {
        "index": info.index,
        "inkRatio": round(info.ink_ratio, 6),
        "hasText": info.has_text,
        "hasAnnotations": info.has_annotations,
        "blank": info.blank,
    }


@operation(id="page.findBlank", title="Find blank pages", group="page", params=BlankParams)
def find_blank(ctx: OpContext, p: BlankParams) -> OpOutput:
    rows = [_info_row(i) for i in _blank_request(ctx, p)]
    candidates = [r["index"] for r in rows if r["blank"]]
    return OpOutput(changed_pages=[], data={"pages": rows, "candidates": candidates})


@operation(
    id="page.removeBlank",
    title="Remove blank pages",
    group="page",
    params=BlankParams,
    destructive=True,
)
def remove_blank(ctx: OpContext, p: BlankParams) -> OpOutput:
    infos = _blank_request(ctx, p)
    doomed = [i.index for i in infos if i.blank]
    with ctx.open_input() as pdf:
        if len(doomed) >= len(pdf.pages):
            raise ChefError(
                ErrorKind.INVALID_PARAMS,
                "Every page is blank; nothing was removed",
                {"field": "pages"},
            )
        bookmarks = read_bookmarks(pdf)
        for i in sorted(doomed, reverse=True):
            ctx.check_cancelled()
            del pdf.pages[i]
        remap_outline(pdf, bookmarks)
        if doomed:
            ctx.save_document(pdf)
    return OpOutput(changed_pages=[] if not doomed else "all", data={"removed": doomed})


# -- page.split (C9) ------------------------------------------------------------------


class PageSplitParams(WireModel):
    """Split each selected page into rows x cols pieces, each with its own CropBox."""

    pages: list[int] | None = Field(default=None, min_length=1, description="0-based; default all.")
    rows: int = Field(default=1, ge=1, le=10)
    cols: int = Field(default=2, ge=1, le=10)
    overlap_mm: float = Field(default=0, ge=0, le=50, description="Overlap between pieces.")
    order: Literal["ltr", "rtl"] = Field(
        default="ltr", description="Reading order of the pieces; rtl for right-to-left books."
    )

    @model_validator(mode="after")
    def _at_least_two(self) -> PageSplitParams:
        if self.rows * self.cols < 2:
            raise ValueError("rows x cols must be at least 2")
        return self


def piece_boxes(
    box: Box, rotation: int, rows: int, cols: int, overlap_pt: float, order: str
) -> list[Box]:
    """User-space boxes of the pieces, in reading order."""
    width, height = _displayed_size(box, rotation)
    half = overlap_pt / 2
    keyed: list[tuple[int, int, Box]] = []
    for r in range(rows):
        for c in range(cols):
            left = max(0.0, c * width / cols - half)
            right = min(width, (c + 1) * width / cols + half)
            top = max(0.0, r * height / rows - half)
            bottom = min(height, (r + 1) * height / rows + half)
            keyed.append((r, c, display_rect_to_user(box, rotation, (left, top, right, bottom))))
    if order == "rtl":
        keyed.sort(key=lambda t: (t[0], -t[1]))
    else:
        keyed.sort(key=lambda t: (t[0], t[1]))
    return [b for _, _, b in keyed]


@operation(
    id="page.split",
    title="Split pages",
    group="page",
    params=PageSplitParams,
    destructive=True,
)
def split_pages(ctx: OpContext, p: PageSplitParams) -> OpOutput:
    with ctx.open_input() as pdf:
        count = len(pdf.pages)
        selected = unique_sorted(check_indices(p.pages, count)) if p.pages else list(range(count))
        n = p.rows * p.cols
        overlap = p.overlap_mm * MM
        # From the back, so the indices of the pages still to do stay valid.
        for index in ctx.steps(sorted(selected, reverse=True), len(selected), "splitting"):
            page = pdf.pages[index]
            box = _box_of(page, "/CropBox")
            rotation = normalized_rotation(page)
            boxes = piece_boxes(box, rotation, p.rows, p.cols, overlap, p.order)
            for k in range(1, n):
                pdf.pages.insert(index + k, pdf.pages[index])
                _unshare_annotations(pdf, pdf.pages[index + k])
            for k, piece in enumerate(boxes):
                _write_box(pdf.pages[index + k], "/CropBox", piece)
        ctx.save_document(pdf)
    return OpOutput(changed_pages="all")


# -- file.splitSmart (C10) ------------------------------------------------------------

SmartMode = Literal["blank", "bookmarkLevel", "pattern"]


class SplitSmartParams(WireModel):
    """Split one document into files at smart boundaries."""

    path: str = Field(min_length=1, description="PDF to split.")
    password: str | None = Field(default=None)
    mode: SmartMode
    level: int = Field(default=1, ge=1, le=10, description="bookmarkLevel: 1 = top level.")
    pattern: str | None = Field(default=None, description="pattern: regular expression.")
    ignore_case: bool = Field(default=True)
    drop_separator_pages: bool = Field(
        default=False,
        description="blank: leave the blank separator pages out of the files.",
    )
    blank_sensitivity: float = Field(default=0.5, ge=0, le=1)
    output_dir: str = Field(min_length=1)
    name_template: str = Field(default="{name}_{index}", min_length=1)

    @model_validator(mode="after")
    def _pattern_needed(self) -> SplitSmartParams:
        if self.mode == "pattern":
            if not self.pattern:
                raise ValueError("pattern is required for mode 'pattern'")
            try:
                re.compile(self.pattern)
            except re.error as exc:
                raise ValueError(f"invalid regular expression: {exc}") from exc
        return self


def _bookmark_pages(
    items: list[Bookmark], level: int, index: dict[tuple[int, int], int]
) -> set[int]:
    found: set[int] = set()
    stack: list[tuple[Bookmark, int]] = [(bm, 1) for bm in items]
    while stack:
        bm, depth = stack.pop()
        if depth == level and bm.page is not None and bm.page in index:
            found.add(index[bm.page])
        stack.extend((child, depth + 1) for child in bm.children)
    return found


def _parts_from_starts(starts: set[int], count: int) -> list[Part]:
    ordered = sorted(starts)
    if not ordered or ordered[0] != 0:
        ordered.insert(0, 0)
    bounds = [*ordered, count]
    return [Part(list(range(a, b))) for a, b in itertools.pairwise(bounds) if b > a]


def _parts_at_blanks(infos: list[PageInfo], drop: bool) -> list[Part]:
    parts: list[Part] = []
    current: list[int] = []
    for info in infos:
        if info.blank:
            if not drop:
                current.append(info.index)
            if current:
                parts.append(Part(current))
            current = []
            continue
        current.append(info.index)
    if current:
        parts.append(Part(current))
    return parts


@operation(
    id="file.splitSmart",
    title="Split file at boundaries",
    group="file",
    params=SplitSmartParams,
    standalone=True,
)
def split_smart(ctx: OpContext, p: SplitSmartParams) -> OpOutput:
    src_path = Path(p.path).expanduser().absolute()
    out_dir = Path(p.output_dir).expanduser().absolute()
    if out_dir.exists() and not out_dir.is_dir():
        raise invalid_params("outputDir is not a directory", {"field": "outputDir"})
    src = open_pdf(src_path, p.password)
    try:
        count = len(src.pages)
        if count == 0:
            raise invalid_params("The document has no pages")
        if p.mode == "bookmarkLevel":
            index = {page.obj.objgen: i for i, page in enumerate(src.pages)}
            starts = _bookmark_pages(read_bookmarks(src), p.level, index)
            parts = _parts_from_starts(starts, count)
            if not starts:
                ctx.warn("No bookmarks at that level; the document was not split.")
        elif p.mode == "pattern":
            assert p.pattern is not None
            flags = re.IGNORECASE if p.ignore_case else 0
            rx = re.compile(p.pattern, flags)
            doc = _open_render(src_path, p.password)
            try:
                starts = {i for i in range(count) if rx.search(_page_text(doc, i))}
            finally:
                doc.close()
            if not starts:
                ctx.warn("The pattern was not found; the document was not split.")
            parts = _parts_from_starts(starts, count)
        else:
            infos = analyse_blank(
                src_path,
                p.password,
                list(range(count)),
                sensitivity=p.blank_sensitivity,
                border_mm=5,
                keep_if_annotations=True,
            )
            parts = _parts_at_blanks(infos, p.drop_separator_pages)
            if not any(i.blank for i in infos):
                ctx.warn("No blank separator pages were found; the document was not split.")
        if not parts:
            raise invalid_params("Nothing to write: every page was dropped")
        out_dir.mkdir(parents=True, exist_ok=True)
        total = len(parts)
        names: list[str] = []
        for number, part in enumerate(parts, start=1):
            name = render_name(
                p.name_template, name=src_path.stem, index=number, total=total, part=part
            )
            if name in names:
                name = f"{name[:-4]}_{str(number).zfill(len(str(total)))}.pdf"
            names.append(name)
        outputs: list[str] = []
        for part, name in ctx.steps(list(zip(parts, names, strict=True)), total, "writing"):
            target = out_dir / name
            with _build_part(src, part.pages, ctx) as dst:
                atomic_save(dst, target)
            outputs.append(str(target))
    finally:
        src.close()
    return OpOutput(changed_pages=[], outputs=outputs, data={"parts": total})


def _page_text(doc: pdfium.PdfDocument, index: int) -> str:
    page = doc[index]
    try:
        textpage = page.get_textpage()
        try:
            return str(textpage.get_text_range())
        finally:
            textpage.close()
    finally:
        page.close()
