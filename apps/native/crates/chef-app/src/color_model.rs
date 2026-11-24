//! Chuyển màu (TASKS_RUST R5.17, FEATURES M6): port `colorModel.ts`. Form, kiểm, tham số
//! `color.convert` (chỉ gửi trường của chế độ đã chọn), báo cáo kết quả. Logic thuần.
#![allow(dead_code)]

use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorMode {
    Gray,
    BlackWhite,
    InkSaver,
    ReplaceColor,
}

impl ColorMode {
    pub const ALL: [ColorMode; 4] = [
        ColorMode::Gray,
        ColorMode::BlackWhite,
        ColorMode::InkSaver,
        ColorMode::ReplaceColor,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Gray => "gray",
            Self::BlackWhite => "blackwhite",
            Self::InkSaver => "ink-saver",
            Self::ReplaceColor => "replace-color",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ColorForm {
    pub mode: ColorMode,
    /// `false` = mọi trang; `true` = khoảng trong `pages_text` (từ 1).
    pub only_pages: bool,
    pub pages_text: String,
    /// blackwhite: ngưỡng 0..255.
    pub threshold: i64,
    pub dithering: bool,
    /// ink-saver: 0..1.
    pub amount: f64,
    /// replace-color: '#rrggbb'.
    pub source_color: String,
    pub target_color: String,
    /// replace-color: mỗi kênh 0..255.
    pub tolerance: i64,
}

impl Default for ColorForm {
    fn default() -> Self {
        Self {
            mode: ColorMode::Gray,
            only_pages: false,
            pages_text: String::new(),
            threshold: 128,
            dithering: false,
            amount: 0.5,
            source_color: "#ff0000".into(),
            target_color: "#000000".into(),
            tolerance: 24,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorIssue {
    Pages,
    Threshold,
    Amount,
    SourceColor,
    TargetColor,
    Tolerance,
}

/// '#rrggbb' chữ thường, hoặc None khi không phải màu hex 6 chữ số.
pub fn normalize_hex(text: &str) -> Option<String> {
    let t = text.trim();
    crate::overlay_common::is_hex_color(t).then(|| t.to_lowercase())
}

/// Trang (từ 0) của ô chọn; None khi rỗng hoặc sai với tài liệu.
pub fn selected_color_pages(f: &ColorForm, page_count: usize) -> Option<Vec<usize>> {
    crate::page_range::parse_page_ranges(&f.pages_text, page_count)
        .ok()
        .map(|p| p.pages)
}

/// Vấn đề của form với tài liệu `page_count` trang (rỗng = chạy được).
pub fn color_issues(f: &ColorForm, page_count: usize) -> Vec<ColorIssue> {
    let mut v = Vec::new();
    if f.only_pages && selected_color_pages(f, page_count).is_none() {
        v.push(ColorIssue::Pages);
    }
    if f.mode == ColorMode::BlackWhite && !(0..=255).contains(&f.threshold) {
        v.push(ColorIssue::Threshold);
    }
    if f.mode == ColorMode::InkSaver && !(0.0..=1.0).contains(&f.amount) {
        v.push(ColorIssue::Amount);
    }
    if f.mode == ColorMode::ReplaceColor {
        if normalize_hex(&f.source_color).is_none() {
            v.push(ColorIssue::SourceColor);
        }
        if normalize_hex(&f.target_color).is_none() {
            v.push(ColorIssue::TargetColor);
        }
        if !(0..=255).contains(&f.tolerance) {
            v.push(ColorIssue::Tolerance);
        }
    }
    v
}

/// `color.convert` cho form hợp lệ.
pub fn color_params(f: &ColorForm, page_count: usize) -> Value {
    let mut v = json!({"mode": f.mode.as_str()});
    if f.only_pages {
        v["pages"] = json!(selected_color_pages(f, page_count).unwrap_or_default());
    }
    match f.mode {
        ColorMode::BlackWhite => {
            v["threshold"] = f.threshold.into();
            v["dithering"] = f.dithering.into();
        }
        ColorMode::InkSaver => v["amount"] = f.amount.into(),
        ColorMode::ReplaceColor => {
            v["sourceColor"] = normalize_hex(&f.source_color)
                .unwrap_or_else(|| f.source_color.clone())
                .into();
            v["targetColor"] = normalize_hex(&f.target_color)
                .unwrap_or_else(|| f.target_color.clone())
                .into();
            v["tolerance"] = f.tolerance.into();
        }
        ColorMode::Gray => {}
    }
    v
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColorReport {
    pub colours_changed: u64,
    pub images_changed: u64,
    pub pages_changed: u64,
    /// (lý do, số lượng) giữ nguyên, theo tên lý do.
    pub kept: Vec<(String, u64)>,
}

/// Dữ liệu `color.convert` (trường thiếu tính là 0).
pub fn read_color_report(d: &Value) -> ColorReport {
    let n = |k: &str| d.get(k).and_then(Value::as_u64).unwrap_or(0);
    let mut kept: Vec<(String, u64)> = d
        .get("kept")
        .and_then(Value::as_object)
        .map(|o| {
            o.iter()
                .filter_map(|(k, v)| v.as_u64().filter(|c| *c > 0).map(|c| (k.clone(), c)))
                .collect()
        })
        .unwrap_or_default();
    kept.sort();
    ColorReport {
        colours_changed: n("coloursChanged"),
        images_changed: n("imagesChanged"),
        pages_changed: n("pagesChanged"),
        kept,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex() {
        assert_eq!(normalize_hex(" #FF00aa "), Some("#ff00aa".into()));
        assert_eq!(
            (
                normalize_hex("ff0000"),
                normalize_hex("#12345"),
                normalize_hex("")
            ),
            (None, None, None)
        );
    }

    #[test]
    fn issues_depend_on_mode() {
        assert!(color_issues(&ColorForm::default(), 3).is_empty());
        let bw = ColorForm {
            mode: ColorMode::BlackWhite,
            threshold: 300,
            ..Default::default()
        };
        assert_eq!(color_issues(&bw, 3), [ColorIssue::Threshold]);
        assert!(
            color_issues(
                &ColorForm {
                    threshold: 300,
                    ..Default::default()
                },
                3
            )
            .is_empty(),
            "chế độ khác không kiểm ngưỡng"
        );
        let ink = ColorForm {
            mode: ColorMode::InkSaver,
            amount: 1.5,
            ..Default::default()
        };
        assert_eq!(color_issues(&ink, 3), [ColorIssue::Amount]);
        let rc = ColorForm {
            mode: ColorMode::ReplaceColor,
            source_color: "red".into(),
            target_color: "#00".into(),
            tolerance: -1,
            ..Default::default()
        };
        assert_eq!(
            color_issues(&rc, 3),
            [
                ColorIssue::SourceColor,
                ColorIssue::TargetColor,
                ColorIssue::Tolerance
            ]
        );
        let pages = ColorForm {
            only_pages: true,
            pages_text: "9".into(),
            ..Default::default()
        };
        assert_eq!(color_issues(&pages, 3), [ColorIssue::Pages]);
        assert!(
            color_issues(
                &ColorForm {
                    only_pages: true,
                    pages_text: "2-3".into(),
                    ..Default::default()
                },
                3
            )
            .is_empty()
        );
    }

    #[test]
    fn params_only_for_the_chosen_mode() {
        assert_eq!(
            color_params(&ColorForm::default(), 3),
            json!({"mode":"gray"})
        );
        let bw = color_params(
            &ColorForm {
                mode: ColorMode::BlackWhite,
                dithering: true,
                only_pages: true,
                pages_text: "3,1".into(),
                ..Default::default()
            },
            3,
        );
        assert_eq!(
            (
                &bw["pages"],
                bw["threshold"].as_i64(),
                bw["dithering"].as_bool(),
                bw.get("amount")
            ),
            (&json!([2, 0]), Some(128), Some(true), None)
        );
        assert_eq!(
            color_params(
                &ColorForm {
                    mode: ColorMode::InkSaver,
                    ..Default::default()
                },
                3
            )["amount"],
            0.5
        );
        let rc = color_params(
            &ColorForm {
                mode: ColorMode::ReplaceColor,
                source_color: "#FF0000".into(),
                ..Default::default()
            },
            3,
        );
        assert_eq!(
            (
                rc["sourceColor"].as_str(),
                rc["targetColor"].as_str(),
                rc["tolerance"].as_i64(),
                rc.get("threshold")
            ),
            (Some("#ff0000"), Some("#000000"), Some(24), None)
        );
        assert_eq!(ColorMode::ALL.len(), 4);
    }

    #[test]
    fn report() {
        let r = read_color_report(
            &json!({"coloursChanged":5,"imagesChanged":2,"kept":{"b":1,"a":3,"c":0,"d":"x"}}),
        );
        assert_eq!(
            (r.colours_changed, r.images_changed, r.pages_changed, r.kept),
            (5, 2, 0, vec![("a".into(), 3), ("b".into(), 1)])
        );
        assert_eq!(read_color_report(&Value::Null).kept.len(), 0);
    }
}
