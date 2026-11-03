"""Atomic output creation stays no-clobber if hardlinks are unavailable."""

from __future__ import annotations

import errno
from pathlib import Path

import pytest

from chef_core.errors import ChefError
from chef_core.pdf import io


def test_atomic_write_new_falls_back_when_hardlinks_are_unsupported(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    target = tmp_path / "result.bin"

    def unsupported_link(_source: Path, _target: Path) -> None:
        raise OSError(errno.EOPNOTSUPP, "hardlinks unsupported")

    monkeypatch.setattr(io.os, "link", unsupported_link)
    io.atomic_write_new(target, lambda temp: temp.write_bytes(b"complete output"))

    assert target.read_bytes() == b"complete output"
    assert list(tmp_path.glob(".result.bin.*.tmp")) == []


def test_exclusive_fallback_does_not_replace_a_racing_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    target = tmp_path / "result.bin"
    marker = b"created by another actor"

    def link_race(_source: Path, destination: Path) -> None:
        destination.write_bytes(marker)
        raise OSError(errno.EPERM, "hardlink denied")

    monkeypatch.setattr(io.os, "link", link_race)
    with pytest.raises(ChefError, match="Output already exists"):
        io.atomic_write_new(target, lambda temp: temp.write_bytes(b"job output"))

    assert target.read_bytes() == marker
    assert list(tmp_path.glob(".result.bin.*.tmp")) == []


def test_failed_exclusive_copy_removes_only_its_own_partial_file(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    target = tmp_path / "result.bin"

    def unsupported_link(_source: Path, _target: Path) -> None:
        raise OSError(errno.EOPNOTSUPP, "hardlinks unsupported")

    def partial_copy(_source: object, destination: object) -> None:
        destination.write(b"partial")  # type: ignore[attr-defined]
        raise OSError("simulated copy failure")

    monkeypatch.setattr(io.os, "link", unsupported_link)
    monkeypatch.setattr(io.shutil, "copyfileobj", partial_copy)

    with pytest.raises(OSError, match="simulated copy failure"):
        io.atomic_write_new(target, lambda temp: temp.write_bytes(b"job output"))

    assert not target.exists()
    assert list(tmp_path.glob(".result.bin.*.tmp")) == []
