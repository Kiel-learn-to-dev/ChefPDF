//! Trạng thái và điều khiển của chế độ sửa chữ (TASKS_RUST R7.01, R7.02, R7.07, R7.12; FEATURES D8, D9, B11):
//! port `textEditState.ts` và phần logic thuần của `textEditActions.ts`. Gồm: cờ chế độ, vùng chọn chữ trên
//! trang (D65), phiên sửa đoạn (D62), nháp văn bản mới (D66), bộ nhớ đệm dòng theo bản sửa, hàng đợi ghi tuần
//! tự (lệnh ghi và đổi kiểu không bao giờ chồng nhau), ghi chú xem trước, và quyết định khi đóng tài liệu còn
//! chữ đang gõ (D64). Gọi lõi nằm ngoài file này: các hàm ở đây chỉ đổi trạng thái hoặc trả việc cần làm.
#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};

use serde_json::Value;

use crate::text_edit_model::{
    PageSelection, SessionRow, clamp_range, hit_line, index_at, paragraph_glyphs, word_range,
};
use crate::text_paragraph_model::{
    FontStrategy, ParagraphInfo, TextBlock, TextLine, chars_label, paragraph_centre,
    paragraph_lines, paragraph_text, reselect_paragraph,
};

/// Cỡ chữ của khung chữ mới, pt.
pub const NEW_TEXT_SIZE: f64 = 12.0;

/// Chờ trước khi xin xem trước lại sau một lần gõ, ms.
pub const PREVIEW_DEBOUNCE_MS: u64 = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteTone {
    Warn,
    Error,
}

/// Một thông báo của phiên: font thay thế, ký tự thiếu, chữ tràn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionNote {
    pub tone: NoteTone,
    pub text: String,
}

/// Font mà phiên dùng để vẽ chữ: họ font sẽ ghi (chỉ font đã cài), nếu không thì kiểu chung.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderFont {
    pub family: Option<String>,
    pub style: String,
    pub bold: bool,
    pub italic: bool,
}

/// Đoạn đang gõ (D62). Chưa ghi gì tới khi phiên commit. `seq` bỏ câu trả lời đến sau một lần gõ mới hơn.
#[derive(Debug, Clone, PartialEq)]
pub struct ParaSession {
    pub doc_id: String,
    pub page_index: usize,
    pub paragraph_id: String,
    pub original: String,
    pub text: String,
    pub caret: usize,
    pub anchor: usize,
    pub font_size: f64,
    pub rows: Option<Vec<SessionRow>>,
    pub render: Option<RenderFont>,
    pub notes: Vec<SessionNote>,
    pub seq: u64,
    pub committing: bool,
}

/// Khung chữ mới (D66): vị trí (pt, khung hiển thị) và chữ đã gõ.
#[derive(Debug, Clone, PartialEq)]
pub struct Draft {
    pub doc_id: String,
    pub page_index: usize,
    pub x: f64,
    pub y: f64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplacementFont {
    pub id: String,
    pub family: String,
    pub style: String,
    pub bold: bool,
    pub italic: bool,
    /// `bundled` hoặc `system`.
    pub source: Option<String>,
}

/// Mở phiên: neo và caret tùy chọn (mặc định cuối chữ).
#[derive(Debug, Clone, PartialEq)]
pub struct OpenSession {
    pub doc_id: String,
    pub page_index: usize,
    pub paragraph_id: String,
    pub original: String,
    pub font_size: f64,
    pub anchor: Option<usize>,
    pub caret: Option<usize>,
}

pub struct TextEditState {
    /// Chế độ sửa chữ đang bật.
    pub active: bool,
    /// Dòng của các trang đã nạp, theo chỉ số trang.
    pub lines: HashMap<usize, Vec<TextLine>>,
    /// Khóa bộ nhớ đệm: `<doc id>:<phiên bản bản sửa>`. Trả lời của bản sửa khác bị bỏ.
    pub key: String,
    pub fonts: Option<Vec<ReplacementFont>>,
    pub font_strategy: FontStrategy,
    pub font_name: Option<String>,
    /// Chữ đang chọn trên trang (D65); đoạn của nó là đoạn mà hàng định dạng đổi.
    pub selection: Option<PageSelection>,
    pub blocks: HashMap<usize, Vec<TextBlock>>,
    pub paragraphs: HashMap<usize, Vec<ParagraphInfo>>,
    /// Một thay đổi định dạng đang chạy: hàng định dạng không nhận thêm (mỗi lần một lệnh).
    pub format_busy: bool,
    pub session: Option<ParaSession>,
    /// Công cụ Thêm văn bản đang bật: bấm lên trang là mở khung chữ mới.
    pub adding_text: bool,
    pub draft: Option<Draft>,
}

impl Default for TextEditState {
    fn default() -> Self {
        TextEditState {
            active: false,
            lines: HashMap::new(),
            key: String::new(),
            fonts: None,
            font_strategy: FontStrategy::Auto,
            font_name: None,
            selection: None,
            blocks: HashMap::new(),
            paragraphs: HashMap::new(),
            format_busy: false,
            session: None,
            adding_text: false,
            draft: None,
        }
    }
}

impl TextEditState {
    /// Bật hoặc tắt chế độ. Tắt giữ phiên và nháp đang mở (lớp giao diện sẽ ghi chúng, chữ gõ không mất);
    /// bỏ vùng chọn và công cụ thêm văn bản.
    pub fn set_active(&mut self, active: bool) {
        self.active = active;
        if !active {
            self.selection = None;
            self.adding_text = false;
        }
    }

