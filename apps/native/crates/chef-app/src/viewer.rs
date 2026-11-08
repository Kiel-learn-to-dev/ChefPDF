//! Viewer PDF trong GPUI (TASKS_RUST R1.30, R1.32–R1.34).
//!
//! Trang được render trên luồng pdfium (chef_pdf::render). UI giữ một cache LRU theo MB, chỉ
//! yêu cầu ảnh full-scale cho trang nhìn thấy và một trang mỗi bên, và giải phóng ảnh (texture GPU)
//! của trang đã bỏ bằng `Window::drop_image`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Duration;

use chef_pdf::render::{DocId, Job, PageImage, RenderHandle, Reply};
use chef_ui::text_input::TextInput;
use chef_viewer::{cache::LruCache, scroll::Layout};
use gpui::{
    App, Context, Entity, Focusable, IntoElement, RenderImage, ScrollWheelEvent, Window, div, img,
    prelude::*, px, rgb,
};
use image::{Frame, RgbaImage};

use crate::theme::{self, Mode};

/// Trần bộ nhớ bitmap trang trong cache (R1 của BLUEPRINT_RUST §2.2). Khởi điểm 256 MB.
const CACHE_BUDGET: usize = 256 * 1024 * 1024;
/// Khoảng cách giữa hai trang, pixel logic.
const PAGE_GAP: f32 = 16.0;
/// Lề hai bên khi vừa chiều rộng, pixel logic.
const MARGIN: f32 = 24.0;
/// Số trang giữ bitmap đầy đủ ngoài vùng nhìn (R2 của BLUEPRINT_RUST §2.2).
const BUFFER_PAGES: usize = 1;
/// Chiều cao thanh tìm kiếm phía trên trang, pixel logic.
const TOOLBAR_H: f32 = 40.0;
/// Chu kỳ kiểm tra kết quả render, mili giây.
const POLL_MS: u64 = 16;
/// Bước cuộn cho một nấc bánh xe khi thiết bị báo theo dòng, pixel.
const LINE_PX: f32 = 40.0;

pub struct Viewer {
    handle: RenderHandle,
    search: Entity<TextInput>,
    mode: Mode,
    doc: Option<DocId>,
    layout: Option<Layout>,
    zoom_fitted: bool,
    scroll_y: f32,
    viewport: (f32, f32),
    cache: LruCache<usize, Arc<RenderImage>>,
    pending: HashMap<usize, Receiver<Reply<PageImage>>>,
    to_drop: Vec<Arc<RenderImage>>,
    message: Option<String>,
}

impl Viewer {
    /// Mở `path` (nếu có). Trả về viewer; lỗi mở hiện ở `message` thay vì làm sập app.
    pub fn open(handle: RenderHandle, path: Option<PathBuf>, cx: &mut Context<Self>) -> Self {
        let mut viewer = Viewer {
            handle,
            search: cx.new(|cx| TextInput::new(cx, "Tìm trong tài liệu")),
            mode: theme::mode_from_env(),
            doc: None,
            layout: None,
            zoom_fitted: false,
            scroll_y: 0.0,
            viewport: (0.0, 0.0),
            cache: LruCache::new(CACHE_BUDGET),
            pending: HashMap::new(),
            to_drop: Vec::new(),
            message: None,
        };
        match path {
            Some(p) => {
                if let Err(e) = viewer.load(p) {
                    viewer.message = Some(e);
                }
            }
            None => viewer.message = Some("Cách dùng: chef-app <tệp.pdf>".into()),
        }
        viewer.start_poll(cx);
        viewer
    }

    /// Gửi một job và chờ trả lời. Dùng cho thao tác mở và đọc kích thước (nhanh).
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

    fn load(&mut self, path: PathBuf) -> Result<(), String> {
        let doc = self.call(|id, reply| Job::Open {
            id,
            path: path.clone(),
            password: None,
            reply,
        })?;
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
        self.doc = Some(doc);
        self.layout = Some(Layout::new(sizes, PAGE_GAP, 1.0));
        Ok(())
    }

    /// Kiểm tra định kỳ các yêu cầu đang chờ và nạp ảnh về cache.
    fn start_poll(&self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(POLL_MS))
                    .await;
                if this
                    .update(cx, |viewer, cx| {
                        // Chỉ vẽ lại khi có ảnh mới (tránh vẽ lại liên tục mỗi 16 ms).
                        if viewer.poll() {
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

    /// Nạp các ảnh đã render xong. Trả true nếu có ảnh mới.
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
                Ok(page) => match to_render_image(page) {
                    Ok((image, bytes)) => {
                        self.to_drop.extend(self.cache.insert(index, image, bytes));
                    }
                    Err(e) => self.message = Some(e),
                },
                Err(e) => self.message = Some(e),
            }
        }
        any
    }

    /// Chiều cao vùng trang, trừ thanh tìm kiếm.
    fn content_height(&self) -> f32 {
        (self.viewport.1 - TOOLBAR_H).max(0.0)
    }

