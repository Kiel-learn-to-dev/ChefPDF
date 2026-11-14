//! Lỗi từ lõi: `kind` và khóa thông báo tiếng Việt (TASKS_RUST R3.10, CONTRACTS §3). Mỗi kind có chuỗi
//! `errors.<KIND>` trong i18n, như `lib/errors` của bản Electron. Kind lạ vẫn hiện được qua `UNKNOWN`.

use serde_json::Value;

/// Các `kind` của lõi, đúng danh sách `ErrorKinds` trong packages/contracts/src/rpc.ts. Test
/// `kinds_match_the_electron_contract` đối chiếu với file đó, để hai bên không lệch nhau.
pub const ERROR_KINDS: &[&str] = &[
    "PASSWORD_REQUIRED",
    "PASSWORD_INVALID",
    "FILE_NOT_FOUND",
    "INVALID_PDF",
    "SESSION_NOT_FOUND",
    "OP_NOT_FOUND",
    "INVALID_PARAMS",
    "BLOCKED_BY_SIGNATURE",
    "SIGN_BAD_PASSWORD",
    "SIGN_BAD_CERT",
    "SIGN_CERT_EXPIRED",
    "SIGN_TSA_FAILED",
    "SIGN_FAILED",
    "TOKEN_NOT_FOUND",
    "TOKEN_PIN_INVALID",
    "TOKEN_PIN_LOCKED",
    "TOKEN_PIN_CONFIRM_REQUIRED",
    "TOKEN_DRIVER_ERROR",
    "TOKEN_SUPPORT_UNAVAILABLE",
    "LIBRARY_INVALID",
    "LIBRARY_NOT_FOUND",
    "LIBRARY_FULL",
    "LIBRARY_KEY_MISSING",
    "LIBRARY_TAMPERED",
    "REDACTION_VERIFY_FAILED",
    "CANCELLED",
    "INTERNAL",
];

/// Kind dùng khi lõi trả kind lạ hoặc không có kind.
pub const UNKNOWN: &str = "UNKNOWN";

/// `kind` của một đối tượng lỗi JSON-RPC (`error.data.kind`). Kind không có trong danh sách thành `UNKNOWN`.
pub fn kind_of(error: &Value) -> &str {
    match error.pointer("/data/kind").and_then(Value::as_str) {
        Some(kind) if ERROR_KINDS.contains(&kind) => kind,
        _ => UNKNOWN,
    }
}

/// Khóa i18n của thông báo cho một kind: `errors.<KIND>`.
pub fn message_key(kind: &str) -> String {
    format!("errors.{kind}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::Path;

    fn repo() -> &'static Path {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../..")
            .leak()
    }

    /// Đọc danh sách `ErrorKinds` từ rpc.ts của Electron (chuỗi trong dấu nháy đơn giữa `[` và `]`).
    fn electron_kinds() -> Vec<String> {
        let text =
            std::fs::read_to_string(repo().join("packages/contracts/src/rpc.ts")).expect("rpc.ts");
        let start = text.find("ErrorKinds = [").expect("ErrorKinds");
        let body = &text[start..];
        let body = &body[..body.find("] as const").expect("kết thúc mảng")];
        body.split('\'')
            .enumerate()
            .filter(|(i, _)| i % 2 == 1)
            .map(|(_, s)| s.to_string())
            .collect()
    }

    fn vi_errors() -> serde_json::Map<String, Value> {
        let text = std::fs::read_to_string(repo().join("apps/native/assets/i18n/vi.json"))
            .expect("vi.json");
        let v: Value = serde_json::from_str(&text).expect("vi.json hợp lệ");
        v["errors"].as_object().cloned().expect("mục errors")
    }

    #[test]
    fn kinds_match_the_electron_contract() {
        let mut ours: Vec<String> = ERROR_KINDS.iter().map(|s| s.to_string()).collect();
        let mut theirs = electron_kinds();
        ours.sort();
        theirs.sort();
        assert_eq!(ours, theirs);
    }

    #[test]
    fn every_kind_has_a_vietnamese_message_equal_to_electron() {
        let ours = vi_errors();
        let electron: Value = serde_json::from_str(
            &std::fs::read_to_string(repo().join("apps/ui/src/i18n/vi.json"))
                .expect("vi.json bản Electron"),
        )
        .expect("json");
        for kind in ERROR_KINDS.iter().chain(std::iter::once(&UNKNOWN)) {
            let key = message_key(kind);
            let name = key.trim_start_matches("errors.");
            let text = ours
                .get(name)
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("thiếu {key}"));
            assert_eq!(
                Some(text),
                electron["errors"][name].as_str(),
                "chuỗi {key} khác bản Electron"
            );
        }
    }

    #[test]
    fn known_kind_is_read_and_unknown_kind_falls_back() {
        let known = json!({"code": -32000, "message": "x", "data": {"kind": "PASSWORD_REQUIRED"}});
        assert_eq!(kind_of(&known), "PASSWORD_REQUIRED");
        let invalid_params = json!({"code": -32602, "message": "Invalid params", "data": {"kind": "INVALID_PARAMS"}});
        assert_eq!(kind_of(&invalid_params), "INVALID_PARAMS");
        assert_eq!(
            message_key(kind_of(&invalid_params)),
            "errors.INVALID_PARAMS"
        );
        let strange = json!({"code": -32000, "message": "x", "data": {"kind": "KHONG_CO"}});
        assert_eq!(kind_of(&strange), UNKNOWN);
        assert_eq!(kind_of(&json!({"code": -32000})), UNKNOWN);
        assert!(
            vi_errors().contains_key(UNKNOWN),
            "phải có thông báo cho UNKNOWN"
        );
    }
}
