//! Hộp thoại xử lý chung cho các thao tác độc lập, dựng từ schema của lõi (TASKS_RUST R5.02, R5.11,
//! R5.12, R5.13, R5.22, R5.45, R6.29): `SchemaForm` cho các tham số, nút "Chọn…" cho trường đường dẫn,
//! chạy qua `job_runner`. Mỗi thao tác chỉ cần một dòng trong `SPECS`; thêm thao tác mới không cần
//! viết giao diện. Hình họa của từng hộp thoại chưa đối chiếu với bản Electron (R5.09).

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use gpui::{App, Context, Entity, FocusHandle, SharedString, Window, div, prelude::*, px};

use chef_rpc::Supervisor;
use chef_ui::button::{Button, Size, Variant};
use chef_ui::i18n::{t, t_with};
use chef_ui::schema_form::{FormSchema, SchemaForm};
use chef_ui::task_dialog::{TaskDialog, TaskResult};

use crate::job_runner::{self, JobSlot, Outcome};

/// Cách chọn giá trị cho một trường đường dẫn.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Pick {
    /// Chọn một PDF có sẵn.
    OpenPdf,
    /// Chọn nơi lưu một PDF mới.
    SavePdf,
    /// Chọn một ảnh và thêm vào danh sách của trường `FileList`.
    AddImage,
}

pub struct OpSpec {
    /// Khóa dùng cho action và id phần tử, ví dụ "repair".
    pub key: &'static str,
    pub op_id: &'static str,
    /// Tên definition trong `ops.schema.json`.
    pub def: &'static str,
    pub title_key: &'static str,
    pub description_key: &'static str,
    pub run_key: &'static str,
    pub icon: &'static str,
    /// (tên trường, cách chọn, hậu tố tên file gợi ý cho `SavePdf`).
    pub picks: &'static [(&'static str, Pick, &'static str)],
}

pub static SPECS: &[OpSpec] = &[
    OpSpec {
        key: "repair",
        op_id: "doc.repair",
        def: "DocRepairParams",
        title_key: "repair.title",
        description_key: "repair.description",
        run_key: "repair.run",
        icon: "icons/wrench.svg",
        picks: &[
            ("inputPath", Pick::OpenPdf, ""),
            ("outputPath", Pick::SavePdf, "_sua"),
        ],
    },
    OpSpec {
        key: "compress",
        op_id: "compress.file",
        def: "CompressFileParams",
        title_key: "compress.title",
        description_key: "",
        run_key: "compress.run",
        icon: "icons/shrink.svg",
        picks: &[
            ("inputPath", Pick::OpenPdf, ""),
            ("outputPath", Pick::SavePdf, "_nen"),
        ],
    },
    OpSpec {
        key: "encrypt",
        op_id: "security.encryptFile",
        def: "SecurityEncryptFileParams",
        title_key: "security.title",
        description_key: "security.description",
        run_key: "security.title",
        icon: "icons/lock.svg",
        picks: &[
            ("inputPath", Pick::OpenPdf, ""),
            ("outputPath", Pick::SavePdf, "_mat-khau"),
        ],
    },
    OpSpec {
        key: "pdfToImages",
        op_id: "convert.pdfToImages",
        def: "ConvertPdfToImagesParams",
        title_key: "convert.title",
        description_key: "",
        run_key: "convert.run",
        icon: "icons/image.svg",
        picks: &[("path", Pick::OpenPdf, "")],
    },
    OpSpec {
        key: "imagesToPdf",
        op_id: "convert.imagesToPdf",
        def: "ConvertImagesToPdfParams",
        title_key: "convert.title",
        description_key: "",
        run_key: "convert.run",
        icon: "icons/file-image.svg",
        picks: &[
            ("images", Pick::AddImage, ""),
            ("outputPath", Pick::SavePdf, ""),
        ],
    },
    OpSpec {
        key: "verifyBatch",
        op_id: "sign.verifyBatch",
        def: "SignVerifyBatchParams",
        title_key: "verifyBatch.title",
        description_key: "verifyBatch.description",
        run_key: "verifyBatch.run",
        icon: "icons/shield-check.svg",
        picks: &[],
    },
];

pub fn spec_for(key: &str) -> Option<&'static OpSpec> {
    SPECS.iter().find(|s| s.key == key)
}

pub struct OpPanel {
    supervisor: Option<Arc<Mutex<Supervisor>>>,
    spec: Option<&'static OpSpec>,
    form: Option<Entity<SchemaForm>>,
    /// Ảnh đã chọn cho trường `FileList` (nếu thao tác có).
    files: Vec<String>,
    running: bool,
    confirm_cancel: bool,
    result: Option<TaskResult>,
    error: Option<String>,
    initial_dir: Option<PathBuf>,
    job_id: JobSlot,
    pick_focus: Vec<FocusHandle>,
    return_to: Option<FocusHandle>,
}

