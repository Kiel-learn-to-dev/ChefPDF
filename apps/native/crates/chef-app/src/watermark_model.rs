//! Gỡ watermark tự động (TASKS_RUST R5.40, FEATURES E3): port `watermarkModel.ts` và `cleanup/scope.ts`.
//! Đọc kết quả `watermark.detect`, xếp hạng, ô tích mặc định, tham số `watermark.remove`. Lõi không
//! bao giờ gỡ khi dò; giao diện chỉ gỡ những gì người dùng tích. Logic thuần.
#![allow(dead_code)]

use serde_json::{Map, Value, json};

/// Ứng viên từ mức này trở lên được tích sẵn.
pub const HIGH_CONFIDENCE: f64 = 0.8;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfidenceLevel {
    High,
    Medium,
    Low,
}

pub fn confidence_level(c: f64) -> ConfidenceLevel {
    if c >= HIGH_CONFIDENCE {
        ConfidenceLevel::High
    } else if c >= 0.5 {
        ConfidenceLevel::Medium
    } else {
        ConfidenceLevel::Low
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub id: String,
    pub kind: String,
    pub tier: u64,
    pub confidence: f64,
    pub pages: Vec<u64>,
    pub count: u64,
    pub sample_page: Option<u64>,
    pub description_vi: String,
    pub description_en: String,
    pub evidence: Vec<String>,
    /// (trang, các khung [trái, trên, phải, dưới])
    pub preview: Vec<(u64, Vec<Vec<f64>>)>,
}

fn numbers(v: Option<&Value>) -> Vec<f64> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_f64).collect())
        .unwrap_or_default()
}

fn read_one(raw: &Value) -> Option<Candidate> {
    let id = raw.get("id")?.as_str()?.to_string();
    let confidence = raw.get("confidence")?.as_f64()?;
    let desc = raw.get("description");
    let text = |k: &str| {
        desc.and_then(|d| d.get(k))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    Some(Candidate {
        id,
        kind: raw
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        tier: raw.get("tier").and_then(Value::as_u64).unwrap_or(4),
        confidence,
        pages: numbers(raw.get("pages"))
            .into_iter()
            .map(|n| n as u64)
            .collect(),
        count: raw.get("count").and_then(Value::as_u64).unwrap_or(0),
        sample_page: raw
            .get("sample")
            .and_then(|s| s.get("pageIndex"))
            .and_then(Value::as_u64),
        description_vi: text("vi"),
        description_en: text("en"),
        evidence: raw
            .get("evidence")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        preview: raw
            .get("preview")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|p| {
                        let boxes = p
                            .get("bboxes")
                            .and_then(Value::as_array)
                            .map(|b| b.iter().map(|x| numbers(Some(x))).collect())
                            .unwrap_or_default();
                        Some((p.get("pageIndex")?.as_u64()?, boxes))
                    })
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// Ứng viên của `watermark.detect`; mục hỏng bị bỏ.
pub fn read_candidates(data: &Value) -> Vec<Candidate> {
    data.get("candidates")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(read_one).collect())
        .unwrap_or_default()
}

/// Tin cậy cao nhất trước; bằng nhau thì tầng mạnh hơn (số nhỏ hơn) trước, rồi theo mã.
pub fn rank_candidates(list: &[Candidate]) -> Vec<Candidate> {
    let mut v = list.to_vec();
    v.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.tier.cmp(&b.tier))
            .then_with(|| a.id.cmp(&b.id))
    });
    v
}

/// Mã được tích khi danh sách mở: mọi ứng viên từ `HIGH_CONFIDENCE`.
pub fn default_checked(list: &[Candidate]) -> Vec<String> {
    list.iter()
        .filter(|c| c.confidence >= HIGH_CONFIDENCE)
        .map(|c| c.id.clone())
        .collect()
}

/// Các khung của ứng viên trên một trang.
pub fn candidate_boxes(c: &Candidate, page: u64) -> Vec<Vec<f64>> {
    c.preview
        .iter()
        .find(|(p, _)| *p == page)
        .map(|(_, b)| b.clone())
        .unwrap_or_default()
}

/// Trang khung nhìn nhảy tới khi bấm một ứng viên.
pub fn sample_page(c: &Candidate) -> Option<u64> {
    c.sample_page.or_else(|| c.pages.first().copied())
}

/// Phạm vi gõ sai hoặc ngoài tài liệu.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BadScope;

/// Phạm vi trang của các công cụ dọn (watermark, nền, đối tượng giống nhau).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CleanupScope {
    All,
    Current(usize),
    Range(String),
}

/// `Ok(None)` là mọi trang (bỏ trường `pages`); `Ok(Some)` là danh sách; `Err` khi khoảng gõ sai.
pub fn cleanup_pages(
    scope: &CleanupScope,
    page_count: usize,
) -> Result<Option<Vec<usize>>, BadScope> {
    match scope {
        CleanupScope::All => Ok(None),
        CleanupScope::Current(p) if *p < page_count => Ok(Some(vec![*p])),
        CleanupScope::Current(_) => Err(BadScope),
        CleanupScope::Range(t) => crate::page_range::parse_page_ranges(t, page_count)
            .map(|p| Some(p.pages))
            .map_err(|_| BadScope),
    }
}

