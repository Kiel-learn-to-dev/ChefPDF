//! Điều khiển biểu mẫu (TASKS_RUST R2.04, BLUEPRINT_RUST §6.6): ô nhập có nhãn, checkbox ba trạng
//! thái và switch, theo `.field`, `.input`, `.checkbox`, `.switch` trong components.css.
//!
//! Checkbox và switch là thẻ `<button>` trong Radix nên trình duyệt kích hoạt bằng Space và Enter.
//! GPUI cũng kích hoạt `on_click` cho cả hai phím khi có tiêu điểm, nên hành vi khớp mà không cần
//! xử lý phím riêng. Tên truy cập theo D81: mọi điều khiển đăng ký vào `a11y` khi vẽ.

use chef_theme::{Rgba, dark, light, shared};
use gpui::{
    App, ClickEvent, ElementId, Entity, FocusHandle, Focusable, FontWeight, IntoElement,
    RenderOnce, SharedString, Window, div, prelude::*, px, rgba, svg,
};

use crate::a11y::{self, Registered};
use crate::button::ring;
use crate::text_input::TextInput;

/// Trạng thái checkbox, như `checked` của Radix: không xác định (`Mixed`) cũng là một trạng thái.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum CheckState {
    #[default]
    Unchecked,
    Checked,
    Indeterminate,
}

impl CheckState {
    /// Bấm từ không xác định sang bật, như Radix.
    pub fn toggled(self) -> CheckState {
        match self {
            CheckState::Checked => CheckState::Unchecked,
            CheckState::Unchecked | CheckState::Indeterminate => CheckState::Checked,
        }
    }

    /// Giá trị `aria-checked` tương ứng.
    pub fn aria(self) -> &'static str {
        match self {
            CheckState::Unchecked => "false",
            CheckState::Checked => "true",
            CheckState::Indeterminate => "mixed",
        }
    }
}

/// Màu của token theo theme, lấy trực tiếp từ chef-theme.
struct Tokens {
    surface: Rgba,
    border_hover: Rgba,
    border_strong: Rgba,
    text: Rgba,
    text_2: Rgba,
    accent: Rgba,
    focus: Rgba,
    white: Rgba,
}

impl Tokens {
    fn of(is_dark: bool) -> Tokens {
        if is_dark {
            Tokens {
                surface: dark::C_SURFACE,
                border_hover: dark::C_TEXT_3,
                border_strong: dark::C_BORDER_STRONG,
                text: dark::C_TEXT,
                text_2: dark::C_TEXT_2,
                accent: dark::C_ACCENT,
                focus: dark::C_FOCUS,
                white: [255, 255, 255, 255],
            }
        } else {
            Tokens {
                surface: light::C_SURFACE,
                border_hover: light::C_TEXT_3,
                border_strong: light::C_BORDER_STRONG,
                text: light::C_TEXT,
                text_2: light::C_TEXT_2,
                accent: light::C_ACCENT,
                focus: light::C_FOCUS,
                white: [255, 255, 255, 255],
            }
        }
    }
}

fn pack(c: Rgba) -> u32 {
    u32::from_be_bytes(c)
}

fn element_key(id: &ElementId) -> String {
    a11y::element_id_text(id)
}

type BoolChange = Box<dyn Fn(&bool, &mut Window, &mut App)>;
type CheckChange = Box<dyn Fn(&CheckState, &mut Window, &mut App)>;

/// Ô nhập có nhãn: `.field` với `.field__label` phía trên và khung `.input` bao ô nhập.
/// Khung đổi viền khi di chuột (`:hover`) và khi có tiêu điểm (`:focus`, vòng 3 px).
#[derive(IntoElement)]
pub struct TextField {
    id: ElementId,
    label: SharedString,
    input: Entity<TextInput>,
    dark: bool,
}

impl TextField {
    pub fn new(
        id: impl Into<ElementId>,
        label: impl Into<SharedString>,
        input: Entity<TextInput>,
    ) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            input,
            dark: false,
        }
    }

    pub fn dark(mut self, dark: bool) -> Self {
        self.dark = dark;
        self
    }
}

