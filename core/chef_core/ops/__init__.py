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
