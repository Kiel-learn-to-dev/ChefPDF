//! Hộp chữ ký trên trang (TASKS_RUST R6.17, FEATURES I27): port `placementGeometry.ts` và
//! `placementDrag.ts`. Ba hệ tọa độ: không gian người dùng (điểm PDF, gốc dưới trái, trang CHƯA xoay),
//! khung hiển thị (sau /Rotate, y hướng lên) và màn hình (px, gốc trên trái). Logic thuần.
#![allow(dead_code)]

pub const MM_TO_PT: f64 = 72.0 / 25.4;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pt {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect4 {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenBox {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rotation {
    R0,
    R90,
    R180,
    R270,
}

/// Góc xoay về bội của 90 trong [0, 360).
pub fn normalize_rotation(value: f64) -> Rotation {
    let steps = (value / 90.0).round() as i64;
    match steps.rem_euclid(4) {
        1 => Rotation::R90,
        2 => Rotation::R180,
        3 => Rotation::R270,
        _ => Rotation::R0,
    }
}

/// Hình học trang ở hai khung. `user_*` là cỡ chưa xoay.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageGeom {
    pub disp_w: f64,
    pub disp_h: f64,
    pub user_w: f64,
    pub user_h: f64,
    pub rotation: Rotation,
}

/// Trang như `DocumentInfo.pages` báo: cỡ sau xoay và /Rotate.
pub fn page_geom(width: f64, height: f64, rotation: f64) -> PageGeom {
    let rotation = normalize_rotation(rotation);
    let swapped = matches!(rotation, Rotation::R90 | Rotation::R270);
    PageGeom {
        disp_w: width,
        disp_h: height,
        user_w: if swapped { height } else { width },
        user_h: if swapped { width } else { height },
        rotation,
    }
}

/// Điểm không gian người dùng -> khung hiển thị.
pub fn user_to_display(p: Pt, g: &PageGeom) -> Pt {
    let (u, v) = (p.x, p.y);
    match g.rotation {
        Rotation::R90 => Pt {
            x: v,
            y: g.user_w - u,
        },
        Rotation::R180 => Pt {
            x: g.user_w - u,
            y: g.user_h - v,
        },
        Rotation::R270 => Pt {
            x: g.user_h - v,
            y: u,
        },
        Rotation::R0 => Pt { x: u, y: v },
    }
}

/// Khung hiển thị -> không gian người dùng (nghịch đảo của `user_to_display`).
pub fn display_to_user(p: Pt, g: &PageGeom) -> Pt {
    let (dx, dy) = (p.x, p.y);
    match g.rotation {
        Rotation::R90 => Pt {
            x: g.user_w - dy,
            y: dx,
        },
        Rotation::R180 => Pt {
            x: g.user_w - dx,
            y: g.user_h - dy,
        },
        Rotation::R270 => Pt {
            x: dy,
            y: g.user_h - dx,
        },
        Rotation::R0 => Pt { x: dx, y: dy },
    }
}

fn norm_rect(a: Pt, b: Pt) -> Rect4 {
    Rect4 {
        x1: a.x.min(b.x),
        y1: a.y.min(b.y),
        x2: a.x.max(b.x),
        y2: a.y.max(b.y),
    }
}

/// Hình chữ nhật không gian người dùng [x1,y1,x2,y2] -> khung hiển thị (chuẩn hóa).
pub fn rect_user_to_display(r: [f64; 4], g: &PageGeom) -> Rect4 {
    norm_rect(
        user_to_display(Pt { x: r[0], y: r[1] }, g),
        user_to_display(Pt { x: r[2], y: r[3] }, g),
    )
}

/// Làm tròn 3 chữ số thập phân (như `roundPt`).
pub fn round_pt(n: f64) -> f64 {
    round_digits(n, 3)
}

fn round_digits(n: f64, digits: i32) -> f64 {
    let f = 10f64.powi(digits);
    (n * f).round() / f
}

/// Khung hiển thị -> [x1,y1,x2,y2] không gian người dùng (chuẩn hóa), lõi dùng dạng này.
pub fn rect_display_to_user(r: Rect4, g: &PageGeom) -> [f64; 4] {
    let a = display_to_user(Pt { x: r.x1, y: r.y1 }, g);
    let b = display_to_user(Pt { x: r.x2, y: r.y2 }, g);
    let n = norm_rect(a, b);
    [
        round_pt(n.x1),
        round_pt(n.y1),
        round_pt(n.x2),
        round_pt(n.y2),
    ]
}

/// Điểm khung hiển thị (y lên, điểm) -> màn hình (y xuống), `scale` px mỗi điểm.
pub fn display_to_screen(p: Pt, g: &PageGeom, scale: f64) -> Pt {
    Pt {
        x: p.x * scale,
        y: (g.disp_h - p.y) * scale,
    }
}

pub fn screen_to_display(p: Pt, g: &PageGeom, scale: f64) -> Pt {
    Pt {
        x: p.x / scale,
        y: g.disp_h - p.y / scale,
    }
}

pub fn display_rect_to_screen(r: Rect4, g: &PageGeom, scale: f64) -> ScreenBox {
    let a = display_to_screen(Pt { x: r.x1, y: r.y2 }, g, scale);
    let b = display_to_screen(Pt { x: r.x2, y: r.y1 }, g, scale);
    ScreenBox {
        left: a.x,
        top: a.y,
        width: b.x - a.x,
        height: b.y - a.y,
    }
}

pub fn screen_box_to_display_rect(b: ScreenBox, g: &PageGeom, scale: f64) -> Rect4 {
    let a = screen_to_display(
        Pt {
            x: b.left,
            y: b.top,
        },
        g,
        scale,
    );
    let c = screen_to_display(
        Pt {
            x: b.left + b.width,
            y: b.top + b.height,
        },
        g,
        scale,
    );
    norm_rect(a, c)
}

pub fn user_rect_to_screen(r: [f64; 4], g: &PageGeom, scale: f64) -> ScreenBox {
    display_rect_to_screen(rect_user_to_display(r, g), g, scale)
}

pub fn screen_box_to_user_rect(b: ScreenBox, g: &PageGeom, scale: f64) -> [f64; 4] {
    rect_display_to_user(screen_box_to_display_rect(b, g, scale), g)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

impl Corner {
    fn is_left(self) -> bool {
        matches!(self, Corner::TopLeft | Corner::BottomLeft)
    }
    fn is_top(self) -> bool {
        matches!(self, Corner::TopLeft | Corner::TopRight)
    }
}

/// Hộp cố định ở một góc của trang ĐANG HIỂN THỊ (I27), khung hiển thị; lề `margin` hai cạnh.
pub fn fixed_rect_displayed(
    corner: Corner,
    width: f64,
    height: f64,
    margin: f64,
    g: &PageGeom,
) -> Rect4 {
    let x1 = if corner.is_left() {
        margin
    } else {
        g.disp_w - margin - width
    };
    let y1 = if corner.is_top() {
        g.disp_h - margin - height
    } else {
        margin
    };
    Rect4 {
        x1,
        y1,
        x2: x1 + width,
        y2: y1 + height,
    }
}

pub fn fixed_rect_user(
    corner: Corner,
    width: f64,
    height: f64,
    margin: f64,
    g: &PageGeom,
) -> [f64; 4] {
    rect_display_to_user(fixed_rect_displayed(corner, width, height, margin, g), g)
}

/// Giữ hộp trong ảnh trang. Hộp lớn hơn trang bị cắt về cỡ trang; ưu tiên dời vị trí.
pub fn clamp_box_to_page(b: ScreenBox, page_w: f64, page_h: f64) -> ScreenBox {
    let width = b.width.min(page_w);
    let height = b.height.min(page_h);
    let left = b.left.max(0.0).min(page_w - width);
    let top = b.top.max(0.0).min(page_h - height);
    ScreenBox {
        left,
        top,
        width,
        height,
    }
}

/// Cỡ hộp (mm) từ px; `scale` là px mỗi điểm.
pub fn box_size_mm(width: f64, height: f64, scale: f64) -> (f64, f64) {
    (
        round_digits(width / scale / MM_TO_PT, 1),
        round_digits(height / scale / MM_TO_PT, 1),
    )
}

pub fn mm_to_pt(mm: f64) -> f64 {
    mm * MM_TO_PT
}

pub fn pt_to_mm(pt: f64) -> f64 {
    pt / MM_TO_PT
}

// ---------- Kéo, dời và đổi cỡ (placementDrag.ts) ----------

/// Tay nắm của hộp.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Handle {
    Nw,
    N,
    Ne,
    E,
    Se,
    S,
    Sw,
    W,
}

impl Handle {
    fn has_w(self) -> bool {
        matches!(self, Handle::Nw | Handle::Sw | Handle::W)
    }
    fn has_e(self) -> bool {
        matches!(self, Handle::Ne | Handle::Se | Handle::E)
    }
    fn has_n(self) -> bool {
        matches!(self, Handle::Nw | Handle::Ne | Handle::N)
    }
    fn has_s(self) -> bool {
        matches!(self, Handle::Sw | Handle::Se | Handle::S)
    }
    fn is_corner(self) -> bool {
        matches!(self, Handle::Nw | Handle::Ne | Handle::Se | Handle::Sw)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageSizePx {
    pub width: f64,
    pub height: f64,
}

/// Hộp nhỏ nhất người dùng vẽ được, px (khoảng 4 mm ở 100%).
pub const MIN_BOX_PX: f64 = 12.0;

fn clamp_x(x: f64, w: f64) -> f64 {
    x.max(0.0).min(w)
}

fn clamp_y(y: f64, h: f64) -> f64 {
    y.max(0.0).min(h)
}

/// Hộp từ một lần kéo: hai góc, chuẩn hóa và kẹp trong trang. `aspect` giữ tỷ lệ của lần kéo đầu.
pub fn box_from_drag(start: Pt, current: Pt, page: PageSizePx, aspect: Option<f64>) -> ScreenBox {
    let sx = clamp_x(start.x, page.width);
    let sy = clamp_y(start.y, page.height);
    let cx = clamp_x(current.x, page.width);
    let cy = clamp_y(current.y, page.height);
    let mut width = (cx - sx).abs();
    let mut height = (cy - sy).abs();
    if let Some(a) = aspect {
        if width / height.max(1e-9) > a {
            height = width / a;
        } else {
            width = height * a;
        }
    }
    let left = if cx >= sx { sx } else { sx - width };
    let top = if cy >= sy { sy } else { sy - height };
    clamp_box_to_page(
        ScreenBox {
            left,
            top,
            width,
            height,
        },
        page.width,
        page.height,
    )
}

/// Dời hộp (dx, dy) và giữ trong trang.
pub fn move_box(b: ScreenBox, dx: f64, dy: f64, page: PageSizePx) -> ScreenBox {
    clamp_box_to_page(
        ScreenBox {
            left: b.left + dx,
            top: b.top + dy,
            ..b
        },
        page.width,
        page.height,
    )
}

/// Đổi cỡ bằng một tay nắm; cạnh đối diện đứng yên. Có `aspect` thì giữ hình dạng.
pub fn resize_box(
    b: ScreenBox,
    handle: Handle,
    dx: f64,
    dy: f64,
    page: PageSizePx,
    aspect: Option<f64>,
) -> ScreenBox {
    let mut left = b.left;
    let mut top = b.top;
    let mut right = b.left + b.width;
    let mut bottom = b.top + b.height;
    if handle.has_w() {
        left = clamp_x(left + dx, page.width);
    }
    if handle.has_e() {
        right = clamp_x(right + dx, page.width);
    }
    if handle.has_n() {
        top = clamp_y(top + dy, page.height);
    }
    if handle.has_s() {
        bottom = clamp_y(bottom + dy, page.height);
    }
    let mut width = (right - left).max(MIN_BOX_PX);
    let mut height = (bottom - top).max(MIN_BOX_PX);
    if let Some(a) = aspect {
        if handle.is_corner() {
            if width / height > a {
                height = width / a;
            } else {
                width = height * a;
            }
        } else if matches!(handle, Handle::E | Handle::W) {
            height = width / a;
        } else {
            width = height * a;
        }
    }
    let new_left = if handle.has_w() {
        b.left + b.width - width
    } else {
        b.left
    };
    let new_top = if handle.has_n() {
        b.top + b.height - height
    } else {
        b.top
    };
    clamp_box_to_page(
        ScreenBox {
            left: new_left,
            top: new_top,
            width,
            height,
        },
        page.width,
        page.height,
    )
}

/// Giữ hình dạng nhưng đưa hộp vào trang (khi cỡ trang đổi).
pub fn fit_box(b: ScreenBox, page: PageSizePx) -> ScreenBox {
    clamp_box_to_page(b, page.width, page.height)
}

/// Tám vị trí tay nắm (tâm điểm), để dò chuột và vẽ.
pub fn handle_points(b: ScreenBox) -> [(Handle, f64, f64); 8] {
    let cx = b.left + b.width / 2.0;
    let cy = b.top + b.height / 2.0;
    let r = b.left + b.width;
    let bt = b.top + b.height;
    [
        (Handle::Nw, b.left, b.top),
        (Handle::N, cx, b.top),
        (Handle::Ne, r, b.top),
        (Handle::E, r, cy),
        (Handle::Se, r, bt),
        (Handle::S, cx, bt),
        (Handle::Sw, b.left, bt),
        (Handle::W, b.left, cy),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }

    #[test]
    fn rotation_normalizes() {
        assert_eq!(normalize_rotation(0.0), Rotation::R0);
        assert_eq!(normalize_rotation(90.0), Rotation::R90);
        assert_eq!(normalize_rotation(-90.0), Rotation::R270);
        assert_eq!(normalize_rotation(450.0), Rotation::R90);
        assert_eq!(normalize_rotation(179.0), Rotation::R180);
    }

    #[test]
    fn user_and_display_round_trip_for_every_rotation() {
        for rot in [0.0, 90.0, 180.0, 270.0] {
            let g = page_geom(842.0, 595.0, rot);
            let p = Pt { x: 100.0, y: 40.0 };
            let back = display_to_user(user_to_display(p, &g), &g);
            assert!(close(back.x, p.x) && close(back.y, p.y), "rot {rot}");
        }
    }

    #[test]
    fn rotated_page_swaps_user_size() {
        let g = page_geom(842.0, 595.0, 90.0);
        assert_eq!((g.user_w, g.user_h), (595.0, 842.0));
        assert_eq!((g.disp_w, g.disp_h), (842.0, 595.0));
    }

    #[test]
    fn rect_round_trips_through_screen() {
        let g = page_geom(595.0, 842.0, 0.0);
        let r = [100.0, 200.0, 250.0, 260.0];
        let b = user_rect_to_screen(r, &g, 1.5);
        assert!(close(b.width, 225.0) && close(b.height, 90.0));
        let back = screen_box_to_user_rect(b, &g, 1.5);
        assert_eq!(back, [100.0, 200.0, 250.0, 260.0]);
    }

    #[test]
    fn fixed_corner_uses_margin_on_displayed_page() {
        let g = page_geom(595.0, 842.0, 0.0);
        let r = fixed_rect_displayed(Corner::TopRight, 100.0, 50.0, 20.0, &g);
        assert_eq!((r.x1, r.x2), (475.0, 575.0));
        assert_eq!((r.y1, r.y2), (772.0, 822.0));
        let bl = fixed_rect_user(Corner::BottomLeft, 100.0, 50.0, 20.0, &g);
        assert_eq!(bl, [20.0, 20.0, 120.0, 70.0]);
    }

    #[test]
    fn fixed_corner_on_rotated_page_maps_to_user_space() {
        // Trang xoay 90: góc dưới-trái hiển thị không phải góc dưới-trái của không gian người dùng.
        let g = page_geom(842.0, 595.0, 90.0);
        let r = fixed_rect_user(Corner::BottomLeft, 100.0, 50.0, 20.0, &g);
        let back = rect_user_to_display(r, &g);
        assert!(close(back.x1, 20.0) && close(back.y1, 20.0));
        assert!(close(back.x2, 120.0) && close(back.y2, 70.0));
    }

    #[test]
    fn clamp_moves_before_shrinking() {
        let b = clamp_box_to_page(
            ScreenBox {
                left: 450.0,
                top: -5.0,
                width: 100.0,
                height: 40.0,
            },
            500.0,
            600.0,
        );
        assert_eq!(
            (b.left, b.top, b.width, b.height),
            (400.0, 0.0, 100.0, 40.0)
        );
        let big = clamp_box_to_page(
            ScreenBox {
                left: 10.0,
                top: 10.0,
                width: 900.0,
                height: 40.0,
            },
            500.0,
            600.0,
        );
        assert_eq!((big.left, big.width), (0.0, 500.0));
    }

    #[test]
    fn size_readout_in_mm() {
        // 50 mm ở scale 1,0 là 50 * 72/25,4 điểm.
        let (w, h) = box_size_mm(mm_to_pt(50.0), mm_to_pt(20.0), 1.0);
        assert_eq!((w, h), (50.0, 20.0));
        assert!(close(pt_to_mm(mm_to_pt(12.5)), 12.5));
    }

    const PAGE: PageSizePx = PageSizePx {
        width: 500.0,
        height: 700.0,
    };

    #[test]
    fn drag_normalizes_and_clamps() {
        let b = box_from_drag(
            Pt { x: 300.0, y: 300.0 },
            Pt { x: 200.0, y: 250.0 },
            PAGE,
            None,
        );
        assert_eq!(
            (b.left, b.top, b.width, b.height),
            (200.0, 250.0, 100.0, 50.0)
        );
        let out = box_from_drag(
            Pt { x: 450.0, y: 650.0 },
            Pt { x: 900.0, y: 900.0 },
            PAGE,
            None,
        );
        assert_eq!((out.left + out.width, out.top + out.height), (500.0, 700.0));
    }

    #[test]
    fn drag_with_aspect_keeps_shape() {
        let b = box_from_drag(
            Pt { x: 10.0, y: 10.0 },
            Pt { x: 110.0, y: 30.0 },
            PAGE,
            Some(2.0),
        );
        assert!(close(b.width / b.height, 2.0));
    }

    #[test]
    fn move_stays_on_page() {
        let b = move_box(
            ScreenBox {
                left: 10.0,
                top: 10.0,
                width: 100.0,
                height: 50.0,
            },
            -50.0,
            900.0,
            PAGE,
        );
        assert_eq!((b.left, b.top), (0.0, 650.0));
    }

    #[test]
    fn resize_keeps_opposite_edge_and_min_size() {
        let b = ScreenBox {
            left: 100.0,
            top: 100.0,
            width: 100.0,
            height: 60.0,
        };
        let r = resize_box(b, Handle::E, 40.0, 0.0, PAGE, None);
        assert_eq!((r.left, r.width), (100.0, 140.0));
        let nw = resize_box(b, Handle::Nw, 500.0, 500.0, PAGE, None);
        assert_eq!((nw.width, nw.height), (MIN_BOX_PX, MIN_BOX_PX));
        // Cạnh đối diện (đông-nam) đứng yên.
        assert!(close(nw.left + nw.width, 200.0) && close(nw.top + nw.height, 160.0));
    }

    #[test]
    fn resize_with_aspect_on_corner_and_edge() {
        let b = ScreenBox {
            left: 100.0,
            top: 100.0,
            width: 100.0,
            height: 50.0,
        };
        let c = resize_box(b, Handle::Se, 100.0, 0.0, PAGE, Some(2.0));
        assert!(close(c.width / c.height, 2.0));
        let e = resize_box(b, Handle::E, 50.0, 0.0, PAGE, Some(2.0));
        assert!(close(e.width, 150.0) && close(e.height, 75.0));
    }

    #[test]
    fn handles_are_eight_points() {
        let pts = handle_points(ScreenBox {
            left: 0.0,
            top: 0.0,
            width: 10.0,
            height: 20.0,
        });
        assert_eq!(pts.len(), 8);
        assert_eq!(pts[3], (Handle::E, 10.0, 10.0));
    }
}
