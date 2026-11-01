"""File names: templates, sanitising, collisions and batch renames (T9.06, O4, O6).

Template tokens (single braces)::

    {name}     file name without extension          {date}  YYYY-MM-DD
    {index}    1-based position in the batch         {time}  HHMMSS
    {seq:N}    index padded with zeros to N digits   {pages} page count (PDF only)
    {parent}   name of the folder that holds it      {title} /Title in the metadata (PDF only)
    {counter}  1-based count of files that got a name so far in this batch

Conflict policy: ``suffix`` gives ``name (2).pdf``, ``skip`` leaves the item out, ``overwrite``
replaces an existing file that is not part of the batch.

Windows rules: characters ``<>:"/\\|?*`` and control characters become ``_``, trailing dots and
spaces are dropped, reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) get a ``_``
prefix, and the full path stays under 240 characters.
"""

from __future__ import annotations

import logging
import os
import re
import unicodedata
import uuid
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import Literal

Conflict = Literal["suffix", "skip", "overwrite"]
PlanStatus = Literal["ready", "unchanged", "skipped", "invalid"]

CONFLICT_POLICIES: tuple[str, ...] = ("suffix", "skip", "overwrite")
TOKEN_RE = re.compile(r"\{([^{}]*)\}")
SEQ_RE = re.compile(r"^seq:([1-9][0-9]?)$")
PLAIN_TOKENS = frozenset({"name", "index", "date", "time", "pages", "parent", "title", "counter"})
ILLEGAL_RE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
RESERVED = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{i}" for i in range(1, 10)}
    | {f"LPT{i}" for i in range(1, 10)}
)
MAX_BASE_LENGTH = 150
MAX_PATH_LENGTH = 240
DEFAULT_EXT = ".pdf"
log = logging.getLogger(__name__)


@dataclass(frozen=True)
class NameValues:
    """What a template can use for one file."""

    name: str
    index: int
    when: datetime
    pages: int | None = None
    parent: str = ""
    title: str | None = None
    counter: int = 1


def check_template(template: str) -> list[str]:
    """Problems in a name template (Vietnamese messages); an empty list when it is valid."""
    if not template.strip():
        return ["Mẫu tên không được để trống."]
    problems: list[str] = []
    for match in TOKEN_RE.finditer(template):
        token = match.group(1).strip()
        if token not in PLAIN_TOKENS and not SEQ_RE.match(token):
            problems.append(f"Thẻ {{{token}}} không có trong danh sách thẻ hỗ trợ.")
    if "{" in TOKEN_RE.sub("", template) or "}" in TOKEN_RE.sub("", template):
        problems.append("Dấu ngoặc nhọn không đóng đúng cặp.")
    return problems


def render_template(template: str, values: NameValues) -> str:
    """The text a valid template gives for ``values`` (not yet sanitised)."""

    def token(match: re.Match[str]) -> str:
        key = match.group(1).strip()
        seq = SEQ_RE.match(key)
        if seq:
            return str(values.index).zfill(int(seq.group(1)))
        simple = {
            "name": values.name,
            "index": str(values.index),
            "date": values.when.strftime("%Y-%m-%d"),
            "time": values.when.strftime("%H%M%S"),
            "pages": "" if values.pages is None else str(values.pages),
            "parent": values.parent,
            "title": values.title or "",
            "counter": str(values.counter),
        }
        if key not in simple:
            raise ValueError(f"unknown token {key}")
        return simple[key]

    return TOKEN_RE.sub(token, template)


def sanitize_base(text: str, max_length: int = MAX_BASE_LENGTH) -> str:
    """A file name without extension that Windows accepts."""
    cleaned = unicodedata.normalize("NFC", text)
    cleaned = ILLEGAL_RE.sub("_", cleaned).strip().rstrip(" .")
    if not cleaned:
        return "file"
    if cleaned.split(".", 1)[0].upper() in RESERVED:
        cleaned = "_" + cleaned
    return cleaned[:max_length].rstrip(" .") or "file"


def _fit_length(folder: Path, base: str, ext: str) -> str:
    """Shorten ``base`` until the full path (with room for " (99)") is within the limit."""
    room = MAX_PATH_LENGTH - len(str(folder)) - len(os.sep) - len(ext) - len(" (99)")
    if len(base) <= room:
        return base
    return base[: max(1, room)].rstrip(" .") or "file"


def _key(path: Path) -> str:
    return str(path).casefold()


