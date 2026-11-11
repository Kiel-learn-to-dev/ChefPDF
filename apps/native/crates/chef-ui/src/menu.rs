//! Menu bật lên và menu chuột phải (TASKS_RUST R2.06, R2.07, BLUEPRINT_RUST §6.6): bản GPUI của
//! `.menu` và `.menu__item` trong components.css.
//!
//! - Mũi tên lên và xuống đi qua các mục đang hiện và dùng được (mục bị khóa bị bỏ qua), có vòng lại.
//! - Gõ một chữ cái nhảy tới mục đầu tiên bắt đầu bằng chữ đó (typeahead), tính từ mục hiện tại.
//! - Enter chọn mục đang có tiêu điểm (GPUI kích hoạt `on_click`). Esc đóng qua `MenuDismiss`.
//! - Menu con (`MenuEntry::submenu`): mũi tên phải, Enter hoặc bấm mở; các mục con hiện ngay dưới
//!   mục cha, thụt vào. Mũi tên trái hoặc Esc khi đang ở mục con đóng menu con và trả tiêu điểm về
//!   mục cha (Esc ở mục gốc mới đóng menu). Khác bản Electron: menu con không bật ra bên cạnh
//!   (lý do ở TASKS_RUST R2.07).
//! - Bấm ra ngoài đóng khi `dismiss_on_outside` bật. Bên gọi trả tiêu điểm khi đóng.
//! - Phím tắt hiển thị căn phải, như bản Electron.
//!
//! Chỉ số truyền cho `on_select` là vị trí trong danh sách đang hiện (kể cả mục con đang mở). Menu
//! không có menu con thì chỉ số trùng với chỉ số mục.
//!
//! Menu được đặt theo tọa độ trong khung chứa (`at`). Menu chuột phải đặt ở khung gốc theo tọa độ
//! cửa sổ, nên bên gọi truyền vị trí chuột.

use std::rc::Rc;

use chef_theme::{dark, light, shared};
use gpui::{
    App, BoxShadow, ElementId, Entity, FocusHandle, IntoElement, KeyBinding, KeyDownEvent,
    RenderOnce, SharedString, Window, actions, div, point, prelude::*, px, rgba,
};

use crate::a11y::{self, Registered};
use crate::button::pack;
use crate::choice::next_enabled;

actions!(
    chef_ui_menu,
    [MenuPrev, MenuNext, MenuDismiss, MenuOpenSub, MenuCloseSub]
);

/// Ngữ cảnh phím của menu.
pub const CONTEXT: &str = "ChefMenu";

/// Gắn phím cho menu. Gọi một lần lúc khởi động.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("up", MenuPrev, Some(CONTEXT)),
        KeyBinding::new("down", MenuNext, Some(CONTEXT)),
        KeyBinding::new("escape", MenuDismiss, Some(CONTEXT)),
        KeyBinding::new("right", MenuOpenSub, Some(CONTEXT)),
        KeyBinding::new("left", MenuCloseSub, Some(CONTEXT)),
    ]);
}

/// Chỉ số mục đầu tiên sau `current` (không gồm chính nó) có nhãn bắt đầu bằng `needle`, không phân
/// biệt hoa thường, và dùng được. Duyệt vòng từ `current + 1`. `None` khi không có mục nào khớp.
pub fn typeahead(
    labels: &[String],
    enabled: &[bool],
    current: Option<usize>,
    needle: &str,
) -> Option<usize> {
    let n = labels.len();
    if n == 0 {
        return None;
    }
    let needle = needle.to_lowercase();
    let start = current.map_or(0, |c| c + 1);
    (0..n)
        .map(|k| (start + k) % n)
        .find(|&i| enabled[i] && labels[i].to_lowercase().starts_with(&needle))
}

/// Một mục của menu.
pub struct MenuEntry {
    id: ElementId,
    focus: FocusHandle,
    label: SharedString,
    shortcut: Option<SharedString>,
    disabled: bool,
    checked: Option<bool>,
    children: Vec<MenuEntry>,
}

impl MenuEntry {
    pub fn new(
        id: impl Into<ElementId>,
        focus: FocusHandle,
        label: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            focus,
            label: label.into(),
            shortcut: None,
            disabled: false,
            checked: None,
            children: Vec::new(),
        }
    }

    /// Phím tắt hiển thị bên phải, ví dụ "Ctrl+O".
    pub fn shortcut(mut self, shortcut: impl Into<SharedString>) -> Self {
        self.shortcut = Some(shortcut.into());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Mục có dấu chọn (dùng cho menu chọn một, như select).
    pub fn checked(mut self, checked: bool) -> Self {
        self.checked = Some(checked);
        self
    }

    /// Mục có menu con. Mở bằng mũi tên phải, Enter hoặc bấm. Mục con không lồng thêm được.
    pub fn submenu(mut self, children: Vec<MenuEntry>) -> Self {
        self.children = children;
        self
    }
}

