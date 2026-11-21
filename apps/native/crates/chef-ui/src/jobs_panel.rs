//! Panel tiến trình công việc (TASKS_RUST R3.09, BLUEPRINT_RUST §6.6):
//! bản GPUI của `jobStore.ts` và `JobPanel.tsx` / `JobPanel.css`.
//!
//! - [`JobStore`] giữ tối đa [`MAX_KEPT`] (30) công việc, đệm thông báo đến trước [`JobStore::track`],
//!   loại trừ job `silent`, và giữ lỗi của job `Failed` tới khi người dùng bỏ hoặc xóa xong.
//! - [`build_jobs_toggle`] (`id = "jobs-toggle"`) và [`build_jobs_panel`] (`id = "jobs-panel"`)
//!   vẽ nút thanh trạng thái và popover danh sách công việc theo token của `chef-theme`, dùng `i18n`,
//!   đăng ký `a11y`, và tôn trọng [`motion::reduced`].

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chef_theme::{dark, light, shared};
use gpui::{
    Animation, AnimationExt, App, ElementId, FocusHandle, FontWeight, IntoElement, RenderOnce,
    SharedString, Transformation, Window, div, percentage, prelude::*, px, relative, rgba, svg,
};

use crate::a11y::{self, Registered};
use crate::button::{Button, Size, Variant, cubic_bezier, pack};
use crate::dialog::shadow_lg;
use crate::{i18n, motion};

/// Số lượng công việc tối đa được giữ trong danh sách hiển thị (khớp `jobStore.ts`).
pub const MAX_KEPT: usize = 30;

/// Trạng thái của một công việc nền.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobStatus {
    Running,
    Finished,
    Failed,
    Cancelled,
}

impl JobStatus {
    /// Chuỗi trạng thái ổn định dùng cho i18n (`jobs.status.<str>`) và debug JSON.
    pub fn as_str(&self) -> &'static str {
        match self {
            JobStatus::Running => "running",
            JobStatus::Finished => "finished",
            JobStatus::Failed => "failed",
            JobStatus::Cancelled => "cancelled",
        }
    }
}

/// Thông tin mô tả khi bắt đầu theo dõi một job.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct JobMeta {
    pub op_id: String,
    pub title: String,
    pub session_id: Option<String>,
    pub silent: bool,
}

/// Một mục công việc trong [`JobStore`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobEntry {
    pub id: String,
    pub op_id: String,
    pub title: String,
    pub session_id: Option<String>,
    pub status: JobStatus,
    pub done: u64,
    pub total: u64,
    pub message: Option<String>,
    pub error: Option<String>,
    pub started_at_ms: u64,
    pub ended_at_ms: Option<u64>,
}

/// Kho trạng thái các công việc đang chạy và vừa hoàn tất.
#[derive(Debug, Default)]
pub struct JobStore {
    jobs: Vec<JobEntry>,
    silent: HashSet<String>,
    early: HashMap<String, Vec<(String, serde_json::Value)>>,
}

