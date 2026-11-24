//! Quy trình tự động và thư mục tự động (TASKS_RUST R5.61–R5.63; FEATURES O): port `workflowModel.ts`,
//! `watch/watchModel.ts` và `start/startWorkflowModel.ts`. Quy trình là JSON của lõi (`Workflow`),
//! giữ dạng `serde_json::Value`. Logic thuần.
#![allow(dead_code)]

use serde_json::{Value, json};

/// Quy trình mới: một bước đầu (nếu có), nhận PDF, ghi cạnh file với hậu tố `_da-xu-ly`. `stamp` là
/// mã duy nhất do bên gọi cấp (Electron dùng thời gian hệ 36).
pub fn create_workflow(stamp: &str, initial_step: Option<&Value>) -> Value {
    json!({"id": format!("workflow-{stamp}"), "name": "Quy trình mới", "version": 1,
        "steps": initial_step.map(|s| vec![s.clone()]).unwrap_or_default(),
        "inputs": {"accept": ["pdf"]}, "output": {"mode": "suffix", "suffix": "_da-xu-ly"}})
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputMode {
    Suffix,
    Folder,
    Overwrite,
}

impl OutputMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Suffix => "suffix",
            Self::Folder => "folder",
            Self::Overwrite => "overwrite",
        }
    }
}

/// Ghi đè đầu ra khi chạy (`workflow.run`): lựa chọn của hộp thoại cộng hai cờ của quy trình.
pub fn build_output_override(
    workflow_output: &Value,
    mode: OutputMode,
    suffix: &str,
    folder: &str,
    name_template: &str,
) -> Value {
    let mut v = json!({"mode": mode.as_str(), "suffix": suffix});
    if mode == OutputMode::Folder && !folder.is_empty() {
        v["folder"] = folder.into();
    }
    if !name_template.is_empty() {
        v["nameTemplate"] = name_template.into();
    }
    if workflow_output.get("alsoSavePdf").and_then(Value::as_bool) == Some(true) {
        v["alsoSavePdf"] = true.into();
    }
    if let Some(m) = workflow_output.get("maxBytes").filter(|m| !m.is_null()) {
        v["maxBytes"] = m.clone();
    }
    v
}

/// Đổi chỗ bước `index` với bước kế (delta ±1); ngoài phạm vi thì không đổi.
pub fn move_step<T: Clone>(steps: &[T], index: usize, delta: i32) -> Vec<T> {
    let mut v = steps.to_vec();
    let target = index as i64 + delta as i64;
    if index < v.len() && (0..v.len() as i64).contains(&target) {
        v.swap(index, target as usize);
    }
    v
}

pub fn remove_step<T: Clone>(steps: &[T], index: usize) -> Vec<T> {
    steps
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != index)
        .map(|(_, s)| s.clone())
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkflowJsonError {
    Invalid,
    NotAnObject,
}

/// Đọc quy trình từ JSON (file nhập).
pub fn parse_workflow_json(text: &str) -> Result<Value, WorkflowJsonError> {
    let v: Value = serde_json::from_str(text).map_err(|_| WorkflowJsonError::Invalid)?;
    if v.is_object() {
        Ok(v)
    } else {
        Err(WorkflowJsonError::NotAnObject)
    }
}

pub fn format_workflow_json(w: &Value) -> String {
    serde_json::to_string_pretty(w).expect("JSON hợp lệ") + "\n"
}

// ---- Thư mục tự động (watch) ----

#[derive(Debug, Clone, PartialEq)]
pub struct WatchConfig {
    pub source_folder: String,
    pub output_folder: String,
    pub workflow: Value,
    pub poll_seconds: f64,
    pub settle_seconds: f64,
    pub pattern: String,
}

/// Đường dẫn sổ ghi các file đã xử lý, nằm trong thư mục nguồn: `.chef-watch-<id>.json`.
pub fn watch_ledger_path(folder: &str, workflow_id: &str, windows: bool) -> String {
    let sep = if windows { '\\' } else { '/' };
    let mut root = folder.trim_end_matches(['/', '\\']).to_string();
    if root.is_empty() && !folder.is_empty() {
        root = sep.to_string();
    }
    let id: String = workflow_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    let id = if id.is_empty() {
        "workflow".to_string()
    } else {
        id
    };
    let leaf = format!(".chef-watch-{id}.json");
    if root.ends_with(sep) {
        format!("{root}{leaf}")
    } else {
        format!("{root}{sep}{leaf}")
    }
}

/// Tham số quét một lượt.
pub fn watch_scan_params(c: &WatchConfig, ledger_path: &str) -> Value {
    json!({"directory": c.source_folder, "outputDirectory": c.output_folder, "ledgerPath": ledger_path,
        "settleSeconds": c.settle_seconds, "pattern": c.pattern})
}

