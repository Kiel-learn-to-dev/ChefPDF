# Chef PDF: Cây tính năng

> **Trạng thái:** Bản nháp 2 (2026-10-31), chờ chủ dự án góp ý.
> Bản nháp 2 **đánh lại mã toàn bộ** so với bản nháp 1. Từ giờ dùng mã trong file này.
> Mỗi tính năng có mã (ví dụ `F4`) để tiện góp ý. Cột "Bản" là phiên bản dự kiến làm.
> ★ = tính năng chủ lực. 🆕 = mới thêm ở bản nháp 2. 🤔 = chưa chắc có cần không, chờ chủ dự án quyết.

## Cách tổ chức

Cây chia thành **5 khu vực**, khớp với cách giao diện sẽ được bố trí: mỗi nhóm là một tab trên thanh công cụ hoặc một ô nhiệm vụ ở màn hình Start.

```
1. Nền tảng       A Khung app · B Xem & điều hướng
2. Trang          C Sắp xếp trang
3. Nội dung       D Chỉnh sửa chữ & đối tượng · E Lớp & gỡ watermark
                  F Watermark, con dấu & đánh số · G Ghi chú · H Form
4. Xuất & bảo vệ  I Chuyển thành bản scan · J Làm đẹp bản scan · K Ký số
                  L Bảo mật · M Tối ưu, chuyển đổi & sửa lỗi
5. Tự động        N Quy trình & hàng loạt · O So sánh · P Để sau
```

Giao diện dự kiến: **Start** · tab **Xem** · **Trang** · **Chỉnh sửa** (D, E, F) · **Ghi chú** (G) · **Form** (H) · **Ký & Bảo vệ** (K, L) · **Xuất** (I, J, M) · **Quy trình** (N).

## Lộ trình theo phiên bản

| Bản | Trọng tâm |
|---|---|
| v0.1 | Khung app, Start, xem PDF, tab, sắp xếp trang, build 3 OS |
| v0.2 | ★ Chuyển thành bản scan |
| v0.3 | ★ Ký số và kiểm tra chữ ký |
| v0.4 | Watermark, con dấu, dấu giáp lai, header/footer, số trang; mật khẩu; nén; chuyển PDF ↔ ảnh |
| v0.5 | **Bộ máy nội dung**: chọn/di chuyển/xóa đối tượng, tẩy vùng, bảng lớp, gỡ watermark, che thông tin mật |
| v0.6 | Sửa chữ có sẵn (mức dòng, sau đó mức đoạn), tìm & thay thế; ghi chú |
| v0.7 | Form, làm đẹp bản scan, quy trình tự động, tự cập nhật |
| Sau | Ký từ xa, so sánh, OCR, máy scan… |

> **Vì sao v0.5 gom nhiều thứ:** tẩy vùng, xóa đối tượng, gỡ watermark và che thông tin mật cùng dùng chung một "bộ máy nội dung": đọc, chọn và xóa các đối tượng trong luồng nội dung của trang. Làm bộ máy này một lần là có cả 4 tính năng. Sửa chữ (v0.6) cũng xây tiếp trên nền đó.

---

# Khu vực 1: Nền tảng

## A. Khung app

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| A1 | Màn hình Start | Ô nhiệm vụ (Mở PDF, Ghép file, Chuyển thành bản scan, Ký số, Đóng dấu, Nén…), file gần đây, kéo thả file vào | v0.1 |
| A2 | Tab nhiều tài liệu | Mở nhiều file cùng lúc, kéo tab ra cửa sổ riêng | v0.1 |
| A3 | Bảng lệnh `Ctrl+K` | Gõ tên tính năng để chạy, ví dụ gõ "ky" ra "Ký số" | v0.1 |
| A4 | Cài đặt | Ngôn ngữ Việt/Anh, giao diện sáng/tối/theo hệ thống, thư mục lưu mặc định, preset mặc định | v0.1 |
| A5 | Mở file từ hệ điều hành | "Open with", đặt làm app PDF mặc định | v0.1 |
| A6 | Hoàn tác / Làm lại | `Ctrl+Z` / `Ctrl+Y` | v0.1 |
| A7 | In | Hộp thoại in của hệ điều hành, chọn trang | v0.1 |
| A8 | Khôi phục khi crash | Tự lưu nháp, mở lại file đang làm dở | v0.4 |
| A9 | Tự cập nhật | | v0.7 |
| A10 | Phím tắt tùy chỉnh | | Sau 🤔 |

