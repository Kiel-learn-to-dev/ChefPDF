//! Nút (TASKS_RUST R2.03, BLUEPRINT_RUST §6.6): bản GPUI của `.btn` trong
//! apps/ui/src/components/components.css.
//!
//! Bốn biến thể (primary, secondary, ghost, danger), ba cỡ (sm, md, lg), trạng thái hover và active
//! theo token, vòng focus `:focus-visible` bằng hai bóng (D80: blur 0,5 px), con trỏ tay, và
//! `opacity` 0,5 khi bị vô hiệu. Bấm bằng Enter và Space khi có tiêu điểm đã do GPUI làm.
//!
//! Màu và kích thước tính bằng hàm thuần ([`paint`], [`geometry`]) để kiểm thử không cần cửa sổ.

use std::time::{Duration, Instant};

use chef_theme::{Rgba, dark, light, shared};
use gpui::{
    App, BoxShadow, ClickEvent, Div, ElementId, FocusHandle, FontWeight, IntoElement, KeyBinding,
    MouseButton, RenderOnce, SharedString, Window, actions, div, point, prelude::*, px, rgba, svg,
};

use crate::a11y::{self, Registered};

actions!(chef_ui_button, [FocusNext, FocusPrev]);

/// Gắn Tab và Shift+Tab cho điều hướng tiêu điểm. Gọi một lần lúc khởi động.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("tab", FocusNext, None),
        KeyBinding::new("shift-tab", FocusPrev, None),
    ]);
}

/// Đăng ký hành động Tab và Shift+Tab lên một khung gốc. GPUI không tự đi tới tiêu điểm kế tiếp.
pub fn focus_nav(root: Div) -> Div {
    root.on_action(|_: &FocusNext, window, cx| window.focus_next(cx))
        .on_action(|_: &FocusPrev, window, cx| window.focus_prev(cx))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Variant {
    Primary,
    Secondary,
    Ghost,
    Danger,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Size {
    Sm,
    Md,
    Lg,
}

/// Màu của một nút, dạng RRGGBBAA để giữ alpha của token (hover và active của ghost là RGBA).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Paint {
    pub bg: u32,
    pub bg_hover: u32,
    pub bg_active: u32,
    pub border: u32,
    pub border_hover: u32,
    pub text: u32,
    pub text_hover: u32,
    pub surface: u32,
    pub focus: u32,
}

/// Kích thước theo cỡ, pixel logic (token của chef-theme).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Geometry {
    pub height: f32,
    pub padding_x: f32,
    pub radius: f32,
    pub text: f32,
    pub icon: f32,
}

pub fn pack(c: Rgba) -> u32 {
    u32::from_be_bytes(c)
}

/// Bảng màu theo biến thể, khớp các quy tắc `.btn--*` trong components.css.
/// Trạng thái không có quy tắc riêng trong CSS (ví dụ active của secondary) giữ màu thường.
pub fn paint(variant: Variant, is_dark: bool) -> Paint {
    let t = if is_dark { Tokens::DARK } else { Tokens::LIGHT };
    let transparent = 0;
    let white = 0xffff_ffff;
    match variant {
        Variant::Primary => Paint {
            bg: pack(t.accent),
            bg_hover: pack(t.accent_hover),
            bg_active: pack(t.accent_active),
            border: transparent,
            border_hover: transparent,
            text: pack(t.text_on_accent),
            text_hover: pack(t.text_on_accent),
            surface: pack(t.surface),
            focus: pack(t.focus),
        },
        Variant::Secondary => Paint {
            bg: pack(t.surface),
            bg_hover: pack(t.surface_2),
            bg_active: pack(t.surface),
            border: pack(t.border_strong),
            border_hover: pack(t.text_3),
            text: pack(t.text),
            text_hover: pack(t.text),
            surface: pack(t.surface),
            focus: pack(t.focus),
        },
        Variant::Ghost => Paint {
            bg: transparent,
            bg_hover: pack(t.hover),
            bg_active: transparent,
            border: transparent,
            border_hover: transparent,
            text: pack(t.text_2),
            text_hover: pack(t.text),
            surface: pack(t.surface),
            focus: pack(t.focus),
        },
        Variant::Danger => Paint {
            bg: pack(t.danger),
            bg_hover: pack(t.danger_hover),
            bg_active: pack(t.danger),
            border: transparent,
            border_hover: transparent,
            text: white,
            text_hover: white,
            surface: pack(t.surface),
            focus: pack(t.focus),
        },
    }
}

