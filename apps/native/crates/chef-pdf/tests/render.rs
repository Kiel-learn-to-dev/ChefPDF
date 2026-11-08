//! Kiểm thử luồng render với pdfium thật (TASKS_RUST R1.28–R1.30, R1.29 stress).
//! Cần pdfium.dll: đặt CHEF_PDFIUM_DIR là thư mục chứa DLL (mặc định apps/native/third_party/pdfium,
//! tải bằng scripts/fetch-pdfium.mjs).
//! Cần PDF: CHEF_TEST_PDF (mặc định %TEMP%/chef-perf/pages1000.pdf). Thiếu thì bỏ qua có thông báo.
use std::path::PathBuf;
use std::sync::mpsc::channel;

use chef_pdf::render::{self, Job, Reply};

fn dll_dir() -> PathBuf {
    std::env::var("CHEF_PDFIUM_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../third_party/pdfium")
        })
}

fn test_pdf() -> Option<PathBuf> {
    let p = std::env::var("CHEF_TEST_PDF")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("chef-perf").join("pages1000.pdf"));
    if p.exists() {
        Some(p)
    } else {
        eprintln!("bỏ qua: không có PDF kiểm thử tại {}", p.display());
        None
    }
}

fn handle() -> render::RenderHandle {
    render::spawn(dll_dir()).expect("nạp pdfium thất bại (xem CHEF_PDFIUM_DIR)")
}

fn open(h: &render::RenderHandle, path: PathBuf) -> u64 {
    let (tx, rx) = channel::<Reply<u64>>();
    let id = h.next_id();
    h.send(Job::Open {
        id,
        path,
        password: None,
        reply: tx,
    })
    .unwrap();
    let r = rx.recv().unwrap();
    assert_eq!(r.id, id, "id trả lời không khớp");
    r.result.expect("mở PDF thất bại")
}

#[test]
fn opens_counts_and_sizes_pages() {
    let Some(pdf) = test_pdf() else { return };
    let h = handle();
    let doc = open(&h, pdf);

    let (tx, rx) = channel();
    h.send(Job::PageCount {
        id: h.next_id(),
        doc,
        reply: tx,
    })
    .unwrap();
    assert_eq!(rx.recv().unwrap().result.unwrap(), 1000);

    let (tx, rx) = channel();
    h.send(Job::PageSize {
        id: h.next_id(),
        doc,
        index: 0,
        reply: tx,
    })
    .unwrap();
    let (w, hgt) = rx.recv().unwrap().result.unwrap();
    // A4 là 595,3 × 841,9 pt.
    assert!(
        (w - 595.3).abs() < 0.5 && (hgt - 841.9).abs() < 0.5,
        "khổ trang {w}×{hgt}"
    );
}

#[test]
fn renders_first_page_as_bgra_with_white_background() {
    let Some(pdf) = test_pdf() else { return };
    let h = handle();
    let doc = open(&h, pdf);

    let (tx, rx) = channel();
    h.send(Job::Render {
        id: h.next_id(),
        doc,
        index: 0,
        width: 600,
        height: 850,
        reply: tx,
    })
    .unwrap();
    let img = rx.recv().unwrap().result.expect("render thất bại");
    assert_eq!((img.width, img.height), (600, 850));
    assert_eq!(img.bgra.len(), 600 * 850 * 4);
    // Nền trang là trắng: góc trên trái phải là (255,255,255,255) trong BGRA.
    assert_eq!(&img.bgra[0..4], &[255, 255, 255, 255]);
    // Có chữ: phải có ít nhất một pixel không trắng.
    assert!(
        img.bgra
            .chunks_exact(4)
            .any(|p| p[0] < 128 || p[1] < 128 || p[2] < 128)
    );
}

/// Ghi BGRA trang 1 ra CHEF_RENDER_DUMP (nếu đặt) để so với pypdfium2 (R1.31). Không chạy khi không đặt.
#[test]
fn dumps_first_page_when_asked() {
    let Ok(out) = std::env::var("CHEF_RENDER_DUMP") else {
        return;
    };
    let w: u32 = std::env::var("CHEF_RENDER_W")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(600);
    let hgt: u32 = std::env::var("CHEF_RENDER_H")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(850);
    let Some(pdf) = test_pdf() else { return };
    let h = handle();
    let doc = open(&h, pdf);
    let (tx, rx) = channel();
    h.send(Job::Render {
        id: h.next_id(),
        doc,
        index: 0,
        width: w,
        height: hgt,
        reply: tx,
    })
    .unwrap();
    let img = rx.recv().unwrap().result.expect("render thất bại");
    std::fs::write(out, &img.bgra).expect("ghi file dump lỗi");
}

#[test]
fn thousand_requests_keep_unique_ids_and_matching_replies() {
    let Some(pdf) = test_pdf() else { return };
    let h = handle();
    let doc = open(&h, pdf);

    let mut pending = Vec::with_capacity(1000);
    for _ in 0..1000 {
        let id = h.next_id();
        let (tx, rx) = channel::<Reply<usize>>();
        h.send(Job::PageCount { id, doc, reply: tx }).unwrap();
        pending.push((id, rx));
    }
    let mut seen = std::collections::HashSet::new();
    for (id, rx) in pending {
        let r = rx.recv().unwrap();
        assert_eq!(r.id, id, "id trả lời không khớp");
        assert!(seen.insert(r.id), "trùng id {}", r.id);
        assert_eq!(r.result.unwrap(), 1000);
    }
    assert_eq!(seen.len(), 1000);
}

#[test]
fn missing_file_returns_an_error_not_a_panic() {
    let h = handle();
    let (tx, rx) = channel::<Reply<u64>>();
    h.send(Job::Open {
        id: h.next_id(),
        path: PathBuf::from("khong_ton_tai_chef.pdf"),
        password: None,
        reply: tx,
    })
    .unwrap();
    let r = rx.recv().unwrap();
    assert!(r.result.is_err());
}
