"""T9.02 / T9.04: workflow.run and batch.run: continue after a failure, stop on error, cancel,
no leftover sessions, secrets never in results or data files, variables, signing, 10 files."""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

import pikepdf
import pytest
from conftest import Harness, RpcFailure, make_numbered_pdf, page_count
from layout_support import report_pdf
from signing_support import PASSWORD_A, validate_pdf_signatures

from chef_core.errors import CancelledError, ChefError
from chef_core.export import markdown as export_markdown
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


@pytest.mark.parametrize("export", [False, True])
def test_workflow_output_name_can_use_first_line(
    harness: Harness, tmp_path: Path, export: bool
) -> None:
    from reportlab.pdfgen import canvas

    source = tmp_path / "input.pdf"
    pdf = canvas.Canvas(str(source))
    pdf.drawString(72, 740, "FIRST LINE")
    pdf.save()
    steps = [{"op": "export.document", "params": {"format": "txt"}}] if export else [ROTATE_FIRST]
    result = harness.op(
        "workflow.run",
        {
            "workflow": flow_json(
                steps,
                output={
                    "mode": "folder",
                    "folder": str(tmp_path / "out"),
                    "nameTemplate": "{ firstline }",
                },
            ),
            "files": [{"path": str(source)}],
        },
    )["data"]
    row = result["results"][0]
    assert row["status"] == "done"
    assert Path(row["outputPath"]).name == ("FIRST LINE.txt" if export else "FIRST LINE.pdf")


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


def _locked_pdf(source: Path, target: Path, password: str) -> Path:
    with pikepdf.open(source) as pdf:
        pdf.save(target, encryption=pikepdf.Encryption(user=password, owner="test-owner"))
    return target


def test_merge_inputs_combines_in_order_and_preserves_encrypted_sources(
    harness: Harness, tmp_path: Path
) -> None:
    first = _locked_pdf(
        make_numbered_pdf(tmp_path / "first-plain.pdf", 2), tmp_path / "first.pdf", "pw-one"
    )
    second = _locked_pdf(
        make_numbered_pdf(tmp_path / "second-plain.pdf", 3), tmp_path / "second.pdf", "pw-two"
    )
    before = [first.read_bytes(), second.read_bytes()]
    flow = flow_json([ROTATE_FIRST], inputs={"mode": "merge", "password": True})
    data = harness.op(
        "workflow.run",
        {
            "workflow": flow,
            "files": [
                {"path": str(first), "password": "pw-one"},
                {"path": str(second), "password": "pw-two"},
            ],
        },
    )["data"]
    assert data["summary"] == {"total": 1, "done": 1, "failed": 0, "skipped": 0}
    row = data["results"][0]
    assert row["status"] == "done"
    assert row["path"] == str(first)
    assert "Đã ghép 2 PDF theo thứ tự đã chọn" in row["message"]
    assert Path(row["outputPath"]).name == "first_da-xu-ly.pdf"
    assert page_count(row["outputPath"]) == 5
    assert [first.read_bytes(), second.read_bytes()] == before


def test_merge_inputs_wrong_password_cleans_private_file_and_keeps_sources(tmp_path: Path) -> None:
    source = _locked_pdf(
        make_numbered_pdf(tmp_path / "plain.pdf", 2), tmp_path / "locked.pdf", "right"
    )
    original = source.read_bytes()
    flow = parsed(flow_json([ROTATE_FIRST], inputs={"mode": "merge"}))
    work = tmp_path / "work"
    with pytest.raises(ChefError):
        run_workflow(
            flow,
            [FileRequest(str(source), "wrong"), FileRequest(str(source), "right")],
            sessions=SessionManager(tmp_path / "sessions"),
            work_dir=work,
        )
    assert source.read_bytes() == original
    assert not list(work.glob("workflow-merged-*.pdf"))


