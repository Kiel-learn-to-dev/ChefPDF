"""T9.06 / T9.05 through the RPC harness: naming.preview, naming.apply, files.renameBatch (dry run,
collisions, swap, undo) and watch.scan / watch.markDone with a real folder and ledger."""

from __future__ import annotations

from pathlib import Path

import pytest
from conftest import Harness, RpcFailure, make_numbered_pdf

from chef_core.ops import load_builtin_ops

load_builtin_ops()


def _make(folder: Path, names: list[str]) -> list[Path]:
    folder.mkdir(parents=True, exist_ok=True)
    return [make_numbered_pdf(folder / name, 2) for name in names]


def test_preview_shows_names_and_touches_nothing(harness: Harness, tmp_path: Path) -> None:
    files = _make(tmp_path / "d", ["a.pdf", "b.pdf"])
    data = harness.op(
        "naming.preview",
        {"files": [str(p) for p in files], "template": "Hồ sơ_{seq:2}_{name}"},
    )["data"]
    assert data["dryRun"] is True
    targets = [Path(item["to"]).name for item in data["items"]]
    assert targets == ["Hồ sơ_01_a.pdf", "Hồ sơ_02_b.pdf"]
    assert all(p.exists() for p in files)


def test_first_line_token_reads_pdf_text_and_falls_back_for_a_blank_page(
    harness: Harness, tmp_path: Path
) -> None:
    from reportlab.pdfgen import canvas

    readable = tmp_path / "readable.pdf"
    c = canvas.Canvas(str(readable))
    c.drawString(72, 740, "HOP DONG 2026")
    c.drawString(72, 710, "Second line")
    c.save()
    blank = make_numbered_pdf(tmp_path / "blank.pdf", 1)
    result = harness.op(
        "naming.preview", {"files": [str(readable), str(blank)], "template": "{firstline}"}
    )["data"]
    assert [Path(row["to"]).name for row in result["items"]] == ["HOP DONG 2026.pdf", "blank.pdf"]


def test_first_line_token_keeps_vietnamese_characters(harness: Harness, tmp_path: Path) -> None:
    from layout_support import report_pdf

    source = report_pdf(tmp_path / "document.pdf", pages=2)
    result = harness.op("naming.preview", {"files": [str(source)], "template": "{firstline}"})[
        "data"
    ]
    assert Path(result["items"][0]["to"]).name.startswith("Báo cáo thường niên")


def test_apply_renames_and_the_mapping_undoes_it(harness: Harness, tmp_path: Path) -> None:
    files = _make(tmp_path / "d", ["x.pdf", "y.pdf"])
    applied = harness.op(
        "files.renameBatch",
        {"files": [str(p) for p in files], "template": "{name}_{date}", "dryRun": False},
    )["data"]
    assert [i["status"] for i in applied["items"]] == ["done", "done"]
    new_paths = [Path(i["to"]) for i in applied["items"]]
    assert all(p.exists() for p in new_paths) and not any(p.exists() for p in files)
    undone = harness.op(
        "files.renameBatch", {"mapping": applied["undo"]["mapping"], "dryRun": False}
    )["data"]
    assert [i["status"] for i in undone["items"]] == ["done", "done"]
    assert all(p.exists() for p in files)


def test_collisions_get_suffixes_and_skip_policy_leaves_them(
    harness: Harness, tmp_path: Path
) -> None:
    files = _make(tmp_path / "d", ["one.pdf", "two.pdf", "three.pdf"])
    data = harness.op(
        "naming.preview",
        {"files": [str(p) for p in files], "template": "Giống"},
    )["data"]
    assert [Path(i["to"]).name for i in data["items"]] == [
        "Giống.pdf",
        "Giống (2).pdf",
        "Giống (3).pdf",
    ]
    (tmp_path / "d" / "Giống.pdf").write_bytes(b"taken")
    skipped = harness.op(
        "naming.preview",
        {"files": [str(p) for p in files], "template": "Giống", "conflict": "skip"},
    )["data"]
    assert [i["status"] for i in skipped["items"]] == ["skipped", "skipped", "skipped"]
    assert len(skipped["collisions"]) == 3


def test_swap_of_two_names_works_with_a_mapping(harness: Harness, tmp_path: Path) -> None:
    folder = tmp_path / "d"
    a, b = _make(folder, ["a.pdf", "b.pdf"])
    body = {
        "mapping": [
            {"source": str(a), "target": str(b)},
            {"source": str(b), "target": str(a)},
        ],
        "dryRun": False,
    }
    data = harness.op("files.renameBatch", body)["data"]
    assert [i["status"] for i in data["items"]] == ["done", "done"]
    assert a.exists() and b.exists()
    assert a.stat().st_size > 0