impl OpPanel {
    pub fn new(supervisor: Option<Arc<Mutex<Supervisor>>>, cx: &mut Context<Self>) -> Self {
        Self {
            supervisor,
            spec: None,
            form: None,
            files: Vec::new(),
            running: false,
            confirm_cancel: false,
            result: None,
            error: None,
            initial_dir: None,
            job_id: Arc::new(Mutex::new(None)),
            pick_focus: (0..4).map(|_| cx.focus_handle()).collect(),
            return_to: None,
        }
    }

    /// Mở hộp thoại của thao tác `key`. Trả false nếu không có thao tác đó.
    pub fn open(
        &mut self,
        key: &str,
        initial_dir: Option<PathBuf>,
        dark: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.spec.is_some() {
            return true;
        }
        let Some(spec) = spec_for(key) else {
            return false;
        };
        let root = chef_contracts::ops_schema();
        // Definition phải có trong schema; kiểm trước để không có form hỏng (R5.02).
        if FormSchema::from_definition(&root, spec.def).is_err() {
            return false;
        }
        self.error = None;
        self.form = Some(cx.new(|cx| {
            SchemaForm::new(&root, spec.def, dark, cx).expect("definition đã kiểm ở trên")
        }));
        self.files.clear();
        self.result = None;
        self.running = false;
        self.confirm_cancel = false;
        self.initial_dir = initial_dir;
        self.return_to = window.focused(cx);
        self.spec = Some(spec);
        cx.notify();
        true
    }

    pub fn close(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.spec = None;
        self.form = None;
        self.confirm_cancel = false;
        if let Some(focus) = self.return_to.take() {
            window.focus(&focus, cx);
        }
        cx.notify();
    }

    fn pick(
        &mut self,
        field: &'static str,
        kind: Pick,
        suffix: &'static str,
        cx: &mut Context<Self>,
    ) {
        let Some(form) = self.form.clone() else {
            return;
        };
        match kind {
            Pick::OpenPdf => {
                if let Some(path) = crate::dialogs::open_pdfs(self.initial_dir.as_deref())
                    .into_iter()
                    .next()
                {
                    form.update(cx, |f, cx| {
                        f.set_text(field, &path.display().to_string(), cx)
                    });
                }
            }
            Pick::SavePdf => {
                let suggested = format!("document{suffix}.pdf");
                if let Some(path) =
                    crate::dialogs::save_pdf(self.initial_dir.as_deref(), &suggested)
                {
                    form.update(cx, |f, cx| {
                        f.set_text(field, &path.display().to_string(), cx)
                    });
                }
            }
            Pick::AddImage => {
                if let Some(path) = crate::dialogs::open_image(self.initial_dir.as_deref()) {
                    self.files.push(path.display().to_string());
                    let files = self.files.clone();
                    form.update(cx, |f, cx| f.set_files(field, files, cx));
                }
            }
        }
        self.result = None;
        cx.notify();
    }

    fn run(&mut self, cx: &mut Context<Self>) {
        if self.running {
            return;
        }
        let (Some(spec), Some(form)) = (self.spec, self.form.clone()) else {
            return;
        };
        let Some(supervisor) = self.supervisor.clone() else {
            self.result = Some(TaskResult::error(t("editor.coreUnavailable")));
            cx.notify();
            return;
        };
        let Some(params) = form.update(cx, |f, cx| f.validate(cx)) else {
            self.result = None;
            cx.notify();
            return;
        };
        self.running = true;
        self.confirm_cancel = false;
        self.result = None;
        cx.notify();
        job_runner::spawn_job(
            supervisor,
            spec.op_id.to_string(),
            params,
            self.job_id.clone(),
            cx,
            |panel: &mut OpPanel, outcome, cx| panel.finish(outcome, cx),
        );
    }

    fn finish(&mut self, outcome: Outcome, cx: &mut Context<Self>) {
        self.running = false;
        self.confirm_cancel = false;
        if let Ok(mut id) = self.job_id.lock() {
            *id = None;
        }
        self.result = Some(match outcome {
            Outcome::Done(value) => {
                let first = value
                    .get("outputs")
                    .and_then(|o| o.as_array())
                    .and_then(|a| a.first())
                    .and_then(|v| v.as_str())
                    .map(String::from);
                let ok = TaskResult::success(t("merge.doneTitle"));
                match first {
                    Some(path) => {
                        let name = path.rsplit(['/', '\\']).next().unwrap_or(&path).to_string();
                        ok.detail(t_with("merge.doneText", &[("name", &name)]))
                    }
                    None => ok,
                }
            }
            Outcome::Cancelled => TaskResult::cancelled(t("editor.operationFailed")),
            Outcome::Failed(message) => TaskResult::error(t("merge.failed")).detail(message),
        });
        cx.notify();
    }
}

