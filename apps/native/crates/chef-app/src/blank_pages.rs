//! Hộp thoại Xóa trang trắng (TASKS_RUST R5.06, FEATURES C8). Dò trang trắng bằng `page.findBlank`, hiện
//! danh sách để người dùng bỏ chọn trang muốn giữ, rồi mới xóa bằng `page.removeBlank` qua đường sửa
//! revision của viewer (có hoàn tác). Không có thao tác xóa nào chạy trước khi người dùng bấm xóa.
//!
//! Ngưỡng: lõi coi trang là trắng khi tỉ lệ mực ngoài viền không vượt ngưỡng suy từ "độ nhạy" (0 = chỉ
//! trang hoàn toàn trắng, 1 = chịu được vài chấm bẩn); viền `borderMm` quanh trang bị bỏ qua; trang có
//! chú thích được giữ khi bật "Giữ trang có chú thích". Danh sách hiện tỉ lệ mực từng trang để người dùng
//! tự quyết các trường hợp sát ngưỡng.

use chef_ui::button::{Button, Size};
use chef_ui::choice::Slider;
use chef_ui::dialog::Width;
use chef_ui::form::{CheckState, Checkbox, TextField};
use chef_ui::i18n::{t, t_with};
use chef_ui::task_dialog::{TaskDialog, TaskResult};
use chef_ui::text_input::TextInput;
use gpui::{
    App, Context, Entity, EventEmitter, FocusHandle, Focusable, IntoElement, Render, Subscription,
    Window, div, prelude::*, px, rgba,
};
use serde_json::{Value, json};

use crate::process::{
    Colors, JobFail, JobOk, ProcessContext, ProcessEvent, ProcessView, Runner, parse_decimal,
    spawn_job, text_entity, wire,
};

// ---------------------------------------------------------------------------
// Phần thuần
// ---------------------------------------------------------------------------

/// Thiết lập dò trang trắng.
#[derive(Debug, Clone, PartialEq)]
pub struct BlankInput {
    /// 0 đến 100 (%), đổi thành 0 đến 1 khi gửi cho lõi.
    pub sensitivity_percent: f32,
    pub keep_annotations: bool,
    pub border_mm: String,
}

impl Default for BlankInput {
    fn default() -> Self {
        Self {
            sensitivity_percent: 50.0,
            keep_annotations: true,
            border_mm: "5".into(),
        }
    }
}

/// Viền bị bỏ qua, mm (lõi nhận 0 đến 50).
const BORDER_MAX_MM: f64 = 50.0;

fn common(input: &BlankInput) -> Option<serde_json::Map<String, Value>> {
    let border = parse_decimal(&input.border_mm).filter(|b| (0.0..=BORDER_MAX_MM).contains(b))?;
    let mut map = serde_json::Map::new();
    map.insert(
        "sensitivity".into(),
        json!(
            (f64::from(input.sensitivity_percent.clamp(0.0, 100.0)) / 100.0 * 1000.0).round()
                / 1000.0
        ),
    );
    map.insert("borderMm".into(), json!(border));
    map.insert("keepIfAnnotations".into(), json!(input.keep_annotations));
    Some(map)
}

/// Tham số `page.findBlank` cho cả tài liệu.
pub fn find_params(input: &BlankInput) -> Option<Value> {
    common(input).map(Value::Object)
}

/// Tham số `page.removeBlank` chỉ cho các trang người dùng đã chọn (chỉ số từ 0).
pub fn remove_params(input: &BlankInput, selected: &[usize]) -> Option<Value> {
    if selected.is_empty() {
        return None;
    }
    let mut map = common(input)?;
    let mut pages = selected.to_vec();
    pages.sort_unstable();
    pages.dedup();
    map.insert("pages".into(), json!(pages));
    Some(Value::Object(map))
}

/// Một trang trong kết quả dò.
#[derive(Debug, Clone, PartialEq)]
pub struct BlankRow {
    pub index: usize,
    pub ink_ratio: f64,
    pub has_text: bool,
    pub has_annotations: bool,
    pub blank: bool,
}

