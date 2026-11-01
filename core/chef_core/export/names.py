"""Output names of batch exports (N7).

The same rules as the other batch jobs (``pdf/outnames.py``): a name never overwrites a file that
exists, nor a name given out earlier in the same batch (``name (2).md``...). The file extension is
the format's, and the images folder of Markdown and HTML (``<name>_files``) must be free too.
Overwriting the source is refused for exports: a PDF is not replaced by its own export.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from chef_core.errors import ChefError, ErrorKind
from chef_core.export.files import assets_folder
from chef_core.export.options import EXTENSIONS

OutputMode = Literal["suffix", "folder"]
FOLDER_FORMATS = ("md", "html")


@dataclass(frozen=True)
class OutputRule:
    mode: OutputMode
    suffix: str = "_export"
    folder: Path | None = None


def _taken(candidate: Path, fmt: str, reserved: set[str]) -> bool:
    if candidate.exists() or str(candidate).casefold() in reserved:
        return True
    return fmt in FOLDER_FORMATS and assets_folder(candidate).exists()


def target_for(source: Path, fmt: str, rule: OutputRule, reserved: set[str]) -> Path:
    """The file a batch export of ``source`` is written to (never an existing one)."""
    if fmt not in EXTENSIONS:
        raise ChefError(ErrorKind.INVALID_PARAMS, f"Unknown format: {fmt}", {"field": "format"})
    if rule.mode == "folder":
        if rule.folder is None:
            raise ChefError(ErrorKind.INVALID_PARAMS, "folder is required", {"field": "folder"})
        folder = rule.folder
        stem = source.stem
    else:
        folder = source.parent
        stem = source.stem + rule.suffix
    extension = EXTENSIONS[fmt]
    candidate = folder / f"{stem}{extension}"
    number = 2
    while _taken(candidate, fmt, reserved):
        candidate = folder / f"{stem} ({number}){extension}"
        number += 1
    reserved.add(str(candidate).casefold())
    if fmt in FOLDER_FORMATS:
        reserved.add(str(assets_folder(candidate)).casefold())
    return candidate
