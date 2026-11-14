//! State preservation when a new document revision is loaded (TASKS_RUST R3.06).
//!
//! This module stays independent of GPUI so that the anchor and invalidation rules can be tested
//! without opening a native window.

use std::collections::BTreeSet;

use serde_json::Value;

use crate::{
    scroll::Layout,
    spread::{PageMode, SpreadLayout},
};

/// A point within the first visible page, plus the current zoom.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ViewAnchor {
    pub page: usize,
    /// Fraction from the top of the page, in `[0, 1]`.
    pub page_fraction: f32,
    pub zoom: f32,
}

/// Vertical position within the spread row containing `page`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpreadAnchor {
    pub page: usize,
    /// Fraction from the top of the spread row, in `[0, 1]`.
    pub row_fraction: f32,
    pub zoom: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MutationKind {
    RevisionEdit,
    Save,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MutationOutcome {
    ExplicitFailure,
    Unknown,
    Committed,
}

/// Whether the displayed revision must be re-read before allowing another edit.
pub fn requires_revision_reconciliation(kind: MutationKind, outcome: MutationOutcome) -> bool {
    kind == MutationKind::RevisionEdit
        && matches!(
            outcome,
            MutationOutcome::Unknown | MutationOutcome::Committed
        )
}

/// Capture the first visible page and the relative vertical position inside it.
pub fn capture(layout: &Layout, scroll_y: f32, viewport_h: f32) -> Option<ViewAnchor> {
    let page = *layout.visible(scroll_y, viewport_h).start();
    if page >= layout.page_count() {
        return None;
    }
    let (_, page_h) = layout.page_px(page);
    if page_h <= 0.0 {
        return None;
    }
    let page_fraction = ((scroll_y - layout.page_top(page)) / page_h).clamp(0.0, 1.0);
    Some(ViewAnchor {
        page,
        page_fraction,
        zoom: layout.zoom(),
    })
}

/// Build the replacement geometry at the previous zoom and restore the visible page position.
pub fn restore_layout(
    sizes_pt: Vec<(f32, f32)>,
    gap: f32,
    anchor: Option<ViewAnchor>,
    viewport_h: f32,
) -> (Layout, f32) {
    let zoom = anchor.map_or(1.0, |a| a.zoom);
    let layout = Layout::new(sizes_pt, gap, zoom);
    let scroll_y = anchor
        .filter(|_| layout.page_count() > 0)
        .map(|a| {
            let page = a.page.min(layout.page_count() - 1);
            let (_, page_h) = layout.page_px(page);
            layout.page_top(page) + a.page_fraction * page_h
        })
        .unwrap_or(0.0);
    let scroll_y = layout.clamp_scroll(scroll_y, viewport_h);
    (layout, scroll_y)
}

/// Capture scroll against spread rows, which are the coordinate system used by two-page, book,
/// and slideshow modes. Continuous `Layout` coordinates do not match those modes.
pub fn capture_spread(
    layout: &SpreadLayout,
    scroll_y: f32,
    viewport_h: f32,
) -> Option<SpreadAnchor> {
    let page = *layout.visible_pages(scroll_y, viewport_h).first()?;
    let row_page = layout.first_page_in_row(page)?;
    let row_top = layout.row_top_for_page(row_page)?;
    let row_h = layout.row_height_for_page(row_page)?;
    if row_h <= 0.0 {
        return None;
    }
    Some(SpreadAnchor {
        page: row_page,
        row_fraction: ((scroll_y - row_top) / row_h).clamp(0.0, 1.0),
        zoom: layout.zoom(),
    })
}

/// Rebuild spread geometry at the captured zoom and restore the same row-relative scroll offset.
pub fn restore_spread(
    sizes_pt: Vec<(f32, f32)>,
    mode: PageMode,
    gap_y: f32,
    gap_x: f32,
    anchor: Option<SpreadAnchor>,
    viewport_h: f32,
) -> (SpreadLayout, f32) {
    let zoom = anchor.map_or(1.0, |a| a.zoom);
    let layout = SpreadLayout::new(sizes_pt, mode, gap_y, gap_x, zoom);
    let scroll_y = anchor
        .filter(|_| layout.page_count() > 0)
        .and_then(|a| {
            let page = a.page.min(layout.page_count() - 1);
            let row_top = layout.row_top_for_page(page)?;
            let row_h = layout.row_height_for_page(page)?;
            Some(row_top + a.row_fraction * row_h)
        })
        .unwrap_or(0.0);
    let scroll_y = layout.clamp_scroll(scroll_y, viewport_h);
    (layout, scroll_y)
}

/// Parse the core's `changedPages` result. Unknown/malformed values invalidate all pages safely.
pub fn changed_pages(value: Option<&Value>, page_count: usize) -> BTreeSet<usize> {
    match value {
        Some(Value::String(kind)) if kind == "all" => (0..page_count).collect(),
        Some(Value::Array(pages)) => {
            let mut changed = BTreeSet::new();
            for page in pages {
                let Some(page) = page.as_u64().and_then(|n| usize::try_from(n).ok()) else {
                    return (0..page_count).collect();
                };
                if page >= page_count {
                    return (0..page_count).collect();
                }
                changed.insert(page);
            }
            changed
        }
        _ => (0..page_count).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spread::PageMode;

    fn pages(count: usize) -> Vec<(f32, f32)> {
        vec![(600.0, 800.0); count]
    }

    #[test]
    fn revision_reload_keeps_zoom_and_anchor_page_fraction() {
        let old = Layout::new(pages(5), 16.0, 1.5);
        let old_scroll = old.page_top(2) + 300.0;
        let anchor = capture(&old, old_scroll, 500.0).unwrap();

        let new = Layout::new(
            vec![
                (800.0, 600.0),
                (600.0, 800.0),
                (600.0, 800.0),
                (600.0, 800.0),
                (600.0, 800.0),
            ],
            16.0,
            1.0,
        );
        let (layout, restored) = restore_layout(
            vec![
                (800.0, 600.0),
                (600.0, 800.0),
                (600.0, 800.0),
                (600.0, 800.0),
                (600.0, 800.0),
            ],
            16.0,
            Some(anchor),
            500.0,
        );
        assert!((layout.zoom() - 1.5).abs() < 1e-6);
        assert_eq!(*layout.visible(restored, 500.0).start(), 2);
        let (_, new_h) = layout.page_px(2);
        assert!(((restored - layout.page_top(2)) / new_h - anchor.page_fraction).abs() < 1e-6);
        assert_ne!(new.page_top(2), old.page_top(2));
    }

    #[test]
    fn changed_pages_only_selects_the_core_reported_pages() {
        let changed = serde_json::json!([1, 4]);
        assert_eq!(
            changed_pages(Some(&changed), 6),
            [1, 4].into_iter().collect()
        );
    }

    #[test]
    fn all_or_invalid_changed_pages_fall_back_to_every_page() {
        assert_eq!(
            changed_pages(Some(&Value::String("all".into())), 3),
            [0, 1, 2].into()
        );
        assert_eq!(
            changed_pages(Some(&serde_json::json!([99])), 3),
            [0, 1, 2].into()
        );
        assert_eq!(changed_pages(None, 3), [0, 1, 2].into());
    }

    #[test]
    fn spread_reload_keeps_row_anchor_zoom_and_fraction_in_every_mode() {
        for mode in [PageMode::TwoPage, PageMode::Book, PageMode::Slideshow] {
            let old_sizes = pages(6);
            let old = SpreadLayout::new(old_sizes, mode, 16.0, 16.0, 1.5);
            let target_page = 4;
            let row_page = old.first_page_in_row(target_page).unwrap();
            let row_top = old.row_top_for_page(row_page).unwrap();
            let row_height = old.row_height_for_page(row_page).unwrap();
            let scroll = row_top + row_height * 0.35;
            let anchor = capture_spread(&old, scroll, 100.0).unwrap();
            assert_eq!(anchor.page, row_page, "mode: {mode:?}");

            // Changing the first row's height shifts every later row. The reader should still see
            // the same page group and the same fractional point within that group.
            let mut changed_sizes = pages(6);
            changed_sizes[0].1 = 500.0;
            if mode == PageMode::TwoPage {
                changed_sizes[1].1 = 500.0;
            }
            let (restored, restored_scroll) =
                restore_spread(changed_sizes, mode, 16.0, 16.0, Some(anchor), 100.0);

            assert!((restored.zoom() - 1.5).abs() < 1e-6, "mode: {mode:?}");
            let new_row_top = restored.row_top_for_page(row_page).unwrap();
            let new_row_height = restored.row_height_for_page(row_page).unwrap();
            assert!(
                ((restored_scroll - new_row_top) / new_row_height - anchor.row_fraction).abs()
                    < 1e-6,
                "mode: {mode:?}"
            );
            assert!(
                restored
                    .visible_pages(restored_scroll, 100.0)
                    .contains(&target_page),
                "mode: {mode:?}"
            );
        }
    }

    #[test]
    fn ambiguous_or_committed_revision_mutations_require_reconciliation() {
        for outcome in [MutationOutcome::Unknown, MutationOutcome::Committed] {
            assert!(requires_revision_reconciliation(
                MutationKind::RevisionEdit,
                outcome
            ));
        }
        assert!(!requires_revision_reconciliation(
            MutationKind::RevisionEdit,
            MutationOutcome::ExplicitFailure
        ));
    }

    #[test]
    fn save_does_not_make_the_displayed_revision_stale() {
        assert!(!requires_revision_reconciliation(
            MutationKind::Save,
            MutationOutcome::Unknown
        ));
    }
}
