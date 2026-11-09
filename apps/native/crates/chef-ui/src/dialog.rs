//! Khung hộp thoại (TASKS_RUST R2.10, BLUEPRINT_RUST §6.7): bản GPUI của `.dlg-overlay` và `.dlg`
//! trong components.css.
//!
//! - Lớp phủ tô `--c-overlay` và chặn chuột xuống trang bên dưới. Bấm ra ngoài khung thì đóng.
//! - Tab và Shift+Tab đi vòng trong `tab_order` (nút đóng đứng đầu nếu có). Tiêu điểm không rời
//!   hộp thoại. GPUI ở commit đã ghim không có `tab_group`, nên vòng lặp do khung tự làm.
//! - Esc đóng. Khi tiêu điểm nằm trong ô nhập, ô đó gửi `Cancel` lên trên; khung nhận cả hai action.
//! - Đóng thì trả tiêu điểm về `return_focus`.
//! - Mở: lớp phủ và khung hiện trong `--dur` (160 ms) theo `--ease`, khung dịch lên 6 px. Không
//!   có co 0,985 như CSS (lệch đã ghi ở BLUEPRINT_RUST §6.7). Khi giảm chuyển động
//!   ([`motion::reduced`]) thì vẽ trạng thái cuối ngay.
//!
//! Hộp thoại chỉ có mặt khi đang mở: hoạt ảnh chạy khi nó được dựng lần đầu, nên người gọi phải
//! bỏ nó khỏi cây khi đóng.

use std::rc::Rc;
use std::time::Duration;

use chef_theme::{dark, light, shared};
use gpui::{
    Animation, AnimationExt, AnyElement, App, BoxShadow, ElementId, FocusHandle, FontWeight,
    IntoElement, KeyBinding, RenderOnce, SharedString, Window, actions, div, point, prelude::*, px,
    relative, rgba,
};

use crate::a11y::{self, Registered};
use crate::button::{Button, FocusNext, FocusPrev, Variant, cubic_bezier, pack};
use crate::motion;
use crate::text_input::Cancel;

actions!(chef_ui_dialog, [Dismiss]);

/// Ngữ cảnh phím của khung. Esc đi tới [`Dismiss`] khi tiêu điểm nằm trong hộp thoại.
pub const CONTEXT: &str = "ChefDialog";

/// Dịch lên của khung khi mở, như `translate(-50%, calc(-50% + 6px))` trong `dialog-in`.
const ENTER_OFFSET_PX: f32 = 6.0;

/// Gắn Esc cho khung hộp thoại. Gọi một lần lúc khởi động, cùng các `bind_keys` khác.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([KeyBinding::new("escape", Dismiss, Some(CONTEXT))]);
}

/// Chiều rộng khung theo `.dlg`, `.dlg--sm`, `.dlg--lg`, `.dlg--xl`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Width {
    Sm,
    Md,
    Lg,
    Xl,
}

impl Width {
    /// Chiều rộng pixel logic. Khung không rộng quá 92% cửa sổ (min(92vw, …) trong CSS).
    pub fn px(self) -> f32 {
        match self {
            Width::Sm => 400.0,
            Width::Md => 480.0,
            Width::Lg => 720.0,
            Width::Xl => 880.0,
        }
    }
}

/// Chỉ số tiêu điểm kế tiếp trong danh sách có `len` phần tử. `None` là chưa có tiêu điểm nào
/// trong danh sách: Tab vào đầu, Shift+Tab vào cuối.
pub fn next_index(len: usize, current: Option<usize>, forward: bool) -> Option<usize> {
    if len == 0 {
        return None;
    }
    Some(match (current, forward) {
        (Some(i), true) => (i + 1) % len,
        (Some(i), false) => (i + len - 1) % len,
        (None, true) => 0,
        (None, false) => len - 1,
    })
}

