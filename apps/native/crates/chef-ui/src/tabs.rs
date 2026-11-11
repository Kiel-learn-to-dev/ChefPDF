//! Thẻ chuyển (TASKS_RUST R2.09, BLUEPRINT_RUST §6.6): bản GPUI của `Tabs` của Radix (activation
//! tự động, như mặc định của Radix).
//!
//! - Chỉ thẻ đang chọn là điểm dừng Tab (roving focus).
//! - Mũi tên trái và phải chuyển tiêu điểm và chọn luôn, có vòng lại. Home và End về thẻ đầu và cuối.
//! - Thẻ đang chọn có gạch chân nhấn màu accent, như `[data-state=active]`.
//!
//! Thanh thẻ tài liệu (R2.15) sẽ dùng cùng hành vi này, thêm nút đóng.

use std::rc::Rc;

use chef_theme::{dark, light, shared};
use gpui::{
    App, ElementId, FocusHandle, FontWeight, IntoElement, KeyBinding, RenderOnce, SharedString,
    Window, actions, div, prelude::*, px, rgba,
};

use crate::a11y::{self, Registered};
use crate::button::{pack, ring};
use crate::choice::next_enabled;

actions!(chef_ui_tabs, [TabPrev, TabNext, TabFirst, TabLast]);

/// Ngữ cảnh phím của thanh thẻ.
pub const CONTEXT: &str = "ChefTabs";

/// Gắn phím cho thanh thẻ. Gọi một lần lúc khởi động.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("left", TabPrev, Some(CONTEXT)),
        KeyBinding::new("right", TabNext, Some(CONTEXT)),
        KeyBinding::new("home", TabFirst, Some(CONTEXT)),
        KeyBinding::new("end", TabLast, Some(CONTEXT)),
    ]);
}

/// Một thẻ: mã, tiêu điểm và nhãn.
pub struct TabItem {
    id: ElementId,
    focus: FocusHandle,
    label: SharedString,
}

impl TabItem {
    pub fn new(
        id: impl Into<ElementId>,
        focus: FocusHandle,
        label: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            focus,
            label: label.into(),
        }
    }
}

type IndexFn = Rc<dyn Fn(usize, &mut Window, &mut App)>;

/// Thanh thẻ. `selected` là chỉ số thẻ đang chọn do bên gọi giữ.
#[derive(IntoElement)]
pub struct Tabs {
    id: ElementId,
    name: SharedString,
    items: Vec<TabItem>,
    selected: usize,
    dark: bool,
    on_change: Option<IndexFn>,
}

impl Tabs {
    /// `name` là nhãn truy cập của thanh thẻ.
    pub fn new(
        id: impl Into<ElementId>,
        name: impl Into<SharedString>,
        items: Vec<TabItem>,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            items,
            selected: 0,
            dark: false,
            on_change: None,
        }
    }

    pub fn selected(mut self, index: usize) -> Self {
        self.selected = index;
        self
    }

    pub fn dark(mut self, dark: bool) -> Self {
        self.dark = dark;
        self
    }

    pub fn on_change(mut self, listener: impl Fn(usize, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(listener));
        self
    }
}

/// Đưa tiêu điểm và chọn mục `target`, nếu có.
fn focus_and_select(
    focus: &[FocusHandle],
    listener: &Option<IndexFn>,
    target: Option<usize>,
    window: &mut Window,
    cx: &mut App,
) {
    if let Some(i) = target {
        window.focus(&focus[i], cx);
        if let Some(listener) = listener {
            listener(i, window, cx);
        }
    }
}

