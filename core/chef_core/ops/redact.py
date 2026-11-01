"""Redaction (T6.07, J6 'che thông tin mật').

- ``redact.find`` (read-only): matches of patterns on the pages. A pattern is ``literal``
  (text, with or without diacritics), ``regex``, or a built-in: ``cccd`` (CCCD/CMND), ``phone``,
  ``email``, ``bankAccount`` (digits after STK / số tài khoản / account), ``taxCode``, ``date``.
  Each match has an id and one rectangle per line (displayed frame, points, origin top-left).
- ``redact.apply`` ({patterns, matchIds, rects, fill, alsoMetadata, removeFromAnnotations}): with
  ``patterns`` alone every match is redacted; with ``matchIds`` only those. Really
  removes what lies under the chosen areas. Text glyphs and vector parts inside them are cut out of
  the content, image pixels are painted with ``fill`` inside the image bytes, annotations that touch
  them are deleted (widget values too), the redacted strings are removed from the document
  information, outline titles and XMP (``alsoMetadata``), page thumbnails are deleted, and the
  areas are then painted. Afterwards the saved file is checked by a second reader
  (``chef_core.content.redact.verify``). If any redacted text is still there, the operation fails
  with ``REDACTION_VERIFY_FAILED`` and the session stays as it was.
  ``overlayText`` (e.g. 'ĐÃ CHE') is drawn centred in every painted box, shrunk to fit, white on a
  dark fill and black otherwise. It is added after the check, to the verified file: the label is
  not one of the redacted strings, and its glyphs would otherwise look like text left in the box.

Matches are identified by page, order on the page and a digest of their text, so the ids of
``redact.find`` are valid for ``redact.apply`` as long as the document has not changed.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from typing import Any, Literal

import pypdfium2 as pdfium
from pydantic import Field

from chef_core.content.erase import (
    CutOptions,
    cut_page,
    paint_rects,
    rect_display_from_user,
    rect_user_from_display,
)
from chef_core.content.model import Rect
from chef_core.content.redact import remove_annotations, remove_thumbnails, scrub_metadata, verify
from chef_core.content.textfind import Hit, PatternSpec, display_rects, hit_ids, search
from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.overlay.engine import OverlayWriter, Placement, TextStyle
from chef_core.overlay.pagecontent import page_frame
from chef_core.pdf.io import atomic_save, open_pdf

_HEX = r"^#?[0-9a-fA-F]{6}$"
LABEL_MAX_PT = 28.0
LABEL_MIN_PT = 4.0


class RedactPattern(WireModel):
    """One search pattern. ``value`` is required for literal and regex."""

    kind: Literal["literal", "regex", "cccd", "phone", "email", "bankAccount", "taxCode", "date"]
    value: str | None = None
    ignore_diacritics: bool = True

    def spec(self) -> PatternSpec:
        return PatternSpec(self.kind, self.value, self.ignore_diacritics)


class RedactFindParams(WireModel):
    """Find the text to redact."""

    patterns: list[RedactPattern] = Field(min_length=1)
    pages: list[int] | None = Field(default=None, description="Limit to these 0-based pages.")


class ManualRect(WireModel):
    """An area to redact by hand (displayed frame, points, origin top-left)."""

    page_index: int = Field(ge=0)
    rect: list[float] = Field(min_length=4, max_length=4)


class RedactApplyParams(WireModel):
    """Redact the matches (ids from redact.find) and the manual areas."""

    patterns: list[RedactPattern] = Field(default_factory=list)
    match_ids: list[str] = Field(default_factory=list)
    rects: list[ManualRect] = Field(default_factory=list)
    fill: str = Field(default="#000000", pattern=_HEX, description="Colour of the boxes.")
    also_metadata: bool = Field(default=True, description="Also scrub information and XMP.")
    remove_from_annotations: bool = Field(
        default=True, description="Delete annotations and form values in the areas."
    )
    overlay_text: str | None = Field(
        default=None,
        min_length=1,
        max_length=60,
        description="Label drawn centred in each redacted box, e.g. 'ĐÃ CHE'.",
    )


def _specs(patterns: list[RedactPattern]) -> list[PatternSpec]:
    return [p.spec() for p in patterns]


def _found(
    path: str, pdf: Any, patterns: list[RedactPattern], pages: list[int] | None
) -> list[tuple[str, Hit]]:
    doc = pdfium.PdfDocument(path)
    try:
        hits = search(doc, lambda i: page_frame(pdf.pages[i]), _specs(patterns), pages)
    finally:
        doc.close()
    return list(zip(hit_ids(hits), hits, strict=True))


def _rgb(value: str) -> tuple[int, int, int]:
    text = value.lstrip("#")
    r, g, b = (int(text[i : i + 2], 16) for i in (0, 2, 4))
    return (r, g, b)


def _label_colour(fill: tuple[int, int, int]) -> tuple[float, float, float]:
    luminance = 0.2126 * fill[0] + 0.7152 * fill[1] + 0.0722 * fill[2]
    return (0.0, 0.0, 0.0) if luminance > 140 else (1.0, 1.0, 1.0)


def _draw_labels(
    ctx: OpContext,
    regions: dict[int, list[Rect]],
    fill: tuple[int, int, int],
    text: str,
) -> int:
    """Draw ``text`` centred in every redacted box of the verified result, shrunk until it fits
    (90% of the box). A box too small for even the smallest size gets no label, with a warning."""
    result = ctx.result_path
    assert result is not None
    drawn = 0
    pdf = open_pdf(result)
    try:
        writer = OverlayWriter(
            pdf, kind="text", group=_new_id(), label="redaction label", warn=ctx.warn
        )
        colour = _label_colour(fill)
        for index in sorted(regions):
            frame = page_frame(pdf.pages[index])
            for rect in regions[index]:
                x0, top, x1, bottom = rect_display_from_user(frame, rect)
                width, height = x1 - x0, bottom - top
                size = min(LABEL_MAX_PT, height * 0.6)
                piece = None
                while size >= LABEL_MIN_PT:
                    candidate = writer.text(
                        text, TextStyle(font_size=size, bold=True, color=colour)
                    )
                    if candidate.width <= width * 0.9 and candidate.height <= height * 0.9:
                        piece = candidate
                        break
                    size *= 0.9
                if piece is None:
                    ctx.warn(f"No label on page {index + 1}: the redacted box is too small.")
                    continue
                left = x0 + (width - piece.width) / 2
                upper = top + (height - piece.height) / 2
                writer.place(index, piece, Placement(x=left, y=upper, anchor="top-left"))
                drawn += 1
        writer.commit()
        atomic_save(pdf, result, before_replace=pdf.close)
    finally:
        pdf.close()
    return drawn


@operation(id="redact.find", title="Find text to redact", group="redact", params=RedactFindParams)
def redact_find(ctx: OpContext, p: RedactFindParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("redact.find needs a session")
    with ctx.open_input() as pdf:
        if p.pages is not None and any(i < 0 or i >= len(pdf.pages) for i in p.pages):
            raise invalid_params("PAGE_OUT_OF_RANGE", {"pages": p.pages})
        found = _found(str(ctx.input_path), pdf, p.patterns, p.pages)
        matches = []
        for ident, hit in found:
            frame = page_frame(pdf.pages[hit.page_index])
            matches.append(
                {
                    "id": ident,
                    "pageIndex": hit.page_index,
                    "pattern": hit.pattern,
                    "text": hit.text,
                    "rects": display_rects(frame, hit.rects),
                }
            )
    return OpOutput(changed_pages=[], data={"matches": matches, "count": len(matches)})


@operation(
    id="redact.apply",
    title="Redact",
    group="redact",
    params=RedactApplyParams,
    destructive=True,
)
def redact_apply(ctx: OpContext, p: RedactApplyParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("redact.apply needs a session")
    if not p.match_ids and not p.patterns and not p.rects:
        raise invalid_params("NOTHING_TO_REDACT", {"hint": "give patterns, matchIds or rects"})
    fill8 = _rgb(p.fill)
    fill_f = (fill8[0] / 255, fill8[1] / 255, fill8[2] / 255)
    regions: dict[int, list[Rect]] = defaultdict(list)
    texts: list[str] = []
    with ctx.open_input() as pdf:
        if p.match_ids or (p.patterns and not p.rects):
            known = dict(_found(str(ctx.input_path), pdf, p.patterns, None))
            chosen = list(dict.fromkeys(p.match_ids)) if p.match_ids else list(known)
            missing = [i for i in chosen if i not in known]
            if missing:
                raise invalid_params("MATCH_NOT_FOUND", {"ids": missing})
            for ident in chosen:
                hit = known[ident]
                regions[hit.page_index].extend(hit.rects)
                texts.append(hit.text)
        for manual in p.rects:
            if manual.page_index >= len(pdf.pages):
                raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": manual.page_index})
            frame = page_frame(pdf.pages[manual.page_index])
            regions[manual.page_index].append(rect_user_from_display(frame, manual.rect))
        removed_annots = 0
        pages_done: list[int] = []
        totals = {"removedObjects": 0, "splitObjects": 0, "modifiedImages": 0, "clippedObjects": 0}
        for index in sorted(regions):
            page = pdf.pages[index]
            rects = regions[index]
            opts = CutOptions(image_fill="color", colour=fill8, partial=True)
            editor, stats = cut_page(pdf, page, index, rects, opts, flatten=True)
            for reason in stats.skipped:
                ctx.warn(reason)
            totals["removedObjects"] += stats.removed
            totals["splitObjects"] += stats.split
            totals["modifiedImages"] += stats.images
            totals["clippedObjects"] += stats.clipped
            paint_rects(editor, rects, fill_f)
            editor.write()
            if p.remove_from_annotations:
                removed_annots += remove_annotations(page, rects)
            pages_done.append(index)
        remove_thumbnails(pdf)
        scrubbed = scrub_metadata(pdf, texts) if p.also_metadata else {}
        ctx.save_document(pdf)
    assert ctx.result_path is not None
    leaks = verify(ctx.result_path, texts, dict(regions))
    if leaks:
        raise ChefError(
            ErrorKind.REDACTION_VERIFY_FAILED,
            "Redacted text is still present in the saved file",
            {"leaks": [leak.to_json() for leak in leaks]},
        )
    labels = 0
    if p.overlay_text:
        labels = _draw_labels(ctx, dict(regions), fill8, p.overlay_text)
    return OpOutput(
        changed_pages=pages_done,
        data={
            "redacted": sum(len(r) for r in regions.values()),
            "pages": pages_done,
            "removedAnnotations": removed_annots,
            "scrubbed": scrubbed,
            "labels": labels,
            **totals,
            "verification": {"ok": True, "leaks": []},
        },
    )


def _new_id() -> str:
    return uuid.uuid4().hex


__all__ = ["RedactApplyParams", "RedactFindParams", "RedactPattern", "redact_apply", "redact_find"]
