//! Kênh debug cho E2E (TASKS_RUST R1.07). Chỉ bật khi CHEF_E2E=1.
//!
//! Named pipe `\\.\pipe\chef-native-<pid>` nhận một dòng `<token> <lệnh> [tham số]\n`
//! và trả một dòng. Token ngẫu nhiên 128 bit, in ra stderr khi khởi động; lệnh sai token
//! bị từ chối. Không mở cổng mạng (cùng nguyên tắc với JSON-RPC, CONTRACTS §3).
//!
//! Lệnh:
//! - `state`: JSON các trạng thái của cửa sổ (hiện hay không, hình chữ nhật).
//! - `screenshot <đường dẫn.bmp>`: chụp nội dung cửa sổ bằng PrintWindow, ghi BMP 32-bit.
//! - `quit`: thoát tiến trình.
//!
//! Chụp qua PrintWindow vì backend Windows của GPUI không triển khai render_to_image
//! (gpui_windows không có; chỉ macOS và test có).

use std::ffi::c_void;
use std::io::Write;
use std::mem::size_of;
use std::thread;
use std::time::{Duration, Instant};

const PIPE_ACCESS_DUPLEX: u32 = 0x0000_0003;
const PIPE_TYPE_BYTE: u32 = 0x0000_0000;
const PIPE_READMODE_BYTE: u32 = 0x0000_0000;
const PIPE_WAIT: u32 = 0x0000_0000;
const PIPE_UNLIMITED_INSTANCES: u32 = 255;
const INVALID_HANDLE_VALUE: isize = -1;
const BI_RGB: u32 = 0;

/// Số lần GPUI gọi `render` từ khi khởi động. Đọc qua lệnh `state` để đo số vòng vẽ (R1.08).
static RENDERS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static RENDER_TIMING: std::sync::LazyLock<RenderTiming> =
    std::sync::LazyLock::new(RenderTiming::default);
static LAST_RENDER_START: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);

#[derive(Default)]
struct RenderTiming {
    samples: std::sync::atomic::AtomicU64,
    body_max_ns: std::sync::atomic::AtomicU64,
    body_over_50ms: std::sync::atomic::AtomicU64,
    call_gap_max_ns: std::sync::atomic::AtomicU64,
    call_gap_over_50ms: std::sync::atomic::AtomicU64,
}

pub struct RenderTimer {
    start: Instant,
    call_gap_ns: Option<u64>,
    enabled: bool,
}

impl Drop for RenderTimer {
    fn drop(&mut self) {
        if !self.enabled {
            return;
        }
        let ns = self.start.elapsed().as_nanos().min(u64::MAX as u128) as u64;
        RENDER_TIMING
            .samples
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        RENDER_TIMING
            .body_max_ns
            .fetch_max(ns, std::sync::atomic::Ordering::Relaxed);
        if ns > 50_000_000 {
            RENDER_TIMING
                .body_over_50ms
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        if let Some(gap) = self.call_gap_ns {
            RENDER_TIMING
                .call_gap_max_ns
                .fetch_max(gap, std::sync::atomic::Ordering::Relaxed);
            if gap > 50_000_000 {
                RENDER_TIMING
                    .call_gap_over_50ms
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
        }
    }
}

pub fn render_timer() -> RenderTimer {
    let start = Instant::now();
    let enabled = std::env::var_os("CHEF_E2E").as_deref() == Some(std::ffi::OsStr::new("1"));
    let call_gap_ns = if enabled {
        LAST_RENDER_START
            .lock()
            .ok()
            .and_then(|mut last| last.replace(start))
            .map(|last| start.duration_since(last).as_nanos().min(u64::MAX as u128) as u64)
    } else {
        None
    };
    RenderTimer {
        start,
        call_gap_ns,
        enabled,
    }
}

fn reset_render_timing() {
    RENDER_TIMING
        .samples
        .store(0, std::sync::atomic::Ordering::Relaxed);
    RENDER_TIMING
        .body_max_ns
        .store(0, std::sync::atomic::Ordering::Relaxed);
    RENDER_TIMING
        .body_over_50ms
        .store(0, std::sync::atomic::Ordering::Relaxed);
    RENDER_TIMING
        .call_gap_max_ns
        .store(0, std::sync::atomic::Ordering::Relaxed);
    RENDER_TIMING
        .call_gap_over_50ms
        .store(0, std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut last) = LAST_RENDER_START.lock() {
        *last = None;
    }
}

fn render_timing_json() -> String {
    let samples = RENDER_TIMING
        .samples
        .load(std::sync::atomic::Ordering::Relaxed);
    let max_ms = RENDER_TIMING
        .body_max_ns
        .load(std::sync::atomic::Ordering::Relaxed) as f64
        / 1_000_000.0;
    let over = RENDER_TIMING
        .body_over_50ms
        .load(std::sync::atomic::Ordering::Relaxed);
    let gap_ms = RENDER_TIMING
        .call_gap_max_ns
        .load(std::sync::atomic::Ordering::Relaxed) as f64
        / 1_000_000.0;
    let gap_over = RENDER_TIMING
        .call_gap_over_50ms
        .load(std::sync::atomic::Ordering::Relaxed);
    format!(
        "{{\"bodyMeasurement\":\"GPUI Render body duration\",\"gapMeasurement\":\"between Render call start timestamps, not presented frame interval\",\"samples\":{samples},\"maxBodyMs\":{max_ms:.3},\"bodyOver50ms\":{over},\"maxRenderCallGapMs\":{gap_ms:.3},\"renderCallGapOver50ms\":{gap_over}}}"
    )
}
static THEME_DARK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static TABS: std::sync::LazyLock<std::sync::Mutex<String>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new("[]".into()));
static START_RECENTS: std::sync::LazyLock<std::sync::Mutex<String>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new("[]".into()));
static TAB_MESSAGE: std::sync::LazyLock<std::sync::Mutex<String>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new("null".into()));
static PALETTE: std::sync::LazyLock<std::sync::Mutex<String>> = std::sync::LazyLock::new(|| {
    std::sync::Mutex::new("{\"open\":false,\"query\":\"\",\"selected\":0,\"results\":[]}".into())
});

