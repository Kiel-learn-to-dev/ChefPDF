"""Image placements in page content (T6.04): replace, adjust, extract.

An object id from ``content.listObjects`` of kind ``image`` names one placement (one ``Do`` or one
inline image). Every operation writes a *new* image XObject and points only this placement at it,
so the other placements of a shared image keep the original.

- ``content.replaceImage``: the new PNG/JPEG is drawn in the placement's box. ``fit`` decides how it
  fills the box (``stretch``, ``contain`` keeps proportions and centres, ``cover`` fills and clips).
  ``keepAspectBox`` = false forces ``stretch``. A PNG alpha channel becomes an /SMask.
- ``content.adjustImage``: crop (pixels), rotate (90 steps, clockwise), flip, grayscale, invert,
  brightness, contrast, saturation (-100..100) and gamma. A JPEG stays JPEG when it has no alpha.
  If the proportions change, the image is fitted (contain) into the old box.
- ``content.extractImage`` (read-only): writes the image as it is in the file: the raw JPEG bytes
  for DCT images written to a .jpg path, otherwise a PNG of the decoded pixels.
"""

from __future__ import annotations

import io
import zlib
from pathlib import Path
from typing import Any, Literal

import pikepdf
from pikepdf import Name
from PIL import Image, ImageEnhance, ImageOps
from pydantic import Field

from chef_core.content.editor import prepare
from chef_core.content.model import Ins
from chef_core.errors import invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.overlay.pagecontent import category

Fit = Literal["stretch", "contain", "cover"]
_COLOUR_SPACE = {"L": Name.DeviceGray, "RGB": Name.DeviceRGB, "CMYK": Name.DeviceCMYK}


# -- decoding and encoding ------------------------------------------------------------------


def _decode(stream: pikepdf.Stream) -> tuple[Image.Image, Image.Image | None]:
    """The pixels of an image XObject (colour and alpha), converted to RGB or gray."""
    img = pikepdf.PdfImage(stream).as_pil_image()
    alpha: Image.Image | None = None
    if "/SMask" in stream:
        smask = stream["/SMask"]
        assert isinstance(smask, pikepdf.Stream)
        alpha = pikepdf.PdfImage(smask).as_pil_image().convert("L")
    if img.mode not in ("L", "RGB"):
        img = img.convert("L" if img.mode in ("1", "LA", "I", "F") else "RGB")
    if alpha is not None and alpha.size != img.size:
        alpha = alpha.resize(img.size)
    return img, alpha


def _new_xobject(
    pdf: pikepdf.Pdf,
    img: Image.Image,
    alpha: Image.Image | None,
    jpeg: bytes | None = None,
) -> pikepdf.Stream:
    """An image XObject: DCT when ``jpeg`` bytes are given and there is no alpha, else Flate."""
    width, height = img.size
    common: dict[str, Any] = {
        "Type": Name.XObject,
        "Subtype": Name.Image,
        "Width": width,
        "Height": height,
        "BitsPerComponent": 8,
    }
    if jpeg is not None and alpha is None and img.mode in ("L", "RGB"):
        data = jpeg
        filt = Name.DCTDecode
        space = _COLOUR_SPACE[img.mode]
    else:
        data = zlib.compress(img.tobytes(), 9)
        filt = Name.FlateDecode
        space = _COLOUR_SPACE[img.mode]
    stream = pdf.make_stream(data, ColorSpace=space, Filter=filt, **common)
    if alpha is not None:
        mask = pdf.make_stream(
            zlib.compress(alpha.tobytes(), 9),
            Type=Name.XObject,
            Subtype=Name.Image,
            Width=width,
            Height=height,
            BitsPerComponent=8,
            ColorSpace=Name.DeviceGray,
            Filter=Name.FlateDecode,
        )
        stream.SMask = mask
    return stream


def _load_source(path: str) -> tuple[Image.Image, Image.Image | None, bytes | None]:
    p = Path(path)
    if not p.is_file():
        raise invalid_params("FILE_NOT_FOUND", {"path": path})
    try:
        with Image.open(p) as im:
            im.load()
            fmt = im.format
            has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
            if has_alpha:
                rgba = im.convert("RGBA")
                return rgba.convert("RGB"), rgba.getchannel("A"), None
            jpeg = p.read_bytes() if fmt == "JPEG" and im.mode in ("L", "RGB") else None
            if im.mode in ("L", "1"):
                return im.convert("L"), None, jpeg
            return im.convert("RGB"), None, jpeg
    except (OSError, ValueError) as exc:
        raise invalid_params("UNREADABLE_IMAGE", {"path": path, "error": str(exc)}) from exc


# -- placements -----------------------------------------------------------------------------


