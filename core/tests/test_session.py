"""Sessions: open/create/close, info (B7), undo/redo, save, encryption (B6), errors."""

from __future__ import annotations

import base64
import json
from collections.abc import Callable
from pathlib import Path

import pikepdf
import pytest
from conftest import Harness, RpcFailure, page_widths

from chef_core.session import manager as session_manager
from chef_core.session.info import pdf_date_to_iso


def _state(h: Harness, sid: str) -> dict[str, object]:
    result: dict[str, object] = h.call("session.state", {"sessionId": sid})
    return result


def _session_dir(h: Harness, sid: str) -> Path:
    return h.data_dir / "sessions" / sid


def test_open_creates_working_copy(harness: Harness, numbered: Callable[[int], Path]) -> None:
    src = numbered(3)
    opened = harness.open(src)
    state = opened["state"]
    sid = state["sessionId"]
    assert state == {
        "sessionId": sid,
        "sourcePath": str(src),
        "revisionPath": str(_session_dir(harness, sid) / "rev-0000.pdf"),
        "revision": 0,
        "canUndo": False,
        "canRedo": False,
        "dirty": False,
        "signed": False,
    }
    assert Path(state["revisionPath"]).read_bytes() == src.read_bytes()
    meta = json.loads((_session_dir(harness, sid) / "meta.json").read_text())
    assert meta["sourcePath"] == str(src) and meta["revision"] == 0 and "openedAt" in meta
    assert (_session_dir(harness, sid) / "journal.jsonl").read_text() == ""
    info = opened["info"]
    assert info["pageCount"] == 3 and info["fileSize"] == src.stat().st_size
    assert info == harness.call("session.info", {"sessionId": sid})


def test_info(harness: Harness, corpus: dict[str, Path]) -> None:
    info = harness.open(corpus["vietnamese_text.pdf"])["info"]
    assert info["pageCount"] == 3
    assert info["pdfVersion"] == "1.3"
    assert info["encrypted"] is False
    assert info["hasSignatures"] is False
    assert info["metadata"]["Title"] == "Nghị định bảo vệ dữ liệu cá nhân"
    assert info["metadata"]["Author"] == "Chef PDF – bộ mẫu thử"
    assert info["metadata"]["CreationDate"].startswith("2000-01-01T00:00:00")
    assert {"name": "BeVietnamPro-Regular", "embedded": True, "subset": True} in info["fonts"]
    assert {"name": "Helvetica", "embedded": False, "subset": False} in info["fonts"]

    info = harness.open(corpus["mixed_sizes.pdf"])["info"]
    assert [(p["width"], p["height"], p["rotation"]) for p in info["pages"]] == [
        (595.276, 841.89, 0),
        (841.89, 595.276, 0),
        (612.0, 792.0, 0),
        (595.276, 419.528, 90),
        (595.276, 841.89, 180),
        (300.0, 400.0, 0),
    ]
    fonts = harness.open(corpus["mixed_fonts.pdf"])["info"]["fonts"]
    assert [f["name"] for f in fonts] == ["BeVietnamPro-Bold", "BeVietnamPro-Regular", "Helvetica"]


def test_pdf_date_to_iso() -> None:
    assert pdf_date_to_iso("D:20240131120501+07'00'") == "2024-01-31T12:05:01+07:00"
    assert pdf_date_to_iso("D:20240131") == "2024-01-31T00:00:00"
    assert pdf_date_to_iso("D:20240131120501Z") == "2024-01-31T12:05:01Z"
    assert pdf_date_to_iso("yesterday") == "yesterday"


