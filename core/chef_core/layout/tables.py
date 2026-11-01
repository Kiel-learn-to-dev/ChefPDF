"""Table detection (T10.02, N2): ruled tables from the path objects of a page, and an optional
conservative borderless heuristic.

Ruled tables. Horizontal and vertical rules are taken from stroked paths (and thin filled
rectangles). Rules are merged when they are on the same line and touch, then connected to each
other where they cross or touch. A connected group with at least two horizontal and two vertical
rules is a grid. Its rows and columns are the distinct rule positions. A grid cell is merged with
its neighbour when the rule between them is missing (a merged cell): the merged group becomes one
cell with ``rowSpan``/``colSpan``. Text lines are mapped to cells by their centre point.

Borderless (off by default). Consecutive lines that split into the same number of segments at the
same x positions (gaps wider than 1.5 x the font size), across at least three lines, form a table.
Text is split into segments; each segment is a cell. This is only a guess and is marked with a low
confidence by the caller.

Coordinates are user space (points, y up), as in the content engine.
"""

from __future__ import annotations

import dataclasses
import itertools
from collections.abc import Iterable
from dataclasses import dataclass

from chef_core.content.model import PageObject, Rect
from chef_core.text.build import _display
from chef_core.text.model import TextChar, TextLine

TOL = 2.0  # rules closer than this are the same rule (points)
MIN_RULE = 6.0  # shorter segments are ignored
COVER_TOL = 3.0  # slack when checking that a rule covers a cell edge
BORDERLESS_GAP = 1.5  # of the font size: a gap wider than this separates two cells
BORDERLESS_MIN_ROWS = 3
BORDERLESS_ALIGN = 4.0  # points: segment starts that match across rows


@dataclass(frozen=True)
class Rule:
    horizontal: bool
    pos: float  # y for a horizontal rule, x for a vertical one
    start: float  # extent along the other axis
    end: float


@dataclass
class CellGeom:
    row: int
    col: int
    row_span: int
    col_span: int
    rect: Rect  # user space
    filled: bool = False  # covered by a filled background (header shading)


@dataclass
class TableGeom:
    bbox: Rect
    xs: list[float]  # column boundaries, ascending
    ys: list[float]  # row boundaries, descending (top first)
    cells: list[CellGeom]
    ruled: bool = True

    @property
    def columns(self) -> int:
        return max(len(self.xs) - 1, 0)

    @property
    def rows(self) -> int:
        return max(len(self.ys) - 1, 0)

    def has_header_fill(self) -> bool:
        top = [c for c in self.cells if c.row == 0]
        return bool(top) and all(c.filled for c in top)


# -- rules -------------------------------------------------------------------------------


def _is_thick_fill(obj: PageObject) -> bool:
    x0, y0, x1, y1 = obj.bbox
    return obj.fill and not obj.stroke and (x1 - x0) > TOL * 2 and (y1 - y0) > TOL * 2


def _rules_of(objects: Iterable[PageObject]) -> tuple[list[Rule], list[Rect]]:
    rules: list[Rule] = []
    fills: list[Rect] = []
    for obj in objects:
        if obj.kind != "path":
            continue
        if _is_thick_fill(obj):
            fills.append(obj.bbox)
            continue
        if obj.fill and not obj.stroke:
            fills.append(obj.bbox)  # thin filled rectangles are rules too
        for line in obj.polylines:
            for (ax, ay), (bx, by) in itertools.pairwise(line):
                if abs(ay - by) <= TOL and abs(ax - bx) >= MIN_RULE:
                    rules.append(Rule(True, (ay + by) / 2, min(ax, bx), max(ax, bx)))
                elif abs(ax - bx) <= TOL and abs(ay - by) >= MIN_RULE:
                    rules.append(Rule(False, (ax + bx) / 2, min(ay, by), max(ay, by)))
    return rules, fills