    pub fn set_adding_text(&mut self, on: bool) {
        self.adding_text = on;
        if !on {
            self.draft = None;
        }
    }

    pub fn open_draft(&mut self, doc_id: &str, page_index: usize, x: f64, y: f64) {
        self.draft = Some(Draft {
            doc_id: doc_id.into(),
            page_index,
            x,
            y,
            text: String::new(),
        });
    }

    pub fn patch_draft(&mut self, text: &str) {
        if let Some(d) = self.draft.as_mut() {
            d.text = text.to_string();
        }
    }

    pub fn close_draft(&mut self) {
        self.draft = None;
    }

    pub fn set_selection(&mut self, s: Option<PageSelection>) {
        self.selection = s;
    }

    /// Đổi khóa bản sửa: xóa dòng, khối và đoạn đã nạp nếu khóa khác.
    pub fn reset_for(&mut self, key: &str) {
        if self.key != key {
            self.key = key.to_string();
            self.lines.clear();
            self.blocks.clear();
            self.paragraphs.clear();
        }
    }

    /// Ghi một trang đã đọc. Khóa khác khóa hiện tại thì bỏ (trả lời chậm của bản sửa cũ).
    pub fn set_page(
        &mut self,
        key: &str,
        index: usize,
        lines: Vec<TextLine>,
        blocks: Option<Vec<TextBlock>>,
        paragraphs: Option<Vec<ParagraphInfo>>,
    ) {
        if self.key != key {
            return;
        }
        self.lines.insert(index, lines);
        if let Some(b) = blocks {
            self.blocks.insert(index, b);
        }
        if let Some(p) = paragraphs {
            self.paragraphs.insert(index, p);
        }
    }

    pub fn open_session(&mut self, s: OpenSession) {
        let end = s.original.chars().count();
        self.session = Some(ParaSession {
            doc_id: s.doc_id,
            page_index: s.page_index,
            paragraph_id: s.paragraph_id,
            text: s.original.clone(),
            original: s.original,
            font_size: s.font_size,
            caret: s.caret.unwrap_or(end),
            anchor: s.anchor.unwrap_or(end),
            rows: None,
            render: None,
            notes: Vec::new(),
            seq: 0,
            committing: false,
        });
    }

    pub fn close_session(&mut self) {
        self.session = None;
    }

    /// Phiên có chữ đã đổi chưa ghi.
    pub fn session_dirty(&self) -> bool {
        self.session.as_ref().is_some_and(|s| s.text != s.original)
    }

    /// Chữ của phiên đổi: tăng `seq` (câu trả lời cũ bị bỏ). Trả `seq` mới để hẹn xin xem trước sau
    /// `PREVIEW_DEBOUNCE_MS`.
    pub fn change_session_text(&mut self, text: &str, caret: usize, anchor: usize) -> Option<u64> {
        let s = self.session.as_mut()?;
        s.text = text.to_string();
        s.caret = caret;
        s.anchor = anchor;
        s.seq += 1;
        Some(s.seq)
    }

