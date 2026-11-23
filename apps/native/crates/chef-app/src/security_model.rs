//! Mật khẩu và quyền (TASKS_RUST R5.44, R5.45; FEATURES J1, J2): port `securityModel.ts`. Mật khẩu chỉ
//! nằm trong bộ nhớ: module này không lưu, không ghi nhật ký, không tuần tự hóa chúng. Logic thuần.
#![allow(dead_code)]

use serde_json::{Map, Value, json};

pub const PERMISSION_KEYS: [&str; 8] = [
    "printLowRes",
    "printHighRes",
    "copyContent",
    "modify",
    "annotate",
    "fillForms",
    "assemble",
    "accessibility",
];

/// Cờ quyền theo thứ tự `PERMISSION_KEYS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Permissions(pub [bool; 8]);

impl Permissions {
    pub const ALL: Permissions = Permissions([true; 8]);

    pub fn get(&self, key: &str) -> Option<bool> {
        PERMISSION_KEYS
            .iter()
            .position(|k| *k == key)
            .map(|i| self.0[i])
    }

    /// In độ phân giải cao cần in độ phân giải thấp (quy tắc của lõi).
    pub fn with(self, key: &str, value: bool) -> Permissions {
        let mut p = self;
        if let Some(i) = PERMISSION_KEYS.iter().position(|k| *k == key) {
            p.0[i] = value;
            if key == "printLowRes" && !value {
                p.0[1] = false;
            }
        }
        p
    }

    pub fn allows_all(&self) -> bool {
        self.0.iter().all(|b| *b)
    }

