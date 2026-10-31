"""Order safety for a list of operations (BLUEPRINT section 3, O5 / D10).

A destructive operation rewrites page content, which would invalidate a signature that is already
in the document. So a destructive step must never come after a finalizing (signing) step. The
same rule is applied to every multi-step pipeline: ``sign.stampAndSign`` now, the workflow engine
(T9.02) later.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

from chef_core.errors import ChefError, ErrorKind
from chef_core.ops.base import OpSpec


@dataclass(frozen=True)
class OrderViolation:
    index: int  # 0-based position of the offending step
    op_id: str
    after_index: int  # 0-based position of the finalizing step it follows
    after_op_id: str
    message: str  # Vietnamese, for the user


def check_op_order(steps: Sequence[OpSpec]) -> OrderViolation | None:
    """The first destructive step that follows a finalizing step, or None when the order is safe."""
    first_final: int | None = None
    for index, spec in enumerate(steps):
        if spec.destructive and first_final is not None:
            after = steps[first_final]
            message = (
                f"Bước {index + 1} ({spec.id}) làm thay đổi tài liệu nhưng đứng sau bước "
                f"{first_final + 1} ({after.id}) đã ký số. Hãy đặt các bước thay đổi trước "
                "bước ký."
            )
            return OrderViolation(
                index=index,
                op_id=spec.id,
                after_index=first_final,
                after_op_id=after.id,
                message=message,
            )
        if spec.finalizing and first_final is None:
            first_final = index
    return None


def ensure_op_order(steps: Sequence[OpSpec]) -> None:
    """Raise ``BLOCKED_BY_SIGNATURE`` with the structured violation when the order is unsafe."""
    violation = check_op_order(steps)
    if violation is None:
        return
    raise ChefError(
        ErrorKind.BLOCKED_BY_SIGNATURE,
        "A destructive step follows a signing step",
        {
            "index": violation.index,
            "opId": violation.op_id,
            "afterIndex": violation.after_index,
            "afterOpId": violation.after_op_id,
            "message": violation.message,
        },
    )
