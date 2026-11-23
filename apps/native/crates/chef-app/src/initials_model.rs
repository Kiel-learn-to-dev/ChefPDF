//! Chữ ký nháy mọi trang (TASKS_RUST R5.33, FEATURES F6): port `initialsModel.ts`. Chữ hoặc ảnh, một
//! trong chín vị trí, lề, cỡ, trang áp dụng, tham số `stamp.initials`. Logic thuần.
#![allow(dead_code)]

use serde_json::{Value, json};

use crate::overlay_common::{
    FormCheck, PagesChoice, PagesSel, in_range, is_hex_color, page_selection,
};

/// Chín vị trí, từng hàng (trên xuống dưới, trái sang phải).
pub const INITIALS_POSITIONS: [&str; 9] = [
    "top-left",
    "top-center",
    "top-right",
    "center-left",
    "center",
    "center-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
];

pub const MAX_INITIALS_TEXT: usize = 40;

#[derive(Debug, Clone, PartialEq)]
pub struct InitialsForm {
    /// `false` = chữ, `true` = ảnh.
    pub image: bool,
    pub text: String,
    /// Đường dẫn tuyệt đối ảnh chữ ký nháy. Không lưu vào tùy chọn.
    pub path: String,
    pub position: &'static str,
    pub margin_mm: f64,
    /// Bề rộng ảnh (chỉ ảnh).
    pub width_mm: f64,
    /// Cỡ chữ (chỉ chữ).
    pub font_size: f64,
    pub bold: bool,
    pub color: String,
    pub opacity: f64,
    pub blend_multiply: bool,
    pub pages: PagesSel,
}

impl Default for InitialsForm {
    fn default() -> Self {
        Self {
            image: false,
            text: "KN".into(),
            path: String::new(),
            position: "bottom-right",
            margin_mm: 10.0,
            width_mm: 25.0,
            font_size: 14.0,
            bold: false,
            color: "#1F4E9A".into(),
            opacity: 1.0,
            blend_multiply: false,
            pages: PagesSel {
                choice: PagesChoice::All,
                range: String::new(),
            },
        }
    }
}

pub fn check_initials(f: &InitialsForm, page_count: usize, current: usize) -> FormCheck {
    if f.image {
        if f.path.trim().is_empty() {
            return Err("path");
        }
        if !in_range(f.width_mm, 1.0, 500.0) {
            return Err("widthMm");
        }
    } else {
        if f.text.trim().is_empty() || f.text.encode_utf16().count() > MAX_INITIALS_TEXT {
            return Err("text");
        }
        if !in_range(f.font_size, 4.0, 120.0) {
            return Err("fontSize");
        }
    }
    if !in_range(f.margin_mm, 0.0, 100.0) {
        return Err("marginMm");
    }
    if !is_hex_color(&f.color) {
        return Err("color");
    }
    if !in_range(f.opacity, 0.0, 1.0) {
        return Err("opacity");
    }
    page_selection(&f.pages, current, page_count)
        .map(|_| ())
        .map_err(|_| "pages")
}

/// `stamp.initials`. Chỉ gửi nội dung của loại đang chọn.
pub fn initials_params(f: &InitialsForm, current: usize, page_count: usize) -> Value {
    let mut v = json!({"position": f.position, "marginMm": f.margin_mm, "opacity": f.opacity, "blendMultiply": f.blend_multiply});
    let o = v.as_object_mut().expect("object");
    if f.image {
        o.insert("path".into(), f.path.clone().into());
        o.insert("widthMm".into(), f.width_mm.into());
    } else {
        o.insert("text".into(), f.text.clone().into());
        o.insert("fontSize".into(), f.font_size.into());
        o.insert("bold".into(), f.bold.into());
        o.insert("color".into(), f.color.clone().into());
    }
    o.extend(page_selection(&f.pages, current, page_count).unwrap_or_default());
    v
}

