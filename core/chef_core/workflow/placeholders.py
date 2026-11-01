"""Placeholders in workflow params (T9.02).

- ``{{name}}``: a variable. Built in (``name``, ``filename``, ``date``, ``time``, ``index``,
  ``parent``) or declared in the workflow / given by the run request.
- ``{{secret:name}}``: a secret (certificate password, token PIN, document password). The value
  comes from the run request only. It is never stored in the workflow JSON, the journal or a log.

Placeholders are plain text inside string params, so they are only valid in text fields.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterator, Mapping
from typing import Any

PLACEHOLDER_RE = re.compile(r"\{\{\s*([^{}]+?)\s*\}\}")
SECRET_PREFIX = "secret:"
BUILTIN_VARIABLES = frozenset({"name", "filename", "date", "time", "index", "parent"})

# Param keys whose values are secrets (the same keys the session journal drops).
SECRET_KEYS = frozenset({"password", "pin", "inputPassword", "userPassword", "ownerPassword"})


class MissingValue(LookupError):
    """A placeholder has no value in this run. ``name`` is the placeholder text, never a value."""

    def __init__(self, name: str) -> None:
        super().__init__(name)
        self.name = name


def placeholder_names(text: str) -> list[str]:
    return [m.group(1).strip() for m in PLACEHOLDER_RE.finditer(text)]


def is_secret(name: str) -> bool:
    return name.startswith(SECRET_PREFIX)


def secret_name(name: str) -> str:
    return name[len(SECRET_PREFIX) :]


def iter_strings(value: Any, path: str = "") -> Iterator[tuple[str, str]]:
    """Every string inside ``value`` with its path (``stamps[0].params.text``)."""
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, Mapping):
        for key, item in value.items():
            yield from iter_strings(item, f"{path}.{key}" if path else str(key))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            yield from iter_strings(item, f"{path}[{index}]")


def literal_secret_paths(value: Any, path: str = "") -> list[str]:
    """Paths of secret params that hold a literal value instead of a placeholder."""
    found: list[str] = []
    if isinstance(value, Mapping):
        for key, item in value.items():
            here = f"{path}.{key}" if path else str(key)
            if (
                key in SECRET_KEYS
                and isinstance(item, str)
                and item
                and not PLACEHOLDER_RE.search(item)
            ):
                found.append(here)
            found.extend(literal_secret_paths(item, here))
    elif isinstance(value, list):
        for index, item in enumerate(value):
            found.extend(literal_secret_paths(item, f"{path}[{index}]"))
    return found


def expand(value: Any, lookup: Callable[[str], str]) -> Any:
    """A copy of ``value`` with every placeholder replaced by ``lookup(name)``."""
    if isinstance(value, str):
        return PLACEHOLDER_RE.sub(lambda m: lookup(m.group(1).strip()), value)
    if isinstance(value, Mapping):
        return {key: expand(item, lookup) for key, item in value.items()}
    if isinstance(value, list):
        return [expand(item, lookup) for item in value]
    return value


def scrub(text: str, secrets: Mapping[str, str]) -> str:
    """``text`` with every secret value replaced, for messages that may echo one."""
    for value in secrets.values():
        if value:
            text = text.replace(value, "***")
    return text
