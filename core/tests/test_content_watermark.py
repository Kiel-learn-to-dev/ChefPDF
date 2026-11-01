"""T6.06: watermark detection (tiers 1-5), removal, content.removeSimilar and backgrounds."""

from __future__ import annotations

from pathlib import Path

import pikepdf
import pytest
from conftest import Harness, RpcFailure
from content_support import helvetica, ink_bbox, is_blue, is_dark, is_red, raw_pdf, render
from pikepdf import Array, Dictionary, Name

from chef_core.content.verify import assert_unchanged_outside
from chef_core.overlay.markers import overlay_block

PAGE_H = 792.0
BODY = b"BT /F1 12 Tf 60 650 Td (Body text line) Tj ET"
ROTATED_WM = b"q /GS1 gs BT /F1 60 Tf 0.7071 0.7071 -0.7071 0.7071 150 200 Tm (DRAFT) Tj ET Q\n"


def _gs(pdf: pikepdf.Pdf, page: pikepdf.Page, ca: float = 0.25) -> None:
    page.obj.Resources.ExtGState = Dictionary(GS1=Dictionary(Type=Name.ExtGState, ca=ca, CA=ca))


def _setup(pdf: pikepdf.Pdf, page: pikepdf.Page) -> None:
    _gs(pdf, page)


def _pdf(path: Path, content: bytes, pages: int = 1) -> Path:
    return raw_pdf(path, content, pages=pages, setup=_setup)


def _sid(harness: Harness, path: Path) -> str:
    return str(harness.open(path)["state"]["sessionId"])


def _revision(harness: Harness, sid: str) -> Path:
    return Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])


def _detect(harness: Harness, sid: str) -> list[dict]:
    return list(harness.op("watermark.detect", {}, sid)["data"]["candidates"])


def _kinds(cands: list[dict]) -> list[str]:
    return [c["kind"] for c in cands]


def _user_boxes(cand: dict) -> list[tuple[float, float, float, float]]:
    out = []
    for item in cand["preview"]:
        for x0, y0, x1, y1 in item["bboxes"]:
            out.append((x0, PAGE_H - y1, x1, PAGE_H - y0))
    return out


def test_tier1_tagged_artifact_is_first(harness: Harness, tmp_path: Path) -> None:
    content = (
        b"/Artifact <</Type /Pagination /Subtype /Watermark>> BDC "
        b"BT /F1 40 Tf 100 500 Td (MAT) Tj ET EMC\n" + BODY
    )
    sid = _sid(harness, _pdf(tmp_path / "t1.pdf", content))
    cands = _detect(harness, sid)
    assert cands[0]["kind"] == "artifact"
    assert cands[0]["confidence"] == pytest.approx(0.95)
    assert cands[0]["pages"] == [0]
    assert cands[0]["description"]["vi"].startswith("Watermark gắn nhãn")


def test_tier2_layer_with_a_watermark_name(harness: Harness, tmp_path: Path) -> None:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    ocg = pdf.make_indirect(Dictionary(Type=Name.OCG, Name=pikepdf.String("Bản quyền nội bộ")))
    pdf.Root.OCProperties = Dictionary(
        OCGs=Array([ocg]), D=Dictionary(Order=Array([ocg]), ON=Array([ocg]))
    )
    page = pdf.pages[0]
    page.obj.Resources = Dictionary(
        Font=Dictionary(F1=helvetica(pdf)), Properties=Dictionary(W=ocg)
    )
    page.obj.Contents = pdf.make_stream(
        b"/OC /W BDC BT /F1 40 Tf 100 500 Td (LAYER) Tj ET EMC\n" + BODY
    )
    path = tmp_path / "t2.pdf"
    pdf.save(path)
    pdf.close()
    sid = _sid(harness, path)
    cands = _detect(harness, sid)
    assert cands[0]["kind"] == "layer" and cands[0]["confidence"] == pytest.approx(0.9)
    assert cands[0]["layerIds"]


def test_tier3_watermark_annotation(harness: Harness, tmp_path: Path) -> None:
    path = _pdf(tmp_path / "t3.pdf", BODY)
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        annot = pdf.make_indirect(
            Dictionary(
                Type=Name.Annot,
                Subtype=Name.Watermark,
                Rect=Array([100, 100, 400, 300]),
                Contents=pikepdf.String("CONFIDENTIAL"),
            )
        )
        pdf.pages[0].obj.Annots = Array([annot])
        pdf.save(path)
    sid = _sid(harness, path)
    cands = _detect(harness, sid)
    assert _kinds(cands) == ["annotation"]
    assert cands[0]["annotRefs"] == [{"pageIndex": 0, "index": 0}]


