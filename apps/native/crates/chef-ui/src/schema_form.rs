//! Hộp thoại sinh từ JSON Schema (TASKS_RUST R5.02, BLUEPRINT_RUST §6).
//!
//! Hai lớp:
//! - Mô hình thuần ([`FormSchema`], [`FieldInput`], [`FormSchema::build`]): đọc định nghĩa `*Params`
//!   trong `ops.schema.json`, quyết định kiểu từng trường, kiểm tra giá trị người dùng nhập và dựng
//!   JSON `params` cho `ops.run`. Không phụ thuộc giao diện nên kiểm thử đơn vị được.
//! - Giao diện ([`SchemaForm`]): entity GPUI vẽ form bằng `TextField`, `Switch`, `RadioGroup`,
//!   `Select` có sẵn. Phần viết tay (xem trước, danh sách kéo thả) nằm ngoài, bên gọi đặt vào
//!   `TaskDialog`; form chỉ nhận danh sách file qua [`SchemaForm::set_files`].
//!
//! Nhãn và mô tả lấy từ `vi.json`/`en.json` theo khóa `schemaForm.fields.<Params>.<trường>` rồi
//! `schemaForm.fields.<trường>`; thiếu thì dùng `title` của schema (đã đổi camelCase thành chữ
//! thường có cách). Nhờ vậy thêm một operation mới không cần viết giao diện.

use std::collections::BTreeMap;

use chef_theme::{dark, light, shared};
use gpui::{
    Context, Entity, EventEmitter, FocusHandle, FontWeight, IntoElement, Render, SharedString,
    Subscription, Window, div, prelude::*, px, rgba,
};
use serde_json::{Map, Number, Value};

use crate::button::pack;
use crate::choice::{RadioGroup, RadioItem};
use crate::form::{Switch, TextField};
use crate::i18n;
use crate::select::Select;
use crate::task_dialog::display_basename;
use crate::text_input::{TextInput, TextInputEvent};

/// Quá số này thì dùng ô chọn thả xuống thay vì nhóm nút radio.
const RADIO_MAX_OPTIONS: usize = 4;
/// Số trang tối đa một khoảng trang được mở rộng ra (chặn "1-999999999").
const PAGE_RANGE_MAX: i64 = 100_000;

// ---------------------------------------------------------------------------
// Mô hình
// ---------------------------------------------------------------------------

/// Kiểu điều khiển của một trường.
#[derive(Clone, Debug, PartialEq)]
pub enum FieldKind {
    Text {
        min_len: usize,
        max_len: Option<usize>,
    },
    Integer {
        min: Option<i64>,
        max: Option<i64>,
    },
    Number {
        min: Option<f64>,
        max: Option<f64>,
    },
    Bool,
    /// `enum` của schema; giá trị giữ nguyên kiểu JSON.
    Choice(Vec<Value>),
    /// Danh sách số trang. Người dùng nhập theo số trang từ 1 ("1-3, 5"); `zero_based` cho biết
    /// lõi nhận chỉ số từ 0.
    PageRange {
        zero_based: bool,
    },
    /// Danh sách file do phần viết tay thêm. `as_objects`: mỗi phần tử là `{ "path": ... }`.
    FileList {
        as_objects: bool,
        min_items: usize,
    },
    /// Kiểu chưa sinh được (đối tượng lồng, mảng phức tạp…): bên gọi tự viết điều khiển.
    Unsupported(String),
}

/// Một trường của `Params`.
#[derive(Clone, Debug, PartialEq)]
pub struct FieldSpec {
    pub name: String,
    pub kind: FieldKind,
    pub required: bool,
    /// Chấp nhận `null` (ở schema là `anyOf [T, null]`).
    pub nullable: bool,
    pub title: Option<String>,
    pub description: Option<String>,
    pub default: Option<Value>,
}

/// Lỗi đọc schema.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SchemaError {
    MissingDefinition(String),
    NotAnObject(String),
}

/// Form của một `Params`.
#[derive(Clone, Debug, PartialEq)]
pub struct FormSchema {
    pub params_name: String,
    pub description: Option<String>,
    pub fields: Vec<FieldSpec>,
}

/// Giá trị người dùng đang nhập cho một trường.
#[derive(Clone, Debug, PartialEq)]
pub enum FieldInput {
    Text(String),
    Bool(bool),
    /// Chỉ số trong `FieldKind::Choice`; `None` là chưa chọn.
    Choice(Option<usize>),
    Files(Vec<String>),
}

