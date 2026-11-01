"""T9.05 core: folder watch with a settle time, lock check, queue and ledger de-duplication."""

from __future__ import annotations

from pathlib import Path

from chef_core.workflow.watch import WatchState, is_temp_name


def names(files: list) -> list[str]:  # type: ignore[type-arg]
    return sorted(Path(f.path).name for f in files)


def test_growing_file_is_returned_only_after_it_is_stable(tmp_path: Path) -> None:
    f = tmp_path / "scan.pdf"
    f.write_bytes(b"x" * 10)
    state = WatchState()
    assert state.scan(tmp_path, settle_seconds=2, now=0.0) == []
    f.write_bytes(b"x" * 20)  # still growing
    assert state.scan(tmp_path, settle_seconds=2, now=1.0) == []
    assert state.scan(tmp_path, settle_seconds=2, now=2.5) == []  # stable for 1.5 s only
    ready = state.scan(tmp_path, settle_seconds=2, now=3.5)
    assert names(ready) == ["scan.pdf"]
    assert ready[0].size == 20


def test_queued_file_is_not_returned_twice_until_marked(tmp_path: Path) -> None:
    (tmp_path / "a.pdf").write_bytes(b"1")
    state = WatchState()
    assert names(state.scan(tmp_path, settle_seconds=0, now=0.0)) == ["a.pdf"]
    assert state.scan(tmp_path, settle_seconds=0, now=2.0) == []  # queued, not done
    state.mark_done(tmp_path / "a.pdf", output_path=None, status="done")
    assert state.scan(tmp_path, settle_seconds=0, now=3.0) == []


def test_temp_partial_and_output_files_are_ignored(tmp_path: Path) -> None:
    for name in ("x.pdf.crdownload", "b.part", "~$a.pdf", "c.tmp", "keep.pdf", "keep_out.pdf"):
        (tmp_path / name).write_bytes(b"1")
    assert is_temp_name("x.pdf.crdownload") and is_temp_name("~$a.pdf")
    state = WatchState()
    state.mark_done(tmp_path / "keep.pdf", output_path=tmp_path / "keep_out.pdf", status="done")
    state.scan(tmp_path, settle_seconds=0, now=0.0)
    ready = state.scan(tmp_path, settle_seconds=0, now=1.0)
    assert names(ready) == []  # keep.pdf is done, keep_out.pdf is an output


def test_changed_content_is_a_new_file(tmp_path: Path) -> None:
    f = tmp_path / "a.pdf"
    f.write_bytes(b"1")
    state = WatchState()
    assert names(state.scan(tmp_path, settle_seconds=0, now=0.0)) == ["a.pdf"]
    state.mark_done(f, output_path=None, status="done")
    assert state.scan(tmp_path, settle_seconds=0, now=1.0) == []
    f.write_bytes(b"22")  # dropped again with new content
    assert names(state.scan(tmp_path, settle_seconds=0, now=2.0)) == ["a.pdf"]


def test_locked_file_waits(tmp_path: Path) -> None:
    (tmp_path / "a.pdf").write_bytes(b"1")
    locked = {"yes": True}
    state = WatchState(is_locked=lambda _p: locked["yes"])
    state.scan(tmp_path, settle_seconds=0, now=0.0)
    assert state.scan(tmp_path, settle_seconds=0, now=1.0) == []
    locked["yes"] = False
    assert names(state.scan(tmp_path, settle_seconds=0, now=2.0)) == ["a.pdf"]


def test_ledger_survives_a_restart(tmp_path: Path) -> None:
    (tmp_path / "a.pdf").write_bytes(b"1")
    ledger = tmp_path / "state" / "processed.json"
    first = WatchState()
    first.scan(tmp_path, settle_seconds=0, now=0.0)
    first.scan(tmp_path, settle_seconds=0, now=1.0)
    first.mark_done(tmp_path / "a.pdf", output_path=None, status="done")
    first.save(ledger)
    second = WatchState.load(ledger)
    second.scan(tmp_path, settle_seconds=0, now=5.0)
    assert second.scan(tmp_path, settle_seconds=0, now=6.0) == []
    assert '"status": "done"' in ledger.read_text(encoding="utf-8")


def test_corrupt_ledger_starts_empty(tmp_path: Path) -> None:
    ledger = tmp_path / "processed.json"
    ledger.write_text("{not json", encoding="utf-8")
    state = WatchState.load(ledger)
    (tmp_path / "a.pdf").write_bytes(b"1")
    assert names(state.scan(tmp_path, settle_seconds=0, now=0.0)) == ["a.pdf"]
