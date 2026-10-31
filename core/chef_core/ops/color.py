"""Colour conversion (feature M6): grayscale, black & white, ink saving, replace a colour.

``color.convert`` rewrites the colour operators of the selected pages (and of the forms they
draw) and the pixels of their images. Text is not touched: its characters stay as they are.

- ``gray``: every colour becomes gray (luminance 0.299 R + 0.587 G + 0.114 B); images are
  converted to 8-bit gray.
- ``blackwhite``: every colour is thresholded to black or white at ``threshold``; images are
  thresholded (or dithered with Floyd-Steinberg when ``dithering`` is on).
- ``ink-saver``: colours move toward white by ``amount`` (CMYK inks are scaled down by
  ``1 - amount``); text colours stay as they are so that the text remains dark.
- ``replace-color``: a colour within ``tolerance`` (per channel, 0..255) of ``sourceColor`` becomes
  ``targetColor``, in vector operators and in image pixels.

Colours the rewriter cannot read (Separation/DeviceN spot colours, Lab, patterns, shadings) are
kept and reported as warnings. The operation is destructive: it changes the page content, so it
is blocked on signed documents.
"""

from __future__ import annotations

import io
import re
import zlib
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

import pikepdf
from pikepdf import Name
from PIL import Image, ImageChops
from pydantic import Field, model_validator

from chef_core.errors import invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.ops.compress import _decode, _filters, _skip_reason
from chef_core.pdf.content import walk_page
from chef_core.pdf.io import atomic_save

ColorOp = Literal["gray", "blackwhite", "ink-saver", "replace-color"]
Kind = Literal["gray", "rgb", "cmyk", "other"]
_HEX = re.compile(r"^#?([0-9a-fA-F]{6})$")
_COLOUR_OPS = {"g": "gray", "rg": "rgb", "k": "cmyk", "G": "gray", "RG": "rgb", "K": "cmyk"}
_OUT_OPS: dict[tuple[str, Kind], str] = {
    ("fill", "gray"): "g",
    ("fill", "rgb"): "rg",
    ("fill", "cmyk"): "k",
    ("stroke", "gray"): "G",
    ("stroke", "rgb"): "RG",
    ("stroke", "cmyk"): "K",
}


class ColorConvertParams(WireModel):
    """Change colours on the selected pages."""

    mode: ColorOp
    pages: list[int] | None = Field(default=None, min_length=1, description="0-based; default all.")
    threshold: int = Field(default=128, ge=0, le=255, description="blackwhite: the cut-off.")
    dithering: bool = Field(default=False, description="blackwhite: dither the images.")
    amount: float = Field(default=0.5, ge=0, le=1, description="ink-saver: how far to lighten.")
    source_color: str | None = Field(default=None, description="replace-color: '#rrggbb'.")
    target_color: str | None = Field(default=None, description="replace-color: '#rrggbb'.")
    tolerance: int = Field(default=24, ge=0, le=255, description="replace-color: per channel.")

    @model_validator(mode="after")
    def _check_replace(self) -> ColorConvertParams:
        if self.mode == "replace-color":
            for name, value in (
                ("sourceColor", self.source_color),
                ("targetColor", self.target_color),
            ):
                if value is None or _HEX.match(value) is None:
                    raise ValueError(f"{name} must be '#rrggbb' for replace-color")
        return self


def _rgb_of(text: str) -> tuple[int, int, int]:
    m = _HEX.match(text)
    if m is None:
        raise invalid_params("colour must be #rrggbb", {"field": "color"})
    value = m.group(1)
    return int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16)


@dataclass(frozen=True)
class _Plan:
    mode: ColorOp
    threshold: int
    dithering: bool
    amount: float
    source: tuple[int, int, int] | None
    target: tuple[int, int, int] | None
    tolerance: int


def _plan(p: ColorConvertParams) -> _Plan:
    return _Plan(
        mode=p.mode,
        threshold=p.threshold,
        dithering=p.dithering,
        amount=p.amount,
        source=_rgb_of(p.source_color) if p.source_color else None,
        target=_rgb_of(p.target_color) if p.target_color else None,
        tolerance=p.tolerance,
    )


# -- colour arithmetic ----------------------------------------------------------------


def _to_rgb(kind: Kind, comps: list[float]) -> tuple[float, float, float]:
    if kind == "gray":
        return comps[0], comps[0], comps[0]
    if kind == "rgb":
        return comps[0], comps[1], comps[2]
    c, m, y, k = comps
    return (1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)