def test_undo_redo(harness: Harness, numbered: Callable[[int], Path]) -> None:
    sid = harness.open(numbered(3))["state"]["sessionId"]
    r1 = harness.op("page.delete", {"pages": [0]}, sid)
    assert r1["state"]["revision"] == 1 and r1["state"]["canUndo"] and r1["state"]["dirty"]
    harness.op("page.delete", {"pages": [0]}, sid)
    assert page_widths(_state(harness, sid)["revisionPath"]) == [102]  # type: ignore[arg-type]

    undo = harness.call("session.undo", {"sessionId": sid})
    assert undo["changedPages"] == "all"
    assert undo["state"]["revision"] == 1 and undo["state"]["canRedo"]
    assert page_widths(undo["state"]["revisionPath"]) == [101, 102]
    undo = harness.call("session.undo", {"sessionId": sid})
    assert undo["state"]["revision"] == 0 and not undo["state"]["canUndo"]
    assert not undo["state"]["dirty"]
    with pytest.raises(RpcFailure) as exc:
        harness.call("session.undo", {"sessionId": sid})
    assert exc.value.kind == "INVALID_PARAMS"

    redo = harness.call("session.redo", {"sessionId": sid})
    assert redo["state"]["revision"] == 1 and redo["state"]["canRedo"]

    # A new op after undo drops the redo branch; revision numbers keep increasing.
    r3 = harness.op("page.rotate", {"pages": [0], "angle": 90}, sid)
    assert r3["state"]["revision"] == 3 and not r3["state"]["canRedo"]
    assert not (_session_dir(harness, sid) / "rev-0002.pdf").exists()
    with pytest.raises(RpcFailure):
        harness.call("session.redo", {"sessionId": sid})

    journal = [
        json.loads(line)
        for line in (_session_dir(harness, sid) / "journal.jsonl").read_text().splitlines()
    ]
    assert [(j["rev"], j["opId"]) for j in journal] == [
        (1, "page.delete"),
        (2, "page.delete"),
        (3, "page.rotate"),
    ]
    assert journal[2]["params"] == {"pages": [0], "angle": 90}


def test_journal_never_stores_passwords_or_image_data(
    harness: Harness, numbered: Callable[[int], Path], corpus: dict[str, Path]
) -> None:
    sid = harness.open(numbered(1))["state"]["sessionId"]
    path = str(corpus["encrypted_1234.pdf"])
    harness.op("page.insertFromFile", {"at": 0, "path": path, "password": "1234"}, sid)
    png = corpus["logo_alpha.png"].read_bytes()
    data_url = "data:image/png;base64," + base64.b64encode(png).decode()
    harness.op(
        "page.insertImages",
        {"at": 0, "images": [{"dataUrl": data_url}], "pageSize": "image", "margin": 0},
        sid,
    )
    journal = (_session_dir(harness, sid) / "journal.jsonl").read_text()
    entries = [json.loads(line) for line in journal.splitlines()]
    assert entries[0]["params"] == {"at": 0, "path": path, "pages": None}
    assert "password" not in journal
    assert data_url not in journal and "chars>" in journal


