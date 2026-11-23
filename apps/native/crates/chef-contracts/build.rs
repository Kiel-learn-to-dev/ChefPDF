//! Sinh struct Rust từ JSON Schema của lõi (TASKS_RUST R1.42 và R3.07).
//!
//! - `core/chef_core/layout/schema.json` → `OUT_DIR/layout_types.rs` (`layout_types`).
//! - `schema/ops.schema.json` (do `python -m chef_core.codegen` sinh, `--check` báo lệch)
//!   → `OUT_DIR/ops_types.rs` (`ops_types`): `Params` của mọi operation.
//!
//! lib.rs nạp lại bằng `include!`. Đổi `Params` ở lõi mà chưa chạy codegen thì `--check` lỗi;
//! chạy codegen rồi mà code Rust dùng field cũ thì build lỗi.

use std::path::{Path, PathBuf};

/// Tên các definition mà `value` tham chiếu bằng `$ref`.
fn collect_refs(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, v) in map {
                if key == "$ref" {
                    if let Some(name) = v.as_str().and_then(|s| s.strip_prefix("#/definitions/")) {
                        out.push(name.to_string());
                    }
                } else {
                    collect_refs(v, out);
                }
            }
        }
        serde_json::Value::Array(items) => items.iter().for_each(|v| collect_refs(v, out)),
        _ => {}
    }
}

/// Khi typify lỗi, thử từng definition cùng các definition nó cần để chỉ ra definition hỏng.
fn find_failing_definitions(text: &str) -> Vec<String> {
    let root: serde_json::Value = serde_json::from_str(text).expect("schema JSON");
    let defs = root["definitions"].as_object().cloned().unwrap_or_default();
    let mut bad = Vec::new();
    for name in defs.keys() {
        let mut needed = vec![name.clone()];
        let mut i = 0;
        while i < needed.len() {
            let mut refs = Vec::new();
            collect_refs(&defs[&needed[i]], &mut refs);
            for r in refs {
                if !needed.contains(&r) && defs.contains_key(&r) {
                    needed.push(r);
                }
            }
            i += 1;
        }
        let subset: serde_json::Map<String, serde_json::Value> = needed
            .iter()
            .map(|n| (n.clone(), defs[n].clone()))
            .collect();
        let mut sub_root = root.clone();
        sub_root["definitions"] = serde_json::Value::Object(subset);
        let Ok(schema) = serde_json::from_value::<schemars::schema::RootSchema>(sub_root) else {
            continue;
        };
        let failed = std::panic::catch_unwind(|| {
            let mut space = typify::TypeSpace::default();
            space.add_root_schema(schema).is_err()
        });
        if failed.unwrap_or(true) {
            bad.push(name.clone());
        }
    }
    bad
}

/// Gom các enum nội tuyến theo `title`: title → các tập giá trị khác nhau đã gặp.
fn collect_enum_titles(
    value: &serde_json::Value,
    out: &mut std::collections::BTreeMap<String, Vec<serde_json::Value>>,
) {
    match value {
        serde_json::Value::Object(map) => {
            if let (Some(title), Some(values)) = (
                map.get("title").and_then(|t| t.as_str()),
                map.get("enum"),
            ) {
                let seen = out.entry(title.to_string()).or_default();
                if !seen.contains(values) {
                    seen.push(values.clone());
                }
            }
            map.values().for_each(|v| collect_enum_titles(v, out));
        }
        serde_json::Value::Array(items) => items.iter().for_each(|v| collect_enum_titles(v, out)),
        _ => {}
    }
}

/// Đổi `title` của enum nội tuyến thành `<Definition><Title>` khi cùng title mà khác tập giá trị.
/// Nếu không, typify gộp chúng thành một enum (ví dụ `Mode` của `file.split` thành `remove`/
/// `replaceColor`) và struct sinh không đọc lại được JSON hợp lệ của lõi.
fn qualify_colliding_enums(root: &mut serde_json::Value) {
    fn rename(value: &mut serde_json::Value, prefix: &str, colliding: &[String]) {
        match value {
            serde_json::Value::Object(map) => {
                if map.contains_key("enum") {
                    if let Some(t) = map.get("title").and_then(|t| t.as_str()) {
                        if colliding.iter().any(|c| c == t) {
                            let new = format!("{prefix}{t}");
                            map.insert("title".into(), serde_json::Value::String(new));
                        }
                    }
                }
                map.values_mut().for_each(|v| rename(v, prefix, colliding));
            }
            serde_json::Value::Array(items) => {
                items.iter_mut().for_each(|v| rename(v, prefix, colliding))
            }
            _ => {}
        }
    }
    let mut titles = std::collections::BTreeMap::new();
    collect_enum_titles(root, &mut titles);
    let colliding: Vec<String> = titles
        .into_iter()
        .filter(|(_, sets)| sets.len() > 1)
        .map(|(t, _)| t)
        .collect();
    if colliding.is_empty() {
        return;
    }
    if let Some(defs) = root.get_mut("definitions").and_then(|d| d.as_object_mut()) {
        for (name, def) in defs.iter_mut() {
            rename(def, name, &colliding);
        }
    }
}

fn generate(schema_path: &Path, out_name: &str, qualify_enums: bool) {
    println!("cargo:rerun-if-changed={}", schema_path.display());
    let text = std::fs::read_to_string(schema_path)
        .unwrap_or_else(|e| panic!("đọc {}: {e}", schema_path.display()));
    let mut json: serde_json::Value = serde_json::from_str(&text)
        .unwrap_or_else(|e| panic!("{} không phải JSON: {e}", schema_path.display()));
    if qualify_enums {
        qualify_colliding_enums(&mut json);
    }
    let text = json.to_string();
    let schema: schemars::schema::RootSchema = serde_json::from_value(json).unwrap_or_else(|e| {
        panic!(
            "{} không đọc được bằng schemars: {e}",
            schema_path.display()
        )
    });
    let mut space = typify::TypeSpace::default();
    if let Err(e) = space.add_root_schema(schema) {
        let bad = find_failing_definitions(&text);
        panic!(
            "typify không sinh được type từ {}: {e}; definition lỗi: {bad:?}",
            schema_path.display()
        );
    }
    let file: syn::File = syn::parse2(space.to_stream()).expect("mã sinh ra không parse được");
    let out = prettyplease::unparse(&file);
    let dest = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join(out_name);
    std::fs::write(dest, out).unwrap_or_else(|e| panic!("ghi {out_name}: {e}"));
}

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    generate(
        &manifest.join("../../../../core/chef_core/layout/schema.json"),
        "layout_types.rs",
        false,
    );
    generate(&manifest.join("schema/ops.schema.json"), "ops_types.rs", true);
}
