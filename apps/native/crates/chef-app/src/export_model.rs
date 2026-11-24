//! Xuất định dạng khác và màn hình kiểm tra bố cục (TASKS_RUST R5.53–R5.56; FEATURES N): port
//! `exportModel.ts` và `layout/reviewModel.ts`. Tên file ra, tham số `export.document`, khối bố cục
//! đã rã, thay đổi của người dùng (loại khối, cấp tiêu đề, chữ) và hộp vùng theo phần trăm. Logic thuần.
#![allow(dead_code)]

use serde_json::{Value, json};

pub const FORMATS: [&str; 9] = [
    "docx", "md", "html", "txt", "json", "epub", "odt", "xlsx", "pdf",
];

/// Tên file ra: tên tài liệu bỏ đuôi `.pdf`; "pdf" (làm mới) thêm `_lam-moi`.
pub fn output_name(name: &str, format: &str) -> String {
    let lower = name.to_lowercase();
    let stem = if lower.ends_with(".pdf") {
        &name[..name.len() - 4]
    } else {
        name
    };
    let stem = if stem.is_empty() { "document" } else { stem };
    format!(
        "{stem}{}.{format}",
        if format == "pdf" { "_lam-moi" } else { "" }
    )
}

/// `export.document`. Hộp thoại lưu của hệ điều hành đã hỏi trước khi thay file có sẵn.
pub fn export_params(
    format: &str,
    output_path: &str,
    pages: &[usize],
    editable: bool,
    include_images: bool,
) -> Value {
    json!({"format": format, "outputPath": output_path, "replaceExisting": true, "pages": pages,
        "options": {"mode": if editable { "editable" } else { "layout" }, "includeImages": include_images}})
}

pub const TEXT_KINDS: [&str; 7] = [
    "heading",
    "paragraph",
    "header",
    "footer",
    "pageNumber",
    "footnote",
    "unknown",
];

#[derive(Debug, Clone, PartialEq)]
pub struct Block {
    pub kind: String,
    pub runs: Vec<String>,
    pub bbox: Vec<f64>,
    pub level: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    pub index: usize,
    pub width: f64,
    pub height: f64,
    pub blocks: Vec<Block>,
}

