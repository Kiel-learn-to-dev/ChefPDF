"""Summary of annotations (milestone v0.7, G4): rows, and files in txt, md, html, csv, xlsx, json.

A row has the page (1-based), the annotation type, author, date, the quoted text under a markup
annotation (taken from the text model: the characters whose boxes lie in its quads), the note
text, review status, the replies and the id. Exporting never changes the document.
"""

from __future__ import annotations

import csv
import html
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pikepdf

from chef_core.annots.review import describe, entries, ids_by_objgen
from chef_core.errors import invalid_params
from chef_core.text.build import build_text_page
from chef_core.text.model import TextPage

FORMATS = ("txt", "md", "html", "csv", "xlsx", "json")
COLUMNS = ("page", "type", "author", "date", "quoted_text", "contents", "status", "replies", "id")
TOLERANCE = 1.0  # points


@dataclass(frozen=True)
class Row:
    page: int
    type: str
    author: str
    date: str
    quoted_text: str
    contents: str
    status: str | None
    replies: str
    id: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "page": self.page,
            "type": self.type,
            "author": self.author,
            "date": self.date,
            "quoted_text": self.quoted_text,
            "contents": self.contents,
            "status": self.status or "",
            "replies": self.replies,
            "id": self.id,
        }


def quoted_text(tp: TextPage, quads: list[list[float]]) -> str:
    """Text under the quads (displayed frame, flat lists of 8 numbers), in reading order."""
    boxes = []
    for flat in quads:
        xs = flat[0::2]
        ys = flat[1::2]
        boxes.append(
            (min(xs) - TOLERANCE, min(ys) - TOLERANCE, max(xs) + TOLERANCE, max(ys) + TOLERANCE)
        )
    if not boxes:
        return ""
    pieces: list[str] = []
    for line in tp.lines:
        inside: list[str] = []
        for c in line.chars:
            left, top, right, bottom = tp.display_box((c.x0, c.y0, c.x1, c.y1))
            cx, cy = (left + right) / 2, (top + bottom) / 2
            if any(b[0] <= cx <= b[2] and b[1] <= cy <= b[3] for b in boxes):
                inside.append(c.ch)
        if inside:
            pieces.append("".join(inside).strip())
    return " ".join(p for p in pieces if p)


def collect(pdf: pikepdf.Pdf, page_indices: list[int], kinds: set[str] | None) -> list[Row]:
    rows: list[Row] = []
    for pi in page_indices:
        page = pdf.pages[pi]
        items: list[dict[str, Any]] = []
        ids = ids_by_objgen(pi, page)
        for index, annot in entries(page):
            subtype = str(annot.get("/Subtype", "")).lstrip("/")
            if subtype in ("Link", "Popup", "Widget"):
                continue
            if kinds is not None and subtype not in kinds:
                continue
            items.append(describe(pdf, pi, index, annot, ids))
        if not items:
            continue
        tp = build_text_page(pdf, page, pi)
        by_id = {it["id"]: it for it in items}
        for it in items:
            quoted = quoted_text(tp, it["quads"]) if it["quads"] else ""
            replies = " | ".join(
                str(by_id[r]["contents"])
                for r in it["replies"]
                if r in by_id and by_id[r]["contents"]
            )
            rows.append(
                Row(
                    page=pi + 1,
                    type=it["subtype"],
                    author=it["author"],
                    date=it["modified"],
                    quoted_text=quoted,
                    contents=it["contents"],
                    status=it["status"],
                    replies=replies,
                    id=it["id"],
                )
            )
    return rows


def write(rows: list[Row], fmt: str, target: Path) -> None:
    if fmt not in FORMATS:
        raise invalid_params("INVALID_EXPORT_FORMAT", {"format": fmt})
    if fmt == "txt":
        target.write_text(_txt(rows), encoding="utf-8")
    elif fmt == "md":
        target.write_text(_md(rows), encoding="utf-8")
    elif fmt == "html":
        target.write_text(_html(rows), encoding="utf-8")
    elif fmt == "csv":
        with target.open("w", encoding="utf-8-sig", newline="") as fh:
            writer = csv.DictWriter(fh, fieldnames=list(COLUMNS))
            writer.writeheader()
            for row in rows:
                writer.writerow(row.as_dict())
    elif fmt == "json":
        target.write_text(
            json.dumps([row.as_dict() for row in rows], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    else:
        _xlsx(rows, target)


def _label(row: Row) -> str:
    return f"Trang {row.page} · {row.type}" + (f" · {row.author}" if row.author else "")


def _txt(rows: list[Row]) -> str:
    out = ["Danh sách ghi chú", ""]
    for n, row in enumerate(rows, 1):
        out.append(f"{n}. {_label(row)}" + (f" · {row.date}" if row.date else ""))
        if row.quoted_text:
            out.append(f"   Trích: {row.quoted_text}")
        if row.contents:
            out.append(f"   Nội dung: {row.contents}")
        if row.status:
            out.append(f"   Trạng thái: {row.status}")
        if row.replies:
            out.append(f"   Trả lời: {row.replies}")
        out.append("")
    return "\n".join(out)


def _md(rows: list[Row]) -> str:
    out = ["# Danh sách ghi chú", ""]
    for n, row in enumerate(rows, 1):
        out.append(f"## {n}. {_label(row)}")
        out.append("")
        if row.quoted_text:
            out.append(f"> {row.quoted_text}")
            out.append("")
        if row.contents:
            out.append(f"- **Nội dung:** {row.contents}")
        if row.status:
            out.append(f"- **Trạng thái:** {row.status}")
        if row.date:
            out.append(f"- **Ngày:** {row.date}")
        if row.replies:
            out.append(f"- **Trả lời:** {row.replies}")
        out.append("")
    return "\n".join(out)


def _html(rows: list[Row]) -> str:
    head = "".join(f"<th>{html.escape(c)}</th>" for c in COLUMNS)
    body = []
    for row in rows:
        cells = "".join(f"<td>{html.escape(str(row.as_dict()[c]))}</td>" for c in COLUMNS)
        body.append(f"<tr>{cells}</tr>")
    return (
        '<!doctype html><html lang="vi"><head><meta charset="utf-8">'
        "<title>Danh sách ghi chú</title>"
        "<style>body{font-family:sans-serif}table{border-collapse:collapse}"
        "td,th{border:1px solid #bbb;padding:4px 6px;vertical-align:top}</style></head><body>"
        f"<h1>Danh sách ghi chú</h1><table><thead><tr>{head}</tr></thead>"
        f"<tbody>{''.join(body)}</tbody></table></body></html>\n"
    )


def _xlsx(rows: list[Row], target: Path) -> None:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font

    wb = Workbook()
    ws = wb.active
    assert ws is not None
    ws.title = "Ghi chú"
    ws.append(list(COLUMNS))
    for cell in ws[1]:
        cell.font = Font(bold=True)
    for row in rows:
        ws.append([row.as_dict()[c] for c in COLUMNS])
    widths = {"A": 7, "B": 14, "C": 18, "D": 20, "E": 48, "F": 48, "G": 12, "H": 40, "I": 20}
    for col, width in widths.items():
        ws.column_dimensions[col].width = width
    for row_cells in ws.iter_rows(min_row=2):
        for cell in row_cells:
            cell.alignment = Alignment(wrap_text=True, vertical="top")
    wb.save(target)


__all__ = ["COLUMNS", "FORMATS", "Row", "collect", "quoted_text", "write"]
