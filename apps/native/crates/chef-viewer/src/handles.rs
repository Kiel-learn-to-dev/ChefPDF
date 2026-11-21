//! R4.12 object selection handles: hit-testing, Shift aspect resize, rotation and PDF transforms.

use std::f64::consts::PI;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Handle {
    NW,
    N,
    NE,
    E,
    SE,
    S,
    SW,
    W,
    Rotate,
    Body,
}

pub const RESIZE_HANDLES: [Handle; 8] = [
    Handle::NW,
    Handle::N,
    Handle::NE,
    Handle::E,
    Handle::SE,
    Handle::S,
    Handle::SW,
    Handle::W,
];

pub const MIN_SIZE_PT: f32 = 4.0;
pub const ROTATE_STEM_PX: f32 = 24.0;
pub const HANDLE_HIT_RADIUS_PX: f32 = 7.0;

pub fn handle_pos(bbox: [f32; 4], handle: Handle, zoom: f32) -> [f32; 2] {
    let [x0, y0, x1, y1] = bbox;
    let cx = (x0 + x1) * 0.5;
    let cy = (y0 + y1) * 0.5;
    let stem = ROTATE_STEM_PX / zoom.max(0.1);
    match handle {
        Handle::NW => [x0, y0],
        Handle::N => [cx, y0],
        Handle::NE => [x1, y0],
        Handle::E => [x1, cy],
        Handle::SE => [x1, y1],
        Handle::S => [cx, y1],
        Handle::SW => [x0, y1],
        Handle::W => [x0, cy],
        Handle::Rotate => [cx, y0 - stem],
        Handle::Body => [cx, cy],
    }
}

pub fn hit_test_handle(bbox: [f32; 4], point: [f32; 2], zoom: f32) -> Option<Handle> {
    let r = HANDLE_HIT_RADIUS_PX / zoom.max(0.1);
    let r2 = r * r;
    let dist2 = |a: [f32; 2], b: [f32; 2]| {
        let dx = a[0] - b[0];
        let dy = a[1] - b[1];
        dx * dx + dy * dy
    };
    if dist2(point, handle_pos(bbox, Handle::Rotate, zoom)) <= r2 {
        return Some(Handle::Rotate);
    }
    for handle in RESIZE_HANDLES {
        if dist2(point, handle_pos(bbox, handle, zoom)) <= r2 {
            return Some(handle);
        }
    }
    if point[0] >= bbox[0] && point[0] <= bbox[2] && point[1] >= bbox[1] && point[1] <= bbox[3] {
        Some(Handle::Body)
    } else {
        None
    }
}

