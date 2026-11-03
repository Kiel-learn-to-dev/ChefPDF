# Chef PDF: Cây tính năng

> **Trạng thái: ĐÃ CHỐT. Phiên bản 1.0 của cây tính năng, ngày 2026-10-31.**
> Đây là bản tổng hợp chuẩn của toàn bộ thảo luận. **Mã tính năng trong file này là mã chính thức**: bước lập kế hoạch, ước lượng và code đều dùng mã này. Các mã ở bản nháp trước không còn dùng, xem lại trong lịch sử git nếu cần.
> Muốn thêm, bớt hoặc đổi phạm vi thì ghi vào mục **"Thay đổi sau khi chốt"** ở cuối file.

## Cách đọc

| Cột "Mức" | Nghĩa |
|---|---|
| **v0.1 … v0.10** | Thuộc phạm vi **bản 1.0**. Số bản là mốc phát triển trong [BLUEPRINT.md](BLUEPRINT.md) mục 13 |
| **Sau 1.0** | Muốn có, nhưng làm sau bản 1.0 |
| **Nâng cấp** | Thuộc **gói nâng cấp nhận dạng** (OCR, mô hình AI chạy trên máy, hoặc API trả phí). Để dành cho phiên bản nâng cấp sau này |
| **Ý tưởng** | Chưa cam kết, xem lại khi lập kế hoạch |

★ = tính năng chủ lực.

## Nguyên tắc sản phẩm

1. **Gọn gàng như ABBYY**: màn hình Start dạng ô nhiệm vụ; một thanh công cụ thay đổi theo ngữ cảnh; mặc định chỉ hiện 3–4 tùy chọn, phần còn lại nằm trong "▸ Nâng cao"; hộp thoại xử lý luôn có xem trước.
2. **Offline hoàn toàn**: không tải tài liệu lên đâu cả. Ngoại lệ duy nhất là những thứ người dùng tự bật: ký từ xa, dấu thời gian TSA, kiểm tra OCSP/CRL, API nhận dạng trả phí.
3. **Chạy trên Windows, macOS, Linux.**
4. **Tiếng Việt là ưu tiên số 1**: giao diện, font, tìm kiếm không dấu, thể thức văn bản hành chính, chữ ký số Việt Nam.
5. **Bản 1.0 không có OCR và không có AI.** Phần đó nằm trong gói nâng cấp (nhóm Q). **Ngoại lệ duy nhất:** mô hình dò viền trang loại nhỏ (L20), chạy offline, đi kèm bản cài.

## Sơ đồ tổng quan

```
Chef PDF
│
├── 1. NỀN TẢNG
│   ├── A  Khung ứng dụng
│   └── B  Xem & điều hướng
│
├── 2. TRANG
│   └── C  Sắp xếp trang
│
├── 3. NỘI DUNG
│   ├── D  Chỉnh sửa chữ & đối tượng
│   ├── E  Lớp & gỡ watermark
│   ├── F  Watermark, con dấu & đánh số
│   ├── G  Ghi chú
│   └── H  Form
│
├── 4. KÝ SỐ & BẢO MẬT
│   ├── I  ★ Ký số
│   │   ├── I-A Chứng thư & USB token
│   │   ├── I-B Studio mẫu chữ ký
│   │   ├── I-C Ảnh chữ ký & con dấu
│   │   ├── I-D Đặt chữ ký & ký
│   │   └── I-E Kiểm tra chữ ký
│   └── J  Bảo mật
│
├── 5. XUẤT & CHUYỂN ĐỔI
│   ├── K  ★ Chuyển thành bản scan
│   ├── L  Làm đẹp bản scan & chụp tài liệu
│   ├── M  Tối ưu, chuyển đổi & sửa lỗi
│   └── N  Rã tài liệu & tái tạo định dạng
│
├── 6. TỰ ĐỘNG & SO SÁNH
│   ├── O  ★ Quy trình & xử lý hàng loạt
│   └── P  So sánh tài liệu
│
└── 7. GÓI NÂNG CẤP
    └── Q  Nhận dạng (OCR & AI)
```

**Bố trí trên giao diện:** màn hình **Start** · tab **Xem** (B) · **Trang** (C) · **Chỉnh sửa** (D, E, F) · **Ghi chú** (G) · **Form** (H) · **Ký & Bảo mật** (I, J) · **Xuất** (K, L, M, N) · **Quy trình** (O). So sánh tài liệu (P) mở từ màn hình Start.

## Thứ tự làm

Đã chốt khi lập kế hoạch (2026-10-31). Chi tiết ở [BLUEPRINT.md](BLUEPRINT.md) mục 13 và [TASKS.md](TASKS.md).

| Bản | Trọng tâm |
|---|---|
| v0.1 | Nền móng, bộ cài 3 OS, xem PDF, sắp xếp trang |
| v0.2 | ★ Chuyển thành bản scan |
| v0.3 | ★ Ký số: token, Studio mẫu chữ ký, ảnh chữ ký & con dấu, kiểm tra chữ ký |
| v0.4 | Đóng dấu & đánh số: thêm chữ/ảnh, watermark, con dấu, giáp lai, số trang, header/footer, ký kèm đóng dấu |
| v0.5 | Bảo mật, tối ưu & chuyển đổi; công cụ trang mở rộng; khôi phục khi crash |
| v0.6 | Bộ máy nội dung: chọn/xóa đối tượng, tẩy vùng, lớp, gỡ watermark, che thông tin mật |
| v0.7 | Sửa chữ có sẵn, tìm & thay thế, liên kết; ghi chú |
| v0.8 | Ảnh scan & chụp sách: trình sửa ảnh, dò viền & cắt, tách trang đôi, làm phẳng, xóa ngón tay, chụp bằng điện thoại |
| v0.9 | Form; quy trình tự động |
| v0.10 | Rã PDF có chữ và tái tạo định dạng |
| **1.0** | Ổn định & hoàn thiện |

