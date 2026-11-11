//! Luồng render: sở hữu Pdfium và mọi tài liệu đang mở (TASKS_RUST R1.29).
//!
//! UI gửi `Job` qua `RenderHandle`, mỗi job có `id` duy nhất và một kênh trả lời riêng.
//! Kết quả ảnh là BGRA từ trên xuống, đúng định dạng RenderImage của gpui (xem assets.rs).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::thread;

use pdfium_render::prelude::{PdfDocument, PdfRenderConfig, PdfiumError, PdfiumInternalError};

/// Mã lỗi khi file cần mật khẩu mà chưa có (R2.26). Viewer nhận mã này để hỏi mật khẩu.
pub const PASSWORD_REQUIRED: &str = "PASSWORD_REQUIRED";
/// Mã lỗi khi mật khẩu đã nhập không đúng (R2.26).
pub const PASSWORD_WRONG: &str = "PASSWORD_WRONG";

use crate::bind;
use crate::text::PageText;

/// Ảnh một trang, BGRA, từ trên xuống. `bgra.len() == width * height * 4`.
#[derive(Debug, Clone, PartialEq)]
pub struct PageImage {
    pub width: u32,
    pub height: u32,
    pub bgra: Vec<u8>,
}

/// Kết quả trả về kèm id của yêu cầu, để kiểm tra không bị lẫn.
#[derive(Debug)]
pub struct Reply<T> {
    pub id: u64,
    pub result: Result<T, String>,
}

pub type DocId = u64;

/// Yêu cầu gửi tới luồng render. Mỗi biến thể mang kênh trả lời riêng.
pub enum Job {
    Open {
        id: u64,
        path: PathBuf,
        password: Option<String>,
        reply: Sender<Reply<DocId>>,
    },
    PageCount {
        id: u64,
        doc: DocId,
        reply: Sender<Reply<usize>>,
    },
    /// Thuộc tính tài liệu (R2.27): phiên bản, số trang, khổ trang đầu, metadata.
    Properties {
        id: u64,
        doc: DocId,
        reply: Sender<Reply<crate::props::DocProps>>,
    },
    /// Kích thước trang tính bằng point (1/72 inch): (rộng, cao).
    PageSize {
        id: u64,
        doc: DocId,
        index: usize,
        reply: Sender<Reply<(f32, f32)>>,
    },
    Render {
        id: u64,
        doc: DocId,
        index: usize,
        width: u32,
        height: u32,
        reply: Sender<Reply<PageImage>>,
    },
    /// Chữ và hộp từng ký tự của một trang (R2.25a). Trang scan trả danh sách rỗng.
    PageText {
        id: u64,
        doc: DocId,
        index: usize,
        reply: Sender<Reply<PageText>>,
    },
    Close {
        id: u64,
        doc: DocId,
        reply: Sender<Reply<()>>,
    },
}

/// Phía UI giữ bản sao này. Gửi yêu cầu và nhận id tự tăng.
#[derive(Clone)]
pub struct RenderHandle {
    tx: Sender<Job>,
    next_id: Arc<AtomicU64>,
}

impl RenderHandle {
    /// Cấp id mới cho yêu cầu tiếp theo. Dùng khi tự gắn id vào job.
    pub fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    /// Gửi job cho luồng render. Lỗi nếu luồng đã dừng.
    pub fn send(&self, job: Job) -> Result<(), String> {
        self.tx
            .send(job)
            .map_err(|_| "luồng render đã dừng".to_string())
    }
}

/// Khởi động luồng render và chờ nó nạp pdfium xong. `dll_dir` là thư mục có pdfium.dll.
pub fn spawn(dll_dir: PathBuf) -> Result<RenderHandle, String> {
    let (tx, rx) = channel::<Job>();
    let (ready_tx, ready_rx) = channel::<Result<(), String>>();
    thread::Builder::new()
        .name("chef-pdfium".into())
        .spawn(move || run(dll_dir, rx, ready_tx))
        .map_err(|e| format!("không tạo được luồng render: {e}"))?;
    ready_rx
        .recv()
        .map_err(|_| "luồng render thoát khi khởi động".to_string())??;
    Ok(RenderHandle {
        tx,
        next_id: Arc::new(AtomicU64::new(1)),
    })
}

