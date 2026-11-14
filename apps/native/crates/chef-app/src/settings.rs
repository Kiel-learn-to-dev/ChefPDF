//! Cài đặt dùng chung với bản Electron (TASKS_RUST R2.14, BLUEPRINT_RUST §7.1, CONTRACTS §7).
//!
//! Đọc và ghi `<userData>/settings.json`, cùng file với bản Electron. Chỉ ba khóa của phần này được
//! đổi (`theme`, `language`, `defaultSaveDir`); mọi khóa khác được giữ nguyên, kể cả khóa chưa biết.
//! Khi ghi, chỉ các khóa đã đổi được vá vào file hiện tại, nên thay đổi do Electron ghi sau lúc đọc
//! không bị mất. Ghi qua file tạm rồi đổi tên, như `atomicWriteFile` của Electron. File hỏng thì báo
//! lỗi và không ghi đè.

// Các hàm ghi và đọc chỉ có chỗ dùng khi dialog Cài đặt được nối vào (R2.14, phần giao diện).
#![allow(dead_code)]

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

/// Tên file cài đặt trong userData (CONTRACTS §7).
pub const FILE_NAME: &str = "settings.json";

/// Thư mục userData của bản Electron: `%APPDATA%\Chef PDF` (productName trong electron-builder.yml).
const APP_DIR: &str = "Chef PDF";

/// Ghi đè thư mục userData. Dùng cho thử nghiệm; người dùng thường không đặt.
pub const ENV_USER_DATA: &str = "CHEF_USER_DATA_DIR";

const KEY_THEME: &str = "theme";
const KEY_LANGUAGE: &str = "language";
const KEY_SAVE_DIR: &str = "defaultSaveDir";
const KEY_RECENT_FILES: &str = "recentFiles";
const MAX_RECENT_FILES: usize = 20;

/// File history record shared with Electron (`settings.recentFiles`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentFile {
    pub path: String,
    pub name: String,
    pub opened_at: String,
}