def test_merge_input_warnings_for_signature_and_form_reach_run_report(
    harness: Harness, tmp_path: Path
) -> None:
    first = make_numbered_pdf(tmp_path / "signed.pdf", 1)
    with pikepdf.open(first, allow_overwriting_input=True) as pdf:
        field = pdf.make_indirect(
            pikepdf.Dictionary({"/FT": pikepdf.Name.Sig, "/V": pikepdf.Dictionary()})
        )
        pdf.Root.AcroForm = pikepdf.Dictionary({"/Fields": pikepdf.Array([field])})
        pdf.save(first)
    second = make_numbered_pdf(tmp_path / "plain.pdf", 1)
    data = harness.op(
        "workflow.run",
        {
            "workflow": flow_json([ROTATE_FIRST], inputs={"mode": "merge"}),
            "files": [{"path": str(first)}, {"path": str(second)}],
        },
    )["data"]
    warnings = data["results"][0]["warnings"]
    assert any("chữ ký số không được giữ lại" in warning for warning in warnings)
    assert any("trường biểu mẫu tương tác không được giữ lại" in warning for warning in warnings)


def test_merge_dry_run_says_inputs_and_passwords_were_not_checked(harness: Harness) -> None:
    data = harness.op(
        "workflow.run",
        {
            "workflow": flow_json([ROTATE_FIRST], inputs={"mode": "merge"}),
            "files": [{"path": "C:/first.pdf"}, {"path": "C:/missing.pdf", "password": "hidden"}],
            "dryRun": True,
        },
    )["data"]
    row = data["results"][0]
    assert row["status"] == "skipped"
    assert "chưa mở/kiểm tra các PDF đầu vào hoặc mật khẩu" in row["message"]
    assert row["plannedOutputPath"].endswith("first_da-xu-ly.pdf")


def test_merge_inputs_cancellation_cleans_private_file_and_session(tmp_path: Path) -> None:
    files = pdfs(tmp_path / "in", [2, 2])
    flow = parsed(flow_json([ROTATE_FIRST], inputs={"mode": "merge"}))
    sessions = SessionManager(tmp_path / "sessions")
    calls = {"count": 0}

    def cancel_during_merge() -> None:
        calls["count"] += 1
        if calls["count"] >= 4:
            raise CancelledError()

    work = tmp_path / "work"
    with pytest.raises(CancelledError):
        run_workflow(
            flow,
            [FileRequest(str(p)) for p in files],
            sessions=sessions,
            work_dir=work,
            check_cancel=cancel_during_merge,
        )
    assert sessions.all() == []
    assert not list(work.glob("workflow-merged-*.pdf"))


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


def test_dry_run_reports_overwrite_target(harness: Harness, tmp_path: Path) -> None:
    source = make_numbered_pdf(tmp_path / "source.pdf", 2)
    original = source.read_bytes()
    row = harness.op(
        "workflow.run",
        {
            "workflow": flow_json([ROTATE_FIRST], output={"mode": "overwrite"}),
            "files": [{"path": str(source)}],
            "dryRun": True,
        },
    )["data"]["results"][0]
    assert row["plannedOutputPath"] == str(source)
    assert source.read_bytes() == original


@pytest.mark.parametrize(
    ("op_id", "params", "suffix"),
    [
        ("export.document", {"format": "md"}, ".md"),
        ("export.refresh", {}, ".pdf"),
    ],
)
def test_workflow_export_is_final_and_never_overwrites(
    harness: Harness, tmp_path: Path, op_id: str, params: dict[str, Any], suffix: str
) -> None:
    source = make_numbered_pdf(tmp_path / "source.pdf", 2)
    requested = tmp_path / f"result{suffix}"
    export_params = {**params, "outputPath": str(requested)}
    body = {
        "workflow": flow_json([{"op": op_id, "params": export_params}]),
        "files": [{"path": str(source)}],
    }

    first = harness.op("workflow.run", body)["data"]["results"][0]
    second = harness.op("workflow.run", body)["data"]["results"][0]

    assert first["status"] == second["status"] == "done"
    assert first["outputPath"] == str(requested)
    assert second["outputPath"] == str(requested.with_name(f"result (2){suffix}"))
    assert first["outputs"] == [str(requested)]
    assert second["outputs"] == [str(requested.with_name(f"result (2){suffix}"))]
    assert source.is_file()
    assert Path(first["outputPath"]).is_file()
    assert Path(second["outputPath"]).is_file()


