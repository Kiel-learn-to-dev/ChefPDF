"""Compress PDF (feature M1): presets, image resampling and lossless clean-up.

Presets set image resolution and JPEG quality; any field given explicitly overrides the preset.

- ``compress.pdf``: session op on the current revision (destructive: it changes image data, so it
  is blocked on signed documents).
- ``compress.file``: standalone op for batch jobs, reads ``inputPath`` and writes ``outputPath``.
- ``compress.estimate``: session op, read-only. Runs the whole compression on the current
  revision and writes it to a temporary file to measure the result.
- ``compress.fitSize``: session op, read-only. Searches the image resolution and JPEG quality for
  the first setting whose measured size fits ``targetBytes`` (same search as ``scan.fitSize``).

Image rules (see ``_recode``): an image is re-encoded only when it has to change (it is above
``maxImageDpi``, grayscale is requested, a soft mask is flattened, or a JPEG gets a new quality).
Images with alpha or few colours stay lossless (Flate). Bilevel (1-bit, CCITT, JBIG2), stencil
masks, colour-key masks, JPEG 2000 and unusual colour spaces are kept as they are. A re-encoded
image replaces the original only when it is smaller, and images shared by several places are
processed once. ``/Decode`` is baked into the pixels and then removed.
"""

from __future__ import annotations

import io
import tempfile
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

import pikepdf
from pikepdf import Name
from PIL import Image, UnidentifiedImageError
from pydantic import Field

from chef_core.errors import invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.pdf.content import page_xobject_images, walk_page
from chef_core.pdf.io import atomic_save, open_pdf
from chef_core.pdf.pages import display_size

CompressPreset = Literal["screen", "ebook", "print", "archive-light", "custom"]
Objgen = tuple[int, int]

JPEG_DEFAULT_QUALITY = 85
SCALE_EPSILON = 0.98  # resample only when the image shrinks by more than 2 %
FEW_COLOURS = 256

PRESETS: dict[str, dict[str, Any]] = {
    "screen": {"max_image_dpi": 96, "jpeg_quality": 55, "remove_thumbnails": True},
    "ebook": {"max_image_dpi": 150, "jpeg_quality": 70, "remove_thumbnails": True},
    "print": {"max_image_dpi": 300, "jpeg_quality": 85, "remove_thumbnails": False},
    "archive-light": {"max_image_dpi": None, "jpeg_quality": None, "remove_thumbnails": False},
    "custom": {"max_image_dpi": None, "jpeg_quality": None, "remove_thumbnails": False},
}


class CompressParams(WireModel):
    """Compression settings. Fields left null take the value of the preset."""

    preset: CompressPreset = Field(
        default="ebook",
        description="screen 96 dpi / q55; ebook 150 dpi / q70; print 300 dpi / q85; "
        "archive-light: lossless only (no image resampling); custom: only the fields given.",
    )
    max_image_dpi: int | None = Field(
        default=None, ge=36, le=1200, description="Largest effective image resolution in dpi."
    )
    jpeg_quality: int | None = Field(default=None, ge=1, le=100)
    grayscale: bool = Field(default=False, description="Convert images to grayscale.")
    remove_unused: bool | None = Field(
        default=None, description="Drop XObject resources (images, forms) the pages do not use."
    )
    remove_metadata: bool = Field(
        default=False, description="Remove the document information and XMP metadata."
    )
    remove_thumbnails: bool | None = Field(default=None, description="Remove page thumbnails.")
    remove_attachments: bool = Field(default=False, description="Remove embedded files.")
    remove_annotations: bool = Field(
        default=False, description="Remove annotations (form fields are kept)."
    )
    flatten_transparency: bool = Field(
        default=False, description="Composite images with soft masks onto white."
    )
    subset_fonts: bool = Field(
        default=True,
        description="Drop font resources the pages do not use. Producers already subset the "
        "embedded fonts, so this only removes unused font entries.",
    )
    recompress_streams: bool | None = Field(
        default=None, description="Re-encode plain Flate streams at level 9."
    )
    use_object_streams: bool | None = Field(
        default=None, description="Store objects in compressed object streams."
    )


