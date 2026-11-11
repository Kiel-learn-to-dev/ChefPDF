//! Điều khiển chọn và thanh trượt (TASKS_RUST R2.05, BLUEPRINT_RUST §6.6): nhóm nút chọn một
//! (`.radio-row`, `.radio-dot`), nhóm nút bật (`.segmented`) và thanh trượt (`.slider`).
//!
//! - Mỗi nhóm chỉ có một điểm dừng Tab (roving focus): mục đang chọn, hoặc mục đầu nếu chưa chọn.
//! - Nhóm chọn một: mũi tên chuyển tiêu điểm và chọn luôn, như Radix. Space hoặc Enter chọn mục
//!   đang có tiêu điểm (GPUI kích hoạt `on_click` cho cả hai phím).
//! - Nhóm nút bật: mũi tên chỉ chuyển tiêu điểm. Space hoặc Enter bật mục.
//! - Thanh trượt: mũi tên một bước; PageUp, PageDown và Shift+mũi tên mười bước; Home và End về
//!   min và max. Bấm chuột để đặt giá trị và kéo chưa làm (ghi ở TASKS_RUST).
//!
//! Hàm thuần ([`next_enabled`], [`slider_step`]) được kiểm thử không cần cửa sổ.

use std::rc::Rc;

use chef_theme::{dark, light, shared};
use gpui::{
    App, BoxShadow, ElementId, FocusHandle, FontWeight, IntoElement, KeyBinding, RenderOnce,
    SharedString, Window, actions, div, point, prelude::*, px, relative, rgba,
};

use crate::a11y::{self, Registered};
use crate::button::{pack, ring};

actions!(
    chef_ui_choice,
    [
        GroupPrev,
        GroupNext,
        SliderInc,
        SliderDec,
        SliderBigInc,
        SliderBigDec,
        SliderMin,
        SliderMax,
    ]
);

/// Ngữ cảnh phím của nhóm chọn và nhóm nút bật.
pub const GROUP_CONTEXT: &str = "ChefChoice";
/// Ngữ cảnh phím của thanh trượt.
pub const SLIDER_CONTEXT: &str = "ChefSlider";

/// Gắn phím cho nhóm và thanh trượt. Gọi một lần lúc khởi động.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("up", GroupPrev, Some(GROUP_CONTEXT)),
        KeyBinding::new("left", GroupPrev, Some(GROUP_CONTEXT)),
        KeyBinding::new("down", GroupNext, Some(GROUP_CONTEXT)),
        KeyBinding::new("right", GroupNext, Some(GROUP_CONTEXT)),
        KeyBinding::new("up", SliderInc, Some(SLIDER_CONTEXT)),
        KeyBinding::new("right", SliderInc, Some(SLIDER_CONTEXT)),
        KeyBinding::new("down", SliderDec, Some(SLIDER_CONTEXT)),
        KeyBinding::new("left", SliderDec, Some(SLIDER_CONTEXT)),
        KeyBinding::new("shift-up", SliderBigInc, Some(SLIDER_CONTEXT)),
        KeyBinding::new("shift-right", SliderBigInc, Some(SLIDER_CONTEXT)),
        KeyBinding::new("shift-down", SliderBigDec, Some(SLIDER_CONTEXT)),
        KeyBinding::new("shift-left", SliderBigDec, Some(SLIDER_CONTEXT)),
        KeyBinding::new("pageup", SliderBigInc, Some(SLIDER_CONTEXT)),
        KeyBinding::new("pagedown", SliderBigDec, Some(SLIDER_CONTEXT)),
        KeyBinding::new("home", SliderMin, Some(SLIDER_CONTEXT)),
        KeyBinding::new("end", SliderMax, Some(SLIDER_CONTEXT)),
    ]);
}

/// Chỉ số mục kế tiếp theo chiều (`forward`), bỏ qua mục vô hiệu và vòng lại đầu hoặc cuối.
/// `None` khi không có mục nào dùng được. Khi `current` là `None`, tới mục đầu hoặc cuối tùy chiều.
pub fn next_enabled(enabled: &[bool], current: Option<usize>, forward: bool) -> Option<usize> {
    let n = enabled.len();
    if n == 0 || !enabled.iter().any(|e| *e) {
        return None;
    }
    let start = match current {
        Some(i) => i,
        None if forward => n - 1,
        None => 0,
    };
    for step in 1..=n {
        let idx = if forward {
            (start + step) % n
        } else {
            (start + n * step - step) % n
        };
        if enabled[idx] {
            return Some(idx);
        }
    }
    None
}