---|---|
| v0.1 | Khung app, bộ cài 3 OS, xem PDF, sắp xếp trang |
| v0.2 | ★ Chuyển thành bản scan |
| v0.3 | ★ Ký số: token, Studio mẫu chữ ký, ảnh chữ ký & con dấu, kiểm tra chữ ký |
| v0.4 | Watermark, con dấu, giáp lai, số trang, header/footer; bảo mật; nén & chuyển đổi; các công cụ trang mở rộng |
| v0.5 | Bộ máy nội dung: chọn/xóa đối tượng, tẩy vùng, lớp, gỡ watermark, che thông tin mật |
| v0.6 | Sửa chữ có sẵn, tìm & thay thế, liên kết; ghi chú |
| v0.7 | Form, làm đẹp bản scan, chụp bằng điện thoại, quy trình tự động, tự cập nhật |
| v0.8 | Rã PDF có chữ và tái tạo định dạng |
| **1.0** | Hoàn thiện, ổn định |

---

# 1. NỀN TẢNG

## A. Khung ứng dụng

| Mã | Tính năng | Mô tả | Mức |
|---|---|---|---|
| A1 | Màn hình Start | Ô nhiệm vụ (Mở PDF, Ghép file, Chuyển thành bản scan, Ký số, Đóng dấu, Nén…), các quy trình đã lưu, file gần đây, kéo thả file vào | v0.1 |
| A2 | Tab nhiều tài liệu | Mở nhiều file cùng lúc, kéo tab ra cửa sổ riêng | v0.1 |
| A3 | Bảng lệnh `Ctrl+K` | Gõ tên tính năng để chạy, tìm được cả khi gõ không dấu ("ky so" ra "Ký số") | v0.1 |
| A4 | Cài đặt | Ngôn ngữ Việt/Anh; giao diện sáng/tối/theo hệ thống; thư mục lưu mặc định; preset mặc định | v0.1 |
| A5 | Mở file từ hệ điều hành | "Open with", đặt làm app PDF mặc định | v0.1 |
| A6 | Hoàn tác / Làm lại | `Ctrl+Z` / `Ctrl+Y` | v0.1 |
| A7 | In | Hộp thoại in của hệ điều hành, chọn trang | v0.1 |
| A8 | Bộ cài 3 hệ điều hành | Windows (`.exe`/`.msi`), macOS (`.dmg` cho Intel và Apple Silicon), Linux (`.AppImage`/`.deb`/`.rpm`), build tự động bằng GitHub Actions | v0.1 |
| A9 | Khôi phục khi crash | Tự lưu nháp, mở lại file đang làm dở | v0.5 |
| A10 | Tự cập nhật | Kiểm tra và cài bản mới | Sau 1.0 |
| A11 | Phím tắt tùy chỉnh | | Ý tưởng |
| A12 | Bản portable | Chạy từ USB, không cần cài đặt | Ý tưởng |
| A13 | Hệ thống plugin | Cho phép bên thứ ba viết thêm tính năng | Ý tưởng |
| A14 | Bản web rút gọn | Dùng lại giao diện React, không có ký số | Ý tưởng |

## B. Xem & điều hướng

| Mã | Tính năng | Mô tả | Mức |
|---|---|---|---|
| B1 | Hiển thị trang | Zoom (vừa chiều rộng, vừa trang, %), xoay khung nhìn | v0.1 |
| B2 | Chế độ xem | Một trang, cuộn liên tục, hai trang, kiểu sách, toàn màn hình / trình chiếu | v0.1 |
| B3 | Thanh bên | Thumbnail, mục lục; các tab lớp, file đính kèm, ghi chú, chữ ký xuất hiện theo tính năng tương ứng | v0.1 |
| B4 | Tìm kiếm | `Ctrl+F`, tô sáng kết quả. **Tìm không dấu**: gõ "nghi dinh" ra "nghị định" | v0.1 |
| B5 | Chọn & copy | Copy chữ; chụp một vùng thành ảnh | v0.1 |
| B6 | Mở file có mật khẩu | Hỏi mật khẩu khi mở | v0.1 |
| B7 | Thuộc tính tài liệu | Xem metadata, khổ giấy, font, phiên bản PDF, số trang, dung lượng | v0.1 |
| B8 | Xem song song | Chia đôi màn hình xem 2 file hoặc 2 vị trí của cùng một file | v0.5 |
| B9 | Chế độ đọc ban đêm | Đảo màu trang | v0.5 |
| B10 | Đọc to | Đọc chữ bằng giọng đọc có sẵn của hệ điều hành | Ý tưởng |

---

# 2. TRANG

## C. Sắp xếp trang

| Mã | Tính năng | Mô tả | Mức |
|---|---|---|---|
| C1 | Lưới thumbnail | Kéo thả đổi thứ tự, chọn nhiều trang (Shift/Ctrl) | v0.1 |
| C2 | Thao tác trang | Xoay, xóa, nhân bản, trích trang ra file mới | v0.1 |
| C3 | Chèn trang | Trang trắng, trang từ file khác, từ ảnh, từ clipboard | v0.1 |
| C4 | Ghép file | Nhiều file thành 1, sắp thứ tự, tùy chọn tạo bookmark theo tên file | v0.1 |
| C5 | Tách file | Theo khoảng trang, mỗi N trang, theo bookmark, theo dung lượng, trang chẵn/lẻ | v0.1 |
| C6 | Thay thế trang | Thay trang X bằng trang từ file khác | v0.5 |
| C7 | Cắt lề / đổi khổ | Cắt lề trắng (tự dò), đưa về A4/Letter, co giãn nội dung. Áp cho trang PDF thường bằng cách đặt lại khung trang (CropBox), không mất nội dung. Cắt ảnh scan thật sự thì dùng L15–L19 | v0.5 |
| C8 | Xóa trang trắng | Tự tìm trang trắng (hay gặp khi scan 2 mặt), xem trước rồi mới xóa | v0.5 |
| C9 | Chia đôi trang | Trang A3 / trang đôi thành 2 trang A4; hoặc cắt trang thành lưới N phần | v0.5 |
| C10 | Tách thông minh | Tách file mỗi khi gặp trang có tiêu đề mới, mã QR phân cách, hoặc trang trắng phân cách | v0.5 |
| C11 | In ghép trang | N-up (2/4 trang trên 1 tờ), in kiểu sổ tay (booklet) | Ý tưởng |
| C12 | Trang dài | Ghép nhiều trang thành 1 trang dài và ngược lại | Ý tưởng |

