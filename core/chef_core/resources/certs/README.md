# Kho chứng thư tin cậy đi kèm app (I35)

**Trạng thái hiện tại: thư mục này CHƯA chứa Root CA Việt Nam nào.** Chưa có chứng thư thật nào
được đặt vào đây, và code không tải hay tự tạo chứng thư nào. Hệ quả: chữ ký của chứng thư
Việt Nam sẽ báo `CERT_UNTRUSTED` (trạng thái "chưa xác định") cho đến khi chủ dự án bổ sung các
file dưới đây. Chữ ký kiểm tra bằng file `trustRootPaths` vẫn hoạt động bình thường.

## Cần bổ sung (chủ dự án tự tải từ nguồn chính thức)

| Nhóm (tiền tố tên file) | Chứng thư | Nguồn để tải |
|---|---|---|
| `vn-public-ca.` | Root CA quốc gia (NEAC/Bộ KH&CN), dùng cho các CA công cộng: Viettel-CA, VNPT-CA, FPT-CA, MISA-CA, Bkav-CA, CA2… kèm chứng thư trung gian của từng CA | neac.gov.vn, trang của từng CA |
| `vn-gov-ca.` | Root CA chuyên dùng Chính phủ của Ban Cơ yếu Chính phủ, kèm chứng thư trung gian | rootca.gov.vn, dichvucong.ca.gov.vn |

Không có chứng thư nào trong danh sách trên được sinh ra từ code này. Tải bản chính thức, kiểm tra
dấu vân tay SHA-256 với trang của cơ quan cấp trước khi chép vào đây.

## Quy ước đặt tên

- Tên file: `<nhóm>.<tên tùy ý>.<đuôi>`, với nhóm là `vn-public-ca` hoặc `vn-gov-ca`.
  Ví dụ: `vn-public-ca.neac-root-ca.pem`, `vn-gov-ca.bcy-root-ca.crt`.
- Đuôi được nhận: `.pem`, `.crt`, `.cer`, `.der`. File PEM có thể chứa nhiều chứng thư.
- File không có tiền tố nhóm được xếp vào nhóm `other`. Chứng thư tự cấp (chủ thể = người cấp)
  là Root CA; các chứng thư khác là trung gian.
- Thư mục này chỉ đọc khi chạy app. Chứng thư người dùng tự thêm nằm ở thư mục riêng, mang nhóm
  `user`, và có thể xóa. Chứng thư đi kèm không xóa được từ giao diện.

## Không đưa vào đây

- Chứng thư của người ký (chữ ký cá nhân, doanh nghiệp) và khóa riêng.
- Kho tin cậy của hệ điều hành hay của trình duyệt. Không cần thiết cho bản 1.0.
