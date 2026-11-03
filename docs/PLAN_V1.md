# Chef PDF: Kế hoạch đến bản 1.0

> Lập ngày 2026-11-03, sau khi chủ dự án trả lời CH1 (Windows, token Viettel-CA) và CH2 (chưa cần tự cập nhật). Đi kèm [TASKS.md](TASKS.md) (danh sách task gốc) và [NOTES.md](NOTES.md) (quyết định). **Cập nhật trạng thái ở đây và ở TASKS.md khi xong từng bước.**

## Hiện trạng

- 118 task: 57 ✅, 54 🔄, 6 ⬜, 1 ⏸ (T9.08, làm sau 1.0). Bản 1.0 còn **159** tính năng.
- Các test đã chạy trên Windows: lõi Python 1635, giao diện 736, desktop 228, e2e Electron + lõi thật (khoảng 80 spec).
- **CI GitHub chưa chạy từ 2026-10-31**: nhánh `claude/modest-dijkstra-ifoeki` đang **43 commit chưa push**, và lần chạy cuối hỏng ở e2e macOS và Windows. Vì vậy macOS và Linux gần như chưa được kiểm chứng với code hiện tại.
- Trạng thái 🔄 nghĩa là code đã có nhưng chưa qua cổng nghiệm thu của mốc. Mỗi mốc có một **Demo** trong TASKS.md; đó là tiêu chí nghiệm thu thật.

## Nguyên tắc làm

1. **Cắt dọc theo Demo của mốc**, không đóng từng task rời: mỗi bước đi từ lõi đến giao diện đến e2e với lõi thật.
2. **Định nghĩa "xong" cho một task** (đóng 🔄 → ✅): (a) có test lõi hoặc test giao diện cho hành vi chính và lỗi chính; (b) có ít nhất một e2e đường chính với lõi thật; (c) `pnpm typecheck`, `pnpm lint`, `ruff`, `mypy`, test đều xanh; (d) quyết định mới ghi vào NOTES.md; (e) cập nhật trạng thái trong TASKS.md.
3. Phần việc cần phần cứng hoặc người thật (token, điện thoại, Adobe Reader) được **gom thành danh sách kiểm thử tay cho chủ dự án**, không chặn phần còn lại.
4. Việc rủi ro cao làm trước: ký số với token thật, CI 3 hệ điều hành.
5. Mỗi mảng review xong thì commit riêng; không đẩy lên remote khi chưa được chủ dự án đồng ý.

## Giai đoạn 0: Nền chất lượng (làm ngay)

| Bước | Việc | Tiêu chí nghiệm thu | Kiểm tra |
|---|---|---|---|
| 0.1 ✅ | `ruff format` sạch (CI đang chạy `ruff format --check`) | `ruff format --check .` không báo file nào | `cd core && uv run ruff format --check .` và toàn bộ pytest vẫn xanh |
| 0.2 ✅ | Sửa race mở file khi app đang khởi động | File từ instance thứ hai tới trước khi cửa sổ nạp xong vẫn mở được, không rơi vào hàng đợi "file ban đầu" sau khi giao diện đã đọc | Unit test `OpenFilesController`; spec `smoke` bỏ được `waitForTimeout` |
| 0.3 ✅ | E2E chạy cả bộ ổn định | Chạy `pnpm e2e` toàn bộ đều xanh trên Windows (đạt: 86/86 ngày 2026-11-03 sau khi sửa các race trong spec `forms`, `tools5`) | Dọn tiến trình Electron treo giữa các spec, tăng chờ khởi động lõi |
| 0.4 ⬜ | **Push và CI 3 hệ điều hành xanh** (cần chủ dự án đồng ý push) | Cả 5 job CI xanh: JS, Core, E2E trên ubuntu, windows, macos | `gh run list` |

**Kiểm tra giữa chặng:** CI xanh trên 3 hệ điều hành trước khi sang giai đoạn sau (hoàn thành phần đầu của T11.01).

