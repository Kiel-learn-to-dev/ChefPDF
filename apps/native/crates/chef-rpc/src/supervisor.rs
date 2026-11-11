//! Giám sát tiến trình lõi (TASKS_RUST R3.02, R3.03; CONTRACTS §2): khởi động, `system.ping`, khởi động lại khi
//! lõi chết với lùi dần, và phát `core-status`. Chỉ Windows.
//!
//! Chế độ lười (`Supervisor::lazy`, R3.03): lõi chưa chạy cho đến yêu cầu đầu tiên. Khi rảnh (không có yêu cầu
//! và không có job trong `idle_stop`), lõi tự tắt và báo `stopped`; yêu cầu sau đó khởi động lại lõi. `stopped`
//! là trạng thái riêng của bản Rust, ngoài bốn trạng thái của CONTRACTS §2 (D89).
//!
//! Khi lõi chết, mọi yêu cầu đang chờ nhận lỗi ngay (xem `client.rs`), còn yêu cầu mới chờ tới `ready_wait`.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::client::{CallError, Client, ExitInfo, Notification};

/// Khoảng kiểm tra thời gian rảnh khi lõi đang chạy.
const IDLE_POLL: Duration = Duration::from_millis(100);

/// Trạng thái lõi. Bốn trạng thái đầu đúng tên trong CONTRACTS §2; `Stopped` là riêng của bản Rust (D89).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoreStatus {
    Starting,
    Ready,
    Crashed,
    Restarting,
    Stopped,
}

impl CoreStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            CoreStatus::Starting => "starting",
            CoreStatus::Ready => "ready",
            CoreStatus::Crashed => "crashed",
            CoreStatus::Restarting => "restarting",
            CoreStatus::Stopped => "stopped",
        }
    }
}

/// Sự kiện gửi cho UI: trạng thái lõi hoặc thông báo đẩy của lõi.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Status(CoreStatus),
    Notification(Notification),
}

/// Lệnh khởi động lõi. Người gọi lấy đường dẫn từ thư mục cài đặt, không từ dữ liệu người dùng (BLUEPRINT §7.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoreCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
}

/// Cấu hình giám sát. Giá trị mặc định lấy từ bản Electron (`sidecar.ts`) khi có tương ứng.
pub struct SupervisorConfig {
    pub command: CoreCommand,
    /// Thời gian chờ `system.ping` đầu tiên, gồm cả khởi động interpreter.
    pub startup_timeout: Duration,
    /// Thời gian chờ mỗi yêu cầu sau khi lõi sẵn sàng.
    pub request_timeout: Duration,
    /// Yêu cầu chờ lõi sẵn sàng tối đa bao lâu.
    pub ready_wait: Duration,
    pub backoff_initial: Duration,
    pub backoff_max: Duration,
    /// Lõi sống đủ lâu thì đếm lại từ đầu việc lùi dần.
    pub stable_after: Duration,
    /// Số lần chết liên tiếp mà không sống đủ `stable_after` trước khi ngừng khởi động lại.
    pub max_failed_starts: u32,
    /// Lõi tự tắt sau khi rảnh (không yêu cầu, không job) quá khoảng này. `None` là không tự tắt.
    pub idle_stop: Option<Duration>,
    /// Nhận nhật ký: dòng stderr của lõi và thông báo của giám sát.
    pub log: Arc<dyn Fn(&str) + Send + Sync>,
}

impl SupervisorConfig {
    pub fn new(command: CoreCommand, log: Arc<dyn Fn(&str) + Send + Sync>) -> SupervisorConfig {
        SupervisorConfig {
            command,
            startup_timeout: Duration::from_secs(60),
            request_timeout: Duration::from_secs(60),
            ready_wait: Duration::from_secs(60),
            backoff_initial: Duration::from_millis(500),
            backoff_max: Duration::from_secs(30),
            stable_after: Duration::from_secs(60),
            max_failed_starts: 5,
            idle_stop: Some(Duration::from_secs(600)),
            log,
        }
    }
}

