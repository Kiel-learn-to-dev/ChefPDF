//! Giảm chuyển động (TASKS_RUST R2.10, BLUEPRINT_RUST §6.7): tương đương `prefers-reduced-motion`
//! của bản Electron (components.css, cuối file).
//!
//! Nguồn là cài đặt "Hiện hoạt ảnh trong Windows" (SPI_GETCLIENTAREAANIMATION). Biến môi trường
//! `CHEF_E2E_REDUCED_MOTION=1|0` ghi đè để E2E kiểm được cả hai đường; người dùng thường không đặt.

/// Biến môi trường ghi đè, chỉ để E2E.
pub const ENV_OVERRIDE: &str = "CHEF_E2E_REDUCED_MOTION";

/// `true` khi phải bỏ hoạt ảnh. Gọi mỗi lần dựng hộp thoại nên đổi cài đặt Windows có hiệu lực ngay.
pub fn reduced() -> bool {
    let env = std::env::var(ENV_OVERRIDE).ok();
    parse_override(env.as_deref()).unwrap_or_else(|| !system_animations_enabled())
}

/// Đọc giá trị ghi đè: `1` là giảm, `0` là không giảm, giá trị khác là không ghi đè.
pub fn parse_override(value: Option<&str>) -> Option<bool> {
    match value? {
        "1" => Some(true),
        "0" => Some(false),
        _ => None,
    }
}

#[cfg(windows)]
fn system_animations_enabled() -> bool {
    use std::ffi::c_void;

    const SPI_GETCLIENTAREAANIMATION: u32 = 0x1042;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn SystemParametersInfoW(action: u32, param: u32, pv: *mut c_void, win_ini: u32) -> i32;
    }

    let mut enabled: i32 = 1;
    // SAFETY: pv trỏ tới một BOOL (i32) còn sống trong suốt lời gọi.
    let ok = unsafe {
        SystemParametersInfoW(
            SPI_GETCLIENTAREAANIMATION,
            0,
            (&mut enabled as *mut i32).cast(),
            0,
        )
    };
    // Lỗi thì coi như bật hoạt ảnh (mặc định của Windows).
    ok == 0 || enabled != 0
}

#[cfg(not(windows))]
fn system_animations_enabled() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::parse_override;

    #[test]
    fn override_reads_only_one_and_zero() {
        assert_eq!(parse_override(Some("1")), Some(true));
        assert_eq!(parse_override(Some("0")), Some(false));
        assert_eq!(parse_override(Some("yes")), None);
        assert_eq!(parse_override(Some("")), None);
        assert_eq!(parse_override(None), None);
    }
}
