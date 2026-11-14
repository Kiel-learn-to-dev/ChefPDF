//! Geometry for continuous, two-page, book, and slideshow viewing.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum PageMode {
    #[default]
    Continuous,
    TwoPage,
    Book,
    Slideshow,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageRect {
    pub page: usize,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub row: usize,
}

#[derive(Debug, Clone, PartialEq)]
struct Row {
    pages: Vec<usize>,
    top: f32,
    height: f32,
    width: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SpreadLayout {
    mode: PageMode,
    sizes: Vec<(f32, f32)>,
    zoom: f32,
    gap_y: f32,
    gap_x: f32,
    rows: Vec<Row>,
}

impl SpreadLayout {
    pub fn new(sizes: Vec<(f32, f32)>, mode: PageMode, gap_y: f32, gap_x: f32, zoom: f32) -> Self {
        let mut this = Self {
            mode,
            sizes,
            zoom: zoom.max(0.01),
            gap_y,
            gap_x,
            rows: Vec::new(),
        };
        this.rebuild();
        this
    }
    pub fn mode(&self) -> PageMode {
        self.mode
    }
    pub fn set_mode(&mut self, mode: PageMode) {
        self.mode = mode;
        self.rebuild();
    }
    pub fn set_zoom(&mut self, zoom: f32) {
        self.zoom = zoom.max(0.01);
        self.rebuild();
    }
    pub fn zoom(&self) -> f32 {
        self.zoom
    }
    pub fn page_count(&self) -> usize {
        self.sizes.len()
    }
    pub fn page_px(&self, page: usize) -> (f32, f32) {
        let (w, h) = self.sizes[page];
        (w * self.zoom, h * self.zoom)
    }
    fn rebuild(&mut self) {
        self.rows.clear();
        let mut i = 0;
        let mut top = 0.0;
        while i < self.sizes.len() {
            let count = match self.mode {
                PageMode::Continuous | PageMode::Slideshow => 1,
                PageMode::TwoPage => 2,
                PageMode::Book if i == 0 => 1,
                PageMode::Book => 2,
            };
            let end = (i + count).min(self.sizes.len());
            let pages = (i..end).collect::<Vec<_>>();
            let height = pages
                .iter()
                .map(|&p| self.sizes[p].1 * self.zoom)
                .fold(0.0, f32::max);
            let width = pages
                .iter()
                .map(|&p| self.sizes[p].0 * self.zoom)
                .sum::<f32>()
                + self.gap_x * ((pages.len().saturating_sub(1)) as f32);
            self.rows.push(Row {
                pages,
                top,
                height,
                width,
            });
            top += height + self.gap_y;
            i = end;
        }
    }
    pub fn total_height(&self) -> f32 {
        self.rows.last().map_or(0.0, |r| r.top + r.height)
    }
    pub fn clamp_scroll(&self, scroll: f32, viewport: f32) -> f32 {
        scroll
            .max(0.0)
            .min((self.total_height() - viewport).max(0.0))
    }
    pub fn row_for_page(&self, page: usize) -> Option<usize> {
        self.rows.iter().position(|r| r.pages.contains(&page))
    }
    pub fn row_top_for_page(&self, page: usize) -> Option<f32> {
        self.row_for_page(page).map(|r| self.rows[r].top)
    }
    pub fn row_height_for_page(&self, page: usize) -> Option<f32> {
        self.row_for_page(page).map(|r| self.rows[r].height)
    }
    pub fn first_page_in_row(&self, page: usize) -> Option<usize> {
        let row = self.row_for_page(page)?;
        self.rows[row].pages.first().copied()
    }
    pub fn page_rect(&self, page: usize, viewport_w: f32) -> Option<PageRect> {
        let row = self.row_for_page(page)?;
        let r = &self.rows[row];
        let mut x = ((viewport_w - r.width) / 2.0).max(0.0);
        for &p in &r.pages {
            let (w, h) = self.page_px(p);
            if p == page {
                return Some(PageRect {
                    page,
                    x,
                    y: r.top + (r.height - h) / 2.0,
                    width: w,
                    height: h,
                    row,
                });
            }
            x += w + self.gap_x;
        }
        None
    }
    pub fn visible_pages(&self, scroll: f32, viewport: f32) -> Vec<usize> {
        if self.mode == PageMode::Slideshow {
            return self
                .rows
                .iter()
                .min_by(|a, b| {
                    (a.top - scroll.max(0.0))
                        .abs()
                        .total_cmp(&(b.top - scroll.max(0.0)).abs())
                })
                .and_then(|r| r.pages.first().copied())
                .into_iter()
                .collect();
        }
        let top = scroll.max(0.0);
        let bottom = top + viewport.max(0.0);
        self.rows
            .iter()
            .filter(|r| r.top + r.height >= top && r.top <= bottom)
            .flat_map(|r| r.pages.iter().copied())
            .collect()
    }
    pub fn buffered_pages(&self, scroll: f32, viewport: f32, buffer_rows: usize) -> Vec<usize> {
        let visible = self.visible_pages(scroll, viewport);
        if visible.is_empty() {
            return vec![];
        }
        let first = self
            .row_for_page(visible[0])
            .unwrap_or(0)
            .saturating_sub(buffer_rows);
        let last = (self.row_for_page(*visible.last().unwrap()).unwrap_or(0) + buffer_rows)
            .min(self.rows.len() - 1);
        self.rows[first..=last]
            .iter()
            .flat_map(|r| r.pages.iter().copied())
            .collect()
    }
    pub fn fit_width_zoom(&self, viewport_w: f32, margin: f32) -> f32 {
        let (width_points, page_gaps) = self
            .rows
            .iter()
            .map(|r| {
                (
                    r.pages.iter().map(|&p| self.sizes[p].0).sum::<f32>(),
                    r.pages.len().saturating_sub(1),
                )
            })
            .max_by(|a, b| {
                (a.0 + a.1 as f32 * self.gap_x / self.zoom)
                    .total_cmp(&(b.0 + b.1 as f32 * self.gap_x / self.zoom))
            })
            .unwrap_or((0.0, 0));
        if width_points <= 0.0 {
            1.0
        } else {
            (viewport_w - 2.0 * margin - page_gaps as f32 * self.gap_x).max(1.0) / width_points
        }
    }
    pub fn fit_page_zoom(&self, page: usize, viewport_w: f32, viewport_h: f32, margin: f32) -> f32 {
        let Some(&(w, h)) = self.sizes.get(page) else {
            return 1.0;
        };
        ((viewport_w - 2.0 * margin).max(1.0) / w).min((viewport_h - 2.0 * margin).max(1.0) / h)
    }
    pub fn page_scroll(&self, page: usize) -> Option<f32> {
        self.row_top_for_page(page)
    }
    pub fn adjacent_page(&self, page: usize, delta: isize) -> Option<usize> {
        if self.sizes.is_empty() {
            return None;
        }
        Some(page.saturating_add_signed(delta).min(self.sizes.len() - 1))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sizes(n: usize) -> Vec<(f32, f32)> {
        vec![(100.0, 200.0); n]
    }
    #[test]
    fn groups_modes_and_keeps_book_cover_alone() {
        let two = SpreadLayout::new(sizes(5), PageMode::TwoPage, 10.0, 8.0, 1.0);
        assert_eq!(two.visible_pages(0.0, 200.0), vec![0, 1]);
        let book = SpreadLayout::new(sizes(5), PageMode::Book, 10.0, 8.0, 1.0);
        assert_eq!(book.visible_pages(0.0, 200.0), vec![0]);
        assert_eq!(book.row_top_for_page(1), Some(210.0));
        assert_eq!(book.visible_pages(210.0, 200.0), vec![1, 2]);
    }
    #[test]
    fn centers_and_fits_spreads_and_single_page_slides() {
        let l = SpreadLayout::new(
            vec![(100.0, 200.0), (120.0, 100.0)],
            PageMode::TwoPage,
            10.0,
            8.0,
            1.0,
        );
        assert_eq!(l.page_rect(0, 300.0).unwrap().x, 36.0);
        assert_eq!(l.page_rect(1, 300.0).unwrap().y, 50.0);
        let fit = l.fit_width_zoom(300.0, 10.0);
        assert!((fit - 272.0 / 220.0).abs() < 1e-5);
        let mut fitted = l.clone();
        fitted.set_zoom(fit);
        let left = fitted.page_rect(0, 300.0).unwrap();
        let right = fitted.page_rect(1, 300.0).unwrap();
        assert!((left.x - 10.0).abs() < 1e-5);
        assert!((right.x + right.width - 290.0).abs() < 1e-5);
        let slide = SpreadLayout::new(sizes(4), PageMode::Slideshow, 10.0, 8.0, 1.0);
        assert_eq!(slide.visible_pages(0.0, 900.0), vec![0]);
        assert_eq!(slide.adjacent_page(2, 1), Some(3));
    }
}
