# Chef PDF: Cây tính năng

> **Trạng thái:** Bản nháp 3.1 (2026-10-31). Chủ dự án muốn liệt kê đủ tính năng trước, **lập kế hoạch và ước lượng dev sau**.
> Bản nháp 2 đã **đánh lại mã toàn bộ** so với bản nháp 1. Bản nháp 3 giữ nguyên mã cũ, chỉ thêm mã mới (riêng nhóm K được đánh lại vì mở rộng nhiều).
> Mỗi tính năng có mã (ví dụ `F4`) để tiện góp ý. Cột "Bản" là phiên bản dự kiến làm.
> ★ = tính năng chủ lực. = mới thêm ở bản nháp 2. 🤔 = chưa chắc có cần không, chờ chủ dự án quyết.

## Cách tổ chức

Cây chia thành **5 khu vực**, khớp với cách giao diện sẽ được bố trí: mỗi nhóm là một tab trên thanh công cụ hoặc một ô nhiệm vụ ở màn hình Start.

```
1. Nền tảng       A Khung app · B Xem & điều hướng
2. Trang          C Sắp xếp trang
3. Nội dung       D Chỉnh sửa chữ & đối tượng · E Lớp & gỡ watermark
                  F Watermark, con dấu & đánh số · G Ghi chú · H Form
4. Xuất & bảo vệ  I Chuyển thành bản scan · J Làm đẹp bản scan · K Ký số
                  L Bảo mật · M Tối ưu, chuyển đổi & sửa lỗi
                  Q Rã tài liệu & tái tạo định dạng
5. Tự động        N Quy trình & hàng loạt · O So sánh · P Để sau
```

Giao diện dự kiến: **Start** · tab **Xem** · **Trang** · **Chỉnh sửa** (D, E, F) · **Ghi chú** (G) · **Form** (H) · **Ký & Bảo vệ** (K, L) · **Xuất** (I, J, M, Q) · **Quy trình** (N).

## Lộ trình theo phiên bản

| Bản | Trọng tâm |
|---|---|
| v0.1 | Khung app, Start, xem PDF, tab, sắp xếp trang, build 3 OS |
| v0.2 | ★ Chuyển thành bản scan |
| v0.3 | ★ Ký số, **Studio mẫu chữ ký** (ảnh ký, tách nền, thông tin hiển thị, bố cục) và kiểm tra chữ ký |
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
| B9 🆕 | Đọc to | Đọc chữ trong PDF bằng giọng đọc có sẵn của hệ điều hành (có tiếng Việt nếu máy cài giọng Việt) | Sau 🤔 |
| B10 🆕 | Xem song song | Chia đôi màn hình xem 2 file hoặc 2 vị trí của cùng một file | v0.4 |

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
| C9 🆕 | Xóa trang trắng | Tự tìm và xóa trang trắng (hay gặp khi scan 2 mặt), có xem trước trước khi xóa | v0.4 |
| C10 🆕 | Chia đôi trang | Một trang A3 / trang đôi thành 2 trang A4; hoặc cắt trang thành lưới N phần | v0.4 |
| C11 🆕 | Trang dài | Ghép nhiều trang thành 1 trang dài (xem trên điện thoại) và ngược lại, cắt trang dài thành trang A4 | Sau 🤔 |
| C12 🆕 | Tách thông minh | Tách file theo nội dung: mỗi khi gặp trang có tiêu đề mới, mã QR phân cách, hoặc trang trắng phân cách | v0.4 |

---

# Khu vực 3: Nội dung

