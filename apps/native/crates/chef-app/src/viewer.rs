//! Viewer PDF trong GPUI (TASKS_RUST R1.30, R1.32–R1.34, R2.24).
//!
//! Trang được render trên luồng pdfium (chef_pdf::render). UI giữ một cache LRU theo MB, chỉ
//! yêu cầu ảnh full-scale cho trang nhìn thấy và một trang mỗi bên, và giải phóng ảnh (texture GPU)
//! của trang đã bỏ bằng `Window::drop_image`. Tìm kiếm quét chữ từng trang trong nền (find.rs).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Duration;

use chef_pdf::render::{DocId, Job, PageImage, RenderHandle, Reply};
use chef_pdf::search;
use chef_pdf::text::{CharBox, PageText, char_at};
use chef_ui::text_input::{TextInput, TextInputEvent};
use chef_viewer::{cache::LruCache, scroll::Layout};
use gpui::{
    App, ClipboardItem, Context, Entity, FocusHandle, Focusable, IntoElement, KeyBinding,
    MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Pixels, Point, RenderImage,
    ScrollWheelEvent, Subscription, Window, actions, div, img, prelude::*, px, rgb, rgba,
};
use image::{Frame, RgbaImage};

use crate::find::Find;
use crate::password;
use crate::properties;
use crate::settings::{self, Language as SettingLanguage, Settings, Theme as SettingTheme};
use crate::settings_dialog;
use crate::theme::{self, Mode};
use chef_ui::i18n;
use zeroize::Zeroize;

actions!(
    viewer,
    [
        FocusSearch,
        SelectAllText,
        CopySelection,
        ZoomIn,
        ZoomOut,
        ZoomReset,
        NextPage,
        PrevPage,
        ToggleFullscreen,
        ToggleNight,
        OpenSettings,
        OpenFile,
        OpenProperties
    ]
);

/// Gắn phím của viewer (theo D67): Ctrl+F tìm, Ctrl+A chọn chữ của trang, Ctrl+C copy,
/// Ctrl+=, Ctrl+−, Ctrl+0 zoom, PageUp và PageDown chuyển trang, F11 toàn màn hình.
/// Gọi một lần khi khởi động app.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("ctrl-f", FocusSearch, Some("Viewer")),
        KeyBinding::new("ctrl-a", SelectAllText, Some("Viewer")),
        KeyBinding::new("ctrl-c", CopySelection, Some("Viewer")),
        KeyBinding::new("ctrl-=", ZoomIn, Some("Viewer")),
        KeyBinding::new("ctrl--", ZoomOut, Some("Viewer")),
        KeyBinding::new("ctrl-0", ZoomReset, Some("Viewer")),
        KeyBinding::new("pagedown", NextPage, Some("Viewer")),
        KeyBinding::new("pageup", PrevPage, Some("Viewer")),
        KeyBinding::new("f11", ToggleFullscreen, Some("Viewer")),
        KeyBinding::new("ctrl-,", OpenSettings, Some("Viewer")),
        KeyBinding::new("ctrl-o", OpenFile, Some("Viewer")),
        KeyBinding::new("ctrl-d", OpenProperties, Some("Viewer")),
    ]);
}

/// Hệ số đổi zoom mỗi nấc, và giới hạn zoom (tỉ lệ so với 100%).
const ZOOM_STEP: f32 = 1.25;
const ZOOM_MIN: f32 = 0.1;
const ZOOM_MAX: f32 = 8.0;

/// Vùng chữ được chọn: từ điểm bấm (anchor) đến điểm hiện tại (focus), theo (trang, chỉ số ký tự).
#[derive(Debug, Clone, Copy, PartialEq)]
struct Selection {
    anchor: (usize, usize),
    focus: (usize, usize),
}

impl Selection {
    /// Hai đầu của vùng chọn theo thứ tự đọc, đầu trước đầu sau.
    fn ordered(&self) -> ((usize, usize), (usize, usize)) {
        if self.anchor <= self.focus {
            (self.anchor, self.focus)
        } else {
            (self.focus, self.anchor)
        }
    }
}

/// Hai ký tự liền nhau nằm ở hai dòng khác nhau (theo hộp dòng).
fn new_line(prev: &CharBox, next: &CharBox) -> bool {
    !prev.line.same_line(&next.line)
}

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
/// Chiều cao thanh dưới (số trang và chỉ báo lớp chữ), pixel logic.
const FOOTER_H: f32 = 24.0;
/// Số trang lấy mẫu để biết tài liệu có chữ hay là scan (R2.29). Không đọc cả file.
const SAMPLE_PAGES: usize = 8;
/// Chu kỳ kiểm tra kết quả render, mili giây.
const POLL_MS: u64 = 16;
/// Bước cuộn cho một nấc bánh xe khi thiết bị báo theo dòng, pixel.
const LINE_PX: f32 = 40.0;

/// Cài đặt đang hiển thị: từ settings.json, hoặc mặc định khi file không đọc được.
#[derive(Clone, Default)]
struct Prefs {
    theme: SettingTheme,
    language: SettingLanguage,
    save_dir: Option<String>,
}