---

# 3. NỘI DUNG

## D. Chỉnh sửa chữ & đối tượng

| Mã | Tính năng | Mô tả | Mức |
|---|---|---|---|
| D1 | Thêm chữ | Hộp chữ mới, hỗ trợ đầy đủ tiếng Việt (nhúng font Unicode) | v0.4 |
| D2 | Thêm ảnh | Logo, ảnh, kéo thả lên trang | v0.4 |
| D3 | Sửa mục lục | Thêm/sửa/xóa/sắp xếp bookmark | v0.4 |
| D4 | Chọn & sửa đối tượng | Click chọn chữ, ảnh, hình vẽ có sẵn; di chuyển, đổi kích thước, xoay, xóa, đưa lên trên / xuống dưới | v0.6 |
| D5 | Tẩy vùng | Quét chọn vùng rồi xóa toàn bộ nội dung bên trong, không để lại ô đen (khác với che thông tin mật J6) | v0.6 |
| D6 | Thay ảnh | Thay một ảnh trong PDF bằng ảnh khác, giữ vị trí và kích thước | v0.6 |
| D7 | Chỉnh ảnh trong PDF | Cắt, xoay, lật, xóa nền, chỉnh sáng/tương phản ngay trong PDF | v0.6 |
| D8 | **Sửa chữ có sẵn: mức dòng** | Click vào dòng chữ để sửa. Dùng lại font gốc nếu còn đủ ký tự; thiếu (hay gặp với tiếng Việt) thì tự thay bằng font gần giống | v0.7 |
| D9 | **Sửa chữ có sẵn: mức đoạn** | Gom các dòng thành đoạn, sửa và tự xuống dòng lại, đổi font/cỡ/màu/căn lề | v0.7 |
| D10 | Tìm & thay thế chữ | Thay một cụm từ trên toàn tài liệu | v0.7 |
| D11 | Liên kết | Thêm/sửa/xóa link (trang nội bộ, web, email) | v0.7 |
| D12 | Tự tạo mục lục | Dò các dòng tiêu đề (cỡ chữ lớn, in đậm) để tạo bookmark | v0.10 |

## E. Lớp & gỡ watermark

| Mã | Tính năng | Mô tả | Mức |
|---|---|---|---|
| E1 | Bảng lớp (Layers) | Hiện các lớp nội dung có trong file; bật/tắt, đổi tên, xóa, làm phẳng lớp | v0.6 |
| E2 | Xem theo loại nội dung | Bật/tắt riêng chữ, ảnh, hình vẽ, ghi chú, nền | v0.6 |
| E3 | Gỡ watermark tự động | App dò ứng viên (watermark gắn nhãn chuẩn, lớp tên "watermark", ghi chú kiểu watermark, đối tượng lặp ở cùng vị trí trên nhiều trang, đối tượng xoay chéo hoặc trong suốt), hiện danh sách kèm xem trước để người dùng tích chọn. **Không tự xóa** | v0.6 |
| E4 | Gỡ "đối tượng giống thế này" | Chọn một đối tượng (ví dụ logo chìm), gỡ nó trên mọi trang | v0.6 |
| E5 | Gỡ / đổi nền trang | Xóa màu nền hoặc ảnh nền; đặt nền mới | v0.6 |
| E6 | Tách lớp ra file | Xuất riêng phần chữ, phần ảnh hoặc từng lớp ra file | Ý tưởng |

Gỡ watermark đã dính vào ảnh scan nằm ở Q8 (gói nâng cấp).

## F. Watermark, con dấu & đánh số

| Mã | Tính năng | Mô tả | Mức |
|---|---|---|---|
| F1 | Thêm watermark | Chữ hoặc ảnh; độ mờ, góc xoay, cỡ; nằm trên/dưới nội dung; chọn trang. **Gắn nhãn chuẩn** để sau này gỡ sạch được | v0.4 |
| F2 | Con dấu chữ | ĐÃ DUYỆT, MẬT, KHẨN, BẢN SAO, ĐÃ NHẬN…; thư viện dấu tự tạo | v0.4 |
| F3 | Con dấu ảnh | Ảnh con dấu, kéo thả, đổi cỡ, xoay. Lấy ảnh từ thư viện I-C | v0.4 |
| F4 | **Dấu giáp lai** | Một dấu cắt đều qua mép phải của nhiều trang, đúng kiểu văn bản hành chính Việt Nam. Chọn trang, vị trí dọc, số phần cắt | v0.4 |
| F5 | Con dấu động | Tự điền ngày giờ và tên người, ví dụ "ĐÃ NHẬN – 14:30 31/10/2026 – Nguyễn A" | v0.4 |
| F6 | Chữ ký nháy | Đóng ảnh chữ ký tắt lên góc mọi trang hoặc các trang chọn | v0.4 |
| F7 | Header / Footer | Chữ hoặc ảnh ở đầu/chân trang, trái/giữa/phải; biến `{ngay}` `{tenfile}` `{trang}` `{tongtrang}` | v0.4 |
| F8 | Đánh số trang | Nhiều kiểu ("1", "Trang 1/10", "- 1 -", số La Mã), chọn vị trí, bỏ trang đầu, bắt đầu từ số bất kỳ. **Preset theo Nghị định 30/2020/NĐ-CP** (giữa lề trên, không đánh số trang đầu) | v0.4 |
| F9 | Đánh số Bates | Mã tài liệu liên tục qua nhiều file (HS-000001…) | v0.4 |
| F10 | Mã QR / mã vạch | Chèn QR hoặc mã vạch (link, mã hồ sơ, số văn bản…); dùng được trong đánh số Bates | v0.4 |
| F11 | Chồng lên giấy tiêu đề | Đặt nội dung lên mẫu giấy tiêu đề công ty (một file PDF khác); áp cho trang đầu hoặc mọi trang | v0.4 |
| F12 | Quản lý & gỡ | Sửa hoặc gỡ watermark / header / footer / số trang mà Chef PDF đã thêm | v0.4 |

## G. Ghi chú

