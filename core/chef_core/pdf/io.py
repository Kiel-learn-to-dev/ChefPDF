"""Opening and saving PDFs with error mapping and atomic writes."""

from __future__ import annotations

import contextlib
import os
import shutil
import tempfile
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pikepdf

from chef_core.errors import ChefError, ErrorKind


def _path_detail(path: Path) -> dict[str, str]:
    return {"path": str(path)}


def open_pdf(path: str | Path, password: str | None = None) -> pikepdf.Pdf:
    """Open ``path`` with pikepdf, mapping failures to ``ChefError`` kinds.

    - missing file / directory → ``FILE_NOT_FOUND``
    - encrypted without password → ``PASSWORD_REQUIRED``; wrong password → ``PASSWORD_INVALID``
    - unreadable / damaged beyond repair → ``INVALID_PDF``

    The page tree is touched so that structurally broken files fail here, not later.
    The caller must close the returned ``Pdf``.
    """
    p = Path(path)
    if not p.is_file():
        raise ChefError(ErrorKind.FILE_NOT_FOUND, "File not found", _path_detail(p))
    try:
        pdf = pikepdf.open(p, password=password or "")
    except pikepdf.PasswordError as exc:
        if password:
            raise ChefError(
                ErrorKind.PASSWORD_INVALID, "Invalid password", _path_detail(p)
            ) from exc
        raise ChefError(ErrorKind.PASSWORD_REQUIRED, "Password required", _path_detail(p)) from exc
    except (pikepdf.PdfError, OSError, RuntimeError, ValueError) as exc:
        raise ChefError(ErrorKind.INVALID_PDF, f"Not a valid PDF: {exc}", _path_detail(p)) from exc
    try:
        count = len(pdf.pages)
        # Touch the first page dictionary to catch broken page trees early.
        if count:
            _ = pdf.pages[0].obj.get("/MediaBox")
    except Exception as exc:
        pdf.close()
        raise ChefError(ErrorKind.INVALID_PDF, f"Damaged PDF: {exc}", _path_detail(p)) from exc
    return pdf


@contextlib.contextmanager
def opened_pdf(path: str | Path, password: str | None = None) -> Iterator[pikepdf.Pdf]:
    pdf = open_pdf(path, password)
    try:
        yield pdf
    finally:
        pdf.close()


def _temp_path_in(directory: Path, stem: str) -> Path:
    fd, name = tempfile.mkstemp(dir=directory, prefix=f".{stem}.", suffix=".tmp")
    os.close(fd)
    return Path(name)


def atomic_write(
    dest: str | Path,
    writer: Callable[[Path], None],
    before_replace: Callable[[], None] | None = None,
) -> None:
    """Write ``dest`` atomically: ``writer(tmp)`` writes a temp file in the same directory,
    which is then fsynced and renamed over ``dest``.

    ``before_replace`` runs after the temp file is complete and just before the rename; use it
    to release handles on ``dest`` (Windows refuses to replace a file that is still open)."""
    target = Path(dest)
    directory = target.parent
    if not directory.is_dir():
        raise ChefError(
            ErrorKind.FILE_NOT_FOUND, "Output directory does not exist", _path_detail(directory)
        )
    tmp = _temp_path_in(directory, target.name)
    try:
        writer(tmp)
        with open(tmp, "rb+") as fh:
            os.fsync(fh.fileno())
        if before_replace is not None:
            before_replace()
        os.replace(tmp, target)
    except BaseException:
        with contextlib.suppress(OSError):
            tmp.unlink()
        raise


def atomic_save(
    pdf: pikepdf.Pdf,
    dest: str | Path,
    before_replace: Callable[[], None] | None = None,
    **save_kwargs: Any,
) -> None:
    """Save ``pdf`` to ``dest`` atomically. Encryption is dropped unless given explicitly."""
    save_kwargs.setdefault("encryption", False)

    def write(tmp: Path) -> None:
        pdf.save(tmp, **save_kwargs)

    atomic_write(dest, write, before_replace)


def atomic_copy(src: str | Path, dest: str | Path) -> None:

    def write(tmp: Path) -> None:
        shutil.copyfile(src, tmp)

    atomic_write(dest, write)


def write_json_atomic(dest: Path, text: str) -> None:

    def write(tmp: Path) -> None:
        tmp.write_text(text, encoding="utf-8")

    atomic_write(dest, write)