## Giai đoạn 1: Ký số với token Viettel (★, mốc v0.3)

Tiêu chí mốc (Demo v0.3): cắm token thật, chẩn đoán xanh, tạo mẫu chữ ký có ảnh tách nền, ký theo chữ mốc cho 10 file, Adobe Reader báo chữ ký hợp lệ.

| Bước | Việc | Task | Tiêu chí nghiệm thu |
|---|---|---|---|
| 1.1 | **Chủ dự án cắm token Viettel, chạy `spikes/s1_token_probe.py`**, gửi `token_probe_report.json` (hướng dẫn: `docs/spikes/S1-pkcs11.md` mục 9) | T1.08 | Biết đời token (V6/V4…), tên module PKCS#11, ký thử được một file |
| 1.2 | Chỉnh danh bạ driver và lớp PKCS#11 theo báo cáo thật | T3.01, T3.02 | App tự dò driver Viettel trên máy bạn, liệt kê chứng thư |
| 1.3 | Màn hình chẩn đoán từng bước, cảnh báo PIN sắp khóa | T3.03 | Kịch bản: thiếu driver, sai PIN, token rút ra giữa chừng đều có hướng dẫn tiếng Việt |
| 1.4 | Ký `.pfx`, kiểm tra chữ ký (chuỗi chứng thư, OCSP/CRL), thư viện ảnh chữ ký | T3.04, T3.08, T3.11 | E2E ký bằng pfx rồi kiểm tra ra "hợp lệ"; panel hiển thị người ký thật, không phải chữ hiển thị |
| 1.5 | Ký bằng kho chứng thư Windows (CNG) | T4.11 (phần Windows) | Ký được bằng chứng thư trong kho Windows khi không dùng PKCS#11 |
| 1.6 | **Kiểm tra chéo** trong Adobe Reader, Foxit; checklist thử token | T3.14 | Danh sách kiểm thử tay có kết quả; sửa lỗi tương thích nếu có |

**Rủi ro:** driver Viettel V6 tự hiện hộp PIN riêng (TOKENS.md), PIN sai nhiều lần làm khóa token. Mitigation: chỉ dùng module PKCS#11, đọc cờ PIN trước mỗi lần hỏi, không thử PIN tự động quá một lần.

## Giai đoạn 2: Đóng các mốc v0.5, v0.6, v0.7

| Mốc | Demo (cổng nghiệm thu) | Task cần đóng |
|---|---|---|
| v0.5 | Soi file, kiểm tra trước khi gửi, nén còn ≤ 2 MB, tách thông minh theo trang trắng, crash giữa chừng vẫn khôi phục | T4.03, T5.01–T5.05, T5.07–T5.11 |
| v0.6 | Gỡ logo chìm mọi trang, tẩy một vùng, che CCCD rồi kiểm chứng không copy ra được chữ bên dưới | T6.03–T6.07 |
| v0.7 | Sửa một câu tiếng Việt trong hợp đồng, thay tên công ty toàn tài liệu, highlight và ghi chú | T7.01, T7.02, T7.04–T7.07 |

Mỗi mốc: (1) viết một e2e theo đúng câu Demo bằng lõi thật; (2) chạy, sửa lỗi; (3) rà từng task theo định nghĩa "xong", đóng ✅ những task đạt, ghi lý do cho task chưa đạt. Cần tập tài liệu thật (hợp đồng, CCCD giả lập, file có watermark) trong `tests/e2e/fixtures`.

**Kiểm tra giữa chặng:** CI xanh sau mỗi mốc; chủ dự án dùng thử Demo trên máy thật.

## Giai đoạn 3: Đóng các mốc v0.8 và v0.9

