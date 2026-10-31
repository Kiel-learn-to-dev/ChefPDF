# Chef PDF: Cây tính năng

> **Trạng thái:** Bản nháp 1 (2026-10-31), **chờ chủ dự án góp ý**.
> Mỗi tính năng có mã (ví dụ `G4`) để tiện góp ý. Cột "Bản" là phiên bản dự kiến làm.
> ★ = tính năng chủ lực. 🤔 = chưa chắc có cần không, chờ chủ dự án quyết.

## Lộ trình theo phiên bản

| Bản | Trọng tâm |
|---|---|
| v0.1 | Khung app, Start, xem PDF, tab, sắp xếp trang, build 3 OS |
| v0.2 | ★ Chuyển thành bản scan |
| v0.3 | ★ Ký số và kiểm tra chữ ký |
| v0.4 | Watermark, đánh số trang, mật khẩu, nén, chuyển PDF ↔ ảnh |
| v0.5 | Ghi chú, form, che thông tin mật, quy trình tự động, tự cập nhật |
| Sau | Ký từ xa, so sánh tài liệu, OCR, sửa chữ có sẵn |

---

## A. Khung app & trải nghiệm chung

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| A1 | Màn hình Start | Ô nhiệm vụ (Mở PDF, Ghép file, Chuyển thành bản scan, Ký số, Nén…), danh sách file gần đây, kéo thả file vào | v0.1 |
| A2 | Tab nhiều tài liệu | Mở nhiều file cùng lúc, kéo tab ra cửa sổ riêng | v0.1 |
| A3 | Bảng lệnh `Ctrl+K` | Gõ tên tính năng để chạy, ví dụ gõ "ký" ra "Ký số" | v0.1 |
| A4 | Cài đặt | Ngôn ngữ Việt/Anh, giao diện sáng/tối/theo hệ thống, thư mục lưu mặc định, preset mặc định | v0.1 |
| A5 | Mở file từ hệ điều hành | "Open with", đặt làm app PDF mặc định, liên kết đuôi `.pdf` | v0.1 |
| A6 | Hoàn tác / Làm lại | Lịch sử thao tác, `Ctrl+Z` / `Ctrl+Y` | v0.1 |
| A7 | Khôi phục khi crash | Tự lưu nháp, mở lại file đang làm dở | v0.4 |
| A8 | In | Hộp thoại in của hệ điều hành, chọn trang | v0.1 |
| A9 | Tự cập nhật | Kiểm tra và cài bản mới | v0.5 |
| A10 | Phím tắt tùy chỉnh | | Sau 🤔 |

## B. Xem & điều hướng

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| B1 | Hiển thị trang | Zoom (vừa chiều rộng, vừa trang, %), xoay khung nhìn | v0.1 |
| B2 | Chế độ xem | Một trang, cuộn liên tục, hai trang, kiểu sách, toàn màn hình / trình chiếu | v0.1 |
| B3 | Thanh bên | Thumbnail, mục lục (bookmark), file đính kèm, danh sách ghi chú, danh sách chữ ký | v0.1 (thumbnail, mục lục), phần còn lại theo tính năng |
| B4 | Tìm kiếm | `Ctrl+F`, tô sáng kết quả. **Tìm không dấu**: gõ "nghi dinh" ra "nghị định" | v0.1 |
| B5 | Chọn & copy | Copy chữ; chụp một vùng thành ảnh | v0.1 |
| B6 | Thuộc tính tài liệu | Metadata, khổ giấy, font, phiên bản PDF, số trang, dung lượng | v0.1 |
| B7 | Chế độ đọc ban đêm | Đảo màu trang | v0.4 🤔 |
| B8 | Mở PDF có mật khẩu | Hỏi mật khẩu khi mở | v0.1 |

## C. Sắp xếp trang

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| C1 | Lưới thumbnail | Kéo thả đổi thứ tự, chọn nhiều trang (Shift/Ctrl) | v0.1 |
| C2 | Thao tác trang | Xoay, xóa, nhân bản, trích trang ra file mới | v0.1 |
| C3 | Chèn trang | Trang trắng, trang từ file khác, từ ảnh, từ clipboard | v0.1 |
| C4 | Ghép file | Nhiều file thành 1, sắp thứ tự, tùy chọn tạo bookmark theo tên file | v0.1 |
| C5 | Tách file | Theo khoảng trang, mỗi N trang, theo bookmark, theo dung lượng, trang chẵn/lẻ | v0.1 |
| C6 | Thay thế trang | Thay trang X bằng trang từ file khác | v0.4 |
| C7 | Cắt lề / đổi khổ | Cắt lề trắng, đưa về A4/Letter, co giãn nội dung | v0.4 |
| C8 | In ghép trang | N-up (2/4 trang trên 1 tờ), in kiểu sổ tay (booklet) | Sau 🤔 |

