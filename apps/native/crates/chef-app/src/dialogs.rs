//! Hộp chọn file của Windows (TASKS_RUST R2.30, FEATURES A5): mở một hoặc nhiều PDF, và chọn nơi lưu
//! một PDF. Bộ lọc mặc định là PDF, thư mục bắt đầu lấy từ cài đặt `defaultSaveDir` nếu có. Hủy không
//! báo lỗi: trả về danh sách rỗng hoặc `None`.
//!
//! Dùng `GetOpenFileNameW` và `GetSaveFileNameW` của comdlg32 trực tiếp, không thêm thư viện. Hàm gọi
//! chặn luồng giao diện cho tới khi người dùng đóng hộp thoại (như mọi hộp thoại mô-đun của Windows).
//!
//! Trong E2E (`CHEF_E2E_CLOSE_DIALOGS=1`), một luồng phụ đóng hộp thoại sau một lúc, để kiểm đường hủy.

// Lưu PDF (save_pdf) chưa có chỗ dùng; dùng khi làm lưu và lưu thành (R3.12).
#![allow(dead_code)]

use std::ffi::c_void;
use std::path::{Path, PathBuf};

const OFN_HIDEREADONLY: u32 = 0x0000_0004;
const OFN_OVERWRITEPROMPT: u32 = 0x0000_0002;
const OFN_PATHMUSTEXIST: u32 = 0x0000_0800;
const OFN_FILEMUSTEXIST: u32 = 0x0000_1000;
const OFN_EXPLORER: u32 = 0x0008_0000;
const OFN_ALLOWMULTISELECT: u32 = 0x0000_0200;

/// Số ký tự tối đa của vùng nhận tên file khi chọn nhiều tệp.
const FILE_BUFFER: usize = 65_536;
static PDF_DEFAULT_EXTENSION: [u16; 4] = [b'p' as u16, b'd' as u16, b'f' as u16, 0];

const WM_CLOSE: u32 = 0x0010;

/// Cấu trúc `OPENFILENAMEW` của comdlg32 (repr(C) cho đúng bố cục trên x64).
#[repr(C)]
struct OpenFileNameW {
    struct_size: u32,
    owner: isize,
    instance: isize,
    filter: *const u16,
    custom_filter: *mut u16,
    max_custom_filter: u32,
    filter_index: u32,
    file: *mut u16,
    max_file: u32,
    file_title: *mut u16,
    max_file_title: u32,
    initial_dir: *const u16,
    title: *const u16,
    flags: u32,
    file_offset: u16,
    file_extension: u16,
    def_ext: *const u16,
    cust_data: isize,
    hook: isize,
    template_name: *const u16,
    reserved: *mut c_void,
    reserved_dw: u32,
    flags_ex: u32,
}

#[link(name = "comdlg32")]
unsafe extern "system" {
    fn GetOpenFileNameW(ofn: *mut OpenFileNameW) -> i32;
    fn GetSaveFileNameW(ofn: *mut OpenFileNameW) -> i32;
}

#[link(name = "user32")]
unsafe extern "system" {
    fn EnumWindows(callback: unsafe extern "system" fn(isize, isize) -> i32, param: isize) -> i32;
    fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
    fn GetClassNameW(hwnd: isize, class: *mut u16, max: i32) -> i32;
    fn PostMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> i32;
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcessId() -> u32;
}

/// Chuỗi UTF-16 kết thúc bằng NUL.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Bộ lọc của hộp thoại: "Tài liệu PDF (*.pdf)" và "Tất cả tệp". Kết thúc bằng hai NUL.
pub fn pdf_filter() -> Vec<u16> {
    let mut out = Vec::new();
    for part in ["Tài liệu PDF (*.pdf)", "*.pdf", "Tất cả tệp", "*.*"] {
        out.extend(part.encode_utf16());
        out.push(0);
    }
    out.push(0);
    out
}

/// Đọc vùng kết quả của hộp thoại. Chọn một tệp: đường dẫn đầy đủ. Chọn nhiều tệp: thư mục, rồi tên
/// từng tệp, mỗi phần kết thúc bằng NUL và phần cuối là NUL kép.
pub fn parse_selection(buf: &[u16]) -> Vec<PathBuf> {
    let parts: Vec<String> = buf
        .split(|c| *c == 0)
        .take_while(|p| !p.is_empty())
        .map(String::from_utf16_lossy)
        .collect();
    match parts.as_slice() {
        [] => Vec::new(),
        [single] => vec![PathBuf::from(single)],
        [dir, names @ ..] => names.iter().map(|n| Path::new(dir).join(n)).collect(),
    }
}

/// Đường dẫn ban đầu của hộp thoại, dạng UTF-16 kết thúc NUL, hoặc None khi chưa có thư mục.
fn initial_dir_wide(dir: Option<&Path>) -> Option<Vec<u16>> {
    dir.filter(|d| d.is_dir())
        .map(|d| wide(&d.to_string_lossy()))
}