def _image_object(pdf: pikepdf.Pdf, page_index: int, object_id: str) -> Any:
    page = pdf.pages[page_index]
    editor, targets = prepare(pdf, page, page_index, [object_id], flatten_forms=False)
    obj = targets[0]
    if obj.kind != "image":
        raise invalid_params("NOT_AN_IMAGE", {"id": object_id, "kind": obj.kind})
    return editor, obj


def _register(editor: Any, xobj: pikepdf.Stream) -> Name:
    table = category(editor.res, "/XObject")
    index = 0
    while Name(f"/ChefImg{index}") in table:
        index += 1
    name = Name(f"/ChefImg{index}")
    table[name] = xobj
    return name


def _place(editor: Any, obj: Any, name: Name, size: tuple[int, int], fit: Fit, keep: bool) -> None:
    """Draw ``name`` in the box of the placement, fitted by ``fit`` (box = unit square)."""
    key = obj.key
    ctm = obj.ctm
    box_w = (ctm[0] ** 2 + ctm[1] ** 2) ** 0.5
    box_h = (ctm[2] ** 2 + ctm[3] ** 2) ** 0.5
    pw, ph = size
    nodes = [Ins([], "q", key)]
    if keep and fit != "stretch" and box_w > 0 and box_h > 0 and pw > 0 and ph > 0:
        scale = min(box_w / pw, box_h / ph) if fit == "contain" else max(box_w / pw, box_h / ph)
        fx = pw * scale / box_w
        fy = ph * scale / box_h
        nodes.append(Ins([fx, 0, 0, fy, (1 - fx) / 2, (1 - fy) / 2], "cm", key))
        if fit == "cover":
            nodes += [Ins([0, 0, 1, 1], "re", key), Ins([], "W", key), Ins([], "n", key)]
    nodes += [Ins([name], "Do", key), Ins([], "Q", key)]
    editor.replace_object(obj, nodes)


def _drop_old(editor: Any, obj: Any) -> None:
    if obj.image_name:
        editor.drop_candidates.add(obj.image_name)


class ContentReplaceImageParams(WireModel):
    """Replace an image placement by another image file."""

    page_index: int = Field(ge=0)
    object_id: str
    path: str = Field(description="PNG or JPEG file.")
    fit: Fit = "contain"
    keep_aspect_box: bool = Field(
        default=True,
        description="False forces stretch: the image fills the old box.",
    )