/// Snapshot of document tab identity, selection, dirty state, and retained page images.
pub fn set_tabs(tabs: serde_json::Value) {
    if let Ok(mut current) = TABS.lock() {
        *current = tabs.to_string();
    }
}

/// Ordered recent file paths on the Start screen, for isolated native UI E2E.
pub fn set_start_recents(paths: Vec<String>) {
    if let Ok(mut current) = START_RECENTS.lock() {
        *current = serde_json::to_string(&paths).unwrap_or_else(|_| "[]".into());
    }
}

pub fn set_tab_message(message: Option<&str>) {
    if let Ok(mut current) = TAB_MESSAGE.lock() {
        *current = message.map_or_else(|| "null".into(), json_str);
    }
}

pub fn set_palette_state(state: serde_json::Value) {
    if let Ok(mut current) = PALETTE.lock() {
        *current = state.to_string();
    }
}

/// Theme đang được dùng trong lần render gần nhất.
pub fn set_theme_dark(dark: bool) {
    THEME_DARK.store(dark, std::sync::atomic::Ordering::Relaxed);
}

/// Gọi mỗi lần `render` của cửa sổ.
pub fn count_render() {
    RENDERS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

/// Số trang đang có ảnh trong cache và số yêu cầu render đang chờ, do viewer cập nhật.
static CACHED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static PENDING: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static CACHED_PAGE_IMAGES: std::sync::LazyLock<std::sync::Mutex<String>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new("{}".into()));
static CACHE_INVALIDATION: std::sync::LazyLock<std::sync::Mutex<String>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new("null".into()));
static SOURCE_WARNING: std::sync::LazyLock<std::sync::Mutex<String>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new("null".into()));
static SIDEBAR_THUMBNAILS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static SIDEBAR_OUTLINE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static SIDEBAR_BOOKMARKS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn set_viewer_stats(cached: usize, pending: usize) {
    CACHED.store(cached as u64, std::sync::atomic::Ordering::Relaxed);
    PENDING.store(pending as u64, std::sync::atomic::Ordering::Relaxed);
}

/// Full-size bitmap page index -> GPUI's monotonic RenderImage ID for the active viewer.
/// IDs distinguish preserved cache entries from a page that was invalidated and rerendered.
pub fn set_viewer_cache_images(images: impl IntoIterator<Item = (usize, usize)>) {
    let value = serde_json::to_string(
        &images
            .into_iter()
            .collect::<std::collections::BTreeMap<_, _>>(),
    )
    .unwrap_or_else(|_| "{}".into());
    if let Ok(mut current) = CACHED_PAGE_IMAGES.lock() {
        *current = value;
    }
}

/// Audit a revision's full-size bitmap invalidation at the moment it is applied.
pub fn set_cache_invalidation(snapshot: serde_json::Value) {
    if let Ok(mut current) = CACHE_INVALIDATION.lock() {
        *current = snapshot.to_string();
    }
}

/// Localized source warning shown by the viewer, without exposing the source path.
pub fn set_source_warning(warning: Option<(&str, &str)>) {
    let value = warning
        .map(|(title, body)| serde_json::json!({"title": title, "body": body}).to_string())
        .unwrap_or_else(|| "null".into());
    if let Ok(mut current) = SOURCE_WARNING.lock() {
        *current = value;
    }
}

/// Number of retained page thumbnails in the active document's sidebar (R2.22).
pub fn set_sidebar_thumbnail_count(count: usize) {
    SIDEBAR_THUMBNAILS.store(count as u64, std::sync::atomic::Ordering::Relaxed);
}

pub fn set_sidebar_state(outline: bool, bookmark_count: usize) {
    SIDEBAR_OUTLINE.store(outline, std::sync::atomic::Ordering::Relaxed);
    SIDEBAR_BOOKMARKS.store(bookmark_count as u64, std::sync::atomic::Ordering::Relaxed);
}

