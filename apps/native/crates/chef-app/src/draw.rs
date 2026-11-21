//! Drawing tool state and wire helpers for R4.19.

use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Tool {
    Rectangle,
    Line,
    Arrow,
    Ellipse,
    Pen,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Gesture {
    pub generation: u64,
    pub page_index: usize,
    pub start: [f32; 2],
    pub end: [f32; 2],
    pub points: Vec<[f32; 2]>,
}

impl Gesture {
    pub fn rect(&self) -> [f32; 4] {
        [
            self.start[0].min(self.end[0]),
            self.start[1].min(self.end[1]),
            self.start[0].max(self.end[0]),
            self.start[1].max(self.end[1]),
        ]
    }

    pub fn drag_distance(&self) -> f32 {
        if self.points.len() > 1 {
            return self
                .points
                .windows(2)
                .map(|pair| distance(pair[0], pair[1]))
                .sum();
        }
        let dx = self.end[0] - self.start[0];
        let dy = self.end[1] - self.start[1];
        (dx * dx + dy * dy).sqrt()
    }
}

pub fn distance(a: [f32; 2], b: [f32; 2]) -> f32 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    (dx * dx + dy * dy).sqrt()
}

pub fn rectangle_params(
    page_index: usize,
    rect: [f32; 4],
    color: &str,
    width: f32,
) -> Result<Value, String> {
    if rect.iter().any(|value| !value.is_finite())
        || rect[0] < 0.0
        || rect[1] < 0.0
        || rect[2] <= rect[0]
        || rect[3] <= rect[1]
    {
        return Err("The rectangle geometry is invalid".into());
    }
    if color.len() != 7
        || !color.starts_with('#')
        || !color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("The drawing color is invalid".into());
    }
    if !width.is_finite() || width <= 0.0 || width > 40.0 {
        return Err("The drawing width is invalid".into());
    }
    Ok(json!({
        "pageIndex": page_index,
        "kind": "rect",
        "rect": rect,
        "color": color,
        "width": width,
    }))
}

pub fn operation_params(
    tool: Tool,
    page_index: usize,
    gesture: &Gesture,
    color: &str,
    width: f32,
) -> Result<(&'static str, Value), String> {
    match tool {
        Tool::Rectangle | Tool::Ellipse => {
            let kind = if tool == Tool::Rectangle {
                "rect"
            } else {
                "ellipse"
            };
            let params = rectangle_params(page_index, gesture.rect(), color, width)?;
            let mut params = params;
            params["kind"] = json!(kind);
            Ok(("annots.addShape", params))
        }
        Tool::Line | Tool::Arrow => {
            validate_style(color, width)?;
            let [x1, y1] = gesture.start;
            let [x2, y2] = gesture.end;
            if [x1, y1, x2, y2].iter().any(|v| !v.is_finite())
                || x1 < 0.0
                || y1 < 0.0
                || x2 < 0.0
                || y2 < 0.0
            {
                return Err("The drawing geometry is invalid".into());
            }
            Ok((
                "annots.addShape",
                json!({
                    "pageIndex": page_index,
                    "kind": if tool == Tool::Arrow { "arrow" } else { "line" },
                    "points": [x1, y1, x2, y2],
                    "color": color,
                    "width": width,
                }),
            ))
        }
        Tool::Pen => {
            validate_style(color, width)?;
            if gesture.points.len() < 2
                || gesture
                    .points
                    .iter()
                    .flatten()
                    .any(|v| !v.is_finite() || *v < 0.0)
            {
                return Err("The pen stroke needs at least two valid points".into());
            }
            Ok((
                "annots.addInk",
                json!({
                    "pageIndex": page_index,
                    "strokes": [gesture.points],
                    "color": color,
                    "width": width,
                    "opacity": 1.0,
                }),
            ))
        }
    }
}

fn validate_style(color: &str, width: f32) -> Result<(), String> {
    if color.len() != 7
        || !color.starts_with('#')
        || !color[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("The drawing color is invalid".into());
    }
    if !width.is_finite() || width <= 0.0 || width > 40.0 {
        return Err("The drawing width is invalid".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gesture_normalizes_reverse_drag_and_tracks_size() {
        let gesture = Gesture {
            generation: 8,
            page_index: 2,
            start: [80.0, 90.0],
            end: [20.0, 30.0],
            points: vec![[80.0, 90.0], [20.0, 30.0]],
        };
        assert_eq!(gesture.rect(), [20.0, 30.0, 80.0, 90.0]);
        assert!((gesture.drag_distance() - 84.85281).abs() < 0.001);
    }

    #[test]
    fn rectangle_params_preserve_display_geometry_and_style() {
        let params = rectangle_params(3, [10.0, 20.0, 70.0, 90.0], "#12ABef", 2.5).unwrap();
        assert_eq!(params["pageIndex"], 3);
        assert_eq!(params["kind"], "rect");
        assert_eq!(params["rect"], json!([10.0, 20.0, 70.0, 90.0]));
        assert_eq!(params["color"], "#12ABef");
        assert_eq!(params["width"], 2.5);
    }

    #[test]
    fn rejects_invalid_rectangle_geometry_and_style() {
        assert!(rectangle_params(0, [2.0, 2.0, 1.0, 4.0], "#000000", 2.0).is_err());
        assert!(rectangle_params(0, [1.0, 2.0, f32::NAN, 4.0], "#000000", 2.0).is_err());
        assert!(rectangle_params(0, [1.0, 2.0, 3.0, 4.0], "red", 2.0).is_err());
        assert!(rectangle_params(0, [1.0, 2.0, 3.0, 4.0], "#000000", 41.0).is_err());
    }

    #[test]
    fn shape_tools_use_shape_operation_and_pen_uses_ink_operation() {
        let gesture = Gesture {
            generation: 1,
            page_index: 0,
            start: [10.0, 20.0],
            end: [50.0, 60.0],
            points: vec![[10.0, 20.0], [30.0, 40.0], [50.0, 60.0]],
        };
        let (shape_op, ellipse) =
            operation_params(Tool::Ellipse, 0, &gesture, "#123456", 3.0).unwrap();
        assert_eq!(shape_op, "annots.addShape");
        assert_eq!(ellipse["kind"], "ellipse");
        let (line_op, arrow) = operation_params(Tool::Arrow, 0, &gesture, "#123456", 3.0).unwrap();
        assert_eq!(line_op, "annots.addShape");
        assert_eq!(arrow["kind"], "arrow");
        let (pen_op, pen) = operation_params(Tool::Pen, 0, &gesture, "#123456", 3.0).unwrap();
        assert_eq!(pen_op, "annots.addInk");
        assert_eq!(pen["strokes"][0].as_array().unwrap().len(), 3);
    }
}
