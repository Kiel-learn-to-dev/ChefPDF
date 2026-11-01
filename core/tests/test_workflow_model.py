"""T9.02: workflow model, JSON round trip and validate_workflow (error collection, ordering,
secrets, placeholders, standalone rule, batch flags)."""

from __future__ import annotations

from typing import Any

from chef_core.ops import load_builtin_ops
from chef_core.workflow.model import (
    Workflow,
    describe_steps,
    parse_workflow,
    to_json,
    validate_workflow,
)

load_builtin_ops()


def wf(steps: list[dict[str, Any]], **extra: Any) -> Workflow:
    data: dict[str, Any] = {"id": "test-wf", "name": "Thử", "steps": steps, **extra}
    parsed, issues = parse_workflow(data)
    assert parsed is not None, issues
    return parsed


def kinds(report: Any) -> list[str]:
    return [issue.kind for issue in report.errors]


def test_json_round_trip_keeps_every_field() -> None:
    flow = wf(
        [
            {"op": "page.rotate", "params": {"pages": [0], "angle": 90}, "label": "Xoay"},
            {"op": "overlay.pageNumbers", "params": {"preset": "nd30"}, "onError": "skip"},
        ],
        description="Mô tả",
        variables={"ten": "HS"},
        output={"mode": "folder", "folder": "out", "nameTemplate": "{name}_{seq:3}"},
    )
    text = to_json(flow)
    assert '"onError": "skip"' in text
    again, issues = parse_workflow(__import__("json").loads(text))
    assert issues == []
    assert again == flow


def test_structural_problems_are_reported_with_paths() -> None:
    parsed, issues = parse_workflow(
        {"id": "x", "name": "a", "steps": [{"op": "page.rotate", "onError": "explode"}]}
    )
    assert parsed is None
    assert any(i.field == "steps[0].onError" for i in issues)


def test_unknown_op_is_an_error_at_its_step() -> None:
    report = validate_workflow(
        wf([{"op": "page.rotate", "params": {"pages": [0], "angle": 90}}, {"op": "nope.missing"}])
    )
    assert not report.valid
    err = [e for e in report.errors if e.kind == "UNKNOWN_OP"]
    assert len(err) == 1 and err[0].step == 1 and err[0].field == "steps[1].op"


def test_all_param_errors_are_collected_with_step_and_field() -> None:
    report = validate_workflow(
        wf(
            [
                {"op": "page.rotate", "params": {"angle": 45}},
                {"op": "overlay.pageNumbers", "params": {"numberFormat": "bogus"}},
            ]
        )
    )
    fields = {e.field for e in report.errors if e.kind == "INVALID_PARAMS"}
    assert any(f and f.startswith("steps[0].params.") for f in fields)
    assert any(f and f.startswith("steps[1].params.") for f in fields)
    assert len([e for e in report.errors if e.step == 0]) >= 2


def test_standalone_ops_need_explicit_paths_and_are_rejected() -> None:
    report = validate_workflow(
        wf([{"op": "compress.file", "params": {"inputPath": "a", "outputPath": "b"}}])
    )
    assert "STANDALONE_OP" in kinds(report)


def test_destructive_after_signing_is_an_order_error_naming_steps() -> None:
    report = validate_workflow(
        wf(
            [
                {
                    "op": "sign.pades",
                    "params": {"pfxPath": "a.pfx", "password": "{{secret:password}}"},
                },
                {"op": "page.rotate", "params": {"pages": [0], "angle": 90}},
            ]
        )
    )
    order = [e for e in report.errors if e.kind == "ORDER"]
    assert len(order) == 1
    assert "Bước 2 (page.rotate)" in order[0].message
    assert "bước 1 (sign.pades)" in order[0].message
    assert order[0].step == 1


def test_disabled_steps_do_not_take_part_in_the_order_check() -> None:
    report = validate_workflow(
        wf(
            [
                {"op": "sign.pades", "params": {"pfxPath": "a.pfx"}, "enabled": False},
                {"op": "page.rotate", "params": {"pages": [0], "angle": 90}},
            ]
        )
    )
    assert "ORDER" not in kinds(report)


def test_literal_secret_is_refused_placeholder_is_flagged() -> None:
    literal = validate_workflow(
        wf([{"op": "security.encrypt", "params": {"userPassword": "hunter2"}}])
    )
    assert "SECRET_LITERAL" in kinds(literal)
    ok = validate_workflow(
        wf(
            [
                {
                    "op": "sign.pades",
                    "params": {"pfxPath": "{{pfx}}", "password": "{{secret:password}}"},
                }
            ],
            variables={"pfx": ""},
        )
    )
    assert "SECRET_LITERAL" not in kinds(ok)
    assert ok.steps[0].needs_secrets == ["password"]
    assert ok.required_secrets == ["password"]
    assert ok.required_variables == ["pfx"]


def test_unknown_variable_is_an_error() -> None:
    report = validate_workflow(
        wf([{"op": "security.encrypt", "params": {"userPassword": "{{nope}}"}}])
    )
    assert "UNKNOWN_VARIABLE" in kinds(report)


def test_batch_incompatible_steps_are_flagged() -> None:
    report = validate_workflow(
        wf([{"op": "content.delete", "params": {"page": 0, "objectIds": ["x"]}}])
    )
    assert report.steps[0].batch_incompatible is True


def test_describe_steps_uses_op_titles_and_labels() -> None:
    flow = wf(
        [
            {"op": "page.rotate", "params": {"pages": [0], "angle": 90}},
            {
                "op": "page.rotate",
                "params": {"pages": [0], "angle": 90},
                "label": "Xoay lại",
                "enabled": False,
            },
        ]
    )
    lines = describe_steps(flow)
    assert len(lines) == 2
    assert lines[0].startswith("Bước 1: ")
    assert "Xoay lại" in lines[1] and "tắt" in lines[1]


def test_output_rules_are_checked() -> None:
    report = validate_workflow(
        wf(
            [{"op": "page.rotate", "params": {"pages": [0], "angle": 90}}],
            output={"mode": "folder"},
        )
    )
    assert any(e.field == "output.folder" for e in report.errors)
    bad = validate_workflow(
        wf(
            [{"op": "page.rotate", "params": {"pages": [0], "angle": 90}}],
            output={"nameTemplate": "{bogus}"},
        )
    )
    assert any(e.field == "output.nameTemplate" for e in bad.errors)
