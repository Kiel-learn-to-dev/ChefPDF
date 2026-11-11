//! Ô chọn một mục (TASKS_RUST R2.08, BLUEPRINT_RUST §6.6): nút hiện mục đang chọn, bấm hoặc Enter
//! mở danh sách, và danh sách là một [`Menu`] (R2.06).
//!
//! - Mở: đưa tiêu điểm vào mục đang chọn. Enter hoặc Space trên nút mở và đóng (GPUI kích hoạt click).
//! - Chọn: Enter trên mục, hoặc bấm mục. Đóng và trả tiêu điểm về nút.
//! - Esc đóng và trả tiêu điểm về nút. Bấm ra ngoài đóng (khung bao nút và danh sách lo việc này,
//!   nên bấm chính nút để đóng không bị coi là bấm ngoài).
//! - Trạng thái mở và các tiêu điểm nằm trong keyed state theo `id`, nên bên gọi chỉ giữ mục đang chọn.

use std::rc::Rc;

use chef_theme::{dark, light, shared};
use gpui::{
    App, Entity, FontWeight, IntoElement, RenderOnce, SharedString, Window, div, prelude::*, px,
    rgba, svg,
};

use crate::a11y::{self, Registered};
use crate::button::{pack, ring};
use crate::menu::{Menu, MenuEntry};

/// Trạng thái giữ qua các lần vẽ: đang mở hay không, và tiêu điểm của nút và các mục.
#[derive(Default)]
struct SelectState {
    open: bool,
    trigger: Option<gpui::FocusHandle>,
    items: Vec<gpui::FocusHandle>,
    /// Vùng của danh sách sau bố cục. Bấm trong vùng này không tính là bấm ngoài.
    list_bounds: Option<gpui::Bounds<gpui::Pixels>>,
}

type IndexFn = Rc<dyn Fn(usize, &mut Window, &mut App)>;

/// Tiêu điểm của nút ô chọn `id` trong khung đang vẽ. Hộp thoại chứa ô chọn dùng để xếp vòng Tab.
pub fn trigger_focus(
    id: impl Into<gpui::ElementId>,
    window: &mut Window,
    cx: &mut App,
) -> gpui::FocusHandle {
    let state = window.use_keyed_state(id, cx, |_, _| SelectState::default());
    state.update(cx, |s, cx| {
        s.trigger.get_or_insert_with(|| cx.focus_handle()).clone()
    })
}

fn set_open(state: &Entity<SelectState>, open: bool, window: &mut Window, cx: &mut App) {
    state.update(cx, |s, _| {
        s.open = open;
        if !open {
            s.list_bounds = None;
        }
    });
    window.refresh();
}

/// Ô chọn một mục. `selected` là chỉ số mục đang chọn do bên gọi giữ.
#[derive(IntoElement)]
pub struct Select {
    id: gpui::ElementId,
    name: SharedString,
    options: Vec<SharedString>,
    selected: usize,
    width: f32,
    dark: bool,
    on_change: Option<IndexFn>,
}