type IndexFn = Rc<dyn Fn(usize, &mut Window, &mut App)>;
type DismissFn = Rc<dyn Fn(&mut Window, &mut App)>;
type LayoutFn = Rc<dyn Fn(gpui::Bounds<gpui::Pixels>, &mut App)>;

/// Trạng thái menu con, giữ theo id của menu: chỉ số mục gốc đang mở menu con.
#[derive(Default)]
struct SubState {
    open: Option<usize>,
}

/// Một dòng đang hiện, theo thứ tự hiển thị.
struct Visible {
    entry: MenuEntry,
    /// 0 là mục gốc, 1 là mục con.
    depth: u8,
    /// Chỉ số mục gốc: của chính nó (mục gốc) hoặc của mục cha (mục con).
    top: usize,
    has_children: bool,
}

/// Dòng trong danh sách điều hướng, theo đúng thứ tự hiển thị.
struct NavRow {
    enabled: bool,
    focus: FocusHandle,
    depth: u8,
    top: usize,
    has_children: bool,
}

struct Colors {
    surface: u32,
    border: u32,
    text: u32,
    text_2: u32,
    hover: u32,
    accent: u32,
}

impl Colors {
    fn of(is_dark: bool) -> Colors {
        if is_dark {
            Colors {
                surface: pack(dark::C_SURFACE),
                border: pack(dark::C_BORDER),
                text: pack(dark::C_TEXT),
                text_2: pack(dark::C_TEXT_2),
                hover: pack(dark::C_HOVER),
                accent: pack(dark::C_ACCENT),
            }
        } else {
            Colors {
                surface: pack(light::C_SURFACE),
                border: pack(light::C_BORDER),
                text: pack(light::C_TEXT),
                text_2: pack(light::C_TEXT_2),
                hover: pack(light::C_HOVER),
                accent: pack(light::C_ACCENT),
            }
        }
    }
}

/// `--shadow-md` của theme sáng hoặc tối, đổi blur sang σ như `dialog::shadow_lg` (D80).
pub fn shadow_md(is_dark: bool) -> Vec<BoxShadow> {
    let (main, near) = if is_dark {
        (0x0000_0066, 0x0000_004d)
    } else {
        (0x1018_2817, 0x1018_280f)
    };
    vec![bar(main, 4.0, 6.0), bar(near, 1.0, 1.5)]
}

fn bar(color: u32, offset_y: f32, blur: f32) -> BoxShadow {
    BoxShadow {
        color: gpui::rgba(color).into(),
        offset: point(px(0.), px(offset_y)),
        blur_radius: px(blur),
        spread_radius: px(0.),
    }
}

/// Chỉ số dòng đang có tiêu điểm trong danh sách điều hướng.
fn focused_row(nav: &[NavRow], window: &Window) -> Option<usize> {
    nav.iter().position(|r| r.focus.is_focused(window))
}

/// Đưa tiêu điểm tới mục kế tiếp dùng được, theo chiều `forward`.
fn move_focus(nav: &[NavRow], window: &mut Window, cx: &mut App, forward: bool) {
    let enabled: Vec<bool> = nav.iter().map(|r| r.enabled).collect();
    let current = focused_row(nav, window);
    if let Some(next) = next_enabled(&enabled, current, forward) {
        window.focus(&nav[next].focus, cx);
    }
}

/// Mở menu con của mục gốc `top` và đưa tiêu điểm vào mục con dùng được đầu tiên.
fn open_child(
    sub: &Entity<SubState>,
    child_nav: &[Vec<(bool, FocusHandle)>],
    top: usize,
    window: &mut Window,
    cx: &mut App,
) {
    sub.update(cx, |s, _| s.open = Some(top));
    window.refresh();
    if let Some((_, first)) = child_nav[top].iter().find(|(enabled, _)| *enabled) {
        let first = first.clone();
        window.defer(cx, move |window, cx| window.focus(&first, cx));
    }
}

