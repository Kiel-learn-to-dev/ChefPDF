"""T7.05 (D11): links.list, links.add, links.update, links.remove, links.autoDetect.

Clicking semantics are checked with PDFium's own link reader: the URI of a link, the page a
destination points to, and the user-space location of an XYZ destination on a rotated page.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pikepdf
import pypdfium2.raw as raw
import pytest
from conftest import Harness, RpcFailure
from text_support import canvas_pdf, put

from chef_core.overlay.pagecontent import page_frame


def _sid(harness: Harness, path: Path) -> str:
    return str(harness.open(path)["state"]["sessionId"])


def _three_page(path: Path, rotate: int = 0, text: str | None = None) -> Path:
    def draw(cv: Any, index: int) -> None:
        put(cv, 72, 700, text or f"Trang {index + 1}", 12)

    return canvas_pdf(path, draw, pages=3, rotate=rotate)


def _with_links(path: Path, pages: int = 2) -> Path:
    """Two pages; page 0 has a URI link, a link to page 1, a named link and a JavaScript link."""
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=(612, 792))
    uri = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Annot,
            Subtype=pikepdf.Name.Link,
            Rect=pikepdf.Array([72, 700, 200, 720]),
            Border=pikepdf.Array([0, 0, 1]),
            A=pikepdf.Dictionary(S=pikepdf.Name.URI, URI=pikepdf.String("https://example.com")),
        )
    )
    goto = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Annot,
            Subtype=pikepdf.Name.Link,
            Rect=pikepdf.Array([72, 600, 200, 620]),
            Dest=pikepdf.Array([pdf.pages[1].obj, pikepdf.Name.Fit]),
        )
    )
    named = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Annot,
            Subtype=pikepdf.Name.Link,
            Rect=pikepdf.Array([72, 500, 200, 520]),
            A=pikepdf.Dictionary(S=pikepdf.Name.Named, N=pikepdf.Name.NextPage),
        )
    )
    js = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Annot,
            Subtype=pikepdf.Name.Link,
            Rect=pikepdf.Array([72, 400, 200, 420]),
            A=pikepdf.Dictionary(S=pikepdf.Name.JavaScript, JS=pikepdf.String("app.alert(1)")),
        )
    )
    pdf.pages[0].obj.Annots = pikepdf.Array([uri, goto, named, js])
    pdf.save(path)
    return path


def _pdfium_links(path: Path, index: int = 0) -> list[dict[str, Any]]:
    """Link annotations as PDFium reads them: rect (user space), URI or destination page."""
    import ctypes

    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(path))
    try:
        page = doc[index]
        out: list[dict[str, Any]] = []
        count = raw.FPDFPage_GetAnnotCount(page.raw)
        for i in range(count):
            annot = raw.FPDFPage_GetAnnot(page.raw, i)
            if raw.FPDFAnnot_GetSubtype(annot) != raw.FPDF_ANNOT_LINK:
                raw.FPDFPage_CloseAnnot(annot)
                continue
            rect = raw.FS_RECTF()
            raw.FPDFAnnot_GetRect(annot, rect)
            entry: dict[str, Any] = {"rect": (rect.left, rect.bottom, rect.right, rect.top)}
            link = raw.FPDFAnnot_GetLink(annot)
            action = raw.FPDFLink_GetAction(link)
            if action:
                kind = raw.FPDFAction_GetType(action)
                entry["actionType"] = kind
                if kind == raw.PDFACTION_URI:
                    size = raw.FPDFAction_GetURIPath(doc.raw, action, None, 0)
                    buf = ctypes.create_string_buffer(size)
                    raw.FPDFAction_GetURIPath(doc.raw, action, buf, size)
                    entry["uri"] = buf.value.decode("ascii")
            dest = raw.FPDFLink_GetDest(doc.raw, link)
            if dest:
                entry["destPage"] = raw.FPDFDest_GetDestPageIndex(doc.raw, dest)
                has_x, has_y, has_zoom = ctypes.c_int(), ctypes.c_int(), ctypes.c_int()
                x, y, zoom = ctypes.c_float(), ctypes.c_float(), ctypes.c_float()
                ok = raw.FPDFDest_GetLocationInPage(dest, has_x, has_y, has_zoom, x, y, zoom)
                entry["destXY"] = (
                    (round(x.value, 2), round(y.value, 2)) if ok and has_x and has_y else None
                )
            out.append(entry)
            raw.FPDFPage_CloseAnnot(annot)
        page.close()
        return out
    finally:
        doc.close()


def test_list_reads_each_kind_and_flags_javascript(harness: Harness, tmp_path: Path) -> None:
    src = _with_links(tmp_path / "links.pdf")
    sid = _sid(harness, src)
    links = harness.op("links.list", {"pageIndex": 0}, sid)["data"]["links"]
    kinds = [ln["kind"] for ln in links]
    assert kinds == ["uri", "page", "named", "javascript"]
    uri, goto, named, js = links
    assert uri["target"] == "https://example.com"
    assert goto["target"] == 1
    assert named["target"] == "NextPage"
    assert js["flagged"] is True
    assert js["target"] is None
    # display frame: origin top-left, y down (page is 792 high)
    assert uri["rect"] == pytest.approx([72, 72, 200, 92], abs=0.01)


def test_add_uri_and_page_links_are_seen_by_pdfium(harness: Harness, tmp_path: Path) -> None:
    src = _three_page(tmp_path / "three.pdf")
    sid = _sid(harness, src)
    uri = harness.op(
        "links.add",
        {
            "pageIndex": 0,
            "rect": [72, 100, 220, 120],
            "kind": "uri",
            "uri": "https://chef.example/a",
        },
        sid,
    )["data"]
    page = harness.op(
        "links.add",
        {
            "pageIndex": 0,
            "rect": [72, 140, 220, 160],
            "kind": "page",
            "targetPage": 2,
            "view": "fit",
        },
        sid,
    )["data"]
    assert uri["id"] != page["id"]
    state = harness.call("session.state", {"sessionId": sid})
    links = _pdfium_links(Path(state["revisionPath"]))
    assert len(links) == 2
    assert links[0]["uri"] == "https://chef.example/a"
    assert links[0]["rect"] == pytest.approx((72, 792 - 120, 220, 792 - 100), abs=0.01)
    assert links[1]["destPage"] == 2


def test_xyz_destination_on_a_rotated_page_points_at_the_displayed_spot(
    harness: Harness, tmp_path: Path
) -> None:
    # /Rotate 90: the displayed top-left corner is the user origin; displayed x runs along the
    # user y axis and displayed downwards runs along the user x axis
    src = _three_page(tmp_path / "rot.pdf", rotate=90)
    sid = _sid(harness, src)
    harness.op(
        "links.add",
        {
            "pageIndex": 0,
            "rect": [72, 100, 220, 120],
            "kind": "page",
            "targetPage": 1,
            "view": "xyz",
            "left": 100,
            "top": 50,
        },
        sid,
    )
    state = harness.call("session.state", {"sessionId": sid})
    links = _pdfium_links(Path(state["revisionPath"]))
    assert links[0]["destPage"] == 1
    assert links[0]["destXY"] == pytest.approx((50.0, 100.0), abs=0.05)


def test_rotated_page_list_reports_display_rects(harness: Harness, tmp_path: Path) -> None:
    src = _three_page(tmp_path / "rot.pdf", rotate=90)
    sid = _sid(harness, src)
    added = harness.op(
        "links.add",
        {"pageIndex": 0, "rect": [72, 100, 220, 120], "kind": "uri", "uri": "https://a.example"},
        sid,
    )["data"]
    links = harness.op("links.list", {"pageIndex": 0}, sid)["data"]["links"]
    assert links[0]["id"] == added["id"]
    assert links[0]["rect"] == pytest.approx([72, 100, 220, 120], abs=0.01)


def test_update_changes_the_link_and_returns_a_new_id(harness: Harness, tmp_path: Path) -> None:
    src = _three_page(tmp_path / "three.pdf")
    sid = _sid(harness, src)
    first = harness.op(
        "links.add",
        {"pageIndex": 0, "rect": [72, 100, 220, 120], "kind": "uri", "uri": "https://a.example"},
        sid,
    )["data"]
    updated = harness.op(
        "links.update",
        {
            "id": first["id"],
            "uri": "https://b.example",
            "borderWidth": 2,
            "color": "#ff0000",
            "highlight": "outline",
        },
        sid,
    )["data"]
    assert updated["id"] != first["id"]
    state = harness.call("session.state", {"sessionId": sid})
    (link,) = _pdfium_links(Path(state["revisionPath"]))
    assert link["uri"] == "https://b.example"
    with pytest.raises(RpcFailure) as exc:
        harness.op("links.update", {"id": first["id"], "uri": "https://c.example"}, sid)
    assert exc.value.error["message"] == "STALE_OBJECT_IDS"


def test_remove_by_ids_and_all(harness: Harness, tmp_path: Path) -> None:
    src = _with_links(tmp_path / "links.pdf")
    sid = _sid(harness, src)
    links = harness.op("links.list", {"pageIndex": 0}, sid)["data"]["links"]
    harness.op("links.remove", {"ids": [links[0]["id"]]}, sid)
    assert len(harness.op("links.list", {"pageIndex": 0}, sid)["data"]["links"]) == 3
    harness.op("links.remove", {"all": True, "pageIndex": 0}, sid)
    assert harness.op("links.list", {"pageIndex": 0}, sid)["data"]["links"] == []


def test_autodetect_creates_uri_links_for_urls_and_emails(harness: Harness, tmp_path: Path) -> None:
    src = _three_page(
        tmp_path / "auto.pdf",
        text="Xem www.example.com hoặc a@b.vn, https://chef.pdf/doc.",
    )
    sid = _sid(harness, src)
    result = harness.op("links.autoDetect", {"pages": [0], "skipExisting": True}, sid)["data"]
    assert result["created"] == 3
    state = harness.call("session.state", {"sessionId": sid})
    uris = [link.get("uri") for link in _pdfium_links(Path(state["revisionPath"]))]
    assert uris == ["https://www.example.com", "mailto:a@b.vn", "https://chef.pdf/doc"]


def test_autodetect_skips_links_that_exist(harness: Harness, tmp_path: Path) -> None:
    src = _three_page(tmp_path / "auto2.pdf", text="Trang có www.example.com ở đây.")
    sid = _sid(harness, src)
    first = harness.op("links.autoDetect", {"pages": [0]}, sid)["data"]
    assert first["created"] == 1
    second = harness.op("links.autoDetect", {"pages": [0], "skipExisting": True}, sid)["data"]
    assert second["created"] == 0


def test_javascript_links_cannot_be_created(harness: Harness, tmp_path: Path) -> None:
    src = _three_page(tmp_path / "js.pdf")
    sid = _sid(harness, src)
    with pytest.raises(RpcFailure):
        harness.op(
            "links.add",
            {"pageIndex": 0, "rect": [72, 100, 220, 120], "kind": "javascript", "uri": "x"},
            sid,
        )


def test_undo_removes_the_added_link(harness: Harness, tmp_path: Path) -> None:
    src = _three_page(tmp_path / "undo.pdf")
    sid = _sid(harness, src)
    harness.op(
        "links.add",
        {"pageIndex": 0, "rect": [72, 100, 220, 120], "kind": "uri", "uri": "https://a.example"},
        sid,
    )
    harness.call("session.undo", {"sessionId": sid})
    assert harness.op("links.list", {"pageIndex": 0}, sid)["data"]["links"] == []


def test_page_frame_helper_matches_the_rotation(tmp_path: Path) -> None:
    src = _three_page(tmp_path / "frame.pdf", rotate=90)
    with pikepdf.open(src) as pdf:
        frame = page_frame(pdf.pages[0])
    assert frame.display_size == (792, 612)
