//! Studio mẫu chữ ký: bố cục xem thử, danh sách mẫu, giá trị mẫu (TASKS_RUST R6.11, R6.12, R6.13, R6.15;
//! FEATURES I9–I13): port `canvasLayout.ts`, `templateList.ts` và `sampleData.ts`. Mẫu là JSON
//! `SignatureTemplate` (cùng dạng với `sign_template_model.rs`). Bố cục chỉ là ước lượng để xem nhanh khi
//! sửa; hình thật do lõi vẽ (`appearance.py`). Logic thuần.
#![allow(dead_code)]

use serde_json::{Map, Value};

use crate::sign_template_model::{DateParts, MAX_TEMPLATE_LINES, format_date_pattern};

// ---------- Bố cục xem thử (canvasLayout.ts) ----------

/// Khoảng cách dòng, đơn vị em (như `appearance.py`).
pub const LEAD: f64 = 1.2;
/// Bước giảm cỡ chữ mỗi lần, điểm.
pub const SHRINK_STEP: f64 = 0.25;

/// Bề rộng ước lượng theo số ký tự: Be Vietnam Pro xấp xỉ 0,54 em, đậm 0,6 em.
pub fn approx_text_width(text: &str, size_pt: f64, bold: bool) -> f64 {
    text.chars().count() as f64 * size_pt * if bold { 0.6 } else { 0.54 }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TextRow {
    pub text: String,
    /// Cỡ yêu cầu (trước khi co).
    pub font_size: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PlacedRow {
    pub text: String,
    /// Cỡ sau khi tự co.
    pub font_size: f64,
    pub x: f64,
    /// Đường cơ sở trong tọa độ hộp (gốc trên trái, điểm).
    pub y: f64,
    pub width: f64,
    /// Cả cỡ nhỏ nhất vẫn không vừa (lõi sẽ cắt hoặc xuống dòng).
    pub overflow: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Area {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BoxLayout {
    pub rows: Vec<PlacedRow>,
    /// Vùng chữ trong lề.
    pub area: Area,
    /// Có dòng nào bị co.
    pub shrunk: bool,
    /// Khối chữ vẫn không vừa hộp.
    pub overflow: bool,
}

/// Làm tròn 4 chữ số thập phân như `+x.toFixed(4)`.
fn fix4(x: f64) -> f64 {
    (x * 1e4).round() / 1e4
}

fn num(t: &Value, key: &str, default: f64) -> f64 {
    t.get(key).and_then(Value::as_f64).unwrap_or(default)
}

fn flag(t: &Value, key: &str, default: bool) -> bool {
    t.get(key).and_then(Value::as_bool).unwrap_or(default)
}

fn fit_height(rows: &[TextRow], sizes: &[f64], floor: f64, max_height: f64) -> Vec<f64> {
    let height_of = |cur: &[f64]| cur.iter().map(|s| s * LEAD).sum::<f64>();
    let apply = |s: f64| -> Vec<f64> {
        rows.iter()
            .enumerate()
            .map(|(i, _)| floor.max(fix4(sizes[i] - s)))
            .collect()
    };
    let mut scale = 0.0;
    let mut cur = apply(scale);
    while height_of(&cur) > max_height && cur.iter().any(|s| *s > floor) {
        scale += SHRINK_STEP;
        cur = apply(scale);
    }
    cur
}

/// Xếp các dòng chữ của hộp (rộng x cao, điểm). `template` đọc: padding, fontSize, minFontSize, autoShrink,
/// bold, align, valign. Có autoShrink thì mỗi dòng co theo bề rộng, cả khối co theo chiều cao, không dưới
/// minFontSize.
pub fn layout_box(width: f64, height: f64, template: &Value, rows: &[TextRow]) -> BoxLayout {
    let pad = num(template, "padding", 4.0);
    let area = Area {
        x: pad,
        y: pad,
        width: (width - 2.0 * pad).max(0.0),
        height: (height - 2.0 * pad).max(0.0),
    };
    let bold = flag(template, "bold", false);
    let floor = num(template, "minFontSize", 5.0);
    let auto = flag(template, "autoShrink", true);

    let mut sizes: Vec<f64> = rows.iter().map(|r| r.font_size).collect();
    if auto {
        sizes = rows
            .iter()
            .enumerate()
            .map(|(i, r)| {
                let mut size = sizes[i];
                while size > floor && approx_text_width(&r.text, size, bold) > area.width {
                    size = floor.max(fix4(size - SHRINK_STEP));
                }
                size
            })
            .collect();
        sizes = fit_height(rows, &sizes, floor, area.height);
    }
    let shrunk = sizes.iter().zip(rows).any(|(s, r)| *s < r.font_size);
    let block_height: f64 = sizes.iter().map(|s| s * LEAD).sum();
    let valign = template.get("valign").and_then(Value::as_str);
    let top = match valign {
        Some("bottom") => area.y + area.height - block_height,
        Some("top") => area.y,
        _ => area.y + (area.height - block_height) / 2.0,
    };
    let align = template.get("align").and_then(Value::as_str);
    let mut y = top;
    let placed: Vec<PlacedRow> = rows
        .iter()
        .zip(&sizes)
        .map(|(r, &size)| {
            let w = approx_text_width(&r.text, size, bold);
            let overflow = w > area.width && (!auto || size <= floor);
            let x = match align {
                Some("center") => area.x + (area.width - w) / 2.0,
                Some("right") => area.x + area.width - w,
                _ => area.x,
            };
            let row = PlacedRow {
                text: r.text.clone(),
                font_size: size,
                x,
                y: y + size * LEAD,
                width: w,
                overflow,
            };
            y += size * LEAD;
            row
        })
        .collect();
    let overflow = y > area.y + area.height + 0.01 || placed.iter().any(|p| p.overflow);
    BoxLayout {
        rows: placed,
        area,
        shrunk,
        overflow,
    }
}

// ---------- Danh sách mẫu đã lưu (templateList.ts) ----------

pub const MAX_TEMPLATES: usize = 50;
const NAME_MAX: usize = 80;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListError {
    Full,
    DuplicateId,
    NotFound,
}

impl ListError {
    pub fn reason(&self) -> &'static str {
        match self {
            ListError::Full => "full",
            ListError::DuplicateId => "duplicate-id",
            ListError::NotFound => "not-found",
        }
    }
}

/// Tên đã cắt khoảng trắng và giới hạn độ dài; None khi rỗng.
pub fn clean_name(name: &str) -> Option<String> {
    let t = name.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.chars().take(NAME_MAX).collect())
    }
}

/// Mã mới: `t` và 16 chữ số hex. `next` trả số ngẫu nhiên [0,16) (tiêm vào để test).
pub fn new_template_id(mut next: impl FnMut() -> u32) -> String {
    let mut id = String::from("t");
    for _ in 0..16 {
        id.push(char::from_digit(next() % 16, 16).unwrap_or('0'));
    }
    id
}

fn id_of(e: &Value) -> Option<&str> {
    e.get("id").and_then(Value::as_str)
}

/// Thêm một mục. Không hai mẫu cùng mã.
pub fn add_entry(list: &[Value], entry: Value) -> Result<Vec<Value>, ListError> {
    if list.len() >= MAX_TEMPLATES {
        return Err(ListError::Full);
    }
    if list.iter().any(|e| id_of(e) == id_of(&entry)) {
        return Err(ListError::DuplicateId);
    }
    let mut out = list.to_vec();
    out.push(entry);
    Ok(out)
}

/// Thay mục cùng mã.
pub fn replace_entry(list: &[Value], next: &Value) -> Vec<Value> {
    list.iter()
        .map(|e| {
            if id_of(e) == id_of(next) {
                next.clone()
            } else {
                e.clone()
            }
        })
        .collect()
}

pub fn remove_entry(list: &[Value], id: &str) -> Vec<Value> {
    list.iter()
        .filter(|e| id_of(e) != Some(id))
        .cloned()
        .collect()
}

/// Bản sao tên "<tên> (bản sao)", không gắn chứng thư (một chứng thư chỉ gắn một mẫu).
pub fn duplicate_entry(
    list: &[Value],
    id: &str,
    new_id: &str,
    copy_suffix: &str,
) -> Result<Vec<Value>, ListError> {
    let source = list
        .iter()
        .find(|e| id_of(e) == Some(id))
        .ok_or(ListError::NotFound)?;
    if list.len() >= MAX_TEMPLATES {
        return Err(ListError::Full);
    }
    let name = source.get("name").and_then(Value::as_str).unwrap_or("");
    let keep = NAME_MAX.saturating_sub(copy_suffix.chars().count());
    let base: String = name.chars().take(keep).collect();
    let mut copy = Map::new();
    copy.insert("id".into(), new_id.into());
    copy.insert("name".into(), format!("{base}{copy_suffix}").into());
    copy.insert(
        "template".into(),
        source.get("template").cloned().unwrap_or(Value::Null),
    );
    if let Some(refs) = source.get("libraryRefs") {
        copy.insert("libraryRefs".into(), refs.clone());
    }
    let mut out = list.to_vec();
    out.push(Value::Object(copy));
    Ok(out)
}

/// Gắn mẫu `id` với chứng thư (hoặc bỏ gắn khi `fingerprint` None). Mẫu khác đang gắn chứng thư đó mất liên
/// kết. Dấu vân tay không phân biệt hoa thường.
pub fn bind_template(list: &[Value], id: &str, fingerprint: Option<&str>) -> Vec<Value> {
    let fp = fingerprint.map(str::to_lowercase);
    list.iter()
        .map(|e| {
            let mut next = e.clone();
            let Some(obj) = next.as_object_mut() else {
                return next;
            };
            let is_target = id_of(e) == Some(id);
            let current = e.get("certFingerprint").and_then(Value::as_str);
            if let Some(f) = &fp {
                if current == Some(f.as_str()) && !is_target {
                    obj.remove("certFingerprint");
                }
                if is_target {
                    obj.insert("certFingerprint".into(), f.clone().into());
                }
            } else if is_target {
                obj.remove("certFingerprint");
            }
            next
        })
        .collect()
}

/// Mẫu gắn với một chứng thư, nếu có.
pub fn bound_template<'a>(list: &'a [Value], fingerprint: Option<&str>) -> Option<&'a Value> {
    let fp = fingerprint.filter(|f| !f.is_empty())?.to_lowercase();
    list.iter()
        .find(|e| e.get("certFingerprint").and_then(Value::as_str) == Some(fp.as_str()))
}

