"""Document utilities (M7-M11; T5.08): images, text, attachments, metadata, web and repair."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pikepdf
import pytest
from conftest import Harness, RpcFailure
from pdf_builders import jpeg_image_pdf, plain, with_embedded


def _open(h: Harness, path: Path) -> str:
    sid: str = h.open(path)["state"]["sessionId"]
    return sid


# -- M7: images and text -------------------------------------------------------------------


def test_extract_images_keeps_jpeg_bytes_and_writes_png_for_the_rest(
    harness: Harness, tmp_path: Path
) -> None:
    sid = _open(harness, jpeg_image_pdf(tmp_path / "img.pdf"))
    out = tmp_path / "images"
    result = harness.op("doc.extractImages", {"outputDir": str(out)}, sid)
    names = sorted(p.name for p in out.iterdir())
    assert names == ["1_1.jpg", "1_2.png"]
    assert result["data"]["count"] == 2
    assert (out / "1_1.jpg").read_bytes()[:2] == b"\xff\xd8"  # original JPEG bytes
    assert (out / "1_2.png").read_bytes()[:4] == b"\x89PNG"
    with pikepdf.open(tmp_path / "img.pdf") as pdf:  # the document itself is unchanged
        assert len(pdf.pages) == 1
    assert result["state"]["revision"] == 0


def test_extract_images_name_template_and_page_selection(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, jpeg_image_pdf(tmp_path / "img.pdf"))
    out = tmp_path / "sel"
    harness.op(
        "doc.extractImages",
        {"outputDir": str(out), "pages": [0], "nameTemplate": "{name}-p{page}-{index}"},
        sid,
    )
    assert sorted(p.name for p in out.iterdir()) == ["img-p1-1.jpg", "img-p1-2.png"]


def test_extract_images_rejects_empty_page_list(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, jpeg_image_pdf(tmp_path / "img.pdf"))
    with pytest.raises(RpcFailure) as exc:
        harness.op("doc.extractImages", {"outputDir": str(tmp_path / "x"), "pages": []}, sid)
    assert exc.value.kind == "INVALID_PARAMS"


def test_extract_text_whole_and_with_markers(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path
) -> None:
    sid = _open(harness, corpus["vietnamese_text.pdf"])
    out = tmp_path / "text.txt"
    result = harness.op("doc.extractText", {"outputPath": str(out)}, sid)
    text = out.read_text(encoding="utf-8")
    assert "CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM" in text
    assert result["data"]["pages"] == 3
    assert "--- Trang" not in text  # the document's own "Trang 1 / 3" footer is kept

    marked = tmp_path / "marked.txt"
    harness.op("doc.extractText", {"outputPath": str(marked), "pageMarkers": True}, sid)
    assert "--- Trang 2 ---" in marked.read_text(encoding="utf-8")


# -- M8: attachments -----------------------------------------------------------------------


def test_attachments_list_add_extract_remove(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, with_embedded(tmp_path / "att.pdf"))
    data = harness.op("doc.attachments.list", {}, sid)["data"]
    assert [a["name"] for a in data] == ["secret.txt"]
    assert data[0]["size"] == len(b"internal notes")

    extra = tmp_path / "phu luc.txt"
    extra.write_bytes(b"appendix")
    harness.op("doc.attachments.add", {"paths": [str(extra)]}, sid)
    names = [a["name"] for a in harness.op("doc.attachments.list", {}, sid)["data"]]
    assert sorted(names) == ["phu luc.txt", "secret.txt"]

    with pytest.raises(RpcFailure) as exc:
        harness.op("doc.attachments.add", {"paths": [str(extra)]}, sid)
    assert exc.value.kind == "INVALID_PARAMS"

    out = tmp_path / "saved"
    harness.op("doc.attachments.extract", {"outputDir": str(out), "names": ["secret.txt"]}, sid)
    assert (out / "secret.txt").read_bytes() == b"internal notes"

    harness.op("doc.attachments.remove", {"names": ["secret.txt"]}, sid)
    harness.op("doc.attachments.remove", {"names": ["phu luc.txt"]}, sid)
    assert harness.op("doc.attachments.list", {}, sid)["data"] == []
    with pytest.raises(RpcFailure) as exc:
        harness.op("doc.attachments.remove", {"names": ["ghost.txt"]}, sid)
    assert exc.value.kind == "INVALID_PARAMS"


def test_attachment_changes_are_saved(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, with_embedded(tmp_path / "att.pdf"))
    harness.op("doc.attachments.remove", {"names": ["secret.txt"]}, sid)
    out = tmp_path / "out.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(out)})
    with pikepdf.open(out) as pdf:
        assert len(pdf.attachments) == 0


# -- M9: metadata --------------------------------------------------------------------------


def test_set_metadata_writes_info_and_xmp_together(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, plain(tmp_path / "m.pdf", 1))
    result = harness.op(
        "doc.setMetadata",
        {
            "title": "Hop dong thue nha",
            "author": "Le Thi B",
            "subject": "Thue nha",
            "keywords": "hop dong, nha",
            "creator": "Chef PDF",
            "creationDate": "2024-03-01T09:30:00+07:00",
            "custom": {"Phong ban": "Kinh doanh"},
        },
        sid,
    )
    assert result["data"]["metadata"]["Title"] == "Hop dong thue nha"
    out = tmp_path / "meta_out.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(out)})
    with pikepdf.open(out) as pdf:
        assert str(pdf.docinfo["/Title"]) == "Hop dong thue nha"
        assert str(pdf.docinfo["/Author"]) == "Le Thi B"
        assert str(pdf.docinfo["/Phong ban"]) == "Kinh doanh"
        assert str(pdf.docinfo["/CreationDate"]).startswith("D:20240301093000+07")
        with pdf.open_metadata() as xmp:
            assert xmp["dc:title"] == "Hop dong thue nha"
            assert "Le Thi B" in list(xmp["dc:creator"])
            assert xmp["xmp:CreatorTool"] == "Chef PDF"
            assert xmp["pdf:Keywords"] == "hop dong, nha"
            assert xmp["xmp:CreateDate"].startswith("2024-03-01T09:30:00")


def test_set_metadata_empty_string_removes_and_clear_wipes(
    harness: Harness, tmp_path: Path
) -> None:
    sid = _open(harness, with_embedded(tmp_path / "m2.pdf"))
    harness.op("doc.setMetadata", {"title": "Ten cu", "author": "A"}, sid)
    harness.op("doc.setMetadata", {"author": ""}, sid)
    out = tmp_path / "step.pdf"
    harness.call("session.save", {"sessionId": sid, "path": str(out)})
    with pikepdf.open(out) as pdf:
        assert "/Author" not in pdf.docinfo and str(pdf.docinfo["/Title"]) == "Ten cu"

    result = harness.op("doc.setMetadata", {"clear": True, "subject": "Moi"}, sid)
    assert result["data"]["metadata"] == {"Subject": "Moi"}


def test_set_metadata_rejects_bad_dates(harness: Harness, tmp_path: Path) -> None:
    sid = _open(harness, plain(tmp_path / "m3.pdf", 1))
    with pytest.raises(RpcFailure) as exc:
        harness.op("doc.setMetadata", {"modDate": "hom qua"}, sid)
    assert exc.value.kind == "INVALID_PARAMS"


# -- M10: web optimisation -----------------------------------------------------------------


def test_optimize_web_writes_a_linearized_copy(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path
) -> None:
    out = tmp_path / "web.pdf"
    result = harness.op(
        "doc.optimizeWeb",
        {"inputPath": str(corpus["outline_10p.pdf"]), "outputPath": str(out)},
    )
    assert result["outputs"] == [str(out)]
    data = result["data"]
    assert data["beforeBytes"] == corpus["outline_10p.pdf"].stat().st_size
    assert data["afterBytes"] == out.stat().st_size
    with pikepdf.open(out) as pdf:
        assert pdf.is_linearized and len(pdf.pages) == 10


def test_optimize_web_warns_when_encryption_is_dropped(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path
) -> None:
    out = tmp_path / "web_plain.pdf"
    result = harness.op(
        "doc.optimizeWeb",
        {
            "inputPath": str(corpus["encrypted_1234.pdf"]),
            "inputPassword": "1234",
            "outputPath": str(out),
        },
    )
    assert any("encrypt" in w.lower() for w in result["warnings"])
    with pikepdf.open(out) as pdf:
        assert not pdf.is_encrypted


# -- M11: repair ---------------------------------------------------------------------------


def _damage(src: Path, dest: Path, transform: Callable[[bytes], bytes]) -> Path:
    dest.write_bytes(transform(src.read_bytes()))
    return dest


def test_repair_damaged_xref_recovers_all_pages(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path
) -> None:
    def bad_xref(data: bytes) -> bytes:
        index = data.rindex(b"startxref")
        return data[:index] + b"startxref\n999999\n%%EOF\n"

    src = _damage(corpus["outline_10p.pdf"], tmp_path / "bad_xref.pdf", bad_xref)
    out = tmp_path / "fixed.pdf"
    result = harness.op("doc.repair", {"inputPath": str(src), "outputPath": str(out)})
    assert result["data"]["recovered"] is True and result["data"]["pageCount"] == 10
    assert result["data"]["warnings"]
    with pikepdf.open(out) as pdf:
        assert len(pdf.pages) == 10 and not pdf.get_warnings()


def test_repair_missing_endobj_is_recovered(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path
) -> None:
    src = _damage(
        corpus["vietnamese_text.pdf"],
        tmp_path / "no_endobj.pdf",
        lambda data: data.replace(b"endobj", b"", 2),
    )
    out = tmp_path / "fixed2.pdf"
    result = harness.op("doc.repair", {"inputPath": str(src), "outputPath": str(out)})
    assert result["data"]["pageCount"] == 3
    with pikepdf.open(out) as pdf:
        assert len(pdf.pages) == 3


def test_repair_reconstructs_a_file_without_xref(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path
) -> None:
    out = tmp_path / "from_damaged.pdf"
    result = harness.op(
        "doc.repair",
        {"inputPath": str(corpus["damaged_recoverable.pdf"]), "outputPath": str(out)},
    )
    assert result["data"]["recovered"] is True and result["data"]["pageCount"] == 10


def test_repair_clean_file_reports_nothing_recovered(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path
) -> None:
    out = tmp_path / "clean.pdf"
    result = harness.op(
        "doc.repair", {"inputPath": str(corpus["vietnamese_text.pdf"]), "outputPath": str(out)}
    )
    assert result["data"]["recovered"] is False and result["data"]["warnings"] == []


def test_repair_unrecoverable_is_invalid_pdf(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path
) -> None:
    out = tmp_path / "never.pdf"
    for name in ("corrupt_truncated.pdf", "corrupt_garbage.pdf"):
        with pytest.raises(RpcFailure) as exc:
            harness.op("doc.repair", {"inputPath": str(corpus[name]), "outputPath": str(out)})
        assert exc.value.kind == "INVALID_PDF"
    assert not out.exists()
