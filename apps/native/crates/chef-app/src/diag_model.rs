//! Mô hình chẩn đoán token (TASKS_RUST R6.06, FEATURES I6, I7): port `diagModel.ts`. Logic thuần:
//! sắp bước, đếm trạng thái, kết quả chung, cảnh báo PIN, báo cáo văn bản cho hỗ trợ.
#![allow(dead_code)]

use serde_json::Value;

/// Thang kiểm theo thứ tự lõi chạy.
pub const STEP_ORDER: [&str; 8] = [
    "driver_found",
    "driver_loads",
    "token_present",
    "token_initialized",
    "certificate_readable",
    "certificate_validity",
    "pin_state",
    "signing_self_test",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Status {
    Ok,
    Warn,
    Fail,
    Skipped,
}

impl Status {
    pub fn parse(s: &str) -> Option<Status> {
        match s {
            "ok" => Some(Status::Ok),
            "warn" => Some(Status::Warn),
            "fail" => Some(Status::Fail),
            "skipped" => Some(Status::Skipped),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Overall {
    Ok,
    Warn,
    Fail,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub id: String,
    pub status: Status,
    pub title_vi: String,
    pub title_en: String,
    pub detail: String,
    pub fix_vi: Option<String>,
    pub fix_en: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Vi,
    En,
}

/// Đọc `steps` của lõi; bước thiếu id hoặc trạng thái lạ bị bỏ.
pub fn parse_steps(data: &Value) -> Vec<Step> {
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(String::from);
    data.get("steps")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| {
                    Some(Step {
                        id: s(v, "id")?,
                        status: Status::parse(&s(v, "status")?)?,
                        title_vi: s(v, "titleVi").unwrap_or_default(),
                        title_en: s(v, "titleEn").unwrap_or_default(),
                        detail: s(v, "detail").unwrap_or_default(),
                        fix_vi: s(v, "fixVi"),
                        fix_en: s(v, "fixEn"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Bước theo thứ tự thang; id lạ (lõi mới hơn) xếp cuối, giữ thứ tự gốc.
pub fn order_steps(steps: &[Step]) -> Vec<Step> {
    let rank = |id: &str| {
        STEP_ORDER
            .iter()
            .position(|s| *s == id)
            .unwrap_or(STEP_ORDER.len())
    };
    let mut v: Vec<(usize, &Step)> = steps.iter().enumerate().collect();
    v.sort_by_key(|(i, s)| (rank(&s.id), *i));
    v.into_iter().map(|(_, s)| s.clone()).collect()
}

pub fn count_by_status(steps: &[Step]) -> [usize; 4] {
    let mut c = [0; 4];
    for s in steps {
        c[match s.status {
            Status::Ok => 0,
            Status::Warn => 1,
            Status::Fail => 2,
            Status::Skipped => 3,
        }] += 1;
    }
    c
}

/// Fail thắng warn thắng ok; bước bỏ qua không tính.
pub fn overall_of(steps: &[Step]) -> Overall {
    let [_, warn, fail, _] = count_by_status(steps);
    if fail > 0 {
        Overall::Fail
    } else if warn > 0 {
        Overall::Warn
    } else {
        Overall::Ok
    }
}

/// Bước PIN khi cần chú ý (sai PIN, còn một lần thử, bị khóa, phải đổi).
pub fn pin_alert(steps: &[Step]) -> Option<&Step> {
    steps
        .iter()
        .find(|s| s.id == "pin_state")
        .filter(|s| matches!(s.status, Status::Warn | Status::Fail))
}

/// Tiêu đề và cách sửa theo ngôn ngữ.
pub fn localized(step: &Step, lang: Lang) -> (&str, Option<&str>) {
    match lang {
        Lang::Vi => (&step.title_vi, step.fix_vi.as_deref()),
        Lang::En => (&step.title_en, step.fix_en.as_deref()),
    }
}

/// Nhãn đã dịch cho báo cáo.
pub struct ReportLabels<'a> {
    pub title: &'a str,
    pub generated_at: &'a str,
    pub driver: &'a str,
    pub overall: [&'a str; 3],
    pub status: [&'a str; 4],
    pub fix: &'a str,
    pub no_driver: &'a str,
}

/// Báo cáo văn bản: mỗi bước một dòng, kèm cách sửa của bước warn/fail. Không chứa PIN.
pub fn build_report(
    steps: &[Step],
    overall: Overall,
    lang: Lang,
    labels: &ReportLabels,
    module_path: Option<&str>,
    generated_at: &str,
) -> String {
    let mut lines = vec![
        labels.title.to_string(),
        format!("{}: {generated_at}", labels.generated_at),
        format!(
            "{}: {}",
            labels.driver,
            module_path.unwrap_or(labels.no_driver)
        ),
        labels.overall[overall as usize].to_string(),
        String::new(),
    ];
    for step in order_steps(steps) {
        let (title, fix) = localized(&step, lang);
        lines.push(format!("[{}] {title}", labels.status[step.status as usize]));
        lines.push(format!("    {}", step.detail));
        if let (Some(fix), Status::Warn | Status::Fail) =
            (fix.filter(|f| !f.is_empty()), step.status)
        {
            lines.push(format!("    {}: {fix}", labels.fix));
        }
    }
    lines.join("\n") + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn step(id: &str, status: &str, fix: Option<&str>) -> Value {
        json!({"id":id,"status":status,"titleVi":format!("VI {id}"),"titleEn":format!("EN {id}"),
               "detail":"chi tiết","fixVi":fix,"fixEn":fix})
    }

    #[test]
    fn orders_by_ladder_and_keeps_unknown_last() {
        let steps = parse_steps(&json!({"steps":[
            step("pin_state","ok",None), step("zzz_new","ok",None),
            step("driver_found","ok",None), step("aaa_new","ok",None),
            {"id":"x","status":"weird"}]}));
        assert_eq!(steps.len(), 4);
        let ids: Vec<_> = order_steps(&steps).into_iter().map(|s| s.id).collect();
        assert_eq!(ids, ["driver_found", "pin_state", "zzz_new", "aaa_new"]);
    }

    #[test]
    fn overall_and_pin_alert() {
        let ok = parse_steps(
            &json!({"steps":[step("driver_found","ok",None),step("pin_state","skipped",None)]}),
        );
        assert_eq!(overall_of(&ok), Overall::Ok);
        assert!(pin_alert(&ok).is_none());
        let warn = parse_steps(
            &json!({"steps":[step("driver_found","ok",None),step("pin_state","warn",Some("Còn 1 lần"))]}),
        );
        assert_eq!(overall_of(&warn), Overall::Warn);
        assert_eq!(pin_alert(&warn).unwrap().id, "pin_state");
        let fail = parse_steps(
            &json!({"steps":[step("pin_state","warn",None),step("driver_loads","fail",None)]}),
        );
        assert_eq!(overall_of(&fail), Overall::Fail);
        assert_eq!(count_by_status(&fail), [0, 1, 1, 0]);
    }

    #[test]
    fn report_has_fix_only_for_problem_steps() {
        let steps = parse_steps(&json!({"steps":[
            step("driver_loads","fail",Some("Cài driver")), step("driver_found","ok",Some("không in"))]}));
        let labels = ReportLabels {
            title: "Báo cáo",
            generated_at: "Lúc",
            driver: "Driver",
            overall: ["Tốt", "Lưu ý", "Lỗi"],
            status: ["OK", "CẢNH BÁO", "LỖI", "BỎ QUA"],
            fix: "Cách sửa",
            no_driver: "(không có)",
        };
        let r = build_report(&steps, Overall::Fail, Lang::Vi, &labels, None, "2026-11-23");
        assert!(r.starts_with("Báo cáo\nLúc: 2026-11-23\nDriver: (không có)\nLỗi\n\n"));
        let found = r.find("[OK] VI driver_found").unwrap();
        let loads = r.find("[LỖI] VI driver_loads").unwrap();
        assert!(found < loads);
        assert!(r.contains("    Cách sửa: Cài driver"));
        assert!(!r.contains("không in"));
        assert!(r.ends_with('\n'));
        let en = build_report(
            &steps,
            Overall::Fail,
            Lang::En,
            &labels,
            Some("C:\\x.dll"),
            "t",
        );
        assert!(en.contains("EN driver_loads") && en.contains("Driver: C:\\x.dll"));
    }
}
