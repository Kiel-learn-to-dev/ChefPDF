//! chef-contracts: kiểu dữ liệu sinh từ JSON Schema của lõi (TASKS_RUST R1.42, probe typify).
//! Các struct trong `layout_types` được sinh lúc build từ core/chef_core/layout/schema.json.

#[allow(clippy::all, dead_code, non_camel_case_types)]
pub mod layout_types {
    include!(concat!(env!("OUT_DIR"), "/layout_types.rs"));
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
}