/// (độ mờ, dịch lên px) của khung ở `delta` từ 0 đến 1.
pub fn enter_frame(delta: f32) -> (f32, f32) {
    let d = delta.clamp(0.0, 1.0);
    (d, ENTER_OFFSET_PX * (1.0 - d))
}

/// Bóng `--shadow-lg` của theme sáng hoặc tối. Đổi blur của CSS sang σ của GPUI (D80: chia đôi).
pub fn shadow_lg(is_dark: bool) -> Vec<BoxShadow> {
    let (main, near) = if is_dark {
        (0x0000_008c, 0x0000_0059)
    } else {
        (0x1018_2829, 0x1018_2814)
    };
    let (main_offset, main_blur, near_offset, near_blur) = (16.0, 20.0, 2.0, 4.0);
    vec![
        bar(main, main_offset, main_blur),
        bar(near, near_offset, near_blur),
    ]
}

fn bar(color: u32, offset_y: f32, blur: f32) -> BoxShadow {
    BoxShadow {
        color: rgba(color).into(),
        offset: point(px(0.), px(offset_y)),
        blur_radius: px(blur),
        spread_radius: px(0.),
    }
}

struct Colors {
    surface: u32,
    border: u32,
    divider: u32,
    overlay: u32,
    text: u32,
}

impl Colors {
    fn of(is_dark: bool) -> Colors {
        if is_dark {
            Colors {
                surface: pack(dark::C_SURFACE),
                border: pack(dark::C_BORDER),
                divider: pack(dark::C_DIVIDER),
                overlay: pack(dark::C_OVERLAY),
                text: pack(dark::C_TEXT),
            }
        } else {
            Colors {
                surface: pack(light::C_SURFACE),
                border: pack(light::C_BORDER),
                divider: pack(light::C_DIVIDER),
                overlay: pack(light::C_OVERLAY),
                text: pack(light::C_TEXT),
            }
        }
    }
}

/// Đưa tiêu điểm sang phần tử kế tiếp trong `order`, vòng lại đầu hoặc cuối.
fn step(order: &[FocusHandle], window: &mut Window, cx: &mut App, forward: bool) {
    let current = order.iter().position(|h| h.is_focused(window));
    if let Some(next) = next_index(order.len(), current, forward) {
        window.focus(&order[next], cx);
    }
}

/// Người nghe đóng hộp thoại: trả tiêu điểm trước, rồi gọi `on_dismiss` của người dùng.
type DismissListener = dyn Fn(&mut Window, &mut App);

#[derive(IntoElement)]
pub struct Dialog {
    id: SharedString,
    title: SharedString,
    width: Width,
    dark: bool,
    close: Option<(ElementId, FocusHandle, SharedString)>,
    tab_order: Vec<FocusHandle>,
    return_focus: Option<FocusHandle>,
    on_dismiss: Option<Rc<DismissListener>>,
    body: Vec<AnyElement>,
    footer: Vec<AnyElement>,
}

