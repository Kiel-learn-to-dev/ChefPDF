"""Editing existing text (milestone v0.7, D8/D10): read lines, check text, edit a line, find and
replace. See ``chef_core.text`` for the model and the planner.

- ``text.getLines`` (read-only) {pageIndex, includeArtifacts?}: lines, paragraphs and blocks of a
  page. Line ids (``L<page>:<digest>:<n>``) are valid until the page changes.
- ``text.checkText`` (read-only) {lineId, newText, keepStyle?}: supported?, missing characters,
  and the font the edit would use. No change.
- ``text.listFonts`` (read-only): the replacement fonts of the registry.
- ``text.layer`` (read-only): how many pages have a text layer (B12: a scan has none).
- ``text.editLine`` (destructive) {pageIndex, lineId, newText, fontStrategy, fontName?, keepStyle,
  fitWidth}: one line. Empty text deletes the line.
- ``text.findReplace`` (destructive) {find, replace, caseSensitive, ignoreDiacritics, wholeWord,
  regex, pages?, preview, fontStrategy, fontName?, keepStyle, fitWidth}: across the document,
  line by line. ``preview`` returns the matches and what would change, without changing the file.

Stale ids (another revision of the page) give ``STALE_OBJECT_IDS``. A line that needs characters no
font has gives ``TEXT_GLYPH_MISSING`` with the list in ``missing``; in findReplace such lines are
reported in ``skipped`` instead.
"""

from __future__ import annotations

from typing import Any, Literal

import pypdfium2 as pdfium
from pydantic import Field

from chef_core.content.editor import PageEditor
from chef_core.errors import ChefError, invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.text.build import build_text_page
from chef_core.text.edit import (
    EditOptions,
    FontBook,
    LinePlan,
    apply_plan,
    font_cap,
    plan_line,
    probe_text,
    real_char_indices,
)
from chef_core.text.find import apply_spans, find_spans, replacement_for
from chef_core.text.fonts import load_registry
from chef_core.text.model import TextLine, TextPage, parse_line_id
from chef_core.text.system_fonts import system_entries

FontStrategy = Literal["auto", "keep", "replace"]
FitWidth = Literal["none", "shrink", "track"]


def _parse(line_id: str) -> tuple[int, str]:
    parsed = parse_line_id(line_id)
    if parsed is None:
        raise invalid_params("INVALID_LINE_ID", {"lineId": line_id})
    return parsed[0], parsed[1]


def _page_index(pdf_pages: int, index: int) -> None:
    if index >= pdf_pages:
        raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": index})


def _line_for(tp: TextPage, line_id: str, digest: str) -> TextLine:
    if tp.digest != digest:
        raise invalid_params("STALE_OBJECT_IDS", {"ids": [line_id]})
    line = tp.line(line_id)
    if line is None:
        raise invalid_params("LINE_NOT_FOUND", {"lineId": line_id})
    return line


def _options(
    font_strategy: str, font_name: str | None, keep_style: bool, fit_width: str
) -> EditOptions:
    opts = EditOptions(
        font_strategy=font_strategy,
        font_name=font_name,
        keep_style=keep_style,
        fit_width=fit_width,
    )
    opts.validate()
    return opts


def _glyphs_json(tp: TextPage, line: TextLine) -> list[list[float]]:
    """Displayed [left, right] of every character of line.text (one pair per display index).

    An inferred space (no character of the page) takes the right edge of the character before it,
    so the pairs stay in reading order and the selection can point at any index of the text.
    """
    out: list[list[float]] = []
    edge = tp.display_box(line.bbox)[0]
    for index in line.display_map:
        if index is None:
            out.append([edge, edge])
            continue
        c = line.chars[index]
        left, _, right, _ = tp.display_box((c.x0, c.y0, c.x1, c.y1))
        out.append([round(left, 3), round(right, 3)])
        edge = round(right, 3)
    return out


