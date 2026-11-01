"""Form data files (H1): export and import of field values as JSON, FDF, XFDF and CSV.

Export is text: JSON, CSV, XFDF and FDF are all written as ASCII (non-ASCII text goes into
hex-encoded UTF-16BE strings in FDF, and as character references in XFDF), so the result is safe
to return through JSON-RPC and to save as a file.

Import reads JSON (``{name: value}``), FDF and XFDF. FDF is parsed with a small PDF-syntax reader
that accepts only what FDF uses (dictionaries, arrays, names, strings and numbers). XFDF is read
with ElementTree after rejecting DTDs and entities, so external or recursive entities never load.
"""

from __future__ import annotations

import csv
import io
import json
import re
from dataclasses import dataclass
from typing import Any
from xml.etree import ElementTree
from xml.sax.saxutils import escape, quoteattr

from chef_core.errors import invalid_params
from chef_core.forms.model import FieldRef, FormDoc, on_states, value_of

FORMATS = ("json", "fdf", "xfdf", "csv")


class PdfName(str):
    """A PDF name read from FDF (kept apart from text strings)."""


@dataclass(frozen=True)
class _Reference:
    """An indirect reference ``N G R`` (only its number is kept; FDF data never needs more)."""

    number: int


def export_values(fd: FormDoc) -> dict[str, Any]:
    """Field name to value, for every field that has one (buttons and signatures excluded)."""
    out: dict[str, Any] = {}
    for ref in fd.fields():
        if ref.kind in ("button", "signature", "unknown"):
            continue
        out[ref.name] = value_of(ref)
    return out


def export_text(fmt: str, fd: FormDoc) -> str:
    values = export_values(fd)
    refs = {ref.name: ref for ref in fd.fields()}
    if fmt == "json":
        return json.dumps(values, ensure_ascii=True, indent=2) + "\n"
    if fmt == "csv":
        return _csv(values)
    pairs = [
        (name, _export_value(refs[name], value))
        for name, value in values.items()
        if value is not None and value != []
    ]
    if fmt == "xfdf":
        return _xfdf(pairs)
    if fmt == "fdf":
        return _fdf(pairs)
    raise invalid_params(f"Unknown format {fmt}", {"format": fmt})


def _export_value(ref: FieldRef, value: Any) -> Any:
    if ref.kind == "checkbox":
        states = [s for w in ref.widgets for s in on_states(w)]
        on = states[0] if states else "Yes"
        return PdfName(on if value else "Off")
    if ref.kind == "radio":
        return PdfName(value or "Off")
    return value


def _csv(values: dict[str, Any]) -> str:
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(list(values.keys()))
    row = []
    for value in values.values():
        if value is None:
            row.append("")
        elif isinstance(value, bool):
            row.append("true" if value else "false")
        elif isinstance(value, list):
            row.append("; ".join(value))
        else:
            row.append(str(value))
    writer.writerow(row)
    return buffer.getvalue()


# -- writers ----------------------------------------------------------------------------


def _tree(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    """Nest dotted names: a leaf holds ``("leaf", value)``; a group holds its children."""
    root: dict[str, Any] = {}
    for name, value in pairs:
        node = root
        parts = name.split(".")
        for part in parts[:-1]:
            child = node.setdefault(part, {})
            node = child["kids"] if "kids" in child else child.setdefault("kids", {})
        node[parts[-1]] = {"leaf": value}
    return root


def _hex_text(value: str) -> str:
    return "<FEFF" + value.encode("utf-16-be").hex().upper() + ">"


def _fdf_value(value: Any) -> str:
    if isinstance(value, PdfName):
        return f"/{value}"
    if isinstance(value, bool):
        return "/Yes" if value else "/Off"
    if value is None:
        return "()"
    if isinstance(value, list):
        return "[" + " ".join(_hex_text(v) for v in value) + "]"
    return _hex_text(str(value))


def _fdf_fields(nodes: dict[str, Any]) -> str:
    parts = []
    for name, node in nodes.items():
        if "leaf" in node:
            parts.append(f"<< /T {_hex_text(name)} /V {_fdf_value(node['leaf'])} >>")
        else:
            parts.append(f"<< /T {_hex_text(name)} /Kids [ {_fdf_fields(node['kids'])} ] >>")
    return " ".join(parts)


def _fdf(pairs: list[tuple[str, Any]]) -> str:
    body = _fdf_fields(_tree(pairs))
    return (
        "%FDF-1.2\n1 0 obj\n<< /FDF << /Fields [ " + body + " ] >> >>\nendobj\n"
        "trailer\n<< /Root 1 0 R >>\n%%EOF\n"
    )


def _xfdf_fields(nodes: dict[str, Any]) -> str:
    out = []
    for name, node in nodes.items():
        attr = quoteattr(name)
        if "leaf" in node:
            value = node["leaf"]
            if isinstance(value, list):
                inner = "".join(f"<value>{escape(str(v))}</value>" for v in value)
            elif value is None:
                inner = ""
            else:
                inner = f"<value>{escape(str(value))}</value>"
            out.append(f"<field name={attr}>{inner}</field>")
        else:
            out.append(f"<field name={attr}>{_xfdf_fields(node['kids'])}</field>")
    return "".join(out)


def _xfdf(pairs: list[tuple[str, Any]]) -> str:
    fields = _xfdf_fields(_tree([(n, _xfdf_text(v)) for n, v in pairs]))
    text = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">'
        f"<fields>{fields}</fields></xfdf>\n"
    )
    # ASCII only: non-ASCII characters become numeric character references (valid XML)
    return text.encode("ascii", "xmlcharrefreplace").decode("ascii")


