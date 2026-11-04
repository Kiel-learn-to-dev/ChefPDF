"""Rule-based document analysis (T10.01, N1): the text model and the page objects -> DocModel.

Pipeline (per document, all pages analysed together because repeated furniture needs them):

1. Text model per page (``chef_core.text.build``). Artifacts (watermarks, page numbers marked as
   /Artifact) are left out. Rotated text is skipped and reported.
2. Tables from ruled grids (``layout.tables``), and borderless tables when asked. Their text is
   removed from the flow.
3. Units: paragraphs of the text model (lines grouped by paragraph id), images, vector figure
   clusters, horizontal separators. Captions ('Hình', 'Bảng', 'Figure', 'Table') next to an image
   or figure are attached to it.
4. Classification: repeated header/footer/page-number units (same normalised text in the top or
   bottom band of at least 60% of the pages; digits are normalised to '#'); headings by font size
   clustered over the document (bold-only and numbered short lines when size does not decide);
   list items by marker; footnotes (small text at the bottom with a leading number or marker).
5. Reading order per page: full-width items (width >= 60% of the text width) split the page into
   bands; inside a band, narrow items are sorted by column (gutters are the empty columns of the
   projection profile of the narrow items), then top to bottom.
6. Paragraphs that continue across a page break or a column break (no terminal punctuation, same
   size and weight, same left edge) are joined.
7. Consecutive list items become list blocks, nested by indentation.

Coordinates in blocks are display points (origin top-left). Ids of the text model are kept in
``sourceRefs``.
"""

from __future__ import annotations

import math
import re
import statistics
import unicodedata
from collections import Counter
from dataclasses import dataclass, field
from typing import Any

import pikepdf

from chef_core.annots.links import list_links
from chef_core.content.model import PageObject, Rect
from chef_core.layout.model import (
    FURNITURE_KINDS,
    DocModel,
    Figure,
    Footer,
    Footnote,
    Header,
    Heading,
    Image,
    ListBlock,
    ListItem,
    Meta,
    PageInfo,
    PageNumber,
    Paragraph,
    Run,
    Separator,
    SourceInfo,
    StyleDef,
    Table,
    TableCell,
)
from chef_core.layout.tables import (
    TableGeom,
    assign_lines,
    borderless_pieces,
    borderless_tables,
    in_table,
    ruled_tables,
)
from chef_core.text.build import SHOW_OPS, build_text_page, is_rotated, matrix_of
from chef_core.text.model import TextLine, TextPage

# -- options and results -----------------------------------------------------------------


@dataclass(frozen=True)
class DetectOptions:
    drop_repeated: bool = True
    join_across_pages: bool = True
    detect_tables: bool = True
    borderless_tables: bool = False
    join_tables: bool = True
    language: str | None = None


@dataclass(frozen=True)
class HeadingRef:
    """A heading for the table of contents (D12). ``top`` is the user-space y of its top."""

    page: int
    level: int
    text: str
    confidence: float
    top: float
    x: float
    size: float


@dataclass
class DocAnalysis:
    model: DocModel
    columns: dict[int, int]
    warnings: list[dict[str, Any]]
    headings: list[HeadingRef]


# -- constants ---------------------------------------------------------------------------

TERMINAL = re.compile(r"[.!?:;…\"”'’)\]»]\s*$")
CAPTION = re.compile(
    r"^\s*(?:hình|figure|fig\.|bảng|table|sơ đồ|biểu đồ)\s*[\dIVXLA-Za-z]{0,3}\s*[.:\-–)]?\s",
    re.IGNORECASE,
)
NUMBERED = re.compile(
    r"^\s*(?:\d{1,2}(?:\.\d{1,2}){0,3}[.)]?|[IVXLC]{1,6}[.)])\s+\S"
    r"|^\s*(?:chương|phần|mục|điều|chapter|article|section|part)\s+[\dIVXLC]+",
    re.IGNORECASE,
)
ORDERED = re.compile(r"^\s*(?:\d{1,3}|[a-zA-Z]|[ivxIVX]{1,4}|\(\w{1,4}\))[.)]\s")
# A marker followed by a letter is a list item too: bullets are often drawn flush with the text.
LOOSE_MARKER = re.compile(
    r"^\s*((?:[-•·▪●◦*–]|\d{1,3}[.)]|[a-zA-Z][.)]|[ivxIVX]{1,4}[.)]))(?=[^\W\d_]|\s)"
)
FOOTNOTE = re.compile(r"^\s*(?:\d{1,3}|[*†‡¹²³⁴⁵⁶⁷⁸⁹⁰]+)[.)]?\s+\S")
PAGE_MARK = re.compile(r"\b(?:trang|page)\b|\bp\.\s*#|#\s*(?:/|of|trên)\s*#", re.IGNORECASE)
PAGE_NUMBER = re.compile(
    r"^[-–(\[]?\s*(?:trang|page|p\.)?\s*#+(?:\s*(?:/|of|trên|-|–)\s*#+)?\s*[-–)\]]?$",
    re.IGNORECASE,
)
REPEAT_SHARE = 0.6
TOP_BAND = 0.15
BOTTOM_BAND = 0.85
FULL_WIDTH = 0.6
ALIGN_TOL = 3.0
VN_LETTERS = re.compile(r"[ăâđêôơưĂÂĐÊÔƠƯẠ-ỹ]")


