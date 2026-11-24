//! Hộp thoại danh sách chọn (TASKS_RUST R5.19, R5.39, R5.40, R5.46, R5.47): chạy một thao tác đọc của lõi
//! để lấy danh sách (file đính kèm, dấu đã thêm, watermark tìm được, dữ liệu ẩn), cho người dùng tích chọn
//! từng mục, rồi gỡ đúng các mục đã chọn bằng thao tác đổi revision (qua `begin_edit`, có hoàn tác).
//!
//! Mỗi hộp thoại là một dòng trong [`PICKERS`]; phần đọc dòng và dựng tham số là hàm thuần có test trên
//! kết quả thật của lõi (`testdata/list_results.json`).

use chef_ui::button::{Button, Size};
use chef_ui::dialog::Width;
use chef_ui::form::{CheckState, Checkbox};
use chef_ui::i18n::{t, t_with};
use chef_ui::task_dialog::{TaskDialog, TaskResult};
use gpui::{
    Context, EventEmitter, FocusHandle, IntoElement, Render, Window, div, prelude::*, px, rgba,
};
use serde_json::{Value, json};

use crate::process::{
    Colors, JobFail, JobOk, ProcessContext, ProcessEvent, ProcessView, Runner, spawn_job, wire,
};

/// Đặc tả một hộp thoại danh sách chọn.
#[derive(Clone, Copy, Debug)]
pub struct PickerSpec {
    /// Mã lệnh và khóa chữ (`picker.<id>.*`).
    pub id: &'static str,
    pub list_op: &'static str,
    /// Con trỏ JSON tới mảng dòng trong `data` ("" là chính `data`).
    pub rows_pointer: &'static str,
    /// Trường định danh của mỗi dòng.
    pub id_field: &'static str,
    pub apply_op: &'static str,
    /// Trường của tham số thao tác gỡ nhận danh sách định danh đã chọn.
    pub apply_field: &'static str,
    pub icon: &'static str,
    pub keywords: &'static [&'static str],
    /// Nhóm bảng lệnh: "file", "pages" hoặc "tools".
    pub group: &'static str,
}

pub static PICKERS: &[PickerSpec] = &[
    PickerSpec {
        id: "attachments",
        list_op: "doc.attachments.list",
        rows_pointer: "",
        id_field: "name",
        apply_op: "doc.attachments.remove",
        apply_field: "names",
        icon: "icons/paperclip.svg",
        keywords: &[
            "attachments",
            "xoa file dinh kem",
            "danh sach file dinh kem",
        ],
        group: "tools",
    },
    PickerSpec {
        id: "overlays",
        list_op: "overlay.listOverlays",
        rows_pointer: "/overlays",
        id_field: "id",
        apply_op: "overlay.remove",
        apply_field: "ids",
        icon: "icons/layers.svg",
        keywords: &["overlays", "quan ly dau da them", "go dau"],
        group: "tools",
    },
    PickerSpec {
        id: "watermarks",
        list_op: "watermark.detect",
        rows_pointer: "/candidates",
        id_field: "id",
        apply_op: "watermark.remove",
        apply_field: "candidateIds",
        icon: "icons/droplets.svg",
        keywords: &["watermarks", "chon watermark de go"],
        group: "tools",
    },
    PickerSpec {
        id: "hidden",
        list_op: "inspect.hiddenData",
        rows_pointer: "/findings",
        id_field: "category",
        apply_op: "inspect.removeHidden",
        apply_field: "categories",
        icon: "icons/scan-search.svg",
        keywords: &["hidden data", "du lieu an", "don dep"],
        group: "tools",
    },
];

// ---------------------------------------------------------------------------
// Phần thuần
// ---------------------------------------------------------------------------

/// Một dòng của danh sách.
#[derive(Clone, Debug, PartialEq)]
pub struct PickerRow {
    pub id: String,
    pub label: String,
    pub detail: Option<String>,
    /// Chọn được hay không (ví dụ mục chỉ để báo cáo, không gỡ được).
    pub selectable: bool,
}

/// "3 trang (1-3)" từ danh sách chỉ số trang (từ 0) của lõi.
fn pages_text(value: &Value) -> Option<String> {
    let pages: Vec<usize> = value
        .as_array()?
        .iter()
        .filter_map(|p| p.as_u64().and_then(|p| usize::try_from(p).ok()))
        .collect();
    (!pages.is_empty()).then(|| {
        t_with(
            "pages.pagesN",
            &[
                ("count", &pages.len().to_string()),
                ("ranges", &crate::page_range::format_page_ranges(&pages)),
            ],
        )
    })
}

