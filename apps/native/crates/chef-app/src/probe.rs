//! Trang thử hình họa M1 (TASKS_RUST R1.13, R1.15–R1.19). Chỉ mở khi `CHEF_E2E=1` và
//! `CHEF_E2E_PROBE=1`, đặt ngoài màn hình như cửa sổ E2E. Không phải giao diện thật: mỗi khu là một
//! kiểm tra, chụp bằng kênh debug (`screenshot`) rồi so với bản Electron.

use std::sync::Arc;

use chef_theme::{Rgba, dark, light};
use gpui::{
    App, BoxShadow, ClickEvent, Context, Div, Entity, FocusHandle, Focusable, FontFeatures,
    FontWeight, Hsla, IntoElement, Render, Window, div, point, prelude::*, px, rgb, rgba, svg,
};

use chef_ui::button::{Button, Size, Variant};
use chef_ui::dialog::{Dialog, Width};
use chef_ui::form::{CheckState, Checkbox, Switch, TextField};
use chef_ui::text_input::TextInput;

use crate::theme::{hex, is_dark, mode_from_env, rgba_hex};

/// Icon dùng để thử: một nét đơn (check), nét đôi (chevron), nét đầy (bold), hình khối (copy).
const ICONS: &[&str] = &[
    "check",
    "chevron-down",
    "bold",
    "copy",
    "crop",
    "combine",
    "arrow-left-right",
    "alert-triangle",
    "circle-x",
    "clock",
];

/// Màu theo theme đang chọn. Lấy trực tiếp từ token sinh (chef-theme), không sao chép số tay.
#[derive(Clone, Copy)]
struct Colors {
    dark: bool,
    bg: u32,
    surface: u32,
    border: u32,
    text: u32,
    text_2: u32,
    focus: u32,
}

impl Colors {
    fn new(dark_theme: bool) -> Self {
        let t = if dark_theme {
            Tokens::DARK
        } else {
            Tokens::LIGHT
        };
        Self {
            dark: dark_theme,
            bg: hex(t.bg),
            surface: hex(t.surface),
            border: hex(t.border),
            text: hex(t.text),
            text_2: hex(t.text_2),
            focus: rgba_hex(t.focus),
        }
    }
}

/// Các token của một theme mà probe dùng, lấy từ chef-theme.
struct Tokens {
    bg: Rgba,
    surface: Rgba,
    border: Rgba,
    text: Rgba,
    text_2: Rgba,
    focus: Rgba,
}

impl Tokens {
    const LIGHT: Tokens = Tokens {
        bg: light::C_BG,
        surface: light::C_SURFACE,
        border: light::C_BORDER,
        text: light::C_TEXT,
        text_2: light::C_TEXT_2,
        focus: light::C_FOCUS,
    };
    const DARK: Tokens = Tokens {
        bg: dark::C_BG,
        surface: dark::C_SURFACE,
        border: dark::C_BORDER,
        text: dark::C_TEXT,
        text_2: dark::C_TEXT_2,
        focus: dark::C_FOCUS,
    };
}

/// Màu alpha của token (RRGGBBAA) thành `Hsla` cho BoxShadow.
fn shade(rgba_u32: u32) -> Hsla {
    rgba(rgba_u32).into()
}

pub struct Probe {
    buttons: Vec<FocusHandle>,
    /// Khu R2.04: checkbox, checkbox không xác định, switch, và ô nhập có nhãn.
    form: Vec<FocusHandle>,
    input: Entity<TextInput>,
    check: CheckState,
    mixed: CheckState,
    switch_on: bool,
    /// Khu R2.10: nút mở hộp thoại và các điều khiển bên trong (theo thứ tự Tab).
    dialog_open: bool,
    dialog_opener: FocusHandle,
    dialog_close: FocusHandle,
    dialog_input: Entity<TextInput>,
    dialog_keep_ext: FocusHandle,
    dialog_keep: CheckState,
    dialog_cancel: FocusHandle,
    dialog_ok: FocusHandle,
}

