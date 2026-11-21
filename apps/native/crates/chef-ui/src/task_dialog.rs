//! Khung hộp thoại xử lý dùng chung (TASKS_RUST R5.01, BLUEPRINT_RUST §6.6):
//! bản GPUI của `apps/ui/src/components/TaskDialog.tsx` và `TaskDialog.css`.
//!
//! Bố cục chia hai cột (`minmax(0, 1fr) 300px` ở màn hình rộng, xếp chồng khi viewport `<= 760px`),
//! gồm vùng thiết lập mẫu, tùy chọn chính, danh sách nhiều file, mục "Nâng cao" thu gọn được,
//! cột xem trước + ước tính 300 px, cảnh báo, kết quả, thanh tiến độ khi chạy và hộp xác nhận
//! dừng khi người dùng đóng hộp thoại lúc công việc đang chạy.

use std::rc::Rc;

use chef_theme::{dark, light, shared};
use gpui::{
    AnyElement, App, ElementId, FocusHandle, FontWeight, IntoElement, RenderOnce, SharedString,
    Window, div, prelude::*, px, rgba, svg,
};

use crate::a11y::{self, Registered};
use crate::button::{Button, Size as ButtonSize, Variant, pack, ring};
use crate::choice::{RadioGroup, RadioItem, tab_stop_index};
use crate::dialog::{Dialog, Width};
use crate::jobs_panel::render_progress_bar_raw;
use crate::select::{self, Select};
use crate::{i18n, motion};

/// Chiều rộng mặc định của cột xem trước bên phải (`.task--split`, pixel logic).
pub const DEFAULT_SIDE_WIDTH_PX: f32 = 300.0;

/// Ngưỡng viewport chuyển từ hai cột sang một cột (`@media (max-width: 760px)`).
pub const SPLIT_BREAKPOINT_PX: f32 = 760.0;

/// Thông số bố cục đã giải cho một khung cửa sổ.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TaskLayoutMetrics {
    pub dialog_width: Width,
    pub stacked: bool,
    pub side_width: f32,
}

/// Tính kích thước khung và chế độ chia cột theo `TaskDialog.tsx` / `TaskDialog.css`.
pub fn layout_metrics(
    viewport_width: f32,
    has_side: bool,
    side_width: f32,
    size_override: Option<Width>,
) -> TaskLayoutMetrics {
    let dialog_width = size_override.unwrap_or(if has_side { Width::Xl } else { Width::Lg });
    let stacked = !has_side || viewport_width <= SPLIT_BREAKPOINT_PX;
    TaskLayoutMetrics {
        dialog_width,
        stacked,
        side_width: side_width.max(160.0),
    }
}

/// Phạm vi áp dụng ở chân hộp thoại (`.task__apply`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApplyTo {
    ThisFile,
    MultipleFiles,
}

/// Mức độ hiển thị của khối kết quả sau khi chạy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskResultTone {
    Success,
    Error,
    Cancelled,
    Info,
}

impl TaskResultTone {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskResultTone::Success => "success",
            TaskResultTone::Error => "error",
            TaskResultTone::Cancelled => "cancelled",
            TaskResultTone::Info => "info",
        }
    }
}

/// Tóm tắt kết quả sau khi chạy xong trong `TaskDialog`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskResult {
    pub tone: TaskResultTone,
    pub title: SharedString,
    pub detail: Option<SharedString>,
    pub items: Vec<SharedString>,
}

impl TaskResult {
    pub fn new(tone: TaskResultTone, title: impl Into<SharedString>) -> Self {
        Self {
            tone,
            title: title.into(),
            detail: None,
            items: Vec::new(),
        }
    }

    pub fn success(title: impl Into<SharedString>) -> Self {
        Self::new(TaskResultTone::Success, title)
    }

    pub fn error(title: impl Into<SharedString>) -> Self {
        Self::new(TaskResultTone::Error, title)
    }

    pub fn cancelled(title: impl Into<SharedString>) -> Self {
        Self::new(TaskResultTone::Cancelled, title)
    }

    pub fn info(title: impl Into<SharedString>) -> Self {
        Self::new(TaskResultTone::Info, title)
    }

    pub fn detail(mut self, detail: impl Into<SharedString>) -> Self {
        self.detail = Some(detail.into());
        self
    }

    pub fn items(mut self, items: impl IntoIterator<Item = impl Into<SharedString>>) -> Self {
        self.items = items.into_iter().map(Into::into).collect();
        self
    }
}

/// Quyết định khi người dùng thử đóng hộp thoại (Esc, nút X, hoặc bấm nền).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseDecision {
    CloseNow,
    AskConfirmCancel,
    DismissConfirmPrompt,
}

/// Xác định hành động đóng: chỉ hỏi xác nhận khi công việc đang chạy (R5.01 tiêu chí 3).
pub fn resolve_close_attempt(running: bool, confirm_cancel_open: bool) -> CloseDecision {
    if !running {
        CloseDecision::CloseNow
    } else if !confirm_cancel_open {
        CloseDecision::AskConfirmCancel
    } else {
        CloseDecision::DismissConfirmPrompt
    }
}

/// Chuỗi phần trăm hoặc `"indeterminate"` cho `a11y` của thanh tiến độ.
pub fn progress_a11y_value(progress: Option<f32>) -> String {
    match progress {
        Some(p) => format!("{}%", (p.clamp(0.0, 1.0) * 100.0).round() as u32),
        None => "indeterminate".to_string(),
    }
}

/// Tên tệp ngắn hiển thị trong danh sách nhiều file (hỗ trợ cả `\` và `/`).
pub fn display_basename(path: &str) -> &str {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return path;
    }
    trimmed
        .rsplit(['/', '\\'])
        .next()
        .filter(|segment| !segment.is_empty())
        .unwrap_or(trimmed)
}

pub type ActionCallback = Rc<dyn Fn(&mut Window, &mut App)>;
pub type IndexCallback = Rc<dyn Fn(usize, &mut Window, &mut App)>;
pub type ApplyToCallback = Rc<dyn Fn(ApplyTo, &mut Window, &mut App)>;

/// Mục chọn mẫu thiết lập (`.task__preset-row`) đặt đầu cột chính.
pub struct TaskPreset {
    pub options: Vec<SharedString>,
    pub selected: usize,
    pub width: f32,
    pub on_change: Option<IndexCallback>,
    pub actions: Vec<AnyElement>,
}

impl TaskPreset {
    pub fn new(options: Vec<SharedString>, selected: usize) -> Self {
        Self {
            options,
            selected,
            width: 220.0,
            on_change: None,
            actions: Vec::new(),
        }
    }

    pub fn width(mut self, width: f32) -> Self {
        self.width = width;
        self
    }

