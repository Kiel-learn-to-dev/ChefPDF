//! Tìm không dấu trong chữ của trang (TASKS_RUST R2.23). "nghi dinh" khớp "nghị định" và "NGHỊ ĐỊNH".
//! Thuần Rust, không cần pdfium: nhận `PageText` đã đọc, nên kiểm thử được riêng.

use std::ops::Range;

use unicode_normalization::UnicodeNormalization;

use crate::text::{CharBox, Rect};

/// Dấu tổ hợp của tiếng Việt nằm trong khối Combining Diacritical Marks.
fn is_combining(c: char) -> bool {
    ('\u{0300}'..='\u{036F}').contains(&c)
}

/// Bỏ dấu một ký tự: tách dấu (NFD), giữ chữ gốc, đ và Đ thành d và D, đổi thành chữ thường.
/// Ký tự không có chữ gốc (dấu đứng riêng) trả None. Mọi khoảng trắng thành một dấu cách.
pub fn fold_char(c: char) -> Option<char> {
    if c.is_whitespace() {
        return Some(' ');
    }
    let base = match c {
        'đ' => 'd',
        'Đ' => 'D',
        _ => c.nfd().find(|x| !is_combining(*x))?,
    };
    Some(base.to_lowercase().next().unwrap_or(base))
}

/// Chữ đã bỏ dấu, kèm vị trí ký tự gốc của từng ký tự đã bỏ dấu.
/// Khoảng trắng liên tiếp chỉ giữ một dấu cách.
#[derive(Debug, Clone, PartialEq)]
pub struct Folded {
    pub chars: Vec<char>,
    pub origin: Vec<usize>,
}

pub fn fold(text: &[CharBox]) -> Folded {
    let mut out = Folded {
        chars: Vec::with_capacity(text.len()),
        origin: Vec::with_capacity(text.len()),
    };
    for (index, cb) in text.iter().enumerate() {
        let Some(f) = fold_char(cb.ch) else { continue };
        if f == ' ' && out.chars.last() == Some(&' ') {
            continue;
        }
        out.chars.push(f);
        out.origin.push(index);
    }
    out
}

/// Cụm tìm đã bỏ dấu. Bỏ khoảng trắng đầu và cuối, khoảng trắng giữa chỉ còn một.
pub fn fold_query(query: &str) -> Vec<char> {
    let empty = Rect {
        left: 0.0,
        top: 0.0,
        right: 0.0,
        bottom: 0.0,
    };
    let boxes: Vec<CharBox> = query
        .chars()
        .map(|ch| CharBox {
            ch,
            rect: empty,
            line: empty,
        })
        .collect();
    let mut folded = fold(&boxes).chars;
    while folded.last() == Some(&' ') {
        folded.pop();
    }
    while folded.first() == Some(&' ') {
        folded.remove(0);
    }
    folded
}

/// Vị trí (trong `text`) của mọi lần khớp, có thể chồng nhau. Trả về khoảng ký tự gốc, nửa mở.
pub fn find(text: &[CharBox], query: &str) -> Vec<Range<usize>> {
    let needle = fold_query(query);
    if needle.is_empty() {
        return Vec::new();
    }
    let folded = fold(text);
    let mut hits = Vec::new();
    if folded.chars.len() < needle.len() {
        return hits;
    }
    for start in 0..=folded.chars.len() - needle.len() {
        if folded.chars[start..start + needle.len()] == needle[..] {
            let first = folded.origin[start];
            let last = folded.origin[start + needle.len() - 1];
            hits.push(first..last + 1);
        }
    }
    hits
}

/// Hộp để tô sáng một khoảng ký tự: gộp các ký tự cùng dòng thành một hình chữ nhật.
pub fn rects(text: &[CharBox], range: Range<usize>) -> Vec<Rect> {
    // Mỗi phần tử: hộp đã gộp, và hộp dòng của ký tự đầu tiên (để so dòng với ký tự sau).
    let mut out: Vec<(Rect, Rect)> = Vec::new();
    for cb in &text[range] {
        if cb.ch.is_whitespace() {
            continue;
        }
        let r = cb.rect;
        match out.last_mut() {
            Some((merged, line)) if line.same_line(&cb.line) => {
                merged.left = merged.left.min(r.left);
                merged.right = merged.right.max(r.right);
                merged.top = merged.top.min(r.top);
                merged.bottom = merged.bottom.max(r.bottom);
            }
            _ => out.push((r, cb.line)),
        }
    }
    out.into_iter().map(|(merged, _)| merged).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn boxes(text: &str, line_top: f32) -> Vec<CharBox> {
        text.chars()
            .enumerate()
            .map(|(i, ch)| {
                let rect = Rect {
                    left: i as f32 * 10.0,
                    top: line_top,
                    right: i as f32 * 10.0 + 10.0,
                    bottom: line_top + 12.0,
                };
                CharBox {
                    ch,
                    rect,
                    line: rect,
                }
            })
            .collect()
    }

    #[test]
    fn vietnamese_marks_and_d_stroke_are_folded() {
        let folded: String = "NGHỊ ĐỊNH nghị định Ấn Độ"
            .chars()
            .filter_map(fold_char)
            .collect();
        assert_eq!(folded, "nghi dinh nghi dinh an do");
    }

    #[test]
    fn query_without_diacritics_finds_text_with_them() {
        let text = boxes("Nghị định số 30", 0.0);
        let hits = find(&text, "nghi dinh");
        assert_eq!(hits, vec![0..9]);
        assert_eq!(find(&boxes("NGHỊ ĐỊNH", 0.0), "nghi dinh"), vec![0..9]);
    }

    #[test]
    fn standalone_combining_mark_is_dropped_and_spaces_collapse() {
        // U+0301 đứng riêng không có chữ gốc; hai dấu cách liên tiếp thành một.
        let text = boxes("a\u{0301}b  c", 0.0);
        assert_eq!(fold(&text).chars, vec!['a', 'b', ' ', 'c']);
        assert_eq!(find(&text, "  b  c"), vec![2..6]);
    }

    #[test]
    fn overlapping_matches_are_all_reported() {
        assert_eq!(find(&boxes("aaa", 0.0), "aa"), vec![0..2, 1..3]);
    }

    #[test]
    fn empty_query_and_missing_text_find_nothing() {
        assert!(find(&boxes("abc", 0.0), "   ").is_empty());
        assert!(find(&[], "abc").is_empty());
    }

    #[test]
    fn match_on_one_line_becomes_one_rect_and_two_lines_two() {
        let mut text = boxes("chef pdf", 0.0);
        text.extend(boxes("pdf", 20.0));
        let one_line = rects(&text, 0..4);
        assert_eq!(one_line.len(), 1);
        assert_eq!(one_line[0].left, 0.0);
        assert_eq!(one_line[0].right, 40.0);
        let two_lines = rects(&text, 3..10);
        assert_eq!(two_lines.len(), 2);
    }
}
