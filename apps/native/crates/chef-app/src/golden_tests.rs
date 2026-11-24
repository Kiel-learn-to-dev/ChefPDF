//! So tham số mà các hộp thoại M5 dựng (R5.03 đến R5.08) với `testdata/op_params.json`. Cùng file này được
//! `core/tests/test_native_op_params.py` chạy trên lõi Python thật, nên JSON mà vỏ Rust gửi đi đã được lõi
//! chấp nhận, không chỉ khớp với suy đoán của người viết test.

use serde_json::{Value, json};

use crate::blank_pages::{BlankInput, find_params, remove_params};
use crate::crop_page::{self, CropInput, Fit, Kind, Method, Paper, Scope};
use crate::merge::{self, MergeRow, Probe};
use crate::page_range::SplitMode;
use crate::process::ProbedPdf;
use crate::smart_split::{self, SmartInput, SmartMode};
use crate::split::{self, SplitInput};
use crate::split_page;

fn golden(key: &str) -> (String, Value) {
    let all: Value = serde_json::from_str(include_str!("../testdata/op_params.json")).unwrap();
    let entry = all
        .get(key)
        .unwrap_or_else(|| panic!("thiếu mẫu {key}"))
        .clone();
    (
        entry["op"].as_str().unwrap().to_string(),
        entry["params"].clone(),
    )
}

fn row(path: &str, pages: usize, range: &str) -> MergeRow {
    MergeRow {
        path: path.into(),
        probe: Probe::Ready(ProbedPdf {
            page_count: pages,
            file_size: 1,
        }),
        range: range.into(),
    }
}

#[test]
fn merge_matches_the_golden_params() {
    let rows = [row("{a}", 10, ""), row("{b}", 5, "2-3")];
    let built = merge::build_params(&rows, "{out}", true).unwrap();
    assert_eq!(built, golden("merge").1);
}

fn split_input(mode: SplitMode) -> SplitInput {
    SplitInput {
        mode,
        ranges: "1-2, 3-6".into(),
        n: "2".into(),
        max_mb: "1,5".into(),
        output_dir: "{dir}".into(),
        template: "{name}_{index}".into(),
    }
}

#[test]
fn split_matches_the_golden_params() {
    for (key, mode) in [
        ("split.ranges", SplitMode::Ranges),
        ("split.everyN", SplitMode::EveryN),
        ("split.maxSize", SplitMode::MaxSize),
    ] {
        let built = split::build_params(&split_input(mode), 6, None).unwrap();
        assert_eq!(built, golden(key).1, "{key}");
    }
    let mut odd = split_input(SplitMode::OddEven);
    odd.template = "{name}_{start}-{end}".into();
    assert_eq!(
        split::build_params(&odd, 6, None).unwrap(),
        golden("split.oddEven").1
    );
}

fn smart_input(mode: SmartMode) -> SmartInput {
    SmartInput {
        source: "{a}".into(),
        mode,
        level: "1".into(),
        pattern: "Chương [0-9]+".into(),
        ignore_case: false,
        drop_separators: true,
        sensitivity_percent: 50.0,
        output_dir: "{dir}".into(),
        template: "{name}_{index}".into(),
    }
}

#[test]
fn smart_split_matches_the_golden_params() {
    for (key, mode) in [
        ("smart.blank", SmartMode::Blank),
        ("smart.bookmarkLevel", SmartMode::BookmarkLevel),
        ("smart.pattern", SmartMode::Pattern),
    ] {
        let built = smart_split::build_params(&smart_input(mode)).unwrap();
        assert_eq!(built, golden(key).1, "{key}");
    }
}

fn crop_input() -> CropInput {
    CropInput {
        kind: Kind::Crop,
        method: Method::Margins,
        scope: Scope::All,
        pages: String::new(),
        margins: ["5".into(), "6,5".into(), "7".into(), "8".into()],
        frame: ["0".into(), "0".into(), "300".into(), "400".into()],
        padding_mm: "3".into(),
        paper: Paper::A4,
        width_mm: "100,5".into(),
        height_mm: "297".into(),
        fit: Fit::Scale,
    }
}

#[test]
fn crop_and_resize_match_the_golden_params() {
    let margins = crop_input();
    assert_eq!(
        crop_page::build(&margins, 6).unwrap(),
        ("page.crop", golden("crop.margins").1)
    );
    let trim = CropInput {
        method: Method::AutoTrim,
        scope: Scope::Pages,
        pages: "1, 3".into(),
        ..crop_input()
    };
    assert_eq!(
        crop_page::build(&trim, 6).unwrap().1,
        golden("crop.autoTrim").1
    );
    let frame = CropInput {
        method: Method::Box,
        scope: Scope::Odd,
        ..crop_input()
    };
    assert_eq!(crop_page::build(&frame, 6).unwrap().1, golden("crop.box").1);
    let resize = CropInput {
        kind: Kind::Resize,
        ..crop_input()
    };
    assert_eq!(
        crop_page::build(&resize, 6).unwrap(),
        ("page.resize", golden("resize.a4").1)
    );
    let custom = CropInput {
        kind: Kind::Resize,
        paper: Paper::Custom,
        scope: Scope::Even,
        fit: Fit::Center,
        ..crop_input()
    };
    assert_eq!(
        crop_page::build(&custom, 6).unwrap().1,
        golden("resize.custom").1
    );
}

#[test]
fn blank_pages_match_the_golden_params() {
    let input = BlankInput::default();
    assert_eq!(find_params(&input).unwrap(), golden("blank.find").1);
    assert_eq!(
        remove_params(&input, &[1, 2]).unwrap(),
        golden("blank.remove").1
    );
}

#[test]
fn grid_split_form_matches_the_golden_params() {
    use chef_ui::schema_form::{FieldInput, FormSchema};
    let schema =
        FormSchema::from_definition(&chef_contracts::ops_schema(), "PageSplitParams").unwrap();
    let order_index = schema
        .fields
        .iter()
        .find(|f| f.name == "order")
        .map(|f| match &f.kind {
            chef_ui::schema_form::FieldKind::Choice(values) => {
                values.iter().position(|v| v == &json!("rtl")).unwrap()
            }
            other => panic!("order không phải lựa chọn: {other:?}"),
        })
        .unwrap();
    let mut inputs = schema.initial_inputs();
    inputs.insert("pages".into(), FieldInput::Text("1".into()));
    inputs.insert("rows".into(), FieldInput::Text("2".into()));
    inputs.insert("cols".into(), FieldInput::Text("2".into()));
    inputs.insert("overlapMm".into(), FieldInput::Text("1,5".into()));
    inputs.insert("order".into(), FieldInput::Choice(Some(order_index)));
    let built = split_page::finish_params(schema.build(&inputs).unwrap());
    assert_eq!(built, golden("grid.split").1);
}
