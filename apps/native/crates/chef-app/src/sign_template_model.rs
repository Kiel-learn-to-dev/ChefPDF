//! Mẫu chữ ký số (TASKS_RUST R6.11–R6.16; FEATURES I10–I18): port `templateModel.ts`. Mẫu là JSON của
//! lõi (`SignatureTemplate`). Giới hạn khớp `core/chef_core/signing/appearance.py`, nên mẫu lưu ở đây
//! luôn được lõi nhận: giá trị ngoài khoảng bị kẹp và ghi thành cảnh báo. Logic thuần.
#![allow(dead_code)]

use serde_json::{Map, Value, json};

pub const TEMPLATE_FORMAT: &str = "chef-sign-template";
pub const TEMPLATE_FORMAT_VERSION: u64 = 1;
pub const MAX_TEMPLATE_LINES: usize = 12;

pub const LAYOUTS: [&str; 4] = ["text-only", "image-left", "image-right", "image-background"];
pub const LINE_SOURCES: [&str; 9] = [
    "signerName",
    "organization",
    "taxCode",
    "citizenId",
    "reason",
    "location",
    "contact",
    "date",
    "custom",
];
pub const ALIGNS: [&str; 3] = ["left", "center", "right"];
pub const VALIGNS: [&str; 3] = ["top", "middle", "bottom"];
pub const FITS: [&str; 3] = ["contain", "cover", "stretch"];

const NAME_MAX: usize = 80;
const HEADER_MAX: usize = 120;
const LABEL_MAX: usize = 60;
const TEXT_MAX: usize = 500;
const DATE_FORMAT_MAX: usize = 80;
const FONT_SIZE: (f64, f64) = (2.0, 72.0);
const MIN_FONT_SIZE: (f64, f64) = (1.0, 72.0);
const LINE_FONT_SIZE: (f64, f64) = (1.0, 72.0);
const PADDING: (f64, f64) = (0.0, 60.0);
const BORDER_WIDTH: (f64, f64) = (0.1, 10.0);
const IMAGE_RATIO: (f64, f64) = (0.1, 0.9);
const OPACITY: (f64, f64) = (0.0, 1.0);

/// Mặc định của Python (`appearance.py` SignatureTemplate).
pub fn default_template(name: Option<&str>) -> Value {
    let mut t = json!({
        "name": "Mặc định", "layout": "text-only", "header": "Ký số bởi",
        "lines": [{"source":"signerName","enabled":true},{"source":"date","enabled":true}],
        "dateFormat": "dd/MM/yyyy HH:mm:ss", "showTimezone": false, "fontName": "BeVietnamPro",
        "fontSize": 9, "minFontSize": 5, "autoShrink": true, "bold": false, "textColor": "#000000",
        "align": "left", "valign": "middle", "padding": 4, "border": {"color":"#1F3A93","width":0.8},
        "background": {"color":"#FFFFFF","opacity":0}, "checkmark": false, "checkColor": "#1E8E3E",
        "imageRatio": 0.35,
    });
    if let Some(n) = name {
        t["name"] = n.into();
    }
    t
}

fn is_hex(v: &Value) -> Option<String> {
    v.as_str()
        .filter(|s| crate::overlay_common::is_hex_color(s))
        .map(str::to_uppercase)
}

fn num(
    v: Option<&Value>,
    range: (f64, f64),
    fallback: f64,
    w: &mut Vec<String>,
    what: &str,
) -> f64 {
    let Some(v) = v.filter(|v| !v.is_null()) else {
        return fallback;
    };
    let Some(n) = v.as_f64().filter(|n| n.is_finite()) else {
        w.push(format!("{what}: {v} is not a number"));
        return fallback;
    };
    let c = n.clamp(range.0, range.1);
    if c != n {
        w.push(format!("{what} limited to {}–{}", range.0, range.1));
    }
    c
}

