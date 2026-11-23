//! Chạy một thao tác độc lập (không cần phiên tài liệu) ở luồng nền và báo kết quả về thực thể giao
//! diện (TASKS_RUST R5.03 trở đi). Dùng chung cho các hộp thoại xử lý: gửi `ops.run`, ghi mã job để
//! dừng được, chờ kết thúc, rồi đọc kênh kết quả định kỳ.

use std::sync::mpsc::{Receiver, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use gpui::Context;

use chef_rpc::{CallError, Supervisor};
use chef_ui::i18n::t;

const JOB_TIMEOUT: Duration = Duration::from_secs(600);
const POLL: Duration = Duration::from_millis(100);

/// Mã job đang chạy, chia sẻ giữa luồng nền và giao diện để dừng được.
pub type JobSlot = Arc<Mutex<Option<String>>>;

pub enum Outcome {
    /// `result` của job (`{ state, outputs, warnings, data }`).
    Done(serde_json::Value),
    Cancelled,
    Failed(String),
}

pub fn call_error_text(error: CallError) -> String {
    match error {
        CallError::Rpc(value) => t(&chef_rpc::errors::message_key(chef_rpc::errors::kind_of(
            &value,
        ))),
        CallError::Timeout | CallError::Closed | CallError::Io(_) => t("editor.coreUnavailable"),
    }
}

/// Gửi `op_id` với `params`, ghi mã job vào `slot`, chờ kết quả. Chạy ở luồng nền.
pub fn run_standalone(
    supervisor: &Arc<Mutex<Supervisor>>,
    op_id: &str,
    params: &serde_json::Value,
    slot: &JobSlot,
) -> Outcome {
    let Ok(sup) = supervisor.lock() else {
        return Outcome::Failed(t("editor.coreUnavailable"));
    };
    let id = match chef_rpc::ops::start(&sup, op_id, None, params) {
        Ok(id) => id,
        Err(error) => return Outcome::Failed(call_error_text(error)),
    };
    let waiter = sup.waiter();
    drop(sup);
    if let Ok(mut s) = slot.lock() {
        *s = Some(id.clone());
    }
    match chef_rpc::ops::wait_job_with_waiter(&waiter, &id, JOB_TIMEOUT) {
        chef_rpc::ops::JobEnd::Finished(v) => Outcome::Done(v),
        chef_rpc::ops::JobEnd::Failed(error) => {
            Outcome::Failed(call_error_text(CallError::Rpc(error)))
        }
        chef_rpc::ops::JobEnd::Cancelled => Outcome::Cancelled,
        chef_rpc::ops::JobEnd::TimedOut | chef_rpc::ops::JobEnd::Stopped => {
            Outcome::Failed(t("editor.coreUnavailable"))
        }
    }
}

/// Dừng job đang chạy (hợp tác): kết quả `Cancelled` về qua kênh như bình thường.
pub fn cancel(supervisor: &Option<Arc<Mutex<Supervisor>>>, slot: &JobSlot) {
    let (Some(supervisor), Some(id)) =
        (supervisor.clone(), slot.lock().ok().and_then(|g| g.clone()))
    else {
        return;
    };
    std::thread::spawn(move || {
        if let Ok(sup) = supervisor.lock() {
            let _ = chef_rpc::ops::cancel(&sup, &id);
        }
    });
}

/// Bắt đầu job ở luồng nền và gọi `on_done` trên thực thể khi xong.
pub fn spawn_job<T: 'static>(
    supervisor: Arc<Mutex<Supervisor>>,
    op_id: String,
    params: serde_json::Value,
    slot: JobSlot,
    cx: &mut Context<T>,
    on_done: impl FnOnce(&mut T, Outcome, &mut Context<T>) + 'static,
) {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(run_standalone(&supervisor, &op_id, &params, &slot));
    });
    watch(rx, cx, on_done);
}

/// Đọc kênh kết quả mỗi 100 ms cho tới khi job xong.
fn watch<T: 'static>(
    rx: Receiver<Outcome>,
    cx: &mut Context<T>,
    on_done: impl FnOnce(&mut T, Outcome, &mut Context<T>) + 'static,
) {
    cx.spawn(async move |this, cx| {
        let outcome = loop {
            cx.background_executor().timer(POLL).await;
            match rx.try_recv() {
                Ok(o) => break o,
                Err(TryRecvError::Empty) => continue,
                Err(TryRecvError::Disconnected) => {
                    break Outcome::Failed(t("editor.coreUnavailable"));
                }
            }
        };
        let _ = this.update(cx, |state, cx| on_done(state, outcome, cx));
    })
    .detach();
}