@dataclass(frozen=True)
class Resolved:
    max_dpi: int | None
    jpeg_quality: int | None
    grayscale: bool
    remove_unused: bool
    remove_metadata: bool
    remove_thumbnails: bool
    remove_attachments: bool
    remove_annotations: bool
    flatten: bool
    subset_fonts: bool
    recompress: bool
    object_streams: bool


def resolve(p: CompressParams) -> Resolved:
    base = PRESETS[p.preset]

    def pick(value: Any, preset_value: Any) -> Any:
        return preset_value if value is None else value

    return Resolved(
        max_dpi=pick(p.max_image_dpi, base["max_image_dpi"]),
        jpeg_quality=pick(p.jpeg_quality, base["jpeg_quality"]),
        grayscale=p.grayscale,
        remove_unused=pick(p.remove_unused, True),
        remove_metadata=p.remove_metadata,
        remove_thumbnails=pick(p.remove_thumbnails, base["remove_thumbnails"]),
        remove_attachments=p.remove_attachments,
        remove_annotations=p.remove_annotations,
        flatten=p.flatten_transparency,
        subset_fonts=p.subset_fonts,
        recompress=pick(p.recompress_streams, True),
        object_streams=pick(p.use_object_streams, True),
    )


@dataclass
class CompressStats:
    images_processed: int = 0
    images_skipped: int = 0
    skipped: dict[str, int] = field(default_factory=dict)
    fonts_dropped: int = 0
    resources_dropped: int = 0
    warnings: list[str] = field(default_factory=list)

    def skip(self, reason: str) -> None:
        self.images_skipped += 1
        self.skipped[reason] = self.skipped.get(reason, 0) + 1

    def warn(self, message: str) -> None:
        if message not in self.warnings:
            self.warnings.append(message)


def save_options(res: Resolved) -> dict[str, Any]:
    mode = (
        pikepdf.ObjectStreamMode.generate
        if res.object_streams
        else pikepdf.ObjectStreamMode.preserve
    )
    return {"object_stream_mode": mode}


# -- image decisions ------------------------------------------------------------------

_BILEVEL_FILTERS = {"/CCITTFaxDecode", "/CCF", "/JBIG2Decode"}


def _filters(obj: pikepdf.Object) -> list[str]:
    raw = obj.get("/Filter")
    if raw is None:
        return []
    if isinstance(raw, pikepdf.Array):
        return [str(f) for f in raw]
    return [str(raw)]


def _skip_reason(obj: pikepdf.Object, shared_smask: bool) -> str | None:
    if obj.get("/ImageMask"):
        return "stencil mask"
    if "/Mask" in obj:
        return "colour-key or explicit mask"
    if "/SMaskInData" in obj:
        return "soft mask in data"
    filters = _filters(obj)
    if any(f in _BILEVEL_FILTERS for f in filters):
        return "bilevel (CCITT/JBIG2)"
    if "/JPXDecode" in filters:
        return "JPEG 2000"
    if int(obj.get("/BitsPerComponent", 8)) == 1:
        return "1-bit line art"
    if shared_smask:
        return "soft mask shared by several images"
    return None


def _decode(obj: pikepdf.Object) -> Image.Image | None:
    """The image as Pillow sees it. ``PdfImage`` applies /Decode, so the result is final."""
    if not isinstance(obj, pikepdf.Stream):
        return None
    try:
        img: Image.Image = pikepdf.PdfImage(obj).as_pil_image()
    except (pikepdf.PdfError, OSError, ValueError, UnidentifiedImageError, NotImplementedError):
        return None
    # With a /SMask, PdfImage returns RGBA/LA: the colour part is kept here, the mask is decoded
    # on its own by the caller.
    if img.mode == "RGBA":
        return img.convert("RGB")
    if img.mode == "LA":
        return img.convert("L")
    return img


def scale_for(px: tuple[int, int], placed: tuple[float, float], max_dpi: int | None) -> float:
    """Factor that brings the effective resolution down to ``max_dpi`` (1.0 = leave it)."""
    if max_dpi is None or placed[0] <= 0 or placed[1] <= 0:
        return 1.0
    fit_w = max_dpi * placed[0] / 72 / px[0]
    fit_h = max_dpi * placed[1] / 72 / px[1]
    scale = min(1.0, fit_w, fit_h)
    return scale if scale < SCALE_EPSILON else 1.0


