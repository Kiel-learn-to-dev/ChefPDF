//! Phần dùng chung của các hộp thoại xử lý M5 (TASKS_RUST R5.03 đến R5.08): ngữ cảnh viewer trao cho
//! hộp thoại, chạy một operation của lõi trên luồng nền (có hủy), dò số trang và dung lượng của một PDF,
//! và đọc kết quả `job.finished`.
//!
//! Hai kiểu operation:
//! - **Đọc / xuất file** (`file.merge`, `file.split`, `file.splitSmart`, `page.findBlank`): hộp thoại tự
//!   chạy và hiện kết quả. Không đổi revision của tài liệu đang mở.
//! - **Đổi revision** (`page.crop`, `page.resize`, `page.split`, `page.removeBlank`): hộp thoại không
//!   tự chạy mà phát [`ProcessEvent::ApplyRevision`]; viewer chạy qua `begin_edit` để vẽ lại trang, giữ
//!   hoàn tác và đối soát revision như mọi thao tác trang khác.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chef_rpc::ops::JobEnd;
use chef_rpc::{CallError, Supervisor};
use chef_ui::choice::{RadioGroup, RadioItem};
use chef_ui::i18n;
use chef_ui::task_dialog::{TaskDialog, TaskResult};
use chef_ui::text_input::{TextInput, TextInputEvent};
use gpui::{
    App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, SharedString, Subscription,
    Window,
};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::source_guard::Fingerprint;

/// Thời gian chờ tối đa một job (khớp `run_session_job` của viewer ở thao tác trang, nhưng xuất file
/// lớn lâu hơn nên cho rộng).
const JOB_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Ảnh chụp trạng thái viewer lúc mở hộp thoại. Hộp thoại không giữ tham chiếu tới viewer.
#[derive(Clone)]
pub struct ProcessContext {
    pub supervisor: Option<Arc<Mutex<Supervisor>>>,
    /// Phiên đang mở của tab (có khi tab đã có thao tác sửa).
    pub session_id: Option<String>,
    /// File gốc của tab, nếu có; dùng mở phiên tạm khi tab chưa có phiên.
    pub source: Option<PathBuf>,
    pub guard: Option<Fingerprint>,
    pub password: Option<Zeroizing<String>>,
    pub file_name: String,
    pub page_count: usize,
    /// Trang đang chọn hoặc trang hiện tại, tính từ 0.
    pub target_pages: Vec<usize>,
    /// Khổ từng trang theo pt, để gợi ý khung cắt và đổi khổ.
    pub page_sizes: Vec<(f32, f32)>,
    pub dirty: bool,
    /// Bookmark của tài liệu: (độ sâu từ 0, trang từ 1). `None` khi chưa đọc được.
    pub bookmarks: Option<Vec<(usize, usize)>>,
    pub initial_dir: Option<PathBuf>,
    pub dark: bool,
}

impl ProcessContext {
    /// Trang đầu (từ 1) của các bookmark ở `level` (1 là cấp cao nhất). `None` khi chưa có bookmark.
    pub fn bookmark_starts(&self, level: usize) -> Option<Vec<usize>> {
        let marks = self.bookmarks.as_ref()?;
        Some(
            marks
                .iter()
                .filter(|(depth, _)| depth + 1 == level)
                .map(|(_, page)| *page)
                .collect(),
        )
    }

    /// Đích chạy cho operation cần tài liệu: phiên đang mở, hoặc phiên tạm mở từ file gốc.
    pub fn target(&self) -> Target {
        if let Some(id) = &self.session_id {
            return Target::Session(id.clone());
        }
        match (&self.source, &self.guard) {
            (Some(path), Some(guard)) => Target::Source {
                path: path.clone(),
                guard: guard.clone(),
                password: self.password.clone(),
            },
            _ => Target::None,
        }
    }
}

