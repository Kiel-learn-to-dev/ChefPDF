//! Kiểm tra bản mới thủ công (TASKS_RUST R9.08, D36): so sánh số phiên bản và chọn bản mới nhất trong
//! danh sách release. Không tự cập nhật; app chỉ báo và mở link tải khi người dùng bấm. Logic thuần.
#![allow(dead_code)]

use std::cmp::Ordering;

/// "v1.4.0-beta.1" thành (1, 4, 0, có hậu tố tiền phát hành). None khi không đọc được.
pub fn parse_version(s: &str) -> Option<(u64, u64, u64, bool)> {
    let s = s.trim().trim_start_matches(['v', 'V']);
    let (core, pre) = match s.split_once(['-', '+']) {
        Some((c, _)) if s.contains('-') && s.find('-') < s.find('+').or(Some(usize::MAX)) => {
            (c, true)
        }
        Some((c, _)) => (c, false),
        None => (s, false),
    };
    let mut parts = core.split('.');
    let n = |p: Option<&str>| -> Option<u64> { p.map_or(Some(0), |x| x.parse().ok()) };
    let major = parts.next()?.parse().ok()?;
    let minor = n(parts.next())?;
    let patch = n(parts.next())?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch, pre))
}

/// So sánh hai phiên bản: bản tiền phát hành nhỏ hơn bản chính thức cùng số. None nếu không đọc được.
pub fn compare(a: &str, b: &str) -> Option<Ordering> {
    let (x, y) = (parse_version(a)?, parse_version(b)?);
    Some((x.0, x.1, x.2, !x.3).cmp(&(y.0, y.1, y.2, !y.3)))
}

/// `latest` có mới hơn `current` không (không đọc được thì coi là không).
pub fn is_newer(current: &str, latest: &str) -> bool {
    compare(latest, current) == Some(Ordering::Greater)
}

/// Bản mới nhất trong danh sách tên phiên bản, bỏ bản tiền phát hành khi `stable_only`.
pub fn latest<'a>(versions: &[&'a str], stable_only: bool) -> Option<&'a str> {
    versions
        .iter()
        .copied()
        .filter(|v| parse_version(v).is_some_and(|p| !(stable_only && p.3)))
        .max_by(|a, b| compare(a, b).unwrap_or(Ordering::Equal))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_shapes() {
        assert_eq!(parse_version("1.4.0"), Some((1, 4, 0, false)));
        assert_eq!(parse_version("v1.4"), Some((1, 4, 0, false)));
        assert_eq!(parse_version(" 2 "), Some((2, 0, 0, false)));
        assert_eq!(parse_version("1.4.0-beta.1"), Some((1, 4, 0, true)));
        assert_eq!(parse_version("1.4.0+build5"), Some((1, 4, 0, false)));
        for bad in ["", "a.b", "1.x", "1.2.3.4", "v"] {
            assert_eq!(parse_version(bad), None, "{bad}");
        }
    }

    #[test]
    fn ordering_and_latest() {
        assert!(is_newer("1.3.0", "1.4.0") && is_newer("1.9.9", "1.10.0"));
        assert!(!is_newer("1.4.0", "1.4.0") && !is_newer("1.4.0", "1.3.9"));
        assert!(
            is_newer("1.4.0-beta.1", "1.4.0"),
            "bản chính thức mới hơn bản thử"
        );
        assert!(!is_newer("1.4.0", "1.4.0-beta.1"));
        assert!(!is_newer("x", "1.0.0") && !is_newer("1.0.0", "y"));
        let all = ["v1.3.0", "v1.4.0-beta.1", "v1.2.9", "junk", "v1.4.0-beta.2"];
        assert_eq!(latest(&all, true), Some("v1.3.0"));
        assert_eq!(latest(&all, false), Some("v1.4.0-beta.2"));
        assert_eq!(latest(&["junk"], true), None);
    }
}
