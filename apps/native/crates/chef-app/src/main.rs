//! Chef PDF (bản native, M1).
//!
//! Dùng: `chef-app [tệp.pdf]`.
//!
//! Hai đường mở cửa sổ:
//! - Bình thường: cửa sổ hiện giữa màn hình, kích thước 1200×860, có viewer PDF.
//! - E2E (`CHEF_E2E=1`): cửa sổ tạo ẩn rồi đưa ra ngoài màn hình bằng SetWindowPos (GPUI không
//!   nhận tọa độ âm qua WindowOptions: nó thay bằng vị trí giữa màn hình chính). Kênh debug bật.
//!   Không có bước nào hiện cửa sổ trên màn hình của người dùng ở đường này.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use gpui::{
    Action, App, Bounds, Window, WindowBounds, WindowHandle, WindowOptions, prelude::*, px, size,
};
use gpui_platform::application;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

mod assets;
mod capture;
mod debug;
mod find;
mod night;
mod probe;
mod settings;
mod theme;
mod viewer;

use viewer::Viewer;

/// Góc trên trái của cửa sổ E2E, nằm xa ngoài mọi màn hình hiện có.
const OFFSCREEN_ORIGIN: (i32, i32) = (-20000, -20000);

/// Kích thước tối thiểu của cửa sổ, lấy từ MIN_SIZE của bản Electron (apps/desktop/src/main/windowState.ts).
const MIN_SIZE: (f32, f32) = (800.0, 560.0);

/// Kích thước cửa sổ khi chạy bình thường (pixel logic).
const DEFAULT_SIZE: (f32, f32) = (1200.0, 860.0);

const SW_SHOWNOACTIVATE: i32 = 4;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;

#[link(name = "user32")]
unsafe extern "system" {
    fn SetWindowPos(
        hwnd: isize,
        insert_after: isize,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> i32;
    fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
}

/// HWND và hệ số scale của cửa sổ GPUI. Gọi trong `window.update`, không đổi vị trí hay kích thước.
fn hwnd_of(window: &mut Window) -> Result<(isize, f32), String> {
    // Gọi qua trait: Window có phương thức window_handle() riêng của GPUI, trả AnyWindowHandle.
    let handle =
        HasWindowHandle::window_handle(window).map_err(|e| format!("không lấy được HWND: {e}"))?;
    let RawWindowHandle::Win32(win32) = handle.as_raw() else {
        return Err("không phải cửa sổ Win32".into());
    };
    Ok((win32.hwnd.get(), window.scale_factor()))
}

/// Đưa cửa sổ E2E ra ngoài màn hình rồi hiện nó mà không kích hoạt.
///
/// Phải gọi NGOÀI `window.update`: SetWindowPos/ShowWindow gửi WM_SIZE đồng bộ vào GPUI.
/// Nếu gọi trong update, kích thước viewport không được cập nhật (còn giá trị CW_USEDEFAULT) và
/// không khung nào được vẽ.
fn show_offscreen(hwnd: isize, scale: f32, size: (f32, f32)) -> Result<(), String> {
    // Truyền kích thước thật (không SWP_NOSIZE): Windows chỉ gửi WM_SIZE khi kích thước đổi,
    // và GPUI cần WM_SIZE để cập nhật viewport.
    let (cx, cy) = (
        (size.0 * scale).round() as i32,
        (size.1 * scale).round() as i32,
    );
    // SAFETY: hwnd là cửa sổ GPUI vừa tạo, còn sống trong luồng UI này.
    unsafe {
        if SetWindowPos(
            hwnd,
            0,
            OFFSCREEN_ORIGIN.0,
            OFFSCREEN_ORIGIN.1,
            cx,
            cy,
            SWP_NOZORDER | SWP_NOACTIVATE,
        ) == 0
        {
            return Err("SetWindowPos thất bại".into());
        }
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
    Ok(())
}

/// Chỉ E2E (R1.13, R1.15–R1.19): mở trang thử hình họa ngoài màn hình và bật kênh debug.
fn open_probe_offscreen(cx: &mut App, min: Option<gpui::Size<gpui::Pixels>>) {
    // CHEF_E2E_PROBE_WIDTH: chiều rộng khung (pixel logic), để đo auto-fit ở nhiều cỡ (R1.17).
    let width = std::env::var("CHEF_E2E_PROBE_WIDTH")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
        .unwrap_or(DEFAULT_SIZE.0);
    let bounds = Bounds {
        origin: gpui::point(px(OFFSCREEN_ORIGIN.0 as f32), px(OFFSCREEN_ORIGIN.1 as f32)),
        size: size(px(width), px(DEFAULT_SIZE.1)),
    };
    let window = cx
        .open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: min,
                show: false,
                ..Default::default()
            },
            |_, cx| cx.new(probe::Probe::new),
        )
        .expect("mở trang thử thất bại");
    window
        .update(cx, |probe, window, cx| probe.focus_button(window, cx))
        .expect("cập nhật trang thử thất bại");
    spawn_action_pump(window, cx);
    let (hwnd, scale) = window
        .update(cx, |_, window, _| hwnd_of(window))
        .expect("cập nhật cửa sổ thất bại")
        .expect("không lấy được HWND");
    cx.spawn(async move |_| {
        show_offscreen(hwnd, scale, (width, DEFAULT_SIZE.1))
            .expect("đưa cửa sổ ra ngoài màn hình thất bại");
    })
    .detach();
    debug::start(hwnd).expect("không bật được kênh debug");
}