struct State {
    /// Client của lượt chạy hiện tại. Có từ lúc spawn, nên `shutdown` dừng được cả khi đang ping.
    client: Option<Arc<Client>>,
    /// Lõi đã trả lời `system.ping`.
    ready: bool,
    status: CoreStatus,
    stopping: bool,
    /// Luồng giám sát đã kết thúc (dừng theo yêu cầu, hoặc đã ngừng khởi động lại).
    finished: bool,
    /// Có cần lõi chạy. Chế độ lười bắt đầu là `false`; yêu cầu hoặc job đặt lại thành `true`.
    want_start: bool,
    /// Lần cuối có yêu cầu hoặc job. Mốc để tính thời gian rảnh.
    last_activity: Instant,
    /// Lý do giữ lõi chạy: job đang chạy (`job:<id>`) và phiên đang mở (`session:<id>`). Lõi không tự tắt khi
    /// còn lý do nào. Phiên giữ lõi vì `system.shutdown` xóa thư mục phiên (CONTRACTS §4): tắt khi còn phiên
    /// sẽ mất các revision chưa lưu.
    busy: HashSet<String>,
}

struct Shared {
    state: Mutex<State>,
    changed: Condvar,
}

fn lock(shared: &Shared) -> MutexGuard<'_, State> {
    shared.state.lock().unwrap_or_else(|e| e.into_inner())
}

fn wait_for<'a>(
    shared: &'a Shared,
    guard: MutexGuard<'a, State>,
    dur: Duration,
) -> MutexGuard<'a, State> {
    match shared.changed.wait_timeout(guard, dur) {
        Ok((guard, _)) => guard,
        Err(poison) => poison.into_inner().0,
    }
}

/// Giám sát một tiến trình lõi. Khi bị bỏ, `Drop` dừng lõi.
pub struct Supervisor {
    shared: Arc<Shared>,
    events: Receiver<Event>,
    monitor: Option<JoinHandle<()>>,
    ready_wait: Duration,
}

impl Supervisor {
    /// Bắt đầu giám sát và khởi động lõi ngay.
    pub fn start(config: SupervisorConfig) -> Supervisor {
        Supervisor::spawn(config, true)
    }

    /// Giám sát nhưng chưa khởi động lõi: lõi chạy từ yêu cầu đầu tiên (R3.03).
    pub fn lazy(config: SupervisorConfig) -> Supervisor {
        Supervisor::spawn(config, false)
    }

