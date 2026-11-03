# Chef PDF: Kế hoạch đến bản 1.0 (Windows trước)

> Viết lại ngày 2026-11-03 sau khi chủ dự án chốt **ưu tiên bản Windows** (D37): bản 1.0 chỉ cam kết chạy tốt trên Windows với token Viettel-CA (D35). macOS và Linux để sau 1.0. Đi kèm [TASKS.md](TASKS.md) (danh sách task gốc) và [NOTES.md](NOTES.md) (quyết định). **Cập nhật trạng thái ở đây và ở TASKS.md khi xong từng bước.**

## Hiện trạng (2026-11-03)

- 118 task: 57 ✅, 54 🔄, 6 ⬜, 1 ⏸ (T9.08 tự cập nhật, làm sau 1.0). Bản 1.0 có **159** tính năng.
- Test trên Windows đều xanh: lõi Python 1638, giao diện 736, desktop 230, e2e Electron + lõi thật 86/86.
- CI GitHub: job **Core**, **JS** và **E2E Windows** xanh. E2E Linux và macOS **không còn chặn** (D37); Linux còn hỏng một spec, macOS chưa có kết quả.
- Ký số: token Viettel V6 trên Windows đã **ký thật thành công** (PAdES B-B) và kiểm tra lại đạt; chủ dự án chấp nhận kết quả. T1.08, T3.01–T3.03 đã đóng ✅. Chưa có ảnh Adobe Reader/Foxit (T3.14 🔄).
- Trạng thái 🔄 nghĩa là code đã có nhưng chưa qua cổng nghiệm thu của mốc. Mỗi mốc có một **Demo** trong TASKS.md; đó là tiêu chí nghiệm thu thật.

## Nguyên tắc làm

1. **Windows là nền duy nhất phải xanh** để coi một việc là xong. macOS và Linux: code vẫn giữ được chạy (CI vẫn chạy nhưng không chặn), lỗi riêng của chúng ghi vào danh sách "Sau 1.0" bên dưới, không sửa ngay.
2. **Cắt dọc theo Demo của mốc**, không đóng từng task rời: mỗi bước đi từ lõi đến giao diện đến e2e với lõi thật.
3. **Định nghĩa "xong" cho một task** (đóng 🔄 → ✅): (a) có test lõi hoặc test giao diện cho hành vi chính và lỗi chính; (b) có ít nhất một e2e đường chính với lõi thật; (c) `pnpm typecheck`, `pnpm lint`, `ruff`, `mypy`, test đều xanh trên Windows; (d) quyết định mới ghi vào NOTES.md; (e) cập nhật trạng thái trong TASKS.md.
4. Phần việc cần phần cứng hoặc người thật (token, điện thoại, Adobe Reader) được gom thành **danh sách kiểm thử tay cho chủ dự án**, không chặn phần còn lại.
5. Việc rủi ro cao làm trước: ký số với token thật.
6. Mỗi mảng review xong thì commit riêng; push lên remote chỉ khi chủ dự án cho phép.

## Giai đoạn 0: Nền chất lượng ✅

| Bước | Việc | Kết quả |
|---|---|---|
| 0.1 ✅ | `ruff format` sạch | Đạt |
| 0.2 ✅ | Sửa race mở file lúc khởi động | Đạt, có unit test |
| 0.3 ✅ | E2E chạy cả bộ ổn định trên Windows | 86/86 |
| 0.4 ✅ | Push và CI | Core, JS, E2E Windows xanh. Linux/macOS: xem "Sau 1.0" |

## Giai đoạn 1: Ký số với token Viettel (★, mốc v0.3), tạm xong; còn các bước 1.4–1.7

Tiêu chí mốc (Demo v0.3): cắm token thật, chẩn đoán xanh, tạo mẫu chữ ký có ảnh tách nền, ký theo chữ mốc cho 10 file, Adobe Reader báo chữ ký hợp lệ.

