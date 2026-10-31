"""Affine maths for placing overlays on a displayed page (T4.01).

An affine map is a tuple ``(a, b, c, d, e, f)`` in the PDF matrix convention:
``x' = a*x + c*y + e`` and ``y' = b*x + d*y + f``.

Coordinates used by callers: "displayed" means the page as a reader shows it, after /Rotate
and CropBox. The origin is the top-left corner, x grows to the right and y grows downwards, in
points. Rotations are counter-clockwise on screen, in degrees, about the anchor point.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from typing import Literal

from chef_core.signing.anchors import PageFrame

Affine = tuple[float, float, float, float, float, float]
Anchor = Literal[
    "top-left",
    "top-center",
    "top-right",
    "center-left",
    "center",
    "center-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
]

# Anchor position inside a box as (x fraction from left, y fraction from top).
ANCHOR_FRACTIONS: dict[str, tuple[float, float]] = {
    "top-left": (0.0, 0.0),
    "top-center": (0.5, 0.0),
    "top-right": (1.0, 0.0),
    "center-left": (0.0, 0.5),
    "center": (0.5, 0.5),
    "center-right": (1.0, 0.5),
    "bottom-left": (0.0, 1.0),
    "bottom-center": (0.5, 1.0),
    "bottom-right": (1.0, 1.0),
}

IDENTITY: Affine = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def mul(first: Affine, then: Affine) -> Affine:
    """The map that applies ``first`` and then ``then`` (the order of PDF ``cm`` operands)."""
    a1, b1, c1, d1, e1, f1 = first
    a2, b2, c2, d2, e2, f2 = then
    return (
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    )


def translate(tx: float, ty: float) -> Affine:
    return (1.0, 0.0, 0.0, 1.0, tx, ty)


def rotate(degrees: float) -> Affine:
    """Counter-clockwise rotation in a y-up space (the displayed frame after conversion)."""
    rad = math.radians(degrees)
    cos, sin = math.cos(rad), math.sin(rad)
    return (cos, sin, -sin, cos, 0.0, 0.0)


def scale(sx: float, sy: float) -> Affine:
    return (sx, 0.0, 0.0, sy, 0.0, 0.0)


Point = Callable[[float, float], tuple[float, float]]


def _affine_from_points(f: Point) -> Affine:
    """Build an affine map from a point function by sampling it at three points."""
    origin = f(0.0, 0.0)
    ex = f(1.0, 0.0)
    ey = f(0.0, 1.0)
    return (
        ex[0] - origin[0],
        ex[1] - origin[1],
        ey[0] - origin[0],
        ey[1] - origin[1],
        origin[0],
        origin[1],
    )


def display_to_user(frame: PageFrame) -> Affine:
    """Map from the displayed frame (origin bottom-left, y up) to user space of the page."""

    def point(x: float, y: float) -> tuple[float, float]:
        u, v = frame.rect_from_display((x, y, x, y))[:2]
        return u, v

    return _affine_from_points(point)


def user_to_display(frame: PageFrame) -> Affine:
    """Map from user space of the page to the displayed frame (origin bottom-left, y up)."""

    def point(x: float, y: float) -> tuple[float, float]:
        u, v = frame.rect_to_display((x, y, x, y))[:2]
        return u, v

    return _affine_from_points(point)


def placed_box_matrix(
    frame: PageFrame,
    *,
    x: float,
    y: float,
    anchor: str,
    width: float,
    height: float,
    rotation: float,
) -> Affine:
    """Matrix from a box's own coordinates (origin bottom-left, size width x height) to user space.

    ``x`` and ``y`` are the anchor point measured from the top-left of the displayed page. The
    box is rotated counter-clockwise about that anchor point.
    """
    _, display_height = frame.display_size
    fx, fy_top = ANCHOR_FRACTIONS[anchor]
    anchor_local = (fx * width, (1.0 - fy_top) * height)
    to_anchor = translate(-anchor_local[0], -anchor_local[1])
    anchor_in_display = translate(x, display_height - y)
    display = mul(mul(to_anchor, rotate(rotation)), anchor_in_display)
    return mul(display, display_to_user(frame))


def number(value: float) -> str:
    """A number as PDF content syntax: at most five decimals, no trailing zeros, no ``-0``."""
    text = f"{value:.5f}".rstrip("0").rstrip(".")
    return "0" if text in ("-0", "") else text


def fmt(m: Affine) -> str:
    """Affine map as the six operands of ``cm``."""
    return " ".join(number(v) for v in m)