impl JobStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Bắt đầu theo dõi một `job_id`. Chèn mục mới lên đầu (gộp trùng theo `id`, cắt tối đa
    /// [`MAX_KEPT`]) hoặc đánh dấu `silent`, rồi phát lại các thông báo đến sớm nếu có.
    pub fn track(&mut self, job_id: impl Into<String>, meta: JobMeta) {
        let job_id = job_id.into();
        if meta.silent {
            self.silent.insert(job_id.clone());
            self.jobs.retain(|j| j.id != job_id);
        } else {
            self.silent.remove(&job_id);
            self.jobs.retain(|j| j.id != job_id);
            let entry = JobEntry {
                id: job_id.clone(),
                op_id: meta.op_id,
                title: meta.title,
                session_id: meta.session_id,
                status: JobStatus::Running,
                done: 0,
                total: 0,
                message: None,
                error: None,
                started_at_ms: now_ms(),
                ended_at_ms: None,
            };
            self.jobs.insert(0, entry);
            self.jobs.truncate(MAX_KEPT);
        }

        if let Some(buffered) = self.early.remove(&job_id) {
            for (method, params) in buffered {
                self.handle_notification(&method, &params);
            }
        }
    }

    /// Xử lý thông báo RPC `job.progress`, `job.finished`, `job.failed`, `job.cancelled`.
    /// Trả về `true` nếu danh sách hiển thị có thay đổi.
    pub fn handle_notification(&mut self, method: &str, params: &serde_json::Value) -> bool {
        if !is_job_notification(method) {
            return false;
        }
        let Some(job_id) = params
            .get("jobId")
            .or_else(|| params.get("job_id"))
            .and_then(|v| v.as_str())
        else {
            return false;
        };

        if self.silent.contains(job_id) {
            if method != "job.progress" {
                self.silent.remove(job_id);
            }
            return false;
        }

        let Some(pos) = self.jobs.iter().position(|j| j.id == job_id) else {
            self.early
                .entry(job_id.to_string())
                .or_default()
                .push((method.to_string(), params.clone()));
            return false;
        };

        let entry = &mut self.jobs[pos];
        match method {
            "job.progress" => {
                if let Some(done) = params.get("done").and_then(|v| v.as_u64()) {
                    entry.done = done;
                }
                if let Some(total) = params.get("total").and_then(|v| v.as_u64()) {
                    entry.total = total;
                }
                if let Some(msg) = params.get("message") {
                    entry.message = msg.as_str().map(ToOwned::to_owned);
                }
                true
            }
            "job.finished" => {
                entry.status = JobStatus::Finished;
                entry.ended_at_ms = Some(now_ms());
                entry.done = entry.total.max(1);
                entry.message = None;
                true
            }
            "job.failed" => {
                entry.status = JobStatus::Failed;
                entry.ended_at_ms = Some(now_ms());
                entry.error = extract_error_message(params);
                true
            }
            "job.cancelled" => {
                entry.status = JobStatus::Cancelled;
                entry.ended_at_ms = Some(now_ms());
                true
            }
            _ => false,
        }
    }

    /// Gỡ một job khỏi danh sách nếu job đó không còn ở trạng thái [`JobStatus::Running`].
    pub fn dismiss(&mut self, job_id: &str) {
        self.jobs
            .retain(|j| j.id != job_id || j.status == JobStatus::Running);
    }

    /// Xóa mọi job đã kết thúc (chỉ giữ lại job đang chạy).
    pub fn clear_finished(&mut self) {
        self.jobs.retain(|j| j.status == JobStatus::Running);
    }

    /// Danh sách job hiển thị (mới nhất đứng trước).
    pub fn jobs(&self) -> &[JobEntry] {
        &self.jobs
    }

    /// Số job đang ở trạng thái [`JobStatus::Running`].
    pub fn running_count(&self) -> usize {
        self.jobs
            .iter()
            .filter(|j| j.status == JobStatus::Running)
            .count()
    }

    /// Có job nào đang ở trạng thái [`JobStatus::Failed`] hay không.
    pub fn has_failed(&self) -> bool {
        self.jobs.iter().any(|j| j.status == JobStatus::Failed)
    }

    /// Có job nào đã kết thúc (không còn chạy) để hiện nút xóa xong hay không.
    pub fn has_finished(&self) -> bool {
        self.jobs.iter().any(|j| j.status != JobStatus::Running)
    }

    /// Xuất trạng thái cho kênh debug E2E (`state.jobs`).
    pub fn to_debug_json(&self, open: bool) -> serde_json::Value {
        serde_json::json!({
            "open": open,
            "runningCount": self.running_count(),
            "items": self.jobs.iter().map(|entry| {
                serde_json::json!({
                    "id": entry.id,
                    "opId": entry.op_id,
                    "title": entry.title,
                    "sessionId": entry.session_id,
                    "status": entry.status.as_str(),
                    "done": entry.done,
                    "total": entry.total,
                    "message": entry.message,
                    "error": entry.error,
                    "progress": job_progress(entry),
                    "startedAtMs": entry.started_at_ms,
                    "endedAtMs": entry.ended_at_ms,
                })
            }).collect::<Vec<_>>(),
        })
    }
}

/// Kiểm tra tên method có phải thông báo job (`job.*`) hay không.
pub fn is_job_notification(method: &str) -> bool {
    matches!(
        method,
        "job.progress" | "job.finished" | "job.failed" | "job.cancelled"
    )
}

/// Tiến độ trong `[0.0, 1.0]`, hoặc `None` khi chưa xác định (`total == 0` lúc đang chạy).
pub fn job_progress(entry: &JobEntry) -> Option<f32> {
    if entry.status != JobStatus::Running {
        return Some(1.0);
    }
    if entry.total > 0 {
        Some((entry.done as f32 / entry.total as f32).clamp(0.0, 1.0))
    } else {
        None
    }
}