    pub fn on_change(mut self, listener: impl Fn(usize, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(listener));
        self
    }

    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.actions.push(action.into_any_element());
        self
    }
}

/// Khối chọn phạm vi "File này / Nhiều file…" và danh sách file xử lý hàng loạt.
pub struct TaskApplyTo {
    pub value: ApplyTo,
    pub this_disabled: bool,
    pub multiple_disabled: bool,
    pub files: Vec<String>,
    pub on_change: Option<ApplyToCallback>,
    pub on_add_files: Option<ActionCallback>,
    pub on_remove_file: Option<IndexCallback>,
}

impl TaskApplyTo {
    pub fn new(value: ApplyTo) -> Self {
        Self {
            value,
            this_disabled: false,
            multiple_disabled: false,
            files: Vec::new(),
            on_change: None,
            on_add_files: None,
            on_remove_file: None,
        }
    }

    pub fn this_disabled(mut self, disabled: bool) -> Self {
        self.this_disabled = disabled;
        self
    }

    pub fn multiple_disabled(mut self, disabled: bool) -> Self {
        self.multiple_disabled = disabled;
        self
    }

    pub fn files(mut self, files: Vec<String>) -> Self {
        self.files = files;
        self
    }

    pub fn on_change(
        mut self,
        listener: impl Fn(ApplyTo, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_change = Some(Rc::new(listener));
        self
    }

    pub fn on_add_files(mut self, listener: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_add_files = Some(Rc::new(listener));
        self
    }

    pub fn on_remove_file(
        mut self,
        listener: impl Fn(usize, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_remove_file = Some(Rc::new(listener));
        self
    }
}

/// Nhóm tùy chọn "Nâng cao" đóng/mở được (`.task__advanced`, `.collapsible`).
pub struct TaskAdvanced {
    pub open: bool,
    pub on_toggle: Option<ActionCallback>,
    pub children: Vec<AnyElement>,
}

impl TaskAdvanced {
    pub fn new(open: bool) -> Self {
        Self {
            open,
            on_toggle: None,
            children: Vec::new(),
        }
    }

    pub fn on_toggle(mut self, listener: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_toggle = Some(Rc::new(listener));
        self
    }

    pub fn child(mut self, child: impl IntoElement) -> Self {
        self.children.push(child.into_any_element());
        self
    }
}

struct TaskColors {
    surface: u32,
    surface_sunken: u32,
    hover: u32,
    border: u32,
    divider: u32,
    text: u32,
    text_2: u32,
    text_3: u32,
    accent: u32,
    accent_soft: u32,
    accent_text: u32,
    success: u32,
    success_soft: u32,
    warning: u32,
    warning_soft: u32,
    danger: u32,
    danger_soft: u32,
    focus: u32,
}

impl TaskColors {
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
                accent_soft: pack(dark::C_ACCENT_SOFT),
                accent_text: pack(dark::C_ACCENT_TEXT),
                success: pack(dark::C_SUCCESS),
                success_soft: pack(dark::C_SUCCESS_SOFT),
                warning: pack(dark::C_WARNING),
                warning_soft: pack(dark::C_WARNING_SOFT),
                danger: pack(dark::C_DANGER),
                danger_soft: pack(dark::C_DANGER_SOFT),
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
                accent_soft: pack(light::C_ACCENT_SOFT),
                accent_text: pack(light::C_ACCENT_TEXT),
                success: pack(light::C_SUCCESS),
                success_soft: pack(light::C_SUCCESS_SOFT),
                warning: pack(light::C_WARNING),
                warning_soft: pack(light::C_WARNING_SOFT),
                danger: pack(light::C_DANGER),
                danger_soft: pack(light::C_DANGER_SOFT),
                focus: pack(light::C_FOCUS),
            }
        }
    }
}

/// Quyết định có cần khôi phục tiêu điểm về bên trong hộp thoại hay không (tránh mất phím `Esc`
/// khi phần tử đang giữ tiêu điểm bị gỡ khỏi cây phần tử hoặc khi mới mở hộp thoại bằng chuột).
#[allow(clippy::too_many_arguments)]
pub(crate) fn should_recover_focus(
    any_live_focused: bool,
    opener_focused: bool,
    window_unfocused: bool,
    was_running: bool,
    running: bool,
    was_confirm_cancel: bool,
    confirm_cancel_open: bool,
    prev_file_count: usize,
    file_count: usize,
) -> bool {
    if any_live_focused {
        return false;
    }
    let focus_lost_on_transition = (was_running && !running)
        || (was_confirm_cancel && !confirm_cancel_open)
        || (prev_file_count > file_count);
    opener_focused || window_unfocused || focus_lost_on_transition
}

struct TaskDialogFocusState {
    close: FocusHandle,
    advanced_toggle: FocusHandle,
    apply_this: FocusHandle,
    apply_multiple: FocusHandle,
    add_files: FocusHandle,
    file_removes: Vec<FocusHandle>,
    save_step: FocusHandle,
    cancel_or_stop: FocusHandle,
    run: FocusHandle,
    confirm_keep: FocusHandle,
    confirm_stop: FocusHandle,
    was_running: bool,
    was_confirm_cancel: bool,
    prev_file_count: usize,
}

impl TaskDialogFocusState {
    fn new(cx: &mut App) -> Self {
        Self {
            close: cx.focus_handle(),
            advanced_toggle: cx.focus_handle(),
            apply_this: cx.focus_handle(),
            apply_multiple: cx.focus_handle(),
            add_files: cx.focus_handle(),
            file_removes: Vec::new(),
            save_step: cx.focus_handle(),
            cancel_or_stop: cx.focus_handle(),
            run: cx.focus_handle(),
            confirm_keep: cx.focus_handle(),
            confirm_stop: cx.focus_handle(),
            was_running: false,
            was_confirm_cancel: false,
            prev_file_count: 0,
        }
    }

    fn ensure_file_removes(&mut self, count: usize, cx: &mut App) {
        while self.file_removes.len() < count {
            self.file_removes.push(cx.focus_handle());
        }
    }
}