/// Nếu tiêu điểm đang ở mục con, đóng menu con và trả tiêu điểm về mục cha. Trả `true` khi đã đóng.
fn close_child_if_focused(
    nav: &[NavRow],
    sub: &Entity<SubState>,
    parent_focus: &[FocusHandle],
    window: &mut Window,
    cx: &mut App,
) -> bool {
    let Some(f) = focused_row(nav, window) else {
        return false;
    };
    if nav[f].depth == 0 {
        return false;
    }
    let top = nav[f].top;
    sub.update(cx, |s, _| s.open = None);
    window.focus(&parent_focus[top], cx);
    window.refresh();
    true
}

/// Menu. Bên gọi giữ trạng thái mở và tiêu điểm; menu chỉ báo `on_select` và `on_dismiss`.
#[derive(IntoElement)]
pub struct Menu {
    id: ElementId,
    name: SharedString,
    entries: Vec<MenuEntry>,
    at: (f32, f32),
    width: f32,
    dark: bool,
    dismiss_on_outside: bool,
    on_select: Option<IndexFn>,
    on_dismiss: Option<DismissFn>,
    on_layout: Option<LayoutFn>,
}

impl Menu {
    /// `name` là nhãn truy cập của menu.
    pub fn new(
        id: impl Into<ElementId>,
        name: impl Into<SharedString>,
        entries: Vec<MenuEntry>,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            entries,
            at: (0.0, 0.0),
            width: 200.0,
            dark: false,
            dismiss_on_outside: true,
            on_select: None,
            on_dismiss: None,
            on_layout: None,
        }
    }

    /// Gọi sau mỗi lần bố cục với vùng của menu. Ô chọn dùng để biết chỗ nào là trong danh sách.
    pub fn on_layout(
        mut self,
        listener: impl Fn(gpui::Bounds<gpui::Pixels>, &mut App) + 'static,
    ) -> Self {
        self.on_layout = Some(Rc::new(listener));
        self
    }

    /// Vị trí góc trên trái trong khung chứa, pixel logic.
    pub fn at(mut self, x: f32, y: f32) -> Self {
        self.at = (x, y);
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

    /// Bấm ra ngoài menu thì đóng. Bên gọi tắt khi chính nó xử lý việc này (ví dụ select).
    pub fn dismiss_on_outside(mut self, on: bool) -> Self {
        self.dismiss_on_outside = on;
        self
    }

    /// Gọi với chỉ số dòng trong danh sách đang hiện. Khi một mục cha mở menu con, các mục đứng sau nó
    /// có chỉ số tăng thêm số mục con. Bên gọi không được giả định chỉ số của mục sau mục có menu con;
    /// nếu cần ổn định, dùng khóa theo `id` (ghi ở D84).
    pub fn on_select(mut self, listener: impl Fn(usize, &mut Window, &mut App) + 'static) -> Self {
        self.on_select = Some(Rc::new(listener));
        self
    }

    pub fn on_dismiss(mut self, listener: impl Fn(&mut Window, &mut App) + 'static) -> Self {
        self.on_dismiss = Some(Rc::new(listener));
        self
    }
}

impl RenderOnce for Menu {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let c = Colors::of(self.dark);
        let (x, y) = self.at;
        a11y::register(Registered {
            id: a11y::element_id_text(&self.id),
            role: "menu",
            name: self.name.to_string(),
            disabled: false,
            focused: false,
            hovered: false,
            checked: None,
            value: None,
            bounds: None,
        });

        // Trạng thái menu con. Đóng menu thì trạng thái này được đặt lại (xem `dismiss` và `on_select`).
        let sub = window.use_keyed_state(self.id.clone(), cx, |_, _| SubState::default());
        let open_sub = sub.read(cx).open;

        // Dòng hiện: mục gốc, và mục con của mục đang mở ngay sau mục cha.
        let mut visible: Vec<Visible> = Vec::new();
        let mut child_nav: Vec<Vec<(bool, FocusHandle)>> = Vec::new();
        let mut parent_focus: Vec<FocusHandle> = Vec::new();
        for (top, mut entry) in self.entries.into_iter().enumerate() {
            let children = std::mem::take(&mut entry.children);
            child_nav.push(
                children
                    .iter()
                    .map(|e| (!e.disabled, e.focus.clone()))
                    .collect(),
            );
            parent_focus.push(entry.focus.clone());
            let has_children = !children.is_empty();
            visible.push(Visible {
                entry,
                depth: 0,
                top,
                has_children,
            });
            if open_sub == Some(top) {
                for child in children {
                    visible.push(Visible {
                        entry: child,
                        depth: 1,
                        top,
                        has_children: false,
                    });
                }
            }
        }
        let nav: Rc<Vec<NavRow>> = Rc::new(
            visible
                .iter()
                .map(|v| NavRow {
                    enabled: !v.entry.disabled,
                    focus: v.entry.focus.clone(),
                    depth: v.depth,
                    top: v.top,
                    has_children: v.has_children,
                })
                .collect(),
        );
        let labels: Rc<Vec<String>> =
            Rc::new(visible.iter().map(|v| v.entry.label.to_string()).collect());
        let enabled: Rc<Vec<bool>> = Rc::new(nav.iter().map(|r| r.enabled).collect());
        let child_nav = Rc::new(child_nav);
        let parent_focus = Rc::new(parent_focus);

