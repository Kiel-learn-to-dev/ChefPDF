//! Sửa đối tượng trên trang (TASKS_RUST R4.12–R4.15, R7.11; FEATURES D4): port `objectModel.ts`. Danh
//! sách đối tượng của lõi (`content.listObjects`), chọn theo thứ tự vẽ, đổi px ↔ pt và tham số các
//! thao tác `content.*`. Bổ sung cho `objects.rs` (chọn bằng điểm qua lõi). Logic thuần.
//!
//! Tọa độ: lõi báo `bbox` là [x0, y0, x1, y1] theo PT của trang đang HIỂN THỊ, gốc trên-trái (y đi
//! xuống). Trình xem vẽ trang với `scale` px mỗi pt nên điểm (x, y) nằm ở (x·scale, y·scale) trong ảnh
//! trang. Chỉ hỗ trợ xoay 0 (khi khung nhìn đang xoay thì lớp đối tượng từ chối sửa).
#![allow(dead_code)]

use serde_json::{Map, Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectKind {
    Text,
    Image,
    Path,
    Shading,
    Form,
}

impl ObjectKind {
    pub const ALL: [ObjectKind; 5] = [
        ObjectKind::Text,
        ObjectKind::Image,
        ObjectKind::Path,
        ObjectKind::Shading,
        ObjectKind::Form,
    ];

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "text" => Self::Text,
            "image" => Self::Image,
            "path" => Self::Path,
            "shading" => Self::Shading,
            "form" => Self::Form,
            _ => return None,
        })
    }
}

/// Một đối tượng của `content.listObjects` (phần giao diện đọc).
#[derive(Debug, Clone, PartialEq)]
pub struct PageObject {
    pub id: String,
    pub page_index: usize,
    pub kind: ObjectKind,
    pub ordinal: i64,
    pub parent_id: Option<String>,
    pub editable: bool,
    /// [x0, y0, x1, y1], pt, khung hiển thị, gốc trên-trái.
    pub bbox: [f64; 4],
    pub layer: Option<String>,
    pub clipped: bool,
    /// [độ mờ tô, độ mờ viền].
    pub opacity: [f64; 2],
    pub fill_color: Option<String>,
    pub stroke_color: Option<String>,
    pub string: Option<String>,
    pub font: Option<String>,
    pub font_size: Option<f64>,
    pub pixel_size: Option<[u64; 2]>,
}

fn bbox_of(v: &Value) -> Option<[f64; 4]> {
    let a = v.as_array()?;
    (a.len() == 4).then_some(())?;
    Some([
        a[0].as_f64()?,
        a[1].as_f64()?,
        a[2].as_f64()?,
        a[3].as_f64()?,
    ])
}

/// Đọc `objects` của `content.listObjects`; mục hỏng bị bỏ.
pub fn read_objects(data: &Value) -> Vec<PageObject> {
    let page = data.get("pageIndex").and_then(Value::as_u64).unwrap_or(0) as usize;
    let s = |o: &Value, k: &str| o.get(k).and_then(Value::as_str).map(String::from);
    data.get("objects")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|o| {
            let op = o.get("opacity").and_then(Value::as_array);
            Some(PageObject {
                id: s(o, "id")?,
                page_index: o
                    .get("pageIndex")
                    .and_then(Value::as_u64)
                    .map_or(page, |n| n as usize),
                kind: ObjectKind::parse(o.get("kind")?.as_str()?)?,
                ordinal: o.get("ordinal").and_then(Value::as_i64).unwrap_or(0),
                parent_id: s(o, "parentId"),
                editable: o.get("editable").and_then(Value::as_bool).unwrap_or(false),
                bbox: bbox_of(o.get("bbox")?)?,
                layer: s(o, "layer"),
                clipped: o.get("clipped").and_then(Value::as_bool).unwrap_or(false),
                opacity: [
                    op.and_then(|a| a.first())
                        .and_then(Value::as_f64)
                        .unwrap_or(1.0),
                    op.and_then(|a| a.get(1))
                        .and_then(Value::as_f64)
                        .unwrap_or(1.0),
                ],
                fill_color: s(o, "fillColor"),
                stroke_color: s(o, "strokeColor"),
                string: s(o, "string"),
                font: s(o, "font"),
                font_size: o.get("fontSize").and_then(Value::as_f64),
                pixel_size: o
                    .get("pixelSize")
                    .and_then(Value::as_array)
                    .and_then(|a| Some([a.first()?.as_u64()?, a.get(1)?.as_u64()?])),
            })
        })
        .collect()
}