/// Nơi operation chạy.
#[derive(Clone)]
pub enum Target {
    /// Operation `standalone` (ví dụ `file.merge`, `file.splitSmart`): không cần tài liệu.
    None,
    Session(String),
    /// Mở phiên tạm từ file gốc, chạy rồi đóng.
    Source {
        path: PathBuf,
        guard: Fingerprint,
        password: Option<Zeroizing<String>>,
    },
}

/// Sự kiện hộp thoại phát cho viewer.
pub enum ProcessEvent {
    /// Đóng hộp thoại.
    Close,
    /// Chạy operation đổi revision bằng đường `begin_edit` của viewer rồi đóng hộp thoại.
    ApplyRevision { op_id: &'static str, params: Value },
    /// Mở file kết quả thành tab mới.
    OpenFile(PathBuf),
}

/// Kết quả một job đã xong.
#[derive(Debug, Clone, PartialEq)]
pub struct JobOk {
    pub outputs: Vec<String>,
    pub warnings: Vec<String>,
    pub data: Value,
    pub changed_pages: Value,
}

impl JobOk {
    /// Đọc `result` của `job.finished`: `{ state, changedPages, warnings, outputs, data? }`.
    pub fn from_result(result: &Value) -> JobOk {
        let strings = |key: &str| -> Vec<String> {
            result
                .get(key)
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default()
        };
        JobOk {
            outputs: strings("outputs"),
            warnings: strings("warnings"),
            data: result.get("data").cloned().unwrap_or(Value::Null),
            changed_pages: result.get("changedPages").cloned().unwrap_or(Value::Null),
        }
    }
}

/// Màu chữ và viền dùng chung của phần viết tay trong hộp thoại, đã đóng gói RRGGBBAA.
#[derive(Clone, Copy)]
pub struct Colors {
    pub border: u32,
    pub text: u32,
    pub muted: u32,
    pub danger: u32,
}

impl Colors {
    pub fn of(dark: bool) -> Self {
        use chef_theme::{dark as d, light as l};
        use chef_ui::button::pack;
        if dark {
            Self {
                border: pack(d::C_BORDER),
                text: pack(d::C_TEXT),
                muted: pack(d::C_TEXT_2),
                danger: pack(d::C_DANGER),
            }
        } else {
            Self {
                border: pack(l::C_BORDER),
                text: pack(l::C_TEXT),
                muted: pack(l::C_TEXT_2),
                danger: pack(l::C_DANGER),
            }
        }
    }
}

/// Ô giữ `jobId` đang chạy để nút Dừng hủy đúng job.
pub type JobSlot = Arc<Mutex<Option<String>>>;

pub fn error_text(error: CallError) -> String {
    match error {
        CallError::Rpc(value) => {
            let kind = chef_rpc::errors::kind_of(&value);
            i18n::t(&chef_rpc::errors::message_key(kind))
        }
        CallError::Timeout | CallError::Closed | CallError::Io(_) => {
            i18n::t("editor.coreUnavailable")
        }
    }
}

/// Lỗi một job: chuỗi đã dịch, hoặc `Cancelled` khi người dùng dừng.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobFail {
    Cancelled,
    Failed(String),
}

/// Đổi kết thúc của job thành kết quả. Tách riêng để test không cần lõi.
pub fn interpret_end(end: JobEnd) -> Result<JobOk, JobFail> {
    match end {
        JobEnd::Finished(result) => Ok(JobOk::from_result(&result)),
        JobEnd::Failed(error) => {
            let kind = chef_rpc::errors::kind_of(&error).to_string();
            Err(JobFail::Failed(i18n::t(&chef_rpc::errors::message_key(
                &kind,
            ))))
        }
        JobEnd::Cancelled => Err(JobFail::Cancelled),
        JobEnd::TimedOut | JobEnd::Stopped => {
            Err(JobFail::Failed(i18n::t("editor.operationFailed")))
        }
    }
}

fn lock(
    supervisor: &Arc<Mutex<Supervisor>>,
) -> Result<std::sync::MutexGuard<'_, Supervisor>, JobFail> {
    supervisor
        .lock()
        .map_err(|_| JobFail::Failed(i18n::t("editor.coreUnavailable")))
}

