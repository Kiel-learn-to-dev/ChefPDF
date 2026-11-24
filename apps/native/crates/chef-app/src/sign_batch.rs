//! Ký hàng loạt (TASKS_RUST R6.24, FEATURES I31): port `batchModel.ts`. Danh sách file, quy tắc tên
//! file ra, bảng kết quả. Logic thuần; PIN nhập một lần do hộp thoại giữ, không nằm ở đây.
#![allow(dead_code)]

use serde_json::Value;

pub const MAX_BATCH_FILES: usize = 200;
pub const DEFAULT_SUFFIX: &str = "_da-ky";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatchRow {
    pub path: String,
    pub name: String,
    /// Mật khẩu file mã hóa: chỉ giữ trong bộ nhớ cho lô này.
    pub password: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddResult {
    pub rows: Vec<BatchRow>,
    pub added: usize,
    pub duplicates: usize,
    pub over_limit: bool,
}

pub fn file_name(path: &str) -> &str {
    match path.rsplit(['\\', '/']).next() {
        Some(n) if !n.is_empty() => n,
        _ => path,
    }
}

/// Thêm các đường dẫn chưa có (không phân biệt hoa thường), tối đa `MAX_BATCH_FILES`.
pub fn add_paths(rows: &[BatchRow], paths: &[&str]) -> AddResult {
    let mut out = rows.to_vec();
    let (mut added, mut duplicates, mut over_limit) = (0, 0, false);
    for path in paths {
        if out.iter().any(|r| {
            r.path.eq_ignore_ascii_case(path) || r.path.to_lowercase() == path.to_lowercase()
        }) {
            duplicates += 1;
            continue;
        }
        if out.len() >= MAX_BATCH_FILES {
            over_limit = true;
            break;
        }
        out.push(BatchRow {
            path: (*path).into(),
            name: file_name(path).into(),
            password: None,
        });
        added += 1;
    }
    AddResult {
        rows: out,
        added,
        duplicates,
        over_limit,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SuffixProblem {
    Empty,
    Separator,
    InvalidChars,
    Long,
}

/// Lỗi của hậu tố tên file ra, hoặc None.
pub fn suffix_problem(suffix: &str) -> Option<SuffixProblem> {
    if suffix.trim().is_empty() {
        Some(SuffixProblem::Empty)
    } else if suffix.contains(['\\', '/']) {
        Some(SuffixProblem::Separator)
    } else if suffix
        .chars()
        .any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || (c as u32) < 32)
    {
        Some(SuffixProblem::InvalidChars)
    } else if suffix.encode_utf16().count() > 40 {
        Some(SuffixProblem::Long)
    } else {
        None
    }
}

/// "<tên><hậu tố>.pdf" cạnh file vào.
pub fn suffix_output_name(input: &str, suffix: &str) -> String {
    let name = file_name(input);
    let stem = if name.to_lowercase().ends_with(".pdf") {
        &name[..name.len() - 4]
    } else {
        name
    };
    format!("{stem}{suffix}.pdf")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemStatus {
    Signed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BatchItem {
    pub path: String,
    pub output_path: Option<String>,
    pub status: ItemStatus,
    pub error_kind: Option<String>,
    pub message: Option<String>,
    pub verification_status: Option<String>,
}

/// Đọc `data.results` của `sign.batch`; dòng sai dạng bị bỏ.
pub fn parse_results(data: &Value) -> Vec<BatchItem> {
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(String::from);
    data.get("results")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| {
                    Some(BatchItem {
                        path: s(v, "path")?,
                        output_path: s(v, "outputPath"),
                        status: match v.get("status")?.as_str()? {
                            "signed" => ItemStatus::Signed,
                            "failed" => ItemStatus::Failed,
                            "skipped" => ItemStatus::Skipped,
                            _ => return None,
                        },
                        error_kind: s(v, "errorKind"),
                        message: s(v, "message"),
                        verification_status: v
                            .get("verification")
                            .and_then(|x| x.get("status"))
                            .and_then(Value::as_str)
                            .map(String::from),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Summary {
    pub total: usize,
    pub signed: usize,
    pub failed: usize,
    pub skipped: usize,
}

pub fn summarize(items: &[BatchItem]) -> Summary {
    let n = |st| items.iter().filter(|i| i.status == st).count();
    Summary {
        total: items.len(),
        signed: n(ItemStatus::Signed),
        failed: n(ItemStatus::Failed),
        skipped: n(ItemStatus::Skipped),
    }
}

/// Đường dẫn vào của các mục lỗi hoặc bỏ qua: tập có thể thử lại.
pub fn retry_paths(items: &[BatchItem]) -> Vec<&str> {
    items
        .iter()
        .filter(|i| i.status != ItemStatus::Signed)
        .map(|i| i.path.as_str())
        .collect()
}

/// Khóa chuỗi giao diện của lỗi: loại lỗi của lõi, hoặc khóa chung khi không rõ.
pub fn error_key(kind: Option<&str>) -> String {
    kind.map_or_else(|| "signBatch.errUnknown".into(), |k| format!("errors.{k}"))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Ok,
    Warn,
    Bad,
    None,
}

/// Huy hiệu kiểm tra của file đã ký.
pub fn verification_tone(status: Option<&str>) -> Tone {
    match status {
        Some("valid") => Tone::Ok,
        Some("valid-with-warnings" | "unknown") => Tone::Warn,
        Some("invalid") => Tone::Bad,
        _ => Tone::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn add_paths_dedupes_ignoring_case_and_caps() {
        let r = add_paths(
            &[],
            &["C:\\a\\Hop dong.pdf", "c:\\a\\hop dong.PDF", "/x/b.pdf"],
        );
        assert_eq!((r.added, r.duplicates, r.over_limit), (2, 1, false));
        assert_eq!(r.rows[0].name, "Hop dong.pdf");
        let many: Vec<String> = (0..MAX_BATCH_FILES + 5)
            .map(|i| format!("/f/{i}.pdf"))
            .collect();
        let refs: Vec<&str> = many.iter().map(String::as_str).collect();
        let r = add_paths(&[], &refs);
        assert_eq!((r.rows.len(), r.over_limit), (MAX_BATCH_FILES, true));
    }

    #[test]
    fn suffix_rules_and_output_name() {
        assert_eq!(suffix_problem("_da-ky"), None);
        assert_eq!(suffix_problem(" "), Some(SuffixProblem::Empty));
        assert_eq!(suffix_problem("a/b"), Some(SuffixProblem::Separator));
        assert_eq!(suffix_problem("a?"), Some(SuffixProblem::InvalidChars));
        assert_eq!(suffix_problem("a\tb"), Some(SuffixProblem::InvalidChars));
        assert_eq!(suffix_problem(&"x".repeat(41)), Some(SuffixProblem::Long));
        assert_eq!(
            suffix_output_name("/d/Hop dong.PDF", "_da-ky"),
            "Hop dong_da-ky.pdf"
        );
        assert_eq!(suffix_output_name("/d/notes", "_x"), "notes_x.pdf");
    }

    #[test]
    fn results_summary_retry_and_tone() {
        let items = parse_results(&json!({"results":[
            {"path":"/a.pdf","outputPath":"/a_da-ky.pdf","status":"signed","verification":{"status":"valid"}},
            {"path":"/b.pdf","status":"failed","errorKind":"PIN_WRONG","message":"sai PIN"},
            {"path":"/c.pdf","status":"skipped"},
            {"path":"/d.pdf","status":"weird"}, {"nopath":1}]}));
        assert_eq!(items.len(), 3);
        let s = summarize(&items);
        assert_eq!((s.total, s.signed, s.failed, s.skipped), (3, 1, 1, 1));
        assert_eq!(retry_paths(&items), ["/b.pdf", "/c.pdf"]);
        assert_eq!(error_key(Some("PIN_WRONG")), "errors.PIN_WRONG");
        assert_eq!(error_key(None), "signBatch.errUnknown");
        assert_eq!(
            verification_tone(items[0].verification_status.as_deref()),
            Tone::Ok
        );
        assert_eq!(verification_tone(Some("unknown")), Tone::Warn);
        assert_eq!(verification_tone(Some("invalid")), Tone::Bad);
        assert_eq!(verification_tone(None), Tone::None);
    }
}