pub struct Viewer {
    handle: RenderHandle,
    search: Entity<TextInput>,
    /// Giữ đăng ký sự kiện của ô tìm và ô thư mục: bỏ thì không còn nhận sự kiện.
    _subscriptions: Vec<Subscription>,
    /// settings.json đã đọc. None khi file không đọc được: thay đổi chỉ còn trong phiên này.
    settings: Option<Settings>,
    settings_error: Option<String>,
    prefs: Prefs,
    settings_open: bool,
    settings_handles: settings_dialog::Handles,
    dir_input: Entity<TextInput>,
    find: Find,
    /// Tiêu điểm của khung viewer. Bấm vào trang đưa tiêu điểm về đây để Ctrl+A, Ctrl+C hoạt động.
    focus: FocusHandle,
    /// Chữ của các trang nhìn thấy (và vùng giữ), dùng cho chọn và copy.
    texts: HashMap<usize, Arc<PageText>>,
    text_pending: HashMap<usize, Receiver<Reply<PageText>>>,
    selection: Option<Selection>,
    dragging: bool,
    mode: Mode,
    doc: Option<DocId>,
    /// Đường dẫn tệp đang mở, để hộp thoại Thuộc tính đọc dung lượng.
    doc_path: Option<PathBuf>,
    /// Hộp thoại Thuộc tính (Ctrl+D): số liệu đã đọc lúc mở, và tiêu điểm nút đóng.
    props_open: bool,
    props_view: Option<properties::View>,
    props_close: FocusHandle,
    /// Hộp nhập mật khẩu (R2.26): file đang chờ mật khẩu, ô nhập, và trạng thái lần thử trước.
    password_open: bool,
    password_path: Option<PathBuf>,
    password_wrong: bool,
    password_input: Entity<TextInput>,
    password_handles: password::Handles,
    /// Đặt tiêu điểm vào ô mật khẩu ở khung kế tiếp (sau khi hộp thoại hiện).
    password_focus_pending: bool,
    layout: Option<Layout>,
    /// Vừa chiều rộng khi true (mặc định). Ctrl+=, Ctrl+− tắt chế độ này; Ctrl+0 bật lại.
    fit_width: bool,
    scroll_y: f32,
    viewport: (f32, f32),
    cache: LruCache<usize, Arc<RenderImage>>,
    pending: HashMap<usize, Receiver<Reply<PageImage>>>,
    to_drop: Vec<Arc<RenderImage>>,
    message: Option<String>,
    /// Đọc ban đêm: đảo màu trang khi nhận ảnh (night.rs).
    night: bool,
    /// Lớp chữ của tài liệu, xác định từ vài trang mẫu khi mở.
    kind: Option<DocKind>,
}

/// Tài liệu có chữ, không có chữ (scan) hay hỗn hợp (R2.29).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DocKind {
    Text,
    Scan,
    Mixed,
}

impl DocKind {
    /// Tên ngắn cho kênh debug.
    fn as_str(self) -> &'static str {
        match self {
            DocKind::Text => "text",
            DocKind::Scan => "scan",
            DocKind::Mixed => "mixed",
        }
    }

    fn label(self) -> &'static str {
        match self {
            DocKind::Text => "Có chữ",
            DocKind::Scan => "Scan, không có chữ",
            DocKind::Mixed => "Hỗn hợp: có chữ và scan",
        }
    }
}

