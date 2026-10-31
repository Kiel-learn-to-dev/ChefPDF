# Chef PDF: Ghi chú thảo luận & quyết định

> File này ghi lại toàn bộ quyết định đã chốt với chủ dự án, để các phiên làm việc sau đọc và làm tiếp.
> **Cập nhật file này mỗi khi có quyết định mới.** Mới nhất ở trên cùng của mục "Nhật ký".

## Trạng thái hiện tại

- **Giai đoạn:** Đang brainstorm và chốt cây tính năng ([FEATURES.md](FEATURES.md)). **Chưa viết code.**
- **Việc tiếp theo:** Chờ chủ dự án góp ý cây tính năng → chốt phạm vi v0.1 → dựng khung dự án Electron.
- **Câu hỏi còn mở:**
  - Chủ dự án dùng USB token của hãng nào (VNPT-CA, Viettel-CA, BKAV-CA, FPT-CA, MISA…)? Cần token thật để thử ký số.
  - App để tự dùng hay sẽ phát hành/bán? Câu này ảnh hưởng chi phí ký mã (Apple Developer 99 USD/năm, chứng thư code signing Windows).

## Mục tiêu sản phẩm

- App PDF desktop **mạnh nhưng gọn gàng**, lấy cảm hứng từ sự gọn gàng của ABBYY FineReader. Chủ dự án chê các app miễn phí hiện có là rối.
- Chạy được trên **Windows, macOS, Linux**.
- **Offline hoàn toàn**, không tải file lên server.
- Giao diện tiếng Việt (và tiếng Anh).

## Các quyết định đã chốt

| # | Quyết định | Lý do |
|---|---|---|
| D1 | Tên app: **Chef PDF** (repo vẫn tên `powerpdf`) | "Power PDF" trùng tên thương mại của Kofax/Tungsten (trước là Nuance) |
| D2 | **Chưa làm OCR** ở các bản đầu | Chủ dự án yêu cầu. Để dành cho giai đoạn sau |
| D3 | Vỏ app: **Electron** (không dùng Tauri, không làm webapp thuần) | Electron mang Chromium theo app nên hiển thị giống hệt trên 3 OS, chỉ cần thử trên 1 máy. Tauri dùng 3 lõi khác nhau (WebView2 / WKWebView / WebKitGTK), Linux hay lỗi canvas. **WebView2 chỉ có trên Windows.** Webapp thuần không truy cập được USB token PKCS#11 |
| D4 | Giao diện: **React + TypeScript**, xem PDF bằng **pdf.js** | Dễ làm đẹp. UI tách khỏi vỏ để sau này có thể chuyển sang Tauri hoặc làm bản web rút gọn |
| D5 | Lõi xử lý: **Python sidecar** đóng gói kèm app (PyInstaller, chế độ onedir) | Có pyHanko, thư viện ký PDF tốt nhất |
| D6 | Thư viện lõi: **pyHanko** (ký số), **pypdfium2** (render), **pikepdf** (thao tác PDF), **Pillow + img2pdf** (ảnh) | Đều có giấy phép thoáng |
| D7 | **Tránh thư viện AGPL:** PyMuPDF/MuPDF, Ghostscript, iText | Để giữ quyền bán app mã nguồn đóng sau này |
| D8 | Build bằng **GitHub Actions** cho 3 OS: `.exe`/`.msi`, `.dmg` (Intel + Apple Silicon), `.AppImage`/`.deb`/`.rpm` | Chủ dự án không cần có đủ 3 máy |
| D9 | Tính năng chủ lực: **Chuyển thành bản scan** (PDF chỉ có ảnh, chỉnh DPI/màu/nén/hiệu ứng scan) và **Ký số** (USB token + PFX, PAdES) | Chủ dự án yêu cầu đặc biệt |
| D10 | Chuyển thành bản scan phải làm **trước** khi ký số. App tự sắp xếp thứ tự và cảnh báo | Raster hóa sau khi ký sẽ làm mất chữ ký |

## Kiến trúc dự kiến

```
Chef PDF
├── Vỏ app: Electron (Chromium, chạy giống nhau trên Win/Mac/Linux)
├── Giao diện: React + TypeScript + pdf.js
└── Lõi xử lý: Python sidecar, giao tiếp qua local API (HTTP/IPC trên localhost)
    ├── pikepdf: ghép/tách/xoay, mật khẩu, nén
    ├── pypdfium2: render trang ra ảnh
    ├── pyHanko: ký số PAdES (B-B, B-T, B-LT, B-LTA), PKCS#11, PFX, TSA, kiểm tra chữ ký
    └── Pillow + img2pdf: xử lý ảnh, tạo PDF ảnh (nhúng JPEG không nén lại)
→ GitHub Actions build: .exe / .dmg / .AppImage .deb
```

Dung lượng cài đặt ước tính khoảng 150MB (Electron ~100MB + Python ~50MB).

## Ghi chú kỹ thuật quan trọng

### Chuyển thành bản scan
- Gắn đúng DPI vào ảnh để giữ nguyên khổ giấy khi in.
- Đen trắng 1-bit dùng nén CCITT G4.
- JPEG nhúng trực tiếp, không nén lại lần hai.
- Xử lý từng trang theo luồng (streaming) và song song. Một trang A4 ở 600 dpi chưa nén đã khoảng 100MB RAM.
- Ước tính dung lượng bằng cách render thử 1–2 trang.
- Cảnh báo người dùng: mất text, link, bookmark, form, chữ ký số.

### Ký số
- USB token của CA Việt Nam qua PKCS#11. Tự dò đường dẫn driver của các hãng phổ biến trên từng OS.
- **Rủi ro:** driver token VN trên macOS (nhất là chip M) và Linux không đồng đều.
- Nạp sẵn chứng thư gốc (Root CA) quốc gia Việt Nam để chữ ký từ CA trong nước được nhận là tin cậy.
- Ký nhiều lần nối tiếp bằng incremental save để không phá chữ ký trước.
- Ký từ xa qua cloud (VNPT SmartCA, Viettel MySign…) để giai đoạn sau, vì cần tích hợp API riêng của từng nhà cung cấp.

### Phân phối
- macOS cần notarize (tài khoản Apple Developer 99 USD/năm), nếu không Gatekeeper sẽ chặn app.
- Windows cần chứng thư code signing, nếu không SmartScreen sẽ cảnh báo.

## Nguyên tắc giao diện (để "gọn gàng như ABBYY")
- Màn hình Start dạng **ô nhiệm vụ** ("Mở PDF", "Ghép file", "Chuyển thành bản scan", "Ký số"…).
- **Một** thanh công cụ thay đổi theo ngữ cảnh, không dùng ribbon chi chít nút.
- Mặc định chỉ hiện 3–4 lựa chọn, phần còn lại ẩn sau "▸ Nâng cao".
- Hộp thoại xử lý luôn có **xem trước** và **ước tính kết quả** nếu có thể.
- Tab nhiều file, file gần đây, chế độ tối, bảng lệnh `Ctrl+K`.

## Nhật ký

- **2026-10-31:** Bắt đầu dự án. Chốt tên Chef PDF, Electron, Python sidecar, bỏ OCR ở bản đầu, ưu tiên "Chuyển thành bản scan" và "Ký số". Soạn cây tính năng bản nháp 1 (`docs/FEATURES.md`), chờ chủ dự án góp ý.
