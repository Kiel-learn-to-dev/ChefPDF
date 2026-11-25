//! Kho ảnh chữ ký mã hóa bằng mật khẩu của app (TASKS_RUST R6.10, FEATURES I19–I23, hướng 1 ngày 2026-11-24).
//!
//! Bản Electron mã hóa ảnh bằng khóa 256 bit nằm trong `safeStorage` (DPAPI); bản Rust không đọc được khóa đó
//! (D73). Ở bản Rust: một **khóa dữ liệu** 256 bit ngẫu nhiên được bọc bằng khóa dẫn xuất từ mật khẩu (Argon2id),
//! cất trong `library/vault.json`. Mở khóa bằng mật khẩu thì khóa dữ liệu nằm trong bộ nhớ (xóa khi khóa lại hoặc
//! hủy). Ảnh dùng cùng khuôn với Electron: `CHLIB1 | iv (12) | tag (16) | ciphertext`, AES-256-GCM, nên file ảnh
//! trên đĩa không đọc được như PNG. **Hệ quả:** ảnh do Electron mã hóa bằng khóa `safeStorage` không mở được ở đây
//! (tag sai thành `Tampered`); cần nhập lại ảnh. Logic thuần: chỉ ghi và đọc `vault.json` qua `std::fs`.
#![allow(dead_code)]

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, OsRng};
use aes_gcm::{Aes256Gcm, Key, KeyInit, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use serde_json::{Value, json};
use zeroize::Zeroizing;

const ITEM_MAGIC: &[u8; 6] = b"CHLIB1";
const WRAP_MAGIC: &[u8; 6] = b"CHVLT1";
const IV_BYTES: usize = 12;
const TAG_BYTES: usize = 16;
const KEY_BYTES: usize = 32;
const SALT_BYTES: usize = 16;
const PNG_SIGNATURE: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/// Tên file vỏ khóa trong thư mục thư viện.
pub const VAULT_FILE: &str = "vault.json";
pub const MIN_PASSWORD_CHARS: usize = 6;

/// Tham số Argon2id. Mặc định theo khuyến nghị OWASP (19 MiB, t=2) nâng lên 64 MiB và t=3 cho máy bàn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KdfParams {
    pub mem_kib: u32,
    pub iterations: u32,
    pub lanes: u32,
}

impl KdfParams {
    pub const DEFAULT: KdfParams = KdfParams {
        mem_kib: 64 * 1024,
        iterations: 3,
        lanes: 1,
    };
    /// Giới hạn trên khi đọc từ đĩa, để file hỏng không bắt máy cấp hàng GiB.
    const MAX_MEM_KIB: u32 = 1024 * 1024;
    const MAX_ITERATIONS: u32 = 10;
    const MAX_LANES: u32 = 8;

