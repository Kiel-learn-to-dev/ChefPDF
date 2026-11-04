# Chef PDF: Chia việc (Task breakdown)

> **Phiên bản 1.0 (2026-10-31).** Đi kèm [BLUEPRINT.md](BLUEPRINT.md) (kiến trúc, quy ước) và [FEATURES.md](FEATURES.md) (mã tính năng).
> **Cập nhật cột "Trạng thái" mỗi khi xong một task.** ⬜ chưa làm · 🔄 đang làm · ✅ xong · ⏸ tạm dừng · ❌ bỏ
> **Điểm:** 1 điểm ≈ 1 ngày làm của một lập trình viên có kinh nghiệm (xem BLUEPRINT mục 14).
> **Mã task:** `T<mốc>.<số>`, ví dụ `T3.06` là task 6 của mốc v0.3. Mốc v0.10 dùng `T10.xx`, mốc v1.0 dùng `T11.xx`, mốc v1.1 dùng `T12.xx` (PLAN_V1_1).

## Câu hỏi cần chủ dự án trả lời

| # | Câu hỏi | Cần trước task |
|---|---|---|
| CH1 | Máy chính của bạn chạy **Windows, macOS hay Linux**? Token của bạn là của **CA nào**? | T1.08 (spike token), kiểm thử tay mọi mốc |
| CH2 (đã trả lời: chưa cần, D36) | Tự cập nhật: để repo **public**, hay tạo **repo riêng public chỉ chứa bộ cài**, hay **tự kiểm tra bằng tay**? Lý do: app không đọc được release của repo private nếu không nhét token GitHub vào app | T9.08 |

## Tổng quan

| Mốc | Tên | Số task | Điểm |
|---|---|---|---|
| v0.1 | Nền móng, xem & sắp xếp | 25 | 42 |
| v0.2 | ★ Bản scan | 8 | 10,5 |
| v0.3 | ★ Ký số | 14 | 31,5 |
| v0.4 | Đóng dấu & đánh số | 14 | 24 |
| v0.5 | Bảo mật, tối ưu & chuyển đổi | 11 | 21,5 |
| v0.6 | Bộ máy nội dung | 7 | 21,5 |
| v0.7 | Sửa chữ & ghi chú | 7 | 21 |
| v0.8 | Ảnh scan & chụp sách | 11 | 32 |
| v0.9 | Form & quy trình tự động | 8 | 19,5 |
| v0.10 | Rã tài liệu | 8 | 24,5 |
| v1.0 | Ổn định & hoàn thiện | 6 | 17 |
| **Tổng** | | **119** | **265** |

---

## v0.1: Nền móng, xem & sắp xếp

**Mục tiêu:** dựng toàn bộ khung kiến trúc, có app cài được trên 3 OS để mở, xem và sắp xếp trang PDF.
**Demo:** cài app trên 3 OS. Mở PDF có mật khẩu, tìm "nghi dinh" ra "nghị định", ghép 3 file, kéo đổi thứ tự trang, xóa trang, hoàn tác, lưu.

### Nền móng

| Mã | Việc | Tính năng | Điểm | Phụ thuộc | Trạng thái |
|---|---|---|---|---|---|
| T1.01 | Dựng monorepo: pnpm workspaces, uv, ruff/mypy, ESLint/Prettier, editorconfig; **chốt và ghim phiên bản** các công nghệ | | 1 | | ✅ |
| T1.02 | Electron shell: main/preload/renderer, cấu hình bảo mật (contextIsolation, sandbox, CSP), cửa sổ, menu, một phiên bản app duy nhất | | 1,5 | T1.01 | ✅ |
| T1.03 | Sidecar Python: JSON-RPC qua stdio, khởi động / theo dõi / tự khởi động lại, log, `ping` | | 2 | T1.01 | ✅ |
| T1.04 | Operation registry + job runner (tiến độ, hủy, process pool) + codegen pydantic → JSON Schema → kiểu TS | | 2 | T1.03 | ✅ |
| T1.05 | Phiên tài liệu: bản sao làm việc, bản sửa, journal, hoàn tác/làm lại, danh sách trang thay đổi, Lưu / Lưu thành an toàn | A6 | 2,5 | T1.04 | ✅ |
| T1.06 | Đóng gói: PyInstaller onedir + electron-builder; GitHub Actions build 3 OS; đo dung lượng bộ cài và thời gian khởi động | A8 | 2,5 | T1.02, T1.03 | ✅ |
| T1.07 | Hạ tầng test: pytest, Vitest, Playwright-Electron; script sinh bộ PDF mẫu tiếng Việt; workflow `ci.yml` | | 1,5 | T1.01 | ✅ |