/// Đọc `data.pages` của `page.findBlank`; bỏ qua dòng hỏng.
pub fn parse_find_result(data: &Value) -> Vec<BlankRow> {
    data.get("pages")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    Some(BlankRow {
                        index: usize::try_from(row.get("index")?.as_u64()?).ok()?,
                        ink_ratio: row.get("inkRatio").and_then(Value::as_f64).unwrap_or(0.0),
                        has_text: row.get("hasText").and_then(Value::as_bool).unwrap_or(false),
                        has_annotations: row
                            .get("hasAnnotations")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                        blank: row.get("blank").and_then(Value::as_bool).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Trang hiện trong danh sách: chỉ các trang được coi là trắng (ứng viên xóa).
pub fn candidates(rows: &[BlankRow]) -> Vec<BlankRow> {
    rows.iter().filter(|r| r.blank).cloned().collect()
}

/// Có xóa được số trang đã chọn không: ít nhất một, và không phải toàn bộ tài liệu.
pub fn can_remove(selected: usize, page_count: usize) -> bool {
    selected >= 1 && selected < page_count
}

/// "mực 0,3%" từ tỉ lệ 0 đến 1.
pub fn ink_label(ratio: f64) -> String {
    let percent = (ratio * 100.0 * 100.0).round() / 100.0;
    t_with(
        "pageTools.blank.ink",
        &[("percent", &format!("{percent}").replace('.', ","))],
    )
}

// ---------------------------------------------------------------------------
// Giao diện
// ---------------------------------------------------------------------------

struct Candidate {
    row: BlankRow,
    checked: bool,
    focus: FocusHandle,
}

pub struct BlankDialog {
    ctx: ProcessContext,
    input: BlankInput,
    border: Entity<TextInput>,
    slider_focus: FocusHandle,
    keep_focus: FocusHandle,
    rescan_focus: FocusHandle,
    return_to: FocusHandle,
    /// `None` khi chưa dò xong; `Some` là danh sách ứng viên.
    found: Option<Vec<Candidate>>,
    /// Kết quả (hoặc lỗi) của lần dò gần nhất.
    detect: Runner,
    runner: Runner,
    _subs: Vec<Subscription>,
}

impl EventEmitter<ProcessEvent> for BlankDialog {}

impl ProcessView for BlankDialog {
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

impl BlankDialog {
    pub fn new(ctx: ProcessContext, return_to: FocusHandle, cx: &mut Context<Self>) -> Self {
        let mut subs = Vec::new();
        let border = text_entity(cx, &mut subs, "5", "");
        let mut me = Self {
            ctx,
            input: BlankInput::default(),
            border,
            slider_focus: cx.focus_handle(),
            keep_focus: cx.focus_handle(),
            rescan_focus: cx.focus_handle(),
            return_to,
            found: None,
            detect: Runner::default(),
            runner: Runner::default(),
            _subs: subs,
        };
        me.detect(cx);
        me
    }

    fn current_input(&self, cx: &App) -> BlankInput {
        BlankInput {
            border_mm: self.border.read(cx).text().to_string(),
            ..self.input.clone()
        }
    }

    /// Dò lại. Bỏ danh sách cũ để không xóa nhầm theo thiết lập cũ.
    fn detect(&mut self, cx: &mut Context<Self>) {
        let Some(params) = find_params(&self.current_input(cx)) else {
            self.runner.result = Some(TaskResult::error(t("pageTools.issue.border")));
            cx.notify();
            return;
        };
        self.found = None;
        self.runner.result = None;
        let ctx = self.ctx.clone();
        spawn_job(
            self,
            cx,
            |me| &mut me.detect,
            &ctx,
            "page.findBlank",
            params,
            |me, outcome, cx| {
                match outcome {
                    Ok(JobOk { data, .. }) => {
                        let rows = candidates(&parse_find_result(&data));
                        let found = rows
                            .into_iter()
                            .map(|row| Candidate {
                                row,
                                checked: true,
                                focus: cx.focus_handle(),
                            })
                            .collect();
                        me.found = Some(found);
                    }
                    Err(JobFail::Cancelled) => me.found = Some(Vec::new()),
                    Err(JobFail::Failed(message)) => {
                        me.found = Some(Vec::new());
                        me.runner.result =
                            Some(TaskResult::error(t("pageTools.blank.detecting")).detail(message));
                    }
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    fn selected(&self) -> Vec<usize> {
        self.found
            .as_ref()
            .map(|f| {
                f.iter()
                    .filter(|c| c.checked)
                    .map(|c| c.row.index)
                    .collect()
            })
            .unwrap_or_default()
    }

    fn run(&mut self, cx: &mut Context<Self>) {
        let selected = self.selected();
        if !can_remove(selected.len(), self.ctx.page_count) {
            return;
        }
        match remove_params(&self.current_input(cx), &selected) {
            Some(params) => cx.emit(ProcessEvent::ApplyRevision {
                op_id: "page.removeBlank",
                params,
            }),
            None => {
                self.runner.result = Some(TaskResult::error(t("pageTools.issue.border")));
                cx.notify();
            }
        }
    }
}

impl Render for BlankDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let dark = self.ctx.dark;
        let colors = Colors::of(dark);
        let entity = cx.entity();
        let detecting = self.detect.running;
        let selected = self.selected();
        let label = |text: String| {
            div()
                .text_size(px(chef_theme::shared::TEXT_MD))
                .text_color(rgba(colors.text))
                .child(text)
        };
        let hint = |text: String| {
            div()
                .text_size(px(chef_theme::shared::TEXT_SM))
                .text_color(rgba(colors.muted))
                .child(text)
        };

        let slider_e = entity.clone();
        let keep_e = entity.clone();
        let rescan_e = entity.clone();
        let controls = div()
            .flex()
            .flex_col()
            .gap(px(10.))
            .child(label(format!(
                "{}: {}%",
                t("pageTools.blank.sensitivity"),
                self.input.sensitivity_percent.round()
            )))
            .child(
                Slider::new(
                    "blank-sensitivity",
                    t("pageTools.blank.sensitivity"),
                    self.slider_focus.clone(),
                    self.input.sensitivity_percent,
                )
                .range(0.0, 100.0, 5.0)
                .width(280.0)
                .dark(dark)
                .on_change(move |value, _, cx| {
                    slider_e.update(cx, |me, cx| {
                        me.input.sensitivity_percent = value;
                        cx.notify();
                    });
                }),
            )
            .child(
                Checkbox::new(
                    "blank-keep-annotations",
                    self.keep_focus.clone(),
                    t("pageTools.blank.keepAnnotations"),
                    if self.input.keep_annotations {
                        CheckState::Checked
                    } else {
                        CheckState::Unchecked
                    },
                )
                .dark(dark)
                .on_change(move |next, _, cx| {
                    let on = *next == CheckState::Checked;
                    keep_e.update(cx, |me, cx| {
                        me.input.keep_annotations = on;
                        cx.notify();
                    });
                }),
            )
            .child(hint(t("pageTools.blank.keepAnnotationsHint")))
            .child(
                TextField::new(
                    "blank-border",
                    t("pageTools.blank.border"),
                    self.border.clone(),
                )
                .dark(dark),
            )
            .child(
                Button::new("blank-rescan", self.rescan_focus.clone())
                    .label(t("pageTools.blank.rescan"))
                    .size(Size::Sm)
                    .dark(dark)
                    .loading(detecting)
                    .on_click(move |_, _, cx| {
                        rescan_e.update(cx, |me, cx| me.detect(cx));
                    }),
            );

        let mut list = div()
            .flex()
            .flex_col()
            .gap(px(4.))
            .child(label(t("pageTools.blank.list")));
        match &self.found {
            None => list = list.child(hint(t("pageTools.blank.detecting"))),
            Some(found) if found.is_empty() => list = list.child(hint(t("pageTools.blank.none"))),
            Some(found) => {
                list = list.child(hint(t("pageTools.blank.explain")));
                for (i, candidate) in found.iter().enumerate() {
                    let toggle_e = entity.clone();
                    let mut notes = vec![ink_label(candidate.row.ink_ratio)];
                    if candidate.row.has_text {
                        notes.push(t("pageTools.blank.flagText"));
                    }
                    if candidate.row.has_annotations {
                        notes.push(t("pageTools.blank.flagAnnotations"));
                    }
                    list = list.child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(8.))
                            .child(
                                Checkbox::new(
                                    ("blank-page", candidate.row.index as u64),
                                    candidate.focus.clone(),
                                    t_with(
                                        "pageTools.pageN",
                                        &[("page", &(candidate.row.index + 1).to_string())],
                                    ),
                                    if candidate.checked {
                                        CheckState::Checked
                                    } else {
                                        CheckState::Unchecked
                                    },
                                )
                                .dark(dark)
                                .on_change(move |next, _, cx| {
                                    let on = *next == CheckState::Checked;
                                    toggle_e.update(cx, |me, cx| {
                                        if let Some(c) =
                                            me.found.as_mut().and_then(|f| f.get_mut(i))
                                        {
                                            c.checked = on;
                                        }
                                        cx.notify();
                                    });
                                }),
                            )
                            .child(
                                div()
                                    .text_size(px(chef_theme::shared::TEXT_SM))
                                    .text_color(rgba(colors.muted))
                                    .child(notes.join(" · ")),
                            ),
                    );
                }
            }
        }

        let mut warnings = Vec::new();
        if !selected.is_empty() && selected.len() >= self.ctx.page_count {
            warnings.push(t("pageTools.issue.pages"));
        }
        let mut order = vec![
            self.slider_focus.clone(),
            self.keep_focus.clone(),
            self.border.read(cx).focus_handle(cx),
            self.rescan_focus.clone(),
        ];
        if let Some(found) = &self.found {
            order.extend(found.iter().map(|c| c.focus.clone()));
        }
        let dialog = TaskDialog::new("blank-dialog", t("pageTools.blank.title"), dark)
            .icon("icons/eraser.svg")
            .description(t_with(
                "pageTools.blank.description",
                &[("name", &self.ctx.file_name)],
            ))
            .size(Width::Lg)
            .return_focus(self.return_to.clone())
            .child(controls)
            .child(list)
            .warnings(warnings)
            .run_label(t_with(
                "pageTools.blank.run",
                &[("count", &selected.len().to_string())],
            ))
            .can_run(can_remove(selected.len(), self.ctx.page_count) && !detecting)
            .tab_order(order);
        wire(dialog, &entity, cx, Self::run)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_find_and_remove_params_with_fractional_sensitivity() {
        let input = BlankInput::default();
        assert_eq!(
            find_params(&input).unwrap(),
            json!({"sensitivity":0.5,"borderMm":5.0,"keepIfAnnotations":true})
        );
        let remove = remove_params(&input, &[4, 2, 4]).unwrap();
        assert_eq!(remove["pages"], json!([2, 4]));
        assert_eq!(remove["sensitivity"], 0.5);
        assert!(remove_params(&input, &[]).is_none());
    }

    #[test]
    fn rejects_a_border_outside_the_core_range() {
        let mut input = BlankInput {
            border_mm: "51".into(),
            ..BlankInput::default()
        };
        assert!(find_params(&input).is_none());
        input.border_mm = "x".into();
        assert!(find_params(&input).is_none());
        input.border_mm = "2,5".into();
        assert_eq!(find_params(&input).unwrap()["borderMm"], 2.5);
    }

    #[test]
    fn reads_the_find_result_and_lists_only_blank_candidates() {
        let data = json!({
            "pages": [
                {"index": 0, "inkRatio": 0.2, "hasText": true, "hasAnnotations": false, "blank": false},
                {"index": 1, "inkRatio": 0.0, "hasText": false, "hasAnnotations": false, "blank": true},
                {"index": 2, "inkRatio": 0.0004, "hasText": false, "hasAnnotations": true, "blank": true},
                {"bad": 1}
            ],
            "candidates": [1, 2]
        });
        let rows = parse_find_result(&data);
        assert_eq!(rows.len(), 3);
        let found = candidates(&rows);
        assert_eq!(found.iter().map(|r| r.index).collect::<Vec<_>>(), [1, 2]);
        assert!(found[1].has_annotations);
        assert!(parse_find_result(&Value::Null).is_empty());
    }

    #[test]
    fn never_allows_deleting_every_page_or_nothing() {
        assert!(!can_remove(0, 5));
        assert!(can_remove(1, 5));
        assert!(can_remove(4, 5));
        assert!(!can_remove(5, 5));
    }
}
