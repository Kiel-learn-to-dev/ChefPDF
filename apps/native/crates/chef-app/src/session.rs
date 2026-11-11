//! Mở phiên tài liệu (TASKS_RUST R3.05, BLUEPRINT_RUST §4 bước 2–3). Thao tác sửa đầu tiên gọi `session.open`
//! của lõi, sau khi kiểm vân tay file gốc (R3.04). Lõi tạo `rev-0000.pdf` và `meta.json` trong thư mục phiên.
//!
//! Mật khẩu đi từ bộ nhớ Rust (`Zeroizing`) tới lõi qua RPC, không ghi ra đĩa và không ghi log. Phía Rust, chuỗi
//! gửi đi là một bản sao tạm trong `serde_json::Value` và dòng JSON, nên không xóa được bằng zeroize; đây là hạn
//! chế đã ghi ở TASKS_RUST R3.05.

use std::path::Path;

use chef_rpc::{CallError, Supervisor};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::source_guard::{self, Fingerprint, Verdict};

/// Lỗi khi mở phiên.
#[derive(Debug, PartialEq, Eq)]
pub enum OpenError {
    /// File gốc đã đổi, mất hoặc không đọc được từ lúc mở. Không tạo phiên tự động.
    SourceChanged(Verdict),
    /// Lõi trả lỗi; `kind` là `ErrorKinds` của CONTRACTS, ví dụ `PASSWORD_REQUIRED`.
    Core { kind: String },
    /// Không liên lạc được lõi.
    Unavailable(String),
}

/// Phiên đã mở: id, trạng thái và thông tin tài liệu do lõi trả về.
#[derive(Debug, Clone, PartialEq)]
pub struct OpenedSession {
    pub session_id: String,
    pub state: Value,
    pub info: Value,
}

/// Mở `source` thành phiên mới. `guard` là vân tay lúc mở tài liệu (R3.04).
pub fn open(
    supervisor: &Supervisor,
    source: &Path,
    guard: &Fingerprint,
    password: Option<&Zeroizing<String>>,
) -> Result<OpenedSession, OpenError> {
    let verdict = source_guard::check(guard, source);
    if verdict != Verdict::Same {
        return Err(OpenError::SourceChanged(verdict));
    }
    let mut params = json!({ "path": source.display().to_string() });
    if let Some(password) = password {
        params["password"] = Value::String(password.as_str().to_string());
    }
    let reply = supervisor
        .request("session.open", &params)
        .map_err(map_call_error)?;
    let state = reply.get("state").cloned().unwrap_or(Value::Null);
    let session_id = state
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or_else(|| OpenError::Core {
            kind: "INTERNAL".into(),
        })?
        .to_string();
    Ok(OpenedSession {
        session_id,
        state,
        info: reply.get("info").cloned().unwrap_or(Value::Null),
    })
}

