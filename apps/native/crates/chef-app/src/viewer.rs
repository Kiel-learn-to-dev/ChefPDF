//! Viewer PDF trong GPUI (TASKS_RUST R1.30, R1.32–R1.34, R2.24).
//!
//! Trang được render trên luồng pdfium (chef_pdf::render). UI giữ một cache LRU theo MB, chỉ
//! yêu cầu ảnh full-scale cho trang nhìn thấy và một trang mỗi bên, và giải phóng ảnh (texture GPU)
//! của trang đã bỏ bằng `Window::drop_image`. Tìm kiếm quét chữ từng trang trong nền (find.rs).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chef_pdf::render::{Bookmark, DocId, Job, PageImage, RenderHandle, Reply};
use chef_pdf::search;
use chef_pdf::text::{CharBox, PageText, char_at};
use chef_rpc::{CallError, Supervisor};
use chef_ui::button::{Button, Size as ButtonSize, Variant};
use chef_ui::text_input::{TextInput, TextInputEvent};
use chef_viewer::{
    cache::LruCache,
    reload,
    scroll::Layout,
    sidebar::SidebarLayout,
    spread::{PageMode, SpreadLayout},
};
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
use crate::source_guard::{self, Fingerprint, Verdict};
use crate::theme::{self, Mode};
use chef_ui::i18n;

