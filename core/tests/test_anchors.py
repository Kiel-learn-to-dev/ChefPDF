"""Find text anchors and place signatures next to them (T3.12, I26, I27).

The PDFs are generated with reportlab and Be Vietnam Pro, so the drawing positions are known and
the returned rectangles can be checked against them.
"""

from __future__ import annotations

import unicodedata
from pathlib import Path

import pikepdf
import pytest
from conftest import Harness, RpcFailure
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

from chef_core.ops import load_builtin_ops
from chef_core.signing import anchors

REPO_ROOT = Path(__file__).resolve().parents[2]
FONT = REPO_ROOT / "tests" / "corpus" / "fonts" / "BeVietnamPro-Regular.ttf"
SIZE = 14.0
GIAM_DOC_AT = (100.0, 200.0)  # page 0, drawn at this baseline point


@pytest.fixture(autouse=True)
def _builtins() -> None:
    load_builtin_ops()


def _register() -> None:
    if "BeVietnamPro" not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont("BeVietnamPro", str(FONT)))


def _text_width(text: str) -> float:
    _register()
    return float(pdfmetrics.stringWidth(text, "BeVietnamPro", SIZE))


@pytest.fixture
def sample_pdf(tmp_path: Path) -> Path:
    """Five pages (A4):
    0: 'Nguyễn Văn A' above 'GIÁM ĐỐC' at (100, 200)
    1: 'Giám đốc' at (300, 500) and 'PHÓ GIÁM ĐỐC' at (100, 100)
    2: 'TRƯỞNG PHÒNG DOCUMENT' at (100, 400) and 'Giám đốc Sở' at (300, 700)
    3: 'GIÁM ĐỐC' near the bottom edge at (100, 20)
    4: 'GIÁM ĐỐC' near the right edge at (560, 400)
    """
    _register()
    path = tmp_path / "anchors.pdf"
    c = canvas.Canvas(str(path), pagesize=A4)
    c.setFont("BeVietnamPro", SIZE)
    c.drawString(100, 300, "Nguyễn Văn A")
    c.drawString(*GIAM_DOC_AT, "GIÁM ĐỐC")
    c.showPage()
    c.setFont("BeVietnamPro", SIZE)
    c.drawString(300, 500, "Giám đốc")
    c.drawString(100, 100, "PHÓ GIÁM ĐỐC")
    c.showPage()
    c.setFont("BeVietnamPro", SIZE)
    c.drawString(100, 400, "TRƯỞNG PHÒNG DOCUMENT")
    c.drawString(300, 700, "Giám đốc Sở")
    c.showPage()
    c.setFont("BeVietnamPro", SIZE)
    c.drawString(100, 20, "GIÁM ĐỐC")
    c.showPage()
    c.setFont("BeVietnamPro", SIZE)
    c.drawString(560, 400, "GIÁM ĐỐC")
    c.showPage()
    c.save()
    return path


def _rotated_copy(src: Path, dest: Path, rotations: dict[int, int]) -> Path:
    with pikepdf.open(src) as pdf:
        for index, angle in rotations.items():
            pdf.pages[index].obj["/Rotate"] = angle
        pdf.save(dest)
    return dest


def _find(path: Path, text: str, **kwargs: object) -> list[anchors.Match]:
    return anchors.find_anchors(path, text, **kwargs)  # type: ignore[arg-type]


# -- finding anchors ----------------------------------------------------------------------


def test_diacritics_are_ignored_by_default(sample_pdf: Path) -> None:
    matches = _find(sample_pdf, "giam doc")
    assert [m.page_index for m in matches] == [0, 1, 1, 2, 3, 4]


def test_diacritic_sensitive_search_needs_the_marks(sample_pdf: Path) -> None:
    assert _find(sample_pdf, "GIÁM ĐỐC", ignore_diacritics=False, pages=[0])
    assert _find(sample_pdf, "GIAM DOC", ignore_diacritics=False) == []


def test_nfd_and_nfc_queries_match_the_same_text(sample_pdf: Path) -> None:
    nfc = unicodedata.normalize("NFC", "GIÁM ĐỐC")
    nfd = unicodedata.normalize("NFD", "GIÁM ĐỐC")
    assert nfc != nfd
    a = _find(sample_pdf, nfc)
    b = _find(sample_pdf, nfd)
    c = _find(sample_pdf, nfd, ignore_diacritics=False)
    assert len(a) == len(b) == len(c) == 6