fn extract_error_message(params: &serde_json::Value) -> Option<String> {
    if let Some(err) = params.get("error") {
        if let Some(msg) = err.get("message").and_then(|v| v.as_str()) {
            return Some(msg.to_string());
        }
        if let Some(msg) = err.as_str() {
            return Some(msg.to_string());
        }
    }
    params
        .get("message")
        .and_then(|v| v.as_str())
        .map(ToOwned::to_owned)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn format_relative_ms(ts_ms: u64, now: u64, lang: i18n::Lang) -> String {
    let diff_s = now.saturating_sub(ts_ms) / 1000;
    match lang {
        i18n::Lang::Vi => {
            if diff_s < 5 {
                "vừa xong".to_string()
            } else if diff_s < 60 {
                format!("{diff_s} giây trước")
            } else if diff_s < 3600 {
                format!("{} phút trước", diff_s / 60)
            } else if diff_s < 86400 {
                format!("{} giờ trước", diff_s / 3600)
            } else {
                format!("{} ngày trước", diff_s / 86400)
            }
        }
        i18n::Lang::En => {
            if diff_s < 5 {
                "just now".to_string()
            } else if diff_s < 60 {
                format!("{diff_s}s ago")
            } else if diff_s < 3600 {
                format!("{}m ago", diff_s / 60)
            } else if diff_s < 86400 {
                format!("{}h ago", diff_s / 3600)
            } else {
                format!("{}d ago", diff_s / 86400)
            }
        }
    }
}

struct PanelColors {
    surface: u32,
    surface_sunken: u32,
    hover: u32,
    border: u32,
    divider: u32,
    text: u32,
    text_2: u32,
    text_3: u32,
    accent: u32,
    accent_text: u32,
    success: u32,
    danger: u32,
    focus: u32,
}

impl PanelColors {
    fn of(is_dark: bool) -> Self {
        if is_dark {
            Self {
                surface: pack(dark::C_SURFACE),
                surface_sunken: pack(dark::C_SURFACE_SUNKEN),
                hover: pack(dark::C_HOVER),
                border: pack(dark::C_BORDER),
                divider: pack(dark::C_DIVIDER),
                text: pack(dark::C_TEXT),
                text_2: pack(dark::C_TEXT_2),
                text_3: pack(dark::C_TEXT_3),
                accent: pack(dark::C_ACCENT),
                accent_text: pack(dark::C_ACCENT_TEXT),
                success: pack(dark::C_SUCCESS),
                danger: pack(dark::C_DANGER),
                focus: pack(dark::C_FOCUS),
            }
        } else {
            Self {
                surface: pack(light::C_SURFACE),
                surface_sunken: pack(light::C_SURFACE_SUNKEN),
                hover: pack(light::C_HOVER),
                border: pack(light::C_BORDER),
                divider: pack(light::C_DIVIDER),
                text: pack(light::C_TEXT),
                text_2: pack(light::C_TEXT_2),
                text_3: pack(light::C_TEXT_3),
                accent: pack(light::C_ACCENT),
                accent_text: pack(light::C_ACCENT_TEXT),
                success: pack(light::C_SUCCESS),
                danger: pack(light::C_DANGER),
                focus: pack(light::C_FOCUS),
            }
        }
    }
}

/// Dữ liệu hiển thị cho nút bật/tắt bảng công việc trên thanh trạng thái (`id = "jobs-toggle"`).
#[derive(Clone, Debug)]
pub struct JobsToggleProps {
    pub running_count: usize,
    pub has_failed: bool,
    pub open: bool,
    pub dark: bool,
    pub focus: Option<FocusHandle>,
}

impl JobsToggleProps {
    pub fn from_store(store: &JobStore, open: bool, dark: bool) -> Self {
        Self {
            running_count: store.running_count(),
            has_failed: store.has_failed(),
            open,
            dark,
            focus: None,
        }
    }

    pub fn focus(mut self, focus: FocusHandle) -> Self {
        self.focus = Some(focus);
        self
    }
}

/// Callback không tham số cho thao tác chung trên toggle/panel.
pub type ActionCallback = Rc<dyn Fn(&mut Window, &mut App)>;

/// Callback theo `job_id` cho nút hủy/bỏ từng dòng.
pub type JobActionCallback = Rc<dyn Fn(String, &mut Window, &mut App)>;

/// Callback cho [`build_jobs_toggle`].
#[derive(Clone, Default)]
pub struct JobsToggleCallbacks {
    pub on_toggle: Option<ActionCallback>,
}

impl JobsToggleCallbacks {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn on_toggle(mut self, listener: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_toggle = Some(Rc::new(listener));
        self
    }
}

/// Thành phần nút bật/tắt danh sách công việc (`id = "jobs-toggle"`).
#[derive(IntoElement)]
pub struct JobsToggle {
    props: JobsToggleProps,
    callbacks: JobsToggleCallbacks,
}

impl JobsToggle {
    pub fn new(props: JobsToggleProps, callbacks: JobsToggleCallbacks) -> Self {
        Self { props, callbacks }
    }
}

/// Tạo nút bật/tắt danh sách công việc trên thanh trạng thái (`id = "jobs-toggle"`).
pub fn build_jobs_toggle(props: JobsToggleProps, callbacks: JobsToggleCallbacks) -> JobsToggle {
    JobsToggle::new(props, callbacks)
}

impl RenderOnce for JobsToggle {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let c = PanelColors::of(self.props.dark);
        let reduced = motion::reduced();
        let focus = self.props.focus.unwrap_or_else(|| {
            window
                .use_keyed_state(ElementId::Name("jobs-toggle-focus".into()), cx, |_, cx| {
                    cx.focus_handle()
                })
                .read(cx)
                .clone()
        });

        let running = self.props.running_count;
        let label = if running > 0 {
            i18n::tn("jobs.runningCount", running as i64, &[])
        } else {
            i18n::t("jobs.title")
        };
        let fg = if running > 0 {
            c.accent_text
        } else if self.props.has_failed {
            c.danger
        } else {
            c.text_2
        };

        let icon = if running > 0 {
            render_spinner("jobs-toggle-spinner", 13.0, fg, reduced)
        } else {
            svg()
                .path("icons/list-checks.svg")
                .size(px(13.0))
                .flex_none()
                .text_color(rgba(fg))
                .into_any_element()
        };

        a11y::register(Registered {
            id: "jobs-toggle".into(),
            role: "button",
            name: label.clone(),
            disabled: false,
            focused: focus.is_focused(window),
            hovered: false,
            checked: Some(if self.props.open { "true" } else { "false" }),
            value: None,
            bounds: None,
        });

        let on_toggle = self.callbacks.on_toggle;
        let mut btn = div()
            .id("jobs-toggle")
            .track_focus(&focus)
            .flex()
            .flex_row()
            .items_center()
            .gap(px(shared::SPACE_3))
            .h(px(shared::CONTROL_H_XS))
            .px(px(shared::SPACE_4))
            .rounded(px(shared::RADIUS_SM))
            .cursor_pointer()
            .text_size(px(shared::TEXT_SM))
            .text_color(rgba(fg))
            .hover(|s| s.bg(rgba(c.hover)))
            .focus_visible(|s| {
                s.shadow(vec![
                    crate::button::ring(c.surface, 2.0),
                    crate::button::ring(c.focus, 4.0),
                ])
            })
            .child(icon)
            .child(label);

        if self.props.open {
            btn = btn.bg(rgba(c.hover));
        }
        if let Some(listener) = on_toggle {
            btn = btn.on_click(move |_, window, cx| listener(window, cx));
        }

        div()
            .flex_none()
            .child(btn)
            .on_children_prepainted(|bounds, _, _| {
                if let Some(b) = bounds.first() {
                    a11y::set_bounds("jobs-toggle", *b);
                }
            })
    }
}

