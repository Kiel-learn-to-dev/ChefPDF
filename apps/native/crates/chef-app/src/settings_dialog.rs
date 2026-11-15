//! Cài đặt của app và hộp thoại Cài đặt (TASKS_RUST R2.14, BLUEPRINT_RUST §7.1): giao diện, ngôn ngữ
//! và thư mục lưu mặc định, ghi vào settings.json như bản Electron.
//!
//! `SettingsPanel` là nơi duy nhất giữ và ghi settings.json trong một cửa sổ. Cửa sổ (`DocumentHost`)
//! tạo một thực thể và chia cho mọi tab, nên các tab luôn thấy cùng một giá trị và không ghi đè lẫn
//! nhau (kể cả danh sách file gần đây). Hộp thoại do cửa sổ vẽ, nên mở được cả ở màn hình Start.
//!
//! Điều khiển: nhóm nút chọn (giao diện, R2.05), ô chọn (ngôn ngữ, R2.08), ô nhập (thư mục). Thay đổi
//! có hiệu lực ngay và được ghi ngay. Phần chọn thư mục bằng hộp thoại của Windows chưa làm (R2.30).

use std::path::Path;

use gpui::{
    App, Context, Entity, FocusHandle, Focusable, IntoElement, SharedString, Subscription, Window,
    div, prelude::*, px, rgba,
};

use chef_ui::button::{Button, Variant};
use chef_ui::choice::{ToggleGroup, ToggleItem};
use chef_ui::dialog::{Dialog, Width};
use chef_ui::form::TextField;
use chef_ui::i18n::{self, t};
use chef_ui::select::{self, Select};
use chef_ui::text_input::{TextInput, TextInputEvent};

use crate::settings::{self, Language, RecentFile, Settings, Theme};
use crate::theme;

const LANGUAGE_SELECT: &str = "settings-language";

/// Cài đặt đang dùng và trạng thái hộp thoại Cài đặt của một cửa sổ.
pub struct SettingsPanel {
    /// settings.json đã đọc. None khi file không đọc được: thay đổi chỉ còn trong phiên này.
    settings: Option<Settings>,
    read_error: Option<String>,
    /// Lỗi của lần ghi gần nhất, hiện trong hộp thoại.
    write_error: Option<String>,
    theme: Theme,
    language: Language,
    save_dir: Option<String>,
    open: bool,
    /// Ba nút chọn giao diện: hệ thống, sáng, tối.
    theme_handles: Vec<FocusHandle>,
    close_handle: FocusHandle,
    /// Phần tử có tiêu điểm lúc mở hộp thoại; tiêu điểm trả về đó khi đóng.
    return_to: Option<FocusHandle>,
    dir_input: Entity<TextInput>,
    _subscription: Subscription,
}

impl SettingsPanel {
    /// Đọc settings.json trong userData (hoặc thư mục thử nghiệm). Lỗi đọc không làm sập app.
    pub fn new(cx: &mut Context<Self>) -> Self {
        let (settings, read_error) = match Settings::load(&settings::user_data_dir()) {
            Ok(settings) => (Some(settings), None),
            Err(error) => (None, Some(error.to_string())),
        };
        let (theme, language, save_dir) = match &settings {
            Some(s) => (
                s.theme(),
                s.language(),
                s.default_save_dir().map(str::to_string),
            ),
            None => (Theme::default(), Language::default(), None),
        };
        i18n::set_language(i18n::Lang::from_code(language.as_str()));
        let dir_input = cx.new(|cx| TextInput::new(cx, t("settings.defaultSaveDirPlaceholder")));
        let subscription = cx.subscribe(
            &dir_input,
            |this: &mut SettingsPanel, input, event: &TextInputEvent, cx| {
                if matches!(event, TextInputEvent::Submit) {
                    let text = input.read(cx).text().to_string();
                    this.set_save_dir(&text, cx);
                }
            },
        );
        SettingsPanel {
            settings,
            read_error,
            write_error: None,
            theme,
            language,
            save_dir,
            open: false,
            theme_handles: (0..3).map(|_| cx.focus_handle()).collect(),
            close_handle: cx.focus_handle(),
            return_to: None,
            dir_input,
            _subscription: subscription,
        }
    }

    pub fn theme(&self) -> Theme {
        self.theme
    }

    pub fn language(&self) -> Language {
        self.language
    }

    pub fn save_dir(&self) -> Option<&str> {
        self.save_dir.as_deref()
    }

    /// Chế độ sáng/tối đang áp dụng theo cài đặt giao diện.
    pub fn mode(&self) -> theme::Mode {
        theme::effective_mode(self.theme)
    }

    pub fn is_open(&self) -> bool {
        self.open
    }

    pub fn recent_files(&self) -> Vec<RecentFile> {
        self.settings
            .as_ref()
            .map(Settings::recent_files)
            .unwrap_or_default()
    }

    /// Ghi nhận một file vừa mở vào danh sách gần đây và ghi settings.json.
    pub fn record_recent(&mut self, path: &Path, cx: &mut Context<Self>) -> Result<(), String> {
        let Some(settings) = self.settings.as_mut() else {
            return Ok(());
        };
        if settings
            .record_recent(path, &settings::now_iso_8601())
            .is_err()
        {
            return Ok(());
        }
        cx.notify();
        settings.save().map_err(|error| error.to_string())
    }

