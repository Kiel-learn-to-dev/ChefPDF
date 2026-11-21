//! Widget overlay geometry, styling, and accessibility helpers for R4.21 form-fill display.

use chef_pdf::form_fill::{FormWidget, WidgetKind};

/// Pixel placement of one form widget on the viewer canvas and in window coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WidgetPlacement {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    /// `[x, y, width, height]` in logical window coordinates matching `a11y` bounds.
    pub screen_bounds: [f32; 4],
}

/// Converts a page-relative displayed rectangle (points after view rotation) to canvas-relative
/// pixel coordinates and window screen bounds using the same page origin and zoom as page images.
pub fn place_widget(
    page_x: f32,
    page_y: f32,
    content_origin: (f32, f32),
    rect_view_pt: (f32, f32, f32, f32),
    zoom: f32,
) -> WidgetPlacement {
    let x = page_x + rect_view_pt.0 * zoom;
    let y = page_y + rect_view_pt.1 * zoom;
    let w = ((rect_view_pt.2 - rect_view_pt.0) * zoom).max(2.0);
    let h = ((rect_view_pt.3 - rect_view_pt.1) * zoom).max(2.0);
    WidgetPlacement {
        x,
        y,
        w,
        h,
        screen_bounds: [content_origin.0 + x, content_origin.1 + y, w, h],
    }
}

/// Maps PDF form widget kind to a standard accessibility role string for E2E inspection.
pub fn widget_a11y_role(kind: WidgetKind) -> &'static str {
    match kind {
        WidgetKind::Text | WidgetKind::Multiline | WidgetKind::Comb | WidgetKind::Password => {
            "textbox"
        }
        WidgetKind::Checkbox => "checkbox",
        WidgetKind::Radio => "radio",
        WidgetKind::Dropdown | WidgetKind::Listbox => "combobox",
        WidgetKind::PushButton | WidgetKind::Signature | WidgetKind::Unknown => "button",
    }
}

/// Human-readable control label used for a11y registration and tooltips.
pub fn widget_display_label(widget: &FormWidget) -> String {
    match widget.alternate_name.as_deref() {
        Some(alt) if !alt.is_empty() && !widget.name.is_empty() => {
            format!("{} ({})", widget.name, alt)
        }
        _ if !widget.name.is_empty() => widget.name.clone(),
        _ => widget.id.clone(),
    }
}

/// Translucent RGBA fill and opaque RGB border colors so PDFium-drawn widget contents remain
/// sharp while interactive hit bounds and focus/hover states stay legible across themes.
pub fn widget_visual_colors(
    kind: WidgetKind,
    read_only: bool,
    required: bool,
    active: bool,
    dark: bool,
) -> (u32, u32) {
    let fill = if active {
        if dark { 0x60a5fa38 } else { 0x2563eb26 }
    } else if read_only {
        if dark { 0x9ca3af1a } else { 0x64748b14 }
    } else if kind == WidgetKind::Signature {
        if dark { 0xf59e0b20 } else { 0xd9770618 }
    } else if required {
        if dark { 0x60a5fa1c } else { 0x2563eb14 }
    } else if dark {
        0x93c5fd18
    } else {
        0x3b82f60f
    };

    let border = if active {
        if dark { 0x60a5fa } else { 0x2563eb }
    } else if read_only {
        if dark { 0x6b7280 } else { 0x94a3b8 }
    } else if kind == WidgetKind::Signature {
        if dark { 0xf59e0b } else { 0xb45309 }
    } else if required {
        if dark { 0x93c5fd } else { 0x1d4ed8 }
    } else if dark {
        0x4b6a96
    } else {
        0x6090c8
    };
    (fill, border)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chef_pdf::text::Rect;

    #[test]
    fn place_widget_tracks_page_origin_across_three_audit_widths() {
        let page_pt = (595.0_f32, 842.0_f32);
        let sidebar = 210.0_f32;
        let toolbar = 72.0_f32;
        let margin = 24.0_f32;
        let widget_pt = (20.0_f32, 120.0_f32, 180.0_f32, 140.0_f32);

        let mut zooms = Vec::new();
        for win_w in [800.0_f32, 1184.0_f32, 1484.0_f32] {
            let view_w = win_w - sidebar;
            let zoom = (view_w - 2.0 * margin) / page_pt.0;
            zooms.push(zoom);
            let page_w = page_pt.0 * zoom;
            let page_x = ((view_w - page_w) / 2.0).max(0.0);
            let page_y = margin;
            let placed = place_widget(page_x, page_y, (sidebar, toolbar), widget_pt, zoom);
            assert!((placed.x - (page_x + 20.0 * zoom)).abs() < 1e-3);
            assert!((placed.y - (page_y + 120.0 * zoom)).abs() < 1e-3);
            assert!((placed.w - 160.0 * zoom).abs() < 1e-3);
            assert!((placed.h - 20.0 * zoom).abs() < 1e-3);
            assert!(
                placed.screen_bounds[0] >= sidebar + page_x
                    && placed.screen_bounds[0] + placed.screen_bounds[2]
                        <= sidebar + page_x + page_w
            );
        }
        assert!(zooms[0] < zooms[1] && zooms[1] < zooms[2]);
    }

    #[test]
    fn roles_and_labels_cover_widget_variants() {
        assert_eq!(widget_a11y_role(WidgetKind::Text), "textbox");
        assert_eq!(widget_a11y_role(WidgetKind::Comb), "textbox");
        assert_eq!(widget_a11y_role(WidgetKind::Checkbox), "checkbox");
        assert_eq!(widget_a11y_role(WidgetKind::Radio), "radio");
        assert_eq!(widget_a11y_role(WidgetKind::Dropdown), "combobox");
        assert_eq!(widget_a11y_role(WidgetKind::Signature), "button");

        let widget = FormWidget {
            id: "form-widget-p0-0".into(),
            page_index: 0,
            annot_index: 0,
            name: "hoten".into(),
            alternate_name: Some("Họ tên".into()),
            kind: WidgetKind::Text,
            rect: Rect {
                left: 0.0,
                top: 0.0,
                right: 100.0,
                bottom: 20.0,
            },
            value: None,
            checked: None,
            control_index: None,
            options: Vec::new(),
            read_only: false,
            required: false,
            has_appearance: false,
        };
        assert_eq!(widget_display_label(&widget), "hoten (Họ tên)");
    }
}
