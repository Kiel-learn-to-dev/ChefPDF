"""T7.02: the replacement font registry (manifest, coverage, closest match)."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

import chef_core.text.fonts as fonts_mod
from chef_core.text.fonts import FontEntry, Wanted, load_registry, missing_in_all, pick

BE_REG = fonts_mod.fonts_dir() / "BeVietnamPro-Regular.ttf"
BE_BOLD = fonts_mod.fonts_dir() / "BeVietnamPro-Bold.ttf"


@pytest.fixture
def registry_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A registry folder with its own manifest; the module caches are reset around it."""
    folder = tmp_path / "fonts"
    folder.mkdir()
    monkeypatch.setattr(fonts_mod, "fonts_dir", lambda: folder)
    load_registry.cache_clear()
    yield folder
    load_registry.cache_clear()


def _manifest(folder: Path, entries: list[dict]) -> None:
    (folder / "manifest.json").write_text(
        json.dumps({"format": "chef-fonts/1", "fonts": entries}), encoding="utf-8"
    )


def _entry(font_id: str, file: str, **kw: object) -> dict:
    base = {
        "id": font_id,
        "file": file,
        "family": font_id,
        "style": "sans",
        "bold": False,
        "italic": False,
        "coverage": "vietnamese",
        "license": "OFL-1.1",
    }
    base.update(kw)
    return base


def test_the_bundled_manifest_lists_the_two_be_vietnam_pro_faces() -> None:
    load_registry.cache_clear()
    ids = [f.id for f in load_registry()]
    assert ids == ["BeVietnamPro-Regular", "BeVietnamPro-Bold"]
    bold = next(f for f in load_registry() if f.id == "BeVietnamPro-Bold")
    assert bold.bold and bold.file == BE_BOLD


def test_missing_files_are_skipped_and_bad_styles_refused(
    registry_dir: Path,
) -> None:
    shutil.copy(BE_REG, registry_dir / "A.ttf")
    _manifest(
        registry_dir,
        [_entry("A", "A.ttf"), _entry("Ghost", "not-there.ttf")],
    )
    load_registry.cache_clear()
    assert [f.id for f in load_registry()] == ["A"]


def test_unknown_style_is_an_error(registry_dir: Path) -> None:
    shutil.copy(BE_REG, registry_dir / "A.ttf")
    _manifest(registry_dir, [_entry("A", "A.ttf", style="comic")])
    load_registry.cache_clear()
    with pytest.raises(ValueError):
        load_registry()


def test_duplicate_ids_are_refused(registry_dir: Path) -> None:
    shutil.copy(BE_REG, registry_dir / "A.ttf")
    _manifest(registry_dir, [_entry("A", "A.ttf"), _entry("A", "A.ttf")])
    load_registry.cache_clear()
    with pytest.raises(ValueError):
        load_registry()


def test_pick_prefers_the_same_style_then_weight_then_slant(registry_dir: Path) -> None:
    for name in ("sans.ttf", "serif.ttf", "serif-bold.ttf", "serif-italic.ttf"):
        shutil.copy(BE_REG, registry_dir / name)
    _manifest(
        registry_dir,
        [
            _entry("Sans", "sans.ttf", style="sans"),
            _entry("Serif", "serif.ttf", style="serif"),
            _entry("SerifBold", "serif-bold.ttf", style="serif", bold=True),
            _entry("SerifItalic", "serif-italic.ttf", style="serif", italic=True),
        ],
    )
    load_registry.cache_clear()
    cps = {ord(c) for c in "Nguyễn Văn"}
    assert pick(cps, Wanted(style="serif")).id == "Serif"
    assert pick(cps, Wanted(style="serif", bold=True)).id == "SerifBold"
    assert pick(cps, Wanted(style="serif", italic=True)).id == "SerifItalic"
    assert pick(cps, Wanted(style="sans")).id == "Sans"


def test_pick_returns_none_when_no_font_covers_the_text(registry_dir: Path) -> None:
    shutil.copy(BE_REG, registry_dir / "A.ttf")
    _manifest(registry_dir, [_entry("A", "A.ttf")])
    load_registry.cache_clear()
    assert pick({ord("中")}, Wanted()) is None
    assert missing_in_all({ord("中"), ord("a")}) == {ord("中")}


def test_font_entry_face_reads_the_file() -> None:
    load_registry.cache_clear()
    item: FontEntry = load_registry()[0]
    face = item.face()
    assert face.supports(ord("ệ")) and face.supports(ord("Đ"))
    assert face.path == item.file


def test_the_original_family_name_is_preferred_over_style(registry_dir: Path) -> None:
    shutil.copy(BE_REG, registry_dir / "noto.ttf")
    shutil.copy(BE_REG, registry_dir / "sans.ttf")
    _manifest(
        registry_dir,
        [
            _entry("Sans", "sans.ttf", style="sans", family="Be Vietnam Pro"),
            _entry("NotoSerif", "noto.ttf", style="serif", family="Noto Serif"),
        ],
    )
    load_registry.cache_clear()
    cps = {ord(c) for c in "Chef"}
    # the original is "NotoSerif-Italic": the family wins even though the style differs
    picked = pick(cps, Wanted(style="sans", family="NotoSerif-Italic"))
    assert picked is not None and picked.id == "NotoSerif"
    assert pick(cps, Wanted(style="sans", family="Arial")).id == "Sans"
