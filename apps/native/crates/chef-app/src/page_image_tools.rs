//! Mô hình công cụ ảnh trang (TASKS_RUST R8.09, R8.10, R8.11, R8.15): port `spineModel.ts`,
//! `eraseModel.ts`, `fingerModel.ts`. Tách trang đôi (khe gáy), tẩy vùng, xóa vết màu và mặt nạ xóa
//! ngón tay (cọ tròn), làm phẳng trang cong (`dewarpModel.ts`) và chỉnh ảnh (`adjustModel.ts`: nền
//! trắng, khử nhiễu, Levels, Curves, DPI). Logic thuần, không phụ thuộc giao diện.
#![allow(dead_code)]

use crate::scan_convert::parse_pages;
use serde_json::{Value, json};

// ---- Tách trang đôi (spine) ----

pub const SPINE_PREVIEW_LIMIT: usize = 3;
pub const SPINE_MIN_PERCENT: f64 = 10.0;
pub const SPINE_MAX_PERCENT: f64 = 90.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpineMode {
    Auto,
    Manual,
}

/// Trang chọn: rỗng là mọi trang; `Invalid` là chữ không đọc được hoặc trống sau khi lọc.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PageChoice {
    All,
    Pages(Vec<u64>),
    Invalid,
}

pub fn parse_choice(text: &str, page_count: usize) -> PageChoice {
    if text.trim().is_empty() {
        return PageChoice::All;
    }
    match parse_pages(text, page_count) {
        Some(p) if !p.is_empty() => PageChoice::Pages(p),
        _ => PageChoice::Invalid,
    }
}

/// `pageimg.spinePreview`: tối đa 3 trang đầu của vùng chọn; None khi không có trang hợp lệ.
pub fn spine_preview_params(text: &str, page_count: usize) -> Option<Value> {
    let pages: Vec<u64> = match parse_choice(text, page_count) {
        PageChoice::Invalid => return None,
        PageChoice::All => (0..page_count as u64).collect(),
        PageChoice::Pages(p) => p,
    };
    let pages: Vec<u64> = pages.into_iter().take(SPINE_PREVIEW_LIMIT).collect();
    (!pages.is_empty()).then(|| json!({ "pages": pages }))
}

/// `pageimg.splitSpread`. Thủ công: một vị trí (phần trăm bề rộng) áp cho mọi trang của vùng chọn.
pub fn spine_apply_params(
    text: &str,
    page_count: usize,
    mode: SpineMode,
    percent: f64,
) -> Option<Value> {
    let mut v = json!({ "order": "ltr" });
    match parse_choice(text, page_count) {
        PageChoice::Invalid => return None,
        PageChoice::Pages(p) => v["pages"] = json!(p),
        PageChoice::All => {}
    }
    if mode == SpineMode::Manual {
        if !percent.is_finite() || !(SPINE_MIN_PERCENT..=SPINE_MAX_PERCENT).contains(&percent) {
            return None;
        }
        v["mode"] = "x".into();
        v["x"] = ((percent * 10.0).round() / 1000.0).into();
    }
    Some(v)
}

pub fn clamp_percent(v: f64) -> f64 {
    v.clamp(SPINE_MIN_PERCENT, SPINE_MAX_PERCENT)
}

/// Vị trí tách tự động của trang xem trước đầu tiên, làm phần trăm cho thanh trượt (mặc định 50).
pub fn start_percent(preview: &Value) -> f64 {
    preview
        .get("pages")
        .and_then(Value::as_array)
        .and_then(|rows| {
            rows.iter().find_map(|r| {
                (r.get("status")?.as_str()? == "done")
                    .then(|| r.get("autoX")?.as_f64())
                    .flatten()
            })
        })
        .map_or(50.0, |x| clamp_percent((x * 1000.0).round() / 10.0))
}

// ---- Tẩy vùng và xóa vết màu ----

pub const ERASE_MIN_SIDE: f64 = 0.005;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EraseRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StainPreset {
    pub id: &'static str,
    pub hue_min: u32,
    pub hue_max: u32,
}

