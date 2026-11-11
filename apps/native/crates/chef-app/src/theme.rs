//! Chọn theme sáng hoặc tối cho cửa sổ (TASKS_RUST R1.12).
//!
//! Màu lấy từ chef_theme (sinh từ tokens.css, không viết tay). Chế độ hệ thống đọc
//! `AppsUseLightTheme` trong registry, giống cài đặt `system` của bản Electron (app/theme.ts).

use chef_theme::Rgba;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Light,
    Dark,
    System,
}

/// Đọc `CHEF_THEME` (light, dark, system). Mặc định là system.
pub fn mode_from_env() -> Mode {
    match std::env::var("CHEF_THEME").as_deref() {
        Ok("light") => Mode::Light,
        Ok("dark") => Mode::Dark,
        _ => Mode::System,
    }
}

/// Chế độ theo cài đặt `theme` (settings.json). Biến `CHEF_THEME` nếu có thì ưu tiên (E2E).
pub fn effective_mode(setting: crate::settings::Theme) -> Mode {
    if std::env::var_os("CHEF_THEME").is_some() {
        return mode_from_env();
    }
    match setting {
        crate::settings::Theme::System => Mode::System,
        crate::settings::Theme::Light => Mode::Light,
        crate::settings::Theme::Dark => Mode::Dark,
    }
}

/// Theme tối đang được chọn? Với System, hỏi hệ điều hành.
pub fn is_dark(mode: Mode) -> bool {
    match mode {
        Mode::Light => false,
        Mode::Dark => true,
        Mode::System => system_uses_dark(),
    }
}

/// `AppsUseLightTheme` = 0 nghĩa là Windows đang dùng chế độ tối cho ứng dụng.
pub fn system_uses_dark() -> bool {
    use std::ffi::c_void;
    const HKEY_CURRENT_USER: isize = 0x8000_0001u32 as i32 as isize;
    const RRF_RT_REG_DWORD: u32 = 0x0000_0010;

    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegGetValueW(
            key: isize,
            sub_key: *const u16,
            value: *const u16,
            flags: u32,
            kind: *mut u32,
            data: *mut c_void,
            data_len: *mut u32,
        ) -> i32;
    }
    let sub: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let value: Vec<u16> = "AppsUseLightTheme"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut data: u32 = 1;
    let mut len: u32 = 4;
    // SAFETY: các chuỗi kết thúc bằng 0 còn sống trong lời gọi; data đủ 4 byte cho DWORD.
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            sub.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            &mut data as *mut u32 as *mut c_void,
            &mut len,
        )
    };
    // Không đọc được thì coi như sáng (mặc định của Windows).
    status == 0 && data == 0
}

/// Màu của một Rgba theo dạng 0xRRGGBB để dùng với gpui::rgb.
pub fn hex(c: Rgba) -> u32 {
    ((c[0] as u32) << 16) | ((c[1] as u32) << 8) | (c[2] as u32)
}

/// Màu chữ đã chọn: màu nhấn với alpha 0x55 (khoảng 33%).
fn accent_selection(accent: Rgba) -> u32 {
    rgba_hex([accent[0], accent[1], accent[2], 0x55])
}

/// Màu có alpha dạng RRGGBBAA cho gpui::rgba.
pub fn rgba_hex(c: Rgba) -> u32 {
    ((c[0] as u32) << 24) | ((c[1] as u32) << 16) | ((c[2] as u32) << 8) | (c[3] as u32)
}

/// Bảng màu đang dùng cho cửa sổ viewer.
#[derive(Debug, Clone, Copy)]
pub struct Palette {
    pub canvas: u32,
    pub surface: u32,
    pub border: u32,
    pub text: u32,
    pub text_2: u32,
    /// Tô sáng khớp tìm kiếm và khớp đang chọn, dạng RRGGBBAA (gpui::rgba).
    pub highlight: u32,
    pub highlight_selected: u32,
    /// Chữ đã chọn trong trang: màu nhấn của theme với alpha thấp.
    pub selection: u32,
}

pub fn palette(dark: bool) -> Palette {
    if dark {
        Palette {
            canvas: hex(chef_theme::dark::C_CANVAS),
            surface: hex(chef_theme::dark::C_SURFACE),
            border: hex(chef_theme::dark::C_BORDER),
            text: hex(chef_theme::dark::C_TEXT),
            text_2: hex(chef_theme::dark::C_TEXT_2),
            highlight: rgba_hex(chef_theme::dark::C_HIGHLIGHT),
            highlight_selected: rgba_hex(chef_theme::dark::C_HIGHLIGHT_SELECTED),
            selection: accent_selection(chef_theme::dark::C_ACCENT),
        }
    } else {
        Palette {
            canvas: hex(chef_theme::light::C_CANVAS),
            surface: hex(chef_theme::light::C_SURFACE),
            border: hex(chef_theme::light::C_BORDER),
            text: hex(chef_theme::light::C_TEXT),
            text_2: hex(chef_theme::light::C_TEXT_2),
            highlight: rgba_hex(chef_theme::light::C_HIGHLIGHT),
            highlight_selected: rgba_hex(chef_theme::light::C_HIGHLIGHT_SELECTED),
            selection: accent_selection(chef_theme::light::C_ACCENT),
        }
    }
}