/// Dữ liệu hiển thị cho bảng danh sách công việc (`id = "jobs-panel"`).
#[derive(Clone, Debug)]
pub struct JobsPanelProps {
    pub jobs: Vec<JobEntry>,
    pub dark: bool,
    pub close_focus: Option<FocusHandle>,
    pub clear_focus: Option<FocusHandle>,
}

impl JobsPanelProps {
    pub fn from_store(store: &JobStore, dark: bool) -> Self {
        Self {
            jobs: store.jobs().to_vec(),
            dark,
            close_focus: None,
            clear_focus: None,
        }
    }

    pub fn close_focus(mut self, focus: FocusHandle) -> Self {
        self.close_focus = Some(focus);
        self
    }

    pub fn clear_focus(mut self, focus: FocusHandle) -> Self {
        self.clear_focus = Some(focus);
        self
    }
}

/// Các callback cho [`build_jobs_panel`].
#[derive(Clone, Default)]
pub struct JobsPanelCallbacks {
    pub on_close: Option<ActionCallback>,
    pub on_clear_finished: Option<ActionCallback>,
    pub on_cancel: Option<JobActionCallback>,
    pub on_dismiss: Option<JobActionCallback>,
}

impl JobsPanelCallbacks {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn on_close(mut self, listener: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_close = Some(Rc::new(listener));
        self
    }

    pub fn on_clear_finished(mut self, listener: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_clear_finished = Some(Rc::new(listener));
        self
    }

    pub fn on_cancel(mut self, listener: impl Fn(String, &mut Window, &mut App) + 'static) -> Self {
        self.on_cancel = Some(Rc::new(listener));
        self
    }

    pub fn on_dismiss(
        mut self,
        listener: impl Fn(String, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_dismiss = Some(Rc::new(listener));
        self
    }
}

/// Thành phần bảng danh sách công việc (`id = "jobs-panel"`).
#[derive(IntoElement)]
pub struct JobsPanel {
    props: JobsPanelProps,
    callbacks: JobsPanelCallbacks,
}

impl JobsPanel {
    pub fn new(props: JobsPanelProps, callbacks: JobsPanelCallbacks) -> Self {
        Self { props, callbacks }
    }
}

/// Tạo bảng danh sách công việc (`id = "jobs-panel"`).
pub fn build_jobs_panel(props: JobsPanelProps, callbacks: JobsPanelCallbacks) -> JobsPanel {
    JobsPanel::new(props, callbacks)
}

impl RenderOnce for JobsPanel {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let c = PanelColors::of(self.props.dark);
        let reduced = motion::reduced();
        let lang = i18n::language();
        let now = now_ms();
        let title = i18n::t("jobs.title");

        a11y::register(Registered {
            id: "jobs-panel".into(),
            role: "dialog",
            name: title.clone(),
            disabled: false,
            focused: false,
            hovered: false,
            checked: None,
            value: None,
            bounds: None,
        });