/// Khung hộp thoại xử lý dùng chung (R5.01): cột chính, cột phụ xem trước/ước tính 300 px,
/// tùy chọn nâng cao, cảnh báo, kết quả, tiến độ và xác nhận dừng khi đóng lúc đang chạy.
#[derive(IntoElement)]
pub struct TaskDialog {
    id: SharedString,
    title: SharedString,
    icon: Option<SharedString>,
    description: Option<SharedString>,
    size: Option<Width>,
    side_width: f32,
    dark: bool,
    preset: Option<TaskPreset>,
    children: Vec<AnyElement>,
    advanced: Option<TaskAdvanced>,
    preview: Option<AnyElement>,
    estimate: Option<AnyElement>,
    warnings: Vec<SharedString>,
    result: Option<TaskResult>,
    apply_to: Option<TaskApplyTo>,
    run_label: Option<SharedString>,
    can_run: bool,
    running: bool,
    progress: Option<f32>,
    progress_label: Option<SharedString>,
    confirm_cancel_open: bool,
    show_save_workflow_step: bool,
    workflow_step_enabled: bool,
    on_save_workflow_step: Option<ActionCallback>,
    on_run: Option<ActionCallback>,
    on_cancel_run: Option<ActionCallback>,
    on_close: Option<ActionCallback>,
    on_request_cancel_confirm: Option<ActionCallback>,
    on_keep_running: Option<ActionCallback>,
    on_confirm_cancel_close: Option<ActionCallback>,
    tab_order: Vec<FocusHandle>,
    advanced_tab_order: Vec<FocusHandle>,
    return_focus: Option<FocusHandle>,
}

impl TaskDialog {
    /// Tạo khung `TaskDialog` với `id` ổn định cho kênh debug/E2E và tiêu đề hiển thị.
    pub fn new(id: impl Into<SharedString>, title: impl Into<SharedString>, dark: bool) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            icon: None,
            description: None,
            size: None,
            side_width: DEFAULT_SIDE_WIDTH_PX,
            dark,
            preset: None,
            children: Vec::new(),
            advanced: None,
            preview: None,
            estimate: None,
            warnings: Vec::new(),
            result: None,
            apply_to: None,
            run_label: None,
            can_run: true,
            running: false,
            progress: None,
            progress_label: None,
            confirm_cancel_open: false,
            show_save_workflow_step: true,
            workflow_step_enabled: false,
            on_save_workflow_step: None,
            on_run: None,
            on_cancel_run: None,
            on_close: None,
            on_request_cancel_confirm: None,
            on_keep_running: None,
            on_confirm_cancel_close: None,
            tab_order: Vec::new(),
            advanced_tab_order: Vec::new(),
            return_focus: None,
        }
    }

    pub fn icon(mut self, path: impl Into<SharedString>) -> Self {
        self.icon = Some(path.into());
        self
    }

    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    pub fn size(mut self, size: Width) -> Self {
        self.size = Some(size);
        self
    }

    pub fn side_width(mut self, width: f32) -> Self {
        self.side_width = width;
        self
    }

    pub fn preset(mut self, preset: TaskPreset) -> Self {
        self.preset = Some(preset);
        self
    }

    pub fn child(mut self, child: impl IntoElement) -> Self {
        self.children.push(child.into_any_element());
        self
    }

    pub fn advanced(mut self, advanced: TaskAdvanced) -> Self {
        self.advanced = Some(advanced);
        self
    }

    pub fn preview(mut self, preview: impl IntoElement) -> Self {
        self.preview = Some(preview.into_any_element());
        self
    }

    pub fn estimate(mut self, estimate: impl IntoElement) -> Self {
        self.estimate = Some(estimate.into_any_element());
        self
    }

    pub fn warnings(mut self, warnings: impl IntoIterator<Item = impl Into<SharedString>>) -> Self {
        self.warnings = warnings.into_iter().map(Into::into).collect();
        self
    }

    pub fn result(mut self, result: TaskResult) -> Self {
        self.result = Some(result);
        self
    }

    pub fn apply_to(mut self, apply_to: TaskApplyTo) -> Self {
        self.apply_to = Some(apply_to);
        self
    }

    pub fn run_label(mut self, label: impl Into<SharedString>) -> Self {
        self.run_label = Some(label.into());
        self
    }

    pub fn can_run(mut self, can_run: bool) -> Self {
        self.can_run = can_run;
        self
    }

    pub fn running(mut self, running: bool) -> Self {
        self.running = running;
        self
    }

    pub fn progress(mut self, progress: Option<f32>) -> Self {
        self.progress = progress;
        self
    }

    pub fn progress_label(mut self, label: impl Into<SharedString>) -> Self {
        self.progress_label = Some(label.into());
        self
    }

    pub fn confirm_cancel_open(mut self, open: bool) -> Self {
        self.confirm_cancel_open = open;
        self
    }

    pub fn show_save_workflow_step(mut self, show: bool) -> Self {
        self.show_save_workflow_step = show;
        self
    }

    pub fn workflow_step_enabled(mut self, enabled: bool) -> Self {
        self.workflow_step_enabled = enabled;
        self
    }

    pub fn on_save_workflow_step(
        mut self,
        listener: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_save_workflow_step = Some(Rc::new(listener));
        self
    }

    pub fn on_run(mut self, listener: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_run = Some(Rc::new(listener));
        self
    }

    pub fn on_cancel_run(mut self, listener: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_cancel_run = Some(Rc::new(listener));
        self
    }

    pub fn on_close(mut self, listener: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_close = Some(Rc::new(listener));
        self
    }

    pub fn on_request_cancel_confirm(
        mut self,
        listener: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_request_cancel_confirm = Some(Rc::new(listener));
        self
    }

    pub fn on_keep_running(mut self, listener: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_keep_running = Some(Rc::new(listener));
        self
    }

    pub fn on_confirm_cancel_close(
        mut self,
        listener: impl Fn(&mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_confirm_cancel_close = Some(Rc::new(listener));
        self
    }

    /// Thứ tự Tab cho các điều khiển tùy chọn trong cột chính.
    pub fn tab_order(mut self, order: Vec<FocusHandle>) -> Self {
        self.tab_order = order;
        self
    }

    /// Thứ tự Tab cho các điều khiển bên trong mục "Nâng cao" (chỉ đi qua khi đang mở).
    pub fn advanced_tab_order(mut self, order: Vec<FocusHandle>) -> Self {
        self.advanced_tab_order = order;
        self
    }

    pub fn return_focus(mut self, focus: FocusHandle) -> Self {
        self.return_focus = Some(focus);
        self
    }
}

impl RenderOnce for TaskDialog {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let TaskDialog {
            id,
            title,
            icon,
            description,
            size,
            side_width,
            dark: is_dark,
            preset,
            children,
            advanced,
            preview,
            estimate,
            warnings,
            result,
            apply_to,
            run_label,
            can_run,
            running,
            progress,
            progress_label,
            confirm_cancel_open,
            show_save_workflow_step,
            workflow_step_enabled,
            on_save_workflow_step,
            on_run,
            on_cancel_run,
            on_close,
            on_request_cancel_confirm,
            on_keep_running,
            on_confirm_cancel_close,
            tab_order,
            advanced_tab_order,
            return_focus,
        } = self;

        let c = TaskColors::of(is_dark);
        let reduced = motion::reduced();
        let has_side = preview.is_some() || estimate.is_some();
        let metrics = layout_metrics(
            window.viewport_size().width.as_f32(),
            has_side,
            side_width,
            size,
        );

