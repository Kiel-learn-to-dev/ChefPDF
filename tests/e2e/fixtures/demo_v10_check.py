"""Checks the demo-v10 outputs from the files themselves (run with the core environment).

Usage: python demo_v10_check.py MANIFEST.json   (the JSON printed by demo_v10_export.py)

For each DOCX: the table (rows, columns, header text), the column sections (layout mode only), the
running header and footer that must stay out of the body, and the order of the headings.
For the Markdown: the headings and one pipe table with a separator row, and no running header.
"""

import json
import re
import sys
from pathlib import Path

import docx

HEADER_TEXT = "Báo cáo thường niên 2026 · Chef PDF"
FOOTER_TEXT = "Bí mật nội bộ"
HEADINGS = ["Giới thiệu", "Phạm vi báo cáo", "Kết luận"]
TABLE_HEADER = ["Quý", "Doanh thu", "Chi phí", "Lợi nhuận"]


def check_docx(path: Path, layout_mode: bool) -> dict:
    document = docx.Document(str(path))
    body = [p.text for p in document.paragraphs if p.text.strip()]
    text = "\n".join(body)
    tables = document.tables
    headings = [t for t in body if any(h in t for h in HEADINGS)]
    report = {
        "bytes": path.stat().st_size,
        "tables": len(tables),
        "tableRows": len(tables[0].rows) if tables else 0,
        "tableColumns": len(tables[0].columns) if tables else 0,
        "tableHeader": [c.text for c in tables[0].rows[0].cells] if tables else [],
        "sections": len(document.sections),
        "headerInBody": HEADER_TEXT in text,
        "footerInBody": FOOTER_TEXT in text,
        "pageNumberInBody": bool(re.search(r"^Trang \d+$", text, re.M)),
        "titleCount": sum(1 for t in body if t == "Báo cáo thường niên"),
        "headingOrder": [next(h for h in HEADINGS if h in t) for t in headings],
        "vietnameseKept": "Chi phí" in text and "Doanh thu" in text,
    }
    report["layoutSections"] = layout_mode and report["sections"] >= 2
    return report


def check_markdown(path: Path) -> dict:
    lines = path.read_text(encoding="utf-8").splitlines()
    text = "\n".join(lines)
    pipe_rows = [line for line in lines if line.startswith("|")]
    separators = [line for line in pipe_rows if re.fullmatch(r"\|[\s:|-]+\|", line.strip())]
    headings = [line for line in lines if re.match(r"^#{1,6} ", line)]
    return {
        "bytes": path.stat().st_size,
        "pipeRows": len(pipe_rows),
        "separatorRows": len(separators),
        "tableHeader": [c.strip() for c in pipe_rows[0].strip("|").split("|")] if pipe_rows else [],
        "headingLevels": [len(re.match(r"^(#+)", h).group(1)) for h in headings],
        "headerInBody": HEADER_TEXT in text,
        "footerInBody": FOOTER_TEXT in text,
    }


def main() -> None:
    manifest = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    files = manifest["files"]
    result = {
        "layout": check_docx(Path(files["layoutDocx"]), layout_mode=True),
        "editable": check_docx(Path(files["editableDocx"]), layout_mode=False),
        "markdown": check_markdown(Path(files["markdown"])),
        "analysis": manifest["summary"],
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
