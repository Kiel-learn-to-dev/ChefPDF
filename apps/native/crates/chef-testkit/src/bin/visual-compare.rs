//! Compare Rust screenshots with Electron references using a JSON manifest.
//!
//! Usage: cargo run -p chef-testkit --bin visual-compare -- pairs.json report-dir
//! Manifest paths are resolved relative to the manifest file unless absolute.
//! Manifest shape: {"config":{"tile":16},"jobs":[{"name":"start-light",
//! "reference":"refs/start.png","candidate":"captures/start.png"}]}.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use chef_testkit::visual::{self, Job};
use serde_json::Value;

fn manifest_jobs(manifest_path: &Path, root: &Value) -> Result<Vec<Job>, String> {
    let entries = root
        .get("jobs")
        .and_then(Value::as_array)
        .ok_or("manifest must contain a `jobs` array")?;
    if entries.is_empty() {
        return Err("manifest `jobs` array must not be empty".into());
    }

    let base = manifest_path.parent().unwrap_or_else(|| Path::new("."));
    let mut diff_names = HashSet::new();
    entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let name = entry
                .get("name")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| format!("jobs[{index}].name must be a non-empty string"))?;
            let diff_name: String = name
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            if !diff_names.insert(diff_name) {
                return Err(format!(
                    "jobs[{index}].name collides with another report/diff name"
                ));
            }
            let path = |key: &str| -> Result<PathBuf, String> {
                let value = entry
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .ok_or_else(|| format!("jobs[{index}].{key} must be a non-empty path"))?;
                let path = PathBuf::from(value);
                Ok(if path.is_absolute() {
                    path
                } else {
                    base.join(path)
                })
            };
            Ok(Job {
                name: name.to_owned(),
                reference: path("reference")?,
                candidate: path("candidate")?,
            })
        })
        .collect()
}

fn run(manifest_path: &Path, out_dir: &Path) -> Result<bool, String> {
    let manifest_text = std::fs::read_to_string(manifest_path)
        .map_err(|error| format!("read {}: {error}", manifest_path.display()))?;
    let manifest: Value = serde_json::from_str(&manifest_text)
        .map_err(|error| format!("parse {}: {error}", manifest_path.display()))?;
    let jobs = manifest_jobs(manifest_path, &manifest)?;
    if manifest
        .get("config")
        .is_some_and(|config| !config.is_object())
    {
        return Err("manifest `config` must be a JSON object".into());
    }
    let config_text = serde_json::to_string(manifest.get("config").unwrap_or(&Value::Null))
        .map_err(|error| format!("serialize config: {error}"))?;
    let config = visual::config_from_json(&config_text)?;
    let results = visual::run(&jobs, out_dir, &config)?;
    visual::write_reports(&results, out_dir, &config)?;

    let failed = results
        .iter()
        .filter(|result| !result.verdict.passed)
        .count();
    println!("Compared {} visual pairs; {failed} failed.", results.len());
    println!("JSON: {}", out_dir.join("report.json").display());
    println!("HTML: {}", out_dir.join("report.html").display());
    Ok(failed == 0)
}

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 2 {
        eprintln!("Usage: visual-compare <pairs.json> <report-dir>");
        std::process::exit(64);
    }
    let manifest = PathBuf::from(&args[0]);
    let out_dir = PathBuf::from(&args[1]);
    match run(&manifest, &out_dir) {
        Ok(true) => {}
        Ok(false) => std::process::exit(1),
        Err(error) => {
            eprintln!("visual-compare: {error}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_resolves_relative_and_absolute_pairs() {
        let base = Path::new("refs");
        let absolute = std::env::temp_dir().join("candidate.png");
        let manifest = serde_json::json!({
            "jobs": [
                {"name":"light start", "reference":"light/start.png", "candidate":"rust/start.png"},
                {"name":"dark start", "reference":"dark/start.png", "candidate":absolute}
            ]
        });
        let jobs = manifest_jobs(base.join("pairs.json").as_path(), &manifest).unwrap();
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0].reference, base.join("light/start.png"));
        assert_eq!(jobs[0].candidate, base.join("rust/start.png"));
        assert_eq!(jobs[1].candidate, absolute);
    }

    #[test]
    fn manifest_rejects_missing_or_empty_jobs() {
        assert!(manifest_jobs(Path::new("pairs.json"), &serde_json::json!({})).is_err());
        assert!(manifest_jobs(Path::new("pairs.json"), &serde_json::json!({"jobs": []})).is_err());
    }

    #[test]
    fn manifest_rejects_names_that_collide_in_diff_output() {
        let manifest = serde_json::json!({
            "jobs": [
                {"name":"start/light", "reference":"ref.png", "candidate":"cand.png"},
                {"name":"start:light", "reference":"ref.png", "candidate":"cand.png"}
            ]
        });
        assert!(
            manifest_jobs(Path::new("pairs.json"), &manifest)
                .unwrap_err()
                .contains("collides")
        );
    }

    #[test]
    fn run_writes_aggregate_report_and_diff_for_failed_pair() {
        let dir = std::env::temp_dir().join(format!("chef-visual-cli-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("refs")).unwrap();
        std::fs::create_dir_all(dir.join("candidates")).unwrap();

        let mut reference = image::RgbaImage::from_pixel(64, 64, image::Rgba([255, 255, 255, 255]));
        let mut shifted = reference.clone();
        for y in 16..40 {
            for x in 16..40 {
                reference.put_pixel(x, y, image::Rgba([0, 0, 0, 255]));
            }
            for x in 17..41 {
                shifted.put_pixel(x, y, image::Rgba([0, 0, 0, 255]));
            }
        }
        reference.save(dir.join("refs/base.png")).unwrap();
        reference.save(dir.join("candidates/same.png")).unwrap();
        shifted.save(dir.join("candidates/shifted.png")).unwrap();
        std::fs::write(
            dir.join("pairs.json"),
            r#"{"jobs":[
                {"name":"identical","reference":"refs/base.png","candidate":"candidates/same.png"},
                {"name":"shifted","reference":"refs/base.png","candidate":"candidates/shifted.png"}
            ]}"#,
        )
        .unwrap();

        assert!(!run(&dir.join("pairs.json"), &dir.join("report")).unwrap());
        let report: Value =
            serde_json::from_slice(&std::fs::read(dir.join("report/report.json")).unwrap())
                .unwrap();
        assert_eq!(report["total"], 2);
        assert_eq!(report["failed"], 1);
        assert_eq!(report["screens"][0]["score"], 1.0);
        assert_eq!(report["screens"][0]["passed"], true);
        assert_eq!(report["screens"][1]["passed"], false);
        assert!(dir.join("report/report.html").is_file());
        assert!(dir.join("report/diff/shifted.png").is_file());
        let _ = std::fs::remove_dir_all(dir);
    }
}
