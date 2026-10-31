"""Page operations (features C2, C3): rotate, delete, duplicate, reorder, extract, insert."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Literal

import pikepdf
from pydantic import Field

from chef_core.errors import invalid_params
from chef_core.imaging.images import PageSize, decode_data_url, image_pages, read_image_file
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.pdf.io import atomic_save, open_pdf
from chef_core.pdf.outline import build_items, read_bookmarks, remap_outline
from chef_core.pdf.pages import (
    A4,
    check_indices,
    display_size,
    make_blank_page,
    replace_page_order,
    unique_sorted,
)

PageIndex = Annotated[int, Field(ge=0)]
PageList = Annotated[list[PageIndex], Field(min_length=1)]
Points = Annotated[float, Field(gt=0, le=14400)]


# -- page.rotate ----------------------------------------------------------------------


class PageRotateParams(WireModel):
    """Rotate pages clockwise, relative to their current rotation."""

    pages: PageList = Field(description="0-based page indices.")
    angle: Literal[90, 180, 270] = Field(description="Clockwise rotation in degrees.")


@operation(
    id="page.rotate",
    title="Rotate pages",
    group="page",
    params=PageRotateParams,
    destructive=True,
    batchable=True,
)
def rotate(ctx: OpContext, p: PageRotateParams) -> OpOutput:
    with ctx.open_input() as pdf:
        pages = unique_sorted(check_indices(p.pages, len(pdf.pages)))
        for i in ctx.steps(pages, len(pages)):
            pdf.pages[i].rotate(p.angle, relative=True)
        ctx.save_document(pdf)
    return OpOutput(changed_pages=pages)


# -- page.delete ----------------------------------------------------------------------


class PageDeleteParams(WireModel):
    """Delete pages. Deleting every page is not allowed."""

    pages: PageList = Field(description="0-based page indices.")


@operation(
    id="page.delete",
    title="Delete pages",
    group="page",
    params=PageDeleteParams,
    destructive=True,
    batchable=True,
)
def delete(ctx: OpContext, p: PageDeleteParams) -> OpOutput:
    with ctx.open_input() as pdf:
        count = len(pdf.pages)
        doomed = set(check_indices(p.pages, count))
        if len(doomed) >= count:
            raise invalid_params("Cannot delete all pages", {"field": "pages"})
        bookmarks = read_bookmarks(pdf)
        for i in sorted(doomed, reverse=True):
            ctx.check_cancelled()
            del pdf.pages[i]
        remap_outline(pdf, bookmarks)
        ctx.save_document(pdf)
    return OpOutput()


# -- page.duplicate -------------------------------------------------------------------


class PageDuplicateParams(WireModel):
    """Duplicate pages; each copy is inserted right after its source page."""

    pages: PageList = Field(description="0-based page indices.")


@operation(
    id="page.duplicate",
    title="Duplicate pages",
    group="page",
    params=PageDuplicateParams,
    destructive=True,
    batchable=True,
)
def duplicate(ctx: OpContext, p: PageDuplicateParams) -> OpOutput:
    with ctx.open_input() as pdf:
        pages = unique_sorted(check_indices(p.pages, len(pdf.pages)))
        # Insert from the back so earlier indices stay valid. Adding a page that is already
        # in the document makes qpdf insert a shallow copy (shared content and resources).
        for i in ctx.steps(sorted(pages, reverse=True), len(pages)):
            pdf.pages.insert(i + 1, pdf.pages[i])
            _unshare_annotations(pdf, pdf.pages[i + 1])
        ctx.save_document(pdf)
    return OpOutput()


def _unshare_annotations(pdf: pikepdf.Pdf, page: pikepdf.Page) -> None:
    """Give a duplicated page its own annotation objects (an annotation belongs to one page).

    Form-field widgets are dropped from the copy: duplicating a field would need AcroForm
    changes and two widgets of one field on different pages would be linked.
    """
    annots = page.obj.get("/Annots")
    if not isinstance(annots, pikepdf.Array):
        return
    copies = pikepdf.Array()
    for annot in annots:
        if not isinstance(annot, pikepdf.Dictionary):
            continue
        if annot.get("/Subtype") == pikepdf.Name.Widget or "/Parent" in annot:
            continue
        if annot.get("/Subtype") == pikepdf.Name.Popup:
            continue
        clone = pikepdf.Dictionary({k: v for k, v in annot.items() if k not in ("/P", "/Popup")})
        clone.P = page.obj
        copies.append(pdf.make_indirect(clone))
    page.obj.Annots = copies


# -- page.reorder ---------------------------------------------------------------------


class PageReorderParams(WireModel):
    """Reorder pages: new page i = old page ``order[i]`` (a full permutation)."""

    order: list[PageIndex] = Field(
        min_length=1, description="Full permutation of current 0-based indices."
    )


@operation(
    id="page.reorder",
    title="Reorder pages",
    group="page",
    params=PageReorderParams,
    destructive=True,
)
def reorder(ctx: OpContext, p: PageReorderParams) -> OpOutput:
    with ctx.open_input() as pdf:
        count = len(pdf.pages)
        if sorted(p.order) != list(range(count)):
            raise invalid_params(
                "order must be a permutation of all page indices",
                {"field": "order", "pageCount": count},
            )
        objs = [page.obj for page in pdf.pages]
        replace_page_order(pdf, [objs[i] for i in p.order])
        ctx.save_document(pdf)
    return OpOutput()


# -- page.extract ---------------------------------------------------------------------


class PageExtractParams(WireModel):
    """Write the given pages (in the given order) to a new PDF. The document is unchanged."""

    pages: PageList = Field(description="0-based page indices, in output order.")
    output_path: str = Field(min_length=1, description="Absolute path of the PDF to write.")


@operation(
    id="page.extract",
    title="Extract pages",
    group="page",
    params=PageExtractParams,
    batchable=True,
)
def extract(ctx: OpContext, p: PageExtractParams) -> OpOutput:
    out_path = Path(p.output_path).expanduser().absolute()
    with ctx.open_input() as src, pikepdf.new() as dst:
        pages = check_indices(p.pages, len(src.pages))
        copy_pages(ctx, src, dst, pages, keep_outline=True)
        _copy_docinfo(src, dst)
        ctx.check_cancelled()
        atomic_save(dst, out_path)
    return OpOutput(changed_pages=[], outputs=[str(out_path)])


def copy_pages(
    ctx: OpContext,
    src: pikepdf.Pdf,
    dst: pikepdf.Pdf,
    pages: list[int],
    *,
    keep_outline: bool,
    at: int | None = None,
    message: str | None = None,
) -> dict[tuple[int, int], pikepdf.Object]:
    """Copy ``src`` pages into ``dst`` (appended, or inserted at ``at``).

    Returns a map from source page objgen to the new page object. With ``keep_outline``,
    the source bookmarks pointing at copied pages are appended to the target outline.
    """
    page_map: dict[tuple[int, int], pikepdf.Object] = {}
    position = len(dst.pages) if at is None else at
    for i in ctx.steps(pages, len(pages), message):
        src_page = src.pages[i]
        dst.pages.insert(position, src_page)
        new_obj = dst.pages[position].obj
        page_map.setdefault(src_page.obj.objgen, new_obj)
        position += 1
    if keep_outline:
        items = build_items(read_bookmarks(src), page_map)
        if items:
            with dst.open_outline() as outline:
                outline.root.extend(items)
    return page_map


def _copy_docinfo(src: pikepdf.Pdf, dst: pikepdf.Pdf) -> None:
    info = src.trailer.get("/Info")
    if not isinstance(info, pikepdf.Dictionary):
        return
    for key, value in info.items():
        if isinstance(value, pikepdf.String | pikepdf.Name):
            dst.docinfo[key] = value


# -- page.insertBlank -----------------------------------------------------------------


class PageInsertBlankParams(WireModel):
    """Insert blank pages before index ``at`` (``at`` = page count appends)."""

    at: PageIndex = Field(description="Insert position (0-based, 0..pageCount).")
    count: int = Field(ge=1, le=1000, description="Number of blank pages.")
    width: Points | None = Field(
        default=None, description="Width in pt; defaults to the page before `at`, or A4."
    )
    height: Points | None = Field(
        default=None, description="Height in pt; defaults to the page before `at`, or A4."
    )


@operation(
    id="page.insertBlank",
    title="Insert blank pages",
    group="page",
    params=PageInsertBlankParams,
    destructive=True,
)
def insert_blank(ctx: OpContext, p: PageInsertBlankParams) -> OpOutput:
    with ctx.open_input() as pdf:
        count = len(pdf.pages)
        _check_insert_position(p.at, count)
        if p.at > 0:
            ref_w, ref_h, _ = display_size(pdf.pages[p.at - 1])
        else:
            ref_w, ref_h = A4
        width = p.width if p.width is not None else ref_w
        height = p.height if p.height is not None else ref_h
        for k in ctx.steps(range(p.count), p.count):
            pdf.pages.insert(p.at + k, make_blank_page(pdf, width, height))
        ctx.save_document(pdf)
    return OpOutput()


def _check_insert_position(at: int, count: int) -> None:
    if at > count:
        raise invalid_params(
            f"at must be between 0 and {count}", {"field": "at", "pageCount": count}
        )


# -- page.insertFromFile --------------------------------------------------------------


class PageInsertFromFileParams(WireModel):
    """Insert pages of another PDF before index ``at``."""

    at: PageIndex = Field(description="Insert position (0-based, 0..pageCount).")
    path: str = Field(min_length=1, description="PDF file to insert from.")
    password: str | None = Field(default=None, description="Password of that file.")
    pages: list[PageIndex] | None = Field(
        default=None, min_length=1, description="0-based pages of that file; default all."
    )


@operation(
    id="page.insertFromFile",
    title="Insert pages from file",
    group="page",
    params=PageInsertFromFileParams,
    destructive=True,
)
def insert_from_file(ctx: OpContext, p: PageInsertFromFileParams) -> OpOutput:
    with ctx.open_input() as pdf:
        _check_insert_position(p.at, len(pdf.pages))
        with open_pdf(p.path, p.password) as src:
            if p.pages is None:
                pages = list(range(len(src.pages)))
            else:
                pages = check_indices(p.pages, len(src.pages))
            copy_pages(ctx, src, pdf, pages, keep_outline=False, at=p.at)
            ctx.save_document(pdf)
    return OpOutput()


# -- page.insertImages ----------------------------------------------------------------


class ImagePathSource(WireModel):
    path: str = Field(min_length=1, description="Image file path.")


class ImageDataUrlSource(WireModel):
    data_url: str = Field(min_length=5, description="data: URL (e.g. pasted from clipboard).")


class PageInsertImagesParams(WireModel):
    """Insert one page per image (multi-frame TIFF: one per frame) before index ``at``."""

    at: PageIndex = Field(description="Insert position (0-based, 0..pageCount).")
    images: list[ImagePathSource | ImageDataUrlSource] = Field(min_length=1)
    page_size: PageSize = Field(
        description="'image' = page fits the image (+margin); 'a4' / 'letter' = image fitted "
        "into the page, landscape for landscape images."
    )
    margin: float = Field(ge=0, le=720, description="Margin in pt.")


@operation(
    id="page.insertImages",
    title="Insert images as pages",
    group="page",
    params=PageInsertImagesParams,
    destructive=True,
)
def insert_images(ctx: OpContext, p: PageInsertImagesParams) -> OpOutput:
    with ctx.open_input() as pdf:
        _check_insert_position(p.at, len(pdf.pages))
        position = p.at
        for source in ctx.steps(p.images, len(p.images)):
            if isinstance(source, ImagePathSource):
                data = read_image_file(source.path)
            else:
                data = decode_data_url(source.data_url)
            for page in image_pages(pdf, data, p.page_size, p.margin):
                pdf.pages.insert(position, page)
                position += 1
        ctx.save_document(pdf)
    return OpOutput()