| Mã | Tính năng | Mô tả | Mức |
|---|---|---|---|
| G1 | Đánh dấu chữ | Highlight, gạch chân, gạch ngang | v0.7 |
| G2 | Ghi chú | Note dán, hộp chữ bình luận | v0.7 |
| G3 | Vẽ | Bút vẽ tay, đường thẳng, mũi tên, hình chữ nhật, elip | v0.7 |
| G4 | Danh sách ghi chú | Lọc theo loại/người, trả lời, đánh dấu đã xử lý, xuất bản tổng hợp | v0.7 |
| G5 | Làm phẳng ghi chú | Biến ghi chú thành nội dung cố định | v0.7 |

## H. Form

| Mã | Tính năng | Mô tả | Mức |
|---|---|---|---|
| H1 | Điền form | Điền form có sẵn, lưu lại | v0.9 |
| H2 | Tạo form | Ô chữ, checkbox, radio, dropdown, ô chữ ký | v0.9 |
| H3 | Làm phẳng form | | v0.9 |
| H4 | Điền hàng loạt | Một mẫu form × N dòng dữ liệu Excel/CSV thành N file | Ý tưởng |

---

# 4. KÝ SỐ & BẢO MẬT

## I. ★ Ký số

### I-A. Chứng thư & USB token

Chi tiết tra cứu ở [TOKENS.md](TOKENS.md).

| Mã | Tính năng | Mô tả | Mức |
|---|---|---|---|
| I1 | USB token | Giao tiếp qua PKCS#11; chọn chứng thư nếu token có nhiều. Hỗ trợ **cả CA công cộng** (Viettel-CA, VNPT-CA, FPT-CA, MISA-CA, Bkav-CA, CA2, EFY-CA, NewTel-CA, SAFE-CA, SmartSign, TrustCA, FastCA, CMC-CA…) **và CA chuyên dùng Chính phủ** (Ban Cơ yếu) | v0.3 |
| I2 | File chứng thư | `.pfx` / `.p12`; tùy chọn ghi nhớ, mật khẩu lưu trong kho bảo mật của hệ điều hành | v0.3 |
| I3 | Thông tin chứng thư | Chủ sở hữu, đơn vị cấp, hạn dùng, MST/CCCD; **nhắc trước khi hết hạn** | v0.3 |
| I4 | Danh bạ driver token | File dữ liệu: CA → đời token → hệ điều hành → đường dẫn thư viện PKCS#11. Cập nhật được mà không cần ra bản app mới | v0.3 |
| I5 | Tự dò & quét driver | Cắm token là app dò theo danh bạ. Không thấy thì nút "Quét tìm driver" thử nạp các thư viện trong thư mục hệ thống. Vẫn cho chọn file thủ công | v0.3 |
| I6 | **Chẩn đoán token** | Kiểm tra từng bước: thấy token → nạp driver → có chứng thư → còn hạn → tin cậy. Mỗi lỗi kèm hướng dẫn tiếng Việt và link tải driver của đúng CA | v0.3 |
| I7 | Cảnh báo PIN | Báo khi token sắp bị khóa vì nhập sai PIN; không bao giờ tự thử lại PIN sai | v0.3 |
| I8 | Kho chứng thư hệ điều hành | Windows Certificate Store, macOS Keychain. Đường dự phòng cho token chỉ có driver CSP | v0.4 |
| I9 | Ký từ xa qua cloud | VNPT SmartCA, Viettel MySign, MISA eSign… (mỗi bên một API riêng) | Sau 1.0 |

### I-B. Studio mẫu chữ ký

Tham khảo "Configure Signature Style" của Foxit, cộng thêm nhu cầu riêng ở Việt Nam. Xem trước trực tiếp khi chỉnh.

| Mã | Tính năng | Mô tả | Mức |
|---|---|---|---|
| I10 | Quản lý mẫu | Tạo / sửa / nhân bản / xóa; mẫu mặc định; **gắn mẫu với từng chứng thư**; xuất/nhập mẫu ra file | v0.3 |
| I11 | Thông tin hiển thị | Tích chọn từng dòng: Người ký, Đơn vị, Chức vụ, Email, MST/CCCD, Ngày ký, Lý do, Nơi ký, Liên hệ, DN, dòng tùy ý. Bật/tắt và sửa chữ của nhãn ("Ký bởi:", "Ngày ký:"…) | v0.3 |
| I12 | Nguồn dữ liệu | Mặc định tự lấy từ chứng thư. Cho ghi đè chữ hiển thị, nhưng panel kiểm tra (I34) luôn hiện thông tin thật | v0.3 |
| I13 | Định dạng ngày giờ | `dd/MM/yyyy HH:mm:ss`, "Ngày 31 tháng 10 năm 2026", có/không múi giờ; giờ máy hay giờ TSA | v0.3 |
| I14 | Lý do & nơi ký | Danh sách lý do có sẵn, tự nhớ lý do đã nhập; nơi ký mặc định | v0.3 |
| I15 | Bố cục | Ảnh trái + chữ phải / ảnh trên + chữ dưới / chỉ ảnh / chỉ chữ / ảnh mờ làm nền / chữ ký + con dấu chồng nhau; chỉnh tỉ lệ, lề, căn lề | v0.3 |
| I16 | Kiểu chữ & màu | Font tiếng Việt đóng gói sẵn, cỡ chữ (hoặc tự co vừa khung), màu, đậm/nghiêng, viền, nền trong suốt | v0.3 |
| I17 | Biểu tượng hợp lệ | Dấu ✓ kiểu "Signature Valid" thường thấy trên hóa đơn điện tử | v0.3 |
| I18 | Logo | Logo công ty bên cạnh hoặc làm nền mờ | v0.3 |

### I-C. Ảnh chữ ký & con dấu

Thư viện **dùng chung** cho ký số (I-B), con dấu ảnh (F3), dấu giáp lai (F4), chữ ký nháy (F6).

