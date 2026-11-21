//! Independent secondary PDF pane for side-by-side viewing (TASKS_RUST R4.08, feature B8).
//!
//! Renders an independent PDF document/viewport using a second `DocId` on the shared PDFium render
//! thread and shares the single byte-budgeted [`SharedCache`] across all viewers.

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Duration;

use chef_pdf::render::{DocId, Job, PageImage, RenderHandle, Reply};
use chef_ui::a11y::{self, Registered};
use chef_ui::button::{Button, Size as ButtonSize, Variant};
use chef_ui::i18n;
use chef_ui::select::Select;
use chef_ui::text_input::{TextInput, TextInputEvent};
use chef_viewer::reload;
use chef_viewer::scroll::Layout;
use chef_viewer::split::{SharedPageCache, parse_page_input};
use gpui::{
    App, Context, Entity, FocusHandle, Focusable, IntoElement, Render, RenderImage,
    ScrollWheelEvent, Subscription, Window, canvas, div, img, prelude::*, px, rgb,
};

use crate::settings_dialog::SettingsPanel;
use crate::tabs::TabId;
use crate::theme;
use crate::viewer::{
    BUFFER_PAGES, LINE_PX, MARGIN, PAGE_GAP, POLL_MS, SharedCache, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP,
    lock_shared_cache, to_render_image,
};

/// Document snapshot passed from the active/selected tab's [`crate::viewer::Viewer`] into
/// [`ComparePane`] so both panes view independent `DocId` handles without touching core sessions.
#[derive(Clone)]
pub struct SplitSource {
    pub tab_id: TabId,
    pub title: String,
    pub doc_path: Option<PathBuf>,
    pub password: Option<zeroize::Zeroizing<String>>,
    pub generation: u64,
    pub night: bool,
}

type SelectTabCallback = Rc<dyn Fn(TabId, &mut Window, &mut App)>;
type HostActionCallback = Rc<dyn Fn(&mut Window, &mut App)>;
type BoundsCell = Rc<Cell<Option<(f32, f32, f32, f32)>>>;

pub struct ComparePane {
    handle: RenderHandle,
    shared_cache: SharedCache,
    cache_owner: u64,
    settings: Entity<SettingsPanel>,
    doc: Option<DocId>,
    loaded_source: Option<(PathBuf, u64)>,
    selected_tab: Option<TabId>,
    title: String,
    page_sizes: Vec<(f32, f32)>,
    layout: Option<Layout>,
    fit_width: bool,
    scroll_y: f32,
    viewport: (f32, f32),
    content_bounds: BoundsCell,
    raster_key: u32,
    stale: HashSet<usize>,
    pending: HashMap<usize, Receiver<Reply<PageImage>>>,
    night: bool,
    message: Option<String>,
    page_input: Entity<TextInput>,
    _subscriptions: Vec<Subscription>,
    last_synced_page: usize,
    tab_options: Vec<(TabId, String)>,
    on_select_tab: SelectTabCallback,
    on_open_file: HostActionCallback,
    on_close: HostActionCallback,
    focus: FocusHandle,
    close_focus: FocusHandle,
}