/// Trang như đang vẽ trong trình xem: ô của nó trong lớp và px mỗi pt.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PageBox {
    pub index: usize,
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
    /// px mỗi pt.
    pub scale: f64,
    pub disp_w: f64,
    pub disp_h: f64,
}

pub const NUDGE_PT: f64 = 1.0;
pub const NUDGE_BIG_PT: f64 = 10.0;
/// Bản sao đặt lệch bản gốc chừng này để thấy được.
pub const DUPLICATE_OFFSET_PT: f64 = 10.0;
/// Khung khớp nhau trong dung sai này khi ánh xạ lại vùng chọn sau khi sửa.
const MATCH_TOLERANCE_PT: f64 = 0.6;
const EPS: f64 = 0.01;

fn round(n: f64, digits: i32) -> f64 {
    let f = 10f64.powi(digits);
    (n * f).round() / f
}

/// Hộp màn hình (px, so với ảnh trang): trái, trên, rộng, cao.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenBox {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}

/// bbox (pt) → hộp màn hình (px so với ảnh trang).
pub fn bbox_to_page_box(bbox: &[f64; 4], scale: f64) -> ScreenBox {
    ScreenBox {
        left: bbox[0] * scale,
        top: bbox[1] * scale,
        width: (bbox[2] - bbox[0]) * scale,
        height: (bbox[3] - bbox[1]) * scale,
    }
}

/// Hộp màn hình (px) → bbox (pt), gốc trên-trái, chuẩn hóa thứ tự góc.
pub fn page_box_to_bbox(b: &ScreenBox, scale: f64) -> [f64; 4] {
    let (x0, y0) = (b.left / scale, b.top / scale);
    let (x1, y1) = ((b.left + b.width) / scale, (b.top + b.height) / scale);
    [
        round(x0.min(x1), 3),
        round(y0.min(y1), 3),
        round(x0.max(x1), 3),
        round(y0.max(y1), 3),
    ]
}

/// Độ dời px trong lớp → pt (khung hiển thị, y đi xuống).
pub fn px_delta_to_pt(dx: f64, dy: f64, scale: f64) -> (f64, f64) {
    (round(dx / scale, 3), round(dy / scale, 3))
}

// ---- Thử trúng và chọn ----

pub fn bbox_contains(b: &[f64; 4], x: f64, y: f64) -> bool {
    x >= b[0] - EPS && x <= b[2] + EPS && y >= b[1] - EPS && y <= b[3] + EPS
}

/// Đối tượng dưới một điểm (pt, gốc trên-trái), trên cùng trước (thứ tự vẽ cao hơn trước).
pub fn hit_objects(objects: &[PageObject], x: f64, y: f64) -> Vec<&PageObject> {
    let mut v: Vec<&PageObject> = objects
        .iter()
        .filter(|o| bbox_contains(&o.bbox, x, y))
        .collect();
    v.sort_by_key(|o| std::cmp::Reverse(o.ordinal));
    v
}

/// Chọn một trong các đối tượng trúng. Nhấp thường lấy cái trên cùng; nhấp xoay vòng (Alt) lấy cái
/// ngay dưới `previous_id` (vòng lại), để chạm tới từng đối tượng chồng nhau.
pub fn pick_hit<'a>(
    hits: &[&'a PageObject],
    previous_id: Option<&str>,
    cycle: bool,
) -> Option<&'a PageObject> {
    let first = *hits.first()?;
    let (true, Some(prev)) = (cycle, previous_id) else {
        return Some(first);
    };
    match hits.iter().position(|o| o.id == prev) {
        Some(i) => Some(hits[(i + 1) % hits.len()]),
        None => Some(first),
    }
}