# -- per-page context --------------------------------------------------------------------


@dataclass
class PageCtx:
    index: int
    tp: TextPage
    objects: list[PageObject]
    links: list[dict[str, Any]]
    width: float
    height: float
    rotation: int
    lines: list[TextLine]
    rotated_text: int

    def disp(self, box: Rect) -> Rect:
        x0, y0, x1, y1 = self.tp.display_box(box)
        return (round(x0, 3), round(y0, 3), round(x1, 3), round(y1, 3))


@dataclass(eq=False)
class Item:
    kind: str
    page: int
    box: Rect  # user space
    lines: list[TextLine] = field(default_factory=list)
    confidence: float = 0.9
    level: int = 1
    col: int = 0
    marker: str | None = None
    caption: str | None = None
    obj: PageObject | None = None
    refs: list[str] = field(default_factory=list)
    table: TableGeom | None = None
    cell_lines: list[tuple[int, TextLine]] = field(default_factory=list)
    joined: list[int] = field(default_factory=list)

    @property
    def text(self) -> str:
        return _norm(" ".join(ln.text.strip() for ln in self.lines))

    @property
    def top(self) -> float:
        return self.box[3]

    @property
    def width(self) -> float:
        return self.box[2] - self.box[0]


def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFC", text)).strip()


def _page_ctx(pdf: pikepdf.Pdf, index: int) -> PageCtx:
    tp = build_text_page(pdf, pdf.pages[index], index)
    frame = tp.frame
    width, height = frame.display_size
    rotated = 0
    for obj in tp.model.objects:
        if obj.kind != "text" or not obj.in_page:
            continue
        if tp.model.nodes[obj.start].op not in SHOW_OPS:
            continue
        if is_rotated(matrix_of(obj)):
            rotated += 1
    return PageCtx(
        index=index,
        tp=tp,
        objects=tp.model.objects,
        links=list_links(pdf, index),
        width=float(width),
        height=float(height),
        rotation=int(frame.rotation),
        lines=[ln for ln in tp.lines if not ln.artifact],
        rotated_text=rotated,
    )


def _dominant(lines: list[TextLine]) -> tuple[float, bool]:
    """The font size with most characters, and whether that text is mostly bold."""
    weight: Counter[float] = Counter()
    bold: Counter[bool] = Counter()
    for ln in lines:
        n = max(len(ln.text.strip()), 1)
        weight[round(ln.font_size, 1)] += n
        bold[ln.bold] += n
    size = weight.most_common(1)[0][0] if weight else 0.0
    return size, bool(bold and bold.most_common(1)[0][0])


def _union(boxes: list[Rect]) -> Rect:
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


def centre_of(box: Rect) -> tuple[float, float]:
    return (box[0] + box[2]) / 2, (box[1] + box[3]) / 2


def _in_any(tables: list[TableGeom], x: float, y: float) -> bool:
    return any(in_table(t, x, y) for t in tables)


# -- units per page ----------------------------------------------------------------------


