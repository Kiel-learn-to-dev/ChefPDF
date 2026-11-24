//! Khổ giấy, tỉ lệ khung và cỡ ảnh ra khi cắt (TASKS_RUST R8.18, R8.19, R8.20; FEATURES L16–L19): port
//! `cropSizing.ts` và phần tỉ lệ của `CropDialog.tsx`, thêm `guess_paper` (đoán khổ theo tỉ lệ cạnh, R8.20).
//! Logic thuần, đơn vị: mm cho khổ giấy, điểm ảnh cho cỡ ra, tọa độ chuẩn hóa 0..1 cho khung trên ảnh.
#![allow(dead_code)]

use crate::crop_geometry::Point;

/// Giới hạn tổng số điểm ảnh của ảnh ra.
pub const MAX_CROP_PIXELS: u64 = 50_000_000;
/// Giới hạn mỗi chiều của ảnh ra.
pub const MAX_CROP_DIMENSION: u64 = 20_000;

/// Kết quả đổi số đo (mm) sang cỡ điểm ảnh ở độ phân giải `ppi`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutSize {
    /// Cả hai ô trống: giữ cỡ khung.
    Unset,
    Pixels(u32, u32),
    /// Số đo không hợp lệ hoặc vượt giới hạn.
    Invalid,
}

/// `width_mm` và `height_mm` là chữ người dùng nhập; trống cả hai thì `Unset`. Một ô trống hoặc không phải số
/// dương, `ppi` không dương, hoặc kết quả vượt giới hạn thì `Invalid`.
pub fn output_size_from_mm(width_mm: &str, height_mm: &str, ppi: f64) -> OutSize {
    let (wt, ht) = (width_mm.trim(), height_mm.trim());
    if wt.is_empty() && ht.is_empty() {
        return OutSize::Unset;
    }
    let (Ok(w), Ok(h)) = (wt.parse::<f64>(), ht.parse::<f64>()) else {
        return OutSize::Invalid;
    };
    if !ppi.is_finite() || ppi <= 0.0 || !w.is_finite() || !h.is_finite() || w <= 0.0 || h <= 0.0 {
        return OutSize::Invalid;
    }
    // Làm tròn nửa lên như Math.round.
    let width = (w * ppi / 25.4 + 0.5).floor();
    let height = (h * ppi / 25.4 + 0.5).floor();
    if width < 1.0
        || height < 1.0
        || width > MAX_CROP_DIMENSION as f64
        || height > MAX_CROP_DIMENSION as f64
    {
        return OutSize::Invalid;
    }
    let (width, height) = (width as u64, height as u64);
    if width * height > MAX_CROP_PIXELS {
        return OutSize::Invalid;
    }
    OutSize::Pixels(width as u32, height as u32)
}

/// Tỉ lệ có sẵn của khung cắt. `Free` là tự do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ratio {
    Free,
    A4,
    A5,
    Letter,
    /// Căn cước công dân (thẻ 54 x 86 mm).
    Cccd,
}

impl Ratio {
    pub const ALL: [Ratio; 5] = [
        Ratio::Free,
        Ratio::A4,
        Ratio::A5,
        Ratio::Letter,
        Ratio::Cccd,
    ];

    /// Giá trị gửi qua lại (`210/297`...), như ô chọn của Electron.
    pub fn as_str(self) -> &'static str {
        match self {
            Ratio::Free => "free",
            Ratio::A4 => "210/297",
            Ratio::A5 => "148/210",
            Ratio::Letter => "216/279",
            Ratio::Cccd => "54/86",
        }
    }

    pub fn parse(v: &str) -> Option<Ratio> {
        Ratio::ALL.into_iter().find(|r| r.as_str() == v)
    }

    /// (rộng, cao) mm của giấy dọc; `None` khi tự do.
    pub fn mm(self) -> Option<(f64, f64)> {
        match self {
            Ratio::Free => None,
            Ratio::A4 => Some((210.0, 297.0)),
            Ratio::A5 => Some((148.0, 210.0)),
            Ratio::Letter => Some((216.0, 279.0)),
            Ratio::Cccd => Some((54.0, 86.0)),
        }
    }
}

