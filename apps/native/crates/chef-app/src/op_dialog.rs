//! Hộp thoại xử lý sinh từ schema cho các operation của lõi (TASKS_RUST R5.11 đến R5.59; nhóm "S" và
//! "S+" của `docs/DIALOG_CLASSIFICATION_RUST.md`). Mỗi operation là một dòng trong [`OPS`]: mã
//! operation, tên `Params` trong `ops.schema.json`, khóa chữ, cách chạy, và các trường đường dẫn cần
//! nút "Chọn…". Form do `SchemaForm` vẽ; thêm một operation mới không cần viết giao diện (R5.02 tiêu chí 3).
//!
//! Ba cách chạy ([`OpMode`]):
//! - `Revision`: thao tác đổi tài liệu; hộp thoại phát `ApplyRevision`, viewer chạy qua `begin_edit`
//!   nên có hoàn tác và đối soát revision.
//! - `Output`: thao tác đọc hoặc xuất file trên phiên của tài liệu; hộp thoại tự chạy và hiện file ra.
//! - `Standalone`: thao tác không cần tài liệu đang mở (ví dụ chuyển ảnh sang PDF, sửa file hỏng).
//!
//! Trường lồng nhau mà `SchemaForm` chưa sinh được (ví dụ `margins`, `header`) bị bỏ qua khi tùy chọn,
//! nên lõi dùng giá trị mặc định; thao tác có trường bắt buộc kiểu đó không có trong bảng (cần hộp
//! thoại viết tay, xem ghi chú ở từng task).

use std::collections::BTreeMap;
use std::path::PathBuf;

use chef_ui::button::{Button, Size};
use chef_ui::dialog::Width;
use chef_ui::i18n::{t, t_with};
use chef_ui::schema_form::{FormSchema, SchemaForm, SchemaFormEvent};
use chef_ui::task_dialog::{TaskDialog, TaskResult, display_basename};
use gpui::{
    AppContext as _, Context, Entity, EventEmitter, FocusHandle, IntoElement, Render, Subscription,
    Window, div, prelude::*, px, rgba,
};
use serde_json::Value;

use crate::page_range::format_page_ranges;
use crate::process::{
    Colors, JobFail, JobOk, ProcessContext, ProcessEvent, ProcessView, Runner, Target, file_stem,
    parent_dir, spawn_jobs, wire,
};

// ---------------------------------------------------------------------------
// Bảng đặc tả
// ---------------------------------------------------------------------------

/// Cách chạy một operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OpMode {
    Revision,
    Output,
    Standalone,
}

/// Cách chọn đường dẫn cho một trường.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathKind {
    /// File PDF đầu vào; mặc định là file gốc của tab.
    OpenPdf,
    /// Một file ảnh đầu vào.
    OpenImage,
    /// Danh sách ảnh (mỗi lần bấm thêm một ảnh).
    OpenImages,
    /// Danh sách PDF (mỗi lần bấm thêm các file chọn).
    OpenPdfs,
    /// File PDF đầu ra; hậu tố đặt trước đuôi, ví dụ "-nen".
    SavePdf(&'static str),
    /// File đầu ra khác PDF: hậu tố và đuôi.
    SaveFile(&'static str, &'static str),
    /// Thư mục đầu ra.
    Folder,
}

/// Một trường đường dẫn của `Params`.
#[derive(Clone, Copy, Debug)]
pub struct PathField {
    pub name: &'static str,
    pub kind: PathKind,
}

/// Một operation có hộp thoại sinh từ schema.
#[derive(Clone, Copy, Debug)]
pub struct OpSpec {
    /// Mã lệnh trong bảng lệnh, ví dụ "compress.pdf".
    pub id: &'static str,
    pub op_id: &'static str,
    /// Tên `Params` trong `ops.schema.json`.
    pub def: &'static str,
    pub mode: OpMode,
    pub icon: &'static str,
    /// Khóa nhóm của bảng lệnh: "file", "pages" hoặc "tools".
    pub group: &'static str,
    pub keywords: &'static [&'static str],
    /// Trường nhận trang đang chọn (chỉ số từ 0), nếu có.
    pub pages_field: Option<&'static str>,
    pub paths: &'static [PathField],
}

impl OpSpec {
    fn slug(&self) -> String {
        self.id.replace('.', "_")
    }

    pub fn title_key(&self) -> String {
        format!("opDialog.{}.title", self.slug())
    }

    pub fn description_key(&self) -> String {
        format!("opDialog.{}.description", self.slug())
    }

    pub fn run_key(&self) -> String {
        format!("opDialog.{}.run", self.slug())
    }

    /// Thao tác sửa tài liệu bị chặn khi file đã ký số.
    pub fn edits_document(&self) -> bool {
        self.mode == OpMode::Revision
    }

    /// Cần tài liệu đang mở (phiên) để chạy.
    pub fn needs_document(&self) -> bool {
        self.mode != OpMode::Standalone
    }
}

#[allow(clippy::too_many_arguments)]
const fn spec(
    id: &'static str,
    op_id: &'static str,
    def: &'static str,
    mode: OpMode,
    icon: &'static str,
    group: &'static str,
    keywords: &'static [&'static str],
    pages_field: Option<&'static str>,
    paths: &'static [PathField],
) -> OpSpec {
    OpSpec {
        id,
        op_id,
        def,
        mode,
        icon,
        group,
        keywords,
        pages_field,
        paths,
    }
}

const fn path(name: &'static str, kind: PathKind) -> PathField {
    PathField { name, kind }
}

use OpMode::{Output, Revision, Standalone};
use PathKind::{Folder, OpenImage, OpenImages, OpenPdf, SaveFile, SavePdf};

