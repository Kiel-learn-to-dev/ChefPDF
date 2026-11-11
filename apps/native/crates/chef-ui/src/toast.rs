//! Thông báo nổi (TASKS_RUST R2.12, BLUEPRINT_RUST §6.6): bản GPUI của `.toast` trong components.css.
//!
//! Thành phần này chỉ vẽ một thông báo với nút đóng. Danh sách, thứ tự xếp chồng và việc tự ẩn do
//! bên gọi giữ (xem `probe.rs` và `viewer.rs`): mỗi thông báo có một bộ đếm riêng và bị gỡ khi hết hạn.
//! Hoạt ảnh `toast-in` (160 ms, `--ease`): trượt lên 8 px và hiện dần. Khi giảm chuyển động thì không chạy.

use std::rc::Rc;

use chef_theme::{dark, light, shared};
use gpui::{
    App, ElementId, FocusHandle, IntoElement, RenderOnce, SharedString, Window, div, prelude::*,
    px, rgba,
};

use crate::a11y::{self, Registered};
use crate::button::{Button, Variant, cubic_bezier, pack};
use crate::motion;
use gpui::{Animation, AnimationExt};
use std::time::Duration;

type CloseFn = Rc<dyn Fn(&mut Window, &mut App)>;

/// Một thông báo: nội dung đọc được bằng truy cập (role status) và nút đóng.
#[derive(IntoElement)]
pub struct Toast {
    id: ElementId,
    text: SharedString,
    close: FocusHandle,
    dark: bool,
    on_close: Option<CloseFn>,
}

impl Toast {
    /// `close` là tiêu điểm của nút đóng. `id` là mã ổn định cho kênh debug và E2E.
    pub fn new(
        id: impl Into<ElementId>,
        text: impl Into<SharedString>,
        close: FocusHandle,
    ) -> Self {
        Self {
            id: id.into(),
            text: text.into(),
            close,
            dark: false,
            on_close: None,
        }
    }

    pub fn dark(mut self, dark: bool) -> Self {
        self.dark = dark;
        self
    }

    pub fn on_close(mut self, listener: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_close = Some(Rc::new(listener));
        self
    }
}

impl RenderOnce for Toast {
    fn render(self, window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let (bg, text) = if self.dark {
            (pack(dark::C_INVERSE_BG), pack(dark::C_INVERSE_TEXT))
        } else {
            (pack(light::C_INVERSE_BG), pack(light::C_INVERSE_TEXT))
        };
        a11y::register(Registered {
            id: a11y::element_id_text(&self.id),
            role: "status",
            name: self.text.to_string(),
            disabled: false,
            focused: self.close.is_focused(window),
            hovered: false,
            checked: None,
            value: None,
            bounds: None,
        });

        let mut close = Button::new(
            format!("{}-close", a11y::element_id_text(&self.id)),
            self.close,
        )
        .variant(Variant::Ghost)
        .icon("icons/x.svg")
        .aria_label("Đóng")
        .dark(self.dark);
        if let Some(listener) = self.on_close {
            close = close.on_click(move |_, window, cx| listener(window, cx));
        }

        let toast = div()
            .id(self.id.clone())
            .relative()
            .flex()
            .flex_row()
            .items_center()
            .gap(px(shared::SPACE_4))
            .min_w(px(260.))
            .max_w(px(420.))
            .px(px(shared::SPACE_6))
            .py(px(shared::SPACE_5))
            .rounded(px(shared::RADIUS_LG))
            .bg(rgba(bg))
            .text_color(rgba(text))
            .text_size(px(shared::TEXT_MD))
            .child(div().flex_1().min_w_0().child(self.text))
            .child(close);
        if motion::reduced() {
            return toast.into_any_element();
        }
        // Khóa theo id thông báo: thông báo chỉ vào một lần, nên không đổi id phần tử (xem D82).
        toast
            .with_animation(
                (self.id, "enter"),
                Animation::new(Duration::from_millis(chef_theme::shared::DUR as u64))
                    .with_easing(cubic_bezier(0.2, 0.0, 0.0, 1.0)),
                |el, delta| el.opacity(delta).top(px(8.0 * (1.0 - delta))),
            )
            .into_any_element()
    }
}