pub fn resized_bbox(
    orig: [f32; 4],
    handle: Handle,
    point: [f32; 2],
    keep_aspect: bool,
) -> [f32; 4] {
    let [x0, y0, x1, y1] = orig;
    let w = (x1 - x0).max(0.001);
    let h = (y1 - y0).max(0.001);

    if keep_aspect {
        let min_s = (MIN_SIZE_PT / w).max(MIN_SIZE_PT / h);
        return match handle {
            Handle::NW | Handle::NE | Handle::SW | Handle::SE => {
                let (ax, ay, sx_dir, sy_dir) = match handle {
                    Handle::NW => (x1, y1, -1.0_f32, -1.0_f32),
                    Handle::NE => (x0, y1, 1.0, -1.0),
                    Handle::SW => (x1, y0, -1.0, 1.0),
                    Handle::SE => (x0, y0, 1.0, 1.0),
                    _ => unreachable!(),
                };
                let rx = ((point[0] - ax) * sx_dir) / w;
                let ry = ((point[1] - ay) * sy_dir) / h;
                let s = if (rx - 1.0).abs() >= (ry - 1.0).abs() {
                    rx
                } else {
                    ry
                }
                .max(min_s);
                let px = ax + sx_dir * w * s;
                let py = ay + sy_dir * h * s;
                [ax.min(px), ay.min(py), ax.max(px), ay.max(py)]
            }
            Handle::E | Handle::W => {
                let (ax, dir) = if handle == Handle::E {
                    (x0, 1.0_f32)
                } else {
                    (x1, -1.0_f32)
                };
                let s = (((point[0] - ax) * dir) / w).max(min_s);
                let px = ax + dir * w * s;
                let cy = (y0 + y1) * 0.5;
                let hh = h * s * 0.5;
                [ax.min(px), cy - hh, ax.max(px), cy + hh]
            }
            Handle::N | Handle::S => {
                let (ay, dir) = if handle == Handle::S {
                    (y0, 1.0_f32)
                } else {
                    (y1, -1.0_f32)
                };
                let s = (((point[1] - ay) * dir) / h).max(min_s);
                let py = ay + dir * h * s;
                let cx = (x0 + x1) * 0.5;
                let hw = w * s * 0.5;
                [cx - hw, ay.min(py), cx + hw, ay.max(py)]
            }
            Handle::Rotate | Handle::Body => orig,
        };
    }

    match handle {
        Handle::NW => [
            point[0].min(x1 - MIN_SIZE_PT),
            point[1].min(y1 - MIN_SIZE_PT),
            x1,
            y1,
        ],
        Handle::N => [x0, point[1].min(y1 - MIN_SIZE_PT), x1, y1],
        Handle::NE => [
            x0,
            point[1].min(y1 - MIN_SIZE_PT),
            point[0].max(x0 + MIN_SIZE_PT),
            y1,
        ],
        Handle::E => [x0, y0, point[0].max(x0 + MIN_SIZE_PT), y1],
        Handle::SE => [
            x0,
            y0,
            point[0].max(x0 + MIN_SIZE_PT),
            point[1].max(y0 + MIN_SIZE_PT),
        ],
        Handle::S => [x0, y0, x1, point[1].max(y0 + MIN_SIZE_PT)],
        Handle::SW => [
            point[0].min(x1 - MIN_SIZE_PT),
            y0,
            x1,
            point[1].max(y0 + MIN_SIZE_PT),
        ],
        Handle::W => [point[0].min(x1 - MIN_SIZE_PT), y0, x1, y1],
        Handle::Rotate | Handle::Body => orig,
    }
}

/// Clockwise rotation angle in radians in the y-down displayed frame.
pub fn rotation_angle(orig: [f32; 4], start: [f32; 2], cur: [f32; 2], snap_15deg: bool) -> f64 {
    let cx = f64::from(orig[0] + orig[2]) * 0.5;
    let cy = f64::from(orig[1] + orig[3]) * 0.5;
    let a0 = (f64::from(start[1]) - cy).atan2(f64::from(start[0]) - cx);
    let a1 = (f64::from(cur[1]) - cy).atan2(f64::from(cur[0]) - cx);
    let mut delta = a1 - a0;
    while delta > PI {
        delta -= 2.0 * PI;
    }
    while delta < -PI {
        delta += 2.0 * PI;
    }
    if snap_15deg {
        let step = PI / 12.0;
        delta = (delta / step).round() * step;
    }
    delta
}

/// Matrix product in PDF's row-vector convention: apply `m1`, then `m2`.
pub fn mul(m1: [f64; 6], m2: [f64; 6]) -> [f64; 6] {
    let [a1, b1, c1, d1, e1, f1] = m1;
    let [a2, b2, c2, d2, e2, f2] = m2;
    [
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    ]
}

pub fn apply(m: [f64; 6], x: f64, y: f64) -> (f64, f64) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

fn translate(tx: f64, ty: f64) -> [f64; 6] {
    [1.0, 0.0, 0.0, 1.0, tx, ty]
}

