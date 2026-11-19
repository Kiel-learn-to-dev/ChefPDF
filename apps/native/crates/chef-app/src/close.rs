//! Hộp thoại xác nhận đóng thẻ hoặc thoát khi tài liệu có thay đổi chưa lưu (TASKS_RUST R3.14).

use chef_theme::{dark, light, shared};
use chef_ui::button::{Button, Variant, pack};
use chef_ui::dialog::{Dialog, Width};
use chef_ui::i18n;
use gpui::{
    App, Context, Entity, FocusHandle, InteractiveElement, ParentElement, Styled, Window, div, px,
    rgba,
};

/// Trạng thái hộp thoại hỏi Lưu / Không lưu / Hủy khi đóng thẻ bẩn (`id = "unsaved-close-dialog"`).
pub struct UnsavedClosePrompt {
    pub open: bool,
    pub tab_id: Option<usize>,
    pub name: String,
    cancel_focus: FocusHandle,
    discard_focus: FocusHandle,
    save_focus: FocusHandle,
}

impl UnsavedClosePrompt {
    pub fn new(cx: &mut App) -> Self {
        Self {
            open: false,
            tab_id: None,
            name: String::new(),
            cancel_focus: cx.focus_handle(),
            discard_focus: cx.focus_handle(),
            save_focus: cx.focus_handle(),
        }
    }

    pub fn open_for(&mut self, tab_id: usize, name: String, window: &mut Window, cx: &mut App) {
        self.open = true;
        self.tab_id = Some(tab_id);
        self.name = name;
        self.save_focus.focus(window, cx);
    }

    pub fn close(&mut self) {
        self.open = false;
        self.tab_id = None;
        self.name.clear();
    }

    #[allow(clippy::too_many_arguments)]
    pub fn render_dialog<V: 'static>(
        &self,
        is_dark: bool,
        entity: &Entity<V>,
        on_cancel: impl Fn(&mut V, &mut Window, &mut Context<V>) + Copy + 'static,
        on_discard: impl Fn(&mut V, usize, &mut Window, &mut Context<V>) + Copy + 'static,
        on_save: impl Fn(&mut V, usize, &mut Window, &mut Context<V>) + Copy + 'static,
    ) -> Dialog {
        let title = i18n::t("close.unsavedTitle");
        let message = i18n::t_with("close.unsavedMessage", &[("name", &self.name)]);
        let text_color = if is_dark {
            pack(dark::C_TEXT_2)
        } else {
            pack(light::C_TEXT_2)
        };
        let tab_id = self.tab_id.unwrap_or(0);

        let host_cancel = entity.clone();
        let cancel_btn = Button::new("close-prompt-cancel", self.cancel_focus.clone())
            .label(i18n::t("common.cancel"))
            .variant(Variant::Secondary)
            .dark(is_dark)
            .on_click(move |_, window, cx| {
                host_cancel.update(cx, |this, cx| on_cancel(this, window, cx));
            });

        let host_discard = entity.clone();
        let discard_btn = Button::new("close-prompt-discard", self.discard_focus.clone())
            .label(i18n::t("close.discard"))
            .variant(Variant::Danger)
            .dark(is_dark)
            .on_click(move |_, window, cx| {
                host_discard.update(cx, |this, cx| on_discard(this, tab_id, window, cx));
            });

        let host_save = entity.clone();
        let save_btn = Button::new("close-prompt-save", self.save_focus.clone())
            .label(i18n::t("close.save"))
            .variant(Variant::Primary)
            .dark(is_dark)
            .on_click(move |_, window, cx| {
                host_save.update(cx, |this, cx| on_save(this, tab_id, window, cx));
            });

        let host_esc = entity.clone();
        Dialog::new("unsaved-close-dialog", title, Width::Sm, is_dark)
            .tab_order(vec![
                self.cancel_focus.clone(),
                self.discard_focus.clone(),
                self.save_focus.clone(),
            ])
            .child(
                div()
                    .id("unsaved-close-body")
                    .text_size(px(shared::TEXT_MD))
                    .text_color(rgba(text_color))
                    .child(message),
            )
            .action(cancel_btn)
            .action(discard_btn)
            .action(save_btn)
            .on_dismiss(move |window, cx| {
                host_esc.update(cx, |this, cx| on_cancel(this, window, cx));
            })
    }
}
