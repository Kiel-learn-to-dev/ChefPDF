"""Checklist before sending a document (feature J5; T5.03).

``preflight.check`` (session, read-only) runs the checks in a fixed order and returns a list of
``{id, status, titleVi, titleEn, detail, fixOp}``. ``status`` is ``ok``, ``warn`` or ``fail``.
``fixOp`` is ``{op, params}`` for the operation that repairs the item, or null when no operation
can (or when the fix needs input the checklist does not have, see ``doc.setMetadata``).

Hidden data is checked with the same scan as ``inspect.hiddenData``; signatures with the
verifier of ``sign.verify``. Revocation checks are off by default, so the checklist makes no
network requests unless ``checkRevocation`` is ``soft`` or ``hard``.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import pikepdf
from pydantic import Field

from chef_core.errors import ChefError
from chef_core.models import WireModel
from chef_core.ops.base import OpContext, OpOutput, operation
from chef_core.ops.inspect import CATEGORIES, IMAGES, Finding, scan_path
from chef_core.pdf.io import opened_pdf
from chef_core.pdf.outline import read_bookmarks
from chef_core.pdf.pages import display_size
from chef_core.session.manager import EncryptionState
from chef_core.signing.trust import default_trust_store
from chef_core.signing.verify import VerifyOptions, verify_document

LOW_DPI = 100
HIGH_DPI = 600
BOOKMARK_PAGES = 20
MIN_PAGE_PT = 36.0
MAX_PAGE_PT = 14400.0
BLANK_CONTENT_BYTES = 8

_TITLES: dict[str, tuple[str, str]] = {
    "fileSize": ("Dung lượng file", "File size"),
    "signatures.unsigned": ("Chữ ký còn trống", "Empty signature fields"),
    "signatures.validity": ("Chữ ký còn hợp lệ", "Signatures are valid"),
    "fonts.notEmbedded": ("Font chưa nhúng", "Fonts not embedded"),
    "pages.blank": ("Trang trắng", "Blank pages"),
    "pages.sizes": ("Khổ giấy", "Page sizes"),
    "images.lowDpi": ("Ảnh độ phân giải thấp", "Low-resolution images"),
    "images.highDpi": ("Ảnh độ phân giải quá cao", "Very high-resolution images"),
    "metadata.titleAuthor": ("Tiêu đề và tác giả", "Title and author"),
    "security.printing": ("Quyền in", "Printing permission"),
    "bookmarks.missing": ("Mục lục", "Bookmarks"),
    "hidden.hiddenText": ("Chữ ẩn", "Hidden text"),
}


def _hidden_title(category: str) -> tuple[str, str]:
    titles = {
        "metadata": ("Metadata còn sót", "Leftover metadata"),
        "embeddedFiles": ("File đính kèm còn sót", "Leftover embedded files"),
        "javascript": ("JavaScript", "JavaScript"),
        "launchActions": ("Hành động mở chương trình", "Launch actions"),
        "hiddenLayers": ("Lớp ẩn", "Hidden layers"),
        "comments": ("Ghi chú còn sót", "Leftover comments"),
        "formValues": ("Dữ liệu form chưa làm phẳng", "Unflattened form values"),
        "bookmarks": ("Mục lục", "Bookmarks"),
        "thumbnails": ("Ảnh thu nhỏ", "Thumbnails"),
        "externalLinks": ("Liên kết ra ngoài", "External links"),
        "xfa": ("Form XFA", "XFA form"),
        "revisionHistory": ("Lịch sử sửa còn sót", "Leftover revision history"),
        "unusedObjects": ("Đối tượng thừa", "Unused objects"),
        "fontsNotEmbedded": ("Font chưa nhúng", "Fonts not embedded"),
        "images": ("Ảnh", "Images"),
    }
    return titles.get(category, (category, category))


@dataclass
class CheckResult:
    id: str
    status: Literal["ok", "warn", "fail"]
    detail: dict[str, Any]
    fix: dict[str, Any] | None = None

    def as_dict(self) -> dict[str, Any]:
        if self.id.startswith("hidden."):
            vi, en = _hidden_title(self.id[len("hidden.") :])
        else:
            vi, en = _TITLES[self.id]
        return {
            "id": self.id,
            "status": self.status,
            "titleVi": vi,
            "titleEn": en,
            "detail": self.detail,
            "fixOp": self.fix,
        }


def _fix(op: str, **params: Any) -> dict[str, Any]:
    return {"op": op, "params": params}


def _blank(page: pikepdf.Page) -> bool:
    contents = page.obj.get("/Contents")
    if isinstance(contents, pikepdf.Stream):
        streams: list[Any] = [contents]
    elif isinstance(contents, pikepdf.Array):
        streams = [c for c in contents if isinstance(c, pikepdf.Stream)]
    else:
        streams = []
    data = b"".join(s.read_bytes() for s in streams)
    if len(data.strip()) > BLANK_CONTENT_BYTES:
        return False
    if page.obj.get("/Annots"):
        return False
    resources = page.obj.get("/Resources")
    return not (isinstance(resources, pikepdf.Dictionary) and "/XObject" in resources)


def _check_hidden(findings: dict[str, Finding]) -> list[CheckResult]:
    results: list[CheckResult] = []
    for category, (severity, fixable) in CATEGORIES.items():
        if category in (IMAGES, "fontsNotEmbedded", "bookmarks"):
            continue
        finding = findings[category]
        if category == "hiddenText":
            status = "fail" if finding.count else "ok"
            fix = None
        else:
            status = "ok" if finding.count == 0 else ("fail" if severity == "risk" else "warn")
            fix = _fix("inspect.removeHidden", categories=[category]) if fixable else None
        results.append(
            CheckResult(
                f"hidden.{category}",
                status,  # type: ignore[arg-type]
                {"count": finding.count},
                fix if finding.count else None,
            )
        )
    return results


def run_checks(
    path: Path,
    protection: EncryptionState | None,
    max_bytes: int | None,
    check_revocation: str,
) -> list[dict[str, Any]]:
    results: list[CheckResult] = []

    size = path.stat().st_size
    if max_bytes is None:
        results.append(CheckResult("fileSize", "ok", {"bytes": size, "limitBytes": None}))
    else:
        over = size > max_bytes
        results.append(
            CheckResult(
                "fileSize",
                "fail" if over else "ok",
                {"bytes": size, "limitBytes": max_bytes},
                _fix("compress.fitSize", targetBytes=max_bytes) if over else None,
            )
        )

    findings = scan_path(path)
    results.extend(_check_hidden(findings))

    try:
        report = verify_document(
            path,
            VerifyOptions(trust=default_trust_store(), check_revocation=check_revocation),  # type: ignore[arg-type]
        )["signatures"]
    except ChefError as exc:  # a signature that cannot be read at all
        report = []
        results.append(
            CheckResult(
                "signatures.validity",
                "fail",
                {"error": exc.message, "count": None},
            )
        )
    unsigned = [s["fieldName"] for s in report if s["status"] == "unsigned"]
    signed = [s for s in report if s["status"] != "unsigned"]
    results.append(
        CheckResult(
            "signatures.unsigned",
            "warn" if unsigned else "ok",
            {"fields": unsigned},
        )
    )
    if signed:
        bad = [s["fieldName"] for s in signed if s["status"] == "invalid"]
        weak = [s["fieldName"] for s in signed if s["status"] not in ("valid", "invalid")]
        status = "fail" if bad else ("warn" if weak else "ok")
        results.append(
            CheckResult(
                "signatures.validity",
                status,  # type: ignore[arg-type]
                {"invalid": bad, "notFullyValid": weak, "count": len(signed)},
            )
        )

    with opened_pdf(path) as pdf:
        pages = list(pdf.pages)
        sizes: dict[tuple[float, float], int] = {}
        odd_sizes: list[dict[str, Any]] = []
        blank_pages: list[int] = []
        for index, page in enumerate(pages):
            w, h, _ = display_size(page)
            key = (round(min(w, h), 1), round(max(w, h), 1))
            sizes[key] = sizes.get(key, 0) + 1
            if min(w, h) < MIN_PAGE_PT or max(w, h) > MAX_PAGE_PT:
                odd_sizes.append({"page": index + 1, "width": w, "height": h})
            if _blank(page):
                blank_pages.append(index)
        has_bookmarks = bool(read_bookmarks(pdf))
        info = pdf.trailer.get("/Info")
        info_map: Any = info if isinstance(info, pikepdf.Dictionary) else {}
        page_count = len(pages)
    fonts = [str(item["name"]) for item in findings["fontsNotEmbedded"].items]
    title = str(info_map.get("/Title", "")).strip()
    author = str(info_map.get("/Author", "")).strip()

    results.append(
        CheckResult(
            "fonts.notEmbedded",
            "warn" if fonts else "ok",
            {"fonts": fonts},
        )
    )
    if blank_pages:
        fix = _fix("page.delete", pages=blank_pages) if len(blank_pages) < page_count else None
        results.append(
            CheckResult(
                "pages.blank",
                "warn",
                {"pages": [i + 1 for i in blank_pages]},
                fix,
            )
        )
    else:
        results.append(CheckResult("pages.blank", "ok", {"pages": []}))
    mixed = len(sizes) > 1
    status = "warn" if (mixed or odd_sizes) else "ok"
    results.append(
        CheckResult(
            "pages.sizes",
            status,  # type: ignore[arg-type]
            {
                "sizes": [{"width": k[0], "height": k[1], "pages": n} for k, n in sizes.items()],
                "odd": odd_sizes,
            },
        )
    )

    images = findings[IMAGES].items
    low = [i for i in images if i.get("dpi") is not None and i["dpi"] < LOW_DPI]
    high = [i for i in images if i.get("dpi") is not None and i["dpi"] > HIGH_DPI]
    results.append(
        CheckResult(
            "images.lowDpi",
            "warn" if low else "ok",
            {"images": [{"page": i["page"], "dpi": i["dpi"]} for i in low]},
        )
    )
    results.append(
        CheckResult(
            "images.highDpi",
            "warn" if high else "ok",
            {"images": [{"page": i["page"], "dpi": i["dpi"]} for i in high]},
            _fix("compress.pdf", maxImageDpi=HIGH_DPI) if high else None,
        )
    )

    missing = [name for name, value in (("title", title), ("author", author)) if not value]
    results.append(
        CheckResult(
            "metadata.titleAuthor",
            "warn" if missing else "ok",
            {"missing": missing},
            _fix("doc.setMetadata") if missing else None,
        )
    )

    if protection is not None:
        allow = protection.allow
        blocked = not allow.print_lowres and not allow.print_highres
        results.append(
            CheckResult(
                "security.printing",
                "warn" if blocked else "ok",
                {
                    "printLowRes": bool(allow.print_lowres),
                    "printHighRes": bool(allow.print_highres),
                },
                _fix("security.decrypt") if blocked else None,
            )
        )

    needs_bookmarks = page_count > BOOKMARK_PAGES and not has_bookmarks
    results.append(
        CheckResult(
            "bookmarks.missing",
            "warn" if needs_bookmarks else "ok",
            {"pages": page_count},
            _fix("bookmarks.fromPages", mode="replace") if needs_bookmarks else None,
        )
    )
    return [r.as_dict() for r in results]


class PreflightParams(WireModel):
    """Run the checklist on the session document."""

    max_bytes: int | None = Field(
        default=None, ge=1, description="Size limit of the file (for example 10 MB)."
    )
    check_revocation: Literal["none", "soft", "hard"] = Field(
        default="none", description="Revocation check of the signatures. none: offline."
    )


@operation(
    id="preflight.check",
    title="Check before sending",
    group="preflight",
    params=PreflightParams,
)
def check(ctx: OpContext, p: PreflightParams) -> OpOutput:
    if ctx.input_path is None:
        raise RuntimeError("preflight.check needs a session")
    ctx.check_cancelled()
    results = run_checks(ctx.input_path, ctx.protection, p.max_bytes, p.check_revocation)
    return OpOutput(changed_pages=[], data=results)