def _line_json(tp: TextPage, line: TextLine) -> dict[str, Any]:
    cap = font_cap(tp, line.runs[0].font)
    can_any = any(cap.can(ch) for ch in line.text if not ch.isspace())
    return {
        "id": line.id,
        "pageIndex": line.page_index,
        "text": line.text,
        "bbox": [round(v, 3) for v in tp.display_box(line.bbox)],
        "glyphs": _glyphs_json(tp, line),
        "fontName": line.font_name,
        "fontSize": round(line.font_size, 3),
        "bold": line.bold,
        "italic": line.italic,
        "style": line.style,
        "colour": line.colour,
        "renderMode": line.render_mode,
        "artifact": line.artifact,
        "editable": line.editable,
        "canEncodeAny": can_any,
        "role": line.role,
        "align": line.align,
        "listMarker": line.list_marker,
        "paragraphId": line.paragraph_id,
        "blockId": line.block_id,
    }


def _plan_json(plan: LinePlan) -> dict[str, Any]:
    return {
        "action": plan.action,
        "fontFrom": plan.font_from,
        "fontTo": plan.font_to,
        "fit": plan.fit,
        "fontSize": round(plan.size, 3),
        "tracking": round(plan.tracking, 3),
        "width": round(plan.width, 3),
        "overflow": round(plan.overflow, 3),
        "missing": plan.missing,
        "warnings": plan.warnings,
    }


# -- read-only --------------------------------------------------------------------------------


class TextGetLinesParams(WireModel):
    """Lines of one page with their boxes (displayed frame, points, origin top-left)."""

    page_index: int = Field(ge=0, description="0-based page.")
    include_artifacts: bool = Field(
        default=False, description="Also list text marked as /Artifact (watermarks, page numbers)."
    )


