//! PDFium form-fill environment wrapper, JS/XFA isolation, and widget readout (TASKS_RUST R4.21).
//!
//! Security audit (BLUEPRINT_RUST §7.2):
//! `pdfium-render` 0.9.5 allocates `FPDF_FORMFILLINFO` with `m_pJsPlatform = std::ptr::null_mut()`
//! and `None` for all action/JavaScript/UI callbacks inside `PdfForm::from_pdfium`, then calls
//! `FPDFDOC_InitFormFillEnvironment(document_handle, &mut form_fill_info)`. Per PDFium's
//! `fpdf_formfill.h`, setting `m_pJsPlatform = NULL` prevents JavaScript execution even when
//! `pdfium.dll` is compiled with V8 support. We also never call `FPDF_LoadXFA`.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use pdfium_render::prelude::{
    PdfAppearanceMode, PdfDocument, PdfFormField, PdfFormFieldCommon, PdfFormType, PdfPage,
    PdfPageAnnotation, PdfPageAnnotationCommon, PdfPageRenderRotation, PdfRenderConfig,
};

use crate::text::Rect;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FormType {
    None,
    AcroForm,
    XfaFull,
    XfaForeground,
}

impl FormType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::AcroForm => "acroForm",
            Self::XfaFull => "xfaFull",
            Self::XfaForeground => "xfaForeground",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WidgetKind {
    Text,
    Multiline,
    Comb,
    Password,
    Checkbox,
    Radio,
    Dropdown,
    Listbox,
    PushButton,
    Signature,
    Unknown,
}