### Spike (thử nghiệm sớm để giảm rủi ro)

| Mã | Việc | Tính năng | Điểm | Phụ thuộc | Trạng thái |
|---|---|---|---|---|---|
| T1.08 | **S1:** pyHanko + PKCS#11 với SoftHSM2, rồi với **token thật** trên máy chủ dự án. Ghi kết quả vào TOKENS.md. *Phần SoftHSM2 xong ([báo cáo](spikes/S1-pkcs11.md)); token thật Viettel V6 đã dò và ký thử thành công ngày 2026-11-03 ([TOKENS.md](TOKENS.md))* | (I1) | 1,5 | T1.03, CH1 | ✅ |
| T1.09 | **S2:** đánh giá pypdfium2/pikepdf cho chọn/xóa/di chuyển đối tượng và sửa chữ tiếng Việt. Kết luận có cần xem lại D7 không | (D4–D9) | 1,5 | T1.03 | ✅ |

### Giao diện & trình xem

| Mã | Việc | Tính năng | Điểm | Phụ thuộc | Trạng thái |
|---|---|---|---|---|---|
| T1.10 | Design system: token sáng/tối, thành phần nền (Radix), icon, font, i18n vi/en | A4 | 2,5 | T1.02 | ✅ |
| T1.11 | App shell: tab tài liệu, tab chức năng + toolbar ngữ cảnh, thanh bên, panel thuộc tính, thanh trạng thái, job panel | A2 | 2,5 | T1.10 | ✅ |
| T1.12 | Mẫu "Task dialog" dùng chung: preset, tùy chọn chính, nâng cao, xem trước, ước tính, áp dụng nhiều file | | 1,5 | T1.11, T1.04 | ✅ |
| T1.13 | Màn hình Start: ô nhiệm vụ, file gần đây, kéo thả | A1 | 1,5 | T1.11 | ✅ |
| T1.14 | Bảng lệnh `Ctrl+K`, tìm không dấu | A3 | 1 | T1.11 | ✅ |
| T1.15 | Cài đặt: lưu/đọc settings, màn hình cài đặt | A4 | 1 | T1.10 | ✅ |
| T1.16 | Trình xem pdf.js: render trong worker, ảo hóa trang, zoom, xoay khung nhìn; chế độ một trang / liên tục / hai trang / sách / trình chiếu | B1, B2 | 3 | T1.11 | ✅ |
| T1.17 | Thanh bên: thumbnail, mục lục | B3 | 1,5 | T1.16 | ✅ |
| T1.18 | Tìm kiếm có tô sáng, **tìm không dấu** | B4 | 1,5 | T1.16 | ✅ |
| T1.19 | Chọn & copy chữ; chụp một vùng thành ảnh | B5 | 1 | T1.16 | ✅ |
| T1.20 | Hỏi mật khẩu khi mở; xem thuộc tính tài liệu | B6, B7 | 1 | T1.16 | ✅ |
| T1.21 | Mở file từ OS, liên kết đuôi `.pdf`, "Open with" | A5 | 1 | T1.06 | ✅ |
| T1.22 | In qua hộp thoại của OS, chọn trang | A7 | 1 | T1.16 | ✅ |

### Sắp xếp trang

| Mã | Việc | Tính năng | Điểm | Phụ thuộc | Trạng thái |
|---|---|---|---|---|---|
| T1.23 | Operation trang: xoay, xóa, nhân bản, trích; chèn trang trắng / từ file / từ ảnh / từ clipboard | C2, C3 | 2 | T1.05 | ✅ |
| T1.24 | Lưới thumbnail: kéo thả đổi thứ tự, chọn nhiều | C1 | 2 | T1.17, T1.23 | ✅ |
| T1.25 | Ghép file (kèm tạo bookmark theo tên file), tách file (theo khoảng, mỗi N trang, bookmark, dung lượng, chẵn/lẻ) | C4, C5 | 2 | T1.12, T1.23 | ✅ |

---

## v0.2: ★ Bản scan

**Demo:** file 50 trang chuyển thành bản scan 200 dpi xám có hiệu ứng, xem trước, file ra ≤ 5MB.