## D. Chỉnh sửa chữ & đối tượng

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| D1 | Thêm chữ | Hộp chữ mới, hỗ trợ đầy đủ tiếng Việt (nhúng font Unicode) | v0.4 |
| D2 | Thêm ảnh | Logo, ảnh, kéo thả lên trang | v0.4 |
| D3 | Chọn & sửa đối tượng | Click chọn chữ, ảnh hoặc hình vẽ có sẵn; di chuyển, đổi kích thước, xoay, xóa, đưa lên trên / xuống dưới | v0.5 |
| D4 | Tẩy vùng | Quét chọn một vùng rồi xóa toàn bộ nội dung bên trong (khác với che thông tin mật: không để lại ô đen) | v0.5 |
| D5 | Thay ảnh | Thay một ảnh trong PDF bằng ảnh khác, giữ nguyên vị trí và kích thước | v0.5 |
| D6 | **Sửa chữ có sẵn (mức dòng)** | Click vào dòng chữ để sửa. Dùng lại font gốc nếu font còn đủ ký tự; nếu thiếu (hay gặp với tiếng Việt) thì tự thay bằng font gần giống | v0.6 |
| D7 | **Sửa chữ có sẵn (mức đoạn)** | Gom các dòng thành đoạn văn, sửa và tự xuống dòng lại (reflow), đổi font/cỡ/màu/căn lề | v0.6 |
| D8 | Tìm & thay thế chữ | Thay một cụm từ trên toàn tài liệu, ví dụ đổi tên công ty, đổi ngày tháng | v0.6 |
| D9 | Liên kết | Thêm/sửa/xóa link (trang nội bộ, web, email) | v0.6 |
| D10 | Sửa mục lục | Thêm/sửa/xóa/sắp xếp bookmark | v0.4 |
| D11 🆕 | Chỉnh ảnh trong PDF | Cắt, xoay, lật, xóa nền ảnh, chỉnh sáng/tương phản ngay trong PDF, không cần app khác | v0.5 |
| D12 🆕 | Tự tạo mục lục | Dò các dòng có cỡ chữ lớn / in đậm (tiêu đề) để tạo bookmark tự động | Sau 🤔 |

## E. Lớp & gỡ watermark

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
| F3 | Con dấu ảnh | Ảnh con dấu / chữ ký tay, kéo thả, đổi cỡ, xoay. **Dùng chung thư viện và công cụ xử lý ảnh chữ ký & con dấu (K-C)** | v0.4 |
| F4 | Tách nền trắng cho ảnh dấu | Đã gộp vào K21 (xử lý ảnh chữ ký & con dấu). Đóng dấu ảnh ở F3 dùng luôn công cụ đó | v0.3 |
| F5 | **Dấu giáp lai** | Đóng một dấu cắt đều qua mép phải của nhiều trang, đúng kiểu văn bản hành chính Việt Nam. Chọn trang, vị trí theo chiều dọc, số phần cắt | v0.4 |
| F6 | Con dấu động | Dấu tự điền ngày giờ và tên người, ví dụ "ĐÃ NHẬN – 14:30 31/10/2026 – Nguyễn A" | v0.4 |
| F7 | Header / Footer | Chữ hoặc ảnh ở đầu/chân trang, trái/giữa/phải, có biến `{ngay}` `{tenfile}` `{trang}` `{tongtrang}` | v0.4 |
| F8 | Đánh số trang | Nhiều kiểu ("1", "Trang 1/10", "- 1 -", số La Mã), chọn vị trí, bỏ trang đầu, bắt đầu từ số bất kỳ. **Preset theo Nghị định 30/2020/NĐ-CP**: giữa lề trên, không đánh số trang đầu | v0.4 |
| F9 | Đánh số Bates | Mã tài liệu liên tục qua nhiều file (ví dụ HS-000001), dùng trong hồ sơ pháp lý | v0.4 |
| F10 | Quản lý & gỡ | Sửa hoặc gỡ watermark / header / footer / số trang mà Chef PDF đã thêm trước đó | v0.4 |
| F11 🆕 | Chồng lên giấy tiêu đề | Đặt nội dung PDF lên một mẫu giấy tiêu đề công ty (letterhead) là file PDF khác; chọn trang đầu / mọi trang | v0.4 |
| F12 🆕 | Mã QR / mã vạch | Chèn QR hoặc mã vạch (link, mã hồ sơ, số văn bản, thông tin tùy ý) lên trang, dùng được trong đánh số Bates | v0.4 |
| F13 🆕 | Chữ ký nháy | Đóng ảnh chữ ký nháy (ký tắt) lên góc mọi trang hoặc các trang chọn | v0.4 |

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

## J. Làm đẹp bản scan

