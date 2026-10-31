"""The committed TypeScript params file must match the current pydantic models."""

from __future__ import annotations

from chef_core import codegen


def test_generated_ops_ts_is_up_to_date() -> None:
    expected = codegen.render()
    current = codegen.DEFAULT_OUTPUT.read_text(encoding="utf-8")
    assert current == expected, "run: cd core && uv run python -m chef_core.codegen"


def test_render_contents() -> None:
    text = codegen.render()
    assert "export interface PageRotateParams {" in text
    assert "  angle: 90 | 180 | 270;" in text
    assert "  images: (ImagePathSource | ImageDataUrlSource)[];" in text
    assert "  password?: string;" in text
    assert "  'page.insertImages': PageInsertImagesParams;" in text
    assert "export type OpId = keyof OpParams;" in text


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
