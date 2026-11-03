# USB token chữ ký số ở Việt Nam: tra cứu

> Tra cứu ngày 2026-10-31 qua tìm kiếm web. Đây là **ghi chú nghiên cứu, chưa kiểm chứng trên token thật**.
> Tên file driver và đường dẫn phải xác minh lại bằng bộ cài chính thức của từng CA trước khi đưa vào danh bạ driver (I4).

## 1. Hai hệ thống chứng thực song song

| Hệ thống | Ai cấp | Dùng cho | Root CA |
|---|---|---|---|
| **CA công cộng** | Các doanh nghiệp được cấp phép (Viettel-CA, VNPT-CA, FPT-CA, MISA-CA…) | Doanh nghiệp, cá nhân: thuế, hải quan, BHXH, hóa đơn điện tử, hợp đồng | Root CA quốc gia do Trung tâm Chứng thực điện tử quốc gia (NEAC) quản lý |
| **CA chuyên dùng Chính phủ** | Ban Cơ yếu Chính phủ (Cục Chứng thực số và Bảo mật thông tin) | Cán bộ, cơ quan nhà nước: văn bản điều hành, quản lý văn bản | Root CA riêng, tải tại `rootca.gov.vn` |

→ App phải tin cậy **cả hai** hệ Root CA (I35). Thiếu một hệ thì chữ ký của hệ đó sẽ bị báo "không tin cậy".

**Pháp lý:** Điều kiện cấp phép CA công cộng hiện nằm ở Nghị định 23/2025/NĐ-CP. Năm 2025, Bộ TT&TT đã sáp nhập vào Bộ Khoa học và Công nghệ, nên danh sách doanh nghiệp được cấp phép nay đăng trên cổng của Bộ KH&CN (mst.gov.vn) và neac.gov.vn.

## 2. Các CA công cộng thường gặp

Danh sách tổng hợp từ các trang thứ cấp, **chưa phải bản chính thức mới nhất**. Một số giấy phép có thời hạn (ví dụ giấy phép của Bkav-CA ghi đến 18/3/2025), cần kiểm tra tình trạng gia hạn trên neac.gov.vn.

- **Viettel-CA** (Viettel)
- **VNPT-CA** (VNPT), có dịch vụ ký từ xa **VNPT SmartCA**
- **FPT-CA** (FPT)
- **MISA-CA** (MISA), có dịch vụ ký từ xa **MISA eSign**
- **Bkav-CA** (Bkav)
- **CA2** (Nacencomm)
- **EFY-CA**, **NewTel-CA**, **SAFE-CA**, **SmartSign (VINA-CA)**, **TrustCA**, **FastCA**, **CMC-CA**, **i-CA**…

## 3. Phần cứng token và driver

Các CA Việt Nam phần lớn **không tự sản xuất token**. Họ mua token của hãng nước ngoài rồi đóng gói kèm phần mềm quản lý và driver mang tên mình. Hệ quả:
- Cùng một CA có nhiều **đời token**, mỗi đời một driver khác nhau (ví dụ Viettel-CA có v1, v3, v4, v6).
- Cùng một chip phần cứng có thể đi kèm driver của nhiều CA khác nhau.

| Hãng chip / token | Ghi chú | Thư viện PKCS#11 (cần xác minh) |
|---|---|---|
| **Feitian ePass2003** | Rất phổ biến; hỗ trợ Windows, Linux, macOS; chuẩn CCID | Linux: `/usr/lib/libePass2003.so` (theo hướng dẫn tích hợp của bên thứ ba). OpenSC cũng hỗ trợ dòng này, có thể dùng làm driver chung |
| **SafeNet eToken** (Thales/Gemalto) | Token Ban Cơ yếu **cấp trước 2021** dùng driver SafeNet | Thường là `eTPKCS11.dll` (Windows), chưa xác minh |
| **Bit4id** | Token Ban Cơ yếu **cấp từ 2021** dùng driver Bit4ID | Thường là `bit4xpki.dll` (Windows), chưa xác minh |

### Tên driver theo CA (đã thấy trong tài liệu)