def _merge(rules: list[Rule]) -> list[Rule]:
    """Rules on the same line (within TOL) that overlap or touch become one rule."""
    out: list[Rule] = []
    for horizontal in (True, False):
        group = sorted((r for r in rules if r.horizontal == horizontal), key=lambda r: r.pos)
        clusters: list[list[Rule]] = []
        for r in group:
            if clusters and abs(r.pos - clusters[-1][-1].pos) <= TOL:
                clusters[-1].append(r)
            else:
                clusters.append([r])
        for cluster in clusters:
            pos = sum(r.pos for r in cluster) / len(cluster)
            spans = sorted((r.start, r.end) for r in cluster)
            cur_s, cur_e = spans[0]
            for s, e in spans[1:]:
                if s <= cur_e + TOL:
                    cur_e = max(cur_e, e)
                else:
                    out.append(Rule(horizontal, pos, cur_s, cur_e))
                    cur_s, cur_e = s, e
            out.append(Rule(horizontal, pos, cur_s, cur_e))
    return out


def _cluster_positions(values: Iterable[float]) -> list[float]:
    ordered = sorted(values)
    clusters: list[list[float]] = []
    for v in ordered:
        if clusters and v - clusters[-1][-1] <= TOL:
            clusters[-1].append(v)
        else:
            clusters.append([v])
    return [sum(c) / len(c) for c in clusters]


def _covers_h(rules: list[Rule], y: float, x0: float, x1: float) -> bool:
    return any(
        abs(r.pos - y) <= COVER_TOL and r.start <= x0 + COVER_TOL and r.end >= x1 - COVER_TOL
        for r in rules
        if r.horizontal
    )


def _covers_v(rules: list[Rule], x: float, y0: float, y1: float) -> bool:
    return any(
        abs(r.pos - x) <= COVER_TOL and r.start <= y0 + COVER_TOL and r.end >= y1 - COVER_TOL
        for r in rules
        if not r.horizontal
    )


class _Sets:
    def __init__(self, n: int) -> None:
        self.parent = list(range(n))

    def find(self, i: int) -> int:
        while self.parent[i] != i:
            self.parent[i] = self.parent[self.parent[i]]
            i = self.parent[i]
        return i

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)


def _components(rules: list[Rule]) -> list[list[Rule]]:
    sets = _Sets(len(rules))
    for i, h in enumerate(rules):
        if not h.horizontal:
            continue
        for j, v in enumerate(rules):
            if v.horizontal:
                continue
            if (
                h.start - COVER_TOL <= v.pos <= h.end + COVER_TOL
                and v.start - COVER_TOL <= h.pos <= v.end + COVER_TOL
            ):
                sets.union(i, j)
    groups: dict[int, list[Rule]] = {}
    for i, r in enumerate(rules):
        groups.setdefault(sets.find(i), []).append(r)
    return [groups[k] for k in sorted(groups)]


def _grid(group: list[Rule], fills: list[Rect]) -> TableGeom | None:
    h = [r for r in group if r.horizontal]
    v = [r for r in group if not r.horizontal]
    if len(h) < 2 or len(v) < 2:
        return None
    ys = sorted(_cluster_positions(r.pos for r in h), reverse=True)
    xs = _cluster_positions(r.pos for r in v)
    if len(ys) < 2 or len(xs) < 2:
        return None
    rows, cols = len(ys) - 1, len(xs) - 1
    if rows * cols < 2:
        return None
    sets = _Sets(rows * cols)

    def idx(r: int, c: int) -> int:
        return r * cols + c

    for r in range(rows):
        for c in range(cols):
            if c + 1 < cols and not _covers_v(group, xs[c + 1], ys[r + 1], ys[r]):
                sets.union(idx(r, c), idx(r, c + 1))
            if r + 1 < rows and not _covers_h(group, ys[r + 1], xs[c], xs[c + 1]):
                sets.union(idx(r, c), idx(r + 1, c))
    members: dict[int, list[tuple[int, int]]] = {}
    for r in range(rows):
        for c in range(cols):
            members.setdefault(sets.find(idx(r, c)), []).append((r, c))
    cells: list[CellGeom] = []
    for cell in sorted(members.values(), key=lambda m: min(m)):
        r0 = min(r for r, _ in cell)
        r1 = max(r for r, _ in cell)
        c0 = min(c for _, c in cell)
        c1 = max(c for _, c in cell)
        rect = (xs[c0], ys[r1 + 1], xs[c1 + 1], ys[r0])
        cells.append(
            CellGeom(
                row=r0,
                col=c0,
                row_span=r1 - r0 + 1,
                col_span=c1 - c0 + 1,
                rect=rect,
                filled=_filled(rect, fills),
            )
        )
    cells.sort(key=lambda c: (c.row, c.col))
    bbox = (xs[0], ys[-1], xs[-1], ys[0])
    return TableGeom(bbox=bbox, xs=xs, ys=ys, cells=cells, ruled=True)


