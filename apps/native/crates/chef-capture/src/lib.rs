//! Chụp qua điện thoại (TASKS_RUST R8.07, R8.08; FEATURES L5, I19): máy chủ HTTP tạm trong tiến trình, chỉ sống
//! khi một phiên chụp chạy. Port `apps/desktop/src/main/capture.ts`. Quy tắc (giao diện và điện thoại không
//! lách được):
//! - gắn vào MỘT địa chỉ IPv4 LAN riêng (10/8, 172.16/12, 192.168/16), cổng ngẫu nhiên;
//! - mọi đường dẫn cần token dùng một lần; sai token chỉ nhận 404 trần;
//! - tải lên chỉ nhận image/jpeg, image/png, image/webp, byte đầu phải khớp, thân <= 25 MB, tối đa `max_pages` file;
//! - tối đa 5 yêu cầu mỗi giây mỗi phiên; không CORS, không cookie, `Cache-Control: no-store`;
//! - file do máy chủ đặt tên (`NNN.ext`) trong `<captureRoot>/<phiên>/`;
//! - phiên dứt khi `stop()`, khi bấm xong, sau 10 phút hoặc khi thoát app; máy chủ luôn được đóng.
//!
//! Token chỉ nằm trong `url` và không bao giờ ghi nhật ký. Mọi phụ thuộc (giao diện mạng, đồng hồ, nơi phát sự
//! kiện) được tiêm vào để test. Trang điện thoại (`assets/capture.html`) mới thử trên trình duyệt máy tính.
//!
//! Máy chủ xử lý yêu cầu tuần tự trên một luồng, nên không cần hàng đợi ghi.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::thread::JoinHandle;
use std::time::Duration;

use qrcode::render::svg;
use qrcode::{EcLevel, QrCode};
use tiny_http::{Header, Method, Request, Response, Server};

pub const CAPTURE_TIMEOUT_MS: u64 = 10 * 60_000;
pub const CAPTURE_MAX_BODY_BYTES: u64 = 25 * 1024 * 1024;
pub const CAPTURE_DEFAULT_MAX_PAGES: u32 = 200;
pub const CAPTURE_MAX_PAGES: u32 = 500;
pub const CAPTURE_RATE_PER_SECOND: usize = 5;
const TOKEN_BYTES: usize = 16;

/// CSP của trang điện thoại (`GET /c/<token>`).
pub const CAPTURE_PAGE_CSP: &str = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src blob: data:; connect-src 'self'";

/// Trang điện thoại.
pub const CAPTURE_PAGE_HTML: &str = include_str!("../assets/capture.html");

// ---------- Kiểu dùng chung ----------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureError {
    NoLanInterface,
    InterfaceNotFound,
    InvalidRequest(String),
    Io(String),
}