impl Probe {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            buttons: (0..6).map(|_| cx.focus_handle()).collect(),
            form: (0..3).map(|_| cx.focus_handle()).collect(),
            input: cx.new(|cx| TextInput::new(cx, "Nhập họ tên")),
            check: CheckState::Unchecked,
            mixed: CheckState::Indeterminate,
            switch_on: false,
            dialog_open: false,
            dialog_opener: cx.focus_handle(),
            dialog_close: cx.focus_handle(),
            dialog_input: cx.new(|cx| TextInput::new(cx, "Tên mới")),
            dialog_keep_ext: cx.focus_handle(),
            dialog_keep: CheckState::Checked,
            dialog_cancel: cx.focus_handle(),
            dialog_ok: cx.focus_handle(),
        }
    }

    /// R2.10: mở hộp thoại và đưa tiêu điểm vào nút đóng, mục đầu của vòng Tab.
    fn open_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dialog_open = true;
        window.focus(&self.dialog_close, cx);
        cx.notify();
    }

    /// R2.10: đóng hộp thoại và trả tiêu điểm về nút đã mở.
    fn close_dialog(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.dialog_open = false;
        window.focus(&self.dialog_opener, cx);
        cx.notify();
    }

    /// Hộp thoại mẫu: một ô nhập, một checkbox, hai nút. Dựng lại mỗi khung khi đang mở.
    fn dialog(&self, c: &Colors, cx: &mut Context<Self>) -> Dialog {
        let entity = cx.entity();
        let input_focus = self.dialog_input.read(cx).focus_handle(cx);
        Dialog::new("dlg", "Đổi tên tệp", Width::Md, c.dark)
            .close("dlg-close", self.dialog_close.clone(), "Đóng")
            .tab_order(vec![
                input_focus,
                self.dialog_keep_ext.clone(),
                self.dialog_cancel.clone(),
                self.dialog_ok.clone(),
            ])
            .return_focus(self.dialog_opener.clone())
            .on_dismiss(move |window, cx| {
                entity.update(cx, |this, cx| this.close_dialog(window, cx));
            })
            .child(
                div()
                    .mb(px(12.))
                    .text_color(rgba(c.text_2))
                    .text_size(px(13.))
                    .child("Nhập tên mới rồi bấm Lưu."),
            )
            .child(div().mb(px(12.)).child(
                TextField::new("dlg-name", "Tên mới", self.dialog_input.clone()).dark(c.dark),
            ))
            .child(
                Checkbox::new(
                    "dlg-keep-ext",
                    self.dialog_keep_ext.clone(),
                    "Giữ phần mở rộng .pdf",
                    self.dialog_keep,
                )
                .dark(c.dark)
                .on_change(cx.listener(
                    |this: &mut Probe, next: &CheckState, _, cx| {
                        this.dialog_keep = *next;
                        cx.notify();
                    },
                )),
            )
            .action(
                Button::new("dlg-cancel", self.dialog_cancel.clone())
                    .variant(Variant::Secondary)
                    .label("Hủy")
                    .dark(c.dark)
                    .on_click(cx.listener(|this: &mut Probe, _: &ClickEvent, window, cx| {
                        this.close_dialog(window, cx)
                    })),
            )
            .action(
                Button::new("dlg-ok", self.dialog_ok.clone())
                    .variant(Variant::Primary)
                    .label("Lưu")
                    .dark(c.dark)
                    .on_click(cx.listener(|this: &mut Probe, _: &ClickEvent, window, cx| {
                        this.close_dialog(window, cx)
                    })),
            )
    }
}

/// R2.10: nút mở hộp thoại mẫu. Hộp thoại được dựng ở `Probe::render` khi đang mở.
fn dialog_section(c: &Colors, probe: &Probe, cx: &mut Context<Probe>) -> Div {
    section(
        "R2.10 · hộp thoại: bẫy tiêu điểm, Esc, bấm ra ngoài, trả tiêu điểm",
        c,
    )
    .child(
        Button::new("dialog-open", probe.dialog_opener.clone())
            .variant(Variant::Secondary)
            .label("Mở hộp thoại")
            .dark(c.dark)
            .on_click(cx.listener(|this: &mut Probe, _: &ClickEvent, window, cx| {
                this.open_dialog(window, cx)
            })),
    )
}

/// R2.04: ô nhập có nhãn, checkbox, checkbox không xác định và switch. Trạng thái nằm ở `Probe`.
fn form_section(c: &Colors, probe: &Probe, cx: &mut Context<Probe>) -> Div {
    let check = probe.check;
    let mixed = probe.mixed;
    let on = probe.switch_on;
    section(
        "R2.04 · biểu mẫu: ô nhập có nhãn, checkbox, switch (Space và Enter bật/tắt)",
        c,
    )
    .flex_row()
    .flex_wrap()
    .gap(px(24.))
    .child(TextField::new("probe-name", "Họ tên", probe.input.clone()).dark(c.dark))
    .child(
        Checkbox::new(
            "probe-check",
            probe.form[0].clone(),
            "Đồng ý điều khoản",
            check,
        )
        .dark(c.dark)
        .on_change(cx.listener(|this: &mut Probe, next: &CheckState, _, cx| {
            this.check = *next;
            cx.notify();
        })),
    )
    .child(
        Checkbox::new("probe-mixed", probe.form[1].clone(), "Chọn một phần", mixed)
            .dark(c.dark)
            .on_change(cx.listener(|this: &mut Probe, next: &CheckState, _, cx| {
                this.mixed = *next;
                cx.notify();
            })),
    )
    .child(
        Switch::new("probe-switch", probe.form[2].clone(), "Thông báo", on)
            .dark(c.dark)
            .on_change(cx.listener(|this: &mut Probe, next: &bool, _, cx| {
                this.switch_on = *next;
                cx.notify();
            })),
    )
}