impl Select {
    /// `name` là nhãn truy cập (aria-label) của ô chọn.
    pub fn new(
        id: impl Into<gpui::ElementId>,
        name: impl Into<SharedString>,
        options: Vec<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            options,
            selected: 0,
            width: 200.0,
            dark: false,
            on_change: None,
        }
    }

    pub fn selected(mut self, index: usize) -> Self {
        self.selected = index;
        self
    }

    pub fn width(mut self, width: f32) -> Self {
        self.width = width;
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

impl RenderOnce for Select {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let is_dark = self.dark;
        let (surface, border, border_strong, text, text_2, focus) = if is_dark {
            (
                pack(dark::C_SURFACE),
                pack(dark::C_BORDER),
                pack(dark::C_BORDER_STRONG),
                pack(dark::C_TEXT),
                pack(dark::C_TEXT_2),
                pack(dark::C_FOCUS),
            )
        } else {
            (
                pack(light::C_SURFACE),
                pack(light::C_BORDER),
                pack(light::C_BORDER_STRONG),
                pack(light::C_TEXT),
                pack(light::C_TEXT_2),
                pack(light::C_FOCUS),
            )
        };
        let n = self.options.len();
        let selected = self.selected.min(n.saturating_sub(1));
        let state = window.use_keyed_state(self.id.clone(), cx, |_, _| SelectState::default());
        // Tạo đủ tiêu điểm cho nút và các mục. Tiêu điểm được giữ lại qua các lần vẽ.
        let (trigger, items, open) = state.update(cx, |s, cx| {
            let trigger = s.trigger.get_or_insert_with(|| cx.focus_handle()).clone();
            while s.items.len() < n {
                s.items.push(cx.focus_handle());
            }
            (trigger, s.items[..n].to_vec(), s.open)
        });
        let label = self.options.get(selected).cloned().unwrap_or_default();
        a11y::register(Registered {
            id: a11y::element_id_text(&self.id),
            role: "combobox",
            name: self.name.to_string(),
            disabled: false,
            focused: trigger.is_focused(window),
            hovered: false,
            checked: None,
            value: Some(label.to_string()),
            bounds: None,
        });

        let on_change = self.on_change.clone();
        let trigger_el = div()
            .id(self.id.clone())
            .track_focus(&trigger.clone().tab_stop(true))
            .flex()
            .flex_none()
            .items_center()
            .justify_between()
            .gap(px(shared::SPACE_4))
            .w(px(self.width))
            .h(px(shared::CONTROL_H))
            .px(px(shared::SPACE_5))
            .rounded(px(shared::RADIUS_MD))
            .border_1()
            .border_color(rgba(border))
            .bg(rgba(surface))
            .text_size(px(shared::TEXT_MD))
            .text_color(rgba(text))
            .font_weight(FontWeight::MEDIUM)
            .cursor_pointer()
            .focus_visible(|s| s.shadow(vec![ring(surface, 2.0), ring(focus, 4.0)]))
            .hover(move |s| s.border_color(rgba(border_strong)))
            .child(
                div()
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .child(label),
            )
            .child(
                svg()
                    .path("icons/chevron-down.svg")
                    .size(px(14.))
                    .flex_none()
                    .text_color(rgba(text_2)),
            )
            .on_click({
                let state = state.clone();
                let trigger = trigger.clone();
                let items = items.clone();
                move |_, window, cx| {
                    if state.read(cx).open {
                        set_open(&state, false, window, cx);
                        window.focus(&trigger, cx);
                    } else {
                        set_open(&state, true, window, cx);
                        if let Some(first) = items.get(selected) {
                            window.focus(first, cx);
                        }
                    }
                }
            });

        // Đo vị trí nút (con đầu tiên) để E2E bấm đúng chỗ (D81).
        let trigger_key = a11y::element_id_text(&self.id);
        let mut wrapper = div()
            .relative()
            .flex_none()
            .w(px(self.width))
            .child(trigger_el)
            .on_children_prepainted(move |bounds, _, _| {
                if let Some(b) = bounds.first() {
                    a11y::set_bounds(&trigger_key, *b);
                }
            })
            // Bấm ra ngoài cả nút và danh sách thì đóng. Bấm nút không tính là ngoài.
            .on_mouse_down_out({
                let state = state.clone();
                let trigger = trigger.clone();
                move |event, window, cx| {
                    let (open, inside_list) = {
                        let s = state.read(cx);
                        (
                            s.open,
                            s.list_bounds.is_some_and(|b| b.contains(&event.position)),
                        )
                    };
                    if open && !inside_list {
                        set_open(&state, false, window, cx);
                        window.focus(&trigger, cx);
                    }
                }
            });

        if open {
            let entries: Vec<MenuEntry> = self
                .options
                .iter()
                .enumerate()
                .map(|(i, option)| {
                    MenuEntry::new(
                        format!("{}-opt-{i}", self.id_text()),
                        items[i].clone(),
                        option.clone(),
                    )
                    .checked(i == selected)
                })
                .collect();
            let select_listener: IndexFn = Rc::new({
                let on_change = on_change.clone();
                let state = state.clone();
                let trigger = trigger.clone();
                move |index, window, cx| {
                    if let Some(listener) = &on_change {
                        listener(index, window, cx);
                    }
                    set_open(&state, false, window, cx);
                    window.focus(&trigger, cx);
                }
            });
            let menu = Menu::new(
                format!("{}-menu", self.id_text()),
                self.name.clone(),
                entries,
            )
            .at(0.0, shared::CONTROL_H + 4.0)
            .width(self.width)
            .dark(is_dark)
            .dismiss_on_outside(false)
            .on_select({
                let listener = select_listener.clone();
                move |index, window, cx| listener(index, window, cx)
            })
            .on_dismiss({
                let state = state.clone();
                let trigger = trigger.clone();
                move |window, cx| {
                    set_open(&state, false, window, cx);
                    window.focus(&trigger, cx);
                }
            })
            .on_layout({
                let state = state.clone();
                move |bounds, cx| {
                    state.update(cx, |s, _| s.list_bounds = Some(bounds));
                }
            });
            // Danh sách vẽ ở lớp trên, để các điều khiển đứng sau trong khung không đè lên khi bấm mục.
            wrapper = wrapper.child(gpui::deferred(menu));
        }
        wrapper
    }
}

impl Select {
    fn id_text(&self) -> String {
        a11y::element_id_text(&self.id)
    }
}
