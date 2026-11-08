//! Bộ đệm văn bản cho ô nhập (TASKS_RUST R1.22). Thuần Rust, không phụ thuộc GPUI để kiểm thử được.
//!
//! Mọi vị trí nội bộ là byte UTF-8. Giao diện IME của GPUI dùng UTF-16, nên có hàm đổi qua lại.
//! Ranh giới con trỏ theo grapheme (cụm ký tự hiển thị), nên chữ tiếng Việt có dấu tổ hợp
//! không bị tách đôi khi xóa.

use std::ops::Range;

use unicode_segmentation::UnicodeSegmentation;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TextBuffer {
    content: String,
    selected: Range<usize>,
    /// true khi con trỏ nằm ở đầu vùng chọn (người dùng kéo ngược).
    reversed: bool,
    /// Vùng đang là chữ gõ dở của bộ gõ (composition), nếu có.
    marked: Option<Range<usize>>,
}

impl TextBuffer {
    /// Tạo bộ đệm với con trỏ ở cuối nội dung.
    pub fn new(text: &str) -> Self {
        let end = text.len();
        TextBuffer {
            content: text.to_string(),
            selected: end..end,
            reversed: false,
            marked: None,
        }
    }

    pub fn content(&self) -> &str {
        &self.content
    }

    pub fn selected_range(&self) -> Range<usize> {
        self.selected.clone()
    }

    pub fn selection_reversed(&self) -> bool {
        self.reversed
    }

    pub fn marked_range(&self) -> Option<Range<usize>> {
        self.marked.clone()
    }

    pub fn cursor(&self) -> usize {
        if self.reversed {
            self.selected.start
        } else {
            self.selected.end
        }
    }

    pub fn selected_text(&self) -> &str {
        &self.content[self.selected.clone()]
    }

    /// Đặt con trỏ tại `offset` và bỏ vùng chọn.
    pub fn move_to(&mut self, offset: usize) {
        let offset = self.clamp_boundary(offset);
        self.selected = offset..offset;
        self.reversed = false;
    }

    /// Kéo vùng chọn từ neo đến `offset`. Tự đổi chiều khi kéo vượt neo.
    pub fn select_to(&mut self, offset: usize) {
        let offset = self.clamp_boundary(offset);
        if self.reversed {
            self.selected.start = offset;
        } else {
            self.selected.end = offset;
        }
        if self.selected.end < self.selected.start {
            self.reversed = !self.reversed;
            self.selected = self.selected.end..self.selected.start;
        }
    }

    pub fn select_all(&mut self) {
        self.selected = 0..self.content.len();
        self.reversed = false;
    }

