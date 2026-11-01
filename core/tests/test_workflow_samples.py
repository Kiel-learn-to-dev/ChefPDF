"""T9.07: the built-in sample workflows validate, and the ones without signing run end to end."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pikepdf
from conftest import Harness, make_numbered_pdf, page_count
from PIL import Image
from signing_support import PASSWORD_A, validate_pdf_signatures

from chef_core.ops import load_builtin_ops
from chef_core.workflow.model import validate_workflow
from chef_core.workflow.samples import load_samples

load_builtin_ops()

SECRET = "SAMPLE-SECRET-7319"
IDS = ["nop-ho-so-online", "phat-hanh-van-ban", "chup-sach", "gui-ban-sao-gon"]


def sample(flow_id: str) -> dict[str, Any]:
    for flow in load_samples():
        if flow.id == flow_id:
            return flow.model_dump(by_alias=True, mode="json")
    raise AssertionError(f"no sample {flow_id}")


def test_four_samples_exist_and_validate_structurally() -> None:
    samples = load_samples()
    assert [s.id for s in samples] == IDS
    for flow in samples:
        report = validate_workflow(flow)
        assert report.valid, [e.message for e in report.errors]
        assert report.steps and all(step.description for step in report.steps)


def test_samples_declare_their_secrets_and_variables() -> None:
    by_id = {s.id: validate_workflow(s) for s in load_samples()}
    assert by_id["nop-ho-so-online"].required_secrets == ["password"]
    assert by_id["nop-ho-so-online"].required_variables == ["pfxPath"]
    assert by_id["phat-hanh-van-ban"].required_variables == ["pfxPath", "seamPath"]
    assert by_id["chup-sach"].required_secrets == []
    assert by_id["gui-ban-sao-gon"].required_secrets == ["password"]


def test_chup_sach_runs_end_to_end(harness: Harness, tmp_path: Path) -> None:
    folder = tmp_path / "scan"
    folder.mkdir()
    files = [make_numbered_pdf(folder / f"p{i}.pdf", 2) for i in range(2)]
    data = harness.op(
        "workflow.run",
        {"workflow": sample("chup-sach"), "files": [{"path": str(p)} for p in files]},
    )["data"]
    assert [r["status"] for r in data["results"]] == ["done", "done"], data["results"]
    for row in data["results"]:
        assert Path(row["outputPath"]).name == Path(row["path"]).stem + "_sach.pdf"
        assert page_count(row["outputPath"]) == 2


def test_gui_ban_sao_gon_runs_with_its_secret(harness: Harness, tmp_path: Path) -> None:
    folder = tmp_path / "in"
    folder.mkdir()
    src = make_numbered_pdf(folder / "hoso.pdf", 3)
    out = tmp_path / "out"
    out.mkdir()
    data = harness.op(
        "workflow.run",
        {
            "workflow": sample("gui-ban-sao-gon"),
            "files": [{"path": str(src)}],
            "secrets": {"password": SECRET},
            "output": {"mode": "folder", "folder": str(out)},
        },
    )["data"]
    row = data["results"][0]
    assert row["status"] == "done", row
    assert SECRET not in json.dumps(data)
    with pikepdf.open(row["outputPath"], password=SECRET) as opened:
        assert len(opened.pages) == 3


def test_nop_ho_so_online_compresses_numbers_and_signs(
    harness: Harness, pki: Any, tmp_path: Path
) -> None:
    folder = tmp_path / "ho-so"
    folder.mkdir()
    files = [make_numbered_pdf(folder / f"hs{i}.pdf", 2) for i in range(3)]
    data = harness.op(
        "workflow.run",
        {
            "workflow": sample("nop-ho-so-online"),
            "files": [{"path": str(p)} for p in files],
            "variables": {"pfxPath": str(pki.pfx_a())},
            "secrets": {"password": PASSWORD_A},
        },
    )["data"]
    assert [r["status"] for r in data["results"]] == ["done"] * 3, data["results"]
    for row in data["results"]:
        out = Path(row["outputPath"])
        assert out.stat().st_size <= 2 * 1024 * 1024
        assert [s["op"] for s in row["stepResults"]] == [
            "compress.fitSize",
            "overlay.pageNumbers",
            "sign.pades",
        ]
        assert validate_pdf_signatures(out, pki.root.cert).signatures[0].valid
    assert PASSWORD_A not in json.dumps(data)


def test_phat_hanh_van_ban_stamps_then_signs(harness: Harness, pki: Any, tmp_path: Path) -> None:
    folder = tmp_path / "vb"
    folder.mkdir()
    src = make_numbered_pdf(folder / "vb.pdf", 3)
    seal = tmp_path / "seal.png"
    Image.new("RGB", (120, 60), (200, 30, 30)).save(seal)
    data = harness.op(
        "workflow.run",
        {
            "workflow": sample("phat-hanh-van-ban"),
            "files": [{"path": str(src)}],
            "variables": {"pfxPath": str(pki.pfx_a()), "seamPath": str(seal)},
            "secrets": {"password": PASSWORD_A},
        },
    )["data"]
    row = data["results"][0]
    assert row["status"] == "done", row
    assert [s["op"] for s in row["stepResults"]] == [
        "overlay.pageNumbers",
        "stamp.seam",
        "sign.pades",
    ]
    assert validate_pdf_signatures(Path(row["outputPath"]), pki.root.cert).signatures[0].valid
