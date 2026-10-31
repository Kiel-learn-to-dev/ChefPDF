"""File operations (features C4, C5): merge files, split a document."""

from __future__ import annotations

import io
import itertools
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal

import pikepdf
from pydantic import Field, model_validator

from chef_core.errors import ChefError, invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.ops.page import copy_pages
from chef_core.pdf.io import atomic_save, open_pdf
from chef_core.pdf.outline import build_items, read_bookmarks
from chef_core.pdf.pages import check_indices, page_objgen_index

PageIndex = Annotated[int, Field(ge=0)]

# -- file.merge -----------------------------------------------------------------------


class MergeInput(WireModel):
    path: str = Field(min_length=1, description="PDF file to merge.")
    password: str | None = Field(default=None, description="Password of that file.")
    pages: list[PageIndex] | None = Field(
        default=None, min_length=1, description="0-based pages to take; default all."
    )


class FileMergeParams(WireModel):
    """Merge several PDFs (in order) into a new file."""

    inputs: list[MergeInput] = Field(min_length=1)
    output_path: str = Field(min_length=1, description="Absolute path of the PDF to write.")
    bookmarks_from_filenames: bool = Field(
        description="Add one top-level bookmark per input named after its file; the input's "
        "own bookmarks are nested under it."
    )


@operation(
    id="file.merge",
    title="Merge files",
    group="file",
    params=FileMergeParams,
    standalone=True,
)
def merge(ctx: OpContext, p: FileMergeParams) -> OpOutput:
    out_path = Path(p.output_path).expanduser().absolute()
    sources: list[pikepdf.Pdf] = []
    try:
        with pikepdf.new() as dst:
            outline_items: list[pikepdf.OutlineItem] = []
            total = len(p.inputs)
            for index, item in enumerate(p.inputs):
                ctx.progress(index, total, Path(item.path).name)
                try:
                    src = open_pdf(item.path, item.password)
                except ChefError as exc:
                    exc.detail = {**(exc.detail or {}), "inputIndex": index}
                    raise
                sources.append(src)
                pages = (
                    list(range(len(src.pages)))
                    if item.pages is None
                    else check_indices(item.pages, len(src.pages), f"inputs[{index}].pages")
                )
                first = len(dst.pages)
                page_map = copy_pages(ctx, src, dst, pages, keep_outline=False)
                children = build_items(read_bookmarks(src), page_map)
                if p.bookmarks_from_filenames and pages:
                    top = pikepdf.OutlineItem(
                        Path(item.path).stem,
                        pikepdf.Array([dst.pages[first].obj, pikepdf.Name.Fit]),
                    )
                    top.children.extend(children)
                    outline_items.append(top)
                else:
                    outline_items.extend(children)
            if outline_items:
                with dst.open_outline() as outline:
                    outline.root.extend(outline_items)
            ctx.progress(total, total)
            # Sources must stay open until the output is written (pikepdf reads lazily).
            atomic_save(dst, out_path)
    finally:
        for src in sources:
            src.close()
    return OpOutput(changed_pages=[], outputs=[str(out_path)])


# -- file.split -----------------------------------------------------------------------

SplitMode = Literal["ranges", "everyN", "bookmarks", "maxSize", "oddEven"]


class FileSplitParams(WireModel):
    """Split the document into several files written to ``outputDir``."""

    mode: SplitMode
    ranges: str | None = Field(
        default=None,
        description='mode "ranges": 1-based groups, e.g. "1-3,5,7-9" (one file per group).',
    )
    n: int | None = Field(default=None, ge=1, description='mode "everyN": pages per file.')
    max_bytes: int | None = Field(
        default=None, ge=1, description='mode "maxSize": maximum size of each file in bytes.'
    )
    output_dir: str = Field(min_length=1, description="Directory for the output files.")
    name_template: str = Field(
        default="{name}_{index}",
        min_length=1,
        description="File name template: {name}, {index}, {start}, {end}; .pdf is appended.",
    )

    @model_validator(mode="after")
    def _mode_fields(self) -> FileSplitParams:
        if self.mode == "ranges" and not self.ranges:
            raise ValueError('ranges is required for mode "ranges"')
        if self.mode == "everyN" and self.n is None:
            raise ValueError('n is required for mode "everyN"')
        if self.mode == "maxSize" and self.max_bytes is None:
            raise ValueError('maxBytes is required for mode "maxSize"')
        return self


@dataclass
class Part:
    pages: list[int]  # 0-based

    @property
    def start(self) -> int:
        return self.pages[0] + 1

    @property
    def end(self) -> int:
        return self.pages[-1] + 1


_RANGE_RE = re.compile(r"^\s*(\d+)\s*(?:-\s*(\d*)\s*)?$")


def parse_ranges(text: str, count: int) -> list[Part]:
    """Parse ``"1-3,5,7-9"`` (1-based, inclusive; ``"7-"`` = 7 to end) into parts."""
    parts: list[Part] = []
    for group in text.split(","):
        if not group.strip():
            continue
        m = _RANGE_RE.match(group)
        if not m:
            raise invalid_params(f"Invalid page range: {group.strip()!r}", {"field": "ranges"})
        start = int(m.group(1))
        end = start if m.group(2) is None else (int(m.group(2)) if m.group(2) else count)
        if start < 1 or end < 1 or start > count or end > count:
            raise invalid_params(
                f"Page range out of bounds: {group.strip()!r} (document has {count} pages)",
                {"field": "ranges", "pageCount": count},
            )
        step = 1 if end >= start else -1
        parts.append(Part(list(range(start - 1, end - 1 + step, step))))
    if not parts:
        raise invalid_params("ranges is empty", {"field": "ranges"})
    return parts


