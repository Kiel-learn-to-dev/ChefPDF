//! macOS file dialogs for the native build.

use std::path::{Path, PathBuf};

#[allow(dead_code)]
pub fn open_pdfs(_initial_dir: Option<&Path>) -> Vec<PathBuf> {
    let script = r#"set picked to choose file with prompt "Open PDF" of type {"pdf"} with multiple selections allowed
set output to ""
repeat with itemPath in picked
  set output to output & POSIX path of itemPath & linefeed
end repeat
return output"#;
    let Ok(output) = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", script])
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .collect()
}

#[allow(dead_code)]
pub fn save_pdf(_initial_dir: Option<&Path>, suggested: &str) -> Option<PathBuf> {
    // Pass the suggested name as an argv item so quotes in a filename cannot alter AppleScript.
    let script = r#"on run argv
set picked to choose file name with prompt "Save PDF" default name (item 1 of argv)
return POSIX path of picked
end run"#;
    let output = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", script, "--", suggested])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!path.is_empty()).then(|| PathBuf::from(path))
}