/// Dải màu (độ) của ba loại mực; đỏ vòng qua 0.
pub const STAIN_PRESETS: [StainPreset; 3] = [
    StainPreset {
        id: "blue",
        hue_min: 200,
        hue_max: 250,
    },
    StainPreset {
        id: "highlighter",
        hue_min: 45,
        hue_max: 70,
    },
    StainPreset {
        id: "red",
        hue_min: 340,
        hue_max: 20,
    },
];

/// Hình chữ nhật từ hai điểm kéo (tỉ lệ ảnh), kẹp vào trang; None nếu quá nhỏ.
pub fn rect_from_drag(start: (f64, f64), end: (f64, f64)) -> Option<EraseRect> {
    let c = |v: f64| v.clamp(0.0, 1.0);
    let (x0, x1) = (c(start.0.min(end.0)), c(start.0.max(end.0)));
    let (y0, y1) = (c(start.1.min(end.1)), c(start.1.max(end.1)));
    (x1 - x0 >= ERASE_MIN_SIDE && y1 - y0 >= ERASE_MIN_SIDE).then_some(EraseRect {
        x: x0,
        y: y0,
        w: x1 - x0,
        h: y1 - y0,
    })
}

/// Một trang (từ 1) thành chỉ số từ 0; None nếu không phải số nguyên trong phạm vi.
pub fn parse_single_page(text: &str, page_count: usize) -> Option<usize> {
    let t = text.trim();
    if t.is_empty() || !t.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n: usize = t.parse().ok()?;
    (1..=page_count).contains(&n).then(|| n - 1)
}

fn round4(v: f64) -> f64 {
    (v * 10_000.0).round() / 10_000.0
}

/// `pageimg.erase`; `paper_fill` là tô màu giấy tự dò, sai là trắng.
pub fn erase_params(page: Option<usize>, rects: &[EraseRect], paper_fill: bool) -> Option<Value> {
    let page = page?;
    if rects.is_empty() {
        return None;
    }
    Some(json!({
        "pageIndex": page,
        "rects": rects.iter().map(|r| json!({"x": round4(r.x), "y": round4(r.y), "w": round4(r.w), "h": round4(r.h)})).collect::<Vec<_>>(),
        "fill": if paper_fill { "paper" } else { "#ffffff" },
    }))
}

/// `pageimg.removeStains`: rỗng là mọi trang.
pub fn stain_params(text: &str, page_count: usize, preset: StainPreset) -> Option<Value> {
    let mut v = json!({ "hueMin": preset.hue_min, "hueMax": preset.hue_max });
    match parse_choice(text, page_count) {
        PageChoice::Invalid => return None,
        PageChoice::Pages(p) => v["pages"] = json!(p),
        PageChoice::All => {}
    }
    Some(v)
}

// ---- Mặt nạ xóa ngón tay ----

pub const FINGER_BRUSH_MIN: f64 = 4.0;
pub const FINGER_BRUSH_MAX: f64 = 120.0;
pub const FINGER_BRUSH_DEFAULT: f64 = 24.0;

/// Mặt nạ 1 byte/điểm ảnh: 255 là xóa (ngón tay), 0 là giữ.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FingerMask {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

