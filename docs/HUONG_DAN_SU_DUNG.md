# Chef PDF: Hướng dẫn sử dụng (bản 1.0, Windows)

> Hướng dẫn này khớp với bản 1.0 chạy trên **Windows**. macOS và Linux để sau bản 1.0 (D37).
> Tên lệnh và nút trong hướng dẫn là đúng như hiển thị trong ứng dụng.

## 1. Cài đặt trên Windows

Bộ cài là file `chef-pdf-<phiên bản>-setup-x64.exe`. Chỉ cài từ file bạn đã tự build hoặc nhận từ người bạn tin cậy.

1. Chạy file `setup-x64.exe`, chọn thư mục cài nếu được hỏi, rồi mở **Chef PDF** từ Start hoặc shortcut trên Desktop.
2. Ứng dụng **chưa được ký mã** (chỉ dùng cá nhân), nên Windows SmartScreen có thể chặn lần đầu. Chọn **Thêm thông tin → Vẫn chạy** để tiếp tục.
3. Nếu Windows hoặc phần mềm bảo mật cách ly file, kiểm tra nguồn file trước khi khôi phục. Không tắt chế độ bảo vệ của Windows để cài.

Cập nhật: cài bản mới đè lên bản cũ. Tự cập nhật chưa có trong bản 1.0.

Dữ liệu (phiên làm việc, nhật ký, cài đặt) nằm trong thư mục dữ liệu của người dùng Windows, không gửi đi đâu. Nhật ký lõi nằm trong thư mục `logs` của dữ liệu ứng dụng; cần hỗ trợ thì gửi file đó.

## 2. Làm quen

- **Màn hình Start**: các ô nhiệm vụ (Mở PDF, Ghép, Tách, Quét…), file gần đây và quy trình đã lưu. Kéo file PDF vào cửa sổ để mở.
- **Ctrl+K**: bảng lệnh. Gõ tên lệnh, có thể gõ không dấu (ví dụ `chinh khe gay`).
- **Tab tài liệu**: mỗi file mở trong một tab. Nút **Lưu** ghi đè file gốc; **Lưu thành…** ghi ra file mới. Tab có dấu chấm là còn thay đổi chưa lưu.
- **Hoàn tác / Làm lại**: Ctrl+Z / Ctrl+Y, theo phiên làm việc. Hoàn tác không sửa file gốc cho tới khi bạn Lưu.
- Thanh công cụ thay đổi theo ngữ cảnh: Xem, Trang, Chỉnh sửa, Ghi chú, Form, Ký & Bảo mật, Xuất, Quy trình.

Mọi xử lý diễn ra trên máy bạn. Ứng dụng không tải file lên mạng.

## 3. Xem và tìm

- Chọn chế độ xem một trang, liên tục, hai trang, sách, hoặc trình chiếu.
- **Ctrl+F**: tìm chữ có tô sáng; tìm không dấu được (ví dụ `nghi dinh` tìm `nghị định`).
- Chọn và copy chữ như trong trình đọc thông thường. **Chụp một vùng thành ảnh** cho ảnh một vùng trang.
- Thanh bên có thumbnail và mục lục.

## 4. Trang

Tab **Trang** hiển thị lưới thumbnail:

- Kéo thả để đổi thứ tự; chọn nhiều trang bằng Shift/Ctrl+click.
- Xoay, xóa, nhân bản, trích, chèn trang trắng, chèn từ file hoặc ảnh.
- Chuột phải trên các trang đã chọn: **Tạo PDF từ N trang đã chọn** ghi ra file mới và mở ở tab mới (file gốc không đổi); đóng dấu, nén hoặc xuất ảnh đúng các trang đó.
- **Ghép** file (có tạo mục lục theo tên file) và **Tách** file (theo khoảng, mỗi N trang, dung lượng, chẵn/lẻ) có trên Start.
- Lệnh **Làm phẳng trang cong…**: nắn trang sách bị cong; xem trước trước khi áp dụng.

## 5. Chụp sách và ảnh scan

- **Chụp bằng điện thoại** (lệnh cùng tên): ứng dụng tạo mã QR và địa chỉ LAN. Mở địa chỉ trên điện thoại cùng mạng Wi-Fi rồi chụp từng trang; ảnh về máy được cắt, tách trang đôi, nắn và làm trắng theo cài đặt. Chỉ hoạt động khi điện thoại và máy tính cùng mạng.
- **Chỉnh khe gáy (tách trang đôi)…**: xem khe gáy tự dò trên trang đôi; có thể kéo đường khe bằng tay rồi tách theo vị trí đó.
- **Xóa ngón tay…**: chọn trang, bấm **Đề xuất vùng ngón tay** để thấy các vùng đỏ; dùng cọ **Tô thêm vùng** hoặc **Bỏ tô** để chỉnh, rồi **Xóa ngón tay**. Vùng xóa được tô bằng màu giấy.
- **Tẩy vùng và xóa vết màu…**: kéo khung trên trang để tẩy vùng (tô giấy hoặc trắng); hoặc chọn mực cần xóa (bút xanh, bút dạ quang vàng, con dấu đỏ).
- **Chỉnh ảnh trang (mức, đường cong, DPI)…**: làm trắng nền, khử nhiễu, mức đen/trắng và gamma, đường cong 5 điểm, tương phản, độ sáng, đảo màu, thang xám, đổi DPI. Bấm **Xem trước** để so sánh trước và sau trên một trang.
- **Cắt lề / đổi khổ** và **cắt hàng loạt**: kéo 4 góc hoặc khung chữ nhật, nắn phối cảnh; trong cắt hàng loạt có **Duyệt lần lượt** các trang chưa đạt, có kính lúp khi chỉnh góc.