    /// Mở hộp thoại: tiêu điểm vào lựa chọn giao diện hiện tại, nhớ chỗ để trả về khi đóng.
    pub fn open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.open {
            return;
        }
        let text = self.save_dir.clone().unwrap_or_default();
        self.dir_input
            .update(cx, |input, cx| input.set_text(&text, cx));
        self.return_to = window.focused(cx);
        self.open = true;
        window.focus(&self.theme_handles[theme_index(self.theme)], cx);
        cx.notify();
    }

    pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.open = false;
        if let Some(focus) = self.return_to.take() {
            window.focus(&focus, cx);
        }
        cx.notify();
    }

    fn save(&mut self) {
        self.write_error = match self.settings.as_mut().map(Settings::save) {
            Some(Err(error)) => Some(format!("Không lưu được cài đặt: {error}")),
            _ => None,
        };
    }

    /// Đổi giao diện: có hiệu lực ngay và được ghi.
    fn set_theme(&mut self, theme: Theme, cx: &mut Context<Self>) {
        self.theme = theme;
        if let Some(settings) = self.settings.as_mut() {
            settings.set_theme(theme);
        }
        self.save();
        cx.notify();
    }

    /// Đổi ngôn ngữ: chuỗi giao diện đổi ngay và được ghi.
    fn set_language(&mut self, language: Language, cx: &mut Context<Self>) {
        self.language = language;
        i18n::set_language(i18n::Lang::from_code(language.as_str()));
        if let Some(settings) = self.settings.as_mut() {
            settings.set_language(language);
        }
        self.save();
        cx.notify();
    }

    /// Đặt thư mục lưu mặc định từ ô nhập (Enter). Chuỗi rỗng là bỏ thư mục mặc định.
    fn set_save_dir(&mut self, text: &str, cx: &mut Context<Self>) {
        let dir = text.trim();
        self.save_dir = (!dir.is_empty()).then(|| dir.to_string());
        if let Some(settings) = self.settings.as_mut() {
            settings.set_default_save_dir(self.save_dir.as_deref());
        }
        self.save();
        cx.notify();
    }
}

fn theme_index(theme: Theme) -> usize {
    match theme {
        Theme::System => 0,
        Theme::Light => 1,
        Theme::Dark => 2,
    }
}

fn theme_from_index(index: usize) -> Theme {
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

fn language_from_index(index: usize) -> Language {
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

/// Dựng hộp thoại nếu đang mở. Mọi thay đổi đi qua `panel`, nơi duy nhất ghi file.
pub fn build(panel: &Entity<SettingsPanel>, window: &mut Window, cx: &mut App) -> Option<Dialog> {
    let (theme, language, dark, errors, theme_handles, close_handle, dir_input) = {
        let state = panel.read(cx);
        if !state.open {
            return None;
        }
        (
            state.theme,
            state.language,
            theme::is_dark(state.mode()),
            [state.read_error.clone(), state.write_error.clone()],
            state.theme_handles.clone(),
            state.close_handle.clone(),
            state.dir_input.clone(),
        )
    };
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
            theme_handles[i].clone(),
            t(key),
        )
    })
    .collect();
    let theme_panel = panel.clone();
    let theme_group = ToggleGroup::new("settings-theme", t("settings.theme"), theme_items)
        .selected(theme_index(theme))
        .dark(dark)
        .on_change(move |index, _, cx| {
            theme_panel.update(cx, |this, cx| this.set_theme(theme_from_index(index), cx));
        });

    let language_focus = select::trigger_focus(LANGUAGE_SELECT, window, cx);
    let language_panel = panel.clone();
    let language_select = Select::new(
        LANGUAGE_SELECT,
        t("settings.language"),
        vec![
            SharedString::from("Tiếng Việt"),
            SharedString::from("English"),
        ],
    )
    .selected(language_index(language))
    .width(220.0)
    .dark(dark)
    .on_change(move |index, _, cx| {
        language_panel.update(cx, |this, cx| {
            this.set_language(language_from_index(index), cx)
        });
    });

    let dir_focus = dir_input.read(cx).focus_handle(cx);
    let dir_field =
        TextField::new("settings-save-dir", t("settings.defaultSaveDir"), dir_input).dark(dark);

    let hint_color = if dark {
        chef_theme::dark::C_TEXT_3
    } else {
        chef_theme::light::C_TEXT_3
    };
    let hint = div()
        .text_size(px(chef_theme::shared::TEXT_SM))
        .text_color(rgba(chef_ui::button::pack(hint_color)))
        .child(t("settings.defaultSaveDirHint"));

    let danger = if dark {
        chef_theme::dark::C_DANGER
    } else {
        chef_theme::light::C_DANGER
    };
    let error_lines = errors.into_iter().flatten().map(|message| {
        div()
            .mb(px(12.))
            .text_size(px(chef_theme::shared::TEXT_SM))
            .text_color(rgba(chef_ui::button::pack(danger)))
            .child(message)
    });

    let dismiss_panel = panel.clone();
    let close_panel = panel.clone();
    let mut tab_order = theme_handles;
    tab_order.push(language_focus);
    tab_order.push(dir_focus);
    let mut dialog = Dialog::new("settings", t("settings.title"), Width::Md, dark)
        .close("settings-close", close_handle.clone(), t("common.close"))
        .tab_order(tab_order)
        .on_dismiss(move |window, cx| {
            dismiss_panel.update(cx, |this, cx| this.close(window, cx));
        });
    for line in error_lines {
        dialog = dialog.child(line);
    }
    let dialog = dialog
        .child(field(t("settings.theme").into(), theme_group, dark))
        .child(field(t("settings.language").into(), language_select, dark))
        .child(field(t("settings.defaultSaveDir").into(), dir_field, dark))
        .child(hint)
        .action(
            Button::new("settings-done", close_handle)
                .variant(Variant::Primary)
                .label(t("common.close"))
                .dark(dark)
                .on_click(move |_, window, cx| {
                    close_panel.update(cx, |this, cx| this.close(window, cx));
                }),
        );
    Some(dialog)
}