        let file_count = apply_to.as_ref().map_or(0, |a| a.files.len());
        let focus_state = window.use_keyed_state(
            ElementId::Name(format!("{id}-focus-state").into()),
            cx,
            |_, cx| TaskDialogFocusState::new(cx),
        );
        let (
            close_focus,
            adv_focus,
            apply_this_focus,
            apply_multiple_focus,
            add_files_focus,
            file_remove_focuses,
            save_step_focus,
            cancel_or_stop_focus,
            run_focus,
            confirm_keep_focus,
            confirm_stop_focus,
            was_running,
            was_confirm_cancel,
            prev_file_count,
        ) = focus_state.update(cx, |s, cx| {
            s.ensure_file_removes(file_count, cx);
            let prev = (s.was_running, s.was_confirm_cancel, s.prev_file_count);
            s.was_running = running;
            s.was_confirm_cancel = confirm_cancel_open;
            s.prev_file_count = file_count;
            (
                s.close.clone(),
                s.advanced_toggle.clone(),
                s.apply_this.clone(),
                s.apply_multiple.clone(),
                s.add_files.clone(),
                s.file_removes[..file_count].to_vec(),
                s.save_step.clone(),
                s.cancel_or_stop.clone(),
                s.run.clone(),
                s.confirm_keep.clone(),
                s.confirm_stop.clone(),
                prev.0,
                prev.1,
                prev.2,
            )
        });

        // Lắp đặt thứ tự Tab hoàn chỉnh theo thứ tự hiển thị, bỏ qua các nút đang bị vô hiệu.
        let mut full_tab_order: Vec<FocusHandle> = Vec::new();
        let preset_id = format!("{id}-preset");
        if preset.is_some() {
            full_tab_order.push(select::trigger_focus(preset_id.clone(), window, cx));
        }
        full_tab_order.extend(tab_order);
        let show_multiple_files = apply_to
            .as_ref()
            .is_some_and(|a| a.value == ApplyTo::MultipleFiles);
        if show_multiple_files {
            full_tab_order.extend(file_remove_focuses.iter().cloned());
            full_tab_order.push(add_files_focus.clone());
        }
        if let Some(adv) = &advanced {
            full_tab_order.push(adv_focus.clone());
            if adv.open {
                full_tab_order.extend(advanced_tab_order);
            }
        }
        if running && confirm_cancel_open {
            full_tab_order.push(confirm_keep_focus.clone());
            full_tab_order.push(confirm_stop_focus.clone());
        }
        if let Some(apply) = &apply_to {
            let enabled = [
                !(running || apply.this_disabled),
                !(running || apply.multiple_disabled),
            ];
            let selected = Some(match apply.value {
                ApplyTo::ThisFile => 0,
                ApplyTo::MultipleFiles => 1,
            });
            if let Some(idx) = tab_stop_index(&enabled, selected) {
                full_tab_order.push(if idx == 0 {
                    apply_this_focus.clone()
                } else {
                    apply_multiple_focus.clone()
                });
            }
        }
        if show_save_workflow_step && workflow_step_enabled && !running {
            full_tab_order.push(save_step_focus.clone());
        }
        if !running || on_cancel_run.is_some() {
            full_tab_order.push(cancel_or_stop_focus.clone());
        }
        if can_run && !running {
            full_tab_order.push(run_focus.clone());
        }

        let any_live_focused =
            close_focus.is_focused(window) || full_tab_order.iter().any(|h| h.is_focused(window));
        let opener_focused = return_focus
            .as_ref()
            .is_some_and(|ret| ret.is_focused(window));
        let window_unfocused = window.focused(cx).is_none();
        if should_recover_focus(
            any_live_focused,
            opener_focused,
            window_unfocused,
            was_running,
            running,
            was_confirm_cancel,
            confirm_cancel_open,
            prev_file_count,
            file_count,
        ) {
            let fallback = if prev_file_count > file_count && show_multiple_files {
                add_files_focus.clone()
            } else if was_confirm_cancel
                && !confirm_cancel_open
                && running
                && on_cancel_run.is_some()
            {
                cancel_or_stop_focus.clone()
            } else {
                close_focus.clone()
            };
            window.defer(cx, move |window, cx| {
                window.focus(&fallback, cx);
                window.refresh();
            });
        }

        let mut main_col = div().flex().flex_col().gap(px(shared::SPACE_6)).min_w_0();
        main_col = if metrics.stacked {
            main_col.w_full()
        } else {
            main_col.flex_1()
        };

        if let Some(p) = preset {
            main_col = main_col.child(render_preset_field(&preset_id, p, &c, is_dark));
        }

        if !children.is_empty() {
            main_col = main_col.child(
                div()
                    .flex()
                    .flex_col()
                    .gap(px(shared::SPACE_6))
                    .children(children),
            );
        }

        if let Some(apply) = &apply_to
            && apply.value == ApplyTo::MultipleFiles
        {
            main_col = main_col.child(render_files_section(
                &id,
                apply,
                &add_files_focus,
                &file_remove_focuses,
                &c,
                is_dark,
            ));
        }

        if let Some(adv) = advanced {
            main_col = main_col.child(render_advanced_section(&id, adv, &adv_focus, &c, window));
        }

        let side_col = if has_side {
            Some(render_side_column(
                preview,
                estimate,
                metrics.stacked,
                metrics.side_width,
                &c,
            ))
        } else {
            None
        };

        let main_id = format!("{id}-main");
        let side_id = format!("{id}-side");
        a11y::register(Registered {
            id: main_id.clone(),
            role: "region",
            name: title.to_string(),
            disabled: false,
            focused: false,
            hovered: false,
            checked: None,
            value: None,
            bounds: None,
        });
        if has_side {
            a11y::register(Registered {
                id: side_id.clone(),
                role: "complementary",
                name: i18n::t("task.preview"),
                disabled: false,
                focused: false,
                hovered: false,
                checked: None,
                value: None,
                bounds: None,
            });
        }

        let split_container = if metrics.stacked {
            div().flex().flex_col().gap(px(shared::SPACE_6))
        } else {
            div()
                .flex()
                .flex_row()
                .items_start()
                .gap(px(shared::SPACE_8))
        };
        let split_el = split_container
            .child(main_col)
            .children(side_col)
            .on_children_prepainted(move |bounds, _, _| {
                if let Some(b) = bounds.first() {
                    a11y::set_bounds(&main_id, *b);
                }
                if has_side && let Some(b) = bounds.get(1) {
                    a11y::set_bounds(&side_id, *b);
                }
            });