/// Mục có điểm dừng Tab trong nhóm: mục đã chọn nếu dùng được, còn lại là mục dùng được đầu tiên.
pub fn tab_stop_index(enabled: &[bool], selected: Option<usize>) -> Option<usize> {
    match selected {
        Some(i) if enabled.get(i).copied().unwrap_or(false) => Some(i),
        _ => enabled.iter().position(|e| *e),
    }
}

/// Giá trị sau `delta` bước từ `value`, làm tròn về lưới `min + k·step` và kẹp trong [min, max].
pub fn slider_step(value: f32, min: f32, max: f32, step: f32, delta: i32) -> f32 {
    if step <= 0.0 || max <= min {
        return value.clamp(min, max);
    }
    let raw = value + delta as f32 * step;
    let k = ((raw - min) / step).round();
    (min + k * step).clamp(min, max)
}

/// Tỉ lệ vị trí của giá trị trên thanh, trong [0, 1].
pub fn slider_fraction(value: f32, min: f32, max: f32) -> f32 {
    if max <= min {
        return 0.0;
    }
    ((value - min) / (max - min)).clamp(0.0, 1.0)
}

type IndexChange = Rc<dyn Fn(usize, &mut Window, &mut App)>;
type ValueChange = Rc<dyn Fn(f32, &mut Window, &mut App)>;

struct Colors {
    surface: u32,
    surface_sunken: u32,
    border: u32,
    border_strong: u32,
    border_hover: u32,
    text: u32,
    text_2: u32,
    accent: u32,
    focus: u32,
}

impl Colors {
    fn of(is_dark: bool) -> Colors {
        if is_dark {
            Colors {
                surface: pack(dark::C_SURFACE),
                surface_sunken: pack(dark::C_SURFACE_SUNKEN),
                border: pack(dark::C_BORDER),
                border_strong: pack(dark::C_BORDER_STRONG),
                border_hover: pack(dark::C_TEXT_3),
                text: pack(dark::C_TEXT),
                text_2: pack(dark::C_TEXT_2),
                accent: pack(dark::C_ACCENT),
                focus: pack(dark::C_FOCUS),
            }
        } else {
            Colors {
                surface: pack(light::C_SURFACE),
                surface_sunken: pack(light::C_SURFACE_SUNKEN),
                border: pack(light::C_BORDER),
                border_strong: pack(light::C_BORDER_STRONG),
                border_hover: pack(light::C_TEXT_3),
                text: pack(light::C_TEXT),
                text_2: pack(light::C_TEXT_2),
                accent: pack(light::C_ACCENT),
                focus: pack(light::C_FOCUS),
            }
        }
    }
}

fn focus_ring(c: &Colors) -> Vec<BoxShadow> {
    vec![ring(c.surface, 2.0), ring(c.focus, 4.0)]
}

/// Một mục của nhóm chọn một (`.radio-row`).
pub struct RadioItem {
    id: ElementId,
    focus: FocusHandle,
    label: SharedString,
    hint: Option<SharedString>,
    disabled: bool,
}

impl RadioItem {
    pub fn new(
        id: impl Into<ElementId>,
        focus: FocusHandle,
        label: impl Into<SharedString>,
    ) -> Self {
        Self {
            id: id.into(),
            focus,
            label: label.into(),
            hint: None,
            disabled: false,
        }
    }

    pub fn hint(mut self, hint: impl Into<SharedString>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }
}

/// Nhóm nút chọn một (`.radio-row` trong `RadioGroup` của Electron). Trạng thái chọn do bên gọi giữ.
#[derive(IntoElement)]
pub struct RadioGroup {
    id: ElementId,
    name: SharedString,
    items: Vec<RadioItem>,
    selected: Option<usize>,
    dark: bool,
    on_change: Option<IndexChange>,
}

