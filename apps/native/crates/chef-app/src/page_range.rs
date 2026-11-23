//! Khoảng trang người dùng gõ ("1-3, 5, 7-9", từ 1) ↔ chỉ số từ 0 (TASKS_RUST R5.xx dùng chung):
//! port `apps/ui/src/lib/pageRange.ts`. Nhận "-3" (từ đầu đến 3), "5-" (từ 5 đến cuối), dấu `,` hoặc
//! `;` phân cách, gạch ngang `-` hoặc `–`. Không nhận từ khóa "cuối".
#![allow(dead_code)]

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RangeError {
    Empty,
    Syntax,
    OutOfRange,
    Reversed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Group {
    /// Từ 1, gồm cả hai đầu.
    pub start: usize,
    pub end: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    pub groups: Vec<Group>,
    /// Chỉ số từ 0, không trùng, theo thứ tự đã viết ("3,1" cho [2, 0]).
    pub pages: Vec<usize>,
}

fn digits(s: &str) -> Option<Option<usize>> {
    if s.is_empty() {
        return Some(None);
    }
    if s.bytes().all(|b| b.is_ascii_digit()) {
        s.parse().ok().map(Some)
    } else {
        None
    }
}

pub fn parse(input: &str, page_count: usize) -> Result<Parsed, RangeError> {
    let parts: Vec<&str> = input
        .split([',', ';'])
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        return Err(RangeError::Empty);
    }
    let mut groups = Vec::new();
    for part in parts {
        let (start, end) = match part.split_once(['-', '–']) {
            Some((a, b)) => {
                let (a, b) = (
                    digits(a.trim()).ok_or(RangeError::Syntax)?,
                    digits(b.trim()).ok_or(RangeError::Syntax)?,
                );
                if a.is_none() && b.is_none() {
                    return Err(RangeError::Syntax);
                }
                (a.unwrap_or(1), b.unwrap_or(page_count))
            }
            None => {
                let n = digits(part).flatten().ok_or(RangeError::Syntax)?;
                (n, n)
            }
        };
        if start < 1 || end < 1 || start > page_count || end > page_count {
            return Err(RangeError::OutOfRange);
        }
        if start > end {
            return Err(RangeError::Reversed);
        }
        groups.push(Group { start, end });
    }
    let mut seen = std::collections::HashSet::new();
    let pages = groups
        .iter()
        .flat_map(|g| g.start..=g.end)
        .filter(|p| seen.insert(*p))
        .map(|p| p - 1)
        .collect();
    Ok(Parsed { groups, pages })
}

/// Chỉ số từ 0 thành chuỗi khoảng rút gọn từ 1 ("1-3,5"), đã sắp.
pub fn format(pages: &[usize]) -> String {
    crate::page_ops::format_page_ranges(pages)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_like_the_electron_helper() {
        assert_eq!(parse("1-3, 5", 9).unwrap().pages, [0, 1, 2, 4]);
        assert_eq!(parse("3,1", 9).unwrap().pages, [2, 0], "giữ thứ tự đã viết");
        assert_eq!(parse("-3", 9).unwrap().pages, [0, 1, 2]);
        assert_eq!(parse("7-", 9).unwrap().pages, [6, 7, 8]);
        assert_eq!(
            parse("1–2;4", 9).unwrap().pages,
            [0, 1, 3],
            "gạch en và dấu chấm phẩy"
        );
        assert_eq!(parse("1,,2", 9).unwrap().pages, [0, 1], "phần rỗng bị bỏ");
        assert_eq!(
            parse("2-4, 3-5", 9).unwrap().pages,
            [1, 2, 3, 4],
            "không trùng"
        );
        assert_eq!(parse("1-2, 2", 9).unwrap().groups.len(), 2);
    }

    #[test]
    fn reports_the_kind_of_error() {
        assert_eq!(parse("", 9).unwrap_err(), RangeError::Empty);
        assert_eq!(parse(" , ", 9).unwrap_err(), RangeError::Empty);
        assert_eq!(parse("a", 9).unwrap_err(), RangeError::Syntax);
        assert_eq!(parse("-", 9).unwrap_err(), RangeError::Syntax);
        assert_eq!(parse("1-a", 9).unwrap_err(), RangeError::Syntax);
        assert_eq!(parse("0", 9).unwrap_err(), RangeError::OutOfRange);
        assert_eq!(parse("10", 9).unwrap_err(), RangeError::OutOfRange);
        assert_eq!(parse("1-10", 9).unwrap_err(), RangeError::OutOfRange);
        assert_eq!(parse("5-2", 9).unwrap_err(), RangeError::Reversed);
        assert_eq!(parse("1", 0).unwrap_err(), RangeError::OutOfRange);
    }
}
