//! Kiểm tra chữ ký hàng loạt (TASKS_RUST R6.29, FEATURES I36): port `verifyBatchModel.ts`. Form,
//! tham số `sign.verifyBatch`, đếm theo trạng thái. Logic thuần.
#![allow(dead_code)]

use serde_json::{Map, Value, json};

pub const DEFAULT_REPORT_NAME: &str = "kiem-tra-chu-ky";
pub const TRUST_ROOT_FILTERS: [&str; 4] = ["pem", "cer", "crt", "der"];

/// Thứ tự trạng thái trong phần tóm tắt (tên của lõi).
pub const STATUS_ORDER: [&str; 6] = [
    "valid",
    "valid-with-warnings",
    "invalid",
    "unknown",
    "unsigned",
    "error",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Files,
    Folder,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Revocation {
    None,
    Soft,
    Hard,
}

impl Revocation {
    fn as_str(self) -> &'static str {
        match self {
            Revocation::None => "none",
            Revocation::Soft => "soft",
            Revocation::Hard => "hard",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Csv,
    Xlsx,
}

impl Format {
    pub fn ext(self) -> &'static str {
        match self {
            Format::Csv => "csv",
            Format::Xlsx => "xlsx",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Form {
    pub scope: Scope,
    pub files: Vec<String>,
    pub folder: Option<String>,
    pub recursive: bool,
    pub revocation: Revocation,
    /// Gốc tin cậy thêm (file hoặc thư mục); kho đóng gói và kho người dùng luôn áp dụng.
    pub trust_roots: Vec<String>,
    pub format: Format,
    pub report_path: Option<String>,
}

impl Default for Form {
    fn default() -> Self {
        Self {
            scope: Scope::Files,
            files: vec![],
            folder: None,
            recursive: false,
            revocation: Revocation::Soft,
            trust_roots: vec![],
            format: Format::Csv,
            report_path: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Problem {
    NoInput,
    NoReport,
    Extension,
}

pub fn problem(f: &Form) -> Option<Problem> {
    let has_input = match f.scope {
        Scope::Files => !f.files.is_empty(),
        Scope::Folder => f.folder.is_some(),
    };
    if !has_input {
        return Some(Problem::NoInput);
    }
    match f.report_path.as_deref().map(str::trim) {
        None | Some("") => Some(Problem::NoReport),
        Some(p) if !p.to_lowercase().ends_with(&format!(".{}", f.format.ext())) => {
            Some(Problem::Extension)
        }
        _ => None,
    }
}

/// `sign.verifyBatch`: đúng một nguồn (file hoặc thư mục); gốc tin cậy chỉ khi có.
pub fn params(f: &Form) -> Value {
    let mut m = Map::new();
    match f.scope {
        Scope::Files => {
            m.insert(
                "files".into(),
                f.files
                    .iter()
                    .map(|p| json!({"path": p}))
                    .collect::<Vec<_>>()
                    .into(),
            );
        }
        Scope::Folder => {
            m.insert("folder".into(), f.folder.clone().unwrap_or_default().into());
            m.insert("recursive".into(), f.recursive.into());
        }
    }
    m.insert("checkRevocation".into(), f.revocation.as_str().into());
    if !f.trust_roots.is_empty() {
        m.insert("trustRootPaths".into(), json!(f.trust_roots));
    }
    m.insert(
        "reportPath".into(),
        f.report_path.clone().unwrap_or_default().into(),
    );
    m.insert("format".into(), f.format.ext().into());
    Value::Object(m)
}

/// Đổi định dạng thì đổi đuôi file báo cáo, giữ tên.
pub fn with_format(path: Option<&str>, format: Format) -> Option<String> {
    let p = path.filter(|p| !p.is_empty())?;
    let slash = p.rfind(['/', '\\']);
    let stem = match p.rfind('.') {
        Some(d) if slash.is_none_or(|s| d > s) => &p[..d],
        _ => p,
    };
    Some(format!("{stem}.{}", format.ext()))
}

/// Nối thư mục với tên báo cáo mặc định; dùng dấu phân cách đang có trong đường dẫn.
pub fn default_report_path(dir: &str, format: Format) -> String {
    let sep = if dir.contains('\\') && !dir.contains('/') {
        '\\'
    } else {
        '/'
    };
    let base = dir.strip_suffix(['/', '\\']).unwrap_or(dir);
    format!("{base}{sep}{DEFAULT_REPORT_NAME}.{}", format.ext())
}

/// Đếm theo trạng thái đúng thứ tự tóm tắt; trạng thái lạ xếp cuối theo tên; bỏ số 0.
pub fn counts_by_status(by_status: &Map<String, Value>) -> Vec<(String, u64)> {
    let count = |s: &str| by_status.get(s).and_then(Value::as_u64).unwrap_or(0);
    let mut out: Vec<(String, u64)> = STATUS_ORDER
        .iter()
        .filter(|s| count(s) > 0)
        .map(|s| (s.to_string(), count(s)))
        .collect();
    let mut extra: Vec<&String> = by_status
        .keys()
        .filter(|k| !STATUS_ORDER.contains(&k.as_str()) && count(k) > 0)
        .collect();
    extra.sort();
    out.extend(extra.into_iter().map(|k| (k.clone(), count(k))));
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct VerifyResult {
    pub files: u64,
    pub signatures: u64,
    pub by_status: Vec<(String, u64)>,
    pub report_path: String,
}

/// Đọc `data` của `sign.verifyBatch`; None khi sai dạng.
pub fn parse_result(d: &Value) -> Option<VerifyResult> {
    Some(VerifyResult {
        files: d.get("files")?.as_u64()?,
        signatures: d.get("signatures").and_then(Value::as_u64).unwrap_or(0),
        by_status: d
            .get("byStatus")
            .and_then(Value::as_object)
            .map(counts_by_status)
            .unwrap_or_default(),
        report_path: d.get("reportPath")?.as_str()?.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready() -> Form {
        Form {
            files: vec!["/a.pdf".into()],
            report_path: Some("/r/x.csv".into()),
            ..Default::default()
        }
    }

    #[test]
    fn problems() {
        assert_eq!(problem(&Form::default()), Some(Problem::NoInput));
        assert_eq!(
            problem(&Form {
                files: vec!["/a".into()],
                ..Default::default()
            }),
            Some(Problem::NoReport)
        );
        assert_eq!(
            problem(&Form {
                report_path: Some("  ".into()),
                ..ready()
            }),
            Some(Problem::NoReport)
        );
        assert_eq!(
            problem(&Form {
                report_path: Some("/r/x.xlsx".into()),
                ..ready()
            }),
            Some(Problem::Extension)
        );
        assert_eq!(
            problem(&Form {
                format: Format::Xlsx,
                report_path: Some("/r/X.XLSX".into()),
                ..ready()
            }),
            None
        );
        assert_eq!(problem(&ready()), None);
        let folder = Form {
            scope: Scope::Folder,
            folder: Some("/d".into()),
            ..ready()
        };
        assert_eq!(problem(&folder), None);
    }

    #[test]
    fn params_have_exactly_one_source() {
        let v = params(&ready());
        assert_eq!(
            (&v["files"], v.get("folder"), v["checkRevocation"].as_str()),
            (&json!([{"path":"/a.pdf"}]), None, Some("soft"))
        );
        assert!(v.get("trustRootPaths").is_none());
        let f = Form {
            scope: Scope::Folder,
            folder: Some("/d".into()),
            recursive: true,
            trust_roots: vec!["/ca.pem".into()],
            format: Format::Xlsx,
            report_path: Some("/r.xlsx".into()),
            ..Default::default()
        };
        let v = params(&f);
        assert_eq!(
            (
                v.get("files"),
                v["folder"].as_str(),
                v["recursive"].as_bool()
            ),
            (None, Some("/d"), Some(true))
        );
        assert_eq!(
            (&v["trustRootPaths"], v["format"].as_str()),
            (&json!(["/ca.pem"]), Some("xlsx"))
        );
    }

    #[test]
    fn paths() {
        assert_eq!(
            with_format(Some("C:\\r\\bao cao.csv"), Format::Xlsx).as_deref(),
            Some("C:\\r\\bao cao.xlsx")
        );
        assert_eq!(
            with_format(Some("/a.b/report"), Format::Csv).as_deref(),
            Some("/a.b/report.csv")
        );
        assert_eq!(with_format(None, Format::Csv), None);
        assert_eq!(
            default_report_path("C:\\Docs\\", Format::Csv),
            "C:\\Docs\\kiem-tra-chu-ky.csv"
        );
        assert_eq!(
            default_report_path("/home/u", Format::Xlsx),
            "/home/u/kiem-tra-chu-ky.xlsx"
        );
    }

    #[test]
    fn counts_and_result() {
        let r = parse_result(&json!({"files":3,"signatures":5,"reportPath":"/r.csv",
            "byStatus":{"invalid":1,"valid":2,"zeta":1,"alpha":2,"unsigned":0,"bad":"x"}}))
        .unwrap();
        assert_eq!(
            r.by_status,
            [
                ("valid".into(), 2),
                ("invalid".into(), 1),
                ("alpha".into(), 2),
                ("zeta".into(), 1)
            ]
        );
        assert_eq!((r.files, r.signatures), (3, 5));
        assert!(parse_result(&json!({"files":1})).is_none());
        assert!(parse_result(&json!(5)).is_none());
    }
}
