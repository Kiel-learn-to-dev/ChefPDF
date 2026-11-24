//! Hộp thoại Tách file (TASKS_RUST R5.04, FEATURES C5): tách theo khoảng trang, mỗi N trang, bookmark
//! cấp 1, dung lượng tối đa, hoặc trang lẻ / chẵn. Chạy operation `file.split` trên phiên của tài liệu
//! (hoặc phiên tạm mở từ file gốc), ghi các file vào thư mục chọn và không đổi file gốc.
//! Bản GPUI của `apps/ui/src/features/split/SplitDialog.tsx`.

use std::path::{Path, PathBuf};

use chef_ui::button::{Button, Size, Variant};
use chef_ui::choice::{RadioGroup, RadioItem};
use chef_ui::dialog::Width;
use chef_ui::form::TextField;
use chef_ui::i18n::{t, t_with};
use chef_ui::task_dialog::{
    ApplyTo, TaskAdvanced, TaskApplyTo, TaskDialog, TaskPreset, TaskResult, display_basename,
};
use chef_ui::text_input::TextInput;
use gpui::{
    App, Context, Entity, EventEmitter, FocusHandle, Focusable, IntoElement, Render, Subscription,
    Window, div, prelude::*, px, rgba,
};
use serde_json::{Value, json};

use crate::page_range::{
    DEFAULT_NAME_TEMPLATE, PageGroup, SplitMode, TEMPLATE_VARIABLES, parse_page_ranges, plan_split,
    preview_names, unknown_variables,
};
use crate::process::{
    Colors, JobFail, JobOk, ProcessContext, ProcessEvent, ProcessView, Runner, Target, file_stem,
    parent_dir, spawn_jobs, text_entity, wire,
};

/// Số tên file hiện trong cột xem trước.
const PREVIEW_ROWS: usize = 6;

// ---------------------------------------------------------------------------
// Phần thuần
// ---------------------------------------------------------------------------

/// Giá trị người dùng nhập, ở dạng chữ như trên form.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SplitInput {
    pub mode: SplitMode,
    pub ranges: String,
    pub n: String,
    pub max_mb: String,
    pub output_dir: String,
    pub template: String,
}

/// Lý do chưa chạy được.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SplitIssue {
    OutputDirEmpty,
    RangesInvalid,
    EveryNInvalid,
    MaxSizeInvalid,
    NoBookmarks,
    UnknownVariables(Vec<String>),
}

