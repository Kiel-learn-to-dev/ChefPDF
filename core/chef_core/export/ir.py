"""The intermediate representation read by every renderer (T10.04-T10.06).

``build_ir`` walks the pages of a :class:`DocModel` in reading order and produces one flat list of
items. Renderers never see the model directly: they get clean text (NFC, XML-safe), the grid of each
table with its spans already placed, and the image bytes already extracted (``Assets``).

Repeated furniture (header, footer, page number) is left out unless ``includeHeadersFooters``; it
is kept with its role otherwise, so a renderer can put it in a header or in the body.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field
from typing import Literal

from chef_core.errors import ChefError, ErrorKind
from chef_core.export.assets import Assets
from chef_core.export.options import ExportOptions
from chef_core.export.text import clean, clean_runs, plain
from chef_core.layout import model as m
from chef_core.layout.model import DocModel, PageInfo, Run

Role = Literal["body", "header", "footer", "pagenumber", "footnote", "unknown", "caption"]


@dataclass(frozen=True)
class Asset:
    data: bytes
    ext: str  # "png" or "jpg"


BBox = tuple[float, float, float, float]
NO_BOX: BBox = (0.0, 0.0, 0.0, 0.0)


@dataclass
class Heading:
    level: int
    runs: list[Run]
    page: int
    bbox: BBox = NO_BOX


@dataclass
class Para:
    runs: list[Run]
    page: int
    role: Role = "body"
    bbox: BBox = NO_BOX


@dataclass
class ListNode:
    runs: list[Run]
    marker: str | None
    children: list[ListNode] = field(default_factory=list)


@dataclass
class ListBlock:
    ordered: bool
    items: list[ListNode]
    page: int
    bbox: BBox = NO_BOX


@dataclass
class CellIR:
    paras: list[list[Run]] = field(default_factory=list)
    row_span: int = 1
    col_span: int = 1
    covered: bool = False  # inside a span that starts elsewhere


@dataclass
class TableBlock:
    rows: list[list[CellIR]]  # a full grid: every row has ``columns`` cells
    header: bool
    page: int
    columns: int
    bbox: BBox = NO_BOX

    @property
    def merged(self) -> bool:
        return any(c.row_span > 1 or c.col_span > 1 for row in self.rows for c in row)


@dataclass
class ImageBlock:
    asset: Asset | None
    width: float
    height: float
    caption: str | None
    page: int
    kind: Literal["image", "figure"] = "image"
    bbox: BBox = NO_BOX


@dataclass
class Rule:
    page: int
    bbox: BBox = NO_BOX


@dataclass
class PageMark:
    index: int
    width: float
    height: float


Item = Heading | Para | ListBlock | TableBlock | ImageBlock | Rule | PageMark


@dataclass
class ExportResult:
    outputs: list[str]
    warnings: list[str]
    stats: dict[str, int]


@dataclass
class DocIR:
    name: str
    title: str | None
    author: str | None
    language: str
    page_indices: list[int]
    items: list[Item]
    body_font: str | None
    body_size: float | None
    heading_sizes: dict[int, float]
    warnings: list[str]
    stats: Counter[str]

    def blocks_of(self, cls: type[Item] | tuple[type[Item], ...]) -> list[Item]:
        return [it for it in self.items if isinstance(it, cls)]


# -- selection ---------------------------------------------------------------------------------


def select_pages(model: DocModel, pages: list[int] | None) -> list[PageInfo]:
    """The pages to export, in document order. Unknown indices are an error."""
    by_index = {p.index: p for p in model.pages}
    if pages is None:
        return sorted(model.pages, key=lambda p: p.index)
    missing = sorted({i for i in pages if i not in by_index})
    if missing:
        raise ChefError(
            ErrorKind.INVALID_PARAMS,
            f"Trang không có trong tài liệu: {missing}",
            {"field": "pages", "pages": missing},
        )
    return [by_index[i] for i in sorted(set(pages))]


# -- runs and cells ----------------------------------------------------------------------------


def _text_of(block: m.Block) -> list[Run]:
    runs = getattr(block, "runs", None)
    return clean_runs(runs) if runs else []


def _without_marker(runs: list[Run], marker: str) -> list[Run]:
    """The runs without the printed marker, when the text repeats it (the marker is kept apart)."""
    if not runs:
        return runs
    first = runs[0]
    text = first.text.lstrip()
    if text == marker:
        return runs[1:]
    if text.startswith(marker):
        return [first.model_copy(update={"text": text[len(marker) :]}), *runs[1:]]
    return runs


def _list_nodes(items: list[m.ListItem]) -> list[ListNode]:
    out: list[ListNode] = []
    for item in items:
        marker = clean(item.marker).strip() if item.marker else ""
        runs = clean_runs(item.runs)
        if marker:
            runs = clean_runs(_without_marker(runs, marker))
        out.append(
            ListNode(
                runs=runs,
                marker=marker or None,
                children=_list_nodes(item.children),
            )
        )
    return out


def _cell_paragraphs(cell: m.TableCell) -> list[list[Run]]:
    paras: list[list[Run]] = []
    for block in cell.blocks:
        if isinstance(block, m.ListBlock):
            for node in _list_nodes(block.items):
                marker = node.marker or ("" if block.ordered else "•")
                prefix = [Run(text=marker + " ")] if marker else []
                runs = clean_runs(prefix + node.runs)
                if runs:
                    paras.append(runs)
        elif isinstance(block, m.Image | m.Figure | m.Separator):
            continue
        else:
            runs = _text_of(block)
            if runs:
                paras.append(runs)
    return paras


def grid_of(block: m.Table) -> tuple[list[list[CellIR]], int]:
    """The full grid of a table: anchors placed where the spans put them, covered positions
    marked. Returns (rows, number of columns)."""
    anchors: dict[tuple[int, int], CellIR] = {}
    covered: set[tuple[int, int]] = set()
    width = block.columns
    height = len(block.rows)
    for r, row in enumerate(block.rows):
        c = 0
        for cell in row:
            while (r, c) in covered or (r, c) in anchors:
                c += 1
            anchors[(r, c)] = CellIR(
                paras=_cell_paragraphs(cell), row_span=cell.row_span, col_span=cell.col_span
            )
            for dr in range(cell.row_span):
                for dc in range(cell.col_span):
                    if dr or dc:
                        covered.add((r + dr, c + dc))
            c += cell.col_span
            width = max(width, c)
            height = max(height, r + cell.row_span)
    grid: list[list[CellIR]] = []
    for r in range(height):
        line: list[CellIR] = []
        for c in range(width):
            if (r, c) in anchors:
                line.append(anchors[(r, c)])
            elif (r, c) in covered:
                line.append(CellIR(covered=True))
            else:
                line.append(CellIR())
        grid.append(line)
    return grid, width


# -- building ----------------------------------------------------------------------------------


class _Builder:
    def __init__(self, assets: Assets | None, opts: ExportOptions) -> None:
        self.assets = assets
        self.opts = opts
        self.items: list[Item] = []
        self.warnings: list[str] = []
        self.stats: Counter[str] = Counter()

    def warn(self, code: str, page: int) -> None:
        text = f"{code}: trang {page + 1}"
        if text not in self.warnings:
            self.warnings.append(text)

    def block(self, block: m.Block, page: int) -> None:
        start = len(self.items)
        self.dispatch(block, page)
        for item in self.items[start:]:
            if not isinstance(item, PageMark):
                item.bbox = block.bbox

    def dispatch(self, block: m.Block, page: int) -> None:
        if isinstance(block, m.Heading):
            runs = clean_runs(block.runs)
            if runs:
                self.items.append(Heading(block.level, runs, page))
                self.stats["headings"] += 1
        elif isinstance(block, m.Paragraph | m.Unknown | m.Footnote):
            self.text_block(block, page)
        elif isinstance(block, m.Header | m.Footer | m.PageNumber):
            self.furniture(block, page)
        elif isinstance(block, m.ListBlock):
            nodes = _list_nodes(block.items)
            if nodes:
                self.items.append(ListBlock(block.ordered, nodes, page))
                self.stats["lists"] += 1
        elif isinstance(block, m.Table):
            self.table(block, page)
        elif isinstance(block, m.Image | m.Figure):
            self.picture(block, page)
        elif isinstance(block, m.Separator):
            self.items.append(Rule(page))
            self.stats["rules"] += 1

    def furniture(self, block: m.Block, page: int) -> None:
        if not self.opts.include_headers_footers:
            return
        if isinstance(block, m.Header):
            role: Role = "header"
        elif isinstance(block, m.Footer):
            role = "footer"
        else:
            role = "pagenumber"
        runs = _text_of(block)
        if runs:
            self.items.append(Para(runs, page, role))
            self.stats["furniture"] += 1

    def text_block(self, block: m.Block, page: int) -> None:
        runs = _text_of(block)
        if not runs:
            return
        if isinstance(block, m.Footnote):
            self.items.append(Para(runs, page, "footnote"))
            self.stats["footnotes"] += 1
        elif isinstance(block, m.Unknown):
            self.items.append(Para(runs, page, "unknown"))
            self.stats["unknown"] += 1
        else:
            self.items.append(Para(runs, page, "body"))
            self.stats["paragraphs"] += 1

    def table(self, block: m.Table, page: int) -> None:
        if not block.rows:
            return
        rows, width = grid_of(block)
        self.items.append(TableBlock(rows, block.has_header_row, page, width))
        self.stats["tables"] += 1

    def picture(self, block: m.Image | m.Figure, page: int) -> None:
        caption = clean(block.caption).strip() if block.caption else None
        if not self.opts.include_images:
            if caption:
                self.items.append(Para([Run(text=caption)], page, "caption"))
            return
        x0, y0, x1, y1 = block.bbox
        width, height = max(0.0, x1 - x0), max(0.0, y1 - y0)
        asset: Asset | None = None
        if isinstance(block, m.Image):
            kind: Literal["image", "figure"] = "image"
            got = self.assets.image(block.image_ref) if self.assets and block.image_ref else None
            if got is not None:
                asset = Asset(got[0], got[1])
            else:
                self.warn("IMAGE_NOT_EXTRACTED", page)
        else:
            kind = "figure"
            data = self.assets.region(page, block.bbox) if self.assets else None
            if data is not None:
                asset = Asset(data, "png")
            else:
                self.warn("FIGURE_NOT_RENDERED", page)
        self.items.append(ImageBlock(asset, width, height, caption, page, kind))
        self.stats["figures" if kind == "figure" else "images"] += 1


def _body_style(model: DocModel) -> tuple[str | None, float | None, dict[int, float]]:
    heads: dict[int, float] = {}
    for level in range(1, m.MAX_HEADING_LEVEL + 1):
        style = model.styles.get(f"heading{level}")
        if style is not None and style.size:
            heads[level] = float(style.size)
    body = model.styles.get("body")
    if body is None:
        return None, None, heads
    return body.font, body.size, heads


def build_ir(
    model: DocModel,
    assets: Assets | None,
    opts: ExportOptions,
    pages: list[int] | None = None,
    name: str | None = None,
) -> DocIR:
    """The items of ``pages`` (all when None), in reading order, with images extracted."""
    selected = select_pages(model, pages)
    builder = _Builder(assets, opts)
    for info in selected:
        builder.items.append(PageMark(info.index, info.width, info.height))
        builder.stats["pages"] += 1
        for block in sorted(info.blocks, key=lambda b: b.reading_order):
            builder.block(block, info.index)
    font, size, heads = _body_style(model)
    title = opts.title or model.meta.title
    author = opts.author or model.meta.author
    return DocIR(
        name=name or model.source.name,
        title=clean(title).strip() if title else None,
        author=clean(author).strip() if author else None,
        language=opts.language,
        page_indices=[p.index for p in selected],
        items=builder.items,
        body_font=font,
        body_size=size,
        heading_sizes=heads,
        warnings=builder.warnings,
        stats=builder.stats,
    )


def first_text(items: list[Item]) -> str:
    """The first heading or paragraph text (a fallback title)."""
    for it in items:
        if isinstance(it, Heading | Para):
            return plain(it.runs)
    return ""