/// Đối tượng nằm trọn trong hình chữ nhật (pt, gốc trên-trái): chọn bằng khung kéo.
pub fn objects_in_rect<'a>(objects: &'a [PageObject], rect: &[f64; 4]) -> Vec<&'a PageObject> {
    objects
        .iter()
        .filter(|o| {
            o.bbox[0] >= rect[0] - EPS
                && o.bbox[1] >= rect[1] - EPS
                && o.bbox[2] <= rect[2] + EPS
                && o.bbox[3] <= rect[3] + EPS
        })
        .collect()
}

pub fn toggle_id(selected: &[String], id: &str) -> Vec<String> {
    if selected.iter().any(|s| s == id) {
        selected.iter().filter(|s| *s != id).cloned().collect()
    } else {
        let mut v = selected.to_vec();
        v.push(id.to_string());
        v
    }
}

pub fn add_ids(selected: &[String], ids: &[String]) -> Vec<String> {
    let mut v = selected.to_vec();
    for id in ids {
        if !v.contains(id) {
            v.push(id.clone());
        }
    }
    v
}

/// Chọn theo khoảng trên một trang: các đối tượng giữa `anchor_id` và `target_id` theo thứ tự vẽ
/// (gồm hai đầu). Neo không có trên trang này thì chỉ lấy đích.
pub fn range_ids(
    page_objects: &[PageObject],
    anchor_id: Option<&str>,
    target_id: &str,
) -> Vec<String> {
    let mut sorted: Vec<&PageObject> = page_objects.iter().collect();
    sorted.sort_by_key(|o| o.ordinal);
    let Some(t) = sorted.iter().position(|o| o.id == target_id) else {
        return vec![];
    };
    let Some(a) = anchor_id.and_then(|id| sorted.iter().position(|o| o.id == id)) else {
        return vec![target_id.to_string()];
    };
    let (lo, hi) = if a <= t { (a, t) } else { (t, a) };
    sorted[lo..=hi].iter().map(|o| o.id.clone()).collect()
}

/// Giữ các mã đã chọn còn tồn tại trong `objects`.
pub fn prune_selection(selected: &[String], objects: &[PageObject]) -> Vec<String> {
    selected
        .iter()
        .filter(|id| objects.iter().any(|o| &o.id == *id))
        .cloned()
        .collect()
}

/// Sau khi sửa, mã đổi (mã có chữ số bản sửa). Mỗi đối tượng được chọn được tìm lại ở danh sách mới:
/// cùng trang, cùng loại, cùng chữ, và khung bằng khung cũ dời `delta` (pt). Không khớp thì bị bỏ.
pub fn remap_selection(
    previous: &[PageObject],
    next: &[PageObject],
    delta: (f64, f64),
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for old in previous {
        let want = [
            old.bbox[0] + delta.0,
            old.bbox[1] + delta.1,
            old.bbox[2] + delta.0,
            old.bbox[3] + delta.1,
        ];
        let mut best: Option<(&PageObject, f64)> = None;
        for cand in next {
            if out.contains(&cand.id) || cand.page_index != old.page_index || cand.kind != old.kind
            {
                continue;
            }
            if old.kind == ObjectKind::Text && cand.string != old.string {
                continue;
            }
            let dist = cand
                .bbox
                .iter()
                .zip(want)
                .map(|(v, w)| (v - w).abs())
                .fold(0.0, f64::max);
            if dist <= MATCH_TOLERANCE_PT && best.is_none_or(|(_, d)| dist < d) {
                best = Some((cand, dist));
            }
        }
        if let Some((c, _)) = best {
            out.push(c.id.clone());
        }
    }
    out
}