## B. Xem & điều hướng

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| B1 | Hiển thị trang | Zoom (vừa chiều rộng, vừa trang, %), xoay khung nhìn | v0.1 |
| B2 | Chế độ xem | Một trang, cuộn liên tục, hai trang, kiểu sách, toàn màn hình / trình chiếu | v0.1 |
| B3 | Thanh bên | Thumbnail, mục lục; các tab khác (lớp, file đính kèm, ghi chú, chữ ký) xuất hiện theo tính năng tương ứng | v0.1 |
| B4 | Tìm kiếm | `Ctrl+F`, tô sáng kết quả. **Tìm không dấu**: gõ "nghi dinh" ra "nghị định" | v0.1 |
| B5 | Chọn & copy | Copy chữ; chụp một vùng thành ảnh | v0.1 |
| B6 | Mở file có mật khẩu | Hỏi mật khẩu khi mở | v0.1 |
| B7 | Thuộc tính tài liệu | Xem metadata, khổ giấy, font, phiên bản PDF, số trang, dung lượng (sửa metadata ở M8) | v0.1 |
| B8 | Chế độ đọc ban đêm | Đảo màu trang | Sau 🤔 |

---

# Khu vực 2: Trang

## C. Sắp xếp trang

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| C1 | Lưới thumbnail | Kéo thả đổi thứ tự, chọn nhiều trang (Shift/Ctrl) | v0.1 |
| C2 | Thao tác trang | Xoay, xóa, nhân bản, trích trang ra file mới | v0.1 |
| C3 | Chèn trang | Trang trắng, trang từ file khác, từ ảnh, từ clipboard | v0.1 |
| C4 | Ghép file | Nhiều file thành 1, sắp thứ tự, tùy chọn tạo bookmark theo tên file | v0.1 |
| C5 | Tách file | Theo khoảng trang, mỗi N trang, theo bookmark, theo dung lượng, trang chẵn/lẻ | v0.1 |
| C6 | Thay thế trang | Thay trang X bằng trang từ file khác | v0.4 |
| C7 | Cắt lề / đổi khổ | Cắt lề trắng (tự dò), đưa về A4/Letter, co giãn nội dung | v0.4 |
| C8 | In ghép trang | N-up (2/4 trang trên 1 tờ), in kiểu sổ tay (booklet) | Sau 🤔 |

---

# Khu vực 3: Nội dung

## D. Chỉnh sửa chữ & đối tượng

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| D1 | Thêm chữ | Hộp chữ mới, hỗ trợ đầy đủ tiếng Việt (nhúng font Unicode) | v0.4 |
| D2 | Thêm ảnh | Logo, ảnh, kéo thả lên trang | v0.4 |
| D3 🆕 | Chọn & sửa đối tượng | Click chọn chữ, ảnh hoặc hình vẽ có sẵn; di chuyển, đổi kích thước, xoay, xóa, đưa lên trên / xuống dưới | v0.5 |
| D4 🆕 | Tẩy vùng | Quét chọn một vùng rồi xóa toàn bộ nội dung bên trong (khác với che thông tin mật: không để lại ô đen) | v0.5 |
| D5 🆕 | Thay ảnh | Thay một ảnh trong PDF bằng ảnh khác, giữ nguyên vị trí và kích thước | v0.5 |
| D6 | **Sửa chữ có sẵn (mức dòng)** | Click vào dòng chữ để sửa. Dùng lại font gốc nếu font còn đủ ký tự; nếu thiếu (hay gặp với tiếng Việt) thì tự thay bằng font gần giống | v0.6 |
| D7 🆕 | **Sửa chữ có sẵn (mức đoạn)** | Gom các dòng thành đoạn văn, sửa và tự xuống dòng lại (reflow), đổi font/cỡ/màu/căn lề | v0.6 |
| D8 🆕 | Tìm & thay thế chữ | Thay một cụm từ trên toàn tài liệu, ví dụ đổi tên công ty, đổi ngày tháng | v0.6 |
| D9 | Liên kết | Thêm/sửa/xóa link (trang nội bộ, web, email) | v0.6 |
| D10 | Sửa mục lục | Thêm/sửa/xóa/sắp xếp bookmark | v0.4 |