| CA | Thông tin tìm được |
|---|---|
| **Viettel-CA** | Module PKCS#11: `viettel-ca_v6.dll` (token V6). Các đời cũ: `Viettel-ca.dll`, `viettel-ca_v1.dll`, `viettel-ca_v3.dll`, `viettel-ca_v4.dll`. Nằm trong `C:\Windows\System32`. **Lưu ý:** driver CSP `viettel-ca_v6_s.dll` bỏ qua PIN do app truyền vào và luôn tự hiện cửa sổ nhập PIN, nên khi app tự nhập PIN phải dùng module PKCS#11 |
| **VNPT-CA** | VNPT cung cấp "Driver Token v8" và công cụ "Pkcs11 Admin" trên trang tải của SmartCA. Chưa tìm được tên file DLL. Các đời token v6, v8, v10 |
| **FPT-CA** | Chưa tìm được tên file. Các đời token v2 đến v5 |
| **MISA-CA** | Phần mềm quản lý "MISA-CA Token Manager v2.0", có bản cho Windows và macOS. Chưa tìm được tên file |
| **Ban Cơ yếu** | Driver Bit4ID (token mới) hoặc SafeNet (token cũ), tải tại `dichvucong.ca.gov.vn`. Có app ký miễn phí **vSignPDF** (còn gọi là VGCASignTool), tải tại `ca.gov.vn/tai-phan-mem` |

## 4. Hệ quả cho thiết kế Chef PDF

1. **Danh bạ driver (I4)** phải là file dữ liệu tách khỏi code, theo cấu trúc *CA → đời token → OS → đường dẫn thư viện*, để bổ sung mà không cần ra bản app mới.
2. **Quét tìm driver (I5)** là bắt buộc, vì không thể liệt kê đủ mọi đời token. Cách làm: thử nạp từng thư viện ứng viên, gọi `C_GetFunctionList`, rồi kiểm tra xem có slot nào đang có token không.
3. **Ưu tiên PKCS#11 hơn CSP/KSP trên Windows**, vì một số driver CSP tự bật cửa sổ PIN riêng (trường hợp Viettel-CA V6). Kho chứng thư Windows (I8) chỉ là đường dự phòng.
4. **macOS và Linux:** chưa rõ CA nào có driver. MISA có bản cho macOS; Feitian ePass2003 có driver cho cả 3 OS. **Cần thử bằng token thật.**
5. **Chẩn đoán token (I6)** có giá trị lớn: lỗi cài driver là vấn đề phổ biến nhất mà người dùng gặp, nhìn vào số lượng bài hướng dẫn "xử lý lỗi USB token" trên mạng là thấy.
6. **Ký từ xa (I9)**, để sau: VNPT SmartCA, Viettel MySign, MISA eSign; FPT và Bkav có thể cũng có dịch vụ tương tự. Mỗi bên một API riêng, thường phải ký hợp đồng tích hợp.

## 5. Việc cần làm trước khi dev phần ký số

- [ ] Thu thập bộ cài driver chính thức của Viettel-CA, VNPT-CA, FPT-CA, MISA-CA, Ban Cơ yếu. Ghi lại tên file PKCS#11 trên từng OS.
- [x] Token thật để thử: chủ dự án có token **Viettel-CA V6 (Hyperpki HYP2003)** trên Windows 11 (CH1, 2026-11-03).
- [ ] Tải Root CA quốc gia (NEAC) và Root CA chuyên dùng Chính phủ (rootca.gov.vn), kèm các CA trung gian.
- [ ] Lấy danh sách máy chủ dấu thời gian (TSA) công khai của các CA Việt Nam.
- [ ] Kiểm tra danh sách CA công cộng còn hiệu lực trên neac.gov.vn.

## Kết quả thử với token thật

| Ngày | OS | CA | Đời token | Thư viện PKCS#11 | Liệt kê | Cờ PIN | Cơ chế ký | Ký | Adobe |
|---|---|---|---|---|---|---|---|---|---|
| 2026-11-03 | Windows 11 x64 | Viettel-CA | V6 (HYP2003, Cryptoki 2.20) | `C:\Windows\System32\viettel-ca_v6.dll` (64-bit; bản SysWOW64 32-bit không nạp được vào Python 64-bit) | Qua: 1 slot, 2 chứng thư ký (một đã hết hạn 2026-09-12, một hiệu lực đến 2027-09-15), không có chứng thư CA trên token | Bình thường (không có cờ khóa) | `SHA256_RSA_PKCS` và `RSA_PKCS` đều có | Chưa thử (cần PIN do chủ dự án nhập: `scripts/token_sign_check.py`) | Chưa thử |

