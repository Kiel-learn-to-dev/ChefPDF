//! Tooltip (TASKS_RUST R2.11, BLUEPRINT_RUST §6.6): hiện sau 450 ms khi di chuột hoặc có tiêu điểm
//! bàn phím; khi đã có tooltip đang hiện, hoặc vừa đóng một tooltip trong 200 ms, thì chỉ chờ 200 ms
//! (`App.tsx` dùng `delayDuration={450}` và `skipDelayDuration={200}`).
//!
//! Trạng thái thời gian nằm trong keyed state theo `id`. Khi đang chờ, khung vẽ lại ở mỗi khung hình
//! cho tới lúc hiện, nên thời điểm hiện chính xác đến một khung hình.

use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use chef_theme::{dark, light, shared};
use gpui::{
    AnyElement, ElementId, FocusHandle, IntoElement, RenderOnce, SharedString, Window, div,
    prelude::*, px, relative, rgba,
};

use crate::a11y::{self, Registered};
use crate::button::pack;

/// Thời gian chờ trước khi hiện tooltip đầu tiên.
pub const SHOW_DELAY: Duration = Duration::from_millis(450);
/// Thời gian chờ khi đã có tooltip hiện, hoặc vừa đóng một tooltip.
pub const SKIP_DELAY: Duration = Duration::from_millis(200);

/// Số tooltip đang hiện trên toàn app.
static OPEN: AtomicUsize = AtomicUsize::new(0);
/// Lúc đóng tooltip gần nhất.
static LAST_CLOSE: Mutex<Option<Instant>> = Mutex::new(None);

/// Thời gian chờ cho một lần hiện mới ở thời điểm `now`.
pub fn delay_at(now: Instant, open_count: usize, last_close: Option<Instant>) -> Duration {
    let recently_closed = last_close.is_some_and(|t| now.saturating_duration_since(t) < SKIP_DELAY);
    if open_count > 0 || recently_closed {
        SKIP_DELAY
    } else {
        SHOW_DELAY
    }
}

/// Trạng thái giữ qua các lần vẽ.
#[derive(Default)]
struct TipState {
    /// Lúc bắt đầu được kích hoạt (di chuột vào hoặc có tiêu điểm). None khi không kích hoạt.
    since: Option<Instant>,
    /// Thời gian chờ được chốt lúc kích hoạt, không tính lại theo khung sau đó.
    delay: Duration,
    shown: bool,
}

fn mark_closed(state: &mut TipState) {
    if state.shown {
        state.shown = false;
        OPEN.fetch_sub(1, Ordering::SeqCst);
        if let Ok(mut last) = LAST_CLOSE.lock() {
            *last = Some(Instant::now());
        }
    }
    state.since = None;
}

/// Bọc một điều khiển có tooltip. `text` là nội dung hiện; `focus` là tiêu điểm của điều khiển, để
/// tooltip cũng hiện khi dùng bàn phím.
#[derive(IntoElement)]
pub struct Tooltip {
    id: ElementId,
    text: SharedString,
    focus: Option<FocusHandle>,
    dark: bool,
    child: AnyElement,
}

impl Tooltip {
    pub fn new(
        id: impl Into<ElementId>,
        text: impl Into<SharedString>,
        child: impl IntoElement,
    ) -> Self {
        Self {
            id: id.into(),
            text: text.into(),
            focus: None,
            dark: false,
            child: child.into_any_element(),
        }
    }

    pub fn focus(mut self, focus: FocusHandle) -> Self {
        self.focus = Some(focus);
        self
    }

    pub fn dark(mut self, dark: bool) -> Self {
        self.dark = dark;
        self
    }
}

impl RenderOnce for Tooltip {
    fn render(self, window: &mut Window, cx: &mut gpui::App) -> impl IntoElement {
        let state = window.use_keyed_state(self.id.clone(), cx, |_, _| TipState::default());
        let focused = self.focus.as_ref().is_some_and(|f| f.is_focused(window));
        let (since, shown) = {
            let s = state.read(cx);
            (s.since, s.shown)
        };
        let now = Instant::now();
        let active = focused || since.is_some();
        let mut show_now = shown;
        state.update(cx, |s, _| {
            if active && s.since.is_none() {
                s.since = Some(now);
                s.delay = delay_at(
                    now,
                    OPEN.load(Ordering::SeqCst),
                    LAST_CLOSE.lock().ok().and_then(|l| *l),
                );
            }
            if !active {
                mark_closed(s);
            } else if !s.shown
                && s.since
                    .is_some_and(|t| now.saturating_duration_since(t) >= s.delay)
            {
                s.shown = true;
                OPEN.fetch_add(1, Ordering::SeqCst);
                show_now = true;
            }
        });
        if active && !show_now {
            // Đang chờ: vẽ lại ở khung kế để kiểm tra lại thời gian.
            window.request_animation_frame();
        }

        let (inverse, inverse_text) = if self.dark {
            (pack(dark::C_INVERSE_BG), pack(dark::C_INVERSE_TEXT))
        } else {
            (pack(light::C_INVERSE_BG), pack(light::C_INVERSE_TEXT))
        };

        let state_hover = state.clone();
        let mut wrapper = div()
            .id(format!("{}-wrap", a11y::element_id_text(&self.id)))
            .relative()
            .flex_none()
            .on_hover(move |hovered, window, cx| {
                state_hover.update(cx, |s, _| {
                    if *hovered {
                        if s.since.is_none() {
                            s.since = Some(Instant::now());
                            s.delay = delay_at(
                                Instant::now(),
                                OPEN.load(Ordering::SeqCst),
                                LAST_CLOSE.lock().ok().and_then(|l| *l),
                            );
                        }
                    } else {
                        mark_closed(s);
                    }
                });
                window.refresh();
            })
            .child(self.child);

        if show_now {
            let tip_id = format!("{}-tip", a11y::element_id_text(&self.id));
            a11y::register(Registered {
                id: tip_id.clone(),
                role: "tooltip",
                name: self.text.to_string(),
                disabled: false,
                focused: false,
                hovered: false,
                checked: None,
                value: None,
                bounds: None,
            });
            wrapper = wrapper.child(
                div()
                    .id(tip_id)
                    .absolute()
                    .top(relative(1.0))
                    .left(px(0.))
                    .mt(px(6.))
                    .px(px(shared::SPACE_4))
                    .py(px(shared::SPACE_2))
                    .rounded(px(shared::RADIUS_SM))
                    .bg(rgba(inverse))
                    .text_color(rgba(inverse_text))
                    .text_size(px(shared::TEXT_SM))
                    .whitespace_nowrap()
                    .child(self.text),
            );
        }
        wrapper
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_tooltip_waits_the_full_delay() {
        let now = Instant::now();
        assert_eq!(delay_at(now, 0, None), Duration::from_millis(450));
    }

    #[test]
    fn skip_delay_applies_while_one_is_open_or_just_closed() {
        let now = Instant::now();
        assert_eq!(delay_at(now, 1, None), Duration::from_millis(200));
        assert_eq!(
            delay_at(now, 0, Some(now - Duration::from_millis(100))),
            Duration::from_millis(200)
        );
        assert_eq!(
            delay_at(now, 0, Some(now - Duration::from_millis(500))),
            Duration::from_millis(450)
        );
    }
}
