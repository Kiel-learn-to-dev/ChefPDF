//! Thuộc tính tài liệu lấy từ pdfium (TASKS_RUST R2.27): phiên bản PDF, số trang, khổ trang đầu, và
//! thông tin mô tả (metadata). Phần font, chữ ký và mã hóa lấy từ lõi (M3), chưa có ở đây.

use pdfium_render::prelude::{PdfDocument, PdfDocumentMetadataTagType};

/// Các thẻ metadata hiển thị, theo thứ tự của bản Electron (PropertiesDialog.tsx).
pub const META_TAGS: [(&str, PdfDocumentMetadataTagType); 8] = [
    ("Title", PdfDocumentMetadataTagType::Title),
    ("Author", PdfDocumentMetadataTagType::Author),
    ("Subject", PdfDocumentMetadataTagType::Subject),
    ("Keywords", PdfDocumentMetadataTagType::Keywords),
    ("Creator", PdfDocumentMetadataTagType::Creator),
    ("Producer", PdfDocumentMetadataTagType::Producer),
    ("CreationDate", PdfDocumentMetadataTagType::CreationDate),
    ("ModDate", PdfDocumentMetadataTagType::ModificationDate),
];

#[derive(Debug, Clone, Default, PartialEq)]
pub struct DocProps {
    /// Phiên bản PDF dạng "1.7", hoặc "" khi không xác định.
    pub version: String,
    pub page_count: usize,
    /// Khổ của trang đầu, pt (1/72 inch).
    pub first_page_pt: (f32, f32),
    /// Giá trị từng thẻ, theo thứ tự của [`META_TAGS`]; thẻ không có là chuỗi rỗng.
    pub metadata: Vec<(&'static str, String)>,
}

/// Đọc thuộc tính của tài liệu đang mở. Lỗi khi đọc một trang không làm hỏng các phần còn lại.
pub fn read(doc: &PdfDocument) -> DocProps {
    let version = version_label(&format!("{:?}", doc.version()));
    let page_count = doc.pages().len() as usize;
    let first_page_pt = doc
        .pages()
        .get(0)
        .map(|p| (p.width().value, p.height().value))
        .unwrap_or((0.0, 0.0));
    let metadata = META_TAGS
        .iter()
        .map(|(key, tag)| {
            let value = doc
                .metadata()
                .get(*tag)
                .map(|t| t.value().to_string())
                .unwrap_or_default();
            (*key, value)
        })
        .collect();
    DocProps {
        version,
        page_count,
        first_page_pt,
        metadata,
    }
}

/// "Pdf1_7" (tên enum của pdfium-render) thành "1.7". "Unset" thành "".
pub fn version_label(debug_name: &str) -> String {
    match debug_name.strip_prefix("Pdf") {
        Some(rest) => rest.replace('_', "."),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_names_become_dotted_numbers() {
        assert_eq!(version_label("Pdf1_7"), "1.7");
        assert_eq!(version_label("Pdf2_0"), "2.0");
        assert_eq!(version_label("Unset"), "");
    }

    #[test]
    fn metadata_order_matches_the_electron_dialog() {
        let keys: Vec<&str> = META_TAGS.iter().map(|(k, _)| *k).collect();
        assert_eq!(
            keys,
            [
                "Title",
                "Author",
                "Subject",
                "Keywords",
                "Creator",
                "Producer",
                "CreationDate",
                "ModDate"
            ]
        );
    }
}
