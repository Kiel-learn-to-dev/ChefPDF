//! Nén PDF (TASKS_RUST R5.11, FEATURES M1): port `compressModel.ts`. Form, preset dựng sẵn và của
//! người dùng, tham số `compress.pdf`/`estimate`/`fitSize`, báo cáo kết quả. Logic thuần.
#![allow(dead_code)]

use serde_json::{Value, json};

pub const DPI_MIN: i64 = 36;
pub const DPI_MAX: i64 = 1200;
pub const QUALITY_MIN: i64 = 1;
pub const QUALITY_MAX: i64 = 100;
pub const MAX_PRESET_NAME: usize = 60;
pub const MAX_USER_PRESETS: usize = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Preset {
    Screen,
    Ebook,
    Print,
    ArchiveLight,
    Custom,
}

impl Preset {
    pub const BUILTIN: [Preset; 4] = [
        Preset::Screen,
        Preset::Ebook,
        Preset::Print,
        Preset::ArchiveLight,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Preset::Screen => "screen",
            Preset::Ebook => "ebook",
            Preset::Print => "print",
            Preset::ArchiveLight => "archive-light",
            Preset::Custom => "custom",
        }
    }

    pub fn parse(s: &str) -> Option<Preset> {
        Self::BUILTIN.into_iter().find(|p| p.as_str() == s)
    }

    /// Ảnh của từng preset, khớp `PRESETS` trong `core/chef_core/ops/compress.py`.
    /// None nghĩa là lõi giữ nguyên ảnh.
    fn values(self) -> (Option<i64>, Option<i64>, bool) {
        match self {
            Preset::Screen => (Some(96), Some(55), true),
            Preset::Ebook => (Some(150), Some(70), true),
            Preset::Print => (Some(300), Some(85), false),
            Preset::ArchiveLight | Preset::Custom => (None, None, false),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Form {
    pub preset: Preset,
    pub max_image_dpi: Option<i64>,
    pub jpeg_quality: Option<i64>,
    pub grayscale: bool,
    pub remove_unused: bool,
    pub remove_metadata: bool,
    pub remove_thumbnails: bool,
    pub remove_attachments: bool,
    pub subset_fonts: bool,
    pub flatten_transparency: bool,
}

impl Default for Form {
    fn default() -> Self {
        Form {
            preset: Preset::Ebook,
            grayscale: false,
            remove_unused: true,
            remove_metadata: false,
            remove_attachments: false,
            subset_fonts: true,
            flatten_transparency: false,
            ..Form::blank()
        }
        .with_preset(Preset::Ebook)
    }
}

impl Form {
    fn blank() -> Form {
        Form {
            preset: Preset::Custom,
            max_image_dpi: None,
            jpeg_quality: None,
            grayscale: false,
            remove_unused: true,
            remove_metadata: false,
            remove_thumbnails: false,
            remove_attachments: false,
            subset_fonts: true,
            flatten_transparency: false,
        }
    }

    /// Sau khi chọn preset: ảnh theo preset, các cờ giữ nguyên. `Custom` chỉ đổi nhãn.
    pub fn with_preset(&self, preset: Preset) -> Form {
        let mut f = self.clone();
        f.preset = preset;
        if preset != Preset::Custom {
            let (dpi, q, thumbs) = preset.values();
            f.max_image_dpi = dpi;
            f.jpeg_quality = q;
            f.remove_thumbnails = thumbs;
        }
        f
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Issue {
    Dpi,
    Quality,
}

fn int_in(n: i64, min: i64, max: i64) -> bool {
    (min..=max).contains(&n)
}

pub fn form_issues(f: &Form) -> Vec<Issue> {
    let mut v = Vec::new();
    if f.max_image_dpi
        .is_some_and(|d| !int_in(d, DPI_MIN, DPI_MAX))
    {
        v.push(Issue::Dpi);
    }
    if f.jpeg_quality
        .is_some_and(|q| !int_in(q, QUALITY_MIN, QUALITY_MAX))
    {
        v.push(Issue::Quality);
    }
    v
}

/// Tham số `compress.pdf`/`compress.estimate`; thiếu cài đặt ảnh thì để theo preset.
pub fn compress_params(f: &Form) -> Value {
    let mut v = json!({
        "preset": f.preset.as_str(),
        "grayscale": f.grayscale,
        "removeUnused": f.remove_unused,
        "removeMetadata": f.remove_metadata,
        "removeThumbnails": f.remove_thumbnails,
        "removeAttachments": f.remove_attachments,
        "subsetFonts": f.subset_fonts,
        "flattenTransparency": f.flatten_transparency,
    });
    if let Some(d) = f.max_image_dpi {
        v["maxImageDpi"] = d.into();
    }
    if let Some(q) = f.jpeg_quality {
        v["jpegQuality"] = q.into();
    }
    v
}

/// Đọc form từ tham số (preset người dùng hoặc kết quả `compress.fitSize`).
pub fn form_from_params(raw: &Value) -> Form {
    let preset = raw
        .get("preset")
        .and_then(Value::as_str)
        .and_then(Preset::parse)
        .unwrap_or(Preset::Custom);
    let base = if preset == Preset::Custom {
        Form::default().with_preset(Preset::Custom)
    } else {
        Form::default().with_preset(preset)
    };
    let boolean = |k: &str, d: bool| raw.get(k).and_then(Value::as_bool).unwrap_or(d);
    let num = |k: &str, min, max| {
        raw.get(k)
            .and_then(Value::as_i64)
            .filter(|n| int_in(*n, min, max))
    };
    let custom = preset == Preset::Custom;
    Form {
        preset,
        max_image_dpi: num("maxImageDpi", DPI_MIN, DPI_MAX).or(if custom {
            None
        } else {
            base.max_image_dpi
        }),
        jpeg_quality: num("jpegQuality", QUALITY_MIN, QUALITY_MAX).or(if custom {
            None
        } else {
            base.jpeg_quality
        }),
        grayscale: boolean("grayscale", false),
        remove_unused: boolean("removeUnused", true),
        remove_metadata: boolean("removeMetadata", false),
        remove_thumbnails: boolean("removeThumbnails", base.remove_thumbnails),
        remove_attachments: boolean("removeAttachments", false),
        subset_fonts: boolean("subsetFonts", true),
        flatten_transparency: boolean("flattenTransparency", false),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NameIssue {
    Empty,
    TooLong,
    Duplicate,
}

pub fn validate_preset_name(name: &str, taken: &[&str]) -> Option<NameIssue> {
    let t = name.trim();
    if t.is_empty() {
        Some(NameIssue::Empty)
    } else if t.chars().count() > MAX_PRESET_NAME {
        Some(NameIssue::TooLong)
    } else if taken.iter().any(|x| x.to_lowercase() == t.to_lowercase()) {
        Some(NameIssue::Duplicate)
    } else {
        None
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct UserPreset {
    pub name: String,
    pub params: Value,
}

/// Giữ các preset người dùng hợp lệ (từ cài đặt hoặc nhập vào); mục hỏng hay trùng bị bỏ.
pub fn read_user_presets(raw: &Value) -> Vec<UserPreset> {
    let mut out: Vec<UserPreset> = Vec::new();
    for item in raw.as_array().into_iter().flatten() {
        let (Some(name), Some(params)) = (
            item.get("name").and_then(Value::as_str),
            item.get("params").filter(|p| p.is_object()),
        ) else {
            continue;
        };
        let name = name.trim();
        if name.is_empty()
            || name.chars().count() > MAX_PRESET_NAME
            || out
                .iter()
                .any(|p| p.name.to_lowercase() == name.to_lowercase())
        {
            continue;
        }
        out.push(UserPreset {
            name: name.into(),
            params: params.clone(),
        });
        if out.len() >= MAX_USER_PRESETS {
            break;
        }
    }
    out
}

/// Dung lượng đích (byte) từ MB gõ vào; None nếu không hợp lệ.
pub fn target_bytes_of(mb: f64) -> Option<u64> {
    (mb.is_finite() && mb > 0.0 && mb <= 10_000.0).then(|| (mb * 1024.0 * 1024.0).round() as u64)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Report {
    pub bytes_before: u64,
    pub bytes_after: u64,
    /// Phần dung lượng gốc còn lại (0..1+).
    pub ratio: f64,
    pub images_processed: u64,
    pub images_skipped: u64,
    pub skipped: Vec<(String, u64)>,
    pub warnings: Vec<String>,
}

pub fn read_report(d: &Value) -> Report {
    let n = |k: &str| d.get(k).and_then(Value::as_u64).unwrap_or(0);
    let ratio = d
        .get("ratio")
        .and_then(Value::as_f64)
        .filter(|r| r.is_finite() && *r != 0.0)
        .unwrap_or(1.0);
    let mut skipped: Vec<(String, u64)> = d
        .get("skippedReasons")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| v.as_u64().filter(|c| *c > 0).map(|c| (k.clone(), c)))
                .collect()
        })
        .unwrap_or_default();
    skipped.sort();
    Report {
        bytes_before: n("bytesBefore"),
        bytes_after: n("bytesAfter"),
        ratio,
        images_processed: n("imagesProcessed"),
        images_skipped: n("imagesSkipped"),
        skipped,
        warnings: d
            .get("warnings")
            .and_then(Value::as_array)
            .map(|w| {
                w.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// Phần trăm tiết kiệm (0 khi kết quả không nhỏ hơn).
pub fn percent_saved(before: u64, after: u64) -> u32 {
    if before == 0 || after >= before {
        0
    } else {
        ((1.0 - after as f64 / before as f64) * 100.0).round() as u32
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FitResult {
    pub form: Form,
    pub estimated_bytes: u64,
    pub reachable: bool,
}

/// Kết quả `compress.fitSize`: tham số cần áp dụng và có đạt dung lượng đích không.
pub fn read_fit_result(d: &Value) -> Option<FitResult> {
    let params = d.get("params").filter(|p| p.is_object())?;
    Some(FitResult {
        form: Form {
            preset: Preset::Custom,
            ..form_from_params(params)
        },
        estimated_bytes: d.get("estimatedBytes").and_then(Value::as_u64).unwrap_or(0),
        reachable: d.get("reachable").and_then(Value::as_bool) == Some(true),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_fill_image_settings_and_keep_flags() {
        let f = Form::default();
        assert_eq!(
            (
                f.preset,
                f.max_image_dpi,
                f.jpeg_quality,
                f.remove_thumbnails
            ),
            (Preset::Ebook, Some(150), Some(70), true)
        );
        let g = Form {
            grayscale: true,
            ..f
        }
        .with_preset(Preset::ArchiveLight);
        assert_eq!(
            (
                g.max_image_dpi,
                g.jpeg_quality,
                g.remove_thumbnails,
                g.grayscale
            ),
            (None, None, false, true)
        );
        let c = g.with_preset(Preset::Custom);
        assert_eq!(c.preset, Preset::Custom);
        let p = Form::default().with_preset(Preset::Print);
        assert_eq!(
            (p.max_image_dpi, p.jpeg_quality, p.remove_thumbnails),
            (Some(300), Some(85), false)
        );
    }

    #[test]
    fn params_leave_out_unset_image_settings() {
        let v = compress_params(&Form::default().with_preset(Preset::ArchiveLight));
        assert!(v.get("maxImageDpi").is_none() && v.get("jpegQuality").is_none());
        assert_eq!(v["preset"], "archive-light");
        let v = compress_params(&Form::default());
        assert_eq!(
            (
                v["maxImageDpi"].as_i64(),
                v["jpegQuality"].as_i64(),
                v["subsetFonts"].as_bool()
            ),
            (Some(150), Some(70), Some(true))
        );
        let bad = Form {
            max_image_dpi: Some(10),
            jpeg_quality: Some(101),
            ..Form::default()
        };
        assert_eq!(form_issues(&bad), [Issue::Dpi, Issue::Quality]);
        assert!(form_issues(&Form::default()).is_empty());
    }

    #[test]
    fn form_round_trips_through_params() {
        for preset in Preset::BUILTIN {
            let f = Form::default().with_preset(preset);
            assert_eq!(form_from_params(&compress_params(&f)), f, "{preset:?}");
        }
        let custom = Form {
            max_image_dpi: Some(200),
            grayscale: true,
            ..Form::default().with_preset(Preset::Custom)
        };
        assert_eq!(form_from_params(&compress_params(&custom)), custom);
        // thiếu khóa: dùng mặc định theo preset
        let f = form_from_params(&json!({"preset":"screen"}));
        assert_eq!(
            (f.max_image_dpi, f.jpeg_quality, f.remove_thumbnails),
            (Some(96), Some(55), true)
        );
        let junk = form_from_params(&json!({"preset":"zzz","maxImageDpi":5}));
        assert_eq!((junk.preset, junk.max_image_dpi), (Preset::Custom, None));
    }

    #[test]
    fn user_presets_and_names() {
        assert_eq!(validate_preset_name("  ", &[]), Some(NameIssue::Empty));
        assert_eq!(
            validate_preset_name(&"a".repeat(61), &[]),
            Some(NameIssue::TooLong)
        );
        assert_eq!(
            validate_preset_name("Nhẹ", &["nhẹ"]),
            Some(NameIssue::Duplicate)
        );
        assert_eq!(validate_preset_name("Mới", &["Nhẹ"]), None);
        let raw = json!([{"name":"A","params":{"x":1}}, {"name":"a","params":{}}, {"name":"","params":{}},
                         {"name":"B"}, {"name":"C","params":5}, 7, {"name":"D","params":{}}]);
        let names: Vec<_> = read_user_presets(&raw)
            .into_iter()
            .map(|p| p.name)
            .collect();
        assert_eq!(names, ["A", "D"]);
        assert!(read_user_presets(&Value::Null).is_empty());
        let many: Vec<Value> = (0..60)
            .map(|i| json!({"name":format!("p{i}"),"params":{}}))
            .collect();
        assert_eq!(
            read_user_presets(&Value::Array(many)).len(),
            MAX_USER_PRESETS
        );
    }

    #[test]
    fn target_report_and_fit() {
        assert_eq!(target_bytes_of(1.5), Some(1_572_864));
        assert_eq!(
            (
                target_bytes_of(0.0),
                target_bytes_of(10_001.0),
                target_bytes_of(f64::NAN)
            ),
            (None, None, None)
        );
        let r = read_report(
            &json!({"bytesBefore":1000,"bytesAfter":400,"ratio":0.4,"imagesProcessed":3,
            "skippedReasons":{"tiny":2,"none":0},"warnings":["w",1]}),
        );
        assert_eq!(
            (
                r.bytes_after,
                r.images_processed,
                r.skipped.clone(),
                r.warnings.clone()
            ),
            (400, 3, vec![("tiny".into(), 2)], vec!["w".to_string()])
        );
        assert_eq!(read_report(&json!({})).ratio, 1.0);
        assert_eq!(
            (
                percent_saved(1000, 400),
                percent_saved(1000, 1000),
                percent_saved(0, 1)
            ),
            (60, 0, 0)
        );
        let fit = read_fit_result(
            &json!({"params":{"preset":"screen"},"estimatedBytes":5,"reachable":true}),
        )
        .unwrap();
        assert_eq!(
            (fit.form.preset, fit.reachable, fit.estimated_bytes),
            (Preset::Custom, true, 5)
        );
        assert!(read_fit_result(&json!({})).is_none());
    }
}