        let has_finished = self
            .props
            .jobs
            .iter()
            .any(|j| j.status != JobStatus::Running);
        let close_focus = self.props.close_focus.unwrap_or_else(|| {
            window
                .use_keyed_state(
                    ElementId::Name("jobs-panel-close-focus".into()),
                    cx,
                    |_, cx| cx.focus_handle(),
                )
                .read(cx)
                .clone()
        });

        let mut header_actions = div()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(shared::SPACE_2));
        if has_finished {
            let clear_focus = self.props.clear_focus.unwrap_or_else(|| {
                window
                    .use_keyed_state(
                        ElementId::Name("jobs-clear-finished-focus".into()),
                        cx,
                        |_, cx| cx.focus_handle(),
                    )
                    .read(cx)
                    .clone()
            });
            let mut clear_btn = Button::new("jobs-clear-finished", clear_focus)
                .size(Size::Sm)
                .variant(Variant::Ghost)
                .label(i18n::t("jobs.clearFinished"))
                .dark(self.props.dark);
            if let Some(on_clear) = self.callbacks.on_clear_finished.clone() {
                clear_btn = clear_btn.on_click(move |_, window, cx| on_clear(window, cx));
            }
            header_actions = header_actions.child(clear_btn);
        }

        let mut close_btn = Button::new("jobs-panel-close", close_focus)
            .size(Size::Sm)
            .variant(Variant::Ghost)
            .icon("icons/x.svg")
            .aria_label(i18n::t("common.close"))
            .dark(self.props.dark);
        if let Some(on_close) = self.callbacks.on_close.clone() {
            close_btn = close_btn.on_click(move |_, window, cx| on_close(window, cx));
        }
        header_actions = header_actions.child(close_btn);

        let header = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_between()
            .min_h(px(42.0))
            .pl(px(shared::SPACE_6))
            .pr(px(shared::SPACE_4))
            .py(px(shared::SPACE_4))
            .border_b_1()
            .border_color(rgba(c.divider))
            .child(
                div()
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_size(px(shared::TEXT_MD))
                    .text_color(rgba(c.text))
                    .child(title),
            )
            .child(header_actions);

        let body = if self.props.jobs.is_empty() {
            div()
                .px(px(shared::SPACE_6))
                .py(px(shared::SPACE_8))
                .flex()
                .items_center()
                .justify_center()
                .text_size(px(shared::TEXT_SM))
                .text_color(rgba(c.text_3))
                .child(i18n::t("jobs.empty"))
                .into_any_element()
        } else {
            let mut rows = Vec::with_capacity(self.props.jobs.len());
            for job in &self.props.jobs {
                rows.push(render_job_row(
                    job,
                    &c,
                    self.props.dark,
                    reduced,
                    lang,
                    now,
                    &self.callbacks,
                    window,
                    cx,
                ));
            }
            div()
                .id("jobs-panel-list")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .p(px(shared::SPACE_2))
                .flex()
                .flex_col()
                .gap(px(shared::SPACE_1))
                .children(rows)
                .into_any_element()
        };

        let panel = div()
            .id("jobs-panel")
            .w(px(340.0))
            .max_h(px(420.0))
            .flex()
            .flex_col()
            .bg(rgba(c.surface))
            .border_1()
            .border_color(rgba(c.border))
            .rounded(px(shared::RADIUS_LG))
            .shadow(shadow_lg(self.props.dark))
            .occlude()
            .child(header)
            .child(body);

        let panel = if reduced {
            panel.into_any_element()
        } else {
            let duration = Duration::from_millis(shared::DUR as u64);
            panel
                .with_animation(
                    (ElementId::Name("jobs-panel".into()), "enter"),
                    Animation::new(duration).with_easing(cubic_bezier(0.2, 0.0, 0.0, 1.0)),
                    |el, delta| el.opacity(delta),
                )
                .into_any_element()
        };

        div()
            .flex_none()
            .child(panel)
            .on_children_prepainted(|bounds, _, _| {
                if let Some(b) = bounds.first() {
                    a11y::set_bounds("jobs-panel", *b);
                }
            })
    }
}