def test_case_insensitive_by_default_and_case_sensitive_on_request(sample_pdf: Path) -> None:
    assert len(_find(sample_pdf, "GIÁM ĐỐC")) == 6
    upper_only = _find(sample_pdf, "GIÁM ĐỐC", case_sensitive=True)
    assert [m.page_index for m in upper_only] == [0, 1, 3, 4]


def test_whole_word_rejects_partial_words(sample_pdf: Path) -> None:
    whole = _find(sample_pdf, "doc")
    partial = _find(sample_pdf, "doc", whole_word=False)
    # 'DOCUMENT' on page 2 only matches without whole-word matching.
    assert len(partial) == len(whole) + 1
    assert [m.page_index for m in whole] == [0, 1, 1, 2, 3, 4]


def test_page_filter_and_result_limit(sample_pdf: Path) -> None:
    assert [m.page_index for m in _find(sample_pdf, "giam doc", pages=[1])] == [1, 1]
    assert len(_find(sample_pdf, "giam doc", max_results=2)) == 2
    assert _find(sample_pdf, "   ") == []
    assert _find(sample_pdf, "khong ton tai") == []


def test_match_rect_is_near_the_drawn_position(sample_pdf: Path) -> None:
    (match,) = _find(sample_pdf, "GIÁM ĐỐC", pages=[0])
    x1, y1, x2, y2 = match.rect
    assert x1 == pytest.approx(GIAM_DOC_AT[0], abs=3)
    # Capitals without descenders: pdfium puts the bottom of the box on the baseline.
    assert y1 == pytest.approx(GIAM_DOC_AT[1], abs=3)
    # The top includes the accent on 'Á' (about 1.1 em above the baseline).
    assert GIAM_DOC_AT[1] + 0.7 * SIZE <= y2 <= GIAM_DOC_AT[1] + 1.3 * SIZE
    assert x2 - x1 == pytest.approx(_text_width("GIÁM ĐỐC"), abs=3)


def test_context_is_taken_from_the_page_text(sample_pdf: Path) -> None:
    (match,) = _find(sample_pdf, "GIÁM ĐỐC", pages=[0])
    assert "Nguyễn Văn A" in match.context_before
    assert match.context_after == ""


def test_rotation_does_not_change_user_space_rect(sample_pdf: Path, tmp_path: Path) -> None:
    rotated = _rotated_copy(sample_pdf, tmp_path / "rot.pdf", {0: 90, 1: 270, 2: 180})
    plain = _find(sample_pdf, "GIÁM ĐỐC", pages=[0])[0]
    turned = _find(rotated, "GIÁM ĐỐC", pages=[0])[0]
    assert turned.rect == pytest.approx(plain.rect, abs=0.01)


def test_display_mapping_matches_a_rendered_page(tmp_path: Path) -> None:
    """The displayed frame used by placement is the frame a reader shows: the box predicted
    for each /Rotate matches the dark pixels pdfium renders (scale 1, top-left origin)."""
    import pypdfium2 as pdfium

    _register()
    single = tmp_path / "single.pdf"
    c = canvas.Canvas(str(single), pagesize=A4)
    c.setFont("BeVietnamPro", 30)
    c.drawString(*GIAM_DOC_AT, "GIÁM ĐỐC")
    c.showPage()
    c.save()
    for rotation in (0, 90, 180, 270):
        dst = _rotated_copy(single, tmp_path / f"r{rotation}.pdf", {0: rotation})
        doc = pdfium.PdfDocument(str(dst))
        try:
            image = doc[0].render(scale=1).to_pil().convert("L")
        finally:
            doc.close()
        ink = image.point(lambda v: 255 if v < 128 else 0)
        rendered = ink.getbbox()
        assert rendered is not None
        frame = anchors.page_frames(dst)[0]
        match = _find(dst, "GIÁM ĐỐC", pages=[0])[0]
        x1, y1, x2, y2 = frame.rect_to_display(match.rect)
        height = frame.display_size[1]
        predicted = (x1, height - y2, x2, height - y1)
        for got, want in zip(rendered, predicted, strict=True):
            assert got == pytest.approx(want, abs=3.0), (rotation, rendered, predicted)


# -- placement ------------------------------------------------------------------------------


