"""Sanity checks for the generated test corpus (scripts/gen_corpus.py)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pikepdf
import pytest
from PIL import Image


def test_corpus_files_exist(corpus: dict[str, Path]) -> None:
    assert len(corpus) >= 15
    for path in corpus.values():
        assert path.is_file() and path.stat().st_size > 0


def test_vietnamese_font_is_subset_embedded(corpus: dict[str, Path]) -> None:
    with pikepdf.open(corpus["vietnamese_text.pdf"]) as pdf:
        names = [str(f.BaseFont) for f in pdf.pages[0].resources.Font.values()]
    assert any(n[1:7].isupper() and n[7] == "+" and "BeVietnamPro" in n for n in names)


def test_encrypted_needs_password(corpus: dict[str, Path]) -> None:
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(corpus["encrypted_1234.pdf"])
    with pikepdf.open(corpus["encrypted_1234.pdf"], password="1234") as pdf:
        assert pdf.encryption.R == 6


def test_exif_jpeg(corpus: dict[str, Path]) -> None:
    with Image.open(corpus["photo_exif6.jpg"]) as im:
        assert im.size == (400, 200)
        assert im.getexif()[0x0112] == 6


def test_generator_is_deterministic(
    gen_corpus_module: Any, tmp_path: Path, corpus: dict[str, Path]
) -> None:
    files = gen_corpus_module.generate(tmp_path)
    for name in (
        "outline_10p.pdf",
        "mixed_sizes.pdf",
        "images_8p.pdf",
        "scanned_like.pdf",
        "photo_exif6.jpg",
    ):
        assert files[name].read_bytes() == corpus[name].read_bytes(), name