/// Đầu ra của quy trình khi chạy từ thư mục tự động: luôn vào thư mục đích.
pub fn watch_workflow_output(c: &WatchConfig) -> Value {
    json!({"mode": "folder", "folder": c.output_folder,
        "alsoSavePdf": c.workflow.get("output").and_then(|o| o.get("alsoSavePdf")).and_then(Value::as_bool).unwrap_or(false)})
}

/// Chuẩn hóa đường dẫn thư mục để so sánh: `/`, bỏ `.` và `..` hợp lệ, không phân biệt hoa thường, bỏ `/` cuối.
fn canonical_folder(path: &str) -> String {
    let value = path.trim().replace('\\', "/");
    let drive: String = {
        let b = value.as_bytes();
        if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
            value[..2].to_lowercase()
        } else {
            String::new()
        }
    };
    let rest = &value[drive.len()..];
    let absolute = value.starts_with('/') || (!drive.is_empty() && rest.starts_with('/'));
    let mut stack: Vec<&str> = Vec::new();
    for part in rest.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." && stack.last().is_some_and(|l| *l != "..") {
            stack.pop();
        } else if part != ".." || !absolute {
            stack.push(part);
        }
    }
    let joined = format!(
        "{drive}{}{}",
        if absolute && drive.is_empty() {
            "/"
        } else {
            ""
        },
        stack.join("/")
    );
    let trimmed = joined.strip_suffix('/').unwrap_or(&joined).to_lowercase();
    if trimmed.is_empty() {
        "/".into()
    } else {
        trimmed
    }
}

/// Cấu hình hợp lệ: có hai thư mục khác nhau, có quy trình, mẫu tên, chu kỳ 1–3600 s, chờ ổn định 0–3600 s.
pub fn valid_watch_config(c: &WatchConfig) -> bool {
    !c.source_folder.trim().is_empty()
        && !c.output_folder.trim().is_empty()
        && canonical_folder(&c.source_folder) != canonical_folder(&c.output_folder)
        && c.workflow
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|i| !i.is_empty())
        && !c.pattern.trim().is_empty()
        && c.poll_seconds.is_finite()
        && (1.0..=3600.0).contains(&c.poll_seconds)
        && c.settle_seconds.is_finite()
        && (0.0..=3600.0).contains(&c.settle_seconds)
}

/// Thời gian chờ giữa hai lượt quét (ms), kẹp 1–3600 giây.
pub fn watch_delay_ms(seconds: f64) -> u64 {
    (seconds.floor().clamp(1.0, 3600.0) as u64) * 1000
}

// ---- Thả quy trình (start) ----

/// Bước có thể cắt/xóa nội dung, đổi điểm ảnh, giảm chất lượng hoặc ký.
const DATA_RISK_OPS: [&str; 12] = [
    "pageimg.autoCrop",
    "pageimg.crop",
    "pageimg.splitSpread",
    "pageimg.deskew",
    "pageimg.dewarp",
    "pageimg.removeFingers",
    "pageimg.enhance",
    "scan.rasterize",
    "compress.pdf",
    "overlay.pageNumbers",
    "stamp.seam",
    "sign.pades",
];

fn enabled_steps(flow: &Value) -> impl Iterator<Item = &Value> {
    flow.get("steps")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|s| s.get("enabled").and_then(Value::as_bool) != Some(false))
}

/// Quy trình có bước được bật có thể làm mất dữ liệu.
pub fn has_data_risk(flow: &Value) -> bool {
    enabled_steps(flow).any(|s| {
        s.get("op")
            .and_then(Value::as_str)
            .is_some_and(|o| DATA_RISK_OPS.contains(&o))
    })
}

/// Quy trình ghép cần ít nhất 2 file.
pub fn needs_more_files(flow: &Value, file_count: usize) -> bool {
    flow.get("inputs")
        .and_then(|i| i.get("mode"))
        .and_then(Value::as_str)
        == Some("merge")
        && file_count < 2
}

/// Kết quả `workflow.validate` (phần giao diện đọc).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ValidationReport {
    pub valid: bool,
    pub warnings: usize,
    pub required_secrets: usize,
    pub required_variables: Vec<String>,
}