impl FingerMask {
    pub fn new(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            data: vec![0; width * height],
        }
    }

    /// Vẽ (255) hoặc xóa (0) một đĩa; điểm ngoài mặt nạ bị bỏ qua.
    pub fn stamp_disc(&mut self, cx: f64, cy: f64, radius: f64, value: u8) {
        if self.width == 0 || self.height == 0 {
            return;
        }
        let r = radius.max(0.5);
        let x0 = (cx - r).floor().max(0.0) as usize;
        let x1 = ((cx + r).ceil().min(self.width as f64 - 1.0)).max(0.0) as usize;
        let y0 = (cy - r).floor().max(0.0) as usize;
        let y1 = ((cy + r).ceil().min(self.height as f64 - 1.0)).max(0.0) as usize;
        let r2 = r * r;
        for y in y0..=y1 {
            for x in x0..=x1 {
                let (dx, dy) = (x as f64 + 0.5 - cx, y as f64 + 0.5 - cy);
                if dx * dx + dy * dy <= r2 {
                    self.data[y * self.width + x] = value;
                }
            }
        }
    }

    /// Nét cọ từ điểm này đến điểm kia, đóng dấu cách nhau nửa bán kính.
    pub fn stroke_line(&mut self, from: (f64, f64), to: (f64, f64), radius: f64, value: u8) {
        let dist = (to.0 - from.0).hypot(to.1 - from.1);
        let steps = (dist / (radius / 2.0).max(1.0)).ceil().max(1.0) as usize;
        for i in 0..=steps {
            let t = i as f64 / steps as f64;
            self.stamp_disc(
                from.0 + (to.0 - from.0) * t,
                from.1 + (to.1 - from.1) * t,
                radius,
                value,
            );
        }
    }

    pub fn erased_pixels(&self) -> usize {
        self.data.iter().filter(|&&v| v != 0).count()
    }

    /// Từ ảnh RGBA đã vẽ: điểm sáng (đỏ > 127) là xóa.
    pub fn from_rgba(width: usize, height: usize, rgba: &[u8]) -> Self {
        let mut m = Self::new(width, height);
        for i in 0..width * height {
            m.data[i] = if rgba.get(i * 4).copied().unwrap_or(0) > 127 {
                255
            } else {
                0
            };
        }
        m
    }

    /// Lớp phủ đỏ trong suốt cho trình sửa: vùng xóa hiện, vùng giữ trong suốt.
    pub fn overlay_rgba(&self) -> Vec<u8> {
        let mut out = vec![0u8; self.data.len() * 4];
        for (i, &v) in self.data.iter().enumerate() {
            if v != 0 {
                out[i * 4..i * 4 + 4].copy_from_slice(&[255, 40, 40, 150]);
            }
        }
        out
    }

    /// Ảnh xám RGBA để mã hóa PNG gửi lõi (trắng là xóa).
    pub fn to_gray_rgba(&self) -> Vec<u8> {
        self.data.iter().flat_map(|&v| [v, v, v, 255]).collect()
    }
}

/// Bán kính cọ (điểm ảnh) từ thanh trượt, đơn vị 1/1000 bề rộng trang.
pub fn brush_radius_px(slider: f64, mask_width: usize) -> usize {
    let clamped = slider.clamp(FINGER_BRUSH_MIN, FINGER_BRUSH_MAX);
    ((clamped / 1000.0 * mask_width as f64).round() as usize).max(1)
}

// ---- Làm phẳng trang cong (dewarp) ----

pub const DEWARP_MIN_CONFIDENCE: f64 = 0.35;
pub const DEWARP_PREVIEW_LIMIT: usize = 3;

/// `pageimg.dewarpPreview`: tối đa 3 trang đầu của vùng chọn.
pub fn dewarp_preview_params(text: &str, page_count: usize) -> Option<Value> {
    let pages: Vec<u64> = match parse_choice(text, page_count) {
        PageChoice::Invalid => return None,
        PageChoice::All => (0..page_count as u64).collect(),
        PageChoice::Pages(p) => p,
    };
    let pages: Vec<u64> = pages.into_iter().take(DEWARP_PREVIEW_LIMIT).collect();
    (!pages.is_empty()).then(|| json!({ "pages": pages }))
}

/// `pageimg.dewarp`: trang rỗng là tất cả; ngưỡng tin cậy cố định.
pub fn dewarp_apply_params(text: &str, page_count: usize) -> Option<Value> {
    let mut v = json!({ "minConfidence": DEWARP_MIN_CONFIDENCE });
    match parse_choice(text, page_count) {
        PageChoice::Invalid => return None,
        PageChoice::Pages(p) => v["pages"] = json!(p),
        PageChoice::All => {}
    }
    Some(v)
}

/// Trang lõi đánh dấu `review` (độ tin cậy thấp) trong kết quả dewarp.
pub fn dewarp_review_pages(data: &Value) -> Vec<u64> {
    data.get("pages")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter(|r| r.get("status").and_then(Value::as_str) == Some("review"))
                .filter_map(|r| r.get("pageIndex")?.as_u64())
                .collect()
        })
        .unwrap_or_default()
}

// ---- Chỉnh ảnh (adjust) ----

/// Năm mức vào của đường cong tông màu; người dùng đặt mức ra ở mỗi mức.
pub const CURVE_INPUTS: [i64; 5] = [0, 64, 128, 192, 255];