/// Số JSON: số nguyên khi không có phần thập phân (khớp mặc định và JSON của lõi).
fn jn(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 1e15 {
        Value::from(x as i64)
    } else {
        Value::from(x)
    }
}

fn boolean(v: Option<&Value>, fallback: bool) -> bool {
    v.and_then(Value::as_bool).unwrap_or(fallback)
}

fn one_of(v: Option<&Value>, options: &[&str], fallback: &str) -> String {
    v.and_then(Value::as_str)
        .filter(|s| options.contains(s))
        .unwrap_or(fallback)
        .to_string()
}

fn color(v: Option<&Value>, fallback: &str, w: &mut Vec<String>, what: &str) -> String {
    match v.filter(|v| !v.is_null()) {
        None => fallback.into(),
        Some(v) => is_hex(v).unwrap_or_else(|| {
            w.push(format!("{what}: colour must look like #1F3A93"));
            fallback.into()
        }),
    }
}

fn slot(v: Option<&Value>, w: &mut Vec<String>, what: &str) -> Option<Value> {
    let v = v.filter(|v| !v.is_null())?;
    let Some(path) = v
        .get("path")
        .and_then(Value::as_str)
        .filter(|p| !p.is_empty())
    else {
        w.push(format!("{what}: needs a file"));
        return None;
    };
    Some(
        json!({"path": path, "fit": one_of(v.get("fit"), &FITS, "contain"),
        "opacity": jn(num(v.get("opacity"), OPACITY, 1.0, w, &format!("{what} opacity")))}),
    )
}