def _xfdf_text(value: Any) -> Any:
    if isinstance(value, PdfName):
        return str(value)
    if isinstance(value, bool):
        return "Yes" if value else "Off"
    if isinstance(value, list):
        return [str(v) for v in value]
    return value


# -- readers ----------------------------------------------------------------------------


def parse_import(data: bytes, fmt: str) -> dict[str, Any]:
    if fmt == "json":
        return _parse_json(data)
    if fmt == "fdf":
        return _parse_fdf(data)
    if fmt == "xfdf":
        return _parse_xfdf(data)
    raise invalid_params(f"Cannot import format {fmt}", {"format": fmt})


def _parse_json(data: bytes) -> dict[str, Any]:
    try:
        value = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise invalid_params("The file is not valid JSON", {"format": "json"}) from exc
    if not isinstance(value, dict):
        raise invalid_params("JSON data must be an object of field values", {"format": "json"})
    for name, item in value.items():
        if not isinstance(item, str | bool | list | type(None)):
            raise invalid_params(f"Unsupported value for {name}", {"field": name})
    return value


_OCTAL = re.compile(rb"\\([0-7]{1,3})")
_ESCAPES = {ord("n"): 10, ord("r"): 13, ord("t"): 9, ord("b"): 8, ord("f"): 12}


class _FdfReader:
    def __init__(self, data: bytes) -> None:
        self.data = data
        self.pos = 0

    def _skip(self) -> None:
        data, n = self.data, len(self.data)
        while self.pos < n:
            c = data[self.pos]
            if c in b" \t\r\n\f\x00":
                self.pos += 1
            elif c == ord("%"):
                while self.pos < n and data[self.pos] not in b"\r\n":
                    self.pos += 1
            else:
                break

    def values(self) -> list[Any]:
        out: list[Any] = []
        while True:
            self._skip()
            if self.pos >= len(self.data):
                return out
            out.append(self._value())

    def _value(self) -> Any:
        self._skip()
        data = self.data
        if self.pos >= len(data):
            raise invalid_params("Truncated FDF file", {"format": "fdf"})
        if data.startswith(b"<<", self.pos):
            self.pos += 2
            return self._dict()
        c = data[self.pos]
        if c == ord("["):
            self.pos += 1
            return self._array()
        if c == ord("("):
            return self._literal()
        if c == ord("<"):
            return self._hex()
        if c == ord("/"):
            return PdfName(self._regular().decode("latin-1")[1:])
        token = self._regular().decode("latin-1")
        try:
            number = float(token) if "." in token else int(token)
        except ValueError:
            return token
        if isinstance(number, int) and number >= 0:
            save = self.pos
            self._skip()
            generation = self._regular().decode("latin-1")
            if generation.isdigit():
                self._skip()
                if self._regular() == b"R":
                    return _Reference(number)
            self.pos = save
        return number

    def _regular(self) -> bytes:
        start = self.pos
        if self.data[self.pos : self.pos + 1] == b"/":
            self.pos += 1
        while self.pos < len(self.data) and self.data[self.pos] not in b" \t\r\n\f\x00()<>[]{}/%":
            self.pos += 1
        if self.pos == start:
            self.pos += 1
        return self.data[start : self.pos]

    def _dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        while True:
            self._skip()
            if self.data.startswith(b">>", self.pos):
                self.pos += 2
                return out
            if self.pos >= len(self.data):
                raise invalid_params("Truncated FDF file", {"format": "fdf"})
            key = self._value()
            if not isinstance(key, PdfName):
                raise invalid_params("Malformed FDF dictionary", {"format": "fdf"})
            out[str(key)] = self._value()

    def _array(self) -> list[Any]:
        out: list[Any] = []
        while True:
            self._skip()
            if self.pos < len(self.data) and self.data[self.pos] == ord("]"):
                self.pos += 1
                return out
            if self.pos >= len(self.data):
                raise invalid_params("Truncated FDF file", {"format": "fdf"})
            out.append(self._value())

    def _literal(self) -> str:
        data = self.data
        self.pos += 1
        depth = 1
        out = bytearray()
        while self.pos < len(data):
            c = data[self.pos]
            self.pos += 1
            if c == ord("\\") and self.pos < len(data):
                nxt = data[self.pos]
                if nxt in _ESCAPES:
                    out.append(_ESCAPES[nxt])
                    self.pos += 1
                elif 48 <= nxt <= 55:
                    match = _OCTAL.match(data, self.pos - 1)
                    if match is None:
                        raise invalid_params("Malformed FDF string", {"format": "fdf"})
                    out.append(int(match.group(1), 8) & 0xFF)
                    self.pos = match.end()
                else:
                    out.append(nxt)
                    self.pos += 1
            elif c == ord("("):
                depth += 1
                out.append(c)
            elif c == ord(")"):
                depth -= 1
                if depth == 0:
                    return _decode_text(bytes(out))
                out.append(c)
            else:
                out.append(c)
        raise invalid_params("Unterminated FDF string", {"format": "fdf"})

    def _hex(self) -> str:
        end = self.data.find(b">", self.pos)
        if end < 0:
            raise invalid_params("Unterminated FDF hex string", {"format": "fdf"})
        digits = re.sub(rb"\s", b"", self.data[self.pos + 1 : end])
        self.pos = end + 1
        if len(digits) % 2:
            digits += b"0"
        try:
            return _decode_text(bytes.fromhex(digits.decode("ascii")))
        except ValueError as exc:
            raise invalid_params("Malformed FDF hex string", {"format": "fdf"}) from exc


