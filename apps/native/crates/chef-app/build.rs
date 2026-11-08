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
