//! Bộ so ảnh ui-audit (TASKS_RUST R2.02, BLUEPRINT_RUST §6.8): so từng màn hình giữa ảnh Rust và ảnh
//! tham chiếu của Electron theo lưới ô, rồi ghi báo cáo JSON, HTML và ảnh chênh lệch.
//!
//! Một ô bị coi là lệch khi độ chênh lệch kênh trung bình (0–255) của ô vượt `tile_mean_tolerance`.
//! Màn hình đạt khi hai ảnh cùng kích thước và tỉ lệ ô lệch không vượt `max_bad_ratio`.
//! Khử răng cưa chữ chỉ đổi vài điểm ảnh ở mép chữ nên trung bình ô tăng ít; lệch 1 px của chữ làm
//! trung bình ô tăng nhiều. Ngưỡng nằm trong file cấu hình JSON (`config_from_json`).

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use image::RgbaImage;

/// Ngưỡng so ảnh. Giá trị mặc định dùng khi file cấu hình không ghi khóa đó.
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    /// Cạnh của ô vuông tính bằng điểm ảnh.
    pub tile: u32,
    /// Trung bình chênh lệch kênh (0–255) của một ô vượt mức này thì ô bị lệch.
    pub tile_mean_tolerance: f64,
    /// Tỉ lệ ô lệch tối đa để màn hình đạt (0–1).
    pub max_bad_ratio: f64,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            tile: 16,
            tile_mean_tolerance: 6.0,
            max_bad_ratio: 0.02,
        }
    }
}

/// Đọc cấu hình từ JSON, ví dụ `{"tile": 16, "tileMeanTolerance": 6.0, "maxBadRatio": 0.02}`.
/// Khóa thiếu thì lấy mặc định; giá trị ngoài miền thì báo lỗi.
pub fn config_from_json(text: &str) -> Result<Config, String> {
    let v: serde_json::Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    let mut cfg = Config::default();
    if let Some(t) = v.get("tile") {
        let t = t.as_u64().ok_or("tile phải là số nguyên dương")?;
        if t == 0 {
            return Err("tile phải lớn hơn 0".into());
        }
        cfg.tile = u32::try_from(t).map_err(|_| "tile quá lớn")?;
    }
    if let Some(t) = v.get("tileMeanTolerance") {
        let t = t.as_f64().ok_or("tileMeanTolerance phải là số")?;
        if !(0.0..=255.0).contains(&t) {
            return Err("tileMeanTolerance phải trong khoảng 0–255".into());
        }
        cfg.tile_mean_tolerance = t;
    }
    if let Some(r) = v.get("maxBadRatio") {
        let r = r.as_f64().ok_or("maxBadRatio phải là số")?;
        if !(0.0..=1.0).contains(&r) {
            return Err("maxBadRatio phải trong khoảng 0–1".into());
        }
        cfg.max_bad_ratio = r;
    }
    Ok(cfg)
}

/// Kết quả so một cặp ảnh.
#[derive(Clone, Debug, PartialEq)]
pub struct Verdict {
    pub size_match: bool,
    pub tiles: u32,
    pub bad_tiles: u32,
    pub bad_ratio: f64,
    /// 1 là giống hệt; 0 khi kích thước khác nhau.
    pub score: f64,
    pub passed: bool,
}

/// Ô lệch theo từng vị trí lưới (hàng-cột), dùng chung cho điểm và ảnh chênh lệch.
fn bad_tiles(reference: &RgbaImage, candidate: &RgbaImage, cfg: &Config) -> (Vec<bool>, u32, u32) {
    let (w, h) = reference.dimensions();
    let t = cfg.tile.max(1);
    let cols = w.div_ceil(t);
    let rows = h.div_ceil(t);
    let mut flags = Vec::with_capacity((cols * rows) as usize);
    for ty in 0..rows {
        for tx in 0..cols {
            let (x0, y0) = (tx * t, ty * t);
            let (x1, y1) = ((x0 + t).min(w), (y0 + t).min(h));
            let mut sum = 0u64;
            for y in y0..y1 {
                for x in x0..x1 {
                    let a = reference.get_pixel(x, y).0;
                    let b = candidate.get_pixel(x, y).0;
                    sum += a
                        .iter()
                        .zip(b.iter())
                        .take(3)
                        .map(|(p, q)| u64::from(p.abs_diff(*q)))
                        .sum::<u64>();
                }
            }
            let n = u64::from(x1 - x0) * u64::from(y1 - y0) * 3;
            let mean = sum as f64 / n as f64;
            flags.push(mean > cfg.tile_mean_tolerance);
        }
    }
    let bad = flags.iter().filter(|f| **f).count() as u32;
    (flags, cols * rows, bad)
}

