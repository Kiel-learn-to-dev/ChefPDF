//! Chế độ sửa đoạn (TASKS_RUST R7.04, R7.05, R7.06; FEATURES D9): port `textParagraphModel.ts`. Dòng của
//! một đoạn, chữ cho ô sửa (các dòng nối bằng khoảng trắng, lõi tự xuống dòng lại), tham số
//! `text.editParagraph`/`text.styleParagraph`, cảnh báo và nhãn ký tự vô hình. Logic thuần.
#![allow(dead_code)]

use serde_json::{Value, json};

/// Dòng chữ của `text.getLines` (phần chế độ đoạn đọc).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct TextLine {
    pub id: String,
    pub page_index: usize,
    pub font_name: String,
    pub can_encode_any: bool,
    /// [trái, phải] (pt) của từng ký tự trong `text`, theo thứ tự đọc; None khi lõi cũ không có.
    pub glyphs: Option<Vec<(f64, f64)>>,
    pub paragraph_id: Option<String>,
    pub editable: bool,
    pub artifact: bool,
    /// [trái, trên, phải, dưới], pt đã xoay theo hiển thị.
    pub bbox: [f64; 4],
    pub text: String,
    pub font_size: f64,
    pub bold: bool,
    pub italic: bool,
    pub colour: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextBlock {
    pub id: String,
    pub bbox: [f64; 4],
}

/// Dòng của một đoạn, từ trên xuống rồi trái sang phải; bỏ dòng không sửa được và Artifact.
pub fn paragraph_lines<'a>(lines: &'a [TextLine], id: &str) -> Vec<&'a TextLine> {
    let mut v: Vec<&TextLine> = lines
        .iter()
        .filter(|l| l.paragraph_id.as_deref() == Some(id) && l.editable && !l.artifact)
        .collect();
    v.sort_by(|a, b| {
        a.bbox[1]
            .total_cmp(&b.bbox[1])
            .then(a.bbox[0].total_cmp(&b.bbox[0]))
    });
    v
}

