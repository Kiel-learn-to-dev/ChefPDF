"""Paragraph text edits (milestone v0.7, D9): re-flow a paragraph, or change its style only.

- ``text.editParagraph`` (destructive) {pageIndex, paragraphId, newText, ...style}: replaces the
  text of one paragraph and re-flows it inside its box (see ``chef_core.text.paragraph``). A
  newText with ``\\n`` makes hard breaks; empty text deletes the paragraph.
- ``text.styleParagraph`` (destructive) {pageIndex, paragraphId, ...style}: the same paragraph
  drawn again with other size, colour, weight, slant, alignment or leading; the text is unchanged.

Style fields (both ops):

- fontStrategy: auto | keep | replace (auto: keep the font when it writes everything, else a
  registry font; bold/italic changes always use a registry font).
- fontName: a registry font id (text.listFonts), overrides fontStrategy.
- keepStyle: a registry font follows the family class (sans, serif, mono) of the paragraph.
- align: "keep" | left | right | center | justify.
- lineSpacing: "keep" (the leading ratio of the paragraph) or a pitch in points.
- fontSize: "keep" or points.
- color: "keep" or "#rrggbb".
- bold / italic: "keep" or true/false.
- boxWidth: "keep" (the right edge of the text block) or points.

Result: action (reflow | delete), fontFrom, fontTo, fontSize, lineCount, pitch, boxWidth, height,
overflow (points the text reaches past the next block or the page bottom), overlapsBlockIds,
missing (characters the chosen font cannot write) and warnings. Paragraph ids of an older
revision give STALE_OBJECT_IDS.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import Field

from chef_core.content.editor import PageEditor
from chef_core.errors import invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.text.build import build_text_page
from chef_core.text.edit import FontBook
from chef_core.text.paragraph import (
    ParagraphOptions,
    apply_paragraph,
    parse_paragraph_id,
    plan_json,
    plan_paragraph,
)

FontStrategy = Literal["auto", "keep", "replace"]
Align = Literal["keep", "left", "right", "center", "justify"]


class _StyleFields(WireModel):
    font_strategy: FontStrategy = Field(
        default="auto",
        description="auto: keep the font when it writes everything, else a registry font. "
        "keep: never change the font (error when characters are missing). replace: always a "
        "registry font.",
    )
    font_name: str | None = Field(
        default=None, description="Registry font id (text.listFonts); overrides fontStrategy."
    )
    keep_style: bool = Field(
        default=True, description="A registry font follows the sans/serif/mono class of the text."
    )
    align: Align = Field(default="keep", description="Alignment of the lines.")
    line_spacing: Literal["keep"] | float = Field(
        default="keep", description="keep: the leading ratio of the paragraph; or a pitch in pt."
    )
    font_size: Literal["keep"] | float = Field(default="keep", description="keep or points.")
    color: Literal["keep"] | str = Field(default="keep", description="keep or #rrggbb.")
    bold: Literal["keep"] | bool = Field(default="keep", description="keep or true/false.")
    italic: Literal["keep"] | bool = Field(default="keep", description="keep or true/false.")
    box_width: Literal["keep"] | float = Field(
        default="keep", description="keep: up to the right edge of the text block; or points."
    )


def _options(p: _StyleFields) -> ParagraphOptions:
    def num(value: Any) -> float | None:
        return None if value == "keep" else float(value)

    def flag(value: Any) -> bool | None:
        return None if value == "keep" else bool(value)

    colour = None if p.color == "keep" else str(p.color)
    opts = ParagraphOptions(
        font_strategy=p.font_strategy,
        font_name=p.font_name,
        keep_style=p.keep_style,
        align=p.align,
        line_spacing=num(p.line_spacing),
        font_size=num(p.font_size),
        color=colour,
        bold=flag(p.bold),
        italic=flag(p.italic),
        box_width=num(p.box_width),
    )
    opts.validate()
    return opts


def _check_page(pdf_pages: int, index: int) -> None:
    if index >= pdf_pages:
        raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": index})


def _run(
    ctx: OpContext,
    page_index: int,
    para_id: str,
    new_text: str | None,
    opts: ParagraphOptions,
) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("paragraph ops need a session")
    parsed = parse_paragraph_id(para_id)
    if parsed is None:
        raise invalid_params("INVALID_PARAGRAPH_ID", {"paragraphId": para_id})
    if parsed[0] != page_index:
        raise invalid_params(
            "PARAGRAPH_NOT_ON_PAGE", {"paragraphId": para_id, "pageIndex": page_index}
        )
    changed: list[int] = []
    with ctx.open_input() as pdf:
        _check_page(len(pdf.pages), page_index)
        page = pdf.pages[page_index]
        tp = build_text_page(pdf, page, page_index)
        plan = plan_paragraph(tp, para_id, new_text, opts)
        book = FontBook(pdf)
        if plan.font_id is not None:
            book.need(plan.font_id, plan.codepoints)
        book.build()
        editor = PageEditor(pdf, page, tp.model)
        apply_paragraph(editor, tp, plan, book)
        editor.write()
        changed.append(page_index)
        ctx.save_document(pdf)
    for message in plan.warnings:
        ctx.warn(message)
    return OpOutput(changed_pages=changed, data={"changed": bool(changed), **plan_json(plan)})


class TextEditParagraphParams(_StyleFields):
    """Replace the text of one paragraph and re-flow it in its box."""

    page_index: int = Field(ge=0, description="0-based page.")
    paragraph_id: str = Field(description="Paragraph id from text.getLines.")
    new_text: str = Field(description="New text; \\n makes a hard break; empty deletes.")


@operation(
    id="text.editParagraph",
    title="Edit a paragraph of text",
    group="text",
    params=TextEditParagraphParams,
    destructive=True,
)
def edit_paragraph(ctx: OpContext, p: TextEditParagraphParams) -> OpOutput:
    return _run(ctx, p.page_index, p.paragraph_id, p.new_text, _options(p))


class TextStyleParagraphParams(_StyleFields):
    """Change the style of one paragraph; its text is kept."""

    page_index: int = Field(ge=0, description="0-based page.")
    paragraph_id: str = Field(description="Paragraph id from text.getLines.")


@operation(
    id="text.styleParagraph",
    title="Change the style of a paragraph",
    group="text",
    params=TextStyleParagraphParams,
    destructive=True,
)
def style_paragraph(ctx: OpContext, p: TextStyleParagraphParams) -> OpOutput:
    return _run(ctx, p.page_index, p.paragraph_id, None, _options(p))


__all__ = [
    "TextEditParagraphParams",
    "TextStyleParagraphParams",
    "edit_paragraph",
    "style_paragraph",
]