#[derive(Debug, Clone, PartialEq)]
pub struct AdjustState {
    pub whiten: bool,
    pub whiten_strength: f64,
    pub denoise: bool,
    pub denoise_strength: f64,
    pub black: i64,
    pub white: i64,
    pub gamma: f64,
    pub curve: [f64; 5],
    pub contrast: f64,
    pub brightness: f64,
    pub invert: bool,
    pub grayscale: bool,
    /// Chữ người dùng gõ; rỗng là không đổi DPI.
    pub dpi: String,
    pub resize_page: bool,
}

impl Default for AdjustState {
    fn default() -> Self {
        Self {
            whiten: false,
            whiten_strength: 0.8,
            denoise: false,
            denoise_strength: 0.5,
            black: 0,
            white: 255,
            gamma: 1.0,
            curve: [0.0, 64.0, 128.0, 192.0, 255.0],
            contrast: 0.0,
            brightness: 0.0,
            invert: false,
            grayscale: false,
            dpi: String::new(),
            resize_page: false,
        }
    }
}

pub fn curve_is_default(curve: &[f64; 5]) -> bool {
    curve.iter().zip(CURVE_INPUTS).all(|(o, i)| *o == i as f64)
}

/// Trắng phải cao hơn đen.
pub fn levels_valid(s: &AdjustState) -> bool {
    s.white > s.black
}

fn dpi_of(s: &AdjustState) -> Option<Option<u32>> {
    let t = s.dpi.trim();
    if t.is_empty() {
        return Some(None);
    }
    let n: u32 = t.parse().ok().filter(|n| (50..=1200).contains(n))?;
    Some(Some(n))
}

pub fn dpi_valid(s: &AdjustState) -> bool {
    dpi_of(s).is_some()
}

/// Chỉ gửi phần khác "không đổi gì".
pub fn enhance_settings(s: &AdjustState) -> serde_json::Map<String, Value> {
    let mut m = serde_json::Map::new();
    if s.whiten {
        m.insert("whiten".into(), true.into());
        m.insert("whitenStrength".into(), s.whiten_strength.into());
    }
    if s.denoise {
        m.insert("denoise".into(), true.into());
        m.insert("denoiseStrength".into(), s.denoise_strength.into());
    }
    if s.black != 0 || s.white != 255 || s.gamma != 1.0 {
        m.insert(
            "levels".into(),
            json!({"black": s.black, "white": s.white, "gamma": s.gamma}),
        );
    }
    if !curve_is_default(&s.curve) {
        let pts: Vec<Value> = CURVE_INPUTS
            .iter()
            .zip(s.curve)
            .map(|(i, o)| json!({"input": i, "output": o.round() as i64}))
            .collect();
        m.insert("curve".into(), pts.into());
    }
    if s.contrast != 0.0 {
        m.insert("contrast".into(), s.contrast.into());
    }
    if s.brightness != 0.0 {
        m.insert("brightness".into(), s.brightness.into());
    }
    if s.invert {
        m.insert("invert".into(), true.into());
    }
    if s.grayscale {
        m.insert("grayscale".into(), true.into());
    }
    if let Some(Some(dpi)) = dpi_of(s) {
        m.insert("dpi".into(), dpi.into());
        if s.resize_page {
            m.insert("resizePage".into(), true.into());
        }
    }
    m
}

/// `pageimg.enhance`: trang rỗng là tất cả.
pub fn adjust_apply_params(s: &AdjustState, text: &str, page_count: usize) -> Option<Value> {
    if !levels_valid(s) || !dpi_valid(s) {
        return None;
    }
    let mut m = enhance_settings(s);
    match parse_choice(text, page_count) {
        PageChoice::Invalid => return None,
        PageChoice::Pages(p) => {
            m.insert("pages".into(), json!(p));
        }
        PageChoice::All => {}
    }
    Some(Value::Object(m))
}

