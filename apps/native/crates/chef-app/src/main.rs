//! Chef PDF (bản native, M1).
//!
//! Dùng: `chef-app [tệp.pdf]`.
//!
//! Hai đường mở cửa sổ:
//! - Bình thường: cửa sổ hiện giữa màn hình, kích thước 1200×860, có viewer PDF.
//! - E2E (`CHEF_E2E=1`): cửa sổ tạo ẩn rồi đưa ra ngoài màn hình bằng SetWindowPos (GPUI không
//!   nhận tọa độ âm qua WindowOptions: nó thay bằng vị trí giữa màn hình chính). Kênh debug bật.
//!   Riêng probe hình họa có thể hiện cửa sổ khi đặt thêm `CHEF_E2E_PROBE_VISIBLE=1` để đo cursor thật.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use gpui::{
    Action, App, Bounds, Window, WindowBounds, WindowHandle, WindowOptions, prelude::*, px, size,
};
use gpui_platform::application;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

mod annots;
mod assets;
pub mod bookmarks;
#[cfg(windows)]
mod capture;
mod close;
mod commands;
#[cfg(windows)]
mod debug;
#[cfg(not(windows))]
#[path = "debug_stub.rs"]
mod debug;
#[cfg(windows)]
mod dialogs;
#[cfg(not(windows))]
#[path = "dialogs_stub.rs"]
mod dialogs;
mod draw;
mod drop;
mod find;
#[cfg(windows)]
mod image_edit;
mod insert_image;
mod instance;
mod layers;
mod links;
mod logging;
mod night;
pub mod notes;
mod notes_list;
mod objects;
mod page_ops;
mod password;
mod probe;
mod properties;
mod recovery;
mod session;
mod settings;
mod settings_dialog;
#[allow(dead_code)]
mod source_guard;
mod start;
mod tabs;
mod tabs_host;
mod theme;
mod viewer;

use tabs_host::DocumentHost;

/// Góc trên trái của cửa sổ E2E, nằm xa ngoài mọi màn hình hiện có.
const OFFSCREEN_ORIGIN: (i32, i32) = (-20000, -20000);

/// Kích thước tối thiểu của cửa sổ, lấy từ MIN_SIZE của bản Electron (apps/desktop/src/main/windowState.ts).
const MIN_SIZE: (f32, f32) = (800.0, 560.0);

/// Kích thước cửa sổ khi chạy bình thường (pixel logic).
const DEFAULT_SIZE: (f32, f32) = (1200.0, 860.0);

/// Chiều cao cửa sổ trang thử (E2E). Trang thử cao hơn cửa sổ thường, nên các khu ở cuối trang (menu,
/// ô chọn, hộp thoại) phải nằm trong khung để E2E bấm được bằng chuột.
const PROBE_HEIGHT: f32 = 1600.0;

const SW_SHOWNOACTIVATE: i32 = 4;
const SWP_NOZORDER: u32 = 0x0004;
const SWP_NOACTIVATE: u32 = 0x0010;

#[cfg(windows)]
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
    fn GetWindowRect(hwnd: isize, rect: *mut WinRect) -> i32;
    fn GetClientRect(hwnd: isize, rect: *mut WinRect) -> i32;
}

/// RECT của Win32 (left, top, right, bottom).
#[cfg(windows)]
#[repr(C)]
#[derive(Clone, Copy)]
struct WinRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
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
#[cfg(windows)]
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

#[cfg(not(windows))]
fn show_offscreen(_hwnd: isize, _scale: f32, _size: (f32, f32)) -> Result<(), String> {
    Err("chế độ E2E ngoài màn hình chỉ hỗ trợ Windows".into())
}

