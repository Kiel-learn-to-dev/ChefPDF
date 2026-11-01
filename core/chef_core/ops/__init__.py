"""Operations. Each group lives in its own module and registers itself on import."""

from __future__ import annotations

import importlib

from chef_core.ops.base import OpContext, OpOutput, OpSpec, get_op, operation, registry

BUILTIN_MODULES = (
    "chef_core.ops.page",
    "chef_core.ops.file",
    "chef_core.ops.scan",
    "chef_core.ops.scan_preview",
    "chef_core.ops.scan_fit",
    "chef_core.ops.sign",
    "chef_core.ops.sign_fields",
    "chef_core.ops.sign_token",
    "chef_core.ops.sign_verify",
    "chef_core.ops.sign_anchor",
    "chef_core.ops.sign_trust",
    "chef_core.ops.sign_batch",
    "chef_core.ops.image_sig",
    "chef_core.ops.overlay",
    "chef_core.ops.overlay_header",
    "chef_core.ops.overlay_bates",
    "chef_core.ops.overlay_code",
    "chef_core.ops.bookmarks",
    "chef_core.ops.stamp",
    "chef_core.ops.sign_stamp",
    "chef_core.ops.sign_preview",
    "chef_core.ops.sign_report",
    "chef_core.ops.security",
    "chef_core.ops.inspect",
    "chef_core.ops.preflight",
    "chef_core.ops.docutils",
    "chef_core.ops.compress",
    "chef_core.ops.convert",
    "chef_core.ops.color",
    "chef_core.ops.pageedit",
    "chef_core.ops.content",
    "chef_core.ops.content_image",
    "chef_core.ops.content_erase",
    "chef_core.ops.content_layers",
    "chef_core.ops.content_watermark",
    "chef_core.ops.text_edit",
    "chef_core.ops.text_paragraph",
    "chef_core.ops.links",
    "chef_core.ops.annots",
    "chef_core.ops.annots_export",
    "chef_core.ops.redact",
    "chef_core.ops.pageimg",
    "chef_core.ops.forms",
    "chef_core.ops.workflow",
    "chef_core.ops.naming",
    "chef_core.ops.watch",
)


def load_builtin_ops() -> None:
    for name in BUILTIN_MODULES:
        importlib.import_module(name)


__all__ = [
    "OpContext",
    "OpOutput",
    "OpSpec",
    "get_op",
    "load_builtin_ops",
    "operation",
    "registry",
]
