//! Hộp thoại Chia đôi trang và lưới N phần (TASKS_RUST R5.07, FEATURES C9). Form do `SchemaForm` sinh
//! từ `PageSplitParams` (nhóm "S" của DIALOG_CLASSIFICATION_RUST): hàng, cột, chồng lấn, thứ tự, trang.
//! Chạy `page.split` qua đường sửa revision của viewer; mỗi phần là một trang có CropBox riêng, nên có
//! hoàn tác. Trang A3 hoặc trang đôi thành hai trang A4 là trường hợp 1 hàng × 2 cột (mặc định).

use chef_ui::dialog::Width;
use chef_ui::i18n::{t, t_with};
use chef_ui::schema_form::{FormSchema, SchemaForm, SchemaFormEvent};
use chef_ui::task_dialog::{TaskDialog, TaskResult};
use gpui::{
    AppContext as _, Context, Entity, EventEmitter, FocusHandle, IntoElement, Render, Subscription,
    Window, div, prelude::*, px,
};
use serde_json::{Value, json};

use crate::page_range::format_page_ranges;
use crate::process::{ProcessContext, ProcessEvent, ProcessView, Runner, wire};

// ---------------------------------------------------------------------------
// Phần thuần
// ---------------------------------------------------------------------------

/// Số trang kết quả khi chia `pages` trang thành `rows` × `cols` phần.
pub fn resulting_pages(page_count: usize, selected: usize, rows: u64, cols: u64) -> usize {
    let pieces = (rows.max(1) * cols.max(1)) as usize;
    page_count - selected + selected * pieces
}

/// Phải chia thành ít nhất hai phần (1 × 1 không làm gì).
pub fn is_noop(params: &Value) -> bool {
    let get = |key: &str, default: u64| params.get(key).and_then(Value::as_u64).unwrap_or(default);
    get("rows", 1) * get("cols", 2) < 2
}

/// Sửa tham số form trước khi gửi: bỏ `pages` rỗng, đặt mặc định mà form để trống.
pub fn finish_params(mut params: Value) -> Value {
    if let Some(map) = params.as_object_mut() {
        map.entry("rows").or_insert(json!(1));
        map.entry("cols").or_insert(json!(2));
        map.entry("overlapMm").or_insert(json!(0));
        map.entry("order").or_insert(json!("ltr"));
    }
    params
}

// ---------------------------------------------------------------------------
// Giao diện
// ---------------------------------------------------------------------------

pub struct GridSplitDialog {
    ctx: ProcessContext,
    form: Option<Entity<SchemaForm>>,
    return_to: FocusHandle,
    runner: Runner,
    _subs: Vec<Subscription>,
}

impl EventEmitter<ProcessEvent> for GridSplitDialog {}

impl ProcessView for GridSplitDialog {
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

impl GridSplitDialog {
    pub fn new(ctx: ProcessContext, return_to: FocusHandle, cx: &mut Context<Self>) -> Self {
        let root = chef_contracts::ops_schema();
        let dark = ctx.dark;
        // Schema đi kèm app và có test; nếu vẫn không đọc được thì hộp thoại không có trường (không chạy).
        let form = FormSchema::from_definition(&root, "PageSplitParams")
            .is_ok()
            .then(|| {
                cx.new(|cx| {
                    SchemaForm::new(&root, "PageSplitParams", dark, cx)
                        .unwrap_or_else(|_| unreachable!("đã kiểm schema ở trên"))
                })
            });
        let mut subs = Vec::new();
        if let Some(form) = &form {
            subs.push(cx.subscribe(form, |_, _, _: &SchemaFormEvent, cx| cx.notify()));
            let selected = (!ctx.target_pages.is_empty()
                && ctx.target_pages.len() < ctx.page_count)
                .then(|| format_page_ranges(&ctx.target_pages));
            form.update(cx, |form, cx| {
                form.set_text("rows", "1", cx);
                form.set_text("cols", "2", cx);
                form.set_text("overlapMm", "0", cx);
                if let Some(selected) = &selected {
                    form.set_text("pages", selected, cx);
                }
            });
        }
        Self {
            ctx,
            form,
            return_to,
            runner: Runner::default(),
            _subs: subs,
        }
    }