def _few_colours(img: Image.Image) -> bool:
    return img.mode in ("L", "RGB") and img.getcolors(FEW_COLOURS) is not None


@dataclass
class _Encoded:
    data: bytes
    filter: Name
    mode: str  # Pillow mode of the pixels (L, RGB or CMYK)
    size: tuple[int, int]
    smask: bytes | None


def _recode(
    obj: pikepdf.Object,
    decoded: Image.Image,
    smask: pikepdf.Object | None,
    scale: float,
    res: Resolved,
) -> _Encoded | None:
    """New encoding for the image (and its soft mask), or None when it does not get smaller."""
    img = decoded.convert("RGB") if decoded.mode == "P" else decoded
    alpha: Image.Image | None = None
    if smask is not None:
        alpha_src = _decode(smask)
        if alpha_src is None:
            return None
        alpha = alpha_src.convert("L")
        if alpha.size != img.size:
            alpha = alpha.resize(img.size, Image.Resampling.LANCZOS)
    old_size = len(obj.read_raw_bytes()) + (len(smask.read_raw_bytes()) if smask is not None else 0)
    width, height = img.size
    if scale < 1.0:
        new_size = (max(1, round(width * scale)), max(1, round(height * scale)))
        img = img.resize(new_size, Image.Resampling.LANCZOS)
        if alpha is not None:
            alpha = alpha.resize(new_size, Image.Resampling.LANCZOS)
    if res.grayscale and img.mode != "L":
        img = img.convert("L")
    if res.flatten and alpha is not None:
        base = img if img.mode in ("L", "RGB") else img.convert("RGB")
        white = Image.new(base.mode, base.size, 255 if base.mode == "L" else (255, 255, 255))
        img = Image.composite(base, white, alpha)
        alpha = None
    lossless = _filters(obj) == ["/FlateDecode"] and (alpha is not None or _few_colours(img))
    if lossless:
        data, filt = zlib.compress(img.tobytes(), 9), Name.FlateDecode
    else:
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=res.jpeg_quality or JPEG_DEFAULT_QUALITY)
        data, filt = buf.getvalue(), Name.DCTDecode
    smask_bytes = zlib.compress(alpha.tobytes(), 9) if alpha is not None else None
    new_total = len(data) + (len(smask_bytes) if smask_bytes is not None else 0)
    if new_total >= old_size:
        return None
    return _Encoded(
        data=data,
        filter=filt,
        mode=img.mode,
        size=img.size,
        smask=smask_bytes,
    )


def _colour_space(mode: str, original: Any) -> Any:
    """Keep an ICC colour space whose component count still matches; else a device space."""
    comps = {"L": 1, "RGB": 3, "CMYK": 4}[mode]
    if (
        isinstance(original, pikepdf.Array)
        and len(original) > 1
        and str(original[0]) == "/ICCBased"
    ):
        stream = original[1]
        if isinstance(stream, pikepdf.Stream) and int(stream.get("/N", 0)) == comps:
            return original
    return {"L": Name.DeviceGray, "RGB": Name.DeviceRGB, "CMYK": Name.DeviceCMYK}[mode]


def _drop_keys(obj: pikepdf.Object, *keys: str) -> None:
    for key in keys:
        if key in obj:
            del obj[key]


def _write_image(obj: pikepdf.Object, enc: _Encoded, original_space: Any) -> None:
    obj.write(enc.data, filter=enc.filter)
    obj.Width, obj.Height = enc.size
    obj.BitsPerComponent = 8
    _drop_keys(obj, "/DecodeParms", "/Decode", "/Matte")
    obj.ColorSpace = _colour_space(enc.mode, original_space)


def _write_smask(obj: pikepdf.Object, smask: pikepdf.Object | None, enc: _Encoded) -> None:
    if smask is None:
        return
    if enc.smask is None:
        _drop_keys(obj, "/SMask")  # flattened: the mask is no longer referenced
        return
    smask.write(enc.smask, filter=Name.FlateDecode)
    smask.Width, smask.Height = enc.size
    smask.BitsPerComponent = 8
    smask.ColorSpace = Name.DeviceGray
    _drop_keys(smask, "/DecodeParms", "/Decode")


