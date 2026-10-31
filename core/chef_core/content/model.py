"""Data model of the page content engine (T6.01).

A page is a list of instructions (``Ins``). Every instruction has an *origin key*: a tuple of
ints that says where it came from. A key is ``(i,)`` for the i-th instruction of the page, and
``(i, j)`` for the j-th instruction of the form XObject drawn by instruction i, and so on. Keys
do not change when the page is edited around them, so an object found in the model of the
current revision can be found again in a model built with the forms flattened.

Object ids are ``p<page>:<digest>:<ordinal>``. ``digest`` is the first 12 hex digits of the
SHA-1 of the page's content streams and ``ordinal`` is the position of the object in the paint
order of the whole enumeration (forms included), so the ids of one revision are deterministic.
An id from an older revision has another digest and is refused as stale.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from chef_core.signing.anchors import PageFrame

Matrix = tuple[float, float, float, float, float, float]
Rect = tuple[float, float, float, float]
Key = tuple[int, ...]
Colour = tuple[str, tuple[float, ...]]

_ID = re.compile(r"^p(\d+):([0-9a-f]{12}):(\d+)$")


@dataclass
class Ins:
    """One content stream instruction. ``operands`` are pikepdf objects or Python numbers."""

    operands: list[Any]
    op: str
    key: Key


@dataclass(eq=False)
class PageObject:
    """A paint object of the page: text run, image, path, shading or form."""

    kind: str
    key: Key
    bbox: Rect  # page user space, clipped by the clip in effect
    in_page: bool  # True when start/end index the page's own instruction list
    start: int = -1
    end: int = -1
    ordinal: int = -1
    id: str = ""
    parent_key: Key | None = None
    parent_id: str | None = None
    marks: list[str] = field(default_factory=list)
    layer: str | None = None
    mark_ins: list[Ins] = field(default_factory=list)
    ctm: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    clipped: bool = False
    # colour state before the object (used to restore it after an edit)
    fill_op: tuple[str, str | None, tuple[float, ...]] = ("g", None, (0.0,))
    stroke_op: tuple[str, str | None, tuple[float, ...]] = ("g", None, (0.0,))
    fill_color: Colour | None = None  # what is painted: ("gray"|"rgb"|"cmyk"|"named", comps)
    stroke_color: Colour | None = None
    fa: float = 1.0
    sa: float = 1.0
    lw: float = 1.0
    dash: tuple[Any, Any] | None = None
    # text
    string: str = ""
    font: str | None = None  # resource name, with the slash
    font_name: str = ""  # BaseFont
    font_size: float = 0.0
    tm: Matrix = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    advance: float = 0.0  # horizontal advance of the run (scaled by Th)
    tc: float = 0.0
    tw: float = 0.0
    th: float = 1.0
    tl: float = 0.0
    ts: float = 0.0
    tr: int = 0
    quad: tuple[tuple[float, float], ...] = ()
    # image
    image_name: str | None = None
    pixel_size: tuple[int, int] | None = None
    smask: bool = False
    inline: bool = False
    # path
    fill: bool = False
    stroke: bool = False
    segments: int = 0
    stroke_width: float = 0.0
    polylines: list[list[tuple[float, float]]] = field(default_factory=list)

    @property
    def editable(self) -> bool:
        return self.in_page

    def display_bbox(self, frame: PageFrame) -> tuple[float, float, float, float]:
        """Bounding box in the displayed frame: points, origin top-left, y downwards."""
        x0, y0, x1, y1 = frame.rect_to_display(self.bbox)
        height = frame.display_size[1]
        return (x0, height - y1, x1, height - y0)

    def to_json(self, frame: PageFrame, page_index: int) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id,
            "pageIndex": page_index,
            "kind": self.kind,
            "ordinal": self.ordinal,
            "parentId": self.parent_id,
            "editable": self.editable,
            "bbox": [round(v, 4) for v in self.display_bbox(frame)],
            "bboxUser": [round(v, 4) for v in self.bbox],
            "marks": list(self.marks),
            "layer": self.layer,
            "clipped": self.clipped,
            "opacity": [round(self.fa, 4), round(self.sa, 4)],
            "opRange": [self.start, self.end] if self.in_page else None,
        }
        if self.kind in ("text", "path"):
            out["fillColor"] = hex_of(self.fill_color)
            out["strokeColor"] = hex_of(self.stroke_color)
        if self.kind == "text":
            out.update(
                string=self.string,
                font=self.font_name,
                fontSize=round(self.font_size, 3),
                invisible=self.tr == 3,
            )
        elif self.kind == "image":
            out.update(
                imageName=self.image_name,
                pixelSize=list(self.pixel_size) if self.pixel_size else None,
                inline=self.inline,
                smask=self.smask,
            )
        elif self.kind == "path":
            out.update(fill=self.fill, stroke=self.stroke, segments=self.segments)
        return out


@dataclass
class PageModel:
    """Everything the engine knows about one page at one revision."""

    page_index: int
    digest: str
    nodes: list[Ins]  # the page's instruction list (with forms flattened when requested)
    objects: list[PageObject]
    frame: PageFrame
    clean_at: list[bool]  # position p (0..n): an object can be inserted before node p
    ctm_at: list[Matrix]  # CTM in effect before node p (n + 1 entries)
    res: Any  # the resources dictionary the instructions refer to
    res_owned: bool = False
    flattened: bool = False
    inlined: set[str] = field(default_factory=set)  # page XObject names inlined by flattening
    by_id: dict[str, PageObject] = field(default_factory=dict)
    by_key: dict[Key, PageObject] = field(default_factory=dict)

    def id_of(self, obj: PageObject) -> str:
        return obj.id

    def to_json(self, objects: list[PageObject] | None = None) -> list[dict[str, Any]]:
        return [o.to_json(self.frame, self.page_index) for o in (objects or self.objects)]


def make_id(page_index: int, digest: str, ordinal: int) -> str:
    return f"p{page_index}:{digest}:{ordinal}"


def parse_id(value: str) -> tuple[int, str, int] | None:
    m = _ID.match(value)
    if m is None:
        return None
    return int(m.group(1)), m.group(2), int(m.group(3))


def hex_of(colour: Colour | None) -> str | None:
    """A colour as '#rrggbb' (CMYK converted naively, named spaces only when 1 or 3 values)."""
    if colour is None:
        return None
    kind, comps = colour
    if kind == "gray":
        g = comps[0]
        return _hex(g, g, g)
    if kind == "rgb":
        return _hex(*comps)
    if kind == "cmyk":
        c, m, y, k = comps
        return _hex((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k))
    if kind == "named" and len(comps) == 1:
        return _hex(comps[0], comps[0], comps[0])
    if kind == "named" and len(comps) == 3:
        return _hex(*comps)
    return None


def _hex(r: float, g: float, b: float) -> str:
    def byte(v: float) -> int:
        return max(0, min(255, round(v * 255)))

    return f"#{byte(r):02x}{byte(g):02x}{byte(b):02x}"