/// Vị trí trên trang theo tỉ lệ 0..1 của rộng và cao (chỉ để xem trước).
pub fn position_fraction(position: &str) -> (f64, f64) {
    if position == "center" {
        return (0.5, 0.5);
    }
    let (v, h) = position.split_once('-').unwrap_or((position, "center"));
    let x = match h {
        "left" => 0.1,
        "right" => 0.9,
        _ => 0.5,
    };
    let y = match v {
        "top" => 0.1,
        "bottom" => 0.9,
        _ => 0.5,
    };
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks() {
        let ok = InitialsForm::default();
        assert_eq!(check_initials(&ok, 5, 0), Ok(()));
        assert_eq!(
            check_initials(
                &InitialsForm {
                    text: " ".into(),
                    ..ok.clone()
                },
                5,
                0
            ),
            Err("text")
        );
        assert_eq!(
            check_initials(
                &InitialsForm {
                    text: "x".repeat(41),
                    ..ok.clone()
                },
                5,
                0
            ),
            Err("text")
        );
        assert_eq!(
            check_initials(
                &InitialsForm {
                    font_size: 3.0,
                    ..ok.clone()
                },
                5,
                0
            ),
            Err("fontSize")
        );
        assert_eq!(
            check_initials(
                &InitialsForm {
                    image: true,
                    ..ok.clone()
                },
                5,
                0
            ),
            Err("path")
        );
        assert_eq!(
            check_initials(
                &InitialsForm {
                    image: true,
                    path: "/k.png".into(),
                    width_mm: 0.0,
                    ..ok.clone()
                },
                5,
                0
            ),
            Err("widthMm")
        );
        assert_eq!(
            check_initials(
                &InitialsForm {
                    image: true,
                    path: "/k.png".into(),
                    font_size: 1.0,
                    text: String::new(),
                    ..ok.clone()
                },
                5,
                0
            ),
            Ok(()),
            "ảnh không kiểm chữ"
        );
        assert_eq!(
            check_initials(
                &InitialsForm {
                    margin_mm: 101.0,
                    ..ok.clone()
                },
                5,
                0
            ),
            Err("marginMm")
        );
        assert_eq!(
            check_initials(
                &InitialsForm {
                    color: "blue".into(),
                    ..ok.clone()
                },
                5,
                0
            ),
            Err("color")
        );
        assert_eq!(
            check_initials(
                &InitialsForm {
                    opacity: 1.1,
                    ..ok.clone()
                },
                5,
                0
            ),
            Err("opacity")
        );
        assert_eq!(
            check_initials(
                &InitialsForm {
                    pages: PagesSel {
                        choice: PagesChoice::Range,
                        range: "9".into()
                    },
                    ..ok
                },
                5,
                0
            ),
            Err("pages")
        );
    }

    #[test]
    fn params_only_for_the_active_kind() {
        let t = initials_params(&InitialsForm::default(), 0, 5);
        assert_eq!(
            (
                t["text"].as_str(),
                t["color"].as_str(),
                t.get("path"),
                t.get("pages"),
                t["position"].as_str()
            ),
            (
                Some("KN"),
                Some("#1F4E9A"),
                None,
                None,
                Some("bottom-right")
            )
        );
        let i = initials_params(
            &InitialsForm {
                image: true,
                path: "/k.png".into(),
                pages: PagesSel {
                    choice: PagesChoice::Odd,
                    range: String::new(),
                },
                ..Default::default()
            },
            0,
            5,
        );
        assert_eq!(
            (
                i["path"].as_str(),
                i["widthMm"].as_f64(),
                i.get("text"),
                i.get("color"),
                i["pageRange"].as_str()
            ),
            (Some("/k.png"), Some(25.0), None, None, Some("odd"))
        );
    }

    #[test]
    fn preview_positions() {
        assert_eq!(INITIALS_POSITIONS.len(), 9);
        assert_eq!(position_fraction("top-left"), (0.1, 0.1));
        assert_eq!(position_fraction("center-right"), (0.9, 0.5));
        assert_eq!(position_fraction("bottom-center"), (0.5, 0.9));
        assert_eq!(position_fraction("center"), (0.5, 0.5));
        for p in INITIALS_POSITIONS {
            let (x, y) = position_fraction(p);
            assert!((0.0..=1.0).contains(&x) && (0.0..=1.0).contains(&y), "{p}");
        }
    }
}
