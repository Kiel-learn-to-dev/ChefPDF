"""Workflow operations (T9.02, T9.04, T9.07): ``workflow.validate``, ``workflow.run``,
``workflow.samples`` and ``batch.run`` (one operation over many files).

All four are standalone: they open their own working sessions and never touch a UI session.
Results are returned in ``data`` (the job result). Secrets are request params with ``repr=False``
and never appear in results.
"""

from __future__ import annotations

from typing import Any

from pydantic import Field

from chef_core.errors import ChefError, ErrorKind, invalid_params
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, get_op, operation
from chef_core.session.manager import SessionManager
from chef_core.workflow.model import (
    NOT_BATCH_OPS,
    Workflow,
    WorkflowOutput,
    WorkflowStep,
    describe_steps,
    parse_workflow,
    validate_workflow,
)
from chef_core.workflow.runner import FileRequest, run_workflow
from chef_core.workflow.samples import load_samples

FILE_PASSWORD_DOC = "Password of this PDF, when it is encrypted. Never stored or echoed back."
SECRET_DOC = "Values of {{secret:name}} placeholders. Never stored, logged or echoed back."


class WorkflowFile(WireModel):
    path: str = Field(min_length=1, max_length=1024, description="PDF file to process.")
    password: str | None = Field(default=None, repr=False, description=FILE_PASSWORD_DOC)


class WorkflowValidateParams(WireModel):
    workflow: dict[str, Any] = Field(description="A workflow (see Workflow JSON schema).")
    variables: dict[str, str] = Field(
        default_factory=dict, description="Values of the run request, checked with the workflow."
    )


class WorkflowRunParams(WireModel):
    workflow: dict[str, Any] = Field(description="A workflow (see Workflow JSON schema).")
    files: list[WorkflowFile] = Field(min_length=1, max_length=5000)
    secrets: dict[str, str] = Field(default_factory=dict, repr=False, description=SECRET_DOC)
    variables: dict[str, str] = Field(
        default_factory=dict, description="Values for {{name}} placeholders of this run."
    )
    output: WorkflowOutput | None = Field(
        default=None, description="Replaces the output rule of the workflow for this run."
    )
    stop_on_error: bool = Field(default=False, description="Stop after the first failed file.")
    dry_run: bool = Field(
        default=False, description="Only plan the output names: nothing is processed or written."
    )


class BatchRunParams(WireModel):
    op_id: str = Field(min_length=3, max_length=80, description="Batchable operation id.")
    params: dict[str, Any] = Field(default_factory=dict, description="Params of that operation.")
    files: list[WorkflowFile] = Field(min_length=1, max_length=5000)
    secrets: dict[str, str] = Field(default_factory=dict, repr=False, description=SECRET_DOC)
    output: WorkflowOutput | None = Field(default=None)
    parallel: int = Field(default=1, ge=1, le=4, description="Files at the same time.")
    stop_on_error: bool = Field(default=False)


class SamplesParams(WireModel):
    """No parameters."""


def _parse(data: dict[str, Any]) -> Workflow:
    flow, issues = parse_workflow(data)
    if flow is None:
        raise ChefError(
            ErrorKind.INVALID_PARAMS,
            "Quy trình không đúng cấu trúc.",
            {"errors": [issue.to_dict() for issue in issues]},
        )
    return flow


def _private_sessions(ctx: OpContext) -> SessionManager:
    """Sessions of this job only: they live in the job's work folder and are removed with it."""
    return SessionManager(ctx.work_dir / "wf-sessions")


@operation(
    id="workflow.validate",
    title="Kiểm tra quy trình",
    group="workflow",
    params=WorkflowValidateParams,
    standalone=True,
)
def workflow_validate(ctx: OpContext, p: WorkflowValidateParams) -> OpOutput:
    flow = _parse(p.workflow)
    report = validate_workflow(flow, variables=p.variables)
    data = report.to_dict()
    data["workflowId"] = flow.id
    data["descriptions"] = describe_steps(flow)
    return OpOutput(data=data)


@operation(
    id="workflow.run",
    title="Chạy quy trình",
    group="workflow",
    params=WorkflowRunParams,
    standalone=True,
)
def workflow_run(ctx: OpContext, p: WorkflowRunParams) -> OpOutput:
    flow = _parse(p.workflow)
    report = run_workflow(
        flow,
        [FileRequest(f.path, f.password) for f in p.files],
        sessions=_private_sessions(ctx),
        work_dir=ctx.work_dir,
        secrets=p.secrets,
        variables=p.variables,
        output=p.output,
        stop_on_error=p.stop_on_error,
        dry_run=p.dry_run,
        progress=ctx.progress,
        check_cancel=ctx.check_cancelled,
    )
    outputs = [path for row in report["results"] for path in row["outputs"]]
    return OpOutput(outputs=outputs, data=report)


@operation(
    id="batch.run",
    title="Chạy hàng loạt",
    group="batch",
    params=BatchRunParams,
    standalone=True,
)
def batch_run(ctx: OpContext, p: BatchRunParams) -> OpOutput:
    spec = get_op(p.op_id)
    if spec is None:
        raise ChefError(ErrorKind.OP_NOT_FOUND, f"Unknown operation: {p.op_id}", {"opId": p.op_id})
    if not spec.batchable or p.op_id in NOT_BATCH_OPS:
        raise invalid_params(f"Thao tác {p.op_id} không hỗ trợ chạy hàng loạt.", {"field": "opId"})
    flow = Workflow(
        id="batch",
        name=spec.title,
        steps=[WorkflowStep(op=p.op_id, params=p.params)],
    )
    report = run_workflow(
        flow,
        [FileRequest(f.path, f.password) for f in p.files],
        sessions=_private_sessions(ctx),
        work_dir=ctx.work_dir,
        secrets=p.secrets,
        output=p.output,
        stop_on_error=p.stop_on_error,
        parallel=p.parallel,
        progress=ctx.progress,
        check_cancel=ctx.check_cancelled,
    )
    outputs = [path for row in report["results"] for path in row["outputs"]]
    return OpOutput(outputs=outputs, data=report)


@operation(
    id="workflow.samples",
    title="Quy trình mẫu",
    group="workflow",
    params=SamplesParams,
    standalone=True,
)
def workflow_samples(ctx: OpContext, p: SamplesParams) -> OpOutput:
    samples = [
        {
            "id": flow.id,
            "name": flow.name,
            "description": flow.description,
            "workflow": flow.model_dump(by_alias=True, mode="json"),
        }
        for flow in load_samples()
    ]
    return OpOutput(data={"samples": samples})
