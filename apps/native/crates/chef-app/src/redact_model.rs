//! Che thông tin mật (TASKS_RUST R5.49, FEATURES J6): port `redactModel.ts`. Form mẫu → `redact.find`,
//! gom và tích các chỗ khớp, vùng vẽ tay, `redact.apply`, kết quả kiểm tra. Che là vĩnh viễn: lõi gỡ
//! nội dung dưới khung và kiểm lại file đã lưu (`REDACTION_VERIFY_FAILED` nếu còn chữ). Một chỗ khớp
//! phải được chọn cùng mọi lần xuất hiện khác của chữ đó, nếu không bước kiểm thất bại. Logic thuần.
#![allow(dead_code)]

use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Builtin {
    Cccd,
    Phone,
    Email,
    BankAccount,
    TaxCode,
    Date,
}

impl Builtin {
    pub const ALL: [Builtin; 6] = [
        Builtin::Cccd,
        Builtin::Phone,
        Builtin::Email,
        Builtin::BankAccount,
        Builtin::TaxCode,
        Builtin::Date,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Builtin::Cccd => "cccd",
            Builtin::Phone => "phone",
            Builtin::Email => "email",
            Builtin::BankAccount => "bankAccount",
            Builtin::TaxCode => "taxCode",
            Builtin::Date => "date",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CustomRow {
    pub id: String,
    pub regex: bool,
    pub value: String,
    pub ignore_diacritics: bool,
}

pub fn new_custom_row(id: &str, regex: bool) -> CustomRow {
    CustomRow {
        id: id.into(),
        regex,
        value: String::new(),
        ignore_diacritics: true,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RedactForm {
    /// Bật theo thứ tự `Builtin::ALL`.
    pub builtins: [bool; 6],
    pub custom: Vec<CustomRow>,
}

impl Default for RedactForm {
    fn default() -> Self {
        Self {
            builtins: [true, true, true, false, false, false],
            custom: vec![],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PatternProblem {
    Empty,
    /// Biểu thức chính quy sai ở dòng này.
    Regex(String),
}

/// Mẫu của `redact.find`, hoặc vấn đề chặn việc tìm. `regex_ok` kiểm biểu thức do bên gọi cấp.
pub fn form_patterns(
    f: &RedactForm,
    regex_ok: &dyn Fn(&str) -> bool,
) -> Result<Vec<Value>, PatternProblem> {
    let mut v: Vec<Value> = Builtin::ALL
        .iter()
        .zip(f.builtins)
        .filter(|(_, on)| *on)
        .map(|(k, _)| json!({"kind": k.as_str()}))
        .collect();
    for row in &f.custom {
        let value = row.value.trim();
        if value.is_empty() {
            continue;
        }
        if row.regex && !regex_ok(value) {
            return Err(PatternProblem::Regex(row.id.clone()));
        }
        v.push(json!({"kind": if row.regex {"regex"} else {"literal"}, "value": value, "ignoreDiacritics": row.ignore_diacritics}));
    }
    if v.is_empty() {
        Err(PatternProblem::Empty)
    } else {
        Ok(v)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Match {
    pub id: String,
    pub page_index: u64,
    /// Nhãn mẫu tìm thấy (loại dựng sẵn hoặc chữ đã gõ).
    pub pattern: String,
    pub text: String,
    /// Khung [x1, y1, x2, y2], pt, gốc trên-trái.
    pub rects: Vec<Vec<f64>>,
}

pub fn read_matches(data: &Value) -> Vec<Match> {
    data.get("matches")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|r| {
            Some(Match {
                id: r.get("id")?.as_str()?.to_string(),
                page_index: r.get("pageIndex").and_then(Value::as_u64).unwrap_or(0),
                pattern: r
                    .get("pattern")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                text: r
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                rects: r
                    .get("rects")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .map(|x| {
                                x.as_array()
                                    .map(|n| {
                                        n.iter().map(|v| v.as_f64().unwrap_or(f64::NAN)).collect()
                                    })
                                    .unwrap_or_default()
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
pub struct MatchGroup {
    pub pattern: String,
    pub count: usize,
    pub pages: Vec<u64>,
    pub ids: Vec<String>,
}

/// Gom theo mẫu, theo thứ tự xuất hiện đầu tiên.
pub fn group_matches(matches: &[Match]) -> Vec<MatchGroup> {
    let mut groups: Vec<MatchGroup> = Vec::new();
    for m in matches {
        let g = match groups.iter().position(|g| g.pattern == m.pattern) {
            Some(i) => &mut groups[i],
            None => {
                groups.push(MatchGroup {
                    pattern: m.pattern.clone(),
                    count: 0,
                    pages: vec![],
                    ids: vec![],
                });
                groups.last_mut().expect("vừa thêm")
            }
        };
        g.count += 1;
        g.ids.push(m.id.clone());
        if !g.pages.contains(&m.page_index) {
            g.pages.push(m.page_index);
        }
    }
    for g in &mut groups {
        g.pages.sort_unstable();
    }
    groups
}

/// Mọi chỗ khớp được tích sẵn.
pub fn default_selection(matches: &[Match]) -> Vec<String> {
    matches.iter().map(|m| m.id.clone()).collect()
}

pub fn toggle_match(selected: &[String], id: &str) -> Vec<String> {
    if selected.iter().any(|x| x == id) {
        selected.iter().filter(|x| *x != id).cloned().collect()
    } else {
        let mut v = selected.to_vec();
        v.push(id.to_string());
        v
    }
}

/// Tích hoặc bỏ tích mọi chỗ khớp của một nhóm.
pub fn set_group_checked(selected: &[String], group: &MatchGroup, checked: bool) -> Vec<String> {
    let mut rest: Vec<String> = selected
        .iter()
        .filter(|id| !group.ids.contains(id))
        .cloned()
        .collect();
    if checked {
        rest.extend(group.ids.iter().cloned());
    }
    rest
}

/// Số chỗ chưa tích. Khác 0 nghĩa là còn chữ hiện rõ: hộp thoại cảnh báo nên che mọi lần xuất hiện.
pub fn unselected_count(matches: &[Match], selected: &[String]) -> usize {
    matches.iter().filter(|m| !selected.contains(&m.id)).count()
}

/// Vùng vẽ tay: khung vẽ trên một trang.
#[derive(Debug, Clone, PartialEq)]
pub struct ManualArea {
    pub id: String,
    pub page_index: u64,
    pub rect: [f64; 4],
}

/// Khung vẽ thành vùng tay; None khi rỗng (dưới 1 pt mỗi chiều).
pub fn manual_from_box(
    id: &str,
    page_index: u64,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Option<ManualArea> {
    if w < 1.0 || h < 1.0 {
        return None;
    }
    let r = |n: f64| (n * 1000.0).round() / 1000.0;
    Some(ManualArea {
        id: id.into(),
        page_index,
        rect: [r(x), r(y), r(x + w), r(y + h)],
    })
}

pub struct ApplyChoices<'a> {
    pub patterns: &'a [Value],
    pub match_ids: &'a [String],
    pub areas: &'a [ManualArea],
    pub fill: &'a str,
    pub also_metadata: bool,
    pub remove_from_annotations: bool,
}

/// `redact.apply`; None khi chưa chọn gì. Mẫu đi cùng mã chỗ khớp vì lõi tìm lại để kiểm.
pub fn apply_params(c: &ApplyChoices) -> Option<Value> {
    if c.match_ids.is_empty() && c.areas.is_empty() {
        return None;
    }
    let fill = if crate::overlay_common::is_hex_color(c.fill) {
        c.fill
    } else {
        "#000000"
    };
    let mut v = json!({
        "rects": c.areas.iter().map(|a| json!({"pageIndex": a.page_index, "rect": a.rect})).collect::<Vec<_>>(),
        "fill": fill, "alsoMetadata": c.also_metadata, "removeFromAnnotations": c.remove_from_annotations,
    });
    if !c.match_ids.is_empty() {
        let mut ids: Vec<&String> = Vec::new();
        for id in c.match_ids {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        v["patterns"] = json!(c.patterns);
        v["matchIds"] = json!(ids);
    }
    Some(v)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verification {
    pub ok: bool,
    /// (nơi, mẫu)
    pub leaks: Vec<(String, String)>,
}

/// Phần kiểm tra của kết quả `redact.apply`.
pub fn read_verification(data: &Value) -> Verification {
    let v = data.get("verification");
    let leaks: Vec<(String, String)> = v
        .and_then(|v| v.get("leaks"))
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|l| l.is_object())
                .map(|l| {
                    let s = |k: &str| l.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                    (s("where"), s("pattern"))
                })
                .collect()
        })
        .unwrap_or_default();
    let ok =
        v.and_then(|v| v.get("ok")).and_then(Value::as_bool) != Some(false) && leaks.is_empty();
    Verification { ok, leaks }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(id: &str, page: u64, pat: &str) -> Match {
        Match {
            id: id.into(),
            page_index: page,
            pattern: pat.into(),
            text: "t".into(),
            rects: vec![],
        }
    }

    #[test]
    fn patterns_from_form() {
        let ok_re = |s: &str| !s.contains('(');
        let p = form_patterns(&RedactForm::default(), &ok_re).unwrap();
        assert_eq!(
            p.iter()
                .map(|x| x["kind"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["cccd", "phone", "email"]
        );
        let mut f = RedactForm {
            builtins: [false; 6],
            custom: vec![],
        };
        assert_eq!(
            form_patterns(&f, &ok_re).unwrap_err(),
            PatternProblem::Empty
        );
        f.custom = vec![
            CustomRow {
                value: "  Nguyễn Văn An ".into(),
                ..new_custom_row("a", false)
            },
            CustomRow {
                value: "   ".into(),
                ..new_custom_row("b", true)
            },
            CustomRow {
                value: "\\d{3}".into(),
                ignore_diacritics: false,
                ..new_custom_row("c", true)
            },
        ];
        let p = form_patterns(&f, &ok_re).unwrap();
        assert_eq!(
            (
                p[0]["kind"].as_str(),
                p[0]["value"].as_str(),
                p[0]["ignoreDiacritics"].as_bool()
            ),
            (Some("literal"), Some("Nguyễn Văn An"), Some(true))
        );
        assert_eq!(
            (p[1]["kind"].as_str(), p[1]["ignoreDiacritics"].as_bool()),
            (Some("regex"), Some(false))
        );
        f.custom.push(CustomRow {
            value: "(".into(),
            ..new_custom_row("bad", true)
        });
        assert_eq!(
            form_patterns(&f, &ok_re).unwrap_err(),
            PatternProblem::Regex("bad".into())
        );
        // regex tắt thì không kiểm
        f.custom = vec![CustomRow {
            value: "(".into(),
            ..new_custom_row("lit", false)
        }];
        assert!(form_patterns(&f, &ok_re).is_ok());
    }

    #[test]
    fn grouping_and_selection() {
        let ms = vec![
            m("1", 2, "cccd"),
            m("2", 0, "email"),
            m("3", 0, "cccd"),
            m("4", 2, "cccd"),
        ];
        let g = group_matches(&ms);
        assert_eq!(
            g.iter()
                .map(|g| (g.pattern.as_str(), g.count, g.pages.clone()))
                .collect::<Vec<_>>(),
            [("cccd", 3, vec![0, 2]), ("email", 1, vec![0])]
        );
        let all = default_selection(&ms);
        assert_eq!(all.len(), 4);
        assert_eq!(unselected_count(&ms, &all), 0);
        let some = toggle_match(&all, "2");
        assert_eq!((some.len(), unselected_count(&ms, &some)), (3, 1));
        assert_eq!(toggle_match(&some, "2").len(), 4);
        let off = set_group_checked(&all, &g[0], false);
        assert_eq!(off, ["2"]);
        assert_eq!(set_group_checked(&off, &g[0], true).len(), 4);
        let parsed = read_matches(
            &json!({"matches":[{"id":"x","pageIndex":1,"pattern":"p","text":"t","rects":[[1,2,3,4]]},{"pageIndex":1},5]}),
        );
        assert_eq!(
            (parsed.len(), parsed[0].rects.clone()),
            (1, vec![vec![1.0, 2.0, 3.0, 4.0]])
        );
    }

    #[test]
    fn manual_areas_and_apply() {
        assert!(manual_from_box("a", 0, 1.0, 1.0, 0.5, 10.0).is_none());
        let a = manual_from_box("a", 1, 10.0, 20.0, 30.0, 5.0004).unwrap();
        assert_eq!(a.rect, [10.0, 20.0, 40.0, 25.0]);
        let pats = vec![json!({"kind":"email"})];
        let ids = vec!["1".to_string(), "1".into(), "2".into()];
        let none = ApplyChoices {
            patterns: &pats,
            match_ids: &[],
            areas: &[],
            fill: "#fff",
            also_metadata: false,
            remove_from_annotations: false,
        };
        assert!(apply_params(&none).is_none());
        let both = ApplyChoices {
            match_ids: &ids,
            areas: std::slice::from_ref(&a),
            fill: "#112233",
            also_metadata: true,
            ..none
        };
        let v = apply_params(&both).unwrap();
        assert_eq!(
            (
                &v["matchIds"],
                &v["patterns"],
                v["fill"].as_str(),
                v["alsoMetadata"].as_bool()
            ),
            (
                &json!(["1", "2"]),
                &json!(pats),
                Some("#112233"),
                Some(true)
            )
        );
        assert_eq!(v["rects"][0]["pageIndex"], 1);
        let only_area = ApplyChoices {
            patterns: &pats,
            match_ids: &[],
            areas: std::slice::from_ref(&a),
            fill: "bad",
            also_metadata: false,
            remove_from_annotations: true,
        };
        let v = apply_params(&only_area).unwrap();
        assert_eq!(
            (v.get("matchIds"), v.get("patterns"), v["fill"].as_str()),
            (None, None, Some("#000000"))
        );
    }

    #[test]
    fn verification_reads_leaks() {
        assert!(read_verification(&json!({})).ok);
        assert!(read_verification(&json!({"verification":{"ok":true,"leaks":[]}})).ok);
        let v = read_verification(
            &json!({"verification":{"ok":true,"leaks":[{"where":"trang 2","pattern":"cccd"}]}}),
        );
        assert_eq!(
            (v.ok, v.leaks),
            (false, vec![("trang 2".into(), "cccd".into())])
        );
        assert!(!read_verification(&json!({"verification":{"ok":false}})).ok);
    }
}
