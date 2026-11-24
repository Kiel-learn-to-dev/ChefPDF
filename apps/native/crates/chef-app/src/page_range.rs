//! Khoảng trang của người dùng ("1-3, 5, 7-") và mẫu tên file tách (TASKS_RUST R5.03, R5.04, R5.08).
//! Bản Rust của `apps/ui/src/lib/pageRange.ts` và `features/split/nameTemplate.ts`, giữ cùng quy tắc để
//! hộp thoại Rust và Electron báo lỗi giống nhau.

use std::collections::HashSet;

/// Lỗi khoảng trang. Khóa i18n là `range.<tên>` (`empty`, `syntax`, `outOfRange`, `reversed`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RangeError {
    Empty,
    Syntax(String),
    OutOfRange(String),
    Reversed(String),
}

impl RangeError {
    pub fn i18n_key(&self) -> &'static str {
        match self {
            RangeError::Empty => "range.empty",
            RangeError::Syntax(_) => "range.syntax",
            RangeError::OutOfRange(_) => "range.outOfRange",
            RangeError::Reversed(_) => "range.reversed",
        }
    }
}

/// Một nhóm trang, tính từ 1, gồm cả hai đầu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PageGroup {
    pub start: usize,
    pub end: usize,
}

/// Kết quả phân tích: các nhóm (giữ từng phần giữa hai dấu phẩy) và chỉ số trang tính từ 0, bỏ trùng,
/// theo thứ tự người dùng nhập.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedRanges {
    pub groups: Vec<PageGroup>,
    pub pages: Vec<usize>,
}

/// "1-3, 5, 7-9", "5-" (5 đến hết), "-3" (1 đến 3). Dấu cách quanh dấu gạch và dấu `;` được chấp nhận.
pub fn parse_page_ranges(input: &str, page_count: usize) -> Result<ParsedRanges, RangeError> {
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
        let syntax = || RangeError::Syntax(part.to_string());
        let (start, end) = match part.split_once(['-', '–']) {
            None => {
                let n: usize = parse_number(part).ok_or_else(syntax)?;
                (n, n)
            }
            Some((a, b)) => {
                let (a, b) = (a.trim(), b.trim());
                if a.is_empty() && b.is_empty() {
                    return Err(syntax());
                }
                let start = if a.is_empty() {
                    1
                } else {
                    parse_number(a).ok_or_else(syntax)?
                };
                let end = if b.is_empty() {
                    page_count
                } else {
                    parse_number(b).ok_or_else(syntax)?
                };
                (start, end)
            }
        };
        if start < 1 || end < 1 || start > page_count || end > page_count {
            return Err(RangeError::OutOfRange(part.to_string()));
        }
        if start > end {
            return Err(RangeError::Reversed(part.to_string()));
        }
        groups.push(PageGroup { start, end });
    }
    let mut seen = HashSet::new();
    let mut pages = Vec::new();
    for group in &groups {
        for page in group.start..=group.end {
            if seen.insert(page) {
                pages.push(page - 1);
            }
        }
    }
    Ok(ParsedRanges { groups, pages })
}

/// Chỉ nhận chữ số ASCII; `usize::from_str` chấp nhận cả dấu `+` nên lọc trước.
fn parse_number(text: &str) -> Option<usize> {
    if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// Chỉ số trang tính từ 0 thành chuỗi gọn tính từ 1 ("1-3,5"), đã sắp xếp.
pub fn format_page_ranges(pages: &[usize]) -> String {
    let mut sorted: Vec<usize> = pages.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let mut out = Vec::new();
    let mut i = 0;
    while i < sorted.len() {
        let start = sorted[i];
        let mut end = start;
        while i + 1 < sorted.len() && sorted[i + 1] == end + 1 {
            i += 1;
            end = sorted[i];
        }
        out.push(if start == end {
            format!("{}", start + 1)
        } else {
            format!("{}-{}", start + 1, end + 1)
        });
        i += 1;
    }
    out.join(",")
}

// ---------------------------------------------------------------------------
// Mẫu tên file tách
// ---------------------------------------------------------------------------

pub const DEFAULT_NAME_TEMPLATE: &str = "{name}_{index}";
pub const TEMPLATE_VARIABLES: [&str; 4] = ["name", "index", "start", "end"];

/// Biến trong mẫu mà lõi không biết, theo thứ tự xuất hiện, không lặp.
pub fn unknown_variables(template: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for name in variables(template) {
        if !TEMPLATE_VARIABLES.contains(&name.as_str()) && !out.contains(&name) {
            out.push(name);
        }
    }
    out
}

/// Tên các biến `{tên}` trong mẫu; tên gồm chữ, số, gạch dưới (như `\w+`).
fn variables(template: &str) -> Vec<String> {
    let mut out = Vec::new();
    let chars: Vec<char> = template.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '{' {
            let mut j = i + 1;
            while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            if j > i + 1 && j < chars.len() && chars[j] == '}' {
                out.push(chars[i + 1..j].iter().collect());
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }
    out
}

/// Giá trị điền vào mẫu cho một file đầu ra.
#[derive(Debug, Clone)]
pub struct NameVars<'a> {
    pub name: &'a str,
    /// Thứ tự file, từ 1.
    pub index: usize,
    pub total: usize,
    pub start: usize,
    pub end: usize,
}

/// Tên một file đầu ra có đuôi `.pdf`, theo CONTRACTS §6 và `render_name` của lõi.
pub fn render_name(template: &str, vars: &NameVars<'_>) -> String {
    let digits = vars.total.max(1).to_string().len();
    let template = if template.trim().is_empty() {
        DEFAULT_NAME_TEMPLATE
    } else {
        template.trim()
    };
    let mut base = String::new();
    let chars: Vec<char> = template.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '{' {
            let mut j = i + 1;
            while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            if j > i + 1 && j < chars.len() && chars[j] == '}' {
                let key: String = chars[i + 1..j].iter().collect();
                let value = match key.as_str() {
                    "name" => Some(vars.name.to_string()),
                    "index" => Some(format!("{:0>digits$}", vars.index)),
                    "start" => Some(vars.start.to_string()),
                    "end" => Some(vars.end.to_string()),
                    _ => None,
                };
                match value {
                    Some(value) => base.push_str(&value),
                    None => base.extend(&chars[i..=j]),
                }
                i = j + 1;
                continue;
            }
        }
        base.push(chars[i]);
        i += 1;
    }
    let safe: String = base
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if (c as u32) < 0x20 => '_',
            c => c,
        })
        .collect();
    if safe.to_lowercase().ends_with(".pdf") {
        safe
    } else {
        format!("{safe}.pdf")
    }
}

