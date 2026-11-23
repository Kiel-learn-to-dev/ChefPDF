//! Kiểm tra trước khi gửi (TASKS_RUST R5.48, FEATURES J5): port `preflightModel.ts`. Đọc danh sách
//! kiểm của `preflight.check` và quyết định nút "Sửa" làm gì (chạy thao tác, mở hộp thoại, hay chỉ
//! gợi ý). Logic thuần.
#![allow(dead_code)]

use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Ok,
    Warn,
    Fail,
}

impl Status {
    fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "ok" => Self::Ok,
            "warn" => Self::Warn,
            "fail" => Self::Fail,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FixOp {
    pub op: String,
    pub params: Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CheckItem {
    pub id: String,
    pub status: Status,
    pub title_vi: String,
    pub title_en: String,
    pub detail: Value,
    pub fix_op: Option<FixOp>,
}

/// Đọc danh sách kiểm; dòng sai dạng bị bỏ.
pub fn read_checklist(data: &Value) -> Vec<CheckItem> {
    data.as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            let id = r.get("id")?.as_str()?;
            let title = |k: &str| r.get(k).and_then(Value::as_str).unwrap_or(id).to_string();
            let fix_op = r.get("fixOp").and_then(|f| {
                let op = f.get("op")?.as_str()?.to_string();
                let params = f
                    .get("params")
                    .filter(|p| p.is_object())
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                Some(FixOp { op, params })
            });
            Some(CheckItem {
                id: id.to_string(),
                status: Status::parse(r.get("status")?.as_str()?)?,
                title_vi: title("titleVi"),
                title_en: title("titleEn"),
                detail: r
                    .get("detail")
                    .filter(|d| d.is_object())
                    .cloned()
                    .unwrap_or_else(|| json!({})),
                fix_op,
            })
        })
        .collect()
}

/// Mức giới hạn dung lượng (MB); 0 là không giới hạn.
pub const SIZE_LIMITS_MB: [u32; 4] = [0, 5, 10, 25];

/// Byte cho `maxBytes` của `preflight.check`; None khi không giới hạn.
pub fn max_bytes_of(mb: u32) -> Option<u64> {
    (mb > 0).then(|| mb as u64 * 1024 * 1024)
}

/// Mục cần chú ý: lỗi trước, rồi cảnh báo, rồi đạt; ổn định.
pub fn attention_items(items: &[CheckItem]) -> Vec<CheckItem> {
    let mut v = items.to_vec();
    v.sort_by_key(|i| match i.status {
        Status::Fail => 0,
        Status::Warn => 1,
        Status::Ok => 2,
    });
    v
}

pub fn count_by_status(items: &[CheckItem]) -> [usize; 3] {
    let mut c = [0; 3];
    for i in items {
        c[i.status as usize] += 1;
    }
    c
}