| Mã | Tính năng | Mô tả | Mức |
|---|---|---|---|
| I19 | Tạo ảnh chữ ký | Nhập ảnh; vẽ bằng chuột / bút cảm ứng / bảng vẽ; gõ tên với font viết tay; chụp bằng điện thoại qua QR (dùng L5) | v0.3 |
| I20 | **Tách nền tự động** | Bỏ nền giấy (trắng, ngả vàng, bóng đổ khi chụp), giữ nét mực trong suốt; chỉnh độ nhạy; xem trước trên nền caro; tự nhận màu mực | v0.3 |
| I21 | Làm sạch & chỉnh | Cắt sát nét mực, xoay, xóa chấm bẩn, đổi màu mực, làm đậm/mảnh nét, chỉnh độ mờ | v0.3 |
| I22 | Tách chữ ký & con dấu theo màu | Ảnh có chữ ký xanh đè lên con dấu đỏ → tách thành 2 ảnh riêng | v0.4 |
| I23 | Bảo vệ thư viện | Mã hóa ảnh khi lưu; tùy chọn hỏi mật khẩu / Windows Hello / Touch ID trước khi dùng | v0.3 |
| I24 | Chuyển thành vector | Ảnh chữ ký/dấu thành nét vector, phóng to vẫn nét | Ý tưởng |

### I-D. Đặt chữ ký & ký

| Mã | Tính năng | Mô tả | Mức |
|---|---|---|---|
| I25 | Đặt chữ ký | Kéo thả khung ký; ký ẩn; hoặc ký vào ô ký có sẵn | v0.3 |
| I26 | **Đặt theo chữ mốc** | Tìm cụm chữ ("NGƯỜI KÝ", "GIÁM ĐỐC"…) rồi đặt chữ ký ngay dưới/cạnh nó | v0.3 |
| I27 | Vị trí cố định | Góc phải trang cuối, trang đầu, mọi trang, trang chỉ định; lưu thành preset | v0.3 |
| I28 | Tùy chọn kỹ thuật | PAdES B-B / B-T / B-LT / B-LTA; máy chủ TSA (danh sách TSA Việt Nam, có dự phòng); SHA-256 | v0.3 |
| I29 | Ký chứng nhận (certify) | Khóa tài liệu, chọn mức quyền được phép sau khi ký | v0.3 |
| I30 | Nhiều người ký | Ký nối tiếp không phá chữ ký trước; tạo ô ký trống cho người khác | v0.3 |
| I31 | Ký hàng loạt | Nhiều file, nhập PIN 1 lần, kết hợp I26 / I27 | v0.3 |
| I32 | Sau khi ký | Tự đặt tên file (`_da-ky`), mở panel kiểm tra, mở thư mục chứa file | v0.3 |
| I33 | Ký kèm đóng dấu | Một lần bấm: ký số + dấu giáp lai (F4) + chữ ký nháy mọi trang (F6) | v0.4 |

### I-E. Kiểm tra chữ ký

| Mã | Tính năng | Mô tả | Mức |
|---|---|---|---|
| I34 | Kiểm tra chữ ký | Panel ✅ hợp lệ / ⚠️ đã bị sửa / ❌ không tin cậy; chuỗi chứng thư; OCSP/CRL; xem phiên bản tài liệu lúc ký | v0.3 |
| I35 | Kho tin cậy | Nạp sẵn **2 hệ Root CA Việt Nam**: Root CA quốc gia (NEAC) và Root CA chuyên dùng Chính phủ (Ban Cơ yếu); thêm/xóa chứng thư tin cậy | v0.3 |
| I36 | Kiểm tra hàng loạt | Kiểm tra cả thư mục, xuất bảng kết quả ra Excel/CSV | v0.4 |
| I37 | Báo cáo chữ ký | Xuất kết quả kiểm tra ra PDF | Ý tưởng |

## J. Bảo mật

| Mã | Tính năng | Mô tả | Mức |
|---|---|---|---|
| J1 | Đặt mật khẩu | Mật khẩu mở file; giới hạn quyền in/copy/sửa; AES-256 | v0.5 |
| J2 | Gỡ mật khẩu | Khi đã biết mật khẩu | v0.5 |
| J3 | Gỡ dữ liệu ẩn | Xóa metadata, JavaScript, file đính kèm, lớp ẩn, ghi chú, lịch sử sửa | v0.5 |
| J4 | Soi file | Báo cáo file chứa gì: JavaScript, link ra ngoài, file đính kèm, form, chữ ký, font chưa nhúng, lớp ẩn | v0.5 |
| J5 | **Kiểm tra trước khi gửi** | Một nút chạy checklist: metadata, ghi chú còn sót, form chưa làm phẳng, dung lượng vượt giới hạn (5/10/25MB), chữ ký còn hợp lệ. Bấm để sửa từng mục | v0.5 |
| J6 | Che thông tin mật | Chọn vùng hoặc chữ; tìm và che hàng loạt (CCCD, số điện thoại, email, số tài khoản); **xóa hẳn nội dung bên dưới** | v0.6 |

---

# 5. XUẤT & CHUYỂN ĐỔI

## K. ★ Chuyển thành bản scan (PDF chỉ có ảnh)

| Mã | Tính năng | Mô tả | Mức |
|---|---|---|---|
| K1 | Độ phân giải | Preset 150 / 200 / 300 / 600 dpi và tùy chỉnh | v0.2 |
| K2 | Chế độ màu | Màu / Xám / Đen trắng 1-bit (chỉnh ngưỡng, tùy chọn dithering) | v0.2 |
| K3 | Nén | JPEG (chỉnh chất lượng), không mất dữ liệu (Flate), CCITT G4 cho đen trắng | v0.2 |
| K4 | Hiệu ứng scan thật | Nghiêng nhẹ, hạt nhiễu, ám màu giấy, bóng mép giấy, mờ nhẹ, lệch tương phản; ngẫu nhiên khác nhau từng trang | v0.2 |
| K5 | Xem trước | So sánh gốc và kết quả (chia đôi / thanh trượt); zoom 100% | v0.2 |
| K6 | Ước tính dung lượng | Cập nhật ngay khi đổi thiết lập | v0.2 |
| K7 | Phạm vi & tùy chọn | Chọn trang, giữ khổ giấy, xóa metadata | v0.2 |
| K8 | Preset | Có sẵn (Nhẹ / Chuẩn / Nét / Văn bản hành chính) và tự tạo | v0.2 |
| K9 | Cảnh báo | Báo trước sẽ mất chữ, link, form, chữ ký số | v0.2 |
| K10 | Giới hạn dung lượng | "Nén sao cho file ≤ 5MB": tự dò DPI/chất lượng phù hợp | v0.2 |