    fn in_bounds(self) -> bool {
        self.mem_kib >= 8 * self.lanes
            && self.mem_kib <= Self::MAX_MEM_KIB
            && (1..=Self::MAX_ITERATIONS).contains(&self.iterations)
            && (1..=Self::MAX_LANES).contains(&self.lanes)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VaultError {
    /// Chưa mở khóa.
    Locked,
    /// Mật khẩu sai (hoặc `vault.json` bị sửa).
    WrongPassword,
    /// Dữ liệu bị đổi hoặc không phải file đã mã hóa của kho này.
    Tampered,
    /// Đầu vào không hợp lệ (mật khẩu quá ngắn, không phải PNG, tham số sai).
    Invalid(&'static str),
    /// Chưa tạo kho.
    NotCreated,
    Io(String),
}

impl From<io::Error> for VaultError {
    fn from(e: io::Error) -> Self {
        VaultError::Io(e.to_string())
    }
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn from_hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

fn derive_key(
    password: &str,
    salt: &[u8],
    p: KdfParams,
) -> Result<Zeroizing<[u8; KEY_BYTES]>, VaultError> {
    let params = Params::new(p.mem_kib, p.iterations, p.lanes, Some(KEY_BYTES))
        .map_err(|_| VaultError::Invalid("tham số Argon2 sai"))?;
    let mut out = Zeroizing::new([0u8; KEY_BYTES]);
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(password.as_bytes(), salt, out.as_mut())
        .map_err(|_| VaultError::Invalid("không dẫn xuất được khóa"))?;
    Ok(out)
}

/// Niêm phong: `magic | iv | tag | ciphertext` (cùng bố cục với `sealBytes` của Electron).
fn seal(magic: &[u8; 6], key: &[u8; KEY_BYTES], plain: &[u8]) -> Vec<u8> {
    let mut iv = [0u8; IV_BYTES];
    OsRng.fill_bytes(&mut iv);
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    // aes-gcm trả `ciphertext | tag`; Electron đặt tag trước ciphertext.
    let mut ct_tag = cipher
        .encrypt(Nonce::from_slice(&iv), plain)
        .expect("AES-GCM mã hóa trong bộ nhớ không thất bại");
    let tag = ct_tag.split_off(ct_tag.len() - TAG_BYTES);
    let mut out = Vec::with_capacity(magic.len() + IV_BYTES + TAG_BYTES + ct_tag.len());
    out.extend_from_slice(magic);
    out.extend_from_slice(&iv);
    out.extend_from_slice(&tag);
    out.extend_from_slice(&ct_tag);
    out
}

/// Mở file niêm phong; mọi thay đổi (kể cả tag) là `Tampered`.
fn open(magic: &[u8; 6], key: &[u8; KEY_BYTES], sealed: &[u8]) -> Result<Vec<u8>, VaultError> {
    let header = magic.len() + IV_BYTES + TAG_BYTES;
    if sealed.len() < header || &sealed[..magic.len()] != magic {
        return Err(VaultError::Tampered);
    }
    let iv = &sealed[magic.len()..magic.len() + IV_BYTES];
    let tag = &sealed[magic.len() + IV_BYTES..header];
    let mut ct_tag = sealed[header..].to_vec();
    ct_tag.extend_from_slice(tag);
    Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key))
        .decrypt(Nonce::from_slice(iv), ct_tag.as_slice())
        .map_err(|_| VaultError::Tampered)
}

fn is_png(b: &[u8]) -> bool {
    b.len() >= PNG_SIGNATURE.len() && b[..8] == PNG_SIGNATURE
}

/// Kho: giữ đường dẫn thư mục thư viện và khóa dữ liệu khi đã mở.
pub struct Vault {
    dir: PathBuf,
    key: Option<Zeroizing<[u8; KEY_BYTES]>>,
}

struct VaultFile {
    kdf: KdfParams,
    salt: Vec<u8>,
    wrapped: Vec<u8>,
}

fn read_vault_file(dir: &Path) -> Result<VaultFile, VaultError> {
    let text = match fs::read_to_string(dir.join(VAULT_FILE)) {
        Ok(t) => t,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(VaultError::NotCreated),
        Err(e) => return Err(e.into()),
    };
    let v: Value = serde_json::from_str(&text).map_err(|_| VaultError::Tampered)?;
    let u = |k: &str| v["kdf"][k].as_u64().and_then(|n| u32::try_from(n).ok());
    let kdf = KdfParams {
        mem_kib: u("memKib").ok_or(VaultError::Tampered)?,
        iterations: u("iterations").ok_or(VaultError::Tampered)?,
        lanes: u("lanes").ok_or(VaultError::Tampered)?,
    };
    if v["version"] != 1 || v["kdf"]["alg"] != "argon2id" || !kdf.in_bounds() {
        return Err(VaultError::Tampered);
    }
    Ok(VaultFile {
        kdf,
        salt: v["kdf"]["salt"]
            .as_str()
            .and_then(from_hex)
            .filter(|s| s.len() >= SALT_BYTES)
            .ok_or(VaultError::Tampered)?,
        wrapped: v["wrapped"]
            .as_str()
            .and_then(from_hex)
            .ok_or(VaultError::Tampered)?,
    })
}

fn write_vault_file(
    dir: &Path,
    kdf: KdfParams,
    salt: &[u8],
    wrapped: &[u8],
) -> Result<(), VaultError> {
    let body = json!({
        "version": 1,
        "kdf": { "alg": "argon2id", "memKib": kdf.mem_kib, "iterations": kdf.iterations, "lanes": kdf.lanes, "salt": to_hex(salt) },
        "wrapped": to_hex(wrapped),
    });
    fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{VAULT_FILE}.tmp"));
    fs::write(
        &tmp,
        serde_json::to_string_pretty(&body).unwrap_or_default() + "\n",
    )?;
    fs::rename(&tmp, dir.join(VAULT_FILE))?;
    Ok(())
}

impl Vault {
    /// Kho trong `dir` (thư mục `library`), ở trạng thái khóa.
    pub fn new(dir: impl Into<PathBuf>) -> Vault {
        Vault {
            dir: dir.into(),
            key: None,
        }
    }

    /// Đã tạo kho (có `vault.json`) chưa.
    pub fn exists(&self) -> bool {
        self.dir.join(VAULT_FILE).is_file()
    }

    pub fn is_unlocked(&self) -> bool {
        self.key.is_some()
    }

    /// Tạo kho mới với mật khẩu; mở khóa luôn. Không ghi đè kho đã có.
    pub fn create(&mut self, password: &str, kdf: KdfParams) -> Result<(), VaultError> {
        if password.chars().count() < MIN_PASSWORD_CHARS {
            return Err(VaultError::Invalid("mật khẩu quá ngắn"));
        }
        if !kdf.in_bounds() {
            return Err(VaultError::Invalid("tham số Argon2 ngoài khoảng"));
        }
        if self.exists() {
            return Err(VaultError::Invalid("kho đã tồn tại"));
        }
        let mut salt = [0u8; SALT_BYTES];
        OsRng.fill_bytes(&mut salt);
        let mut data_key = Zeroizing::new([0u8; KEY_BYTES]);
        OsRng.fill_bytes(data_key.as_mut());
        let kek = derive_key(password, &salt, kdf)?;
        let wrapped = seal(WRAP_MAGIC, &kek, data_key.as_ref());
        write_vault_file(&self.dir, kdf, &salt, &wrapped)?;
        self.key = Some(data_key);
        Ok(())
    }

    /// Mở khóa bằng mật khẩu. Sai mật khẩu là `WrongPassword` và kho vẫn khóa.
    pub fn unlock(&mut self, password: &str) -> Result<(), VaultError> {
        let f = read_vault_file(&self.dir)?;
        let kek = derive_key(password, &f.salt, f.kdf)?;
        let key = open(WRAP_MAGIC, &kek, &f.wrapped).map_err(|_| VaultError::WrongPassword)?;
        let arr: [u8; KEY_BYTES] = key.try_into().map_err(|_| VaultError::Tampered)?;
        self.key = Some(Zeroizing::new(arr));
        Ok(())
    }

    /// Khóa lại: xóa khóa dữ liệu khỏi bộ nhớ.
    pub fn lock(&mut self) {
        self.key = None;
    }

    /// Đổi mật khẩu: kiểm mật khẩu cũ, bọc lại cùng khóa dữ liệu (ảnh đã lưu không đổi). Kho giữ trạng thái mở.
    pub fn change_password(
        &mut self,
        old: &str,
        new: &str,
        kdf: KdfParams,
    ) -> Result<(), VaultError> {
        if new.chars().count() < MIN_PASSWORD_CHARS {
            return Err(VaultError::Invalid("mật khẩu mới quá ngắn"));
        }
        if !kdf.in_bounds() {
            return Err(VaultError::Invalid("tham số Argon2 ngoài khoảng"));
        }
        self.unlock(old)?;
        let key = self.key.as_ref().ok_or(VaultError::Locked)?;
        let mut salt = [0u8; SALT_BYTES];
        OsRng.fill_bytes(&mut salt);
        let kek = derive_key(new, &salt, kdf)?;
        let wrapped = seal(WRAP_MAGIC, &kek, key.as_ref());
        write_vault_file(&self.dir, kdf, &salt, &wrapped)
    }

    /// Niêm phong một ảnh PNG để ghi ra `<id>.enc`.
    pub fn seal_item(&self, png: &[u8]) -> Result<Vec<u8>, VaultError> {
        let key = self.key.as_ref().ok_or(VaultError::Locked)?;
        if !is_png(png) {
            return Err(VaultError::Invalid("không phải PNG"));
        }
        Ok(seal(ITEM_MAGIC, key, png))
    }

    /// Mở một file `<id>.enc`; kết quả phải là PNG.
    pub fn open_item(&self, sealed: &[u8]) -> Result<Vec<u8>, VaultError> {
        let key = self.key.as_ref().ok_or(VaultError::Locked)?;
        let plain = open(ITEM_MAGIC, key, sealed)?;
        if !is_png(&plain) {
            return Err(VaultError::Tampered);
        }
        Ok(plain)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Tham số tối thiểu để test nhanh; mặc định thật dùng 64 MiB.
    const FAST: KdfParams = KdfParams {
        mem_kib: 8,
        iterations: 1,
        lanes: 1,
    };

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("chef-vault-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn png() -> Vec<u8> {
        let mut v = PNG_SIGNATURE.to_vec();
        v.extend_from_slice(b"\0\0\0\rIHDR rest of the fake image");
        v
    }

    #[test]
    fn create_seal_and_open_round_trip() {
        let dir = temp("round");
        let mut v = Vault::new(&dir);
        assert!(!v.exists());
        v.create("mật-khẩu-mạnh", FAST).unwrap();
        assert!(v.exists() && v.is_unlocked());
        let sealed = v.seal_item(&png()).unwrap();
        assert_eq!(v.open_item(&sealed).unwrap(), png());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sealed_file_is_not_a_png_and_has_the_electron_layout() {
        let dir = temp("layout");
        let mut v = Vault::new(&dir);
        v.create("123456", FAST).unwrap();
        let sealed = v.seal_item(&png()).unwrap();
        assert!(!is_png(&sealed), "tiêu chí 1: không đọc được như PNG");
        assert_eq!(&sealed[..6], b"CHLIB1");
        assert_eq!(sealed.len(), 6 + 12 + 16 + png().len());
        assert_ne!(
            v.seal_item(&png()).unwrap(),
            sealed,
            "iv ngẫu nhiên mỗi lần"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn wrong_password_does_not_unlock() {
        let dir = temp("wrong");
        let mut v = Vault::new(&dir);
        v.create("đúng-mật-khẩu", FAST).unwrap();
        v.lock();
        let mut again = Vault::new(&dir);
        assert_eq!(again.unlock("sai-mật-khẩu"), Err(VaultError::WrongPassword));
        assert!(!again.is_unlocked());
        assert_eq!(again.seal_item(&png()), Err(VaultError::Locked));
        again.unlock("đúng-mật-khẩu").unwrap();
        assert!(again.is_unlocked());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn locking_clears_the_key_and_items_stay_readable_after_unlock() {
        let dir = temp("lock");
        let mut v = Vault::new(&dir);
        v.create("khóa-lại-nhé", FAST).unwrap();
        let sealed = v.seal_item(&png()).unwrap();
        v.lock();
        assert!(!v.is_unlocked());
        assert_eq!(
            v.open_item(&sealed),
            Err(VaultError::Locked),
            "tiêu chí 3: khóa lại thì không mở được"
        );
        v.unlock("khóa-lại-nhé").unwrap();
        assert_eq!(v.open_item(&sealed).unwrap(), png());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tampering_is_detected() {
        let dir = temp("tamper");
        let mut v = Vault::new(&dir);
        v.create("abcdefg", FAST).unwrap();
        let sealed = v.seal_item(&png()).unwrap();
        for i in [0, 8, 20, sealed.len() - 1] {
            let mut bad = sealed.clone();
            bad[i] ^= 1;
            assert_eq!(v.open_item(&bad), Err(VaultError::Tampered), "byte {i}");
        }
        assert_eq!(v.open_item(&sealed[..10]), Err(VaultError::Tampered));
        // Một file do Electron niêm phong bằng khóa safeStorage khác: cùng bố cục, tag không khớp.
        let other = seal(ITEM_MAGIC, &[7u8; 32], &png());
        assert_eq!(v.open_item(&other), Err(VaultError::Tampered));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_png_is_sealed_and_only_png_comes_out() {
        let dir = temp("png");
        let mut v = Vault::new(&dir);
        v.create("abcdefg", FAST).unwrap();
        assert_eq!(
            v.seal_item(b"not an image"),
            Err(VaultError::Invalid("không phải PNG"))
        );
        let key = v.key.as_ref().unwrap().clone();
        let sealed_text = seal(ITEM_MAGIC, &key, b"plain text payload");
        assert_eq!(v.open_item(&sealed_text), Err(VaultError::Tampered));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn change_password_keeps_items_readable() {
        let dir = temp("change");
        let mut v = Vault::new(&dir);
        v.create("mật-khẩu-cũ", FAST).unwrap();
        let sealed = v.seal_item(&png()).unwrap();
        assert_eq!(
            v.change_password("sai", "mật-khẩu-mới", FAST),
            Err(VaultError::WrongPassword)
        );
        assert_eq!(
            v.change_password("mật-khẩu-cũ", "ngắn", FAST),
            Err(VaultError::Invalid("mật khẩu mới quá ngắn"))
        );
        v.change_password("mật-khẩu-cũ", "mật-khẩu-mới", FAST)
            .unwrap();
        let mut fresh = Vault::new(&dir);
        assert_eq!(fresh.unlock("mật-khẩu-cũ"), Err(VaultError::WrongPassword));
        fresh.unlock("mật-khẩu-mới").unwrap();
        assert_eq!(
            fresh.open_item(&sealed).unwrap(),
            png(),
            "khóa dữ liệu giữ nguyên nên ảnh cũ vẫn mở được"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn create_rejects_short_password_existing_vault_and_bad_params() {
        let dir = temp("rules");
        let mut v = Vault::new(&dir);
        assert_eq!(
            v.create("12345", FAST),
            Err(VaultError::Invalid("mật khẩu quá ngắn"))
        );
        assert!(!v.exists());
        let huge = KdfParams {
            mem_kib: u32::MAX,
            iterations: 1,
            lanes: 1,
        };
        assert!(matches!(
            v.create("abcdefg", huge),
            Err(VaultError::Invalid(_))
        ));
        v.create("abcdefg", FAST).unwrap();
        let mut second = Vault::new(&dir);
        assert_eq!(
            second.create("abcdefg", FAST),
            Err(VaultError::Invalid("kho đã tồn tại"))
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_or_corrupt_vault_file() {
        let dir = temp("corrupt");
        let mut v = Vault::new(&dir);
        assert_eq!(v.unlock("abcdefg"), Err(VaultError::NotCreated));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(VAULT_FILE), "not json").unwrap();
        assert_eq!(v.unlock("abcdefg"), Err(VaultError::Tampered));
        // Tham số Argon2 bị sửa thành quá lớn không được cấp bộ nhớ.
        let body = json!({ "version": 1, "kdf": { "alg": "argon2id", "memKib": 4_000_000_000u64, "iterations": 3, "lanes": 1, "salt": to_hex(&[1u8; 16]) }, "wrapped": "00" });
        fs::write(dir.join(VAULT_FILE), body.to_string()).unwrap();
        assert_eq!(v.unlock("abcdefg"), Err(VaultError::Tampered));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn vault_file_holds_no_key_or_password_in_clear() {
        let dir = temp("clear");
        let mut v = Vault::new(&dir);
        v.create("bí-mật-của-tôi", FAST).unwrap();
        let text = fs::read_to_string(dir.join(VAULT_FILE)).unwrap();
        assert!(!text.contains("bí-mật-của-tôi"));
        let key_hex = to_hex(v.key.as_ref().unwrap().as_ref());
        assert!(!text.contains(&key_hex));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn hex_round_trip() {
        assert_eq!(
            from_hex(&to_hex(&[0, 1, 254, 255])),
            Some(vec![0, 1, 254, 255])
        );
        assert_eq!(from_hex("abc"), None);
        assert_eq!(from_hex("zz"), None);
    }
}
