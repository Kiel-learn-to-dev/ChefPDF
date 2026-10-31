"""Ký kèm đóng dấu (I33): stamps and a signature in one click, as one revision.

``sign.stampAndSign`` runs a list of stamp operations (destructive) and then ``sign.pades``
(finalizing) on the stamped copy. ``sign.stampAndSignToken`` does the same with ``sign.padesToken``.

Atomicity: every step writes its own temporary file. Only the last step (the signature) writes the
session's new revision, and the session commits it only when the whole operation returns. If any
step fails, the temporary files are removed and the session stays at its starting revision.

Order safety: the steps go through ``check_op_order`` (ops/ordering.py), so a destructive step can
never follow the signature. The PIN and the certificate password are ordinary parameters with
``repr=False``, and the session drops them from the journal (SECRET_PARAM_KEYS).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal, NamedTuple

from pydantic import Field, ValidationError

from chef_core.errors import invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, OpSpec, get_op, operation
from chef_core.ops.ordering import ensure_op_order
from chef_core.ops.sign import SignPadesParams
from chef_core.ops.sign_token import SignPadesTokenParams

StampOpId = Literal[
    "stamp.text",
    "stamp.image",
    "stamp.seam",
    "stamp.initials",
    "overlay.watermark",
    "overlay.addText",
    "overlay.addImage",
]
MAX_STEPS = 20


class StampStep(WireModel):
    """One stamp operation with its own parameters, exactly as that operation takes them."""

    op: StampOpId = Field(description="Stamp operation id.")
    params: dict[str, Any] = Field(default_factory=dict, description="Params of that operation.")


class StampAndSignParams(WireModel):
    """Stamps first, then one PAdES signature with a certificate file (PFX / P12)."""

    stamps: list[StampStep] = Field(min_length=1, max_length=MAX_STEPS)
    sign: SignPadesParams


class StampAndSignTokenParams(WireModel):
    """Stamps first, then one PAdES signature with a key on a USB token."""

    stamps: list[StampStep] = Field(min_length=1, max_length=MAX_STEPS)
    sign: SignPadesTokenParams


class _Plan(NamedTuple):
    """Validated steps: the step, its spec and its typed params, in the order given."""

    steps: list[tuple[StampStep, OpSpec, Any]]


def _required(op_id: str) -> OpSpec:
    spec = get_op(op_id)
    if spec is None:
        raise RuntimeError(f"operation {op_id} is not registered")
    return spec


def _plan(stamps: list[StampStep]) -> _Plan:
    steps: list[tuple[StampStep, OpSpec, Any]] = []
    for step in stamps:
        spec = _required(step.op)
        try:
            params = spec.params_model.model_validate(step.params)
        except ValidationError as exc:
            raise invalid_params(
                f"Invalid params for {step.op}",
                {"field": "stamps", "opId": step.op, "errors": len(exc.errors())},
            ) from exc
        steps.append((step, spec, params))
    return _Plan(steps)


def _child(ctx: OpContext, source: Path, dest: Path) -> OpContext:
    """A context for one step: same job, same cancellation, its own input and output files."""
    return OpContext(
        job_id=ctx.job_id,
        work_dir=ctx.work_dir,
        input_path=source,
        result_path=dest,
        doc_name=ctx.doc_name,
        cancel_event=ctx._cancel,  # one cancel flag for every step of the job
    )


def _run_pipeline(
    ctx: OpContext, plan: _Plan, sign_spec: OpSpec, sign_params: WireModel
) -> OpOutput:
    if ctx.input_path is None or ctx.result_path is None:
        raise RuntimeError(f"{sign_spec.id} needs a session")
    ctx.check_cancelled()
    ctx.work_dir.mkdir(parents=True, exist_ok=True)
    total = len(plan.steps) + 1
    temporary: list[Path] = []
    stamp_rows: list[dict[str, Any]] = []
    changed: set[int] = set()
    current = ctx.input_path
    try:
        for index, (step, spec, params) in enumerate(plan.steps):
            ctx.progress(index, total, f"Đóng dấu {index + 1}/{len(plan.steps)}")
            dest = ctx.work_dir / f"{ctx.job_id}-stamp-{index}.pdf"
            temporary.append(dest)
            sub = _child(ctx, current, dest)
            out = spec.run(sub, params)
            _forward_warnings(ctx, sub)
            if sub.modified:
                current = dest
            if isinstance(out.changed_pages, list):
                changed.update(out.changed_pages)
            stamp_rows.append({"op": step.op, "changedPages": out.changed_pages})
        ctx.progress(len(plan.steps), total, "Ký số")
        sign_sub = _child(ctx, current, ctx.result_path)
        sign_out = sign_spec.run(sign_sub, sign_params)
        _forward_warnings(ctx, sign_sub)
        if isinstance(sign_out.changed_pages, list):
            changed.update(sign_out.changed_pages)
    finally:
        for path in temporary:
            path.unlink(missing_ok=True)
    ctx.modified = True
    return OpOutput(
        changed_pages=sorted(changed),
        data={"stamps": stamp_rows, "sign": sign_out.data},
    )


def _forward_warnings(ctx: OpContext, sub: OpContext) -> None:
    for message in sub.warnings:
        ctx.warn(message)


def _check_order(plan: _Plan, sign_spec: OpSpec) -> None:
    ensure_op_order([spec for _, spec, _ in plan.steps] + [sign_spec])


@operation(
    id="sign.stampAndSign",
    title="Stamp and sign (PAdES)",
    group="sign",
    params=StampAndSignParams,
    destructive=True,
    finalizing=True,
)
def stamp_and_sign(ctx: OpContext, p: StampAndSignParams) -> OpOutput:
    plan = _plan(p.stamps)
    sign_spec = _required("sign.pades")
    _check_order(plan, sign_spec)
    return _run_pipeline(ctx, plan, sign_spec, p.sign)


@operation(
    id="sign.stampAndSignToken",
    title="Stamp and sign with a USB token (PAdES)",
    group="sign",
    params=StampAndSignTokenParams,
    destructive=True,
    finalizing=True,
)
def stamp_and_sign_token(ctx: OpContext, p: StampAndSignTokenParams) -> OpOutput:
    plan = _plan(p.stamps)
    sign_spec = _required("sign.padesToken")
    _check_order(plan, sign_spec)
    return _run_pipeline(ctx, plan, sign_spec, p.sign)