        let mut dialog = Dialog::new(id.clone(), title, metrics.dialog_width, is_dark)
            .close(format!("{id}-close"), close_focus, i18n::t("common.close"))
            .tab_order(full_tab_order)
            .scrollable(true)
            .dismiss_on_outside(!(running && confirm_cancel_open))
            .return_focus_on_dismiss(!running);
        if let Some(icon_path) = icon {
            dialog = dialog.icon(icon_path);
        }
        if let Some(desc) = description {
            dialog = dialog.description(desc);
        }
        if let Some(ret) = &return_focus {
            dialog = dialog.return_focus(ret.clone());
        }

        dialog = dialog.on_dismiss({
            let confirm_keep_focus = confirm_keep_focus.clone();
            let on_close = on_close.clone();
            let on_keep_running = on_keep_running.clone();
            move |window, cx| match resolve_close_attempt(running, confirm_cancel_open) {
                CloseDecision::CloseNow => {
                    if let Some(cb) = &on_close {
                        cb(window, cx);
                    }
                }
                CloseDecision::AskConfirmCancel => {
                    if let Some(cb) = &on_request_cancel_confirm {
                        cb(window, cx);
                    }
                    let focus = confirm_keep_focus.clone();
                    window.defer(cx, move |window, cx| window.focus(&focus, cx));
                }
                CloseDecision::DismissConfirmPrompt => {
                    if let Some(cb) = &on_keep_running {
                        cb(window, cx);
                    }
                }
            }
        });

        dialog = dialog.child(split_el);

        if !warnings.is_empty() {
            dialog = dialog.child(render_warnings(&id, &warnings, &c));
        }

        if let Some(res) = result {
            dialog = dialog.child(render_result(&id, res, &c));
        }

        if running {
            dialog = dialog.child(render_progress(&id, progress, progress_label, &c, reduced));
        }

        if running && confirm_cancel_open {
            dialog = dialog.child(render_cancel_confirm(
                &id,
                &confirm_keep_focus,
                &confirm_stop_focus,
                return_focus.clone(),
                on_keep_running.clone(),
                on_confirm_cancel_close.clone(),
                &c,
                is_dark,
            ));
        }

        if let Some(apply) = apply_to {
            dialog = dialog.footer_leading(render_apply_to_footer(
                &id,
                &apply,
                running,
                &apply_this_focus,
                &apply_multiple_focus,
                &c,
                is_dark,
            ));
        }

        if show_save_workflow_step {
            let mut save_btn = Button::new(format!("{id}-save-step"), save_step_focus)
                .variant(Variant::Ghost)
                .icon("icons/workflow.svg")
                .label(i18n::t("task.saveAsStep"))
                .disabled(!workflow_step_enabled || running)
                .dark(is_dark);
            if let Some(cb) = on_save_workflow_step {
                save_btn = save_btn.on_click(move |_, window, cx| cb(window, cx));
            }
            dialog = dialog.action(save_btn);
        }

        if running && let Some(cancel_cb) = on_cancel_run {
            let stop_btn = Button::new(format!("{id}-stop"), cancel_or_stop_focus)
                .variant(Variant::Secondary)
                .label(i18n::t("task.stop"))
                .dark(is_dark)
                .on_click(move |_, window, cx| cancel_cb(window, cx));
            dialog = dialog.action(stop_btn);
        } else {
            let mut cancel_btn = Button::new(format!("{id}-cancel"), cancel_or_stop_focus)
                .variant(Variant::Secondary)
                .label(i18n::t("common.cancel"))
                .disabled(running)
                .dark(is_dark);
            let ret = return_focus;
            let close_cb = on_close;
            cancel_btn = cancel_btn.on_click(move |_, window, cx| {
                if let Some(focus) = &ret {
                    window.focus(focus, cx);
                }
                if let Some(cb) = &close_cb {
                    cb(window, cx);
                }
            });
            dialog = dialog.action(cancel_btn);
        }

        let mut run_btn = Button::new(format!("{id}-run"), run_focus)
            .variant(Variant::Primary)
            .label(run_label.unwrap_or_else(|| i18n::t("task.run").into()))
            .disabled(!can_run)
            .loading(running)
            .dark(is_dark);
        if let Some(run_cb) = on_run {
            run_btn = run_btn.on_click(move |_, window, cx| run_cb(window, cx));
        }
        dialog = dialog.action(run_btn);

        dialog
    }
}

fn render_preset_field(
    preset_id: &str,
    preset: TaskPreset,
    c: &TaskColors,
    is_dark: bool,
) -> gpui::Div {
    let label = i18n::t("task.preset");
    let mut select = Select::new(preset_id.to_string(), label.clone(), preset.options)
        .selected(preset.selected)
        .width(preset.width)
        .dark(is_dark);
    if let Some(on_change) = preset.on_change {
        select = select.on_change(move |idx, window, cx| on_change(idx, window, cx));
    }

    div()
        .flex()
        .flex_col()
        .gap(px(shared::SPACE_3))
        .child(
            div()
                .text_size(px(shared::TEXT_SM))
                .font_weight(FontWeight::MEDIUM)
                .text_color(rgba(c.text_2))
                .child(label),
        )
        .child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .flex_wrap()
                .gap(px(shared::SPACE_4))
                .child(select)
                .children(preset.actions),
        )
}

fn render_files_section(
    id: &str,
    apply: &TaskApplyTo,
    add_files_focus: &FocusHandle,
    remove_focuses: &[FocusHandle],
    c: &TaskColors,
    is_dark: bool,
) -> gpui::Div {
    let mut section = div()
        .flex()
        .flex_col()
        .items_start()
        .gap(px(shared::SPACE_4))
        .child(
            div()
                .text_size(px(shared::TEXT_SM))
                .font_weight(FontWeight::MEDIUM)
                .text_color(rgba(c.text_2))
                .child(i18n::t("task.files")),
        );

    if apply.files.is_empty() {
        section = section.child(
            div()
                .text_size(px(shared::TEXT_SM))
                .text_color(rgba(c.text_3))
                .child(i18n::t("task.noFiles")),
        );
    } else {
        let mut list = div().w_full().flex().flex_col();
        for (i, path) in apply.files.iter().enumerate() {
            let row_id = ElementId::Name(format!("{id}-file-row-{i}").into());
            let mut remove_btn =
                Button::new(format!("{id}-file-remove-{i}"), remove_focuses[i].clone())
                    .variant(Variant::Ghost)
                    .size(ButtonSize::Sm)
                    .icon("icons/x.svg")
                    .aria_label(i18n::t("common.remove"))
                    .dark(is_dark);
            if let Some(on_remove) = &apply.on_remove_file {
                let on_remove = on_remove.clone();
                remove_btn = remove_btn.on_click(move |_, window, cx| on_remove(i, window, cx));
            }
            list = list.child(
                div()
                    .id(row_id)
                    .w_full()
                    .flex()
                    .flex_row()
                    .items_center()
                    .justify_between()
                    .gap(px(shared::SPACE_3))
                    .pl(px(shared::SPACE_4))
                    .pr(px(shared::SPACE_2))
                    .py(px(shared::SPACE_2))
                    .rounded(px(shared::RADIUS_SM))
                    .hover(|s| s.bg(rgba(c.hover)))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .text_size(px(shared::TEXT_SM))
                            .text_color(rgba(c.text))
                            .child(display_basename(path).to_string()),
                    )
                    .child(remove_btn),
            );
        }
        section = section.child(list);
    }

    let mut add_btn = Button::new(format!("{id}-add-files"), add_files_focus.clone())
        .variant(Variant::Secondary)
        .size(ButtonSize::Sm)
        .icon("icons/file-plus.svg")
        .label(i18n::t("task.addFiles"))
        .dark(is_dark);
    if let Some(on_add) = &apply.on_add_files {
        let on_add = on_add.clone();
        add_btn = add_btn.on_click(move |_, window, cx| on_add(window, cx));
    }

    section.child(add_btn)
}