## D. Chỉnh sửa nội dung

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| D1 | Thêm chữ | Hộp chữ, hỗ trợ đầy đủ tiếng Việt (nhúng font Unicode) | v0.4 |
| D2 | Thêm ảnh | Logo, ảnh, kéo thả lên trang | v0.4 |
| D3 | Watermark | Chữ hoặc ảnh, độ mờ, góc xoay, nằm trên/dưới nội dung, chọn trang | v0.4 |
| D4 | Header/Footer, đánh số trang | "Trang 1/10", vị trí, font, bỏ trang đầu; đánh số kiểu Bates | v0.4 |
| D5 | Con dấu | ĐÃ DUYỆT, MẬT, KHẨN, BẢN SAO, thư viện dấu tự tạo | v0.4 |
| D6 | Liên kết | Thêm/sửa/xóa link | v0.5 |
| D7 | Sửa mục lục | Thêm/sửa/xóa/sắp xếp bookmark | v0.4 |
| D8 | Sửa chữ có sẵn trong PDF | Bị giới hạn bởi font nhúng, khó làm | Sau |

## E. Ghi chú

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| E1 | Đánh dấu chữ | Highlight, gạch chân, gạch ngang | v0.5 |
| E2 | Ghi chú | Note dán, hộp chữ bình luận | v0.5 |
| E3 | Vẽ | Bút vẽ tay, đường thẳng, mũi tên, hình chữ nhật, elip | v0.5 |
| E4 | Danh sách ghi chú | Lọc theo loại/người, xuất bản tổng hợp ghi chú | v0.5 |
| E5 | Làm phẳng ghi chú | Biến ghi chú thành nội dung cố định | v0.5 |

## F. Form

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| F1 | Điền form | Điền form AcroForm có sẵn, lưu lại | v0.5 |
| F2 | Tạo form | Ô chữ, checkbox, radio, dropdown, ô chữ ký | v0.5 |
| F3 | Làm phẳng form | | v0.5 |
| F4 | Nhập/xuất dữ liệu form | JSON / Excel, điền hàng loạt (1 mẫu × N dòng dữ liệu) | Sau 🤔 |

## G. ★ Chuyển thành bản scan (PDF chỉ có ảnh)

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| G1 | Độ phân giải | Preset 150 / 200 / 300 / 600 dpi và tùy chỉnh | v0.2 |
| G2 | Chế độ màu | Màu / Xám / Đen trắng 1-bit (chỉnh ngưỡng, tùy chọn dithering) | v0.2 |
| G3 | Nén | JPEG (chỉnh chất lượng), không mất dữ liệu (Flate), CCITT G4 cho đen trắng | v0.2 |
| G4 | Hiệu ứng scan thật | Nghiêng nhẹ ngẫu nhiên, hạt nhiễu, ám màu giấy, bóng mép giấy, mờ nhẹ, lệch tương phản; ngẫu nhiên khác nhau từng trang | v0.2 |
| G5 | Xem trước | So sánh gốc và kết quả (chia đôi hoặc thanh trượt), zoom 100% để kiểm tra độ nét | v0.2 |
| G6 | Ước tính dung lượng | Cập nhật ngay khi đổi thiết lập | v0.2 |
| G7 | Phạm vi & tùy chọn | Chọn trang, giữ khổ giấy, xóa metadata | v0.2 |
| G8 | Preset | Có sẵn (Nhẹ / Chuẩn / Nét / Văn bản hành chính) và tự tạo | v0.2 |
| G9 | Cảnh báo | Báo trước sẽ mất chữ, link, form, chữ ký số | v0.2 |
| G10 | Giới hạn dung lượng | "Nén sao cho file ≤ 5MB": tự dò DPI/chất lượng phù hợp. Hữu ích khi nộp hồ sơ online có giới hạn dung lượng | v0.2 🤔 |

