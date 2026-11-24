//! Xem trước scan (TASKS_RUST R5.25; FEATURES K-preview): port `previewScheduler.ts`. Bộ lập lịch có
//! debounce, bản mới nhất thắng: tối đa một lần chạy cùng lúc; yêu cầu mới hủy lần đang chạy và chỉ chạy bản
//! mới nhất khi lần cũ đã dứt; kết quả của lần bị thay thế bị bỏ. Lõi xóa ảnh xem trước cũ ở mỗi lần chạy nên
//! hai lần chạy không bao giờ chồng nhau. Máy trạng thái thuần: gọi sự kiện, nhận danh sách hiệu ứng để
//! thực hiện (đặt timer, chạy job, hủy job, giao kết quả). Không phụ thuộc timer hay RPC thật.
#![allow(dead_code)]

/// Thời gian chờ mặc định giữa lần chỉnh cuối và lần chạy, ms.
pub const DEBOUNCE_MS: u64 = 400;

/// Việc bên ngoài phải làm.
#[derive(Debug, Clone, PartialEq)]
pub enum Effect<P> {
    /// Hủy timer đang đặt.
    ClearTimer,
    /// Đặt timer; khi hết giờ gọi `timer_fired`.
    StartTimer(u64),
    /// Hủy hợp tác một job đã bắt đầu.
    Cancel(String),
    /// Chạy xem trước với tham số này; báo `job_started(seq, id)` khi lõi nhận, `finished(seq, ..)` khi dứt.
    Run { seq: u64, params: P },
    /// Giao kết quả của lần chạy `seq` cho giao diện.
    DeliverResult(u64),
    /// Giao lỗi của lần chạy `seq` cho giao diện.
    DeliverError(u64),
}

/// Cách một lần chạy dứt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Ok,
    Error,
    /// Lỗi do chủ ý hủy: bỏ qua.
    Cancelled,
}

#[derive(Debug, Clone)]
struct Flight {
    seq: u64,
    job_id: Option<String>,
    cancelled: bool,
}

#[derive(Debug, Clone)]
pub struct PreviewScheduler<P> {
    seq: u64,
    latest: Option<(P, u64)>,
    due: bool,
    timer_set: bool,
    in_flight: Option<Flight>,
    disposed: bool,
    debounce_ms: u64,
}

impl<P: Clone> Default for PreviewScheduler<P> {
    fn default() -> Self {
        Self::new(DEBOUNCE_MS)
    }
}

impl<P: Clone> PreviewScheduler<P> {
    pub fn new(debounce_ms: u64) -> Self {
        PreviewScheduler {
            seq: 0,
            latest: None,
            due: false,
            timer_set: false,
            in_flight: None,
            disposed: false,
            debounce_ms,
        }
    }

    /// Có lần chạy đang bay không.
    pub fn is_running(&self) -> bool {
        self.in_flight.is_some()
    }

    fn cancel_flight(&mut self, out: &mut Vec<Effect<P>>) {
        if let Some(f) = self.in_flight.as_mut() {
            if f.cancelled {
                return;
            }
            f.cancelled = true;
            if let Some(id) = &f.job_id {
                out.push(Effect::Cancel(id.clone()));
            }
        }
    }

    /// Yêu cầu xem trước với tham số mới.
    pub fn request(&mut self, params: P) -> Vec<Effect<P>> {
        let mut out = Vec::new();
        if self.disposed {
            return out;
        }
        self.seq += 1;
        self.latest = Some((params, self.seq));
        self.due = false;
        if self.timer_set {
            out.push(Effect::ClearTimer);
        }
        self.timer_set = true;
        out.push(Effect::StartTimer(self.debounce_ms));
        self.cancel_flight(&mut out);
        out
    }

    /// Timer hết giờ.
    pub fn timer_fired(&mut self) -> Vec<Effect<P>> {
        self.timer_set = false;
        self.due = true;
        self.pump()
    }

    /// Dừng tất cả: timer, job đang chạy, mọi yêu cầu về sau.
    pub fn dispose(&mut self) -> Vec<Effect<P>> {
        let mut out = Vec::new();
        self.disposed = true;
        if self.timer_set {
            out.push(Effect::ClearTimer);
            self.timer_set = false;
        }
        self.cancel_flight(&mut out);
        out
    }

    /// Lõi đã nhận job `job_id` của lần chạy `seq`. Nếu lần đó đã bị hủy thì hủy luôn job.
    pub fn job_started(&mut self, seq: u64, job_id: &str) -> Vec<Effect<P>> {
        match self.in_flight.as_mut() {
            Some(f) if f.seq == seq => {
                f.job_id = Some(job_id.to_string());
                if f.cancelled {
                    return vec![Effect::Cancel(job_id.to_string())];
                }
                Vec::new()
            }
            _ => Vec::new(),
        }
    }

    /// Lần chạy `seq` đã dứt. Chỉ giao kết quả khi nó còn là bản mới nhất; rồi chạy tiếp bản đang chờ.
    pub fn finished(&mut self, seq: u64, outcome: Outcome) -> Vec<Effect<P>> {
        let mut out = Vec::new();
        let current = !self.disposed
            && self
                .in_flight
                .as_ref()
                .is_some_and(|f| f.seq == seq && !f.cancelled)
            && self.latest.as_ref().is_some_and(|(_, s)| *s == seq);
        if current {
            match outcome {
                Outcome::Ok => out.push(Effect::DeliverResult(seq)),
                Outcome::Error => out.push(Effect::DeliverError(seq)),
                Outcome::Cancelled => {}
            }
        }
        if self.in_flight.as_ref().is_some_and(|f| f.seq == seq) {
            self.in_flight = None;
        }
        out.extend(self.pump());
        out
    }

