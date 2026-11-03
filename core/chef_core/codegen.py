"""Generate TypeScript interfaces for operation params from their pydantic JSON Schemas.

Usage::

    python -m chef_core.codegen            # write packages/contracts/src/generated/ops.ts
    python -m chef_core.codegen --check    # exit 1 if the file is out of date
    python -m chef_core.codegen --stdout   # print instead of writing

Only the JSON Schema subset produced by our params models is supported: objects, arrays,
strings, numbers, integers, booleans, null, enums/consts, anyOf/oneOf and ``$ref`` to
``$defs``. Anything else raises, so unsupported schemas are noticed at codegen time.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

from chef_core import ops
from chef_core.models import WireModel
from chef_core.workflow.contracts import (
    WorkflowRunResult,
    WorkflowSamplesResult,
    WorkflowValidationResult,
)
from chef_core.workflow.model import Workflow, WorkflowInputs, WorkflowOutput, WorkflowStep

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = REPO_ROOT / "packages" / "contracts" / "src" / "generated" / "ops.ts"
DEFAULT_WORKFLOW_OUTPUT = (
    REPO_ROOT / "packages" / "contracts" / "src" / "generated" / "workflow.ts"
)

HEADER = """\
/**
 * GENERATED FILE - DO NOT EDIT.
 * Source: pydantic params models of the core operations (core/chef_core/ops).
 * Regenerate: cd core && uv run python -m chef_core.codegen
 */
"""

WORKFLOW_HEADER = """\
/**
 * GENERATED FILE - DO NOT EDIT.
 * Source: pydantic workflow models and result contracts (core/chef_core/workflow).
 * Regenerate: cd core && uv run python -m chef_core.codegen
 */