#[allow(clippy::too_many_arguments)]
fn render_job_row(
    job: &JobEntry,
    c: &PanelColors,
    is_dark: bool,
    reduced: bool,
    lang: i18n::Lang,
    now: u64,
    callbacks: &JobsPanelCallbacks,
    window: &mut Window,
    cx: &mut App,
) -> gpui::AnyElement {
    let icon = match job.status {
        JobStatus::Running => {
            render_spinner(format!("job-spinner-{}", job.id), 16.0, c.accent, reduced)
        }
        JobStatus::Finished => svg()
            .path("icons/circle-check.svg")
            .size(px(16.0))
            .flex_none()
            .text_color(rgba(c.success))
            .into_any_element(),
        JobStatus::Failed => svg()
            .path("icons/circle-alert.svg")
            .size(px(16.0))
            .flex_none()
            .text_color(rgba(c.danger))
            .into_any_element(),
        JobStatus::Cancelled => svg()
            .path("icons/ban.svg")
            .size(px(16.0))
            .flex_none()
            .text_color(rgba(c.text_3))
            .into_any_element(),
    };

    let mut body = div()
        .flex_1()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(shared::SPACE_2))
        .child(
            div()
                .w_full()
                .min_w_0()
                .truncate()
                .font_weight(FontWeight::MEDIUM)
                .text_size(px(shared::TEXT_SM))
                .text_color(rgba(c.text))
                .child(SharedString::from(job.title.clone())),
        );

    if job.status == JobStatus::Running {
        let progress = job_progress(job);
        body = body.child(render_progress_bar(
            format!("job-progress-{}", job.id),
            progress,
            c,
            reduced,
        ));
        let meta_text = if let Some(msg) = &job.message {
            msg.clone()
        } else if job.total > 0 {
            let done_str = job.done.to_string();
            let total_str = job.total.to_string();
            i18n::t_with(
                "jobs.progress",
                &[("done", &done_str), ("total", &total_str)],
            )
        } else {
            i18n::t("jobs.running")
        };
        body = body.child(
            div()
                .w_full()
                .min_w_0()
                .truncate()
                .text_size(px(shared::TEXT_XS))
                .text_color(rgba(c.text_3))
                .child(meta_text),
        );
    } else {
        let status_label = i18n::t(&format!("jobs.status.{}", job.status.as_str()));
        let rel = format_relative_ms(job.ended_at_ms.unwrap_or(job.started_at_ms), now, lang);
        let meta_text = match &job.error {
            Some(err) if !err.is_empty() => format!("{status_label} · {err} · {rel}"),
            _ => format!("{status_label} · {rel}"),
        };
        body = body.child(
            div()
                .w_full()
                .min_w_0()
                .truncate()
                .text_size(px(shared::TEXT_XS))
                .text_color(rgba(c.text_3))
                .child(meta_text),
        );
    }

    let action_btn = if job.status == JobStatus::Running {
        let btn_id = format!("job-cancel-{}", job.id);
        let focus = window
            .use_keyed_state(
                ElementId::Name(format!("{btn_id}-focus").into()),
                cx,
                |_, cx| cx.focus_handle(),
            )
            .read(cx)
            .clone();
        let mut btn = Button::new(btn_id, focus)
            .size(Size::Sm)
            .variant(Variant::Ghost)
            .icon("icons/x.svg")
            .aria_label(i18n::t("jobs.cancel"))
            .dark(is_dark);
        if let Some(on_cancel) = callbacks.on_cancel.clone() {
            let id = job.id.clone();
            btn = btn.on_click(move |_, window, cx| on_cancel(id.clone(), window, cx));
        }
        btn
    } else {
        let btn_id = format!("job-dismiss-{}", job.id);
        let focus = window
            .use_keyed_state(
                ElementId::Name(format!("{btn_id}-focus").into()),
                cx,
                |_, cx| cx.focus_handle(),
            )
            .read(cx)
            .clone();
        let mut btn = Button::new(btn_id, focus)
            .size(Size::Sm)
            .variant(Variant::Ghost)
            .icon("icons/x.svg")
            .aria_label(i18n::t("jobs.dismiss"))
            .dark(is_dark);
        if let Some(on_dismiss) = callbacks.on_dismiss.clone() {
            let id = job.id.clone();
            btn = btn.on_click(move |_, window, cx| on_dismiss(id.clone(), window, cx));
        }
        btn
    };

    div()
        .id(ElementId::Name(format!("job-row-{}", job.id).into()))
        .flex()
        .flex_row()
        .items_start()
        .gap(px(shared::SPACE_4))
        .p(px(shared::SPACE_4))
        .rounded(px(shared::RADIUS_MD))
        .hover(|s| s.bg(rgba(c.hover)))
        .child(div().flex_none().mt(px(shared::SPACE_1)).child(icon))
        .child(body)
        .child(action_btn)
        .into_any_element()
}

pub(crate) fn render_spinner(
    id: impl Into<ElementId>,
    size: f32,
    color: u32,
    reduced: bool,
) -> gpui::AnyElement {
    let icon = svg()
        .path("icons/loader-circle.svg")
        .size(px(size))
        .flex_none()
        .text_color(rgba(color));
    if reduced {
        icon.into_any_element()
    } else {
        icon.with_animation(
            (id.into(), "spin"),
            Animation::new(Duration::from_millis(900)).repeat(),
            |el, delta| el.with_transformation(Transformation::rotate(percentage(delta))),
        )
        .into_any_element()
    }
}

fn render_progress_bar(
    id: impl Into<ElementId>,
    value: Option<f32>,
    c: &PanelColors,
    reduced: bool,
) -> gpui::AnyElement {
    render_progress_bar_raw(id, value, c.accent, c.surface_sunken, reduced)
}

