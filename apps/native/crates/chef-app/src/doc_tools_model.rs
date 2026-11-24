//! Thuộc tính và tiện ích tài liệu (TASKS_RUST R5.18–R5.22; FEATURES M7–M11): port `docToolsModel.ts`.
//! Metadata, file đính kèm, trích ảnh và chữ, tối ưu cho web, sửa file hỏng. Logic thuần.
#![allow(dead_code)]

use serde_json::{Map, Value, json};

// ---- Metadata (M9) ----

/// Khóa Info chuẩn theo thứ tự của form; khóa của lõi trùng tên.
pub const STANDARD_KEYS: [&str; 8] = [
    "Title",
    "Author",
    "Subject",
    "Keywords",
    "Creator",
    "Producer",
    "CreationDate",
    "ModDate",
];
const WIRE: [&str; 8] = [
    "title",
    "author",
    "subject",
    "keywords",
    "creator",
    "producer",
    "creationDate",
    "modDate",
];
const DATE_KEYS: [usize; 2] = [6, 7];
pub const MAX_CUSTOM: usize = 30;
pub const MAX_VALUE: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MetadataForm {
    /// Theo thứ tự `STANDARD_KEYS`.
    pub standard: [String; 8],
    pub custom: Vec<(String, String)>,
}

/// Form từ giá trị Info của tài liệu; khóa lạ thành khóa tự đặt.
pub fn form_from_metadata(metadata: &[(String, String)]) -> MetadataForm {
    let mut f = MetadataForm::default();
    for (k, v) in metadata {
        match STANDARD_KEYS.iter().position(|s| s == k) {
            Some(i) => f.standard[i] = v.clone(),
            None => f.custom.push((k.clone(), v.clone())),
        }
    }
    f
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetadataProblem {
    CustomKey,
    DuplicateKey,
    CustomLimit,
    Date,
    Length,
}

/// Ngày ISO: `YYYY-MM-DD`, tùy chọn `THH:MM[:SS[.f+]]` và múi giờ `Z` hoặc `±HH[:]MM`.
pub fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    let digits =
        |r: std::ops::Range<usize>| b.get(r).is_some_and(|x| x.iter().all(u8::is_ascii_digit));
    if !(digits(0..4)
        && b.get(4) == Some(&b'-')
        && digits(5..7)
        && b.get(7) == Some(&b'-')
        && digits(8..10))
    {
        return false;
    }
    if b.len() == 10 {
        return true;
    }
    if b.get(10) != Some(&b'T') || !(digits(11..13) && b.get(13) == Some(&b':') && digits(14..16)) {
        return false;
    }
    let mut i = 16;
    if b.get(i) == Some(&b':') {
        if !digits(i + 1..i + 3) {
            return false;
        }
        i += 3;
        if b.get(i) == Some(&b'.') {
            let start = i + 1;
            while b.get(i + 1).is_some_and(u8::is_ascii_digit) {
                i += 1;
            }
            if i + 1 == start {
                return false;
            }
            i += 1;
        }
    }
    match &b[i..] {
        [] | [b'Z'] => true,
        [b'+' | b'-', rest @ ..] => {
            let r: Vec<u8> = rest.iter().copied().filter(|c| *c != b':').collect();
            (rest.len() == 4 || (rest.len() == 5 && rest[2] == b':'))
                && r.len() == 4
                && r.iter().all(u8::is_ascii_digit)
        }
        _ => false,
    }
}

pub fn metadata_problem(f: &MetadataForm) -> Option<MetadataProblem> {
    for i in DATE_KEYS {
        let v = f.standard[i].trim();
        if !v.is_empty() && !is_iso_date(v) {
            return Some(MetadataProblem::Date);
        }
    }
    if f.standard
        .iter()
        .any(|v| v.encode_utf16().count() > MAX_VALUE)
    {
        return Some(MetadataProblem::Length);
    }
    if f.custom.len() > MAX_CUSTOM {
        return Some(MetadataProblem::CustomLimit);
    }
    let mut seen: Vec<&str> = Vec::new();
    for (k, v) in &f.custom {
        let key = k.trim();
        if key.is_empty()
            || key
                .chars()
                .any(|c| c.is_whitespace() || "/()<>[]{}%".contains(c))
            || key.encode_utf16().count() > 64
            || STANDARD_KEYS.contains(&key)
        {
            return Some(MetadataProblem::CustomKey);
        }
        if seen.contains(&key) {
            return Some(MetadataProblem::DuplicateKey);
        }
        seen.push(key);
        if v.encode_utf16().count() > MAX_VALUE {
            return Some(MetadataProblem::Length);
        }
    }
    None
}

