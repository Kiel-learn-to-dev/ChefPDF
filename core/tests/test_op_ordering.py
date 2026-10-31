"""Operation order safety (BLUEPRINT 3, O5/D10): check_op_order / ensure_op_order."""

from __future__ import annotations

import pytest

from chef_core.errors import ChefError, ErrorKind
from chef_core.ops import load_builtin_ops
from chef_core.ops.base import get_op
from chef_core.ops.ordering import check_op_order, ensure_op_order


@pytest.fixture(autouse=True)
def _builtins() -> None:
    load_builtin_ops()


def _specs(*ids: str) -> list:
    specs = []
    for op_id in ids:
        spec = get_op(op_id)
        assert spec is not None, op_id
        specs.append(spec)
    return specs


def test_destructive_steps_before_signing_are_fine() -> None:
    steps = _specs("stamp.text", "overlay.watermark", "sign.pades")
    assert check_op_order(steps) is None
    ensure_op_order(steps)  # does not raise


def test_non_destructive_steps_may_follow_signing() -> None:
    steps = _specs("sign.pades", "sign.verify")
    assert check_op_order(steps) is None


def test_destructive_step_after_signing_is_reported_with_its_position() -> None:
    steps = _specs("stamp.text", "sign.pades", "overlay.addText")
    violation = check_op_order(steps)
    assert violation is not None
    assert violation.index == 2
    assert violation.op_id == "overlay.addText"
    assert violation.after_index == 1
    assert violation.after_op_id == "sign.pades"
    assert "overlay.addText" in violation.message
    assert "sign.pades" in violation.message
    assert "Bước 3" in violation.message  # Vietnamese, 1-based step number


def test_ensure_raises_blocked_with_structured_detail() -> None:
    steps = _specs("sign.pades", "stamp.initials")
    with pytest.raises(ChefError) as exc:
        ensure_op_order(steps)
    assert exc.value.kind == ErrorKind.BLOCKED_BY_SIGNATURE
    detail = exc.value.detail
    assert detail["index"] == 1
    assert detail["opId"] == "stamp.initials"
    assert detail["afterIndex"] == 0
    assert detail["afterOpId"] == "sign.pades"
    assert "Bước 2" in detail["message"]


def test_empty_pipeline_is_valid() -> None:
    assert check_op_order([]) is None