#[derive(Clone, Debug, PartialEq)]
pub enum FieldErrorKind {
    Required,
    NotInteger,
    NotNumber,
    TooSmall(String),
    TooLarge(String),
    TooShort(usize),
    TooLong(usize),
    BadPageRange(String),
    NoFiles(usize),
    InvalidChoice,
    Unsupported,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FieldError {
    pub field: String,
    pub kind: FieldErrorKind,
}

impl FieldError {
    /// Thông báo tiếng người dùng, theo ngôn ngữ hiện tại. `label` là nhãn của trường.
    pub fn message(&self, label: &str) -> String {
        let (key, vars): (&str, Vec<(&str, String)>) = match &self.kind {
            FieldErrorKind::Required => ("required", vec![]),
            FieldErrorKind::NotInteger => ("notInteger", vec![]),
            FieldErrorKind::NotNumber => ("notNumber", vec![]),
            FieldErrorKind::TooSmall(min) => ("tooSmall", vec![("min", min.clone())]),
            FieldErrorKind::TooLarge(max) => ("tooLarge", vec![("max", max.clone())]),
            FieldErrorKind::TooShort(min) => ("tooShort", vec![("min", min.to_string())]),
            FieldErrorKind::TooLong(max) => ("tooLong", vec![("max", max.to_string())]),
            FieldErrorKind::BadPageRange(token) => ("badPages", vec![("token", token.clone())]),
            FieldErrorKind::NoFiles(min) => ("noFiles", vec![("min", min.to_string())]),
            FieldErrorKind::InvalidChoice => ("invalidChoice", vec![]),
            FieldErrorKind::Unsupported => ("unsupported", vec![]),
        };
        let mut all: Vec<(&str, &str)> = vec![("field", label)];
        all.extend(vars.iter().map(|(k, v)| (*k, v.as_str())));
        i18n::t_with(&format!("schemaForm.error.{key}"), &all)
    }
}

const DEFINITIONS_PREFIX: &str = "#/definitions/";

fn resolve<'a>(root: &'a Value, node: &'a Value) -> &'a Value {
    let mut node = node;
    // Giới hạn độ sâu để schema vòng không treo.
    for _ in 0..8 {
        let Some(target) = node.get("$ref").and_then(Value::as_str) else {
            return node;
        };
        let Some(name) = target.strip_prefix(DEFINITIONS_PREFIX) else {
            return node;
        };
        match root.get("definitions").and_then(|d| d.get(name)) {
            Some(next) => node = next,
            None => return node,
        }
    }
    node
}

/// Tách `anyOf [T, null]`. Trả về (nút kiểu thật, có null).
fn split_nullable<'a>(root: &'a Value, node: &'a Value) -> (&'a Value, bool) {
    let node = resolve(root, node);
    let Some(variants) = node.get("anyOf").and_then(Value::as_array) else {
        return (node, false);
    };
    let is_null = |v: &Value| v.get("type").and_then(Value::as_str) == Some("null");
    let nullable = variants.iter().any(is_null);
    let mut others = variants.iter().filter(|v| !is_null(v));
    match (others.next(), others.next()) {
        (Some(only), None) => (resolve(root, only), nullable),
        _ => (node, nullable),
    }
}

fn as_i64(v: Option<&Value>) -> Option<i64> {
    let v = v?;
    v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))
}

fn kind_of(root: &Value, name: &str, node: &Value) -> FieldKind {
    if let Some(values) = node.get("enum").and_then(Value::as_array) {
        return FieldKind::Choice(values.clone());
    }
    match node.get("type").and_then(Value::as_str) {
        Some("string") => FieldKind::Text {
            min_len: node.get("minLength").and_then(Value::as_u64).unwrap_or(0) as usize,
            max_len: node
                .get("maxLength")
                .and_then(Value::as_u64)
                .map(|n| n as usize),
        },
        Some("integer") => FieldKind::Integer {
            min: as_i64(node.get("minimum")),
            max: as_i64(node.get("maximum")),
        },
        Some("number") => FieldKind::Number {
            min: node.get("minimum").and_then(Value::as_f64),
            max: node.get("maximum").and_then(Value::as_f64),
        },
        Some("boolean") => FieldKind::Bool,
        Some("array") => array_kind(root, name, node),
        Some(other) => FieldKind::Unsupported(other.to_string()),
        None => FieldKind::Unsupported("khác".to_string()),
    }
}

fn array_kind(root: &Value, name: &str, node: &Value) -> FieldKind {
    let min_items = node.get("minItems").and_then(Value::as_u64).unwrap_or(0) as usize;
    let Some(items) = node.get("items") else {
        return FieldKind::Unsupported("array".to_string());
    };
    let items = resolve(root, items);
    let lower = name.to_ascii_lowercase();
    match items.get("type").and_then(Value::as_str) {
        Some("integer") if lower.ends_with("pages") => FieldKind::PageRange {
            zero_based: as_i64(items.get("minimum")).unwrap_or(0) == 0,
        },
        Some("object")
            if items
                .get("properties")
                .and_then(|p| p.get("path"))
                .and_then(|p| p.get("type"))
                .and_then(Value::as_str)
                == Some("string") =>
        {
            FieldKind::FileList {
                as_objects: true,
                min_items,
            }
        }
        Some("string") if lower.ends_with("paths") || lower.ends_with("files") => {
            FieldKind::FileList {
                as_objects: false,
                min_items,
            }
        }
        _ => FieldKind::Unsupported("array".to_string()),
    }
}