## L. Làm đẹp bản scan & chụp tài liệu

| Mã | Tính năng | Mô tả | Mức |
|---|---|---|---|
| L1 | Chỉnh nghiêng | Tự dò và xoay thẳng trang | v0.8 |
| L2 | Cắt & nắn | Cắt viền thừa; nắn trang chụp xiên thành hình chữ nhật. Chi tiết ở L15–L19 | v0.8 |
| L3 | Làm trắng nền | Nền giấy ngả vàng/xám thành trắng, chữ rõ hơn | v0.8 |
| L4 | Khử nhiễu, chỉnh sáng | Xóa chấm bẩn; chỉnh sáng, tương phản | v0.8 |
| L5 | **Chụp tài liệu bằng điện thoại** | App hiện mã QR, điện thoại quét mã (cùng Wi-Fi, không qua internet), chụp xong ảnh về thẳng máy tính, tự cắt và nắn (L2). Không cần cài app trên điện thoại | v0.8 |
| L6 | **Tách trang đôi** | Ảnh chụp 2 trang sách mở thành 2 trang riêng: tự dò đường gáy sách (vùng tối/cong giữa 2 trang), cho chỉnh tay đường cắt; thứ tự trang trái → phải. Là một bước của quy trình **chụp sách** | v0.8 |
| L7 | Tách nhiều ảnh trên một bản scan | Nhiều hóa đơn / thẻ trên một mặt kính thành từng ảnh riêng | Ý tưởng |
| L8 | Quét từ máy scan | TWAIN/WIA (Windows), ICA (macOS), SANE (Linux) | Ý tưởng |
| L9 | **Trình sửa ảnh trang** | Chế độ sửa ảnh riêng cho trang scan / trang ảnh, giống công cụ sửa ảnh trong OCR Editor của ABBYY. Sửa **không phá hủy**: luôn giữ ảnh gốc, có lịch sử thao tác, hoàn nguyên được. Áp dụng cho trang hiện tại, các trang chọn hoặc mọi trang. Gom các công cụ L1–L4, L10–L14 vào một chỗ | v0.8 |
| L10 | Tẩy & tô | Cọ tẩy, chọn vùng chữ nhật hoặc vẽ tự do; tô bằng **màu nền giấy tự dò** (có thêm hạt giấy để vùng tô không bị lộ) hoặc màu tự chọn | v0.8 |
| L11 | Xóa vết màu | Xóa nét bút bi, bút dạ quang, con dấu theo màu; chọn màu bằng ống hút (dùng chung công cụ tách màu với I22) | v0.8 |
| L12 | Chỉnh mức sáng & độ phân giải | Levels/Curves, đảo màu (âm bản), đổi độ phân giải ảnh (giảm hoặc tăng DPI) | v0.8 |
| L13 | Làm phẳng trang cong (cơ bản) | Nắn trang sách bị cong ở gáy bằng cách dò các dòng chữ rồi kéo cho thẳng. Hợp với trang cong nhẹ; trang cong mạnh để Q12 | v0.8 |
| L14 | **Xóa ngón tay (bán tự động)** | Dò vùng màu da chạm mép trang (ngón tay giữ giấy khi chụp), đề xuất vùng xóa; người dùng chỉnh lại bằng cọ, xong tô bằng màu nền giấy. Không khôi phục được chữ nằm dưới ngón tay | v0.8 |
| L15 | **Tự dò viền trang & tự cắt** | Hai trường hợp. **Bản scan máy:** cắt viền đen/xám của nắp máy scan và bóng mép giấy. **Ảnh chụp điện thoại:** tìm 4 góc tờ giấy (dò cạnh → tìm đường thẳng → chấm điểm các tứ giác theo độ tương phản trong/ngoài), rồi nắn phối cảnh thành hình chữ nhật. Mỗi trang có **điểm tin cậy** | v0.8 |
| L16 | Cắt thủ công: khung chữ nhật | Kéo 8 tay nắm; **kính lúp** phóng to góc khi kéo; tỉ lệ có sẵn (A4, A5, Letter, CCCD, tự do, giữ tỉ lệ khổ giấy); nhập số đo bằng mm; khung tự hít vào viền đã dò | v0.8 |
| L17 | Cắt thủ công: kéo 4 góc | Kéo từng góc độc lập cho trang chụp xiên, xem trước kết quả nắn phối cảnh ngay; kết hợp xoay tinh (±0,1°) | v0.8 |
| L18 | Cắt hàng loạt & duyệt nhanh | Tự dò viền mọi trang, hiện lưới thumbnail có khung viền đè lên; **trang dò kém được đánh dấu** để chỉ phải sửa tay vài trang. Hoặc dùng một khung cắt cho mọi trang, riêng trang chẵn/lẻ (khi chụp sách) | v0.8 |
| L19 | Tự nhận khổ giấy | Sau khi cắt, đoán khổ theo tỉ lệ cạnh (A4, A5, Letter, CCCD…) và đặt đúng kích thước trang PDF; hoặc giữ nguyên kích thước thật | v0.8 |
| L20 | **Dò viền trang bằng mô hình nhẹ** | Mô hình dò 4 góc tờ giấy loại nhỏ (vài MB, chạy ONNX trên CPU, ứng viên: DocAligner), **đi kèm bản cài**. Xử lý các trường hợp thuật toán L15 hay sai: giấy trắng trên bàn trắng, nền lộn xộn, góc bị ngón tay che, ánh sáng xấu. App chạy cả hai cách và chọn kết quả có điểm tin cậy cao hơn. **Ngoại lệ** của nguyên tắc "1.0 không có AI" | v0.8 |

## M. Tối ưu, chuyển đổi & sửa lỗi