def _place(path: Path, text: str, **kwargs: object) -> tuple[list[anchors.Placement], int]:
    found = _find(path, text)
    frames = anchors.page_frames(path)
    return anchors.place(found, frames, **kwargs)  # type: ignore[arg-type]


def test_below_is_centred_under_the_anchor(sample_pdf: Path) -> None:
    placed, skipped = _place(
        sample_pdf, "GIÁM ĐỐC", width=120, height=40, position="below", gap=4, align="center"
    )
    assert skipped == 0
    first = next(p for p in placed if p.page_index == 0)
    x1, y1, x2, y2 = first.rect
    assert x2 - x1 == pytest.approx(120)
    assert y2 - y1 == pytest.approx(40)
    anchor_x1, anchor_y1, anchor_x2, _ = _find(sample_pdf, "GIÁM ĐỐC", pages=[0])[0].rect
    assert (x1 + x2) / 2 == pytest.approx((anchor_x1 + anchor_x2) / 2, abs=0.01)
    assert y2 == pytest.approx(anchor_y1 - 4, abs=0.01)


@pytest.mark.parametrize(
    ("align", "expected"),
    [("left", "left"), ("center", "center"), ("right", "right")],
)
def test_align_for_below(sample_pdf: Path, align: str, expected: str) -> None:
    placed, _ = _place(sample_pdf, "GIÁM ĐỐC", width=120, height=40, position="below", align=align)
    x1 = next(p for p in placed if p.page_index == 0).rect[0]
    anchor_x1, _, anchor_x2, _ = _find(sample_pdf, "GIÁM ĐỐC", pages=[0])[0].rect
    expected_x1 = {
        "left": anchor_x1,
        "center": (anchor_x1 + anchor_x2) / 2 - 60,
        "right": anchor_x2 - 120,
    }[expected]
    assert x1 == pytest.approx(expected_x1, abs=0.01)


def test_above_right_left_and_over(sample_pdf: Path) -> None:
    anchor = _find(sample_pdf, "GIÁM ĐỐC", pages=[0])[0].rect
    ax1, _, ax2, ay2 = anchor
    above, _ = _place(sample_pdf, "GIÁM ĐỐC", width=60, height=20, position="above", gap=4)
    right, _ = _place(sample_pdf, "GIÁM ĐỐC", width=60, height=20, position="right", gap=4)
    left, _ = _place(sample_pdf, "GIÁM ĐỐC", width=60, height=20, position="left", gap=4)
    over, _ = _place(sample_pdf, "GIÁM ĐỐC", width=60, height=20, position="over")
    rect_above = next(p.rect for p in above if p.page_index == 0)
    rect_right = next(p.rect for p in right if p.page_index == 0)
    rect_left = next(p.rect for p in left if p.page_index == 0)
    rect_over = next(p.rect for p in over if p.page_index == 0)
    assert rect_above[1] == pytest.approx(ay2 + 4, abs=0.01)
    assert rect_right[0] == pytest.approx(ax2 + 4, abs=0.01)
    assert rect_left[2] == pytest.approx(ax1 - 4, abs=0.01)
    assert (rect_over[0] + rect_over[2]) / 2 == pytest.approx((ax1 + ax2) / 2, abs=0.01)


def test_offsets_move_the_box(sample_pdf: Path) -> None:
    base, _ = _place(sample_pdf, "GIÁM ĐỐC", width=60, height=20, position="below")
    moved, _ = _place(
        sample_pdf, "GIÁM ĐỐC", width=60, height=20, position="below", offset_x=10, offset_y=-5
    )
    b = next(p.rect for p in base if p.page_index == 0)
    m = next(p.rect for p in moved if p.page_index == 0)
    assert m[0] == pytest.approx(b[0] + 10, abs=0.01)
    assert m[1] == pytest.approx(b[1] - 5, abs=0.01)


def test_clamp_keeps_the_box_on_the_page(sample_pdf: Path) -> None:
    placed, skipped = _place(
        sample_pdf, "GIÁM ĐỐC", width=120, height=60, position="below", clamp=True
    )
    assert skipped == 0
    bottom_page = next(p.rect for p in placed if p.page_index == 3)
    assert bottom_page[1] == pytest.approx(0, abs=0.01)
    assert bottom_page[3] == pytest.approx(60, abs=0.01)
    right_page = next(p.rect for p in placed if p.page_index == 4)
    assert right_page[2] <= A4[0] + 0.01
    assert right_page[2] == pytest.approx(A4[0], abs=0.01)


