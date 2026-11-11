//! Danh sách điều khiển của khung vẽ gần nhất, cho kênh debug và E2E (D81).
//!
//! GPUI không có cây truy cập, nên trình đọc màn hình không đọc được điều khiển. Thay thế: mọi
//! điều khiển phải có tên (nhãn) khi vẽ, và mỗi điều khiển đăng ký vai trò, tên, trạng thái và vị
//! trí vào đây. Lệnh `state` của kênh debug đọc danh sách này để E2E tìm điều khiển theo `id`.

use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

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

/// Hai bộ đệm: `pending` là khung đang vẽ, `published` là khung đã vẽ xong để lệnh `state` đọc. Khung
/// được coi là xong khi bắt đầu khung kế tiếp, hoặc khi đã yên 30 ms không có đăng ký nào (lúc nhàn rỗi,
/// kể cả khung rỗng). Nhờ vậy `state` không đọc một khung vẽ dở.
struct Frame {
    scale: f32,
    pending: Vec<Registered>,
    published_scale: f32,
    published: Vec<Registered>,
    /// Lúc khung đang vẽ bắt đầu hoặc có đăng ký gần nhất.
    touched: Option<Instant>,
}

/// Thời gian yên lặng để coi khung đang vẽ là đã xong.
const QUIET: Duration = Duration::from_millis(30);

static FRAME: Mutex<Frame> = Mutex::new(Frame {
    scale: 1.0,
    pending: Vec::new(),
    published_scale: 1.0,
    published: Vec::new(),
    touched: None,
});

fn frame() -> MutexGuard<'static, Frame> {
    FRAME.lock().unwrap_or_else(|e| e.into_inner())
}

/// Bắt đầu một khung vẽ: khung vừa xong được công bố, khung mới bắt đầu trống.
pub fn begin_frame(scale: f32) {
    let mut f = frame();
    f.published = std::mem::take(&mut f.pending);
    f.published_scale = f.scale;
    f.scale = scale;
    f.touched = Some(Instant::now());
}

/// Tỉ lệ hiển thị và các điều khiển của khung đã xong gần nhất.
pub fn snapshot() -> (f32, Vec<Registered>) {
    let mut f = frame();
    let quiet = f.touched.is_none_or(|t| t.elapsed() > QUIET);
    if quiet && f.published != f.pending {
        // Khung đã yên: công bố cả khung rỗng, để điều khiển đã bị gỡ không còn xuất hiện.
        f.published = f.pending.clone();
        f.published_scale = f.scale;
    }
    (f.published_scale, f.published.clone())
}

pub fn register(entry: Registered) {
    let mut f = frame();
    f.pending.push(entry);
    f.touched = Some(Instant::now());
}

/// Đặt vị trí cho điều khiển `id`, khi layout và prepaint xong. Áp vào cả hai bộ đệm.
pub fn set_bounds(id: &str, bounds: Bounds<Pixels>) {
    let mut f = frame();
    let value = [
        f32::from(bounds.origin.x),
        f32::from(bounds.origin.y),
        f32::from(bounds.size.width),
        f32::from(bounds.size.height),
    ];
    let f = &mut *f;
    for list in [&mut f.pending, &mut f.published] {
        if let Some(entry) = list.iter_mut().find(|c| c.id == id) {
            entry.bounds = Some(value);
        }
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
    fn registry_publishes_a_frame_only_when_it_is_complete() {
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
        // Khung vừa vẽ xong nhưng chưa có khung kế tiếp và chưa yên: chưa công bố, nên không thấy.
        let (_, early) = snapshot();
        assert!(early.iter().all(|c| c.id != "unit-ctl"));
        // Khung kế tiếp bắt đầu: khung trước được công bố kèm vị trí và tỉ lệ của nó.
        begin_frame(1.0);
        let (scale, controls) = snapshot();
        assert_eq!(scale, 1.75);
        let found = controls
            .iter()
            .find(|c| c.id == "unit-ctl")
            .expect("đăng ký");
        assert_eq!(found.role, "checkbox");
        assert_eq!(found.checked, Some("mixed"));
        assert_eq!(found.bounds, Some([10.0, 20.0, 30.0, 40.0]));
        // Khung mới không đăng ký gì và đã yên: khung rỗng được công bố, điều khiển cũ biến mất.
        std::thread::sleep(QUIET + Duration::from_millis(20));
        assert!(snapshot().1.iter().all(|c| c.id != "unit-ctl"));
    }
}