    fn pump(&mut self) -> Vec<Effect<P>> {
        if self.disposed || self.in_flight.is_some() || !self.due {
            return Vec::new();
        }
        let Some((params, seq)) = self.latest.clone() else {
            return Vec::new();
        };
        self.due = false;
        self.in_flight = Some(Flight {
            seq,
            job_id: None,
            cancelled: false,
        });
        vec![Effect::Run { seq, params }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Effect::*;

    type S = PreviewScheduler<&'static str>;

    #[test]
    fn request_sets_a_debounce_timer_and_run_waits_for_it() {
        let mut s = S::default();
        assert_eq!(s.request("a"), vec![StartTimer(400)]);
        assert!(!s.is_running());
        assert_eq!(
            s.timer_fired(),
            vec![Run {
                seq: 1,
                params: "a"
            }]
        );
        assert!(s.is_running());
    }

    #[test]
    fn repeated_requests_reset_the_timer_and_only_the_last_runs() {
        let mut s = S::default();
        s.request("a");
        assert_eq!(s.request("b"), vec![ClearTimer, StartTimer(400)]);
        assert_eq!(
            s.timer_fired(),
            vec![Run {
                seq: 2,
                params: "b"
            }]
        );
    }

    #[test]
    fn result_of_the_current_run_is_delivered() {
        let mut s = S::default();
        s.request("a");
        s.timer_fired();
        assert_eq!(s.job_started(1, "job1"), vec![]);
        assert_eq!(s.finished(1, Outcome::Ok), vec![DeliverResult(1)]);
        assert!(!s.is_running());
    }

    #[test]
    fn new_request_cancels_the_running_job_and_drops_its_result() {
        let mut s = S::default();
        s.request("a");
        s.timer_fired();
        s.job_started(1, "job1");
        // Người dùng chỉnh tiếp khi job 1 đang chạy: hủy job, đặt lại timer.
        assert_eq!(s.request("b"), vec![StartTimer(400), Cancel("job1".into())]);
        // Timer hết giờ nhưng lần 1 chưa dứt: chưa chạy lần 2 (không bao giờ chồng nhau).
        assert_eq!(s.timer_fired(), vec![]);
        // Lần 1 dứt (bị hủy): kết quả bị bỏ, lần 2 chạy ngay.
        assert_eq!(
            s.finished(1, Outcome::Cancelled),
            vec![Run {
                seq: 2,
                params: "b"
            }]
        );
        assert_eq!(s.finished(2, Outcome::Ok), vec![DeliverResult(2)]);
    }

    #[test]
    fn superseded_result_is_dropped_even_if_it_succeeds() {
        let mut s = S::default();
        s.request("a");
        s.timer_fired();
        s.job_started(1, "j");
        s.request("b");
        assert_eq!(
            s.finished(1, Outcome::Ok),
            vec![],
            "kết quả cũ bị bỏ, lần mới chưa tới hạn"
        );
        assert_eq!(
            s.timer_fired(),
            vec![Run {
                seq: 2,
                params: "b"
            }]
        );
    }

    #[test]
    fn cancel_before_the_job_id_is_known_is_sent_when_it_arrives() {
        let mut s = S::default();
        s.request("a");
        s.timer_fired();
        // Chưa có job id: không có gì để hủy ngay.
        assert_eq!(s.request("b"), vec![StartTimer(400)]);
        assert_eq!(s.job_started(1, "late"), vec![Cancel("late".into())]);
    }

    #[test]
    fn errors_are_delivered_unless_cancelled() {
        let mut s = S::default();
        s.request("a");
        s.timer_fired();
        assert_eq!(s.finished(1, Outcome::Error), vec![DeliverError(1)]);
        s.request("b");
        s.timer_fired();
        assert_eq!(
            s.finished(2, Outcome::Cancelled),
            vec![],
            "hủy chủ ý bị bỏ qua"
        );
    }

    #[test]
    fn dispose_stops_everything() {
        let mut s = S::default();
        s.request("a");
        s.timer_fired();
        s.job_started(1, "j");
        s.request("b");
        assert_eq!(s.dispose(), vec![ClearTimer]);
        assert_eq!(s.request("c"), vec![], "không nhận yêu cầu sau khi dispose");
        assert_eq!(
            s.finished(1, Outcome::Ok),
            vec![],
            "không giao kết quả sau dispose"
        );
        assert_eq!(s.timer_fired(), vec![]);
    }

    #[test]
    fn dispose_cancels_a_running_job() {
        let mut s = S::default();
        s.request("a");
        s.timer_fired();
        s.job_started(1, "j");
        assert_eq!(s.dispose(), vec![Cancel("j".into())]);
    }

    #[test]
    fn custom_debounce_is_used() {
        let mut s = S::new(50);
        assert_eq!(s.request("a"), vec![StartTimer(50)]);
    }
}