/// Khối có tiêu đề nhỏ, dùng chung cho các khu thử.
fn section(title: &str, c: &Colors) -> Div {
    div()
        .flex()
        .flex_col()
        .gap(px(8.))
        .p(px(12.))
        .bg(rgb(c.surface))
        .border_1()
        .border_color(rgb(c.border))
        .rounded(px(8.))
        .child(
            div()
                .text_size(px(11.))
                .text_color(rgb(c.text_2))
                .child(title.to_string()),
        )
}

/// R1.13: ba độ đậm của Be Vietnam Pro ở 13 px, kèm chữ có dấu.
fn fonts_section(c: &Colors) -> Div {
    let line = |label: &str, weight: FontWeight| {
        div()
            .font_weight(weight)
            .child(format!("{label}: Thanh toán được"))
    };
    section("R1.13 · font 13 px (400, 500, 600)", c)
        .text_size(px(13.))
        .child(line("400", FontWeight::NORMAL))
        .child(line("500", FontWeight::MEDIUM))
        .child(line("600", FontWeight::SEMIBOLD))
        .child("Nghị định 123/2024/NĐ-CP · Đ đ Ư ư Ơ ơ · ẮẰẲẴẶ ệ ộ ự")
}

/// R1.15: icon 16 px và 18 px, tô bằng màu chữ.
fn icons_section(c: &Colors) -> Div {
    let row = |size: f32| {
        div()
            .flex()
            .gap(px(12.))
            .items_center()
            .children(ICONS.iter().map(|name| {
                svg()
                    .path(format!("icons/{name}.svg"))
                    .size(px(size))
                    .text_color(rgb(c.text))
            }))
    };
    section("R1.15 · icon 16 px và 18 px (currentColor)", c)
        .child(row(16.))
        .child(row(18.))
}

/// R1.16: `--shadow-md` bằng BoxShadow và vòng focus `0 0 0 2px surface, 0 0 0 4px focus`.
fn shadow_section(c: &Colors) -> Div {
    let md = if c.dark {
        vec![
            BoxShadow {
                color: shade(0x0000_0066),
                offset: point(px(0.), px(6.)),
                blur_radius: px(8.),
                spread_radius: px(0.),
            },
            BoxShadow {
                color: shade(0x0000_004d),
                offset: point(px(0.), px(1.)),
                blur_radius: px(1.5),
                spread_radius: px(0.),
            },
        ]
    } else {
        vec![
            BoxShadow {
                color: shade(0x1018_2817),
                offset: point(px(0.), px(4.)),
                blur_radius: px(6.),
                spread_radius: px(0.),
            },
            BoxShadow {
                color: shade(0x1018_280f),
                offset: point(px(0.), px(1.)),
                blur_radius: px(1.5),
                spread_radius: px(0.),
            },
        ]
    };
    let ring = vec![
        BoxShadow {
            color: shade((c.surface << 8) | 0xff),
            offset: point(px(0.), px(0.)),
            blur_radius: px(0.5),
            spread_radius: px(2.),
        },
        BoxShadow {
            color: shade(c.focus),
            offset: point(px(0.), px(0.)),
            blur_radius: px(0.5),
            spread_radius: px(4.),
        },
    ];
    section("R1.16 · bóng --shadow-md và vòng focus", c)
        .flex_row()
        .items_center()
        .gap(px(32.))
        .child(
            div()
                .w(px(120.))
                .h(px(60.))
                .rounded(px(8.))
                .bg(rgb(c.surface))
                .shadow(md),
        )
        .child(
            div()
                .w(px(120.))
                .h(px(60.))
                .rounded(px(8.))
                .bg(rgb(c.surface))
                .border_1()
                .border_color(rgb(c.border))
                .shadow(ring),
        )
}

/// R1.18: `font-variant-numeric: tabular-nums` bằng OpenType `tnum`, cạnh chữ số thường.
fn tnum_section(c: &Colors) -> Div {
    let tnum = FontFeatures(Arc::new(vec![("tnum".to_string(), 1)]));
    let rows = ["1111111", "1234567", "98765", "7"];
    let column = |features: Option<FontFeatures>| {
        let mut col = div().flex().flex_col().gap(px(4.)).items_end();
        for value in rows {
            let mut cell = div()
                .w(px(120.))
                .text_right()
                .border_b_1()
                .border_color(rgb(c.border))
                .child(value.to_string());
            if let Some(f) = &features {
                cell = cell.font_features(f.clone());
            }
            col = col.child(cell);
        }
        col
    };
    section("R1.18 · số cột: không tnum (trái) và tnum (phải)", c)
        .flex_row()
        .gap(px(48.))
        .child(column(None))
        .child(column(Some(tnum)))
}

