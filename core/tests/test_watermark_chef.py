"""Defect 1 of the core review: watermarks that Chef PDF adds (``overlay.watermark``) and the
Acrobat-style watermarks (tagged artifact, OCG named Watermark) are listed by ``watermark.detect``
and removed by ``watermark.remove`` so that the pages render as before and no Chef marker remains.
"""

from __future__ import annotations

from pathlib import Path

import pikepdf
from conftest import Harness
from content_support import helvetica, raw_pdf
from pdf_media import mean_abs_diff, render
from pikepdf import Array, Dictionary, Name
from PIL import Image

PAGES = 20
BODY = b"BT /F1 12 Tf 60 650 Td (Body text line) Tj ET BT /F1 12 Tf 60 400 Td (Second line) Tj ET"
TAGGED_TEXT = (
    b"/Artifact <</Type /Pagination /Subtype /Watermark>> BDC "
    b"BT /F1 48 Tf 100 300 Td (MAT) Tj ET EMC\n"
)
LAYER_TEXT = b"/OC /W BDC BT /F1 60 Tf 100 300 Td (LAYERED) Tj ET EMC\n"
TOLERANCE = 0.5  # mean absolute difference per channel, 0..255


def _sid(harness: Harness, path: Path) -> str:
    return str(harness.open(path)["state"]["sessionId"])


def _revision(harness: Harness, sid: str) -> Path:
    return Path(harness.call("session.state", {"sessionId": sid})["revisionPath"])


def _detect(harness: Harness, sid: str) -> list[dict]:
    """The tagged, layer, annotation and overlay candidates. The body text repeats on every
    test page, so the repeated-object heuristic (tier 5) is left out of these checks."""
    cands = list(harness.op("watermark.detect", {}, sid)["data"]["candidates"])
    return [c for c in cands if c["tier"] != 5]


def _saved_bytes(path: Path) -> bytes:
    """The raw file and every decoded stream: compressed streams hide their text otherwise."""
    parts = [path.read_bytes()]
    with pikepdf.open(path) as pdf:
        for obj in pdf.objects:
            if isinstance(obj, pikepdf.Stream):
                parts.append(obj.read_bytes())
    return b"\n".join(parts)


def _assert_same_pages(before: Path, after: Path) -> None:
    for index in range(PAGES):
        diff = mean_abs_diff(render(before, index), render(after, index))
        assert diff < TOLERANCE, f"page {index} differs by {diff:.3f}"


def _plain(path: Path) -> Path:
    return raw_pdf(path, BODY, pages=PAGES)


def _layer_pdf(path: Path, content: bytes) -> Path:
    pdf = pikepdf.new()
    for _ in range(PAGES):
        pdf.add_blank_page(page_size=(612, 792))
    ocg = pdf.make_indirect(Dictionary(Type=Name.OCG, Name=pikepdf.String("Watermark")))
    pdf.Root.OCProperties = Dictionary(
        OCGs=Array([ocg]), D=Dictionary(Order=Array([ocg]), ON=Array([ocg]))
    )
    for page in pdf.pages:
        page.obj.Resources = Dictionary(
            Font=Dictionary(F1=helvetica(pdf)), Properties=Dictionary(W=ocg)
        )
        page.obj.Contents = pdf.make_stream(content)
    pdf.save(path)
    pdf.close()
    return path


def _tagged_form_pdf(path: Path) -> Path:
    """Acrobat-style: ``/Artifact`` watermark that draws a Form XObject with Do."""
    pdf = pikepdf.new()
    for _ in range(PAGES):
        pdf.add_blank_page(page_size=(612, 792))
    form_body = b"BT /F1 48 Tf 100 100 Td (FORMWM) Tj ET"
    for page in pdf.pages:
        form = pdf.make_stream(form_body)
        form.Type = Name.XObject
        form.Subtype = Name.Form
        form.BBox = Array([0, 0, 612, 792])
        form.Resources = Dictionary(Font=Dictionary(F1=helvetica(pdf)))
        page.obj.Resources = Dictionary(
            Font=Dictionary(F1=helvetica(pdf)), XObject=Dictionary(Wm=form)
        )
        page.obj.Contents = pdf.make_stream(
            b"/Artifact <</Type /Pagination /Subtype /Watermark>> BDC q /Wm Do Q EMC\n" + BODY
        )
    pdf.save(path)
    pdf.close()
    return path


def _png(path: Path) -> Path:
    Image.new("RGB", (200, 100), (200, 30, 30)).save(path)
    return path


TEXT_CENTER = {"text": "BẢN NHÁP", "mode": "center", "fontSize": 40}
TEXT_TILED = {"text": "BẢN NHÁP", "mode": "tiled", "fontSize": 40, "spacing": 30}


def test_chef_text_watermark_is_listed_exactly(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, _plain(tmp_path / "base.pdf"))
    harness.op("overlay.watermark", TEXT_CENTER, sid)
    cands = _detect(harness, sid)
    assert [c["kind"] for c in cands] == ["overlay"]
    cand = cands[0]
    assert cand["tier"] == 4
    assert cand["confidence"] == 1.0
    assert cand["pages"] == list(range(PAGES))
    assert len(cand["overlayIds"]) == 1
    assert cand["objectRefs"], "the page-level Do of the watermark is referenced"