/// `pageimg.enhancePreview`: bỏ DPI (xem trước chỉ cho thấy tông màu và làm sạch).
pub fn adjust_preview_params(s: &AdjustState, page: usize) -> Option<Value> {
    if !levels_valid(s) || !dpi_valid(s) {
        return None;
    }
    let mut m = enhance_settings(s);
    m.remove("dpi");
    m.remove("resizePage");
    m.insert("pageIndex".into(), page.into());
    Some(Value::Object(m))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spine_params() {
        assert_eq!(
            spine_preview_params("", 10).unwrap()["pages"],
            json!([0, 1, 2])
        );
        assert_eq!(
            spine_preview_params("5-9", 10).unwrap()["pages"],
            json!([4, 5, 6])
        );
        assert!(spine_preview_params("99", 10).is_none());
        assert!(spine_preview_params("", 0).is_none());
        let auto = spine_apply_params("", 4, SpineMode::Auto, 0.0).unwrap();
        assert_eq!(auto, json!({"order":"ltr"}));
        let man = spine_apply_params("2-3", 4, SpineMode::Manual, 47.26).unwrap();
        assert_eq!(
            (man["mode"].as_str(), man["x"].as_f64(), &man["pages"]),
            (Some("x"), Some(0.473), &json!([1, 2]))
        );
        assert!(spine_apply_params("", 4, SpineMode::Manual, 9.0).is_none());
        assert!(spine_apply_params("", 4, SpineMode::Manual, f64::NAN).is_none());
        assert!(spine_apply_params("x", 4, SpineMode::Auto, 50.0).is_none());
    }

    #[test]
    fn start_percent_uses_first_done_row() {
        let d = json!({"pages":[{"status":"skipped"},{"status":"done","autoX":0.4872},{"status":"done","autoX":0.6}]});
        assert_eq!(start_percent(&d), 48.7);
        assert_eq!(start_percent(&json!({"pages":[]})), 50.0);
        assert_eq!(
            start_percent(&json!({"pages":[{"status":"done","autoX":0.99}]})),
            90.0
        );
        assert_eq!(clamp_percent(1.0), 10.0);
    }

    #[test]
    fn erase_and_stain() {
        assert_eq!(rect_from_drag((0.5, 0.5), (0.5005, 0.9)), None);
        let r = rect_from_drag((0.8, 0.9), (-1.0, 0.2)).unwrap();
        assert_eq!((r.x, r.y, r.w), (0.0, 0.2, 0.8));
        assert!((r.h - 0.7).abs() < 1e-12);
        assert_eq!(parse_single_page(" 3 ", 5), Some(2));
        assert_eq!(parse_single_page("0", 5), None);
        assert_eq!(parse_single_page("6", 5), None);
        assert_eq!(parse_single_page("1-2", 5), None);
        let p = erase_params(
            Some(1),
            &[EraseRect {
                x: 0.123456,
                y: 0.1,
                w: 0.2,
                h: 0.3,
            }],
            true,
        )
        .unwrap();
        assert_eq!(
            (p["fill"].as_str(), p["rects"][0]["x"].as_f64()),
            (Some("paper"), Some(0.1235))
        );
        assert_eq!(erase_params(Some(0), &[], false), None);
        assert_eq!(
            erase_params(
                None,
                &[EraseRect {
                    x: 0.0,
                    y: 0.0,
                    w: 1.0,
                    h: 1.0
                }],
                false
            ),
            None
        );
        let s = stain_params("", 3, STAIN_PRESETS[2]).unwrap();
        assert_eq!(
            (s["hueMin"].as_u64(), s["hueMax"].as_u64(), s.get("pages")),
            (Some(340), Some(20), None)
        );
        assert_eq!(
            stain_params("2", 3, STAIN_PRESETS[0]).unwrap()["pages"],
            json!([1])
        );
        assert!(stain_params("9", 3, STAIN_PRESETS[0]).is_none());
    }

    #[test]
    fn finger_brush_paints_erases_and_clips() {
        let mut m = FingerMask::new(20, 20);
        m.stamp_disc(10.0, 10.0, 3.0, 255);
        let painted = m.erased_pixels();
        assert!((20..=36).contains(&painted), "{painted}");
        assert_eq!(m.data[10 * 20 + 10], 255);
        m.stamp_disc(10.0, 10.0, 3.0, 0);
        assert_eq!(m.erased_pixels(), 0);
        m.stamp_disc(-50.0, -50.0, 3.0, 255); // ngoài mặt nạ
        m.stamp_disc(19.5, 19.5, 5.0, 255); // sát mép
        assert!(m.erased_pixels() > 0);
        let mut line = FingerMask::new(30, 10);
        line.stroke_line((2.0, 5.0), (27.0, 5.0), 2.0, 255);
        assert!(
            (3..27).all(|x| line.data[5 * 30 + x] == 255),
            "nét liền, không đứt"
        );
        let rgba = FingerMask::from_rgba(2, 1, &[200, 0, 0, 255, 10, 0, 0, 255]);
        assert_eq!(rgba.data, [255, 0]);
        assert_eq!(rgba.overlay_rgba()[..8], [255, 40, 40, 150, 0, 0, 0, 0]);
        assert_eq!(rgba.to_gray_rgba(), [255, 255, 255, 255, 0, 0, 0, 255]);
        assert_eq!(brush_radius_px(24.0, 1000), 24);
        assert_eq!(brush_radius_px(1.0, 1000), 4);
        assert_eq!(brush_radius_px(24.0, 10), 1);
        FingerMask::new(0, 0).stamp_disc(0.0, 0.0, 3.0, 255);
    }
    #[test]
    fn dewarp_params() {
        assert_eq!(
            dewarp_preview_params("", 5).unwrap()["pages"],
            json!([0, 1, 2])
        );
        assert!(dewarp_preview_params("0", 5).is_none());
        let a = dewarp_apply_params("2,4", 5).unwrap();
        assert_eq!(
            (&a["pages"], a["minConfidence"].as_f64()),
            (&json!([1, 3]), Some(0.35))
        );
        assert!(dewarp_apply_params("", 5).unwrap().get("pages").is_none());
        let d = json!({"pages":[{"pageIndex":1,"status":"review"},{"pageIndex":2,"status":"done"},{"pageIndex":4,"status":"review"},{"status":"review"}]});
        assert_eq!(dewarp_review_pages(&d), [1, 4]);
    }

    #[test]
    fn adjust_sends_only_changes() {
        let s = AdjustState::default();
        assert!(enhance_settings(&s).is_empty());
        let s = AdjustState {
            whiten: true,
            black: 10,
            curve: [0.0, 70.4, 128.0, 192.0, 255.0],
            dpi: " 300 ".into(),
            resize_page: true,
            invert: true,
            ..Default::default()
        };
        let m = enhance_settings(&s);
        assert_eq!(m["whitenStrength"], 0.8);
        assert_eq!(m["levels"], json!({"black":10,"white":255,"gamma":1.0}));
        assert_eq!(m["curve"][1], json!({"input":64,"output":70}));
        assert_eq!(
            (
                m["dpi"].as_u64(),
                m["resizePage"].as_bool(),
                m["invert"].as_bool()
            ),
            (Some(300), Some(true), Some(true))
        );
        assert!(!m.contains_key("denoise") && !m.contains_key("contrast"));
        // resizePage không đi một mình khi không có DPI
        let only = AdjustState {
            resize_page: true,
            ..Default::default()
        };
        assert!(enhance_settings(&only).is_empty());
    }

    #[test]
    fn adjust_validation_and_pages() {
        let bad_levels = AdjustState {
            black: 100,
            white: 100,
            ..Default::default()
        };
        assert!(adjust_apply_params(&bad_levels, "", 3).is_none());
        for dpi in ["49", "1201", "abc", "300.5"] {
            let s = AdjustState {
                dpi: dpi.into(),
                ..Default::default()
            };
            assert!(!dpi_valid(&s), "{dpi}");
            assert!(adjust_apply_params(&s, "", 3).is_none());
        }
        let s = AdjustState {
            grayscale: true,
            ..Default::default()
        };
        let p = adjust_apply_params(&s, "3, 1", 3).unwrap();
        assert_eq!(
            (&p["pages"], p["grayscale"].as_bool()),
            (&json!([0, 2]), Some(true))
        );
        assert!(adjust_apply_params(&s, "9", 3).is_none());
        assert!(
            adjust_apply_params(&s, "", 3)
                .unwrap()
                .get("pages")
                .is_none()
        );
        let with_dpi = AdjustState {
            dpi: "200".into(),
            whiten: true,
            ..Default::default()
        };
        let pv = adjust_preview_params(&with_dpi, 2).unwrap();
        assert_eq!((pv["pageIndex"].as_u64(), pv.get("dpi")), (Some(2), None));
        assert_eq!(pv["whiten"], true);
    }
}