fn close_session(supervisor: &Arc<Mutex<Supervisor>>, session_id: &str) {
    if let Ok(sup) = supervisor.lock()
        && sup
            .request("session.close", &json!({ "sessionId": session_id }))
            .is_ok()
    {
        sup.session_closed(session_id);
    }
}

/// Chạy `op_id` và chờ kết thúc. Chặn luồng gọi, nên gọi từ luồng nền. `slot` nhận `jobId` ngay khi có
/// để [`cancel`] dừng được job.
pub fn run_blocking(
    supervisor: &Arc<Mutex<Supervisor>>,
    target: &Target,
    op_id: &str,
    params: &Value,
    slot: &JobSlot,
) -> Result<JobOk, JobFail> {
    let mut temp_session: Option<String> = None;
    let outcome = (|| {
        let sup = lock(supervisor)?;
        let session_id = match target {
            Target::None => None,
            Target::Session(id) => Some(id.clone()),
            Target::Source {
                path,
                guard,
                password,
            } => {
                let opened = crate::session::open(&sup, path, guard, password.as_ref())
                    .map_err(open_error_text)?;
                temp_session = Some(opened.session_id.clone());
                Some(opened.session_id)
            }
        };
        let job_id = chef_rpc::ops::start(&sup, op_id, session_id.as_deref(), params)
            .map_err(|e| JobFail::Failed(error_text(e)))?;
        if let Ok(mut guard) = slot.lock() {
            *guard = Some(job_id.clone());
        }
        let waiter = sup.waiter();
        drop(sup);
        let end = chef_rpc::ops::wait_job_with_waiter(&waiter, &job_id, JOB_TIMEOUT);
        interpret_end(end)
    })();
    if let Ok(mut guard) = slot.lock() {
        *guard = None;
    }
    if let Some(id) = temp_session {
        close_session(supervisor, &id);
    }
    outcome
}

fn open_error_text(error: crate::session::OpenError) -> JobFail {
    use crate::session::OpenError;
    JobFail::Failed(match error {
        OpenError::SourceChanged(_) => i18n::t("sourceGuard.changed"),
        OpenError::Core { kind } => i18n::t(&chef_rpc::errors::message_key(&kind)),
        OpenError::Unavailable(_) => i18n::t("editor.coreUnavailable"),
    })
}

/// Hủy job đang chạy (nếu đã có `jobId`). Job kết thúc bằng `job.cancelled`.
pub fn cancel(supervisor: &Arc<Mutex<Supervisor>>, slot: &JobSlot) {
    let Some(id) = slot.lock().ok().and_then(|g| g.clone()) else {
        return;
    };
    if let Ok(sup) = supervisor.lock() {
        let _ = chef_rpc::ops::cancel(&sup, &id);
    }
}

/// Trạng thái chạy chung của một hộp thoại xử lý: đang chạy, hỏi xác nhận dừng, kết quả, `jobId`.
#[derive(Default)]
pub struct Runner {
    pub running: bool,
    pub confirm_cancel: bool,
    pub result: Option<TaskResult>,
    pub slot: JobSlot,
    /// Tăng mỗi lần chạy; kết quả của lần chạy đã bỏ không được ghi đè trạng thái mới.
    pub seq: u64,
}

impl Runner {
    /// Bắt đầu một lần chạy, trả số thứ tự của lần chạy.
    pub fn begin(&mut self) -> u64 {
        self.seq += 1;
        self.running = true;
        self.confirm_cancel = false;
        self.result = None;
        self.seq
    }

    /// Kết thúc lần chạy `seq`. `false` khi lần chạy đó đã bị bỏ (đóng hộp thoại, chạy lại).
    pub fn finish(&mut self, seq: u64) -> bool {
        if seq != self.seq || !self.running {
            return false;
        }
        self.running = false;
        self.confirm_cancel = false;
        true
    }

    /// Bỏ lần chạy hiện tại mà không chờ kết quả.
    pub fn abandon(&mut self) {
        self.seq += 1;
        self.running = false;
        self.confirm_cancel = false;
    }
}