/// Mọi hộp thoại sinh từ schema. Thứ tự không quan trọng; chỉ số trong bảng là mã nội bộ của lệnh.
pub static OPS: &[OpSpec] = &[
    // M5b: tối ưu, chuyển đổi, bản scan
    spec(
        "compress.pdf",
        "compress.pdf",
        "CompressPdfParams",
        Revision,
        "icons/shrink.svg",
        "file",
        &["compress", "nen pdf", "giam dung luong"],
        None,
        &[],
    ),
    spec(
        "compress.file",
        "compress.file",
        "CompressFileParams",
        Standalone,
        "icons/shrink.svg",
        "file",
        &["compress copy", "nen thanh file moi"],
        None,
        &[
            path("inputPath", OpenPdf),
            path("outputPath", SavePdf("-nen")),
        ],
    ),
    spec(
        "convert.pdfToImages",
        "convert.pdfToImages",
        "ConvertPdfToImagesParams",
        Standalone,
        "icons/images.svg",
        "file",
        &["pdf to image", "pdf sang anh", "xuat anh"],
        Some("pages"),
        &[path("path", OpenPdf), path("outputDir", Folder)],
    ),
    spec(
        "convert.imagesToPdf",
        "convert.imagesToPdf",
        "ConvertImagesToPdfParams",
        Standalone,
        "icons/file-image.svg",
        "file",
        &["image to pdf", "anh sang pdf"],
        None,
        &[
            path("images", OpenImages),
            path("outputPath", SavePdf("-anh")),
        ],
    ),
    spec(
        "color.convert",
        "color.convert",
        "ColorConvertParams",
        Revision,
        "icons/palette.svg",
        "tools",
        &["color", "chuyen mau", "thang xam", "den trang"],
        Some("pages"),
        &[],
    ),
    spec(
        "doc.extractImages",
        "doc.extractImages",
        "DocExtractImagesParams",
        Output,
        "icons/image.svg",
        "file",
        &["extract images", "trich xuat anh"],
        Some("pages"),
        &[path("outputDir", Folder)],
    ),
    spec(
        "doc.extractText",
        "doc.extractText",
        "DocExtractTextParams",
        Output,
        "icons/file-text.svg",
        "file",
        &["extract text", "trich xuat van ban"],
        None,
        &[path("outputPath", SaveFile("", "txt"))],
    ),
    spec(
        "doc.attachments.add",
        "doc.attachments.add",
        "DocAttachmentsAddParams",
        Revision,
        "icons/paperclip.svg",
        "tools",
        &["attach file", "dinh kem", "them file dinh kem"],
        None,
        &[path("paths", PathKind::OpenPdfs)],
    ),
    spec(
        "doc.attachments.extract",
        "doc.attachments.extract",
        "DocAttachmentsExtractParams",
        Output,
        "icons/paperclip.svg",
        "tools",
        &["extract attachments", "luu file dinh kem"],
        None,
        &[path("outputDir", Folder)],
    ),
    spec(
        "doc.setMetadata",
        "doc.setMetadata",
        "DocSetMetadataParams",
        Revision,
        "icons/pen-line.svg",
        "tools",
        &["metadata", "thuoc tinh", "tieu de tac gia"],
        None,
        &[],
    ),
    spec(
        "doc.optimizeWeb",
        "doc.optimizeWeb",
        "DocOptimizeWebParams",
        Standalone,
        "icons/globe.svg",
        "file",
        &["linearize", "fast web view", "toi uu cho web"],
        None,
        &[
            path("inputPath", OpenPdf),
            path("outputPath", SavePdf("-web")),
        ],
    ),
    spec(
        "doc.repair",
        "doc.repair",
        "DocRepairParams",
        Standalone,
        "icons/wrench.svg",
        "file",
        &["repair", "sua file hong", "khoi phuc pdf"],
        None,
        &[
            path("inputPath", OpenPdf),
            path("outputPath", SavePdf("-da-sua")),
        ],
    ),
    spec(
        "scan.rasterize",
        "scan.rasterize",
        "ScanRasterizeParams",
        Revision,
        "icons/scan-line.svg",
        "tools",
        &["scan", "ban scan", "chuyen thanh anh"],
        Some("pages"),
        &[],
    ),
    // M5c: đóng dấu, đánh số, watermark
    spec(
        "overlay.watermark",
        "overlay.watermark",
        "OverlayWatermarkParams",
        Revision,
        "icons/droplets.svg",
        "tools",
        &["watermark", "chu chim", "hinh mo"],
        Some("pages"),
        &[path("path", OpenImage)],
    ),
    spec(
        "stamp.text",
        "stamp.text",
        "StampTextParams",
        Revision,
        "icons/stamp.svg",
        "tools",
        &["stamp", "con dau chu", "dong dau"],
        Some("pages"),
        &[],
    ),
    spec(
        "stamp.image",
        "stamp.image",
        "StampImageParams",
        Revision,
        "icons/stamp.svg",
        "tools",
        &["image stamp", "con dau anh", "dong dau hinh"],
        Some("pages"),
        &[path("path", OpenImage)],
    ),
    spec(
        "stamp.seam",
        "stamp.seam",
        "StampSeamParams",
        Revision,
        "icons/stamp.svg",
        "tools",
        &["seam stamp", "dau giap lai"],
        Some("pages"),
        &[path("path", OpenImage)],
    ),
    spec(
        "overlay.pageNumbers",
        "overlay.pageNumbers",
        "OverlayPageNumbersParams",
        Revision,
        "icons/hash.svg",
        "pages",
        &["page numbers", "danh so trang", "nghi dinh 30"],
        Some("pages"),
        &[],
    ),
    spec(
        "overlay.qrCode",
        "overlay.qrCode",
        "OverlayQrCodeParams",
        Revision,
        "icons/qr-code.svg",
        "tools",
        &["qr code", "ma qr"],
        Some("pages"),
        &[],
    ),
    spec(
        "overlay.barcode",
        "overlay.barcode",
        "OverlayBarcodeParams",
        Revision,
        "icons/qr-code.svg",
        "tools",
        &["barcode", "ma vach"],
        Some("pages"),
        &[],
    ),
    spec(
        "overlay.letterhead",
        "overlay.letterhead",
        "OverlayLetterheadParams",
        Revision,
        "icons/file-stack.svg",
        "tools",
        &["letterhead", "giay tieu de", "chong len"],
        Some("pages"),
        &[path("sourcePath", OpenPdf)],
    ),
    spec(
        "overlay.remove",
        "overlay.remove",
        "OverlayRemoveParams",
        Revision,
        "icons/eraser.svg",
        "tools",
        &["remove overlay", "go dau da them"],
        None,
        &[],
    ),
    spec(
        "watermark.remove",
        "watermark.remove",
        "WatermarkRemoveParams",
        Revision,
        "icons/eraser.svg",
        "tools",
        &["remove watermark", "go watermark"],
        Some("pages"),
        &[],
    ),
    spec(
        "background.remove",
        "background.remove",
        "BackgroundRemoveParams",
        Revision,
        "icons/paint-bucket.svg",
        "tools",
        &["background", "go nen trang", "doi nen"],
        Some("pages"),
        &[],
    ),
    // M5d: bảo mật
    spec(
        "security.encrypt",
        "security.encrypt",
        "SecurityEncryptParams",
        Revision,
        "icons/lock.svg",
        "tools",
        &["password", "encrypt", "dat mat khau"],
        None,
        &[],
    ),
    spec(
        "security.decrypt",
        "security.decrypt",
        "SecurityDecryptParams",
        Revision,
        "icons/lock.svg",
        "tools",
        &["remove password", "go mat khau"],
        None,
        &[],
    ),
    // M5e: tài liệu
    spec(
        "export.document",
        "export.document",
        "ExportDocumentParams",
        Output,
        "icons/file-output.svg",
        "file",
        &["export", "xuat word", "xuat excel", "xuat dinh dang"],
        Some("pages"),
        &[path("outputPath", SaveFile("", "docx"))],
    ),
    spec(
        "toc.insertPage",
        "toc.insertPage",
        "TocInsertPageParams",
        Revision,
        "icons/list-ordered.svg",
        "pages",
        &["table of contents", "tao muc luc", "chen muc luc"],
        None,
        &[],
    ),
    spec(
        "bookmarks.fromPages",
        "bookmarks.fromPages",
        "BookmarksFromPagesParams",
        Revision,
        "icons/list-tree.svg",
        "pages",
        &["bookmarks from pages", "tao bookmark tu trang"],
        Some("pages"),
        &[],
    ),
    // Thao tác chỉ đọc: hiện kết quả dạng dòng khóa-giá trị.
    spec(
        "preflight.check",
        "preflight.check",
        "PreflightCheckParams",
        Output,
        "icons/shield-check.svg",
        "tools",
        &["preflight", "kiem tra truoc khi gui"],
        None,
        &[],
    ),
    spec(
        "inspect.hiddenData",
        "inspect.hiddenData",
        "InspectHiddenDataParams",
        Output,
        "icons/scan-search.svg",
        "tools",
        &["inspect", "soi file", "du lieu an"],
        None,
        &[],
    ),
    spec(
        "watermark.detect",
        "watermark.detect",
        "WatermarkDetectParams",
        Output,
        "icons/scan-search.svg",
        "tools",
        &["detect watermark", "do watermark"],
        None,
        &[],
    ),
    spec(
        "toc.preview",
        "toc.preview",
        "TocPreviewParams",
        Output,
        "icons/list-tree.svg",
        "pages",
        &["contents preview", "do tieu de", "xem truoc muc luc"],
        None,
        &[],
    ),
    spec(
        "compress.estimate",
        "compress.estimate",
        "CompressEstimateParams",
        Output,
        "icons/shrink.svg",
        "file",
        &["estimate compression", "uoc tinh nen"],
        None,
        &[],
    ),
    spec(
        "forms.detectFields",
        "forms.detectFields",
        "FormsDetectFieldsParams",
        Output,
        "icons/scan-search.svg",
        "tools",
        &["detect form fields", "do o bieu mau"],
        Some("pages"),
        &[],
    ),
    spec(
        "sign.verify",
        "sign.verify",
        "SignVerifyParams",
        Output,
        "icons/shield-check.svg",
        "tools",
        &["verify signature", "kiem tra chu ky"],
        None,
        &[],
    ),
    // M5 còn lại và M7: sửa trang, thay chữ
    spec(
        "links.autoDetect",
        "links.autoDetect",
        "LinksAutoDetectParams",
        Revision,
        "icons/link-2.svg",
        "tools",
        &["detect links", "tu tim lien ket"],
        Some("pages"),
        &[],
    ),
    spec(
        "text.findReplace",
        "text.findReplace",
        "TextFindReplaceParams",
        Revision,
        "icons/replace.svg",
        "tools",
        &["find replace", "tim va thay the", "thay chu"],
        Some("pages"),
        &[],
    ),
    // M8: xử lý ảnh trang
    spec(
        "pageimg.autoCrop",
        "pageimg.autoCrop",
        "PageimgAutoCropParams",
        Revision,
        "icons/crop.svg",
        "tools",
        &["auto crop", "tu do vien", "cat anh scan"],
        Some("pages"),
        &[],
    ),
    spec(
        "pageimg.deskew",
        "pageimg.deskew",
        "PageimgDeskewParams",
        Revision,
        "icons/rotate-cw.svg",
        "tools",
        &["deskew", "chinh nghieng"],
        Some("pages"),
        &[],
    ),
    spec(
        "pageimg.dewarp",
        "pageimg.dewarp",
        "PageimgDewarpParams",
        Revision,
        "icons/stretch-vertical.svg",
        "tools",
        &["dewarp", "lam phang trang cong"],
        Some("pages"),
        &[],
    ),
    spec(
        "pageimg.enhance",
        "pageimg.enhance",
        "PageimgEnhanceParams",
        Revision,
        "icons/sparkles.svg",
        "tools",
        &["enhance", "lam dep anh trang", "khu nhieu"],
        Some("pages"),
        &[],
    ),
    spec(
        "pageimg.splitSpread",
        "pageimg.splitSpread",
        "PageimgSplitSpreadParams",
        Revision,
        "icons/columns-2.svg",
        "tools",
        &["split spread", "tach trang doi"],
        Some("pages"),
        &[],
    ),
    spec(
        "pageimg.removeFingers",
        "pageimg.removeFingers",
        "PageimgRemoveFingersParams",
        Revision,
        "icons/hand.svg",
        "tools",
        &["remove fingers", "xoa ngon tay"],
        Some("pages"),
        &[],
    ),
    spec(
        "pageimg.removeStains",
        "pageimg.removeStains",
        "PageimgRemoveStainsParams",
        Revision,
        "icons/droplets.svg",
        "tools",
        &["remove stains", "xoa vet ban"],
        Some("pages"),
        &[],
    ),
    // M6, M8: chữ ký, ảnh chữ ký, thư mục theo dõi (không cần tài liệu đang mở)
    spec(
        "image.cleanup",
        "image.cleanup",
        "ImageCleanupParams",
        Standalone,
        "icons/sparkles.svg",
        "tools",
        &["clean signature", "lam sach chu ky"],
        None,
        &[
            path("inputPath", OpenImage),
            path("outputPath", SaveFile("-sach", "png")),
        ],
    ),
    spec(
        "image.removeBackground",
        "image.removeBackground",
        "ImageRemoveBackgroundParams",
        Standalone,
        "icons/paint-bucket.svg",
        "tools",
        &["remove image background", "xoa nen anh"],
        None,
        &[
            path("inputPath", OpenImage),
            path("outputPath", SaveFile("-nen-trong", "png")),
        ],
    ),
    spec(
        "image.textSignature",
        "image.textSignature",
        "ImageTextSignatureParams",
        Standalone,
        "icons/pen-line.svg",
        "tools",
        &["text signature", "tao chu ky tu chu"],
        None,
        &[path("outputPath", SaveFile("-chu-ky", "png"))],
    ),
    spec(
        "sign.verifyFile",
        "sign.verifyFile",
        "SignVerifyFileParams",
        Standalone,
        "icons/shield-check.svg",
        "tools",
        &["verify file signature", "kiem tra chu ky file"],
        None,
        &[path("path", OpenPdf)],
    ),
    spec(
        "sign.certInfo",
        "sign.certInfo",
        "SignCertInfoParams",
        Standalone,
        "icons/key-round.svg",
        "tools",
        &["certificate info", "xem chung thu", "pfx"],
        None,
        &[],
    ),
    spec(
        "sign.trustList",
        "sign.trustList",
        "SignTrustListParams",
        Standalone,
        "icons/landmark.svg",
        "tools",
        &["trusted roots", "chung thu goc tin cay"],
        None,
        &[],
    ),
    spec(
        "sign.trustAdd",
        "sign.trustAdd",
        "SignTrustAddParams",
        Standalone,
        "icons/landmark.svg",
        "tools",
        &["add trusted root", "them chung thu goc"],
        None,
        &[],
    ),
    spec(
        "sign.trustRemove",
        "sign.trustRemove",
        "SignTrustRemoveParams",
        Standalone,
        "icons/landmark.svg",
        "tools",
        &["remove trusted root", "go chung thu goc"],
        None,
        &[],
    ),
    spec(
        "sign.driverScan",
        "sign.driverScan",
        "SignDriverScanParams",
        Standalone,
        "icons/usb.svg",
        "tools",
        &["scan token drivers", "quet driver token"],
        None,
        &[],
    ),
    spec(
        "sign.diagnoseToken",
        "sign.diagnoseToken",
        "SignDiagnoseTokenParams",
        Standalone,
        "icons/stethoscope.svg",
        "tools",
        &["diagnose token", "chan doan token"],
        None,
        &[],
    ),
    spec(
        "sign.listStoreCertificates",
        "sign.listStoreCertificates",
        "SignListStoreCertificatesParams",
        Standalone,
        "icons/key-round.svg",
        "tools",
        &["windows certificates", "chung thu trong windows"],
        None,
        &[],
    ),
    spec(
        "sign.listTokens",
        "sign.listTokens",
        "SignListTokensParams",
        Standalone,
        "icons/usb.svg",
        "tools",
        &["list tokens", "liet ke token"],
        None,
        &[],
    ),
    spec(
        "sign.extractRevision",
        "sign.extractRevision",
        "SignExtractRevisionParams",
        Standalone,
        "icons/history.svg",
        "tools",
        &["extract revision", "lay ban truoc khi ky"],
        None,
        &[
            path("path", OpenPdf),
            path("outputPath", SavePdf("-truoc-ky")),
        ],
    ),
    spec(
        "sign.verifyBatch",
        "sign.verifyBatch",
        "SignVerifyBatchParams",
        Standalone,
        "icons/shield-check.svg",
        "tools",
        &["verify batch", "kiem tra chu ky hang loat"],
        None,
        &[path("folder", Folder)],
    ),
    spec(
        "watch.scan",
        "watch.scan",
        "WatchScanParams",
        Standalone,
        "icons/folder-search.svg",
        "tools",
        &["watch folder", "thu muc theo doi"],
        None,
        &[path("directory", Folder), path("outputDirectory", Folder)],
    ),
    // Trường lồng nhau nhập dạng JSON (xem `json_fields`) và thao tác gọn.
    spec(
        "overlay.headerFooter",
        "overlay.headerFooter",
        "OverlayHeaderFooterParams",
        Revision,
        "icons/panel-top.svg",
        "pages",
        &["header footer", "dau trang chan trang"],
        Some("pages"),
        &[],
    ),
    spec(
        "overlay.bates",
        "overlay.bates",
        "OverlayBatesParams",
        Standalone,
        "icons/hash.svg",
        "file",
        &["bates", "danh so bates"],
        None,
        &[path("files", PathKind::OpenPdfs)],
    ),
    spec(
        "redact.find",
        "redact.find",
        "RedactFindParams",
        Output,
        "icons/eye-off.svg",
        "tools",
        &["find sensitive", "tim thong tin mat"],
        Some("pages"),
        &[],
    ),
    spec(
        "redact.apply",
        "redact.apply",
        "RedactApplyParams",
        Revision,
        "icons/eye-off.svg",
        "tools",
        &["redact", "che thong tin mat"],
        None,
        &[],
    ),
    spec(
        "inspect.removeHidden",
        "inspect.removeHidden",
        "InspectRemoveHiddenParams",
        Revision,
        "icons/eraser.svg",
        "tools",
        &["remove hidden data", "go du lieu an", "scrub"],
        None,
        &[],
    ),
    spec(
        "workflow.validate",
        "workflow.validate",
        "WorkflowValidateParams",
        Standalone,
        "icons/workflow.svg",
        "tools",
        &["validate workflow", "kiem tra quy trinh"],
        None,
        &[],
    ),
    spec(
        "workflow.run",
        "workflow.run",
        "WorkflowRunParams",
        Standalone,
        "icons/workflow.svg",
        "tools",
        &["run workflow", "chay quy trinh"],
        None,
        &[path("files", PathKind::OpenPdfs)],
    ),
    spec(
        "batch.run",
        "batch.run",
        "BatchRunParams",
        Standalone,
        "icons/zap.svg",
        "tools",
        &["batch", "chay hang loat"],
        None,
        &[path("files", PathKind::OpenPdfs)],
    ),
    spec(
        "export.batch",
        "export.batch",
        "ExportBatchParams",
        Standalone,
        "icons/file-output.svg",
        "file",
        &["export batch", "xuat hang loat"],
        None,
        &[path("files", PathKind::OpenPdfs)],
    ),
    spec(
        "naming.preview",
        "naming.preview",
        "NamingPreviewParams",
        Standalone,
        "icons/file-pen-line.svg",
        "file",
        &["naming preview", "xem truoc ten file"],
        None,
        &[path("files", PathKind::OpenPdfs)],
    ),
    spec(
        "naming.apply",
        "naming.apply",
        "NamingApplyParams",
        Standalone,
        "icons/file-pen-line.svg",
        "file",
        &["rename files", "doi ten file hang loat"],
        None,
        &[path("files", PathKind::OpenPdfs)],
    ),
    spec(
        "layout.analyze",
        "layout.analyze",
        "LayoutAnalyzeParams",
        Output,
        "icons/layout-grid.svg",
        "file",
        &["analyze layout", "ra tai lieu", "phan tich bo cuc"],
        Some("pages"),
        &[],
    ),
    spec(
        "annots.flatten",
        "annots.flatten",
        "AnnotsFlattenParams",
        Revision,
        "icons/layers.svg",
        "tools",
        &["flatten annotations", "lam phang ghi chu"],
        Some("pages"),
        &[],
    ),
    spec(
        "annots.removeAll",
        "annots.removeAll",
        "AnnotsRemoveAllParams",
        Revision,
        "icons/trash-2.svg",
        "tools",
        &["remove all annotations", "xoa het ghi chu"],
        None,
        &[],
    ),
    spec(
        "layers.flatten",
        "layers.flatten",
        "LayersFlattenParams",
        Revision,
        "icons/layers-3.svg",
        "tools",
        &["flatten layers", "gop lop"],
        None,
        &[],
    ),
    spec(
        "bookmarks.clear",
        "bookmarks.clear",
        "BookmarksClearParams",
        Revision,
        "icons/trash-2.svg",
        "pages",
        &["clear bookmarks", "xoa bookmark"],
        None,
        &[],
    ),
];

