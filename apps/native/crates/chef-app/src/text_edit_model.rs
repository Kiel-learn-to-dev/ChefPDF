//! Chế độ sửa chữ: dòng, vùng chọn và caret (TASKS_RUST R7.01–R7.03, R7.12; FEATURES D8, D9, B11, B12):
//! port `textEditModel.ts`, `textLayer.ts` (phần nhãn), `textSelection.ts` và `textSession.ts`. Một vùng
//! chọn là một khoảng trong MỘT đoạn: neo và caret là chỉ số trong `paragraph_text()` (chữ mà phiên sửa
//! đoạn chỉnh), nên khoảng đó chuyển sang ô nhập không đổi. Hộp lấy từ cặp glyph của `text.getLines`
//! (vị trí thật trong PDF), không phải từ xếp lại. Chỉ số tính theo ký tự (char). Logic thuần.
#![allow(dead_code)]

use serde_json::Value;

pub use crate::text_paragraph_model::TextLine;
use crate::text_paragraph_model::paragraph_lines;

/// Dòng của `text.getLines`; dòng thiếu trường bắt buộc bị bỏ.
pub fn read_lines(data: &Value) -> Vec<TextLine> {
    let s = |l: &Value, k: &str| l.get(k).and_then(Value::as_str).map(String::from);
    data.get("lines")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|l| {
            let b = l.get("bbox")?.as_array()?;
            Some(TextLine {
                id: s(l, "id")?,
                page_index: l.get("pageIndex").and_then(Value::as_u64).unwrap_or(0) as usize,
                text: s(l, "text")?,
                bbox: [
                    b.first()?.as_f64()?,
                    b.get(1)?.as_f64()?,
                    b.get(2)?.as_f64()?,
                    b.get(3)?.as_f64()?,
                ],
                font_name: s(l, "fontName").unwrap_or_default(),
                font_size: l.get("fontSize").and_then(Value::as_f64).unwrap_or(0.0),
                bold: l.get("bold").and_then(Value::as_bool).unwrap_or(false),
                italic: l.get("italic").and_then(Value::as_bool).unwrap_or(false),
                colour: s(l, "colour"),
                can_encode_any: l
                    .get("canEncodeAny")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                paragraph_id: s(l, "paragraphId"),
                editable: l.get("editable").and_then(Value::as_bool).unwrap_or(false),
                artifact: l.get("artifact").and_then(Value::as_bool).unwrap_or(false),
                glyphs: l.get("glyphs").and_then(Value::as_array).map(|a| {
                    a.iter()
                        .filter_map(|p| {
                            let p = p.as_array()?;
                            Some((p.first()?.as_f64()?, p.get(1)?.as_f64()?))
                        })
                        .collect()
                }),
            })
        })
        .collect()
}

/// Dòng sửa được dưới một điểm (pt của trang); hộp nhỏ nhất thắng.
pub fn hit_line(lines: &[TextLine], x: f64, y: f64) -> Option<&TextLine> {
    lines
        .iter()
        .filter(|l| l.editable && !l.artifact)
        .filter(|l| x >= l.bbox[0] && x <= l.bbox[2] && y >= l.bbox[1] && y <= l.bbox[3])
        .min_by(|a, b| {
            let area = |l: &TextLine| (l.bbox[2] - l.bbox[0]) * (l.bbox[3] - l.bbox[1]);
            area(a).total_cmp(&area(b))
        })
}

/// Nhãn lớp chữ trên thanh trạng thái, dạng (khóa chuỗi, số chữ, số trang); None khi chưa có trang.
pub fn text_layer_label(pages: u64, text_pages: u64) -> Option<(&'static str, u64, u64)> {
    if pages == 0 {
        None
    } else if text_pages == pages {
        Some(("status.text.all", text_pages, pages))
    } else if text_pages == 0 {
        Some(("status.text.none", 0, pages))
    } else {
        Some(("status.text.mixed", text_pages, pages))
    }
}

// ---- Vùng chọn chữ trên trang ----

