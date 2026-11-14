//! Geometry for virtualized page thumbnails (TASKS_RUST R2.22).
//!
//! Page thumbnails keep each PDF page's aspect ratio. Only rows intersecting the viewport are
//! returned, with a hard upper bound so unusual tiny pages cannot create an unbounded render set.

pub const MAX_THUMBNAILS: usize = 60;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ThumbnailRow {
    pub page_index: usize,
    pub top: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SidebarLayout {
    rows: Vec<ThumbnailRow>,
    total_height: f32,
}

impl SidebarLayout {
    pub fn new(page_sizes_pt: &[(f32, f32)], thumbnail_width: f32, gap: f32) -> Self {
        let width = if thumbnail_width.is_finite() {
            thumbnail_width.max(1.0)
        } else {
            1.0
        };
        let gap = if gap.is_finite() { gap.max(0.0) } else { 0.0 };
        let mut top = 0.0;
        let rows = page_sizes_pt
            .iter()
            .enumerate()
            .map(|(page_index, &(page_width, page_height))| {
                let ratio = if page_width.is_finite()
                    && page_height.is_finite()
                    && page_width > 0.0
                    && page_height > 0.0
                {
                    page_height / page_width
                } else {
                    1.0
                };
                let height = (width * ratio).clamp(1.0, 100_000.0);
                let row = ThumbnailRow {
                    page_index,
                    top,
                    width,
                    height,
                };
                top += height + gap;
                row
            })
            .collect();
        let total_height = if page_sizes_pt.is_empty() {
            0.0
        } else {
            (top - gap).max(0.0)
        };
        Self { rows, total_height }
    }

    pub fn total_height(&self) -> f32 {
        self.total_height
    }

    pub fn row(&self, page_index: usize) -> Option<ThumbnailRow> {
        self.rows.get(page_index).copied()
    }

    /// Return rows that intersect the viewport. When more than the limit intersect, retain the
    /// nearest rows around the viewport center, preserving page order and the 60-image cap.
    pub fn visible_rows(&self, scroll_y: f32, viewport_height: f32) -> Vec<ThumbnailRow> {
        if self.rows.is_empty() || viewport_height <= 0.0 || !viewport_height.is_finite() {
            return Vec::new();
        }
        let top = if scroll_y.is_finite() {
            scroll_y.max(0.0)
        } else {
            0.0
        };
        let bottom = top + viewport_height;
        let first = self.rows.partition_point(|row| row.top + row.height < top);
        let end = self.rows.partition_point(|row| row.top <= bottom);
        if first >= end {
            return Vec::new();
        }
        let count = end - first;
        if count <= MAX_THUMBNAILS {
            return self.rows[first..end].to_vec();
        }
        let center = top + viewport_height / 2.0;
        let center_index = self.rows[first..end]
            .partition_point(|row| row.top + row.height / 2.0 < center)
            + first;
        let start = center_index
            .saturating_sub(MAX_THUMBNAILS / 2)
            .clamp(first, end - MAX_THUMBNAILS);
        self.rows[start..start + MAX_THUMBNAILS].to_vec()
    }

    pub fn scroll_for_page(&self, page_index: usize, viewport_height: f32) -> Option<f32> {
        let row = self.rows.get(page_index)?;
        Some((row.top - (viewport_height - row.height).max(0.0) / 2.0).max(0.0))
    }
}

#[cfg(test)]
mod tests {
    use super::{MAX_THUMBNAILS, SidebarLayout};

    #[test]
    fn thumbnail_height_tracks_each_page_aspect_ratio() {
        let layout = SidebarLayout::new(&[(600.0, 800.0), (800.0, 600.0)], 120.0, 8.0);
        assert_eq!(layout.row(0).unwrap().height, 160.0);
        assert_eq!(layout.row(1).unwrap().height, 90.0);
        assert_eq!(layout.row(1).unwrap().top, 168.0);
    }

    #[test]
    fn visible_rows_exclude_offscreen_pages_and_preserve_variable_heights() {
        let sizes = vec![(100.0, 100.0), (100.0, 200.0), (100.0, 100.0)];
        let layout = SidebarLayout::new(&sizes, 100.0, 10.0);
        let rows = layout.visible_rows(110.0, 100.0);
        assert_eq!(
            rows.iter().map(|row| row.page_index).collect::<Vec<_>>(),
            vec![1]
        );
    }

    #[test]
    fn visible_rows_are_capped_even_for_many_tiny_pages() {
        let sizes = vec![(100.0, 1.0); 10_000];
        let layout = SidebarLayout::new(&sizes, 100.0, 0.0);
        let rows = layout.visible_rows(0.0, 90_000.0);
        assert_eq!(rows.len(), MAX_THUMBNAILS);
        assert!(
            rows.windows(2)
                .all(|pair| pair[0].page_index < pair[1].page_index)
        );
    }

    #[test]
    fn bookmark_navigation_can_center_target_row() {
        let sizes = vec![(100.0, 200.0); 20];
        let layout = SidebarLayout::new(&sizes, 100.0, 10.0);
        assert_eq!(layout.scroll_for_page(10, 300.0), Some(2050.0));
        assert_eq!(layout.scroll_for_page(100, 100.0), None);
    }
}
