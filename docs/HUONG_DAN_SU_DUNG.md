# Chef PDF: Hướng dẫn sử dụng

> Tài liệu này mô tả ứng dụng theo mã nguồn hiện có. Hình thức cảnh báo cài đặt thay đổi theo phiên bản hệ điều hành và chính sách của máy; các bước bên dưới không đồng nghĩa với việc Chef PDF đã được kiểm thử thủ công trên mọi máy.

## 1. Cài đặt

> **Bản 1.0 chỉ được kiểm thử trên Windows.** Các phần macOS và Linux dưới đây chỉ là hướng dẫn tham khảo, chưa kiểm thử.

Chỉ mở bộ cài lấy từ nguồn mà bạn tin cậy. Cấu hình phát hành hiện tạo bộ cài Windows `.exe`, macOS `.dmg` cho Intel và Apple Silicon, cùng Linux `.AppImage`, `.deb`, `.rpm`. Quy trình build nằm trong [release workflow](../.github/workflows/release.yml); khi CI phát hành, hãy dùng đúng gói cho hệ điều hành và kiến trúc máy.

Ứng dụng chưa được ký bằng chứng thư nhà phát triển. macOS dùng chữ ký ad-hoc để chạy trên Apple Silicon, nhưng không notarize. Vì vậy Windows hoặc macOS có thể hiện cảnh báo. Hãy kiểm tra nguồn file trước khi cho phép mở; không tắt SmartScreen, Gatekeeper hay phần mềm bảo vệ toàn hệ thống.

### Windows

1. Mở file cài `.exe` từ nguồn tin cậy, chọn thư mục cài nếu được hỏi, rồi mở Chef PDF từ Start hoặc shortcut.
2. Windows có thể hiện cảnh báo SmartScreen vì ứng dụng chưa có danh tiếng/chứng thư nhà phát hành. Nếu Windows hiện tùy chọn cho phép chạy, chỉ tiếp tục khi bạn đã xác minh đúng nguồn file. Một số chế độ bảo vệ hoặc chính sách của cơ quan có thể chặn ứng dụng không ký và không có lựa chọn bỏ qua; không tắt chế độ bảo vệ để cài. Xem [giải thích Smart App Control của Microsoft](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions).
3. Nếu file bị Windows hoặc phần mềm bảo mật xóa/cách ly, kiểm tra nguồn và lịch sử bảo vệ trước; không khôi phục file khi chưa xác minh.

### macOS

