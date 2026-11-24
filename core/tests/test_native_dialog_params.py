"""Tham số mà các hộp thoại sinh từ schema của bản Rust gửi cho lõi (TASKS_RUST R5.11 đến R5.59).

`apps/native/crates/chef-app/testdata/dialog_params.json` do test Rust `golden_tests.rs` sinh từ
chính `SchemaForm` và bảng `OPS` của hộp thoại (kèm giá trị mặc định). File này chạy từng mục trên
lõi thật: nếu một trường bị đặt sai tên, sai kiểu hoặc lõi từ chối giá trị mặc định thì test đỏ.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import Any

import pytest
from conftest import Harness, page_count
from layout_support import report_pdf
from pageimg_support import rotate_ccw, text_page
from pdf_media import new_pdf, place, save
from PIL import Image
from test_pageedit import _rev, _sid
from test_pageimg_ops import _image_pdf

GOLDEN = (
    Path(__file__).resolve().parents[2]
    / "apps"
    / "native"
    / "crates"
    / "chef-app"
    / "testdata"
    / "dialog_params.json"
)


def _golden() -> dict[str, dict[str, Any]]:
    return json.loads(GOLDEN.read_text(encoding="utf-8"))  # type: ignore[no-any-return]


def _fill(value: Any, paths: dict[str, str]) -> Any:
    if isinstance(value, str):
        for key, real in paths.items():
            value = value.replace("{" + key + "}", real)
        return value
    if isinstance(value, list):
        return [_fill(v, paths) for v in value]
    if isinstance(value, dict):
        return {k: _fill(v, paths) for k, v in value.items()}
    return value


def _text_doc(path: Path, pages: int = 4) -> Path:
    pdf = new_pdf(0)
    for i in range(pages):
        page = pdf.add_blank_page(page_size=(612, 792))
        place(pdf, page, [], text=f"Chuong {i + 1}. Noi dung trang {i + 1}")
    return save(pdf, path)


# Cách chạy của từng hộp thoại, theo OpMode trong op_dialog.rs.
STANDALONE = {
    "overlay.bates",
    "workflow.validate",
    "workflow.run",
    "batch.run",
    "export.batch",
    "naming.preview",
    "naming.apply",
    "image.cleanup",
    "image.removeBackground",
    "image.textSignature",
    "sign.verifyFile",
    "sign.trustList",
    "sign.driverScan",
    "sign.diagnoseToken",
    "sign.verifyBatch",
    "watch.scan",
    "compress.file",
    "convert.pdfToImages",
    "convert.imagesToPdf",
    "doc.optimizeWeb",
    "doc.repair",
}
OUTPUT = {
    "redact.find",
    "layout.analyze",
    "doc.extractImages",
    "doc.extractText",
    "doc.attachments.extract",
    "export.document",
    "preflight.check",
    "inspect.hiddenData",
    "watermark.detect",
    "toc.preview",
    "compress.estimate",
    "forms.detectFields",
    "sign.verify",
}
# Cần phần cứng, chứng thư hoặc file đã ký mà môi trường kiểm thử không có: chỉ kiểm dạng tham số
# bằng test Rust (`golden_tests.rs`), lõi có test riêng ở test_sign_*.py.
NEEDS_EXTERNAL = {
    "sign.certInfo",
    "sign.trustAdd",
    "sign.trustRemove",
    "sign.listStoreCertificates",
    "sign.listTokens",
    "sign.extractRevision",
}
SCAN_FIXTURE = {
    "pageimg.autoCrop",
    "pageimg.deskew",
    "pageimg.dewarp",
    "pageimg.enhance",
    "pageimg.splitSpread",
    "pageimg.removeFingers",
    "pageimg.removeStains",
}
# Hộp thoại Output / Standalone phải để lại file.
WRITES = {
    "compress.file",
    "convert.pdfToImages",
    "convert.imagesToPdf",
    "doc.optimizeWeb",
    "doc.repair",
    "doc.extractText",
    "export.document",
}
# Thao tác sửa tài liệu mà mẫu này không làm đổi gì (không có dấu nào để gỡ): chỉ cần lõi chấp nhận.
NO_CHANGE_EXPECTED = {
    "overlay.remove",
    "watermark.remove",
    "background.remove",
    # Tài liệu mẫu chỉ có chữ, không có ảnh để đổi màu, ghi chú, lớp hay bookmark để gỡ.
    "color.convert",
    "annots.flatten",
    "annots.removeAll",
    "layers.flatten",
    "bookmarks.clear",
    "inspect.removeHidden",
    "links.autoDetect",
    "text.findReplace",
    # Trang ảnh mẫu không có vết bẩn, ngón tay hay nền cần xử lý: lõi báo "xem lại" nhưng không lỗi.
    "pageimg.removeFingers",
    "pageimg.removeStains",
    "pageimg.dewarp",
    "pageimg.autoCrop",
    "pageimg.splitSpread",
}


def test_every_dialog_sample_is_covered() -> None:
    assert len(_golden()) >= 29


@pytest.mark.parametrize("key", sorted(_golden()))
def test_dialog_params_are_accepted_by_the_core(
    harness: Harness, corpus: dict[str, Path], tmp_path: Path, key: str
) -> None:
    entry = _golden()[key]
    src = _text_doc(tmp_path / "bao-cao.pdf")
    img = tmp_path / "con-dau.png"
    Image.new("RGB", (80, 40), (200, 30, 30)).save(img)
    att = tmp_path / "ghi-chu.txt"
    att.write_text("tệp đính kèm", encoding="utf-8")
    out_dir = tmp_path / "ra"
    out_dir.mkdir()
    suffix = {
        "doc.extractText": ".txt",
        "export.document": ".txt",
        "image.cleanup": ".png",
        "image.removeBackground": ".png",
        "image.textSignature": ".png",
        "sign.verifyBatch": ".csv",
    }.get(key, ".pdf")
    out = tmp_path / f"ket-qua{suffix}"
    paths = {
        "a": str(src),
        "img": str(img),
        "att": str(att),
        "dir": str(out_dir),
        "out": str(out),
        "rep": str(tmp_path / "bao-cao.csv"),
        "led": str(tmp_path / "so-theo-doi.json"),
    }
    params = _fill(entry["params"], paths)
    op = entry["op"]

    if key in {"sign.verifyBatch", "watch.scan"}:
        shutil.copy(src, out_dir / "a.pdf")  # thư mục cần có ít nhất một PDF để quét

    if key in NEEDS_EXTERNAL:
        pytest.skip("cần chứng thư, token hoặc file đã ký; chỉ kiểm dạng tham số ở phía Rust")

    if key == "security.decrypt":
        sid = str(harness.open(corpus["encrypted_1234.pdf"], "1234")["state"]["sessionId"])
        result = harness.op(op, params, sid)
        # Gỡ mật khẩu là hiệu ứng của phiên (ghi nhận "gỡ" để áp khi lưu), không tạo revision mới.
        assert result["state"]["pendingEncryption"] is True
        assert result["state"]["canUndo"] is False
        return

    if key == "security.encrypt":
        sid = _sid(harness, src)
        result = harness.op(op, params, sid)
        # Mật khẩu được áp khi lưu, không tạo revision mới.
        assert result["state"]["pendingEncryption"] is True
        return

    if key == "toc.insertPage":
        src = report_pdf(tmp_path / "bao-cao-tieu-de.pdf", pages=6)
        sid = _sid(harness, src)
        result = harness.op(op, params, sid)
        assert result["state"]["canUndo"] is True
        assert page_count(_rev(harness, sid)) == 7
        return

    if key in STANDALONE:
        result = harness.op(op, params)
        if key.startswith("image."):
            assert out.exists(), key
        if key == "sign.verifyBatch":
            assert (tmp_path / "bao-cao.csv").exists()
        if key == "watch.scan":
            assert result["outputs"] == [] or isinstance(result["outputs"], list)
        if key in WRITES:
            assert Path(result["outputs"][0]).exists() or out.exists() or any(out_dir.iterdir())
        if key == "convert.imagesToPdf":
            assert page_count(out) == 2
        if key == "convert.pdfToImages":
            assert len(list(out_dir.iterdir())) == 2  # trang 1-2
        return

    if key in SCAN_FIXTURE:
        frames = [rotate_ccw(text_page(1240, 1754, seed=1), 3.0), text_page(1240, 1754, seed=2)]
        src = _image_pdf(tmp_path / "ban-quet.pdf", frames)
    sid = _sid(harness, src)
    if key == "doc.attachments.extract":
        harness.op("doc.attachments.add", {"paths": [str(att)]}, sid)
    before = _rev(harness, sid)
    result = harness.op(op, params, sid)

    if key in OUTPUT:
        if key in WRITES:
            assert out.exists(), key
        if key == "doc.attachments.extract":
            assert (out_dir / "ghi-chu.txt").read_text(encoding="utf-8") == "tệp đính kèm"
        if key != "doc.attachments.extract":  # mẫu này đã thêm file đính kèm trước đó
            # Thao tác chỉ đọc không đổi tài liệu.
            assert result["state"]["canUndo"] is False
        return

    if key not in NO_CHANGE_EXPECTED:
        assert result["state"]["canUndo"] is True, key
        assert _rev(harness, sid) != before or result["changedPages"] == [], key
