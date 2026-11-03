"""Document model (T10.01, D21): the structured form of a PDF with text (N1-N7).

A ``DocModel`` is JSON on the wire (camelCase, see ``chef_core.models.WireModel``). Every block
has a ``kind`` (the discriminator), a ``bbox`` in display points (origin top-left, y down, the
same frame as the text model), a ``readingOrder`` (0-based position on its page), ``sourceRefs``
(text-model ids: line ids ``L..``, paragraph ids ``P..``, object ids ``p..``) and a
``confidence`` in [0, 1]. Changing ``kind`` (for example heading -> paragraph in the review
screen) keeps the rest of the block.

The schema is exported to ``layout/schema.json`` (``python -m chef_core.layout.schema``).
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field

from chef_core.models import WireModel

BBox = tuple[float, float, float, float]
Lang = str

MAX_HEADING_LEVEL = 6


class Run(WireModel):
    """A piece of text with one style. ``link`` is ``https://...`` (uri), ``page:<n>`` (a page
    of this document, 0-based) or a file/named target as written in the PDF."""

    text: str
    bold: bool = False
    italic: bool = False
    underline: bool = False
    size: float | None = None
    font: str | None = None
    color: str | None = Field(default=None, description="#rrggbb")
    link: str | None = None
    sup: bool = False
    sub: bool = False


class _Block(WireModel):
    bbox: BBox
    reading_order: int = Field(default=0, ge=0)
    source_refs: list[str] = Field(default_factory=list)
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)


class Heading(_Block):
    kind: Literal["heading"] = "heading"
    level: int = Field(ge=1, le=MAX_HEADING_LEVEL)
    runs: list[Run] = Field(default_factory=list)


class Paragraph(_Block):
    kind: Literal["paragraph"] = "paragraph"
    runs: list[Run] = Field(default_factory=list)
    joined_pages: list[int] = Field(
        default_factory=list,
        description="Pages whose first paragraph continues this one (0-based).",
    )


class ListItem(WireModel):
    runs: list[Run] = Field(default_factory=list)
    marker: str | None = Field(default=None, description="The marker as printed (e.g. '1.', '•').")
    children: list[ListItem] = Field(default_factory=list)
    bbox: BBox | None = Field(
        default=None,
        description="Detected item bounds in display points; absent in hand-edited/older models.",
    )


class ListBlock(_Block):
    kind: Literal["list"] = "list"
    ordered: bool
    items: list[ListItem] = Field(default_factory=list)


class TableCell(WireModel):
    row_span: int = Field(default=1, ge=1)
    col_span: int = Field(default=1, ge=1)
    blocks: list[Block] = Field(default_factory=list)


class Table(_Block):
    kind: Literal["table"] = "table"
    has_header_row: bool = False
    columns: int = Field(default=0, ge=0)
    rows: list[list[TableCell]] = Field(
        default_factory=list,
        description="One list per row; only the anchor cell of a span is listed (its top-left).",
    )


class Image(_Block):
    kind: Literal["image"] = "image"
    image_ref: str | None = Field(default=None, description="Object id of the image (N4 exports).")
    caption: str | None = None


class Figure(_Block):
    """A vector drawing (clusters of paths that are not a table)."""

    kind: Literal["figure"] = "figure"
    rendered_ref: str | None = Field(default=None, description="PNG of the region, if rendered.")
    caption: str | None = None


class Header(_Block):
    kind: Literal["header"] = "header"
    runs: list[Run] = Field(default_factory=list)


class Footer(_Block):
    kind: Literal["footer"] = "footer"
    runs: list[Run] = Field(default_factory=list)


class PageNumber(_Block):
    kind: Literal["pageNumber"] = "pageNumber"
    runs: list[Run] = Field(default_factory=list)


class Footnote(_Block):
    kind: Literal["footnote"] = "footnote"
    runs: list[Run] = Field(default_factory=list)


class Separator(_Block):
    """A horizontal rule (a thin path wider than it is high)."""

    kind: Literal["separator"] = "separator"


class Unknown(_Block):
    kind: Literal["unknown"] = "unknown"
    runs: list[Run] = Field(default_factory=list)
    reason: str | None = None


Block = Annotated[
    Heading
    | Paragraph
    | ListBlock
    | Table
    | Image
    | Figure
    | Header
    | Footer
    | PageNumber
    | Footnote
    | Separator
    | Unknown,
    Field(discriminator="kind"),
]

BLOCK_KINDS = (
    "heading",
    "paragraph",
    "list",
    "table",
    "image",
    "figure",
    "header",
    "footer",
    "pageNumber",
    "footnote",
    "separator",
    "unknown",
)

# header, footer and page numbers are repeated page furniture; exporters skip them by default.
FURNITURE_KINDS = ("header", "footer", "pageNumber")


class SourceInfo(WireModel):
    name: str
    page_count: int = Field(ge=0)


class PageInfo(WireModel):
    index: int = Field(ge=0)
    width: float
    height: float
    rotation: int = 0
    blocks: list[Block] = Field(default_factory=list)


class StyleDef(WireModel):
    font: str | None = None
    size: float | None = None
    bold: bool = False
    italic: bool = False
    color: str | None = None


class Meta(WireModel):
    title: str | None = None
    author: str | None = None
    lang: Lang | None = None


class DocModel(WireModel):
    version: int = Field(default=1, ge=1)
    source: SourceInfo
    pages: list[PageInfo] = Field(default_factory=list)
    styles: dict[str, StyleDef] = Field(default_factory=dict)
    meta: Meta = Field(default_factory=Meta)


ListItem.model_rebuild()
TableCell.model_rebuild()
Table.model_rebuild()
ListBlock.model_rebuild()
PageInfo.model_rebuild()
DocModel.model_rebuild()


def block_kinds(model: DocModel) -> dict[str, int]:
    """Number of blocks of each kind (every kind listed, zero when absent)."""
    counts = dict.fromkeys(BLOCK_KINDS, 0)
    for page in model.pages:
        for block in page.blocks:
            counts[block.kind] += 1
    return counts


def dump_json(model: DocModel) -> str:
    """Stable JSON text (same model, same bytes)."""
    return model.model_dump_json(by_alias=True, indent=2)


def json_schema() -> dict[str, object]:
    return DocModel.model_json_schema(by_alias=True)