#[derive(Debug, Clone, PartialEq)]
pub enum FixAction {
    None,
    Run { op_id: &'static str, params: Value },
    Dialog(&'static str),
    Hint,
}

fn dialog_for(op: &str) -> Option<&'static str> {
    Some(match op {
        "security.decrypt" | "security.encrypt" => "security",
        "inspect.removeHidden" | "inspect.hiddenData" => "inspect",
        "compress.pdf" | "compress.fitSize" | "compress.estimate" => "compress",
        _ => return None,
    })
}

/// Chỉ số trang của `page.delete`: số nguyên không âm, không trùng (giữ thứ tự gặp đầu tiên).
fn page_list(v: Option<&Value>) -> Option<Vec<u64>> {
    let mut out: Vec<u64> = Vec::new();
    for n in v?.as_array()? {
        if let Some(n) = n.as_u64() {
            if !out.contains(&n) {
                out.push(n);
            }
        }
    }
    (!out.is_empty()).then_some(out)
}

/// Nút sửa làm gì. Thuần: bên gọi chạy thao tác hoặc mở hộp thoại.
pub fn fix_action_of(item: &CheckItem) -> FixAction {
    let Some(fix) = &item.fix_op else {
        return FixAction::None;
    };
    match fix.op.as_str() {
        "inspect.removeHidden" => {
            let cats: Vec<&str> = fix
                .params
                .get("categories")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            if !cats.is_empty() {
                return FixAction::Run {
                    op_id: "inspect.removeHidden",
                    params: json!({"categories": cats}),
                };
            }
        }
        "security.decrypt" => {
            return FixAction::Run {
                op_id: "security.decrypt",
                params: json!({}),
            };
        }
        "page.delete" => {
            if let Some(pages) = page_list(fix.params.get("pages")) {
                return FixAction::Run {
                    op_id: "page.delete",
                    params: json!({"pages": pages}),
                };
            }
        }
        _ => {}
    }
    dialog_for(&fix.op).map_or(FixAction::Hint, FixAction::Dialog)
}

/// Thao tác danh sách kiểm chạy thẳng được.
pub fn is_runnable_fix(op: &str) -> bool {
    matches!(
        op,
        "inspect.removeHidden" | "security.decrypt" | "page.delete"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, st: &str, fix: Value) -> Value {
        json!({"id":id,"status":st,"titleVi":format!("VI {id}"),"fixOp":fix})
    }

    #[test]
    fn reads_only_well_formed_rows() {
        let l = read_checklist(&json!([
            item("a", "ok", Value::Null), item("b", "weird", Value::Null), {"status":"ok"}, 7,
            {"id":"c","status":"fail","detail":[1],"fixOp":{"op":"page.delete","params":5}}]));
        assert_eq!(
            l.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
            ["a", "c"]
        );
        assert_eq!(
            (l[0].title_en.as_str(), l[0].title_vi.as_str()),
            ("a", "VI a")
        );
        assert_eq!(
            (l[1].detail.clone(), l[1].fix_op.clone().unwrap().params),
            (json!({}), json!({}))
        );
        assert!(read_checklist(&Value::Null).is_empty());
    }

    #[test]
    fn severity_order_counts_and_limits() {
        let l = read_checklist(&json!([
            item("o", "ok", Value::Null),
            item("w", "warn", Value::Null),
            item("f", "fail", Value::Null),
            item("w2", "warn", Value::Null)
        ]));
        assert_eq!(
            attention_items(&l)
                .iter()
                .map(|i| i.id.as_str())
                .collect::<Vec<_>>(),
            ["f", "w", "w2", "o"]
        );
        assert_eq!(count_by_status(&l), [1, 2, 1]);
        assert_eq!(
            (max_bytes_of(0), max_bytes_of(5)),
            (None, Some(5 * 1024 * 1024))
        );
    }

    #[test]
    fn fix_actions() {
        let act = |fix: Value| fix_action_of(&read_checklist(&json!([item("x", "warn", fix)]))[0]);
        assert_eq!(act(Value::Null), FixAction::None);
        assert_eq!(
            act(json!({"op":"security.decrypt"})),
            FixAction::Run {
                op_id: "security.decrypt",
                params: json!({})
            }
        );
        assert_eq!(
            act(json!({"op":"inspect.removeHidden","params":{"categories":["metadata", 5, "js"]}})),
            FixAction::Run {
                op_id: "inspect.removeHidden",
                params: json!({"categories":["metadata","js"]})
            }
        );
        assert_eq!(
            act(json!({"op":"inspect.removeHidden","params":{"categories":[]}})),
            FixAction::Dialog("inspect")
        );
        assert_eq!(
            act(json!({"op":"page.delete","params":{"pages":[2, 2, -1, 0, 1.5]}})),
            FixAction::Run {
                op_id: "page.delete",
                params: json!({"pages":[2, 0]})
            }
        );
        assert_eq!(
            act(json!({"op":"page.delete","params":{"pages":[]}})),
            FixAction::Hint
        );
        assert_eq!(
            act(json!({"op":"compress.fitSize"})),
            FixAction::Dialog("compress")
        );
        assert_eq!(
            act(json!({"op":"security.encrypt"})),
            FixAction::Dialog("security")
        );
        assert_eq!(act(json!({"op":"something.else"})), FixAction::Hint);
        assert!(is_runnable_fix("page.delete") && !is_runnable_fix("compress.pdf"));
    }
}
