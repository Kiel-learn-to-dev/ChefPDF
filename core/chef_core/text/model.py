"""Text model of a page (T7.01): characters -> lines -> paragraphs -> blocks.

Built from the paint objects of the flattened page model (``build_model(flatten=True)``), so that
text inside forms is visible and editable. Every line keeps the text objects (``runs``) that
draw it, so an edit can find the operators to rewrite or delete.

Ids are ``L<page>:<digest>:<n>`` for lines, ``P..`` for paragraphs and ``B..`` for blocks, with
the same digest as object ids: an id from an older revision is refused as stale.

Not handled: rotated and vertical text (those characters are left out of the model), right-to-
left scripts, and text whose ToUnicode is missing (its characters show as '?').
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from chef_core.content.model import PageModel, PageObject, Rect
from chef_core.signing.anchors import PageFrame

ALIGNS = ("left", "center", "right", "justify")
ROLES = ("body", "heading", "list")

_LINE_ID = re.compile(r"^L(\d+):([0-9a-f]{12}):(\d+)$")


@dataclass(eq=False)
class TextChar:
    ch: str
    run: int  # index of the run (text object) in the page's run list
    tok: int  # index of the glyph token in the run's token list
    x0: float  # user space: start of the advance along the baseline
    x1: float  # end of the advance (includes character spacing)
    baseline: float  # user y of the glyph origin
    size: float  # effective font size in user units
    y0: float  # glyph box, user space
    y1: float
    code: int = -1
    # style of the run that drew the character (used by the document model, D12/N1)
    bold: bool = False
    italic: bool = False
    font: str = ""
    colour: str | None = None


@dataclass(eq=False)
class TextLine:
    id: str
    page_index: int
    index: int  # position in reading order on the page
    text: str  # what the user sees and edits (spaces inferred from gaps are included)
    chars: list[TextChar]
    display_map: list[int | None]  # display index -> char index (None: inferred space)
    runs: list[PageObject]  # the text objects drawing the line, in paint order
    font_name: str  # BaseFont without the subset tag
    font_size: float
    bold: bool
    italic: bool
    style: str  # sans | serif | mono
    colour: str | None
    render_mode: int
    artifact: bool
    bbox: Rect  # user space
    baseline: float
    editable: bool = True
    paragraph_id: str | None = None
    block_id: str | None = None
    role: str = "body"
    align: str = "left"
    list_marker: bool = False

    @property
    def width(self) -> float:
        return self.bbox[2] - self.bbox[0]


@dataclass(eq=False)
class TextParagraph:
    id: str
    line_ids: list[str]
    align: str
    indent: float
    role: str
    block_id: str | None = None


@dataclass(eq=False)
class TextBlock:
    id: str
    paragraph_ids: list[str]
    bbox: Rect


@dataclass(eq=False)
class TextPage:
    page_index: int
    digest: str
    frame: PageFrame
    lines: list[TextLine]
    paragraphs: list[TextParagraph]
    blocks: list[TextBlock]
    model: PageModel
    by_id: dict[str, TextLine] = field(default_factory=dict)
    caps: dict[str, Any] = field(default_factory=dict)  # font resource name -> FontCapability

    def line(self, line_id: str) -> TextLine | None:
        return self.by_id.get(line_id)

    def display_box(self, rect: Rect) -> tuple[float, float, float, float]:
        """A user-space box in the displayed frame (points, origin top-left, y down)."""
        x0, y0, x1, y1 = self.frame.rect_to_display(rect)
        height = self.frame.display_size[1]
        return (x0, height - y1, x1, height - y0)


def make_line_id(page_index: int, digest: str, n: int) -> str:
    return f"L{page_index}:{digest}:{n}"


def make_paragraph_id(page_index: int, digest: str, n: int) -> str:
    return f"P{page_index}:{digest}:{n}"


def make_block_id(page_index: int, digest: str, n: int) -> str:
    return f"B{page_index}:{digest}:{n}"


def parse_line_id(value: str) -> tuple[int, str, int] | None:
    m = _LINE_ID.match(value)
    return None if m is None else (int(m.group(1)), m.group(2), int(m.group(3)))
