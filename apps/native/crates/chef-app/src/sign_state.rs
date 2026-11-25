//! Trạng thái ký trong bộ nhớ (TASKS_RUST R6.17, R6.18, R6.27; FEATURES I26, I27, I34): port
//! `signDraft.ts`, `placementStore.ts` và `verifyStore.ts` (không có zustand: struct thuần, giao diện đọc và
//! ghi qua các hàm này). Gồm lựa chọn hộp thoại "Ký tài liệu" còn lại sau khi đóng (không bao giờ có mật
//! khẩu hay PIN), hộp ký đang đặt của từng tài liệu, và kết quả kiểm tra chữ ký của từng tài liệu với lịch
//! kiểm debounce 300 ms, bản mới nhất thắng (dùng lại `scan_preview::PreviewScheduler`). Logic thuần.
#![allow(dead_code)]

use std::collections::HashMap;

use crate::scan_preview::{Effect, Outcome, PreviewScheduler};
use crate::sign_anchor::{AnchorForm, FixedForm};
use crate::sign_request::{CertifyMode, DigestName, SignLevel, SignPrefs};
use crate::sign_verify_model::{SigItem, sort_by_severity};

// ---------- Bản nháp hộp thoại ký (signDraft.ts) ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlacementMode {
    Invisible,
    Draw,
    Field,
    Anchor,
    Fixed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SignDraft {
    /// Mẫu đã chọn. `None` ở lớp ngoài = mẫu gắn với chứng thư (hoặc không có); `Some(None)` = không dùng mẫu.
    pub template_id: Option<Option<String>>,
    pub level: SignLevel,
    pub digest: DigestName,
    pub certify: CertifyMode,
    pub reason: String,
    pub location: String,
    pub contact: String,
    pub placement_mode: PlacementMode,
    pub anchor_form: AnchorForm,
    pub fixed_form: FixedForm,
}

impl Default for SignDraft {
    fn default() -> Self {
        let p = SignPrefs::default();
        SignDraft {
            template_id: None,
            level: p.level,
            digest: p.digest,
            certify: p.certify,
            reason: String::new(),
            location: String::new(),
            contact: String::new(),
            placement_mode: PlacementMode::Invisible,
            anchor_form: AnchorForm::default(),
            fixed_form: FixedForm::default(),
        }
    }
}