Dành cho PDF vốn đã là bản scan hoặc ảnh chụp, không cần OCR.

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| J1 | Chỉnh nghiêng | Tự dò và xoay thẳng trang bị lệch | v0.7 |
| J2 | Cắt & nắn | Cắt viền thừa; nắn trang chụp bị xiên (méo hình thang) thành hình chữ nhật | v0.7 |
| J3 | Làm trắng nền | Biến nền giấy ngả vàng/xám thành trắng, chữ đậm và rõ hơn | v0.7 |
| J4 | Khử nhiễu, chỉnh sáng | Xóa chấm bẩn; chỉnh độ sáng, tương phản | v0.7 |
| J5 | Tách trang đôi | Ảnh chụp 2 trang sách mở thành 2 trang riêng | Sau 🤔 |
| J6 🆕 | Tách nhiều ảnh trên một bản scan | Scan nhiều hóa đơn / ảnh / thẻ trên một mặt kính → tự tách thành từng ảnh hoặc từng trang riêng | Sau 🤔 |
| J7 🆕 | **Chụp tài liệu bằng điện thoại** | App hiện mã QR, điện thoại quét mã (cùng mạng Wi-Fi, **không qua internet**) mở trang chụp, chụp xong ảnh gửi thẳng về máy tính, tự cắt và nắn thẳng (J2). Không cần cài app trên điện thoại. Thay thế máy scan | v0.7 |

## K. ★ Ký số

Nhóm này được **đánh lại mã** ở bản nháp 3 và chia thành 5 phần nhỏ. Số có chừa khoảng trống để sau này chèn thêm.

### K-A. Nguồn chứng thư

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| K1 | USB token | Qua PKCS#11; chọn chứng thư nếu token có nhiều. Hỗ trợ token của **cả CA công cộng** (Viettel-CA, VNPT-CA, FPT-CA, MISA-CA, Bkav-CA, CA2, EFY-CA, NewTel-CA, SAFE-CA, SmartSign, TrustCA, FastCA, CMC-CA…) **và CA chuyên dùng Chính phủ** (Ban Cơ yếu). Xem [TOKENS.md](TOKENS.md) | v0.3 |
| K2 | File chứng thư | `.pfx` / `.p12`, có tùy chọn ghi nhớ (mật khẩu lưu trong kho bảo mật của hệ điều hành) | v0.3 |
| K3 | Kho chứng thư hệ điều hành | Windows Certificate Store (CNG/CSP), macOS Keychain. Là **đường dự phòng** cho token chỉ có driver CSP trên Windows, không có PKCS#11 | Sau 🤔 |
| K4 | Ký từ xa qua cloud | VNPT SmartCA, Viettel MySign… | Sau |
| K5 🆕 | Thông tin chứng thư | Xem chi tiết: chủ sở hữu, đơn vị cấp, hạn dùng, **MST / CCCD** (CA Việt Nam thường ghi trong chứng thư); **nhắc trước khi chứng thư hết hạn** | v0.3 |
| K6 🆕 | Danh bạ driver token | File dữ liệu liệt kê tên và đường dẫn thư viện PKCS#11 của từng CA, từng đời token, trên từng OS. Cập nhật được mà không cần ra bản app mới | v0.3 |
| K7 🆕 | Tự dò & quét driver | Cắm token là app dò theo danh bạ (K6). Không thấy thì nút "Quét tìm driver": thử nạp các thư viện nghi là PKCS#11 trong thư mục hệ thống, giữ lại cái nào thấy token. Vẫn cho chọn file thủ công | v0.3 |
| K8 🆕 | **Chẩn đoán token** | Một màn hình kiểm tra từng bước: đã thấy token chưa → đã nạp driver chưa → có chứng thư không → chứng thư còn hạn không → chuỗi chứng thư có tin cậy không. Mỗi lỗi có hướng dẫn sửa bằng tiếng Việt và link tải driver của đúng CA | v0.3 |
| K9 🆕 | Cảnh báo PIN | Báo khi token báo "còn ít lần nhập PIN" hoặc "lần nhập cuối" trước khi bị khóa; không bao giờ tự thử lại PIN sai | v0.3 |

### K-B. 🆕 Studio mẫu chữ ký (giao diện chữ ký)

