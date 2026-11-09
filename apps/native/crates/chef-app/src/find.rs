//! Trạng thái tìm trong tài liệu của viewer (TASKS_RUST R2.24).
//!
//! Quét chữ từng trang qua luồng render (`Job::PageText`), tối đa `IN_FLIGHT` trang cùng lúc.
//! Chỉ giữ hộp các khớp theo trang, không giữ chữ của cả tài liệu, nên bộ nhớ không tăng theo số trang.

use std::collections::BTreeMap;
use std::sync::mpsc::{Receiver, channel};

use chef_pdf::render::{DocId, Job, RenderHandle, Reply};
use chef_pdf::search;
use chef_pdf::text::{PageText, Rect};

/// Số trang đọc chữ cùng lúc. Luồng render chạy tuần tự, nên hàng đợi chỉ cần ngắn.
const IN_FLIGHT: usize = 8;

#[derive(Default)]
pub struct Find {
    query: String,
    /// Trang -> các khớp trên trang đó, mỗi khớp là danh sách hộp (một hộp cho mỗi dòng).
    matches: BTreeMap<usize, Vec<Vec<Rect>>>,
    inflight: BTreeMap<usize, Receiver<Reply<PageText>>>,
    /// Trang tiếp theo chưa gửi yêu cầu đọc chữ.
    next_page: usize,
    /// Số thứ tự khớp đang chọn trên toàn tài liệu (0 là khớp đầu tiên).
    current: Option<usize>,
}

impl Find {
    pub fn query(&self) -> &str {
        &self.query
    }

    pub fn is_active(&self) -> bool {
        !self.query.is_empty()
    }

    /// Tổng số khớp đã tìm thấy (có thể tăng khi quét còn chạy).
    pub fn total(&self) -> usize {
        self.matches.values().map(Vec::len).sum()
    }

    pub fn current(&self) -> Option<usize> {
        self.current
    }

    /// Còn trang chưa đọc hoặc còn yêu cầu đang chờ.
    pub fn scanning(&self, page_count: usize) -> bool {
        self.is_active() && (self.next_page < page_count || !self.inflight.is_empty())
    }

    /// Đặt cụm tìm mới và bỏ mọi kết quả cũ. Yêu cầu đang chờ bị bỏ khi trả lời (kênh đã đóng).
    pub fn set_query(&mut self, query: &str) {
        self.query = query.to_string();
        self.matches.clear();
        self.inflight.clear();
        self.next_page = 0;
        self.current = None;
    }

    /// Gửi thêm yêu cầu đọc chữ, đến khi đủ `IN_FLIGHT` hoặc hết trang.
    pub fn feed(&mut self, handle: &RenderHandle, doc: DocId, page_count: usize) {
        if !self.is_active() {
            return;
        }
        while self.inflight.len() < IN_FLIGHT && self.next_page < page_count {
            let index = self.next_page;
            self.next_page += 1;
            let (tx, rx) = channel();
            let id = handle.next_id();
            if handle
                .send(Job::PageText {
                    id,
                    doc,
                    index,
                    reply: tx,
                })
                .is_err()
            {
                break;
            }
            self.inflight.insert(index, rx);
        }
    }

    /// Nhận các trang đã đọc xong. Trả true nếu có khớp mới.
    pub fn poll(&mut self) -> bool {
        let done: Vec<(usize, Reply<PageText>)> = self
            .inflight
            .iter()
            .filter_map(|(index, rx)| rx.try_recv().ok().map(|reply| (*index, reply)))
            .collect();
        let mut changed = false;
        for (index, reply) in done {
            self.inflight.remove(&index);
            let Ok(text) = reply.result else { continue };
            let hits: Vec<Vec<Rect>> = search::find(&text.chars, &self.query)
                .into_iter()
                .map(|range| search::rects(&text.chars, range))
                .collect();
            if !hits.is_empty() {
                self.matches.insert(index, hits);
                changed = true;
            }
        }
        changed
    }

    /// Các khớp trên một trang, theo thứ tự đọc.
    pub fn matches_on(&self, page: usize) -> &[Vec<Rect>] {
        self.matches.get(&page).map(Vec::as_slice).unwrap_or(&[])
    }

    /// Trang và vị trí trong trang của khớp thứ `k` trên toàn tài liệu.
    pub fn locate(&self, k: usize) -> Option<(usize, usize)> {
        let mut before = 0;
        for (page, hits) in &self.matches {
            if k < before + hits.len() {
                return Some((*page, k - before));
            }
            before += hits.len();
        }
        None
    }

    /// Chuyển sang khớp kế tiếp (`delta` dương) hoặc trước đó (âm), có vòng lại.
    /// Trả trang và vị trí trong trang của khớp mới.
    pub fn step(&mut self, delta: isize) -> Option<(usize, usize)> {
        let total = self.total();
        if total == 0 {
            return None;
        }
        let next = match self.current {
            None if delta >= 0 => 0,
            None => total - 1,
            Some(k) => (k as isize + delta).rem_euclid(total as isize) as usize,
        };
        self.current = Some(next);
        self.locate(next)
    }

    /// Dùng khi bỏ tìm: xóa cụm, kết quả và yêu cầu đang chờ.
    pub fn clear(&mut self) {
        self.set_query("");
    }
}
