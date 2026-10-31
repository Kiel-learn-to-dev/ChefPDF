"""Hidden data (features J3, J4; T5.02).

``inspect.hiddenData`` (session, read-only) reports what a file holds beyond its visible pages.
Each finding is ``{category, severity, count, items, fixAvailable}``; severity is ``info``,
``warn`` or ``risk``. Hidden text (invisible or white-on-white text, text outside the page) is
reported but cannot be removed without rewriting the page text, so it has no fix.

``inspect.removeHidden`` (session, destructive) removes the selected categories and writes a new
revision. Every run writes a full copy of the document, so older revisions stored in the file
(incremental updates) and unused objects are dropped as well. Blocked on signed documents.

``scan_path`` is shared with the pre-send checklist (``ops/preflight.py``).
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, cast

import pikepdf
import pypdfium2 as pdfium
from pydantic import Field

from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.pdf.io import opened_pdf
from chef_core.pdf.outline import read_bookmarks
from chef_core.session.info import document_info

METADATA = "metadata"
EMBEDDED = "embeddedFiles"
JAVASCRIPT = "javascript"
LAUNCH = "launchActions"
HIDDEN_TEXT = "hiddenText"
HIDDEN_LAYERS = "hiddenLayers"
COMMENTS = "comments"
FORM_VALUES = "formValues"
BOOKMARKS = "bookmarks"
THUMBNAILS = "thumbnails"
EXTERNAL_LINKS = "externalLinks"
XFA = "xfa"
REVISIONS = "revisionHistory"
UNUSED = "unusedObjects"
FONTS = "fontsNotEmbedded"
IMAGES = "images"

# category -> (severity when present, fixAvailable)
CATEGORIES: dict[str, tuple[str, bool]] = {
    METADATA: ("warn", True),
    EMBEDDED: ("warn", True),
    JAVASCRIPT: ("risk", True),
    LAUNCH: ("risk", True),
    HIDDEN_TEXT: ("risk", False),
    HIDDEN_LAYERS: ("warn", True),
    COMMENTS: ("warn", True),
    FORM_VALUES: ("info", True),
    BOOKMARKS: ("info", True),
    THUMBNAILS: ("info", True),
    EXTERNAL_LINKS: ("info", True),
    XFA: ("warn", True),
    REVISIONS: ("risk", True),
    UNUSED: ("info", True),
    FONTS: ("warn", False),
    IMAGES: ("info", False),
}

RemovableCategory = Literal[
    "metadata",
    "embeddedFiles",
    "javascript",
    "launchActions",
    "hiddenLayers",
    "comments",
    "formValues",
    "bookmarks",
    "thumbnails",
    "externalLinks",
    "xfa",
    "revisionHistory",
    "unusedObjects",
]

MAX_ITEMS = 200
MAX_DEPTH = 32
MAX_CHARS_PER_PAGE = 20000
_TEXT_SHOW = frozenset({"Tj", "TJ", "'", '"'})


@dataclass
class Finding:
    category: str
    items: list[Any] = field(default_factory=list)

    @property
    def count(self) -> int:
        return len(self.items)

    def as_dict(self) -> dict[str, Any]:
        _, fix = CATEGORIES[self.category]
        return {
            "category": self.category,
            "severity": CATEGORIES[self.category][0] if self.count else "info",
            "count": self.count,
            "items": self.items[:MAX_ITEMS],
            "fixAvailable": fix,
        }


def _name(obj: Any) -> str:
    return str(obj).lstrip("/") if isinstance(obj, pikepdf.Name) else ""


def _annots(page: pikepdf.Object) -> list[pikepdf.Dictionary]:
    annots = page.get("/Annots")
    if not isinstance(annots, pikepdf.Array):
        return []
    return [a for a in annots if isinstance(a, pikepdf.Dictionary)]


# -- actions -------------------------------------------------------------------------------


@dataclass
class ActionSite:
    owner: pikepdf.Dictionary
    key: str  # key of the action in ``owner``, or of the /AA dictionary
    trigger: str | None  # trigger name inside /AA, None for a plain action
    action: pikepdf.Dictionary
    where: str


def _fields(acroform: pikepdf.Dictionary) -> list[pikepdf.Dictionary]:
    out: list[pikepdf.Dictionary] = []

    def walk(nodes: pikepdf.Object, depth: int) -> None:
        if not isinstance(nodes, pikepdf.Array) or depth > MAX_DEPTH:
            return
        for node in nodes:
            if isinstance(node, pikepdf.Dictionary):
                out.append(node)
                walk(node.get("/Kids", pikepdf.Array()), depth + 1)

    walk(acroform.get("/Fields", pikepdf.Array()), 0)
    return out


def _field_name(field_dict: pikepdf.Dictionary) -> str:
    name = field_dict.get("/T")
    return str(name) if isinstance(name, pikepdf.String) else "(unnamed)"


def _action_sites(pdf: pikepdf.Pdf) -> Iterator[ActionSite]:
    """Every action stored in the document: open action, page, annotation and field actions."""

    def from_owner(owner: pikepdf.Dictionary, key: str, where: str) -> Iterator[ActionSite]:
        value = owner.get(key)
        if not isinstance(value, pikepdf.Dictionary):
            return
        if "/S" in value:
            yield ActionSite(owner, key, None, value, where)
            return
        for trigger in list(value):  # an /AA dictionary: one action per trigger
            action = cast(Any, value)[trigger]
            if isinstance(action, pikepdf.Dictionary) and "/S" in action:
                yield ActionSite(owner, key, str(trigger), action, f"{where} {trigger}")

    root = cast(pikepdf.Dictionary, pdf.Root)
    yield from from_owner(root, "/OpenAction", "document /OpenAction")
    yield from from_owner(root, "/AA", "document /AA")
    for index, page in enumerate(pdf.pages):
        yield from from_owner(page.obj, "/AA", f"page {index + 1} /AA")
        for annot in _annots(page.obj):
            yield from from_owner(annot, "/A", f"page {index + 1} annotation /A")
            yield from from_owner(annot, "/AA", f"page {index + 1} annotation /AA")
    acroform = root.get("/AcroForm")
    if isinstance(acroform, pikepdf.Dictionary):
        for field_dict in _fields(acroform):
            name = _field_name(field_dict)
            yield from from_owner(field_dict, "/A", f"field {name} /A")
            yield from from_owner(field_dict, "/AA", f"field {name} /AA")


def _sites_with(pdf: pikepdf.Pdf, subtype: str) -> list[ActionSite]:
    return [s for s in _action_sites(pdf) if _name(s.action.get("/S")) == subtype]


def _remove_site(site: ActionSite) -> None:
    if site.trigger is None:
        del site.owner[site.key]
        return
    aa = site.owner[site.key]
    assert isinstance(aa, pikepdf.Dictionary)
    del aa[site.trigger]
    if len(aa) == 0:
        del site.owner[site.key]


def _name_tree_leaves(node: pikepdf.Object, depth: int = 0) -> list[tuple[Any, Any]]:
    if not isinstance(node, pikepdf.Dictionary) or depth > MAX_DEPTH:
        return []
    out: list[tuple[Any, Any]] = []
    names = node.get("/Names")
    if isinstance(names, pikepdf.Array):
        out.extend((names[i], names[i + 1]) for i in range(0, len(names) - 1, 2))
    kids = node.get("/Kids")
    if isinstance(kids, pikepdf.Array):
        for kid in kids:
            out.extend(_name_tree_leaves(kid, depth + 1))
    return out


def _name_tree(pdf: pikepdf.Pdf, sub: str) -> pikepdf.Object | None:
    names = pdf.Root.get("/Names")
    if isinstance(names, pikepdf.Dictionary) and sub in names:
        return names[sub]
    return None


# -- content streams -----------------------------------------------------------------------


@dataclass
class _Gfx:
    ctm: tuple[float, ...] = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    fill_white: bool = False
    render_mode: int = 0


def _mul(m: tuple[float, ...], n: tuple[float, ...]) -> tuple[float, ...]:
    """Matrix ``m`` times ``n`` in the PDF row-vector convention."""
    a, b, c, d, e, f = m
    a2, b2, c2, d2, e2, f2 = n
    return (
        a * a2 + b * c2,
        a * b2 + b * d2,
        c * a2 + d * c2,
        c * b2 + d * d2,
        e * a2 + f * c2 + e2,
        e * b2 + f * d2 + f2,
    )


def _is_white(operator: str, operands: list[Any]) -> bool | None:
    try:
        values = [float(x) for x in operands]
    except (TypeError, ValueError):
        return None
    if operator == "rg":
        return values == [1.0, 1.0, 1.0]
    if operator == "g":
        return values == [1.0]
    if operator == "k":
        return values == [0.0, 0.0, 0.0, 0.0]
    return None


@dataclass
class _Report:
    invisible_text: int = 0
    white_text: int = 0
    images: dict[Any, dict[str, Any]] = field(default_factory=dict)
    seen_forms: set[Any] = field(default_factory=set)


def _walk(
    instructions: list[Any],
    resources: pikepdf.Object,
    page_index: int,
    ctm: tuple[float, ...],
    report: _Report,
    depth: int,
) -> None:
    gfx = _Gfx(ctm=ctm)
    stack: list[_Gfx] = []
    in_text = False
    for operands, operator in instructions:
        op = str(operator)
        args = list(operands)
        if op == "q":
            stack.append(_Gfx(gfx.ctm, gfx.fill_white, gfx.render_mode))
        elif op == "Q" and stack:
            gfx = stack.pop()
        elif op == "cm" and len(args) == 6:
            gfx.ctm = _mul(tuple(float(x) for x in args), gfx.ctm)
        elif op == "BT":
            in_text = True
        elif op == "ET":
            in_text = False
        elif op == "Tr" and args:
            gfx.render_mode = int(args[0])
        elif op in ("rg", "g", "k"):
            white = _is_white(op, args)
            if white is not None:
                gfx.fill_white = white
        elif op in _TEXT_SHOW and in_text:
            if gfx.render_mode == 3:
                report.invisible_text += 1
            elif gfx.fill_white:
                report.white_text += 1
        elif op == "Do" and args:
            _do(str(args[0]), resources, page_index, gfx.ctm, report, depth)


def _do(
    name: str,
    resources: pikepdf.Object,
    page_index: int,
    ctm: tuple[float, ...],
    report: _Report,
    depth: int,
) -> None:
    if depth > MAX_DEPTH or not isinstance(resources, pikepdf.Dictionary):
        return
    xobjects = resources.get("/XObject")
    if not isinstance(xobjects, pikepdf.Dictionary) or name not in xobjects:
        return
    xobj = xobjects[name]
    if not isinstance(xobj, pikepdf.Stream):
        return
    key = xobj.objgen if xobj.is_indirect else ("direct", page_index, name)
    subtype = _name(xobj.get("/Subtype"))
    if subtype == "Image":
        if key in report.images:
            return
        width_pt = (ctm[0] ** 2 + ctm[1] ** 2) ** 0.5
        height_pt = (ctm[2] ** 2 + ctm[3] ** 2) ** 0.5
        px_w = int(xobj.get("/Width", 0))
        px_h = int(xobj.get("/Height", 0))
        dpi: float | None = None
        if width_pt > 0 and height_pt > 0 and px_w and px_h:
            dpi = round(min(px_w / (width_pt / 72), px_h / (height_pt / 72)), 1)
        filt = xobj.get("/Filter")
        if isinstance(filt, pikepdf.Array) and len(filt) > 0:
            filt = filt[-1]
        report.images[key] = {
            "page": page_index + 1,
            "name": name.lstrip("/"),
            "width": px_w,
            "height": px_h,
            "dpi": dpi,
            "bytes": len(xobj.read_raw_bytes()),
            "filter": _name(filt) or None,
        }
    elif subtype == "Form" and key not in report.seen_forms:
        report.seen_forms.add(key)
        matrix = tuple(float(x) for x in xobj.get("/Matrix", [1, 0, 0, 1, 0, 0]))
        inner = xobj.get("/Resources", resources)
        try:
            instructions = pikepdf.parse_content_stream(xobj)
        except Exception:
            return
        _walk(instructions, inner, page_index, _mul(matrix, ctm), report, depth + 1)


def _content_report(pdf: pikepdf.Pdf) -> _Report:
    report = _Report()
    for index, page in enumerate(pdf.pages):
        resources = page.obj.get("/Resources", pikepdf.Dictionary())
        _walk(
            pikepdf.parse_content_stream(page),
            resources,
            index,
            (1.0, 0.0, 0.0, 1.0, 0.0, 0.0),
            report,
            0,
        )
    return report


def _offpage_chars(path: Path) -> list[dict[str, Any]]:
    """Characters whose glyph box lies outside the page box (pdfium's text layer)."""
    out: list[dict[str, Any]] = []
    doc = pdfium.PdfDocument(str(path))
    try:
        for index in range(len(doc)):
            page = doc[index]
            try:
                left, bottom, right, top = page.get_mediabox()
                text = page.get_textpage()
                try:
                    outside = 0
                    for ci in range(min(text.count_chars(), MAX_CHARS_PER_PAGE)):
                        box = text.get_charbox(ci)
                        if box is None:
                            continue
                        lft, btm, rgt, tp = box
                        if rgt < left - 1 or lft > right + 1 or tp < bottom - 1 or btm > top + 1:
                            outside += 1
                    if outside:
                        out.append({"kind": "offPage", "page": index + 1, "chars": outside})
                finally:
                    text.close()
            finally:
                page.close()
    finally:
        doc.close()
    return out


# -- category scans ------------------------------------------------------------------------


def _metadata_items(pdf: pikepdf.Pdf) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    info = pdf.trailer.get("/Info")
    if isinstance(info, pikepdf.Dictionary):
        for key in info:
            value = cast(Any, info)[key]
            text = str(value) if isinstance(value, pikepdf.String | pikepdf.Name) else "(object)"
            items.append({"where": "Info", "key": str(key).lstrip("/"), "value": text})
    if "/Metadata" in pdf.Root:
        items.append({"where": "XMP", "key": "Metadata"})
    for index, page in enumerate(pdf.pages):
        if "/Metadata" in page.obj:
            items.append({"where": "page", "key": "Metadata", "page": index + 1})
    return items


def _embedded_items(pdf: pikepdf.Pdf) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    tree = _name_tree(pdf, "/EmbeddedFiles")
    if tree is not None:
        items += [{"where": "name tree", "name": str(k)} for k, _ in _name_tree_leaves(tree)]
    af = pdf.Root.get("/AF")
    if isinstance(af, pikepdf.Array):
        items += [{"where": "AF"} for _ in af]
    for index, page in enumerate(pdf.pages):
        for annot in _annots(page.obj):
            if _name(annot.get("/Subtype")) == "FileAttachment":
                items.append({"where": "annotation", "page": index + 1})
    return items


def _javascript_items(pdf: pikepdf.Pdf) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    tree = _name_tree(pdf, "/JavaScript")
    if tree is not None:
        items += [{"where": "name tree", "name": str(k)} for k, _ in _name_tree_leaves(tree)]
    items += [{"where": s.where} for s in _sites_with(pdf, "JavaScript")]
    return items


def _launch_items(pdf: pikepdf.Pdf) -> list[dict[str, Any]]:
    return [
        {"where": s.where, "file": str(s.action.get("/F", ""))} for s in _sites_with(pdf, "Launch")
    ]


def _is_comment(annot: pikepdf.Dictionary) -> bool:
    return _name(annot.get("/Subtype")) not in ("Link", "Widget", "FileAttachment")


def _comment_items(pdf: pikepdf.Pdf) -> list[dict[str, Any]]:
    return [
        {"page": index + 1, "subtype": _name(a.get("/Subtype"))}
        for index, page in enumerate(pdf.pages)
        for a in _annots(page.obj)
        if _is_comment(a)
    ]


def _hidden_layers(pdf: pikepdf.Pdf) -> list[pikepdf.Dictionary]:
    props = pdf.Root.get("/OCProperties")
    if not isinstance(props, pikepdf.Dictionary):
        return []
    default = props.get("/D")
    if not isinstance(default, pikepdf.Dictionary):
        return []
    off = default.get("/OFF")
    if not isinstance(off, pikepdf.Array):
        return []
    return [o for o in off if isinstance(o, pikepdf.Dictionary)]


def _layer_items(pdf: pikepdf.Pdf) -> list[dict[str, Any]]:
    return [{"name": str(o.get("/Name", ""))} for o in _hidden_layers(pdf)]


def _form_value_items(pdf: pikepdf.Pdf) -> list[dict[str, Any]]:
    acroform = pdf.Root.get("/AcroForm")
    if not isinstance(acroform, pikepdf.Dictionary):
        return []
    items = []
    for f in _fields(acroform):
        if f.get("/FT") == pikepdf.Name.Sig:
            continue
        value = f.get("/V")
        if isinstance(value, pikepdf.String | pikepdf.Name) and str(value):
            items.append({"field": _field_name(f), "value": str(value)})
    return items


def _bookmark_items(pdf: pikepdf.Pdf) -> list[dict[str, Any]]:
    def flatten(nodes: list[Any]) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for bm in nodes:
            out.append({"title": bm.title})
            out.extend(flatten(bm.children))
        return out

    return flatten(read_bookmarks(pdf))


def _thumb_items(pdf: pikepdf.Pdf) -> list[dict[str, Any]]:
    return [{"page": i + 1} for i, p in enumerate(pdf.pages) if "/Thumb" in p.obj]


def _link_items(pdf: pikepdf.Pdf) -> list[dict[str, Any]]:
    items = []
    for index, page in enumerate(pdf.pages):
        for annot in _annots(page.obj):
            if _name(annot.get("/Subtype")) != "Link":
                continue
            action = annot.get("/A")
            if isinstance(action, pikepdf.Dictionary) and _name(action.get("/S")) in (
                "URI",
                "GoToR",
            ):
                target = action.get("/URI") or action.get("/F") or ""
                items.append(
                    {
                        "page": index + 1,
                        "kind": _name(action.get("/S")),
                        "target": str(target),
                    }
                )
    return items


def _xfa_items(pdf: pikepdf.Pdf) -> list[dict[str, Any]]:
    acroform = pdf.Root.get("/AcroForm")
    if isinstance(acroform, pikepdf.Dictionary) and "/XFA" in acroform:
        return [{"where": "AcroForm /XFA"}]
    return []


def _revision_items(path: Path) -> list[dict[str, Any]]:
    extra = max(0, path.read_bytes().count(b"%%EOF") - 1)
    return [{"previousRevisions": extra}] if extra else []


def _reachable(pdf: pikepdf.Pdf) -> set[tuple[int, int]]:
    seen: set[tuple[int, int]] = set()
    stack: list[Any] = [pdf.trailer]
    while stack:
        obj = stack.pop()
        if isinstance(obj, pikepdf.Object) and obj.is_indirect:
            if obj.objgen in seen:
                continue
            seen.add(obj.objgen)
        if isinstance(obj, pikepdf.Dictionary | pikepdf.Stream):
            any_obj: Any = obj
            stack.extend(any_obj[k] for k in any_obj)
        elif isinstance(obj, pikepdf.Array):
            stack.extend(list(obj))
    return seen


def _unused_items(pdf: pikepdf.Pdf) -> list[dict[str, Any]]:
    reachable = _reachable(pdf)
    items = []
    for obj in pdf.objects:
        if not isinstance(obj, pikepdf.Object) or not obj.is_indirect:
            continue
        if obj.objgen in reachable:
            continue
        if isinstance(obj, pikepdf.Dictionary | pikepdf.Stream) and _name(obj.get("/Type")) in (
            "ObjStm",
            "XRef",
        ):
            continue
        items.append({"object": f"{obj.objgen[0]} {obj.objgen[1]} R"})
    return items


def _font_items(pdf: pikepdf.Pdf) -> list[dict[str, Any]]:
    fonts = document_info(pdf, encrypted=False, file_size=0)["fonts"]
    return [{"name": f["name"]} for f in fonts if not f["embedded"]]


def scan_path(path: Path) -> dict[str, Finding]:
    """Scan a PDF file. Returns one Finding per category (no items when clean)."""
    findings = {c: Finding(c) for c in CATEGORIES}
    with opened_pdf(path) as pdf:
        findings[METADATA].items = _metadata_items(pdf)
        findings[EMBEDDED].items = _embedded_items(pdf)
        findings[JAVASCRIPT].items = _javascript_items(pdf)
        findings[LAUNCH].items = _launch_items(pdf)
        findings[HIDDEN_LAYERS].items = _layer_items(pdf)
        findings[COMMENTS].items = _comment_items(pdf)
        findings[FORM_VALUES].items = _form_value_items(pdf)
        findings[BOOKMARKS].items = _bookmark_items(pdf)
        findings[THUMBNAILS].items = _thumb_items(pdf)
        findings[EXTERNAL_LINKS].items = _link_items(pdf)
        findings[XFA].items = _xfa_items(pdf)
        findings[REVISIONS].items = _revision_items(path)
        findings[UNUSED].items = _unused_items(pdf)
        findings[FONTS].items = _font_items(pdf)
        report = _content_report(pdf)
        hidden: list[dict[str, Any]] = []
        if report.invisible_text:
            hidden.append({"kind": "invisible", "ops": report.invisible_text})
        if report.white_text:
            hidden.append({"kind": "whiteOnWhite", "ops": report.white_text})
        findings[IMAGES].items = list(report.images.values())
        findings[HIDDEN_TEXT].items = hidden
    findings[HIDDEN_TEXT].items += _offpage_chars(path)
    return findings


def summarize(findings: dict[str, Finding]) -> dict[str, Any]:
    return {"findings": [findings[c].as_dict() for c in CATEGORIES]}


class HiddenDataParams(WireModel):
    """Report the hidden data of the session document."""


class RemoveHiddenParams(WireModel):
    """Remove the selected categories of hidden data (writes a new revision)."""

    categories: list[RemovableCategory] = Field(min_length=1)


@operation(
    id="inspect.hiddenData",
    title="Inspect hidden data",
    group="inspect",
    params=HiddenDataParams,
)
def hidden_data(ctx: OpContext, p: HiddenDataParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("inspect.hiddenData needs a session")
    ctx.check_cancelled()
    return OpOutput(changed_pages=[], data=summarize(scan_path(ctx.input_path)))


# -- removal -------------------------------------------------------------------------------


def _strip_metadata(pdf: pikepdf.Pdf) -> int:
    count = 0
    if "/Info" in pdf.trailer:
        del pdf.trailer["/Info"]
        count += 1
    if "/Metadata" in pdf.Root:
        del pdf.Root["/Metadata"]
        count += 1
    for page in pdf.pages:
        if "/Metadata" in page.obj:
            del page.obj["/Metadata"]
            count += 1
    return count


def _strip_embedded(pdf: pikepdf.Pdf) -> int:
    count = len(_embedded_items(pdf))
    names = pdf.Root.get("/Names")
    if isinstance(names, pikepdf.Dictionary) and "/EmbeddedFiles" in names:
        del names["/EmbeddedFiles"]
    if "/AF" in pdf.Root:
        del pdf.Root["/AF"]
    for page in pdf.pages:
        annots = page.obj.get("/Annots")
        if isinstance(annots, pikepdf.Array):
            page.obj.Annots = pikepdf.Array(
                [a for a in annots if _name(a.get("/Subtype")) != "FileAttachment"]
            )
    return count


def _strip_actions(pdf: pikepdf.Pdf, subtype: str) -> int:
    sites = _sites_with(pdf, subtype)
    for site in sites:
        _remove_site(site)
    if subtype == "JavaScript":
        names = pdf.Root.get("/Names")
        if isinstance(names, pikepdf.Dictionary) and "/JavaScript" in names:
            del names["/JavaScript"]
    return len(sites)


def _strip_hidden_layers(pdf: pikepdf.Pdf) -> int:
    hidden = _hidden_layers(pdf)
    if not hidden:
        return 0
    off_ids = {o.objgen for o in hidden if o.is_indirect}
    for page in pdf.pages:
        resources = page.obj.get("/Resources", pikepdf.Dictionary())
        props = resources.get("/Properties") if isinstance(resources, pikepdf.Dictionary) else None
        names = set()
        if isinstance(props, pikepdf.Dictionary):
            names = {
                str(k).lstrip("/")
                for k, v in props.items()
                if isinstance(v, pikepdf.Object) and v.is_indirect and v.objgen in off_ids
            }
        if names:
            _drop_layer_blocks(pdf, page.obj, names)
        annots = page.obj.get("/Annots")
        if isinstance(annots, pikepdf.Array):
            page.obj.Annots = pikepdf.Array([a for a in annots if not _hidden_by_oc(a, off_ids)])
    props_root = pdf.Root.get("/OCProperties")
    if isinstance(props_root, pikepdf.Dictionary):
        ocgs = props_root.get("/OCGs")
        if isinstance(ocgs, pikepdf.Array):
            props_root.OCGs = pikepdf.Array([g for g in ocgs if g.objgen not in off_ids])
        default = props_root.get("/D")
        if isinstance(default, pikepdf.Dictionary) and "/OFF" in default:
            del default["/OFF"]
    return len(hidden)


def _hidden_by_oc(annot: pikepdf.Object, off_ids: set[tuple[int, int]]) -> bool:
    if not isinstance(annot, pikepdf.Dictionary):
        return False
    oc = annot.get("/OC")
    return isinstance(oc, pikepdf.Object) and oc.is_indirect and oc.objgen in off_ids


def _drop_layer_blocks(pdf: pikepdf.Pdf, page: pikepdf.Object, hidden: set[str]) -> None:
    """Remove the marked-content blocks (``/OC /name BDC`` ... ``EMC``) of hidden layers."""
    contents = page.get("/Contents")
    if isinstance(contents, pikepdf.Stream):
        streams: list[Any] = [contents]
    elif isinstance(contents, pikepdf.Array):
        streams = [c for c in contents if isinstance(c, pikepdf.Stream)]
    else:
        return
    data = b"\n".join(s.read_bytes() for s in streams)
    kept: list[Any] = []
    depth = 0  # nesting inside a hidden block
    stream_ops: Any = pikepdf.parse_content_stream(pdf.make_stream(data))
    for operands, operator in stream_ops:
        op = str(operator)
        args = list(operands)
        if depth:
            if op in ("BDC", "BMC"):
                depth += 1
            elif op == "EMC":
                depth -= 1
            continue
        if op == "BDC" and len(args) == 2 and _name(args[0]) == "OC" and _name(args[1]) in hidden:
            depth = 1
            continue
        kept.append((args, operator))
    page.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))