def _luminance(r: float, g: float, b: float) -> float:
    return 0.299 * r + 0.587 * g + 0.114 * b


def _transform(
    plan: _Plan, kind: Kind, comps: list[float], in_text: bool
) -> tuple[Kind, list[float]] | None:
    """New (kind, components) for a colour, or None when it stays."""
    if plan.mode == "gray":
        if kind == "gray":
            return None
        r, g, b = _to_rgb(kind, comps)
        return "gray", [_luminance(r, g, b)]
    if plan.mode == "blackwhite":
        value = comps[0] if kind == "gray" else _luminance(*_to_rgb(kind, comps))
        return "gray", [1.0 if value >= plan.threshold / 255 else 0.0]
    if plan.mode == "ink-saver":
        if in_text:
            return None
        a = plan.amount
        if kind == "gray":
            return "gray", [v + (1 - v) * a for v in comps]
        if kind == "rgb":
            return "rgb", [v + (1 - v) * a for v in comps]
        if kind == "cmyk":
            return "cmyk", [v * (1 - a) for v in comps]
        return None
    # replace-color
    assert plan.source is not None and plan.target is not None
    r, g, b = _to_rgb(kind, comps)
    rgb255 = (round(r * 255), round(g * 255), round(b * 255))
    if max(abs(x - y) for x, y in zip(rgb255, plan.source, strict=True)) <= plan.tolerance:
        return "rgb", [v / 255 for v in plan.target]
    return None


# -- content streams ------------------------------------------------------------------


@dataclass
class _Report:
    colours_changed: int = 0
    kept: dict[str, int] = field(default_factory=dict)

    def keep(self, reason: str) -> None:
        self.kept[reason] = self.kept.get(reason, 0) + 1


def _space_kind(obj: Any, resources: Any) -> Kind:
    """Colour family of a colour space given by name (or array), resolving resource names."""
    if isinstance(obj, pikepdf.Name):
        text = str(obj)
        if text == "/DeviceGray" or text == "/G":
            return "gray"
        if text == "/DeviceRGB" or text == "/RGB":
            return "rgb"
        if text == "/DeviceCMYK" or text == "/CMYK":
            return "cmyk"
        table = resources.get("/ColorSpace") if isinstance(resources, pikepdf.Dictionary) else None
        if isinstance(table, pikepdf.Dictionary) and text in table:
            return _space_kind(table[text], None)
        return "other"
    if isinstance(obj, pikepdf.Array) and len(obj) > 0:
        family = str(obj[0])
        if family == "/ICCBased" and len(obj) > 1 and isinstance(obj[1], pikepdf.Stream):
            kinds: dict[int, Kind] = {1: "gray", 3: "rgb", 4: "cmyk"}
            return kinds.get(int(obj[1].get("/N", 0)), "other")
        if family in ("/DeviceGray", "/CalGray"):
            return "gray"
        if family in ("/DeviceRGB", "/CalRGB"):
            return "rgb"
        if family == "/DeviceCMYK":
            return "cmyk"
    return "other"


_CS_NUMBER_OPS = {"sc": "fill", "scn": "fill", "SC": "stroke", "SCN": "stroke"}


_COLOUR_SETTERS = {"g", "G", "rg", "RG", "k", "K", "sc", "scn", "SC", "SCN", "cs", "CS"}
_TEXT_SHOW = {"Tj", "TJ", "'", '"'}
_PAINT = {"f", "F", "f*", "S", "s", "B", "B*", "b", "b*", "n", "sh", "Do"}


def _colour_is_for_text(instructions: list[tuple[list[Any], pikepdf.Operator]], start: int) -> bool:
    """True when the colour set at ``start`` is next used to show text (before any painting)."""
    for _, operator in instructions[start + 1 :]:
        op = str(operator)
        if op in _TEXT_SHOW:
            return True
        if op in _COLOUR_SETTERS or op in _PAINT or op in ("q", "Q"):
            return False
    return False


