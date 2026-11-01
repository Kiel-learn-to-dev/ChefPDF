"""T10.04 (N4): EPUB 3 and ODT packages. Structural checks only: zip order, compression, required
parts, well-formed XML and the references between parts. No reader was available to open them."""

from __future__ import annotations

import io
import posixpath
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from export_support import reference_model, reference_pdf

from chef_core.export.assets import Assets
from chef_core.export.epub import build_epub, chapters_of
from chef_core.export.ir import Heading, build_ir
from chef_core.export.odt import build_odt, write_odt
from chef_core.export.options import ExportOptions
from chef_core.layout.model import DocModel

NS_OPF = {"opf": "http://www.idpf.org/2007/opf", "dc": "http://purl.org/dc/elements/1.1/"}
NS_XHTML = {"x": "http://www.w3.org/1999/xhtml", "epub": "http://www.idpf.org/2007/ops"}


def _zip(data: bytes) -> zipfile.ZipFile:
    return zipfile.ZipFile(io.BytesIO(data))


def _xml(zf: zipfile.ZipFile, name: str) -> ET.Element:
    return ET.fromstring(zf.read(name))  # raises if not well-formed


def _epub(model: DocModel | None = None, pdf: Path | None = None, **kw: str | int) -> bytes:
    model = model or reference_model()
    opts = ExportOptions()
    assets = Assets(pdf) if pdf else None
    try:
        ir = build_ir(model, assets, opts)
        data, _ = build_epub(ir, str(kw.get("mode", "heading1")), int(kw.get("per", 10)))
    finally:
        if assets is not None:
            assets.close()
    return data


def _resolve(base: str, href: str) -> str:
    return posixpath.normpath(posixpath.join(posixpath.dirname(base), href.split("#")[0]))


# -- EPUB --------------------------------------------------------------------------------------


def test_epub_mimetype_is_the_first_entry_and_stored() -> None:
    zf = _zip(_epub())
    first = zf.infolist()[0]
    assert first.filename == "mimetype"
    assert first.compress_type == zipfile.ZIP_STORED
    assert zf.read("mimetype") == b"application/epub+zip"
    assert zf.testzip() is None


def test_epub_container_points_to_the_package() -> None:
    zf = _zip(_epub())
    container = _xml(zf, "META-INF/container.xml")
    rootfile = container.find(".//{urn:oasis:names:tc:opendocument:xmlns:container}rootfile")
    assert rootfile is not None
    assert rootfile.get("full-path") == "OEBPS/content.opf"
    assert "OEBPS/content.opf" in zf.namelist()


def test_epub_package_metadata_manifest_and_spine() -> None:
    zf = _zip(_epub())
    opf = _xml(zf, "OEBPS/content.opf")
    assert opf.get("version") == "3.0"
    assert opf.find(".//dc:title", NS_OPF).text == "Tài liệu mẫu"  # type: ignore[union-attr]
    assert opf.find(".//dc:language", NS_OPF).text == "vi"  # type: ignore[union-attr]
    assert opf.find(".//dc:creator", NS_OPF).text == "Nguyễn Văn A"  # type: ignore[union-attr]
    manifest = {item.get("id"): item for item in opf.findall(".//opf:manifest/opf:item", NS_OPF)}
    assert manifest["nav"].get("properties") == "nav"
    for item in manifest.values():
        href = _resolve("OEBPS/content.opf", item.get("href") or "")
        assert href in zf.namelist(), href
    spine = [ref.get("idref") for ref in opf.findall(".//opf:spine/opf:itemref", NS_OPF)]
    assert spine == ["chap1", "chap2"]
    assert all(idref in manifest for idref in spine)


def test_epub_nav_lists_chapters_and_headings() -> None:
    zf = _zip(_epub())
    nav = _xml(zf, "OEBPS/nav.xhtml")
    toc = nav.find(".//x:nav[@epub:type='toc']", NS_XHTML)
    assert toc is not None
    links = [a.get("href") for a in toc.iter("{http://www.w3.org/1999/xhtml}a")]
    assert "chapter-1.xhtml" in links and "chapter-2.xhtml" in links
    assert any(link and link.startswith("chapter-1.xhtml#h") for link in links), "nested headings"
    for href in links:
        assert _resolve("OEBPS/nav.xhtml", href or "") in zf.namelist()


def test_epub_chapters_are_well_formed_and_images_are_referenced(tmp_path: Path) -> None:
    pdf = reference_pdf(tmp_path / "ref.pdf")
    zf = _zip(_epub(pdf=pdf))
    names = zf.namelist()
    images = [n for n in names if n.startswith("OEBPS/images/")]
    assert len(images) == 1
    chapter = _xml(zf, "OEBPS/chapter-1.xhtml")
    assert chapter.get("{http://www.w3.org/XML/1998/namespace}lang") == "vi"
    srcs = [img.get("src") for img in chapter.iter("{http://www.w3.org/1999/xhtml}img")]
    assert [_resolve("OEBPS/chapter-1.xhtml", s or "") for s in srcs] == images
    for name in names:
        if name.endswith(".xhtml"):
            _xml(zf, name)