def _strip_comments(pdf: pikepdf.Pdf) -> int:
    count = 0
    for page in pdf.pages:
        annots = page.obj.get("/Annots")
        if not isinstance(annots, pikepdf.Array):
            continue
        keep = [a for a in annots if not (isinstance(a, pikepdf.Dictionary) and _is_comment(a))]
        count += len(annots) - len(keep)
        page.obj.Annots = pikepdf.Array(keep)
    return count


def _strip_form_values(pdf: pikepdf.Pdf) -> int:
    acroform = pdf.Root.get("/AcroForm")
    if not isinstance(acroform, pikepdf.Dictionary):
        return 0
    count = 0
    for f in _fields(acroform):
        if f.get("/FT") != pikepdf.Name.Sig and "/V" in f:
            del f["/V"]
            count += 1
    return count


def _strip_external_links(pdf: pikepdf.Pdf) -> int:
    count = 0
    for page in pdf.pages:
        annots = page.obj.get("/Annots")
        if not isinstance(annots, pikepdf.Array):
            continue
        keep = []
        for a in annots:
            action = a.get("/A") if isinstance(a, pikepdf.Dictionary) else None
            external = (
                _name(a.get("/Subtype")) == "Link"
                and isinstance(action, pikepdf.Dictionary)
                and _name(action.get("/S")) in ("URI", "GoToR")
            )
            if external:
                count += 1
            else:
                keep.append(a)
        page.obj.Annots = pikepdf.Array(keep)
    return count