def _decode_text(raw: bytes) -> str:
    if raw.startswith(b"\xfe\xff"):
        return raw[2:].decode("utf-16-be", errors="replace")
    return raw.decode("latin-1")


def _fdf_fields_map(objects: list[Any]) -> dict[str, Any]:
    found: list[Any] | None = None
    stack: list[Any] = list(objects)
    while stack and found is None:
        node = stack.pop()
        if isinstance(node, dict):
            if isinstance(node.get("Fields"), list):
                found = node["Fields"]
            else:
                stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    if found is None:
        raise invalid_params("The FDF file has no /Fields", {"format": "fdf"})
    out: dict[str, Any] = {}
    _collect_fdf(found, "", out)
    return out


def _collect_fdf(fields: list[Any], prefix: str, out: dict[str, Any]) -> None:
    for item in fields:
        if not isinstance(item, dict):
            continue
        partial = item.get("T")
        name = f"{prefix}.{partial}" if prefix and partial else (partial or prefix)
        if isinstance(item.get("Kids"), list):
            _collect_fdf(item["Kids"], name, out)
        if "V" in item and name:
            out[name] = _plain(item["V"])


def _plain(value: Any) -> Any:
    if isinstance(value, list):
        return [_plain(v) for v in value]
    if isinstance(value, PdfName):
        return str(value)
    return value


def _parse_fdf(data: bytes) -> dict[str, Any]:
    if not data.startswith(b"%FDF"):
        raise invalid_params("The file is not an FDF file", {"format": "fdf"})
    objects = _FdfReader(data).values()
    return _fdf_fields_map(objects)


def _parse_xfdf(data: bytes) -> dict[str, Any]:
    if b"<!DOCTYPE" in data or b"<!ENTITY" in data:
        raise invalid_params("XFDF with DTD or entities is not accepted", {"format": "xfdf"})
    try:
        root = ElementTree.fromstring(data)
    except ElementTree.ParseError as exc:
        raise invalid_params("The file is not valid XFDF", {"format": "xfdf"}) from exc
    fields = root.find("{http://ns.adobe.com/xfdf/}fields")
    if fields is None:
        fields = root.find("fields")
    if fields is None:
        raise invalid_params("The XFDF file has no <fields>", {"format": "xfdf"})
    out: dict[str, Any] = {}
    _collect_xfdf(list(fields), "", out)
    return out


def _collect_xfdf(elements: list[Any], prefix: str, out: dict[str, Any]) -> None:
    for el in elements:
        if el.tag.split("}")[-1] != "field":
            continue
        partial = el.get("name", "")
        name = f"{prefix}.{partial}" if prefix and partial else (partial or prefix)
        children = [c for c in el if c.tag.split("}")[-1] == "field"]
        values = [c for c in el if c.tag.split("}")[-1] == "value"]
        if children:
            _collect_xfdf(children, name, out)
        if values and name:
            texts = [v.text or "" for v in values]
            out[name] = texts if len(texts) > 1 else texts[0]


__all__ = ["FORMATS", "export_text", "export_values", "parse_import"]
