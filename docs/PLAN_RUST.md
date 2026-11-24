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
| M1 Khung và rủi ro | Cửa sổ, theme từ tokens, UniKey IME Telex/VNI, viewer pdfium, bộ đo RAM, off-screen, kênh debug, lõi lười | 43 |
| M2 Xem đầy đủ | Tab, mở và lưu, thumbnail, tìm kiếm, chọn và copy, theme, i18n, thư viện thành phần | 34 |
| M3 Phiên và thao tác | RPC, giám sát lõi, lõi lười, mô hình revision, undo, lưu, khôi phục | 15 |
| M4 Trang và chú thích | Lưới trang, chọn nhiều, menu, đối tượng, lớp, ghi chú, form | 25 |
| M5 Hộp thoại và xử lý | Khung hộp thoại, renderer từ schema, ghép, tách, nén, bản scan, đóng dấu, bảo mật, rã, quy trình (5a–5f) | 69 |
| M6 Ký số | Chứng thư, token, chẩn đoán, studio chữ ký, ký, kiểm tra | 30 |
| M7 Sửa chữ và đoạn | Chế độ sửa, sửa dòng và đoạn, hàng định dạng, thêm chữ, tìm thay thế | 13 |
| M8 Chụp và xử lý ảnh | Trình sửa ảnh trang, chụp qua LAN, tách trang đôi, xóa ngón tay, tự dò viền | 23 |
| M9 Hoàn thiện | Cài đặt đầy đủ, mở bằng app PDF, in, bộ cài, dữ liệu từ Electron, nghiệm thu, gỡ Electron | 17 |

## Thứ tự làm tiếp (cập nhật 2026-11-22, D92 và rà trạng thái M1/M2)

Mốc là cách chia việc. Thứ tự làm đi theo rủi ro còn lại, nên có chỗ không theo số mốc. Danh sách task cụ thể ở mục "Thứ tự làm tiếp" của [TASKS_RUST.md](TASKS_RUST.md).

1. **M1 đã được chủ dự án nghiệm thu (2026-11-22, D93).** R1.05 đã đóng (run `45044608231` xanh trên `d6caeda`). Cổng môi trường còn mở: R1.32 cần đo frame/present, hiện Windows policy chặn WPR. Ước lượng điểm M2–M9 chờ số giờ thực tế; không suy đoán giờ.
2. **Khép M2 theo bằng chứng:** R2.17 cần kéo file thật từ Explorer; R2.19 cần OS wheel/key và present/frame; R2.28 cần full-page visual comparison ngày/đêm; rồi hoàn tất R2.32 và MAN-5. R2.16, R2.21 và R2.26 đã ✅ trong lần rà 2026-11-22.
3. **Sau khi các cổng môi trường đã được ghi rõ hoặc hoàn tất, tiếp tục phần còn lại của M3** (R3.09 còn mở), rồi M4 đến M9 theo thứ tự bảng trên. Điểm kiểm M1/M2 không phải phụ thuộc kỹ thuật hay cổng dừng.
4. Sau khi xong renderer hộp thoại từ schema (R5.02), rà lại kích thước các task hộp thoại của M5.

## Quy tắc đi kèm

- Mỗi mốc có Demo nghiệm thu và **một dòng báo cáo RAM** (`nativeMB` + `coreMB`) đối chiếu với Electron cùng kịch bản.
- Không có ngân sách số cứng. Mục tiêu là RAM thấp nhất đạt được.
- Không có cổng dừng riêng: rủi ro lớn nhất (IME, off-screen) nằm trong M1 và được xử lý ngay trong đó, với đường dự phòng đã biết.
- Điểm kiểm cuối mỗi mốc là điểm xem lại kế hoạch, không phải cổng dừng, và **không phải phụ thuộc kỹ thuật**: task của mốc sau không chờ điểm kiểm của mốc trước.
- Task 🔄 chỉ còn thiếu việc thuộc mốc sau thì chuyển tiêu chí đó sang task của mốc sau và đóng, không để đuôi kéo dài.
- Trước mỗi lần báo "xong" một đợt việc: chạy script gộp E2E native (R2.33) cùng fmt, clippy, test.
- Phiên cloud (Linux, không có Windows): chạy `scripts/cloud-linux-check.sh` (fmt, clippy, test; vá tạm `xattr` mà không sửa repo) và `cd core && uv run pytest` cho phần lõi. Việc này không thay được E2E và bộ kiểm trên Windows.
- Không commit nếu chủ dự án không yêu cầu.
