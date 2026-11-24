//! chef-contracts: kiểu dữ liệu sinh từ JSON Schema của lõi (TASKS_RUST R1.42, probe typify).
//! Các struct trong `layout_types` được sinh lúc build từ core/chef_core/layout/schema.json.

#[allow(clippy::all, dead_code, non_camel_case_types)]
pub mod layout_types {
    include!(concat!(env!("OUT_DIR"), "/layout_types.rs"));
}

/// `Params` của mọi operation, sinh từ `schema/ops.schema.json` (R3.07).
#[allow(clippy::all, dead_code, non_camel_case_types)]
pub mod ops_types {
    include!(concat!(env!("OUT_DIR"), "/ops_types.rs"));
}

/// Schema gốc của mọi `Params` (`schema/ops.schema.json`), cho renderer hộp thoại (R5.02).
pub const OPS_SCHEMA: &str = include_str!("../schema/ops.schema.json");

/// Giá trị mặc định của từng trường, `{ "<Params>": { "<trường>": <giá trị> } }`. Schema ở trên bỏ `default`
/// (để typify sinh `Option` và lõi tự áp mặc định), nên mặc định đi riêng ở đây cho hộp thoại hiện đúng
/// giá trị mà lõi sẽ dùng. Trường mặc định `null` không có trong file.
pub const OPS_DEFAULTS: &str = include_str!("../schema/ops.defaults.json");

/// `OPS_SCHEMA` đã đọc thành JSON, kèm `default` của từng trường lấy từ [`OPS_DEFAULTS`].
pub fn ops_schema() -> serde_json::Value {
    let mut schema: serde_json::Value =
        serde_json::from_str(OPS_SCHEMA).expect("ops.schema.json hợp lệ (kiểm bằng test)");
    let defaults: serde_json::Value =
        serde_json::from_str(OPS_DEFAULTS).expect("ops.defaults.json hợp lệ (kiểm bằng test)");
    if let Some(defaults) = defaults.as_object() {
        for (params, fields) in defaults {
            let Some(props) = schema
                .pointer_mut(&format!("/definitions/{params}/properties"))
                .and_then(serde_json::Value::as_object_mut)
            else {
                continue;
            };
            for (field, value) in fields.as_object().into_iter().flatten() {
                if let Some(node) = props
                    .get_mut(field)
                    .and_then(serde_json::Value::as_object_mut)
                {
                    node.insert("default".to_string(), value.clone());
                }
            }
        }
    }
    schema
}

#[cfg(test)]
mod tests {
    use super::layout_types::Paragraph;

    #[test]
    fn generated_paragraph_deserializes_from_a_core_shaped_json() {
        // Theo schema của lõi: bbox bắt buộc, runs là danh sách có text bắt buộc.
        let text = r#"{"bbox":[0,0,100,20],"runs":[{"text":"Xin chào"}]}"#;
        let parsed: Paragraph = serde_json::from_str(text).expect("Paragraph phải đọc được");
        assert_eq!(parsed.runs.len(), 1);
        assert_eq!(parsed.runs[0].text, "Xin chào");
    }

    #[test]
    fn generated_type_rejects_a_paragraph_without_bbox() {
        let parsed: Result<Paragraph, _> = serde_json::from_str(r#"{"runs":[]}"#);
        assert!(parsed.is_err(), "thiếu bbox (bắt buộc) phải bị từ chối");
    }

    #[test]
    fn defaults_are_merged_into_the_schema_without_touching_required() {
        let schema = super::ops_schema();
        let split = &schema["definitions"]["PageSplitParams"];
        assert_eq!(split["properties"]["cols"]["default"], 2);
        assert_eq!(split["properties"]["order"]["default"], "ltr");
        // Trường có mặc định vẫn không bắt buộc, như trong file schema gốc.
        assert!(
            split
                .get("required")
                .is_none_or(|r| r.as_array().is_some_and(|r| r.is_empty()))
        );
        // Mọi mục trong file mặc định trỏ tới một trường có thật.
        let defaults: serde_json::Value = serde_json::from_str(super::OPS_DEFAULTS).unwrap();
        for (params, fields) in defaults.as_object().unwrap() {
            for field in fields.as_object().unwrap().keys() {
                assert!(
                    schema["definitions"][params]["properties"]
                        .get(field)
                        .is_some(),
                    "{params}.{field}"
                );
            }
        }
    }

    const OPS_SCHEMA: &str = include_str!("../schema/ops.schema.json");
    const OPS_GENERATED: &str = include_str!(concat!(env!("OUT_DIR"), "/ops_types.rs"));

    #[test]
    fn every_operation_params_has_a_generated_struct() {
        let schema: serde_json::Value = serde_json::from_str(OPS_SCHEMA).unwrap();
        let names: Vec<&String> = schema["definitions"]
            .as_object()
            .unwrap()
            .keys()
            .filter(|name| name.ends_with("Params"))
            .collect();
        assert!(names.len() > 150, "schema thiếu operation: {}", names.len());
        for name in names {
            assert!(
                OPS_GENERATED.contains(&format!("pub struct {name} ")),
                "không có struct sinh cho {name}"
            );
        }
    }

    #[test]
    fn page_rotate_params_match_the_core_wire_shape() {
        use super::ops_types::PageRotateParams;
        let ok: PageRotateParams =
            serde_json::from_str(r#"{"pages":[0,2],"angle":90}"#).expect("page.rotate params");
        assert_eq!(ok.pages, vec![0, 2]);
        let back = serde_json::to_value(&ok).unwrap();
        assert_eq!(back, serde_json::json!({"pages":[0,2],"angle":90}));
        assert!(serde_json::from_str::<PageRotateParams>(r#"{"angle":90}"#).is_err());
        assert!(serde_json::from_str::<PageRotateParams>(r#"{"pages":[0],"angle":45}"#).is_err());
        assert!(
            serde_json::from_str::<PageRotateParams>(r#"{"pages":[0],"angle":90,"x":1}"#).is_err(),
            "field lạ phải bị từ chối (additionalProperties: false)"
        );
    }

    /// Enum nội tuyến trùng title (`Mode`, `Fit`, ...) không được gộp giữa các operation.
    #[test]
    fn same_titled_enums_stay_separate_per_operation() {
        use super::ops_types::{FileSplitParams, PageCropParams, PageResizeParams};
        let split: FileSplitParams = serde_json::from_value(serde_json::json!(
            {"mode":"ranges","ranges":"1-3","outputDir":"/o","nameTemplate":"{name}_{index}"}
        ))
        .expect("file.split");
        assert_eq!(serde_json::to_value(&split).unwrap()["mode"], "ranges");
        let crop: PageCropParams = serde_json::from_value(
            serde_json::json!({"mode":"cropbox","scope":"all","autoTrim":true}),
        )
        .expect("page.crop");
        assert_eq!(serde_json::to_value(&crop).unwrap()["mode"], "cropbox");
        let resize: PageResizeParams =
            serde_json::from_value(serde_json::json!({"fit":"scale","scope":"all","size":"A4"}))
                .expect("page.resize");
        assert_eq!(serde_json::to_value(&resize).unwrap()["size"], "A4");
    }
}
