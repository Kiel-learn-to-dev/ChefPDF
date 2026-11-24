//! Hình học khung cắt (TASKS_RUST R8.17, R8.18, FEATURES L15–L19): port `quadModel.ts`. Tọa độ chuẩn
//! hóa 0..1 theo ảnh. Kiểm tứ giác hợp lệ, hít vào viền đã dò, đổi cỡ khung chữ nhật (tám nắm), giữ
//! tỉ lệ. Logic thuần.
#![allow(dead_code)]

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ViewRect {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

/// Điểm chuột (px màn hình) thành tọa độ chuẩn hóa trong `rect`, kẹp vào 0..1.
pub fn point_at(x: f64, y: f64, rect: ViewRect) -> Point {
    Point {
        x: ((x - rect.left) / rect.width).clamp(0.0, 1.0),
        y: ((y - rect.top) / rect.height).clamp(0.0, 1.0),
    }
}

/// Tứ giác lồi, diện tích ≥ 1% ảnh, bốn đỉnh trong 0..1 và cùng chiều quay.
pub fn valid_quad(p: &[Point]) -> bool {
    if p.len() != 4
        || p.iter().any(|q| {
            !q.x.is_finite()
                || !q.y.is_finite()
                || !(0.0..=1.0).contains(&q.x)
                || !(0.0..=1.0).contains(&q.y)
        })
    {
        return false;
    }
    let cross: Vec<f64> = (0..4)
        .map(|i| {
            let (q, a, b) = (p[i], p[(i + 1) % 4], p[(i + 2) % 4]);
            (a.x - q.x) * (b.y - a.y) - (a.y - q.y) * (b.x - a.x)
        })
        .collect();
    let area = (0..4)
        .map(|i| {
            let (q, n) = (p[i], p[(i + 1) % 4]);
            q.x * n.y - n.x * q.y
        })
        .sum::<f64>()
        .abs()
        / 2.0;
    area >= 0.01 && (cross.iter().all(|v| *v > 0.0001) || cross.iter().all(|v| *v < -0.0001))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handle {
    TopLeft,
    Top,
    TopRight,
    Right,
    BottomRight,
    Bottom,
    BottomLeft,
    Left,
}

impl Handle {
    fn moves_left(self) -> bool {
        matches!(self, Handle::Left | Handle::TopLeft | Handle::BottomLeft)
    }
    fn moves_right(self) -> bool {
        matches!(self, Handle::Right | Handle::TopRight | Handle::BottomRight)
    }
    fn moves_top(self) -> bool {
        matches!(self, Handle::Top | Handle::TopLeft | Handle::TopRight)
    }
    fn moves_bottom(self) -> bool {
        matches!(
            self,
            Handle::Bottom | Handle::BottomLeft | Handle::BottomRight
        )
    }
}

/// Hít nam châm vào hộp bao của trang đã dò khi cách cạnh trong dung sai (đơn vị chuẩn hóa).
pub fn snap_rectangle_target(
    handle: Handle,
    target: Point,
    detected: &[Point],
    tolerance_x: f64,
    tolerance_y: f64,
) -> Point {
    if detected.len() != 4 || !valid_quad(detected) {
        return target;
    }
    let fold = |f: fn(f64, f64) -> f64, g: fn(&Point) -> f64, init: f64| {
        detected.iter().map(g).fold(init, f)
    };
    let left = fold(f64::min, |p| p.x, f64::INFINITY);
    let right = fold(f64::max, |p| p.x, f64::NEG_INFINITY);
    let top = fold(f64::min, |p| p.y, f64::INFINITY);
    let bottom = fold(f64::max, |p| p.y, f64::NEG_INFINITY);
    let edge_x = if handle.moves_left() {
        Some(left)
    } else if handle.moves_right() {
        Some(right)
    } else {
        None
    };
    let edge_y = if handle.moves_top() {
        Some(top)
    } else if handle.moves_bottom() {
        Some(bottom)
    } else {
        None
    };
    Point {
        x: match edge_x {
            Some(e) if (target.x - e).abs() <= tolerance_x => e,
            _ => target.x,
        },
        y: match edge_y {
            Some(e) if (target.y - e).abs() <= tolerance_y => e,
            _ => target.y,
        },
    }
}

/// Đổi cỡ khung chữ nhật (4 đỉnh: trái-trên, phải-trên, phải-dưới, trái-dưới). `ratio` = rộng/cao
/// theo tọa độ chuẩn hóa; Some thì giữ tỉ lệ. Kết quả không hợp lệ thì giữ nguyên khung cũ.
pub fn resize_rectangle(
    points: &[Point],
    handle: Handle,
    target: Point,
    ratio: Option<f64>,
) -> Vec<Point> {
    if points.len() != 4 {
        return points.to_vec();
    }
    let (mut left, mut top, mut right, mut bottom) =
        (points[0].x, points[0].y, points[2].x, points[2].y);
    let (ml, mr, mt, mb) = (
        handle.moves_left(),
        handle.moves_right(),
        handle.moves_top(),
        handle.moves_bottom(),
    );
    let clamp = |n: f64, min: f64, max: f64| n.max(min).min(max);
    match ratio.filter(|r| r.is_finite() && *r > 0.0) {
        None => {
            let min_w = (0.0101 / (bottom - top)).min(1.0);
            let min_h = (0.0101 / (right - left)).min(1.0);
            if ml {
                left = clamp(target.x, 0.0, (right - min_w).max(0.0));
            }
            if mr {
                right = clamp(target.x, (left + min_w).min(1.0), 1.0);
            }
            if mt {
                top = clamp(target.y, 0.0, (bottom - min_h).max(0.0));
            }
            if mb {
                bottom = clamp(target.y, (top + min_h).min(1.0), 1.0);
            }
        }
        Some(r) => {
            let min_width = (0.011 * r).sqrt();
            if (ml || mr) && (mt || mb) {
                let ax = if ml { right } else { left };
                let ay = if mt { bottom } else { top };
                let max_w =
                    (if ml { ax } else { 1.0 - ax }).min((if mt { ay } else { 1.0 - ay }) * r);
                let want = (if ml { ax - target.x } else { target.x - ax })
                    .max((if mt { ay - target.y } else { target.y - ay }) * r);
                let width = clamp(want, min_width.min(max_w), max_w);
                if ml {
                    left = ax - width;
                } else {
                    right = ax + width;
                }
                if mt {
                    top = ay - width / r;
                } else {
                    bottom = ay + width / r;
                }
            } else if ml || mr {
                let ax = if ml { right } else { left };
                let cy = (top + bottom) / 2.0;
                let max_w = (if ml { ax } else { 1.0 - ax }).min(2.0 * cy.min(1.0 - cy) * r);
                let width = clamp(
                    if ml { ax - target.x } else { target.x - ax },
                    min_width.min(max_w),
                    max_w,
                );
                if ml {
                    left = ax - width;
                } else {
                    right = ax + width;
                }
                top = cy - width / r / 2.0;
                bottom = cy + width / r / 2.0;
            } else {
                let ay = if mt { bottom } else { top };
                let cx = (left + right) / 2.0;
                let max_w = ((if mt { ay } else { 1.0 - ay }) * r).min(2.0 * cx.min(1.0 - cx));
                let width = clamp(
                    (if mt { ay - target.y } else { target.y - ay }) * r,
                    min_width.min(max_w),
                    max_w,
                );
                if mt {
                    top = ay - width / r;
                } else {
                    bottom = ay + width / r;
                }
                left = cx - width / 2.0;
                right = cx + width / 2.0;
            }
        }
    }
    let resized = vec![
        Point { x: left, y: top },
        Point { x: right, y: top },
        Point {
            x: right,
            y: bottom,
        },
        Point { x: left, y: bottom },
    ];
    if valid_quad(&resized) {
        resized
    } else {
        points.to_vec()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(x: f64, y: f64) -> Point {
        Point { x, y }
    }
    fn rect(l: f64, t: f64, r: f64, b: f64) -> Vec<Point> {
        vec![p(l, t), p(r, t), p(r, b), p(l, b)]
    }
    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn point_is_clamped_to_unit_square() {
        let r = ViewRect {
            left: 10.0,
            top: 20.0,
            width: 100.0,
            height: 200.0,
        };
        assert_eq!(point_at(60.0, 120.0, r), p(0.5, 0.5));
        assert_eq!(point_at(0.0, 999.0, r), p(0.0, 1.0));
    }

    #[test]
    fn quad_validity() {
        assert!(valid_quad(&rect(0.1, 0.1, 0.9, 0.9)));
        assert!(!valid_quad(&rect(0.1, 0.1, 0.15, 0.15)), "quá nhỏ");
        assert!(
            !valid_quad(&[p(0.0, 0.0), p(1.0, 1.0), p(1.0, 0.0), p(0.0, 1.0)]),
            "tứ giác tự cắt"
        );
        assert!(
            !valid_quad(&[p(0.0, 0.0), p(1.0, 0.0), p(1.2, 1.0), p(0.0, 1.0)]),
            "ngoài ảnh"
        );
        assert!(!valid_quad(&rect(0.1, 0.1, 0.9, 0.9)[..3]));
        // cùng chiều ngược cũng hợp lệ
        let mut rev = rect(0.1, 0.1, 0.9, 0.9);
        rev.reverse();
        assert!(valid_quad(&rev));
    }

    #[test]
    fn snap_pulls_edges_within_tolerance_only() {
        let page = rect(0.1, 0.1, 0.9, 0.9);
        let s = snap_rectangle_target(Handle::TopLeft, p(0.105, 0.2), &page, 0.01, 0.01);
        assert_eq!(s, p(0.1, 0.2));
        let s = snap_rectangle_target(Handle::Right, p(0.8, 0.5), &page, 0.01, 0.01);
        assert_eq!(s, p(0.8, 0.5));
        let s = snap_rectangle_target(Handle::Bottom, p(0.3, 0.895), &page, 0.01, 0.01);
        assert_eq!(s, p(0.3, 0.9));
        assert_eq!(
            snap_rectangle_target(Handle::Left, p(0.1, 0.1), &[], 1.0, 1.0),
            p(0.1, 0.1)
        );
    }

    #[test]
    fn free_resize_moves_only_the_dragged_edges() {
        let r = rect(0.2, 0.2, 0.8, 0.8);
        let out = resize_rectangle(&r, Handle::Right, p(0.95, 0.0), None);
        assert!(close(out[1].x, 0.95) && close(out[0].x, 0.2) && close(out[2].y, 0.8));
        let out = resize_rectangle(&r, Handle::TopLeft, p(0.1, 0.05), None);
        assert!(close(out[0].x, 0.1) && close(out[0].y, 0.05) && close(out[2].x, 0.8));
        // kéo quá cạnh đối diện: không đảo, dừng ở cỡ tối thiểu
        let out = resize_rectangle(&r, Handle::Left, p(0.99, 0.5), None);
        assert!(out[0].x < out[1].x && valid_quad(&out));
        // kéo ra ngoài ảnh bị kẹp
        let out = resize_rectangle(&r, Handle::Right, p(2.0, 0.5), None);
        assert!(close(out[1].x, 1.0));
    }

    #[test]
    fn locked_ratio_is_kept() {
        let r = rect(0.2, 0.2, 0.6, 0.6); // 0,4 × 0,4
        let ratio = 0.7;
        for (h, t) in [
            (Handle::BottomRight, p(0.9, 0.7)),
            (Handle::TopLeft, p(0.1, 0.1)),
            (Handle::Right, p(0.7, 0.4)),
            (Handle::Bottom, p(0.4, 0.8)),
            (Handle::Left, p(0.05, 0.4)),
            (Handle::Top, p(0.4, 0.05)),
        ] {
            let out = resize_rectangle(&r, h, t, Some(ratio));
            let (w, hh) = (out[1].x - out[0].x, out[2].y - out[1].y);
            assert!(close(w / hh, ratio), "{h:?}: {} vs {ratio}", w / hh);
            assert!(
                out.iter()
                    .all(|q| (0.0..=1.0).contains(&q.x) && (0.0..=1.0).contains(&q.y)),
                "{h:?}"
            );
        }
    }

    #[test]
    fn invalid_input_returns_original() {
        let r = rect(0.2, 0.2, 0.8, 0.8);
        assert_eq!(
            resize_rectangle(&r[..3], Handle::Left, p(0.0, 0.0), None).len(),
            3
        );
        let out = resize_rectangle(&r, Handle::Right, p(0.5, 0.5), Some(f64::NAN));
        assert!(
            out[1].x <= 0.5 + 1e-9 || out == r,
            "NaN ratio coi như không khóa"
        );
    }
}
