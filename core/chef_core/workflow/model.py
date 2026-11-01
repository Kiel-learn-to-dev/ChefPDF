"""Workflow model and validation (T9.02, O1, O5).

A workflow is an ordered list of ``{op, params}`` steps plus how its inputs are read and where its
results go. It is stored as JSON (``userData/library/workflows/*.json`` on the Electron side); the
core validates and runs it.

``validate_workflow`` never stops at the first problem: it returns every error with its step index
and field path, so the UI can show them all at once. Errors make a workflow unrunnable; warnings
(for example a step that cannot run in a batch) do not.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import Field, ValidationError

from chef_core.models import WireModel
from chef_core.ops.base import OpSpec, get_op
from chef_core.ops.ordering import check_op_order
from chef_core.workflow.naming import ILLEGAL_RE, check_template
from chef_core.workflow.placeholders import (
    BUILTIN_VARIABLES,
    PLACEHOLDER_RE,
    is_secret,
    iter_strings,
    literal_secret_paths,
    placeholder_names,
    secret_name,
)

WORKFLOW_ID_RE = r"^[a-z0-9][a-z0-9_-]{0,63}$"
MAX_STEPS = 50

# Standalone operations that take explicit file paths. None of them can run on a workflow file
# yet, so the list is empty; the rule and the list stay in place for later additions.
DOCUMENT_TRANSFORM_OPS: frozenset[str] = frozenset()

# Operations that need a person to point at something on the page (an object id, a region drawn
# by hand, a line picked from a list). A workflow can run them on one file but not on a batch.
NOT_BATCH_OPS: frozenset[str] = frozenset(
    {
        "content.delete",
        "content.move",
        "content.transform",
        "content.setColor",
        "content.setOpacity",
        "content.reorder",
        "content.duplicate",
        "content.replaceImage",
        "content.adjustImage",
        "content.eraseRegion",
        "content.removeSimilar",
        "pageimg.erase",
        "pageimg.removeFingers",
        "text.editLine",
        "redact.apply",
    }
)


class WorkflowStep(WireModel):
    op: str = Field(min_length=3, max_length=80, description="Operation id, e.g. page.rotate.")
    params: dict[str, Any] = Field(
        default_factory=dict, description="Params of that operation (placeholders allowed)."
    )
    label: str | None = Field(default=None, max_length=120, description="Name shown in the UI.")
    enabled: bool = Field(default=True, description="A disabled step is kept but not run.")
    on_error: Literal["stop", "skip"] = Field(
        default="stop", description="stop: the file fails here. skip: go on with the next step."
    )


class WorkflowInputs(WireModel):
    accept: list[Literal["pdf", "images"]] = Field(default=["pdf"], min_length=1)
    password: bool = Field(
        default=False, description="Ask for a password of an encrypted input file."
    )


class WorkflowOutput(WireModel):
    mode: Literal["suffix", "folder", "overwrite"] = Field(
        default="suffix", description="suffix: next to the input. folder: into a folder."
    )
    suffix: str = Field(default="_da-xu-ly", max_length=40)
    folder: str | None = Field(default=None, max_length=1024)
    name_template: str | None = Field(
        default=None, max_length=200, description="Name template, e.g. {name}_{date}_da-ky."
    )


class Workflow(WireModel):
    id: str = Field(pattern=WORKFLOW_ID_RE)
    name: str = Field(min_length=1, max_length=120, description="Name (Vietnamese).")
    description: str = Field(default="", max_length=500)
    version: int = Field(default=1, ge=1)
    steps: list[WorkflowStep] = Field(min_length=1, max_length=MAX_STEPS)
    inputs: WorkflowInputs = Field(default_factory=WorkflowInputs)
    output: WorkflowOutput = Field(default_factory=WorkflowOutput)
    variables: dict[str, str] = Field(
        default_factory=dict, description="Defaults for {{name}} placeholders."
    )


# -- JSON --------------------------------------------------------------------------------


def to_json(flow: Workflow) -> str:
    return json.dumps(flow.model_dump(by_alias=True, mode="json"), ensure_ascii=False, indent=2)


def from_json(text: str) -> Workflow:
    """Parse and check the structure of a workflow file; raises ValueError with all issues."""
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise ValueError(f"not JSON: {exc}") from exc
    flow, issues = parse_workflow(data)
    if flow is None:
        raise ValueError("; ".join(f"{i.field}: {i.message}" for i in issues))
    return flow


def _format_loc(loc: tuple[Any, ...]) -> str:
    text = ""
    for part in loc:
        if isinstance(part, int):
            text += f"[{part}]"
        else:
            text += f"{'.' if text else ''}{part}"
    return text


def parse_workflow(data: Any) -> tuple[Workflow | None, list[Issue]]:
    """The workflow, or the structural problems with their field paths (no values echoed)."""
    try:
        return Workflow.model_validate(data), []
    except ValidationError as exc:
        issues = [
            Issue(kind="INVALID_WORKFLOW", field=_format_loc(tuple(e["loc"])), message=e["msg"])
            for e in exc.errors()
        ]
        return None, issues


# -- validation -------------------------------------------------------------------------


@dataclass(frozen=True)
class Issue:
    kind: str
    message: str
    step: int | None = None
    field: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"kind": self.kind, "step": self.step, "field": self.field, "message": self.message}


@dataclass
class StepSummary:
    index: int
    op: str
    title: str
    label: str
    enabled: bool
    description: str
    destructive: bool = False
    finalizing: bool = False
    standalone: bool = False
    needs_secrets: list[str] = field(default_factory=list)
    batch_incompatible: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "op": self.op,
            "title": self.title,
            "label": self.label,
            "enabled": self.enabled,
            "description": self.description,
            "destructive": self.destructive,
            "finalizing": self.finalizing,
            "standalone": self.standalone,
            "needsSecrets": self.needs_secrets,
            "batchIncompatible": self.batch_incompatible,
        }


@dataclass
class ValidationReport:
    errors: list[Issue] = field(default_factory=list)
    warnings: list[Issue] = field(default_factory=list)
    steps: list[StepSummary] = field(default_factory=list)
    required_secrets: list[str] = field(default_factory=list)
    required_variables: list[str] = field(default_factory=list)

    @property
    def valid(self) -> bool:
        return not self.errors

    def to_dict(self) -> dict[str, Any]:
        return {
            "valid": self.valid,
            "errors": [e.to_dict() for e in self.errors],
            "warnings": [w.to_dict() for w in self.warnings],
            "steps": [s.to_dict() for s in self.steps],
            "requiredSecrets": self.required_secrets,
            "requiredVariables": self.required_variables,
        }


def step_title(step: WorkflowStep, spec: OpSpec | None) -> str:
    if spec is not None:
        return spec.title
    return step.op


def describe_steps(flow: Workflow) -> list[str]:
    """One human-readable line per step, from the op titles (Vietnamese titles from the ops)."""
    lines: list[str] = []
    for index, step in enumerate(flow.steps):
        spec = get_op(step.op)
        name = step.label or step_title(step, spec)
        line = f"Bước {index + 1}: {name}"
        if not step.enabled:
            line += " (tắt)"
        lines.append(line)
    return lines


def validate_workflow(
    flow: Workflow, *, variables: dict[str, str] | None = None
) -> ValidationReport:
    """Check a workflow without running it. ``variables`` are the values of the run request."""
    report = ValidationReport()
    given = dict(variables or {})
    declared = {**flow.variables, **given}
    known: set[str] = set(BUILTIN_VARIABLES) | set(declared)
    _check_output(flow, report)

    required_secrets: list[str] = []
    required_variables: list[str] = []
    specs: dict[int, OpSpec] = {}
    for index, step in enumerate(flow.steps):
        spec = get_op(step.op)
        summary = StepSummary(
            index=index,
            op=step.op,
            title=step_title(step, spec),
            label=step.label or step_title(step, spec),
            enabled=step.enabled,
            description=f"Bước {index + 1}: {step.label or step_title(step, spec)}"
            + ("" if step.enabled else " (tắt)"),
            destructive=spec.destructive if spec else False,
            finalizing=spec.finalizing if spec else False,
        )
        report.steps.append(summary)
        base = f"steps[{index}]"
        if spec is None:
            report.errors.append(
                Issue("UNKNOWN_OP", f"Thao tác {step.op} không tồn tại.", index, f"{base}.op")
            )
            continue
        specs[index] = spec
        summary.standalone = spec.standalone
        if spec.standalone and step.op not in DOCUMENT_TRANSFORM_OPS:
            report.errors.append(
                Issue(
                    "STANDALONE_OP",
                    f"Thao tác {step.op} cần đường dẫn file riêng nên không dùng được trong "
                    "quy trình.",
                    index,
                    f"{base}.op",
                )
            )
        _check_placeholders(step, index, known, declared, given, summary, report)
        for path in literal_secret_paths(step.params):
            report.errors.append(
                Issue(
                    "SECRET_LITERAL",
                    "Mật khẩu hoặc mã PIN không được lưu trong quy trình. Hãy dùng "
                    "{{secret:...}} và nhập giá trị khi chạy.",
                    index,
                    f"{base}.params.{path}",
                )
            )
        if step.op in NOT_BATCH_OPS:
            summary.batch_incompatible = True
            report.warnings.append(
                Issue(
                    "NOT_BATCH",
                    f"Thao tác {step.op} cần chọn vị trí bằng tay nên không chạy hàng loạt được.",
                    index,
                    f"{base}.op",
                )
            )
        try:
            spec.params_model.model_validate(step.params)
        except ValidationError as exc:
            for err in exc.errors():
                field_path = f"{base}.params" + (
                    "." + _format_loc(tuple(err["loc"])) if err["loc"] else ""
                )
                report.errors.append(Issue("INVALID_PARAMS", str(err["msg"]), index, field_path))
        summary.needs_secrets = sorted(
            {
                secret_name(n)
                for _p, text in iter_strings(step.params)
                for n in placeholder_names(text)
                if is_secret(n)
            }
        )
    for step in flow.steps:
        for _path, text in iter_strings(step.params):
            for name in placeholder_names(text):
                if is_secret(name):
                    required_secrets.append(secret_name(name))
                elif name in declared and not declared[name] and name not in BUILTIN_VARIABLES:
                    required_variables.append(name)
    report.required_secrets = sorted(set(required_secrets))
    report.required_variables = sorted(set(required_variables))
    _check_order(flow, specs, report)
    return report


def _check_placeholders(
    step: WorkflowStep,
    index: int,
    known: set[str],
    declared: dict[str, str],
    given: dict[str, str],
    summary: StepSummary,
    report: ValidationReport,
) -> None:
    base = f"steps[{index}].params"
    for path, text in iter_strings(step.params):
        field_path = f"{base}.{path}" if path else base
        if not PLACEHOLDER_RE.search(text):
            continue
        for name in placeholder_names(text):
            if is_secret(name):
                if not secret_name(name):
                    report.errors.append(
                        Issue("UNKNOWN_VARIABLE", "Thiếu tên bí mật.", index, field_path)
                    )
                continue
            if name not in known:
                report.errors.append(
                    Issue(
                        "UNKNOWN_VARIABLE",
                        f"Biến {{{{{name}}}}} chưa được khai báo.",
                        index,
                        field_path,
                    )
                )


def _check_output(flow: Workflow, report: ValidationReport) -> None:
    out = flow.output
    if out.mode == "folder" and not out.folder:
        report.errors.append(
            Issue("OUTPUT", "Chế độ lưu vào thư mục cần có thư mục đích.", None, "output.folder")
        )
    if out.suffix and ILLEGAL_RE.search(out.suffix):
        report.errors.append(
            Issue("OUTPUT", "Hậu tố tên file có ký tự không hợp lệ.", None, "output.suffix")
        )
    if out.name_template is not None:
        for problem in check_template(out.name_template):
            report.errors.append(Issue("OUTPUT", problem, None, "output.nameTemplate"))


def _check_order(flow: Workflow, specs: dict[int, OpSpec], report: ValidationReport) -> None:
    """Reuse the order rule of O5: no destructive step after a signing step (enabled steps)."""
    indexes = [i for i, step in enumerate(flow.steps) if step.enabled and i in specs]
    violation = check_op_order([specs[i] for i in indexes])
    if violation is None:
        return
    index = indexes[violation.index]
    after = indexes[violation.after_index]
    report.errors.append(
        Issue(
            "ORDER",
            f"Bước {index + 1} ({specs[index].id}) làm thay đổi tài liệu nhưng đứng sau bước "
            f"{after + 1} ({specs[after].id}) đã ký số. Hãy đặt các bước thay đổi trước bước ký.",
            index,
            f"steps[{index}].op",
        )
    )


__all__ = [
    "DOCUMENT_TRANSFORM_OPS",
    "NOT_BATCH_OPS",
    "Issue",
    "StepSummary",
    "ValidationReport",
    "Workflow",
    "WorkflowInputs",
    "WorkflowOutput",
    "WorkflowStep",
    "describe_steps",
    "from_json",
    "parse_workflow",
    "to_json",
    "validate_workflow",
]
