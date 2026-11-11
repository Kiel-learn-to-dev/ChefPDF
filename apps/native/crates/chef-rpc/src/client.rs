//! Client JSON-RPC tới lõi Python (TASKS_RUST R3.01, R3.02, BLUEPRINT_RUST §3). Một luồng đọc nền nhận các
//! dòng từ lõi: phản hồi được trả cho đúng yêu cầu theo `id`, thông báo đẩy vào kênh cho UI, dòng hỏng
//! được bỏ qua và đếm lại. Yêu cầu có thời gian chờ. Trên Windows, `spawn` đưa lõi vào Job Object để dừng
//! cả cây tiến trình (xem `job.rs`).

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::Duration;

use serde_json::Value;

use crate::framing::{Incoming, decode_line, encode_request};
#[cfg(windows)]
use crate::job::JobObject;
#[cfg(windows)]
use std::process::{Child, Command, Stdio};

/// Thông báo đẩy từ lõi (không có id).
#[derive(Debug, Clone, PartialEq)]
pub struct Notification {
    pub method: String,
    pub params: Value,
}

/// Lỗi khi gọi một phương thức.
#[derive(Debug, Clone, PartialEq)]
pub enum CallError {
    /// Lõi không trả lời trong thời gian chờ.
    Timeout,
    /// Kết nối với lõi đã đóng trước khi có phản hồi.
    Closed,
    /// Lõi trả lỗi JSON-RPC (đối tượng `error` nguyên văn).
    Rpc(Value),
    /// Không ghi được yêu cầu.
    Io(String),
}

/// Kết thúc của tiến trình lõi: mã thoát nếu có.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExitInfo {
    pub code: Option<i32>,
}

type Pending = Arc<Mutex<HashMap<u64, Sender<Result<Value, Value>>>>>;

pub struct Client {
    writer: Mutex<Box<dyn Write + Send>>,
    next_id: AtomicU64,
    pending: Pending,
    /// Bọc trong Mutex để Client là Sync (Arc<Client> gửi qua luồng được). Chỉ một bên đọc tại một thời điểm.
    notifications: Mutex<Receiver<Notification>>,
    timeout: Duration,
    /// Số dòng hỏng đã bỏ qua (để kiểm và để ghi nhật ký).
    skipped: Arc<AtomicUsize>,
    /// Job của tiến trình lõi (chỉ khi do `spawn` tạo). Drop dừng cả cây.
    #[cfg(windows)]
    job: Option<Arc<JobObject>>,
    /// Kênh báo khi launcher của lõi thoát. Lấy một lần bằng `take_exit_watch`.
    exit: Mutex<Option<Receiver<ExitInfo>>>,
    /// PID của tiến trình được spawn (launcher của venv, không phải tiến trình con). Dùng trong kiểm thử.
    root_pid: Option<u32>,
}

impl Client {
    /// Nối với một luồng đọc và ghi bất kỳ (dùng cho lõi giả trong kiểm thử).
    pub fn from_io(
        reader: impl Read + Send + 'static,
        writer: impl Write + Send + 'static,
        timeout: Duration,
    ) -> Client {
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (tx, rx) = channel();
        let skipped = Arc::new(AtomicUsize::new(0));
        spawn_reader(reader, Arc::clone(&pending), tx, Arc::clone(&skipped));
        Client {
            writer: Mutex::new(Box::new(writer)),
            next_id: AtomicU64::new(1),
            pending,
            notifications: Mutex::new(rx),
            timeout,
            skipped,
            #[cfg(windows)]
            job: None,
            exit: Mutex::new(None),
            root_pid: None,
        }
    }