def _page_items(ctx: PageCtx, opts: DetectOptions) -> list[Item]:
    items: list[Item] = []
    remaining = list(ctx.lines)
    tables: list[TableGeom] = []
    if opts.detect_tables:
        for geom in ruled_tables(ctx.objects):
            assigned = assign_lines(geom, remaining)
            used = {ln.id for _, ln in assigned}
            remaining = [ln for ln in remaining if ln.id not in used]
            tables.append(geom)
            items.append(
                Item(
                    kind="table",
                    page=ctx.index,
                    box=geom.bbox,
                    lines=[ln for _, ln in assigned],
                    confidence=0.9,
                    table=geom,
                    cell_lines=assigned,
                    refs=[ln.id for _, ln in assigned],
                )
            )
    if opts.borderless_tables:
        for geom in borderless_tables(remaining):
            pieces = borderless_pieces(geom, remaining)
            used = {ln.id for _, ln in pieces}
            remaining = [ln for ln in remaining if ln.id not in used]
            tables.append(geom)
            items.append(
                Item(
                    kind="table",
                    page=ctx.index,
                    box=geom.bbox,
                    lines=[ln for _, ln in pieces],
                    confidence=0.55,
                    table=geom,
                    cell_lines=pieces,
                    refs=sorted({ln.id for _, ln in pieces}),
                )
            )
    # paragraphs: consecutive remaining lines of the same text-model paragraph
    units: list[Item] = []
    for ln in remaining:
        last = units[-1] if units else None
        if (
            last is not None
            and ln.paragraph_id is not None
            and last.lines[-1].paragraph_id == ln.paragraph_id
        ):
            last.lines.append(ln)
        else:
            units.append(Item(kind="paragraph", page=ctx.index, box=ln.bbox, lines=[ln]))
    for u in units:
        u.box = _union([ln.bbox for ln in u.lines])
        u.refs = [ln.id for ln in u.lines]
    items.extend(units)
    # images and vector drawings
    for obj in ctx.objects:
        if obj.kind != "image" or any(m.startswith("Artifact") for m in obj.marks):
            continue
        x0, y0, x1, y1 = obj.bbox
        if x1 - x0 < 8 or y1 - y0 < 8:
            continue
        items.append(
            Item(
                kind="image", page=ctx.index, box=obj.bbox, obj=obj, refs=[obj.id], confidence=0.95
            )
        )
    paths = [
        o
        for o in ctx.objects
        if o.kind == "path"
        and not any(m.startswith("Artifact") for m in o.marks)
        and not _in_any(tables, *centre_of(o.bbox))
    ]
    items.extend(_separators(paths, ctx))
    items.extend(_figures(paths, ctx))
    _attach_captions(items, ctx.index)
    return items


def _is_separator(box: Rect) -> bool:
    return box[3] - box[1] <= 2.5 and box[2] - box[0] >= 40


def _separators(paths: list[PageObject], ctx: PageCtx) -> list[Item]:
    out: list[Item] = []
    for o in paths:
        if _is_separator(o.bbox) and o.bbox[2] - o.bbox[0] >= 0.3 * ctx.width:
            out.append(
                Item(
                    kind="separator",
                    page=ctx.index,
                    box=o.bbox,
                    refs=[o.id],
                    confidence=0.95,
                    obj=o,
                )
            )
    return out


