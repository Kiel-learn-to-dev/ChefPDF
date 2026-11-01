"""Fixtures of the exporter tests (T10.04-T10.07).

``reference_model`` is a hand-built document model that covers every block kind, nested lists, a
table with a row span and a column span, Vietnamese text, links, super- and subscript, footnotes,
furniture and an image that cannot be extracted. ``reference_pdf`` is the PDF its figure is
rendered from. ``report_model`` is the model of a generated two-column report (real detection).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from reportlab.lib import colors
from reportlab.pdfgen import canvas

from chef_core.layout.model import DocModel
from chef_core.pdf.io import open_pdf

PAGE_W, PAGE_H = 595.0, 842.0
LINK = "https://example.com/ban-quyen"
PARA_RUNS = [
    {"text": "Đây là "},
    {"text": "đoạn đậm", "bold": True},
    {"text": " và "},
    {"text": "nghiêng", "italic": True},
    {"text": " kèm "},
    {"text": "liên kết", "link": LINK},
    {"text": " với chỉ số "},
    {"text": "2", "sup": True},
    {"text": " & <thẻ> *sao* [ngoặc] _gạch_ | ống"},
]


def _run(text: str, **kw: Any) -> dict[str, Any]:
    return {"text": text, **kw}


def _cell(
    paras: list[list[dict[str, Any]]], row_span: int = 1, col_span: int = 1
) -> dict[str, Any]:
    blocks = [
        {"kind": "paragraph", "bbox": [0, 0, 10, 10], "readingOrder": 0, "runs": runs}
        for runs in paras
    ]
    return {"rowSpan": row_span, "colSpan": col_span, "blocks": blocks}


def _box(x0: float, y0: float, x1: float, y1: float) -> list[float]:
    return [x0, y0, x1, y1]


def reference_dict() -> dict[str, Any]:
    page0 = [
        {
            "kind": "header",
            "bbox": _box(60, 20, 500, 34),
            "readingOrder": 0,
            "runs": [_run("Báo cáo mẫu · Chef PDF", size=8)],
        },
        {
            "kind": "heading",
            "level": 1,
            "bbox": _box(60, 60, 500, 84),
            "readingOrder": 1,
            "runs": [_run("Chương 1: Tổng quan", bold=True, size=20)],
        },
        {
            "kind": "paragraph",
            "bbox": _box(60, 90, 500, 130),
            "readingOrder": 2,
            "runs": PARA_RUNS,
            "joinedPages": [],
        },
        {
            "kind": "heading",
            "level": 2,
            "bbox": _box(60, 140, 500, 158),
            "readingOrder": 3,
            "runs": [_run("1.1 Danh sách", bold=True, size=14)],
        },
        {
            "kind": "list",
            "ordered": True,
            "bbox": _box(60, 160, 500, 220),
            "readingOrder": 4,
            "items": [
                {
                    "marker": "1.",
                    "runs": [_run("Mục một")],
                    "children": [
                        {
                            "marker": "a.",
                            "runs": [_run("Mục con a")],
                            "children": [],
                        }
                    ],
                },
                {"marker": "2.", "runs": [_run("Mục hai")], "children": []},
            ],
        },
        {
            "kind": "list",
            "ordered": False,
            "bbox": _box(60, 225, 500, 260),
            "readingOrder": 5,
            "items": [
                {
                    "marker": "•",
                    "runs": [_run("Gạch đầu dòng")],
                    "children": [
                        {
                            "marker": "–",
                            "runs": [
                                _run("Con"),
                            ],
                            "children": [],
                        }
                    ],
                }
            ],
        },
        {
            "kind": "table",
            "hasHeaderRow": True,
            "columns": 3,
            "bbox": _box(60, 270, 500, 340),
            "readingOrder": 6,
            "rows": [
                [
                    _cell([[_run("Tên", bold=True)]], row_span=2),
                    _cell([[_run("Số liệu", bold=True)]], col_span=2),
                ],
                [_cell([[_run("Q1")]]), _cell([[_run("Q2")]])],
                [
                    _cell([[_run("Ann")], [_run("Lee")]]),
                    _cell([[_run("10")]]),
                    _cell([[_run("20,5")]]),
                ],
            ],
        },
        {
            "kind": "image",
            "imageRef": "p0:0000000000000000:999",
            "caption": "Hình 1. Ảnh minh họa",
            "bbox": _box(60, 360, 300, 480),
            "readingOrder": 7,
        },
        {
            "kind": "figure",
            "renderedRef": None,
            "caption": "Hình 2. Hình vẽ",
            "bbox": _box(320, 360, 500, 480),
            "readingOrder": 8,
        },
        {"kind": "separator", "bbox": _box(60, 500, 500, 501), "readingOrder": 9},
        {
            "kind": "footnote",
            "bbox": _box(60, 760, 500, 772),
            "readingOrder": 10,
            "runs": [
                _run("1 Chú thích đầu trang."),
            ],
        },
        {
            "kind": "unknown",
            "bbox": _box(60, 780, 500, 792),
            "readingOrder": 11,
            "runs": [
                _run("Khối chưa phân loại"),
            ],
            "reason": "test",
        },
        {
            "kind": "pageNumber",
            "bbox": _box(260, 810, 330, 822),
            "readingOrder": 12,
            "runs": [_run("Trang 1")],
        },
    ]
    page1 = [
        {
            "kind": "heading",
            "level": 1,
            "bbox": _box(60, 60, 500, 84),
            "readingOrder": 0,
            "runs": [_run("Chương 2: Kết luận", bold=True, size=20)],
        },
        {
            "kind": "paragraph",
            "bbox": _box(60, 90, 500, 110),
            "readingOrder": 1,
            "runs": [_run("Nội dung cuối tài liệu.")],
            "joinedPages": [],
        },
        {
            "kind": "footer",
            "bbox": _box(60, 800, 500, 812),
            "readingOrder": 2,
            "runs": [_run("Chân trang")],
        },
        {
            "kind": "footnote",
            "bbox": _box(60, 760, 500, 772),
            "readingOrder": 3,
            "runs": [_run("* Ghi chú khác.")],
        },
    ]
    return {
        "version": 1,
        "source": {"name": "tai-lieu-mau.pdf", "pageCount": 2},
        "pages": [
            {"index": 0, "width": PAGE_W, "height": PAGE_H, "rotation": 0, "blocks": page0},
            {"index": 1, "width": PAGE_W, "height": PAGE_H, "rotation": 0, "blocks": page1},
        ],
        "styles": {
            "body": {"font": "Arial", "size": 10, "bold": False, "italic": False, "color": None},
            "heading1": {"font": "Arial", "size": 20, "bold": True, "italic": False, "color": None},
            "heading2": {"font": "Arial", "size": 14, "bold": True, "italic": False, "color": None},
        },
        "meta": {"title": "Tài liệu mẫu", "author": "Nguyễn Văn A", "lang": "vi"},
    }


def reference_model() -> DocModel:
    return DocModel.model_validate(reference_dict())


def reference_pdf(path: Path) -> Path:
    """A two-page PDF with a filled rectangle where the reference figure is (for region renders)."""
    cv = canvas.Canvas(str(path), pagesize=(PAGE_W, PAGE_H))
    for _ in range(2):
        cv.setFillColor(colors.HexColor("#1e5ab4"))
        cv.rect(320, PAGE_H - 480, 180, 120, stroke=0, fill=1)
        cv.setFillColor(colors.black)
        cv.drawString(60, PAGE_H - 100, "Reference page text")
        cv.showPage()
    cv.save()
    return path


def model_of(path: Path) -> DocModel:
    """The model of a PDF from the rules-based analysis (what ``layout.analyze`` writes)."""
    from chef_core.layout.detect import build_doc_model

    with open_pdf(path) as pdf:
        return build_doc_model(pdf, None, name=path.stem).model


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")
