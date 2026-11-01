"""EPUB 3 (T10.04, N4), written by hand with zipfile and xml (no EPUB library).

Layout of the package::

    mimetype                      (first entry, stored, no compression)
    META-INF/container.xml
    OEBPS/content.opf             metadata, manifest, spine
    OEBPS/nav.xhtml               the table of contents (EPUB 3 nav document)
    OEBPS/style.css
    OEBPS/chapter-N.xhtml         one per chapter
    OEBPS/images/img-NNN.png|jpg

Chapters: one per level-1 heading (``chapterMode`` heading1; text before the first heading is a
chapter of its own), or one per N pages (``pages``). The nav lists the chapters and the headings
inside them. Text that the document has is never changed: only escaped.
"""

from __future__ import annotations

import io
import uuid
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from chef_core.export.html import ImageSource, render_items, to_xhtml
from chef_core.export.ir import DocIR, ExportResult, Heading, ImageBlock, Item, PageMark
from chef_core.export.text import squash, xml_escape
from chef_core.pdf.io import atomic_write

MIMETYPE = "application/epub+zip"
CSS = """body { font-family: 'Be Vietnam Pro', Arial, sans-serif; line-height: 1.5;
  margin: 1em; color: #1d1d1f; }
h1 { font-size: 1.6em; } h2 { font-size: 1.35em; } h3 { font-size: 1.15em; }
table { border-collapse: collapse; margin: 1em 0; }
th, td { border: 1px solid #888; padding: .25em .4em; vertical-align: top; }
img { max-width: 100%; height: auto; }
figcaption, .caption { color: #555; font-size: .9em; }
"""
XHTML_NS = 'xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"'


@dataclass
class Chapter:
    title: str
    items: list[Item]
    file: str  # chapter-N.xhtml


def _heading_items(items: list[Item]) -> list[tuple[int, Heading]]:
    return [(pos, it) for pos, it in enumerate(items) if isinstance(it, Heading)]


def chapters_of(ir: DocIR, mode: str, per: int) -> list[Chapter]:
    """Split the items into chapters. ``heading1`` falls back to pages when there is no level-1
    heading."""
    has_h1 = any(isinstance(it, Heading) and it.level == 1 for it in ir.items)
    groups: list[tuple[str, list[Item]]] = []
    if mode == "heading1" and has_h1:
        current: list[Item] = []
        title = ir.title or "Nội dung"
        for item in ir.items:
            if isinstance(item, Heading) and item.level == 1:
                if any(not isinstance(i, PageMark) for i in current):
                    groups.append((title, current))
                current = [item]
                title = squash("".join(r.text for r in item.runs)) or "Chương"
            else:
                current.append(item)
        if any(not isinstance(i, PageMark) for i in current):
            groups.append((title, current))
    else:
        current = []
        pages_in = 0
        first_page = None
        last_page = None
        for item in ir.items:
            if isinstance(item, PageMark):
                if pages_in == per:
                    groups.append((_pages_title(first_page, last_page), current))
                    current = []
                    pages_in = 0
                    first_page = None
                if first_page is None:
                    first_page = item.index + 1
                last_page = item.index + 1
                pages_in += 1
            current.append(item)
        if current:
            groups.append((_pages_title(first_page, last_page), current))
    return [
        Chapter(title=title or "Trang", items=items, file=f"chapter-{n + 1}.xhtml")
        for n, (title, items) in enumerate(groups)
        if any(not isinstance(i, PageMark) for i in items)
    ]


def _pages_title(first: int | None, last: int | None) -> str:
    if first is None or last is None:
        return "Trang"
    return f"Trang {first}" if first == last else f"Trang {first}–{last}"


def _nav_list(entries: list[tuple[int, str, str]], start: int, floor: int) -> tuple[str, int]:
    out: list[str] = []
    i = start
    while i < len(entries) and entries[i][0] >= floor:
        level, text, href = entries[i]
        i += 1
        sub = ""
        if i < len(entries) and entries[i][0] > level:
            sub, i = _nav_list(entries, i, entries[i][0])
        out.append(f'<li><a href="{xml_escape(href)}">{xml_escape(text)}</a>{sub}</li>')
    return "<ol>" + "".join(out) + "</ol>", i


def _nav_xhtml(chapters: list[Chapter], lang: str) -> str:
    entries: list[tuple[int, str, str]] = []
    for chapter in chapters:
        entries.append((1, chapter.title, chapter.file))
        headings = _heading_items(chapter.items)
        for pos, head in headings:
            if pos == 0 and head.level == 1:
                continue  # the chapter entry itself
            text = squash("".join(r.text for r in head.runs))
            entries.append((head.level, text, f"{chapter.file}#h{pos}"))
    tree, _ = _nav_list(entries, 0, 1) if entries else ("<ol></ol>", 0)
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n'
        f'<html {XHTML_NS} xml:lang="{lang}" lang="{lang}">\n<head>\n'
        '<meta charset="utf-8"/>\n<title>Mục lục</title>\n</head>\n<body>\n'
        '<nav epub:type="toc" id="toc">\n<h1>Mục lục</h1>\n'
        f"{tree}\n</nav>\n</body>\n</html>\n"
    )


