"""Output names for batch jobs (T3.13 signing, T4.07 Bates numbering).

- ``resolve_output_path``: where a result goes. Names never overwrite a file that exists:
  ``name.pdf``, then ``name (2).pdf``, ``name (3).pdf``...
- ``common_folder``: the folder that holds a set of inputs.
"""

from __future__ import annotations

import os
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from chef_core.errors import ChefError, ErrorKind

OutputMode = Literal["suffix", "folder", "overwrite"]


@dataclass(frozen=True)
class OutputRule:
    mode: OutputMode
    suffix: str = "_signed"
    folder: Path | None = None


def _taken(candidate: Path, reserved: set[str]) -> bool:
    return candidate.exists() or str(candidate).casefold() in reserved


def resolve_output_path(source: Path, rule: OutputRule, reserved: set[str]) -> Path:
    """The file a result for ``source`` is written to; never an existing file.

    ``reserved`` holds names already given out in this batch (lower-cased), so two inputs with
    the same name in one folder get different outputs even before the first is written.
    """
    if rule.mode == "overwrite":
        return source
    if rule.mode == "suffix":
        folder = source.parent
        stem = source.stem + rule.suffix
    else:
        if rule.folder is None:
            raise ChefError(ErrorKind.INVALID_PARAMS, "folder is required", {"field": "folder"})
        folder = rule.folder
        stem = source.stem
    candidate = folder / f"{stem}.pdf"
    number = 2
    while _taken(candidate, reserved):
        candidate = folder / f"{stem} ({number}).pdf"
        number += 1
    reserved.add(str(candidate).casefold())
    return candidate


def common_folder(paths: Sequence[Path]) -> Path | None:
    """The folder that holds all of ``paths`` (their closest common ancestor), or None."""
    if not paths:
        return None
    parents = [str(p.parent) for p in paths]
    if len(set(parents)) == 1:
        return paths[0].parent
    try:
        return Path(os.path.commonpath(parents))
    except ValueError:  # different drives
        return None
