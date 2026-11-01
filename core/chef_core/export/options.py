"""Options of the exporters (T10.04-T10.07). One flat model: each format reads the fields it needs
and ignores the rest. The UI builds its dialogs from the JSON Schema of the operation params."""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from chef_core.models import WireModel

Format = Literal["md", "html", "txt", "json", "epub", "odt", "xlsx", "docx"]
FORMATS: tuple[str, ...] = ("md", "html", "txt", "json", "epub", "odt", "xlsx", "docx")
EXTENSIONS: dict[str, str] = {
    "md": ".md",
    "html": ".html",
    "txt": ".txt",
    "json": ".json",
    "epub": ".epub",
    "odt": ".odt",
    "xlsx": ".xlsx",
    "docx": ".docx",
    "pdf": ".pdf",  # batch only: the refreshed PDF of N6 (export.refresh)
}


class ExportOptions(WireModel):
    """Options shared by the exporters. Defaults give a plain, complete export of the body."""

    include_headers_footers: bool = Field(
        default=False,
        description="Repeated headers, footers and page numbers. Off: they are left out.",
    )
    include_images: bool = Field(default=True, description="Images and vector figures.")
    embed_images: bool = Field(default=False, description="HTML only: images inside the file.")
    page_markers: bool = Field(default=False, description="TXT only: a line per source page.")
    parse_numbers: bool = Field(
        default=True, description="XLSX only: numbers (1.234,56) and dates (dd/mm/yyyy) as typed."
    )
    chapter_mode: Literal["heading1", "pages"] = Field(
        default="heading1", description="EPUB only: a chapter per level-1 heading, or per N pages."
    )
    pages_per_chapter: int = Field(
        default=10, ge=1, le=1000, description="EPUB, chapterMode=pages."
    )
    mode: Literal["editable", "layout"] = Field(
        default="editable",
        description="DOCX only: 'editable' flowing text, 'layout' positioned frames per page.",
    )
    page_breaks: bool = Field(
        default=False, description="DOCX editable: a page break at each source page."
    )
    title: str | None = Field(default=None, max_length=300, description="Overrides the title.")
    author: str | None = Field(default=None, max_length=200, description="Overrides the author.")
    language: str = Field(default="vi", min_length=2, max_length=12, description="BCP 47 tag.")
    page_size: Literal["A4", "Letter", "source"] = Field(
        default="A4", description="REFRESH only: paper size; 'source' uses the first page's size."
    )
    font_scale: float = Field(default=1.0, ge=0.6, le=1.6, description="REFRESH only.")
    margins: float = Field(default=56.0, ge=18, le=150, description="REFRESH only, in points.")


__all__ = ["EXTENSIONS", "FORMATS", "ExportOptions", "Format"]
