//! Search-result list for the Ctrl+K command palette (R2.18).
//!
//! Matching and diacritic folding live in the app command registry, which uses the same
//! `chef_pdf::search::fold_query` function as document search. This component only presents the
//! already-ranked results and reports activation by row index.

use std::rc::Rc;

use chef_theme::{dark, light};
use gpui::{
    App, ElementId, FontWeight, IntoElement, RenderOnce, SharedString, Window, div, prelude::*, px,
    rgba,
};

use crate::a11y::{self, Registered};
use crate::button::pack;

#[derive(Clone, Debug)]
pub struct PaletteItem {
    pub id: SharedString,
    pub title: SharedString,
    pub group: SharedString,
    pub enabled: bool,
}

impl PaletteItem {
    pub fn new(
        id: impl Into<SharedString>,
        title: impl Into<SharedString>,
        group: impl Into<SharedString>,
        enabled: bool,
    ) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            group: group.into(),
            enabled,
        }
    }
}

type ActivateFn = Rc<dyn Fn(usize, &mut Window, &mut App)>;

#[derive(IntoElement)]
pub struct PaletteList {
    id: ElementId,
    label: SharedString,
    empty: SharedString,
    items: Vec<PaletteItem>,
    selected: usize,
    dark: bool,
    on_activate: Option<ActivateFn>,
}

impl PaletteList {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            empty: "No matching command".into(),
            items: Vec::new(),
            selected: 0,
            dark: false,
            on_activate: None,
        }
    }

    pub fn items(mut self, items: Vec<PaletteItem>) -> Self {
        self.items = items;
        self
    }

    pub fn selected(mut self, selected: usize) -> Self {
        self.selected = selected;
        self
    }

    pub fn dark(mut self, dark: bool) -> Self {
        self.dark = dark;
        self
    }

    pub fn empty_message(mut self, message: impl Into<SharedString>) -> Self {
        self.empty = message.into();
        self
    }

    pub fn on_activate(
        mut self,
        listener: impl Fn(usize, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.on_activate = Some(Rc::new(listener));
        self
    }
}

impl RenderOnce for PaletteList {
    fn render(self, _window: &mut Window, _cx: &mut App) -> impl IntoElement {
        let (surface, text, muted, border, accent, hover) = if self.dark {
            (
                pack(dark::C_SURFACE),
                pack(dark::C_TEXT),
                pack(dark::C_TEXT_2),
                pack(dark::C_DIVIDER),
                pack(dark::C_ACCENT),
                pack(dark::C_SURFACE_2),
            )
        } else {
            (
                pack(light::C_SURFACE),
                pack(light::C_TEXT),
                pack(light::C_TEXT_2),
                pack(light::C_DIVIDER),
                pack(light::C_ACCENT),
                pack(light::C_SURFACE_2),
            )
        };
        a11y::register(Registered {
            id: a11y::element_id_text(&self.id),
            role: "listbox",
            name: self.label.to_string(),
            disabled: false,
            focused: false,
            hovered: false,
            checked: None,
            value: None,
            bounds: None,
        });
        let mut root = div()
            .id(self.id.clone())
            .flex()
            .flex_col()
            .gap(px(2.0))
            .max_h(px(420.0))
            .overflow_y_scroll()
            .border_t_1()
            .border_color(rgba(border))
            .bg(rgba(surface));
        if self.items.is_empty() {
            root = root.child(
                div()
                    .px(px(12.0))
                    .py(px(14.0))
                    .text_color(rgba(muted))
                    .child(self.empty),
            );
            return root;
        }
        let selected = self.selected.min(self.items.len() - 1);
        for (index, item) in self.items.into_iter().enumerate() {
            let is_selected = index == selected;
            let on_activate = self.on_activate.clone();
            let title = item.title.clone();
            a11y::register(Registered {
                id: item.id.to_string(),
                role: "option",
                name: title.to_string(),
                disabled: !item.enabled,
                focused: is_selected,
                hovered: false,
                checked: Some(if is_selected { "true" } else { "false" }),
                value: Some(item.group.to_string()),
                bounds: None,
            });
            let mut row = div()
                .id(ElementId::Name(item.id))
                .flex()
                .flex_row()
                .items_center()
                .justify_between()
                .gap(px(12.0))
                .w_full()
                .px(px(12.0))
                .py(px(8.0))
                .cursor_pointer()
                .text_color(rgba(if item.enabled { text } else { muted }))
                .font_weight(if is_selected {
                    FontWeight::MEDIUM
                } else {
                    FontWeight::NORMAL
                })
                .bg(rgba(if is_selected { hover } else { surface }))
                .child(title)
                .child(
                    div()
                        .text_size(px(12.0))
                        .text_color(rgba(muted))
                        .child(item.group),
                );
            if let Some(listener) = on_activate {
                row = row.on_click(move |_, window, cx| {
                    if item.enabled {
                        listener(index, window, cx);
                    }
                });
            }
            if is_selected {
                row = row.border_l_2().border_color(rgba(accent));
            }
            root = root.child(row);
        }
        root
    }
}