// ---------- Hộp ký đang đặt (placementStore.ts) ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlacementSource {
    Draw,
    Field,
    Anchor,
    Fixed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlacedBox {
    pub page_index: usize,
    /// Không gian người dùng [x1, y1, x2, y2], điểm.
    pub rect: [f64; 4],
    /// Trường rỗng có sẵn mà chữ ký được vẽ vào.
    pub field_name: Option<String>,
    pub source: PlacementSource,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AnchorPreview {
    pub page_index: usize,
    pub rect: [f64; 4],
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct DocPlacement {
    pub placement: Option<PlacedBox>,
    pub previews: Vec<AnchorPreview>,
    /// Chỉ số trong `previews` của hộp chữ ký dùng.
    pub selected: usize,
}

#[derive(Debug, Clone, Default)]
pub struct PlacementStore {
    /// Tài liệu đang ở chế độ đặt hộp (viewer nhận kéo).
    pub placing_doc: Option<String>,
    by_doc: HashMap<String, DocPlacement>,
}

impl PlacementStore {
    pub fn start_placing(&mut self, doc: &str) {
        self.placing_doc = Some(doc.to_string());
    }

    pub fn stop_placing(&mut self) {
        self.placing_doc = None;
    }

    pub fn set_placement(&mut self, doc: &str, b: Option<PlacedBox>) {
        self.by_doc.entry(doc.to_string()).or_default().placement = b;
    }

    /// Đặt các hộp xem trước của chữ mốc; chọn lại hộp đầu.
    pub fn set_previews(&mut self, doc: &str, previews: Vec<AnchorPreview>) {
        let d = self.by_doc.entry(doc.to_string()).or_default();
        d.previews = previews;
        d.selected = 0;
    }

    /// Chọn một hộp xem trước làm hộp ký (nguồn `Anchor`). Chỉ số ngoài khoảng: không đổi gì.
    pub fn select_preview(&mut self, doc: &str, index: usize) {
        let d = self.by_doc.entry(doc.to_string()).or_default();
        let Some(p) = d.previews.get(index).copied() else {
            return;
        };
        d.selected = index;
        d.placement = Some(PlacedBox {
            page_index: p.page_index,
            rect: p.rect,
            field_name: None,
            source: PlacementSource::Anchor,
        });
    }

    /// Quên tài liệu khi đóng; thoát chế độ đặt nếu đó là tài liệu đang đặt.
    pub fn forget(&mut self, doc: &str) {
        self.by_doc.remove(doc);
        if self.placing_doc.as_deref() == Some(doc) {
            self.placing_doc = None;
        }
    }

    /// Đặt chỗ của tài liệu (mặc định rỗng).
    pub fn of(&self, doc: &str) -> DocPlacement {
        self.by_doc.get(doc).cloned().unwrap_or_default()
    }
}

// ---------- Kiểm tra chữ ký theo tài liệu (verifyStore.ts) ----------

/// Chờ trước khi kiểm, ms.
pub const VERIFY_DEBOUNCE_MS: u64 = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyPhase {
    Idle,
    Running,
    Done,
    Error,
}

#[derive(Debug, Clone, PartialEq)]
pub struct VerifyEntry {
    pub phase: VerifyPhase,
    pub items: Vec<SigItem>,
    pub error: Option<String>,
    /// Bản sửa mà kết quả thuộc về (đường dẫn + số).
    pub revision: Option<String>,
}

impl Default for VerifyEntry {
    fn default() -> Self {
        VerifyEntry {
            phase: VerifyPhase::Idle,
            items: Vec::new(),
            error: None,
            revision: None,
        }
    }
}

#[derive(Default)]
pub struct VerifyStore {
    entries: HashMap<String, VerifyEntry>,
    schedulers: HashMap<String, PreviewScheduler<String>>,
}

impl VerifyStore {
    pub fn entry(&self, doc: &str) -> VerifyEntry {
        self.entries.get(doc).cloned().unwrap_or_default()
    }

    /// Xin kiểm sau `VERIFY_DEBOUNCE_MS`. Yêu cầu mới của cùng tài liệu thay yêu cầu cũ. Trả hiệu ứng cho nơi
    /// gọi thực hiện (đặt timer, chạy `sign.verify` với bản sửa này, hủy job cũ).
    pub fn schedule(&mut self, doc: &str, revision: &str) -> Vec<Effect<String>> {
        let e = self.entries.entry(doc.to_string()).or_default();
        e.phase = VerifyPhase::Running;
        e.revision = Some(revision.to_string());
        self.schedulers
            .entry(doc.to_string())
            .or_insert_with(|| PreviewScheduler::new(VERIFY_DEBOUNCE_MS))
            .request(revision.to_string())
    }

    pub fn timer_fired(&mut self, doc: &str) -> Vec<Effect<String>> {
        self.schedulers
            .get_mut(doc)
            .map(|s| s.timer_fired())
            .unwrap_or_default()
    }

    pub fn job_started(&mut self, doc: &str, seq: u64, job_id: &str) -> Vec<Effect<String>> {
        self.schedulers
            .get_mut(doc)
            .map(|s| s.job_started(seq, job_id))
            .unwrap_or_default()
    }

    /// Kết quả của lần chạy `seq`: `Ok(items)`, lỗi có thông báo, hoặc hủy chủ ý. Chỉ ghi khi còn là bản mới nhất.
    /// Trả hiệu ứng tiếp theo (lần chạy đang chờ).
    pub fn finished(
        &mut self,
        doc: &str,
        seq: u64,
        revision: &str,
        result: Result<Vec<SigItem>, Option<String>>,
    ) -> Vec<Effect<String>> {
        let outcome = match &result {
            Ok(_) => Outcome::Ok,
            Err(Some(_)) => Outcome::Error,
            Err(None) => Outcome::Cancelled,
        };
        let Some(s) = self.schedulers.get_mut(doc) else {
            return Vec::new();
        };
        let effects = s.finished(seq, outcome);
        for e in &effects {
            match (e, &result) {
                (Effect::DeliverResult(_), Ok(items)) => {
                    self.entries.insert(
                        doc.to_string(),
                        VerifyEntry {
                            phase: VerifyPhase::Done,
                            items: sort_by_severity(items),
                            error: None,
                            revision: Some(revision.to_string()),
                        },
                    );
                }
                (Effect::DeliverError(_), Err(Some(msg))) => {
                    self.entries.insert(
                        doc.to_string(),
                        VerifyEntry {
                            phase: VerifyPhase::Error,
                            items: Vec::new(),
                            error: Some(msg.clone()),
                            revision: Some(revision.to_string()),
                        },
                    );
                }
                _ => {}
            }
        }
        effects
    }

    /// Quên tài liệu khi đóng: hủy timer, job, bỏ kết quả.
    pub fn dispose(&mut self, doc: &str) -> Vec<Effect<String>> {
        self.entries.remove(doc);
        self.schedulers
            .remove(doc)
            .map(|mut s| s.dispose())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draft_defaults_follow_prefs_and_hold_no_secrets() {
        let d = SignDraft::default();
        assert_eq!(d.level, SignLevel::BB);
        assert_eq!(d.placement_mode, PlacementMode::Invisible);
        assert_eq!(d.template_id, None);
        assert!(d.reason.is_empty());
    }

    fn pbox(p: usize) -> PlacedBox {
        PlacedBox {
            page_index: p,
            rect: [1.0, 2.0, 3.0, 4.0],
            field_name: None,
            source: PlacementSource::Draw,
        }
    }

    #[test]
    fn placement_is_per_document() {
        let mut s = PlacementStore::default();
        assert_eq!(s.of("a"), DocPlacement::default());
        s.set_placement("a", Some(pbox(0)));
        s.set_placement("b", Some(pbox(5)));
        assert_eq!(s.of("a").placement.unwrap().page_index, 0);
        assert_eq!(s.of("b").placement.unwrap().page_index, 5);
        s.set_placement("a", None);
        assert!(s.of("a").placement.is_none());
    }

    #[test]
    fn previews_reset_selection_and_select_sets_anchor_placement() {
        let mut s = PlacementStore::default();
        let ps = vec![
            AnchorPreview {
                page_index: 1,
                rect: [0.0, 0.0, 10.0, 10.0],
            },
            AnchorPreview {
                page_index: 3,
                rect: [5.0, 5.0, 15.0, 15.0],
            },
        ];
        s.set_previews("a", ps);
        s.select_preview("a", 1);
        let d = s.of("a");
        assert_eq!(d.selected, 1);
        let p = d.placement.unwrap();
        assert_eq!((p.page_index, p.source), (3, PlacementSource::Anchor));
        s.select_preview("a", 9);
        assert_eq!(s.of("a").selected, 1, "chỉ số ngoài khoảng không đổi gì");
        s.set_previews("a", vec![]);
        assert_eq!(s.of("a").selected, 0);
    }

    #[test]
    fn forget_leaves_placing_mode_only_for_that_doc() {
        let mut s = PlacementStore::default();
        s.start_placing("a");
        s.set_placement("a", Some(pbox(0)));
        s.forget("b");
        assert_eq!(s.placing_doc.as_deref(), Some("a"));
        s.forget("a");
        assert_eq!(s.placing_doc, None);
        assert_eq!(s.of("a"), DocPlacement::default());
        s.start_placing("c");
        s.stop_placing();
        assert_eq!(s.placing_doc, None);
    }

    #[test]
    fn verify_runs_after_debounce_and_stores_sorted_result() {
        let mut v = VerifyStore::default();
        assert_eq!(v.entry("a").phase, VerifyPhase::Idle);
        assert_eq!(v.schedule("a", "r1"), vec![Effect::StartTimer(300)]);
        assert_eq!(v.entry("a").phase, VerifyPhase::Running);
        assert_eq!(
            v.timer_fired("a"),
            vec![Effect::Run {
                seq: 1,
                params: "r1".to_string()
            }]
        );
        v.job_started("a", 1, "job");
        let fx = v.finished("a", 1, "r1", Ok(vec![]));
        assert_eq!(fx, vec![Effect::DeliverResult(1)]);
        let e = v.entry("a");
        assert_eq!(
            (e.phase, e.revision.as_deref()),
            (VerifyPhase::Done, Some("r1"))
        );
    }

    #[test]
    fn newer_revision_supersedes_and_drops_the_old_result() {
        let mut v = VerifyStore::default();
        v.schedule("a", "r1");
        v.timer_fired("a");
        v.job_started("a", 1, "job");
        let fx = v.schedule("a", "r2");
        assert!(fx.contains(&Effect::Cancel("job".into())));
        let fx = v.finished("a", 1, "r1", Ok(vec![]));
        assert!(fx.is_empty());
        assert_eq!(v.entry("a").phase, VerifyPhase::Running, "kết quả cũ bị bỏ");
        v.timer_fired("a");
    }

    #[test]
    fn errors_are_kept_and_cancel_is_ignored() {
        let mut v = VerifyStore::default();
        v.schedule("a", "r1");
        v.timer_fired("a");
        v.finished("a", 1, "r1", Err(Some("hỏng".into())));
        let e = v.entry("a");
        assert_eq!(
            (e.phase, e.error.as_deref(), e.items.len()),
            (VerifyPhase::Error, Some("hỏng"), 0)
        );
        v.schedule("a", "r2");
        v.timer_fired("a");
        v.finished("a", 2, "r2", Err(None));
        assert_eq!(
            v.entry("a").phase,
            VerifyPhase::Running,
            "hủy chủ ý không giao kết quả; trạng thái vẫn là lần xin mới"
        );
    }

    #[test]
    fn dispose_forgets_everything() {
        let mut v = VerifyStore::default();
        v.schedule("a", "r1");
        v.timer_fired("a");
        v.job_started("a", 1, "job");
        assert_eq!(v.dispose("a"), vec![Effect::Cancel("job".into())]);
        assert_eq!(v.entry("a"), VerifyEntry::default());
        assert!(v.finished("a", 1, "r1", Ok(vec![])).is_empty());
        assert!(v.timer_fired("zzz").is_empty());
    }
}