def process_image(
    obj: pikepdf.Object,
    smask: pikepdf.Object | None,
    placed: tuple[float, float],
    res: Resolved,
    stats: CompressStats,
) -> bool:
    """Re-encode one image if it must change. Returns True when it was replaced."""
    decoded = _decode(obj)
    if decoded is None:
        stats.skip("undecodable")
        return False
    if decoded.mode not in ("L", "RGB", "CMYK", "P"):
        stats.skip("colour space")
        return False
    scale = scale_for(decoded.size, placed, res.max_dpi)
    colour_change = res.grayscale and decoded.mode in ("RGB", "CMYK", "P")
    flatten = res.flatten and smask is not None
    quality = "/DCTDecode" in _filters(obj) and res.jpeg_quality is not None
    if scale >= 1.0 and not (colour_change or flatten or quality):
        stats.skip("within limits")
        return False
    enc = _recode(obj, decoded, smask, scale, res)
    if enc is None:
        stats.skip("would not shrink")
        return False
    original_space = obj.get("/ColorSpace")
    _write_image(obj, enc, original_space)
    _write_smask(obj, smask, enc)
    stats.images_processed += 1
    return True


# -- whole-document pass --------------------------------------------------------------


def _resources_key(page: pikepdf.Page, index: int) -> tuple[Any, ...]:
    res = page.resources
    if isinstance(res, pikepdf.Object) and res.is_indirect:
        return ("obj", res.objgen)
    return ("page", index)


def _drop_unused(pdf: pikepdf.Pdf, res: Resolved, stats: CompressStats) -> None:
    """Drop XObject and font entries no page content (or form, pattern, soft mask) uses.

    Pages that share one resources dictionary share the union of their uses, and a dictionary
    used by a page whose content could not be fully parsed is left alone.
    """
    groups: dict[tuple[Any, ...], dict[str, Any]] = {}
    for index, page in enumerate(pdf.pages):
        walk = walk_page(page)
        group = groups.setdefault(
            _resources_key(page, index),
            {"res": page.resources, "x": set(), "f": set(), "ok": True},
        )
        group["x"] |= walk.xobject_names
        group["f"] |= walk.font_names
        group["ok"] = group["ok"] and walk.complete
    for group in groups.values():
        resources = group["res"]
        if not group["ok"] or not isinstance(resources, pikepdf.Dictionary):
            continue
        xobjects = resources.get("/XObject")
        if res.remove_unused and isinstance(xobjects, pikepdf.Dictionary):
            for key in list(xobjects.keys()):
                if str(key) not in group["x"]:
                    del xobjects[key]
                    stats.resources_dropped += 1
        fonts = resources.get("/Font")
        if res.subset_fonts and isinstance(fonts, pikepdf.Dictionary):
            for key in list(fonts.keys()):
                if str(key) not in group["f"]:
                    del fonts[key]
                    stats.fonts_dropped += 1


def _strip(pdf: pikepdf.Pdf, res: Resolved, stats: CompressStats) -> None:
    if res.remove_metadata:
        _drop_keys(pdf.Root, "/Metadata")
        for key in list(pdf.docinfo.keys()):
            del pdf.docinfo[key]
    if res.remove_attachments:
        names = pdf.Root.get("/Names")
        if isinstance(names, pikepdf.Dictionary):
            _drop_keys(names, "/EmbeddedFiles")
    for page in pdf.pages:
        if res.remove_thumbnails:
            _drop_keys(page.obj, "/Thumb")
        annots = page.obj.get("/Annots")
        if not isinstance(annots, pikepdf.Array):
            continue
        kept = pikepdf.Array()
        for annot in annots:
            if not isinstance(annot, pikepdf.Dictionary):
                continue
            subtype = annot.get("/Subtype")
            if subtype == Name.Widget:
                kept.append(annot)
            elif res.remove_annotations or (
                res.remove_attachments and subtype == Name.FileAttachment
            ):
                continue
            else:
                kept.append(annot)
        if len(kept) != len(annots):
            page.obj["/Annots"] = kept
    if res.remove_annotations:
        stats.warn("Annotations were removed; form fields were kept.")