/// Giá trị mặc định khi tạo file mới, đúng `defaultSettings()` của Electron.
fn defaults() -> Map<String, Value> {
    let v = serde_json::json!({
        "version": 1,
        "language": "vi",
        "theme": "system",
        "defaultSaveDir": null,
        "recentFiles": [],
        "prefs": {},
        "scanPresets": [],
        "knownPfxFiles": [],
        "lastDriverPath": null,
        "signTemplates": [],
        "tsaUrls": [],
        "overlayPresets": [],
        "compressPresets": [],
        "userName": "",
    });
    match v {
        Value::Object(map) => map,
        _ => unreachable!("defaults là một object"),
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

impl Theme {
    pub fn parse(v: &str) -> Option<Theme> {
        match v {
            "system" => Some(Theme::System),
            "light" => Some(Theme::Light),
            "dark" => Some(Theme::Dark),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Theme::System => "system",
            Theme::Light => "light",
            Theme::Dark => "dark",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Language {
    #[default]
    Vi,
    En,
}

impl Language {
    pub fn parse(v: &str) -> Option<Language> {
        match v {
            "vi" => Some(Language::Vi),
            "en" => Some(Language::En),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Language::Vi => "vi",
            Language::En => "en",
        }
    }
}

#[derive(Debug)]
pub enum LoadError {
    Io(io::Error),
    Json(serde_json::Error),
    /// File có JSON nhưng không phải object ở gốc.
    NotObject,
}

impl std::fmt::Display for LoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LoadError::Io(e) => write!(f, "không đọc được settings.json: {e}"),
            LoadError::Json(e) => write!(f, "settings.json không phải JSON hợp lệ: {e}"),
            LoadError::NotObject => write!(f, "settings.json không phải một object"),
        }
    }
}

/// Cài đặt đã đọc. `raw` là ảnh chụp lúc đọc hoặc lúc ghi gần nhất. `dirty` là các khóa đã đổi từ đó.
pub struct Settings {
    path: PathBuf,
    raw: Map<String, Value>,
    dirty: BTreeSet<&'static str>,
}

impl Settings {
    /// Đọc `<dir>/settings.json`. Không có file thì dùng mặc định (chưa ghi cho tới khi `save`).
    pub fn load(dir: &Path) -> Result<Settings, LoadError> {
        let path = dir.join(FILE_NAME);
        let raw = match fs::read_to_string(&path) {
            Ok(text) => match serde_json::from_str::<Value>(&text).map_err(LoadError::Json)? {
                Value::Object(map) => map,
                _ => return Err(LoadError::NotObject),
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => defaults(),
            Err(e) => return Err(LoadError::Io(e)),
        };
        Ok(Settings {
            path,
            raw,
            dirty: BTreeSet::new(),
        })
    }

    /// Giao diện. Giá trị lạ được coi là `system`, không làm hỏng việc đọc.
    pub fn theme(&self) -> Theme {
        self.str_value(KEY_THEME)
            .and_then(Theme::parse)
            .unwrap_or(Theme::System)
    }

    /// Ngôn ngữ. Giá trị lạ được coi là `vi`.
    pub fn language(&self) -> Language {
        self.str_value(KEY_LANGUAGE)
            .and_then(Language::parse)
            .unwrap_or(Language::Vi)
    }

    /// Thư mục lưu mặc định, hoặc `None` khi chưa đặt.
    pub fn default_save_dir(&self) -> Option<&str> {
        self.str_value(KEY_SAVE_DIR).filter(|s| !s.is_empty())
    }

    /// Read valid recent PDF entries in their stored newest-first order, capped at twenty.
    pub fn recent_files(&self) -> Vec<RecentFile> {
        let Some(entries) = self.raw.get(KEY_RECENT_FILES).and_then(Value::as_array) else {
            return Vec::new();
        };
        dedupe_recent(entries.iter().filter_map(|entry| {
            let object = entry.as_object()?;
            Some(RecentFile {
                path: object.get("path")?.as_str()?.to_string(),
                name: object.get("name")?.as_str()?.to_string(),
                opened_at: object.get("openedAt")?.as_str()?.to_string(),
            })
        }))
    }

    /// Replace recent-file history with Electron's `{path,name,openedAt}` records.
    pub fn set_recent_files(&mut self, recent: impl IntoIterator<Item = RecentFile>) {
        let entries: Vec<Value> = dedupe_recent(recent)
            .into_iter()
            .map(|entry| {
                serde_json::json!({
                    "path": entry.path,
                    "name": entry.name,
                    "openedAt": entry.opened_at,
                })
            })
            .collect();
        self.put(KEY_RECENT_FILES, Value::Array(entries));
    }

    /// Add an absolute PDF path to the front of history and de-duplicate according to the host
    /// platform's path-case rules. Saving remains explicit so callers can report write failures.
    pub fn record_recent(&mut self, path: &Path, opened_at: &str) -> io::Result<()> {
        if !path.is_absolute() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "recent file path must be absolute",
            ));
        }
        let path = path.to_string_lossy().into_owned();
        let name = Path::new(&path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        let mut recent = self.recent_files();
        recent.insert(
            0,
            RecentFile {
                path,
                name,
                opened_at: opened_at.to_string(),
            },
        );
        self.set_recent_files(recent);
        Ok(())
    }

    pub fn set_theme(&mut self, theme: Theme) {
        self.put(KEY_THEME, Value::String(theme.as_str().into()));
    }

    pub fn set_language(&mut self, language: Language) {
        self.put(KEY_LANGUAGE, Value::String(language.as_str().into()));
    }

    /// Đặt thư mục mặc định; `None` ghi `null` như Electron.
    pub fn set_default_save_dir(&mut self, dir: Option<&str>) {
        let value = match dir.filter(|d| !d.is_empty()) {
            Some(d) => Value::String(d.into()),
            None => Value::Null,
        };
        self.put(KEY_SAVE_DIR, value);
    }

    /// Ghi `settings.json`. Đọc lại file trước, vì Electron có thể đã ghi sau lúc Rust đọc: chỉ các
    /// khóa đã đổi được vá vào bản hiện tại. File hiện tại hỏng thì báo lỗi và không ghi đè.
    /// Ghi qua file tạm rồi đổi tên. Tạo thư mục nếu chưa có.
    pub fn save(&mut self) -> io::Result<()> {
        let mut current = match fs::read_to_string(&self.path) {
            Ok(text) => match serde_json::from_str::<Value>(&text) {
                Ok(Value::Object(map)) => map,
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "settings.json hỏng, không ghi đè",
                    ));
                }
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => defaults(),
            Err(e) => return Err(e),
        };
        for key in &self.dirty {
            if let Some(value) = self.raw.get(*key) {
                current.insert((*key).to_string(), value.clone());
            }
        }
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let text = serde_json::to_string_pretty(&Value::Object(current.clone()))
            .map_err(io::Error::other)?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, text)?;
        fs::rename(&tmp, &self.path)?;
        self.raw = current;
        self.dirty.clear();
        Ok(())
    }

    /// Nội dung đã biết, để kiểm thử và để so khi cần.
    pub fn raw(&self) -> &Map<String, Value> {
        &self.raw
    }

    fn put(&mut self, key: &'static str, value: Value) {
        self.raw.insert(key.to_string(), value);
        self.dirty.insert(key);
    }

    #[cfg(test)]
    fn dirty_keys(&self) -> Vec<&'static str> {
        self.dirty.iter().copied().collect()
    }

    fn str_value(&self, key: &str) -> Option<&str> {
        self.raw.get(key).and_then(Value::as_str)
    }
}

