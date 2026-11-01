"""File naming operations (T9.06, O4, O6): ``naming.preview``, ``naming.apply`` and
``files.renameBatch``. All three are standalone and work on file paths.

Every rename returns the mapping it made, so the caller can undo it by sending the reversed
mapping to ``files.renameBatch``.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, model_validator

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.workflow.naming import (
    NameValues,
    RenamePlan,
    apply_mapping,
    check_template,
    plan_renames,
)
from chef_core.workflow.runner import pdf_facts

Conflict = Literal["suffix", "skip", "overwrite"]
MAX_FILES = 5000


class NamingParams(WireModel):
    files: list[str] = Field(min_length=1, max_length=MAX_FILES, description="Files to rename.")
    template: str = Field(
        min_length=1,
        max_length=200,
        description="Tokens: {name} {index} {seq:N} {date} {time} {pages} {parent} {title} "
        "{counter}.",
    )
    conflict: Conflict = Field(default="suffix", description="suffix | skip | overwrite.")


class RenameMapping(WireModel):
    source: str = Field(min_length=1, max_length=1024)
    target: str = Field(min_length=1, max_length=1024)


class RenameBatchParams(WireModel):
    files: list[str] = Field(default_factory=list, max_length=MAX_FILES)
    template: str | None = Field(default=None, min_length=1, max_length=200)
    mapping: list[RenameMapping] | None = Field(
        default=None, min_length=1, max_length=MAX_FILES, description="Exact renames (undo)."
    )
    conflict: Conflict = Field(default="suffix")
    dry_run: bool = Field(default=True, description="True: only show old and new names.")

    @model_validator(mode="after")
    def _one_way(self) -> RenameBatchParams:
        if (self.template is None) == (self.mapping is None):
            raise ValueError("give exactly one of template or mapping")
        if self.template is not None and not self.files:
            raise ValueError("files is required with a template")
        return self


def _values_for(path: Path) -> NameValues:
    stat = path.stat()
    pages, title = pdf_facts(path, None) if path.suffix.lower() == ".pdf" else (None, None)
    return NameValues(
        name=path.stem,
        index=1,
        when=datetime.fromtimestamp(stat.st_mtime),
        pages=pages,
        parent=path.parent.name,
        title=title,
    )


def _require_files(paths: list[Path]) -> None:
    for path in paths:
        if not path.is_file():
            raise ChefError(ErrorKind.FILE_NOT_FOUND, "File not found", {"path": str(path)})


def _plan_row(plan: RenamePlan) -> dict[str, Any]:
    return {
        "from": str(plan.source),
        "to": str(plan.target) if plan.target is not None else None,
        "status": plan.status,
        "message": plan.message,
    }


def _summary(items: list[dict[str, Any]]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in items:
        counts[item["status"]] = counts.get(item["status"], 0) + 1
    return counts


def _result(items: list[dict[str, Any]], dry_run: bool) -> dict[str, Any]:
    data: dict[str, Any] = {
        "dryRun": dry_run,
        "items": items,
        "collisions": [i for i in items if i["status"] in ("skipped", "invalid")],
        "summary": _summary(items),
    }
    if not dry_run:
        undo = [{"source": i["to"], "target": i["from"]} for i in items if i["status"] == "done"]
        data["undo"] = {"mapping": undo}
    return data


def rename_by_template(
    files: list[str], template: str, conflict: Conflict, dry_run: bool
) -> dict[str, Any]:
    problems = check_template(template)
    if problems:
        raise invalid_params(problems[0], {"field": "template"})
    paths = [Path(f) for f in files]
    _require_files(paths)
    plans = plan_renames(paths, template, conflict, _values_for)
    if dry_run:
        return _result([_plan_row(p) for p in plans], dry_run=True)
    pairs = [(p.source, p.target) for p in plans if p.status == "ready" and p.target is not None]
    rows = apply_mapping(pairs, replace_existing=conflict == "overwrite")
    applied = {str(src): row for (src, _dst), row in zip(pairs, rows, strict=True)}
    items: list[dict[str, Any]] = []
    for plan in plans:
        if str(plan.source) in applied:
            items.append(applied[str(plan.source)])
        else:
            items.append(_plan_row(plan))
    return _result(items, dry_run=False)


def rename_by_mapping(pairs: list[tuple[str, str]], dry_run: bool) -> dict[str, Any]:
    sources = [Path(src) for src, _dst in pairs]
    _require_files(sources)
    source_keys = {str(p).casefold() for p in sources}
    items: list[dict[str, Any]] = []
    ready: list[tuple[Path, Path]] = []
    claimed: set[str] = set()
    for src, dst in pairs:
        source, target = Path(src), Path(dst)
        if not target.parent.is_dir():
            items.append(
                {
                    "from": src,
                    "to": dst,
                    "status": "invalid",
                    "message": "Thư mục đích không tồn tại",
                }
            )
            continue
        key = str(target).casefold()
        if key in claimed or (target.exists() and key not in source_keys):
            items.append(
                {"from": src, "to": dst, "status": "skipped", "message": "Tệp đích đã tồn tại"}
            )
            continue
        claimed.add(key)
        if source == target:
            items.append({"from": src, "to": dst, "status": "unchanged", "message": None})
            continue
        ready.append((source, target))
        items.append({"from": src, "to": dst, "status": "ready", "message": None})
    if dry_run:
        return _result(items, dry_run=True)
    rows = iter(apply_mapping(ready))
    final: list[dict[str, Any]] = []
    for item in items:
        if item["status"] == "ready":
            final.append(next(rows))
        else:
            final.append(item)
    return _result(final, dry_run=False)


@operation(
    id="naming.preview",
    title="Xem tên mới",
    group="naming",
    params=NamingParams,
    standalone=True,
)
def naming_preview(ctx: OpContext, p: NamingParams) -> OpOutput:
    return OpOutput(data=rename_by_template(p.files, p.template, p.conflict, dry_run=True))


@operation(
    id="naming.apply",
    title="Đặt tên theo mẫu",
    group="naming",
    params=NamingParams,
    standalone=True,
)
def naming_apply(ctx: OpContext, p: NamingParams) -> OpOutput:
    return OpOutput(data=rename_by_template(p.files, p.template, p.conflict, dry_run=False))


@operation(
    id="files.renameBatch",
    title="Đổi tên hàng loạt",
    group="files",
    params=RenameBatchParams,
    standalone=True,
)
def files_rename_batch(ctx: OpContext, p: RenameBatchParams) -> OpOutput:
    if p.mapping is not None:
        pairs = [(m.source, m.target) for m in p.mapping]
        return OpOutput(data=rename_by_mapping(pairs, dry_run=p.dry_run))
    assert p.template is not None
    return OpOutput(data=rename_by_template(p.files, p.template, p.conflict, dry_run=p.dry_run))
