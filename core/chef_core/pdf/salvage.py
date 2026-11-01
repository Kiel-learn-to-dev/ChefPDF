"""Repair of damaged PDF files for ``doc.repair`` (defect 2 of the core review).

Two routes produce a document, and the one that keeps more readable pages is written:

- qpdf recovery (``pikepdf.open``): rebuilds the xref table, and a missing trailer when the
  catalog is still in the file. It can open a file whose pages cannot be drawn.
- salvage: the raw bytes are scanned for ``N G obj ... endobj`` (a stream ends at its
  ``endstream``; an object whose stream is cut off is dropped; a missing ``endobj`` ends the object
  at the next header). Object streams (``/Type /ObjStm``) are inflated as far as the zlib data
  goes and their complete members are taken. The objects are written to a temporary file with a
  fresh xref table and a dummy catalog, qpdf reads that file, and a new page tree is built from the
  ``/Type /Page`` objects in file order.

Both routes then check every page (``_assess_page``). qpdf drops a reference to a missing object
from its dictionary without a trace, so the raw text of the objects is used too: a page whose
``/Contents`` refers to a missing stream, or a font whose descriptor refers to a missing font
program, is caught even though qpdf no longer shows the key. The names the content stream uses
(``Tf``, ``Do``, ``gs``) must resolve. A font that cannot be used is replaced by Helvetica (a
warning is written); a page with unreadable content, or a missing image or graphics state, is
dropped (reported as lost).

A page is only drawable when its own objects are in the surviving bytes. A file cut inside the
font program of a document whose pages come after the font has no complete page left, and is
reported as not repairable.
"""

from __future__ import annotations

import re
import tempfile
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import pikepdf
from pikepdf import Array, Dictionary, Name

from chef_core.pdf.io import atomic_save

HEADER_RE = re.compile(
    rb"(?<![0-9])(\d{1,10})[ \t\r\n\f\x00]+(\d{1,5})[ \t\r\n\f\x00]+obj(?![A-Za-z])"
)
STREAM_RE = re.compile(rb">>[ \t\r\n\f\x00]*stream(?:\r\n|\n|\r)")
OBJSTM_RE = re.compile(rb"/Type\s*/ObjStm")
XREF_RE = re.compile(rb"/Type\s*/XRef")
FLATE_RE = re.compile(rb"/FlateDecode")
N_RE = re.compile(rb"/N\s+(\d+)")
FIRST_RE = re.compile(rb"/First\s+(\d+)")
ASCII_HEADER = b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n"
FALLBACK_FONT = "Helvetica"
FONT_FILE_KEYS = (b"/FontFile", b"/FontFile2", b"/FontFile3")
Texts = dict[int, bytes]  # object number -> raw text of the complete object in the file
Collected = dict[int, tuple[tuple[int, int], int, bytes]]  # number -> (order, gen, text)


class NotRepairable(Exception):
    """No page can be read from the file."""


@dataclass
class RawObject:
    num: int
    gen: int
    text: bytes  # "N G obj ... endobj" as it is in the file (endobj added when missing)
    order: int  # file offset, used for page order
    dict_part: bytes
    stream: bytes | None


@dataclass
class Scan:
    objects: dict[int, RawObject] = field(default_factory=dict)
    cut_off: int = 0  # objects whose stream is cut off: dropped


@dataclass
class PageVerdict:
    reason: str | None = None  # None: the page is kept
    fallback_fonts: list[str] = field(default_factory=list)


@dataclass
class RepairReport:
    pages: int
    lost: list[dict[str, Any]]
    warnings: list[str]
    salvaged: bool