def _filled(rect: Rect, fills: list[Rect]) -> bool:
    x0, y0, x1, y1 = rect
    area = max((x1 - x0) * (y1 - y0), 1e-9)
    for fx0, fy0, fx1, fy1 in fills:
        w = min(x1, fx1) - max(x0, fx0)
        h = min(y1, fy1) - max(y0, fy0)
        if w > 0 and h > 0 and w * h >= 0.6 * area:
            return True
    return False


def ruled_tables(objects: list[PageObject]) -> list[TableGeom]:
    """Grids found from the rules of a page, top to bottom (rules inside each grid only)."""
    rules, fills = _rules_of(objects)
    rules = _merge(rules)
    tables: list[TableGeom] = []
    for group in _components(rules):
        grid = _grid(group, fills)
        if grid is not None:
            tables.append(grid)
    tables.sort(key=lambda t: (-t.bbox[3], t.bbox[0]))
    return tables


def in_table(table: TableGeom, x: float, y: float) -> bool:
    x0, y0, x1, y1 = table.bbox
    return x0 - 1 <= x <= x1 + 1 and y0 - 1 <= y <= y1 + 1


def _cell_index(table: TableGeom, x: float, y: float) -> int | None:
    for i, cell in enumerate(table.cells):
        x0, y0, x1, y1 = cell.rect
        if x0 - 1 <= x <= x1 + 1 and y0 - 1 <= y <= y1 + 1:
            return i
    return None


def centre(line: TextLine) -> tuple[float, float]:
    x0, y0, x1, y1 = line.bbox
    return (x0 + x1) / 2, (y0 + y1) / 2


def assign_lines(table: TableGeom, lines: list[TextLine]) -> list[tuple[int, TextLine]]:
    """(cell index, line) for each line whose centre lies in the table (ruled tables)."""
    out: list[tuple[int, TextLine]] = []
    for line in lines:
        cx, cy = centre(line)
        i = _cell_index(table, cx, cy)
        if i is not None:
            out.append((i, line))
    return out


# -- borderless --------------------------------------------------------------------------


def _segments(line: TextLine) -> list[list[TextChar]]:
    """The characters of a line split where the gap is wider than BORDERLESS_GAP font sizes.
    Spaces stay inside a segment; a segment starts and ends with a visible character."""
    chars = sorted(line.chars, key=lambda c: c.x0)
    segs: list[list[TextChar]] = []
    for c in chars:
        if segs and c.x0 - segs[-1][-1].x1 <= BORDERLESS_GAP * max(c.size, segs[-1][-1].size):
            segs[-1].append(c)
        elif c.ch.strip():
            segs.append([c])
    out: list[list[TextChar]] = []
    for seg in segs:
        while seg and not seg[-1].ch.strip():
            seg.pop()
        if seg:
            out.append(seg)
    return out


def _piece(line: TextLine, chars: list[TextChar]) -> TextLine:
    text, mapping = _display(chars)
    x0 = min(c.x0 for c in chars)
    x1 = max(c.x1 for c in chars)
    return dataclasses.replace(
        line,
        chars=chars,
        text=text,
        display_map=mapping,
        bbox=(x0, line.bbox[1], x1, line.bbox[3]),
    )