def test_tier4_chef_overlay_watermark_is_exact(harness: Harness, tmp_path: Path) -> None:
    body = "BT /F1 40 Tf 120 400 Td (CHEF) Tj ET"
    block = overlay_block(overlay_id="a" * 32, group="b" * 32, kind="watermark", body=body)
    sid = _sid(harness, _pdf(tmp_path / "t4.pdf", block.encode() + BODY))
    cands = _detect(harness, sid)
    assert cands[0]["kind"] == "overlay"
    assert cands[0]["confidence"] == pytest.approx(1.0)
    assert cands[0]["overlayIds"] == ["a" * 32]


def test_repeated_rotated_faint_text_is_found_on_most_pages(
    harness: Harness, tmp_path: Path
) -> None:
    path = _pdf(tmp_path / "t5.pdf", ROTATED_WM + BODY, pages=4)
    sid = _sid(harness, path)
    cands = _detect(harness, sid)
    assert cands and cands[0]["kind"] == "repeated"
    assert cands[0]["pages"] == [0, 1, 2, 3]
    assert cands[0]["confidence"] >= 0.85
    assert "rotated" in " ".join(cands[0]["evidence"])
    assert "low opacity" in " ".join(cands[0]["evidence"])
    body = [c for c in cands if "Body" in c["description"]["en"]]
    assert all(c["confidence"] < cands[0]["confidence"] for c in body)


def test_repeated_needs_three_pages_and_sixty_percent(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, _pdf(tmp_path / "t5b.pdf", ROTATED_WM, pages=2))
    assert _detect(harness, sid) == []


def test_ranking_puts_tags_before_heuristics(harness: Harness, tmp_path: Path) -> None:
    tagged = (
        b"/Artifact <</Type /Pagination /Subtype /Watermark>> BDC "
        b"BT /F1 30 Tf 50 60 Td (X) Tj ET EMC\n"
    )
    sid = _sid(harness, _pdf(tmp_path / "rank.pdf", tagged + ROTATED_WM, pages=4))
    cands = _detect(harness, sid)
    assert cands[0]["kind"] == "artifact"
    assert [c["tier"] for c in cands] == sorted(c["tier"] for c in cands)


def test_remove_repeated_keeps_other_pixels(harness: Harness, tmp_path: Path) -> None:
    path = _pdf(tmp_path / "rm5.pdf", ROTATED_WM + BODY, pages=3)
    sid = _sid(harness, path)
    cand = _detect(harness, sid)[0]
    harness.op("watermark.remove", {"candidateIds": [cand["id"]]}, sid)
    after = _revision(harness, sid)
    boxes = _user_boxes(cand)
    assert_unchanged_outside(path, after, 0, boxes, pad=2.0)
    assert ink_bbox(render(after, 0), is_dark) is not None  # the body text stays
    assert ink_bbox(render(after, 2, 72), is_dark) is not None
    # the repeated body text is still a (low-confidence) candidate, the watermark is gone
    left = _detect(harness, sid)
    assert all("rotated" not in " ".join(c["evidence"]) for c in left)


def test_remove_artifact_and_annotation_and_overlay(harness: Harness, tmp_path: Path) -> None:
    tagged = (
        b"/Artifact <</Type /Pagination /Subtype /Watermark>> BDC "
        b"BT /F1 40 Tf 100 500 Td (MAT) Tj ET EMC\n"
    )
    path = _pdf(tmp_path / "rmt.pdf", tagged + BODY)
    sid = _sid(harness, path)
    cand = _detect(harness, sid)[0]
    result = harness.op("watermark.remove", {"candidateIds": [cand["id"]]}, sid)
    assert result["data"]["removedObjects"] == 1
    assert _detect(harness, sid) == []
    assert ink_bbox(render(_revision(harness, sid)), is_dark) is not None

    block = overlay_block(
        overlay_id="c" * 32,
        group="d" * 32,
        kind="watermark",
        body="BT /F1 40 Tf 120 400 Td (CHEF) Tj ET",
    )
    path2 = _pdf(tmp_path / "rmo.pdf", block.encode() + BODY)
    sid2 = _sid(harness, path2)
    cand2 = _detect(harness, sid2)[0]
    res2 = harness.op("watermark.remove", {"candidateIds": [cand2["id"]]}, sid2)
    assert res2["data"]["removedOverlays"] == 1
    assert _detect(harness, sid2) == []


def test_remove_unknown_candidate_is_refused(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, _pdf(tmp_path / "unk.pdf", BODY))
    with pytest.raises(RpcFailure) as exc:
        harness.op("watermark.remove", {"candidateIds": ["nope"]}, sid)
    assert exc.value.kind == "INVALID_PARAMS"


