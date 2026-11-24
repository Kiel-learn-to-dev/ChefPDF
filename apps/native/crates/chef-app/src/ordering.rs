//! Thứ tự an toàn (TASKS_RUST R5.65, FEATURES O5, D10): bước làm đổi nội dung (bản scan, đóng dấu...)
//! không được đứng sau bước ký số, và sắp tên file trong lô theo thứ tự tự nhiên (2 trước 10).
//! Cùng quy tắc với `core/chef_core/ops/ordering.py`; lõi vẫn là nơi chặn cuối cùng.
#![allow(dead_code)]

use std::cmp::Ordering;

/// Đặc tính của một bước (lấy từ metadata operation của lõi).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepSpec {
    pub id: String,
    pub destructive: bool,
    /// Bước kết thúc tài liệu (ký số): sau nó không được sửa nội dung.
    pub finalizing: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Violation {
    pub index: usize,
    pub op_id: String,
    pub after_index: usize,
    pub after_op_id: String,
    pub message: String,
}

/// Bước đầu tiên làm đổi nội dung mà đứng sau bước ký; None khi thứ tự an toàn.
pub fn check_op_order(steps: &[StepSpec]) -> Option<Violation> {
    let mut first_final: Option<usize> = None;
    for (index, spec) in steps.iter().enumerate() {
        if let (true, Some(f)) = (spec.destructive, first_final) {
            let after = &steps[f];
            return Some(Violation {
                index,
                op_id: spec.id.clone(),
                after_index: f,
                after_op_id: after.id.clone(),
                message: format!(
                    "Bước {} ({}) làm thay đổi tài liệu nhưng đứng sau bước {} ({}) đã ký số. \
                     Hãy đặt các bước thay đổi trước bước ký.",
                    index + 1,
                    spec.id,
                    f + 1,
                    after.id
                ),
            });
        }
        if spec.finalizing && first_final.is_none() {
            first_final = Some(index);
        }
    }
    None
}

/// Thứ tự mới (chỉ số cũ) đưa mọi bước ký ra sau cùng, giữ nguyên thứ tự tương đối của các bước còn
/// lại. Không bỏ và không nhân bước nào. Trả None nếu không cần đổi.
pub fn safe_permutation(steps: &[StepSpec]) -> Option<Vec<usize>> {
    let mut order: Vec<usize> = (0..steps.len()).filter(|&i| !steps[i].finalizing).collect();
    order.extend((0..steps.len()).filter(|&i| steps[i].finalizing));
    (order.iter().copied().ne(0..steps.len())).then_some(order)
}

/// So sánh tên theo thứ tự tự nhiên: dãy chữ số so như số, phần còn lại không phân biệt hoa thường.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let (mut x, mut y) = (a.chars().peekable(), b.chars().peekable());
    loop {
        match (x.peek().copied(), y.peek().copied()) {
            (None, None) => return a.cmp(b),
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(c), Some(d)) if c.is_ascii_digit() && d.is_ascii_digit() => {
                let take = |it: &mut std::iter::Peekable<std::str::Chars>| {
                    let mut s = String::new();
                    while let Some(&ch) = it.peek() {
                        if !ch.is_ascii_digit() {
                            break;
                        }
                        s.push(ch);
                        it.next();
                    }
                    s
                };
                let (n, m) = (take(&mut x), take(&mut y));
                let (n2, m2) = (n.trim_start_matches('0'), m.trim_start_matches('0'));
                let ord = n2.len().cmp(&m2.len()).then_with(|| n2.cmp(m2));
                if ord != Ordering::Equal {
                    return ord;
                }
            }
            (Some(c), Some(d)) => {
                let ord = c.to_lowercase().cmp(d.to_lowercase());
                if ord != Ordering::Equal {
                    return ord;
                }
                x.next();
                y.next();
            }
        }
    }
}

/// Sắp tên theo thứ tự tự nhiên; ổn định, không đổi số phần tử.
pub fn sort_names_natural(names: &mut [String]) {
    names.sort_by(|a, b| natural_cmp(a, b));
}

/// Sắp theo ngày sửa (mới nhất cuối), cùng ngày thì theo tên tự nhiên. `items`: (tên, giây).
pub fn sort_by_mtime(items: &mut [(String, u64)]) {
    items.sort_by(|a, b| a.1.cmp(&b.1).then_with(|| natural_cmp(&a.0, &b.0)));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(id: &str, destructive: bool, finalizing: bool) -> StepSpec {
        StepSpec {
            id: id.into(),
            destructive,
            finalizing,
        }
    }

    #[test]
    fn destructive_after_sign_is_flagged() {
        let ok = [
            s("scan.rasterize", true, false),
            s("sign.sign", false, true),
        ];
        assert!(check_op_order(&ok).is_none());
        let bad = [
            s("sign.sign", false, true),
            s("scan.rasterize", true, false),
        ];
        let v = check_op_order(&bad).unwrap();
        assert_eq!((v.index, v.after_index), (1, 0));
        assert!(v.message.contains("Bước 2") && v.message.contains("bước 1"));
    }

    #[test]
    fn safe_permutation_moves_signing_last_and_keeps_all_steps() {
        let steps = [
            s("a", true, false),
            s("sign", false, true),
            s("b", true, false),
            s("c", false, false),
        ];
        let p = safe_permutation(&steps).unwrap();
        assert_eq!(p, vec![0, 2, 3, 1]);
        let moved: Vec<StepSpec> = p.iter().map(|&i| steps[i].clone()).collect();
        assert!(check_op_order(&moved).is_none());
        assert!(safe_permutation(&moved).is_none());
    }

    #[test]
    fn natural_order() {
        let mut v: Vec<String> = [
            "file10.pdf",
            "File2.pdf",
            "file1.pdf",
            "file02.pdf",
            "a.pdf",
        ]
        .map(String::from)
        .to_vec();
        sort_names_natural(&mut v);
        assert_eq!(
            v,
            [
                "a.pdf",
                "file1.pdf",
                "File2.pdf",
                "file02.pdf",
                "file10.pdf"
            ]
        );
        assert_eq!(v.len(), 5);
        assert_eq!(natural_cmp("2", "10"), Ordering::Less);
        assert_eq!(natural_cmp("x", "x"), Ordering::Equal);
        let mut t = vec![
            ("b".to_string(), 5),
            ("a".to_string(), 9),
            ("c".to_string(), 5),
        ];
        sort_by_mtime(&mut t);
        assert_eq!(
            t.iter().map(|x| x.0.as_str()).collect::<Vec<_>>(),
            ["b", "c", "a"]
        );
    }
}
