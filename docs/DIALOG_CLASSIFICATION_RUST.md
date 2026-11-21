# Phân loại hộp thoại theo renderer schema (R5.02, tiêu chí 4)

Nguồn: 104 màn hình của `tests/visual/native-refs/ui-audit-manifest.json` (mỗi theme). Gồm 68 hộp thoại cơ bản (`dialog_*`), 16 ảnh "Nâng cao" (`*_adv0_*`, thuộc cùng hộp thoại cơ bản) và 20 màn hình không phải hộp thoại xử lý (`about`, `edit_*`, `main_*`, `overlay_*`, `start`). Bảng dưới phân loại 68 hộp thoại.

Cách đọc ba nhóm (BLUEPRINT_RUST §6):

- **S, sinh từ schema:** form do `SchemaForm` (`chef-ui/src/schema_form.rs`) vẽ hoàn toàn từ `Params`; chỉ nối vào `TaskDialog` (R5.01). Điều kiện đạt: ảnh so khớp ngưỡng R2.02.
- **S+, schema + phần viết tay:** `SchemaForm` lo các trường nhập; phần còn lại viết tay đặt cạnh trong `TaskDialog` (xem trước trang, danh sách kéo thả, ước lượng dung lượng, kéo khung trên trang, bảng).
- **H, viết tay hoàn toàn:** không ứng với một `Params` đơn lẻ (cài đặt, quản lý, trình hướng dẫn, màn hình duyệt).
- **✕:** bỏ (D78).

Đây là phân loại dự kiến. Nhóm cuối cùng của từng hộp thoại được chốt khi làm task tương ứng và so ảnh ở R5.09; nếu một hộp thoại S không đạt ngưỡng R2.02 thì chuyển sang S+.

| Nhóm | Số | Hộp thoại |
|---|---|---|
| S | 6 | insertBlank, pageGridSplit, repair, rename, linkDialog, insertFromFile |
| S+ | 44 | merge, split (+nâng cao), smartSplit (+nâng cao), compress (+nâng cao), color (+nâng cao), pdfToImages (+nâng cao), imagesToPdf, pageCrop, pageBlank (+nâng cao), pageReplace, insertImages, overlayCode (+nâng cao), overlayHeaderFooter (+nâng cao), overlayImage (+nâng cao), overlayLetterhead (+nâng cao), overlayPageNumbers (+nâng cao), overlayText (+nâng cao), overlayWatermark (+nâng cao), overlayBates, stamp (+nâng cao), seam (+nâng cao), spine, scan, security, properties, redact, preflight, inspect, removeSimilar, watermarkRemove, finger, dewarp, erase, backgroundRemove, adjust, docTools, batchExport, batchSign, batchCrop, capture, initials (+nâng cao), signDoc, toc, findReplace |
| H | 17 | settings, shortcuts, print, certs, trust, tokenWizard, sigLibrary, signTemplates, cropReview, layoutReview, forms, workflow, watch, recovery, documentExport, overlayManager, verifyBatch |
| ✕ | 1 | web2pdf (CH-R1, bỏ) |
| **Tổng** | **68** | |

## Hệ quả cho kích thước task M5

Quy tắc: task chỉ còn nối `SchemaForm` vào `TaskDialog` và viết E2E (không có xem trước hay điều khiển riêng) xuống S. Task có phần viết tay lớn giữ M.

- Xuống S (nhóm S hoặc S+ không có phần viết tay lớn): R5.04 (Tách file), R5.44 (Đặt mật khẩu), R5.46 (Gỡ dữ liệu ẩn).
- Giữ M: mọi task còn lại có xem trước, kéo khung, danh sách kéo thả hoặc bảng (merge, cắt lề, watermark, con dấu, scan, rã tài liệu…).
- Task M6, M7, M8 không đổi: hầu hết thuộc H hoặc S+ với phần viết tay chiếm phần lớn.

## Phạm vi của renderer (đo trên `ops.schema.json`)

`SchemaForm` sinh điều khiển cho: chuỗi (có `minLength`, `maxLength`), số nguyên, số thực (có `minimum`, `maximum`), bool, `enum`, danh sách số trang (nhập "1-3, 5", đổi sang chỉ số lõi) và danh sách file (đối tượng `{path}` hoặc chuỗi). Đối tượng lồng và mảng phức tạp là `Unsupported`: trường tùy chọn bị bỏ qua, trường bắt buộc chặn chạy và cần điều khiển viết tay. Test `most_required_fields_are_generated` giữ tỉ lệ trường bắt buộc không sinh được dưới 20% trên 194 operation.
