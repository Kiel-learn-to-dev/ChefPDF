"""Hidden data (J3, J4; T5.02): inspect.hiddenData and inspect.removeHidden."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2 as pdfium
import pytest
from conftest import Harness, RpcFailure
from pdf_builders import (
    everything,
    jpeg_image_pdf,
    plain,
    with_bookmarks,
    with_comments,
    with_embedded,
    with_external_links,
    with_form,
    with_hidden_layer,
    with_hidden_text,
    with_javascript,
    with_launch,
    with_metadata,
    with_offpage_text,
    with_revisions,
    with_thumbnail,
    with_unused_object,
    with_white_text,
    with_xfa,
)

from chef_core.ops.inspect import CATEGORIES


def _findings(h: Harness, sid: str) -> dict[str, dict[str, Any]]:
    data = h.op("inspect.hiddenData", {}, sid)["data"]
    return {f["category"]: f for f in data["findings"]}


def _open(h: Harness, path: Path) -> str:
    sid: str = h.open(path)["state"]["sessionId"]
    return sid


def test_clean_document_reports_no_hidden_data(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, plain(tmp_path / "clean.pdf"))
    found = _findings(harness, sid)
    assert set(found) == set(CATEGORIES)
    for category in set(CATEGORIES) - {"fontsNotEmbedded"}:
        assert found[category]["count"] == 0, category
    # The page uses Helvetica, which is not embedded.
    assert found["fontsNotEmbedded"]["count"] == 1
    assert found["fontsNotEmbedded"]["items"] == [{"name": "Helvetica"}]


def test_inspect_is_read_only(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, with_javascript(tmp_path / "js.pdf"))
    before = harness.call("session.state", {"sessionId": sid})
    harness.op("inspect.hiddenData", {}, sid)
    assert harness.call("session.state", {"sessionId": sid}) == before


@pytest.mark.parametrize(
    ("builder", "category", "severity"),
    [
        (with_metadata, "metadata", "warn"),
        (with_javascript, "javascript", "risk"),
        (with_embedded, "embeddedFiles", "warn"),
        (with_hidden_text, "hiddenText", "risk"),
        (with_white_text, "hiddenText", "risk"),
        (with_offpage_text, "hiddenText", "risk"),
        (with_hidden_layer, "hiddenLayers", "warn"),
        (with_comments, "comments", "warn"),
        (with_form, "formValues", "info"),
        (with_bookmarks, "bookmarks", "info"),
        (with_thumbnail, "thumbnails", "info"),
        (with_external_links, "externalLinks", "info"),
        (with_launch, "launchActions", "risk"),
        (with_xfa, "xfa", "warn"),
        (with_revisions, "revisionHistory", "risk"),
        (with_unused_object, "unusedObjects", "info"),
    ],
)
def test_each_category_is_detected(
    harness: Harness, tmp_path: Path, builder: Callable[[Path], Path], category: str, severity: str
) -> None:
    sid = _open(harness, builder(tmp_path / "doc.pdf"))
    finding = _findings(harness, sid)[category]
    assert finding["count"] >= 1, finding
    assert finding["severity"] == severity
    assert finding["fixAvailable"] is CATEGORIES[category][1]


def test_hidden_text_kinds_and_no_fix(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, with_hidden_text(tmp_path / "ht.pdf"))
    item = _findings(harness, sid)["hiddenText"]["items"][0]
    assert item == {"kind": "invisible", "ops": 2}
    sid = _open(harness, with_white_text(tmp_path / "wt.pdf"))
    assert {"kind": "whiteOnWhite", "ops": 1} in _findings(harness, sid)["hiddenText"]["items"]
    sid = _open(harness, with_offpage_text(tmp_path / "op.pdf"))
    offpage = [i for i in _findings(harness, sid)["hiddenText"]["items"] if i["kind"] == "offPage"]
    assert offpage and offpage[0]["chars"] >= 5


def test_jpeg_image_dpi_is_reported(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, jpeg_image_pdf(tmp_path / "img.pdf"))
    images = _findings(harness, sid)["images"]["items"]
    jpeg = next(i for i in images if i["filter"] == "DCTDecode")
    assert jpeg["width"] == 200 and jpeg["height"] == 100
    assert jpeg["dpi"] == pytest.approx(100.0)
    assert {i["name"] for i in images} == {"Im1", "Im2"}


def test_signed_document_is_reported_but_not_changed(
    harness: Harness, corpus: dict[str, Path]
) -> None:
    sid = _open(harness, corpus["fake_signed.pdf"])
    harness.op("inspect.hiddenData", {}, sid)
    with pytest.raises(RpcFailure) as exc:
        harness.op("inspect.removeHidden", {"categories": ["metadata"]}, sid)
    assert exc.value.kind == "BLOCKED_BY_SIGNATURE"


REMOVABLE = [
    (with_metadata, "metadata"),
    (with_embedded, "embeddedFiles"),
    (with_javascript, "javascript"),
    (with_launch, "launchActions"),
    (with_hidden_layer, "hiddenLayers"),
    (with_comments, "comments"),
    (with_form, "formValues"),
    (with_bookmarks, "bookmarks"),
    (with_thumbnail, "thumbnails"),
    (with_external_links, "externalLinks"),
    (with_xfa, "xfa"),
    (with_revisions, "revisionHistory"),
    (with_unused_object, "unusedObjects"),
]


@pytest.mark.parametrize(("builder", "category"), REMOVABLE)
def test_remove_then_rescan_reports_zero(
    harness: Harness, tmp_path: Path, builder: Callable[[Path], Path], category: str
) -> None:
    sid = _open(harness, builder(tmp_path / "doc.pdf"))
    assert _findings(harness, sid)[category]["count"] >= 1
    result = harness.op("inspect.removeHidden", {"categories": [category]}, sid)
    assert result["state"]["revision"] == 1 and result["state"]["dirty"] is True
    assert result["data"]["before"][category] >= 1
    assert result["data"]["after"][category] == 0
    assert _findings(harness, sid)[category]["count"] == 0


def test_metadata_removal_clears_info_and_xmp(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, with_metadata(tmp_path / "meta.pdf"))
    harness.op("inspect.removeHidden", {"categories": ["metadata"]}, sid)
    out = tmp_path / "clean.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(out)})
    with pikepdf.open(out) as pdf:
        assert "/Info" not in pdf.trailer or len(pdf.docinfo) == 0
        assert "/Metadata" not in pdf.Root


def test_embedded_and_form_values_are_really_removed(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, with_embedded(tmp_path / "emb.pdf"))
    harness.op("inspect.removeHidden", {"categories": ["embeddedFiles"]}, sid)
    out = tmp_path / "emb_clean.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(out)})
    with pikepdf.open(out) as pdf:
        assert len(pdf.attachments) == 0

    sid = _open(harness, with_form(tmp_path / "form.pdf"))
    harness.op("inspect.removeHidden", {"categories": ["formValues"]}, sid)
    out = tmp_path / "form_clean.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(out)})
    with pikepdf.open(out) as pdf:
        fields = pdf.Root.AcroForm.Fields
        assert len(fields) == 2 and "/V" not in fields[0]


def _render(path: Path) -> bytes:
    doc = pdfium.PdfDocument(str(path))
    try:
        page = doc[0]
        bitmap = page.render(scale=1.5)
        data = bitmap.to_pil().tobytes()
        bitmap.close()
        page.close()
        return data
    finally:
        doc.close()


def test_hidden_layer_removal_keeps_the_visible_rendering(harness: Harness, tmp_path: Path) -> None:
    src = with_hidden_layer(tmp_path / "layers.pdf")
    before = _render(src)
    sid = _open(harness, src)
    result = harness.op("inspect.removeHidden", {"categories": ["hiddenLayers"]}, sid)
    assert result["data"]["after"]["hiddenLayers"] == 0
    assert _render(Path(result["state"]["revisionPath"])) == before
    with pikepdf.open(result["state"]["revisionPath"]) as pdf:
        text = b"".join(
            c.read_bytes()
            for c in (
                [pdf.pages[0].obj.Contents]
                if isinstance(pdf.pages[0].obj.Contents, pikepdf.Stream)
                else list(pdf.pages[0].obj.Contents)
            )
        )
    assert b"Layer secret" not in text and b"Visible text" in text


def test_remove_all_categories_from_a_busy_document(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, everything(tmp_path / "busy.pdf"))
    before = _findings(harness, sid)
    for category in (
        "metadata",
        "javascript",
        "hiddenLayers",
        "comments",
        "formValues",
        "bookmarks",
        "externalLinks",
        "hiddenText",
    ):
        assert before[category]["count"] >= 1, category
    removable = [
        "metadata",
        "embeddedFiles",
        "javascript",
        "launchActions",
        "hiddenLayers",
        "comments",
        "formValues",
        "bookmarks",
        "thumbnails",
        "externalLinks",
        "xfa",
        "revisionHistory",
        "unusedObjects",
    ]
    result = harness.op("inspect.removeHidden", {"categories": removable}, sid)
    for category in removable:
        assert result["data"]["after"][category] == 0, category
    assert result["data"]["after"]["hiddenText"] >= 1  # not removable: still reported
    assert _findings(harness, sid)["javascript"]["count"] == 0


def test_removal_params_are_validated(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, plain(tmp_path / "p.pdf"))
    with pytest.raises(RpcFailure) as exc:
        harness.op("inspect.removeHidden", {"categories": ["hiddenText"]}, sid)
    assert exc.value.kind == "INVALID_PARAMS"
    with pytest.raises(RpcFailure) as exc:
        harness.op("inspect.removeHidden", {"categories": []}, sid)
    assert exc.value.kind == "INVALID_PARAMS"