def test_workflow_export_dry_run_reports_its_target_without_writing(
    harness: Harness, tmp_path: Path
) -> None:
    source = make_numbered_pdf(tmp_path / "source.pdf", 2)
    requested = tmp_path / "planned.md"
    data = harness.op(
        "workflow.run",
        {
            "workflow": flow_json(
                [
                    {
                        "op": "export.document",
                        "params": {"format": "md", "outputPath": str(requested)},
                    }
                ]
            ),
            "files": [{"path": str(source)}],
            "dryRun": True,
        },
    )["data"]

    assert data["results"][0]["plannedOutputPath"] == str(requested)
    assert data["results"][0]["plannedOutputs"] == [str(requested)]
    assert not requested.exists()
    assert source.is_file()


def test_workflow_derives_multiple_export_names_and_also_saves_pdf(
    harness: Harness, tmp_path: Path
) -> None:
    source = make_numbered_pdf(tmp_path / "source.pdf", 2)
    out = tmp_path / "exports"
    body = {
        "workflow": flow_json(
            [
                {"op": "export.document", "params": {"format": "md"}},
                {"op": "export.document", "params": {"format": "txt"}},
            ],
            output={
                "mode": "folder",
                "folder": str(out),
                "nameTemplate": "Bao-cao-{seq:2}",
                "alsoSavePdf": True,
            },
        ),
        "files": [{"path": str(source)}],
    }

    row = harness.op("workflow.run", body)["data"]["results"][0]

    assert row["status"] == "done"
    assert [Path(p).name for p in row["outputs"]] == [
        "Bao-cao-01.md",
        "Bao-cao-01.txt",
        "Bao-cao-01.pdf",
    ]
    assert row["outputPath"] == row["outputs"][-1]
    assert all(Path(p).is_file() for p in row["outputs"])


def test_workflow_export_uses_suffix_and_format_extension_by_default(
    harness: Harness, tmp_path: Path
) -> None:
    source = make_numbered_pdf(tmp_path / "source.pdf", 2)
    row = harness.op(
        "workflow.run",
        {
            "workflow": flow_json(
                [{"op": "export.document", "params": {"format": "html"}}],
                output={"mode": "suffix", "suffix": "_converted"},
            ),
            "files": [{"path": str(source)}],
        },
    )["data"]["results"][0]

    assert Path(row["outputPath"]).name == "source_converted.html"
    assert Path(row["outputPath"]).is_file()
    assert row["outputs"] == [row["outputPath"]]


def test_workflow_without_exports_keeps_overwrite_output_mode(
    harness: Harness, tmp_path: Path
) -> None:
    source = make_numbered_pdf(tmp_path / "source.pdf", 2)
    row = harness.op(
        "workflow.run",
        {
            "workflow": flow_json([ROTATE_FIRST], output={"mode": "overwrite"}),
            "files": [{"path": str(source)}],
        },
    )["data"]["results"][0]

    assert row["status"] == "done"
    assert row["outputPath"] == str(source)
    assert row["outputs"] == [str(source)]


def test_skipped_export_falls_back_to_pdf_output(harness: Harness, tmp_path: Path) -> None:
    source = make_numbered_pdf(tmp_path / "source.pdf", 2)
    missing_dir = tmp_path / "missing" / "out.txt"
    row = harness.op(
        "workflow.run",
        {
            "workflow": flow_json(
                [
                    {
                        "op": "export.document",
                        "params": {
                            "format": "txt",
                            "outputPath": str(missing_dir),
                            "pages": [99],
                        },
                        "onError": "skip",
                    }
                ]
            ),
            "files": [{"path": str(source)}],
        },
    )["data"]["results"][0]

    assert row["status"] == "done"
    assert len(row["outputs"]) == 1
    assert row["outputPath"] == row["outputs"][0]
    assert row["outputPath"].endswith("_da-xu-ly.pdf")
    assert Path(row["outputPath"]).is_file()


