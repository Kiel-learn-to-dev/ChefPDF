//! Multi-document window host for R2.15.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    mpsc::{Receiver, channel},
};
use std::time::Duration;

use chef_pdf::render::RenderHandle;
use chef_rpc::Supervisor;
use chef_ui::dialog::{Dialog, Width};
use chef_ui::jobs_panel::{
    JobMeta, JobStore, JobsPanelCallbacks, JobsPanelProps, JobsToggleCallbacks, JobsToggleProps,
    build_jobs_panel, build_jobs_toggle, is_job_notification,
};
use chef_ui::text_input::{TextInput, TextInputEvent};
use gpui::{
    AnyWindowHandle, App, Context, Entity, ExternalPaths, FocusHandle, Focusable, KeyBinding,
    Render, SharedString, Subscription, Window, actions, div, prelude::*, px, rgb,
};

use crate::close::UnsavedClosePrompt;
use crate::commands::{self, Command, CommandRegistry};
use crate::recovery::{ConfirmDiscard, RecoverableSession, RecoveryModal};
use crate::settings_dialog::{self, SettingsPanel};
use crate::tabs::{TabId, Tabs};
use crate::viewer::{self, Viewer};

actions!(document_tabs, [NextTab, PreviousTab, CloseTab]);

pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("ctrl-tab", NextTab, Some("Viewer")),
        KeyBinding::new("ctrl-shift-tab", PreviousTab, Some("Viewer")),
        KeyBinding::new("ctrl-w", CloseTab, Some("Viewer")),
    ]);
}

struct Closing {
    rx: Receiver<Result<(), String>>,
}

enum RecoveryOpResult {
    Listed(Result<Vec<RecoverableSession>, String>),
    Restored {
        session_id: String,
        result: Result<serde_json::Value, String>,
    },
    Discarded {
        discarded_ids: Vec<String>,
        error: Option<String>,
    },
}

fn job_title_for_op(op_id: &str) -> String {
    match op_id {
        "page.rotate" => chef_ui::i18n::t("toolbar.rotateRight"),
        _ => op_id.to_string(),
    }
}

static HOST_FRAME: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub(crate) fn take_host_frame() -> bool {
    HOST_FRAME.swap(false, std::sync::atomic::Ordering::SeqCst)
}

pub struct DocumentHost {
    tabs: Tabs,
    viewers: HashMap<TabId, Entity<Viewer>>,
    handle: RenderHandle,
    supervisor: Option<Arc<Mutex<Supervisor>>>,
    closing: HashMap<TabId, Closing>,
    close_message: Option<String>,
    close_prompt: UnsavedClosePrompt,
    recovery: RecoveryModal,
    recovery_rx: Option<Receiver<RecoveryOpResult>>,
    job_store: JobStore,
    jobs_open: bool,
    debug_job_ids: HashSet<String>,
    core_events: Option<Receiver<chef_rpc::Event>>,
    poll_started: bool,
    /// Cài đặt của cửa sổ, dùng chung cho màn hình Start và mọi tab.
    settings: Entity<SettingsPanel>,
    appearance_observer_installed: bool,
    _subscriptions: Vec<Subscription>,
    command_registry: CommandRegistry,
    palette_open: bool,
    palette_query: String,
    palette_selected: usize,
    palette_input: Entity<TextInput>,
    palette_close: FocusHandle,
    /// Tiêu điểm của khung cửa sổ khi chưa có tab nào (màn hình Start), để phím tắt vẫn tới được.
    focus: FocusHandle,
    palette_window: Option<AnyWindowHandle>,
}

impl DocumentHost {
    pub fn new(
        paths: Vec<PathBuf>,
        handle: RenderHandle,
        supervisor: Option<Arc<Mutex<Supervisor>>>,
        cx: &mut Context<Self>,
    ) -> Self {
        let palette_input =
            cx.new(|cx| TextInput::new(cx, chef_ui::i18n::t("palette.placeholder")));
        let palette_subscription = cx.subscribe(
            &palette_input,
            |this: &mut DocumentHost, input, event: &TextInputEvent, cx| {
                this.on_palette_input(input, *event, cx);
            },
        );
        let settings = cx.new(SettingsPanel::new);
        let settings_subscription = cx.observe(&settings, |_, _, cx| cx.notify());
        let core_events = supervisor
            .as_ref()
            .and_then(|sup| sup.lock().ok())
            .map(|sup| sup.subscribe());
        let close_prompt = UnsavedClosePrompt::new(cx);
        let recovery = RecoveryModal::new(cx);
        let job_store = JobStore::new();
        crate::debug::set_close_prompt(false, None, None);
        crate::debug::set_recovery(recovery.to_debug_json());
        crate::debug::set_jobs(job_store.to_debug_json(false));
        let mut host = Self {
            tabs: Tabs::new(),
            viewers: HashMap::new(),
            handle,
            supervisor,
            closing: HashMap::new(),
            close_message: None,
            close_prompt,
            recovery,
            recovery_rx: None,
            job_store,
            jobs_open: false,
            debug_job_ids: HashSet::new(),
            core_events,
            poll_started: false,
            settings,
            appearance_observer_installed: false,
            _subscriptions: vec![palette_subscription, settings_subscription],
            command_registry: commands::viewer_commands(chef_ui::i18n::t),
            palette_open: false,
            palette_query: String::new(),
            palette_selected: 0,
            palette_input,
            palette_close: cx.focus_handle(),
            focus: cx.focus_handle(),
            palette_window: None,
        };
        let batch = crate::drop::validate_paths(paths);
        for path in batch.accepted {
            host.insert_path(path, cx);
        }
        host.close_message = open_errors_message(&batch.rejected);
        host.start_recovery_check_if_needed();
        host
    }

