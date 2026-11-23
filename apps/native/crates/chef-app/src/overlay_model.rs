//! Công cụ đặt đối tượng lên trang (TASKS_RUST R5.29–R5.39; FEATURES F): port phần còn lại của
//! `overlayModel.ts` (phần dùng chung đã ở `overlay_common.rs`). Form → tham số lõi cho chữ, ảnh,
//! watermark, header/footer, số trang, QR, mã vạch, Bates, giấy tiêu đề; quản lý lớp đã thêm; hình
//! học xem trước. Tọa độ x/y tính từ góc TRÊN-TRÁI của trang đang hiển thị (sau /Rotate), theo đơn vị
//! của form (pt hoặc mm); lề header/footer và số trang luôn là mm. Logic thuần.
#![allow(dead_code)]

use serde_json::{Map, Value, json};

use crate::overlay_common::{
    Anchor, FormCheck, PagesSel, Unit, in_range, is_hex_color, page_selection,
};
use crate::overlay_variables::parse_template;

fn is_image_path(p: &str) -> bool {
    let l = p.to_lowercase();
    l.ends_with(".png") || l.ends_with(".jpg") || l.ends_with(".jpeg")
}

fn with_pages(
    mut m: Map<String, Value>,
    pages: &PagesSel,
    current: usize,
    count: usize,
) -> Map<String, Value> {
    m.extend(page_selection(pages, current, count).unwrap_or_default());
    m
}

fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

