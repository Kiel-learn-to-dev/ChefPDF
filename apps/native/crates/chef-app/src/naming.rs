//! Quy tắc đặt tên file đầu ra (TASKS_RUST R5.64, FEATURES O4): mẫu có thẻ, làm sạch cho Windows,
//! đánh số khi trùng, kế hoạch đổi tên. Port phần thuần của `core/chef_core/workflow/naming.py`
//! (không đọc đĩa trực tiếp: kiểm tra tồn tại do bên gọi truyền vào).
#![allow(dead_code)]

use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub const MAX_BASE_LENGTH: usize = 150;
pub const MAX_PATH_LENGTH: usize = 240;
const RESERVED: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];

const PLAIN_TOKENS: [&str; 9] = [
    "name",
    "index",
    "date",
    "time",
    "pages",
    "parent",
    "title",
    "firstline",
    "counter",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Conflict {
    /// `name (2).pdf`
    Suffix,
    Skip,
    Overwrite,
}

/// Giá trị thẻ của một file. `date` là "YYYY-MM-DD", `time` là "HHMMSS" (bên gọi tính từ đồng hồ).
#[derive(Debug, Clone, Default)]
pub struct NameValues {
    pub name: String,
    pub index: usize,
    pub date: String,
    pub time: String,
    pub pages: Option<usize>,
    pub parent: String,
    pub title: Option<String>,
    pub first_line: Option<String>,
    pub counter: usize,
}

fn is_seq(token: &str) -> Option<usize> {
    let n = token.strip_prefix("seq:")?;
    if n.is_empty() || n.len() > 2 || n.starts_with('0') || !n.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    n.parse().ok()
}

/// Duyệt các `{...}`; trả (thẻ đã cắt khoảng trắng, vị trí đầu, vị trí cuối) và phần ngoài thẻ.
fn tokens(template: &str) -> (Vec<(String, usize, usize)>, String) {
    let mut found = Vec::new();
    let mut outside = String::new();
    let mut i = 0;
    let b = template.as_bytes();
    while i < b.len() {
        if b[i] == b'{'
            && let Some(rel) = template[i + 1..].find(['{', '}'])
        {
            let end = i + 1 + rel;
            if b[end] == b'}' {
                found.push((template[i + 1..end].trim().to_string(), i, end + 1));
                i = end + 1;
                continue;
            }
        }
        let ch = template[i..].chars().next().expect("char");
        outside.push(ch);
        i += ch.len_utf8();
    }
    (found, outside)
}

/// Lỗi của mẫu tên (tiếng Việt); rỗng khi hợp lệ.
pub fn check_template(template: &str) -> Vec<String> {
    if template.trim().is_empty() {
        return vec!["Mẫu tên không được để trống.".into()];
    }
    let (found, outside) = tokens(template);
    let mut problems: Vec<String> = found
        .iter()
        .filter(|(t, _, _)| !PLAIN_TOKENS.contains(&t.as_str()) && is_seq(t).is_none())
        .map(|(t, _, _)| format!("Thẻ {{{t}}} không có trong danh sách thẻ hỗ trợ."))
        .collect();
    if outside.contains('{') || outside.contains('}') {
        problems.push("Dấu ngoặc nhọn không đóng đúng cặp.".into());
    }
    problems
}

/// Chữ mẫu cho `values` (chưa làm sạch). Mẫu phải hợp lệ.
pub fn render_template(template: &str, v: &NameValues) -> String {
    let (found, _) = tokens(template);
    let mut out = String::new();
    let mut last = 0;
    for (token, start, end) in found {
        out.push_str(&template[last..start]);
        let text = if let Some(width) = is_seq(&token) {
            format!("{:0width$}", v.index)
        } else {
            match token.as_str() {
                "name" => v.name.clone(),
                "index" => v.index.to_string(),
                "date" => v.date.clone(),
                "time" => v.time.clone(),
                "pages" => v.pages.map(|p| p.to_string()).unwrap_or_default(),
                "parent" => v.parent.clone(),
                "title" => v.title.clone().unwrap_or_default(),
                "firstline" => v.first_line.clone().unwrap_or_else(|| v.name.clone()),
                "counter" => v.counter.to_string(),
                _ => String::new(),
            }
        };
        out.push_str(&text);
        last = end;
    }
    out.push_str(&template[last..]);
    out
}

/// Tên không đuôi mà Windows nhận: ký tự `<>:"/\|?*` và ký tự điều khiển thành `_`, bỏ dấu chấm và
/// khoảng trắng ở cuối, tên thiết bị (CON, COM1...) thêm `_` phía trước, cắt còn ≤ 150 ký tự.
pub fn sanitize_base(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let mut cleaned = cleaned.trim().trim_end_matches([' ', '.']).to_string();
    if cleaned.is_empty() {
        return "file".into();
    }
    let head = cleaned.split('.').next().unwrap_or("").to_uppercase();
    let reserved = RESERVED.contains(&head.as_str())
        || ["COM", "LPT"].iter().any(|p| {
            head.strip_prefix(p)
                .is_some_and(|d| d.len() == 1 && matches!(d.as_bytes()[0], b'1'..=b'9'))
        });
    if reserved {
        cleaned.insert(0, '_');
    }
    let cut: String = cleaned.chars().take(MAX_BASE_LENGTH).collect();
    let cut = cut.trim_end_matches([' ', '.']).to_string();
    if cut.is_empty() { "file".into() } else { cut }
}

fn fit_length(folder: &Path, base: &str, ext: &str) -> String {
    let used = folder.as_os_str().len() + 1 + ext.len() + " (99)".len();
    let room = MAX_PATH_LENGTH.saturating_sub(used).max(1);
    if base.chars().count() <= room {
        return base.to_string();
    }
    let cut: String = base.chars().take(room).collect();
    let cut = cut.trim_end_matches([' ', '.']).to_string();
    if cut.is_empty() { "file".into() } else { cut }
}

fn key(p: &Path) -> String {
    p.to_string_lossy().to_lowercase()
}

/// File `base + ext` trong `folder` theo chính sách trùng; None là bỏ qua. `reserved` giữ các tên đã
/// phát (chữ thường) và được cập nhật; một tên không phát hai lần trong cùng lô. `exists` hỏi đĩa;
/// `exclude` là các file của lô sắp dời đi nên không tính là chiếm chỗ.
pub fn unique_target(
    folder: &Path,
    base: &str,
    conflict: Conflict,
    reserved: &mut HashSet<String>,
    exclude: &[PathBuf],
    ext: &str,
    exists: &dyn Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let free: HashSet<String> = exclude.iter().map(|p| key(p)).collect();
    let base = fit_length(folder, base, ext);
    let taken = |c: &Path, reserved: &HashSet<String>| {
        reserved.contains(&key(c)) || (exists(c) && !free.contains(&key(c)))
    };
    let first = folder.join(format!("{base}{ext}"));
    if conflict == Conflict::Overwrite && !reserved.contains(&key(&first)) {
        reserved.insert(key(&first));
        return Some(first);
    }
    if !taken(&first, reserved) {
        reserved.insert(key(&first));
        return Some(first);
    }
    if conflict == Conflict::Skip {
        return None;
    }
    (2..)
        .map(|n| folder.join(format!("{base} ({n}){ext}")))
        .find_map(|c| {
            if taken(&c, reserved) {
                None
            } else {
                reserved.insert(key(&c));
                Some(c)
            }
        })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    Ready,
    Unchanged,
    Skipped,
    Invalid,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenamePlan {
    pub source: PathBuf,
    pub target: Option<PathBuf>,
    pub status: Status,
    pub message: Option<String>,
}

/// Mỗi file sẽ đi đâu; không đổi gì trên đĩa. Giữ nguyên đuôi file.
pub fn plan_renames(
    paths: &[PathBuf],
    template: &str,
    conflict: Conflict,
    values_for: &dyn Fn(&Path) -> NameValues,
    exists: &dyn Fn(&Path) -> bool,
) -> Vec<RenamePlan> {
    let problems = check_template(template);
    if let Some(first) = problems.first() {
        return paths
            .iter()
            .map(|p| RenamePlan {
                source: p.clone(),
                target: None,
                status: Status::Invalid,
                message: Some(first.clone()),
            })
            .collect();
    }
    let ext_of = |p: &Path| {
        p.extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default()
    };
    let bases: Vec<String> = paths
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let mut v = values_for(p);
            v.index = i + 1;
            v.counter = i + 1;
            sanitize_base(&render_template(template, &v))
        })
        .collect();
    let file_name = |p: &Path| p.file_name().map(|n| n.to_string_lossy().into_owned());
    let mut reserved: HashSet<String> = HashSet::new();
    for (p, base) in paths.iter().zip(&bases) {
        if file_name(p).as_deref() == Some(&format!("{base}{}", ext_of(p))) {
            reserved.insert(key(p));
        }
    }
    paths
        .iter()
        .zip(&bases)
        .map(|(p, base)| {
            let ext = ext_of(p);
            if file_name(p).as_deref() == Some(&format!("{base}{ext}")) {
                return RenamePlan {
                    source: p.clone(),
                    target: Some(p.clone()),
                    status: Status::Unchanged,
                    message: None,
                };
            }
            let folder = p.parent().unwrap_or_else(|| Path::new(""));
            match unique_target(folder, base, conflict, &mut reserved, paths, &ext, exists) {
                Some(t) => RenamePlan {
                    source: p.clone(),
                    target: Some(t),
                    status: Status::Ready,
                    message: None,
                },
                None => RenamePlan {
                    source: p.clone(),
                    target: None,
                    status: Status::Skipped,
                    message: Some("Tên đã có, bỏ qua".into()),
                },
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vals(name: &str) -> NameValues {
        NameValues {
            name: name.into(),
            date: "2026-11-23".into(),
            time: "101530".into(),
            pages: Some(7),
            ..Default::default()
        }
    }

    #[test]
    fn template_check_and_render() {
        assert!(check_template("{name}_{date}_da-ky").is_empty());
        assert!(check_template("{seq:3}-{ name }").is_empty());
        assert_eq!(check_template("{bogus}").len(), 1);
        assert_eq!(check_template("{seq:0}").len(), 1);
        assert_eq!(check_template("a{b").len(), 1);
        assert_eq!(check_template(" ").len(), 1);
        let mut v = vals("Hop dong");
        v.index = 4;
        assert_eq!(
            render_template("{name}_{date}_da-ky {seq:3}/{pages} {firstline}", &v),
            "Hop dong_2026-11-23_da-ky 004/7 Hop dong"
        );
    }

    #[test]
    fn windows_sanitising() {
        assert_eq!(sanitize_base("a<b>:c\"d/e\\f|g?h*i"), "a_b__c_d_e_f_g_h_i");
        assert_eq!(sanitize_base("tên. "), "tên");
        assert_eq!(sanitize_base("CON"), "_CON");
        assert_eq!(sanitize_base("com1.txt"), "_com1.txt");
        assert_eq!(sanitize_base("COM0"), "COM0");
        assert_eq!(sanitize_base(" . "), "file");
        assert_eq!(
            sanitize_base(&"x".repeat(300)).chars().count(),
            MAX_BASE_LENGTH
        );
    }

    #[test]
    fn collisions_get_numbers_or_skip() {
        let taken: HashSet<PathBuf> =
            [PathBuf::from("/o/a.pdf"), PathBuf::from("/o/a (2).pdf")].into();
        let exists = |p: &Path| taken.contains(p);
        let mut res = HashSet::new();
        let f = Path::new("/o");
        let t = unique_target(f, "a", Conflict::Suffix, &mut res, &[], ".pdf", &exists).unwrap();
        assert_eq!(t, Path::new("/o/a (3).pdf"));
        // cùng tên không phát hai lần trong lô
        let t = unique_target(f, "b", Conflict::Suffix, &mut res, &[], ".pdf", &exists).unwrap();
        let t2 = unique_target(f, "B", Conflict::Suffix, &mut res, &[], ".pdf", &exists).unwrap();
        assert_ne!(t, t2);
        assert_eq!(
            unique_target(f, "a", Conflict::Skip, &mut res, &[], ".pdf", &exists),
            None
        );
        let mut res2 = HashSet::new();
        assert_eq!(
            unique_target(f, "a", Conflict::Overwrite, &mut res2, &[], ".pdf", &exists).unwrap(),
            Path::new("/o/a.pdf")
        );
    }

    #[test]
    fn plan_renames_previews_without_overwriting() {
        let paths = vec![
            PathBuf::from("/d/x.pdf"),
            PathBuf::from("/d/y.pdf"),
            PathBuf::from("/d/z.PNG"),
        ];
        let exists = |_: &Path| false;
        let plans = plan_renames(
            &paths,
            "ho-so",
            Conflict::Suffix,
            &|p| vals(&p.file_stem().unwrap().to_string_lossy()),
            &exists,
        );
        assert_eq!(plans[0].target.as_deref(), Some(Path::new("/d/ho-so.pdf")));
        assert_eq!(
            plans[1].target.as_deref(),
            Some(Path::new("/d/ho-so (2).pdf"))
        );
        assert_eq!(plans[2].target.as_deref(), Some(Path::new("/d/ho-so.PNG")));
        let same = plan_renames(
            &paths[..1],
            "{name}",
            Conflict::Suffix,
            &|p| vals(&p.file_stem().unwrap().to_string_lossy()),
            &exists,
        );
        assert_eq!(same[0].status, Status::Unchanged);
        let bad = plan_renames(&paths, "{nope}", Conflict::Suffix, &|_| vals("x"), &exists);
        assert!(
            bad.iter()
                .all(|p| p.status == Status::Invalid && p.target.is_none())
        );
    }
}