/// `doc.setMetadata`. Giá trị rỗng là xóa khóa; `clear` xóa mọi thuộc tính trước.
pub fn metadata_params(f: &MetadataForm, clear: bool) -> Value {
    if clear {
        return json!({"clear": true});
    }
    let mut m = Map::new();
    for (w, v) in WIRE.iter().zip(&f.standard) {
        m.insert((*w).into(), v.trim().into());
    }
    let mut custom = Map::new();
    for (k, v) in &f.custom {
        let key = k.trim();
        if !key.is_empty() {
            custom.insert(key.into(), v.trim().into());
        }
    }
    m.insert("custom".into(), Value::Object(custom));
    Value::Object(m)
}

// ---- File đính kèm (M8) ----

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentRow {
    pub name: String,
    pub size: u64,
    pub description: String,
}

/// Sắp theo tên không phân biệt hoa thường, giữ thứ tự của lõi khi trùng tên.
pub fn sort_attachments(rows: &[AttachmentRow]) -> Vec<AttachmentRow> {
    let mut v = rows.to_vec();
    v.sort_by_key(|r| r.name.to_lowercase());
    v
}

/// Tên cần xử lý: phần đã chọn, hoặc mọi file khi chưa chọn gì.
pub fn attachment_names(rows: &[AttachmentRow], selected: &[String]) -> Vec<String> {
    rows.iter()
        .filter(|r| selected.is_empty() || selected.contains(&r.name))
        .map(|r| r.name.clone())
        .collect()
}

// ---- Trích ảnh và chữ (M7) ----

pub const DEFAULT_IMAGE_TEMPLATE: &str = "{page}_{index}";

/// Ô trang gõ sai.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BadPages;

/// Ô trang "1,3-5": từ 0; rỗng là mọi trang (`Ok(None)`); `Err` khi sai.
pub fn pages_from_field(input: &str, page_count: usize) -> Result<Option<Vec<usize>>, BadPages> {
    if input.trim().is_empty() {
        return Ok(None);
    }
    crate::page_range::parse_page_ranges(input, page_count)
        .map(|p| Some(p.pages))
        .map_err(|_| BadPages)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemplateProblem {
    Empty,
    Separator,
    InvalidChars,
    Long,
}

/// Mẫu tên ảnh: tên file không đuôi.
pub fn image_template_problem(t: &str) -> Option<TemplateProblem> {
    if t.trim().is_empty() {
        Some(TemplateProblem::Empty)
    } else if t.contains(['\\', '/']) {
        Some(TemplateProblem::Separator)
    } else if t
        .chars()
        .any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || (c as u32) < 32)
    {
        Some(TemplateProblem::InvalidChars)
    } else if t.encode_utf16().count() > 80 {
        Some(TemplateProblem::Long)
    } else {
        None
    }
}

pub fn extract_images_params(
    output_dir: &str,
    pages: Option<&[usize]>,
    name_template: &str,
) -> Value {
    let mut v = json!({"outputDir": output_dir, "nameTemplate": name_template.trim()});
    if let Some(p) = pages {
        v["pages"] = json!(p);
    }
    v
}

pub fn extract_text_params(output_path: &str, page_markers: bool) -> Value {
    json!({"outputPath": output_path, "pageMarkers": page_markers})
}

// ---- Tối ưu cho web (M10) ----

/// File đã lưu của tài liệu đang mở, hoặc None khi phải lưu trước. Tài liệu đã ký không bao giờ bị
/// ghi lại: tuyến tính hóa sẽ phá chữ ký.
pub fn web_source_path(source_path: Option<&str>, dirty: bool, signed: bool) -> Option<&str> {
    source_path.filter(|_| !dirty && !signed)
}

