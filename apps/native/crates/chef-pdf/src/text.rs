//! Chữ của một trang theo vị trí (TASKS_RUST R2.25a): mỗi ký tự kèm hộp bao.
//! Tọa độ tính bằng point (1/72 inch), gốc ở góc trên trái trang, như hệ tọa độ của viewer.

use pdfium_render::prelude::{PdfPage, PdfPageRenderRotation};

/// Hình chữ nhật, point, gốc trên trái trang.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub left: f32,
    pub top: f32,
    pub right: f32,
    pub bottom: f32,
}

/// Một ký tự, hộp glyph (`rect`, dùng để chọn và tô sáng) và hộp dòng (`line`, dùng để biết
/// ký tự nào cùng dòng). Hộp dòng là hộp loose: cùng cỡ chữ thì cùng chiều cao, nên không bị lệch
/// vì dấu hay dấu gạch ngắn như hộp glyph.
///
/// `rect` nằm trong hệ tọa độ trang đã xoay theo `/Rotate` (như bitmap pdfium vẽ ra). `line` nằm
/// trong hệ tọa độ trang chưa xoay, nơi dòng chữ nằm ngang: nhờ vậy trang bị xoay 90° (chữ chạy
/// dọc trên màn hình) vẫn tách dòng đúng, và chữ copy ra không đổi khi trang được xoay.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CharBox {
    pub ch: char,
    pub rect: Rect,
    pub line: Rect,
}

/// Ký tự của trang theo thứ tự pdfium trả về (gần thứ tự đọc). Trang scan trả danh sách rỗng.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PageText {
    pub chars: Vec<CharBox>,
}

/// Đọc chữ của trang. Ký tự không có Unicode hoặc không có hộp bị bỏ qua.
pub fn read_page(page: &PdfPage) -> Result<PageText, String> {
    let text = page.text().map_err(|e| format!("đọc chữ trang: {e}"))?;
    // Kích thước pdfium trả về là của trang đã xoay; hộp ký tự thì ở hệ tọa độ chưa xoay.
    let (width, height) = (page.width().value, page.height().value);
    let quarter = match page.rotation() {
        Ok(PdfPageRenderRotation::Degrees90) => 1,
        Ok(PdfPageRenderRotation::Degrees180) => 2,
        Ok(PdfPageRenderRotation::Degrees270) => 3,
        _ => 0,
    };
    let unrotated_height = if quarter % 2 == 1 { width } else { height };
    let mut chars = Vec::new();
    for c in text.chars().iter() {
        let Some(ch) = c.unicode_char() else { continue };
        // Hộp glyph (tight) khớp với chữ đã vẽ. Hộp loose bao cả khoảng ascent và descent nên
        // chồng lên dòng dưới. Khoảng trắng không có glyph thì dùng hộp loose.
        let tight = c
            .tight_bounds()
            .ok()
            .filter(|r| r.right().value > r.left().value && r.top().value > r.bottom().value);
        let Ok(loose) = c.loose_bounds() else {
            continue;
        };
        let user = |r: &pdfium_render::prelude::PdfRect| {
            (
                r.left().value,
                r.bottom().value,
                r.right().value,
                r.top().value,
            )
        };
        let line = to_view(0, 0.0, unrotated_height, user(&loose));
        let rect = to_view(
            quarter,
            width,
            height,
            user(tight.as_ref().unwrap_or(&loose)),
        );
        chars.push(CharBox { ch, rect, line });
    }
    Ok(PageText {
        chars: normalize_lines(chars, quarter != 0),
    })
}