/// Các nhóm trang mà một cách tách sẽ tạo, để xem trước. `None` khi không biết trước ở phía giao diện
/// (`maxSize`) hoặc đầu vào chưa hợp lệ. `bookmark_starts` là trang đầu (từ 1) của bookmark cấp 1.
pub fn plan_split(
    mode: SplitMode,
    page_count: usize,
    ranges: &str,
    n: usize,
    bookmark_starts: &[usize],
) -> Option<Vec<PageGroup>> {
    if page_count < 1 {
        return None;
    }
    match mode {
        SplitMode::Ranges => parse_page_ranges(ranges, page_count).ok().map(|r| r.groups),
        SplitMode::EveryN => {
            if n < 1 {
                return None;
            }
            let mut groups = Vec::new();
            let mut start = 1;
            while start <= page_count {
                groups.push(PageGroup {
                    start,
                    end: page_count.min(start + n - 1),
                });
                start += n;
            }
            Some(groups)
        }
        SplitMode::OddEven => {
            let mut groups = vec![PageGroup {
                start: 1,
                end: if page_count % 2 == 1 {
                    page_count
                } else {
                    page_count - 1
                },
            }];
            if page_count > 1 {
                groups.push(PageGroup {
                    start: 2,
                    end: if page_count.is_multiple_of(2) {
                        page_count
                    } else {
                        page_count - 1
                    },
                });
            }
            // Một trang duy nhất: chỉ có nhóm lẻ, không có nhóm chẵn.
            Some(groups)
        }
        SplitMode::Bookmarks => {
            let mut starts: Vec<usize> = bookmark_starts
                .iter()
                .copied()
                .filter(|p| *p >= 1 && *p <= page_count)
                .collect();
            starts.sort_unstable();
            starts.dedup();
            if starts.is_empty() {
                return None;
            }
            if starts[0] != 1 {
                starts.insert(0, 1);
            }
            Some(
                starts
                    .iter()
                    .enumerate()
                    .map(|(i, s)| PageGroup {
                        start: *s,
                        end: starts.get(i + 1).copied().unwrap_or(page_count + 1) - 1,
                    })
                    .collect(),
            )
        }
        SplitMode::MaxSize => None,
    }
}

/// Năm cách tách của `file.split`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitMode {
    Ranges,
    EveryN,
    Bookmarks,
    MaxSize,
    OddEven,
}

impl SplitMode {
    pub const ALL: [SplitMode; 5] = [
        SplitMode::Ranges,
        SplitMode::EveryN,
        SplitMode::Bookmarks,
        SplitMode::MaxSize,
        SplitMode::OddEven,
    ];

    /// Giá trị `mode` gửi cho lõi.
    pub fn wire(self) -> &'static str {
        match self {
            SplitMode::Ranges => "ranges",
            SplitMode::EveryN => "everyN",
            SplitMode::Bookmarks => "bookmarks",
            SplitMode::MaxSize => "maxSize",
            SplitMode::OddEven => "oddEven",
        }
    }
}

