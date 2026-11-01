"""Defect 5c of the core review: the PyInstaller bundle carries every data file the code reads.

Static checks only (PyInstaller is not run here): the build script collects the chef_core package
data and submodules, every data file that the code names exists in the repository, and the font
manifest only lists files that exist. The numeric dependencies (numpy, OpenCV) are declared.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

CORE = Path(__file__).resolve().parents[1]
PACKAGE = CORE / "chef_core"
RESOURCES = PACKAGE / "resources"
BUILD_SCRIPT = CORE.parent / "packaging" / "build-core.mjs"
# Written by the app at run time (session meta), never shipped with the package.
RUNTIME_FILES = {"meta.json"}
DATA_LITERAL = re.compile(r'"([A-Za-z0-9_.-]+\.(?:json|ttf|otf|txt|pem|p12|pfx|crt|cer))"')


def _code_literals() -> set[str]:
    names: set[str] = set()
    for source in PACKAGE.rglob("*.py"):
        if "__pycache__" in source.parts:
            continue
        names.update(DATA_LITERAL.findall(source.read_text(encoding="utf-8")))
    return names


def _shipped(name: str) -> list[Path]:
    return [
        path for path in PACKAGE.rglob(name) if path.is_file() and "__pycache__" not in path.parts
    ]


def test_build_script_collects_the_package_data_and_submodules() -> None:
    text = BUILD_SCRIPT.read_text(encoding="utf-8")
    assert re.search(r"'--collect-data',\s*\n\s*'chef_core'", text), "--collect-data chef_core"
    assert re.search(r"'--collect-submodules',\s*\n\s*'chef_core'", text)
    assert "'--onedir'" in text


def test_numeric_dependencies_are_declared_for_the_bundle() -> None:
    pyproject = (CORE / "pyproject.toml").read_text(encoding="utf-8")
    assert '"numpy' in pyproject
    assert '"opencv-python-headless' in pyproject  # cv2 is imported inside chef_core.imaging


def test_resource_files_the_code_names_are_in_the_repository() -> None:
    names = _code_literals() - RUNTIME_FILES
    assert names, "the scan should find the data files the code names"
    missing = sorted(name for name in names if not _shipped(name))
    assert missing == [], f"referenced by code but not in the repository: {missing}"


def test_known_resource_paths_exist() -> None:
    for relative in (
        "stamps.json",
        "token_drivers.json",
        "fonts/BeVietnamPro-Regular.ttf",
        "fonts/BeVietnamPro-Bold.ttf",
        "fonts/manifest.json",
        "fonts/OFL.txt",
    ):
        assert (RESOURCES / relative).is_file(), relative
    assert (PACKAGE / "layout" / "schema.json").is_file()


def test_font_manifest_entries_have_their_files() -> None:
    manifest = json.loads((RESOURCES / "fonts" / "manifest.json").read_text(encoding="utf-8"))
    files = [entry["file"] for entry in manifest["fonts"]]
    assert files
    for name in files:
        assert (RESOURCES / "fonts" / name).is_file(), name


def test_workflow_samples_are_shipped_as_valid_json() -> None:
    samples = sorted((RESOURCES / "workflows").glob("*.json"))
    assert samples
    for sample in samples:
        json.loads(sample.read_text(encoding="utf-8"))