Các thao tác này không sửa file gốc cho tới khi bạn Lưu. Trang đã ký không chỉnh được.

## 6. Nội dung, ghi chú, form

- **Sửa chữ**: chọn dòng hoặc đoạn, sửa chữ; nếu font trong file không có ký tự tiếng Việt, ứng dụng cảnh báo và thay font gần giống.
- **Tìm và thay thế** cả tài liệu; **Liên kết** thêm, sửa, xóa.
- **Gỡ logo chìm / watermark**: dò ứng viên, xem trước, tích chọn trang trước khi xóa.
- **Che thông tin mật**: tìm CCCD, số điện thoại, email, số tài khoản; xóa thật nội dung bên dưới (kiểm tra bằng cách copy chữ sau khi che).
- **Ghi chú**: tô sáng, gạch chân, gạch ngang, ghi chú dán, vẽ. Danh sách ghi chú để lọc, trả lời, xuất CSV, làm phẳng.
- **Form**: điền form có sẵn; tạo trường chữ, checkbox, radio, dropdown, ô ký; làm phẳng để khóa.
- **Đánh số trang** theo Nghị định 30/2020/NĐ-CP, header/footer có biến, đóng dấu, chữ ký nháy, giáp lai, watermark, mã QR/vạch, giấy tiêu đề.

## 7. Ký số

Các lệnh ký nằm trong tab **Ký & Bảo mật**:

- Ký bằng **USB token** của CA Việt Nam (Viettel-CA đã thử thành công trên Windows) hoặc file `.pfx`/`.p12`.
- Mở **Chẩn đoán token** nếu token không được nhận; ứng dụng hướng dẫn từng bước và cảnh báo khi PIN sắp khóa.
- Mẫu chữ ký (**Studio mẫu chữ ký**) và thư viện ảnh chữ ký/con dấu: nhập ảnh, vẽ, hoặc gõ chữ viết tay; nền được tách tự động.
- Ký hàng loạt nhập PIN một lần.
- **Kiểm tra chữ ký** cho biết trạng thái, chuỗi chứng thư và thời điểm ký.

Chữ ký hợp lệ với Adobe Reader phụ thuộc chuỗi tin cậy (xem `docs/TOKENS.md`). Đừng coi một file là hợp lệ chỉ vì ứng dụng tạo được chữ ký; hãy mở lại bằng Adobe Reader hoặc Foxit.

## 8. Quy trình, thư mục tự động, rã tài liệu

- **Tạo quy trình**: ghép các bước từ các hộp thoại. Nút **Lưu thành bước quy trình** trong các hộp thoại có tham số chung thêm bước vào quy trình. Quy trình lưu thành file JSON, dùng lại được. Quy trình mẫu: **Nộp hồ sơ online** (ghép, raster 200 dpi xám, nén tối đa 4 MB, ký), **Rã tài liệu ra Word**, **Phát hành văn bản**, **Chụp sách**.
- **Thư mục tự động** (lệnh cùng tên): chọn quy trình, thư mục nguồn và thư mục đầu ra. Thả file vào thư mục nguồn, ứng dụng chạy quy trình. Quy trình **ghép** chạy một lần trên cả đợt file đã sẵn sàng (cần ít nhất 2 PDF); quy trình từng file chạy riêng từng file, file lỗi không dừng đợt. Dùng thư mục đầu ra khác thư mục nguồn.
- **Rã tài liệu**: PDF có chữ được phân tích bố cục (cột, tiêu đề, bảng kẻ, header/footer), rồi xuất ra **DOCX** chế độ *giữ bố cục* hoặc *dễ chỉnh sửa*, Markdown, HTML, TXT, JSON, EPUB, ODT, XLSX. Mở **Kiểm tra bố cục** để đổi loại vùng trước khi xuất. PDF scan chỉ có ảnh không rã được chữ (không có OCR trong bản 1.0).

## 9. Xuất, nén, bảo mật

- **Nén PDF** theo preset hoặc đến dung lượng mục tiêu (ví dụ ≤ 2 MB).
- **Chuyển thành bản scan**: 200 dpi, xám hoặc đen trắng, có hiệu ứng scan; cảnh báo mất chữ, liên kết, form và chữ ký.
- **Đặt mật khẩu**, giới hạn quyền, AES-256; **Gỡ dữ liệu ẩn**; **Soi file**; **Kiểm tra trước khi gửi** (danh sách việc cần sửa).
- Chuyển đổi: PDF ↔ ảnh, ảnh/clipboard/màn hình → PDF, Web/HTML → PDF.

## 10. Phiên làm việc và khôi phục

- Đóng tab còn thay đổi: ứng dụng hỏi lưu, bỏ, hay hủy.
- Nếu máy hoặc ứng dụng dừng đột ngột, lần mở sau hỏi có khôi phục phiên không. Khôi phục đưa về bản sửa gần nhất còn đọc được.
- Mật khẩu không được lưu trong phiên khôi phục; khôi phục file mã hóa cần đặt lại mật khẩu trước khi lưu.

## 11. Giới hạn đã biết (bản 1.0)

- Không có OCR và không có AI: không biến ảnh scan thành chữ tìm được.
- Chỉ thử trên Windows. macOS và Linux chưa hỗ trợ trong bản này.
- Tự cập nhật chưa có: cài bản mới đè lên.
- Chữ ký: đã ký thành công bằng Viettel-CA trên một máy; chưa kiểm chứng trên mọi token/CA, và cần kiểm tra file bằng Adobe Reader trước khi nộp.
- Ứng dụng không ký mã; SmartScreen sẽ cảnh báo khi cài lần đầu.
- Làm phẳng trang cong và xóa ngón tay là đề xuất bằng thuật toán; luôn xem trước và chỉnh tay khi kết quả chưa đúng.