| Mã | Việc | Tính năng | Điểm | Phụ thuộc | Trạng thái |
|---|---|---|---|---|---|
| T2.01 | Raster hóa bằng PDFium theo DPI; chế độ màu / xám / đen trắng (ngưỡng, dithering) | K1, K2 | 1,5 | T1.04 | ✅ |
| T2.02 | Tạo PDF ảnh: nhúng JPEG không nén lại, Flate, CCITT G4; giữ khổ giấy; chọn trang; xóa metadata | K3, K7 | 1,5 | T2.01 | ✅ |
| T2.03 | Hiệu ứng scan thật (nghiêng, nhiễu, ám giấy, bóng mép, mờ, tương phản), ngẫu nhiên theo seed từng trang | K4 | 1,5 | T2.01 | ✅ |
| T2.04 | Xử lý theo luồng + song song, giới hạn RAM; benchmark 500 trang ở 600 dpi | | 1 | T2.02 | ✅ |
| T2.05 | Xem trước gốc/kết quả (chia đôi, thanh trượt, zoom 100%); ước tính dung lượng và thời gian | K5, K6 | 1,5 | T1.12, T2.03 | ✅ |
| T2.06 | Preset có sẵn và tự tạo; cảnh báo mất chữ/link/form/chữ ký | K8, K9 | 1 | T2.05 | ✅ |
| T2.07 | "Nén sao cho ≤ X MB": tìm DPI/chất lượng phù hợp bằng tìm kiếm nhị phân trên trang mẫu | K10 | 1 | T2.05 | ✅ |
| T2.08 | Dialog "Chuyển thành bản scan" hoàn chỉnh + ô nhiệm vụ trên Start + test golden image | | 1,5 | T2.06 | ✅ |

---

## v0.3: ★ Ký số

**Demo:** cắm token thật, chẩn đoán xanh, tạo mẫu chữ ký có ảnh đã tách nền, ký theo chữ mốc "GIÁM ĐỐC" cho 10 file, Adobe Reader báo chữ ký hợp lệ.

| Mã | Việc | Tính năng | Điểm | Phụ thuộc | Trạng thái |
|---|---|---|---|---|---|
| T3.01 | Lớp PKCS#11: nạp module, liệt kê slot/token/chứng thư, đăng nhập PIN, quản lý phiên | I1 | 2,5 | T1.08 | ✅ |
| T3.02 | Danh bạ driver (file dữ liệu theo CA → đời token → OS) + tự dò + nút "Quét tìm driver" + chọn file thủ công | I4, I5 | 2 | T3.01 | ✅ |
| T3.03 | Màn hình chẩn đoán token từng bước, hướng dẫn sửa bằng tiếng Việt; cảnh báo PIN sắp khóa | I6, I7 | 2 | T3.02 | ✅ |
| T3.04 | Ký bằng file `.pfx`/`.p12`, ghi nhớ mật khẩu bằng safeStorage | I2 | 1 | T1.04 | ✅ (file .pfx/.p12, ghi nhớ mật khẩu qua kho bí mật của hệ điều hành) |
| T3.05 | Đọc thông tin chứng thư (gồm MST/CCCD theo cách CA Việt Nam ghi), nhắc trước khi hết hạn | I3 | 1,5 | T3.01 | ✅ |
| T3.06 | Engine ký PAdES: B-B / B-T / B-LT / B-LTA, TSA có dự phòng, SHA-256, ghi incremental | I28 | 3 | T3.01, T3.04 | ✅ |
| T3.07 | Ký chứng nhận (DocMDP); nhiều người ký nối tiếp; tạo ô ký trống | I29, I30 | 1,5 | T3.06 | ✅ |
| T3.08 | Kiểm tra chữ ký: panel trạng thái, chuỗi chứng thư, OCSP/CRL, xem phiên bản lúc ký; kho tin cậy với 2 hệ Root CA Việt Nam | I34, I35 | 3 | T3.06 | ⏸ (hoãn: chủ dự án đối chiếu vân tay Root CA và kiểm sau khi có kết quả) |
| T3.09 | Bộ vẽ giao diện chữ ký theo mẫu: bố cục, font tiếng Việt, tự co chữ, màu, viền, logo, dấu ✓. **Tự vẽ bằng reportlab rồi nhúng vào**, không dùng bộ vẽ chữ có sẵn của pyHanko (lỗi giãn chữ với font TrueType, xem spike S1) | I15–I18 | 3 | T3.06 | ✅ |
| T3.10 | Studio mẫu chữ ký (UI): quản lý mẫu, gắn mẫu với chứng thư, chọn dòng thông tin, nguồn dữ liệu, ngày giờ, lý do/nơi ký, xem trước trực tiếp | I10–I14 | 3 | T3.09, T3.05 | ✅ |
| T3.11 | Thư viện ảnh chữ ký & con dấu: nhập ảnh / vẽ (có lực bút) / gõ font viết tay; tách nền tự động; làm sạch & chỉnh; mã hóa thư viện. *Phần "chụp qua QR" của I19 làm ở T8.11* | I19, I20, I21, I23 | 3,5 | T1.10 | ✅ (nhập ảnh, vẽ có lực bút, gõ tên, tách nền, làm sạch; thư viện mã hóa qua kho bí mật) |
| T3.12 | Đặt chữ ký: kéo thả khung, ký ẩn, ký vào ô có sẵn, **đặt theo chữ mốc**, vị trí cố định | I25, I26, I27 | 2,5 | T3.09 | ✅ |
| T3.13 | Ký hàng loạt (nhập PIN 1 lần); việc sau khi ký (đặt tên, mở panel kiểm tra, mở thư mục) | I31, I32 | 1,5 | T3.12 | ✅ |
| T3.14 | Kiểm tra chéo bằng Adobe Reader, Foxit, vSignPDF; checklist thử token thật; sửa lỗi tương thích | | 1,5 | T3.13, T3.08 | ⏸ (hoãn: chủ dự án kiểm Adobe Reader/Foxit và token thật sau khi dùng v1) |

