"""T10.04-T10.07 over the RPC harness: export.document, export.refresh, export.batch, and the output
names of batch jobs."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pikepdf
from conftest import Harness, RpcFailure
from layout_support import report_pdf
from pytest import raises

from chef_core.export import markdown as export_markdown
from chef_core.export.names import OutputRule, target_for
from chef_core.ops import load_builtin_ops
from chef_core.ops.base import get_op, registry


def _sid(harness: Harness, path: Path) -> str:
    return str(harness.open(path)["state"]["sessionId"])


def test_export_ops_are_registered_with_their_params() -> None:
    load_builtin_ops()
    reg = registry()
    for op_id in ("export.document", "export.refresh", "export.batch"):
        spec = get_op(op_id)
        assert spec is not None, op_id
        assert op_id in reg
    schema = get_op("export.document").params_schema()  # type: ignore[union-attr]
    assert set(schema["required"]) >= {"format", "outputPath"}
    assert "options" in schema["properties"]
    assert get_op("export.batch").standalone  # type: ignore[union-attr]
    assert not get_op("export.document").destructive  # type: ignore[union-attr]


def test_export_document_writes_markdown_from_a_session(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, report_pdf(tmp_path / "r.pdf", pages=6))
    out = tmp_path / "r.md"
    data = harness.op("export.document", {"format": "md", "outputPath": str(out)}, sid)["data"]
    assert out.is_file()
    assert data["outputPath"] == str(out)
    assert data["format"] == "md"
    assert data["stats"]["blocks"] > 0
    assert out.read_text(encoding="utf-8").startswith("#")


def test_export_document_every_format(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, report_pdf(tmp_path / "r.pdf", pages=6))
    for fmt in ("md", "html", "txt", "json", "epub", "odt", "xlsx", "docx"):
        out = tmp_path / f"r-all-{fmt}.{fmt}"
        harness.op("export.document", {"format": fmt, "outputPath": str(out)}, sid)
        assert out.is_file() and out.stat().st_size > 100, fmt


def test_export_document_uses_a_reviewed_model(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, report_pdf(tmp_path / "r.pdf", pages=6))
    model_path = harness.op("layout.analyze", {}, sid)["data"]["modelPath"]
    direct = tmp_path / "direct.txt"
    reviewed = tmp_path / "reviewed.txt"
    harness.op("export.document", {"format": "txt", "outputPath": str(direct)}, sid)
    harness.op(
        "export.document",
        {"format": "txt", "outputPath": str(reviewed), "modelPath": model_path},
        sid,
    )
    assert direct.read_bytes() == reviewed.read_bytes()


def test_export_document_pages_and_options(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, report_pdf(tmp_path / "r.pdf", pages=6))
    out = tmp_path / "one.txt"
    harness.op(
        "export.document",
        {"format": "txt", "outputPath": str(out), "pages": [2], "options": {"pageMarkers": True}},
        sid,
    )
    text = out.read_text(encoding="utf-8")
    assert text.startswith("--- Trang 3 ---")
    assert "--- Trang 1 ---" not in text


def test_export_document_rejects_bad_params(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, report_pdf(tmp_path / "r.pdf", pages=6))
    with raises(RpcFailure):
        harness.op("export.document", {"format": "pdf", "outputPath": str(tmp_path / "x")}, sid)
    with raises(RpcFailure):
        harness.op("export.document", {"format": "md", "outputPath": "relative.md"}, sid)
    with raises(RpcFailure):
        harness.op(
            "export.document",
            {"format": "md", "outputPath": str(tmp_path / "x.md"), "pages": [99]},
            sid,
        )
    assert not (tmp_path / "x.md").exists()


def test_export_refresh_op_writes_a_pdf(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, report_pdf(tmp_path / "r.pdf", pages=6))
    out = tmp_path / "fresh.pdf"
    data = harness.op(
        "export.refresh",
        {"outputPath": str(out), "options": {"pageSize": "Letter", "fontScale": 1.1}},
        sid,
    )["data"]
    assert out.is_file()
    with pikepdf.open(out) as pdf:
        assert abs(float(pdf.pages[0].MediaBox[2]) - 612) < 1
        assert len(pdf.pages) == data["pages"]


def test_export_rejects_source_and_current_revision_as_destinations(
    harness: Harness, tmp_path: Path
) -> None:
    source = report_pdf(tmp_path / "source.pdf", pages=2)
    original = source.read_bytes()
    sid = _sid(harness, source)
    revision = Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])
    for target in (source, revision):
        before = target.read_bytes()
        for op, params in (
            ("export.refresh", {"outputPath": str(target)}),
            ("export.document", {"format": "txt", "outputPath": str(target)}),
        ):
            with raises(RpcFailure):
                harness.op(op, params, sid)
            assert target.read_bytes() == before
    assert source.read_bytes() == original


def test_export_rejects_hard_link_and_symlink_aliases(
    harness: Harness, tmp_path: Path
) -> None:
    source = report_pdf(tmp_path / "source.pdf", pages=2)
    sid = _sid(harness, source)
    revision = Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])
    hard_link = tmp_path / "source-hardlink.pdf"
    os.link(source, hard_link)
    aliases = [hard_link]
    symlink = tmp_path / "revision-symlink.pdf"
    try:
        symlink.symlink_to(revision)
    except OSError:
        pass  # Symlink creation is unavailable on some Windows configurations.
    else:
        aliases.append(symlink)

    for target in aliases:
        before = target.read_bytes()
        with raises(RpcFailure):
            harness.op("export.refresh", {"outputPath": str(target)}, sid)
        assert target.read_bytes() == before


def test_export_preserves_a_destination_created_after_validation(
    harness: Harness, monkeypatch: Any, tmp_path: Path
) -> None:
    source = report_pdf(tmp_path / "source.pdf", pages=2)
    sid = _sid(harness, source)
    target = tmp_path / "external.md"
    marker = b"created by another actor"
    original_write = export_markdown.write_bytes

    def write_asset_after_creating_external_target(path: Path, data: bytes) -> None:
        if not target.exists():
            target.write_bytes(marker)
        original_write(path, data)

    monkeypatch.setattr(export_markdown, "write_bytes", write_asset_after_creating_external_target)

    with raises(RpcFailure):
        harness.op("export.document", {"format": "md", "outputPath": str(target)}, sid)

    assert target.read_bytes() == marker
    assert not (tmp_path / "external_files").exists()


def test_batch_exports_each_file_and_reports_per_file(harness: Harness, tmp_path: Path) -> None:
    a = report_pdf(tmp_path / "a.pdf", pages=2)
    b = report_pdf(tmp_path / "b.pdf", pages=2)
    missing = tmp_path / "missing.pdf"
    folder = tmp_path / "out"
    folder.mkdir()
    params: dict[str, Any] = {
        "files": [{"path": str(a)}, {"path": str(missing)}, {"path": str(b)}],
        "format": "txt",
        "output": {"mode": "folder", "folder": str(folder)},
    }
    data = harness.op("export.batch", params)["data"]
    statuses = [row["status"] for row in data["files"]]
    assert statuses == ["done", "failed", "done"]
    assert data["files"][1]["errorKind"] == "FILE_NOT_FOUND"
    assert data["summary"] == {"total": 3, "done": 2, "failed": 1, "skipped": 0}
    assert (folder / "a.txt").is_file() and (folder / "b.txt").is_file()
    assert data["files"][0]["outputPath"] == str(folder / "a.txt")


def test_batch_stop_on_error_skips_the_rest(harness: Harness, tmp_path: Path) -> None:
    good = report_pdf(tmp_path / "g.pdf", pages=2)
    params: dict[str, Any] = {
        "files": [{"path": str(tmp_path / "nope.pdf")}, {"path": str(good)}],
        "format": "md",
        "output": {"mode": "suffix"},
        "stopOnError": True,
    }
    data = harness.op("export.batch", params)["data"]
    assert [row["status"] for row in data["files"]] == ["failed", "skipped"]


def test_batch_suffix_names_never_overwrite(harness: Harness, tmp_path: Path) -> None:
    src = report_pdf(tmp_path / "s.pdf", pages=2)
    params: dict[str, Any] = {
        "files": [{"path": str(src)}],
        "format": "html",
        "output": {"mode": "suffix", "suffix": "_web"},
    }
    first = harness.op("export.batch", params)["data"]["files"][0]["outputPath"]
    second = harness.op("export.batch", params)["data"]["files"][0]["outputPath"]
    assert first == str(tmp_path / "s_web.html")
    assert second == str(tmp_path / "s_web (2).html")
    assert (tmp_path / "s_web.html").is_file() and (tmp_path / "s_web (2).html").is_file()


def test_batch_reports_a_password_failure_without_leaking_it(
    harness: Harness, tmp_path: Path
) -> None:
    plain = report_pdf(tmp_path / "p.pdf", pages=2)
    locked = tmp_path / "locked.pdf"
    with pikepdf.open(plain) as pdf:
        pdf.save(
            locked,
            encryption=pikepdf.Encryption(owner="ownerpw-7731", user="userpw-7731"),
        )
    params: dict[str, Any] = {
        "files": [{"path": str(locked)}],
        "format": "txt",
        "output": {"mode": "suffix"},
    }
    data = harness.op("export.batch", params)["data"]
    row = data["files"][0]
    assert row["status"] == "failed"
    assert row["errorKind"] == "PASSWORD_REQUIRED"
    assert "ownerpw-7731" not in str(data) and "userpw-7731" not in str(data)


def test_batch_pdf_format_refreshes_each_file(harness: Harness, tmp_path: Path) -> None:
    src = report_pdf(tmp_path / "x.pdf", pages=2)
    params: dict[str, Any] = {
        "files": [{"path": str(src)}],
        "format": "pdf",
        "output": {"mode": "suffix", "suffix": "_fresh"},
    }
    data = harness.op("export.batch", params)["data"]
    out = Path(data["files"][0]["outputPath"])
    assert out.name == "x_fresh.pdf" and out.is_file()


def test_target_names_follow_the_format_and_folder_rules(tmp_path: Path) -> None:
    reserved: set[str] = set()
    source = tmp_path / "doc.pdf"
    rule = OutputRule(mode="suffix", suffix="_export")
    first = target_for(source, "md", rule, reserved)
    assert first == tmp_path / "doc_export.md"
    (tmp_path / "doc_export_files").mkdir()
    second = target_for(source, "md", rule, set())
    assert second == tmp_path / "doc_export (2).md", "the images folder is taken too"
    folder = tmp_path / "out"
    folder.mkdir()
    folder_rule = OutputRule(mode="folder", folder=folder)
    taken: set[str] = set()
    a = target_for(tmp_path / "a" / "same.pdf", "txt", folder_rule, taken)
    b = target_for(tmp_path / "b" / "same.pdf", "txt", folder_rule, taken)
    assert a == folder / "same.txt" and b == folder / "same (2).txt"
