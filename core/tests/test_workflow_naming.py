"""T9.06: name templates, sanitising, conflict policy, and batch rename (O4, O6)."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from chef_core.workflow.naming import (
    NameValues,
    check_template,
    plan_renames,
    render_template,
    sanitize_base,
    unique_target,
)

WHEN = datetime(2026, 11, 1, 9, 5, 7)


def values(name: str = "hoso", index: int = 3, **extra: object) -> NameValues:
    base = {
        "name": name,
        "index": index,
        "when": WHEN,
        "pages": 4,
        "parent": "Đơn",
        "title": "Tiêu đề",
        "counter": 2,
    }
    base.update(extra)
    return NameValues(**base)  # type: ignore[arg-type]


def test_render_all_tokens() -> None:
    text = render_template(
        "{name}_{date}_{time}_{seq:3}_{pages}p_{parent}_{title}_{counter}", values()
    )
    assert text == "hoso_2026-11-01_090507_003_4p_Đơn_Tiêu đề_2"


def test_unknown_tokens_and_bad_braces_are_reported() -> None:
    assert check_template("{name}_{bogus}") != []
    assert check_template("{seq:0}") != []
    assert check_template("{name") != [] or check_template("name}") != []
    assert check_template("{name}_{seq:3}") == []


def test_sanitise_illegal_and_reserved_names() -> None:
    assert sanitize_base(r'a<b>:c"d/e\f|g?h*i') == "a_b__c_d_e_f_g_h_i"
    assert sanitize_base("CON") == "_CON"
    assert sanitize_base("nul.txt") == "_nul.txt"
    assert sanitize_base("LPT1") == "_LPT1"
    assert sanitize_base("Hồ sơ 01. ") == "Hồ sơ 01"
    assert sanitize_base("...") == "file"
    long = sanitize_base("x" * 400)
    assert len(long) <= 150


def test_unique_target_suffixes_and_skip(tmp_path: Path) -> None:
    (tmp_path / "a.pdf").write_bytes(b"x")
    reserved: set[str] = set()
    first = unique_target(tmp_path, "a", "suffix", reserved)
    assert first == tmp_path / "a (2).pdf"
    second = unique_target(tmp_path, "a", "suffix", reserved)
    assert second == tmp_path / "a (3).pdf"
    assert unique_target(tmp_path, "a", "skip", set()) is None
    assert unique_target(tmp_path, "a", "overwrite", set()) == tmp_path / "a.pdf"


def test_plan_renames_resolves_duplicates_in_the_batch(tmp_path: Path) -> None:
    folder = tmp_path / "in"
    folder.mkdir()
    files = []
    for name in ("one.pdf", "two.pdf"):
        path = folder / name
        path.write_bytes(b"%PDF")
        files.append(path)
    plans = plan_renames(files, "{title}", "suffix", lambda p: values(name=p.stem, title="Giống"))
    targets = [p.target.name for p in plans if p.target is not None]
    assert targets == ["Giống.pdf", "Giống (2).pdf"]
    assert all(p.status == "ready" for p in plans)


def test_plan_renames_treats_batch_members_as_free(tmp_path: Path) -> None:
    folder = tmp_path / "in"
    folder.mkdir()
    a = folder / "a.pdf"
    b = folder / "b.pdf"
    a.write_bytes(b"1")
    b.write_bytes(b"2")
    plans = plan_renames([a, b], "{name}", "suffix", lambda p: values(name=p.stem))
    assert [p.status for p in plans] == ["unchanged", "unchanged"]


def test_invalid_template_gives_an_invalid_plan(tmp_path: Path) -> None:
    a = tmp_path / "a.pdf"
    a.write_bytes(b"1")
    plans = plan_renames([a], "{nope}", "suffix", lambda p: values())
    assert plans[0].status == "invalid" and plans[0].target is None
