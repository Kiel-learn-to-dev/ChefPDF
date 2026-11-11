//! Dấu vết file gốc và cảnh báo khi file đổi (TASKS_RUST R3.04, BLUEPRINT_RUST §4 bước 1 và 3).
//!
//! Khi mở file, app ghi vân tay gồm kích thước, mtime và băm 64 KB đầu và cuối. Trước thao tác sửa đầu tiên
//! (lúc tạo phiên, R3.05), app kiểm lại. Nếu file đã đổi bên ngoài, app cảnh báo và không tạo phiên tự động.
//! Hàm ở đây là thuần, không đụng giao diện. Hộp thoại cảnh báo được nối ở R3.05.

use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::time::SystemTime;

/// Số byte đầu và cuối được băm (BLUEPRINT_RUST §4).
pub const EDGE_BYTES: u64 = 64 * 1024;

/// Vân tay của file gốc tại lúc mở.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fingerprint {
    pub size: u64,
    pub modified: Option<SystemTime>,
    pub head: u64,
    pub tail: u64,
}

/// Kết quả kiểm lại file gốc.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Không đổi: có thể tạo phiên.
    Same,
    /// Đã đổi (kích thước, mtime hoặc nội dung đầu/cuối).
    Changed,
    /// Không còn ở đường dẫn cũ.
    Missing,
    /// Có file nhưng không đọc được (ví dụ đang bị khóa).
    Unreadable,
}

/// Băm FNV-1a 64 bit. Đủ để phát hiện thay đổi; không dùng cho bảo mật.
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

/// Đọc vân tay của file hiện tại.
pub fn fingerprint(path: &Path) -> io::Result<Fingerprint> {
    let mut file = File::open(path)?;
    let meta = file.metadata()?;
    let size = meta.len();
    let modified = meta.modified().ok();

    let head_len = size.min(EDGE_BYTES) as usize;
    let mut head_buf = vec![0u8; head_len];
    file.read_exact(&mut head_buf)?;

    let tail_len = size.min(EDGE_BYTES) as usize;
    file.seek(SeekFrom::Start(size - tail_len as u64))?;
    let mut tail_buf = vec![0u8; tail_len];
    file.read_exact(&mut tail_buf)?;

    Ok(Fingerprint {
        size,
        modified,
        head: fnv1a(&head_buf),
        tail: fnv1a(&tail_buf),
    })
}

/// So vân tay lúc mở với file hiện tại.
pub fn check(before: &Fingerprint, path: &Path) -> Verdict {
    match fingerprint(path) {
        Ok(now) if now == *before => Verdict::Same,
        Ok(_) => Verdict::Changed,
        Err(err) if err.kind() == io::ErrorKind::NotFound => Verdict::Missing,
        Err(_) => Verdict::Unreadable,
    }
}

/// Nội dung cảnh báo tiếng Việt (CONTRACTS và i18n: khóa mới, xem NOTES D87).
pub mod text {
    pub const CHANGED_TITLE: &str = "File gốc đã thay đổi";
    pub const CHANGED_BODY: &str = "File này đã được sửa hoặc thay thế bên ngoài Chef PDF từ lúc bạn mở. Chef PDF chưa tạo phiên làm việc cho file này, nên thao tác sẽ áp lên bản mới. Hãy xem lại file, hoặc mở lại để dùng bản hiện có.";
    pub const MISSING_BODY: &str =
        "Không tìm thấy file gốc ở vị trí cũ. Hãy kiểm tra file đã bị đổi tên hoặc xóa chưa.";
    pub const UNREADABLE_BODY: &str =
        "Không đọc được file gốc. File có thể đang bị chương trình khác khóa.";
    /// Nút: giữ tài liệu hiện tại để kiểm tra lại.
    pub const REVIEW: &str = "Xem lại";
    /// Nút: đọc lại file từ đĩa.
    pub const REOPEN: &str = "Mở lại";
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    struct TempFile(PathBuf);

    impl TempFile {
        fn new(name: &str, bytes: &[u8]) -> TempFile {
            let path = std::env::temp_dir().join(format!(
                "chef-source-guard-{name}-{}.pdf",
                std::process::id()
            ));
            fs::write(&path, bytes).expect("ghi file tạm");
            TempFile(path)
        }
    }

    impl Drop for TempFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }

    #[test]
    fn unchanged_file_is_the_same() {
        let file = TempFile::new("same", b"%PDF-1.7 noi dung");
        let before = fingerprint(&file.0).expect("vân tay");
        assert_eq!(check(&before, &file.0), Verdict::Same);
    }

    #[test]
    fn change_in_the_first_bytes_is_detected() {
        let file = TempFile::new("head", &vec![b'a'; 200 * 1024]);
        let before = fingerprint(&file.0).expect("vân tay");
        let mut bytes = vec![b'a'; 200 * 1024];
        bytes[0] = b'b';
        fs::write(&file.0, &bytes).expect("ghi lại");
        assert_eq!(check(&before, &file.0), Verdict::Changed);
    }

    #[test]
    fn change_in_the_last_bytes_is_detected() {
        let file = TempFile::new("tail", &vec![b'a'; 1024 * 1024]);
        let before = fingerprint(&file.0).expect("vân tay");
        let mut bytes = vec![b'a'; 1024 * 1024];
        let last = bytes.len() - 1;
        bytes[last] = b'z';
        fs::write(&file.0, &bytes).expect("ghi lại");
        assert_eq!(check(&before, &file.0), Verdict::Changed);
    }

    #[test]
    fn size_change_is_detected() {
        let file = TempFile::new("size", b"abc");
        let before = fingerprint(&file.0).expect("vân tay");
        fs::write(&file.0, b"abcd").expect("ghi lại");
        assert_eq!(check(&before, &file.0), Verdict::Changed);
    }

    #[test]
    fn deleted_file_is_missing() {
        let file = TempFile::new("gone", b"abc");
        let before = fingerprint(&file.0).expect("vân tay");
        fs::remove_file(&file.0).expect("xóa");
        assert_eq!(check(&before, &file.0), Verdict::Missing);
    }

    #[test]
    fn only_the_edges_are_hashed() {
        // File 1 MB: đổi byte ở giữa không đổi băm đầu và cuối (chỉ mtime báo đổi). Đây là giới hạn có
        // chủ ý của BLUEPRINT §4: băm toàn file quá tốn cho file lớn.
        let size = 1024 * 1024;
        let file = TempFile::new("middle", &vec![b'a'; size]);
        let before = fingerprint(&file.0).expect("vân tay");
        let mut bytes = vec![b'a'; size];
        bytes[size / 2] = b'z';
        let mut copy = fs::File::create(&file.0).expect("mở để ghi");
        io::Write::write_all(&mut copy, &bytes).expect("ghi");
        drop(copy);
        let after = fingerprint(&file.0).expect("vân tay sau khi sửa");
        assert_eq!(before.head, after.head);
        assert_eq!(before.tail, after.tail);
    }
}