    /// Dời caret và đầu vùng chọn mà không đổi chữ.
    pub fn move_session_caret(&mut self, caret: usize, anchor: usize) {
        if let Some(s) = self.session.as_mut() {
            s.caret = caret;
            s.anchor = anchor;
        }
    }

    /// Nhận câu trả lời xem trước cho lần gõ `seq`. Chỉ ghi khi phiên còn đó và `seq` còn là mới nhất.
    pub fn apply_preview(
        &mut self,
        seq: u64,
        rows: Vec<SessionRow>,
        render: Option<RenderFont>,
        notes: Vec<SessionNote>,
    ) -> bool {
        match self.session.as_mut() {
            Some(s) if s.seq == seq => {
                s.rows = Some(rows);
                s.render = render;
                s.notes = notes;
                true
            }
            _ => false,
        }
    }

    /// Xin xem trước lỗi: bỏ hàng, hiện lỗi.
    pub fn preview_failed(&mut self, message: &str) {
        if let Some(s) = self.session.as_mut() {
            s.rows = None;
            s.notes = vec![SessionNote {
                tone: NoteTone::Error,
                text: message.to_string(),
            }];
        }
    }

    // ---- Chọn chữ trên trang (selectAt, dragSelection, clearSelection) ----

    /// Bấm lên trang tại điểm (pt): chọn chữ dưới điểm, chỉ trong một đoạn. `extend` kéo dài từ neo cũ
    /// nếu cùng đoạn; `word` chọn cả từ (nhấp đúp). Không có chữ dưới điểm thì bỏ chọn.
    pub fn select_at(&mut self, page_index: usize, x: f64, y: f64, extend: bool, word: bool) {
        let empty = Vec::new();
        let lines = self.lines.get(&page_index).unwrap_or(&empty);
        let Some(pid) = hit_line(lines, x, y).and_then(|h| h.paragraph_id.clone()) else {
            self.selection = None;
            return;
        };
        let pg = paragraph_glyphs(lines, &pid);
        let index = index_at(&pg, x, y);
        let new = if word {
            let (from, to) = word_range(&pg.text, index);
            PageSelection {
                page_index,
                paragraph_id: pid,
                anchor: from,
                caret: to,
            }
        } else {
            let anchor = match &self.selection {
                Some(p) if extend && p.paragraph_id == pid => p.anchor,
                _ => index,
            };
            PageSelection {
                page_index,
                paragraph_id: pid,
                anchor,
                caret: index,
            }
        };
        self.selection = Some(new);
    }

    /// Kéo chuột: caret của vùng chọn theo điểm, trong đoạn của nó.
    pub fn drag_selection(&mut self, x: f64, y: f64) {
        let Some(sel) = self.selection.clone() else {
            return;
        };
        let empty = Vec::new();
        let lines = self.lines.get(&sel.page_index).unwrap_or(&empty);
        let pg = paragraph_glyphs(lines, &sel.paragraph_id);
        let caret = index_at(&pg, x, y);
        self.selection = Some(PageSelection { caret, ..sel });
    }

    /// Chọn lại đoạn thay thế `old_id` sau khi trang đọc lại; khoảng kẹp theo chữ mới. Không thấy đoạn thì bỏ chọn.
    pub fn select_after_reload(
        &mut self,
        page_index: usize,
        old_id: &str,
        centre: Option<[f64; 2]>,
        anchor: usize,
        caret: usize,
    ) {
        let empty = Vec::new();
        let lines = self.lines.get(&page_index).unwrap_or(&empty);
        let Some(id) = reselect_paragraph(lines, old_id, centre) else {
            self.selection = None;
            return;
        };
        let length = paragraph_glyphs(lines, &id).text.chars().count();
        let (a, c) = clamp_range(anchor, caret, length);
        self.selection = Some(PageSelection {
            page_index,
            paragraph_id: id,
            anchor: a,
            caret: c,
        });
    }

    /// Tâm của đoạn trước khi đổi (để chọn lại sau khi đọc lại trang).
    pub fn centre_of(&self, page_index: usize, paragraph_id: &str) -> Option<[f64; 2]> {
        paragraph_centre(
            self.lines
                .get(&page_index)
                .map(Vec::as_slice)
                .unwrap_or(&[]),
            paragraph_id,
        )
    }

    // ---- Mở phiên từ vùng chọn (nút Sửa, Enter) ----