fn pos_ok(x: f64, y: f64) -> bool {
    in_range(x, -10_000.0, 10_000.0) && in_range(y, -10_000.0, 10_000.0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Align {
    Left,
    Center,
    Right,
}

impl Align {
    pub fn as_str(self) -> &'static str {
        match self {
            Align::Left => "left",
            Align::Center => "center",
            Align::Right => "right",
        }
    }
}

// ---- Chữ ----

#[derive(Debug, Clone, PartialEq)]
pub struct TextForm {
    pub text: String,
    pub font_size: f64,
    pub bold: bool,
    pub color: String,
    pub align: Align,
    pub rotation: f64,
    pub opacity: f64,
    pub under: bool,
    pub anchor: Anchor,
    pub unit: Unit,
    pub x: f64,
    pub y: f64,
    /// 0 = không giới hạn bề rộng (không xuống dòng).
    pub width: f64,
    pub pages: PagesSel,
}

impl Default for TextForm {
    fn default() -> Self {
        Self {
            text: String::new(),
            font_size: 12.0,
            bold: false,
            color: "#000000".into(),
            align: Align::Left,
            rotation: 0.0,
            opacity: 1.0,
            under: false,
            anchor: Anchor::TopLeft,
            unit: Unit::Mm,
            x: 20.0,
            y: 20.0,
            width: 0.0,
            pages: PagesSel::default(),
        }
    }
}

pub fn check_text(f: &TextForm, page_count: usize, current: usize) -> FormCheck {
    if f.text.trim().is_empty() || f.text.encode_utf16().count() > 5000 {
        return Err("text");
    }
    if !in_range(f.font_size, 1.0, 200.0) {
        return Err("fontSize");
    }
    if !is_hex_color(&f.color) {
        return Err("color");
    }
    if !in_range(f.opacity, 0.0, 1.0) {
        return Err("opacity");
    }
    if !pos_ok(f.x, f.y) {
        return Err("position");
    }
    if !in_range(f.width, 0.0, 10_000.0) {
        return Err("width");
    }
    page_selection(&f.pages, current, page_count)
        .map(|_| ())
        .map_err(|_| "pages")
}

/// `overlay.addText`.
pub fn add_text_params(f: &TextForm, current: usize, count: usize) -> Value {
    let mut m = with_pages(
        obj(
            json!({"x": f.x, "y": f.y, "unit": f.unit.as_str(), "anchor": f.anchor.as_str(), "rotation": f.rotation,
            "opacity": f.opacity, "under": f.under, "text": f.text, "fontName": "BeVietnamPro",
            "fontSize": f.font_size, "bold": f.bold, "color": f.color, "align": f.align.as_str()}),
        ),
        &f.pages,
        current,
        count,
    );
    if f.width > 0.0 {
        m.insert("width".into(), f.width.into());
    }
    Value::Object(m)
}

// ---- Ảnh ----

#[derive(Debug, Clone, PartialEq)]
pub struct ImageForm {
    pub path: String,
    /// 0 = giữ cỡ tự nhiên cho cạnh đó.
    pub width: f64,
    pub height: f64,
    pub unit: Unit,
    pub x: f64,
    pub y: f64,
    pub anchor: Anchor,
    pub rotation: f64,
    pub opacity: f64,
    pub under: bool,
    pub pages: PagesSel,
}

impl Default for ImageForm {
    fn default() -> Self {
        Self {
            path: String::new(),
            width: 40.0,
            height: 0.0,
            unit: Unit::Mm,
            x: 20.0,
            y: 20.0,
            anchor: Anchor::TopLeft,
            rotation: 0.0,
            opacity: 1.0,
            under: false,
            pages: PagesSel::default(),
        }
    }
}

pub fn check_image(f: &ImageForm, page_count: usize, current: usize) -> FormCheck {
    if !is_image_path(&f.path) {
        return Err("path");
    }
    if !in_range(f.width, 0.0, 10_000.0) || !in_range(f.height, 0.0, 10_000.0) {
        return Err("size");
    }
    if !in_range(f.opacity, 0.0, 1.0) {
        return Err("opacity");
    }
    if !pos_ok(f.x, f.y) {
        return Err("position");
    }
    page_selection(&f.pages, current, page_count)
        .map(|_| ())
        .map_err(|_| "pages")
}

/// `overlay.addImage`.
pub fn add_image_params(f: &ImageForm, current: usize, count: usize) -> Value {
    let mut m = with_pages(
        obj(
            json!({"x": f.x, "y": f.y, "unit": f.unit.as_str(), "anchor": f.anchor.as_str(), "rotation": f.rotation,
            "opacity": f.opacity, "under": f.under, "path": f.path}),
        ),
        &f.pages,
        current,
        count,
    );
    if f.width > 0.0 {
        m.insert("width".into(), f.width.into());
    }
    if f.height > 0.0 {
        m.insert("height".into(), f.height.into());
    }
    Value::Object(m)
}

// ---- Watermark ----

#[derive(Debug, Clone, PartialEq)]
pub struct WatermarkLook {
    pub font_size: f64,
    pub bold: bool,
    pub color: String,
    pub opacity: f64,
    pub rotation: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatermarkMode {
    Center,
    Tiled,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WatermarkForm {
    pub image: bool,
    pub text: String,
    pub path: String,
    pub look: WatermarkLook,
    pub mode: WatermarkMode,
    pub spacing: f64,
    pub width: f64,
    pub height: f64,
    pub under: bool,
    pub pages: PagesSel,
}

impl Default for WatermarkForm {
    fn default() -> Self {
        Self {
            image: false,
            text: "BẢN SAO".into(),
            path: String::new(),
            look: builtin_watermarks()[0].1.clone(),
            mode: WatermarkMode::Center,
            spacing: 60.0,
            width: 0.0,
            height: 0.0,
            under: false,
            pages: PagesSel::default(),
        }
    }
}

/// Giao diện dựng sẵn (kiểu F2): (khóa, giao diện, khóa chuỗi cho chữ in trên trang).
pub fn builtin_watermarks() -> [(&'static str, WatermarkLook, &'static str); 4] {
    let look = |size, color: &str, opacity, rotation| WatermarkLook {
        font_size: size,
        bold: true,
        color: color.into(),
        opacity,
        rotation,
    };
    [
        (
            "copy",
            look(60.0, "#808080", 0.25, 45.0),
            "overlay.presetText.copy",
        ),
        (
            "secret",
            look(90.0, "#B00020", 0.2, 45.0),
            "overlay.presetText.secret",
        ),
        (
            "draft",
            look(80.0, "#808080", 0.2, 45.0),
            "overlay.presetText.draft",
        ),
        (
            "approved",
            look(56.0, "#1E8E3E", 0.3, 0.0),
            "overlay.presetText.approved",
        ),
    ]
}

pub fn check_watermark(f: &WatermarkForm, page_count: usize, current: usize) -> FormCheck {
    if f.image {
        if !is_image_path(&f.path) {
            return Err("path");
        }
        if !in_range(f.width, 0.0, 2000.0) || !in_range(f.height, 0.0, 2000.0) {
            return Err("size");
        }
    } else {
        if f.text.trim().is_empty() || f.text.encode_utf16().count() > 500 {
            return Err("text");
        }
        if !in_range(f.look.font_size, 1.0, 400.0) {
            return Err("fontSize");
        }
        if !is_hex_color(&f.look.color) {
            return Err("color");
        }
    }
    if !in_range(f.look.opacity, 0.0, 1.0) {
        return Err("opacity");
    }
    if !in_range(f.look.rotation, -360.0, 360.0) {
        return Err("rotation");
    }
    if !in_range(f.spacing, 0.0, 1000.0) {
        return Err("spacing");
    }
    page_selection(&f.pages, current, page_count)
        .map(|_| ())
        .map_err(|_| "pages")
}

/// `overlay.watermark`.
pub fn watermark_params(f: &WatermarkForm, current: usize, count: usize) -> Value {
    let mut m = with_pages(
        obj(
            json!({"opacity": f.look.opacity, "rotation": f.look.rotation, "under": f.under,
            "mode": if f.mode == WatermarkMode::Center { "center" } else { "tiled" }, "spacing": f.spacing}),
        ),
        &f.pages,
        current,
        count,
    );
    if f.image {
        m.insert("path".into(), f.path.clone().into());
        if f.width > 0.0 {
            m.insert("width".into(), f.width.into());
        }
        if f.height > 0.0 {
            m.insert("height".into(), f.height.into());
        }
    } else {
        m.extend(obj(
            json!({"text": f.text, "fontName": "BeVietnamPro", "fontSize": f.look.font_size,
            "bold": f.look.bold, "color": f.look.color}),
        ));
    }
    Value::Object(m)
}

// ---- Header/footer và số trang ----

pub const ZONE_KEYS: [&str; 3] = ["left", "center", "right"];

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Zones {
    pub left: String,
    pub center: String,
    pub right: String,
}

impl Zones {
    fn get(&self, key: &str) -> &str {
        match key {
            "left" => &self.left,
            "center" => &self.center,
            _ => &self.right,
        }
    }
    fn to_json(&self) -> Value {
        json!({"left": self.left, "center": self.center, "right": self.right})
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Margins {
    pub top: f64,
    pub bottom: f64,
    pub left: f64,
    pub right: f64,
}

impl Default for Margins {
    fn default() -> Self {
        Margins {
            top: 10.0,
            bottom: 10.0,
            left: 20.0,
            right: 20.0,
        }
    }
}

impl Margins {
    fn to_json(self) -> Value {
        json!({"top": self.top, "bottom": self.bottom, "left": self.left, "right": self.right})
    }
}

/// Mẫu hỏng đầu tiên của các vùng: (vùng, lỗi).
pub fn zones_problem(z: &Zones) -> Option<(&'static str, crate::overlay_variables::TemplateIssue)> {
    ZONE_KEYS
        .into_iter()
        .find_map(|k| parse_template(z.get(k)).err().map(|(issue, _)| (k, issue)))
}

pub fn zones_empty(z: &Zones) -> bool {
    ZONE_KEYS.iter().all(|k| z.get(k).trim().is_empty())
}

pub fn check_margins(m: &Margins) -> bool {
    [m.top, m.bottom, m.left, m.right]
        .iter()
        .all(|v| in_range(*v, 0.0, 200.0))
}

#[derive(Debug, Clone, PartialEq)]
pub struct HeaderFooterForm {
    pub header: Zones,
    pub footer: Zones,
    pub font_size: f64,
    pub bold: bool,
    pub color: String,
    pub opacity: f64,
    pub margins: Margins,
    pub date_format: String,
    pub skip_first: bool,
    pub start_number: i64,
    pub mirror_odd_even: bool,
    pub pages: PagesSel,
    pub bates_prefix: String,
    pub bates_suffix: String,
    pub bates_digits: u32,
}

impl Default for HeaderFooterForm {
    fn default() -> Self {
        Self {
            header: Zones::default(),
            footer: Zones {
                left: "{filename}".into(),
                center: String::new(),
                right: "Trang {page}/{pages}".into(),
            },
            font_size: 10.0,
            bold: false,
            color: "#000000".into(),
            opacity: 1.0,
            margins: Margins::default(),
            date_format: "dd/MM/yyyy".into(),
            skip_first: false,
            start_number: 1,
            mirror_odd_even: false,
            pages: PagesSel::default(),
            bates_prefix: String::new(),
            bates_suffix: String::new(),
            bates_digits: 6,
        }
    }
}

/// `overlay.headerFooter`.
pub fn header_footer_params(f: &HeaderFooterForm, current: usize, count: usize) -> Value {
    Value::Object(with_pages(
        obj(
            json!({"header": f.header.to_json(), "footer": f.footer.to_json(), "margins": f.margins.to_json(),
            "fontName": "BeVietnamPro", "fontSize": f.font_size, "bold": f.bold, "color": f.color, "opacity": f.opacity,
            "dateFormat": f.date_format, "skipFirst": f.skip_first, "startNumber": f.start_number,
            "mirrorOddEven": f.mirror_odd_even, "batesPrefix": f.bates_prefix, "batesSuffix": f.bates_suffix,
            "batesDigits": f.bates_digits}),
        ),
        &f.pages,
        current,
        count,
    ))
}

pub const NUMBER_POSITIONS: [&str; 6] = [
    "top-left",
    "top-center",
    "top-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
];

#[derive(Debug, Clone, PartialEq)]
pub struct PageNumbersForm {
    /// `true` = mẫu Nghị định 30/2020/NĐ-CP (lõi ghi đè).
    pub nd30: bool,
    /// "arabic", "roman", "ROMAN", "alpha", "ALPHA".
    pub number_format: String,
    pub template: String,
    pub position: String,
    pub margins: Margins,
    pub font_size: f64,
    pub bold: bool,
    pub color: String,
    pub opacity: f64,
    pub start_number: i64,
    pub skip_first: bool,
    pub write_labels: bool,
    pub date_format: String,
    pub pages: PagesSel,
}

impl Default for PageNumbersForm {
    fn default() -> Self {
        Self {
            nd30: false,
            number_format: "arabic".into(),
            template: "Trang {page}/{pages}".into(),
            position: "bottom-center".into(),
            margins: Margins::default(),
            font_size: 10.0,
            bold: false,
            color: "#000000".into(),
            opacity: 1.0,
            start_number: 1,
            skip_first: false,
            write_labels: false,
            date_format: "dd/MM/yyyy".into(),
            pages: PagesSel::default(),
        }
    }
}

/// Giá trị mẫu ND30 mà lõi áp dụng (`overlay_header.py`).
pub const ND30_TEMPLATE: &str = "{page}";
pub const ND30_POSITION: &str = "top-center";
pub const ND30_FONT_SIZE: f64 = 13.0;

/// `overlay.pageNumbers`.
pub fn page_numbers_params(f: &PageNumbersForm, current: usize, count: usize) -> Value {
    let mut m = with_pages(
        obj(
            json!({"numberFormat": f.number_format, "template": f.template, "position": f.position,
            "margins": f.margins.to_json(), "fontName": "BeVietnamPro", "fontSize": f.font_size, "bold": f.bold,
            "color": f.color, "opacity": f.opacity, "startNumber": f.start_number, "skipFirst": f.skip_first,
            "writeLabels": f.write_labels, "dateFormat": f.date_format}),
        ),
        &f.pages,
        current,
        count,
    );
    if f.nd30 {
        m.insert("preset".into(), "nd30".into());
    }
    Value::Object(m)
}

/// Mẫu như lõi sẽ thấy (nd30 ghi đè).
pub fn effective_number_template(f: &PageNumbersForm) -> &str {
    if f.nd30 { ND30_TEMPLATE } else { &f.template }
}

pub fn check_page_numbers(f: &PageNumbersForm, page_count: usize, current: usize) -> FormCheck {
    if !f.nd30 && parse_template(&f.template).is_err() {
        return Err("template");
    }
    if !in_range(f.start_number as f64, 0.0, 1_000_000_000.0) {
        return Err("startNumber");
    }
    if !in_range(f.font_size, 1.0, 200.0) {
        return Err("fontSize");
    }
    if !check_margins(&f.margins) {
        return Err("margins");
    }
    page_selection(&f.pages, current, page_count)
        .map(|_| ())
        .map_err(|_| "pages")
}

/// Biến hiện thành nút chọn, theo thứ tự lõi ghi.
pub const CHIP_VARIABLES: [&str; 11] = [
    "page",
    "pages",
    "page_roman",
    "page_alpha",
    "date",
    "time",
    "filename",
    "title",
    "author",
    "bates",
    "section",
];

// ---- QR và mã vạch ----

pub const ECC_LEVELS: [&str; 4] = ["L", "M", "Q", "H"];

#[derive(Debug, Clone, PartialEq)]
pub struct QrForm {
    pub content: String,
    pub error_correction: &'static str,
    pub size: f64,
    pub label: String,
    pub color: String,
    /// Rỗng = trong suốt.
    pub background: String,
    pub x: f64,
    pub y: f64,
    pub anchor: Anchor,
    pub pages: PagesSel,
}

impl Default for QrForm {
    fn default() -> Self {
        Self {
            content: "{filename} - trang {page}".into(),
            error_correction: "M",
            size: 25.0,
            label: String::new(),
            color: "#000000".into(),
            background: String::new(),
            x: 150.0,
            y: 20.0,
            anchor: Anchor::TopLeft,
            pages: PagesSel::default(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BarcodeKind {
    Code128,
    Ean13,
    Code39,
}

impl BarcodeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Code128 => "code128",
            Self::Ean13 => "ean13",
            Self::Code39 => "code39",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct BarcodeForm {
    pub kind: BarcodeKind,
    pub content: String,
    pub unit: Unit,
    pub module_width: f64,
    pub height: f64,
    pub label: String,
    pub color: String,
    pub background: String,
    pub x: f64,
    pub y: f64,
    pub anchor: Anchor,
    pub pages: PagesSel,
}

impl Default for BarcodeForm {
    fn default() -> Self {
        Self {
            kind: BarcodeKind::Code128,
            content: "HS-000001".into(),
            unit: Unit::Mm,
            module_width: 0.33,
            height: 15.0,
            label: String::new(),
            color: "#000000".into(),
            background: String::new(),
            x: 20.0,
            y: 260.0,
            anchor: Anchor::TopLeft,
            pages: PagesSel::default(),
        }
    }
}

/// Chữ số kiểm của EAN-13 cho 12 chữ số đầu. Ký tự không phải số tính là 0.
pub fn ean13_check_digit(first12: &str) -> u32 {
    let sum: u32 = first12
        .chars()
        .take(12)
        .enumerate()
        .map(|(i, c)| c.to_digit(10).unwrap_or(0) * if i % 2 == 0 { 1 } else { 3 })
        .sum();
    (10 - sum % 10) % 10
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BarcodeProblem {
    Empty,
    Ean13Digits,
    Ean13Length,
    Ean13Check,
    Code39,
    Code128,
}

/// None khi nội dung hợp lệ cho loại mã vạch. EAN-13 nhận 12 hoặc 13 chữ số.
pub fn barcode_problem(kind: BarcodeKind, content: &str) -> Option<BarcodeProblem> {
    if content.is_empty() {
        return Some(BarcodeProblem::Empty);
    }
    match kind {
        BarcodeKind::Ean13 => {
            if !content.bytes().all(|b| b.is_ascii_digit()) {
                Some(BarcodeProblem::Ean13Digits)
            } else if content.len() != 12 && content.len() != 13 {
                Some(BarcodeProblem::Ean13Length)
            } else if content.len() == 13
                && ean13_check_digit(content) != content[12..].parse::<u32>().unwrap_or(10)
            {
                Some(BarcodeProblem::Ean13Check)
            } else {
                None
            }
        }
        BarcodeKind::Code39 => (!content
            .chars()
            .all(|c| c.is_ascii_digit() || c.is_ascii_uppercase() || " -.$/+%".contains(c)))
        .then_some(BarcodeProblem::Code39),
        BarcodeKind::Code128 => {
            (!content.chars().all(|c| (' '..='~').contains(&c))).then_some(BarcodeProblem::Code128)
        }
    }
}

/// EAN-13 đủ chữ số kiểm, từ 12 hoặc 13 chữ số.
pub fn ean13_complete(content: &str) -> String {
    if content.len() == 13 {
        content.to_string()
    } else {
        format!("{content}{}", ean13_check_digit(content))
    }
}

/// Nội dung QR: mẫu phải hợp lệ (lõi dựng các biến). Trả tên lỗi.
pub fn qr_content_problem(content: &str) -> Option<&'static str> {
    if content.trim().is_empty() {
        return Some("empty");
    }
    parse_template(content).err().map(|(issue, _)| match issue {
        crate::overlay_variables::TemplateIssue::Unclosed => "unclosed",
        crate::overlay_variables::TemplateIssue::Stray => "stray",
        crate::overlay_variables::TemplateIssue::Unknown => "unknown",
    })
}

/// `overlay.qrCode`.
pub fn qr_params(f: &QrForm, current: usize, count: usize) -> Value {
    let mut m = with_pages(
        obj(
            json!({"x": f.x, "y": f.y, "unit": "mm", "anchor": f.anchor.as_str(), "content": f.content,
            "errorCorrection": f.error_correction, "size": f.size, "color": f.color}),
        ),
        &f.pages,
        current,
        count,
    );
    if !f.background.is_empty() {
        m.insert("background".into(), f.background.clone().into());
    }
    if !f.label.is_empty() {
        m.insert("label".into(), f.label.clone().into());
        m.insert("fontName".into(), "BeVietnamPro".into());
    }
    Value::Object(m)
}

/// `overlay.barcode`.
pub fn barcode_params(f: &BarcodeForm, current: usize, count: usize) -> Value {
    let mut m = with_pages(
        obj(
            json!({"x": f.x, "y": f.y, "unit": f.unit.as_str(), "anchor": f.anchor.as_str(), "kind": f.kind.as_str(),
            "content": if f.kind == BarcodeKind::Ean13 { ean13_complete(&f.content) } else { f.content.clone() },
            "moduleWidth": f.module_width, "height": f.height, "color": f.color}),
        ),
        &f.pages,
        current,
        count,
    );
    if !f.background.is_empty() {
        m.insert("background".into(), f.background.clone().into());
    }
    if !f.label.is_empty() {
        m.insert("label".into(), f.label.clone().into());
        m.insert("fontName".into(), "BeVietnamPro".into());
    }
    Value::Object(m)
}

// ---- Hình học xem trước (xấp xỉ) ----

/// Cỡ khối chữ ước lượng, pt (chỉ cho xem trước; lõi đo chính xác): (rộng, cao, số dòng).
pub fn estimate_text_box(text: &str, font_size: f64, width: f64) -> (f64, f64, usize) {
    let rows: Vec<&str> = text.split('\n').collect();
    let char_w = font_size * 0.52;
    let natural = rows
        .iter()
        .map(|l| l.chars().count())
        .max()
        .unwrap_or(1)
        .max(1) as f64
        * char_w;
    let lines: usize = if width > 0.0 {
        rows.iter()
            .map(|l| ((l.chars().count() as f64 * char_w / width).ceil() as usize).max(1))
            .sum()
    } else {
        rows.len()
    };
    (
        if width > 0.0 { width } else { natural },
        lines as f64 * font_size * 1.2,
        lines,
    )
}

/// Độ lệch từ góc trên-trái của đối tượng đến điểm mỏ neo.
pub fn anchor_shift(anchor: Anchor, w: f64, h: f64) -> (f64, f64) {
    let s = anchor.as_str();
    let dx = if s.ends_with("center") || s == "center" {
        w / 2.0
    } else if s.ends_with("right") {
        w
    } else {
        0.0
    };
    let dy = if s.starts_with("center") || s == "center" {
        h / 2.0
    } else if s.starts_with("bottom") {
        h
    } else {
        0.0
    };
    (dx, dy)
}

/// Vị trí đối tượng trên bản xem trước trang, theo phần trăm trang: (trái, trên, rộng, cao).
pub fn preview_box(
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    anchor: Anchor,
    page: (f64, f64),
) -> (f64, f64, f64, f64) {
    let (dx, dy) = anchor_shift(anchor, w, h);
    (
        (x - dx) / page.0 * 100.0,
        (y - dy) / page.1 * 100.0,
        w / page.0 * 100.0,
        h / page.1 * 100.0,
    )
}

// ---- Bates ----

pub const BATES_POSITIONS: [&str; 7] = [
    "top-left",
    "top-center",
    "top-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
    "outside-alternating",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatesOutputMode {
    Suffix,
    Folder,
    Overwrite,
}

#[derive(Debug, Clone, PartialEq)]
pub struct BatesForm {
    pub files: Vec<String>,
    pub prefix: String,
    pub suffix: String,
    pub start_number: u64,
    pub digits: u32,
    pub position: &'static str,
    pub font_size: f64,
    pub output_mode: BatesOutputMode,
    pub output_suffix: String,
    pub folder: String,
    pub stop_on_error: bool,
}

impl Default for BatesForm {
    fn default() -> Self {
        Self {
            files: vec![],
            prefix: "HS-".into(),
            suffix: String::new(),
            start_number: 1,
            digits: 6,
            position: "bottom-right",
            font_size: 9.0,
            output_mode: BatesOutputMode::Suffix,
            output_suffix: "_bates".into(),
            folder: String::new(),
            stop_on_error: false,
        }
    }
}

pub fn check_bates(f: &BatesForm) -> FormCheck {
    if f.files.is_empty() {
        return Err("files");
    }
    if f.output_mode == BatesOutputMode::Folder && f.folder.trim().is_empty() {
        return Err("folder");
    }
    if !(1..=12).contains(&f.digits) {
        return Err("digits");
    }
    if f.start_number > 1_000_000_000 {
        return Err("start");
    }
    if f.output_mode == BatesOutputMode::Suffix && f.output_suffix.trim().is_empty() {
        return Err("suffix");
    }
    Ok(())
}

/// Mã Bates: tiền tố + số đệm 0 + hậu tố.
pub fn bates_code(f: &BatesForm, n: u64) -> String {
    format!("{}{:0w$}{}", f.prefix, n, f.suffix, w = f.digits as usize)
}

/// `overlay.bates`.
pub fn bates_params(f: &BatesForm) -> Value {
    let output = match f.output_mode {
        BatesOutputMode::Folder => json!({"mode": "folder", "folder": f.folder}),
        BatesOutputMode::Suffix => json!({"mode": "suffix", "suffix": f.output_suffix}),
        BatesOutputMode::Overwrite => json!({"mode": "overwrite"}),
    };
    json!({"files": f.files.iter().map(|p| json!({"path": p})).collect::<Vec<_>>(), "prefix": f.prefix,
        "suffix": f.suffix, "startNumber": f.start_number, "digits": f.digits, "position": f.position,
        "fontSize": f.font_size, "output": output, "stopOnError": f.stop_on_error})
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BatesStatus {
    Done,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BatesRow {
    pub path: String,
    pub status: BatesStatus,
    pub output_path: Option<String>,
    pub pages: Option<u64>,
    pub first_number: Option<String>,
    pub last_number: Option<String>,
    pub error_kind: Option<String>,
    pub message: Option<String>,
}

/// Dòng của `overlay.bates` (`data.files`); trạng thái lạ coi là lỗi.
pub fn read_bates_rows(data: &Value) -> Vec<BatesRow> {
    let s = |r: &Value, k: &str| r.get(k).and_then(Value::as_str).map(String::from);
    data.get("files")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|r| BatesRow {
                    path: s(r, "path").unwrap_or_default(),
                    status: match r.get("status").and_then(Value::as_str) {
                        Some("done") => BatesStatus::Done,
                        Some("skipped") => BatesStatus::Skipped,
                        _ => BatesStatus::Failed,
                    },
                    output_path: s(r, "outputPath"),
                    pages: r.get("pages").and_then(Value::as_u64),
                    first_number: s(r, "firstLabel").or_else(|| s(r, "firstNumber")),
                    last_number: s(r, "lastLabel").or_else(|| s(r, "lastNumber")),
                    error_kind: s(r, "errorKind"),
                    message: s(r, "message"),
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---- Giấy tiêu đề (letterhead) ----

pub const LETTERHEAD_ROLES: [&str; 4] = ["first", "odd", "even", "rest"];

#[derive(Debug, Clone, PartialEq)]
pub struct LetterheadForm {
    pub source_path: String,
    /// Trang nguồn (từ 0) theo vai trò: trang đầu, lẻ, chẵn, còn lại; None là không dùng.
    pub roles: [Option<u64>; 4],
    /// "none" hoặc "fit".
    pub scaling: &'static str,
    pub under: bool,
    pub pages: PagesSel,
}

impl Default for LetterheadForm {
    fn default() -> Self {
        Self {
            source_path: String::new(),
            roles: [Some(0), None, None, Some(0)],
            scaling: "fit",
            under: true,
            pages: PagesSel::default(),
        }
    }
}

/// `overlay.letterhead`.
pub fn letterhead_params(f: &LetterheadForm, current: usize, count: usize) -> Value {
    let mut m = with_pages(Map::new(), &f.pages, current, count);
    m.insert("sourcePath".into(), f.source_path.clone().into());
    m.insert("sourcePage".into(), f.roles[0].unwrap_or(0).into());
    for (role, v) in LETTERHEAD_ROLES.iter().zip(f.roles) {
        if let Some(p) = v {
            m.insert((*role).into(), p.into());
        }
    }
    m.insert("scaling".into(), f.scaling.into());
    m.insert("under".into(), f.under.into());
    Value::Object(m)
}

pub fn letterhead_problem(f: &LetterheadForm) -> Option<&'static str> {
    if !f.source_path.to_lowercase().ends_with(".pdf") {
        Some("source")
    } else if f.roles.iter().all(Option::is_none) {
        Some("roles")
    } else {
        None
    }
}

// ---- Quản lý lớp đã thêm ----

pub const OVERLAY_KINDS: [&str; 9] = [
    "text",
    "image",
    "watermark",
    "stamp",
    "header",
    "footer",
    "number",
    "qr",
    "letterhead",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverlayItem {
    pub id: String,
    pub kind: String,
    pub group: String,
    pub pages: Vec<u64>,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverlayGroup {
    pub kind: String,
    pub group: String,
    pub label: String,
    /// Từ 0, đã sắp, không trùng.
    pub pages: Vec<u64>,
    pub count: usize,
}

/// Mục của `overlay.listOverlays` (`data.overlays`); mục hỏng bị bỏ.
pub fn read_overlays(data: &Value) -> Vec<OverlayItem> {
    data.get("overlays")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|o| {
            let kind = o
                .get("kind")?
                .as_str()
                .filter(|k| OVERLAY_KINDS.contains(k))?;
            Some(OverlayItem {
                id: o.get("id")?.as_str()?.to_string(),
                kind: kind.to_string(),
                group: o.get("group")?.as_str()?.to_string(),
                pages: o
                    .get("pages")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(Value::as_u64).collect())
                    .unwrap_or_default(),
                label: o
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
        })
        .collect()
}

/// Gom theo loại và nhóm thao tác, theo thứ tự loại.
pub fn group_overlays(items: &[OverlayItem]) -> Vec<OverlayGroup> {
    let mut groups: Vec<OverlayGroup> = Vec::new();
    for it in items {
        let i = match groups
            .iter()
            .position(|g| g.kind == it.kind && g.group == it.group)
        {
            Some(i) => i,
            None => {
                groups.push(OverlayGroup {
                    kind: it.kind.clone(),
                    group: it.group.clone(),
                    label: it.label.clone(),
                    pages: vec![],
                    count: 0,
                });
                groups.len() - 1
            }
        };
        groups[i].count += 1;
        for p in &it.pages {
            if !groups[i].pages.contains(p) {
                groups[i].pages.push(*p);
            }
        }
    }
    let rank = |k: &str| {
        OVERLAY_KINDS
            .iter()
            .position(|x| *x == k)
            .unwrap_or(usize::MAX)
    };
    for g in &mut groups {
        g.pages.sort_unstable();
    }
    groups.sort_by(|a, b| {
        rank(&a.kind)
            .cmp(&rank(&b.kind))
            .then_with(|| a.group.cmp(&b.group))
    });
    groups
}

// ---- Preset watermark trong cài đặt ----

pub const MAX_OVERLAY_PRESET_NAME: usize = 60;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresetNameIssue {
    Empty,
    TooLong,
    Duplicate,
}

/// Tên đã cắt khoảng trắng, không trùng (không phân biệt hoa thường) trong `taken`.
pub fn validate_preset_name(raw: &str, taken: &[&str]) -> Result<String, PresetNameIssue> {
    let n = raw.trim();
    if n.is_empty() {
        return Err(PresetNameIssue::Empty);
    }
    if n.chars().count() > MAX_OVERLAY_PRESET_NAME {
        return Err(PresetNameIssue::TooLong);
    }
    if taken.iter().any(|t| t.to_lowercase() == n.to_lowercase()) {
        return Err(PresetNameIssue::Duplicate);
    }
    Ok(n.to_string())
}

/// Giao diện của preset đã lưu; giá trị hỏng lấy từ `fallback`.
pub fn preset_look(params: &Value, fallback: &WatermarkLook) -> WatermarkLook {
    let num = |k: &str, d: f64| {
        params
            .get(k)
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
            .unwrap_or(d)
    };
    WatermarkLook {
        font_size: num("fontSize", fallback.font_size),
        bold: params
            .get("bold")
            .and_then(Value::as_bool)
            .unwrap_or(fallback.bold),
        color: params
            .get("color")
            .and_then(Value::as_str)
            .filter(|c| is_hex_color(c))
            .map_or_else(|| fallback.color.clone(), String::from),
        opacity: num("opacity", fallback.opacity),
        rotation: num("rotation", fallback.rotation),
    }
}

/// Phần giao diện của form watermark (cái preset giữ): không bao giờ có đường dẫn hay danh sách trang.
pub fn look_of(f: &WatermarkForm) -> WatermarkLook {
    f.look.clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overlay_common::PagesChoice;

    fn range(r: &str) -> PagesSel {
        PagesSel {
            choice: PagesChoice::Range,
            range: r.into(),
        }
    }

    #[test]
    fn text_and_image() {
        let ok = TextForm {
            text: "Xin chào".into(),
            ..Default::default()
        };
        assert_eq!(check_text(&ok, 5, 0), Ok(()));
        for (f, field) in [
            (
                TextForm {
                    text: " ".into(),
                    ..ok.clone()
                },
                "text",
            ),
            (
                TextForm {
                    font_size: 0.5,
                    ..ok.clone()
                },
                "fontSize",
            ),
            (
                TextForm {
                    color: "#12".into(),
                    ..ok.clone()
                },
                "color",
            ),
            (
                TextForm {
                    opacity: 2.0,
                    ..ok.clone()
                },
                "opacity",
            ),
            (
                TextForm {
                    x: 1e6,
                    ..ok.clone()
                },
                "position",
            ),
            (
                TextForm {
                    width: -1.0,
                    ..ok.clone()
                },
                "width",
            ),
            (
                TextForm {
                    pages: range("9"),
                    ..ok.clone()
                },
                "pages",
            ),
        ] {
            assert_eq!(check_text(&f, 5, 0), Err(field));
        }
        let v = add_text_params(
            &TextForm {
                width: 80.0,
                pages: range("2-3"),
                ..ok
            },
            0,
            5,
        );
        assert_eq!(
            (
                &v["pages"],
                v["width"].as_f64(),
                v["fontName"].as_str(),
                v["align"].as_str()
            ),
            (
                &json!([1, 2]),
                Some(80.0),
                Some("BeVietnamPro"),
                Some("left")
            )
        );
        let img = ImageForm {
            path: "/a/Logo.PNG".into(),
            width: 0.0,
            height: 30.0,
            ..Default::default()
        };
        assert_eq!(check_image(&img, 5, 0), Ok(()));
        assert_eq!(check_image(&ImageForm::default(), 5, 0), Err("path"));
        assert_eq!(
            check_image(
                &ImageForm {
                    width: -1.0,
                    ..img.clone()
                },
                5,
                0
            ),
            Err("size")
        );
        let v = add_image_params(&img, 1, 5);
        assert_eq!(
            (v.get("width"), v["height"].as_f64(), &v["pages"]),
            (None, Some(30.0), &json!([1]))
        );
    }

    #[test]
    fn watermark() {
        let ok = WatermarkForm::default();
        assert_eq!(check_watermark(&ok, 5, 0), Ok(()));
        assert_eq!(
            check_watermark(
                &WatermarkForm {
                    text: String::new(),
                    ..ok.clone()
                },
                5,
                0
            ),
            Err("text")
        );
        assert_eq!(
            check_watermark(
                &WatermarkForm {
                    image: true,
                    ..ok.clone()
                },
                5,
                0
            ),
            Err("path")
        );
        let img = WatermarkForm {
            image: true,
            path: "/w.png".into(),
            width: 100.0,
            ..ok.clone()
        };
        assert_eq!(check_watermark(&img, 5, 0), Ok(()));
        assert_eq!(
            check_watermark(
                &WatermarkForm {
                    spacing: 1001.0,
                    ..ok.clone()
                },
                5,
                0
            ),
            Err("spacing")
        );
        let t = watermark_params(&ok, 0, 5);
        assert_eq!(
            (
                t["text"].as_str(),
                t["mode"].as_str(),
                t["rotation"].as_f64(),
                t.get("path")
            ),
            (Some("BẢN SAO"), Some("center"), Some(45.0), None)
        );
        let i = watermark_params(
            &WatermarkForm {
                mode: WatermarkMode::Tiled,
                ..img
            },
            0,
            5,
        );
        assert_eq!(
            (
                i["path"].as_str(),
                i["width"].as_f64(),
                i.get("text"),
                i["mode"].as_str()
            ),
            (Some("/w.png"), Some(100.0), None, Some("tiled"))
        );
        let b = builtin_watermarks();
        assert_eq!(
            (b[1].0, b[1].1.font_size, b[3].1.rotation),
            ("secret", 90.0, 0.0)
        );
        assert_eq!(look_of(&ok), b[0].1);
    }

    #[test]
    fn header_footer_and_numbers() {
        let z = Zones {
            left: "{page}".into(),
            center: "{bad}".into(),
            right: String::new(),
        };
        assert_eq!(zones_problem(&z).map(|p| p.0), Some("center"));
        assert!(zones_problem(&Zones::default()).is_none());
        assert!(
            zones_empty(&Zones {
                left: "  ".into(),
                ..Default::default()
            }) && !zones_empty(&z)
        );
        assert!(
            check_margins(&Margins::default())
                && !check_margins(&Margins {
                    top: 201.0,
                    ..Default::default()
                })
        );
        let h = header_footer_params(&HeaderFooterForm::default(), 0, 4);
        assert_eq!(
            (
                h["footer"]["right"].as_str(),
                h["margins"]["left"].as_f64(),
                h["batesDigits"].as_u64(),
                h["startNumber"].as_i64()
            ),
            (Some("Trang {page}/{pages}"), Some(20.0), Some(6), Some(1))
        );
        let pn = PageNumbersForm::default();
        assert_eq!(check_page_numbers(&pn, 4, 0), Ok(()));
        assert_eq!(
            check_page_numbers(
                &PageNumbersForm {
                    template: "{x}".into(),
                    ..pn.clone()
                },
                4,
                0
            ),
            Err("template")
        );
        assert_eq!(
            check_page_numbers(
                &PageNumbersForm {
                    nd30: true,
                    template: "{x}".into(),
                    ..pn.clone()
                },
                4,
                0
            ),
            Ok(()),
            "nd30 bỏ qua mẫu"
        );
        assert_eq!(
            check_page_numbers(
                &PageNumbersForm {
                    start_number: -1,
                    ..pn.clone()
                },
                4,
                0
            ),
            Err("startNumber")
        );
        let nd = PageNumbersForm {
            nd30: true,
            ..pn.clone()
        };
        assert_eq!(
            (
                page_numbers_params(&nd, 0, 4)["preset"].as_str(),
                effective_number_template(&nd),
                effective_number_template(&pn)
            ),
            (Some("nd30"), "{page}", "Trang {page}/{pages}")
        );
        assert!(page_numbers_params(&pn, 0, 4).get("preset").is_none());
        assert_eq!(NUMBER_POSITIONS.len(), 6);
        assert_eq!(CHIP_VARIABLES, crate::overlay_variables::VARIABLE_NAMES);
    }

    #[test]
    fn barcodes_and_qr() {
        assert_eq!(ean13_check_digit("590123412345"), 7);
        assert_eq!(ean13_complete("590123412345"), "5901234123457");
        assert_eq!(ean13_complete("5901234123457"), "5901234123457");
        assert_eq!(barcode_problem(BarcodeKind::Ean13, "5901234123457"), None);
        assert_eq!(
            barcode_problem(BarcodeKind::Ean13, "5901234123450"),
            Some(BarcodeProblem::Ean13Check)
        );
        assert_eq!(
            barcode_problem(BarcodeKind::Ean13, "12345"),
            Some(BarcodeProblem::Ean13Length)
        );
        assert_eq!(
            barcode_problem(BarcodeKind::Ean13, "12a"),
            Some(BarcodeProblem::Ean13Digits)
        );
        assert_eq!(barcode_problem(BarcodeKind::Code39, "ABC-123 $"), None);
        assert_eq!(
            barcode_problem(BarcodeKind::Code39, "abc"),
            Some(BarcodeProblem::Code39)
        );
        assert_eq!(
            barcode_problem(BarcodeKind::Code128, "Hợp"),
            Some(BarcodeProblem::Code128)
        );
        assert_eq!(barcode_problem(BarcodeKind::Code128, "HS-0001~"), None);
        assert_eq!(
            barcode_problem(BarcodeKind::Code128, ""),
            Some(BarcodeProblem::Empty)
        );
        assert_eq!(
            (
                qr_content_problem(" "),
                qr_content_problem("{page"),
                qr_content_problem("a}"),
                qr_content_problem("{x}"),
                qr_content_problem("{filename}")
            ),
            (
                Some("empty"),
                Some("unclosed"),
                Some("stray"),
                Some("unknown"),
                None
            )
        );
        let q = qr_params(
            &QrForm {
                label: "Mã hồ sơ".into(),
                background: "#FFFFFF".into(),
                ..Default::default()
            },
            0,
            3,
        );
        assert_eq!(
            (
                q["unit"].as_str(),
                q["errorCorrection"].as_str(),
                q["fontName"].as_str(),
                q["background"].as_str()
            ),
            (Some("mm"), Some("M"), Some("BeVietnamPro"), Some("#FFFFFF"))
        );
        assert!(qr_params(&QrForm::default(), 0, 3).get("label").is_none());
        let b = barcode_params(
            &BarcodeForm {
                kind: BarcodeKind::Ean13,
                content: "590123412345".into(),
                ..Default::default()
            },
            0,
            3,
        );
        assert_eq!(
            (
                b["content"].as_str(),
                b["kind"].as_str(),
                b.get("background")
            ),
            (Some("5901234123457"), Some("ean13"), None)
        );
    }

    #[test]
    fn preview_geometry() {
        let (w, h, n) = estimate_text_box("abc\nde", 10.0, 0.0);
        assert!((w - 15.6).abs() < 1e-9 && h == 24.0 && n == 2);
        let (w, h, lines) = estimate_text_box("aaaaaaaaaa", 10.0, 26.0);
        assert_eq!((w, lines, h), (26.0, 2, 24.0));
        assert_eq!(estimate_text_box("", 10.0, 0.0).2, 1);
        assert_eq!(
            (
                anchor_shift(Anchor::TopLeft, 10.0, 20.0),
                anchor_shift(Anchor::Center, 10.0, 20.0),
                anchor_shift(Anchor::BottomRight, 10.0, 20.0)
            ),
            ((0.0, 0.0), (5.0, 10.0), (10.0, 20.0))
        );
        assert_eq!(anchor_shift(Anchor::TopCenter, 10.0, 20.0), (5.0, 0.0));
        assert_eq!(anchor_shift(Anchor::CenterLeft, 10.0, 20.0), (0.0, 10.0));
        assert_eq!(
            preview_box(100.0, 50.0, 20.0, 10.0, Anchor::Center, (200.0, 100.0)),
            (45.0, 45.0, 10.0, 10.0)
        );
    }

    #[test]
    fn bates() {
        let f = BatesForm {
            files: vec!["/a.pdf".into()],
            ..Default::default()
        };
        assert_eq!(check_bates(&f), Ok(()));
        assert_eq!(check_bates(&BatesForm::default()), Err("files"));
        assert_eq!(
            check_bates(&BatesForm {
                output_mode: BatesOutputMode::Folder,
                ..f.clone()
            }),
            Err("folder")
        );
        assert_eq!(
            check_bates(&BatesForm {
                digits: 13,
                ..f.clone()
            }),
            Err("digits")
        );
        assert_eq!(
            check_bates(&BatesForm {
                start_number: 2_000_000_000,
                ..f.clone()
            }),
            Err("start")
        );
        assert_eq!(
            check_bates(&BatesForm {
                output_suffix: " ".into(),
                ..f.clone()
            }),
            Err("suffix")
        );
        assert_eq!(
            check_bates(&BatesForm {
                output_mode: BatesOutputMode::Overwrite,
                output_suffix: String::new(),
                ..f.clone()
            }),
            Ok(())
        );
        assert_eq!(
            bates_code(
                &BatesForm {
                    suffix: "-X".into(),
                    digits: 4,
                    ..f.clone()
                },
                42
            ),
            "HS-0042-X"
        );
        let p = bates_params(&BatesForm {
            output_mode: BatesOutputMode::Folder,
            folder: "/out".into(),
            ..f.clone()
        });
        assert_eq!(
            (&p["output"], &p["files"]),
            (
                &json!({"mode":"folder","folder":"/out"}),
                &json!([{"path":"/a.pdf"}])
            )
        );
        assert_eq!(
            bates_params(&f)["output"],
            json!({"mode":"suffix","suffix":"_bates"})
        );
        let rows = read_bates_rows(
            &json!({"files":[{"path":"/a","status":"done","outputPath":"/o","pages":3,"firstLabel":"HS-000001","lastNumber":"HS-000003"},{"path":"/b","status":"???","errorKind":"X"}]}),
        );
        assert_eq!(
            (
                rows[0].status.clone(),
                rows[0].first_number.as_deref(),
                rows[0].last_number.as_deref(),
                rows[1].status.clone()
            ),
            (
                BatesStatus::Done,
                Some("HS-000001"),
                Some("HS-000003"),
                BatesStatus::Failed
            )
        );
    }

    #[test]
    fn letterhead_and_manager() {
        let f = LetterheadForm {
            source_path: "/lh.PDF".into(),
            ..Default::default()
        };
        assert_eq!(letterhead_problem(&f), None);
        assert_eq!(
            letterhead_problem(&LetterheadForm::default()),
            Some("source")
        );
        assert_eq!(
            letterhead_problem(&LetterheadForm {
                roles: [None; 4],
                ..f.clone()
            }),
            Some("roles")
        );
        let v = letterhead_params(
            &LetterheadForm {
                roles: [Some(2), Some(1), None, None],
                ..f
            },
            0,
            3,
        );
        assert_eq!(
            (
                v["sourcePage"].as_u64(),
                v["first"].as_u64(),
                v["odd"].as_u64(),
                v.get("even"),
                v["scaling"].as_str(),
                v["under"].as_bool()
            ),
            (Some(2), Some(2), Some(1), None, Some("fit"), Some(true))
        );
        let items = read_overlays(&json!({"overlays":[
            {"id":"1","kind":"watermark","group":"g2","pages":[3,1],"label":"BẢN SAO"},
            {"id":"2","kind":"text","group":"g1","pages":[0]},
            {"id":"3","kind":"watermark","group":"g2","pages":[1,2]},
            {"id":"4","kind":"weird","group":"g"}, {"id":"5","kind":"qr"}, 7]}));
        assert_eq!(items.len(), 3);
        let g = group_overlays(&items);
        assert_eq!(
            g.iter()
                .map(|g| (g.kind.as_str(), g.count, g.pages.clone()))
                .collect::<Vec<_>>(),
            [("text", 1, vec![0]), ("watermark", 2, vec![1, 2, 3])]
        );
        assert_eq!(g[1].label, "BẢN SAO");
    }

    #[test]
    fn presets() {
        assert_eq!(
            validate_preset_name("  Mật  ", &["Công khai"]).unwrap(),
            "Mật"
        );
        assert_eq!(validate_preset_name("", &[]), Err(PresetNameIssue::Empty));
        assert_eq!(
            validate_preset_name(&"a".repeat(61), &[]),
            Err(PresetNameIssue::TooLong)
        );
        assert_eq!(
            validate_preset_name("mật", &["MẬT"]),
            Err(PresetNameIssue::Duplicate)
        );
        let fb = builtin_watermarks()[0].1.clone();
        let l = preset_look(
            &json!({"fontSize": 70, "color": "nope", "bold": false, "opacity": "x"}),
            &fb,
        );
        assert_eq!(
            (l.font_size, l.color.as_str(), l.bold, l.opacity, l.rotation),
            (70.0, "#808080", false, 0.25, 45.0)
        );
    }
}
