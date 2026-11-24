//! Hộp thoại Cắt lề và đổi khổ (TASKS_RUST R5.05, FEATURES C7). Cắt lề đặt CropBox (theo lề mm, theo khung
//! pt, hoặc tự cắt viền trắng) nên nội dung còn nguyên; đổi khổ đưa trang về A3, A4, Letter hoặc cỡ tùy
//! chỉnh. Chạy `page.crop` / `page.resize` qua đường sửa revision của viewer (có hoàn tác).
//! Bản GPUI của phần "Cắt lề / đổi khổ" trong `apps/ui/src/features/pagetools`.

use chef_ui::dialog::Width;
use chef_ui::form::TextField;
use chef_ui::i18n::{t, t_with};
use chef_ui::task_dialog::TaskDialog;
use chef_ui::text_input::TextInput;
use gpui::{
    App, Context, Entity, EventEmitter, FocusHandle, Focusable, IntoElement, Render, Subscription,
    Window, div, prelude::*, px, rgba,
};
use serde_json::{Value, json};

use crate::page_range::{format_page_ranges, parse_page_ranges};
use crate::process::{
    Colors, ProcessContext, ProcessEvent, ProcessView, Runner, focus_handles, parse_decimal,
    radios, text_entity, wire,
};

// ---------------------------------------------------------------------------
// Phần thuần
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Crop,
    Resize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Margins,
    Box,
    AutoTrim,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    All,
    Odd,
    Even,
    Pages,
}

impl Scope {
    pub const ALL: [Scope; 4] = [Scope::All, Scope::Odd, Scope::Even, Scope::Pages];

    pub fn wire(self) -> &'static str {
        match self {
            Scope::All => "all",
            Scope::Odd => "odd",
            Scope::Even => "even",
            Scope::Pages => "pages",
        }
    }

    pub fn i18n_key(self) -> &'static str {
        match self {
            Scope::All => "pageTools.scope.all",
            Scope::Odd => "pageTools.scope.odd",
            Scope::Even => "pageTools.scope.even",
            Scope::Pages => "pageTools.scope.pages",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Paper {
    A3,
    A4,
    Letter,
    Custom,
}

impl Paper {
    pub const ALL: [Paper; 4] = [Paper::A3, Paper::A4, Paper::Letter, Paper::Custom];

    pub fn wire(self) -> &'static str {
        match self {
            Paper::A3 => "A3",
            Paper::A4 => "A4",
            Paper::Letter => "Letter",
            Paper::Custom => "custom",
        }
    }

    pub fn i18n_key(self) -> &'static str {
        match self {
            Paper::A3 => "pageTools.resize.preset.A3",
            Paper::A4 => "pageTools.resize.preset.A4",
            Paper::Letter => "pageTools.resize.preset.Letter",
            Paper::Custom => "pageTools.resize.preset.custom",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fit {
    Scale,
    Center,
}

/// Giá trị người dùng nhập, ở dạng chữ như trên form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CropInput {
    pub kind: Kind,
    pub method: Method,
    pub scope: Scope,
    pub pages: String,
    /// Lề mm theo thứ tự trên, phải, dưới, trái.
    pub margins: [String; 4],
    /// Khung pt: x0, y0, x1, y1.
    pub frame: [String; 4],
    pub padding_mm: String,
    pub paper: Paper,
    pub width_mm: String,
    pub height_mm: String,
    pub fit: Fit,
}

/// Lý do chưa chạy được; khóa i18n là `pageTools.issue.<tên>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CropIssue {
    Pages,
    Margins,
    Box,
    Padding,
    CustomSize,
}

impl CropIssue {
    pub fn i18n_key(self) -> &'static str {
        match self {
            CropIssue::Pages => "pageTools.issue.pages",
            CropIssue::Margins => "pageTools.issue.margins",
            CropIssue::Box => "pageTools.issue.box",
            CropIssue::Padding => "pageTools.issue.padding",
            CropIssue::CustomSize => "pageTools.issue.customSize",
        }
    }
}