        let dismiss: DismissFn = {
            let listener = self.on_dismiss.clone();
            let sub = sub.clone();
            Rc::new(move |window, cx| {
                sub.update(cx, |s, _| s.open = None);
                if let Some(listener) = &listener {
                    listener(window, cx);
                }
            })
        };

        let mut panel = div()
            .id(self.id.clone())
            .key_context(CONTEXT)
            .absolute()
            .left(px(x))
            .top(px(y))
            .w(px(self.width))
            .flex()
            .flex_col()
            .p(px(shared::SPACE_2))
            .bg(rgba(c.surface))
            .border_1()
            .border_color(rgba(c.border))
            .rounded(px(shared::RADIUS_LG))
            .shadow(shadow_md(self.dark))
            .on_action({
                let nav = nav.clone();
                move |_: &MenuNext, window, cx| {
                    cx.stop_propagation();
                    move_focus(&nav, window, cx, true);
                }
            })
            .on_action({
                let nav = nav.clone();
                move |_: &MenuPrev, window, cx| {
                    cx.stop_propagation();
                    move_focus(&nav, window, cx, false);
                }
            })
            .on_action({
                let nav = nav.clone();
                let sub = sub.clone();
                let child_nav = child_nav.clone();
                move |_: &MenuOpenSub, window, cx| {
                    cx.stop_propagation();
                    let Some(f) = focused_row(&nav, window) else {
                        return;
                    };
                    let row = &nav[f];
                    if row.depth != 0 || !row.has_children {
                        return;
                    }
                    let top = row.top;
                    open_child(&sub, &child_nav, top, window, cx);
                }
            })
            .on_action({
                let nav = nav.clone();
                let sub = sub.clone();
                let parent_focus = parent_focus.clone();
                move |_: &MenuCloseSub, window, cx| {
                    cx.stop_propagation();
                    close_child_if_focused(&nav, &sub, &parent_focus, window, cx);
                }
            })
            .on_action({
                let nav = nav.clone();
                let sub = sub.clone();
                let parent_focus = parent_focus.clone();
                let dismiss = dismiss.clone();
                move |_: &MenuDismiss, window, cx| {
                    cx.stop_propagation();
                    if !close_child_if_focused(&nav, &sub, &parent_focus, window, cx) {
                        dismiss(window, cx);
                    }
                }
            })
            .on_key_down({
                let nav = nav.clone();
                let labels = labels.clone();
                let enabled = enabled.clone();
                move |event: &KeyDownEvent, window, cx| {
                    let k = &event.keystroke;
                    if k.modifiers.control || k.modifiers.alt || k.modifiers.platform {
                        return;
                    }
                    let mut chars = k.key.chars();
                    let (Some(ch), None) = (chars.next(), chars.next()) else {
                        return;
                    };
                    if ch.is_control() || ch.is_whitespace() {
                        return;
                    }
                    let current = focused_row(&nav, window);
                    if let Some(i) = typeahead(&labels, &enabled, current, &ch.to_string()) {
                        window.focus(&nav[i].focus, cx);
                    }
                }
            });
        if self.dismiss_on_outside {
            let dismiss = dismiss.clone();
            panel = panel.on_mouse_down_out(move |_, window, cx| dismiss(window, cx));
        }