    /// Phiên mở trên vùng đang chọn, hoặc None khi không có chọn hay đoạn không còn dòng.
    pub fn session_for_selection(&self, doc_id: &str) -> Option<OpenSession> {
        let sel = self.selection.as_ref()?;
        let lines = self.lines.get(&sel.page_index)?;
        let own = paragraph_lines(lines, &sel.paragraph_id);
        let first = own.first()?;
        let text = paragraph_text(lines, &sel.paragraph_id);
        let (anchor, caret) = clamp_range(sel.anchor, sel.caret, text.chars().count());
        Some(OpenSession {
            doc_id: doc_id.into(),
            page_index: sel.page_index,
            paragraph_id: sel.paragraph_id.clone(),
            original: text,
            font_size: first.font_size,
            anchor: Some(anchor),
            caret: Some(caret),
        })
    }
}

// ---------- Ghi chú xem trước ----------

/// Các ghi chú một lần xem trước: cảnh báo của lõi, ký tự không font nào viết được, tràn và đè khối.
/// `data` là JSON của `text.previewParagraph` (`warnings`, `missing`, `fontTo`, `overflow`, `overlapsBlockIds`);
/// `t(key, arg)` dịch chuỗi giao diện (nhận khóa và một tham số hiển thị).
pub fn preview_notes(data: &Value, t: &dyn Fn(&str, &str) -> String) -> Vec<SessionNote> {
    let mut notes: Vec<SessionNote> = data
        .get("warnings")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(|s| SessionNote {
                    tone: NoteTone::Warn,
                    text: s.to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    let missing: Vec<char> = data
        .get("missing")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .filter_map(|s| s.chars().next())
                .collect()
        })
        .unwrap_or_default();
    let font_to = data.get("fontTo").is_some_and(|v| !v.is_null());
    if !missing.is_empty() && !font_to {
        notes.push(SessionNote {
            tone: NoteTone::Error,
            text: t("textEdit.chip.missing", &chars_label(&missing)),
        });
    }
    let overflow = data.get("overflow").and_then(Value::as_f64).unwrap_or(0.0);
    if overflow > 0.0 {
        notes.push(SessionNote {
            tone: NoteTone::Warn,
            text: t("textEdit.warn.overflow", &format!("{overflow}")),
        });
    }
    let overlaps = data
        .get("overlapsBlockIds")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    if overlaps > 0 {
        notes.push(SessionNote {
            tone: NoteTone::Warn,
            text: t("textEdit.warn.overlap", &overlaps.to_string()),
        });
    }
    notes
}

// ---------- Hàng đợi ghi tuần tự ----------

/// Lệnh trong hàng đợi: commit phiên, ghi nháp, đổi kiểu, mở phiên từ vùng chọn, chọn trên trang...
/// Chạy lần lượt, không chồng nhau: lệnh sau chỉ bắt đầu khi lệnh trước đã dứt (kể cả lỗi).
pub struct JobQueue<J> {
    pending: VecDeque<J>,
    running: bool,
}

impl<J> Default for JobQueue<J> {
    fn default() -> Self {
        JobQueue {
            pending: VecDeque::new(),
            running: false,
        }
    }
}

impl<J> JobQueue<J> {
    /// Xếp một lệnh. Trả lệnh cần chạy ngay nếu hàng đang rảnh (đánh dấu đang chạy), ngược lại None.
    pub fn push(&mut self, job: J) -> Option<J> {
        if self.running {
            self.pending.push_back(job);
            None
        } else {
            self.running = true;
            Some(job)
        }
    }

    /// Lệnh hiện tại đã dứt (thành công hay lỗi). Trả lệnh kế tiếp, hoặc None khi hết.
    pub fn finish(&mut self) -> Option<J> {
        match self.pending.pop_front() {
            Some(next) => Some(next),
            None => {
                self.running = false;
                None
            }
        }
    }

    pub fn is_idle(&self) -> bool {
        !self.running
    }

    pub fn len(&self) -> usize {
        self.pending.len() + usize::from(self.running)
    }
}

// ---------- Quyết định ghi và đóng ----------

/// Kết quả xét một lần commit phiên.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CommitPlan {
    /// Không có phiên, hoặc đang ghi dở: không làm gì.
    Skip,
    /// Chữ không đổi: chỉ đóng phiên, không gọi lõi.
    JustClose,
    /// Ghi chữ này vào đoạn bằng `text.editParagraph` (một bản sửa).
    Write {
        page_index: usize,
        paragraph_id: String,
        text: String,
        anchor: usize,
        caret: usize,
    },
}

