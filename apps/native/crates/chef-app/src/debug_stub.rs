//! Debug pipe is Windows-only. Keep viewer instrumentation calls portable and inert elsewhere.

#[allow(dead_code)]
pub const ACTION_NAMES: &[&str] = &[];

#[allow(dead_code)]
pub struct ViewSnapshot {
    pub zoom: f32,
    pub scroll_y: f32,
    pub viewport_h: f32,
    pub fit_width: bool,
    pub first_page: usize,
    pub kind: &'static str,
    pub mode: &'static str,
    pub visible_pages: Vec<usize>,
    pub fullscreen: bool,
    pub fit_page: bool,
    pub rotation: u8,
}

#[allow(dead_code)]
pub fn start(_hwnd: isize) -> Result<(), String> {
    Ok(())
}

pub fn render_timer() {}
pub fn count_render() {}
pub fn set_tabs(_: serde_json::Value) {}
pub fn set_start_recents(_: Vec<String>) {}
pub fn set_tab_message(_: Option<&str>) {}
pub fn set_file_dialog_request(_: serde_json::Value) {}
pub fn set_palette_state(_: serde_json::Value) {}
pub fn set_theme_dark(_: bool) {}
pub fn set_viewer_stats(_: usize, _: usize, _: usize) {}
pub fn set_viewer_cache_images(_: impl IntoIterator<Item = (usize, usize)>) {}
pub fn set_cache_invalidation(_: serde_json::Value) {}
pub fn set_source_warning(_: Option<(&str, &str)>) {}
pub fn set_sidebar_thumbnail_count(_: usize) {}
pub fn set_sidebar_state(_: bool, _: usize) {}
pub fn take_actions() -> Vec<String> {
    Vec::new()
}
pub fn take_scroll_screens() -> Vec<f32> {
    Vec::new()
}
pub fn set_scroll_progress(_: u32, _: u32, _: bool) {}
pub fn set_night(_: bool) {}
pub fn set_view(_: ViewSnapshot) {}
pub fn set_find(_: &str, _: usize, _: Option<usize>, _: bool) {}
pub fn set_input(_: &str, _: std::ops::Range<usize>, _: bool) {}
pub fn set_password(_: bool, _: bool, _: bool, _: bool, _: bool) {}
pub fn set_properties(_: Option<serde_json::Value>) {}
pub fn set_message(_: Option<&str>) {}
pub fn set_settings(_: &str, _: &str, _: Option<&str>, _: bool) {}