Tham khảo hộp thoại "Configure Signature Style" của Foxit, cộng thêm các nhu cầu riêng ở Việt Nam. **Xem trước trực tiếp** khi chỉnh, lưu được nhiều mẫu.

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| K10 | Quản lý mẫu | Tạo / sửa / nhân bản / xóa mẫu; đặt mẫu mặc định; **gắn mẫu với từng chứng thư** (cắm token nào thì tự chọn mẫu đó); xuất/nhập mẫu ra file để dùng ở máy khác | v0.3 |
| K11 | Thông tin hiển thị | Tích chọn từng dòng: **Người ký**, Đơn vị/Tổ chức, Chức vụ, Email, MST/CCCD, **Ngày ký**, **Lý do**, **Nơi ký**, Liên hệ, Tên đầy đủ trong chứng thư (DN), dòng chữ tùy ý. Bật/tắt nhãn ("Ký bởi:", "Ngày ký:"…) và sửa được chữ của nhãn | v0.3 |
| K12 | Nguồn dữ liệu cho từng dòng | Mặc định **lấy tự động từ chứng thư** (tên, đơn vị, email, MST). Có thể ghi đè chữ hiển thị, nhưng panel kiểm tra (K40) luôn hiện thông tin thật trong chứng thư | v0.3 |
| K13 | Định dạng ngày giờ | `dd/MM/yyyy HH:mm:ss`, `dd/MM/yyyy`, "Ngày 31 tháng 10 năm 2026", có/không múi giờ (GMT+7); chọn lấy giờ máy hay giờ máy chủ dấu thời gian (TSA) | v0.3 |
| K14 | Lý do & nơi ký | Danh sách lý do có sẵn ("Tôi đồng ý với nội dung", "Phê duyệt", "Xác nhận đã xem"…), tự nhớ lý do đã nhập; nơi ký đặt sẵn trong cài đặt (ví dụ "Hà Nội") | v0.3 |
| K15 | Bố cục | Preset: ảnh trái + chữ phải / ảnh trên + chữ dưới / chỉ ảnh / chỉ chữ / **ảnh mờ làm nền phía sau chữ** / ảnh chữ ký + con dấu chồng lên nhau. Chỉnh tỉ lệ ảnh/chữ, lề, căn lề | v0.3 |
| K16 | Kiểu chữ & màu | Font (có font tiếng Việt đóng gói sẵn), cỡ chữ (hoặc **tự co chữ cho vừa khung**), màu chữ, đậm/nghiêng, khung viền, màu nền / nền trong suốt | v0.3 |
| K17 | Biểu tượng hợp lệ | Tùy chọn hiện dấu ✓ kiểu "Signature Valid" thường thấy trên hóa đơn điện tử Việt Nam | v0.3 |
| K18 | Logo | Thêm logo công ty bên cạnh hoặc làm nền mờ | v0.3 |

### K-C. 🆕 Ảnh chữ ký & con dấu

Thư viện ảnh **dùng chung** cho ký số (K-B), đóng dấu ảnh (F3), chữ ký nháy (F13) và dấu giáp lai (F5).

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| K20 | Tạo ảnh chữ ký | Nhập ảnh có sẵn; **vẽ bằng chuột / bút cảm ứng / bảng vẽ** (bút có độ nhạy lực); gõ tên rồi chọn font chữ viết tay; chụp bằng điện thoại qua QR (giống J7) | v0.3 |
| K21 | **Tách nền tự động** | Bỏ nền giấy (trắng, ngả vàng, có bóng do chụp điện thoại), giữ nét mực trong suốt. Có thanh chỉnh độ nhạy và **xem trước trên nền caro** để thấy rõ vùng trong suốt. Tự nhận màu mực (đỏ của con dấu, xanh/đen của chữ ký) | v0.3 |
| K22 | Làm sạch & chỉnh | Tự cắt sát nét mực, xoay, thẳng góc; xóa chấm bẩn; **đổi màu mực** (đen → xanh, làm đỏ con dấu tươi hơn); làm nét đậm hoặc mảnh đi; chỉnh độ mờ | v0.3 |
| K23 | Tách chữ ký và con dấu | Ảnh chụp có cả chữ ký xanh đè lên con dấu đỏ → tách thành 2 ảnh riêng theo màu | v0.3 🤔 |
| K24 | Chuyển thành vector | Biến ảnh chữ ký/dấu thành nét vector, phóng to bao nhiêu cũng nét, file nhẹ | Sau 🤔 |
| K25 | Bảo vệ thư viện | Ảnh chữ ký/con dấu được **mã hóa** khi lưu trên máy; tùy chọn hỏi mật khẩu hoặc vân tay/Windows Hello/Touch ID trước khi dùng | v0.3 |

