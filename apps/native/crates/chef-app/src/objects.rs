//! R4.11 page object selection: hit-test replies and edit parameters.

use serde_json::{Value, json};

/// A page object picked by a click, in the displayed frame (points, origin top-left).
#[derive(Clone, Debug, PartialEq)]
pub struct ObjectSel {
    pub page_index: usize,
    pub id: String,
    pub kind: String,
    pub bbox: [f32; 4],
    pub bbox_user: [f32; 4],
    pub page_rotation: u16,
}

impl ObjectSel {
    pub fn center(&self) -> [f32; 2] {
        [
            (self.bbox[0] + self.bbox[2]) / 2.0,
            (self.bbox[1] + self.bbox[3]) / 2.0,
        ]
    }
}

pub fn hit_params(page_index: usize, point: [f32; 2]) -> Value {
    json!({ "pageIndex": page_index, "x": point[0], "y": point[1], "unit": "pt", "includeForms": false })
}

fn parse_rect4(value: Option<&Value>) -> Option<[f32; 4]> {
    let rect = value.and_then(Value::as_array).filter(|r| r.len() == 4)?;
    let nums = rect.iter().map(Value::as_f64).collect::<Option<Vec<_>>>()?;
    Some([
        nums[0] as f32,
        nums[1] as f32,
        nums[2] as f32,
        nums[3] as f32,
    ])
}

/// The topmost object under the point, or `None` when the point is on empty page.
pub fn selection_from_reply(reply: &Value, page_index: usize) -> Result<Option<ObjectSel>, String> {
    let data = reply.get("data").unwrap_or(reply);
    let page_rotation = data
        .get("rotation")
        .and_then(Value::as_u64)
        .and_then(|r| u16::try_from(r).ok())
        .unwrap_or(0);
    let Some(object) = data.get("object").filter(|object| !object.is_null()) else {
        return Ok(None);
    };
    let bbox = parse_rect4(object.get("bbox"))
        .ok_or_else(|| "Core returned invalid object geometry".to_string())?;
    let bbox_user = parse_rect4(object.get("bboxUser")).unwrap_or(bbox);
    Ok(Some(ObjectSel {
        page_index,
        id: object
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "Core returned an object without an ID".to_string())?
            .to_owned(),
        kind: object
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        bbox,
        bbox_user,
        page_rotation,
    }))
}

pub fn delete_params(id: &str) -> Value {
    json!({ "ids": [id] })
}

/// Displacement in points of the displayed frame, y downwards.
pub fn move_params(id: &str, dx: f32, dy: f32) -> Value {
    json!({ "ids": [id], "dx": dx, "dy": dy })
}

pub fn transform_params(id: &str, matrix: [f64; 6]) -> Value {
    json!({ "ids": [id], "matrix": matrix })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Order {
    Front,
    Back,
}

pub fn reorder_params(id: &str, order: Order) -> Value {
    json!({ "ids": [id], "mode": match order { Order::Front => "front", Order::Back => "back" } })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_topmost_object_and_empty_hit() {
        let reply = json!({"data": {"object": {"id": "p0:ab:3", "kind": "image", "bbox": [10.0, 20.0, 110.0, 70.0]},
            "objects": []}});
        let sel = selection_from_reply(&reply, 0).unwrap().unwrap();
        assert_eq!(sel.id, "p0:ab:3");
        assert_eq!(sel.kind, "image");
        assert_eq!(sel.center(), [60.0, 45.0]);
        assert_eq!(
            selection_from_reply(&json!({"data": {"object": null}}), 0),
            Ok(None)
        );
        assert!(selection_from_reply(&json!({"data": {"object": {"id": "x"}}}), 0).is_err());
    }

    #[test]
    fn builds_edit_params() {
        assert_eq!(delete_params("a")["ids"][0], "a");
        let moved = move_params("a", 1.0, -2.0);
        assert_eq!(
            (moved["dx"].as_f64(), moved["dy"].as_f64()),
            (Some(1.0), Some(-2.0))
        );
        assert_eq!(reorder_params("a", Order::Front)["mode"], "front");
        assert_eq!(hit_params(2, [3.0, 4.0])["pageIndex"], 2);
        let tr = transform_params("a", [2.0, 0.0, 0.0, 2.0, 1.0, 3.0]);
        assert_eq!(tr["ids"][0], "a");
        assert_eq!(tr["matrix"][0], 2.0);
    }

    #[test]
    fn parses_bbox_user_and_page_rotation() {
        let reply = json!({
            "data": {
                "rotation": 90,
                "object": {
                    "id": "p1:ab:0",
                    "kind": "path",
                    "bbox": [10.0, 20.0, 110.0, 70.0],
                    "bboxUser": [20.0, 50.0, 70.0, 150.0]
                }
            }
        });
        let sel = selection_from_reply(&reply, 1).unwrap().unwrap();
        assert_eq!(sel.page_rotation, 90);
        assert_eq!(sel.bbox_user, [20.0, 50.0, 70.0, 150.0]);
    }
}