/// Xét commit phiên. Đánh dấu `committing` khi cần ghi (chống ghi hai lần).
pub fn plan_commit(state: &mut TextEditState) -> CommitPlan {
    let Some(s) = state.session.as_mut() else {
        return CommitPlan::Skip;
    };
    if s.committing {
        return CommitPlan::Skip;
    }
    if s.text == s.original {
        state.session = None;
        return CommitPlan::JustClose;
    }
    s.committing = true;
    CommitPlan::Write {
        page_index: s.page_index,
        paragraph_id: s.paragraph_id.clone(),
        text: s.text.clone(),
        anchor: s.anchor,
        caret: s.caret,
    }
}

/// Khung chữ mới cần ghi: chữ trống chỉ đóng khung.
#[derive(Debug, Clone, PartialEq)]
pub enum DraftPlan {
    None,
    JustClose,
    Write {
        page_index: usize,
        x: f64,
        y: f64,
        text: String,
    },
}

pub fn plan_draft(state: &TextEditState) -> DraftPlan {
    match &state.draft {
        None => DraftPlan::None,
        Some(d) if d.text.trim().is_empty() => DraftPlan::JustClose,
        Some(d) => DraftPlan::Write {
            page_index: d.page_index,
            x: d.x,
            y: d.y,
            text: d.text.clone(),
        },
    }
}

/// Đóng tài liệu `doc_id` (D64): còn chữ đang gõ thì phải hỏi.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseCheck {
    /// Không có chữ chưa ghi của tài liệu này: bỏ phiên và nháp rồi đóng ngay.
    Proceed,
    /// Hỏi: Ghi chữ, Bỏ chữ hoặc Hủy.
    Ask,
}