fn map_call_error(err: CallError) -> OpenError {
    match err {
        CallError::Rpc(error) => OpenError::Core {
            kind: error
                .pointer("/data/kind")
                .and_then(Value::as_str)
                .unwrap_or("UNKNOWN")
                .to_string(),
        },
        other => OpenError::Unavailable(format!("{other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chef_rpc::{CoreCommand, SupervisorConfig};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    const PASSWORD: &str = "giu-bi-mat-123";

    /// Thư mục tạm riêng cho mỗi test: chứa userData (có `sessions/`) và file PDF mẫu.
    struct Sandbox {
        root: PathBuf,
    }

    impl Sandbox {
        fn new(name: &str) -> Sandbox {
            let root =
                std::env::temp_dir().join(format!("chef-session-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(root.join("data")).expect("tạo thư mục dữ liệu");
            Sandbox { root }
        }

        fn data(&self) -> PathBuf {
            self.root.join("data")
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn core_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../core")
    }

    /// Tạo một PDF một trang, không mã hóa hoặc mã hóa với `PASSWORD`, bằng pikepdf của lõi.
    fn make_pdf(python: &Path, sandbox: &Sandbox, name: &str, encrypted: bool) -> PathBuf {
        let script = sandbox.root.join("make_pdf.py");
        fs::write(
            &script,
            "import sys, pikepdf\n\
             pdf = pikepdf.new()\n\
             pdf.add_blank_page()\n\
             if sys.argv[2] == '1':\n\
             \tpdf.save(sys.argv[1], encryption=pikepdf.Encryption(user=sys.argv[3], owner='chu-so-huu'))\n\
             else:\n\
             \tpdf.save(sys.argv[1])\n",
        )
        .expect("ghi script tạo PDF");
        let out = sandbox.root.join(name);
        let status = std::process::Command::new(python)
            .arg(&script)
            .arg(&out)
            .arg(if encrypted { "1" } else { "0" })
            .arg(PASSWORD)
            .current_dir(core_dir())
            .status()
            .expect("chạy python tạo PDF");
        assert!(status.success(), "tạo PDF mẫu thất bại");
        out
    }

    /// Lõi thật với userData riêng; `log` nhận mọi dòng nhật ký của lõi và của giám sát.
    fn start_core(sandbox: &Sandbox, log: Arc<Mutex<Vec<String>>>) -> Option<Supervisor> {
        let python = core_dir().join(".venv/Scripts/python.exe");
        if !python.exists() {
            eprintln!("bỏ qua: không có core/.venv");
            return None;
        }
        let command = CoreCommand {
            program: python,
            args: vec![
                "-m".into(),
                "chef_core".into(),
                "--data-dir".into(),
                sandbox.data().display().to_string(),
            ],
            cwd: core_dir(),
        };
        let sink = Arc::clone(&log);
        let mut config = SupervisorConfig::new(
            command,
            Arc::new(move |line: &str| sink.lock().unwrap().push(line.to_string())),
        );
        config.backoff_initial = Duration::from_millis(50);
        let sup = Supervisor::start(config);
        loop {
            match sup.events().recv_timeout(Duration::from_secs(60)) {
                Ok(chef_rpc::Event::Status(chef_rpc::CoreStatus::Ready)) => return Some(sup),
                Ok(_) => {}
                Err(_) => panic!("lõi không sẵn sàng"),
            }
        }
    }

    fn sessions_dir(sandbox: &Sandbox) -> PathBuf {
        sandbox.data().join("sessions")
    }

    /// Các tệp (đường dẫn) trong cây thư mục, để kiểm tra không có mật khẩu nằm trên đĩa.
    fn all_files(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                all_files(&path, out);
            } else {
                out.push(path);
            }
        }
    }

    #[test]
    fn open_plain_file_creates_session_with_rev0_and_meta() {
        let sandbox = Sandbox::new("plain");
        let python = core_dir().join(".venv/Scripts/python.exe");
        if !python.exists() {
            eprintln!("bỏ qua: không có core/.venv");
            return;
        }
        let pdf = make_pdf(&python, &sandbox, "plain.pdf", false);
        let guard = source_guard::fingerprint(&pdf).expect("vân tay");
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut sup = start_core(&sandbox, Arc::clone(&log)).expect("lõi");

        let opened = open(&sup, &pdf, &guard, None).expect("mở phiên");
        let dir = sessions_dir(&sandbox).join(&opened.session_id);
        assert!(dir.join("rev-0000.pdf").exists(), "thiếu rev-0000.pdf");
        assert!(dir.join("meta.json").exists(), "thiếu meta.json");
        assert_eq!(opened.info["pageCount"], 1);
        sup.shutdown(Duration::from_secs(5));
    }

    #[test]
    fn encrypted_file_needs_a_password_and_rejects_a_wrong_one() {
        let sandbox = Sandbox::new("password");
        let python = core_dir().join(".venv/Scripts/python.exe");
        if !python.exists() {
            eprintln!("bỏ qua: không có core/.venv");
            return;
        }
        let pdf = make_pdf(&python, &sandbox, "locked.pdf", true);
        let guard = source_guard::fingerprint(&pdf).expect("vân tay");
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut sup = start_core(&sandbox, Arc::clone(&log)).expect("lõi");

        assert_eq!(
            open(&sup, &pdf, &guard, None),
            Err(OpenError::Core {
                kind: "PASSWORD_REQUIRED".into()
            })
        );
        let wrong = Zeroizing::new("sai-mat-khau".to_string());
        assert_eq!(
            open(&sup, &pdf, &guard, Some(&wrong)),
            Err(OpenError::Core {
                kind: "PASSWORD_INVALID".into()
            })
        );
        sup.shutdown(Duration::from_secs(5));
    }

    #[test]
    fn right_password_opens_and_the_password_never_reaches_disk_or_log() {
        let sandbox = Sandbox::new("secret");
        let python = core_dir().join(".venv/Scripts/python.exe");
        if !python.exists() {
            eprintln!("bỏ qua: không có core/.venv");
            return;
        }
        let pdf = make_pdf(&python, &sandbox, "locked.pdf", true);
        let guard = source_guard::fingerprint(&pdf).expect("vân tay");
        let log = Arc::new(Mutex::new(Vec::new()));
        let mut sup = start_core(&sandbox, Arc::clone(&log)).expect("lõi");

        let password = Zeroizing::new(PASSWORD.to_string());
        let opened = open(&sup, &pdf, &guard, Some(&password)).expect("mở bằng đúng mật khẩu");
        assert!(
            sessions_dir(&sandbox)
                .join(&opened.session_id)
                .join("rev-0000.pdf")
                .exists()
        );
        sup.shutdown(Duration::from_secs(5));

        let mut files = Vec::new();
        all_files(&sandbox.data(), &mut files);
        for file in files {
            let bytes = fs::read(&file).unwrap_or_default();
            assert!(
                !bytes
                    .windows(PASSWORD.len())
                    .any(|w| w == PASSWORD.as_bytes()),
                "mật khẩu nằm trong {}",
                file.display()
            );
        }
        let lines = log.lock().unwrap().clone();
        assert!(
            lines.iter().all(|line| !line.contains(PASSWORD)),
            "mật khẩu xuất hiện trong nhật ký"
        );
    }

    #[test]
    fn changed_source_is_refused_before_any_session_is_created() {
        let sandbox = Sandbox::new("changed");
        let python = core_dir().join(".venv/Scripts/python.exe");
        if !python.exists() {
            eprintln!("bỏ qua: không có core/.venv");
            return;
        }
        let pdf = make_pdf(&python, &sandbox, "plain.pdf", false);
        let guard = source_guard::fingerprint(&pdf).expect("vân tay");
        // Đổi file gốc sau khi mở: kích thước đổi, nên vân tay khác.
        let mut bytes = fs::read(&pdf).expect("đọc");
        bytes.extend_from_slice(b"\n% sua ngoai app\n");
        fs::write(&pdf, &bytes).expect("ghi lại");

        let log = Arc::new(Mutex::new(Vec::new()));
        let mut sup = start_core(&sandbox, Arc::clone(&log)).expect("lõi");
        assert_eq!(
            open(&sup, &pdf, &guard, None),
            Err(OpenError::SourceChanged(Verdict::Changed))
        );
        let created = fs::read_dir(sessions_dir(&sandbox))
            .map(|d| d.count())
            .unwrap_or(0);
        assert_eq!(created, 0, "không được tạo phiên khi file gốc đã đổi");
        sup.shutdown(Duration::from_secs(5));
    }
}
