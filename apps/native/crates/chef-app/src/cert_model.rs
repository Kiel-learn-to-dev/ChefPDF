//! Thẻ chứng thư số (TASKS_RUST R6.03, FEATURES I1–I3): port `apps/ui/src/features/certs/certModel.ts`.
//! Logic thuần: nhận JSON `CertInfoData` của lõi, trả dữ liệu hiển thị. Chuỗi giao diện do nơi gọi dịch.
#![allow(dead_code)]

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Expiry {
    None,
    Soon,
    Expired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdentityKey {
    PersonName,
    Organization,
    TaxCode,
    CitizenId,
    BudgetCode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityLine {
    pub key: IdentityKey,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CertCard {
    pub title: String,
    pub issuer: String,
    pub serial: String,
    pub valid_from: String,
    pub valid_to: String,
    pub expiry: Expiry,
    /// Âm khi đã hết hạn.
    pub days_left: i64,
    pub identity: Vec<IdentityLine>,
    pub key_usage: Vec<String>,
    pub fingerprint_short: String,
}

/// Hết hạn thắng sắp hết hạn.
pub fn expiry_level(expired: bool, expiring_soon: bool) -> Expiry {
    if expired {
        Expiry::Expired
    } else if expiring_soon {
        Expiry::Soon
    } else {
        Expiry::None
    }
}

/// Tên và mã định danh có mặt, theo thứ tự cố định.
pub fn identity_lines(identity: &Value) -> Vec<IdentityLine> {
    [
        ("personName", IdentityKey::PersonName),
        ("organization", IdentityKey::Organization),
        ("taxCode", IdentityKey::TaxCode),
        ("citizenId", IdentityKey::CitizenId),
        ("budgetCode", IdentityKey::BudgetCode),
    ]
    .into_iter()
    .filter_map(|(name, key)| {
        let v = identity.get(name)?.as_str()?;
        (!v.is_empty()).then(|| IdentityLine {
            key,
            value: v.to_string(),
        })
    })
    .collect()
}

/// Ngày từ số ngày kể từ 1970-01-01 (thuật toán civil_from_days).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Thời điểm ISO 8601 ("2026-01-01T00:00:00+00:00", "...Z") thành giây UNIX; None nếu sai dạng.
pub fn parse_iso(iso: &str) -> Option<i64> {
    let (date, rest) = iso.split_once(['T', ' '])?;
    let mut dp = date.split('-');
    let (y, m, d): (i64, u32, u32) = (
        dp.next()?.parse().ok()?,
        dp.next()?.parse().ok()?,
        dp.next()?.parse().ok()?,
    );
    if dp.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let split = rest.find(['Z', '+', '-']).unwrap_or(rest.len());
    let (time, zone) = rest.split_at(split);
    let time = time.split('.').next()?;
    let mut tp = time.split(':');
    let (hh, mm): (i64, i64) = (tp.next()?.parse().ok()?, tp.next()?.parse().ok()?);
    let ss: i64 = tp.next().map_or(Some(0), |s| s.parse().ok())?;
    if hh > 23 || mm > 59 || ss > 60 {
        return None;
    }
    let offset = match zone {
        "" | "Z" => 0,
        z => {
            let sign = if z.starts_with('-') { -1 } else { 1 };
            let body = &z[1..];
            let (oh, om) = body.split_once(':').unwrap_or((body, "0"));
            sign * (oh.parse::<i64>().ok()? * 3600 + om.parse::<i64>().ok()? * 60)
        }
    };
    Some(days_from_civil(y, m, d) * 86_400 + hh * 3600 + mm * 60 + ss - offset)
}

/// "dd/MM/yyyy HH:mm" theo múi giờ cục bộ (`local_offset_min` phút so với UTC). Sai dạng thì trả
/// nguyên chuỗi vào.
pub fn format_date_time(iso: &str, local_offset_min: i64) -> String {
    let Some(secs) = parse_iso(iso) else {
        return iso.to_string();
    };
    let local = secs + local_offset_min * 60;
    let (y, m, d) = civil_from_days(local.div_euclid(86_400));
    let t = local.rem_euclid(86_400);
    format!("{d:02}/{m:02}/{y} {:02}:{:02}", t / 3600, t % 3600 / 60)
}

/// "dd/MM/yyyy HH:mm:ss" theo múi giờ cục bộ (panel chữ ký); None khi thiếu hoặc sai dạng.
pub fn format_date_time_sec(iso: Option<&str>, local_offset_min: i64) -> Option<String> {
    let secs = parse_iso(iso.filter(|s| !s.is_empty())?)? + local_offset_min * 60;
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let t = secs.rem_euclid(86_400);
    Some(format!(
        "{d:02}/{m:02}/{y} {:02}:{:02}:{:02}",
        t / 3600,
        t % 3600 / 60,
        t % 60
    ))
}

/// "dd/MM/yyyy" theo múi giờ cục bộ; trả nguyên chuỗi nếu không phải ngày.
pub fn format_date(iso: &str, local_offset_min: i64) -> String {
    match parse_iso(iso) {
        Some(secs) => {
            let (y, m, d) = civil_from_days((secs + local_offset_min * 60).div_euclid(86_400));
            format!("{d:02}/{m:02}/{y}")
        }
        None => iso.to_string(),
    }
}

/// 16 chữ số hex đầu của dấu vân tay, theo cặp ("AB:CD:EF:01:...").
pub fn fingerprint_short(hex: &str) -> String {
    let clean: String = hex
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .map(|c| c.to_ascii_uppercase())
        .take(16)
        .collect();
    clean
        .as_bytes()
        .chunks(2)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect::<Vec<_>>()
        .join(":")
}

fn text(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn non_empty(v: &Value, primary: &str, fallback: &str) -> String {
    let p = text(v, primary);
    if p.is_empty() { text(v, fallback) } else { p }
}

/// Dữ liệu thẻ từ `CertInfoData` (JSON của lõi).
pub fn cert_card(info: &Value, local_offset_min: i64) -> CertCard {
    CertCard {
        title: non_empty(info, "subjectCommonName", "subject"),
        issuer: non_empty(info, "issuerCommonName", "issuer"),
        serial: text(info, "serial"),
        valid_from: format_date_time(&text(info, "notBefore"), local_offset_min),
        valid_to: format_date_time(&text(info, "notAfter"), local_offset_min),
        expiry: expiry_level(
            info.get("expired")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            info.get("expiringSoon")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        ),
        days_left: info
            .get("daysUntilExpiry")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        identity: identity_lines(info.get("identity").unwrap_or(&Value::Null)),
        key_usage: info
            .get("keyUsage")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|k| k.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default(),
        fingerprint_short: fingerprint_short(&text(info, "fingerprintSha256")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn expiry_wins_over_soon() {
        assert_eq!(expiry_level(false, false), Expiry::None);
        assert_eq!(expiry_level(false, true), Expiry::Soon);
        assert_eq!(expiry_level(true, true), Expiry::Expired);
    }

    #[test]
    fn identity_in_fixed_order_and_only_present() {
        let id = json!({"taxCode":"0101234567","citizenId":null,"budgetCode":null,
            "organization":"Công ty ABC","personName":"Nguyễn Văn An"});
        let keys: Vec<_> = identity_lines(&id).iter().map(|l| l.key).collect();
        assert_eq!(
            keys,
            [
                IdentityKey::PersonName,
                IdentityKey::Organization,
                IdentityKey::TaxCode
            ]
        );
        assert!(identity_lines(&json!({"taxCode":null})).is_empty());
        assert!(identity_lines(&Value::Null).is_empty());
    }

    #[test]
    fn dates_in_local_zone() {
        assert_eq!(
            format_date_time("2026-01-01T00:00:00+00:00", 0),
            "01/01/2026 00:00"
        );
        assert_eq!(
            format_date_time("2026-01-01T00:00:00Z", 420),
            "01/01/2026 07:00"
        );
        assert_eq!(
            format_date_time("2026-12-31T20:30:00-05:00", 420),
            "01/01/2027 08:30"
        );
        assert_eq!(
            format_date_time("2024-02-29T23:59:00+07:00", 420),
            "29/02/2024 23:59"
        );
        assert_eq!(format_date_time("không phải ngày", 420), "không phải ngày");
        assert_eq!(parse_iso("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_iso("2026-13-01T00:00:00Z"), None);
    }

    #[test]
    fn fingerprint_and_card() {
        assert_eq!(
            fingerprint_short("ab cd:ef01234567890123456789"),
            "AB:CD:EF:01:23:45:67:89"
        );
        assert_eq!(fingerprint_short(""), "");
        let info = json!({"subjectCommonName":null,"subject":"CN=An","issuerCommonName":"Test CA",
            "issuer":"CN=Test CA","serial":"01AB","notBefore":"2026-01-01T00:00:00+00:00",
            "notAfter":"2028-01-01T00:00:00+00:00","daysUntilExpiry":-3,"expired":true,
            "expiringSoon":false,"keyUsage":["digitalSignature"],"fingerprintSha256":"abcdef",
            "identity":{"taxCode":"01"}});
        let c = cert_card(&info, 0);
        assert_eq!((c.title.as_str(), c.issuer.as_str()), ("CN=An", "Test CA"));
        assert_eq!((c.expiry, c.days_left), (Expiry::Expired, -3));
        assert_eq!(c.valid_to, "01/01/2028 00:00");
        assert_eq!(c.identity.len(), 1);
        assert_eq!(c.key_usage, ["digitalSignature"]);
    }
}
