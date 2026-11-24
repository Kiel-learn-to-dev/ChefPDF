//! Hộp thoại Ghép file (TASKS_RUST R5.03, FEATURES C4): chọn nhiều PDF, sắp thứ tự, chọn trang từng file,
//! tùy chọn bookmark theo tên file. Chạy operation `file.merge` (standalone, không cần tài liệu đang mở).
//! Bản GPUI của `apps/ui/src/features/merge/MergeDialog.tsx`.
//!
//! Phần thuần (dựng tham số, kiểm tra, tổng số trang, đổi thứ tự) tách khỏi giao diện để test không cần
//! cửa sổ. Sắp thứ tự bằng nút Chuyển lên/xuống; kéo thả chưa làm (ghi ở TASKS_RUST R5.03).

use std::path::PathBuf;

use chef_ui::button::{Button, Size, Variant};
use chef_ui::dialog::Width;
use chef_ui::form::{CheckState, Checkbox};
use chef_ui::i18n::{t, t_with};
use chef_ui::task_dialog::{TaskDialog, TaskResult, display_basename};
use chef_ui::text_input::{TextInput, TextInputEvent};
use gpui::{
    Context, Entity, EventEmitter, FocusHandle, Focusable, IntoElement, Render, Subscription,
    Window, div, prelude::*, px, rgba,
};
use serde_json::{Value, json};

use crate::page_range::{RangeError, parse_page_ranges};
use crate::process::{
    Colors, ProbeError, ProbedPdf, ProcessContext, ProcessEvent, ProcessView, Runner, file_stem,
    format_bytes, parent_dir, probe_pdf, spawn_job, wire,
};

/// Số tệp hiện trong cột xem trước trước khi gộp "và N file khác".
const SUMMARY_ROWS: usize = 6;

// ---------------------------------------------------------------------------
// Phần thuần
// ---------------------------------------------------------------------------

/// Kết quả dò một tệp.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Probe {
    Pending,
    Ready(ProbedPdf),
    /// File có mật khẩu: chưa mở được. `wrong` là lần thử trước sai mật khẩu.
    Locked {
        wrong: bool,
    },
    /// Không đọc được; chuỗi đã dịch.
    Failed(String),
}

/// Một dòng của danh sách ghép, theo dạng thuần.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergeRow {
    pub path: String,
    pub probe: Probe,
    /// Khoảng trang người dùng nhập; rỗng là tất cả trang.
    pub range: String,
    /// Mật khẩu mở file, nếu đã nhập đúng.
    pub password: Option<String>,
}

/// Trang lấy từ một dòng.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowPages {
    /// Chưa dò xong hoặc dò lỗi, nên chưa biết số trang.
    Unknown,
    All(usize),
    Some(Vec<usize>),
    Invalid(RangeError),
}

impl RowPages {
    pub fn count(&self) -> Option<usize> {
        match self {
            RowPages::All(n) => Some(*n),
            RowPages::Some(pages) => Some(pages.len()),
            RowPages::Unknown | RowPages::Invalid(_) => None,
        }
    }
}

pub fn row_pages(row: &MergeRow) -> RowPages {
    let Probe::Ready(info) = &row.probe else {
        return RowPages::Unknown;
    };
    if row.range.trim().is_empty() {
        return RowPages::All(info.page_count);
    }
    match parse_page_ranges(&row.range, info.page_count) {
        Ok(parsed) => RowPages::Some(parsed.pages),
        Err(error) => RowPages::Invalid(error),
    }
}

/// Lý do không chạy được; có khóa i18n để hiện cho người dùng.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeIssue {
    NeedTwo,
    Loading,
    Unreadable,
    Locked,
    BadRange,
    OutputIsInput,
}

impl MergeIssue {
    pub fn i18n_key(self) -> &'static str {
        match self {
            MergeIssue::NeedTwo => "merge.needTwo",
            MergeIssue::Loading => "merge.loading",
            MergeIssue::Unreadable => "merge.unreadable",
            MergeIssue::Locked => "merge.locked",
            MergeIssue::BadRange => "range.syntax",
            MergeIssue::OutputIsInput => "merge.outputIsInput",
        }
    }
}

