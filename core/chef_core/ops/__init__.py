"""Operations. Each group lives in its own module and registers itself on import."""

from __future__ import annotations

import importlib

from chef_core.ops.base import OpContext, OpOutput, OpSpec, get_op, operation, registry

BUILTIN_MODULES = ("chef_core.ops.page", "chef_core.ops.file")


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