impl OpSpec {
    /// Trường lồng nhau nhập dạng JSON (ngoài các trường bắt buộc, tự thành ô JSON).
    pub fn json_fields(&self) -> &'static [&'static str] {
        match self.id {
            "overlay.headerFooter" => &["header", "footer", "margins"],
            "overlay.pageNumbers" => &["margins"],
            "overlay.bates" => &["output", "margins"],
            "redact.apply" => &["patterns", "matchIds", "rects"],
            "scan.rasterize" => &["effects"],
            "export.document" => &["options"],
            "export.batch" => &["options", "output"],
            "workflow.run" => &["output", "variables"],
            "batch.run" => &["params", "output"],
            "doc.setMetadata" => &["custom"],
            "doc.attachments.extract" => &["names"],
            _ => &[],
        }
    }
}

// ---------------------------------------------------------------------------
// Phần thuần
// ---------------------------------------------------------------------------

/// Đường dẫn ra mặc định: cùng thư mục với file gốc, tên file gốc cộng hậu tố và đuôi.
pub fn default_output(source: Option<&str>, suffix: &str, ext: &str) -> String {
    let Some(source) = source else {
        return String::new();
    };
    let dir = parent_dir(source);
    let name = format!("{}{suffix}.{ext}", file_stem(source));
    crate::process::join_path(&dir, &name)
}

