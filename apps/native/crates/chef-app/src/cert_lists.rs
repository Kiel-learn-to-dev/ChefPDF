//! Danh sách driver token và danh sách file chứng thư đã lưu (TASKS_RUST R6.02, R6.04; FEATURES I4, I5):
//! port `driverList.ts` và `pfxList.ts`. Sắp xếp driver, tóm tắt kết quả dò, thêm/bớt/nhớ file `.pfx`.
//! Logic thuần. So sánh chuỗi "vi" xấp xỉ bằng khóa bỏ dấu rồi mới so nguyên văn.
#![allow(dead_code)]

use std::cmp::Ordering;

use serde_json::Value;

use crate::sign_anchor::fold_diacritics;

// ---------- Driver (driverList.ts) ----------

/// Một dòng driver từ `sign.driverScan`.
#[derive(Debug, Clone, PartialEq)]
pub struct DriverRow {
    pub exists: bool,
    pub confidence: DriverConfidence,
    pub ca: String,
    pub model: String,
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DriverConfidence {
    Documented,
    Reported,
    Unverified,
}

impl DriverConfidence {
    fn rank(self) -> u8 {
        match self {
            DriverConfidence::Documented => 0,
            DriverConfidence::Reported => 1,
            DriverConfidence::Unverified => 2,
        }
    }

    pub fn parse(v: &str) -> Option<DriverConfidence> {
        Some(match v {
            "documented" => DriverConfidence::Documented,
            "reported" => DriverConfidence::Reported,
            "unverified" => DriverConfidence::Unverified,
            _ => return None,
        })
    }
}

/// So sánh gần với `localeCompare('vi')`: bỏ dấu và hoa thường trước, rồi so nguyên văn.
fn vi_cmp(a: &str, b: &str) -> Ordering {
    fold_diacritics(a)
        .cmp(&fold_diacritics(b))
        .then_with(|| a.cmp(b))
}

/// Driver có trên máy này trước, rồi độ tin cậy (documented, reported, unverified), rồi tên CA, model, đường
/// dẫn. Không sửa đầu vào.
pub fn sort_drivers(rows: &[DriverRow]) -> Vec<DriverRow> {
    let mut out = rows.to_vec();
    out.sort_by(|a, b| {
        b.exists
            .cmp(&a.exists)
            .then(a.confidence.rank().cmp(&b.confidence.rank()))
            .then_with(|| vi_cmp(&a.ca, &b.ca))
            .then_with(|| vi_cmp(&a.model, &b.model))
            .then_with(|| a.path.cmp(&b.path))
    });
    out
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeSummary {
    None,
    Labels(Vec<String>),
    Error {
        error_kind: Option<String>,
        reason: Option<String>,
    },
}

/// Kết quả một driver đã dò: nhãn token, lỗi nạp, hoặc chưa dò. `probe` là JSON `DriverProbe`.
pub fn probe_summary(probe: Option<&Value>) -> ProbeSummary {
    let Some(p) = probe else {
        return ProbeSummary::None;
    };
    if p.get("status").and_then(Value::as_str) == Some("ok") {
        let labels = p
            .get("tokenLabels")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        return ProbeSummary::Labels(labels);
    }
    let s = |k: &str| p.get(k).and_then(Value::as_str).map(String::from);
    ProbeSummary::Error {
        error_kind: s("errorKind"),
        reason: s("reason"),
    }
}

/// Chỉ chọn được dòng driver khi file tồn tại trên máy này.
pub fn is_selectable(row: &DriverRow) -> bool {
    row.exists
}

// ---------- File .pfx đã lưu (pfxList.ts) ----------

pub const MAX_KNOWN_PFX: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownPfxFile {
    pub path: String,
    pub label: String,
    pub remembered: bool,
}

/// Tên file của đường dẫn, cả dấu phân cách Windows và POSIX.
pub fn file_name_of(path: &str) -> String {
    match path.rsplit(['\\', '/']).next() {
        Some(n) if !n.is_empty() => n.to_string(),
        _ => path.to_string(),
    }
}

/// Windows và macOS so đường dẫn không phân biệt hoa thường, như tiến trình chính của Electron.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PathCompare {
    pub case_insensitive: bool,
}

pub fn same_path(a: &str, b: &str, cmp: PathCompare) -> bool {
    if cmp.case_insensitive {
        a.to_lowercase() == b.to_lowercase()
    } else {
        a == b
    }
}

pub fn find_known_pfx<'a>(
    list: &'a [KnownPfxFile],
    path: &str,
    cmp: PathCompare,
) -> Option<&'a KnownPfxFile> {
    list.iter().find(|e| same_path(&e.path, path, cmp))
}

