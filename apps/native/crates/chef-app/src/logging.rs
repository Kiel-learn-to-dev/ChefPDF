//! Nhật ký của bản native (TASKS_RUST R9.10, D-ghi ở NOTES): ghi ra `<userData>/logs/chef-native.log`,
//! xoay vòng khi file quá dung lượng, và giữ một bộ đệm trong RAM có trần (để kênh debug đọc gần nhất).
//!
//! Quy tắc: không ghi mật khẩu, nội dung tài liệu hay đường dẫn đầy đủ của tài liệu người dùng. Chỉ ghi
//! sự kiện và mã lỗi. Lời gọi `info` và `error` không chặn lâu: lỗi ghi file bị bỏ qua, không làm sập app.

use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Tên file nhật ký đang ghi.
pub const FILE_NAME: &str = "chef-native.log";
/// Dung lượng tối đa của một file trước khi xoay vòng.
pub const MAX_FILE_BYTES: u64 = 512 * 1024;
/// Số file cũ giữ lại (chef-native.log.1 … .N).
pub const KEEP_FILES: usize = 3;
/// Trần của bộ đệm RAM, tính theo byte nội dung.
pub const RAM_CAP_BYTES: usize = 64 * 1024;

struct Log {
    dir: PathBuf,
    ring: VecDeque<String>,
    ring_bytes: usize,
}

static LOG: OnceLock<Mutex<Log>> = OnceLock::new();

/// Bắt đầu ghi nhật ký vào `<dir>/logs`. Gọi một lần lúc khởi động; lần gọi sau bị bỏ qua.
pub fn init(dir: &Path) {
    let _ = LOG.set(Mutex::new(Log {
        dir: dir.join("logs"),
        ring: VecDeque::new(),
        ring_bytes: 0,
    }));
}

/// Ghi một dòng mức thông tin.
pub fn info(message: &str) {
    write_line("INFO", message);
}

/// Ghi một dòng mức lỗi.
pub fn error(message: &str) {
    write_line("ERROR", message);
}

/// Các dòng gần nhất trong bộ đệm RAM (cũ trước).
pub fn recent() -> Vec<String> {
    match LOG.get().and_then(|m| m.lock().ok()) {
        Some(log) => log.ring.iter().cloned().collect(),
        None => Vec::new(),
    }
}

fn write_line(level: &str, message: &str) {
    let Some(mutex) = LOG.get() else {
        return;
    };
    let Ok(mut log) = mutex.lock() else {
        return;
    };
    let line = format!("{} {level} {message}", timestamp());
    push_ring(&mut log, &line);
    let _ = append(&log.dir, &line);
}

/// Thêm dòng vào bộ đệm; bỏ dòng cũ nhất khi vượt trần.
fn push_ring(log: &mut Log, line: &str) {
    log.ring_bytes += line.len();
    log.ring.push_back(line.to_string());
    while log.ring_bytes > RAM_CAP_BYTES {
        match log.ring.pop_front() {
            Some(old) => log.ring_bytes -= old.len(),
            None => break,
        }
    }
}

fn append(dir: &Path, line: &str) -> std::io::Result<()> {
    fs::create_dir_all(dir)?;
    let path = dir.join(FILE_NAME);
    if fs::metadata(&path).map(|m| m.len()).unwrap_or(0) >= MAX_FILE_BYTES {
        rotate(dir)?;
    }
    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    writeln!(file, "{line}")
}

/// chef-native.log → .1, .1 → .2 … và bỏ file quá số lượng giữ lại.
pub fn rotate(dir: &Path) -> std::io::Result<()> {
    let numbered = |n: usize| dir.join(format!("{FILE_NAME}.{n}"));
    let _ = fs::remove_file(numbered(KEEP_FILES));
    for n in (1..KEEP_FILES).rev() {
        if numbered(n).exists() {
            fs::rename(numbered(n), numbered(n + 1))?;
        }
    }
    let current = dir.join(FILE_NAME);
    if current.exists() {
        fs::rename(current, numbered(1))?;
    }
    Ok(())
}

fn timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> TempDir {
            let dir =
                std::env::temp_dir().join(format!("chef-log-test-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("tạo thư mục tạm");
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn ram_buffer_never_exceeds_its_cap() {
        let mut log = Log {
            dir: PathBuf::new(),
            ring: VecDeque::new(),
            ring_bytes: 0,
        };
        let line = "x".repeat(1000);
        for _ in 0..500 {
            push_ring(&mut log, &line);
            assert!(log.ring_bytes <= RAM_CAP_BYTES);
        }
        assert!(!log.ring.is_empty());
        assert_eq!(
            log.ring.iter().map(String::len).sum::<usize>(),
            log.ring_bytes
        );
    }

    #[test]
    fn file_rotates_and_keeps_only_the_configured_number_of_old_files() {
        let tmp = TempDir::new("rotate");
        let dir = tmp.0.join("logs");
        fs::create_dir_all(&dir).unwrap();
        // Điền nhiều lần vượt trần file để tạo nhiều đời file.
        let big = "y".repeat(1024 * 100);
        for generation in 0..(KEEP_FILES + 2) {
            fs::write(dir.join(FILE_NAME), format!("đời {generation}\n{big}")).unwrap();
            rotate(&dir).unwrap();
        }
        assert!(
            !dir.join(FILE_NAME).exists(),
            "file đang ghi đã được chuyển đi"
        );
        for n in 1..=KEEP_FILES {
            assert!(
                dir.join(format!("{FILE_NAME}.{n}")).exists(),
                "thiếu file .{n}"
            );
        }
        assert!(!dir.join(format!("{FILE_NAME}.{}", KEEP_FILES + 1)).exists());
        // File .1 là đời gần nhất.
        let newest = fs::read_to_string(dir.join(format!("{FILE_NAME}.1"))).unwrap();
        assert!(newest.starts_with(&format!("đời {}", KEEP_FILES + 1)));
    }

    #[test]
    fn append_writes_a_line_and_rotates_when_full() {
        let tmp = TempDir::new("append");
        let dir = tmp.0.join("logs");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(FILE_NAME), vec![b'a'; MAX_FILE_BYTES as usize]).unwrap();
        append(&dir, "dòng mới").unwrap();
        assert!(dir.join(format!("{FILE_NAME}.1")).exists());
        let now = fs::read_to_string(dir.join(FILE_NAME)).unwrap();
        assert_eq!(now.trim_end(), "dòng mới");
    }
}