impl WidgetKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Multiline => "multiline",
            Self::Comb => "comb",
            Self::Password => "password",
            Self::Checkbox => "checkbox",
            Self::Radio => "radio",
            Self::Dropdown => "dropdown",
            Self::Listbox => "listbox",
            Self::PushButton => "button",
            Self::Signature => "signature",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WidgetOption {
    pub label: String,
    pub selected: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FormWidget {
    pub id: String,
    pub page_index: usize,
    pub annot_index: usize,
    pub name: String,
    pub alternate_name: Option<String>,
    pub kind: WidgetKind,
    /// Displayed page frame in PDF points, origin at top-left after `/CropBox` and `/Rotate`.
    pub rect: Rect,
    pub value: Option<String>,
    pub checked: Option<bool>,
    pub control_index: Option<u32>,
    pub options: Vec<WidgetOption>,
    pub read_only: bool,
    pub required: bool,
    pub has_appearance: bool,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PageWidgets {
    pub page_index: usize,
    pub widgets: Vec<FormWidget>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DocFormInfo {
    pub form_type: FormType,
    pub form_env_active: bool,
    pub js_enabled: bool,
    pub xfa_loaded: bool,
}

impl Default for DocFormInfo {
    fn default() -> Self {
        Self {
            form_type: FormType::None,
            form_env_active: false,
            js_enabled: false,
            xfa_loaded: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FormEnvStats {
    pub active_docs: usize,
    pub active_form_envs: usize,
    pub total_form_inits: u64,
    pub total_form_exits: u64,
}

#[derive(Debug, Default)]
pub(crate) struct FormEnvCounters {
    active_docs: AtomicUsize,
    active_form_envs: AtomicUsize,
    total_form_inits: AtomicU64,
    total_form_exits: AtomicU64,
}

impl FormEnvCounters {
    pub fn record_open(&self, has_form_env: bool) {
        self.active_docs.fetch_add(1, Ordering::AcqRel);
        if has_form_env {
            self.active_form_envs.fetch_add(1, Ordering::AcqRel);
            self.total_form_inits.fetch_add(1, Ordering::AcqRel);
        }
    }

    pub fn record_close(&self, has_form_env: bool) {
        self.active_docs.fetch_sub(1, Ordering::AcqRel);
        if has_form_env {
            self.active_form_envs.fetch_sub(1, Ordering::AcqRel);
            self.total_form_exits.fetch_add(1, Ordering::AcqRel);
        }
    }

    pub fn snapshot(&self) -> FormEnvStats {
        FormEnvStats {
            active_docs: self.active_docs.load(Ordering::Acquire),
            active_form_envs: self.active_form_envs.load(Ordering::Acquire),
            total_form_inits: self.total_form_inits.load(Ordering::Acquire),
            total_form_exits: self.total_form_exits.load(Ordering::Acquire),
        }
    }
}

/// Tracks an opened `PdfDocument` and guarantees its `FPDF_FORMHANDLE` is released on close.
pub(crate) struct TrackedDoc<'a> {
    doc: Option<PdfDocument<'a>>,
    has_form_env: bool,
    counters: Arc<FormEnvCounters>,
}

impl<'a> TrackedDoc<'a> {
    pub fn new(doc: PdfDocument<'a>, counters: Arc<FormEnvCounters>) -> Self {
        let has_form_env = doc.form().is_some();
        counters.record_open(has_form_env);
        Self {
            doc: Some(doc),
            has_form_env,
            counters,
        }
    }

    pub fn doc(&self) -> &PdfDocument<'a> {
        self.doc.as_ref().expect("tracked document already closed")
    }

    pub fn has_form_env(&self) -> bool {
        self.has_form_env
    }
}

impl Drop for TrackedDoc<'_> {
    fn drop(&mut self) {
        // PdfDocument::drop clears self.form (calling FPDFDOC_ExitFormFillEnvironment) before
        // calling FPDF_CloseDocument, preventing teardown crashes when PDFium has V8/XFA code.
        drop(self.doc.take());
        self.counters.record_close(self.has_form_env);
    }
}

/// Returns form metadata for an opened document. JavaScript and XFA evaluation remain disabled.
pub fn inspect_document(doc: &PdfDocument<'_>) -> DocFormInfo {
    match doc.form() {
        Some(form) => {
            let form_type = match form.form_type() {
                PdfFormType::None => FormType::None,
                PdfFormType::Acrobat => FormType::AcroForm,
                PdfFormType::XfaFull => FormType::XfaFull,
                PdfFormType::XfaForeground => FormType::XfaForeground,
            };
            DocFormInfo {
                form_type,
                form_env_active: true,
                js_enabled: false,
                xfa_loaded: false,
            }
        }
        None => DocFormInfo::default(),
    }
}

/// Explicitly enables PDFium's annotation and `FPDF_FFLDraw` passes when a form environment is
/// active on the document.
pub fn configure_render(config: PdfRenderConfig, has_form_env: bool) -> PdfRenderConfig {
    config
        .render_annotations(true)
        .render_form_data(has_form_env)
}

/// Treat PDF `/Off` (with or without leading slash) and empty names as unchecked states.
pub fn is_off_state(value: &str) -> bool {
    let trimmed = value.trim().trim_start_matches('/');
    trimmed.is_empty() || trimmed.eq_ignore_ascii_case("off")
}

/// Maps an unrotated user-space rectangle `[left, bottom, right, top]` into the displayed page
/// frame (points, origin at top-left) after applying `crop = [cx0, cy0, cx1, cy1]` and `quarter`
/// clockwise 90° steps matching `/Rotate` and `chef_core::signing::anchors::PageFrame`.
pub fn user_rect_to_display(
    quarter: u8,
    crop: (f32, f32, f32, f32),
    user: (f32, f32, f32, f32),
) -> Rect {
    let cx0 = crop.0.min(crop.2);
    let cy0 = crop.1.min(crop.3);
    let cx1 = crop.0.max(crop.2);
    let cy1 = crop.1.max(crop.3);
    let w = (cx1 - cx0).max(0.0);
    let h = (cy1 - cy0).max(0.0);
    let point = |x: f32, y: f32| {
        let u = x - cx0;
        let v = y - cy0;
        match quarter % 4 {
            1 => (v, u),
            2 => (w - u, v),
            3 => (h - v, w - u),
            _ => (u, h - v),
        }
    };
    let (ax, ay) = point(user.0, user.1);
    let (bx, by) = point(user.2, user.3);
    Rect {
        left: ax.min(bx),
        top: ay.min(by),
        right: ax.max(bx),
        bottom: ay.max(by),
    }
}

/// Reads all visible widget annotations on a single page in displayed coordinates.
pub fn read_page_widgets(page: &PdfPage<'_>, page_index: usize) -> PageWidgets {
    let quarter = match page.rotation() {
        Ok(PdfPageRenderRotation::Degrees90) => 1,
        Ok(PdfPageRenderRotation::Degrees180) => 2,
        Ok(PdfPageRenderRotation::Degrees270) => 3,
        _ => 0,
    };
    let crop = page
        .boundaries()
        .crop()
        .or_else(|_| page.boundaries().media())
        .map(|b| {
            (
                b.bounds.left().value,
                b.bounds.bottom().value,
                b.bounds.right().value,
                b.bounds.top().value,
            )
        })
        .unwrap_or_else(|_| {
            if quarter % 2 == 1 {
                (0.0, 0.0, page.height().value, page.width().value)
            } else {
                (0.0, 0.0, page.width().value, page.height().value)
            }
        });

    let mut widgets = Vec::new();
    for (annot_index, annotation) in page.annotations().iter().enumerate() {
        let PdfPageAnnotation::Widget(widget) = &annotation else {
            continue;
        };
        if annotation.is_hidden() || annotation.is_printable_but_not_viewable() {
            continue;
        }
        let Some(field) = widget.form_field() else {
            continue;
        };
        let Ok(bounds) = annotation.bounds() else {
            continue;
        };
        let rect = user_rect_to_display(
            quarter,
            crop,
            (
                bounds.left().value,
                bounds.bottom().value,
                bounds.right().value,
                bounds.top().value,
            ),
        );
        if rect.right <= rect.left || rect.bottom <= rect.top {
            continue;
        }
        let parsed = extract_field(&annotation, field, page_index, annot_index, rect);
        widgets.push(parsed);
    }
    PageWidgets {
        page_index,
        widgets,
    }
}

fn extract_field(
    annotation: &PdfPageAnnotation<'_>,
    field: &PdfFormField<'_>,
    page_index: usize,
    annot_index: usize,
    rect: Rect,
) -> FormWidget {
    let name = field.name().unwrap_or_default();
    let alternate_name = annotation.contents().filter(|s| !s.is_empty());
    let read_only = field.is_read_only();
    let required = field.is_required();
    let has_appearance = field
        .appearance_mode_value(PdfAppearanceMode::Normal)
        .is_some()
        || field.appearance_stream().is_some();

    let mut value = None;
    let mut checked = None;
    let mut control_index = None;
    let mut options = Vec::new();

    let kind = match field {
        PdfFormField::Text(text) => {
            value = text.value();
            if text.is_password() {
                WidgetKind::Password
            } else if text.is_multiline() {
                WidgetKind::Multiline
            } else if !text.is_scrollable() {
                // pdfium-render 0.9.5 labels PDF bit 25 (1 << 24, Comb) as `TextDoNotScroll`.
                WidgetKind::Comb
            } else {
                WidgetKind::Text
            }
        }
        PdfFormField::Checkbox(cb) => {
            // Override pdfium-render's `== "Yes"` check so arbitrary export names like `/On` work.
            let is_checked = match cb.appearance_stream() {
                Some(as_name) => !is_off_state(&as_name),
                None => cb
                    .group_value()
                    .as_deref()
                    .is_some_and(|v| !is_off_state(v)),
            };
            checked = Some(is_checked);
            value = cb
                .appearance_stream()
                .filter(|s| !is_off_state(s))
                .or_else(|| cb.group_value().filter(|s| !is_off_state(s)));
            control_index = Some(cb.index_in_group());
            WidgetKind::Checkbox
        }
        PdfFormField::RadioButton(rb) => {
            // Avoid pdfium-render's `group_value == appearance_stream` false positive when both
            // are `"Off"` or `None`.
            let group_value = rb.group_value();
            let is_checked = match rb.appearance_stream() {
                Some(as_name) => {
                    !is_off_state(&as_name) && !group_value.as_deref().is_some_and(is_off_state)
                }
                None => false,
            };
            checked = Some(is_checked);
            value = group_value.filter(|s| !is_off_state(s));
            control_index = Some(rb.index_in_group());
            WidgetKind::Radio
        }
        PdfFormField::ComboBox(combo) => {
            value = combo.value();
            options = combo
                .options()
                .iter()
                .map(|opt| WidgetOption {
                    label: opt.label().cloned().unwrap_or_default(),
                    selected: opt.is_set(),
                })
                .collect();
            WidgetKind::Dropdown
        }
        PdfFormField::ListBox(list) => {
            value = list.value();
            options = list
                .options()
                .iter()
                .map(|opt| WidgetOption {
                    label: opt.label().cloned().unwrap_or_default(),
                    selected: opt.is_set(),
                })
                .collect();
            WidgetKind::Listbox
        }
        PdfFormField::PushButton(_) => WidgetKind::PushButton,
        PdfFormField::Signature(_) => WidgetKind::Signature,
        PdfFormField::Unknown(_) => WidgetKind::Unknown,
    };

    FormWidget {
        id: format!("form-widget-p{page_index}-{annot_index}"),
        page_index,
        annot_index,
        name,
        alternate_name,
        kind,
        rect,
        value,
        checked,
        control_index,
        options,
        read_only,
        required,
        has_appearance,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(got: Rect, want: (f32, f32, f32, f32)) {
        assert!(
            (got.left - want.0).abs() < 1e-3
                && (got.top - want.1).abs() < 1e-3
                && (got.right - want.2).abs() < 1e-3
                && (got.bottom - want.3).abs() < 1e-3,
            "got {got:?}, want {want:?}"
        );
    }

    #[test]
    fn user_rect_to_display_handles_all_rotations_and_shifted_cropbox() {
        // Unrotated crop [10, 20, 310, 220] -> width 300, height 200.
        // Box in user space: [30, 140, 130, 180] (u: 20..120, v: 120..160).
        let crop = (10.0, 20.0, 310.0, 220.0);
        let user = (30.0, 140.0, 130.0, 180.0);
        approx(
            user_rect_to_display(0, crop, user),
            (20.0, 40.0, 120.0, 80.0),
        );
        // 90° CW: display width = h (200), display height = w (300); x' = v (120..160), y' = u (20..120).
        approx(
            user_rect_to_display(1, crop, user),
            (120.0, 20.0, 160.0, 120.0),
        );
        // 180° CW: x' = w - u (180..280), y' = v (120..160).
        approx(
            user_rect_to_display(2, crop, user),
            (180.0, 120.0, 280.0, 160.0),
        );
        // 270° CW: x' = h - v (40..80), y' = w - u (180..280).
        approx(
            user_rect_to_display(3, crop, user),
            (40.0, 180.0, 80.0, 280.0),
        );
    }

    #[test]
    fn is_off_state_recognizes_empty_and_off_names() {
        assert!(is_off_state(""));
        assert!(is_off_state("Off"));
        assert!(is_off_state("/Off"));
        assert!(is_off_state("  /off  "));
        assert!(!is_off_state("Yes"));
        assert!(!is_off_state("/nam"));
    }

    #[test]
    fn form_env_counters_track_active_and_cumulative_lifecycles() {
        let counters = FormEnvCounters::default();
        assert_eq!(counters.snapshot(), FormEnvStats::default());
        counters.record_open(false);
        counters.record_open(true);
        counters.record_open(true);
        assert_eq!(
            counters.snapshot(),
            FormEnvStats {
                active_docs: 3,
                active_form_envs: 2,
                total_form_inits: 2,
                total_form_exits: 0,
            }
        );
        counters.record_close(true);
        counters.record_close(false);
        assert_eq!(
            counters.snapshot(),
            FormEnvStats {
                active_docs: 1,
                active_form_envs: 1,
                total_form_inits: 2,
                total_form_exits: 1,
            }
        );
        counters.record_close(true);
        assert_eq!(
            counters.snapshot(),
            FormEnvStats {
                active_docs: 0,
                active_form_envs: 0,
                total_form_inits: 2,
                total_form_exits: 2,
            }
        );
    }
}