/// Ghi đè tùy chọn khi thêm file.
#[derive(Debug, Clone, Default)]
pub struct PfxPatch {
    pub label: Option<String>,
    pub remembered: Option<bool>,
}

/// Đưa `path` lên đầu danh sách (mới nhất trước). Mục đã có giữ nhãn và cờ nhớ trừ khi `patch` ghi đè.
/// Danh sách bị cắt ở `MAX_KNOWN_PFX`.
pub fn upsert_known_pfx(
    list: &[KnownPfxFile],
    path: &str,
    cmp: PathCompare,
    patch: &PfxPatch,
) -> Vec<KnownPfxFile> {
    let prev = find_known_pfx(list, path, cmp);
    let entry = KnownPfxFile {
        path: path.to_string(),
        label: patch
            .label
            .clone()
            .or_else(|| prev.map(|p| p.label.clone()))
            .unwrap_or_else(|| file_name_of(path)),
        remembered: patch
            .remembered
            .or_else(|| prev.map(|p| p.remembered))
            .unwrap_or(false),
    };
    let mut out = vec![entry];
    out.extend(
        list.iter()
            .filter(|e| !same_path(&e.path, path, cmp))
            .cloned(),
    );
    out.truncate(MAX_KNOWN_PFX);
    out
}

pub fn remove_known_pfx(list: &[KnownPfxFile], path: &str, cmp: PathCompare) -> Vec<KnownPfxFile> {
    list.iter()
        .filter(|e| !same_path(&e.path, path, cmp))
        .cloned()
        .collect()
}

