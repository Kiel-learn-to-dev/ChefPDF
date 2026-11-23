//! Đặt chữ ký theo chữ mốc và vị trí cố định (TASKS_RUST R6.20, FEATURES I26, I27): port
//! `anchorModel.ts`. Kích thước gõ bằng mm, gửi đi bằng pt. Logic thuần.
#![allow(dead_code)]

use serde_json::{Value, json};

pub const MAX_RECENT_ANCHORS: usize = 8;
const ANCHOR_TEXT_MAX: usize = 120;

pub fn mm_to_pt(mm: f64) -> f64 {
    mm * 72.0 / 25.4
}

fn round3(n: f64) -> f64 {
    (n * 1000.0).round() / 1000.0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Position {
    Below,
    Above,
    Right,
    Left,
    Over,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnMissing {
    Skip,
    Fail,
    FallbackFixed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhichMatch {
    First,
    Last,
    All,
}

impl Position {
    fn as_str(self) -> &'static str {
        match self {
            Position::Below => "below",
            Position::Above => "above",
            Position::Right => "right",
            Position::Left => "left",
            Position::Over => "over",
        }
    }
}
impl Align {
    fn as_str(self) -> &'static str {
        match self {
            Align::Left => "left",
            Align::Center => "center",
            Align::Right => "right",
        }
    }
}
impl OnMissing {
    fn as_str(self) -> &'static str {
        match self {
            OnMissing::Skip => "skip",
            OnMissing::Fail => "fail",
            OnMissing::FallbackFixed => "fallback-fixed",
        }
    }
}
impl WhichMatch {
    fn as_str(self) -> &'static str {
        match self {
            WhichMatch::First => "first",
            WhichMatch::Last => "last",
            WhichMatch::All => "all",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AnchorForm {
    pub text: String,
    pub position: Position,
    pub width_mm: f64,
    pub height_mm: f64,
    pub offset_x_pt: f64,
    pub offset_y_pt: f64,
    pub align: Align,
    pub ignore_diacritics: bool,
    pub which_match: WhichMatch,
    pub on_missing: OnMissing,
}

impl Default for AnchorForm {
    fn default() -> Self {
        Self {
            text: String::new(),
            position: Position::Below,
            width_mm: 50.0,
            height_mm: 20.0,
            offset_x_pt: 0.0,
            offset_y_pt: 0.0,
            align: Align::Center,
            ignore_diacritics: true,
            which_match: WhichMatch::First,
            on_missing: OnMissing::Skip,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormField {
    Text,
    WidthMm,
    HeightMm,
    OffsetXPt,
    OffsetYPt,
}

/// Bỏ dấu tiếng Việt (và dấu phụ Latin thường gặp), đ → d, chữ thường.
pub fn fold_diacritics(s: &str) -> String {
    const TABLE: [(&str, char); 17] = [
        ("àáảãạâầấẩẫậăằắẳẵặ", 'a'),
        ("èéẻẽẹêềếểễệ", 'e'),
        ("ìíỉĩị", 'i'),
        ("òóỏõọôồốổỗộơờớởỡợ", 'o'),
        ("ùúủũụưừứửữự", 'u'),
        ("ỳýỷỹỵ", 'y'),
        ("đ", 'd'),
        ("äå", 'a'),
        ("ë", 'e'),
        ("ï", 'i'),
        ("ö", 'o'),
        ("ü", 'u'),
        ("ç", 'c'),
        ("ñ", 'n'),
        ("ß", 's'),
        ("ÿ", 'y'),
        ("œ", 'o'),
    ];
    s.chars()
        .flat_map(|c| c.to_lowercase())
        .map(|c| {
            TABLE
                .iter()
                .find(|(set, _)| set.contains(c))
                .map_or(c, |(_, base)| *base)
        })
        .collect()
}

/// Khóa so sánh chữ mốc: không phân biệt hoa thường và dấu.
pub fn anchor_key(s: &str) -> String {
    fold_diacritics(s)
}

/// Danh sách chữ mốc gần đây, mới nhất đầu; hoa thường và dấu không tạo mục thứ hai.
pub fn remember_anchor(list: &[String], text: &str) -> Vec<String> {
    let clean: String = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(ANCHOR_TEXT_MAX)
        .collect();
    if clean.is_empty() {
        return list.to_vec();
    }
    let key = anchor_key(&clean);
    let mut out = vec![clean];
    out.extend(list.iter().filter(|t| anchor_key(t) != key).cloned());
    out.truncate(MAX_RECENT_ANCHORS);
    out
}

fn in_range(n: f64, min: f64, max: f64) -> bool {
    n.is_finite() && n >= min && n <= max
}

/// Lỗi đầu tiên của form, hoặc None. Khoảng giá trị khớp với lõi.
pub fn validate_anchor_form(f: &AnchorForm) -> Option<FormField> {
    if f.text.trim().is_empty() {
        Some(FormField::Text)
    } else if !in_range(f.width_mm, 2.0, 300.0) {
        Some(FormField::WidthMm)
    } else if !in_range(f.height_mm, 2.0, 300.0) {
        Some(FormField::HeightMm)
    } else if !in_range(f.offset_x_pt, -500.0, 500.0) {
        Some(FormField::OffsetXPt)
    } else if !in_range(f.offset_y_pt, -500.0, 500.0) {
        Some(FormField::OffsetYPt)
    } else {
        None
    }
}

/// Tham số `anchor` cho thao tác ký hàng loạt.
pub fn anchor_placement_params(f: &AnchorForm) -> Value {
    json!({
        "kind": "anchor",
        "text": f.text.trim(),
        "position": f.position.as_str(),
        "width": round3(mm_to_pt(f.width_mm)),
        "height": round3(mm_to_pt(f.height_mm)),
        "offsetX": f.offset_x_pt,
        "offsetY": f.offset_y_pt,
        "align": f.align.as_str(),
        "ignoreDiacritics": f.ignore_diacritics,
        "whichMatch": f.which_match.as_str(),
        "onMissing": f.on_missing.as_str(),
    })
}

/// Tham số `sign.placeFromAnchor`: `anchors` là (trang từ 0, hình chữ nhật) từ `sign.findAnchors`.
pub fn place_from_anchor_params(f: &AnchorForm, anchors: &[(u64, [f64; 4])]) -> Value {
    json!({
        "anchors": anchors.iter().map(|(p, r)| json!({"pageIndex": p, "rect": r})).collect::<Vec<_>>(),
        "width": round3(mm_to_pt(f.width_mm)),
        "height": round3(mm_to_pt(f.height_mm)),
        "position": f.position.as_str(),
        "offsetX": f.offset_x_pt,
        "offsetY": f.offset_y_pt,
        "align": f.align.as_str(),
        "clampToPage": true,
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Corner {
    TopLeft,
    TopRight,
    BottomLeft,
    BottomRight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FixedPage {
    First,
    Last,
    /// Trang cụ thể (số của lõi).
    Index(u64),
}

#[derive(Debug, Clone, PartialEq)]
pub struct FixedForm {
    pub corner: Corner,
    pub width_mm: f64,
    pub height_mm: f64,
    pub margin_pt: f64,
    pub page: FixedPage,
}

impl Default for FixedForm {
    fn default() -> Self {
        Self {
            corner: Corner::BottomRight,
            width_mm: 50.0,
            height_mm: 20.0,
            margin_pt: 36.0,
            page: FixedPage::Last,
        }
    }
}

pub fn validate_fixed_form(f: &FixedForm) -> Option<FormField> {
    if !in_range(f.width_mm, 2.0, 300.0) {
        Some(FormField::WidthMm)
    } else if !in_range(f.height_mm, 2.0, 300.0) {
        Some(FormField::HeightMm)
    } else if !in_range(f.margin_pt, 0.0, 300.0) {
        Some(FormField::OffsetXPt)
    } else {
        None
    }
}

pub fn fixed_placement_params(f: &FixedForm) -> Value {
    json!({
        "kind": "fixed",
        "corner": match f.corner {
            Corner::TopLeft => "top-left",
            Corner::TopRight => "top-right",
            Corner::BottomLeft => "bottom-left",
            Corner::BottomRight => "bottom-right",
        },
        "width": round3(mm_to_pt(f.width_mm)),
        "height": round3(mm_to_pt(f.height_mm)),
        "margin": f.margin_pt,
        "page": match f.page {
            FixedPage::First => json!("first"),
            FixedPage::Last => json!("last"),
            FixedPage::Index(n) => json!(n),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diacritics_fold_vietnamese() {
        assert_eq!(fold_diacritics("NGƯỜI KÝ"), "nguoi ky");
        assert_eq!(fold_diacritics("Giám đốc"), "giam doc");
        assert_eq!(fold_diacritics("Trưởng phòng"), "truong phong");
        assert_eq!(anchor_key("ĐẠI DIỆN"), anchor_key("dai dien"));
    }

    #[test]
    fn recent_anchors_dedupe_and_cap() {
        let l = remember_anchor(&[], "  Người   ký ");
        assert_eq!(l, ["Người ký"]);
        let l = remember_anchor(&l, "NGUOI KY");
        assert_eq!(l, ["NGUOI KY"]);
        let l = remember_anchor(&l, "   ");
        assert_eq!(l.len(), 1);
        let mut l = Vec::new();
        for i in 0..12 {
            l = remember_anchor(&l, &format!("mốc {i}"));
        }
        assert_eq!(l.len(), MAX_RECENT_ANCHORS);
        assert_eq!(l[0], "mốc 11");
    }

    #[test]
    fn validation_ranges() {
        let ok = AnchorForm {
            text: "Giám đốc".into(),
            ..Default::default()
        };
        assert_eq!(validate_anchor_form(&ok), None);
        assert_eq!(
            validate_anchor_form(&AnchorForm::default()),
            Some(FormField::Text)
        );
        let bad = AnchorForm {
            width_mm: 1.0,
            ..ok.clone()
        };
        assert_eq!(validate_anchor_form(&bad), Some(FormField::WidthMm));
        let bad = AnchorForm {
            offset_y_pt: 501.0,
            ..ok.clone()
        };
        assert_eq!(validate_anchor_form(&bad), Some(FormField::OffsetYPt));
        let bad = AnchorForm {
            height_mm: f64::NAN,
            ..ok
        };
        assert_eq!(validate_anchor_form(&bad), Some(FormField::HeightMm));
        assert_eq!(validate_fixed_form(&FixedForm::default()), None);
        assert_eq!(
            validate_fixed_form(&FixedForm {
                margin_pt: -1.0,
                ..Default::default()
            }),
            Some(FormField::OffsetXPt)
        );
    }

    #[test]
    fn params_use_points() {
        let f = AnchorForm {
            text: " Giám đốc ".into(),
            ..Default::default()
        };
        let v = anchor_placement_params(&f);
        assert_eq!(v["kind"], "anchor");
        assert_eq!(v["text"], "Giám đốc");
        assert_eq!(v["width"], 141.732);
        assert_eq!(v["onMissing"], "skip");
        let p = place_from_anchor_params(&f, &[(2, [10.0, 20.0, 30.0, 40.0])]);
        assert_eq!(p["anchors"][0]["pageIndex"], 2);
        assert_eq!(p["clampToPage"], true);
        let fx = fixed_placement_params(&FixedForm {
            page: FixedPage::Index(3),
            ..Default::default()
        });
        assert_eq!(
            (fx["corner"].as_str(), fx["page"].as_u64()),
            (Some("bottom-right"), Some(3))
        );
        assert_eq!(
            fixed_placement_params(&FixedForm::default())["page"],
            "last"
        );
    }
}