impl ComparePane {
    pub fn new(
        handle: RenderHandle,
        shared_cache: SharedCache,
        settings: Entity<SettingsPanel>,
        on_select_tab: impl Fn(TabId, &mut Window, &mut App) + 'static,
        on_open_file: impl Fn(&mut Window, &mut App) + 'static,
        on_close: impl Fn(&mut Window, &mut App) + 'static,
        cx: &mut Context<Self>,
    ) -> Self {
        let cache_owner = {
            let mut cache = shared_cache
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            cache.allocate_owner()
        };
        let page_input = cx.new(|cx| TextInput::new(cx, "1"));
        page_input.update(cx, |input, cx| input.set_text("1", cx));
        let page_sub = cx.subscribe(
            &page_input,
            |this: &mut ComparePane, _, event: &TextInputEvent, cx| {
                if matches!(event, TextInputEvent::Submit) {
                    this.jump_to_input_page(cx);
                }
            },
        );
        let settings_sub = cx.observe(&settings, |_, _, cx| cx.notify());
        let pane = Self {
            handle,
            shared_cache,
            cache_owner,
            settings,
            doc: None,
            loaded_source: None,
            selected_tab: None,
            title: String::new(),
            page_sizes: Vec::new(),
            layout: None,
            fit_width: true,
            scroll_y: 0.0,
            viewport: (0.0, 0.0),
            content_bounds: Rc::new(Cell::new(None)),
            raster_key: 0,
            stale: HashSet::new(),
            pending: HashMap::new(),
            night: false,
            message: None,
            page_input,
            _subscriptions: vec![page_sub, settings_sub],
            last_synced_page: 0,
            tab_options: Vec::new(),
            on_select_tab: Rc::new(on_select_tab),
            on_open_file: Rc::new(on_open_file),
            on_close: Rc::new(on_close),
            focus: cx.focus_handle(),
            close_focus: cx.focus_handle(),
        };
        pane.start_poll(cx);
        pane
    }

