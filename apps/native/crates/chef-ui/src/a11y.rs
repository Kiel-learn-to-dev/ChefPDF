//! Danh sách điều khiển của khung vẽ gần nhất, cho kênh debug và E2E (D81).
//!
//! GPUI không có cây truy cập, nên trình đọc màn hình không đọc được điều khiển. Thay thế: mọi
//! điều khiển phải có tên (nhãn) khi vẽ, và mỗi điều khiển đăng ký vai trò, tên, trạng thái và vị
//! trí vào đây. Lệnh `state` của kênh debug đọc danh sách này để E2E tìm điều khiển theo `id`.

use std::sync::{Mutex, MutexGuard};

use gpui::{Bounds, ElementId, Pixels};

/// Một điều khiển đã vẽ trong khung gần nhất.
#[derive(Clone, Debug, PartialEq)]
pub struct Registered {
    pub id: String,
    /// Vai trò như ARIA: `button`, `checkbox`, `switch`, `textbox`.
    pub role: &'static str,
    /// Tên truy cập: nhãn, hoặc aria_label khi điều khiển chỉ có icon.
    pub name: String,
    pub disabled: bool,
    pub focused: bool,
    pub hovered: bool,
    /// Trạng thái bật/tắt: `true`, `false`, hoặc `mixed` (checkbox không xác định).
    pub checked: Option<&'static str>,
    /// Nội dung của ô nhập; `None` cho điều khiển khác.
    pub value: Option<String>,
    /// x, y, rộng, cao theo pixel logic trong khung cửa sổ. Chưa có khi chưa được đặt.
    pub bounds: Option<[f32; 4]>,
}

struct Frame {
    scale: f32,
    controls: Vec<Registered>,
}

static FRAME: Mutex<Frame> = Mutex::new(Frame {
    scale: 1.0,
    controls: Vec::new(),
});

fn frame() -> MutexGuard<'static, Frame> {
    FRAME.lock().unwrap_or_else(|e| e.into_inner())
}

/// Bắt đầu một khung vẽ: xóa danh sách. Gọi đầu `render` của view gốc có điều khiển.
pub fn begin_frame(scale: f32) {
    let mut f = frame();
    f.scale = scale;
    f.controls.clear();
}

/// Tỉ lệ hiển thị và các điều khiển của khung gần nhất.
pub fn snapshot() -> (f32, Vec<Registered>) {
    let f = frame();
    (f.scale, f.controls.clone())
}

pub fn register(entry: Registered) {
    frame().controls.push(entry);
}

/// Đặt vị trí cho điều khiển `id`, khi layout và prepaint xong.
pub fn set_bounds(id: &str, bounds: Bounds<Pixels>) {
    let mut f = frame();
    if let Some(entry) = f.controls.iter_mut().find(|c| c.id == id) {
        entry.bounds = Some([
            f32::from(bounds.origin.x),
            f32::from(bounds.origin.y),
            f32::from(bounds.size.width),
            f32::from(bounds.size.height),
        ]);
    }
}

/// Chữ của `ElementId` để làm khóa đăng ký.
pub fn element_id_text(id: &ElementId) -> String {
    match id {
        ElementId::Name(name) => name.to_string(),
        other => format!("{other:?}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::{point, px, size};

    #[test]
    fn registry_keeps_last_frame_and_bounds() {
        begin_frame(1.75);
        register(Registered {
            id: "unit-ctl".into(),
            role: "checkbox",
            name: "Trộn tệp".into(),
            disabled: false,
            focused: true,
            hovered: false,
            checked: Some("mixed"),
            value: None,
            bounds: None,
        });
        set_bounds(
            "unit-ctl",
            Bounds::new(point(px(10.), px(20.)), size(px(30.), px(40.))),
        );
        let (scale, controls) = snapshot();
        assert_eq!(scale, 1.75);
        let found = controls
            .iter()
            .find(|c| c.id == "unit-ctl")
            .expect("đăng ký");
        assert_eq!(found.role, "checkbox");
        assert_eq!(found.checked, Some("mixed"));
        assert_eq!(found.bounds, Some([10.0, 20.0, 30.0, 40.0]));
        begin_frame(1.0);
        assert!(snapshot().1.iter().all(|c| c.id != "unit-ctl"));
    }
}
