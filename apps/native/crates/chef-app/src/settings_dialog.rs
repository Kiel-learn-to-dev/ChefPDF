//! Hộp thoại Cài đặt (TASKS_RUST R2.14, BLUEPRINT_RUST §7.1): giao diện, ngôn ngữ và thư mục lưu mặc
//! định, ghi vào settings.json như bản Electron.
//!
//! Điều khiển: nhóm nút chọn (giao diện, R2.05), ô chọn (ngôn ngữ, R2.08), ô nhập (thư mục). Thay đổi
//! có hiệu lực ngay và được ghi ngay. Viewer giữ trạng thái và xử lý ghi file (xem `viewer.rs`).
//! Phần chọn thư mục bằng hộp thoại của Windows chưa làm (R2.30).

use gpui::{
    App, Entity, FocusHandle, Focusable, IntoElement, SharedString, Window, div, prelude::*, px,
    rgba,
};

use chef_ui::button::{Button, Variant};
use chef_ui::choice::{ToggleGroup, ToggleItem};
use chef_ui::dialog::{Dialog, Width};
use chef_ui::form::TextField;
use chef_ui::i18n::t;
use chef_ui::select::{self, Select};
use chef_ui::text_input::TextInput;

use crate::settings::{Language, Theme};
use crate::viewer::Viewer;

/// Trạng thái hiển thị, do viewer giữ.
pub struct Snapshot {
    pub theme: Theme,
    pub language: Language,
    pub dark: bool,
    /// Lý do không đọc được settings.json (thay đổi chỉ tồn tại trong phiên này).
    pub read_error: Option<String>,
}

/// Điều khiển có tiêu điểm lâu dài, tạo một lần ở viewer và giữ qua các lần vẽ.
pub struct Handles {
    /// Ba nút chọn giao diện: hệ thống, sáng, tối.
    pub theme: Vec<FocusHandle>,
    /// Nút đóng ở góc hộp thoại.
    pub close: FocusHandle,
    /// Tiêu điểm trả về khi đóng: khung viewer.
    pub return_to: FocusHandle,
}

const LANGUAGE_SELECT: &str = "settings-language";

pub fn theme_index(theme: Theme) -> usize {
    match theme {
        Theme::System => 0,
        Theme::Light => 1,
        Theme::Dark => 2,
    }
}

pub fn theme_from_index(index: usize) -> Theme {
    match index {
        1 => Theme::Light,
        2 => Theme::Dark,
        _ => Theme::System,
    }
}

fn language_index(language: Language) -> usize {
    match language {
        Language::Vi => 0,
        Language::En => 1,
    }
}

pub fn language_from_index(index: usize) -> Language {
    match index {
        1 => Language::En,
        _ => Language::Vi,
    }
}

/// Một nhãn của phần giao diện: chữ nhỏ đậm phía trên điều khiển.
fn field(label: SharedString, control: impl IntoElement, dark: bool) -> impl IntoElement {
    let muted = if dark {
        chef_theme::dark::C_TEXT_2
    } else {
        chef_theme::light::C_TEXT_2
    };
    div()
        .flex()
        .flex_col()
        .gap(px(6.))
        .mb(px(16.))
        .child(
            div()
                .text_size(px(chef_theme::shared::TEXT_SM))
                .font_weight(gpui::FontWeight::MEDIUM)
                .text_color(rgba(chef_ui::button::pack(muted)))
                .child(label),
        )
        .child(control)
}

/// Dựng hộp thoại. Các thay đổi đi qua `viewer`, nên viewer là nơi duy nhất ghi file.
pub fn build(
    viewer: &Entity<Viewer>,
    snapshot: &Snapshot,
    handles: &Handles,
    dir_input: &Entity<TextInput>,
    window: &mut Window,
    cx: &mut App,
) -> Dialog {
    let dark = snapshot.dark;
    let theme_items: Vec<ToggleItem> = [
        "settings.themeSystem",
        "settings.themeLight",
        "settings.themeDark",
    ]
    .iter()
    .enumerate()
    .map(|(i, key)| {
        ToggleItem::new(
            format!("settings-theme-{i}"),
            handles.theme[i].clone(),
            t(key),
        )
    })
    .collect();
    let theme_viewer = viewer.clone();
    let theme_group = ToggleGroup::new("settings-theme", t("settings.theme"), theme_items)
        .selected(theme_index(snapshot.theme))
        .dark(dark)
        .on_change(move |index, _, cx| {
            let theme = theme_from_index(index);
            theme_viewer.update(cx, |this, cx| this.set_theme_setting(theme, cx));
        });

    let language_focus = select::trigger_focus(LANGUAGE_SELECT, window, cx);
    let language_viewer = viewer.clone();
    let language_select = Select::new(
        LANGUAGE_SELECT,
        t("settings.language"),
        vec![
            SharedString::from("Tiếng Việt"),
            SharedString::from("English"),
        ],
    )
    .selected(language_index(snapshot.language))
    .width(220.0)
    .dark(dark)
    .on_change(move |index, _, cx| {
        let language = language_from_index(index);
        language_viewer.update(cx, |this, cx| this.set_language_setting(language, cx));
    });

    let dir_focus = dir_input.read(cx).focus_handle(cx);
    let dir_field = TextField::new(
        "settings-save-dir",
        t("settings.defaultSaveDir"),
        dir_input.clone(),
    )
    .dark(dark);

    let hint_color = if dark {
        chef_theme::dark::C_TEXT_3
    } else {
        chef_theme::light::C_TEXT_3
    };
    let hint = div()
        .text_size(px(chef_theme::shared::TEXT_SM))
        .text_color(rgba(chef_ui::button::pack(hint_color)))
        .child(t("settings.defaultSaveDirHint"));

    let error = snapshot.read_error.clone().map(|message| {
        let danger = if dark {
            chef_theme::dark::C_DANGER
        } else {
            chef_theme::light::C_DANGER
        };
        div()
            .mb(px(12.))
            .text_size(px(chef_theme::shared::TEXT_SM))
            .text_color(rgba(chef_ui::button::pack(danger)))
            .child(message)
    });

    let close_viewer = viewer.clone();
    let close_viewer_btn = viewer.clone();
    let mut dialog = Dialog::new("settings", t("settings.title"), Width::Md, dark)
        .close("settings-close", handles.close.clone(), t("common.close"))
        .tab_order({
            let mut order = handles.theme.clone();
            order.push(language_focus.clone());
            order.push(dir_focus.clone());
            order
        })
        .return_focus(handles.return_to.clone())
        .on_dismiss(move |window, cx| {
            close_viewer.update(cx, |this, cx| this.close_settings(window, cx));
        });
    if let Some(error) = error {
        dialog = dialog.child(error);
    }
    dialog
        .child(field(t("settings.theme").into(), theme_group, dark))
        .child(field(t("settings.language").into(), language_select, dark))
        .child(field(t("settings.defaultSaveDir").into(), dir_field, dark))
        .child(hint)
        .action(
            Button::new("settings-done", handles.close.clone())
                .variant(Variant::Primary)
                .label(t("common.close"))
                .dark(dark)
                .on_click(move |_, window, cx| {
                    close_viewer_btn.update(cx, |this, cx| this.close_settings(window, cx));
                }),
        )
}