/// Số dòng tối đa mỗi mẫu (studio và bộ kiểm dùng chung một số).
pub const TEMPLATE_LINE_LIMIT: usize = MAX_TEMPLATE_LINES;

// ---------- Giá trị điền xem thử (sampleData.ts) ----------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignValues {
    pub signer_name: String,
    pub organization: String,
    pub tax_code: String,
    pub citizen_id: String,
    pub reason: String,
    pub location: String,
    pub contact: String,
    /// Ngày giờ cục bộ khi vẽ xem thử.
    pub signed_at: DateParts,
}

/// Giá trị mẫu cho chế độ "Mẫu" (thiết kế). 31/10/2026 08:02:03, UTC+7.
pub fn sample_values() -> SignValues {
    SignValues {
        signer_name: "Nguyễn Văn An".into(),
        organization: "Công ty Mẫu".into(),
        tax_code: "0101234567".into(),
        citizen_id: "001234567890".into(),
        reason: "Phê duyệt".into(),
        location: "Hà Nội".into(),
        contact: "an.nguyen@example.vn".into(),
        signed_at: DateParts {
            year: 2026,
            month: 10,
            day: 31,
            hour: 8,
            minute: 2,
            second: 3,
            offset_min: 420,
        },
    }
}

fn str_at(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(String::from)
}