        // Chỉ số `flat` là vị trí trong danh sách hiện tại; `on_select` nhận đúng chỉ số này.
        for (flat, v) in visible.into_iter().enumerate() {
            let Visible {
                entry,
                depth,
                top,
                has_children,
            } = v;
            let entry_id = entry.id.clone();
            a11y::register(Registered {
                id: a11y::element_id_text(&entry.id),
                role: if entry.checked.is_some() {
                    "menuitemradio"
                } else {
                    "menuitem"
                },
                name: entry.label.to_string(),
                disabled: entry.disabled,
                focused: entry.focus.is_focused(window),
                hovered: false,
                checked: entry.checked.map(|on| if on { "true" } else { "false" }),
                // Phím tắt của mục, để E2E kiểm chữ hiển thị (R2.07 tiêu chí 3).
                value: entry.shortcut.as_ref().map(|s| s.to_string()),
                bounds: None,
            });
            let mut row = div()
                .id(entry.id.clone())
                .flex()
                .items_center()
                .gap(px(shared::SPACE_4))
                .h(px(30.))
                .px(px(shared::SPACE_4))
                .rounded(px(shared::RADIUS_SM))
                .text_size(px(shared::TEXT_MD))
                .text_color(rgba(c.text));
            if depth > 0 {
                row = row.pl(px(shared::SPACE_4 * 3.0));
            }
            // Dấu chọn: một ô cố định để chữ các mục thẳng hàng, dù mục có chọn hay không.
            if let Some(on) = entry.checked {
                row = row.child(
                    div()
                        .w(px(14.))
                        .flex()
                        .justify_center()
                        .text_color(rgba(c.accent))
                        .child(if on { "✓" } else { "" }),
                );
            }
            row = row.child(div().flex_1().min_w_0().child(entry.label.clone()));
            if let Some(shortcut) = entry.shortcut.clone() {
                row = row.child(
                    div()
                        .text_size(px(shared::TEXT_SM))
                        .text_color(rgba(c.text_2))
                        .child(shortcut),
                );
            } else if has_children {
                row = row.child(
                    div()
                        .text_size(px(shared::TEXT_SM))
                        .text_color(rgba(c.text_2))
                        .child("▸"),
                );
            }
            if entry.disabled {
                row = row.opacity(0.5);
            } else {
                let focus = entry.focus.tab_stop(false);
                row = row
                    .track_focus(&focus)
                    .cursor_pointer()
                    .focus(|s| s.bg(rgba(c.hover)))
                    .hover(|s| s.bg(rgba(c.hover)));
                if has_children {
                    let sub = sub.clone();
                    let child_nav = child_nav.clone();
                    row = row.on_click(move |_, window, cx| {
                        if sub.read(cx).open == Some(top) {
                            sub.update(cx, |s, _| s.open = None);
                            window.refresh();
                        } else {
                            open_child(&sub, &child_nav, top, window, cx);
                        }
                    });
                } else if let Some(listener) = self.on_select.clone() {
                    let sub = sub.clone();
                    row = row.on_click(move |_, window, cx| {
                        sub.update(cx, |s, _| s.open = None);
                        listener(flat, window, cx)
                    });
                }
            }
            // Đo vị trí mục để E2E bấm đúng chỗ (D81).
            let row_key = a11y::element_id_text(&entry_id);
            panel = panel.child(div().flex_none().child(row).on_children_prepainted(
                move |bounds, _, _| {
                    if let Some(b) = bounds.first() {
                        a11y::set_bounds(&row_key, *b);
                    }
                },
            ));
        }
        // Chỉ đo vị trí khung để E2E kiểm vị trí menu chuột phải (D81).
        let key = a11y::element_id_text(&self.id);
        let layout = self.on_layout.clone();
        div()
            .flex_none()
            .child(panel)
            .on_children_prepainted(move |bounds, _, cx| {
                if let Some(b) = bounds.first() {
                    a11y::set_bounds(&key, *b);
                    if let Some(layout) = &layout {
                        layout(*b, cx);
                    }
                }
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn typeahead_moves_to_the_next_matching_item_and_wraps() {
        let l = labels(&["Mở", "Mở gần đây", "Lưu", "Đóng"]);
        let all = [true, true, true, true];
        // Gõ "m" từ đầu: mục 0 khớp, nhưng vì bắt đầu sau mục hiện tại nên tới mục 1.
        assert_eq!(typeahead(&l, &all, None, "m"), Some(0));
        assert_eq!(typeahead(&l, &all, Some(0), "m"), Some(1));
        assert_eq!(typeahead(&l, &all, Some(1), "m"), Some(0));
        assert_eq!(typeahead(&l, &all, Some(0), "l"), Some(2));
    }

    #[test]
    fn typeahead_skips_disabled_items_and_ignores_case() {
        let l = labels(&["Lưu", "Lưu thành", "Lùi"]);
        let enabled = [false, true, true];
        assert_eq!(typeahead(&l, &enabled, None, "L"), Some(1));
        assert_eq!(typeahead(&l, &enabled, None, "x"), None);
        assert_eq!(typeahead(&[], &[], None, "a"), None);
    }

    #[test]
    fn shadow_md_has_two_layers() {
        assert_eq!(shadow_md(false).len(), 2);
        assert_eq!(shadow_md(true).len(), 2);
    }
}
