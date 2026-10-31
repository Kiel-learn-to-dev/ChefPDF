"""Bundled fonts for the signature appearance (T3.09).

The font files live in ``chef_core/resources/fonts``. They are resolved with ``importlib.resources``
so the same code finds them in a source checkout, in an installed wheel and in the PyInstaller
bundle (which copies package data with ``--collect-data chef_core``).
"""

from __future__ import annotations

from importlib import resources
from pathlib import Path

from chef_core.errors import ChefError, ErrorKind

BUNDLED_FONT_FAMILIES: tuple[str, ...] = ("BeVietnamPro",)
_FONT_FILES = {
    ("BeVietnamPro", False): "BeVietnamPro-Regular.ttf",
    ("BeVietnamPro", True): "BeVietnamPro-Bold.ttf",
}


def font_path(family: str, *, bold: bool) -> Path:
    """Path of a bundled TrueType font. Unknown families are an internal error."""
    filename = _FONT_FILES.get((family, bold))
    if filename is None:
        raise ChefError(ErrorKind.INTERNAL, f"Font is not bundled: {family}")
    path = Path(str(resources.files("chef_core.resources") / "fonts" / filename))
    if not path.is_file():
        raise ChefError(ErrorKind.INTERNAL, f"Bundled font is missing: {filename}")
    return path
