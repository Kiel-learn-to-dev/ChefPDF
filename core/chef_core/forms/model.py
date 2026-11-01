"""Reading the AcroForm field tree (H1, H2): names, types, widgets, values and options.

Read only. Everything the other form modules need to know about an existing field lives here:

- ``FieldRef``: one terminal field (a text box, a checkbox, a radio group, a choice...). ``node``
  is the dictionary that holds /V and /FT (for a radio group that is the parent); ``widgets`` are
  the annotations drawn on pages (the node itself when it is merged with its widget).
- Inheritable attributes (/FT, /Ff, /V, /DA, /Q, /MaxLen, /Opt, /DV) are read through the
  /Parent chain, as the PDF spec says, by ``attr``.
- Geometry is reported in the displayed frame of the page (after /Rotate and CropBox), origin at
  the top-left corner, in points: ``[x0, top, x1, bottom]``.

Text strings are decoded from PDFDocEncoding (ASCII subset) or UTF-16BE with a byte order mark.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

import pikepdf
from pikepdf import Dictionary

from chef_core.overlay.engine import DocCache
from chef_core.overlay.pagecontent import page_frame
from chef_core.signing.anchors import PageFrame

Color = tuple[float, float, float]
Rect = tuple[float, float, float, float]

# /Ff bits (PDF 1.7 tables 221, 226, 230)
FF_READONLY = 1 << 0
FF_REQUIRED = 1 << 1
FF_NOEXPORT = 1 << 2
FF_MULTILINE = 1 << 12
FF_PASSWORD = 1 << 13
FF_NOTOGGLE = 1 << 14
FF_RADIO = 1 << 15
FF_PUSH = 1 << 16
FF_COMBO = 1 << 17
FF_EDIT = 1 << 18
FF_MULTISELECT = 1 << 21
FF_COMB = 1 << 24

TEXT_KINDS = frozenset({"text", "multiline", "password", "comb"})
JS_KEYS = {"/C": "calculate", "/F": "format", "/V": "validate", "/K": "keystroke"}


def text_of(obj: Any) -> str:
    """A PDF text string or name as Python text."""
    if isinstance(obj, pikepdf.Name):
        return str(obj)[1:]
    if isinstance(obj, pikepdf.String):
        raw = bytes(obj)
        if raw.startswith(b"\xfe\xff"):
            return raw[2:].decode("utf-16-be", errors="replace")
        return raw.decode("latin-1")
    return str(obj)


def text_string(value: str) -> pikepdf.String:
    """A Python string as a PDF text string (ASCII literal, else UTF-16BE with a BOM)."""
    if value.isascii():
        return pikepdf.String(value)
    return pikepdf.String(b"\xfe\xff" + value.encode("utf-16-be"))


def objgen_of(obj: Any) -> tuple[int, int] | None:
    objgen = getattr(obj, "objgen", None)
    if objgen is None or tuple(objgen) == (0, 0):
        return None
    return (int(objgen[0]), int(objgen[1]))


def attr(node: Any, key: str) -> Any:
    """An inheritable field attribute: the node's own value, else the nearest /Parent's."""
    current = node
    for _ in range(64):
        if not isinstance(current, Dictionary):
            return None
        if key in current:
            return current[key]
        current = current.get("/Parent")
    return None


def flags_of(node: Any) -> int:
    value = attr(node, "/Ff")
    return int(value) if value is not None else 0


def field_type(node: Any) -> str:
    value = attr(node, "/FT")
    return str(value) if value is not None else ""


def maxlen_of(node: Any) -> int | None:
    value = attr(node, "/MaxLen")
    return int(value) if value is not None else None


def kind_of(node: Any) -> str:
    """The user-facing kind of a field, from /FT and /Ff."""
    ft, ff = field_type(node), flags_of(node)
    if ft == "/Tx":
        if ff & FF_COMB and maxlen_of(node):
            return "comb"
        if ff & FF_MULTILINE:
            return "multiline"
        if ff & FF_PASSWORD:
            return "password"
        return "text"
    if ft == "/Btn":
        if ff & FF_RADIO:
            return "radio"
        if ff & FF_PUSH:
            return "button"
        return "checkbox"
    if ft == "/Ch":
        return "dropdown" if ff & FF_COMBO else "listbox"
    if ft == "/Sig":
        return "signature"
    return "unknown"


@dataclass
class FieldRef:
    name: str  # fully qualified name (dotted)
    partial: str  # /T of the terminal field
    node: Dictionary  # field dictionary holding /V (the parent of the widgets for a radio group)
    widgets: list[Dictionary]  # widget annotations of this field

    @property
    def kind(self) -> str:
        return kind_of(self.node)

    @property
    def flags(self) -> int:
        return flags_of(self.node)

    @property
    def read_only(self) -> bool:
        return bool(self.flags & FF_READONLY)

    @property
    def required(self) -> bool:
        return bool(self.flags & FF_REQUIRED)

    @property
    def max_len(self) -> int | None:
        return maxlen_of(self.node)


@dataclass
class FormDoc:
    """Per-document helper: page lookup, display frames and the overlay font cache."""

    pdf: pikepdf.Pdf
    doc: DocCache = field(init=False)
    _frames: dict[int, PageFrame] = field(default_factory=dict)
    _page_of: dict[tuple[int, int], int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self.doc = DocCache(self.pdf)
        for index, page in enumerate(self.pdf.pages):
            objgen = objgen_of(page.obj)
            if objgen is not None:
                self._page_of[objgen] = index

    @property
    def acroform(self) -> Dictionary | None:
        acro = self.pdf.Root.get("/AcroForm")
        return acro if isinstance(acro, Dictionary) else None

    def frame(self, index: int) -> PageFrame:
        if index not in self._frames:
            self._frames[index] = page_frame(self.pdf.pages[index])
        return self._frames[index]

    def page_of(self, widget: Dictionary) -> int | None:
        parent = widget.get("/P")
        if isinstance(parent, Dictionary):
            found = self._page_of.get(objgen_of(parent) or (-1, -1))
            if found is not None:
                return found
        target = objgen_of(widget)
        for index, page in enumerate(self.pdf.pages):
            for annot in page.obj.get("/Annots", []):
                if target is not None and objgen_of(annot) == target:
                    return index
        return None

    def display_rect(self, page_index: int, rect: Rect) -> list[float]:
        """A user-space rectangle as [x0, top, x1, bottom] in the displayed frame."""
        frame = self.frame(page_index)
        x0, y0, x1, y1 = frame.rect_to_display(rect)
        height = frame.display_size[1]
        return [round(x0, 3), round(height - y1, 3), round(x1, 3), round(height - y0, 3)]

    def fields(self) -> list[FieldRef]:
        acro = self.acroform
        if acro is None or "/Fields" not in acro:
            return []
        found: list[FieldRef] = []

        def visit(node: Dictionary, prefix: str) -> None:
            own = text_of(node["/T"]) if "/T" in node else None
            name = f"{prefix}.{own}" if prefix and own else (own or prefix)
            kids = node.get("/Kids")
            if kids is None:
                if own is not None:
                    found.append(FieldRef(name, own, node, [node]))
                return
            named = [k for k in kids if isinstance(k, Dictionary) and "/T" in k]
            widgets = [k for k in kids if isinstance(k, Dictionary) and "/T" not in k]
            if widgets and own is not None:
                found.append(FieldRef(name, own, node, widgets))
            for child in named:
                visit(child, name)

        for node in acro.Fields:
            if isinstance(node, Dictionary):
                visit(node, "")
        return found

    def find(self, name: str) -> FieldRef | None:
        for ref in self.fields():
            if ref.name == name:
                return ref
        return None


# -- values and options -----------------------------------------------------------------


def on_states(widget: Dictionary) -> list[str]:
    """Appearance state names of a button widget that are not /Off (its on-states)."""
    ap = widget.get("/AP")
    if not isinstance(ap, Dictionary):
        return []
    normal = ap.get("/N")
    if not isinstance(normal, Dictionary):
        return []
    names = [str(k).lstrip("/") for k in normal]
    return [name for name in names if name != "Off"]


def options_of(ref: FieldRef) -> list[dict[str, str]]:
    """Choices as ``{"export": ..., "display": ...}`` (display = export when unnamed)."""
    kind = ref.kind
    if kind in ("checkbox", "radio"):
        seen: list[str] = []
        for widget in ref.widgets:
            for state in on_states(widget):
                if state not in seen:
                    seen.append(state)
        return [{"export": s, "display": s} for s in seen]
    if kind in ("dropdown", "listbox"):
        out: list[dict[str, str]] = []
        for item in attr(ref.node, "/Opt") or []:
            if isinstance(item, pikepdf.Array) and len(item) >= 2:
                export, display = text_of(item[0]), text_of(item[1])
            else:
                export = display = text_of(item)
            out.append({"export": export, "display": display})
        return out
    return []


def value_of(ref: FieldRef) -> Any:
    """Current value: text, bool (checkbox), on-state name (radio), text or list (choice)."""
    raw = attr(ref.node, "/V")
    kind = ref.kind
    if kind in TEXT_KINDS or kind == "dropdown":
        return None if raw is None else text_of(raw)
    if kind == "listbox":
        if raw is None:
            return None
        if isinstance(raw, pikepdf.Array):
            return [text_of(v) for v in raw]
        return text_of(raw)
    if kind == "checkbox":
        return raw is not None and text_of(raw) not in ("", "Off")
    if kind == "radio":
        if raw is None or text_of(raw) == "Off":
            return None
        return text_of(raw)
    return None


def javascript_hooks(ref: FieldRef) -> list[str]:
    """JavaScript hooks present on the field or its widgets (calculate, format, ... action)."""
    hooks: set[str] = set()
    for node in [ref.node, *ref.widgets]:
        aa = node.get("/AA")
        if isinstance(aa, Dictionary):
            for key, label in JS_KEYS.items():
                if key in aa:
                    hooks.add(label)
        action = node.get("/A")
        if isinstance(action, Dictionary) and str(action.get("/S", "")) == "/JavaScript":
            hooks.add("action")
    return sorted(hooks)


def xfa_present(pdf: pikepdf.Pdf) -> bool:
    acro = pdf.Root.get("/AcroForm")
    return isinstance(acro, Dictionary) and "/XFA" in acro


_DA_SIZE = re.compile(r"([\d.]+)\s+Tf")
_DA_RGB = re.compile(r"([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg")
_DA_GRAY = re.compile(r"([\d.]+)\s+g\b")


def parse_da(da: str) -> tuple[float, Color]:
    """Font size (0 = auto) and text colour of a /DA string; black when absent."""
    size_match = _DA_SIZE.findall(da)
    size = float(size_match[-1]) if size_match else 0.0
    rgb = _DA_RGB.findall(da)
    if rgb:
        r, g, b = rgb[-1]
        return size, (float(r), float(g), float(b))
    gray = _DA_GRAY.findall(da)
    if gray:
        value = float(gray[-1])
        return size, (value, value, value)
    return size, (0.0, 0.0, 0.0)


def da_of(node: Any) -> str:
    raw = attr(node, "/DA")
    return text_of(raw) if raw is not None else "/Helv 0 Tf 0 g"


def colour_of_array(value: Any) -> Color | None:
    """A /MK colour array (gray, RGB or CMYK) as RGB; None for an empty array (transparent)."""
    if not isinstance(value, pikepdf.Array) or len(value) == 0:
        return None
    nums = [float(v) for v in value]
    if len(nums) == 1:
        return (nums[0], nums[0], nums[0])
    if len(nums) == 3:
        return (nums[0], nums[1], nums[2])
    if len(nums) == 4:
        c, m, y, k = nums
        return ((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k))
    return None


def border_width_of(widget: Dictionary) -> float:
    bs = widget.get("/BS")
    if isinstance(bs, Dictionary) and "/W" in bs:
        return float(bs["/W"])
    return 1.0