actions!(
    viewer,
    [
        FocusSearch,
        SelectAllText,
        CopySelection,
        ZoomIn,
        ZoomOut,
        ZoomReset,
        ZoomFitPage,
        RotateViewLeft,
        RotateViewRight,
        FocusZoomInput,
        NextPage,
        PrevPage,
        ToggleFullscreen,
        ToggleNight,
        OpenSettings,
        OpenFile,
        OpenProperties,
        RotatePage,
        UndoEdit,
        RedoEdit,
        SaveEdit,
        SaveEditAs,
        RetryRevisionReload,
        SetTwoPage,
        SetBook,
        SetContinuous,
        SetSlideshow,
        SlideNext,
        SlidePrevious,
        ExitSlideshow
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
        KeyBinding::new("left", SlidePrevious, Some("Viewer")),
        KeyBinding::new("right", SlideNext, Some("Viewer")),
        KeyBinding::new("escape", ExitSlideshow, Some("Viewer")),
        KeyBinding::new("ctrl-,", OpenSettings, Some("Viewer")),
        KeyBinding::new("ctrl-o", OpenFile, Some("Viewer")),
        KeyBinding::new("ctrl-d", OpenProperties, Some("Viewer")),
        KeyBinding::new("ctrl-r", RotatePage, Some("Viewer")),
        KeyBinding::new("ctrl-z", UndoEdit, Some("Viewer")),
        KeyBinding::new("ctrl-y", RedoEdit, Some("Viewer")),
        KeyBinding::new("ctrl-s", SaveEdit, Some("Viewer")),
        KeyBinding::new("ctrl-shift-r", RetryRevisionReload, Some("Viewer")),
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
/// Fixed navigation rail for the page thumbnails and document outline.
const SIDEBAR_WIDTH: f32 = 210.0;
const SIDEBAR_HEADER_H: f32 = 40.0;
const THUMBNAIL_WIDTH: f32 = 150.0;
const THUMBNAIL_GAP: f32 = 10.0;
const THUMBNAIL_RASTER_WIDTH: u32 = 150;

/// Cài đặt đang hiển thị: từ settings.json, hoặc mặc định khi file không đọc được.
#[derive(Clone, Default)]
struct Prefs {
    theme: SettingTheme,
    language: SettingLanguage,
    save_dir: Option<String>,
}

pub struct Viewer {
    handle: RenderHandle,
    supervisor: Option<Arc<Mutex<Supervisor>>>,
    search: Entity<TextInput>,
    zoom_input: Entity<TextInput>,
    /// Giữ đăng ký sự kiện của ô tìm và ô thư mục: bỏ thì không còn nhận sự kiện.
    _subscriptions: Vec<Subscription>,
    appearance_observer_installed: bool,
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
    /// Tệp người dùng đã mở; khác với `doc_path` sau khi viewer chuyển sang revision.
    source_path: Option<PathBuf>,
    source_fingerprint: Option<Fingerprint>,
    source_password: Option<zeroize::Zeroizing<String>>,
    session_id: Option<String>,
    operation_rx: Option<Receiver<OperationResult>>,
    switch_rx: Option<Receiver<Result<PathBuf, String>>>,
    operation_pending: bool,
    document_generation: u64,
    can_undo: bool,
    can_redo: bool,
    dirty: bool,
    edit_blocked: bool,
    tab_closing: bool,
    retry_reload_focus: FocusHandle,
    source_warning: Option<Verdict>,
    source_warning_review: FocusHandle,
    source_warning_reopen: FocusHandle,
    rotate_focus: FocusHandle,
    undo_focus: FocusHandle,
    redo_focus: FocusHandle,
    save_focus: FocusHandle,
    save_as_focus: FocusHandle,
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
    spread: Option<SpreadLayout>,
    page_sizes: Vec<(f32, f32)>,
    view_rotation: u8,
    page_mode: PageMode,
    slideshow_restore_fullscreen: Option<bool>,
    sidebar_layout: Option<SidebarLayout>,
    /// Vừa chiều rộng khi true (mặc định). Ctrl+=, Ctrl+− tắt chế độ này; Ctrl+0 bật lại.
    fit_width: bool,
    fit_page: bool,
    scroll_y: f32,
    viewport: (f32, f32),
    cache: LruCache<usize, Arc<RenderImage>>,
    pending: HashMap<usize, Receiver<Reply<PageImage>>>,
    bookmarks: Vec<Bookmark>,
    sidebar_outline: bool,
    sidebar_scroll_y: f32,
    sidebar_visible: Vec<usize>,
    thumbnail_cache: HashMap<usize, Arc<RenderImage>>,
    thumbnail_pending: HashMap<usize, Receiver<Reply<PageImage>>>,
    to_drop: Vec<Arc<RenderImage>>,
    message: Option<String>,
    /// Đọc ban đêm: đảo màu trang khi nhận ảnh (night.rs).
    night: bool,
    /// Lớp chữ của tài liệu, xác định từ vài trang mẫu khi mở.
    kind: Option<DocKind>,
}

enum OperationResult {
    Applied {
        generation: u64,
        session_id: String,
        path: PathBuf,
        doc: DocId,
        sizes: Vec<(f32, f32)>,
        changed_pages: Option<serde_json::Value>,
        can_undo: bool,
        can_redo: bool,
        dirty: bool,
    },
    Saved {
        generation: u64,
        session_id: String,
        path: Option<PathBuf>,
        warnings: Vec<String>,
        can_undo: bool,
        can_redo: bool,
        dirty: bool,
    },
    SourceChanged {
        generation: u64,
        verdict: Verdict,
    },
    Failed {
        generation: u64,
        session_id: Option<String>,
        message: String,
        refresh_required: bool,
    },
}

enum EditOperation {
    Rotate,
    Undo,
    Redo,
    Save(Option<String>),
}

fn call_error_has_unknown_outcome(error: &CallError) -> bool {
    matches!(
        error,
        CallError::Timeout | CallError::Closed | CallError::Io(_)
    )
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
    fn retry_revision_reload(&mut self, cx: &mut Context<Self>) {
        if !self.edit_blocked || self.operation_pending {
            return;
        }
        let (Some(supervisor), Some(session_id)) =
            (self.supervisor.clone(), self.session_id.clone())
        else {
            self.message = Some(i18n::t("editor.coreUnavailable"));
            cx.notify();
            return;
        };
        self.operation_pending = true;
        let generation = self.document_generation;
        let handle = self.handle.clone();
        let (tx, rx) = channel();
        self.operation_rx = Some(rx);
        std::thread::spawn(move || {
            let result = (|| {
                let sup = supervisor
                    .lock()
                    .map_err(|_| i18n::t("editor.coreUnavailable"))?;
                let state = sup
                    .request(
                        "session.state",
                        &serde_json::json!({"sessionId":session_id}),
                    )
                    .map_err(call_error_text)?;
                let path = state
                    .get("revisionPath")
                    .and_then(serde_json::Value::as_str)
                    .map(PathBuf::from)
                    .ok_or_else(|| i18n::t("editor.revisionMissing"))?;
                drop(sup);
                let (doc, sizes) = load_revision(&handle, path.clone())?;
                let applied = OperationResult::Applied {
                    generation,
                    session_id: session_id.clone(),
                    path,
                    doc,
                    sizes,
                    changed_pages: Some(serde_json::Value::String("all".into())),
                    can_undo: state
                        .get("canUndo")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                    can_redo: state
                        .get("canRedo")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                    dirty: state
                        .get("dirty")
                        .and_then(serde_json::Value::as_bool)
                        .unwrap_or(false),
                };
                if let Err(std::sync::mpsc::SendError(OperationResult::Applied { doc, .. })) =
                    tx.send(applied)
                {
                    close_render_doc_handle(&handle, doc);
                }
                Ok::<(), String>(())
            })();
            if let Err(message) = result {
                let _ = tx.send(OperationResult::Failed {
                    generation,
                    session_id: Some(session_id),
                    message,
                    refresh_required: true,
                });
            }
        });
        cx.notify();
    }

    fn begin_edit(&mut self, operation: EditOperation, cx: &mut Context<Self>) {
        if self.tab_closing {
            self.message = Some(i18n::t("editor.sessionClosing"));
            cx.notify();
            return;
        }
        if self.operation_pending {
            return;
        }
        if self.switch_rx.is_some() {
            self.message = Some(i18n::t("editor.sessionClosing"));
            cx.notify();
            return;
        }
        if self.edit_blocked {
            self.message = Some(i18n::t("editor.reloadRequired"));
            cx.notify();
            return;
        }
        match &operation {
            EditOperation::Undo if self.session_id.is_none() || !self.can_undo => {
                self.message = Some(i18n::t("editor.nothingToUndo"));
                cx.notify();
                return;
            }
            EditOperation::Redo if self.session_id.is_none() || !self.can_redo => {
                self.message = Some(i18n::t("editor.nothingToRedo"));
                cx.notify();
                return;
            }
            EditOperation::Save(_) if self.session_id.is_none() => {
                self.message = Some(i18n::t("editor.nothingToSave"));
                cx.notify();
                return;
            }
            _ => {}
        }
        let (Some(supervisor), Some(source), Some(guard)) = (
            self.supervisor.clone(),
            self.source_path.clone(),
            self.source_fingerprint.clone(),
        ) else {
            self.message = Some(i18n::t("editor.coreUnavailable"));
            cx.notify();
            return;
        };
        self.operation_pending = true;
        let generation = self.document_generation;
        let render_handle = self.handle.clone();
        let existing_session = self.session_id.clone();
        let password = self.source_password.clone();
        let (tx, rx) = channel();
        self.operation_rx = Some(rx);
        std::thread::spawn(move || {
            let mut active_session_id = existing_session.clone();
            let mut refresh_required = false;
            let result = (|| {
                let sup = supervisor
                    .lock()
                    .map_err(|_| "Không khóa được lõi".to_string())?;
                let session_id = if let Some(id) = existing_session {
                    id
                } else {
                    match crate::session::open(&sup, &source, &guard, password.as_ref()) {
                        Ok(opened) => opened.session_id,
                        Err(crate::session::OpenError::SourceChanged(v)) => {
                            let _ = tx.send(OperationResult::SourceChanged {
                                generation,
                                verdict: v,
                            });
                            return Ok(());
                        }
                        Err(crate::session::OpenError::Core { kind }) => {
                            return Err(i18n::t(&chef_rpc::errors::message_key(&kind)));
                        }
                        Err(crate::session::OpenError::Unavailable(_)) => {
                            return Err(i18n::t("editor.coreUnavailable"));
                        }
                    }
                };
                active_session_id = Some(session_id.clone());
                let is_save = matches!(&operation, EditOperation::Save(_));
                let reply = match operation {
                    EditOperation::Rotate => {
                        let id = match chef_rpc::ops::start(
                            &sup,
                            "page.rotate",
                            Some(&session_id),
                            &serde_json::json!({"pages":[0],"angle":90}),
                        ) {
                            Ok(id) => id,
                            Err(error) => {
                                refresh_required = reload::requires_revision_reconciliation(
                                    reload::MutationKind::RevisionEdit,
                                    if call_error_has_unknown_outcome(&error) {
                                        reload::MutationOutcome::Unknown
                                    } else {
                                        reload::MutationOutcome::ExplicitFailure
                                    },
                                );
                                return Err(call_error_text(error));
                            }
                        };
                        match chef_rpc::ops::wait_job(&sup, &id, Duration::from_secs(120)) {
                            chef_rpc::ops::JobEnd::Finished(v) => v,
                            chef_rpc::ops::JobEnd::Failed(error) => {
                                return Err(call_error_text(CallError::Rpc(error)));
                            }
                            chef_rpc::ops::JobEnd::Cancelled => {
                                return Err(i18n::t("editor.operationFailed"));
                            }
                            chef_rpc::ops::JobEnd::TimedOut | chef_rpc::ops::JobEnd::Stopped => {
                                refresh_required = reload::requires_revision_reconciliation(
                                    reload::MutationKind::RevisionEdit,
                                    reload::MutationOutcome::Unknown,
                                );
                                return Err(i18n::t("editor.operationFailed"));
                            }
                        }
                    }
                    EditOperation::Undo => {
                        crate::undo::undo(&sup, &session_id).map_err(|error| {
                            refresh_required = reload::requires_revision_reconciliation(
                                reload::MutationKind::RevisionEdit,
                                if call_error_has_unknown_outcome(&error) {
                                    reload::MutationOutcome::Unknown
                                } else {
                                    reload::MutationOutcome::ExplicitFailure
                                },
                            );
                            call_error_text(error)
                        })?
                    }
                    EditOperation::Redo => {
                        crate::undo::redo(&sup, &session_id).map_err(|error| {
                            refresh_required = reload::requires_revision_reconciliation(
                                reload::MutationKind::RevisionEdit,
                                if call_error_has_unknown_outcome(&error) {
                                    reload::MutationOutcome::Unknown
                                } else {
                                    reload::MutationOutcome::ExplicitFailure
                                },
                            );
                            call_error_text(error)
                        })?
                    }
                    EditOperation::Save(path) => {
                        crate::save::save(&sup, &session_id, path.as_deref())
                            .map_err(call_error_text)?
                    }
                };
                if is_save {
                    let path = reply
                        .get("sourcePath")
                        .and_then(serde_json::Value::as_str)
                        .map(PathBuf::from);
                    let warnings = reply
                        .get("warnings")
                        .and_then(serde_json::Value::as_array)
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(serde_json::Value::as_str)
                                .map(str::to_owned)
                                .collect()
                        })
                        .unwrap_or_default();
                    let _ = tx.send(OperationResult::Saved {
                        generation,
                        session_id,
                        path,
                        warnings,
                        can_undo: reply
                            .get("canUndo")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false),
                        can_redo: reply
                            .get("canRedo")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false),
                        dirty: reply
                            .get("dirty")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false),
                    });
                    return Ok(());
                }
                if !is_save {
                    refresh_required = reload::requires_revision_reconciliation(
                        reload::MutationKind::RevisionEdit,
                        reload::MutationOutcome::Committed,
                    );
                }
                let state = reply.get("state").cloned().unwrap_or_else(|| reply.clone());
                let revision_path = state
                    .get("revisionPath")
                    .and_then(serde_json::Value::as_str)
                    .map(PathBuf::from)
                    .ok_or_else(|| i18n::t("editor.revisionMissing"))?;
                drop(sup);
                let (doc, sizes) = load_revision(&render_handle, revision_path.clone())?;
                let changed = reply.get("changedPages").cloned();
                let can_undo = state
                    .get("canUndo")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                let can_redo = state
                    .get("canRedo")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                let dirty = state
                    .get("dirty")
                    .and_then(serde_json::Value::as_bool)
                    .unwrap_or(false);
                let applied = OperationResult::Applied {
                    generation,
                    session_id,
                    path: revision_path,
                    doc,
                    sizes,
                    changed_pages: changed,
                    can_undo,
                    can_redo,
                    dirty,
                };
                if let Err(std::sync::mpsc::SendError(OperationResult::Applied { doc, .. })) =
                    tx.send(applied)
                {
                    close_render_doc_handle(&render_handle, doc);
                }
                Ok(())
            })();
            if let Err(message) = result {
                let _ = tx.send(OperationResult::Failed {
                    generation,
                    session_id: active_session_id,
                    message,
                    refresh_required,
                });
            }
        });
        cx.notify();
    }

    fn poll_operation(&mut self) -> bool {
        let Some(rx) = self.operation_rx.as_ref() else {
            return false;
        };
        let result = match rx.try_recv() {
            Ok(result) => result,
            Err(std::sync::mpsc::TryRecvError::Empty) => return false,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                self.operation_rx = None;
                self.operation_pending = false;
                self.edit_blocked = true;
                self.dirty = true;
                if self.session_id.is_some() {
                    // The worker may have been disconnected after the core committed its request.
                    // Require a state reload before allowing another edit.
                    self.message = Some(i18n::t("editor.reloadRequired"));
                } else {
                    self.message = Some(i18n::t("editor.operationDisconnected"));
                }
                return true;
            }
        };
        self.operation_rx = None;
        self.operation_pending = false;
        match result {
            OperationResult::Applied {
                generation,
                session_id,
                path,
                doc,
                sizes,
                changed_pages,
                can_undo,
                can_redo,
                dirty,
            } => {
                if generation != self.document_generation {
                    self.close_render_doc(doc);
                    if let Some(supervisor) = self.supervisor.clone() {
                        close_session_async(supervisor, session_id);
                    }
                    return true;
                }
                self.session_id = Some(session_id);
                self.can_undo = can_undo;
                self.can_redo = can_redo;
                self.dirty = dirty;
                let anchor = self.spread.as_ref().and_then(|spread| {
                    reload::capture_spread(spread, self.scroll_y, self.content_height())
                });
                {
                    let changed = reload::changed_pages(changed_pages.as_ref(), sizes.len());
                    let cached_before: std::collections::BTreeMap<usize, usize> = self
                        .cache
                        .entries()
                        .map(|(page, image)| (*page, image.id.0))
                        .collect();
                    let mut removed_images = std::collections::BTreeMap::new();
                    for &page in &changed {
                        if let Some(image) = self.cache.remove(&page) {
                            removed_images.insert(page, image.id.0);
                            self.to_drop.push(image);
                        }
                        self.texts.remove(&page);
                    }
                    crate::debug::set_cache_invalidation(serde_json::json!({
                        "before": cached_before,
                        "changedPages": changed,
                        "removed": removed_images,
                    }));
                    self.thumbnail_pending
                        .retain(|page, _| !changed.contains(page));
                    for page in &changed {
                        if let Some(image) = self.thumbnail_cache.remove(page) {
                            self.to_drop.push(image);
                        }
                    }
                    self.bookmarks = self
                        .call(|id, reply| Job::Bookmarks { id, doc, reply })
                        .unwrap_or_default();
                    self.page_sizes = sizes.clone();
                    let display_sizes = oriented_sizes(&sizes, self.view_rotation);
                    self.sidebar_layout = Some(SidebarLayout::new(
                        &display_sizes,
                        THUMBNAIL_WIDTH,
                        THUMBNAIL_GAP,
                    ));
                    if self.selection.is_some_and(|selection| {
                        selection.anchor.0 >= sizes.len() || selection.focus.0 >= sizes.len()
                    }) {
                        self.selection = None;
                    }
                    self.pending.clear();
                    self.text_pending.clear();
                    let old = self.doc.replace(doc);
                    if let Some(old) = old {
                        self.close_render_doc(old);
                    }
                    let (spread, scroll) = reload::restore_spread(
                        display_sizes.clone(),
                        self.page_mode,
                        PAGE_GAP,
                        PAGE_GAP,
                        anchor,
                        self.content_height(),
                    );
                    self.layout = Some(Layout::new(display_sizes, PAGE_GAP, spread.zoom()));
                    self.spread = Some(spread);
                    self.scroll_y = scroll;
                    // A revision must keep the user's explicit zoom. If either fit mode remained
                    // active, the next frame could silently choose a different zoom using the new
                    // page dimensions.
                    self.fit_width = false;
                    self.fit_page = false;
                    self.doc_path = Some(path);
                    self.edit_blocked = false;
                    let query = self.find.query().to_string();
                    if !query.is_empty() {
                        self.find.set_query(&query);
                    }
                    self.message = None;
                }
            }
            OperationResult::Saved {
                generation,
                session_id,
                path,
                warnings,
                can_undo,
                can_redo,
                dirty,
            } => {
                if generation != self.document_generation {
                    if let Some(supervisor) = self.supervisor.clone() {
                        close_session_async(supervisor, session_id);
                    }
                    return true;
                }
                self.session_id = Some(session_id);
                self.can_undo = can_undo;
                self.can_redo = can_redo;
                self.dirty = dirty;
                if let Some(path) = path {
                    self.source_path = Some(path.clone());
                    self.source_fingerprint = source_guard::fingerprint(&path).ok();
                }
                self.message = Some(
                    if warnings.iter().any(|warning| {
                        warning.contains("original owner password could not be preserved")
                    }) {
                        i18n::t("editor.savedOwnerPasswordWarning")
                    } else if warnings
                        .iter()
                        .any(|warning| warning.contains("unknown owner password"))
                    {
                        i18n::t("editor.savedRestrictionsWarning")
                    } else if warnings.is_empty() {
                        i18n::t("editor.saved")
                    } else {
                        i18n::t("editor.savedWithWarning")
                    },
                );
            }
            OperationResult::SourceChanged {
                generation,
                verdict,
            } => {
                if generation != self.document_generation {
                    return true;
                }
                self.source_warning = Some(verdict);
            }
            OperationResult::Failed {
                generation,
                session_id,
                message,
                refresh_required,
            } => {
                if generation != self.document_generation {
                    if let (Some(supervisor), Some(session_id)) =
                        (self.supervisor.clone(), session_id)
                    {
                        close_session_async(supervisor, session_id);
                    }
                    return true;
                }
                if let Some(id) = session_id {
                    self.session_id = Some(id);
                }
                if refresh_required {
                    self.edit_blocked = true;
                    self.dirty = true;
                    self.message = Some(i18n::t("editor.reloadRequired"));
                    return true;
                }
                self.message = Some(message);
            }
        }
        true
    }

    /// Mở `path` (nếu có). Trả về viewer; lỗi mở hiện ở `message` thay vì làm sập app.
    pub fn open(
        handle: RenderHandle,
        path: Option<PathBuf>,
        supervisor: Option<Arc<Mutex<Supervisor>>>,
        cx: &mut Context<Self>,
    ) -> Self {
        let search = cx.new(|cx| TextInput::new(cx, "Tìm trong tài liệu"));
        let zoom_input = cx.new(|cx| TextInput::new(cx, i18n::t("zoom.percentPlaceholder")));
        let zoom_subscription = cx.subscribe(
            &zoom_input,
            |this: &mut Viewer, input, event: &TextInputEvent, cx| {
                if matches!(event, TextInputEvent::Submit) {
                    let value = input.read(cx).text().to_string();
                    this.apply_zoom_percent(&value, cx);
                }
            },
        );
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
        password_input.update(cx, |input, cx| input.set_secure(true, cx));
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
        let source_warning_review = cx.focus_handle();
        let source_warning_reopen = cx.focus_handle();
        let rotate_focus = cx.focus_handle();
        let undo_focus = cx.focus_handle();
        let redo_focus = cx.focus_handle();
        let save_focus = cx.focus_handle();
        let save_as_focus = cx.focus_handle();
        let settings_handles = settings_dialog::Handles {
            theme: (0..3).map(|_| cx.focus_handle()).collect(),
            close: cx.focus_handle(),
            return_to: focus.clone(),
        };
        let mut viewer = Viewer {
            handle,
            supervisor,
            search,
            zoom_input,
            _subscriptions: vec![
                subscription,
                zoom_subscription,
                dir_subscription,
                password_subscription,
            ],
            appearance_observer_installed: false,
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
            source_path: None,
            source_fingerprint: None,
            source_password: None,
            session_id: None,
            operation_rx: None,
            switch_rx: None,
            operation_pending: false,
            document_generation: 0,
            can_undo: false,
            can_redo: false,
            dirty: false,
            edit_blocked: false,
            tab_closing: false,
            retry_reload_focus: cx.focus_handle(),
            source_warning: None,
            source_warning_review,
            source_warning_reopen,
            rotate_focus,
            undo_focus,
            redo_focus,
            save_focus,
            save_as_focus,
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
            spread: None,
            page_sizes: Vec::new(),
            view_rotation: 0,
            page_mode: PageMode::Continuous,
            slideshow_restore_fullscreen: None,
            sidebar_layout: None,
            fit_width: true,
            fit_page: false,
            scroll_y: 0.0,
            viewport: (0.0, 0.0),
            cache: LruCache::new(CACHE_BUDGET),
            pending: HashMap::new(),
            bookmarks: Vec::new(),
            sidebar_outline: false,
            sidebar_scroll_y: 0.0,
            sidebar_visible: Vec::new(),
            thumbnail_cache: HashMap::new(),
            thumbnail_pending: HashMap::new(),
            to_drop: Vec::new(),
            message: None,
            night: false,
            kind: None,
        };
        match path {
            Some(p) => viewer.open_path(p, cx),
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
    fn open_path(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        if self.operation_pending {
            self.message = Some(i18n::t("editor.waitCurrentOperation"));
            return;
        }
        if self.switch_rx.is_some() {
            self.message = Some(i18n::t("editor.sessionClosing"));
            return;
        }
        if let Some(session_id) = self.session_id.clone() {
            if self.dirty {
                self.message = Some(i18n::t("editor.saveBeforeSwitch"));
                cx.notify();
                return;
            }
            let Some(supervisor) = self.supervisor.clone() else {
                self.message = Some(i18n::t("editor.coreUnavailable"));
                cx.notify();
                return;
            };
            let (tx, rx) = channel();
            self.switch_rx = Some(rx);
            self.message = Some(i18n::t("editor.sessionClosing"));
            std::thread::spawn(move || {
                let result = supervisor
                    .lock()
                    .map_err(|_| i18n::t("editor.coreUnavailable"))
                    .and_then(|sup| {
                        sup.request(
                            "session.close",
                            &serde_json::json!({"sessionId":session_id}),
                        )
                        .map_err(call_error_text)?;
                        sup.session_closed(&session_id);
                        Ok(path)
                    });
                let _ = tx.send(result);
            });
            cx.notify();
            return;
        }
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

    fn poll_session_switch(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(rx) = self.switch_rx.as_ref() else {
            return false;
        };
        let result = match rx.try_recv() {
            Ok(result) => result,
            Err(std::sync::mpsc::TryRecvError::Empty) => return false,
            Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                Err(i18n::t("editor.operationDisconnected"))
            }
        };
        self.switch_rx = None;
        match result {
            Ok(path) => {
                self.session_id = None;
                self.can_undo = false;
                self.can_redo = false;
                self.dirty = false;
                self.open_path(path, cx);
            }
            Err(message) => self.message = Some(message),
        }
        true
    }

    /// Enter trong ô mật khẩu: thử mở bằng mật khẩu đã nhập, rồi xóa mật khẩu khỏi bộ nhớ.
    fn submit_password(&mut self, cx: &mut Context<Self>) {
        let Some(path) = self.password_path.clone() else {
            return;
        };
        let typed = zeroize::Zeroizing::new(self.password_input.read(cx).text().to_string());
        self.password_input
            .update(cx, |input, cx| input.clear_sensitive(cx));
        let result = self.load(path, Some(typed));
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
            .update(cx, |input, cx| input.clear_sensitive(cx));
        window.focus(&self.focus, cx);
        cx.notify();
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

    fn load(
        &mut self,
        path: PathBuf,
        password: Option<zeroize::Zeroizing<String>>,
    ) -> Result<(), String> {
        let fingerprint = source_guard::fingerprint(&path)
            .map_err(|e| format!("Không thể ghi nhận file gốc: {e}"))?;
        let protected_password = password.as_ref().cloned();
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
        let bookmarks = self.call(|id, reply| Job::Bookmarks { id, doc, reply })?;
        self.kind = self.sample_kind(doc, count);
        self.clear_document_state();
        if let Some(previous) = self.doc {
            self.close_render_doc(previous);
        }
        self.doc = Some(doc);
        self.doc_path = Some(path.clone());
        self.source_path = Some(path);
        self.source_fingerprint = Some(fingerprint);
        self.source_password = protected_password;
        self.session_id = None;
        self.operation_rx = None;
        self.operation_pending = false;
        self.document_generation = self.document_generation.wrapping_add(1);
        self.can_undo = false;
        self.can_redo = false;
        self.dirty = false;
        self.source_warning = None;
        self.page_sizes = sizes.clone();
        let display_sizes = oriented_sizes(&sizes, self.view_rotation);
        self.sidebar_layout = Some(SidebarLayout::new(
            &display_sizes,
            THUMBNAIL_WIDTH,
            THUMBNAIL_GAP,
        ));
        self.spread = Some(SpreadLayout::new(
            display_sizes.clone(),
            self.page_mode,
            PAGE_GAP,
            PAGE_GAP,
            1.0,
        ));
        self.layout = Some(Layout::new(display_sizes, PAGE_GAP, 1.0));
        self.bookmarks = bookmarks;
        self.sidebar_scroll_y = 0.0;
        self.sidebar_visible.clear();
        Ok(())
    }

    /// Drop per-document UI state. The GPU images are released on the next render pass.
    fn clear_document_state(&mut self) {
        for key in self.cache.keys() {
            if let Some(image) = self.cache.remove(&key) {
                self.to_drop.push(image);
            }
        }
        self.pending.clear();
        self.thumbnail_pending.clear();
        for (_, image) in self.thumbnail_cache.drain() {
            self.to_drop.push(image);
        }
        self.text_pending.clear();
        self.texts.clear();
        self.find.clear();
        self.selection = None;
        self.dragging = false;
        self.scroll_y = 0.0;
        self.fit_width = true;
        self.fit_page = false;
        self.bookmarks.clear();
        self.sidebar_layout = None;
        self.sidebar_scroll_y = 0.0;
        self.sidebar_visible.clear();
    }

    /// Queue a close behind all currently queued pdfium work, so document handles do not leak.
    fn close_render_doc(&self, doc: DocId) {
        let (tx, _rx) = channel();
        let id = self.handle.next_id();
        let _ = self.handle.send(Job::Close { id, doc, reply: tx });
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
                        let thumbnails = viewer.poll_thumbnails();
                        let found = viewer.poll_find();
                        let texts = viewer.poll_text();
                        let operation = viewer.poll_operation();
                        let switched = viewer.poll_session_switch(cx);
                        let scanning = viewer.scanning();
                        if images
                            || thumbnails
                            || found
                            || texts
                            || scanning
                            || operation
                            || switched
                        {
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
                    match to_render_image(page, self.view_rotation) {
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

    /// Nạp thumbnail raster hoàn tất. Kết quả của trang đã cuộn khỏi vùng nhìn bị bỏ ngay.
    fn poll_thumbnails(&mut self) -> bool {
        let ready: Vec<(usize, Reply<PageImage>)> = self
            .thumbnail_pending
            .iter()
            .filter_map(|(index, rx)| rx.try_recv().ok().map(|reply| (*index, reply)))
            .collect();
        let any = !ready.is_empty();
        for (index, reply) in ready {
            self.thumbnail_pending.remove(&index);
            if !self.sidebar_visible.contains(&index) {
                continue;
            }
            match reply.result {
                Ok(mut page) => {
                    if self.night {
                        crate::night::invert_bgra(&mut page.bgra);
                    }
                    match to_render_image(page, self.view_rotation) {
                        Ok((image, _bytes)) => {
                            if let Some(previous) = self.thumbnail_cache.insert(index, image) {
                                self.to_drop.push(previous);
                            }
                        }
                        Err(error) => self.message = Some(error),
                    }
                }
                Err(error) => self.message = Some(error),
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
        let keep = self
            .spread
            .as_ref()
            .map(|s| s.buffered_pages(self.scroll_y, self.content_height(), BUFFER_PAGES))
            .unwrap_or_else(|| {
                layout
                    .full_scale_set(self.scroll_y, self.content_height(), BUFFER_PAGES)
                    .collect()
            });
        let selected_pages = self
            .selection
            .map(|selection| [selection.anchor.0, selection.focus.0]);
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
        if let Some(selection) = self.selection {
            for endpoint in [selection.anchor, selection.focus] {
                if self
                    .texts
                    .get(&endpoint.0)
                    .is_some_and(|text| endpoint.1 >= text.chars.len())
                {
                    self.selection = None;
                    break;
                }
            }
        }
        self.texts.retain(|i, _| {
            keep.contains(i) || selected_pages.is_some_and(|pages| pages.contains(i))
        });
        let mut wanted: Vec<usize> = keep
            .iter()
            .copied()
            .filter(|i| !self.texts.contains_key(i) && !self.text_pending.contains_key(i))
            .collect();
        if let Some(pages) = selected_pages {
            for page in pages {
                if !keep.contains(&page)
                    && !self.texts.contains_key(&page)
                    && !self.text_pending.contains_key(&page)
                {
                    wanted.push(page);
                }
            }
        }
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
        let (x, y) = (pos.x.as_f32() - SIDEBAR_WIDTH, pos.y.as_f32() - TOOLBAR_H);
        let zoom = layout.zoom();
        let pages = self
            .spread
            .as_ref()
            .map(|s| s.visible_pages(self.scroll_y, self.content_height()))
            .unwrap_or_else(|| {
                layout
                    .visible(self.scroll_y, self.content_height())
                    .collect()
            });
        for i in pages {
            let (w, h) = layout.page_px(i);
            let (x0, y0) = self
                .spread
                .as_ref()
                .and_then(|s| s.page_rect(i, (vw - SIDEBAR_WIDTH).max(1.0)))
                .map(|r| (r.x, r.y - self.scroll_y))
                .unwrap_or_else(|| {
                    (
                        ((vw - w) / 2.0).max(0.0),
                        layout.page_top(i) - self.scroll_y,
                    )
                });
            if y < y0 || y > y0 + h {
                continue;
            }
            let text = self.texts.get(&i)?;
            let (page_w, page_h) = self.page_sizes.get(i).copied().unwrap_or((w, h));
            let (display_x, display_y) = ((x - x0) / zoom, (y - y0) / zoom);
            let (pdf_x, pdf_y) =
                display_to_pdf(display_x, display_y, page_w, page_h, self.view_rotation);
            let idx = char_at(&text.chars, pdf_x, pdf_y)?;
            return Some((i, idx));
        }
        None
    }

    fn rect_to_view(
        &self,
        page: usize,
        left: f32,
        top: f32,
        right: f32,
        bottom: f32,
    ) -> (f32, f32, f32, f32) {
        let (width, height) = self.page_sizes.get(page).copied().unwrap_or((0.0, 0.0));
        pdf_rect_to_view(left, top, right, bottom, width, height, self.view_rotation)
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
        let first = self
            .spread
            .as_ref()
            .and_then(|s| {
                fit_anchor_page(
                    s,
                    self.scroll_y,
                    self.content_height(),
                    (self.viewport.0 - SIDEBAR_WIDTH).max(1.0),
                )
            })
            .or_else(|| layout.visible(self.scroll_y, self.content_height()).next());
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
            self.scroll_y = self.spread.as_ref().map_or_else(
                || layout.clamp_scroll(self.scroll_y - dy, vh),
                |s| s.clamp_scroll(self.scroll_y - dy, vh),
            );
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

    /// Bật hoặc tắt đọc ban đêm. Bỏ cache bitmap trang để vẽ lại theo chế độ mới.
    fn toggle_night(&mut self) {
        self.night = !self.night;
        self.to_drop
            .extend(crate::night::evict_cached_pages(&mut self.cache));
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
            self.fit_width = false;
            self.fit_page = false;
            return;
        }
        let anchor = self.spread.as_ref().and_then(|spread| {
            let center = self.scroll_y + vh / 2.0;
            let width = (self.viewport.0 - SIDEBAR_WIDTH).max(1.0);
            let page = fit_anchor_page(spread, self.scroll_y, vh, width)?;
            let rect = spread.page_rect(page, width)?;
            Some((
                page,
                ((center - rect.y) / rect.height.max(1.0)).clamp(0.0, 1.0),
            ))
        });
        layout.set_zoom(zoom);
        if let Some(spread) = self.spread.as_mut() {
            spread.set_zoom(zoom);
        }
        self.scroll_y = if self.page_mode == PageMode::Slideshow {
            anchor
                .and_then(|(p, _)| self.spread.as_ref().and_then(|s| s.page_scroll(p)))
                .unwrap_or(self.scroll_y)
        } else if let (Some(spread), Some((page, fraction))) = (self.spread.as_ref(), anchor) {
            let center = spread
                .page_rect(page, (self.viewport.0 - SIDEBAR_WIDTH).max(1.0))
                .map(|r| r.y + fraction * r.height)
                .unwrap_or(self.scroll_y + vh / 2.0);
            spread.clamp_scroll(center - vh / 2.0, vh)
        } else {
            layout.clamp_scroll((self.scroll_y + vh / 2.0) / old * zoom - vh / 2.0, vh)
        };
        self.fit_width = false;
        self.fit_page = false;
    }

    fn zoom_by(&mut self, factor: f32) {
        if let Some(zoom) = self.layout.as_ref().map(|l| l.zoom()) {
            self.set_zoom(zoom * factor);
        }
    }

    /// Ctrl+0: trở về vừa chiều rộng.
    fn reset_zoom(&mut self) {
        self.fit_width = self.page_mode != PageMode::Slideshow;
        self.fit_page = false;
    }

    fn fit_to_page(&mut self) {
        let page = self
            .spread
            .as_ref()
            .and_then(|s| {
                s.visible_pages(self.scroll_y, self.content_height())
                    .first()
                    .copied()
            })
            .unwrap_or(0);
        let (vw, _) = self.viewport;
        let zoom = self.fit_group_zoom(page, (vw - SIDEBAR_WIDTH).max(1.0), self.content_height());
        self.fit_width = false;
        self.fit_page = true;
        if let Some(top) = self.spread.as_ref().and_then(|s| s.page_scroll(page)) {
            self.scroll_y = top;
        }
        self.set_zoom(zoom);
        if let Some(top) = self.spread.as_ref().and_then(|s| s.page_scroll(page)) {
            self.scroll_y = top;
        }
        self.fit_page = true;
    }

    fn fit_group_zoom(&self, page: usize, viewport_w: f32, viewport_h: f32) -> f32 {
        if self.page_sizes.is_empty() {
            return 1.0;
        }
        let count = self.page_sizes.len();
        let start = match self.page_mode {
            PageMode::Continuous | PageMode::Slideshow => page,
            PageMode::TwoPage => (page / 2) * 2,
            PageMode::Book if page == 0 => 0,
            PageMode::Book => 1 + ((page - 1) / 2) * 2,
        }
        .min(count - 1);
        let end = match self.page_mode {
            PageMode::Continuous | PageMode::Slideshow => start + 1,
            PageMode::TwoPage | PageMode::Book
                if start == 0 && self.page_mode == PageMode::Book =>
            {
                1
            }
            PageMode::TwoPage | PageMode::Book => (start + 2).min(count),
        }
        .min(count);
        let mut width = 0.0_f32;
        let mut height = 0.0_f32;
        for &(raw_w, raw_h) in &self.page_sizes[start..end] {
            let (w, h) = if self.view_rotation % 2 == 1 {
                (raw_h, raw_w)
            } else {
                (raw_w, raw_h)
            };
            width += w;
            height = height.max(h);
        }
        let gap = PAGE_GAP * ((end - start).saturating_sub(1) as f32);
        if width <= 0.0 || height <= 0.0 {
            1.0
        } else {
            ((viewport_w - 2.0 * MARGIN - gap).max(1.0) / width)
                .min((viewport_h - 2.0 * MARGIN).max(1.0) / height)
                .clamp(ZOOM_MIN, ZOOM_MAX)
        }
    }

    fn apply_zoom_percent(&mut self, value: &str, cx: &mut Context<Self>) {
        let value = value.trim().trim_end_matches('%').trim();
        match value.parse::<f32>() {
            Ok(percent) if percent.is_finite() && percent > 0.0 => {
                self.set_zoom(percent / 100.0);
                self.message = None;
            }
            _ => self.message = Some(i18n::t("zoom.invalidPercent")),
        }
        cx.notify();
    }

    fn rotate_view(&mut self, delta: i8, cx: &mut Context<Self>) {
        let Some(layout) = self.layout.as_ref() else {
            return;
        };
        let old_zoom = layout.zoom();
        let vh = self.content_height();
        let anchor = self
            .spread
            .as_ref()
            .and_then(|s| s.visible_pages(self.scroll_y, vh).first().copied())
            .map(|page| {
                let top = self
                    .spread
                    .as_ref()
                    .and_then(|s| s.row_top_for_page(page))
                    .unwrap_or(0.0);
                let h = layout.page_px(page).1.max(1.0);
                (page, ((self.scroll_y - top) / h).clamp(0.0, 1.0))
            });
        self.view_rotation = (self.view_rotation as i8 + delta).rem_euclid(4) as u8;
        let sizes = oriented_sizes(&self.page_sizes, self.view_rotation);
        self.layout = Some(Layout::new(sizes.clone(), PAGE_GAP, old_zoom));
        self.spread = Some(SpreadLayout::new(
            sizes.clone(),
            self.page_mode,
            PAGE_GAP,
            PAGE_GAP,
            old_zoom,
        ));
        self.sidebar_layout = Some(SidebarLayout::new(&sizes, THUMBNAIL_WIDTH, THUMBNAIL_GAP));
        self.pending.clear();
        self.thumbnail_pending.clear();
        for (_, image) in self.thumbnail_cache.drain() {
            self.to_drop.push(image);
        }
        for index in self.cache.keys() {
            if let Some(image) = self.cache.remove(&index) {
                self.to_drop.push(image);
            }
        }
        self.scroll_y = anchor
            .and_then(|(page, fraction)| {
                self.spread.as_ref().and_then(|s| {
                    s.row_top_for_page(page)
                        .map(|top| top + fraction * self.layout.as_ref().unwrap().page_px(page).1)
                })
            })
            .unwrap_or(0.0);
        cx.notify();
    }

    /// PageDown và PageUp: đưa đầu trang kế (hoặc trước) lên đầu vùng nhìn.
    fn go_page(&mut self, delta: isize) {
        let vh = self.content_height();
        let Some(layout) = self.layout.as_ref() else {
            return;
        };
        let current = self
            .spread
            .as_ref()
            .and_then(|s| s.visible_pages(self.scroll_y, vh).first().copied())
            .unwrap_or_else(|| *layout.visible(self.scroll_y, vh).start());
        let last = layout.page_count().saturating_sub(1);
        let target = (current as isize + delta).clamp(0, last as isize) as usize;
        let top = self
            .spread
            .as_ref()
            .and_then(|s| s.page_scroll(target))
            .unwrap_or_else(|| layout.page_top(target));
        self.scroll_y = if self.page_mode == PageMode::Slideshow {
            top
        } else {
            self.spread
                .as_ref()
                .map_or_else(|| layout.clamp_scroll(top, vh), |s| s.clamp_scroll(top, vh))
        };
    }

    fn go_to_page(&mut self, page_index: usize) {
        let vh = self.content_height();
        let Some(layout) = self.layout.as_ref() else {
            return;
        };
        if page_index >= layout.page_count() {
            return;
        }
        let top = self
            .spread
            .as_ref()
            .and_then(|s| s.page_scroll(page_index))
            .unwrap_or_else(|| layout.page_top(page_index));
        self.scroll_y = if self.page_mode == PageMode::Slideshow {
            top
        } else {
            self.spread
                .as_ref()
                .map_or_else(|| layout.clamp_scroll(top, vh), |s| s.clamp_scroll(top, vh))
        };
    }

    fn set_page_mode(&mut self, mode: PageMode, cx: &mut Context<Self>) {
        let viewport_h = self.content_height();
        self.page_mode = mode;
        if let Some(spread) = self.spread.as_mut() {
            spread.set_mode(mode);
            let current = spread
                .visible_pages(self.scroll_y, viewport_h)
                .first()
                .copied()
                .unwrap_or(0);
            let top = spread.page_scroll(current).unwrap_or(0.0);
            self.scroll_y = if mode == PageMode::Slideshow {
                top
            } else {
                spread.clamp_scroll(top, viewport_h)
            };
        }
        self.fit_width = mode != PageMode::Slideshow;
        self.fit_page = false;
        cx.notify();
    }

    fn enter_slideshow(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.slideshow_restore_fullscreen = Some(window.is_fullscreen());
        if !window.is_fullscreen() {
            window.toggle_fullscreen();
        }
        self.set_page_mode(PageMode::Slideshow, cx);
    }
    fn exit_slideshow(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.set_page_mode(PageMode::Continuous, cx);
        if let Some(was_fullscreen) = self.slideshow_restore_fullscreen.take()
            && window.is_fullscreen() != was_fullscreen
        {
            window.toggle_fullscreen();
        }
    }

    /// Ô tìm kiếm trên thanh viewer. Kênh debug đọc nội dung và vùng chọn qua đây.
    pub fn search(&self) -> &Entity<TextInput> {
        &self.search
    }

    /// Tab metadata/lifecycle hooks used by the document host (R2.15).
    pub fn tab_title(&self) -> String {
        self.source_path
            .as_ref()
            .and_then(|path| path.file_name())
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "Untitled".to_string())
    }

    pub fn tab_is_dirty(&self) -> bool {
        self.dirty
    }

    pub fn tab_close_blocked(&self) -> bool {
        self.dirty
            || self.operation_pending
            || self.operation_rx.is_some()
            || self.switch_rx.is_some()
    }

    pub fn set_tab_closing(&mut self, closing: bool) {
        self.tab_closing = closing;
    }

    pub fn tab_cached_pages(&self) -> usize {
        self.cache.len()
    }

    pub fn tab_pending_pages(&self) -> usize {
        self.pending.len()
    }

    /// Flush GPU images when a tab becomes inactive while preserving document and editing state.
    pub fn deactivate_tab(&mut self, window: &mut Window) {
        self.pending.clear();
        self.thumbnail_pending.clear();
        self.sidebar_visible.clear();
        crate::debug::set_sidebar_thumbnail_count(0);
        for (_, image) in self.thumbnail_cache.drain() {
            let _ = window.drop_image(image);
        }
        for key in self.cache.keys() {
            if let Some(image) = self.cache.remove(&key) {
                let _ = window.drop_image(image);
            }
        }
        for image in self.to_drop.drain(..) {
            let _ = window.drop_image(image);
        }
        crate::debug::set_viewer_stats(0, 0);
    }

    pub fn tab_close_target(&self) -> Option<(Arc<Mutex<Supervisor>>, String)> {
        Some((self.supervisor.clone()?, self.session_id.clone()?))
    }

    /// Called by the host only after `session.close` completed successfully.
    pub fn finish_tab_close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.session_id = None;
        self.password_input
            .update(cx, |input, cx| input.clear_sensitive(cx));
        drop(self.source_password.take());
        crate::debug::set_password(false, false, true, false, true);
        if let Some(doc) = self.doc.take() {
            self.close_render_doc(doc);
        }
        self.deactivate_tab(window);
        self.source_path = None;
        self.doc_path = None;
        self.layout = None;
    }

    /// Đưa tiêu điểm vào ô tìm kiếm để gõ được ngay. Gọi ngoài render (sau khi mở cửa sổ).
    pub fn focus_search(&self, window: &mut Window, cx: &mut App) {
        let handle = self.search.focus_handle(cx);
        window.focus(&handle, cx);
    }

    /// Cuộn theo số màn hình (chiều cao vùng nhìn). Dùng khi đo bộ nhớ trong E2E.
    pub fn scroll_screens(&mut self, screens: f32) {
        let step = self.content_height() * screens;
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
        let (_, top, _, _) = self.rect_to_view(page, rect.left, rect.top, rect.right, rect.bottom);
        let page_top = self
            .spread
            .as_ref()
            .and_then(|s| {
                s.page_rect(page, (self.viewport.0 - SIDEBAR_WIDTH).max(1.0))
                    .map(|r| r.y)
            })
            .unwrap_or_else(|| layout.page_top(page));
        let y = page_top + top * layout.zoom();
        self.scroll_y = self.spread.as_ref().map_or_else(
            || layout.clamp_scroll(y - vh / 3.0, vh),
            |s| s.clamp_scroll(y - vh / 3.0, vh),
        );
    }

    /// Chữ trên nút đếm: "k/N", thêm dấu … khi còn đang quét.
    fn counter_label(&self, scanning: bool) -> String {
        let total = self.find.total();
        let current = self.find.current().map_or(0, |k| k + 1);
        let more = if scanning { "…" } else { "" };
        format!("{current}/{total}{more}")
    }
}

/// Đọc revision PDF trên worker thread; lỗi sau khi Open vẫn đóng handle pdfium.
fn load_revision(handle: &RenderHandle, path: PathBuf) -> Result<(DocId, Vec<(f32, f32)>), String> {
    fn call<R>(
        handle: &RenderHandle,
        make: impl FnOnce(u64, Sender<Reply<R>>) -> Job,
    ) -> Result<R, String> {
        let (tx, rx) = channel();
        let id = handle.next_id();
        handle.send(make(id, tx))?;
        let reply = rx
            .recv()
            .map_err(|_| "luồng pdfium không trả lời".to_string())?;
        if reply.id != id {
            return Err(format!("id trả lời {} không khớp {id}", reply.id));
        }
        reply.result
    }
    let doc = call(handle, |id, reply| Job::Open {
        id,
        path,
        password: None,
        reply,
    })?;
    let sizes = (|| {
        let count = call(handle, |id, reply| Job::PageCount { id, doc, reply })?;
        let mut sizes = Vec::with_capacity(count);
        for index in 0..count {
            sizes.push(call(handle, |id, reply| Job::PageSize {
                id,
                doc,
                index,
                reply,
            })?);
        }
        Ok::<_, String>(sizes)
    })();
    match sizes {
        Ok(sizes) => Ok((doc, sizes)),
        Err(error) => {
            close_render_doc_handle(handle, doc);
            Err(error)
        }
    }
}

fn close_render_doc_handle(handle: &RenderHandle, doc: DocId) {
    let (tx, _rx) = channel();
    let id = handle.next_id();
    let _ = handle.send(Job::Close { id, doc, reply: tx });
}

fn call_error_text(error: CallError) -> String {
    match error {
        CallError::Rpc(value) => {
            let kind = chef_rpc::errors::kind_of(&value);
            i18n::t(&chef_rpc::errors::message_key(kind))
        }
        CallError::Timeout | CallError::Closed | CallError::Io(_) => {
            i18n::t("editor.coreUnavailable")
        }
    }
}

fn close_session_async(supervisor: Arc<Mutex<Supervisor>>, session_id: String) {
    std::thread::spawn(move || {
        let Ok(supervisor) = supervisor.lock() else {
            return;
        };
        if supervisor
            .request(
                "session.close",
                &serde_json::json!({"sessionId":session_id}),
            )
            .is_ok()
        {
            supervisor.session_closed(&session_id);
        }
    });
}

/// Đổi ảnh BGRA của pdfium thành RenderImage của gpui (cũng là BGRA). Trả về ảnh và số byte.
fn to_render_image(page: PageImage, rotation: u8) -> Result<(Arc<RenderImage>, usize), String> {
    let bytes = page.bgra.len();
    let mut buffer = RgbaImage::from_raw(page.width, page.height, page.bgra)
        .ok_or_else(|| "kích thước bitmap không khớp".to_string())?;
    buffer = match rotation % 4 {
        1 => image::imageops::rotate90(&buffer),
        2 => image::imageops::rotate180(&buffer),
        3 => image::imageops::rotate270(&buffer),
        _ => buffer,
    };
    Ok((Arc::new(RenderImage::new(vec![Frame::new(buffer)])), bytes))
}

fn oriented_sizes(sizes: &[(f32, f32)], rotation: u8) -> Vec<(f32, f32)> {
    sizes
        .iter()
        .map(|&(w, h)| if rotation % 2 == 1 { (h, w) } else { (w, h) })
        .collect()
}

fn display_to_pdf(x: f32, y: f32, width: f32, height: f32, rotation: u8) -> (f32, f32) {
    match rotation % 4 {
        1 => (y, height - x),
        2 => (width - x, height - y),
        3 => (width - y, x),
        _ => (x, y),
    }
}

fn pdf_rect_to_view(
    left: f32,
    top: f32,
    right: f32,
    bottom: f32,
    width: f32,
    height: f32,
    rotation: u8,
) -> (f32, f32, f32, f32) {
    match rotation % 4 {
        1 => (height - bottom, left, height - top, right),
        2 => (width - right, height - bottom, width - left, height - top),
        3 => (top, width - right, bottom, width - left),
        _ => (left, top, right, bottom),
    }
}

fn fit_anchor_page(
    spread: &chef_viewer::spread::SpreadLayout,
    scroll_y: f32,
    viewport_h: f32,
    viewport_w: f32,
) -> Option<usize> {
    let center = scroll_y + viewport_h / 2.0;
    spread
        .visible_pages(scroll_y, viewport_h)
        .into_iter()
        .filter_map(|page| spread.page_rect(page, viewport_w).map(|rect| (page, rect)))
        .min_by(|(_, a), (_, b)| {
            let distance = |r: &chef_viewer::spread::PageRect| {
                if center < r.y {
                    r.y - center
                } else if center > r.y + r.height {
                    center - r.y - r.height
                } else {
                    0.0
                }
            };
            distance(a).total_cmp(&distance(b))
        })
        .map(|(page, _)| page)
}

impl Render for Viewer {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let _render_timer = crate::debug::render_timer();
        crate::debug::count_render();
        if !self.appearance_observer_installed {
            self._subscriptions
                .push(cx.observe_window_appearance(window, |this, _window, cx| {
                    if this.mode == Mode::System {
                        cx.notify();
                    }
                }));
            self.appearance_observer_installed = true;
        }
        // Đầu khung: xóa danh sách điều khiển của khung trước, để lệnh `state` không đọc bản cũ.
        chef_ui::a11y::begin_frame(window.scale_factor());
        let vp = window.viewport_size();
        self.viewport = (vp.width.as_f32(), vp.height.as_f32());
        for old in self.to_drop.drain(..) {
            let _ = window.drop_image(old);
        }
        let dark = theme::is_dark(self.mode);
        crate::debug::set_theme_dark(dark);
        let palette = theme::palette(dark);
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
        crate::debug::set_password(
            self.password_open,
            self.password_wrong,
            self.password_input.read(cx).text().is_empty(),
            self.source_password.is_some(),
            self.password_input.read(cx).is_secure(),
        );
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
                dark,
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
                    dark,
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
                dark,
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
        let source_warning = self.source_warning.map(|verdict| {
            let (body, title) = match verdict {
                Verdict::Changed => (i18n::t("sourceGuard.changed"), i18n::t("sourceGuard.title")),
                Verdict::Missing => (i18n::t("sourceGuard.missing"), i18n::t("sourceGuard.title")),
                Verdict::Unreadable => (
                    i18n::t("sourceGuard.unreadable"),
                    i18n::t("sourceGuard.title"),
                ),
                Verdict::Same => (String::new(), String::new()),
            };
            (body, title)
        });
        crate::debug::set_source_warning(
            source_warning
                .as_ref()
                .map(|(body, title)| (title.as_str(), body.as_str())),
        );
        let source_banner = source_warning.map(|(body, title)| {
            let review = entity.clone();
            let reopen = entity.clone();
            let path = self.source_path.clone();
            div()
                .w_full()
                .px(px(16.))
                .py(px(10.))
                .flex()
                .items_center()
                .gap(px(8.))
                .bg(rgb(palette.surface))
                .text_color(rgb(palette.text))
                .child(div().flex_1().child(format!("{title}: {body}")))
                .child(
                    Button::new("source-warning-review", self.source_warning_review.clone())
                        .label(i18n::t("sourceGuard.review"))
                        .on_click(move |_, _, cx| {
                            review.update(cx, |this, cx| {
                                this.source_warning = None;
                                cx.notify();
                            })
                        }),
                )
                .child(
                    Button::new("source-warning-reopen", self.source_warning_reopen.clone())
                        .label(i18n::t("sourceGuard.reopen"))
                        .variant(Variant::Primary)
                        .on_click(move |_, _, cx| {
                            reopen.update(cx, |this, cx| {
                                this.source_warning = None;
                                if let Some(path) = path.clone() {
                                    this.open_path(path, cx);
                                }
                                cx.notify();
                            })
                        }),
                )
        });
        let label = if self.find.is_active() {
            self.counter_label(scanning)
        } else {
            String::new()
        };
        let retry_reload = self.edit_blocked.then(|| {
            let entity = entity.clone();
            Button::new("viewer-retry-reload", self.retry_reload_focus.clone())
                .label(i18n::t("editor.reloadRevision"))
                .variant(Variant::Primary)
                .size(ButtonSize::Sm)
                .dark(dark)
                .disabled(self.operation_pending || self.switch_rx.is_some())
                .on_click(move |_, _, cx| {
                    entity.update(cx, |this, cx| this.retry_revision_reload(cx))
                })
        });
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
            .child(
                Button::new("viewer-rotate", self.rotate_focus.clone())
                    .label(i18n::t("editor.rotateFirst"))
                    .size(ButtonSize::Sm)
                    .dark(dark)
                    .disabled(
                        self.operation_pending
                            || self.switch_rx.is_some()
                            || self.edit_blocked
                            || self.doc.is_none(),
                    )
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |this, cx| this.begin_edit(EditOperation::Rotate, cx))
                        }
                    }),
            )
            .child(
                Button::new("viewer-undo", self.undo_focus.clone())
                    .label(i18n::t("editor.undo"))
                    .size(ButtonSize::Sm)
                    .dark(dark)
                    .disabled(
                        self.operation_pending
                            || self.switch_rx.is_some()
                            || self.edit_blocked
                            || !self.can_undo,
                    )
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |this, cx| this.begin_edit(EditOperation::Undo, cx))
                        }
                    }),
            )
            .child(
                Button::new("viewer-redo", self.redo_focus.clone())
                    .label(i18n::t("editor.redo"))
                    .size(ButtonSize::Sm)
                    .dark(dark)
                    .disabled(
                        self.operation_pending
                            || self.switch_rx.is_some()
                            || self.edit_blocked
                            || !self.can_redo,
                    )
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |this, cx| this.begin_edit(EditOperation::Redo, cx))
                        }
                    }),
            )
            .child(
                Button::new("viewer-save", self.save_focus.clone())
                    .label(i18n::t("editor.save"))
                    .size(ButtonSize::Sm)
                    .dark(dark)
                    .disabled(
                        self.operation_pending
                            || self.switch_rx.is_some()
                            || self.edit_blocked
                            || self.session_id.is_none(),
                    )
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |this, cx| {
                                this.begin_edit(EditOperation::Save(None), cx)
                            })
                        }
                    }),
            )
            .child(
                Button::new("viewer-save-as", self.save_as_focus.clone())
                    .label(i18n::t("editor.saveAs"))
                    .size(ButtonSize::Sm)
                    .dark(dark)
                    .disabled(
                        self.operation_pending
                            || self.switch_rx.is_some()
                            || self.edit_blocked
                            || self.session_id.is_none(),
                    )
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |this, cx| {
                                if std::env::var("CHEF_E2E").as_deref() == Ok("1")
                                    && let Some(path) = std::env::var_os("CHEF_E2E_SAVE_AS_PATH")
                                {
                                    this.begin_edit(
                                        EditOperation::Save(Some(
                                            PathBuf::from(path).display().to_string(),
                                        )),
                                        cx,
                                    );
                                    return;
                                }
                                let name = this
                                    .source_path
                                    .as_ref()
                                    .and_then(|p| p.file_name())
                                    .map(|s| s.to_string_lossy().into_owned())
                                    .unwrap_or_else(|| "document.pdf".into());
                                if let Some(path) = crate::dialogs::save_pdf(
                                    this.prefs.save_dir.as_deref().map(std::path::Path::new),
                                    &name,
                                ) {
                                    this.begin_edit(
                                        EditOperation::Save(Some(path.display().to_string())),
                                        cx,
                                    );
                                }
                            })
                        }
                    }),
            )
            .children(retry_reload)
            .child(div().flex_1().child(self.search.clone()))
            .child(
                Button::new("zoom-fit-width", cx.focus_handle())
                    .label(i18n::t("zoom.fitWidth"))
                    .size(ButtonSize::Sm)
                    .dark(dark)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |v, cx| {
                                v.reset_zoom();
                                cx.notify();
                            })
                        }
                    }),
            )
            .child(
                Button::new("zoom-fit-page", cx.focus_handle())
                    .label(i18n::t("zoom.fitPage"))
                    .size(ButtonSize::Sm)
                    .dark(dark)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |v, cx| {
                                v.fit_to_page();
                                cx.notify();
                            })
                        }
                    }),
            )
            .child(div().w(px(64.)).child(self.zoom_input.clone()))
            .child(
                Button::new("zoom-rotate-left", cx.focus_handle())
                    .label(i18n::t("zoom.rotateLeft"))
                    .size(ButtonSize::Sm)
                    .dark(dark)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| entity.update(cx, |v, cx| v.rotate_view(-1, cx))
                    }),
            )
            .child(
                Button::new("zoom-rotate-right", cx.focus_handle())
                    .label(i18n::t("zoom.rotateRight"))
                    .size(ButtonSize::Sm)
                    .dark(dark)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| entity.update(cx, |v, cx| v.rotate_view(1, cx))
                    }),
            )
            .child(
                Button::new("mode-continuous", cx.focus_handle())
                    .label(i18n::t("commands.modeContinuous"))
                    .size(ButtonSize::Sm)
                    .dark(dark)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |v, cx| v.set_page_mode(PageMode::Continuous, cx))
                        }
                    }),
            )
            .child(
                Button::new("mode-two-page", cx.focus_handle())
                    .label(i18n::t("commands.modeTwoPage"))
                    .size(ButtonSize::Sm)
                    .dark(dark)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |v, cx| v.set_page_mode(PageMode::TwoPage, cx))
                        }
                    }),
            )
            .child(
                Button::new("mode-book", cx.focus_handle())
                    .label(i18n::t("commands.modeBook"))
                    .size(ButtonSize::Sm)
                    .dark(dark)
                    .on_click({
                        let entity = entity.clone();
                        move |_, _, cx| {
                            entity.update(cx, |v, cx| v.set_page_mode(PageMode::Book, cx))
                        }
                    }),
            )
            .child(
                Button::new("mode-slideshow", cx.focus_handle())
                    .label(i18n::t("commands.modeSlideshow"))
                    .size(ButtonSize::Sm)
                    .dark(dark)
                    .on_click({
                        let entity = entity.clone();
                        move |_, window, cx| {
                            entity.update(cx, |v, cx| v.enter_slideshow(window, cx))
                        }
                    }),
            )
            .child(
                div()
                    .flex_none()
                    .text_color(rgb(palette.text_2))
                    .child(label),
            );
        let root =
            div()
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
                .on_action(cx.listener(|this, _: &ZoomFitPage, _window, cx| {
                    this.fit_to_page();
                    cx.notify();
                }))
                .on_action(
                    cx.listener(|this, _: &RotateViewLeft, _window, cx| this.rotate_view(-1, cx)),
                )
                .on_action(
                    cx.listener(|this, _: &RotateViewRight, _window, cx| this.rotate_view(1, cx)),
                )
                .on_action(cx.listener(|this, _: &FocusZoomInput, window, cx| {
                    let input = this.zoom_input.read(cx).focus_handle(cx);
                    window.focus(&input, cx);
                }))
                .on_action(cx.listener(|this, _: &NextPage, _window, cx| {
                    this.go_page(1);
                    cx.notify();
                }))
                .on_action(cx.listener(|this, _: &PrevPage, _window, cx| {
                    this.go_page(-1);
                    cx.notify();
                }))
                .on_action(cx.listener(|this, _: &SlideNext, _window, cx| {
                    if this.page_mode == PageMode::Slideshow {
                        this.go_page(1);
                    }
                    cx.notify();
                }))
                .on_action(cx.listener(|this, _: &SlidePrevious, _window, cx| {
                    if this.page_mode == PageMode::Slideshow {
                        this.go_page(-1);
                    }
                    cx.notify();
                }))
                .on_action(cx.listener(|this, _: &SetTwoPage, _window, cx| {
                    this.set_page_mode(PageMode::TwoPage, cx)
                }))
                .on_action(cx.listener(|this, _: &SetBook, _window, cx| {
                    this.set_page_mode(PageMode::Book, cx)
                }))
                .on_action(cx.listener(|this, _: &SetContinuous, _window, cx| {
                    this.set_page_mode(PageMode::Continuous, cx)
                }))
                .on_action(cx.listener(|this, _: &SetSlideshow, window, cx| {
                    this.enter_slideshow(window, cx)
                }))
                .on_action(cx.listener(|this, _: &ExitSlideshow, window, cx| {
                    if this.page_mode == PageMode::Slideshow {
                        this.exit_slideshow(window, cx);
                    }
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
                .on_action(cx.listener(|this, _: &OpenProperties, window, cx| {
                    this.open_properties(window, cx);
                }))
                .on_action(cx.listener(|this, _: &RotatePage, _window, cx| {
                    this.begin_edit(EditOperation::Rotate, cx)
                }))
                .on_action(cx.listener(|this, _: &UndoEdit, _window, cx| {
                    this.begin_edit(EditOperation::Undo, cx)
                }))
                .on_action(cx.listener(|this, _: &RedoEdit, _window, cx| {
                    this.begin_edit(EditOperation::Redo, cx)
                }))
                .on_action(cx.listener(|this, _: &SaveEdit, _window, cx| {
                    this.begin_edit(EditOperation::Save(None), cx)
                }))
                .on_action(cx.listener(|this, _: &SaveEditAs, _window, cx| {
                    if std::env::var("CHEF_E2E").as_deref() == Ok("1")
                        && let Some(path) = std::env::var_os("CHEF_E2E_SAVE_AS_PATH")
                    {
                        this.begin_edit(
                            EditOperation::Save(Some(PathBuf::from(path).display().to_string())),
                            cx,
                        );
                        return;
                    }
                    let suggested = this
                        .source_path
                        .as_ref()
                        .and_then(|p| p.file_name())
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "document.pdf".into());
                    if let Some(path) = crate::dialogs::save_pdf(
                        this.prefs.save_dir.as_deref().map(std::path::Path::new),
                        &suggested,
                    ) {
                        this.begin_edit(EditOperation::Save(Some(path.display().to_string())), cx);
                    }
                }))
                .on_action(cx.listener(|this, _: &RetryRevisionReload, _window, cx| {
                    this.retry_revision_reload(cx)
                }))
                .on_scroll_wheel(cx.listener(|this, ev: &ScrollWheelEvent, _window, cx| {
                    let dy = ev.delta.pixel_delta(px(LINE_PX)).y.as_f32();
                    this.scroll_by(dy);
                    cx.notify();
                }));

        let (vw, vh) = self.viewport;
        let scale = window.scale_factor();
        let page_viewport_w = (vw - SIDEBAR_WIDTH).max(1.0);
        let fit_page_target = if self.fit_page && self.page_mode != PageMode::Slideshow {
            let page = self
                .spread
                .as_ref()
                .and_then(|s| {
                    fit_anchor_page(
                        s,
                        self.scroll_y,
                        (vh - TOOLBAR_H - FOOTER_H).max(0.0),
                        page_viewport_w,
                    )
                })
                .unwrap_or(0);
            Some((
                page,
                self.fit_group_zoom(page, page_viewport_w, (vh - TOOLBAR_H - FOOTER_H).max(0.0)),
            ))
        } else {
            None
        };
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
        if self.fit_width && self.page_mode != PageMode::Slideshow && page_viewport_w > 0.0 {
            let fit = if let Some(spread) = self.spread.as_ref() {
                spread.fit_width_zoom(page_viewport_w, MARGIN)
            } else {
                layout.fit_width_zoom(page_viewport_w, MARGIN)
            };
            if (fit - layout.zoom()).abs() > 1e-6 {
                layout.set_zoom(fit);
                if let Some(spread) = self.spread.as_mut() {
                    spread.set_zoom(fit);
                }
            }
        }
        if let Some((page, fit)) = fit_page_target {
            if (fit - layout.zoom()).abs() > 1e-6 {
                layout.set_zoom(fit);
                if let Some(s) = self.spread.as_mut() {
                    s.set_zoom(fit);
                }
            }
            if let Some(top) = self.spread.as_ref().and_then(|s| s.page_scroll(page)) {
                self.scroll_y = top;
            }
        }
        let vh = (vh - TOOLBAR_H - FOOTER_H).max(0.0);
        self.scroll_y = if self.page_mode == PageMode::Slideshow {
            self.scroll_y
        } else {
            self.spread.as_ref().map_or_else(
                || layout.clamp_scroll(self.scroll_y, vh),
                |s| s.clamp_scroll(self.scroll_y, vh),
            )
        };
        if self.page_mode == PageMode::Slideshow {
            let slide = self.spread.as_ref().and_then(|spread| {
                spread
                    .visible_pages(self.scroll_y, vh)
                    .first()
                    .copied()
                    .map(|page| {
                        let fit = spread
                            .fit_page_zoom(page, page_viewport_w, vh, MARGIN)
                            .clamp(ZOOM_MIN, ZOOM_MAX);
                        (page, fit)
                    })
            });
            if let Some((page, fit)) = slide {
                if (fit - layout.zoom()).abs() > 1e-5 {
                    layout.set_zoom(fit);
                    if let Some(spread) = self.spread.as_mut() {
                        spread.set_zoom(fit);
                    }
                }
                self.scroll_y = self
                    .spread
                    .as_ref()
                    .and_then(|spread| spread.page_scroll(page))
                    .unwrap_or(0.0);
            }
        }
        let zoom = layout.zoom();
        let page_count = layout.page_count();

        // Vùng nhìn và vùng giữ bitmap. Các trang ngoài vùng giữ bị bỏ khỏi cache (R2).
        let visible: Vec<usize> = self
            .spread
            .as_ref()
            .map(|s| s.visible_pages(self.scroll_y, vh))
            .unwrap_or_else(|| layout.visible(self.scroll_y, vh).collect());
        let keep: Vec<usize> = self
            .spread
            .as_ref()
            .map(|s| s.buffered_pages(self.scroll_y, vh, BUFFER_PAGES))
            .unwrap_or_else(|| {
                layout
                    .full_scale_set(self.scroll_y, vh, BUFFER_PAGES)
                    .collect()
            });
        let geometry: Vec<(usize, f32, f32, f32, f32)> = visible
            .iter()
            .copied()
            .filter_map(|i| {
                if let Some(spread) = self.spread.as_ref() {
                    let r = spread.page_rect(i, page_viewport_w)?;
                    Some((i, r.x, r.y - self.scroll_y, r.width, r.height))
                } else {
                    let (w, h) = layout.page_px(i);
                    Some((
                        i,
                        ((page_viewport_w - w) / 2.0).max(0.0),
                        layout.page_top(i) - self.scroll_y,
                        w,
                        h,
                    ))
                }
            })
            .collect();
        let requests: Vec<(usize, u32, u32)> = keep
            .iter()
            .copied()
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

        // The thumbnail pane has its own small cache and request set. It never borrows full-size
        // page images, and both retained results and outstanding work are limited to visible rows.
        let sidebar_layout = self
            .sidebar_layout
            .as_ref()
            .expect("sidebar layout follows document layout");
        let sidebar_height = (vh - SIDEBAR_HEADER_H).max(0.0);
        let visible_thumbnail_rows = if self.sidebar_outline {
            self.sidebar_scroll_y = self.sidebar_scroll_y.clamp(
                0.0,
                (self.bookmarks.len() as f32 * 28.0 - sidebar_height).max(0.0),
            );
            Vec::new()
        } else {
            self.sidebar_scroll_y = self.sidebar_scroll_y.clamp(
                0.0,
                (sidebar_layout.total_height() - sidebar_height).max(0.0),
            );
            sidebar_layout.visible_rows(self.sidebar_scroll_y, sidebar_height)
        };
        self.sidebar_visible = visible_thumbnail_rows
            .iter()
            .map(|row| row.page_index)
            .collect();
        let visible_thumbnail_set: std::collections::HashSet<usize> =
            self.sidebar_visible.iter().copied().collect();
        let stale_thumbnails: Vec<usize> = self
            .thumbnail_cache
            .keys()
            .copied()
            .filter(|index| !visible_thumbnail_set.contains(index))
            .collect();
        for index in stale_thumbnails {
            if let Some(image) = self.thumbnail_cache.remove(&index) {
                self.to_drop.push(image);
            }
        }
        self.thumbnail_pending
            .retain(|index, _| visible_thumbnail_set.contains(index));
        for row in &visible_thumbnail_rows {
            if self.thumbnail_cache.contains_key(&row.page_index)
                || self.thumbnail_pending.contains_key(&row.page_index)
            {
                continue;
            }
            let Some(doc) = self.doc else { break };
            let width = (THUMBNAIL_RASTER_WIDTH as f32 * scale).round().max(1.0) as u32;
            let (raw_w, raw_h) = self
                .page_sizes
                .get(row.page_index)
                .copied()
                .unwrap_or((row.width, row.height));
            let height = (width as f32 * raw_h / raw_w).round().max(1.0) as u32;
            let (tx, rx) = channel();
            let id = self.handle.next_id();
            if self
                .handle
                .send(Job::Render {
                    id,
                    doc,
                    index: row.page_index,
                    width,
                    height,
                    reply: tx,
                })
                .is_ok()
            {
                self.thumbnail_pending.insert(row.page_index, rx);
            }
        }
        crate::debug::set_sidebar_thumbnail_count(self.thumbnail_cache.len());
        crate::debug::set_sidebar_state(self.sidebar_outline, self.bookmarks.len());

        crate::debug::set_viewer_stats(self.cache.len(), self.pending.len());
        crate::debug::set_viewer_cache_images(
            self.cache
                .entries()
                .map(|(index, image)| (*index, image.id.0)),
        );
        crate::debug::set_view(crate::debug::ViewSnapshot {
            zoom,
            scroll_y: self.scroll_y,
            viewport_h: vh,
            fit_width: self.fit_width,
            fit_page: self.fit_page,
            rotation: self.view_rotation,
            first_page: visible.first().copied().unwrap_or(0),
            kind: self.kind.map_or("", |k| k.as_str()),
            mode: match self.page_mode {
                PageMode::Continuous => "continuous",
                PageMode::TwoPage => "twoPage",
                PageMode::Book => "book",
                PageMode::Slideshow => "slideshow",
            },
            visible_pages: visible.clone(),
            fullscreen: window.is_fullscreen(),
        });
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
                            let (left, top, right, bottom) =
                                self.rect_to_view(i, rect.left, rect.top, rect.right, rect.bottom);
                            children.push(
                                div()
                                    .absolute()
                                    .left(px(x + left * zoom))
                                    .top(px(y + top * zoom))
                                    .w(px((right - left) * zoom))
                                    .h(px((bottom - top) * zoom))
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
                    let (left, top, right, bottom) =
                        self.rect_to_view(i, rect.left, rect.top, rect.right, rect.bottom);
                    children.push(
                        div()
                            .absolute()
                            .left(px(x + left * zoom))
                            .top(px(y + top * zoom))
                            .w(px((right - left) * zoom))
                            .h(px((bottom - top) * zoom))
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
            .min_w_0()
            .overflow_hidden()
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .children(children);
        let pages_toggle = cx.listener(|this, _: &MouseDownEvent, _window, cx| {
            this.sidebar_outline = false;
            this.sidebar_scroll_y = 0.0;
            cx.notify();
        });
        let outline_toggle = cx.listener(|this, _: &MouseDownEvent, _window, cx| {
            this.sidebar_outline = true;
            this.sidebar_scroll_y = 0.0;
            cx.notify();
        });
        let mut sidebar_header = div()
            .w_full()
            .h(px(SIDEBAR_HEADER_H))
            .flex()
            .flex_row()
            .items_center()
            .justify_center()
            .gap(px(6.0))
            .border_b_1()
            .border_color(rgb(palette.border));
        sidebar_header = sidebar_header
            .child(
                div()
                    .id("sidebar-pages")
                    .px(px(8.0))
                    .py(px(5.0))
                    .cursor_pointer()
                    .bg(rgb(if !self.sidebar_outline {
                        palette.surface
                    } else {
                        palette.canvas
                    }))
                    .text_color(rgb(palette.text))
                    .child(i18n::t("sidebar.thumbnails"))
                    .on_mouse_down(MouseButton::Left, pages_toggle),
            )
            .child(
                div()
                    .id("sidebar-outline")
                    .px(px(8.0))
                    .py(px(5.0))
                    .cursor_pointer()
                    .bg(rgb(if self.sidebar_outline {
                        palette.surface
                    } else {
                        palette.canvas
                    }))
                    .text_color(rgb(palette.text))
                    .child(i18n::t("sidebar.outline"))
                    .on_mouse_down(MouseButton::Left, outline_toggle),
            );
        let sidebar_scroll = cx.listener(|this, ev: &ScrollWheelEvent, _window, cx| {
            cx.stop_propagation();
            let delta = ev.delta.pixel_delta(px(LINE_PX)).y.as_f32();
            this.sidebar_scroll_y = (this.sidebar_scroll_y - delta).max(0.0);
            cx.notify();
        });
        let mut sidebar_rows = Vec::new();
        if self.sidebar_outline {
            let row_height = 28.0;
            let first = (self.sidebar_scroll_y / row_height).floor() as usize;
            let end = ((self.sidebar_scroll_y + sidebar_height) / row_height).ceil() as usize;
            for (index, bookmark) in self
                .bookmarks
                .iter()
                .enumerate()
                .skip(first)
                .take(end.saturating_sub(first))
            {
                let top = SIDEBAR_HEADER_H + index as f32 * row_height - self.sidebar_scroll_y;
                let title = if bookmark.title.is_empty() {
                    "(không có tiêu đề)"
                } else {
                    &bookmark.title
                };
                let mut row = div()
                    .id(format!("bookmark-{index}"))
                    .absolute()
                    .left(px(0.0))
                    .top(px(top))
                    .w_full()
                    .h(px(row_height))
                    .px(px(8.0 + bookmark.depth.min(8) as f32 * 10.0))
                    .flex()
                    .items_center()
                    .overflow_hidden()
                    .text_color(rgb(if bookmark.page_index.is_some() {
                        palette.text
                    } else {
                        palette.text_2
                    }))
                    .child(title.to_string());
                if let Some(page_index) = bookmark.page_index {
                    let navigate = cx.listener(move |this, _: &MouseDownEvent, _window, cx| {
                        this.go_to_page(page_index);
                        cx.notify();
                    });
                    row = row
                        .cursor_pointer()
                        .on_mouse_down(MouseButton::Left, navigate);
                }
                sidebar_rows.push(row.into_any_element());
            }
        } else {
            for row in &visible_thumbnail_rows {
                let top = SIDEBAR_HEADER_H + row.top - self.sidebar_scroll_y;
                let child = match self.thumbnail_cache.get(&row.page_index).cloned() {
                    Some(image) => img(image)
                        .w(px(row.width))
                        .h(px(row.height))
                        .border_1()
                        .border_color(rgb(palette.border))
                        .into_any_element(),
                    None => div()
                        .w(px(row.width))
                        .h(px(row.height))
                        .bg(rgb(palette.surface))
                        .border_1()
                        .border_color(rgb(palette.border))
                        .into_any_element(),
                };
                let page_index = row.page_index;
                let navigate = cx.listener(move |this, _: &MouseDownEvent, _window, cx| {
                    this.go_to_page(page_index);
                    cx.notify();
                });
                sidebar_rows.push(
                    div()
                        .id(format!("thumbnail-{}", page_index + 1))
                        .absolute()
                        .left(px(0.0))
                        .top(px(top))
                        .w_full()
                        .h(px(row.height))
                        .flex()
                        .justify_center()
                        .cursor_pointer()
                        .child(child)
                        .on_mouse_down(MouseButton::Left, navigate)
                        .into_any_element(),
                );
            }
        }
        if self.sidebar_outline && self.bookmarks.is_empty() {
            sidebar_rows.push(
                div()
                    .absolute()
                    .top(px(SIDEBAR_HEADER_H))
                    .w_full()
                    .px(px(8.0))
                    .py(px(8.0))
                    .text_color(rgb(palette.text_2))
                    .child(i18n::t("sidebar.noOutlineText"))
                    .into_any_element(),
            );
        }
        let sidebar = div()
            .id("document-sidebar")
            .w(px(SIDEBAR_WIDTH))
            .h_full()
            .flex_none()
            .flex()
            .flex_col()
            .overflow_hidden()
            .bg(rgb(palette.canvas))
            .border_r_1()
            .border_color(rgb(palette.border))
            .child(sidebar_header)
            .child(
                div()
                    .id("sidebar-scroll")
                    .relative()
                    .flex_1()
                    .overflow_hidden()
                    .on_scroll_wheel(sidebar_scroll)
                    .children(sidebar_rows),
            );
        let body = div()
            .w_full()
            .flex_1()
            .flex()
            .flex_row()
            .overflow_hidden()
            .child(sidebar)
            .child(content);
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
                visible.first().copied().unwrap_or(0) + 1,
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
            .children(source_banner)
            .child(body)
            .child(footer)
            .children(settings_dialog)
            .children(props_dialog)
            .children(password_dialog)
    }
}

#[cfg(test)]
mod zoom_rotation_tests {
    use super::*;

    #[test]
    fn view_rotation_maps_text_points_and_rectangles_consistently() {
        let (w, h) = (600.0, 800.0);
        for rotation in 0..4 {
            let (x, y) = match rotation {
                1 => (h - 120.0, 40.0),
                2 => (w - 40.0, h - 120.0),
                3 => (120.0, w - 40.0),
                _ => (40.0, 120.0),
            };
            assert_eq!(display_to_pdf(x, y, w, h, rotation), (40.0, 120.0));
            let rect = pdf_rect_to_view(20.0, 30.0, 80.0, 100.0, w, h, rotation);
            assert!(rect.0 < rect.2 && rect.1 < rect.3);
            let (rw, rh) = oriented_sizes(&[(w, h)], rotation)[0];
            let corners = [
                (rect.0, rect.1),
                (rect.2, rect.1),
                (rect.0, rect.3),
                (rect.2, rect.3),
            ];
            assert!(
                corners
                    .iter()
                    .all(|(x, y)| *x >= 0.0 && *y >= 0.0 && *x <= rw && *y <= rh)
            );
            for (x, y) in [(rect.0, rect.1), (rect.2, rect.3)] {
                let (px, py) = display_to_pdf(x, y, w, h, rotation);
                let (l, t, r, b) = pdf_rect_to_view(px, py, px, py, w, h, rotation);
                assert!(
                    (l - x).abs() < 1e-4
                        && (t - y).abs() < 1e-4
                        && (r - x).abs() < 1e-4
                        && (b - y).abs() < 1e-4
                );
            }
        }
    }

    #[test]
    fn fit_page_from_mid_page_anchors_center_page_and_resize_keeps_group() {
        let sizes = vec![(600.0, 800.0); 8];
        let mut spread = SpreadLayout::new(sizes, PageMode::Continuous, 24.0, 24.0, 1.0);
        let selected = 4;
        let top = spread.page_scroll(selected).unwrap();
        let scroll = top + 200.0;
        assert_eq!(
            fit_anchor_page(&spread, scroll, 400.0, 900.0),
            Some(selected)
        );
        let fit = spread.fit_page_zoom(selected, 900.0, 400.0, 24.0);
        spread.set_zoom(fit);
        assert_eq!(
            fit_anchor_page(&spread, spread.page_scroll(selected).unwrap(), 400.0, 500.0),
            Some(selected)
        );
        let resized = spread.fit_page_zoom(selected, 500.0, 300.0, 24.0);
        spread.set_zoom(resized);
        let restored = spread.page_scroll(selected).unwrap();
        assert_eq!(
            fit_anchor_page(&spread, restored, 300.0, 500.0),
            Some(selected)
        );
    }
}
