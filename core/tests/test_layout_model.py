"""T10.01: the document model (JSON wire format, block kinds, schema file)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from chef_core.layout.model import (
    BLOCK_KINDS,
    DocModel,
    Footer,
    Heading,
    ListBlock,
    ListItem,
    Meta,
    PageInfo,
    Paragraph,
    Run,
    SourceInfo,
    Table,
    TableCell,
    block_kinds,
    dump_json,
)
from chef_core.layout.schema import SCHEMA_PATH
from chef_core.layout.schema import render as render_schema


def _sample() -> DocModel:
    cell = TableCell(blocks=[Paragraph(bbox=(1, 2, 3, 4), runs=[Run(text="Quý 1")])])
    return DocModel(
        source=SourceInfo(name="a.pdf", page_count=1),
        pages=[
            PageInfo(
                index=0,
                width=595,
                height=842,
                blocks=[
                    Heading(
                        bbox=(72, 60, 300, 80),
                        reading_order=0,
                        level=2,
                        runs=[Run(text="Điều 1. Phạm vi", bold=True, size=12, font="BeVietnamPro")],
                        source_refs=["L0:abc:0"],
                    ),
                    Paragraph(
                        bbox=(72, 90, 300, 120),
                        reading_order=1,
                        runs=[Run(text="Nội dung", link="https://example.com", sup=True)],
                        joined_pages=[1],
                        confidence=0.95,
                    ),
                    ListBlock(
                        bbox=(72, 130, 300, 160),
                        reading_order=2,
                        ordered=True,
                        items=[ListItem(runs=[Run(text="Một")], marker="1.")],
                    ),
                    Table(
                        bbox=(72, 170, 300, 200),
                        reading_order=3,
                        has_header_row=True,
                        columns=1,
                        rows=[[cell]],
                    ),
                    Footer(bbox=(72, 800, 300, 810), reading_order=4, runs=[Run(text="Bí mật")]),
                ],
            )
        ],
        meta=Meta(title="Báo cáo", lang="vi"),
    )


def test_model_round_trips_through_json_with_every_block_kind() -> None:
    model = _sample()
    text = dump_json(model)
    again = DocModel.model_validate_json(text)
    assert again == model
    assert dump_json(again) == text


def test_wire_format_is_camel_case() -> None:
    text = dump_json(_sample())
    for key in ('"pageCount"', '"readingOrder"', '"sourceRefs"', '"hasHeaderRow"', '"joinedPages"'):
        assert key in text
    assert '"page_count"' not in text and '"reading_order"' not in text


def test_block_kinds_are_counted_and_listed() -> None:
    counts = block_kinds(_sample())
    assert counts["heading"] == 1 and counts["paragraph"] == 1 and counts["table"] == 1
    assert counts["image"] == 0 and set(counts) == set(BLOCK_KINDS)


def test_unknown_block_kind_is_rejected() -> None:
    bad = {"kind": "chart", "bbox": [0, 0, 1, 1]}
    with pytest.raises(ValidationError):
        DocModel.model_validate(
            {
                "source": {"name": "x", "pageCount": 1},
                "pages": [{"index": 0, "width": 1, "height": 1, "blocks": [bad]}],
            }
        )


@pytest.mark.parametrize("level", [0, 7])
def test_heading_level_must_be_between_one_and_six(level: int) -> None:
    with pytest.raises(ValidationError):
        Heading(bbox=(0, 0, 1, 1), level=level)


def test_confidence_must_be_a_fraction() -> None:
    with pytest.raises(ValidationError):
        Paragraph(bbox=(0, 0, 1, 1), confidence=1.5)


def test_block_type_can_be_changed_by_rebuilding_the_block() -> None:
    para = Paragraph(bbox=(0, 0, 10, 10), runs=[Run(text="Tiêu đề")], source_refs=["L0:x:1"])
    head = Heading(
        bbox=para.bbox,
        level=1,
        runs=para.runs,
        source_refs=para.source_refs,
        confidence=0.5,
    )
    assert head.kind == "heading" and head.source_refs == ["L0:x:1"]


def test_schema_file_is_up_to_date() -> None:
    assert SCHEMA_PATH.read_text(encoding="utf-8") == render_schema()
    schema = render_schema()
    assert '"DocModel"' in schema and '"discriminator"' in schema