Ghi chú từ lần thử:

- Lõi của app (`sign.driverScan`, `sign.listTokens`, `sign.diagnoseToken`) chạy đúng trên token thật không cần PIN: tìm đúng driver V6, 7 bước chẩn đoán đạt, bước ký thử bị bỏ qua vì không có PIN.
- `viettel-ca_v6_s.dll` (CSP) không nạp được như PKCS#11, đúng như ghi chú ở mục 3; app chỉ dùng `viettel-ca_v6.dll`.
- Chuỗi chứng thư: người ký ← `Viettel-CA SHA2` (hết hạn 2029-04-17) ← `Vietnam National Root CA` (tự cấp, hết hạn 2039-04-15). Chứng thư người ký ghi địa chỉ lấy chứng thư cấp (`viettel-ca.vn/downloads/sub/Viettel-CA_SHA2.crt`), OCSP (`ocsp.viettel-ca.vn`) và CRL (`crl.viettel-ca.vn`). Chứng thư trung gian ghi địa chỉ lấy gốc `rootca.gov.vn/crt/vnrca256.p7b`.
- Thư mục `core/chef_core/resources/certs` vẫn **trống**, nên chữ ký Viettel báo `CERT_UNTRUSTED` cho đến khi chủ dự án đối chiếu dấu vân tay hai chứng thư trên với trang của NEAC/rootca.gov.vn rồi đặt vào đó (xem README trong thư mục). SHA-256 lấy được ngày 2026-11-03: gốc `bac8bf60…0908e7`, trung gian `dcc79cac…f72e4`.

## Nguồn

- [Bộ KH&CN: Danh sách doanh nghiệp được cấp phép dịch vụ chứng thực chữ ký số công cộng](https://mst.gov.vn/danh-sach-cac-doanh-nghiep-da-duoc-cap-giay-phep-dich-vu-chung-thuc-chu-ky-so-cong-cong-197116271.htm)
- [NEAC: Trung tâm Chứng thực điện tử quốc gia](https://neac.gov.vn/vi)
- [dauthau.asia: Danh sách các đơn vị cung cấp chữ ký số công cộng](https://dauthau.asia/news/blog/danh-sach-cac-don-vi-cung-cap-chu-ky-so-cong-cong-469.html)
- [MISA: Đơn vị cung cấp dịch vụ chứng thực chữ ký số công cộng](https://esign.misa.vn/2853/chung-thuc-chu-ky-so-cong-cong/)
- [GitHub hSignerBridge: ký số qua USB token (ghi chú về Viettel-CA V6)](https://github.com/haoquangviet/hSignerBridge)
- [GitHub PDF_Signature: dò driver PKCS#11 trong System32](https://github.com/HongChuyen0106/PDF_Signature)
- [Viettel Net: lỗi thường gặp khi cài USB token](https://viettelnet.vn/xu-ly-loi-lien-quan-den-cai-dat-usb-token/)
- [SInvoice: các bước kiểm tra ký USB token](https://www.sinvoice.vn/2020/11/hdsd-cac-buoc-kiem-tra-ky-usb-token.html)
- [VNPT SmartCA: trang tải driver](https://smartca.vnpt.vn/download)
- [MISA: cài đặt chữ ký số](https://esign.misa.vn/6706/cai-dat-chu-ky-so/)
- [Cao Bằng ITC: hướng dẫn USB ký số VGCA cũ và token Bit4id mới](https://caobangitc.vn/index.php/vi/news/chu-ky-so-chuyen-dung/tai-lieu-huong-dan-cai-dat-va-su-dung-usb-ky-so-cho-cac-thiet-bi-vgca-cu-va-usb-token-bit4id-moi-201.html)
- [MISA: chữ ký số Ban Cơ yếu Chính phủ](https://esign.misa.vn/5627/chu-ky-so-cua-ban-co-yeu-chinh-phu/)
- [chukyso.com: hướng dẫn VGCASignTool (vSignPDF)](https://chukyso.com/huong-dan-cai-dat-vgcasigntool-ky-so-file-pdf)
- [Feitian: Standard PKI Token (ePass2003)](https://www.ftsafe.com/Products/PKI/Standard)
- [Encryption Consulting: Feitian ePass integration guide](https://www.encryptionconsulting.com/wp-content/downloads/integration-guides/Feitian_ePass_Integration_Guide.pdf)