---

## v0.4: Đóng dấu & đánh số

**Demo:** đánh số theo NĐ 30, đóng dấu giáp lai + chữ ký nháy + ký số trong một lần bấm, gỡ lại watermark đã thêm.

| Mã | Việc | Tính năng | Điểm | Phụ thuộc | Trạng thái |
|---|---|---|---|---|---|
| T4.01 | Engine lớp phủ: vẽ chữ/ảnh lên trang, nhúng font Unicode (subset), gắn nhãn `/Artifact` (D14) | | 3 | T1.05 | ✅ |
| T4.02 | Thêm chữ, thêm ảnh lên trang | D1, D2 | 2 | T4.01 | ✅ |
| T4.03 | Sửa mục lục (bookmark) | D3 | 1,5 | T1.17 | ✅ |
| T4.04 | Watermark chữ/ảnh | F1 | 1,5 | T4.01 | ✅ |
| T4.05 | Con dấu chữ, con dấu ảnh, con dấu động, thư viện dấu | F2, F3, F5 | 2 | T4.01, T3.11 | ✅ |
| T4.06 | Dấu giáp lai; chữ ký nháy | F4, F6 | 1,5 | T4.05 | ✅ |
| T4.07 | Header/footer có biến; đánh số trang (gồm preset NĐ 30); đánh số Bates qua nhiều file | F7, F8, F9 | 2,5 | T4.01 | ✅ |
| T4.08 | Mã QR / mã vạch | F10 | 1 | T4.01 | ✅ |
| T4.09 | Chồng lên giấy tiêu đề | F11 | 1 | T4.01 | ✅ |
| T4.10 | Quản lý & gỡ những gì Chef PDF đã thêm | F12 | 1,5 | T4.04, T4.07 | ✅ |
| T4.11 | Ký bằng kho chứng thư OS (Windows CNG, macOS Keychain) | I8 | 3 | T3.06 | ✅ (kho chứng thư Windows qua CNG, chọn theo thumbprint; test lõi trên Windows `test_sign_store_cng.py`; giao diện có test đơn vị; chưa có e2e giao diện, owner kiểm tay) |
| T4.12 | Tách chữ ký & con dấu theo màu | I22 | 1,5 | T3.11 | ✅ |
| T4.13 | Ký kèm đóng dấu (ký số + giáp lai + ký nháy) | I33 | 1 | T4.06, T3.13 | ✅ |
| T4.14 | Kiểm tra chữ ký hàng loạt, xuất Excel/CSV | I36 | 1 | T3.08 | ✅ |

---

## v0.5: Bảo mật, tối ưu & chuyển đổi

**Demo:** soi file, kiểm tra trước khi gửi, nén còn ≤ 2MB, tách thông minh theo trang trắng, app crash giữa chừng vẫn khôi phục được.