impl Dialog {
    /// `id` là mã ổn định cho kênh debug và E2E; `title` là tiêu đề hiển thị và tên truy cập.
    pub fn new(
        id: impl Into<SharedString>,
        title: impl Into<SharedString>,
        width: Width,
        dark: bool,
    ) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            width,
            dark,
            close: None,
            tab_order: Vec::new(),
            return_focus: None,
            on_dismiss: None,
            body: Vec::new(),
            footer: Vec::new(),
        }
    }

    /// Nút đóng ở góc trên phải (`.dlg__close`). Nhãn truy cập bắt buộc theo D81.
    pub fn close(
        mut self,
        id: impl Into<ElementId>,
        focus: FocusHandle,
        label: impl Into<SharedString>,
    ) -> Self {
        self.close = Some((id.into(), focus, label.into()));
        self
    }

    /// Thứ tự Tab trong hộp thoại, theo thứ tự hiển thị. Nút đóng (nếu có) đứng trước danh sách này.
    pub fn tab_order(mut self, order: Vec<FocusHandle>) -> Self {
        self.tab_order = order;
        self
    }

    /// Tiêu điểm trả về khi đóng, thường là nút đã mở hộp thoại.
    pub fn return_focus(mut self, focus: FocusHandle) -> Self {
        self.return_focus = Some(focus);
        self
    }

    /// Gọi khi đóng bằng Esc, nút đóng, bấm ra ngoài, hoặc `Dismiss` từ nút hành động.
    /// Người gọi phải bỏ hộp thoại khỏi cây trong listener này.
    pub fn on_dismiss(mut self, listener: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_dismiss = Some(Rc::new(listener));
        self
    }

    /// Nội dung thân hộp thoại (`.dlg__body`).
    pub fn child(mut self, child: impl IntoElement) -> Self {
        self.body.push(child.into_any_element());
        self
    }

    /// Nút ở chân hộp thoại (`.dlg__footer`), xếp từ trái sang phải và dồn về mép phải.
    pub fn action(mut self, action: impl IntoElement) -> Self {
        self.footer.push(action.into_any_element());
        self
    }
}

impl RenderOnce for Dialog {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let Dialog {
            id,
            title,
            width,
            dark: is_dark,
            close,
            tab_order,
            return_focus,
            on_dismiss,
            body,
            footer,
        } = self;
        let c = Colors::of(is_dark);
        let reduced = motion::reduced();

        let mut order: Vec<FocusHandle> = close.iter().map(|(_, f, _)| f.clone()).collect();
        order.extend(tab_order);
        let order = Rc::new(order);

        let dismiss: Rc<DismissListener> = Rc::new(move |window, cx| {
            if let Some(focus) = &return_focus {
                window.focus(focus, cx);
            }
            if let Some(listener) = &on_dismiss {
                listener(window, cx);
            }
        });

        a11y::register(Registered {
            id: id.to_string(),
            role: "dialog",
            name: title.to_string(),
            disabled: false,
            focused: false,
            hovered: false,
            checked: None,
            value: None,
            bounds: None,
        });

