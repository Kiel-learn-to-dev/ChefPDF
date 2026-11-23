//! Tìm và thay thế chữ trên cả tài liệu (TASKS_RUST R7.10, FEATURES D10): port
//! `findReplaceModel.ts`. Form, tham số `text.findReplace`, gom kết quả xem trước theo trang, tóm tắt
//! lần chạy. Lõi thay mọi chỗ trong các trang đã chọn (không loại trừ từng chỗ). Logic thuần.
#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};

use crate::scan_convert::parse_pages;
use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FindForm {
    pub find: String,
    pub replace: String,
    pub case_sensitive: bool,
    pub ignore_diacritics: bool,
    pub whole_word: bool,
    pub regex: bool,
    /// `false` = mọi trang; `true` = khoảng trong `page_range` (từ 1).
    pub only_pages: bool,
    pub page_range: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormError {
    FindRequired,
    InvalidRegex,
    PageRange,
}

/// Lỗi đầu tiên của form, hoặc None khi chạy được. `regex_ok` kiểm biểu thức chính quy (bên gọi
/// quyết định bộ máy; lõi vẫn kiểm lại và trả `INVALID_REGEX`).
pub fn validate_form(
    f: &FindForm,
    page_count: usize,
    regex_ok: &dyn Fn(&str) -> bool,
) -> Option<FormError> {
    if f.find.is_empty() {
        Some(FormError::FindRequired)
    } else if f.regex && !regex_ok(&f.find) {
        Some(FormError::InvalidRegex)
    } else if f.only_pages && parse_pages(&f.page_range, page_count).is_none() {
        Some(FormError::PageRange)
    } else {
        None
    }
}

/// `text.findReplace`; trang từ 0, đã sắp; không có `pages` nghĩa là mọi trang.
pub fn build_params(f: &FindForm, page_count: usize, preview: bool) -> Value {
    let mut v = json!({
        "find": f.find, "replace": f.replace,
        "caseSensitive": f.case_sensitive, "ignoreDiacritics": f.ignore_diacritics,
        "wholeWord": f.whole_word, "regex": f.regex, "preview": preview,
        "fontStrategy": "auto", "keepStyle": true, "fitWidth": "none",
    });
    if f.only_pages {
        if let Some(p) = parse_pages(&f.page_range, page_count) {
            v["pages"] = json!(p);
        }
    }
    v
}

#[derive(Debug, Clone, PartialEq)]
pub struct Match {
    pub page_index: u64,
    pub line_id: String,
    pub before: String,
    pub after: String,
    /// [trái, trên, phải, dưới] của các ký tự khớp, pt.
    pub rect: [f64; 4],
}

#[derive(Debug, Clone, PartialEq)]
pub struct Data {
    pub matches: Vec<Match>,
    pub replaced: u64,
    /// (trang, dòng, từ font, sang font)
    pub font_substitutions: Vec<(u64, String, String, String)>,
    /// (trang, dòng, lý do)
    pub skipped: Vec<(u64, String, String)>,
    pub preview: bool,
}

/// Đọc kết quả của lõi; chỗ khớp thiếu trường bị bỏ.
pub fn parse_data(d: &Value) -> Data {
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(String::from);
    let list = |k: &str| {
        d.get(k)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    Data {
        matches: list("matches")
            .iter()
            .filter_map(|m| {
                let r = m.get("rect")?.as_array()?;
                let rect: [f64; 4] = [
                    r.first()?.as_f64()?,
                    r.get(1)?.as_f64()?,
                    r.get(2)?.as_f64()?,
                    r.get(3)?.as_f64()?,
                ];
                Some(Match {
                    page_index: m.get("pageIndex")?.as_u64()?,
                    line_id: s(m, "lineId")?,
                    before: s(m, "before").unwrap_or_default(),
                    after: s(m, "after").unwrap_or_default(),
                    rect,
                })
            })
            .collect(),
        replaced: d.get("replaced").and_then(Value::as_u64).unwrap_or(0),
        font_substitutions: list("fontSubstitutions")
            .iter()
            .filter_map(|x| {
                Some((
                    x.get("pageIndex")?.as_u64()?,
                    s(x, "lineId")?,
                    s(x, "from")?,
                    s(x, "to")?,
                ))
            })
            .collect(),
        skipped: list("skipped")
            .iter()
            .filter_map(|x| {
                Some((
                    x.get("pageIndex")?.as_u64()?,
                    s(x, "lineId")?,
                    s(x, "reason")?,
                ))
            })
            .collect(),
        preview: d.get("preview").and_then(Value::as_bool).unwrap_or(false),
    }
}

/// Kết quả xem trước gom theo trang tăng dần, giữ thứ tự trong trang.
pub fn group_by_page(matches: &[Match]) -> Vec<(u64, Vec<&Match>)> {
    let mut by: BTreeMap<u64, Vec<&Match>> = BTreeMap::new();
    for m in matches {
        by.entry(m.page_index).or_default().push(m);
    }
    by.into_iter().collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Summary {
    pub replaced: u64,
    pub pages: Vec<u64>,
    pub substitutions: usize,
    pub skipped_by_reason: BTreeMap<String, usize>,
    pub fonts: Vec<String>,
}

pub fn summarize(d: &Data) -> Summary {
    let mut skipped_by_reason = BTreeMap::new();
    for (_, _, reason) in &d.skipped {
        *skipped_by_reason.entry(reason.clone()).or_insert(0) += 1;
    }
    Summary {
        replaced: d.replaced,
        pages: d
            .matches
            .iter()
            .map(|m| m.page_index)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        substitutions: d.font_substitutions.len(),
        skipped_by_reason,
        fonts: d
            .font_substitutions
            .iter()
            .map(|s| s.3.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
    }
}

/// Khung tô sáng của các chỗ khớp xem trước: (trang, hình chữ nhật).
pub fn highlights(matches: &[Match]) -> Vec<(u64, [f64; 4])> {
    matches.iter().map(|m| (m.page_index, m.rect)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data() -> Data {
        parse_data(&json!({
            "replaced": 3, "preview": true,
            "matches": [
                {"pageIndex":2,"lineId":"a","before":"x","after":"y","rect":[1,2,3,4]},
                {"pageIndex":0,"lineId":"b","before":"x","after":"y","rect":[1,2,3,4]},
                {"pageIndex":2,"lineId":"c","rect":[5,6,7,8]},
                {"pageIndex":1,"lineId":"d","rect":[1,2]}],
            "fontSubstitutions":[{"pageIndex":0,"lineId":"b","from":"A","to":"Arial"},{"pageIndex":2,"lineId":"a","from":"B","to":"Arial"}],
            "skipped":[{"pageIndex":1,"lineId":"z","reason":"no glyph"},{"pageIndex":1,"lineId":"y","reason":"no glyph"},{"pageIndex":3,"lineId":"w","reason":"locked"}]
        }))
    }

    #[test]
    fn form_validation() {
        let ok_re = |_: &str| true;
        let bad_re = |_: &str| false;
        let f = FindForm {
            find: "abc".into(),
            ..Default::default()
        };
        assert_eq!(
            validate_form(&FindForm::default(), 5, &ok_re),
            Some(FormError::FindRequired)
        );
        assert_eq!(validate_form(&f, 5, &ok_re), None);
        assert_eq!(
            validate_form(
                &FindForm {
                    regex: true,
                    ..f.clone()
                },
                5,
                &bad_re
            ),
            Some(FormError::InvalidRegex)
        );
        assert_eq!(
            validate_form(
                &FindForm {
                    regex: false,
                    ..f.clone()
                },
                5,
                &bad_re
            ),
            None,
            "regex tắt thì không kiểm"
        );
        let p = FindForm {
            only_pages: true,
            page_range: "9".into(),
            ..f.clone()
        };
        assert_eq!(validate_form(&p, 5, &ok_re), Some(FormError::PageRange));
        assert_eq!(
            validate_form(
                &FindForm {
                    page_range: "2-3".into(),
                    ..p
                },
                5,
                &ok_re
            ),
            None
        );
    }

    #[test]
    fn params_and_pages() {
        let f = FindForm {
            find: "a".into(),
            replace: "b".into(),
            only_pages: true,
            page_range: "3, 1-2".into(),
            ..Default::default()
        };
        let v = build_params(&f, 5, true);
        assert_eq!(
            (
                &v["pages"],
                v["preview"].as_bool(),
                v["fontStrategy"].as_str()
            ),
            (&json!([0, 1, 2]), Some(true), Some("auto"))
        );
        let all = build_params(
            &FindForm {
                find: "a".into(),
                ..Default::default()
            },
            5,
            false,
        );
        assert!(all.get("pages").is_none());
        assert_eq!(all["fitWidth"], "none");
    }

    #[test]
    fn grouping_and_summary() {
        let d = data();
        assert_eq!(d.matches.len(), 3, "dòng thiếu rect đủ 4 số bị bỏ");
        let g = group_by_page(&d.matches);
        assert_eq!(
            g.iter().map(|(p, m)| (*p, m.len())).collect::<Vec<_>>(),
            [(0, 1), (2, 2)]
        );
        assert_eq!(g[1].1[0].line_id, "a");
        let s = summarize(&d);
        assert_eq!(
            (
                s.replaced,
                s.pages.clone(),
                s.substitutions,
                s.fonts.clone()
            ),
            (3, vec![0, 2], 2, vec!["Arial".to_string()])
        );
        assert_eq!(s.skipped_by_reason["no glyph"], 2);
        assert_eq!(s.skipped_by_reason["locked"], 1);
        assert_eq!(highlights(&d.matches)[0], (2, [1.0, 2.0, 3.0, 4.0]));
        assert!(d.preview);
    }
}