impl FormSchema {
    /// Đọc `definitions.<def_name>` của schema gốc (`ops.schema.json`).
    pub fn from_definition(root: &Value, def_name: &str) -> Result<FormSchema, SchemaError> {
        let def = root
            .get("definitions")
            .and_then(|d| d.get(def_name))
            .ok_or_else(|| SchemaError::MissingDefinition(def_name.to_string()))?;
        let def = resolve(root, def);
        let props = def
            .get("properties")
            .and_then(Value::as_object)
            .ok_or_else(|| SchemaError::NotAnObject(def_name.to_string()))?;
        let required: Vec<&str> = def
            .get("required")
            .and_then(Value::as_array)
            .map(|r| r.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();

        let mut fields = Vec::with_capacity(props.len());
        for (name, prop) in props {
            let outer = resolve(root, prop);
            let (inner, nullable) = split_nullable(root, prop);
            let text = |key: &str| {
                outer
                    .get(key)
                    .or_else(|| inner.get(key))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            };
            fields.push(FieldSpec {
                name: name.clone(),
                kind: kind_of(root, name, inner),
                required: required.contains(&name.as_str()),
                nullable,
                title: text("title"),
                description: text("description"),
                default: outer
                    .get("default")
                    .or_else(|| inner.get("default"))
                    .cloned(),
            });
        }
        Ok(FormSchema {
            params_name: def_name.to_string(),
            description: def
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
            fields,
        })
    }

    /// Giá trị ban đầu cho mọi trường.
    pub fn initial_inputs(&self) -> BTreeMap<String, FieldInput> {
        self.fields
            .iter()
            .map(|f| (f.name.clone(), initial_input(f)))
            .collect()
    }

    /// Trường cần điều khiển viết tay (không sinh được).
    pub fn unsupported_fields(&self) -> impl Iterator<Item = &FieldSpec> {
        self.fields
            .iter()
            .filter(|f| matches!(f.kind, FieldKind::Unsupported(_)))
    }

    /// Kiểm tra giá trị nhập rồi dựng JSON `params`. Trả mọi lỗi cùng lúc để hiện trên từng ô.
    /// Trường tùy chọn bỏ trống thì không có trong kết quả (lõi tự áp mặc định).
    pub fn build(&self, inputs: &BTreeMap<String, FieldInput>) -> Result<Value, Vec<FieldError>> {
        let mut out = Map::new();
        let mut errors = Vec::new();
        for field in &self.fields {
            let input = inputs
                .get(&field.name)
                .cloned()
                .unwrap_or_else(|| initial_input(field));
            match build_field(field, &input) {
                Ok(Some(value)) => {
                    out.insert(field.name.clone(), value);
                }
                Ok(None) => {}
                Err(kind) => errors.push(FieldError {
                    field: field.name.clone(),
                    kind,
                }),
            }
        }
        if errors.is_empty() {
            Ok(Value::Object(out))
        } else {
            Err(errors)
        }
    }

    /// Nhãn hiển thị của trường.
    pub fn label(&self, field: &FieldSpec) -> String {
        let keys = [
            format!("schemaForm.fields.{}.{}", self.params_name, field.name),
            format!("schemaForm.fields.{}", field.name),
        ];
        catalog_text(&keys)
            .unwrap_or_else(|| humanize(field.title.as_deref().unwrap_or(&field.name)))
    }

    /// Mô tả ngắn dưới nhãn; thiếu bản dịch thì dùng `description` của schema.
    pub fn hint(&self, field: &FieldSpec) -> Option<String> {
        let keys = [
            format!("schemaForm.hints.{}.{}", self.params_name, field.name),
            format!("schemaForm.hints.{}", field.name),
        ];
        catalog_text(&keys).or_else(|| field.description.clone())
    }

    /// Nhãn một lựa chọn của trường `Choice`.
    pub fn option_label(&self, field: &FieldSpec, value: &Value) -> String {
        let raw = value_text(value);
        let keys = [
            format!(
                "schemaForm.options.{}.{}.{}",
                self.params_name, field.name, raw
            ),
            format!("schemaForm.options.{}.{}", field.name, raw),
        ];
        catalog_text(&keys).unwrap_or(raw)
    }
}

fn catalog_text(keys: &[String]) -> Option<String> {
    let catalog = i18n::catalog(i18n::language());
    keys.iter().find_map(|k| catalog.get(k).cloned())
}

fn value_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// "outputPath" → "Output path".
pub fn humanize(name: &str) -> String {
    let mut out = String::new();
    let mut prev_lower = false;
    for ch in name.chars() {
        if ch == '_' || ch == '-' {
            out.push(' ');
            prev_lower = false;
            continue;
        }
        if ch.is_uppercase() && prev_lower {
            out.push(' ');
        }
        if out.is_empty() {
            out.extend(ch.to_uppercase());
        } else if ch.is_uppercase() {
            out.extend(ch.to_lowercase());
        } else {
            out.push(ch);
        }
        prev_lower = ch.is_lowercase() || ch.is_ascii_digit();
    }
    out
}

fn initial_input(field: &FieldSpec) -> FieldInput {
    match &field.kind {
        FieldKind::Bool => FieldInput::Bool(
            field
                .default
                .as_ref()
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
        FieldKind::Choice(values) => {
            let by_default = field
                .default
                .as_ref()
                .and_then(|d| values.iter().position(|v| v == d));
            // Trường bắt buộc chọn sẵn mục đầu, như nhóm radio ở hộp thoại viết tay.
            FieldInput::Choice(by_default.or(if field.required { Some(0) } else { None }))
        }
        FieldKind::FileList { .. } => FieldInput::Files(Vec::new()),
        FieldKind::Text { .. } | FieldKind::Integer { .. } | FieldKind::Number { .. } => {
            FieldInput::Text(field.default.as_ref().map(value_text).unwrap_or_default())
        }
        FieldKind::PageRange { .. } | FieldKind::Unsupported(_) => FieldInput::Text(String::new()),
    }
}

fn build_field(field: &FieldSpec, input: &FieldInput) -> Result<Option<Value>, FieldErrorKind> {
    let empty = |required: bool| {
        if required {
            Err(FieldErrorKind::Required)
        } else {
            Ok(None)
        }
    };
    match (&field.kind, input) {
        (FieldKind::Unsupported(_), _) => {
            if field.required {
                Err(FieldErrorKind::Unsupported)
            } else {
                Ok(None)
            }
        }
        (FieldKind::Bool, FieldInput::Bool(b)) => Ok(Some(Value::Bool(*b))),
        (FieldKind::Text { min_len, max_len }, FieldInput::Text(s)) => {
            if s.trim().is_empty() {
                return empty(field.required || *min_len > 0);
            }
            let len = s.chars().count();
            if len < *min_len {
                return Err(FieldErrorKind::TooShort(*min_len));
            }
            if max_len.is_some_and(|max| len > max) {
                return Err(FieldErrorKind::TooLong(max_len.unwrap_or(0)));
            }
            Ok(Some(Value::String(s.clone())))
        }
        (FieldKind::Integer { min, max }, FieldInput::Text(s)) => {
            let s = s.trim();
            if s.is_empty() {
                return empty(field.required);
            }
            let n: i64 = s.parse().map_err(|_| FieldErrorKind::NotInteger)?;
            if min.is_some_and(|m| n < m) {
                return Err(FieldErrorKind::TooSmall(min.unwrap_or(0).to_string()));
            }
            if max.is_some_and(|m| n > m) {
                return Err(FieldErrorKind::TooLarge(max.unwrap_or(0).to_string()));
            }
            Ok(Some(Value::Number(n.into())))
        }
        (FieldKind::Number { min, max }, FieldInput::Text(s)) => {
            let s = s.trim().replace(',', ".");
            if s.is_empty() {
                return empty(field.required);
            }
            let n: f64 = s.parse().map_err(|_| FieldErrorKind::NotNumber)?;
            let number = Number::from_f64(n).ok_or(FieldErrorKind::NotNumber)?;
            if min.is_some_and(|m| n < m) {
                return Err(FieldErrorKind::TooSmall(min.unwrap_or(0.0).to_string()));
            }
            if max.is_some_and(|m| n > m) {
                return Err(FieldErrorKind::TooLarge(max.unwrap_or(0.0).to_string()));
            }
            Ok(Some(Value::Number(number)))
        }
        (FieldKind::Choice(values), FieldInput::Choice(index)) => match index {
            None => empty(field.required),
            Some(i) => values
                .get(*i)
                .cloned()
                .map(Some)
                .ok_or(FieldErrorKind::InvalidChoice),
        },
        (FieldKind::PageRange { zero_based }, FieldInput::Text(s)) => {
            if s.trim().is_empty() {
                return empty(field.required);
            }
            let pages = parse_page_ranges(s, *zero_based)?;
            Ok(Some(Value::Array(
                pages.into_iter().map(|p| Value::Number(p.into())).collect(),
            )))
        }
        (
            FieldKind::FileList {
                as_objects,
                min_items,
            },
            FieldInput::Files(files),
        ) => {
            if files.is_empty() {
                return if field.required || *min_items > 0 {
                    Err(FieldErrorKind::NoFiles((*min_items).max(1)))
                } else {
                    Ok(None)
                };
            }
            if files.len() < *min_items {
                return Err(FieldErrorKind::NoFiles(*min_items));
            }
            Ok(Some(Value::Array(
                files
                    .iter()
                    .map(|path| {
                        if *as_objects {
                            let mut o = Map::new();
                            o.insert("path".to_string(), Value::String(path.clone()));
                            Value::Object(o)
                        } else {
                            Value::String(path.clone())
                        }
                    })
                    .collect(),
            )))
        }
        // Loại giá trị không khớp loại trường: lỗi lập trình ở bên gọi, chặn chứ không đoán.
        _ => Err(FieldErrorKind::InvalidChoice),
    }
}

/// "1-3, 5" (số trang từ 1) → chỉ số theo quy ước của lõi. Giữ thứ tự nhập, bỏ trang trùng.
pub fn parse_page_ranges(text: &str, zero_based: bool) -> Result<Vec<i64>, FieldErrorKind> {
    let offset = if zero_based { 1 } else { 0 };
    let mut pages: Vec<i64> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut push = |page: i64| {
        if seen.insert(page) {
            pages.push(page - offset);
        }
    };
    for token in text.split([',', ';', '\n']) {
        let token = token.trim();
        if token.is_empty() {
            continue;
        }
        let bad = || FieldErrorKind::BadPageRange(token.to_string());
        let (from, to) = match token.split_once(['-', '–']) {
            Some((a, b)) => (a.trim(), b.trim()),
            None => (token, token),
        };
        let from: i64 = from.parse().map_err(|_| bad())?;
        let to: i64 = to.parse().map_err(|_| bad())?;
        if from < 1 || to < from || to - from >= PAGE_RANGE_MAX {
            return Err(bad());
        }
        for page in from..=to {
            push(page);
        }
    }
    if pages.is_empty() {
        return Err(FieldErrorKind::Required);
    }
    Ok(pages)
}

// ---------------------------------------------------------------------------
// Giao diện
// ---------------------------------------------------------------------------

/// Sự kiện của form: giá trị đổi (để hộp thoại tính lại `can_run`, bản xem trước).
pub enum SchemaFormEvent {
    Changed,
}

/// Form sinh từ schema. Giữ ô nhập, tiêu điểm và lỗi; giá trị rời chỉ lấy qua [`Self::validate`].
pub struct SchemaForm {
    schema: FormSchema,
    dark: bool,
    inputs: BTreeMap<String, FieldInput>,
    texts: BTreeMap<String, Entity<TextInput>>,
    focus: BTreeMap<String, Vec<FocusHandle>>,
    errors: BTreeMap<String, FieldErrorKind>,
    show_errors: bool,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<SchemaFormEvent> for SchemaForm {}

impl SchemaForm {
    pub fn new(
        root: &Value,
        def_name: &str,
        dark: bool,
        cx: &mut Context<Self>,
    ) -> Result<Self, SchemaError> {
        let schema = FormSchema::from_definition(root, def_name)?;
        let inputs = schema.initial_inputs();
        let mut texts = BTreeMap::new();
        let mut focus = BTreeMap::new();
        let mut subscriptions = Vec::new();
        for field in &schema.fields {
            match &field.kind {
                FieldKind::Text { .. }
                | FieldKind::Integer { .. }
                | FieldKind::Number { .. }
                | FieldKind::PageRange { .. } => {
                    let placeholder = if matches!(field.kind, FieldKind::PageRange { .. }) {
                        i18n::t("schemaForm.pagesPlaceholder")
                    } else {
                        String::new()
                    };
                    let initial = match inputs.get(&field.name) {
                        Some(FieldInput::Text(s)) => s.clone(),
                        _ => String::new(),
                    };
                    let entity = cx.new(|cx| {
                        let mut input = TextInput::new(cx, placeholder);
                        input.set_text(&initial, cx);
                        input
                    });
                    subscriptions.push(cx.subscribe(
                        &entity,
                        |this, _, event: &TextInputEvent, cx| {
                            if matches!(event, TextInputEvent::Changed) {
                                // Sửa lại thì xóa lỗi cũ, lỗi mới chỉ hiện sau lần kiểm tra kế tiếp.
                                this.errors.clear();
                                this.show_errors = false;
                                cx.emit(SchemaFormEvent::Changed);
                                cx.notify();
                            }
                        },
                    ));
                    texts.insert(field.name.clone(), entity);
                }
                FieldKind::Bool => {
                    focus.insert(field.name.clone(), vec![cx.focus_handle()]);
                }
                FieldKind::Choice(values) => {
                    focus.insert(
                        field.name.clone(),
                        (0..values.len()).map(|_| cx.focus_handle()).collect(),
                    );
                }
                FieldKind::FileList { .. } | FieldKind::Unsupported(_) => {}
            }
        }
        Ok(Self {
            schema,
            dark,
            inputs,
            texts,
            focus,
            errors: BTreeMap::new(),
            show_errors: false,
            _subscriptions: subscriptions,
        })
    }

    pub fn schema(&self) -> &FormSchema {
        &self.schema
    }

    pub fn set_dark(&mut self, dark: bool, cx: &mut Context<Self>) {
        if self.dark != dark {
            self.dark = dark;
            cx.notify();
        }
    }

    /// Danh sách file cho trường `FileList` (phần viết tay thêm, bớt, sắp thứ tự).
    pub fn set_files(&mut self, field: &str, files: Vec<String>, cx: &mut Context<Self>) {
        self.inputs
            .insert(field.to_string(), FieldInput::Files(files));
        self.errors.clear();
        self.show_errors = false;
        cx.emit(SchemaFormEvent::Changed);
        cx.notify();
    }

    /// Đặt chữ cho trường nhập dòng (ví dụ đường dẫn ra do hộp thoại lưu trả về).
    pub fn set_text(&mut self, field: &str, text: &str, cx: &mut Context<Self>) {
        if let Some(entity) = self.texts.get(field) {
            entity.update(cx, |input, cx| input.set_text(text, cx));
        }
    }

    fn collect(&self, cx: &gpui::App) -> BTreeMap<String, FieldInput> {
        let mut inputs = self.inputs.clone();
        for (name, entity) in &self.texts {
            inputs.insert(
                name.clone(),
                FieldInput::Text(entity.read(cx).text().to_string()),
            );
        }
        inputs
    }

    /// Dựng `params` mà không hiện lỗi; dùng để bật tắt nút chạy.
    pub fn peek(&self, cx: &gpui::App) -> Result<Value, Vec<FieldError>> {
        self.schema.build(&self.collect(cx))
    }

    /// Kiểm tra trước khi chạy. Có lỗi thì hiện dưới từng ô và trả `None`.
    pub fn validate(&mut self, cx: &mut Context<Self>) -> Option<Value> {
        match self.peek(cx) {
            Ok(value) => {
                self.errors.clear();
                self.show_errors = false;
                cx.notify();
                Some(value)
            }
            Err(errors) => {
                self.errors = errors.into_iter().map(|e| (e.field, e.kind)).collect();
                self.show_errors = true;
                cx.notify();
                None
            }
        }
    }

    /// Lỗi đang hiện (rỗng khi chưa kiểm tra); cho E2E đọc.
    pub fn shown_errors(&self) -> Vec<FieldError> {
        if !self.show_errors {
            return Vec::new();
        }
        self.errors
            .iter()
            .map(|(field, kind)| FieldError {
                field: field.clone(),
                kind: kind.clone(),
            })
            .collect()
    }

    fn element_id(&self, field: &FieldSpec) -> SharedString {
        format!("schema-{}-{}", self.schema.params_name, field.name).into()
    }

    fn render_field(&self, field: &FieldSpec, cx: &mut Context<Self>) -> Option<gpui::AnyElement> {
        let label = self.schema.label(field);
        let id = self.element_id(field);
        let me = cx.entity();
        let control: gpui::AnyElement = match &field.kind {
            FieldKind::Text { .. }
            | FieldKind::Integer { .. }
            | FieldKind::Number { .. }
            | FieldKind::PageRange { .. } => {
                let entity = self.texts.get(&field.name)?.clone();
                TextField::new(id.clone(), label.clone(), entity)
                    .dark(self.dark)
                    .into_any_element()
            }
            FieldKind::Bool => {
                let focus = self.focus.get(&field.name)?.first()?.clone();
                let on = matches!(self.inputs.get(&field.name), Some(FieldInput::Bool(true)));
                let name = field.name.clone();
                Switch::new(id.clone(), focus, label.clone(), on)
                    .dark(self.dark)
                    .on_change(move |next, _, cx| {
                        let name = name.clone();
                        let next = *next;
                        me.update(cx, |this, cx| {
                            this.inputs.insert(name, FieldInput::Bool(next));
                            this.errors.clear();
                            this.show_errors = false;
                            cx.emit(SchemaFormEvent::Changed);
                            cx.notify();
                        });
                    })
                    .into_any_element()
            }
            FieldKind::Choice(values) => {
                self.render_choice(field, values, &label, id.clone(), me)?
            }
            FieldKind::FileList { .. } => {
                let files = match self.inputs.get(&field.name) {
                    Some(FieldInput::Files(f)) => f.clone(),
                    _ => Vec::new(),
                };
                self.render_files(&label, &files)
            }
            FieldKind::Unsupported(_) => return None,
        };

        let t = Colors::of(self.dark);
        let hint = self.schema.hint(field);
        // Tên trường đã nằm trong nhãn của TextField, Switch; chỉ thêm mô tả và lỗi.
        let error = self
            .show_errors
            .then(|| self.errors.get(&field.name))
            .flatten()
            .map(|kind| {
                FieldError {
                    field: field.name.clone(),
                    kind: kind.clone(),
                }
                .message(&label)
            });
        Some(
            div()
                .flex()
                .flex_col()
                .gap(px(shared::SPACE_2))
                .child(control)
                .when_some(hint, |d, hint| {
                    d.child(
                        div()
                            .text_size(px(shared::TEXT_SM))
                            .text_color(rgba(pack(t.text_3)))
                            .child(hint),
                    )
                })
                .when_some(error, |d, message| {
                    d.child(
                        div()
                            .text_size(px(shared::TEXT_SM))
                            .text_color(rgba(pack(t.danger)))
                            .child(message),
                    )
                })
                .into_any_element(),
        )
    }

    fn render_choice(
        &self,
        field: &FieldSpec,
        values: &[Value],
        label: &str,
        id: SharedString,
        me: Entity<SchemaForm>,
    ) -> Option<gpui::AnyElement> {
        let t = Colors::of(self.dark);
        let selected = match self.inputs.get(&field.name) {
            Some(FieldInput::Choice(i)) => *i,
            _ => None,
        };
        let labels: Vec<SharedString> = values
            .iter()
            .map(|v| self.schema.option_label(field, v).into())
            .collect();
        let name = field.name.clone();
        let on_pick = move |index: Option<usize>, cx: &mut gpui::App| {
            let name = name.clone();
            me.update(cx, |this, cx| {
                this.inputs.insert(name, FieldInput::Choice(index));
                this.errors.clear();
                this.show_errors = false;
                cx.emit(SchemaFormEvent::Changed);
                cx.notify();
            });
        };
        let heading = div()
            .text_size(px(shared::TEXT_SM))
            .font_weight(FontWeight::MEDIUM)
            .text_color(rgba(pack(t.text_2)))
            .child(label.to_string());
        let body: gpui::AnyElement = if values.len() <= RADIO_MAX_OPTIONS && field.required {
            let handles = self.focus.get(&field.name)?;
            let items: Vec<RadioItem> = labels
                .iter()
                .zip(handles)
                .enumerate()
                .map(|(i, (text, handle))| {
                    RadioItem::new(format!("{id}-{i}"), handle.clone(), text.clone())
                })
                .collect();
            RadioGroup::new(id, label.to_string(), items)
                .selected(selected)
                .dark(self.dark)
                .on_change(move |index, _, cx| on_pick(Some(index), cx))
                .into_any_element()
        } else {
            // Trường tùy chọn có thêm mục đầu "không chọn" ứng với `None`.
            let optional = !field.required;
            let mut options: Vec<SharedString> = Vec::new();
            if optional {
                options.push(i18n::t("schemaForm.noChoice").into());
            }
            options.extend(labels);
            let shown = match (selected, optional) {
                (Some(i), true) => i + 1,
                (Some(i), false) => i,
                (None, _) => 0,
            };
            Select::new(id, label.to_string(), options)
                .selected(shown)
                .width(240.0)
                .dark(self.dark)
                .on_change(move |index, _, cx| {
                    let picked = if optional {
                        index.checked_sub(1)
                    } else {
                        Some(index)
                    };
                    on_pick(picked, cx);
                })
                .into_any_element()
        };
        Some(
            div()
                .flex()
                .flex_col()
                .gap(px(shared::SPACE_3))
                .child(heading)
                .child(body)
                .into_any_element(),
        )
    }

    fn render_files(&self, label: &str, files: &[String]) -> gpui::AnyElement {
        let t = Colors::of(self.dark);
        let mut list = div().flex().flex_col().gap(px(shared::SPACE_1));
        if files.is_empty() {
            list = list.child(
                div()
                    .text_size(px(shared::TEXT_MD))
                    .text_color(rgba(pack(t.text_3)))
                    .child(i18n::t("schemaForm.noFiles")),
            );
        }
        for (i, path) in files.iter().enumerate() {
            list = list.child(
                div()
                    .text_size(px(shared::TEXT_MD))
                    .text_color(rgba(pack(t.text)))
                    .child(format!("{}. {}", i + 1, display_basename(path))),
            );
        }
        div()
            .flex()
            .flex_col()
            .gap(px(shared::SPACE_3))
            .child(
                div()
                    .text_size(px(shared::TEXT_SM))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(rgba(pack(t.text_2)))
                    .child(label.to_string()),
            )
            .child(list)
            .into_any_element()
    }
}

struct Colors {
    text: chef_theme::Rgba,
    text_2: chef_theme::Rgba,
    text_3: chef_theme::Rgba,
    danger: chef_theme::Rgba,
}

impl Colors {
    fn of(is_dark: bool) -> Colors {
        if is_dark {
            Colors {
                text: dark::C_TEXT,
                text_2: dark::C_TEXT_2,
                text_3: dark::C_TEXT_3,
                danger: dark::C_DANGER,
            }
        } else {
            Colors {
                text: light::C_TEXT,
                text_2: light::C_TEXT_2,
                text_3: light::C_TEXT_3,
                danger: light::C_DANGER,
            }
        }
    }
}

impl Render for SchemaForm {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let fields = self.schema.fields.clone();
        let mut column = div().flex().flex_col().gap(px(shared::SPACE_6)).w_full();
        for field in &fields {
            if let Some(element) = self.render_field(field, cx) {
                column = column.child(element);
            }
        }
        column
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn ops() -> Value {
        chef_contracts::ops_schema()
    }

    fn form(name: &str) -> FormSchema {
        FormSchema::from_definition(&ops(), name).expect(name)
    }

    fn field<'a>(schema: &'a FormSchema, name: &str) -> &'a FieldSpec {
        schema
            .fields
            .iter()
            .find(|f| f.name == name)
            .unwrap_or_else(|| panic!("thiếu trường {name}"))
    }

    fn text(s: &str) -> FieldInput {
        FieldInput::Text(s.to_string())
    }

    #[test]
    fn every_operation_params_parses_into_a_form() {
        let root = ops();
        let names: Vec<&String> = root["definitions"]
            .as_object()
            .unwrap()
            .keys()
            .filter(|n| n.ends_with("Params"))
            .collect();
        assert!(names.len() > 150);
        for name in names {
            let schema = FormSchema::from_definition(&root, name)
                .unwrap_or_else(|e| panic!("{name}: {e:?}"));
            // Mọi trường có điều khiển hoặc được đánh dấu "viết tay"; không trường nào mất.
            assert!(!schema.params_name.is_empty());
        }
    }

    #[test]
    fn most_required_fields_are_generated() {
        let root = ops();
        let (mut required, mut hand) = (0usize, 0usize);
        for (name, _) in root["definitions"].as_object().unwrap() {
            if !name.ends_with("Params") {
                continue;
            }
            let schema = FormSchema::from_definition(&root, name).unwrap();
            for f in &schema.fields {
                if f.required {
                    required += 1;
                    if matches!(f.kind, FieldKind::Unsupported(_)) {
                        hand += 1;
                    }
                }
            }
        }
        // Chỉ vài trường bắt buộc phức tạp (đối tượng lồng) cần điều khiển viết tay.
        assert!(
            hand * 5 <= required,
            "quá nhiều trường bắt buộc không sinh được: {hand}/{required}"
        );
    }

    #[test]
    fn page_rotate_form_matches_the_hand_written_rotate_dialog() {
        let schema = form("PageRotateParams");
        assert_eq!(
            field(&schema, "pages").kind,
            FieldKind::PageRange { zero_based: true }
        );
        assert_eq!(
            field(&schema, "angle").kind,
            FieldKind::Choice(vec![json!(90), json!(180), json!(270)])
        );
        let mut inputs = schema.initial_inputs();
        inputs.insert("pages".into(), text("1-2, 4, 2"));
        inputs.insert("angle".into(), FieldInput::Choice(Some(1)));
        let value = schema.build(&inputs).expect("hợp lệ");
        assert_eq!(value, json!({"pages": [0, 1, 3], "angle": 180}));
        // Kết quả đúng dạng dây mà struct sinh từ lõi chấp nhận.
        let typed: chef_contracts::ops_types::PageRotateParams =
            serde_json::from_value(value).expect("struct sinh đọc được");
        assert_eq!(typed.pages, vec![0, 1, 3]);
    }

    #[test]
    fn wrong_types_are_blocked_before_running() {
        let schema = form("PageRotateParams");
        let mut inputs = schema.initial_inputs();
        inputs.insert("pages".into(), text("một-hai"));
        let errors = schema.build(&inputs).unwrap_err();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].field, "pages");
        assert!(matches!(errors[0].kind, FieldErrorKind::BadPageRange(_)));