def _strip_thumbnails(pdf: pikepdf.Pdf) -> int:
    count = 0
    for page in pdf.pages:
        if "/Thumb" in page.obj:
            del page.obj["/Thumb"]
            count += 1
    return count


def _strip_xfa(pdf: pikepdf.Pdf) -> int:
    acroform = pdf.Root.get("/AcroForm")
    if isinstance(acroform, pikepdf.Dictionary) and "/XFA" in acroform:
        del acroform["/XFA"]
        return 1
    return 0


REMOVERS: dict[str, Callable[[pikepdf.Pdf], int]] = {
    METADATA: _strip_metadata,
    EMBEDDED: _strip_embedded,
    JAVASCRIPT: lambda pdf: _strip_actions(pdf, "JavaScript"),
    LAUNCH: lambda pdf: _strip_actions(pdf, "Launch"),
    HIDDEN_LAYERS: _strip_hidden_layers,
    COMMENTS: _strip_comments,
    FORM_VALUES: _strip_form_values,
    BOOKMARKS: lambda pdf: _drop_root_key(pdf, "/Outlines"),
    THUMBNAILS: _strip_thumbnails,
    EXTERNAL_LINKS: _strip_external_links,
    XFA: _strip_xfa,
    # Previous revisions and unused objects disappear when the document is written again.
    REVISIONS: lambda pdf: 0,
    UNUSED: lambda pdf: 0,
}


def _drop_root_key(pdf: pikepdf.Pdf, key: str) -> int:
    if key in pdf.Root:
        del pdf.Root[key]
        return 1
    return 0


@operation(
    id="inspect.removeHidden",
    title="Remove hidden data",
    group="inspect",
    params=RemoveHiddenParams,
    destructive=True,
    batchable=True,
)
def remove_hidden(ctx: OpContext, p: RemoveHiddenParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("inspect.removeHidden needs a session")
    before = scan_path(ctx.input_path)
    removed: dict[str, int] = {}
    with ctx.open_input() as pdf:
        for category in dict.fromkeys(p.categories):
            ctx.check_cancelled()
            removed[category] = REMOVERS[category](pdf)
        ctx.save_document(pdf)
    assert ctx.result_path is not None
    after = scan_path(ctx.result_path)
    data = {
        "removed": removed,
        "before": {c: before[c].count for c in CATEGORIES},
        "after": {c: after[c].count for c in CATEGORIES},
    }
    return OpOutput(changed_pages="all", data=data)
