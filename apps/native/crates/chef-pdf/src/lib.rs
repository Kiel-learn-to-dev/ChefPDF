//! Xem PDF bằng pdfium (TASKS_RUST M1.4). Mọi lệnh pdfium chạy trên một luồng render (render.rs),
//! vì pdfium không an toàn luồng (BLUEPRINT_RUST §2.1). UI chỉ gửi yêu cầu và nhận ảnh BGRA.

pub mod render;

use std::path::Path;

use pdfium_render::prelude::Pdfium;

/// Nạp pdfium từ thư mục `dir` (nơi có pdfium.dll cạnh exe). Trả lỗi nếu DLL không nạp được.
pub fn bind(dir: &Path) -> Result<Pdfium, String> {
    let path = Pdfium::pdfium_platform_library_name_at_path(dir);
    let bindings = Pdfium::bind_to_library(&path)
        .map_err(|e| format!("không nạp được {}: {e}", path.display()))?;
    Ok(Pdfium::new(bindings))
}
