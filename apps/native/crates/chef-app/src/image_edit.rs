//! R4.14 in-PDF image replacement and pixel adjustment parameters.

use std::path::Path;

use serde_json::{Value, json};

use crate::insert_image::is_supported_image;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageFit {
    Contain,
    Cover,
    Stretch,
}

impl ImageFit {
    pub fn as_str(self) -> &'static str {
        match self {
            ImageFit::Contain => "contain",
            ImageFit::Cover => "cover",
            ImageFit::Stretch => "stretch",
        }
    }

    #[allow(dead_code)]
    pub fn cycle(self) -> Self {
        match self {
            ImageFit::Contain => ImageFit::Cover,
            ImageFit::Cover => ImageFit::Stretch,
            ImageFit::Stretch => ImageFit::Contain,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AdjustState {
    pub brightness: i32,
    pub contrast: i32,
    pub rotate: u16,
    pub flip: &'static str,
    pub grayscale: bool,
    pub invert: bool,
    pub crop: Option<[u32; 4]>,
}

impl Default for AdjustState {
    fn default() -> Self {
        Self {
            brightness: 0,
            contrast: 0,
            rotate: 0,
            flip: "none",
            grayscale: false,
            invert: false,
            crop: None,
        }
    }
}

impl AdjustState {
    pub fn is_identity(&self) -> bool {
        self.brightness == 0
            && self.contrast == 0
            && self.rotate == 0
            && self.flip == "none"
            && !self.grayscale
            && !self.invert
            && self.crop.is_none()
    }
}

pub fn parse_crop(input: &str) -> Result<Option<[u32; 4]>, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let parts: Vec<&str> = trimmed.split(',').map(str::trim).collect();
    if parts.len() != 4 {
        return Err("Crop must be x,y,width,height in pixels.".to_string());
    }
    let nums: Vec<u32> = parts
        .into_iter()
        .map(|part| {
            part.parse::<u32>()
                .map_err(|_| "Crop values must be non-negative integers.".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if nums[2] == 0 || nums[3] == 0 {
        return Err("Crop width and height must be positive.".to_string());
    }
    Ok(Some([nums[0], nums[1], nums[2], nums[3]]))
}

pub fn replace_image_params(
    page_index: usize,
    object_id: &str,
    path: &Path,
    fit: ImageFit,
) -> Result<Value, String> {
    if object_id.is_empty() {
        return Err("The selected image ID is invalid.".to_string());
    }
    if !is_supported_image(path) {
        return Err("Only PNG and JPEG images are supported.".to_string());
    }
    let path_str = path
        .to_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Invalid image file path.".to_string())?;
    Ok(json!({
        "pageIndex": page_index,
        "objectId": object_id,
        "path": path_str,
        "fit": fit.as_str(),
        "keepAspectBox": fit != ImageFit::Stretch,
    }))
}

pub fn adjust_image_params(
    page_index: usize,
    object_id: &str,
    adj: &AdjustState,
) -> Result<Value, String> {
    if object_id.is_empty() {
        return Err("The selected image ID is invalid.".to_string());
    }
    if adj.is_identity() {
        return Err("Choose at least one image adjustment to apply.".to_string());
    }
    let mut params = json!({
        "pageIndex": page_index,
        "objectId": object_id,
        "rotate": adj.rotate,
        "flip": adj.flip,
        "grayscale": adj.grayscale,
        "invert": adj.invert,
        "brightness": adj.brightness.clamp(-100, 100),
        "contrast": adj.contrast.clamp(-100, 100),
    });
    if let Some([x, y, w, h]) = adj.crop {
        params["crop"] = json!({ "x": x, "y": y, "w": w, "h": h });
    }
    Ok(params)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_crop_and_rejects_invalid_inputs() {
        assert_eq!(parse_crop("  ").unwrap(), None);
        assert_eq!(
            parse_crop("10, 20, 40, 30").unwrap(),
            Some([10, 20, 40, 30])
        );
        assert!(parse_crop("10,20,0,30").is_err());
        assert!(parse_crop("10,20").is_err());
        assert!(parse_crop("-1,0,10,10").is_err());
    }

    #[test]
    fn builds_replace_and_adjust_params() {
        let rep = replace_image_params(0, "p0:ab:1", Path::new("C:/x/new.jpg"), ImageFit::Contain)
            .unwrap();
        assert_eq!(rep["fit"], "contain");
        assert_eq!(rep["keepAspectBox"], true);
        let stretch =
            replace_image_params(0, "p0:ab:1", Path::new("C:/x/new.png"), ImageFit::Stretch)
                .unwrap();
        assert_eq!(stretch["keepAspectBox"], false);
        assert!(
            replace_image_params(0, "p0:ab:1", Path::new("C:/x/new.bmp"), ImageFit::Contain)
                .is_err()
        );

        let idle = AdjustState::default();
        assert!(adjust_image_params(0, "p0:ab:1", &idle).is_err());
        let adj = AdjustState {
            brightness: 50,
            rotate: 90,
            crop: Some([0, 0, 40, 40]),
            ..Default::default()
        };
        let params = adjust_image_params(0, "p0:ab:1", &adj).unwrap();
        assert_eq!(params["brightness"], 50);
        assert_eq!(params["rotate"], 90);
        assert_eq!(params["crop"]["w"], 40);
    }
}