pub fn read_validation(d: &Value) -> ValidationReport {
    let len = |k: &str| d.get(k).and_then(Value::as_array).map_or(0, Vec::len);
    ValidationReport {
        valid: d.get("valid").and_then(Value::as_bool) == Some(true),
        warnings: len("warnings"),
        required_secrets: len("requiredSecrets"),
        required_variables: d
            .get("requiredVariables")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// Quy trình được thả vào chạy ngay, trừ khi cần xem lại: bỏ ngón tay phải qua luồng đề xuất, quy
/// trình sai hay có cảnh báo, thiếu bí mật hay biến, ghi đè file gốc, hoặc file có mật khẩu.
pub fn needs_workflow_review(flow: &Value, report: &ValidationReport) -> bool {
    let has_finger_removal = enabled_steps(flow)
        .any(|s| s.get("op").and_then(Value::as_str) == Some("pageimg.removeFingers"));
    let missing_variable = report.required_variables.iter().any(|k| {
        flow.get("variables")
            .and_then(|v| v.get(k))
            .and_then(Value::as_str)
            .is_none_or(|s| s.trim().is_empty())
    });
    has_finger_removal
        || !report.valid
        || report.warnings > 0
        || report.required_secrets > 0
        || missing_variable
        || flow
            .get("output")
            .and_then(|o| o.get("mode"))
            .and_then(Value::as_str)
            == Some("overwrite")
        || flow
            .get("inputs")
            .and_then(|i| i.get("password"))
            .and_then(Value::as_bool)
            == Some(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn flow(ops: &[(&str, bool)]) -> Value {
        json!({"id":"w","steps": ops.iter().map(|(o, e)| json!({"op": o, "enabled": e})).collect::<Vec<_>>()})
    }

    #[test]
    fn create_edit_and_json() {
        let w = create_workflow(
            "abc",
            Some(&json!({"op":"page.rotate","params":{"angle":90}})),
        );
        assert_eq!(
            (
                w["id"].as_str(),
                w["steps"].as_array().unwrap().len(),
                w["output"]["suffix"].as_str(),
                &w["inputs"]
            ),
            (
                Some("workflow-abc"),
                1,
                Some("_da-xu-ly"),
                &json!({"accept":["pdf"]})
            )
        );
        assert!(
            create_workflow("x", None)["steps"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(move_step(&[1, 2, 3], 0, 1), [2, 1, 3]);
        assert_eq!(move_step(&[1, 2, 3], 0, -1), [1, 2, 3]);
        assert_eq!(move_step(&[1, 2, 3], 2, 1), [1, 2, 3]);
        assert_eq!(move_step(&[1, 2, 3], 9, -1), [1, 2, 3]);
        assert_eq!(remove_step(&[1, 2, 3], 1), [1, 3]);
        assert_eq!(
            parse_workflow_json("[1]"),
            Err(WorkflowJsonError::NotAnObject)
        );
        assert_eq!(parse_workflow_json("{"), Err(WorkflowJsonError::Invalid));
        let text = format_workflow_json(&w);
        assert!(text.ends_with("}\n"));
        assert_eq!(parse_workflow_json(&text).unwrap(), w);
    }

    #[test]
    fn output_override() {
        let out = json!({"alsoSavePdf": true, "maxBytes": 5000000});
        let v = build_output_override(&out, OutputMode::Folder, "_x", "/out", "{name}");
        assert_eq!(
            (
                v["mode"].as_str(),
                v["folder"].as_str(),
                v["nameTemplate"].as_str(),
                v["alsoSavePdf"].as_bool(),
                v["maxBytes"].as_u64()
            ),
            (
                Some("folder"),
                Some("/out"),
                Some("{name}"),
                Some(true),
                Some(5_000_000)
            )
        );
        let s = build_output_override(&Value::Null, OutputMode::Suffix, "_x", "/ignored", "");
        assert_eq!(
            (
                s.get("folder"),
                s.get("nameTemplate"),
                s.get("alsoSavePdf"),
                s["suffix"].as_str()
            ),
            (None, None, None, Some("_x"))
        );
        assert!(
            build_output_override(
                &json!({"maxBytes": null}),
                OutputMode::Overwrite,
                "",
                "",
                ""
            )
            .get("maxBytes")
            .is_none()
        );
    }

    #[test]
    fn watch_paths_and_config() {
        assert_eq!(
            watch_ledger_path("C:\\In\\", "Quy trình #1", true),
            "C:\\In\\.chef-watch-Quy_tr_nh__1.json"
        );
        assert_eq!(
            watch_ledger_path("/in/", "w", false),
            "/in/.chef-watch-w.json"
        );
        assert_eq!(watch_ledger_path("/", "w", false), "/.chef-watch-w.json");
        assert_eq!(
            watch_ledger_path("/in", "", false),
            "/in/.chef-watch-workflow.json"
        );
        assert_eq!(
            watch_ledger_path("/in", &"q".repeat(100), false)
                .matches('q')
                .count(),
            64
        );
        let c = WatchConfig {
            source_folder: "C:\\In".into(),
            output_folder: "C:\\Out".into(),
            workflow: json!({"id":"w"}),
            poll_seconds: 5.0,
            settle_seconds: 2.0,
            pattern: "*.pdf".into(),
        };
        assert!(valid_watch_config(&c));
        for bad in [
            WatchConfig {
                output_folder: "c:/in/".into(),
                ..c.clone()
            },
            WatchConfig {
                output_folder: "C:\\In\\sub\\..".into(),
                ..c.clone()
            },
            WatchConfig {
                source_folder: " ".into(),
                ..c.clone()
            },
            WatchConfig {
                workflow: json!({}),
                ..c.clone()
            },
            WatchConfig {
                pattern: " ".into(),
                ..c.clone()
            },
            WatchConfig {
                poll_seconds: 0.5,
                ..c.clone()
            },
            WatchConfig {
                poll_seconds: 4000.0,
                ..c.clone()
            },
            WatchConfig {
                settle_seconds: -1.0,
                ..c.clone()
            },
            WatchConfig {
                settle_seconds: f64::NAN,
                ..c.clone()
            },
        ] {
            assert!(!valid_watch_config(&bad), "{bad:?}");
        }
        assert!(valid_watch_config(&WatchConfig {
            output_folder: "C:\\In2".into(),
            ..c.clone()
        }));
        assert_eq!(
            (
                watch_delay_ms(0.2),
                watch_delay_ms(2.9),
                watch_delay_ms(99999.0)
            ),
            (1000, 2000, 3_600_000)
        );
        let p = watch_scan_params(&c, "/l.json");
        assert_eq!(
            (
                p["directory"].as_str(),
                p["ledgerPath"].as_str(),
                p["settleSeconds"].as_f64()
            ),
            (Some("C:\\In"), Some("/l.json"), Some(2.0))
        );
        assert_eq!(
            watch_workflow_output(&c),
            json!({"mode":"folder","folder":"C:\\Out","alsoSavePdf":false})
        );
    }

    #[test]
    fn dropped_workflows() {
        assert!(has_data_risk(&flow(&[
            ("page.rotate", true),
            ("scan.rasterize", true)
        ])));
        assert!(
            !has_data_risk(&flow(&[("scan.rasterize", false), ("page.rotate", true)])),
            "bước tắt không tính"
        );
        assert!(needs_more_files(&json!({"inputs":{"mode":"merge"}}), 1));
        assert!(
            !needs_more_files(&json!({"inputs":{"mode":"merge"}}), 2)
                && !needs_more_files(&json!({}), 0)
        );
        let ok = ValidationReport {
            valid: true,
            ..Default::default()
        };
        let f = flow(&[("page.rotate", true)]);
        assert!(!needs_workflow_review(&f, &ok));
        assert!(needs_workflow_review(
            &flow(&[("pageimg.removeFingers", true)]),
            &ok
        ));
        assert!(!needs_workflow_review(
            &flow(&[("pageimg.removeFingers", false)]),
            &ok
        ));
        assert!(needs_workflow_review(
            &f,
            &ValidationReport {
                valid: false,
                ..Default::default()
            }
        ));
        assert!(needs_workflow_review(
            &f,
            &ValidationReport {
                warnings: 1,
                ..ok.clone()
            }
        ));
        assert!(needs_workflow_review(
            &f,
            &ValidationReport {
                required_secrets: 1,
                ..ok.clone()
            }
        ));
        let var = ValidationReport {
            required_variables: vec!["ten".into()],
            ..ok.clone()
        };
        assert!(needs_workflow_review(&f, &var));
        let mut with_var = f.clone();
        with_var["variables"] = json!({"ten": "  "});
        assert!(
            needs_workflow_review(&with_var, &var),
            "biến toàn khoảng trắng coi là thiếu"
        );
        with_var["variables"] = json!({"ten": "An"});
        assert!(!needs_workflow_review(&with_var, &var));
        let mut ow = f.clone();
        ow["output"] = json!({"mode":"overwrite"});
        assert!(needs_workflow_review(&ow, &ok));
        let mut pw = f.clone();
        pw["inputs"] = json!({"password": true});
        assert!(needs_workflow_review(&pw, &ok));
        let r = read_validation(
            &json!({"valid":true,"warnings":["a"],"requiredSecrets":[],"requiredVariables":["x",1]}),
        );
        assert_eq!(
            (
                r.valid,
                r.warnings,
                r.required_secrets,
                r.required_variables
            ),
            (true, 1, 0, vec!["x".to_string()])
        );
    }
}