/// Giới hạn lề, mm (theo thông báo "từ 0 đến 500 mm").
const MARGIN_MAX_MM: f64 = 500.0;
const PADDING_MAX_MM: f64 = 50.0;

/// `scope` và `pages` (chỉ số từ 0) của lõi.
fn scope_fields(
    input: &CropInput,
    page_count: usize,
) -> Result<(&'static str, Option<Vec<usize>>), CropIssue> {
    if input.scope != Scope::Pages {
        return Ok((input.scope.wire(), None));
    }
    let parsed = parse_page_ranges(&input.pages, page_count).map_err(|_| CropIssue::Pages)?;
    Ok((Scope::Pages.wire(), Some(parsed.pages)))
}

fn number_in(text: &str, min: f64, max: f64) -> Option<f64> {
    parse_decimal(text).filter(|v| *v >= min && *v <= max)
}

/// Tham số `page.crop`. Đúng một trong lề, khung, tự cắt, như lõi yêu cầu.
pub fn crop_params(input: &CropInput, page_count: usize) -> Result<Value, CropIssue> {
    let (scope, pages) = scope_fields(input, page_count)?;
    let mut params = json!({ "scope": scope, "mode": "cropbox" });
    if let Some(pages) = pages {
        params["pages"] = json!(pages);
    }
    match input.method {
        Method::Margins => {
            let mut values = [0.0; 4];
            for (slot, text) in values.iter_mut().zip(&input.margins) {
                *slot = number_in(text, 0.0, MARGIN_MAX_MM).ok_or(CropIssue::Margins)?;
            }
            let [top, right, bottom, left] = values;
            params["margins"] =
                json!({ "top": top, "right": right, "bottom": bottom, "left": left });
        }
        Method::Box => {
            let mut values = [0.0; 4];
            for (slot, text) in values.iter_mut().zip(&input.frame) {
                *slot = parse_decimal(text).ok_or(CropIssue::Box)?;
            }
            let [x0, y0, x1, y1] = values;
            if x1 <= x0 || y1 <= y0 {
                return Err(CropIssue::Box);
            }
            params["box"] = json!([x0, y0, x1, y1]);
        }
        Method::AutoTrim => {
            let padding =
                number_in(&input.padding_mm, 0.0, PADDING_MAX_MM).ok_or(CropIssue::Padding)?;
            params["autoTrim"] = json!(true);
            params["trimPaddingMm"] = json!(padding);
        }
    }
    Ok(params)
}

/// Tham số `page.resize`.
pub fn resize_params(input: &CropInput, page_count: usize) -> Result<Value, CropIssue> {
    let (scope, pages) = scope_fields(input, page_count)?;
    let mut params = json!({
        "scope": scope,
        "size": input.paper.wire(),
        "fit": match input.fit { Fit::Scale => "scale", Fit::Center => "center" },
    });
    if let Some(pages) = pages {
        params["pages"] = json!(pages);
    }
    if input.paper == Paper::Custom {
        let width = number_in(&input.width_mm, 1.0, f64::MAX).ok_or(CropIssue::CustomSize)?;
        let height = number_in(&input.height_mm, 1.0, f64::MAX).ok_or(CropIssue::CustomSize)?;
        params["customWidthMm"] = json!(width);
        params["customHeightMm"] = json!(height);
    }
    Ok(params)
}

/// Mã thao tác và tham số theo loại đang chọn.
pub fn build(input: &CropInput, page_count: usize) -> Result<(&'static str, Value), CropIssue> {
    match input.kind {
        Kind::Crop => crop_params(input, page_count).map(|p| ("page.crop", p)),
        Kind::Resize => resize_params(input, page_count).map(|p| ("page.resize", p)),
    }
}

/// Khung pt gợi ý lấy từ khổ trang đầu của phạm vi: toàn trang, `x0 y0 x1 y1`.
pub fn default_frame(first_page_pt: Option<(f32, f32)>) -> [String; 4] {
    let (w, h) = first_page_pt.unwrap_or((595.0, 842.0));
    [
        "0".into(),
        "0".into(),
        format!("{}", w.round()),
        format!("{}", h.round()),
    ]
}