/// Chữ ô sửa hiển thị: các dòng theo thứ tự, nối bằng khoảng trắng (ngắt dòng mềm).
pub fn paragraph_text(lines: &[TextLine], id: &str) -> String {
    paragraph_lines(lines, id)
        .iter()
        .map(|l| l.text.trim())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Hộp hợp của các dòng trong đoạn, hoặc None khi đoạn không có dòng.
pub fn paragraph_box(lines: &[TextLine], id: &str) -> Option<[f64; 4]> {
    let ls = paragraph_lines(lines, id);
    let first = ls.first()?.bbox;
    Some(ls.iter().fold(first, |a, l| {
        [
            a[0].min(l.bbox[0]),
            a[1].min(l.bbox[1]),
            a[2].max(l.bbox[2]),
            a[3].max(l.bbox[3]),
        ]
    }))
}

/// Giá trị đổi kiểu: `Keep` giữ nguyên, nên chỉ trường được chọn mới đổi.
#[derive(Debug, Clone, PartialEq)]
pub enum Keep<T> {
    Keep,
    Set(T),
}

impl<T: Into<Value> + Clone> Keep<T> {
    fn to_json(&self) -> Value {
        match self {
            Keep::Keep => "keep".into(),
            Keep::Set(v) => v.clone().into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParagraphStyle {
    /// "left", "center", "right", "justify".
    pub align: Keep<String>,
    /// Bước dòng, pt.
    pub line_spacing: Keep<f64>,
    pub font_size: Keep<f64>,
    pub color: Keep<String>,
    pub bold: Keep<bool>,
    pub italic: Keep<bool>,
    /// Thụt lề dòng đầu, pt (≥ 0).
    pub indent: Keep<f64>,
}

impl Default for ParagraphStyle {
    fn default() -> Self {
        Self {
            align: Keep::Keep,
            line_spacing: Keep::Keep,
            font_size: Keep::Keep,
            color: Keep::Keep,
            bold: Keep::Keep,
            italic: Keep::Keep,
            indent: Keep::Keep,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParagraphInfo {
    pub id: String,
    pub align: String,
    pub indent: f64,
}

/// Định dạng của đoạn đang chọn, như hàng định dạng hiển thị.
#[derive(Debug, Clone, PartialEq)]
pub struct CurrentFormat {
    /// Căn lề đọc từ hình học dòng; "none" khi một dòng không phân biệt được trái với giữa (D58).
    pub align: String,
    pub indent: f64,
    pub font_size: f64,
    pub bold: bool,
    pub italic: bool,
    pub colour: Option<String>,
}

pub fn current_format(
    lines: &[TextLine],
    paragraphs: &[ParagraphInfo],
    id: &str,
) -> Option<CurrentFormat> {
    let own = paragraph_lines(lines, id);
    let first = own.first()?;
    let info = paragraphs.iter().find(|p| p.id == id)?;
    Some(CurrentFormat {
        align: if own.len() >= 2 {
            info.align.clone()
        } else {
            "none".into()
        },
        indent: info.indent,
        font_size: first.font_size,
        bold: first.bold,
        italic: first.italic,
        colour: first.colour.clone(),
    })
}

/// Trang của đoạn từ mã `P<trang>:<digest>:<n>`; None khi mã sai.
pub fn page_of_paragraph(id: &str) -> Option<usize> {
    let rest = id.strip_prefix('P')?;
    let end = rest.find(':')?;
    let digits = &rest[..end];
    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
        .then(|| digits.parse().ok())
        .flatten()
}

/// Vị trí của đoạn trên trang (số `<n>` cuối mã); None khi mã sai.
pub fn paragraph_index(id: &str) -> Option<usize> {
    let tail = id.rsplit_once(':')?.1;
    (!tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()))
        .then(|| tail.parse().ok())
        .flatten()
}

pub fn paragraph_centre(lines: &[TextLine], id: &str) -> Option<[f64; 2]> {
    let b = paragraph_box(lines, id)?;
    Some([(b[0] + b[2]) / 2.0, (b[1] + b[3]) / 2.0])
}

/// Đoạn cần chọn lại sau khi đổi kiểu làm đọc lại trang: đoạn cùng vị trí (`<n>` trong mã), nếu
/// không thì đoạn chứa tâm cũ. None khi không thấy.
pub fn reselect_paragraph(
    lines: &[TextLine],
    old_id: &str,
    old_centre: Option<[f64; 2]>,
) -> Option<String> {
    let mut ids: Vec<&str> = Vec::new();
    for l in lines {
        if let Some(id) = l.paragraph_id.as_deref()
            && !ids.contains(&id)
        {
            ids.push(id);
        }
    }
    let index = paragraph_index(old_id);
    if let Some(same) = ids.iter().find(|id| paragraph_index(id) == index) {
        return Some((*same).to_string());
    }
    let [x, y] = old_centre?;
    ids.iter()
        .find(|id| {
            paragraph_box(lines, id)
                .is_some_and(|b| x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3])
        })
        .map(|s| (*s).to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontStrategy {
    Auto,
    Keep,
    Replace,
}

impl FontStrategy {
    fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Keep => "keep",
            Self::Replace => "replace",
        }
    }
}

fn style_fields(v: &mut Value, s: &ParagraphStyle) {
    v["align"] = s.align.to_json();
    v["lineSpacing"] = s.line_spacing.to_json();
    v["fontSize"] = s.font_size.to_json();
    v["color"] = s.color.to_json();
    v["bold"] = s.bold.to_json();
    v["italic"] = s.italic.to_json();
    v["indent"] = s.indent.to_json();
}

/// `text.editParagraph`: chữ mới (ngắt mềm do lõi xếp lại), kiểu áp cùng lúc.
pub fn edit_paragraph_params(
    page: usize,
    paragraph_id: &str,
    new_text: &str,
    strategy: FontStrategy,
    font_name: Option<&str>,
    style: &ParagraphStyle,
    box_width: &Keep<f64>,
) -> Value {
    let mut v = json!({"pageIndex": page, "paragraphId": paragraph_id, "newText": new_text,
        "fontStrategy": strategy.as_str(), "keepStyle": true, "boxWidth": box_width.to_json()});
    style_fields(&mut v, style);
    if let Some(f) = font_name.filter(|f| !f.is_empty()) {
        v["fontName"] = f.into();
    }
    v
}

/// `text.styleParagraph`: chỉ kiểu, giữ chữ.
pub fn style_paragraph_params(
    page: usize,
    paragraph_id: &str,
    style: &ParagraphStyle,
    strategy: FontStrategy,
    font_name: Option<&str>,
) -> Value {
    let mut v = json!({"pageIndex": page, "paragraphId": paragraph_id,
        "fontStrategy": strategy.as_str(), "keepStyle": true, "boxWidth": "keep"});
    style_fields(&mut v, style);
    if let Some(f) = font_name.filter(|f| !f.is_empty()) {
        v["fontName"] = f.into();
    }
    v
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParagraphWarnings {
    pub overflow: f64,
    /// Khối chữ mới đè lên; hộp của chúng được tô sáng.
    pub overlap_blocks: Vec<TextBlock>,
    pub messages: Vec<String>,
}

/// Cảnh báo từ kết quả thao tác đoạn: tràn quá khối kế hoặc cuối trang, khối bị đè.
pub fn paragraph_warnings(data: &Value, blocks: &[TextBlock]) -> ParagraphWarnings {
    let ids: Vec<&str> = data
        .get("overlapsBlockIds")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    ParagraphWarnings {
        overflow: data.get("overflow").and_then(Value::as_f64).unwrap_or(0.0),
        overlap_blocks: blocks
            .iter()
            .filter(|b| ids.contains(&b.id.as_str()))
            .cloned()
            .collect(),
        messages: data
            .get("warnings")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|w| w.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// Khung tô sáng của các khối bị đè: (trang, hình chữ nhật).
pub fn overlap_highlights(page: usize, blocks: &[TextBlock]) -> Vec<(usize, [f64; 4])> {
    blocks.iter().map(|b| (page, b.bbox)).collect()
}

/// Ký tự không in được hay vô hình: điều khiển, định dạng, vùng riêng, khoảng trắng đặc biệt, ngắt
/// dòng/đoạn. Xấp xỉ các nhóm Unicode Cc, Cf, Co, Zs, Zl, Zp (không nhận biết điểm mã chưa gán, Cn).
fn is_invisible(c: char) -> bool {
    let u = c as u32;
    c.is_control()
        || c.is_whitespace()
        || matches!(u, 0x00AD | 0x0600..=0x0605 | 0x061C | 0x06DD | 0x070F | 0x180E | 0x200B..=0x200F | 0x202A..=0x202E | 0x2060..=0x2064 | 0x2066..=0x206F | 0xFEFF | 0xFFF9..=0xFFFB)
        || matches!(u, 0xE000..=0xF8FF | 0xF0000..=0xFFFFD | 0x100000..=0x10FFFD)
}

/// Ký tự cho thông báo: ký tự vô hình hiện bằng mã `U+XXXX`; không lặp.
pub fn chars_label(chars: &[char]) -> String {
    let mut seen: Vec<char> = Vec::new();
    for c in chars {
        if !seen.contains(c) {
            seen.push(*c);
        }
    }
    seen.iter()
        .map(|c| {
            if is_invisible(*c) {
                format!("U+{:04X}", *c as u32)
            } else {
                c.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(par: &str, x: f64, y: f64, text: &str) -> TextLine {
        TextLine {
            paragraph_id: Some(par.into()),
            editable: true,
            artifact: false,
            bbox: [x, y, x + 50.0, y + 12.0],
            text: text.into(),
            font_size: 12.0,
            bold: false,
            italic: true,
            colour: Some("#112233".into()),
            ..Default::default()
        }
    }

    fn doc() -> Vec<TextLine> {
        vec![
            line("P0:ab:1", 72.0, 120.0, " dòng hai "),
            line("P0:ab:1", 72.0, 100.0, "dòng một"),
            TextLine {
                editable: false,
                ..line("P0:ab:1", 72.0, 140.0, "khóa")
            },
            TextLine {
                artifact: true,
                ..line("P0:ab:1", 72.0, 10.0, "header")
            },
            line("P0:ab:2", 300.0, 50.0, "đoạn khác"),
        ]
    }

    #[test]
    fn lines_text_and_box() {
        let l = doc();
        assert_eq!(paragraph_text(&l, "P0:ab:1"), "dòng một dòng hai");
        assert_eq!(paragraph_lines(&l, "P0:ab:1").len(), 2);
        assert_eq!(
            paragraph_box(&l, "P0:ab:1"),
            Some([72.0, 100.0, 122.0, 132.0])
        );
        assert_eq!(paragraph_box(&l, "none"), None);
        assert_eq!(paragraph_centre(&l, "P0:ab:2"), Some([325.0, 56.0]));
        assert_eq!(paragraph_text(&l, "none"), "");
    }

    #[test]
    fn format_alignment_needs_two_lines() {
        let l = doc();
        let info = [
            ParagraphInfo {
                id: "P0:ab:1".into(),
                align: "justify".into(),
                indent: 18.0,
            },
            ParagraphInfo {
                id: "P0:ab:2".into(),
                align: "left".into(),
                indent: 0.0,
            },
        ];
        let f = current_format(&l, &info, "P0:ab:1").unwrap();
        assert_eq!(
            (f.align.as_str(), f.indent, f.italic, f.colour.as_deref()),
            ("justify", 18.0, true, Some("#112233"))
        );
        assert_eq!(current_format(&l, &info, "P0:ab:2").unwrap().align, "none");
        assert!(current_format(&l, &info, "P0:ab:9").is_none());
        assert!(current_format(&l, &[], "P0:ab:1").is_none());
    }

    #[test]
    fn ids_and_reselect() {
        assert_eq!(
            (
                page_of_paragraph("P12:ab:3"),
                page_of_paragraph("X1:a:1"),
                page_of_paragraph("P:a:1"),
                page_of_paragraph("P1")
            ),
            (Some(12), None, None, None)
        );
        assert_eq!(
            (
                paragraph_index("P0:ab:7"),
                paragraph_index("P0:ab:x"),
                paragraph_index("nocolon")
            ),
            (Some(7), None, None)
        );
        let l = doc();
        // trang đọc lại, mã đổi digest nhưng cùng vị trí
        let after = vec![
            line("P0:zz:1", 72.0, 100.0, "a"),
            line("P0:zz:2", 300.0, 50.0, "b"),
        ];
        assert_eq!(
            reselect_paragraph(&after, "P0:ab:2", None).as_deref(),
            Some("P0:zz:2")
        );
        // không cùng vị trí: dùng tâm cũ
        let moved = vec![line("P0:q:5", 300.0, 50.0, "b")];
        assert_eq!(
            reselect_paragraph(&moved, "P0:ab:1", Some([320.0, 55.0])).as_deref(),
            Some("P0:q:5")
        );
        assert_eq!(
            reselect_paragraph(&moved, "P0:ab:1", Some([0.0, 0.0])),
            None
        );
        assert_eq!(reselect_paragraph(&moved, "P0:ab:1", None), None);
        assert_eq!(
            reselect_paragraph(&l, "P0:ab:1", None).as_deref(),
            Some("P0:ab:1")
        );
    }

    #[test]
    fn params_keep_unchosen_fields() {
        let style = ParagraphStyle {
            align: Keep::Set("center".into()),
            indent: Keep::Set(18.0),
            bold: Keep::Set(true),
            ..Default::default()
        };
        let v = edit_paragraph_params(
            2,
            "P2:a:0",
            "Chữ mới",
            FontStrategy::Auto,
            Some("Arial"),
            &style,
            &Keep::Keep,
        );
        assert_eq!(
            (
                v["align"].as_str(),
                v["fontSize"].as_str(),
                v["indent"].as_f64(),
                v["bold"].as_bool(),
                v["boxWidth"].as_str(),
                v["fontName"].as_str()
            ),
            (
                Some("center"),
                Some("keep"),
                Some(18.0),
                Some(true),
                Some("keep"),
                Some("Arial")
            )
        );
        assert_eq!(
            (
                v["newText"].as_str(),
                v["keepStyle"].as_bool(),
                v["fontStrategy"].as_str()
            ),
            (Some("Chữ mới"), Some(true), Some("auto"))
        );
        let s = style_paragraph_params(
            0,
            "P0:a:0",
            &ParagraphStyle::default(),
            FontStrategy::Keep,
            None,
        );
        assert_eq!(
            (
                s["align"].as_str(),
                s["lineSpacing"].as_str(),
                s.get("fontName"),
                s.get("newText"),
                s["fontStrategy"].as_str()
            ),
            (Some("keep"), Some("keep"), None, None, Some("keep"))
        );
        let w = edit_paragraph_params(
            0,
            "p",
            "t",
            FontStrategy::Replace,
            Some(""),
            &ParagraphStyle::default(),
            &Keep::Set(200.0),
        );
        assert_eq!(
            (w.get("fontName"), w["boxWidth"].as_f64()),
            (None, Some(200.0))
        );
    }

    #[test]
    fn warnings_and_chars() {
        let blocks = vec![
            TextBlock {
                id: "b1".into(),
                bbox: [1.0, 2.0, 3.0, 4.0],
            },
            TextBlock {
                id: "b2".into(),
                bbox: [5.0, 6.0, 7.0, 8.0],
            },
        ];
        let w = paragraph_warnings(
            &json!({"overflow":12.5,"overlapsBlockIds":["b2","zz"],"warnings":["cảnh báo",1]}),
            &blocks,
        );
        assert_eq!(
            (w.overflow, w.overlap_blocks.len(), w.messages.clone()),
            (12.5, 1, vec!["cảnh báo".to_string()])
        );
        assert_eq!(
            overlap_highlights(3, &w.overlap_blocks),
            vec![(3, [5.0, 6.0, 7.0, 8.0])]
        );
        assert_eq!(paragraph_warnings(&Value::Null, &blocks).overflow, 0.0);
        assert_eq!(
            chars_label(&[
                'a', 'ế', '\u{200B}', '\u{0}', 'a', ' ', '\u{E000}', '\u{00A0}'
            ]),
            "a ế U+200B U+0000 U+0020 U+E000 U+00A0"
        );
        assert_eq!(chars_label(&[]), "");
    }
}