/// Giá trị mặc định cho một trường đường dẫn, từ ngữ cảnh viewer.
pub fn default_path(kind: PathKind, ctx: &ProcessContext) -> Option<String> {
    let source = ctx.source.as_ref().map(|p| p.display().to_string());
    match kind {
        PathKind::OpenPdf => source,
        PathKind::SavePdf(suffix) => {
            let value = default_output(source.as_deref(), suffix, "pdf");
            (!value.is_empty()).then_some(value)
        }
        PathKind::SaveFile(suffix, ext) => {
            let value = default_output(source.as_deref(), suffix, ext);
            (!value.is_empty()).then_some(value)
        }
        PathKind::Folder => {
            let dir =
                crate::split::default_output_dir(ctx.initial_dir.as_deref(), ctx.source.as_deref());
            (!dir.is_empty()).then_some(dir)
        }
        PathKind::OpenImage | PathKind::OpenImages | PathKind::OpenPdfs => None,
    }
}

/// Số dòng tối đa của kết quả dạng dữ liệu hiện trong hộp thoại.
const MAX_DATA_LINES: usize = 60;

/// Dữ liệu kết quả của lõi (`data`) thành các dòng "khóa: giá trị" để hiện cho thao tác chỉ đọc (soi file,
/// kiểm tra trước khi gửi, kiểm tra chữ ký…). Đối tượng lồng nối khóa bằng dấu chấm; mảng ngắn các giá
/// trị đơn giản gộp một dòng; `null` bị bỏ qua.
pub fn data_lines(data: &Value) -> Vec<String> {
    let mut out = Vec::new();
    flatten_data("", data, &mut out);
    out.truncate(MAX_DATA_LINES);
    out
}