/// Tên action được phép gửi qua lệnh `action`. Luồng GPUI đổi tên thành action thật (main.rs).
pub const ACTION_NAMES: &[&str] = &[
    "selectall",
    "selectleft",
    "selectright",
    "left",
    "right",
    "home",
    "end",
    "backspace",
    "delete",
    "copy",
    "cut",
    "paste",
    "submit",
    "submitback",
    "cancel",
    "focussearch",
    "selectalltext",
    "copyselection",
    "zoomin",
    "zoomout",
    "zoomreset",
    "zoomfitpage",
    "rotateviewleft",
    "rotateviewright",
    "focuszoom",
    "nextpage",
    "prevpage",
    "togglefullscreen",
    "exitslideshow",
    "togglenight",
    "focusnext",
    "focusprev",
    "opensettings",
    "openfile",
    "openpalette",
    "palettenext",
    "paletteprev",
    "tabnext",
    "tabprev",
    "closetab",
    "openproperties",
    "rotatepage",
    "undoedit",
    "redoedit",
    "saveedit",
    "saveeditas",
    "viewcontinuous",
    "viewtwopage",
    "viewbook",
    "viewslideshow",
    "slidenext",
    "slideprevious",
];

/// Hàng đợi action chờ luồng GPUI chạy. Đường đi: pipe -> hàng đợi -> `window.dispatch_action`,
/// nên tổ hợp phím như Shift+mũi tên được kiểm đúng đường keymap (PostMessage không đặt được Shift).
static ACTIONS: std::sync::Mutex<std::collections::VecDeque<String>> =
    std::sync::Mutex::new(std::collections::VecDeque::new());
/// Số màn hình cần cuộn (chỉ nhận lệnh qua debug pipe E2E).
static SCROLL_SCREENS: std::sync::Mutex<std::collections::VecDeque<f32>> =
    std::sync::Mutex::new(std::collections::VecDeque::new());
/// (bước mục tiêu, bước hoàn tất, đang thực thi), để runner đợi cuộn có nhịp xong.
static SCROLL_PROGRESS: std::sync::Mutex<(u32, u32, bool)> = std::sync::Mutex::new((0, 0, false));

/// Lấy các action đang chờ (gọi từ luồng GPUI).
pub fn take_actions() -> Vec<String> {
    match ACTIONS.lock() {
        Ok(mut queue) => queue.drain(..).collect(),
        Err(_) => Vec::new(),
    }
}

/// Lấy các lệnh cuộn chính xác đang chờ để chạy trên luồng GPUI.
pub fn take_scroll_screens() -> Vec<f32> {
    match SCROLL_SCREENS.lock() {
        Ok(mut queue) => queue.drain(..).collect(),
        Err(_) => Vec::new(),
    }
}

pub fn set_scroll_progress(completed: u32, total: u32, active: bool) {
    if let Ok(mut progress) = SCROLL_PROGRESS.lock() {
        *progress = (total, completed, active);
    }
}

fn scroll_progress_json() -> String {
    let (total, completed, active) = SCROLL_PROGRESS.lock().map(|p| *p).unwrap_or((0, 0, false));
    format!("{{\"total\":{total},\"completed\":{completed},\"active\":{active}}}")
}

/// (zoom, vị trí cuộn, chiều cao vùng nhìn, vừa chiều rộng, trang đầu, lớp chữ).
type ViewState = (
    f32,
    f32,
    f32,
    bool,
    usize,
    &'static str,
    &'static str,
    Vec<usize>,
    bool,
    bool,
    u8,
);

pub struct ViewSnapshot {
    pub zoom: f32,
    pub scroll_y: f32,
    pub viewport_h: f32,
    pub fit_width: bool,
    pub first_page: usize,
    pub kind: &'static str,
    pub mode: &'static str,
    pub visible_pages: Vec<usize>,
    pub fullscreen: bool,
    pub fit_page: bool,
    pub rotation: u8,
}

/// Trạng thái khung nhìn, do viewer ghi mỗi lần vẽ: zoom, vị trí cuộn, chiều cao vùng nhìn, chế độ
/// vừa chiều rộng, và trang đầu đang thấy.
static VIEW: std::sync::Mutex<Option<ViewState>> = std::sync::Mutex::new(None);

/// `kind` là lớp chữ của tài liệu (Có chữ, Scan, Hỗn hợp), hoặc "" khi chưa biết.
/// Chế độ đọc ban đêm đang bật (mục `view.night` của lệnh `state`).
static NIGHT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_night(on: bool) {
    NIGHT.store(on, std::sync::atomic::Ordering::Relaxed);
}

pub fn set_view(snapshot: ViewSnapshot) {
    if let Ok(mut view) = VIEW.lock() {
        *view = Some((
            snapshot.zoom,
            snapshot.scroll_y,
            snapshot.viewport_h,
            snapshot.fit_width,
            snapshot.first_page,
            snapshot.kind,
            snapshot.mode,
            snapshot.visible_pages,
            snapshot.fullscreen,
            snapshot.fit_page,
            snapshot.rotation,
        ));
    }
}

fn view_json() -> String {
    match VIEW.lock().ok().and_then(|guard| guard.clone()) {
        Some((
            zoom,
            scroll_y,
            viewport_h,
            fit_width,
            first_page,
            kind,
            mode,
            visible_pages,
            fullscreen,
            fit_page,
            rotation,
        )) => format!(
            "{{\"zoom\":{zoom:.4},\"scrollY\":{scroll_y:.2},\"viewportH\":{viewport_h:.2},\"fitWidth\":{fit_width},\"fitPage\":{fit_page},\"rotation\":{rotation},\"firstPage\":{first_page},\"kind\":{},\"night\":{},\"mode\":{},\"pageMode\":{},\"visiblePages\":{},\"fullscreen\":{fullscreen}}}",
            json_str(kind),
            NIGHT.load(std::sync::atomic::Ordering::Relaxed),
            json_str(mode),
            json_str(mode),
            serde_json::to_string(&visible_pages).unwrap_or_else(|_| "[]".into())
        ),
        None => "null".into(),
    }
}