/// So hai ảnh. Kích thước khác nhau thì không đạt, không cần so ô.
pub fn compare(reference: &RgbaImage, candidate: &RgbaImage, cfg: &Config) -> Verdict {
    if reference.dimensions() != candidate.dimensions() {
        return Verdict {
            size_match: false,
            tiles: 0,
            bad_tiles: 0,
            bad_ratio: 1.0,
            score: 0.0,
            passed: false,
        };
    }
    let (_, tiles, bad) = bad_tiles(reference, candidate, cfg);
    let bad_ratio = if tiles == 0 {
        0.0
    } else {
        f64::from(bad) / f64::from(tiles)
    };
    Verdict {
        size_match: true,
        tiles,
        bad_tiles: bad,
        bad_ratio,
        score: 1.0 - bad_ratio,
        passed: bad_ratio <= cfg.max_bad_ratio,
    }
}

/// Ảnh chênh lệch: ảnh Rust làm mờ đi, ô lệch tô đỏ nửa trong suốt. Chỉ dựng khi kích thước khớp.
pub fn diff_image(reference: &RgbaImage, candidate: &RgbaImage, cfg: &Config) -> Option<RgbaImage> {
    if reference.dimensions() != candidate.dimensions() {
        return None;
    }
    let (flags, _, _) = bad_tiles(reference, candidate, cfg);
    let (w, h) = candidate.dimensions();
    let t = cfg.tile.max(1);
    let cols = w.div_ceil(t);
    let mut out = candidate.clone();
    for y in 0..h {
        for x in 0..w {
            let idx = ((y / t) * cols + x / t) as usize;
            let p = out.get_pixel_mut(x, y);
            if flags[idx] {
                p.0 = blend(p.0, [255, 0, 0, 255], 0.5);
            } else {
                p.0 = blend(p.0, [255, 255, 255, 255], 0.6);
            }
        }
    }
    Some(out)
}

fn blend(base: [u8; 4], over: [u8; 4], alpha: f64) -> [u8; 4] {
    let mix = |b: u8, o: u8| (f64::from(b) * (1.0 - alpha) + f64::from(o) * alpha).round() as u8;
    [
        mix(base[0], over[0]),
        mix(base[1], over[1]),
        mix(base[2], over[2]),
        base[3],
    ]
}

/// Một cặp cần so, theo tên màn hình.
#[derive(Clone, Debug)]
pub struct Job {
    pub name: String,
    pub reference: PathBuf,
    pub candidate: PathBuf,
}

/// Kết quả một màn hình kèm đường dẫn để báo cáo HTML.
#[derive(Clone, Debug)]
pub struct ScreenResult {
    pub name: String,
    pub reference: PathBuf,
    pub candidate: PathBuf,
    pub diff_png: Option<PathBuf>,
    pub verdict: Verdict,
}

fn load(path: &Path) -> Result<RgbaImage, String> {
    image::open(path)
        .map(|img| img.to_rgba8())
        .map_err(|e| format!("không đọc được {}: {e}", path.display()))
}

/// Chạy so cho từng cặp, ghi ảnh chênh lệch vào `out_dir/diff/`. Lỗi đọc file thì dừng và báo lỗi.
pub fn run(jobs: &[Job], out_dir: &Path, cfg: &Config) -> Result<Vec<ScreenResult>, String> {
    let diff_dir = out_dir.join("diff");
    std::fs::create_dir_all(&diff_dir).map_err(|e| e.to_string())?;
    let mut results = Vec::with_capacity(jobs.len());
    for job in jobs {
        let reference = load(&job.reference)?;
        let candidate = load(&job.candidate)?;
        let verdict = compare(&reference, &candidate, cfg);
        let diff_png = match diff_image(&reference, &candidate, cfg) {
            Some(img) => {
                let path = diff_dir.join(format!("{}.png", safe_file_name(&job.name)));
                img.save(&path).map_err(|e| e.to_string())?;
                Some(path)
            }
            None => None,
        };
        results.push(ScreenResult {
            name: job.name.clone(),
            reference: job.reference.clone(),
            candidate: job.candidate.clone(),
            diff_png,
            verdict,
        });
    }
    Ok(results)
}