fn render_advanced_section(
    id: &str,
    adv: TaskAdvanced,
    focus: &FocusHandle,
    c: &TaskColors,
    window: &Window,
) -> gpui::Div {
    let toggle_id = format!("{id}-advanced-toggle");
    let label = i18n::t("task.advanced");
    a11y::register(Registered {
        id: toggle_id.clone(),
        role: "button",
        name: label.clone(),
        disabled: false,
        focused: focus.is_focused(window),
        hovered: false,
        checked: Some(if adv.open { "true" } else { "false" }),
        value: None,
        bounds: None,
    });

    let icon_path = if adv.open {
        "icons/chevron-down.svg"
    } else {
        "icons/chevron-right.svg"
    };
    let text_color = c.text;
    let text_2 = c.text_2;
    let mut trigger = div()
        .id(ElementId::Name(toggle_id.clone().into()))
        .track_focus(&focus.clone().tab_stop(true))
        .flex()
        .flex_row()
        .items_center()
        .gap(px(shared::SPACE_2))
        .h(px(shared::CONTROL_H_SM))
        .pr(px(shared::SPACE_2))
        .rounded(px(shared::RADIUS_SM))
        .cursor_pointer()
        .text_size(px(shared::TEXT_MD))
        .font_weight(FontWeight::MEDIUM)
        .text_color(rgba(text_2))
        .hover(move |s| s.text_color(rgba(text_color)))
        .focus_visible(|s| s.shadow(vec![ring(c.surface, 2.0), ring(c.focus, 4.0)]))
        .child(
            svg()
                .path(icon_path)
                .size(px(15.0))
                .flex_none()
                .text_color(rgba(text_2)),
        )
        .child(label);
    if let Some(on_toggle) = adv.on_toggle {
        trigger = trigger.on_click(move |_, window, cx| on_toggle(window, cx));
    }

    let trigger_wrap = div()
        .flex()
        .items_center()
        .child(trigger)
        .on_children_prepainted(move |bounds, _, _| {
            if let Some(b) = bounds.first() {
                a11y::set_bounds(&toggle_id, *b);
            }
        });

    let mut block = div()
        .pt(px(shared::SPACE_5))
        .border_t_1()
        .border_color(rgba(c.divider))
        .flex()
        .flex_col()
        .child(trigger_wrap);

    if adv.open {
        block = block.child(
            div()
                .pt(px(shared::SPACE_4))
                .pl(px(shared::SPACE_7))
                .flex()
                .flex_col()
                .gap(px(shared::SPACE_4))
                .children(adv.children),
        );
    }

    block
}

fn render_side_column(
    preview: Option<AnyElement>,
    estimate: Option<AnyElement>,
    stacked: bool,
    side_width: f32,
    c: &TaskColors,
) -> gpui::Div {
    let mut side = div().flex().flex_col().gap(px(shared::SPACE_5)).min_w_0();
    side = if stacked {
        side.w_full()
    } else {
        side.flex_none().w(px(side_width))
    };

    if let Some(preview_el) = preview {
        side = side.child(
            div()
                .p(px(shared::SPACE_5))
                .rounded(px(shared::RADIUS_LG))
                .bg(rgba(c.surface_sunken))
                .border_1()
                .border_color(rgba(c.border))
                .min_h(px(140.0))
                .flex()
                .flex_col()
                .child(
                    div()
                        .mb(px(shared::SPACE_4))
                        .text_size(px(shared::TEXT_SM))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(rgba(c.text_2))
                        .child(i18n::t("task.preview")),
                )
                .child(preview_el),
        );
    }

    if let Some(estimate_el) = estimate {
        side = side.child(
            div()
                .flex()
                .flex_row()
                .items_center()
                .flex_wrap()
                .gap(px(shared::SPACE_2))
                .text_size(px(shared::TEXT_SM))
                .text_color(rgba(c.text))
                .child(
                    div()
                        .text_color(rgba(c.text_3))
                        .child(i18n::t("task.estimate")),
                )
                .child(estimate_el),
        );
    }

    side
}

fn render_warnings(id: &str, warnings: &[SharedString], c: &TaskColors) -> gpui::Div {
    let key = format!("{id}-warnings");
    a11y::register(Registered {
        id: key.clone(),
        role: "alert",
        name: warnings[0].to_string(),
        disabled: false,
        focused: false,
        hovered: false,
        checked: None,
        value: Some(warnings.len().to_string()),
        bounds: None,
    });

    let rows = warnings.iter().enumerate().map(|(i, w)| {
        div()
            .when(i > 0, |d| d.mt(px(shared::SPACE_3)))
            .flex()
            .flex_row()
            .items_start()
            .gap(px(shared::SPACE_4))
            .child(
                svg()
                    .path("icons/triangle-alert.svg")
                    .size(px(15.0))
                    .flex_none()
                    .mt(px(shared::SPACE_1))
                    .text_color(rgba(c.warning)),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_size(px(shared::TEXT_SM))
                    .text_color(rgba(c.text))
                    .child(w.clone()),
            )
    });

    div()
        .mt(px(shared::SPACE_6))
        .child(
            div()
                .px(px(shared::SPACE_5))
                .py(px(shared::SPACE_4))
                .rounded(px(shared::RADIUS_MD))
                .bg(rgba(c.warning_soft))
                .flex()
                .flex_col()
                .children(rows),
        )
        .on_children_prepainted(move |bounds, _, _| {
            if let Some(b) = bounds.first() {
                a11y::set_bounds(&key, *b);
            }
        })
}

