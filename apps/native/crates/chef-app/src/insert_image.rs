//! R4.09 insert image placement: validation, proportional drag rect and wire params.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ImagePlacement {
    pub path: PathBuf,
    pub natural_size: Option<(u32, u32)>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ImageDrag {
    pub generation: u64,
    pub page_index: usize,
    pub start: [f32; 2],
    pub cur: [f32; 2],
}

pub fn is_supported_image(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| {
            let lower = ext.to_ascii_lowercase();
            matches!(lower.as_str(), "png" | "jpg" | "jpeg")
        })
}

pub fn load_placement(path: PathBuf) -> Result<ImagePlacement, String> {
    if !is_supported_image(&path) {
        return Err("Only PNG and JPEG images are supported.".to_string());
    }
    let natural_size = image::image_dimensions(&path).ok();
    Ok(ImagePlacement { path, natural_size })
}

/// Normalize start/cur into `[x0, y0, x1, y1]`, fitting `natural_size` proportionally inside
/// the dragged rectangle when dimensions are known.
pub fn normalized_rect(
    start: [f32; 2],
    cur: [f32; 2],
    natural_size: Option<(u32, u32)>,
) -> [f32; 4] {
    let x0 = start[0].min(cur[0]);
    let y0 = start[1].min(cur[1]);
    let x1 = start[0].max(cur[0]);
    let y1 = start[1].max(cur[1]);
    let box_w = x1 - x0;
    let box_h = y1 - y0;
    if let Some((nw, nh)) = natural_size
        && nw > 0
        && nh > 0
        && box_w > 0.0
        && box_h > 0.0
    {
        let ratio = nw as f32 / nh as f32;
        if box_w / box_h > ratio {
            return [x0, y0, x0 + box_h * ratio, y0 + box_h];
        } else {
            return [x0, y0, x0 + box_w, y0 + box_w / ratio];
        }
    }
    [x0, y0, x1, y1]
}

pub fn add_image_params(page_index: usize, rect: [f32; 4], path: &Path) -> Result<Value, String> {
    if !is_supported_image(path) {
        return Err("Only PNG and JPEG images are supported.".to_string());
    }
    let path_str = path
        .to_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Invalid image file path.".to_string())?;
    if rect.iter().any(|v| !v.is_finite()) {
        return Err("The image rectangle is invalid.".to_string());
    }
    let w = rect[2] - rect[0];
    let h = rect[3] - rect[1];
    if w < 4.0 || h < 4.0 {
        return Err("Drag a larger rectangle (at least 4 pt) to place the image.".to_string());
    }
    Ok(json!({
        "pages": [page_index],
        "path": path_str,
        "x": rect[0],
        "y": rect[1],
        "width": w,
        "height": h,
        "unit": "pt",
        "anchor": "top-left",
        "under": false,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_natural_aspect_ratio_and_builds_params() {
        let rect = normalized_rect([100.0, 50.0], [300.0, 250.0], Some((200, 100)));
        assert_eq!(rect, [100.0, 50.0, 300.0, 150.0]);
        let rev = normalized_rect([300.0, 250.0], [100.0, 50.0], Some((100, 200)));
        assert_eq!(rev, [100.0, 50.0, 200.0, 250.0]);

        let params = add_image_params(0, rect, Path::new("C:/tmp/photo.png")).unwrap();
        assert_eq!(params["pages"][0], 0);
        assert_eq!(params["width"], 200.0);
        assert_eq!(params["height"], 100.0);
        assert_eq!(params["unit"], "pt");
    }

    #[test]
    fn rejects_bad_extension_or_tiny_rect_and_allows_page_overflow() {
        assert!(load_placement(PathBuf::from("photo.gif")).is_err());
        assert!(add_image_params(0, [10.0, 10.0, 12.0, 20.0], Path::new("a.jpg")).is_err());
        let overflow =
            add_image_params(0, [550.0, 720.0, 700.0, 820.0], Path::new("a.JPEG")).unwrap();
        assert_eq!(overflow["x"], 550.0);
        assert_eq!(overflow["width"], 150.0);
    }
}
