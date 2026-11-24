//! Màn hình kiểm tra và sửa bố cục rã tài liệu (TASKS_RUST R5.53, R5.54; FEATURES N-review): port
//! `reviewModel.ts`. Mô hình tài liệu từ lõi (trang, khối, vùng), danh sách thay đổi người dùng (đổi loại
//! khối, sửa chữ), và hình chữ nhật vùng theo phần trăm trang cho khung đối chiếu. Logic thuần.
#![allow(dead_code)]

use serde_json::Value;

pub const TEXT_KINDS: [&str; 7] = [
    "heading",
    "paragraph",
    "header",
    "footer",
    "pageNumber",
    "footnote",
    "unknown",
];

/// Khối chữ của một trang (chỉ các trường màn hình kiểm tra dùng).
#[derive(Debug, Clone, PartialEq)]
pub struct Block {
    pub kind: String,
    pub runs: Vec<String>,
    /// [x0, y0, x1, y1] điểm, gốc trên trái.
    pub bbox: Vec<f64>,
    pub level: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Page {
    pub index: usize,
    pub width: f64,
    pub height: f64,
    pub blocks: Vec<Block>,
}

/// Đọc `DocumentModel` JSON của lõi; trang hoặc khối sai dạng bị bỏ.
pub fn read_pages(model: &Value) -> Vec<Page> {
    let Some(pages) = model.get("pages").and_then(Value::as_array) else {
        return Vec::new();
    };
    pages
        .iter()
        .enumerate()
        .map(|(i, p)| Page {
            index: p
                .get("index")
                .and_then(Value::as_u64)
                .map_or(i, |n| n as usize),
            width: p.get("width").and_then(Value::as_f64).unwrap_or(0.0),
            height: p.get("height").and_then(Value::as_f64).unwrap_or(0.0),
            blocks: p
                .get("blocks")
                .and_then(Value::as_array)
                .map(|bs| bs.iter().filter_map(read_block).collect())
                .unwrap_or_default(),
        })
        .collect()
}

fn read_block(b: &Value) -> Option<Block> {
    Some(Block {
        kind: b.get("kind")?.as_str()?.to_string(),
        runs: b
            .get("runs")
            .and_then(Value::as_array)
            .map(|r| {
                r.iter()
                    .filter_map(|x| x.get("text").and_then(Value::as_str).map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        bbox: b
            .get("bbox")?
            .as_array()?
            .iter()
            .filter_map(Value::as_f64)
            .collect(),
        level: b.get("level").and_then(Value::as_i64),
    })
}

/// Thay đổi của một khối.
#[derive(Debug, Clone, PartialEq)]
pub struct Change {
    pub page_index: usize,
    pub block_index: usize,
    pub kind: String,
    pub level: Option<i64>,
    pub text: Option<String>,
}

/// Chữ của khối: nối các run.
pub fn text_of(b: &Block) -> String {
    b.runs.concat()
}

#[derive(Debug, Clone, PartialEq)]
pub struct ReviewedBlock {
    pub kind: String,
    pub level: i64,
    pub text: String,
}

/// Khối sau khi áp thay đổi (nếu có): loại, cấp (mặc định 1) và chữ.
pub fn reviewed_block(
    b: &Block,
    changes: &[Change],
    page_index: usize,
    block_index: usize,
) -> ReviewedBlock {
    let change = changes
        .iter()
        .find(|c| c.page_index == page_index && c.block_index == block_index);
    ReviewedBlock {
        kind: change.map_or_else(|| b.kind.clone(), |c| c.kind.clone()),
        level: change.and_then(|c| c.level).or(b.level).unwrap_or(1),
        text: change
            .and_then(|c| c.text.clone())
            .unwrap_or_else(|| text_of(b)),
    }
}

/// Vùng của khối theo phần trăm trang (trái, trên, rộng, cao). None khi trang không có cỡ hoặc bbox thiếu.
pub fn region_style(page: &Page, b: &Block) -> Option<(f64, f64, f64, f64)> {
    if page.width == 0.0 || page.height == 0.0 || b.bbox.len() < 4 {
        return None;
    }
    let (x0, y0, x1, y1) = (b.bbox[0], b.bbox[1], b.bbox[2], b.bbox[3]);
    Some((
        100.0 * x0 / page.width,
        100.0 * y0 / page.height,
        100.0 * (x1 - x0) / page.width,
        100.0 * (y1 - y0) / page.height,
    ))
}

/// Ghi một thay đổi: thay thế thay đổi cũ của cùng khối, đặt mới ở cuối.
pub fn set_change(changes: &[Change], change: Change) -> Vec<Change> {
    let mut out: Vec<Change> = changes
        .iter()
        .filter(|c| c.page_index != change.page_index || c.block_index != change.block_index)
        .cloned()
        .collect();
    out.push(change);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn model() -> Value {
        json!({ "pages": [
            { "index": 0, "width": 600, "height": 800, "blocks": [
                { "kind": "heading", "level": 2, "bbox": [60, 80, 300, 120], "runs": [{ "text": "Tiêu " }, { "text": "đề" }] },
                { "kind": "paragraph", "bbox": [60, 200, 540, 400] },
                { "bbox": [1, 2, 3, 4] },
            ] },
            { "index": 1, "width": 0, "height": 0, "blocks": [] },
        ] })
    }

    #[test]
    fn reads_pages_and_drops_malformed_blocks() {
        let pages = read_pages(&model());
        assert_eq!(pages.len(), 2);
        assert_eq!(pages[0].blocks.len(), 2, "khối thiếu kind bị bỏ");
        assert_eq!(text_of(&pages[0].blocks[0]), "Tiêu đề");
        assert_eq!(text_of(&pages[0].blocks[1]), "");
        assert!(read_pages(&json!({})).is_empty());
    }

    #[test]
    fn reviewed_block_applies_change_over_original() {
        let pages = read_pages(&model());
        let b = &pages[0].blocks[0];
        let none = reviewed_block(b, &[], 0, 0);
        assert_eq!(
            (none.kind.as_str(), none.level, none.text.as_str()),
            ("heading", 2, "Tiêu đề")
        );
        assert_eq!(
            reviewed_block(&pages[0].blocks[1], &[], 0, 1).level,
            1,
            "cấp mặc định là 1"
        );
        let c = Change {
            page_index: 0,
            block_index: 0,
            kind: "paragraph".into(),
            level: None,
            text: Some("Sửa".into()),
        };
        let r = reviewed_block(b, &[c], 0, 0);
        assert_eq!(
            (r.kind.as_str(), r.level, r.text.as_str()),
            ("paragraph", 2, "Sửa")
        );
        let other = Change {
            page_index: 0,
            block_index: 1,
            kind: "footer".into(),
            level: None,
            text: None,
        };
        assert_eq!(reviewed_block(b, &[other], 0, 0).kind, "heading");
    }

    #[test]
    fn region_is_percent_of_page() {
        let pages = read_pages(&model());
        let (l, t, w, h) = region_style(&pages[0], &pages[0].blocks[0]).unwrap();
        assert_eq!((l, w), (10.0, 40.0));
        assert!((t - 10.0).abs() < 1e-9 && (h - 5.0).abs() < 1e-9);
        let empty = Block {
            kind: "x".into(),
            runs: vec![],
            bbox: vec![1.0, 2.0],
            level: None,
        };
        assert_eq!(region_style(&pages[0], &empty), None);
        assert_eq!(region_style(&pages[1], &pages[0].blocks[0]), None);
    }

    #[test]
    fn set_change_replaces_same_block_and_appends() {
        let a = Change {
            page_index: 0,
            block_index: 0,
            kind: "heading".into(),
            level: Some(1),
            text: None,
        };
        let b = Change {
            page_index: 0,
            block_index: 1,
            kind: "footer".into(),
            level: None,
            text: None,
        };
        let list = set_change(&set_change(&[], a), b.clone());
        let a2 = Change {
            page_index: 0,
            block_index: 0,
            kind: "paragraph".into(),
            level: None,
            text: Some("x".into()),
        };
        let list = set_change(&list, a2.clone());
        assert_eq!(list, vec![b, a2], "thay đổi mới của khối đặt ở cuối");
    }

    #[test]
    fn kinds_are_the_seven_of_the_core() {
        assert_eq!(TEXT_KINDS.len(), 7);
        assert!(TEXT_KINDS.contains(&"pageNumber"));
    }
}
