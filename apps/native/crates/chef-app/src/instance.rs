//! Per-user single-instance IPC for forwarding PDF paths to the existing GPUI window (R2.17).

use std::path::{Path, PathBuf};

const PROTOCOL_VERSION: u64 = 1;
const MAX_REQUEST_BYTES: usize = 128 * 1024;
const MAX_PATHS: usize = 512;

fn identity_hash(identity: &Path) -> String {
    // Stable FNV-1a: the endpoint remains identical across app launches. The user-data directory
    // distinguishes users and lets isolated E2E runs use their own single-instance namespace.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in identity.to_string_lossy().to_lowercase().bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn pipe_name(identity: &Path) -> String {
    format!(r"\\.\pipe\ChefPdf-{}", identity_hash(identity))
}

fn mutex_name(identity: &Path) -> String {
    format!(r"Local\ChefPdf-{}", identity_hash(identity))
}

fn encode_paths(paths: &[PathBuf]) -> Result<String, String> {
    if paths.len() > MAX_PATHS {
        return Err(format!("tối đa {MAX_PATHS} đường dẫn mỗi lần mở"));
    }
    let strings: Vec<String> = paths
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    let request = serde_json::json!({ "version": PROTOCOL_VERSION, "paths": strings });
    let encoded = request.to_string();
    if encoded.len() > MAX_REQUEST_BYTES {
        return Err("danh sách đường dẫn vượt giới hạn IPC".into());
    }
    Ok(encoded)
}

fn decode_paths(encoded: &str) -> Result<Vec<PathBuf>, String> {
    if encoded.len() > MAX_REQUEST_BYTES {
        return Err("yêu cầu IPC vượt giới hạn".into());
    }
    let value: serde_json::Value =
        serde_json::from_str(encoded).map_err(|error| format!("JSON IPC không hợp lệ: {error}"))?;
    if value.get("version").and_then(serde_json::Value::as_u64) != Some(PROTOCOL_VERSION) {
        return Err("phiên bản giao thức IPC không được hỗ trợ".into());
    }
    let paths = value
        .get("paths")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| "yêu cầu IPC thiếu danh sách paths".to_string())?;
    if paths.len() > MAX_PATHS {
        return Err(format!("tối đa {MAX_PATHS} đường dẫn mỗi lần mở"));
    }
    paths
        .iter()
        .map(|path| {
            let path = path
                .as_str()
                .filter(|path| !path.is_empty() && path.len() <= 32 * 1024)
                .ok_or_else(|| "đường dẫn IPC rỗng hoặc quá dài".to_string())?;
            Ok(PathBuf::from(path))
        })
        .collect()
}

#[cfg(windows)]
pub struct InstanceServer {
    mutex: isize,
    paths: std::sync::mpsc::Receiver<Vec<PathBuf>>,
}

#[cfg(windows)]
impl InstanceServer {
    pub fn try_recv(&self) -> Result<Vec<PathBuf>, std::sync::mpsc::TryRecvError> {
        self.paths.try_recv()
    }
}

#[cfg(windows)]
impl Drop for InstanceServer {
    fn drop(&mut self) {
        // SAFETY: this process owns the mutex handle returned by CreateMutexW.
        unsafe { CloseHandle(self.mutex) };
    }
}

#[cfg(windows)]
pub enum LaunchInstance {
    Primary(InstanceServer),
    Forwarded,
}

/// Claim this user's app instance or forward the initial paths to the existing process.
#[cfg(windows)]
pub fn start(paths: Vec<PathBuf>, user_data_dir: &Path) -> Result<LaunchInstance, String> {
    let paths = crate::drop::absolute_paths(paths);
    let mutex_name: Vec<u16> = mutex_name(user_data_dir)
        .encode_utf16()
        .chain([0])
        .collect();
    // SAFETY: valid NUL-terminated name; null security attributes use the current user's default
    // DACL. This named mutex is an atomic existence marker; it is retained but never owned, so its
    // lifetime does not depend on which thread later drops the handle.
    let mutex = unsafe { CreateMutexW(std::ptr::null_mut(), 0, mutex_name.as_ptr()) };
    if mutex == 0 {
        return Err("không tạo được mutex single-instance".into());
    }
    // SAFETY: reads the error from the immediately preceding CreateMutexW call.
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        // SAFETY: this second process does not own the existing mutex handle.
        unsafe { CloseHandle(mutex) };
        send_paths(&pipe_name(user_data_dir), &paths)?;
        return Ok(LaunchInstance::Forwarded);
    }

    let (tx, rx) = std::sync::mpsc::channel();
    let name = pipe_name(user_data_dir);
    if let Err(error) = std::thread::Builder::new()
        .name("chef-instance-pipe".into())
        .spawn(move || listen(name, tx))
    {
        // SAFETY: this process owns the mutex handle.
        unsafe { CloseHandle(mutex) };
        return Err(format!("không tạo được luồng IPC: {error}"));
    }
    Ok(LaunchInstance::Primary(InstanceServer { mutex, paths: rx }))
}