| Bước | Việc | Task | Trạng thái |
|---|---|---|---|
| 1.1 ✅ | Dò token thật: driver `viettel-ca_v6.dll`, 2 chứng thư, cờ PIN bình thường | T1.08, T3.01, T3.02 | Đạt; ghi ở TOKENS.md |
| 1.2 ✅ | Chẩn đoán từng bước trên token thật | T3.03 | Đạt 7/7 bước (bước ký thử cần PIN) |
| 1.3 ✅ | Ký thật bằng token qua lõi, kiểm tra lại | T3.06 | Đạt; sửa 2 lỗi kiểm tra (khóa 1024 bit, CRL dạng PEM) |
| 1.4 🔄 | Chủ dự án xem kết quả ký và chấp nhận (2026-11-03). **Còn lại, làm sau:** ảnh chụp Adobe Reader/Foxit; đối chiếu dấu vân tay Root CA rồi đưa vào kho đi kèm (`core/chef_core/resources/certs`) | T3.14, I35 | Không chặn các mốc sau |
| 1.5 ⬜ | Ký từ giao diện app (không qua script): chọn token, nhập PIN, mẫu chữ ký, ký hàng loạt 10 file theo chữ mốc | T3.04–T3.13 | Cần token lần nữa |
| 1.6 ⬜ | Ký bằng kho chứng thư Windows (CNG) khi không dùng PKCS#11 | T4.11 (phần Windows) | |
| 1.7 ⬜ | Kiểm tra chữ ký: panel trạng thái, thư viện ảnh chữ ký (đóng T3.08, T3.11) | T3.08, T3.11 | |

**Rủi ro:** driver Viettel V6 tự hiện hộp PIN riêng nếu dùng CSP (TOKENS.md); PIN sai nhiều lần làm khóa token. Cách giảm: chỉ dùng PKCS#11, đọc cờ PIN trước mỗi lần hỏi, không thử PIN tự động quá một lần. **Khóa 1024 bit** của chứng thư Viettel nay được chấp nhận với cảnh báo; nếu Adobe Reader từ chối thì ghi vào TOKENS.md.

## Giai đoạn 2: Đóng các mốc v0.5, v0.6, v0.7

| Mốc | Demo (cổng nghiệm thu) | Task cần đóng |
|---|---|---|
| v0.5 | Soi file, kiểm tra trước khi gửi, nén còn ≤ 2 MB, tách thông minh theo trang trắng, crash giữa chừng vẫn khôi phục | T4.03, T5.01–T5.05, T5.07–T5.11 |
| v0.6 | Gỡ logo chìm mọi trang, tẩy một vùng, che CCCD rồi kiểm chứng không copy ra được chữ bên dưới | T6.03–T6.07 |
| v0.7 | Sửa một câu tiếng Việt trong hợp đồng, thay tên công ty toàn tài liệu, highlight và ghi chú | T7.01, T7.02, T7.04–T7.07 |

Mỗi mốc: (1) viết một e2e theo đúng câu Demo bằng lõi thật; (2) chạy, sửa lỗi; (3) rà từng task theo định nghĩa "xong", đóng ✅ những task đạt, ghi lý do cho task chưa đạt. Cần tập tài liệu thật (hợp đồng, CCCD giả lập, file có watermark) trong `tests/e2e/fixtures`.

**Kiểm tra giữa chặng:** test Windows xanh sau mỗi mốc; chủ dự án dùng thử Demo trên máy thật.

## Giai đoạn 3: Đóng các mốc v0.8 và v0.9

| Mốc | Demo | Task cần đóng | Việc cần người thật |
|---|---|---|---|
| v0.8 | Chụp 20 trang sách bằng điện thoại qua QR, tự dò viền, tách trang đôi, làm phẳng, xóa ngón tay, ra PDF đẹp | T8.01–T8.04, T8.06–T8.11 | **Thử trang chụp trên điện thoại thật** (chưa từng thử); 20 trang sách thật để chỉnh ngưỡng |
| v0.9 | Tạo quy trình "Nộp hồ sơ online", thả 20 file vào thư mục tự động, lấy kết quả đã ký | T9.01–T9.07 (T9.08 hoãn) | Cần giai đoạn 1 xong để có bước ký thật |

Việc còn mở đã biết: nối "Lưu thành bước quy trình" cho các hộp thoại còn lại (T9.03), bám viền tự động và hoàn thiện cắt hàng loạt (T8.06, T8.07).