/// Các trang của danh sách mã (mã bắt đầu `p<trang>:`), đã sắp, không trùng.
pub fn pages_of_ids(ids: &[String]) -> Vec<usize> {
    let mut pages: Vec<usize> = ids
        .iter()
        .filter_map(|id| {
            let rest = id.strip_prefix('p')?;
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            (!digits.is_empty() && rest[digits.len()..].starts_with(':'))
                .then(|| digits.parse().ok())
                .flatten()
        })
        .collect();
    pages.sort_unstable();
    pages.dedup();
    pages
}

// ---- Bàn phím ----

/// Độ dời (pt) cho phím mũi tên (Shift = 10 pt); None với phím khác.
pub fn nudge_for(key: &str, shift: bool) -> Option<(f64, f64)> {
    let step = if shift { NUDGE_BIG_PT } else { NUDGE_PT };
    match key {
        "ArrowLeft" => Some((-step, 0.0)),
        "ArrowRight" => Some((step, 0.0)),
        "ArrowUp" => Some((0.0, -step)),
        "ArrowDown" => Some((0.0, step)),
        _ => None,
    }
}

/// Chỉ dời đáng một thao tác khi lệch ít nhất 0,01 pt.
pub fn is_meaningful_move(dx: f64, dy: f64) -> bool {
    dx.abs() >= 0.01 || dy.abs() >= 0.01
}

// ---- Tham số thao tác ----

pub fn move_params(ids: &[String], dx: f64, dy: f64) -> Value {
    json!({"ids": ids, "dx": round(dx, 3), "dy": round(dy, 3)})
}

pub fn delete_params(ids: &[String]) -> Value {
    json!({"ids": ids})
}

pub fn duplicate_params(ids: &[String], dx: f64, dy: f64) -> Value {
    json!({"ids": ids, "dx": dx, "dy": dy})
}

/// `mode` của lõi (ví dụ "front", "back", "forward", "backward").
pub fn reorder_params(ids: &[String], mode: &str) -> Value {
    json!({"ids": ids, "mode": mode})
}

/// Màu: chỉ kênh được cho ('#rrggbb'). None khi không kênh nào có.
pub fn color_params(ids: &[String], fill: Option<&str>, stroke: Option<&str>) -> Option<Value> {
    let (fill, stroke) = (
        fill.filter(|c| !c.is_empty()),
        stroke.filter(|c| !c.is_empty()),
    );
    if fill.is_none() && stroke.is_none() {
        return None;
    }
    let mut m = Map::new();
    m.insert("ids".into(), json!(ids));
    if let Some(f) = fill {
        m.insert("fill".into(), f.into());
    }
    if let Some(s) = stroke {
        m.insert("stroke".into(), s.into());
    }
    Some(Value::Object(m))
}

pub fn opacity_params(ids: &[String], opacity: f64) -> Value {
    json!({"ids": ids, "opacity": round(opacity, 2).clamp(0.0, 1.0)})
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageFit {
    Stretch,
    Contain,
    Cover,
}

impl ImageFit {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stretch => "stretch",
            Self::Contain => "contain",
            Self::Cover => "cover",
        }
    }
}

