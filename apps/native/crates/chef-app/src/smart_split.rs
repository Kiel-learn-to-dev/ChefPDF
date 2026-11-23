//! Tách thông minh (TASKS_RUST R5.08, FEATURES C10): dựng `file.splitSmart` và tính trước các điểm
//! tách để xem trước (cùng quy tắc với lõi: `_parts_from_starts`, `_parts_at_blanks`).
#![allow(dead_code)]

use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq)]
pub enum Mode {
    /// Trang trắng phân cách; `drop_separator` bỏ trang phân cách khỏi file kết quả.
    Blank {
        sensitivity: f64,
        drop_separator: bool,
    },
    /// Mỗi bookmark ở cấp này mở một file mới (1 = cấp trên cùng).
    BookmarkLevel(u32),
    /// Trang có chữ khớp biểu thức chính quy mở một file mới.
    Pattern { regex: String, ignore_case: bool },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reject {
    NoSource,
    NoOutputDir,
    BadLevel,
    EmptyPattern,
    BadSensitivity,
    BadTemplate,
}

/// Một file kết quả: các trang (chỉ số từ 0) theo thứ tự.
pub type Part = Vec<usize>;

pub fn params(
    source: &str,
    password: Option<&str>,
    mode: &Mode,
    output_dir: &str,
    name_template: Option<&str>,
) -> Result<Value, Reject> {
    if source.trim().is_empty() {
        return Err(Reject::NoSource);
    }
    if output_dir.trim().is_empty() {
        return Err(Reject::NoOutputDir);
    }
    let template = name_template.unwrap_or(crate::split::DEFAULT_TEMPLATE);
    if !crate::split::template_ok(template) {
        return Err(Reject::BadTemplate);
    }
    let mut v = json!({ "path": source, "outputDir": output_dir, "nameTemplate": template });
    if let Some(p) = password {
        v["password"] = p.into();
    }
    match mode {
        Mode::Blank {
            sensitivity,
            drop_separator,
        } => {
            if !(0.0..=1.0).contains(sensitivity) {
                return Err(Reject::BadSensitivity);
            }
            v["mode"] = "blank".into();
            v["blankSensitivity"] = (*sensitivity).into();
            v["dropSeparatorPages"] = (*drop_separator).into();
        }
        Mode::BookmarkLevel(level) => {
            if !(1..=10).contains(level) {
                return Err(Reject::BadLevel);
            }
            v["mode"] = "bookmarkLevel".into();
            v["level"] = (*level).into();
        }
        Mode::Pattern { regex, ignore_case } => {
            if regex.is_empty() {
                return Err(Reject::EmptyPattern);
            }
            v["mode"] = "pattern".into();
            v["pattern"] = regex.as_str().into();
            v["ignoreCase"] = (*ignore_case).into();
        }
    }
    Ok(v)
}

/// Các file kết quả khi mỗi trang trong `starts` mở một file mới; trang 0 luôn là điểm đầu.
pub fn parts_from_starts(starts: &[usize], count: usize) -> Vec<Part> {
    let mut ordered: Vec<usize> = starts.iter().copied().filter(|&s| s < count).collect();
    ordered.sort_unstable();
    ordered.dedup();
    if ordered.first() != Some(&0) {
        ordered.insert(0, 0);
    }
    ordered.push(count);
    ordered
        .windows(2)
        .filter(|w| w[1] > w[0])
        .map(|w| (w[0]..w[1]).collect())
        .collect()
}

/// Các file kết quả khi cắt tại trang trắng. `blank[i]` là trang i có trắng không.
pub fn parts_at_blanks(blank: &[bool], drop_separator: bool) -> Vec<Part> {
    let mut parts = Vec::new();
    let mut current: Part = Vec::new();
    for (i, &is_blank) in blank.iter().enumerate() {
        if is_blank {
            if !drop_separator {
                current.push(i);
            }
            if !current.is_empty() {
                parts.push(std::mem::take(&mut current));
            }
        } else {
            current.push(i);
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

/// Văn bản xem trước một file kết quả: "Trang 3–5" hoặc "Trang 7".
pub fn describe(part: &[usize]) -> String {
    match (part.first(), part.last()) {
        (Some(a), Some(b)) if a == b => format!("{}", a + 1),
        (Some(a), Some(b)) => format!("{}–{}", a + 1, b + 1),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_per_mode() {
        let b = Mode::Blank {
            sensitivity: 0.5,
            drop_separator: true,
        };
        let v = params("/a.pdf", None, &b, "/out", None).unwrap();
        assert_eq!(v["mode"], "blank");
        assert_eq!(v["dropSeparatorPages"], true);
        let v = params("/a.pdf", Some("pw"), &Mode::BookmarkLevel(2), "/out", None).unwrap();
        assert_eq!(
            (v["level"].as_u64(), v["password"].as_str()),
            (Some(2), Some("pw"))
        );
        let p = Mode::Pattern {
            regex: "^Chương".into(),
            ignore_case: false,
        };
        assert_eq!(
            params("/a.pdf", None, &p, "/out", None).unwrap()["pattern"],
            "^Chương"
        );
    }

    #[test]
    fn params_rejects() {
        let lvl = |l| params("/a", None, &Mode::BookmarkLevel(l), "/o", None).unwrap_err();
        assert_eq!(lvl(0), Reject::BadLevel);
        assert_eq!(lvl(11), Reject::BadLevel);
        let pat = Mode::Pattern {
            regex: String::new(),
            ignore_case: true,
        };
        assert_eq!(
            params("/a", None, &pat, "/o", None).unwrap_err(),
            Reject::EmptyPattern
        );
        assert_eq!(
            params("", None, &Mode::BookmarkLevel(1), "/o", None).unwrap_err(),
            Reject::NoSource
        );
        assert_eq!(
            params("/a", None, &Mode::BookmarkLevel(1), "", None).unwrap_err(),
            Reject::NoOutputDir
        );
        let b = Mode::Blank {
            sensitivity: 2.0,
            drop_separator: false,
        };
        assert_eq!(
            params("/a", None, &b, "/o", None).unwrap_err(),
            Reject::BadSensitivity
        );
    }

    #[test]
    fn preview_parts_match_core_rules() {
        assert_eq!(
            parts_from_starts(&[3, 6], 8),
            vec![vec![0, 1, 2], vec![3, 4, 5], vec![6, 7]]
        );
        assert_eq!(parts_from_starts(&[], 3), vec![vec![0, 1, 2]]);
        assert_eq!(parts_from_starts(&[0, 0, 9], 2), vec![vec![0, 1]]);
        // trắng ở trang 2 và 5, giữ trang phân cách vào file trước
        let blank = [false, false, true, false, false, true, false];
        assert_eq!(
            parts_at_blanks(&blank, false),
            vec![vec![0, 1, 2], vec![3, 4, 5], vec![6]]
        );
        assert_eq!(
            parts_at_blanks(&blank, true),
            vec![vec![0, 1], vec![3, 4], vec![6]]
        );
        assert_eq!(parts_at_blanks(&[true, true], true), Vec::<Part>::new());
        assert_eq!(describe(&[2, 3, 4]), "3–5");
        assert_eq!(describe(&[6]), "7");
    }
}
