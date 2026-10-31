"""Batch signing (T3.13, I31, I32): sign.batch signs many PDFs with one signer.

The signer is opened once: a PFX is read once; a token is logged in once with the PIN, and the
session is closed in ``finally``. A wrong or locked PIN stops the batch at once (no retry), and
the files that were not reached are reported as ``skipped``.

Each file is read, placed, signed (incremental, so a signed file gets an approval signature and a
certified one obeys its DocMDP), and written to its own output name. Inputs are never changed
unless ``output.mode`` is ``overwrite``, and then the replace is atomic.

Standalone: needs no session and does not touch the journal. Passwords and PINs are only handed to
the signing code; they never appear in results, logs or work files.
"""

from __future__ import annotations

import logging
import shutil
from collections.abc import Callable
from pathlib import Path
from typing import Annotated, Literal, Self

from pydantic import Field, model_validator

from chef_core.errors import CancelledError, ChefError, ErrorKind, invalid_params, to_chef_error
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.ops.sign_common import SignOptions, build_request, check_signer, visible_spot
from chef_core.ops.sign_token import locate_signer, token_selector_error
from chef_core.signing import anchors
from chef_core.signing.anchors import Align, Corner, PageFrame, Position
from chef_core.signing.batch import (
    ENCRYPTED_NOTE,
    FileOutcome,
    OutputRule,
    common_folder,
    copy_to_target,
    failure_of,
    prepare_source,
    resolve_output_path,
    skipped,
    verify_output,
)
from chef_core.signing.drivers import current_environment, validate_module_path
from chef_core.signing.pades import VisibleSpot, sign_pades
from chef_core.signing.pfx import PfxCertificate, load_pfx
from chef_core.signing.pkcs11 import (
    current_backend,
    open_token_session,
)
from chef_core.signing.token_sign import token_identity

log = logging.getLogger(__name__)

PageIndex = Annotated[int, Field(ge=0)]
Rect4 = Annotated[list[float], Field(min_length=4, max_length=4)]
PIN_STOP = frozenset(
    {
        ErrorKind.TOKEN_PIN_INVALID.value,
        ErrorKind.TOKEN_PIN_LOCKED.value,
        ErrorKind.TOKEN_PIN_CONFIRM_REQUIRED.value,
    }
)
STOP_ON_ERROR = "stopOnError"
FILE_PASSWORD_DOC = "Password of this PDF, when it is encrypted. Never stored or echoed back."


# -- parameters -----------------------------------------------------------------------------


class BatchFile(WireModel):
    path: str = Field(min_length=1, description="Path of the PDF to sign.")
    password: str | None = Field(default=None, repr=False, description=FILE_PASSWORD_DOC)


class PfxSigner(WireModel):
    kind: Literal["pfx"]
    pfx_path: str = Field(min_length=1, description="Path to the .pfx or .p12 file.")
    password: str | None = Field(
        default=None, repr=False, description="Password of the certificate file."
    )


class TokenSigner(WireModel):
    kind: Literal["token"]
    module_path: str = Field(min_length=1, description="Path of the PKCS#11 driver file.")
    slot_id: int | None = Field(default=None, ge=0, description="Slot of the token.")
    token_serial: str | None = Field(
        default=None, min_length=1, description="Serial of the token, instead of slotId."
    )
    cert_id: str = Field(
        pattern=r"^(?:[0-9a-fA-F]{2})+$",
        description="CKA_ID of the signing certificate, in hex (from sign.listTokens).",
    )
    pin: str = Field(repr=False, description="Token PIN: one login for the whole batch.")
    confirm_final_try: bool = Field(
        default=False,
        description="Must be true to use the PIN when the token reports only one try left.",
    )

    @model_validator(mode="after")
    def _one_token_selector(self) -> Self:
        message = token_selector_error(self.slot_id, self.token_serial)
        if message is not None:
            raise ValueError(message)
        return self


SignerSpec = Annotated[PfxSigner | TokenSigner, Field(discriminator="kind")]


