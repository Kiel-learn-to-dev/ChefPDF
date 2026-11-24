//! Di chuyển dữ liệu từ bản Electron (TASKS_RUST R9.09, D73, FEATURES A4).
//!
//! Bản Rust dùng chung thư mục userData với Electron, nên không có bước sao chép: file này chỉ **kiểm tra**
//! thư mục đó và trả báo cáo để giao diện hiện thông báo lần đầu. Quy tắc:
//! - `settings.json` có hiệu lực ngay (đã do `settings.rs` đọc);
//! - `sessions/` chứa phiên dở: mở được và khôi phục theo R3.13;
//! - `library/` giữ nguyên;
//! - `secrets.json` là ciphertext của `safeStorage` (DPAPI). **Không đọc nội dung**, chỉ kiểm sự tồn tại
//!   và dung lượng bằng `metadata`; người dùng nhập lại mật khẩu PFX và khóa thư viện chữ ký một lần.
//!
//! Logic thuần, không phụ thuộc GPUI.
#![allow(dead_code)]

use std::fs;
use std::path::Path;

use crate::recovery::has_unclosed_sessions;

/// Thông báo di chuyển.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MigrationNotice {
    /// Nhập lại mật khẩu PFX và khóa thư viện chữ ký (không giải mã `safeStorage`).
    SecretsReenter,
}

/// Kết quả kiểm tra thư mục userData của Electron.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MigrationReport {
    /// Có `settings.json` (cài đặt cũ sẽ có hiệu lực ngay).
    pub has_settings: bool,
    /// Có thư mục `sessions/` với ít nhất một phiên chưa đóng.
    pub has_unclosed_sessions: bool,
    /// Có thư mục `library/` (mẫu chữ ký, quy trình, ảnh chữ ký).
    pub has_library: bool,
    /// Có `secrets.json` không rỗng: cần nhập lại mật khẩu PFX và khóa thư viện chữ ký.
    pub needs_secret_reentry: bool,
}

impl MigrationReport {
    /// Có gì từ Electron để báo người dùng không (thư mục trống hoặc chưa từng dùng Electron thì không).
    pub fn is_empty(&self) -> bool {
        !self.has_settings
            && !self.has_unclosed_sessions
            && !self.has_library
            && !self.needs_secret_reentry
    }

    /// Có cần hiện thông báo lần đầu không: chỉ khi có bí mật phải nhập lại.
    pub fn should_notify(&self) -> bool {
        self.needs_secret_reentry
    }

    /// Thông báo cần hiện lần đầu. Chuỗi i18n gắn khi làm giao diện (không thêm khóa vào `vi.json`/`en.json`
    /// ở đây vì hai file đó giữ nguyên văn với bản Electron).
    pub fn notice(&self) -> Option<MigrationNotice> {
        self.needs_secret_reentry
            .then_some(MigrationNotice::SecretsReenter)
    }
}

fn non_empty_file(path: &Path) -> bool {
    // Chỉ `metadata`: tuyệt đối không mở file để đọc ciphertext (R9.09 tiêu chí 3).
    fs::metadata(path)
        .map(|m| m.is_file() && m.len() > 0)
        .unwrap_or(false)
}

/// Kiểm tra `user_data_dir` (chỉ đọc metadata, không sửa gì).
pub fn inspect(user_data_dir: &Path) -> MigrationReport {
    MigrationReport {
        has_settings: non_empty_file(&user_data_dir.join("settings.json")),
        has_unclosed_sessions: has_unclosed_sessions(user_data_dir),
        has_library: user_data_dir.join("library").is_dir(),
        needs_secret_reentry: non_empty_file(&user_data_dir.join("secrets.json")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("chef-migrate-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const SID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn empty_dir_reports_nothing() {
        let dir = temp_dir("empty");
        let r = inspect(&dir);
        assert!(r.is_empty());
        assert!(!r.should_notify());
        assert_eq!(r.notice(), None);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_dir_is_empty_not_an_error() {
        let dir = std::env::temp_dir().join("chef-migrate-does-not-exist-xyz");
        assert!(inspect(&dir).is_empty());
    }

    #[test]
    fn electron_dir_is_detected_and_secrets_flagged() {
        let dir = temp_dir("electron");
        fs::write(dir.join("settings.json"), r#"{"theme":"dark"}"#).unwrap();
        fs::create_dir_all(dir.join("library").join("workflows")).unwrap();
        let session = dir.join("sessions").join(SID);
        fs::create_dir_all(&session).unwrap();
        fs::write(session.join("meta.json"), r#"{"closed":false}"#).unwrap();
        fs::write(
            dir.join("secrets.json"),
            "not even json: must never be parsed",
        )
        .unwrap();

        let r = inspect(&dir);
        assert!(r.has_settings);
        assert!(r.has_unclosed_sessions);
        assert!(r.has_library);
        assert!(r.needs_secret_reentry);
        assert!(r.should_notify());
        assert_eq!(r.notice(), Some(MigrationNotice::SecretsReenter));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn closed_sessions_and_empty_secrets_do_not_notify() {
        let dir = temp_dir("closed");
        let session = dir.join("sessions").join(SID);
        fs::create_dir_all(&session).unwrap();
        fs::write(session.join("meta.json"), r#"{"closed":true}"#).unwrap();
        fs::write(dir.join("secrets.json"), "").unwrap();
        let r = inspect(&dir);
        assert!(!r.has_unclosed_sessions);
        assert!(!r.needs_secret_reentry);
        assert!(!r.should_notify());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn secrets_content_is_never_read() {
        // File không đọc được (thư mục tên secrets.json) vẫn không làm panic và không tính là bí mật.
        let dir = temp_dir("dir-secrets");
        fs::create_dir_all(dir.join("secrets.json")).unwrap();
        assert!(!inspect(&dir).needs_secret_reentry);
        let _ = fs::remove_dir_all(&dir);
    }
}