        let mut header = div()
            .flex()
            .flex_row()
            .items_start()
            .gap(px(shared::SPACE_5))
            .pt(px(shared::SPACE_7))
            .px(px(shared::SPACE_8))
            .pb(px(shared::SPACE_4))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .text_color(rgba(c.text))
                    .text_size(px(shared::TEXT_LG))
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(title.clone()),
            );
        if let Some((close_id, focus, label)) = close {
            let dismiss_close = dismiss.clone();
            header = header.child(
                div().mt(px(-4.)).mr(px(-8.)).child(
                    Button::new(close_id, focus)
                        .variant(Variant::Ghost)
                        .icon("icons/x.svg")
                        .aria_label(label)
                        .dark(is_dark)
                        .on_click(move |_, window, cx| dismiss_close(window, cx)),
                ),
            );
        }

        let body_el = div()
            .flex_1()
            .min_h_0()
            .px(px(shared::SPACE_8))
            .pt(px(shared::SPACE_6))
            .pb(px(shared::SPACE_8))
            .children(body);

        let footer_el = div()
            .flex()
            .flex_row()
            .items_center()
            .justify_end()
            .gap(px(shared::SPACE_4))
            .px(px(shared::SPACE_8))
            .py(px(shared::SPACE_6))
            .border_t_1()
            .border_color(rgba(c.divider))
            .children(footer);

        let panel_id: ElementId = ElementId::Name(format!("{id}-panel").into());
        let panel = div()
            .id(panel_id.clone())
            .key_context(CONTEXT)
            .relative()
            .flex()
            .flex_col()
            .w(px(width.px()))
            .max_w(relative(0.92))
            .max_h(relative(0.88))
            .bg(rgba(c.surface))
            .border_1()
            .border_color(rgba(c.border))
            .rounded(px(shared::RADIUS_XL))
            .shadow(shadow_lg(is_dark))
            .on_action({
                let dismiss = dismiss.clone();
                move |_: &Dismiss, window, cx| dismiss(window, cx)
            })
            .on_action({
                let dismiss = dismiss.clone();
                move |_: &Cancel, window, cx| dismiss(window, cx)
            })
            .on_action({
                let order = order.clone();
                move |_: &FocusNext, window, cx| {
                    cx.stop_propagation();
                    step(&order, window, cx, true);
                }
            })
            .on_action({
                let order = order.clone();
                move |_: &FocusPrev, window, cx| {
                    cx.stop_propagation();
                    step(&order, window, cx, false);
                }
            })
            .on_mouse_down_out({
                let dismiss = dismiss.clone();
                move |_, window, cx| dismiss(window, cx)
            })
            .child(header)
            .child(body_el)
            .child(footer_el);

        let overlay_id: ElementId = ElementId::Name(format!("{id}-overlay").into());
        let overlay = div()
            .id(overlay_id.clone())
            .absolute()
            .top(px(0.))
            .left(px(0.))
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .bg(rgba(c.overlay))
            .occlude();

        if reduced {
            overlay.child(panel).into_any_element()
        } else {
            let duration = Duration::from_millis(shared::DUR as u64);
            let panel = panel.with_animation(
                (panel_id, "enter"),
                Animation::new(duration).with_easing(cubic_bezier(0.2, 0.0, 0.0, 1.0)),
                |el, delta| {
                    let (opacity, lift) = enter_frame(delta);
                    el.opacity(opacity).top(px(lift))
                },
            );
            overlay
                .child(panel)
                .with_animation(
                    (overlay_id, "enter"),
                    Animation::new(duration).with_easing(cubic_bezier(0.2, 0.0, 0.0, 1.0)),
                    |el, delta| el.opacity(delta),
                )
                .into_any_element()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Width, enter_frame, next_index, shadow_lg};

    #[test]
    fn tab_wraps_inside_the_list_both_ways() {
        // Năm phần tử: tới cuối thì vòng về đầu, lùi qua đầu thì sang cuối.
        assert_eq!(next_index(5, Some(3), true), Some(4));
        assert_eq!(next_index(5, Some(4), true), Some(0));
        assert_eq!(next_index(5, Some(0), false), Some(4));
        assert_eq!(next_index(5, Some(2), false), Some(1));
    }

    #[test]
    fn no_focus_inside_the_list_enters_at_the_near_end() {
        assert_eq!(next_index(5, None, true), Some(0));
        assert_eq!(next_index(5, None, false), Some(4));
        assert_eq!(next_index(0, None, true), None);
        assert_eq!(next_index(0, Some(0), false), None);
    }

    #[test]
    fn enter_frame_starts_lifted_and_transparent_then_settles() {
        assert_eq!(enter_frame(0.0), (0.0, 6.0));
        assert_eq!(enter_frame(1.0), (1.0, 0.0));
        let (opacity, lift) = enter_frame(0.5);
        assert!((opacity - 0.5).abs() < 1e-6);
        assert!((lift - 3.0).abs() < 1e-6);
        // Ngoài [0, 1] thì kẹp lại, không vượt quá trạng thái đầu và cuối.
        assert_eq!(enter_frame(-1.0), (0.0, 6.0));
        assert_eq!(enter_frame(2.0), (1.0, 0.0));
    }

    #[test]
    fn widths_match_the_css_classes() {
        assert_eq!(Width::Sm.px(), 400.0);
        assert_eq!(Width::Md.px(), 480.0);
        assert_eq!(Width::Lg.px(), 720.0);
        assert_eq!(Width::Xl.px(), 880.0);
    }

    #[test]
    fn large_shadow_has_two_layers_in_both_themes() {
        assert_eq!(shadow_lg(false).len(), 2);
        assert_eq!(shadow_lg(true).len(), 2);
    }
}
