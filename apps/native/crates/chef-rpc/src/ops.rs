//! Thao tác, job, hoàn tác và lưu (TASKS_RUST R3.08, R3.11, R3.12; CONTRACTS §4 và §6). Mọi hàm đi qua
//! `Supervisor`. `ops.run` trả `jobId` ngay; kết quả đến sau qua thông báo `job.finished`, `job.failed` hoặc
//! `job.cancelled`, và `wait_job` đọc chúng từ kênh sự kiện.
//!
//! Lưu ý: `wait_job` bỏ qua mọi sự kiện không thuộc job đang chờ. Đây là đường đơn giản cho đến khi JobPanel
//! (R3.09) có vòng sự kiện riêng.

use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::client::{CallError, Notification};
use crate::supervisor::{Event, Supervisor};

/// Kết thúc của một job, theo thông báo của lõi.
#[derive(Debug, Clone, PartialEq)]
pub enum JobEnd {
    /// `result`: `{ state, changedPages, warnings, outputs, data? }`.
    Finished(Value),
    /// `error`: đối tượng lỗi JSON-RPC (`{ code, message, data: { kind } }`).
    Failed(Value),
    Cancelled,
    /// Hết thời gian chờ mà job chưa kết thúc.
    TimedOut,
    /// Kênh sự kiện đã đóng (giám sát đã dừng).
    Stopped,
}

/// Gửi `ops.run`, trả `jobId`. Lỗi kiểm tham số (ví dụ `INVALID_PARAMS`) trả về ngay ở đây.
pub fn start(
    sup: &Supervisor,
    op_id: &str,
    session_id: Option<&str>,
    params: &Value,
) -> Result<String, CallError> {
    let mut request = json!({ "opId": op_id, "params": params });
    if let Some(session_id) = session_id {
        request["sessionId"] = json!(session_id);
    }
    let reply = sup.request("ops.run", &request)?;
    reply
        .get("jobId")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| CallError::Rpc(json!({ "message": "ops.run không trả jobId" })))
}

/// Chờ job `job_id` kết thúc, tối đa `timeout`.
pub fn wait_job(events: &Receiver<Event>, job_id: &str, timeout: Duration) -> JobEnd {
    let deadline = Instant::now() + timeout;
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        match events.recv_timeout(left) {
            Ok(Event::Notification(Notification { method, params }))
                if params.get("jobId").and_then(Value::as_str) == Some(job_id) =>
            {
                match method.as_str() {
                    "job.finished" => {
                        return JobEnd::Finished(
                            params.get("result").cloned().unwrap_or(Value::Null),
                        );
                    }
                    "job.failed" => {
                        return JobEnd::Failed(params.get("error").cloned().unwrap_or(Value::Null));
                    }
                    "job.cancelled" => return JobEnd::Cancelled,
                    _ => {}
                }
            }
            Ok(_) => {}
            Err(RecvTimeoutError::Timeout) => return JobEnd::TimedOut,
            Err(RecvTimeoutError::Disconnected) => return JobEnd::Stopped,
        }
    }
}

/// Hủy job (hợp tác): job kết thúc bằng `job.cancelled`. Job không tồn tại trả `null`, không lỗi.
pub fn cancel(sup: &Supervisor, job_id: &str) -> Result<(), CallError> {
    sup.request("jobs.cancel", &json!({ "jobId": job_id }))
        .map(|_| ())
}

/// Hoàn tác một bước. Kết quả có `state` và `changedPages`.
pub fn undo(sup: &Supervisor, session_id: &str) -> Result<Value, CallError> {
    sup.request("session.undo", &json!({ "sessionId": session_id }))
}

/// Làm lại một bước.
pub fn redo(sup: &Supervisor, session_id: &str) -> Result<Value, CallError> {
    sup.request("session.redo", &json!({ "sessionId": session_id }))
}