    fn lock_cache(&self) -> std::sync::MutexGuard<'_, SharedPageCache<Arc<RenderImage>>> {
        self.shared_cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn start_poll(&self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(POLL_MS))
                    .await;
                if this
                    .update(cx, |pane, cx| {
                        if pane.poll() {
                            cx.notify();
                        }
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
    }

    fn call<R>(&self, make: impl FnOnce(u64, Sender<Reply<R>>) -> Job) -> Result<R, String> {
        let (tx, rx) = channel();
        let id = self.handle.next_id();
        self.handle.send(make(id, tx))?;
        let reply = rx
            .recv()
            .map_err(|_| "luồng render không trả lời".to_string())?;
        if reply.id != id {
            return Err(format!("id trả lời {} không khớp {id}", reply.id));
        }
        reply.result
    }

    fn close_render_doc(&self, doc: DocId) {
        let (tx, _rx) = channel();
        let id = self.handle.next_id();
        let _ = self.handle.send(Job::Close { id, doc, reply: tx });
    }

    pub fn sync(
        &mut self,
        target: Option<SplitSource>,
        options: Vec<(TabId, String)>,
        cx: &mut Context<Self>,
    ) {
        self.tab_options = options;
        let Some(target) = target else {
            return;
        };
        let same_tab = self.selected_tab == Some(target.tab_id);
        self.selected_tab = Some(target.tab_id);
        self.title = target.title;

        if target.night != self.night {
            self.night = target.night;
            self.lock_cache().evict_owner(self.cache_owner);
            self.pending.clear();
            self.stale.clear();
            cx.notify();
        }

        let Some(path) = target.doc_path else {
            if let Some(previous) = self.doc.take() {
                self.close_render_doc(previous);
                self.lock_cache().evict_owner(self.cache_owner);
                self.pending.clear();
                self.stale.clear();
                self.loaded_source = None;
                self.page_sizes.clear();
                self.layout = None;
                cx.notify();
            }
            return;
        };

        let needs_reload = match &self.loaded_source {
            Some((loaded_path, loaded_gen)) => {
                loaded_path != &path || *loaded_gen != target.generation
            }
            None => true,
        };

        if !needs_reload {
            if !same_tab {
                self.scroll_y = 0.0;
                self.fit_width = true;
                self.last_synced_page = 0;
                self.page_input
                    .update(cx, |input, cx| input.set_text("1", cx));
                cx.notify();
            }
            return;
        }

        match self.load_document(path.clone(), target.password) {
            Ok((doc, sizes)) => {
                if let Some(previous) = self.doc.replace(doc) {
                    self.close_render_doc(previous);
                }
                self.lock_cache().evict_owner(self.cache_owner);
                self.pending.clear();
                self.stale.clear();
                self.loaded_source = Some((path, target.generation));
                self.page_sizes = sizes.clone();
                let zoom = if same_tab {
                    self.layout.as_ref().map_or(1.0, Layout::zoom)
                } else {
                    1.0
                };
                let layout = Layout::new(sizes, PAGE_GAP, zoom);
                if same_tab {
                    self.scroll_y = layout.clamp_scroll(self.scroll_y, self.content_height());
                } else {
                    self.scroll_y = 0.0;
                    self.fit_width = true;
                    self.last_synced_page = 0;
                    self.page_input
                        .update(cx, |input, cx| input.set_text("1", cx));
                }
                self.layout = Some(layout);
                self.message = None;
            }
            Err(error) => {
                self.message = Some(error);
            }
        }
        cx.notify();
    }

    fn load_document(
        &self,
        path: PathBuf,
        password: Option<zeroize::Zeroizing<String>>,
    ) -> Result<(DocId, Vec<(f32, f32)>), String> {
        let doc = self.call(|id, reply| Job::Open {
            id,
            path: path.clone(),
            password,
            reply,
        })?;
        let result = (|| {
            let count = self.call(|id, reply| Job::PageCount { id, doc, reply })?;
            let mut sizes = Vec::with_capacity(count);
            for index in 0..count {
                sizes.push(self.call(|id, reply| Job::PageSize {
                    id,
                    doc,
                    index,
                    reply,
                })?);
            }
            Ok(sizes)
        })();
        match result {
            Ok(sizes) => Ok((doc, sizes)),
            Err(error) => {
                self.close_render_doc(doc);
                Err(error)
            }
        }
    }

    fn poll(&mut self) -> bool {
        let ready: Vec<(usize, Reply<PageImage>)> = self
            .pending
            .iter()
            .filter_map(|(index, rx)| rx.try_recv().ok().map(|reply| (*index, reply)))
            .collect();
        let any = !ready.is_empty();
        for (index, reply) in ready {
            self.pending.remove(&index);
            match reply.result {
                Ok(mut page) => {
                    if self.night {
                        crate::night::invert_bgra(&mut page.bgra);
                    }
                    match to_render_image(page, 0) {
                        Ok((image, bytes)) => {
                            self.stale.remove(&index);
                            self.lock_cache()
                                .insert(self.cache_owner, index, image, bytes);
                        }
                        Err(error) => self.message = Some(error),
                    }
                }
                Err(error) => self.message = Some(error),
            }
        }
        any
    }

    fn content_height(&self) -> f32 {
        self.viewport.1.max(0.0)
    }

    fn current_first_page(&self) -> usize {
        let Some(layout) = self.layout.as_ref() else {
            return 0;
        };
        if layout.page_count() == 0 {
            return 0;
        }
        *layout.visible(self.scroll_y, self.content_height()).start()
    }

    pub fn scroll_by(&mut self, dy: f32) {
        let vh = self.content_height();
        if let Some(layout) = &self.layout {
            self.scroll_y = layout.clamp_scroll(self.scroll_y - dy, vh);
        }
    }

    pub fn scroll_screens(&mut self, screens: f32) {
        let step = self.content_height() * screens;
        self.scroll_by(-step);
    }

    pub fn go_to_page(&mut self, page_index: usize) {
        let vh = self.content_height();
        let Some(layout) = self.layout.as_ref() else {
            return;
        };
        if page_index >= layout.page_count() {
            return;
        }
        self.scroll_y = layout.clamp_scroll(layout.page_top(page_index), vh);
    }

    fn step_page(&mut self, delta: isize, cx: &mut Context<Self>) {
        let Some(layout) = self.layout.as_ref() else {
            return;
        };
        let count = layout.page_count();
        if count == 0 {
            return;
        }
        let current = self.current_first_page();
        let target = (current as isize + delta).clamp(0, count as isize - 1) as usize;
        self.go_to_page(target);
        self.last_synced_page = target;
        let label = (target + 1).to_string();
        self.page_input
            .update(cx, |input, cx| input.set_text(&label, cx));
        cx.notify();
    }

    fn jump_to_input_page(&mut self, cx: &mut Context<Self>) {
        let Some(count) = self.layout.as_ref().map(Layout::page_count) else {
            return;
        };
        let text = self.page_input.read(cx).text().to_string();
        if let Some(target) = parse_page_input(&text, count) {
            self.go_to_page(target);
            self.last_synced_page = target;
            let label = (target + 1).to_string();
            self.page_input
                .update(cx, |input, cx| input.set_text(&label, cx));
        } else {
            let current = self.current_first_page();
            self.last_synced_page = current;
            let label = (current + 1).to_string();
            self.page_input
                .update(cx, |input, cx| input.set_text(&label, cx));
        }
        cx.notify();
    }

    fn set_zoom(&mut self, zoom: f32) {
        let vh = self.content_height();
        let Some(layout) = self.layout.as_mut() else {
            return;
        };
        let zoom = zoom.clamp(ZOOM_MIN, ZOOM_MAX);
        let old = layout.zoom();
        if (zoom - old).abs() < 1e-6 {
            self.fit_width = false;
            return;
        }
        layout.set_zoom(zoom);
        if old > 1e-6 {
            self.scroll_y =
                layout.clamp_scroll((self.scroll_y + vh / 2.0) / old * zoom - vh / 2.0, vh);
        }
        self.fit_width = false;
    }

    fn zoom_by(&mut self, factor: f32) {
        if let Some(zoom) = self.layout.as_ref().map(Layout::zoom) {
            self.set_zoom(zoom * factor);
        }
    }

    fn reset_zoom(&mut self) {
        self.fit_width = true;
    }

    pub fn close_pane(&mut self, window: &mut Window) {
        self.pending.clear();
        self.stale.clear();
        if let Some(doc) = self.doc.take() {
            self.close_render_doc(doc);
        }
        let drops = {
            let mut cache = self.lock_cache();
            cache.evict_owner(self.cache_owner);
            cache.take_drops()
        };
        for image in drops {
            let _ = window.drop_image(image);
        }
    }

    pub fn debug_snapshot(&self) -> serde_json::Value {
        let (cached_pages, cached_bytes, shared_pages, shared_bytes, shared_budget) = {
            let cache = self.lock_cache();
            (
                cache.owner_len(self.cache_owner),
                cache.owner_bytes(self.cache_owner),
                cache.total_len(),
                cache.total_bytes(),
                cache.budget(),
            )
        };
        let page_count = self.layout.as_ref().map_or(0, Layout::page_count);
        let zoom = self.layout.as_ref().map_or(1.0, Layout::zoom);
        let first_page = self.current_first_page();
        serde_json::json!({
            "open": true,
            "targetTabId": self.selected_tab.map(TabId::get),
            "title": self.title,
            "pageCount": page_count,
            "firstPage": first_page,
            "scrollY": (self.scroll_y * 100.0).round() / 100.0,
            "zoom": (zoom * 10_000.0).round() / 10_000.0,
            "fitWidth": self.fit_width,
            "cachedPages": cached_pages,
            "cachedBytes": cached_bytes,
            "pending": self.pending.len(),
            "sharedCachePages": shared_pages,
            "sharedCacheBytes": shared_bytes,
            "sharedCacheBudget": shared_budget,
        })
    }
}

impl Drop for ComparePane {
    fn drop(&mut self) {
        if let Some(doc) = self.doc.take() {
            self.close_render_doc(doc);
        }
        if let Ok(mut cache) = self.shared_cache.lock() {
            cache.evict_owner(self.cache_owner);
        }
    }
}

impl Render for ComparePane {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let drops = self.lock_cache().take_drops();
        for image in drops {
            let _ = window.drop_image(image);
        }
        if let Some((_, _, w, h)) = self.content_bounds.get() {
            self.viewport = (w, h);
        }
        let dark = theme::is_dark(self.settings.read(cx).mode());
        let palette = theme::palette(dark);
        let (vw, vh) = self.viewport;
        let scale = window.scale_factor();