impl RenderOnce for Tabs {
    fn render(self, window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let (accent, text, text_2, border, surface, focus_color) = if self.dark {
            (
                pack(dark::C_ACCENT),
                pack(dark::C_TEXT),
                pack(dark::C_TEXT_2),
                pack(dark::C_DIVIDER),
                pack(dark::C_SURFACE),
                pack(dark::C_FOCUS),
            )
        } else {
            (
                pack(light::C_ACCENT),
                pack(light::C_TEXT),
                pack(light::C_TEXT_2),
                pack(light::C_DIVIDER),
                pack(light::C_SURFACE),
                pack(light::C_FOCUS),
            )
        };
        let n = self.items.len();
        let selected = self.selected.min(n.saturating_sub(1));
        let enabled = vec![true; n];
        let focus_list: Rc<Vec<FocusHandle>> =
            Rc::new(self.items.iter().map(|i| i.focus.clone()).collect());
        a11y::register(Registered {
            id: a11y::element_id_text(&self.id),
            role: "tablist",
            name: self.name.to_string(),
            disabled: false,
            focused: false,
            hovered: false,
            checked: None,
            value: None,
            bounds: None,
        });

        let listener = self.on_change.clone();
        let mut root = div()
            .id(self.id.clone())
            .key_context(CONTEXT)
            .flex()
            .flex_row()
            .flex_none()
            .gap(px(shared::SPACE_5))
            .border_b_1()
            .border_color(rgba(border));

        // Mũi tên và Home, End đi qua các thẻ; chọn luôn (activation tự động).
        root = root
            .on_action({
                let focus = focus_list.clone();
                let listener = listener.clone();
                let enabled = enabled.clone();
                move |_: &TabNext, window, cx| {
                    cx.stop_propagation();
                    let current = focus.iter().position(|f| f.is_focused(window));
                    let target = next_enabled(&enabled, current, true);
                    focus_and_select(&focus, &listener, target, window, cx);
                }
            })
            .on_action({
                let focus = focus_list.clone();
                let listener = listener.clone();
                let enabled = enabled.clone();
                move |_: &TabPrev, window, cx| {
                    cx.stop_propagation();
                    let current = focus.iter().position(|f| f.is_focused(window));
                    let target = next_enabled(&enabled, current, false);
                    focus_and_select(&focus, &listener, target, window, cx);
                }
            })
            .on_action({
                let focus = focus_list.clone();
                let listener = listener.clone();
                move |_: &TabFirst, window, cx| {
                    cx.stop_propagation();
                    focus_and_select(&focus, &listener, (n > 0).then_some(0), window, cx);
                }
            })
            .on_action({
                let focus = focus_list.clone();
                let listener = listener.clone();
                move |_: &TabLast, window, cx| {
                    cx.stop_propagation();
                    focus_and_select(&focus, &listener, n.checked_sub(1), window, cx);
                }
            });

        for (i, item) in self.items.into_iter().enumerate() {
            let on = i == selected;
            a11y::register(Registered {
                id: a11y::element_id_text(&item.id),
                role: "tab",
                name: item.label.to_string(),
                disabled: false,
                focused: item.focus.is_focused(window),
                hovered: false,
                checked: Some(if on { "true" } else { "false" }),
                value: None,
                bounds: None,
            });
            let focus = item.focus.tab_stop(i == selected);
            let mut tab = div()
                .id(item.id.clone())
                .track_focus(&focus)
                .flex()
                .flex_col()
                .justify_end()
                .h(px(32.))
                .px(px(shared::SPACE_2))
                .cursor_pointer()
                .text_size(px(shared::TEXT_MD))
                .font_weight(if on {
                    FontWeight::SEMIBOLD
                } else {
                    FontWeight::MEDIUM
                })
                .text_color(rgba(if on { text } else { text_2 }))
                .focus_visible(|s| s.shadow(vec![ring(surface, 2.0), ring(focus_color, 4.0)]))
                .hover(move |s| s.text_color(rgba(text)))
                .child(item.label.clone())
                .child(
                    // Gạch chân của thẻ đang chọn: 2 px, màu accent.
                    div()
                        .mt(px(4.))
                        .h(px(2.))
                        .w_full()
                        .bg(rgba(if on { accent } else { 0 })),
                );
            if let Some(listener) = listener.clone() {
                tab = tab.on_click(move |_, window, cx| listener(i, window, cx));
            }
            root = root.child(tab);
        }
        root
    }
}