| Mã | Việc | Tính năng | Điểm | Phụ thuộc | Trạng thái |
|---|---|---|---|---|---|
| T5.01 | Đặt / gỡ mật khẩu, giới hạn quyền, AES-256 | J1, J2 | 1 | T1.05 | ✅ |
| T5.02 | Gỡ dữ liệu ẩn; soi file | J3, J4 | 2 | T1.05 | ✅ |
| T5.03 | Kiểm tra trước khi gửi (checklist + sửa từng mục) | J5 | 1,5 | T5.02, T3.08 | ✅ |
| T5.04 | Nén PDF theo preset (giảm ảnh, bỏ đối tượng thừa, rút gọn font) | M1 | 2,5 | T1.05 | ✅ |
| T5.05 | PDF → ảnh; ảnh → PDF; ảnh chụp màn hình / clipboard → PDF | M2, M3, M4 | 2 | T2.01 | ✅ (PDF ↔ ảnh, ảnh → PDF có e2e `tools5.spec.ts`; chụp màn hình trực tiếp kiểm tay) |
| T5.06 | Web / Markdown / HTML → PDF (dùng bộ in của Chromium trong Electron) | M5 | 1,5 | T1.02 | ✅ |
| T5.07 | Chuyển đổi màu: thang xám, đen trắng, tiết kiệm mực, thay màu | M6 | 2 | T1.05 | ✅ |
| T5.08 | Trích ảnh/chữ; file đính kèm; sửa metadata; tối ưu cho web; sửa file hỏng | M7–M11 | 2,5 | T1.05 | ✅ |
| T5.09 | Thay trang; cắt lề/đổi khổ (CropBox); xóa trang trắng; chia đôi trang; tách thông minh | C6–C10 | 3,5 | T1.24 | ✅ |
| T5.10 | Khôi phục phiên khi crash | A9 | 1,5 | T1.05 | ✅ |
| T5.11 | Xem song song; chế độ đọc ban đêm | B8, B9 | 1,5 | T1.16 | ✅ |

---

## v0.6: Bộ máy nội dung

**Demo:** gỡ logo chìm trên mọi trang, tẩy một vùng, che số CCCD và kiểm chứng không copy ra được chữ bên dưới.

| Mã | Việc | Tính năng | Điểm | Phụ thuộc | Trạng thái |
|---|---|---|---|---|---|
| T6.01 | Content engine: đọc đối tượng trang, xác định đối tượng dưới con trỏ, chọn, biến đổi, xóa, ghi lại. Gồm bước tiền xử lý bằng pikepdf (mở Form XObject, bỏ ActualText, lấy mã ký tự từ ToUnicode) và bước kiểm chứng độc lập, theo spike S2 | | 6 | T1.09 | ✅ |
| T6.02 | UI chọn & sửa đối tượng (tay nắm, xoay, thứ tự lớp) | D4 | 2,5 | T6.01 | ✅ |
| T6.03 | Tẩy vùng: cắt chữ/vector/ảnh theo vùng | D5 | 3 | T6.01 | ✅ |
| T6.04 | Thay ảnh; chỉnh ảnh trong PDF | D6, D7 | 2 | T6.01 | ✅ |
| T6.05 | Bảng lớp; xem theo loại nội dung | E1, E2 | 2 | T6.01 | ✅ |
| T6.06 | Gỡ watermark tự động (dò ứng viên, xem trước, tích chọn); gỡ "đối tượng giống thế này"; gỡ/đổi nền | E3, E4, E5 | 3 | T6.05 | ✅ |
| T6.07 | Che thông tin mật: xóa thật nội dung bên dưới; tìm theo mẫu CCCD/SĐT/email/STK; kiểm chứng bằng test | J6 | 3 | T6.03 | ✅ |

---

## v0.7: Sửa chữ & ghi chú

**Demo:** sửa một câu tiếng Việt trong hợp đồng, thay tên công ty toàn tài liệu, highlight và ghi chú.

| Mã | Việc | Tính năng | Điểm | Phụ thuộc | Trạng thái |
|---|---|---|---|---|---|
| T7.01 | Mô hình chữ: gom ký tự → dòng → đoạn; ánh xạ font; kiểm tra font có đủ ký tự tiếng Việt không | | 4 | T6.01 | ✅ |
| T7.02 | Sửa chữ mức dòng, tự thay font khi thiếu ký tự | D8 | 4 | T7.01 | ✅ |
| T7.03 | Sửa chữ mức đoạn, tự xuống dòng lại, đổi kiểu chữ | D9 | 5 | T7.02 | ✅ |
| T7.04 | Tìm & thay thế chữ toàn tài liệu | D10 | 2 | T7.02 | ✅ |
| T7.05 | Liên kết | D11 | 1 | T6.01 | ✅ |
| T7.06 | Ghi chú: highlight/gạch chân/gạch ngang, note, vẽ (tận dụng annotation editor của pdf.js) | G1, G2, G3 | 3 | T1.16 | ✅ |
| T7.07 | Danh sách ghi chú (lọc, trả lời, xuất); làm phẳng ghi chú | G4, G5 | 2 | T7.06 | ✅ |