fn label_for(field: &str) -> String {
    match field {
        "images" => t("merge.addFiles"),
        "outputPath" => t("editor.saveAs"),
        _ => t("common.browse"),
    }
}

/// Dựng hộp thoại nếu đang mở.
pub fn build(panel: &Entity<OpPanel>, dark: bool, cx: &mut App) -> Option<TaskDialog> {
    let state = panel.read(cx);
    let spec = state.spec?;
    let form = state.form.clone()?;
    let mut picks = div().flex().flex_wrap().gap(px(8.0));
    for (i, (field, kind, suffix)) in spec.picks.iter().enumerate() {
        let (field, kind, suffix) = (*field, *kind, *suffix);
        let p = panel.clone();
        picks = picks.child(
            Button::new(
                SharedString::from(format!("op-pick-{}-{field}", spec.key)),
                state.pick_focus[i.min(3)].clone(),
            )
            .label(label_for(field))
            .size(Size::Sm)
            .variant(Variant::Secondary)
            .dark(dark)
            .disabled(state.running)
            .on_click(move |_, _, cx| p.update(cx, |p, cx| p.pick(field, kind, suffix, cx))),
        );
    }
    let body = div()
        .flex()
        .flex_col()
        .gap(px(12.0))
        .child(picks)
        .child(form);
    let (run, close, request, keep, confirm_stop, cancel_run) = (
        panel.clone(),
        panel.clone(),
        panel.clone(),
        panel.clone(),
        panel.clone(),
        panel.clone(),
    );
    let mut dialog = TaskDialog::new(
        SharedString::from(format!("op-dialog-{}", spec.key)),
        t(spec.title_key),
        dark,
    )
    .icon(spec.icon)
    .child(body)
    .run_label(t(spec.run_key))
    .can_run(!state.running)
    .running(state.running)
    .confirm_cancel_open(state.confirm_cancel)
    .on_run(move |_, cx| run.update(cx, |p, cx| p.run(cx)))
    .on_close(move |window, cx| {
        close.update(cx, |p, cx| {
            if p.running {
                p.confirm_cancel = true;
                cx.notify();
            } else {
                p.close(window, cx);
            }
        });
    })
    .on_request_cancel_confirm(move |_, cx| {
        request.update(cx, |p, cx| {
            p.confirm_cancel = true;
            cx.notify();
        })
    })
    .on_keep_running(move |_, cx| {
        keep.update(cx, |p, cx| {
            p.confirm_cancel = false;
            cx.notify();
        })
    })
    .on_confirm_cancel_close(move |window, cx| {
        confirm_stop.update(cx, |p, cx| {
            job_runner::cancel(&p.supervisor, &p.job_id);
            p.close(window, cx);
        })
    })
    .on_cancel_run(move |_, cx| {
        cancel_run.update(cx, |p, _| job_runner::cancel(&p.supervisor, &p.job_id))
    });
    if !spec.description_key.is_empty() {
        dialog = dialog.description(t(spec.description_key));
    }
    if let Some(result) = state.result.clone() {
        dialog = dialog.result(result);
    }
    Some(dialog)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_spec_builds_a_form_with_its_pick_fields() {
        let root = chef_contracts::ops_schema();
        for spec in SPECS {
            let schema = FormSchema::from_definition(&root, spec.def)
                .unwrap_or_else(|e| panic!("{}: {e:?}", spec.key));
            for (field, _, _) in spec.picks {
                assert!(
                    schema.fields.iter().any(|f| f.name == *field),
                    "{}: không có trường {field}",
                    spec.key
                );
            }
            assert!(chef_contracts::OPS_SCHEMA.contains(&format!("\"{}\"", spec.def)));
        }
    }

    #[test]
    fn keys_are_unique_and_strings_exist() {
        let mut keys: Vec<&str> = SPECS.iter().map(|s| s.key).collect();
        keys.sort_unstable();
        keys.dedup();
        assert_eq!(keys.len(), SPECS.len());
        for spec in SPECS {
            for key in [spec.title_key, spec.run_key] {
                assert_ne!(t(key), key, "thiếu chuỗi {key}");
            }
            if !spec.description_key.is_empty() {
                assert_ne!(t(spec.description_key), spec.description_key);
            }
        }
        assert!(spec_for("repair").is_some() && spec_for("zzz").is_none());
    }
}