fn dedupe_recent(entries: impl IntoIterator<Item = RecentFile>) -> Vec<RecentFile> {
    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for entry in entries {
        if entry.path.is_empty() || entry.name.is_empty() || entry.opened_at.is_empty() {
            continue;
        }
        let key = recent_path_key(&entry.path);
        if seen.insert(key) {
            result.push(entry);
            if result.len() == MAX_RECENT_FILES {
                break;
            }
        }
    }
    result
}

#[cfg(any(windows, target_os = "macos"))]
fn recent_path_key(path: &str) -> String {
    path.to_lowercase()
}

#[cfg(not(any(windows, target_os = "macos")))]
fn recent_path_key(path: &str) -> String {
    path.to_string()
}

/// Current UTC timestamp in the ISO-8601 format consumed by Electron's settings parser.
pub fn now_iso_8601() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = duration.as_secs();
    let days = (seconds / 86_400) as i64;
    let day_seconds = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    let hour = day_seconds / 3_600;
    let minute = day_seconds % 3_600 / 60;
    let second = day_seconds % 60;
    let millis = duration.subsec_millis();
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let day_of_era = z - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    (year, month, day)
}

/// Chọn thư mục userData theo thứ tự: biến ghi đè; chế độ E2E dùng thư mục tạm riêng của tiến trình
/// để không đụng dữ liệu thật; còn lại là `%APPDATA%\Chef PDF`. Hàm thuần để kiểm thử.
pub fn resolve_user_data(
    override_dir: Option<PathBuf>,
    e2e: bool,
    appdata: Option<PathBuf>,
    temp: PathBuf,
) -> PathBuf {
    if let Some(dir) = override_dir {
        return dir;
    }
    if e2e {
        return temp.join(format!("chef-e2e-userdata-{}", std::process::id()));
    }
    match appdata {
        Some(dir) => dir.join(APP_DIR),
        None => temp.join("chef-userdata"),
    }
}

