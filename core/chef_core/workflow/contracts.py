"""Typed wire results returned by workflow.validate, workflow.run and workflow.samples."""

from __future__ import annotations

from typing import Literal

from chef_core.models import WireModel
from chef_core.workflow.model import Workflow


class WorkflowIssue(WireModel):
    kind: str
    message: str
    step: int | None
    field: str | None


class WorkflowStepSummary(WireModel):
    index: int
    op: str
    title: str
    label: str
    enabled: bool
    description: str
    destructive: bool
    finalizing: bool
    standalone: bool
    needs_secrets: list[str]
    batch_incompatible: bool


class WorkflowValidationResult(WireModel):
    valid: bool
    errors: list[WorkflowIssue]
    warnings: list[WorkflowIssue]
    steps: list[WorkflowStepSummary]
    required_secrets: list[str]
    required_variables: list[str]
    workflow_id: str
    descriptions: list[str]


class WorkflowStepResult(WireModel):
    index: int
    op: str
    label: str
    changed_pages: list[int] | Literal["all"]
    warnings: list[str]


class WorkflowFileResult(WireModel):
    path: str
    output_path: str | None
    outputs: list[str]
    planned_outputs: list[str]
    planned_output_path: str | None = None
    status: Literal["done", "failed", "skipped"]
    failed_step: int | None
    error_kind: str | None
    message: str | None
    warnings: list[str]
    step_results: list[WorkflowStepResult]
    duration_ms: int


class WorkflowRunSummary(WireModel):
    total: int
    done: int
    failed: int
    skipped: int


class WorkflowRunResult(WireModel):
    results: list[WorkflowFileResult]
    summary: WorkflowRunSummary
    dry_run: bool


class WorkflowSample(WireModel):
    id: str
    name: str
    description: str
    workflow: Workflow


class WorkflowSamplesResult(WireModel):
    samples: list[WorkflowSample]


__all__ = [
    "WorkflowFileResult",
    "WorkflowIssue",
    "WorkflowRunResult",
    "WorkflowRunSummary",
    "WorkflowSample",
    "WorkflowSamplesResult",
    "WorkflowStepResult",
    "WorkflowStepSummary",
    "WorkflowValidationResult",
]
