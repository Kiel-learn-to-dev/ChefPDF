//! Panel kiểm tra chữ ký và kho tin cậy (TASKS_RUST R6.27, R6.28, R6.29; FEATURES I34, I35, I36): port
//! `verifyModel.ts` và `trustModel.ts`, thêm xuất bảng kết quả ra CSV. Logic thuần.
#![allow(dead_code)]

use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Vi,
    En,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SigStatus {
    Invalid,
    Unknown,
    ValidWithWarnings,
    Valid,
    Unsigned,
}

impl SigStatus {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "invalid" => Self::Invalid,
            "unknown" => Self::Unknown,
            "valid-with-warnings" => Self::ValidWithWarnings,
            "valid" => Self::Valid,
            "unsigned" => Self::Unsigned,
            _ => return None,
        })
    }
    /// Nghiêm trọng nhất lên đầu.
    pub fn rank(self) -> usize {
        self as usize
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tone {
    Ok,
    Warn,
    Bad,
    Unknown,
    Neutral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Icon {
    Check,
    Alert,
    X,
    Help,
    Minus,
}

/// Màu không phải tín hiệu duy nhất: mỗi trạng thái còn có biểu tượng và chữ.
pub fn status_style(s: SigStatus) -> (Tone, Icon, &'static str) {
    match s {
        SigStatus::Valid => (Tone::Ok, Icon::Check, "sig.status.valid"),
        SigStatus::ValidWithWarnings => (Tone::Warn, Icon::Alert, "sig.status.validWarn"),
        SigStatus::Invalid => (Tone::Bad, Icon::X, "sig.status.invalid"),
        SigStatus::Unknown => (Tone::Unknown, Icon::Help, "sig.status.unknown"),
        SigStatus::Unsigned => (Tone::Neutral, Icon::Minus, "sig.status.unsigned"),
    }
}

/// Mã lý do của lõi (`verify.py` REASON_TEXT) và chữ vi/en dự phòng.
pub fn reason_text(code: &str, lang: Lang) -> String {
    let (vi, en) = match code {
        "INTEGRITY_FAILED" => (
            "nội dung đã ký bị thay đổi",
            "the signed content was changed",
        ),
        "MODIFIED_AFTER_SIGNING" => (
            "tài liệu được sửa sau khi ký",
            "the document changed after signing",
        ),
        "CERT_UNTRUSTED" => (
            "chứng thư không thuộc kho tin cậy",
            "the certificate is not trusted",
        ),
        "CERT_REVOKED" => (
            "chứng thư đã bị thu hồi",
            "the certificate has been revoked",
        ),
        "CERT_EXPIRED_AT_SIGNING" => (
            "chứng thư đã hết hạn tại thời điểm ký",
            "the certificate had expired when it was signed",
        ),
        "CERT_EXPIRED_NOW" => (
            "chứng thư đã hết hạn và không có dấu thời gian",
            "the certificate has expired and there is no timestamp",
        ),
        "REVOCATION_UNKNOWN" => (
            "chưa kiểm tra được trạng thái thu hồi",
            "revocation status could not be checked",
        ),
        "WEAK_KEY" => (
            "chứng thư dùng khóa RSA dưới 2048 bit (yếu)",
            "the certificate uses an RSA key under 2048 bits (weak)",
        ),
        "DOCMDP_VIOLATION" => (
            "thay đổi vi phạm quyền của chữ ký chứng nhận",
            "a change breaks the certification permissions",
        ),
        "TIMESTAMP_INVALID" => ("dấu thời gian không hợp lệ", "the timestamp is not valid"),
        "UNSIGNED_FIELD" => ("ô chữ ký chưa được ký", "the signature field is not signed"),
        "SIGNATURE_UNREADABLE" => (
            "không đọc được dữ liệu chữ ký",
            "the signature data cannot be read",
        ),
        other => return other.to_string(),
    };
    match lang {
        Lang::Vi => vi,
        Lang::En => en,
    }
    .to_string()
}

#[derive(Debug, Clone, PartialEq)]
pub struct SigItem {
    pub field_name: String,
    pub status: SigStatus,
    pub reasons: Vec<String>,
    pub signer_name: Option<String>,
    pub signer_cert_cn: Option<String>,
    pub summary_vi: Option<String>,
    pub summary_en: Option<String>,
    pub signed_at: Option<String>,
    pub level: Option<String>,
}

/// Đọc danh sách kết quả kiểm tra của lõi; dòng thiếu `fieldName`/`status` bị bỏ.
pub fn parse_items(data: &Value) -> Vec<SigItem> {
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).map(String::from);
    data.get("signatures")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|v| {
                    Some(SigItem {
                        field_name: s(v, "fieldName")?,
                        status: SigStatus::parse(v.get("status")?.as_str()?)?,
                        reasons: v
                            .get("reasons")
                            .and_then(Value::as_array)
                            .map(|r| {
                                r.iter()
                                    .filter_map(|x| x.as_str().map(String::from))
                                    .collect()
                            })
                            .unwrap_or_default(),
                        signer_name: s(v, "signerName"),
                        signer_cert_cn: v.get("signerCert").and_then(|c| s(c, "subjectCommonName")),
                        summary_vi: s(v, "summaryVi"),
                        summary_en: s(v, "summaryEn"),
                        signed_at: s(v, "signedAt"),
                        level: s(v, "level"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Sắp theo mức nghiêm trọng, ổn định (giữ thứ tự tài liệu trong cùng trạng thái).
pub fn sort_by_severity(items: &[SigItem]) -> Vec<SigItem> {
    let mut v: Vec<(usize, &SigItem)> = items.iter().enumerate().collect();
    v.sort_by_key(|(i, it)| (it.status.rank(), *i));
    v.into_iter().map(|(_, it)| it.clone()).collect()
}

/// Tóm tắt của lõi nếu có, không thì ghép các lý do đã dịch.
pub fn summary_of(item: &SigItem, lang: Lang) -> String {
    let core = match lang {
        Lang::Vi => &item.summary_vi,
        Lang::En => &item.summary_en,
    };
    if let Some(c) = core.as_deref().filter(|c| !c.trim().is_empty()) {
        return c.to_string();
    }
    item.reasons
        .iter()
        .map(|r| reason_text(r, lang))
        .collect::<Vec<_>>()
        .join("; ")
}

/// Người ký hiển thị: tên, rồi tên chung của chứng thư, rồi tên ô chữ ký.
pub fn signer_of(item: &SigItem) -> &str {
    item.signer_name
        .as_deref()
        .or(item.signer_cert_cn.as_deref())
        .unwrap_or(&item.field_name)
}

/// Chip thanh trạng thái: trạng thái nghiêm trọng nhất. None khi không có chữ ký.
pub fn chip_summary(items: &[SigItem]) -> Option<(Tone, &'static str, usize)> {
    let count = |s| items.iter().filter(|i| i.status == s).count();
    [
        (SigStatus::Invalid, Tone::Bad, "sig.chip.invalid"),
        (SigStatus::Unknown, Tone::Unknown, "sig.chip.unknown"),
        (
            SigStatus::ValidWithWarnings,
            Tone::Warn,
            "sig.chip.validWarn",
        ),
        (SigStatus::Valid, Tone::Ok, "sig.chip.valid"),
    ]
    .into_iter()
    .find_map(|(st, tone, key)| {
        let n = count(st);
        (n > 0).then_some((tone, key, n))
    })
}

/// Tên chung từ chuỗi RFC 4514 ("CN=An,O=ABC"), hoặc cả chuỗi.
pub fn common_name_of(rfc4514: &str) -> &str {
    rfc4514
        .split(',')
        .map(str::trim)
        .find_map(|p| p.strip_prefix("CN="))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(rfc4514)
}

fn csv_cell(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}

/// CSV kết quả kiểm tra cả thư mục: mỗi chữ ký một dòng (file, ô ký, người ký, trạng thái, lý do).
/// Có BOM UTF-8 để Excel đọc đúng tiếng Việt. `rows`: (đường dẫn file, các chữ ký của file).
pub fn export_csv(rows: &[(String, Vec<SigItem>)], lang: Lang, header: [&str; 5]) -> String {
    let mut out = String::from("\u{feff}");
    out.push_str(&header.map(csv_cell).join(","));
    out.push_str("\r\n");
    for (file, items) in rows {
        let mut lines: Vec<[String; 5]> = items
            .iter()
            .map(|it| {
                [
                    file.clone(),
                    it.field_name.clone(),
                    signer_of(it).to_string(),
                    status_style(it.status).2.to_string(),
                    summary_of(it, lang),
                ]
            })
            .collect();
        if lines.is_empty() {
            lines.push([
                file.clone(),
                String::new(),
                String::new(),
                "sig.status.unsigned".into(),
                String::new(),
            ]);
        }
        for l in lines {
            out.push_str(&l.iter().map(|c| csv_cell(c)).collect::<Vec<_>>().join(","));
            out.push_str("\r\n");
        }
    }
    out
}

// ---- Kho tin cậy (I35) ----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustGroup {
    VnPublicCa,
    VnGovCa,
    User,
}

impl TrustGroup {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "vn-public-ca" => Self::VnPublicCa,
            "vn-gov-ca" => Self::VnGovCa,
            "user" => Self::User,
            _ => return None,
        })
    }
    pub fn label_key(self) -> &'static str {
        match self {
            Self::VnPublicCa => "sig.trust.group.publicCa",
            Self::VnGovCa => "sig.trust.group.govCa",
            Self::User => "sig.trust.group.user",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustEntry {
    pub group: TrustGroup,
    pub user_added: bool,
    pub subject: String,
    pub not_after: String,
}

/// Chỉ chứng thư người dùng thêm mới xóa được; gốc đóng gói thì giữ.
pub fn can_remove(e: &TrustEntry) -> bool {
    e.user_added
}

/// Gốc đóng gói trước (theo nhóm), rồi của người dùng, mỗi bên theo tên.
pub fn sort_trust(entries: &[TrustEntry]) -> Vec<TrustEntry> {
    let mut v = entries.to_vec();
    v.sort_by(|a, b| {
        a.user_added
            .cmp(&b.user_added)
            .then((a.group as u8).cmp(&(b.group as u8)))
            .then_with(|| a.subject.to_lowercase().cmp(&b.subject.to_lowercase()))
    });
    v
}

/// Gốc sắp hết hạn trong `days` ngày kể từ `now_secs` (hoặc đã hết hạn).
pub fn expires_within(not_after_secs: i64, days: i64, now_secs: i64) -> bool {
    not_after_secs - now_secs <= days * 86_400
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(field: &str, st: SigStatus) -> SigItem {
        SigItem {
            field_name: field.into(),
            status: st,
            reasons: vec![],
            signer_name: None,
            signer_cert_cn: None,
            summary_vi: None,
            summary_en: None,
            signed_at: None,
            level: None,
        }
    }

    #[test]
    fn severity_order_is_stable() {
        let items = [
            item("a", SigStatus::Valid),
            item("b", SigStatus::Invalid),
            item("c", SigStatus::Valid),
            item("d", SigStatus::Unknown),
        ];
        let names: Vec<_> = sort_by_severity(&items)
            .into_iter()
            .map(|i| i.field_name)
            .collect();
        assert_eq!(names, ["b", "d", "a", "c"]);
    }

    #[test]
    fn summary_falls_back_to_reasons_and_signer_chain() {
        let mut it = item("Sig1", SigStatus::ValidWithWarnings);
        it.reasons = vec!["CERT_UNTRUSTED".into(), "ZZZ".into()];
        assert_eq!(
            summary_of(&it, Lang::Vi),
            "chứng thư không thuộc kho tin cậy; ZZZ"
        );
        assert_eq!(
            summary_of(&it, Lang::En),
            "the certificate is not trusted; ZZZ"
        );
        it.summary_vi = Some(" Lõi nói ".into());
        assert_eq!(summary_of(&it, Lang::Vi), " Lõi nói ");
        assert_eq!(signer_of(&it), "Sig1");
        it.signer_cert_cn = Some("An".into());
        assert_eq!(signer_of(&it), "An");
        it.signer_name = Some("Bình".into());
        assert_eq!(signer_of(&it), "Bình");
    }

    #[test]
    fn chip_picks_most_severe() {
        assert_eq!(chip_summary(&[]), None);
        assert_eq!(chip_summary(&[item("a", SigStatus::Unsigned)]), None);
        let v = [
            item("a", SigStatus::Valid),
            item("b", SigStatus::Valid),
            item("c", SigStatus::ValidWithWarnings),
        ];
        assert_eq!(
            chip_summary(&v),
            Some((Tone::Warn, "sig.chip.validWarn", 1))
        );
        let bad = [
            item("a", SigStatus::Invalid),
            item("b", SigStatus::Invalid),
            item("c", SigStatus::Valid),
        ];
        assert_eq!(chip_summary(&bad), Some((Tone::Bad, "sig.chip.invalid", 2)));
    }

    #[test]
    fn parse_and_common_name() {
        let items = parse_items(&json!({"signatures":[
            {"fieldName":"S1","status":"valid","reasons":["WEAK_KEY"],"signerCert":{"subjectCommonName":"An"}},
            {"fieldName":"S2","status":"bogus"}, {"status":"valid"}]}));
        assert_eq!(items.len(), 1);
        assert_eq!(signer_of(&items[0]), "An");
        assert_eq!(common_name_of("CN=Nguyễn Văn An,O=ABC"), "Nguyễn Văn An");
        assert_eq!(common_name_of("O=ABC, CN=An"), "An");
        assert_eq!(common_name_of("O=ABC"), "O=ABC");
        assert_eq!(status_style(SigStatus::Invalid).1, Icon::X);
    }

    #[test]
    fn csv_escapes_and_marks_unsigned_files() {
        let mut bad = item("Sig1", SigStatus::Invalid);
        bad.signer_name = Some("An, \"Bình\"".into());
        bad.reasons = vec!["INTEGRITY_FAILED".into()];
        let csv = export_csv(
            &[("/a.pdf".into(), vec![bad]), ("/b.pdf".into(), vec![])],
            Lang::Vi,
            ["Tệp", "Ô ký", "Người ký", "Trạng thái", "Lý do"],
        );
        assert!(csv.starts_with("\u{feff}Tệp,Ô ký,"));
        let lines: Vec<&str> = csv.trim_end().split("\r\n").collect();
        assert_eq!(lines.len(), 3);
        assert_eq!(
            lines[1],
            "/a.pdf,Sig1,\"An, \"\"Bình\"\"\",sig.status.invalid,nội dung đã ký bị thay đổi"
        );
        assert_eq!(lines[2], "/b.pdf,,,sig.status.unsigned,");
    }

    #[test]
    fn trust_sorting_and_expiry() {
        let e = |g, user, s: &str| TrustEntry {
            group: g,
            user_added: user,
            subject: s.into(),
            not_after: String::new(),
        };
        let sorted = sort_trust(&[
            e(TrustGroup::User, true, "Zeta"),
            e(TrustGroup::VnGovCa, false, "Gov"),
            e(TrustGroup::VnPublicCa, false, "Pub"),
            e(TrustGroup::User, true, "alpha"),
        ]);
        let names: Vec<_> = sorted.iter().map(|t| t.subject.as_str()).collect();
        assert_eq!(names, ["Pub", "Gov", "alpha", "Zeta"]);
        assert!(!can_remove(&sorted[0]) && can_remove(&sorted[2]));
        assert_eq!(
            TrustGroup::parse("vn-gov-ca").unwrap().label_key(),
            "sig.trust.group.govCa"
        );
        assert!(expires_within(1_000_000 + 29 * 86_400, 30, 1_000_000));
        assert!(!expires_within(1_000_000 + 31 * 86_400, 30, 1_000_000));
        assert!(expires_within(10, 30, 1_000_000));
    }
}
