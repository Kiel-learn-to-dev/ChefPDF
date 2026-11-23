# Việc cần kiểm trên Windows: M5 (phần logic đã code trên Linux)

Phiên 2026-11-23 chạy trên container Linux, không build được `chef-app` (GPUI, lỗi `xattr`). Các module dưới đây chỉ có **logic thuần + unit test**, chưa nối giao diện, nên phải chạy kiểm trên máy Windows.

## Cách pull và kiểm
```
git fetch origin claude/gifted-ritchie-qrrvzj && git checkout claude/gifted-ritchie-qrrvzj
cd apps/native
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p chef-app merge:: split:: split_page:: crop_page:: blank_pages:: smart_split:: scan_convert:: naming:: ordering:: rename::
cargo test -p chef-contracts
cargo deny check
```
Trên Linux các test này đã đạt (11/11) qua crate tạm với bản thay thế `output_conflicts_with_protected_path`; trên Windows hàm thật dùng `same_file` nên cần xem `merge::tests::rejects_bad_requests` đạt.

## Module
| Task | File | Có | Chưa có |
|---|---|---|---|
| R5.03 Ghép | `merge.rs` | `MergeList` (thêm/bỏ/đổi chỗ/mật khẩu), `params()`, chặn ghi đè nguồn, tên gợi ý | hộp thoại, kéo sắp, E2E `tools5`, SHA-256 nguồn |
| R5.04 Tách | `split.rs` | `params()` 6 chế độ, kiểm khoảng trang/mẫu tên | hộp thoại, E2E |
| R5.05 Cắt/đổi khổ | `crop_page.rs` | `crop_params`, `resize_params` | hộp thoại, xem trước, E2E |
| R5.06 Trang trắng | `blank_pages.rs` | `find_params`, `parse_rows`, `Review` (xác nhận trước khi xóa) | hộp thoại, nối `page.delete`, E2E |
| R5.08 Tách thông minh | `smart_split.rs` | `params`, xem trước điểm tách | hộp thoại, E2E |
| R5.23/26/27 Scan | `scan_convert.rs` | form ↔ `scan.rasterize`, preset, giới hạn dung lượng (logic) | hộp thoại, xem trước (R5.25), lưu preset, gọi RPC, E2E `scan` |
| R5.64 Đặt tên | `naming.rs` | mẫu, làm sạch Windows, trùng tên, kế hoạch | nối vào quy trình/hộp thoại |
| R5.65 Thứ tự an toàn | `ordering.rs` | kiểm thứ tự bước, tự sắp, sắp tự nhiên | nối vào trình tạo quy trình |
| R5.66 Đổi tên hàng loạt | `rename.rs` | `apply`/`undo` hai pha | hộp thoại xem trước, nhật ký đĩa, E2E `rename` |
| R5.07 Chia trang | `split_page.rs` | `halves`, `grid`, đếm trang sau chia | hộp thoại, E2E |

Mỗi file có `#![allow(dead_code)]`; bỏ khi nối giao diện (clippy sẽ báo nếu quên).

## Đã sửa: enum trùng title trong `chef-contracts`
Trước đây typify gộp nhầm enum nội tuyến cùng title (`Mode`, `Fit`, `Size`...) giữa các operation, nên `FileSplitParams`, `PageCropParams`, `PageResizeParams` không đọc lại được JSON hợp lệ của lõi. `build.rs` giờ đổi title thành `<Definition><Title>` khi cùng title mà khác tập giá trị (chỉ cho schema ops). Test `same_titled_enums_stay_separate_per_operation` đạt trên Linux. `split.rs` và `crop_page.rs` vẫn trả `serde_json::Value` (đủ dùng); có thể đổi sang struct sinh sau. Trên Windows cần chạy lại `cargo test -p chef-contracts` và `cargo clippy` vì tên type sinh ra có thể đổi.

## Chưa làm của M5
R5.09–R5.10 và M5b–M5f (R5.11 trở đi, trừ R5.23, R5.26, R5.27, R5.64–R5.66). R5.24 (hạt giống hiệu ứng scan) và R5.59 (mục lục) không có logic thuần đáng viết: lõi làm hết, chỉ còn giao diện: cần giao diện và/hoặc lõi chạy thật để kiểm, chưa bắt đầu.

## Ngoài M5
`cert_model.rs`, `diag_model.rs`, `sign_anchor.rs`, `sign_batch.rs`, `sign_verify_model.rs`, `capture_model.rs`, `page_image_tools.rs`, `crop_geometry.rs`: port mô hình Electron, test `cargo test -p chef-app`.