fn disp_linear(page_rotation: u16) -> [f64; 6] {
    match page_rotation % 360 {
        90 => [0.0, 1.0, 1.0, 0.0, 0.0, 0.0],
        180 => [-1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        270 => [0.0, -1.0, -1.0, 0.0, 0.0, 0.0],
        _ => [1.0, 0.0, 0.0, -1.0, 0.0, 0.0],
    }
}

fn frame_maps(
    orig_disp: [f32; 4],
    orig_user: [f32; 4],
    page_rotation: u16,
) -> ([f64; 6], [f64; 6]) {
    let dcx = f64::from(orig_disp[0] + orig_disp[2]) * 0.5;
    let dcy = f64::from(orig_disp[1] + orig_disp[3]) * 0.5;
    let ucx = f64::from(orig_user[0] + orig_user[2]) * 0.5;
    let ucy = f64::from(orig_user[1] + orig_user[3]) * 0.5;
    let l = disp_linear(page_rotation);
    let u_to_d = mul(mul(translate(-ucx, -ucy), l), translate(dcx, dcy));
    let d_to_u = mul(mul(translate(-dcx, -dcy), l), translate(ucx, ucy));
    (u_to_d, d_to_u)
}

pub fn resize_matrix(
    orig_disp: [f32; 4],
    orig_user: [f32; 4],
    new_disp: [f32; 4],
    page_rotation: u16,
) -> [f64; 6] {
    let (u_to_d, d_to_u) = frame_maps(orig_disp, orig_user, page_rotation);
    let ow = f64::from(orig_disp[2] - orig_disp[0]).max(0.001);
    let oh = f64::from(orig_disp[3] - orig_disp[1]).max(0.001);
    let nw = f64::from(new_disp[2] - new_disp[0]).max(0.001);
    let nh = f64::from(new_disp[3] - new_disp[1]).max(0.001);
    let sx = nw / ow;
    let sy = nh / oh;
    let tx = f64::from(new_disp[0]) - f64::from(orig_disp[0]) * sx;
    let ty = f64::from(new_disp[1]) - f64::from(orig_disp[1]) * sy;
    let t_disp = [sx, 0.0, 0.0, sy, tx, ty];
    mul(mul(u_to_d, t_disp), d_to_u)
}

pub fn rotate_matrix(
    orig_disp: [f32; 4],
    orig_user: [f32; 4],
    angle_rad_cw: f64,
    page_rotation: u16,
) -> [f64; 6] {
    let (u_to_d, d_to_u) = frame_maps(orig_disp, orig_user, page_rotation);
    let dcx = f64::from(orig_disp[0] + orig_disp[2]) * 0.5;
    let dcy = f64::from(orig_disp[1] + orig_disp[3]) * 0.5;
    let (s, c) = angle_rad_cw.sin_cos();
    let rot = [c, s, -s, c, 0.0, 0.0];
    let t_disp = mul(mul(translate(-dcx, -dcy), rot), translate(dcx, dcy));
    mul(mul(u_to_d, t_disp), d_to_u)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn to_disp(ux: f64, uy: f64, crop: [f64; 4], rotation: u16) -> (f64, f64) {
        let [x0, y0, x1, y1] = crop;
        let w = x1 - x0;
        let h = y1 - y0;
        let u = ux - x0;
        let v = uy - y0;
        match rotation % 360 {
            90 => (v, u),
            180 => (w - u, v),
            270 => (h - v, w - u),
            _ => (u, h - v),
        }
    }

    fn user_bbox_to_disp(user: [f32; 4], crop: [f64; 4], rotation: u16) -> [f32; 4] {
        let (dx0, dy0) = to_disp(f64::from(user[0]), f64::from(user[1]), crop, rotation);
        let (dx1, dy1) = to_disp(f64::from(user[2]), f64::from(user[3]), crop, rotation);
        [
            dx0.min(dx1) as f32,
            dy0.min(dy1) as f32,
            dx0.max(dx1) as f32,
            dy0.max(dy1) as f32,
        ]
    }

    #[test]
    fn hit_test_prioritizes_rotate_then_handles_then_body() {
        let bbox = [100.0, 100.0, 300.0, 200.0];
        let rot = handle_pos(bbox, Handle::Rotate, 1.0);
        assert_eq!(hit_test_handle(bbox, rot, 1.0), Some(Handle::Rotate));
        for handle in RESIZE_HANDLES {
            let p = handle_pos(bbox, handle, 1.0);
            assert_eq!(hit_test_handle(bbox, p, 1.0), Some(handle));
        }
        assert_eq!(
            hit_test_handle(bbox, [200.0, 150.0], 1.0),
            Some(Handle::Body)
        );
        assert_eq!(hit_test_handle(bbox, [10.0, 10.0], 1.0), None);
    }

    #[test]
    fn shift_resize_keeps_aspect_and_opposite_anchor() {
        let orig = [100.0, 100.0, 300.0, 200.0]; // 2:1 aspect ratio
        for handle in [Handle::NW, Handle::NE, Handle::SW, Handle::SE] {
            let next = resized_bbox(orig, handle, [420.0, 210.0], true);
            let w = next[2] - next[0];
            let h = next[3] - next[1];
            assert!(
                (w / h - 2.0).abs() < 1e-4,
                "aspect mismatch for {handle:?}: {w}/{h}"
            );
        }
        let se = resized_bbox(orig, Handle::SE, [500.0, 220.0], true);
        assert_eq!((se[0], se[1]), (orig[0], orig[1]));
        assert!((se[2] - 500.0).abs() < 1e-4);
        assert!((se[3] - 300.0).abs() < 1e-4);

        let e_free = resized_bbox(orig, Handle::E, [500.0, 150.0], false);
        assert_eq!(e_free, [100.0, 100.0, 500.0, 200.0]);
    }

    #[test]
    fn resize_and_rotate_matrices_hold_for_every_pdf_rotation_and_crop_offset() {
        let crop = [20.0, 40.0, 620.0, 840.0];
        let orig_user = [150.0_f32, 350.0, 350.0, 450.0];
        for rot in [0_u16, 90, 180, 270] {
            let orig_disp = user_bbox_to_disp(orig_user, crop, rot);
            let new_disp = [
                orig_disp[0],
                orig_disp[1],
                orig_disp[2] + (orig_disp[2] - orig_disp[0]) * 0.5,
                orig_disp[3] + (orig_disp[3] - orig_disp[1]) * 0.5,
            ];
            let m_resize = resize_matrix(orig_disp, orig_user, new_disp, rot);
            let (ux0, uy0) = apply(m_resize, f64::from(orig_user[0]), f64::from(orig_user[1]));
            let (ux1, uy1) = apply(m_resize, f64::from(orig_user[2]), f64::from(orig_user[3]));
            let got_disp =
                user_bbox_to_disp([ux0 as f32, uy0 as f32, ux1 as f32, uy1 as f32], crop, rot);
            for i in 0..4 {
                assert!(
                    (got_disp[i] - new_disp[i]).abs() < 1e-3,
                    "rot={rot} idx={i}: got={got_disp:?} expected={new_disp:?}"
                );
            }

            let m_rot = rotate_matrix(orig_disp, orig_user, PI / 2.0, rot);
            let (rx0, ry0) = apply(m_rot, f64::from(orig_user[0]), f64::from(orig_user[1]));
            let (rx1, ry1) = apply(m_rot, f64::from(orig_user[2]), f64::from(orig_user[3]));
            let r_disp =
                user_bbox_to_disp([rx0 as f32, ry0 as f32, rx1 as f32, ry1 as f32], crop, rot);
            let rw = r_disp[2] - r_disp[0];
            let rh = r_disp[3] - r_disp[1];
            let ow = orig_disp[2] - orig_disp[0];
            let oh = orig_disp[3] - orig_disp[1];
            assert!(
                (rw - oh).abs() < 1e-3 && (rh - ow).abs() < 1e-3,
                "rot={rot}: {rw}x{rh} vs {oh}x{ow}"
            );
        }
    }
}
