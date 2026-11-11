//! Khung dòng JSON-RPC theo CONTRACTS §3: mỗi tin nhắn là một object JSON trên một dòng, kết thúc
//! bằng `\n`. Hàm thuần, không đụng tiến trình, để kiểm thử được.

use serde_json::{Value, json};

/// Tin nhắn nhận từ lõi.
#[derive(Debug, Clone, PartialEq)]
pub enum Incoming {
    /// Phản hồi cho một yêu cầu có `id`: `Ok(result)` hoặc `Err(error object)`.
    Response {
        id: u64,
        outcome: Result<Value, Value>,
    },
    /// Thông báo đẩy về UI (không có `id`), ví dụ `job.progress`.
    Notification { method: String, params: Value },
}

/// Lỗi khi đọc một dòng. Không làm sập client: dòng bị bỏ qua và ghi lại.
#[derive(Debug, Clone, PartialEq)]
pub enum FramingError {
    /// Dòng không phải JSON.
    NotJson(String),
    /// JSON nhưng không đúng dạng JSON-RPC (không có id và không có method, hoặc id không phải số).
    NotRpc(String),
}

/// Dòng yêu cầu gửi đi, có ký tự xuống dòng ở cuối.
pub fn encode_request(id: u64, method: &str, params: &Value) -> String {
    let mut line =
        json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string();
    line.push('\n');
    line
}

/// Đọc một dòng từ lõi.
pub fn decode_line(line: &str) -> Result<Incoming, FramingError> {
    let value: Value =
        serde_json::from_str(line.trim_end()).map_err(|e| FramingError::NotJson(e.to_string()))?;
    let object = value
        .as_object()
        .ok_or_else(|| FramingError::NotRpc("không phải object".into()))?;
    if let Some(id) = object.get("id") {
        let id = id
            .as_u64()
            .ok_or_else(|| FramingError::NotRpc("id không phải số nguyên".into()))?;
        return Ok(match object.get("error") {
            Some(error) => Incoming::Response {
                id,
                outcome: Err(error.clone()),
            },
            None => Incoming::Response {
                id,
                outcome: Ok(object.get("result").cloned().unwrap_or(Value::Null)),
            },
        });
    }
    let method = object
        .get("method")
        .and_then(Value::as_str)
        .ok_or_else(|| FramingError::NotRpc("thiếu method".into()))?;
    Ok(Incoming::Notification {
        method: method.to_string(),
        params: object.get("params").cloned().unwrap_or(Value::Null),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_is_one_line_with_id_and_method() {
        let line = encode_request(7, "system.ping", &json!({}));
        assert!(line.ends_with('\n'));
        assert_eq!(line.matches('\n').count(), 1);
        let v: Value = serde_json::from_str(line.trim_end()).unwrap();
        assert_eq!(v["id"], 7);
        assert_eq!(v["method"], "system.ping");
    }

    #[test]
    fn response_with_result_or_error_is_matched_by_id() {
        let ok = decode_line(r#"{"jsonrpc":"2.0","id":3,"result":{"pong":true}}"#).unwrap();
        assert_eq!(
            ok,
            Incoming::Response {
                id: 3,
                outcome: Ok(json!({"pong": true}))
            }
        );
        let err = decode_line(r#"{"jsonrpc":"2.0","id":4,"error":{"code":-32601,"message":"x"}}"#)
            .unwrap();
        assert!(matches!(
            err,
            Incoming::Response {
                id: 4,
                outcome: Err(_)
            }
        ));
    }

    #[test]
    fn notification_has_no_id() {
        let n = decode_line(r#"{"jsonrpc":"2.0","method":"job.progress","params":{"done":1}}"#)
            .unwrap();
        assert_eq!(
            n,
            Incoming::Notification {
                method: "job.progress".into(),
                params: json!({"done": 1})
            }
        );
    }

    #[test]
    fn broken_lines_are_reported_not_panicked() {
        assert!(matches!(
            decode_line("{ hỏng"),
            Err(FramingError::NotJson(_))
        ));
        assert!(matches!(decode_line("[1,2]"), Err(FramingError::NotRpc(_))));
        assert!(matches!(
            decode_line(r#"{"id":"abc"}"#),
            Err(FramingError::NotRpc(_))
        ));
        assert!(matches!(
            decode_line(r#"{"x":1}"#),
            Err(FramingError::NotRpc(_))
        ));
    }
}
