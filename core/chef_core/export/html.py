"""HTML5 (T10.04, N4): semantic tags, embedded CSS, UTF-8, ``lang`` from the document.

Each source page is a ``<section class="page">``. Tables are real ``<table>`` elements with spans
and a ``<thead>`` when the model says there is a header row. Images are relative files in
``<name>_files/``, or base64 data URIs with ``embedImages``. Fonts: the source font mapped to a
web-safe family, then Be Vietnam Pro (``fonts.css_stack``); no font file is embedded.

``render_items`` is the body renderer, reused by the EPUB chapters (which convert the output to
XHTML with ``to_xhtml``).
"""

from __future__ import annotations

import base64
import re
from collections.abc import Callable, Sequence
from pathlib import Path
from urllib.parse import quote

from chef_core.export.files import assets_folder, image_name, write_bytes, write_text
from chef_core.export.fonts import css_stack
from chef_core.export.ir import (
    CellIR,
    DocIR,
    ExportResult,
    Heading,
    ImageBlock,
    Item,
    ListBlock,
    ListNode,
    PageMark,
    Para,
    Rule,
    TableBlock,
)
from chef_core.export.text import html_escape, merge_runs, squash
from chef_core.layout.model import Run

DEFAULT_SIZE = 11.0
DEFAULT_HEADING = {1: 20.0, 2: 16.0, 3: 14.0, 4: 12.0, 5: 11.0, 6: 11.0}
SAFE_URL = re.compile(r"^https?://\S+$")
ImageSource = Callable[[ImageBlock], str | None]


def inline(runs: Sequence[Run]) -> str:
    """Runs as HTML phrasing content (escaped)."""
    out: list[str] = []
    for run in merge_runs(runs):
        text = html_escape(run.text)
        if run.sup:
            text = f"<sup>{text}</sup>"
        elif run.sub:
            text = f"<sub>{text}</sub>"
        if run.bold:
            text = f"<strong>{text}</strong>"
        if run.italic:
            text = f"<em>{text}</em>"
        if run.color and re.fullmatch(r"#[0-9a-fA-F]{6}", run.color) and run.color != "#000000":
            text = f'<span style="color:{run.color}">{text}</span>'
        if run.link and SAFE_URL.match(run.link):
            text = f'<a href="{html_escape(run.link)}">{text}</a>'
        out.append(text)
    return "".join(out)


def _css(ir: DocIR) -> str:
    body = ir.body_size or DEFAULT_SIZE
    heads = []
    for level in range(1, 7):
        size = ir.heading_sizes.get(level, DEFAULT_HEADING[level])
        heads.append(f"h{level} {{ font-size: {size:g}pt; margin: 1.2em 0 .4em; }}")
    return "\n".join(
        [
            ":root { color-scheme: light dark; }",
            f"body {{ font-family: {css_stack(ir.body_font)}; font-size: {body:g}pt; "
            "line-height: 1.5; max-width: 52rem; margin: 2rem auto; padding: 0 1rem; "
            "color: #1d1d1f; background: #ffffff; }",
            *heads,
            "section.page { margin: 1.5em 0; padding-top: .5em; border-top: 1px dashed #bbb; }",
            "section.page:first-child { border-top: 0; }",
            "table { border-collapse: collapse; width: 100%; margin: 1em 0; }",
            "th, td { border: 1px solid #8a8a8a; padding: .3em .5em; vertical-align: top; }",
            "thead th { background: #e9eef7; }",
            "img { max-width: 100%; height: auto; }",
            "figure { margin: 1em 0; }",
            "figcaption, .caption { color: #555; font-size: .9em; }",
            ".header, .footer, .pagenumber { color: #666; font-size: .85em; }",
            ".footnote { font-size: .85em; }",
            "hr { border: 0; border-top: 1px solid #bbb; margin: 2em 0; }",
            "@media (prefers-color-scheme: dark) {",
            "  body { color: #e6e6e6; background: #1b1b1f; }",
            "  thead th { background: #2a3344; }",
            "  th, td { border-color: #5c5c66; }",
            "  figcaption, .caption { color: #aaa; }",
            "}",
        ]
    )


def _cell(cell: CellIR, tag: str) -> str:
    attrs = ""
    if cell.row_span > 1:
        attrs += f' rowspan="{cell.row_span}"'
    if cell.col_span > 1:
        attrs += f' colspan="{cell.col_span}"'
    body = "<br>".join(inline(p) for p in cell.paras)
    return f"<{tag}{attrs}>{body}</{tag}>"


def _table(block: TableBlock) -> str:
    out = ["<table>"]
    rows = block.rows
    start = 0
    if block.header and rows:
        out.append("<thead>")
        out.append("<tr>" + "".join(_cell(c, "th") for c in rows[0] if not c.covered) + "</tr>")
        out.append("</thead>")
        start = 1
    out.append("<tbody>")
    for row in rows[start:]:
        cells = "".join(_cell(c, "td") for c in row if not c.covered)
        out.append(f"<tr>{cells}</tr>")
    out.append("</tbody></table>")
    return "".join(out)