| Mã | Tính năng | Mô tả | Mức |
|---|---|---|---|
| M1 | Nén PDF | Preset (màn hình / email / in ấn), giảm độ phân giải ảnh, bỏ đối tượng thừa, rút gọn font | v0.5 |
| M2 | PDF → ảnh | PNG / JPG / TIFF (TIFF nhiều trang), chọn DPI | v0.5 |
| M3 | Ảnh → PDF | Nhiều ảnh, sắp thứ tự, khổ giấy, lề, tự xoay theo EXIF | v0.5 |
| M4 | Ảnh chụp màn hình → PDF | Dán từ clipboard hoặc chụp màn hình trực tiếp | v0.5 |
| M5 | Web / Markdown / HTML → PDF | Dán link trang web hoặc mở file Markdown/HTML để xuất PDF | v0.5 |
| M6 | Chuyển đổi màu | Thang xám / đen trắng (vẫn giữ chữ, khác K2); tiết kiệm mực in; thay màu | v0.5 |
| M7 | Trích xuất | Lấy toàn bộ ảnh gốc; lấy text ra `.txt` | v0.5 |
| M8 | File đính kèm | Xem, thêm, xóa, lưu ra các file nhúng trong PDF | v0.5 |
| M9 | Sửa metadata | Tiêu đề, tác giả, chủ đề, từ khóa | v0.5 |
| M10 | Tối ưu cho web | Linearize: mở trang đầu nhanh khi xem qua mạng | v0.5 |
| M11 | Sửa file PDF hỏng | Thử khôi phục file lỗi, không mở được | v0.5 |
| M12 | PDF/A để lưu trữ | Không dùng Ghostscript (vì giấy phép) | Sau 1.0 |
| M13 | Office → PDF | Qua LibreOffice nếu máy có cài | Ý tưởng |
| M14 | Máy in ảo "Chef PDF" | In từ app bất kỳ ra PDF | Ý tưởng |
| M15 | Xuất ảnh cho mạng xã hội | Ảnh vừa khổ Zalo / Facebook, ghép nhiều trang thành 1 ảnh dài | Ý tưởng |
| M16 | Tạo PDF từ mẫu | Hóa đơn, thư, văn bản theo mẫu | Ý tưởng |
| M17 | PDF cho người khiếm thị | Tagged PDF / PDF/UA | Ý tưởng |

## N. Rã tài liệu & tái tạo định dạng

Áp dụng cho **PDF có chữ**, không cần OCR. Rã PDF thành **mô hình tài liệu** (khối, vị trí, kiểu chữ) rồi xuất ra nhiều định dạng. Markdown chỉ là **một trong các định dạng xuất**, không dùng làm định dạng trung gian vì nó làm mất bố cục. Với PDF scan, gói nâng cấp Q sẽ OCR trước rồi đưa kết quả vào cùng quy trình này.

| Mã | Tính năng | Mô tả | Mức |
|---|---|---|---|
| N1 | Rã PDF có chữ | Lấy chữ kèm font, cỡ, đậm/nghiêng; gom dòng → đoạn; nhận tiêu đề theo cỡ chữ; danh sách; link; tách ảnh; thứ tự đọc kể cả văn bản nhiều cột; bỏ header/footer/số trang lặp lại | v0.10 |
| N2 | Bảng đơn giản | Bảng có đường kẻ trong PDF có chữ → bảng Markdown/HTML/Excel | v0.10 |
| N3 | **Màn hình kiểm tra & sửa** | Bản gốc một bên, kết quả một bên, click chỗ nào nhảy tới chỗ đó; sửa chữ; đổi loại vùng (đoạn ↔ tiêu đề ↔ bảng ↔ hình). Tô vàng chữ đáng ngờ khi có OCR (gói Q) | v0.10 |
| N4 | Xuất định dạng | Markdown (kèm thư mục ảnh), DOCX, HTML, EPUB, ODT, TXT, XLSX (chỉ bảng), JSON | v0.10 |
| N5 | Hai chế độ xuất Word | "Dễ chỉnh sửa" (văn bản chảy, style Heading) và "Giữ bố cục" (khung định vị, cột) | v0.10 |
| N6 | Làm mới tài liệu | Dàn trang lại thành PDF sạch, font đẹp từ mô hình tài liệu | v0.10 |
| N7 | Hàng loạt | Rã cả thư mục; dùng làm một bước trong quy trình (O) | v0.10 |
| N8 | Trình sửa Markdown | Sửa Markdown, xem trước, xuất lại | Ý tưởng |

---

# 6. TỰ ĐỘNG & SO SÁNH

## O. ★ Quy trình & xử lý hàng loạt

| Mã | Tính năng | Mô tả | Mức |
|---|---|---|---|
| O1 | Trình tạo quy trình | Ghép các bước thành chuỗi (ví dụ: Ghép → Đánh số trang → Dấu giáp lai → Bản scan 200 dpi xám → Ký số → Lưu); lưu và chia sẻ dưới dạng file | v0.9 |
| O2 | Chạy hàng loạt | Áp dụng cho nhiều file / cả thư mục; thanh tiến độ; báo lỗi từng file | v0.9 |
| O3 | Thư mục tự động | Thả file vào thư mục là app tự chạy quy trình | v0.9 |
| O4 | Quy tắc đặt tên đầu ra | `{ten}_{ngay}_da-ky.pdf` | v0.9 |
| O5 | Tự sắp xếp thứ tự an toàn | Bước "bản scan" luôn đứng trước "ký số", có cảnh báo | v0.9 |
| O6 | Đổi tên file hàng loạt | Theo mẫu, theo tiêu đề trong metadata, hoặc theo dòng chữ đầu tiên của trang 1 | v0.9 |
| O7 | Quy trình mẫu có sẵn | "Nộp hồ sơ online" (ghép → bản scan 200 dpi xám → nén ≤ 5MB → ký số); "Phát hành văn bản" (đánh số theo NĐ 30 → ký số → dấu giáp lai); "Chụp sách" (chụp bằng điện thoại → dò viền & cắt → tách trang đôi → làm phẳng trang cong → xóa ngón tay → làm trắng nền → ghép thành PDF) | v0.9 |
| O8 | Kéo thả lên quy trình | Kéo file thả lên một quy trình ở màn hình Start là chạy | v0.9 |
| O9 | Dòng lệnh `chefpdf` | Dùng chung lõi xử lý, chạy từ script | Ý tưởng |