/// Chạy `op_id` trên luồng nền và gọi `done` trên luồng giao diện khi xong. `access` lấy [`Runner`] từ
/// entity chủ. Không có lõi thì `done` được gọi ngay với lỗi.
pub fn spawn_job<T: 'static>(
    me: &mut T,
    cx: &mut Context<T>,
    access: fn(&mut T) -> &mut Runner,
    ctx: &ProcessContext,
    op_id: &'static str,
    params: Value,
    done: impl FnOnce(&mut T, Result<JobOk, JobFail>, &mut Context<T>) + 'static,
) {
    let runs = vec![(ctx.target(), params)];
    spawn_jobs(me, cx, access, ctx, op_id, runs, move |me, outcome, cx| {
        done(
            me,
            outcome.map(|mut all| {
                all.pop()
                    .unwrap_or_else(|| JobOk::from_result(&Value::Null))
            }),
            cx,
        );
    });
}

/// Như [`spawn_job`] nhưng chạy tuần tự nhiều lần (mỗi lần một đích và tham số). Dừng ở lần đầu lỗi
/// hoặc bị hủy; kết quả là danh sách theo thứ tự.
pub fn spawn_jobs<T: 'static>(
    me: &mut T,
    cx: &mut Context<T>,
    access: fn(&mut T) -> &mut Runner,
    ctx: &ProcessContext,
    op_id: &'static str,
    runs: Vec<(Target, Value)>,
    done: impl FnOnce(&mut T, Result<Vec<JobOk>, JobFail>, &mut Context<T>) + 'static,
) {
    let seq = access(me).begin();
    let slot = access(me).slot.clone();
    let Some(supervisor) = ctx.supervisor.clone() else {
        access(me).finish(seq);
        done(
            me,
            Err(JobFail::Failed(i18n::t("editor.coreUnavailable"))),
            cx,
        );
        return;
    };
    let task = cx.background_executor().spawn(async move {
        let mut all = Vec::new();
        for (target, params) in &runs {
            all.push(run_blocking(&supervisor, target, op_id, params, &slot)?);
        }
        Ok(all)
    });
    cx.spawn(async move |this, cx| {
        let outcome = task.await;
        let _ = this.update(cx, |me, cx| {
            if access(me).finish(seq) {
                done(me, outcome, cx);
            }
        });
    })
    .detach();
}

/// Hộp thoại xử lý: có `Runner`, ngữ cảnh và phát [`ProcessEvent`]. Dùng với [`wire`].
pub trait ProcessView: EventEmitter<ProcessEvent> + Sized + 'static {
    fn runner(&self) -> &Runner;
    fn runner_mut(&mut self) -> &mut Runner;
    fn context(&self) -> &ProcessContext;

    /// Yêu cầu lõi hủy job đang chạy; job kết thúc bằng `job.cancelled`.
    fn cancel_run(&mut self, cx: &mut Context<Self>) {
        if let Some(sup) = self.context().supervisor.clone() {
            let slot = self.runner().slot.clone();
            cancel(&sup, &slot);
        }
        cx.notify();
    }
}