def _chapter_xhtml(chapter: Chapter, lang: str, image_src: ImageSource) -> str:
    body = to_xhtml(render_items(chapter.items, image_src, sections=False, heading_ids=True))
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n<!DOCTYPE html>\n'
        f'<html {XHTML_NS} xml:lang="{lang}" lang="{lang}">\n<head>\n'
        '<meta charset="utf-8"/>\n'
        f"<title>{xml_escape(chapter.title)}</title>\n"
        '<link rel="stylesheet" type="text/css" href="style.css"/>\n'
        f"</head>\n<body>\n<section>\n{body}\n</section>\n</body>\n</html>\n"
    )


def _opf(ir: DocIR, chapters: list[Chapter], images: list[tuple[str, str]], uid: str) -> str:
    title = ir.title or ir.name
    creator = f"<dc:creator>{xml_escape(ir.author)}</dc:creator>\n" if ir.author else ""
    modified = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest = [
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
        '<item id="css" href="style.css" media-type="text/css"/>',
    ]
    manifest += [
        f'<item id="chap{n + 1}" href="{c.file}" media-type="application/xhtml+xml"/>'
        for n, c in enumerate(chapters)
    ]
    for n, (name, mime) in enumerate(images):
        manifest.append(f'<item id="img{n + 1}" href="images/{name}" media-type="{mime}"/>')
    spine = "".join(f'<itemref idref="chap{n + 1}"/>' for n in range(len(chapters)))
    return (
        '<?xml version="1.0" encoding="utf-8"?>\n'
        '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" '
        f'unique-identifier="book-id" xml:lang="{xml_escape(ir.language)}">\n'
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
        f'<dc:identifier id="book-id">{uid}</dc:identifier>\n'
        f"<dc:title>{xml_escape(title)}</dc:title>\n"
        f"<dc:language>{xml_escape(ir.language)}</dc:language>\n"
        f"{creator}"
        f'<meta property="dcterms:modified">{modified}</meta>\n'
        "</metadata>\n<manifest>\n" + "\n".join(manifest) + "\n</manifest>\n"
        f"<spine>{spine}</spine>\n</package>\n"
    )


CONTAINER = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
    "<rootfiles>\n"
    '<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n'
    "</rootfiles>\n</container>\n"
)


def build_epub(ir: DocIR, chapter_mode: str, per: int) -> tuple[bytes, list[str]]:
    """The EPUB file as bytes (for tests and for ``write_epub``) and its warnings."""
    chapters = chapters_of(ir, chapter_mode, per)
    files: dict[str, bytes | str] = {}
    images: list[tuple[str, str]] = []
    counter = [0]

    def image_src(item: ImageBlock) -> str | None:
        if item.asset is None:
            return None
        counter[0] += 1
        ext = "jpg" if item.asset.ext == "jpg" else "png"
        name = f"img-{counter[0]:03d}.{ext}"
        mime = "image/jpeg" if ext == "jpg" else "image/png"
        files[f"OEBPS/images/{name}"] = item.asset.data
        images.append((name, mime))
        return f"images/{name}"

    for chapter in chapters:
        files[f"OEBPS/{chapter.file}"] = _chapter_xhtml(chapter, ir.language, image_src)
    uid = f"urn:uuid:{uuid.uuid5(uuid.NAMESPACE_URL, f'{ir.name}|{ir.title}|{len(ir.items)}')}"
    files["OEBPS/nav.xhtml"] = _nav_xhtml(chapters, ir.language)
    files["OEBPS/style.css"] = CSS
    files["OEBPS/content.opf"] = _opf(ir, chapters, images, uid)
    files["META-INF/container.xml"] = CONTAINER
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(zipfile.ZipInfo("mimetype"), MIMETYPE, compress_type=zipfile.ZIP_STORED)
        for name, content in files.items():
            data = content.encode("utf-8") if isinstance(content, str) else content
            zf.writestr(name, data, compress_type=zipfile.ZIP_DEFLATED)
    return buf.getvalue(), list(ir.warnings)


def write_epub(ir: DocIR, out: Path, chapter_mode: str, per: int) -> ExportResult:
    data, warnings = build_epub(ir, chapter_mode, per)

    def write(tmp: Path) -> None:
        tmp.write_bytes(data)

    atomic_write(out, write)
    chapters = chapters_of(ir, chapter_mode, per)
    return ExportResult(
        outputs=[str(out)],
        warnings=warnings,
        stats={"chapters": len(chapters), "blocks": len(ir.items)},
    )