/// Phần trăm dung lượng tiết kiệm (0 khi không nhỏ hơn hoặc chưa biết cỡ).
pub fn saved_percent(before: u64, after: u64) -> u32 {
    if before == 0 || after >= before {
        0
    } else {
        ((before - after) as f64 / before as f64 * 100.0).round() as u32
    }
}

// ---- Sửa file hỏng (M11) ----

/// Tên file sửa: "<tên>_sua.pdf" cạnh file hỏng.
pub fn repair_output_path(input: &str) -> String {
    let slash = input.rfind(['/', '\\']);
    let (dir, name) = match slash {
        Some(i) => (&input[..=i], &input[i + 1..]),
        None => ("", input),
    };
    let stem = if name.to_lowercase().ends_with(".pdf") {
        &name[..name.len() - 4]
    } else {
        name
    };
    format!("{dir}{stem}_sua.pdf")
}

pub fn repair_params(input: &str, output: &str) -> Value {
    json!({"inputPath": input, "outputPath": output})
}

/// Kết quả `doc.repair`: có phục hồi không, số trang, cảnh báo.
pub fn parse_repair_data(d: &Value) -> (bool, u64, Vec<String>) {
    (
        d.get("recovered").and_then(Value::as_bool) == Some(true),
        d.get("pageCount").and_then(Value::as_u64).unwrap_or(0),
        d.get("warnings")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|w| w.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_dates() {
        for ok in [
            "2026-11-23",
            "2026-11-23T10:30",
            "2026-11-23T10:30:05",
            "2026-11-23T10:30:05.123Z",
            "2026-11-23T10:30+07:00",
            "2026-11-23T10:30:00-0500",
        ] {
            assert!(is_iso_date(ok), "{ok}");
        }
        for bad in [
            "",
            "23/11/2026",
            "2026-1-1",
            "2026-11-23T10",
            "2026-11-23T10:30:",
            "2026-11-23T10:30:00.",
            "2026-11-23T10:30+7",
            "2026-11-23 10:30",
            "2026-11-23T10:30Zx",
        ] {
            assert!(!is_iso_date(bad), "{bad}");
        }
    }

    #[test]
    fn metadata_form_and_problems() {
        let f = form_from_metadata(&[
            ("Title".into(), "Hợp đồng".into()),
            ("DuAn".into(), "X".into()),
            ("ModDate".into(), "2026-01-01".into()),
        ]);
        assert_eq!(
            (
                f.standard[0].as_str(),
                f.standard[7].as_str(),
                f.custom.clone()
            ),
            (
                "Hợp đồng",
                "2026-01-01",
                vec![("DuAn".to_string(), "X".to_string())]
            )
        );
        assert_eq!(metadata_problem(&f), None);
        let bad_date = MetadataForm {
            standard: ["", "", "", "", "", "", "1/1/2026", ""].map(String::from),
            ..Default::default()
        };
        assert_eq!(metadata_problem(&bad_date), Some(MetadataProblem::Date));
        let custom = |k: &str| MetadataForm {
            custom: vec![(k.into(), "v".into())],
            ..Default::default()
        };
        assert_eq!(
            metadata_problem(&custom("a b")),
            Some(MetadataProblem::CustomKey)
        );
        assert_eq!(
            metadata_problem(&custom("Title")),
            Some(MetadataProblem::CustomKey)
        );
        assert_eq!(
            metadata_problem(&custom("  ")),
            Some(MetadataProblem::CustomKey)
        );
        assert_eq!(
            metadata_problem(&custom("a/b")),
            Some(MetadataProblem::CustomKey)
        );
        assert_eq!(
            metadata_problem(&custom(&"k".repeat(65))),
            Some(MetadataProblem::CustomKey)
        );
        let dup = MetadataForm {
            custom: vec![("a".into(), "1".into()), (" a ".into(), "2".into())],
            ..Default::default()
        };
        assert_eq!(metadata_problem(&dup), Some(MetadataProblem::DuplicateKey));
        let many = MetadataForm {
            custom: (0..31).map(|i| (format!("k{i}"), String::new())).collect(),
            ..Default::default()
        };
        assert_eq!(metadata_problem(&many), Some(MetadataProblem::CustomLimit));
        let long = MetadataForm {
            standard: [
                "x".repeat(2001),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
                String::new(),
            ],
            ..Default::default()
        };
        assert_eq!(metadata_problem(&long), Some(MetadataProblem::Length));
    }

    #[test]
    fn metadata_params_trim_and_clear() {
        assert_eq!(
            metadata_params(&MetadataForm::default(), true),
            json!({"clear": true})
        );
        let f = MetadataForm {
            standard: [" Tiêu đề ", "", "", "", "", "", "", ""].map(String::from),
            custom: vec![(" k ".into(), " v ".into()), (" ".into(), "x".into())],
        };
        let v = metadata_params(&f, false);
        assert_eq!(
            (v["title"].as_str(), v["author"].as_str(), &v["custom"]),
            (Some("Tiêu đề"), Some(""), &json!({"k":"v"}))
        );
    }

    #[test]
    fn attachments_extract_and_web() {
        let row = |n: &str| AttachmentRow {
            name: n.into(),
            size: 1,
            description: String::new(),
        };
        let rows = [row("b.txt"), row("A.pdf"), row("c.png")];
        assert_eq!(
            sort_attachments(&rows)
                .iter()
                .map(|r| r.name.as_str())
                .collect::<Vec<_>>(),
            ["A.pdf", "b.txt", "c.png"]
        );
        assert_eq!(attachment_names(&rows, &[]).len(), 3);
        assert_eq!(
            attachment_names(&rows, &["c.png".into(), "zz".into()]),
            ["c.png"]
        );
        assert_eq!(pages_from_field("", 5), Ok(None));
        assert_eq!(pages_from_field("1,3-4", 5), Ok(Some(vec![0, 2, 3])));
        assert_eq!(pages_from_field("9", 5), Err(BadPages));
        assert_eq!(image_template_problem(DEFAULT_IMAGE_TEMPLATE), None);
        assert_eq!(
            image_template_problem("a/b"),
            Some(TemplateProblem::Separator)
        );
        assert_eq!(
            image_template_problem("a?"),
            Some(TemplateProblem::InvalidChars)
        );
        assert_eq!(
            image_template_problem(&"x".repeat(81)),
            Some(TemplateProblem::Long)
        );
        assert_eq!(image_template_problem(" "), Some(TemplateProblem::Empty));
        let v = extract_images_params("/o", Some(&[0, 2]), " {page} ");
        assert_eq!(
            (&v["pages"], v["nameTemplate"].as_str()),
            (&json!([0, 2]), Some("{page}"))
        );
        assert!(
            extract_images_params("/o", None, "x")
                .get("pages")
                .is_none()
        );
        assert_eq!(extract_text_params("/t.txt", true)["pageMarkers"], true);
        assert_eq!(
            web_source_path(Some("/a.pdf"), false, false),
            Some("/a.pdf")
        );
        assert_eq!(
            (
                web_source_path(Some("/a.pdf"), true, false),
                web_source_path(Some("/a.pdf"), false, true),
                web_source_path(None, false, false)
            ),
            (None, None, None)
        );
        assert_eq!(
            (
                saved_percent(1000, 400),
                saved_percent(1000, 1000),
                saved_percent(0, 0)
            ),
            (60, 0, 0)
        );
    }

    #[test]
    fn repair() {
        assert_eq!(repair_output_path("C:\\x\\Hỏng.PDF"), "C:\\x\\Hỏng_sua.pdf");
        assert_eq!(repair_output_path("/a/b/file"), "/a/b/file_sua.pdf");
        assert_eq!(repair_output_path("f.pdf"), "f_sua.pdf");
        assert_eq!(repair_params("/i", "/o")["inputPath"], "/i");
        assert_eq!(
            parse_repair_data(&json!({"recovered":true,"pageCount":4,"warnings":["w",2]})),
            (true, 4, vec!["w".to_string()])
        );
        assert_eq!(parse_repair_data(&Value::Null), (false, 0, vec![]));
    }
}
