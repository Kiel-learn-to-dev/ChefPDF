//! Hộp thoại Ghép file (TASKS_RUST R5.03, FEATURES C4): chọn nhiều PDF, sắp thứ tự bằng nút mũi tên,
//! tùy chọn bookmark theo tên file, chạy `file.merge` qua lõi và báo kết quả.
//!
//! `MergePanel` là một thực thể của cửa sổ (như `SettingsPanel`), nên mở được từ màn hình Start và từ
//! bảng lệnh. Logic danh sách và tham số nằm ở `merge.rs` (có test); file này chỉ là giao diện và việc
//! chạy job. File nguồn không bị đổi: lõi chỉ đọc chúng, `merge::MergeList::params` chặn đường ra
//! trùng nguồn. Chưa có kéo thả để sắp thứ tự (dùng nút mũi tên), chưa nhập mật khẩu từng file.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use gpui::{App, Context, Entity, FocusHandle, SharedString, Window, div, prelude::*, px, rgba};

use chef_rpc::Supervisor;
use chef_ui::button::{Button, Size, Variant};
use chef_ui::form::{CheckState, Checkbox};
use chef_ui::i18n::{t, t_with};
use chef_ui::task_dialog::{TaskDialog, TaskResult, display_basename};

use crate::job_runner::Outcome;
use crate::merge::{MergeList, MergeReject};

/// Ba nút của một dòng: lên, xuống, bỏ.
struct RowHandles {
    up: FocusHandle,
    down: FocusHandle,
    remove: FocusHandle,
}

pub struct MergePanel {
    supervisor: Option<Arc<Mutex<Supervisor>>>,
    open: bool,
    list: MergeList,
    bookmarks: bool,
    running: bool,
    confirm_cancel: bool,
    result: Option<TaskResult>,
    /// Thư mục mở sẵn của hộp thoại chọn file và lưu file.
    initial_dir: Option<PathBuf>,
    /// Mã job đang chạy, để dừng khi người dùng xác nhận.
    job_id: Arc<Mutex<Option<String>>>,
    add_focus: FocusHandle,
    bookmarks_focus: FocusHandle,
    rows: Vec<RowHandles>,
    return_to: Option<FocusHandle>,
}

impl MergePanel {
    pub fn new(supervisor: Option<Arc<Mutex<Supervisor>>>, cx: &mut Context<Self>) -> Self {
        Self {
            supervisor,
            open: false,
            list: MergeList::default(),
            bookmarks: false,
            running: false,
            confirm_cancel: false,
            result: None,
            initial_dir: None,
            job_id: Arc::new(Mutex::new(None)),
            add_focus: cx.focus_handle(),
            bookmarks_focus: cx.focus_handle(),
            rows: Vec::new(),
            return_to: None,
        }
    }

    /// Mở hộp thoại. `initial_dir` là thư mục mặc định cho hộp thoại chọn và lưu file. `seed` là file
    /// đang mở (nếu có) được thêm sẵn làm file đầu tiên.
    pub fn open(
        &mut self,
        initial_dir: Option<PathBuf>,
        seed: Option<PathBuf>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.open {
            return;
        }
        self.list = MergeList::default();
        if let Some(path) = seed {
            self.list.add([path]);
        }
        self.sync_rows(cx);
        self.bookmarks = false;
        self.result = None;
        self.running = false;
        self.confirm_cancel = false;
        self.initial_dir = initial_dir;
        self.return_to = window.focused(cx);
        self.open = true;
        window.focus(&self.add_focus, cx);
        cx.notify();
    }

    pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open = false;
        self.confirm_cancel = false;
        if let Some(focus) = self.return_to.take() {
            window.focus(&focus, cx);
        }
        cx.notify();
    }

    /// Giữ số bộ nút khớp với số dòng.
    fn sync_rows(&mut self, cx: &mut Context<Self>) {
        while self.rows.len() < self.list.len() {
            self.rows.push(RowHandles {
                up: cx.focus_handle(),
                down: cx.focus_handle(),
                remove: cx.focus_handle(),
            });
        }
        self.rows.truncate(self.list.len());
    }

    fn add_files(&mut self, cx: &mut Context<Self>) {
        if self.running {
            return;
        }
        let picked = crate::dialogs::open_pdfs(self.initial_dir.as_deref());
        if picked.is_empty() {
            return;
        }
        self.list.add(picked);
        self.result = None;
        self.sync_rows(cx);
        cx.notify();
    }

    fn remove(&mut self, index: usize, cx: &mut Context<Self>) {
        if !self.running && self.list.remove(index) {
            self.result = None;
            self.sync_rows(cx);
            cx.notify();
        }
    }

    fn move_by(&mut self, index: usize, down: bool, cx: &mut Context<Self>) {
        if self.running {
            return;
        }
        let moved = if down {
            self.list.move_down(index)
        } else {
            self.list.move_up(index)
        };
        if moved {
            self.result = None;
            cx.notify();
        }
    }

    fn set_bookmarks(&mut self, on: bool, cx: &mut Context<Self>) {
        self.bookmarks = on;
        cx.notify();
    }

    /// Hỏi nơi lưu rồi chạy `file.merge` ở luồng nền; kết quả về qua kênh và được đọc định kỳ.
    fn run(&mut self, cx: &mut Context<Self>) {
        if self.running || self.list.len() < 2 {
            return;
        }
        let Some(supervisor) = self.supervisor.clone() else {
            self.result = Some(TaskResult::error(t("editor.coreUnavailable")));
            cx.notify();
            return;
        };
        let suggested = self.list.suggested_output_name(&t("merge.suffix"));
        let Some(output) = crate::dialogs::save_pdf(self.initial_dir.as_deref(), &suggested) else {
            return;
        };
        let params = match self.list.params(&output, self.bookmarks) {
            Ok(p) => serde_json::to_value(&p).unwrap_or(serde_json::Value::Null),
            Err(reject) => {
                self.result = Some(TaskResult::error(t(reject_key(reject))));
                cx.notify();
                return;
            }
        };
        self.running = true;
        self.confirm_cancel = false;
        self.result = None;
        cx.notify();
        crate::job_runner::spawn_job(
            supervisor,
            "file.merge".into(),
            params,
            self.job_id.clone(),
            cx,
            move |panel: &mut MergePanel, outcome, cx| panel.finish(outcome, &output, cx),
        );
    }

    fn finish(&mut self, outcome: Outcome, output: &Path, cx: &mut Context<Self>) {
        self.running = false;
        self.confirm_cancel = false;
        if let Ok(mut id) = self.job_id.lock() {
            *id = None;
        }
        self.result = Some(match outcome {
            Outcome::Done(_) => {
                let name = output
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                TaskResult::success(t("merge.doneTitle"))
                    .detail(t_with("merge.doneText", &[("name", &name)]))
            }
            Outcome::Cancelled => TaskResult::cancelled(t("editor.operationFailed")),
            Outcome::Failed(message) => TaskResult::error(t("merge.failed")).detail(message),
        });
        cx.notify();
    }

    /// Dừng job đang chạy (hợp tác): kết quả `Cancelled` về qua kênh như bình thường.
    fn cancel_job(&mut self) {
        crate::job_runner::cancel(&self.supervisor, &self.job_id);
    }
}

fn reject_key(reject: MergeReject) -> &'static str {
    match reject {
        MergeReject::TooFew => "merge.needTwo",
        MergeReject::OutputIsSource => "pages.extractOutputSameFile",
        MergeReject::BadOutput => "merge.failed",
    }
}

