//! Chụp nội dung một cửa sổ bằng Windows.Graphics.Capture (TASKS_RUST R1.08).
//!
//! Dùng cho kênh debug. Cách này đọc nội dung cửa sổ từ DWM, kể cả swap chain
//! DirectComposition mà PrintWindow không đọc được (GPUI Windows vẽ qua
//! CreateSwapChainForComposition). Không cần cửa sổ hiện trên màn hình.

use std::time::{Duration, Instant};

use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use windows::Graphics::DirectX::DirectXPixelFormat;
use windows::Win32::Foundation::{HMODULE, HWND};
use windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_HARDWARE;
use windows::Win32::Graphics::Direct3D11::{
    D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ,
    D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    D3D11CreateDevice, ID3D11Device, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::IDXGIDevice;
use windows::Win32::System::WinRT::Direct3D11::{
    CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
};
use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize};
use windows::core::{Interface, factory};

/// Ảnh BGRA từ trên xuống. `pixels` có độ dài width * height * 4.
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}

/// Chụp cửa sổ `hwnd` và chờ tối đa `timeout` để nhận một khung hình.
pub fn capture_window(hwnd: isize, timeout: Duration) -> Result<Frame, String> {
    // SAFETY: khởi tạo WinRT cho luồng gọi; trả S_FALSE nếu đã khởi tạo, không cần xử lý.
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    capture_inner(hwnd, timeout).map_err(|e| format!("WGC: {e}"))
}

fn capture_inner(hwnd: isize, timeout: Duration) -> windows::core::Result<Frame> {
    let mut device: Option<ID3D11Device> = None;
    // SAFETY: thiết bị phần cứng với hỗ trợ BGRA, bắt buộc để WGC dùng được.
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE(0),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            None,
        )?;
    }
    let device = device.ok_or_else(windows::core::Error::from_win32)?;
    let dxgi: IDXGIDevice = device.cast()?;
    // SAFETY: dxgi là thiết bị DXGI hợp lệ vừa tạo.
    let inspectable = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)? };
    let winrt_device: IDirect3DDevice = inspectable.cast()?;

    let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    // SAFETY: hwnd là cửa sổ GPUI đang sống trong tiến trình này.
    let item: GraphicsCaptureItem = unsafe { interop.CreateForWindow(HWND(hwnd))? };
    let size = item.Size()?;

    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &winrt_device,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        2,
        size,
    )?;
    let session = pool.CreateCaptureSession(&item)?;
    // Bỏ viền vàng của WGC và con trỏ chuột khi có thể (Windows 11). Lỗi ở đây không cản việc chụp.
    let _ = session.SetIsBorderRequired(false);
    let _ = session.SetIsCursorCaptureEnabled(false);
    session.StartCapture()?;

    let started = Instant::now();
    let frame = loop {
        if let Ok(frame) = pool.TryGetNextFrame() {
            break frame;
        }
        if started.elapsed() > timeout {
            session.Close()?;
            pool.Close()?;
            return Err(windows::core::Error::new(
                windows::core::HRESULT(0x80004004u32 as i32), // E_ABORT: hết thời gian chờ khung hình
                "không nhận được khung hình trong thời gian chờ",
            ));
        }
        std::thread::sleep(Duration::from_millis(15));
    };

    let surface = frame.Surface()?;
    let access: IDirect3DDxgiInterfaceAccess = surface.cast()?;
    // SAFETY: surface thuộc thiết bị WGC vừa tạo, lấy texture gốc của nó.
    let texture: ID3D11Texture2D = unsafe { access.GetInterface()? };

    let mut desc = D3D11_TEXTURE2D_DESC::default();
    // SAFETY: desc là struct đích hợp lệ.
    unsafe { texture.GetDesc(&mut desc) };
    let (width, height) = (desc.Width, desc.Height);

    let staging_desc = D3D11_TEXTURE2D_DESC {
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0,
        ..desc
    };
    let mut staging: Option<ID3D11Texture2D> = None;
    // SAFETY: texture staging đọc được từ CPU, cùng kích thước và định dạng với texture nguồn.
    unsafe { device.CreateTexture2D(&staging_desc, None, Some(&mut staging))? };
    let staging = staging.ok_or_else(windows::core::Error::from_win32)?;

    // SAFETY: lấy context tức thời của thiết bị vừa tạo.
    let context = unsafe { device.GetImmediateContext()? };

    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    // SAFETY: sao chép GPU sang staging rồi map để đọc; unmap ngay sau khi chép hàng.
    let pixels = unsafe {
        context.CopyResource(&staging, &texture);
        context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
        let row_bytes = (width * 4) as usize;
        let mut out = vec![0u8; row_bytes * height as usize];
        for y in 0..height as usize {
            let src = (mapped.pData as *const u8).add(y * mapped.RowPitch as usize);
            std::ptr::copy_nonoverlapping(src, out.as_mut_ptr().add(y * row_bytes), row_bytes);
        }
        context.Unmap(&staging, 0);
        out
    };

    frame.Close()?;
    session.Close()?;
    pool.Close()?;
    Ok(Frame {
        width,
        height,
        pixels,
    })
}
