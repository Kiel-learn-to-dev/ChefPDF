//! Yêu cầu ký số (TASKS_RUST R6.18, R6.21, R6.22, R6.24, R6.26; FEATURES I28–I33): port
//! `signRequest.ts`, `signPrefs.ts`, `tsa.ts`, `stampSteps.ts` và `batchParams.ts`. Dựng đúng tham số của
//! `sign.pades`, `sign.padesToken`, `sign.padesStore`, `sign.stampAndSign*` và `sign.batch` từ trạng thái
//! hộp thoại. PIN và mật khẩu chứng thư chỉ nằm trong tham số trả về, không bao giờ lưu (`persistable_draft`).
//! Logic thuần.
#![allow(dead_code)]

use serde_json::{Map, Value, json};

use crate::initials_model::{InitialsForm, check_initials, initials_params};
use crate::sign_anchor::{
    AnchorForm, FixedForm, MAX_RECENT_ANCHORS, anchor_key, anchor_placement_params,
    fixed_placement_params,
};
use crate::sign_batch::{BatchRow, DEFAULT_SUFFIX, suffix_problem};
use crate::stamp_model::{SeamForm, check_seam_form, seam_params};

// ---------- Mức, băm, chứng nhận ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignLevel {
    BB,
    BT,
    BLt,
    BLta,
}