1. Mở `.dmg`, kéo **Chef PDF.app** vào **Applications**, eject ảnh đĩa, rồi mở ứng dụng.
2. Nếu Gatekeeper chặn lần đầu, mở **System Settings → Privacy & Security**, tìm thông báo chặn ứng dụng, chọn **Open Anyway**, rồi xác nhận mở ứng dụng ở hộp thoại tiếp theo. Tên/vị trí mục có thể khác theo phiên bản macOS; máy do cơ quan quản lý có thể không cho phép ngoại lệ. Hướng dẫn hiện hành của [Apple](https://support.apple.com/en-gb/102445).
3. Chỉ khi bạn tin cậy bộ cài và cách mở ở trên không khả dụng, có thể gỡ thuộc tính quarantine cho riêng ứng dụng đã cài bằng Terminal:

   ```bash
   xattr -dr com.apple.quarantine "/Applications/Chef PDF.app"
   ```

   Lệnh này không ký hoặc notarize ứng dụng. Không chạy lệnh với đường dẫn bạn không nhận diện.

### Linux

- **AppImage:** đặt file ở thư mục bạn muốn, cấp quyền thực thi rồi chạy:

  Ví dụ với tên gói hiện tại:

  ```bash
  chmod +x ./chef-pdf-0.1.0-linux-x64.AppImage
  ./chef-pdf-0.1.0-linux-x64.AppImage
  ```

  Nếu tên file tải xuống khác, thay tên trong hai lệnh bằng đúng tên file đó.

  Cách chạy này theo [AppImage Quickstart](https://docs.appimage.org/introduction/quickstart.html). Nếu báo thiếu FUSE, cài gói FUSE phù hợp với bản phân phối Linux của bạn; hướng dẫn phụ thuộc distro trong [AppImage troubleshooting](https://docs.appimage.org/user-guide/troubleshooting/fuse.html).
- **Debian/Ubuntu:** mở file `.deb` bằng trình cài gói của hệ thống hoặc cài bằng trình quản lý gói để hệ thống xử lý phụ thuộc.
- **Fedora/RHEL và distro tương thích:** mở `.rpm` bằng trình cài gói hoặc dùng trình quản lý gói của distro.

Build Linux hiện nhắm `x64`; file macOS được build riêng cho `x64` và `arm64`; Windows build `x64`. Máy dùng kiến trúc khác không được bảo đảm chạy.

## 2. Mở và xem PDF

1. Ở màn hình **Start**, chọn **Mở PDF**; hoặc kéo file PDF vào cửa sổ ứng dụng. Có thể mở nhiều tài liệu thành các tab riêng.
2. PDF có mật khẩu sẽ hỏi mật khẩu khi mở. File hỏng có thể được chuyển sang công cụ sửa file nếu ứng dụng nhận diện được khả năng khôi phục.
3. Dùng `Ctrl+F` (Windows/Linux) hoặc `⌘F` (macOS) để tìm chữ; dùng chế độ xem/zoom trên thanh công cụ để đổi kiểu hiển thị. Tìm không dấu hỗ trợ các truy vấn như `nghi dinh` cho `nghị định` khi PDF có lớp chữ.
4. Mở `Ctrl+K` (Windows/Linux) hoặc `⌘K` (macOS) để tìm lệnh theo tên; có thể gõ không dấu.

PDF scan chỉ chứa ảnh thì chưa tìm kiếm được bằng chữ; ứng dụng không có OCR trong phạm vi hiện tại.

## 3. Sắp xếp và chỉnh tài liệu

- Tab **Trang** hiển thị các thumbnail. Chọn một hoặc nhiều trang để đổi thứ tự, xoay, xóa, nhân bản, trích xuất hoặc chèn trang. **Ghép** và **Tách** cũng có trên màn hình Start.
- Các tab **Chỉnh sửa**, **Ghi chú**, **Form**, **Ký & Bảo mật**, **Xuất**, **Quy trình** gom công cụ theo nhóm. Chọn lệnh trong thanh công cụ hoặc `Ctrl+K`/`⌘K`; hộp thoại sẽ trình bày các thiết lập phù hợp với thao tác đó.
- Dùng **Hoàn tác/Làm lại** (`Ctrl+Z`/`Ctrl+Y`, hoặc phím `⌘` trên macOS) để quay lại/thực hiện lại thao tác trang được hỗ trợ.
- **Lưu** ghi đè file tại đường dẫn nguồn hiện tại; **Lưu thành…** để chọn file mới. Với tài liệu quan trọng, hãy dùng Lưu thành… để giữ riêng bản gốc và kiểm tra file đầu ra trước khi thay bản đang dùng.
- Khi thao tác có cảnh báo mất nội dung, chữ ký hoặc cấu trúc PDF, đọc cảnh báo trong hộp thoại trước khi áp dụng. Chuyển PDF thành bản scan raster hóa nội dung: chữ, liên kết, biểu mẫu tương tác và chữ ký không còn giữ nguyên như PDF gốc; kết quả không tự có OCR.
- Một số chức năng có thể bị giới hạn bởi loại PDF, mã hóa, chữ ký, hoặc nội dung mà thư viện PDF đọc được. Nếu nút bị mờ hay gắn nhãn **Sắp có**, chức năng đó chưa dùng được trong bản đang chạy.

## 4. Lưu, đóng và khôi phục phiên

- Khi đóng một tab còn thay đổi chưa lưu, ứng dụng hỏi lưu, bỏ thay đổi hoặc hủy đóng.
- Nếu ứng dụng/core dừng đột ngột, lần mở sau có thể hiện danh sách phiên để **Khôi phục** hoặc **Bỏ**. Chọn Khôi phục để mở bản sửa gần nhất còn đọc được; nếu revision cuối hỏng, ứng dụng có thể lùi về revision trước và báo cảnh báo.
- Mật khẩu và cài đặt mã hóa không được lưu trong journal khôi phục. Khi khôi phục phiên có mã hóa, ứng dụng cảnh báo rằng lưu ra file sẽ không giữ mã hóa cũ; hãy đặt bảo vệ lại trước khi lưu nếu cần bảo vệ file.
- Đóng ứng dụng bình thường sẽ đóng sạch các phiên. Khôi phục dành cho lần dừng bất thường, không thay cho việc lưu bản sao lưu.

## 5. Ký số và bảo mật

Các màn hình chứng thư, thư viện chữ ký, ký PDF, kiểm tra chữ ký và bảo mật được mở từ tab **Ký & Bảo mật** hoặc lệnh tương ứng. Driver USB token phải được cài từ nhà cung cấp CA. Khả năng tương thích thực tế phụ thuộc token, driver và hệ điều hành.

Trong trạng thái dự án hiện tại, chưa có kết quả kiểm tra bằng USB token thật và chưa có chứng thư Root CA Việt Nam đi kèm lõi. Chữ ký có thể cần được kiểm tra bằng ứng dụng đọc PDF và chuỗi chứng thư của CA; không coi trạng thái tin cậy là đã xác nhận chỉ vì Chef PDF tạo được chữ ký. Không sửa/xử lý nội dung trên PDF đã ký nếu ứng dụng báo thao tác bị chặn.

## 6. Cài đặt và dữ liệu

Mở **Cài đặt** để đổi ngôn ngữ Việt/Anh, giao diện sáng/tối, thư mục lưu mặc định, danh sách file gần đây, cấu hình TSA và tên người dùng dùng trong mẫu dấu. Trong menu hệ điều hành **Trợ giúp**, chọn **Mở thư mục nhật ký** hoặc **Mở thư mục dữ liệu** để xem các thư mục này khi cần hỗ trợ.

Tab **Quy trình** cho phép kiểm tra/chạy quy trình và xử lý nhiều file. Tính năng theo dõi thư mục dừng khi đóng app; theo dõi hiện không thể hỏi mật khẩu cho PDF được mã hóa. Nên chọn thư mục đầu ra riêng, không trùng với thư mục nguồn, để tránh xử lý lặp file đầu ra.

Tài liệu được xử lý cục bộ. Những tính năng được người dùng bật như TSA, kiểm tra OCSP/CRL hoặc chụp tài liệu qua Wi-Fi có thể tạo kết nối mạng tương ứng; luồng chụp điện thoại dùng mạng LAN.

## 7. Giới hạn đã biết

- Bản hiện tại không có OCR, vì vậy không biến ảnh scan thành PDF tìm kiếm được.
- Tự cập nhật chưa được cấu hình. Hãy cài bản mới từ nguồn phát hành được cung cấp; không dựa vào thông báo cập nhật trong ứng dụng.
- Mã nguồn có cấu hình build cho ba hệ điều hành, nhưng chưa có xác nhận kiểm thử thủ công trên thiết bị macOS/Linux hoặc mọi phiên bản Windows. Cảnh báo và khả năng chạy có thể khác theo phiên bản OS, kiến trúc, chính sách bảo mật và driver.
- USB token/driver thật chưa được xác minh. Nếu ký số là yêu cầu nghiệp vụ, kiểm tra file kết quả bằng phần mềm/CA mà nơi nhận yêu cầu.
- Ứng dụng dành cho sử dụng cá nhân; file bộ cài chưa được ký phát hành và macOS chưa notarize.
