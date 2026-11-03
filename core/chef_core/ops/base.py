"""Operation registry and the context object passed to every operation.

An operation is a plain function ``run(ctx, params) -> OpOutput`` registered with
``@operation(...)``. Operations only deal with file paths (``ctx.input_path`` is the current
revision, ``ctx.result_path`` is where a new revision must be written), which keeps them
independent from the session machinery and lets heavy ops move to a process pool later.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterable, Iterator
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

import pikepdf

from chef_core.errors import CancelledError
from chef_core.models import WireModel
from chef_core.pdf.io import atomic_save, open_pdf

if TYPE_CHECKING:
    from chef_core.session.manager import EncryptionState

ChangedPages = list[int] | Literal["all"]
ProgressSink = Callable[[int, int, str | None], None]


@dataclass
class OpOutput:
    changed_pages: ChangedPages = "all"
    outputs: list[str] = field(default_factory=list)
    data: Any = None
    # Called with the Session after a successful run that committed no revision (for
    # operations that change session state only, such as the protection profile).
    session_effect: Callable[[Any], None] | None = None


RunFn = Callable[["OpContext", Any], OpOutput]


@dataclass(frozen=True)
class OpSpec:
    id: str
    title: str
    group: str
    params_model: type[WireModel]
    run: RunFn
    destructive: bool = False
    finalizing: bool = False
    batchable: bool = False
    standalone: bool = False

    def params_schema(self) -> dict[str, Any]:
        return self.params_model.model_json_schema(by_alias=True)

    def descriptor(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "group": self.group,
            "paramsSchema": self.params_schema(),
            "destructive": self.destructive,
            "finalizing": self.finalizing,
            "batchable": self.batchable,
            "standalone": self.standalone,
        }


_REGISTRY: dict[str, OpSpec] = {}


def operation[P: WireModel](
    *,
    id: str,
    title: str,
    group: str,
    params: type[P],
    destructive: bool = False,
    finalizing: bool = False,
    batchable: bool = False,
    standalone: bool = False,
) -> Callable[[Callable[[OpContext, P], OpOutput]], Callable[[OpContext, P], OpOutput]]:
    """Register the decorated ``run(ctx, params)`` function as operation ``id``."""

    def decorate(fn: Callable[[OpContext, P], OpOutput]) -> Callable[[OpContext, P], OpOutput]:
        if id in _REGISTRY:
            raise ValueError(f"operation already registered: {id}")
        if "." not in id:
            raise ValueError(f"operation id must be 'group.action': {id}")
        _REGISTRY[id] = OpSpec(
            id=id,
            title=title,
            group=group,
            params_model=params,
            run=fn,
            destructive=destructive,
            finalizing=finalizing,
            batchable=batchable,
            standalone=standalone,
        )
        return fn

    return decorate


def registry() -> dict[str, OpSpec]:
    """All registered operations (importing ``chef_core.ops`` registers the built-ins)."""
    return dict(_REGISTRY)


def get_op(op_id: str) -> OpSpec | None:
    return _REGISTRY.get(op_id)


class OpContext:
    """Per-job context: progress, cooperative cancellation, warnings and I/O paths."""

    PROGRESS_INTERVAL = 0.1  # seconds between progress notifications

    def __init__(
        self,
        *,
        job_id: str,
        work_dir: Path,
        input_path: Path | None = None,
        source_path: Path | None = None,
        result_path: Path | None = None,
        doc_name: str = "document",
        cancel_event: threading.Event | None = None,
        cancel_check: Callable[[], None] | None = None,
        progress_sink: ProgressSink | None = None,
    ) -> None:
        self.job_id = job_id
        self.work_dir = work_dir
        self.input_path = input_path
        self.source_path = source_path
        self.result_path = result_path
        self.doc_name = doc_name
        self.warnings: list[str] = []
        self.modified = False
        self._cancel_cleanups: list[Callable[[], None]] = []
        # Protection of the session document (EncryptionState or None), set by the session.
        self.protection: EncryptionState | None = None
        self._cancel = cancel_event or threading.Event()
        self._cancel_check = cancel_check
        self._sink = progress_sink
        self._last_progress = 0.0

    # -- cancellation & progress --------------------------------------------------------

    @property
    def cancelled(self) -> bool:
        return self._cancel.is_set()

    def check_cancelled(self) -> None:
        if self._cancel.is_set():
            raise CancelledError()
        if self._cancel_check is not None:
            self._cancel_check()

    def on_cancel(self, cleanup: Callable[[], None]) -> None:
        """Register cleanup for outputs produced before a cancellation is observed."""
        self._cancel_cleanups.append(cleanup)

    def cleanup_cancelled(self) -> None:
        for cleanup in reversed(self._cancel_cleanups):
            with suppress(OSError):
                cleanup()

    def progress(self, done: int, total: int, message: str | None = None) -> None:
        """Report progress (throttled) and check for cancellation."""
        self.check_cancelled()
        now = time.monotonic()
        if self._sink is not None and (
            done >= total or done == 0 or now - self._last_progress >= self.PROGRESS_INTERVAL
        ):
            self._last_progress = now
            self._sink(done, total, message)

    def steps[T](self, items: Iterable[T], total: int, message: str | None = None) -> Iterator[T]:
        """Iterate ``items`` reporting progress before each item and at the end."""
        for done, item in enumerate(items):
            self.progress(done, total, message)
            yield item
        self.progress(total, total, message)

    def warn(self, message: str) -> None:
        if message not in self.warnings:
            self.warnings.append(message)

    # -- document I/O -------------------------------------------------------------------

    def open_input(self) -> pikepdf.Pdf:
        """Open the current revision of the session document (caller closes it)."""
        if self.input_path is None:
            raise RuntimeError("operation needs a session but none was given")
        return open_pdf(self.input_path)

    def save_document(self, pdf: pikepdf.Pdf) -> None:
        """Write ``pdf`` as the new revision of the session document."""
        if self.result_path is None:
            raise RuntimeError("operation needs a session but none was given")
        self.check_cancelled()
        atomic_save(pdf, self.result_path)
        self.modified = True