### K-D. Đặt chữ ký & ký

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| K30 | Đặt chữ ký | Kéo thả khung ký lên trang; hoặc ký ẩn (không hiện trên trang); hoặc ký vào ô ký có sẵn | v0.3 |
| K31 🆕 | **Đặt theo chữ mốc** | Tìm một cụm chữ (ví dụ "NGƯỜI KÝ", "GIÁM ĐỐC") rồi đặt chữ ký ngay dưới/cạnh nó. Rất hữu ích khi ký hàng loạt các file có vị trí ký khác nhau | v0.3 |
| K32 | Vị trí cố định | Góc phải trang cuối, trang đầu, mọi trang, trang chỉ định; lưu vị trí thành preset | v0.3 |
| K33 | Tùy chọn kỹ thuật | Mức PAdES (B-B, B-T, B-LT, B-LTA); máy chủ dấu thời gian TSA (có sẵn danh sách TSA Việt Nam, có dự phòng khi một máy chủ lỗi); thuật toán SHA-256 | v0.3 |
| K34 | Ký chứng nhận (certify) | Khóa tài liệu, chọn mức quyền được phép sau khi ký | v0.3 |
| K35 | Nhiều người ký | Ký nối tiếp không phá chữ ký trước; tạo ô ký trống cho người khác | v0.3 |
| K36 | Ký hàng loạt | Chọn nhiều file, nhập PIN 1 lần, kết hợp K31 / K32 | v0.3 |
| K37 🆕 | Ký kèm đóng dấu | Một lần bấm: ký số + đóng dấu giáp lai (F5) + chữ ký nháy mọi trang (F13) | v0.4 |
| K38 🆕 | Sau khi ký | Tự đặt tên file (`_da-ky`), mở panel kiểm tra, mở thư mục chứa file | v0.3 |

### K-E. Kiểm tra chữ ký

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| K40 | Kiểm tra chữ ký | Panel trạng thái (✅ hợp lệ / ⚠️ đã bị sửa / ❌ không tin cậy), chuỗi chứng thư, kiểm tra OCSP/CRL, xem phiên bản tài liệu lúc ký | v0.3 |
| K41 | Kho tin cậy | Nạp sẵn **2 hệ Root CA Việt Nam**: Root CA quốc gia (NEAC, cho CA công cộng) và Root CA chuyên dùng Chính phủ (Ban Cơ yếu, rootca.gov.vn). Thêm/xóa chứng thư tin cậy | v0.3 |
| K42 | Báo cáo chữ ký | Xuất kết quả kiểm tra ra PDF | Sau 🤔 |
| K43 🆕 | Kiểm tra hàng loạt | Kiểm tra chữ ký của cả thư mục, xuất bảng kết quả ra Excel/CSV | v0.4 |

## L. Bảo mật

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| L1 | Đặt mật khẩu | Mật khẩu mở file; giới hạn quyền in/copy/sửa; AES-256 | v0.4 |
| L2 | Gỡ mật khẩu | Khi đã biết mật khẩu | v0.4 |
| L3 | Che thông tin mật | Chọn vùng hoặc chữ; tìm và che hàng loạt (số CCCD, số điện thoại, email, số tài khoản); **xóa hẳn nội dung bên dưới** | v0.5 |
| L4 | Gỡ dữ liệu ẩn | Xóa metadata, JavaScript, file đính kèm, lớp ẩn, ghi chú, lịch sử sửa (bản lưu ghi thêm) | v0.4 |
| L5 🆕 | Soi file | Báo cáo file chứa gì: JavaScript, link ra ngoài, file đính kèm, form, chữ ký, font chưa nhúng, lớp ẩn, phiên bản PDF. Giúp phát hiện file đáng ngờ | v0.4 |
| L6 🆕 | **Kiểm tra trước khi gửi** | Một nút chạy checklist: còn metadata/tên tác giả không, còn ghi chú chưa xóa, form chưa làm phẳng, dung lượng có vượt giới hạn (ví dụ 5MB / 10MB / 25MB) không, chữ ký còn hợp lệ không. Bấm để sửa từng mục | v0.4 |

