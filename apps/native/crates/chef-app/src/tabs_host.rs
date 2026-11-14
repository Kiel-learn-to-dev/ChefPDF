//! Multi-document window host for R2.15.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    Arc, Mutex,
    mpsc::{Receiver, channel},
};
use std::time::Duration;

use chef_pdf::render::RenderHandle;
use chef_rpc::Supervisor;
use chef_ui::dialog::{Dialog, Width};
use chef_ui::text_input::{TextInput, TextInputEvent};
use gpui::{
    AnyWindowHandle, App, Context, Entity, ExternalPaths, FocusHandle, Focusable, KeyBinding,
    Render, SharedString, Subscription, Window, actions, div, prelude::*, px, rgb,
};

use crate::commands::{self, Command, CommandRegistry};
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

pub struct DocumentHost {
    tabs: Tabs,
    viewers: HashMap<TabId, Entity<Viewer>>,
    handle: RenderHandle,
    supervisor: Option<Arc<Mutex<Supervisor>>>,
    closing: HashMap<TabId, Closing>,
    close_message: Option<String>,
    poll_started: bool,
    recent_files: Vec<crate::settings::RecentFile>,
    start_mode: crate::theme::Mode,
    appearance_observer_installed: bool,
    _subscriptions: Vec<Subscription>,
    command_registry: CommandRegistry,
    palette_open: bool,
    palette_query: String,
    palette_selected: usize,
    palette_input: Entity<TextInput>,
    palette_close: FocusHandle,
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
        let mut host = Self {
            tabs: Tabs::new(),
            viewers: HashMap::new(),
            handle,
            supervisor,
            closing: HashMap::new(),
            close_message: None,
            poll_started: false,
            recent_files: Vec::new(),
            start_mode: crate::theme::Mode::System,
            appearance_observer_installed: false,
            _subscriptions: vec![palette_subscription],
            command_registry: commands::viewer_commands(chef_ui::i18n::t),
            palette_open: false,
            palette_query: String::new(),
            palette_selected: 0,
            palette_input,
            palette_close: cx.focus_handle(),
            palette_window: None,
        };
        host.refresh_start_preferences();
        let batch = crate::drop::validate_paths(paths);
        for path in batch.accepted {
            host.insert_path(path, cx);
        }
        host.close_message = open_errors_message(&batch.rejected);
        host
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
                cx,
            )
        });
        self.viewers.insert(id, viewer);
        self.record_recent_path(&path);
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
                let (cached, pending) = {
                    let viewer = viewer.read(cx);
                    (viewer.tab_cached_pages(), viewer.tab_pending_pages())
                };
                crate::debug::set_viewer_stats(cached, pending);
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
        let initial_dir = crate::settings::Settings::load(&crate::settings::user_data_dir())
            .ok()
            .and_then(|settings| settings.default_save_dir().map(PathBuf::from));
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
        let viewer_ref = viewer_entity.read(cx);
        let blocked = viewer_ref.tab_close_blocked();
        let target = viewer_ref.tab_close_target();
        if blocked {
            self.close_message =
                Some("Lưu thay đổi hoặc chờ thao tác hiện tại trước khi đóng thẻ.".into());
            cx.notify();
            return;
        }
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

    fn finish_close(&mut self, id: TabId, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(viewer) = self.viewers.get(&id) {
            viewer.update(cx, |viewer, cx| viewer.finish_tab_close(window, cx));
        }
        let was_active = self.tabs.active_id() == Some(id);
        self.tabs.close(id);
        self.viewers.remove(&id);
        self.closing.remove(&id);
        self.close_message = None;
        if self.tabs.active_id().is_none() {
            self.refresh_start_preferences();
        }
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
            crate::debug::set_viewer_stats(viewer.tab_cached_pages(), viewer.tab_pending_pages());
        } else {
            crate::debug::set_viewer_stats(0, 0);
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
                    if !host.closing.is_empty() {
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

    fn refresh_start_preferences(&mut self) {
        if let Ok(settings) = crate::settings::Settings::load(&crate::settings::user_data_dir()) {
            self.recent_files = settings.recent_files();
            self.start_mode = crate::theme::effective_mode(settings.theme());
            chef_ui::i18n::set_language(chef_ui::i18n::Lang::from_code(
                settings.language().as_str(),
            ));
        }
    }

    fn record_recent_path(&mut self, path: &std::path::Path) {
        let Ok(mut settings) = crate::settings::Settings::load(&crate::settings::user_data_dir())
        else {
            return;
        };
        if settings
            .record_recent(path, &crate::settings::now_iso_8601())
            .is_err()
        {
            return;
        }
        if let Err(error) = settings.save() {
            self.close_message = Some(format!("Không lưu được danh sách gần đây: {error}"));
        }
        self.recent_files = settings.recent_files();
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
        self.poll_closing(window, cx);
        self.palette_window = Some(window.window_handle());
        if !self.appearance_observer_installed {
            self._subscriptions
                .push(cx.observe_window_appearance(window, |this, _window, cx| {
                    if this.tabs.active_id().is_none()
                        && this.start_mode == crate::theme::Mode::System
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
        if active.is_none() {
            crate::debug::set_start_recents(
                self.recent_files
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
            let activate = cx.listener(move |this, _, window, cx| this.activate(id, window, cx));
            let close = cx.listener(move |this, _, window, cx| {
                cx.stop_propagation();
                this.close_tab(id, window, cx)
            });
            strip = strip.child(
                div()
                    .id(format!("doc-tab-{}", id.get()))
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
        let has_active = active.is_some();
        let body = if let Some(viewer) = active.clone() {
            div().flex_1().child(viewer).into_any_element()
        } else {
            let dark = crate::theme::is_dark(self.start_mode);
            crate::debug::set_theme_dark(dark);
            crate::start::build(
                cx.entity(),
                &self.recent_files,
                window.viewport_size().width.as_f32(),
                dark,
                self.close_message.as_deref(),
            )
            .into_any_element()
        };
        let root = div()
            .id("document-host")
            .flex()
            .flex_col()
            .w_full()
            .h_full()
            .key_context("Viewer")
            .on_action(
                cx.listener(|this, _: &viewer::OpenFile, window, cx| this.open_dialog(window, cx)),
            )
            .on_action(cx.listener(|this, _: &NextTab, window, cx| this.cycle(true, window, cx)))
            .on_action(
                cx.listener(|this, _: &PreviousTab, window, cx| this.cycle(false, window, cx)),
            )
            .on_action(cx.listener(|this, _: &CloseTab, window, cx| this.close_active(window, cx)))
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
        if self.palette_open {
            let dark = crate::theme::is_dark(self.start_mode);
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
        root
    }
}