impl CaptureError {
    pub fn code(&self) -> &'static str {
        match self {
            CaptureError::NoLanInterface => "NO_LAN_INTERFACE",
            CaptureError::InterfaceNotFound => "INTERFACE_NOT_FOUND",
            CaptureError::InvalidRequest(_) => "INVALID_REQUEST",
            CaptureError::Io(_) => "IO",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    Book,
    Signature,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureState {
    Idle,
    Active,
    Stopped,
    Done,
    Expired,
}

impl CaptureState {
    pub fn as_str(self) -> &'static str {
        match self {
            CaptureState::Idle => "idle",
            CaptureState::Active => "active",
            CaptureState::Stopped => "stopped",
            CaptureState::Done => "done",
            CaptureState::Expired => "expired",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureStatus {
    pub state: CaptureState,
    pub count: usize,
    pub expires_at: Option<u64>,
}

/// Một địa chỉ của máy, như `if-addrs` báo (đã phẳng).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetIface {
    pub name: String,
    pub address: String,
    pub is_ipv4: bool,
    pub internal: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LanInterface {
    pub name: String,
    pub address: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartOptions {
    pub purpose: Purpose,
    pub max_pages: u32,
    pub interface_name: Option<String>,
}

/// Sự kiện gửi cho giao diện.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Status {
        state: CaptureState,
        count: usize,
        expires_at: u64,
    },
    Image {
        index: usize,
        path: PathBuf,
    },
}

#[derive(Debug, Clone)]
pub struct StartResult {
    pub session_id: String,
    pub url: String,
    pub qr_svg: String,
    pub expires_at: u64,
    pub interfaces: Vec<LanInterface>,
}

// ---------- Hàm thuần ----------

/// IPv4 riêng: 10/8, 172.16/12, 192.168/16.
pub fn is_private_lan_ipv4(address: &str) -> bool {
    let parts: Vec<&str> = address.split('.').collect();
    if parts.len() != 4
        || parts
            .iter()
            .any(|p| p.is_empty() || p.len() > 3 || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return false;
    }
    let n: Vec<u32> = parts.iter().map(|p| p.parse().unwrap_or(999)).collect();
    if n.iter().any(|o| *o > 255) {
        return false;
    }
    n[0] == 10 || (n[0] == 172 && (16..=31).contains(&n[1])) || (n[0] == 192 && n[1] == 168)
}

/// Địa chỉ IPv4 riêng của giao diện không phải loopback (link-local 169.254/16 bị loại).
pub fn lan_interfaces(list: &[NetIface]) -> Vec<LanInterface> {
    list.iter()
        .filter(|i| !i.internal && i.is_ipv4 && is_private_lan_ipv4(&i.address))
        .map(|i| LanInterface {
            name: i.name.clone(),
            address: i.address.clone(),
        })
        .collect()
}

/// Giao diện để gắn: cái LAN đầu tiên, hoặc cái tên `name`.
pub fn choose_lan_interface(
    list: &[NetIface],
    name: Option<&str>,
) -> Result<LanInterface, CaptureError> {
    let lan = lan_interfaces(list);
    let first = lan.first().cloned().ok_or(CaptureError::NoLanInterface)?;
    match name {
        None => Ok(first),
        Some(n) => lan
            .into_iter()
            .find(|i| i.name == n)
            .ok_or(CaptureError::InterfaceNotFound),
    }
}

/// Giao diện mạng của máy này (đọc từ hệ điều hành).
pub fn system_interfaces() -> Vec<NetIface> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .map(|i| {
            let ip = i.ip();
            NetIface {
                name: i.name.clone(),
                address: ip.to_string(),
                is_ipv4: matches!(ip, IpAddr::V4(_)),
                internal: i.is_loopback(),
            }
        })
        .collect()
}

/// Token 128 bit dạng hex (32 ký tự) từ bộ sinh số ngẫu nhiên của hệ điều hành.
pub fn new_token() -> String {
    let mut b = [0u8; TOKEN_BYTES];
    getrandom::fill(&mut b).expect("hệ điều hành cấp được số ngẫu nhiên");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// So token trong thời gian không đổi.
pub fn token_matches(given: &str, expected: &str) -> bool {
    let (a, b) = (given.as_bytes(), expected.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageExt {
    Jpg,
    Png,
    Webp,
}

impl ImageExt {
    pub fn as_str(self) -> &'static str {
        match self {
            ImageExt::Jpg => "jpg",
            ImageExt::Png => "png",
            ImageExt::Webp => "webp",
        }
    }
}

/// Đuôi cho Content-Type được nhận (bỏ tham số), hoặc None.
pub fn extension_for_content_type(content_type: Option<&str>) -> Option<ImageExt> {
    match content_type?
        .split(';')
        .next()?
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "image/jpeg" => Some(ImageExt::Jpg),
        "image/png" => Some(ImageExt::Png),
        "image/webp" => Some(ImageExt::Webp),
        _ => None,
    }
}

/// Định dạng ảnh theo byte đầu (JPEG, PNG, WebP). HEIC không nhận.
pub fn sniff_image(b: &[u8]) -> Option<ImageExt> {
    if b.len() >= 3 && b[..3] == [0xff, 0xd8, 0xff] {
        return Some(ImageExt::Jpg);
    }
    if b.len() >= 8 && b[..8] == [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] {
        return Some(ImageExt::Png);
    }
    if b.len() >= 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        return Some(ImageExt::Webp);
    }
    None
}

/// Kiểm yêu cầu bắt đầu từ giao diện. `max_pages` mặc định 200, tối đa 500.
pub fn parse_start_options(
    purpose: &str,
    max_pages: Option<i64>,
    interface_name: Option<&str>,
) -> Result<StartOptions, CaptureError> {
    let bad = |m: &str| CaptureError::InvalidRequest(m.to_string());
    let purpose = match purpose {
        "book" => Purpose::Book,
        "signature" => Purpose::Signature,
        _ => return Err(bad("purpose must be book or signature")),
    };
    let max = max_pages.unwrap_or(i64::from(CAPTURE_DEFAULT_MAX_PAGES));
    if !(1..=i64::from(CAPTURE_MAX_PAGES)).contains(&max) {
        return Err(bad("maxPages must be an integer from 1 to 500"));
    }
    if interface_name.is_some_and(|n| n.chars().count() > 128) {
        return Err(bad("interfaceName must be a short string"));
    }
    Ok(StartOptions {
        purpose,
        max_pages: max as u32,
        interface_name: interface_name.map(String::from),
    })
}

fn xml_escape(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '&' | '<' | '>' | '"' | '\'' => format!("&#{};", c as u32),
            _ => c.to_string(),
        })
        .collect()
}

