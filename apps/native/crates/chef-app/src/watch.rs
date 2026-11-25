//! Thư mục tự động (TASKS_RUST R5.63, FEATURES O8, D42): port bộ lặp của `watchService.ts`. Quét thư mục,
//! lấy các file đã ổn định, chạy quy trình (từng file, hoặc cả đợt một lần khi quy trình là ghép), ghi sổ,
//! và trả lại file chưa xử lý khi dừng hoặc lỗi. Lõi và RPC nằm sau `WatchApi` nên test được bằng bản giả.
//! Dừng chờ đến khi đợt đang chạy được ghi xong. Logic thuần, không dùng GPUI.
#![allow(dead_code)]

use serde_json::{Value, json};

use crate::workflow_model::{
    WatchConfig, watch_delay_ms, watch_scan_params, watch_workflow_output,
};

/// Số kết quả gần đây giữ lại.
pub const RESULT_LIMIT: usize = 12;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadyFile {
    pub path: String,
    pub size: u64,
    pub mtime_ns: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanData {
    pub ready: Vec<ReadyFile>,
    pub pending: u64,
}

/// Cổng tới lõi. Mỗi hàm trả `Err(thông báo)` khi lỗi.
pub trait WatchApi {
    /// `watch.scan`.
    fn scan(&mut self, params: &Value) -> Result<ScanData, String>;
    /// `workflow.run`; trả báo cáo `{ results: [{ status, outputPath, message }] }`.
    fn run(&mut self, request: &Value) -> Result<Value, String>;
    /// `watch.markDone`.
    fn mark_done(&mut self, params: &Value) -> Result<(), String>;
    /// `watch.release`: trả file về hàng đợi.
    fn release(&mut self, params: &Value) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchStatus {
    Stopped,
    Running,
    Stopping,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchFileResult {
    pub path: String,
    pub status: String,
    pub output_path: Option<String>,
    pub message: Option<String>,
    pub completed_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WatchSnapshot {
    pub status: WatchStatus,
    pub pending: u64,
    pub queued: usize,
    pub current_file: Option<String>,
    pub recent: Vec<WatchFileResult>,
    pub error: Option<String>,
}

impl Default for WatchSnapshot {
    fn default() -> Self {
        WatchSnapshot {
            status: WatchStatus::Stopped,
            pending: 0,
            queued: 0,
            current_file: None,
            recent: Vec::new(),
            error: None,
        }
    }
}

/// Đầu vào cố định của một lần chạy theo dõi.
pub struct WatchRun<'a> {
    pub config: &'a WatchConfig,
    pub variables: &'a Value,
    pub secrets: &'a Value,
    pub ledger_path: &'a str,
}

/// Quy trình ghép chạy một lần trên cả đợt, cần ít nhất 2 PDF.
fn is_merge(config: &WatchConfig) -> bool {
    config
        .workflow
        .get("inputs")
        .and_then(|i| i.get("mode"))
        .and_then(Value::as_str)
        == Some("merge")
}

/// Chia danh sách file sẵn sàng thành các lô: ghép là một lô (nếu đủ 2 file), ngược lại mỗi file một lô.
pub fn plan_batches(merge: bool, ready: &[ReadyFile]) -> Vec<Vec<ReadyFile>> {
    if merge {
        if ready.len() >= 2 {
            vec![ready.to_vec()]
        } else {
            Vec::new()
        }
    } else {
        ready.iter().map(|f| vec![f.clone()]).collect()
    }
}

fn paths(files: &[ReadyFile]) -> Vec<String> {
    files.iter().map(|f| f.path.clone()).collect()
}

fn outcome_of(report: Result<Value, String>) -> (String, Option<String>, Option<String>) {
    match report {
        Ok(v) => {
            let first = v
                .get("results")
                .and_then(Value::as_array)
                .and_then(|a| a.first());
            let s = |k: &str| {
                first
                    .and_then(|r| r.get(k))
                    .and_then(Value::as_str)
                    .map(String::from)
            };
            (
                s("status").unwrap_or_else(|| "failed".into()),
                s("outputPath"),
                s("message"),
            )
        }
        Err(e) => ("failed".into(), None, Some(e)),
    }
}

/// Bộ theo dõi: giữ ảnh chụp trạng thái và chạy một vòng quét (`cycle`) hoặc vòng lặp tới khi dừng.
pub struct Watcher {
    pub snapshot: WatchSnapshot,
}

impl Watcher {
    pub fn new() -> Self {
        Watcher {
            snapshot: WatchSnapshot::default(),
        }
    }

    /// Một lượt quét và chạy hết các lô sẵn sàng. `stop` được hỏi giữa các bước; khi dừng, file chưa chạy được
    /// trả về hàng đợi (`release`). Lỗi lõi (quét hoặc ghi sổ) trả `Err`; file chưa xử lý cũng được trả.
    pub fn cycle(
        &mut self,
        api: &mut dyn WatchApi,
        run: &WatchRun<'_>,
        stop: &dyn Fn() -> bool,
        now_ms: &dyn Fn() -> u64,
    ) -> Result<(), String> {
        let mut leftovers: Vec<String> = Vec::new();
        let result = self.cycle_inner(api, run, stop, now_ms, &mut leftovers);
        if result.is_err() && !leftovers.is_empty() {
            // Giữ lỗi gốc, bỏ qua lỗi của chính lần trả file.
            let _ = api.release(&json!({ "ledgerPath": run.ledger_path, "paths": leftovers }));
        }
        result
    }

    fn cycle_inner(
        &mut self,
        api: &mut dyn WatchApi,
        run: &WatchRun<'_>,
        stop: &dyn Fn() -> bool,
        now_ms: &dyn Fn() -> u64,
        leftovers: &mut Vec<String>,
    ) -> Result<(), String> {
        let release = |api: &mut dyn WatchApi, files: &[String]| {
            if files.is_empty() {
                Ok(())
            } else {
                api.release(&json!({ "ledgerPath": run.ledger_path, "paths": files }))
            }
        };
        let scanned = api.scan(&watch_scan_params(run.config, run.ledger_path))?;
        *leftovers = paths(&scanned.ready);
        self.snapshot.pending = scanned.pending;
        self.snapshot.queued = scanned.ready.len();
        if stop() {
            release(api, leftovers)?;
            leftovers.clear();
            return Ok(());
        }
        let merge = is_merge(run.config);
        if merge && scanned.ready.len() < 2 {
            // Một file lẻ chờ đến lần quét sau (D42).
            release(api, leftovers)?;
            leftovers.clear();
        }
        let batches = plan_batches(merge, &scanned.ready);
        for (index, batch) in batches.iter().enumerate() {
            let remaining: usize = batches[index..].iter().map(Vec::len).sum();
            self.snapshot.current_file = Some(batch[0].path.clone());
            self.snapshot.queued = remaining;
            let request = json!({
                "workflow": run.config.workflow,
                "files": batch.iter().map(|f| json!({ "path": f.path })).collect::<Vec<_>>(),
                "variables": run.variables,
                "secrets": run.secrets,
                "output": watch_workflow_output(run.config),
            });
            let (status, output_path, message) = outcome_of(api.run(&request));
            *leftovers = batches[index + 1..]
                .iter()
                .flatten()
                .map(|f| f.path.clone())
                .collect();
            for file in batch {
                let mut p =
                    json!({ "ledgerPath": run.ledger_path, "path": file.path, "status": status });
                if let Some(o) = &output_path {
                    p["outputPath"] = json!(o);
                }
                api.mark_done(&p)?;
            }
            // Lô ghép cho một kết quả chung; chạy từng file cho một kết quả mỗi file.
            self.snapshot.recent.insert(
                0,
                WatchFileResult {
                    path: batch[0].path.clone(),
                    status,
                    output_path,
                    message,
                    completed_at_ms: now_ms(),
                },
            );
            self.snapshot.recent.truncate(RESULT_LIMIT);
            self.snapshot.queued = remaining.saturating_sub(batch.len());
            if stop() {
                break;
            }
        }
        if stop() && !leftovers.is_empty() {
            release(api, leftovers)?;
            leftovers.clear();
        }
        self.snapshot.current_file = None;
        self.snapshot.queued = 0;
        Ok(())
    }

    /// Lặp tới khi `stop()` trả true: quét, chạy, ngủ `watch_delay_ms(pollSeconds)`. Lỗi đặt trạng thái Error.
    pub fn run_loop(
        &mut self,
        api: &mut dyn WatchApi,
        run: &WatchRun<'_>,
        stop: &dyn Fn() -> bool,
        now_ms: &dyn Fn() -> u64,
        sleep_ms: &mut dyn FnMut(u64),
    ) {
        self.snapshot.status = WatchStatus::Running;
        self.snapshot.pending = 0;
        self.snapshot.queued = 0;
        self.snapshot.current_file = None;
        self.snapshot.error = None;
        while !stop() {
            if let Err(e) = self.cycle(api, run, stop, now_ms) {
                self.snapshot.status = WatchStatus::Error;
                self.snapshot.current_file = None;
                self.snapshot.queued = 0;
                self.snapshot.error = Some(e);
                return;
            }
            if stop() {
                break;
            }
            sleep_ms(watch_delay_ms(run.config.poll_seconds));
        }
        self.snapshot.status = WatchStatus::Stopped;
        self.snapshot.current_file = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    struct Fake {
        scans: Vec<ScanData>,
        calls: Vec<String>,
        run_fail_for: Option<String>,
        scan_error: bool,
        mark_error: bool,
    }

    impl Fake {
        fn new(scans: Vec<ScanData>) -> Self {
            Fake {
                scans,
                calls: Vec::new(),
                run_fail_for: None,
                scan_error: false,
                mark_error: false,
            }
        }
    }

    impl WatchApi for Fake {
        fn scan(&mut self, _p: &Value) -> Result<ScanData, String> {
            self.calls.push("scan".into());
            if self.scan_error {
                return Err("scan lỗi".into());
            }
            Ok(if self.scans.is_empty() {
                ScanData {
                    ready: vec![],
                    pending: 0,
                }
            } else {
                self.scans.remove(0)
            })
        }
        fn run(&mut self, r: &Value) -> Result<Value, String> {
            let files: Vec<&str> = r["files"]
                .as_array()
                .unwrap()
                .iter()
                .map(|f| f["path"].as_str().unwrap())
                .collect();
            self.calls.push(format!("run:{}", files.join("+")));
            if self.run_fail_for.as_deref() == Some(files[0]) {
                return Err("hỏng".into());
            }
            Ok(
                json!({ "results": [{ "status": "done", "outputPath": format!("out/{}", files[0]), "message": null }] }),
            )
        }
        fn mark_done(&mut self, p: &Value) -> Result<(), String> {
            self.calls.push(format!(
                "done:{}:{}",
                p["path"].as_str().unwrap(),
                p["status"].as_str().unwrap()
            ));
            if self.mark_error {
                Err("sổ lỗi".into())
            } else {
                Ok(())
            }
        }
        fn release(&mut self, p: &Value) -> Result<(), String> {
            let ps: Vec<&str> = p["paths"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_str().unwrap())
                .collect();
            self.calls.push(format!("release:{}", ps.join(",")));
            Ok(())
        }
    }

    fn file(p: &str) -> ReadyFile {
        ReadyFile {
            path: p.into(),
            size: 1,
            mtime_ns: 1,
        }
    }

    fn scan(files: &[&str], pending: u64) -> ScanData {
        ScanData {
            ready: files.iter().map(|f| file(f)).collect(),
            pending,
        }
    }

    fn config(merge: bool) -> WatchConfig {
        WatchConfig {
            source_folder: "in".into(),
            output_folder: "out".into(),
            workflow: json!({ "id": "w", "inputs": { "mode": if merge { "merge" } else { "each" } } }),
            poll_seconds: 5.0,
            settle_seconds: 2.0,
            pattern: "*.pdf".into(),
        }
    }

    fn run_of<'a>(c: &'a WatchConfig, v: &'a Value) -> WatchRun<'a> {
        WatchRun {
            config: c,
            variables: v,
            secrets: v,
            ledger_path: "in/.chef-watch-w.json",
        }
    }

    fn never() -> bool {
        false
    }
    fn clock() -> u64 {
        42
    }

    #[test]
    fn each_file_runs_once_and_is_marked() {
        let c = config(false);
        let v = json!({});
        let mut api = Fake::new(vec![scan(&["a.pdf", "b.pdf"], 3)]);
        let mut w = Watcher::new();
        w.cycle(&mut api, &run_of(&c, &v), &never, &clock).unwrap();
        assert_eq!(
            api.calls,
            [
                "scan",
                "run:a.pdf",
                "done:a.pdf:done",
                "run:b.pdf",
                "done:b.pdf:done"
            ]
        );
        assert_eq!(w.snapshot.pending, 3);
        assert_eq!(w.snapshot.recent.len(), 2);
        assert_eq!(w.snapshot.recent[0].path, "b.pdf", "mới nhất trước");
        assert_eq!(
            w.snapshot.recent[0].output_path.as_deref(),
            Some("out/b.pdf")
        );
        assert_eq!(w.snapshot.recent[0].completed_at_ms, 42);
        assert_eq!(
            (w.snapshot.queued, w.snapshot.current_file.clone()),
            (0, None)
        );
    }

    #[test]
    fn one_failure_does_not_stop_the_batch() {
        let c = config(false);
        let v = json!({});
        let mut api = Fake::new(vec![scan(&["a.pdf", "b.pdf"], 0)]);
        api.run_fail_for = Some("a.pdf".into());
        let mut w = Watcher::new();
        w.cycle(&mut api, &run_of(&c, &v), &never, &clock).unwrap();
        assert_eq!(
            api.calls,
            [
                "scan",
                "run:a.pdf",
                "done:a.pdf:failed",
                "run:b.pdf",
                "done:b.pdf:done"
            ]
        );
        assert_eq!(w.snapshot.recent[1].status, "failed");
        assert_eq!(w.snapshot.recent[1].message.as_deref(), Some("hỏng"));
    }

    #[test]
    fn merge_runs_once_on_the_whole_batch() {
        let c = config(true);
        let v = json!({});
        let mut api = Fake::new(vec![scan(&["a.pdf", "b.pdf", "c.pdf"], 0)]);
        let mut w = Watcher::new();
        w.cycle(&mut api, &run_of(&c, &v), &never, &clock).unwrap();
        assert_eq!(
            api.calls,
            [
                "scan",
                "run:a.pdf+b.pdf+c.pdf",
                "done:a.pdf:done",
                "done:b.pdf:done",
                "done:c.pdf:done"
            ]
        );
        assert_eq!(w.snapshot.recent.len(), 1, "một kết quả cho cả đợt");
    }

    #[test]
    fn lone_file_of_a_merge_workflow_waits() {
        let c = config(true);
        let v = json!({});
        let mut api = Fake::new(vec![scan(&["a.pdf"], 0)]);
        let mut w = Watcher::new();
        w.cycle(&mut api, &run_of(&c, &v), &never, &clock).unwrap();
        assert_eq!(api.calls, ["scan", "release:a.pdf"]);
        assert!(w.snapshot.recent.is_empty());
    }

    #[test]
    fn stop_between_batches_releases_the_rest() {
        let c = config(false);
        let v = json!({});
        let mut api = Fake::new(vec![scan(&["a.pdf", "b.pdf", "c.pdf"], 0)]);
        let ran = Cell::new(0);
        let stop = || ran.get() >= 1;
        // Giả lập người dùng bấm dừng sau khi lô đầu tiên chạy xong.
        struct Count<'a>(&'a Cell<u32>);
        let _ = Count(&ran);
        let calls_seen = Cell::new(false);
        let stop_after_first = || {
            if !calls_seen.get() && ran.get() == 0 {
                false
            } else {
                stop()
            }
        };
        // Đặt cờ ngay khi `run` đầu tiên được gọi: dùng bản Fake bọc.
        struct StopAfterRun<'a> {
            inner: Fake,
            ran: &'a Cell<u32>,
        }
        impl WatchApi for StopAfterRun<'_> {
            fn scan(&mut self, p: &Value) -> Result<ScanData, String> {
                self.inner.scan(p)
            }
            fn run(&mut self, r: &Value) -> Result<Value, String> {
                self.ran.set(self.ran.get() + 1);
                self.inner.run(r)
            }
            fn mark_done(&mut self, p: &Value) -> Result<(), String> {
                self.inner.mark_done(p)
            }
            fn release(&mut self, p: &Value) -> Result<(), String> {
                self.inner.release(p)
            }
        }
        let mut wrapped = StopAfterRun {
            inner: std::mem::replace(&mut api, Fake::new(vec![])),
            ran: &ran,
        };
        let mut w = Watcher::new();
        w.cycle(&mut wrapped, &run_of(&c, &v), &stop_after_first, &clock)
            .unwrap();
        assert_eq!(
            wrapped.inner.calls,
            [
                "scan",
                "run:a.pdf",
                "done:a.pdf:done",
                "release:b.pdf,c.pdf"
            ],
            "file đang chạy được ghi xong, phần còn lại trả về hàng đợi"
        );
    }

    #[test]
    fn stop_requested_before_any_run_releases_everything() {
        let c = config(false);
        let v = json!({});
        let mut api = Fake::new(vec![scan(&["a.pdf", "b.pdf"], 0)]);
        let mut w = Watcher::new();
        w.cycle(&mut api, &run_of(&c, &v), &|| true, &clock)
            .unwrap();
        assert_eq!(api.calls, ["scan", "release:a.pdf,b.pdf"]);
    }

    #[test]
    fn ledger_error_releases_unprocessed_files_and_reports() {
        let c = config(false);
        let v = json!({});
        let mut api = Fake::new(vec![scan(&["a.pdf", "b.pdf"], 0)]);
        api.mark_error = true;
        let mut w = Watcher::new();
        let err = w
            .cycle(&mut api, &run_of(&c, &v), &never, &clock)
            .unwrap_err();
        assert_eq!(err, "sổ lỗi");
        assert_eq!(api.calls.last().unwrap(), "release:b.pdf");
    }

    #[test]
    fn loop_sleeps_by_poll_interval_then_stops() {
        let c = config(false);
        let v = json!({});
        let mut api = Fake::new(vec![scan(&["a.pdf"], 0), scan(&[], 0)]);
        let sleeps = std::cell::RefCell::new(Vec::new());
        let n = Cell::new(0);
        // Dừng sau lần ngủ thứ hai.
        let stop = || n.get() >= 2;
        let mut sleep = |ms: u64| {
            sleeps.borrow_mut().push(ms);
            n.set(n.get() + 1);
        };
        let mut w = Watcher::new();
        w.run_loop(&mut api, &run_of(&c, &v), &stop, &clock, &mut sleep);
        assert_eq!(*sleeps.borrow(), vec![5000, 5000]);
        assert_eq!(w.snapshot.status, WatchStatus::Stopped);
        assert_eq!(w.snapshot.recent.len(), 1);
    }

    #[test]
    fn loop_error_sets_error_status() {
        let c = config(false);
        let v = json!({});
        let mut api = Fake::new(vec![]);
        api.scan_error = true;
        let mut w = Watcher::new();
        w.run_loop(&mut api, &run_of(&c, &v), &never, &clock, &mut |_| {});
        assert_eq!(w.snapshot.status, WatchStatus::Error);
        assert_eq!(w.snapshot.error.as_deref(), Some("scan lỗi"));
    }

    #[test]
    fn recent_results_are_capped() {
        let c = config(false);
        let v = json!({});
        let names: Vec<String> = (0..20).map(|i| format!("f{i}.pdf")).collect();
        let refs: Vec<&str> = names.iter().map(String::as_str).collect();
        let mut api = Fake::new(vec![scan(&refs, 0)]);
        let mut w = Watcher::new();
        w.cycle(&mut api, &run_of(&c, &v), &never, &clock).unwrap();
        assert_eq!(w.snapshot.recent.len(), RESULT_LIMIT);
        assert_eq!(w.snapshot.recent[0].path, "f19.pdf");
    }

    #[test]
    fn plan_batches_shapes() {
        let ready = [file("a"), file("b")];
        assert_eq!(plan_batches(false, &ready).len(), 2);
        assert_eq!(plan_batches(true, &ready).len(), 1);
        assert!(plan_batches(true, &ready[..1]).is_empty());
    }
}
