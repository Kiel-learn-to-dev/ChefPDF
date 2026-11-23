//! Chia đôi trang và lưới N phần (TASKS_RUST R5.07, FEATURES C9): dựng tham số `page.split`.
//! Mỗi mảnh có CropBox riêng; lõi tính hộp theo thứ tự đọc (`ltr` hoặc `rtl`).
#![allow(dead_code)]

use chef_contracts::ops_types::PageSplitParams;
use serde_json::json;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reject {
    /// Hàng × cột phải ≥ 2 và mỗi chiều 1..=10.
    BadGrid,
    BadOverlap,
    EmptyPages,
}

/// Hai nửa: chia dọc (trái/phải) hoặc ngang (trên/dưới).
pub fn halves(
    vertical_cut: bool,
    rtl: bool,
    pages: Option<&[u64]>,
) -> Result<PageSplitParams, Reject> {
    let (rows, cols) = if vertical_cut { (1, 2) } else { (2, 1) };
    grid(rows, cols, 0.0, rtl, pages)
}

pub fn grid(
    rows: u32,
    cols: u32,
    overlap_mm: f64,
    rtl: bool,
    pages: Option<&[u64]>,
) -> Result<PageSplitParams, Reject> {
    if !(1..=10).contains(&rows) || !(1..=10).contains(&cols) || rows * cols < 2 {
        return Err(Reject::BadGrid);
    }
    if !overlap_mm.is_finite() || !(0.0..=50.0).contains(&overlap_mm) {
        return Err(Reject::BadOverlap);
    }
    let mut v = json!({
        "rows": rows, "cols": cols, "overlapMm": overlap_mm,
        "order": if rtl { "rtl" } else { "ltr" },
    });
    if let Some(p) = pages {
        if p.is_empty() {
            return Err(Reject::EmptyPages);
        }
        v["pages"] = json!(p);
    }
    serde_json::from_value(v).map_err(|_| Reject::BadGrid)
}

/// Số trang sau khi chia: mỗi trang được chọn thành rows × cols trang.
pub fn page_count_after(total: usize, selected: usize, rows: u32, cols: u32) -> usize {
    total - selected + selected * (rows * cols) as usize
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn halves_and_grid() {
        let j = serde_json::to_value(halves(true, true, None).unwrap()).unwrap();
        assert_eq!((j["rows"].as_u64(), j["cols"].as_u64()), (Some(1), Some(2)));
        assert_eq!(j["order"], "rtl");
        let j = serde_json::to_value(halves(false, false, Some(&[0, 3])).unwrap()).unwrap();
        assert_eq!((j["rows"].as_u64(), j["cols"].as_u64()), (Some(2), Some(1)));
        assert_eq!(j["pages"], json!([0, 3]));
        assert!(grid(3, 3, 2.5, false, None).is_ok());
    }

    #[test]
    fn rejects_and_counts() {
        assert_eq!(grid(1, 1, 0.0, false, None).unwrap_err(), Reject::BadGrid);
        assert_eq!(grid(11, 1, 0.0, false, None).unwrap_err(), Reject::BadGrid);
        assert_eq!(
            grid(1, 2, 60.0, false, None).unwrap_err(),
            Reject::BadOverlap
        );
        assert_eq!(
            grid(1, 2, 0.0, false, Some(&[])).unwrap_err(),
            Reject::EmptyPages
        );
        assert_eq!(page_count_after(10, 4, 2, 2), 22);
    }
}
