//! Chữ của một trang theo vị trí (TASKS_RUST R2.25a): mỗi ký tự kèm hộp bao.
//! Tọa độ tính bằng point (1/72 inch), gốc ở góc trên trái trang, như hệ tọa độ của viewer.

use pdfium_render::prelude::PdfPage;

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
    let height = page.height().value;
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
        let to_rect = |r: &pdfium_render::prelude::PdfRect| Rect {
            left: r.left().value,
            top: height - r.top().value,
            right: r.right().value,
            bottom: height - r.bottom().value,
        };
        let line = to_rect(&loose);
        let rect = tight.as_ref().map(to_rect).unwrap_or(line);
        chars.push(CharBox { ch, rect, line });
    }
    Ok(PageText { chars })
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
    fn page_without_text_has_no_char() {
        assert_eq!(char_at(&[], 1.0, 1.0), None);
    }
}