fn scalar_text(value: &Value) -> Option<String> {
    match value {
        Value::Null | Value::Array(_) | Value::Object(_) => None,
        Value::String(s) => Some(s.clone()),
        other => Some(other.to_string()),
    }
}

fn flatten_data(prefix: &str, value: &Value, out: &mut Vec<String>) {
    if out.len() >= MAX_DATA_LINES {
        return;
    }
    let join = |key: &str| {
        if prefix.is_empty() {
            key.to_string()
        } else {
            format!("{prefix}.{key}")
        }
    };
    match value {
        Value::Null => {}
        Value::Object(map) => {
            for (key, item) in map {
                flatten_data(&join(key), item, out);
            }
        }
        Value::Array(items) => {
            let simple: Option<Vec<String>> = items.iter().map(scalar_text).collect();
            match simple {
                Some(texts) if texts.len() <= 8 && !prefix.is_empty() => {
                    out.push(format!("{prefix}: {}", texts.join(", ")));
                }
                _ => {
                    for (index, item) in items.iter().enumerate() {
                        flatten_data(&format!("{prefix}[{}]", index + 1), item, out);
                    }
                }
            }
        }
        scalar => {
            if let Some(text) = scalar_text(scalar) {
                out.push(if prefix.is_empty() {
                    text
                } else {
                    format!("{prefix}: {text}")
                });
            }
        }
    }
}