@operation(
    id="text.getLines", title="Text lines of a page", group="text", params=TextGetLinesParams
)
def get_lines(ctx: OpContext, p: TextGetLinesParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("text.getLines needs a session")
    with ctx.open_input() as pdf:
        _page_index(len(pdf.pages), p.page_index)
        tp = build_text_page(pdf, pdf.pages[p.page_index], p.page_index)
        lines = [ln for ln in tp.lines if p.include_artifacts or not ln.artifact]
        display_w, display_h = tp.frame.display_size
        return OpOutput(
            changed_pages=[],
            data={
                "pageIndex": p.page_index,
                "digest": tp.digest,
                "displayWidth": display_w,
                "displayHeight": display_h,
                "rotation": tp.frame.rotation,
                "lines": [_line_json(tp, ln) for ln in lines],
                "paragraphs": [
                    {
                        "id": para.id,
                        "lineIds": para.line_ids,
                        "align": para.align,
                        "indent": para.indent,
                        "role": para.role,
                        "blockId": para.block_id,
                    }
                    for para in tp.paragraphs
                ],
                "blocks": [
                    {
                        "id": block.id,
                        "paragraphIds": block.paragraph_ids,
                        "bbox": [round(v, 3) for v in tp.display_box(block.bbox)],
                    }
                    for block in tp.blocks
                ],
            },
        )


class TextCheckTextParams(WireModel):
    """Would this text fit the line's font? Changes nothing."""

    line_id: str = Field(description="Line id from text.getLines.")
    new_text: str = ""
    keep_style: bool = True


@operation(
    id="text.checkText", title="Check text for a line", group="text", params=TextCheckTextParams
)
def check_text(ctx: OpContext, p: TextCheckTextParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("text.checkText needs a session")
    index, digest = _parse(p.line_id)
    with ctx.open_input() as pdf:
        _page_index(len(pdf.pages), index)
        tp = build_text_page(pdf, pdf.pages[index], index)
        line = _line_for(tp, p.line_id, digest)
        opts = _options("auto", None, p.keep_style, "none")
        return OpOutput(changed_pages=[], data=probe_text(tp, line, p.new_text, opts))


class TextListFontsParams(WireModel):
    """The replacement fonts of the registry (no parameters)."""


@operation(id="text.listFonts", title="Replacement fonts", group="text", params=TextListFontsParams)
def list_fonts(ctx: OpContext, p: TextListFontsParams) -> OpOutput:
    """The bundled fonts, then the fonts installed on this computer (source: bundled | system)."""
    del ctx, p
    bundled = [(f, "bundled") for f in load_registry()]
    installed = [(f, "system") for f in system_entries()]
    return OpOutput(
        changed_pages=[],
        data={
            "fonts": [
                {
                    "id": f.id,
                    "family": f.family,
                    "style": f.style,
                    "bold": f.bold,
                    "italic": f.italic,
                    "coverage": f.coverage,
                    "license": f.license,
                    "source": source,
                }
                for f, source in bundled + installed
            ]
        },
    )


# -- destructive ------------------------------------------------------------------------------


class TextEditLineParams(WireModel):
    """Replace the text of one line. Empty text deletes the line."""

    page_index: int = Field(ge=0)
    line_id: str
    new_text: str
    font_strategy: FontStrategy = Field(
        default="auto",
        description="auto: keep the font when it writes everything, else replace. "
        "keep: never replace (error when characters are missing). replace: always replace.",
    )
    font_name: str | None = Field(
        default=None, description="Replacement font id from text.listFonts (implies replace)."
    )
    keep_style: bool = Field(
        default=True,
        description="Replacement font follows the bold/italic/serif style of the line.",
    )
    fit_width: FitWidth = Field(
        default="none",
        description=(
            "none: the line may grow. shrink: lower the size (to 80%). track: lower spacing."
        ),
    )


@operation(
    id="text.editLine",
    title="Edit a line of text",
    group="text",
    params=TextEditLineParams,
    destructive=True,
)
def edit_line(ctx: OpContext, p: TextEditLineParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("text.editLine needs a session")
    index, digest = _parse(p.line_id)
    if index != p.page_index:
        raise invalid_params("LINE_NOT_ON_PAGE", {"lineId": p.line_id, "pageIndex": p.page_index})
    opts = _options(p.font_strategy, p.font_name, p.keep_style, p.fit_width)
    changed: list[int] = []
    with ctx.open_input() as pdf:
        _page_index(len(pdf.pages), index)
        page = pdf.pages[index]
        tp = build_text_page(pdf, page, index)
        line = _line_for(tp, p.line_id, digest)
        plan = plan_line(tp, line, p.new_text, opts)
        if plan.action != "none":
            book = FontBook(pdf)
            if plan.subst is not None:
                book.need(plan.subst.font_id, plan.subst.codepoints)
            book.build()
            editor = PageEditor(pdf, page, tp.model)
            apply_plan(editor, tp, plan, book)
            editor.write()
            changed.append(index)
            ctx.save_document(pdf)
    for message in plan.warnings:
        ctx.warn(message)
    return OpOutput(
        changed_pages=changed,
        data={"lineId": p.line_id, "changed": bool(changed), **_plan_json(plan)},
    )


class TextFindReplaceParams(WireModel):
    """Find and replace text across the document, line by line."""

    find: str = Field(min_length=1)
    replace: str = ""
    case_sensitive: bool = False
    ignore_diacritics: bool = False
    whole_word: bool = False
    regex: bool = Field(
        default=False, description="Python regular expression; \\1 refers to groups."
    )
    pages: list[int] | None = Field(default=None, description="0-based pages (default: all).")
    preview: bool = Field(default=False, description="List the matches without changing the file.")
    font_strategy: FontStrategy = "auto"
    font_name: str | None = None
    keep_style: bool = True
    fit_width: FitWidth = "none"


def _rect_of(tp: TextPage, line: TextLine, start: int, end: int) -> list[float]:
    """Displayed box (points) of the real characters between two display indices."""
    chars = [line.chars[i] for i in real_char_indices(line, start, end)]
    if not chars:
        return [0.0, 0.0, 0.0, 0.0]
    rect = (
        min(c.x0 for c in chars),
        min(c.y0 for c in chars),
        max(c.x1 for c in chars),
        max(c.y1 for c in chars),
    )
    return [round(v, 3) for v in tp.display_box(rect)]


@operation(
    id="text.findReplace",
    title="Find and replace text",
    group="text",
    params=TextFindReplaceParams,
    destructive=True,
)
def find_replace(ctx: OpContext, p: TextFindReplaceParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("text.findReplace needs a session")
    opts = _options(p.font_strategy, p.font_name, p.keep_style, p.fit_width)
    matches: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    substitutions: list[dict[str, Any]] = []
    work: list[tuple[int, TextPage, list[LinePlan]]] = []
    per_line: dict[str, int] = {}
    with ctx.open_input() as pdf:
        indices = sorted(set(p.pages)) if p.pages is not None else list(range(len(pdf.pages)))
        for index in indices:
            _page_index(len(pdf.pages), index)
            tp = build_text_page(pdf, pdf.pages[index], index)
            plans: list[LinePlan] = []
            for line in tp.lines:
                spans = find_spans(
                    line.text,
                    line.display_map,
                    p.find,
                    regex=p.regex,
                    case_sensitive=p.case_sensitive,
                    ignore_diacritics=p.ignore_diacritics,
                    whole_word=p.whole_word,
                )
                if not spans:
                    continue
                if line.artifact:
                    skipped.append({"pageIndex": index, "lineId": line.id, "reason": "ARTIFACT"})
                    continue
                reps = [replacement_for(s, line.text, p.replace, p.regex) for s in spans]
                new_text = apply_spans(line.text, spans, reps)
                try:
                    plan = plan_line(tp, line, new_text, opts)
                except ChefError as exc:
                    detail = exc.detail or {}
                    skipped.append(
                        {
                            "pageIndex": index,
                            "lineId": line.id,
                            "reason": exc.message,
                            "missing": detail.get("missing", []),
                        }
                    )
                    continue
                if plan.action == "none":
                    continue
                plans.append(plan)
                per_line[line.id] = len(spans)
                for span, rep in zip(spans, reps, strict=True):
                    matches.append(
                        {
                            "pageIndex": index,
                            "lineId": line.id,
                            "before": line.text[span.start : span.end],
                            "after": rep,
                            "rect": _rect_of(tp, line, span.start, span.end),
                            "fit": plan.fit,
                            "fontSize": round(plan.size, 3),
                            "tracking": round(plan.tracking, 3),
                            "overflow": round(plan.overflow, 3),
                            "fontTo": plan.font_to,
                        }
                    )
                if plan.subst is not None:
                    substitutions.append(
                        {
                            "pageIndex": index,
                            "lineId": line.id,
                            "from": plan.font_from,
                            "to": plan.font_to,
                        }
                    )
            if plans:
                work.append((index, tp, plans))
        changed: list[int] = []
        replaced = 0
        if not p.preview and work:
            book = FontBook(pdf)
            for _index, _tp, plans in work:
                for plan in plans:
                    if plan.subst is not None:
                        book.need(plan.subst.font_id, plan.subst.codepoints)
            book.build()
            for index, tp, plans in work:
                editor = PageEditor(pdf, pdf.pages[index], tp.model)
                for plan in plans:
                    apply_plan(editor, tp, plan, book)
                    replaced += per_line[plan.line_id]
                editor.write()
                changed.append(index)
            ctx.save_document(pdf)
    for item in skipped:
        ctx.warn(f"Bỏ qua dòng {item['lineId']}: {item['reason']}")
    return OpOutput(
        changed_pages=changed,
        data={
            "matches": matches,
            "replaced": replaced,
            "fontSubstitutions": substitutions,
            "skipped": skipped,
            "preview": p.preview,
        },
    )


class TextLayerParams(WireModel):
    """How many pages have a text layer (no parameters)."""


@operation(
    id="text.layer", title="Text layer of the document", group="text", params=TextLayerParams
)
def text_layer(ctx: OpContext, p: TextLayerParams) -> OpOutput:
    """A page has a text layer when the renderer finds characters on it (a scan has none)."""
    del p
    if ctx.input_path is None:
        raise RuntimeError("text.layer needs a session")
    doc = pdfium.PdfDocument(str(ctx.input_path))
    try:
        with_text = 0
        for index in range(len(doc)):
            page = doc[index]
            textpage = page.get_textpage()
            if textpage.count_chars() > 0:
                with_text += 1
            textpage.close()
            page.close()
        pages = len(doc)
    finally:
        doc.close()
    return OpOutput(changed_pages=[], data={"pages": pages, "textPages": with_text})


__all__ = [
    "TextCheckTextParams",
    "TextEditLineParams",
    "TextFindReplaceParams",
    "TextGetLinesParams",
    "TextLayerParams",
    "TextListFontsParams",
    "check_text",
    "edit_line",
    "find_replace",
    "get_lines",
    "list_fonts",
    "text_layer",
]