fn truncate(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

fn line(raw: &Value, w: &mut Vec<String>) -> Option<Value> {
    raw.as_object()?;
    let source = raw
        .get("source")?
        .as_str()
        .filter(|s| LINE_SOURCES.contains(s))?;
    let mut out = json!({"source": source, "enabled": boolean(raw.get("enabled"), true)});
    if let Some(l) = raw.get("label").and_then(Value::as_str) {
        out["label"] = truncate(l, LABEL_MAX).into();
    }
    if let Some(t) = raw.get("text").and_then(Value::as_str) {
        out["text"] = truncate(t, TEXT_MAX).into();
    }
    if raw.get("fontSize").is_some_and(|v| !v.is_null()) {
        out["fontSize"] = num(
            raw.get("fontSize"),
            LINE_FONT_SIZE,
            9.0,
            w,
            "line font size",
        )
        .into();
    }
    let has_text = out
        .get("text")
        .and_then(Value::as_str)
        .is_some_and(|t| !t.trim().is_empty());
    if source == "custom" && !has_text {
        // Lõi từ chối dòng tự đặt không có chữ: giữ lại nhưng tắt, và nói lý do.
        out["enabled"] = false.into();
        w.push("a custom line without text was turned off".into());
    }
    Some(out)
}

/// Mẫu hợp lệ và các thay đổi đã làm.
#[derive(Debug, Clone, PartialEq)]
pub struct Normalized {
    pub template: Value,
    pub warnings: Vec<String>,
}

/// Kẹp mọi trường vào giới hạn của lõi và điền mặc định. Không bao giờ lỗi.
pub fn normalize_template(raw: &Value) -> Normalized {
    let mut w: Vec<String> = Vec::new();
    if !raw.is_object() {
        return Normalized {
            template: default_template(None),
            warnings: vec!["template is not an object".into()],
        };
    }
    let d = default_template(None);
    let font_size = num(raw.get("fontSize"), FONT_SIZE, 9.0, &mut w, "font size");
    let mut min_font = num(
        raw.get("minFontSize"),
        MIN_FONT_SIZE,
        5.0,
        &mut w,
        "minimum font size",
    );
    if min_font > font_size {
        w.push("minimum font size cannot be larger than the font size".into());
        min_font = font_size;
    }
    let raw_lines: Vec<Value> = raw
        .get("lines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| d["lines"].as_array().cloned().unwrap_or_default());
    let mut lines = Vec::new();
    for item in raw_lines.iter().take(MAX_TEMPLATE_LINES) {
        match line(item, &mut w) {
            Some(l) => lines.push(l),
            None => w.push("an unknown line was removed".into()),
        }
    }
    if raw_lines.len() > MAX_TEMPLATE_LINES {
        w.push(format!("at most {MAX_TEMPLATE_LINES} lines"));
    }
    let date_format = raw
        .get("dateFormat")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.chars().count() <= DATE_FORMAT_MAX)
        .unwrap_or("dd/MM/yyyy HH:mm:ss");
    let mut t = Map::new();
    t.insert(
        "name".into(),
        raw.get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map_or_else(|| "Mặc định".into(), |s| truncate(s, NAME_MAX))
            .into(),
    );
    t.insert(
        "layout".into(),
        one_of(raw.get("layout"), &LAYOUTS, "text-only").into(),
    );
    t.insert(
        "header".into(),
        match raw.get("header") {
            Some(Value::Null) => Value::Null,
            Some(Value::String(s)) => truncate(s, HEADER_MAX).into(),
            _ => "Ký số bởi".into(),
        },
    );
    t.insert("lines".into(), Value::Array(lines));
    t.insert("dateFormat".into(), date_format.into());
    t.insert(
        "showTimezone".into(),
        boolean(raw.get("showTimezone"), false).into(),
    );
    t.insert("fontName".into(), "BeVietnamPro".into());
    t.insert("fontSize".into(), jn(font_size));
    t.insert("minFontSize".into(), jn(min_font));
    t.insert(
        "autoShrink".into(),
        boolean(raw.get("autoShrink"), true).into(),
    );
    t.insert("bold".into(), boolean(raw.get("bold"), false).into());
    t.insert(
        "textColor".into(),
        color(raw.get("textColor"), "#000000", &mut w, "text colour").into(),
    );
    t.insert(
        "align".into(),
        one_of(raw.get("align"), &ALIGNS, "left").into(),
    );
    t.insert(
        "valign".into(),
        one_of(raw.get("valign"), &VALIGNS, "middle").into(),
    );
    t.insert(
        "padding".into(),
        jn(num(raw.get("padding"), PADDING, 4.0, &mut w, "padding")),
    );
    t.insert(
        "checkmark".into(),
        boolean(raw.get("checkmark"), false).into(),
    );
    t.insert(
        "checkColor".into(),
        color(raw.get("checkColor"), "#1E8E3E", &mut w, "check colour").into(),
    );
    t.insert(
        "imageRatio".into(),
        num(
            raw.get("imageRatio"),
            IMAGE_RATIO,
            0.35,
            &mut w,
            "image share",
        )
        .into(),
    );
    match raw.get("border") {
        Some(Value::Null) => {
            t.insert("border".into(), Value::Null);
        }
        Some(b) if b.is_object() => {
            t.insert(
                "border".into(),
                json!({"color": color(b.get("color"), "#1F3A93", &mut w, "border colour"),
                       "width": jn(num(b.get("width"), BORDER_WIDTH, 0.8, &mut w, "border width"))}),
            );
        }
        _ => {
            t.insert("border".into(), d["border"].clone());
        }
    }
    match raw.get("background") {
        Some(b) if b.is_object() => {
            t.insert(
                "background".into(),
                json!({"color": color(b.get("color"), "#FFFFFF", &mut w, "background colour"),
                       "opacity": jn(num(b.get("opacity"), OPACITY, 0.0, &mut w, "background opacity"))}),
            );
        }
        _ => {
            t.insert("background".into(), d["background"].clone());
        }
    }
    if let Some(s) = slot(raw.get("image"), &mut w, "image") {
        t.insert("image".into(), s);
    }
    if let Some(s) = slot(raw.get("logo"), &mut w, "logo") {
        t.insert("logo".into(), s);
    }
    Normalized {
        template: Value::Object(t),
        warnings: w,
    }
}

/// Dạng gửi lõi: bỏ `image` và `logo`, vì đường dẫn chỉ đúng khi studio đang mở (mục thư viện mới là
/// tham chiếu lưu).
pub fn to_wire(template: &Value) -> Value {
    let mut t = template.clone();
    if let Some(o) = t.as_object_mut() {
        o.remove("image");
        o.remove("logo");
    }
    t
}

/// Từ dữ liệu lưu: qua `normalize` để dữ liệu lưu luôn hợp lệ.
pub fn from_wire(raw: &Value) -> Value {
    normalize_template(raw).template
}

/// Chuyển dòng `from` đến `to` (ngoài phạm vi thì không đổi).
pub fn move_line(lines: &[Value], from: usize, to: usize) -> Vec<Value> {
    let mut v = lines.to_vec();
    if from < v.len() && to < v.len() && from != to {
        let m = v.remove(from);
        v.insert(to, m);
    }
    v
}

/// Dòng trống mới cho một nguồn (dòng tự đặt có chữ gợi ý).
pub fn new_line(source: &str) -> Value {
    if source == "custom" {
        json!({"source": source, "enabled": true, "text": "Thông tin tùy ý"})
    } else {
        json!({"source": source, "enabled": true})
    }
}

/// File "Xuất mẫu" ghi và "Nhập mẫu" đọc.
pub fn template_file_text(template: &Value) -> String {
    serde_json::to_string_pretty(&json!({"format": TEMPLATE_FORMAT, "version": TEMPLATE_FORMAT_VERSION, "template": to_wire(template)}))
        .expect("JSON hợp lệ")
        + "\n"
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FileError {
    BadJson,
    NotATemplate,
    UnsupportedVersion,
}

/// Đọc file mẫu (khung bao ở trên hoặc một đối tượng mẫu trần).
pub fn parse_template_file(text: &str) -> Result<Normalized, FileError> {
    let parsed: Value = serde_json::from_str(text).map_err(|_| FileError::BadJson)?;
    if !parsed.is_object() {
        return Err(FileError::NotATemplate);
    }
    if parsed.get("format").and_then(Value::as_str) == Some(TEMPLATE_FORMAT) {
        if parsed.get("version").and_then(Value::as_u64) != Some(TEMPLATE_FORMAT_VERSION) {
            return Err(FileError::UnsupportedVersion);
        }
        return Ok(normalize_template(
            parsed.get("template").unwrap_or(&Value::Null),
        ));
    }
    if ["layout", "lines", "fontSize"]
        .iter()
        .any(|k| parsed.get(k).is_some())
    {
        return Ok(normalize_template(&parsed));
    }
    Err(FileError::NotATemplate)
}

// ---- Ngày giờ ----

/// Thời điểm cục bộ để định dạng, kèm độ lệch múi giờ.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DateParts {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
    /// Phút lệch so với UTC (+420 cho UTC+7).
    pub offset_min: i32,
}

/// Định dạng ngày theo mẫu của lõi (`appearance.py format_date`): yyyy yy MM M dd d HH H mm m ss s; chữ
/// trong nháy đơn là nguyên văn (`''` là một dấu nháy). `show_timezone` thêm " (UTC+07:00)".
pub fn format_date_pattern(d: &DateParts, pattern: &str, show_timezone: bool) -> String {
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let run = |i: usize, c: char| chars[i..].iter().take_while(|x| **x == c).count();
    while i < chars.len() {
        let c = chars[i];
        if c == '\'' {
            let mut j = i + 1;
            let mut lit = String::new();
            let mut closed = false;
            while j < chars.len() {
                if chars[j] == '\'' {
                    if chars.get(j + 1) == Some(&'\'') {
                        lit.push('\'');
                        j += 2;
                        continue;
                    }
                    closed = true;
                    break;
                }
                lit.push(chars[j]);
                j += 1;
            }
            if closed {
                out.push_str(&lit);
                i = j + 1;
            } else {
                out.push(c);
                i += 1;
            }
            continue;
        }
        let (n, text) = match c {
            'y' => match run(i, 'y') {
                n if n >= 4 => (4, format!("{:04}", d.year)),
                n if n >= 2 => (2, format!("{:02}", d.year.rem_euclid(100))),
                _ => (1, "y".into()),
            },
            'M' => {
                if run(i, 'M') >= 2 {
                    (2, format!("{:02}", d.month))
                } else {
                    (1, d.month.to_string())
                }
            }
            'd' => {
                if run(i, 'd') >= 2 {
                    (2, format!("{:02}", d.day))
                } else {
                    (1, d.day.to_string())
                }
            }
            'H' => {
                if run(i, 'H') >= 2 {
                    (2, format!("{:02}", d.hour))
                } else {
                    (1, d.hour.to_string())
                }
            }
            'm' => {
                if run(i, 'm') >= 2 {
                    (2, format!("{:02}", d.minute))
                } else {
                    (1, d.minute.to_string())
                }
            }
            's' => {
                if run(i, 's') >= 2 {
                    (2, format!("{:02}", d.second))
                } else {
                    (1, d.second.to_string())
                }
            }
            other => (1, other.to_string()),
        };
        out.push_str(&text);
        i += n;
    }
    if show_timezone {
        let m = d.offset_min;
        let sign = if m >= 0 { '+' } else { '-' };
        out.push_str(&format!(
            " (UTC{sign}{:02}:{:02})",
            m.abs() / 60,
            m.abs() % 60
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d() -> DateParts {
        DateParts {
            year: 2026,
            month: 1,
            day: 5,
            hour: 9,
            minute: 7,
            second: 3,
            offset_min: 420,
        }
    }

    #[test]
    fn dates_follow_core_tokens() {
        assert_eq!(
            format_date_pattern(&d(), "dd/MM/yyyy HH:mm:ss", false),
            "05/01/2026 09:07:03"
        );
        assert_eq!(
            format_date_pattern(&d(), "d/M/yy H:m:s", false),
            "5/1/26 9:7:3"
        );
        assert_eq!(
            format_date_pattern(&d(), "'Ngày' d 'tháng' M 'năm' yyyy", false),
            "Ngày 5 tháng 1 năm 2026"
        );
        assert_eq!(format_date_pattern(&d(), "'it''s' HH", false), "it's 09");
        assert_eq!(
            format_date_pattern(&d(), "dd/MM/yyyy", true),
            "05/01/2026 (UTC+07:00)"
        );
        let w = DateParts {
            offset_min: -330,
            ..d()
        };
        assert_eq!(format_date_pattern(&w, "HH", true), "09 (UTC-05:30)");
        assert_eq!(
            format_date_pattern(&d(), "'mở", false),
            "'7ở",
            "nháy không đóng: dấu nháy giữ nguyên, m vẫn là phút"
        );
    }

    #[test]
    fn defaults_and_normalisation() {
        let n = normalize_template(&json!(5));
        assert_eq!((n.template, n.warnings.len()), (default_template(None), 1));
        let ok = normalize_template(&default_template(Some("Mẫu A")));
        assert!(ok.warnings.is_empty(), "{:?}", ok.warnings);
        assert_eq!(ok.template["name"], "Mẫu A");
        let n = normalize_template(
            &json!({"fontSize": 500, "minFontSize": 80, "padding": -3, "imageRatio": "x",
            "textColor": "red", "layout": "weird", "align": "center", "border": null,
            "background": {"color": "#abc", "opacity": 3}}),
        );
        let t = &n.template;
        assert_eq!(
            (
                t["fontSize"].as_f64(),
                t["minFontSize"].as_f64(),
                t["padding"].as_f64(),
                t["imageRatio"].as_f64()
            ),
            (Some(72.0), Some(72.0), Some(0.0), Some(0.35))
        );
        assert_eq!(
            (
                t["textColor"].as_str(),
                t["layout"].as_str(),
                t["align"].as_str(),
                t["border"].is_null()
            ),
            (Some("#000000"), Some("text-only"), Some("center"), true)
        );
        assert_eq!(
            (
                t["background"]["color"].as_str(),
                t["background"]["opacity"].as_f64()
            ),
            (Some("#FFFFFF"), Some(1.0))
        );
        assert!(n.warnings.len() >= 6);
    }

    #[test]
    fn lines_are_validated() {
        let many: Vec<Value> = (0..15).map(|_| json!({"source":"date"})).collect();
        let n = normalize_template(&json!({"lines": many}));
        assert_eq!(
            n.template["lines"].as_array().unwrap().len(),
            MAX_TEMPLATE_LINES
        );
        assert!(n.warnings.iter().any(|w| w.contains("at most 12")));
        let n = normalize_template(
            &json!({"lines":[{"source":"custom","text":"  "},{"source":"nope"},7,{"source":"reason","label":"Lý do","fontSize":200}]}),
        );
        let l = n.template["lines"].as_array().unwrap();
        assert_eq!(l.len(), 2);
        assert_eq!(
            (
                l[0]["enabled"].as_bool(),
                l[1]["fontSize"].as_f64(),
                l[1]["label"].as_str()
            ),
            (Some(false), Some(72.0), Some("Lý do"))
        );
        assert_eq!(
            n.warnings
                .iter()
                .filter(|w| w.contains("unknown line"))
                .count(),
            2
        );
        let none = normalize_template(&json!({"lines": "x"}));
        assert_eq!(
            none.template["lines"].as_array().unwrap().len(),
            2,
            "lines sai kiểu: dùng mặc định"
        );
    }

    #[test]
    fn image_slots_and_wire() {
        let n = normalize_template(
            &json!({"image":{"path":"/s.png","fit":"zzz","opacity":2},"logo":{"path":""}}),
        );
        assert_eq!(
            (
                n.template["image"]["fit"].as_str(),
                n.template["image"]["opacity"].as_f64()
            ),
            (Some("contain"), Some(1.0))
        );
        assert!(n.template.get("logo").is_none());
        assert!(
            n.warnings
                .iter()
                .any(|w| w.starts_with("logo: needs a file"))
        );
        let w = to_wire(&n.template);
        assert!(w.get("image").is_none() && w.get("logo").is_none());
        assert_eq!(
            from_wire(&json!({"fontSize": 1}))
                .get("fontSize")
                .and_then(Value::as_f64),
            Some(2.0)
        );
    }

    #[test]
    fn lines_move_and_new_line() {
        let l = vec![json!(1), json!(2), json!(3)];
        assert_eq!(move_line(&l, 0, 2), [json!(2), json!(3), json!(1)]);
        assert_eq!(move_line(&l, 0, 9), l);
        assert_eq!(move_line(&l, 1, 1), l);
        assert_eq!(new_line("custom")["text"], "Thông tin tùy ý");
        assert!(new_line("date").get("text").is_none());
    }

    #[test]
    fn export_import_round_trip() {
        let t = default_template(Some("Mẫu B"));
        let text = template_file_text(&t);
        assert!(text.ends_with("}\n"));
        let back = parse_template_file(&text).unwrap();
        assert_eq!((back.template, back.warnings.is_empty()), (t.clone(), true));
        let bare = parse_template_file(&serde_json::to_string(&t).unwrap()).unwrap();
        assert_eq!(bare.template["name"], "Mẫu B");
        assert_eq!(parse_template_file("{"), Err(FileError::BadJson));
        assert_eq!(parse_template_file("[1]"), Err(FileError::NotATemplate));
        assert_eq!(
            parse_template_file(r#"{"hello":1}"#),
            Err(FileError::NotATemplate)
        );
        assert_eq!(
            parse_template_file(r#"{"format":"chef-sign-template","version":9,"template":{}}"#),
            Err(FileError::UnsupportedVersion)
        );
    }
}
