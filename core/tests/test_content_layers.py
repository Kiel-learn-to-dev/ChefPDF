"""T6.05: layers (optional content) and content.viewByType, checked with PDFium renders."""

from __future__ import annotations

from pathlib import Path

import pikepdf
import pytest
from conftest import Harness, RpcFailure
from content_support import ink_bbox, is_blue, is_red, render

from chef_core.content.layers import list_layers

PAGE_CONTENT = (
    b"/OC /L1 BDC q 1 0 0 rg 100 100 100 100 re f Q EMC\n"
    b"/OC /L2 BDC q 0 0 1 rg 300 300 100 100 re f Q EMC\n"
    b"q 0 1 0 rg 450 50 40 40 re f Q\n"
)


def _ocg_pdf(path: Path, *, names: tuple[str, str] = ("Layer 1", "Layer 2")) -> Path:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    ocg1 = pdf.make_indirect(
        pikepdf.Dictionary(Type=pikepdf.Name.OCG, Name=pikepdf.String(names[0]))
    )
    ocg2 = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.OCG,
            Name=pikepdf.String(names[1]),
            Usage=pikepdf.Dictionary(Print=pikepdf.Dictionary(PrintState=pikepdf.Name.ON)),
        )
    )
    pdf.Root.OCProperties = pikepdf.Dictionary(
        OCGs=pikepdf.Array([ocg1, ocg2]),
        D=pikepdf.Dictionary(
            Order=pikepdf.Array([ocg1, ocg2]),
            ON=pikepdf.Array([ocg1, ocg2]),
        ),
    )
    page = pdf.pages[0]
    page.obj.Resources = pikepdf.Dictionary(Properties=pikepdf.Dictionary(L1=ocg1, L2=ocg2))
    page.obj.Contents = pdf.make_stream(PAGE_CONTENT)
    pdf.save(path)
    pdf.close()
    return path


def _sid(harness: Harness, path: Path) -> str:
    return str(harness.open(path)["state"]["sessionId"])


def _revision(harness: Harness, sid: str) -> Path:
    return Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])


def _layers(harness: Harness, sid: str) -> dict:
    return harness.op("layers.list", {}, sid)["data"]


def _ids_by_name(harness: Harness, sid: str) -> dict[str, str]:
    return {layer["name"]: layer["id"] for layer in _layers(harness, sid)["layers"]}


def test_list_reports_visibility_counts_and_usage(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, _ocg_pdf(tmp_path / "ocg.pdf"))
    data = _layers(harness, sid)
    by_name = {layer["name"]: layer for layer in data["layers"]}
    assert set(by_name) == {"Layer 1", "Layer 2"}
    assert by_name["Layer 1"]["visible"] is True
    assert by_name["Layer 1"]["objectCount"] == 1 and by_name["Layer 1"]["pages"] == [0]
    assert by_name["Layer 2"]["usage"] == ["Print"]
    assert data["baseState"] == "ON"


def test_visibility_changes_the_render_and_is_undoable(harness: Harness, tmp_path: Path) -> None:
    path = _ocg_pdf(tmp_path / "vis.pdf")
    sid = _sid(harness, path)
    ids = _ids_by_name(harness, sid)
    harness.op("layers.setVisibility", {"layerIds": [ids["Layer 1"]], "visible": False}, sid)
    hidden = render(_revision(harness, sid))
    assert ink_bbox(hidden, is_red) is None
    assert ink_bbox(hidden, is_blue) is not None
    assert _layers(harness, sid)["layers"][0]["visible"] is False
    harness.call("session.undo", {"sessionId": sid})
    assert ink_bbox(render(_revision(harness, sid)), is_red) is not None


def test_remove_with_content_deletes_the_marked_content(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, _ocg_pdf(tmp_path / "rm.pdf"))
    ids = _ids_by_name(harness, sid)
    result = harness.op("layers.remove", {"layerIds": [ids["Layer 1"]], "deleteContent": True}, sid)
    assert result["data"]["removedLayers"] == 1
    img = render(_revision(harness, sid))
    assert ink_bbox(img, is_red) is None
    assert ink_bbox(img, is_blue) is not None
    assert [layer["name"] for layer in _layers(harness, sid)["layers"]] == ["Layer 2"]


def test_remove_without_content_keeps_the_content(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, _ocg_pdf(tmp_path / "merge.pdf"))
    ids = _ids_by_name(harness, sid)
    harness.op("layers.setVisibility", {"layerIds": [ids["Layer 1"]], "visible": False}, sid)
    harness.op("layers.remove", {"layerIds": [ids["Layer 1"]], "deleteContent": False}, sid)
    img = render(_revision(harness, sid))
    assert ink_bbox(img, is_red) is not None  # the content is plain content now
    assert [layer["name"] for layer in _layers(harness, sid)["layers"]] == ["Layer 2"]


def test_flatten_shows_hidden_content_and_drops_the_structure(
    harness: Harness, tmp_path: Path
) -> None:
    sid = _sid(harness, _ocg_pdf(tmp_path / "flat.pdf"))
    ids = _ids_by_name(harness, sid)
    harness.op("layers.setVisibility", {"layerIds": [ids["Layer 1"]], "visible": False}, sid)
    harness.op("layers.flatten", {}, sid)
    with pikepdf.open(_revision(harness, sid)) as pdf:
        assert "/OCProperties" not in pdf.Root
    assert ink_bbox(render(_revision(harness, sid)), is_red) is not None
    assert _layers(harness, sid)["layers"] == []


def test_unknown_layer_and_missing_layers_are_refused(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, _ocg_pdf(tmp_path / "bad.pdf"))
    with pytest.raises(RpcFailure) as bad:
        harness.op("layers.setVisibility", {"layerIds": ["999:0"], "visible": True}, sid)
    assert bad.value.kind == "INVALID_PARAMS"
    plain = pikepdf.new()
    plain.add_blank_page()
    plain_path = tmp_path / "plain.pdf"
    plain.save(plain_path)
    sid2 = _sid(harness, plain_path)
    assert _layers(harness, sid2)["layers"] == []


def test_view_by_type_groups_objects_and_gives_render_hints(
    harness: Harness, tmp_path: Path
) -> None:
    sid = _sid(harness, _ocg_pdf(tmp_path / "view.pdf"))
    full = harness.op("content.viewByType", {"pageIndex": 0}, sid)["data"]
    assert full["kinds"]["path"]["count"] == 3
    assert full["renderHint"]["hideIds"] == []
    only_paths = harness.op(
        "content.viewByType", {"pageIndex": 0, "kinds": ["text"], "solo": True}, sid
    )["data"]
    assert only_paths["kinds"]["path"]["count"] == 3
    assert only_paths["renderHint"]["showIds"] == []
    assert len(only_paths["renderHint"]["hideIds"]) == 3
    assert only_paths["renderHint"]["solo"] is True


def test_list_layers_helper_handles_documents_without_layers(tmp_path: Path) -> None:
    pdf = pikepdf.new()
    pdf.add_blank_page()
    assert list_layers(pdf) == {"baseState": None, "layers": [], "order": []}
