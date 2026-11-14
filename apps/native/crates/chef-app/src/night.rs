//! Đọc ban đêm: đảo màu trang như `invert(1) hue-rotate(180deg)` của bản Electron
//! (apps/ui/src/features/viewer/Viewer.css, TASKS_RUST R2.28). Biến đổi tại chỗ, không tạo bộ nhớ mới.

use chef_viewer::cache::LruCache;
use std::hash::Hash;

/// Ma trận hue-rotate(180deg) theo công thức CSS Filter Effects (cos = -1, sin = 0).
const HUE_ROTATE_180: [[f32; 3]; 3] = [
    [-0.574, 1.430, 0.144],
    [0.426, 0.430, 0.144],
    [0.426, 1.430, -0.856],
];

/// Đảo màu từng pixel BGRA (từ trên xuống). Alpha giữ nguyên.
pub fn invert_bgra(bgra: &mut [u8]) {
    for px in bgra.chunks_exact_mut(4) {
        // Thứ tự kênh trong bộ nhớ là B, G, R, A. Đổi về R, G, B để nhân ma trận.
        let inv = [
            1.0 - px[2] as f32 / 255.0,
            1.0 - px[1] as f32 / 255.0,
            1.0 - px[0] as f32 / 255.0,
        ];
        let mut out = [0.0f32; 3];
        for (o, row) in out.iter_mut().zip(HUE_ROTATE_180.iter()) {
            *o = row[0] * inv[0] + row[1] * inv[1] + row[2] * inv[2];
        }
        px[2] = to_byte(out[0]);
        px[1] = to_byte(out[1]);
        px[0] = to_byte(out[2]);
    }
}

/// Evict cached page images when switching the pixel transform; returned values are handed to GPUI
/// for explicit texture release by the caller.
pub fn evict_cached_pages<K, V>(cache: &mut LruCache<K, V>) -> Vec<V>
where
    K: Eq + Hash + Clone,
{
    cache
        .keys()
        .into_iter()
        .filter_map(|key| cache.remove(&key))
        .collect()
}

fn to_byte(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

#[cfg(test)]
mod tests {
    use super::{evict_cached_pages, invert_bgra};
    use chef_viewer::cache::LruCache;

    #[test]
    fn white_page_becomes_black_and_black_becomes_white() {
        let mut px = [255, 255, 255, 255, 0, 0, 0, 255];
        invert_bgra(&mut px);
        assert_eq!(&px[0..4], &[0, 0, 0, 255]);
        assert_eq!(&px[4..8], &[255, 255, 255, 255]);
    }

    #[test]
    fn alpha_is_untouched() {
        let mut px = [10, 20, 30, 77];
        invert_bgra(&mut px);
        assert_eq!(px[3], 77);
    }

    #[test]
    fn representative_colors_match_invert_then_hue_rotate_180_css_filter() {
        // CSS `invert(1) hue-rotate(180deg)`, input/output byte order BGRA.
        let mut px = [64, 128, 192, 77, 17, 90, 210, 211];
        invert_bgra(&mut px);
        assert_eq!(&px, &[45, 109, 173, 77, 51, 124, 244, 211]);
    }

    #[test]
    fn night_inversion_does_not_allocate_a_replacement_pixel_buffer() {
        let mut px = vec![64, 128, 192, 77, 17, 90, 210, 211];
        let capacity = px.capacity();
        invert_bgra(&mut px);
        assert_eq!(px.capacity(), capacity);
    }

    #[test]
    fn switching_night_mode_evicts_all_cached_page_images() {
        let mut cache = LruCache::new(1024);
        cache.insert(1, "first", 10);
        cache.insert(2, "second", 10);
        let released = evict_cached_pages(&mut cache);
        assert!(cache.is_empty());
        assert_eq!(cache.total_bytes(), 0);
        assert_eq!(released.len(), 2);
        assert!(released.contains(&"first") && released.contains(&"second"));
    }

    #[test]
    fn twice_is_close_to_identity_for_greys() {
        // Với màu xám, đảo hai lần đưa về gần như cũ (sai số làm tròn vài đơn vị).
        let mut px = [90, 90, 90, 255];
        invert_bgra(&mut px);
        invert_bgra(&mut px);
        for c in &px[0..3] {
            assert!((*c as i32 - 90).abs() <= 3, "kênh {c}");
        }
    }
}