/// Tình trạng cả danh sách: tổng trang, tổng dung lượng, có chạy được không.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MergePlan {
    /// `None` khi còn dòng chưa biết số trang.
    pub total_pages: Option<usize>,
    pub total_size: u64,
    pub issue: Option<MergeIssue>,
}

impl MergePlan {
    pub fn can_run(&self) -> bool {
        self.issue.is_none()
    }
}

pub fn plan(rows: &[MergeRow]) -> MergePlan {
    let pages: Vec<RowPages> = rows.iter().map(row_pages).collect();
    let total_pages = pages
        .iter()
        .map(RowPages::count)
        .try_fold(0usize, |sum, n| n.map(|n| sum + n));
    let total_size = rows
        .iter()
        .filter_map(|r| match &r.probe {
            Probe::Ready(info) => Some(info.file_size),
            _ => None,
        })
        .sum();
    let issue = if rows.iter().any(|r| matches!(r.probe, Probe::Failed(_))) {
        Some(MergeIssue::Unreadable)
    } else if rows.iter().any(|r| matches!(r.probe, Probe::Locked { .. })) {
        Some(MergeIssue::Locked)
    } else if rows.iter().any(|r| matches!(r.probe, Probe::Pending)) {
        Some(MergeIssue::Loading)
    } else if pages.iter().any(|p| matches!(p, RowPages::Invalid(_))) {
        Some(MergeIssue::BadRange)
    } else if rows.len() < 2 {
        Some(MergeIssue::NeedTwo)
    } else {
        None
    };
    MergePlan {
        total_pages,
        total_size,
        issue,
    }
}

/// Hai đường dẫn cùng một file? Windows không phân biệt hoa thường và coi `/` như `\`.
pub fn same_path(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        let s = s.replace('/', "\\");
        if cfg!(windows) { s.to_lowercase() } else { s }
    };
    norm(a) == norm(b)
}

/// Tham số `file.merge`. Chặn ghi đè một file nguồn (tiêu chí "file nguồn không đổi").
pub fn build_params(
    rows: &[MergeRow],
    output_path: &str,
    bookmarks_from_filenames: bool,
) -> Result<Value, MergeIssue> {
    if let Some(issue) = plan(rows).issue {
        return Err(issue);
    }
    if rows.iter().any(|r| same_path(&r.path, output_path)) {
        return Err(MergeIssue::OutputIsInput);
    }
    let inputs: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut input = json!({ "path": row.path });
            if let Some(password) = &row.password {
                input["password"] = json!(password);
            }
            if let RowPages::Some(pages) = row_pages(row) {
                input["pages"] = json!(pages);
            }
            input
        })
        .collect();
    Ok(json!({
        "inputs": inputs,
        "outputPath": output_path,
        "bookmarksFromFilenames": bookmarks_from_filenames,
    }))
}

/// Tên file kết quả gợi ý: "<tên file đầu>_da-ghep.pdf".
pub fn suggested_output_name(first_path: &str) -> String {
    format!("{}_{}.pdf", file_stem(first_path), t("merge.suffix"))
}

/// Đổi chỗ dòng `index` với dòng kề (`-1` lên, `1` xuống). Trả `true` nếu có đổi.
pub fn move_row<T>(rows: &mut [T], index: usize, direction: i8) -> bool {
    let target = match direction {
        -1 if index > 0 => index - 1,
        1 if index + 1 < rows.len() => index + 1,
        _ => return false,
    };
    rows.swap(index, target);
    true
}

/// Cảnh báo ở cột bên: thiếu file, hoặc tệp đang mở có thay đổi chưa lưu (ghép dùng bản trên đĩa).
pub fn warnings(
    rows: &[MergeRow],
    unsaved_open_path: Option<&str>,
    unsaved_name: &str,
) -> Vec<String> {
    let mut out = Vec::new();
    if rows.len() == 1 {
        out.push(t("merge.needTwo"));
    }
    if let Some(path) = unsaved_open_path
        && rows.iter().any(|r| same_path(&r.path, path))
    {
        out.push(t_with("merge.unsavedWarning", &[("name", unsaved_name)]));
    }
    out
}