    fn spawn(config: SupervisorConfig, eager: bool) -> Supervisor {
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                client: None,
                ready: false,
                status: if eager {
                    CoreStatus::Starting
                } else {
                    CoreStatus::Stopped
                },
                stopping: false,
                finished: false,
                want_start: eager,
                last_activity: Instant::now(),
                busy: HashSet::new(),
            }),
            changed: Condvar::new(),
        });
        let (tx, rx) = channel();
        let ready_wait = config.ready_wait;
        let monitor_shared = Arc::clone(&shared);
        let monitor = thread::spawn(move || run_monitor(config, monitor_shared, tx));
        Supervisor {
            shared,
            events: rx,
            monitor: Some(monitor),
            ready_wait,
        }
    }

    /// Sự kiện cho UI: trạng thái và thông báo, theo đúng thứ tự xảy ra.
    pub fn events(&self) -> &Receiver<Event> {
        &self.events
    }

    pub fn status(&self) -> CoreStatus {
        lock(&self.shared).status
    }

    /// Gửi yêu cầu. Chờ tới `ready_wait` để lõi sẵn sàng; nếu lõi đang tắt, yêu cầu này khởi động lại lõi.
    /// Gọi từ luồng nền, không từ luồng UI.
    pub fn request(&self, method: &str, params: &Value) -> Result<Value, CallError> {
        let client = self.wait_ready()?;
        client.call(method, params)
    }

    /// Ghi nhận một job vừa bắt đầu: lõi không tự tắt khi còn job.
    pub fn job_started(&self, job_id: &str) {
        self.set_busy(format!("job:{job_id}"), true);
    }

    /// Ghi nhận một job đã kết thúc (thành công, lỗi, hoặc bị hủy).
    pub fn job_finished(&self, job_id: &str) {
        self.set_busy(format!("job:{job_id}"), false);
    }

    /// Ghi nhận một phiên vừa mở: lõi phải chạy để giữ revision của phiên (R3.03).
    pub fn session_opened(&self, session_id: &str) {
        self.set_busy(format!("session:{session_id}"), true);
    }

    /// Ghi nhận một phiên đã đóng. Khi không còn phiên và job nào, lõi rảnh và có thể tự tắt.
    pub fn session_closed(&self, session_id: &str) {
        self.set_busy(format!("session:{session_id}"), false);
    }

    fn set_busy(&self, key: String, busy: bool) {
        let mut state = lock(&self.shared);
        if busy {
            state.busy.insert(key);
        } else {
            state.busy.remove(&key);
        }
        state.last_activity = Instant::now();
    }

    /// PID của các tiến trình lõi hiện tại (gồm tiến trình con). Rỗng khi lõi không chạy.
    pub fn process_ids(&self) -> Vec<u32> {
        match lock(&self.shared).client.clone() {
            Some(client) => client.process_ids(),
            None => Vec::new(),
        }
    }

    /// Dừng lõi: `system.shutdown`, chờ `grace`, rồi dừng cả cây tiến trình nếu còn sống. Trả về sau khi
    /// luồng giám sát kết thúc.
    pub fn shutdown(&mut self, grace: Duration) {
        let client = {
            let mut state = lock(&self.shared);
            state.stopping = true;
            state.client.clone()
        };
        self.shared.changed.notify_all();
        if let Some(client) = &client {
            // Lõi có thể đã chết hoặc chưa sẵn sàng: lỗi ở đây không quan trọng, bước dưới vẫn dừng cây.
            let _ = client.call_with_timeout("system.shutdown", &json!({}), grace);
        }
        let deadline = Instant::now() + grace;
        {
            let mut state = lock(&self.shared);
            while state.client.is_some() {
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                state = wait_for(&self.shared, state, deadline - now);
            }
        }
        // Đọc lại client trong khóa: lượt chạy có thể vừa được gán sau lần đọc đầu.
        let current = lock(&self.shared).client.clone();
        if let Some(current) = current {
            current.terminate_tree();
        }
        if let Some(handle) = self.monitor.take() {
            let _ = handle.join();
        }
    }

    fn wait_ready(&self) -> Result<Arc<Client>, CallError> {
        let deadline = Instant::now() + self.ready_wait;
        let mut state = lock(&self.shared);
        state.last_activity = Instant::now();
        if !state.want_start && !state.stopping && !state.finished {
            state.want_start = true;
            self.shared.changed.notify_all();
        }
        loop {
            if state.ready
                && let Some(client) = &state.client
            {
                return Ok(Arc::clone(client));
            }
            if state.stopping || state.finished {
                return Err(CallError::Closed);
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(CallError::Timeout);
            }
            state = wait_for(&self.shared, state, deadline - now);
        }
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.shutdown(Duration::from_secs(3));
    }
}

fn run_monitor(config: SupervisorConfig, shared: Arc<Shared>, events: Sender<Event>) {
    supervise(&config, &shared, &events);
    {
        let mut state = lock(&shared);
        state.client = None;
        state.ready = false;
        state.finished = true;
    }
    shared.changed.notify_all();
}

/// Kết quả của một lượt chạy lõi.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RunOutcome {
    /// Lõi thoát (do lỗi, bị dừng, hoặc không khởi động được).
    Exited,
    /// Lõi tự tắt vì rảnh. Không tính là lỗi, không khởi động lại theo lùi dần.
    IdleStopped,
}

/// Vòng chạy, nằm chờ và khởi động lại. Thoát khi được yêu cầu dừng, hoặc khi lõi chết quá nhiều lần liên tiếp.
fn supervise(config: &SupervisorConfig, shared: &Shared, events: &Sender<Event>) {
    let mut failed_starts = 0u32;
    loop {
        if !wait_until_wanted(shared) {
            return;
        }
        publish(shared, events, CoreStatus::Starting);
        let started = Instant::now();
        let outcome = run_once(config, shared, events);
        if lock(shared).stopping {
            return;
        }
        if outcome == RunOutcome::IdleStopped {
            (config.log)("lõi đã tự tắt vì rảnh");
            publish(shared, events, CoreStatus::Stopped);
            failed_starts = 0;
            continue;
        }
        publish(shared, events, CoreStatus::Crashed);
        if started.elapsed() >= config.stable_after {
            failed_starts = 0;
        }
        failed_starts += 1;
        if failed_starts >= config.max_failed_starts {
            (config.log)(&format!(
                "lõi chết {failed_starts} lần liên tiếp; ngừng khởi động lại"
            ));
            return;
        }
        let delay = backoff(config, failed_starts);
        (config.log)(&format!(
            "khởi động lại lõi sau {} ms (lần {failed_starts})",
            delay.as_millis()
        ));
        publish(shared, events, CoreStatus::Restarting);
        if wait_backoff(shared, delay) {
            return;
        }
    }
}