/// Trang đang chọn thành chuỗi nhập ("2-3, 5"); `None` khi chọn cả tài liệu hoặc không chọn gì.
pub fn selected_pages_text(target_pages: &[usize], page_count: usize) -> Option<String> {
    (!target_pages.is_empty() && target_pages.len() < page_count)
        .then(|| format_page_ranges(target_pages))
}

// ---------------------------------------------------------------------------
// Giao diện
// ---------------------------------------------------------------------------

pub struct OpDialog {
    spec: &'static OpSpec,
    ctx: ProcessContext,
    form: Option<Entity<SchemaForm>>,
    /// Các danh sách file đã thêm cho trường `FileList`.
    files: BTreeMap<&'static str, Vec<String>>,
    browse_focus: Vec<FocusHandle>,
    clear_focus: Vec<FocusHandle>,
    reveal_focus: FocusHandle,
    return_to: FocusHandle,
    runner: Runner,
    outputs: Vec<String>,
    _subs: Vec<Subscription>,
}

impl EventEmitter<ProcessEvent> for OpDialog {}

impl ProcessView for OpDialog {
    fn runner(&self) -> &Runner {
        &self.runner
    }

    fn runner_mut(&mut self) -> &mut Runner {
        &mut self.runner
    }

    fn context(&self) -> &ProcessContext {
        &self.ctx
    }
}

impl OpDialog {
    pub fn new(
        spec: &'static OpSpec,
        ctx: ProcessContext,
        return_to: FocusHandle,
        cx: &mut Context<Self>,
    ) -> Self {
        let root = chef_contracts::ops_schema();
        let dark = ctx.dark;
        let form = FormSchema::from_definition(&root, spec.def)
            .is_ok()
            .then(|| {
                cx.new(|cx| {
                    SchemaForm::new_with_json(&root, spec.def, dark, spec.json_fields(), cx)
                        .unwrap_or_else(|_| unreachable!("đã kiểm schema ở trên"))
                })
            });
        let mut subs = Vec::new();
        if let Some(form) = &form {
            subs.push(cx.subscribe(form, |_, _, _: &SchemaFormEvent, cx| cx.notify()));
            let pages = spec.pages_field.and_then(|f| {
                selected_pages_text(&ctx.target_pages, ctx.page_count).map(|t| (f, t))
            });
            form.update(cx, |form, cx| {
                for field in spec.paths {
                    if let Some(value) = default_path(field.kind, &ctx)
                        && !matches!(field.kind, PathKind::OpenImage)
                    {
                        form.set_text(field.name, &value, cx);
                    }
                }
                if let Some((field, text)) = &pages {
                    form.set_text(field, text, cx);
                }
            });
        }
        let n = spec.paths.len();
        let browse_focus = (0..n).map(|_| cx.focus_handle()).collect();
        let clear_focus = (0..n).map(|_| cx.focus_handle()).collect();
        Self {
            spec,
            ctx,
            form,
            files: BTreeMap::new(),
            browse_focus,
            clear_focus,
            reveal_focus: cx.focus_handle(),
            return_to,
            runner: Runner::default(),
            outputs: Vec::new(),
            _subs: subs,
        }
    }