def unique_target(
    folder: Path,
    base: str,
    conflict: Conflict,
    reserved: set[str],
    *,
    exclude: Iterable[Path] = (),
    ext: str = DEFAULT_EXT,
) -> Path | None:
    """The file ``base + ext`` in ``folder`` under the conflict policy; None means skip.

    ``reserved`` holds the names already given out (lower-cased) and is updated. A file that
    exists on disk counts as taken unless it is in ``exclude`` (members of a batch that move
    away). A name is never handed out twice in one batch, whatever the policy.
    """
    free_on_disk = {_key(p) for p in exclude}
    base = _fit_length(folder, base, ext)

    def taken(candidate: Path) -> bool:
        if _key(candidate) in reserved:
            return True
        return candidate.exists() and _key(candidate) not in free_on_disk

    first = folder / f"{base}{ext}"
    if conflict == "overwrite" and _key(first) not in reserved:
        reserved.add(_key(first))
        return first
    if not taken(first):
        reserved.add(_key(first))
        return first
    if conflict == "skip":
        return None
    number = 2
    while True:
        candidate = folder / f"{base} ({number}){ext}"
        if not taken(candidate):
            reserved.add(_key(candidate))
            return candidate
        number += 1


@dataclass(frozen=True)
class RenamePlan:
    source: Path
    target: Path | None
    status: PlanStatus
    message: str | None = None


def plan_renames(
    paths: Sequence[Path],
    template: str,
    conflict: Conflict,
    values_for: Callable[[Path], NameValues],
) -> list[RenamePlan]:
    """Where each file would go. Nothing on disk changes. The extension of each file is kept."""
    problems = check_template(template)
    if problems:
        return [RenamePlan(p, None, "invalid", problems[0]) for p in paths]
    bases: list[str | None] = []
    errors: list[str | None] = []
    counter = 0
    for index, path in enumerate(paths, start=1):
        try:
            counter += 1
            values = replace(values_for(path), index=index, counter=counter)
            bases.append(sanitize_base(render_template(template, values)))
            errors.append(None)
        except (ValueError, OSError) as exc:
            bases.append(None)
            errors.append(str(exc))
    reserved: set[str] = set()
    for path, base in zip(paths, bases, strict=True):
        if base is not None and path.name == f"{base}{path.suffix}":
            reserved.add(_key(path))  # keeps its name: nobody else may take it
    plans: list[RenamePlan] = []
    for path, base, error in zip(paths, bases, errors, strict=True):
        if base is None:
            plans.append(RenamePlan(path, None, "invalid", error))
        elif path.name == f"{base}{path.suffix}":
            plans.append(RenamePlan(path, path, "unchanged"))
        else:
            target = unique_target(
                path.parent, base, conflict, reserved, exclude=paths, ext=path.suffix
            )
            if target is None:
                plans.append(RenamePlan(path, None, "skipped", "Tên đã có, bỏ qua"))
            else:
                plans.append(RenamePlan(path, target, "ready"))
    return plans


def _restore(tmp: Path, src: Path) -> None:
    """Put a staged file back under its old name. If that fails, the message says so."""
    try:
        os.replace(tmp, src)
    except OSError:
        log.error("could not restore %s from %s", src, tmp)


def apply_mapping(
    pairs: Sequence[tuple[Path, Path]], *, replace_existing: bool = False
) -> list[dict[str, str | None]]:
    """Rename ``source`` to ``target`` for every pair, in two phases so that swaps work.

    A target that exists when its turn comes is refused and the file keeps its name, unless
    ``replace_existing`` (the overwrite policy). Returns one row per pair: ``from``, ``to``,
    ``status`` (``done`` or ``failed``) and ``message``.
    """
    rows: list[dict[str, str | None]] = [
        {"from": str(src), "to": str(dst), "status": "failed", "message": None}
        for src, dst in pairs
    ]
    staged: list[tuple[int, Path, Path]] = []
    for index, (src, dst) in enumerate(pairs):
        if src == dst:
            rows[index]["status"] = "done"
            continue
        tmp = src.with_name(f".{uuid.uuid4().hex[:12]}.renaming")
        try:
            os.replace(src, tmp)
        except OSError as exc:
            rows[index]["message"] = f"Không đổi được tên: {exc.strerror or exc}"
            continue
        staged.append((index, src, tmp))
    for index, src, tmp in staged:
        dst = pairs[index][1]
        try:
            if dst.exists() and not replace_existing:
                raise FileExistsError(str(dst))
            os.replace(tmp, dst)
            rows[index]["status"] = "done"
        except FileExistsError:
            rows[index]["message"] = "Tệp đích đã tồn tại"
            _restore(tmp, src)
        except OSError as exc:
            rows[index]["message"] = f"Không đổi được tên: {exc.strerror or exc}"
            _restore(tmp, src)
    return rows
