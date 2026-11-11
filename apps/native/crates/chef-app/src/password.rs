//! Hộp thoại nhập mật khẩu để mở file (TASKS_RUST R2.26, FEATURES B6). Hiện khi pdfium báo file cần
//! mật khẩu. Mật khẩu chỉ nằm trong bộ nhớ của viewer và bị xóa sau mỗi lần thử (zeroize).

use gpui::{App, Entity, FocusHandle, Window, div, prelude::*, px, rgba};

use chef_ui::button::{Button, Variant, pack};
use chef_ui::dialog::{Dialog, Width};
use chef_ui::form::TextField;
use chef_ui::i18n::{t, t_with};
use chef_ui::text_input::TextInput;

/// Tiêu điểm và điều khiển của hộp thoại, tạo một lần ở viewer.
pub struct Handles {
    /// Tiêu điểm của ô mật khẩu (cố định theo entity của ô).
    pub input: FocusHandle,
    pub close: FocusHandle,
    pub open: FocusHandle,
    pub return_to: FocusHandle,
}

/// Dựng hộp thoại. `name` là tên file; `wrong` cho biết lần thử trước sai mật khẩu.
pub fn build(
    name: &str,
    wrong: bool,
    dark: bool,
    input: &Entity<TextInput>,
    handles: &Handles,
    on_dismiss: impl Fn(&mut Window, &mut App) + Clone + 'static,
    on_open: impl Fn(&mut Window, &mut App) + 'static,
) -> Dialog {
    let input_focus = handles.input.clone();
    let danger = if dark {
        chef_theme::dark::C_DANGER
    } else {
        chef_theme::light::C_DANGER
    };
    let muted = if dark {
        chef_theme::dark::C_TEXT_2
    } else {
        chef_theme::light::C_TEXT_2
    };
    let mut dialog =
        Dialog::new("password", t("password.title"), Width::Sm, dark)
            .close("password-close", handles.close.clone(), t("common.close"))
            .tab_order(vec![input_focus])
            .return_focus(handles.return_to.clone())
            .on_dismiss(on_dismiss.clone())
            .child(
                div()
                    .mb(px(12.))
                    .text_size(px(chef_theme::shared::TEXT_MD))
                    .child(t_with("password.description", &[("name", name)])),
            )
            .child(div().mb(px(8.)).child(
                TextField::new("password-input", t("password.label"), input.clone()).dark(dark),
            ))
            .child(
                div()
                    .text_size(px(chef_theme::shared::TEXT_SM))
                    .text_color(rgba(pack(muted)))
                    .child(t("password.hint")),
            );
    if wrong {
        dialog = dialog.child(
            div()
                .mt(px(8.))
                .text_size(px(chef_theme::shared::TEXT_SM))
                .text_color(rgba(pack(danger)))
                .child(t("password.invalid")),
        );
    }
    dialog.action(
        Button::new("password-open", handles.open.clone())
            .variant(Variant::Primary)
            .label(t("password.open"))
            .dark(dark)
            .on_click(move |_, window, cx| on_open(window, cx)),
    )
}