pub fn check_before_close(state: &TextEditState, doc_id: &str) -> CloseCheck {
    let open_session = state
        .session
        .as_ref()
        .is_some_and(|s| s.doc_id == doc_id && s.text != s.original);
    let new_text = state
        .draft
        .as_ref()
        .is_some_and(|d| d.doc_id == doc_id && !d.text.trim().is_empty());
    if open_session || new_text {
        CloseCheck::Ask
    } else {
        CloseCheck::Proceed
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAnswer {
    Cancel,
    Discard,
    Save,
}

/// Việc cần làm sau câu trả lời. `Save` ghi phiên rồi nháp; ghi hỏng thì tài liệu giữ mở.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    StayOpen,
    DiscardAndClose,
    SaveThenClose,
}

pub fn close_action(answer: Option<CloseAnswer>) -> CloseAction {
    match answer {
        None | Some(CloseAnswer::Cancel) => CloseAction::StayOpen,
        Some(CloseAnswer::Discard) => CloseAction::DiscardAndClose,
        Some(CloseAnswer::Save) => CloseAction::SaveThenClose,
    }
}

/// Bỏ phiên và nháp (Esc, hoặc chọn Bỏ chữ khi đóng).
pub fn discard_pending(state: &mut TextEditState) {
    state.session = None;
    state.draft = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(id: &str, pid: &str, text: &str, bbox: [f64; 4]) -> TextLine {
        let n = text.chars().count().max(1) as f64;
        let w = (bbox[2] - bbox[0]) / n;
        TextLine {
            id: id.into(),
            page_index: 0,
            paragraph_id: Some(pid.into()),
            editable: true,
            bbox,
            text: text.into(),
            font_size: 12.0,
            glyphs: Some(
                (0..text.chars().count())
                    .map(|i| (bbox[0] + i as f64 * w, bbox[0] + (i + 1) as f64 * w))
                    .collect(),
            ),
            ..TextLine::default()
        }
    }

    fn state_with_page() -> TextEditState {
        let mut s = TextEditState::default();
        s.reset_for("d:1");
        s.set_page(
            "d:1",
            0,
            vec![
                line("l0", "P0:aa:0", "xin chào", [10.0, 10.0, 90.0, 22.0]),
                line("l1", "P0:aa:1", "thế giới", [10.0, 50.0, 90.0, 62.0]),
            ],
            None,
            None,
        );
        s
    }

    #[test]
    fn stale_page_answers_are_dropped() {
        let mut s = state_with_page();
        s.set_page("d:0", 1, vec![], None, None);
        assert!(!s.lines.contains_key(&1), "khóa cũ bị bỏ");
        s.reset_for("d:2");
        assert!(s.lines.is_empty(), "đổi bản sửa thì xóa dòng đã nạp");
        s.reset_for("d:2");
        s.set_page("d:2", 0, vec![], None, None);
        s.reset_for("d:2");
        assert!(s.lines.contains_key(&0), "cùng khóa thì giữ");
    }

    #[test]
    fn mode_off_keeps_session_and_draft_but_clears_selection_and_tool() {
        let mut s = state_with_page();
        s.set_active(true);
        s.select_at(0, 20.0, 15.0, false, false);
        s.set_adding_text(true);
        s.open_draft("d", 0, 5.0, 5.0);
        s.open_session(OpenSession {
            doc_id: "d".into(),
            page_index: 0,
            paragraph_id: "P0:aa:0".into(),
            original: "xin chào".into(),
            font_size: 12.0,
            anchor: None,
            caret: None,
        });
        s.set_active(false);
        assert!(s.selection.is_none() && !s.adding_text);
        assert!(
            s.session.is_some() && s.draft.is_some(),
            "chữ đang gõ không mất"
        );
    }

    #[test]
    fn turning_the_add_text_tool_off_drops_the_draft() {
        let mut s = TextEditState::default();
        s.set_adding_text(true);
        s.open_draft("d", 0, 1.0, 2.0);
        s.patch_draft("abc");
        assert_eq!(s.draft.as_ref().unwrap().text, "abc");
        s.set_adding_text(false);
        assert!(s.draft.is_none());
    }

    #[test]
    fn select_click_word_and_extend() {
        let mut s = state_with_page();
        s.select_at(0, 12.0, 15.0, false, false);
        let a = s.selection.clone().unwrap();
        assert_eq!(a.paragraph_id, "P0:aa:0");
        assert_eq!(a.anchor, a.caret);
        s.select_at(0, 20.0, 15.0, false, true);
        let w = s.selection.clone().unwrap();
        assert_eq!((w.anchor, w.caret), (0, 3), "chọn cả từ \"xin\"");
        // Shift: giữ neo của lần chọn trước nếu cùng đoạn.
        s.select_at(0, 12.0, 15.0, false, false);
        let anchor = s.selection.as_ref().unwrap().anchor;
        s.select_at(0, 80.0, 15.0, true, false);
        let e = s.selection.clone().unwrap();
        assert_eq!(e.anchor, anchor);
        assert!(e.caret > e.anchor);
        // Shift sang đoạn khác: neo mới.
        s.select_at(0, 80.0, 55.0, true, false);
        assert_eq!(s.selection.as_ref().unwrap().paragraph_id, "P0:aa:1");
        // Bấm vào chỗ trống: bỏ chọn.
        s.select_at(0, 500.0, 500.0, false, false);
        assert!(s.selection.is_none());
    }

    #[test]
    fn drag_moves_only_the_caret_within_the_paragraph() {
        let mut s = state_with_page();
        s.select_at(0, 12.0, 15.0, false, false);
        let anchor = s.selection.as_ref().unwrap().anchor;
        s.drag_selection(85.0, 55.0);
        let d = s.selection.clone().unwrap();
        assert_eq!(
            (d.anchor, d.paragraph_id.as_str()),
            (anchor, "P0:aa:0"),
            "không băng qua đoạn bên cạnh"
        );
        let mut none = TextEditState::default();
        none.drag_selection(1.0, 1.0);
        assert!(none.selection.is_none());
    }

    #[test]
    fn session_opens_on_selection_with_clamped_range() {
        let mut s = state_with_page();
        assert!(s.session_for_selection("d").is_none());
        s.set_selection(Some(PageSelection {
            page_index: 0,
            paragraph_id: "P0:aa:0".into(),
            anchor: 2,
            caret: 99,
        }));
        let o = s.session_for_selection("d").unwrap();
        assert_eq!((o.anchor, o.caret), (Some(2), Some(8)));
        assert_eq!(o.original, "xin chào");
        s.open_session(o);
        let sess = s.session.as_ref().unwrap();
        assert_eq!(
            (sess.anchor, sess.caret, sess.text.as_str()),
            (2, 8, "xin chào")
        );
        s.set_selection(Some(PageSelection {
            page_index: 0,
            paragraph_id: "P0:aa:9".into(),
            anchor: 0,
            caret: 0,
        }));
        assert!(
            s.session_for_selection("d").is_none(),
            "đoạn không còn dòng"
        );
    }

    #[test]
    fn open_session_defaults_caret_to_the_end() {
        let mut s = TextEditState::default();
        s.open_session(OpenSession {
            doc_id: "d".into(),
            page_index: 0,
            paragraph_id: "p".into(),
            original: "tiếng Việt".into(),
            font_size: 11.0,
            anchor: None,
            caret: None,
        });
        let x = s.session.as_ref().unwrap();
        assert_eq!(
            (x.caret, x.anchor),
            (10, 10),
            "đếm theo ký tự, không theo byte"
        );
        assert!(!s.session_dirty());
    }

    #[test]
    fn typing_bumps_seq_and_stale_previews_are_dropped() {
        let mut s = TextEditState::default();
        assert_eq!(s.change_session_text("a", 1, 1), None);
        s.open_session(OpenSession {
            doc_id: "d".into(),
            page_index: 0,
            paragraph_id: "p".into(),
            original: "ab".into(),
            font_size: 11.0,
            anchor: None,
            caret: None,
        });
        let s1 = s.change_session_text("abc", 3, 3).unwrap();
        let s2 = s.change_session_text("abcd", 4, 4).unwrap();
        assert_eq!((s1, s2), (1, 2));
        assert!(
            !s.apply_preview(s1, vec![], None, vec![]),
            "trả lời của lần gõ cũ bị bỏ"
        );
        assert!(s.session.as_ref().unwrap().rows.is_none());
        assert!(s.apply_preview(s2, vec![], None, vec![]));
        assert!(s.session.as_ref().unwrap().rows.is_some());
        assert!(s.session_dirty());
        s.move_session_caret(1, 0);
        assert_eq!(
            (
                s.session.as_ref().unwrap().caret,
                s.session.as_ref().unwrap().anchor
            ),
            (1, 0)
        );
        s.preview_failed("lỗi");
        let x = s.session.as_ref().unwrap();
        assert!(x.rows.is_none());
        assert_eq!(x.notes[0].tone, NoteTone::Error);
    }

    #[test]
    fn commit_plan_skip_close_or_write_and_no_double_write() {
        let mut s = TextEditState::default();
        assert_eq!(plan_commit(&mut s), CommitPlan::Skip);
        s.open_session(OpenSession {
            doc_id: "d".into(),
            page_index: 2,
            paragraph_id: "p2-1".into(),
            original: "cũ".into(),
            font_size: 11.0,
            anchor: None,
            caret: None,
        });
        assert_eq!(plan_commit(&mut s), CommitPlan::JustClose);
        assert!(s.session.is_none());
        s.open_session(OpenSession {
            doc_id: "d".into(),
            page_index: 2,
            paragraph_id: "p2-1".into(),
            original: "cũ".into(),
            font_size: 11.0,
            anchor: None,
            caret: None,
        });
        s.change_session_text("mới", 3, 3);
        let plan = plan_commit(&mut s);
        assert_eq!(
            plan,
            CommitPlan::Write {
                page_index: 2,
                paragraph_id: "p2-1".into(),
                text: "mới".into(),
                anchor: 3,
                caret: 3
            }
        );
        assert!(s.session.as_ref().unwrap().committing);
        assert_eq!(
            plan_commit(&mut s),
            CommitPlan::Skip,
            "đang ghi dở thì không ghi lần hai"
        );
    }

    #[test]
    fn draft_plan() {
        let mut s = TextEditState::default();
        assert_eq!(plan_draft(&s), DraftPlan::None);
        s.open_draft("d", 1, 4.0, 5.0);
        assert_eq!(plan_draft(&s), DraftPlan::JustClose);
        s.patch_draft("   ");
        assert_eq!(plan_draft(&s), DraftPlan::JustClose);
        s.patch_draft("Xin chào");
        assert_eq!(
            plan_draft(&s),
            DraftPlan::Write {
                page_index: 1,
                x: 4.0,
                y: 5.0,
                text: "Xin chào".into()
            }
        );
    }

    #[test]
    fn close_asks_only_for_unwritten_text_of_that_document() {
        let mut s = TextEditState::default();
        assert_eq!(check_before_close(&s, "d"), CloseCheck::Proceed);
        s.open_session(OpenSession {
            doc_id: "d".into(),
            page_index: 0,
            paragraph_id: "p".into(),
            original: "a".into(),
            font_size: 11.0,
            anchor: None,
            caret: None,
        });
        assert_eq!(
            check_before_close(&s, "d"),
            CloseCheck::Proceed,
            "phiên chưa đổi chữ thì không hỏi"
        );
        s.change_session_text("ab", 2, 2);
        assert_eq!(check_before_close(&s, "d"), CloseCheck::Ask);
        assert_eq!(
            check_before_close(&s, "khác"),
            CloseCheck::Proceed,
            "tài liệu khác"
        );
        discard_pending(&mut s);
        s.open_draft("d", 0, 0.0, 0.0);
        s.patch_draft(" ");
        assert_eq!(
            check_before_close(&s, "d"),
            CloseCheck::Proceed,
            "khung trống không hỏi"
        );
        s.patch_draft("chữ");
        assert_eq!(check_before_close(&s, "d"), CloseCheck::Ask);
        assert_eq!(close_action(None), CloseAction::StayOpen);
        assert_eq!(
            close_action(Some(CloseAnswer::Cancel)),
            CloseAction::StayOpen
        );
        assert_eq!(
            close_action(Some(CloseAnswer::Discard)),
            CloseAction::DiscardAndClose
        );
        assert_eq!(
            close_action(Some(CloseAnswer::Save)),
            CloseAction::SaveThenClose
        );
        discard_pending(&mut s);
        assert!(s.session.is_none() && s.draft.is_none());
    }

    #[test]
    fn reselect_after_reload_clamps_range_or_clears() {
        let mut s = state_with_page();
        let centre = s.centre_of(0, "P0:aa:0");
        assert!(centre.is_some());
        s.select_after_reload(0, "P0:aa:0", centre, 2, 50);
        let sel = s.selection.clone().unwrap();
        assert_eq!((sel.anchor, sel.caret), (2, 8));
        s.select_after_reload(0, "P0:aa:7", None, 0, 0);
        assert!(s.selection.is_none());
    }

    #[test]
    fn jobs_run_one_at_a_time_in_order_even_after_a_failure() {
        let mut q: JobQueue<&str> = JobQueue::default();
        assert!(q.is_idle());
        assert_eq!(q.push("commit"), Some("commit"));
        assert_eq!(q.push("style"), None);
        assert_eq!(q.push("select"), None);
        assert_eq!(q.len(), 3);
        // Lệnh đầu dứt (dù lỗi): lệnh sau chạy theo đúng thứ tự xếp.
        assert_eq!(q.finish(), Some("style"));
        assert_eq!(q.finish(), Some("select"));
        assert_eq!(q.finish(), None);
        assert!(q.is_idle());
        assert_eq!(q.push("again"), Some("again"));
    }

    fn t(key: &str, arg: &str) -> String {
        format!("{key}|{arg}")
    }

    #[test]
    fn preview_notes_cover_warnings_missing_overflow_and_overlap() {
        let data = json!({ "warnings": ["Font Arial thay bằng Roboto"], "missing": ["ǆ", "\u{200b}"], "overflow": 12.5, "overlapsBlockIds": ["b1", "b2"] });
        let n = preview_notes(&data, &t);
        assert_eq!(n.len(), 4);
        assert_eq!(
            (n[0].tone, n[0].text.as_str()),
            (NoteTone::Warn, "Font Arial thay bằng Roboto")
        );
        assert_eq!(n[1].tone, NoteTone::Error);
        assert!(n[1].text.starts_with("textEdit.chip.missing|ǆ"));
        assert!(n[1].text.contains("U+200B"), "ký tự vô hình hiện mã");
        assert_eq!(n[2].text, "textEdit.warn.overflow|12.5");
        assert_eq!(n[3].text, "textEdit.warn.overlap|2");
    }

    #[test]
    fn missing_chars_are_not_reported_when_a_font_takes_over() {
        let data = json!({ "missing": ["ǆ"], "fontTo": "Roboto" });
        assert!(preview_notes(&data, &t).is_empty());
        assert!(preview_notes(&json!({}), &t).is_empty());
    }
}