        for bad in ["0", "3-1", "1-", "-2", "1.5"] {
            inputs.insert("pages".into(), text(bad));
            assert!(schema.build(&inputs).is_err(), "{bad} phải bị chặn");
        }
        inputs.insert("pages".into(), text(""));
        let errors = schema.build(&inputs).unwrap_err();
        assert_eq!(errors[0].kind, FieldErrorKind::Required);
        // Chỉ số lựa chọn ngoài danh sách bị chặn.
        inputs.insert("pages".into(), text("1"));
        inputs.insert("angle".into(), FieldInput::Choice(Some(9)));
        assert_eq!(
            schema.build(&inputs).unwrap_err()[0].kind,
            FieldErrorKind::InvalidChoice
        );
    }

    #[test]
    fn merge_form_builds_params_the_core_accepts() {
        let schema = form("FileMergeParams");
        assert_eq!(
            field(&schema, "inputs").kind,
            FieldKind::FileList {
                as_objects: true,
                min_items: 1
            }
        );
        let mut inputs = schema.initial_inputs();
        // Thiếu file và đường dẫn ra: báo cả hai lỗi một lượt.
        let errors = schema.build(&inputs).unwrap_err();
        let names: Vec<&str> = errors.iter().map(|e| e.field.as_str()).collect();
        assert!(names.contains(&"inputs") && names.contains(&"outputPath"));

        inputs.insert(
            "inputs".into(),
            FieldInput::Files(vec![r"C:\a.pdf".into(), r"C:\b.pdf".into()]),
        );
        inputs.insert("outputPath".into(), text(r"C:\out.pdf"));
        inputs.insert("bookmarksFromFilenames".into(), FieldInput::Bool(true));
        let value = schema.build(&inputs).expect("hợp lệ");
        assert_eq!(value["inputs"][1]["path"], json!(r"C:\b.pdf"));
        let typed: chef_contracts::ops_types::FileMergeParams =
            serde_json::from_value(value).expect("struct sinh đọc được");
        assert_eq!(typed.inputs.len(), 2);
    }

    #[test]
    fn split_form_has_the_five_modes() {
        let schema = form("FileSplitParams");
        let FieldKind::Choice(values) = &field(&schema, "mode").kind else {
            panic!("mode phải là lựa chọn");
        };
        assert_eq!(values.len(), 5);
    }

    #[test]
    fn optional_nullable_text_is_omitted_when_empty_and_length_checked() {
        let schema = form("DocSetMetadataParams");
        let title = field(&schema, "title");
        assert!(title.nullable && !title.required);
        assert_eq!(
            title.kind,
            FieldKind::Text {
                min_len: 0,
                max_len: Some(1000)
            }
        );
        let mut inputs = schema.initial_inputs();
        inputs.insert("title".into(), text("Hợp đồng"));
        let value = schema.build(&inputs).expect("hợp lệ");
        assert_eq!(value["title"], json!("Hợp đồng"));
        assert!(value.get("author").is_none(), "ô trống không gửi lên");

        inputs.insert("title".into(), text(&"a".repeat(1001)));
        assert_eq!(
            schema.build(&inputs).unwrap_err()[0].kind,
            FieldErrorKind::TooLong(1000)
        );
    }

    /// Thêm một operation mới chỉ cần schema, không viết giao diện (tiêu chí 3).
    #[test]
    fn a_brand_new_operation_gets_a_form_without_ui_code() {
        let root = json!({"definitions": {"BrandNewParams": {
            "title": "BrandNewParams", "type": "object",
            "properties": {
                "dpi": {"type": "integer", "minimum": 72, "maximum": 600, "default": 150},
                "scale": {"type": "number", "minimum": 0.1},
                "mode": {"enum": ["fast", "best"], "type": "string"},
                "grayscale": {"type": "boolean"},
                "extra": {"type": "object", "properties": {}}
            },
            "required": ["dpi", "mode", "extra"]
        }}});
        let schema = FormSchema::from_definition(&root, "BrandNewParams").unwrap();
        assert_eq!(schema.unsupported_fields().count(), 1);
        // Trường bắt buộc không sinh được thì không cho chạy ngầm.
        let mut inputs = schema.initial_inputs();
        assert_eq!(inputs["dpi"], text("150"));
        let errors = schema.build(&inputs).unwrap_err();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].kind, FieldErrorKind::Unsupported);

        let loose = FormSchema {
            fields: schema
                .fields
                .iter()
                .filter(|f| f.name != "extra")
                .cloned()
                .collect(),
            ..schema.clone()
        };
        inputs.insert("dpi".into(), text("601"));
        assert_eq!(
            loose.build(&inputs).unwrap_err()[0].kind,
            FieldErrorKind::TooLarge("600".into())
        );
        inputs.insert("dpi".into(), text("abc"));
        assert_eq!(
            loose.build(&inputs).unwrap_err()[0].kind,
            FieldErrorKind::NotInteger
        );
        inputs.insert("dpi".into(), text("300"));
        inputs.insert("scale".into(), text("0,05"));
        assert_eq!(
            loose.build(&inputs).unwrap_err()[0].kind,
            FieldErrorKind::TooSmall("0.1".into())
        );
        inputs.insert("scale".into(), text("1,5"));
        let value = loose.build(&inputs).unwrap();
        assert_eq!(
            value,
            json!({"dpi": 300, "scale": 1.5, "mode": "fast", "grayscale": false})
        );
    }

    #[test]
    fn missing_definition_is_reported() {
        assert_eq!(
            FormSchema::from_definition(&ops(), "NoSuchParams").unwrap_err(),
            SchemaError::MissingDefinition("NoSuchParams".into())
        );
    }

    #[test]
    fn humanize_splits_camel_case() {
        assert_eq!(humanize("outputPath"), "Output path");
        assert_eq!(humanize("Bookmarksfromfilenames"), "Bookmarksfromfilenames");
        assert_eq!(humanize("dpi"), "Dpi");
        assert_eq!(humanize("max_size"), "Max size");
    }

    #[test]
    fn page_ranges_keep_order_and_drop_duplicates() {
        assert_eq!(parse_page_ranges("3, 1-2; 2", true).unwrap(), vec![2, 0, 1]);
        assert_eq!(parse_page_ranges("1–3", false).unwrap(), vec![1, 2, 3]);
        assert!(parse_page_ranges("1-999999999", true).is_err());
    }

    #[test]
    fn every_error_has_a_vietnamese_and_an_english_message() {
        let kinds = [
            FieldErrorKind::Required,
            FieldErrorKind::NotInteger,
            FieldErrorKind::NotNumber,
            FieldErrorKind::TooSmall("1".into()),
            FieldErrorKind::TooLarge("9".into()),
            FieldErrorKind::TooShort(2),
            FieldErrorKind::TooLong(3),
            FieldErrorKind::BadPageRange("x".into()),
            FieldErrorKind::NoFiles(1),
            FieldErrorKind::InvalidChoice,
            FieldErrorKind::Unsupported,
        ];
        for lang in [i18n::Lang::Vi, i18n::Lang::En] {
            for kind in &kinds {
                let key = match kind {
                    FieldErrorKind::Required => "required",
                    FieldErrorKind::NotInteger => "notInteger",
                    FieldErrorKind::NotNumber => "notNumber",
                    FieldErrorKind::TooSmall(_) => "tooSmall",
                    FieldErrorKind::TooLarge(_) => "tooLarge",
                    FieldErrorKind::TooShort(_) => "tooShort",
                    FieldErrorKind::TooLong(_) => "tooLong",
                    FieldErrorKind::BadPageRange(_) => "badPages",
                    FieldErrorKind::NoFiles(_) => "noFiles",
                    FieldErrorKind::InvalidChoice => "invalidChoice",
                    FieldErrorKind::Unsupported => "unsupported",
                };
                let full = format!("schemaForm.error.{key}");
                let text = i18n::translate_in(lang, &full, None, &[("field", "Trang")]);
                assert_ne!(text, full, "thiếu bản dịch {full} ({lang:?})");
            }
        }
    }
}
