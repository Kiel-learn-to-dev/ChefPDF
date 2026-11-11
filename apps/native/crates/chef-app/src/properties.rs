//! Hộp thoại Thuộc tính tài liệu (TASKS_RUST R2.27, FEATURES B7): tên và vị trí file, dung lượng, phiên
//! bản PDF, số trang, khổ trang hiện tại, và thông tin mô tả. Số liệu lấy từ pdfium (chef-pdf `props`).
//!
//! Định dạng: dung lượng và khổ giấy theo cùng quy tắc của bản Electron (lib/format.ts), số thập phân
//! dùng dấu phẩy như `vi`. Ngày PDF hiển thị theo giờ ghi trong file, không đổi sang giờ máy (lệch
//! so với `Intl` của Electron, ghi ở TASKS_RUST). Phần font, chữ ký và mã hóa thuộc M3.

use gpui::{App, FontWeight, IntoElement, Window, div, prelude::*, px, rgba};

use chef_ui::button::{Button, Variant, pack};
use chef_ui::dialog::{Dialog, Width};
use chef_ui::i18n::{t, t_with};

/// Số liệu của một lần mở hộp thoại.
#[derive(Clone, Debug, Default)]
pub struct View {
    pub file_name: String,
    /// Đường dẫn đầy đủ, hoặc None khi chưa có file.
    pub location: Option<String>,
    pub file_size: u64,
    pub version: String,
    pub page_count: usize,
    /// Khổ trang hiện tại, pt. (0, 0) khi chưa đọc được.
    pub page_pt: (f32, f32),
    pub page_no: usize,
    /// Giá trị metadata theo thứ tự cố định: (khóa, giá trị). Giá trị rỗng là chưa có.
    pub metadata: Vec<(&'static str, String)>,
}

/// "1,5 KB", "2 KB", "512 B". Cùng ngưỡng với formatBytes: chữ số thập phân khi nhỏ hơn 100.
pub fn format_bytes(bytes: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let mut v = bytes as f64;
    let mut u = 0;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    let digits = if u == 0 || v >= 100.0 { 0 } else { 1 };
    let mut s = format!("{v:.digits$}");
    if s.contains('.') {
        s = s.trim_end_matches('0').trim_end_matches('.').to_string();
    }
    format!("{} {}", s.replace('.', ","), UNITS[u])
}

const PT_PER_MM: f32 = 72.0 / 25.4;

/// Khổ giấy chuẩn, mm (cùng bảng với formatPageSize).
const PAPER: [(&str, f32, f32); 5] = [
    ("A3", 297.0, 420.0),
    ("A4", 210.0, 297.0),
    ("A5", 148.0, 210.0),
    ("Letter", 215.9, 279.4),
    ("Legal", 215.9, 355.6),
];

/// "210 × 297 mm (A4)"; khổ ngang thêm nhãn, như "297 × 210 mm (A4, ngang)".
pub fn format_page_size(width_pt: f32, height_pt: f32, landscape_label: &str) -> String {
    let w = width_pt / PT_PER_MM;
    let h = height_pt / PT_PER_MM;
    let base = format!("{} × {} mm", w.round() as i64, h.round() as i64);
    let paper = PAPER.iter().find(|(_, pw, ph)| {
        ((pw - w).abs() < 2.0 && (ph - h).abs() < 2.0)
            || ((pw - h).abs() < 2.0 && (ph - w).abs() < 2.0)
    });
    match paper {
        Some((name, _, _)) if w > h => format!("{base} ({name}, {landscape_label})"),
        Some((name, _, _)) => format!("{base} ({name})"),
        None => base,
    }
}

/// "D:20260102030405+07'00'" thành "02/01/2026 03:04". Chuỗi không đúng dạng thì giữ nguyên.
pub fn format_pdf_date(value: &str) -> String {
    let digits: String = value
        .strip_prefix("D:")
        .unwrap_or("")
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.len() < 8 || !value.starts_with("D:") {
        return value.to_string();
    }
    let at = |from: usize, to: usize, default: &str| -> String {
        digits
            .get(from..to.min(digits.len()))
            .filter(|s| !s.is_empty())
            .unwrap_or(default)
            .to_string()
    };
    format!(
        "{}/{}/{} {}:{}",
        at(6, 8, "01"),
        at(4, 6, "01"),
        at(0, 4, "0000"),
        at(8, 10, "00"),
        at(10, 12, "00"),
    )
}

/// Dạng hiển thị của một giá trị metadata: ngày PDF đổi định dạng, rỗng thành gạch ngang.
pub fn meta_display(key: &str, value: &str) -> String {
    if value.is_empty() {
        "–".into()
    } else if key.ends_with("Date") {
        format_pdf_date(value)
    } else {
        value.to_string()
    }
}

/// Các dòng hiển thị (nhãn đã dịch, giá trị) theo đúng thứ tự của bản Electron.
pub fn rows(view: &View) -> Vec<(String, String)> {
    let page_size = if view.page_pt.0 > 0.0 {
        format!(
            "{} · {}",
            format_page_size(view.page_pt.0, view.page_pt.1, &t("properties.landscape")),
            t_with("properties.pageN", &[("page", &view.page_no.to_string())])
        )
    } else {
        "–".into()
    };
    let mut out = vec![
        (t("properties.file"), view.file_name.clone()),
        (
            t("properties.location"),
            view.location
                .clone()
                .unwrap_or_else(|| t("properties.unsaved")),
        ),
        (t("properties.fileSize"), format_bytes(view.file_size)),
        (t("properties.pdfVersion"), view.version.clone()),
        (t("properties.pageCount"), view.page_count.to_string()),
        (t("properties.pageSize"), page_size),
    ];
    for (key, value) in &view.metadata {
        out.push((
            t(&format!("properties.meta.{key}")),
            meta_display(key, value),
        ));
    }
    out
}

/// Số liệu dạng JSON cho lệnh `state` của kênh debug (E2E đối chiếu với pypdfium2).
pub fn to_json(view: &View) -> serde_json::Value {
    let metadata: serde_json::Map<String, serde_json::Value> = view
        .metadata
        .iter()
        .map(|(k, v)| (k.to_string(), serde_json::Value::String(v.clone())))
        .collect();
    serde_json::json!({
        "fileName": view.file_name,
        "fileSize": view.file_size,
        "version": view.version,
        "pageCount": view.page_count,
        "pageSize": format_page_size(view.page_pt.0, view.page_pt.1, "ngang"),
        "page": view.page_no,
        "metadata": metadata,
        "shown": view
            .metadata
            .iter()
            .map(|(k, v)| (k.to_string(), serde_json::Value::String(meta_display(k, v))))
            .collect::<serde_json::Map<_, _>>(),
    })
}

/// Một dòng nhãn và giá trị. Nhãn mờ, giá trị đậm vừa.
fn row(label: String, value: String, dark: bool) -> impl IntoElement {
    let muted = if dark {
        chef_theme::dark::C_TEXT_2
    } else {
        chef_theme::light::C_TEXT_2
    };
    div()
        .flex()
        .flex_row()
        .gap(px(12.))
        .py(px(4.))
        .child(
            div()
                .w(px(150.))
                .flex_none()
                .text_size(px(chef_theme::shared::TEXT_SM))
                .text_color(rgba(pack(muted)))
                .child(label),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_size(px(chef_theme::shared::TEXT_MD))
                .font_weight(FontWeight::MEDIUM)
                .child(value),
        )
}

/// Dựng hộp thoại. `close` là tiêu điểm của nút đóng; `return_to` là tiêu điểm trả về khi đóng.
pub fn build(
    view: &View,
    dark: bool,
    close: gpui::FocusHandle,
    return_to: gpui::FocusHandle,
    on_dismiss: impl Fn(&mut Window, &mut App) + Clone + 'static,
) -> Dialog {
    let rows = rows(view);
    let mut dialog = Dialog::new("properties", t("properties.title"), Width::Lg, dark)
        .close("properties-close", close.clone(), t("common.close"))
        .return_focus(return_to)
        .on_dismiss(on_dismiss.clone());
    let mut body = div().flex().flex_col();
    for (label, value) in rows {
        body = body.child(row(label, value, dark));
    }
    dialog = dialog.child(body);
    dialog.action(
        Button::new("properties-done", close)
            .variant(Variant::Primary)
            .label(t("common.close"))
            .dark(dark)
            .on_click(move |_, window, cx| on_dismiss(window, cx)),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_use_one_decimal_with_a_comma_below_100() {
        assert_eq!(format_bytes(512), "512 B");
        assert_eq!(format_bytes(1536), "1,5 KB");
        assert_eq!(format_bytes(2048), "2 KB");
        assert_eq!(format_bytes(150 * 1024), "150 KB");
        assert_eq!(format_bytes(3 * 1024 * 1024), "3 MB");
    }

    #[test]
    fn a4_page_is_named_and_landscape_is_marked() {
        assert_eq!(
            format_page_size(595.276, 841.89, "ngang"),
            "210 × 297 mm (A4)"
        );
        assert_eq!(
            format_page_size(841.89, 595.276, "ngang"),
            "297 × 210 mm (A4, ngang)"
        );
        assert_eq!(format_page_size(100.0, 100.0, "ngang"), "35 × 35 mm");
    }

    #[test]
    fn pdf_dates_read_day_month_year_and_time() {
        assert_eq!(
            format_pdf_date("D:20260102030405+07'00'"),
            "02/01/2026 03:04"
        );
        assert_eq!(format_pdf_date("D:20260315101112Z"), "15/03/2026 10:11");
        assert_eq!(format_pdf_date("không phải ngày"), "không phải ngày");
    }

    #[test]
    fn empty_metadata_shows_a_dash() {
        assert_eq!(meta_display("Title", ""), "–");
        assert_eq!(meta_display("Title", "Báo cáo"), "Báo cáo");
    }
}