pub fn geometry(size: Size) -> Geometry {
    match size {
        Size::Sm => Geometry {
            height: shared::CONTROL_H_SM,
            padding_x: shared::SPACE_5,
            radius: shared::RADIUS_SM,
            text: shared::TEXT_SM,
            icon: 14.0,
        },
        Size::Md => Geometry {
            height: shared::CONTROL_H,
            padding_x: shared::SPACE_6,
            radius: shared::RADIUS_MD,
            text: shared::TEXT_MD,
            icon: 16.0,
        },
        Size::Lg => Geometry {
            height: shared::CONTROL_H_LG,
            padding_x: shared::SPACE_7,
            radius: shared::RADIUS_MD,
            text: shared::TEXT_MD,
            icon: 18.0,
        },
    }
}

/// Vòng focus `--focus-ring: 0 0 0 2px surface, 0 0 0 4px focus`. Blur 0,5 px vì blur 0 không vẽ
/// (D80). Hai bóng theo thứ tự CSS: khe 2 px màu nền, rồi viền 2 px màu focus.
pub fn focus_ring(paint: &Paint) -> Vec<BoxShadow> {
    vec![ring(paint.surface, 2.0), ring(paint.focus, 4.0)]
}

/// Một bóng lan có màu, dùng để vẽ vòng focus (D80: blur 0,5 px).
pub fn ring(color: u32, spread: f32) -> BoxShadow {
    BoxShadow {
        color: rgba(color).into(),
        offset: point(px(0.), px(0.)),
        blur_radius: px(0.5),
        spread_radius: px(spread),
    }
}

struct Tokens {
    accent: Rgba,
    accent_hover: Rgba,
    accent_active: Rgba,
    text_on_accent: Rgba,
    surface: Rgba,
    surface_2: Rgba,
    border_strong: Rgba,
    text: Rgba,
    text_2: Rgba,
    text_3: Rgba,
    hover: Rgba,
    danger: Rgba,
    danger_hover: Rgba,
    focus: Rgba,
}

impl Tokens {
    const LIGHT: Tokens = Tokens {
        accent: light::C_ACCENT,
        accent_hover: light::C_ACCENT_HOVER,
        accent_active: light::C_ACCENT_ACTIVE,
        text_on_accent: light::C_TEXT_ON_ACCENT,
        surface: light::C_SURFACE,
        surface_2: light::C_SURFACE_2,
        border_strong: light::C_BORDER_STRONG,
        text: light::C_TEXT,
        text_2: light::C_TEXT_2,
        text_3: light::C_TEXT_3,
        hover: light::C_HOVER,
        danger: light::C_DANGER,
        danger_hover: light::C_DANGER_HOVER,
        focus: light::C_FOCUS,
    };
    const DARK: Tokens = Tokens {
        accent: dark::C_ACCENT,
        accent_hover: dark::C_ACCENT_HOVER,
        accent_active: dark::C_ACCENT_ACTIVE,
        text_on_accent: dark::C_TEXT_ON_ACCENT,
        surface: dark::C_SURFACE,
        surface_2: dark::C_SURFACE_2,
        border_strong: dark::C_BORDER_STRONG,
        text: dark::C_TEXT,
        text_2: dark::C_TEXT_2,
        text_3: dark::C_TEXT_3,
        hover: dark::C_HOVER,
        danger: dark::C_DANGER,
        danger_hover: dark::C_DANGER_HOVER,
        focus: dark::C_FOCUS,
    };
}

/// Màu đang hiển thị của nút (RRGGBBAA): nền, viền và chữ.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Visual {
    pub bg: u32,
    pub border: u32,
    pub text: u32,
}

/// Màu đích theo trạng thái con trỏ, khớp `.btn--*:hover` và `:active` trong components.css.
/// Active nằm sau hover trong CSS nên thắng về nền.
pub fn visual(paint: &Paint, hovered: bool, pressed: bool) -> Visual {
    match (pressed, hovered) {
        (true, hovered) => Visual {
            bg: paint.bg_active,
            border: if hovered {
                paint.border_hover
            } else {
                paint.border
            },
            text: if hovered {
                paint.text_hover
            } else {
                paint.text
            },
        },
        (false, true) => Visual {
            bg: paint.bg_hover,
            border: paint.border_hover,
            text: paint.text_hover,
        },
        (false, false) => Visual {
            bg: paint.bg,
            border: paint.border,
            text: paint.text,
        },
    }
}

