//! Native Start screen (TASKS_RUST R2.16).

use std::path::PathBuf;

use gpui::{Entity, IntoElement, SharedString, div, prelude::*, px, rgb};

use crate::settings::RecentFile;
use crate::tabs_host::DocumentHost;
use crate::theme;
use chef_ui::i18n;

struct Tile {
    id: &'static str,
    title_key: &'static str,
    text_key: &'static str,
    glyph: &'static str,
    tone: u32,
    enabled: bool,
}

const TILES: &[Tile] = &[
    Tile {
        id: "start-open",
        title_key: "start.open",
        text_key: "start.openText",
        glyph: "＋",
        tone: 0x2f6be4,
        enabled: true,
    },
    Tile {
        id: "start-merge",
        title_key: "start.merge",
        text_key: "start.mergeText",
        glyph: "⇄",
        tone: 0x1f9d61,
        enabled: false,
    },
    Tile {
        id: "start-split",
        title_key: "start.split",
        text_key: "start.splitText",
        glyph: "✂",
        tone: 0x7a4fe0,
        enabled: false,
    },
    Tile {
        id: "start-scan",
        title_key: "start.scanTitle",
        text_key: "start.scanText",
        glyph: "▤",
        tone: 0xb7791f,
        enabled: false,
    },
    Tile {
        id: "start-sign",
        title_key: "soon.sign",
        text_key: "start.signText",
        glyph: "✓",
        tone: 0xd6455d,
        enabled: false,
    },
    Tile {
        id: "start-stamp",
        title_key: "soon.stamp",
        text_key: "start.stampText",
        glyph: "▣",
        tone: 0x138a8a,
        enabled: false,
    },
    Tile {
        id: "start-compress",
        title_key: "soon.compress",
        text_key: "start.compressText",
        glyph: "⇣",
        tone: 0x5a6475,
        enabled: false,
    },
];