def scan_objects(data: bytes) -> Scan:
    """Every complete ``N G obj`` of the raw bytes. The last copy of an object number wins."""
    headers = list(HEADER_RE.finditer(data))
    scan = Scan()
    for k, m in enumerate(headers):
        num, gen = int(m.group(1)), int(m.group(2))
        start = m.end()
        limit = headers[k + 1].start() if k + 1 < len(headers) else len(data)
        stream_m = STREAM_RE.search(data, start, limit)
        if stream_m is not None:
            data_start = stream_m.end()
            end_stream = data.find(b"endstream", data_start, limit)
            if end_stream < 0:
                scan.cut_off += 1
                continue
            stream: bytes | None = data[data_start:end_stream]
            endobj = data.find(b"endobj", end_stream, limit)
            end = endobj + len(b"endobj") if endobj >= 0 else end_stream + len(b"endstream")
            dict_part = data[start : stream_m.start()]
        else:
            stream = None
            endobj = data.find(b"endobj", start, limit)
            if endobj < 0 and limit == len(data):
                scan.cut_off += 1  # the file ends inside this object
                continue
            end = endobj + len(b"endobj") if endobj >= 0 else limit
            dict_part = data[start:end]
        text = data[m.start() : end]
        if not text.rstrip().endswith(b"endobj"):
            text = text.rstrip() + b"\nendobj"
        scan.objects[num] = RawObject(
            num=num,
            gen=gen,
            text=text,
            order=m.start(),
            dict_part=dict_part,
            stream=stream,
        )
    return scan


def _inflate_prefix(raw: bytes) -> tuple[bytes, bool]:
    """The inflated prefix of a zlib stream, and whether the stream ended cleanly."""
    decoder = zlib.decompressobj()
    out = bytearray()
    for i in range(0, len(raw), 256):
        try:
            out += decoder.decompress(raw[i : i + 256])
        except zlib.error:
            return bytes(out), False
    try:
        out += decoder.flush()
    except zlib.error:
        return bytes(out), False
    return bytes(out), decoder.eof


