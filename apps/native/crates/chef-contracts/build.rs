//! Probe R1.42 (TASKS_RUST): sinh struct Rust từ JSON Schema của lõi (core/chef_core/layout/schema.json).
//! Kết quả ghi vào OUT_DIR/layout_types.rs, lib.rs nạp lại bằng include!.

use std::path::PathBuf;

fn main() {
    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let schema_path = manifest.join("../../../../core/chef_core/layout/schema.json");
    println!("cargo:rerun-if-changed={}", schema_path.display());
    let text = std::fs::read_to_string(&schema_path).expect("đọc schema.json của lõi");
    let schema: schemars::schema::RootSchema =
        serde_json::from_str(&text).expect("schema.json không đọc được bằng schemars");
    let mut space = typify::TypeSpace::default();
    space
        .add_root_schema(schema)
        .expect("typify không sinh được type");
    let file: syn::File = syn::parse2(space.to_stream()).expect("mã sinh ra không parse được");
    let out = prettyplease::unparse(&file);
    let dest = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR")).join("layout_types.rs");
    std::fs::write(dest, out).expect("ghi layout_types.rs");
}
