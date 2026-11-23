//! Mô hình form "Chuyển thành bản scan" (TASKS_RUST R5.23, R5.26, R5.27; FEATURES K1–K10): chuyển
//! từ `apps/ui/src/features/scan/scanModel.ts` sang Rust. Chỉ là logic thuần: trạng thái form ↔ tham
//! số `scan.rasterize`/`scan.preview`/`scan.fitSize`, preset, kiểm tên, đổi lỗi/cảnh báo của lõi.
#![allow(dead_code)]

use serde_json::{Map, Value, json};

pub const DPI_CHOICES: [u32; 4] = [150, 200, 300, 600];
pub const DPI_MIN: u32 = 72;
pub const DPI_MAX: u32 = 1200;
pub const MAX_PRESET_NAME: usize = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Color {
    Color,
    Gray,
    Bw,
}

impl Color {
    pub fn as_str(self) -> &'static str {
        match self {
            Color::Color => "color",
            Color::Gray => "gray",
            Color::Bw => "bw",
        }
    }
    fn parse(s: &str) -> Option<Self> {
        match s {
            "color" => Some(Color::Color),
            "gray" => Some(Color::Gray),
            "bw" => Some(Color::Bw),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Effects {
    None,
    Light,
    Photocopy,
    OldPaper,
}

impl Effects {
    pub fn as_str(self) -> &'static str {
        match self {
            Effects::None => "none",
            Effects::Light => "light",
            Effects::Photocopy => "photocopy",
            Effects::OldPaper => "old-paper",
        }
    }
    fn parse(s: &str) -> Option<Self> {
        match s {
            "none" => Some(Effects::None),
            "light" => Some(Effects::Light),
            "photocopy" => Some(Effects::Photocopy),
            "old-paper" => Some(Effects::OldPaper),
            _ => None,
        }
    }
}

/// Trạng thái form. `pages_text` tính từ 1 ("1-3,5"); rỗng là mọi trang.
#[derive(Debug, Clone, PartialEq)]
pub struct ScanForm {
    pub dpi: i64,
    pub color: Color,
    pub jpeg_quality: i64,
    pub threshold: i64,
    pub dithering: bool,
    pub pages_text: String,
    pub strip_metadata: bool,
    pub effects: Effects,
    pub seed: i64,
}

impl Default for ScanForm {
    fn default() -> Self {
        Self {
            dpi: 200,
            color: Color::Gray,
            jpeg_quality: 75,
            threshold: 128,
            dithering: false,
            pages_text: String::new(),
            strip_metadata: true,
            effects: Effects::None,
            seed: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Field {
    Dpi,
    JpegQuality,
    Threshold,
    Seed,
    Pages,
}

/// "1-3,5" (từ 1) thành các chỉ số từ 0, đã sắp và bỏ trùng. None khi sai dạng hoặc ngoài phạm vi.
pub fn parse_pages(text: &str, page_count: usize) -> Option<Vec<u64>> {
    let mut p: Vec<u64> = crate::page_range::parse(text, page_count)
        .ok()?
        .pages
        .into_iter()
        .map(|n| n as u64)
        .collect();
    p.sort_unstable();
    Some(p)
}

/// Các trường có giá trị lõi không nhận được.
pub fn form_issues(form: &ScanForm, page_count: usize) -> Vec<Field> {
    let mut issues = Vec::new();
    if !(DPI_MIN as i64..=DPI_MAX as i64).contains(&form.dpi) {
        issues.push(Field::Dpi);
    }
    if !(1..=100).contains(&form.jpeg_quality) {
        issues.push(Field::JpegQuality);
    }
    if !(0..=255).contains(&form.threshold) {
        issues.push(Field::Threshold);
    }
    if form.seed < 0 {
        issues.push(Field::Seed);
    }
    if !form.pages_text.trim().is_empty() && parse_pages(&form.pages_text, page_count).is_none() {
        issues.push(Field::Pages);
    }
    issues
}

/// Tham số `scan.rasterize` (cũng dùng cho `scan.preview`, `scan.fitSize`); None khi form sai.
pub fn build_params(form: &ScanForm, page_count: usize) -> Option<Value> {
    if !form_issues(form, page_count).is_empty() {
        return None;
    }
    let mut v = json!({
        "dpi": form.dpi,
        "color": form.color.as_str(),
        "jpegQuality": form.jpeg_quality,
        "threshold": form.threshold,
        "dithering": form.dithering,
        "stripMetadata": form.strip_metadata,
        "effectsPreset": form.effects.as_str(),
        "seed": form.seed,
    });
    if !form.pages_text.trim().is_empty() {
        v["pages"] = json!(parse_pages(&form.pages_text, page_count)?);
    }
    Some(v)
}

/// Áp tham số lõi lên `base`. Khóa vắng giữ giá trị cũ; `pages: null` là mọi trang.
pub fn apply_params(base: &ScanForm, params: &Value) -> ScanForm {
    let mut f = base.clone();
    let Some(p) = params.as_object() else {
        return f;
    };
    let int = |k: &str| p.get(k).and_then(Value::as_f64).filter(|n| n.is_finite());
    if let Some(n) = int("dpi") {
        f.dpi = n as i64;
    }
    if let Some(c) = p
        .get("color")
        .and_then(Value::as_str)
        .and_then(Color::parse)
    {
        f.color = c;
    }
    if let Some(n) = int("jpegQuality") {
        f.jpeg_quality = n as i64;
    }
    if let Some(n) = int("threshold") {
        f.threshold = n as i64;
    }
    if let Some(b) = p.get("dithering").and_then(Value::as_bool) {
        f.dithering = b;
    }
    if let Some(b) = p.get("stripMetadata").and_then(Value::as_bool) {
        f.strip_metadata = b;
    }
    if let Some(e) = p.get("effectsPreset") {
        f.effects = match e {
            Value::Null => Effects::None,
            Value::String(s) => Effects::parse(s).unwrap_or(base.effects),
            _ => base.effects,
        };
    }
    if let Some(n) = int("seed") {
        f.seed = n as i64;
    }
    if let Some(pages) = p.get("pages") {
        f.pages_text = match pages.as_array() {
            Some(items) => {
                let idx: Vec<usize> = items
                    .iter()
                    .filter_map(Value::as_u64)
                    .map(|n| n as usize)
                    .collect();
                crate::page_ops::format_page_ranges(&idx)
            }
            None => String::new(),
        };
    }
    f
}

/// Tùy chọn một preset người dùng lưu: tham số không kèm trang (trang thuộc về tài liệu).
pub fn preset_params_of(form: &ScanForm, page_count: usize) -> Option<Map<String, Value>> {
    let cleared = ScanForm {
        pages_text: String::new(),
        ..form.clone()
    };
    let mut v = build_params(&cleared, page_count)?;
    v.as_object_mut()?.remove("pages");
    match v {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresetNameIssue {
    Empty,
    TooLong,
    Duplicate,
}

/// Tên đã cắt khoảng trắng, không rỗng, ≤ 60 ký tự, không trùng (không phân biệt hoa thường).
pub fn validate_preset_name(raw: &str, taken: &[&str]) -> Result<String, PresetNameIssue> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(PresetNameIssue::Empty);
    }
    if name.chars().count() > MAX_PRESET_NAME {
        return Err(PresetNameIssue::TooLong);
    }
    let lower = name.to_lowercase();
    if taken.iter().any(|t| t.trim().to_lowercase() == lower) {
        return Err(PresetNameIssue::Duplicate);
    }
    Ok(name.to_string())
}

/// DPI lớn nhất cho phép khi lõi báo lỗi giới hạn dpi (`detail.field = "dpi"`, `detail.maxDpi`).
pub fn dpi_limit_from_error(kind: &str, detail: &Value) -> Option<u32> {
    if kind != "INVALID_PARAMS" || detail.get("field")?.as_str()? != "dpi" {
        return None;
    }
    let max = detail.get("maxDpi")?.as_f64()?;
    (max >= DPI_MIN as f64).then(|| max.floor() as u32)
}

/// Khóa chuỗi giao diện cho cảnh báo mất dữ liệu mà lõi viết bằng tiếng Anh.
pub fn warning_key(message: &str) -> Option<&'static str> {
    match message {
        "Text will be lost: converted pages become images without text." => Some("scan.warn.text"),
        "Links will be lost." => Some("scan.warn.links"),
        "Bookmarks will be lost." => Some("scan.warn.bookmarks"),
        "Form fields will be lost." => Some("scan.warn.forms"),
        "Digital signatures will be lost." => Some("scan.warn.signatures"),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DurationUnit {
    Seconds,
    Minutes,
}

/// Dưới một phút tính bằng giây (tối thiểu 1), còn lại tính bằng phút.
pub fn duration_parts(seconds: f64) -> (DurationUnit, u64) {
    if seconds < 60.0 {
        (DurationUnit::Seconds, seconds.round().max(1.0) as u64)
    } else {
        (DurationUnit::Minutes, (seconds / 60.0).round() as u64)
    }
}

/// Dung lượng đích gõ bằng MB ("2,5" được), đổi ra byte; None nếu không phải số dương.
pub fn parse_megabytes(text: &str) -> Option<u64> {
    let mb: f64 = text.replace(',', ".").trim().parse().ok()?;
    (mb.is_finite() && mb > 0.0).then(|| (mb * 1024.0 * 1024.0).round() as u64)
}

/// Kết quả `scan.fitSize`: tham số đã dò và có đạt giới hạn không.
#[derive(Debug, Clone, PartialEq)]
pub struct FitResult {
    pub params: Value,
    pub estimated_bytes: u64,
    pub reachable: bool,
    pub steps: u64,
}

pub fn parse_fit(data: &Value) -> Option<FitResult> {
    Some(FitResult {
        params: data.get("params")?.clone(),
        estimated_bytes: data.get("estimatedBytes")?.as_u64()?,
        reachable: data.get("reachable")?.as_bool()?,
        steps: data.get("steps").and_then(Value::as_u64).unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_form_builds_core_params() {
        let v = build_params(&ScanForm::default(), 10).unwrap();
        assert_eq!(v["dpi"], 200);
        assert_eq!(v["color"], "gray");
        assert_eq!(v["effectsPreset"], "none");
        assert!(v.get("pages").is_none());
    }

    #[test]
    fn pages_are_zero_based_sorted_and_validated() {
        let f = ScanForm {
            pages_text: "5, 1-3,2".into(),
            ..ScanForm::default()
        };
        assert_eq!(build_params(&f, 10).unwrap()["pages"], json!([0, 1, 2, 4]));
        for bad in ["0", "11", "3-1", "a"] {
            let f = ScanForm {
                pages_text: bad.into(),
                ..ScanForm::default()
            };
            assert_eq!(form_issues(&f, 10), vec![Field::Pages], "{bad}");
            assert!(build_params(&f, 10).is_none());
        }
    }

    #[test]
    fn numeric_limits() {
        let f = ScanForm {
            dpi: 71,
            jpeg_quality: 0,
            threshold: 256,
            seed: -1,
            ..ScanForm::default()
        };
        assert_eq!(
            form_issues(&f, 1),
            vec![
                Field::Dpi,
                Field::JpegQuality,
                Field::Threshold,
                Field::Seed
            ]
        );
        assert!(
            form_issues(
                &ScanForm {
                    dpi: 1200,
                    ..ScanForm::default()
                },
                1
            )
            .is_empty()
        );
    }

    #[test]
    fn apply_params_round_trips_and_keeps_missing_keys() {
        let f = ScanForm {
            dpi: 300,
            color: Color::Bw,
            effects: Effects::OldPaper,
            seed: 7,
            pages_text: "2-3".into(),
            ..ScanForm::default()
        };
        let v = build_params(&f, 5).unwrap();
        assert_eq!(apply_params(&ScanForm::default(), &v), f);
        let kept = apply_params(&f, &json!({"dpi": 150}));
        assert_eq!(
            (kept.dpi, kept.color, kept.pages_text.as_str()),
            (150, Color::Bw, "2-3")
        );
        let all = apply_params(&f, &json!({"pages": null, "effectsPreset": null}));
        assert_eq!((all.pages_text.as_str(), all.effects), ("", Effects::None));
        let bogus = apply_params(&f, &json!({"color": "pink", "effectsPreset": "zzz"}));
        assert_eq!((bogus.color, bogus.effects), (Color::Bw, Effects::OldPaper));
    }

    #[test]
    fn user_preset_drops_pages() {
        let f = ScanForm {
            pages_text: "1-2".into(),
            ..ScanForm::default()
        };
        let m = preset_params_of(&f, 5).unwrap();
        assert!(!m.contains_key("pages") && m["dpi"] == 200);
    }

    #[test]
    fn preset_names() {
        assert_eq!(validate_preset_name("  Nhẹ  ", &["Chuẩn"]).unwrap(), "Nhẹ");
        assert_eq!(
            validate_preset_name(" ", &[]).unwrap_err(),
            PresetNameIssue::Empty
        );
        assert_eq!(
            validate_preset_name(&"a".repeat(61), &[]).unwrap_err(),
            PresetNameIssue::TooLong
        );
        assert_eq!(
            validate_preset_name("chuẩn", &["Chuẩn"]).unwrap_err(),
            PresetNameIssue::Duplicate
        );
    }

    #[test]
    fn core_error_and_helpers() {
        let d = json!({"field":"dpi","maxDpi":437.9});
        assert_eq!(dpi_limit_from_error("INVALID_PARAMS", &d), Some(437));
        assert_eq!(dpi_limit_from_error("OTHER", &d), None);
        assert_eq!(
            dpi_limit_from_error("INVALID_PARAMS", &json!({"field":"dpi","maxDpi":10})),
            None
        );
        assert_eq!(warning_key("Links will be lost."), Some("scan.warn.links"));
        assert_eq!(warning_key("x"), None);
        assert_eq!(duration_parts(0.2), (DurationUnit::Seconds, 1));
        assert_eq!(duration_parts(59.4), (DurationUnit::Seconds, 59));
        assert_eq!(duration_parts(150.0), (DurationUnit::Minutes, 3));
        assert_eq!(parse_megabytes("2,5"), Some(2_621_440));
        assert_eq!(parse_megabytes("0"), None);
        assert_eq!(parse_megabytes(""), None);
        let fit = parse_fit(&json!({"params":{"dpi":150},"estimatedBytes":4000,"reachable":false}))
            .unwrap();
        assert!(!fit.reachable && fit.steps == 0);
    }
}