"""

_IDENT_RE = re.compile(r"^[A-Za-z_$][A-Za-z0-9_$]*$")

Schema = dict[str, Any]


def interface_name(op_id: str) -> str:
    """``page.insertBlank`` → ``PageInsertBlankParams``."""
    parts = re.split(r"[._-]", op_id)
    return "".join(p[:1].upper() + p[1:] for p in parts if p) + "Params"


def _literal(value: Any) -> str:
    if isinstance(value, str):
        return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        return json.dumps(value)
    raise TypeError(f"unsupported literal: {value!r}")


def _ref_name(ref: str) -> str:
    prefix = "#/$defs/"
    if not ref.startswith(prefix):
        raise ValueError(f"unsupported $ref: {ref}")
    return ref[len(prefix) :]


def _union(types: list[str]) -> str:
    seen: list[str] = []
    for t in types:
        if t not in seen:
            seen.append(t)
    return " | ".join(seen)


def ts_type(schema: Schema, indent: str = "") -> str:
    if "$ref" in schema:
        return _ref_name(schema["$ref"])
    for key in ("anyOf", "oneOf"):
        if key in schema:
            return _union([ts_type(s, indent) for s in schema[key]])
    if "const" in schema:
        return _literal(schema["const"])
    if "enum" in schema:
        return _union([_literal(v) for v in schema["enum"]])
    kind = schema.get("type")
    if isinstance(kind, list):
        return _union([ts_type({**schema, "type": k}, indent) for k in kind])
    if kind == "string":
        return "string"
    if kind in ("integer", "number"):
        return "number"
    if kind == "boolean":
        return "boolean"
    if kind == "null":
        return "null"
    if kind == "array":
        item = ts_type(schema.get("items", {}), indent)
        return f"({item})[]" if " | " in item else f"{item}[]"
    if kind == "object" or "properties" in schema:
        if "properties" in schema:
            return _object_body(schema, indent)
        extra = schema.get("additionalProperties")
        value = ts_type(extra, indent) if isinstance(extra, dict) else "unknown"
        return f"Record<string, {value}>"
    if not schema:
        return "unknown"
    raise ValueError(f"unsupported schema: {schema}")


def _doc(schema: Schema, indent: str) -> list[str]:
    lines: list[str] = []
    description = schema.get("description")
    if description:
        lines.extend(str(description).split("\n"))
    if schema.get("default") is not None:
        lines.append(f"@default {json.dumps(schema['default'], ensure_ascii=False)}")
    if not lines:
        return []
    lines = [line.replace("``", "`").replace("*/", "*\\/").rstrip() for line in lines]
    if len(lines) == 1:
        return [f"{indent}/** {lines[0]} */"]
    return [f"{indent}/**", *[f"{indent} * {line}".rstrip() for line in lines], f"{indent} */"]


def _prop_key(name: str) -> str:
    return name if _IDENT_RE.match(name) else _literal(name)


def _object_body(schema: Schema, indent: str, *, preserve_null: bool = False) -> str:
    required = set(schema.get("required", []))
    inner = indent + "  "
    lines = ["{"]
    for name, prop in schema.get("properties", {}).items():
        lines.extend(_doc(prop, inner))
        optional = "" if name in required else "?"
        if (
            not preserve_null
            and optional
            and "default" in prop
            and prop["default"] is None
            and "anyOf" in prop
        ):
            # Optional[X] = None: an omitted field is enough on the TypeScript side.
            branches = [b for b in prop["anyOf"] if b != {"type": "null"}]
            prop = {**prop, "anyOf": branches}
        lines.append(f"{inner}{_prop_key(name)}{optional}: {ts_type(prop, inner)};")
    lines.append(f"{indent}}}")
    return "\n".join(lines)


def _interface(name: str, schema: Schema, *, preserve_null: bool = False) -> str:
    doc = _doc({"description": schema.get("description")}, "")
    body = _object_body(schema, "", preserve_null=preserve_null)
    return "\n".join([*doc, f"export interface {name} {body}"])


def render() -> str:
    """Render the full ``ops.ts`` content for all registered operations."""
    ops.load_builtin_ops()
    specs = sorted(ops.registry().values(), key=lambda s: s.id)
    defs: dict[str, Schema] = {}
    blocks: list[str] = []
    for spec in specs:
        schema = spec.params_schema()
        for def_name, def_schema in schema.pop("$defs", {}).items():
            if def_name in defs and defs[def_name] != def_schema:
                raise ValueError(f"conflicting definitions for {def_name}")
            defs[def_name] = def_schema
        blocks.append(_interface(interface_name(spec.id), schema))
    def_blocks = [_interface(name, defs[name]) for name in sorted(defs)]

    map_lines = ["/** Params type of every operation, by op id. */", "export interface OpParams {"]
    map_lines += [f"  '{spec.id}': {interface_name(spec.id)};" for spec in specs]
    map_lines.append("}")
    ids = "".join(f"  '{spec.id}',\n" for spec in specs)
    tail = [
        "\n".join(map_lines),
        "export type OpId = keyof OpParams;",
        f"export const OP_IDS = [\n{ids}] as const;",
    ]
    return HEADER + "\n" + "\n\n".join([*def_blocks, *blocks, *tail]) + "\n"


def render_workflow() -> str:
    """Render the workflow JSON and operation result contracts for TypeScript."""
    models: list[type[WireModel]] = [
        Workflow,
        WorkflowStep,
        WorkflowInputs,
        WorkflowOutput,
        WorkflowValidationResult,
        WorkflowRunResult,
        WorkflowSamplesResult,
    ]
    roots: dict[str, Schema] = {}
    defs: dict[str, Schema] = {}
    for model in models:
        schema = model.model_json_schema(by_alias=True)
        root_name = schema.pop("title")
        roots[root_name] = schema
        for name, definition in schema.pop("$defs", {}).items():
            definition.pop("title", None)
            prior = defs.get(name)
            if prior is not None and prior != definition:
                raise ValueError(f"conflicting workflow definitions for {name}")
            defs[name] = definition
    for name, definition in defs.items():
        if name in roots and roots[name] != definition:
            raise ValueError(f"conflicting workflow root and definition for {name}")
    blocks = [
        _interface(name, defs.get(name, schema), preserve_null=True)
        for name, schema in roots.items()
    ]
    blocks += [
        _interface(name, schema, preserve_null=True)
        for name, schema in sorted(defs.items())
        if name not in roots
    ]
    return WORKFLOW_HEADER + "\n" + "\n\n".join(blocks) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m chef_core.codegen")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--workflow-out", type=Path, default=DEFAULT_WORKFLOW_OUTPUT)
    parser.add_argument("--check", action="store_true", help="fail if the file is outdated")
    parser.add_argument("--stdout", action="store_true", help="print instead of writing")
    args = parser.parse_args(argv)
    content = render()
    workflow_content = render_workflow()
    if args.stdout:
        sys.stdout.write(content)
        return 0
    out: Path = args.out
    if args.check:
        targets = [(out, content)]
        if args.out == DEFAULT_OUTPUT:
            targets.append((args.workflow_out, workflow_content))
        stale = False
        for target, expected in targets:
            current = target.read_text(encoding="utf-8") if target.is_file() else ""
            if current != expected:
                print(f"{target} is out of date; run python -m chef_core.codegen", file=sys.stderr)
                stale = True
        return int(stale)
    targets = [(out, content)]
    if args.out == DEFAULT_OUTPUT:
        targets.append((args.workflow_out, workflow_content))
    for target, expected in targets:
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(expected, encoding="utf-8", newline="\n")
        print(f"wrote {target}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
