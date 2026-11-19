//! Hình học lưới trang (TASKS_RUST R4.01).
//!
//! Các trang xếp thành hàng, mỗi hàng `columns` ô. Ô giữ tỷ lệ trang trong khung rộng cố định.
//! Chỉ trả về ô của các hàng giao viewport, giới hạn `MAX_CELLS` để file nhiều trang không tạo
//! số thumbnail không giới hạn.

pub const MAX_CELLS: usize = 60;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct GridCell {
    pub page_index: usize,
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct GridLayout {
    cells: Vec<GridCell>,
    columns: usize,
    row_tops: Vec<f32>,
    total_height: f32,
}

impl GridLayout {
    /// Xây lưới `columns` cột. `cell_width` là chiều rộng khung ô, `gap` là khoảng cách giữa các
    /// ô và giữa các hàng. Chiều cao ô theo tỷ lệ trang; cả hàng cao bằng ô cao nhất trong hàng.
    pub fn new(page_sizes_pt: &[(f32, f32)], columns: usize, cell_width: f32, gap: f32) -> Self {
        let columns = columns.max(1);
        let cell_width = if cell_width.is_finite() {
            cell_width.max(1.0)
        } else {
            1.0
        };
        let gap = if gap.is_finite() { gap.max(0.0) } else { 0.0 };
        let mut cells = Vec::with_capacity(page_sizes_pt.len());
        let mut row_tops = Vec::new();
        let mut row_top = 0.0_f32;
        for (row_start, row) in page_sizes_pt.chunks(columns).enumerate() {
            let heights: Vec<f32> = row
                .iter()
                .map(|&(w, h)| cell_height(w, h, cell_width))
                .collect();
            let row_height = heights.iter().copied().fold(1.0_f32, f32::max);
            row_tops.push(row_top);
            for (col, height) in heights.into_iter().enumerate() {
                cells.push(GridCell {
                    page_index: row_start * columns + col,
                    left: col as f32 * (cell_width + gap),
                    top: row_top,
                    width: cell_width,
                    height,
                });
            }
            row_top += row_height + gap;
        }
        let total_height = if page_sizes_pt.is_empty() {
            0.0
        } else {
            (row_top - gap).max(0.0)
        };
        Self {
            cells,
            columns,
            row_tops,
            total_height,
        }
    }

    /// Số cột vừa khít chiều rộng khả dụng, ít nhất 1.
    pub fn columns_for_width(available: f32, cell_width: f32, gap: f32) -> usize {
        if !available.is_finite() || !cell_width.is_finite() || cell_width <= 0.0 {
            return 1;
        }
        let gap = if gap.is_finite() { gap.max(0.0) } else { 0.0 };
        let fit = ((available + gap) / (cell_width + gap)).floor();
        if fit.is_finite() && fit >= 1.0 {
            fit as usize
        } else {
            1
        }
    }

    pub fn columns(&self) -> usize {
        self.columns
    }

    pub fn total_height(&self) -> f32 {
        self.total_height
    }

    pub fn cell(&self, page_index: usize) -> Option<GridCell> {
        self.cells.get(page_index).copied()
    }

    /// Các ô của hàng giao viewport, theo thứ tự trang. Khi vượt `MAX_CELLS`, giữ cửa sổ liền kề
    /// quanh tâm viewport.
    pub fn visible_cells(&self, scroll_y: f32, viewport_height: f32) -> Vec<GridCell> {
        if self.cells.is_empty() || viewport_height <= 0.0 || !viewport_height.is_finite() {
            return Vec::new();
        }
        let top = if scroll_y.is_finite() {
            scroll_y.max(0.0)
        } else {
            0.0
        };
        let bottom = top + viewport_height;
        let first_row = self
            .row_tops
            .partition_point(|&row_top| row_top <= top)
            .saturating_sub(1);
        let end_row = self.row_tops.partition_point(|&row_top| row_top <= bottom);
        let first = (first_row * self.columns).min(self.cells.len());
        let end = (end_row * self.columns).min(self.cells.len());
        if first >= end {
            return Vec::new();
        }
        let count = end - first;
        if count <= MAX_CELLS {
            return self.cells[first..end].to_vec();
        }
        let center = top + viewport_height / 2.0;
        let center_row = self.row_tops[first_row..end_row]
            .partition_point(|&row_top| row_top < center)
            .saturating_sub(1)
            + first_row;
        let center_index = (center_row * self.columns).clamp(first, end - 1);
        let start = center_index
            .saturating_sub(MAX_CELLS / 2)
            .clamp(first, end - MAX_CELLS);
        self.cells[start..start + MAX_CELLS].to_vec()
    }

    /// Trang nằm dưới điểm (x, y) trong hệ tọa độ nội dung lưới, nếu có.
    pub fn page_at(&self, x: f32, y: f32) -> Option<usize> {
        if !x.is_finite() || !y.is_finite() || self.cells.is_empty() {
            return None;
        }
        let row = self
            .row_tops
            .partition_point(|&row_top| row_top <= y)
            .checked_sub(1)?;
        let row_start = row * self.columns;
        self.cells[row_start..(row_start + self.columns).min(self.cells.len())]
            .iter()
            .find(|cell| {
                x >= cell.left
                    && x < cell.left + cell.width
                    && y >= cell.top
                    && y < cell.top + cell.height
            })
            .map(|cell| cell.page_index)
    }

    /// Vị trí cuộn đưa hàng của trang vào giữa viewport, không âm.
    pub fn scroll_for_page(&self, page_index: usize, viewport_height: f32) -> Option<f32> {
        let cell = self.cells.get(page_index)?;
        let row_top = self.row_tops[page_index / self.columns];
        Some((row_top - (viewport_height - cell.height).max(0.0) / 2.0).max(0.0))
    }
}

fn cell_height(page_width: f32, page_height: f32, cell_width: f32) -> f32 {
    let ratio = if page_width.is_finite()
        && page_height.is_finite()
        && page_width > 0.0
        && page_height > 0.0
    {
        page_height / page_width
    } else {
        1.0
    };
    (cell_width * ratio).clamp(1.0, 100_000.0)
}

#[cfg(test)]
mod tests {
    use super::{GridLayout, MAX_CELLS};

    fn pages(n: usize) -> Vec<(f32, f32)> {
        vec![(100.0, 200.0); n]
    }

    #[test]
    fn pages_fill_rows_left_to_right_with_one_row_top_per_row() {
        // 3 cột, cell 100 px rộng, khoảng cách 10 px, trang 100x200 cao 200.
        let layout = GridLayout::new(&pages(7), 3, 100.0, 10.0);
        let c3 = layout.cell(3).unwrap();
        assert_eq!((c3.left, c3.top), (0.0, 210.0));
        let c5 = layout.cell(5).unwrap();
        assert_eq!((c5.left, c5.top), (220.0, 0.0 + 210.0));
        assert_eq!(layout.cell(6).unwrap().top, 420.0);
        assert_eq!(layout.total_height(), 420.0 + 200.0);
    }

    #[test]
    fn row_height_follows_its_tallest_cell_and_cells_keep_aspect_ratio() {
        let sizes = vec![(100.0, 100.0), (100.0, 300.0)];
        let layout = GridLayout::new(&sizes, 2, 100.0, 0.0);
        assert_eq!(layout.cell(0).unwrap().height, 100.0);
        assert_eq!(layout.cell(1).unwrap().height, 300.0);
        assert_eq!(layout.total_height(), 300.0);
    }

    #[test]
    fn columns_for_width_fits_as_many_cells_as_possible_and_never_zero() {
        assert_eq!(GridLayout::columns_for_width(800.0, 120.0, 8.0), 6);
        assert_eq!(GridLayout::columns_for_width(120.0, 120.0, 8.0), 1);
        assert_eq!(GridLayout::columns_for_width(10.0, 120.0, 8.0), 1);
        assert_eq!(GridLayout::columns_for_width(f32::NAN, 120.0, 8.0), 1);
    }

    #[test]
    fn visible_cells_return_only_rows_that_intersect_the_viewport() {
        let layout = GridLayout::new(&pages(12), 3, 100.0, 10.0);
        // Hàng 1 (trang 3..5) bắt đầu ở 210 và cao 200, nên viewport 220..300 chỉ chạm hàng 1.
        let indices: Vec<_> = layout
            .visible_cells(220.0, 80.0)
            .iter()
            .map(|c| c.page_index)
            .collect();
        assert_eq!(indices, vec![3, 4, 5]);
    }

    #[test]
    fn visible_cells_are_capped_for_a_thousand_page_document() {
        // 1000 hàng cao 200 px. Viewport 50 000..250 000 giao 750 hàng, vượt giới hạn.
        let layout = GridLayout::new(&vec![(100.0, 200.0); 1000], 1, 100.0, 0.0);
        let cells = layout.visible_cells(50_000.0, 200_000.0);
        assert_eq!(cells.len(), MAX_CELLS);
        assert!(
            cells
                .windows(2)
                .all(|pair| pair[0].page_index + 1 == pair[1].page_index)
        );
    }

    #[test]
    fn page_at_hits_the_cell_under_the_point_and_misses_gaps() {
        let layout = GridLayout::new(&pages(4), 2, 100.0, 10.0);
        assert_eq!(layout.page_at(50.0, 50.0), Some(0));
        assert_eq!(layout.page_at(150.0, 50.0), Some(1));
        assert_eq!(
            layout.page_at(105.0, 50.0),
            None,
            "khoảng cách giữa hai cột"
        );
        assert_eq!(
            layout.page_at(50.0, 205.0),
            None,
            "khoảng cách giữa hai hàng"
        );
        assert_eq!(layout.page_at(50.0, 999.0), None);
    }

    #[test]
    fn scroll_for_page_centers_its_row_and_never_goes_negative() {
        let layout = GridLayout::new(&pages(20), 2, 100.0, 10.0);
        assert_eq!(layout.scroll_for_page(0, 500.0), Some(0.0));
        // Hàng 5 ở top 1050; cell cao 200; viewport 500 → (1050 - 150) = 900.
        assert_eq!(layout.scroll_for_page(10, 500.0), Some(900.0));
        assert_eq!(layout.scroll_for_page(99, 500.0), None);
    }

    #[test]
    fn empty_document_has_no_cells_and_no_height() {
        let layout = GridLayout::new(&[], 3, 100.0, 10.0);
        assert_eq!(layout.total_height(), 0.0);
        assert!(layout.visible_cells(0.0, 800.0).is_empty());
        assert_eq!(layout.page_at(10.0, 10.0), None);
    }
}
