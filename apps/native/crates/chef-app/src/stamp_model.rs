//! Con dấu chữ, con dấu ảnh và dấu giáp lai (TASKS_RUST R5.30, R5.31; FEATURES F2–F5): port
//! `stampModel.ts` và `seamModel.ts`. Form, kiểm, preset dựng sẵn, biến {date} {time} {user}, tham số
//! `stamp.text`/`stamp.image`/`stamp.seam` và kế hoạch dải giáp lai. Logic thuần.
#![allow(dead_code)]

use serde_json::{Map, Value, json};

use crate::overlay_common::{
    Anchor, FormCheck, LocalTime, PagesSel, Unit, in_range, is_hex_color, page_selection,
    selected_pages,
};

pub const MAX_STAMP_TEXT: usize = 200;
/// Biến chèn được vào chữ con dấu (nút chip).
pub const STAMP_CHIPS: [&str; 3] = ["date", "time", "user"];

#[derive(Debug, Clone, PartialEq)]
pub struct StampPreset {
    pub id: String,
    pub title: String,
    pub text: String,
    pub color: String,
    pub border_width: f64,
    pub bold: bool,
    pub font_size: f64,
}

/// Preset của `stamp.presets`; mục hỏng bị bỏ.
pub fn read_stamp_presets(data: &Value) -> Vec<StampPreset> {
    data.get("presets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|o| {
            let s = |k: &str| o.get(k).and_then(Value::as_str).map(String::from);
            Some(StampPreset {
                id: s("id")?,
                title: s("title")?,
                text: s("text")?,
                color: s("color").unwrap_or_else(|| "#C00000".into()),
                border_width: o.get("borderWidth").and_then(Value::as_f64).unwrap_or(2.0),
                bold: o.get("bold").and_then(Value::as_bool) == Some(true),
                font_size: o.get("fontSize").and_then(Value::as_f64).unwrap_or(24.0),
            })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextStampForm {
    pub text: String,
    pub color: String,
    pub border_width: f64,
    pub font_size: f64,
    pub bold: bool,
    pub rotation: f64,
    pub opacity: f64,
    pub blend_multiply: bool,
    pub x: f64,
    pub y: f64,
    pub unit: Unit,
    pub anchor: Anchor,
    pub pages: PagesSel,
}

impl Default for TextStampForm {
    fn default() -> Self {
        Self {
            text: "ĐÃ DUYỆT".into(),
            color: "#C00000".into(),
            border_width: 2.0,
            font_size: 24.0,
            bold: true,
            rotation: 0.0,
            opacity: 1.0,
            blend_multiply: false,
            x: 20.0,
            y: 20.0,
            unit: Unit::Mm,
            anchor: Anchor::TopLeft,
            pages: PagesSel::default(),
        }
    }
}

/// Giao diện của preset; vị trí và trang giữ nguyên.
pub fn preset_form(form: &TextStampForm, p: &StampPreset) -> TextStampForm {
    TextStampForm {
        text: p.text.clone(),
        color: p.color.clone(),
        border_width: p.border_width,
        bold: p.bold,
        font_size: p.font_size,
        ..form.clone()
    }
}

/// Thêm biến vào cuối chữ, cách một khoảng trắng nếu cần.
pub fn with_chip(text: &str, chip: &str) -> String {
    let sep = if text.is_empty() || text.ends_with(char::is_whitespace) {
        ""
    } else {
        " "
    };
    format!("{text}{sep}{{{chip}}}")
}

/// Chữ với biến đã điền như lõi sẽ ghi (chỉ để xem trước).
pub fn resolve_stamp_text(text: &str, now: LocalTime, user: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(i) = rest.find('{') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let replaced = [
            ("{date}", now.date()),
            ("{time}", now.time()),
            ("{datetime}", format!("{} {}", now.date(), now.time())),
            ("{user}", user.to_string()),
        ]
        .into_iter()
        .find(|(k, _)| tail.starts_with(k));
        match replaced {
            Some((k, v)) => {
                out.push_str(&v);
                rest = &tail[k.len()..];
            }
            None => {
                out.push('{');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn common_checks(
    rotation: f64,
    opacity: f64,
    x: f64,
    y: f64,
    pages: &PagesSel,
    page_count: usize,
    current: usize,
) -> FormCheck {
    if !in_range(rotation, -360.0, 360.0) {
        return Err("rotation");
    }
    if !in_range(opacity, 0.0, 1.0) {
        return Err("opacity");
    }
    if !in_range(x, -10_000.0, 10_000.0) || !in_range(y, -10_000.0, 10_000.0) {
        return Err("position");
    }
    page_selection(pages, current, page_count)
        .map(|_| ())
        .map_err(|_| "pages")
}

pub fn check_text_stamp(f: &TextStampForm, page_count: usize, current: usize) -> FormCheck {
    if f.text.trim().is_empty() || f.text.encode_utf16().count() > MAX_STAMP_TEXT {
        return Err("text");
    }
    if !is_hex_color(&f.color) {
        return Err("color");
    }
    if !in_range(f.font_size, 4.0, 120.0) {
        return Err("fontSize");
    }
    if !in_range(f.border_width, 0.0, 20.0) {
        return Err("borderWidth");
    }
    common_checks(
        f.rotation, f.opacity, f.x, f.y, &f.pages, page_count, current,
    )
}

/// `stamp.text`; biến giữ nguyên trong chữ, lõi điền.
pub fn text_stamp_params(
    f: &TextStampForm,
    current: usize,
    page_count: usize,
    user: &str,
) -> Value {
    let mut m: Map<String, Value> = match json!({
        "x": f.x, "y": f.y, "unit": f.unit.as_str(), "anchor": f.anchor.as_str(),
        "rotation": f.rotation, "opacity": f.opacity, "text": f.text, "fontSize": f.font_size,
        "bold": f.bold, "color": f.color, "borderWidth": f.border_width,
        "blendMultiply": f.blend_multiply, "user": user,
    }) {
        Value::Object(m) => m,
        _ => unreachable!(),
    };
    m.extend(page_selection(&f.pages, current, page_count).unwrap_or_default());
    Value::Object(m)
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImageStampForm {
    /// Đường dẫn tuyệt đối PNG/JPEG (từ thư viện hoặc file). Không lưu vào cài đặt.
    pub path: String,
    pub width: f64,
    pub rotation: f64,
    pub opacity: f64,
    /// Mặc định bật: mực con dấu làm tối phần bên dưới.
    pub blend_multiply: bool,
    pub x: f64,
    pub y: f64,
    pub unit: Unit,
    pub anchor: Anchor,
    pub pages: PagesSel,
}

impl Default for ImageStampForm {
    fn default() -> Self {
        Self {
            path: String::new(),
            width: 40.0,
            rotation: 0.0,
            opacity: 1.0,
            blend_multiply: true,
            x: 20.0,
            y: 20.0,
            unit: Unit::Mm,
            anchor: Anchor::TopLeft,
            pages: PagesSel::default(),
        }
    }
}

pub fn check_image_stamp(f: &ImageStampForm, page_count: usize, current: usize) -> FormCheck {
    if f.path.trim().is_empty() {
        return Err("path");
    }
    if !in_range(f.width, 1.0, 2000.0) {
        return Err("width");
    }
    common_checks(
        f.rotation, f.opacity, f.x, f.y, &f.pages, page_count, current,
    )
}

pub fn image_stamp_params(f: &ImageStampForm, current: usize, page_count: usize) -> Value {
    let mut m = json!({
        "x": f.x, "y": f.y, "unit": f.unit.as_str(), "anchor": f.anchor.as_str(),
        "rotation": f.rotation, "opacity": f.opacity, "path": f.path, "width": f.width,
        "blendMultiply": f.blend_multiply,
    });
    m.as_object_mut()
        .expect("object")
        .extend(page_selection(&f.pages, current, page_count).unwrap_or_default());
    m
}

// ---- Dấu giáp lai (seam) ----

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SeamVertical {
    Center,
    Top,
    Bottom,
    /// Khoảng cách từ mép trên (mm).
    Mm(f64),
}

#[derive(Debug, Clone, PartialEq)]
pub struct SeamForm {
    pub path: String,
    /// "right" hoặc "left".
    pub side: &'static str,
    /// Số trang mỗi bộ; 0 = một bộ cho mọi trang đã chọn.
    pub group_size: u32,
    pub cut_first_page: bool,
    pub vertical: SeamVertical,
    pub overlap_mm: f64,
    /// Bề rộng cả con dấu qua mọi dải; 0 = cỡ tự nhiên.
    pub scale_width_mm: f64,
    pub opacity: f64,
    pub blend_multiply: bool,
    pub pages: PagesSel,
}

impl Default for SeamForm {
    fn default() -> Self {
        Self {
            path: String::new(),
            side: "right",
            group_size: 0,
            cut_first_page: true,
            vertical: SeamVertical::Center,
            overlap_mm: 0.0,
            scale_width_mm: 30.0,
            opacity: 1.0,
            blend_multiply: true,
            pages: PagesSel {
                choice: crate::overlay_common::PagesChoice::All,
                range: String::new(),
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeamSlot {
    /// Trang (từ 0) nhận dải.
    pub page: usize,
    /// Số thứ tự dải trong bộ (từ 0).
    pub strip: usize,
    /// Số dải trong bộ đó.
    pub of: usize,
    /// Bộ thứ mấy (từ 0).
    pub set: usize,
}

/// Các dải lõi sẽ đặt: trang chọn chia thành bộ `group_size` (0 = một bộ); mỗi bộ bỏ trang đầu khi
/// `cut_first_page` sai. Khớp `stamp.seam`.
pub fn seam_plan(pages: &[usize], group_size: u32, cut_first_page: bool) -> Vec<SeamSlot> {
    let sets: Vec<&[usize]> = if group_size == 0 {
        vec![pages]
    } else {
        pages.chunks(group_size as usize).collect()
    };
    sets.iter()
        .enumerate()
        .flat_map(|(set, group)| {
            let targets: &[usize] = if cut_first_page {
                group
            } else {
                group.get(1..).unwrap_or(&[])
            };
            targets
                .iter()
                .enumerate()
                .map(move |(strip, &page)| SeamSlot {
                    page,
                    strip,
                    of: targets.len(),
                    set,
                })
        })
        .collect()
}

/// Số dải của bộ đầu tiên (cho sơ đồ).
pub fn seam_slice_count(plan: &[SeamSlot]) -> usize {
    plan.first().map_or(0, |s| s.of)
}

pub fn check_seam_form(f: &SeamForm, page_count: usize, current: usize) -> FormCheck {
    if f.path.trim().is_empty() {
        return Err("path");
    }
    if f.group_size > 10_000 {
        return Err("groupSize");
    }
    if !in_range(f.overlap_mm, 0.0, 50.0) {
        return Err("overlapMm");
    }
    if !in_range(f.scale_width_mm, 0.0, 1000.0) {
        return Err("scaleWidthMm");
    }
    if let SeamVertical::Mm(v) = f.vertical {
        if !in_range(v, 0.0, 10_000.0) {
            return Err("verticalMm");
        }
    }
    if !in_range(f.opacity, 0.0, 1.0) {
        return Err("opacity");
    }
    page_selection(&f.pages, current, page_count).map_err(|_| "pages")?;
    let plan = seam_plan(
        &selected_pages(&f.pages, current, page_count),
        f.group_size,
        f.cut_first_page,
    );
    if plan.is_empty() {
        Err("cutFirstPage")
    } else {
        Ok(())
    }
}

/// `stamp.seam`.
pub fn seam_params(f: &SeamForm, current: usize, page_count: usize) -> Value {
    let mut m = json!({
        "path": f.path, "side": f.side, "sliceMode": "even", "cutFirstPage": f.cut_first_page,
        "vertical": match f.vertical {
            SeamVertical::Center => json!("center"),
            SeamVertical::Top => json!("top"),
            SeamVertical::Bottom => json!("bottom"),
            SeamVertical::Mm(v) => json!(v),
        },
        "overlapMm": f.overlap_mm, "opacity": f.opacity, "blendMultiply": f.blend_multiply,
    });
    let o = m.as_object_mut().expect("object");
    if f.group_size > 0 {
        o.insert("groupSize".into(), f.group_size.into());
    }
    if f.scale_width_mm > 0.0 {
        o.insert("scaleWidthMm".into(), f.scale_width_mm.into());
    }
    o.extend(page_selection(&f.pages, current, page_count).unwrap_or_default());
    m
}

/// Tóm tắt các dải lõi trả về (`data.strips`, dải đánh số từ 1): số dải, số bộ (mỗi bộ bắt đầu ở
/// dải 1) và số trang có dải.
pub fn summarize_seam(strips: &[(u64, u64)]) -> (usize, usize, usize) {
    let pages: std::collections::HashSet<u64> = strips.iter().map(|s| s.0).collect();
    (
        strips.len(),
        strips.iter().filter(|s| s.1 == 1).count(),
        pages.len(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overlay_common::PagesChoice;

    fn now() -> LocalTime {
        LocalTime {
            year: 2026,
            month: 11,
            day: 3,
            hour: 8,
            minute: 5,
        }
    }

    #[test]
    fn presets_chips_and_variables() {
        let p = read_stamp_presets(&json!({"presets":[
            {"id":"a","title":"Đã duyệt","text":"ĐÃ DUYỆT","bold":true},
            {"id":"b","title":"x"}, 5]}));
        assert_eq!(p.len(), 1);
        assert_eq!(
            (
                p[0].color.as_str(),
                p[0].border_width,
                p[0].font_size,
                p[0].bold
            ),
            ("#C00000", 2.0, 24.0, true)
        );
        let f = preset_form(
            &TextStampForm {
                x: 5.0,
                ..Default::default()
            },
            &p[0],
        );
        assert_eq!((f.x, f.text.as_str()), (5.0, "ĐÃ DUYỆT"));
        assert_eq!(with_chip("", "date"), "{date}");
        assert_eq!(with_chip("Ngày", "date"), "Ngày {date}");
        assert_eq!(with_chip("Ngày ", "user"), "Ngày {user}");
        assert_eq!(
            resolve_stamp_text("{date} {time} / {user} {datetime} {x} {", now(), "An"),
            "03/11/2026 08:05 / An 03/11/2026 08:05 {x} {"
        );
    }

    #[test]
    fn text_stamp_checks_and_params() {
        let ok = TextStampForm::default();
        assert_eq!(check_text_stamp(&ok, 5, 0), Ok(()));
        let cases: [(TextStampForm, &str); 7] = [
            (
                TextStampForm {
                    text: " ".into(),
                    ..ok.clone()
                },
                "text",
            ),
            (
                TextStampForm {
                    text: "a".repeat(201),
                    ..ok.clone()
                },
                "text",
            ),
            (
                TextStampForm {
                    color: "red".into(),
                    ..ok.clone()
                },
                "color",
            ),
            (
                TextStampForm {
                    font_size: 3.0,
                    ..ok.clone()
                },
                "fontSize",
            ),
            (
                TextStampForm {
                    border_width: 21.0,
                    ..ok.clone()
                },
                "borderWidth",
            ),
            (
                TextStampForm {
                    opacity: 1.5,
                    ..ok.clone()
                },
                "opacity",
            ),
            (
                TextStampForm {
                    pages: PagesSel {
                        choice: PagesChoice::Range,
                        range: "x".into(),
                    },
                    ..ok.clone()
                },
                "pages",
            ),
        ];
        for (f, field) in cases {
            assert_eq!(check_text_stamp(&f, 5, 0), Err(field));
        }
        let v = text_stamp_params(&ok, 2, 5, "An");
        assert_eq!(
            (
                &v["pages"],
                v["user"].as_str(),
                v["unit"].as_str(),
                v["anchor"].as_str()
            ),
            (&json!([2]), Some("An"), Some("mm"), Some("top-left"))
        );
        let all = TextStampForm {
            pages: PagesSel {
                choice: PagesChoice::All,
                range: String::new(),
            },
            ..ok
        };
        assert!(text_stamp_params(&all, 2, 5, "An").get("pages").is_none());
    }

    #[test]
    fn image_stamp() {
        let ok = ImageStampForm {
            path: "/s.png".into(),
            ..Default::default()
        };
        assert_eq!(check_image_stamp(&ok, 5, 0), Ok(()));
        assert_eq!(
            check_image_stamp(&ImageStampForm::default(), 5, 0),
            Err("path")
        );
        assert_eq!(
            check_image_stamp(
                &ImageStampForm {
                    width: 0.5,
                    ..ok.clone()
                },
                5,
                0
            ),
            Err("width")
        );
        assert_eq!(
            check_image_stamp(
                &ImageStampForm {
                    x: 1e9,
                    ..ok.clone()
                },
                5,
                0
            ),
            Err("position")
        );
        let v = image_stamp_params(&ok, 0, 5);
        assert_eq!(
            (
                v["blendMultiply"].as_bool(),
                v["width"].as_f64(),
                &v["pages"]
            ),
            (Some(true), Some(40.0), &json!([0]))
        );
    }

    #[test]
    fn seam_plan_matches_core() {
        assert_eq!(
            seam_plan(&[0, 1, 2, 3], 0, true)
                .iter()
                .map(|s| (s.page, s.strip, s.of, s.set))
                .collect::<Vec<_>>(),
            [(0, 0, 4, 0), (1, 1, 4, 0), (2, 2, 4, 0), (3, 3, 4, 0)]
        );
        let skip = seam_plan(&[0, 1, 2, 3, 4], 2, false);
        assert_eq!(
            skip.iter()
                .map(|s| (s.page, s.set, s.of))
                .collect::<Vec<_>>(),
            [(1, 0, 1), (3, 1, 1)],
            "bộ cuối chỉ một trang bị bỏ hết"
        );
        assert_eq!(seam_slice_count(&seam_plan(&[0, 1, 2], 0, true)), 3);
        assert_eq!(seam_slice_count(&[]), 0);
        assert!(seam_plan(&[], 0, true).is_empty());
        assert_eq!(summarize_seam(&[(0, 1), (1, 2), (2, 1), (3, 2)]), (4, 2, 4));
    }

    #[test]
    fn seam_form_checks_and_params() {
        let ok = SeamForm {
            path: "/seal.png".into(),
            ..Default::default()
        };
        assert_eq!(check_seam_form(&ok, 6, 0), Ok(()));
        assert_eq!(check_seam_form(&SeamForm::default(), 6, 0), Err("path"));
        assert_eq!(
            check_seam_form(
                &SeamForm {
                    overlap_mm: 51.0,
                    ..ok.clone()
                },
                6,
                0
            ),
            Err("overlapMm")
        );
        assert_eq!(
            check_seam_form(
                &SeamForm {
                    vertical: SeamVertical::Mm(-1.0),
                    ..ok.clone()
                },
                6,
                0
            ),
            Err("verticalMm")
        );
        // một trang, bỏ trang đầu: không còn dải nào
        let one = SeamForm {
            cut_first_page: false,
            pages: PagesSel {
                choice: PagesChoice::Current,
                range: String::new(),
            },
            ..ok.clone()
        };
        assert_eq!(check_seam_form(&one, 6, 0), Err("cutFirstPage"));
        let v = seam_params(
            &SeamForm {
                group_size: 2,
                vertical: SeamVertical::Mm(12.5),
                scale_width_mm: 0.0,
                ..ok.clone()
            },
            0,
            6,
        );
        assert_eq!(
            (
                v["groupSize"].as_u64(),
                v["vertical"].as_f64(),
                v.get("scaleWidthMm"),
                v.get("pages")
            ),
            (Some(2), Some(12.5), None, None)
        );
        let c = seam_params(&ok, 0, 6);
        assert_eq!(
            (
                c["vertical"].as_str(),
                c["scaleWidthMm"].as_f64(),
                c.get("groupSize"),
                c["sliceMode"].as_str()
            ),
            (Some("center"), Some(30.0), None, Some("even"))
        );
    }
}