#[cfg(windows)]
const ERROR_ALREADY_EXISTS: u32 = 183;
#[cfg(windows)]
const ERROR_PIPE_CONNECTED: u32 = 535;
#[cfg(windows)]
const INVALID_HANDLE_VALUE: isize = -1;

#[cfg(windows)]
const PIPE_ACCESS_DUPLEX: u32 = 0x0000_0003;
#[cfg(windows)]
const PIPE_TYPE_BYTE: u32 = 0x0000_0000;
#[cfg(windows)]
const PIPE_READMODE_BYTE: u32 = 0x0000_0000;
#[cfg(windows)]
const PIPE_WAIT: u32 = 0x0000_0000;
#[cfg(windows)]
const PIPE_REJECT_REMOTE_CLIENTS: u32 = 0x0000_0008;
#[cfg(windows)]
const PIPE_UNLIMITED_INSTANCES: u32 = 255;
#[cfg(windows)]
const GENERIC_READ: u32 = 0x8000_0000;
#[cfg(windows)]
const GENERIC_WRITE: u32 = 0x4000_0000;
#[cfg(windows)]
const OPEN_EXISTING: u32 = 3;

#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateMutexW(
        attributes: *const std::ffi::c_void,
        initial_owner: i32,
        name: *const u16,
    ) -> isize;
    fn GetLastError() -> u32;
    fn CloseHandle(handle: isize) -> i32;
    fn CreateNamedPipeW(
        name: *const u16,
        open_mode: u32,
        pipe_mode: u32,
        max_instances: u32,
        out_buffer_size: u32,
        in_buffer_size: u32,
        default_timeout: u32,
        attributes: *const std::ffi::c_void,
    ) -> isize;
    fn ConnectNamedPipe(pipe: isize, overlapped: *mut std::ffi::c_void) -> i32;
    fn WaitNamedPipeW(name: *const u16, timeout: u32) -> i32;
    fn CreateFileW(
        name: *const u16,
        desired_access: u32,
        share_mode: u32,
        attributes: *mut std::ffi::c_void,
        creation_disposition: u32,
        flags: u32,
        template: isize,
    ) -> isize;
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}

#[cfg(windows)]
fn from_handle(handle: isize) -> std::fs::File {
    use std::os::windows::io::{FromRawHandle, RawHandle};
    // SAFETY: the Win32 API returned a valid owned handle which is transferred to File.
    unsafe { std::fs::File::from_raw_handle(handle as RawHandle) }
}

#[cfg(windows)]
fn listen(name: String, tx: std::sync::mpsc::Sender<Vec<PathBuf>>) {
    use std::io::{BufRead, BufReader, BufWriter, Read, Write};

    loop {
        let wide_name = wide(&name);
        // SAFETY: valid name and documented byte-mode pipe arguments. A null security descriptor
        // applies the primary process token's default DACL; remote clients are rejected explicitly.
        let pipe = unsafe {
            CreateNamedPipeW(
                wide_name.as_ptr(),
                PIPE_ACCESS_DUPLEX,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                4096,
                4096,
                0,
                std::ptr::null(),
            )
        };
        if pipe == INVALID_HANDLE_VALUE {
            return;
        }
        // SAFETY: `pipe` was just created and is not overlapped.
        let connected = unsafe { ConnectNamedPipe(pipe, std::ptr::null_mut()) } != 0
            // SAFETY: GetLastError follows ConnectNamedPipe.
            || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
        if !connected {
            // SAFETY: closes the unconnected pipe handle.
            unsafe { CloseHandle(pipe) };
            continue;
        }

        let file = from_handle(pipe);
        let Ok(writer_file) = file.try_clone() else {
            continue;
        };
        let mut reader = BufReader::new(file);
        let mut line = String::new();
        let read_result = reader
            .by_ref()
            .take((MAX_REQUEST_BYTES + 1) as u64)
            .read_line(&mut line);
        let response = match read_result {
            Ok(bytes) if bytes <= MAX_REQUEST_BYTES => match decode_paths(line.trim_end()) {
                Ok(paths) => match tx.send(paths) {
                    Ok(()) => serde_json::json!({"ok":true}).to_string(),
                    Err(_) => {
                        serde_json::json!({"ok":false,"error":"cửa sổ chính đã đóng"}).to_string()
                    }
                },
                Err(error) => serde_json::json!({"ok":false,"error":error}).to_string(),
            },
            Ok(_) => serde_json::json!({"ok":false,"error":"yêu cầu IPC quá dài"}).to_string(),
            Err(error) => serde_json::json!({"ok":false,"error":error.to_string()}).to_string(),
        };
        let mut writer = BufWriter::new(writer_file);
        let _ = writeln!(writer, "{response}");
        let _ = writer.flush();
        drop(writer);
        // Dropping both owned File handles closes the pipe instance and disconnects the client.
        drop(reader);
    }
}

