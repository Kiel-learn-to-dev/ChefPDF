//! Pure-Rust form flattening helpers and contract-checked RPC builders (R4.24).

use chef_contracts::ops_types::FormsFlattenParams;
use serde_json::{Map, Value, json};

use crate::forms_fill::FormDraft;

const MAX_FIELD_NAME_LEN: usize = 120;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FlattenPlan {
    pub fill_params: Option<Value>,
    pub flatten_params: Value,
}

#[cfg_attr(not(test), allow(dead_code))]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FlattenSummary {
    pub flattened: Vec<String>,
    pub kept: Vec<String>,
    pub without_appearance: Vec<String>,
}

pub fn flatten_params(
    names: Option<&[String]>,
    pages: Option<&[usize]>,
    keep_signatures: bool,
    remove_javascript: bool,
) -> Result<Value, String> {
    if let Some(names) = names {
        for name in names {
            let len = name.chars().count();
            if len == 0 || len > MAX_FIELD_NAME_LEN {
                return Err(format!("tên trường không hợp lệ khi làm phẳng: {name}"));
            }
        }
    }
    if let Some(pages) = pages
        && pages.is_empty()
    {
        return Err("danh sách trang làm phẳng không được rỗng".into());
    }

    let mut obj = Map::new();
    if let Some(names) = names {
        obj.insert("names".into(), json!(names));
    }
    if let Some(pages) = pages {
        obj.insert("pages".into(), json!(pages));
    }
    obj.insert("keepSignatures".into(), Value::Bool(keep_signatures));
    obj.insert("removeJavascript".into(), Value::Bool(remove_javascript));

    let typed: FormsFlattenParams = serde_json::from_value(Value::Object(obj))
        .map_err(|e| format!("tham số forms.flatten không hợp lệ: {e}"))?;
    serde_json::to_value(&typed).map_err(|e| e.to_string())
}

pub fn default_flatten_params() -> Result<Value, String> {
    flatten_params(None, None, true, true)
}

pub fn plan_flatten(draft: &FormDraft) -> Result<FlattenPlan, String> {
    if draft.doc.fields.is_empty() {
        return Err("Tài liệu chưa có trường biểu mẫu.".into());
    }
    let fill_params = draft.fill_params()?;
    let flatten_params = default_flatten_params()?;
    Ok(FlattenPlan {
        fill_params,
        flatten_params,
    })
}

#[cfg_attr(not(test), allow(dead_code))]
fn read_string_list(root: &Value, key: &str) -> Vec<String> {
    root.get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn parse_flatten_summary(reply: &Value) -> FlattenSummary {
    let root = reply.get("data").unwrap_or(reply);
    FlattenSummary {
        flattened: read_string_list(root, "flattened"),
        kept: read_string_list(root, "kept"),
        without_appearance: read_string_list(root, "withoutAppearance"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forms_fill::{FieldValue, FormDocData, FormField, FormFieldKind};

    fn text_field(name: &str, value: &str) -> FormField {
        FormField {
            name: name.into(),
            partial_name: name.into(),
            kind: FormFieldKind::Text,
            page: Some(0),
            widgets: Vec::new(),
            value: FieldValue::Text(value.into()),
            options: Vec::new(),
            tooltip: None,
            read_only: false,
            required: false,
            max_len: None,
            multi_select: false,
            combo: false,
        }
    }

    #[test]
    fn default_flatten_params_matches_contract_defaults() {
        let params = default_flatten_params().unwrap();
        assert_eq!(
            params,
            json!({
                "keepSignatures": true,
                "removeJavascript": true,
            })
        );
        let parsed: FormsFlattenParams = serde_json::from_value(params).unwrap();
        assert_eq!(parsed.keep_signatures, Some(true));
        assert_eq!(parsed.remove_javascript, Some(true));
        assert!(parsed.names.is_none());
        assert!(parsed.pages.is_none());
    }

    #[test]
    fn scoped_flatten_params_validates_names_and_pages() {
        let names = vec!["hoten".to_string(), "dongy".to_string()];
        let pages = vec![0usize, 2usize];
        let params = flatten_params(Some(&names), Some(&pages), false, true).unwrap();
        assert_eq!(
            params,
            json!({
                "names": ["hoten", "dongy"],
                "pages": [0, 2],
                "keepSignatures": false,
                "removeJavascript": true,
            })
        );
        assert!(flatten_params(None, Some(&[]), true, true).is_err());
        assert!(flatten_params(Some(&[String::new()]), None, true, true).is_err());
        assert!(
            flatten_params(
                Some(&["a".repeat(MAX_FIELD_NAME_LEN + 1)]),
                None,
                true,
                true
            )
            .is_err()
        );
    }

    #[test]
    fn plan_flatten_includes_unsaved_fill_changes_and_rejects_empty_form() {
        let empty_draft = FormDraft::new(FormDocData::default());
        assert!(plan_flatten(&empty_draft).is_err());

        let doc = FormDocData {
            fields: vec![text_field("hoten", "Cu")],
            xfa: false,
            need_appearances: false,
            has_form: true,
        };
        let mut draft = FormDraft::new(doc);
        let unchanged = plan_flatten(&draft).unwrap();
        assert!(unchanged.fill_params.is_none());
        assert_eq!(unchanged.flatten_params["keepSignatures"], true);

        draft.set_text("hoten", "Moi".into());
        let with_edits = plan_flatten(&draft).unwrap();
        assert_eq!(
            with_edits.fill_params,
            Some(json!({ "values": { "hoten": "Moi" } }))
        );
        assert_eq!(with_edits.flatten_params["removeJavascript"], true);
    }

    #[test]
    fn parse_flatten_summary_reads_flattened_kept_and_skipped_lists() {
        let reply = json!({
            "ok": true,
            "data": {
                "flattened": ["hoten", "dongy"],
                "kept": ["chuky"],
                "withoutAppearance": []
            }
        });
        let summary = parse_flatten_summary(&reply);
        assert_eq!(summary.flattened, vec!["hoten", "dongy"]);
        assert_eq!(summary.kept, vec!["chuky"]);
        assert!(summary.without_appearance.is_empty());
    }

    #[test]
    fn default_flatten_params_matches_ops_schema() {
        let schema: Value =
            serde_json::from_str(include_str!("../../chef-contracts/schema/ops.schema.json"))
                .expect("ops.schema.json must parse");
        let def = &schema["definitions"]["FormsFlattenParams"];
        let properties = def["properties"]
            .as_object()
            .expect("FormsFlattenParams.properties");
        let params = default_flatten_params().unwrap();
        let obj = params.as_object().expect("flatten params must be object");
        for key in obj.keys() {
            assert!(
                properties.contains_key(key),
                "unknown property '{key}' not in FormsFlattenParams"
            );
        }
    }
}