## M. Tối ưu, chuyển đổi & sửa lỗi

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| M1 | Nén PDF | Preset (màn hình / email / in ấn), giảm độ phân giải ảnh, bỏ đối tượng thừa, rút gọn font | v0.4 |
| M2 | PDF → ảnh | PNG / JPG / TIFF (TIFF nhiều trang), chọn DPI | v0.4 |
| M3 | Ảnh → PDF | Nhiều ảnh, sắp thứ tự, khổ giấy, lề, tự xoay theo EXIF | v0.4 |
| M4 | Trích xuất | Lấy toàn bộ ảnh gốc, lấy text ra `.txt` | v0.4 |
| M5 | Sửa file PDF hỏng | Thử khôi phục file lỗi, không mở được | v0.4 |
| M6 | File đính kèm | Xem, thêm, xóa, lưu ra các file nhúng trong PDF | v0.4 |
| M7 | Tối ưu cho web | Linearize: mở trang đầu nhanh khi xem qua mạng | v0.4 |
| M8 | Sửa metadata | Tiêu đề, tác giả, chủ đề, từ khóa | v0.4 |
| M9 | PDF/A để lưu trữ | Lưu ý giấy phép: không dùng Ghostscript | Sau |
| M10 | Office → PDF | Qua LibreOffice nếu máy có cài | Sau 🤔 |
| M11 | Máy in ảo "Chef PDF" | In từ bất kỳ app nào ra PDF. Khó làm đều trên 3 OS | Sau 🤔 |
| M12 🆕 | Chuyển đổi màu | Chuyển sang thang xám / đen trắng (vẫn giữ chữ, khác với I2); **tiết kiệm mực in** (nền tối thành trắng); thay một màu bằng màu khác | v0.4 |
| M13 🆕 | Web / Markdown / HTML → PDF | Dán link trang web hoặc file Markdown/HTML để xuất ra PDF đẹp (Electron có sẵn bộ in của Chromium nên làm rất rẻ) | v0.4 |
| M14 🆕 | Ảnh chụp màn hình → PDF | Dán ảnh từ clipboard thành trang mới, hoặc chụp màn hình trực tiếp | v0.4 |
| M15 🆕 | Bảng → Excel/CSV | Trích bảng trong PDF có chữ (không cần OCR) ra Excel/CSV | Sau 🤔 |
| M16 🆕 | Xuất ảnh cho mạng xã hội | Xuất từng trang thành ảnh vừa khổ Zalo / Facebook, tùy chọn ghép nhiều trang thành 1 ảnh dài | Sau 🤔 |

## Q. 🆕 Rã tài liệu & tái tạo định dạng

Rã PDF (có chữ hoặc scan) thành một **mô hình tài liệu** gồm tiêu đề, đoạn, danh sách, bảng, hình, chú thích, kèm vị trí và độ tin cậy. Từ mô hình đó xuất ra Markdown, Word, HTML… Markdown chỉ là **một trong các định dạng xuất**, không phải định dạng trung gian, vì Markdown làm mất bố cục (cột, vị trí, font, màu).