/// (cụm tìm, tổng khớp, khớp đang chọn, còn quét).
type FindState = (String, usize, Option<usize>, bool);

/// Trạng thái tìm, do viewer ghi mỗi lần vẽ: cụm tìm, tổng khớp, khớp đang chọn, còn quét không.
static FIND: std::sync::Mutex<Option<FindState>> = std::sync::Mutex::new(None);

pub fn set_find(query: &str, total: usize, current: Option<usize>, scanning: bool) {
    if let Ok(mut find) = FIND.lock() {
        *find = Some((query.to_string(), total, current, scanning));
    }
}

fn find_json() -> String {
    match FIND.lock().ok().and_then(|guard| guard.clone()) {
        Some((query, total, current, scanning)) => format!(
            "{{\"query\":{},\"total\":{total},\"current\":{},\"scanning\":{scanning}}}",
            json_str(&query),
            current.map_or("null".to_string(), |k| k.to_string())
        ),
        None => "null".into(),
    }
}

/// Nội dung và vùng chọn của ô nhập, do luồng GPUI ghi sau mỗi lần xử lý action.
static INPUT: std::sync::Mutex<Option<(String, usize, usize, bool)>> = std::sync::Mutex::new(None);

pub fn set_input(text: &str, selected: std::ops::Range<usize>, focused: bool) {
    if let Ok(mut input) = INPUT.lock() {
        *input = Some((text.to_string(), selected.start, selected.end, focused));
    }
}

const BCRYPT_USE_SYSTEM_PREFERRED_RNG: u32 = 0x0000_0002;

#[repr(C)]
struct WinRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[repr(C)]
#[allow(non_snake_case)]
struct BitmapInfoHeader {
    biSize: u32,
    biWidth: i32,
    biHeight: i32,
    biPlanes: u16,
    biBitCount: u16,
    biCompression: u32,
    biSizeImage: u32,
    biXPelsPerMeter: i32,
    biYPelsPerMeter: i32,
    biClrUsed: u32,
    biClrImportant: u32,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateNamedPipeW(
        name: *const u16,
        open_mode: u32,
        pipe_mode: u32,
        max_instances: u32,
        out_size: u32,
        in_size: u32,
        default_timeout: u32,
        security: *const c_void,
    ) -> isize;
    fn ConnectNamedPipe(pipe: isize, overlapped: *mut c_void) -> i32;
    fn DisconnectNamedPipe(pipe: isize) -> i32;
    fn ReadFile(
        file: isize,
        buf: *mut u8,
        to_read: u32,
        read: *mut u32,
        overlapped: *mut c_void,
    ) -> i32;
    fn WriteFile(
        file: isize,
        buf: *const u8,
        to_write: u32,
        written: *mut u32,
        overlapped: *mut c_void,
    ) -> i32;
    fn FlushFileBuffers(file: isize) -> i32;
    fn CloseHandle(handle: isize) -> i32;
    fn GetCurrentProcessId() -> u32;
}

#[link(name = "user32")]
unsafe extern "system" {
    fn GetWindowRect(hwnd: isize, rect: *mut WinRect) -> i32;
    fn IsWindowVisible(hwnd: isize) -> i32;
    fn GetForegroundWindow() -> isize;
    fn GetDpiForWindow(hwnd: isize) -> u32;
    fn PostMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> i32;
}

const WM_KEYDOWN: u32 = 0x0100;
const WM_KEYUP: u32 = 0x0101;
const WM_CHAR: u32 = 0x0102;
const WM_MOUSEMOVE: u32 = 0x0200;
const WM_LBUTTONDOWN: u32 = 0x0201;
const WM_LBUTTONUP: u32 = 0x0202;
const WM_RBUTTONDOWN: u32 = 0x0204;
const WM_RBUTTONUP: u32 = 0x0205;
/// Cờ MK_LBUTTON của wParam: nút trái đang giữ (khi kéo).
const MK_LBUTTON: usize = 0x0001;
const MK_RBUTTON: usize = 0x0002;

#[link(name = "bcrypt")]
unsafe extern "system" {
    fn BCryptGenRandom(alg: isize, buf: *mut u8, len: u32, flags: u32) -> i32;
}