pub fn replace_image_params(page: usize, object_id: &str, path: &str, fit: ImageFit) -> Value {
    json!({"pageIndex": page, "objectId": object_id, "path": path, "fit": fit.as_str(), "keepAspectBox": fit != ImageFit::Stretch})
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImageAdjust {
    /// Hộp cắt của lõi (`CropBox`), nếu có.
    pub crop: Option<Value>,
    pub rotate: u32,
    /// "none", "h", "v".
    pub flip: &'static str,
    pub grayscale: bool,
    pub invert: bool,
    pub brightness: f64,
    pub contrast: f64,
    pub saturation: f64,
    pub gamma: f64,
}

impl Default for ImageAdjust {
    fn default() -> Self {
        Self {
            crop: None,
            rotate: 0,
            flip: "none",
            grayscale: false,
            invert: false,
            brightness: 0.0,
            contrast: 0.0,
            saturation: 0.0,
            gamma: 1.0,
        }
    }
}

/// Điều chỉnh không đổi gì (nút bị vô hiệu).
pub fn is_identity_adjust(a: &ImageAdjust) -> bool {
    a.crop.is_none()
        && a.rotate == 0
        && a.flip == "none"
        && !a.grayscale
        && !a.invert
        && a.brightness == 0.0
        && a.contrast == 0.0
        && a.saturation == 0.0
        && a.gamma == 1.0
}

fn clamp_int(n: f64, lo: f64, hi: f64) -> i64 {
    n.round().clamp(lo, hi) as i64
}

pub fn adjust_image_params(page: usize, object_id: &str, a: &ImageAdjust) -> Value {
    let mut v = json!({"pageIndex": page, "objectId": object_id, "rotate": a.rotate, "flip": a.flip,
        "grayscale": a.grayscale, "invert": a.invert,
        "brightness": clamp_int(a.brightness, -100.0, 100.0), "contrast": clamp_int(a.contrast, -100.0, 100.0),
        "saturation": clamp_int(a.saturation, -100.0, 100.0), "gamma": round(a.gamma, 2).clamp(0.1, 5.0)});
    if let Some(c) = &a.crop {
        v["crop"] = c.clone();
    }
    v
}

pub fn extract_image_params(page: usize, object_id: &str, output_path: &str) -> Value {
    json!({"pageIndex": page, "objectId": object_id, "outputPath": output_path})
}

#[derive(Debug, Clone, PartialEq)]
pub struct EraseOptions {
    /// "cut" hoặc "cover".
    pub cover: bool,
    /// 'auto' hoặc '#rrggbb' (chỉ cho cover).
    pub color: String,
    pub include_text: bool,
    pub include_images: bool,
    pub include_vectors: bool,
    pub partial: bool,
    /// "transparent", "white", "auto".
    pub image_fill: &'static str,
}

impl Default for EraseOptions {
    fn default() -> Self {
        Self {
            cover: false,
            color: "auto".into(),
            include_text: true,
            include_images: true,
            include_vectors: true,
            partial: true,
            image_fill: "transparent",
        }
    }
}

/// Hình chữ nhật pt (khung hiển thị, gốc trên-trái) từ hai góc, chuẩn hóa.
pub fn norm_rect_pt(a: (f64, f64), b: (f64, f64)) -> [f64; 4] {
    [
        round(a.0.min(b.0), 3),
        round(a.1.min(b.1), 3),
        round(a.0.max(b.0), 3),
        round(a.1.max(b.1), 3),
    ]
}

pub fn erase_region_params(page: usize, rect: &[f64; 4], o: &EraseOptions) -> Value {
    let mut v = json!({"pageIndex": page, "rect": rect, "mode": if o.cover { "cover" } else { "cut" },
        "includeText": o.include_text, "includeImages": o.include_images, "includeVectors": o.include_vectors,
        "partial": o.partial, "imageFill": o.image_fill});
    if o.cover {
        v["color"] = o.color.clone().into();
    }
    v
}

/// Số lượng kết quả tẩy, như lõi báo (`content.eraseRegion`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct EraseCounts {
    pub removed_objects: u64,
    pub split_objects: u64,
    pub modified_images: u64,
    pub clipped_objects: u64,
    pub covered: u64,
    pub skipped: Vec<String>,
}