## Giai đoạn 4: Mốc v0.10, rã tài liệu

Demo: rã một báo cáo 2 cột có bảng thành Word "giữ bố cục" và Markdown. Task: T10.01–T10.07. Việc còn mở đã biết: sửa vùng phi văn bản mà không mất dữ liệu (T10.03), kiểm thử DOCX bằng Word/LibreOffice thật (T10.05, chủ dự án mở thử), tài liệu cũ thiếu tọa độ (đang ước lượng).

## Giai đoạn 5: Cổng bản 1.0 (mốc v1.0, Windows)

| Bước | Task | Tiêu chí nghiệm thu |
|---|---|---|
| 5.1 | T11.02 hiệu năng | File 1000 trang mở và cuộn mượt; file 300 MB không tràn RAM; khởi động ≤ ngưỡng ghi trong BLUEPRINT; có số đo trong NOTES |
| 5.2 | T11.03 giấy phép | Rà toàn bộ thư viện, font, mô hình (có DocAligner, onnxruntime); tạo file NOTICE; không có thư viện AGPL (D7) |
| 5.3 | T11.05 đánh bóng | Phím tắt, điều hướng bằng bàn phím, trạng thái rỗng và lỗi thống nhất |
| 5.4 | T11.04 hướng dẫn | `docs/HUONG_DAN_SU_DUNG.md` khớp tính năng cuối, phần cài đặt chỉ Windows |
| 5.5 | T11.01 kiểm thử **trên Windows** | Bộ cài Windows `.exe` cài và chạy được trên máy sạch; CI Windows xanh liên tục |
| 5.6 | **Dùng hằng ngày một tuần trên Windows** | Không lỗi nghiêm trọng (tiêu chí Demo v1.0); lỗi tìm thấy ghi vào NOTES và sửa |

## Sau 1.0 (để sau, không chặn bản 1.0)

- **E2E Linux:** spec `integration › side-by-side` hỏng trên CI do mở file hai lần với Ctrl+O. Đã sửa ở menu (`registerAccelerator: false`) nhưng chưa có kết quả CI xác nhận; còn các lỗi khác chưa biết vì log chỉ đọc được khi cả lượt CI kết thúc.
- **E2E macOS:** lượt CI xếp hàng rất lâu; lỗi cũ từ v0.1: tìm kiếm không dấu (`page.fill` hết hạn) và khởi động lại lõi sau crash. Python đã giới hạn `<3.15` vì onnxruntime chưa có wheel cho 3.15.
- **Bộ cài và ký trên macOS/Linux:** driver token, PKCS#11 và đường dẫn khác nhau; cần máy hoặc CI thật.
- **Tự cập nhật (T9.08, A10).**
- Xuất Markdown/HTML có ảnh vào tên đã có thư mục ảnh đi kèm vẫn bị từ chối.
- Tách bớt `commands.tsx` và `mockBridge.ts` khi chạm vào.

## Rủi ro và cách giảm

| Rủi ro | Mức | Cách giảm |
|---|---|---|
| Adobe Reader/Foxit không tin chữ ký khóa 1024 bit của Viettel | Trung bình | Bước 1.4; ghi kết quả vào TOKENS.md; hướng dẫn thêm Root CA vào Adobe trong tài liệu |
| 54 task 🔄 không có tiêu chí riêng | Trung bình | Dùng Demo từng mốc làm cổng, ghi lý do cho task chưa đạt |
| E2E không ổn định khi chạy cả bộ | Thấp | Đã đạt 86/86; giữ nguyên tắc chờ tường minh thay vì `waitForTimeout` |
| Chỉ có một máy Windows để thử | Trung bình | CI Windows là bản đối chứng; thử bộ cài trên máy sạch trước khi dùng hằng ngày |

## Câu hỏi còn mở

- Điện thoại dùng thử trang chụp: Android hay iPhone (trình duyệt nào)?
- Ngoài Viettel, 1.0 có cần thử thêm CA khác (VNPT, FPT, Ban Cơ yếu) không? Mặc định: không.
