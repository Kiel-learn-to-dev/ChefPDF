"""File writes of the exporters: atomic, UTF-8, LF line endings (same input, same bytes)."""

from __future__ import annotations

from pathlib import Path

from chef_core.pdf.io import atomic_write_new, record_created_output


def write_text(path: Path, text: str) -> None:
    def write(tmp: Path) -> None:
        tmp.write_text(text, encoding="utf-8", newline="\n")

    atomic_write_new(path, write)


def write_bytes(path: Path, data: bytes) -> None:
    def write(tmp: Path) -> None:
        tmp.write_bytes(data)

    atomic_write_new(path, write)


def create_assets_folder(path: Path) -> None:
    """Create and register a fresh assets folder; never reuse an existing folder."""
    path.mkdir()
    record_created_output(path)


def assets_folder(out: Path) -> Path:
    """The folder that holds the images of an export: ``<name>_files`` next to the output."""
    return out.with_name(out.stem + "_files")


def image_name(index: int, ext: str) -> str:
    return f"img-{index:03d}.{ext}"
