"""Independent check of an edit (T6.01, spike S2 section 4.3).

The editor decides what to change; this module checks the result with a different engine
(PDFium, the same renderer the viewer uses). Pixels outside the boxes that an edit may touch
must be the same before and after. Used by the tests and by the operations' self-checks.
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image, ImageChops

Box = Sequence[float]


def render_rgb(path: Path | str, page_index: int = 0, dpi: int = 72) -> Image.Image:
    doc = pdfium.PdfDocument(str(path))
    try:
        page = doc[page_index]
        try:
            rendered: Image.Image = page.render(scale=dpi / 72).to_pil().convert("RGB")
            return rendered
        finally:
            page.close()
    finally:
        doc.close()


def user_box_to_pixels(
    box: Box, page_height: float, scale: float = 1.0, pad: float = 0.0
) -> tuple[int, int, int, int]:
    """A user-space box (unrotated page, origin bottom-left) as pixel (l, t, r, b)."""
    x0, y0, x1, y1 = box
    return (
        int((min(x0, x1) - pad) * scale),
        int((page_height - max(y0, y1) - pad) * scale),
        int((max(x0, x1) + pad) * scale + 1),
        int((page_height - min(y0, y1) + pad) * scale + 1),
    )


def max_difference_outside(
    before: Path | str,
    after: Path | str,
    page_index: int,
    boxes: Sequence[Box],
    *,
    pad: float = 2.0,
    dpi: int = 72,
) -> int:
    """Largest per-channel difference between the two renderings outside ``boxes`` (grown by
    ``pad`` points). Only valid for pages without /Rotate."""
    img_a = render_rgb(before, page_index, dpi)
    img_b = render_rgb(after, page_index, dpi)
    if img_a.size != img_b.size:
        raise AssertionError(f"page size changed: {img_a.size} -> {img_b.size}")
    scale = dpi / 72
    height = img_a.size[1] / scale
    mask = Image.new("L", img_a.size, 0)
    from PIL import ImageDraw

    draw = ImageDraw.Draw(mask)
    for box in boxes:
        draw.rectangle(user_box_to_pixels(box, height, scale, pad), fill=255)
    diff = ImageChops.difference(img_a, img_b).convert("L")
    outside = Image.new("L", img_a.size, 0)
    outside.paste(diff, mask=Image.eval(mask, lambda v: 0 if v else 255))
    if not outside.getbbox():
        return 0
    extrema = outside.getextrema()
    return int(extrema[1]) if isinstance(extrema[1], int) else 0


def assert_unchanged_outside(
    before: Path | str,
    after: Path | str,
    page_index: int,
    boxes: Sequence[Box],
    *,
    tolerance: int = 0,
    pad: float = 2.0,
) -> None:
    worst = max_difference_outside(before, after, page_index, boxes, pad=pad)
    if worst > tolerance:
        raise AssertionError(f"pixels outside the edited boxes changed (max diff {worst})")