/// Tên file xem trước cho `limit` nhóm đầu.
pub fn preview_names(
    template: &str,
    source_name: &str,
    groups: &[PageGroup],
    limit: usize,
) -> Vec<String> {
    groups
        .iter()
        .take(limit)
        .enumerate()
        .map(|(i, g)| {
            render_name(
                template,
                &NameVars {
                    name: source_name,
                    index: i + 1,
                    total: groups.len(),
                    start: g.start,
                    end: g.end,
                },
            )
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_groups_and_zero_based_pages_in_typed_order() {
        let r = parse_page_ranges("3, 1-2, 2", 10).unwrap();
        assert_eq!(
            r.groups,
            vec![
                PageGroup { start: 3, end: 3 },
                PageGroup { start: 1, end: 2 },
                PageGroup { start: 2, end: 2 }
            ]
        );
        // Trang 2 xuất hiện hai lần nhưng chỉ lấy một lần.
        assert_eq!(r.pages, vec![2, 0, 1]);
    }

    #[test]
    fn open_ended_and_dash_variants() {
        assert_eq!(
            parse_page_ranges("8-", 10).unwrap().groups,
            vec![PageGroup { start: 8, end: 10 }]
        );
        assert_eq!(
            parse_page_ranges("-3", 10).unwrap().groups,
            vec![PageGroup { start: 1, end: 3 }]
        );
        assert_eq!(
            parse_page_ranges("2 – 4;6", 10).unwrap().pages,
            vec![1, 2, 3, 5]
        );
    }

    #[test]
    fn reports_each_error_kind() {
        assert_eq!(parse_page_ranges("  ,", 5), Err(RangeError::Empty));
        assert_eq!(
            parse_page_ranges("a-3", 5),
            Err(RangeError::Syntax("a-3".into()))
        );
        assert_eq!(
            parse_page_ranges("-", 5),
            Err(RangeError::Syntax("-".into()))
        );
        assert_eq!(
            parse_page_ranges("+2", 5),
            Err(RangeError::Syntax("+2".into()))
        );
        assert_eq!(
            parse_page_ranges("1-6", 5),
            Err(RangeError::OutOfRange("1-6".into()))
        );
        assert_eq!(
            parse_page_ranges("0", 5),
            Err(RangeError::OutOfRange("0".into()))
        );
        assert_eq!(
            parse_page_ranges("4-2", 5),
            Err(RangeError::Reversed("4-2".into()))
        );
        assert_eq!(
            RangeError::Reversed("x".into()).i18n_key(),
            "range.reversed"
        );
    }

    #[test]
    fn formats_compact_ranges() {
        assert_eq!(format_page_ranges(&[4, 0, 1, 2, 2]), "1-3,5");
        assert_eq!(format_page_ranges(&[]), "");
    }

    #[test]
    fn renders_names_like_the_core() {
        let vars = NameVars {
            name: "bao-cao",
            index: 3,
            total: 12,
            start: 5,
            end: 9,
        };
        assert_eq!(render_name("{name}_{index}", &vars), "bao-cao_03.pdf");
        assert_eq!(
            render_name("{name}_{start}-{end}", &vars),
            "bao-cao_5-9.pdf"
        );
        assert_eq!(render_name("  ", &vars), "bao-cao_03.pdf");
        assert_eq!(render_name("a/b:{index}.PDF", &vars), "a_b_03.PDF");
        // Biến lạ được giữ nguyên trong tên; hộp thoại báo lỗi riêng.
        assert_eq!(render_name("{name}-{foo}", &vars), "bao-cao-{foo}.pdf");
        assert_eq!(unknown_variables("{name}{foo}{foo}{bar}"), ["foo", "bar"]);
        assert!(unknown_variables(DEFAULT_NAME_TEMPLATE).is_empty());
    }

    #[test]
    fn plans_every_split_mode_for_the_preview() {
        let ranges = plan_split(SplitMode::Ranges, 10, "1-3, 4-10", 0, &[]).unwrap();
        assert_eq!(ranges.len(), 2);
        assert!(plan_split(SplitMode::Ranges, 10, "1-30", 0, &[]).is_none());

        let every = plan_split(SplitMode::EveryN, 7, "", 3, &[]).unwrap();
        assert_eq!(
            every,
            vec![
                PageGroup { start: 1, end: 3 },
                PageGroup { start: 4, end: 6 },
                PageGroup { start: 7, end: 7 }
            ]
        );
        assert!(plan_split(SplitMode::EveryN, 7, "", 0, &[]).is_none());

        let odd_even = plan_split(SplitMode::OddEven, 5, "", 0, &[]).unwrap();
        assert_eq!(odd_even.len(), 2);
        assert_eq!(odd_even[0].end, 5);
        assert_eq!(odd_even[1].end, 4);
        assert_eq!(
            plan_split(SplitMode::OddEven, 1, "", 0, &[]).unwrap().len(),
            1
        );

        let marks = plan_split(SplitMode::Bookmarks, 10, "", 0, &[4, 8, 4, 99]).unwrap();
        assert_eq!(
            marks,
            vec![
                PageGroup { start: 1, end: 3 },
                PageGroup { start: 4, end: 7 },
                PageGroup { start: 8, end: 10 }
            ]
        );
        assert!(plan_split(SplitMode::Bookmarks, 10, "", 0, &[]).is_none());
        assert!(plan_split(SplitMode::MaxSize, 10, "", 0, &[]).is_none());
        assert_eq!(
            preview_names("{name}_{index}", "a", &every, 2),
            ["a_1.pdf", "a_2.pdf"]
        );
    }
}