/// Giá trị từ file chứng thư (`CertInfoData`): thông tin thật, thiếu thì để trống (dòng chỉ còn nhãn).
pub fn values_from_cert(info: &Value, now: DateParts) -> SignValues {
    let identity = info.get("identity").cloned().unwrap_or(Value::Null);
    SignValues {
        signer_name: str_at(&identity, "personName")
            .or_else(|| str_at(info, "subjectCommonName"))
            .unwrap_or_default(),
        organization: str_at(&identity, "organization").unwrap_or_default(),
        tax_code: str_at(&identity, "taxCode").unwrap_or_default(),
        citizen_id: str_at(&identity, "citizenId").unwrap_or_default(),
        reason: String::new(),
        location: String::new(),
        contact: String::new(),
        signed_at: now,
    }
}

/// Chữ một nguồn điền vào. `custom` luôn rỗng ở đây (dòng tự do dùng chữ riêng).
pub fn source_value(source: &str, values: &SignValues, template: &Value) -> String {
    match source {
        "signerName" => values.signer_name.clone(),
        "organization" => values.organization.clone(),
        "taxCode" => values.tax_code.clone(),
        "citizenId" => values.citizen_id.clone(),
        "reason" => values.reason.clone(),
        "location" => values.location.clone(),
        "contact" => values.contact.clone(),
        "date" => format_date_pattern(
            &values.signed_at,
            template
                .get("dateFormat")
                .and_then(Value::as_str)
                .unwrap_or("dd/MM/yyyy HH:mm:ss"),
            flag(template, "showTimezone", false),
        ),
        _ => String::new(),
    }
}

