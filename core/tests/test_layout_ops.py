"""T10.01 / D12 ops over the RPC harness: layout.analyze, layout.pageModel, toc.preview and
toc.fromHeadings."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from conftest import Harness, RpcFailure
from layout_support import report_pdf, scanned_page_pdf
from pytest import raises

from chef_core.layout.model import DocModel


def _sid(harness: Harness, path: Path) -> str:
    return str(harness.open(path)["state"]["sessionId"])


def _tree_titles(nodes: list[dict[str, Any]]) -> list[tuple[int, str]]:
    out: list[tuple[int, str]] = []

    def walk(items: list[dict[str, Any]], depth: int) -> None:
        for node in items:
            out.append((depth, node["title"]))
            walk(node["children"], depth + 1)

    walk(nodes, 0)
    return out


def test_analyze_writes_the_model_file_and_returns_a_summary(
    harness: Harness, tmp_path: Path
) -> None:
    sid = _sid(harness, report_pdf(tmp_path / "r.pdf", pages=6))
    data = harness.op("layout.analyze", {}, sid)["data"]
    model_path = Path(data["modelPath"])
    assert model_path.is_file()
    model = DocModel.model_validate_json(model_path.read_text(encoding="utf-8"))
    assert model.source.page_count == 6
    summary = data["summary"]
    assert summary["pages"] == 6
    assert summary["blocksByKind"]["header"] == 6
    assert summary["blocksByKind"]["table"] == 1
    assert summary["blocksByKind"]["list"] == 1
    assert len(summary["columnsPerPage"]) == 6
    assert "model" not in data, "the model stays in the file unless asked"


def test_analyze_inline_model_and_page_selection(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, report_pdf(tmp_path / "r.pdf", pages=6))
    data = harness.op("layout.analyze", {"pages": [2], "includeModel": True}, sid)["data"]
    assert data["summary"]["pages"] == 1
    assert data["model"]["pages"][0]["index"] == 2


def test_analyze_is_repeatable(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, report_pdf(tmp_path / "r.pdf", pages=6))
    first = Path(harness.op("layout.analyze", {}, sid)["data"]["modelPath"]).read_bytes()
    second = Path(harness.op("layout.analyze", {}, sid)["data"]["modelPath"]).read_bytes()
    assert first == second


def test_review_changes_heading_to_paragraph_without_changing_pdf(
    harness: Harness, tmp_path: Path
) -> None:
    source = report_pdf(tmp_path / "review.pdf", pages=6)
    original = source.read_bytes()
    sid = _sid(harness, source)
    analyzed = harness.op("layout.analyze", {"includeModel": True}, sid)["data"]
    page = analyzed["model"]["pages"][0]
    index = next(i for i, block in enumerate(page["blocks"]) if block["kind"] == "heading")
    result = harness.op(
        "layout.review",
        {
            "modelPath": analyzed["modelPath"],
            "changes": [{"pageIndex": 0, "blockIndex": index, "kind": "paragraph"}],
        },
        sid,
    )["data"]
    revised = DocModel.model_validate_json(Path(result["modelPath"]).read_text(encoding="utf-8"))
    assert revised.pages[0].blocks[index].kind == "paragraph"
    assert revised.pages[0].blocks[index].source_refs == page["blocks"][index]["sourceRefs"]
    assert source.read_bytes() == original
    output = tmp_path / "review.txt"
    harness.op(
        "export.document",
        {"format": "txt", "outputPath": str(output), "modelPath": result["modelPath"]},
        sid,
    )
    assert output.is_file()


def test_review_rejects_reclassifying_tables_and_images_as_unknown(
    harness: Harness, tmp_path: Path
) -> None:
    sid = _sid(harness, report_pdf(tmp_path / "protected-regions.pdf", pages=6))
    analyzed = harness.op("layout.analyze", {"includeModel": True}, sid)["data"]
    page = next(
        page
        for page in analyzed["model"]["pages"]
        if any(block["kind"] == "table" for block in page["blocks"])
        and any(block["kind"] == "image" for block in page["blocks"])
    )

    for kind in ("table", "image"):
        index = next(i for i, block in enumerate(page["blocks"]) if block["kind"] == kind)
        with raises(RpcFailure):
            harness.op(
                "layout.review",
                {
                    "modelPath": analyzed["modelPath"],
                    "changes": [
                        {"pageIndex": page["index"], "blockIndex": index, "kind": "unknown"}
                    ],
                },
                sid,
            )


def test_review_replaces_text_and_export_uses_the_correction(
    harness: Harness, tmp_path: Path
) -> None:
    source = report_pdf(tmp_path / "text-review.pdf", pages=6)
    sid = _sid(harness, source)
    analyzed = harness.op("layout.analyze", {"includeModel": True}, sid)["data"]
    page = analyzed["model"]["pages"][0]
    index = next(i for i, block in enumerate(page["blocks"]) if block["kind"] == "heading")
    original_text = "".join(run["text"] for run in page["blocks"][index]["runs"])
    corrected_text = original_text.replace("Báo cáo", "BÁO CÁO")

    result = harness.op(
        "layout.review",
        {
            "modelPath": analyzed["modelPath"],
            "changes": [
                {"pageIndex": 0, "blockIndex": index, "kind": "heading", "text": corrected_text}
            ],
        },
        sid,
    )["data"]
    revised = DocModel.model_validate_json(Path(result["modelPath"]).read_text(encoding="utf-8"))
    assert "".join(run.text for run in revised.pages[0].blocks[index].runs) == corrected_text

    output = tmp_path / "corrected.txt"
    harness.op(
        "export.document",
        {"format": "txt", "outputPath": str(output), "modelPath": result["modelPath"]},
        sid,
    )
    assert corrected_text in output.read_text(encoding="utf-8")


def test_review_text_edit_preserves_unchanged_run_styles() -> None:
    from chef_core.ops.layout import _replace_run_text

    runs = [
        {"text": "Mở ", "bold": True},
        {"text": "bài", "italic": True},
    ]
    revised = _replace_run_text(runs, "Mới bài!")

    assert "".join(run["text"] for run in revised) == "Mới bài!"
    assert any(run["text"].startswith("Mới") and run["bold"] for run in revised)
    assert any(run["text"].startswith("bài") and run["italic"] for run in revised)


def test_review_text_edit_handles_large_repeated_text_and_preserves_styles() -> None:
    from chef_core.ops.layout import _replace_run_text

    prefix = "lặp lại " * 8_000
    suffix = " nội dung cũ" * 8_000
    new = prefix + "Y" + suffix
    revised = _replace_run_text(
        [
            {"text": prefix, "bold": True},
            {"text": "X", "italic": True},
            {"text": suffix, "underline": True},
        ],
        new,
    )

    assert "".join(run["text"] for run in revised) == new
    assert revised[0]["text"] == prefix and revised[0]["bold"]
    assert any(run["text"] == "Y" and run["italic"] for run in revised)
    assert revised[-1]["text"] == suffix and revised[-1]["underline"]


def test_review_rejects_foreign_model_and_missing_block(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, report_pdf(tmp_path / "r.pdf", pages=6))
    analyzed = harness.op("layout.analyze", {}, sid)["data"]
    with raises(RpcFailure):
        harness.op(
            "layout.review",
            {
                "modelPath": analyzed["modelPath"],
                "changes": [{"pageIndex": 0, "blockIndex": 9999, "kind": "paragraph"}],
            },
            sid,
        )
    foreign = tmp_path / "foreign.json"
    foreign.write_bytes(Path(analyzed["modelPath"]).read_bytes())
    with raises(RpcFailure):
        harness.op("layout.review", {"modelPath": str(foreign), "changes": []}, sid)


def test_analyze_reports_scanned_pages(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, scanned_page_pdf(tmp_path / "s.pdf"))
    summary = harness.op("layout.analyze", {}, sid)["data"]["summary"]
    assert [w["code"] for w in summary["warnings"]] == ["PAGE_HAS_NO_TEXT_LAYER"]


def test_analyze_rejects_pages_out_of_range(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, report_pdf(tmp_path / "r.pdf", pages=6))
    with raises(RpcFailure):
        harness.op("layout.analyze", {"pages": [42]}, sid)


def test_page_model_inline_with_and_without_context(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, report_pdf(tmp_path / "r.pdf", pages=6))
    page = harness.op("layout.pageModel", {"pageIndex": 2, "context": True}, sid)["data"]
    kinds = [b["kind"] for b in page["page"]["blocks"]]
    assert "table" in kinds and "list" in kinds and "header" in kinds
    alone = harness.op("layout.pageModel", {"pageIndex": 2}, sid)["data"]
    assert "header" not in [b["kind"] for b in alone["page"]["blocks"]]


def test_toc_preview_nests_headings_and_respects_max_level(
    harness: Harness, tmp_path: Path
) -> None:
    sid = _sid(harness, report_pdf(tmp_path / "r.pdf", pages=6))
    preview = harness.op("toc.preview", {"maxLevel": 3}, sid)["data"]
    titles = _tree_titles(preview["bookmarks"])
    assert (0, "Báo cáo thường niên") in titles
    assert (1, "1. Giới thiệu") in titles
    assert (2, "1.1 Phạm vi báo cáo") in titles
    assert (0, "2. Kết luận") not in titles and (1, "2. Kết luận") in titles
    shallow = harness.op("toc.preview", {"maxLevel": 1}, sid)["data"]
    assert [t for d, t in _tree_titles(shallow["bookmarks"]) if d > 0] == []


def test_toc_preview_without_numbering(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, report_pdf(tmp_path / "r.pdf", pages=6))
    data = harness.op("toc.preview", {"includeNumbering": False}, sid)["data"]
    titles = [t for _, t in _tree_titles(data["bookmarks"])]
    assert "Giới thiệu" in titles and "Phạm vi báo cáo" in titles


def test_toc_from_headings_writes_bookmarks_that_bookmarks_get_reads(
    harness: Harness, tmp_path: Path
) -> None:
    sid = _sid(harness, report_pdf(tmp_path / "r.pdf", pages=6))
    result = harness.op("toc.fromHeadings", {"maxLevel": 3, "minConfidence": 0.6}, sid)
    assert result["data"]["count"] == 4  # the title and the three numbered headings
    got = harness.op("bookmarks.get", {}, sid)["data"]["bookmarks"]
    titles = [t for _, t in _tree_titles(got)]
    assert "1. Giới thiệu" in titles and "1.1 Phạm vi báo cáo" in titles
    page_of = {n["title"]: n["page"] for n in _walk(got)}
    assert page_of["2. Kết luận"] == 2
    view = next(n for n in _walk(got) if n["title"] == "1.1 Phạm vi báo cáo")["view"]
    assert view["type"] == "xyz" and view["top"] is not None


def _walk(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for node in nodes:
        out.append(node)
        out.extend(_walk(node["children"]))
    return out


def test_toc_append_keeps_existing_bookmarks(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, report_pdf(tmp_path / "r.pdf", pages=6))
    harness.op("bookmarks.fromPages", {"template": "Trang {page}"}, sid)
    harness.op("toc.fromHeadings", {"mode": "append"}, sid)
    got = _walk(harness.op("bookmarks.get", {}, sid)["data"]["bookmarks"])
    titles = [n["title"] for n in got]
    assert "Trang 1" in titles and "1. Giới thiệu" in titles


def test_toc_op_is_undoable(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, report_pdf(tmp_path / "r.pdf", pages=6))
    before = harness.op("bookmarks.get", {}, sid)["data"]["count"]
    harness.op("toc.fromHeadings", {}, sid)
    assert harness.op("bookmarks.get", {}, sid)["data"]["count"] > before
    harness.call("session.undo", {"sessionId": sid})
    assert harness.op("bookmarks.get", {}, sid)["data"]["count"] == before


def test_model_file_is_json(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, report_pdf(tmp_path / "r.pdf", pages=6))
    path = Path(harness.op("layout.analyze", {}, sid)["data"]["modelPath"])
    parsed = json.loads(path.read_text(encoding="utf-8"))
    assert parsed["version"] == 1 and "pages" in parsed