/// Dựng hộp thoại nếu đang mở. Mọi thay đổi đi qua `panel`.
pub fn build(panel: &Entity<MergePanel>, dark: bool, cx: &mut App) -> Option<TaskDialog> {
    let state = panel.read(cx);
    if !state.open {
        return None;
    }
    let count = state.list.len();
    let muted = if dark {
        chef_theme::dark::C_TEXT_2
    } else {
        chef_theme::light::C_TEXT_2
    };

    let mut rows = div().flex().flex_col().gap(px(6.0)).w_full();
    if count == 0 {
        rows = rows.child(
            div()
                .flex()
                .flex_col()
                .gap(px(4.0))
                .py(px(16.0))
                .child(
                    div()
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .child(t("merge.emptyTitle")),
                )
                .child(
                    div()
                        .text_color(rgba(chef_ui::button::pack(muted)))
                        .child(t("merge.emptyText")),
                ),
        );
    }
    for (index, entry) in state.list.entries().iter().enumerate() {
        let handles = &state.rows[index];
        let name = display_basename(&entry.path.display().to_string()).to_string();
        let (up, down, remove) = (panel.clone(), panel.clone(), panel.clone());
        let busy = state.running;
        rows = rows.child(
            div()
                .id(SharedString::from(format!("merge-row-{index}")))
                .flex()
                .items_center()
                .gap(px(8.0))
                .w_full()
                .child(
                    div()
                        .w(px(24.0))
                        .text_color(rgba(chef_ui::button::pack(muted)))
                        .child(format!("{}.", index + 1)),
                )
                .child(div().flex_1().overflow_hidden().child(name))
                .child(
                    Button::new(
                        SharedString::from(format!("merge-up-{index}")),
                        handles.up.clone(),
                    )
                    .icon("icons/arrow-up.svg")
                    .size(Size::Sm)
                    .variant(Variant::Ghost)
                    .dark(dark)
                    .disabled(busy || index == 0)
                    .on_click(move |_, _, cx| up.update(cx, |p, cx| p.move_by(index, false, cx))),
                )
                .child(
                    Button::new(
                        SharedString::from(format!("merge-down-{index}")),
                        handles.down.clone(),
                    )
                    .icon("icons/arrow-down.svg")
                    .size(Size::Sm)
                    .variant(Variant::Ghost)
                    .dark(dark)
                    .disabled(busy || index + 1 == count)
                    .on_click(move |_, _, cx| down.update(cx, |p, cx| p.move_by(index, true, cx))),
                )
                .child(
                    Button::new(
                        SharedString::from(format!("merge-remove-{index}")),
                        handles.remove.clone(),
                    )
                    .icon("icons/x.svg")
                    .size(Size::Sm)
                    .variant(Variant::Ghost)
                    .dark(dark)
                    .disabled(busy)
                    .on_click(move |_, _, cx| remove.update(cx, |p, cx| p.remove(index, cx))),
                ),
        );
    }

    let add = panel.clone();
    let bookmarks = panel.clone();
    let body = div()
        .flex()
        .flex_col()
        .gap(px(12.0))
        .child(
            div()
                .flex()
                .items_center()
                .justify_between()
                .child(
                    div()
                        .font_weight(gpui::FontWeight::MEDIUM)
                        .child(t_with("merge.files", &[("count", &count.to_string())])),
                )
                .child(
                    Button::new("merge-add", state.add_focus.clone())
                        .icon("icons/file-plus.svg")
                        .label(t("merge.addFiles"))
                        .size(Size::Sm)
                        .variant(Variant::Secondary)
                        .dark(dark)
                        .disabled(state.running)
                        .on_click(move |_, _, cx| add.update(cx, |p, cx| p.add_files(cx))),
                ),
        )
        .child(rows)
        .child(
            Checkbox::new(
                "merge-bookmarks",
                state.bookmarks_focus.clone(),
                t("merge.bookmarks"),
                if state.bookmarks {
                    CheckState::Checked
                } else {
                    CheckState::Unchecked
                },
            )
            .dark(dark)
            .disabled(state.running)
            .on_change(move |next, _, cx| {
                let on = *next == CheckState::Checked;
                bookmarks.update(cx, |p, cx| p.set_bookmarks(on, cx));
            }),
        )
        .child(
            div()
                .text_size(px(chef_theme::shared::TEXT_SM))
                .text_color(rgba(chef_ui::button::pack(muted)))
                .child(t("merge.bookmarksHint")),
        );

    let (run, close, request, keep, confirm_stop, cancel_run) = (
        panel.clone(),
        panel.clone(),
        panel.clone(),
        panel.clone(),
        panel.clone(),
        panel.clone(),
    );
    let mut dialog = TaskDialog::new("merge-dialog", t("merge.title"), dark)
        .icon("icons/combine.svg")
        .description(t("merge.description"))
        .child(body)
        .run_label(t("merge.run"))
        .can_run(count >= 2 && !state.running)
        .running(state.running)
        .confirm_cancel_open(state.confirm_cancel)
        .tab_order(vec![state.add_focus.clone(), state.bookmarks_focus.clone()])
        .on_run(move |_, cx| run.update(cx, |p, cx| p.run(cx)))
        .on_close(move |window, cx| {
            // Đóng khi đang chạy thì hỏi xác nhận trước (khung xử lý qua `on_request_cancel_confirm`).
            close.update(cx, |p, cx| {
                if p.running {
                    p.confirm_cancel = true;
                    cx.notify();
                } else {
                    p.close(window, cx);
                }
            });
        })
        .on_request_cancel_confirm(move |_, cx| {
            request.update(cx, |p, cx| {
                p.confirm_cancel = true;
                cx.notify();
            })
        })
        .on_keep_running(move |_, cx| {
            keep.update(cx, |p, cx| {
                p.confirm_cancel = false;
                cx.notify();
            })
        })
        .on_confirm_cancel_close(move |window, cx| {
            confirm_stop.update(cx, |p, cx| {
                p.cancel_job();
                p.close(window, cx);
            })
        })
        .on_cancel_run(move |_, cx| cancel_run.update(cx, |p, _| p.cancel_job()));
    if count < 2 {
        dialog = dialog.warnings([t("merge.needTwo")]);
    }
    if let Some(result) = state.result.clone() {
        dialog = dialog.result(result);
    }
    Some(dialog)
}