def _image_targets(pdf: pikepdf.Pdf) -> dict[Objgen, tuple[pikepdf.Object, tuple[float, float]]]:
    """Every image XObject with its binding placed size in points (smallest placement).

    An image that no page places is sized as a full-page image (the conservative choice: a
    larger size means a lower effective resolution, so less is downsampled).
    """
    targets: dict[Objgen, tuple[pikepdf.Object, tuple[float, float]]] = {}
    for page in pdf.pages:
        walk = walk_page(page)
        for gen, placement in walk.images.items():
            size = (placement.width, placement.height)
            old = targets.get(gen)
            if old is None or size[0] * size[1] < old[1][0] * old[1][1]:
                targets[gen] = (placement.image, size)
        page_w, page_h = (float(v) for v in display_size(page)[:2])
        for image in page_xobject_images(page):
            if image.is_indirect and image.objgen not in targets:
                targets[image.objgen] = (image, (page_w, page_h))
    return targets


def _smask_of(obj: pikepdf.Object) -> pikepdf.Object | None:
    value = obj.get("/SMask")
    return value if isinstance(value, pikepdf.Stream) else None


def _process_images(pdf: pikepdf.Pdf, res: Resolved, ctx: OpContext, stats: CompressStats) -> None:
    """Each image is handled once. A soft mask is handled together with its image, and only when
    no other image uses it (resizing a shared mask would break the others)."""
    targets = _image_targets(pdf)
    users: dict[Objgen, int] = {}
    for obj, _ in targets.values():
        smask = _smask_of(obj)
        if smask is not None and smask.is_indirect:
            users[smask.objgen] = users.get(smask.objgen, 0) + 1
    items = list(targets.items())
    for gen, (obj, placed) in ctx.steps(items, len(items), "images"):
        if gen in users:
            stats.skip("soft mask")  # handled with its image
            continue
        smask = _smask_of(obj)
        if smask is not None and smask.is_indirect and users.get(smask.objgen, 0) > 1:
            stats.skip("soft mask shared by several images")
            continue
        reason = _skip_reason(obj, shared_smask=False)
        if reason is not None:
            stats.skip(reason)
            continue
        process_image(obj, smask, placed, res, stats)
        ctx.check_cancelled()


def _flate_recompress(pdf: pikepdf.Pdf, ctx: OpContext) -> None:
    """Re-encode plain Flate streams at level 9 (streams with predictors are left alone)."""
    for obj in pdf.objects:
        if not isinstance(obj, pikepdf.Stream):
            continue
        ctx.check_cancelled()
        if _filters(obj) != ["/FlateDecode"] or "/DecodeParms" in obj:
            continue
        raw = obj.read_raw_bytes()
        try:
            packed = zlib.compress(zlib.decompress(raw), 9)
        except zlib.error:
            continue  # damaged or unusual stream: leave it as it is
        if len(packed) < len(raw):
            obj.write(packed, filter=Name.FlateDecode)


def compress_document(
    ctx: OpContext, pdf: pikepdf.Pdf, res: Resolved, stats: CompressStats
) -> None:
    """Apply the compression to ``pdf`` in memory. The caller saves it."""
    _strip(pdf, res, stats)
    _drop_unused(pdf, res, stats)
    _process_images(pdf, res, ctx, stats)
    if res.recompress:
        _flate_recompress(pdf, ctx)
    for message in stats.warnings:
        ctx.warn(message)


def _report(before: int, after: int, stats: CompressStats) -> dict[str, Any]:
    return {
        "bytesBefore": before,
        "bytesAfter": after,
        "ratio": round(after / before, 4) if before else 1.0,
        "imagesProcessed": stats.images_processed,
        "imagesSkipped": stats.images_skipped,
        "skippedReasons": dict(sorted(stats.skipped.items())),
        "fontsDropped": stats.fonts_dropped,
        "resourcesDropped": stats.resources_dropped,
        "warnings": list(stats.warnings),
    }


def _measure(pdf: pikepdf.Pdf, res: Resolved, scratch: Path) -> int:
    target = scratch / "measure.pdf"
    atomic_save(pdf, target, **save_options(res))
    return target.stat().st_size


# -- ops ------------------------------------------------------------------------------