/// Khoảng chữ trong một đoạn; `anchor == caret` là không có khoảng.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageSelection {
    pub page_index: usize,
    pub paragraph_id: String,
    pub anchor: usize,
    pub caret: usize,
}

/// Một ký tự của đoạn: chỉ số trong chữ và hộp của nó (pt, khung hiển thị).
#[derive(Debug, Clone, PartialEq)]
pub struct Glyph {
    pub index: usize,
    pub row: usize,
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
}

/// Đoạn như trình sửa đọc: cùng chữ với `paragraph_text()`, kèm hộp từng ký tự.
#[derive(Debug, Clone, PartialEq)]
pub struct ParagraphGlyphs {
    pub text: String,
    pub glyphs: Vec<Glyph>,
    /// Số hàng hiển thị (dòng).
    pub rows: usize,
}

/// Hộp một khoảng trên một hàng.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RangeBox {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

/// Các ký tự của đoạn theo thứ tự chữ. Mỗi dòng đóng góp chữ đã cắt khoảng trắng đầu cuối (như
/// `paragraph_text`) và một khoảng trắng nối giữa các dòng có chữ. Dòng không có cặp glyph (lõi cũ) thì
/// các ký tự được chia đều theo hộp của dòng.
pub fn paragraph_glyphs(lines: &[TextLine], paragraph_id: &str) -> ParagraphGlyphs {
    let mut text = String::new();
    let mut glyphs = Vec::new();
    let mut row = 0;
    let mut len = 0usize;
    for line in paragraph_lines(lines, paragraph_id) {
        let body = line.text.trim();
        let n = body.chars().count();
        if n == 0 {
            continue;
        }
        if len > 0 {
            text.push(' ');
            len += 1;
        }
        let base = len;
        let lead = line.text.chars().count() - line.text.trim_start().chars().count();
        let [l, t, r, b] = line.bbox;
        let step = (r - l) / n as f64;
        let pairs = line
            .glyphs
            .as_ref()
            .filter(|p| p.len() == line.text.chars().count());
        for k in 0..n {
            let (left, right) = pairs
                .and_then(|p| p.get(lead + k).copied())
                .unwrap_or((l + k as f64 * step, l + (k + 1) as f64 * step));
            glyphs.push(Glyph {
                index: base + k,
                row,
                left,
                right,
                top: t,
                bottom: b,
            });
        }
        text.push_str(body);
        len += n;
        row += 1;
    }
    ParagraphGlyphs {
        text,
        glyphs,
        rows: row,
    }
}

/// Chỉ số chữ gần nhất một điểm (pt) trong đoạn. Chọn hàng theo dải của nó, rồi theo x.
pub fn index_at(pg: &ParagraphGlyphs, x: f64, y: f64) -> usize {
    if pg.glyphs.is_empty() {
        return 0;
    }
    let (mut best_row, mut best_dist) = (0, f64::INFINITY);
    for r in 0..pg.rows {
        let Some(g) = pg.glyphs.iter().find(|g| g.row == r) else {
            continue;
        };
        let dist = if y < g.top {
            g.top - y
        } else if y > g.bottom {
            y - g.bottom
        } else {
            0.0
        };
        if dist < best_dist {
            best_dist = dist;
            best_row = r;
        }
    }
    let row: Vec<&Glyph> = pg.glyphs.iter().filter(|g| g.row == best_row).collect();
    // Ranh giới của hàng: trước mỗi ký tự và sau ký tự cuối.
    let (mut index, mut dist) = (row[0].index, f64::INFINITY);
    for g in &row {
        let d = (x - g.left).abs();
        if d < dist {
            dist = d;
            index = g.index;
        }
    }
    let last = row[row.len() - 1];
    if (x - last.right).abs() < dist {
        index = last.index + 1;
    }
    index
}

