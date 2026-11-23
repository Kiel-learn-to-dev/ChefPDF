//! Tách file: dựng tham số `file.split` (TASKS_RUST R5.04, FEATURES C5). Lõi làm việc tách; đây chỉ
//! kiểm tra đầu vào như validator của lõi rồi dựng struct có kiểu, để giao diện báo lỗi trước khi chạy.
// Trả `Value` thay vì struct sinh: typify gộp nhầm enum `Mode`/`Fit` giữa các operation nên
// `FileSplitParams`, `PageCropParams`, `PageResizeParams` không đọc lại được JSON hợp lệ (xem TASKS_RUST).
#![allow(dead_code)]

use serde_json::{Value, json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SplitMode {
    /// "1-3,5,7-9": mỗi nhóm một file (số trang từ 1).
    Ranges(String),
    EveryN(u64),
    Bookmarks,
    MaxBytes(u64),
    /// Hai file: các trang lẻ và các trang chẵn.
    OddEven,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SplitReject {
    EmptyRanges,
    BadRanges,
    ZeroN,
    ZeroSize,
    NoOutputDir,
    BadTemplate,
}

pub const DEFAULT_TEMPLATE: &str = "{name}_{index}";

/// Mẫu tên chỉ nhận {name} {index} {start} {end}; ký tự lạ trong ngoặc nhọn bị từ chối.
pub fn template_ok(t: &str) -> bool {
    if t.is_empty() {
        return false;
    }
    let mut rest = t;
    while let Some(i) = rest.find('{') {
        let Some(j) = rest[i..].find('}') else {
            return false;
        };
        let var = &rest[i + 1..i + j];
        if !matches!(var, "name" | "index" | "start" | "end") {
            return false;
        }
        rest = &rest[i + j + 1..];
    }
    !rest.contains('}')
}

/// Nhóm trang hợp lệ: các đoạn "a", "a-b" (a ≤ b, a ≥ 1) cách nhau bằng dấu phẩy.
fn ranges_ok(text: &str) -> bool {
    text.split(',').all(|part| {
        let part = part.trim();
        let num = |s: &str| s.trim().parse::<u64>().ok().filter(|&n| n >= 1);
        match part.split_once('-') {
            Some((a, b)) => matches!((num(a), num(b)), (Some(a), Some(b)) if a <= b),
            None => num(part).is_some(),
        }
    })
}

pub fn params(
    mode: &SplitMode,
    output_dir: &str,
    name_template: Option<&str>,
) -> Result<Value, SplitReject> {
    if output_dir.trim().is_empty() {
        return Err(SplitReject::NoOutputDir);
    }
    let template = name_template.unwrap_or(DEFAULT_TEMPLATE);
    if !template_ok(template) {
        return Err(SplitReject::BadTemplate);
    }
    let mut v = json!({ "outputDir": output_dir, "nameTemplate": template });
    let o = v.as_object_mut().expect("object");
    match mode {
        SplitMode::Ranges(text) => {
            if text.trim().is_empty() {
                return Err(SplitReject::EmptyRanges);
            }
            if !ranges_ok(text) {
                return Err(SplitReject::BadRanges);
            }
            o.insert("mode".into(), Value::from("ranges"));
            o.insert("ranges".into(), Value::from(text.trim()));
        }
        SplitMode::EveryN(n) => {
            if *n == 0 {
                return Err(SplitReject::ZeroN);
            }
            o.insert("mode".into(), Value::from("everyN"));
            o.insert("n".into(), Value::from(*n));
        }
        SplitMode::Bookmarks => {
            o.insert("mode".into(), Value::from("bookmarks"));
        }
        SplitMode::MaxBytes(b) => {
            if *b == 0 {
                return Err(SplitReject::ZeroSize);
            }
            o.insert("mode".into(), Value::from("maxSize"));
            o.insert("maxBytes".into(), Value::from(*b));
        }
        SplitMode::OddEven => {
            o.insert("mode".into(), Value::from("oddEven"));
        }
    }
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_build_typed_params() {
        for (mode, name) in [
            (SplitMode::Ranges("1-3, 5,7-9".into()), "ranges"),
            (SplitMode::EveryN(2), "everyN"),
            (SplitMode::Bookmarks, "bookmarks"),
            (SplitMode::MaxBytes(1 << 20), "maxSize"),
            (SplitMode::OddEven, "oddEven"),
        ] {
            let p = params(&mode, "/out", None).unwrap_or_else(|e| panic!("{name}: {e:?}"));
            assert_eq!(p["mode"], name);
        }
    }

    #[test]
    fn rejects_invalid_input() {
        let r = |m: SplitMode| params(&m, "/out", None).unwrap_err();
        assert_eq!(r(SplitMode::Ranges(" ".into())), SplitReject::EmptyRanges);
        assert_eq!(r(SplitMode::Ranges("3-1".into())), SplitReject::BadRanges);
        assert_eq!(r(SplitMode::Ranges("0".into())), SplitReject::BadRanges);
        assert_eq!(r(SplitMode::Ranges("1,,2".into())), SplitReject::BadRanges);
        assert_eq!(r(SplitMode::EveryN(0)), SplitReject::ZeroN);
        assert_eq!(r(SplitMode::MaxBytes(0)), SplitReject::ZeroSize);
        assert_eq!(
            params(&SplitMode::OddEven, "", None).unwrap_err(),
            SplitReject::NoOutputDir
        );
        assert_eq!(
            params(&SplitMode::OddEven, "/o", Some("{foo}")).unwrap_err(),
            SplitReject::BadTemplate
        );
        assert!(params(&SplitMode::OddEven, "/o", Some("{name}_{start}-{end}")).is_ok());
    }
}
