//! Hình học cuộn của viewer (TASKS_RUST R1.32). Thuần Rust, không phụ thuộc GPUI.
//!
//! Đơn vị: pixel logic. Trang xếp dọc, cách nhau `gap`. `zoom` là số pixel logic trên mỗi point PDF.

use std::ops::RangeInclusive;

#[derive(Debug, Clone, PartialEq)]
pub struct Layout {
    /// Kích thước mỗi trang tính bằng point (1/72 inch): (rộng, cao).
    sizes_pt: Vec<(f32, f32)>,
    gap: f32,
    zoom: f32,
    /// Tọa độ đỉnh trên và đáy của từng trang, theo pixel logic (đã tính với zoom và gap).
    tops: Vec<f32>,
    bottoms: Vec<f32>,
}

impl Layout {
    pub fn new(sizes_pt: Vec<(f32, f32)>, gap: f32, zoom: f32) -> Self {
        let mut layout = Layout {
            sizes_pt,
            gap,
            zoom,
            tops: Vec::new(),
            bottoms: Vec::new(),
        };
        layout.rebuild();
        layout
    }

    fn rebuild(&mut self) {
        self.tops.clear();
        self.bottoms.clear();
        let mut y = 0.0_f32;
        for &(_, h) in &self.sizes_pt {
            let bottom = y + h * self.zoom;
            self.tops.push(y);
            self.bottoms.push(bottom);
            y = bottom + self.gap;
        }
    }

    pub fn page_count(&self) -> usize {
        self.sizes_pt.len()
    }

    pub fn zoom(&self) -> f32 {
        self.zoom
    }

    pub fn set_zoom(&mut self, zoom: f32) {
        self.zoom = zoom.max(0.01);
        self.rebuild();
    }

    /// Kích thước trang theo pixel logic ở zoom hiện tại: (rộng, cao).
    pub fn page_px(&self, index: usize) -> (f32, f32) {
        let (w, h) = self.sizes_pt[index];
        (w * self.zoom, h * self.zoom)
    }

    pub fn page_top(&self, index: usize) -> f32 {
        self.tops[index]
    }

    /// Tổng chiều cao nội dung, không tính khoảng cách sau trang cuối.
    pub fn total_height(&self) -> f32 {
        self.bottoms.last().copied().unwrap_or(0.0)
    }

    /// Các trang giao với vùng nhìn [scroll_y, scroll_y + viewport_h]. Rỗng nếu không có trang.
    pub fn visible(&self, scroll_y: f32, viewport_h: f32) -> RangeInclusive<usize> {
        if self.sizes_pt.is_empty() {
            // Khoảng rỗng có chủ đích (không có trang nào).
            return RangeInclusive::new(1, 0);
        }
        let top = scroll_y.max(0.0);
        let bottom = top + viewport_h.max(0.0);
        // Trang đầu tiên có đáy nằm ngoài phía trên vùng nhìn.
        let first = self
            .bottoms
            .partition_point(|&b| b < top)
            .min(self.sizes_pt.len() - 1);
        // Trang cuối cùng có đỉnh nằm phía trên đáy vùng nhìn.
        let last = self
            .tops
            .partition_point(|&t| t <= bottom)
            .saturating_sub(1)
            .max(first);
        first..=last
    }

    /// Vùng cần giữ bitmap đầy đủ: các trang nhìn thấy, mở rộng `buffer` trang mỗi bên (R2).
    pub fn full_scale_set(
        &self,
        scroll_y: f32,
        viewport_h: f32,
        buffer: usize,
    ) -> RangeInclusive<usize> {
        let v = self.visible(scroll_y, viewport_h);
        if v.is_empty() {
            return v;
        }
        let first = v.start().saturating_sub(buffer);
        let last = (*v.end() + buffer).min(self.sizes_pt.len() - 1);
        first..=last
    }

    /// Giới hạn cuộn trong [0, tổng cao - vùng nhìn].
    pub fn clamp_scroll(&self, scroll_y: f32, viewport_h: f32) -> f32 {
        let max = (self.total_height() - viewport_h).max(0.0);
        scroll_y.clamp(0.0, max)
    }

    /// Zoom để trang rộng nhất vừa chiều rộng vùng nhìn trừ lề hai bên.
    pub fn fit_width_zoom(&self, viewport_w: f32, margin: f32) -> f32 {
        let widest = self
            .sizes_pt
            .iter()
            .map(|&(w, _)| w)
            .fold(0.0_f32, f32::max);
        if widest <= 0.0 {
            return 1.0;
        }
        ((viewport_w - 2.0 * margin).max(1.0)) / widest
    }
}
