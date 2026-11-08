# Chef PDF: Lộ trình vỏ Rust + GPUI

> Theo quyết định **D71** ([NOTES.md](NOTES.md)). Ba file có vai trò khác nhau:
> - [BLUEPRINT_RUST.md](BLUEPRINT_RUST.md): **thiết kế** (kiến trúc, hình họa, kiểm thử, rủi ro).
> - [TASKS_RUST.md](TASKS_RUST.md): **việc phải làm và trạng thái** (267 task, tiêu chí, phụ thuộc, độ phủ). Nguồn trạng thái duy nhất.
> - File này: **thứ tự mốc** và quy tắc đi kèm.
>
> Electron 1.3 vẫn là bản đang chạy cho đến khi bản Rust đạt parity và chủ dự án chốt dùng hằng ngày. Lõi Python và hợp đồng JSON-RPC ([CONTRACTS.md](CONTRACTS.md)) không đổi.

## Mốc (theo thứ tự rủi ro)

Trạng thái từng task xem ở [TASKS_RUST.md](TASKS_RUST.md). Thiết kế từng mốc xem ở [BLUEPRINT_RUST.md §13](BLUEPRINT_RUST.md#13-các-mốc).

| Mốc | Nội dung chính | Số task |
|---|---|---|
| M1 Khung và rủi ro | Cửa sổ, theme từ tokens, IME Telex, viewer pdfium, bộ đo RAM, off-screen, kênh debug, lõi lười | 42 |
| M2 Xem đầy đủ | Tab, mở và lưu, thumbnail, tìm kiếm, chọn và copy, theme, i18n, thư viện thành phần | 33 |
| M3 Phiên và thao tác | RPC, giám sát lõi, lõi lười, mô hình revision, undo, lưu, khôi phục | 15 |
| M4 Trang và chú thích | Lưới trang, chọn nhiều, menu, đối tượng, lớp, ghi chú, form | 25 |
| M5 Hộp thoại và xử lý | Khung hộp thoại, renderer từ schema, ghép, tách, nén, bản scan, đóng dấu, bảo mật, rã, quy trình (5a–5f) | 69 |
| M6 Ký số | Chứng thư, token, chẩn đoán, studio chữ ký, ký, kiểm tra | 30 |
| M7 Sửa chữ và đoạn | Chế độ sửa, sửa dòng và đoạn, hàng định dạng, thêm chữ, tìm thay thế | 13 |
| M8 Chụp và xử lý ảnh | Trình sửa ảnh trang, chụp qua LAN, tách trang đôi, xóa ngón tay, tự dò viền | 23 |
| M9 Hoàn thiện | Cài đặt đầy đủ, mở bằng app PDF, in, bộ cài, dữ liệu từ Electron, nghiệm thu, gỡ Electron | 17 |

## Quy tắc đi kèm

- Mỗi mốc có Demo nghiệm thu và **một dòng báo cáo RAM** (`nativeMB` + `coreMB`) đối chiếu với Electron cùng kịch bản.
- Không có ngân sách số cứng. Mục tiêu là RAM thấp nhất đạt được.
- Không có cổng dừng riêng: rủi ro lớn nhất (IME, off-screen) nằm trong M1 và được xử lý ngay trong đó, với đường dự phòng đã biết.
- Điểm kiểm cuối mỗi mốc là điểm xem lại kế hoạch, không phải cổng dừng.
- Không commit nếu chủ dự án không yêu cầu.