// ---------------------------------------------------------------------------
// Giao diện
// ---------------------------------------------------------------------------

pub struct CropDialog {
    ctx: ProcessContext,
    kind: Kind,
    method: Method,
    scope: Scope,
    paper: Paper,
    fit: Fit,
    pages: Entity<TextInput>,
    margins: [Entity<TextInput>; 4],
    frame: [Entity<TextInput>; 4],
    padding: Entity<TextInput>,
    width: Entity<TextInput>,
    height: Entity<TextInput>,
    kind_focus: Vec<FocusHandle>,
    method_focus: Vec<FocusHandle>,
    scope_focus: Vec<FocusHandle>,
    paper_focus: Vec<FocusHandle>,
    fit_focus: Vec<FocusHandle>,
    return_to: FocusHandle,
    runner: Runner,
    _subs: Vec<Subscription>,
}

impl EventEmitter<ProcessEvent> for CropDialog {}

impl ProcessView for CropDialog {
    fn runner(&self) -> &Runner {
        &self.runner
    }

    fn runner_mut(&mut self) -> &mut Runner {
        &mut self.runner
    }

    fn context(&self) -> &ProcessContext {
        &self.ctx
    }
}

impl CropDialog {
    pub fn new(
        ctx: ProcessContext,
        kind: Kind,
        return_to: FocusHandle,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut subs = Vec::new();
        let selected = format_page_ranges(&ctx.target_pages);
        let frame = default_frame(ctx.page_sizes.first().copied());
        let mut text = |value: &str, cx: &mut Context<Self>| text_entity(cx, &mut subs, value, "");
        let pages = text(&selected, cx);
        let margins = [text("0", cx), text("0", cx), text("0", cx), text("0", cx)];
        let frame = [
            text(&frame[0], cx),
            text(&frame[1], cx),
            text(&frame[2], cx),
            text(&frame[3], cx),
        ];
        let padding = text("3", cx);
        let width = text("210", cx);
        let height = text("297", cx);
        Self {
            kind,
            method: Method::Margins,
            scope: if ctx.target_pages.is_empty() || ctx.target_pages.len() >= ctx.page_count {
                Scope::All
            } else {
                Scope::Pages
            },
            paper: Paper::A4,
            fit: Fit::Scale,
            pages,
            margins,
            frame,
            padding,
            width,
            height,
            kind_focus: focus_handles(cx, 2),
            method_focus: focus_handles(cx, 3),
            scope_focus: focus_handles(cx, Scope::ALL.len()),
            paper_focus: focus_handles(cx, Paper::ALL.len()),
            fit_focus: focus_handles(cx, 2),
            return_to,
            runner: Runner::default(),
            ctx,
            _subs: subs,
        }
    }

    fn input(&self, cx: &App) -> CropInput {
        let read = |e: &Entity<TextInput>| e.read(cx).text().to_string();
        CropInput {
            kind: self.kind,
            method: self.method,
            scope: self.scope,
            pages: read(&self.pages),
            margins: std::array::from_fn(|i| read(&self.margins[i])),
            frame: std::array::from_fn(|i| read(&self.frame[i])),
            padding_mm: read(&self.padding),
            paper: self.paper,
            width_mm: read(&self.width),
            height_mm: read(&self.height),
            fit: self.fit,
        }
    }

    /// Hộp thoại không tự chạy: trao tham số cho viewer chạy qua `begin_edit`.
    fn run(&mut self, cx: &mut Context<Self>) {
        match build(&self.input(cx), self.ctx.page_count) {
            Ok((op_id, params)) => cx.emit(ProcessEvent::ApplyRevision { op_id, params }),
            Err(issue) => {
                self.runner.result =
                    Some(chef_ui::task_dialog::TaskResult::error(t(issue.i18n_key())));
                cx.notify();
            }
        }
    }
}

