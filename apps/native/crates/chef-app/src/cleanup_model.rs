//! Gỡ nền trang và gỡ đối tượng giống nhau (TASKS_RUST R5.41, R5.42; FEATURES E4, E5): port
//! `backgroundModel.ts` và `removeSimilarModel.ts`. Phạm vi trang dùng `watermark_model::CleanupScope`.
//! Logic thuần.
#![allow(dead_code)]

use std::collections::BTreeMap;

use serde_json::{Map, Value, json};

use crate::overlay_common::is_hex_color;
use crate::watermark_model::{CleanupScope, scope_fields_of};

// ---- Nền trang (E5) ----

#[derive(Debug, Clone, PartialEq)]
pub struct BackgroundItem {
    pub page_index: u64,
    pub id: String,
    /// "rectangle", "image" hoặc "fill" theo tên của lõi.
    pub kind: String,
    /// Khung hiển thị [x1, y1, x2, y2], pt, gốc trên-trái.
    pub bbox: Vec<f64>,
    /// 0..1 diện tích trang.
    pub coverage: f64,
    /// #rrggbb hoặc None.
    pub fill: Option<String>,
}

/// Nền của `background.detect`; mục hỏng bị bỏ.
pub fn read_backgrounds(data: &Value) -> Vec<BackgroundItem> {
    data.get("backgrounds")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|r| {
            Some(BackgroundItem {
                page_index: r.get("pageIndex")?.as_u64()?,
                id: r.get("id")?.as_str()?.to_string(),
                kind: r
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
                bbox: r
                    .get("bbox")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect())
                    .unwrap_or_default(),
                coverage: r.get("coverage").and_then(Value::as_f64).unwrap_or(0.0),
                fill: r.get("fill").and_then(Value::as_str).map(String::from),
            })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct PageBackgrounds {
    pub page_index: u64,
    pub items: Vec<BackgroundItem>,
    /// Độ phủ lớn nhất trên trang, 0..1.
    pub coverage: f64,
}

/// Nền gom theo trang, theo thứ tự trang.
pub fn group_by_page(items: &[BackgroundItem]) -> Vec<PageBackgrounds> {
    let mut by: BTreeMap<u64, Vec<BackgroundItem>> = BTreeMap::new();
    for it in items {
        by.entry(it.page_index).or_default().push(it.clone());
    }
    by.into_iter()
        .map(|(page_index, items)| PageBackgrounds {
            page_index,
            coverage: items.iter().map(|i| i.coverage).fold(0.0, f64::max),
            items,
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackgroundMode {
    Remove,
    ReplaceColor,
}

/// `background.remove`. `ReplaceColor` cần màu #rrggbb. None khi màu hay phạm vi trang sai.
pub fn background_remove_params(
    mode: BackgroundMode,
    color: &str,
    scope: &CleanupScope,
    page_count: usize,
) -> Option<Value> {
    let mut m: Map<String, Value> = scope_fields_of(scope, page_count)?;
    match mode {
        BackgroundMode::Remove => {
            m.insert("mode".into(), "remove".into());
        }
        BackgroundMode::ReplaceColor => {
            if !is_hex_color(color) {
                return None;
            }
            m.insert("mode".into(), "replaceColor".into());
            m.insert("color".into(), color.into());
        }
    }
    Some(Value::Object(m))
}

/// Số đối tượng bị gỡ hoặc đổi màu, từ kết quả `background.remove`.
pub fn read_background_result(data: &Value) -> u64 {
    data.get("objects").and_then(Value::as_u64).unwrap_or(0)
}

// ---- Gỡ đối tượng giống nhau (E4) ----

pub const DEFAULT_TOLERANCE_MM: f64 = 2.0;
pub const MAX_TOLERANCE_MM: f64 = 20.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SimilarScope {
    All,
    Others,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PickedObject {
    pub id: String,
    pub page_index: u64,
    pub kind: String,
    pub bbox: Vec<f64>,
}

/// Đối tượng của kết quả `content.hitTest`; None khi điểm không nằm trên đối tượng nào.
pub fn read_picked_object(data: &Value) -> Option<PickedObject> {
    let o = data.get("object").filter(|o| o.is_object())?;
    Some(PickedObject {
        id: o.get("id")?.as_str()?.to_string(),
        page_index: o.get("pageIndex").and_then(Value::as_u64).unwrap_or(0),
        kind: o
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        bbox: o
            .get("bbox")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect())
            .unwrap_or_default(),
    })
}

pub fn clamp_tolerance(mm: f64) -> f64 {
    if mm.is_finite() {
        mm.clamp(0.0, MAX_TOLERANCE_MM)
    } else {
        DEFAULT_TOLERANCE_MM
    }
}

/// `content.removeSimilar`; `dry_run` chỉ liệt kê chỗ khớp.
pub fn similar_params(
    picked: &PickedObject,
    scope: SimilarScope,
    tolerance_mm: f64,
    dry_run: bool,
) -> Value {
    json!({"pageIndex": picked.page_index, "objectId": picked.id,
        "scope": if scope == SimilarScope::All { "all" } else { "others" },
        "toleranceMm": clamp_tolerance(tolerance_mm), "dryRun": dry_run})
}

#[derive(Debug, Clone, PartialEq)]
pub struct SimilarMatch {
    pub id: String,
    pub page_index: u64,
    pub bbox: Vec<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SimilarResult {
    pub dry_run: bool,
    pub matches: Vec<SimilarMatch>,
    pub removed_objects: u64,
}

/// Kết quả `content.removeSimilar`.
pub fn read_similar_result(d: &Value) -> SimilarResult {
    SimilarResult {
        dry_run: d.get("dryRun").and_then(Value::as_bool) != Some(false),
        matches: d
            .get("matches")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter(|m| m.is_object())
                    .map(|m| SimilarMatch {
                        id: m
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                        page_index: m.get("pageIndex").and_then(Value::as_u64).unwrap_or(0),
                        bbox: m
                            .get("bbox")
                            .and_then(Value::as_array)
                            .map(|a| a.iter().map(|x| x.as_f64().unwrap_or(f64::NAN)).collect())
                            .unwrap_or_default(),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        removed_objects: d.get("removedObjects").and_then(Value::as_u64).unwrap_or(0),
    }
}

/// Trang có chỗ khớp và số lượng, theo thứ tự trang: cho danh sách xem trước.
pub fn matches_per_page(matches: &[SimilarMatch]) -> Vec<(u64, usize)> {
    let mut c: BTreeMap<u64, usize> = BTreeMap::new();
    for m in matches {
        *c.entry(m.page_index).or_insert(0) += 1;
    }
    c.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backgrounds_grouped_and_params() {
        let items = read_backgrounds(&json!({"backgrounds":[
            {"pageIndex":2,"id":"a","kind":"image","bbox":[0,0,10,10],"coverage":0.9,"fill":"#ffffff"},
            {"pageIndex":0,"id":"b","coverage":0.3},
            {"pageIndex":2,"id":"c","coverage":0.95}, {"id":"d"}, {"pageIndex":1}, 5]}));
        assert_eq!(items.len(), 3);
        assert_eq!(
            (items[1].kind.as_str(), items[1].fill.clone()),
            ("unknown", None)
        );
        let g = group_by_page(&items);
        assert_eq!(
            g.iter()
                .map(|p| (p.page_index, p.items.len(), p.coverage))
                .collect::<Vec<_>>(),
            [(0, 1, 0.3), (2, 2, 0.95)]
        );
        let all = CleanupScope::All;
        assert_eq!(
            background_remove_params(BackgroundMode::Remove, "", &all, 5).unwrap(),
            json!({"mode":"remove"})
        );
        let r = background_remove_params(
            BackgroundMode::ReplaceColor,
            "#FFFFFF",
            &CleanupScope::Range("2-3".into()),
            5,
        )
        .unwrap();
        assert_eq!(
            (r["mode"].as_str(), r["color"].as_str(), &r["pages"]),
            (Some("replaceColor"), Some("#FFFFFF"), &json!([1, 2]))
        );
        assert!(background_remove_params(BackgroundMode::ReplaceColor, "white", &all, 5).is_none());
        assert!(
            background_remove_params(
                BackgroundMode::Remove,
                "",
                &CleanupScope::Range("9".into()),
                5
            )
            .is_none()
        );
        assert_eq!(
            (
                read_background_result(&json!({"objects":4})),
                read_background_result(&Value::Null)
            ),
            (4, 0)
        );
    }

    #[test]
    fn similar_objects() {
        assert!(read_picked_object(&json!({})).is_none());
        assert!(read_picked_object(&json!({"object":{"kind":"text"}})).is_none());
        let p = read_picked_object(
            &json!({"object":{"id":"p1:x","pageIndex":1,"kind":"path","bbox":[1,2,3,4]}}),
        )
        .unwrap();
        assert_eq!(
            (p.page_index, p.kind.as_str(), p.bbox.clone()),
            (1, "path", vec![1.0, 2.0, 3.0, 4.0])
        );
        let v = similar_params(&p, SimilarScope::Others, 99.0, true);
        assert_eq!(
            (
                v["scope"].as_str(),
                v["toleranceMm"].as_f64(),
                v["dryRun"].as_bool(),
                v["objectId"].as_str()
            ),
            (Some("others"), Some(20.0), Some(true), Some("p1:x"))
        );
        assert_eq!(
            (
                clamp_tolerance(-1.0),
                clamp_tolerance(f64::NAN),
                clamp_tolerance(5.0)
            ),
            (0.0, DEFAULT_TOLERANCE_MM, 5.0)
        );
        let r = read_similar_result(
            &json!({"dryRun":true,"matches":[{"id":"a","pageIndex":3},{"id":"b","pageIndex":1},{"id":"c","pageIndex":3},7]}),
        );
        assert!(r.dry_run && r.matches.len() == 3 && r.removed_objects == 0);
        assert_eq!(matches_per_page(&r.matches), [(1, 1), (3, 2)]);
        assert!(!read_similar_result(&json!({"dryRun":false,"removedObjects":6})).dry_run);
        assert!(
            read_similar_result(&json!({})).dry_run,
            "thiếu dryRun: coi là chỉ xem"
        );
    }
}