    fn current(&self, cx: &gpui::App) -> Option<Value> {
        self.form
            .as_ref()?
            .read(cx)
            .peek(cx)
            .ok()
            .map(finish_params)
    }

    fn run(&mut self, cx: &mut Context<Self>) {
        let Some(form) = self.form.clone() else {
            return;
        };
        let Some(params) = form.update(cx, |form, cx| form.validate(cx)) else {
            return;
        };
        let params = finish_params(params);
        if is_noop(&params) {
            self.runner.result = Some(TaskResult::error(t("pageTools.issue.pieces")));
            cx.notify();
            return;
        }
        cx.emit(ProcessEvent::ApplyRevision {
            op_id: "page.split",
            params,
        });
    }
}

impl Render for GridSplitDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let dark = self.ctx.dark;
        let entity = cx.entity();
        let current = self.current(cx);
        let can_run = current.as_ref().is_some_and(|p| !is_noop(p));
        let estimate = current.as_ref().map(|p| {
            let get = |k: &str| p.get(k).and_then(Value::as_u64).unwrap_or(1);
            let selected = p
                .get("pages")
                .and_then(Value::as_array)
                .map_or(self.ctx.page_count, Vec::len);
            t_with(
                "merge.pages",
                &[(
                    "count",
                    &resulting_pages(self.ctx.page_count, selected, get("rows"), get("cols"))
                        .to_string(),
                )],
            )
        });
        let mut dialog = TaskDialog::new("grid-split-dialog", t("pageTools.split.title"), dark)
            .icon("icons/columns-2.svg")
            .description(t_with(
                "pageTools.split.description",
                &[("name", &self.ctx.file_name)],
            ))
            .size(Width::Md)
            .return_focus(self.return_to.clone())
            .run_label(t("pageTools.split.run"))
            .can_run(can_run);
        if let Some(form) = &self.form {
            dialog = dialog.child(div().w_full().child(form.clone()));
        }
        if let Some(estimate) = estimate {
            dialog = dialog.estimate(
                div()
                    .text_size(px(chef_theme::shared::TEXT_SM))
                    .child(estimate),
            );
        }
        wire(dialog, &entity, cx, Self::run)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_pages_after_the_grid_split() {
        // 10 trang, chia 3 trang đã chọn thành 1 × 2: 7 + 6 = 13.
        assert_eq!(resulting_pages(10, 3, 1, 2), 13);
        assert_eq!(resulting_pages(4, 4, 2, 2), 16);
        assert_eq!(resulting_pages(5, 5, 1, 1), 5);
    }

    #[test]
    fn one_by_one_is_a_no_op_and_defaults_fill_the_gaps() {
        assert!(is_noop(&json!({"rows": 1, "cols": 1})));
        assert!(!is_noop(&json!({"rows": 1, "cols": 2})));
        assert!(!is_noop(&json!({"cols": 3})));
        let filled = finish_params(json!({"pages": [0, 2]}));
        assert_eq!(
            filled,
            json!({"pages": [0, 2], "rows": 1, "cols": 2, "overlapMm": 0, "order": "ltr"})
        );
        // Giá trị đã có không bị ghi đè.
        assert_eq!(finish_params(json!({"rows": 2}))["rows"], 2);
    }

    #[test]
    fn schema_builds_the_params_the_core_expects() {
        use chef_ui::schema_form::{FieldInput, FormSchema};
        let schema =
            FormSchema::from_definition(&chef_contracts::ops_schema(), "PageSplitParams").unwrap();
        let mut inputs = schema.initial_inputs();
        inputs.insert("pages".into(), FieldInput::Text("2-3".into()));
        inputs.insert("rows".into(), FieldInput::Text("2".into()));
        inputs.insert("cols".into(), FieldInput::Text("2".into()));
        inputs.insert("overlapMm".into(), FieldInput::Text("1,5".into()));
        let built = schema.build(&inputs).expect("hợp lệ");
        assert_eq!(built["pages"], json!([1, 2]));
        assert_eq!(built["rows"], 2);
        assert_eq!(built["cols"], 2);
        // Số thập phân kiểu vi được form nhận hay không, ghi lại thay vì giả định.
        assert!(built.get("overlapMm").is_some());
    }
}
