//! Tách màu chữ ký và con dấu (TASKS_RUST R8.12, FEATURES I22): port `separateModel.ts`. Hai màu mực tự
//! nhận hoặc danh sách lớp màu tùy chỉnh. Mỗi lớp giữ lại được lưu thành một mục thư viện mới tên
//! "<mục> - <lớp>". Logic thuần.
#![allow(dead_code)]

use serde_json::{Value, json};

use crate::sig_library_model::{NAME_MAX, item_name};

pub const MAX_LAYERS: usize = 8;
pub const MAX_LAYER_NAME: usize = 60;
pub const DEFAULT_TOLERANCE: i64 = 60;
const PALETTE: [&str; 7] = [
    "#D32F2F", "#1F3A93", "#2E7D32", "#F9A825", "#6A1B9A", "#00838F", "#5D4037",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SeparateMode {
    AutoTwo,
    Custom,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayerForm {
    pub name: String,
    pub color_hex: String,
    pub tolerance: i64,
}

/// Hai lớp khởi đầu cho chế độ tùy chỉnh: con dấu đỏ và chữ ký xanh.
pub fn default_layers() -> Vec<LayerForm> {
    vec![
        LayerForm {
            name: "Con dấu".into(),
            color_hex: "#D32F2F".into(),
            tolerance: DEFAULT_TOLERANCE,
        },
        LayerForm {
            name: "Chữ ký".into(),
            color_hex: "#1F3A93".into(),
            tolerance: DEFAULT_TOLERANCE,
        },
    ]
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayerProblem {
    Empty,
    TooMany,
    Name,
    Color,
    Tolerance,
}

/// Vấn đề đầu tiên của các lớp tùy chỉnh, hoặc None khi gửi lõi được.
pub fn layer_problem(layers: &[LayerForm]) -> Option<LayerProblem> {
    if layers.is_empty() {
        return Some(LayerProblem::Empty);
    }
    if layers.len() > MAX_LAYERS {
        return Some(LayerProblem::TooMany);
    }
    for l in layers {
        let n = l.name.trim().encode_utf16().count();
        if n == 0 || n > MAX_LAYER_NAME {
            return Some(LayerProblem::Name);
        }
        if !crate::overlay_common::is_hex_color(&l.color_hex) {
            return Some(LayerProblem::Color);
        }
        if !(0..=255).contains(&l.tolerance) {
            return Some(LayerProblem::Tolerance);
        }
    }
    None
}

/// `image.separateColors`; chỉ trường của chế độ đã chọn.
pub fn separate_params(
    input_path: &str,
    output_dir: &str,
    mode: SeparateMode,
    layers: &[LayerForm],
) -> Value {
    match mode {
        SeparateMode::AutoTwo => {
            json!({"inputPath": input_path, "outputDir": output_dir, "mode": "auto-two"})
        }
        SeparateMode::Custom => {
            json!({"inputPath": input_path, "outputDir": output_dir, "mode": "layers",
            "layers": layers.iter().map(|l| json!({"name": l.name.trim(), "colorHex": l.color_hex.to_uppercase(), "tolerance": l.tolerance})).collect::<Vec<_>>()})
        }
    }
}

/// Tên mục thư viện từ một lớp: giữ đầu tên mục và cuối tên lớp để vừa giới hạn của thư viện.
pub fn layer_item_name(base: &str, layer: &str, fallback: &str) -> String {
    let suffix = format!(" - {}", layer.trim());
    let room = NAME_MAX.saturating_sub(suffix.chars().count());
    let head: String = item_name(base, fallback).chars().take(room).collect();
    format!("{head}{suffix}").chars().take(NAME_MAX).collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LayerOutcome {
    pub name: String,
    pub path: String,
    pub pixels: u64,
}

/// Lớp có ít nhất một điểm ảnh khớp: chỉ các lớp này thành mục thư viện.
pub fn kept_layers(outcomes: &[LayerOutcome]) -> Vec<LayerOutcome> {
    outcomes.iter().filter(|o| o.pixels > 0).cloned().collect()
}

/// Dòng `data.layers` của lõi; dòng sai dạng bị bỏ.
pub fn parse_layer_rows(data: &Value) -> Vec<LayerOutcome> {
    data.get("layers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|r| {
            Some(LayerOutcome {
                name: r.get("name")?.as_str()?.to_string(),
                path: r.get("path")?.as_str()?.to_string(),
                pixels: r
                    .get("pixels")
                    .and_then(Value::as_f64)
                    .filter(|n| *n > 0.0)
                    .map_or(0, |n| n as u64),
            })
        })
        .collect()
}

/// Thêm một lớp với màu kế tiếp trong bảng màu cố định; không quá `MAX_LAYERS`.
pub fn add_layer(layers: &[LayerForm], name: &str) -> Vec<LayerForm> {
    let mut v = layers.to_vec();
    if v.len() < MAX_LAYERS {
        v.push(LayerForm {
            name: name.into(),
            color_hex: PALETTE[layers.len() % PALETTE.len()].into(),
            tolerance: DEFAULT_TOLERANCE,
        });
    }
    v
}

pub fn remove_layer(layers: &[LayerForm], index: usize) -> Vec<LayerForm> {
    layers
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != index)
        .map(|(_, l)| l.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn problems() {
        assert_eq!(layer_problem(&default_layers()), None);
        assert_eq!(layer_problem(&[]), Some(LayerProblem::Empty));
        let many: Vec<LayerForm> = (0..9)
            .map(|i| LayerForm {
                name: format!("l{i}"),
                ..default_layers()[0].clone()
            })
            .collect();
        assert_eq!(layer_problem(&many), Some(LayerProblem::TooMany));
        let l = default_layers()[0].clone();
        assert_eq!(
            layer_problem(&[LayerForm {
                name: "  ".into(),
                ..l.clone()
            }]),
            Some(LayerProblem::Name)
        );
        assert_eq!(
            layer_problem(&[LayerForm {
                name: "x".repeat(61),
                ..l.clone()
            }]),
            Some(LayerProblem::Name)
        );
        assert_eq!(
            layer_problem(&[LayerForm {
                color_hex: "red".into(),
                ..l.clone()
            }]),
            Some(LayerProblem::Color)
        );
        assert_eq!(
            layer_problem(&[LayerForm {
                tolerance: 256,
                ..l.clone()
            }]),
            Some(LayerProblem::Tolerance)
        );
        assert_eq!(layer_problem(&[LayerForm { tolerance: 0, ..l }]), None);
    }

    #[test]
    fn params_by_mode() {
        let a = separate_params("/in.png", "/out", SeparateMode::AutoTwo, &default_layers());
        assert_eq!(
            (a["mode"].as_str(), a.get("layers")),
            (Some("auto-two"), None)
        );
        let layers = [LayerForm {
            name: " Con dấu ".into(),
            color_hex: "#d32f2f".into(),
            tolerance: 60,
        }];
        let c = separate_params("/in.png", "/out", SeparateMode::Custom, &layers);
        assert_eq!(
            (
                c["mode"].as_str(),
                c["layers"][0]["name"].as_str(),
                c["layers"][0]["colorHex"].as_str()
            ),
            (Some("layers"), Some("Con dấu"), Some("#D32F2F"))
        );
    }

    #[test]
    fn item_names_fit_the_library_limit() {
        assert_eq!(
            layer_item_name("Chữ ký An", " Con dấu ", "Mới"),
            "Chữ ký An - Con dấu"
        );
        assert_eq!(layer_item_name("  ", "Lớp", "Mặc định"), "Mặc định - Lớp");
        let long = layer_item_name(&"a".repeat(80), "Con dấu", "x");
        assert_eq!(long.chars().count(), NAME_MAX);
        assert!(long.ends_with(" - Con dấu") && long.starts_with("aaa"));
        assert!(
            layer_item_name("abc", &"z".repeat(100), "x")
                .chars()
                .count()
                <= NAME_MAX
        );
    }

    #[test]
    fn outcomes_and_layers_list() {
        let rows = parse_layer_rows(
            &json!({"layers":[{"name":"a","path":"/a.png","pixels":5},{"name":"b","path":"/b.png","pixels":0},{"name":"c","path":"/c.png"},{"name":"d"}, 3]}),
        );
        assert_eq!(rows.len(), 3);
        assert_eq!(
            kept_layers(&rows)
                .iter()
                .map(|r| r.name.as_str())
                .collect::<Vec<_>>(),
            ["a"]
        );
        let l = add_layer(&default_layers(), "Mới");
        assert_eq!(
            (l.len(), l[2].color_hex.as_str(), l[2].tolerance),
            (3, "#2E7D32", DEFAULT_TOLERANCE)
        );
        let mut full = default_layers();
        for _ in 0..10 {
            full = add_layer(&full, "x");
        }
        assert_eq!(full.len(), MAX_LAYERS);
        assert_eq!(remove_layer(&full, 0).len(), MAX_LAYERS - 1);
        assert_eq!(remove_layer(&default_layers(), 9).len(), 2);
    }
}