Cột "Bản": **v0.8** = làm được với PDF có chữ, không cần OCR. **OCR** = thuộc giai đoạn OCR sau này.

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| Q1 | Rã PDF có chữ | Lấy chữ kèm font, cỡ, đậm/nghiêng; gom thành dòng → đoạn; nhận tiêu đề theo cỡ chữ; danh sách; link; tách ảnh; xác định thứ tự đọc, kể cả văn bản nhiều cột | v0.8 |
| Q2 | Nhận dạng bố cục | Dùng mô hình chạy offline trên máy để nhận vùng: tiêu đề, đoạn, bảng, hình, chú thích ảnh, header/footer/số trang (bỏ khi xuất) | v0.8 |
| Q3 | Nhận dạng bảng | Bảng có kẻ và không kẻ, ô gộp → bảng Markdown/HTML/Excel | v0.8 |
| Q4 | OCR cho PDF scan và ảnh | Tiếng Việt + Anh. Phát hiện vùng chữ, sau đó nhận dạng chữ có dấu (tham khảo PaddleOCR + VietOCR, Tesseract làm dự phòng) | OCR |
| Q5 | Lọc con dấu & chữ ký trước khi OCR | Bỏ con dấu đỏ, chữ ký xanh đè lên chữ (dùng công cụ tách màu ở K23) để OCR không đọc sai | OCR |
| Q6 | Nhận diện văn bản hành chính VN | Nhận các phần quốc hiệu, tiêu ngữ, cơ quan ban hành, số/ký hiệu, ngày tháng, trích yếu, nơi nhận, người ký → xuất Word đúng thể thức | OCR 🤔 |
| Q7 | **Màn hình kiểm tra & sửa** | Ảnh gốc một bên, kết quả một bên, click chỗ nào nhảy tới chỗ đó. **Tô vàng chữ có độ tin cậy thấp**, phím tắt nhảy tới chữ đáng ngờ tiếp theo, sửa trực tiếp, sửa cả loại vùng (đoạn ↔ bảng ↔ hình) | v0.8 |
| Q8 | Xuất định dạng | Markdown (kèm thư mục ảnh), DOCX, HTML, EPUB, ODT, TXT, XLSX (chỉ lấy bảng), JSON | v0.8 |
| Q9 | Hai chế độ xuất Word | **"Dễ chỉnh sửa"**: văn bản chảy tự nhiên, dùng style Heading. **"Giữ bố cục"**: dùng khung định vị và cột để giống bản gốc nhất có thể | v0.8 |
| Q10 | PDF tìm kiếm được | Giữ ảnh scan, thêm lớp chữ ẩn bên dưới để tìm kiếm và copy được | OCR |
| Q11 | Làm mới tài liệu | Dàn trang lại thành PDF sạch, font đẹp từ mô hình tài liệu, ví dụ biến bản scan mờ thành văn bản như mới | v0.8 |
| Q12 | Trình sửa Markdown tích hợp | Sửa file Markdown, xem trước, xuất lại ra các định dạng | Sau 🤔 |
| Q13 | Công thức toán | Nhận công thức thành LaTeX | Sau 🤔 |
| Q14 | Gói nhận dạng tải riêng | Các mô hình bố cục/bảng/OCR (vài trăm MB) **không đi kèm bản cài chính**, tải khi cần. Tùy chọn dùng GPU nếu máy có | v0.8 |
| Q15 | Hàng loạt | Rã cả thư mục; dùng làm một bước trong Quy trình (N) | v0.8 |

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
| N7 🆕 | Đổi tên file hàng loạt | Theo mẫu (`{so}_{tieude}_{ngay}`), theo tiêu đề trong metadata, hoặc theo dòng chữ đầu tiên của trang 1 | v0.7 |
| N8 🆕 | Quy trình mẫu có sẵn | Ví dụ "Nộp hồ sơ online": ghép → bản scan 200 dpi xám → nén ≤ 5MB → ký số; "Phát hành văn bản": đánh số theo NĐ 30 → ký số → đóng dấu giáp lai | v0.7 |
| N9 🆕 | Kéo thả vào biểu tượng | Kéo file thả lên một quy trình ở màn hình Start là chạy luôn | v0.7 |

## O. So sánh tài liệu

| Mã | Tính năng | Chi tiết | Bản |
|---|---|---|---|
| O1 | So sánh chữ | Hai phiên bản cạnh nhau, tô màu chỗ thêm/xóa/sửa | Sau |
| O2 | So sánh hình | Chồng 2 trang lên nhau để thấy chỗ khác | Sau |

## P. Để sau / ý tưởng xa

| Mã | Tính năng | Bản |
|---|---|---|
| P1 | OCR (tiếng Việt, tiếng Anh). Chi tiết nằm trong nhóm Q | Sau |
| P2 | Quét trực tiếp từ máy scan (TWAIN/WIA trên Windows, ICA trên macOS, SANE trên Linux) | Sau 🤔 |
| P3 | PDF hỗ trợ người khiếm thị (tagged PDF / PDF/UA) | Sau 🤔 |
| P4 | Hệ thống plugin mở rộng | Sau 🤔 |
| P5 | Bản web rút gọn (không ký số), dùng lại giao diện React | Sau 🤔 |
| P7 🆕 | Tạo hóa đơn / văn bản từ mẫu (PDF24 có công cụ tạo hóa đơn) | Sau 🤔 |
| P8 🆕 | Bản di động (portable) chạy từ USB, không cần cài đặt | Sau 🤔 |