/// Chuẩn hóa dòng: tách ký tự thành các dòng, rồi nối lại với đúng một ký tự xuống dòng giữa hai
/// dòng.
///
/// Một dòng kết thúc ở chỗ pdfium tự chèn ký tự xuống dòng (CR, LF) hoặc ở chỗ hộp dòng đổi.
/// Với trang có `/Rotate`, pdfium trả các dòng theo vị trí sau khi xoay (ví dụ ngược từ dưới lên);
/// `reorder` xếp lại theo thứ tự từ trên xuống của trang chưa xoay. Nhờ vậy cùng một trang cho cùng
/// dãy ký tự trước và sau khi xoay: vùng chọn (theo chỉ số ký tự) và chữ copy ra không đổi.
/// Thứ tự ký tự trong một dòng được giữ nguyên.
fn normalize_lines(chars: Vec<CharBox>, reorder: bool) -> Vec<CharBox> {
    let mut lines: Vec<Vec<CharBox>> = Vec::new();
    let mut broken = true;
    for cb in chars {
        if is_line_break(cb.ch) {
            broken = true;
            continue;
        }
        match lines.last_mut() {
            Some(line)
                if !broken
                    && line
                        .last()
                        .is_some_and(|prev| prev.line.same_line(&cb.line)) =>
            {
                line.push(cb)
            }
            _ => lines.push(vec![cb]),
        }
        broken = false;
    }
    if reorder {
        // Sắp xếp ổn định: các dòng cùng độ cao (hai cột) giữ thứ tự pdfium đã cho.
        lines.sort_by(|a, b| a[0].line.top.total_cmp(&b[0].line.top));
    }
    let mut out: Vec<CharBox> = Vec::new();
    for line in lines {
        if let Some(prev) = out.last().copied() {
            out.push(line_break_after(&prev));
        }
        out.extend(line);
    }
    out
}

/// Ký tự xuống dòng (pdfium tự chèn cuối dòng, không có glyph).
pub fn is_line_break(ch: char) -> bool {
    ch == '\r' || ch == '\n'
}

/// Một `\n` không có bề rộng, đặt ở mép phải của ký tự cuối dòng.
fn line_break_after(prev: &CharBox) -> CharBox {
    let at_right_edge = |r: Rect| Rect { left: r.right, ..r };
    CharBox {
        ch: '\n',
        rect: at_right_edge(prev.rect),
        line: at_right_edge(prev.line),
    }
}

/// Đổi hộp `(left, bottom, right, top)` ở hệ tọa độ PDF chưa xoay (gốc dưới trái, y hướng lên) sang
/// hệ của trang đã xoay `quarter` × 90° theo chiều kim đồng hồ (gốc trên trái, y hướng xuống).
/// `width` và `height` là kích thước trang sau khi xoay.
fn to_view(quarter: u8, width: f32, height: f32, user: (f32, f32, f32, f32)) -> Rect {
    let (left, bottom, right, top) = user;
    let point = |x: f32, y: f32| match quarter % 4 {
        0 => (x, height - y),
        1 => (y, x),
        2 => (width - x, y),
        _ => (width - y, height - x),
    };
    let (ax, ay) = point(left, bottom);
    let (bx, by) = point(right, top);
    Rect {
        left: ax.min(bx),
        top: ay.min(by),
        right: ax.max(bx),
        bottom: ay.max(by),
    }
}

impl Rect {
    /// Hai hộp cùng dòng khi phần chồng lên nhau theo chiều dọc ít nhất bằng nửa chiều cao nhỏ hơn.
    /// Dùng độ chồng lên nhau, không dùng tâm. Với hộp dòng (loose) của cùng cỡ chữ, chữ cùng
    /// dòng luôn chồng nhau gần như hết, còn dòng khác thì không.
    pub fn same_line(&self, other: &Rect) -> bool {
        let overlap = self.bottom.min(other.bottom) - self.top.max(other.top);
        let smaller = (self.bottom - self.top).min(other.bottom - other.top);
        overlap >= smaller / 2.0
    }

    fn contains(&self, x: f32, y: f32) -> bool {
        x >= self.left && x <= self.right && y >= self.top && y <= self.bottom
    }

    /// Bình phương khoảng cách từ điểm tới tâm hình chữ nhật.
    fn center_distance2(&self, x: f32, y: f32) -> f32 {
        let (cx, cy) = (
            (self.left + self.right) / 2.0,
            (self.top + self.bottom) / 2.0,
        );
        (cx - x).powi(2) + (cy - y).powi(2)
    }

