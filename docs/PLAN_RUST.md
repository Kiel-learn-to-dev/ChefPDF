# Chef PDF: Lộ trình vỏ Rust + GPUI

> Theo quyết định **D71** ([NOTES.md](NOTES.md)). Ba file có vai trò khác nhau:
> - [BLUEPRINT_RUST.md](BLUEPRINT_RUST.md): **thiết kế** (kiến trúc, hình họa, kiểm thử, rủi ro).
> - [TASKS_RUST.md](TASKS_RUST.md): **việc phải làm và trạng thái** (269 task, tiêu chí, phụ thuộc, độ phủ). Nguồn trạng thái duy nhất.
> - File này: **cách chia mốc, thứ tự làm** và quy tắc đi kèm.
>
> Electron 1.3 vẫn là bản đang chạy cho đến khi bản Rust đạt parity và chủ dự án chốt dùng hằng ngày. Lõi Python và hợp đồng JSON-RPC ([CONTRACTS.md](CONTRACTS.md)) không đổi.

## Mốc (cách chia việc)

Trạng thái từng task xem ở [TASKS_RUST.md](TASKS_RUST.md). Thiết kế từng mốc xem ở [BLUEPRINT_RUST.md §13](BLUEPRINT_RUST.md#13-các-mốc).

| Mốc | Nội dung chính | Số task |
|---|---|---|
| M1 Khung và rủi ro | Cửa sổ, theme từ tokens, IME Telex, viewer pdfium, bộ đo RAM, off-screen, kênh debug, lõi lười | 43 |
| M2 Xem đầy đủ | Tab, mở và lưu, thumbnail, tìm kiếm, chọn và copy, theme, i18n, thư viện thành phần | 34 |
| M3 Phiên và thao tác | RPC, giám sát lõi, lõi lười, mô hình revision, undo, lưu, khôi phục | 15 |
| M4 Trang và chú thích | Lưới trang, chọn nhiều, menu, đối tượng, lớp, ghi chú, form | 25 |
| M5 Hộp thoại và xử lý | Khung hộp thoại, renderer từ schema, ghép, tách, nén, bản scan, đóng dấu, bảo mật, rã, quy trình (5a–5f) | 69 |
| M6 Ký số | Chứng thư, token, chẩn đoán, studio chữ ký, ký, kiểm tra | 30 |
| M7 Sửa chữ và đoạn | Chế độ sửa, sửa dòng và đoạn, hàng định dạng, thêm chữ, tìm thay thế | 13 |
| M8 Chụp và xử lý ảnh | Trình sửa ảnh trang, chụp qua LAN, tách trang đôi, xóa ngón tay, tự dò viền | 23 |
| M9 Hoàn thiện | Cài đặt đầy đủ, mở bằng app PDF, in, bộ cài, dữ liệu từ Electron, nghiệm thu, gỡ Electron | 17 |

## Thứ tự làm tiếp (chốt 2026-11-11, D86)

Mốc là cách chia việc. Thứ tự làm đi theo rủi ro còn lại, nên có chỗ không theo số mốc. Danh sách task cụ thể ở mục "Thứ tự làm tiếp" của [TASKS_RUST.md](TASKS_RUST.md).

1. **MAN-1 ngay:** chủ dự án gõ thử Telex, Unikey/EVKey trong ô nhập đã có (R1.26, R1.27). Kết quả quyết định có phải làm đường TSF dự phòng (R1.24, R1.25, hai task L) hay không.
2. **Lát cắt dọc M3:** một thao tác thật (`page.rotate`) chạy trọn qua lõi: khởi động lõi, `session.open`, `ops.run`, viewer đổi sang rev file và giữ vị trí, hoàn tác, lưu. Làm trước phần còn lại của M2, vì khoảng 170 task của M4–M8 phụ thuộc chuỗi này và việc đổi sang rev file (R3.06) là rủi ro kiến trúc lớn nhất chưa kiểm.
3. **Gom đuôi M1 và làm Điểm kiểm M1:** script chạy gộp E2E, so các probe hình họa với Electron trong một lần, đo RAM có `coreMB` (cần lõi từ bước 2), rồi đọc lại M2–M9 và ước lượng điểm.
4. **Phần còn lại của M2** (tab, thumbnail, Start, bảng lệnh, chế độ xem), rồi điểm kiểm M2.
5. **Phần còn lại của M3**, rồi M4 đến M9 theo thứ tự bảng trên. Sau khi xong renderer hộp thoại từ schema (R5.02), rà lại kích thước các task hộp thoại của M5.

## Quy tắc đi kèm

- Mỗi mốc có Demo nghiệm thu và **một dòng báo cáo RAM** (`nativeMB` + `coreMB`) đối chiếu với Electron cùng kịch bản.
- Không có ngân sách số cứng. Mục tiêu là RAM thấp nhất đạt được.
- Không có cổng dừng riêng: rủi ro lớn nhất (IME, off-screen) nằm trong M1 và được xử lý ngay trong đó, với đường dự phòng đã biết.
- Điểm kiểm cuối mỗi mốc là điểm xem lại kế hoạch, không phải cổng dừng, và **không phải phụ thuộc kỹ thuật**: task của mốc sau không chờ điểm kiểm của mốc trước.
- Task 🔄 chỉ còn thiếu việc thuộc mốc sau thì chuyển tiêu chí đó sang task của mốc sau và đóng, không để đuôi kéo dài.
- Trước mỗi lần báo "xong" một đợt việc: chạy script gộp E2E native (R2.33) cùng fmt, clippy, test.
- Không commit nếu chủ dự án không yêu cầu.