fn render_result(id: &str, res: TaskResult, c: &TaskColors) -> gpui::Div {
    let key = format!("{id}-result");
    a11y::register(Registered {
        id: key.clone(),
        role: "status",
        name: res.title.to_string(),
        disabled: false,
        focused: false,
        hovered: false,
        checked: None,
        value: Some(res.tone.as_str().to_string()),
        bounds: None,
    });

    let (bg, icon_color, icon_path) = match res.tone {
        TaskResultTone::Success => (c.success_soft, c.success, "icons/circle-check.svg"),
        TaskResultTone::Error => (c.danger_soft, c.danger, "icons/circle-alert.svg"),
        TaskResultTone::Cancelled => (c.surface_sunken, c.text_3, "icons/ban.svg"),
        TaskResultTone::Info => (c.accent_soft, c.accent_text, "icons/info.svg"),
    };

    let mut content = div()
        .flex_1()
        .min_w_0()
        .flex()
        .flex_col()
        .gap(px(shared::SPACE_1))
        .child(
            div()
                .text_size(px(shared::TEXT_SM))
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(rgba(c.text))
                .child(res.title),
        );
    if let Some(detail) = res.detail {
        content = content.child(
            div()
                .text_size(px(shared::TEXT_SM))
                .text_color(rgba(c.text_2))
                .child(detail),
        );
    }
    if !res.items.is_empty() {
        let item_rows = res.items.into_iter().map(|item| {
            div()
                .text_size(px(shared::TEXT_XS))
                .text_color(rgba(c.text_2))
                .child(format!("• {item}"))
        });
        content = content.child(
            div()
                .mt(px(shared::SPACE_1))
                .flex()
                .flex_col()
                .children(item_rows),
        );
    }

    div()
        .mt(px(shared::SPACE_6))
        .child(
            div()
                .px(px(shared::SPACE_5))
                .py(px(shared::SPACE_4))
                .rounded(px(shared::RADIUS_MD))
                .bg(rgba(bg))
                .flex()
                .flex_row()
                .items_start()
                .gap(px(shared::SPACE_4))
                .child(
                    svg()
                        .path(icon_path)
                        .size(px(16.0))
                        .flex_none()
                        .mt(px(shared::SPACE_1))
                        .text_color(rgba(icon_color)),
                )
                .child(content),
        )
        .on_children_prepainted(move |bounds, _, _| {
            if let Some(b) = bounds.first() {
                a11y::set_bounds(&key, *b);
            }
        })
}

fn render_progress(
    id: &str,
    progress: Option<f32>,
    label: Option<SharedString>,
    c: &TaskColors,
    reduced: bool,
) -> gpui::Div {
    let key = format!("{id}-progress");
    let display_label = label.unwrap_or_else(|| i18n::t("jobs.running").into());
    let a11y_value = progress_a11y_value(progress);
    a11y::register(Registered {
        id: key.clone(),
        role: "progressbar",
        name: display_label.to_string(),
        disabled: false,
        focused: false,
        hovered: false,
        checked: None,
        value: Some(a11y_value.clone()),
        bounds: None,
    });

    let mut header = div()
        .flex()
        .flex_row()
        .items_center()
        .justify_between()
        .text_size(px(shared::TEXT_XS))
        .text_color(rgba(c.text_2))
        .child(display_label);
    if progress.is_some() {
        header = header.child(a11y_value);
    }

    div()
        .mt(px(shared::SPACE_6))
        .child(
            div()
                .flex()
                .flex_col()
                .gap(px(shared::SPACE_2))
                .child(header)
                .child(render_progress_bar_raw(
                    format!("{id}-progress-bar"),
                    progress,
                    c.accent,
                    c.surface_sunken,
                    reduced,
                )),
        )
        .on_children_prepainted(move |bounds, _, _| {
            if let Some(b) = bounds.first() {
                a11y::set_bounds(&key, *b);
            }
        })
}

#[allow(clippy::too_many_arguments)]
fn render_cancel_confirm(
    id: &str,
    keep_focus: &FocusHandle,
    stop_focus: &FocusHandle,
    return_focus: Option<FocusHandle>,
    on_keep_running: Option<ActionCallback>,
    on_confirm_cancel_close: Option<ActionCallback>,
    c: &TaskColors,
    is_dark: bool,
) -> gpui::Div {
    let key = format!("{id}-cancel-confirm");
    let title = i18n::t("task.closeRunningTitle");
    let message = i18n::t("task.closeRunningMessage");
    a11y::register(Registered {
        id: key.clone(),
        role: "alertdialog",
        name: title.clone(),
        disabled: false,
        focused: false,
        hovered: false,
        checked: None,
        value: Some(message.clone()),
        bounds: None,
    });

    let mut keep_btn = Button::new(format!("{id}-confirm-keep"), keep_focus.clone())
        .variant(Variant::Secondary)
        .size(ButtonSize::Sm)
        .label(i18n::t("task.keepRunning"))
        .dark(is_dark);
    if let Some(cb) = on_keep_running {
        keep_btn = keep_btn.on_click(move |_, window, cx| cb(window, cx));
    }

    let mut stop_btn = Button::new(format!("{id}-confirm-stop"), stop_focus.clone())
        .variant(Variant::Danger)
        .size(ButtonSize::Sm)
        .label(i18n::t("task.stopAndClose"))
        .dark(is_dark)
        .on_click(move |_, window, cx| {
            if let Some(focus) = &return_focus {
                window.focus(focus, cx);
            }
            if let Some(cb) = &on_confirm_cancel_close {
                cb(window, cx);
            }
        });
    let _ = &mut stop_btn;

    div()
        .mt(px(shared::SPACE_6))
        .child(
            div()
                .p(px(shared::SPACE_5))
                .rounded(px(shared::RADIUS_MD))
                .border_1()
                .border_color(rgba(c.danger))
                .bg(rgba(c.danger_soft))
                .flex()
                .flex_col()
                .gap(px(shared::SPACE_4))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_start()
                        .gap(px(shared::SPACE_4))
                        .child(
                            svg()
                                .path("icons/triangle-alert.svg")
                                .size(px(16.0))
                                .flex_none()
                                .mt(px(shared::SPACE_1))
                                .text_color(rgba(c.danger)),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .flex()
                                .flex_col()
                                .gap(px(shared::SPACE_1))
                                .child(
                                    div()
                                        .text_size(px(shared::TEXT_SM))
                                        .font_weight(FontWeight::SEMIBOLD)
                                        .text_color(rgba(c.text))
                                        .child(title),
                                )
                                .child(
                                    div()
                                        .text_size(px(shared::TEXT_SM))
                                        .text_color(rgba(c.text_2))
                                        .child(message),
                                ),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .justify_end()
                        .gap(px(shared::SPACE_3))
                        .child(keep_btn)
                        .child(stop_btn),
                ),
        )
        .on_children_prepainted(move |bounds, _, _| {
            if let Some(b) = bounds.first() {
                a11y::set_bounds(&key, *b);
            }
        })
}