/// Đọc `pages` của mô hình tài liệu; mục hỏng bị bỏ.
pub fn read_pages(model: &Value) -> Vec<Page> {
    model
        .get("pages")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|p| {
            Some(Page {
                index: p.get("index")?.as_u64()? as usize,
                width: p.get("width").and_then(Value::as_f64).unwrap_or(0.0),
                height: p.get("height").and_then(Value::as_f64).unwrap_or(0.0),
                blocks: p
                    .get("blocks")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|b| {
                                Some(Block {
                                    kind: b.get("kind")?.as_str()?.to_string(),
                                    runs: b
                                        .get("runs")
                                        .and_then(Value::as_array)
                                        .map(|r| {
                                            r.iter()
                                                .filter_map(|x| {
                                                    x.get("text")?.as_str().map(String::from)
                                                })
                                                .collect()
                                        })
                                        .unwrap_or_default(),
                                    bbox: b
                                        .get("bbox")
                                        .and_then(Value::as_array)
                                        .map(|a| a.iter().filter_map(Value::as_f64).collect())
                                        .unwrap_or_default(),
                                    level: b.get("level").and_then(Value::as_u64),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect()
}

pub fn text_of(b: &Block) -> String {
    b.runs.concat()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Change {
    pub page_index: usize,
    pub block_index: usize,
    pub kind: String,
    pub level: Option<u64>,
    pub text: Option<String>,
}

/// Khối sau khi áp thay đổi của người dùng: (loại, cấp, chữ).
pub fn reviewed_block(
    block: &Block,
    changes: &[Change],
    page_index: usize,
    block_index: usize,
) -> (String, u64, String) {
    let c = changes
        .iter()
        .find(|c| c.page_index == page_index && c.block_index == block_index);
    (
        c.map_or_else(|| block.kind.clone(), |c| c.kind.clone()),
        c.and_then(|c| c.level).or(block.level).unwrap_or(1),
        c.and_then(|c| c.text.clone())
            .unwrap_or_else(|| text_of(block)),
    )
}

/// Hộp vùng theo phần trăm trang: (trái, trên, rộng, cao); None khi trang hoặc hộp thiếu số đo.
pub fn region_style(page: &Page, block: &Block) -> Option<(f64, f64, f64, f64)> {
    let [x0, y0, x1, y1] = <[f64; 4]>::try_from(block.bbox.get(..4)?).ok()?;
    (page.width != 0.0 && page.height != 0.0).then(|| {
        (
            100.0 * x0 / page.width,
            100.0 * y0 / page.height,
            100.0 * (x1 - x0) / page.width,
            100.0 * (y1 - y0) / page.height,
        )
    })
}

/// Ghi một thay đổi, thay thay đổi cũ của cùng khối (khối đã sửa đi xuống cuối danh sách).
pub fn set_change(changes: &[Change], change: Change) -> Vec<Change> {
    let mut v: Vec<Change> = changes
        .iter()
        .filter(|c| c.page_index != change.page_index || c.block_index != change.block_index)
        .cloned()
        .collect();
    v.push(change);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_params() {
        assert_eq!(output_name("Hợp đồng.PDF", "docx"), "Hợp đồng.docx");
        assert_eq!(output_name("Hợp đồng.pdf", "pdf"), "Hợp đồng_lam-moi.pdf");
        assert_eq!(output_name(".pdf", "md"), "document.md");
        assert_eq!(output_name("ghi chu", "txt"), "ghi chu.txt");
        let v = export_params("docx", "/o.docx", &[0, 2], true, false);
        assert_eq!(
            (
                v["options"]["mode"].as_str(),
                v["options"]["includeImages"].as_bool(),
                v["replaceExisting"].as_bool(),
                &v["pages"]
            ),
            (Some("editable"), Some(false), Some(true), &json!([0, 2]))
        );
        assert_eq!(
            export_params("md", "/o", &[], false, true)["options"]["mode"],
            "layout"
        );
        assert_eq!((FORMATS.len(), TEXT_KINDS.len()), (9, 7));
    }

    fn model() -> Vec<Page> {
        read_pages(&json!({"pages":[
            {"index":0,"width":200,"height":400,"blocks":[
                {"kind":"heading","level":2,"runs":[{"text":"Chương "},{"text":"1"}],"bbox":[20,40,100,80]},
                {"kind":"paragraph","bbox":[0,0,10]}, {"nokind":1}]},
            {"index":1,"width":0,"height":0,"blocks":[]}, {"width":1}]}))
    }

    #[test]
    fn reads_blocks_and_applies_changes() {
        let pages = model();
        assert_eq!((pages.len(), pages[0].blocks.len()), (2, 2));
        let b = &pages[0].blocks[0];
        assert_eq!(text_of(b), "Chương 1");
        assert_eq!(
            reviewed_block(b, &[], 0, 0),
            ("heading".into(), 2, "Chương 1".into())
        );
        assert_eq!(
            reviewed_block(&pages[0].blocks[1], &[], 0, 1),
            ("paragraph".into(), 1, String::new())
        );
        let ch = Change {
            page_index: 0,
            block_index: 0,
            kind: "paragraph".into(),
            level: None,
            text: Some("Sửa".into()),
        };
        assert_eq!(
            reviewed_block(b, std::slice::from_ref(&ch), 0, 0),
            ("paragraph".into(), 2, "Sửa".into()),
            "cấp lấy từ khối gốc nếu thay đổi không có"
        );
        assert_eq!(
            reviewed_block(b, std::slice::from_ref(&ch), 1, 0).0,
            "heading",
            "khác trang: không áp"
        );
    }

    #[test]
    fn region_and_changes() {
        let pages = model();
        assert_eq!(
            region_style(&pages[0], &pages[0].blocks[0]),
            Some((10.0, 10.0, 40.0, 10.0))
        );
        assert_eq!(
            region_style(&pages[0], &pages[0].blocks[1]),
            None,
            "hộp thiếu số"
        );
        assert_eq!(
            region_style(&pages[1], &pages[0].blocks[0]),
            None,
            "trang rộng 0"
        );
        let c = |b: usize, k: &str| Change {
            page_index: 0,
            block_index: b,
            kind: k.into(),
            level: None,
            text: None,
        };
        let v = set_change(&[c(0, "heading"), c(1, "footer")], c(0, "paragraph"));
        assert_eq!(
            v.iter()
                .map(|x| (x.block_index, x.kind.as_str()))
                .collect::<Vec<_>>(),
            [(1, "footer"), (0, "paragraph")]
        );
    }
}