/// A document-free landing view with working open/recent paths and explicitly disabled future tiles.
pub fn build(
    host: Entity<DocumentHost>,
    recent: &[RecentFile],
    width: f32,
    dark: bool,
    message: Option<&str>,
) -> impl IntoElement {
    let colors = theme::palette(dark);
    let width = width.max(320.0);
    let padding = if width >= 960.0 { 36.0 } else { 24.0 };
    let inner_width = (width - padding * 2.0).clamp(272.0, 980.0);
    let gap = 16.0;
    let columns = columns_for_width(inner_width, gap);
    let tile_width = ((inner_width - gap * (columns - 1) as f32) / columns as f32).max(0.0);

    let mut tile_rows = Vec::new();
    for chunk in TILES.chunks(columns) {
        let mut row = div().w_full().flex().flex_row().gap(px(gap));
        for tile in chunk {
            let title = i18n::t(tile.title_key);
            let text = i18n::t(tile.text_key);
            let host_for_click = host.clone();
            let mut card = div()
                .id(tile.id)
                .w(px(tile_width))
                .h(px(144.0))
                .flex_none()
                .flex()
                .flex_col()
                .gap(px(8.0))
                .p(px(16.0))
                .rounded(px(14.0))
                .border_1()
                .border_color(rgb(colors.border))
                .bg(rgb(if tile.enabled {
                    colors.surface
                } else {
                    colors.canvas
                }))
                .text_color(rgb(colors.text));
            let tile_icon_bg = blend(tile.tone, colors.canvas, if dark { 0.18 } else { 0.12 });
            let icon_color = if tile.enabled {
                tile.tone
            } else {
                disabled_icon_color(tile.tone, colors.canvas)
            };
            let icon_bg = if tile.enabled {
                tile_icon_bg
            } else {
                disabled_icon_color(tile_icon_bg, colors.canvas)
            };
            card = card.child(
                div()
                    .w(px(38.0))
                    .h(px(38.0))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(10.0))
                    .bg(rgb(icon_bg))
                    .text_size(px(22.0))
                    .text_color(rgb(icon_color))
                    .child(tile.glyph),
            );
            card = card.child(
                div()
                    .flex()
                    .flex_row()
                    .items_center()
                    .gap(px(6.0))
                    .text_size(px(chef_theme::shared::TEXT_LG))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(rgb(if tile.enabled {
                        colors.text
                    } else {
                        colors.text_2
                    }))
                    .child(title),
            );
            card = card.child(
                div()
                    .flex_1()
                    .text_size(px(chef_theme::shared::TEXT_SM))
                    .text_color(rgb(colors.text_2))
                    .child(text),
            );
            if tile.enabled {
                card = card
                    .cursor_pointer()
                    .border_color(rgb(if dark { 0x626b7a } else { 0xc5ccda }))
                    .on_click(move |_, window, cx| {
                        host_for_click.update(cx, |host, cx| host.open_dialog(window, cx));
                    });
            } else {
                // Replicate StartScreen.css: grayscale is limited to the disabled tile icon.
                card = card.border_dashed().child(
                    div()
                        .text_size(px(chef_theme::shared::TEXT_SM))
                        .text_color(rgb(colors.text_2))
                        .child(i18n::t("start.notAvailable")),
                );
            }
            row = row.child(card);
        }
        tile_rows.push(row);
    }

    let mut recent_rows = Vec::new();
    for (index, entry) in recent.iter().take(8).enumerate() {
        let host_for_click = host.clone();
        let path = entry.path.clone();
        let dirname = PathBuf::from(&entry.path)
            .parent()
            .map(|parent| parent.to_string_lossy().into_owned())
            .unwrap_or_default();
        recent_rows.push(
            div()
                .id(format!("start-recent-{index}"))
                .w_full()
                .min_w_0()
                .flex()
                .flex_row()
                .items_center()
                .gap(px(12.0))
                .px(px(12.0))
                .py(px(8.0))
                .rounded(px(8.0))
                .cursor_pointer()
                .hover(|style| style.bg(rgb(colors.canvas)))
                .on_click(move |_, window, cx| {
                    host_for_click.update(cx, |host, cx| {
                        host.open_paths(vec![PathBuf::from(path.clone())], window, cx)
                    });
                })
                .child(
                    div()
                        .w(px(30.0))
                        .h(px(30.0))
                        .flex_none()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(8.0))
                        .bg(rgb(if dark { 0x472e36 } else { 0xfce8ec }))
                        .text_color(rgb(if dark { 0xf08a9b } else { 0x2f6be4 }))
                        .text_size(px(chef_theme::shared::TEXT_SM))
                        .child("PDF"),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .flex()
                        .flex_col()
                        .gap(px(2.0))
                        .child(
                            div()
                                .w_full()
                                .text_size(px(chef_theme::shared::TEXT_MD))
                                .font_weight(gpui::FontWeight::MEDIUM)
                                .text_ellipsis()
                                .child(entry.name.clone()),
                        )
                        .child(
                            div()
                                .w_full()
                                .text_size(px(chef_theme::shared::TEXT_SM))
                                .text_color(rgb(colors.text_2))
                                .text_ellipsis()
                                .child(dirname),
                        ),
                )
                .child(
                    div()
                        .w(px(125.0))
                        .flex_none()
                        .text_size(px(chef_theme::shared::TEXT_SM))
                        .text_color(rgb(colors.text_2))
                        .text_right()
                        .child(SharedString::from(entry.opened_at.clone())),
                ),
        );
    }

    let open_host = host.clone();
    div()
        .id("start-screen")
        .size_full()
        .overflow_y_scroll()
        .bg(rgb(colors.canvas))
        .flex()
        .justify_center()
        .child(
            div()
                .w(px(inner_width))
                .flex()
                .flex_col()
                .gap(px(28.0))
                .py(px(36.0))
                .child(
                    div()
                        .flex()
                        .flex_row()
                        .items_center()
                        .gap(px(18.0))
                        .child(
                            div()
                                .w(px(52.0))
                                .h(px(52.0))
                                .flex()
                                .items_center()
                                .justify_center()
                                .rounded(px(14.0))
                                .bg(rgb(if dark { 0x253b62 } else { 0xe8effd }))
                                .text_color(rgb(if dark { 0x8fb3f7 } else { 0x2f6be4 }))
                                .text_size(px(chef_theme::shared::TEXT_2XL))
                                .font_weight(gpui::FontWeight::BOLD)
                                .child("C"),
                        )
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(4.0))
                                .child(
                                    div()
                                        .text_size(px(chef_theme::shared::TEXT_2XL))
                                        .font_weight(gpui::FontWeight::SEMIBOLD)
                                        .text_color(rgb(colors.text))
                                        .child(i18n::t("start.title")),
                                )
                                .child(
                                    div()
                                        .text_size(px(chef_theme::shared::TEXT_LG))
                                        .text_color(rgb(colors.text_2))
                                        .child(i18n::t("start.subtitle")),
                                ),
                        ),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(12.0))
                        .child(section_title("start.tasks", colors.text_2))
                        .children(tile_rows),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(12.0))
                        .child(section_title("start.recent", colors.text_2))
                        .child(
                            div()
                                .w_full()
                                .p(px(6.0))
                                .rounded(px(14.0))
                                .border_1()
                                .border_color(rgb(colors.border))
                                .bg(rgb(colors.surface))
                                .when(recent.is_empty(), |this| {
                                    this.child(
                                        div()
                                            .w_full()
                                            .h(px(92.0))
                                            .flex()
                                            .flex_col()
                                            .items_center()
                                            .justify_center()
                                            .gap(px(8.0))
                                            .text_color(rgb(colors.text_2))
                                            .child("▤")
                                            .child(i18n::t("start.dropHint")),
                                    )
                                    .child(
                                        div()
                                            .id("start-empty-open")
                                            .self_center()
                                            .mb(px(8.0))
                                            .px(px(12.0))
                                            .py(px(7.0))
                                            .rounded(px(8.0))
                                            .cursor_pointer()
                                            .bg(rgb(if dark { 0x253b62 } else { 0xe8effd }))
                                            .text_color(rgb(if dark { 0x8fb3f7 } else { 0x2f6be4 }))
                                            .child(i18n::t("start.open"))
                                            .on_click(move |_, window, cx| {
                                                open_host.update(cx, |host, cx| {
                                                    host.open_dialog(window, cx)
                                                });
                                            }),
                                    )
                                })
                                .children(recent_rows),
                        ),
                )
                .children(message.map(|text| {
                    div()
                        .w_full()
                        .text_color(rgb(if dark { 0xf08a9b } else { 0xb4233d }))
                        .child(text.to_string())
                })),
        )
}