impl Viewer {
    /// Mở `path` (nếu có). Trả về viewer; lỗi mở hiện ở `message` thay vì làm sập app.
    pub fn open(handle: RenderHandle, path: Option<PathBuf>, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| TextInput::new(cx, "Tìm trong tài liệu"));
        let subscription = cx.subscribe(
            &search,
            |this: &mut Viewer, _, event: &TextInputEvent, cx| this.on_search_event(*event, cx),
        );
        // Cài đặt: đọc settings.json trong userData (hoặc thư mục thử nghiệm). Lỗi đọc không làm sập app.
        let (settings, settings_error) = match Settings::load(&settings::user_data_dir()) {
            Ok(s) => (Some(s), None),
            Err(e) => (None, Some(e.to_string())),
        };
        let prefs = match &settings {
            Some(s) => Prefs {
                theme: s.theme(),
                language: s.language(),
                save_dir: s.default_save_dir().map(str::to_string),
            },
            None => Prefs::default(),
        };
        i18n::set_language(i18n::Lang::from_code(prefs.language.as_str()));
        let dir_input =
            cx.new(|cx| TextInput::new(cx, i18n::t("settings.defaultSaveDirPlaceholder")));
        let dir_text = prefs.save_dir.clone().unwrap_or_default();
        dir_input.update(cx, |input, cx| input.set_text(&dir_text, cx));
        let dir_subscription = cx.subscribe(
            &dir_input,
            |this: &mut Viewer, input, event: &TextInputEvent, cx| {
                if matches!(event, TextInputEvent::Submit) {
                    let text = input.read(cx).text().to_string();
                    this.set_save_dir_setting(text, cx);
                }
            },
        );
        let password_input = cx.new(|cx| TextInput::new(cx, i18n::t("password.label")));
        let password_subscription = cx.subscribe(
            &password_input,
            |this: &mut Viewer, _, event: &TextInputEvent, cx| {
                if matches!(event, TextInputEvent::Submit) {
                    this.submit_password(cx);
                }
            },
        );
        let focus = cx.focus_handle();
        let focus_for_password = focus.clone();
        let settings_handles = settings_dialog::Handles {
            theme: (0..3).map(|_| cx.focus_handle()).collect(),
            close: cx.focus_handle(),
            return_to: focus.clone(),
        };
        let mut viewer = Viewer {
            handle,
            search,
            _subscriptions: vec![subscription, dir_subscription, password_subscription],
            settings,
            settings_error,
            prefs: prefs.clone(),
            settings_open: false,
            settings_handles,
            dir_input,
            find: Find::default(),
            focus,
            texts: HashMap::new(),
            text_pending: HashMap::new(),
            selection: None,
            dragging: false,
            mode: theme::effective_mode(prefs.theme),
            doc_path: None,
            props_open: false,
            props_view: None,
            props_close: cx.focus_handle(),
            password_open: false,
            password_path: None,
            password_wrong: false,
            password_input: password_input.clone(),
            password_handles: password::Handles {
                input: password_input.read(cx).focus_handle(cx),
                close: cx.focus_handle(),
                open: cx.focus_handle(),
                return_to: focus_for_password.clone(),
            },
            password_focus_pending: false,
            doc: None,
            layout: None,
            fit_width: true,
            scroll_y: 0.0,
            viewport: (0.0, 0.0),
            cache: LruCache::new(CACHE_BUDGET),
            pending: HashMap::new(),
            to_drop: Vec::new(),
            message: None,
            night: false,
            kind: None,
        };
        match path {
            Some(p) => viewer.open_path(p),
            None => viewer.message = Some("Cách dùng: chef-app <tệp.pdf>".into()),
        }
        viewer.start_poll(cx);
        viewer
    }

    /// Ghi settings.json. Lỗi ghi hiện ở thông báo, không làm sập app.
    fn save_settings(&mut self) {
        let result = self.settings.as_mut().map(|settings| settings.save());
        if let Some(Err(e)) = result {
            self.message = Some(format!("Không lưu được cài đặt: {e}"));
        }
    }

    /// Đổi giao diện từ hộp thoại: có hiệu lực ngay và được ghi.
    pub(crate) fn set_theme_setting(&mut self, theme: SettingTheme, cx: &mut Context<Self>) {
        self.prefs.theme = theme;
        self.mode = theme::effective_mode(theme);
        if let Some(settings) = self.settings.as_mut() {
            settings.set_theme(theme);
        }
        self.save_settings();
        cx.notify();
    }

    /// Đổi ngôn ngữ từ hộp thoại: chuỗi giao diện đổi ngay và được ghi.
    pub(crate) fn set_language_setting(
        &mut self,
        language: SettingLanguage,
        cx: &mut Context<Self>,
    ) {
        self.prefs.language = language;
        i18n::set_language(i18n::Lang::from_code(language.as_str()));
        if let Some(settings) = self.settings.as_mut() {
            settings.set_language(language);
        }
        self.save_settings();
        cx.notify();
    }

    /// Đặt thư mục lưu mặc định từ ô nhập (Enter). Chuỗi rỗng là bỏ thư mục mặc định.
    pub(crate) fn set_save_dir_setting(&mut self, text: String, cx: &mut Context<Self>) {
        let dir = text.trim();
        let value = (!dir.is_empty()).then(|| dir.to_string());
        if let Some(settings) = self.settings.as_mut() {
            settings.set_default_save_dir(value.as_deref());
        }
        self.prefs.save_dir = value;
        self.save_settings();
        cx.notify();
    }

    /// Mở một file. Nếu file cần mật khẩu thì hỏi mật khẩu (R2.26); lỗi khác hiện ở thông báo.
    fn open_path(&mut self, path: PathBuf) {
        match self.load(path.clone(), None) {
            Ok(()) => {}
            Err(e) if e == chef_pdf::render::PASSWORD_REQUIRED => {
                self.password_path = Some(path);
                self.password_wrong = false;
                self.password_open = true;
                self.password_focus_pending = true;
            }
            Err(e) => {
                // Không ghi đường dẫn tài liệu vào nhật ký: chỉ sự kiện.
                crate::logging::error("mở tệp lỗi");
                self.message = Some(e);
            }
        }
    }

    /// Enter trong ô mật khẩu: thử mở bằng mật khẩu đã nhập, rồi xóa mật khẩu khỏi bộ nhớ.
    fn submit_password(&mut self, cx: &mut Context<Self>) {
        let Some(path) = self.password_path.clone() else {
            return;
        };
        let mut typed = self.password_input.read(cx).text().to_string();
        self.password_input
            .update(cx, |input, cx| input.set_text("", cx));
        let result = self.load(path, Some(typed.clone()));
        typed.zeroize();
        match result {
            Ok(()) => self.close_password_state(),
            Err(e) if e == chef_pdf::render::PASSWORD_WRONG => {
                self.password_wrong = true;
                self.password_focus_pending = true;
            }
            Err(e) => {
                self.close_password_state();
                self.message = Some(e);
            }
        }
        cx.notify();
    }

    fn close_password_state(&mut self) {
        self.password_open = false;
        self.password_path = None;
        self.password_wrong = false;
        self.password_focus_pending = false;
    }

    /// Đóng hộp nhập mật khẩu mà không mở file: xóa ô nhập và trả tiêu điểm.
    fn close_password(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.close_password_state();
        self.password_input
            .update(cx, |input, cx| input.set_text("", cx));
        window.focus(&self.focus, cx);
        cx.notify();
    }

    /// Ctrl+O: hộp chọn PDF của Windows, bắt đầu từ thư mục mặc định trong cài đặt. Mở tệp đầu tiên
    /// được chọn (nhiều tệp cần thẻ, R2.15). Hủy thì không làm gì và không báo lỗi.
    fn open_file_dialog(&mut self, _cx: &mut Context<Self>) {
        let dir = self.prefs.save_dir.as_deref().map(std::path::Path::new);
        let picked = crate::dialogs::open_pdfs(dir);
        if let Some(path) = picked.into_iter().next() {
            self.open_path(path);
        }
    }

    /// Ctrl+D: đọc thuộc tính của tài liệu đang mở rồi mở hộp thoại Thuộc tính (R2.27).
    fn open_properties(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(doc) = self.doc else {
            return;
        };
        let props = match self.call(|id, reply| Job::Properties { id, doc, reply }) {
            Ok(props) => props,
            Err(e) => {
                self.message = Some(e);
                return;
            }
        };
        let (name, size) = match self.doc_path.as_ref() {
            Some(path) => (
                path.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
            ),
            None => (String::new(), 0),
        };
        let page_no = self
            .layout
            .as_ref()
            .map(|l| *l.visible(self.scroll_y, self.viewport.1).start() + 1)
            .unwrap_or(1);
        let page_pt = props.first_page_pt;
        self.props_view = Some(properties::View {
            file_name: name,
            location: self.doc_path.as_ref().map(|p| p.display().to_string()),
            file_size: size,
            version: props.version,
            page_count: props.page_count,
            page_pt,
            page_no,
            metadata: props.metadata,
        });
        self.props_open = true;
        window.focus(&self.props_close, cx);
        cx.notify();
    }

    /// Đóng hộp thoại Thuộc tính và trả tiêu điểm về khung viewer.
    fn close_properties(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.props_open = false;
        window.focus(&self.focus, cx);
        cx.notify();
    }

    /// Mở hộp thoại Cài đặt (Ctrl+,). Tiêu điểm vào nút của chế độ đang chọn.
    fn open_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.prefs.save_dir.clone().unwrap_or_default();
        self.dir_input
            .update(cx, |input, cx| input.set_text(&text, cx));
        self.settings_open = true;
        let selected = settings_dialog::theme_index(self.prefs.theme);
        window.focus(&self.settings_handles.theme[selected], cx);
        cx.notify();
    }

    /// Đóng hộp thoại Cài đặt và trả tiêu điểm về khung viewer.
    pub(crate) fn close_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.settings_open = false;
        window.focus(&self.focus, cx);
        cx.notify();
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

    fn load(&mut self, path: PathBuf, password: Option<String>) -> Result<(), String> {
        let doc = self.call(|id, reply| Job::Open {
            id,
            path: path.clone(),
            password,
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
        self.kind = self.sample_kind(doc, count);
        self.doc = Some(doc);
        self.doc_path = Some(path);
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
                        // Chỉ vẽ lại khi có gì mới (tránh vẽ lại liên tục mỗi 16 ms).
                        let images = viewer.poll();
                        let found = viewer.poll_find();
                        let texts = viewer.poll_text();
                        let scanning = viewer.scanning();
                        if images || found || texts || scanning {
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
                Ok(mut page) => {
                    if self.night {
                        crate::night::invert_bgra(&mut page.bgra);
                    }
                    match to_render_image(page) {
                        Ok((image, bytes)) => {
                            self.to_drop.extend(self.cache.insert(index, image, bytes));
                        }
                        Err(e) => self.message = Some(e),
                    }
                }
                Err(e) => self.message = Some(e),
            }
        }
        any
    }

    /// Gửi thêm yêu cầu đọc chữ cho việc tìm và nhận các trang đã đọc xong. Trả true nếu có khớp mới.
    fn poll_find(&mut self) -> bool {
        let (Some(doc), Some(count)) = (self.doc, self.layout.as_ref().map(|l| l.page_count()))
        else {
            return false;
        };
        self.find.feed(&self.handle, doc, count);
        self.find.poll()
    }

    /// Đọc chữ cho các trang trong vùng giữ, bỏ chữ của trang đã ra khỏi vùng. Trả true nếu có chữ mới.
    fn poll_text(&mut self) -> bool {
        let (Some(layout), Some(doc)) = (self.layout.as_ref(), self.doc) else {
            return false;
        };
        let keep = layout.full_scale_set(self.scroll_y, self.content_height(), BUFFER_PAGES);
        let ready: Vec<(usize, Reply<PageText>)> = self
            .text_pending
            .iter()
            .filter_map(|(index, rx)| rx.try_recv().ok().map(|reply| (*index, reply)))
            .collect();
        let any = !ready.is_empty();
        for (index, reply) in ready {
            self.text_pending.remove(&index);
            if let Ok(text) = reply.result {
                self.texts.insert(index, Arc::new(text));
            }
        }
        self.texts.retain(|i, _| keep.contains(i));
        let wanted: Vec<usize> = keep
            .filter(|i| !self.texts.contains_key(i) && !self.text_pending.contains_key(i))
            .collect();
        for index in wanted {
            let (tx, rx) = channel();
            let id = self.handle.next_id();
            if self
                .handle
                .send(Job::PageText {
                    id,
                    doc,
                    index,
                    reply: tx,
                })
                .is_ok()
            {
                self.text_pending.insert(index, rx);
            }
        }
        any
    }

    /// Chữ của một trang: lấy từ cache, không có thì đọc ngay (dùng khi copy nhiều trang).
    fn text_of(&mut self, page: usize) -> Option<Arc<PageText>> {
        if let Some(text) = self.texts.get(&page) {
            return Some(text.clone());
        }
        let doc = self.doc?;
        let text = Arc::new(
            self.call(|id, reply| Job::PageText {
                id,
                doc,
                index: page,
                reply,
            })
            .ok()?,
        );
        self.texts.insert(page, text.clone());
        Some(text)
    }

    /// Trang và chỉ số ký tự dưới điểm bấm (tọa độ cửa sổ). None nếu điểm không nằm trên chữ đã đọc.
    fn point_to_char(&self, pos: Point<Pixels>) -> Option<(usize, usize)> {
        let layout = self.layout.as_ref()?;
        let (vw, _) = self.viewport;
        let (x, y) = (pos.x.as_f32(), pos.y.as_f32() - TOOLBAR_H);
        let zoom = layout.zoom();
        for i in layout.visible(self.scroll_y, self.content_height()) {
            let (w, h) = layout.page_px(i);
            let x0 = ((vw - w) / 2.0).max(0.0);
            let y0 = layout.page_top(i) - self.scroll_y;
            if y < y0 || y > y0 + h {
                continue;
            }
            let text = self.texts.get(&i)?;
            let idx = char_at(&text.chars, (x - x0) / zoom, (y - y0) / zoom)?;
            return Some((i, idx));
        }
        None
    }

    fn on_mouse_down(&mut self, ev: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        self.selection = self.point_to_char(ev.position).map(|p| Selection {
            anchor: p,
            focus: p,
        });
        self.dragging = self.selection.is_some();
        cx.notify();
    }

    fn on_mouse_move(&mut self, ev: &MouseMoveEvent, _window: &mut Window, cx: &mut Context<Self>) {
        if !self.dragging {
            return;
        }
        if let Some(p) = self.point_to_char(ev.position) {
            if let Some(sel) = self.selection.as_mut() {
                sel.focus = p;
            }
            cx.notify();
        }
    }

    fn on_mouse_up(&mut self, _ev: &MouseUpEvent, _window: &mut Window, _cx: &mut Context<Self>) {
        self.dragging = false;
    }

    /// Ctrl+A: chọn toàn bộ chữ của trang nhìn thấy đầu tiên.
    fn select_all_text(&mut self, cx: &mut Context<Self>) {
        let Some(layout) = self.layout.as_ref() else {
            return;
        };
        let first = layout.visible(self.scroll_y, self.content_height()).next();
        if let Some(page) = first
            && let Some(text) = self.text_of(page)
            && let Some(last) = text.chars.len().checked_sub(1)
        {
            self.selection = Some(Selection {
                anchor: (page, 0),
                focus: (page, last),
            });
        }
        cx.notify();
    }

    /// Ctrl+C: đưa chữ đã chọn lên clipboard (Unicode). Xuống dòng khi sang dòng mới, và giữa các trang.
    fn copy_selection(&mut self, cx: &mut Context<Self>) {
        let Some(sel) = self.selection else {
            return;
        };
        let ((first_page, first), (last_page, last)) = sel.ordered();
        let mut out = String::new();
        for page in first_page..=last_page {
            let Some(text) = self.text_of(page) else {
                return;
            };
            let start = if page == first_page { first } else { 0 };
            let end = if page == last_page {
                (last + 1).min(text.chars.len())
            } else {
                text.chars.len()
            };
            let mut prev: Option<CharBox> = None;
            for cb in text.chars.get(start..end).unwrap_or(&[]) {
                if prev.as_ref().is_some_and(|p| new_line(p, cb)) {
                    out.push('\n');
                }
                out.push(cb.ch);
                prev = Some(*cb);
            }
            if page != last_page {
                out.push('\n');
            }
        }
        cx.write_to_clipboard(ClipboardItem::new_string(out));
    }

    fn scanning(&self) -> bool {
        match &self.layout {
            Some(layout) => self.find.scanning(layout.page_count()),
            None => false,
        }
    }

    /// Chiều cao vùng trang, trừ thanh tìm kiếm và thanh dưới.
    fn content_height(&self) -> f32 {
        (self.viewport.1 - TOOLBAR_H - FOOTER_H).max(0.0)
    }

    fn scroll_by(&mut self, dy: f32) {
        let vh = self.content_height();
        if let Some(layout) = &self.layout {
            self.scroll_y = layout.clamp_scroll(self.scroll_y - dy, vh);
        }
    }

    /// Đọc chữ của vài trang đều nhau để biết tài liệu có chữ, không có chữ hay hỗn hợp.
    /// Không đọc cả file: tối đa `SAMPLE_PAGES` trang.
    fn sample_kind(&self, doc: DocId, count: usize) -> Option<DocKind> {
        if count == 0 {
            return None;
        }
        let n = SAMPLE_PAGES.min(count);
        let mut with_text = 0;
        for j in 0..n {
            let index = if n == 1 { 0 } else { j * (count - 1) / (n - 1) };
            let text = self
                .call(|id, reply| Job::PageText {
                    id,
                    doc,
                    index,
                    reply,
                })
                .ok()?;
            if !text.chars.is_empty() {
                with_text += 1;
            }
        }
        Some(match with_text {
            n_text if n_text == n => DocKind::Text,
            0 => DocKind::Scan,
            _ => DocKind::Mixed,
        })
    }

    /// Bật hoặc tắt đọc ban đêm. Bỏ ảnh đã có để trang vẽ lại theo chế độ mới.
    fn toggle_night(&mut self) {
        self.night = !self.night;
        for index in self.cache.keys() {
            if let Some(image) = self.cache.remove(&index) {
                self.to_drop.push(image);
            }
        }
        crate::debug::set_night(self.night);
    }

    /// Đặt zoom và giữ nguyên điểm ở giữa vùng nhìn (trên trang) sau khi đổi.
    fn set_zoom(&mut self, zoom: f32) {
        let vh = self.content_height();
        let Some(layout) = self.layout.as_mut() else {
            return;
        };
        let zoom = zoom.clamp(ZOOM_MIN, ZOOM_MAX);
        let old = layout.zoom();
        if (zoom - old).abs() < 1e-6 {
            return;
        }
        let anchor = (self.scroll_y + vh / 2.0) / old;
        layout.set_zoom(zoom);
        self.scroll_y = layout.clamp_scroll(anchor * zoom - vh / 2.0, vh);
        self.fit_width = false;
    }

    fn zoom_by(&mut self, factor: f32) {
        if let Some(zoom) = self.layout.as_ref().map(|l| l.zoom()) {
            self.set_zoom(zoom * factor);
        }
    }

    /// Ctrl+0: trở về vừa chiều rộng.
    fn reset_zoom(&mut self) {
        self.fit_width = true;
    }

    /// PageDown và PageUp: đưa đầu trang kế (hoặc trước) lên đầu vùng nhìn.
    fn go_page(&mut self, delta: isize) {
        let vh = self.content_height();
        let Some(layout) = self.layout.as_ref() else {
            return;
        };
        let current = *layout.visible(self.scroll_y, vh).start();
        let last = layout.page_count().saturating_sub(1);
        let target = (current as isize + delta).clamp(0, last as isize) as usize;
        self.scroll_y = layout.clamp_scroll(layout.page_top(target), vh);
    }

    /// Ô tìm kiếm trên thanh viewer. Kênh debug đọc nội dung và vùng chọn qua đây.
    pub fn search(&self) -> &Entity<TextInput> {
        &self.search
    }

    /// Đưa tiêu điểm vào ô tìm kiếm để gõ được ngay. Gọi ngoài render (sau khi mở cửa sổ).
    pub fn focus_search(&self, window: &mut Window, cx: &mut App) {
        let handle = self.search.focus_handle(cx);
        window.focus(&handle, cx);
    }

    /// Cuộn theo số màn hình (chiều cao vùng nhìn). Dùng khi đo bộ nhớ trong E2E.
    pub fn scroll_screens(&mut self, screens: f32) {
        let step = self.viewport.1 * screens;
        self.scroll_by(-step);
    }

    /// Phản ứng với ô tìm: đổi cụm tìm, Enter và Shift+Enter đi tới, Esc xóa.
    fn on_search_event(&mut self, event: TextInputEvent, cx: &mut Context<Self>) {
        match event {
            TextInputEvent::Changed => {
                let query = self.search.read(cx).text().to_string();
                self.find.set_query(&query);
            }
            TextInputEvent::Submit => self.step_find(1),
            TextInputEvent::SubmitBack => self.step_find(-1),
            TextInputEvent::Cancel => {
                self.search.update(cx, |input, cx| input.set_text("", cx));
                self.find.clear();
            }
        }
        cx.notify();
    }

    fn step_find(&mut self, delta: isize) {
        if let Some((page, index)) = self.find.step(delta) {
            self.scroll_to_match(page, index);
        }
    }

    /// Cuộn để dòng đầu của khớp nằm ở một phần ba chiều cao vùng nhìn.
    fn scroll_to_match(&mut self, page: usize, index: usize) {
        let (Some(layout), Some(rect)) = (
            self.layout.as_ref(),
            self.find
                .matches_on(page)
                .get(index)
                .and_then(|boxes| boxes.first()),
        ) else {
            return;
        };
        let vh = self.content_height();
        let y = layout.page_top(page) + rect.top * layout.zoom();
        self.scroll_y = layout.clamp_scroll(y - vh / 3.0, vh);
    }

    /// Chữ trên nút đếm: "k/N", thêm dấu … khi còn đang quét.
    fn counter_label(&self, scanning: bool) -> String {
        let total = self.find.total();
        let current = self.find.current().map_or(0, |k| k + 1);
        let more = if scanning { "…" } else { "" };
        format!("{current}/{total}{more}")
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
        // Đầu khung: xóa danh sách điều khiển của khung trước, để lệnh `state` không đọc bản cũ.
        chef_ui::a11y::begin_frame(window.scale_factor());
        let vp = window.viewport_size();
        self.viewport = (vp.width.as_f32(), vp.height.as_f32());
        for old in self.to_drop.drain(..) {
            let _ = window.drop_image(old);
        }
        let palette = theme::palette(theme::is_dark(self.mode));
        crate::debug::set_message(self.message.as_deref());
        let entity = cx.entity();
        if self.password_focus_pending {
            self.password_focus_pending = false;
            // Hộp thoại dựng ở khung này, nên tiêu điểm đặt sau khi khung vẽ xong (defer). Trong E2E cửa sổ
            // không active nên tiêu điểm lập trình không giữ; E2E bấm vào ô trước (xem e2e-native-password).
            let focus = self.password_input.read(cx).focus_handle(cx);
            window.defer(cx, move |window, cx| {
                window.focus(&focus, cx);
                window.refresh();
            });
        }
        crate::debug::set_password(self.password_open, self.password_wrong);
        let password_dialog = if self.password_open {
            let name = self
                .password_path
                .as_ref()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let dismiss_entity = entity.clone();
            let open_entity = entity.clone();
            Some(password::build(
                &name,
                self.password_wrong,
                theme::is_dark(self.mode),
                &self.password_input,
                &self.password_handles,
                move |window, cx| {
                    dismiss_entity.update(cx, |this, cx| this.close_password(window, cx));
                },
                move |_window, cx| {
                    open_entity.update(cx, |this, cx| this.submit_password(cx));
                },
            ))
        } else {
            None
        };
        let props_dialog = if self.props_open {
            self.props_view.as_ref().map(|view| {
                crate::debug::set_properties(Some(properties::to_json(view)));
                let close_entity = entity.clone();
                properties::build(
                    view,
                    theme::is_dark(self.mode),
                    self.props_close.clone(),
                    self.focus.clone(),
                    move |window, cx| {
                        close_entity.update(cx, |this, cx| this.close_properties(window, cx));
                    },
                )
            })
        } else {
            crate::debug::set_properties(None);
            None
        };
        crate::debug::set_settings(
            self.prefs.theme.as_str(),
            self.prefs.language.as_str(),
            self.prefs.save_dir.as_deref(),
            self.settings_open,
        );
        let settings_dialog = self.settings_open.then(|| {
            let snapshot = settings_dialog::Snapshot {
                theme: self.prefs.theme,
                language: self.prefs.language,
                dark: theme::is_dark(self.mode),
                read_error: self.settings_error.clone(),
            };
            settings_dialog::build(
                &cx.entity(),
                &snapshot,
                &self.settings_handles,
                &self.dir_input,
                window,
                cx,
            )
        });
        let scanning = self.scanning();
        let label = if self.find.is_active() {
            self.counter_label(scanning)
        } else {
            String::new()
        };
        let toolbar = div()
            .w_full()
            .h(px(TOOLBAR_H))
            .px(px(12.))
            .flex()
            .flex_none()
            .items_center()
            .gap(px(8.))
            .bg(rgb(palette.surface))
            .text_color(rgb(palette.text))
            .border_b_1()
            .border_color(rgb(palette.border))
            .child(div().flex_1().child(self.search.clone()))
            .child(
                div()
                    .flex_none()
                    .text_color(rgb(palette.text_2))
                    .child(label),
            );
        let root = div()
            .size_full()
            .flex()
            .flex_col()
            .overflow_hidden()
            .bg(rgb(palette.canvas))
            .key_context("Viewer")
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &FocusSearch, window, cx| {
                this.focus_search(window, cx);
            }))
            .on_action(cx.listener(|this, _: &SelectAllText, _window, cx| {
                this.select_all_text(cx);
            }))
            .on_action(cx.listener(|this, _: &CopySelection, _window, cx| {
                this.copy_selection(cx);
            }))
            .on_action(cx.listener(|this, _: &ZoomIn, _window, cx| {
                this.zoom_by(ZOOM_STEP);
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &ZoomOut, _window, cx| {
                this.zoom_by(1.0 / ZOOM_STEP);
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &ZoomReset, _window, cx| {
                this.reset_zoom();
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &NextPage, _window, cx| {
                this.go_page(1);
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &PrevPage, _window, cx| {
                this.go_page(-1);
                cx.notify();
            }))
            .on_action(cx.listener(|_this, _: &ToggleFullscreen, window, cx| {
                window.toggle_fullscreen();
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &ToggleNight, _window, cx| {
                this.toggle_night();
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &OpenSettings, window, cx| {
                this.open_settings(window, cx);
            }))
            .on_action(cx.listener(|this, _: &OpenFile, _window, cx| {
                this.open_file_dialog(cx);
                cx.notify();
            }))
            .on_action(cx.listener(|this, _: &OpenProperties, window, cx| {
                this.open_properties(window, cx);
            }))
            .on_scroll_wheel(cx.listener(|this, ev: &ScrollWheelEvent, _window, cx| {
                let dy = ev.delta.pixel_delta(px(LINE_PX)).y.as_f32();
                this.scroll_by(dy);
                cx.notify();
            }));

        let (vw, vh) = self.viewport;
        let scale = window.scale_factor();
        let Some(layout) = self.layout.as_mut() else {
            let text = self.message.clone().unwrap_or_default();
            return root
                .child(toolbar)
                .child(
                    div()
                        .size_full()
                        .flex()
                        .items_center()
                        .justify_center()
                        .text_color(rgb(palette.text_2))
                        .child(text),
                )
                .children(settings_dialog)
                .children(props_dialog)
                .children(password_dialog);
        };
        if self.fit_width && vw > 0.0 {
            let fit = layout.fit_width_zoom(vw, MARGIN);
            if (fit - layout.zoom()).abs() > 1e-6 {
                layout.set_zoom(fit);
            }
        }
        let vh = (vh - TOOLBAR_H - FOOTER_H).max(0.0);
        self.scroll_y = layout.clamp_scroll(self.scroll_y, vh);
        let zoom = layout.zoom();
        let page_count = layout.page_count();

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
        crate::debug::set_view(
            zoom,
            self.scroll_y,
            vh,
            self.fit_width,
            *layout.visible(self.scroll_y, vh).start(),
            self.kind.map_or("", |k| k.as_str()),
        );
        crate::debug::set_find(
            self.find.query(),
            self.find.total(),
            self.find.current(),
            self.find.scanning(page_count),
        );
        let current = self.find.current().and_then(|k| self.find.locate(k));
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
            // Vùng chữ đã chọn trên trang này.
            if let Some(sel) = self.selection {
                let ((first_page, first), (last_page, last)) = sel.ordered();
                if (first_page..=last_page).contains(&i)
                    && let Some(text) = self.texts.get(&i)
                {
                    let start = if i == first_page { first } else { 0 };
                    let end = if i == last_page {
                        (last + 1).min(text.chars.len())
                    } else {
                        text.chars.len()
                    };
                    if start < end {
                        for rect in search::rects(&text.chars, start..end) {
                            children.push(
                                div()
                                    .absolute()
                                    .left(px(x + rect.left * zoom))
                                    .top(px(y + rect.top * zoom))
                                    .w(px((rect.right - rect.left) * zoom))
                                    .h(px((rect.bottom - rect.top) * zoom))
                                    .bg(rgba(palette.selection))
                                    .into_any_element(),
                            );
                        }
                    }
                }
            }
            // Tô sáng khớp tìm kiếm trên trang nhìn thấy; khớp đang chọn có màu đậm hơn.
            for (k, boxes) in self.find.matches_on(i).iter().enumerate() {
                let color = if current == Some((i, k)) {
                    palette.highlight_selected
                } else {
                    palette.highlight
                };
                for rect in boxes {
                    children.push(
                        div()
                            .absolute()
                            .left(px(x + rect.left * zoom))
                            .top(px(y + rect.top * zoom))
                            .w(px((rect.right - rect.left) * zoom))
                            .h(px((rect.bottom - rect.top) * zoom))
                            .bg(rgba(color))
                            .into_any_element(),
                    );
                }
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
        // Chuột trên vùng trang (không gồm thanh tìm kiếm): chọn chữ.
        let content = div()
            .relative()
            .flex_1()
            .w_full()
            .overflow_hidden()
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .children(children);
        // Thanh dưới: số trang và lớp chữ của tài liệu.
        let footer = div()
            .w_full()
            .h(px(FOOTER_H))
            .px(px(12.))
            .flex()
            .flex_none()
            .items_center()
            .justify_between()
            .bg(rgb(palette.surface))
            .text_color(rgb(palette.text_2))
            .border_t_1()
            .border_color(rgb(palette.border))
            .child(format!(
                "Trang {} / {}",
                layout.visible(self.scroll_y, vh).start() + 1,
                page_count
            ))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .child(
                        div()
                            .id("night-toggle")
                            .px(px(6.))
                            .cursor_pointer()
                            .text_color(rgb(if self.night {
                                palette.text
                            } else {
                                palette.text_2
                            }))
                            .child(if self.night {
                                "Tắt đọc ban đêm"
                            } else {
                                "Đọc ban đêm"
                            })
                            .on_mouse_down(
                                MouseButton::Left,
                                cx.listener(|this, _: &MouseDownEvent, _window, cx| {
                                    this.toggle_night();
                                    cx.notify();
                                }),
                            ),
                    )
                    .child(self.kind.map_or("", |k| k.label())),
            );
        root.child(toolbar)
            .child(content)
            .child(footer)
            .children(settings_dialog)
            .children(props_dialog)
            .children(password_dialog)
    }
}