def _figures(paths: list[PageObject], ctx: PageCtx) -> list[Item]:
    """Clusters of vector paths (not separators, not tables) with a real size."""
    cands = [o for o in paths if not _is_separator(o.bbox)]
    parent = list(range(len(cands)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    gap = 24.0  # bars of one chart are a few points apart
    for i, a in enumerate(cands):
        for j in range(i + 1, len(cands)):
            b = cands[j]
            if (
                a.bbox[0] - gap <= b.bbox[2]
                and b.bbox[0] - gap <= a.bbox[2]
                and a.bbox[1] - gap <= b.bbox[3]
                and b.bbox[1] - gap <= a.bbox[3]
            ):
                parent[find(i)] = find(j)
    groups: dict[int, list[PageObject]] = {}
    for i, o in enumerate(cands):
        groups.setdefault(find(i), []).append(o)
    out: list[Item] = []
    for members in groups.values():
        box = _union([m.bbox for m in members])
        w, h = box[2] - box[0], box[3] - box[1]
        if len(members) >= 3 and w >= 40 and h >= 30:
            out.append(
                Item(
                    kind="figure",
                    page=ctx.index,
                    box=box,
                    refs=[m.id for m in members],
                    confidence=0.6,
                )
            )
    return out


def _attach_captions(items: list[Item], page: int) -> None:
    """A caption paragraph within 40 points above or below an image or figure is attached."""
    visuals = [it for it in items if it.kind in ("image", "figure")]
    captions = [it for it in items if it.kind == "paragraph" and CAPTION.match(it.text)]
    for vis in visuals:
        best: Item | None = None
        best_gap = 41.0
        for cap in captions:
            if cap.page != page:
                continue
            cx = centre_of(cap.box)[0]
            if not (vis.box[0] - 20 <= cx <= vis.box[2] + 20):
                continue
            gap = max(cap.box[1] - vis.box[3], vis.box[1] - cap.box[3])
            if 0 <= gap <= 40 and gap < best_gap:
                best, best_gap = cap, gap
        if best is not None:
            vis.caption = best.text
            items.remove(best)
            captions.remove(best)


# -- classification ----------------------------------------------------------------------


def _norm_key(text: str) -> str:
    return re.sub(r"\d", "#", _norm(text).lower())


def _zone(ctx: PageCtx, box: Rect) -> str | None:
    _, y0, _, y1 = ctx.disp(box)
    if y1 <= TOP_BAND * ctx.height:
        return "top"
    if y0 >= BOTTOM_BAND * ctx.height:
        return "bottom"
    return None


def _repeated_furniture(texts: list[Item], ctxs: dict[int, PageCtx], pages: int) -> None:
    """Sets header/footer/pageNumber on units that repeat across pages or are page numbers.

    A unit repeats when its exact text repeats. Digits are ignored only for a line that carries a
    page marker ("Trang 3", "3 / 10"): otherwise "Điều 1" and "Điều 2" at the top of pages would
    count as one running header and vanish from the body."""
    zones: dict[int, str | None] = {}
    exact: dict[tuple[str, str], set[int]] = {}
    marked: dict[tuple[str, str], set[int]] = {}
    for it in texts:
        zone = _zone(ctxs[it.page], it.box)
        zones[id(it)] = zone
        if zone is None:
            continue
        exact.setdefault((zone, _norm(it.text).lower()), set()).add(it.page)
        if PAGE_MARK.search(it.text):
            marked.setdefault((zone, _norm_key(it.text)), set()).add(it.page)
    threshold = max(2, math.ceil(REPEAT_SHARE * pages)) if pages >= 2 else None
    for it in texts:
        zone = zones[id(it)]
        if zone is None:
            continue
        if PAGE_NUMBER.match(_norm_key(it.text)):
            it.kind = "pageNumber"
            continue
        if threshold is None:
            continue
        repeats = len(exact[(zone, _norm(it.text).lower())]) >= threshold or (
            bool(PAGE_MARK.search(it.text))
            and len(marked.get((zone, _norm_key(it.text)), ())) >= threshold
        )
        if repeats:
            it.kind = "header" if zone == "top" else "footer"


def _classify(
    per_page: dict[int, list[Item]],
    ctxs: dict[int, PageCtx],
    body_size: float,
    body_bold: bool,
    opts: DetectOptions,
) -> None:
    texts = [it for items in per_page.values() for it in items if it.kind == "paragraph"]
    if opts.drop_repeated:
        _repeated_furniture(texts, ctxs, len(ctxs))
    units = [it for it in texts if it.kind == "paragraph"]
    # headings and lists: size first, then bold, then numbering and markers
    size_key: dict[int, float] = {}
    for it in units:
        if len(it.lines) > 2 or len(it.text) > 160:
            continue
        size, bold = _dominant(it.lines)
        text = it.text
        numbered = NUMBERED.match(text) is not None
        loose = LOOSE_MARKER.match(text)
        big = body_size > 0 and size >= body_size * 1.12
        boldish = bold and not body_bold and len(text) <= 120
        if big:
            it.kind = "heading"
            it.confidence = 0.9
            size_key[id(it)] = round(size * 2) / 2
        elif numbered and bold and not text.endswith((".", ";", ",")):
            it.kind = "heading"
            it.confidence = 0.7
        elif loose is not None:
            it.kind = "listitem"
            it.marker = loose.group(1)
            it.confidence = 0.85
        elif boldish and not text.endswith((",", ";")):
            it.kind = "heading"
            it.confidence = 0.7
    sizes_desc = sorted(set(size_key.values()), reverse=True)
    bold_level = min(6, len(sizes_desc) + 1)
    for it in units:
        if it.kind != "heading":
            continue
        if id(it) in size_key:
            it.level = min(6, sizes_desc.index(size_key[id(it)]) + 1)
        else:
            it.level = bold_level
    # footnotes: small text at the bottom with a leading marker
    for it in units:
        if it.kind != "paragraph" or _zone(ctxs[it.page], it.box) != "bottom":
            continue
        size, _ = _dominant(it.lines)
        if body_size > 0 and size < 0.85 * body_size and FOOTNOTE.match(it.text):
            it.kind = "footnote"
            it.confidence = 0.7


def _split_furniture(items: list[Item]) -> tuple[list[Item], list[Item], list[Item]]:
    head = [it for it in items if it.kind == "header"]
    tail = [it for it in items if it.kind in ("footer", "pageNumber")]
    body = [it for it in items if it.kind not in ("header", "footer", "pageNumber")]
    head.sort(key=lambda it: (-it.top, it.box[0]))
    tail.sort(key=lambda it: (-it.top, it.box[0]))
    return head, body, tail


# -- reading order -----------------------------------------------------------------------


def _gutters(narrow: list[Item], body_size: float) -> list[float]:
    spans = sorted((it.box[0], it.box[2]) for it in narrow)
    if len(spans) < 2:
        return []
    threshold = max(12.0, 1.5 * body_size)
    gutters: list[float] = []
    reach = spans[0][1]
    for x0, x1 in spans[1:]:
        if x0 - reach >= threshold:
            gutters.append((reach + x0) / 2)
        reach = max(reach, x1)
    return gutters


def order_items(items: list[Item], body_size: float) -> tuple[list[Item], int]:
    """Reading order of body items; sets ``col`` on narrow items. Returns (order, columns)."""
    if not items:
        return [], 1
    left = min(it.box[0] for it in items)
    right = max(it.box[2] for it in items)
    width = max(right - left, 1.0)
    full = [it for it in items if it.width >= FULL_WIDTH * width]
    narrow = [it for it in items if it.width < FULL_WIDTH * width]
    full.sort(key=lambda it: -it.top)
    gutters = _gutters(narrow, body_size)
    keyed: list[tuple[tuple[float, float, float], Item]] = []
    for it in narrow:
        it.col = sum(1 for g in gutters if centre_of(it.box)[0] > g)
        band = sum(1 for f in full if f.box[1] >= it.top - 1.0)
        keyed.append(((2.0 * band, float(it.col), -it.top), it))
    for rank, f in enumerate(full):
        keyed.append(((2.0 * rank + 1.0, 0.0, -f.top), f))
    keyed.sort(key=lambda pair: (pair[0], pair[1].box[0]))
    return [it for _, it in keyed], len(gutters) + 1


# -- runs --------------------------------------------------------------------------------


def _style_key(c: Any, line: TextLine, link: str | None) -> tuple[Any, ...]:
    small = c.size < 0.8 * line.font_size
    sup = small and c.baseline - line.baseline > 0.15 * line.font_size
    sub = small and line.baseline - c.baseline > 0.15 * line.font_size
    return (c.bold, c.italic, c.font or None, round(c.size, 1), c.colour, link, sup, sub)


def _link_at(ctx: PageCtx, c: Any) -> str | None:
    if not ctx.links:
        return None
    x0, y0, x1, y1 = ctx.disp((c.x0, c.y0, c.x1, c.y1))
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    for link in ctx.links:
        rx0, ry0, rx1, ry1 = link["rect"]
        if rx0 <= cx <= rx1 and ry0 <= cy <= ry1:
            kind = link["kind"]
            if kind == "uri" and link.get("target"):
                return str(link["target"])
            if kind == "page" and link.get("target") is not None:
                return f"page:{link['target']}"
            if kind in ("named", "file") and link.get("target"):
                return str(link["target"])
    return None


_Piece = tuple[str, tuple[Any, ...], dict[str, Any]]


def runs_of(lines: list[TextLine], ctx: PageCtx) -> list[Run]:
    """Runs of the lines: one run per stretch of equal style. Lines are joined by a space, or
    without it when the line ends with a hyphen and the next one starts in lower case."""
    runs: list[_Piece] = []

    def push(text: str, key: tuple[Any, ...], style: dict[str, Any]) -> None:
        if runs and runs[-1][1] == key:
            runs[-1] = (runs[-1][0] + text, key, style)
        else:
            runs.append((text, key, style))

    for index, line in enumerate(lines):
        if index > 0 and runs:
            last_text, last_key, last_style = runs[-1]
            if (
                last_text.endswith("-")
                and len(last_text) > 1
                and last_text[-2].isalpha()
                and line.text.strip()[:1].islower()
            ):
                runs[-1] = (last_text[:-1], last_key, last_style)
            else:
                push(" ", last_key, last_style)
        last: _Piece | None = None
        for m in line.display_map:
            if m is None:
                if last is not None:
                    push(" ", last[1], last[2])
                continue
            c = line.chars[m]
            link = _link_at(ctx, c)
            key = _style_key(c, line, link)
            style = {
                "bold": c.bold,
                "italic": c.italic,
                "font": c.font or None,
                "size": round(c.size, 1),
                "color": c.colour,
                "link": link,
                "sup": key[6],
                "sub": key[7],
            }
            push(c.ch, key, style)
            last = runs[-1]
    out: list[Run] = []
    for text, _key, style in runs:
        clean = unicodedata.normalize("NFC", text)
        if clean:
            out.append(Run(text=clean, **style))
    if out:
        out[0] = out[0].model_copy(update={"text": out[0].text.lstrip()})
        out[-1] = out[-1].model_copy(update={"text": out[-1].text.rstrip()})
    return [r for r in out if r.text]


# -- joins -------------------------------------------------------------------------------


def _continues(prev: Item, nxt: Item) -> bool:
    if prev.kind != "paragraph" or nxt.kind != "paragraph":
        return False
    if not prev.text or TERMINAL.search(prev.text):
        return False
    if prev.page == nxt.page and prev.col == nxt.col:
        return False
    s1, b1 = _dominant(prev.lines)
    s2, b2 = _dominant(nxt.lines)
    if abs(s1 - s2) > 0.5 or b1 != b2:
        return False
    if prev.page == nxt.page:  # column break: both columns have the same measure
        return abs(prev.width - nxt.width) <= 0.1 * max(prev.width, nxt.width)
    return abs(prev.box[0] - nxt.box[0]) <= ALIGN_TOL


def _join_flow(flow: list[Item], opts: DetectOptions) -> list[Item]:
    out: list[Item] = []
    for it in flow:
        if out and opts.join_across_pages and _continues(out[-1], it):
            prev = out[-1]
            prev.lines = prev.lines + it.lines
            prev.refs = prev.refs + it.refs  # the box stays that of the first part
            if it.page != prev.page:
                prev.joined.append(it.page)
            continue
        out.append(it)
    return out


# -- conversion --------------------------------------------------------------------------


def _paragraph_blocks(lines: list[TextLine], ctx: PageCtx) -> list[Paragraph]:
    groups: list[list[TextLine]] = []
    for ln in lines:
        if (
            groups
            and ln.paragraph_id is not None
            and groups[-1][-1].paragraph_id == ln.paragraph_id
        ):
            groups[-1].append(ln)
        else:
            groups.append([ln])
    out: list[Paragraph] = []
    for g in groups:
        runs = runs_of(g, ctx)
        if not runs:
            continue
        out.append(
            Paragraph(
                bbox=ctx.disp(_union([ln.bbox for ln in g])),
                runs=runs,
                source_refs=[ln.id for ln in g],
                confidence=0.95,
            )
        )
    return out


def _table_block(item: Item, ctx: PageCtx, geom: TableGeom) -> Table:
    per_cell: dict[int, list[TextLine]] = {}
    for idx, ln in item.cell_lines:
        per_cell.setdefault(idx, []).append(ln)
    rows: list[list[TableCell]] = [[] for _ in range(geom.rows)]
    for index, cell in enumerate(geom.cells):
        blocks = _paragraph_blocks(per_cell.get(index, []), ctx)
        rows[cell.row].append(
            TableCell(row_span=cell.row_span, col_span=cell.col_span, blocks=list(blocks))
        )
    has_header = geom.has_header_fill()
    if not has_header and len(rows) > 1:
        top = [ln for idx, ln in item.cell_lines if geom.cells[idx].row == 0]
        rest = [ln for idx, ln in item.cell_lines if geom.cells[idx].row > 0]
        has_header = bool(top) and all(ln.bold for ln in top) and not all(ln.bold for ln in rest)
    return Table(
        bbox=ctx.disp(geom.bbox),
        has_header_row=has_header,
        columns=geom.columns,
        rows=rows,
        source_refs=item.refs,
        confidence=item.confidence,
    )


def _space_after_marker(runs: list[Run], marker: str | None) -> list[Run]:
    """A bullet drawn flush with its text ('a.con') gets the space back."""
    if not runs or not marker:
        return runs
    first = runs[0].text
    if first == marker and len(runs) > 1 and not runs[1].text[:1].isspace():
        runs[1] = runs[1].model_copy(update={"text": " " + runs[1].text})
    elif first.startswith(marker) and len(first) > len(marker) and not first[len(marker)].isspace():
        runs[0] = runs[0].model_copy(update={"text": f"{marker} {first[len(marker) :]}"})
    return runs


def _list_block(group: list[Item], ctx: PageCtx) -> ListBlock:
    """Nested list items: an item further right than the previous one is its child."""
    roots: list[ListItem] = []
    levels: list[tuple[float, ListItem, list[ListItem]]] = []
    for it in group:
        runs = _space_after_marker(runs_of(it.lines, ctx), it.marker)
        li = ListItem(runs=runs, marker=it.marker, bbox=ctx.disp(it.box))
        x = it.box[0]
        size, _ = _dominant(it.lines)
        while levels and x < levels[-1][0] - ALIGN_TOL:
            levels.pop()
        if levels and abs(x - levels[-1][0]) <= ALIGN_TOL:
            container = levels[-1][2]
        elif levels and x > levels[-1][0] + 0.8 * size:
            container = levels[-1][1].children
        else:
            container = roots
        container.append(li)
        levels.append((x, li, container))
    first = group[0].marker or ""
    return ListBlock(
        bbox=ctx.disp(_union([it.box for it in group])),
        ordered=ORDERED.match(first + " ") is not None,
        items=roots,
        source_refs=[r for it in group for r in it.refs],
        confidence=round(min(it.confidence for it in group), 3),
    )


def _item_block(item: Item, ctx: PageCtx, geom_of: dict[int, TableGeom]) -> Any:
    box = ctx.disp(item.box)
    if item.kind == "heading":
        return Heading(
            bbox=box,
            level=item.level,
            runs=runs_of(item.lines, ctx),
            source_refs=item.refs,
            confidence=item.confidence,
        )
    if item.kind == "paragraph":
        return Paragraph(
            bbox=box,
            runs=runs_of(item.lines, ctx),
            joined_pages=sorted(set(item.joined)),
            source_refs=item.refs,
            confidence=item.confidence,
        )
    if item.kind == "table" and item.table is not None:
        table = _table_block(item, ctx, item.table)
        geom_of[id(table)] = item.table
        return table
    if item.kind == "image":
        return Image(
            bbox=box,
            image_ref=item.obj.id if item.obj is not None else None,
            caption=item.caption,
            source_refs=item.refs,
            confidence=item.confidence,
        )
    if item.kind == "figure":
        return Figure(
            bbox=box, caption=item.caption, source_refs=item.refs, confidence=item.confidence
        )
    if item.kind == "separator":
        return Separator(bbox=box, source_refs=item.refs, confidence=item.confidence)
    if item.kind == "footnote":
        return Footnote(
            bbox=box,
            runs=runs_of(item.lines, ctx),
            source_refs=item.refs,
            confidence=item.confidence,
        )
    runs = runs_of(item.lines, ctx)
    if item.kind == "header":
        return Header(bbox=box, runs=runs, source_refs=item.refs, confidence=0.9)
    if item.kind == "footer":
        return Footer(bbox=box, runs=runs, source_refs=item.refs, confidence=0.9)
    if item.kind == "pageNumber":
        return PageNumber(bbox=box, runs=runs, source_refs=item.refs, confidence=0.9)
    raise ValueError(f"unexpected item kind {item.kind}")


def _page_blocks(
    body: list[Item],
    head: list[Item],
    tail: list[Item],
    ctx: PageCtx,
    geom_of: dict[int, TableGeom],
) -> list[Any]:
    """Blocks of one page in reading order (lists grouped, furniture at the ends)."""
    blocks: list[Any] = [_item_block(it, ctx, geom_of) for it in head]
    group: list[Item] = []
    for it in body:
        if it.kind == "listitem":
            if group and group[-1].col != it.col:
                blocks.append(_list_block(group, ctx))
                group = []
            group.append(it)
            continue
        if group:
            blocks.append(_list_block(group, ctx))
            group = []
        blocks.append(_item_block(it, ctx, geom_of))
    if group:
        blocks.append(_list_block(group, ctx))
    blocks.extend(_item_block(it, ctx, geom_of) for it in tail)
    return blocks


def _last_body(blocks: list[Any]) -> int | None:
    for i in range(len(blocks) - 1, -1, -1):
        if blocks[i].kind not in FURNITURE_KINDS:
            return i
    return None


def _first_body(blocks: list[Any]) -> int | None:
    for i, block in enumerate(blocks):
        if block.kind not in FURNITURE_KINDS:
            return i
    return None


def _same_grid(prev: Table, nxt: Table, gp: TableGeom, gn: TableGeom) -> bool:
    if prev.columns != nxt.columns or prev.columns == 0 or len(gp.xs) != len(gn.xs):
        return False
    return all(abs(a - b) <= 4.0 for a, b in zip(gp.xs, gn.xs, strict=True))


def _row_text(row: list[TableCell]) -> str:
    parts = [r.text for cell in row for block in cell.blocks for r in _runs_of_block(block)]
    return _norm(" ".join(parts))


def _runs_of_block(block: Any) -> list[Run]:
    runs: list[Run] = getattr(block, "runs", [])
    return runs


def _join_tables(
    pages: list[list[Any]], ctxs: list[PageCtx], geom_of: dict[int, TableGeom]
) -> None:
    """A table at the bottom of a page continues the table at the top of the next page when
    the column grids match. A repeated header row of the continuation is dropped."""
    for i in range(1, len(pages)):
        prev_blocks, cur = pages[i - 1], pages[i]
        prev_idx, next_idx = _last_body(prev_blocks), _first_body(cur)
        if prev_idx is None or next_idx is None:
            continue
        prev, nxt = prev_blocks[prev_idx], cur[next_idx]
        if not isinstance(prev, Table) or not isinstance(nxt, Table):
            continue
        gp, gn = geom_of.get(id(prev)), geom_of.get(id(nxt))
        if gp is None or gn is None or not _same_grid(prev, nxt, gp, gn):
            continue
        if prev.bbox[3] < 0.7 * ctxs[i - 1].height or nxt.bbox[1] > 0.3 * ctxs[i].height:
            continue
        new_rows = list(nxt.rows)
        if (
            prev.has_header_row
            and nxt.has_header_row
            and new_rows
            and prev.rows
            and _row_text(new_rows[0]) == _row_text(prev.rows[0])
        ):
            new_rows = new_rows[1:]
        merged = prev.model_copy(
            update={
                "rows": list(prev.rows) + new_rows,
                "source_refs": list(prev.source_refs) + list(nxt.source_refs),
            }
        )
        geom_of[id(merged)] = gp
        prev_blocks[prev_idx] = merged
        del cur[next_idx]


def _meta(pdf: pikepdf.Pdf, lang_hint: str | None, texts: list[str]) -> Meta:
    info: dict[str, str] = {}
    try:
        info = {str(k): str(v) for k, v in dict(pdf.docinfo).items()}
    except Exception:  # pragma: no cover - malformed info dictionary
        info = {}
    title = _norm(info.get("/Title", "")) or None
    author = _norm(info.get("/Author", "")) or None
    if lang_hint:
        lang = lang_hint
    elif any(VN_LETTERS.search(t) for t in texts):
        lang = "vi"
    else:
        lang = "und"
    return Meta(title=title, author=author, lang=lang)


def _styles(
    body_size: float, body_bold: bool, headings: list[HeadingRef], lines: list[TextLine]
) -> dict[str, StyleDef]:
    styles: dict[str, StyleDef] = {}
    if lines:
        font = Counter(ln.font_name for ln in lines).most_common(1)[0][0]
        styles["body"] = StyleDef(font=font or None, size=body_size, bold=body_bold)
    for level in sorted({h.level for h in headings}):
        sizes = [h.size for h in headings if h.level == level]
        styles[f"heading{level}"] = StyleDef(size=statistics.median(sizes), bold=True)
    return styles


def _warnings(ctxs: list[PageCtx]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for c in ctxs:
        has_image = any(o.kind == "image" for o in c.objects)
        if not c.lines and has_image:
            out.append(
                {
                    "code": "PAGE_HAS_NO_TEXT_LAYER",
                    "page": c.index,
                    "message": (
                        "page has images but no text layer (scanned page: OCR is out of scope)"
                    ),
                }
            )
        if c.rotated_text:
            out.append(
                {
                    "code": "ROTATED_TEXT_SKIPPED",
                    "page": c.index,
                    "message": f"{c.rotated_text} rotated text object(s) skipped",
                }
            )
    return out


# -- entry point -------------------------------------------------------------------------


def build_doc_model(
    pdf: pikepdf.Pdf,
    pages: list[int] | None = None,
    options: DetectOptions | None = None,
    name: str = "document",
) -> DocAnalysis:
    """Analyse ``pages`` (all pages when None) and return the model with its side results."""
    opts = options or DetectOptions()
    count = len(pdf.pages)
    selected = sorted(set(pages)) if pages is not None else list(range(count))
    ctxs = [_page_ctx(pdf, i) for i in selected]
    by_index = {c.index: c for c in ctxs}
    all_lines = [ln for c in ctxs for ln in c.lines]
    body_size, body_bold = _dominant(all_lines)
    per_page: dict[int, list[Item]] = {c.index: _page_items(c, opts) for c in ctxs}
    _classify(per_page, by_index, body_size, body_bold, opts)

    columns: dict[int, int] = {}
    heads: dict[int, list[Item]] = {}
    tails: dict[int, list[Item]] = {}
    bodies: dict[int, list[Item]] = {}
    flow: list[Item] = []
    for c in ctxs:
        head, body, tail = _split_furniture(per_page[c.index])
        ordered, ncols = order_items(body, body_size)
        columns[c.index] = ncols
        heads[c.index], tails[c.index], bodies[c.index] = head, tail, ordered
        flow.extend(ordered)
    kept = {id(it) for it in _join_flow(flow, opts)}
    for c in ctxs:
        bodies[c.index] = [it for it in bodies[c.index] if id(it) in kept]

    geom_of: dict[int, TableGeom] = {}
    page_blocks = [
        _page_blocks(bodies[c.index], heads[c.index], tails[c.index], c, geom_of) for c in ctxs
    ]
    if opts.join_tables:
        _join_tables(page_blocks, ctxs, geom_of)

    headings = [
        HeadingRef(
            page=c.index,
            level=it.level,
            text=it.text,
            confidence=it.confidence,
            top=it.top,
            x=it.box[0],
            size=_dominant(it.lines)[0],
        )
        for c in ctxs
        for it in bodies[c.index]
        if it.kind == "heading"
    ]
    infos: list[PageInfo] = []
    for c, blocks in zip(ctxs, page_blocks, strict=True):
        numbered = [b.model_copy(update={"reading_order": n}) for n, b in enumerate(blocks)]
        infos.append(
            PageInfo(
                index=c.index, width=c.width, height=c.height, rotation=c.rotation, blocks=numbered
            )
        )
    model = DocModel(
        source=SourceInfo(name=name, page_count=count),
        pages=infos,
        styles=_styles(body_size, body_bold, headings, all_lines),
        meta=_meta(pdf, opts.language, [ln.text for ln in all_lines]),
    )
    return DocAnalysis(
        model=model,
        columns=columns,
        warnings=_warnings(ctxs),
        headings=headings,
    )


__all__ = [
    "DetectOptions",
    "DocAnalysis",
    "HeadingRef",
    "build_doc_model",
    "order_items",
    "runs_of",
]
