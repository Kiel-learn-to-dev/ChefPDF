//! Hộp thoại Tách thông minh (TASKS_RUST R5.08, FEATURES C10): tách một PDF thành nhiều file khi gặp trang
//! trắng phân cách, bookmark ở cấp đã chọn, hoặc trang có chữ khớp một mẫu. Chạy `file.splitSmart`
//! (standalone, đọc file trên đĩa, không đổi file gốc). Trang trắng phân cách có thể được bỏ khỏi kết quả.
//!
//! Xem trước các điểm tách: với trang trắng, hộp thoại dò bằng `page.findBlank` cùng tham số mà lõi dùng
//! khi tách (viền 5 mm, giữ trang có chú thích) rồi dựng các nhóm trang giống lõi; với bookmark thì dùng
//! bookmark đã đọc của tài liệu đang mở. Mẫu chữ không xem trước được (cần tìm chữ trên từng trang).
//! Mã QR phân cách (nêu trong mô tả task) chưa có trong lõi nên chưa có ở đây.

use std::path::PathBuf;

use chef_ui::button::{Button, Size};
use chef_ui::choice::Slider;
use chef_ui::dialog::Width;
use chef_ui::form::{CheckState, Checkbox, TextField};
use chef_ui::i18n::{t, t_with};
use chef_ui::task_dialog::{TaskDialog, TaskResult, display_basename};
use chef_ui::text_input::TextInput;
use gpui::{
    App, Context, Entity, EventEmitter, FocusHandle, Focusable, IntoElement, Render, Subscription,
    Window, div, prelude::*, px, rgba,
};
use serde_json::{Value, json};

use crate::blank_pages::{BlankRow, parse_find_result};
use crate::page_range::{
    DEFAULT_NAME_TEMPLATE, PageGroup, TEMPLATE_VARIABLES, preview_names, unknown_variables,
};
use crate::process::{
    Colors, JobFail, ProcessContext, ProcessEvent, ProcessView, Runner, Target, file_stem,
    focus_handles, parent_dir, parse_decimal, radios, spawn_jobs, text_entity, wire,
};

/// Số tên file hiện trong cột xem trước.
const PREVIEW_ROWS: usize = 6;

// ---------------------------------------------------------------------------
// Phần thuần
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SmartMode {
    Blank,
    BookmarkLevel,
    Pattern,
}

impl SmartMode {
    pub const ALL: [SmartMode; 3] = [
        SmartMode::Blank,
        SmartMode::BookmarkLevel,
        SmartMode::Pattern,
    ];

    pub fn wire(self) -> &'static str {
        match self {
            SmartMode::Blank => "blank",
            SmartMode::BookmarkLevel => "bookmarkLevel",
            SmartMode::Pattern => "pattern",
        }
    }

    pub fn i18n_key(self) -> &'static str {
        match self {
            SmartMode::Blank => "pageTools.smart.mode.blank",
            SmartMode::BookmarkLevel => "pageTools.smart.mode.bookmarkLevel",
            SmartMode::Pattern => "pageTools.smart.mode.pattern",
        }
    }
}

/// Giá trị người dùng nhập, ở dạng chữ.
#[derive(Debug, Clone, PartialEq)]
pub struct SmartInput {
    pub source: String,
    pub mode: SmartMode,
    pub level: String,
    pub pattern: String,
    pub ignore_case: bool,
    pub drop_separators: bool,
    /// 0 đến 100 (%).
    pub sensitivity_percent: f32,
    pub output_dir: String,
    pub template: String,
}

/// Lý do chưa chạy được; khóa i18n là `pageTools.issue.<tên>`, riêng `Source` dùng `pageTools.smart.source`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SmartIssue {
    Source,
    Level,
    Pattern,
    OutputDir,
    Template,
    UnknownVariables(Vec<String>),
}

