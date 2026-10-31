"""Checklist before sending (J5; T5.03): preflight.check, one test per check."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import pikepdf
import pytest
from conftest import Harness
from pdf_builders import (
    blank_middle_page,
    gray_image_at_dpi,
    plain,
    unsigned_signature_field,
    with_hidden_text,
    with_javascript,
    with_metadata,
)

ORDER = [
    "fileSize",
    "hidden.metadata",
    "hidden.embeddedFiles",
    "hidden.javascript",
    "hidden.launchActions",
    "hidden.hiddenText",
    "hidden.hiddenLayers",
    "hidden.comments",
    "hidden.formValues",
    "hidden.thumbnails",
    "hidden.externalLinks",
    "hidden.xfa",
    "hidden.revisionHistory",
    "hidden.unusedObjects",
    "signatures.unsigned",
    "fonts.notEmbedded",
    "pages.blank",
    "pages.sizes",
    "images.lowDpi",
    "images.highDpi",
    "metadata.titleAuthor",
    "bookmarks.missing",
]


def _checks(h: Harness, sid: str, **params: Any) -> dict[str, dict[str, Any]]:
    data = h.op("preflight.check", params, sid)["data"]
    return {c["id"]: c for c in data}


def _open(h: Harness, path: Path) -> str:
    sid: str = h.open(path)["state"]["sessionId"]
    return sid


def _titled_doc(tmp_path: Path, name: str = "doc.pdf") -> Path:
    """A plain one-page document with Title and Author, so metadata passes."""
    path = plain(tmp_path / name, 1)
    with pikepdf.open(path, allow_overwriting_input=True) as doc:
        doc.docinfo["/Title"] = "Bao cao"
        doc.docinfo["/Author"] = "Nguyen Van A"
        doc.save(path)
    return path


def test_checklist_order_and_shape(harness: Harness, tmp_path: Path) -> None:
    data = harness.op("preflight.check", {}, _open(harness, _titled_doc(tmp_path)))["data"]
    assert [c["id"] for c in data] == ORDER
    for check in data:
        assert check["status"] in ("ok", "warn", "fail")
        assert check["titleVi"] and check["titleEn"]
        assert "fixOp" in check and "detail" in check


def test_clean_document_passes(harness: Harness, tmp_path: Path) -> None:
    checks = _checks(harness, _open(harness, _titled_doc(tmp_path)))
    failing = {k: v["status"] for k, v in checks.items() if v["status"] != "ok"}
    # Title and Author count as metadata to review, and Helvetica is not embedded in the
    # generated test documents: those are the two expected warnings.
    assert failing == {"hidden.metadata": "warn", "fonts.notEmbedded": "warn"}


def test_file_size_limit(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _titled_doc(tmp_path))
    size = harness.call("session.state", {"sessionId": sid})["revisionPath"]
    assert Path(size).stat().st_size > 100
    over = _checks(harness, sid, maxBytes=100)["fileSize"]
    assert over["status"] == "fail"
    assert over["fixOp"] == {"op": "compress.fitSize", "params": {"targetBytes": 100}}
    assert _checks(harness, sid, maxBytes=10_000_000)["fileSize"]["status"] == "ok"


def test_hidden_metadata_is_a_warning_with_a_fix(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, with_metadata(tmp_path / "m.pdf"))
    check = _checks(harness, sid)["hidden.metadata"]
    assert check["status"] == "warn"
    assert check["fixOp"] == {"op": "inspect.removeHidden", "params": {"categories": ["metadata"]}}


def test_javascript_fails_and_can_be_fixed_then_passes(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, with_javascript(tmp_path / "js.pdf"))
    check = _checks(harness, sid)["hidden.javascript"]
    assert check["status"] == "fail"
    assert check["fixOp"]["op"] == "inspect.removeHidden"
    harness.op(check["fixOp"]["op"], check["fixOp"]["params"], sid)
    assert _checks(harness, sid)["hidden.javascript"]["status"] == "ok"


def test_hidden_text_fails_without_a_fix(harness: Harness, tmp_path: Path) -> None:
    check = _checks(harness, _open(harness, with_hidden_text(tmp_path / "ht.pdf")))[
        "hidden.hiddenText"
    ]
    assert check["status"] == "fail" and check["fixOp"] is None


def test_unsigned_signature_field_warns(harness: Harness, tmp_path: Path) -> None:
    check = _checks(harness, _open(harness, unsigned_signature_field(tmp_path / "s.pdf")))[
        "signatures.unsigned"
    ]
    assert check["status"] == "warn" and check["detail"]["fields"] == ["ky1"]


def test_unreadable_signature_fails(harness: Harness, corpus: dict[str, Path]) -> None:
    check = _checks(harness, _open(harness, corpus["fake_signed.pdf"]))["signatures.validity"]
    assert check["status"] == "fail"
    assert check["detail"]["error"]


def test_no_signature_check_without_signatures(harness: Harness, tmp_path: Path) -> None:
    assert "signatures.validity" not in _checks(harness, _open(harness, _titled_doc(tmp_path)))


def test_fonts_not_embedded(harness: Harness, tmp_path: Path) -> None:
    check = _checks(harness, _open(harness, _titled_doc(tmp_path)))["fonts.notEmbedded"]
    assert check["status"] == "warn" and check["detail"]["fonts"] == ["Helvetica"]


def test_blank_page(harness: Harness, tmp_path: Path) -> None:
    check = _checks(harness, _open(harness, blank_middle_page(tmp_path / "b.pdf")))["pages.blank"]
    assert check["status"] == "warn"
    assert check["detail"]["pages"] == [2]
    assert check["fixOp"] == {"op": "page.delete", "params": {"pages": [1]}}


def test_mixed_page_sizes(harness: Harness, corpus: dict[str, Path]) -> None:
    check = _checks(harness, _open(harness, corpus["mixed_sizes.pdf"]))["pages.sizes"]
    assert check["status"] == "warn" and len(check["detail"]["sizes"]) > 1


def test_uniform_page_sizes_are_ok(harness: Harness, tmp_path: Path) -> None:
    check = _checks(harness, _open(harness, _titled_doc(tmp_path)))["pages.sizes"]
    assert check["status"] == "ok"


@pytest.mark.parametrize(
    ("inches", "px", "check_id", "status"),
    [
        (2.0, 50, "images.lowDpi", "warn"),  # 25 dpi
        (2.0, 200, "images.lowDpi", "ok"),  # 100 dpi
        (1.0, 800, "images.highDpi", "warn"),  # 800 dpi
        (2.0, 400, "images.highDpi", "ok"),  # 200 dpi
    ],
)
def test_image_resolution(
    harness: Harness, tmp_path: Path, inches: float, px: int, check_id: str, status: str
) -> None:
    path = gray_image_at_dpi(tmp_path / "img.pdf", px, inches)
    check = _checks(harness, _open(harness, path))[check_id]
    assert check["status"] == status


def test_encrypted_printing_blocked_is_flagged(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _titled_doc(tmp_path))
    harness.op(
        "security.encrypt",
        {"userPassword": "x-1", "permissions": {"printLowRes": False, "printHighRes": False}},
        sid,
    )
    check = _checks(harness, sid)["security.printing"]
    assert check["status"] == "warn"
    assert check["fixOp"] == {"op": "security.decrypt", "params": {}}


def test_metadata_title_and_author(harness: Harness, tmp_path: Path) -> None:
    check = _checks(harness, _open(harness, plain(tmp_path / "bare.pdf", 1)))[
        "metadata.titleAuthor"
    ]
    assert check["status"] == "warn"
    assert check["detail"]["missing"] == ["title", "author"]
    assert check["fixOp"] == {"op": "doc.setMetadata", "params": {}}


def test_bookmarks_for_long_documents(harness: Harness, tmp_path: Path) -> None:
    long_doc = plain(tmp_path / "long.pdf", 21)
    check = _checks(harness, _open(harness, long_doc))["bookmarks.missing"]
    assert check["status"] == "warn"
    assert check["fixOp"] == {"op": "bookmarks.fromPages", "params": {"mode": "replace"}}
    short = _checks(harness, _open(harness, plain(tmp_path / "short.pdf", 20)))
    assert short["bookmarks.missing"]["status"] == "ok"


def test_check_is_read_only(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, _titled_doc(tmp_path))
    before: Callable[[], dict[str, Any]] = lambda: harness.call(  # noqa: E731
        "session.state", {"sessionId": sid}
    )
    state = before()
    harness.op("preflight.check", {}, sid)
    assert before() == state
