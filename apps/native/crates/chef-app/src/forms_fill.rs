//! Pure-Rust form-fill state, page-reading-order Tab navigation, and RPC wire helpers (R4.22).

use std::cmp::Ordering;
use std::collections::{BTreeMap, HashMap, HashSet};

use chef_pdf::form_fill::{FormWidget, WidgetKind};
use serde_json::{Map, Value, json};

/// Vertical tolerance (points) for grouping form widgets into the same visual row.
pub const ROW_TOLERANCE_PT: f32 = 6.0;
const MAX_FIELD_NAME_LEN: usize = 120;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FormFieldKind {
    Text,
    Multiline,
    Comb,
    Password,
    Checkbox,
    Radio,
    Dropdown,
    Listbox,
    Button,
    Signature,
    Unknown,
}

impl FormFieldKind {
    pub fn from_wire(raw: &str) -> Self {
        match raw {
            "text" => Self::Text,
            "multiline" => Self::Multiline,
            "comb" => Self::Comb,
            "password" => Self::Password,
            "checkbox" => Self::Checkbox,
            "radio" => Self::Radio,
            "dropdown" => Self::Dropdown,
            "listbox" => Self::Listbox,
            "button" => Self::Button,
            "signature" => Self::Signature,
            _ => Self::Unknown,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Multiline => "multiline",
            Self::Comb => "comb",
            Self::Password => "password",
            Self::Checkbox => "checkbox",
            Self::Radio => "radio",
            Self::Dropdown => "dropdown",
            Self::Listbox => "listbox",
            Self::Button => "button",
            Self::Signature => "signature",
            Self::Unknown => "unknown",
        }
    }

    pub fn is_editable(self) -> bool {
        matches!(
            self,
            Self::Text
                | Self::Multiline
                | Self::Comb
                | Self::Password
                | Self::Checkbox
                | Self::Radio
                | Self::Dropdown
                | Self::Listbox
        )
    }

    pub fn is_text_like(self) -> bool {
        matches!(
            self,
            Self::Text | Self::Multiline | Self::Comb | Self::Password
        )
    }

