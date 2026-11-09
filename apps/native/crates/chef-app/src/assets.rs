//! Tài nguyên nhúng trong exe (TASKS_RUST R1.02): font và icon từ `apps/native/assets/`.
//! Danh sách sinh bởi build.rs; GPUI đọc qua `AssetSource` (svg và font).

use std::borrow::Cow;

use gpui::{App, AssetSource, Result, SharedString};

include!(concat!(env!("OUT_DIR"), "/assets.rs"));

/// Nạp mọi font TTF đã nhúng vào hệ thống font của GPUI (TASKS_RUST R1.13).
pub fn register_fonts(cx: &App) {
    let fonts: Vec<Cow<'static, [u8]>> = ASSETS
        .iter()
        .filter(|(p, _)| p.starts_with("fonts/") && p.ends_with(".ttf"))
        .map(|(_, bytes)| Cow::Borrowed(*bytes))
        .collect();
    cx.text_system()
        .add_fonts(fonts)
        .expect("nạp font nhúng thất bại");
}

/// Nguồn tài nguyên chỉ đọc từ bộ nhớ, không đọc đĩa lúc chạy.
pub struct Embedded;

impl AssetSource for Embedded {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        Ok(ASSETS
            .iter()
            .find(|(p, _)| *p == path)
            .map(|(_, bytes)| Cow::Borrowed(*bytes)))
    }

    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        Ok(ASSETS
            .iter()
            .filter(|(p, _)| p.starts_with(path))
            .map(|(p, _)| SharedString::from(*p))
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embeds_font_and_icon() {
        let font = Embedded
            .load("fonts/BeVietnamPro-Regular.ttf")
            .expect("load không lỗi")
            .expect("thiếu font đã nhúng");
        // TTF hợp lệ bắt đầu bằng 0x00010000 (hoặc 'true'/'OTTO' cho dạng khác).
        assert_eq!(&font[..4], &[0x00, 0x01, 0x00, 0x00]);
        let icon = Embedded
            .load("icons/check.svg")
            .expect("load không lỗi")
            .expect("thiếu icon đã nhúng");
        assert!(
            std::str::from_utf8(&icon)
                .expect("SVG là UTF-8")
                .contains("<svg")
        );
    }

    #[test]
    fn missing_asset_is_none() {
        assert!(
            Embedded
                .load("khong/co/file.svg")
                .expect("load không lỗi")
                .is_none()
        );
    }

    #[test]
    fn list_filters_by_prefix() {
        let icons = Embedded.list("icons/").expect("list không lỗi");
        assert!(icons.len() >= 153);
        assert!(icons.iter().all(|p| p.starts_with("icons/")));
    }
}
