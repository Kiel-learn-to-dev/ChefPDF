"""PKCS#11 driver registry, scan and manual driver paths (features I4, I5; task T3.02).

The registry is data (``chef_core/resources/token_drivers.json``), so a new token model can be
added without a new app release. The scan only looks at the file system through ``FileSystem``,
so tests can run it against a fake layout. Nothing here loads a driver: loading is the backend's
job (``chef_core.signing.pkcs11``).
"""

from __future__ import annotations

import contextlib
import fnmatch
import ntpath
import os
import platform
import posixpath
import re
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from enum import StrEnum
from importlib import resources
from typing import Protocol

from pydantic import BaseModel, ConfigDict, Field

from chef_core.errors import ChefError, ErrorKind, invalid_params

OS_NAMES = ("windows", "macos", "linux")
DRIVER_DB_FILE = "token_drivers.json"
_ENV_PLACEHOLDER = re.compile(r"%([^%]+)%")
_GLOB_CHARS = ("*", "?", "[")


class Confidence(StrEnum):
    DOCUMENTED = "documented"  # the file name is written in docs/TOKENS.md or by the vendor
    REPORTED = "reported"  # seen in third-party guides or open-source tools
    UNVERIFIED = "unverified"  # a guess; must be checked on a real token


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class DriverCandidate(_Strict):
    path: str = Field(min_length=1)
    confidence: Confidence


class TokenModel(_Strict):
    id: str
    name: str
    notes: str = ""
    drivers: dict[str, list[DriverCandidate]] = Field(default_factory=dict)


class CaEntry(_Strict):
    id: str
    name: str
    models: list[TokenModel]


class DriverDatabase(_Strict):
    version: int
    updated: str = ""
    note: str = ""
    cas: list[CaEntry]


def load_database(text: str | None = None) -> DriverDatabase:
    """Parse the bundled registry (or ``text``). Raises ``ValueError`` on a bad file."""
    if text is None:
        text = (
            resources.files("chef_core.resources")
            .joinpath(DRIVER_DB_FILE)
            .read_text(encoding="utf-8")
        )
    db = DriverDatabase.model_validate_json(text)
    for ca in db.cas:
        for model in ca.models:
            unknown = set(model.drivers) - set(OS_NAMES)
            if unknown:
                raise ValueError(f"unknown OS in token_drivers.json: {sorted(unknown)}")
    return db


class FileSystem(Protocol):
    environ: Mapping[str, str]

    def is_file(self, path: str) -> bool: ...

    def list_dir(self, path: str) -> list[str]: ...


class OsFileSystem:
    """The real file system and environment."""

    def __init__(self) -> None:
        self.environ: Mapping[str, str] = os.environ

    def is_file(self, path: str) -> bool:
        return os.path.isfile(path)

    def list_dir(self, path: str) -> list[str]:
        try:
            return os.listdir(path)
        except OSError:
            return []


@dataclass(frozen=True)
class TokenEnvironment:
    fs: FileSystem
    os_name: str
    database: DriverDatabase


def current_os_name() -> str:
    system = platform.system()
    if system == "Windows":
        return "windows"
    if system == "Darwin":
        return "macos"
    return "linux"


_OVERRIDE: TokenEnvironment | None = None


def current_environment() -> TokenEnvironment:
    if _OVERRIDE is not None:
        return _OVERRIDE
    return TokenEnvironment(fs=OsFileSystem(), os_name=current_os_name(), database=load_database())


@contextlib.contextmanager
def use_environment(env: TokenEnvironment) -> Iterator[TokenEnvironment]:
    """Route scans and path checks to ``env`` (used by tests)."""
    global _OVERRIDE
    previous = _OVERRIDE
    _OVERRIDE = env
    try:
        yield env
    finally:
        _OVERRIDE = previous


# -- paths --------------------------------------------------------------------------------


def _expand(text: str, environ: Mapping[str, str]) -> str:
    """``%VAR%`` placeholders; unknown variables are left as they are."""
    return _ENV_PLACEHOLDER.sub(lambda m: environ.get(m.group(1), m.group(0)), text)


def _join(os_name: str, directory: str, name: str) -> str:
    return ntpath.join(directory, name) if os_name == "windows" else posixpath.join(directory, name)


def _is_absolute(os_name: str, path: str) -> bool:
    if os_name == "windows":
        return ntpath.isabs(path) or re.match(r"^[A-Za-z]:", path) is not None
    return path.startswith("/")


