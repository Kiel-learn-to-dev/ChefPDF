//! Chuyển đổi PDF ↔ ảnh (TASKS_RUST R5.12, R5.13, R5.14; FEATURES M2–M4): port `convertModel.ts`.
//! Form PDF sang ảnh, ảnh sang PDF, danh sách ảnh (thứ tự, thêm, tên file ra). Logic thuần.
#![allow(dead_code)]

use serde_json::{Value, json};

pub const DPI_MIN: i64 = 36;
pub const DPI_MAX: i64 = 600;
pub const MAX_NAME_TEMPLATE: usize = 120;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFormat {
    Png,
    Jpeg,
    Tiff,
    Webp,
}

impl ImageFormat {
    fn as_str(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpeg",
            Self::Tiff => "tiff",
            Self::Webp => "webp",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorMode {
    Color,
    Gray,
    Bw,
}

impl ColorMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Color => "color",
            Self::Gray => "gray",
            Self::Bw => "bw",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PdfToImagesForm {
    pub format: ImageFormat,
    pub dpi: i64,
    pub color: ColorMode,
    pub jpeg_quality: i64,
    pub multi_page_tiff: bool,
    pub output_dir: String,
    pub name_template: String,
}

impl Default for PdfToImagesForm {
    fn default() -> Self {
        Self {
            format: ImageFormat::Png,
            dpi: 150,
            color: ColorMode::Color,
            jpeg_quality: 90,
            multi_page_tiff: false,
            output_dir: String::new(),
            name_template: "{name}_{page}".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PdfToImagesIssue {
    OutputDir,
    Dpi,
    Quality,
    NameTemplate,
}

pub fn pdf_to_images_issues(f: &PdfToImagesForm) -> Vec<PdfToImagesIssue> {
    let mut v = Vec::new();
    if f.output_dir.is_empty() {
        v.push(PdfToImagesIssue::OutputDir);
    }
    if !(DPI_MIN..=DPI_MAX).contains(&f.dpi) {
        v.push(PdfToImagesIssue::Dpi);
    }
    if !(1..=100).contains(&f.jpeg_quality) {
        v.push(PdfToImagesIssue::Quality);
    }
    let t = f.name_template.trim();
    if t.is_empty()
        || t.chars().count() > MAX_NAME_TEMPLATE
        || t.contains(['\\', '/', ':', '*', '?', '"', '<', '>', '|'])
    {
        v.push(PdfToImagesIssue::NameTemplate);
    }
    v
}

/// Lõi đọc bản sửa hiện hành (rev-0000.pdf) nên sẽ lấy `{name}` từ file đó; điền sẵn tên tài liệu
/// thật ở đây, và đổi ngoặc nhọn trong tên để lõi không hiểu là biến.
fn with_doc_name(template: &str, doc_name: Option<&str>) -> String {
    let Some(doc) = doc_name.filter(|d| !d.is_empty()) else {
        return template.to_string();
    };
    let stem = if doc.to_lowercase().ends_with(".pdf") {
        &doc[..doc.len() - 4]
    } else {
        doc
    };
    template.replace("{name}", &stem.replace(['{', '}'], "_"))
}

pub struct Source<'a> {
    pub path: &'a str,
    pub password: Option<&'a str>,
    /// Chỉ số trang từ 0; rỗng là tất cả.
    pub pages: &'a [u64],
    pub doc_name: Option<&'a str>,
}

/// `convert.pdfToImages`. `jpegQuality` chỉ gửi cho JPEG và WebP.
pub fn pdf_to_images_params(f: &PdfToImagesForm, src: &Source) -> Value {
    let mut v = json!({
        "path": src.path,
        "format": f.format.as_str(),
        "dpi": f.dpi,
        "color": f.color.as_str(),
        "multiPageTiff": f.format == ImageFormat::Tiff && f.multi_page_tiff,
        "outputDir": f.output_dir,
        "nameTemplate": with_doc_name(f.name_template.trim(), src.doc_name),
    });
    if matches!(f.format, ImageFormat::Jpeg | ImageFormat::Webp) {
        v["jpegQuality"] = f.jpeg_quality.into();
    }
    if let Some(p) = src.password.filter(|p| !p.is_empty()) {
        v["password"] = p.into();
    }
    if !src.pages.is_empty() {
        v["pages"] = json!(src.pages);
    }
    v
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageSizeMode {
    FitImage,
    A4,
    Letter,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImagesToPdfForm {
    pub page_size: PageSizeMode,
    pub custom_width_mm: f64,
    pub custom_height_mm: f64,
    pub margin_mm: f64,
    /// "auto", "portrait", "landscape".
    pub orientation: &'static str,
    /// "fit", "fill", "center".
    pub fit: &'static str,
}

impl Default for ImagesToPdfForm {
    fn default() -> Self {
        Self {
            page_size: PageSizeMode::A4,
            custom_width_mm: 210.0,
            custom_height_mm: 297.0,
            margin_mm: 10.0,
            orientation: "auto",
            fit: "fit",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImagesToPdfIssue {
    Images,
    Output,
    Custom,
    Margin,
}

pub fn images_to_pdf_issues(
    f: &ImagesToPdfForm,
    images: &[String],
    output: &str,
) -> Vec<ImagesToPdfIssue> {
    let mut v = Vec::new();
    if images.is_empty() {
        v.push(ImagesToPdfIssue::Images);
    }
    if output.is_empty() {
        v.push(ImagesToPdfIssue::Output);
    }
    let ok = |n: f64| n.is_finite() && n > 0.0 && n <= 2000.0;
    if f.page_size == PageSizeMode::Custom && !(ok(f.custom_width_mm) && ok(f.custom_height_mm)) {
        v.push(ImagesToPdfIssue::Custom);
    }
    if !f.margin_mm.is_finite() || !(0.0..=100.0).contains(&f.margin_mm) {
        v.push(ImagesToPdfIssue::Margin);
    }
    v
}

/// `convert.imagesToPdf` (ảnh theo thứ tự đã cho).
pub fn images_to_pdf_params(f: &ImagesToPdfForm, images: &[String], output: &str) -> Value {
    let mut v = json!({
        "images": images, "outputPath": output,
        "pageSize": match f.page_size {
            PageSizeMode::FitImage => "fit-image",
            PageSizeMode::A4 => "a4",
            PageSizeMode::Letter => "letter",
            PageSizeMode::Custom => "custom",
        },
        "marginMm": f.margin_mm, "orientation": f.orientation, "fit": f.fit,
    });
    if f.page_size == PageSizeMode::Custom {
        v["customWidthMm"] = f.custom_width_mm.into();
        v["customHeightMm"] = f.custom_height_mm.into();
    }
    v
}

/// Chuyển mục `from` đến `to` (kẹp vào phạm vi); trả danh sách mới.
pub fn move_item<T: Clone>(list: &[T], from: usize, to: usize) -> Vec<T> {
    let mut v = list.to_vec();
    if from >= v.len() {
        return v;
    }
    let target = to.min(v.len() - 1);
    let item = v.remove(from);
    v.insert(target, item);
    v
}

/// Trình chuyển nhận ảnh PNG và JPEG.
pub fn is_image_path(p: &str) -> bool {
    let l = p.to_lowercase();
    l.ends_with(".png") || l.ends_with(".jpg") || l.ends_with(".jpeg")
}

/// Thêm đường dẫn chưa có, giữ thứ tự, chỉ nhận ảnh.
pub fn add_images(list: &[String], paths: &[&str]) -> Vec<String> {
    let mut v = list.to_vec();
    for p in paths {
        if is_image_path(p) && !v.iter().any(|x| x == p) {
            v.push((*p).to_string());
        }
    }
    v
}

/// Tên PDF ra: tên file ảnh đầu tiên bỏ đuôi.
pub fn default_pdf_name(images: &[String]) -> String {
    let Some(first) = images.first() else {
        return "images.pdf".into();
    };
    let base = first.rsplit(['\\', '/']).next().unwrap_or("images");
    let stem = base.rfind('.').map_or(base, |i| &base[..i]);
    format!("{}.pdf", if stem.is_empty() { "images" } else { stem })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdf_to_images_params_by_format() {
        let src = Source {
            path: "/in/rev-0000.pdf",
            password: Some("pw"),
            pages: &[0, 2],
            doc_name: Some("Hop {dong}.PDF"),
        };
        let png = pdf_to_images_params(
            &PdfToImagesForm {
                output_dir: "/out".into(),
                ..Default::default()
            },
            &src,
        );
        assert!(png.get("jpegQuality").is_none());
        assert_eq!(
            (
                png["format"].as_str(),
                png["password"].as_str(),
                &png["pages"]
            ),
            (Some("png"), Some("pw"), &json!([0, 2]))
        );
        assert_eq!(png["nameTemplate"], "Hop _dong__{page}");
        let jpg = pdf_to_images_params(
            &PdfToImagesForm {
                format: ImageFormat::Jpeg,
                jpeg_quality: 70,
                output_dir: "/o".into(),
                ..Default::default()
            },
            &Source {
                pages: &[],
                password: None,
                doc_name: None,
                ..src
            },
        );
        assert_eq!(
            (
                jpg["jpegQuality"].as_i64(),
                jpg.get("pages"),
                jpg.get("password")
            ),
            (Some(70), None, None)
        );
        assert_eq!(jpg["nameTemplate"], "{name}_{page}");
        let tiff = pdf_to_images_params(
            &PdfToImagesForm {
                format: ImageFormat::Tiff,
                multi_page_tiff: true,
                ..Default::default()
            },
            &Source {
                pages: &[],
                password: None,
                doc_name: None,
                path: "/p",
            },
        );
        assert_eq!(tiff["multiPageTiff"], true);
        let png2 = pdf_to_images_params(
            &PdfToImagesForm {
                multi_page_tiff: true,
                ..Default::default()
            },
            &Source {
                pages: &[],
                password: None,
                doc_name: None,
                path: "/p",
            },
        );
        assert_eq!(png2["multiPageTiff"], false);
    }

    #[test]
    fn pdf_to_images_validation() {
        let ok = PdfToImagesForm {
            output_dir: "/o".into(),
            ..Default::default()
        };
        assert!(pdf_to_images_issues(&ok).is_empty());
        let bad = PdfToImagesForm {
            output_dir: String::new(),
            dpi: 601,
            jpeg_quality: 0,
            name_template: "a/b".into(),
            ..Default::default()
        };
        assert_eq!(
            pdf_to_images_issues(&bad),
            [
                PdfToImagesIssue::OutputDir,
                PdfToImagesIssue::Dpi,
                PdfToImagesIssue::Quality,
                PdfToImagesIssue::NameTemplate
            ]
        );
    }

    #[test]
    fn images_to_pdf() {
        let imgs = vec!["/a/b.png".to_string()];
        let f = ImagesToPdfForm::default();
        assert!(images_to_pdf_issues(&f, &imgs, "/o.pdf").is_empty());
        assert_eq!(
            images_to_pdf_issues(&f, &[], ""),
            [ImagesToPdfIssue::Images, ImagesToPdfIssue::Output]
        );
        let c = ImagesToPdfForm {
            page_size: PageSizeMode::Custom,
            custom_width_mm: 0.0,
            margin_mm: 101.0,
            ..f
        };
        assert_eq!(
            images_to_pdf_issues(&c, &imgs, "/o"),
            [ImagesToPdfIssue::Custom, ImagesToPdfIssue::Margin]
        );
        let v = images_to_pdf_params(&f, &imgs, "/o.pdf");
        assert_eq!(
            (v["pageSize"].as_str(), v.get("customWidthMm")),
            (Some("a4"), None)
        );
        let c = ImagesToPdfForm {
            page_size: PageSizeMode::Custom,
            ..f
        };
        assert_eq!(
            images_to_pdf_params(&c, &imgs, "/o")["customHeightMm"],
            297.0
        );
        assert_eq!(
            images_to_pdf_params(
                &ImagesToPdfForm {
                    page_size: PageSizeMode::FitImage,
                    ..f
                },
                &imgs,
                "/o"
            )["pageSize"],
            "fit-image"
        );
    }

    #[test]
    fn image_list_helpers() {
        let l = add_images(
            &["/a.png".into()],
            &["/a.png", "/b.JPG", "/c.pdf", "/d.jpeg", "/b.JPG"],
        );
        assert_eq!(l, ["/a.png", "/b.JPG", "/d.jpeg"]);
        assert_eq!(move_item(&l, 2, 0), ["/d.jpeg", "/a.png", "/b.JPG"]);
        assert_eq!(move_item(&l, 0, 99), ["/b.JPG", "/d.jpeg", "/a.png"]);
        assert_eq!(move_item(&l, 9, 0), l);
        assert_eq!(
            default_pdf_name(&["C:\\x\\scan.01.png".into()]),
            "scan.01.pdf"
        );
        assert_eq!(default_pdf_name(&[]), "images.pdf");
        assert_eq!(default_pdf_name(&["/x/.png".into()]), "images.pdf");
    }
}