impl Render for CropDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let dark = self.ctx.dark;
        let colors = Colors::of(dark);
        let entity = cx.entity();
        let input = self.input(cx);
        let issue = build(&input, self.ctx.page_count).err();
        let hint = |text: String| {
            div()
                .text_size(px(chef_theme::shared::TEXT_SM))
                .text_color(rgba(colors.muted))
                .child(text)
        };
        let label = |text: String| {
            div()
                .text_size(px(chef_theme::shared::TEXT_MD))
                .text_color(rgba(colors.text))
                .child(text)
        };
        let field = |id: &'static str, text: String, e: &Entity<TextInput>| {
            div()
                .flex_1()
                .child(TextField::new(id, text, e.clone()).dark(dark))
        };

        let kind_e = entity.clone();
        let kind = radios(
            "crop-kind",
            t("pageTools.crop.kind"),
            vec![t("pageTools.crop.kind"), t("pageTools.resize.kind")],
            &self.kind_focus,
            usize::from(self.kind == Kind::Resize),
            (dark, true),
            move |i, _, cx| {
                kind_e.update(cx, |me, cx| {
                    me.kind = if i == 0 { Kind::Crop } else { Kind::Resize };
                    me.runner.result = None;
                    cx.notify();
                });
            },
        );

        let mut main = div().flex().flex_col().gap(px(12.)).child(kind);

        match self.kind {
            Kind::Crop => {
                let method_e = entity.clone();
                main = main.child(label(t("pageTools.crop.method"))).child(radios(
                    "crop-method",
                    t("pageTools.crop.method"),
                    vec![
                        t("pageTools.crop.m.margins"),
                        t("pageTools.crop.m.box"),
                        t("pageTools.crop.m.autoTrim"),
                    ],
                    &self.method_focus,
                    match self.method {
                        Method::Margins => 0,
                        Method::Box => 1,
                        Method::AutoTrim => 2,
                    },
                    (dark, true),
                    move |i, _, cx| {
                        method_e.update(cx, |me, cx| {
                            me.method = [Method::Margins, Method::Box, Method::AutoTrim]
                                .get(i)
                                .copied()
                                .unwrap_or(Method::Margins);
                            cx.notify();
                        });
                    },
                ));
                match self.method {
                    Method::Margins => {
                        let sides = ["top", "right", "bottom", "left"];
                        let ids = ["crop-m-top", "crop-m-right", "crop-m-bottom", "crop-m-left"];
                        let mut row = div().flex().gap(px(8.));
                        for i in 0..4 {
                            row = row.child(field(
                                ids[i],
                                format!(
                                    "{} ({})",
                                    t(&format!("pageTools.crop.side.{}", sides[i])),
                                    t("pageTools.crop.mm")
                                ),
                                &self.margins[i],
                            ));
                        }
                        main = main.child(row);
                    }
                    Method::Box => {
                        let keys = ["x0", "y0", "x1", "y1"];
                        let ids = ["crop-b-x0", "crop-b-y0", "crop-b-x1", "crop-b-y1"];
                        let mut row = div().flex().gap(px(8.));
                        for i in 0..4 {
                            row = row.child(field(
                                ids[i],
                                t(&format!("pageTools.crop.box.{}", keys[i])),
                                &self.frame[i],
                            ));
                        }
                        main = main.child(row).child(hint(t("pageTools.crop.pt")));
                    }
                    Method::AutoTrim => {
                        main = main.child(field(
                            "crop-padding",
                            format!(
                                "{} ({})",
                                t("pageTools.crop.padding"),
                                t("pageTools.crop.mm")
                            ),
                            &self.padding,
                        ));
                    }
                }
            }
            Kind::Resize => {
                let paper_e = entity.clone();
                main = main.child(label(t("pageTools.resize.size"))).child(radios(
                    "resize-paper",
                    t("pageTools.resize.size"),
                    Paper::ALL.iter().map(|p| t(p.i18n_key())).collect(),
                    &self.paper_focus,
                    Paper::ALL
                        .iter()
                        .position(|p| *p == self.paper)
                        .unwrap_or(1),
                    (dark, true),
                    move |i, _, cx| {
                        paper_e.update(cx, |me, cx| {
                            me.paper = Paper::ALL.get(i).copied().unwrap_or(Paper::A4);
                            cx.notify();
                        });
                    },
                ));
                if self.paper == Paper::Custom {
                    main = main.child(
                        div()
                            .flex()
                            .gap(px(8.))
                            .child(field("resize-w", t("pageTools.resize.width"), &self.width))
                            .child(field(
                                "resize-h",
                                t("pageTools.resize.height"),
                                &self.height,
                            )),
                    );
                }
                let fit_e = entity.clone();
                main = main.child(label(t("pageTools.resize.fit"))).child(radios(
                    "resize-fit",
                    t("pageTools.resize.fit"),
                    vec![
                        t("pageTools.resize.fitScale"),
                        t("pageTools.resize.fitCenter"),
                    ],
                    &self.fit_focus,
                    usize::from(self.fit == Fit::Center),
                    (dark, false),
                    move |i, _, cx| {
                        fit_e.update(cx, |me, cx| {
                            me.fit = if i == 0 { Fit::Scale } else { Fit::Center };
                            cx.notify();
                        });
                    },
                ));
            }
        }

        // Phạm vi trang.
        let scope_e = entity.clone();
        main = main.child(label(t("pageTools.scope.label"))).child(radios(
            "crop-scope",
            t("pageTools.scope.label"),
            Scope::ALL.iter().map(|s| t(s.i18n_key())).collect(),
            &self.scope_focus,
            Scope::ALL
                .iter()
                .position(|s| *s == self.scope)
                .unwrap_or(0),
            (dark, true),
            move |i, _, cx| {
                scope_e.update(cx, |me, cx| {
                    me.scope = Scope::ALL.get(i).copied().unwrap_or(Scope::All);
                    cx.notify();
                });
            },
        ));
        if self.scope == Scope::Pages {
            main = main.child(
                TextField::new("crop-pages", t("pageTools.scope.pages"), self.pages.clone())
                    .dark(dark),
            );
        }
        if let Some(issue) = issue {
            main = main.child(
                div()
                    .text_size(px(chef_theme::shared::TEXT_SM))
                    .text_color(rgba(colors.danger))
                    .child(t(issue.i18n_key())),
            );
        }

        let (title_key, run_key, desc_key) = match self.kind {
            Kind::Crop => (
                "pageTools.crop.title",
                "pageTools.crop.run",
                "pageTools.crop.description",
            ),
            Kind::Resize => (
                "pageTools.resize.kind",
                "pageTools.resize.run",
                "pageTools.crop.description",
            ),
        };
        let mut order = self.kind_focus.clone();
        order.extend(match self.kind {
            Kind::Crop => self.method_focus.clone(),
            Kind::Resize => [self.paper_focus.clone(), self.fit_focus.clone()].concat(),
        });
        order.extend(self.scope_focus.iter().cloned());
        let source: Vec<&Entity<TextInput>> = match (self.kind, self.method) {
            (Kind::Crop, Method::Margins) => self.margins.iter().collect(),
            (Kind::Crop, Method::Box) => self.frame.iter().collect(),
            (Kind::Crop, Method::AutoTrim) => vec![&self.padding],
            (Kind::Resize, _) => vec![&self.width, &self.height],
        };
        for e in source {
            order.push(e.read(cx).focus_handle(cx));
        }
        if self.scope == Scope::Pages {
            order.push(self.pages.read(cx).focus_handle(cx));
        }
        let dialog = TaskDialog::new("crop-dialog", t(title_key), dark)
            .icon("icons/crop.svg")
            .description(t_with(desc_key, &[("name", &self.ctx.file_name)]))
            .size(Width::Lg)
            .return_focus(self.return_to.clone())
            .child(main)
            .run_label(t(run_key))
            .can_run(build(&input, self.ctx.page_count).is_ok())
            .tab_order(order);
        wire(dialog, self, cx, Self::run)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input() -> CropInput {
        CropInput {
            kind: Kind::Crop,
            method: Method::Margins,
            scope: Scope::All,
            pages: String::new(),
            margins: ["5".into(), "6,5".into(), "7".into(), "8".into()],
            frame: ["0".into(), "0".into(), "595".into(), "842".into()],
            padding_mm: "3".into(),
            paper: Paper::A4,
            width_mm: "210".into(),
            height_mm: "297".into(),
            fit: Fit::Scale,
        }
    }

    #[test]
    fn crop_by_margins_sends_exactly_the_margins_method() {
        let p = crop_params(&input(), 10).unwrap();
        assert_eq!(
            p,
            json!({"scope":"all","mode":"cropbox",
                   "margins":{"top":5.0,"right":6.5,"bottom":7.0,"left":8.0}})
        );
        assert!(p.get("box").is_none() && p.get("autoTrim").is_none());
    }

    #[test]
    fn crop_by_frame_and_auto_trim() {
        let mut i = input();
        i.method = Method::Box;
        assert_eq!(
            crop_params(&i, 3).unwrap()["box"],
            json!([0.0, 0.0, 595.0, 842.0])
        );
        i.frame[2] = "0".into();
        assert_eq!(crop_params(&i, 3), Err(CropIssue::Box));
        i.method = Method::AutoTrim;
        let p = crop_params(&i, 3).unwrap();
        assert_eq!(p["autoTrim"], true);
        assert_eq!(p["trimPaddingMm"], 3.0);
        i.padding_mm = "80".into();
        assert_eq!(crop_params(&i, 3), Err(CropIssue::Padding));
    }

    #[test]
    fn rejects_bad_margins() {
        let mut i = input();
        i.margins[1] = "-1".into();
        assert_eq!(crop_params(&i, 3), Err(CropIssue::Margins));
        i.margins[1] = "501".into();
        assert_eq!(crop_params(&i, 3), Err(CropIssue::Margins));
        i.margins[1] = "abc".into();
        assert_eq!(crop_params(&i, 3), Err(CropIssue::Margins));
    }

    #[test]
    fn page_scope_converts_to_zero_based_pages() {
        let mut i = input();
        i.scope = Scope::Pages;
        i.pages = "2-3, 5".into();
        assert_eq!(crop_params(&i, 6).unwrap()["pages"], json!([1, 2, 4]));
        assert_eq!(crop_params(&i, 4), Err(CropIssue::Pages));
        i.pages = String::new();
        assert_eq!(crop_params(&i, 6), Err(CropIssue::Pages));
        i.scope = Scope::Odd;
        let p = crop_params(&i, 6).unwrap();
        assert_eq!(p["scope"], "odd");
        assert!(p.get("pages").is_none());
    }

    #[test]
    fn resize_to_standard_and_custom_sizes() {
        let mut i = input();
        i.kind = Kind::Resize;
        assert_eq!(
            resize_params(&i, 5).unwrap(),
            json!({"scope":"all","size":"A4","fit":"scale"})
        );
        i.paper = Paper::Letter;
        i.fit = Fit::Center;
        let p = resize_params(&i, 5).unwrap();
        assert_eq!(
            (p["size"].as_str(), p["fit"].as_str()),
            (Some("Letter"), Some("center"))
        );
        i.paper = Paper::Custom;
        i.width_mm = "0".into();
        assert_eq!(resize_params(&i, 5), Err(CropIssue::CustomSize));
        i.width_mm = "100,5".into();
        let p = resize_params(&i, 5).unwrap();
        assert_eq!(p["customWidthMm"], 100.5);
        assert_eq!(p["customHeightMm"], 297.0);
        assert_eq!(build(&i, 5).unwrap().0, "page.resize");
        i.kind = Kind::Crop;
        assert_eq!(build(&i, 5).unwrap().0, "page.crop");
    }

    #[test]
    fn default_frame_uses_the_first_page_size() {
        assert_eq!(
            default_frame(Some((595.28, 841.89))),
            ["0", "0", "595", "842"]
        );
        assert_eq!(default_frame(None)[2], "595");
    }
}