/// Token ngẫu nhiên 128 bit (32 ký tự hex) từ bộ sinh số ngẫu nhiên của hệ điều hành.
fn random_token() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    // SAFETY: bộ đệm đúng độ dài, cờ dùng bộ sinh ưu tiên của hệ thống.
    let status = unsafe {
        BCryptGenRandom(
            0,
            bytes.as_mut_ptr(),
            bytes.len() as u32,
            BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        )
    };
    if status != 0 {
        return Err(format!("BCryptGenRandom lỗi {status:#x}"));
    }
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Ghi BMP 32-bit từ bộ đệm BGRA (từ trên xuống) ra file.
fn write_bmp(path: &str, width: u32, height: u32, bgra_top_down: &[u8]) -> std::io::Result<()> {
    let row = (width * 4) as usize;
    let header_size = 14 + size_of::<BitmapInfoHeader>();
    let image_size = row * height as usize;
    let mut file = std::fs::File::create(path)?;
    // BITMAPFILEHEADER
    file.write_all(b"BM")?;
    file.write_all(&((header_size + image_size) as u32).to_le_bytes())?;
    file.write_all(&0u32.to_le_bytes())?;
    file.write_all(&(header_size as u32).to_le_bytes())?;
    // BitmapInfoHeader: chiều cao âm = ảnh từ trên xuống
    let info = BitmapInfoHeader {
        biSize: size_of::<BitmapInfoHeader>() as u32,
        biWidth: width as i32,
        biHeight: -(height as i32),
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB,
        biSizeImage: image_size as u32,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
    };
    // SAFETY: BitmapInfoHeader là repr(C), đọc các byte của nó để ghi file.
    let info_bytes = unsafe {
        std::slice::from_raw_parts(
            &info as *const _ as *const u8,
            size_of::<BitmapInfoHeader>(),
        )
    };
    file.write_all(info_bytes)?;
    file.write_all(bgra_top_down)?;
    Ok(())
}

/// Chụp nội dung cửa sổ bằng Windows.Graphics.Capture (kể cả khi nằm ngoài màn hình) và ghi BMP.
fn screenshot(hwnd: isize, path: &str) -> Result<String, String> {
    let frame = crate::capture::capture_window(hwnd, Duration::from_secs(5))?;
    write_bmp(path, frame.width, frame.height, &frame.pixels)
        .map_err(|e| format!("ghi BMP lỗi: {e}"))?;
    Ok(format!(
        "{{\"ok\":true,\"path\":{:?},\"width\":{},\"height\":{}}}",
        path, frame.width, frame.height
    ))
}

/// Chuỗi JSON có dấu nháy kép: escape `"`, `\` và ký tự điều khiển, giữ nguyên Unicode.
fn json_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn input_json() -> String {
    match INPUT.lock().ok().and_then(|guard| guard.clone()) {
        Some((text, start, end, focused)) => format!(
            "{{\"text\":{},\"selStart\":{start},\"selEnd\":{end},\"focused\":{focused}}}",
            json_str(&text)
        ),
        None => "null".into(),
    }
}

/// Trạng thái cài đặt của viewer (theme, ngôn ngữ, thư mục, hộp thoại đang mở), dạng JSON.
/// Viewer ghi mỗi lần vẽ.
/// Trạng thái hộp nhập mật khẩu (mở, lần thử trước sai). Viewer ghi mỗi lần vẽ.
static PASSWORD: std::sync::Mutex<(bool, bool, bool, bool, bool)> =
    std::sync::Mutex::new((false, false, true, false, true));

pub fn set_password(open: bool, wrong: bool, buffer_empty: bool, source_held: bool, masked: bool) {
    if let Ok(mut current) = PASSWORD.lock() {
        *current = (open, wrong, buffer_empty, source_held, masked);
    }
}

fn password_json() -> String {
    let (open, wrong, buffer_empty, source_held, masked) = PASSWORD
        .lock()
        .map(|p| *p)
        .unwrap_or((false, false, true, false, true));
    format!(
        "{{\"open\":{open},\"wrong\":{wrong},\"bufferEmpty\":{buffer_empty},\"sourceHeld\":{source_held},\"masked\":{masked},\"copyAllowed\":{}}}",
        !masked
    )
}

/// Số liệu hộp thoại Thuộc tính khi đang mở (JSON), hoặc None. Viewer ghi mỗi lần vẽ.
static PROPERTIES: std::sync::Mutex<Option<serde_json::Value>> = std::sync::Mutex::new(None);

pub fn set_properties(value: Option<serde_json::Value>) {
    if let Ok(mut current) = PROPERTIES.lock() {
        *current = value;
    }
}

fn properties_json() -> String {
    match PROPERTIES.lock().ok().and_then(|p| p.clone()) {
        Some(value) => value.to_string(),
        None => "null".into(),
    }
}

static MESSAGE: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Thông báo đang hiện của viewer (lỗi mở, lỗi lưu), hoặc None. Viewer ghi mỗi lần vẽ.
pub fn set_message(message: Option<&str>) {
    if let Ok(mut current) = MESSAGE.lock() {
        *current = message.map(str::to_string);
    }
}

fn message_json() -> String {
    match MESSAGE.lock().ok().and_then(|m| m.clone()) {
        Some(text) => json_str(&text),
        None => "null".into(),
    }
}

static SETTINGS: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

pub fn set_settings(theme: &str, language: &str, save_dir: Option<&str>, open: bool) {
    let dir = match save_dir {
        Some(d) => json_str(d),
        None => "null".into(),
    };
    let text = format!(
        "{{\"theme\":{},\"language\":{},\"defaultSaveDir\":{dir},\"open\":{open}}}",
        json_str(theme),
        json_str(language)
    );
    if let Ok(mut current) = SETTINGS.lock() {
        *current = text;
    }
}

fn settings_json() -> String {
    match SETTINGS.lock() {
        Ok(current) if !current.is_empty() => current.clone(),
        _ => "{}".into(),
    }
}