/// Hộp của các ký tự giữa hai chỉ số, mỗi hàng một hộp.
pub fn range_boxes(pg: &ParagraphGlyphs, from: usize, to: usize) -> Vec<RangeBox> {
    let (lo, hi) = (from.min(to), from.max(to));
    if lo == hi {
        return vec![];
    }
    (0..pg.rows)
        .filter_map(|r| {
            let inr: Vec<&Glyph> = pg
                .glyphs
                .iter()
                .filter(|g| g.row == r && g.index >= lo && g.index < hi)
                .collect();
            let first = inr.first()?;
            let left = inr.iter().map(|g| g.left).fold(f64::INFINITY, f64::min);
            let right = inr
                .iter()
                .map(|g| g.right)
                .fold(f64::NEG_INFINITY, f64::max);
            Some(RangeBox {
                left,
                top: first.top,
                width: right - left,
                height: first.bottom - first.top,
            })
        })
        .collect()
}

/// Từ quanh một chỉ số: từ đầu từ đến cuối từ (khoảng trắng tách từ).
pub fn word_range(text: &str, index: usize) -> (usize, usize) {
    let chars: Vec<char> = text.chars().collect();
    let at = index.min(chars.len());
    let (mut from, mut to) = (at, at);
    while from > 0 && !chars[from - 1].is_whitespace() {
        from -= 1;
    }
    while to < chars.len() && !chars[to].is_whitespace() {
        to += 1;
    }
    (from, to)
}

/// Khoảng kẹp vào chữ dài `length` (sau khi đọc lại làm đổi chữ): (neo, caret).
pub fn clamp_range(anchor: usize, caret: usize, length: usize) -> (usize, usize) {
    (anchor.min(length), caret.min(length))
}

// ---- Phiên sửa: caret và hàng ----

/// Một hàng từ `text.previewParagraph`: điểm đầu đường cơ sở, x mỗi ký tự sau điểm đầu (`char_x` nhiều
/// hơn hàng một phần tử) và chỉ số trong chữ đoạn của mỗi ký tự (`index`).
#[derive(Debug, Clone, PartialEq)]
pub struct SessionRow {
    pub text: String,
    /// Trái của hàng, pt.
    pub x: f64,
    /// Đường cơ sở, pt (gốc trên-trái, như getLines).
    pub baseline: f64,
    pub char_x: Vec<f64>,
    pub index: Vec<usize>,
}

/// Đọc `rows` của `text.previewParagraph`; hàng thiếu trường bị bỏ.
pub fn read_rows(data: &Value) -> Vec<SessionRow> {
    let nums = |v: &Value, k: &str| -> Option<Vec<f64>> {
        v.get(k)?.as_array()?.iter().map(Value::as_f64).collect()
    };
    data.get("rows")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|r| {
            Some(SessionRow {
                text: r
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                x: r.get("x")?.as_f64()?,
                baseline: r.get("baseline")?.as_f64()?,
                char_x: nums(r, "charX")?,
                index: r
                    .get("index")?
                    .as_array()?
                    .iter()
                    .map(|v| v.as_u64().map(|n| n as usize))
                    .collect::<Option<Vec<_>>>()?,
            })
        })
        .collect()
}

/// Vị trí caret: hàng, x, đường cơ sở.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pos {
    pub row: usize,
    pub x: f64,
    pub baseline: f64,
}

/// Nơi vẽ caret cho chỉ số `i`; None khi không có hàng.
pub fn caret_at(rows: &[SessionRow], i: usize) -> Option<Pos> {
    let first = rows.first()?;
    for (r, row) in rows.iter().enumerate() {
        if let Some(k) = row.index.iter().position(|&x| x == i) {
            return Some(Pos {
                row: r,
                x: row.x + row.char_x[k],
                baseline: row.baseline,
            });
        }
    }
    // Không ký tự nào bắt đầu ở i (khoảng trắng ngắt dòng, hoặc cuối): vẽ sau ký tự cuối trước nó.
    let mut last = None;
    for (r, row) in rows.iter().enumerate() {
        for (k, &idx) in row.index.iter().enumerate() {
            if idx < i {
                last = Some(Pos {
                    row: r,
                    x: row.x + row.char_x.get(k + 1).copied().unwrap_or(row.char_x[k]),
                    baseline: row.baseline,
                });
            }
        }
    }
    Some(last.unwrap_or(Pos {
        row: 0,
        x: first.x,
        baseline: first.baseline,
    }))
}