impl RenderOnce for TextField {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let t = Tokens::of(self.dark);
        let handle: FocusHandle = self.input.read(cx).focus_handle(cx);
        let focused = handle.is_focused(window);
        let value = self.input.read(cx).text().to_string();
        let key = element_key(&self.id);
        a11y::register(Registered {
            id: key.clone(),
            role: "textbox",
            name: self.label.to_string(),
            disabled: false,
            focused,
            hovered: false,
            checked: None,
            value: Some(value),
            bounds: None,
        });

        let border = if focused { t.accent } else { t.border_strong };
        let control = div()
            .flex()
            .items_center()
            .w_full()
            .h(px(32.))
            .px(px(4.))
            .rounded(px(shared::RADIUS_MD))
            .border_1()
            .border_color(rgba(pack(border)))
            .bg(rgba(pack(t.surface)))
            .when(focused, |c| c.shadow(vec![ring(pack(t.focus), 3.0)]))
            .when(!focused, |c| {
                c.hover(|s| s.border_color(rgba(pack(t.border_hover))))
            })
            .child(self.input.clone());

        div()
            .flex()
            .flex_col()
            .gap(px(shared::SPACE_3))
            .w(px(240.))
            .child(
                div()
                    .text_size(px(shared::TEXT_SM))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(rgba(pack(t.text_2)))
                    .child(self.label),
            )
            .child(control)
            .on_children_prepainted(move |bounds, _, _| {
                // Con thứ hai là khung `.input`, đúng vùng cần đo.
                if let Some(b) = bounds.get(1) {
                    a11y::set_bounds(&key, *b);
                }
            })
    }
}

/// Checkbox có nhãn: `.checkbox-row` gồm hộp 16 px và chữ. Trạng thái do bên gọi giữ.
#[derive(IntoElement)]
pub struct Checkbox {
    id: ElementId,
    focus: FocusHandle,
    label: SharedString,
    state: CheckState,
    disabled: bool,
    dark: bool,
    on_change: Option<CheckChange>,
}

