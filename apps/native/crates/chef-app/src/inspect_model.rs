//! Soi file và dọn dữ liệu ẩn (TASKS_RUST R5.46, R5.47; FEATURES J3, J4): port `inspectModel.ts`. Đọc
//! kết quả `inspect.hiddenData`, dựng tham số `inspect.removeHidden`, tóm tắt trước/sau. Logic thuần.
#![allow(dead_code)]

use serde_json::{Map, Value, json};
use std::collections::BTreeMap;

pub const INSPECT_CATEGORIES: [&str; 16] = [
    "metadata",
    "embeddedFiles",
    "javascript",
    "launchActions",
    "hiddenText",
    "hiddenLayers",
    "comments",
    "formValues",
    "bookmarks",
    "thumbnails",
    "externalLinks",
    "xfa",
    "revisionHistory",
    "unusedObjects",
    "fontsNotEmbedded",
    "images",
];

/// Nhóm `inspect.removeHidden` nhận (phần còn lại chỉ báo cáo).
pub const REMOVABLE: [&str; 13] = [
    "metadata",
    "embeddedFiles",
    "javascript",
    "launchActions",
    "hiddenLayers",
    "comments",
    "formValues",
    "bookmarks",
    "thumbnails",
    "externalLinks",
    "xfa",
    "revisionHistory",
    "unusedObjects",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Info,
    Warn,
    Risk,
}

impl Severity {
    fn parse(s: Option<&str>) -> Severity {
        match s {
            Some("warn") => Severity::Warn,
            Some("risk") => Severity::Risk,
            _ => Severity::Info,
        }
    }
    fn rank(self) -> u8 {
        match self {
            Severity::Risk => 0,
            Severity::Warn => 1,
            Severity::Info => 2,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Finding {
    pub category: String,
    pub severity: Severity,
    pub count: u64,
    pub items: Vec<Map<String, Value>>,
    pub fix_available: bool,
}

fn read_item(v: &Value) -> Option<Map<String, Value>> {
    let o = v.as_object()?;
    Some(
        o.iter()
            .filter(|(_, x)| {
                matches!(
                    x,
                    Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null
                )
            })
            .map(|(k, x)| (k.clone(), x.clone()))
            .collect(),
    )
}

/// Phát hiện của `inspect.hiddenData`; nhóm lạ bị bỏ.
pub fn read_findings(data: &Value) -> Vec<Finding> {
    data.get("findings")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let category = r
                .get("category")?
                .as_str()
                .filter(|c| INSPECT_CATEGORIES.contains(c))?
                .to_string();
            let items: Vec<_> = r
                .get("items")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(read_item).collect())
                .unwrap_or_default();
            let count = r
                .get("count")
                .and_then(Value::as_f64)
                .filter(|n| *n >= 0.0)
                .map_or(items.len() as u64, |n| n.floor() as u64);
            Some(Finding {
                category,
                severity: Severity::parse(r.get("severity").and_then(Value::as_str)),
                count,
                items,
                fix_available: r.get("fixAvailable").and_then(Value::as_bool) == Some(true),
            })
        })
        .collect()
}

/// Phát hiện có nội dung, nghiêm trọng nhất trước (ổn định).
pub fn present_findings(findings: &[Finding]) -> Vec<Finding> {
    let mut v: Vec<Finding> = findings.iter().filter(|f| f.count > 0).cloned().collect();
    v.sort_by_key(|f| f.severity.rank());
    v
}

/// Nhóm người dùng gỡ được ngay: có mặt và lõi có cách sửa.
pub fn removable_of(findings: &[Finding]) -> Vec<String> {
    findings
        .iter()
        .filter(|f| f.count > 0 && f.fix_available && REMOVABLE.contains(&f.category.as_str()))
        .map(|f| f.category.clone())
        .collect()
}

