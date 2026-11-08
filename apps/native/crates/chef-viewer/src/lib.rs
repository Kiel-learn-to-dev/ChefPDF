//! Viewer PDF: hình học cuộn, cache theo MB, và trạng thái trang (TASKS_RUST M1.4).
//! Phần vẽ nằm trong chef-app; crate này không phụ thuộc GPUI để kiểm thử được riêng.

pub mod cache;
pub mod scroll;

#[cfg(test)]
mod tests {
    use crate::cache::LruCache;
    use crate::scroll::Layout;

    fn a4_pages(n: usize) -> Vec<(f32, f32)> {
        vec![(595.0, 842.0); n]
    }

    #[test]
    fn layout_tops_include_gap_and_total_has_no_trailing_gap() {
        let l = Layout::new(a4_pages(3), 10.0, 1.0);
        assert_eq!(l.page_top(0), 0.0);
        assert_eq!(l.page_top(1), 842.0 + 10.0);
        assert_eq!(l.page_top(2), 2.0 * (842.0 + 10.0));
        assert_eq!(l.total_height(), 3.0 * 842.0 + 2.0 * 10.0);
    }

    #[test]
    fn visible_pages_match_the_viewport() {
        let l = Layout::new(a4_pages(100), 10.0, 1.0);
        // Vùng nhìn 0..600 chỉ chạm trang 0.
        assert_eq!(l.visible(0.0, 600.0), 0..=0);
        // Vùng nhìn đúng ở chỗ trang 1 bắt đầu (852): trang 0 đã qua, nằm ở trang 1.
        assert_eq!(l.visible(852.0, 600.0), 1..=1);
        // Vùng nhìn cắt qua khe giữa trang 0 và 1: chạm cả hai.
        assert_eq!(l.visible(800.0, 100.0), 0..=1);
    }

    #[test]
    fn full_scale_set_adds_one_page_each_side_and_clamps_at_ends() {
        let l = Layout::new(a4_pages(10), 10.0, 1.0);
        assert_eq!(l.full_scale_set(4.0 * 852.0, 600.0, 1), 3..=5);
        assert_eq!(l.full_scale_set(0.0, 100.0, 1), 0..=1);
        assert_eq!(l.full_scale_set(9.0 * 852.0, 2000.0, 1), 8..=9);
    }

    #[test]
    fn scroll_is_clamped_to_content() {
        let l = Layout::new(a4_pages(2), 10.0, 1.0);
        let max = l.total_height() - 500.0;
        assert_eq!(l.clamp_scroll(-50.0, 500.0), 0.0);
        assert_eq!(l.clamp_scroll(1e9, 500.0), max);
        // Nội dung ngắn hơn vùng nhìn: không cuộn.
        assert_eq!(l.clamp_scroll(100.0, 10_000.0), 0.0);
    }

    #[test]
    fn fit_width_uses_the_widest_page_and_margins() {
        let l = Layout::new(vec![(595.0, 842.0), (842.0, 595.0)], 10.0, 1.0);
        let z = l.fit_width_zoom(1000.0, 20.0);
        assert!((z - 960.0 / 842.0).abs() < 1e-6);
    }

    #[test]
    fn lru_evicts_least_recently_used_by_bytes() {
        let mut c: LruCache<u32, &str> = LruCache::new(100);
        assert!(c.insert(1, "a", 40).is_empty());
        assert!(c.insert(2, "b", 40).is_empty());
        // Đụng mục 1 để mục 2 thành cũ nhất.
        assert_eq!(c.get(&1), Some(&"a"));
        let evicted = c.insert(3, "c", 40);
        assert_eq!(evicted, vec!["b"]);
        assert!(c.contains(&1) && c.contains(&3) && !c.contains(&2));
        assert!(c.total_bytes() <= c.budget());
    }

    #[test]
    fn lru_never_exceeds_budget_except_for_one_oversized_item() {
        let mut c: LruCache<u32, u8> = LruCache::new(100);
        for i in 0..50 {
            c.insert(i, 0, 30);
            assert!(c.total_bytes() <= 100 || c.len() == 1);
        }
        // Trước đó cache giữ đúng 3 mục 30 byte (90 ≤ 100). Mục 500 byte bỏ cả ba, còn lại chính nó.
        assert_eq!(c.len(), 3);
        let evicted = c.insert(999, 1, 500);
        assert_eq!(evicted.len(), 3);
        assert_eq!(c.len(), 1);
        assert!(c.contains(&999));
    }

    #[test]
    fn lru_replacing_a_key_returns_the_old_value_and_fixes_bytes() {
        let mut c: LruCache<u32, &str> = LruCache::new(1000);
        c.insert(1, "old", 300);
        let evicted = c.insert(1, "new", 200);
        assert_eq!(evicted, vec!["old"]);
        assert_eq!(c.total_bytes(), 200);
        assert_eq!(c.get(&1), Some(&"new"));
    }

    #[test]
    fn lowering_the_budget_evicts_oldest_first() {
        let mut c: LruCache<u32, u32> = LruCache::new(1000);
        for i in 0..5 {
            c.insert(i, i, 100);
        }
        let evicted = c.set_budget(250);
        assert_eq!(evicted, vec![0, 1, 2]);
        assert_eq!(c.total_bytes(), 200);
    }
}