@pytest.mark.parametrize("dry_run", [False, True])
def test_export_output_path_cannot_use_secret_placeholder(
    harness: Harness, tmp_path: Path, dry_run: bool
) -> None:
    source = make_numbered_pdf(tmp_path / "source.pdf", 1)
    secret_path = str(tmp_path / f"{SECRET}.txt")
    result = harness.op(
        "workflow.run",
        {
            "workflow": flow_json(
                [
                    {
                        "op": "export.document",
                        "params": {"format": "txt", "outputPath": "{{secret:destination}}"},
                    }
                ]
            ),
            "files": [{"path": str(source)}],
            "secrets": {"destination": secret_path},
            "dryRun": dry_run,
        },
    )["data"]["results"][0]
    serialized = json.dumps(result, ensure_ascii=False)
    assert SECRET not in serialized
    assert secret_path not in serialized
    assert not Path(secret_path).exists()
    assert result["status"] != "done"


def test_cancel_after_export_render_removes_its_outputs(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    source = report_pdf(tmp_path / "source.pdf", pages=2)
    target = tmp_path / "cancelled.md"
    flow = parsed(
        flow_json(
            [{"op": "export.document", "params": {"format": "md", "outputPath": str(target)}}]
        )
    )
    cancelled = threading.Event()
    written_assets: list[Path] = []
    external_marker = tmp_path / "cancelled_files" / "keep.txt"
    original = export_markdown.write_bytes

    def write_asset_then_cancel(path: Path, data: bytes) -> None:
        original(path, data)
        written_assets.append(path)
        if len(written_assets) == 1:
            external_marker.write_text("created by another actor", encoding="utf-8")
            cancelled.set()

    monkeypatch.setattr(export_markdown, "write_bytes", write_asset_then_cancel)

    def check_cancel() -> None:
        if cancelled.is_set():
            raise CancelledError()

    sessions = SessionManager(tmp_path / "wfdata")
    with pytest.raises(CancelledError):
        run_workflow(
            flow,
            [FileRequest(str(source))],
            sessions=sessions,
            work_dir=tmp_path / "work",
            check_cancel=check_cancel,
        )

    assert not target.exists()
    assert written_assets
    assert all(not path.exists() for path in written_assets)
    assert external_marker.read_text(encoding="utf-8") == "created by another actor"
    assert sessions.all() == []


def test_workflow_export_names_do_not_collide_between_files_or_assets(
    harness: Harness, tmp_path: Path
) -> None:
    inputs = pdfs(tmp_path / "in", [2, 2])
    out = tmp_path / "out"
    out.mkdir()
    (out / "Duy-nhat_files").mkdir()
    body = {
        "workflow": flow_json(
            [{"op": "export.document", "params": {"format": "md"}}],
            output={"mode": "folder", "folder": str(out), "nameTemplate": "Duy-nhat"},
        ),
        "files": [{"path": str(p)} for p in inputs],
    }

    rows = harness.op("workflow.run", body)["data"]["results"]

    assert [Path(row["outputPath"]).name for row in rows] == ["Duy-nhat (2).md", "Duy-nhat (3).md"]
    assert len({path for row in rows for path in row["outputs"]}) == 2
    assert (out / "Duy-nhat_files").is_dir()


def test_workflow_dry_run_plans_every_export_and_optional_pdf(
    harness: Harness, tmp_path: Path
) -> None:
    source = make_numbered_pdf(tmp_path / "source.pdf", 2)
    out = tmp_path / "not-created"
    body = {
        "workflow": flow_json(
            [
                {"op": "export.document", "params": {"format": "md"}},
                {"op": "export.refresh", "params": {}},
            ],
            output={"mode": "folder", "folder": str(out), "alsoSavePdf": True},
        ),
        "files": [{"path": str(source)}],
        "dryRun": True,
    }

    row = harness.op("workflow.run", body)["data"]["results"][0]

    assert [Path(p).name for p in row["plannedOutputs"]] == [
        "source.md",
        "source.pdf",
        "source (2).pdf",
    ]
    assert row["plannedOutputPath"] == row["plannedOutputs"][0]
    assert not out.exists()


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
