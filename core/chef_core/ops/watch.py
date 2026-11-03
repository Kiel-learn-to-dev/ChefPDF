"""Watched folders (T9.05 core): ``watch.scan`` and ``watch.markDone``.

The Electron main process calls ``watch.scan`` every few seconds for each watched folder. It gets
the files that are complete and queued; it runs a workflow on them (``workflow.run``) and reports
each result with ``watch.markDone``. Both ops keep their state in ``ledgerPath`` (a JSON file the
app owns, for example in the user data folder).
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Literal

from pydantic import Field

from chef_core.errors import ChefError, ErrorKind
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.workflow.watch import WatchState


class WatchScanParams(WireModel):
    directory: str = Field(min_length=1, max_length=1024, description="Folder to watch.")
    output_directory: str | None = Field(default=None, max_length=1024)
    ledger_path: str = Field(min_length=1, max_length=1024, description="State file (JSON).")
    settle_seconds: float = Field(
        default=3.0, ge=0, le=3600, description="Size and time must not change for this long."
    )
    pattern: str = Field(default="*.pdf", min_length=1, max_length=100)


class WatchMarkDoneParams(WireModel):
    ledger_path: str = Field(min_length=1, max_length=1024)
    path: str = Field(min_length=1, max_length=1024, description="The file that was handled.")
    output_path: str | None = Field(default=None, max_length=1024)
    status: Literal["done", "failed", "skipped"] = Field(default="done")


class WatchReleaseParams(WireModel):
    ledger_path: str = Field(min_length=1, max_length=1024)
    paths: list[str] = Field(default_factory=list, max_length=10_000)


@operation(
    id="watch.scan",
    title="Quét thư mục theo dõi",
    group="watch",
    params=WatchScanParams,
    standalone=True,
)
def watch_scan(ctx: OpContext, p: WatchScanParams) -> OpOutput:
    directory = Path(p.directory)
    if not directory.is_dir():
        raise ChefError(ErrorKind.FILE_NOT_FOUND, "Folder not found", {"path": p.directory})
    if p.output_directory and directory.resolve() == Path(p.output_directory).resolve():
        raise ChefError(
            ErrorKind.INVALID_PARAMS,
            "Watched source and output folders must be different",
            {"directory": p.directory, "outputDirectory": p.output_directory},
        )
    ledger = Path(p.ledger_path)
    state = WatchState.load(ledger)
    ready = state.scan(
        directory,
        settle_seconds=p.settle_seconds,
        now=time.time(),
        pattern=p.pattern,
    )
    state.save(ledger)
    files = [{"path": f.path, "size": f.size, "mtimeNs": f.mtime_ns} for f in ready]
    return OpOutput(data={"ready": files, "pending": len(state.pending)})


@operation(
    id="watch.markDone",
    title="Ghi kết quả file theo dõi",
    group="watch",
    params=WatchMarkDoneParams,
    standalone=True,
)
def watch_mark_done(ctx: OpContext, p: WatchMarkDoneParams) -> OpOutput:
    ledger = Path(p.ledger_path)
    state = WatchState.load(ledger)
    output = Path(p.output_path) if p.output_path else None
    state.mark_done(Path(p.path), output_path=output, status=p.status, now=time.time())
    state.save(ledger)
    return OpOutput(data={"ok": True})


@operation(
    id="watch.release",
    title="Giải phóng file chưa xử lý",
    group="watch",
    params=WatchReleaseParams,
    standalone=True,
)
def watch_release(ctx: OpContext, p: WatchReleaseParams) -> OpOutput:
    ledger = Path(p.ledger_path)
    state = WatchState.load(ledger)
    released = state.release([Path(path) for path in p.paths])
    state.save(ledger)
    return OpOutput(data={"released": released})
