//! Loading placeholder approximating `PageOrganizer.css`'s thumb-shimmer.

use std::time::Duration;

use gpui::{
    Animation, AnimationExt, App, ElementId, IntoElement, ParentElement, RenderOnce, Styled,
    Window, div, linear_color_stop, linear_gradient, px, relative, rgb,
};

const PERIOD: Duration = Duration::from_millis(1400);
const WHITE: u32 = 0x00ff_ffff;
const BAND: u32 = 0x00f2_f3f5;
const BAND_WIDTH: f32 = 1.2;
const BAND_START: f32 = -1.1;
const BAND_END: f32 = 0.9;

#[derive(IntoElement)]
pub struct ThumbnailShimmer {
    id: ElementId,
    width: f32,
    height: f32,
    reduced_motion: bool,
    /// Optional deterministic frame for visual probes. Production callers leave this unset.
    phase: Option<f32>,
}

impl ThumbnailShimmer {
    pub fn new(id: impl Into<ElementId>, width: f32, height: f32) -> Self {
        Self {
            id: id.into(),
            width: dimension(width),
            height: dimension(height),
            reduced_motion: false,
            phase: None,
        }
    }

    pub fn reduced_motion(mut self, reduced: bool) -> Self {
        self.reduced_motion = reduced;
        self
    }

    /// Render a fixed point in the cycle for screenshot probes and deterministic visual tests.
    pub fn at_phase(mut self, phase: f32) -> Self {
        self.phase = Some(phase);
        self
    }
}

impl RenderOnce for ThumbnailShimmer {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let root = div()
            .relative()
            .w(px(self.width))
            .h(px(self.height))
            .bg(rgb(WHITE))
            .overflow_hidden();

        // Reduced motion presents the same neutral placeholder without any moving band.
        if !animation_enabled(self.reduced_motion) {
            return root;
        }

        let left = self.phase.map_or(BAND_START, phase_left);
        let band = div()
            .absolute()
            .top(px(0.0))
            .bottom(px(0.0))
            .left(relative(left))
            .w(relative(BAND_WIDTH))
            .flex()
            .flex_row()
            .children([
                div()
                    .w(relative(0.5))
                    .flex_none()
                    .h_full()
                    .bg(linear_gradient(
                        90.0,
                        linear_color_stop(rgb(WHITE), 0.0),
                        linear_color_stop(rgb(BAND), 1.0),
                    )),
                div()
                    .w(relative(0.5))
                    .flex_none()
                    .h_full()
                    .bg(linear_gradient(
                        90.0,
                        linear_color_stop(rgb(BAND), 0.0),
                        linear_color_stop(rgb(WHITE), 1.0),
                    )),
            ]);

        if self.phase.is_some() {
            root.child(band)
        } else {
            root.child(band.with_animation(
                (self.id, "thumb-shimmer"),
                Animation::new(PERIOD).repeat(),
                |element, delta| element.left(relative(phase_left(delta))),
            ))
        }
    }
}

fn dimension(value: f32) -> f32 {
    if value.is_finite() {
        value.max(0.0)
    } else {
        0.0
    }
}

/// The CSS placeholder uses a linear 1.4-second cycle from background-position 100% to 0%.
/// Express that as the moving band’s left edge across the clipped thumbnail viewport.
pub fn phase_left(phase: f32) -> f32 {
    let phase = if phase.is_finite() {
        phase.clamp(0.0, 1.0)
    } else {
        0.0
    };
    BAND_START + (BAND_END - BAND_START) * phase
}

pub fn animation_enabled(reduced_motion: bool) -> bool {
    !reduced_motion
}

#[cfg(test)]
mod tests {
    use super::{BAND_END, BAND_START, animation_enabled, phase_left};

    #[test]
    fn shimmer_band_moves_linearly_across_the_thumbnail() {
        assert_eq!(phase_left(0.0), BAND_START);
        assert!((phase_left(0.5) - (BAND_START + BAND_END) / 2.0).abs() < f32::EPSILON);
        assert_eq!(phase_left(1.0), BAND_END);
    }

    #[test]
    fn phase_is_clamped_and_non_finite_values_return_to_the_start() {
        assert_eq!(phase_left(-4.0), BAND_START);
        assert_eq!(phase_left(4.0), BAND_END);
        assert_eq!(phase_left(f32::NAN), BAND_START);
        assert_eq!(phase_left(f32::INFINITY), BAND_START);
    }

    #[test]
    fn reduced_motion_policy_has_no_animation_frame() {
        assert!(!animation_enabled(true));
        assert!(animation_enabled(false));
    }
}
