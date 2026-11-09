//! Chuỗi giao diện (TASKS_RUST R2.13, BLUEPRINT_RUST §6.5).
//!
//! Nạp nguyên văn `assets/i18n/vi.json` và `en.json` của bản Electron, và làm đúng những gì i18next
//! làm với cấu hình của `apps/ui/src/i18n/index.ts`: `lng` là vi, `fallbackLng` là en, không escape
//! HTML. Nội suy `{{tên}}` (khoảng trắng trong ngoặc được bỏ qua); khóa thiếu tham số thì giữ nguyên
//! `{{tên}}`; số nhiều chọn `khóa_one` hoặc `khóa_other` theo `Intl.PluralRules` của ngôn ngữ, rồi
//! rơi về khóa gốc. Khóa không có ở đâu thì trả về chính khóa.
//!
//! Kết quả được kiểm bằng `tests/i18n_golden.json`, sinh bởi `scripts/gen-native-i18n-golden.mjs`
//! từ chính i18next 26.5.12 của dự án.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU8, Ordering};

const VI_JSON: &str = include_str!("../../../assets/i18n/vi.json");
const EN_JSON: &str = include_str!("../../../assets/i18n/en.json");

/// Ngôn ngữ giao diện. Mặc định là tiếng Việt, như bản Electron.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    Vi,
    En,
}

impl Lang {
    /// Mã trong `settings.json` của bản Electron (`"vi"` hoặc `"en"`).
    pub fn code(self) -> &'static str {
        match self {
            Lang::Vi => "vi",
            Lang::En => "en",
        }
    }

    /// Đọc mã từ `settings.json`; mã lạ thì rơi về tiếng Việt như bản Electron.
    pub fn from_code(code: &str) -> Lang {
        match code {
            "en" => Lang::En,
            _ => Lang::Vi,
        }
    }
}

/// Ngôn ngữ đang dùng cho `t()`. Đổi bằng `set_language`, có hiệu lực ở lần vẽ kế tiếp
/// (không cần khởi động lại, R2.13 tiêu chí 3).
static CURRENT: AtomicU8 = AtomicU8::new(0);

pub fn language() -> Lang {
    match CURRENT.load(Ordering::Relaxed) {
        1 => Lang::En,
        _ => Lang::Vi,
    }
}

pub fn set_language(lang: Lang) {
    CURRENT.store(
        match lang {
            Lang::Vi => 0,
            Lang::En => 1,
        },
        Ordering::Relaxed,
    );
}

/// Bảng khóa phẳng `a.b.c` → chuỗi của một ngôn ngữ, gồm cả khóa số nhiều (`a.b_one`).
struct Catalog {
    strings: HashMap<String, String>,
}

impl Catalog {
    fn parse(json: &str) -> Catalog {
        let value: serde_json::Value = serde_json::from_str(json).expect("i18n JSON hỏng");
        let mut strings = HashMap::new();
        flatten(&value, "", &mut strings);
        Catalog { strings }
    }
}

fn flatten(value: &serde_json::Value, prefix: &str, out: &mut HashMap<String, String>) {
    let Some(object) = value.as_object() else {
        return;
    };
    for (key, child) in object {
        let full = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        match child {
            serde_json::Value::String(text) => {
                out.insert(full, text.clone());
            }
            serde_json::Value::Object(_) => flatten(child, &full, out),
            _ => {}
        }
    }
}

/// Bảng của từng ngôn ngữ, đọc và phân tích lần đầu khi cần (tiết kiệm bộ nhớ lúc khởi động).
pub fn catalog(lang: Lang) -> &'static HashMap<String, String> {
    static VI: OnceLock<Catalog> = OnceLock::new();
    static EN: OnceLock<Catalog> = OnceLock::new();
    let catalog = match lang {
        Lang::Vi => VI.get_or_init(|| Catalog::parse(VI_JSON)),
        Lang::En => EN.get_or_init(|| Catalog::parse(EN_JSON)),
    };
    &catalog.strings
}