    fn scroll_by(&mut self, dy: f32) {
        let vh = self.content_height();
        if let Some(layout) = &self.layout {
            self.scroll_y = layout.clamp_scroll(self.scroll_y - dy, vh);
        }
    }

    /// Đưa tiêu điểm vào thanh tìm kiếm để gõ được ngay. Gọi ngoài render (sau khi mở cửa sổ).
    pub fn focus_search(&self, window: &mut Window, cx: &mut App) {
        let handle = self.search.focus_handle(cx);
        window.focus(&handle, cx);
    }

    /// Cuộn theo số màn hình (chiều cao vùng nhìn). Dùng khi đo bộ nhớ trong E2E.
    pub fn scroll_screens(&mut self, screens: f32) {
        let step = self.viewport.1 * screens;
        self.scroll_by(-step);
    }
}

/// Đổi ảnh BGRA của pdfium thành RenderImage của gpui (cũng là BGRA). Trả về ảnh và số byte.
fn to_render_image(page: PageImage) -> Result<(Arc<RenderImage>, usize), String> {
    let bytes = page.bgra.len();
    let buffer = RgbaImage::from_raw(page.width, page.height, page.bgra)
        .ok_or_else(|| "kích thước bitmap không khớp".to_string())?;
    Ok((Arc::new(RenderImage::new(vec![Frame::new(buffer)])), bytes))
}

impl Render for Viewer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        crate::debug::count_render();
        let vp = window.viewport_size();
        self.viewport = (vp.width.as_f32(), vp.height.as_f32());
        for old in self.to_drop.drain(..) {
            let _ = window.drop_image(old);
        }
        let palette = theme::palette(theme::is_dark(self.mode));
        let toolbar = div()
            .w_full()
            .h(px(TOOLBAR_H))
            .px(px(12.))
            .flex()
            .flex_none()
            .items_center()
            .bg(rgb(palette.surface))
            .border_b_1()
            .border_color(rgb(palette.border))
            .child(self.search.clone());
        let root = div()
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .bg(rgb(palette.canvas))
            .on_scroll_wheel(cx.listener(|this, ev: &ScrollWheelEvent, _window, cx| {
                let dy = ev.delta.pixel_delta(px(LINE_PX)).y.as_f32();
                this.scroll_by(dy);
                cx.notify();
            }));

        let (vw, vh) = self.viewport;
        let scale = window.scale_factor();
        let Some(layout) = self.layout.as_mut() else {
            let text = self.message.clone().unwrap_or_default();
            return root.child(toolbar).child(
                div()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_color(rgb(palette.text_2))
                    .child(text),
            );
        };
        if !self.zoom_fitted && vw > 0.0 {
            layout.set_zoom(layout.fit_width_zoom(vw, MARGIN));
            self.zoom_fitted = true;
        }
        let vh = (vh - TOOLBAR_H).max(0.0);
        self.scroll_y = layout.clamp_scroll(self.scroll_y, vh);

        // Vùng nhìn và vùng giữ bitmap. Các trang ngoài vùng giữ bị bỏ khỏi cache (R2).
        let visible = layout.visible(self.scroll_y, vh);
        let keep = layout.full_scale_set(self.scroll_y, vh, BUFFER_PAGES);
        let geometry: Vec<(usize, f32, f32, f32, f32)> = visible
            .clone()
            .map(|i| {
                let (w, h) = layout.page_px(i);
                let x = ((vw - w) / 2.0).max(0.0);
                let y = layout.page_top(i) - self.scroll_y;
                (i, x, y, w, h)
            })
            .collect();
        let requests: Vec<(usize, u32, u32)> = keep
            .clone()
            .filter(|i| !self.cache.contains(i) && !self.pending.contains_key(i))
            .map(|i| {
                let (w, h) = layout.page_px(i);
                (i, (w * scale).round() as u32, (h * scale).round() as u32)
            })
            .collect();
        let outside: Vec<usize> = self
            .cache
            .keys()
            .into_iter()
            .filter(|i| !keep.contains(i))
            .collect();

        for i in outside {
            if let Some(image) = self.cache.remove(&i) {
                self.to_drop.push(image);
            }
        }
        for (index, width, height) in requests {
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
                Err(e) => self.message = Some(e),
            }
        }

        crate::debug::set_viewer_stats(self.cache.len(), self.pending.len());
        let mut children = Vec::new();
        for (i, x, y, w, h) in geometry {
            match self.cache.get(&i).cloned() {
                Some(image) => children.push(
                    img(image)
                        .absolute()
                        .left(px(x))
                        .top(px(y))
                        .w(px(w))
                        .h(px(h))
                        .into_any_element(),
                ),
                None => children.push(
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
        if let Some(text) = self.message.clone() {
            children.push(
                div()
                    .absolute()
                    .left(px(12.))
                    .top(px(12.))
                    .text_color(rgb(palette.text))
                    .child(text)
                    .into_any_element(),
            );
        }
        let content = div()
            .relative()
            .flex_1()
            .w_full()
            .overflow_hidden()
            .children(children);
        root.child(toolbar).child(content)
    }
}