pub fn set_remembered(
    list: &[KnownPfxFile],
    path: &str,
    remembered: bool,
    cmp: PathCompare,
) -> Vec<KnownPfxFile> {
    list.iter()
        .map(|e| {
            if same_path(&e.path, path, cmp) {
                KnownPfxFile {
                    remembered,
                    ..e.clone()
                }
            } else {
                e.clone()
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn d(exists: bool, c: DriverConfidence, ca: &str, model: &str, path: &str) -> DriverRow {
        DriverRow {
            exists,
            confidence: c,
            ca: ca.into(),
            model: model.into(),
            path: path.into(),
        }
    }

    #[test]
    fn drivers_present_first_then_trust_then_names() {
        use DriverConfidence::*;
        let rows = [
            d(false, Documented, "A", "m", "p1"),
            d(true, Unverified, "A", "m", "p2"),
            d(true, Documented, "Viettel", "V6", "p3"),
            d(true, Documented, "Đại", "X", "p4"),
            d(true, Reported, "A", "m", "p5"),
            d(true, Documented, "Viettel", "V5", "p6"),
        ];
        let paths: Vec<_> = sort_drivers(&rows).into_iter().map(|r| r.path).collect();
        // Documented có mặt: "Đại" (đ ~ d) trước "Viettel"; V5 trước V6; rồi reported, unverified, rồi vắng mặt.
        assert_eq!(paths, ["p4", "p6", "p3", "p5", "p2", "p1"]);
        assert_eq!(rows[0].path, "p1", "không sửa đầu vào");
    }

    #[test]
    fn probe_summary_variants() {
        assert_eq!(probe_summary(None), ProbeSummary::None);
        let ok = json!({ "status": "ok", "tokenLabels": ["VT-1", "VT-2"] });
        assert_eq!(
            probe_summary(Some(&ok)),
            ProbeSummary::Labels(vec!["VT-1".into(), "VT-2".into()])
        );
        let bad = json!({ "status": "error", "errorKind": "LOAD", "reason": "x" });
        assert_eq!(
            probe_summary(Some(&bad)),
            ProbeSummary::Error {
                error_kind: Some("LOAD".into()),
                reason: Some("x".into())
            }
        );
        let bare = json!({ "status": "error", "errorKind": null, "reason": null });
        assert_eq!(
            probe_summary(Some(&bare)),
            ProbeSummary::Error {
                error_kind: None,
                reason: None
            }
        );
    }

    #[test]
    fn selectable_only_when_file_exists() {
        assert!(is_selectable(&d(
            true,
            DriverConfidence::Reported,
            "a",
            "b",
            "c"
        )));
        assert!(!is_selectable(&d(
            false,
            DriverConfidence::Documented,
            "a",
            "b",
            "c"
        )));
    }

    const WIN: PathCompare = PathCompare {
        case_insensitive: true,
    };
    const POSIX: PathCompare = PathCompare {
        case_insensitive: false,
    };

    #[test]
    fn file_name_handles_both_separators() {
        assert_eq!(file_name_of(r"C:\a\b\cert.pfx"), "cert.pfx");
        assert_eq!(file_name_of("/x/y.p12"), "y.p12");
        assert_eq!(file_name_of("plain.pfx"), "plain.pfx");
        assert_eq!(file_name_of("dir/"), "dir/");
    }

    #[test]
    fn upsert_moves_to_front_and_keeps_label_and_flag() {
        let list = upsert_known_pfx(&[], r"C:\a.pfx", WIN, &PfxPatch::default());
        assert_eq!(list[0].label, "a.pfx");
        let list = upsert_known_pfx(
            &list,
            r"C:\a.pfx",
            WIN,
            &PfxPatch {
                label: Some("Công ty".into()),
                remembered: Some(true),
            },
        );
        let list = upsert_known_pfx(&list, r"C:\b.pfx", WIN, &PfxPatch::default());
        let list = upsert_known_pfx(&list, r"c:\A.PFX", WIN, &PfxPatch::default());
        assert_eq!(list.len(), 2, "không phân biệt hoa thường trên Windows");
        assert_eq!(list[0].path, r"c:\A.PFX");
        assert_eq!(list[0].label, "Công ty");
        assert!(list[0].remembered);
        assert_eq!(list[1].path, r"C:\b.pfx");
    }

    #[test]
    fn posix_compare_is_case_sensitive() {
        let list = upsert_known_pfx(&[], "/a.pfx", POSIX, &PfxPatch::default());
        let list = upsert_known_pfx(&list, "/A.pfx", POSIX, &PfxPatch::default());
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn list_is_capped_and_remove_and_remember_work() {
        let mut list = Vec::new();
        for i in 0..(MAX_KNOWN_PFX + 5) {
            list = upsert_known_pfx(&list, &format!("/f{i}.pfx"), POSIX, &PfxPatch::default());
        }
        assert_eq!(list.len(), MAX_KNOWN_PFX);
        assert_eq!(list[0].path, format!("/f{}.pfx", MAX_KNOWN_PFX + 4));
        let removed = remove_known_pfx(&list, &list[0].path.clone(), POSIX);
        assert_eq!(removed.len(), MAX_KNOWN_PFX - 1);
        let target = removed[2].path.clone();
        let flagged = set_remembered(&removed, &target, true, POSIX);
        assert!(flagged[2].remembered);
        assert!(flagged.iter().filter(|e| e.remembered).count() == 1);
    }
}