// ---------------------------------------------------------------------------
// Giao diện
// ---------------------------------------------------------------------------

struct Row {
    key: u64,
    path: String,
    probe: Probe,
    /// Mật khẩu đã nhập đúng; nằm trong bộ nhớ và được xóa khi đóng hộp thoại.
    password: Option<zeroize::Zeroizing<String>>,
    /// Ô nhập mật khẩu, chỉ hiện khi file có mật khẩu.
    password_input: Entity<TextInput>,
    password_try: FocusHandle,
    range: Entity<TextInput>,
    up: FocusHandle,
    down: FocusHandle,
    remove: FocusHandle,
}

/// Hộp thoại Ghép file. Viewer giữ entity này khi đang mở và nghe [`ProcessEvent`].
pub struct MergeDialog {
    ctx: ProcessContext,
    rows: Vec<Row>,
    next_key: u64,
    bookmarks: bool,
    bookmarks_focus: FocusHandle,
    add_focus: FocusHandle,
    open_focus: FocusHandle,
    reveal_focus: FocusHandle,
    return_to: FocusHandle,
    runner: Runner,
    /// File kết quả sau khi ghép xong.
    output: Option<String>,
    _subs: Vec<Subscription>,
}

impl EventEmitter<ProcessEvent> for MergeDialog {}

impl ProcessView for MergeDialog {
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

impl MergeDialog {
    pub fn new(
        ctx: ProcessContext,
        initial: Vec<PathBuf>,
        return_to: FocusHandle,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut me = Self {
            ctx,
            rows: Vec::new(),
            next_key: 0,
            bookmarks: true,
            bookmarks_focus: cx.focus_handle(),
            add_focus: cx.focus_handle(),
            open_focus: cx.focus_handle(),
            reveal_focus: cx.focus_handle(),
            return_to,
            runner: Runner::default(),
            output: None,
            _subs: Vec::new(),
        };
        me.add_paths(initial, cx);
        me
    }

    /// Thêm file vào cuối danh sách và dò số trang của từng file trên luồng nền.
    pub fn add_paths(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        for path in paths {
            let key = self.next_key;
            self.next_key += 1;
            let path_text = path.display().to_string();
            let range = cx.new(|cx| TextInput::new(cx, t("merge.allPages")));
            self._subs
                .push(cx.subscribe(&range, |_, _, event: &TextInputEvent, cx| {
                    if matches!(event, TextInputEvent::Changed) {
                        cx.notify();
                    }
                }));
            let password_input = cx.new(|cx| {
                let mut input = TextInput::new(cx, t("password.label"));
                input.set_secure(true, cx);
                input
            });
            self.rows.push(Row {
                key,
                path: path_text,
                probe: Probe::Pending,
                password: None,
                password_input,
                password_try: cx.focus_handle(),
                range,
                up: cx.focus_handle(),
                down: cx.focus_handle(),
                remove: cx.focus_handle(),
            });
            self.probe_row(key, path, None, cx);
        }
        cx.notify();
    }

