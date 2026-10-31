"""Render PDF pages to PNG with pypdfium2 (annotations/appearance streams included)."""

from __future__ import annotations

from pathlib import Path

import pypdfium2 as pdfium


def render_page(pdf: Path, page_index: int, out_png: Path, *, scale: float = 1.0,
                crop_pt: tuple[float, float, float, float] | None = None) -> Path:
    """Render one page. crop_pt = (x0, y0, x1, y1) in PDF points (origin bottom-left)."""
    doc = pdfium.PdfDocument(str(pdf))
    doc.init_forms()  # needed so widget (signature) appearances are drawn
    try:
        page = doc[page_index]
        w, h = page.get_size()
        kwargs = {}
        if crop_pt:
            x0, y0, x1, y1 = crop_pt
            kwargs["crop"] = (x0, y0, w - x1, h - y1)  # left, bottom, right, top margins
        img = page.render(scale=scale, may_draw_forms=True, draw_annots=True, **kwargs).to_pil()
        # 128-colour palette keeps the committed evidence PNGs small
        img = img.convert("RGB").quantize(colors=128)
        out_png.parent.mkdir(parents=True, exist_ok=True)
        img.save(out_png, optimize=True)
        del page
        return out_png
    finally:
        doc.close()