impl Checkbox {
    pub fn new(
        id: impl Into<ElementId>,
        focus: FocusHandle,
        label: impl Into<SharedString>,
        state: CheckState,
    ) -> Self {
        Self {
            id: id.into(),
            focus,
            label: label.into(),
            state,
            disabled: false,
            dark: false,
            on_change: None,
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn dark(mut self, dark: bool) -> Self {
        self.dark = dark;
        self
    }

    pub fn on_change(
        mut self,
        listener: impl Fn(&CheckState, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_change = Some(Box::new(listener));
        self
    }
}

impl RenderOnce for Checkbox {
    fn render(self, window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let t = Tokens::of(self.dark);
        let focus = self.focus.tab_stop(!self.disabled);
        let key = element_key(&self.id);
        a11y::register(Registered {
            id: key.clone(),
            role: "checkbox",
            name: self.label.to_string(),
            disabled: self.disabled,
            focused: focus.is_focused(window),
            hovered: false,
            checked: Some(self.state.aria()),
            value: None,
            bounds: None,
        });

        let filled = self.state != CheckState::Unchecked;
        let (bg, border) = if filled {
            (t.accent, t.accent)
        } else {
            (t.surface, t.border_strong)
        };
        let indicator = match self.state {
            CheckState::Unchecked => None,
            CheckState::Checked => Some("icons/check.svg"),
            CheckState::Indeterminate => Some("icons/minus.svg"),
        };
        let mut hitbox = div()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .mt(px(shared::SPACE_1))
            .size(px(16.))
            .rounded(px(shared::RADIUS_XS))
            .border_1()
            .border_color(rgba(pack(border)))
            .bg(rgba(pack(bg)))
            .when_some(indicator, |b, path| {
                b.child(
                    svg()
                        .path(path)
                        .size(px(12.))
                        .text_color(rgba(pack(t.white))),
                )
            });
        if !self.disabled && !filled {
            hitbox = hitbox.hover(|s| s.border_color(rgba(pack(t.border_hover))));
        }

        let mut row = div()
            .id(self.id.clone())
            .track_focus(&focus)
            .flex()
            .items_start()
            .gap(px(shared::SPACE_4))
            .text_size(px(shared::TEXT_MD))
            .text_color(rgba(pack(t.text)))
            .focus_visible(|s| s.shadow(vec![ring(pack(t.surface), 2.0), ring(pack(t.focus), 4.0)]))
            .child(hitbox)
            .child(self.label);
        if self.disabled {
            row = row.opacity(0.5);
        } else {
            row = row.cursor_pointer();
            if let Some(listener) = self.on_change {
                let next = self.state.toggled();
                row = row.on_click(move |_: &ClickEvent, window, cx| {
                    listener(&next, window, cx);
                });
            }
        }
        // Lớp bọc để đo vị trí hàng sau layout, cho E2E bấm chuột (D81). Không đổi cây phần tử của hàng.
        div()
            .flex_none()
            .child(row)
            .on_children_prepainted(move |bounds, _, _| {
                if let Some(b) = bounds.first() {
                    a11y::set_bounds(&key, *b);
                }
            })
    }
}

/// Switch có nhãn: `.switch` 30×18 px với núm 14 px. Bật và tắt như một nút Radix.
#[derive(IntoElement)]
pub struct Switch {
    id: ElementId,
    focus: FocusHandle,
    label: SharedString,
    on: bool,
    disabled: bool,
    dark: bool,
    on_change: Option<BoolChange>,
}

impl Switch {
    pub fn new(
        id: impl Into<ElementId>,
        focus: FocusHandle,
        label: impl Into<SharedString>,
        on: bool,
    ) -> Self {
        Self {
            id: id.into(),
            focus,
            label: label.into(),
            on,
            disabled: false,
            dark: false,
            on_change: None,
        }
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn dark(mut self, dark: bool) -> Self {
        self.dark = dark;
        self
    }

    pub fn on_change(mut self, listener: impl Fn(&bool, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Box::new(listener));
        self
    }
}

impl RenderOnce for Switch {
    fn render(self, window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let t = Tokens::of(self.dark);
        let focus = self.focus.tab_stop(!self.disabled);
        let key = element_key(&self.id);
        a11y::register(Registered {
            id: key.clone(),
            role: "switch",
            name: self.label.to_string(),
            disabled: self.disabled,
            focused: focus.is_focused(window),
            hovered: false,
            checked: Some(if self.on { "true" } else { "false" }),
            value: None,
            bounds: None,
        });

        // Núm cách mép 2 px; bật thì sang phải (translateX 12 px trong CSS).
        let thumb_left = if self.on { 14.0 } else { 2.0 };
        let track = div()
            .relative()
            .flex_none()
            .mt(px(shared::SPACE_1))
            .w(px(30.))
            .h(px(18.))
            .rounded(px(shared::RADIUS_FULL))
            .bg(rgba(pack(if self.on { t.accent } else { t.border_strong })))
            .child(
                div()
                    .absolute()
                    .top(px(2.))
                    .left(px(thumb_left))
                    .size(px(14.))
                    .rounded(px(shared::RADIUS_FULL))
                    .bg(rgba(pack(t.white))),
            );

        let mut row = div()
            .id(self.id.clone())
            .track_focus(&focus)
            .flex()
            .items_start()
            .gap(px(shared::SPACE_4))
            .text_size(px(shared::TEXT_MD))
            .text_color(rgba(pack(t.text)))
            .focus_visible(|s| s.shadow(vec![ring(pack(t.surface), 2.0), ring(pack(t.focus), 4.0)]))
            .child(track)
            .child(self.label);
        if self.disabled {
            row = row.opacity(0.5);
        } else {
            row = row.cursor_pointer();
            if let Some(listener) = self.on_change {
                let next = !self.on;
                row = row.on_click(move |_: &ClickEvent, window, cx| {
                    listener(&next, window, cx);
                });
            }
        }
        // Lớp bọc để đo vị trí hàng sau layout, cho E2E bấm chuột (D81). Không đổi cây phần tử của hàng.
        div()
            .flex_none()
            .child(row)
            .on_children_prepainted(move |bounds, _, _| {
                if let Some(b) = bounds.first() {
                    a11y::set_bounds(&key, *b);
                }
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkbox_toggles_like_radix() {
        assert_eq!(CheckState::Unchecked.toggled(), CheckState::Checked);
        assert_eq!(CheckState::Checked.toggled(), CheckState::Unchecked);
        // Không xác định bấm sang bật, không quay về tắt.
        assert_eq!(CheckState::Indeterminate.toggled(), CheckState::Checked);
    }

    #[test]
    fn aria_values_match_radix() {
        assert_eq!(CheckState::Unchecked.aria(), "false");
        assert_eq!(CheckState::Checked.aria(), "true");
        assert_eq!(CheckState::Indeterminate.aria(), "mixed");
    }
}