/// Chỉ E2E: chạy action từ kênh debug trên luồng GPUI, đúng đường keymap. Dùng cho trang thử;
/// viewer có vòng lặp riêng vì còn ghi trạng thái ô tìm kiếm.
fn spawn_action_pump<V: 'static>(window: WindowHandle<V>, cx: &mut App) {
    cx.spawn(async move |cx| {
        loop {
            cx.background_executor()
                .timer(Duration::from_millis(16))
                .await;
            let alive = window.update(cx, |_, window, cx| {
                for name in debug::take_actions() {
                    if let Some(action) = action_for(&name) {
                        window.dispatch_action(action, cx);
                    }
                }
            });
            if alive.is_err() {
                break;
            }
        }
    })
    .detach();
}

/// Đổi tên action của kênh debug (debug::ACTION_NAMES) thành action của ô nhập.
fn action_for(name: &str) -> Option<Box<dyn Action>> {
    use chef_ui::text_input as t;
    let action: Box<dyn Action> = match name {
        "selectall" => Box::new(t::SelectAll),
        "selectleft" => Box::new(t::SelectLeft),
        "selectright" => Box::new(t::SelectRight),
        "left" => Box::new(t::Left),
        "right" => Box::new(t::Right),
        "home" => Box::new(t::Home),
        "end" => Box::new(t::End),
        "backspace" => Box::new(t::Backspace),
        "delete" => Box::new(t::Delete),
        "copy" => Box::new(t::Copy),
        "cut" => Box::new(t::Cut),
        "paste" => Box::new(t::Paste),
        "submit" => Box::new(t::Submit),
        "submitback" => Box::new(t::SubmitBack),
        "cancel" => Box::new(t::Cancel),
        "focussearch" => Box::new(viewer::FocusSearch),
        "selectalltext" => Box::new(viewer::SelectAllText),
        "copyselection" => Box::new(viewer::CopySelection),
        "zoomin" => Box::new(viewer::ZoomIn),
        "zoomout" => Box::new(viewer::ZoomOut),
        "zoomreset" => Box::new(viewer::ZoomReset),
        "nextpage" => Box::new(viewer::NextPage),
        "prevpage" => Box::new(viewer::PrevPage),
        "togglefullscreen" => Box::new(viewer::ToggleFullscreen),
        "togglenight" => Box::new(viewer::ToggleNight),
        "focusnext" => Box::new(chef_ui::button::FocusNext),
        "focusprev" => Box::new(chef_ui::button::FocusPrev),
        _ => return None,
    };
    Some(action)
}

/// Thư mục chứa exe: pdfium.dll được build copy vào đây (build.rs).
fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(PathBuf::from))
        .unwrap_or_default()
}