/// `inspect.removeHidden`: chỉ nhóm gỡ được, không trùng.
pub fn remove_params(selected: &[String]) -> Value {
    let mut cats: Vec<&String> = Vec::new();
    for c in selected {
        if REMOVABLE.contains(&c.as_str()) && !cats.contains(&c) {
            cats.push(c);
        }
    }
    json!({ "categories": cats })
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RemoveSummary {
    pub removed: BTreeMap<String, i64>,
    pub before: BTreeMap<String, i64>,
    pub after: BTreeMap<String, i64>,
    pub total_before: i64,
    pub total_after: i64,
}

fn read_counts(v: Option<&Value>) -> BTreeMap<String, i64> {
    v.and_then(Value::as_object)
        .map(|o| {
            o.iter()
                .filter(|(k, _)| INSPECT_CATEGORIES.contains(&k.as_str()))
                .filter_map(|(k, n)| Some((k.clone(), n.as_i64()?)))
                .collect()
        })
        .unwrap_or_default()
}

/// Dữ liệu `inspect.removeHidden`: đã gỡ gì, số lượng trước và sau.
pub fn read_remove_summary(d: &Value) -> RemoveSummary {
    let before = read_counts(d.get("before"));
    let after = read_counts(d.get("after"));
    RemoveSummary {
        removed: read_counts(d.get("removed")),
        total_before: before.values().sum(),
        total_after: after.values().sum(),
        before,
        after,
    }
}

/// Dòng đọc được cho một mục (khóa từ lõi: page, where, key, name, value, file, subtype, chars).
/// `tr(khóa, số)` dịch chuỗi có tham số số.
pub fn item_text(item: &Map<String, Value>, tr: &dyn Fn(&str, i64) -> String) -> String {
    let mut parts: Vec<String> = Vec::new();
    let s = |k: &str| item.get(k).and_then(Value::as_str);
    if let Some(n) = item.get("page").and_then(Value::as_i64) {
        parts.push(tr("inspect.item.page", n));
    }
    for k in ["where", "key", "name"] {
        if let Some(v) = s(k) {
            parts.push(v.into());
        }
    }
    if let Some(v) = s("value").filter(|v| !v.is_empty()) {
        parts.push(format!("= {v}"));
    }
    if let Some(v) = s("file").filter(|v| !v.is_empty()) {
        parts.push(v.into());
    }
    if let Some(v) = s("subtype") {
        parts.push(v.into());
    }
    if let Some(n) = item.get("chars").and_then(Value::as_i64) {
        parts.push(tr("inspect.item.chars", n));
    }
    if parts.is_empty() {
        "—".into()
    } else {
        parts.join(" · ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data() -> Value {
        json!({"findings":[
            {"category":"metadata","severity":"warn","count":2,"items":[{"key":"Author","value":"An","x":[1]}],"fixAvailable":true},
            {"category":"javascript","severity":"risk","items":[{"name":"f"}],"fixAvailable":true},
            {"category":"hiddenText","severity":"info","count":3,"fixAvailable":true},
            {"category":"images","count":0},
            {"category":"nope","count":9}, {"count":1}, 4,
            {"category":"comments","severity":"weird","count":-5,"items":[]}]})
    }

    #[test]
    fn reads_validates_and_orders() {
        let f = read_findings(&data());
        assert_eq!(
            f.iter().map(|x| x.category.as_str()).collect::<Vec<_>>(),
            ["metadata", "javascript", "hiddenText", "images", "comments"]
        );
        assert_eq!(
            (f[1].count, f[4].count, f[4].severity),
            (1, 0, Severity::Info),
            "thiếu count lấy số mục; count âm lấy số mục"
        );
        assert_eq!(f[0].items[0].len(), 2, "mục lồng nhau bị bỏ");
        let p = present_findings(&f);
        assert_eq!(
            p.iter().map(|x| x.category.as_str()).collect::<Vec<_>>(),
            ["javascript", "metadata", "hiddenText"]
        );
        assert_eq!(
            removable_of(&f),
            ["metadata", "javascript"],
            "hiddenText chỉ báo cáo"
        );
    }

    #[test]
    fn remove_params_filter_and_dedupe() {
        let sel: Vec<String> = ["metadata", "hiddenText", "metadata", "xfa", "zzz"]
            .map(String::from)
            .to_vec();
        assert_eq!(
            remove_params(&sel),
            json!({"categories":["metadata","xfa"]})
        );
        assert_eq!(remove_params(&[]), json!({"categories":[]}));
    }

    #[test]
    fn summary_and_item_text() {
        let s = read_remove_summary(
            &json!({"removed":{"metadata":2},"before":{"metadata":2,"comments":3,"junk":9},"after":{"comments":3}}),
        );
        assert_eq!(
            (s.total_before, s.total_after, s.removed["metadata"]),
            (5, 3, 2)
        );
        assert_eq!(read_remove_summary(&Value::Null), RemoveSummary::default());
        let tr = |k: &str, n: i64| format!("{k}:{n}");
        let item = json!({"page":3,"where":"Trang","key":"Author","value":"An","file":"","chars":12,"subtype":"Text"});
        assert_eq!(
            item_text(item.as_object().unwrap(), &tr),
            "inspect.item.page:3 · Trang · Author · = An · Text · inspect.item.chars:12"
        );
        assert_eq!(item_text(&Map::new(), &tr), "—");
    }
}