pub(crate) fn render_progress_bar_raw(
    id: impl Into<ElementId>,
    value: Option<f32>,
    accent: u32,
    surface_sunken: u32,
    reduced: bool,
) -> gpui::AnyElement {
    let track = div()
        .relative()
        .w_full()
        .h(px(4.0))
        .rounded(px(shared::RADIUS_FULL))
        .bg(rgba(surface_sunken))
        .overflow_hidden();

    let bar = match value {
        Some(p) => div()
            .absolute()
            .top(px(0.0))
            .bottom(px(0.0))
            .left(px(0.0))
            .w(relative(p.clamp(0.0, 1.0)))
            .rounded(px(shared::RADIUS_FULL))
            .bg(rgba(accent))
            .into_any_element(),
        None => {
            let ind = div()
                .absolute()
                .top(px(0.0))
                .bottom(px(0.0))
                .w(relative(0.35))
                .rounded(px(shared::RADIUS_FULL))
                .bg(rgba(accent));
            if reduced {
                ind.left(relative(0.325)).into_any_element()
            } else {
                ind.with_animation(
                    (id.into(), "indeterminate"),
                    Animation::new(Duration::from_millis(1200))
                        .repeat()
                        .with_easing(cubic_bezier(0.2, 0.0, 0.0, 1.0)),
                    |el, delta| el.left(relative(-0.35 + 1.35 * delta)),
                )
                .into_any_element()
            }
        }
    };

    track.child(bar).into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn meta(id: &str) -> JobMeta {
        JobMeta {
            op_id: id.to_string(),
            title: format!("Title {id}"),
            session_id: Some("sess-1".to_string()),
            silent: false,
        }
    }

    #[test]
    fn buffers_early_events_before_track_and_replays_them() {
        let mut store = JobStore::new();
        assert!(!store.handle_notification(
            "job.progress",
            &json!({"jobId": "j1", "done": 2, "total": 5, "message": "Page 2"}),
        ));
        assert!(!store.handle_notification("job.finished", &json!({"jobId": "j1"})));
        assert!(store.jobs().is_empty());

        store.track("j1", meta("page.rotate"));
        assert_eq!(store.jobs().len(), 1);
        let job = &store.jobs()[0];
        assert_eq!(job.status, JobStatus::Finished);
        assert_eq!(job.done, 5);
        assert_eq!(job.total, 5);
        assert_eq!(job.message, None);
        assert!(job.ended_at_ms.is_some());
        assert_eq!(store.running_count(), 0);
    }

    #[test]
    fn silent_jobs_are_excluded_from_visible_list() {
        let mut store = JobStore::new();
        assert!(!store.handle_notification(
            "job.progress",
            &json!({"jobId": "silent-1", "done": 1, "total": 2}),
        ));
        store.track(
            "silent-1",
            JobMeta {
                op_id: "scan.preview".into(),
                title: "Preview".into(),
                session_id: None,
                silent: true,
            },
        );
        assert!(store.jobs().is_empty());
        assert_eq!(store.running_count(), 0);

        assert!(!store.handle_notification(
            "job.progress",
            &json!({"jobId": "silent-1", "done": 2, "total": 2}),
        ));
        assert!(!store.handle_notification("job.finished", &json!({"jobId": "silent-1"})));
        assert!(store.jobs().is_empty());
    }

    #[test]
    fn progress_and_finished_update_counts_and_clear_message() {
        let mut store = JobStore::new();
        store.track("j1", meta("ocr.run"));
        assert_eq!(store.running_count(), 1);
        assert_eq!(job_progress(&store.jobs()[0]), None);

        assert!(store.handle_notification(
            "job.progress",
            &json!({"jobId": "j1", "done": 3, "total": 10, "message": "3/10"}),
        ));
        assert_eq!(store.jobs()[0].done, 3);
        assert_eq!(store.jobs()[0].total, 10);
        assert_eq!(store.jobs()[0].message.as_deref(), Some("3/10"));
        assert!((job_progress(&store.jobs()[0]).unwrap() - 0.3).abs() < 1e-6);

        assert!(store.handle_notification("job.finished", &json!({"jobId": "j1"})));
        assert_eq!(store.jobs()[0].status, JobStatus::Finished);
        assert_eq!(store.jobs()[0].done, 10);
        assert_eq!(store.jobs()[0].message, None);
        assert_eq!(job_progress(&store.jobs()[0]), Some(1.0));
        assert_eq!(store.running_count(), 0);

        // Finished with total == 0 still normalizes done to 1.
        store.track("j2", meta("doc.save"));
        assert!(store.handle_notification("job.finished", &json!({"jobId": "j2"})));
        assert_eq!(store.jobs()[0].done, 1);
    }

    #[test]
    fn failed_job_retains_error_until_dismissed_or_cleared() {
        let mut store = JobStore::new();
        store.track("j-obj", meta("pdf.merge"));
        assert!(store.handle_notification(
            "job.failed",
            &json!({"jobId": "j-obj", "error": {"code": -32000, "message": "Corrupt PDF"}}),
        ));
        assert_eq!(store.jobs()[0].status, JobStatus::Failed);
        assert_eq!(store.jobs()[0].error.as_deref(), Some("Corrupt PDF"));
        assert!(store.has_failed());

        store.track("j-str", meta("pdf.split"));
        assert!(store.handle_notification(
            "job.failed",
            &json!({"jobId": "j-str", "error": "Disk full"}),
        ));
        assert_eq!(store.jobs()[0].status, JobStatus::Failed);
        assert_eq!(store.jobs()[0].error.as_deref(), Some("Disk full"));

        // Unrelated notification does not wipe retained error.
        assert!(!store.handle_notification("log", &json!({"message": "hi"})));
        assert_eq!(store.jobs()[1].error.as_deref(), Some("Corrupt PDF"));

        store.dismiss("j-obj");
        assert_eq!(store.jobs().len(), 1);
        assert_eq!(store.jobs()[0].id, "j-str");

        store.clear_finished();
        assert!(store.jobs().is_empty());
        assert!(!store.has_failed());
    }

    #[test]
    fn cancelled_job_updates_status_and_dismiss_ignores_running() {
        let mut store = JobStore::new();
        store.track("j-run", meta("page.duplicate"));
        store.dismiss("j-run");
        assert_eq!(store.jobs().len(), 1);
        assert_eq!(store.jobs()[0].status, JobStatus::Running);

        assert!(store.handle_notification("job.cancelled", &json!({"jobId": "j-run"})));
        assert_eq!(store.jobs()[0].status, JobStatus::Cancelled);
        assert_eq!(store.jobs()[0].status.as_str(), "cancelled");
        assert!(store.jobs()[0].ended_at_ms.is_some());
        assert_eq!(store.running_count(), 0);

        store.dismiss("j-run");
        assert!(store.jobs().is_empty());
    }

    #[test]
    fn caps_kept_jobs_at_max_kept_and_dedups_by_id() {
        let mut store = JobStore::new();
        for i in 0..(MAX_KEPT + 5) {
            store.track(format!("job-{i}"), meta(&format!("op-{i}")));
        }
        assert_eq!(store.jobs().len(), MAX_KEPT);
        assert_eq!(store.jobs()[0].id, format!("job-{}", MAX_KEPT + 4));
        assert_eq!(store.jobs()[MAX_KEPT - 1].id, "job-5");

        // Re-tracking an existing job moves it to front without growing past MAX_KEPT.
        store.track("job-5", meta("op-5-again"));
        assert_eq!(store.jobs().len(), MAX_KEPT);
        assert_eq!(store.jobs()[0].id, "job-5");
    }

    #[test]
    fn debug_json_matches_expected_schema() {
        let mut store = JobStore::new();
        store.track("j1", meta("page.rotate"));
        store.handle_notification(
            "job.progress",
            &json!({"jobId": "j1", "done": 1, "total": 4, "message": "Step 1"}),
        );
        store.track("j2", meta("page.delete"));
        store.handle_notification(
            "job.failed",
            &json!({"jobId": "j2", "error": {"message": "Locked"}}),
        );

        let dbg = store.to_debug_json(true);
        assert_eq!(dbg["open"], true);
        assert_eq!(dbg["runningCount"], 1);
        let items = dbg["items"].as_array().expect("items array");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["id"], "j2");
        assert_eq!(items[0]["status"], "failed");
        assert_eq!(items[0]["error"], "Locked");
        assert_eq!(items[0]["progress"], 1.0);
        assert_eq!(items[1]["id"], "j1");
        assert_eq!(items[1]["status"], "running");
        assert_eq!(items[1]["done"], 1);
        assert_eq!(items[1]["total"], 4);
        assert_eq!(items[1]["message"], "Step 1");
        assert!((items[1]["progress"].as_f64().unwrap() - 0.25).abs() < 1e-6);
    }

    #[test]
    fn i18n_keys_for_jobs_resolve_in_vi_and_en() {
        let keys = [
            "jobs.title",
            "jobs.empty",
            "jobs.running",
            "jobs.progress",
            "jobs.cancel",
            "jobs.dismiss",
            "jobs.clearFinished",
            "jobs.status.running",
            "jobs.status.finished",
            "jobs.status.failed",
            "jobs.status.cancelled",
        ];
        for lang in [i18n::Lang::Vi, i18n::Lang::En] {
            for key in keys {
                let text = i18n::translate_in(lang, key, None, &[]);
                assert_ne!(text, key, "missing translation for {key} in {lang:?}");
            }
            let count_text = i18n::translate_in(lang, "jobs.runningCount", Some(2), &[]);
            assert_ne!(count_text, "jobs.runningCount");
            assert!(count_text.contains('2'));
        }
    }

    #[test]
    fn job_status_as_str_matches_i18n_suffixes() {
        assert_eq!(JobStatus::Running.as_str(), "running");
        assert_eq!(JobStatus::Finished.as_str(), "finished");
        assert_eq!(JobStatus::Failed.as_str(), "failed");
        assert_eq!(JobStatus::Cancelled.as_str(), "cancelled");
    }
}