fn main() {
    // Tham số đầu tiên không bắt đầu bằng "-" là đường dẫn PDF.
    let pdf = std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-'))
        .map(PathBuf::from);
    let e2e = std::env::var("CHEF_E2E").as_deref() == Ok("1");

    application()
        .with_assets(assets::Embedded)
        .run(move |cx: &mut App| {
            chef_ui::text_input::bind_keys(cx);
            chef_ui::button::bind_keys(cx);
            chef_ui::dialog::bind_keys(cx);
            viewer::bind_keys(cx);
            assets::register_fonts(cx);
            let handle = match chef_pdf::render::spawn(exe_dir()) {
                Ok(h) => h,
                Err(e) => {
                    eprintln!("không khởi động được pdfium: {e}");
                    eprintln!("chạy: node scripts/fetch-pdfium.mjs, rồi build lại chef-app");
                    std::process::exit(2);
                }
            };
            let min = Some(size(px(MIN_SIZE.0), px(MIN_SIZE.1)));

            if e2e && std::env::var("CHEF_E2E_PROBE").as_deref() == Ok("1") {
                open_probe_offscreen(cx, min);
                return;
            }
            if e2e {
                let bounds = Bounds {
                    origin: gpui::point(
                        px(OFFSCREEN_ORIGIN.0 as f32),
                        px(OFFSCREEN_ORIGIN.1 as f32),
                    ),
                    size: size(px(DEFAULT_SIZE.0), px(DEFAULT_SIZE.1)),
                };
                let window = cx
                    .open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(bounds)),
                            window_min_size: min,
                            // Tạo ẩn: GPUI không đặt vị trí khi show = false, còn show_offscreen tự làm.
                            show: false,
                            ..Default::default()
                        },
                        |_, cx| cx.new(|cx| Viewer::open(handle.clone(), pdf.clone(), cx)),
                    )
                    .expect("mở cửa sổ E2E thất bại");
                // Chỉ để đo (R1.34, R1.35): cuộn từng màn hình, mỗi bước cách nhau 150 ms.
                if let Some(screens) = std::env::var("CHEF_E2E_SCROLL_SCREENS")
                    .ok()
                    .and_then(|v| v.parse::<u32>().ok())
                {
                    cx.spawn(async move |cx| {
                        for _ in 0..screens {
                            cx.background_executor()
                                .timer(Duration::from_millis(150))
                                .await;
                            if window
                                .update(cx, |viewer, _window, cx| {
                                    viewer.scroll_screens(1.0);
                                    cx.notify();
                                })
                                .is_err()
                            {
                                break;
                            }
                        }
                    })
                    .detach();
                }
                let (hwnd, scale) = window
                    .update(cx, |viewer, window, cx| {
                        viewer.focus_search(window, cx);
                        hwnd_of(window)
                    })
                    .expect("cập nhật cửa sổ thất bại")
                    .expect("không lấy được HWND");
                // Chạy trong task riêng: WM_SIZE đồng bộ gọi lại GPUI qua AsyncApp, và chỉ hoạt động
                // khi closure run() đã trả về (không còn mượn &mut App). Nếu gọi ngay, bounds_changed
                // thất bại âm thầm và viewport giữ giá trị CW_USEDEFAULT.
                cx.spawn(async move |cx| {
                    show_offscreen(hwnd, scale, DEFAULT_SIZE)
                        .expect("đưa cửa sổ ra ngoài màn hình thất bại");
                    // Khung đầu tiên được vẽ khi cửa sổ còn ẩn (show: false), nên yêu cầu vẽ lại sau khi hiện.
                    let _ = window.update(cx, |_, window, _| window.refresh());
                })
                .detach();
                debug::start(hwnd).expect("không bật được kênh debug");

                // Chỉ E2E: chạy action từ kênh debug trên luồng GPUI (đúng đường keymap) và ghi trạng
                // thái ô tìm kiếm để lệnh `state` đọc được (R1.22).
                cx.spawn(async move |cx| {
                    loop {
                        cx.background_executor()
                            .timer(Duration::from_millis(16))
                            .await;
                        let alive = window.update(cx, |viewer, window, cx| {
                            for name in debug::take_actions() {
                                if let Some(action) = action_for(&name) {
                                    window.dispatch_action(action, cx);
                                }
                            }
                            let input = viewer.search().read(cx);
                            debug::set_input(input.text(), input.selected_range());
                        });
                        if alive.is_err() {
                            break;
                        }
                    }
                })
                .detach();

                // Chỉ để đo (R1.08): ép vẽ lại mỗi 16 ms trong CHEF_E2E_SPIN_MS mili giây.
                if let Some(ms) = std::env::var("CHEF_E2E_SPIN_MS")
                    .ok()
                    .and_then(|v| v.parse::<u64>().ok())
                {
                    cx.spawn(async move |cx| {
                        let end = Instant::now() + Duration::from_millis(ms);
                        while Instant::now() < end {
                            cx.background_executor()
                                .timer(Duration::from_millis(16))
                                .await;
                            if window.update(cx, |_, window, _| window.refresh()).is_err() {
                                break;
                            }
                        }
                    })
                    .detach();
                }
            } else {
                let window = cx
                    .open_window(
                        WindowOptions {
                            window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                                None,
                                size(px(DEFAULT_SIZE.0), px(DEFAULT_SIZE.1)),
                                cx,
                            ))),
                            window_min_size: min,
                            ..Default::default()
                        },
                        |_, cx| cx.new(|cx| Viewer::open(handle.clone(), pdf.clone(), cx)),
                    )
                    .expect("mở cửa sổ thất bại");
                window
                    .update(cx, |viewer, window, cx| viewer.focus_search(window, cx))
                    .expect("cập nhật cửa sổ thất bại");
                cx.activate(true);
            }
        });
}