| Mốc | Demo | Task cần đóng | Việc cần người thật |
|---|---|---|---|
| v0.8 | Chụp 20 trang sách bằng điện thoại qua QR, tự dò viền, tách trang đôi, làm phẳng, xóa ngón tay, ra PDF đẹp | T8.01–T8.04, T8.06–T8.11 | **Thử trang chụp trên điện thoại thật** (chưa từng thử); 20 trang sách thật để chỉnh ngưỡng |
| v0.9 | Tạo quy trình "Nộp hồ sơ online", thả 20 file vào thư mục tự động, lấy kết quả đã ký | T9.01–T9.07 (T9.08 hoãn) | Cần giai đoạn 1 xong để có bước ký thật |

Việc còn mở đã biết: nối "Lưu thành bước quy trình" cho các hộp thoại còn lại (T9.03), bám viền tự động và hoàn thiện cắt hàng loạt (T8.06, T8.07), gỡ giới hạn "xuất Markdown/HTML vào tên đã có thư mục ảnh".

## Giai đoạn 4: Mốc v0.10, rã tài liệu

Demo: rã một báo cáo 2 cột có bảng thành Word "giữ bố cục" và Markdown. Task: T10.01–T10.07. Việc còn mở đã biết: sửa vùng phi văn bản mà không mất dữ liệu (T10.03), kiểm thử DOCX bằng Word/LibreOffice thật (T10.05, chủ dự án mở thử), tài liệu cũ thiếu tọa độ (đang ước lượng).

## Giai đoạn 5: Cổng bản 1.0 (mốc v1.0)

| Bước | Task | Tiêu chí nghiệm thu |
|---|---|---|
| 5.1 | T11.02 hiệu năng | File 1000 trang mở và cuộn mượt; file 300 MB không tràn RAM; khởi động ≤ ngưỡng ghi trong BLUEPRINT; có số đo trong NOTES |
| 5.2 | T11.03 giấy phép | Rà toàn bộ thư viện, font, mô hình (có DocAligner, onnxruntime); tạo file NOTICE; không có thư viện AGPL (D7) |
| 5.3 | T11.05 đánh bóng | Phím tắt, điều hướng bằng bàn phím, trạng thái rỗng và lỗi thống nhất |
| 5.4 | T11.04 hướng dẫn | `docs/HUONG_DAN_SU_DUNG.md` khớp tính năng cuối, kèm ảnh/chú thích nơi cần |
| 5.5 | T11.01 kiểm thử 3 hệ điều hành | CI xanh liên tục; chủ dự án thử bộ cài Windows, ghi nhận macOS/Linux chỉ qua CI |
| 5.6 | **Dùng hằng ngày một tuần** | Không lỗi nghiêm trọng (tiêu chí Demo v1.0); lỗi tìm thấy ghi vào NOTES và sửa |

## Rủi ro và cách giảm

| Rủi ro | Mức | Cách giảm |
|---|---|---|
| Token Viettel khác với giả định (đời, driver) | Cao | Làm bước 1.1 sớm nhất; chỉ dùng PKCS#11; chẩn đoán rõ ràng |
| CI 3 OS lộ nhiều lỗi sau 43 commit chưa kiểm | Cao | Làm giai đoạn 0 đầu tiên; sửa theo từng job |
| E2E không ổn định khi chạy cả bộ | Trung bình | Bước 0.3; dọn tiến trình; chờ tường minh thay vì `waitForTimeout` |
| 54 task 🔄 không có tiêu chí riêng | Trung bình | Dùng Demo từng mốc làm cổng, ghi lý do cho task chưa đạt |
| Tệp lớn (`commands.tsx`, `mockBridge.ts`) khó bảo trì | Thấp | Tách khi chạm vào, không làm riêng |
| macOS/Linux không có máy thử | Trung bình | CI là nguồn kiểm chứng duy nhất (D35); ghi rõ phạm vi trong hướng dẫn |

## Câu hỏi còn mở

- Cho phép push nhánh hiện tại lên GitHub để chạy CI không (bước 0.4)?
- Điện thoại dùng thử trang chụp: Android hay iPhone (trình duyệt nào)?
- Ban Cơ yếu / VNPT / FPT: chỉ cần Viettel cho 1.0, hay phải thử thêm CA khác?