## E. 🆕 Lớp & gỡ watermark

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| E1 | Bảng lớp (Layers) | Hiện các lớp nội dung (OCG) có trong file; bật/tắt, đổi tên, xóa lớp, làm phẳng lớp | v0.5 |
| E2 | Xem theo loại nội dung | Bật/tắt riêng từng loại: chữ, ảnh, hình vẽ (vector), ghi chú, nền. Giúp nhìn ra cái gì nằm ở đâu | v0.5 |
| E3 | Tách lớp ra file | Xuất riêng phần chữ, phần ảnh hoặc từng lớp thành file PDF/ảnh riêng | v0.5 🤔 |
| E4 | Gỡ watermark tự động | App dò các ứng viên rồi hiện danh sách kèm xem trước, người dùng tích chọn cái muốn gỡ. Ứng viên gồm: watermark gắn nhãn chuẩn, lớp tên "watermark", ghi chú kiểu watermark, đối tượng lặp lại ở cùng vị trí trên nhiều trang, đối tượng xoay chéo hoặc trong suốt | v0.5 |
| E5 | Gỡ "đối tượng giống thế này" | Click chọn một đối tượng (ví dụ logo chìm), gỡ nó trên **mọi trang** | v0.5 |
| E6 | Gỡ / đổi nền trang | Xóa màu nền hoặc ảnh nền; đặt nền mới | v0.5 |
| E7 | Gỡ watermark trên bản scan | Watermark đã "dính" vào ảnh scan. Cần xử lý ảnh (lọc theo màu, khôi phục vùng), kết quả không bảo đảm | Sau 🤔 |

## F. Watermark, con dấu & đánh số

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| F1 | Thêm watermark | Chữ hoặc ảnh, độ mờ, góc xoay, cỡ, nằm trên/dưới nội dung, chọn trang. **Gắn nhãn chuẩn** nên sau này gỡ được sạch | v0.4 |
| F2 | Con dấu chữ | ĐÃ DUYỆT, MẬT, KHẨN, BẢN SAO, ĐÃ NHẬN…, thư viện dấu tự tạo | v0.4 |
| F3 🆕 | Con dấu ảnh | Ảnh con dấu / chữ ký tay, kéo thả, đổi cỡ, xoay; lưu vào thư viện dấu | v0.4 |
| F4 🆕 | Tách nền trắng cho ảnh dấu | Chụp ảnh con dấu/chữ ký bằng điện thoại → app tự bỏ nền giấy, giữ lại nét mực (màu đỏ/xanh) trong suốt | v0.4 |
| F5 🆕 | **Dấu giáp lai** | Đóng một dấu cắt đều qua mép phải của nhiều trang, đúng kiểu văn bản hành chính Việt Nam. Chọn trang, vị trí theo chiều dọc, số phần cắt | v0.4 |
| F6 🆕 | Con dấu động | Dấu tự điền ngày giờ và tên người, ví dụ "ĐÃ NHẬN – 14:30 31/10/2026 – Nguyễn A" | v0.4 |
| F7 | Header / Footer | Chữ hoặc ảnh ở đầu/chân trang, trái/giữa/phải, có biến `{ngay}` `{tenfile}` `{trang}` `{tongtrang}` | v0.4 |
| F8 | Đánh số trang | Nhiều kiểu ("1", "Trang 1/10", "- 1 -", số La Mã), chọn vị trí, bỏ trang đầu, bắt đầu từ số bất kỳ. **Preset theo Nghị định 30/2020/NĐ-CP**: giữa lề trên, không đánh số trang đầu | v0.4 |
| F9 | Đánh số Bates | Mã tài liệu liên tục qua nhiều file (ví dụ HS-000001), dùng trong hồ sơ pháp lý | v0.4 |
| F10 | Quản lý & gỡ | Sửa hoặc gỡ watermark / header / footer / số trang mà Chef PDF đã thêm trước đó | v0.4 |

## G. Ghi chú

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| G1 | Đánh dấu chữ | Highlight, gạch chân, gạch ngang | v0.6 |
| G2 | Ghi chú | Note dán, hộp chữ bình luận | v0.6 |
| G3 | Vẽ | Bút vẽ tay, đường thẳng, mũi tên, hình chữ nhật, elip | v0.6 |
| G4 | Danh sách ghi chú | Lọc theo loại/người, trả lời, đánh dấu đã xử lý, xuất bản tổng hợp | v0.6 |
| G5 | Làm phẳng ghi chú | Biến ghi chú thành nội dung cố định | v0.6 |

## H. Form

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| H1 | Điền form | Điền form AcroForm có sẵn, lưu lại | v0.7 |
| H2 | Tạo form | Ô chữ, checkbox, radio, dropdown, ô chữ ký | v0.7 |
| H3 | Làm phẳng form | | v0.7 |
| H4 | Điền hàng loạt | Một mẫu form × N dòng dữ liệu từ Excel/CSV thành N file | Sau 🤔 |

