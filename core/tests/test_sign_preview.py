"""sign.templatePreview: the real signature appearance rendered to a PNG (template studio).

The PNG is checked for non-blank ink, ink inside the bounds, Vietnamese text making a difference,
and the size in pixels for the requested dpi.
"""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from conftest import Harness, RpcFailure
from PIL import Image

from chef_core.ops import load_builtin_ops

VALUES: dict[str, Any] = {
    "signerName": "Nguyễn Văn A",
    "organization": "Công ty Cổ phần Ví Dụ",
    "taxCode": "0101234567",
    "citizenId": "001234567890",
    "reason": "Duyệt hồ sơ",
    "location": "Hà Nội",
    "contact": "a@example.vn",
    "date": "2026-10-31T14:30:00+07:00",
}


@pytest.fixture(autouse=True)
def _builtins() -> None:
    load_builtin_ops()


def _preview(h: Harness, path: Path, **params: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "width": 220,
        "height": 80,
        "outputPath": str(path),
        "dpi": 144,
        "values": VALUES,
    }
    body.update(params)
    return dict(h.op("sign.templatePreview", body)["data"])


def _count_pixels(img: Image.Image, predicate: Callable[[int, int, int], bool]) -> int:
    data = img.convert("RGB").tobytes()
    return sum(1 for i in range(0, len(data), 3) if predicate(data[i], data[i + 1], data[i + 2]))


def _ink_box(img: Image.Image) -> tuple[int, int, int, int] | None:
    gray = img.convert("L").point(lambda v: 255 if v < 160 else 0)
    return gray.getbbox()


def test_default_template_renders_vietnamese_text_inside_the_box(
    harness: Harness, tmp_path: Path
) -> None:
    out = tmp_path / "default.png"
    data = _preview(harness, out)
    assert data["outputPath"] == str(out)
    assert data["widthPx"] == round(220 * 144 / 72) and data["heightPx"] == round(80 * 144 / 72)
    img = Image.open(out)
    assert img.size == (data["widthPx"], data["heightPx"])
    box = _ink_box(img)
    assert box is not None
    left, top, right, bottom = box
    assert right - left > 100 and bottom - top > 10  # real text, not a dot
    assert left >= 0 and top >= 0 and right <= img.width and bottom <= img.height


def test_checkmark_bold_and_border_template_renders(harness: Harness, tmp_path: Path) -> None:
    out = tmp_path / "styled.png"
    template = {
        "name": "Có dấu tick",
        "header": "Ký số bởi",
        "checkmark": True,
        "bold": True,
        "textColor": "#1F3A93",
        "border": {"width": 1.5, "color": "#1F3A93"},
        "background": {"color": "#F7F9FF", "opacity": 0.8},
        "align": "center",
        "valign": "middle",
    }
    _preview(harness, out, template=template)
    img = Image.open(out).convert("RGB")
    assert _ink_box(img) is not None
    blue_ink = _count_pixels(img, lambda r, g, b: b > r + 60)  # the blue border and text
    assert blue_ink > 200


def test_vietnamese_name_changes_the_picture(harness: Harness, tmp_path: Path) -> None:
    plain = tmp_path / "plain.png"
    accented = tmp_path / "accented.png"
    _preview(harness, plain, values={"signerName": "Nguyen Van A"})
    _preview(harness, accented, values={"signerName": "Nguyễn Văn Ậ"})
    a = Image.open(plain).convert("L").tobytes()
    b = Image.open(accented).convert("L").tobytes()
    assert a != b


def test_empty_values_still_render_the_box(harness: Harness, tmp_path: Path) -> None:
    out = tmp_path / "empty.png"
    _preview(harness, out, values={})
    assert Image.open(out).size[0] > 0


def test_the_template_decides_the_look(harness: Harness, tmp_path: Path) -> None:
    text_only = tmp_path / "text.png"
    banner = tmp_path / "banner.png"
    _preview(harness, text_only, template={"layout": "text-only", "border": None})
    _preview(
        harness,
        banner,
        template={"border": None, "background": {"color": "#FFE08A", "opacity": 1.0}},
    )
    yellow = sum(
        1 for px in Image.open(banner).convert("RGB").getdata() if px[0] > 240 and px[2] < 180
    )
    assert yellow > 10000
    assert (
        sum(
            1
            for px in Image.open(text_only).convert("RGB").getdata()
            if px[0] > 240 and px[2] < 180
        )
        == 0
    )


def test_bad_size_is_refused(harness: Harness, tmp_path: Path) -> None:
    with pytest.raises(RpcFailure) as exc:
        _preview(harness, tmp_path / "x.png", width=0)
    assert exc.value.kind == "INVALID_PARAMS"