def _list(nodes: list[ListNode], ordered: bool) -> str:
    tag = "ol" if ordered else "ul"
    items = []
    for node in nodes:
        children = _list(node.children, ordered) if node.children else ""
        items.append(f"<li>{inline(node.runs)}{children}</li>")
    return f"<{tag}>" + "".join(items) + f"</{tag}>"


def _para(item: Para) -> str:
    text = inline(item.runs)
    if item.role == "caption":
        return f'<p class="caption">{text}</p>'
    if item.role in ("header", "footer", "pagenumber"):
        return f'<p class="{item.role}">{text}</p>'
    if item.role == "footnote":
        return f'<p class="footnote">{text}</p>'
    return f"<p>{text}</p>"


def _image(item: ImageBlock, src: str | None) -> str:
    alt = html_escape(squash(item.caption or ""))
    if item.asset is None or src is None:
        body = '<p class="caption">[Hình không trích được]</p>'
    else:
        body = f'<img src="{html_escape(src)}" alt="{alt}">'
    if item.caption:
        caption = html_escape(squash(item.caption))
        return f"<figure>{body}<figcaption>{caption}</figcaption></figure>"
    return f"<figure>{body}</figure>" if item.asset is not None else body


def render_items(
    items: Sequence[Item],
    image_src: ImageSource,
    sections: bool = True,
    heading_ids: bool = False,
) -> str:
    """The body HTML of ``items``. ``image_src`` gives the ``src`` of an image (None: no image).
    ``heading_ids`` gives each heading ``id="h<position>"`` (position in ``items``)."""
    parts: list[str] = []
    open_page = False
    for pos, item in enumerate(items):
        if isinstance(item, PageMark):
            if not sections:
                continue
            if open_page:
                parts.append("</section>")
            parts.append(f'<section class="page" data-page="{item.index + 1}">')
            open_page = True
        elif isinstance(item, Heading):
            attr = f' id="h{pos}"' if heading_ids else ""
            plain_runs = [r.model_copy(update={"bold": False}) for r in item.runs]
            parts.append(f"<h{item.level}{attr}>{inline(plain_runs)}</h{item.level}>")
        elif isinstance(item, Para):
            parts.append(_para(item))
        elif isinstance(item, ListBlock):
            parts.append(_list(item.items, item.ordered))
        elif isinstance(item, TableBlock):
            parts.append(_table(item))
        elif isinstance(item, ImageBlock):
            parts.append(_image(item, image_src(item) if item.asset is not None else None))
        elif isinstance(item, Rule):
            parts.append("<hr>")
    if open_page:
        parts.append("</section>")
    return "\n".join(parts)


def to_xhtml(fragment: str) -> str:
    """Void elements self-closed, so that the HTML5 fragment is well-formed XML."""
    fragment = re.sub(r"<(br|hr)>", r"<\1/>", fragment)
    return re.sub(r"<img ([^>]*?)>", r"<img \1/>", fragment)


def render(ir: DocIR, *, embed: bool, folder: str | None) -> tuple[str, list[tuple[str, bytes]]]:
    """The whole HTML document and the image files to write (only when not embedded)."""
    files: list[tuple[str, bytes]] = []
    counter = [0]

    def source(item: ImageBlock) -> str | None:
        if item.asset is None:
            return None
        if embed:
            mime = "image/jpeg" if item.asset.ext == "jpg" else "image/png"
            payload = base64.b64encode(item.asset.data).decode("ascii")
            return f"data:{mime};base64,{payload}"
        counter[0] += 1
        name = image_name(counter[0], item.asset.ext)
        files.append((name, item.asset.data))
        return f"{quote(folder or '')}/{quote(name)}" if folder else name

    body = render_items(ir.items, source)
    head = (
        f'<!DOCTYPE html>\n<html lang="{html_escape(ir.language)}">\n<head>\n'
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        f"<title>{html_escape(ir.title or ir.name)}</title>\n"
        f"<style>\n{_css(ir)}\n</style>\n</head>\n<body>\n<main>\n"
    )
    return head + body + "\n</main>\n</body>\n</html>\n", files


def _images(ir: DocIR) -> int:
    return sum(1 for it in ir.items if isinstance(it, ImageBlock) and it.asset is not None)


def write_html(ir: DocIR, out: Path, *, embed: bool) -> ExportResult:
    folder = assets_folder(out)
    text, files = render(ir, embed=embed, folder=folder.name)
    outputs: list[str] = []
    if files and not embed:
        folder.mkdir(parents=True, exist_ok=True)
        for name, data in files:
            target = folder / name
            write_bytes(target, data)
            outputs.append(str(target))
    write_text(out, text)
    outputs.insert(0, str(out))
    return ExportResult(
        outputs=outputs,
        warnings=list(ir.warnings),
        stats={"blocks": len(ir.items), "images": _images(ir)},
    )