/// Nối các điều khiển chung của `TaskDialog` (chạy, dừng, đóng, xác nhận dừng khi đóng lúc đang chạy,
/// kết quả) với entity `entity`. `run` là hành động của nút chạy.
pub fn wire<T: ProcessView>(
    dialog: TaskDialog,
    view: &T,
    cx: &Context<T>,
    run: fn(&mut T, &mut Context<T>),
) -> TaskDialog {
    let entity = cx.entity();
    let (run_e, cancel_e, close_e, req_e, keep_e, stop_e) = (
        entity.clone(),
        entity.clone(),
        entity.clone(),
        entity.clone(),
        entity.clone(),
        entity,
    );
    let runner = view.runner();
    let mut dialog = dialog
        .running(runner.running)
        .confirm_cancel_open(runner.confirm_cancel)
        .on_run(move |_, cx| {
            run_e.update(cx, run);
        })
        .on_cancel_run(move |_, cx| {
            cancel_e.update(cx, |me, cx| me.cancel_run(cx));
        })
        .on_close(move |_, cx| {
            close_e.update(cx, |_, cx| cx.emit(ProcessEvent::Close));
        })
        .on_request_cancel_confirm(move |_, cx| {
            req_e.update(cx, |me, cx| {
                me.runner_mut().confirm_cancel = true;
                cx.notify();
            });
        })
        .on_keep_running(move |_, cx| {
            keep_e.update(cx, |me, cx| {
                me.runner_mut().confirm_cancel = false;
                cx.notify();
            });
        })
        .on_confirm_cancel_close(move |_, cx| {
            stop_e.update(cx, |me, cx| {
                me.cancel_run(cx);
                me.runner_mut().abandon();
                cx.emit(ProcessEvent::Close);
            });
        });
    if let Some(result) = runner.result.clone() {
        dialog = dialog.result(result);
    }
    dialog
}

/// Ô nhập một dòng có sẵn chữ; mỗi lần đổi thì vẽ lại hộp thoại. Đăng ký nghe vào `subs`.
pub fn text_entity<T: 'static>(
    cx: &mut Context<T>,
    subs: &mut Vec<Subscription>,
    text: &str,
    placeholder: impl Into<SharedString>,
) -> Entity<TextInput> {
    let placeholder = placeholder.into();
    let entity = cx.new(|cx| {
        let mut input = TextInput::new(cx, placeholder);
        input.set_text(text, cx);
        input
    });
    subs.push(cx.subscribe(&entity, |_, _, event: &TextInputEvent, cx| {
        if matches!(event, TextInputEvent::Changed) {
            cx.notify();
        }
    }));
    entity
}

/// Nhóm nút chọn một từ danh sách nhãn; `focus` có cùng độ dài với `labels`. `(dark, horizontal)` là
/// giao diện tối và xếp ngang.
pub fn radios(
    id: &'static str,
    name: impl Into<SharedString>,
    labels: Vec<String>,
    focus: &[FocusHandle],
    selected: usize,
    (dark, horizontal): (bool, bool),
    on_change: impl Fn(usize, &mut Window, &mut App) + 'static,
) -> RadioGroup {
    let items = labels
        .into_iter()
        .zip(focus)
        .enumerate()
        .map(|(index, (label, focus))| RadioItem::new((id, index as u32), focus.clone(), label))
        .collect();
    RadioGroup::new(id, name, items)
        .selected(Some(selected))
        .horizontal(horizontal)
        .dark(dark)
        .on_change(on_change)
}

/// `n` tiêu điểm mới cho một nhóm chọn.
pub fn focus_handles<T: 'static>(cx: &mut Context<T>, n: usize) -> Vec<FocusHandle> {
    (0..n).map(|_| cx.focus_handle()).collect()
}

/// Số thực kiểu `vi`: chấp nhận dấu phẩy thập phân. `None` nếu không phải số hữu hạn.
pub fn parse_decimal(text: &str) -> Option<f64> {
    let value: f64 = text.trim().replace(',', ".").parse().ok()?;
    value.is_finite().then_some(value)
}

/// Thông tin một PDF dò được.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProbedPdf {
    pub page_count: usize,
    pub file_size: u64,
}

/// Vì sao không dò được một PDF.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeError {
    PasswordRequired,
    PasswordInvalid,
    /// Lỗi khác; chuỗi đã dịch.
    Message(String),
}

/// Phân loại lỗi RPC khi mở file: cần mật khẩu, sai mật khẩu, hay lỗi khác.
pub fn classify_open_error(error: CallError) -> ProbeError {
    if let CallError::Rpc(value) = &error {
        match chef_rpc::errors::kind_of(value) {
            "PASSWORD_REQUIRED" => return ProbeError::PasswordRequired,
            "PASSWORD_INVALID" => return ProbeError::PasswordInvalid,
            _ => {}
        }
    }
    ProbeError::Message(error_text(error))
}