/// Các dòng xem thử vẽ: tiêu đề trước, rồi các dòng bật theo thứ tự, dạng "nhãn giá trị". Chữ riêng của
/// dòng thay giá trị (dòng tự do luôn dùng chữ riêng). Dòng rỗng bị bỏ.
pub fn render_rows(template: &Value, values: &SignValues) -> Vec<TextRow> {
    let size = num(template, "fontSize", 9.0);
    let mut rows = Vec::new();
    if let Some(h) = template
        .get("header")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|h| !h.is_empty())
    {
        rows.push(TextRow {
            text: h.to_string(),
            font_size: size,
        });
    }
    let lines = template
        .get("lines")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for line in &lines {
        if line.get("enabled").and_then(Value::as_bool) == Some(false) {
            continue;
        }
        let source = line
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("custom");
        let own = line
            .get("text")
            .and_then(Value::as_str)
            .filter(|t| !t.trim().is_empty())
            .map(String::from);
        let value = if source == "custom" {
            own.unwrap_or_default()
        } else {
            own.unwrap_or_else(|| source_value(source, values, template))
        };
        let label = line
            .get("label")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        let text = [label, value.as_str()]
            .iter()
            .filter(|p| !p.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(" ");
        if text.is_empty() {
            continue;
        }
        rows.push(TextRow {
            text,
            font_size: num(line, "fontSize", size),
        });
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sign_template_model::default_template;
    use serde_json::json;

    fn tpl(extra: Value) -> Value {
        let mut t = json!({ "padding": 4, "fontSize": 9, "minFontSize": 5, "autoShrink": true, "bold": false, "align": "left", "valign": "middle" });
        for (k, v) in extra.as_object().unwrap() {
            t[k] = v.clone();
        }
        t
    }

    fn row(text: &str, size: f64) -> TextRow {
        TextRow {
            text: text.into(),
            font_size: size,
        }
    }

    #[test]
    fn width_estimate_uses_chars_not_bytes() {
        assert_eq!(approx_text_width("abcd", 10.0, false), 4.0 * 10.0 * 0.54);
        assert_eq!(approx_text_width("Việt", 10.0, true), 4.0 * 10.0 * 0.6);
    }

    #[test]
    fn short_text_fits_without_shrinking() {
        let l = layout_box(
            200.0,
            60.0,
            &tpl(json!({})),
            &[row("Ký số bởi", 9.0), row("Nguyễn Văn An", 9.0)],
        );
        assert!(!l.shrunk && !l.overflow);
        assert_eq!(
            l.area,
            Area {
                x: 4.0,
                y: 4.0,
                width: 192.0,
                height: 52.0
            }
        );
        assert_eq!(l.rows[0].x, 4.0);
        // Hai dòng cỡ 9: khối cao 2*9*1,2 = 21,6; căn giữa dọc: top = 4 + (52-21,6)/2.
        let top = 4.0 + (52.0 - 21.6) / 2.0;
        assert!((l.rows[0].y - (top + 9.0 * LEAD)).abs() < 1e-9);
        assert!((l.rows[1].y - (top + 2.0 * 9.0 * LEAD)).abs() < 1e-9);
    }

    #[test]
    fn long_row_shrinks_to_width_but_not_below_floor() {
        let long = "x".repeat(60);
        let l = layout_box(100.0, 80.0, &tpl(json!({})), &[row(&long, 9.0)]);
        assert!(l.shrunk);
        assert!(l.rows[0].font_size >= 5.0 && l.rows[0].font_size < 9.0);
        let l2 = layout_box(40.0, 80.0, &tpl(json!({})), &[row(&long, 9.0)]);
        assert_eq!(l2.rows[0].font_size, 5.0);
        assert!(l2.rows[0].overflow && l2.overflow);
    }

    #[test]
    fn without_autoshrink_a_wide_row_overflows() {
        let long = "x".repeat(60);
        let l = layout_box(
            100.0,
            80.0,
            &tpl(json!({ "autoShrink": false })),
            &[row(&long, 9.0)],
        );
        assert!(!l.shrunk && l.rows[0].overflow && l.overflow);
        assert_eq!(l.rows[0].font_size, 9.0);
    }

    #[test]
    fn many_rows_shrink_to_height() {
        let rows: Vec<_> = (0..6).map(|i| row(&format!("dòng {i}"), 9.0)).collect();
        let l = layout_box(200.0, 40.0, &tpl(json!({})), &rows);
        assert!(l.shrunk);
        let total: f64 = l.rows.iter().map(|r| r.font_size * LEAD).sum();
        assert!(total <= l.area.height + 1e-9 || l.rows.iter().all(|r| r.font_size == 5.0));
    }

    #[test]
    fn alignment_places_rows() {
        let r = [row("abc", 10.0)];
        let w = approx_text_width("abc", 10.0, false);
        let c = layout_box(100.0, 40.0, &tpl(json!({ "align": "center" })), &r);
        assert!((c.rows[0].x - (4.0 + (92.0 - w) / 2.0)).abs() < 1e-9);
        let rt = layout_box(100.0, 40.0, &tpl(json!({ "align": "right" })), &r);
        assert!((rt.rows[0].x - (4.0 + 92.0 - w)).abs() < 1e-9);
        let top = layout_box(100.0, 40.0, &tpl(json!({ "valign": "top" })), &r);
        assert!((top.rows[0].y - (4.0 + 10.0 * LEAD)).abs() < 1e-9);
        let bot = layout_box(100.0, 40.0, &tpl(json!({ "valign": "bottom" })), &r);
        assert!((bot.rows[0].y - (4.0 + 32.0)).abs() < 1e-9);
    }

    fn entry(id: &str, name: &str) -> Value {
        json!({ "id": id, "name": name, "template": { "name": name } })
    }

    #[test]
    fn name_and_id_helpers() {
        assert_eq!(clean_name("   "), None);
        assert_eq!(clean_name("  Mẫu A ").as_deref(), Some("Mẫu A"));
        assert_eq!(clean_name(&"ă".repeat(100)).unwrap().chars().count(), 80);
        let mut n = 0;
        let id = new_template_id(|| {
            n += 1;
            n
        });
        assert_eq!(id, "t123456789abcdef0");
        assert_eq!(id.len(), 17);
    }

    #[test]
    fn add_replace_remove() {
        let l = add_entry(&[], entry("a", "A")).unwrap();
        assert_eq!(add_entry(&l, entry("a", "B")), Err(ListError::DuplicateId));
        let l = add_entry(&l, entry("b", "B")).unwrap();
        let l = replace_entry(&l, &entry("b", "B2"));
        assert_eq!(l[1]["name"], "B2");
        assert_eq!(remove_entry(&l, "a").len(), 1);
        let full: Vec<Value> = (0..MAX_TEMPLATES)
            .map(|i| entry(&format!("i{i}"), "x"))
            .collect();
        assert_eq!(add_entry(&full, entry("new", "n")), Err(ListError::Full));
    }

    #[test]
    fn duplicate_drops_the_binding() {
        let mut a = entry("a", "Mẫu");
        a["certFingerprint"] = "ab".into();
        a["libraryRefs"] = json!({ "logo": "x" });
        let l = duplicate_entry(&[a], "a", "b", " (bản sao)").unwrap();
        assert_eq!(l[1]["name"], "Mẫu (bản sao)");
        assert!(l[1].get("certFingerprint").is_none());
        assert_eq!(l[1]["libraryRefs"], json!({ "logo": "x" }));
        assert_eq!(
            duplicate_entry(&l, "zz", "c", "x"),
            Err(ListError::NotFound)
        );
        assert_eq!(ListError::NotFound.reason(), "not-found");
    }

    #[test]
    fn binding_is_unique_per_certificate_and_case_insensitive() {
        let l = vec![entry("a", "A"), entry("b", "B")];
        let l = bind_template(&l, "a", Some("AB12"));
        assert_eq!(l[0]["certFingerprint"], "ab12");
        let l = bind_template(&l, "b", Some("ab12"));
        assert!(l[0].get("certFingerprint").is_none(), "mẫu cũ mất liên kết");
        assert_eq!(bound_template(&l, Some("AB12")).unwrap()["id"], "b");
        let l = bind_template(&l, "b", None);
        assert!(bound_template(&l, Some("ab12")).is_none());
        assert!(bound_template(&l, None).is_none());
        assert!(bound_template(&l, Some("")).is_none());
    }

    #[test]
    fn default_template_renders_header_and_enabled_lines() {
        let t = default_template(None);
        let rows = render_rows(&t, &sample_values());
        assert_eq!(rows[0].text, "Ký số bởi");
        assert_eq!(rows[1].text, "Nguyễn Văn An");
        assert_eq!(rows[2].text, "31/10/2026 08:02:03");
        assert_eq!(rows.len(), 3);
    }

    #[test]
    fn lines_use_label_override_and_skip_empty_or_disabled() {
        let t = json!({
            "fontSize": 10, "header": "  ",
            "lines": [
                { "source": "signerName", "label": "Người ký:", "enabled": true },
                { "source": "taxCode", "label": "MST:", "text": "999", "fontSize": 7 },
                { "source": "reason", "enabled": false },
                { "source": "custom", "text": "Tự do" },
                { "source": "custom" },
                { "source": "location", "label": "Nơi ký:" },
            ]
        });
        let mut v = sample_values();
        v.location = String::new();
        let rows = render_rows(&t, &v);
        let texts: Vec<_> = rows.iter().map(|r| r.text.as_str()).collect();
        assert_eq!(
            texts,
            ["Người ký: Nguyễn Văn An", "MST: 999", "Tự do", "Nơi ký:"]
        );
        assert_eq!(rows[0].font_size, 10.0);
        assert_eq!(rows[1].font_size, 7.0);
    }

    #[test]
    fn values_from_cert_keep_gaps_empty() {
        let info = json!({ "subjectCommonName": "CN Name", "identity": { "organization": "Cty", "taxCode": "01" } });
        let now = sample_values().signed_at;
        let v = values_from_cert(&info, now);
        assert_eq!(v.signer_name, "CN Name");
        assert_eq!(v.organization, "Cty");
        assert_eq!(v.citizen_id, "");
        assert_eq!(v.reason, "");
        let named = json!({ "subjectCommonName": "CN", "identity": { "personName": "Người" } });
        assert_eq!(values_from_cert(&named, now).signer_name, "Người");
    }

    #[test]
    fn date_source_honours_format_and_timezone() {
        let v = sample_values();
        let t = json!({ "dateFormat": "dd/MM/yyyy", "showTimezone": true });
        assert_eq!(source_value("date", &v, &t), "31/10/2026 (UTC+07:00)");
        assert_eq!(source_value("custom", &v, &t), "");
    }
}