def test_revision_limit(
    harness: Harness, numbered: Callable[[int], Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(session_manager, "MAX_REVISIONS", 4)
    sid = harness.open(numbered(2))["state"]["sessionId"]
    for _ in range(6):
        harness.op("page.rotate", {"pages": [0], "angle": 90}, sid)
    files = sorted(p.name for p in _session_dir(harness, sid).glob("rev-*.pdf"))
    assert files == ["rev-0000.pdf", "rev-0004.pdf", "rev-0005.pdf", "rev-0006.pdf"]
    revisions = []
    while True:
        try:
            revisions.append(harness.call("session.undo", {"sessionId": sid})["state"]["revision"])
        except RpcFailure:
            break
    assert revisions == [5, 4, 0]


def test_save_as_and_save(
    harness: Harness, numbered: Callable[[int], Path], tmp_path: Path
) -> None:
    src = numbered(3)
    original = src.read_bytes()
    sid = harness.open(src)["state"]["sessionId"]
    harness.op("page.delete", {"pages": [1]}, sid)
    assert src.read_bytes() == original  # source untouched until saved

    target = tmp_path / "saved as.pdf"
    state = harness.call("session.save", {"sessionId": sid, "path": str(target)})
    assert state["dirty"] is False and state["sourcePath"] == str(target)
    assert state["warnings"] == []
    assert page_widths(target) == [100, 102]
    assert src.read_bytes() == original

    harness.op("page.rotate", {"pages": [0], "angle": 180}, sid)
    assert _state(harness, sid)["dirty"] is True
    state = harness.call("session.save", {"sessionId": sid})  # back to the (new) source
    assert state["dirty"] is False
    with pikepdf.open(target) as pdf:
        assert int(pdf.pages[0].rotation) == 180
    # Atomic save leaves no temp files behind.
    assert sorted(p.name for p in tmp_path.iterdir() if p.name.startswith(".")) == []

    harness.call("session.undo", {"sessionId": sid})
    assert _state(harness, sid)["dirty"] is True


def test_save_errors(harness: Harness, tmp_path: Path) -> None:
    sid = harness.call("session.create", {})["state"]["sessionId"]
    with pytest.raises(RpcFailure) as exc:
        harness.call("session.save", {"sessionId": sid})
    assert exc.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as exc:
        harness.call("session.save", {"sessionId": sid, "path": str(tmp_path / "x" / "y.pdf")})
    assert exc.value.kind == "FILE_NOT_FOUND"
    with pytest.raises(RpcFailure) as exc:
        harness.call("session.save", {"sessionId": sid, "path": str(tmp_path)})
    assert exc.value.kind == "INVALID_PARAMS"


def test_create_then_save(harness: Harness, corpus: dict[str, Path], tmp_path: Path) -> None:
    created = harness.call("session.create", {})
    state = created["state"]
    assert state["sourcePath"] is None and state["revision"] == 0 and not state["dirty"]
    sid = state["sessionId"]
    harness.op(
        "page.insertImages",
        {
            "at": 0,
            "images": [{"path": str(corpus["photo_exif6.jpg"])}],
            "pageSize": "a4",
            "margin": 20,
        },
        sid,
    )
    out = tmp_path / "from_images.pdf"
    state = harness.call("session.save", {"sessionId": sid, "path": str(out)})
    assert state["sourcePath"] == str(out)
    assert page_widths(out) == [595]


def test_encrypted_round_trip(harness: Harness, corpus: dict[str, Path], tmp_path: Path) -> None:
    path = corpus["encrypted_1234.pdf"]
    with pytest.raises(RpcFailure) as exc:
        harness.open(path)
    assert exc.value.kind == "PASSWORD_REQUIRED" and exc.value.code == -32000
    with pytest.raises(RpcFailure) as exc:
        harness.open(path, "wrong")
    assert exc.value.kind == "PASSWORD_INVALID"

    opened = harness.open(path, "1234")
    assert opened["info"]["encrypted"] is True and opened["info"]["pageCount"] == 3
    sid = opened["state"]["sessionId"]
    revision = Path(opened["state"]["revisionPath"])
    with pikepdf.open(revision) as pdf:  # working copy is not encrypted
        assert not pdf.is_encrypted
    meta_text = (_session_dir(harness, sid) / "meta.json").read_text()
    assert "password" not in meta_text
    # the source path is stored JSON-escaped (backslashes doubled on Windows)
    assert "1234" not in meta_text.replace(json.dumps(str(path))[1:-1], "")

    harness.op("page.delete", {"pages": [0]}, sid)
    out = tmp_path / "saved.pdf"
    state = harness.call("session.save", {"sessionId": sid, "path": str(out)})
    assert len(state["warnings"]) == 1  # opened with the user password: owner not preserved
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(out)
    with pikepdf.open(out, password="1234") as pdf:
        assert len(pdf.pages) == 2
        assert pdf.encryption.R == 6 and pdf.encryption.bits == 256
        assert pdf.allow.extract is False  # permissions preserved


def test_encrypted_opened_with_owner_password(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path
) -> None:
    opened = harness.open(corpus["encrypted_1234.pdf"], "owner-5678")
    sid = opened["state"]["sessionId"]
    out = tmp_path / "saved.pdf"
    state = harness.call("session.save", {"sessionId": sid, "path": str(out)})
    assert state["warnings"] == []
    with pikepdf.open(out, password="owner-5678") as pdf:
        assert pdf.owner_password_matched


def test_owner_only_encryption(harness: Harness, corpus: dict[str, Path], tmp_path: Path) -> None:
    opened = harness.open(corpus["encrypted_owner_only.pdf"])
    assert opened["info"]["encrypted"] is True
    out = tmp_path / "saved.pdf"
    state = harness.call(
        "session.save", {"sessionId": opened["state"]["sessionId"], "path": str(out)}
    )
    assert len(state["warnings"]) == 1
    with pikepdf.open(out) as pdf:
        assert not pdf.is_encrypted

    opened = harness.open(corpus["encrypted_owner_only.pdf"], "owner-5678")
    state = harness.call(
        "session.save", {"sessionId": opened["state"]["sessionId"], "path": str(out)}
    )
    assert state["warnings"] == []
    with pikepdf.open(out) as pdf:  # empty user password kept, owner password kept
        assert pdf.is_encrypted
    with pikepdf.open(out, password="owner-5678") as pdf:
        assert pdf.owner_password_matched


@pytest.mark.parametrize("name", ["corrupt_truncated.pdf", "corrupt_garbage.pdf"])
def test_corrupt_file(harness: Harness, corpus: dict[str, Path], name: str) -> None:
    with pytest.raises(RpcFailure) as exc:
        harness.open(corpus[name])
    assert exc.value.kind == "INVALID_PDF" and exc.value.code == -32000
    assert list((harness.data_dir / "sessions").iterdir()) == []


def test_damaged_but_recoverable(harness: Harness, corpus: dict[str, Path]) -> None:
    opened = harness.open(corpus["damaged_recoverable.pdf"])
    assert opened["info"]["pageCount"] == 10
    revision = Path(opened["state"]["revisionPath"])
    assert revision.read_bytes() != corpus["damaged_recoverable.pdf"].read_bytes()  # repaired
    with pikepdf.open(revision) as pdf:
        assert not pdf.get_warnings() and len(pdf.pages) == 10


def test_missing_file_and_session(harness: Harness, tmp_path: Path) -> None:
    with pytest.raises(RpcFailure) as exc:
        harness.open(tmp_path / "nope.pdf")
    assert exc.value.kind == "FILE_NOT_FOUND"
    with pytest.raises(RpcFailure) as exc:
        harness.call("session.state", {"sessionId": "does-not-exist"})
    assert exc.value.kind == "SESSION_NOT_FOUND" and exc.value.code == -32000
    with pytest.raises(RpcFailure) as exc:
        harness.call("session.open", {})
    assert exc.value.kind == "INVALID_PARAMS" and exc.value.code == -32602


def test_close(harness: Harness, numbered: Callable[[int], Path]) -> None:
    sid = harness.open(numbered(2))["state"]["sessionId"]
    assert _session_dir(harness, sid).is_dir()
    assert harness.call("session.close", {"sessionId": sid}) is None
    assert not _session_dir(harness, sid).exists()
    for method in ("session.state", "session.info", "session.undo", "session.close"):
        with pytest.raises(RpcFailure) as exc:
            harness.call(method, {"sessionId": sid})
        assert exc.value.kind == "SESSION_NOT_FOUND"


def test_signed_document_blocks_destructive_ops(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path
) -> None:
    opened = harness.open(corpus["fake_signed.pdf"])
    assert opened["info"]["hasSignatures"] is True
    assert opened["state"]["signed"] is True
    sid = opened["state"]["sessionId"]
    with pytest.raises(RpcFailure) as exc:
        harness.op("page.rotate", {"pages": [0], "angle": 90}, sid)
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"
    out = tmp_path / "copy.pdf"
    harness.op("page.extract", {"pages": [0], "outputPath": str(out)}, sid)  # allowed
    assert out.is_file()


def test_graceful_shutdown_closes_sessions(tmp_path: Path, numbered: Callable[[int], Path]) -> None:
    h = Harness(tmp_path / "data")
    sid = h.open(numbered(1))["state"]["sessionId"]
    assert h.call("system.shutdown", {}) is None
    assert h.app.server.stopping
    h.close()
    assert not (tmp_path / "data" / "sessions" / sid).exists()


def test_eof_keeps_sessions_for_recovery(tmp_path: Path, numbered: Callable[[int], Path]) -> None:
    h = Harness(tmp_path / "data")
    sid = h.open(numbered(1))["state"]["sessionId"]
    h.close()  # like stdin EOF without system.shutdown
    assert (tmp_path / "data" / "sessions" / sid / "meta.json").is_file()
    # A new core does not delete them (crash-recovery candidates, A9).
    h2 = Harness(tmp_path / "data")
    h2.close()
    assert (tmp_path / "data" / "sessions" / sid / "meta.json").is_file()
