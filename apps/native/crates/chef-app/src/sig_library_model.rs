//! Thư viện ảnh chữ ký và con dấu (TASKS_RUST R6.07–R6.10; FEATURES I19–I23): port `libraryModel.ts`.
//! Mặc định, kẹp giá trị, tham số các thao tác ảnh (`image.removeBackground`, `image.cleanup`,
//! `image.textSignature`, `image.fromStrokes`) và áp lực nét vẽ. Logic thuần.
#![allow(dead_code)]

use serde_json::{Value, json};

pub const KINDS: [&str; 4] = ["signature", "stamp", "initials", "logo"];
pub const NAME_MAX: usize = 80;

/// Kẹp vào [min, max]; giá trị không hữu hạn lấy `min`.
pub fn clamp_to(v: f64, min: f64, max: f64) -> f64 {
    if v.is_finite() {
        v.clamp(min, max)
    } else {
        min
    }
}

fn round(v: f64, digits: i32) -> f64 {
    let k = 10f64.powi(digits);
    (v * k).round() / k
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoveMode {
    Auto,
    InkColor,
    PaperWhite,
}

impl RemoveMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::InkColor => "ink-color",
            Self::PaperWhite => "paper-white",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BackgroundOptions {
    pub mode: RemoveMode,
    /// Khoảng cách màu cho ink-color (0–200).
    pub tolerance: f64,
    /// paper-white: cao hơn giữ mực nhạt hơn (0–100).
    pub sensitivity: f64,
    /// Viền mềm, điểm ảnh (0–5).
    pub feather: f64,
}

impl Default for BackgroundOptions {
    fn default() -> Self {
        Self {
            mode: RemoveMode::Auto,
            tolerance: 60.0,
            sensitivity: 50.0,
            feather: 1.0,
        }
    }
}

pub fn normalize_background(o: &BackgroundOptions) -> BackgroundOptions {
    BackgroundOptions {
        mode: o.mode,
        tolerance: clamp_to(o.tolerance, 0.0, 200.0).round(),
        sensitivity: clamp_to(o.sensitivity, 0.0, 100.0).round(),
        feather: round(clamp_to(o.feather, 0.0, 5.0), 2),
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CleanupOptions {
    /// Vệt mực nhỏ hơn mức này bị bỏ (0 = tắt, 0–200).
    pub min_blob_px: f64,
    pub straighten: bool,
    /// Làm đậm (+) hay mảnh (−) nét (−5 đến 5).
    pub thicken: f64,
    /// 0,2–3.
    pub contrast: f64,
    /// Cạnh dài nhất, điểm ảnh (0 = giữ).
    pub max_side: u32,
}

/// Cỡ chọn của bước làm sạch: 0 là giữ nguyên.
pub const CLEANUP_STEPS: [u32; 4] = [0, 400, 800, 1600];

impl Default for CleanupOptions {
    fn default() -> Self {
        Self {
            min_blob_px: 0.0,
            straighten: false,
            thicken: 0.0,
            contrast: 1.0,
            max_side: 0,
        }
    }
}

pub fn normalize_cleanup(o: &CleanupOptions) -> CleanupOptions {
    CleanupOptions {
        min_blob_px: clamp_to(o.min_blob_px, 0.0, 200.0).round(),
        straighten: o.straighten,
        thicken: clamp_to(o.thicken, -5.0, 5.0).round(),
        contrast: round(clamp_to(o.contrast, 0.2, 3.0), 2),
        max_side: if CLEANUP_STEPS.contains(&o.max_side) {
            o.max_side
        } else {
            0
        },
    }
}

/// `image.removeBackground` (I20).
pub fn remove_background_params(o: &BackgroundOptions, input: &str, output: &str) -> Value {
    let n = normalize_background(o);
    json!({"inputPath": input, "outputPath": output, "mode": n.mode.as_str(),
           "tolerance": n.tolerance, "sensitivity": n.sensitivity, "feather": n.feather})
}

/// `image.cleanup` (I21). Giới hạn cỡ là khung vuông theo cạnh dài nhất.
pub fn cleanup_params(o: &CleanupOptions, input: &str, output: &str) -> Value {
    let n = normalize_cleanup(o);
    let mut v = json!({"inputPath": input, "outputPath": output, "minBlobPx": n.min_blob_px,
        "straighten": n.straighten, "thicken": n.thicken, "contrast": n.contrast});
    if n.max_side > 0 {
        v["maxWidth"] = n.max_side.into();
        v["maxHeight"] = n.max_side.into();
    }
    v
}

#[derive(Debug, Clone, PartialEq)]
pub enum TypedFont {
    Bundled,
    /// File font người dùng chọn.
    File(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct TypedOptions {
    pub text: String,
    pub font: TypedFont,
    pub size_px: f64,
    pub color_hex: String,
    pub slant_deg: f64,
}

impl Default for TypedOptions {
    fn default() -> Self {
        Self {
            text: String::new(),
            font: TypedFont::Bundled,
            size_px: 96.0,
            color_hex: "#1F3A93".into(),
            slant_deg: 0.0,
        }
    }
}

pub const TYPED_FONT_EXTENSIONS: [&str; 2] = ["ttf", "otf"];

fn is_hex(v: &str) -> bool {
    crate::overlay_common::is_hex_color(v)
}

/// `image.textSignature` (I19). Chữ rỗng do bên gọi từ chối.
pub fn text_signature_params(o: &TypedOptions, output: &str) -> Value {
    let text: String = o.text.trim().chars().take(NAME_MAX).collect();
    let mut v = json!({
        "text": text,
        "fontName": if o.font == TypedFont::Bundled { json!("BeVietnamPro") } else { Value::Null },
        "sizePx": clamp_to(o.size_px, 16.0, 400.0).round(),
        "colorHex": if is_hex(&o.color_hex) { o.color_hex.to_uppercase() } else { "#1F3A93".into() },
        "slantDeg": round(clamp_to(o.slant_deg, -45.0, 45.0), 1),
        "outputPath": output,
    });
    if let TypedFont::File(p) = &o.font {
        v["fontPath"] = p.as_str().into();
    }
    v
}

// ---- Nét vẽ (I19: chữ ký vẽ tay) ----

#[derive(Debug, Clone, PartialEq)]
pub struct RawPoint {
    pub x: f64,
    pub y: f64,
    /// ms kể từ đầu nét.
    pub t: f64,
    /// `PointerEvent.pressure` (0–1).
    pub pressure: f64,
    /// "pen", "mouse" hoặc "touch".
    pub pointer_type: String,
}

/// Áp lực một điểm, 0 nhẹ nhất đến 1 nặng nhất. Bút báo áp lực thật. Chuột (không có áp lực) lấy từ tốc
/// độ: chậm nặng hơn, nhanh mảnh hơn, trong 0,5–1,0 (quy tắc của bảng vẽ).
pub fn pressure_for(p: &RawPoint, prev: Option<&RawPoint>) -> f64 {
    if p.pointer_type == "pen" && p.pressure > 0.0 {
        return clamp_to(p.pressure, 0.05, 1.0);
    }
    let Some(prev) = prev else {
        return 0.8;
    };
    let dt = (p.t - prev.t).max(1.0);
    let speed = (p.x - prev.x).hypot(p.y - prev.y) / dt;
    round(clamp_to(1.0 - speed * 0.4, 0.5, 1.0), 3)
}

/// Nét đã ghi thành `StrokeParams` của lõi (điểm theo đơn vị canvas); nét rỗng bị bỏ.
pub fn strokes_to_params(strokes: &[Vec<RawPoint>]) -> Value {
    Value::Array(
        strokes
            .iter()
            .filter(|s| !s.is_empty())
            .map(|s| {
                let points: Vec<Value> = s
                    .iter()
                    .enumerate()
                    .map(|(i, p)| {
                        let pressure = pressure_for(p, i.checked_sub(1).map(|j| &s[j]));
                        json!({"x": round(p.x, 2), "y": round(p.y, 2), "pressure": round(pressure, 3), "t": p.t.round()})
                    })
                    .collect();
                json!({"points": points})
            })
            .collect(),
    )
}

/// `image.fromStrokes`.
pub fn from_strokes_params(
    strokes: &[Vec<RawPoint>],
    width: f64,
    height: f64,
    output: &str,
) -> Value {
    json!({"strokes": strokes_to_params(strokes), "canvasWidth": width, "canvasHeight": height,
           "colorHex": "#1F3A93", "outputPath": output})
}

/// Tên mục thư viện mới: cắt khoảng trắng, giới hạn độ dài, mặc định khi rỗng.
pub fn item_name(raw: &str, fallback: &str) -> String {
    let t: String = raw.trim().chars().take(NAME_MAX).collect();
    if t.is_empty() { fallback.into() } else { t }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(x: f64, y: f64, t: f64, pressure: f64, kind: &str) -> RawPoint {
        RawPoint {
            x,
            y,
            t,
            pressure,
            pointer_type: kind.into(),
        }
    }

    #[test]
    fn clamp_and_names() {
        assert_eq!(
            (
                clamp_to(5.0, 0.0, 3.0),
                clamp_to(-1.0, 0.0, 3.0),
                clamp_to(f64::NAN, 2.0, 3.0)
            ),
            (3.0, 0.0, 2.0)
        );
        assert_eq!(item_name("  Chữ ký An  ", "Mới"), "Chữ ký An");
        assert_eq!(item_name("   ", "Mới"), "Mới");
        assert_eq!(item_name(&"x".repeat(100), "m").chars().count(), NAME_MAX);
        assert_eq!(KINDS.len(), 4);
    }

    #[test]
    fn background_and_cleanup_are_normalised() {
        let b = BackgroundOptions {
            mode: RemoveMode::InkColor,
            tolerance: 999.0,
            sensitivity: -4.0,
            feather: 2.456,
        };
        let v = remove_background_params(&b, "/in.png", "/out.png");
        assert_eq!(
            (
                v["mode"].as_str(),
                v["tolerance"].as_f64(),
                v["sensitivity"].as_f64(),
                v["feather"].as_f64()
            ),
            (Some("ink-color"), Some(200.0), Some(0.0), Some(2.46))
        );
        assert_eq!(
            remove_background_params(&BackgroundOptions::default(), "a", "b")["mode"],
            "auto"
        );
        let c = cleanup_params(
            &CleanupOptions {
                thicken: 9.0,
                contrast: 0.01,
                max_side: 800,
                min_blob_px: 12.4,
                ..Default::default()
            },
            "/i",
            "/o",
        );
        assert_eq!(
            (
                c["thicken"].as_f64(),
                c["contrast"].as_f64(),
                c["maxWidth"].as_u64(),
                c["maxHeight"].as_u64(),
                c["minBlobPx"].as_f64()
            ),
            (Some(5.0), Some(0.2), Some(800), Some(800), Some(12.0))
        );
        let d = cleanup_params(
            &CleanupOptions {
                max_side: 777,
                ..Default::default()
            },
            "/i",
            "/o",
        );
        assert!(
            d.get("maxWidth").is_none(),
            "cỡ không có trong bước thì giữ nguyên"
        );
    }

    #[test]
    fn typed_signature() {
        let o = TypedOptions {
            text: "  Nguyễn Văn An ".into(),
            size_px: 1000.0,
            color_hex: "#abcdef".into(),
            slant_deg: 12.34,
            ..Default::default()
        };
        let v = text_signature_params(&o, "/o.png");
        assert_eq!(
            (
                v["text"].as_str(),
                v["fontName"].as_str(),
                v["sizePx"].as_f64(),
                v["colorHex"].as_str(),
                v["slantDeg"].as_f64()
            ),
            (
                Some("Nguyễn Văn An"),
                Some("BeVietnamPro"),
                Some(400.0),
                Some("#ABCDEF"),
                Some(12.3)
            )
        );
        assert!(v.get("fontPath").is_none());
        let f = TypedOptions {
            font: TypedFont::File("C:\\f.ttf".into()),
            color_hex: "red".into(),
            ..o
        };
        let v = text_signature_params(&f, "/o.png");
        assert_eq!(
            (
                v["fontName"].is_null(),
                v["fontPath"].as_str(),
                v["colorHex"].as_str()
            ),
            (true, Some("C:\\f.ttf"), Some("#1F3A93"))
        );
    }

    #[test]
    fn pressure_rules() {
        assert_eq!(pressure_for(&pt(0.0, 0.0, 0.0, 0.7, "pen"), None), 0.7);
        assert_eq!(
            pressure_for(&pt(0.0, 0.0, 0.0, 0.0, "pen"), None),
            0.8,
            "bút báo 0: coi như chuột"
        );
        assert_eq!(pressure_for(&pt(0.0, 0.0, 0.0, 0.01, "pen"), None), 0.05);
        let a = pt(0.0, 0.0, 0.0, 0.0, "mouse");
        assert_eq!(
            pressure_for(&pt(1.0, 0.0, 10.0, 0.0, "mouse"), Some(&a)),
            0.96,
            "chậm: nặng"
        );
        assert_eq!(
            pressure_for(&pt(100.0, 0.0, 10.0, 0.0, "mouse"), Some(&a)),
            0.5,
            "nhanh: kẹp ở 0,5"
        );
        assert_eq!(
            pressure_for(&pt(5.0, 0.0, 0.0, 0.0, "mouse"), Some(&a)),
            0.5,
            "dt tối thiểu 1 ms"
        );
    }

    #[test]
    fn strokes_are_converted() {
        let strokes = vec![
            vec![
                pt(1.234, 2.0, 0.4, 0.5, "pen"),
                pt(3.0, 4.0, 12.6, 0.0, "mouse"),
            ],
            vec![],
        ];
        let v = strokes_to_params(&strokes);
        assert_eq!(v.as_array().unwrap().len(), 1);
        let p = &v[0]["points"];
        assert_eq!(
            (
                p[0]["x"].as_f64(),
                p[0]["pressure"].as_f64(),
                p[0]["t"].as_f64(),
                p[1]["t"].as_f64()
            ),
            (Some(1.23), Some(0.5), Some(0.0), Some(13.0))
        );
        let f = from_strokes_params(&strokes, 600.0, 200.0, "/o.png");
        assert_eq!(
            (f["canvasWidth"].as_f64(), f["colorHex"].as_str()),
            (Some(600.0), Some("#1F3A93"))
        );
    }
}