    /// Ranh giới grapheme ngay trước `offset`, hoặc 0.
    pub fn previous_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .rev()
            .find_map(|(idx, _)| (idx < offset).then_some(idx))
            .unwrap_or(0)
    }

    /// Ranh giới grapheme ngay sau `offset`, hoặc độ dài nội dung.
    pub fn next_boundary(&self, offset: usize) -> usize {
        self.content
            .grapheme_indices(true)
            .find_map(|(idx, _)| (idx > offset).then_some(idx))
            .unwrap_or(self.content.len())
    }

    /// Thay `range` (byte UTF-8, mặc định là chữ đang gõ dở, rồi vùng chọn) bằng `text`.
    /// Con trỏ đặt sau chữ mới và bỏ trạng thái gõ dở.
    pub fn replace_text(&mut self, range: Option<Range<usize>>, text: &str) {
        let range = range
            .or_else(|| self.marked.clone())
            .unwrap_or_else(|| self.selected.clone());
        let range = self.clamp_range(range);
        self.content.replace_range(range.clone(), text);
        let cursor = range.start + text.len();
        self.selected = cursor..cursor;
        self.reversed = false;
        self.marked = None;
    }

    /// Thay `range` bằng `text` và đánh dấu `text` là chữ gõ dở. `new_selected` là vùng chọn
    /// tương đối với đầu `text` (byte UTF-8), nếu có.
    pub fn replace_and_mark(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        new_selected: Option<Range<usize>>,
    ) {
        let range = range
            .or_else(|| self.marked.clone())
            .unwrap_or_else(|| self.selected.clone());
        let range = self.clamp_range(range);
        self.content.replace_range(range.clone(), text);
        self.marked = if text.is_empty() {
            None
        } else {
            Some(range.start..range.start + text.len())
        };
        self.selected = match new_selected {
            Some(sel) => {
                let sel = sel.start.min(text.len())..sel.end.min(text.len());
                sel.start + range.start..sel.end + range.start
            }
            None => {
                let cursor = range.start + text.len();
                cursor..cursor
            }
        };
        self.reversed = false;
    }

    /// Bỏ trạng thái gõ dở, giữ nguyên chữ đã có.
    pub fn unmark(&mut self) {
        self.marked = None;
    }

    /// Chèn `text` tại vùng chọn (hoặc con trỏ).
    pub fn insert(&mut self, text: &str) {
        self.replace_text(None, text);
    }

    /// Lùi một cụm ký tự, hoặc xóa vùng chọn. Trả false nếu không có gì để xóa.
    pub fn backspace(&mut self) -> bool {
        if self.selected.is_empty() {
            let prev = self.previous_boundary(self.cursor());
            if prev == self.cursor() {
                return false;
            }
            self.select_to(prev);
        }
        self.replace_text(None, "");
        true
    }

    /// Xóa cụm ký tự sau con trỏ, hoặc vùng chọn. Trả false nếu không có gì để xóa.
    pub fn delete(&mut self) -> bool {
        if self.selected.is_empty() {
            let next = self.next_boundary(self.cursor());
            if next == self.cursor() {
                return false;
            }
            self.select_to(next);
        }
        self.replace_text(None, "");
        true
    }

    /// Đổi byte UTF-8 sang đơn vị UTF-16 (dùng cho IME).
    pub fn offset_to_utf16(&self, offset: usize) -> usize {
        self.content[..offset.min(self.content.len())]
            .encode_utf16()
            .count()
    }

    /// Đổi đơn vị UTF-16 sang byte UTF-8, làm tròn xuống ranh giới ký tự.
    pub fn offset_from_utf16(&self, offset: usize) -> usize {
        let mut utf16 = 0;
        for (byte, ch) in self.content.char_indices() {
            // Ký tự này vượt quá `offset`: dừng ở đầu nó (làm tròn xuống).
            if utf16 + ch.len_utf16() > offset {
                return byte;
            }
            utf16 += ch.len_utf16();
        }
        self.content.len()
    }

    pub fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(range.start)..self.offset_to_utf16(range.end)
    }

    pub fn range_from_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_from_utf16(range.start)..self.offset_from_utf16(range.end)
    }

    fn clamp_boundary(&self, offset: usize) -> usize {
        let offset = offset.min(self.content.len());
        if self.content.is_char_boundary(offset) {
            offset
        } else {
            self.previous_char_boundary(offset)
        }
    }

    fn previous_char_boundary(&self, mut offset: usize) -> usize {
        while !self.content.is_char_boundary(offset) {
            offset -= 1;
        }
        offset
    }

    fn clamp_range(&self, range: Range<usize>) -> Range<usize> {
        let start = self.clamp_boundary(range.start);
        let end = self.clamp_boundary(range.end.max(range.start));
        start..end
    }
}

#[cfg(test)]
mod tests {
    use super::TextBuffer;

    #[test]
    fn vietnamese_text_is_stored_and_counted_in_utf16() {
        let b = TextBuffer::new("nghị định số 1");
        assert_eq!(b.content(), "nghị định số 1");
        // Mọi ký tự tiếng Việt trong BMP là một đơn vị UTF-16.
        assert_eq!(
            b.offset_to_utf16(b.content().len()),
            "nghị định số 1".chars().count()
        );
        let end16 = b.offset_to_utf16(b.content().len());
        assert_eq!(b.offset_from_utf16(end16), b.content().len());
    }