fn describe(spec: &PickerSpec, item: &Value, id: &str) -> (String, Option<String>, bool) {
    let text = |key: &str| item.get(key).and_then(Value::as_str).unwrap_or("");
    match spec.id {
        "attachments" => {
            let size = item.get("size").and_then(Value::as_u64).unwrap_or(0);
            (
                id.to_string(),
                Some(crate::process::format_bytes(size)),
                true,
            )
        }
        "overlays" => {
            let kind = text("kind");
            let label = text("label");
            let title = if label.is_empty() {
                kind.to_string()
            } else {
                format!("{kind}: {label}")
            };
            let pages = item.get("pages").and_then(pages_text);
            (title, pages, true)
        }
        "watermarks" => {
            let lang = if chef_ui::i18n::language() == chef_ui::i18n::Lang::En {
                "en"
            } else {
                "vi"
            };
            let label = item
                .pointer(&format!("/description/{lang}"))
                .and_then(Value::as_str)
                .unwrap_or(id)
                .to_string();
            let confidence = item
                .get("confidence")
                .and_then(Value::as_f64)
                .map(|c| format!("{}%", (c * 100.0).round()));
            let pages = item.get("pages").and_then(pages_text);
            let detail = match (pages, confidence) {
                (Some(p), Some(c)) => Some(format!("{p} · {c}")),
                (Some(p), None) => Some(p),
                (None, Some(c)) => Some(c),
                (None, None) => None,
            };
            (label, detail, true)
        }
        "hidden" => {
            let count = item.get("count").and_then(Value::as_u64).unwrap_or(0);
            let fixable = item
                .get("fixAvailable")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let key = format!("inspect.cat.{id}");
            let name = {
                let translated = t(&key);
                if translated == key {
                    id.to_string()
                } else {
                    translated
                }
            };
            (
                name,
                Some(t_with("inspect.count", &[("count", &count.to_string())])),
                fixable && count > 0,
            )
        }
        _ => (id.to_string(), None, true),
    }
}

