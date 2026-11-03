"""Opening and saving PDFs with error mapping and atomic writes."""

from __future__ import annotations

import contextlib
import errno
import os
import shutil
import tempfile
from collections.abc import Callable, Iterator
from contextvars import ContextVar, Token
from pathlib import Path
from typing import Any

import pikepdf

from chef_core.errors import ChefError, ErrorKind

CreatedOutputFn = Callable[[Path, os.stat_result], None]
_CREATED_OUTPUTS: ContextVar[CreatedOutputFn | None] = ContextVar("created_outputs", default=None)


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


def _same_file_identity(left: os.stat_result, right: os.stat_result) -> bool:
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def _unlink_if_owned(path: Path, identity: os.stat_result) -> None:
    try:
        if _same_file_identity(path.stat(), identity):
            path.unlink()
    except OSError:
        pass


def _fallback_create_exclusive(tmp: Path, target: Path) -> None:
    """Copy into an exclusive destination when the filesystem cannot hardlink temp files.

    The destination is visible while copying on these filesystems, so this preserves no-clobber
    and cleanup safety but not atomic visibility.
    """
    try:
        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0)
        fd = os.open(target, flags, 0o666)
    except FileExistsError as exc:
        raise ChefError(
            ErrorKind.INVALID_PARAMS,
            "Output already exists",
            _path_detail(target),
        ) from exc

    identity = os.fstat(fd)
    try:
        stream = os.fdopen(fd, "wb")
        fd = -1
        with stream as destination, open(tmp, "rb") as source:
            shutil.copyfileobj(source, destination)
            destination.flush()
            os.fsync(destination.fileno())
        try:
            current = target.stat()
        except OSError as exc:
            raise OSError("Output path disappeared while writing") from exc
        if not _same_file_identity(current, identity):
            raise OSError("Output path changed while writing")
        record_created_output(target, identity)
    except BaseException:
        if fd >= 0:
            with contextlib.suppress(OSError):
                os.close(fd)
        _unlink_if_owned(target, identity)
        raise


def _hardlink_is_unsupported(exc: OSError) -> bool:
    unsupported = {
        errno.EACCES,
        errno.EPERM,
        errno.EXDEV,
        getattr(errno, "ENOTSUP", errno.EPERM),
        getattr(errno, "EOPNOTSUPP", errno.EPERM),
        getattr(errno, "ENOSYS", errno.EPERM),
    }
    return exc.errno in unsupported or getattr(exc, "winerror", None) in {1, 5, 50, 1314}


@contextlib.contextmanager
def track_created_outputs(callback: CreatedOutputFn) -> Iterator[None]:
    """Track identity of files atomically created while the context is active."""
    token: Token[CreatedOutputFn | None] = _CREATED_OUTPUTS.set(callback)
    try:
        yield
    finally:
        _CREATED_OUTPUTS.reset(token)


def record_created_output(path: Path, stat: os.stat_result | None = None) -> None:
    callback = _CREATED_OUTPUTS.get()
    if callback is not None:
        callback(path, stat or path.stat())


def atomic_write(
    dest: str | Path,
    writer: Callable[[Path], None],
    before_replace: Callable[[], None] | None = None,
    *,
    overwrite: bool = True,
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
        if overwrite:
            os.replace(tmp, target)
        else:
            try:
                os.link(tmp, target)
            except FileExistsError as exc:
                raise ChefError(
                    ErrorKind.INVALID_PARAMS,
                    "Output already exists",
                    _path_detail(target),
                ) from exc
            except OSError as exc:
                if not _hardlink_is_unsupported(exc):
                    raise
                _fallback_create_exclusive(tmp, target)
            else:
                record_created_output(target, tmp.stat())
            tmp.unlink()
    except BaseException:
        with contextlib.suppress(OSError):
            tmp.unlink()
        raise


_REPLACEABLE: ContextVar[Path | None] = ContextVar("replaceable_output", default=None)


@contextlib.contextmanager
def allow_replacing(path: Path | None) -> Iterator[None]:
    """Let ``atomic_write_new`` replace ``path`` (and only that path) while the context is active.

    The caller has the user's explicit confirmation, e.g. from the operating system's save dialog.
    """
    token: Token[Path | None] = _REPLACEABLE.set(path.resolve() if path else None)
    try:
        yield
    finally:
        _REPLACEABLE.reset(token)


def atomic_write_new(dest: str | Path, writer: Callable[[Path], None]) -> None:
    """Atomically create a file, refusing to replace an existing path unless it was declared
    with ``allow_replacing``."""
    replaceable = _REPLACEABLE.get()
    atomic_write(
        dest, writer, overwrite=replaceable is not None and Path(dest).resolve() == replaceable
    )


def atomic_save(
    pdf: pikepdf.Pdf,
    dest: str | Path,
    before_replace: Callable[[], None] | None = None,
    **save_kwargs: Any,
) -> None:
    """Save ``pdf`` to ``dest`` atomically. Encryption is dropped unless given explicitly."""
    save_kwargs.setdefault("encryption", False)
    if not save_kwargs["encryption"]:
        # qpdf otherwise writes a random second /ID element: same input would give different bytes
        save_kwargs.setdefault("deterministic_id", True)

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