def _rewrite(
    instructions: list[tuple[list[Any], pikepdf.Operator]],
    resources: Any,
    plan: _Plan,
    report: _Report,
) -> list[tuple[list[Any], pikepdf.Operator]]:
    fill: Kind = "gray"
    stroke: Kind = "gray"
    stack: list[tuple[Kind, Kind]] = []
    out: list[tuple[list[Any], pikepdf.Operator]] = []
    for position, (operands, operator) in enumerate(instructions):
        op = str(operator)
        in_text = op in _COLOUR_SETTERS and _colour_is_for_text(instructions, position)
        if op == "q":
            stack.append((fill, stroke))
        elif op == "Q":
            fill, stroke = stack.pop() if stack else ("gray", "gray")
        elif op == "cs" and operands:
            fill = _space_kind(operands[0], resources)
        elif op == "CS" and operands:
            stroke = _space_kind(operands[0], resources)
        if op in _COLOUR_OPS and len(operands) == _arity(op):
            side = "stroke" if op in ("G", "RG", "K") else "fill"
            kind: Kind = _COLOUR_OPS[op]  # type: ignore[assignment]
            comps = [float(v) for v in operands]
            result = _transform(plan, kind, comps, in_text and plan.mode == "ink-saver")
            if result is None:
                out.append((operands, operator))
            else:
                new_kind, new_comps = result
                out.append((new_comps, pikepdf.Operator(_OUT_OPS[(side, new_kind)])))
                report.colours_changed += 1
            if side == "fill":
                fill = result[0] if result else kind
            else:
                stroke = result[0] if result else kind
            continue
        if op in _CS_NUMBER_OPS:
            side = _CS_NUMBER_OPS[op]
            kind = fill if side == "fill" else stroke
            if operands and isinstance(operands[-1], pikepdf.Name):
                report.keep("pattern colour")
                out.append((operands, operator))
                continue
            if kind == "other":
                report.keep("spot or other colour space")
                out.append((operands, operator))
                continue
            comps = [float(v) for v in operands]
            if len(comps) != {"gray": 1, "rgb": 3, "cmyk": 4}[kind]:
                out.append((operands, operator))
                continue
            result = _transform(plan, kind, comps, in_text and plan.mode == "ink-saver")
            if result is None:
                out.append((operands, operator))
            else:
                new_kind, new_comps = result
                out.append((new_comps, pikepdf.Operator(_OUT_OPS[(side, new_kind)])))
                report.colours_changed += 1
                if side == "fill":
                    fill = new_kind
                else:
                    stroke = new_kind
            continue
        out.append((operands, operator))
    return out


def _arity(op: str) -> int:
    return {"g": 1, "G": 1, "rg": 3, "RG": 3, "k": 4, "K": 4}[op]


def _unparse(instructions: list[tuple[list[Any], pikepdf.Operator]]) -> bytes:
    return bytes(pikepdf.unparse_content_stream(instructions))


def _forms(resources: Any, seen: set[tuple[int, int]], depth: int = 0) -> list[pikepdf.Stream]:
    """Form XObjects reachable from ``resources`` (each once)."""
    found: list[pikepdf.Stream] = []
    if depth > 16 or not isinstance(resources, pikepdf.Dictionary):
        return found
    table = resources.get("/XObject")
    if not isinstance(table, pikepdf.Dictionary):
        return found
    for value in table.values():
        if not isinstance(value, pikepdf.Stream) or value.get("/Subtype") != Name.Form:
            continue
        if value.is_indirect:
            if value.objgen in seen:
                continue
            seen.add(value.objgen)
        found.append(value)
        inner = value.get("/Resources")
        found.extend(_forms(inner if inner is not None else resources, seen, depth + 1))
    return found


# -- images ---------------------------------------------------------------------------


def _set_device(obj: pikepdf.Object, mode: str) -> None:
    obj.ColorSpace = {"L": Name.DeviceGray, "RGB": Name.DeviceRGB, "CMYK": Name.DeviceCMYK}[mode]
    for key in ("/DecodeParms", "/Decode"):
        if key in obj:
            del obj[key]


def _ink_lut(amount: float) -> Callable[[int], int]:
    return lambda v: round(v + (255 - v) * amount)


