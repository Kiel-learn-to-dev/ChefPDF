//! Pure-Rust form field creation draft, validation, and contract-checked RPC builders (R4.23).

use std::collections::HashSet;

use chef_contracts::ops_types::FormsRemoveParams;
use serde_json::{Map, Value, json};

pub const MIN_FIELD_SIZE_PT: f32 = 14.0;
pub const MAX_FIELD_NAME_LEN: usize = 120;
pub const MAX_COMB_LEN: u64 = 100_000;
pub const MAX_EXPORT_VALUE_LEN: usize = 120;
pub const MAX_LABEL_LEN: usize = 300;
pub const MAX_SIGNATURE_LABEL_LEN: usize = 200;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CreateFieldKind {
    Text,
    Multiline,
    Comb,
    Checkbox,
    Radio,
    Dropdown,
    Signature,
}

impl CreateFieldKind {
    pub const ALL: [CreateFieldKind; 7] = [
        Self::Text,
        Self::Multiline,
        Self::Comb,
        Self::Checkbox,
        Self::Radio,
        Self::Dropdown,
        Self::Signature,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Multiline => "multiline",
            Self::Comb => "comb",
            Self::Checkbox => "checkbox",
            Self::Radio => "radio",
            Self::Dropdown => "dropdown",
            Self::Signature => "signature",
        }
    }

    pub fn i18n_key(self) -> &'static str {
        match self {
            Self::Text => "forms.kind.text",
            Self::Multiline => "forms.kind.multiline",
            Self::Comb => "forms.kind.comb",
            Self::Checkbox => "forms.kind.checkbox",
            Self::Radio => "forms.kind.radio",
            Self::Dropdown => "forms.kind.dropdown",
            Self::Signature => "forms.kind.signature",
        }
    }

    pub fn from_index(idx: usize) -> Option<Self> {
        Self::ALL.get(idx).copied()
    }

    pub fn index(self) -> usize {
        Self::ALL.iter().position(|kind| *kind == self).unwrap_or(0)
    }

    pub fn needs_options(self) -> bool {
        matches!(self, Self::Radio | Self::Dropdown)
    }

    pub fn needs_max_len(self) -> bool {
        matches!(self, Self::Comb)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FormDrawDrag {
    pub generation: u64,
    pub page_index: usize,
    pub start: [f32; 2],
    pub cur: [f32; 2],
}

impl FormDrawDrag {
    pub fn rect(&self) -> [f32; 4] {
        [
            self.start[0].min(self.cur[0]),
            self.start[1].min(self.cur[1]),
            self.start[0].max(self.cur[0]),
            self.start[1].max(self.cur[1]),
        ]
    }

    pub fn is_valid_size(&self) -> bool {
        let [x0, top, x1, bottom] = self.rect();
        [x0, top, x1, bottom].iter().all(|v| v.is_finite())
            && (x1 - x0) >= MIN_FIELD_SIZE_PT
            && (bottom - top) >= MIN_FIELD_SIZE_PT
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PendingFormRect {
    pub page_index: usize,
    pub rect: [f32; 4],
}

impl PendingFormRect {
    pub fn placement_rect_text(&self) -> String {
        self.rect
            .iter()
            .map(|value| value.round().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreateFormDraft {
    pub kind: CreateFieldKind,
    pub name: String,
    pub label: String,
    pub options_text: String,
    pub max_len_text: String,
    pub required: bool,
}

impl Default for CreateFormDraft {
    fn default() -> Self {
        Self {
            kind: CreateFieldKind::Text,
            name: String::new(),
            label: String::new(),
            options_text: String::new(),
            max_len_text: String::new(),
            required: false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CreateIssue {
    Name,
    Duplicate,
    Options,
    RadioSize,
    MaxLen,
    Rect,
}

impl CreateIssue {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Name => "name",
            Self::Duplicate => "duplicate",
            Self::Options => "options",
            Self::RadioSize => "radioSize",
            Self::MaxLen => "maxLen",
            Self::Rect => "rect",
        }
    }

    pub fn i18n_key(self) -> &'static str {
        match self {
            Self::Name => "forms.issues.name",
            Self::Duplicate => "forms.issues.duplicate",
            Self::Options => "forms.issues.options",
            Self::RadioSize => "forms.issues.radioSize",
            Self::MaxLen => "forms.issues.maxLen",
            Self::Rect => "forms.issues.rect",
        }
    }
}

fn is_forbidden_name_char(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            '.' | '[' | ']' | '(' | ')' | '{' | '}' | '<' | '>' | '/' | '%'
        )
}

pub fn is_valid_field_name(raw: &str) -> bool {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_FIELD_NAME_LEN {
        return false;
    }
    trimmed
        .split('.')
        .all(|part| !part.is_empty() && !part.chars().any(is_forbidden_name_char))
}

pub fn parse_options(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for raw in text.split(['\n', ',']) {
        let item = raw.trim();
        if !item.is_empty() && seen.insert(item.to_string()) {
            out.push(item.to_string());
        }
    }
    out
}

pub fn validate_create(
    draft: &CreateFormDraft,
    pending: Option<&PendingFormRect>,
    existing_names: &[String],
) -> Option<CreateIssue> {
    let trimmed = draft.name.trim();
    if !is_valid_field_name(trimmed) {
        return Some(CreateIssue::Name);
    }
    if existing_names.iter().any(|name| name == trimmed) {
        return Some(CreateIssue::Duplicate);
    }
    let Some(pending) = pending else {
        return Some(CreateIssue::Rect);
    };
    let [x0, top, x1, bottom] = pending.rect;
    let width = x1 - x0;
    let height = bottom - top;
    if !pending.rect.iter().all(|v| v.is_finite())
        || width < MIN_FIELD_SIZE_PT
        || height < MIN_FIELD_SIZE_PT
    {
        return Some(CreateIssue::Rect);
    }
    if draft.kind.needs_options() {
        let options = parse_options(&draft.options_text);
        if options.len() < 2 {
            return Some(CreateIssue::Options);
        }
        if draft.kind == CreateFieldKind::Radio {
            if options
                .iter()
                .any(|opt| opt.chars().count() > MAX_EXPORT_VALUE_LEN)
            {
                return Some(CreateIssue::Options);
            }
            if (width / options.len() as f32) < MIN_FIELD_SIZE_PT {
                return Some(CreateIssue::RadioSize);
            }
        }
    }
    if draft.kind.needs_max_len() {
        let parsed = draft.max_len_text.trim().parse::<u64>();
        if !matches!(parsed, Ok(n) if (1..=MAX_COMB_LEN).contains(&n)) {
            return Some(CreateIssue::MaxLen);
        }
    }
    None
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    text.chars().take(max_chars).collect()
}

/// Builds `forms.addField` wire payloads conforming to `FormsAddFieldParams` in
/// `schema/ops.schema.json`.
///
/// Note: `chef_contracts::ops_types::FormsAddFieldParams` is bypassed at deserialize time
/// because `typify` collapses colliding `"title": "Kind"` enums in `ops_types.rs` onto
/// the shape-drawing `Kind` enum; exact wire conformance is enforced in tests against the
/// schema itself.
pub fn build_add_field_params(
    draft: &CreateFormDraft,
    pending: &PendingFormRect,
    existing_names: &[String],
) -> Result<Vec<Value>, CreateIssue> {
    if let Some(issue) = validate_create(draft, Some(pending), existing_names) {
        return Err(issue);
    }

    let name = draft.name.trim().to_string();
    let max_label_len = if draft.kind == CreateFieldKind::Signature {
        MAX_SIGNATURE_LABEL_LEN
    } else {
        MAX_LABEL_LEN
    };
    let label = truncate_chars(draft.label.trim(), max_label_len);
    let [x0, top, x1, bottom] = pending.rect.map(f64::from);

    let make_base = |rect: [f64; 4]| {
        let mut obj = Map::new();
        obj.insert("kind".into(), Value::String(draft.kind.as_str().into()));
        obj.insert("pageIndex".into(), json!(pending.page_index));
        obj.insert("rect".into(), json!(rect));
        obj.insert("name".into(), Value::String(name.clone()));
        if !label.is_empty() {
            obj.insert("label".into(), Value::String(label.clone()));
        }
        obj.insert("required".into(), Value::Bool(draft.required));
        obj
    };

    match draft.kind {
        CreateFieldKind::Radio => {
            let options = parse_options(&draft.options_text);
            let slot = (x1 - x0) / options.len() as f64;
            let mut list = Vec::with_capacity(options.len());
            for (index, option) in options.into_iter().enumerate() {
                let rx0 = x0 + slot * index as f64;
                let rx1 = x0 + slot * (index as f64 + 1.0);
                let mut obj = make_base([rx0, top, rx1, bottom]);
                obj.insert("exportValue".into(), Value::String(option));
                list.push(Value::Object(obj));
            }
            Ok(list)
        }
        CreateFieldKind::Dropdown => {
            let options = parse_options(&draft.options_text);
            let mut obj = make_base([x0, top, x1, bottom]);
            obj.insert("options".into(), json!(options));
            Ok(vec![Value::Object(obj)])
        }
        CreateFieldKind::Comb => {
            let max_len = draft
                .max_len_text
                .trim()
                .parse::<u64>()
                .map_err(|_| CreateIssue::MaxLen)?;
            let mut obj = make_base([x0, top, x1, bottom]);
            obj.insert("maxLen".into(), json!(max_len));
            Ok(vec![Value::Object(obj)])
        }
        CreateFieldKind::Text
        | CreateFieldKind::Multiline
        | CreateFieldKind::Checkbox
        | CreateFieldKind::Signature => Ok(vec![Value::Object(make_base([x0, top, x1, bottom]))]),
    }
}

pub fn build_remove_field_params(name: &str) -> Result<Value, String> {
    let raw = json!({ "names": [name] });
    let typed: FormsRemoveParams = serde_json::from_value(raw)
        .map_err(|e| format!("tham số forms.remove không hợp lệ: {e}"))?;
    serde_json::to_value(&typed).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_pending() -> PendingFormRect {
        PendingFormRect {
            page_index: 0,
            rect: [40.0, 80.0, 220.0, 110.0],
        }
    }

    fn assert_matches_ops_schema(params: &Value) {
        let schema: Value =
            serde_json::from_str(include_str!("../../chef-contracts/schema/ops.schema.json"))
                .expect("ops.schema.json must parse");
        let def = &schema["definitions"]["FormsAddFieldParams"];
        let properties = def["properties"]
            .as_object()
            .expect("FormsAddFieldParams.properties");
        let required = def["required"]
            .as_array()
            .expect("FormsAddFieldParams.required");
        let obj = params.as_object().expect("payload must be JSON object");

        for req in required {
            let key = req.as_str().unwrap();
            assert!(
                obj.contains_key(key),
                "missing required schema property '{key}' in {params}"
            );
        }
        if def["additionalProperties"] == Value::Bool(false) {
            for key in obj.keys() {
                assert!(
                    properties.contains_key(key),
                    "unknown property '{key}' not in FormsAddFieldParams: {params}"
                );
            }
        }
        let kind_enum = properties["kind"]["enum"]
            .as_array()
            .expect("FormsAddFieldParams.kind.enum");
        assert!(
            kind_enum.contains(&obj["kind"]),
            "kind {} not in schema enum {kind_enum:?}",
            obj["kind"]
        );
    }

    #[test]
    fn validates_field_names_and_rejects_duplicates() {
        assert!(is_valid_field_name("hoten"));
        assert!(is_valid_field_name("cty.diachi.phuong_1"));
        assert!(!is_valid_field_name(""));
        assert!(!is_valid_field_name("   "));
        assert!(!is_valid_field_name("bad name"));
        assert!(!is_valid_field_name("bad.part[0]"));
        assert!(!is_valid_field_name(".leading"));
        assert!(!is_valid_field_name("trailing."));
        assert!(!is_valid_field_name(&"a".repeat(MAX_FIELD_NAME_LEN + 1)));

        let draft = CreateFormDraft {
            name: "hoten".into(),
            ..Default::default()
        };
        let issue = validate_create(&draft, Some(&sample_pending()), &[String::from("hoten")]);
        assert_eq!(issue, Some(CreateIssue::Duplicate));
    }

    #[test]
    fn parses_and_deduplicates_options_from_commas_and_newlines() {
        let parsed = parse_options(" Ha Noi, HCM\nDa Nang, HCM \n\n , Can Tho ");
        assert_eq!(parsed, vec!["Ha Noi", "HCM", "Da Nang", "Can Tho"]);
    }

    #[test]
    fn builds_contract_valid_params_for_all_non_radio_kinds() {
        let pending = sample_pending();
        let existing = vec![String::from("taken")];

        let text = build_add_field_params(
            &CreateFormDraft {
                kind: CreateFieldKind::Text,
                name: "hoten".into(),
                label: "Họ và tên".into(),
                required: true,
                ..Default::default()
            },
            &pending,
            &existing,
        )
        .unwrap();
        assert_eq!(text.len(), 1);
        assert_matches_ops_schema(&text[0]);
        assert_eq!(text[0]["kind"], "text");
        assert_eq!(text[0]["label"], "Họ và tên");
        assert_eq!(text[0]["required"], true);

        let multiline = build_add_field_params(
            &CreateFormDraft {
                kind: CreateFieldKind::Multiline,
                name: "ghichu".into(),
                ..Default::default()
            },
            &pending,
            &existing,
        )
        .unwrap();
        assert_matches_ops_schema(&multiline[0]);
        assert_eq!(multiline[0]["kind"], "multiline");

        let comb = build_add_field_params(
            &CreateFormDraft {
                kind: CreateFieldKind::Comb,
                name: "cmnd".into(),
                max_len_text: "9".into(),
                ..Default::default()
            },
            &pending,
            &existing,
        )
        .unwrap();
        assert_matches_ops_schema(&comb[0]);
        assert_eq!(comb[0]["kind"], "comb");
        assert_eq!(comb[0]["maxLen"], 9);

        let checkbox = build_add_field_params(
            &CreateFormDraft {
                kind: CreateFieldKind::Checkbox,
                name: "dongy".into(),
                ..Default::default()
            },
            &pending,
            &existing,
        )
        .unwrap();
        assert_matches_ops_schema(&checkbox[0]);
        assert_eq!(checkbox[0]["kind"], "checkbox");

        let dropdown = build_add_field_params(
            &CreateFormDraft {
                kind: CreateFieldKind::Dropdown,
                name: "tinh".into(),
                options_text: "Ha Noi, HCM".into(),
                ..Default::default()
            },
            &pending,
            &existing,
        )
        .unwrap();
        assert_matches_ops_schema(&dropdown[0]);
        assert_eq!(dropdown[0]["kind"], "dropdown");
        assert_eq!(dropdown[0]["options"], json!(["Ha Noi", "HCM"]));

        let signature = build_add_field_params(
            &CreateFormDraft {
                kind: CreateFieldKind::Signature,
                name: "chuky".into(),
                label: "Giám đốc".into(),
                ..Default::default()
            },
            &pending,
            &existing,
        )
        .unwrap();
        assert_matches_ops_schema(&signature[0]);
        assert_eq!(signature[0]["kind"], "signature");
        assert_eq!(signature[0]["label"], "Giám đốc");
    }

    #[test]
    fn splits_radio_rect_evenly_and_enforces_min_slot_width() {
        let narrow = PendingFormRect {
            page_index: 0,
            rect: [10.0, 20.0, 30.0, 40.0],
        };
        let radio_draft = CreateFormDraft {
            kind: CreateFieldKind::Radio,
            name: "gioitinh".into(),
            options_text: "nam, nu".into(),
            ..Default::default()
        };
        assert_eq!(
            build_add_field_params(&radio_draft, &narrow, &[]),
            Err(CreateIssue::RadioSize)
        );

        let wide = PendingFormRect {
            page_index: 1,
            rect: [20.0, 50.0, 120.0, 74.0],
        };
        let list = build_add_field_params(&radio_draft, &wide, &[]).unwrap();
        assert_eq!(list.len(), 2);
        for item in &list {
            assert_matches_ops_schema(item);
        }
        assert_eq!(list[0]["kind"], "radio");
        assert_eq!(list[0]["pageIndex"], 1);
        assert_eq!(list[0]["exportValue"], "nam");
        assert_eq!(list[0]["rect"], json!([20.0, 50.0, 70.0, 74.0]));
        assert_eq!(list[1]["exportValue"], "nu");
        assert_eq!(list[1]["rect"], json!([70.0, 50.0, 120.0, 74.0]));
    }

    #[test]
    fn rejects_invalid_rect_options_and_comb_max_len() {
        let small = PendingFormRect {
            page_index: 0,
            rect: [10.0, 10.0, 20.0, 30.0],
        };
        assert_eq!(
            validate_create(
                &CreateFormDraft {
                    name: "a".into(),
                    ..Default::default()
                },
                Some(&small),
                &[]
            ),
            Some(CreateIssue::Rect)
        );

        let pending = sample_pending();
        assert_eq!(
            validate_create(
                &CreateFormDraft {
                    kind: CreateFieldKind::Dropdown,
                    name: "tinh".into(),
                    options_text: "OnlyOne".into(),
                    ..Default::default()
                },
                Some(&pending),
                &[]
            ),
            Some(CreateIssue::Options)
        );

        assert_eq!(
            validate_create(
                &CreateFormDraft {
                    kind: CreateFieldKind::Radio,
                    name: "gioitinh".into(),
                    options_text: format!("ok, {}", "x".repeat(MAX_EXPORT_VALUE_LEN + 1)),
                    ..Default::default()
                },
                Some(&pending),
                &[]
            ),
            Some(CreateIssue::Options)
        );

        assert_eq!(
            validate_create(
                &CreateFormDraft {
                    kind: CreateFieldKind::Comb,
                    name: "cmnd".into(),
                    max_len_text: "0".into(),
                    ..Default::default()
                },
                Some(&pending),
                &[]
            ),
            Some(CreateIssue::MaxLen)
        );
    }

    #[test]
    fn builds_valid_remove_params_for_rollback() {
        let params = build_remove_field_params("gioitinh").unwrap();
        assert_eq!(params, json!({ "names": ["gioitinh"] }));
    }
}
