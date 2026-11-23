//! Phần chung của các hộp thoại đặt đối tượng lên trang (TASKS_RUST R5.29–R5.38; FEATURES F): port
//! các kiểu và hàm dùng chung trong `overlayModel.ts` (đơn vị, mỏ neo, chọn trang, kiểm form).
#![allow(dead_code)]

use serde_json::{Map, Value};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Unit {
    Pt,
    Mm,
}

impl Unit {
    pub fn as_str(self) -> &'static str {
        match self {
            Unit::Pt => "pt",
            Unit::Mm => "mm",
        }
    }
}

/// Điểm của đối tượng đặt tại (x, y).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Anchor {
    TopLeft,
    TopCenter,
    TopRight,
    CenterLeft,
    Center,
    CenterRight,
    BottomLeft,
    BottomCenter,
    BottomRight,
}

impl Anchor {
    pub fn as_str(self) -> &'static str {
        match self {
            Anchor::TopLeft => "top-left",
            Anchor::TopCenter => "top-center",
            Anchor::TopRight => "top-right",
            Anchor::CenterLeft => "center-left",
            Anchor::Center => "center",
            Anchor::CenterRight => "center-right",
            Anchor::BottomLeft => "bottom-left",
            Anchor::BottomCenter => "bottom-center",
            Anchor::BottomRight => "bottom-right",
        }
    }
}

/// Lưới chọn mỏ neo 3×3, từng hàng.
pub const ANCHOR_GRID: [[Anchor; 3]; 3] = [
    [Anchor::TopLeft, Anchor::TopCenter, Anchor::TopRight],
    [Anchor::CenterLeft, Anchor::Center, Anchor::CenterRight],
    [
        Anchor::BottomLeft,
        Anchor::BottomCenter,
        Anchor::BottomRight,
    ],
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PagesChoice {
    Current,
    All,
    Range,
    Odd,
    Even,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PagesSel {
    pub choice: PagesChoice,
    /// Dùng với `Range`: "1-3, 5, 8-".
    pub range: String,
}

impl Default for PagesSel {
    fn default() -> Self {
        Self {
            choice: PagesChoice::Current,
            range: String::new(),
        }
    }
}

/// Khoảng trang gõ sai.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BadPages;

/// Tham số trang của lõi cho một lựa chọn: `current` là trang đang xem (từ 0); `All` không gửi gì.
/// `Err` khi khoảng gõ sai (để hộp thoại báo ngay cạnh ô).
pub fn page_selection(
    sel: &PagesSel,
    current: usize,
    page_count: usize,
) -> Result<Map<String, Value>, BadPages> {
    let mut m = Map::new();
    match sel.choice {
        PagesChoice::Current => {
            m.insert("pages".into(), Value::from(vec![current]));
        }
        PagesChoice::All => {}
        PagesChoice::Odd => {
            m.insert("pageRange".into(), "odd".into());
        }
        PagesChoice::Even => {
            m.insert("pageRange".into(), "even".into());
        }
        PagesChoice::Range => {
            let p = crate::page_range::parse(&sel.range, page_count).map_err(|_| BadPages)?;
            m.insert("pages".into(), Value::from(p.pages));
        }
    }
    Ok(m)
}

/// Các trang bị ảnh hưởng (từ 0), cho xem trước và cảnh báo.
pub fn selected_pages(sel: &PagesSel, current: usize, page_count: usize) -> Vec<usize> {
    let Ok(m) = page_selection(sel, current, page_count) else {
        return Vec::new();
    };
    if let Some(p) = m.get("pages").and_then(Value::as_array) {
        return p
            .iter()
            .filter_map(|v| v.as_u64().map(|n| n as usize))
            .collect();
    }
    let all = 0..page_count;
    match m.get("pageRange").and_then(Value::as_str) {
        Some("odd") => all.filter(|i| i % 2 == 0).collect(),
        Some("even") => all.filter(|i| i % 2 == 1).collect(),
        _ => all.collect(),
    }
}

/// Kết quả kiểm form: đạt, hoặc tên trường sai.
pub type FormCheck = Result<(), &'static str>;

/// Màu #RRGGBB.
pub fn is_hex_color(v: &str) -> bool {
    v.len() == 7 && v.starts_with('#') && v[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn in_range(v: f64, min: f64, max: f64) -> bool {
    v.is_finite() && v >= min && v <= max
}

pub fn mm_to_pt(mm: f64) -> f64 {
    mm * 72.0 / 25.4
}

/// Giờ cục bộ để điền biến {date}, {time}.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalTime {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
}

impl LocalTime {
    pub fn date(&self) -> String {
        format!("{:02}/{:02}/{}", self.day, self.month, self.year)
    }
    pub fn time(&self) -> String {
        format!("{:02}:{:02}", self.hour, self.minute)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_selection_params() {
        let sel = |choice, range: &str| PagesSel {
            choice,
            range: range.into(),
        };
        assert_eq!(
            page_selection(&sel(PagesChoice::Current, ""), 3, 9).unwrap()["pages"],
            serde_json::json!([3])
        );
        assert!(
            page_selection(&sel(PagesChoice::All, ""), 3, 9)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            page_selection(&sel(PagesChoice::Odd, ""), 3, 9).unwrap()["pageRange"],
            "odd"
        );
        assert_eq!(
            page_selection(&sel(PagesChoice::Range, "2, 5-"), 3, 9).unwrap()["pages"],
            serde_json::json!([1, 4, 5, 6, 7, 8])
        );
        assert!(page_selection(&sel(PagesChoice::Range, "x"), 3, 9).is_err());
    }

    #[test]
    fn selected_pages_cover_every_choice() {
        let sel = |choice, range: &str| PagesSel {
            choice,
            range: range.into(),
        };
        assert_eq!(
            selected_pages(&sel(PagesChoice::All, ""), 0, 4),
            [0, 1, 2, 3]
        );
        assert_eq!(selected_pages(&sel(PagesChoice::Odd, ""), 0, 5), [0, 2, 4]);
        assert_eq!(selected_pages(&sel(PagesChoice::Even, ""), 0, 5), [1, 3]);
        assert_eq!(selected_pages(&sel(PagesChoice::Current, ""), 2, 5), [2]);
        assert_eq!(
            selected_pages(&sel(PagesChoice::Range, "3,1"), 0, 5),
            [2, 0]
        );
        assert!(selected_pages(&sel(PagesChoice::Range, "99"), 0, 5).is_empty());
    }

    #[test]
    fn small_checks() {
        assert!(is_hex_color("#C00000") && is_hex_color("#abcdef"));
        assert!(!is_hex_color("C00000") && !is_hex_color("#C0000") && !is_hex_color("#GGGGGG"));
        assert!(
            in_range(0.0, 0.0, 1.0) && !in_range(f64::NAN, 0.0, 1.0) && !in_range(1.1, 0.0, 1.0)
        );
        assert!((mm_to_pt(25.4) - 72.0).abs() < 1e-9);
        let t = LocalTime {
            year: 2026,
            month: 1,
            day: 5,
            hour: 9,
            minute: 7,
        };
        assert_eq!(
            (t.date().as_str(), t.time().as_str()),
            ("05/01/2026", "09:07")
        );
        assert_eq!(ANCHOR_GRID[1][1].as_str(), "center");
    }
}