impl RadioGroup {
    /// `name` là nhãn truy cập của nhóm (aria-label).
    pub fn new(
        id: impl Into<ElementId>,
        name: impl Into<SharedString>,
        items: Vec<RadioItem>,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            items,
            selected: None,
            dark: false,
            on_change: None,
        }
    }

    pub fn selected(mut self, index: Option<usize>) -> Self {
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

impl RenderOnce for RadioGroup {
    fn render(self, window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let c = Colors::of(self.dark);
        let enabled: Vec<bool> = self.items.iter().map(|i| !i.disabled).collect();
        let tab_stop = tab_stop_index(&enabled, self.selected);
        let focus_list: Rc<Vec<FocusHandle>> =
            Rc::new(self.items.iter().map(|i| i.focus.clone()).collect());
        let group_id = a11y::element_id_text(&self.id);
        a11y::register(Registered {
            id: group_id.clone(),
            role: "radiogroup",
            name: self.name.to_string(),
            disabled: false,
            focused: false,
            hovered: false,
            checked: None,
            value: None,
            bounds: None,
        });

        let mut root = div()
            .id(self.id.clone())
            .key_context(GROUP_CONTEXT)
            .flex()
            .flex_col();
        if let Some(listener) = self.on_change.clone() {
            let enabled_next = enabled.clone();
            let focus_next = focus_list.clone();
            let listener_next = listener.clone();
            root = root
                .on_action(move |_: &GroupNext, window, cx| {
                    cx.stop_propagation();
                    move_and_select(&enabled_next, &focus_next, &listener_next, window, cx, true);
                })
                .on_action({
                    let enabled = enabled.clone();
                    let focus_list = focus_list.clone();
                    move |_: &GroupPrev, window, cx| {
                        cx.stop_propagation();
                        move_and_select(&enabled, &focus_list, &listener, window, cx, false);
                    }
                });
        }

        for (i, item) in self.items.into_iter().enumerate() {
            let checked = self.selected == Some(i);
            a11y::register(Registered {
                id: a11y::element_id_text(&item.id),
                role: "radio",
                name: item.label.to_string(),
                disabled: item.disabled,
                focused: item.focus.is_focused(window),
                hovered: false,
                checked: Some(if checked { "true" } else { "false" }),
                value: None,
                bounds: None,
            });
            let focus = item.focus.tab_stop(tab_stop == Some(i) && !item.disabled);
            let (border, border_width) = if checked {
                (c.accent, 5.0)
            } else {
                (c.border_strong, 1.0)
            };
            let dot = div()
                .flex()
                .flex_none()
                .size(px(16.))
                .mt(px(shared::SPACE_1))
                .rounded_full()
                .border(px(border_width))
                .border_color(rgba(border))
                .bg(rgba(c.surface));
            let mut text = div().flex().flex_col().child(item.label.clone());
            if let Some(hint) = item.hint.clone() {
                text = text.child(
                    div()
                        .text_size(px(shared::TEXT_SM))
                        .text_color(rgba(c.border_hover))
                        .child(hint),
                );
            }
            let mut row = div()
                .id(item.id.clone())
                .track_focus(&focus)
                .flex()
                .items_start()
                .gap(px(shared::SPACE_4))
                .text_size(px(shared::TEXT_MD))
                .text_color(rgba(c.text))
                .focus_visible(|s| s.shadow(focus_ring(&c)))
                .when(i > 0, |r| r.mt(px(shared::SPACE_4)))
                .child(dot)
                .child(text);
            if item.disabled {
                row = row.opacity(0.5);
            } else {
                row = row.cursor_pointer();
                if let Some(listener) = self.on_change.clone() {
                    row = row.on_click(move |_, window, cx| listener(i, window, cx));
                }
            }
            // Đo vị trí hàng để E2E bấm đúng chỗ (D81).
            let row_key = a11y::element_id_text(&item.id);
            root = root.child(div().flex_none().child(row).on_children_prepainted(
                move |bounds, _, _| {
                    if let Some(b) = bounds.first() {
                        a11y::set_bounds(&row_key, *b);
                    }
                },
            ));
        }
        root
    }
}

/// Đưa tiêu điểm tới mục kế tiếp dùng được và chọn nó.
fn move_and_select(
    enabled: &[bool],
    focus: &[FocusHandle],
    listener: &IndexChange,
    window: &mut Window,
    cx: &mut App,
    forward: bool,
) {
    let current = focus.iter().position(|f| f.is_focused(window));
    if let Some(next) = next_enabled(enabled, current, forward) {
        window.focus(&focus[next], cx);
        listener(next, window, cx);
    }
}

/// Một mục của nhóm nút bật (`.segmented__item`).
pub struct ToggleItem {
    id: ElementId,
    focus: FocusHandle,
    label: SharedString,
}

impl ToggleItem {
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

/// Nhóm nút bật một lựa chọn (`.segmented`). Mũi tên chỉ chuyển tiêu điểm; Space và Enter chọn.
#[derive(IntoElement)]
pub struct ToggleGroup {
    id: ElementId,
    name: SharedString,
    items: Vec<ToggleItem>,
    selected: usize,
    dark: bool,
    on_change: Option<IndexChange>,
}

impl ToggleGroup {
    pub fn new(
        id: impl Into<ElementId>,
        name: impl Into<SharedString>,
        items: Vec<ToggleItem>,
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

impl RenderOnce for ToggleGroup {
    fn render(self, window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let c = Colors::of(self.dark);
        let enabled = vec![true; self.items.len()];
        let tab_stop = tab_stop_index(&enabled, Some(self.selected));
        let focus_list: Rc<Vec<FocusHandle>> =
            Rc::new(self.items.iter().map(|i| i.focus.clone()).collect());
        a11y::register(Registered {
            id: a11y::element_id_text(&self.id),
            role: "group",
            name: self.name.to_string(),
            disabled: false,
            focused: false,
            hovered: false,
            checked: None,
            value: None,
            bounds: None,
        });

        // Chỉ di chuyển tiêu điểm, không chọn: mũi tên không đổi lựa chọn trong nhóm nút bật.
        let mut root = div()
            .id(self.id.clone())
            .key_context(GROUP_CONTEXT)
            .flex()
            .flex_none()
            .items_center()
            .gap(px(shared::SPACE_1))
            .p(px(shared::SPACE_1))
            .rounded(px(shared::RADIUS_MD))
            .bg(rgba(c.surface_sunken))
            .border_1()
            .border_color(rgba(c.border))
            .on_action({
                let focus_list = focus_list.clone();
                let enabled = enabled.clone();
                move |_: &GroupNext, window, cx| {
                    cx.stop_propagation();
                    move_focus(&enabled, &focus_list, window, cx, true);
                }
            })
            .on_action({
                let focus_list = focus_list.clone();
                let enabled = enabled.clone();
                move |_: &GroupPrev, window, cx| {
                    cx.stop_propagation();
                    move_focus(&enabled, &focus_list, window, cx, false);
                }
            });

        for (i, item) in self.items.into_iter().enumerate() {
            let on = i == self.selected;
            a11y::register(Registered {
                id: a11y::element_id_text(&item.id),
                role: "button",
                name: item.label.to_string(),
                disabled: false,
                focused: item.focus.is_focused(window),
                hovered: false,
                checked: Some(if on { "true" } else { "false" }),
                value: None,
                bounds: None,
            });
            let focus = item.focus.tab_stop(tab_stop == Some(i));
            let mut segment = div()
                .id(item.id.clone())
                .track_focus(&focus)
                .flex()
                .items_center()
                .h(px(26.))
                .px(px(shared::SPACE_5))
                .rounded(px(shared::RADIUS_SM))
                .text_size(px(shared::TEXT_SM))
                .font_weight(FontWeight::MEDIUM)
                .text_color(rgba(if on { c.text } else { c.text_2 }))
                .cursor_pointer()
                .focus_visible(|s| s.shadow(focus_ring(&c)))
                .child(item.label.clone());
            if on {
                segment = segment
                    .bg(rgba(c.surface))
                    .shadow(vec![shadow_sm_bar(self.dark)]);
            } else {
                segment = segment.hover(|s| s.text_color(rgba(c.text)));
            }
            if let Some(listener) = self.on_change.clone() {
                segment = segment.on_click(move |_, window, cx| listener(i, window, cx));
            }
            // Đo vị trí mục để E2E bấm đúng chỗ (D81).
            let key = a11y::element_id_text(&item.id);
            root = root.child(div().flex_none().child(segment).on_children_prepainted(
                move |bounds, _, _| {
                    if let Some(b) = bounds.first() {
                        a11y::set_bounds(&key, *b);
                    }
                },
            ));
        }
        root
    }
}

fn move_focus(
    enabled: &[bool],
    focus: &[FocusHandle],
    window: &mut Window,
    cx: &mut App,
    forward: bool,
) {
    let current = focus.iter().position(|f| f.is_focused(window));
    if let Some(next) = next_enabled(enabled, current, forward) {
        window.focus(&focus[next], cx);
    }
}

/// Bóng `--shadow-sm` của mục đang chọn trong nhóm nút bật.
fn shadow_sm_bar(is_dark: bool) -> BoxShadow {
    let color = if is_dark { 0x0000_0059 } else { 0x1018_2814 };
    BoxShadow {
        color: rgba(color).into(),
        offset: point(px(0.), px(1.)),
        blur_radius: px(1.5),
        spread_radius: px(0.),
    }
}

/// Thanh trượt (`.slider`): một giá trị trong [min, max], bước `step`.
#[derive(IntoElement)]
pub struct Slider {
    id: ElementId,
    name: SharedString,
    focus: FocusHandle,
    value: f32,
    min: f32,
    max: f32,
    step: f32,
    width: f32,
    dark: bool,
    on_change: Option<ValueChange>,
}

impl Slider {
    pub fn new(
        id: impl Into<ElementId>,
        name: impl Into<SharedString>,
        focus: FocusHandle,
        value: f32,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            focus,
            value,
            min: 0.0,
            max: 100.0,
            step: 1.0,
            width: 120.0,
            dark: false,
            on_change: None,
        }
    }

    pub fn range(mut self, min: f32, max: f32, step: f32) -> Self {
        self.min = min;
        self.max = max;
        self.step = step;
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

    pub fn on_change(mut self, listener: impl Fn(f32, &mut Window, &mut App) + 'static) -> Self {
        self.on_change = Some(Rc::new(listener));
        self
    }
}

impl RenderOnce for Slider {
    fn render(self, window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let c = Colors::of(self.dark);
        let (min, max, step) = (self.min, self.max, self.step);
        let value = self.value.clamp(min, max);
        let fraction = slider_fraction(value, min, max);
        a11y::register(Registered {
            id: a11y::element_id_text(&self.id),
            role: "slider",
            name: self.name.to_string(),
            disabled: false,
            focused: self.focus.is_focused(window),
            hovered: false,
            checked: None,
            value: Some(format_value(value)),
            bounds: None,
        });

        let mut root = div()
            .id(self.id.clone())
            .key_context(SLIDER_CONTEXT)
            .track_focus(&self.focus.tab_stop(true))
            .relative()
            .flex()
            .items_center()
            .w(px(self.width))
            .h(px(20.))
            .focus_visible(|s| s.shadow(focus_ring(&c)))
            .rounded(px(shared::RADIUS_FULL));

        if let Some(listener) = self.on_change.clone() {
            // Mỗi bước đi qua `slider_step`, rồi chỉ báo khi giá trị thật sự đổi.
            let step_by = {
                let listener = listener.clone();
                Rc::new(move |delta: i32, window: &mut Window, cx: &mut App| {
                    let next = slider_step(value, min, max, step, delta);
                    if (next - value).abs() > f32::EPSILON {
                        listener(next, window, cx);
                    }
                })
            };
            root = root
                .on_action({
                    let step_by = step_by.clone();
                    move |_: &SliderInc, window, cx| {
                        cx.stop_propagation();
                        step_by(1, window, cx);
                    }
                })
                .on_action({
                    let step_by = step_by.clone();
                    move |_: &SliderDec, window, cx| {
                        cx.stop_propagation();
                        step_by(-1, window, cx);
                    }
                })
                .on_action({
                    let step_by = step_by.clone();
                    move |_: &SliderBigInc, window, cx| {
                        cx.stop_propagation();
                        step_by(10, window, cx);
                    }
                })
                .on_action({
                    let step_by = step_by.clone();
                    move |_: &SliderBigDec, window, cx| {
                        cx.stop_propagation();
                        step_by(-10, window, cx);
                    }
                })
                .on_action({
                    let listener = listener.clone();
                    move |_: &SliderMin, window, cx| {
                        cx.stop_propagation();
                        if (min - value).abs() > f32::EPSILON {
                            listener(min, window, cx);
                        }
                    }
                })
                .on_action({
                    let listener = listener.clone();
                    move |_: &SliderMax, window, cx| {
                        cx.stop_propagation();
                        if (max - value).abs() > f32::EPSILON {
                            listener(max, window, cx);
                        }
                    }
                });
        }

        // Rãnh, phần đã chạy và núm. Núm lệch nửa độ rộng để tâm nằm đúng vị trí giá trị.
        let track = div()
            .relative()
            .flex_1()
            .h(px(3.))
            .rounded(px(shared::RADIUS_FULL))
            .bg(rgba(c.border_strong))
            .child(
                div()
                    .absolute()
                    .top(px(0.))
                    .left(px(0.))
                    .h_full()
                    .w(relative(fraction))
                    .rounded(px(shared::RADIUS_FULL))
                    .bg(rgba(c.accent)),
            )
            .child(
                div()
                    .absolute()
                    .top(px(-5.5))
                    .left(relative(fraction))
                    .ml(px(-7.))
                    .size(px(14.))
                    .rounded(px(shared::RADIUS_FULL))
                    .bg(rgba(c.surface))
                    .border_1()
                    .border_color(rgba(c.border_strong))
                    .shadow(vec![shadow_sm_bar(self.dark)]),
            );
        root = root.child(track);
        root
    }
}

/// Giá trị hiển thị trong truy cập: số nguyên khi là số nguyên, còn lại thì một chữ số thập phân.
fn format_value(v: f32) -> String {
    if (v - v.round()).abs() < 1e-4 {
        format!("{}", v.round() as i64)
    } else {
        format!("{v:.1}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_enabled_skips_disabled_and_wraps() {
        let all = [true, true, true];
        assert_eq!(next_enabled(&all, Some(0), true), Some(1));
        assert_eq!(next_enabled(&all, Some(2), true), Some(0));
        assert_eq!(next_enabled(&all, Some(0), false), Some(2));
        let gap = [true, false, true];
        assert_eq!(next_enabled(&gap, Some(0), true), Some(2));
        assert_eq!(next_enabled(&gap, Some(2), false), Some(0));
    }

    #[test]
    fn next_enabled_without_current_enters_at_the_near_end() {
        let all = [true, true, true];
        assert_eq!(next_enabled(&all, None, true), Some(0));
        assert_eq!(next_enabled(&all, None, false), Some(2));
        assert_eq!(next_enabled(&[false, false], None, true), None);
        assert_eq!(next_enabled(&[], Some(0), true), None);
    }

    #[test]
    fn tab_stop_is_the_selected_item_or_the_first_usable_one() {
        assert_eq!(tab_stop_index(&[true, true, true], Some(1)), Some(1));
        assert_eq!(tab_stop_index(&[true, true, true], None), Some(0));
        assert_eq!(tab_stop_index(&[false, true], Some(0)), Some(1));
        assert_eq!(tab_stop_index(&[false, false], None), None);
    }

    #[test]
    fn slider_steps_snap_to_the_grid_and_clamp() {
        assert_eq!(slider_step(50.0, 0.0, 100.0, 5.0, 1), 55.0);
        assert_eq!(slider_step(50.0, 0.0, 100.0, 5.0, -10), 0.0);
        assert_eq!(slider_step(97.0, 0.0, 100.0, 5.0, 1), 100.0);
        assert_eq!(slider_step(3.0, 0.0, 10.0, 1.0, 10), 10.0);
        // Giá trị lệch lưới được kéo về lưới khi bước.
        assert_eq!(slider_step(52.0, 0.0, 100.0, 5.0, 1), 55.0);
    }

    #[test]
    fn slider_fraction_is_within_unit_range() {
        assert_eq!(slider_fraction(0.0, 0.0, 100.0), 0.0);
        assert_eq!(slider_fraction(50.0, 0.0, 100.0), 0.5);
        assert_eq!(slider_fraction(150.0, 0.0, 100.0), 1.0);
        assert_eq!(slider_fraction(5.0, 10.0, 10.0), 0.0);
    }

    #[test]
    fn values_read_as_integers_when_whole() {
        assert_eq!(format_value(50.0), "50");
        assert_eq!(format_value(12.5), "12.5");
    }
}