def _rows_of(lines: list[TextLine]) -> list[list[TextLine]]:
    """Visual rows: lines on the same baseline (the text model splits a row into columns)."""
    rows: list[list[TextLine]] = []
    for ln in sorted(lines, key=lambda ln: (-ln.baseline, ln.bbox[0])):
        tol = 0.4 * max(ln.font_size, rows[-1][0].font_size) if rows else 0.0
        if rows and abs(rows[-1][0].baseline - ln.baseline) <= tol:
            rows[-1].append(ln)
        else:
            rows.append([ln])
    return rows


def _row_segments(row: list[TextLine]) -> list[tuple[float, float]]:
    """(x0, x1) of every segment of a row, left to right."""
    spans = [
        (min(c.x0 for c in seg), max(c.x1 for c in seg)) for ln in row for seg in _segments(ln)
    ]
    return sorted(spans)


def borderless_tables(lines: list[TextLine]) -> list[TableGeom]:
    """Conservative borderless tables: at least three consecutive visual rows that each split
    into the same number of segments at the same x positions (within BORDERLESS_ALIGN)."""
    rows = _rows_of(lines)
    tables: list[TableGeom] = []
    group: list[tuple[list[TextLine], list[tuple[float, float]]]] = []

    def flush() -> None:
        if len(group) >= BORDERLESS_MIN_ROWS:
            table = _borderless_grid(group)
            if table is not None:
                tables.append(table)
        group.clear()

    for row in rows:
        spans = _row_segments(row)
        if len(spans) < 2:
            flush()
            continue
        if group:
            prev_row, prev_spans = group[-1]
            top = min(ln.bbox[1] for ln in prev_row)
            bottom = max(ln.bbox[3] for ln in row)
            size = max(ln.font_size for ln in prev_row + row)
            same = len(prev_spans) == len(spans) and all(
                abs(a[0] - b[0]) <= BORDERLESS_ALIGN for a, b in zip(prev_spans, spans, strict=True)
            )
            if not same or top - bottom > 2.2 * size:
                flush()
        group.append((row, spans))
    flush()
    return tables


def _borderless_grid(
    group: list[tuple[list[TextLine], list[tuple[float, float]]]],
) -> TableGeom | None:
    cols = len(group[0][1])
    starts = [sum(spans[i][0] for _, spans in group) / len(group) for i in range(cols)]
    ends = [max(spans[i][1] for _, spans in group) for i in range(cols)]
    xs = [starts[0] - 2.0]
    for i in range(cols - 1):
        xs.append((ends[i] + starts[i + 1]) / 2)
    xs.append(ends[-1] + 2.0)
    tops = [max(ln.bbox[3] for ln in row) for row, _ in group]
    bottoms = [min(ln.bbox[1] for ln in row) for row, _ in group]
    ys = [tops[0] + 1.0]
    for i in range(len(group) - 1):
        ys.append((bottoms[i] + tops[i + 1]) / 2)
    ys.append(bottoms[-1] - 1.0)
    cells: list[CellGeom] = []
    for r in range(len(group)):
        for c in range(cols):
            rect = (xs[c], ys[r + 1], xs[c + 1], ys[r])
            cells.append(CellGeom(row=r, col=c, row_span=1, col_span=1, rect=rect))
    bbox = (xs[0], ys[-1], xs[-1], ys[0])
    return TableGeom(bbox=bbox, xs=xs, ys=ys, cells=cells, ruled=False)


def borderless_pieces(table: TableGeom, lines: list[TextLine]) -> list[tuple[int, TextLine]]:
    """Each segment of each line as a piece assigned to the cell that holds it."""
    out: list[tuple[int, TextLine]] = []
    for line in lines:
        for seg in _segments(line):
            cx = (min(c.x0 for c in seg) + max(c.x1 for c in seg)) / 2
            cy = centre(line)[1]
            i = _cell_index(table, cx, cy)
            if i is not None:
                out.append((i, _piece(line, seg)))
    return out