        let page_count = self.layout.as_ref().map_or(0, Layout::page_count);
        let mut first_page = 0usize;
        let mut zoom = 1.0f32;
        let mut page_elements = Vec::new();

        let owner = self.cache_owner;
        if let Some(layout) = self.layout.as_mut() {
            if self.fit_width && vw > 0.0 {
                let fit = layout.fit_width_zoom(vw, MARGIN);
                if (fit - layout.zoom()).abs() > 1e-6 {
                    let anchor = reload::capture(layout, self.scroll_y, vh);
                    layout.set_zoom(fit);
                    if self.scroll_y > 0.0
                        && let Some(anchor) = anchor
                    {
                        let (_, page_h) = layout.page_px(anchor.page);
                        self.scroll_y =
                            layout.page_top(anchor.page) + anchor.page_fraction * page_h;
                    }
                }
            }
            self.scroll_y = layout.clamp_scroll(self.scroll_y, vh);
            zoom = layout.zoom();
            let raster_key = (zoom * scale * 10_000.0).round() as u32;
            if raster_key != self.raster_key {
                self.raster_key = raster_key;
                self.pending.clear();
                self.stale = lock_shared_cache(&self.shared_cache)
                    .owner_pages(owner)
                    .into_iter()
                    .collect();
            }

            let visible: Vec<usize> = layout.visible(self.scroll_y, vh).collect();
            first_page = visible.first().copied().unwrap_or(0);
            let keep: Vec<usize> = layout
                .full_scale_set(self.scroll_y, vh, BUFFER_PAGES)
                .collect();
            let visible_set: HashSet<usize> = visible.iter().copied().collect();

            let (outside, requests) = {
                let cache = lock_shared_cache(&self.shared_cache);
                let outside: Vec<usize> = cache
                    .owner_pages(owner)
                    .into_iter()
                    .filter(|i| !keep.contains(i))
                    .collect();
                let requests: Vec<(usize, u32, u32, bool)> = keep
                    .iter()
                    .copied()
                    .filter(|i| {
                        (!cache.contains(owner, *i) || self.stale.contains(i))
                            && !self.pending.contains_key(i)
                    })
                    .map(|i| {
                        let (w, h) = layout.page_px(i);
                        (
                            i,
                            (w * scale).round().max(1.0) as u32,
                            (h * scale).round().max(1.0) as u32,
                            visible_set.contains(&i),
                        )
                    })
                    .collect();
                (outside, requests)
            };

            {
                let mut cache = lock_shared_cache(&self.shared_cache);
                for i in outside {
                    self.stale.remove(&i);
                    if let Some(image) = cache.remove(owner, i) {
                        let _ = window.drop_image(image);
                    }
                }
            }

            for (index, width, height, is_visible) in requests {
                let est_bytes = (width as usize)
                    .saturating_mul(height as usize)
                    .saturating_mul(4);
                if !is_visible && !lock_shared_cache(&self.shared_cache).can_prefetch(est_bytes) {
                    continue;
                }
                let Some(doc) = self.doc else { break };
                let (tx, rx) = channel();
                let id = self.handle.next_id();
                match self.handle.send(Job::Render {
                    id,
                    doc,
                    index,
                    width,
                    height,
                    reply: tx,
                }) {
                    Ok(()) => {
                        self.pending.insert(index, rx);
                    }
                    Err(error) => self.message = Some(error),
                }
            }

            let geometry: Vec<(usize, f32, f32, f32, f32)> = visible
                .iter()
                .copied()
                .map(|i| {
                    let (w, h) = layout.page_px(i);
                    (
                        i,
                        ((vw - w) / 2.0).max(0.0),
                        layout.page_top(i) - self.scroll_y,
                        w,
                        h,
                    )
                })
                .collect();

            for (i, x, y, w, h) in geometry {
                let image = lock_shared_cache(&self.shared_cache).get(owner, i).cloned();
                match image {
                    Some(image) => page_elements.push(
                        img(image)
                            .absolute()
                            .left(px(x))
                            .top(px(y))
                            .w(px(w))
                            .h(px(h))
                            .into_any_element(),
                    ),
                    None => page_elements.push(
                        div()
                            .absolute()
                            .left(px(x))
                            .top(px(y))
                            .w(px(w))
                            .h(px(h))
                            .bg(rgb(palette.surface))
                            .border_1()
                            .border_color(rgb(palette.border))
                            .into_any_element(),
                    ),
                }
            }
        }