---

## v0.8: Ảnh scan & chụp sách

**Demo:** chụp 20 trang sách bằng điện thoại qua QR, tự dò viền, tách trang đôi, làm phẳng, xóa ngón tay, ra PDF đẹp.

| Mã | Việc | Tính năng | Điểm | Phụ thuộc | Trạng thái |
|---|---|---|---|---|---|
| T8.01 | Trình sửa ảnh trang: canvas, lịch sử không phá hủy, áp cho nhiều trang, thay ảnh vào PDF | L9 | 4 | T6.04 | ✅ (các hộp thoại trên xem trước canvas: chỉnh ảnh, xóa ngón tay, tẩy vùng, khe gáy; lịch sử là hoàn tác theo phiên, không phá file gốc) |
| T8.02 | Chỉnh nghiêng; làm trắng nền; khử nhiễu & chỉnh sáng; Levels/Curves, đảo màu, đổi DPI | L1, L3, L4, L12 | 3 | T8.01 | ✅ (hộp thoại Chỉnh ảnh trang: làm trắng, khử nhiễu, mức, đường cong 5 điểm, tương phản, đảo màu, thang xám, DPI, xem trước trước/sau; e2e `adjust.spec.ts`) |
| T8.03 | Tẩy & tô màu nền giấy; xóa vết màu | L10, L11 | 2 | T8.01, T4.12 | ✅ (tẩy vùng bằng khung kéo, tô giấy hoặc trắng, xóa mực xanh/dạ quang/dấu đỏ; e2e `erase.spec.ts`) |
| T8.04 | Dò viền bằng thuật toán: bản scan máy + ảnh chụp, điểm tin cậy | L15 | 3 | T8.01 | ✅ |
| T8.05 | Mô hình dò viền ONNX: **kiểm tra giấy phép trước**, tích hợp, chọn kết quả tốt hơn giữa hai cách | L20 | 2,5 | T8.04 | ✅ |
| T8.06 | Cắt thủ công: khung chữ nhật (kính lúp, tỉ lệ, mm, bám viền) và kéo 4 góc + nắn phối cảnh | L2, L16, L17 | 3 | T8.04 | ✅ |
| T8.07 | Cắt hàng loạt & duyệt nhanh; tự nhận khổ giấy | L18, L19 | 2 | T8.06 | ✅ (duyệt lần lượt các trang chưa tick với kính lúp và chuyển trang; e2e cắt và cắt hàng loạt đạt) |
| T8.08 | Tách trang đôi (dò gáy sách, chỉnh tay) | L6 | 1,5 | T8.04 | ✅ (tự dò và chỉnh tay có giao diện, xem trước khe gáy, e2e `spine.spec.ts`) |
| T8.09 | Làm phẳng trang cong (dò dòng chữ, khớp mặt cong) | L13 | 4 | T8.01 | ✅ (chưa thử trên ảnh sách thật) |
| T8.10 | Xóa ngón tay bán tự động (dò màu da chạm mép, đề xuất, chỉnh cọ, tô nền) | L14 | 3 | T8.03 | ✅ (đề xuất, cọ tô và bỏ tô, tô giấy; e2e `finger.spec.ts` kiểm đề xuất và áp dụng; nét cọ chỉ có test đơn vị) |
| T8.11 | Chụp bằng điện thoại qua QR: máy chủ LAN tạm có token, trang web chụp, nhận ảnh, dò viền ngay. Dùng cho cả chụp chữ ký (I19) | L5, (I19) | 4 | T8.04 | ✅ (chưa thử trên điện thoại thật; server và trang chụp qua HTTP) |

---

## v0.9: Form & quy trình tự động

**Demo:** tạo quy trình "Nộp hồ sơ online", thả 20 file vào thư mục tự động, lấy kết quả đã ký.