def test_similar_objects_are_listed_then_removed(harness: Harness, tmp_path: Path) -> None:
    # two red boxes on one page (the second one shifted by 1 mm) and one blue box
    content = (
        b"q 1 0 0 rg 100 100 50 50 re f Q "
        b"q 1 0 0 rg 102.8 100 50 50 re f Q "
        b"q 0 0 1 rg 300 300 50 50 re f Q"
    )
    path = raw_pdf(tmp_path / "sim.pdf", content, pages=2)
    sid = _sid(harness, path)
    objs = harness.op("content.listObjects", {"pageIndex": 0}, sid)["data"]["objects"]
    source = next(o for o in objs if o.get("fillColor") == "#ff0000")
    dry = harness.op(
        "content.removeSimilar",
        {"pageIndex": 0, "objectId": source["id"], "toleranceMm": 2.0},
        sid,
    )["data"]
    # both pages carry the same two boxes: the source, its 1 mm copy, on each page
    assert dry["dryRun"] is True and len(dry["matches"]) == 4
    done = harness.op(
        "content.removeSimilar",
        {"pageIndex": 0, "objectId": source["id"], "toleranceMm": 2.0, "dryRun": False},
        sid,
    )["data"]
    assert done["removedObjects"] == 4
    img = render(_revision(harness, sid))
    assert ink_bbox(img, is_red) is None
    assert ink_bbox(img, is_blue) is not None


def test_similar_respects_tolerance_and_scope(harness: Harness, tmp_path: Path) -> None:
    content = b"q 1 0 0 rg 100 100 50 50 re f Q q 1 0 0 rg 110 100 50 50 re f Q"
    path = raw_pdf(tmp_path / "tol.pdf", content, pages=2)
    sid = _sid(harness, path)
    objs = harness.op("content.listObjects", {"pageIndex": 0}, sid)["data"]["objects"]
    source = objs[0]
    tight = harness.op(
        "content.removeSimilar",
        {"pageIndex": 0, "objectId": source["id"], "toleranceMm": 1.0},
        sid,
    )["data"]
    # the source on each page; the box shifted by 10 pt is out of tolerance
    assert len(tight["matches"]) == 2
    assert all(m["bbox"][0] == 100.0 for m in tight["matches"])
    others = harness.op(
        "content.removeSimilar",
        {"pageIndex": 0, "objectId": source["id"], "scope": "others", "toleranceMm": 1.0},
        sid,
    )["data"]
    assert [m["pageIndex"] for m in others["matches"]] == [1]


def _bg_pdf(path: Path) -> Path:
    content = b"q 1 1 0 rg 0 0 612 792 re f Q BT /F1 24 Tf 100 400 Td (Ban noi dung) Tj ET"
    return raw_pdf(path, content)


def test_background_detect_remove_and_recolour(harness: Harness, tmp_path: Path) -> None:
    path = _bg_pdf(tmp_path / "bg.pdf")
    sid = _sid(harness, path)
    found = harness.op("background.detect", {}, sid)["data"]["backgrounds"]
    assert len(found) == 1 and found[0]["kind"] == "path" and found[0]["coverage"] >= 0.95
    harness.op("background.remove", {"mode": "replaceColor", "color": "#00ff00"}, sid)
    img = render(_revision(harness, sid))
    assert img.getpixel((5, 5)) == (0, 255, 0)
    assert ink_bbox(img, is_dark) is not None  # text kept
    harness.op("background.remove", {"mode": "remove"}, sid)
    img2 = render(_revision(harness, sid))
    assert img2.getpixel((5, 5)) == (255, 255, 255)
    assert ink_bbox(img2, is_dark) is not None


def test_remove_layer_candidate_deletes_its_content(harness: Harness, tmp_path: Path) -> None:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    ocg = pdf.make_indirect(Dictionary(Type=Name.OCG, Name=pikepdf.String("Watermark nội bộ")))
    pdf.Root.OCProperties = Dictionary(
        OCGs=Array([ocg]), D=Dictionary(Order=Array([ocg]), ON=Array([ocg]))
    )
    page = pdf.pages[0]
    page.obj.Resources = Dictionary(
        Font=Dictionary(F1=helvetica(pdf)), Properties=Dictionary(W=ocg)
    )
    page.obj.Contents = pdf.make_stream(
        b"/OC /W BDC q 1 0 0 rg 100 100 200 200 re f Q EMC\n" + BODY
    )
    path = tmp_path / "layer_rm.pdf"
    pdf.save(path)
    pdf.close()
    sid = _sid(harness, path)
    cand = next(c for c in _detect(harness, sid) if c["kind"] == "layer")
    result = harness.op("watermark.remove", {"candidateIds": [cand["id"]]}, sid)
    assert result["data"]["removedLayers"] == 1
    img = render(_revision(harness, sid))
    assert ink_bbox(img, is_red) is None
    assert ink_bbox(img, is_dark) is not None