## P. So sánh tài liệu

| Mã | Tính năng | Mô tả | Mức |
|---|---|---|---|
| P1 | So sánh chữ | Hai phiên bản cạnh nhau, tô màu chỗ thêm/xóa/sửa | Sau 1.0 |
| P2 | So sánh hình | Chồng 2 trang lên nhau để thấy chỗ khác | Sau 1.0 |

---

# 7. GÓI NÂNG CẤP

## Q. Nhận dạng (OCR & AI)

Phiên bản nâng cấp sau này. Dùng **mô hình chạy trên máy** (offline) hoặc **dịch vụ nhận dạng trả phí qua API** (người dùng tự bật). **Không thuộc bản 1.0.**

| Mã | Tính năng | Mô tả | Mức |
|---|---|---|---|
| Q1 | OCR cho PDF scan và ảnh | Tiếng Việt + Anh, nhận đúng chữ có dấu. Kết quả đưa vào quy trình rã tài liệu (N) | Nâng cấp |
| Q2 | PDF tìm kiếm được | Giữ ảnh scan, thêm lớp chữ ẩn để tìm kiếm và copy | Nâng cấp |
| Q3 | Nhận dạng bố cục bằng mô hình | Tiêu đề, đoạn, bảng, hình, chú thích ảnh; chính xác hơn cách dò bằng quy tắc ở N1 | Nâng cấp |
| Q4 | Bảng phức tạp | Bảng không kẻ, ô gộp, bảng trong bản scan | Nâng cấp |
| Q5 | Lọc con dấu & chữ ký trước khi OCR | Bỏ con dấu đỏ, chữ ký xanh đè lên chữ (dùng I22) | Nâng cấp |
| Q6 | Nhận diện văn bản hành chính VN | Quốc hiệu, cơ quan ban hành, số/ký hiệu, trích yếu, nơi nhận, người ký → Word đúng thể thức | Nâng cấp |
| Q7 | Công thức toán | Thành LaTeX | Nâng cấp |
| Q8 | Gỡ watermark trên bản scan | Watermark đã dính vào ảnh | Nâng cấp |
| Q9 | Gói mô hình tải riêng | Vài trăm MB, không đi kèm bản cài chính; tùy chọn dùng GPU | Nâng cấp |
| Q10 | Kết nối API nhận dạng trả phí | Người dùng tự nhập khóa API; mặc định tắt vì gửi dữ liệu ra ngoài | Nâng cấp |
| Q11 | Xóa ngón tay tự động hoàn toàn | Dùng mô hình nhận dạng bàn tay để tách ngón tay chính xác (kể cả da tối, giấy ngả vàng, ánh sáng xấu), rồi dùng mô hình vẽ lại vùng bị che (inpainting). Nâng cấp từ L14 | Nâng cấp |
| Q12 | Làm phẳng trang cong bằng mô hình | Trang cong mạnh, chụp nghiêng, trang không có nhiều chữ. Nâng cấp từ L13 | Nâng cấp |

---

## Thống kê

| Mức | Số tính năng |
|---|---|
| Bản 1.0 (v0.1–v0.10) | 159 |
| Sau 1.0 | 5 |
| Nâng cấp | 12 |
| Ý tưởng | 20 |
| **Tổng** | 196 |

## Thay đổi sau khi chốt

Ghi mọi thay đổi phạm vi ở đây (ngày, mã, thay đổi, lý do).

| Ngày | Mã | Thay đổi | Lý do |
|---|---|---|---|
| 2026-11-03 | A8 | Bản 1.0 chỉ cam kết **bộ cài và kiểm thử trên Windows**; macOS và Linux (cấu hình build vẫn giữ) kiểm thử sau 1.0. Mức của A8 không đổi, số tính năng không đổi | Chủ dự án: ưu tiên phiên bản Windows (D37) |
| 2026-11-03 | A10 | **Tự cập nhật** chuyển từ v0.9 sang **Sau 1.0**. Bản 1.0 còn 159 tính năng; T9.08 tạm dừng | Chủ dự án (trả lời CH2): phát hành bản mới sau, chưa cần tự cập nhật |
| 2026-10-31 | L9–L14 | Thêm trình sửa ảnh trang, tẩy & tô, xóa vết màu, chỉnh mức sáng & độ phân giải, làm phẳng trang cong (cơ bản), xóa ngón tay (bán tự động). Thuộc v0.7 | Chủ dự án bổ sung (theo ABBYY OCR Editor và vFlat Scan) |
| 2026-10-31 | (nhiều mã) | **Chia lại mốc khi lập kế hoạch:** v0.4 cũ tách thành v0.4 + v0.5; các mốc sau lùi một bậc; v0.7 cũ tách thành v0.8 (ảnh scan) + v0.9 (form, quy trình); rã tài liệu thành v0.10. Không thêm/bớt tính năng | v0.4 cũ có 43 tính năng, quá nặng (D29) |
| 2026-10-31 | L6 | Từ "Ý tưởng" lên **v0.7**, mô tả chi tiết hơn | Chủ dự án đồng ý, để đủ quy trình chụp sách |
| 2026-10-31 | L20, Q13 | Mô hình dò viền trang đưa vào bản 1.0 thành **L20** (ngoại lệ của nguyên tắc không AI). **Mã Q13 bỏ, không dùng lại** | Chủ dự án đồng ý |
| 2026-10-31 | O7 | Thêm quy trình mẫu "Chụp sách" | Gom L5, L15, L6, L13, L14, L3 thành một quy trình |
| 2026-10-31 | L15–L19, Q13 | Thêm tự dò viền trang & tự cắt, cắt thủ công (khung chữ nhật, kéo 4 góc), cắt hàng loạt & duyệt nhanh, tự nhận khổ giấy; bản dò viền bằng mô hình ở gói nâng cấp. Làm rõ C7 và L2 | Chủ dự án bổ sung |
| 2026-10-31 | Q11–Q12 | Thêm xóa ngón tay tự động hoàn toàn và làm phẳng trang cong bằng mô hình | Bản nâng cấp của L14, L13 |