fn state(hwnd: isize) -> String {
    let mut rect = WinRect {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    // SAFETY: con trỏ tới WinRect hợp lệ.
    let ok = unsafe { GetWindowRect(hwnd, &mut rect) } != 0;
    // SAFETY: chỉ đọc trạng thái hiển thị của cửa sổ.
    let visible = unsafe { IsWindowVisible(hwnd) } != 0;
    // Read-only check used by R2.17 to verify activation after a second launch forwards paths.
    let foreground = unsafe { GetForegroundWindow() } == hwnd;
    // Tỉ lệ hiển thị của cửa sổ (96 DPI là 1,0). E2E dùng để đổi tọa độ logic sang vật lý.
    // SAFETY: chỉ đọc DPI của cửa sổ còn sống; 0 nếu không lấy được.
    let dpi = unsafe { GetDpiForWindow(hwnd) };
    let scale = if dpi == 0 { 1.0 } else { dpi as f32 / 96.0 };
    format!(
        "{{\"hwnd\":{hwnd},\"visible\":{visible},\"foreground\":{foreground},\"scale\":{scale},\"themeDark\":{},\"rect\":{{\"left\":{},\"top\":{},\"right\":{},\"bottom\":{}}},\"rectOk\":{ok},\"renders\":{},\"renderTiming\":{},\"cached\":{},\"cachedPageImages\":{},\"cacheInvalidation\":{},\"sourceWarning\":{},\"pending\":{},\"sidebarThumbnails\":{},\"sidebarOutline\":{},\"sidebarBookmarks\":{},\"startRecentFiles\":{},\"input\":{},\"find\":{},\"view\":{},\"tabs\":{},\"tabMessage\":{},\"palette\":{},\"controls\":{},\"reducedMotion\":{},\"settings\":{},\"message\":{},\"properties\":{},\"password\":{},\"scrollProgress\":{},\"logLines\":{}}}",
        THEME_DARK.load(std::sync::atomic::Ordering::Relaxed),
        rect.left,
        rect.top,
        rect.right,
        rect.bottom,
        RENDERS.load(std::sync::atomic::Ordering::Relaxed),
        render_timing_json(),
        CACHED.load(std::sync::atomic::Ordering::Relaxed),
        CACHED_PAGE_IMAGES
            .lock()
            .map(|images| images.clone())
            .unwrap_or_else(|_| "{}".into()),
        CACHE_INVALIDATION
            .lock()
            .map(|snapshot| snapshot.clone())
            .unwrap_or_else(|_| "null".into()),
        SOURCE_WARNING
            .lock()
            .map(|warning| warning.clone())
            .unwrap_or_else(|_| "null".into()),
        PENDING.load(std::sync::atomic::Ordering::Relaxed),
        SIDEBAR_THUMBNAILS.load(std::sync::atomic::Ordering::Relaxed),
        SIDEBAR_OUTLINE.load(std::sync::atomic::Ordering::Relaxed),
        SIDEBAR_BOOKMARKS.load(std::sync::atomic::Ordering::Relaxed),
        START_RECENTS
            .lock()
            .map(|paths| paths.clone())
            .unwrap_or_else(|_| "[]".into()),
        input_json(),
        find_json(),
        view_json(),
        TABS.lock()
            .map(|tabs| tabs.clone())
            .unwrap_or_else(|_| "[]".into()),
        TAB_MESSAGE
            .lock()
            .map(|message| message.clone())
            .unwrap_or_else(|_| "null".into()),
        PALETTE
            .lock()
            .map(|palette| palette.clone())
            .unwrap_or_else(|_| "{}".into()),
        controls_json(),
        chef_ui::motion::reduced(),
        settings_json(),
        message_json(),
        properties_json(),
        password_json(),
        scroll_progress_json(),
        crate::logging::recent().len()
    )
}

/// Các điều khiển của khung gần nhất (chef-ui `a11y`, D81): id, vai trò, tên, trạng thái, vị trí.
fn controls_json() -> String {
    let (scale, controls) = chef_ui::a11y::snapshot();
    let items: Vec<String> = controls
        .iter()
        .map(|c| {
            let bounds = match c.bounds {
                Some([x, y, w, h]) => format!("[{x},{y},{w},{h}]"),
                None => "null".into(),
            };
            let checked = c.checked.map_or("null".to_string(), json_str);
            let value = c.value.as_deref().map_or("null".to_string(), json_str);
            format!(
                "{{\"id\":{},\"role\":{},\"name\":{},\"disabled\":{},\"focused\":{},\"hovered\":{},\"checked\":{},\"value\":{},\"bounds\":{}}}",
                json_str(&c.id),
                json_str(c.role),
                json_str(&c.name),
                c.disabled,
                c.focused,
                c.hovered,
                checked,
                value,
                bounds
            )
        })
        .collect();
    format!("{{\"scale\":{scale},\"controls\":[{}]}}", items.join(","))
}

/// Xử lý một dòng lệnh đã qua kiểm token.
fn dispatch(line: &str, token: &str, hwnd: isize) -> String {
    let mut parts = line.splitn(2, ' ');
    let got = parts.next().unwrap_or("");
    if got != token {
        return "{\"ok\":false,\"error\":\"unauthorized\"}".into();
    }
    let rest = parts.next().unwrap_or("").trim();
    let (cmd, arg) = match rest.split_once(' ') {
        Some((c, a)) => (c, a.trim()),
        None => (rest, ""),
    };
    match cmd {
        "state" => state(hwnd),
        "screenshot" if !arg.is_empty() => match screenshot(hwnd, arg) {
            Ok(json) => json,
            Err(e) => format!("{{\"ok\":false,\"error\":{e:?}}}"),
        },
        "quit" => {
            std::process::exit(0);
        }
        // Gõ chuỗi như bàn phím (WM_CHAR cho từng đơn vị UTF-16). Không phải đường IME composition.
        "char" => {
            for unit in arg.encode_utf16() {
                // SAFETY: gửi thông điệp vào hàng đợi của cửa sổ GPUI còn sống.
                unsafe { PostMessageW(hwnd, WM_CHAR, unit as usize, 0x0001_0001) };
            }
            "{\"ok\":true}".into()
        }
        // Phím ảo (ví dụ 8 = Backspace, 37 = mũi tên trái), nhấn rồi nhả.
        "key" => match arg.parse::<usize>() {
            Ok(vk) => {
                // SAFETY: như trên.
                unsafe {
                    PostMessageW(hwnd, WM_KEYDOWN, vk, 0x0001_0001);
                    PostMessageW(hwnd, WM_KEYUP, vk, 0xC001_0001u32 as i32 as isize);
                }
                "{\"ok\":true}".into()
            }
            Err(_) => "{\"ok\":false,\"error\":\"mã phím không hợp lệ\"}".into(),
        },
        // Chuột trái trong tọa độ client (pixel vật lý): `mouse down|move|up <x> <y>`.
        "mouse" => {
            let mut parts = arg.split_whitespace();
            let kind = parts.next().unwrap_or("");
            let x = parts.next().and_then(|v| v.parse::<i32>().ok());
            let y = parts.next().and_then(|v| v.parse::<i32>().ok());
            let (msg, wparam) = match kind {
                "down" => (WM_LBUTTONDOWN, MK_LBUTTON),
                "move" => (WM_MOUSEMOVE, MK_LBUTTON),
                "up" => (WM_LBUTTONUP, 0),
                "rdown" => (WM_RBUTTONDOWN, MK_RBUTTON),
                "rup" => (WM_RBUTTONUP, 0),
                _ => return "{\"ok\":false,\"error\":\"mouse cần down, move hoặc up\"}".into(),
            };
            match (x, y) {
                (Some(x), Some(y)) => {
                    let lparam = (((y as u32 & 0xFFFF) << 16) | (x as u32 & 0xFFFF)) as isize;
                    // SAFETY: gửi thông điệp vào hàng đợi của cửa sổ GPUI còn sống.
                    unsafe { PostMessageW(hwnd, msg, wparam, lparam) };
                    "{\"ok\":true}".into()
                }
                _ => "{\"ok\":false,\"error\":\"mouse cần tọa độ x y\"}".into(),
            }
        }
        // Đưa một action vào hàng đợi; luồng GPUI sẽ chạy nó (xem ACTION_NAMES).
        "action" => {
            if !ACTION_NAMES.contains(&arg) {
                return format!("{{\"ok\":false,\"error\":\"action không hỗ trợ: {arg}\"}}");
            }
            if let Ok(mut queue) = ACTIONS.lock() {
                queue.push_back(arg.to_string());
            }
            "{\"ok\":true}".into()
        }
        "resetrendertiming" => {
            reset_render_timing();
            "{\"ok\":true}".into()
        }
        // Cuộn chính xác theo số viewport, chỉ có thể gọi qua pipe CHEF_E2E.
        "scrollscreens" => match arg.parse::<f32>() {
            Ok(screens) if screens.is_finite() && screens != 0.0 && screens.abs() <= 10_000.0 => {
                let Ok(mut progress) = SCROLL_PROGRESS.lock() else {
                    return "{\"ok\":false,\"error\":\"không khóa được trạng thái cuộn\"}".into();
                };
                if progress.2 {
                    return "{\"ok\":false,\"error\":\"đang có chuỗi cuộn chạy\"}".into();
                }
                if let Ok(mut queue) = SCROLL_SCREENS.lock() {
                    queue.push_back(screens);
                } else {
                    return "{\"ok\":false,\"error\":\"không khóa được hàng đợi cuộn\"}".into();
                }
                *progress = (screens.abs().ceil() as u32, 0, true);
                "{\"ok\":true}".into()
            }
            _ => "{\"ok\":false,\"error\":\"scrollscreens cần số hữu hạn trong phạm vi 10000\"}"
                .into(),
        },
        _ => format!("{{\"ok\":false,\"error\":\"lệnh không hỗ trợ: {cmd}\"}}"),
    }
}

/// Đọc đến dòng đầu tiên từ pipe (tối đa 4 KB).
fn read_line(pipe: isize) -> Option<String> {
    let mut out = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let mut read = 0u32;
        // SAFETY: đọc 1 byte vào bộ đệm có sẵn trên stack.
        let ok = unsafe { ReadFile(pipe, byte.as_mut_ptr(), 1, &mut read, std::ptr::null_mut()) };
        if ok == 0 || read == 0 {
            return None;
        }
        if byte[0] == b'\n' {
            break;
        }
        out.push(byte[0]);
        if out.len() > 4096 {
            return None;
        }
    }
    String::from_utf8(out).ok()
}