| Mã | Việc | Tính năng | Điểm | Phụ thuộc | Trạng thái |
|---|---|---|---|---|---|
| T9.01 | Form: điền, tạo trường (chữ, checkbox, radio, dropdown, ô ký), làm phẳng | H1, H2, H3 | 5 | T6.01 | ✅ (điền, tạo trường chữ/checkbox/radio/dropdown/ô ký, làm phẳng; e2e `forms.spec.ts`) |
| T9.02 | Workflow engine: chuỗi operation, kiểm tra tham số, **kiểm tra thứ tự an toàn** | O1, O5 | 3 | T1.04 | ✅ (chuỗi thao tác, kiểm tra tham số và thứ tự an toàn; e2e `workflow.spec.ts`) |
| T9.03 | UI trình tạo quy trình; "Lưu thành bước quy trình" từ task dialog | O1 | 3 | T9.02 | ✅ (trình tạo quy trình; "Lưu thành bước" từ các hộp thoại có tham số thuần, xem D44; e2e `workflow-*-step.spec.ts`) |
| T9.04 | Chạy hàng loạt: tiến độ, báo lỗi từng file, chạy tiếp khi có file lỗi | O2 | 2 | T9.02 | ✅ |
| T9.05 | Thư mục tự động (theo dõi thư mục, hàng đợi, chống chạy trùng) | O3 | 1,5 | T9.04 | ✅ |
| T9.06 | Quy tắc đặt tên đầu ra; đổi tên file hàng loạt | O4, O6 | 1,5 | T9.04 | ✅ (quy tắc đặt tên đầu ra và đổi tên hàng loạt; e2e `rename.spec.ts`) |
| T9.07 | Quy trình mẫu (Nộp hồ sơ online, Phát hành văn bản, Chụp sách); kéo thả file lên quy trình ở Start | O7, O8 | 1,5 | T9.03 | ✅ (quy trình mẫu, kéo thả file lên quy trình ở Start; e2e `start-workflows.spec.ts`) |
| T9.08 | Tự cập nhật (Windows/Linux tự động, macOS báo bản mới). **Làm sau 1.0** (D36) | A10 | 2 | T1.06 | ⏸ (hoãn sau 1.0, D36) |

---

## v0.10: Rã tài liệu

**Demo:** rã một báo cáo 2 cột có bảng thành Word "giữ bố cục" và Markdown.

| Mã | Việc | Tính năng | Điểm | Phụ thuộc | Trạng thái |
|---|---|---|---|---|---|
| T10.01 | Mô hình tài liệu JSON + dò bố cục bằng quy tắc (dòng, đoạn, tiêu đề, danh sách, nhiều cột, thứ tự đọc, bỏ header/footer lặp) | N1 | 6 | T7.01 | ✅ |
| T10.02 | Nhận bảng có đường kẻ | N2 | 3 | T10.01 | ✅ |
| T10.03 | Màn hình kiểm tra & sửa (gốc/kết quả song song, đổi loại vùng) | N3 | 4 | T10.01 | ✅ (màn hình kiểm tra: đổi loại vùng và xuất theo mô hình đã duyệt; e2e `layout-review.spec.ts`) |
| T10.04 | Bộ xuất Markdown, HTML, TXT, JSON, EPUB, ODT, XLSX | N4 | 3 | T10.01 | ✅ |
| T10.05 | Xuất DOCX hai chế độ: dễ chỉnh sửa / giữ bố cục | N5 | 4 | T10.01 | ✅ |
| T10.06 | Làm mới tài liệu (dàn trang lại thành PDF sạch) | N6 | 2,5 | T10.01 | ✅ (làm mới tài liệu thành PDF sạch; lõi `test_export_refresh.py` và giao diện xuất) |
| T10.07 | Rã hàng loạt; làm thành một bước quy trình | N7 | 1 | T10.04, T9.02 | ✅ (rã hàng loạt qua quy trình mẫu và thư mục tự động; "Lưu thành bước" từ hộp thoại xuất; e2e `demo-v09` cho đợt từng file) |
| T10.08 | Tự tạo mục lục từ tiêu đề đã dò | D12 | 1 | T10.01 | ✅ |

---

## v1.0: Ổn định & hoàn thiện

**Demo:** dùng hằng ngày một tuần không gặp lỗi nghiêm trọng.

