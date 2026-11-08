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
use std::time::Duration;

const PIPE_ACCESS_DUPLEX: u32 = 0x0000_0003;
const PIPE_TYPE_BYTE: u32 = 0x0000_0000;
const PIPE_READMODE_BYTE: u32 = 0x0000_0000;
const PIPE_WAIT: u32 = 0x0000_0000;
const PIPE_UNLIMITED_INSTANCES: u32 = 255;
const INVALID_HANDLE_VALUE: isize = -1;
const BI_RGB: u32 = 0;

/// Số lần GPUI gọi `render` từ khi khởi động. Đọc qua lệnh `state` để đo số vòng vẽ (R1.08).
static RENDERS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Gọi mỗi lần `render` của cửa sổ.
pub fn count_render() {
    RENDERS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
}

/// Số trang đang có ảnh trong cache và số yêu cầu render đang chờ, do viewer cập nhật.
static CACHED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static PENDING: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn set_viewer_stats(cached: usize, pending: usize) {
    CACHED.store(cached as u64, std::sync::atomic::Ordering::Relaxed);
    PENDING.store(pending as u64, std::sync::atomic::Ordering::Relaxed);
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
    fn PostMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> i32;
}

const WM_KEYDOWN: u32 = 0x0100;
const WM_KEYUP: u32 = 0x0101;
const WM_CHAR: u32 = 0x0102;

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
    format!(
        "{{\"visible\":{visible},\"rect\":{{\"left\":{},\"top\":{},\"right\":{},\"bottom\":{}}},\"rectOk\":{ok},\"renders\":{},\"cached\":{},\"pending\":{}}}",
        rect.left,
        rect.top,
        rect.right,
        rect.bottom,
        RENDERS.load(std::sync::atomic::Ordering::Relaxed),
        CACHED.load(std::sync::atomic::Ordering::Relaxed),
        PENDING.load(std::sync::atomic::Ordering::Relaxed)
    )
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
    use super::dispatch;

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
}