---

# Khu vực 4: Xuất & bảo vệ

## I. ★ Chuyển thành bản scan (PDF chỉ có ảnh)

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| I1 | Độ phân giải | Preset 150 / 200 / 300 / 600 dpi và tùy chỉnh | v0.2 |
| I2 | Chế độ màu | Màu / Xám / Đen trắng 1-bit (chỉnh ngưỡng, tùy chọn dithering) | v0.2 |
| I3 | Nén | JPEG (chỉnh chất lượng), không mất dữ liệu (Flate), CCITT G4 cho đen trắng | v0.2 |
| I4 | Hiệu ứng scan thật | Nghiêng nhẹ ngẫu nhiên, hạt nhiễu, ám màu giấy, bóng mép giấy, mờ nhẹ, lệch tương phản; ngẫu nhiên khác nhau từng trang | v0.2 |
| I5 | Xem trước | So sánh gốc và kết quả (chia đôi hoặc thanh trượt), zoom 100% để kiểm tra độ nét | v0.2 |
| I6 | Ước tính dung lượng | Cập nhật ngay khi đổi thiết lập | v0.2 |
| I7 | Phạm vi & tùy chọn | Chọn trang, giữ khổ giấy, xóa metadata | v0.2 |
| I8 | Preset | Có sẵn (Nhẹ / Chuẩn / Nét / Văn bản hành chính) và tự tạo | v0.2 |
| I9 | Cảnh báo | Báo trước sẽ mất chữ, link, form, chữ ký số | v0.2 |
| I10 | Giới hạn dung lượng | "Nén sao cho file ≤ 5MB": tự dò DPI/chất lượng phù hợp, hữu ích khi nộp hồ sơ online | v0.2 🤔 |

## J. 🆕 Làm đẹp bản scan

Dành cho PDF vốn đã là bản scan hoặc ảnh chụp, không cần OCR.

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| J1 | Chỉnh nghiêng | Tự dò và xoay thẳng trang bị lệch | v0.7 |
| J2 | Cắt & nắn | Cắt viền thừa; nắn trang chụp bị xiên (méo hình thang) thành hình chữ nhật | v0.7 |
| J3 | Làm trắng nền | Biến nền giấy ngả vàng/xám thành trắng, chữ đậm và rõ hơn | v0.7 |
| J4 | Khử nhiễu, chỉnh sáng | Xóa chấm bẩn; chỉnh độ sáng, tương phản | v0.7 |
| J5 | Tách trang đôi | Ảnh chụp 2 trang sách mở thành 2 trang riêng | Sau 🤔 |

## K. ★ Ký số

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| K1 | Nguồn chứng thư | USB token qua PKCS#11 (tự dò driver các CA Việt Nam), file `.pfx`/`.p12` | v0.3 |
| K2 | Hình thức chữ ký | Hiển thị hoặc ẩn; kéo thả khung ký; ảnh chữ ký tay / con dấu (dùng chung thư viện ở F3, F4); mẫu chữ "Ký bởi / Ngày ký / Lý do / Nơi ký"; lưu nhiều mẫu | v0.3 |
| K3 | Tùy chọn ký | Lý do, nơi ký, liên hệ; mức PAdES (B-B, B-T, B-LT, B-LTA); cấu hình TSA (có sẵn danh sách TSA Việt Nam); SHA-256 | v0.3 |
| K4 | Ký chứng nhận (certify) | Khóa tài liệu, chọn mức quyền được phép sau khi ký | v0.3 |
| K5 | Nhiều người ký | Ký nối tiếp không phá chữ ký trước; tạo ô ký trống cho người khác | v0.3 |
| K6 | Ký hàng loạt | Chọn nhiều file, nhập PIN 1 lần, vị trí ký cố định (ví dụ góc phải trang cuối) | v0.3 |
| K7 | Kiểm tra chữ ký | Panel trạng thái (✅ hợp lệ / ⚠️ đã bị sửa / ❌ không tin cậy), chuỗi chứng thư, kiểm tra OCSP/CRL, xem phiên bản tài liệu lúc ký | v0.3 |
| K8 | Kho tin cậy | Nạp sẵn Root CA quốc gia Việt Nam, thêm/xóa chứng thư tin cậy | v0.3 |
| K9 | Kho chứng thư hệ điều hành | Windows Certificate Store, macOS Keychain | Sau 🤔 |
| K10 | Ký từ xa qua cloud | VNPT SmartCA, Viettel MySign… | Sau |
| K11 | Báo cáo chữ ký | Xuất kết quả kiểm tra ra PDF | Sau 🤔 |