/// Chỉ số trong một hàng gần x nhất.
fn index_in_row(row: &SessionRow, x: f64) -> usize {
    let (mut best, mut best_dist) = (0, f64::INFINITY);
    for (k, cx) in row.char_x.iter().enumerate() {
        let d = (row.x + cx - x).abs();
        if d < best_dist {
            best_dist = d;
            best = k;
        }
    }
    let n = row.index.len();
    if best < n {
        row.index[best]
    } else if n > 0 {
        row.index[n - 1] + 1
    } else {
        0
    }
}

/// Chỉ số chữ gần một điểm; chọn hàng có đường cơ sở gần y nhất.
pub fn caret_from_point(rows: &[SessionRow], x: f64, y: f64) -> Option<usize> {
    let (mut best, mut best_dist) = (0, f64::INFINITY);
    for (r, row) in rows.iter().enumerate() {
        let d = (row.baseline - y).abs();
        if d < best_dist {
            best_dist = d;
            best = r;
        }
    }
    rows.get(best).map(|row| index_in_row(row, x))
}

/// Lên hoặc xuống một hàng hiển thị, giữ x của caret. Hàng đầu hoặc cuối thì đứng yên.
pub fn move_vertically(rows: &[SessionRow], i: usize, dir: i32) -> usize {
    let Some(pos) = caret_at(rows, i) else {
        return i;
    };
    let target = pos.row as i64 + dir as i64;
    if target < 0 || target >= rows.len() as i64 {
        return i;
    }
    index_in_row(&rows[target as usize], pos.x)
}

/// Đầu hàng hiển thị mà caret đang ở.
pub fn line_start(rows: &[SessionRow], i: usize) -> usize {
    caret_at(rows, i)
        .and_then(|p| rows[p.row].index.first().copied())
        .unwrap_or(i)
}