    fn browse(&mut self, index: usize, cx: &mut Context<Self>) {
        let Some(field) = self.spec.paths.get(index).copied() else {
            return;
        };
        let Some(form) = self.form.clone() else {
            return;
        };
        let start = self.ctx.initial_dir.clone();
        match field.kind {
            PathKind::OpenPdf => {
                if let Some(path) = crate::dialogs::open_pdfs(start.as_deref())
                    .into_iter()
                    .next()
                {
                    let text = path.display().to_string();
                    form.update(cx, |f, cx| f.set_text(field.name, &text, cx));
                }
            }
            PathKind::OpenImage => {
                if let Some(path) = crate::dialogs::open_image(start.as_deref()) {
                    let text = path.display().to_string();
                    form.update(cx, |f, cx| f.set_text(field.name, &text, cx));
                }
            }
            PathKind::OpenImages => {
                if let Some(path) = crate::dialogs::open_image(start.as_deref()) {
                    self.push_file(form, field.name, path, cx);
                }
            }
            PathKind::OpenPdfs => {
                for path in crate::dialogs::open_pdfs(start.as_deref()) {
                    self.push_file(form.clone(), field.name, path, cx);
                }
            }
            PathKind::SavePdf(suffix) | PathKind::SaveFile(suffix, _) => {
                let ext = match field.kind {
                    PathKind::SaveFile(_, ext) => ext,
                    _ => "pdf",
                };
                let source = self.ctx.source.as_ref().map(|p| p.display().to_string());
                let suggested =
                    display_basename(&default_output(source.as_deref(), suffix, ext)).to_string();
                let suggested = if suggested.is_empty() {
                    format!("{}.{ext}", t("opDialog.untitled"))
                } else {
                    suggested
                };
                if let Some(path) = crate::dialogs::save_pdf(start.as_deref(), &suggested) {
                    let text = path.display().to_string();
                    form.update(cx, |f, cx| f.set_text(field.name, &text, cx));
                }
            }
            PathKind::Folder => {
                let suggested = format!("{}.pdf", file_stem(&self.ctx.file_name));
                if let Some(path) = crate::dialogs::save_pdf(start.as_deref(), &suggested)
                    && let Some(dir) = path.parent()
                {
                    let text = dir.display().to_string();
                    form.update(cx, |f, cx| f.set_text(field.name, &text, cx));
                }
            }
        }
    }

    fn push_file(
        &mut self,
        form: Entity<SchemaForm>,
        name: &'static str,
        path: PathBuf,
        cx: &mut Context<Self>,
    ) {
        let list = self.files.entry(name).or_default();
        let text = path.display().to_string();
        if !list.contains(&text) {
            list.push(text);
        }
        let all = list.clone();
        form.update(cx, |f, cx| f.set_files(name, all, cx));
    }

    fn clear_files(&mut self, name: &'static str, cx: &mut Context<Self>) {
        self.files.remove(name);
        if let Some(form) = self.form.clone() {
            form.update(cx, |f, cx| f.set_files(name, Vec::new(), cx));
        }
    }

    fn can_run(&self, cx: &gpui::App) -> bool {
        let Some(form) = &self.form else {
            return false;
        };
        !self.runner.running && form.read(cx).peek(cx).is_ok()
    }

    fn run(&mut self, cx: &mut Context<Self>) {
        if self.runner.running {
            return;
        }
        let Some(form) = self.form.clone() else {
            return;
        };
        let Some(params) = form.update(cx, |form, cx| form.validate(cx)) else {
            return;
        };
        let spec = self.spec;
        if spec.mode == OpMode::Revision {
            cx.emit(ProcessEvent::ApplyRevision {
                op_id: spec.op_id,
                params,
            });
            return;
        }
        let target = if spec.mode == OpMode::Output {
            self.ctx.target()
        } else {
            Target::None
        };
        self.outputs.clear();
        let ctx = self.ctx.clone();
        spawn_jobs(
            self,
            cx,
            |me| &mut me.runner,
            &ctx,
            spec.op_id,
            vec![(target, params)],
            move |me, outcome, cx| {
                me.runner.result = Some(match outcome {
                    Ok(mut all) => {
                        let ok = all
                            .pop()
                            .unwrap_or_else(|| JobOk::from_result(&Value::Null));
                        me.outputs = ok.outputs.clone();
                        let mut result = TaskResult::success(t("opDialog.done"));
                        if !ok.outputs.is_empty() {
                            result = result.detail(t_with(
                                "opDialog.doneFiles",
                                &[("count", &ok.outputs.len().to_string())],
                            ));
                        }
                        result.items(
                            ok.warnings
                                .into_iter()
                                .chain(
                                    ok.outputs
                                        .iter()
                                        .take(12)
                                        .map(|o| display_basename(o).to_string()),
                                )
                                .chain(data_lines(&ok.data)),
                        )
                    }
                    Err(JobFail::Cancelled) => TaskResult::cancelled(t("jobs.status.cancelled")),
                    Err(JobFail::Failed(message)) => {
                        TaskResult::error(t(&spec.title_key())).detail(message)
                    }
                });
                cx.notify();
            },
        );
        cx.notify();
    }
}

impl Render for OpDialog {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let dark = self.ctx.dark;
        let colors = Colors::of(dark);
        let entity = cx.entity();
        let spec = self.spec;
        let running = self.runner.running;

        let mut main = div().flex().flex_col().gap(px(12.));
        if let Some(form) = &self.form {
            main = main.child(div().w_full().child(form.clone()));
        }
        // Nút chọn đường dẫn.
        for (index, field) in spec.paths.iter().enumerate() {
            let browse_e = entity.clone();
            let label = chef_ui::i18n::t(&format!("opDialog.path.{}", field.name));
            let mut row = div().flex().items_center().gap(px(8.)).child(
                Button::new(
                    ("op-browse", index as u32),
                    self.browse_focus[index].clone(),
                )
                .icon("icons/folder-open.svg")
                .label(format!("{} {}", t("common.browse"), label.to_lowercase()))
                .size(Size::Sm)
                .dark(dark)
                .disabled(running)
                .on_click(move |_, _, cx| {
                    browse_e.update(cx, |me, cx| me.browse(index, cx));
                }),
            );
            if matches!(field.kind, PathKind::OpenImages | PathKind::OpenPdfs) {
                let clear_e = entity.clone();
                let name = field.name;
                row = row.child(
                    Button::new(("op-clear", index as u32), self.clear_focus[index].clone())
                        .label(t("opDialog.clearList"))
                        .size(Size::Sm)
                        .dark(dark)
                        .disabled(running)
                        .on_click(move |_, _, cx| {
                            clear_e.update(cx, |me, cx| me.clear_files(name, cx));
                        }),
                );
            }
            main = main.child(row);
        }
        if let Some(first) = self.outputs.first().cloned() {
            main = main.child(
                Button::new("op-reveal", self.reveal_focus.clone())
                    .icon("icons/folder-open.svg")
                    .label(t("outputs.showInFolder"))
                    .dark(dark)
                    .on_click(move |_, _, _| crate::process::reveal_in_folder(&first)),
            );
        }
        if self.form.is_none() {
            main = main.child(
                div()
                    .text_size(px(chef_theme::shared::TEXT_SM))
                    .text_color(rgba(colors.danger))
                    .child(t("errors.INTERNAL")),
            );
        }