fn write_line(pipe: isize, text: &str) {
    let data = format!("{text}\n");
    let mut written = 0u32;
    // SAFETY: bộ đệm còn sống trong suốt lời gọi.
    unsafe {
        WriteFile(
            pipe,
            data.as_ptr(),
            data.len() as u32,
            &mut written,
            std::ptr::null_mut(),
        );
        FlushFileBuffers(pipe);
    }
}

/// Bật kênh debug nếu CHEF_E2E=1. `hwnd` là cửa sổ cần chụp/đọc trạng thái.
/// In tên pipe và token ra stderr để người chạy E2E lấy được.
pub fn start(hwnd: isize) -> Result<(), String> {
    if std::env::var("CHEF_E2E").as_deref() != Ok("1") {
        return Ok(());
    }
    let token = random_token()?;
    // SAFETY: lời gọi không nhận con trỏ nào từ bên ngoài.
    let pid = unsafe { GetCurrentProcessId() };
    let name = format!(r"\\.\pipe\chef-native-{pid}");
    eprintln!("CHEF_DEBUG_PIPE={name}");
    eprintln!("CHEF_DEBUG_TOKEN={token}");
    thread::Builder::new()
        .name("chef-debug-pipe".into())
        .spawn(move || {
            let wname = wide(&name);
            loop {
                // SAFETY: tên là chuỗi UTF-16 kết thúc bằng 0 còn sống trong vòng lặp.
                let pipe = unsafe {
                    CreateNamedPipeW(
                        wname.as_ptr(),
                        PIPE_ACCESS_DUPLEX,
                        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
                        PIPE_UNLIMITED_INSTANCES,
                        4096,
                        4096,
                        0,
                        std::ptr::null(),
                    )
                };
                if pipe == INVALID_HANDLE_VALUE {
                    eprintln!("CreateNamedPipeW lỗi, kênh debug dừng");
                    return;
                }
                // SAFETY: pipe vừa tạo, không dùng overlapped.
                unsafe { ConnectNamedPipe(pipe, std::ptr::null_mut()) };
                if let Some(line) = read_line(pipe) {
                    let reply = dispatch(&line, &token, hwnd);
                    write_line(pipe, &reply);
                }
                // SAFETY: đóng đúng handle đã mở ở trên.
                unsafe {
                    DisconnectNamedPipe(pipe);
                    CloseHandle(pipe);
                }
            }
        })
        .map_err(|e| format!("không tạo được luồng kênh debug: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{dispatch, json_str, take_actions, take_scroll_screens};

    #[test]
    fn wrong_token_is_rejected_before_any_command_runs() {
        // hwnd 0 không hợp lệ: nếu lệnh chạy, state() sẽ không trả JSON "unauthorized".
        let reply = dispatch("sai_token state", "dung_token", 0);
        assert_eq!(reply, "{\"ok\":false,\"error\":\"unauthorized\"}");
    }

    #[test]
    fn unknown_command_with_right_token_is_reported() {
        let reply = dispatch("dung_token nhay_mua", "dung_token", 0);
        assert!(
            reply.contains("lệnh không hỗ trợ: nhay_mua"),
            "trả lời: {reply}"
        );
    }

    #[test]
    fn screenshot_without_path_is_not_a_valid_command() {
        let reply = dispatch("dung_token screenshot", "dung_token", 0);
        assert!(reply.contains("lệnh không hỗ trợ"), "trả lời: {reply}");
    }

    #[test]
    fn json_escapes_quotes_and_controls_but_keeps_vietnamese() {
        assert_eq!(
            json_str("nói \"xin chào\"\n\\"),
            "\"nói \\\"xin chào\\\"\\n\\\\\""
        );
        assert_eq!(json_str("\u{1}"), "\"\\u0001\"");
        assert_eq!(json_str("Tiếng Việt"), "\"Tiếng Việt\"");
    }

    #[test]
    fn known_action_is_queued_and_unknown_one_is_refused() {
        let reply = dispatch("dung_token action selectleft", "dung_token", 0);
        assert_eq!(reply, "{\"ok\":true}");
        let reply = dispatch("dung_token action nhay_mua", "dung_token", 0);
        assert!(
            reply.contains("action không hỗ trợ: nhay_mua"),
            "trả lời: {reply}"
        );
        assert_eq!(take_actions(), vec!["selectleft".to_string()]);
        assert!(take_actions().is_empty());
    }

    #[test]
    fn scrollscreens_queues_finite_viewport_delta() {
        assert_eq!(
            dispatch("dung_token scrollscreens 350", "dung_token", 0),
            "{\"ok\":true}"
        );
        assert!(
            dispatch("dung_token scrollscreens -350", "dung_token", 0)
                .contains("đang có chuỗi cuộn")
        );
        assert_eq!(take_scroll_screens(), vec![350.0]);
        super::set_scroll_progress(350, 350, false);
        assert_eq!(
            dispatch("dung_token scrollscreens -350", "dung_token", 0),
            "{\"ok\":true}"
        );
        assert_eq!(take_scroll_screens(), vec![-350.0]);
        super::set_scroll_progress(350, 350, false);
        assert!(dispatch("dung_token scrollscreens 0", "dung_token", 0).contains("ok\":false"));
        assert!(dispatch("dung_token scrollscreens NaN", "dung_token", 0).contains("\"ok\":false"));
        assert!(take_scroll_screens().is_empty());
    }
}