fn safe_file_name(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn json_str(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn file_url(path: &Path) -> String {
    let p = path.to_string_lossy().replace('\\', "/");
    format!("file:///{}", p.trim_start_matches('/'))
}

/// Báo cáo JSON: danh sách màn hình, điểm, số ô lệch và trạng thái đạt, kèm ngưỡng đã dùng.
pub fn report_json(results: &[ScreenResult], cfg: &Config) -> String {
    let mut out = String::new();
    let _ = write!(
        out,
        "{{\n  \"config\": {{\"tile\": {}, \"tileMeanTolerance\": {}, \"maxBadRatio\": {}}},\n",
        cfg.tile, cfg.tile_mean_tolerance, cfg.max_bad_ratio
    );
    let failed = results.iter().filter(|r| !r.verdict.passed).count();
    let _ = write!(
        out,
        "  \"total\": {},\n  \"failed\": {},\n  \"screens\": [\n",
        results.len(),
        failed
    );
    for (i, r) in results.iter().enumerate() {
        let v = &r.verdict;
        let _ = write!(
            out,
            "    {{\"name\": {}, \"passed\": {}, \"sizeMatch\": {}, \"score\": {:.4}, \"badTiles\": {}, \"tiles\": {}}}",
            json_str(&r.name),
            v.passed,
            v.size_match,
            v.score,
            v.bad_tiles,
            v.tiles
        );
        out.push_str(if i + 1 < results.len() { ",\n" } else { "\n" });
    }
    out.push_str("  ]\n}\n");
    out
}

/// Báo cáo HTML: mỗi màn hình có ảnh Electron, ảnh Rust và ảnh chênh lệch để xem bằng mắt (MAN-5).
pub fn report_html(results: &[ScreenResult]) -> String {
    let failed = results.iter().filter(|r| !r.verdict.passed).count();
    let mut out = String::from(
        "<!doctype html><meta charset=\"utf-8\"><title>ui-audit</title>\
         <style>body{font-family:sans-serif;margin:16px}\
         .row{border-top:1px solid #ccc;padding:8px 0}\
         .fail{color:#b00020}.imgs img{max-width:31%;margin-right:1%;border:1px solid #ddd}</style>\n",
    );
    let _ = writeln!(
        out,
        "<h1>ui-audit: {} màn hình, {} không đạt</h1>",
        results.len(),
        failed
    );
    for r in results {
        let v = &r.verdict;
        let class = if v.passed { "" } else { " class=\"fail\"" };
        let _ = writeln!(
            out,
            "<div class=\"row\"><h3{class}>{} — {} (điểm {:.4}, ô lệch {}/{})</h3><div class=\"imgs\">",
            html_escape(&r.name),
            if v.passed { "đạt" } else { "không đạt" },
            v.score,
            v.bad_tiles,
            v.tiles
        );
        let _ = writeln!(
            out,
            "<img src=\"{}\" alt=\"Electron\"><img src=\"{}\" alt=\"Rust\">",
            html_escape(&file_url(&r.reference)),
            html_escape(&file_url(&r.candidate))
        );
        if let Some(diff) = &r.diff_png {
            let _ = writeln!(
                out,
                "<img src=\"{}\" alt=\"chênh lệch\">",
                html_escape(&file_url(diff))
            );
        }
        out.push_str("</div></div>\n");
    }
    out
}

/// Ghi `report.json` và `report.html` vào `out_dir`.
pub fn write_reports(results: &[ScreenResult], out_dir: &Path, cfg: &Config) -> Result<(), String> {
    std::fs::create_dir_all(out_dir).map_err(|e| e.to_string())?;
    std::fs::write(out_dir.join("report.json"), report_json(results, cfg))
        .map_err(|e| e.to_string())?;
    std::fs::write(out_dir.join("report.html"), report_html(results)).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use image::Rgba;

    use super::*;

    /// Nền trắng với một khối "chữ" đen ở giữa.
    fn page(w: u32, h: u32, shift: u32) -> RgbaImage {
        let mut img = RgbaImage::from_pixel(w, h, Rgba([255, 255, 255, 255]));
        for y in 40..60 {
            for x in (40 + shift)..(120 + shift) {
                img.put_pixel(x, y, Rgba([20, 20, 20, 255]));
            }
        }
        img
    }

    #[test]
    fn identical_images_score_one_and_pass() {
        let a = page(200, 120, 0);
        let v = compare(&a, &a, &Config::default());
        assert!(v.size_match && v.passed);
        assert_eq!(v.bad_tiles, 0);
        assert_eq!(v.score, 1.0);
    }

    #[test]
    fn one_pixel_shift_of_text_is_caught() {
        let a = page(200, 120, 0);
        let b = page(200, 120, 1);
        let v = compare(&a, &b, &Config::default());
        assert!(
            !v.passed,
            "lệch 1 px phải vượt ngưỡng, ô lệch {}/{}",
            v.bad_tiles, v.tiles
        );
        assert!(v.bad_tiles > 0);
    }

    #[test]
    fn small_antialias_noise_stays_under_the_threshold() {
        let a = page(200, 120, 0);
        let mut b = a.clone();
        // Biến thiên ±2 ở một số điểm ảnh quanh mép chữ, như khử răng cưa khác nhau.
        for y in 39..61 {
            for x in [39u32, 40, 119, 120] {
                let p = b.get_pixel_mut(x, y);
                p.0[0] = p.0[0].saturating_add(2);
                p.0[1] = p.0[1].saturating_add(2);
            }
        }
        let v = compare(&a, &b, &Config::default());
        assert!(v.passed, "khử răng cưa không được vượt ngưỡng: {v:?}");
    }

    #[test]
    fn color_change_is_caught() {
        let a = page(200, 120, 0);
        let mut b = a.clone();
        for y in 0..120 {
            for x in 0..200 {
                let p = b.get_pixel_mut(x, y);
                if p.0[0] == 255 {
                    p.0 = [235, 235, 235, 255];
                }
            }
        }
        let v = compare(&a, &b, &Config::default());
        assert!(!v.passed);
    }

    #[test]
    fn size_mismatch_fails_without_comparing_tiles() {
        let v = compare(&page(200, 120, 0), &page(200, 121, 0), &Config::default());
        assert!(!v.size_match && !v.passed);
        assert_eq!(v.score, 0.0);
    }

    #[test]
    fn config_reads_keys_and_rejects_bad_values() {
        let cfg = config_from_json(r#"{"tile": 8, "maxBadRatio": 0.05}"#).unwrap();
        assert_eq!(cfg.tile, 8);
        assert_eq!(cfg.max_bad_ratio, 0.05);
        assert_eq!(cfg.tile_mean_tolerance, 6.0);
        assert!(config_from_json(r#"{"tile": 0}"#).is_err());
        assert!(config_from_json(r#"{"maxBadRatio": 1.5}"#).is_err());
        assert!(config_from_json("not json").is_err());
    }

    #[test]
    fn run_writes_diff_and_reports() {
        let dir = std::env::temp_dir().join(format!("chef-visual-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let ref_path = dir.join("ref.png");
        let cand_path = dir.join("cand.png");
        page(200, 120, 0).save(&ref_path).unwrap();
        page(200, 120, 3).save(&cand_path).unwrap();
        let jobs = [Job {
            name: "start <screen>".into(),
            reference: ref_path,
            candidate: cand_path,
        }];
        let out = dir.join("out");
        let cfg = Config::default();
        let results = run(&jobs, &out, &cfg).unwrap();
        assert_eq!(results.len(), 1);
        assert!(!results[0].verdict.passed);
        let diff = results[0]
            .diff_png
            .clone()
            .expect("kích thước khớp nên có ảnh chênh lệch");
        assert!(diff.exists());
        write_reports(&results, &out, &cfg).unwrap();
        let json = std::fs::read_to_string(out.join("report.json")).unwrap();
        assert!(json.contains("\"failed\": 1"));
        assert!(json.contains("start <screen>"));
        let html = std::fs::read_to_string(out.join("report.html")).unwrap();
        assert!(html.contains("start &lt;screen&gt;"));
        assert!(html.contains("không đạt"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