def _image_change(img: Image.Image, plan: _Plan) -> Image.Image | None:
    """The changed picture, or None when no pixel changes."""
    if plan.mode == "gray":
        return img.convert("L")
    if plan.mode == "blackwhite":
        gray = img.convert("L")
        if plan.dithering:
            return gray.convert("1", dither=Image.Dither.FLOYDSTEINBERG).convert("L")
        return gray.point(lambda v: 255 if v >= plan.threshold else 0)
    if plan.mode == "ink-saver":
        if img.mode == "CMYK":
            keep = 1 - plan.amount
            return img.point(lambda v: round(v * keep))
        return img.point(_ink_lut(plan.amount))
    assert plan.source is not None and plan.target is not None
    rgb = img.convert("RGB")
    source_img = Image.new("RGB", rgb.size, plan.source)
    diff = ImageChops.difference(rgb, source_img)
    tol = plan.tolerance
    mask = None
    for band in diff.split():
        within = band.point(lambda v: 255 if v <= tol else 0)
        mask = within if mask is None else ImageChops.multiply(mask, within)
    if mask is None or mask.getbbox() is None:
        return None
    target_img = Image.new("RGB", rgb.size, plan.target)
    return Image.composite(target_img, rgb, mask)


def _encode(img: Image.Image, dct: bool) -> tuple[bytes, Name]:
    if dct and img.mode in ("L", "RGB", "CMYK"):
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=92)
        return buf.getvalue(), Name.DCTDecode
    return zlib.compress(img.tobytes(), 9), Name.FlateDecode


def _change_image(obj: pikepdf.Object, plan: _Plan, report: _Report) -> bool:
    reason = _skip_reason(obj, shared_smask=False)
    if reason is not None:
        report.keep(reason)
        return False
    img = _decode(obj)
    if img is None:
        report.keep("undecodable image")
        return False
    if img.mode == "P":
        img = img.convert("RGB")
    if img.mode not in ("L", "RGB", "CMYK"):
        report.keep("colour space")
        return False
    changed = _image_change(img, plan)
    if changed is None:
        return False
    data, filt = _encode(changed, dct="/DCTDecode" in _filters(obj))
    obj.write(data, filter=filt)
    obj.Width, obj.Height = changed.size
    obj.BitsPerComponent = 8
    _set_device(obj, changed.mode)
    return True


# -- the operation --------------------------------------------------------------------


@operation(
    id="color.convert",
    title="Convert colours",
    group="color",
    params=ColorConvertParams,
    destructive=True,
    batchable=True,
)
def convert(ctx: OpContext, p: ColorConvertParams) -> OpOutput:
    plan = _plan(p)
    report = _Report()
    images_changed = 0
    pages_changed = 0
    with ctx.open_input() as pdf:
        count = len(pdf.pages)
        selected = list(range(count)) if p.pages is None else sorted(set(p.pages))
        bad = [i for i in selected if i < 0 or i >= count]
        if bad:
            raise invalid_params("page index out of range", {"field": "pages", "pageCount": count})
        seen_forms: set[tuple[int, int]] = set()
        image_done: set[tuple[int, int]] = set()
        for done, index in enumerate(selected):
            ctx.progress(done, len(selected), "colours")
            page = pdf.pages[index]
            resources = page.resources
            # The page content first, then the forms it draws (each form once).
            targets: list[tuple[pikepdf.Object, Any, bool]] = [(page.obj, resources, True)]
            for form in _forms(resources, seen_forms):
                inner = form.get("/Resources")
                targets.append((form, inner if inner is not None else resources, False))
            for stream, res, is_page in targets:
                ctx.check_cancelled()
                before = report.colours_changed
                instructions = [
                    (list(item.operands), item.operator)
                    for item in pikepdf.parse_content_stream(stream)
                ]
                new = _rewrite(instructions, res, plan, report)
                if report.colours_changed == before:
                    continue
                if is_page:
                    page.obj.Contents = pdf.make_stream(_unparse(new))
                    pages_changed += 1
                else:
                    stream.write(_unparse(new))
                    if "/Filter" in stream:
                        del stream["/Filter"]
            info = walk_page(page)
            for gen, placement in info.images.items():
                if gen in image_done:
                    continue
                image_done.add(gen)
                if _change_image(placement.image, plan, report):
                    images_changed += 1
        if pages_changed or images_changed or report.colours_changed:
            ctx.check_cancelled()
            assert ctx.result_path is not None
            atomic_save(pdf, ctx.result_path)
            ctx.modified = True
    for reason, n in sorted(report.kept.items()):
        ctx.warn(f"{n} {reason} kept as it is.")
    return OpOutput(
        changed_pages=selected if ctx.modified else [],
        data={
            "coloursChanged": report.colours_changed,
            "imagesChanged": images_changed,
            "pagesChanged": pages_changed,
            "kept": dict(sorted(report.kept.items())),
        },
    )