/// Dò số trang và dung lượng bằng phiên tạm (hợp đồng chưa có "info không cần phiên", như Electron).
/// `password` là mật khẩu mở file nếu có.
pub fn probe_pdf(
    supervisor: &Arc<Mutex<Supervisor>>,
    path: &Path,
    password: Option<&str>,
) -> Result<ProbedPdf, ProbeError> {
    let mut params = json!({ "path": path.display().to_string() });
    if let Some(password) = password {
        params["password"] = Value::String(password.to_string());
    }
    let reply = {
        let sup = supervisor
            .lock()
            .map_err(|_| ProbeError::Message(i18n::t("editor.coreUnavailable")))?;
        sup.request("session.open", &params)
            .map_err(classify_open_error)?
    };
    if let Some(id) = reply.pointer("/state/sessionId").and_then(Value::as_str) {
        if let Ok(sup) = supervisor.lock() {
            sup.session_opened(id);
        }
        close_session(supervisor, id);
    }
    parse_probe(&reply).ok_or_else(|| ProbeError::Message(i18n::t("errors.INTERNAL")))
}

/// `info.pageCount` và `info.fileSize` của `session.open`.
pub fn parse_probe(reply: &Value) -> Option<ProbedPdf> {
    let info = reply.get("info")?;
    Some(ProbedPdf {
        page_count: usize::try_from(info.get("pageCount")?.as_u64()?).ok()?,
        file_size: info.get("fileSize").and_then(Value::as_u64).unwrap_or(0),
    })
}

/// Tên file không đuôi: "C:\\a\\bao-cao.pdf" thành "bao-cao". Chịu cả hai kiểu dấu phân cách.
pub fn file_stem(path: &str) -> String {
    let name = chef_ui::task_dialog::display_basename(path);
    match name.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem.to_string(),
        _ => name.to_string(),
    }
}

/// Thư mục chứa file (cả hai kiểu dấu phân cách). Rỗng khi không có.
pub fn parent_dir(path: &str) -> String {
    match path.rfind(['\\', '/']) {
        Some(0) => path[..1].to_string(),
        Some(i) => path[..i].to_string(),
        None => String::new(),
    }
}

/// Nối thư mục và tên file theo kiểu dấu phân cách của thư mục đó.
pub fn join_path(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        return name.to_string();
    }
    let sep = if dir.contains('\\') { '\\' } else { '/' };
    if dir.ends_with(['\\', '/']) {
        format!("{dir}{name}")
    } else {
        format!("{dir}{sep}{name}")
    }
}

/// Mở thư mục chứa file và chọn file đó (Explorer trên Windows, Finder trên macOS).
pub fn reveal_in_folder(path: &str) {
    #[cfg(windows)]
    let result = {
        use std::os::windows::process::CommandExt;
        // `raw_arg`: Explorer cần đúng dạng /select,"đường dẫn" kể cả khi có dấu cách.
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{path}\""))
            .spawn()
    };
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open")
        .args(["-R", path])
        .spawn();
    #[cfg(not(any(windows, target_os = "macos")))]
    let result: std::io::Result<std::process::Child> = {
        let _ = path;
        Err(std::io::ErrorKind::Unsupported.into())
    };
    let _ = result;
}

