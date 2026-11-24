//! Đổi tên file hàng loạt có nhật ký hoàn tác (TASKS_RUST R5.66, FEATURES O6). Dùng `naming.rs` để
//! lập kế hoạch xem trước; `apply` đổi tên hai pha (đổi chỗ được) và không ghi đè file có sẵn;
//! `undo` đảo lại các dòng đã thành công.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RowStatus {
    Done,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub from: PathBuf,
    pub to: PathBuf,
    pub status: RowStatus,
    pub message: Option<String>,
}

fn temp_name(src: &Path, n: usize) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    src.with_file_name(format!(".{stamp:x}-{n}.renaming"))
}

/// Đổi tên từng cặp (nguồn → đích) hai pha. Đích đã tồn tại thì từ chối và file giữ tên cũ.
pub fn apply(pairs: &[(PathBuf, PathBuf)]) -> Vec<Row> {
    let mut rows: Vec<Row> = pairs
        .iter()
        .map(|(f, t)| Row {
            from: f.clone(),
            to: t.clone(),
            status: RowStatus::Failed,
            message: None,
        })
        .collect();
    let mut staged: Vec<(usize, PathBuf)> = Vec::new();
    for (i, (src, dst)) in pairs.iter().enumerate() {
        if src == dst {
            rows[i].status = RowStatus::Done;
            continue;
        }
        let tmp = temp_name(src, i);
        match std::fs::rename(src, &tmp) {
            Ok(()) => staged.push((i, tmp)),
            Err(e) => rows[i].message = Some(format!("Không đổi được tên: {e}")),
        }
    }
    for (i, tmp) in staged {
        let (src, dst) = &pairs[i];
        if dst.exists() {
            rows[i].message = Some("Tệp đích đã tồn tại".into());
            let _ = std::fs::rename(&tmp, src);
            continue;
        }
        match std::fs::rename(&tmp, dst) {
            Ok(()) => rows[i].status = RowStatus::Done,
            Err(e) => {
                rows[i].message = Some(format!("Không đổi được tên: {e}"));
                let _ = std::fs::rename(&tmp, src);
            }
        }
    }
    rows
}

/// Hoàn tác từ nhật ký: đảo các dòng `Done` có đổi tên thật, theo thứ tự ngược.
pub fn undo(log: &[Row]) -> Vec<Row> {
    let pairs: Vec<(PathBuf, PathBuf)> = log
        .iter()
        .rev()
        .filter(|r| r.status == RowStatus::Done && r.from != r.to)
        .map(|r| (r.to.clone(), r.from.clone()))
        .collect();
    apply(&pairs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("chef-rename-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(p: &Path, s: &str) {
        std::fs::write(p, s).unwrap();
    }

    #[test]
    fn swap_works_and_undo_restores() {
        let d = dir("swap");
        let (a, b) = (d.join("a.pdf"), d.join("b.pdf"));
        write(&a, "A");
        write(&b, "B");
        let rows = apply(&[(a.clone(), b.clone()), (b.clone(), a.clone())]);
        assert!(rows.iter().all(|r| r.status == RowStatus::Done), "{rows:?}");
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "B");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "A");
        let back = undo(&rows);
        assert!(back.iter().all(|r| r.status == RowStatus::Done));
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "A");
        assert_eq!(std::fs::read_to_string(&b).unwrap(), "B");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn never_overwrites_an_existing_file() {
        let d = dir("keep");
        let (a, keep, c) = (d.join("a.pdf"), d.join("keep.pdf"), d.join("c.pdf"));
        write(&a, "A");
        write(&keep, "KEEP");
        let rows = apply(&[(a.clone(), keep.clone()), (a.clone(), c.clone())]);
        assert_eq!(rows[0].status, RowStatus::Failed);
        assert_eq!(rows[0].message.as_deref(), Some("Tệp đích đã tồn tại"));
        assert_eq!(std::fs::read_to_string(&keep).unwrap(), "KEEP");
        assert!(a.exists() || c.exists(), "không mất file");
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn missing_source_fails_cleanly() {
        let d = dir("miss");
        let rows = apply(&[(d.join("nope.pdf"), d.join("x.pdf"))]);
        assert_eq!(rows[0].status, RowStatus::Failed);
        assert!(rows[0].message.is_some());
        let _ = std::fs::remove_dir_all(&d);
    }
}