    /// Kiểm tra các phiên chưa đóng trên đĩa lúc khởi động (R3.13).
    /// Bất biến R3.03: chỉ gọi `chef-core` (`recovery.list`) khi `has_unclosed_sessions` trả `true`.
    fn start_recovery_check_if_needed(&mut self) {
        if !crate::recovery::has_unclosed_sessions(&crate::settings::user_data_dir()) {
            return;
        }
        let Some(supervisor) = self.supervisor.clone() else {
            return;
        };
        let (tx, rx) = channel();
        self.recovery_rx = Some(rx);
        std::thread::spawn(move || {
            let result = supervisor
                .lock()
                .map_err(|_| "Core không khả dụng".to_string())
                .and_then(|sup| {
                    let items =
                        chef_rpc::ops::recovery_list(&sup).map_err(|err| format!("{err:?}"))?;
                    Ok(items
                        .iter()
                        .filter_map(RecoverableSession::from_json)
                        .collect::<Vec<_>>())
                });
            let _ = tx.send(RecoveryOpResult::Listed(result));
        });
    }

    fn on_palette_input(
        &mut self,
        input: Entity<TextInput>,
        event: TextInputEvent,
        cx: &mut Context<Self>,
    ) {
        match event {
            TextInputEvent::Changed => {
                self.palette_query = input.read(cx).text().to_string();
                self.palette_selected = 0;
                cx.notify();
            }
            TextInputEvent::Submit => {
                let (Some(window), entity) = (self.palette_window, cx.entity()) else {
                    return;
                };
                cx.spawn(async move |_this, cx| {
                    let _ = cx.update_window(window, |_, window, cx| {
                        entity.update(cx, |host, cx| {
                            host.run_palette_index(host.palette_selected, window, cx)
                        });
                    });
                })
                .detach();
            }
            TextInputEvent::SubmitBack | TextInputEvent::Cancel => {}
        }
    }

