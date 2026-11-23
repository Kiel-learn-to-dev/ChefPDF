//! Biến mẫu cho header, footer, số trang và Bates (TASKS_RUST R5.34–R5.36; FEATURES F7–F9): port
//! `overlay/variables.ts`. CHỈ để xem trước; lõi (`core/chef_core/overlay/variables.py`) mới ghi
//! thật, nên cùng đầu vào phải ra cùng chữ. Logic thuần.
#![allow(dead_code)]

use crate::sign_template_model::{DateParts, format_date_pattern};

pub const VARIABLE_NAMES: [&str; 11] = [
    "page",
    "pages",
    "page_roman",
    "page_alpha",
    "date",
    "time",
    "filename",
    "title",
    "author",
    "bates",
    "section",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NumberFormat {
    Arabic,
    /// i, ii, iii...
    RomanLower,
    /// I, II, III...
    RomanUpper,
    AlphaLower,
    AlphaUpper,
}

impl NumberFormat {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "arabic" => Self::Arabic,
            "roman" => Self::RomanLower,
            "ROMAN" => Self::RomanUpper,
            "alpha" => Self::AlphaLower,
            "ALPHA" => Self::AlphaUpper,
            _ => return None,
        })
    }
}

const ROMAN: [(i64, &str); 13] = [
    (1000, "M"),
    (900, "CM"),
    (500, "D"),
    (400, "CD"),
    (100, "C"),
    (90, "XC"),
    (50, "L"),
    (40, "XL"),
    (10, "X"),
    (9, "IX"),
    (5, "V"),
    (4, "IV"),
    (1, "I"),
];

/// Số La Mã viết hoa, 1..=3999; None ngoài khoảng đó.
pub fn to_roman(n: i64) -> Option<String> {
    if !(1..=3999).contains(&n) {
        return None;
    }
    let mut rest = n;
    let mut out = String::new();
    for (value, letters) in ROMAN {
        out.push_str(&letters.repeat((rest / value) as usize));
        rest %= value;
    }
    Some(out)
}

/// Chữ cái hệ 26 song ánh, viết hoa (1 = A, 27 = AA); None khi n < 1.
pub fn to_alpha(n: i64) -> Option<String> {
    if n < 1 {
        return None;
    }
    let (mut rest, mut out) = (n, Vec::new());
    while rest > 0 {
        out.push(b'A' + ((rest - 1) % 26) as u8);
        rest = (rest - 1) / 26;
    }
    out.reverse();
    String::from_utf8(out).ok()
}