## H. ★ Ký số

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| H1 | Nguồn chứng thư | USB token qua PKCS#11 (tự dò driver các CA Việt Nam), file `.pfx`/`.p12` | v0.3 |
| H2 | Kho chứng thư hệ điều hành | Windows Certificate Store, macOS Keychain | Sau 🤔 |
| H3 | Ký từ xa qua cloud | VNPT SmartCA, Viettel MySign… | Sau |
| H4 | Hình thức chữ ký | Hiển thị hoặc ẩn; kéo thả khung ký; ảnh chữ ký tay / con dấu; mẫu chữ "Ký bởi / Ngày ký / Lý do / Nơi ký"; lưu nhiều mẫu | v0.3 |
| H5 | Tùy chọn ký | Lý do, nơi ký, liên hệ; mức PAdES (B-B, B-T, B-LT, B-LTA); cấu hình TSA (có sẵn danh sách TSA Việt Nam); SHA-256 | v0.3 |
| H6 | Ký chứng nhận (certify) | Khóa tài liệu, chọn mức quyền được phép sau khi ký | v0.3 |
| H7 | Nhiều người ký | Ký nối tiếp không phá chữ ký trước; tạo ô ký trống cho người khác | v0.3 |
| H8 | Ký hàng loạt | Chọn nhiều file, nhập PIN 1 lần, vị trí ký cố định (ví dụ góc phải trang cuối) | v0.3 |
| H9 | Kiểm tra chữ ký | Panel trạng thái (✅ hợp lệ / ⚠️ đã bị sửa / ❌ không tin cậy), chuỗi chứng thư, kiểm tra OCSP/CRL, xem phiên bản tài liệu lúc ký | v0.3 |
| H10 | Kho tin cậy | Nạp sẵn Root CA quốc gia Việt Nam, thêm/xóa chứng thư tin cậy | v0.3 |
| H11 | Báo cáo chữ ký | Xuất kết quả kiểm tra ra PDF | Sau 🤔 |

## I. Bảo mật

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| I1 | Đặt mật khẩu | Mật khẩu mở file; giới hạn quyền in/copy/sửa; AES-256 | v0.4 |
| I2 | Gỡ mật khẩu | Khi đã biết mật khẩu | v0.4 |
| I3 | Che thông tin mật | Chọn vùng hoặc chữ; tìm và che hàng loạt (số CCCD, số điện thoại, email); **xóa hẳn nội dung bên dưới** | v0.5 |
| I4 | Làm sạch tài liệu | Xóa metadata, JavaScript, file đính kèm, layer ẩn | v0.4 |

## J. Tối ưu & chuyển đổi

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| J1 | Nén PDF | Preset (màn hình / email / in ấn), giảm độ phân giải ảnh | v0.4 |
| J2 | PDF → ảnh | PNG / JPG / TIFF (TIFF nhiều trang), chọn DPI | v0.4 |
| J3 | Ảnh → PDF | Nhiều ảnh, sắp thứ tự, khổ giấy, lề, tự xoay theo EXIF | v0.4 |
| J4 | Trích xuất | Lấy toàn bộ ảnh, lấy text ra `.txt` | v0.4 |
| J5 | PDF/A để lưu trữ | Lưu ý giấy phép: không dùng Ghostscript | Sau |
| J6 | Office → PDF | Qua LibreOffice nếu máy có cài | Sau 🤔 |

## K. ★ Quy trình & xử lý hàng loạt

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| K1 | Trình tạo quy trình | Ghép các bước thành chuỗi (ví dụ: Ghép → Đánh số trang → Bản scan 200 dpi xám → Ký số → Lưu), lưu và chia sẻ dưới dạng file | v0.5 |
| K2 | Chạy hàng loạt | Áp dụng quy trình cho nhiều file hoặc cả thư mục, có thanh tiến độ và báo lỗi từng file | v0.5 |
| K3 | Thư mục tự động (hot folder) | Thả file vào thư mục là app tự chạy quy trình | v0.5 |
| K4 | Quy tắc đặt tên đầu ra | `{ten}_{ngay}_da-ky.pdf` | v0.5 |
| K5 | Dòng lệnh `chefpdf` | Dùng chung lõi xử lý, chạy được từ script | Sau 🤔 |
| K6 | Tự sắp xếp thứ tự an toàn | Bước "bản scan" luôn đứng trước "ký số" và có cảnh báo | v0.5 |

## L. So sánh tài liệu

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| L1 | So sánh chữ | Hai phiên bản cạnh nhau, tô màu chỗ thêm/xóa/sửa | Sau |
| L2 | So sánh hình | Chồng 2 trang lên nhau để thấy chỗ khác | Sau |

## M. Để sau / ý tưởng xa

| Mã | Tính năng | Bản |
|---|---|---|
| M1 | OCR (tiếng Việt, tiếng Anh) | Sau |
| M2 | Hệ thống plugin mở rộng | Sau 🤔 |
| M3 | Bản web rút gọn (không ký số), dùng lại giao diện React | Sau 🤔 |