/// Mã QR của `text` dạng SVG (sửa lỗi mức M). Chữ cũng là `<title>` của SVG (đọc màn hình, kiểm payload).
pub fn qr_svg_for(text: &str) -> Result<String, CaptureError> {
    let code = QrCode::with_error_correction_level(text.as_bytes(), EcLevel::M)
        .map_err(|e| CaptureError::Io(format!("QR: {e}")))?;
    let svg = code
        .render::<svg::Color>()
        .min_dimensions(200, 200)
        .quiet_zone(true)
        .build();
    let i = svg
        .find("<svg")
        .ok_or_else(|| CaptureError::Io("QR: không có thẻ svg".into()))?;
    let end = svg[i..]
        .find('>')
        .map(|k| i + k + 1)
        .ok_or_else(|| CaptureError::Io("QR: svg hỏng".into()))?;
    Ok(format!(
        "{}<title>{}</title>{}",
        &svg[i..end],
        xml_escape(text),
        &svg[end..]
    ))
}

/// Đường dẫn hợp lệ: `/c|u|d/<token 32 hex>`, không query. Trả (loại, token).
pub fn parse_route(url: &str) -> Option<(char, &str)> {
    let rest = url.strip_prefix('/')?;
    let (kind, token) = rest.split_once('/')?;
    let kind = match kind {
        "c" => 'c',
        "u" => 'u',
        "d" => 'd',
        _ => return None,
    };
    (token.len() == 32
        && token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    .then_some((kind, token))
}

/// Tên file máy chủ đặt: `001.jpg` cho ảnh đầu tiên.
pub fn image_file_name(index: usize, ext: ImageExt) -> String {
    format!("{:03}.{}", index + 1, ext.as_str())
}

// ---------- Máy chủ ----------

type Emit = Arc<dyn Fn(Event) + Send + Sync>;

/// Phụ thuộc tiêm vào.
pub struct CaptureDeps {
    /// Giao diện mạng của máy (`system_interfaces` khi chạy thật).
    pub interfaces: Box<dyn Fn() -> Vec<NetIface> + Send + Sync>,
    /// Đè địa chỉ gắn (và URL). Chỉ cho test và E2E.
    pub bind_host: Option<String>,
    /// `<userData>/cache/capture`.
    pub capture_root: PathBuf,
    /// HTML trang điện thoại.
    pub page_html: String,
    pub new_session_id: Box<dyn Fn() -> String + Send + Sync>,
    /// Đồng hồ, ms.
    pub now: Arc<dyn Fn() -> u64 + Send + Sync>,
    pub emit: Emit,
    pub max_body_bytes: u64,
}

impl CaptureDeps {
    /// Bản chạy thật: giao diện hệ thống, đồng hồ hệ thống, trang đóng gói sẵn.
    pub fn system(capture_root: PathBuf, emit: Emit) -> CaptureDeps {
        CaptureDeps {
            interfaces: Box::new(system_interfaces),
            bind_host: None,
            capture_root,
            page_html: CAPTURE_PAGE_HTML.to_string(),
            new_session_id: Box::new(new_token),
            now: Arc::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_millis() as u64)
            }),
            emit,
            max_body_bytes: CAPTURE_MAX_BODY_BYTES,
        }
    }
}

