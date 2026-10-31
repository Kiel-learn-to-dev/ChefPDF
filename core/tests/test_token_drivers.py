"""T3.02: driver registry (token_drivers.json), scan with an injected filesystem, manual paths."""

from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

import pytest
from token_support import FakeFileSystem

from chef_core.errors import ChefError, ErrorKind
from chef_core.signing.drivers import (
    Confidence,
    OsFileSystem,
    TokenEnvironment,
    load_database,
    scan_drivers,
    validate_module_path,
)

WIN_ENV = {
    "WINDIR": "C:\\Windows",
    "ProgramFiles": "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
}
SYSTEM32 = "C:\\Windows\\System32"
SYSWOW64 = "C:\\Windows\\SysWOW64"


def _env(
    files: set[str], os_name: str = "windows", environ: Mapping[str, str] | None = None
) -> TokenEnvironment:
    fs = FakeFileSystem(files, WIN_ENV if environ is None else environ)
    return TokenEnvironment(fs=fs, os_name=os_name, database=load_database())


def _hits_for(env: TokenEnvironment, ca_id: str) -> list:
    return [h for h in scan_drivers(env) if h.ca_id == ca_id]


def test_database_covers_the_cas_named_in_tokens_doc() -> None:
    db = load_database()
    names = {ca.name for ca in db.cas}
    for expected in (
        "Viettel-CA",
        "VNPT-CA",
        "FPT-CA",
        "Bkav-CA",
        "MISA-CA",
        "Ban Cơ yếu Chính phủ",
    ):
        assert expected in names
    assert db.version == 1


def test_every_driver_entry_is_valid_and_has_a_confidence() -> None:
    db = load_database()
    seen_paths = 0
    for ca in db.cas:
        assert ca.models, ca.id
        for model in ca.models:
            assert set(model.drivers) <= {"windows", "macos", "linux"}
            for candidates in model.drivers.values():
                for candidate in candidates:
                    seen_paths += 1
                    assert candidate.path.strip()
                    assert isinstance(candidate.confidence, Confidence)
    assert seen_paths > 20


def test_viettel_v6_is_found_in_system32_as_64_bit() -> None:
    env = _env({f"{SYSTEM32}\\viettel-ca_v6.dll"})
    hits = [h for h in _hits_for(env, "viettel-ca") if h.model_id == "v6"]
    assert hits
    found = hits[0]
    assert found.exists is True
    assert found.path == f"{SYSTEM32}\\viettel-ca_v6.dll"
    assert found.bitness == "64"
    assert found.confidence is Confidence.DOCUMENTED


def test_glob_candidates_match_case_insensitively() -> None:
    env = _env({f"{SYSTEM32}\\VNPT_CA_Token_Driver.dll"})
    hits = [h for h in _hits_for(env, "vnpt-ca") if h.exists]
    assert len(hits) == 1
    assert hits[0].path == f"{SYSTEM32}\\VNPT_CA_Token_Driver.dll"


def test_syswow64_hit_is_marked_as_32_bit() -> None:
    env = _env({f"{SYSWOW64}\\viettel-ca_v4.dll"})
    hit = next(h for h in _hits_for(env, "viettel-ca") if h.exists)
    assert hit.bitness == "32"


def test_absolute_candidate_with_environment_placeholder() -> None:
    opensc = "C:\\Program Files\\OpenSC Project\\OpenSC\\pkcs11\\opensc-pkcs11.dll"
    env = _env({opensc})
    hit = next(h for h in _hits_for(env, "opensc") if h.exists)
    assert hit.path == opensc
    assert hit.bitness is None


def test_nothing_installed_means_every_candidate_is_missing() -> None:
    env = _env(set())
    hits = scan_drivers(env)
    assert hits
    assert not any(h.exists for h in hits)


def test_windows_names_are_not_searched_on_linux() -> None:
    env = _env({f"{SYSTEM32}\\viettel-ca_v6.dll"}, os_name="linux", environ={})
    assert not any(h.exists for h in scan_drivers(env))


def test_linux_search_finds_opensc() -> None:
    env = TokenEnvironment(
        fs=FakeFileSystem({"/usr/lib/opensc-pkcs11.so"}, {}),
        os_name="linux",
        database=load_database(),
    )
    hit = next(h for h in _hits_for(env, "opensc") if h.exists)
    assert hit.path == "/usr/lib/opensc-pkcs11.so"


def test_macos_absolute_path_is_checked_directly() -> None:
    env = TokenEnvironment(
        fs=FakeFileSystem({"/Library/OpenSC/lib/opensc-pkcs11.so"}, {}),
        os_name="macos",
        database=load_database(),
    )
    assert any(
        h.exists and h.path == "/Library/OpenSC/lib/opensc-pkcs11.so" for h in scan_drivers(env)
    )


def test_validate_manual_path_rules(tmp_path: Path) -> None:
    dll = tmp_path / "custom.dll"
    dll.write_bytes(b"x")
    text = tmp_path / "notes.txt"
    text.write_text("x", encoding="utf-8")
    fs = OsFileSystem()

    assert validate_module_path(str(dll), "windows", fs) == str(dll)
    with pytest.raises(ChefError) as missing:
        validate_module_path(str(tmp_path / "absent.dll"), "windows", fs)
    assert missing.value.kind is ErrorKind.FILE_NOT_FOUND

    with pytest.raises(ChefError) as directory:
        validate_module_path(str(tmp_path), "windows", fs)
    assert directory.value.kind is ErrorKind.FILE_NOT_FOUND

    with pytest.raises(ChefError) as wrong_ext:
        validate_module_path(str(text), "windows", fs)
    assert wrong_ext.value.kind is ErrorKind.INVALID_PARAMS


def test_extension_depends_on_os(tmp_path: Path) -> None:
    so = tmp_path / "libcustom.so.1"
    so.write_bytes(b"x")
    dylib = tmp_path / "libcustom.dylib"
    dylib.write_bytes(b"x")
    fs = OsFileSystem()
    assert validate_module_path(str(so), "linux", fs) == str(so)
    assert validate_module_path(str(dylib), "macos", fs) == str(dylib)
    with pytest.raises(ChefError) as exc:
        validate_module_path(str(so), "windows", fs)
    assert exc.value.kind is ErrorKind.INVALID_PARAMS
    with pytest.raises(ChefError) as exc2:
        validate_module_path(str(dylib), "linux", fs)
    assert exc2.value.kind is ErrorKind.INVALID_PARAMS