fn run(dll_dir: PathBuf, rx: Receiver<Job>, ready: Sender<Result<(), String>>) {
    let pdfium = match bind(&dll_dir) {
        Ok(p) => {
            let _ = ready.send(Ok(()));
            p
        }
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };
    let mut docs: HashMap<DocId, PdfDocument<'_>> = HashMap::new();
    let mut next_doc: DocId = 1;

    while let Ok(job) = rx.recv() {
        match job {
            Job::Open {
                id,
                path,
                password,
                reply,
            } => {
                let had_password = password.is_some();
                let result = pdfium
                    .load_pdf_from_file(&path, password.as_deref())
                    .map_err(|e| open_error(&path, &e, had_password))
                    .map(|doc| {
                        let key = next_doc;
                        next_doc += 1;
                        docs.insert(key, doc);
                        key
                    });
                let _ = reply.send(Reply { id, result });
            }
            Job::PageCount { id, doc, reply } => {
                let result = docs
                    .get(&doc)
                    .ok_or_else(|| format!("không có tài liệu {doc}"))
                    .map(|d| d.pages().len() as usize);
                let _ = reply.send(Reply { id, result });
            }
            Job::Properties { id, doc, reply } => {
                let result = docs
                    .get(&doc)
                    .ok_or_else(|| format!("không có tài liệu {doc}"))
                    .map(crate::props::read);
                let _ = reply.send(Reply { id, result });
            }
            Job::PageSize {
                id,
                doc,
                index,
                reply,
            } => {
                let result = docs
                    .get(&doc)
                    .ok_or_else(|| format!("không có tài liệu {doc}"))
                    .and_then(|d| d.pages().get(index as i32).map_err(|e| e.to_string()))
                    .map(|p| (p.width().value, p.height().value));
                let _ = reply.send(Reply { id, result });
            }
            Job::Render {
                id,
                doc,
                index,
                width,
                height,
                reply,
            } => {
                let result = render_page(&docs, doc, index, width, height);
                let _ = reply.send(Reply { id, result });
            }
            Job::PageText {
                id,
                doc,
                index,
                reply,
            } => {
                let result = docs
                    .get(&doc)
                    .ok_or_else(|| format!("không có tài liệu {doc}"))
                    .and_then(|d| d.pages().get(index as i32).map_err(|e| e.to_string()))
                    .and_then(|p| crate::text::read_page(&p));
                let _ = reply.send(Reply { id, result });
            }
            Job::Close { id, doc, reply } => {
                let result = if docs.remove(&doc).is_some() {
                    Ok(())
                } else {
                    Err(format!("không có tài liệu {doc}"))
                };
                let _ = reply.send(Reply { id, result });
            }
        }
    }
}

fn render_page(
    docs: &HashMap<DocId, PdfDocument<'_>>,
    doc: DocId,
    index: usize,
    width: u32,
    height: u32,
) -> Result<PageImage, String> {
    let d = docs
        .get(&doc)
        .ok_or_else(|| format!("không có tài liệu {doc}"))?;
    let page = d
        .pages()
        .get(index as i32)
        .map_err(|e| format!("trang {index}: {e}"))?;
    let config = PdfRenderConfig::new().set_target_size(width as i32, height as i32);
    let bitmap = page
        .render_with_config(&config)
        .map_err(|e| format!("render trang {index}: {e}"))?;
    let bgra = bitmap.as_raw_bytes();
    let expected = (width as usize) * (height as usize) * 4;
    if bgra.len() != expected {
        return Err(format!("kích thước bitmap {} khác {expected}", bgra.len()));
    }
    Ok(PageImage {
        width,
        height,
        bgra,
    })
}

/// Chuyển lỗi mở của pdfium thành thông báo. Lỗi mật khẩu thành mã riêng, không kèm mật khẩu.
fn open_error(path: &std::path::Path, e: &PdfiumError, had_password: bool) -> String {
    if matches!(
        e,
        PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::PasswordError)
    ) {
        return if had_password {
            PASSWORD_WRONG
        } else {
            PASSWORD_REQUIRED
        }
        .to_string();
    }
    format!("mở {} lỗi: {e}", path.display())
}
