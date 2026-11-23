//! Khôi phục phiên sau sự cố (TASKS_RUST R3.10, FEATURES A9): port phần thuần của `recoveryModel.ts`.
//! Đọc danh sách `recovery.list`, bỏ mục sai dạng, mỗi phiên một mục, thay đổi mới nhất trước. Phần
//! thử lại bất đồng bộ của bản TS thuộc luồng chạy, không port ở đây. Logic thuần.
#![allow(dead_code)]

use serde_json::Value;

#[derive(Debug, Clone, PartialEq)]
pub struct RecoverableSession {
    pub session_id: String,
    pub source_path: Option<String>,
    pub opened_at: String,
    pub last_modified: String,
    pub revision: i64,
    pub dirty: bool,
    pub pages: u64,
    pub has_unsaved_changes: bool,
}

fn read_session(v: &Value) -> Option<RecoverableSession> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(String::from);
    let source_path = match v.get("sourcePath")? {
        Value::Null => None,
        Value::String(p) => Some(p.clone()),
        _ => return None,
    };
    Some(RecoverableSession {
        session_id: s("sessionId").filter(|i| !i.is_empty())?,
        source_path,
        opened_at: s("openedAt")?,
        last_modified: s("lastModified")?,
        revision: v.get("revision")?.as_i64()?,
        dirty: v.get("dirty")?.as_bool()?,
        pages: v.get("pages")?.as_u64()?,
        has_unsaved_changes: v.get("hasUnsavedChanges")?.as_bool()?,
    })
}

/// Các phiên đúng dạng trong kết quả `recovery.list`.
pub fn read_recoverable(data: &Value) -> Vec<RecoverableSession> {
    data.as_array()
        .map(|a| a.iter().filter_map(read_session).collect())
        .unwrap_or_default()
}

/// Số giây UNIX của thời điểm ISO; None nếu không đọc được.
fn secs(iso: &str) -> Option<i64> {
    crate::cert_model::parse_iso(iso)
}

/// Thay đổi mới nhất trước; mỗi mã phiên một mục (mục đầu sau khi sắp được giữ).
pub fn sort_recoverable(list: &[RecoverableSession]) -> Vec<RecoverableSession> {
    let mut v = list.to_vec();
    v.sort_by(
        |a, b| match (secs(&b.last_modified), secs(&a.last_modified)) {
            (Some(x), Some(y)) if x != y => x.cmp(&y),
            _ => a.session_id.cmp(&b.session_id),
        },
    );
    let mut seen: Vec<String> = Vec::new();
    v.retain(|s| {
        if seen.contains(&s.session_id) {
            false
        } else {
            seen.push(s.session_id.clone());
            true
        }
    });
    v
}

/// Tên file của tài liệu trong phiên, hoặc None nếu chưa đặt tên.
pub fn recovery_name(s: &RecoverableSession) -> Option<String> {
    let p = s.source_path.as_deref().filter(|p| !p.is_empty())?;
    Some(
        p.rsplit(['/', '\\'])
            .next()
            .filter(|n| !n.is_empty())
            .unwrap_or(p)
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session(id: &str, modified: &str, path: Value) -> Value {
        json!({"sessionId":id,"sourcePath":path,"openedAt":"2026-11-01T00:00:00Z","lastModified":modified,
               "revision":3,"dirty":true,"pages":10,"hasUnsavedChanges":true})
    }

    #[test]
    fn reads_only_well_formed_sessions() {
        let data = json!([session("a", "2026-11-02T10:00:00Z", json!("C:\\x\\Hồ sơ.pdf")), session("", "2026-11-02T10:00:00Z", Value::Null),
            {"sessionId":"b"}, 5, session("c", "2026-11-03T10:00:00Z", Value::Null), {"sessionId":"d","sourcePath":7,"openedAt":"x","lastModified":"y","revision":1,"dirty":false,"pages":1,"hasUnsavedChanges":false}]);
        let l = read_recoverable(&data);
        assert_eq!(
            l.iter().map(|s| s.session_id.as_str()).collect::<Vec<_>>(),
            ["a", "c"]
        );
        assert_eq!(
            (l[0].pages, l[0].revision, l[0].has_unsaved_changes),
            (10, 3, true)
        );
        assert!(read_recoverable(&json!({"x":1})).is_empty());
    }

    #[test]
    fn sorted_newest_first_and_deduped() {
        let mk =
            |id: &str, m: &str| read_recoverable(&json!([session(id, m, Value::Null)])).remove(0);
        let l = [
            mk("old", "2026-11-01T00:00:00Z"),
            mk("new", "2026-11-05T00:00:00Z"),
            mk("new", "2026-11-04T00:00:00Z"),
            mk("tie-b", "2026-11-02T00:00:00Z"),
            mk("tie-a", "2026-11-02T00:00:00Z"),
        ];
        let s = sort_recoverable(&l);
        assert_eq!(
            s.iter()
                .map(|x| (x.session_id.as_str(), x.last_modified.as_str()))
                .collect::<Vec<_>>(),
            [
                ("new", "2026-11-05T00:00:00Z"),
                ("tie-a", "2026-11-02T00:00:00Z"),
                ("tie-b", "2026-11-02T00:00:00Z"),
                ("old", "2026-11-01T00:00:00Z")
            ]
        );
        let bad_date = [mk("z", "không phải ngày"), mk("a", "2026-11-05T00:00:00Z")];
        assert_eq!(
            sort_recoverable(&bad_date)
                .iter()
                .map(|x| x.session_id.as_str())
                .collect::<Vec<_>>(),
            ["a", "z"],
            "ngày hỏng: xếp theo mã"
        );
    }

    #[test]
    fn names() {
        let l = read_recoverable(&json!([
            session("a", "2026-11-02T10:00:00Z", json!("C:\\x\\Hồ sơ.pdf")),
            session("b", "2026-11-02T10:00:00Z", Value::Null),
            session("c", "2026-11-02T10:00:00Z", json!(""))
        ]));
        assert_eq!(
            (
                recovery_name(&l[0]).as_deref(),
                recovery_name(&l[1]),
                recovery_name(&l[2])
            ),
            (Some("Hồ sơ.pdf"), None, None)
        );
    }
}