impl SmartIssue {
    pub fn message(&self) -> String {
        match self {
            SmartIssue::Source => t("pageTools.smart.source"),
            SmartIssue::Level => t("pageTools.issue.level"),
            SmartIssue::Pattern => t("pageTools.issue.pattern"),
            SmartIssue::OutputDir => t("pageTools.issue.outputDir"),
            SmartIssue::Template => t("pageTools.issue.nameTemplate"),
            SmartIssue::UnknownVariables(vars) => t_with(
                "split.unknownVars",
                &[(
                    "vars",
                    &vars
                        .iter()
                        .map(|v| format!("{{{v}}}"))
                        .collect::<Vec<_>>()
                        .join(", "),
                )],
            ),
        }
    }
}

/// Cấp bookmark 1 đến 10 (theo thông báo của hộp thoại).
pub fn parse_level(text: &str) -> Option<usize> {
    let level: usize = text.trim().parse().ok()?;
    (1..=10).contains(&level).then_some(level)
}

pub fn validate(input: &SmartInput) -> Result<(), SmartIssue> {
    if input.source.trim().is_empty() {
        return Err(SmartIssue::Source);
    }
    if input.output_dir.trim().is_empty() {
        return Err(SmartIssue::OutputDir);
    }
    if input.template.trim().is_empty() {
        return Err(SmartIssue::Template);
    }
    let unknown = unknown_variables(&input.template);
    if !unknown.is_empty() {
        return Err(SmartIssue::UnknownVariables(unknown));
    }
    match input.mode {
        SmartMode::BookmarkLevel if parse_level(&input.level).is_none() => Err(SmartIssue::Level),
        SmartMode::Pattern if input.pattern.trim().is_empty() => Err(SmartIssue::Pattern),
        _ => Ok(()),
    }
}

/// Tham số `file.splitSmart`; mỗi cách chỉ gửi trường của nó.
pub fn build_params(input: &SmartInput) -> Result<Value, SmartIssue> {
    validate(input)?;
    let mut params = json!({
        "path": input.source.trim(),
        "mode": input.mode.wire(),
        "outputDir": input.output_dir.trim(),
        "nameTemplate": input.template.trim(),
    });
    match input.mode {
        SmartMode::Blank => {
            params["dropSeparatorPages"] = json!(input.drop_separators);
            params["blankSensitivity"] = json!(sensitivity(input.sensitivity_percent));
        }
        SmartMode::BookmarkLevel => {
            params["level"] = json!(parse_level(&input.level).ok_or(SmartIssue::Level)?);
        }
        SmartMode::Pattern => {
            params["pattern"] = json!(input.pattern);
            params["ignoreCase"] = json!(input.ignore_case);
        }
    }
    Ok(params)
}

/// 0 đến 100 % thành 0 đến 1, làm tròn 3 chữ số.
pub fn sensitivity(percent: f32) -> f64 {
    (f64::from(percent.clamp(0.0, 100.0)) / 100.0 * 1000.0).round() / 1000.0
}

/// Tham số `page.findBlank` giống hệt cách lõi dò khi tách theo trang trắng.
pub fn find_blank_params(percent: f32) -> Value {
    json!({
        "sensitivity": sensitivity(percent),
        "borderMm": 5.0,
        "keepIfAnnotations": true,
    })
}

/// Các nhóm trang khi tách tại trang trắng (từ 1), giống `_parts_at_blanks` của lõi: trang trắng kết thúc
/// nhóm hiện tại; `drop_separators` thì trang trắng không nằm trong nhóm nào.
pub fn blank_groups(rows: &[BlankRow], drop_separators: bool) -> Vec<PageGroup> {
    let mut sorted: Vec<&BlankRow> = rows.iter().collect();
    sorted.sort_by_key(|r| r.index);
    let mut groups = Vec::new();
    let mut current: Vec<usize> = Vec::new();
    let flush = |current: &mut Vec<usize>, groups: &mut Vec<PageGroup>| {
        if let (Some(first), Some(last)) = (current.first(), current.last()) {
            groups.push(PageGroup {
                start: first + 1,
                end: last + 1,
            });
        }
        current.clear();
    };
    for row in sorted {
        if row.blank {
            if !drop_separators {
                current.push(row.index);
            }
            flush(&mut current, &mut groups);
        } else {
            current.push(row.index);
        }
    }
    flush(&mut current, &mut groups);
    groups
}