/// Thư mục userData cho tiến trình này, đọc biến môi trường.
pub fn user_data_dir() -> PathBuf {
    resolve_user_data(
        std::env::var_os(ENV_USER_DATA).map(PathBuf::from),
        std::env::var("CHEF_E2E").as_deref() == Ok("1"),
        std::env::var_os("APPDATA").map(PathBuf::from),
        std::env::temp_dir(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Thư mục tạm riêng cho mỗi test, xóa khi xong.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> TempDir {
            let dir = std::env::temp_dir()
                .join(format!("chef-settings-test-{name}-{}", std::process::id()));
            let _ = fs::remove_dir_all(&dir);
            fs::create_dir_all(&dir).expect("tạo thư mục tạm");
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// File giống bản Electron đang dùng: có khóa của phần khác mà bản Rust chưa biết.
    fn electron_like() -> &'static str {
        r#"{
  "version": 1,
  "language": "en",
  "theme": "dark",
  "defaultSaveDir": "D:\\Out",
  "recentFiles": [{"path": "C:\\a.pdf", "name": "a.pdf", "openedAt": "2026-11-01T00:00:00Z"}],
  "prefs": {"zoom": {"step": 1.25}},
  "signTemplates": [{"id": "abc", "name": "Mẫu"}],
  "tsaUrls": ["https://tsa.example.com/"],
  "futureKey": {"keep": [1, 2, 3]}
}"#
    }

    #[test]
    fn missing_file_gives_defaults_without_writing() {
        let dir = TempDir::new("missing");
        let s = Settings::load(&dir.0).expect("đọc mặc định");
        assert_eq!(s.theme(), Theme::System);
        assert_eq!(s.language(), Language::Vi);
        assert_eq!(s.default_save_dir(), None);
        assert!(!dir.0.join(FILE_NAME).exists(), "load không được tạo file");
    }

    #[test]
    fn reads_the_three_settings_from_an_electron_file() {
        let dir = TempDir::new("read");
        fs::write(dir.0.join(FILE_NAME), electron_like()).unwrap();
        let s = Settings::load(&dir.0).unwrap();
        assert_eq!(s.theme(), Theme::Dark);
        assert_eq!(s.language(), Language::En);
        assert_eq!(s.default_save_dir(), Some("D:\\Out"));
    }

    #[test]
    fn recent_files_keep_newest_first_order_dedupe_paths_and_cap_at_twenty() {
        let dir = TempDir::new("recent-order");
        let mut s = Settings::load(&dir.0).unwrap();
        let entries = (0..24).map(|index| RecentFile {
            path: recent_test_path(&format!("{index}.pdf")),
            name: format!("{index}.pdf"),
            opened_at: format!("2026-11-{index:02}T00:00:00Z"),
        });
        s.set_recent_files(entries);
        let items = s.recent_files();
        assert_eq!(items.len(), 20);
        assert_eq!(items[0].name, "0.pdf");
        assert_eq!(items[19].name, "19.pdf");

        s.record_recent(
            Path::new(&recent_test_path("3.pdf")),
            "2026-12-01T00:00:00Z",
        )
        .unwrap();
        let items = s.recent_files();
        assert_eq!(items.len(), 20);
        assert_eq!(items[0].name, "3.pdf");
        assert_eq!(items[0].opened_at, "2026-12-01T00:00:00Z");
        assert_eq!(
            items
                .iter()
                .filter(|item| recent_path_key(&item.path)
                    == recent_path_key(&recent_test_path("3.pdf")))
                .count(),
            1
        );
    }

    #[test]
    fn saving_recent_files_preserves_unknown_settings_fields() {
        let dir = TempDir::new("recent-preserve");
        fs::write(dir.0.join(FILE_NAME), electron_like()).unwrap();
        let mut settings = Settings::load(&dir.0).unwrap();
        settings
            .record_recent(
                &std::env::current_dir().unwrap().join("Tài liệu/new.pdf"),
                "2026-11-14T00:00:00.000Z",
            )
            .unwrap();
        settings.save().unwrap();
        let reread = Settings::load(&dir.0).unwrap();
        assert_eq!(reread.recent_files()[0].name, "new.pdf");
        assert_eq!(
            reread.raw().get("futureKey").unwrap()["keep"],
            serde_json::json!([1, 2, 3])
        );
        assert_eq!(reread.raw().get("prefs").unwrap()["zoom"]["step"], 1.25);
    }

    #[test]
    fn malformed_recent_entries_are_skipped_and_relative_paths_cannot_be_added() {
        let dir = TempDir::new("recent-malformed");
        fs::write(
            dir.0.join(FILE_NAME),
            r#"{"recentFiles":[{"path":"/ok.pdf","name":"ok.pdf","openedAt":"2026-01-01T00:00:00Z"},{"path":"/bad.pdf","name":3,"openedAt":""},3]}"#,
        ).unwrap();
        let mut settings = Settings::load(&dir.0).unwrap();
        assert_eq!(settings.recent_files().len(), 1);
        assert_eq!(settings.recent_files()[0].name, "ok.pdf");
        assert!(
            settings
                .record_recent(Path::new("relative.pdf"), "now")
                .is_err()
        );
    }

    #[test]
    fn current_timestamp_uses_iso_8601_utc_shape() {
        let timestamp = now_iso_8601();
        assert_eq!(timestamp.len(), 24);
        assert_eq!(&timestamp[4..5], "-");
        assert_eq!(&timestamp[10..11], "T");
        assert_eq!(&timestamp[23..24], "Z");
    }

    fn recent_test_path(file: &str) -> String {
        if cfg!(windows) {
            format!("C:\\docs\\{file}")
        } else {
            format!("/docs/{file}")
        }
    }

    #[test]
    fn saving_keeps_every_other_key_and_its_value() {
        let dir = TempDir::new("roundtrip");
        fs::write(dir.0.join(FILE_NAME), electron_like()).unwrap();
        let before: Map<String, Value> = serde_json::from_str::<Value>(electron_like())
            .unwrap()
            .as_object()
            .unwrap()
            .clone();

        let mut s = Settings::load(&dir.0).unwrap();
        s.set_theme(Theme::Light);
        s.set_language(Language::Vi);
        s.set_default_save_dir(Some("E:\\Chữ ký"));
        s.save().unwrap();

        let after = Settings::load(&dir.0).unwrap();
        assert_eq!(after.theme(), Theme::Light);
        assert_eq!(after.language(), Language::Vi);
        assert_eq!(after.default_save_dir(), Some("E:\\Chữ ký"));
        for (key, value) in &before {
            if [KEY_THEME, KEY_LANGUAGE, KEY_SAVE_DIR].contains(&key.as_str()) {
                continue;
            }
            assert_eq!(after.raw().get(key), Some(value), "khóa {key} bị đổi");
        }
    }

    #[test]
    fn a_second_writer_between_load_and_save_is_not_lost() {
        // Electron đang chạy ghi recentFiles sau khi Rust đã đọc. Khi Rust đổi theme và ghi, thay đổi
        // của Electron phải còn; chỉ theme là do Rust.
        let dir = TempDir::new("second-writer");
        let path = dir.0.join(FILE_NAME);
        fs::write(&path, electron_like()).unwrap();
        let mut rust = Settings::load(&dir.0).unwrap();

        let electron_recent: Value = serde_json::from_str(
            r#"[{"path": "C:\\mới.pdf", "name": "mới.pdf", "openedAt": "2026-11-09T00:00:00Z"}]"#,
        )
        .unwrap();
        let mut from_electron: Value = serde_json::from_str(electron_like()).unwrap();
        from_electron["recentFiles"] = electron_recent.clone();
        fs::write(&path, from_electron.to_string()).unwrap();

        rust.set_theme(Theme::Light);
        rust.save().unwrap();

        let after: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(after["recentFiles"], electron_recent);
        assert_eq!(after["theme"], "light");
        assert_eq!(
            after["language"], "en",
            "khóa không đổi không được lấy từ ảnh chụp cũ"
        );
        assert_eq!(after["defaultSaveDir"], "D:\\Out");
    }

    #[test]
    fn save_only_patches_the_keys_that_changed() {
        let dir = TempDir::new("dirty");
        fs::write(dir.0.join(FILE_NAME), electron_like()).unwrap();
        let mut s = Settings::load(&dir.0).unwrap();
        assert!(s.dirty_keys().is_empty());
        s.set_language(Language::Vi);
        assert_eq!(s.dirty_keys(), vec!["language"]);
        s.save().unwrap();
        assert!(s.dirty_keys().is_empty(), "save xong thì hết khóa bẩn");
    }

    #[test]
    fn a_corrupt_file_at_save_time_is_not_overwritten() {
        let dir = TempDir::new("corrupt-at-save");
        let path = dir.0.join(FILE_NAME);
        let mut s = Settings::load(&dir.0).unwrap();
        s.set_theme(Theme::Dark);
        fs::write(&path, "{ hỏng").unwrap();
        assert!(s.save().is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ hỏng");
    }

    #[test]
    fn invalid_json_is_an_error_and_the_file_is_left_alone() {
        let dir = TempDir::new("badjson");
        let path = dir.0.join(FILE_NAME);
        fs::write(&path, "{ không phải json").unwrap();
        assert!(matches!(Settings::load(&dir.0), Err(LoadError::Json(_))));
        assert_eq!(fs::read_to_string(&path).unwrap(), "{ không phải json");
    }

    #[test]
    fn a_json_array_at_the_root_is_rejected() {
        let dir = TempDir::new("array");
        fs::write(dir.0.join(FILE_NAME), "[1, 2]").unwrap();
        assert!(matches!(Settings::load(&dir.0), Err(LoadError::NotObject)));
    }

    #[test]
    fn unknown_values_fall_back_without_failing() {
        let dir = TempDir::new("badvalues");
        fs::write(
            dir.0.join(FILE_NAME),
            r#"{"theme": "blue", "language": 5, "defaultSaveDir": ""}"#,
        )
        .unwrap();
        let s = Settings::load(&dir.0).unwrap();
        assert_eq!(s.theme(), Theme::System);
        assert_eq!(s.language(), Language::Vi);
        assert_eq!(s.default_save_dir(), None);
    }

    #[test]
    fn clearing_the_save_dir_writes_null_like_electron() {
        let dir = TempDir::new("null");
        fs::write(dir.0.join(FILE_NAME), electron_like()).unwrap();
        let mut s = Settings::load(&dir.0).unwrap();
        s.set_default_save_dir(None);
        s.save().unwrap();
        let text = fs::read_to_string(dir.0.join(FILE_NAME)).unwrap();
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["defaultSaveDir"], Value::Null);
    }

    #[test]
    fn save_creates_the_directory_and_leaves_no_temp_file() {
        let dir = TempDir::new("create");
        let nested = dir.0.join("sub");
        let mut s = Settings::load(&nested).unwrap();
        s.set_theme(Theme::Dark);
        s.save().unwrap();
        assert!(nested.join(FILE_NAME).exists());
        assert!(!nested.join("settings.json.tmp").exists());
        assert_eq!(Settings::load(&nested).unwrap().theme(), Theme::Dark);
    }

    #[test]
    fn user_data_dir_prefers_override_then_e2e_then_appdata() {
        let temp = PathBuf::from("T");
        let appdata = Some(PathBuf::from("A"));
        assert_eq!(
            resolve_user_data(
                Some(PathBuf::from("X")),
                true,
                appdata.clone(),
                temp.clone()
            ),
            PathBuf::from("X")
        );
        assert_eq!(
            resolve_user_data(None, true, appdata.clone(), temp.clone()),
            PathBuf::from("T").join(format!("chef-e2e-userdata-{}", std::process::id()))
        );
        assert_eq!(
            resolve_user_data(None, false, appdata, temp.clone()),
            PathBuf::from("A").join("Chef PDF")
        );
        assert_eq!(
            resolve_user_data(None, false, None, temp),
            PathBuf::from("T").join("chef-userdata")
        );
    }

    #[test]
    fn theme_and_language_strings_round_trip() {
        for t in [Theme::System, Theme::Light, Theme::Dark] {
            assert_eq!(Theme::parse(t.as_str()), Some(t));
        }
        for l in [Language::Vi, Language::En] {
            assert_eq!(Language::parse(l.as_str()), Some(l));
        }
        assert_eq!(Theme::parse("blue"), None);
        assert_eq!(Language::parse("fr"), None);
    }
}