Thêm: `compress_model.rs` (R5.11), `convert_model.rs` (R5.12–13), phần dewarp và adjust của `page_image_tools.rs` (R8.04–06, R8.13–14).
Thêm: `find_replace_model.rs` (R7.10), `verify_batch_model.rs` (R6.29), `preflight_model.rs` (R5.48).
Thêm: `page_range.rs` (port `pageRange.ts`; `scan_convert::parse_pages` giờ gọi nó nên nhận "5-", "-3", dấu `;`), `overlay_common.rs`, `stamp_model.rs` (R5.30–31), `watermark_model.rs` (R5.40).
Thêm: `redact_model.rs` (R5.49), `inspect_model.rs` (R5.46–47).
Thêm: `doc_tools_model.rs` (R5.18–22), `text_paragraph_model.rs` (R7.04–06).
Thêm: `sig_library_model.rs` (R6.07–09), `sign_template_model.rs` (R6.11–16), `update_check.rs` (R9.08).

Còn chưa port (logic thuần): `overlayModel.ts` (R5.29–R5.38, 1092 dòng) và `objectModel.ts` (R7.11). R9.11 (script độ phủ mã tính năng) là script Python, không thuộc `chef-app`.

Thêm: `overlay_variables.rs`, `overlay_model.rs` (R5.29, R5.34–R5.39; chữ và ảnh thêm vào trang R7.07 dùng chung), `object_model.rs` (R4.12–R4.15, R7.11; bổ sung cho `objects.rs`).

Thêm: `cleanup_model.rs` (R5.41–42), `color_model.rs` (R5.17), `export_model.rs` (R5.53–56), `security_model.rs` (R5.44–45), `initials_model.rs` (R5.33), `workflow_model.rs` (R5.61–63), `recovery_model.rs` (khôi phục phiên, A9), `sig_separate_model.rs` (R8.12), `text_edit_model.rs` (R7.01–03, R7.12). `text_paragraph_model::TextLine` có thêm các trường `id`, `page_index`, `font_name`, `can_encode_any`, `glyphs`.

**Đã port** (2026-11-23): mọi `apps/ui/src/features/*/*Model.ts` có logic thuần, trừ `web2pdfModel` (R5.16 đã bỏ), phần bất đồng bộ của `recoveryModel` (thử lại kiểm tra khi khởi động, thuộc luồng chạy), và các tệp `pagetools/*Model` đã có bản Rust ở `blank_pages.rs`, `crop_page.rs`, `split_page.rs`, `smart_split.rs`, `replaceModel` (R4.x chưa đối chiếu). `annotModel`, `formsModel`, `layersModel`, `linksModel` có module Rust riêng (`annots.rs`, `forms_*.rs`, `layers.rs`, `links.rs`), chưa đối chiếu từng hàm.

## Hộp thoại đã có (2026-11-23, lượt 2) — thử trên Windows
Mở bảng lệnh (Ctrl+K) rồi gõ: **Ghép file**, **Sửa file PDF hỏng**, **Nén PDF**, **Mật khẩu & quyền**, **Chuyển đổi** (có hai dòng: PDF sang ảnh và Ảnh sang PDF), **Kiểm tra chữ ký hàng loạt**.
- `merge_dialog.rs`: Ghép file (R5.03): thêm file, mũi tên lên/xuống, bookmark, lưu, chạy, dừng.
- `op_dialog.rs`: hộp thoại chung dựng từ schema (`SPECS`); thêm thao tác mới chỉ cần một dòng + một action.
- `job_runner.rs`: chạy `ops.run` ở luồng nền, ghi mã job, dừng, chờ kết quả.
- Đã kiểm kiểu và clippy cho target Windows (`cargo clippy -p chef-app --target x86_64-pc-windows-gnu --all-targets -- -D warnings`, cần `gcc-mingw-w64-x86-64`). **Chưa chạy lần nào.**
- Cần xem: nút chọn file mở đúng hộp thoại Windows; trường nào của form sinh từ schema bị `Unsupported` (hiện báo khi chạy nếu bắt buộc); tên nhãn tiếng Anh của trường (chưa có chuỗi `schemaForm.fields.*` đủ); có bị lỗi tiêu điểm bàn phím trong TaskDialog không.
- Test mới ở `op_dialog.rs` (chạy được trên Windows): mọi `SPECS` dựng được form và có chuỗi giao diện.
