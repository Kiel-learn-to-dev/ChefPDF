use std::collections::BTreeMap;

use serde_json::Value;

pub const FILTER_KINDS: [&str; 5] = ["text", "image", "path", "shading", "form"];

#[derive(Clone, Debug, PartialEq)]
pub struct LayerItem {
    pub id: String,
    pub name: String,
    pub visible: bool,
    pub locked: bool,
    pub object_count: usize,
    pub page_count: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TypeFilterBox {
    pub kind: String,
    pub bbox: [f32; 4],
    pub shown: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct TypeFilterData {
    pub page_index: usize,
    pub counts: BTreeMap<String, usize>,
    pub show_count: usize,
    pub hide_count: usize,
    pub boxes: Vec<TypeFilterBox>,
}

pub fn layers_from_reply(reply: &Value) -> Result<Vec<LayerItem>, String> {
    let root = reply.get("data").unwrap_or(reply);
    let list = root
        .get("layers")
        .and_then(Value::as_array)
        .ok_or_else(|| "Thiếu trường layers từ layers.list".to_string())?;
    let mut items = Vec::with_capacity(list.len());
    for raw in list {
        let id = raw
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "Lớp thiếu id".to_string())?
            .to_string();
        let name = raw
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let visible = raw.get("visible").and_then(Value::as_bool).unwrap_or(true);
        let locked = raw.get("locked").and_then(Value::as_bool).unwrap_or(false);
        let object_count = raw.get("objectCount").and_then(Value::as_u64).unwrap_or(0) as usize;
        let page_count = raw.get("pageCount").and_then(Value::as_u64).unwrap_or(0) as usize;
        items.push(LayerItem {
            id,
            name,
            visible,
            locked,
            object_count,
            page_count,
        });
    }
    Ok(items)
}

fn parse_bbox(raw: &Value) -> Option<[f32; 4]> {
    let arr = raw.as_array()?;
    if arr.len() < 4 {
        return None;
    }
    let vals = [
        arr[0].as_f64()? as f32,
        arr[1].as_f64()? as f32,
        arr[2].as_f64()? as f32,
        arr[3].as_f64()? as f32,
    ];
    if vals.iter().all(|v| v.is_finite()) {
        Some(vals)
    } else {
        None
    }
}

pub fn type_filter_from_reply(
    reply: &Value,
    active_kinds: &[String],
) -> Result<TypeFilterData, String> {
    let root = reply.get("data").unwrap_or(reply);
    let page_index =
        root.get("pageIndex")
            .and_then(Value::as_u64)
            .ok_or_else(|| "Thiếu pageIndex từ content.viewByType".to_string())? as usize;
    let kinds_obj = root
        .get("kinds")
        .and_then(Value::as_object)
        .ok_or_else(|| "Thiếu kinds từ content.viewByType".to_string())?;
    let mut counts = BTreeMap::new();
    let mut boxes = Vec::new();
    let all_shown = active_kinds.is_empty();
    let mut fallback_show = 0usize;
    let mut fallback_hide = 0usize;

    let mut push_kind = |kind: &str, entry: &Value| {
        let count = entry.get("count").and_then(Value::as_u64).unwrap_or(0) as usize;
        counts.insert(kind.to_string(), count);
        let shown = all_shown || active_kinds.iter().any(|k| k == kind);
        if let Some(bboxes) = entry.get("bboxes").and_then(Value::as_array) {
            for raw_box in bboxes {
                if let Some(bbox) = parse_bbox(raw_box) {
                    boxes.push(TypeFilterBox {
                        kind: kind.to_string(),
                        bbox,
                        shown,
                    });
                }
            }
        }
        if shown {
            fallback_show += count;
        } else {
            fallback_hide += count;
        }
    };

    for &kind in &FILTER_KINDS {
        if let Some(entry) = kinds_obj.get(kind) {
            push_kind(kind, entry);
        }
    }
    for (kind, entry) in kinds_obj {
        if !FILTER_KINDS.contains(&kind.as_str()) {
            push_kind(kind, entry);
        }
    }

    let hint = root.get("renderHint");
    let show_count = hint
        .and_then(|h| h.get("showIds"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(fallback_show);
    let hide_count = hint
        .and_then(|h| h.get("hideIds"))
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(fallback_hide);

    Ok(TypeFilterData {
        page_index,
        counts,
        show_count,
        hide_count,
        boxes,
    })
}

pub fn set_visibility_params(layer_id: &str, visible: bool) -> Value {
    serde_json::json!({
        "layerIds": [layer_id],
        "visible": visible,
    })
}

pub fn rename_params(layer_id: &str, name: &str) -> Result<Value, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Tên lớp không được để trống".to_string());
    }
    Ok(serde_json::json!({
        "layerId": layer_id,
        "name": trimmed,
    }))
}

pub fn remove_params(layer_id: &str, delete_content: bool) -> Value {
    serde_json::json!({
        "layerIds": [layer_id],
        "deleteContent": delete_content,
    })
}

pub fn flatten_params() -> Value {
    serde_json::json!({})
}

pub fn view_by_type_params(page_index: usize, kinds: &[String]) -> Value {
    if kinds.is_empty() {
        serde_json::json!({ "pageIndex": page_index })
    } else {
        serde_json::json!({
            "pageIndex": page_index,
            "kinds": kinds,
            "solo": true,
        })
    }
}

pub fn toggle_kind(current: &[String], kind: &str) -> Vec<String> {
    let removing = current.iter().any(|k| k == kind);
    let mut next = Vec::new();
    for &known in &FILTER_KINDS {
        let keep = if known == kind {
            !removing
        } else {
            current.iter().any(|k| k == known)
        };
        if keep {
            next.push(known.to_string());
        }
    }
    for extra in current {
        if !FILTER_KINDS.contains(&extra.as_str())
            && extra != kind
            && !next.iter().any(|k| k == extra)
        {
            next.push(extra.clone());
        }
    }
    next
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_layers_list_reply() {
        let reply = serde_json::json!({
            "data": {
                "baseState": "ON",
                "layers": [
                    {
                        "id": "5:0",
                        "name": "Watermarks",
                        "visible": true,
                        "locked": false,
                        "objectCount": 3,
                        "pageCount": 1
                    },
                    {
                        "id": "6:0",
                        "name": "",
                        "visible": false,
                        "locked": true,
                        "objectCount": 0,
                        "pageCount": 0
                    }
                ]
            }
        });
        let parsed = layers_from_reply(&reply).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].id, "5:0");
        assert_eq!(parsed[0].name, "Watermarks");
        assert!(parsed[0].visible);
        assert!(!parsed[0].locked);
        assert_eq!(parsed[0].object_count, 3);
        assert_eq!(parsed[0].page_count, 1);
        assert!(!parsed[1].visible);
        assert!(parsed[1].locked);
    }

    #[test]
    fn parses_view_by_type_reply_with_active_kinds() {
        let reply = serde_json::json!({
            "data": {
                "pageIndex": 0,
                "displayWidth": 612.0,
                "displayHeight": 792.0,
                "kinds": {
                    "text": { "count": 1, "bboxes": [[48.0, 60.0, 200.0, 90.0]], "ids": ["o1"] },
                    "path": { "count": 2, "bboxes": [[60.0, 112.0, 240.0, 232.0], [60.0, 292.0, 240.0, 412.0]], "ids": ["o2", "o3"] }
                },
                "renderHint": {
                    "solo": true,
                    "showIds": ["o1"],
                    "hideIds": ["o2", "o3"]
                }
            }
        });
        let active = vec!["text".to_string()];
        let parsed = type_filter_from_reply(&reply, &active).unwrap();
        assert_eq!(parsed.page_index, 0);
        assert_eq!(parsed.counts.get("text"), Some(&1));
        assert_eq!(parsed.counts.get("path"), Some(&2));
        assert_eq!(parsed.show_count, 1);
        assert_eq!(parsed.hide_count, 2);
        assert_eq!(parsed.boxes.len(), 3);
        assert!(parsed.boxes[0].shown);
        assert!(!parsed.boxes[1].shown);
        assert!(!parsed.boxes[2].shown);
    }

    #[test]
    fn toggle_kind_keeps_canonical_order() {
        let s1 = toggle_kind(&[], "path");
        assert_eq!(s1, vec!["path"]);
        let s2 = toggle_kind(&s1, "text");
        assert_eq!(s2, vec!["text", "path"]);
        let s3 = toggle_kind(&s2, "path");
        assert_eq!(s3, vec!["text"]);
        let s4 = toggle_kind(&s3, "text");
        assert!(s4.is_empty());
    }

    #[test]
    fn rename_params_trims_and_rejects_empty() {
        assert!(rename_params("5:0", "   ").is_err());
        assert_eq!(
            rename_params("5:0", "  Brand Mark  ").unwrap(),
            serde_json::json!({ "layerId": "5:0", "name": "Brand Mark" })
        );
    }

    #[test]
    fn builds_layer_and_filter_param_payloads() {
        assert_eq!(
            set_visibility_params("5:0", false),
            serde_json::json!({ "layerIds": ["5:0"], "visible": false })
        );
        assert_eq!(
            remove_params("5:0", true),
            serde_json::json!({ "layerIds": ["5:0"], "deleteContent": true })
        );
        assert_eq!(flatten_params(), serde_json::json!({}));
        assert_eq!(
            view_by_type_params(1, &[]),
            serde_json::json!({ "pageIndex": 1 })
        );
        assert_eq!(
            view_by_type_params(0, &["text".into(), "image".into()]),
            serde_json::json!({ "pageIndex": 0, "kinds": ["text", "image"], "solo": true })
        );
    }
}