        let page_input_focused = self.page_input.read(cx).focus_handle(cx).is_focused(window);
        if page_count > 0 && !page_input_focused && first_page != self.last_synced_page {
            self.last_synced_page = first_page;
            let label = (first_page + 1).to_string();
            self.page_input
                .update(cx, |input, cx| input.set_text(&label, cx));
        }
        let page_input_value = self.page_input.read(cx).text().to_string();
        a11y::register(Registered {
            id: "split-page-input".into(),
            role: "textbox",
            name: i18n::t("viewer.comparePage"),
            disabled: page_count == 0,
            focused: page_input_focused,
            hovered: false,
            checked: None,
            value: Some(page_input_value),
            bounds: None,
        });

        let selected_idx = self
            .selected_tab
            .and_then(|id| self.tab_options.iter().position(|(tid, _)| *tid == id))
            .unwrap_or(0);
        let option_labels: Vec<gpui::SharedString> = self
            .tab_options
            .iter()
            .map(|(_, label)| gpui::SharedString::from(label.clone()))
            .collect();
        let tab_ids: Vec<TabId> = self.tab_options.iter().map(|(id, _)| *id).collect();
        let on_select = self.on_select_tab.clone();
        let select_w = if vw > 0.0 {
            (vw - 400.0).clamp(90.0, 170.0)
        } else {
            140.0
        };
        let doc_select = Select::new(
            "split-doc-select",
            i18n::t("viewer.compareDocument"),
            option_labels,
        )
        .selected(selected_idx)
        .width(select_w)
        .dark(dark)
        .on_change(move |index, window, cx| {
            if let Some(&tab_id) = tab_ids.get(index) {
                on_select(tab_id, window, cx);
            }
        });