    fn open_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.command_registry = commands::viewer_commands(chef_ui::i18n::t);
        self.palette_query.clear();
        self.palette_selected = 0;
        self.palette_open = true;
        self.palette_input
            .update(cx, |input, cx| input.set_text("", cx));
        let focus = self.palette_input.read(cx).focus_handle(cx);
        window.defer(cx, move |window, cx| {
            window.focus(&focus, cx);
            window.refresh();
        });
        cx.notify();
    }

    fn dismiss_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.palette_open = false;
        self.palette_query.clear();
        self.palette_selected = 0;
        self.palette_input
            .update(cx, |input, cx| input.set_text("", cx));
        if let Some(id) = self.tabs.active_id()
            && let Some(viewer) = self.viewers.get(&id)
        {
            viewer.update(cx, |viewer, cx| viewer.focus_search(window, cx));
        }
        cx.notify();
    }

    fn move_palette_selection(&mut self, forward: bool, cx: &mut Context<Self>) {
        if !self.palette_open {
            return;
        }
        let count = self.command_registry.search(&self.palette_query).len();
        if count == 0 {
            self.palette_selected = 0;
        } else if forward {
            self.palette_selected = (self.palette_selected + 1).min(count - 1);
        } else {
            self.palette_selected = self.palette_selected.saturating_sub(1);
        }
        cx.notify();
    }

    fn run_palette_index(&mut self, index: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(command) = self
            .command_registry
            .search(&self.palette_query)
            .get(index)
            .copied()
        else {
            return;
        };
        let Some(action) = command.action.gpui_action() else {
            return;
        };
        self.palette_open = false;
        self.palette_query.clear();
        self.palette_selected = 0;
        self.palette_input
            .update(cx, |input, cx| input.set_text("", cx));
        if let Some(id) = self.tabs.active_id()
            && let Some(viewer) = self.viewers.get(&id)
        {
            viewer.update(cx, |viewer, cx| viewer.focus_search(window, cx));
        }
        window.defer(cx, move |window, cx| window.dispatch_action(action, cx));
        cx.notify();
    }

    /// Open each valid PDF in a new tab; report invalid paths while continuing with the rest.
    pub fn open_paths(&mut self, paths: Vec<PathBuf>, window: &mut Window, cx: &mut Context<Self>) {
        if self
            .tabs
            .active_id()
            .is_some_and(|id| self.closing.contains_key(&id))
        {
            self.close_message = Some("Đang đóng phiên tài liệu…".into());
            cx.notify();
            return;
        }
        let batch = crate::drop::validate_paths(paths);
        for path in batch.accepted {
            if let Some(active) = self.tabs.active_id()
                && let Some(viewer) = self.viewers.get(&active)
            {
                viewer.update(cx, |viewer, _| viewer.deactivate_tab(window));
            }
            self.insert_path(path, cx);
        }
        self.close_message = open_errors_message(&batch.rejected);
        self.focus_active(window, cx);
        cx.notify();
    }

    pub fn focus_active(&self, window: &mut Window, cx: &mut App) {
        if let Some(id) = self.tabs.active_id()
            && let Some(viewer) = self.viewers.get(&id)
        {
            viewer.update(cx, |viewer, cx| viewer.focus_search(window, cx));
        }
    }

    pub fn scroll_active(&mut self, screens: f32, cx: &mut App) {
        if let Some(id) = self.tabs.active_id()
            && let Some(viewer) = self.viewers.get(&id)
        {
            viewer.update(cx, |viewer, cx| {
                viewer.scroll_screens(screens);
                cx.notify();
            });
        }
    }

    pub fn active_search(
        &self,
        window: &Window,
        cx: &App,
    ) -> Option<(String, std::ops::Range<usize>, bool)> {
        let id = self.tabs.active_id()?;
        let viewer = self.viewers.get(&id)?;
        let search = viewer.read(cx).search().clone();
        let input = search.read(cx);
        let focused = input.focus_handle(cx).is_focused(window);
        Some((input.text().to_string(), input.selected_range(), focused))
    }

    fn insert_path(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let title = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());
        let Ok(id) = self.tabs.open(title, Some(path.clone())) else {
            return;
        };
        let viewer = cx.new(|cx| {
            Viewer::open(
                self.handle.clone(),
                Some(path.clone()),
                self.supervisor.clone(),
                self.settings.clone(),
                cx,
            )
        });
        self._subscriptions
            .push(cx.observe(&viewer, |_, _, cx| cx.notify()));
        self.viewers.insert(id, viewer);
        self.record_recent_path(&path, cx);
    }

    fn activate(&mut self, id: TabId, window: &mut Window, cx: &mut Context<Self>) {
        let Some(previous) = self.tabs.active_id() else {
            return;
        };
        if previous == id || self.closing.contains_key(&previous) || self.closing.contains_key(&id)
        {
            return;
        }
        if let Some(viewer) = self.viewers.get(&previous) {
            viewer.update(cx, |viewer, _| viewer.deactivate_tab(window));
        }
        if self.tabs.activate(id) {
            self.close_message = None;
            if let Some(viewer) = self.viewers.get(&id) {
                viewer.update(cx, |viewer, cx| viewer.focus_search(window, cx));
                let (cached, pending, cached_bytes) = {
                    let viewer = viewer.read(cx);
                    (
                        viewer.tab_cached_pages(),
                        viewer.tab_pending_pages(),
                        viewer.tab_cached_bytes(),
                    )
                };
                crate::debug::set_viewer_stats(cached, pending, cached_bytes);
            }
            crate::debug::set_tabs(self.tabs_debug(cx));
            cx.notify();
            window.refresh();
        }
    }

    pub(crate) fn open_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self
            .tabs
            .active_id()
            .is_some_and(|id| self.closing.contains_key(&id))
        {
            self.close_message = Some("Đang đóng phiên tài liệu…".into());
            cx.notify();
            return;
        }
        let initial_dir = self.settings.read(cx).save_dir().map(PathBuf::from);
        let paths = crate::dialogs::open_pdfs(initial_dir.as_deref());
        self.open_paths(paths, window, cx);
    }

    fn close_active(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.tabs.active_id() else {
            return;
        };
        self.close_tab(id, window, cx);
    }

    fn cycle(&mut self, forward: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some(current) = self.tabs.active_id() else {
            return;
        };
        let Some(index) = self.tabs.tabs().iter().position(|tab| tab.id() == current) else {
            return;
        };
        let len = self.tabs.tabs().len();
        if len < 2 {
            return;
        }
        let next = if forward {
            (index + 1) % len
        } else {
            (index + len - 1) % len
        };
        let target = self.tabs.tabs()[next].id();
        self.activate(target, window, cx);
    }

    fn close_tab(&mut self, id: TabId, window: &mut Window, cx: &mut Context<Self>) {
        if self.closing.contains_key(&id) {
            return;
        }
        let Some(viewer_entity) = self.viewers.get(&id).cloned() else {
            return;
        };
        let (busy, dirty, title) = {
            let viewer_ref = viewer_entity.read(cx);
            (
                viewer_ref.tab_is_busy(),
                viewer_ref.tab_is_dirty(),
                viewer_ref.tab_title(),
            )
        };
        if busy {
            self.close_message =
                Some("Lưu thay đổi hoặc chờ thao tác hiện tại trước khi đóng thẻ.".into());
            cx.notify();
            return;
        }
        if dirty {
            self.close_prompt
                .open_for(id.get() as usize, title.clone(), window, cx);
            crate::debug::set_close_prompt(true, Some(id.get() as usize), Some(&title));
            cx.notify();
            return;
        }
        self.close_tab_clean_or_discard(id, window, cx);
    }

    fn close_tab_clean_or_discard(
        &mut self,
        id: TabId,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.closing.contains_key(&id) {
            return;
        }
        let Some(viewer_entity) = self.viewers.get(&id).cloned() else {
            return;
        };
        let target = viewer_entity.read(cx).tab_close_target();
        if let Some((supervisor, session_id)) = target {
            viewer_entity.update(cx, |viewer, _| viewer.set_tab_closing(true));
            let (tx, rx) = channel();
            self.closing.insert(id, Closing { rx });
            std::thread::spawn(move || {
                let result = supervisor
                    .lock()
                    .map_err(|_| "Core không khả dụng".to_string())
                    .and_then(|sup| {
                        sup.request(
                            "session.close",
                            &serde_json::json!({"sessionId":session_id}),
                        )
                        .map_err(|error| format!("{error:?}"))?;
                        sup.session_closed(&session_id);
                        Ok(())
                    });
                let _ = tx.send(result);
            });
            // Do not allow another tab switch/action to race the in-flight session close.
            self.close_message = Some("Đang đóng phiên tài liệu…".into());
            cx.notify();
        } else {
            self.finish_close(id, window, cx);
        }
    }

    fn cancel_close_prompt(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.close_prompt.close();
        crate::debug::set_close_prompt(false, None, None);
        self.focus_active(window, cx);
        cx.notify();
    }

    fn discard_close_prompt(
        &mut self,
        raw_tab_id: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.close_prompt.close();
        crate::debug::set_close_prompt(false, None, None);
        if let Some(id) = self
            .tabs
            .tabs()
            .iter()
            .find(|t| t.id().get() as usize == raw_tab_id)
            .map(|t| t.id())
        {
            self.close_tab_clean_or_discard(id, window, cx);
        }
    }

    fn save_close_prompt(
        &mut self,
        raw_tab_id: usize,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.close_prompt.close();
        crate::debug::set_close_prompt(false, None, None);
        if let Some(id) = self
            .tabs
            .tabs()
            .iter()
            .find(|t| t.id().get() as usize == raw_tab_id)
            .map(|t| t.id())
            && let Some(viewer) = self.viewers.get(&id).cloned()
        {
            viewer.update(cx, |v, cx| v.save_for_close(cx));
        }
        cx.notify();
    }

    fn poll_ready_to_close(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let ready_ids: Vec<TabId> = self
            .viewers
            .iter()
            .filter_map(|(id, viewer)| {
                viewer
                    .update(cx, |v, _| v.take_ready_to_close())
                    .then_some(*id)
            })
            .collect();
        if ready_ids.is_empty() {
            return false;
        }
        for id in ready_ids {
            self.close_tab_clean_or_discard(id, window, cx);
        }
        true
    }

    fn insert_restored_tab(
        &mut self,
        restored: &serde_json::Value,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if let Some(active) = self.tabs.active_id()
            && let Some(viewer) = self.viewers.get(&active)
        {
            viewer.update(cx, |viewer, _| viewer.deactivate_tab(window));
        }
        let state = restored.get("state").unwrap_or(restored);
        let source_path = state
            .get("sourcePath")
            .and_then(serde_json::Value::as_str)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from);
        let title = source_path
            .as_ref()
            .and_then(|p| p.file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Untitled".to_string());
        let Ok(id) = self.tabs.open(title, source_path.clone()) else {
            return;
        };
        let restored_clone = restored.clone();
        let viewer = cx.new(|cx| {
            Viewer::open_restored(
                self.handle.clone(),
                &restored_clone,
                self.supervisor.clone(),
                self.settings.clone(),
                cx,
            )
        });
        self._subscriptions
            .push(cx.observe(&viewer, |_, _, cx| cx.notify()));
        let dirty = viewer.read(cx).tab_is_dirty();
        self.tabs.set_dirty(id, dirty);
        self.viewers.insert(id, viewer);
        if let Some(path) = &source_path {
            self.record_recent_path(path, cx);
        }
        crate::debug::set_tabs(self.tabs_debug(cx));
        self.focus_active(window, cx);
    }

    fn restore_recovery_session(
        &mut self,
        session_id: String,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.recovery.busy {
            return;
        }
        let Some(supervisor) = self.supervisor.clone() else {
            return;
        };
        self.recovery.busy = true;
        self.recovery.error = None;
        crate::debug::set_recovery(self.recovery.to_debug_json());
        let (tx, rx) = channel();
        self.recovery_rx = Some(rx);
        std::thread::spawn(move || {
            let sid = session_id.clone();
            let result = supervisor
                .lock()
                .map_err(|_| "Core không khả dụng".to_string())
                .and_then(|sup| {
                    chef_rpc::ops::recovery_restore(&sup, &sid).map_err(|err| format!("{err:?}"))
                });
            let _ = tx.send(RecoveryOpResult::Restored { session_id, result });
        });
        cx.notify();
    }

    fn request_discard_recovery(
        &mut self,
        target: ConfirmDiscard,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.recovery.busy {
            return;
        }
        self.recovery.confirming_discard = Some(target);
        crate::debug::set_recovery(self.recovery.to_debug_json());
        cx.notify();
    }

    fn cancel_discard_recovery(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if self.recovery.busy {
            return;
        }
        self.recovery.confirming_discard = None;
        crate::debug::set_recovery(self.recovery.to_debug_json());
        cx.notify();
    }

    fn confirm_discard_recovery(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        if self.recovery.busy {
            return;
        }
        let ids: Vec<String> = match &self.recovery.confirming_discard {
            Some(ConfirmDiscard::Single(id)) => vec![id.clone()],
            Some(ConfirmDiscard::All) => self
                .recovery
                .sessions
                .iter()
                .map(|s| s.session_id.clone())
                .collect(),
            None => return,
        };
        let Some(supervisor) = self.supervisor.clone() else {
            return;
        };
        self.recovery.busy = true;
        self.recovery.error = None;
        crate::debug::set_recovery(self.recovery.to_debug_json());
        let (tx, rx) = channel();
        self.recovery_rx = Some(rx);
        std::thread::spawn(move || {
            let mut discarded_ids = Vec::with_capacity(ids.len());
            let mut error = None;
            match supervisor.lock() {
                Ok(sup) => {
                    for sid in ids {
                        match chef_rpc::ops::recovery_discard(&sup, &sid) {
                            Ok(()) => discarded_ids.push(sid),
                            Err(err) => {
                                error = Some(format!("{err:?}"));
                                break;
                            }
                        }
                    }
                }
                Err(_) => error = Some("Core không khả dụng".to_string()),
            }
            let _ = tx.send(RecoveryOpResult::Discarded {
                discarded_ids,
                error,
            });
        });
        cx.notify();
    }

    fn later_recovery(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.recovery.close();
        crate::debug::set_recovery(self.recovery.to_debug_json());
        self.focus_active(window, cx);
        cx.notify();
    }

    fn poll_recovery(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let Some(rx) = self.recovery_rx.as_ref() else {
            return false;
        };
        let op = match rx.try_recv() {
            Ok(op) => op,
            Err(std::sync::mpsc::TryRecvError::Empty) => return false,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                self.recovery_rx = None;
                self.recovery.busy = false;
                crate::debug::set_recovery(self.recovery.to_debug_json());
                return true;
            }
        };
        self.recovery_rx = None;
        match op {
            RecoveryOpResult::Listed(Ok(sessions)) => {
                self.recovery.open_with(sessions);
            }
            RecoveryOpResult::Listed(Err(err)) => {
                self.recovery.busy = false;
                self.recovery.error = Some(err);
            }
            RecoveryOpResult::Restored {
                session_id,
                result: Ok(restored),
            } => {
                self.recovery.remove_session(&session_id);
                self.insert_restored_tab(&restored, window, cx);
            }
            RecoveryOpResult::Restored {
                result: Err(err), ..
            } => {
                self.recovery.busy = false;
                self.recovery.error = Some(err);
            }
            RecoveryOpResult::Discarded {
                discarded_ids,
                error,
            } => {
                for sid in discarded_ids {
                    self.recovery.remove_session(&sid);
                }
                if let Some(err) = error {
                    self.recovery.busy = false;
                    self.recovery.error = Some(err);
                }
            }
        }
        crate::debug::set_recovery(self.recovery.to_debug_json());
        true
    }

    fn poll_jobs(&mut self) -> bool {
        let mut changed = false;
        if let Some(rx) = self.core_events.as_ref() {
            while let Ok(event) = rx.try_recv() {
                if let chef_rpc::Event::Notification(note) = event {
                    if note.method == "job.started" {
                        if let Some(job_id) =
                            note.params.get("jobId").and_then(serde_json::Value::as_str)
                        {
                            let op_id = note
                                .params
                                .get("opId")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("job");
                            let session_id = note
                                .params
                                .get("sessionId")
                                .and_then(serde_json::Value::as_str)
                                .map(str::to_string);
                            self.job_store.track(
                                job_id,
                                JobMeta {
                                    op_id: op_id.to_string(),
                                    title: job_title_for_op(op_id),
                                    session_id,
                                    silent: false,
                                },
                            );
                            changed = true;
                        }
                    } else if is_job_notification(&note.method)
                        && self
                            .job_store
                            .handle_notification(&note.method, &note.params)
                    {
                        changed = true;
                    }
                }
            }
        }
        for cmd in crate::debug::take_job_commands() {
            match cmd {
                crate::debug::DebugJobCommand::Track {
                    job_id,
                    op_id,
                    title,
                } => {
                    self.debug_job_ids.insert(job_id.clone());
                    self.job_store.track(
                        job_id,
                        JobMeta {
                            op_id,
                            title,
                            session_id: None,
                            silent: false,
                        },
                    );
                    changed = true;
                }
                crate::debug::DebugJobCommand::Notify { method, params } => {
                    if self.job_store.handle_notification(&method, &params) {
                        changed = true;
                    }
                }
            }
        }
        if changed {
            crate::debug::set_jobs(self.job_store.to_debug_json(self.jobs_open));
        }
        changed
    }

    fn cancel_job(&mut self, job_id: String, cx: &mut Context<Self>) {
        if self.debug_job_ids.remove(&job_id) {
            self.job_store
                .handle_notification("job.cancelled", &serde_json::json!({ "jobId": job_id }));
            crate::debug::set_jobs(self.job_store.to_debug_json(self.jobs_open));
            cx.notify();
            return;
        }
        if let Some(supervisor) = self.supervisor.clone() {
            std::thread::spawn(move || {
                if let Ok(sup) = supervisor.lock() {
                    let _ = chef_rpc::ops::cancel(&sup, &job_id);
                }
            });
        }
    }

    fn finish_close(&mut self, id: TabId, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(viewer) = self.viewers.get(&id) {
            viewer.update(cx, |viewer, cx| viewer.finish_tab_close(window, cx));
        }
        let was_active = self.tabs.active_id() == Some(id);
        self.tabs.close(id);
        self.viewers.remove(&id);
        self.closing.remove(&id);
        self.close_message = None;
        if was_active
            && let Some(next) = self.tabs.active_id()
            && let Some(viewer) = self.viewers.get(&next)
        {
            viewer.update(cx, |viewer, cx| viewer.focus_search(window, cx));
        }
        if let Some(active) = self.tabs.active_id()
            && let Some(viewer) = self.viewers.get(&active)
        {
            let viewer = viewer.read(cx);
            crate::debug::set_viewer_stats(
                viewer.tab_cached_pages(),
                viewer.tab_pending_pages(),
                viewer.tab_cached_bytes(),
            );
        } else {
            crate::debug::set_viewer_stats(0, 0, 0);
        }
        crate::debug::set_tabs(self.tabs_debug(cx));
        cx.notify();
    }

    fn poll_closing(&mut self, window: &mut Window, cx: &mut Context<Self>) -> bool {
        let ready: Vec<(TabId, Result<(), String>)> = self
            .closing
            .iter()
            .filter_map(|(id, closing)| match closing.rx.try_recv() {
                Ok(result) => Some((*id, result)),
                Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                    Some((*id, Err("Đóng phiên thất bại".into())))
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => None,
            })
            .collect();
        if ready.is_empty() {
            return false;
        }
        for (id, result) in ready {
            match result {
                Ok(()) => self.finish_close(id, window, cx),
                Err(error) => {
                    self.closing.remove(&id);
                    if let Some(viewer) = self.viewers.get(&id) {
                        viewer.update(cx, |viewer, _| viewer.set_tab_closing(false));
                    }
                    self.close_message = Some(error);
                }
            }
        }
        true
    }

    fn tabs_debug(&self, cx: &App) -> serde_json::Value {
        let active = self.tabs.active_id();
        serde_json::Value::Array(
            self.tabs
                .tabs()
                .iter()
                .map(|tab| {
                    let (title, dirty, cache) = self
                        .viewers
                        .get(&tab.id())
                        .map(|viewer| {
                            let viewer = viewer.read(cx);
                            (
                                viewer.tab_title(),
                                viewer.tab_is_dirty(),
                                viewer.tab_cached_pages(),
                            )
                        })
                        .unwrap_or_else(|| (tab.title().to_string(), tab.is_dirty(), 0));
                    serde_json::json!({
                        "id": tab.id().get(), "title": title, "active": active == Some(tab.id()),
                        "dirty": dirty, "cachedPages": cache,
                    })
                })
                .collect(),
        )
    }

    fn begin_poll(&mut self, cx: &mut Context<Self>) {
        if self.poll_started {
            return;
        }
        self.poll_started = true;
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(30))
                    .await;
                let alive = this.update(cx, |host, cx| {
                    let jobs_changed = host.poll_jobs();
                    let ready_close = host
                        .viewers
                        .values()
                        .any(|v| v.read(cx).has_ready_to_close());
                    crate::debug::set_tabs(host.tabs_debug(cx));
                    if jobs_changed
                        || ready_close
                        || host.recovery_rx.is_some()
                        || !host.closing.is_empty()
                    {
                        cx.notify();
                    }
                });
                if alive.is_err() {
                    break;
                }
            }
        })
        .detach();
    }

    fn record_recent_path(&mut self, path: &std::path::Path, cx: &mut Context<Self>) {
        let saved = self
            .settings
            .update(cx, |settings, cx| settings.record_recent(path, cx));
        if let Err(error) = saved {
            self.close_message = Some(format!("Không lưu được danh sách gần đây: {error}"));
        }
    }
}

