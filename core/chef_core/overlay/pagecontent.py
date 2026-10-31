"""Page content helpers for overlays: frame, content bytes and resources (T4.01).

Resources are always copied before they change (copy-on-write). Pages often inherit one
/Resources dictionary from the page tree, and an overlay on one page must not show up on the
others.
"""

from __future__ import annotations

import pikepdf

from chef_core.pdf.pages import normalized_rotation
from chef_core.signing.anchors import PageFrame

# Resource categories whose dictionaries are copied with the resources (one level deep).
CATEGORY_KEYS = (
    "/Font",
    "/XObject",
    "/ExtGState",
    "/ColorSpace",
    "/Pattern",
    "/Shading",
    "/Properties",
)


def page_frame(page: pikepdf.Page) -> PageFrame:
    """Crop box, /Rotate and the displayed frame of a page (same convention as signing)."""
    x0, y0, x1, y1 = (float(v) for v in page.cropbox)
    return PageFrame(
        x0=min(x0, x1),
        y0=min(y0, y1),
        x1=max(x0, x1),
        y1=max(y0, y1),
        rotation=normalized_rotation(page),
    )


def content_bytes(page: pikepdf.Page) -> bytes:
    """The whole content of a page: the streams of /Contents joined by newlines."""
    contents = page.obj.get("/Contents")
    if contents is None:
        return b""
    if isinstance(contents, pikepdf.Array):
        return b"\n".join(stream.read_bytes() for stream in contents)
    return contents.read_bytes()


def set_content(pdf: pikepdf.Pdf, page: pikepdf.Page, data: bytes) -> None:
    page.obj.Contents = pdf.make_stream(data)


def inherited(obj: pikepdf.Object, key: str) -> pikepdf.Object | None:
    """Value of an inheritable page attribute, looked up through /Parent."""
    node: pikepdf.Object | None = obj
    seen = 0
    while isinstance(node, pikepdf.Dictionary) and seen < 64:
        if key in node:
            return node[key]
        node = node.get("/Parent")
        seen += 1
    return None


def own_resources(page: pikepdf.Page) -> pikepdf.Dictionary:
    """A fresh /Resources dictionary for the page, copied from the (inherited) one."""
    source = inherited(page.obj, "/Resources")
    fresh = pikepdf.Dictionary()
    if isinstance(source, pikepdf.Dictionary):
        for key, value in source.items():
            if key in CATEGORY_KEYS and isinstance(value, pikepdf.Dictionary):
                fresh[key] = pikepdf.Dictionary(dict(value.items()))
            else:
                fresh[key] = value
    page.obj.Resources = fresh
    result = page.obj.Resources
    assert isinstance(result, pikepdf.Dictionary)
    return result


def category(res: pikepdf.Dictionary, key: str) -> pikepdf.Dictionary:
    """The category dictionary (created when missing). ``res`` must be owned."""
    if key not in res or not isinstance(res[key], pikepdf.Dictionary):
        res[key] = pikepdf.Dictionary()
    value = res[key]
    assert isinstance(value, pikepdf.Dictionary)
    return value


def resource_names(res: pikepdf.Dictionary | None, key: str) -> set[str]:
    if res is None or key not in res or not isinstance(res[key], pikepdf.Dictionary):
        return set()
    return {str(name).lstrip("/") for name in res[key]}