## L. Bảo mật

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| L1 | Đặt mật khẩu | Mật khẩu mở file; giới hạn quyền in/copy/sửa; AES-256 | v0.4 |
| L2 | Gỡ mật khẩu | Khi đã biết mật khẩu | v0.4 |
| L3 | Che thông tin mật | Chọn vùng hoặc chữ; tìm và che hàng loạt (số CCCD, số điện thoại, email, số tài khoản); **xóa hẳn nội dung bên dưới** | v0.5 |
| L4 | Gỡ dữ liệu ẩn | Xóa metadata, JavaScript, file đính kèm, lớp ẩn, ghi chú, lịch sử sửa (bản lưu ghi thêm) | v0.4 |

## M. Tối ưu, chuyển đổi & sửa lỗi

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| M1 | Nén PDF | Preset (màn hình / email / in ấn), giảm độ phân giải ảnh, bỏ đối tượng thừa, rút gọn font | v0.4 |
| M2 | PDF → ảnh | PNG / JPG / TIFF (TIFF nhiều trang), chọn DPI | v0.4 |
| M3 | Ảnh → PDF | Nhiều ảnh, sắp thứ tự, khổ giấy, lề, tự xoay theo EXIF | v0.4 |
| M4 | Trích xuất | Lấy toàn bộ ảnh gốc, lấy text ra `.txt` | v0.4 |
| M5 🆕 | Sửa file PDF hỏng | Thử khôi phục file lỗi, không mở được | v0.4 |
| M6 🆕 | File đính kèm | Xem, thêm, xóa, lưu ra các file nhúng trong PDF | v0.4 |
| M7 🆕 | Tối ưu cho web | Linearize: mở trang đầu nhanh khi xem qua mạng | v0.4 |
| M8 🆕 | Sửa metadata | Tiêu đề, tác giả, chủ đề, từ khóa | v0.4 |
| M9 | PDF/A để lưu trữ | Lưu ý giấy phép: không dùng Ghostscript | Sau |
| M10 | Office → PDF | Qua LibreOffice nếu máy có cài | Sau 🤔 |
| M11 🆕 | Máy in ảo "Chef PDF" | In từ bất kỳ app nào ra PDF. Khó làm đều trên 3 OS | Sau 🤔 |

---

# Khu vực 5: Tự động & mở rộng

## N. ★ Quy trình & xử lý hàng loạt

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| N1 | Trình tạo quy trình | Ghép các bước thành chuỗi (ví dụ: Ghép → Đánh số trang → Dấu giáp lai → Bản scan 200 dpi xám → Ký số → Lưu), lưu và chia sẻ dưới dạng file | v0.7 |
| N2 | Chạy hàng loạt | Áp dụng quy trình cho nhiều file hoặc cả thư mục, có thanh tiến độ và báo lỗi từng file | v0.7 |
| N3 | Thư mục tự động (hot folder) | Thả file vào thư mục là app tự chạy quy trình | v0.7 |
| N4 | Quy tắc đặt tên đầu ra | `{ten}_{ngay}_da-ky.pdf` | v0.7 |
| N5 | Tự sắp xếp thứ tự an toàn | Bước "bản scan" luôn đứng trước "ký số" và có cảnh báo | v0.7 |
| N6 | Dòng lệnh `chefpdf` | Dùng chung lõi xử lý, chạy được từ script | Sau 🤔 |

## O. So sánh tài liệu

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| O1 | So sánh chữ | Hai phiên bản cạnh nhau, tô màu chỗ thêm/xóa/sửa | Sau |
| O2 | So sánh hình | Chồng 2 trang lên nhau để thấy chỗ khác | Sau |

## P. Để sau / ý tưởng xa

| Mã | Tính năng | Bản |
|---|---|---|
| P1 | OCR (tiếng Việt, tiếng Anh) | Sau |
| P2 | Quét trực tiếp từ máy scan (TWAIN/WIA trên Windows, ICA trên macOS, SANE trên Linux) | Sau 🤔 |
| P3 | PDF hỗ trợ người khiếm thị (tagged PDF / PDF/UA) | Sau 🤔 |
| P4 | Hệ thống plugin mở rộng | Sau 🤔 |
| P5 | Bản web rút gọn (không ký số), dùng lại giao diện React | Sau 🤔 |