fn open_errors_message(errors: &[String]) -> Option<String> {
    if errors.is_empty() {
        return None;
    }
    let details = errors
        .iter()
        .take(2)
        .cloned()
        .collect::<Vec<_>>()
        .join("; ");
    let more = errors.len().saturating_sub(2);
    Some(if more == 0 {
        format!("Không mở được: {details}")
    } else {
        format!(
            "Không mở được {} tệp: {details}; và {more} tệp khác",
            errors.len()
        )
    })
}

impl Render for DocumentHost {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.begin_poll(cx);
        self.poll_jobs();
        self.poll_ready_to_close(window, cx);
        self.poll_closing(window, cx);
        self.poll_recovery(window, cx);
        chef_ui::a11y::begin_frame(window.scale_factor());
        HOST_FRAME.store(
            self.tabs.active_id().is_some(),
            std::sync::atomic::Ordering::SeqCst,
        );
        self.palette_window = Some(window.window_handle());
        if !self.appearance_observer_installed {
            self._subscriptions
                .push(cx.observe_window_appearance(window, |this, _window, cx| {
                    if this.tabs.active_id().is_none()
                        && this.settings.read(cx).mode() == crate::theme::Mode::System
                    {
                        cx.notify();
                    }
                }));
            self.appearance_observer_installed = true;
        }
        let metadata: Vec<(TabId, String, bool)> = self
            .tabs
            .tabs()
            .iter()
            .filter_map(|tab| {
                self.viewers.get(&tab.id()).map(|viewer| {
                    let viewer = viewer.read(cx);
                    let (title, dirty) = (viewer.tab_title(), viewer.tab_is_dirty());
                    (tab.id(), title, dirty)
                })
            })
            .collect();
        for (id, title, dirty) in metadata {
            self.tabs.set_title(id, title);
            self.tabs.set_dirty(id, dirty);
        }
        crate::debug::set_tabs(self.tabs_debug(cx));
        crate::debug::set_tab_message(self.close_message.as_deref());
        let active = self
            .tabs
            .active_id()
            .and_then(|id| self.viewers.get(&id).cloned());
        let palette_results: Vec<Command> = if self.palette_query.trim().is_empty() {
            self.command_registry
                .all()
                .iter()
                .take(50)
                .cloned()
                .collect()
        } else {
            self.command_registry
                .search(&self.palette_query)
                .into_iter()
                .take(50)
                .cloned()
                .collect()
        };
        crate::debug::set_palette_state(serde_json::json!({
            "open": self.palette_open,
            "query": self.palette_query,
            "selected": self.palette_selected,
            "results": palette_results.iter().map(|command| serde_json::json!({
                "id": command.id,
                "title": command.title,
                "enabled": command.is_available(),
            })).collect::<Vec<_>>(),
        }));
        let (recent_files, mode) = {
            let settings = self.settings.read(cx);
            crate::debug::set_settings(
                settings.theme().as_str(),
                settings.language().as_str(),
                settings.save_dir(),
                settings.is_open(),
            );
            (settings.recent_files(), settings.mode())
        };
        if active.is_none() {
            crate::debug::set_start_recents(
                recent_files
                    .iter()
                    .map(|recent| recent.path.clone())
                    .collect(),
            );
        }
        let mut strip = div()
            .id("document-tabs")
            .flex()
            .flex_row()
            .items_center()
            .gap(px(4.0))
            .h(px(40.0))
            .px(px(8.0))
            .bg(rgb(0xf0f0f0));
        for tab in self.tabs.tabs() {
            let id = tab.id();
            let selected = Some(id) == self.tabs.active_id();
            let title = format!("{}{}", tab.title(), if tab.is_dirty() { " •" } else { "" });
            let tab_control_id = format!("doc-tab-{}", id.get());
            chef_ui::a11y::register(chef_ui::a11y::Registered {
                id: tab_control_id.clone(),
                role: "tab",
                name: title.clone(),
                disabled: false,
                focused: false,
                hovered: false,
                checked: None,
                value: None,
                bounds: None,
            });
            let activate = cx.listener(move |this, _, window, cx| this.activate(id, window, cx));
            let close = cx.listener(move |this, _, window, cx| {
                cx.stop_propagation();
                this.close_tab(id, window, cx)
            });
            let tab_control_key = tab_control_id.clone();
            strip = strip.child(
                div()
                    .flex_none()
                    .child(
                        div()
                            .id(tab_control_id)
                            .flex()
                            .flex_row()
                            .items_center()
                            .gap(px(4.0))
                            .px(px(8.0))
                            .py(px(4.0))
                            .cursor_pointer()
                            .bg(rgb(if selected { 0xffffff } else { 0xe5e5e5 }))
                            .child(title)
                            .child(
                                div()
                                    .id(format!("doc-tab-close-{}", id.get()))
                                    .px(px(4.0))
                                    .child("×")
                                    .on_click(close),
                            )
                            .on_click(activate),
                    )
                    .on_children_prepainted(move |bounds, _, _| {
                        if let Some(bounds) = bounds.first() {
                            chef_ui::a11y::set_bounds(&tab_control_key, *bounds);
                        }
                    }),
            );
        }
        strip = strip.child(
            div()
                .id("document-tab-new")
                .px(px(10.0))
                .py(px(4.0))
                .cursor_pointer()
                .child("＋")
                .on_click(cx.listener(|this, _, window, cx| this.open_dialog(window, cx))),
        );
        if let Some(message) = &self.close_message {
            strip = strip.child(
                div()
                    .id("document-tab-message")
                    .px(px(8.0))
                    .child(SharedString::from(message.clone())),
            );
        }
        let dark = crate::theme::is_dark(mode);
        crate::debug::set_close_prompt(
            self.close_prompt.open,
            self.close_prompt.tab_id,
            if self.close_prompt.open {
                Some(self.close_prompt.name.as_str())
            } else {
                None
            },
        );
        crate::debug::set_recovery(self.recovery.to_debug_json());
        crate::debug::set_jobs(self.job_store.to_debug_json(self.jobs_open));
        let host_for_toggle = cx.entity();
        let jobs_toggle = build_jobs_toggle(
            JobsToggleProps::from_store(&self.job_store, self.jobs_open, dark),
            JobsToggleCallbacks::new().on_toggle(move |_, cx| {
                host_for_toggle.update(cx, |host, cx| {
                    host.jobs_open = !host.jobs_open;
                    crate::debug::set_jobs(host.job_store.to_debug_json(host.jobs_open));
                    cx.notify();
                });
            }),
        );
        strip = strip.child(div().flex_1()).child(jobs_toggle);
        let has_active = active.is_some();
        if !has_active && window.focused(cx).is_none() {
            window.focus(&self.focus, cx);
        }
        let body = if let Some(viewer) = active.clone() {
            div().flex_1().child(viewer).into_any_element()
        } else {
            crate::debug::set_theme_dark(dark);
            crate::start::build(
                cx.entity(),
                &recent_files,
                window.viewport_size().width.as_f32(),
                dark,
                self.close_message.as_deref(),
            )
            .into_any_element()
        };
        let root = div()
            .id("document-host")
            .relative()
            .flex()
            .flex_col()
            .w_full()
            .h_full()
            .key_context("Viewer")
            .track_focus(&self.focus)
            .on_action(
                cx.listener(|this, _: &viewer::OpenFile, window, cx| this.open_dialog(window, cx)),
            )
            .on_action(cx.listener(|this, _: &NextTab, window, cx| this.cycle(true, window, cx)))
            .on_action(
                cx.listener(|this, _: &PreviousTab, window, cx| this.cycle(false, window, cx)),
            )
            .on_action(cx.listener(|this, _: &CloseTab, window, cx| this.close_active(window, cx)))
            .on_action(cx.listener(|this, _: &viewer::OpenSettings, window, cx| {
                this.settings
                    .update(cx, |settings, cx| settings.open(window, cx));
            }))
            .on_action(cx.listener(|this, _: &commands::OpenPalette, window, cx| {
                this.open_palette(window, cx)
            }))
            .on_action(cx.listener(|this, _: &commands::PaletteNext, _window, cx| {
                this.move_palette_selection(true, cx)
            }))
            .on_action(
                cx.listener(|this, _: &commands::PalettePrevious, _window, cx| {
                    this.move_palette_selection(false, cx)
                }),
            )
            .on_drop(cx.listener(|this, paths: &ExternalPaths, window, cx| {
                this.open_paths(paths.paths().to_vec(), window, cx);
            }));
        let mut root = if has_active {
            root.child(strip).child(body)
        } else {
            root.child(body)
        };
        if self.jobs_open {
            let host_close = cx.entity();
            let host_clear = cx.entity();
            let host_cancel = cx.entity();
            let host_dismiss = cx.entity();
            let panel = build_jobs_panel(
                JobsPanelProps::from_store(&self.job_store, dark),
                JobsPanelCallbacks::new()
                    .on_close(move |_, cx| {
                        host_close.update(cx, |host, cx| {
                            host.jobs_open = false;
                            crate::debug::set_jobs(host.job_store.to_debug_json(host.jobs_open));
                            cx.notify();
                        });
                    })
                    .on_clear_finished(move |_, cx| {
                        host_clear.update(cx, |host, cx| {
                            host.job_store.clear_finished();
                            crate::debug::set_jobs(host.job_store.to_debug_json(host.jobs_open));
                            cx.notify();
                        });
                    })
                    .on_cancel(move |job_id, _, cx| {
                        host_cancel.update(cx, |host, cx| {
                            host.cancel_job(job_id, cx);
                        });
                    })
                    .on_dismiss(move |job_id, _, cx| {
                        host_dismiss.update(cx, |host, cx| {
                            host.job_store.dismiss(&job_id);
                            crate::debug::set_jobs(host.job_store.to_debug_json(host.jobs_open));
                            cx.notify();
                        });
                    }),
            );
            root = root.child(
                div()
                    .id("jobs-panel-anchor")
                    .absolute()
                    .top(px(44.0))
                    .right(px(8.0))
                    .child(panel),
            );
        }
        if self.close_prompt.open {
            let entity = cx.entity();
            root = root.child(self.close_prompt.render_dialog(
                dark,
                &entity,
                Self::cancel_close_prompt,
                Self::discard_close_prompt,
                Self::save_close_prompt,
            ));
        }
        if self.recovery.open {
            let entity = cx.entity();
            root = root.child(self.recovery.render_dialog(
                dark,
                window,
                cx,
                &entity,
                Self::restore_recovery_session,
                Self::request_discard_recovery,
                Self::confirm_discard_recovery,
                Self::cancel_discard_recovery,
                Self::later_recovery,
            ));
        }
        if self.palette_open {
            let dark = crate::theme::is_dark(mode);
            let items = palette_results
                .iter()
                .map(|command| {
                    chef_ui::palette::PaletteItem::new(
                        command.id.clone(),
                        command.title.clone(),
                        command.group.clone(),
                        command.is_available(),
                    )
                })
                .collect();
            let host = cx.entity();
            let results = chef_ui::palette::PaletteList::new(
                "command-palette-results",
                chef_ui::i18n::t("palette.results"),
            )
            .items(items)
            .selected(self.palette_selected)
            .dark(dark)
            .empty_message(chef_ui::i18n::t("palette.noResults"))
            .on_activate(move |index, window, cx| {
                host.update(cx, |host, cx| host.run_palette_index(index, window, cx));
            });
            let input_focus = self.palette_input.read(cx).focus_handle(cx);
            let return_focus = active
                .as_ref()
                .map(|viewer| viewer.read(cx).search().read(cx).focus_handle(cx));
            let dismiss_host = cx.entity();
            let mut dialog = Dialog::new(
                "command-palette",
                chef_ui::i18n::t("palette.title"),
                Width::Md,
                dark,
            )
            .close(
                "command-palette-close",
                self.palette_close.clone(),
                chef_ui::i18n::t("common.close"),
            )
            .tab_order(vec![input_focus])
            .on_dismiss(move |window, cx| {
                dismiss_host.update(cx, |host, cx| host.dismiss_palette(window, cx));
            });
            if let Some(focus) = return_focus {
                dialog = dialog.return_focus(focus);
            }
            dialog = dialog.child(self.palette_input.clone()).child(results);
            root = root.child(dialog);
        }
        let settings = self.settings.clone();
        root.children(settings_dialog::build(&settings, window, cx))
    }
}
