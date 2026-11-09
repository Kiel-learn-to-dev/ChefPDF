// Sao chép pdfium.dll cạnh chef-app.exe (TASKS_RUST R1.28).
//
// Nguồn: apps/native/third_party/pdfium/pdfium.dll, tải bằng scripts/fetch-pdfium.mjs (build 8125,
// khớp feature pdfium_8125 của pdfium-render). KHÔNG dùng DLL của pypdfium2 (build 8076): thiếu symbol.
// Ghi đè được bằng biến môi trường CHEF_PDFIUM_DLL. Không commit binary.
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=CHEF_PDFIUM_DLL");

    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    // crates/chef-app -> apps/native là hai cấp trên.
    let native = manifest.join("..").join("..");
    let source = std::env::var("CHEF_PDFIUM_DLL")
        .map(PathBuf::from)
        .unwrap_or_else(|_| native.join("third_party").join("pdfium").join("pdfium.dll"));
    println!("cargo:rerun-if-changed={}", source.display());

    // OUT_DIR = target/<profile>/build/<pkg>-<hash>/out; ba cấp trên là target/<profile>.
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let profile_dir = out_dir
        .ancestors()
        .nth(3)
        .expect("không xác định được thư mục profile");

    embed_assets(&native.join("assets"), &out_dir);

    if !Path::new(&source).exists() {
        println!(
            "cargo:warning=không thấy pdfium.dll tại {} (chạy: node scripts/fetch-pdfium.mjs)",
            source.display()
        );
        return;
    }
    let dest = profile_dir.join("pdfium.dll");
    std::fs::copy(&source, &dest).expect("sao chép pdfium.dll thất bại");
}

/// Nhúng mọi tệp trong `assets/` vào exe (TASKS_RUST R1.02). Sinh `OUT_DIR/assets.rs` gồm
/// danh sách `(đường dẫn tương đối có "/", bytes)`; `assets.rs` của chef-app đọc danh sách này.
fn embed_assets(root: &Path, out_dir: &Path) {
    println!("cargo:rerun-if-changed={}", root.display());
    let mut files = Vec::new();
    collect(root, root, &mut files);
    files.sort();

    let mut src = String::from("pub static ASSETS: &[(&str, &[u8])] = &[\n");
    for (rel, abs) in &files {
        println!("cargo:rerun-if-changed={}", abs.display());
        src.push_str(&format!(
            "    ({rel:?}, include_bytes!({:?})),\n",
            abs.display().to_string()
        ));
    }
    src.push_str("];\n");
    std::fs::write(out_dir.join("assets.rs"), src).expect("ghi assets.rs thất bại");
}

fn collect(root: &Path, dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let entries = std::fs::read_dir(dir).expect("không đọc được thư mục assets");
    for entry in entries {
        let path = entry.expect("đọc mục assets thất bại").path();
        if path.is_dir() {
            collect(root, &path, out);
        } else {
            let rel = path
                .strip_prefix(root)
                .expect("tệp assets nằm ngoài thư mục gốc")
                .to_string_lossy()
                .replace('\\', "/");
            out.push((rel, path));
        }
    }
}