#[cfg(windows)]
fn send_paths(name: &str, paths: &[PathBuf]) -> Result<(), String> {
    use std::io::{BufRead, BufReader, Write};
    use std::time::{Duration, Instant};

    let request = encode_paths(paths)?;
    let wide_name = wide(name);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        // SAFETY: waits on a NUL-terminated pipe name from this module.
        unsafe { WaitNamedPipeW(wide_name.as_ptr(), 500) };
        // SAFETY: requests a duplex connection to the existing local endpoint.
        let handle = unsafe {
            CreateFileW(
                wide_name.as_ptr(),
                GENERIC_READ | GENERIC_WRITE,
                0,
                std::ptr::null_mut(),
                OPEN_EXISTING,
                0,
                0,
            )
        };
        if handle != INVALID_HANDLE_VALUE {
            let mut writer = from_handle(handle);
            writer
                .write_all(request.as_bytes())
                .and_then(|_| writer.write_all(b"\n"))
                .and_then(|_| writer.flush())
                .map_err(|error| format!("gửi yêu cầu mở file thất bại: {error}"))?;
            let reader_file = writer
                .try_clone()
                .map_err(|error| format!("đọc phản hồi IPC thất bại: {error}"))?;
            let mut reader = BufReader::new(reader_file);
            let mut response = String::new();
            reader
                .read_line(&mut response)
                .map_err(|error| format!("đọc phản hồi IPC thất bại: {error}"))?;
            let response: serde_json::Value = serde_json::from_str(&response)
                .map_err(|error| format!("phản hồi IPC không hợp lệ: {error}"))?;
            if response.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
                return Ok(());
            }
            return Err(response
                .get("error")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("yêu cầu IPC bị từ chối")
                .to_string());
        }
        if Instant::now() >= deadline {
            return Err("không kết nối được cửa sổ Chef PDF đang chạy".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{decode_paths, encode_paths, identity_hash, mutex_name, pipe_name};
    use std::path::PathBuf;

    #[test]
    fn ipc_round_trips_multiple_unicode_paths_structurally() {
        let paths = vec![
            PathBuf::from(r"C:\Hồ sơ\báo cáo.pdf"),
            PathBuf::from(r"D:\Tài liệu\mẫu #2.pdf"),
        ];
        let request = encode_paths(&paths).unwrap();
        assert!(request.contains("Hồ sơ"));
        assert_eq!(decode_paths(&request).unwrap(), paths);
    }

    #[test]
    fn ipc_rejects_invalid_versions_and_oversized_batches() {
        assert!(decode_paths(r#"{"version":2,"paths":[]}"#).is_err());
        let many = vec![PathBuf::from("a.pdf"); 513];
        assert!(encode_paths(&many).is_err());
    }

    #[test]
    fn per_user_endpoint_is_stable_and_separates_user_data_directories() {
        let first = PathBuf::from(r"C:\Users\Lan\AppData\Roaming\Chef PDF");
        let same = PathBuf::from(r"c:\users\lan\appdata\roaming\chef pdf");
        let other = PathBuf::from(r"C:\Users\Minh\AppData\Roaming\Chef PDF");
        assert_eq!(identity_hash(&first), identity_hash(&same));
        assert_ne!(identity_hash(&first), identity_hash(&other));
        assert!(pipe_name(&first).starts_with(r"\\.\pipe\ChefPdf-"));
        assert!(mutex_name(&first).starts_with(r"Local\ChefPdf-"));
    }
}