| Mã | Việc | Tính năng | Điểm | Phụ thuộc | Trạng thái |
|---|---|---|---|---|---|
| T11.01 | Kiểm thử toàn bộ **trên Windows**, sửa lỗi (macOS/Linux sau 1.0, D37) | | 5 | tất cả | ✅ (Windows: pytest lõi 1654 đạt, giao diện 777 đạt, desktop 230 đạt, e2e 211 đạt / 2 bỏ qua; chưa thử trên máy sạch) |
| T11.02 | Hiệu năng: file 1000 trang, file 300MB, RAM, thời gian khởi động | | 3 | tất cả | ✅ (trong app: file 1000 trang hiện trang đầu 4,1 s, 20 lần PageDown 0,9 s; file 305 MB hiện trang đầu 5,1 s, 20 lần PageDown 52 ms; RAM đỉnh lõi 444 MB; `perf-large.spec.ts`) |
| T11.03 | Rà soát giấy phép toàn bộ thư viện, font, mô hình; tạo file NOTICE | | 1 | tất cả | ✅ (NOTICE ở gốc repo; không có AGPL/GPL; mypy/pytest/ruff bỏ khỏi bản đóng gói; còn ghi chú giấy phép mã DocAligner) |
| T11.04 | Hướng dẫn sử dụng tiếng Việt (kèm cách cài khi app chưa ký mã) | | 2 | tất cả | ✅ (hướng dẫn viết lại cho bản Windows, khớp tên lệnh trong app) |
| T11.05 | Đánh bóng giao diện, phím tắt, truy cập bằng bàn phím | | 3 | tất cả | ✅ (phím tắt và điều hướng bàn phím, e2e `keyboard.spec.ts`; đánh bóng giao diện theo D41 và ui-audit; dọn token CSS B1–B9 để sau 1.0) |
| T11.06 | Menu chuột phải trên các trang đã chọn (kiểu ABBYY): **tạo PDF từ các trang đã chọn** mở ở tab mới, đóng dấu và nén đúng các trang đã chọn, chọn tất cả/đảo chọn, xuất ảnh; dùng chung ở lưới thumbnail và thanh bên (chọn nhiều và menu ở thanh bên xong), xem NOTES 2026-11-03 | C13, C14 | 3 | T1.24, T4.05, T5.04 | ✅ |

---

## v1.1: Sửa lỗi báo cáo & sửa chữ PDF

**Mục tiêu:** sửa B1, B2 báo cáo ở 1.0; đưa sửa chữ PDF khớp blueprint ABBYY (PLAN_V1_1 mục 5, quyết định D53–D57).
**Demo:** `demo-v11` theo PLAN_V1_1 mục 5.7, chạy với lõi đóng gói; B1 và B2 có test hồi quy trên bản đóng gói.

| Mã | Việc | Tính năng | Điểm | Phụ thuộc | Trạng thái |
|---|---|---|---|---|---|
| T12.01 | **B1:** tái hiện trên bản đóng gói (harness `b1-in-session`), test đỏ, sửa, test xanh. Chờ chủ dự án xác nhận bước của mình (PLAN_V1_1 mục 7, câu 1) | B1 | 2 | | 🔄 |
| T12.02 | **B2:** kịch bản "cửa sổ khác ở trên" chưa chạy; cần chủ dự án cho phép rõ ràng | B2 | 1 | | ⬜ |
| T12.03 | Lõi: tham số `indent` (pt hoặc keep) cho `text.editParagraph` và `text.styleParagraph`, test lõi, cập nhật contracts | D53–D56 | 1 | T9.03 | ⬜ |
| T12.04 | Một chế độ **Chỉnh sửa** thay hai lệnh dòng và đoạn; khung là khối từ lõi; hộp đoạn nổi bỏ, giữ cảnh báo tràn và chồng khối | B11 | 3 | T12.03 | ⬜ |
| T12.05 | **Hàng định dạng cố định** dưới hàng công cụ: font, cỡ (tăng/giảm), đậm, nghiêng, căn, thụt lề, khoảng cách, màu; áp dụng ngay, giữ id đoạn sau mỗi revision | D14 | 4 | T12.04 | ⬜ |
| T12.06 | Chỉ báo lớp chữ trên thanh dưới: có chữ, không có chữ (bản scan), hỗn hợp | B12 | 1 | | ⬜ |
| T12.07 | Bảng thuộc tính đối tượng (chữ, ảnh, ghi chú, chữ ký) ở panel phải | D13 | 2,5 | T12.04 | ⬜ |
| T12.08 | Demo v1.1: `demo-v11.spec.ts` theo §5.7, lõi đóng gói; ui-audit cập nhật baseline có chủ ý (D41) | | 2 | T12.01–T12.06 | ⬜ |

---

## Kiểm tra độ phủ

Mọi tính năng thuộc bản 1.0 trong FEATURES.md (161 mục) đều có ít nhất một task ở trên. Khi thêm hoặc đổi tính năng, chạy lại kiểm tra này:

```bash
python3 scripts/check_coverage.py
```

*(Script này tạo ở T1.07. Trước khi có script, kiểm tra bằng tay.)*