def test_overwrite_policy_replaces_an_existing_file(harness: Harness, tmp_path: Path) -> None:
    folder = tmp_path / "d"
    (src,) = _make(folder, ["old.pdf"])
    (folder / "Đích.pdf").write_bytes(b"to be replaced")
    data = harness.op(
        "naming.apply",
        {"files": [str(src)], "template": "Đích", "conflict": "overwrite"},
    )["data"]
    assert [i["status"] for i in data["items"]] == ["done"]
    assert not src.exists()
    assert (folder / "Đích.pdf").stat().st_size > 20  # the PDF that was renamed, not the old bytes


def test_invalid_templates_and_missing_files_are_refused(harness: Harness, tmp_path: Path) -> None:
    files = _make(tmp_path / "d", ["a.pdf"])
    try:
        harness.op("naming.preview", {"files": [str(files[0])], "template": "{name}_{bogus}"})
        raise AssertionError("an unknown token must be refused")
    except RpcFailure as exc:
        assert exc.kind == "INVALID_PARAMS"
    try:
        harness.op("naming.preview", {"files": [str(tmp_path / "none.pdf")], "template": "x"})
        raise AssertionError("a missing file must be refused")
    except RpcFailure as exc:
        assert exc.kind == "FILE_NOT_FOUND"


def test_watch_scan_and_mark_done_over_rpc(harness: Harness, tmp_path: Path) -> None:
    watched = tmp_path / "inbox"
    watched.mkdir()
    ledger = tmp_path / "state" / "processed.json"
    make_numbered_pdf(watched / "scan1.pdf", 1)
    first = harness.op(
        "watch.scan",
        {"directory": str(watched), "ledgerPath": str(ledger), "settleSeconds": 0},
    )["data"]
    assert [Path(f["path"]).name for f in first["ready"]] == ["scan1.pdf"]
    again = harness.op(
        "watch.scan",
        {"directory": str(watched), "ledgerPath": str(ledger), "settleSeconds": 0},
    )["data"]
    assert again["ready"] == []  # queued, not handed out twice
    out = watched / "scan1_da-xu-ly.pdf"
    make_numbered_pdf(out, 1)
    harness.op(
        "watch.markDone",
        {
            "ledgerPath": str(ledger),
            "path": str(watched / "scan1.pdf"),
            "outputPath": str(out),
            "status": "done",
        },
    )
    after = harness.op(
        "watch.scan",
        {"directory": str(watched), "ledgerPath": str(ledger), "settleSeconds": 0},
    )["data"]
    assert after["ready"] == []  # processed, and its output is never picked up


def test_watch_scan_rejects_resolved_source_output_alias(harness: Harness, tmp_path: Path) -> None:
    from chef_core.errors import INVALID_PARAMS_CODE

    watched = tmp_path / "inbox"
    watched.mkdir()
    alias = tmp_path / "output-alias"
    try:
        alias.symlink_to(watched, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"directory symlinks unavailable: {exc}")
    try:
        harness.op(
            "watch.scan",
            {
                "directory": str(watched),
                "outputDirectory": str(alias),
                "ledgerPath": str(tmp_path / "state.json"),
            },
        )
        raise AssertionError("resolved aliases of the source folder must be rejected")
    except RpcFailure as exc:
        assert exc.code == INVALID_PARAMS_CODE


def test_watch_release_allows_unprocessed_batch_items_to_be_scanned_again(
    harness: Harness, tmp_path: Path
) -> None:
    watched = tmp_path / "inbox"
    watched.mkdir()
    ledger = tmp_path / "state.json"
    make_numbered_pdf(watched / "a.pdf", 1)
    make_numbered_pdf(watched / "b.pdf", 1)
    ready = harness.op(
        "watch.scan", {"directory": str(watched), "ledgerPath": str(ledger), "settleSeconds": 0}
    )["data"]["ready"]
    assert len(ready) == 2
    harness.op(
        "watch.markDone",
        {"ledgerPath": str(ledger), "path": ready[0]["path"], "status": "done"},
    )
    released = harness.op(
        "watch.release",
        {"ledgerPath": str(ledger), "paths": [item["path"] for item in ready]},
    )["data"]
    assert released["released"] == 1
    again = harness.op(
        "watch.scan", {"directory": str(watched), "ledgerPath": str(ledger), "settleSeconds": 0}
    )["data"]["ready"]
    assert [Path(item["path"]).name for item in again] == ["b.pdf"]