/// Chỉ trang thử (R1.43): SetWindowPos đặt kích thước KHUNG NGOÀI, nên vùng client thật nhỏ hơn
/// (trừ thanh tiêu đề và viền). Hàm này đo phần khung rồi đặt lại để vùng client đúng
/// `size` (logic × scale), khớp kích thước viewport của bản Electron ở cùng cỡ.
/// Gọi ngoài `window.update`, sau `show_offscreen`.
#[cfg(windows)]
fn fit_client_size(hwnd: isize, scale: f32, size: (f32, f32)) -> Result<(), String> {
    let zero = WinRect {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    let (mut outer, mut client) = (zero, zero);
    // SAFETY: hwnd là cửa sổ GPUI còn sống; hai con trỏ trỏ tới biến cục bộ hợp lệ.
    unsafe {
        if GetWindowRect(hwnd, &mut outer) == 0 || GetClientRect(hwnd, &mut client) == 0 {
            return Err("GetWindowRect/GetClientRect thất bại".into());
        }
    }
    let frame_w = (outer.right - outer.left) - (client.right - client.left);
    let frame_h = (outer.bottom - outer.top) - (client.bottom - client.top);
    let cx = (size.0 * scale).round() as i32 + frame_w;
    let cy = (size.1 * scale).round() as i32 + frame_h;
    // SAFETY: như trên; vị trí truyền tường minh là OFFSCREEN_ORIGIN, giống show_offscreen.
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
            return Err("SetWindowPos (client) thất bại".into());
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn fit_client_size(_hwnd: isize, _scale: f32, _size: (f32, f32)) -> Result<(), String> {
    Err("chế độ E2E ngoài màn hình chỉ hỗ trợ Windows".into())
}

/// Chỉ E2E (R1.13, R1.15–R1.19): mở trang thử hình họa ngoài màn hình và bật kênh debug.
fn open_probe_window(cx: &mut App, min: Option<gpui::Size<gpui::Pixels>>) {
    // CHEF_E2E_PROBE_WIDTH: chiều rộng khung (pixel logic), để đo auto-fit ở nhiều cỡ (R1.17).
    let width = std::env::var("CHEF_E2E_PROBE_WIDTH")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
        .unwrap_or(DEFAULT_SIZE.0);
    let visible = std::env::var("CHEF_E2E_PROBE_VISIBLE").as_deref() == Ok("1");
    let origin = if visible {
        gpui::point(px(96.), px(96.))
    } else {
        gpui::point(px(OFFSCREEN_ORIGIN.0 as f32), px(OFFSCREEN_ORIGIN.1 as f32))
    };
    let bounds = Bounds {
        origin,
        size: size(px(width), px(PROBE_HEIGHT)),
    };
    let window = cx
        .open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: min,
                show: visible,
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
    if !visible {
        cx.spawn(async move |_| {
            show_offscreen(hwnd, scale, (width, PROBE_HEIGHT))
                .expect("đưa cửa sổ ra ngoài màn hình thất bại");
            fit_client_size(hwnd, scale, (width, PROBE_HEIGHT))
                .expect("đặt vùng client trang thử thất bại");
        })
        .detach();
    }
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
            // Tổ hợp phím chạy sau khi update kết thúc: handler của viewer có thể cập nhật lại
            // DocumentHost, và làm vậy trong update đang chạy sẽ panic (re-entrant update).
            let keystrokes = debug::take_keystrokes();
            if !keystrokes.is_empty() {
                // AnyWindowHandle không lease root view (WindowHandle::update thì có, và render lại sẽ panic).
                let any: gpui::AnyWindowHandle = window.into();
                let _ = any.update(cx, |_, window, cx| {
                    for keystroke in keystrokes {
                        if let Ok(parsed) = gpui::Keystroke::parse(&keystroke) {
                            window.dispatch_keystroke(parsed, cx);
                        }
                    }
                });
            }
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
        "selectalltextdocument" => Box::new(viewer::SelectAllTextDocument),
        "copyselection" => Box::new(viewer::CopySelection),
        "zoomin" => Box::new(viewer::ZoomIn),
        "zoomout" => Box::new(viewer::ZoomOut),
        "zoomreset" => Box::new(viewer::ZoomReset),
        "zoomfitpage" => Box::new(viewer::ZoomFitPage),
        "rotateviewleft" => Box::new(viewer::RotateViewLeft),
        "rotateviewright" => Box::new(viewer::RotateViewRight),
        "focuszoom" => Box::new(viewer::FocusZoomInput),
        "nextpage" => Box::new(viewer::NextPage),
        "prevpage" => Box::new(viewer::PrevPage),
        "togglefullscreen" => Box::new(viewer::ToggleFullscreen),
        "viewcontinuous" => Box::new(viewer::SetContinuous),
        "viewtwopage" => Box::new(viewer::SetTwoPage),
        "viewbook" => Box::new(viewer::SetBook),
        "viewslideshow" => Box::new(viewer::SetSlideshow),
        "slidenext" => Box::new(viewer::SlideNext),
        "slideprevious" => Box::new(viewer::SlidePrevious),
        "exitslideshow" => Box::new(viewer::ExitSlideshow),
        "togglenight" => Box::new(viewer::ToggleNight),
        "focusnext" => Box::new(chef_ui::button::FocusNext),
        "focusprev" => Box::new(chef_ui::button::FocusPrev),
        "opensettings" => Box::new(viewer::OpenSettings),
        "openfile" => Box::new(viewer::OpenFile),
        "openpalette" => Box::new(commands::OpenPalette),
        "palettenext" => Box::new(commands::PaletteNext),
        "paletteprev" => Box::new(commands::PalettePrevious),
        "tabnext" => Box::new(tabs_host::NextTab),
        "tabprev" => Box::new(tabs_host::PreviousTab),
        "closetab" => Box::new(tabs_host::CloseTab),
        "openproperties" => Box::new(viewer::OpenProperties),
        "editbookmarks" => Box::new(viewer::EditBookmarks),
        "rotatepage" => Box::new(viewer::RotatePage),
        "rotatepageleft" => Box::new(viewer::RotatePageLeft),
        "deletepages" => Box::new(viewer::DeletePages),
        "duplicatepages" => Box::new(viewer::DuplicatePages),
        "extractpages" => Box::new(viewer::ExtractPages),
        "insertblankbefore" => Box::new(viewer::InsertBlankBefore),
        "insertblankafter" => Box::new(viewer::InsertBlankAfter),
        "insertpagesfromfile" => Box::new(viewer::InsertPagesFromFile),
        "replaceselectedpages" => Box::new(viewer::ReplaceSelectedPages),
        "selectallpages" => Box::new(viewer::SelectAllPages),
        "invertpageselection" => Box::new(viewer::InvertPageSelection),
        "selectoddpages" => Box::new(viewer::SelectOddPages),
        "selectevenpages" => Box::new(viewer::SelectEvenPages),
        "clearpageselection" => Box::new(viewer::ClearPageSelection),
        "undoedit" => Box::new(viewer::UndoEdit),
        "redoedit" => Box::new(viewer::RedoEdit),
        "saveedit" => Box::new(viewer::SaveEdit),
        "saveeditas" => Box::new(viewer::SaveEditAs),
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

#[cfg(windows)]
fn dispatch_instance_requests(
    server: instance::InstanceServer,
    window: WindowHandle<DocumentHost>,
    cx: &mut App,
) {
    cx.spawn(async move |cx| {
        loop {
            cx.background_executor()
                .timer(Duration::from_millis(30))
                .await;
            match server.try_recv() {
                Ok(paths) => {
                    if window
                        .update(cx, |host, window, cx| {
                            host.open_paths(paths, window, cx);
                            window.activate_window();
                            cx.activate(true);
                        })
                        .is_err()
                    {
                        break;
                    }
                }
                Err(std::sync::mpsc::TryRecvError::Empty) => {}
                Err(std::sync::mpsc::TryRecvError::Disconnected) => break,
            }
        }
    })
    .detach();
}

fn main() {
    logging::init(&settings::user_data_dir());
    logging::info("khởi động");
    let pdfs = drop::parse_argv(std::env::args_os().skip(1));
    let e2e = std::env::var("CHEF_E2E").as_deref() == Ok("1");
    let e2e_probe = e2e && std::env::var("CHEF_E2E_PROBE").as_deref() == Ok("1");
    #[cfg(windows)]
    let instance_server = if e2e_probe {
        None
    } else {
        match instance::start(pdfs.clone(), &settings::user_data_dir()) {
            Ok(instance::LaunchInstance::Primary(server)) => Some(server),
            Ok(instance::LaunchInstance::Forwarded) => return,
            Err(error) => {
                eprintln!("không chuyển được yêu cầu tới Chef PDF đang chạy: {error}");
                return;
            }
        }
    };

    application()
        .with_assets(assets::Embedded)
        .run(move |cx: &mut App| {
            #[cfg(windows)]
            let mut instance_server = instance_server;
            chef_ui::text_input::bind_keys(cx);
            chef_ui::button::bind_keys(cx);
            chef_ui::dialog::bind_keys(cx);
            chef_ui::choice::bind_keys(cx);
            chef_ui::menu::bind_keys(cx);
            chef_ui::tabs::bind_keys(cx);
            viewer::bind_keys(cx);
            commands::bind_keys(cx);
            tabs_host::bind_keys(cx);
            assets::register_fonts(cx);
            let handle = match chef_pdf::render::spawn(exe_dir()) {
                Ok(h) => h,
                Err(e) => {
                    eprintln!("không khởi động được pdfium: {e}");
                    eprintln!("chạy: node scripts/fetch-pdfium.mjs, rồi build lại chef-app");
                    std::process::exit(2);
                }
            };
            #[cfg(windows)]
            let supervisor = {
                use chef_rpc::{CoreCommand, Supervisor, SupervisorConfig};
                use std::sync::{Arc, Mutex};
                let core = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../core");
                let data = settings::user_data_dir();
                let command = CoreCommand {
                    program: core.join(".venv/Scripts/python.exe"),
                    args: vec![
                        "-m".into(),
                        "chef_core".into(),
                        "--data-dir".into(),
                        data.display().to_string(),
                    ],
                    cwd: core,
                };
                let log = Arc::new(|line: &str| logging::info(line));
                let mut config = SupervisorConfig::new(command, log);
                if e2e && let Ok(raw) = std::env::var("CHEF_E2E_IDLE_STOP_MS") {
                    match raw.parse::<u64>() {
                        Ok(ms) if (1..=60_000).contains(&ms) => {
                            config.idle_stop = Some(std::time::Duration::from_millis(ms));
                        }
                        _ => {
                            eprintln!("CHEF_E2E_IDLE_STOP_MS phải từ 1 đến 60000");
                            std::process::exit(2);
                        }
                    }
                }
                Some(Arc::new(Mutex::new(Supervisor::lazy(config))))
            };
            #[cfg(not(windows))]
            let supervisor = None;
            if let Some(sup_for_shutdown) = supervisor.clone() {
                debug::set_shutdown_hook(move || {
                    if let Ok(mut sup) = sup_for_shutdown.lock() {
                        sup.shutdown(Duration::from_secs(3));
                    }
                });
            }
            let min = Some(size(px(MIN_SIZE.0), px(MIN_SIZE.1)));

            if e2e_probe {
                open_probe_window(cx, min);
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
                        |_, cx| {
                            cx.new(|cx| {
                                DocumentHost::new(
                                    pdfs.clone(),
                                    handle.clone(),
                                    supervisor.clone(),
                                    cx,
                                )
                            })
                        },
                    )
                    .expect("mở cửa sổ E2E thất bại");
                let (hwnd, scale) = window
                    .update(cx, |host, window, cx| {
                        let entity = cx.entity();
                        window.on_window_should_close(cx, move |window, cx| {
                            entity
                                .update(cx, |host, cx| host.handle_window_close_request(window, cx))
                        });
                        host.focus_active(window, cx);
                        hwnd_of(window)
                    })
                    .expect("cập nhật cửa sổ thất bại")
                    .expect("không lấy được HWND");
                #[cfg(windows)]
                if let Some(server) = instance_server.take() {
                    dispatch_instance_requests(server, window, cx);
                }
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
                        for screens in debug::take_scroll_screens() {
                            let total = screens.abs().ceil() as u32;
                            let direction = screens.signum();
                            let mut remaining = screens.abs();
                            for completed in 1..=total {
                                let amount = remaining.min(1.0) * direction;
                                if window
                                    .update(cx, |host, _window, cx| {
                                        host.scroll_active(amount, cx);
                                    })
                                    .is_err()
                                {
                                    return;
                                }
                                remaining -= amount.abs();
                                debug::set_scroll_progress(completed, total, true);
                                cx.background_executor()
                                    .timer(Duration::from_millis(150))
                                    .await;
                            }
                            debug::set_scroll_progress(total, total, false);
                        }
                        let alive = window.update(cx, |host, window, cx| {
                            for name in debug::take_actions() {
                                if let Some(action) = action_for(&name) {
                                    window.dispatch_action(action, cx);
                                }
                            }
                            if let Some((text, selection, focused)) = host.active_search(window, cx)
                            {
                                debug::set_input(&text, selection, focused);
                            }
                        });
                        let keystrokes = debug::take_keystrokes();
                        if !keystrokes.is_empty() {
                            // AnyWindowHandle không lease root view (WindowHandle::update thì có, và render lại sẽ panic).
                            let any: gpui::AnyWindowHandle = window.into();
                            let _ = any.update(cx, |_, window, cx| {
                                for keystroke in keystrokes {
                                    if let Ok(parsed) = gpui::Keystroke::parse(&keystroke) {
                                        window.dispatch_keystroke(parsed, cx);
                                    }
                                }
                            });
                        }
                        let clicks = debug::take_clicks();
                        if !clicks.is_empty() {
                            let any: gpui::AnyWindowHandle = window.into();
                            let _ = any.update(cx, |_, window, cx| {
                                let scale = window.scale_factor().max(0.1);
                                for click in clicks {
                                    let position = gpui::point(
                                        px(click.x as f32 / scale),
                                        px(click.y as f32 / scale),
                                    );
                                    let button = if click.right {
                                        gpui::MouseButton::Right
                                    } else {
                                        gpui::MouseButton::Left
                                    };
                                    let modifiers = gpui::Modifiers {
                                        control: click.ctrl,
                                        alt: click.alt,
                                        shift: click.shift,
                                        platform: click.platform,
                                        function: false,
                                    };
                                    window.dispatch_event(
                                        gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {
                                            button,
                                            position,
                                            modifiers,
                                            click_count: 1,
                                            first_mouse: false,
                                        }),
                                        cx,
                                    );
                                    window.dispatch_event(
                                        gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
                                            button,
                                            position,
                                            modifiers,
                                            click_count: 1,
                                        }),
                                        cx,
                                    );
                                }
                            });
                        }
                        let pointers = debug::take_pointers();
                        if !pointers.is_empty() {
                            let any: gpui::AnyWindowHandle = window.into();
                            let _ = any.update(cx, |_, window, cx| {
                                let scale = window.scale_factor().max(0.1);
                                for pointer in pointers {
                                    let position = gpui::point(
                                        px(pointer.x as f32 / scale),
                                        px(pointer.y as f32 / scale),
                                    );
                                    let modifiers = gpui::Modifiers {
                                        control: pointer.ctrl,
                                        alt: pointer.alt,
                                        shift: pointer.shift,
                                        platform: pointer.platform,
                                        function: false,
                                    };
                                    let event = match pointer.action {
                                        debug::PointerAction::Down => {
                                            gpui::PlatformInput::MouseDown(gpui::MouseDownEvent {
                                                button: gpui::MouseButton::Left,
                                                position,
                                                modifiers,
                                                click_count: 1,
                                                first_mouse: false,
                                            })
                                        }
                                        debug::PointerAction::Move => {
                                            gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                                                position,
                                                pressed_button: None,
                                                modifiers,
                                            })
                                        }
                                        debug::PointerAction::Drag => {
                                            gpui::PlatformInput::MouseMove(gpui::MouseMoveEvent {
                                                position,
                                                pressed_button: Some(gpui::MouseButton::Left),
                                                modifiers,
                                            })
                                        }
                                        debug::PointerAction::Up => {
                                            gpui::PlatformInput::MouseUp(gpui::MouseUpEvent {
                                                button: gpui::MouseButton::Left,
                                                position,
                                                modifiers,
                                                click_count: 1,
                                            })
                                        }
                                    };
                                    window.dispatch_event(event, cx);
                                }
                            });
                        }
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
                        |_, cx| {
                            cx.new(|cx| {
                                DocumentHost::new(
                                    pdfs.clone(),
                                    handle.clone(),
                                    supervisor.clone(),
                                    cx,
                                )
                            })
                        },
                    )
                    .expect("mở cửa sổ thất bại");
                #[cfg(windows)]
                if let Some(server) = instance_server.take() {
                    dispatch_instance_requests(server, window, cx);
                }
                window
                    .update(cx, |host, window, cx| {
                        let entity = cx.entity();
                        window.on_window_should_close(cx, move |window, cx| {
                            entity
                                .update(cx, |host, cx| host.handle_window_close_request(window, cx))
                        });
                        host.focus_active(window, cx);
                    })
                    .expect("cập nhật cửa sổ thất bại");
            }
        });
    debug::run_shutdown_hook();
}