    /// Khởi động lõi và đưa nó vào Job Object (`KILL_ON_JOB_CLOSE`).
    ///
    /// Tiến trình được tạo ở trạng thái suspended, gán vào job, rồi mới resume, nên không có tiến trình con
    /// nào được tạo trước khi gán. Không mở cửa sổ console (`CREATE_NO_WINDOW`). Mỗi dòng stderr của lõi
    /// được đưa cho `on_stderr`; luồng đọc stderr luôn chạy để pipe không đầy và làm treo lõi.
    #[cfg(windows)]
    pub fn spawn(
        program: &Path,
        args: &[&str],
        cwd: &Path,
        env: &[(&str, &str)],
        timeout: Duration,
        on_stderr: impl FnMut(&str) + Send + 'static,
    ) -> std::io::Result<Client> {
        use std::os::windows::process::CommandExt;
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let mut command = Command::new(program);
        command
            .args(args)
            .current_dir(cwd)
            .envs(env.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        let mut child = command.spawn()?;
        let root_pid = child.id();
        let job = match attach_job(&child) {
            Ok(job) => Arc::new(job),
            Err(err) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(err);
            }
        };
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| std::io::Error::other("không có stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| std::io::Error::other("không có stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| std::io::Error::other("không có stderr"))?;
        spawn_stderr_drain(stderr, on_stderr);

        // Luồng chờ: khi launcher thoát, dừng nốt tiến trình con còn sót (để pipe đóng và các yêu cầu
        // đang chờ nhận lỗi ngay), rồi báo kết thúc.
        let (exit_tx, exit_rx) = channel();
        let waiter_job = Arc::clone(&job);
        thread::spawn(move || {
            let code = child.wait().ok().and_then(|status| status.code());
            waiter_job.terminate();
            let _ = exit_tx.send(ExitInfo { code });
        });

        let mut client = Client::from_io(stdout, stdin, timeout);
        client.job = Some(job);
        client.exit = Mutex::new(Some(exit_rx));
        client.root_pid = Some(root_pid);
        Ok(client)
    }

    /// Gọi `method` với `params` và chờ phản hồi có cùng `id`, dùng thời gian chờ của client.
    pub fn call(&self, method: &str, params: &Value) -> Result<Value, CallError> {
        self.call_with_timeout(method, params, self.timeout)
    }

    /// Như `call` nhưng với thời gian chờ riêng (ví dụ `system.ping` khi khởi động).
    pub fn call_with_timeout(
        &self,
        method: &str,
        params: &Value,
        timeout: Duration,
    ) -> Result<Value, CallError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = channel();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, tx);
        let line = encode_request(id, method, params);
        let written = {
            let mut writer = self.writer.lock().unwrap_or_else(|e| e.into_inner());
            writer
                .write_all(line.as_bytes())
                .and_then(|_| writer.flush())
        };
        if let Err(e) = written {
            self.pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&id);
            return Err(CallError::Io(e.to_string()));
        }
        match rx.recv_timeout(timeout) {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(error)) => Err(CallError::Rpc(error)),
            Err(RecvTimeoutError::Timeout) => {
                self.pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                Err(CallError::Timeout)
            }
            Err(RecvTimeoutError::Disconnected) => Err(CallError::Closed),
        }
    }

    /// Kênh thông báo đẩy từ lõi. UI đọc kênh này để cập nhật tiến trình và kết quả việc nền.
    pub fn notifications(&self) -> MutexGuard<'_, Receiver<Notification>> {
        self.notifications.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Số dòng hỏng đã bỏ qua từ khi kết nối.
    pub fn skipped_lines(&self) -> usize {
        self.skipped.load(Ordering::SeqCst)
    }

    /// PID của tiến trình được spawn (launcher). Không phải PID của tiến trình con; xem `process_ids`.
    pub fn root_pid(&self) -> Option<u32> {
        self.root_pid
    }

    /// Lấy kênh báo khi tiến trình lõi thoát. Chỉ có khi do `spawn` tạo; lần gọi sau trả `None`.
    pub fn take_exit_watch(&self) -> Option<Receiver<ExitInfo>> {
        self.exit.lock().unwrap_or_else(|e| e.into_inner()).take()
    }

    /// Dừng mọi tiến trình của lõi (gồm tiến trình con). Mô phỏng lõi chết trong kiểm thử và dừng khẩn.
    #[cfg(windows)]
    pub fn terminate_tree(&self) {
        if let Some(job) = &self.job {
            job.terminate();
        }
    }

    /// PID của mọi tiến trình trong job của lõi (gồm tiến trình con). Rỗng nếu không có job.
    #[cfg(windows)]
    pub fn process_ids(&self) -> Vec<u32> {
        self.job
            .as_ref()
            .and_then(|job| job.process_ids().ok())
            .unwrap_or_default()
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            // Đóng client là dừng lõi: không để tiến trình nào sống sau khi không còn ai nghe.
            if let Some(job) = &self.job {
                job.terminate();
            }
        }
    }
}

/// Tạo job, gán launcher vào, rồi resume. Nếu lỗi, người gọi kill tiến trình.
#[cfg(windows)]
fn attach_job(child: &Child) -> std::io::Result<JobObject> {
    let job = JobObject::kill_on_close()?;
    job.assign(child)?;
    crate::job::resume_threads(child.id())?;
    Ok(job)
}