/// Chạy hộp thoại mở nhiều PDF. Trả về các tệp đã chọn; rỗng khi hủy.
pub fn open_pdfs(initial_dir: Option<&Path>) -> Vec<PathBuf> {
    let mut filter = pdf_filter();
    let mut file = vec![0u16; FILE_BUFFER];
    let title = wide("Mở PDF");
    let dir = initial_dir_wide(initial_dir);
    record_dialog_request(
        "open",
        dir.as_deref(),
        file.len(),
        std::ptr::null(),
        open_flags(),
    );
    let mut ofn = new_ofn(
        filter.as_mut_ptr(),
        file.as_mut_ptr(),
        file.len() as u32,
        title.as_ptr(),
        dir.as_ref().map_or(std::ptr::null(), |d| d.as_ptr()),
        std::ptr::null(),
        open_flags(),
    );
    spawn_e2e_closer();
    // SAFETY: mọi con trỏ trỏ tới vec và chuỗi còn sống trong lời gọi; kích thước vùng file khai đúng.
    let ok = unsafe { GetOpenFileNameW(&mut ofn) };
    open_result(ok, &file)
}

/// Chạy hộp thoại lưu một PDF, tên gợi ý là `suggested`. Trả về None khi hủy.
pub fn save_pdf(initial_dir: Option<&Path>, suggested: &str) -> Option<PathBuf> {
    let mut filter = pdf_filter();
    let mut file = vec![0u16; 1024];
    for (slot, unit) in file.iter_mut().zip(suggested.encode_utf16()) {
        *slot = unit;
    }
    let title = wide("Lưu PDF");
    let dir = initial_dir_wide(initial_dir);
    record_dialog_request(
        "save",
        dir.as_deref(),
        file.len(),
        PDF_DEFAULT_EXTENSION.as_ptr(),
        save_flags(),
    );
    let mut ofn = new_ofn(
        filter.as_mut_ptr(),
        file.as_mut_ptr(),
        file.len() as u32,
        title.as_ptr(),
        dir.as_ref().map_or(std::ptr::null(), |d| d.as_ptr()),
        PDF_DEFAULT_EXTENSION.as_ptr(),
        save_flags(),
    );
    spawn_e2e_closer();
    // SAFETY: như `open_pdfs`.
    let ok = unsafe { GetSaveFileNameW(&mut ofn) };
    save_result(ok, &file)
}

fn record_dialog_request(
    kind: &str,
    initial_dir: Option<&[u16]>,
    max_file: usize,
    default_extension: *const u16,
    flags: u32,
) {
    let initial_dir = initial_dir
        .and_then(|path| path.strip_suffix(&[0]))
        .map(String::from_utf16_lossy);
    let default_extension = if default_extension.is_null() {
        None
    } else {
        Some(String::from_utf16_lossy(
            &PDF_DEFAULT_EXTENSION[..PDF_DEFAULT_EXTENSION.len() - 1],
        ))
    };
    crate::debug::set_file_dialog_request(serde_json::json!({
        "kind": kind,
        "initialDir": initial_dir,
        "filterIndex": 1,
        "maxFile": max_file,
        "allowMultiSelect": flags & OFN_ALLOWMULTISELECT != 0,
        "defaultExtension": default_extension,
        "flags": flags,
    }));
}

fn open_flags() -> u32 {
    OFN_EXPLORER | OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_ALLOWMULTISELECT | OFN_HIDEREADONLY
}

fn save_flags() -> u32 {
    OFN_EXPLORER | OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_HIDEREADONLY
}

fn open_result(ok: i32, file: &[u16]) -> Vec<PathBuf> {
    if ok == 0 {
        Vec::new()
    } else {
        parse_selection(file)
    }
}

fn save_result(ok: i32, file: &[u16]) -> Option<PathBuf> {
    if ok == 0 {
        None
    } else {
        parse_selection(file).into_iter().next()
    }
}

fn new_ofn(
    filter: *mut u16,
    file: *mut u16,
    max_file: u32,
    title: *const u16,
    initial_dir: *const u16,
    def_ext: *const u16,
    flags: u32,
) -> OpenFileNameW {
    OpenFileNameW {
        struct_size: std::mem::size_of::<OpenFileNameW>() as u32,
        owner: 0,
        instance: 0,
        filter,
        custom_filter: std::ptr::null_mut(),
        max_custom_filter: 0,
        filter_index: 1,
        file,
        max_file,
        file_title: std::ptr::null_mut(),
        max_file_title: 0,
        initial_dir,
        title,
        flags,
        file_offset: 0,
        file_extension: 0,
        def_ext,
        cust_data: 0,
        hook: 0,
        template_name: std::ptr::null(),
        reserved: std::ptr::null_mut(),
        reserved_dw: 0,
        flags_ex: 0,
    }
}