        let mut order: Vec<FocusHandle> = self.browse_focus.clone();
        order.extend(self.clear_focus.iter().cloned());
        let mut dialog = TaskDialog::new(format!("op-{}", spec.id), t(&spec.title_key()), dark)
            .icon(spec.icon)
            .size(Width::Md)
            .return_focus(self.return_to.clone())
            .child(main)
            .run_label(t(&spec.run_key()))
            .can_run(self.can_run(cx))
            .tab_order(order);
        let description = chef_ui::i18n::t(&spec.description_key());
        if description != spec.description_key() {
            dialog = dialog.description(t_with(
                &spec.description_key(),
                &[("name", &self.ctx.file_name)],
            ));
        }
        wire(dialog, self, cx, Self::run)
    }
}

#[cfg(test)]
mod tests {
    use chef_ui::schema_form::{FieldKind, FormSchema};
    use serde_json::json;

    use super::*;

    #[test]
    fn every_spec_points_at_a_real_params_definition() {
        let root = chef_contracts::ops_schema();
        for spec in OPS {
            let schema = FormSchema::from_definition(&root, spec.def)
                .unwrap_or_else(|e| panic!("{}: {e:?}", spec.id));
            for field in spec.paths {
                assert!(
                    schema.fields.iter().any(|f| f.name == field.name),
                    "{}: không có trường {}",
                    spec.id,
                    field.name
                );
            }
            if let Some(pages) = spec.pages_field {
                let f = schema
                    .fields
                    .iter()
                    .find(|f| f.name == pages)
                    .unwrap_or_else(|| panic!("{}: không có trường trang {pages}", spec.id));
                assert!(
                    matches!(f.kind, FieldKind::PageRange { .. }),
                    "{}: {pages} không phải danh sách trang",
                    spec.id
                );
            }
        }
    }

    #[test]
    fn spec_ids_are_unique_and_op_ids_are_in_the_contract() {
        let mut seen = std::collections::HashSet::new();
        for spec in OPS {
            assert!(seen.insert(spec.id), "trùng mã {}", spec.id);
        }
        let ops_ts = include_str!("../../../../../packages/contracts/src/generated/ops.ts");
        for spec in OPS {
            assert!(
                ops_ts.contains(&format!("'{}': {};", spec.op_id, spec.def)),
                "{}: hợp đồng không có {} → {}",
                spec.id,
                spec.op_id,
                spec.def
            );
        }
    }

    #[test]
    fn no_required_field_is_left_without_a_control() {
        // Trường bắt buộc mà SchemaForm không sinh được sẽ chặn chạy; chỉ cho phép khi đã có nút riêng.
        let root = chef_contracts::ops_schema();
        let mut missing = Vec::new();
        for spec in OPS {
            let mut schema = FormSchema::from_definition(&root, spec.def).unwrap();
            schema.expose_json(spec.json_fields());
            for f in schema.unsupported_fields() {
                if f.required {
                    missing.push(format!("{}.{} ({:?})", spec.id, f.name, f.kind));
                }
            }
        }
        assert!(missing.is_empty(), "thiếu điều khiển: {missing:?}");
    }

    #[test]
    fn every_spec_has_text_in_both_languages() {
        let keys = |spec: &OpSpec| {
            let mut keys = vec![spec.title_key(), spec.run_key()];
            keys.extend(
                spec.paths
                    .iter()
                    .map(|p| format!("opDialog.path.{}", p.name)),
            );
            keys
        };
        for lang in [chef_ui::i18n::Lang::Vi, chef_ui::i18n::Lang::En] {
            let catalog = chef_ui::i18n::catalog(lang);
            for spec in OPS {
                for key in keys(spec) {
                    assert!(catalog.contains_key(&key), "{lang:?}: thiếu {key}");
                }
            }
            for key in [
                "opDialog.done",
                "opDialog.doneFiles",
                "opDialog.clearList",
                "opDialog.untitled",
            ] {
                assert!(catalog.contains_key(key), "{lang:?}: thiếu {key}");
            }
        }
    }

    #[test]
    fn flattens_result_data_into_readable_lines() {
        let data = json!({
            "count": 3,
            "ok": true,
            "skip": null,
            "pages": [1, 2, 3],
            "nested": { "name": "a", "tags": ["x", "y"] },
            "rows": [ { "id": 1 }, { "id": 2 } ]
        });
        let lines = data_lines(&data);
        assert!(lines.contains(&"count: 3".to_string()));
        assert!(lines.contains(&"ok: true".to_string()));
        assert!(lines.contains(&"pages: 1, 2, 3".to_string()));
        assert!(lines.contains(&"nested.name: a".to_string()));
        assert!(lines.contains(&"nested.tags: x, y".to_string()));
        assert!(lines.contains(&"rows[1].id: 1".to_string()));
        assert!(!lines.iter().any(|l| l.contains("skip")));
        let many = Value::Array((0..500).map(|i| json!({ "i": i })).collect());
        assert_eq!(data_lines(&many).len(), MAX_DATA_LINES);
        assert!(data_lines(&Value::Null).is_empty());
    }

    #[test]
    fn default_paths_follow_the_source_file() {
        assert_eq!(
            default_output(Some("/docs/hop-dong.pdf"), "-nen", "pdf"),
            "/docs/hop-dong-nen.pdf"
        );
        assert_eq!(default_output(None, "-nen", "pdf"), "");
        assert_eq!(
            selected_pages_text(&[1, 2, 4], 10).as_deref(),
            Some("2-3,5")
        );
        assert_eq!(selected_pages_text(&[0, 1], 2), None);
        assert_eq!(selected_pages_text(&[], 5), None);
    }
}
