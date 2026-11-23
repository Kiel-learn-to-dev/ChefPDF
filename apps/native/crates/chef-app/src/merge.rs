//! Ghép file: danh sách PDF có thứ tự và tham số `file.merge` (TASKS_RUST R5.03, FEATURES C4).
//!
//! Phần thuần (không GPUI): thêm, bỏ, đổi chỗ file; dựng `FileMergeParams`; đặt tên file ra; chặn
//! ghi đè file nguồn. Hộp thoại (TaskDialog + danh sách kéo sắp thứ tự) gọi các hàm này.

use std::path::{Path, PathBuf};

use chef_contracts::ops_types::{FileMergeParams, MergeInput, Outputpath};

/// Một file trong danh sách ghép.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub path: PathBuf,
    /// Mật khẩu nếu file có mã hóa (hỏi khi lõi trả lỗi cần mật khẩu).
    pub password: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MergeReject {
    /// Cần ít nhất hai file để ghép.
    TooFew,
    /// Đường dẫn ra rỗng hoặc không hợp lệ.
    BadOutput,
    /// File ra trùng một file nguồn (sẽ ghi đè nguồn).
    OutputIsSource,
}

/// Danh sách file ghép, theo thứ tự người dùng sắp.
#[derive(Debug, Clone, Default)]
pub struct MergeList {
    entries: Vec<Entry>,
}

impl MergeList {
    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[allow(dead_code)] // clippy::len_without_is_empty đòi có
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Thêm file vào cuối. Cùng file thêm hai lần là hợp lệ (ghép một file với chính nó).
    pub fn add(&mut self, paths: impl IntoIterator<Item = PathBuf>) {
        self.entries.extend(paths.into_iter().map(|path| Entry {
            path,
            password: None,
        }));
    }

    pub fn remove(&mut self, index: usize) -> bool {
        if index < self.entries.len() {
            self.entries.remove(index);
            true
        } else {
            false
        }
    }

    #[allow(dead_code)] // chưa có ô nhập mật khẩu từng file trong hộp thoại
    pub fn set_password(&mut self, index: usize, password: Option<String>) {
        if let Some(entry) = self.entries.get_mut(index) {
            entry.password = password;
        }
    }

    /// Chuyển mục `from` đến vị trí `to` (chỉ số sau khi chuyển). Trả false nếu ngoài phạm vi.
    pub fn move_to(&mut self, from: usize, to: usize) -> bool {
        let n = self.entries.len();
        if from >= n || to >= n {
            return false;
        }
        if from != to {
            let item = self.entries.remove(from);
            self.entries.insert(to, item);
        }
        true
    }

    pub fn move_up(&mut self, index: usize) -> bool {
        index > 0 && self.move_to(index, index - 1)
    }

    pub fn move_down(&mut self, index: usize) -> bool {
        self.move_to(index, index + 1)
    }

    /// Tên file ra gợi ý: `<tên file đầu>_ghep.pdf` (hậu tố do giao diện truyền, theo ngôn ngữ).
    pub fn suggested_output_name(&self, suffix: &str) -> String {
        let stem = self
            .entries
            .first()
            .and_then(|e| e.path.file_stem())
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("merged");
        format!("{stem}_{suffix}.pdf")
    }

    /// Dựng tham số `file.merge`. File nguồn không bị đổi: lõi chỉ đọc chúng, và hàm này chặn đường
    /// ra trùng nguồn để lõi không thay file nguồn.
    pub fn params(
        &self,
        output: &Path,
        bookmarks_from_filenames: bool,
    ) -> Result<FileMergeParams, MergeReject> {
        if self.entries.len() < 2 {
            return Err(MergeReject::TooFew);
        }
        if output.as_os_str().is_empty() {
            return Err(MergeReject::BadOutput);
        }
        let sources: Vec<Option<&Path>> = self
            .entries
            .iter()
            .map(|e| Some(e.path.as_path()))
            .collect();
        if crate::page_ops::output_conflicts_with_protected_path(output, &sources) {
            return Err(MergeReject::OutputIsSource);
        }
        let output_path = Outputpath::try_from(output.display().to_string().as_str())
            .map_err(|_| MergeReject::BadOutput)?;
        let inputs = self
            .entries
            .iter()
            .map(|e| {
                Ok(MergeInput {
                    path: chef_contracts::ops_types::Path::try_from(
                        e.path.display().to_string().as_str(),
                    )
                    .map_err(|_| MergeReject::BadOutput)?,
                    password: e.password.clone(),
                    pages: None,
                })
            })
            .collect::<Result<Vec<_>, MergeReject>>()?;
        Ok(FileMergeParams {
            bookmarks_from_filenames,
            inputs,
            output_path,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(names: &[&str]) -> MergeList {
        let mut l = MergeList::default();
        l.add(names.iter().map(|n| PathBuf::from(format!("/in/{n}"))));
        l
    }

    fn order(l: &MergeList) -> Vec<String> {
        l.entries()
            .iter()
            .map(|e| e.path.file_name().unwrap().to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn reorder_and_remove() {
        let mut l = list(&["a.pdf", "b.pdf", "c.pdf"]);
        assert!(l.move_down(0));
        assert_eq!(order(&l), ["b.pdf", "a.pdf", "c.pdf"]);
        assert!(l.move_to(2, 0));
        assert_eq!(order(&l), ["c.pdf", "b.pdf", "a.pdf"]);
        assert!(!l.move_up(0));
        assert!(!l.move_down(2));
        assert!(!l.move_to(0, 9));
        assert!(l.remove(1));
        assert!(!l.remove(5));
        assert_eq!(order(&l), ["c.pdf", "a.pdf"]);
    }

    #[test]
    fn params_keep_order_password_and_bookmark_flag() {
        let mut l = list(&["a.pdf", "b.pdf"]);
        l.set_password(1, Some("pw".into()));
        let p = l.params(Path::new("/out/all.pdf"), true).unwrap();
        assert!(p.bookmarks_from_filenames);
        assert_eq!(p.inputs.len(), 2);
        assert_eq!(p.inputs[0].path.to_string(), "/in/a.pdf");
        assert_eq!(p.inputs[1].password.as_deref(), Some("pw"));
        assert!(p.inputs.iter().all(|i| i.pages.is_none()));
        let json = serde_json::to_value(&p).unwrap();
        assert_eq!(json["outputPath"], "/out/all.pdf");
        assert_eq!(json["bookmarksFromFilenames"], true);
    }

    #[test]
    fn rejects_bad_requests() {
        let one = list(&["a.pdf"]);
        assert_eq!(
            one.params(Path::new("/out/x.pdf"), false).unwrap_err(),
            MergeReject::TooFew
        );
        let two = list(&["a.pdf", "b.pdf"]);
        assert_eq!(
            two.params(Path::new(""), false).unwrap_err(),
            MergeReject::BadOutput
        );
        assert_eq!(
            two.params(Path::new("/in/b.pdf"), false).unwrap_err(),
            MergeReject::OutputIsSource
        );
    }

    #[test]
    fn suggested_name_uses_first_file() {
        assert_eq!(
            list(&["Hop dong.pdf", "b.pdf"]).suggested_output_name("ghep"),
            "Hop dong_ghep.pdf"
        );
        assert_eq!(
            MergeList::default().suggested_output_name("ghep"),
            "merged_ghep.pdf"
        );
    }
}
