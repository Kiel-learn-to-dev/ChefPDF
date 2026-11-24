//! Tùy chọn dùng gần nhất của các hộp thoại overlay (TASKS_RUST R5.29–R5.38; FEATURES F-prefs): port
//! `overlayPrefs.ts`. Lưu trong `settings.prefs.overlay.<hộp thoại>`; chỉ lưu lựa chọn thuần, không bao giờ
//! lưu đường dẫn, danh sách file, thư mục hay mật khẩu. Giá trị lưu được kiểm theo hình dạng của mặc định,
//! sai thì về mặc định. Logic thuần.
#![allow(dead_code)]

use serde_json::{Map, Value};

pub const PREF_KEY: &str = "overlay";

/// Khóa không bao giờ vào prefs: file và thư mục người dùng chọn.
const NEVER_STORED: [&str; 4] = ["path", "files", "folder", "sourcePath"];

const MAX_TEXT: usize = 5000;

/// Bỏ các khóa kiểu đường dẫn (đệ quy) để form lưu được thành prefs. Mảng giữ nguyên.
pub fn strip_paths(value: &Value) -> Value {
    match value {
        Value::Object(m) => Value::Object(
            m.iter()
                .filter(|(k, _)| !NEVER_STORED.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), strip_paths(v)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// `raw` theo hình dạng `defaults`: mỗi trường giữ giá trị lưu khi cùng kiểu (và đúng tập cho phép nếu
/// `enums` có tên trường), còn lại lấy mặc định. Mảng không bao giờ đọc lại. Chỉ trường của `defaults` sống sót.
pub fn sanitize_like(raw: &Value, defaults: &Value, enums: &Map<String, Value>) -> Value {
    let Value::Object(defs) = defaults else {
        return defaults.clone();
    };
    let empty = Map::new();
    let src = raw.as_object().unwrap_or(&empty);
    let mut out = Map::new();
    for (key, d) in defs {
        let v = src.get(key);
        let kept = if NEVER_STORED.contains(&key.as_str()) || d.is_array() {
            d.clone()
        } else if d.is_object() {
            sanitize_like(v.unwrap_or(&Value::Null), d, enums)
        } else if d.is_number() {
            match v {
                Some(n) if n.is_number() => n.clone(),
                _ => d.clone(),
            }
        } else if d.is_boolean() {
            match v {
                Some(b) if b.is_boolean() => b.clone(),
                _ => d.clone(),
            }
        } else if d.is_string() {
            let allowed = enums.get(key).and_then(Value::as_array);
            match v {
                Some(Value::String(s))
                    if s.chars().count() <= MAX_TEXT
                        && allowed.is_none_or(|a| a.contains(v.unwrap())) =>
                {
                    Value::String(s.clone())
                }
                _ => d.clone(),
            }
        } else {
            d.clone()
        };
        out.insert(key.clone(), kept);
    }
    Value::Object(out)
}

/// Prefs đã lưu của một hộp thoại, kiểm theo mặc định.
pub fn read_prefs(
    prefs: &Map<String, Value>,
    dialog: &str,
    defaults: &Value,
    enums: &Map<String, Value>,
) -> Value {
    let own = prefs
        .get(PREF_KEY)
        .and_then(Value::as_object)
        .and_then(|f| f.get(dialog))
        .unwrap_or(&Value::Null);
    sanitize_like(own, defaults, enums)
}

/// Đối tượng prefs với lựa chọn của một hộp thoại được thay; hộp thoại và tính năng khác giữ nguyên.
pub fn write_prefs(prefs: &Map<String, Value>, dialog: &str, value: &Value) -> Map<String, Value> {
    let mut current = prefs
        .get(PREF_KEY)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    current.insert(dialog.to_string(), strip_paths(value));
    let mut out = prefs.clone();
    out.insert(PREF_KEY.to_string(), Value::Object(current));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn defaults() -> Value {
        json!({
            "text": "Mẫu", "size": 12, "bold": false, "position": "center",
            "files": ["x"], "path": "", "color": { "hex": "#000000", "alpha": 1 },
        })
    }

    fn enums() -> Map<String, Value> {
        json!({ "position": ["center", "top"] })
            .as_object()
            .unwrap()
            .clone()
    }

    #[test]
    fn strip_paths_removes_file_keys_recursively_and_keeps_arrays() {
        let v = json!({ "a": 1, "path": "C:/x", "inner": { "folder": "f", "keep": true }, "list": [{ "path": "keep-in-array" }] });
        assert_eq!(
            strip_paths(&v),
            json!({ "a": 1, "inner": { "keep": true }, "list": [{ "path": "keep-in-array" }] })
        );
    }

    #[test]
    fn matching_types_survive_and_wrong_ones_fall_back() {
        let raw = json!({ "text": "Khác", "size": "to", "bold": true, "position": "top", "extra": 1,
                          "color": { "hex": 5, "alpha": 0.5 } });
        let out = sanitize_like(&raw, &defaults(), &enums());
        assert_eq!(out["text"], "Khác");
        assert_eq!(out["size"], 12, "chuỗi thay số về mặc định");
        assert_eq!(out["bold"], true);
        assert_eq!(out["position"], "top");
        assert_eq!(out["color"], json!({ "hex": "#000000", "alpha": 0.5 }));
        assert!(
            out.get("extra").is_none(),
            "chỉ trường của mặc định sống sót"
        );
    }

    #[test]
    fn enum_and_length_and_paths_are_enforced() {
        let raw = json!({ "position": "bottom", "text": "a".repeat(5001), "path": "C:/secret", "files": ["leak"] });
        let out = sanitize_like(&raw, &defaults(), &enums());
        assert_eq!(out["position"], "center");
        assert_eq!(out["text"], "Mẫu");
        assert_eq!(out["path"], "");
        assert_eq!(out["files"], json!(["x"]));
    }

    #[test]
    fn missing_or_garbage_raw_gives_defaults() {
        assert_eq!(
            sanitize_like(&Value::Null, &defaults(), &enums()),
            defaults()
        );
        assert_eq!(
            sanitize_like(&json!([1, 2]), &defaults(), &enums()),
            defaults()
        );
    }

    #[test]
    fn read_and_write_round_trip_without_touching_other_prefs() {
        let mut prefs = Map::new();
        prefs.insert("sign".into(), json!({ "level": "B-B" }));
        let stored = json!({ "text": "Lưu", "size": 20, "path": "C:/never" });
        let written = write_prefs(&prefs, "watermark", &stored);
        assert_eq!(written["sign"], json!({ "level": "B-B" }));
        assert!(written["overlay"]["watermark"].get("path").is_none());
        let back = read_prefs(&written, "watermark", &defaults(), &enums());
        assert_eq!(back["text"], "Lưu");
        assert_eq!(back["size"], 20);
        assert_eq!(back["path"], "");
        let other = write_prefs(&written, "stamp", &json!({ "text": "S" }));
        assert_eq!(other["overlay"]["watermark"]["text"], "Lưu");
        assert_eq!(
            read_prefs(&Map::new(), "x", &defaults(), &enums()),
            defaults()
        );
    }
}