/// Hậu tố số nhiều mà `Intl.PluralRules` của ngôn ngữ chọn cho số `count`.
/// Tiếng Việt chỉ có `other`. Tiếng Anh: `one` khi |n| = 1, còn lại `other`.
fn plural_category(lang: Lang, count: i64) -> &'static str {
    match lang {
        Lang::Vi => "other",
        Lang::En if count.abs() == 1 => "one",
        Lang::En => "other",
    }
}

/// Tra khóa như i18next: với số đếm, thử `khóa_<hậu tố>` trước, rồi `khóa`; làm lại với en.
fn resolve(lang: Lang, key: &str, count: Option<i64>) -> Option<&'static str> {
    let langs: &[Lang] = match lang {
        Lang::Vi => &[Lang::Vi, Lang::En],
        Lang::En => &[Lang::En],
    };
    for &l in langs {
        let strings = catalog(l);
        if let Some(n) = count {
            let plural = format!("{key}_{}", plural_category(l, n));
            if let Some(text) = strings.get(&plural) {
                return Some(text.as_str());
            }
        }
        if let Some(text) = strings.get(key) {
            return Some(text.as_str());
        }
    }
    None
}

/// Thay `{{tên}}` bằng giá trị trong `vars`. Tên không có trong `vars` giữ nguyên chuỗi gốc.
fn interpolate(template: &str, vars: &[(&str, String)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find("{{") {
        let Some(close_rel) = rest[open + 2..].find("}}") else {
            break;
        };
        let close = open + 2 + close_rel;
        out.push_str(&rest[..open]);
        let raw = &rest[open..close + 2];
        let name = rest[open + 2..close].trim();
        match vars.iter().find(|(k, _)| *k == name) {
            Some((_, value)) => out.push_str(value),
            None => out.push_str(raw),
        }
        rest = &rest[close + 2..];
    }
    out.push_str(rest);
    out
}

fn translate(lang: Lang, key: &str, count: Option<i64>, vars: &[(&str, String)]) -> String {
    let Some(template) = resolve(lang, key, count) else {
        return key.to_string();
    };
    if count.is_none() && vars.is_empty() {
        return template.to_string();
    }
    let mut all: Vec<(&str, String)> = vars.to_vec();
    if let Some(n) = count {
        all.push(("count", n.to_string()));
    }
    interpolate(template, &all)
}

/// `t(key)` không tham số, theo ngôn ngữ hiện tại.
pub fn t(key: &str) -> String {
    translate(language(), key, None, &[])
}

/// `t(key, { tên: giá trị })`, theo ngôn ngữ hiện tại.
pub fn t_with(key: &str, vars: &[(&str, &str)]) -> String {
    let vars: Vec<(&str, String)> = vars.iter().map(|(k, v)| (*k, (*v).to_string())).collect();
    translate(language(), key, None, &vars)
}

/// `t(key, { count, … })`: số đếm chọn dạng số nhiều và được nội suy thành `{{count}}`.
pub fn tn(key: &str, count: i64, vars: &[(&str, &str)]) -> String {
    let vars: Vec<(&str, String)> = vars.iter().map(|(k, v)| (*k, (*v).to_string())).collect();
    translate(language(), key, Some(count), &vars)
}

/// Bản dịch theo một ngôn ngữ cụ thể, không đụng ngôn ngữ hiện tại (dùng cho kiểm thử).
pub fn translate_in(lang: Lang, key: &str, count: Option<i64>, vars: &[(&str, &str)]) -> String {
    let vars: Vec<(&str, String)> = vars.iter().map(|(k, v)| (*k, (*v).to_string())).collect();
    translate(lang, key, count, &vars)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Các khóa lá của một file JSON (đã bỏ hậu tố số nhiều nếu cần giữ).
    fn leaf_keys(json: &str) -> Vec<String> {
        let value: serde_json::Value = serde_json::from_str(json).expect("JSON");
        let mut out = HashMap::new();
        flatten(&value, "", &mut out);
        out.into_keys().collect()
    }

    #[test]
    fn every_vi_key_is_in_the_rust_table() {
        // R2.13 tiêu chí 1: mọi khóa trong vi.json đều có trong bảng Rust.
        let table = catalog(Lang::Vi);
        let keys = leaf_keys(VI_JSON);
        assert!(keys.len() > 1000, "vi.json chỉ có {} khóa", keys.len());
        let missing: Vec<&String> = keys.iter().filter(|k| !table.contains_key(*k)).collect();
        assert!(missing.is_empty(), "thiếu trong bảng Rust: {missing:?}");
    }

    #[test]
    fn every_en_key_is_in_the_rust_table() {
        let table = catalog(Lang::En);
        let missing: Vec<String> = leaf_keys(EN_JSON)
            .into_iter()
            .filter(|k| !table.contains_key(k))
            .collect();
        assert!(missing.is_empty(), "thiếu trong bảng Rust: {missing:?}");
    }

    #[test]
    fn golden_cases_match_i18next() {
        // Sinh bởi scripts/gen-native-i18n-golden.mjs bằng i18next 26.5.12 của dự án.
        let golden: serde_json::Value =
            serde_json::from_str(include_str!("../tests/i18n_golden.json")).expect("golden JSON");
        let cases = golden["cases"].as_array().expect("cases");
        assert!(
            cases.len() > 10_000,
            "golden chỉ có {} trường hợp",
            cases.len()
        );

        let mut failures = Vec::new();
        for case in cases {
            let lang = Lang::from_code(case["lng"].as_str().unwrap());
            let key = case["key"].as_str().unwrap();
            let expected = case["out"].as_str().unwrap();

            let options = case["options"].as_object().unwrap();
            let count = options.get("count").and_then(|v| v.as_i64());
            // Tham số chuỗi là "<tên>" trong golden, kể cả "count" khi không có số đếm.
            // Chỉ "count" dạng số mới đi qua đường số nhiều.
            let vars: Vec<(String, String)> = options
                .iter()
                .filter(|(_, v)| v.is_string())
                .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
                .collect();
            let vars_ref: Vec<(&str, &str)> =
                vars.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();

            let got = translate_in(lang, key, count, &vars_ref);
            if got != expected {
                failures.push(format!(
                    "{}:{key} {options:?}: rust={got:?} i18next={expected:?}",
                    lang.code()
                ));
            }
        }
        assert!(
            failures.is_empty(),
            "{} trường hợp lệch, ví dụ: {:?}",
            failures.len(),
            &failures[..failures.len().min(5)]
        );
    }

    #[test]
    fn plural_picks_one_and_other_in_english() {
        // Khóa tiếng Anh có cặp _one và _other (createPdf trong pageMenu).
        assert_eq!(
            translate_in(Lang::En, "pageMenu.createPdf", Some(1), &[]),
            "Create PDF from 1 selected page"
        );
        assert_eq!(
            translate_in(Lang::En, "pageMenu.createPdf", Some(5), &[]),
            "Create PDF from 5 selected pages"
        );
    }

    #[test]
    fn vietnamese_has_no_plural_forms() {
        assert_eq!(
            translate_in(Lang::Vi, "pageMenu.createPdf", Some(1), &[]),
            "Tạo PDF từ 1 trang đã chọn"
        );
    }

    #[test]
    fn missing_key_returns_the_key() {
        assert_eq!(
            translate_in(Lang::Vi, "khong.co.khoa", None, &[]),
            "khong.co.khoa"
        );
    }

    #[test]
    fn language_switch_takes_effect_without_restart() {
        // R2.13 tiêu chí 3. Trạng thái toàn cục: khôi phục sau khi kiểm.
        let before = language();
        set_language(Lang::En);
        let en = tn("pageMenu.createPdf", 2, &[]);
        set_language(Lang::Vi);
        let vi = tn("pageMenu.createPdf", 2, &[]);
        set_language(before);
        assert_eq!(en, "Create PDF from 2 selected pages");
        assert_eq!(vi, "Tạo PDF từ 2 trang đã chọn");
    }
}