    pub fn i18n_key(self) -> &'static str {
        match self {
            Self::Text | Self::Password | Self::Unknown => "forms.kind.text",
            Self::Multiline => "forms.kind.multiline",
            Self::Comb => "forms.kind.comb",
            Self::Checkbox => "forms.kind.checkbox",
            Self::Radio => "forms.kind.radio",
            Self::Dropdown => "forms.kind.dropdown",
            Self::Listbox => "forms.kind.listbox",
            Self::Button => "forms.buttonField",
            Self::Signature => "forms.kind.signature",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FieldValue {
    Bool(bool),
    Text(String),
    List(Vec<String>),
}

impl FieldValue {
    pub fn from_wire(kind: FormFieldKind, multi_select: bool, raw: &Value) -> Self {
        match kind {
            FormFieldKind::Checkbox => Self::Bool(raw.as_bool().unwrap_or(false)),
            FormFieldKind::Listbox if multi_select => {
                let items = if let Some(arr) = raw.as_array() {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                } else if let Some(s) = raw.as_str().filter(|s| !s.is_empty()) {
                    vec![s.to_string()]
                } else {
                    Vec::new()
                };
                Self::List(items)
            }
            FormFieldKind::Listbox => {
                let text = if let Some(s) = raw.as_str() {
                    s.to_string()
                } else if let Some(arr) = raw.as_array() {
                    arr.iter()
                        .find_map(Value::as_str)
                        .unwrap_or_default()
                        .to_string()
                } else {
                    String::new()
                };
                Self::Text(text)
            }
            _ => Self::Text(raw.as_str().unwrap_or_default().to_string()),
        }
    }

    pub fn to_wire(&self) -> Value {
        match self {
            Self::Bool(b) => Value::Bool(*b),
            Self::Text(s) => Value::String(s.clone()),
            Self::List(items) => Value::Array(
                items
                    .iter()
                    .map(|item| Value::String(item.clone()))
                    .collect(),
            ),
        }
    }

    pub fn as_bool(&self) -> bool {
        matches!(self, Self::Bool(true))
    }

    pub fn as_text(&self) -> &str {
        match self {
            Self::Text(s) => s.as_str(),
            _ => "",
        }
    }

    pub fn selected_list(&self) -> Vec<String> {
        match self {
            Self::List(items) => items.clone(),
            Self::Text(s) if !s.is_empty() => vec![s.clone()],
            _ => Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FormFieldOption {
    pub export: String,
    pub display: String,
}

impl FormFieldOption {
    pub fn label(&self) -> &str {
        if self.display.is_empty() {
            &self.export
        } else {
            &self.display
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct FormWidgetRef {
    pub page: Option<usize>,
    pub rect: Option<[f32; 4]>,
    pub has_appearance: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FormField {
    pub name: String,
    pub partial_name: String,
    pub kind: FormFieldKind,
    pub page: Option<usize>,
    pub widgets: Vec<FormWidgetRef>,
    pub value: FieldValue,
    pub options: Vec<FormFieldOption>,
    pub tooltip: Option<String>,
    pub read_only: bool,
    pub required: bool,
    pub max_len: Option<usize>,
    pub multi_select: bool,
    pub combo: bool,
}

impl FormField {
    pub fn can_edit(&self) -> bool {
        !self.read_only && self.kind.is_editable()
    }

    pub fn display_label(&self) -> String {
        if let Some(tip) = self.tooltip.as_deref().map(str::trim)
            && !tip.is_empty()
        {
            return tip.to_string();
        }
        if !self.partial_name.trim().is_empty() {
            return self.partial_name.clone();
        }
        self.name.clone()
    }

    /// Primary top-down display position `(page, top, left)` for page reading order.
    pub fn primary_position(&self) -> (usize, f32, f32) {
        let mut best: Option<(usize, f32, f32)> = None;
        for w in &self.widgets {
            let Some(page) = w.page else {
                continue;
            };
            let Some(rect) = w.rect else {
                continue;
            };
            if !rect.iter().all(|v| v.is_finite()) {
                continue;
            }
            let pos = (page, rect[1].min(rect[3]), rect[0].min(rect[2]));
            let replace = match best {
                None => true,
                Some(cur) => cmp_reading_raw(pos, cur) == Ordering::Less,
            };
            if replace {
                best = Some(pos);
            }
        }
        best.unwrap_or((self.page.unwrap_or(usize::MAX), f32::MAX, f32::MAX))
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct FormDocData {
    pub fields: Vec<FormField>,
    pub xfa: bool,
    pub need_appearances: bool,
    pub has_form: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FormDraft {
    pub doc: FormDocData,
    pub values: BTreeMap<String, FieldValue>,
    pub control_ids: BTreeMap<String, String>,
}

impl FormDraft {
    pub fn new(mut doc: FormDocData) -> Self {
        sort_fields_page_order(&mut doc.fields);
        let mut values = BTreeMap::new();
        let mut control_ids = BTreeMap::new();
        let mut used_ids = HashSet::new();
        for (index, field) in doc.fields.iter().enumerate() {
            values.insert(field.name.clone(), field.value.clone());
            let base = control_id_base(&field.name);
            let mut candidate = base.clone();
            if !used_ids.insert(candidate.clone()) {
                candidate = format!("{base}-{index}");
                used_ids.insert(candidate.clone());
            }
            control_ids.insert(field.name.clone(), candidate);
        }
        Self {
            doc,
            values,
            control_ids,
        }
    }

    pub fn field(&self, name: &str) -> Option<&FormField> {
        self.doc.fields.iter().find(|f| f.name == name)
    }

    pub fn value_of(&self, name: &str) -> Option<&FieldValue> {
        self.values.get(name)
    }

    pub fn changed_count(&self) -> usize {
        self.doc
            .fields
            .iter()
            .filter(|f| f.can_edit())
            .filter(|f| self.values.get(&f.name).is_some_and(|v| v != &f.value))
            .count()
    }

    pub fn set_text(&mut self, name: &str, text: String) -> String {
        let clamped = match self.field(name).and_then(|f| f.max_len) {
            Some(limit) => truncate_chars(&text, limit),
            None => text,
        };
        if let Some(slot) = self.values.get_mut(name) {
            *slot = FieldValue::Text(clamped.clone());
        } else {
            self.values
                .insert(name.to_string(), FieldValue::Text(clamped.clone()));
        }
        clamped
    }

    pub fn set_bool(&mut self, name: &str, checked: bool) {
        self.values
            .insert(name.to_string(), FieldValue::Bool(checked));
    }

    pub fn set_choice(&mut self, name: &str, export: String) {
        self.values
            .insert(name.to_string(), FieldValue::Text(export));
    }

    pub fn toggle_list_option(&mut self, name: &str, export: String) {
        let Some(field) = self.field(name).cloned() else {
            return;
        };
        if !field.multi_select {
            self.set_choice(name, export);
            return;
        }
        let mut selected = self
            .values
            .get(name)
            .map(FieldValue::selected_list)
            .unwrap_or_default();
        if let Some(pos) = selected.iter().position(|item| item == &export) {
            selected.remove(pos);
        } else {
            selected.push(export);
        }
        // Keep selection order deterministic by matching field.options order first.
        let mut ordered = Vec::with_capacity(selected.len());
        for opt in &field.options {
            if selected.iter().any(|s| s == &opt.export) && !ordered.contains(&opt.export) {
                ordered.push(opt.export.clone());
            }
        }
        for extra in selected {
            if !ordered.contains(&extra) {
                ordered.push(extra);
            }
        }
        self.values
            .insert(name.to_string(), FieldValue::List(ordered));
    }

    pub fn fill_params(&self) -> Result<Option<Value>, String> {
        build_fill_params(&self.doc.fields, &self.values)
    }
}

fn control_id_base(field_name: &str) -> String {
    let mut slug = String::with_capacity(field_name.len());
    let mut prev_dash = false;
    for ch in field_name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            slug.push(ch);
            prev_dash = false;
        } else if !prev_dash && !slug.is_empty() {
            slug.push('-');
            prev_dash = true;
        }
    }
    let trimmed = slug.trim_end_matches('-');
    if trimmed.is_empty() {
        "form-field".to_string()
    } else {
        format!("form-field-{trimmed}")
    }
}

fn truncate_chars(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    text.chars().take(max_chars).collect()
}

fn cmp_reading_raw(a: (usize, f32, f32), b: (usize, f32, f32)) -> Ordering {
    a.0.cmp(&b.0)
        .then_with(|| a.1.total_cmp(&b.1))
        .then_with(|| a.2.total_cmp(&b.2))
}

/// Sort elements in strict visual reading order: page ascending, then top-to-bottom visual rows
/// (grouping items within [`ROW_TOLERANCE_PT`] of the row anchor), then left-to-right within row.
fn sort_by_reading_order<T, K>(
    items: &mut [T],
    pos: impl Fn(&T) -> (usize, f32, f32),
    tie: impl Fn(&T) -> K,
) where
    K: Ord,
{
    items.sort_by(|a, b| {
        let pa = pos(a);
        let pb = pos(b);
        cmp_reading_raw(pa, pb).then_with(|| tie(a).cmp(&tie(b)))
    });
    let mut start = 0usize;
    while start < items.len() {
        let (page, row_top, _) = pos(&items[start]);
        let mut end = start + 1;
        while end < items.len() {
            let (p, top, _) = pos(&items[end]);
            if p != page || (top - row_top).abs() > ROW_TOLERANCE_PT {
                break;
            }
            end += 1;
        }
        if end - start > 1 {
            items[start..end].sort_by(|a, b| {
                let pa = pos(a);
                let pb = pos(b);
                pa.2.total_cmp(&pb.2)
                    .then_with(|| pa.1.total_cmp(&pb.1))
                    .then_with(|| tie(a).cmp(&tie(b)))
            });
        }
        start = end;
    }
}

pub fn sort_fields_page_order(fields: &mut [FormField]) {
    sort_by_reading_order(fields, FormField::primary_position, |f| f.name.clone());
}

pub fn is_widget_tab_editable(widget: &FormWidget) -> bool {
    !widget.read_only
        && !matches!(
            widget.kind,
            WidgetKind::PushButton | WidgetKind::Signature | WidgetKind::Unknown
        )
}

pub fn order_editable_widgets(
    widgets_by_page: &HashMap<usize, Vec<FormWidget>>,
) -> Vec<FormWidget> {
    let mut ordered: Vec<FormWidget> = widgets_by_page
        .values()
        .flatten()
        .filter(|w| is_widget_tab_editable(w))
        .cloned()
        .collect();
    sort_by_reading_order(
        &mut ordered,
        |w| {
            (
                w.page_index,
                w.rect.top.min(w.rect.bottom),
                w.rect.left.min(w.rect.right),
            )
        },
        |w| w.annot_index,
    );
    ordered
}

pub fn next_widget_id(
    ordered: &[FormWidget],
    current: Option<&str>,
    forward: bool,
) -> Option<String> {
    let len = ordered.len();
    if len == 0 {
        return None;
    }
    let idx = current.and_then(|id| ordered.iter().position(|w| w.id == id));
    let target = match (idx, forward) {
        (Some(i), true) => (i + 1) % len,
        (Some(i), false) => (i + len - 1) % len,
        (None, true) => 0,
        (None, false) => len - 1,
    };
    Some(ordered[target].id.clone())
}

fn parse_rect4(raw: &Value) -> Option<[f32; 4]> {
    let arr = raw.as_array()?;
    if arr.len() != 4 {
        return None;
    }
    let vals = [
        arr[0].as_f64()? as f32,
        arr[1].as_f64()? as f32,
        arr[2].as_f64()? as f32,
        arr[3].as_f64()? as f32,
    ];
    vals.iter().all(|v| v.is_finite()).then_some(vals)
}

/// Parse `forms.list` + optional `forms.getValues` RPC replies into sorted [`FormDocData`].
pub fn forms_from_replies(
    list_reply: &Value,
    values_reply: Option<&Value>,
) -> Result<FormDocData, String> {
    let root = list_reply.get("data").unwrap_or(list_reply);
    let fields_raw = root
        .get("fields")
        .and_then(Value::as_array)
        .ok_or_else(|| "Thiếu trường fields từ forms.list".to_string())?;
    let override_values = values_reply
        .map(|reply| reply.get("data").unwrap_or(reply))
        .and_then(|data| data.get("values"))
        .and_then(Value::as_object);

    let mut fields = Vec::with_capacity(fields_raw.len());
    for raw in fields_raw {
        let name = raw
            .get("name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "Trường biểu mẫu thiếu name".to_string())?
            .to_string();
        let partial_name = raw
            .get("partialName")
            .and_then(Value::as_str)
            .unwrap_or(&name)
            .to_string();
        let kind =
            FormFieldKind::from_wire(raw.get("type").and_then(Value::as_str).unwrap_or("unknown"));
        let page = raw
            .get("page")
            .and_then(Value::as_u64)
            .and_then(|p| usize::try_from(p).ok());
        let widgets = raw
            .get("widgets")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .map(|item| FormWidgetRef {
                        page: item
                            .get("page")
                            .and_then(Value::as_u64)
                            .and_then(|p| usize::try_from(p).ok()),
                        rect: item.get("rect").and_then(parse_rect4),
                        has_appearance: item
                            .get("hasAppearance")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let flags = raw.get("flags");
        let read_only = flags
            .and_then(|f| f.get("readOnly"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let required = flags
            .and_then(|f| f.get("required"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let max_len = flags
            .and_then(|f| f.get("maxLen"))
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok());
        let multi_select = flags
            .and_then(|f| f.get("multiSelect"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let combo = flags
            .and_then(|f| f.get("combo"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let options = raw
            .get("options")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        let export = item.get("export").and_then(Value::as_str)?.to_string();
                        let display = item
                            .get("display")
                            .and_then(Value::as_str)
                            .unwrap_or(&export)
                            .to_string();
                        Some(FormFieldOption { export, display })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let tooltip = raw
            .get("tooltip")
            .and_then(Value::as_str)
            .map(str::to_string);
        let raw_value = override_values
            .and_then(|map| map.get(&name))
            .or_else(|| raw.get("value"))
            .unwrap_or(&Value::Null);
        let value = FieldValue::from_wire(kind, multi_select, raw_value);
        fields.push(FormField {
            name,
            partial_name,
            kind,
            page,
            widgets,
            value,
            options,
            tooltip,
            read_only,
            required,
            max_len,
            multi_select,
            combo,
        });
    }
    sort_fields_page_order(&mut fields);
    Ok(FormDocData {
        fields,
        xfa: root.get("xfa").and_then(Value::as_bool).unwrap_or(false),
        need_appearances: root
            .get("needAppearances")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        has_form: root
            .get("hasForm")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn validate_field_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > MAX_FIELD_NAME_LEN {
        return Err(format!("Tên trường biểu mẫu không hợp lệ: {name}"));
    }
    Ok(())
}

/// Build `forms.fill` params containing only changed editable fields. Returns `Ok(None)` when
/// nothing changed so callers do not invoke `forms.fill` with an empty map.
pub fn build_fill_params(
    fields: &[FormField],
    draft: &BTreeMap<String, FieldValue>,
) -> Result<Option<Value>, String> {
    let mut values = Map::new();
    for field in fields {
        if !field.can_edit() {
            continue;
        }
        let Some(candidate) = draft.get(&field.name) else {
            continue;
        };
        let normalized = match (field.kind, candidate) {
            (kind, FieldValue::Text(text)) if kind.is_text_like() => match field.max_len {
                Some(limit) => FieldValue::Text(truncate_chars(text, limit)),
                None => candidate.clone(),
            },
            _ => candidate.clone(),
        };
        if normalized == field.value {
            continue;
        }
        validate_field_name(&field.name)?;
        values.insert(field.name.clone(), normalized.to_wire());
    }
    if values.is_empty() {
        return Ok(None);
    }
    Ok(Some(json!({ "values": values })))
}

pub fn single_field_fill_params(field_name: &str, value: &FieldValue) -> Result<Value, String> {
    validate_field_name(field_name)?;
    let mut values = Map::new();
    values.insert(field_name.to_string(), value.to_wire());
    Ok(json!({ "values": values }))
}

/// Helper for dropdown UI index (`0` = empty/unselected "Choose...", `1..` = `options`).
pub fn dropdown_selected_index(field: &FormField, value: Option<&FieldValue>) -> usize {
    let current = value.map(FieldValue::as_text).unwrap_or("");
    if current.is_empty() {
        return 0;
    }
    field
        .options
        .iter()
        .position(|opt| opt.export == current)
        .map_or(0, |idx| idx + 1)
}

pub fn dropdown_value_for_index(field: &FormField, selected_index: usize) -> String {
    if selected_index == 0 {
        return String::new();
    }
    field
        .options
        .get(selected_index - 1)
        .map(|opt| opt.export.clone())
        .unwrap_or_default()
}

pub fn radio_selected_index(field: &FormField, value: Option<&FieldValue>) -> Option<usize> {
    let current = value.map(FieldValue::as_text).unwrap_or("");
    if current.is_empty() {
        return None;
    }
    field.options.iter().position(|opt| opt.export == current)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chef_contracts::ops_types::FormsFillParams;
    use chef_pdf::text::Rect;

    fn sample_list_reply() -> Value {
        json!({
            "data": {
                "xfa": false,
                "needAppearances": false,
                "hasForm": true,
                "fields": [
                    {
                        "name": "p2_right",
                        "partialName": "p2_right",
                        "type": "text",
                        "page": 1,
                        "widgets": [{ "page": 1, "rect": [180.0, 42.0, 280.0, 62.0], "hasAppearance": true }],
                        "value": null,
                        "options": [],
                        "tooltip": null,
                        "flags": { "readOnly": false, "required": false, "maxLen": null }
                    },
                    {
                        "name": "tinh",
                        "partialName": "tinh",
                        "type": "dropdown",
                        "page": 0,
                        "widgets": [{ "page": 0, "rect": [20.0, 220.0, 140.0, 240.0], "hasAppearance": true }],
                        "value": null,
                        "options": [
                            { "export": "HN", "display": "Ha Noi" },
                            { "export": "HCM", "display": "HCM" }
                        ],
                        "tooltip": null,
                        "flags": { "readOnly": false, "required": false, "maxLen": null }
                    },
                    {
                        "name": "p2_left",
                        "partialName": "p2_left",
                        "type": "text",
                        "page": 1,
                        "widgets": [{ "page": 1, "rect": [20.0, 40.0, 120.0, 60.0], "hasAppearance": true }],
                        "value": null,
                        "options": [],
                        "tooltip": null,
                        "flags": { "readOnly": false, "required": false, "maxLen": null }
                    },
                    {
                        "name": "hoten",
                        "partialName": "hoten",
                        "type": "text",
                        "page": 0,
                        "widgets": [{ "page": 0, "rect": [20.0, 20.0, 180.0, 40.0], "hasAppearance": true }],
                        "value": "",
                        "options": [],
                        "tooltip": "Họ và tên",
                        "flags": { "readOnly": false, "required": true, "maxLen": 12 }
                    },
                    {
                        "name": "dongy",
                        "partialName": "dongy",
                        "type": "checkbox",
                        "page": 0,
                        "widgets": [{ "page": 0, "rect": [195.0, 22.0, 209.0, 36.0], "hasAppearance": true }],
                        "value": true,
                        "options": [{ "export": "Yes", "display": "Yes" }],
                        "tooltip": null,
                        "flags": { "readOnly": false, "required": false, "maxLen": null }
                    },
                    {
                        "name": "ma",
                        "partialName": "ma",
                        "type": "text",
                        "page": 0,
                        "widgets": [{ "page": 0, "rect": [20.0, 250.0, 140.0, 270.0], "hasAppearance": true }],
                        "value": "MA-01",
                        "options": [],
                        "tooltip": null,
                        "flags": { "readOnly": true, "required": false, "maxLen": null }
                    },
                    {
                        "name": "chuky",
                        "partialName": "chuky",
                        "type": "signature",
                        "page": 0,
                        "widgets": [{ "page": 0, "rect": [160.0, 278.0, 280.0, 296.0], "hasAppearance": false }],
                        "value": null,
                        "options": [],
                        "tooltip": null,
                        "flags": { "readOnly": false, "required": false, "maxLen": null }
                    }
                ]
            }
        })
    }

    #[test]
    fn parses_forms_list_and_sorts_in_page_reading_order() {
        let values = json!({
            "data": {
                "values": {
                    "hoten": "An",
                    "dongy": true,
                    "ma": "MA-01"
                }
            }
        });
        let doc = forms_from_replies(&sample_list_reply(), Some(&values)).unwrap();
        let names: Vec<&str> = doc.fields.iter().map(|f| f.name.as_str()).collect();
        // Row 0 on page 0 has hoten (y=20, x=20) and dongy (y=22, x=195 within 6pt),
        // followed by tinh (y=220), ma (y=250), chuky (y=278), then page 1 p2_left & p2_right.
        assert_eq!(
            names,
            vec![
                "hoten", "dongy", "tinh", "ma", "chuky", "p2_left", "p2_right"
            ]
        );
        assert_eq!(doc.fields[0].value, FieldValue::Text("An".into()));
        assert_eq!(doc.fields[1].value, FieldValue::Bool(true));
        assert!(doc.fields[0].can_edit());
        assert!(!doc.fields[3].can_edit());
        assert!(!doc.fields[4].can_edit());
    }

    #[test]
    fn builds_diff_only_fill_params_matching_contract() {
        let doc = forms_from_replies(&sample_list_reply(), None).unwrap();
        let mut draft = FormDraft::new(doc);
        assert_eq!(draft.changed_count(), 0);
        assert_eq!(draft.fill_params().unwrap(), None);

        // Enforce Unicode character truncation at max_len=12 and ignore read-only edits.
        let clamped = draft.set_text("hoten", "Nguyễn Văn Toàn Thắng".into());
        assert_eq!(clamped.chars().count(), 12);
        draft.set_bool("dongy", false);
        draft.set_choice("tinh", "HCM".into());
        draft.set_text("ma", "FORBIDDEN".into());
        assert_eq!(draft.changed_count(), 3);

        let params = draft.fill_params().unwrap().expect("diff params");
        let parsed: FormsFillParams =
            serde_json::from_value(params).expect("matches FormsFillParams schema");
        assert_eq!(parsed.values.len(), 3);
        let keys: Vec<&str> = parsed.values.keys().map(|k| k.as_str()).collect();
        assert!(!keys.contains(&"ma"));
        assert!(!keys.contains(&"chuky"));
        assert!(!keys.contains(&"p2_left"));
        assert_eq!(
            draft
                .field("hoten")
                .map(FormField::display_label)
                .as_deref(),
            Some("Họ và tên")
        );
    }

    #[test]
    fn tab_navigation_orders_editable_widgets_across_pages_and_wraps() {
        let widget =
            |id: &str, page: usize, annot: usize, x: f32, y: f32, kind, read_only| FormWidget {
                id: id.into(),
                page_index: page,
                annot_index: annot,
                name: id.into(),
                alternate_name: None,
                kind,
                rect: Rect {
                    left: x,
                    top: y,
                    right: x + 60.0,
                    bottom: y + 18.0,
                },
                value: None,
                checked: None,
                control_index: None,
                options: Vec::new(),
                read_only,
                required: false,
                has_appearance: true,
            };
        let mut by_page = HashMap::new();
        by_page.insert(
            1,
            vec![
                widget("p1_r", 1, 0, 200.0, 44.0, WidgetKind::Text, false),
                widget("p1_l", 1, 1, 20.0, 40.0, WidgetKind::Text, false),
            ],
        );
        by_page.insert(
            0,
            vec![
                widget("p0_sig", 0, 0, 20.0, 10.0, WidgetKind::Signature, false),
                widget("p0_ro", 0, 1, 20.0, 30.0, WidgetKind::Text, true),
                widget("p0_btn", 0, 2, 20.0, 50.0, WidgetKind::PushButton, false),
                widget("p0_b", 0, 3, 180.0, 82.0, WidgetKind::Checkbox, false),
                widget("p0_a", 0, 4, 20.0, 80.0, WidgetKind::Text, false),
            ],
        );
        let ordered = order_editable_widgets(&by_page);
        let ids: Vec<&str> = ordered.iter().map(|w| w.id.as_str()).collect();
        assert_eq!(ids, vec!["p0_a", "p0_b", "p1_l", "p1_r"]);

        assert_eq!(
            next_widget_id(&ordered, None, true).as_deref(),
            Some("p0_a")
        );
        assert_eq!(
            next_widget_id(&ordered, Some("p0_a"), true).as_deref(),
            Some("p0_b")
        );
        assert_eq!(
            next_widget_id(&ordered, Some("p1_r"), true).as_deref(),
            Some("p0_a")
        );
        assert_eq!(
            next_widget_id(&ordered, None, false).as_deref(),
            Some("p1_r")
        );
        assert_eq!(
            next_widget_id(&ordered, Some("p0_a"), false).as_deref(),
            Some("p1_r")
        );
    }

    #[test]
    fn option_selection_and_dropdown_index_roundtrip() {
        let reply = json!({
            "data": {
                "xfa": false,
                "needAppearances": false,
                "hasForm": true,
                "fields": [
                    {
                        "name": "tinh",
                        "partialName": "tinh",
                        "type": "dropdown",
                        "page": 0,
                        "widgets": [{ "page": 0, "rect": [20.0, 20.0, 120.0, 40.0], "hasAppearance": true }],
                        "value": "HN",
                        "options": [
                            { "export": "HN", "display": "Ha Noi" },
                            { "export": "HCM", "display": "TP. Ho Chi Minh" }
                        ],
                        "tooltip": null,
                        "flags": { "readOnly": false, "required": false, "maxLen": null }
                    },
                    {
                        "name": "gioitinh",
                        "partialName": "gioitinh",
                        "type": "radio",
                        "page": 0,
                        "widgets": [{ "page": 0, "rect": [20.0, 60.0, 80.0, 74.0], "hasAppearance": true }],
                        "value": null,
                        "options": [
                            { "export": "nam", "display": "nam" },
                            { "export": "nu", "display": "nu" }
                        ],
                        "tooltip": null,
                        "flags": { "readOnly": false, "required": false, "maxLen": null }
                    },
                    {
                        "name": "ngonngu",
                        "partialName": "ngonngu",
                        "type": "listbox",
                        "page": 0,
                        "widgets": [{ "page": 0, "rect": [20.0, 90.0, 120.0, 150.0], "hasAppearance": true }],
                        "value": ["Vi"],
                        "options": [
                            { "export": "Vi", "display": "Vi" },
                            { "export": "En", "display": "En" },
                            { "export": "Fr", "display": "Fr" }
                        ],
                        "tooltip": null,
                        "flags": { "readOnly": false, "required": false, "multiSelect": true }
                    }
                ]
            }
        });
        let doc = forms_from_replies(&reply, None).unwrap();
        let mut draft = FormDraft::new(doc);

        let tinh = draft.field("tinh").unwrap().clone();
        assert_eq!(dropdown_selected_index(&tinh, draft.value_of("tinh")), 1);
        assert_eq!(dropdown_value_for_index(&tinh, 2), "HCM");
        assert_eq!(dropdown_value_for_index(&tinh, 0), "");

        let radio = draft.field("gioitinh").unwrap().clone();
        assert_eq!(
            radio_selected_index(&radio, draft.value_of("gioitinh")),
            None
        );
        draft.set_choice("gioitinh", "nu".into());
        assert_eq!(
            radio_selected_index(&radio, draft.value_of("gioitinh")),
            Some(1)
        );

        draft.toggle_list_option("ngonngu", "Fr".into());
        assert_eq!(
            draft.value_of("ngonngu"),
            Some(&FieldValue::List(vec!["Vi".into(), "Fr".into()]))
        );
        draft.toggle_list_option("ngonngu", "Vi".into());
        assert_eq!(
            draft.value_of("ngonngu"),
            Some(&FieldValue::List(vec!["Fr".into()]))
        );
    }
}
