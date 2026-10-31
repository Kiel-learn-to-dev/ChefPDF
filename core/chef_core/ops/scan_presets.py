"""Built-in scan presets (K8) as plain data.

Each preset holds the wire (camelCase) form of ``RasterizeParams``, so the UI can pass
``params`` to ``scan.rasterize`` or ``scan.preview`` unchanged. ``scan.presets`` returns them.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ScanPreset:
    name: str
    label_vi: str
    label_en: str
    params: dict[str, Any]


PRESETS: tuple[ScanPreset, ...] = (
    ScanPreset(
        name="email-light",
        label_vi="Nhẹ để gửi email",
        label_en="Light for email",
        params={"dpi": 150, "color": "gray", "jpegQuality": 60},
    ),
    ScanPreset(
        name="archive",
        label_vi="Lưu trữ",
        label_en="Archive",
        params={"dpi": 300, "color": "color", "jpegQuality": 80},
    ),
    ScanPreset(
        name="fax-bw",
        label_vi="Fax đen trắng",
        label_en="Black and white fax",
        params={"dpi": 200, "color": "bw", "dithering": False, "threshold": 140},
    ),
    ScanPreset(
        name="photocopy",
        label_vi="Bản photocopy",
        label_en="Photocopy",
        params={"dpi": 200, "color": "gray", "effectsPreset": "photocopy"},
    ),
    ScanPreset(
        name="old-document",
        label_vi="Tài liệu cũ",
        label_en="Old document",
        params={"dpi": 200, "color": "color", "effectsPreset": "old-paper"},
    ),
)


def describe_presets() -> list[dict[str, Any]]:
    """Presets in the shape returned by the ``scan.presets`` RPC method."""
    return [
        {
            "name": preset.name,
            "labelVi": preset.label_vi,
            "labelEn": preset.label_en,
            "params": dict(preset.params),
        }
        for preset in PRESETS
    ]