def test_epub_chapter_per_heading_and_per_pages() -> None:
    model = reference_model()
    ir = build_ir(model, None, ExportOptions())
    by_heading = chapters_of(ir, "heading1", 10)
    assert [c.title for c in by_heading] == ["Chương 1: Tổng quan", "Chương 2: Kết luận"]
    by_pages = chapters_of(ir, "pages", 1)
    assert [c.title for c in by_pages] == ["Trang 1", "Trang 2"]
    zf = _zip(_epub(mode="pages", per=1))
    assert "OEBPS/chapter-2.xhtml" in zf.namelist()


def test_epub_without_level_one_headings_falls_back_to_pages() -> None:
    data = reference_model().model_dump(mode="json", by_alias=True)
    for page in data["pages"]:
        page["blocks"] = [
            b for b in page["blocks"] if not (b["kind"] == "heading" and b["level"] == 1)
        ]
    model = DocModel.model_validate(data)
    ir = build_ir(model, None, ExportOptions())
    chapters = chapters_of(ir, "heading1", 10)
    assert [c.title for c in chapters] == ["Trang 1–2"]
    assert any(isinstance(it, Heading) for it in ir.items)


def test_epub_escapes_xml_in_text() -> None:
    zf = _zip(_epub())
    raw = zf.read("OEBPS/chapter-1.xhtml").decode("utf-8")
    assert "&lt;thẻ&gt;" in raw
    assert "<thẻ>" not in raw


# -- ODT ---------------------------------------------------------------------------------------

ODF = "urn:oasis:names:tc:opendocument:xmlns:"
TEXT = f"{{{ODF}text:1.0}}"
TABLE = f"{{{ODF}table:1.0}}"


def _odt(tmp_path: Path | None = None) -> zipfile.ZipFile:
    ir = build_ir(reference_model(), None, ExportOptions())
    data = build_odt(ir)
    return _zip(data)


def test_odt_mimetype_first_and_stored() -> None:
    zf = _odt()
    first = zf.infolist()[0]
    assert first.filename == "mimetype"
    assert first.compress_type == zipfile.ZIP_STORED
    assert zf.read("mimetype") == b"application/vnd.oasis.opendocument.text"


def test_odt_parts_are_well_formed_and_listed_in_the_manifest() -> None:
    zf = _odt()
    for name in ("content.xml", "styles.xml", "meta.xml", "META-INF/manifest.xml"):
        _xml(zf, name)
    manifest = _xml(zf, "META-INF/manifest.xml")
    listed = {
        entry.get("{urn:oasis:names:tc:opendocument:xmlns:manifest:1.0}full-path")
        for entry in manifest
    }
    assert {"/", "content.xml", "styles.xml", "meta.xml"} <= listed


def test_odt_headings_outline_levels_and_title() -> None:
    zf = _odt()
    content = _xml(zf, "content.xml")
    heads = list(content.iter(f"{TEXT}h"))
    assert [h.get(f"{TEXT}outline-level") for h in heads] == ["1", "2", "1"]
    meta = _xml(zf, "meta.xml")
    title = meta.find(".//{http://purl.org/dc/elements/1.1/}title")
    assert title is not None and title.text == "Tài liệu mẫu"


def test_odt_tables_spans_and_header_rows() -> None:
    zf = _odt()
    content = _xml(zf, "content.xml")
    table = next(content.iter(f"{TABLE}table"))
    assert table.get(f"{TABLE}name") == "Bảng 1"
    assert table.find(f"{TABLE}table-header-rows") is not None
    spanned = list(content.iter(f"{TABLE}table-cell"))
    cols = [c.get(f"{TABLE}number-columns-spanned") for c in spanned]
    rows = [c.get(f"{TABLE}number-rows-spanned") for c in spanned]
    assert "2" in cols and "2" in rows
    assert len(list(content.iter(f"{TABLE}covered-table-cell"))) == 2
    for row in table.iter(f"{TABLE}table-row"):
        assert len(list(row)) == 3, "every row covers the three columns"


def test_odt_lists_nest_and_text_is_kept() -> None:
    zf = _odt()
    content = _xml(zf, "content.xml")
    lists = list(content.iter(f"{TEXT}list"))
    assert len(lists) >= 4
    nested = [lst for lst in lists if lst.find(f".//{TEXT}list") is not None]
    assert nested, "a list inside a list item"
    text = ET.tostring(content, encoding="unicode")
    assert "Mục con a" in text and "Ann" in text


def test_odt_images_are_pictures_in_the_package(tmp_path: Path) -> None:
    pdf = reference_pdf(tmp_path / "ref.pdf")
    with Assets(pdf) as assets:
        ir = build_ir(reference_model(), assets, ExportOptions())
    out = tmp_path / "doc.odt"
    result = write_odt(ir, out)
    zf = zipfile.ZipFile(out)
    assert "Pictures/img-001.png" in zf.namelist()
    content = _xml(zf, "content.xml")
    assert list(content.iter(f"{{{ODF}draw:1.0}}image")) or list(
        content.iter("{urn:oasis:names:tc:opendocument:xmlns:drawing:1.0}image")
    )
    assert result.stats["tables"] == 1