/// Các nhóm trang khi tách theo bookmark (`starts` từ 1): trang 1 luôn bắt đầu một nhóm.
pub fn bookmark_groups(starts: &[usize], page_count: usize) -> Vec<PageGroup> {
    let mut points: Vec<usize> = starts
        .iter()
        .copied()
        .filter(|p| *p >= 1 && *p <= page_count)
        .collect();
    points.sort_unstable();
    points.dedup();
    if points.is_empty() {
        return Vec::new();
    }
    if points[0] != 1 {
        points.insert(0, 1);
    }
    points
        .iter()
        .enumerate()
        .map(|(i, start)| PageGroup {
            start: *start,
            end: points.get(i + 1).copied().unwrap_or(page_count + 1) - 1,
        })
        .collect()
}

/// Tên file mẫu để người dùng hình dung ("bao-cao_1.pdf").
pub fn sample_name(template: &str, source: &str) -> String {
    preview_names(
        template,
        &file_stem(source),
        &[PageGroup { start: 1, end: 1 }],
        1,
    )
    .into_iter()
    .next()
    .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Giao diện
// ---------------------------------------------------------------------------

pub struct SmartSplitDialog {
    ctx: ProcessContext,
    source: String,
    mode: SmartMode,
    ignore_case: bool,
    drop_separators: bool,
    sensitivity: f32,
    level: Entity<TextInput>,
    pattern: Entity<TextInput>,
    output_dir: Entity<TextInput>,
    template: Entity<TextInput>,
    mode_focus: Vec<FocusHandle>,
    source_focus: FocusHandle,
    browse_focus: FocusHandle,
    ignore_focus: FocusHandle,
    drop_focus: FocusHandle,
    slider_focus: FocusHandle,
    preview_focus: FocusHandle,
    reveal_focus: FocusHandle,
    return_to: FocusHandle,
    /// Nhóm trang xem trước của trang trắng (đã dò); `None` khi chưa dò.
    blank_rows: Option<Vec<BlankRow>>,
    preview: Runner,
    runner: Runner,
    outputs: Vec<String>,
    _subs: Vec<Subscription>,
}

impl EventEmitter<ProcessEvent> for SmartSplitDialog {}

impl ProcessView for SmartSplitDialog {
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

impl SmartSplitDialog {
    pub fn new(ctx: ProcessContext, return_to: FocusHandle, cx: &mut Context<Self>) -> Self {
        let mut subs = Vec::new();
        let source = ctx
            .source
            .as_ref()
            .map(|p| p.display().to_string())
            .unwrap_or_default();
        let dir =
            crate::split::default_output_dir(ctx.initial_dir.as_deref(), ctx.source.as_deref());
        let level = text_entity(cx, &mut subs, "1", "");
        let pattern = text_entity(cx, &mut subs, "", t("pageTools.smart.patternHint"));
        let output_dir = text_entity(cx, &mut subs, &dir, t("pageTools.smart.noOutputDir"));
        let template = text_entity(cx, &mut subs, DEFAULT_NAME_TEMPLATE, "");
        Self {
            source,
            mode: SmartMode::Blank,
            ignore_case: true,
            drop_separators: false,
            sensitivity: 50.0,
            level,
            pattern,
            output_dir,
            template,
            mode_focus: focus_handles(cx, SmartMode::ALL.len()),
            source_focus: cx.focus_handle(),
            browse_focus: cx.focus_handle(),
            ignore_focus: cx.focus_handle(),
            drop_focus: cx.focus_handle(),
            slider_focus: cx.focus_handle(),
            preview_focus: cx.focus_handle(),
            reveal_focus: cx.focus_handle(),
            return_to,
            blank_rows: None,
            preview: Runner::default(),
            runner: Runner::default(),
            outputs: Vec::new(),
            ctx,
            _subs: subs,
        }
    }

    fn input(&self, cx: &App) -> SmartInput {
        SmartInput {
            source: self.source.clone(),
            mode: self.mode,
            level: self.level.read(cx).text().to_string(),
            pattern: self.pattern.read(cx).text().to_string(),
            ignore_case: self.ignore_case,
            drop_separators: self.drop_separators,
            sensitivity_percent: self.sensitivity,
            output_dir: self.output_dir.read(cx).text().to_string(),
            template: self.template.read(cx).text().to_string(),
        }
    }

    /// Đích của `page.findBlank` cho `self.source`: phiên đang mở nếu đó là tài liệu hiện tại và đang có
    /// phiên, nếu không thì phiên tạm từ file trên đĩa.
    fn blank_target(&self) -> Option<Target> {
        let source = PathBuf::from(&self.source);
        if self.ctx.source.as_ref() == Some(&source)
            && self.ctx.session_id.is_some()
            && !self.ctx.dirty
        {
            return Some(self.ctx.target());
        }
        let guard = crate::source_guard::fingerprint(&source).ok()?;
        Some(Target::Source {
            path: source,
            guard,
            password: None,
        })
    }

    fn detect_blank(&mut self, cx: &mut Context<Self>) {
        let Some(target) = self.blank_target() else {
            self.runner.result = Some(TaskResult::error(SmartIssue::Source.message()));
            cx.notify();
            return;
        };
        let params = find_blank_params(self.sensitivity);
        self.blank_rows = None;
        let ctx = self.ctx.clone();
        spawn_jobs(
            self,
            cx,
            |me| &mut me.preview,
            &ctx,
            "page.findBlank",
            vec![(target, params)],
            |me, outcome, cx| {
                match outcome {
                    Ok(mut all) => {
                        let data = all.pop().map(|ok| ok.data).unwrap_or(Value::Null);
                        me.blank_rows = Some(parse_find_result(&data));
                    }
                    Err(JobFail::Cancelled) => {}
                    Err(JobFail::Failed(message)) => {
                        me.runner.result =
                            Some(TaskResult::error(t("pageTools.smart.running")).detail(message));
                    }
                }
                cx.notify();
            },
        );
        cx.notify();
    }

    fn pick_source(&mut self, cx: &mut Context<Self>) {
        if let Some(path) = crate::dialogs::open_pdfs(self.ctx.initial_dir.as_deref())
            .into_iter()
            .next()
        {
            self.source = path.display().to_string();
            self.blank_rows = None;
            cx.notify();
        }
    }

    fn browse_output(&mut self, cx: &mut Context<Self>) {
        let current = self.output_dir.read(cx).text().to_string();
        let start = Some(PathBuf::from(&current)).filter(|p| p.is_dir());
        let suggested = format!("{}.pdf", file_stem(&self.source));
        if let Some(path) = crate::dialogs::save_pdf(start.as_deref(), &suggested)
            && let Some(dir) = path.parent()
        {
            let text = dir.display().to_string();
            self.output_dir.update(cx, |i, cx| i.set_text(&text, cx));
        }
    }

    /// Nhóm trang xem trước, nếu cách tách hiện tại xem trước được và đã có dữ liệu.
    fn groups(&self, input: &SmartInput) -> Option<Vec<PageGroup>> {
        match input.mode {
            SmartMode::Blank => self
                .blank_rows
                .as_ref()
                .map(|rows| blank_groups(rows, input.drop_separators)),
            SmartMode::BookmarkLevel => {
                // Chỉ biết bookmark của tài liệu đang mở.
                if self
                    .ctx
                    .source
                    .as_ref()
                    .map(|p| p.display().to_string())
                    .as_deref()
                    != Some(self.source.as_str())
                {
                    return None;
                }
                let level = parse_level(&input.level)?;
                let starts = self.ctx.bookmark_starts(level)?;
                Some(bookmark_groups(&starts, self.ctx.page_count))
            }
            SmartMode::Pattern => None,
        }
    }

    fn run(&mut self, cx: &mut Context<Self>) {
        if self.runner.running {
            return;
        }
        let params = match build_params(&self.input(cx)) {
            Ok(params) => params,
            Err(issue) => {
                self.runner.result = Some(TaskResult::error(issue.message()));
                cx.notify();
                return;
            }
        };
        self.outputs.clear();
        let ctx = self.ctx.clone();
        spawn_jobs(
            self,
            cx,
            |me| &mut me.runner,
            &ctx,
            "file.splitSmart",
            vec![(Target::None, params)],
            |me, outcome, cx| {
                me.runner.result = Some(match outcome {
                    Ok(mut all) => {
                        let ok = all
                            .pop()
                            .unwrap_or_else(|| crate::process::JobOk::from_result(&Value::Null));
                        me.outputs = ok.outputs.clone();
                        TaskResult::success(t_with(
                            "pageTools.smart.result",
                            &[("count", &ok.outputs.len().to_string())],
                        ))
                        .items(
                            ok.warnings.into_iter().chain(
                                ok.outputs
                                    .iter()
                                    .take(12)
                                    .map(|o| display_basename(o).to_string()),
                            ),
                        )
                    }
                    Err(JobFail::Cancelled) => TaskResult::cancelled(t("jobs.status.cancelled")),
                    Err(JobFail::Failed(message)) => {
                        TaskResult::error(t("pageTools.smart.title")).detail(message)
                    }
                });
                cx.notify();
            },
        );
        cx.notify();
    }
}

impl Render for SmartSplitDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let dark = self.ctx.dark;
        let colors = Colors::of(dark);
        let entity = cx.entity();
        let input = self.input(cx);
        let running = self.runner.running;
        let issue = validate(&input).err();
        let label = |text: String| {
            div()
                .text_size(px(chef_theme::shared::TEXT_MD))
                .text_color(rgba(colors.text))
                .child(text)
        };
        let hint = |text: String| {
            div()
                .text_size(px(chef_theme::shared::TEXT_SM))
                .text_color(rgba(colors.muted))
                .child(text)
        };

        // File nguồn.
        let pick_e = entity.clone();
        let source_row = div()
            .flex()
            .items_center()
            .justify_between()
            .gap(px(8.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .min_w(px(0.))
                    .child(label(t("pageTools.smart.source")))
                    .child(
                        div()
                            .truncate()
                            .text_size(px(chef_theme::shared::TEXT_SM))
                            .text_color(rgba(colors.muted))
                            .child(if self.source.is_empty() {
                                t("pageTools.replace.noSource")
                            } else {
                                display_basename(&self.source).to_string()
                            }),
                    ),
            )
            .child(
                Button::new("smart-source", self.source_focus.clone())
                    .icon("icons/folder-open.svg")
                    .label(t("common.browse"))
                    .size(Size::Sm)
                    .dark(dark)
                    .disabled(running)
                    .on_click(move |_, _, cx| {
                        pick_e.update(cx, |me, cx| me.pick_source(cx));
                    }),
            );

        let mode_e = entity.clone();
        let mut main = div()
            .flex()
            .flex_col()
            .gap(px(12.))
            .child(source_row)
            .child(label(t("pageTools.smart.mode.label")));
        main = main.child(radios(
            "smart-mode",
            t("pageTools.smart.mode.label"),
            SmartMode::ALL.iter().map(|m| t(m.i18n_key())).collect(),
            &self.mode_focus,
            SmartMode::ALL
                .iter()
                .position(|m| *m == self.mode)
                .unwrap_or(0),
            (dark, false),
            move |i, _, cx| {
                mode_e.update(cx, |me, cx| {
                    me.mode = SmartMode::ALL.get(i).copied().unwrap_or(SmartMode::Blank);
                    cx.notify();
                });
            },
        ));
        match self.mode {
            SmartMode::Blank => {
                let (slider_e, drop_e, prev_e) = (entity.clone(), entity.clone(), entity.clone());
                main = main
                    .child(label(format!(
                        "{}: {}%",
                        t("pageTools.smart.sensitivity"),
                        self.sensitivity.round()
                    )))
                    .child(
                        Slider::new(
                            "smart-sensitivity",
                            t("pageTools.smart.sensitivity"),
                            self.slider_focus.clone(),
                            self.sensitivity,
                        )
                        .range(0.0, 100.0, 5.0)
                        .width(280.0)
                        .dark(dark)
                        .on_change(move |value, _, cx| {
                            slider_e.update(cx, |me, cx| {
                                me.sensitivity = value;
                                me.blank_rows = None;
                                cx.notify();
                            });
                        }),
                    )
                    .child(hint(t("pageTools.smart.sensitivityHint")))
                    .child(
                        Checkbox::new(
                            "smart-drop",
                            self.drop_focus.clone(),
                            t("pageTools.smart.dropSeparators"),
                            if self.drop_separators {
                                CheckState::Checked
                            } else {
                                CheckState::Unchecked
                            },
                        )
                        .dark(dark)
                        .on_change(move |next, _, cx| {
                            let on = *next == CheckState::Checked;
                            drop_e.update(cx, |me, cx| {
                                me.drop_separators = on;
                                cx.notify();
                            });
                        }),
                    )
                    .child(hint(t("pageTools.smart.dropSeparatorsHint")))
                    .child(
                        Button::new("smart-preview", self.preview_focus.clone())
                            .label(t("task.preview"))
                            .size(Size::Sm)
                            .dark(dark)
                            .loading(self.preview.running)
                            .disabled(self.source.is_empty())
                            .on_click(move |_, _, cx| {
                                prev_e.update(cx, |me, cx| me.detect_blank(cx));
                            }),
                    );
            }
            SmartMode::BookmarkLevel => {
                main = main
                    .child(
                        TextField::new(
                            "smart-level",
                            t("pageTools.smart.level"),
                            self.level.clone(),
                        )
                        .dark(dark),
                    )
                    .child(hint(t("pageTools.smart.levelHint")));
            }
            SmartMode::Pattern => {
                let ignore_e = entity.clone();
                main = main
                    .child(
                        TextField::new(
                            "smart-pattern",
                            t("pageTools.smart.pattern"),
                            self.pattern.clone(),
                        )
                        .dark(dark),
                    )
                    .child(
                        Checkbox::new(
                            "smart-ignore-case",
                            self.ignore_focus.clone(),
                            t("pageTools.smart.ignoreCase"),
                            if self.ignore_case {
                                CheckState::Checked
                            } else {
                                CheckState::Unchecked
                            },
                        )
                        .dark(dark)
                        .on_change(move |next, _, cx| {
                            let on = *next == CheckState::Checked;
                            ignore_e.update(cx, |me, cx| {
                                me.ignore_case = on;
                                cx.notify();
                            });
                        }),
                    );
            }
        }
        let browse_e = entity.clone();
        main = main
            .child(
                div()
                    .flex()
                    .items_end()
                    .gap(px(8.))
                    .child(
                        div().flex_1().child(
                            TextField::new(
                                "smart-dir",
                                t("pageTools.smart.outputDir"),
                                self.output_dir.clone(),
                            )
                            .dark(dark),
                        ),
                    )
                    .child(
                        Button::new("smart-browse", self.browse_focus.clone())
                            .icon("icons/folder-open.svg")
                            .label(t("common.browse"))
                            .dark(dark)
                            .disabled(running)
                            .on_click(move |_, _, cx| {
                                browse_e.update(cx, |me, cx| me.browse_output(cx));
                            }),
                    ),
            )
            .child(
                TextField::new(
                    "smart-template",
                    t("pageTools.smart.nameTemplate"),
                    self.template.clone(),
                )
                .dark(dark),
            )
            .child(hint(t_with(
                "pageTools.smart.nameHint",
                &[("sample", &sample_name(&input.template, &self.source))],
            )))
            .child(hint(
                TEMPLATE_VARIABLES
                    .iter()
                    .map(|v| format!("{{{v}}}"))
                    .collect::<Vec<_>>()
                    .join("  "),
            ));
        if let Some(issue) = &issue
            && !matches!(issue, SmartIssue::Source)
        {
            main = main.child(
                div()
                    .text_size(px(chef_theme::shared::TEXT_SM))
                    .text_color(rgba(colors.danger))
                    .child(issue.message()),
            );
        }
        if let Some(first) = self.outputs.first().cloned() {
            main = main.child(
                Button::new("smart-reveal", self.reveal_focus.clone())
                    .icon("icons/folder-open.svg")
                    .label(t("pageTools.smart.openFolder"))
                    .dark(dark)
                    .on_click(move |_, _, _| crate::process::reveal_in_folder(&first)),
            );
        }

        // Xem trước các điểm tách.
        let groups = self.groups(&input);
        let preview = match &groups {
            Some(groups) if !groups.is_empty() => {
                let names = preview_names(
                    &input.template,
                    &file_stem(&self.source),
                    groups,
                    PREVIEW_ROWS,
                );
                let mut list = div().flex().flex_col().gap(px(6.));
                for (name, group) in names.iter().zip(groups) {
                    list = list.child(
                        div()
                            .flex()
                            .justify_between()
                            .gap(px(8.))
                            .text_size(px(chef_theme::shared::TEXT_SM))
                            .child(
                                div()
                                    .truncate()
                                    .text_color(rgba(colors.text))
                                    .child(name.clone()),
                            )
                            .child(
                                div()
                                    .text_color(rgba(colors.muted))
                                    .child(crate::split::group_label(group)),
                            ),
                    );
                }
                if groups.len() > names.len() {
                    list = list.child(hint(t_with(
                        "split.andMore",
                        &[("count", &(groups.len() - names.len()).to_string())],
                    )));
                }
                list
            }
            Some(_) => div().child(hint(t("pageTools.smart.noSplitPoints"))),
            None => div().child(hint(t("split.previewUnavailable"))),
        };
        let estimate = groups.as_ref().map_or_else(
            || "–".to_string(),
            |g| t_with("split.fileCount", &[("count", &g.len().to_string())]),
        );
        let mut warnings = Vec::new();
        if self.ctx.dirty
            && self
                .ctx
                .source
                .as_ref()
                .map(|p| p.display().to_string())
                .as_deref()
                == Some(self.source.as_str())
        {
            warnings.push(t_with(
                "merge.unsavedWarning",
                &[("name", &self.ctx.file_name)],
            ));
        }
        let mut order = self.mode_focus.clone();
        order.extend([self.source_focus.clone(), self.browse_focus.clone()]);
        order.push(self.output_dir.read(cx).focus_handle(cx));
        order.push(self.template.read(cx).focus_handle(cx));
        let _ = parent_dir;
        let _ = parse_decimal;
        let dialog = TaskDialog::new("smart-split-dialog", t("pageTools.smart.title"), dark)
            .icon("icons/scissors.svg")
            .description(t("pageTools.smart.description"))
            .size(Width::Xl)
            .return_focus(self.return_to.clone())
            .child(main)
            .preview(preview)
            .estimate(div().child(estimate))
            .warnings(warnings)
            .run_label(t("pageTools.smart.run"))
            .can_run(issue.is_none() && !running)
            .tab_order(order);
        wire(dialog, &entity, cx, Self::run)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(mode: SmartMode) -> SmartInput {
        SmartInput {
            source: r"C:\docs\bao-cao.pdf".into(),
            mode,
            level: "2".into(),
            pattern: "Chương [0-9]+".into(),
            ignore_case: false,
            drop_separators: true,
            sensitivity_percent: 60.0,
            output_dir: r"C:\out".into(),
            template: "{name}_{index}".into(),
        }
    }

    fn row(index: usize, blank: bool) -> BlankRow {
        BlankRow {
            index,
            ink_ratio: 0.0,
            has_text: !blank,
            has_annotations: false,
            blank,
        }
    }

    #[test]
    fn builds_only_the_fields_of_each_mode() {
        let blank = build_params(&input(SmartMode::Blank)).unwrap();
        assert_eq!(
            blank,
            json!({"path":"C:\\docs\\bao-cao.pdf","mode":"blank","outputDir":"C:\\out",
                   "nameTemplate":"{name}_{index}","dropSeparatorPages":true,"blankSensitivity":0.6})
        );
        let level = build_params(&input(SmartMode::BookmarkLevel)).unwrap();
        assert_eq!(level["level"], 2);
        assert!(level.get("pattern").is_none());
        let pattern = build_params(&input(SmartMode::Pattern)).unwrap();
        assert_eq!(pattern["pattern"], "Chương [0-9]+");
        assert_eq!(pattern["ignoreCase"], false);
        assert!(pattern.get("level").is_none());
    }

    #[test]
    fn blocks_missing_or_invalid_fields() {
        let mut bad = input(SmartMode::Pattern);
        bad.pattern = "  ".into();
        assert_eq!(validate(&bad), Err(SmartIssue::Pattern));
        let mut bad = input(SmartMode::BookmarkLevel);
        bad.level = "0".into();
        assert_eq!(validate(&bad), Err(SmartIssue::Level));
        bad.level = "11".into();
        assert_eq!(validate(&bad), Err(SmartIssue::Level));
        let mut bad = input(SmartMode::Blank);
        bad.source = String::new();
        assert_eq!(validate(&bad), Err(SmartIssue::Source));
        bad.source = "a.pdf".into();
        bad.output_dir = " ".into();
        assert_eq!(validate(&bad), Err(SmartIssue::OutputDir));
        bad.output_dir = "o".into();
        bad.template = " ".into();
        assert_eq!(validate(&bad), Err(SmartIssue::Template));
        bad.template = "{x}".into();
        assert_eq!(
            validate(&bad),
            Err(SmartIssue::UnknownVariables(vec!["x".into()]))
        );
    }

    #[test]
    fn blank_groups_match_the_core_algorithm() {
        // Trang 1-2 có chữ, 3 trắng, 4 có chữ, 5 trắng, 6 trắng, 7 có chữ (đánh số từ 0).
        let rows: Vec<BlankRow> = [false, false, true, false, true, true, false]
            .iter()
            .enumerate()
            .map(|(i, b)| row(i, *b))
            .collect();
        let keep = blank_groups(&rows, false);
        // Trang trắng nằm cuối nhóm trước nó.
        assert_eq!(
            keep,
            vec![
                PageGroup { start: 1, end: 3 },
                PageGroup { start: 4, end: 5 },
                PageGroup { start: 6, end: 6 },
                PageGroup { start: 7, end: 7 }
            ]
        );
        let dropped = blank_groups(&rows, true);
        assert_eq!(
            dropped,
            vec![
                PageGroup { start: 1, end: 2 },
                PageGroup { start: 4, end: 4 },
                PageGroup { start: 7, end: 7 }
            ]
        );
        assert!(blank_groups(&[], false).is_empty());
    }

    #[test]
    fn bookmark_groups_always_start_at_page_one() {
        assert_eq!(
            bookmark_groups(&[4, 8, 4], 10),
            vec![
                PageGroup { start: 1, end: 3 },
                PageGroup { start: 4, end: 7 },
                PageGroup { start: 8, end: 10 }
            ]
        );
        assert!(bookmark_groups(&[], 10).is_empty());
        assert!(bookmark_groups(&[99], 10).is_empty());
    }

    #[test]
    fn sensitivity_and_sample_name() {
        assert_eq!(sensitivity(50.0), 0.5);
        assert_eq!(sensitivity(150.0), 1.0);
        assert_eq!(sensitivity(-5.0), 0.0);
        assert_eq!(
            find_blank_params(30.0),
            json!({"sensitivity":0.3,"borderMm":5.0,"keepIfAnnotations":true})
        );
        assert_eq!(
            sample_name("{name}_{index}", r"C:\d\bao-cao.pdf"),
            "bao-cao_1.pdf"
        );
    }
}