@operation(
    id="compress.pdf",
    title="Compress PDF",
    group="compress",
    params=CompressParams,
    destructive=True,
    batchable=True,
)
def compress_pdf(ctx: OpContext, p: CompressParams) -> OpOutput:
    res = resolve(p)
    stats = CompressStats()
    assert ctx.input_path is not None and ctx.result_path is not None
    before = ctx.input_path.stat().st_size
    with ctx.open_input() as pdf:
        compress_document(ctx, pdf, res, stats)
        ctx.check_cancelled()
        atomic_save(pdf, ctx.result_path, **save_options(res))
    ctx.modified = True
    after = ctx.result_path.stat().st_size
    if after >= before:
        stats.warn("The compressed file is not smaller than the original.")
    return OpOutput(changed_pages="all", data=_report(before, after, stats))


class CompressFileParams(CompressParams):
    input_path: str = Field(min_length=1, description="PDF to compress.")
    output_path: str = Field(min_length=1, description="PDF to write (may equal the input).")
    password: str | None = Field(default=None, description="Password of the input file.")


@operation(
    id="compress.file",
    title="Compress file",
    group="compress",
    params=CompressFileParams,
    batchable=True,
    standalone=True,
)
def compress_file(ctx: OpContext, p: CompressFileParams) -> OpOutput:
    res = resolve(p)
    src_path = Path(p.input_path).expanduser().absolute()
    out_path = Path(p.output_path).expanduser().absolute()
    before = src_path.stat().st_size if src_path.is_file() else 0
    stats = CompressStats()
    src = open_pdf(src_path, p.password)
    try:
        compress_document(ctx, src, res, stats)
        ctx.check_cancelled()
        atomic_save(src, out_path, before_replace=src.close, **save_options(res))
    finally:
        src.close()
    after = out_path.stat().st_size
    if after >= before:
        stats.warn("The compressed file is not smaller than the original.")
    return OpOutput(changed_pages=[], outputs=[str(out_path)], data=_report(before, after, stats))


@operation(
    id="compress.estimate",
    title="Estimate compressed size",
    group="compress",
    params=CompressParams,
)
def estimate(ctx: OpContext, p: CompressParams) -> OpOutput:
    res = resolve(p)
    assert ctx.input_path is not None
    before = ctx.input_path.stat().st_size
    stats = CompressStats()
    with (
        ctx.open_input() as pdf,
        tempfile.TemporaryDirectory(dir=ctx.work_dir) as scratch,
    ):
        compress_document(ctx, pdf, res, stats)
        after = _measure(pdf, res, Path(scratch))
    return OpOutput(changed_pages=[], data=_report(before, after, stats))


class CompressFitSizeParams(CompressParams):
    target_bytes: int = Field(gt=0, description="Largest acceptable size of the result in bytes.")
    min_dpi: int = Field(default=72, ge=36, le=1200, description="Lowest image dpi to try.")
    min_jpeg_quality: int = Field(default=30, ge=1, le=100, description="Lowest JPEG quality.")


DPI_STEPS = (300, 250, 200, 150, 120, 96, 72)


def dpi_ladder(base: int, min_dpi: int) -> list[int]:
    candidates = {base, *DPI_STEPS, min_dpi}
    return sorted((d for d in candidates if min_dpi <= d <= base), reverse=True)


class _FitSearch:
    """Binary search over JPEG quality at each dpi of the ladder, as scan.fitSize does."""

    def __init__(self, ctx: OpContext, base: CompressParams) -> None:
        self.ctx = ctx
        self.base = base
        self.steps = 0
        self.cache: dict[tuple[int, int], int] = {}
        self.smallest: tuple[int, CompressParams] | None = None

    def candidate(self, dpi: int, quality: int) -> CompressParams:
        data = {name: getattr(self.base, name) for name in CompressParams.model_fields}
        data.update(max_image_dpi=dpi, jpeg_quality=quality)
        return CompressParams.model_validate(data)

    def size(self, dpi: int, quality: int) -> int:
        key = (dpi, quality)
        if key in self.cache:
            return self.cache[key]
        self.ctx.check_cancelled()
        self.steps += 1
        params = self.candidate(dpi, quality)
        res = resolve(params)
        assert self.ctx.input_path is not None
        with (
            open_pdf(self.ctx.input_path) as pdf,
            tempfile.TemporaryDirectory(dir=self.ctx.work_dir) as scratch,
        ):
            compress_document(self.ctx, pdf, res, CompressStats())
            value = _measure(pdf, res, Path(scratch))
        self.cache[key] = value
        if self.smallest is None or value < self.smallest[0]:
            self.smallest = (value, params)
        return value

    def run(
        self, target: int, top: int, floor: int, base_dpi: int, min_dpi: int
    ) -> tuple[bool, CompressParams, int]:
        for dpi in dpi_ladder(base_dpi, min_dpi):
            value = self.size(dpi, top)
            if value <= target:
                return True, self.candidate(dpi, top), value
            if self.size(dpi, floor) > target:
                continue
            ok, bad = floor, top  # invariant: `ok` fits, `bad` does not
            while bad - ok > 1:
                mid = (ok + bad) // 2
                if self.size(dpi, mid) <= target:
                    ok = mid
                else:
                    bad = mid
            return True, self.candidate(dpi, ok), self.size(dpi, ok)
        assert self.smallest is not None
        value, params = self.smallest
        return False, params, value