    #[test]
    fn utf16_round_trip_with_surrogate_pairs() {
        // Emoji là hai đơn vị UTF-16 (một cặp thay thế).
        let b = TextBuffer::new("a😀b");
        assert_eq!(b.offset_to_utf16(1), 1);
        assert_eq!(b.offset_to_utf16(5), 3);
        assert_eq!(b.offset_from_utf16(3), 5);
        // Vị trí giữa cặp thay thế làm tròn xuống ký tự trước.
        assert_eq!(b.offset_from_utf16(2), 1);
    }

    #[test]
    fn backspace_removes_a_whole_grapheme_including_combining_marks() {
        // "ệ" dạng tách: e + dấu nặng + dấu mũ, một cụm hiển thị.
        // Cả cụm "ệ" (e + hai dấu tổ hợp) bị xóa một lần; chữ "t" phía sau còn nguyên.
        let mut b = TextBuffer::new("Việ\u{0323}\u{0302}t");
        b.move_to("Việ\u{0323}\u{0302}".len());
        assert!(b.backspace());
        assert_eq!(b.content(), "Vit");
    }

    #[test]
    fn delete_removes_the_grapheme_after_the_cursor() {
        let mut b = TextBuffer::new("ab");
        b.move_to(0);
        assert!(b.delete());
        assert_eq!(b.content(), "b");
        assert!(!TextBuffer::new("").delete());
    }

    #[test]
    fn selection_replace_inserts_and_moves_cursor_after_text() {
        let mut b = TextBuffer::new("thanh toan");
        b.move_to(0);
        b.select_to("thanh".len());
        b.insert("thanh toán");
        assert_eq!(b.content(), "thanh toán toan");
        assert_eq!(b.cursor(), "thanh toán".len());
        assert!(b.selected_range().is_empty());
    }

    #[test]
    fn dragging_backwards_flips_the_selection_direction() {
        let mut b = TextBuffer::new("nghị định");
        b.move_to("nghị".len());
        b.select_to(0);
        assert!(b.selection_reversed());
        assert_eq!(b.selected_text(), "nghị");
        b.select_to("nghị định".len());
        assert!(!b.selection_reversed());
        assert_eq!(b.selected_text(), " định");
    }

    #[test]
    fn composition_marks_text_and_replacing_it_keeps_one_copy() {
        // Bộ gõ gửi từng bước: "n", "ng", "ngh", "nghi" rồi chốt.
        let mut b = TextBuffer::new("");
        b.replace_and_mark(None, "n", None);
        assert_eq!(b.marked_range(), Some(0..1));
        b.replace_and_mark(None, "ng", None);
        b.replace_and_mark(None, "nghị", None);
        assert_eq!(b.content(), "nghị");
        assert_eq!(b.marked_range(), Some(0.."nghị".len()));
        b.replace_text(None, "nghị");
        assert_eq!(b.content(), "nghị");
        assert_eq!(b.marked_range(), None);
        assert_eq!(b.cursor(), "nghị".len());
    }

    #[test]
    fn composition_selection_is_relative_to_the_marked_text() {
        let mut b = TextBuffer::new("");
        // Chữ gõ dở "ệ" với con trỏ sau chữ đó (tương đối với đầu chữ mới).
        let n = "ệ".len();
        b.replace_and_mark(None, "ệ", Some(n..n));
        assert_eq!(b.cursor(), n);
        assert_eq!(b.marked_range(), Some(0..n));
    }

    #[test]
    fn replacing_with_an_explicit_range_leaves_the_rest_alone() {
        let mut b = TextBuffer::new("ab cd");
        b.replace_text(Some(3..5), "xyz");
        assert_eq!(b.content(), "ab xyz");
    }

    #[test]
    fn select_all_and_home_end_positions() {
        let mut b = TextBuffer::new("chef pdf");
        b.select_all();
        assert_eq!(b.selected_text(), "chef pdf");
        b.move_to(0);
        assert_eq!(b.cursor(), 0);
        b.move_to(usize::MAX);
        assert_eq!(b.cursor(), "chef pdf".len());
    }

    #[test]
    fn offsets_inside_a_multibyte_char_snap_back_to_its_start() {
        let mut b = TextBuffer::new("ệ");
        b.move_to(1);
        assert_eq!(b.cursor(), 0);
    }
}