/// Chờ đến khi cần lõi chạy. Trả `false` nếu đang dừng.
fn wait_until_wanted(shared: &Shared) -> bool {
    let mut state = lock(shared);
    loop {
        if state.stopping {
            return false;
        }
        if state.want_start {
            return true;
        }
        state = wait_for(shared, state, Duration::from_secs(3600));
    }
}

/// Lùi dần: `initial * 2^(n-1)`, không quá `backoff_max`.
fn backoff(config: &SupervisorConfig, failed_starts: u32) -> Duration {
    let factor = 2u32
        .checked_pow(failed_starts.saturating_sub(1))
        .unwrap_or(u32::MAX);
    config
        .backoff_initial
        .checked_mul(factor)
        .unwrap_or(config.backoff_max)
        .min(config.backoff_max)
}

/// Chờ `delay`, trả `true` nếu có yêu cầu dừng trong lúc chờ.
fn wait_backoff(shared: &Shared, delay: Duration) -> bool {
    let deadline = Instant::now() + delay;
    let mut state = lock(shared);
    loop {
        if state.stopping {
            return true;
        }
        let now = Instant::now();
        if now >= deadline {
            return false;
        }
        state = wait_for(shared, state, deadline - now);
    }
}

/// Một lượt chạy: spawn, ping, rồi chờ lõi thoát hoặc tự tắt vì rảnh. Khi trở về, mọi trạng thái của lượt đã
/// được xóa.
fn run_once(config: &SupervisorConfig, shared: &Shared, events: &Sender<Event>) -> RunOutcome {
    let args: Vec<&str> = config.command.args.iter().map(String::as_str).collect();
    let env = [
        ("PYTHONUNBUFFERED", "1"),
        ("PYTHONIOENCODING", "utf-8"),
        ("PYTHONUTF8", "1"),
    ];
    let log = Arc::clone(&config.log);
    let spawned = Client::spawn(
        &config.command.program,
        &args,
        &config.command.cwd,
        &env,
        config.request_timeout,
        move |line| log(&format!("core: {line}")),
    );
    let client = match spawned {
        Ok(client) => Arc::new(client),
        Err(err) => {
            (config.log)(&format!("không khởi động được lõi: {err}"));
            return RunOutcome::Exited;
        }
    };
    let Some(exit) = client.take_exit_watch() else {
        return RunOutcome::Exited;
    };

    // Thông báo của lõi chuyển thành sự kiện; vòng này kết thúc khi pipe của lõi đóng.
    let forward = Arc::clone(&client);
    let forward_events = events.clone();
    thread::spawn(move || {
        for note in forward.notifications().iter() {
            if forward_events.send(Event::Notification(note)).is_err() {
                break;
            }
        }
    });

    // Gán client và kiểm `stopping` trong cùng một khóa. Nếu `shutdown` đã bắt đầu, lõi bị dừng ngay và không
    // ping: `shutdown` đã đọc `client` trước khi có, nên không ai khác dừng lõi này.
    let stored = {
        let mut state = lock(shared);
        if state.stopping {
            false
        } else {
            state.client = Some(Arc::clone(&client));
            true
        }
    };
    if !stored {
        client.terminate_tree();
        let _ = exit.recv();
        return RunOutcome::Exited;
    }

    let (code, idle) =
        match client.call_with_timeout("system.ping", &json!({}), config.startup_timeout) {
            Ok(_) => {
                lock(shared).ready = true;
                shared.changed.notify_all();
                publish(shared, events, CoreStatus::Ready);
                wait_while_ready(config, shared, &client, &exit)
            }
            Err(err) => {
                (config.log)(&format!("ping khi khởi động lỗi: {err:?}; dừng lõi"));
                client.terminate_tree();
                (exit.recv().ok().and_then(|info| info.code), false)
            }
        };
    {
        let mut state = lock(shared);
        state.client = None;
        state.ready = false;
    }
    shared.changed.notify_all();
    (config.log)(&format!("lõi đã thoát (mã {code:?})"));
    if idle {
        RunOutcome::IdleStopped
    } else {
        RunOutcome::Exited
    }
}