    /// Khoảng cách từ điểm tới hình chữ nhật (0 nếu điểm nằm trong).
    fn distance(&self, x: f32, y: f32) -> f32 {
        let dx = (self.left - x).max(x - self.right).max(0.0);
        let dy = (self.top - y).max(y - self.bottom).max(0.0);
        (dx * dx + dy * dy).sqrt()
    }
}

/// Chỉ số ký tự dưới điểm (x, y) của trang, tọa độ point, gốc trên trái.
/// Ưu tiên ký tự chứa điểm (nếu nhiều, lấy ký tự có tâm gần điểm nhất); không có thì lấy ký tự
/// gần nhất. Trang không có chữ trả None.
pub fn char_at(chars: &[CharBox], x: f32, y: f32) -> Option<usize> {
    let containing = chars
        .iter()
        .enumerate()
        .filter(|(_, c)| c.rect.contains(x, y))
        .min_by(|(_, a), (_, b)| {
            a.rect
                .center_distance2(x, y)
                .partial_cmp(&b.rect.center_distance2(x, y))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(i, _)| i);
    if containing.is_some() {
        return containing;
    }
    chars
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| {
            a.rect
                .distance(x, y)
                .partial_cmp(&b.rect.distance(x, y))
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .map(|(i, _)| i)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cb(ch: char, left: f32) -> CharBox {
        let rect = Rect {
            left,
            top: 100.0,
            right: left + 10.0,
            bottom: 112.0,
        };
        CharBox {
            ch,
            rect,
            line: rect,
        }
    }

    #[test]
    fn point_inside_a_char_picks_that_char() {
        let chars = [cb('a', 0.0), cb('ệ', 10.0), cb('b', 20.0)];
        assert_eq!(char_at(&chars, 15.0, 105.0), Some(1));
        assert_eq!(char_at(&chars, 0.0, 100.0), Some(0));
    }

    #[test]
    fn point_outside_text_picks_the_nearest_char() {
        let chars = [cb('a', 0.0), cb('b', 20.0)];
        assert_eq!(char_at(&chars, 40.0, 106.0), Some(1));
        assert_eq!(char_at(&chars, -5.0, 106.0), Some(0));
    }

    #[test]
    fn user_boxes_follow_the_page_rotation() {
        // Trang chưa xoay 200×100 point; hộp sát góc dưới trái: x 10..30, y 5..15.
        let user = (10.0, 5.0, 30.0, 15.0);
        let rect = |left, top, right, bottom| Rect {
            left,
            top,
            right,
            bottom,
        };
        assert_eq!(to_view(0, 200.0, 100.0, user), rect(10.0, 85.0, 30.0, 95.0));
        // Xoay 90° thuận chiều kim đồng hồ: góc dưới trái lên góc trên trái, trang thành 100×200.
        assert_eq!(to_view(1, 100.0, 200.0, user), rect(5.0, 10.0, 15.0, 30.0));
        assert_eq!(
            to_view(2, 200.0, 100.0, user),
            rect(170.0, 5.0, 190.0, 15.0)
        );
        // Xoay 270°: góc dưới trái xuống góc dưới phải.
        assert_eq!(
            to_view(3, 100.0, 200.0, user),
            rect(85.0, 170.0, 95.0, 190.0)
        );
    }

    #[test]
    fn rotated_page_lines_are_put_back_in_reading_order() {
        let at = |ch, left: f32, top: f32| {
            let rect = Rect {
                left,
                top,
                right: left + 10.0,
                bottom: top + 12.0,
            };
            CharBox {
                ch,
                rect,
                line: rect,
            }
        };
        // pdfium đưa dòng dưới ("cd") trước dòng trên ("ab").
        let chars = vec![
            at('c', 0.0, 50.0),
            at('d', 10.0, 50.0),
            at('\r', 20.0, 50.0),
            at('\n', 20.0, 50.0),
            at('a', 0.0, 10.0),
            at('b', 10.0, 10.0),
        ];
        let text: String = normalize_lines(chars, true).iter().map(|c| c.ch).collect();
        assert_eq!(text, "ab\ncd");
    }

    #[test]
    fn page_without_text_has_no_char() {
        assert_eq!(char_at(&[], 1.0, 1.0), None);
    }
}