fn render_apply_to_footer(
    id: &str,
    apply: &TaskApplyTo,
    running: bool,
    this_focus: &FocusHandle,
    multiple_focus: &FocusHandle,
    c: &TaskColors,
    is_dark: bool,
) -> gpui::Div {
    let selected = Some(match apply.value {
        ApplyTo::ThisFile => 0,
        ApplyTo::MultipleFiles => 1,
    });
    let items = vec![
        RadioItem::new(
            format!("{id}-apply-this"),
            this_focus.clone(),
            i18n::t("task.thisFile"),
        )
        .disabled(running || apply.this_disabled),
        RadioItem::new(
            format!("{id}-apply-multiple"),
            multiple_focus.clone(),
            i18n::t("task.multipleFiles"),
        )
        .disabled(running || apply.multiple_disabled),
    ];
    let mut group = RadioGroup::new(format!("{id}-apply-mode"), i18n::t("task.applyTo"), items)
        .selected(selected)
        .horizontal(true)
        .dark(is_dark);
    if let Some(on_change) = &apply.on_change {
        let on_change = on_change.clone();
        group = group.on_change(move |idx, window, cx| {
            let next = if idx == 0 {
                ApplyTo::ThisFile
            } else {
                ApplyTo::MultipleFiles
            };
            on_change(next, window, cx);
        });
    }

    div()
        .flex_none()
        .flex()
        .flex_row()
        .items_center()
        .gap(px(shared::SPACE_5))
        .child(
            div()
                .text_size(px(shared::TEXT_SM))
                .text_color(rgba(c.text_3))
                .child(i18n::t("task.applyTo")),
        )
        .child(group)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_metrics_matches_split_and_stacked_breakpoints() {
        let wide = layout_metrics(1484.0, true, DEFAULT_SIDE_WIDTH_PX, None);
        assert_eq!(wide.dialog_width, Width::Xl);
        assert!(!wide.stacked);
        assert_eq!(wide.side_width, 300.0);

        let mid = layout_metrics(1184.0, true, DEFAULT_SIDE_WIDTH_PX, None);
        assert_eq!(mid.dialog_width, Width::Xl);
        assert!(!mid.stacked);

        let at_800 = layout_metrics(800.0, true, DEFAULT_SIDE_WIDTH_PX, None);
        assert_eq!(at_800.dialog_width, Width::Xl);
        assert!(!at_800.stacked);

        let at_breakpoint = layout_metrics(760.0, true, DEFAULT_SIDE_WIDTH_PX, None);
        assert!(at_breakpoint.stacked);

        let narrow = layout_metrics(720.0, true, 380.0, Some(Width::Lg));
        assert_eq!(narrow.dialog_width, Width::Lg);
        assert!(narrow.stacked);
        assert_eq!(narrow.side_width, 380.0);

        let no_side = layout_metrics(1484.0, false, DEFAULT_SIDE_WIDTH_PX, None);
        assert_eq!(no_side.dialog_width, Width::Lg);
        assert!(no_side.stacked);

        let clamped = layout_metrics(1184.0, true, 40.0, None);
        assert_eq!(clamped.side_width, 160.0);
    }

    #[test]
    fn close_attempt_prompts_only_while_running() {
        assert_eq!(resolve_close_attempt(false, false), CloseDecision::CloseNow);
        assert_eq!(resolve_close_attempt(false, true), CloseDecision::CloseNow);
        assert_eq!(
            resolve_close_attempt(true, false),
            CloseDecision::AskConfirmCancel
        );
        assert_eq!(
            resolve_close_attempt(true, true),
            CloseDecision::DismissConfirmPrompt
        );
    }

    #[test]
    fn progress_a11y_value_formats_and_clamps() {
        assert_eq!(progress_a11y_value(None), "indeterminate");
        assert_eq!(progress_a11y_value(Some(0.0)), "0%");
        assert_eq!(progress_a11y_value(Some(0.5)), "50%");
        assert_eq!(progress_a11y_value(Some(1.0)), "100%");
        assert_eq!(progress_a11y_value(Some(-0.2)), "0%");
        assert_eq!(progress_a11y_value(Some(1.5)), "100%");
    }

    #[test]
    fn display_basename_handles_windows_and_posix_paths() {
        assert_eq!(
            display_basename(r"C:\docs\hop-dong-1.pdf"),
            "hop-dong-1.pdf"
        );
        assert_eq!(display_basename("/tmp/files/sample.pdf"), "sample.pdf");
        assert_eq!(display_basename("C:\\docs\\folder\\"), "folder");
        assert_eq!(display_basename("plain.pdf"), "plain.pdf");
    }

    #[test]
    fn task_i18n_keys_resolve_in_vi_and_en() {
        let keys = [
            "task.preset",
            "task.advanced",
            "task.preview",
            "task.estimate",
            "task.applyTo",
            "task.thisFile",
            "task.multipleFiles",
            "task.files",
            "task.noFiles",
            "task.addFiles",
            "task.run",
            "task.stop",
            "task.saveAsStep",
            "task.closeRunningTitle",
            "task.closeRunningMessage",
            "task.keepRunning",
            "task.stopAndClose",
        ];
        for lang in [i18n::Lang::Vi, i18n::Lang::En] {
            for key in keys {
                let value = i18n::translate_in(lang, key, None, &[]);
                assert_ne!(value, key, "missing {key} in {lang:?}");
                assert!(!value.trim().is_empty(), "empty {key} in {lang:?}");
            }
        }
    }

    #[test]
    fn focus_recovery_handles_transitions_without_stealing_from_child_popups() {
        // Đang có điều khiển hợp lệ trong hộp thoại giữ tiêu điểm: không kéo đi.
        assert!(!should_recover_focus(
            true, true, true, true, false, true, false, 2, 1
        ));
        // Mới mở bằng chuột nên opener vẫn giữ tiêu điểm.
        assert!(should_recover_focus(
            false, true, false, false, false, false, false, 0, 0
        ));
        // Cửa sổ mất tiêu điểm (phần tử vừa bị gỡ).
        assert!(should_recover_focus(
            false, false, true, false, false, false, false, 0, 0
        ));
        // Chuyển running -> idle khi nút đang giữ tiêu điểm bị gỡ khỏi cây.
        assert!(should_recover_focus(
            false, false, false, true, false, false, false, 0, 0
        ));
        // Đóng xác nhận dừng (confirm -> keep running).
        assert!(should_recover_focus(
            false, false, false, true, true, true, false, 0, 0
        ));
        // Xóa một file khỏi danh sách.
        assert!(should_recover_focus(
            false, false, false, false, false, false, false, 2, 1
        ));
        // Đang mở popup con như Select (không có chuyển trạng thái, cửa sổ vẫn có tiêu điểm): không cướp.
        assert!(!should_recover_focus(
            false, false, false, false, false, false, false, 1, 1
        ));
    }
}