/// Cuối hàng hiển thị (sau ký tự cuối).
pub fn line_end(rows: &[SessionRow], i: usize) -> usize {
    caret_at(rows, i)
        .and_then(|p| rows[p.row].index.last().map(|l| l + 1))
        .unwrap_or(i)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Box4 {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

/// Hộp tô sáng (pt) của các ký tự giữa hai chỉ số, mỗi hàng một hộp. Hộp phủ dải glyph của hàng: từ
/// đường cơ sở lên theo ascent đến dưới nó.
pub fn selection_boxes(rows: &[SessionRow], from: usize, to: usize, font_size: f64) -> Vec<Box4> {
    let (lo, hi) = (from.min(to), from.max(to));
    if lo == hi {
        return vec![];
    }
    rows.iter()
        .filter_map(|row| {
            let ks: Vec<usize> = row
                .index
                .iter()
                .enumerate()
                .filter(|(_, &at)| at >= lo && at < hi)
                .map(|(k, _)| k)
                .collect();
            let (start, end) = (*ks.first()?, ks.last()? + 1);
            let left = row.x + row.char_x[start];
            let right = row.x + row.char_x.get(end).copied().unwrap_or(row.char_x[end - 1]);
            Some(Box4 {
                left,
                top: row.baseline - 0.8 * font_size,
                width: right - left,
                height: 1.2 * font_size,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line(par: &str, text: &str, bbox: [f64; 4], glyphs: Option<Vec<(f64, f64)>>) -> TextLine {
        TextLine {
            paragraph_id: Some(par.into()),
            editable: true,
            text: text.into(),
            bbox,
            glyphs,
            ..Default::default()
        }
    }

    #[test]
    fn reads_lines_and_hit_tests_smallest_box() {
        let l = read_lines(&json!({"lines":[
            {"id":"a","pageIndex":1,"text":"xin chào","bbox":[10,10,100,30],"editable":true,"paragraphId":"P1:a:0","fontSize":12,"glyphs":[[10,15],[15,20]]},
            {"id":"b","text":"nhỏ","bbox":[20,15,40,25],"editable":true},
            {"id":"c","text":"khóa","bbox":[0,0,200,200],"editable":false},
            {"id":"d","text":"hdr","bbox":[0,0,200,200],"editable":true,"artifact":true},
            {"text":"thiếu id","bbox":[0,0,1,1]}, {"id":"e","text":"x","bbox":[1,2]}]}));
        assert_eq!(l.len(), 4);
        assert_eq!(
            (l[0].page_index, l[0].glyphs.clone().map(|g| g.len())),
            (1, Some(2))
        );
        assert_eq!(hit_line(&l, 25.0, 20.0).map(|x| x.id.as_str()), Some("b"));
        assert_eq!(hit_line(&l, 80.0, 20.0).map(|x| x.id.as_str()), Some("a"));
        assert_eq!(
            hit_line(&l, 150.0, 150.0),
            None,
            "dòng khóa và Artifact không trúng"
        );
        assert_eq!(text_layer_label(0, 0), None);
        assert_eq!(text_layer_label(5, 5), Some(("status.text.all", 5, 5)));
        assert_eq!(text_layer_label(5, 0), Some(("status.text.none", 0, 5)));
        assert_eq!(text_layer_label(5, 2), Some(("status.text.mixed", 2, 5)));
    }

    fn para() -> Vec<TextLine> {
        vec![
            line(
                "P0:a:0",
                "  ab cd ",
                [0.0, 0.0, 80.0, 10.0],
                Some(vec![
                    (0.0, 5.0),
                    (5.0, 10.0),
                    (10.0, 20.0),
                    (20.0, 30.0),
                    (30.0, 40.0),
                    (40.0, 50.0),
                    (50.0, 60.0),
                    (60.0, 80.0),
                ]),
            ),
            line("P0:a:0", "ef", [0.0, 12.0, 20.0, 22.0], None),
        ]
    }

    #[test]
    fn glyph_boxes_follow_trimmed_text() {
        let pg = paragraph_glyphs(&para(), "P0:a:0");
        assert_eq!(
            (pg.text.as_str(), pg.glyphs.len(), pg.rows),
            ("ab cd ef", 7, 2)
        );
        assert_eq!(
            pg.text,
            crate::text_paragraph_model::paragraph_text(&para(), "P0:a:0")
        );
        // dòng 1 bỏ 2 khoảng trắng đầu: 'a' lấy cặp thứ 3 (10..20)
        assert_eq!((pg.glyphs[0].left, pg.glyphs[0].right), (10.0, 20.0));
        // dòng 2 không có glyph: chia đều 20 pt cho 2 ký tự
        assert_eq!(
            (
                pg.glyphs[5].left,
                pg.glyphs[5].right,
                pg.glyphs[5].row,
                pg.glyphs[6].right
            ),
            (0.0, 10.0, 1, 20.0)
        );
        assert_eq!(paragraph_glyphs(&para(), "none").rows, 0);
    }

    #[test]
    fn index_from_point_and_range_boxes() {
        let pg = paragraph_glyphs(&para(), "P0:a:0");
        assert_eq!(index_at(&pg, 0.0, 5.0), 0);
        assert_eq!(index_at(&pg, 38.0, 5.0), 3, "gần ranh giới trước 'c'");
        assert_eq!(index_at(&pg, 200.0, 5.0), 5, "sau ký tự cuối của hàng 1");
        assert_eq!(index_at(&pg, 0.0, 30.0), 6, "y thấp hơn: hàng 2");
        assert_eq!(index_at(&pg, 100.0, 30.0), 8, "sau ký tự cuối của hàng 2");
        assert_eq!(
            index_at(
                &ParagraphGlyphs {
                    text: String::new(),
                    glyphs: vec![],
                    rows: 0
                },
                1.0,
                1.0
            ),
            0
        );
        assert!(range_boxes(&pg, 2, 2).is_empty());
        let b = range_boxes(&pg, 1, 7);
        assert_eq!(b.len(), 2);
        assert_eq!(
            (b[0].left, b[0].width, b[0].height, b[1].left, b[1].width),
            (20.0, 40.0, 10.0, 0.0, 10.0)
        );
        assert_eq!(range_boxes(&pg, 7, 1), b, "thứ tự hai đầu không quan trọng");
    }

    #[test]
    fn words_and_clamping() {
        assert_eq!(word_range("xin chào bạn", 6), (4, 8));
        assert_eq!(word_range("xin chào bạn", 3), (0, 3));
        assert_eq!(word_range("xin chào bạn", 4), (4, 8));
        assert_eq!(
            word_range("xin  bạn", 4),
            (4, 4),
            "trong khoảng trắng kép: khoảng rỗng"
        );
        assert_eq!(word_range("ab", 99), (0, 2));
        assert_eq!(word_range("", 0), (0, 0));
        assert_eq!(clamp_range(10, 3, 5), (5, 3));
    }

    fn rows() -> Vec<SessionRow> {
        read_rows(&json!({"rows":[
            {"text":"ab cd","x":10,"baseline":20,"charX":[0,5,10,15,20,25],"index":[0,1,2,3,4]},
            {"text":"ef","x":10,"baseline":40,"charX":[0,5,10],"index":[6,7]},
            {"x":1}]}))
    }

    #[test]
    fn caret_positions() {
        let r = rows();
        assert_eq!(r.len(), 2);
        assert_eq!(
            caret_at(&r, 3),
            Some(Pos {
                row: 0,
                x: 25.0,
                baseline: 20.0
            })
        );
        assert_eq!(
            caret_at(&r, 6),
            Some(Pos {
                row: 1,
                x: 10.0,
                baseline: 40.0
            })
        );
        assert_eq!(
            caret_at(&r, 5),
            Some(Pos {
                row: 0,
                x: 35.0,
                baseline: 20.0
            }),
            "khoảng trắng ngắt dòng: sau ký tự cuối trước nó"
        );
        assert_eq!(
            caret_at(&r, 8),
            Some(Pos {
                row: 1,
                x: 20.0,
                baseline: 40.0
            }),
            "cuối đoạn"
        );
        assert_eq!(caret_at(&r, 0).map(|p| p.x), Some(10.0));
        assert_eq!(caret_at(&[], 0), None);
    }

    #[test]
    fn caret_movement() {
        let r = rows();
        assert_eq!(caret_from_point(&r, 26.0, 19.0), Some(3));
        assert_eq!(caret_from_point(&r, 100.0, 39.0), Some(8));
        assert_eq!(caret_from_point(&[], 0.0, 0.0), None);
        assert_eq!(
            move_vertically(&r, 3, 1),
            8,
            "x=25 gần ranh giới x=20 (sau ký tự cuối) của hàng 2 nhất"
        );
        assert_eq!(move_vertically(&r, 3, -1), 3, "hàng đầu: đứng yên");
        assert_eq!(move_vertically(&r, 7, 1), 7, "hàng cuối: đứng yên");
        assert_eq!(move_vertically(&r, 7, -1), 1);
        assert_eq!(
            (
                line_start(&r, 3),
                line_end(&r, 3),
                line_start(&r, 7),
                line_end(&r, 7)
            ),
            (0, 5, 6, 8)
        );
        assert_eq!(line_start(&[], 4), 4);
    }

    #[test]
    fn selection_highlight() {
        let r = rows();
        assert!(selection_boxes(&r, 2, 2, 10.0).is_empty());
        let b = selection_boxes(&r, 1, 7, 10.0);
        assert_eq!(b.len(), 2);
        assert_eq!(
            (b[0].left, b[0].width, b[0].top, b[0].height),
            (15.0, 20.0, 12.0, 12.0)
        );
        assert_eq!((b[1].left, b[1].width, b[1].top), (10.0, 5.0, 32.0));
        assert!(selection_boxes(&r, 100, 200, 10.0).is_empty());
    }
}
