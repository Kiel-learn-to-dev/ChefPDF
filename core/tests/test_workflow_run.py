"""T9.02 / T9.04: workflow.run and batch.run: continue after a failure, stop on error, cancel,
no leftover sessions, secrets never in results or data files, variables, signing, 10 files."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pikepdf
import pytest
from conftest import Harness, RpcFailure, make_numbered_pdf, page_count
from signing_support import PASSWORD_A, validate_pdf_signatures

from chef_core.errors import CancelledError
from chef_core.ops import load_builtin_ops
from chef_core.session.manager import SessionManager
from chef_core.workflow.model import Workflow, parse_workflow
from chef_core.workflow.runner import FileRequest, run_workflow

load_builtin_ops()

SECRET = "SECRET-PW-LEAK-4411"
ROTATE_FIRST = {"op": "page.rotate", "params": {"pages": [0], "angle": 90}}


def flow_json(steps: list[dict[str, Any]], **extra: Any) -> dict[str, Any]:
    return {"id": "run-test", "name": "Chạy thử", "steps": steps, **extra}


def parsed(data: dict[str, Any]) -> Workflow:
    flow, issues = parse_workflow(data)
    assert flow is not None, issues
    return flow


def pdfs(folder: Path, counts: list[int]) -> list[Path]:
    folder.mkdir(parents=True, exist_ok=True)
    return [make_numbered_pdf(folder / f"doc{i}.pdf", n) for i, n in enumerate(counts)]


def test_five_files_one_fails_midway_and_the_rest_go_on(harness: Harness, tmp_path: Path) -> None:
    files = pdfs(tmp_path / "in", [3, 3, 2, 3, 3])  # the third file has no page 2
    steps = [
        ROTATE_FIRST,
        {"op": "page.rotate", "params": {"pages": [2], "angle": 90}},
        {"op": "overlay.pageNumbers", "params": {}},
    ]
    body = {"workflow": flow_json(steps), "files": [{"path": str(p)} for p in files]}
    data = harness.op("workflow.run", body)["data"]
    assert [r["status"] for r in data["results"]] == ["done", "done", "failed", "done", "done"]
    bad = data["results"][2]
    assert bad["failedStep"] == 1
    assert bad["errorKind"] is not None and bad["message"]
    assert data["summary"] == {"total": 5, "done": 4, "failed": 1, "skipped": 0}
    for row in data["results"]:
        if row["status"] == "done":
            assert Path(row["outputPath"]).name == Path(row["path"]).stem + "_da-xu-ly.pdf"
            assert page_count(row["outputPath"]) in (2, 3)
    assert data["results"][0]["stepResults"][0]["op"] == "page.rotate"


def test_stop_on_error_skips_the_rest(harness: Harness, tmp_path: Path) -> None:
    files = pdfs(tmp_path / "in", [3, 2, 3])
    steps = [ROTATE_FIRST, {"op": "page.rotate", "params": {"pages": [2], "angle": 90}}]
    body = {
        "workflow": flow_json(steps),
        "files": [{"path": str(p)} for p in files],
        "stopOnError": True,
    }
    data = harness.op("workflow.run", body)["data"]
    assert [r["status"] for r in data["results"]] == ["done", "failed", "skipped"]


def test_invalid_workflow_is_refused_with_every_error(harness: Harness, tmp_path: Path) -> None:
    files = pdfs(tmp_path / "in", [2])
    body = {
        "workflow": flow_json([{"op": "page.rotate", "params": {"angle": 45}}, {"op": "bogus.op"}]),
        "files": [{"path": str(files[0])}],
    }
    with pytest.raises(RpcFailure) as info:
        harness.op("workflow.run", body)
    assert info.value.kind == "INVALID_PARAMS"
    assert len(info.value.detail["errors"]) >= 3


def test_cancel_is_honoured_and_no_session_is_left(tmp_path: Path) -> None:
    files = pdfs(tmp_path / "in", [2, 2, 2, 2])
    flow = parsed(flow_json([ROTATE_FIRST, {"op": "overlay.pageNumbers", "params": {}}]))
    sessions = SessionManager(tmp_path / "wfdata")
    calls = {"n": 0}

    def cancel_after_three() -> None:
        calls["n"] += 1
        if calls["n"] > 3:
            raise CancelledError()

    with pytest.raises(CancelledError):
        run_workflow(
            flow,
            [FileRequest(str(p), None) for p in files],
            sessions=sessions,
            work_dir=tmp_path / "work",
            check_cancel=cancel_after_three,
        )
    assert sessions.all() == []
    assert list(sessions.sessions_dir.iterdir()) == []


def test_full_run_leaves_no_session_behind(tmp_path: Path) -> None:
    files = pdfs(tmp_path / "in", [2, 2])
    flow = parsed(flow_json([ROTATE_FIRST]))
    sessions = SessionManager(tmp_path / "wfdata")
    report = run_workflow(
        flow,
        [FileRequest(str(p), None) for p in files],
        sessions=sessions,
        work_dir=tmp_path / "work",
    )
    assert report["summary"]["done"] == 2
    assert sessions.all() == []
    assert list(sessions.sessions_dir.iterdir()) == []


def test_secrets_never_reach_results_or_data_files(harness: Harness, tmp_path: Path) -> None:
    files = pdfs(tmp_path / "in", [2])
    out = tmp_path / "out"
    out.mkdir()
    body = {
        "workflow": flow_json(
            [{"op": "security.encrypt", "params": {"userPassword": "{{secret:pw}}"}}],
            output={"mode": "folder", "folder": str(out)},
        ),
        "files": [{"path": str(files[0])}],
        "secrets": {"pw": SECRET},
    }
    data = harness.op("workflow.run", body)["data"]
    assert data["results"][0]["status"] == "done"
    blob = json.dumps(data, ensure_ascii=False)
    assert SECRET not in blob
    for path in list(harness.data_dir.rglob("*")) + list(out.rglob("*")):
        if path.is_file():
            assert SECRET.encode() not in path.read_bytes(), path
    target = out / "doc0.pdf"
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(target)
    with pikepdf.open(target, password=SECRET) as opened:
        assert len(opened.pages) == 2


def test_missing_secret_is_refused_before_any_file_opens(harness: Harness, tmp_path: Path) -> None:
    files = pdfs(tmp_path / "in", [2])
    body = {
        "workflow": flow_json(
            [{"op": "security.encrypt", "params": {"userPassword": "{{secret:pw}}"}}]
        ),
        "files": [{"path": str(files[0])}],
    }
    with pytest.raises(RpcFailure) as info:
        harness.op("workflow.run", body)
    assert info.value.kind == "INVALID_PARAMS"
    assert "pw" in info.value.error["message"]


def test_variables_are_expanded_per_file(harness: Harness, tmp_path: Path) -> None:
    files = pdfs(tmp_path / "in", [2])
    out = tmp_path / "out"
    out.mkdir()
    body = {
        "workflow": flow_json(
            [{"op": "security.encrypt", "params": {"userPassword": "{{ten}}-{{name}}"}}],
            variables={"ten": "HS"},
            output={"mode": "folder", "folder": str(out)},
        ),
        "files": [{"path": str(files[0])}],
    }
    data = harness.op("workflow.run", body)["data"]
    assert data["results"][0]["status"] == "done"
    with pikepdf.open(out / "doc0.pdf", password="HS-doc0") as opened:
        assert len(opened.pages) == 2


def test_name_template_gives_distinct_names(harness: Harness, tmp_path: Path) -> None:
    files = pdfs(tmp_path / "in", [2, 2])
    out = tmp_path / "out"
    out.mkdir()
    body = {
        "workflow": flow_json(
            [ROTATE_FIRST],
            output={"mode": "folder", "folder": str(out), "nameTemplate": "Ban_{seq:2}"},
        ),
        "files": [{"path": str(files[0])}, {"path": str(files[1])}],
    }
    data = harness.op("workflow.run", body)["data"]
    names = sorted(Path(r["outputPath"]).name for r in data["results"])
    assert names == ["Ban_01.pdf", "Ban_02.pdf"]


def test_dry_run_writes_nothing(harness: Harness, tmp_path: Path) -> None:
    files = pdfs(tmp_path / "in", [2])
    body = {
        "workflow": flow_json([ROTATE_FIRST]),
        "files": [{"path": str(files[0])}],
        "dryRun": True,
    }
    data = harness.op("workflow.run", body)["data"]
    assert data["dryRun"] is True
    assert data["results"][0]["status"] == "skipped"
    assert data["results"][0]["plannedOutputPath"].endswith("doc0_da-xu-ly.pdf")
    assert not (tmp_path / "in" / "doc0_da-xu-ly.pdf").exists()


def test_signing_three_files_with_a_pfx_workflow(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    files = pdfs(tmp_path / "in", [2, 2, 2])
    out = tmp_path / "signed"
    out.mkdir()
    body = {
        "workflow": flow_json(
            [
                {
                    "op": "sign.pades",
                    "params": {"pfxPath": "{{pfx}}", "password": "{{secret:password}}"},
                }
            ],
            output={"mode": "folder", "folder": str(out)},
        ),
        "files": [{"path": str(p)} for p in files],
        "variables": {"pfx": str(pki.pfx_a())},
        "secrets": {"password": PASSWORD_A},
    }
    data = harness.op("workflow.run", body)["data"]
    assert [r["status"] for r in data["results"]] == ["done"] * 3
    for row in data["results"]:
        assert validate_pdf_signatures(Path(row["outputPath"]), pki.root.cert).signatures[0].valid
    assert PASSWORD_A not in json.dumps(data)


def test_batch_run_ten_files_in_parallel(harness: Harness, tmp_path: Path) -> None:
    files = pdfs(tmp_path / "in", [2] * 10)
    out = tmp_path / "out"
    out.mkdir()
    body = {
        "opId": "page.rotate",
        "params": {"pages": [0], "angle": 90},
        "files": [{"path": str(p)} for p in files],
        "output": {"mode": "folder", "folder": str(out)},
        "parallel": 3,
    }
    data = harness.op("batch.run", body)["data"]
    assert data["summary"]["done"] == 10
    assert len(list(out.glob("*.pdf"))) == 10


def test_batch_refuses_ops_that_are_not_batchable(harness: Harness, tmp_path: Path) -> None:
    files = pdfs(tmp_path / "in", [2])
    body = {"opId": "content.delete", "params": {}, "files": [{"path": str(files[0])}]}
    with pytest.raises(RpcFailure) as info:
        harness.op("batch.run", body)
    assert info.value.kind == "INVALID_PARAMS"
