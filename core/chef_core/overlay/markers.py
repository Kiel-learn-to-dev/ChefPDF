"""Chef markers in page content (T4.01, D14, F12).

Every overlay chunk is marked content. The outer block (for pagination kinds) is a standard
artifact, so that screen readers and watermark detection (NOTES "Dò watermark") see it as an
artifact. The inner block carries the Chef property list:

    /Artifact <</Type /Pagination /Subtype /Watermark>> BDC
      /ChefOverlay <</Id (<32 hex>) /Kind (watermark) /Group (<32 hex>) /V 1>> BDC
        ... drawing operators ...
      EMC
    EMC

Pages that have any overlay are wrapped once in ``/ChefWrap BMC q <original> Q EMC``, so the
overlays never inherit a graphics state that the original content left behind. The wrap is
removed when the last overlay of the page goes.
"""

from __future__ import annotations

from dataclasses import dataclass

import pikepdf

TAG_OVERLAY = "ChefOverlay"
TAG_WRAP = "ChefWrap"
PROPERTY_VERSION = 1

KINDS = (
    "text",
    "image",
    "watermark",
    "stamp",
    "header",
    "footer",
    "number",
    "qr",
    "letterhead",
)

# Artifact dictionary for kinds that are page furniture rather than content.
ARTIFACT_DICTS: dict[str, str] = {
    "watermark": "<</Type /Pagination /Subtype /Watermark>>",
    "header": "<</Type /Pagination /Subtype /Header>>",
    "footer": "<</Type /Pagination /Subtype /Footer>>",
    "number": "<</Type /Pagination /Subtype /Footer>>",
    "letterhead": "<</Type /Layout>>",
}


def artifact_dict(kind: str) -> str | None:
    return ARTIFACT_DICTS.get(kind)


def overlay_block(*, overlay_id: str, group: str, kind: str, body: str) -> str:
    """The marked content of one overlay chunk (with the artifact wrapper when the kind has one)."""
    inner = (
        f"/{TAG_OVERLAY} <</Id ({overlay_id}) /Kind ({kind}) /Group ({group}) "
        f"/V {PROPERTY_VERSION}>> BDC\n{body}\nEMC\n"
    )
    dict_text = artifact_dict(kind)
    if dict_text is None:
        return inner
    return f"/Artifact {dict_text} BDC\n{inner}EMC\n"


WRAP_BEGIN = f"/{TAG_WRAP} BMC\nq\n"
WRAP_END = "\nQ\nEMC\n"


@dataclass(frozen=True)
class OverlayProps:
    """The Chef property list of one marked block."""

    overlay_id: str
    kind: str
    group: str

    @classmethod
    def from_dict(cls, props: pikepdf.Object) -> OverlayProps | None:
        if not isinstance(props, pikepdf.Dictionary):
            return None
        try:
            return cls(
                overlay_id=_text(props["/Id"]),
                kind=_text(props["/Kind"]),
                group=_text(props["/Group"]),
            )
        except KeyError:
            return None


def _text(value: pikepdf.Object) -> str:
    if isinstance(value, pikepdf.String):
        return str(value)
    if isinstance(value, pikepdf.Name):
        return str(value).lstrip("/")
    raise KeyError("not text")