struct Shared {
    state: CaptureState,
    images: Vec<PathBuf>,
}

struct Active {
    id: String,
    expires_at: u64,
    /// Yếu: luồng làm việc giữ tham chiếu mạnh duy nhất, nên khi nó dứt thì cổng được đóng ngay.
    server: Weak<Server>,
    stop: Arc<AtomicBool>,
    shared: Arc<Mutex<Shared>>,
    worker: Option<JoinHandle<()>>,
}

pub struct CaptureService {
    deps: Arc<CaptureDeps>,
    session: Mutex<Option<Active>>,
    swept: AtomicBool,
}

/// Lý do vòng lặp dứt.
#[derive(Clone, Copy)]
enum End {
    Stopped,
    Done,
    Expired,
}

struct Worker {
    server: Arc<Server>,
    stop: Arc<AtomicBool>,
    shared: Arc<Mutex<Shared>>,
    deps: Arc<CaptureDeps>,
    token: String,
    dir: PathBuf,
    max_pages: usize,
    expires_at: u64,
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("header hợp lệ")
}

fn respond(req: Request, status: u16, body: &str, content_type: &str, extra: &[(&str, &str)]) {
    let mut r = Response::from_string(body)
        .with_status_code(status)
        .with_header(header("Content-Type", content_type))
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("X-Content-Type-Options", "nosniff"))
        .with_header(header("Referrer-Policy", "no-referrer"));
    for (k, v) in extra {
        r = r.with_header(header(k, v));
    }
    let _ = req.respond(r);
}

fn json(req: Request, status: u16, body: &str) {
    respond(req, status, body, "application/json; charset=utf-8", &[]);
}

fn not_found(req: Request) {
    respond(req, 404, "Not found", "text/plain; charset=utf-8", &[]);
}