fn section_title(key: &str, color: u32) -> impl IntoElement {
    div()
        .text_size(px(chef_theme::shared::TEXT_SM))
        .font_weight(gpui::FontWeight::SEMIBOLD)
        .text_color(rgb(color))
        .child(i18n::t(key).to_uppercase())
}

fn columns_for_width(inner_width: f32, gap: f32) -> usize {
    (((inner_width.max(0.0) + gap.max(0.0)) / (208.0 + gap.max(0.0))).floor() as usize).clamp(1, 4)
}

fn blend(fg: u32, bg: u32, amount: f32) -> u32 {
    let component = |shift: u32| {
        let front = ((fg >> shift) & 0xff) as f32;
        let back = ((bg >> shift) & 0xff) as f32;
        (front * (1.0 - amount) + back * amount).round() as u32
    };
    (component(16) << 16) | (component(8) << 8) | component(0)
}

/// Approximate CSS `grayscale(0.6)` followed by `opacity: 0.7` for disabled tile icons.
fn disabled_icon_color(color: u32, background: u32) -> u32 {
    let channel = |shift: u32| ((color >> shift) & 0xff) as f32;
    let r = channel(16);
    let g = channel(8);
    let b = channel(0);
    let luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    let composite = |shift: u32, original: f32| {
        let gray_mix = original * 0.4 + luminance * 0.6;
        let back = ((background >> shift) & 0xff) as f32;
        (gray_mix * 0.7 + back * 0.3).round() as u32
    };
    (composite(16, r) << 16) | (composite(8, g) << 8) | composite(0, b)
}

#[cfg(test)]
mod tests {
    use super::columns_for_width;

    #[test]
    fn start_tile_columns_match_css_auto_fill_at_narrow_medium_and_wide_widths() {
        assert_eq!(columns_for_width(500.0, 16.0), 2);
        assert_eq!(columns_for_width(700.0, 16.0), 3);
        assert_eq!(columns_for_width(980.0, 16.0), 4);
    }
}
