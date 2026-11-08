// @generated bởi scripts/gen-native-theme.mjs từ apps/ui/src/app/styles/tokens.css.
// Không sửa tay. Sửa tokens.css rồi chạy: node scripts/gen-native-theme.mjs
#![allow(dead_code)]

/// Màu RGBA, mỗi kênh 0–255.
pub type Rgba = [u8; 4];

/// Token dùng chung cho mọi theme: font, cỡ chữ, khoảng cách, bo góc, kích thước, chuyển động.
pub mod shared {
    pub const FONT_SANS: &str =
        "\"Be Vietnam Pro\", system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif";
    pub const FONT_MONO: &str =
        "ui-monospace, \"SF Mono\", \"Cascadia Code\", Menlo, Consolas, monospace";
    pub const TEXT_XS: f32 = 11.0;
    pub const TEXT_SM: f32 = 12.0;
    pub const TEXT_MD: f32 = 13.0;
    pub const TEXT_LG: f32 = 15.0;
    pub const TEXT_XL: f32 = 18.0;
    pub const TEXT_2XL: f32 = 24.0;
    pub const TEXT_3XL: f32 = 30.0;
    pub const LEADING_TIGHT: f32 = 1.25;
    pub const LEADING_NORMAL: f32 = 1.5;
    pub const WEIGHT_REGULAR: f32 = 400.0;
    pub const WEIGHT_MEDIUM: f32 = 500.0;
    pub const WEIGHT_SEMIBOLD: f32 = 600.0;
    pub const SPACE_0: f32 = 0.0;
    pub const SPACE_1: f32 = 2.0;
    pub const SPACE_2: f32 = 4.0;
    pub const SPACE_3: f32 = 6.0;
    pub const SPACE_4: f32 = 8.0;
    pub const SPACE_5: f32 = 12.0;
    pub const SPACE_6: f32 = 16.0;
    pub const SPACE_7: f32 = 20.0;
    pub const SPACE_8: f32 = 24.0;
    pub const SPACE_9: f32 = 32.0;
    pub const SPACE_10: f32 = 40.0;
    pub const SPACE_11: f32 = 56.0;
    pub const RADIUS_XS: f32 = 3.0;
    pub const RADIUS_SM: f32 = 5.0;
    pub const RADIUS_MD: f32 = 7.0;
    pub const RADIUS_LG: f32 = 10.0;
    pub const RADIUS_XL: f32 = 14.0;
    pub const RADIUS_FULL: f32 = 999.0;
    pub const CONTROL_H_XS: f32 = 22.0;
    pub const CONTROL_H_SM: f32 = 26.0;
    pub const CONTROL_H: f32 = 32.0;
    pub const CONTROL_H_LG: f32 = 38.0;
    pub const TITLEBAR_H: f32 = 42.0;
    pub const TABSBAR_H: f32 = 38.0;
    pub const TOOLBAR_H: f32 = 46.0;
    pub const STATUSBAR_H: f32 = 28.0;
    pub const SIDEBAR_W: f32 = 216.0;
    pub const PANEL_W: f32 = 272.0;
    pub const EASE: &str = "cubic-bezier(0.2, 0, 0, 1)";
    pub const DUR_FAST: u32 = 100;
    pub const DUR: u32 = 160;
}

/// Màu và bóng theme sáng (`:root`).
pub mod light {
    use super::Rgba;
    pub const C_BG: Rgba = [244, 245, 247, 255];
    pub const C_CANVAS: Rgba = [233, 235, 239, 255];
    pub const C_SURFACE: Rgba = [255, 255, 255, 255];
    pub const C_SURFACE_2: Rgba = [248, 249, 251, 255];
    pub const C_SURFACE_SUNKEN: Rgba = [238, 240, 243, 255];
    pub const C_HOVER: Rgba = [20, 30, 50, 14];
    pub const C_ACTIVE: Rgba = [20, 30, 50, 26];
    pub const C_BORDER: Rgba = [225, 228, 234, 255];
    pub const C_BORDER_STRONG: Rgba = [205, 210, 218, 255];
    pub const C_DIVIDER: Rgba = [236, 238, 242, 255];
    pub const C_TEXT: Rgba = [29, 35, 48, 255];
    pub const C_TEXT_2: Rgba = [77, 85, 101, 255];
    pub const C_TEXT_3: Rgba = [125, 132, 148, 255];
    pub const C_TEXT_DISABLED: Rgba = [168, 174, 185, 255];
    pub const C_TEXT_ON_ACCENT: Rgba = [255, 255, 255, 255];
    pub const C_ACCENT: Rgba = [47, 107, 228, 255];
    pub const C_INVERSE_BG: Rgba = [34, 38, 47, 255];
    pub const C_INVERSE_TEXT: Rgba = [241, 243, 246, 255];
    pub const C_ACCENT_HOVER: Rgba = [37, 91, 208, 255];
    pub const C_ACCENT_ACTIVE: Rgba = [31, 79, 182, 255];
    pub const C_ACCENT_SOFT: Rgba = [232, 239, 253, 255];
    pub const C_ACCENT_SOFT_2: Rgba = [214, 227, 251, 255];
    pub const C_ACCENT_TEXT: Rgba = [31, 86, 199, 255];
    pub const C_BRAND: Rgba = [229, 83, 61, 255];
    pub const C_SUCCESS: Rgba = [31, 157, 97, 255];
    pub const C_SUCCESS_SOFT: Rgba = [227, 245, 236, 255];
    pub const C_WARNING: Rgba = [183, 121, 31, 255];
    pub const C_WARNING_SOFT: Rgba = [253, 243, 225, 255];
    pub const C_DANGER: Rgba = [217, 61, 61, 255];
    pub const C_DANGER_HOVER: Rgba = [197, 48, 48, 255];
    pub const C_DANGER_SOFT: Rgba = [253, 234, 234, 255];
    pub const C_FOCUS: Rgba = [47, 107, 228, 115];
    pub const C_OVERLAY: Rgba = [16, 22, 34, 97];
    pub const C_HIGHLIGHT: Rgba = [255, 196, 0, 107];
    pub const C_HIGHLIGHT_SELECTED: Rgba = [255, 128, 0, 140];
    pub const C_PAGE_SHADOW: &str =
        "0 1px 2px rgba(16, 24, 40, 0.1), 0 2px 8px rgba(16, 24, 40, 0.08)";
    pub const SHADOW_XS: &str = "0 1px 1px rgba(16, 24, 40, 0.05)";
    pub const SHADOW_SM: &str =
        "0 1px 2px rgba(16, 24, 40, 0.06), 0 1px 3px rgba(16, 24, 40, 0.06)";
    pub const SHADOW_MD: &str =
        "0 4px 12px rgba(16, 24, 40, 0.09), 0 1px 3px rgba(16, 24, 40, 0.06)";
    pub const SHADOW_LG: &str =
        "0 16px 40px rgba(16, 24, 40, 0.16), 0 2px 8px rgba(16, 24, 40, 0.08)";
    pub const FOCUS_RING: &str = "0 0 0 2px #ffffff, 0 0 0 4px rgba(47, 107, 228, 0.45)";
}