fn header_of(req: &Request, name: &str) -> Option<String> {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

impl Worker {
    fn run(self) {
        let mut recent: Vec<u64> = Vec::new();
        // Chỉ số của khách (X-Chef-Index) -> kết quả đã trả: lần gửi lại không ghi hai lần.
        let mut by_client: HashMap<u32, Result<usize, &'static str>> = HashMap::new();
        let end = loop {
            if self.stop.load(Ordering::SeqCst) {
                break End::Stopped;
            }
            if (self.deps.now)() >= self.expires_at {
                break End::Expired;
            }
            let req = match self.server.recv_timeout(Duration::from_millis(50)) {
                Ok(Some(r)) => r,
                Ok(None) => continue,
                Err(_) => break End::Stopped,
            };
            if self.handle(req, &mut recent, &mut by_client) {
                break End::Done;
            }
        };
        let (state, count) = {
            let mut s = self.shared.lock().expect("khóa phiên");
            s.state = match end {
                End::Stopped => CaptureState::Stopped,
                End::Done => CaptureState::Done,
                End::Expired => CaptureState::Expired,
            };
            (s.state, s.images.len())
        };
        (self.deps.emit)(Event::Status {
            state,
            count,
            expires_at: self.expires_at,
        });
    }

    /// Xử lý một yêu cầu. Trả true khi khách báo xong (`/d/<token>`).
    fn handle(
        &self,
        req: Request,
        recent: &mut Vec<u64>,
        by_client: &mut HashMap<u32, Result<usize, &'static str>>,
    ) -> bool {
        let url = req.url().to_string();
        let Some((kind, token)) = parse_route(&url) else {
            not_found(req);
            return false;
        };
        if !token_matches(token, &self.token) {
            not_found(req);
            return false;
        }
        let want = if kind == 'c' {
            Method::Get
        } else {
            Method::Post
        };
        if *req.method() != want {
            not_found(req);
            return false;
        }
        let now = (self.deps.now)();
        recent.retain(|t| now.saturating_sub(*t) < 1000);
        if recent.len() >= CAPTURE_RATE_PER_SECOND {
            respond(
                req,
                429,
                "{\"error\":\"rate\"}",
                "application/json; charset=utf-8",
                &[("Retry-After", "1")],
            );
            return false;
        }
        recent.push(now);
        match kind {
            'c' => {
                respond(
                    req,
                    200,
                    &self.deps.page_html,
                    "text/html; charset=utf-8",
                    &[("Content-Security-Policy", CAPTURE_PAGE_CSP)],
                );
                false
            }
            'd' => {
                let count = self.shared.lock().expect("khóa phiên").images.len();
                json(req, 200, &format!("{{\"count\":{count}}}"));
                true
            }
            _ => {
                self.receive(req, by_client);
                false
            }
        }
    }

    fn receive(&self, mut req: Request, by_client: &mut HashMap<u32, Result<usize, &'static str>>) {
        let Some(ext) = extension_for_content_type(header_of(&req, "Content-Type").as_deref())
        else {
            return json(req, 415, "{\"error\":\"type\"}");
        };
        let client_index = header_of(&req, "X-Chef-Index")
            .filter(|h| (1..=4).contains(&h.len()) && h.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|h| h.parse::<u32>().ok());
        let Some(client_index) = client_index else {
            return json(req, 400, "{\"error\":\"index\"}");
        };
        let max = self.deps.max_body_bytes;
        if req.body_length().is_some_and(|n| n as u64 > max) {
            return respond(
                req,
                413,
                "{\"error\":\"size\"}",
                "application/json; charset=utf-8",
                &[("Connection", "close")],
            );
        }
        let mut body = Vec::new();
        if req
            .as_reader()
            .take(max + 1)
            .read_to_end(&mut body)
            .is_err()
        {
            return json(req, 400, "{\"error\":\"body\"}");
        }
        if body.len() as u64 > max {
            return respond(
                req,
                413,
                "{\"error\":\"size\"}",
                "application/json; charset=utf-8",
                &[("Connection", "close")],
            );
        }
        if let Some(known) = by_client.get(&client_index) {
            return match known {
                Ok(i) => json(req, 200, &format!("{{\"index\":{i}}}")),
                Err(e) => json(req, 500, &format!("{{\"error\":\"{e}\"}}")),
            };
        }
        if sniff_image(&body) != Some(ext) {
            return json(req, 415, "{\"error\":\"content\"}");
        }
        let index = self.shared.lock().expect("khóa phiên").images.len();
        if index >= self.max_pages {
            return json(req, 409, "{\"error\":\"limit\"}");
        }
        let target = self.dir.join(image_file_name(index, ext));
        let written = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .and_then(|mut f| std::io::Write::write_all(&mut f, &body));
        if written.is_err() {
            let _ = fs::remove_file(&target);
            return json(req, 500, "{\"error\":\"write\"}");
        }
        self.shared
            .lock()
            .expect("khóa phiên")
            .images
            .push(target.clone());
        by_client.insert(client_index, Ok(index));
        (self.deps.emit)(Event::Image {
            index,
            path: target,
        });
        json(req, 200, &format!("{{\"index\":{index}}}"));
    }
}

impl CaptureService {
    pub fn new(deps: CaptureDeps) -> CaptureService {
        CaptureService {
            deps: Arc::new(deps),
            session: Mutex::new(None),
            swept: AtomicBool::new(false),
        }
    }

    /// Bắt đầu một phiên. Phiên đang chạy bị dừng trước: mỗi lúc chỉ một phiên.
    pub fn start(&self, opts: &StartOptions) -> Result<StartResult, CaptureError> {
        self.stop(None);
        let list = (self.deps.interfaces)();
        let iface = choose_lan_interface(&list, opts.interface_name.as_deref())?;
        let host = self
            .deps
            .bind_host
            .clone()
            .unwrap_or_else(|| iface.address.clone());
        self.sweep_stale();
        let id = (self.deps.new_session_id)();
        let dir = self.deps.capture_root.join(&id);
        fs::create_dir_all(&dir).map_err(|e| CaptureError::Io(e.to_string()))?;

        let server =
            Server::http(format!("{host}:0")).map_err(|e| CaptureError::Io(e.to_string()))?;
        let port = server
            .server_addr()
            .to_ip()
            .map(|a| a.port())
            .ok_or_else(|| CaptureError::Io("không lấy được cổng".into()))?;
        let server = Arc::new(server);
        let server_weak = Arc::downgrade(&server);
        let token = new_token();
        let expires_at = (self.deps.now)() + CAPTURE_TIMEOUT_MS;
        let stop = Arc::new(AtomicBool::new(false));
        let shared = Arc::new(Mutex::new(Shared {
            state: CaptureState::Active,
            images: Vec::new(),
        }));
        let worker = Worker {
            server,
            stop: stop.clone(),
            shared: shared.clone(),
            deps: self.deps.clone(),
            token: token.clone(),
            dir,
            max_pages: opts.max_pages as usize,
            expires_at,
        };
        let handle = std::thread::Builder::new()
            .name("chef-capture".into())
            .spawn(move || worker.run())
            .map_err(|e| CaptureError::Io(e.to_string()))?;
        let url = format!("http://{host}:{port}/c/{token}");
        let qr_svg = qr_svg_for(&url)?;
        *self.session.lock().expect("khóa dịch vụ") = Some(Active {
            id: id.clone(),
            expires_at,
            server: server_weak,
            stop,
            shared,
            worker: Some(handle),
        });
        (self.deps.emit)(Event::Status {
            state: CaptureState::Active,
            count: 0,
            expires_at,
        });
        Ok(StartResult {
            session_id: id,
            url,
            qr_svg,
            expires_at,
            interfaces: lan_interfaces(&list),
        })
    }

    /// Dừng phiên đang chạy (không làm gì khi rảnh). File đã nhận ở lại trên đĩa cho người gọi.
    pub fn stop(&self, session_id: Option<&str>) {
        let taken = {
            let mut g = self.session.lock().expect("khóa dịch vụ");
            match g.as_ref() {
                Some(a) if session_id.is_none_or(|s| s == a.id) => g.take(),
                _ => None,
            }
        };
        if let Some(mut a) = taken {
            a.stop.store(true, Ordering::SeqCst);
            if let Some(srv) = a.server.upgrade() {
                srv.unblock();
            }
            if let Some(h) = a.worker.take() {
                let _ = h.join();
            }
        }
    }

    pub fn status(&self) -> CaptureStatus {
        let g = self.session.lock().expect("khóa dịch vụ");
        match g.as_ref() {
            None => CaptureStatus {
                state: CaptureState::Idle,
                count: 0,
                expires_at: None,
            },
            Some(a) => {
                let s = a.shared.lock().expect("khóa phiên");
                // Phiên đã dứt (đã xong hoặc hết hạn) nhưng chưa được dọn: báo đúng trạng thái cuối.
                CaptureStatus {
                    state: s.state,
                    count: s.images.len(),
                    expires_at: Some(a.expires_at),
                }
            }
        }
    }

    /// File đã nhận của phiên hiện tại, theo thứ tự nhận.
    pub fn received(&self) -> Vec<PathBuf> {
        self.session
            .lock()
            .expect("khóa dịch vụ")
            .as_ref()
            .map(|a| a.shared.lock().expect("khóa phiên").images.clone())
            .unwrap_or_default()
    }

    /// Xóa thư mục của phiên cũ (không bao giờ phiên đang chạy). Chỉ làm một lần mỗi tiến trình.
    fn sweep_stale(&self) {
        if self.swept.swap(true, Ordering::SeqCst) {
            return;
        }
        remove_children(&self.deps.capture_root);
    }
}

impl Drop for CaptureService {
    fn drop(&mut self) {
        self.stop(None);
    }
}

fn remove_children(dir: &Path) {
    if let Ok(entries) = fs::read_dir(dir) {
        for e in entries.flatten() {
            let _ = fs::remove_dir_all(e.path());
        }
    }
}

#[cfg(test)]
mod tests;