def search_dirs(os_name: str, environ: Mapping[str, str]) -> list[str]:
    """Directories searched for bare file names, in order."""
    if os_name == "windows":
        raw = [
            r"%WINDIR%\System32",
            r"%WINDIR%\SysWOW64",
            "%ProgramFiles%",
            "%ProgramFiles(x86)%",
        ]
        expanded = [_expand(d, environ) for d in raw]
        return [d for d in expanded if "%" not in d]
    if os_name == "macos":
        return ["/usr/local/lib", "/opt/homebrew/lib", "/Library/OpenSC/lib"]
    return [
        "/usr/lib",
        "/usr/lib/x86_64-linux-gnu",
        "/usr/lib64",
        "/usr/local/lib",
        "/usr/lib/pkcs11",
        "/usr/lib/x86_64-linux-gnu/pkcs11",
    ]


def _bitness(os_name: str, directory: str) -> str | None:
    if os_name != "windows":
        return None
    lowered = directory.lower()
    if lowered.endswith("syswow64"):
        return "32"
    if lowered.endswith("system32"):
        return "64"
    return None


@dataclass(frozen=True)
class DriverHit:
    ca_id: str
    ca_name: str
    model_id: str
    model_name: str
    path: str  # the file found, or where it was looked for
    exists: bool
    confidence: Confidence
    bitness: str | None  # "32" / "64" for Windows system folders, else None


@dataclass(frozen=True)
class _Located:
    path: str
    exists: bool
    bitness: str | None


def _locate(candidate: str, env: TokenEnvironment, dirs: list[str]) -> list[_Located]:
    os_name = env.os_name
    text = _expand(candidate, env.fs.environ)
    if _is_absolute(os_name, text):
        directory = ntpath.dirname(text) if os_name == "windows" else posixpath.dirname(text)
        return [_Located(text, env.fs.is_file(text), _bitness(os_name, directory))]
    if any(ch in text for ch in _GLOB_CHARS):
        return _locate_glob(text, env, dirs)
    for directory in dirs:
        path = _join(os_name, directory, text)
        if env.fs.is_file(path):
            return [_Located(path, True, _bitness(os_name, directory))]
    shown = _join(os_name, dirs[0], text) if dirs else text
    return [_Located(shown, False, None)]


def _locate_glob(pattern: str, env: TokenEnvironment, dirs: list[str]) -> list[_Located]:
    os_name = env.os_name
    fold = os_name == "windows"
    needle = pattern.lower() if fold else pattern
    found: list[_Located] = []
    for directory in dirs:
        for name in env.fs.list_dir(directory):
            haystack = name.lower() if fold else name
            if fnmatch.fnmatchcase(haystack, needle):
                path = _join(os_name, directory, name)
                if env.fs.is_file(path):
                    found.append(_Located(path, True, _bitness(os_name, directory)))
    if found:
        return found
    shown = _join(os_name, dirs[0], pattern) if dirs else pattern
    return [_Located(shown, False, None)]


def scan_drivers(env: TokenEnvironment) -> list[DriverHit]:
    """Every candidate of the registry for ``env.os_name``, with whether its file exists.

    A glob that matches several files gives one hit per file. A name that is missing gives one
    hit with ``exists=False`` so the UI can show what was looked for.
    """
    dirs = search_dirs(env.os_name, env.fs.environ)
    hits: list[DriverHit] = []
    for ca in env.database.cas:
        for model in ca.models:
            for candidate in model.drivers.get(env.os_name, []):
                for located in _locate(candidate.path, env, dirs):
                    hits.append(
                        DriverHit(
                            ca_id=ca.id,
                            ca_name=ca.name,
                            model_id=model.id,
                            model_name=model.name,
                            path=located.path,
                            exists=located.exists,
                            confidence=candidate.confidence,
                            bitness=located.bitness,
                        )
                    )
    return hits


# -- manual paths ---------------------------------------------------------------------------


def _file_name(path: str) -> str:
    return re.split(r"[\\/]", path)[-1].lower()


def _has_driver_extension(path: str, os_name: str) -> bool:
    name = _file_name(path)
    if os_name == "windows":
        return name.endswith(".dll")
    if os_name == "macos":
        return name.endswith(".dylib") or ".so" in name
    return ".so" in name  # libfoo.so and libfoo.so.1


def validate_module_path(path: str, os_name: str, fs: FileSystem) -> str:
    """A user-supplied driver: must be a file with the driver extension for this OS."""
    if not path or not path.strip():
        raise invalid_params("modulePath is required", {"field": "modulePath"})
    if not fs.is_file(path):
        raise ChefError(ErrorKind.FILE_NOT_FOUND, "Driver file not found", {"path": path})
    if not _has_driver_extension(path, os_name):
        raise invalid_params(
            "Not a PKCS#11 driver for this system: expected .dll on Windows, "
            ".dylib or .so on macOS, .so on Linux",
            {"field": "modulePath", "os": os_name},
        )
    return path
