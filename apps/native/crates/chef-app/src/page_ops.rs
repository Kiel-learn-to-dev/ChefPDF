//! Tham số có kiểu và cập nhật vùng chọn cho thao tác trang (TASKS_RUST R4.03).

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use chef_contracts::ops_types::{
    Angle, Outputpath, PageDeleteParams, PageDuplicateParams, PageExtractParams,
    PageInsertBlankParams, PageInsertFromFileParams, PageReplaceParams, PageRotateParams,
};
use chef_viewer::selection::PageSelection;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeleteReject {
    EmptySelection,
    CannotDeleteAll,
    OutOfRange,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageEditReject {
    EmptySelection,
    OutOfRange,
    InvalidPosition,
    InvalidCount,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReorderPlan {
    /// New page at index `i` comes from old page `order[i]`.
    pub order: Vec<usize>,
    /// New indices occupied by the pages that were dragged.
    pub selected_after: Vec<usize>,
}

/// Move the selected pages as an ordered block immediately before `target`.
/// Returns `None` when the input is invalid or the target is part of the dragged block.
pub fn reorder_plan(pages: &[usize], selected: &[usize], target: usize) -> Option<ReorderPlan> {
    if pages.is_empty() || target >= pages.len() {
        return None;
    }
    let selected = sorted_unique_pages(selected);
    if selected.is_empty()
        || selected.iter().any(|&page| page >= pages.len())
        || selected.contains(&target)
    {
        return None;
    }
    let moved: BTreeSet<_> = selected.iter().copied().collect();
    let mut order: Vec<_> = pages
        .iter()
        .copied()
        .filter(|page| !moved.contains(page))
        .collect();
    let insert_at = order.iter().position(|&page| page == target)?;
    order.splice(insert_at..insert_at, selected.iter().copied());
    let selected_after = order
        .iter()
        .enumerate()
        .filter_map(|(index, page)| moved.contains(page).then_some(index))
        .collect();
    if order == pages {
        return None;
    }
    Some(ReorderPlan {
        order,
        selected_after,
    })
}

fn sorted_unique_pages(pages: &[usize]) -> Vec<usize> {
    pages
        .iter()
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// True when an output path resolves to the same file as any protected input/revision path.
/// The identity check catches hard links; canonical paths catch relative and symlink aliases.
pub fn output_conflicts_with_protected_path(output: &Path, protected: &[Option<&Path>]) -> bool {
    protected.iter().flatten().any(|path| {
        same_file::is_same_file(output, path).unwrap_or(false)
            || normalized_path(output)
                .zip(normalized_path(path))
                .is_some_and(|(left, right)| paths_equal(&left, &right))
    })
}

fn normalized_path(path: &Path) -> Option<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    if let Ok(canonical) = std::fs::canonicalize(&absolute) {
        return Some(canonical);
    }
    let file_name = absolute.file_name()?;
    let parent = absolute.parent()?;
    let parent = std::fs::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf());
    Some(parent.join(file_name))
}

#[cfg(windows)]
fn paths_equal(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

#[cfg(not(windows))]
fn paths_equal(left: &Path, right: &Path) -> bool {
    left == right
}

pub fn rotate_params(pages: &[usize], angle: i64) -> Result<PageRotateParams, String> {
    let unique = sorted_unique_pages(pages);
    if unique.is_empty() {
        return Err("Chưa chọn trang nào".into());
    }
    let angle = Angle::try_from(angle).map_err(|e| format!("Góc xoay không hợp lệ: {e}"))?;
    Ok(PageRotateParams {
        angle,
        pages: unique.into_iter().map(|p| p as u64).collect(),
    })
}

pub fn delete_params(pages: &[usize], page_count: usize) -> Result<PageDeleteParams, DeleteReject> {
    let unique = sorted_unique_pages(pages);
    if unique.is_empty() {
        return Err(DeleteReject::EmptySelection);
    }
    if unique.iter().any(|&p| p >= page_count) {
        return Err(DeleteReject::OutOfRange);
    }
    if unique.len() >= page_count {
        return Err(DeleteReject::CannotDeleteAll);
    }
    Ok(PageDeleteParams {
        pages: unique.into_iter().map(|p| p as u64).collect(),
    })
}

pub fn duplicate_params(pages: &[usize]) -> Result<PageDuplicateParams, String> {
    let unique = sorted_unique_pages(pages);
    if unique.is_empty() {
        return Err("Chưa chọn trang nào".into());
    }
    Ok(PageDuplicateParams {
        pages: unique.into_iter().map(|p| p as u64).collect(),
    })
}

pub fn extract_params(pages: &[usize], output_path: &str) -> Result<PageExtractParams, String> {
    if pages.is_empty() {
        return Err("Chưa chọn trang nào".into());
    }
    let output_path = Outputpath::try_from(output_path)
        .map_err(|e| format!("Đường dẫn xuất không hợp lệ: {e}"))?;
    Ok(PageExtractParams {
        output_path,
        pages: pages.iter().copied().map(|p| p as u64).collect(),
    })
}

/// Build `page.insertBlank` params. `at` is a zero-based insertion point, including page_count.
pub fn insert_blank_params(
    at: usize,
    page_count: usize,
    count: usize,
) -> Result<PageInsertBlankParams, PageEditReject> {
    if at > page_count {
        return Err(PageEditReject::InvalidPosition);
    }
    let count = std::num::NonZeroU64::new(count as u64).ok_or(PageEditReject::InvalidCount)?;
    if count.get() > 1000 {
        return Err(PageEditReject::InvalidCount);
    }
    Ok(PageInsertBlankParams {
        at: at as u64,
        count,
        height: None,
        width: None,
    })
}

pub fn insert_from_file_params(
    at: usize,
    page_count: usize,
    path: &str,
    pages: Option<&[usize]>,
) -> Result<PageInsertFromFileParams, PageEditReject> {
    if at > page_count {
        return Err(PageEditReject::InvalidPosition);
    }
    let pages = pages
        .map(|items| {
            if items.is_empty() {
                Err(PageEditReject::EmptySelection)
            } else {
                Ok(items.iter().map(|&page| page as u64).collect())
            }
        })
        .transpose()?;
    let path = chef_contracts::ops_types::Path::try_from(path)
        .map_err(|_| PageEditReject::InvalidPosition)?;
    Ok(PageInsertFromFileParams {
        at: at as u64,
        pages,
        password: None,
        path,
    })
}

pub fn replace_params(
    targets: &[usize],
    page_count: usize,
    path: &str,
    source_pages: Option<&[usize]>,
) -> Result<PageReplaceParams, PageEditReject> {
    let targets = sorted_unique_pages(targets);
    if targets.is_empty() {
        return Err(PageEditReject::EmptySelection);
    }
    if targets.iter().any(|&page| page >= page_count) {
        return Err(PageEditReject::OutOfRange);
    }
    let source_pages = source_pages
        .map(|items| {
            if items.is_empty() {
                Err(PageEditReject::EmptySelection)
            } else {
                Ok(items.iter().map(|&page| page as i64).collect())
            }
        })
        .transpose()?;
    let path = chef_contracts::ops_types::Path::try_from(path)
        .map_err(|_| PageEditReject::InvalidPosition)?;
    Ok(PageReplaceParams {
        pages: targets.into_iter().map(|page| page as i64).collect(),
        password: None,
        path,
        source_pages,
    })
}

pub fn selection_after_insert(at: usize, inserted_count: usize, new_count: usize) -> PageSelection {
    if inserted_count == 0 || new_count == 0 {
        return PageSelection::empty();
    }
    PageSelection::from_pages([at.min(new_count - 1)])
}

pub fn selection_after_replace(targets: &[usize], new_count: usize) -> PageSelection {
    if new_count == 0 {
        return PageSelection::empty();
    }
    PageSelection::from_pages([targets
        .iter()
        .copied()
        .min()
        .unwrap_or(0)
        .min(new_count - 1)])
}

/// Định dạng chỉ số 0-based thành chuỗi khoảng 1-based rút gọn (`"1-3,5"`).
pub fn format_page_ranges(pages: &[usize]) -> String {
    let sorted = sorted_unique_pages(pages);
    let mut out = Vec::new();
    let mut i = 0;
    while i < sorted.len() {
        let start = sorted[i];
        let mut end = start;
        while i + 1 < sorted.len() && sorted[i + 1] == end + 1 {
            i += 1;
            end = sorted[i];
        }
        if start == end {
            out.push(format!("{}", start + 1));
        } else {
            out.push(format!("{}-{}", start + 1, end + 1));
        }
        i += 1;
    }
    out.join(",")
}

pub fn suggested_extract_filename(source_name: &str, suffix: &str, pages: &[usize]) -> String {
    let stem = match source_name.rfind('.') {
        Some(i) if i > 0 => &source_name[..i],
        _ => source_name,
    };
    let ranges = format_page_ranges(pages).replace(',', "_");
    if ranges.is_empty() {
        format!("{stem}_{suffix}.pdf")
    } else {
        format!("{stem}_{suffix}_{ranges}.pdf")
    }
}

pub fn selection_after_delete(deleted: &[usize], new_count: usize) -> PageSelection {
    if new_count == 0 {
        return PageSelection::empty();
    }
    let first = deleted.iter().copied().min().unwrap_or(0);
    PageSelection::from_pages([first.min(new_count - 1)])
}

pub fn selection_after_duplicate(duplicated: &[usize], new_count: usize) -> PageSelection {
    let sorted = sorted_unique_pages(duplicated);
    let copied = sorted
        .into_iter()
        .enumerate()
        .map(|(i, p)| p + i + 1)
        .filter(|&p| p < new_count);
    PageSelection::from_pages(copied)
}

#[cfg(test)]
mod tests {
    use super::{
        DeleteReject, PageEditReject, delete_params, duplicate_params, extract_params,
        format_page_ranges, insert_blank_params, insert_from_file_params,
        output_conflicts_with_protected_path, reorder_plan, replace_params, rotate_params,
        selection_after_delete, selection_after_duplicate, selection_after_insert,
        selection_after_replace, suggested_extract_filename,
    };
    use chef_viewer::selection::PageSelection;

    #[test]
    fn extraction_output_cannot_replace_source_by_path_alias_or_hard_link() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir =
            std::env::temp_dir().join(format!("chef-page-output-{}-{nonce}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.pdf");
        let other = dir.join("other.pdf");
        let hard_link = dir.join("source-hard-link.pdf");
        std::fs::write(&source, b"source").unwrap();
        std::fs::write(&other, b"other").unwrap();
        std::fs::hard_link(&source, &hard_link).expect("test directory supports hard links");
        let protected = [Some(source.as_path())];

        assert!(output_conflicts_with_protected_path(&source, &protected));
        assert!(output_conflicts_with_protected_path(
            &dir.join(".").join("source.pdf"),
            &protected
        ));
        assert!(output_conflicts_with_protected_path(&hard_link, &protected));
        assert!(!output_conflicts_with_protected_path(&other, &protected));

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rotate_params_dedupes_sorts_and_validates_angle() {
        let ok = rotate_params(&[3, 1, 3], 90).expect("valid rotate params");
        assert_eq!(ok.pages, vec![1, 3]);
        assert_eq!(*ok.angle, 90);
        assert!(rotate_params(&[], 90).is_err());
        assert!(rotate_params(&[0], 45).is_err());
    }

    #[test]
    fn delete_params_rejects_empty_out_of_range_and_all_pages() {
        assert_eq!(
            delete_params(&[], 4).err(),
            Some(DeleteReject::EmptySelection)
        );
        assert_eq!(delete_params(&[4], 4).err(), Some(DeleteReject::OutOfRange));
        assert_eq!(
            delete_params(&[0, 1, 2, 3], 4).err(),
            Some(DeleteReject::CannotDeleteAll)
        );
        assert_eq!(
            delete_params(&[1, 1, 2, 0, 3], 4).err(),
            Some(DeleteReject::CannotDeleteAll)
        );
        let ok = delete_params(&[3, 1, 3], 4).expect("valid delete params");
        assert_eq!(ok.pages, vec![1, 3]);
    }

    #[test]
    fn duplicate_params_dedupes_and_sorts() {
        let ok = duplicate_params(&[2, 0, 2]).expect("valid duplicate params");
        assert_eq!(ok.pages, vec![0, 2]);
        assert!(duplicate_params(&[]).is_err());
    }

    #[test]
    fn reorder_moves_a_selected_block_before_target_and_preserves_relative_order() {
        let plan = reorder_plan(&[0, 1, 2, 3, 4], &[3, 1, 3], 4).unwrap();
        assert_eq!(plan.order, vec![0, 2, 1, 3, 4]);
        assert_eq!(plan.selected_after, vec![2, 3]);

        let plan = reorder_plan(&[0, 1, 2, 3, 4], &[1, 3], 0).unwrap();
        assert_eq!(plan.order, vec![1, 3, 0, 2, 4]);
        assert_eq!(plan.selected_after, vec![0, 1]);
    }

    #[test]
    fn reorder_rejects_drop_on_selection_invalid_pages_and_noop() {
        assert!(reorder_plan(&[0, 1, 2], &[1], 1).is_none());
        assert!(reorder_plan(&[0, 1, 2], &[3], 0).is_none());
        assert!(reorder_plan(&[0, 1, 2], &[0], 3).is_none());
        assert!(reorder_plan(&[0, 1, 2], &[0], 1).is_none());
    }

    #[test]
    fn extract_params_preserves_order_and_validates_path() {
        let ok = extract_params(&[3, 1], "C:\\out\\sub.pdf").expect("valid extract params");
        assert_eq!(ok.pages, vec![3, 1]);
        assert_eq!(ok.output_path.as_str(), "C:\\out\\sub.pdf");
        assert!(extract_params(&[], "C:\\out\\sub.pdf").is_err());
        assert!(extract_params(&[0], "").is_err());
    }

    #[test]
    fn formats_compact_ranges_and_extract_filenames() {
        assert_eq!(format_page_ranges(&[]), "");
        assert_eq!(format_page_ranges(&[0, 1, 2, 4, 6, 7, 8]), "1-3,5,7-9");
        assert_eq!(
            suggested_extract_filename("bao_cao.pdf", "trang", &[1, 3]),
            "bao_cao_trang_2_4.pdf"
        );
        assert_eq!(
            suggested_extract_filename("single", "pages", &[0, 1, 2]),
            "single_pages_1-3.pdf"
        );
    }

    #[test]
    fn selection_remaps_after_delete_and_duplicate() {
        assert_eq!(
            selection_after_delete(&[1, 3], 2).selected(),
            &[1],
            "points to page at first deleted slot"
        );
        assert_eq!(
            selection_after_delete(&[3], 3).selected(),
            &[2],
            "clamps to last page when tail deleted"
        );
        assert_eq!(selection_after_delete(&[0], 0), PageSelection::empty());

        // Pages 0 and 2 duplicated in 4-page doc -> copies land at 1 and 4 in 6-page doc.
        assert_eq!(selection_after_duplicate(&[2, 0], 6).selected(), &[1, 4]);
    }

    #[test]
    fn insert_blank_params_validate_position_and_count() {
        let params = insert_blank_params(4, 4, 2).expect("append position is valid");
        assert_eq!(params.at, 4);
        assert_eq!(params.count.get(), 2);
        assert_eq!(
            insert_blank_params(5, 4, 1).err(),
            Some(PageEditReject::InvalidPosition)
        );
        assert_eq!(
            insert_blank_params(0, 4, 0).err(),
            Some(PageEditReject::InvalidCount)
        );
        assert_eq!(
            insert_blank_params(0, 4, 1001).err(),
            Some(PageEditReject::InvalidCount)
        );
    }

    #[test]
    fn insert_and_replace_params_use_core_wire_names_and_validate_pages() {
        let insert = insert_from_file_params(2, 4, "C:\\source.pdf", Some(&[3, 1]))
            .expect("valid source pages");
        assert_eq!(
            serde_json::to_value(insert).unwrap(),
            serde_json::json!({
                "at": 2,
                "pages": [3, 1],
                "path": "C:\\source.pdf"
            })
        );
        assert_eq!(
            insert_from_file_params(5, 4, "C:\\source.pdf", None).err(),
            Some(PageEditReject::InvalidPosition)
        );
        assert_eq!(
            insert_from_file_params(0, 4, "C:\\source.pdf", Some(&[])).err(),
            Some(PageEditReject::EmptySelection)
        );

        let replace =
            replace_params(&[3, 1, 3], 4, "C:\\source.pdf", Some(&[0])).expect("valid replacement");
        assert_eq!(
            serde_json::to_value(replace).unwrap(),
            serde_json::json!({
                "pages": [1, 3],
                "path": "C:\\source.pdf",
                "sourcePages": [0]
            })
        );
        assert_eq!(
            replace_params(&[4], 4, "C:\\source.pdf", None).err(),
            Some(PageEditReject::OutOfRange)
        );
        assert_eq!(
            replace_params(&[], 4, "C:\\source.pdf", None).err(),
            Some(PageEditReject::EmptySelection)
        );
    }

    #[test]
    fn insertion_and_replacement_select_the_first_affected_page() {
        assert_eq!(selection_after_insert(3, 2, 7).selected(), &[3]);
        assert_eq!(selection_after_insert(7, 2, 9).selected(), &[7]);
        assert_eq!(selection_after_insert(0, 0, 0), PageSelection::empty());
        assert_eq!(selection_after_replace(&[4, 1], 3).selected(), &[1]);
        assert_eq!(selection_after_replace(&[4], 0), PageSelection::empty());
    }
}