/// Số theo định dạng; None khi không biểu diễn được (La Mã > 3999, chữ cái < 1).
pub fn format_number(n: i64, fmt: NumberFormat) -> Option<String> {
    match fmt {
        NumberFormat::Arabic => Some(n.to_string()),
        NumberFormat::RomanLower => to_roman(n).map(|s| s.to_lowercase()),
        NumberFormat::RomanUpper => to_roman(n),
        NumberFormat::AlphaLower => to_alpha(n).map(|s| s.to_lowercase()),
        NumberFormat::AlphaUpper => to_alpha(n),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TemplatePart {
    Text(String),
    Variable(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TemplateIssue {
    Unclosed,
    Stray,
    Unknown,
}

/// Tách mẫu; `{{` và `}}` là dấu ngoặc nguyên văn. Lỗi nói rõ vấn đề (và tên biến lạ).
pub fn parse_template(t: &str) -> Result<Vec<TemplatePart>, (TemplateIssue, Option<String>)> {
    let mut parts = Vec::new();
    let mut buf = String::new();
    let mut rest = t;
    while let Some(ch) = rest.chars().next() {
        if ch == '{' {
            if let Some(r) = rest.strip_prefix("{{") {
                buf.push('{');
                rest = r;
                continue;
            }
            let Some(end) = rest.find('}') else {
                return Err((TemplateIssue::Unclosed, None));
            };
            let name = &rest[1..end];
            if !VARIABLE_NAMES.contains(&name) {
                return Err((TemplateIssue::Unknown, Some(name.to_string())));
            }
            if !buf.is_empty() {
                parts.push(TemplatePart::Text(std::mem::take(&mut buf)));
            }
            parts.push(TemplatePart::Variable(name.to_string()));
            rest = &rest[end + 1..];
        } else if ch == '}' {
            if let Some(r) = rest.strip_prefix("}}") {
                buf.push('}');
                rest = r;
                continue;
            }
            return Err((TemplateIssue::Stray, None));
        } else {
            buf.push(ch);
            rest = &rest[ch.len_utf8()..];
        }
    }
    if !buf.is_empty() {
        parts.push(TemplatePart::Text(buf));
    }
    Ok(parts)
}

/// Giá trị tài liệu xem trước (cùng trường với `DocVars` của lõi).
#[derive(Debug, Clone, PartialEq)]
pub struct PreviewDoc {
    pub filename: String,
    pub title: String,
    pub author: String,
    pub page_count: usize,
    pub start_number: i64,
    pub date_format: String,
    pub now: DateParts,
    /// (trang bắt đầu từ 0, tên mục)
    pub sections: Vec<(usize, String)>,
    pub bates_prefix: String,
    pub bates_suffix: String,
    pub bates_digits: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RenderError {
    /// Số ngoài khoảng biểu diễn được của định dạng.
    Range(String),
    Template(TemplateIssue, Option<String>),
}

/// Chữ của `template` cho trang `index` (từ 0).
pub fn render_template(
    template: &str,
    index: usize,
    doc: &PreviewDoc,
    fmt: NumberFormat,
) -> Result<String, RenderError> {
    let parts = parse_template(template).map_err(|(i, v)| RenderError::Template(i, v))?;
    let page = index as i64 + doc.start_number;
    let last = doc.page_count as i64 - 1 + doc.start_number;
    let mut sections = doc.sections.clone();
    sections.sort_by_key(|s| s.0);
    let section = sections
        .iter()
        .rfind(|(start, _)| *start <= index)
        .map(|s| s.1.clone())
        .unwrap_or_default();
    let mut out = String::new();
    for part in parts {
        match part {
            TemplatePart::Text(t) => out.push_str(&t),
            TemplatePart::Variable(name) => {
                let v = match name.as_str() {
                    "page" => format_number(page, fmt),
                    "pages" => format_number(last, fmt),
                    "page_roman" => format_number(page, NumberFormat::RomanUpper),
                    "page_alpha" => format_number(page, NumberFormat::AlphaUpper),
                    "date" => Some(format_date_pattern(&doc.now, &doc.date_format, false)),
                    "time" => Some(format!("{:02}:{:02}", doc.now.hour, doc.now.minute)),
                    "filename" => Some(doc.filename.clone()),
                    "title" => Some(doc.title.clone()),
                    "author" => Some(doc.author.clone()),
                    "bates" => Some(format!(
                        "{}{:0w$}{}",
                        doc.bates_prefix,
                        page,
                        doc.bates_suffix,
                        w = doc.bates_digits
                    )),
                    "section" => Some(section.clone()),
                    _ => None,
                };
                out.push_str(&v.ok_or(RenderError::Range(name))?);
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> PreviewDoc {
        PreviewDoc {
            filename: "hop-dong.pdf".into(),
            title: "Hợp đồng".into(),
            author: "An".into(),
            page_count: 12,
            start_number: 1,
            date_format: "dd/MM/yyyy".into(),
            now: DateParts {
                year: 2026,
                month: 11,
                day: 23,
                hour: 9,
                minute: 5,
                second: 0,
                offset_min: 420,
            },
            sections: vec![(5, "Phụ lục".into()), (0, "Chính".into())],
            bates_prefix: "HS-".into(),
            bates_suffix: String::new(),
            bates_digits: 6,
        }
    }

    #[test]
    fn numbers() {
        assert_eq!(
            (
                to_roman(1994),
                to_roman(4).as_deref(),
                to_roman(0),
                to_roman(4000)
            ),
            (Some("MCMXCIV".into()), Some("IV"), None, None)
        );
        assert_eq!(
            (
                to_alpha(1).as_deref(),
                to_alpha(26).as_deref(),
                to_alpha(27).as_deref(),
                to_alpha(703).as_deref(),
                to_alpha(0)
            ),
            (Some("A"), Some("Z"), Some("AA"), Some("AAA"), None)
        );
        assert_eq!(
            format_number(9, NumberFormat::RomanLower).as_deref(),
            Some("ix")
        );
        assert_eq!(
            format_number(28, NumberFormat::AlphaLower).as_deref(),
            Some("ab")
        );
        assert_eq!(
            format_number(-3, NumberFormat::Arabic).as_deref(),
            Some("-3")
        );
        assert_eq!(format_number(5000, NumberFormat::RomanUpper), None);
        assert_eq!(NumberFormat::parse("ROMAN"), Some(NumberFormat::RomanUpper));
        assert_eq!(NumberFormat::parse("x"), None);
    }

    #[test]
    fn parse_templates() {
        assert_eq!(parse_template("Trang {page}/{pages}").unwrap().len(), 4);
        assert_eq!(
            parse_template("{{literal}} {page}").unwrap(),
            [
                TemplatePart::Text("{literal} ".into()),
                TemplatePart::Variable("page".into())
            ]
        );
        assert_eq!(
            parse_template("abc").unwrap(),
            [TemplatePart::Text("abc".into())]
        );
        assert!(parse_template("").unwrap().is_empty());
        assert_eq!(
            parse_template("{page").unwrap_err(),
            (TemplateIssue::Unclosed, None)
        );
        assert_eq!(
            parse_template("a}b").unwrap_err(),
            (TemplateIssue::Stray, None)
        );
        assert_eq!(
            parse_template("{nope}").unwrap_err(),
            (TemplateIssue::Unknown, Some("nope".into()))
        );
        assert_eq!(
            parse_template("{ page }").unwrap_err().0,
            TemplateIssue::Unknown
        );
    }

    #[test]
    fn renders_like_the_core() {
        let d = doc();
        assert_eq!(
            render_template(
                "Trang {page}/{pages} - {filename}",
                2,
                &d,
                NumberFormat::Arabic
            )
            .unwrap(),
            "Trang 3/12 - hop-dong.pdf"
        );
        assert_eq!(
            render_template(
                "{page_roman} {page_alpha} {bates}",
                3,
                &d,
                NumberFormat::Arabic
            )
            .unwrap(),
            "IV D HS-000004"
        );
        assert_eq!(
            render_template(
                "{date} {time} {title} {author}",
                0,
                &d,
                NumberFormat::Arabic
            )
            .unwrap(),
            "23/11/2026 09:05 Hợp đồng An"
        );
        assert_eq!(
            render_template("{section}", 4, &d, NumberFormat::Arabic).unwrap(),
            "Chính"
        );
        assert_eq!(
            render_template("{section}", 5, &d, NumberFormat::Arabic).unwrap(),
            "Phụ lục"
        );
        assert_eq!(
            render_template(
                "{page}",
                0,
                &PreviewDoc {
                    start_number: 10,
                    ..doc()
                },
                NumberFormat::RomanLower
            )
            .unwrap(),
            "x"
        );
        assert_eq!(
            render_template(
                "{section}",
                0,
                &PreviewDoc {
                    sections: vec![],
                    ..doc()
                },
                NumberFormat::Arabic
            )
            .unwrap(),
            ""
        );
    }

    #[test]
    fn render_errors() {
        let d = doc();
        assert_eq!(
            render_template(
                "{page}",
                0,
                &PreviewDoc {
                    start_number: 0,
                    ..doc()
                },
                NumberFormat::AlphaUpper
            ),
            Err(RenderError::Range("page".into()))
        );
        assert_eq!(
            render_template("{page_roman}", 4000, &d, NumberFormat::Arabic),
            Err(RenderError::Range("page_roman".into()))
        );
        assert_eq!(
            render_template("{x}", 0, &d, NumberFormat::Arabic),
            Err(RenderError::Template(
                TemplateIssue::Unknown,
                Some("x".into())
            ))
        );
    }
}