/// Nội suy từng kênh RGBA giữa hai màu, `t` trong [0, 1].
pub fn lerp_color(from: u32, to: u32, t: f32) -> u32 {
    let a = from.to_be_bytes();
    let b = to.to_be_bytes();
    let mut out = [0u8; 4];
    for i in 0..4 {
        let v = a[i] as f32 + (b[i] as f32 - a[i] as f32) * t;
        out[i] = v.round().clamp(0.0, 255.0) as u8;
    }
    u32::from_be_bytes(out)
}

/// Đường cong bezier lập phương CSS (`cubic-bezier(x1, y1, x2, y2)`): tìm tham số `s` có
/// `x(s) = t` bằng chia đôi, rồi trả `y(s)`.
pub fn cubic_bezier(x1: f32, y1: f32, x2: f32, y2: f32) -> impl Fn(f32) -> f32 {
    move |t: f32| {
        let t = t.clamp(0.0, 1.0);
        let bezier = |s: f32, p1: f32, p2: f32| {
            let u = 1.0 - s;
            3.0 * u * u * s * p1 + 3.0 * u * s * s * p2 + s * s * s
        };
        let (mut lo, mut hi) = (0.0f32, 1.0f32);
        for _ in 0..40 {
            let mid = (lo + hi) / 2.0;
            if bezier(mid, x1, x2) < t {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        bezier((lo + hi) / 2.0, y1, y2)
    }
}

/// Trạng thái con trỏ của một nút, giữ qua các lần vẽ theo `id`. `changed_at` là lúc đích đổi
/// lần cuối; màu đi từ `from` tới đích trong `--dur-fast`.
///
/// Không dùng `with_animation` để chuyển màu: khóa của animation phải đổi mỗi lần đổi đích, mà đổi
/// khóa đổi id của phần tử, làm GPUI mất trạng thái nhấn và không phát `on_click` (lỗi tìm ra ở
/// e2e-native-dialog). Màu được nội suy thủ công và phần tử giữ nguyên qua các lần vẽ.
#[derive(Default)]
pub struct Feedback {
    hovered: bool,
    pressed: bool,
    from: Visual,
    changed_at: Option<Instant>,
}

/// Tiến độ đã làm mượt (0 đến 1) của chuyển màu sau `elapsed`, theo `--dur-fast` và `--ease`.
pub fn fade_progress(elapsed: Duration) -> f32 {
    let total = Duration::from_millis(shared::DUR_FAST as u64).as_secs_f32();
    let t = (elapsed.as_secs_f32() / total).min(1.0);
    cubic_bezier(0.2, 0.0, 0.0, 1.0)(t)
}

type ClickListener = Box<dyn Fn(&ClickEvent, &mut Window, &mut App)>;

/// Nút. Mọi nút có `id` ổn định để kênh debug và E2E tìm được.
#[derive(IntoElement)]
pub struct Button {
    id: ElementId,
    focus: FocusHandle,
    label: Option<SharedString>,
    icon: Option<SharedString>,
    aria_label: Option<SharedString>,
    variant: Variant,
    size: Size,
    dark: bool,
    disabled: bool,
    on_click: Option<ClickListener>,
}

impl Button {
    /// `focus` là tiêu điểm của nút, tạo bằng `cx.focus_handle()` ở view cha.
    pub fn new(id: impl Into<ElementId>, focus: FocusHandle) -> Self {
        Self {
            id: id.into(),
            focus,
            label: None,
            icon: None,
            aria_label: None,
            variant: Variant::Secondary,
            size: Size::Md,
            dark: false,
            disabled: false,
            on_click: None,
        }
    }

    pub fn label(mut self, label: impl Into<SharedString>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// Đường dẫn icon trong tài nguyên nhúng, ví dụ `icons/check.svg`.
    pub fn icon(mut self, path: impl Into<SharedString>) -> Self {
        self.icon = Some(path.into());
        self
    }

    /// Nhãn truy cập cho nút chỉ có icon. GPUI không có cây truy cập, nên nhãn này chưa được đọc
    /// bởi trình đọc màn hình; hiện được qua tooltip (R2.11) và kênh debug.
    pub fn aria_label(mut self, label: impl Into<SharedString>) -> Self {
        self.aria_label = Some(label.into());
        self
    }

    pub fn variant(mut self, variant: Variant) -> Self {
        self.variant = variant;
        self
    }

    pub fn size(mut self, size: Size) -> Self {
        self.size = size;
        self
    }

    pub fn dark(mut self, dark: bool) -> Self {
        self.dark = dark;
        self
    }

    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    pub fn on_click(
        mut self,
        listener: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_click = Some(Box::new(listener));
        self
    }
}

impl RenderOnce for Button {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let paint = paint(self.variant, self.dark);
        let geo = geometry(self.size);
        let key = a11y::element_id_text(&self.id);
        // D81: nút chỉ có icon phải có nhãn truy cập. Tên dùng cho kênh debug và E2E.
        let name = self
            .label
            .as_ref()
            .or(self.aria_label.as_ref())
            .map(|s| s.to_string())
            .unwrap_or_default();
        debug_assert!(
            !name.is_empty(),
            "nút {key} không có label hoặc aria_label (D81)"
        );
        let focused = self.focus.is_focused(window);
        // Nút vô hiệu không nhận Tab. Nút còn lại là điểm dừng của Tab.
        let focus = self.focus.tab_stop(!self.disabled);
        let ring = focus_ring(&paint);
        let feedback = window.use_keyed_state(self.id.clone(), cx, |_, _| Feedback::default());
        let (hovered, pressed, from, changed_at) = {
            let state = feedback.read(cx);
            (state.hovered, state.pressed, state.from, state.changed_at)
        };
        let target = visual(&paint, hovered, pressed);
        // Chưa từng đổi đích (changed_at là None) thì vẽ luôn màu đích, không chuyển.
        let fade = changed_at.map(|at| fade_progress(Instant::now().saturating_duration_since(at)));
        let shown = match fade {
            Some(p) if p < 1.0 => {
                window.request_animation_frame();
                Visual {
                    bg: lerp_color(from.bg, target.bg, p),
                    border: lerp_color(from.border, target.border, p),
                    text: lerp_color(from.text, target.text, p),
                }
            }
            _ => target,
        };
        a11y::register(Registered {
            id: key.clone(),
            role: "button",
            name,
            disabled: self.disabled,
            focused,
            hovered,
            checked: None,
            value: None,
            bounds: None,
        });

        let mut button = div()
            .id(self.id.clone())
            .track_focus(&focus)
            .flex()
            .flex_row()
            .items_center()
            .justify_center()
            .gap(px(shared::SPACE_3))
            .h(px(geo.height))
            .px(px(geo.padding_x))
            .rounded(px(geo.radius))
            .border_1()
            .border_color(rgba(shown.border))
            .bg(rgba(shown.bg))
            .text_color(rgba(shown.text))
            .text_size(px(geo.text))
            .font_weight(FontWeight::MEDIUM)
            .whitespace_nowrap()
            .focus_visible(|s| s.shadow(ring));

        if self.disabled {
            button = button.opacity(0.5);
        } else {
            button = button.cursor_pointer();
            let on_hover = feedback.clone();
            let on_press = feedback.clone();
            let on_release = feedback.clone();
            button = button
                .on_hover(move |is_hovered, window, cx| {
                    on_hover.update(cx, |f, _| {
                        if f.hovered == *is_hovered {
                            return;
                        }
                        f.from = visual(&paint, f.hovered, f.pressed);
                        f.hovered = *is_hovered;
                        if !*is_hovered {
                            f.pressed = false;
                        }
                        f.changed_at = Some(Instant::now());
                    });
                    window.refresh();
                })
                .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                    on_press.update(cx, |f, _| {
                        if f.pressed {
                            return;
                        }
                        f.from = visual(&paint, f.hovered, f.pressed);
                        f.pressed = true;
                        f.changed_at = Some(Instant::now());
                    });
                    window.refresh();
                })
                .on_mouse_up(MouseButton::Left, move |_, window, cx| {
                    on_release.update(cx, |f, _| {
                        if !f.pressed {
                            return;
                        }
                        f.from = visual(&paint, f.hovered, f.pressed);
                        f.pressed = false;
                        f.changed_at = Some(Instant::now());
                    });
                    window.refresh();
                });
            if let Some(listener) = self.on_click {
                button = button.on_click(listener);
            }
        }

        if let Some(icon) = self.icon {
            button = button.child(
                svg()
                    .path(icon)
                    .size(px(geo.icon))
                    .flex_none()
                    .text_color(rgba(shown.text)),
            );
        }
        if let Some(label) = self.label {
            button = button.child(label);
        }

        let element = button.into_any_element();
        // Lớp bọc chỉ để đo vị trí nút sau layout (on_children_prepainted đưa bounds của con).
        div()
            .flex_none()
            .child(element)
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
    fn fade_runs_from_zero_to_one_within_dur_fast_and_never_back() {
        assert!(fade_progress(Duration::ZERO).abs() < 1e-3);
        assert!((fade_progress(Duration::from_millis(100)) - 1.0).abs() < 1e-3);
        assert!((fade_progress(Duration::from_secs(5)) - 1.0).abs() < 1e-6);
        let mut last = 0.0_f32;
        for ms in (0..=120).step_by(5) {
            let p = fade_progress(Duration::from_millis(ms));
            assert!(p + 1e-6 >= last, "tiến độ lùi tại {ms} ms: {last} -> {p}");
            last = p;
        }
    }

    #[test]
    fn primary_uses_accent_tokens() {
        let p = paint(Variant::Primary, false);
        assert_eq!(p.bg, pack(light::C_ACCENT));
        assert_eq!(p.bg_hover, pack(light::C_ACCENT_HOVER));
        assert_eq!(p.bg_active, pack(light::C_ACCENT_ACTIVE));
        assert_eq!(p.text, pack(light::C_TEXT_ON_ACCENT));
    }

    #[test]
    fn secondary_hover_changes_surface_and_border() {
        let p = paint(Variant::Secondary, true);
        assert_eq!(p.bg, pack(dark::C_SURFACE));
        assert_eq!(p.bg_hover, pack(dark::C_SURFACE_2));
        assert_eq!(p.border, pack(dark::C_BORDER_STRONG));
        assert_eq!(p.border_hover, pack(dark::C_TEXT_3));
        // Secondary không có quy tắc :active trong CSS: giữ màu nền thường.
        assert_eq!(p.bg_active, p.bg);
    }

    #[test]
    fn ghost_is_transparent_and_hover_keeps_alpha() {
        let p = paint(Variant::Ghost, false);
        assert_eq!(p.bg, 0, "nền ghost trong suốt");
        // C_HOVER là RGBA trong suốt: alpha phải được giữ, không về 255.
        assert_eq!(p.bg_hover & 0xff, light::C_HOVER[3] as u32);
        assert_eq!(p.text, pack(light::C_TEXT_2));
        assert_eq!(p.text_hover, pack(light::C_TEXT));
    }

    #[test]
    fn danger_text_is_white() {
        assert_eq!(paint(Variant::Danger, false).text, 0xffff_ffff);
        assert_eq!(paint(Variant::Danger, false).bg, pack(light::C_DANGER));
    }

    #[test]
    fn sizes_match_the_css_scale() {
        assert_eq!(geometry(Size::Sm).height, 26.0);
        assert_eq!(geometry(Size::Md).height, 32.0);
        assert_eq!(geometry(Size::Lg).height, 38.0);
        assert_eq!(geometry(Size::Sm).padding_x, 12.0);
        assert_eq!(geometry(Size::Md).padding_x, 16.0);
        assert_eq!(geometry(Size::Lg).padding_x, 20.0);
        assert_eq!(geometry(Size::Sm).radius, 5.0);
        assert_eq!(geometry(Size::Md).radius, 7.0);
    }

    #[test]
    fn focus_ring_has_gap_then_outer_ring() {
        let ring = focus_ring(&paint(Variant::Secondary, false));
        assert_eq!(ring.len(), 2);
        assert_eq!(ring[0].spread_radius, px(2.0));
        assert_eq!(ring[0].color, rgba(pack(light::C_SURFACE)).into());
        assert_eq!(ring[1].spread_radius, px(4.0));
        assert_eq!(ring[1].blur_radius, px(0.5));
    }

    #[test]
    fn active_wins_over_hover_for_primary() {
        let p = paint(Variant::Primary, false);
        assert_eq!(visual(&p, true, true).bg, pack(light::C_ACCENT_ACTIVE));
        assert_eq!(visual(&p, true, false).bg, pack(light::C_ACCENT_HOVER));
        assert_eq!(visual(&p, false, false).bg, pack(light::C_ACCENT));
    }

    #[test]
    fn lerp_hits_endpoints_and_midpoint() {
        let a = 0x0000_0000;
        let b = 0xff80_40ff;
        assert_eq!(lerp_color(a, b, 0.0), a);
        assert_eq!(lerp_color(a, b, 1.0), b);
        assert_eq!(lerp_color(a, b, 0.5), 0x8040_2080);
    }

    #[test]
    fn ease_matches_css_endpoints_and_is_monotonic() {
        let ease = cubic_bezier(0.2, 0.0, 0.0, 1.0);
        assert!(ease(0.0).abs() < 1e-4);
        assert!((ease(1.0) - 1.0).abs() < 1e-4);
        let mut prev = 0.0;
        for i in 1..=20 {
            let y = ease(i as f32 / 20.0);
            assert!(y + 1e-4 >= prev, "không đơn điệu tại {i}");
            prev = y;
        }
        // --ease tăng nhanh lúc đầu: tới nửa thời gian đã vượt 80% quãng đường.
        assert!(ease(0.5) > 0.8);
    }
}