/// Tỉ lệ rộng/cao trong tọa độ chuẩn hóa của ảnh nguồn (để khóa khung chữ nhật). `None` khi tự do hoặc ảnh
/// không có cỡ.
pub fn locked_aspect(ratio: Ratio, source_w: f64, source_h: f64) -> Option<f64> {
    let (w, h) = ratio.mm()?;
    (source_w > 0.0 && source_h > 0.0).then(|| (w / h) * (source_h / source_w))
}

/// Khi chọn một tỉ lệ: thu khung hiện tại (bốn góc chuẩn hóa) về đúng tỉ lệ, giữ tâm, ngắn bớt cạnh dài.
/// `view_w`, `view_h` là cỡ ảnh đang hiển thị (px) để đổi tỉ lệ sang hệ chuẩn hóa. Trả bốn góc trên-trái,
/// trên-phải, dưới-phải, dưới-trái.
pub fn fit_frame_to_ratio(
    points: &[Point],
    ratio: Ratio,
    view_w: f64,
    view_h: f64,
) -> Option<[Point; 4]> {
    let (rw, rh) = ratio.mm()?;
    if points.len() != 4 || view_w <= 0.0 || view_h <= 0.0 {
        return None;
    }
    let (x0, x1) = (
        points.iter().map(|p| p.x).fold(f64::INFINITY, f64::min),
        points.iter().map(|p| p.x).fold(f64::NEG_INFINITY, f64::max),
    );
    let (y0, y1) = (
        points.iter().map(|p| p.y).fold(f64::INFINITY, f64::min),
        points.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max),
    );
    let (cx, cy) = ((x0 + x1) / 2.0, (y0 + y1) / 2.0);
    let (mut w, mut h) = (x1 - x0, y1 - y0);
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    let target = (rw / rh) * (view_h / view_w);
    if w / h > target {
        w = h * target;
    } else {
        h = w / target;
    }
    Some([
        Point {
            x: cx - w / 2.0,
            y: cy - h / 2.0,
        },
        Point {
            x: cx + w / 2.0,
            y: cy - h / 2.0,
        },
        Point {
            x: cx + w / 2.0,
            y: cy + h / 2.0,
        },
        Point {
            x: cx - w / 2.0,
            y: cy + h / 2.0,
        },
    ])
}

/// Khổ đoán được: loại, hướng (ngang hay dọc) và độ lệch tỉ lệ.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PaperGuess {
    pub ratio: Ratio,
    pub landscape: bool,
    /// Độ lệch tương đối giữa tỉ lệ cạnh đo được và tỉ lệ chuẩn (0 = khớp hẳn).
    pub error: f64,
}

/// Dung sai mặc định khi đoán khổ: 3% theo tỉ lệ cạnh.
pub const PAPER_TOLERANCE: f64 = 0.03;

/// Đoán khổ giấy từ cỡ hộp (bất kỳ đơn vị): so tỉ lệ cạnh ngắn/dài với từng khổ có sẵn, chọn khổ lệch ít nhất
/// nếu trong dung sai. A4 và A5 cùng tỉ lệ (√2) nên `guess_paper` trả A4 (khổ phổ biến hơn); đổi sang A5 là chọn
/// tay hoặc theo kích thước thật. Trả `None` khi không khổ nào đủ gần hoặc cỡ không hợp lệ.
pub fn guess_paper(width: f64, height: f64, tolerance: f64) -> Option<PaperGuess> {
    if !(width.is_finite() && height.is_finite()) || width <= 0.0 || height <= 0.0 {
        return None;
    }
    let landscape = width > height;
    let measured = width.min(height) / width.max(height);
    let mut best: Option<PaperGuess> = None;
    for r in [Ratio::A4, Ratio::Letter, Ratio::Cccd] {
        let (w, h) = r.mm()?;
        let standard = w / h;
        let error = (measured - standard).abs() / standard;
        if error <= tolerance && best.is_none_or(|b| error < b.error) {
            best = Some(PaperGuess {
                ratio: r,
                landscape,
                error,
            });
        }
    }
    best
}

