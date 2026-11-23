//! Xóa trang trắng (TASKS_RUST R5.06, FEATURES C8): tìm bằng `page.findBlank` (chỉ đọc), người dùng
//! xem danh sách và bỏ chọn trang giữ lại, rồi mới xóa bằng `page.delete` đúng các trang đã chọn.
//! Ngưỡng: tỷ lệ mực ≤ 10^(-4.3 + 2·độ nhạy) thì là trắng (độ nhạy 0,5 mặc định ≈ 0,05% điểm ảnh).
#![allow(dead_code)]

use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Options {
    /// 0 = chỉ trang trắng tuyệt đối, 1 = chịu được vài chấm bẩn.
    pub sensitivity: f64,
    /// Viền bỏ qua khi đo (mm), để vết mép giấy không làm trang thành "có chữ".
    pub border_mm: f64,
    pub keep_if_annotations: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            sensitivity: 0.5,
            border_mm: 5.0,
            keep_if_annotations: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reject {
    BadSensitivity,
    BadBorder,
    EmptyPages,
    /// Mọi trang đều bị chọn xóa: không cho xóa hết tài liệu.
    WouldDeleteAll,
    NothingSelected,
}

/// Ngưỡng tỷ lệ mực tương ứng độ nhạy (cùng công thức `blank_limit` của lõi).
pub fn ink_limit(sensitivity: f64) -> f64 {
    10f64.powf(-4.3 + 2.0 * sensitivity)
}

/// Tham số `page.findBlank`; `pages` là chỉ số từ 0, None là mọi trang.
pub fn find_params(opts: &Options, pages: Option<&[u64]>) -> Result<Value, Reject> {
    if !(0.0..=1.0).contains(&opts.sensitivity) {
        return Err(Reject::BadSensitivity);
    }
    if !opts.border_mm.is_finite() || !(0.0..=50.0).contains(&opts.border_mm) {
        return Err(Reject::BadBorder);
    }
    let mut v = json!({
        "sensitivity": opts.sensitivity,
        "borderMm": opts.border_mm,
        "keepIfAnnotations": opts.keep_if_annotations,
    });
    if let Some(p) = pages {
        if p.is_empty() {
            return Err(Reject::EmptyPages);
        }
        v["pages"] = json!(p);
    }
    Ok(v)
}

/// Một dòng kết quả của `page.findBlank`.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    pub index: usize,
    pub ink_ratio: f64,
    pub has_text: bool,
    pub has_annotations: bool,
    pub blank: bool,
}

/// Đọc `data.pages` của `page.findBlank`; dòng sai dạng bị bỏ.
pub fn parse_rows(data: &Value) -> Vec<Row> {
    data.get("pages")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|r| {
                    Some(Row {
                        index: r.get("index")?.as_u64()? as usize,
                        ink_ratio: r.get("inkRatio")?.as_f64()?,
                        has_text: r.get("hasText").and_then(Value::as_bool).unwrap_or(false),
                        has_annotations: r
                            .get("hasAnnotations")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        blank: r.get("blank")?.as_bool()?,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Trạng thái màn xem trước: chưa xác nhận thì chưa có gì bị xóa.
#[derive(Debug, Clone, Default)]
pub struct Review {
    rows: Vec<Row>,
    /// Trang được chọn xóa (mặc định là các ứng viên trắng).
    selected: std::collections::BTreeSet<usize>,
    page_count: usize,
}

impl Review {
    pub fn new(rows: Vec<Row>, page_count: usize) -> Self {
        let selected = rows.iter().filter(|r| r.blank).map(|r| r.index).collect();
        Self {
            rows,
            selected,
            page_count,
        }
    }

    pub fn rows(&self) -> &[Row] {
        &self.rows
    }

    pub fn is_selected(&self, index: usize) -> bool {
        self.selected.contains(&index)
    }

    pub fn toggle(&mut self, index: usize) {
        if self.rows.iter().any(|r| r.index == index) && !self.selected.remove(&index) {
            self.selected.insert(index);
        }
    }

    pub fn selected(&self) -> Vec<usize> {
        self.selected.iter().copied().collect()
    }

    /// Chỉ xóa sau khi người dùng bấm xác nhận: trả danh sách trang cho `page.delete`.
    pub fn confirm(&self) -> Result<Vec<usize>, Reject> {
        if self.selected.is_empty() {
            return Err(Reject::NothingSelected);
        }
        if self.page_count > 0 && self.selected.len() >= self.page_count {
            return Err(Reject::WouldDeleteAll);
        }
        Ok(self.selected())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data() -> Value {
        json!({"pages":[
            {"index":0,"inkRatio":0.0,"hasText":false,"hasAnnotations":false,"blank":true},
            {"index":1,"inkRatio":0.02,"hasText":true,"hasAnnotations":false,"blank":false},
            {"index":2,"inkRatio":0.00001,"hasText":false,"hasAnnotations":false,"blank":true},
            {"broken":true}
        ]})
    }

    #[test]
    fn limit_matches_core_formula() {
        assert!((ink_limit(0.5) - 10f64.powf(-3.3)).abs() < 1e-12);
        assert!(ink_limit(0.0) < ink_limit(1.0));
    }

    #[test]
    fn find_params_validated() {
        let ok = find_params(&Options::default(), None).unwrap();
        assert_eq!(ok["sensitivity"], 0.5);
        assert!(ok.get("pages").is_none());
        let bad = Options {
            sensitivity: 1.5,
            ..Options::default()
        };
        assert_eq!(find_params(&bad, None).unwrap_err(), Reject::BadSensitivity);
        let bad = Options {
            border_mm: 80.0,
            ..Options::default()
        };
        assert_eq!(find_params(&bad, None).unwrap_err(), Reject::BadBorder);
        assert_eq!(
            find_params(&Options::default(), Some(&[])).unwrap_err(),
            Reject::EmptyPages
        );
    }

    #[test]
    fn review_requires_confirmation_and_blocks_delete_all() {
        let rows = parse_rows(&data());
        assert_eq!(rows.len(), 3);
        let mut r = Review::new(rows, 3);
        assert_eq!(r.selected(), vec![0, 2]);
        assert_eq!(r.confirm().unwrap(), vec![0, 2]);
        r.toggle(0); // giữ lại trang 0
        assert_eq!(r.confirm().unwrap(), vec![2]);
        r.toggle(1); // chọn thêm trang có chữ
        r.toggle(0);
        assert_eq!(r.confirm().unwrap_err(), Reject::WouldDeleteAll);
        r.toggle(0);
        r.toggle(1);
        r.toggle(2);
        assert_eq!(r.confirm().unwrap_err(), Reject::NothingSelected);
        r.toggle(99); // không có trong danh sách: bỏ qua
        assert!(r.selected().is_empty());
    }
}