/// Lưu revision hiện tại. Không có `path` thì ghi đè file gốc.
pub fn save(sup: &Supervisor, session_id: &str, path: Option<&str>) -> Result<Value, CallError> {
    let mut params = json!({ "sessionId": session_id });
    if let Some(path) = path {
        params["path"] = json!(path);
    }
    sup.request("session.save", &params)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::errors::{kind_of, message_key};
    use crate::{CoreCommand, SupervisorConfig};
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::Arc;

    fn core_dir() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../core")
    }

    fn python() -> Option<PathBuf> {
        let python = core_dir().join(".venv/Scripts/python.exe");
        python.exists().then_some(python)
    }

    /// Thư mục tạm riêng: userData của lõi và các file mẫu.
    struct Sandbox(PathBuf);

    impl Sandbox {
        fn new(name: &str) -> Sandbox {
            let root = std::env::temp_dir().join(format!("chef-ops-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(root.join("data")).expect("tạo thư mục");
            Sandbox(root)
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// Chạy một đoạn Python có sẵn pikepdf của lõi, với đối số là các đường dẫn.
    fn run_py(python: &Path, script: &str, args: &[&Path]) -> String {
        // Tên duy nhất cho mỗi lần chạy: các test chạy song song trong cùng một tiến trình.
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let file = std::env::temp_dir().join(format!("chef-ops-{}-{n}.py", std::process::id()));
        fs::write(&file, script).expect("ghi script");
        let out = Command::new(python)
            .arg(&file)
            .args(args)
            .current_dir(core_dir())
            .output()
            .expect("chạy python");
        let _ = fs::remove_file(&file);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    fn make_pdf(python: &Path, path: &Path, pages: u32) {
        run_py(
            python,
            "import sys, pikepdf\npdf = pikepdf.new()\nfor _ in range(int(sys.argv[2])): pdf.add_blank_page()\npdf.save(sys.argv[1])\n",
            &[path, Path::new(&pages.to_string())],
        );
    }

    fn start_core(sandbox: &Sandbox) -> Supervisor {
        let command = CoreCommand {
            program: python().expect("core/.venv"),
            args: vec![
                "-m".into(),
                "chef_core".into(),
                "--data-dir".into(),
                sandbox.0.join("data").display().to_string(),
            ],
            cwd: core_dir(),
        };
        let config = SupervisorConfig::new(command, Arc::new(|_: &str| {}));
        let sup = Supervisor::start(config);
        loop {
            match sup.events().recv_timeout(Duration::from_secs(60)) {
                Ok(Event::Status(crate::CoreStatus::Ready)) => return sup,
                Ok(_) => {}
                Err(_) => panic!("lõi không sẵn sàng"),
            }
        }
    }

    /// Mở file vào phiên, trả `sessionId`.
    fn open_session(sup: &Supervisor, pdf: &Path) -> String {
        let reply = sup
            .request(
                "session.open",
                &json!({ "path": pdf.display().to_string() }),
            )
            .expect("session.open");
        reply["state"]["sessionId"]
            .as_str()
            .expect("sessionId")
            .to_string()
    }

    /// Góc xoay (`/Rotate`) và số trang của file, đọc bằng pikepdf.
    fn rotate_and_pages(python: &Path, pdf: &Path) -> (i64, i64) {
        let out = run_py(
            python,
            "import sys, pikepdf\npdf = pikepdf.open(sys.argv[1])\nprint(int(pdf.pages[0].get('/Rotate', 0)), len(pdf.pages))\n",
            &[pdf],
        );
        let mut parts = out.split_whitespace().map(|v| v.parse::<i64>().unwrap());
        (parts.next().unwrap(), parts.next().unwrap())
    }

    fn expect_finished(sup: &Supervisor, job_id: &str) -> Value {
        match wait_job(sup.events(), job_id, Duration::from_secs(60)) {
            JobEnd::Finished(result) => result,
            other => panic!("job phải kết thúc tốt, được {other:?}"),
        }
    }

    #[test]
    fn rotate_runs_as_a_job_and_undo_redo_follow() {
        let Some(python) = python() else {
            eprintln!("bỏ qua: không có core/.venv");
            return;
        };
        let sandbox = Sandbox::new("rotate");
        let pdf = sandbox.0.join("two.pdf");
        make_pdf(&python, &pdf, 2);
        let mut sup = start_core(&sandbox);
        let session = open_session(&sup, &pdf);

        let job = start(
            &sup,
            "page.rotate",
            Some(&session),
            &json!({ "pages": [0], "angle": 90 }),
        )
        .expect("ops.run");
        let result = expect_finished(&sup, &job);
        assert_eq!(result["changedPages"], json!([0]));
        assert_eq!(result["state"]["revision"], 1);
        assert_eq!(result["state"]["canUndo"], true);

        // Trang đổi thật: rev-0001 có /Rotate 90 ở trang 0, vẫn còn 2 trang.
        let rev1 = sandbox
            .0
            .join("data/sessions")
            .join(&session)
            .join("rev-0001.pdf");
        assert_eq!(rotate_and_pages(&python, &rev1), (90, 2));

        let undone = undo(&sup, &session).expect("session.undo");
        assert_eq!(undone["state"]["revision"], 0);
        assert_eq!(undone["state"]["canRedo"], true);
        let redone = redo(&sup, &session).expect("session.redo");
        assert_eq!(redone["state"]["revision"], 1);
        sup.shutdown(Duration::from_secs(5));
    }

    #[test]
    fn invalid_angle_is_refused_with_invalid_params_and_a_vietnamese_key() {
        let Some(python) = python() else {
            eprintln!("bỏ qua: không có core/.venv");
            return;
        };
        let sandbox = Sandbox::new("invalid");
        let pdf = sandbox.0.join("one.pdf");
        make_pdf(&python, &pdf, 1);
        let mut sup = start_core(&sandbox);
        let session = open_session(&sup, &pdf);

        let err = start(
            &sup,
            "page.rotate",
            Some(&session),
            &json!({ "pages": [0], "angle": 45 }),
        )
        .expect_err("góc 45 phải bị từ chối");
        match err {
            CallError::Rpc(error) => {
                let kind = kind_of(&error);
                assert_eq!(kind, "INVALID_PARAMS", "{error}");
                assert_eq!(message_key(kind), "errors.INVALID_PARAMS");
            }
            other => panic!("cần lỗi RPC, được {other:?}"),
        }
        sup.shutdown(Duration::from_secs(5));
    }

    #[test]
    fn save_writes_the_rotated_revision_to_a_new_file() {
        let Some(python) = python() else {
            eprintln!("bỏ qua: không có core/.venv");
            return;
        };
        let sandbox = Sandbox::new("save");
        let pdf = sandbox.0.join("one.pdf");
        make_pdf(&python, &pdf, 1);
        let mut sup = start_core(&sandbox);
        let session = open_session(&sup, &pdf);
        let job = start(
            &sup,
            "page.rotate",
            Some(&session),
            &json!({ "pages": [0], "angle": 180 }),
        )
        .expect("ops.run");
        expect_finished(&sup, &job);

        let out = sandbox.0.join("saved.pdf");
        let saved = save(&sup, &session, Some(&out.display().to_string())).expect("session.save");
        assert_eq!(saved["dirty"], false);
        assert!(out.exists(), "file lưu phải tồn tại");
        assert_eq!(rotate_and_pages(&python, &out), (180, 1));
        // File gốc không đổi.
        assert_eq!(rotate_and_pages(&python, &pdf), (0, 1));
        sup.shutdown(Duration::from_secs(5));
    }
}
