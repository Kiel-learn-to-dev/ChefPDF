"""Export the JSON Schema of the document model to ``layout/schema.json``.

Usage::

    python -m chef_core.layout.schema            # write schema.json
    python -m chef_core.layout.schema --check    # exit 1 if the file is out of date
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from chef_core.layout.model import json_schema

SCHEMA_PATH = Path(__file__).with_name("schema.json")


def render() -> str:
    return json.dumps(json_schema(), ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m chef_core.layout.schema")
    parser.add_argument("--check", action="store_true", help="fail if schema.json is outdated")
    args = parser.parse_args(argv)
    content = render()
    if args.check:
        current = SCHEMA_PATH.read_text(encoding="utf-8") if SCHEMA_PATH.is_file() else ""
        if current != content:
            print(
                f"{SCHEMA_PATH} is out of date; run python -m chef_core.layout.schema",
                file=sys.stderr,
            )
            return 1
        return 0
    SCHEMA_PATH.write_text(content, encoding="utf-8", newline="\n")
    print(f"wrote {SCHEMA_PATH}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
