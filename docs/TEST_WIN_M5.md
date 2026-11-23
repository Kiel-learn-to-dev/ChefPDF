# Việc cần kiểm trên Windows: M5 (phần logic đã code trên Linux)

Phiên 2026-11-23 chạy trên container Linux, không build được `chef-app` (GPUI, lỗi `xattr`). Các module dưới đây chỉ có **logic thuần + unit test**, chưa nối giao diện, nên phải chạy kiểm trên máy Windows.

## Cách pull và kiểm
```
git fetch origin claude/gifted-ritchie-qrrvzj && git checkout claude/gifted-ritchie-qrrvzj
cd apps/native
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p chef-app merge:: split:: split_page:: crop_page:: blank_pages:: smart_split::
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
| R5.07 Chia trang | `split_page.rs` | `halves`, `grid`, đếm trang sau chia | hộp thoại, E2E |

Mỗi file có `#![allow(dead_code)]`; bỏ khi nối giao diện (clippy sẽ báo nếu quên).

## Đã sửa: enum trùng title trong `chef-contracts`
Trước đây typify gộp nhầm enum nội tuyến cùng title (`Mode`, `Fit`, `Size`...) giữa các operation, nên `FileSplitParams`, `PageCropParams`, `PageResizeParams` không đọc lại được JSON hợp lệ của lõi. `build.rs` giờ đổi title thành `<Definition><Title>` khi cùng title mà khác tập giá trị (chỉ cho schema ops). Test `same_titled_enums_stay_separate_per_operation` đạt trên Linux. `split.rs` và `crop_page.rs` vẫn trả `serde_json::Value` (đủ dùng); có thể đổi sang struct sinh sau. Trên Windows cần chạy lại `cargo test -p chef-contracts` và `cargo clippy` vì tên type sinh ra có thể đổi.

## Chưa làm của M5
R5.09–R5.10 và M5b–M5f (R5.11 trở đi): cần giao diện và/hoặc lõi chạy thật để kiểm, chưa bắt đầu.