impl SignLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            SignLevel::BB => "B-B",
            SignLevel::BT => "B-T",
            SignLevel::BLt => "B-LT",
            SignLevel::BLta => "B-LTA",
        }
    }
    pub fn parse(v: &str) -> Option<SignLevel> {
        Some(match v {
            "B-B" => SignLevel::BB,
            "B-T" => SignLevel::BT,
            "B-LT" => SignLevel::BLt,
            "B-LTA" => SignLevel::BLta,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DigestName {
    Sha256,
    Sha384,
    Sha512,
}

impl DigestName {
    pub fn as_str(self) -> &'static str {
        match self {
            DigestName::Sha256 => "sha256",
            DigestName::Sha384 => "sha384",
            DigestName::Sha512 => "sha512",
        }
    }
    pub fn parse(v: &str) -> Option<DigestName> {
        Some(match v {
            "sha256" => DigestName::Sha256,
            "sha384" => DigestName::Sha384,
            "sha512" => DigestName::Sha512,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CertifyMode {
    None,
    NoChanges,
    FormFill,
    Annotate,
}

impl CertifyMode {
    pub fn as_str(self) -> &'static str {
        match self {
            CertifyMode::None => "none",
            CertifyMode::NoChanges => "no-changes",
            CertifyMode::FormFill => "form-fill",
            CertifyMode::Annotate => "annotate",
        }
    }
    pub fn parse(v: &str) -> Option<CertifyMode> {
        Some(match v {
            "none" => CertifyMode::None,
            "no-changes" => CertifyMode::NoChanges,
            "form-fill" => CertifyMode::FormFill,
            "annotate" => CertifyMode::Annotate,
            _ => return None,
        })
    }
}

// ---------- Người ký, tùy chọn, vị trí ----------

#[derive(Debug, Clone, PartialEq)]
pub enum SignerChoice {
    Pfx {
        pfx_path: String,
        password: Option<String>,
    },
    /// Chứng thư trong kho cá nhân của Windows, theo thumbprint SHA-1.
    Store { thumbprint: String },
    Token {
        module_path: String,
        slot_id: Option<u32>,
        token_serial: Option<String>,
        cert_id: String,
        pin: String,
        confirm_final_try: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub struct SignOptionsDraft {
    pub level: SignLevel,
    pub digest: DigestName,
    pub tsa_urls: Vec<String>,
    pub reason: String,
    pub location: String,
    pub contact: String,
    pub certify: CertifyMode,
    /// Mẫu chữ ký hiển thị (JSON `SignatureTemplate`, đường dẫn ảnh đã materialize).
    pub template: Option<Value>,
}

/// Vị trí hộp đã xác định. `rect` là không gian người dùng [x1,y1,x2,y2].
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedPlacement {
    pub page: u64,
    pub rect: [f64; 4],
    /// Trường chữ ký rỗng có sẵn (rect phải trùng).
    pub field_name: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignRequestError {
    NeedsTsa,
    BadTokenSelection,
    NoPin,
}

impl SignRequestError {
    pub fn code(self) -> &'static str {
        match self {
            SignRequestError::NeedsTsa => "NEEDS_TSA",
            SignRequestError::BadTokenSelection => "BAD_TOKEN_SELECTION",
            SignRequestError::NoPin => "NO_PIN",
        }
    }
}

/// Op cần gọi và tham số của nó.
#[derive(Debug, Clone, PartialEq)]
pub struct SignRequest {
    pub op_id: &'static str,
    pub params: Value,
}

fn common_params(
    o: &SignOptionsDraft,
    placement: Option<&ResolvedPlacement>,
) -> Result<Map<String, Value>, SignRequestError> {
    if o.level != SignLevel::BB && o.tsa_urls.is_empty() {
        return Err(SignRequestError::NeedsTsa);
    }
    let mut out = Map::new();
    out.insert("level".into(), json!(o.level.as_str()));
    out.insert("digest".into(), json!(o.digest.as_str()));
    if !o.tsa_urls.is_empty() {
        out.insert("tsaUrls".into(), json!(o.tsa_urls));
    }
    for (key, text) in [
        ("reason", &o.reason),
        ("location", &o.location),
        ("contactInfo", &o.contact),
    ] {
        let t = text.trim();
        if !t.is_empty() {
            out.insert(key.into(), json!(t));
        }
    }
    if o.certify != CertifyMode::None {
        out.insert("certify".into(), json!(o.certify.as_str()));
    }
    if let Some(t) = &o.template {
        out.insert("template".into(), t.clone());
    }
    if let Some(p) = placement {
        out.insert("page".into(), json!(p.page));
        out.insert("rect".into(), json!(p.rect));
        if let Some(f) = p.field_name.as_ref().filter(|f| !f.is_empty()) {
            out.insert("fieldName".into(), json!(f));
        }
    }
    Ok(out)
}

fn is_sha1_hex(s: &str) -> bool {
    s.len() == 40 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Tham số cho một chữ ký của tài liệu đang mở. `placement` None = chữ ký ẩn. Trả lỗi cho tổ hợp mà lõi
/// cũng sẽ từ chối, để hộp thoại báo trước khi bắt đầu việc.
pub fn build_sign_request(
    signer: &SignerChoice,
    options: &SignOptionsDraft,
    placement: Option<&ResolvedPlacement>,
) -> Result<SignRequest, SignRequestError> {
    let mut p = common_params(options, placement)?;
    match signer {
        SignerChoice::Store { thumbprint } => {
            if !is_sha1_hex(thumbprint) {
                return Err(SignRequestError::BadTokenSelection);
            }
            p.insert("thumbprint".into(), json!(thumbprint));
            Ok(SignRequest {
                op_id: "sign.padesStore",
                params: Value::Object(p),
            })
        }
        SignerChoice::Pfx { pfx_path, password } => {
            p.insert("pfxPath".into(), json!(pfx_path));
            if let Some(pw) = password.as_ref().filter(|s| !s.is_empty()) {
                p.insert("password".into(), json!(pw));
            }
            Ok(SignRequest {
                op_id: "sign.pades",
                params: Value::Object(p),
            })
        }
        SignerChoice::Token {
            module_path,
            slot_id,
            token_serial,
            cert_id,
            pin,
            confirm_final_try,
        } => {
            if cert_id.is_empty() {
                return Err(SignRequestError::BadTokenSelection);
            }
            if pin.is_empty() {
                return Err(SignRequestError::NoPin);
            }
            p.insert("modulePath".into(), json!(module_path));
            p.insert("certId".into(), json!(cert_id));
            p.insert("pin".into(), json!(pin));
            if let Some(s) = slot_id {
                p.insert("slotId".into(), json!(s));
            } else if let Some(serial) = token_serial.as_ref().filter(|s| !s.is_empty()) {
                p.insert("tokenSerial".into(), json!(serial));
            } else {
                return Err(SignRequestError::BadTokenSelection);
            }
            if *confirm_final_try {
                p.insert("confirmFinalTry".into(), json!(true));
            }
            Ok(SignRequest {
                op_id: "sign.padesToken",
                params: Value::Object(p),
            })
        }
    }
}

/// Phần của bản nháp được phép lưu: xóa PIN, mật khẩu và xác nhận lần thử cuối khỏi `signer`.
pub fn persistable_draft(draft: &Value) -> Value {
    let mut copy = draft.clone();
    if let Some(Value::Object(signer)) = copy.get_mut("signer") {
        signer.remove("pin");
        signer.remove("password");
        signer.remove("confirmFinalTry");
    }
    copy
}

// ---------- Máy chủ dấu thời gian (tsa.ts) ----------

pub const MAX_TSA_URLS: usize = 5;
const TSA_URL_MAX: usize = 2048;

/// URL đã chuẩn hóa nếu là http(s) tuyệt đối; ngược lại None. Chuẩn hóa như `URL.toString()`: scheme và
/// host viết thường, đường dẫn rỗng thành "/".
pub fn valid_tsa_url(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() || s.len() > TSA_URL_MAX || s.chars().any(char::is_whitespace) {
        return None;
    }
    let (scheme, rest) = s.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, tail) = rest.split_at(end);
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = if host_port.starts_with('[') {
        host_port
    } else {
        host_port.split(':').next().unwrap_or("")
    };
    if host.is_empty() || host == "[" {
        return None;
    }
    let tail = if tail.is_empty() {
        "/"
    } else if tail.starts_with('/') {
        tail
    } else {
        return Some(format!(
            "{scheme}://{}/{tail}",
            authority.to_ascii_lowercase()
        ));
    };
    Some(format!(
        "{scheme}://{}{tail}",
        authority.to_ascii_lowercase()
    ))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TsaCleanResult {
    pub urls: Vec<String>,
    /// Mục không phải URL http(s) hợp lệ (hiện cho người dùng).
    pub invalid: Vec<String>,
    /// Danh sách vượt `MAX_TSA_URLS` (phần thừa bị bỏ).
    pub too_many: bool,
}

/// Cắt khoảng trắng, kiểm và bỏ trùng. Giữ thứ tự (đầu tiên thử trước).
pub fn clean_tsa_urls(list: &[&str]) -> TsaCleanResult {
    let mut urls: Vec<String> = Vec::new();
    let mut invalid = Vec::new();
    for raw in list {
        if raw.trim().is_empty() {
            continue;
        }
        match valid_tsa_url(raw) {
            Some(ok) => {
                if !urls.contains(&ok) {
                    urls.push(ok);
                }
            }
            None => invalid.push(raw.trim().to_string()),
        }
    }
    let too_many = urls.len() > MAX_TSA_URLS;
    urls.truncate(MAX_TSA_URLS);
    TsaCleanResult {
        urls,
        invalid,
        too_many,
    }
}

// ---------- Tùy chọn ký lưu trong settings.prefs.sign (signPrefs.ts) ----------

pub const PREF_KEY: &str = "sign";

#[derive(Debug, Clone, PartialEq)]
pub struct SignPrefs {
    /// Cỡ hộp vẽ gần nhất, mm.
    pub box_mm: (f64, f64),
    pub level: SignLevel,
    pub digest: DigestName,
    pub certify: CertifyMode,
    /// Chữ mốc gần đây, mới nhất trước.
    pub anchors: Vec<String>,
}

impl Default for SignPrefs {
    fn default() -> Self {
        SignPrefs {
            box_mm: (50.0, 20.0),
            level: SignLevel::BB,
            digest: DigestName::Sha256,
            certify: CertifyMode::None,
            anchors: Vec::new(),
        }
    }
}

fn mm_in_range(v: Option<f64>, default: f64) -> f64 {
    v.filter(|n| n.is_finite() && (2.0..=300.0).contains(n))
        .unwrap_or(default)
}

/// Tùy chọn ký từ đối tượng prefs tự do; giá trị sai quay về mặc định.
pub fn read_sign_prefs(prefs: &Map<String, Value>) -> SignPrefs {
    let d = SignPrefs::default();
    let empty = Map::new();
    let r = prefs
        .get(PREF_KEY)
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let boxm = r.get("boxMm").and_then(Value::as_object).unwrap_or(&empty);
    let w = mm_in_range(boxm.get("w").and_then(Value::as_f64), d.box_mm.0);
    let h = mm_in_range(boxm.get("h").and_then(Value::as_f64), d.box_mm.1);
    let mut anchors: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    if let Some(arr) = r.get("anchors").and_then(Value::as_array) {
        for a in arr {
            let Some(t) = a.as_str().filter(|t| !t.trim().is_empty()) else {
                continue;
            };
            let key = anchor_key(t);
            if seen.contains(&key) {
                continue;
            }
            seen.push(key);
            anchors.push(t.trim().to_string());
        }
    }
    anchors.truncate(MAX_RECENT_ANCHORS);
    SignPrefs {
        box_mm: (w, h),
        level: r
            .get("level")
            .and_then(Value::as_str)
            .and_then(SignLevel::parse)
            .unwrap_or(d.level),
        digest: r
            .get("digest")
            .and_then(Value::as_str)
            .and_then(DigestName::parse)
            .unwrap_or(d.digest),
        certify: r
            .get("certify")
            .and_then(Value::as_str)
            .and_then(CertifyMode::parse)
            .unwrap_or(d.certify),
        anchors,
    }
}

/// Prefs với `patch` gộp vào; phần còn lại của đối tượng prefs giữ nguyên.
pub fn write_sign_prefs(prefs: &Map<String, Value>, patch: &SignPrefs) -> Map<String, Value> {
    let mut out = prefs.clone();
    out.insert(
        PREF_KEY.into(),
        json!({
            "boxMm": { "w": patch.box_mm.0, "h": patch.box_mm.1 },
            "level": patch.level.as_str(),
            "digest": patch.digest.as_str(),
            "certify": patch.certify.as_str(),
            "anchors": patch.anchors,
        }),
    );
    out
}

// ---------- Đóng dấu kèm (stampSteps.ts, I33) ----------

#[derive(Debug, Clone, Default)]
pub struct SignStamps {
    pub seam: Option<SeamForm>,
    pub initials: Option<InitialsForm>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StampKind {
    Seam,
    Initials,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StampProblem {
    pub stamp: StampKind,
    pub field: &'static str,
}

pub fn has_stamps(s: &SignStamps) -> bool {
    s.seam.is_some() || s.initials.is_some()
}

/// Các bước đóng dấu theo thứ tự đặt (giáp lai, rồi chữ ký nháy). `Err` nêu dấu đầu tiên có form sai.
pub fn stamp_steps_of(
    stamps: &SignStamps,
    current: usize,
    page_count: usize,
) -> Result<Vec<Value>, StampProblem> {
    let mut steps = Vec::new();
    if let Some(f) = &stamps.seam {
        check_seam_form(f, page_count, current).map_err(|field| StampProblem {
            stamp: StampKind::Seam,
            field,
        })?;
        steps.push(json!({ "op": "stamp.seam", "params": seam_params(f, current, page_count) }));
    }
    if let Some(f) = &stamps.initials {
        check_initials(f, page_count, current).map_err(|field| StampProblem {
            stamp: StampKind::Initials,
            field,
        })?;
        steps.push(
            json!({ "op": "stamp.initials", "params": initials_params(f, current, page_count) }),
        );
    }
    Ok(steps)
}

/// Bọc yêu cầu ký thường bằng các dấu. Không có dấu: trả nguyên. Kho Windows chưa có bản đóng dấu.
pub fn with_stamps(req: SignRequest, steps: Vec<Value>) -> Result<SignRequest, &'static str> {
    if steps.is_empty() {
        return Ok(req);
    }
    let op_id = match req.op_id {
        "sign.padesStore" => {
            return Err(
                "Con dấu và chữ ký hình ảnh chưa dùng với chứng thư trong kho Windows. Tắt con dấu hoặc chọn file .pfx/token.",
            );
        }
        "sign.pades" => "sign.stampAndSign",
        _ => "sign.stampAndSignToken",
    };
    Ok(SignRequest {
        op_id,
        params: json!({ "stamps": steps, "sign": req.params }),
    })
}

// ---------- Ký hàng loạt (batchParams.ts) ----------

#[derive(Debug, Clone, PartialEq)]
pub enum BatchPlacement {
    Invisible,
    Anchor(AnchorForm),
    Fixed(FixedForm),
    Rect { page: u64, rect: [f64; 4] },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputMode {
    Suffix,
    Folder,
    Overwrite,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BatchForm {
    pub signer: SignerChoice,
    pub level: SignLevel,
    pub digest: DigestName,
    pub tsa_urls: Vec<String>,
    pub reason: String,
    pub location: String,
    pub contact: String,
    pub certify: CertifyMode,
    pub template: Option<Value>,
    pub placement: BatchPlacement,
    pub output_mode: OutputMode,
    pub suffix: String,
    pub folder: Option<String>,
    pub stop_on_error: bool,
    pub verify_after: bool,
    /// Người dùng đã xác nhận ghi đè bản gốc (bắt buộc cho chế độ ghi đè).
    pub overwrite_confirmed: bool,
    pub confirm_final_try: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatchProblem {
    NoFiles,
    NoTsa,
    BadSuffix,
    NoFolder,
    NoOverwriteConfirm,
    BadRect,
    NoAnchorText,
}

/// Vấn đề đầu tiên của form, hoặc None.
pub fn batch_problem(files: &[BatchRow], f: &BatchForm) -> Option<BatchProblem> {
    if files.is_empty() {
        return Some(BatchProblem::NoFiles);
    }
    if f.level != SignLevel::BB && f.tsa_urls.is_empty() {
        return Some(BatchProblem::NoTsa);
    }
    if f.output_mode == OutputMode::Suffix && suffix_problem(&f.suffix).is_some() {
        return Some(BatchProblem::BadSuffix);
    }
    if f.output_mode == OutputMode::Folder && f.folder.as_deref().is_none_or(str::is_empty) {
        return Some(BatchProblem::NoFolder);
    }
    if f.output_mode == OutputMode::Overwrite && !f.overwrite_confirmed {
        return Some(BatchProblem::NoOverwriteConfirm);
    }
    if let BatchPlacement::Rect { rect, .. } = &f.placement {
        let [x1, y1, x2, y2] = *rect;
        if ![x1, y1, x2, y2].iter().all(|n| n.is_finite()) || x2 <= x1 || y2 <= y1 {
            return Some(BatchProblem::BadRect);
        }
    }
    if let BatchPlacement::Anchor(a) = &f.placement
        && a.text.trim().is_empty()
    {
        return Some(BatchProblem::NoAnchorText);
    }
    None
}

/// Tham số `sign.batch` (người gọi đã kiểm `batch_problem`). Kho Windows chưa dùng cho lô.
pub fn build_batch_params(files: &[BatchRow], f: &BatchForm) -> Result<Value, &'static str> {
    let mut common = Map::new();
    common.insert("level".into(), json!(f.level.as_str()));
    common.insert("digest".into(), json!(f.digest.as_str()));
    if !f.tsa_urls.is_empty() {
        common.insert("tsaUrls".into(), json!(f.tsa_urls));
    }
    for (key, text) in [
        ("reason", &f.reason),
        ("location", &f.location),
        ("contactInfo", &f.contact),
    ] {
        let t = text.trim();
        if !t.is_empty() {
            common.insert(key.into(), json!(t));
        }
    }
    if f.certify != CertifyMode::None {
        common.insert("certify".into(), json!(f.certify.as_str()));
    }
    if let Some(t) = &f.template {
        common.insert("template".into(), t.clone());
    }
    let signer = match &f.signer {
        SignerChoice::Store { .. } => {
            return Err(
                "Kho chứng thư Windows chưa dùng cho ký hàng loạt. Chọn file .pfx hoặc token.",
            );
        }
        SignerChoice::Pfx { pfx_path, password } => {
            let mut m = Map::new();
            m.insert("kind".into(), json!("pfx"));
            m.insert("pfxPath".into(), json!(pfx_path));
            if let Some(pw) = password.as_ref().filter(|s| !s.is_empty()) {
                m.insert("password".into(), json!(pw));
            }
            Value::Object(m)
        }
        SignerChoice::Token {
            module_path,
            slot_id,
            token_serial,
            cert_id,
            pin,
            ..
        } => {
            let mut m = Map::new();
            m.insert("kind".into(), json!("token"));
            m.insert("modulePath".into(), json!(module_path));
            m.insert("certId".into(), json!(cert_id));
            m.insert("pin".into(), json!(pin));
            if let Some(s) = slot_id {
                m.insert("slotId".into(), json!(s));
            } else if let Some(serial) = token_serial.as_ref().filter(|s| !s.is_empty()) {
                m.insert("tokenSerial".into(), json!(serial));
            }
            if f.confirm_final_try {
                m.insert("confirmFinalTry".into(), json!(true));
            }
            Value::Object(m)
        }
    };
    let output = match f.output_mode {
        OutputMode::Suffix => {
            let s = f.suffix.trim();
            json!({ "mode": "suffix", "suffix": if s.is_empty() { DEFAULT_SUFFIX } else { s } })
        }
        OutputMode::Folder => {
            json!({ "mode": "folder", "folder": f.folder.clone().unwrap_or_default() })
        }
        OutputMode::Overwrite => json!({ "mode": "overwrite" }),
    };
    let placement = match &f.placement {
        BatchPlacement::Invisible => None,
        BatchPlacement::Anchor(a) => Some(anchor_placement_params(a)),
        BatchPlacement::Fixed(x) => Some(fixed_placement_params(x)),
        BatchPlacement::Rect { page, rect } => {
            Some(json!({ "kind": "rect", "page": page, "rect": rect }))
        }
    };
    let rows: Vec<Value> = files
        .iter()
        .map(|r| match r.password.as_ref().filter(|p| !p.is_empty()) {
            Some(pw) => json!({ "path": r.path, "password": pw }),
            None => json!({ "path": r.path }),
        })
        .collect();
    let mut out = Map::new();
    out.insert("files".into(), Value::Array(rows));
    out.insert("signer".into(), signer);
    out.insert("common".into(), Value::Object(common));
    if let Some(p) = placement {
        out.insert("placement".into(), p);
    }
    out.insert("output".into(), output);
    out.insert("stopOnError".into(), json!(f.stop_on_error));
    out.insert("verifyAfter".into(), json!(f.verify_after));
    Ok(Value::Object(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> SignOptionsDraft {
        SignOptionsDraft {
            level: SignLevel::BB,
            digest: DigestName::Sha256,
            tsa_urls: vec![],
            reason: "  Phê duyệt ".into(),
            location: String::new(),
            contact: String::new(),
            certify: CertifyMode::None,
            template: None,
        }
    }

    fn pfx() -> SignerChoice {
        SignerChoice::Pfx {
            pfx_path: "C:/a.pfx".into(),
            password: Some("mk".into()),
        }
    }

    fn token(slot: Option<u32>, serial: Option<&str>) -> SignerChoice {
        SignerChoice::Token {
            module_path: "viettel-ca_v6.dll".into(),
            slot_id: slot,
            token_serial: serial.map(String::from),
            cert_id: "ab12".into(),
            pin: "1234".into(),
            confirm_final_try: false,
        }
    }

    #[test]
    fn pfx_request_trims_text_and_omits_empty() {
        let r = build_sign_request(&pfx(), &options(), None).unwrap();
        assert_eq!(r.op_id, "sign.pades");
        assert_eq!(r.params["pfxPath"], "C:/a.pfx");
        assert_eq!(r.params["password"], "mk");
        assert_eq!(r.params["reason"], "Phê duyệt");
        assert!(r.params.get("location").is_none());
        assert!(
            r.params.get("page").is_none(),
            "chữ ký ẩn không có page/rect"
        );
        assert!(r.params.get("certify").is_none());
    }

    #[test]
    fn visible_placement_adds_page_rect_and_field() {
        let p = ResolvedPlacement {
            page: 3,
            rect: [10.0, 20.0, 110.0, 70.0],
            field_name: Some("Sig1".into()),
        };
        let r = build_sign_request(&pfx(), &options(), Some(&p)).unwrap();
        assert_eq!(r.params["page"], 3);
        assert_eq!(r.params["rect"], json!([10.0, 20.0, 110.0, 70.0]));
        assert_eq!(r.params["fieldName"], "Sig1");
    }

    #[test]
    fn level_above_bb_needs_a_tsa() {
        let mut o = options();
        o.level = SignLevel::BT;
        assert_eq!(
            build_sign_request(&pfx(), &o, None),
            Err(SignRequestError::NeedsTsa)
        );
        o.tsa_urls = vec!["https://tsa.example/".into()];
        assert!(build_sign_request(&pfx(), &o, None).is_ok());
    }

    #[test]
    fn token_requires_cert_pin_and_slot_or_serial() {
        let o = options();
        let ok = build_sign_request(&token(Some(2), None), &o, None).unwrap();
        assert_eq!(ok.op_id, "sign.padesToken");
        assert_eq!(ok.params["slotId"], 2);
        assert!(ok.params.get("tokenSerial").is_none());
        let by_serial = build_sign_request(&token(None, Some("SN1")), &o, None).unwrap();
        assert_eq!(by_serial.params["tokenSerial"], "SN1");
        assert_eq!(
            build_sign_request(&token(None, None), &o, None),
            Err(SignRequestError::BadTokenSelection)
        );
        let SignerChoice::Token { module_path, .. } = token(Some(1), None) else {
            unreachable!()
        };
        let no_pin = SignerChoice::Token {
            module_path,
            slot_id: Some(1),
            token_serial: None,
            cert_id: "x".into(),
            pin: String::new(),
            confirm_final_try: false,
        };
        assert_eq!(
            build_sign_request(&no_pin, &o, None),
            Err(SignRequestError::NoPin)
        );
    }

    #[test]
    fn store_needs_a_40_hex_thumbprint() {
        let o = options();
        let bad = SignerChoice::Store {
            thumbprint: "zz".into(),
        };
        assert_eq!(
            build_sign_request(&bad, &o, None),
            Err(SignRequestError::BadTokenSelection)
        );
        let good = SignerChoice::Store {
            thumbprint: "a".repeat(40),
        };
        assert_eq!(
            build_sign_request(&good, &o, None).unwrap().op_id,
            "sign.padesStore"
        );
    }

    #[test]
    fn persistable_draft_strips_secrets_only() {
        let d = json!({ "signer": { "kind": "token", "pin": "1", "password": "p", "confirmFinalTry": true, "certId": "c" }, "x": 1 });
        let p = persistable_draft(&d);
        assert_eq!(p["signer"], json!({ "kind": "token", "certId": "c" }));
        assert_eq!(p["x"], 1);
        assert_eq!(d["signer"]["pin"], "1", "bản gốc không bị sửa");
    }

    #[test]
    fn tsa_url_validation_and_cleaning() {
        assert_eq!(
            valid_tsa_url(" HTTPS://TSA.Example.com "),
            Some("https://tsa.example.com/".into())
        );
        assert_eq!(
            valid_tsa_url("http://a.b/ts?x=1"),
            Some("http://a.b/ts?x=1".into())
        );
        assert_eq!(valid_tsa_url("ftp://a.b"), None);
        assert_eq!(valid_tsa_url("not a url"), None);
        assert_eq!(valid_tsa_url("https://"), None);
        assert_eq!(valid_tsa_url("https://a b.com"), None);
        let r = clean_tsa_urls(&[
            "https://a.com",
            "",
            "https://a.com/",
            "bad",
            "https://b.com",
            "https://c.com",
            "https://d.com",
            "https://e.com",
            "https://f.com",
        ]);
        assert_eq!(r.urls.len(), MAX_TSA_URLS);
        assert_eq!(r.urls[0], "https://a.com/");
        assert_eq!(r.invalid, vec!["bad".to_string()]);
        assert!(r.too_many);
    }

    #[test]
    fn prefs_fall_back_to_defaults_and_round_trip() {
        let mut m = Map::new();
        assert_eq!(read_sign_prefs(&m), SignPrefs::default());
        m.insert("other".into(), json!(1));
        m.insert(
            PREF_KEY.into(),
            json!({ "boxMm": { "w": 1, "h": 80 }, "level": "B-LT", "digest": "md5", "certify": "annotate", "anchors": ["Giám đốc", " ", "giám đốc", "Kế toán"] }),
        );
        let p = read_sign_prefs(&m);
        assert_eq!(
            p.box_mm,
            (50.0, 80.0),
            "w=1 ngoài khoảng 2..300 nên về mặc định"
        );
        assert_eq!(p.level, SignLevel::BLt);
        assert_eq!(p.digest, DigestName::Sha256);
        assert_eq!(p.certify, CertifyMode::Annotate);
        assert_eq!(
            p.anchors,
            vec!["Giám đốc".to_string(), "Kế toán".to_string()]
        );
        let written = write_sign_prefs(&m, &p);
        assert_eq!(written["other"], 1);
        assert_eq!(read_sign_prefs(&written), p);
    }

    #[test]
    fn stamps_wrap_the_request_but_never_for_the_store() {
        let req = build_sign_request(&pfx(), &options(), None).unwrap();
        assert_eq!(with_stamps(req.clone(), vec![]).unwrap(), req);
        let steps = vec![json!({ "op": "stamp.seam", "params": {} })];
        let w = with_stamps(req, steps.clone()).unwrap();
        assert_eq!(w.op_id, "sign.stampAndSign");
        assert_eq!(w.params["stamps"], json!(steps));
        assert_eq!(w.params["sign"]["pfxPath"], "C:/a.pfx");
        let tok = build_sign_request(&token(Some(1), None), &options(), None).unwrap();
        assert_eq!(
            with_stamps(tok, steps.clone()).unwrap().op_id,
            "sign.stampAndSignToken"
        );
        let store = build_sign_request(
            &SignerChoice::Store {
                thumbprint: "a".repeat(40),
            },
            &options(),
            None,
        )
        .unwrap();
        assert!(with_stamps(store, steps).is_err());
        assert!(!has_stamps(&SignStamps::default()));
    }

    fn row(path: &str, pw: Option<&str>) -> BatchRow {
        BatchRow {
            path: path.into(),
            name: path.into(),
            password: pw.map(String::from),
        }
    }

    fn batch_form() -> BatchForm {
        BatchForm {
            signer: pfx(),
            level: SignLevel::BB,
            digest: DigestName::Sha256,
            tsa_urls: vec![],
            reason: String::new(),
            location: String::new(),
            contact: String::new(),
            certify: CertifyMode::None,
            template: None,
            placement: BatchPlacement::Invisible,
            output_mode: OutputMode::Suffix,
            suffix: "_da-ky".into(),
            folder: None,
            stop_on_error: false,
            verify_after: true,
            overwrite_confirmed: false,
            confirm_final_try: false,
        }
    }

    #[test]
    fn batch_problems_are_reported_in_order() {
        let files = [row("a.pdf", None)];
        assert_eq!(
            batch_problem(&[], &batch_form()),
            Some(BatchProblem::NoFiles)
        );
        let mut f = batch_form();
        f.level = SignLevel::BLta;
        assert_eq!(batch_problem(&files, &f), Some(BatchProblem::NoTsa));
        let mut f = batch_form();
        f.suffix = "a/b".into();
        assert_eq!(batch_problem(&files, &f), Some(BatchProblem::BadSuffix));
        let mut f = batch_form();
        f.output_mode = OutputMode::Folder;
        assert_eq!(batch_problem(&files, &f), Some(BatchProblem::NoFolder));
        f.output_mode = OutputMode::Overwrite;
        assert_eq!(
            batch_problem(&files, &f),
            Some(BatchProblem::NoOverwriteConfirm)
        );
        f.overwrite_confirmed = true;
        assert_eq!(batch_problem(&files, &f), None);
        let mut f = batch_form();
        f.placement = BatchPlacement::Rect {
            page: 1,
            rect: [10.0, 10.0, 5.0, 20.0],
        };
        assert_eq!(batch_problem(&files, &f), Some(BatchProblem::BadRect));
        assert_eq!(batch_problem(&files, &batch_form()), None);
    }

    #[test]
    fn batch_params_shape() {
        let files = [row("a.pdf", Some("p1")), row("b.pdf", None)];
        let v = build_batch_params(&files, &batch_form()).unwrap();
        assert_eq!(
            v["files"],
            json!([{ "path": "a.pdf", "password": "p1" }, { "path": "b.pdf" }])
        );
        assert_eq!(
            v["signer"],
            json!({ "kind": "pfx", "pfxPath": "C:/a.pfx", "password": "mk" })
        );
        assert_eq!(v["output"], json!({ "mode": "suffix", "suffix": "_da-ky" }));
        assert!(v.get("placement").is_none());
        assert_eq!(v["verifyAfter"], true);
        let mut f = batch_form();
        f.suffix = "  ".into();
        f.placement = BatchPlacement::Rect {
            page: 2,
            rect: [1.0, 2.0, 3.0, 4.0],
        };
        let v = build_batch_params(&files, &f).unwrap();
        assert_eq!(v["output"]["suffix"], DEFAULT_SUFFIX);
        assert_eq!(
            v["placement"],
            json!({ "kind": "rect", "page": 2, "rect": [1.0, 2.0, 3.0, 4.0] })
        );
    }

    #[test]
    fn batch_token_signer_and_store_refusal() {
        let mut f = batch_form();
        f.signer = token(Some(3), None);
        f.confirm_final_try = true;
        let v = build_batch_params(&[row("a.pdf", None)], &f).unwrap();
        assert_eq!(v["signer"]["slotId"], 3);
        assert_eq!(v["signer"]["confirmFinalTry"], true);
        f.signer = SignerChoice::Store {
            thumbprint: "a".repeat(40),
        };
        assert!(build_batch_params(&[row("a.pdf", None)], &f).is_err());
    }
}