class RectPlacement(WireModel):
    kind: Literal["rect"]
    page: PageIndex = Field(description="0-based page.")
    rect: Rect4 = Field(description="[x1, y1, x2, y2] in PDF points, the same on every file.")

    @model_validator(mode="after")
    def _rect_is_ordered(self) -> Self:
        x1, y1, x2, y2 = self.rect
        if x2 <= x1 or y2 <= y1:
            raise ValueError("rect must be [x1, y1, x2, y2] with x2 > x1 and y2 > y1")
        return self


class FixedPlacement(WireModel):
    kind: Literal["fixed"]
    corner: Corner = "bottom-right"
    width: float = Field(gt=0, le=2000, description="Points.")
    height: float = Field(gt=0, le=2000, description="Points.")
    margin: float = Field(default=36.0, ge=0, le=500, description="Points from both edges.")
    page: Literal["first", "last"] | PageIndex = "last"


class AnchorPlacement(WireModel):
    kind: Literal["anchor"]
    text: str = Field(min_length=1, max_length=200, description="Text to find on each file.")
    position: Position = "below"
    width: float = Field(gt=0, le=2000, description="Displayed width in points.")
    height: float = Field(gt=0, le=2000, description="Displayed height in points.")
    offset_x: float = Field(default=0.0, ge=-2000, le=2000)
    offset_y: float = Field(default=0.0, ge=-2000, le=2000)
    align: Align = "center"
    ignore_diacritics: bool = True
    which_match: Literal["first", "last", "all"] = Field(
        default="first",
        description="all: one signature per match, each in its own box, in one output file.",
    )
    on_missing: Literal["skip", "fail", "fallback-fixed"] = Field(
        default="skip",
        description="skip: the file is skipped. fail: the file fails. fallback-fixed: a fixed "
        "box at fallbackCorner / fallbackPage.",
    )
    fallback_corner: Corner = "bottom-right"
    fallback_page: Literal["first", "last"] | PageIndex = "last"
    fallback_margin: float = Field(default=36.0, ge=0, le=500)


class InvisiblePlacement(WireModel):
    kind: Literal["invisible"]


PlacementSpec = Annotated[
    RectPlacement | FixedPlacement | AnchorPlacement | InvisiblePlacement,
    Field(discriminator="kind"),
]


class BatchOutput(WireModel):
    mode: Literal["suffix", "folder", "overwrite"] = Field(
        default="suffix",
        description="suffix: next to each input, name + suffix. folder: all into one folder. "
        "overwrite: replace each input (atomic).",
    )
    suffix: str = Field(default="_signed", max_length=40, description="Used in suffix mode.")
    folder: str | None = Field(default=None, min_length=1, description="For folder mode.")

    @model_validator(mode="after")
    def _consistent(self) -> Self:
        if self.mode == "folder" and not self.folder:
            raise ValueError("folder mode needs a folder")
        if any(ch in self.suffix for ch in "/\\"):
            raise ValueError("suffix must not contain a path separator")
        return self


class SignBatchParams(WireModel):
    """Sign many PDFs with one certificate (PFX or token). One set of options for all files."""

    files: list[BatchFile] = Field(min_length=1, max_length=1000)
    signer: SignerSpec
    common: SignOptions = Field(default_factory=SignOptions)
    placement: PlacementSpec = Field(
        default_factory=lambda: InvisiblePlacement(kind="invisible"),
        description="Where the visible box goes on each file. Default: no box.",
    )
    output: BatchOutput = Field(default_factory=BatchOutput)
    stop_on_error: bool = Field(
        default=False, description="Stop after the first failed file; the rest are skipped."
    )
    verify_after: bool = Field(
        default=False, description="Check each output with the verifier (verification field)."
    )


# -- placement ------------------------------------------------------------------------------


def _page_index(value: Literal["first", "last"] | int, count: int, field: str) -> int:
    index = {"first": 0, "last": count - 1}.get(value) if isinstance(value, str) else value
    if index is None or not 0 <= index < count:
        raise invalid_params("Page is out of range", {"field": field})
    return index


def _fixed_spot(
    frames: dict[int, PageFrame],
    corner: Corner,
    width: float,
    height: float,
    margin: float,
    page: Literal["first", "last"] | int,
    field: str,
) -> VisibleSpot:
    index = _page_index(page, len(frames), field)
    frame = frames[index]
    try:
        displayed = anchors.fixed_rect(frame.display_size, corner, width, height, margin)
    except ValueError as exc:
        raise invalid_params(str(exc), {"field": field}) from exc
    x1, y1, x2, y2 = frame.rect_from_display(displayed)
    return VisibleSpot(page=index, rect=(x1, y1, x2, y2))