/// Trường hợp đồng theo phạm vi: `pages` chỉ có khi là danh sách trang.
pub fn scope_fields_of(scope: &CleanupScope, page_count: usize) -> Option<Map<String, Value>> {
    let pages = cleanup_pages(scope, page_count).ok()?;
    let mut m = Map::new();
    if let Some(p) = pages {
        m.insert("pages".into(), json!(p));
    }
    Some(m)
}

/// `watermark.remove` cho các ứng viên đã tích. None khi chưa tích gì hoặc phạm vi sai (lõi từ chối
/// lựa chọn rỗng).
pub fn watermark_remove_params(
    checked: &[String],
    scope: &CleanupScope,
    page_count: usize,
) -> Option<Value> {
    if checked.is_empty() {
        return None;
    }
    let mut ids: Vec<&String> = Vec::new();
    for c in checked {
        if !ids.contains(&c) {
            ids.push(c);
        }
    }
    let mut m = scope_fields_of(scope, page_count)?;
    m.insert("candidateIds".into(), json!(ids));
    Some(Value::Object(m))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RemoveResult {
    pub objects: u64,
    pub annotations: u64,
    pub overlays: u64,
    pub layers: u64,
}

/// Số lượng của kết quả `watermark.remove` (0 cho phần thiếu).
pub fn read_remove_result(d: &Value) -> RemoveResult {
    let n = |k: &str| d.get(k).and_then(Value::as_u64).unwrap_or(0);
    RemoveResult {
        objects: n("removedObjects"),
        annotations: n("removedAnnotations"),
        overlays: n("removedOverlays"),
        layers: n("removedLayers"),
    }
}

pub fn removed_total(r: &RemoveResult) -> u64 {
    r.objects + r.annotations + r.overlays + r.layers
}

#[cfg(test)]
mod tests {
    use super::*;

    fn data() -> Value {
        json!({"candidates":[
            {"id":"c","confidence":0.5,"tier":2,"pages":[3,4],"kind":"text","description":{"vi":"Chữ chìm","en":"Faint text"}},
            {"id":"a","confidence":0.9,"tier":3,"sample":{"pageIndex":2,"bbox":[1,2,3,4]},"preview":[{"pageIndex":2,"bboxes":[[1,2,3,4],[5,6,7,8]]}]},
            {"id":"b","confidence":0.9,"tier":1},
            {"id":"d"}, {"confidence":0.9}, 7]})
    }

    #[test]
    fn reads_ranks_and_checks() {
        let l = read_candidates(&data());
        assert_eq!(l.len(), 3);
        assert_eq!(
            (l[0].kind.as_str(), l[0].description_vi.as_str(), l[2].tier),
            ("text", "Chữ chìm", 1)
        );
        let ranked = rank_candidates(&l);
        assert_eq!(
            ranked.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["b", "a", "c"]
        );
        assert_eq!(default_checked(&ranked), ["b", "a"]);
        assert_eq!(
            (
                confidence_level(0.8),
                confidence_level(0.5),
                confidence_level(0.49)
            ),
            (
                ConfidenceLevel::High,
                ConfidenceLevel::Medium,
                ConfidenceLevel::Low
            )
        );
        assert_eq!(candidate_boxes(&l[1], 2).len(), 2);
        assert!(candidate_boxes(&l[1], 9).is_empty());
        assert_eq!(
            (sample_page(&l[1]), sample_page(&l[0]), sample_page(&l[2])),
            (Some(2), Some(3), None)
        );
    }

    #[test]
    fn scope_and_remove_params() {
        assert_eq!(cleanup_pages(&CleanupScope::All, 5), Ok(None));
        assert_eq!(
            cleanup_pages(&CleanupScope::Current(2), 5),
            Ok(Some(vec![2]))
        );
        assert_eq!(cleanup_pages(&CleanupScope::Current(5), 5), Err(BadScope));
        assert_eq!(
            cleanup_pages(&CleanupScope::Range("2-3".into()), 5),
            Ok(Some(vec![1, 2]))
        );
        assert_eq!(
            cleanup_pages(&CleanupScope::Range("9".into()), 5),
            Err(BadScope)
        );
        let ids = vec!["a".to_string(), "b".into(), "a".into()];
        let v = watermark_remove_params(&ids, &CleanupScope::Range("1,3".into()), 5).unwrap();
        assert_eq!(
            (&v["candidateIds"], &v["pages"]),
            (&json!(["a", "b"]), &json!([0, 2]))
        );
        assert!(
            watermark_remove_params(&ids, &CleanupScope::All, 5)
                .unwrap()
                .get("pages")
                .is_none()
        );
        assert!(watermark_remove_params(&[], &CleanupScope::All, 5).is_none());
        assert!(watermark_remove_params(&ids, &CleanupScope::Range("x".into()), 5).is_none());
    }

    #[test]
    fn remove_result_totals() {
        let r = read_remove_result(
            &json!({"removedObjects":2,"removedLayers":1,"removedOverlays":"x"}),
        );
        assert_eq!(
            (r, removed_total(&r)),
            (
                RemoveResult {
                    objects: 2,
                    annotations: 0,
                    overlays: 0,
                    layers: 1
                },
                3
            )
        );
        assert_eq!(removed_total(&read_remove_result(&Value::Null)), 0);
    }
}