def test_without_clamp_edge_overlaps_are_skipped(sample_pdf: Path) -> None:
    placed, skipped = _place(
        sample_pdf, "GIÁM ĐỐC", width=120, height=60, position="below", clamp=False
    )
    assert skipped == 2  # bottom edge (page 3) and right edge (page 4)
    assert {p.page_index for p in placed} == {0, 1, 2}


def test_rotated_page_below_means_displayed_below(sample_pdf: Path, tmp_path: Path) -> None:
    """With /Rotate 90 the displayed bottom edge is the user-space right edge, so 'below'
    moves the box towards larger x in user space."""
    rotated = _rotated_copy(sample_pdf, tmp_path / "rot90.pdf", {0: 90})
    anchor = _find(rotated, "GIÁM ĐỐC", pages=[0])[0].rect
    placed, _ = _place(rotated, "GIÁM ĐỐC", width=60, height=20, position="over")
    assert placed
    placed_below, _ = _place(rotated, "GIÁM ĐỐC", width=60, height=20, position="below", gap=4)
    box = next(p.rect for p in placed_below if p.page_index == 0)
    assert box[0] == pytest.approx(anchor[2] + 4, abs=0.01)
    # width/height are the displayed size: on a 90 page the user-space width is the height
    assert box[2] - box[0] == pytest.approx(20, abs=0.01)
    assert box[3] - box[1] == pytest.approx(60, abs=0.01)


def test_rotated_page_rect_stays_in_user_space(sample_pdf: Path, tmp_path: Path) -> None:
    rotated = _rotated_copy(sample_pdf, tmp_path / "rot270.pdf", {0: 270})
    frames = anchors.page_frames(rotated)
    assert frames[0].rotation == 270
    placed, _ = _place(rotated, "GIÁM ĐỐC", width=60, height=20, position="left", gap=4)
    box = next(p.rect for p in placed if p.page_index == 0)
    anchor = _find(rotated, "GIÁM ĐỐC", pages=[0])[0].rect
    # Displayed 'left' on a 270 page is the user-space top edge side.
    assert box[1] == pytest.approx(anchor[3] + 4, abs=0.01)


def test_placement_op_returns_boxes_and_uses_the_session(
    harness: Harness, sample_pdf: Path
) -> None:
    sid: str = harness.open(sample_pdf)["state"]["sessionId"]
    found = harness.op("sign.findAnchors", {"text": "giam doc"}, session_id=sid)
    matches = found["data"]["matches"]
    assert len(matches) == 6
    placed = harness.op(
        "sign.placeFromAnchor",
        {
            "anchors": [{"pageIndex": m["pageIndex"], "rect": m["rect"]} for m in matches],
            "width": 150,
            "height": 50,
            "position": "below",
        },
        session_id=sid,
    )
    data = placed["data"]
    assert data["skipped"] == 0  # clampToPage is on by default
    assert len(data["placements"]) == 6
    assert placed["changedPages"] == []
    unclamped = harness.op(
        "sign.placeFromAnchor",
        {
            "anchors": [{"pageIndex": m["pageIndex"], "rect": m["rect"]} for m in matches],
            "width": 150,
            "height": 50,
            "position": "below",
            "clampToPage": False,
        },
        session_id=sid,
    )
    assert unclamped["data"]["skipped"] == 2


def test_find_op_rejects_empty_text(harness: Harness, sample_pdf: Path) -> None:
    sid: str = harness.open(sample_pdf)["state"]["sessionId"]
    with pytest.raises(RpcFailure) as exc:
        harness.call(
            "ops.run", {"opId": "sign.findAnchors", "params": {"text": ""}, "sessionId": sid}
        )
    assert exc.value.kind == "INVALID_PARAMS"


# -- fixed positions (I27) -----------------------------------------------------------------


def test_fixed_rect_corners() -> None:
    assert anchors.fixed_rect((595, 842), "bottom-right", 100, 50, 20) == [475, 20, 575, 70]
    assert anchors.fixed_rect((595, 842), "top-left", 100, 50, 20) == [20, 772, 120, 822]
    assert anchors.fixed_rect((595, 842), "bottom-left", 100, 50, 0) == [0, 0, 100, 50]


def test_fixed_rect_rejects_oversized_box() -> None:
    with pytest.raises(ValueError):
        anchors.fixed_rect((100, 100), "top-right", 120, 20, 0)