    fn to_json(self) -> Value {
        Value::Object(
            PERMISSION_KEYS
                .iter()
                .zip(self.0)
                .map(|(k, v)| ((*k).to_string(), Value::Bool(v)))
                .collect::<Map<_, _>>(),
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Strength {
    Empty,
    Weak,
    Fair,
    Strong,
}

/// Điểm độ dài và loại ký tự: chỉ là gợi ý, không đảm bảo an toàn.
pub fn password_strength(pw: &str) -> Strength {
    if pw.is_empty() {
        return Strength::Empty;
    }
    let n = pw.chars().count();
    let score = [
        n >= 8,
        n >= 12,
        pw.chars().any(|c| c.is_ascii_lowercase()) && pw.chars().any(|c| c.is_ascii_uppercase()),
        pw.chars().any(|c| c.is_ascii_digit()),
        pw.chars().any(|c| !c.is_ascii_alphanumeric()),
    ]
    .iter()
    .filter(|b| **b)
    .count();
    match score {
        0..=2 => Strength::Weak,
        3..=4 => Strength::Fair,
        _ => Strength::Strong,
    }
}

#[derive(Clone, Default)]
pub struct PasswordForm {
    pub user_password: String,
    pub user_confirm: String,
    pub owner_password: String,
    pub owner_confirm: String,
}

// Không in mật khẩu ra nhật ký hay thông báo lỗi.
impl std::fmt::Debug for PasswordForm {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("PasswordForm { .. }")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordIssue {
    NoPassword,
    UserMismatch,
    OwnerMismatch,
    OwnerNeedsRights,
}

/// Kiểm form. Danh sách rỗng là áp dụng được. `OwnerNeedsRights`: chỉ có mật khẩu chủ mà không hạn chế
/// quyền nào thì không có gì được thực thi với người đọc.
pub fn validate_passwords(f: &PasswordForm, perms: &Permissions) -> Vec<PasswordIssue> {
    let mut v = Vec::new();
    let (user, owner) = (&f.user_password, &f.owner_password);
    if user.is_empty() && owner.is_empty() {
        v.push(PasswordIssue::NoPassword);
    }
    if !user.is_empty() && *user != f.user_confirm {
        v.push(PasswordIssue::UserMismatch);
    }
    if !owner.is_empty() && *owner != f.owner_confirm {
        v.push(PasswordIssue::OwnerMismatch);
    }
    if user.is_empty() && !owner.is_empty() && perms.allows_all() {
        v.push(PasswordIssue::OwnerNeedsRights);
    }
    v
}

/// `security.encrypt`. Mật khẩu rỗng bị bỏ.
pub fn protection_params(f: &PasswordForm, perms: &Permissions) -> Value {
    let mut v = json!({"permissions": perms.to_json()});
    if !f.user_password.is_empty() {
        v["userPassword"] = f.user_password.as_str().into();
    }
    if !f.owner_password.is_empty() {
        v["ownerPassword"] = f.owner_password.as_str().into();
    }
    v
}

pub fn issue_key(issue: PasswordIssue) -> &'static str {
    match issue {
        PasswordIssue::NoPassword => "security.issue.noPassword",
        PasswordIssue::UserMismatch => "security.issue.userMismatch",
        PasswordIssue::OwnerMismatch => "security.issue.ownerMismatch",
        PasswordIssue::OwnerNeedsRights => "security.issue.ownerNeedsRights",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn form(u: &str, uc: &str, o: &str, oc: &str) -> PasswordForm {
        PasswordForm {
            user_password: u.into(),
            user_confirm: uc.into(),
            owner_password: o.into(),
            owner_confirm: oc.into(),
        }
    }

    #[test]
    fn permission_rules() {
        let p = Permissions::ALL;
        assert!(p.allows_all());
        let q = p.with("printLowRes", false);
        assert_eq!(
            (
                q.get("printLowRes"),
                q.get("printHighRes"),
                q.get("copyContent")
            ),
            (Some(false), Some(false), Some(true))
        );
        let r = q.with("printHighRes", true);
        assert_eq!(
            r.get("printHighRes"),
            Some(true),
            "bật lại riêng từng cờ vẫn được (lõi kiểm sau)"
        );
        assert_eq!(p.with("nope", false), p);
        assert_eq!(p.get("nope"), None);
        assert!(!p.with("modify", false).allows_all());
    }

    #[test]
    fn strength_levels() {
        assert_eq!(password_strength(""), Strength::Empty);
        assert_eq!(password_strength("abc"), Strength::Weak);
        assert_eq!(password_strength("abcdefgh"), Strength::Weak);
        assert_eq!(password_strength("Abcdefg1"), Strength::Fair);
        assert_eq!(password_strength("Abcdefghij1!"), Strength::Strong);
    }

    #[test]
    fn validation() {
        let all = Permissions::ALL;
        let locked = all.with("modify", false);
        assert_eq!(
            validate_passwords(&form("", "", "", ""), &all),
            [PasswordIssue::NoPassword]
        );
        assert!(validate_passwords(&form("a", "a", "", ""), &all).is_empty());
        assert_eq!(
            validate_passwords(&form("a", "b", "", ""), &all),
            [PasswordIssue::UserMismatch]
        );
        assert_eq!(
            validate_passwords(&form("a", "a", "o", "x"), &all),
            [PasswordIssue::OwnerMismatch]
        );
        assert_eq!(
            validate_passwords(&form("", "", "o", "o"), &all),
            [PasswordIssue::OwnerNeedsRights]
        );
        assert!(validate_passwords(&form("", "", "o", "o"), &locked).is_empty());
        assert_eq!(
            issue_key(PasswordIssue::UserMismatch),
            "security.issue.userMismatch"
        );
    }

    #[test]
    fn params_omit_empty_and_debug_hides_secrets() {
        let f = form("mk1", "mk1", "", "");
        let v = protection_params(&f, &Permissions::ALL.with("copyContent", false));
        assert_eq!(
            (
                v["userPassword"].as_str(),
                v.get("ownerPassword"),
                v["permissions"]["copyContent"].as_bool(),
                v["permissions"]["modify"].as_bool()
            ),
            (Some("mk1"), None, Some(false), Some(true))
        );
        let shown = format!("{f:?}");
        assert!(!shown.contains("mk1"), "{shown}");
    }
}
