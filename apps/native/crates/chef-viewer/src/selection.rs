//! Chọn nhiều trang dùng chung giữa thanh bên thumbnail và lưới trang (TASKS_RUST R4.02).
//!
//! Phiên bản Rust thuần (không phụ thuộc GPUI) tương ứng `apps/ui/src/features/pages/selection.ts`.

use std::collections::BTreeSet;

/// Phím bổ trợ khi bấm chuột chọn trang: `shift` chọn khoảng, `toggle` (Ctrl/Cmd) bật tắt từng trang.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ClickModifiers {
    pub shift: bool,
    pub toggle: bool,
}

/// Chẵn/lẻ theo số trang 1-based (`Odd` = trang 1, 3, 5… = chỉ số 0-based chẵn).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageParity {
    Odd,
    Even,
}

/// Trạng thái vùng chọn trang (chỉ số 0-based, luôn tăng dần và không trùng).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PageSelection {
    selected: Vec<usize>,
    anchor: Option<usize>,
    focus: Option<usize>,
}

fn range_vec(a: usize, b: usize) -> Vec<usize> {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    (lo..=hi).collect()
}

fn sort_unique(iter: impl IntoIterator<Item = usize>) -> Vec<usize> {
    iter.into_iter()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

impl PageSelection {
    pub fn empty() -> Self {
        Self::default()
    }

    pub fn from_pages(pages: impl IntoIterator<Item = usize>) -> Self {
        let selected = sort_unique(pages);
        let anchor = selected.first().copied();
        let focus = selected.last().copied();
        Self {
            selected,
            anchor,
            focus,
        }
    }

    pub fn selected(&self) -> &[usize] {
        &self.selected
    }

    pub fn anchor(&self) -> Option<usize> {
        self.anchor
    }

    pub fn focus(&self) -> Option<usize> {
        self.focus
    }

    pub fn contains(&self, index: usize) -> bool {
        self.selected.binary_search(&index).is_ok()
    }

    pub fn is_empty(&self) -> bool {
        self.selected.is_empty()
    }

    pub fn len(&self) -> usize {
        self.selected.len()
    }

    /// Áp dụng click lên trang `index` với phím bổ trợ (giống `clickSelect` trong Electron).
    pub fn click_select(&self, index: usize, mods: ClickModifiers) -> Self {
        if mods.shift
            && let Some(anchor) = self.anchor
        {
            let span = range_vec(anchor, index);
            let selected = if mods.toggle {
                sort_unique(self.selected.iter().copied().chain(span))
            } else {
                span
            };
            return Self {
                selected,
                anchor: Some(anchor),
                focus: Some(index),
            };
        }
        if mods.toggle {
            let selected = if self.contains(index) {
                self.selected
                    .iter()
                    .copied()
                    .filter(|&i| i != index)
                    .collect()
            } else {
                sort_unique(self.selected.iter().copied().chain(std::iter::once(index)))
            };
            return Self {
                selected,
                anchor: Some(index),
                focus: Some(index),
            };
        }
        Self {
            selected: vec![index],
            anchor: Some(index),
            focus: Some(index),
        }
    }

    /// Chuột phải lên trang `index`: giữ nguyên vùng chọn nếu `index` đã được chọn, ngược lại chọn mỗi trang đó.
    pub fn context_select(&self, index: usize) -> Self {
        if self.contains(index) {
            Self {
                selected: self.selected.clone(),
                anchor: self.anchor,
                focus: Some(index),
            }
        } else {
            self.click_select(index, ClickModifiers::default())
        }
    }

    /// Nhấn chuột trước khi kéo hoặc mở menu: giữ nguyên nhiều trang nếu mục đã nằm trong vùng chọn.
    pub fn press_select(&self, index: usize, mods: ClickModifiers) -> Self {
        if !mods.shift && !mods.toggle && self.contains(index) {
            return Self {
                selected: self.selected.clone(),
                anchor: self.anchor,
                focus: Some(index),
            };
        }
        self.click_select(index, mods)
    }

    pub fn select_all(count: usize) -> Self {
        if count == 0 {
            Self::empty()
        } else {
            Self {
                selected: (0..count).collect(),
                anchor: Some(0),
                focus: Some(0),
            }
        }
    }

    /// Di chuyển tiêu điểm bàn phím theo `delta` (ví dụ ±1 hoặc ±cột); `extend = true` mở rộng vùng chọn.
    pub fn move_focus(&self, delta: isize, count: usize, extend: bool) -> Self {
        if count == 0 {
            return Self::empty();
        }
        let from = self
            .focus
            .map(|f| f as isize)
            .unwrap_or_else(|| if delta > 0 { -1 } else { count as isize });
        let next = (from + delta).clamp(0, (count - 1) as isize) as usize;
        if extend {
            let anchor = self.anchor.unwrap_or(next);
            Self {
                selected: range_vec(anchor, next),
                anchor: Some(anchor),
                focus: Some(next),
            }
        } else {
            Self {
                selected: vec![next],
                anchor: Some(next),
                focus: Some(next),
            }
        }
    }

    /// Giữ vùng chọn hợp lệ sau khi số trang thay đổi.
    pub fn clamp(&self, count: usize) -> Self {
        Self {
            selected: self
                .selected
                .iter()
                .copied()
                .filter(|&i| i < count)
                .collect(),
            anchor: self.anchor.filter(|&i| i < count),
            focus: self.focus.filter(|&i| i < count),
        }
    }

    /// Đảo vùng chọn trong phạm vi `0..count`.
    pub fn invert(&self, count: usize) -> Self {
        let selected: Vec<usize> = (0..count).filter(|i| !self.contains(*i)).collect();
        let anchor = selected.first().copied();
        let focus = selected.last().copied();
        Self {
            selected,
            anchor,
            focus,
        }
    }

    /// Chọn các trang lẻ hoặc chẵn (1-based) trong phạm vi `0..count`.
    pub fn select_by_parity(count: usize, parity: PageParity) -> Self {
        let want_even_index = parity == PageParity::Odd;
        let selected: Vec<usize> = (0..count)
            .filter(|&i| (i % 2 == 0) == want_even_index)
            .collect();
        let anchor = selected.first().copied();
        let focus = selected.last().copied();
        Self {
            selected,
            anchor,
            focus,
        }
    }

    /// Trang áp dụng thao tác: vùng đang chọn nếu khác rỗng, ngược lại là trang đang xem hiện tại.
    pub fn target_pages(&self, current_page: usize, page_count: usize) -> Vec<usize> {
        let chosen: Vec<usize> = self
            .selected
            .iter()
            .copied()
            .filter(|&i| i < page_count)
            .collect();
        if !chosen.is_empty() {
            chosen
        } else if current_page < page_count {
            vec![current_page]
        } else {
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ClickModifiers, PageParity, PageSelection};

    #[test]
    fn plain_click_selects_one() {
        let s = PageSelection::empty().click_select(3, ClickModifiers::default());
        assert_eq!(s.selected(), &[3]);
        assert_eq!(s.anchor(), Some(3));
        assert_eq!(s.focus(), Some(3));
    }

    #[test]
    fn shift_click_selects_range_from_anchor() {
        let s = PageSelection::empty().click_select(2, ClickModifiers::default());
        let s = s.click_select(
            5,
            ClickModifiers {
                shift: true,
                toggle: false,
            },
        );
        assert_eq!(s.selected(), &[2, 3, 4, 5]);
        let s = s.click_select(
            0,
            ClickModifiers {
                shift: true,
                toggle: false,
            },
        );
        assert_eq!(s.selected(), &[0, 1, 2]);
        assert_eq!(s.anchor(), Some(2));
        assert_eq!(s.focus(), Some(0));
    }

    #[test]
    fn ctrl_click_toggles() {
        let s = PageSelection::empty().click_select(1, ClickModifiers::default());
        let s = s.click_select(
            4,
            ClickModifiers {
                shift: false,
                toggle: true,
            },
        );
        assert_eq!(s.selected(), &[1, 4]);
        let s = s.click_select(
            1,
            ClickModifiers {
                shift: false,
                toggle: true,
            },
        );
        assert_eq!(s.selected(), &[4]);
    }

    #[test]
    fn ctrl_shift_click_adds_range() {
        let s = PageSelection::empty().click_select(0, ClickModifiers::default());
        let s = s.click_select(
            5,
            ClickModifiers {
                shift: false,
                toggle: true,
            },
        );
        let s = s.click_select(
            7,
            ClickModifiers {
                shift: true,
                toggle: true,
            },
        );
        assert_eq!(s.selected(), &[0, 5, 6, 7]);
    }

    #[test]
    fn press_keeps_existing_multi_selection() {
        let s = PageSelection::from_pages([1, 2, 3]);
        let kept = s.press_select(2, ClickModifiers::default());
        assert_eq!(kept.selected(), &[1, 2, 3]);
        assert_eq!(kept.focus(), Some(2));
        assert_eq!(
            kept.press_select(5, ClickModifiers::default()).selected(),
            &[5]
        );
    }

    #[test]
    fn select_all_handles_nonempty_and_empty() {
        assert_eq!(PageSelection::select_all(3).selected(), &[0, 1, 2]);
        assert!(PageSelection::select_all(0).is_empty());
    }

    #[test]
    fn keyboard_focus_movement_works_and_extends() {
        let s = PageSelection::empty().move_focus(1, 5, false);
        assert_eq!(s.selected(), &[0]);
        let s = s.move_focus(2, 5, true);
        assert_eq!(s.selected(), &[0, 1, 2]);
        let s = s.move_focus(10, 5, false);
        assert_eq!(s.selected(), &[4]);
        assert_eq!(s.move_focus(-1, 0, false), PageSelection::empty());
    }

    #[test]
    fn clamps_after_page_count_shrinks() {
        let s = PageSelection {
            selected: vec![1, 4, 6],
            anchor: Some(6),
            focus: Some(4),
        };
        let clamped = s.clamp(5);
        assert_eq!(clamped.selected(), &[1, 4]);
        assert_eq!(clamped.anchor(), None);
        assert_eq!(clamped.focus(), Some(4));
    }

    #[test]
    fn inverts_selection_over_page_count() {
        let s = PageSelection::from_pages([1, 3]).invert(5);
        assert_eq!(s.selected(), &[0, 2, 4]);
        assert_eq!(s.anchor(), Some(0));
        assert_eq!(s.focus(), Some(4));
        assert_eq!(
            PageSelection::select_all(3).invert(3),
            PageSelection::empty()
        );
        assert_eq!(PageSelection::empty().invert(2).selected(), &[0, 1]);
    }

    #[test]
    fn selects_odd_and_even_pages() {
        assert_eq!(
            PageSelection::select_by_parity(5, PageParity::Odd).selected(),
            &[0, 2, 4]
        );
        assert_eq!(
            PageSelection::select_by_parity(5, PageParity::Even).selected(),
            &[1, 3]
        );
        assert_eq!(
            PageSelection::select_by_parity(0, PageParity::Odd),
            PageSelection::empty()
        );
    }

    #[test]
    fn right_click_keeps_or_replaces_selection() {
        let s = PageSelection::from_pages([1, 3]);
        let outside = s.context_select(5);
        assert_eq!(outside.selected(), &[5]);
        assert_eq!(outside.anchor(), Some(5));
        assert_eq!(outside.focus(), Some(5));

        let inside = s.context_select(3);
        assert_eq!(inside.selected(), &[1, 3]);
        assert_eq!(inside.focus(), Some(3));
    }

    #[test]
    fn target_pages_prefers_selection_otherwise_current_page() {
        let s = PageSelection::from_pages([1, 3]);
        assert_eq!(s.target_pages(0, 5), vec![1, 3]);
        assert_eq!(PageSelection::empty().target_pages(2, 5), vec![2]);
        assert!(PageSelection::empty().target_pages(0, 0).is_empty());
    }
}