@operation(
    id="compress.fitSize",
    title="Compress to a target size",
    group="compress",
    params=CompressFitSizeParams,
)
def fit_size(ctx: OpContext, p: CompressFitSizeParams) -> OpOutput:
    res = resolve(p)
    base_dpi = res.max_dpi or 300
    if p.min_dpi > base_dpi:
        raise invalid_params("minDpi must not be above maxImageDpi", {"field": "minDpi"})
    top = res.jpeg_quality or JPEG_DEFAULT_QUALITY
    if p.min_jpeg_quality > top:
        raise invalid_params(
            "minJpegQuality must not be above jpegQuality", {"field": "minJpegQuality"}
        )
    search = _FitSearch(ctx, p)
    reachable, params, value = search.run(
        p.target_bytes, top, p.min_jpeg_quality, base_dpi, p.min_dpi
    )
    return OpOutput(
        changed_pages=[],
        data={
            "params": params.model_dump(by_alias=True, mode="json"),
            "estimatedBytes": value,
            "reachable": reachable,
            "steps": search.steps,
        },
    )


@operation(
    id="compress.toSize",
    title="Compress to a target size",
    group="compress",
    params=CompressFitSizeParams,
    destructive=True,
    batchable=True,
)
def compress_to_size(ctx: OpContext, p: CompressFitSizeParams) -> OpOutput:
    """Find and apply the first compression setting that fits, or stop without a revision."""
    res = resolve(p)
    base_dpi = res.max_dpi or 300
    if p.min_dpi > base_dpi:
        raise invalid_params("minDpi must not be above maxImageDpi", {"field": "minDpi"})
    top = res.jpeg_quality or JPEG_DEFAULT_QUALITY
    if p.min_jpeg_quality > top:
        raise invalid_params(
            "minJpegQuality must not be above jpegQuality", {"field": "minJpegQuality"}
        )
    search = _FitSearch(ctx, p)
    reachable, params, value = search.run(
        p.target_bytes, top, p.min_jpeg_quality, base_dpi, p.min_dpi
    )
    if not reachable:
        raise invalid_params(
            "Target size cannot be reached within the configured compression limits.",
            {
                "targetBytes": p.target_bytes,
                "smallestEstimatedBytes": value,
                "minDpi": p.min_dpi,
                "minJpegQuality": p.min_jpeg_quality,
            },
        )

    assert ctx.input_path is not None and ctx.result_path is not None
    stats = CompressStats()
    before = ctx.input_path.stat().st_size
    applied = resolve(params)
    with ctx.open_input() as pdf:
        compress_document(ctx, pdf, applied, stats)
        ctx.check_cancelled()
        atomic_save(pdf, ctx.result_path, **save_options(applied))
    ctx.modified = True
    after = ctx.result_path.stat().st_size
    if after > p.target_bytes:
        # The search measures a temporary serialization; keep the real output as the authority.
        # Refuse to commit so a workflow never proceeds to signing with a false size claim.
        ctx.result_path.unlink(missing_ok=True)
        ctx.modified = False
        raise invalid_params(
            "The measured output exceeded the target; no compressed revision was committed.",
            {"targetBytes": p.target_bytes, "actualBytes": after},
        )
    report = _report(before, after, stats)
    return OpOutput(
        changed_pages="all",
        data={**report, "targetBytes": p.target_bytes, "reachable": True, "steps": search.steps},
    )