impl SplitIssue {
    pub fn message(&self, page_count: usize) -> String {
        match self {
            SplitIssue::OutputDirEmpty => t("pageTools.issue.outputDir"),
            SplitIssue::RangesInvalid => {
                t_with("split.rangesInvalid", &[("count", &page_count.to_string())])
            }
            SplitIssue::EveryNInvalid => {
                t("schemaForm.error.notInteger").replace("{{field}}", &t("split.everyN"))
            }
            SplitIssue::MaxSizeInvalid => {
                t("schemaForm.error.notNumber").replace("{{field}}", &t("split.maxSize"))
            }
            SplitIssue::NoBookmarks => t("split.noBookmarks"),
            SplitIssue::UnknownVariables(vars) => t_with(
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

/// Số trang mỗi file: số nguyên ≥ 1.
pub fn parse_every_n(text: &str) -> Option<usize> {
    let n: usize = text.trim().parse().ok()?;
    (n >= 1).then_some(n)
}

/// "5" hoặc "0,5" MB thành byte (làm tròn). Dấu phẩy được coi là dấu thập phân (nhập kiểu `vi`).
pub fn parse_max_bytes(text: &str) -> Option<u64> {
    let mb: f64 = text.trim().replace(',', ".").parse().ok()?;
    if !mb.is_finite() || mb < 0.1 {
        return None;
    }
    Some((mb * 1024.0 * 1024.0).round() as u64)
}

/// Kiểm tra đầu vào. `bookmark_starts` là `None` khi chưa đọc được bookmark.
pub fn validate(
    input: &SplitInput,
    page_count: usize,
    bookmark_starts: Option<&[usize]>,
) -> Result<(), SplitIssue> {
    if input.output_dir.trim().is_empty() {
        return Err(SplitIssue::OutputDirEmpty);
    }
    let unknown = unknown_variables(&input.template);
    if !unknown.is_empty() {
        return Err(SplitIssue::UnknownVariables(unknown));
    }
    match input.mode {
        SplitMode::Ranges if parse_page_ranges(&input.ranges, page_count).is_err() => {
            Err(SplitIssue::RangesInvalid)
        }
        SplitMode::EveryN if parse_every_n(&input.n).is_none() => Err(SplitIssue::EveryNInvalid),
        SplitMode::MaxSize if parse_max_bytes(&input.max_mb).is_none() => {
            Err(SplitIssue::MaxSizeInvalid)
        }
        SplitMode::Bookmarks if bookmark_starts.is_some_and(<[usize]>::is_empty) => {
            Err(SplitIssue::NoBookmarks)
        }
        _ => Ok(()),
    }
}

/// Tham số `file.split`. Mỗi cách tách chỉ gửi trường của nó, như lõi yêu cầu.
pub fn build_params(
    input: &SplitInput,
    page_count: usize,
    bookmark_starts: Option<&[usize]>,
) -> Result<Value, SplitIssue> {
    validate(input, page_count, bookmark_starts)?;
    let template = if input.template.trim().is_empty() {
        DEFAULT_NAME_TEMPLATE
    } else {
        input.template.trim()
    };
    let mut params = json!({
        "mode": input.mode.wire(),
        "outputDir": input.output_dir.trim(),
        "nameTemplate": template,
    });
    match input.mode {
        SplitMode::Ranges => params["ranges"] = json!(input.ranges.trim()),
        SplitMode::EveryN => {
            params["n"] = json!(parse_every_n(&input.n).ok_or(SplitIssue::EveryNInvalid)?)
        }
        SplitMode::MaxSize => {
            params["maxBytes"] =
                json!(parse_max_bytes(&input.max_mb).ok_or(SplitIssue::MaxSizeInvalid)?)
        }
        SplitMode::Bookmarks | SplitMode::OddEven => {}
    }
    Ok(params)
}

/// Mẫu thiết lập (thứ tự khớp danh sách chọn).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Preset {
    Custom,
    Single,
    Halves,
    OddEven,
    Bookmarks,
}

impl Preset {
    pub const ALL: [Preset; 5] = [
        Preset::Custom,
        Preset::Single,
        Preset::Halves,
        Preset::OddEven,
        Preset::Bookmarks,
    ];

    pub fn i18n_key(self) -> &'static str {
        match self {
            Preset::Custom => "split.preset.custom",
            Preset::Single => "split.preset.single",
            Preset::Halves => "split.preset.halves",
            Preset::OddEven => "split.preset.oddEven",
            Preset::Bookmarks => "split.preset.bookmarks",
        }
    }
}

/// "1-5,6-10": chia đôi tài liệu; một trang thì "1".
pub fn halves_ranges(page_count: usize) -> String {
    if page_count > 1 {
        let half = page_count.div_ceil(2);
        format!("1-{half},{}-{page_count}", half + 1)
    } else {
        "1".to_string()
    }
}

/// Áp một mẫu lên đầu vào. `Custom` không đổi gì.
pub fn apply_preset(input: &mut SplitInput, preset: Preset, page_count: usize) {
    match preset {
        Preset::Custom => {}
        Preset::Single => {
            input.mode = SplitMode::EveryN;
            input.n = "1".into();
        }
        Preset::Halves => {
            input.mode = SplitMode::Ranges;
            input.ranges = halves_ranges(page_count);
        }
        Preset::OddEven => input.mode = SplitMode::OddEven,
        Preset::Bookmarks => input.mode = SplitMode::Bookmarks,
    }
}

/// Thư mục xuất mặc định: thư mục lưu trong cài đặt, nếu không thì thư mục của file gốc.
pub fn default_output_dir(save_dir: Option<&Path>, source: Option<&Path>) -> String {
    if let Some(dir) = save_dir {
        return dir.display().to_string();
    }
    source
        .map(|p| parent_dir(&p.display().to_string()))
        .unwrap_or_default()
}

/// Cảnh báo ở cột bên.
pub fn warnings(
    input: &SplitInput,
    bookmark_starts: Option<&[usize]>,
    dirty: bool,
    this_file: bool,
) -> Vec<String> {
    let mut out = Vec::new();
    let unknown = unknown_variables(&input.template);
    if !unknown.is_empty() {
        out.push(SplitIssue::UnknownVariables(unknown).message(0));
    }
    if input.mode == SplitMode::Bookmarks && bookmark_starts.is_some_and(<[usize]>::is_empty) {
        out.push(t("split.noBookmarks"));
    }
    if dirty && this_file {
        out.push(t("split.usesCurrentRevision"));
    }
    out
}

/// Nhãn nhóm trang: "Trang 3" hoặc "Trang 3–5".
pub fn group_label(group: &PageGroup) -> String {
    if group.start == group.end {
        t_with("split.pageN", &[("page", &group.start.to_string())])
    } else {
        t_with(
            "split.pageRange",
            &[
                ("start", &group.start.to_string()),
                ("end", &group.end.to_string()),
            ],
        )
    }
}

// ---------------------------------------------------------------------------
// Giao diện
// ---------------------------------------------------------------------------

/// Hộp thoại Tách file.
pub struct SplitDialog {
    ctx: ProcessContext,
    mode: SplitMode,
    preset: Preset,
    ranges: Entity<TextInput>,
    n: Entity<TextInput>,
    max_mb: Entity<TextInput>,
    output_dir: Entity<TextInput>,
    template: Entity<TextInput>,
    advanced_open: bool,
    apply_to: ApplyTo,
    extra_files: Vec<String>,
    mode_focus: Vec<FocusHandle>,
    browse_focus: FocusHandle,
    advanced_focus: FocusHandle,
    var_focus: Vec<FocusHandle>,
    reveal_focus: FocusHandle,
    return_to: FocusHandle,
    runner: Runner,
    outputs: Vec<String>,
    _subs: Vec<Subscription>,
}

impl EventEmitter<ProcessEvent> for SplitDialog {}

impl ProcessView for SplitDialog {
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

impl SplitDialog {
    pub fn new(ctx: ProcessContext, return_to: FocusHandle, cx: &mut Context<Self>) -> Self {
        let pages = ctx.page_count;
        let mut subs = Vec::new();
        let mut input = |text: &str, placeholder: String, cx: &mut Context<Self>| {
            text_entity(cx, &mut subs, text, placeholder)
        };
        let ranges = input(&halves_ranges(pages), t("range.hint"), cx);
        let n = input("1", String::new(), cx);
        let max_mb = input("5", String::new(), cx);
        let dir = default_output_dir(ctx.initial_dir.as_deref(), ctx.source.as_deref());
        let output_dir = input(&dir, t("split.outputDirPlaceholder"), cx);
        let template = input(DEFAULT_NAME_TEMPLATE, String::new(), cx);
        Self {
            ctx,
            mode: SplitMode::Ranges,
            preset: Preset::Custom,
            ranges,
            n,
            max_mb,
            output_dir,
            template,
            advanced_open: false,
            apply_to: ApplyTo::ThisFile,
            extra_files: Vec::new(),
            mode_focus: (0..SplitMode::ALL.len())
                .map(|_| cx.focus_handle())
                .collect(),
            browse_focus: cx.focus_handle(),
            advanced_focus: cx.focus_handle(),
            var_focus: (0..TEMPLATE_VARIABLES.len())
                .map(|_| cx.focus_handle())
                .collect(),
            reveal_focus: cx.focus_handle(),
            return_to,
            runner: Runner::default(),
            outputs: Vec::new(),
            _subs: subs,
        }
    }

    fn input(&self, cx: &App) -> SplitInput {
        SplitInput {
            mode: self.mode,
            ranges: self.ranges.read(cx).text().to_string(),
            n: self.n.read(cx).text().to_string(),
            max_mb: self.max_mb.read(cx).text().to_string(),
            output_dir: self.output_dir.read(cx).text().to_string(),
            template: self.template.read(cx).text().to_string(),
        }
    }

    fn starts(&self) -> Option<Vec<usize>> {
        self.ctx.bookmark_starts(1)
    }

    fn set_preset(&mut self, preset: Preset, cx: &mut Context<Self>) {
        self.preset = preset;
        let mut input = self.input(cx);
        apply_preset(&mut input, preset, self.ctx.page_count);
        self.mode = input.mode;
        self.ranges
            .update(cx, |i, cx| i.set_text(&input.ranges, cx));
        self.n.update(cx, |i, cx| i.set_text(&input.n, cx));
        cx.notify();
    }

    fn set_mode(&mut self, mode: SplitMode, cx: &mut Context<Self>) {
        self.mode = mode;
        self.preset = Preset::Custom;
        cx.notify();
    }

    fn browse_output(&mut self, cx: &mut Context<Self>) {
        let current = self.output_dir.read(cx).text().to_string();
        let start = Some(PathBuf::from(&current)).filter(|p| p.is_dir());
        let suggested = format!("{}.pdf", file_stem(&self.ctx.file_name).trim());
        if let Some(path) = crate::dialogs::save_pdf(start.as_deref(), &suggested)
            && let Some(dir) = path.parent()
        {
            let text = dir.display().to_string();
            self.output_dir.update(cx, |i, cx| i.set_text(&text, cx));
        }
    }

    fn add_template_var(&mut self, name: &str, cx: &mut Context<Self>) {
        let mut text = self.template.read(cx).text().to_string();
        text.push_str(&format!("{{{name}}}"));
        self.template.update(cx, |i, cx| i.set_text(&text, cx));
    }

    fn can_run(&self, cx: &App) -> bool {
        let input = self.input(cx);
        let has_target = match self.apply_to {
            ApplyTo::ThisFile => !matches!(self.ctx.target(), Target::None),
            ApplyTo::MultipleFiles => !self.extra_files.is_empty(),
        };
        has_target
            && !self.runner.running
            && validate(&input, self.ctx.page_count, self.starts().as_deref()).is_ok()
    }

    fn run(&mut self, cx: &mut Context<Self>) {
        if self.runner.running {
            return;
        }
        let input = self.input(cx);
        // Khoảng trang chỉ kiểm theo số trang của file đang mở; file khác do lõi kiểm.
        let page_count = match self.apply_to {
            ApplyTo::ThisFile => self.ctx.page_count,
            ApplyTo::MultipleFiles => usize::MAX / 2,
        };
        let params = match build_params(&input, page_count, self.starts().as_deref()) {
            Ok(params) => params,
            Err(issue) => {
                self.runner.result = Some(TaskResult::error(issue.message(self.ctx.page_count)));
                cx.notify();
                return;
            }
        };
        let runs: Vec<(Target, Value)> = match self.apply_to {
            ApplyTo::ThisFile => vec![(self.ctx.target(), params)],
            ApplyTo::MultipleFiles => {
                let mut runs = Vec::new();
                for path in &self.extra_files {
                    let path = PathBuf::from(path);
                    let Ok(guard) = crate::source_guard::fingerprint(&path) else {
                        self.runner.result = Some(
                            TaskResult::error(t("split.failed")).detail(t("sourceGuard.missing")),
                        );
                        cx.notify();
                        return;
                    };
                    runs.push((
                        Target::Source {
                            path,
                            guard,
                            password: None,
                        },
                        params.clone(),
                    ));
                }
                runs
            }
        };
        self.outputs.clear();
        let ctx = self.ctx.clone();
        spawn_jobs(
            self,
            cx,
            |me| &mut me.runner,
            &ctx,
            "file.split",
            runs,
            move |me, outcome, cx| {
                me.runner.result = Some(match outcome {
                    Ok(all) => {
                        let warnings: Vec<String> = all
                            .iter()
                            .flat_map(|ok: &JobOk| ok.warnings.clone())
                            .collect();
                        me.outputs = all.into_iter().flat_map(|ok| ok.outputs).collect();
                        TaskResult::success(t("split.doneTitle"))
                            .detail(t_with(
                                "split.doneText",
                                &[("count", &me.outputs.len().to_string())],
                            ))
                            .items(
                                warnings.into_iter().chain(
                                    me.outputs
                                        .iter()
                                        .take(12)
                                        .map(|o| display_basename(o).to_string()),
                                ),
                            )
                    }
                    Err(JobFail::Cancelled) => TaskResult::cancelled(t("jobs.status.cancelled")),
                    Err(JobFail::Failed(message)) => {
                        TaskResult::error(t("split.failed")).detail(message)
                    }
                });
                cx.notify();
            },
        );
        cx.notify();
    }
}

impl Render for SplitDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let dark = self.ctx.dark;
        let colors = Colors::of(dark);
        let entity = cx.entity();
        let input = self.input(cx);
        let running = self.runner.running;
        let issue = validate(&input, self.ctx.page_count, self.starts().as_deref()).err();
        let plan = plan_split(
            input.mode,
            self.ctx.page_count,
            &input.ranges,
            parse_every_n(&input.n).unwrap_or(0),
            &self.starts().unwrap_or_default(),
        );
        let source_name = file_stem(&self.ctx.file_name);

        // Mẫu thiết lập.
        let preset_entity = entity.clone();
        let preset = TaskPreset::new(
            Preset::ALL.iter().map(|p| t(p.i18n_key()).into()).collect(),
            Preset::ALL
                .iter()
                .position(|p| *p == self.preset)
                .unwrap_or(0),
        )
        .on_change(move |index, _, cx| {
            if let Some(preset) = Preset::ALL.get(index).copied() {
                preset_entity.update(cx, |me, cx| me.set_preset(preset, cx));
            }
        });

        // Chọn cách tách.
        let mode_entity = entity.clone();
        let items: Vec<RadioItem> = SplitMode::ALL
            .iter()
            .zip(&self.mode_focus)
            .enumerate()
            .map(|(index, (mode, focus))| {
                let key = match mode {
                    SplitMode::Ranges => "split.mode.ranges",
                    SplitMode::EveryN => "split.mode.everyN",
                    SplitMode::Bookmarks => "split.mode.bookmarks",
                    SplitMode::MaxSize => "split.mode.maxSize",
                    SplitMode::OddEven => "split.mode.oddEven",
                };
                RadioItem::new(("split-mode", index as u32), focus.clone(), t(key))
            })
            .collect();
        let mode_group = RadioGroup::new("split-mode-group", t("split.modeLabel"), items)
            .selected(SplitMode::ALL.iter().position(|m| *m == self.mode))
            .dark(dark)
            .on_change(move |index, _, cx| {
                if let Some(mode) = SplitMode::ALL.get(index).copied() {
                    mode_entity.update(cx, |me, cx| me.set_mode(mode, cx));
                }
            });

        let hint = |text: String| {
            div()
                .text_size(px(chef_theme::shared::TEXT_SM))
                .text_color(rgba(colors.muted))
                .child(text)
        };
        let mut fields = div().flex().flex_col().gap(px(12.)).child(
            div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(
                    div()
                        .text_size(px(chef_theme::shared::TEXT_MD))
                        .text_color(rgba(colors.text))
                        .child(t("split.modeLabel")),
                )
                .child(mode_group),
        );
        match self.mode {
            SplitMode::Ranges => {
                let invalid = issue == Some(SplitIssue::RangesInvalid);
                fields = fields.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .child(
                            TextField::new("split-ranges", t("split.ranges"), self.ranges.clone())
                                .dark(dark),
                        )
                        .child(hint(t("split.rangesHint")))
                        .children(invalid.then(|| {
                            div()
                                .text_size(px(chef_theme::shared::TEXT_SM))
                                .text_color(rgba(colors.danger))
                                .child(SplitIssue::RangesInvalid.message(self.ctx.page_count))
                        })),
                );
            }
            SplitMode::EveryN => {
                fields = fields
                    .child(TextField::new("split-n", t("split.everyN"), self.n.clone()).dark(dark));
            }
            SplitMode::MaxSize => {
                fields = fields.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(4.))
                        .child(
                            TextField::new(
                                "split-max",
                                format!("{} (MB)", t("split.maxSize")),
                                self.max_mb.clone(),
                            )
                            .dark(dark),
                        )
                        .child(hint(t("split.maxSizeHint"))),
                );
            }
            SplitMode::Bookmarks => {
                if let Some(starts) = self.starts() {
                    fields = fields.child(hint(t_with(
                        "split.bookmarkCount",
                        &[("count", &starts.len().to_string())],
                    )));
                }
            }
            SplitMode::OddEven => {}
        }
        let browse_entity = entity.clone();
        fields = fields.child(
            div()
                .flex()
                .items_end()
                .gap(px(8.))
                .child(
                    div().flex_1().child(
                        TextField::new("split-dir", t("split.outputDir"), self.output_dir.clone())
                            .dark(dark),
                    ),
                )
                .child(
                    Button::new("split-browse", self.browse_focus.clone())
                        .icon("icons/folder-open.svg")
                        .label(t("common.browse"))
                        .dark(dark)
                        .disabled(running)
                        .on_click(move |_, _, cx| {
                            browse_entity.update(cx, |me, cx| me.browse_output(cx));
                        }),
                ),
        );

        // Kết quả: nút hiện file trong thư mục.
        if let Some(first) = self.outputs.first().cloned() {
            fields = fields.child(
                Button::new("split-reveal", self.reveal_focus.clone())
                    .icon("icons/folder-open.svg")
                    .label(t("outputs.showInFolder"))
                    .dark(dark)
                    .on_click(move |_, _, _| crate::process::reveal_in_folder(&first)),
            );
        }

        // Mục nâng cao: mẫu tên và biến.
        let adv_toggle = entity.clone();
        let mut vars = div().flex().flex_wrap().gap(px(6.));
        for (index, (name, focus)) in TEMPLATE_VARIABLES.iter().zip(&self.var_focus).enumerate() {
            let var_entity = entity.clone();
            let var = *name;
            vars = vars.child(
                Button::new(("split-var", index as u32), focus.clone())
                    .label(format!("{{{name}}}"))
                    .variant(Variant::Ghost)
                    .size(Size::Sm)
                    .dark(dark)
                    .on_click(move |_, _, cx| {
                        var_entity.update(cx, |me, cx| me.add_template_var(var, cx));
                    }),
            );
        }
        let advanced = TaskAdvanced::new(self.advanced_open)
            .on_toggle(move |_, cx| {
                adv_toggle.update(cx, |me, cx| {
                    me.advanced_open = !me.advanced_open;
                    cx.notify();
                });
            })
            .child(
                TextField::new(
                    "split-template",
                    t("split.nameTemplate"),
                    self.template.clone(),
                )
                .dark(dark),
            )
            .child(vars);

        // Xem trước.
        let preview = match (&plan, self.mode) {
            (_, SplitMode::MaxSize) => div().child(hint(t("split.maxSizePreview"))),
            (Some(groups), _) => {
                let names = preview_names(&input.template, &source_name, groups, PREVIEW_ROWS);
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
                                    .child(group_label(group)),
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
            (None, _) => div().child(hint(t("split.previewUnavailable"))),
        };
        let estimate = plan.as_ref().map_or_else(
            || "–".to_string(),
            |g| t_with("split.fileCount", &[("count", &g.len().to_string())]),
        );

        // Phạm vi áp dụng.
        let (change_e, add_e, remove_e) = (entity.clone(), entity.clone(), entity.clone());
        let apply_to = TaskApplyTo::new(self.apply_to)
            .files(self.extra_files.clone())
            .on_change(move |mode, _, cx| {
                change_e.update(cx, |me, cx| {
                    me.apply_to = mode;
                    cx.notify();
                });
            })
            .on_add_files(move |_, cx| {
                add_e.update(cx, |me, cx| {
                    for path in crate::dialogs::open_pdfs(me.ctx.initial_dir.as_deref()) {
                        let path = path.display().to_string();
                        if !me.extra_files.contains(&path) {
                            me.extra_files.push(path);
                        }
                    }
                    cx.notify();
                });
            })
            .on_remove_file(move |index, _, cx| {
                remove_e.update(cx, |me, cx| {
                    if index < me.extra_files.len() {
                        me.extra_files.remove(index);
                        cx.notify();
                    }
                });
            });

        let mut tab_order: Vec<FocusHandle> = self.mode_focus.clone();
        for field in [&self.ranges, &self.n, &self.max_mb, &self.output_dir] {
            tab_order.push(field.read(cx).focus_handle(cx));
        }
        tab_order.push(self.browse_focus.clone());
        let mut advanced_order = vec![self.template.read(cx).focus_handle(cx)];
        advanced_order.extend(self.var_focus.iter().cloned());
        let _ = &self.advanced_focus;

        let dialog = TaskDialog::new("split-dialog", t("split.title"), dark)
            .icon("icons/split.svg")
            .description(t_with(
                "split.description",
                &[
                    ("name", &self.ctx.file_name),
                    ("count", &self.ctx.page_count.to_string()),
                ],
            ))
            .size(Width::Xl)
            .return_focus(self.return_to.clone())
            .preset(preset)
            .child(fields)
            .advanced(advanced)
            .preview(preview)
            .estimate(div().child(estimate))
            .warnings(warnings(
                &input,
                self.starts().as_deref(),
                self.ctx.dirty,
                self.apply_to == ApplyTo::ThisFile,
            ))
            .apply_to(apply_to)
            .run_label(t("split.run"))
            .can_run(self.can_run(cx))
            .tab_order(tab_order)
            .advanced_tab_order(advanced_order);
        wire(dialog, &entity, cx, Self::run)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(mode: SplitMode) -> SplitInput {
        SplitInput {
            mode,
            ranges: "1-3, 4-10".into(),
            n: "2".into(),
            max_mb: "1,5".into(),
            output_dir: r"C:\out".into(),
            template: "{name}_{index}".into(),
        }
    }

    #[test]
    fn builds_only_the_fields_of_each_mode() {
        let ranges = build_params(&input(SplitMode::Ranges), 10, None).unwrap();
        assert_eq!(
            ranges,
            json!({"mode":"ranges","ranges":"1-3, 4-10","outputDir":"C:\\out","nameTemplate":"{name}_{index}"})
        );
        let every = build_params(&input(SplitMode::EveryN), 10, None).unwrap();
        assert_eq!(every["n"], 2);
        assert!(every.get("ranges").is_none());
        let size = build_params(&input(SplitMode::MaxSize), 10, None).unwrap();
        assert_eq!(size["maxBytes"], (1.5f64 * 1024.0 * 1024.0).round() as u64);
        let odd = build_params(&input(SplitMode::OddEven), 10, None).unwrap();
        assert_eq!(odd["mode"], "oddEven");
        // Không kiểm bằng struct `FileSplitParams` sinh sẵn: typify gộp nhầm enum `mode` của nhiều
        // operation vào một kiểu `Mode`, nên serde từ chối "ranges". Bản kiểm với lõi thật nằm ở
        // core/tests/test_native_op_params.py.
    }

    #[test]
    fn blocks_invalid_input_before_running() {
        let mut bad = input(SplitMode::Ranges);
        bad.ranges = "1-99".into();
        assert_eq!(validate(&bad, 10, None), Err(SplitIssue::RangesInvalid));
        let mut bad = input(SplitMode::EveryN);
        bad.n = "0".into();
        assert_eq!(validate(&bad, 10, None), Err(SplitIssue::EveryNInvalid));
        bad.n = "abc".into();
        assert_eq!(validate(&bad, 10, None), Err(SplitIssue::EveryNInvalid));
        let mut bad = input(SplitMode::MaxSize);
        bad.max_mb = "0.01".into();
        assert_eq!(validate(&bad, 10, None), Err(SplitIssue::MaxSizeInvalid));
        let mut bad = input(SplitMode::Ranges);
        bad.output_dir = "  ".into();
        assert_eq!(validate(&bad, 10, None), Err(SplitIssue::OutputDirEmpty));
        let mut bad = input(SplitMode::Ranges);
        bad.template = "{name}_{oops}".into();
        assert_eq!(
            validate(&bad, 10, None),
            Err(SplitIssue::UnknownVariables(vec!["oops".into()]))
        );
        assert_eq!(
            validate(&input(SplitMode::Bookmarks), 10, Some(&[])),
            Err(SplitIssue::NoBookmarks)
        );
        // Chưa đọc được bookmark thì vẫn cho chạy; lõi báo cảnh báo nếu không có.
        assert!(validate(&input(SplitMode::Bookmarks), 10, None).is_ok());
    }

    #[test]
    fn empty_template_falls_back_to_the_default() {
        let mut blank = input(SplitMode::OddEven);
        blank.template = "   ".into();
        assert_eq!(
            build_params(&blank, 4, None).unwrap()["nameTemplate"],
            DEFAULT_NAME_TEMPLATE
        );
    }

    #[test]
    fn parses_numbers_like_the_dialog_fields() {
        assert_eq!(parse_every_n(" 3 "), Some(3));
        assert_eq!(parse_every_n("1.5"), None);
        assert_eq!(parse_max_bytes("5"), Some(5 * 1024 * 1024));
        assert_eq!(parse_max_bytes("0,5"), Some(512 * 1024));
        assert_eq!(parse_max_bytes("nan"), None);
        assert_eq!(parse_max_bytes("0.09"), None);
    }

    #[test]
    fn presets_set_the_mode_and_values() {
        let mut v = input(SplitMode::Ranges);
        apply_preset(&mut v, Preset::Single, 10);
        assert_eq!((v.mode, v.n.as_str()), (SplitMode::EveryN, "1"));
        apply_preset(&mut v, Preset::Halves, 11);
        assert_eq!((v.mode, v.ranges.as_str()), (SplitMode::Ranges, "1-6,7-11"));
        apply_preset(&mut v, Preset::OddEven, 11);
        assert_eq!(v.mode, SplitMode::OddEven);
        apply_preset(&mut v, Preset::Bookmarks, 11);
        assert_eq!(v.mode, SplitMode::Bookmarks);
        let before = v.clone();
        apply_preset(&mut v, Preset::Custom, 11);
        assert_eq!(v, before);
        assert_eq!(halves_ranges(1), "1");
    }

    #[test]
    fn default_output_dir_prefers_the_saved_folder() {
        assert_eq!(
            default_output_dir(Some(Path::new("/save")), Some(Path::new("/docs/a.pdf"))),
            "/save"
        );
        assert_eq!(
            default_output_dir(None, Some(Path::new("/docs/a.pdf"))),
            "/docs"
        );
        assert_eq!(default_output_dir(None, None), "");
    }

    #[test]
    fn warns_about_unsaved_changes_only_for_this_file() {
        let i = input(SplitMode::Ranges);
        assert_eq!(warnings(&i, None, true, true).len(), 1);
        assert!(warnings(&i, None, true, false).is_empty());
        assert!(warnings(&i, None, false, true).is_empty());
    }
}