/// Luồng đọc stderr: mỗi dòng (UTF-8, lỗi thay bằng ký tự thay thế) đi tới `on_line`.
#[cfg(windows)]
fn spawn_stderr_drain(
    stderr: impl Read + Send + 'static,
    mut on_line: impl FnMut(&str) + Send + 'static,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => on_line(String::from_utf8_lossy(&buf).trim_end()),
            }
        }
    });
}

fn spawn_reader(
    reader: impl Read + Send + 'static,
    pending: Pending,
    notifications: Sender<Notification>,
    skipped: Arc<AtomicUsize>,
) {
    thread::spawn(move || {
        let reader = BufReader::new(reader);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.trim().is_empty() {
                continue;
            }
            match decode_line(&line) {
                Ok(Incoming::Response { id, outcome }) => {
                    let waiter = pending
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .remove(&id);
                    if let Some(waiter) = waiter {
                        let _ = waiter.send(outcome);
                    }
                }
                Ok(Incoming::Notification { method, params }) => {
                    let _ = notifications.send(Notification { method, params });
                }
                Err(_) => {
                    skipped.fetch_add(1, Ordering::SeqCst);
                }
            }
        }
        // Lõi đã đóng: các yêu cầu đang chờ nhận lỗi Closed ngay (sender bị bỏ).
        pending.lock().unwrap_or_else(|e| e.into_inner()).clear();
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::{BufRead, BufReader, Write};
    use std::time::Instant;

    /// Lõi giả: nhận từng yêu cầu và để `respond` quyết định các dòng trả về.
    fn fake_core(respond: impl Fn(&Value) -> Vec<String> + Send + 'static) -> Client {
        let (req_r, req_w) = std::io::pipe().expect("pipe yêu cầu");
        let (res_r, mut res_w) = std::io::pipe().expect("pipe phản hồi");
        thread::spawn(move || {
            let reader = BufReader::new(req_r);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let request: Value = serde_json::from_str(&line).expect("yêu cầu JSON");
                for out in respond(&request) {
                    if res_w.write_all(format!("{out}\n").as_bytes()).is_err() {
                        return;
                    }
                }
            }
        });
        Client::from_io(res_r, req_w, Duration::from_millis(800))
    }

    #[test]
    fn response_is_matched_to_its_request_id() {
        let client = fake_core(|req| {
            vec![
                json!({"jsonrpc":"2.0","id":req["id"],"result":{"method":req["method"]}})
                    .to_string(),
            ]
        });
        let first = client.call("system.ping", &json!({})).expect("gọi lần 1");
        let second = client.call("ops.list", &json!({})).expect("gọi lần 2");
        assert_eq!(first, json!({"method": "system.ping"}));
        assert_eq!(second, json!({"method": "ops.list"}));
    }

    #[test]
    fn broken_line_is_skipped_and_the_call_still_succeeds() {
        let client = fake_core(|req| {
            vec![
                "{ dòng hỏng".to_string(),
                json!({"jsonrpc":"2.0","id":req["id"],"result":"ok"}).to_string(),
            ]
        });
        assert_eq!(client.call("system.ping", &json!({})), Ok(json!("ok")));
        assert_eq!(client.skipped_lines(), 1);
    }

    #[test]
    fn notifications_arrive_on_the_channel_before_the_response() {
        let client = fake_core(|req| {
            vec![
                json!({"jsonrpc":"2.0","method":"job.progress","params":{"done":1,"total":2}})
                    .to_string(),
                json!({"jsonrpc":"2.0","id":req["id"],"result":null}).to_string(),
            ]
        });
        client.call("ops.run", &json!({})).expect("gọi");
        let note = client
            .notifications()
            .recv_timeout(Duration::from_millis(500))
            .expect("thông báo phải đến kênh");
        assert_eq!(note.method, "job.progress");
        assert_eq!(note.params["done"], 1);
    }

    #[test]
    fn rpc_error_is_returned_as_the_error_object() {
        let client = fake_core(|req| {
            vec![json!({"jsonrpc":"2.0","id":req["id"],"error":{"code":-32601,"message":"không có"}}).to_string()]
        });
        match client.call("khong.co", &json!({})) {
            Err(CallError::Rpc(err)) => assert_eq!(err["code"], -32601),
            other => panic!("cần lỗi RPC, được {other:?}"),
        }
    }

    #[test]
    fn silent_core_times_out() {
        let (req_r, req_w) = std::io::pipe().unwrap();
        let (res_r, _res_w) = std::io::pipe().unwrap();
        // Đọc yêu cầu nhưng không trả lời.
        thread::spawn(move || {
            let mut reader = BufReader::new(req_r);
            let mut line = String::new();
            let _ = reader.read_line(&mut line);
            thread::sleep(Duration::from_millis(1500));
        });
        let client = Client::from_io(res_r, req_w, Duration::from_millis(150));
        assert_eq!(
            client.call("system.ping", &json!({})),
            Err(CallError::Timeout)
        );
    }

    #[test]
    fn closed_core_reports_closed() {
        let (req_r, req_w) = std::io::pipe().unwrap();
        let (res_r, res_w) = std::io::pipe().unwrap();
        drop(req_r);
        drop(res_w);
        let client = Client::from_io(res_r, req_w, Duration::from_millis(300));
        let outcome = client.call("system.ping", &json!({}));
        assert!(
            matches!(outcome, Err(CallError::Closed) | Err(CallError::Io(_))),
            "{outcome:?}"
        );
    }

    #[test]
    fn pending_call_fails_at_once_when_core_dies() {
        // Lõi nhận yêu cầu rồi chết (đóng stdout) mà không trả lời: người gọi phải nhận lỗi ngay,
        // không đợi hết thời gian chờ 10 giây.
        let (req_r, req_w) = std::io::pipe().unwrap();
        let (res_r, res_w) = std::io::pipe().unwrap();
        thread::spawn(move || {
            let mut reader = BufReader::new(req_r);
            let mut line = String::new();
            let _ = reader.read_line(&mut line);
            drop(res_w);
        });
        let client = Client::from_io(res_r, req_w, Duration::from_secs(10));
        let started = Instant::now();
        let outcome = client.call("ops.run", &json!({}));
        assert_eq!(outcome, Err(CallError::Closed));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
    }

    /// Lõi Python thật (core/.venv). Bỏ qua khi không có môi trường lõi, để kiểm thử vẫn chạy ở máy khác.
    fn venv_python() -> Option<std::path::PathBuf> {
        let core = core_dir();
        let python = core.join(".venv/Scripts/python.exe");
        python.exists().then_some(python)
    }

    fn core_dir() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../core")
    }

    #[cfg(windows)]
    #[test]
    fn real_core_answers_system_ping() {
        let Some(python) = venv_python() else {
            eprintln!("bỏ qua: không có core/.venv");
            return;
        };
        let data = std::env::temp_dir().join(format!("chef-rpc-core-{}", std::process::id()));
        std::fs::create_dir_all(&data).unwrap();
        let data_str = data.display().to_string();
        let client = Client::spawn(
            &python,
            &["-m", "chef_core", "--data-dir", &data_str],
            &core_dir(),
            &[("PYTHONUTF8", "1")],
            Duration::from_secs(20),
            |_| {},
        )
        .expect("khởi động lõi");
        let pong = client.call("system.ping", &json!({})).expect("system.ping");
        assert!(
            pong.is_object() || pong.is_string() || pong.is_null(),
            "{pong}"
        );
        drop(client);
        let _ = std::fs::remove_dir_all(&data);
    }

    #[cfg(windows)]
    #[test]
    fn core_process_has_no_visible_console_window() {
        // CREATE_NO_WINDOW: tiến trình lõi không có cửa sổ console hiện ra (criterion 1, R3.02).
        let Some(python) = venv_python() else {
            eprintln!("bỏ qua: không có core/.venv");
            return;
        };
        let script = "import ctypes, sys; h = ctypes.windll.kernel32.GetConsoleWindow(); \
            print('visible=' + str(bool(h and ctypes.windll.user32.IsWindowVisible(h))), \
            file=sys.stderr, flush=True)";
        let lines = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = Arc::clone(&lines);
        let client = Client::spawn(
            &python,
            &["-c", script],
            &core_dir(),
            &[],
            Duration::from_secs(20),
            move |line| sink.lock().unwrap().push(line.to_string()),
        )
        .expect("khởi động tiến trình thử");
        let exit = client.take_exit_watch().expect("kênh thoát");
        exit.recv_timeout(Duration::from_secs(20))
            .expect("tiến trình thử thoát");
        drop(client);
        let seen = lines.lock().unwrap().clone();
        assert!(seen.iter().any(|l| l == "visible=False"), "{seen:?}");
    }
}
