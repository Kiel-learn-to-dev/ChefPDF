"""Image bytes for the exporters: the images of a document model (N4) and vector figures rendered
from the page. Opens the source PDF lazily; the caller closes it (``with Assets(...)``)."""

from __future__ import annotations

import io
import zlib
from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
from pikepdf import Name
from PIL import Image

from chef_core.content.engine import build_model
from chef_core.content.model import PageModel, parse_id
from chef_core.pdf.io import open_pdf

RENDER_SCALE = 2.0  # pixels per point for rendered figures
Bbox = tuple[float, float, float, float]


def _is_dct(stream: pikepdf.Stream) -> bool:
    return "/DCTDecode" in str(stream.get("/Filter", ""))


def _png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    if img.mode not in ("L", "RGB", "RGBA"):
        img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
    img.save(buf, format="PNG")
    return buf.getvalue()


class Assets:
    """Extracts image bytes by object id (``p<page>:<digest>:<n>``) and renders figure regions."""

    def __init__(self, path: Path | None, password: str | None = None) -> None:
        self.path = path
        self.password = password
        self._pdf: pikepdf.Pdf | None = None
        self._pages: dict[int, PageModel] = {}
        self._rendered: dict[int, Any] = {}
        self._doc: Any = None

    def __enter__(self) -> Assets:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        if self._pdf is not None:
            self._pdf.close()
            self._pdf = None
        self._doc = None
        self._pages.clear()
        self._rendered.clear()

    def _open(self) -> pikepdf.Pdf:
        if self.path is None:
            raise RuntimeError("no source document for the images")
        if self._pdf is None:
            self._pdf = open_pdf(self.path, self.password)
        return self._pdf

    def _page_model(self, index: int) -> PageModel | None:
        pdf = self._open()
        if not 0 <= index < len(pdf.pages):
            return None
        if index not in self._pages:
            self._pages[index] = build_model(pdf, pdf.pages[index], index)
        return self._pages[index]

    def image(self, ref: str) -> tuple[bytes, str] | None:
        """(bytes, 'jpg' | 'png') of the image object, or None when it cannot be read."""
        parsed = parse_id(ref)
        if parsed is None:
            return None
        model = self._page_model(parsed[0])
        if model is None:
            return None
        obj = model.by_id.get(ref)
        if obj is None or obj.kind != "image" or obj.image_name is None:
            return None
        table = model.res.get("/XObject")
        if table is None or Name(obj.image_name) not in table:
            return None
        stream = table[Name(obj.image_name)]
        if not isinstance(stream, pikepdf.Stream):
            return None
        if _is_dct(stream):
            return stream.read_raw_bytes(), "jpg"
        return self._decode(stream)

    @staticmethod
    def _decode(stream: pikepdf.Stream) -> tuple[bytes, str] | None:
        try:
            img = pikepdf.PdfImage(stream).as_pil_image()
            if "/SMask" in stream:
                smask = stream["/SMask"]
                assert isinstance(smask, pikepdf.Stream)
                alpha = pikepdf.PdfImage(smask).as_pil_image().convert("L")
                if alpha.size != img.size:
                    alpha = alpha.resize(img.size)
                img = img.convert("RGB").convert("RGBA")
                img.putalpha(alpha)
            return _png_bytes(img), "png"
        except (pikepdf.PdfError, ValueError, OSError, NotImplementedError, zlib.error):
            return None

    def region(self, page: int, bbox: Bbox) -> bytes | None:
        """A PNG of the page region ``bbox`` (display points, top-left origin)."""
        if self.path is None:
            return None
        if self._doc is None:
            self._doc = pdfium.PdfDocument(str(self.path), password=self.password)
        if page not in self._rendered:
            bitmap = self._doc[page].render(scale=RENDER_SCALE)
            self._rendered[page] = bitmap.to_pil().convert("RGB")
        full = self._rendered[page]
        x0, y0, x1, y1 = (round(v * RENDER_SCALE) for v in bbox)
        x0, y0 = max(0, x0), max(0, y0)
        x1, y1 = min(full.size[0], x1), min(full.size[1], y1)
        if x1 <= x0 or y1 <= y0:
            return None
        return _png_bytes(full.crop((x0, y0, x1, y1)))