    /// Dò một dòng trên luồng nền, có hoặc không có mật khẩu.
    fn probe_row(
        &mut self,
        key: u64,
        path: PathBuf,
        password: Option<zeroize::Zeroizing<String>>,
        cx: &mut Context<Self>,
    ) {
        let supervisor = self.ctx.supervisor.clone();
        cx.spawn(async move |this, cx| {
            let typed = password.clone();
            let outcome = match supervisor {
                Some(sup) => cx
                    .background_executor()
                    .spawn(
                        async move { probe_pdf(&sup, &path, typed.as_ref().map(|p| p.as_str())) },
                    )
                    .await,
                None => Err(ProbeError::Message(t("editor.coreUnavailable"))),
            };
            let _ = this.update(cx, |me, cx| {
                if let Some(row) = me.rows.iter_mut().find(|r| r.key == key) {
                    match outcome {
                        Ok(info) => {
                            row.probe = Probe::Ready(info);
                            row.password = password;
                        }
                        Err(ProbeError::PasswordRequired) => {
                            row.probe = Probe::Locked { wrong: false };
                        }
                        Err(ProbeError::PasswordInvalid) => {
                            row.probe = Probe::Locked { wrong: true };
                        }
                        Err(ProbeError::Message(message)) => row.probe = Probe::Failed(message),
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Thử lại một dòng có mật khẩu bằng chữ trong ô nhập; ô nhập được xóa ngay.
    fn retry_password(&mut self, index: usize, cx: &mut Context<Self>) {
        let Some(row) = self.rows.get(index) else {
            return;
        };
        let (key, path) = (row.key, PathBuf::from(&row.path));
        let typed = zeroize::Zeroizing::new(row.password_input.read(cx).text().to_string());
        row.password_input
            .update(cx, |input, cx| input.clear_sensitive(cx));
        if typed.is_empty() {
            return;
        }
        if let Some(row) = self.rows.get_mut(index) {
            row.probe = Probe::Pending;
        }
        self.probe_row(key, path, Some(typed), cx);
        cx.notify();
    }

    fn snapshot(&self, cx: &gpui::App) -> Vec<MergeRow> {
        self.rows
            .iter()
            .map(|row| MergeRow {
                path: row.path.clone(),
                probe: row.probe.clone(),
                range: row.range.read(cx).text().to_string(),
                password: None,
            })
            .collect()
    }

    fn pick_files(&mut self, cx: &mut Context<Self>) {
        let picked = crate::dialogs::open_pdfs(self.ctx.initial_dir.as_deref());
        if !picked.is_empty() {
            self.add_paths(picked, cx);
        }
    }

    fn remove_row(&mut self, index: usize, cx: &mut Context<Self>) {
        if index < self.rows.len() {
            self.rows.remove(index);
            cx.notify();
        }
    }

    fn move_row(&mut self, index: usize, direction: i8, cx: &mut Context<Self>) {
        if move_row(&mut self.rows, index, direction) {
            cx.notify();
        }
    }

    fn run(&mut self, cx: &mut Context<Self>) {
        if self.runner.running {
            return;
        }
        let rows = self.snapshot(cx);
        if let Some(issue) = plan(&rows).issue {
            self.runner.result = Some(TaskResult::error(t(issue.i18n_key())));
            cx.notify();
            return;
        }
        let first = rows[0].path.clone();
        let dir_hint = self.ctx.initial_dir.clone().or_else(|| {
            Some(PathBuf::from(parent_dir(&first))).filter(|p| !p.as_os_str().is_empty())
        });
        let Some(output) =
            crate::dialogs::save_pdf(dir_hint.as_deref(), &suggested_output_name(&first))
        else {
            return;
        };
        let output = output.display().to_string();
        let params = match build_params(&rows, &output, self.bookmarks) {
            Ok(params) => params,
            Err(issue) => {
                self.runner.result = Some(TaskResult::error(t(issue.i18n_key())));
                cx.notify();
                return;
            }
        };
        self.output = None;
        let ctx = self.ctx.clone();
        spawn_job(
            self,
            cx,
            |me| &mut me.runner,
            &ctx,
            "file.merge",
            params,
            move |me, outcome, cx| {
                me.runner.result = Some(match outcome {
                    Ok(ok) => {
                        let path = ok.outputs.first().cloned().unwrap_or(output);
                        let name = display_basename(&path).to_string();
                        me.output = Some(path);
                        TaskResult::success(t("merge.doneTitle"))
                            .detail(t_with("merge.doneText", &[("name", &name)]))
                            .items(ok.warnings)
                    }
                    Err(crate::process::JobFail::Cancelled) => {
                        TaskResult::cancelled(t("jobs.status.cancelled"))
                    }
                    Err(crate::process::JobFail::Failed(message)) => {
                        TaskResult::error(t("merge.failed")).detail(message)
                    }
                });
                cx.notify();
            },
        );
        cx.notify();
    }

    fn render_row(&self, index: usize, cx: &mut Context<Self>) -> impl IntoElement {
        let row = &self.rows[index];
        let dark = self.ctx.dark;
        let colors = Colors::of(dark);
        let entity = cx.entity();
        let merge_row = MergeRow {
            path: row.path.clone(),
            probe: row.probe.clone(),
            range: row.range.read(cx).text().to_string(),
            password: None,
        };
        let pages = row_pages(&merge_row);
        let meta = match &row.probe {
            Probe::Pending => t("merge.loading"),
            Probe::Failed(message) => message.clone(),
            Probe::Locked { wrong: false } => t("merge.locked"),
            Probe::Locked { wrong: true } => t("password.invalid"),
            Probe::Ready(info) => format!(
                "{} · {}",
                t_with("merge.pages", &[("count", &info.page_count.to_string())]),
                format_bytes(info.file_size)
            ),
        };
        let range_error = match &pages {
            RowPages::Invalid(error) => Some(t(error.i18n_key())),
            _ => None,
        };
        let total = self.rows.len();
        let (up_entity, down_entity, remove_entity) =
            (entity.clone(), entity.clone(), entity.clone());
        let name = display_basename(&row.path).to_string();
        div()
            .id(("merge-row", row.key))
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(10.))
            .py(px(8.))
            .border_1()
            .border_color(rgba(colors.border))
            .rounded(px(chef_theme::shared::RADIUS_MD))
            .child(
                div()
                    .w(px(20.))
                    .text_size(px(chef_theme::shared::TEXT_SM))
                    .text_color(rgba(colors.muted))
                    .child(format!("{}", index + 1)),
            )
            .child(
                div()
                    .flex_1()
                    .min_w(px(0.))
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .truncate()
                            .text_size(px(chef_theme::shared::TEXT_MD))
                            .text_color(rgba(colors.text))
                            .child(name),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_size(px(chef_theme::shared::TEXT_SM))
                            .text_color(rgba(if matches!(row.probe, Probe::Failed(_)) {
                                colors.danger
                            } else {
                                colors.muted
                            }))
                            .child(meta),
                    )
                    .children(range_error.map(|message| {
                        div()
                            .text_size(px(chef_theme::shared::TEXT_SM))
                            .text_color(rgba(colors.danger))
                            .child(message)
                    })),
            )
            .child(if matches!(row.probe, Probe::Locked { .. }) {
                let retry_entity = entity.clone();
                div()
                    .flex()
                    .items_end()
                    .gap(px(4.))
                    .child(
                        div().w(px(120.)).child(
                            chef_ui::form::TextField::new(
                                ("merge-password", row.key),
                                t("password.label"),
                                row.password_input.clone(),
                            )
                            .dark(dark),
                        ),
                    )
                    .child(
                        Button::new(("merge-unlock", row.key), row.password_try.clone())
                            .label(t("password.open"))
                            .size(Size::Sm)
                            .dark(dark)
                            .on_click(move |_, _, cx| {
                                retry_entity.update(cx, |me, cx| me.retry_password(index, cx));
                            }),
                    )
            } else {
                div().w(px(120.)).child(
                    chef_ui::form::TextField::new(
                        ("merge-range", row.key),
                        t_with(
                            "merge.pageRangeFor",
                            &[("name", display_basename(&row.path))],
                        ),
                        row.range.clone(),
                    )
                    .dark(dark),
                )
            })
            .child(
                Button::new(("merge-up", row.key), row.up.clone())
                    .icon("icons/arrow-up.svg")
                    .aria_label(t("common.moveUp"))
                    .variant(Variant::Ghost)
                    .size(Size::Sm)
                    .dark(dark)
                    .disabled(index == 0 || self.runner.running)
                    .on_click(move |_, _, cx| {
                        up_entity.update(cx, |me, cx| me.move_row(index, -1, cx));
                    }),
            )
            .child(
                Button::new(("merge-down", row.key), row.down.clone())
                    .icon("icons/arrow-down.svg")
                    .aria_label(t("common.moveDown"))
                    .variant(Variant::Ghost)
                    .size(Size::Sm)
                    .dark(dark)
                    .disabled(index + 1 >= total || self.runner.running)
                    .on_click(move |_, _, cx| {
                        down_entity.update(cx, |me, cx| me.move_row(index, 1, cx));
                    }),
            )
            .child(
                Button::new(("merge-remove", row.key), row.remove.clone())
                    .icon("icons/x.svg")
                    .aria_label(t("common.remove"))
                    .variant(Variant::Ghost)
                    .size(Size::Sm)
                    .dark(dark)
                    .disabled(self.runner.running)
                    .on_click(move |_, _, cx| {
                        remove_entity.update(cx, |me, cx| me.remove_row(index, cx));
                    }),
            )
    }

    fn tab_order(&self, cx: &gpui::App) -> Vec<FocusHandle> {
        let mut order = vec![self.add_focus.clone()];
        for row in &self.rows {
            order.push(row.range.read(cx).focus_handle(cx));
            order.extend([row.up.clone(), row.down.clone(), row.remove.clone()]);
        }
        order.push(self.bookmarks_focus.clone());
        order
    }
}

impl Render for MergeDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let dark = self.ctx.dark;
        let colors = Colors::of(dark);
        let snapshot = self.snapshot(cx);
        let plan = plan(&snapshot);
        let running = self.runner.running;
        let unsaved = (self.ctx.dirty)
            .then(|| self.ctx.source.as_ref().map(|p| p.display().to_string()))
            .flatten();
        let warnings = warnings(&snapshot, unsaved.as_deref(), &self.ctx.file_name);
        let entity = cx.entity();

        let mut list = div().flex().flex_col().gap(px(6.));
        if self.rows.is_empty() {
            list = list.child(
                div()
                    .flex()
                    .flex_col()
                    .items_center()
                    .py(px(24.))
                    .gap(px(4.))
                    .child(
                        div()
                            .text_size(px(chef_theme::shared::TEXT_MD))
                            .text_color(rgba(colors.text))
                            .child(t("merge.emptyTitle")),
                    )
                    .child(
                        div()
                            .text_size(px(chef_theme::shared::TEXT_SM))
                            .text_color(rgba(colors.muted))
                            .child(t("merge.emptyText")),
                    ),
            );
        }
        for index in 0..self.rows.len() {
            list = list.child(self.render_row(index, cx));
        }

        let add_entity = entity.clone();
        let head = div()
            .flex()
            .items_center()
            .justify_between()
            .mb(px(8.))
            .child(
                div()
                    .text_size(px(chef_theme::shared::TEXT_MD))
                    .text_color(rgba(colors.text))
                    .child(t_with(
                        "merge.files",
                        &[("count", &self.rows.len().to_string())],
                    )),
            )
            .child(
                Button::new("merge-add", self.add_focus.clone())
                    .icon("icons/file-plus.svg")
                    .label(t("merge.addFiles"))
                    .size(Size::Sm)
                    .dark(dark)
                    .disabled(running)
                    .on_click(move |_, _, cx| {
                        add_entity.update(cx, |me, cx| me.pick_files(cx));
                    }),
            );

        let bookmarks_entity = entity.clone();
        let bookmarks = div()
            .mt(px(12.))
            .flex()
            .flex_col()
            .gap(px(2.))
            .child(
                Checkbox::new(
                    "merge-bookmarks",
                    self.bookmarks_focus.clone(),
                    t("merge.bookmarks"),
                    if self.bookmarks {
                        CheckState::Checked
                    } else {
                        CheckState::Unchecked
                    },
                )
                .disabled(running)
                .dark(dark)
                .on_change(move |next, _, cx| {
                    let on = *next == CheckState::Checked;
                    bookmarks_entity.update(cx, |me, cx| {
                        me.bookmarks = on;
                        cx.notify();
                    });
                }),
            )
            .child(
                div()
                    .pl(px(26.))
                    .text_size(px(chef_theme::shared::TEXT_SM))
                    .text_color(rgba(colors.muted))
                    .child(t("merge.bookmarksHint")),
            );

        // Kết quả: nút mở file và hiện trong thư mục.
        let mut after = div().flex().gap(px(8.)).mt(px(12.));
        if let Some(output) = self.output.clone() {
            let open_entity = entity.clone();
            let reveal_path = output.clone();
            let open_path = output.clone();
            after = after
                .child(
                    Button::new("merge-open", self.open_focus.clone())
                        .variant(Variant::Primary)
                        .label(t("merge.openResult"))
                        .dark(dark)
                        .on_click(move |_, _, cx| {
                            let path = PathBuf::from(&open_path);
                            open_entity.update(cx, |_, cx| cx.emit(ProcessEvent::OpenFile(path)));
                        }),
                )
                .child(
                    Button::new("merge-reveal", self.reveal_focus.clone())
                        .icon("icons/folder-open.svg")
                        .label(t("outputs.showInFolder"))
                        .dark(dark)
                        .on_click(move |_, _, _| crate::process::reveal_in_folder(&reveal_path)),
                );
        }

        let mut summary = div()
            .flex()
            .flex_col()
            .gap(px(6.))
            .child(
                div()
                    .text_size(px(28.))
                    .text_color(rgba(colors.text))
                    .child(
                        plan.total_pages
                            .map_or_else(|| "…".to_string(), |n| n.to_string()),
                    ),
            )
            .child(
                div()
                    .text_size(px(chef_theme::shared::TEXT_SM))
                    .text_color(rgba(colors.muted))
                    .child(t("merge.totalPages")),
            );
        for (row, merge_row) in self.rows.iter().zip(&snapshot).take(SUMMARY_ROWS) {
            summary = summary.child(
                div()
                    .flex()
                    .justify_between()
                    .gap(px(8.))
                    .text_size(px(chef_theme::shared::TEXT_SM))
                    .child(
                        div()
                            .truncate()
                            .text_color(rgba(colors.text))
                            .child(display_basename(&row.path).to_string()),
                    )
                    .child(
                        div().text_color(rgba(colors.muted)).child(
                            row_pages(merge_row)
                                .count()
                                .map_or_else(|| "…".to_string(), |n| n.to_string()),
                        ),
                    ),
            );
        }
        if self.rows.len() > SUMMARY_ROWS {
            summary = summary.child(
                div()
                    .text_size(px(chef_theme::shared::TEXT_SM))
                    .text_color(rgba(colors.muted))
                    .child(t_with(
                        "merge.andMore",
                        &[("count", &(self.rows.len() - SUMMARY_ROWS).to_string())],
                    )),
            );
        }

        let dialog = TaskDialog::new("merge-dialog", t("merge.title"), dark)
            .icon("icons/combine.svg")
            .description(t("merge.description"))
            .size(Width::Xl)
            .return_focus(self.return_to.clone())
            .child(head)
            .child(list)
            .child(bookmarks)
            .child(after)
            .preview(summary)
            .estimate(div().child(if self.rows.is_empty() {
                "–".to_string()
            } else {
                format!("~{}", format_bytes(plan.total_size))
            }))
            .warnings(warnings)
            .run_label(t("merge.run"))
            .can_run(plan.can_run() && !running)
            .tab_order(self.tab_order(cx));
        wire(dialog, self, cx, Self::run)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready(path: &str, pages: usize, size: u64, range: &str) -> MergeRow {
        MergeRow {
            path: path.into(),
            probe: Probe::Ready(ProbedPdf {
                page_count: pages,
                file_size: size,
            }),
            range: range.into(),
            password: None,
        }
    }

    #[test]
    fn totals_pages_and_size_over_all_rows() {
        let rows = [ready("a.pdf", 10, 100, ""), ready("b.pdf", 5, 50, "1-2, 5")];
        let plan = plan(&rows);
        assert_eq!(plan.total_pages, Some(13));
        assert_eq!(plan.total_size, 150);
        assert!(plan.can_run());
    }

    #[test]
    fn needs_two_readable_files_with_valid_ranges() {
        assert_eq!(
            plan(&[ready("a.pdf", 3, 1, "")]).issue,
            Some(MergeIssue::NeedTwo)
        );
        let pending = MergeRow {
            path: "b.pdf".into(),
            probe: Probe::Pending,
            range: String::new(),
            password: None,
        };
        let both = [ready("a.pdf", 3, 1, ""), pending];
        assert_eq!(plan(&both).issue, Some(MergeIssue::Loading));
        assert_eq!(plan(&both).total_pages, None);
        let failed = MergeRow {
            path: "c.pdf".into(),
            probe: Probe::Failed("cần mật khẩu".into()),
            range: String::new(),
            password: None,
        };
        assert_eq!(
            plan(&[ready("a.pdf", 3, 1, ""), failed]).issue,
            Some(MergeIssue::Unreadable)
        );
        let bad = [ready("a.pdf", 3, 1, "1-9"), ready("b.pdf", 3, 1, "")];
        assert_eq!(plan(&bad).issue, Some(MergeIssue::BadRange));
        assert_eq!(plan(&bad).total_pages, None);
    }

    #[test]
    fn builds_core_params_with_zero_based_pages_and_optional_range() {
        let rows = [
            ready("C:\\a.pdf", 10, 1, ""),
            ready("C:\\b.pdf", 5, 1, "2-3"),
        ];
        let params = build_params(&rows, "C:\\out.pdf", true).unwrap();
        assert_eq!(
            params,
            json!({
                "inputs": [{ "path": "C:\\a.pdf" }, { "path": "C:\\b.pdf", "pages": [1, 2] }],
                "outputPath": "C:\\out.pdf",
                "bookmarksFromFilenames": true
            })
        );
        // Đúng dạng dây mà struct sinh từ lõi chấp nhận.
        let typed: chef_contracts::ops_types::FileMergeParams =
            serde_json::from_value(params).expect("FileMergeParams đọc được");
        assert_eq!(typed.inputs.len(), 2);
    }

    #[test]
    fn refuses_to_overwrite_a_source_file() {
        let rows = [ready("/tmp/a.pdf", 2, 1, ""), ready("/tmp/b.pdf", 2, 1, "")];
        assert_eq!(
            build_params(&rows, "/tmp/b.pdf", false),
            Err(MergeIssue::OutputIsInput)
        );
        assert!(same_path("/tmp/a.pdf", "/tmp/a.pdf"));
        assert!(same_path("C:/x/a.pdf", "C:\\x\\a.pdf"));
        assert!(build_params(&rows[..1], "/tmp/o.pdf", false).is_err());
    }

    #[test]
    fn locked_files_block_the_run_until_the_password_opens_them() {
        let locked = MergeRow {
            path: "/tmp/khoa.pdf".into(),
            probe: Probe::Locked { wrong: false },
            range: String::new(),
            password: None,
        };
        let rows = [ready("/tmp/a.pdf", 3, 1, ""), locked];
        assert_eq!(plan(&rows).issue, Some(MergeIssue::Locked));
        assert_eq!(plan(&rows).total_pages, None);
        assert_eq!(MergeIssue::Locked.i18n_key(), "merge.locked");
        // Sau khi mở được bằng mật khẩu, mật khẩu đi cùng đầu vào đó và chỉ đầu vào đó.
        let mut opened = ready("/tmp/khoa.pdf", 4, 1, "");
        opened.password = Some("1234".into());
        let rows = [ready("/tmp/a.pdf", 3, 1, ""), opened];
        let params = build_params(&rows, "/tmp/o.pdf", false).unwrap();
        assert!(params["inputs"][0].get("password").is_none());
        assert_eq!(params["inputs"][1]["password"], "1234");
    }

    #[test]
    fn moves_rows_and_ignores_edges() {
        let mut v = vec![1, 2, 3];
        assert!(move_row(&mut v, 1, -1));
        assert_eq!(v, [2, 1, 3]);
        assert!(move_row(&mut v, 1, 1));
        assert_eq!(v, [2, 3, 1]);
        assert!(!move_row(&mut v, 0, -1));
        assert!(!move_row(&mut v, 2, 1));
        assert!(!move_row(&mut v, 0, 0));
    }

    #[test]
    fn suggests_a_name_next_to_the_first_file() {
        assert_eq!(
            suggested_output_name(r"C:\docs\hop-dong.pdf"),
            "hop-dong_da-ghep.pdf"
        );
    }

    #[test]
    fn warns_about_unsaved_open_documents() {
        let rows = [ready("/tmp/a.pdf", 2, 1, "")];
        let w = warnings(&rows, Some("/tmp/a.pdf"), "a.pdf");
        assert_eq!(w.len(), 2);
        assert!(warnings(&rows, Some("/tmp/other.pdf"), "x").len() == 1);
    }
}
