"""Committed TypeScript contracts must match the current pydantic models."""

from __future__ import annotations

from chef_core import codegen


def test_generated_ops_ts_is_up_to_date() -> None:
    expected = codegen.render()
    current = codegen.DEFAULT_OUTPUT.read_text(encoding="utf-8")
    assert current == expected, "run: cd core && uv run python -m chef_core.codegen"


def test_generated_workflow_ts_is_up_to_date() -> None:
    expected = codegen.render_workflow()
    current = codegen.DEFAULT_WORKFLOW_OUTPUT.read_text(encoding="utf-8")
    assert current == expected, "run: cd core && uv run python -m chef_core.codegen"


def test_codegen_check_covers_both_generated_contract_files() -> None:
    assert codegen.main(["--check"]) == 0


def test_render_contents() -> None:
    text = codegen.render()
    assert "export interface PageRotateParams {" in text
    assert "  angle: 90 | 180 | 270;" in text
    assert "  images: (ImagePathSource | ImageDataUrlSource)[];" in text
    assert "  password?: string;" in text
    assert "  'page.insertImages': PageInsertImagesParams;" in text
    assert "export type OpId = keyof OpParams;" in text


def test_render_workflow_preserves_wire_names_nulls_and_result_shapes() -> None:
    text = codegen.render_workflow()
    assert "export interface WorkflowStep {" in text
    assert "  onError?: 'stop' | 'skip';" in text
    assert "  label?: string | null;" in text
    assert "export interface WorkflowOutput {" in text
    assert "  alsoSavePdf?: boolean;" in text
    assert "export interface WorkflowValidationResult {" in text
    assert "export interface WorkflowRunResult {" in text
    assert "export interface WorkflowSamplesResult {" in text
    assert "  plannedOutputs: string[];" in text


def test_interface_name() -> None:
    assert codegen.interface_name("page.insertFromFile") == "PageInsertFromFileParams"
    assert codegen.interface_name("file.merge") == "FileMergeParams"


def test_ts_type_subset() -> None:
    assert codegen.ts_type({"type": "string"}) == "string"
    assert codegen.ts_type({"type": "array", "items": {"type": "integer"}}) == "number[]"
    assert codegen.ts_type({"anyOf": [{"type": "string"}, {"type": "null"}]}) == "string | null"
    assert codegen.ts_type({"const": "a"}) == "'a'"
    assert codegen.ts_type({"type": "object", "additionalProperties": {"type": "number"}}) == (
        "Record<string, number>"
    )