/// Màu và bóng theme tối (`:root[data-theme='dark']`, các token không ghi đè lấy từ sáng).
pub mod dark {
    use super::Rgba;
    pub const C_BG: Rgba = [21, 23, 28, 255];
    pub const C_CANVAS: Rgba = [15, 17, 20, 255];
    pub const C_SURFACE: Rgba = [29, 32, 39, 255];
    pub const C_SURFACE_2: Rgba = [34, 38, 46, 255];
    pub const C_SURFACE_SUNKEN: Rgba = [24, 26, 32, 255];
    pub const C_HOVER: Rgba = [255, 255, 255, 15];
    pub const C_ACTIVE: Rgba = [255, 255, 255, 28];
    pub const C_BORDER: Rgba = [45, 50, 60, 255];
    pub const C_BORDER_STRONG: Rgba = [59, 65, 77, 255];
    pub const C_DIVIDER: Rgba = [39, 43, 52, 255];
    pub const C_TEXT: Rgba = [231, 233, 238, 255];
    pub const C_TEXT_2: Rgba = [179, 184, 195, 255];
    pub const C_TEXT_3: Rgba = [133, 140, 153, 255];
    pub const C_TEXT_DISABLED: Rgba = [90, 96, 108, 255];
    pub const C_TEXT_ON_ACCENT: Rgba = [255, 255, 255, 255];
    pub const C_ACCENT: Rgba = [82, 136, 240, 255];
    pub const C_INVERSE_BG: Rgba = [231, 233, 238, 255];
    pub const C_INVERSE_TEXT: Rgba = [29, 32, 39, 255];
    pub const C_ACCENT_HOVER: Rgba = [101, 151, 243, 255];
    pub const C_ACCENT_ACTIVE: Rgba = [122, 166, 245, 255];
    pub const C_ACCENT_SOFT: Rgba = [82, 136, 240, 41];
    pub const C_ACCENT_SOFT_2: Rgba = [82, 136, 240, 66];
    pub const C_ACCENT_TEXT: Rgba = [143, 179, 247, 255];
    pub const C_BRAND: Rgba = [240, 106, 82, 255];
    pub const C_SUCCESS: Rgba = [60, 194, 130, 255];
    pub const C_SUCCESS_SOFT: Rgba = [60, 194, 130, 36];
    pub const C_WARNING: Rgba = [224, 164, 67, 255];
    pub const C_WARNING_SOFT: Rgba = [224, 164, 67, 36];
    pub const C_DANGER: Rgba = [240, 100, 100, 255];
    pub const C_DANGER_HOVER: Rgba = [243, 123, 123, 255];
    pub const C_DANGER_SOFT: Rgba = [240, 100, 100, 36];
    pub const C_FOCUS: Rgba = [82, 136, 240, 153];
    pub const C_OVERLAY: Rgba = [0, 0, 0, 140];
    pub const C_HIGHLIGHT: Rgba = [255, 196, 0, 97];
    pub const C_HIGHLIGHT_SELECTED: Rgba = [255, 128, 0, 153];
    pub const C_PAGE_SHADOW: &str = "0 1px 2px rgba(0, 0, 0, 0.4), 0 3px 10px rgba(0, 0, 0, 0.35)";
    pub const SHADOW_XS: &str = "0 1px 1px rgba(0, 0, 0, 0.3)";
    pub const SHADOW_SM: &str = "0 1px 2px rgba(0, 0, 0, 0.35)";
    pub const SHADOW_MD: &str = "0 6px 16px rgba(0, 0, 0, 0.4), 0 1px 3px rgba(0, 0, 0, 0.3)";
    pub const SHADOW_LG: &str = "0 18px 48px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.35)";
    pub const FOCUS_RING: &str = "0 0 0 2px #1d2027, 0 0 0 4px rgba(82, 136, 240, 0.6)";
}
