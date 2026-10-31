"""Bates numbering across several files (T4.07, F9): overlay.bates.

Each page of each file gets the next number of one running sequence, in the order of the input
list: file 1 holds numbers 1..n1, file 2 holds n1+1..n1+n2, and so on. A file that fails does
not use any numbers, so the sequence has no gaps from failures. The result lists, per file, the
first and last number and their labels (prefix, zero-padded number, suffix).

Standalone: the op opens every input itself (passwords are per file and never echoed). A signed
input is refused with BLOCKED_BY_SIGNATURE, because re-saving it would break its signatures.
Outputs follow the same naming rules as batch signing (``pdf/outnames.py``).
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any, Literal

from pydantic import Field, model_validator

from chef_core.errors import ChefError, ErrorKind, to_chef_error
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.ops.overlay import HexColor, hex_color
from chef_core.ops.overlay_header import NUMBER_ALIGN, Margins, NumberPosition, number_placement
from chef_core.overlay.engine import OverlayWriter, TextStyle
from chef_core.overlay.pagecontent import page_frame
from chef_core.pdf.io import atomic_copy, atomic_save, open_pdf
from chef_core.pdf.outnames import OutputRule, resolve_output_path
from chef_core.session.info import has_signatures
from chef_core.signing.batch import ENCRYPTED_NOTE

MAX_FILES = 1000
FILE_PASSWORD_DOC = "Password of this PDF, when it is encrypted. Never stored or echoed back."


class BatesFile(WireModel):
    path: str = Field(min_length=1, description="Path of the PDF to number.")
    password: str | None = Field(default=None, repr=False, description=FILE_PASSWORD_DOC)


class BatesOutput(WireModel):
    mode: Literal["suffix", "folder", "overwrite"] = Field(
        default="suffix",
        description="suffix: next to each input, name + suffix. folder: all into one folder. "
        "overwrite: replace each input (atomic).",
    )
    suffix: str = Field(default="_bates", max_length=40, description="Used in suffix mode.")
    folder: str | None = Field(default=None, min_length=1, description="For folder mode.")

    @model_validator(mode="after")
    def _consistent(self) -> BatesOutput:
        if self.mode == "folder" and not self.folder:
            raise ValueError("folder mode needs a folder")
        if any(ch in self.suffix for ch in "/\\"):
            raise ValueError("suffix must not contain a path separator")
        return self


class BatesParams(WireModel):
    """Bates numbers on every page of many PDFs, one running sequence in list order."""

    files: list[BatesFile] = Field(min_length=1, max_length=MAX_FILES)
    prefix: str = Field(default="", max_length=40, description="Text before the number.")
    suffix: str = Field(default="", max_length=40, description="Text after the number.")
    start_number: int = Field(default=1, ge=0, le=10**12)
    digits: int = Field(default=6, ge=1, le=20, description="Zero padding of the number.")
    position: NumberPosition = Field(default="bottom-right")
    margins: Margins = Field(default_factory=Margins)
    font_name: Literal["BeVietnamPro"] = Field(default="BeVietnamPro")
    font_size: float = Field(default=9.0, gt=0, le=200)
    bold: bool = Field(default=False)
    color: HexColor = Field(default="#000000")
    opacity: float = Field(default=1.0, ge=0, le=1)
    output: BatesOutput = Field(default_factory=BatesOutput)
    stop_on_error: bool = Field(
        default=False, description="Stop after the first failed file; the rest are skipped."
    )


def _label(p: BatesParams, number: int) -> str:
    return f"{p.prefix}{number:0{p.digits}d}{p.suffix}"


def _failed(path: str, exc: ChefError) -> dict[str, Any]:
    return {
        "path": path,
        "status": "failed",
        "outputPath": None,
        "pages": None,
        "firstNumber": None,
        "lastNumber": None,
        "firstLabel": None,
        "lastLabel": None,
        "errorKind": exc.kind.value,
        "message": exc.message,
        "warnings": [],
    }


def _skipped(path: str) -> dict[str, Any]:
    item = _failed(path, ChefError(ErrorKind.INTERNAL, ""))
    item.update(status="skipped", errorKind=None, message="Skipped after an earlier error")
    return item


@operation(
    id="overlay.bates",
    title="Bates numbering",
    group="overlay",
    params=BatesParams,
    standalone=True,
)
def bates(ctx: OpContext, p: BatesParams) -> OpOutput:
    rule = OutputRule(
        mode=p.output.mode,
        suffix=p.output.suffix,
        folder=Path(p.output.folder).expanduser().absolute() if p.output.folder else None,
    )
    ctx.work_dir.mkdir(parents=True, exist_ok=True)
    reserved: set[str] = set()
    next_number = p.start_number
    items: list[dict[str, Any]] = []
    outputs: list[str] = []
    stopped = False
    total = len(p.files)
    for index, entry in enumerate(p.files):
        ctx.progress(index, total, "Bates numbering")
        if stopped:
            items.append(_skipped(entry.path))
            continue
        try:
            item, next_number = _number_file(ctx, p, index, entry, rule, reserved, next_number)
        except ChefError as exc:
            items.append(_failed(entry.path, exc))
            stopped = p.stop_on_error
            continue
        items.append(item)
        outputs.append(str(item["outputPath"]))
    ctx.progress(total, total, "Bates numbering")
    return OpOutput(
        changed_pages=[],
        outputs=outputs,
        data={"files": items, "nextNumber": next_number},
    )


def _number_file(
    ctx: OpContext,
    p: BatesParams,
    index: int,
    entry: BatesFile,
    rule: OutputRule,
    reserved: set[str],
    first: int,
) -> tuple[dict[str, Any], int]:
    """Number one file. Returns its result item and the next free number."""
    source = Path(entry.path).expanduser().absolute()
    warnings: list[str] = []
    work_file = ctx.work_dir / f"bates-{index}-{uuid.uuid4().hex[:8]}.pdf"
    with open_pdf(source, entry.password) as pdf:
        if has_signatures(pdf):
            raise ChefError(
                ErrorKind.BLOCKED_BY_SIGNATURE,
                "A document with signatures cannot be numbered: re-saving it breaks them",
                {"path": str(source)},
            )
        count = len(pdf.pages)
        if count == 0:
            raise ChefError(
                ErrorKind.INVALID_PDF, "The document has no pages", {"path": str(source)}
            )
        writer = OverlayWriter(
            pdf, kind="number", group=uuid.uuid4().hex, label="Bates", warn=warnings.append
        )
        style = TextStyle(
            font_family=p.font_name,
            font_size=p.font_size,
            bold=p.bold,
            color=hex_color(p.color),
            align=NUMBER_ALIGN.get(p.position, "center"),
        )
        for i in range(count):
            piece = writer.text(_label(p, first + i), style)
            frame = page_frame(pdf.pages[i])
            writer.place(i, piece, number_placement(p.position, frame, p.margins, i, p.opacity))
        writer.commit()
        if pdf.is_encrypted:
            warnings.append(ENCRYPTED_NOTE)
        atomic_save(pdf, work_file)
    target = resolve_output_path(source, rule, reserved)
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        atomic_copy(work_file, target)
    except OSError as exc:
        raise to_chef_error(exc) from exc
    finally:
        work_file.unlink(missing_ok=True)
    last = first + count - 1
    item: dict[str, Any] = {
        "path": entry.path,
        "status": "done",
        "outputPath": str(target),
        "pages": count,
        "firstNumber": first,
        "lastNumber": last,
        "firstLabel": _label(p, first),
        "lastLabel": _label(p, last),
        "errorKind": None,
        "message": None,
        "warnings": warnings,
    }
    return item, last + 1