def test_chef_tiled_and_image_watermarks_are_listed(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, _plain(tmp_path / "tiled.pdf"))
    harness.op("overlay.watermark", TEXT_TILED, sid)
    sid2 = _sid(harness, _plain(tmp_path / "image.pdf"))
    harness.op("overlay.watermark", {"path": str(_png(tmp_path / "logo.png")), "width": 150}, sid2)
    for session in (sid, sid2):
        cands = _detect(harness, session)
        assert [c["kind"] for c in cands] == ["overlay"]
        assert cands[0]["confidence"] == 1.0
        assert cands[0]["pages"] == list(range(PAGES))


def test_chef_watermark_removal_restores_every_page(harness: Harness, tmp_path: Path) -> None:
    base = _plain(tmp_path / "base.pdf")
    for label, opts in (("center", TEXT_CENTER), ("tiled", TEXT_TILED)):
        sid = _sid(harness, base)
        harness.op("overlay.watermark", opts, sid)
        cand = _detect(harness, sid)[0]
        result = harness.op("watermark.remove", {"candidateIds": [cand["id"]]}, sid)
        assert result["data"]["removedOverlays"] == 1, label
        assert _detect(harness, sid) == [], label
        after = _revision(harness, sid)
        _assert_same_pages(base, after)
        assert b"ChefOverlay" not in _saved_bytes(after), label
        assert b"ChefWrap" not in _saved_bytes(after), label


def test_chef_image_watermark_removal_restores_pages(harness: Harness, tmp_path: Path) -> None:
    base = _plain(tmp_path / "base.pdf")
    sid = _sid(harness, base)
    harness.op("overlay.watermark", {"path": str(_png(tmp_path / "logo.png")), "width": 150}, sid)
    harness.op("watermark.remove", {"all": True}, sid)
    assert _detect(harness, sid) == []
    after = _revision(harness, sid)
    _assert_same_pages(base, after)
    assert b"ChefOverlay" not in _saved_bytes(after)


def test_chef_watermark_is_removed_by_pages_selection(harness: Harness, tmp_path: Path) -> None:
    sid = _sid(harness, _plain(tmp_path / "pages.pdf"))
    harness.op("overlay.watermark", TEXT_CENTER, sid)
    cand = _detect(harness, sid)[0]
    # an overlay spread over every page is only removed when all its pages are chosen
    partial = harness.op("watermark.remove", {"candidateIds": [cand["id"]], "pages": [0, 1]}, sid)
    assert partial["data"]["removedOverlays"] == 0
    assert _detect(harness, sid)


def test_acrobat_tagged_text_watermark_round_trip(harness: Harness, tmp_path: Path) -> None:
    base = raw_pdf(tmp_path / "ref.pdf", BODY, pages=PAGES)
    path = raw_pdf(tmp_path / "acro.pdf", TAGGED_TEXT + BODY, pages=PAGES)
    sid = _sid(harness, path)
    cands = _detect(harness, sid)
    assert cands[0]["kind"] == "artifact"
    assert cands[0]["confidence"] == 0.95
    assert cands[0]["pages"] == list(range(PAGES))
    harness.op("watermark.remove", {"candidateIds": [cands[0]["id"]]}, sid)
    assert _detect(harness, sid) == []
    _assert_same_pages(base, _revision(harness, sid))


def test_acrobat_tagged_form_watermark_round_trip(harness: Harness, tmp_path: Path) -> None:
    base = raw_pdf(tmp_path / "ref.pdf", BODY, pages=PAGES)
    path = _tagged_form_pdf(tmp_path / "acro_form.pdf")
    sid = _sid(harness, path)
    cands = _detect(harness, sid)
    assert [c["kind"] for c in cands] == ["artifact"]
    assert cands[0]["pages"] == list(range(PAGES))
    harness.op("watermark.remove", {"candidateIds": [cands[0]["id"]]}, sid)
    assert _detect(harness, sid) == []
    _assert_same_pages(base, _revision(harness, sid))


def test_layer_named_watermark_round_trip(harness: Harness, tmp_path: Path) -> None:
    base = raw_pdf(tmp_path / "ref.pdf", BODY, pages=PAGES)
    path = _layer_pdf(tmp_path / "layer.pdf", LAYER_TEXT + BODY)
    sid = _sid(harness, path)
    cands = _detect(harness, sid)
    assert [c["kind"] for c in cands] == ["layer"]
    assert cands[0]["confidence"] == 0.9
    harness.op("watermark.remove", {"candidateIds": [cands[0]["id"]]}, sid)
    assert _detect(harness, sid) == []
    _assert_same_pages(base, _revision(harness, sid))


def test_form_children_inherit_the_marks_around_do(tmp_path: Path) -> None:
    """The engine gives the objects drawn by a form the marked content of the Do (defect 1)."""
    from chef_core.content.engine import build_model

    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    page = pdf.pages[0]
    form = pdf.make_stream(b"BT /F1 40 Tf 100 100 Td (CHILD) Tj ET")
    form.Type = Name.XObject
    form.Subtype = Name.Form
    form.BBox = Array([0, 0, 612, 792])
    form.Resources = Dictionary(Font=Dictionary(F1=helvetica(pdf)))
    page.obj.Resources = Dictionary(Font=Dictionary(F1=helvetica(pdf)), XObject=Dictionary(Wm=form))
    page.obj.Contents = pdf.make_stream(
        b"/Artifact <</Type /Pagination /Subtype /Watermark>> BDC q /Wm Do Q EMC"
    )
    model = build_model(pdf, page, 0)
    child = next(o for o in model.objects if o.kind == "text")
    assert not child.in_page
    assert child.marks == ["Artifact"]
    form_obj = next(o for o in model.objects if o.kind == "form")
    assert form_obj.marks == ["Artifact"]
    assert child.parent_id == form_obj.id