/// Chờ lõi thoát. Nếu rảnh quá `idle_stop`, tự tắt lõi. Trả (mã thoát, có tự tắt vì rảnh).
fn wait_while_ready(
    config: &SupervisorConfig,
    shared: &Shared,
    client: &Client,
    exit: &Receiver<ExitInfo>,
) -> (Option<i32>, bool) {
    let Some(idle) = config.idle_stop else {
        return (exit.recv().ok().and_then(|info| info.code), false);
    };
    loop {
        match exit.recv_timeout(IDLE_POLL) {
            Ok(info) => return (info.code, false),
            Err(RecvTimeoutError::Disconnected) => return (None, false),
            Err(RecvTimeoutError::Timeout) => {
                if idle_expired(shared, idle) {
                    (config.log)("lõi rảnh quá lâu; tự tắt");
                    return (stop_idle(client, exit), true);
                }
            }
        }
    }
}

/// Kiểm rảnh và đánh dấu tắt trong cùng một khóa: yêu cầu đến sau đó sẽ khởi động lại lõi.
fn idle_expired(shared: &Shared, idle: Duration) -> bool {
    let mut state = lock(shared);
    if state.stopping || !state.busy.is_empty() || state.last_activity.elapsed() < idle {
        return false;
    }
    state.want_start = false;
    state.ready = false;
    true
}

/// Tắt lõi đang rảnh: `system.shutdown`, chờ 3 giây, rồi dừng cả cây nếu còn sống.
fn stop_idle(client: &Client, exit: &Receiver<ExitInfo>) -> Option<i32> {
    let grace = Duration::from_secs(3);
    let _ = client.call_with_timeout("system.shutdown", &json!({}), grace);
    match exit.recv_timeout(grace) {
        Ok(info) => info.code,
        Err(_) => {
            client.terminate_tree();
            exit.recv().ok().and_then(|info| info.code)
        }
    }
}