def _every_n(count: int, n: int) -> list[Part]:
    return [Part(list(range(i, min(i + n, count)))) for i in range(0, count, n)]


def _by_bookmarks(pdf: pikepdf.Pdf, ctx: OpContext) -> list[Part]:
    index = page_objgen_index(pdf)
    starts = sorted(
        {index[bm.page] for bm in read_bookmarks(pdf) if bm.page is not None and bm.page in index}
    )
    count = len(pdf.pages)
    if not starts:
        ctx.warn("The document has no top-level bookmarks; it was not split.")
        return [Part(list(range(count)))]
    if starts[0] != 0:
        starts.insert(0, 0)
    bounds = [*starts, count]
    return [Part(list(range(a, b))) for a, b in itertools.pairwise(bounds)]


def _odd_even(count: int, ctx: OpContext) -> list[Part]:
    parts = [Part(list(range(0, count, 2)))]
    if count > 1:
        parts.append(Part(list(range(1, count, 2))))
    else:
        ctx.warn("The document has a single page; there are no even pages.")
    return parts


def _build_part(src: pikepdf.Pdf, pages: list[int], ctx: OpContext) -> pikepdf.Pdf:
    dst = pikepdf.new()
    page_map: dict[tuple[int, int], pikepdf.Object] = {}
    for i in pages:
        dst.pages.append(src.pages[i])
        page_map.setdefault(src.pages[i].obj.objgen, dst.pages[-1].obj)
    items = build_items(read_bookmarks(src), page_map)
    if items:
        with dst.open_outline() as outline:
            outline.root.extend(items)
    info = src.trailer.get("/Info")
    if isinstance(info, pikepdf.Dictionary):
        for key, value in info.items():
            if isinstance(value, pikepdf.String | pikepdf.Name):
                dst.docinfo[key] = value
    return dst


def _part_size(src: pikepdf.Pdf, pages: list[int], ctx: OpContext) -> int:
    ctx.check_cancelled()
    buf = io.BytesIO()
    with _build_part(src, pages, ctx) as part:
        part.save(buf)
    return buf.tell()


def _by_max_size(src: pikepdf.Pdf, max_bytes: int, ctx: OpContext) -> list[Part]:
    """Greedy split: each part takes as many following pages as fit in ``max_bytes``.

    Uses exponential + binary search on the end page, so each part costs O(log n) saves.
    """
    count = len(src.pages)
    parts: list[Part] = []
    start = 0
    while start < count:
        ctx.progress(start, count, "measuring")
        if _part_size(src, [start], ctx) > max_bytes:
            ctx.warn(f"Page {start + 1} alone is larger than the size limit.")
            parts.append(Part([start]))
            start += 1
            continue
        good = 1  # number of pages known to fit
        step = 1
        bad: int | None = None
        while bad is None:
            probe = min(good + step, count - start)
            if probe == good:
                break
            if _part_size(src, list(range(start, start + probe)), ctx) <= max_bytes:
                good = probe
                step *= 2
            else:
                bad = probe
        if bad is not None:
            lo, hi = good, bad  # lo fits, hi does not
            while hi - lo > 1:
                mid = (lo + hi) // 2
                if _part_size(src, list(range(start, start + mid)), ctx) <= max_bytes:
                    lo = mid
                else:
                    hi = mid
            good = lo
        parts.append(Part(list(range(start, start + good))))
        start += good
    return parts


_UNSAFE_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_VAR_RE = re.compile(r"\{(name|index|start|end)\}")


def render_name(template: str, *, name: str, index: int, total: int, part: Part) -> str:
    width = len(str(total))
    values = {
        "name": name,
        "index": str(index).zfill(width),
        "start": str(part.start),
        "end": str(part.end),
    }
    text = _VAR_RE.sub(lambda m: values[m.group(1)], template)
    text = _UNSAFE_CHARS.sub("_", text).strip().rstrip(".")
    if not text:
        text = f"{name}_{values['index']}"
    if not text.lower().endswith(".pdf"):
        text += ".pdf"
    return text


@operation(
    id="file.split",
    title="Split file",
    group="file",
    params=FileSplitParams,
    batchable=True,
)
def split(ctx: OpContext, p: FileSplitParams) -> OpOutput:
    out_dir = Path(p.output_dir).expanduser().absolute()
    if out_dir.exists() and not out_dir.is_dir():
        raise invalid_params("outputDir is not a directory", {"field": "outputDir"})
    out_dir.mkdir(parents=True, exist_ok=True)
    with ctx.open_input() as src:
        count = len(src.pages)
        if count == 0:
            raise invalid_params("The document has no pages")
        if p.mode == "ranges":
            assert p.ranges is not None
            parts = parse_ranges(p.ranges, count)
        elif p.mode == "everyN":
            assert p.n is not None
            parts = _every_n(count, p.n)
        elif p.mode == "bookmarks":
            parts = _by_bookmarks(src, ctx)
        elif p.mode == "maxSize":
            assert p.max_bytes is not None
            parts = _by_max_size(src, p.max_bytes, ctx)
        else:
            parts = _odd_even(count, ctx)

        total = len(parts)
        names: list[str] = []
        for index, part in enumerate(parts, start=1):
            name = render_name(
                p.name_template, name=ctx.doc_name, index=index, total=total, part=part
            )
            if name in names:  # template without {index}: keep files distinct
                stem = name[:-4]
                name = f"{stem}_{str(index).zfill(len(str(total)))}.pdf"
            names.append(name)

        outputs: list[str] = []
        for part, name in ctx.steps(list(zip(parts, names, strict=True)), total, "writing"):
            target = out_dir / name
            with _build_part(src, part.pages, ctx) as dst:
                atomic_save(dst, target)
            outputs.append(str(target))
    return OpOutput(changed_pages=[], outputs=outputs)