def objstm_members(obj: RawObject) -> list[tuple[int, bytes]]:
    """The complete members of an object stream (number, body). Members past a cut are lost."""
    if obj.stream is None or OBJSTM_RE.search(obj.dict_part) is None:
        return []
    n_match = N_RE.search(obj.dict_part)
    first_match = FIRST_RE.search(obj.dict_part)
    if n_match is None or first_match is None:
        return []
    if FLATE_RE.search(obj.dict_part):
        data, complete = _inflate_prefix(obj.stream)
    else:
        data, complete = obj.stream, True
    count, first = int(n_match.group(1)), int(first_match.group(1))
    if first > len(data):
        return []
    ints = re.findall(rb"\d+", data[:first])
    pairs = [(int(ints[2 * i]), int(ints[2 * i + 1])) for i in range(min(count, len(ints) // 2))]
    members: list[tuple[int, bytes]] = []
    for i, (num, offset) in enumerate(pairs):
        start = first + offset
        end: int | None = first + pairs[i + 1][1] if i + 1 < len(pairs) else None
        if end is None and complete:
            end = len(data)
        if end is None or end > len(data) or start > end:
            continue
        members.append((num, data[start:end]))
    return members


def collect_objects(scan: Scan) -> Collected:
    """The objects to rebuild a file from: the direct objects, then the members of the object
    streams that no direct object repeats. Cross-reference streams and object streams are left
    out (the members stand for them)."""
    collected: Collected = {}
    for num, obj in scan.objects.items():
        if XREF_RE.search(obj.dict_part) is not None:
            continue
        if OBJSTM_RE.search(obj.dict_part) is not None and obj.stream is not None:
            continue
        collected[num] = ((obj.order, 0), obj.gen, obj.text)
    for obj in scan.objects.values():
        for index, (num, body) in enumerate(objstm_members(obj)):
            if num in scan.objects or num in collected:
                continue
            text = f"{num} 0 obj\n".encode() + body.strip() + b"\nendobj"
            collected[num] = ((obj.order, index), 0, text)
    return collected


def _write_file(objects: Collected, path: Path) -> None:
    """A file with the given objects, a fresh xref table, and a catalog with an empty page tree
    (qpdf refuses a file without one). The real page tree is added once the pages are known."""
    out = bytearray(ASCII_HEADER)
    offsets: dict[int, tuple[int, int]] = {}
    for num in sorted(objects):
        _, gen, text = objects[num]
        offsets[num] = (len(out), gen)
        out += text + b"\n"
    root = max(objects) + 1
    pages = root + 1
    offsets[root] = (len(out), 0)
    out += f"{root} 0 obj\n<< /Type /Catalog /Pages {pages} 0 R >>\nendobj\n".encode()
    offsets[pages] = (len(out), 0)
    out += f"{pages} 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\n".encode()
    size = pages + 1
    xref_at = len(out)
    out += f"xref\n0 {size}\n".encode()
    out += b"0000000000 65535 f \n"
    for num in range(1, size):
        if num in offsets:
            off, gen = offsets[num]
            out += f"{off:010d} {gen:05d} n \n".encode()
        else:
            out += b"0000000000 65535 f \n"
    out += f"trailer\n<< /Size {size} /Root {root} 0 R >>\nstartxref\n{xref_at}\n%%EOF\n".encode()
    path.write_bytes(bytes(out))


def _raw_of(obj: Any, texts: Texts) -> bytes | None:
    """The raw text of an indirect object, when it is known."""
    if isinstance(obj, pikepdf.Object) and obj.is_indirect:
        return texts.get(obj.objgen[0])
    return None


def _raw_refs(raw: bytes, key: bytes) -> list[int]:
    """Object numbers that the raw text refers to under ``key`` (a reference or an array)."""
    pattern = re.escape(key) + rb"(?![0-9A-Za-z])\s*(\[[^\]]*\]|\d+\s+\d+\s+R)"
    match = re.search(pattern, raw)
    if match is None:
        return []
    return [int(n) for n in re.findall(rb"(\d+)\s+\d+\s+R", match.group(1))]


def _effective(page: Dictionary, key: str) -> Any:
    """An attribute of the page, or the one it inherits from its page-tree ancestors."""
    node: Any = page
    for _ in range(32):
        if not isinstance(node, Dictionary):
            return None
        if key in node:
            return node[key]
        node = node.get("/Parent")
    return None


def _stream_ok(value: Any) -> bool:
    if not isinstance(value, pikepdf.Stream):
        return False
    try:
        value.read_raw_bytes()
    except Exception:
        return False
    return True


def _font_ok(font: Any, texts: Texts) -> bool:
    if not isinstance(font, Dictionary):
        return False
    chain: list[Dictionary] = [font]
    if font.get("/Subtype") == Name.Type0:
        descendants = font.get("/DescendantFonts")
        if not isinstance(descendants, Array) or not descendants:
            return False
        if not isinstance(descendants[0], Dictionary):
            return False
        chain.append(descendants[0])
    for item in chain:
        raw_item = _raw_of(item, texts)
        if "/FontDescriptor" not in item:
            if raw_item is not None and _raw_refs(raw_item, b"/FontDescriptor"):
                return False  # the descriptor is missing from the file
            continue
        descriptor = item.get("/FontDescriptor")
        if not isinstance(descriptor, Dictionary):
            return False
        raw_descriptor = _raw_of(descriptor, texts)
        for key in FONT_FILE_KEYS:
            name = key.decode()
            if name in descriptor and not _stream_ok(descriptor.get(name)):
                return False
            if (
                raw_descriptor is not None
                and _raw_refs(raw_descriptor, key)
                and name not in descriptor
            ):
                return False  # the font program is missing from the file
    return True


def _contents_problem(page: Dictionary, raw: bytes | None, texts: Texts) -> str | None:
    if raw is not None and any(num not in texts for num in _raw_refs(raw, b"/Contents")):
        return "content stream is missing or cut off"
    if "/Contents" not in page:
        return None  # a page without content is blank
    contents = page.get("/Contents")
    parts = list(contents) if isinstance(contents, Array) else [contents]
    for part in parts:
        if not isinstance(part, pikepdf.Stream) or not _stream_ok(part):
            return "content stream is missing or cut off"
        try:
            part.read_bytes()
        except Exception:
            return "content stream cannot be decoded"
    return None


def _used_names(page: Dictionary) -> dict[str, set[str]]:
    """The resource names the content stream uses: fonts (Tf), XObjects (Do), states (gs)."""
    used: dict[str, set[str]] = {"Tf": set(), "Do": set(), "gs": set()}
    for ins in pikepdf.parse_content_stream(page):
        op = str(ins.operator)
        if op in used and ins.operands:
            used[op].add(str(ins.operands[0]).lstrip("/"))
    return used


def _assess_page(page: Dictionary, texts: Texts) -> PageVerdict:
    raw = _raw_of(page, texts)
    problem = _contents_problem(page, raw, texts)
    if problem is not None:
        return PageVerdict(reason=problem)
    try:
        used = _used_names(page)
    except Exception:
        return PageVerdict(reason="content does not parse")
    resources = _effective(page, "/Resources")
    if resources is not None and not isinstance(resources, Dictionary):
        return PageVerdict(reason="resources are unreadable")
    fonts = resources.get("/Font") if isinstance(resources, Dictionary) else None
    xobjects = resources.get("/XObject") if isinstance(resources, Dictionary) else None
    gstates = resources.get("/ExtGState") if isinstance(resources, Dictionary) else None
    font_names = set(used["Tf"])
    if isinstance(fonts, Dictionary):
        font_names |= {str(key).lstrip("/") for key in fonts}
    fallback = [
        name
        for name in sorted(font_names)
        if not _font_ok(fonts.get(f"/{name}") if isinstance(fonts, Dictionary) else None, texts)
    ]
    for name in sorted(used["Do"]):
        value = xobjects.get(f"/{name}") if isinstance(xobjects, Dictionary) else None
        if not _stream_ok(value):
            return PageVerdict(reason=f"image or form {name} is missing or cut off")
    for name in sorted(used["gs"]):
        value = gstates.get(f"/{name}") if isinstance(gstates, Dictionary) else None
        if not isinstance(value, Dictionary):
            return PageVerdict(reason=f"graphics state {name} is missing")
    return PageVerdict(fallback_fonts=fallback)


def _check(
    pages: list[Dictionary], texts: Texts
) -> tuple[list[Dictionary], list[PageVerdict]] | None:
    if not pages:
        return None
    return pages, [_assess_page(page, texts) for page in pages]


def _apply(
    pdf: pikepdf.Pdf,
    pages: list[Dictionary],
    verdicts: list[PageVerdict],
    *,
    warnings: list[str],
    salvaged: bool,
) -> RepairReport:
    """Keep the readable pages, give them a new page tree, and replace the unusable fonts."""
    kept: list[Dictionary] = []
    lost: list[dict[str, Any]] = []
    fallback_font: Dictionary | None = None
    for index, (page, verdict) in enumerate(zip(pages, verdicts, strict=True), start=1):
        if verdict.reason is not None:
            lost.append({"page": index, "reason": verdict.reason})
            continue
        for key in ("/MediaBox", "/CropBox", "/Resources", "/Rotate"):
            if key not in page:
                inherited = _effective(page, key)
                if inherited is not None:
                    page[key] = inherited
        if verdict.fallback_fonts:
            if fallback_font is None:
                fallback_font = pdf.make_indirect(
                    Dictionary(
                        Type=Name.Font,
                        Subtype=Name.Type1,
                        BaseFont=Name(f"/{FALLBACK_FONT}"),
                        Encoding=Name.WinAnsiEncoding,
                    )
                )
            resources = page.get("/Resources")
            if not isinstance(resources, Dictionary):
                resources = Dictionary()
                page["/Resources"] = resources
            fonts = resources.get("/Font")
            if not isinstance(fonts, Dictionary):
                fonts = Dictionary()
                resources["/Font"] = fonts
            for name in verdict.fallback_fonts:
                fonts[f"/{name}"] = fallback_font
            warnings.append(
                f"Page {index}: font(s) {', '.join(verdict.fallback_fonts)} were damaged and "
                f"replaced by {FALLBACK_FONT}; the text may look different."
            )
        if not page.is_indirect:
            page = pdf.make_indirect(page)
        kept.append(page)
    if kept:
        node = pdf.make_indirect(Dictionary(Type=Name.Pages, Kids=Array(kept), Count=len(kept)))
        for page in kept:
            page["/Parent"] = node
        pdf.Root.Type = Name.Catalog
        pdf.Root.Pages = node
    for item in lost:
        warnings.append(f"Page {item['page']} was dropped: {item['reason']}.")
    return RepairReport(pages=len(kept), lost=lost, warnings=warnings, salvaged=salvaged)


def _parses(pdf: pikepdf.Pdf, num: int, gen: int) -> Any:
    """The object, or None when it cannot be parsed."""
    try:
        return pdf.get_object(num, gen)
    except Exception:
        return None


def _salvaged_pdf(
    collected: Collected, scratch: Path
) -> tuple[pikepdf.Pdf | None, list[Dictionary]]:
    """Open a file rebuilt from ``collected``, with its ``/Type /Page`` objects in file order.
    Objects that cannot be parsed (damaged members of an object stream) are left out."""
    path = scratch / "salvage-objects.pdf"
    while collected:
        _write_file(collected, path)
        try:
            pdf = pikepdf.open(path)
        except pikepdf.PdfError:
            return None, []
        broken = [num for num, (_o, gen, _t) in collected.items() if _parses(pdf, num, gen) is None]
        if not broken:
            break
        pdf.close()
        for num in broken:
            del collected[num]
    else:
        return None, []
    found: list[tuple[tuple[int, int], int, Dictionary]] = []
    for num, (order, gen, _text) in collected.items():
        obj = _parses(pdf, num, gen)
        if isinstance(obj, Dictionary) and obj.get("/Type") == Name.Page:
            found.append((order, num, obj))
    if not found:
        pdf.close()
        return None, []
    found.sort(key=lambda item: (item[0], item[1]))
    return pdf, [obj for _order, _num, obj in found]


def _open_qpdf(src: Path) -> pikepdf.Pdf | None:
    try:
        return pikepdf.open(src)
    except pikepdf.PasswordError:
        raise
    except (pikepdf.PdfError, OSError, RuntimeError, ValueError):
        return None


def _finish(pdf: pikepdf.Pdf, dest: Path, report: RepairReport) -> RepairReport:
    try:
        if report.pages == 0:
            raise NotRepairable
        atomic_save(pdf, dest, before_replace=pdf.close)
    finally:
        pdf.close()
    return report


def repair_file(src: Path, dest: Path) -> RepairReport:
    """Write a repaired copy of ``src`` to ``dest``. Raises ``NotRepairable`` when no page can be
    read. A password error from qpdf propagates (``pikepdf.PasswordError``)."""
    qpdf_pdf = _open_qpdf(src)
    qpdf_warnings = [str(w) for w in qpdf_pdf.get_warnings()] if qpdf_pdf is not None else []
    scan = scan_objects(src.read_bytes())
    collected = collect_objects(scan)
    texts: Texts = {num: entry[2] for num, entry in collected.items()}
    best_pdf: pikepdf.Pdf | None = None
    best: tuple[list[Dictionary], list[PageVerdict]] | None = None
    best_good = 0
    best_warnings: list[str] = []
    salvaged = False
    try:
        if qpdf_pdf is not None:
            try:
                qpdf_checked = _check([page.obj for page in qpdf_pdf.pages], texts)
            except Exception:
                qpdf_checked = None
            if qpdf_checked is not None:
                best_pdf, best = qpdf_pdf, qpdf_checked
                best_good = sum(v.reason is None for v in qpdf_checked[1])
                best_warnings = qpdf_warnings
                qpdf_pdf = None  # owned by best_pdf now
                clean = not qpdf_warnings and all(
                    v.reason is None and not v.fallback_fonts for v in qpdf_checked[1]
                )
                if clean:
                    report = _apply(best_pdf, *best, warnings=[], salvaged=False)
                    return _finish(best_pdf, dest, report)
        with tempfile.TemporaryDirectory(prefix="chef-repair-") as tmp:
            pdf_s, pages_s = _salvaged_pdf(collected, Path(tmp))
            if pdf_s is not None:
                checked = _check(pages_s, texts)
                good = sum(v.reason is None for v in checked[1]) if checked is not None else 0
                if checked is not None and good > best_good:
                    if best_pdf is not None:
                        best_pdf.close()
                    best_pdf, best, best_good, salvaged = pdf_s, checked, good, True
                    best_warnings = [
                        f"The file was rebuilt from {len(collected)} complete object(s).",
                        f"{scan.cut_off} object(s) cut off at the end of a stream were dropped.",
                    ]
                    pdf_s = None  # owned by best_pdf now
                elif pdf_s is not None:
                    pdf_s.close()
            if best_pdf is None or best is None or best_good == 0:
                raise NotRepairable
            report = _apply(best_pdf, *best, warnings=list(best_warnings), salvaged=salvaged)
            return _finish(best_pdf, dest, report)
    finally:
        if qpdf_pdf is not None:
            qpdf_pdf.close()
        if best_pdf is not None:
            best_pdf.close()  # a no-op after _finish


__all__ = ["NotRepairable", "RepairReport", "collect_objects", "repair_file", "scan_objects"]