fn publish(shared: &Shared, events: &Sender<Event>, status: CoreStatus) {
    lock(shared).status = status;
    let _ = events.send(Event::Status(status));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::job::process_alive;
    use std::time::Duration;

    fn quiet_log() -> Arc<dyn Fn(&str) + Send + Sync> {
        Arc::new(|_: &str| {})
    }

    /// Cấu hình lõi Python thật. Bỏ qua (None) khi không có core/.venv.
    fn real_core_config(
        test: &str,
        log: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Option<SupervisorConfig> {
        let core = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../core");
        let python = core.join(".venv/Scripts/python.exe");
        if !python.exists() {
            eprintln!("bỏ qua: không có core/.venv");
            return None;
        }
        let data = std::env::temp_dir().join(format!("chef-sup-{test}-{}", std::process::id()));
        std::fs::create_dir_all(&data).ok()?;
        let command = CoreCommand {
            program: python,
            args: vec![
                "-m".into(),
                "chef_core".into(),
                "--data-dir".into(),
                data.display().to_string(),
            ],
            cwd: core,
        };
        let mut config = SupervisorConfig::new(command, log);
        config.backoff_initial = Duration::from_millis(50);
        // Trong test, lõi không tự tắt trừ khi test tự đặt.
        config.idle_stop = None;
        Some(config)
    }

    /// Lấy sự kiện trạng thái cho đến khi gặp `until`, hoặc hết thời gian.
    fn statuses_until(sup: &Supervisor, until: CoreStatus, count: usize) -> Vec<CoreStatus> {
        let mut seen = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(60);
        while Instant::now() < deadline {
            let left = deadline.saturating_duration_since(Instant::now());
            match sup.events().recv_timeout(left) {
                Ok(Event::Status(status)) => {
                    seen.push(status);
                    if seen.iter().filter(|s| **s == until).count() >= count {
                        break;
                    }
                }
                Ok(Event::Notification(_)) => {}
                Err(_) => break,
            }
        }
        seen
    }

    #[test]
    fn real_core_pings_and_shutdown_stops_the_whole_tree() {
        let Some(config) = real_core_config("ping", quiet_log()) else {
            return;
        };
        let mut sup = Supervisor::start(config);
        assert_eq!(
            statuses_until(&sup, CoreStatus::Ready, 1),
            vec![CoreStatus::Starting, CoreStatus::Ready]
        );
        let pong = sup.request("system.ping", &json!({})).expect("system.ping");
        assert!(
            pong.is_object() || pong.is_string() || pong.is_null(),
            "{pong}"
        );

        let pids = sup.process_ids();
        // Launcher của venv và tiến trình Python thật (con của nó) đều phải nằm trong job.
        assert!(pids.len() >= 2, "job phải gồm cả tiến trình con: {pids:?}");
        sup.shutdown(Duration::from_secs(5));
        for pid in pids {
            assert!(!process_alive(pid), "pid {pid} còn sống sau khi dừng");
        }
    }

    /// Chờ lượt đầu sẵn sàng: `starting`, rồi `ready`.
    fn start_ready(sup: &Supervisor) {
        assert_eq!(
            statuses_until(sup, CoreStatus::Ready, 1),
            vec![CoreStatus::Starting, CoreStatus::Ready]
        );
    }

    /// Tên image của một PID, qua tasklist (chỉ dùng trong kiểm thử).
    fn image_name(pid: u32) -> String {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
            .output()
            .expect("chạy tasklist");
        String::from_utf8_lossy(&out.stdout)
            .split(',')
            .next()
            .unwrap_or("")
            .trim_matches('"')
            .to_string()
    }

    /// Dừng đúng một tiến trình bằng taskkill (không /T): mô phỏng lỗi thực tế, chỉ một tiến trình chết.
    fn kill_one(pid: u32) {
        let status = std::process::Command::new("taskkill")
            .args(["/F", "/PID", &pid.to_string()])
            .status()
            .expect("chạy taskkill");
        assert!(status.success(), "taskkill không dừng được pid {pid}");
    }

    /// Giết một tiến trình của lượt hiện tại (PID chọn bởi `pick`). Kiểm: mọi PID của lượt cũ phải chết,
    /// kể cả PID không bị giết (không để tiến trình mồ côi); trạng thái đi crashed → restarting → starting →
    /// ready; và lõi mới trả lời yêu cầu.
    fn kill_and_expect_full_restart(sup: &Supervisor, pick: impl FnOnce(u32, &[u32]) -> u32) {
        let client = lock(&sup.shared).client.clone().expect("có client");
        let root = client.root_pid().expect("có PID gốc");
        let old_pids = client.process_ids();
        let names: Vec<String> = old_pids
            .iter()
            .map(|pid| format!("{pid}={}", image_name(*pid)))
            .collect();
        eprintln!("job của lượt chạy: {names:?}");
        assert!(
            old_pids.len() >= 2,
            "job phải có launcher và tiến trình con: {names:?}"
        );
        let victim = pick(root, &old_pids);
        drop(client);
        kill_one(victim);

        let after = statuses_until(sup, CoreStatus::Ready, 1);
        assert_eq!(
            after,
            vec![
                CoreStatus::Crashed,
                CoreStatus::Restarting,
                CoreStatus::Starting,
                CoreStatus::Ready
            ],
            "sau khi pid {victim} chết phải báo crashed, restarting, rồi starting và ready"
        );
        for pid in old_pids {
            assert!(
                !process_alive(pid),
                "pid {pid} của lượt cũ còn sống (giết pid {victim})"
            );
        }
        let pong = sup
            .request("system.ping", &json!({}))
            .expect("ping sau khi khởi động lại");
        assert!(
            pong.is_object() || pong.is_string() || pong.is_null(),
            "{pong}"
        );
    }

    #[test]
    fn whole_tree_killed_restarts_with_status_sequence() {
        let Some(config) = real_core_config("restart-tree", quiet_log()) else {
            return;
        };
        let mut sup = Supervisor::start(config);
        start_ready(&sup);
        let old_pids = sup.process_ids();
        let client = lock(&sup.shared).client.clone().expect("có client");
        client.terminate_tree();
        drop(client);
        let after = statuses_until(&sup, CoreStatus::Ready, 1);
        assert_eq!(
            after,
            vec![
                CoreStatus::Crashed,
                CoreStatus::Restarting,
                CoreStatus::Starting,
                CoreStatus::Ready
            ]
        );
        for pid in old_pids {
            assert!(!process_alive(pid), "pid {pid} còn sống");
        }
        sup.shutdown(Duration::from_secs(5));
    }

    #[test]
    fn only_the_launcher_killed_takes_the_whole_tree_down() {
        // Đúng lỗi đã gặp: kill launcher không dừng tiến trình Python con. Job phải dọn nốt con.
        let Some(config) = real_core_config("restart-launcher", quiet_log()) else {
            return;
        };
        let mut sup = Supervisor::start(config);
        start_ready(&sup);
        kill_and_expect_full_restart(&sup, |root, _| root);
        sup.shutdown(Duration::from_secs(5));
    }

    #[test]
    fn only_the_real_python_killed_takes_the_launcher_down() {
        let Some(config) = real_core_config("restart-child", quiet_log()) else {
            return;
        };
        let mut sup = Supervisor::start(config);
        start_ready(&sup);
        // Job cũng chứa conhost.exe (CREATE_NO_WINDOW), nên chọn đúng python.exe con, không lấy PID đầu tiên.
        kill_and_expect_full_restart(&sup, |root, pids| {
            *pids
                .iter()
                .find(|pid| **pid != root && image_name(**pid).eq_ignore_ascii_case("python.exe"))
                .expect("có python.exe con trong job")
        });
        sup.shutdown(Duration::from_secs(5));
    }

    #[test]
    fn shutdown_right_after_start_never_hangs() {
        // Hồi quy: shutdown lúc lõi đang spawn từng làm treo (client chưa được gán khi shutdown đọc).
        // Cửa sổ rất hẹp, nên chạy nhiều vòng; mỗi vòng phải kết thúc trong 15 giây.
        for round in 0..20 {
            let Some(config) = real_core_config("race", quiet_log()) else {
                return;
            };
            let (done_tx, done_rx) = channel();
            thread::spawn(move || {
                let mut sup = Supervisor::start(config);
                sup.shutdown(Duration::from_secs(2));
                let _ = done_tx.send(());
            });
            assert!(
                done_rx.recv_timeout(Duration::from_secs(15)).is_ok(),
                "shutdown treo ở vòng {round}"
            );
        }
    }

    #[test]
    fn lazy_core_starts_only_on_the_first_request() {
        let Some(config) = real_core_config("lazy", quiet_log()) else {
            return;
        };
        let mut sup = Supervisor::lazy(config);
        assert_eq!(sup.status(), CoreStatus::Stopped);
        assert!(
            sup.events()
                .recv_timeout(Duration::from_millis(800))
                .is_err(),
            "chưa có yêu cầu thì không được có sự kiện nào"
        );
        assert!(
            sup.process_ids().is_empty(),
            "chưa có yêu cầu thì không có tiến trình lõi"
        );

        let pong = sup.request("system.ping", &json!({})).expect("ping");
        assert!(
            pong.is_object() || pong.is_string() || pong.is_null(),
            "{pong}"
        );
        assert_eq!(
            statuses_until(&sup, CoreStatus::Ready, 1),
            vec![CoreStatus::Starting, CoreStatus::Ready]
        );
        sup.shutdown(Duration::from_secs(5));
    }

    #[test]
    fn idle_core_stops_by_itself_and_comes_back_on_the_next_request() {
        let Some(mut config) = real_core_config("idle", quiet_log()) else {
            return;
        };
        config.idle_stop = Some(Duration::from_millis(800));
        let mut sup = Supervisor::start(config);
        start_ready(&sup);
        let old_pids = sup.process_ids();
        assert!(!old_pids.is_empty());

        assert_eq!(
            statuses_until(&sup, CoreStatus::Stopped, 1),
            vec![CoreStatus::Stopped],
            "lõi rảnh phải tự tắt và báo stopped"
        );
        assert_eq!(sup.status(), CoreStatus::Stopped);
        for pid in old_pids {
            assert!(!process_alive(pid), "pid {pid} còn sống sau khi tự tắt");
        }
        assert!(sup.process_ids().is_empty());

        let pong = sup
            .request("system.ping", &json!({}))
            .expect("ping sau khi tự tắt");
        assert!(
            pong.is_object() || pong.is_string() || pong.is_null(),
            "{pong}"
        );
        assert_eq!(
            statuses_until(&sup, CoreStatus::Ready, 1),
            vec![CoreStatus::Starting, CoreStatus::Ready]
        );
        sup.shutdown(Duration::from_secs(5));
    }

    #[test]
    fn running_job_keeps_the_core_alive_until_it_ends() {
        let Some(mut config) = real_core_config("busy", quiet_log()) else {
            return;
        };
        config.idle_stop = Some(Duration::from_millis(300));
        let mut sup = Supervisor::start(config);
        start_ready(&sup);

        sup.job_started("job-dang-chay");
        std::thread::sleep(Duration::from_millis(1200));
        assert_eq!(
            sup.status(),
            CoreStatus::Ready,
            "còn job thì không được tự tắt"
        );
        while let Ok(event) = sup.events().try_recv() {
            assert!(
                !matches!(event, Event::Status(CoreStatus::Stopped)),
                "không được báo stopped khi còn job"
            );
        }

        sup.job_finished("job-dang-chay");
        assert_eq!(
            statuses_until(&sup, CoreStatus::Stopped, 1),
            vec![CoreStatus::Stopped],
            "hết job và đã rảnh thì phải tự tắt"
        );
        sup.shutdown(Duration::from_secs(5));
    }

    #[test]
    fn open_session_keeps_the_core_alive_until_it_is_closed() {
        // system.shutdown xóa thư mục phiên, nên lõi không được tự tắt khi còn phiên mở.
        let Some(mut config) = real_core_config("session-busy", quiet_log()) else {
            return;
        };
        config.idle_stop = Some(Duration::from_millis(300));
        let mut sup = Supervisor::start(config);
        start_ready(&sup);

        sup.session_opened("phien-1");
        std::thread::sleep(Duration::from_millis(1200));
        assert_eq!(
            sup.status(),
            CoreStatus::Ready,
            "còn phiên thì không được tự tắt"
        );

        sup.session_closed("phien-1");
        assert_eq!(
            statuses_until(&sup, CoreStatus::Stopped, 1),
            vec![CoreStatus::Stopped],
            "đóng hết phiên và job thì phải tự tắt"
        );
        sup.shutdown(Duration::from_secs(5));
    }

    #[test]
    fn missing_core_gives_up_after_the_limit() {
        let command = CoreCommand {
            program: PathBuf::from("C:/khong-co/chef-core-khong-ton-tai.exe"),
            args: Vec::new(),
            cwd: std::env::temp_dir(),
        };
        let mut config = SupervisorConfig::new(command, quiet_log());
        config.backoff_initial = Duration::from_millis(5);
        config.max_failed_starts = 3;
        let mut sup = Supervisor::start(config);

        let mut seen = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            match sup.events().recv_timeout(left) {
                Ok(Event::Status(status)) => seen.push(status),
                Ok(Event::Notification(_)) => {}
                Err(_) => break,
            }
        }
        assert_eq!(
            seen,
            vec![
                CoreStatus::Starting,
                CoreStatus::Crashed,
                CoreStatus::Restarting,
                CoreStatus::Starting,
                CoreStatus::Crashed,
                CoreStatus::Restarting,
                CoreStatus::Starting,
                CoreStatus::Crashed,
            ]
        );
        assert_eq!(
            sup.request("system.ping", &json!({})),
            Err(CallError::Closed)
        );
        sup.shutdown(Duration::from_secs(1));
    }

    #[test]
    fn backoff_doubles_and_is_capped() {
        let command = CoreCommand {
            program: PathBuf::new(),
            args: Vec::new(),
            cwd: PathBuf::new(),
        };
        let mut config = SupervisorConfig::new(command, quiet_log());
        config.backoff_initial = Duration::from_millis(500);
        config.backoff_max = Duration::from_secs(3);
        let delays: Vec<u128> = (1..=6).map(|n| backoff(&config, n).as_millis()).collect();
        assert_eq!(delays, vec![500, 1000, 2000, 3000, 3000, 3000]);
    }
}
