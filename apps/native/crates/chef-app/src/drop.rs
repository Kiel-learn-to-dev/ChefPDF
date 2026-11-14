//! File path handling shared by argv, file drops, and second-instance requests (R2.17).

use std::fs::File;
use std::path::{Path, PathBuf};

#[derive(Debug, Default)]
pub struct PathBatch {
    pub accepted: Vec<PathBuf>,
    pub rejected: Vec<String>,
}

/// Resolve each path independently. Invalid files are reported without discarding valid neighbors.
pub fn validate_paths(paths: impl IntoIterator<Item = PathBuf>) -> PathBatch {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    validate_paths_from(paths, &cwd)
}

/// Resolve each path before forwarding it to another process with a different current directory.
pub fn absolute_paths(paths: impl IntoIterator<Item = PathBuf>) -> Vec<PathBuf> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    paths
        .into_iter()
        .map(|path| {
            let absolute = if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            };
            absolute.canonicalize().unwrap_or(absolute)
        })
        .collect()
}

pub fn validate_paths_from(paths: impl IntoIterator<Item = PathBuf>, cwd: &Path) -> PathBatch {
    let mut batch = PathBatch::default();
    for path in paths {
        let absolute = if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        };
        let normalized = absolute.canonicalize().unwrap_or(absolute);
        let display = normalized.to_string_lossy().into_owned();
        let error = if !normalized
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
        {
            Some("chỉ hỗ trợ tệp PDF".to_string())
        } else if !normalized.is_file() {
            Some("tệp không tồn tại hoặc không phải tệp thường".to_string())
        } else if File::open(&normalized).is_err() {
            Some("không có quyền đọc tệp".to_string())
        } else {
            None
        };
        if let Some(error) = error {
            batch.rejected.push(format!("{display}: {error}"));
        } else {
            batch.accepted.push(normalized);
        }
    }
    batch
}

/// Parse command-line paths. `--` permits a filename beginning with `-`; unknown switches are
/// ignored because the native app currently has no command switches.
pub fn parse_argv(args: impl IntoIterator<Item = std::ffi::OsString>) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let mut positional_only = false;
    for arg in args {
        if !positional_only && arg == "--" {
            positional_only = true;
            continue;
        }
        if !positional_only && arg.to_string_lossy().starts_with('-') {
            continue;
        }
        paths.push(PathBuf::from(arg));
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::{parse_argv, validate_paths_from};
    use std::ffi::OsString;
    use std::fs;
    use std::path::PathBuf;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "chef-r217-drop-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn argv_keeps_multiple_unicode_paths_and_supports_double_dash() {
        let paths = parse_argv([
            OsString::from("--"),
            OsString::from("-ghi chú.pdf"),
            OsString::from("D:/Tài liệu/biên bản.pdf"),
        ]);
        assert_eq!(paths.len(), 2);
        assert_eq!(paths[0], PathBuf::from("-ghi chú.pdf"));
        assert_eq!(paths[1], PathBuf::from("D:/Tài liệu/biên bản.pdf"));
    }

    #[test]
    fn validation_keeps_readable_pdfs_and_reports_bad_neighbors_individually() {
        let temp = TempDir::new();
        let good = temp.0.join("Hồ sơ.pdf");
        let other = temp.0.join("note.txt");
        fs::write(&good, b"%PDF-1.7\n").unwrap();
        fs::write(&other, b"text").unwrap();
        let batch = validate_paths_from([good.clone(), temp.0.join("missing.pdf"), other], &temp.0);
        assert_eq!(batch.accepted, vec![good.canonicalize().unwrap()]);
        assert_eq!(batch.rejected.len(), 2);
        assert!(
            batch
                .rejected
                .iter()
                .any(|error| error.contains("missing.pdf"))
        );
        assert!(
            batch
                .rejected
                .iter()
                .any(|error| error.contains("note.txt"))
        );
    }
}