/// R2.03: nút của chef-ui theo biến thể, cỡ, trạng thái vô hiệu và nút chỉ icon.
fn button_section(c: &Colors, h: &[FocusHandle]) -> Div {
    section(
        "R2.03 · nút chef-ui (Tab đi qua nút, nút vô hiệu bỏ qua)",
        c,
    )
    .flex_row()
    .flex_wrap()
    .gap(px(16.))
    .child(
        Button::new("probe-primary", h[0].clone())
            .label("Primary")
            .variant(Variant::Primary)
            .dark(c.dark),
    )
    .child(
        Button::new("probe-secondary", h[1].clone())
            .label("Secondary")
            .variant(Variant::Secondary)
            .dark(c.dark),
    )
    .child(
        Button::new("probe-ghost", h[2].clone())
            .label("Ghost")
            .variant(Variant::Ghost)
            .dark(c.dark),
    )
    .child(
        Button::new("probe-danger", h[3].clone())
            .label("Danger")
            .variant(Variant::Danger)
            .dark(c.dark),
    )
    .child(
        Button::new("probe-disabled", h[4].clone())
            .label("Vô hiệu")
            .disabled(true)
            .dark(c.dark),
    )
    .child(
        Button::new("probe-icon", h[5].clone())
            .icon("icons/copy.svg")
            .aria_label("Sao chép")
            .size(Size::Sm)
            .dark(c.dark),
    )
}

/// R1.17: lưới kiểu `repeat(auto-fit, minmax(220px,1fr))`, ellipsis một dòng, `minmax(0,1fr) 300px`,
/// `aspect-ratio: 260/100`. GPUI không có auto-fit: số cột tính từ chiều rộng khung nhìn.
fn layout_section(c: &Colors, viewport_w: f32) -> Div {
    const MIN_CARD: f32 = 220.;
    const GAP: f32 = 12.;
    // Nội dung của khối: chiều rộng khung trừ lề 24 px hai bên và 12 px padding của khối.
    let inner = viewport_w - 48. - 24.;
    let cols = (((inner + GAP) / (MIN_CARD + GAP)).floor() as u16).max(1);
    let card = |i: usize| {
        div()
            .h(px(40.))
            .rounded(px(6.))
            .bg(rgb(c.bg))
            .border_1()
            .border_color(rgb(c.border))
            .flex()
            .items_center()
            .px(px(8.))
            .child(format!("ô {}", i + 1))
    };
    let grid = div()
        .grid()
        .grid_cols(cols)
        .gap(px(GAP))
        .children((0..cols as usize * 2).map(card));
    let ellipsis = div()
        .w(px(160.))
        .truncate()
        .child("Chuỗi rất dài cần cắt một dòng với dấu ba chấm ở cuối");
    let split = div()
        .flex()
        .gap(px(GAP))
        .child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .child("Cột trái co lại được, chữ dài bị cắt bằng ellipsis khi khung hẹp"),
        )
        .child(div().w(px(300.)).bg(rgb(c.bg)).child("Cột phải 300 px"));
    let ratio = div()
        .w(px(260.))
        .aspect_ratio(260. / 100.)
        .bg(rgb(c.bg))
        .border_1()
        .border_color(rgb(c.border))
        .child("260 × 100");
    section(
        &format!("R1.17 · auto-fit: {cols} cột ở khung {viewport_w:.0} px"),
        c,
    )
    .child(grid)
    .child(ellipsis)
    .child(split)
    .child(ratio)
}

impl Probe {
    /// Đưa tiêu điểm vào nút "Focus" để chụp trạng thái focus-visible. Gọi một lần sau khi mở.
    pub fn focus_button(&self, window: &mut Window, cx: &mut App) {
        window.focus(&self.buttons[0], cx);
    }
}

impl Render for Probe {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        chef_ui::a11y::begin_frame(window.scale_factor());
        crate::debug::count_render();
        let c = Colors::new(is_dark(mode_from_env()));
        chef_ui::button::focus_nav(div())
            .size_full()
            .bg(rgb(c.bg))
            .text_color(rgb(c.text))
            .font_family("Be Vietnam Pro")
            .p(px(24.))
            .flex()
            .flex_col()
            .gap(px(16.))
            .child(button_section(&c, &self.buttons))
            .child(form_section(&c, self, cx))
            .child(fonts_section(&c))
            .child(icons_section(&c))
            .child(shadow_section(&c))
            .child(layout_section(&c, window.viewport_size().width.as_f32()))
            .child(tnum_section(&c))
            .child(dialog_section(&c, self, cx))
            .children(self.dialog_open.then(|| self.dialog(&c, cx)))
    }
}