/// Đọc danh sách dòng từ `data` của thao tác liệt kê. Dòng không có định danh bị bỏ.
pub fn parse_rows(spec: &PickerSpec, data: &Value) -> Vec<PickerRow> {
    let rows = if spec.rows_pointer.is_empty() {
        Some(data)
    } else {
        data.pointer(spec.rows_pointer)
    };
    rows.and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get(spec.id_field)?.as_str()?.to_string();
                    let (label, detail, selectable) = describe(spec, item, &id);
                    Some(PickerRow {
                        id,
                        label,
                        detail,
                        selectable,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Tham số thao tác gỡ cho các định danh đã chọn; `None` khi chưa chọn gì.
pub fn apply_params(spec: &PickerSpec, selected: &[String]) -> Option<Value> {
    (!selected.is_empty()).then(|| json!({ spec.apply_field: selected }))
}

impl PickerSpec {
    pub fn title_key(&self) -> String {
        format!("picker.{}.title", self.id)
    }
}

// ---------------------------------------------------------------------------
// Giao diện
// ---------------------------------------------------------------------------

struct Entry {
    row: PickerRow,
    checked: bool,
    focus: FocusHandle,
}

pub struct PickerDialog {
    spec: &'static PickerSpec,
    ctx: ProcessContext,
    /// `None` khi đang tải danh sách.
    entries: Option<Vec<Entry>>,
    all_focus: FocusHandle,
    none_focus: FocusHandle,
    return_to: FocusHandle,
    list: Runner,
    runner: Runner,
}

impl EventEmitter<ProcessEvent> for PickerDialog {}

impl ProcessView for PickerDialog {
    fn runner(&self) -> &Runner {
        &self.runner
    }

    fn runner_mut(&mut self) -> &mut Runner {
        &mut self.runner
    }

    fn context(&self) -> &ProcessContext {
        &self.ctx
    }
}

impl PickerDialog {
    pub fn new(
        spec: &'static PickerSpec,
        ctx: ProcessContext,
        return_to: FocusHandle,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut me = Self {
            spec,
            ctx,
            entries: None,
            all_focus: cx.focus_handle(),
            none_focus: cx.focus_handle(),
            return_to,
            list: Runner::default(),
            runner: Runner::default(),
        };
        me.load(cx);
        me
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        let spec = self.spec;
        let ctx = self.ctx.clone();
        spawn_job(
            self,
            cx,
            |me| &mut me.list,
            &ctx,
            spec.list_op,
            json!({}),
            move |me, outcome, cx| {
                match outcome {
                    Ok(JobOk { data, .. }) => {
                        let entries = parse_rows(spec, &data)
                            .into_iter()
                            .map(|row| Entry {
                                checked: false,
                                focus: cx.focus_handle(),
                                row,
                            })
                            .collect();
                        me.entries = Some(entries);
                    }
                    Err(JobFail::Cancelled) => me.entries = Some(Vec::new()),
                    Err(JobFail::Failed(message)) => {
                        me.entries = Some(Vec::new());
                        me.runner.result =
                            Some(TaskResult::error(t(&spec.title_key())).detail(message));
                    }
                }
                cx.notify();
            },
        );
    }

    fn selected(&self) -> Vec<String> {
        self.entries
            .as_ref()
            .map(|e| {
                e.iter()
                    .filter(|e| e.checked && e.row.selectable)
                    .map(|e| e.row.id.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    fn set_all(&mut self, checked: bool, cx: &mut Context<Self>) {
        if let Some(entries) = self.entries.as_mut() {
            for entry in entries.iter_mut().filter(|e| e.row.selectable) {
                entry.checked = checked;
            }
        }
        cx.notify();
    }

    fn run(&mut self, cx: &mut Context<Self>) {
        if let Some(params) = apply_params(self.spec, &self.selected()) {
            cx.emit(ProcessEvent::ApplyRevision {
                op_id: self.spec.apply_op,
                params,
            });
        }
    }
}

impl Render for PickerDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let dark = self.ctx.dark;
        let colors = Colors::of(dark);
        let entity = cx.entity();
        let spec = self.spec;
        let selected = self.selected();
        let hint = |text: String| {
            div()
                .text_size(px(chef_theme::shared::TEXT_SM))
                .text_color(rgba(colors.muted))
                .child(text)
        };
        let mut list = div().flex().flex_col().gap(px(6.));
        let mut order: Vec<FocusHandle> = Vec::new();
        match &self.entries {
            None => list = list.child(hint(t("picker.loading"))),
            Some(entries) if entries.is_empty() => {
                list = list.child(hint(t(&format!("picker.{}.empty", spec.id))))
            }
            Some(entries) => {
                let (all_e, none_e) = (entity.clone(), entity.clone());
                order.extend([self.all_focus.clone(), self.none_focus.clone()]);
                list = list.child(
                    div()
                        .flex()
                        .gap(px(8.))
                        .child(
                            Button::new("picker-all", self.all_focus.clone())
                                .label(t("picker.selectAll"))
                                .size(Size::Sm)
                                .dark(dark)
                                .on_click(move |_, _, cx| {
                                    all_e.update(cx, |me, cx| me.set_all(true, cx));
                                }),
                        )
                        .child(
                            Button::new("picker-none", self.none_focus.clone())
                                .label(t("picker.selectNone"))
                                .size(Size::Sm)
                                .dark(dark)
                                .on_click(move |_, _, cx| {
                                    none_e.update(cx, |me, cx| me.set_all(false, cx));
                                }),
                        ),
                );
                for (index, entry) in entries.iter().enumerate() {
                    let toggle_e = entity.clone();
                    order.push(entry.focus.clone());
                    list = list.child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(8.))
                            .child(
                                Checkbox::new(
                                    ("picker-row", index as u64),
                                    entry.focus.clone(),
                                    entry.row.label.clone(),
                                    if entry.checked {
                                        CheckState::Checked
                                    } else {
                                        CheckState::Unchecked
                                    },
                                )
                                .disabled(!entry.row.selectable)
                                .dark(dark)
                                .on_change(move |next, _, cx| {
                                    let on = *next == CheckState::Checked;
                                    toggle_e.update(cx, |me, cx| {
                                        if let Some(e) =
                                            me.entries.as_mut().and_then(|v| v.get_mut(index))
                                        {
                                            e.checked = on;
                                        }
                                        cx.notify();
                                    });
                                }),
                            )
                            .children(entry.row.detail.clone().map(hint)),
                    );
                }
            }
        }
        let dialog = TaskDialog::new(format!("picker-{}", spec.id), t(&spec.title_key()), dark)
            .icon(spec.icon)
            .description(t_with(
                &format!("picker.{}.description", spec.id),
                &[("name", &self.ctx.file_name)],
            ))
            .size(Width::Md)
            .return_focus(self.return_to.clone())
            .child(list)
            .run_label(t_with(
                &format!("picker.{}.run", spec.id),
                &[("count", &selected.len().to_string())],
            ))
            .can_run(!selected.is_empty())
            .tab_order(order);
        wire(dialog, &entity, cx, Self::run)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn samples() -> Value {
        serde_json::from_str(include_str!("../testdata/list_results.json")).unwrap()
    }

    fn spec(id: &str) -> &'static PickerSpec {
        PICKERS.iter().find(|s| s.id == id).unwrap()
    }

    #[test]
    fn reads_attachment_rows_from_the_real_core_output() {
        let rows = parse_rows(spec("attachments"), &samples()["attachments"]);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "ghi-chu.txt");
        assert!(rows[0].selectable);
        assert!(rows[0].detail.is_some());
    }

    #[test]
    fn reads_overlay_and_watermark_rows() {
        let overlays = parse_rows(spec("overlays"), &samples()["overlays"]);
        assert_eq!(overlays.len(), 2);
        assert!(overlays[0].label.starts_with("watermark: "));
        assert_eq!(overlays[0].id.len(), 32);
        let marks = parse_rows(spec("watermarks"), &samples()["watermarks"]);
        assert_eq!(marks.len(), 3);
        // Watermark do Chef PDF thêm có độ tin cậy 100%; hai mục còn lại là ứng viên đoán.
        assert!(
            marks[0]
                .detail
                .as_deref()
                .is_some_and(|d| d.contains("100%"))
        );
        assert!(
            marks[1]
                .detail
                .as_deref()
                .is_some_and(|d| d.contains("40%"))
        );
    }

    #[test]
    fn only_fixable_non_empty_categories_are_selectable() {
        let rows = parse_rows(spec("hidden"), &samples()["hidden"]);
        assert!(rows.len() >= 10);
        let embedded = rows.iter().find(|r| r.id == "embeddedFiles").unwrap();
        assert!(embedded.selectable, "có file nhúng và gỡ được");
        let metadata = rows.iter().find(|r| r.id == "metadata").unwrap();
        assert!(!metadata.selectable, "không có gì để gỡ");
        let hidden_text = rows.iter().find(|r| r.id == "hiddenText").unwrap();
        assert!(!hidden_text.selectable, "chỉ báo cáo");
    }

    #[test]
    fn builds_the_removal_params_per_dialog() {
        let ids = vec!["a".to_string(), "b".to_string()];
        assert_eq!(
            apply_params(spec("attachments"), &ids).unwrap(),
            json!({"names": ["a", "b"]})
        );
        assert_eq!(
            apply_params(spec("overlays"), &ids).unwrap(),
            json!({"ids": ["a", "b"]})
        );
        assert_eq!(
            apply_params(spec("watermarks"), &ids).unwrap(),
            json!({"candidateIds": ["a", "b"]})
        );
        assert_eq!(
            apply_params(spec("hidden"), &ids).unwrap(),
            json!({"categories": ["a", "b"]})
        );
        assert!(apply_params(spec("hidden"), &[]).is_none());
    }

    /// `testdata/picker_params.json`: thao tác liệt kê và gỡ của từng hộp thoại, cho
    /// `core/tests/test_native_picker.py` chạy vòng liệt kê → chọn → gỡ trên lõi thật.
    #[test]
    fn picker_contract_matches_the_golden_file() {
        let built: serde_json::Map<String, Value> = PICKERS
            .iter()
            .map(|s| {
                (
                    s.id.to_string(),
                    json!({
                        "listOp": s.list_op,
                        "rowsPointer": s.rows_pointer,
                        "idField": s.id_field,
                        "applyOp": s.apply_op,
                        "applyField": s.apply_field,
                    }),
                )
            })
            .collect();
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/testdata/picker_params.json");
        if std::env::var("CHEF_UPDATE_GOLDEN").as_deref() == Ok("1") {
            let text = serde_json::to_string_pretty(&Value::Object(built)).unwrap() + "\n";
            std::fs::write(path, text).unwrap();
            return;
        }
        let golden: Value =
            serde_json::from_str(include_str!("../testdata/picker_params.json")).unwrap();
        assert_eq!(Value::Object(built), golden);
    }

    #[test]
    fn every_picker_has_text_in_both_languages() {
        for lang in [chef_ui::i18n::Lang::Vi, chef_ui::i18n::Lang::En] {
            let catalog = chef_ui::i18n::catalog(lang);
            for spec in PICKERS {
                for key in ["title", "description", "run", "empty"] {
                    let full = format!("picker.{}.{key}", spec.id);
                    assert!(catalog.contains_key(&full), "{lang:?}: thiếu {full}");
                }
            }
            for key in ["picker.loading", "picker.selectAll", "picker.selectNone"] {
                assert!(catalog.contains_key(key), "{lang:?}: thiếu {key}");
            }
        }
    }
}