        let entity = cx.entity();
        let on_open_file = self.on_open_file.clone();
        let on_close = self.on_close.clone();
        let zoom_pct = (zoom * 100.0).round() as i32;

        let page_input_box = div()
            .flex_none()
            .child(
                div()
                    .w(px(44.))
                    .h(px(28.))
                    .flex()
                    .items_center()
                    .rounded(px(chef_theme::shared::RADIUS_SM))
                    .border_1()
                    .border_color(rgb(if page_input_focused {
                        palette.accent
                    } else {
                        palette.border
                    }))
                    .bg(rgb(palette.surface))
                    .text_color(rgb(palette.text))
                    .child(self.page_input.clone()),
            )
            .on_children_prepainted(move |bounds, _, _| {
                if let Some(b) = bounds.first() {
                    a11y::set_bounds("split-page-input", *b);
                }
            });

        let controls = div()
            .id("split-controls")
            .w_full()
            .h(px(40.))
            .px(px(8.))
            .flex()
            .flex_none()
            .items_center()
            .gap(px(4.))
            .bg(rgb(palette.surface))
            .text_color(rgb(palette.text))
            .border_b_1()
            .border_color(rgb(palette.border))
            .child(doc_select)
            .child(
                Button::new("split-open-file", cx.focus_handle())
                    .icon("icons/folder-open.svg")
                    .aria_label(i18n::t("commands.openPdf"))
                    .size(ButtonSize::Sm)
                    .variant(Variant::Ghost)
                    .dark(dark)
                    .on_click(move |_, window, cx| on_open_file(window, cx)),
            )
            .child(
                Button::new("split-prev-page", cx.focus_handle())
                    .label("‹")
                    .aria_label(i18n::t("viewer.prevPage"))
                    .size(ButtonSize::Sm)
                    .variant(Variant::Ghost)
                    .dark(dark)
                    .disabled(page_count == 0 || first_page == 0)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |this, cx| this.step_page(-1, cx));
                        }
                    }),
            )
            .child(page_input_box)
            .child(
                div()
                    .flex_none()
                    .text_size(px(chef_theme::shared::TEXT_SM))
                    .text_color(rgb(palette.text_2))
                    .child(format!("/ {page_count}")),
            )
            .child(
                Button::new("split-next-page", cx.focus_handle())
                    .label("›")
                    .aria_label(i18n::t("viewer.nextPage"))
                    .size(ButtonSize::Sm)
                    .variant(Variant::Ghost)
                    .dark(dark)
                    .disabled(page_count == 0 || first_page + 1 >= page_count)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |this, cx| this.step_page(1, cx));
                        }
                    }),
            )
            .child(div().flex_1())
            .child(
                Button::new("split-zoom-out", cx.focus_handle())
                    .label("−")
                    .aria_label(i18n::t("commands.zoomOut"))
                    .size(ButtonSize::Sm)
                    .variant(Variant::Ghost)
                    .dark(dark)
                    .disabled(page_count == 0)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |this, cx| {
                                this.zoom_by(1.0 / ZOOM_STEP);
                                cx.notify();
                            });
                        }
                    }),
            )
            .child(
                Button::new("split-zoom-reset", cx.focus_handle())
                    .label(format!("{zoom_pct}%"))
                    .aria_label(i18n::t("zoom.fitWidth"))
                    .size(ButtonSize::Sm)
                    .variant(Variant::Ghost)
                    .dark(dark)
                    .disabled(page_count == 0)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |this, cx| {
                                this.reset_zoom();
                                cx.notify();
                            });
                        }
                    }),
            )
            .child(
                Button::new("split-zoom-in", cx.focus_handle())
                    .label("+")
                    .aria_label(i18n::t("commands.zoomIn"))
                    .size(ButtonSize::Sm)
                    .variant(Variant::Ghost)
                    .dark(dark)
                    .disabled(page_count == 0)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |this, cx| {
                                this.zoom_by(ZOOM_STEP);
                                cx.notify();
                            });
                        }
                    }),
            )
            .child(
                Button::new("split-close", self.close_focus.clone())
                    .icon("icons/x.svg")
                    .aria_label(i18n::t("common.close"))
                    .size(ButtonSize::Sm)
                    .variant(Variant::Ghost)
                    .dark(dark)
                    .on_click(move |_, window, cx| on_close(window, cx)),
            );

        if let Some(error) = &self.message {
            page_elements.push(
                div()
                    .absolute()
                    .left(px(12.))
                    .top(px(12.))
                    .text_color(rgb(palette.text_2))
                    .child(error.clone())
                    .into_any_element(),
            );
        }

        let measured = self.content_bounds.clone();
        crate::debug::set_split(self.debug_snapshot());
        let content = div()
            .id("split-content")
            .relative()
            .flex_1()
            .min_w_0()
            .min_h_0()
            .overflow_hidden()
            .bg(rgb(palette.canvas))
            .on_scroll_wheel(cx.listener(|this, ev: &ScrollWheelEvent, _window, cx| {
                cx.stop_propagation();
                let dy = ev.delta.pixel_delta(px(LINE_PX)).y.as_f32();
                this.scroll_by(dy);
                cx.notify();
            }))
            .child(
                canvas(
                    move |bounds, window, _| {
                        let now = Some((
                            bounds.origin.x.as_f32(),
                            bounds.origin.y.as_f32(),
                            bounds.size.width.as_f32(),
                            bounds.size.height.as_f32(),
                        ));
                        if measured.replace(now) != now {
                            window.request_animation_frame();
                        }
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .size_full(),
            )
            .children(page_elements);

        div()
            .id("compare-pane")
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .track_focus(&self.focus)
            .child(controls)
            .child(content)
    }
}