@operation(
    id="content.replaceImage",
    title="Replace image",
    group="content",
    params=ContentReplaceImageParams,
    destructive=True,
)
def replace_image(ctx: OpContext, p: ContentReplaceImageParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("content.replaceImage needs a session")
    img, alpha, jpeg = _load_source(p.path)
    with ctx.open_input() as pdf:
        if p.page_index >= len(pdf.pages):
            raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": p.page_index})
        editor, obj = _image_object(pdf, p.page_index, p.object_id)
        xobj = _new_xobject(pdf, img, alpha, jpeg)
        name = _register(editor, xobj)
        _place(editor, obj, name, img.size, p.fit, p.keep_aspect_box)
        _drop_old(editor, obj)
        editor.write()
        ctx.save_document(pdf)
    return OpOutput(changed_pages=[p.page_index], data={"pixelSize": list(img.size)})


class CropBox(WireModel):
    x: int = Field(ge=0)
    y: int = Field(ge=0)
    w: int = Field(gt=0)
    h: int = Field(gt=0)


class ContentAdjustImageParams(WireModel):
    """Edit the pixels of one image placement; the result is a new image XObject."""

    page_index: int = Field(ge=0)
    object_id: str
    crop: CropBox | None = Field(default=None, description="Crop rectangle in pixels.")
    rotate: int = Field(default=0, description="Clockwise degrees: 0, 90, 180 or 270.")
    flip: Literal["none", "h", "v"] = "none"
    grayscale: bool = False
    invert: bool = False
    brightness: float = Field(default=0, ge=-100, le=100)
    contrast: float = Field(default=0, ge=-100, le=100)
    saturation: float = Field(default=0, ge=-100, le=100)
    gamma: float = Field(default=1.0, gt=0, le=10)


@operation(
    id="content.adjustImage",
    title="Adjust image",
    group="content",
    params=ContentAdjustImageParams,
    destructive=True,
)
def adjust_image(ctx: OpContext, p: ContentAdjustImageParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("content.adjustImage needs a session")
    if p.rotate not in (0, 90, 180, 270):
        raise invalid_params("INVALID_ROTATION", {"rotate": p.rotate})
    with ctx.open_input() as pdf:
        if p.page_index >= len(pdf.pages):
            raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": p.page_index})
        editor, obj = _image_object(pdf, p.page_index, p.object_id)
        if obj.inline:
            raise invalid_params("INLINE_IMAGE_NOT_SUPPORTED", {"id": p.object_id})
        stream = _stored_image(pdf, editor, obj)
        was_jpeg = stream.get("/Filter") == Name.DCTDecode
        old_size = (int(stream.Width), int(stream.Height))
        img, alpha = _decode(stream)
        if p.crop is not None:
            c = p.crop
            if c.x + c.w > img.size[0] or c.y + c.h > img.size[1]:
                raise invalid_params("CROP_OUTSIDE_IMAGE", {"size": list(img.size)})
            box = (c.x, c.y, c.x + c.w, c.y + c.h)
            img = img.crop(box)
            alpha = alpha.crop(box) if alpha is not None else None
        transpose = {
            90: Image.Transpose.ROTATE_270,
            180: Image.Transpose.ROTATE_180,
            270: Image.Transpose.ROTATE_90,
        }.get(p.rotate)
        if transpose is not None:
            img = img.transpose(transpose)
            alpha = alpha.transpose(transpose) if alpha is not None else None
        if p.flip == "h":
            img = ImageOps.mirror(img)
            alpha = ImageOps.mirror(alpha) if alpha is not None else None
        elif p.flip == "v":
            img = ImageOps.flip(img)
            alpha = ImageOps.flip(alpha) if alpha is not None else None
        img = _colour(img, p)
        jpeg: bytes | None = None
        if was_jpeg and alpha is None:
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=92)
            jpeg = buf.getvalue()
        name = _register(editor, _new_xobject(pdf, img, alpha, jpeg))
        aspect_changed = abs(img.size[0] / img.size[1] - old_size[0] / old_size[1]) > 0.01
        _place(editor, obj, name, img.size, "contain" if aspect_changed else "stretch", True)
        _drop_old(editor, obj)
        editor.write()
        ctx.save_document(pdf)
    return OpOutput(changed_pages=[p.page_index], data={"pixelSize": list(img.size)})


def _stored_image(pdf: pikepdf.Pdf, editor: Any, obj: Any) -> pikepdf.Stream:
    table = editor.res.get("/XObject")
    if obj.image_name is None or table is None or Name(obj.image_name) not in table:
        raise invalid_params("IMAGE_NOT_FOUND", {"id": obj.id})
    stream = table[Name(obj.image_name)]
    if not isinstance(stream, pikepdf.Stream):
        raise invalid_params("IMAGE_NOT_FOUND", {"id": obj.id})
    return stream


def _colour(img: Image.Image, p: ContentAdjustImageParams) -> Image.Image:
    if p.grayscale and img.mode != "L":
        img = img.convert("L")
    if p.brightness:
        img = ImageEnhance.Brightness(img).enhance(1 + p.brightness / 100)
    if p.contrast:
        img = ImageEnhance.Contrast(img).enhance(1 + p.contrast / 100)
    if p.saturation and img.mode == "RGB":
        img = ImageEnhance.Color(img).enhance(1 + p.saturation / 100)
    if p.gamma != 1.0:
        lut = [round(255 * ((i / 255) ** (1 / p.gamma))) for i in range(256)]
        img = img.point(lut * len(img.getbands()))
    if p.invert:
        img = ImageOps.invert(img)
    return img


class ContentExtractImageParams(WireModel):
    """Write the original image of a placement to a file."""

    page_index: int = Field(ge=0)
    object_id: str
    output_path: str


@operation(
    id="content.extractImage",
    title="Extract image",
    group="content",
    params=ContentExtractImageParams,
)
def extract_image(ctx: OpContext, p: ContentExtractImageParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("content.extractImage needs a session")
    out = Path(p.output_path)
    with ctx.open_input() as pdf:
        if p.page_index >= len(pdf.pages):
            raise invalid_params("PAGE_OUT_OF_RANGE", {"pageIndex": p.page_index})
        editor, obj = _image_object(pdf, p.page_index, p.object_id)
        if obj.inline:
            raise invalid_params("INLINE_IMAGE_NOT_SUPPORTED", {"id": p.object_id})
        stream = _stored_image(pdf, editor, obj)
        if stream.get("/Filter") == Name.DCTDecode and out.suffix.lower() in (".jpg", ".jpeg"):
            out.write_bytes(stream.read_raw_bytes())
        else:
            img, alpha = _decode(stream)
            if alpha is not None:
                img = img.convert("RGB") if img.mode == "L" else img
                img.putalpha(alpha)
            img.save(out, format="PNG")
    return OpOutput(
        changed_pages=[], outputs=[str(out)], data={"pixelSize": list(obj.pixel_size or ())}
    )