/// Kích thước trang PDF (điểm) của một khổ giấy dọc; đổi chiều khi `landscape`.
pub fn page_size_pt(ratio: Ratio, landscape: bool) -> Option<(f64, f64)> {
    let (w, h) = ratio.mm()?;
    let k = 72.0 / 25.4;
    let (pw, ph) = (w * k, h * k);
    Some(if landscape { (ph, pw) } else { (pw, ph) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn size_from_mm_matches_the_electron_rules() {
        assert_eq!(output_size_from_mm("", "  ", 300.0), OutSize::Unset);
        assert_eq!(
            output_size_from_mm("210", "297", 300.0),
            OutSize::Pixels(2480, 3508)
        );
        assert_eq!(
            output_size_from_mm("54", "86", 200.0),
            OutSize::Pixels(425, 677)
        );
        assert_eq!(
            output_size_from_mm("210", "", 300.0),
            OutSize::Invalid,
            "một ô trống"
        );
        assert_eq!(output_size_from_mm("abc", "10", 300.0), OutSize::Invalid);
        assert_eq!(output_size_from_mm("0", "10", 300.0), OutSize::Invalid);
        assert_eq!(output_size_from_mm("-5", "10", 300.0), OutSize::Invalid);
        assert_eq!(
            output_size_from_mm("10", "10", 0.0),
            OutSize::Invalid,
            "không biết ppi"
        );
        assert_eq!(output_size_from_mm("10", "10", f64::NAN), OutSize::Invalid);
    }

    #[test]
    fn size_limits() {
        assert_eq!(
            output_size_from_mm("1", "1", 10.0),
            OutSize::Invalid,
            "dưới 1 điểm ảnh"
        );
        // 20000 px mỗi chiều ở 508 ppi = 1000 mm: đúng giới hạn thì được, hơn thì không.
        assert_eq!(
            output_size_from_mm("1000", "10", 508.0),
            OutSize::Pixels(20000, 200)
        );
        assert_eq!(output_size_from_mm("1001", "10", 508.0), OutSize::Invalid);
        // Mỗi chiều hợp lệ nhưng tích vượt 50 triệu điểm ảnh.
        assert_eq!(output_size_from_mm("900", "900", 508.0), OutSize::Invalid);
    }

    #[test]
    fn ratio_values_round_trip() {
        for r in Ratio::ALL {
            assert_eq!(Ratio::parse(r.as_str()), Some(r));
        }
        assert_eq!(Ratio::parse("1/1"), None);
        assert_eq!(Ratio::Free.mm(), None);
    }

    #[test]
    fn locked_aspect_uses_source_proportions() {
        assert_eq!(locked_aspect(Ratio::Free, 1000.0, 1000.0), None);
        assert_eq!(locked_aspect(Ratio::A4, 0.0, 10.0), None);
        let a = locked_aspect(Ratio::A4, 2000.0, 1000.0).unwrap();
        assert!((a - (210.0 / 297.0) * 0.5).abs() < 1e-12);
    }

    fn pts(x0: f64, y0: f64, x1: f64, y1: f64) -> Vec<Point> {
        vec![
            Point { x: x0, y: y0 },
            Point { x: x1, y: y0 },
            Point { x: x1, y: y1 },
            Point { x: x0, y: y1 },
        ]
    }

    #[test]
    fn fitting_a_frame_keeps_the_centre_and_the_ratio() {
        // Khung vuông trên ảnh vuông 1000x1000: chiều cao giữ, chiều rộng thu theo A4.
        let f = fit_frame_to_ratio(&pts(0.2, 0.2, 0.8, 0.8), Ratio::A4, 1000.0, 1000.0).unwrap();
        let (w, h) = (f[1].x - f[0].x, f[2].y - f[1].y);
        assert!((w / h - 210.0 / 297.0).abs() < 1e-9);
        assert!((h - 0.6).abs() < 1e-9, "cạnh dài giữ nguyên");
        assert!(
            ((f[0].x + f[1].x) / 2.0 - 0.5).abs() < 1e-9
                && ((f[0].y + f[2].y) / 2.0 - 0.5).abs() < 1e-9
        );
        // Khung rất cao: chiều rộng giữ, chiều cao thu.
        let g = fit_frame_to_ratio(&pts(0.4, 0.0, 0.6, 1.0), Ratio::A4, 1000.0, 1000.0).unwrap();
        assert!(((g[1].x - g[0].x) - 0.2).abs() < 1e-9);
        assert!(fit_frame_to_ratio(&pts(0.0, 0.0, 1.0, 1.0), Ratio::Free, 10.0, 10.0).is_none());
        assert!(fit_frame_to_ratio(&pts(0.0, 0.0, 1.0, 1.0)[..3], Ratio::A4, 10.0, 10.0).is_none());
        assert!(fit_frame_to_ratio(&pts(0.5, 0.5, 0.5, 0.5), Ratio::A4, 10.0, 10.0).is_none());
    }

    #[test]
    fn guesses_standard_papers_in_either_orientation() {
        let a4 = guess_paper(2480.0, 3508.0, PAPER_TOLERANCE).unwrap();
        assert_eq!((a4.ratio, a4.landscape), (Ratio::A4, false));
        assert!(a4.error < 0.001);
        let a4_land = guess_paper(3508.0, 2480.0, PAPER_TOLERANCE).unwrap();
        assert_eq!((a4_land.ratio, a4_land.landscape), (Ratio::A4, true));
        assert_eq!(
            guess_paper(216.0, 279.0, PAPER_TOLERANCE).unwrap().ratio,
            Ratio::Letter
        );
        assert_eq!(
            guess_paper(860.0, 540.0, PAPER_TOLERANCE).unwrap().ratio,
            Ratio::Cccd
        );
    }

    #[test]
    fn a5_has_the_a4_ratio_so_it_reads_as_a4() {
        assert_eq!(
            guess_paper(148.0, 210.0, PAPER_TOLERANCE).unwrap().ratio,
            Ratio::A4
        );
    }

    #[test]
    fn letter_and_a4_are_told_apart_and_odd_shapes_are_not_guessed() {
        // 8,5x11 in = 0,7727; A4 = 0,7071: cách nhau hơn 9% nên không nhầm với dung sai 3%.
        assert_eq!(
            guess_paper(850.0, 1100.0, PAPER_TOLERANCE).unwrap().ratio,
            Ratio::Letter
        );
        assert_eq!(guess_paper(1000.0, 1000.0, PAPER_TOLERANCE), None);
        assert_eq!(guess_paper(100.0, 300.0, PAPER_TOLERANCE), None);
        assert_eq!(guess_paper(0.0, 10.0, PAPER_TOLERANCE), None);
        assert_eq!(guess_paper(f64::NAN, 10.0, PAPER_TOLERANCE), None);
        assert!(guess_paper(210.0, 380.0, PAPER_TOLERANCE).is_none());
        assert!(
            guess_paper(210.0, 380.0, 0.5).is_some(),
            "dung sai rộng thì đoán được"
        );
    }

    #[test]
    fn page_size_in_points() {
        let (w, h) = page_size_pt(Ratio::A4, false).unwrap();
        assert!((w - 595.28).abs() < 0.01 && (h - 841.89).abs() < 0.01);
        assert_eq!(page_size_pt(Ratio::A4, true), Some((h, w)));
        assert_eq!(page_size_pt(Ratio::Free, false), None);
    }
}