class _Skip(Exception):
    """The placement says this file is skipped (anchor text not found)."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


def plan_spots(placement: PlacementSpec, source: Path) -> list[VisibleSpot | None]:
    """The visible boxes for ``source``; ``[None]`` for an invisible signature.

    Raises ``_Skip`` for a missing anchor under ``skip``, and ``ChefError`` for a placement that
    cannot be made on this file (page out of range, anchor missing under ``fail``).
    """
    if isinstance(placement, InvisiblePlacement):
        return [None]
    if isinstance(placement, RectPlacement):
        spot = visible_spot(source, placement.page, placement.rect)
        return [spot]
    frames = anchors.page_frames(source)
    if isinstance(placement, FixedPlacement):
        return [
            _fixed_spot(
                frames,
                placement.corner,
                placement.width,
                placement.height,
                placement.margin,
                placement.page,
                "page",
            )
        ]
    search = anchors.search_anchors(
        source, placement.text, ignore_diacritics=placement.ignore_diacritics
    )
    found = search.matches
    if placement.which_match == "first":
        found = found[:1]
    elif placement.which_match == "last":
        found = found[-1:]
    if not found:
        if placement.on_missing == "skip":
            raise _Skip("The anchor text was not found")
        if placement.on_missing == "fail":
            raise invalid_params("The anchor text was not found", {"reason": "anchor_not_found"})
        return [
            _fixed_spot(
                frames,
                placement.fallback_corner,
                placement.width,
                placement.height,
                placement.fallback_margin,
                placement.fallback_page,
                "fallbackPage",
            )
        ]
    placed, _skipped = anchors.place(
        found,
        frames,
        width=placement.width,
        height=placement.height,
        position=placement.position,
        offset_x=placement.offset_x,
        offset_y=placement.offset_y,
        align=placement.align,
        clamp=True,
    )
    return [VisibleSpot(page=item.page_index, rect=item.rect) for item in placed]


# -- signer ---------------------------------------------------------------------------------


def _open_token(
    ctx: OpContext, spec: TokenSigner
) -> tuple[PfxCertificate | None, Callable[[], None] | None, ChefError | None]:
    """(signer, close, login_error). A PIN error is returned, not raised: it stops the batch."""
    env = current_environment()
    module = validate_module_path(spec.module_path, env.os_name, env.fs)
    backend = current_backend()
    chosen = locate_signer(
        backend, module, slot_id=spec.slot_id, serial=spec.token_serial, cert_id=spec.cert_id
    )
    check_signer(ctx, chosen.cert.certificate)
    try:
        session = open_token_session(
            backend,
            module,
            chosen.token.slot_id,
            spec.pin,
            confirm_final_try=spec.confirm_final_try,
        )
    except ChefError as exc:
        if exc.kind.value in PIN_STOP:
            return None, None, exc
        raise
    return token_identity(session, chosen.cert, chosen.chain), session.close, None


# -- one file -------------------------------------------------------------------------------


def _sign_one(
    ctx: OpContext,
    p: SignBatchParams,
    index: int,
    source: Path,
    rule: OutputRule,
    signer: PfxCertificate,
    reserved: set[str],
) -> FileOutcome:
    path = str(source)
    work = ctx.work_dir / f"file-{index:04d}"
    work.mkdir(parents=True, exist_ok=True)
    try:
        if not source.is_file():
            raise ChefError(ErrorKind.FILE_NOT_FOUND, "File not found", {"path": path})
        to_sign, encrypted = prepare_source(source, p.files[index].password, work)
        spots = plan_spots(p.placement, to_sign)
        target = resolve_output_path(source, rule, reserved)
        current = to_sign
        names: list[str] = []
        first_page: int | None = None
        for step, spot in enumerate(spots):
            ctx.check_cancelled()
            dest = work / f"pass-{step}.pdf"
            result = sign_pades(
                build_request(
                    p.common,
                    source=current,
                    destination=dest,
                    signer=signer,
                    spot=spot,
                    field_name=None,
                )
            )
            names.append(result.field_name)
            if first_page is None:
                first_page = result.page
            current = dest
        copy_to_target(current, target)
        outcome = FileOutcome(
            path=path,
            status="signed",
            output_path=str(target),
            field_name=names[0],
            page=first_page,
        )
        if encrypted:
            outcome.warnings.append(ENCRYPTED_NOTE)
        if p.verify_after:
            outcome.verification = verify_output(target, names, p.common.trust_root_paths)
        return outcome
    except _Skip as skip:
        return skipped(path, skip.message)
    except CancelledError:
        raise
    except ChefError as exc:
        return failure_of(path, exc)
    except Exception as exc:
        log.warning("batch file %d failed: %s", index, type(exc).__name__)
        return failure_of(path, to_chef_error(exc))
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _login_failure(paths: list[str], error: ChefError) -> list[FileOutcome]:
    """The PIN was refused once: the first file reports it, the rest are skipped."""
    first = failure_of(paths[0], error)
    rest = [skipped(path, "Not signed: the PIN was refused") for path in paths[1:]]
    return [first, *rest]


# -- the operation --------------------------------------------------------------------------


@operation(
    id="sign.batch",
    title="Sign many files",
    group="sign",
    params=SignBatchParams,
    standalone=True,
)
def sign_batch_op(ctx: OpContext, p: SignBatchParams) -> OpOutput:
    ctx.check_cancelled()
    folder: Path | None = None
    if p.output.folder:
        folder = Path(p.output.folder).expanduser().absolute()
        try:
            folder.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise ChefError(
                ErrorKind.FILE_NOT_FOUND, "Output folder cannot be created", {"path": str(folder)}
            ) from exc
    rule = OutputRule(mode=p.output.mode, suffix=p.output.suffix, folder=folder)
    sources = [Path(f.path).expanduser().absolute() for f in p.files]
    paths = [str(s) for s in sources]

    close: Callable[[], None] | None = None
    if isinstance(p.signer, PfxSigner):
        loaded = load_pfx(p.signer.pfx_path, p.signer.password)
        check_signer(ctx, loaded.certificate)
        signer: PfxCertificate | None = loaded
        login_error: ChefError | None = None
    else:
        signer, close, login_error = _open_token(ctx, p.signer)

    try:
        if signer is None and login_error is not None:
            outcomes = _login_failure(paths, login_error)
            stopped_by: str | None = login_error.kind.value
        else:
            assert signer is not None
            outcomes, stopped_by = _run(ctx, p, sources, rule, signer)
    finally:
        if close is not None:
            close()

    signed = [o for o in outcomes if o.status == "signed"]
    failed = [o for o in outcomes if o.status == "failed"]
    skip_count = [o for o in outcomes if o.status == "skipped"]
    if rule.mode == "folder" and folder is not None:
        open_folder: Path | None = folder
    else:
        open_folder = common_folder([Path(o.output_path) for o in signed if o.output_path])
    outputs = [o.output_path for o in signed if o.output_path]
    return OpOutput(
        changed_pages=[],
        outputs=[str(o) for o in outputs],
        data={
            "results": [o.to_wire() for o in outcomes],
            "signed": len(signed),
            "failed": len(failed),
            "skipped": len(skip_count),
            "openFolder": str(open_folder) if open_folder is not None else None,
            "stoppedBy": stopped_by,
        },
    )


def _run(
    ctx: OpContext,
    p: SignBatchParams,
    sources: list[Path],
    rule: OutputRule,
    signer: PfxCertificate,
) -> tuple[list[FileOutcome], str | None]:
    total = len(sources)
    reserved: set[str] = set()
    outcomes: list[FileOutcome] = []
    stopped_by: str | None = None
    for index, source in enumerate(sources):
        ctx.progress(index, total)  # also the cancellation point between files
        if stopped_by is not None:
            outcomes.append(skipped(str(source), "Not signed: the batch stopped"))
            continue
        outcome = _sign_one(ctx, p, index, source, rule, signer, reserved)
        outcomes.append(outcome)
        if outcome.error_kind in PIN_STOP:
            stopped_by = outcome.error_kind
        elif outcome.status == "failed" and p.stop_on_error:
            stopped_by = STOP_ON_ERROR
    ctx.progress(total, total)
    return outcomes, stopped_by