pub fn read_erase_counts(d: &Value) -> EraseCounts {
    let n = |k: &str| d.get(k).and_then(Value::as_u64).unwrap_or(0);
    EraseCounts {
        removed_objects: n("removedObjects"),
        split_objects: n("splitObjects"),
        modified_images: n("modifiedImages"),
        clipped_objects: n("clippedObjects"),
        covered: n("covered"),
        skipped: d
            .get("skipped")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// Không gỡ, đổi hay phủ gì: vùng không có đối tượng khớp.
pub fn erase_changed_nothing(c: &EraseCounts) -> bool {
    c.removed_objects == 0
        && c.split_objects == 0
        && c.modified_images == 0
        && c.clipped_objects == 0
        && c.covered == 0
}

/// Milimét từ pt, một chữ số thập phân, dấu phẩy kiểu `vi` ("8,5").
pub fn pt_to_mm_text(pt: f64) -> String {
    let mm = (pt / (72.0 / 25.4) * 10.0).round() / 10.0;
    let s = format!("{mm:.1}");
    s.trim_end_matches('0')
        .trim_end_matches('.')
        .replace('.', ",")
}

/// Rộng và cao của một bbox (pt).
pub fn bbox_size(b: &[f64; 4]) -> (f64, f64) {
    (b[2] - b[0], b[3] - b[1])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(id: &str, ordinal: i64, kind: &str, bbox: [f64; 4], string: Option<&str>) -> Value {
        let mut v = json!({"id": id, "kind": kind, "ordinal": ordinal, "bbox": bbox, "editable": true, "opacity": [1, 0.5]});
        if let Some(s) = string {
            v["string"] = s.into();
        }
        v
    }

    fn list(objs: Vec<Value>) -> Vec<PageObject> {
        read_objects(&json!({"pageIndex": 2, "objects": objs}))
    }

    fn sample() -> Vec<PageObject> {
        list(vec![
            obj("p2:a", 1, "image", [0.0, 0.0, 100.0, 100.0], None),
            obj("p2:b", 2, "text", [10.0, 10.0, 50.0, 30.0], Some("xin")),
            obj("p2:c", 3, "path", [20.0, 20.0, 40.0, 40.0], None),
            obj(
                "p2:far",
                4,
                "text",
                [200.0, 200.0, 220.0, 210.0],
                Some("xa"),
            ),
        ])
    }

    #[test]
    fn reads_objects_and_skips_bad_rows() {
        let l = list(vec![
            obj("a", 1, "text", [0.0, 0.0, 1.0, 1.0], Some("t")),
            json!({"id":"x","kind":"weird","bbox":[0,0,1,1]}),
            json!({"id":"y","kind":"text","bbox":[0,0,1]}),
            json!(5),
        ]);
        assert_eq!(l.len(), 1);
        assert_eq!(
            (
                l[0].page_index,
                l[0].opacity,
                l[0].string.as_deref(),
                l[0].kind
            ),
            (2, [1.0, 0.5], Some("t"), ObjectKind::Text)
        );
    }

    #[test]
    fn px_pt_round_trip() {
        let b = bbox_to_page_box(&[10.0, 20.0, 110.0, 70.0], 2.0);
        assert_eq!(
            (b.left, b.top, b.width, b.height),
            (20.0, 40.0, 200.0, 100.0)
        );
        assert_eq!(page_box_to_bbox(&b, 2.0), [10.0, 20.0, 110.0, 70.0]);
        let flipped = ScreenBox {
            left: 220.0,
            top: 140.0,
            width: -200.0,
            height: -100.0,
        };
        assert_eq!(
            page_box_to_bbox(&flipped, 2.0),
            [10.0, 20.0, 110.0, 70.0],
            "kéo ngược vẫn chuẩn hóa"
        );
        assert_eq!(px_delta_to_pt(3.0, -1.0, 2.0), (1.5, -0.5));
    }

    #[test]
    fn hit_test_orders_by_paint_order_and_cycles() {
        let l = sample();
        let hits = hit_objects(&l, 25.0, 25.0);
        assert_eq!(
            hits.iter().map(|o| o.id.as_str()).collect::<Vec<_>>(),
            ["p2:c", "p2:b", "p2:a"]
        );
        assert_eq!(pick_hit(&hits, None, false).unwrap().id, "p2:c");
        assert_eq!(
            pick_hit(&hits, Some("p2:c"), false).unwrap().id,
            "p2:c",
            "không xoay vòng thì luôn trên cùng"
        );
        assert_eq!(pick_hit(&hits, Some("p2:c"), true).unwrap().id, "p2:b");
        assert_eq!(
            pick_hit(&hits, Some("p2:a"), true).unwrap().id,
            "p2:c",
            "vòng lại"
        );
        assert_eq!(pick_hit(&hits, Some("zz"), true).unwrap().id, "p2:c");
        assert!(pick_hit(&[], None, true).is_none());
        assert!(bbox_contains(&[0.0, 0.0, 10.0, 10.0], 10.005, 5.0));
        assert!(hit_objects(&l, 500.0, 500.0).is_empty());
    }

    #[test]
    fn selection_helpers() {
        let l = sample();
        assert_eq!(
            objects_in_rect(&l, &[5.0, 5.0, 60.0, 60.0])
                .iter()
                .map(|o| o.id.as_str())
                .collect::<Vec<_>>(),
            ["p2:b", "p2:c"]
        );
        let s = vec!["a".to_string()];
        assert_eq!(toggle_id(&s, "b"), ["a", "b"]);
        assert_eq!(toggle_id(&s, "a").len(), 0);
        assert_eq!(add_ids(&s, &["a".into(), "c".into()]), ["a", "c"]);
        assert_eq!(
            range_ids(&l, Some("p2:c"), "p2:a"),
            ["p2:a", "p2:b", "p2:c"]
        );
        assert_eq!(range_ids(&l, None, "p2:b"), ["p2:b"]);
        assert_eq!(range_ids(&l, Some("other"), "p2:b"), ["p2:b"]);
        assert!(range_ids(&l, Some("p2:a"), "zz").is_empty());
        assert_eq!(
            prune_selection(&["p2:a".into(), "gone".into()], &l),
            ["p2:a"]
        );
        assert_eq!(
            pages_of_ids(&[
                "p3:x".into(),
                "p1:y".into(),
                "p3:z".into(),
                "q2:w".into(),
                "p:z".into(),
                "p12".into()
            ]),
            [1, 3]
        );
    }

    #[test]
    fn remap_after_a_move() {
        let prev = sample();
        let moved = list(vec![
            obj("p2:n1", 1, "image", [5.0, 5.0, 105.0, 105.0], None),
            obj("p2:n2", 2, "text", [15.0, 15.0, 55.0, 35.0], Some("xin")),
            obj("p2:n3", 3, "text", [15.2, 15.2, 55.2, 35.2], Some("khác")),
        ]);
        let sel: Vec<PageObject> = prev
            .iter()
            .filter(|o| ["p2:a", "p2:b"].contains(&o.id.as_str()))
            .cloned()
            .collect();
        assert_eq!(
            remap_selection(&sel, &moved, (5.0, 5.0)),
            ["p2:n1", "p2:n2"]
        );
        assert!(
            remap_selection(&sel, &moved, (50.0, 0.0)).is_empty(),
            "lệch quá dung sai"
        );
        // không khớp hai lần cùng một mục
        let dup = list(vec![obj("p2:only", 1, "path", [0.0, 0.0, 1.0, 1.0], None)]);
        let two = list(vec![
            obj("p2:x", 1, "path", [0.0, 0.0, 1.0, 1.0], None),
            obj("p2:y", 2, "path", [0.0, 0.0, 1.0, 1.0], None),
        ]);
        assert_eq!(remap_selection(&two, &dup, (0.0, 0.0)), ["p2:only"]);
    }

    #[test]
    fn keyboard() {
        assert_eq!(nudge_for("ArrowLeft", false), Some((-1.0, 0.0)));
        assert_eq!(nudge_for("ArrowDown", true), Some((0.0, 10.0)));
        assert_eq!(nudge_for("a", false), None);
        assert!(is_meaningful_move(0.0, 0.01) && !is_meaningful_move(0.009, -0.009));
    }

    #[test]
    fn operation_params() {
        let ids = vec!["p0:a".to_string()];
        assert_eq!(
            move_params(&ids, 1.23456, -2.0),
            json!({"ids":["p0:a"],"dx":1.235,"dy":-2.0})
        );
        assert_eq!(delete_params(&ids), json!({"ids":["p0:a"]}));
        assert_eq!(
            duplicate_params(&ids, DUPLICATE_OFFSET_PT, DUPLICATE_OFFSET_PT)["dx"],
            10.0
        );
        assert_eq!(reorder_params(&ids, "front")["mode"], "front");
        assert!(color_params(&ids, None, Some("")).is_none());
        let c = color_params(&ids, Some("#112233"), None).unwrap();
        assert_eq!(
            (c["fill"].as_str(), c.get("stroke")),
            (Some("#112233"), None)
        );
        assert_eq!(
            (
                opacity_params(&ids, 1.7)["opacity"].as_f64(),
                opacity_params(&ids, -1.0)["opacity"].as_f64(),
                opacity_params(&ids, 0.456)["opacity"].as_f64()
            ),
            (Some(1.0), Some(0.0), Some(0.46))
        );
        let r = replace_image_params(1, "p1:i", "/n.png", ImageFit::Cover);
        assert_eq!(
            (r["fit"].as_str(), r["keepAspectBox"].as_bool()),
            (Some("cover"), Some(true))
        );
        assert_eq!(
            replace_image_params(1, "p1:i", "/n.png", ImageFit::Stretch)["keepAspectBox"],
            false
        );
        assert_eq!(
            extract_image_params(0, "o", "/x.png")["outputPath"],
            "/x.png"
        );
    }

    #[test]
    fn image_adjust() {
        assert!(is_identity_adjust(&ImageAdjust::default()));
        assert!(!is_identity_adjust(&ImageAdjust {
            gamma: 1.2,
            ..Default::default()
        }));
        assert!(!is_identity_adjust(&ImageAdjust {
            crop: Some(json!({})),
            ..Default::default()
        }));
        let a = ImageAdjust {
            brightness: 250.4,
            contrast: -300.0,
            saturation: 12.5,
            gamma: 9.0,
            rotate: 90,
            flip: "h",
            ..Default::default()
        };
        let v = adjust_image_params(0, "o", &a);
        assert_eq!(
            (
                v["brightness"].as_i64(),
                v["contrast"].as_i64(),
                v["saturation"].as_i64(),
                v["gamma"].as_f64(),
                v["rotate"].as_u64(),
                v["flip"].as_str(),
                v.get("crop")
            ),
            (
                Some(100),
                Some(-100),
                Some(13),
                Some(5.0),
                Some(90),
                Some("h"),
                None
            )
        );
        assert_eq!(
            adjust_image_params(
                0,
                "o",
                &ImageAdjust {
                    gamma: 0.0,
                    crop: Some(json!({"x":1})),
                    ..Default::default()
                }
            )["crop"],
            json!({"x":1})
        );
    }

    #[test]
    fn erase() {
        assert_eq!(
            norm_rect_pt((50.0, 10.0), (20.0, 40.12345)),
            [20.0, 10.0, 50.0, 40.123]
        );
        let cut = erase_region_params(1, &[0.0, 0.0, 10.0, 10.0], &EraseOptions::default());
        assert_eq!(
            (
                cut["mode"].as_str(),
                cut.get("color"),
                cut["imageFill"].as_str()
            ),
            (Some("cut"), None, Some("transparent"))
        );
        let cover = erase_region_params(
            1,
            &[0.0, 0.0, 10.0, 10.0],
            &EraseOptions {
                cover: true,
                color: "#FFFFFF".into(),
                ..Default::default()
            },
        );
        assert_eq!(
            (cover["mode"].as_str(), cover["color"].as_str()),
            (Some("cover"), Some("#FFFFFF"))
        );
        let c = read_erase_counts(&json!({"removedObjects":2,"covered":1,"skipped":["a",3]}));
        assert_eq!(
            (c.removed_objects, c.covered, c.skipped.clone()),
            (2, 1, vec!["a".to_string()])
        );
        assert!(!erase_changed_nothing(&c));
        assert!(erase_changed_nothing(&EraseCounts::default()));
    }

    #[test]
    fn size_text() {
        assert_eq!(
            (
                pt_to_mm_text(72.0 / 25.4 * 8.5),
                pt_to_mm_text(72.0),
                pt_to_mm_text(0.0)
            ),
            ("8,5".to_string(), "25,4".to_string(), "0".to_string())
        );
        assert_eq!(bbox_size(&[1.0, 2.0, 11.0, 7.0]), (10.0, 5.0));
    }
}