/// "1,5 MB" như `formatBytes` của Electron (chung với hộp thoại Thuộc tính).
pub fn format_bytes(bytes: u64) -> String {
    crate::properties::format_bytes(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_outputs_warnings_and_data_from_a_finished_job() {
        let ok = JobOk::from_result(&json!({
            "state": {},
            "changedPages": [],
            "warnings": ["Trang 1 lớn"],
            "outputs": ["C:\\out\\a.pdf", "C:\\out\\b.pdf"],
            "data": { "parts": 2 }
        }));
        assert_eq!(ok.outputs.len(), 2);
        assert_eq!(ok.warnings, ["Trang 1 lớn"]);
        assert_eq!(ok.data["parts"], 2);
        assert_eq!(ok.changed_pages, json!([]));
        // Thiếu trường thì rỗng, không lỗi.
        let empty = JobOk::from_result(&json!({}));
        assert!(empty.outputs.is_empty() && empty.data.is_null());
    }

    #[test]
    fn interprets_every_job_end() {
        assert!(matches!(
            interpret_end(JobEnd::Finished(json!({ "outputs": ["x"] }))),
            Ok(ok) if ok.outputs == ["x"]
        ));
        assert_eq!(interpret_end(JobEnd::Cancelled), Err(JobFail::Cancelled));
        assert!(matches!(
            interpret_end(JobEnd::Failed(
                json!({ "code": -32602, "message": "x", "data": { "kind": "INVALID_PARAMS" } })
            )),
            Err(JobFail::Failed(text)) if !text.is_empty()
        ));
        assert!(matches!(
            interpret_end(JobEnd::TimedOut),
            Err(JobFail::Failed(_))
        ));
    }

    #[test]
    fn parses_page_count_and_size_from_session_open() {
        let probe = parse_probe(&json!({
            "state": { "sessionId": "s1" },
            "info": { "pageCount": 12, "fileSize": 4096 }
        }))
        .unwrap();
        assert_eq!(
            probe,
            ProbedPdf {
                page_count: 12,
                file_size: 4096
            }
        );
        assert!(parse_probe(&json!({ "info": {} })).is_none());
        assert!(parse_probe(&json!({})).is_none());
    }

    #[test]
    fn classifies_password_errors_from_the_core() {
        let rpc = |kind: &str| {
            CallError::Rpc(json!({ "code": -32000, "message": "x", "data": { "kind": kind } }))
        };
        assert_eq!(
            classify_open_error(rpc("PASSWORD_REQUIRED")),
            ProbeError::PasswordRequired
        );
        assert_eq!(
            classify_open_error(rpc("PASSWORD_INVALID")),
            ProbeError::PasswordInvalid
        );
        assert!(matches!(
            classify_open_error(rpc("INVALID_PARAMS")),
            ProbeError::Message(_)
        ));
        assert!(matches!(
            classify_open_error(CallError::Timeout),
            ProbeError::Message(_)
        ));
    }

    #[test]
    fn lists_bookmark_starts_by_level() {
        let ctx = ProcessContext {
            supervisor: None,
            session_id: None,
            source: None,
            guard: None,
            password: None,
            file_name: String::new(),
            page_count: 10,
            target_pages: Vec::new(),
            page_sizes: Vec::new(),
            dirty: false,
            bookmarks: Some(vec![(0, 1), (1, 2), (0, 5), (1, 6)]),
            initial_dir: None,
            dark: false,
        };
        assert_eq!(ctx.bookmark_starts(1), Some(vec![1, 5]));
        assert_eq!(ctx.bookmark_starts(2), Some(vec![2, 6]));
        assert_eq!(ctx.bookmark_starts(3), Some(vec![]));
        let none = ProcessContext {
            bookmarks: None,
            ..ctx
        };
        assert_eq!(none.bookmark_starts(1), None);
    }

    #[test]
    fn splits_windows_and_posix_paths() {
        assert_eq!(file_stem(r"C:\docs\bao-cao.v2.pdf"), "bao-cao.v2");
        assert_eq!(file_stem("/tmp/a.pdf"), "a");
        assert_eq!(file_stem("noext"), "noext");
        assert_eq!(parent_dir(r"C:\docs\a.pdf"), r"C:\docs");
        assert_eq!(parent_dir("/a.pdf"), "/");
        assert_eq!(parent_dir("a.pdf"), "");
        assert_eq!(join_path(r"C:\docs", "a.pdf"), r"C:\docs\a.pdf");
        assert_eq!(join_path(r"C:\docs\", "a.pdf"), r"C:\docs\a.pdf");
        assert_eq!(join_path("/tmp", "a.pdf"), "/tmp/a.pdf");
        assert_eq!(join_path("", "a.pdf"), "a.pdf");
    }
}