/// Chỉ E2E: nếu `CHEF_E2E_CLOSE_DIALOGS=1`, sau khoảng 800 ms đóng mọi hộp thoại (#32770) của tiến
/// trình này, để kiểm đường hủy mà không cần thao tác chuột. Việc đóng chạy trên luồng riêng.
fn spawn_e2e_closer() {
    if std::env::var("CHEF_E2E_CLOSE_DIALOGS").as_deref() != Ok("1") {
        return;
    }
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_millis(800));
        // SAFETY: EnumWindows gọi callback với các cửa sổ cấp cao nhất; callback chỉ đọc và gửi WM_CLOSE.
        unsafe { EnumWindows(close_common_dialog, 0) };
    });
}

unsafe extern "system" fn close_common_dialog(hwnd: isize, _param: isize) -> i32 {
    let mut pid = 0u32;
    // SAFETY: hwnd do EnumWindows cấp; pid là con trỏ tới biến cục bộ.
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    // SAFETY: lấy PID của tiến trình hiện tại, không có tham số.
    if pid != unsafe { GetCurrentProcessId() } {
        return 1;
    }
    let mut class = [0u16; 16];
    // SAFETY: class có đúng độ dài khai báo.
    let n = unsafe { GetClassNameW(hwnd, class.as_mut_ptr(), class.len() as i32) };
    if String::from_utf16_lossy(&class[..n.max(0) as usize]) == "#32770" {
        // SAFETY: gửi WM_CLOSE tới cửa sổ hộp thoại của chính tiến trình này.
        unsafe { PostMessageW(hwnd, WM_CLOSE, 0, 0) };
    }
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filter_lists_pdf_first_and_ends_with_two_nuls() {
        let f = pdf_filter();
        assert_eq!(&f[f.len() - 2..], &[0, 0]);
        let text = String::from_utf16_lossy(&f);
        assert!(text.starts_with("Tài liệu PDF (*.pdf)\0*.pdf\0"));
    }

    #[test]
    fn single_selection_is_a_full_path() {
        let buf: Vec<u16> = "C:\\Tài liệu\\a.pdf\0\0".encode_utf16().collect();
        assert_eq!(
            parse_selection(&buf),
            vec![PathBuf::from("C:\\Tài liệu\\a.pdf")]
        );
    }

    #[test]
    fn multi_selection_joins_the_folder_with_each_name() {
        let buf: Vec<u16> = "D:\\in\0a.pdf\0b.pdf\0\0".encode_utf16().collect();
        assert_eq!(
            parse_selection(&buf),
            vec![
                PathBuf::from("D:\\in\\a.pdf"),
                PathBuf::from("D:\\in\\b.pdf")
            ]
        );
    }

    #[test]
    fn empty_buffer_means_nothing_selected() {
        assert!(parse_selection(&[0, 0]).is_empty());
    }

    #[test]
    fn cancel_returns_no_selection_for_open_and_save() {
        assert!(open_result(0, &[0, 0]).is_empty());
        assert_eq!(save_result(0, &[0, 0]), None);
    }

    #[test]
    fn initial_dir_is_used_only_when_it_exists() {
        assert!(initial_dir_wide(Some(Path::new("Z:\\khong-co-thu-muc-nay"))).is_none());
        assert!(initial_dir_wide(None).is_none());
        assert!(initial_dir_wide(Some(&std::env::temp_dir())).is_some());
    }

    #[test]
    fn open_file_dialog_capacity_matches_the_provided_buffer() {
        let mut filter = pdf_filter();
        let mut file = vec![0u16; 1024];
        let title = wide("Lưu PDF");
        let ofn = new_ofn(
            filter.as_mut_ptr(),
            file.as_mut_ptr(),
            file.len() as u32,
            title.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            OFN_PATHMUSTEXIST,
        );
        assert_eq!(ofn.max_file, file.len() as u32);
    }

    #[test]
    fn open_dialog_defaults_to_pdf_filter_and_multiple_existing_files() {
        let flags = open_flags();
        assert_eq!(
            new_ofn(
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                flags
            )
            .filter_index,
            1
        );
        assert_eq!(
            flags & (OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_ALLOWMULTISELECT),
            OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_ALLOWMULTISELECT
        );
    }

    #[test]
    fn save_dialog_uses_pdf_default_extension_and_overwrite_confirmation() {
        let ofn = new_ofn(
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
            std::ptr::null(),
            PDF_DEFAULT_EXTENSION.as_ptr(),
            save_flags(),
        );
        // SAFETY: the pointer refers to all four elements of the static PDF_DEFAULT_EXTENSION.
        let extension =
            unsafe { std::slice::from_raw_parts(ofn.def_ext, PDF_DEFAULT_EXTENSION.len()) };
        assert_eq!(extension, PDF_DEFAULT_EXTENSION.as_slice());
        assert_ne!(ofn.flags & OFN_OVERWRITEPROMPT, 0);
    }
}
