# Chef PDF: Ghi chú thảo luận & quyết định

> File này ghi lại toàn bộ quyết định đã chốt với chủ dự án, để các phiên làm việc sau đọc và làm tiếp.
> **Cập nhật file này mỗi khi có quyết định mới.** Mới nhất ở trên cùng của mục "Nhật ký".

## Trạng thái hiện tại

- **Giai đoạn:** Đang liệt kê tính năng ([FEATURES.md](FEATURES.md), bản nháp 3.1). **Chưa viết code.** Chủ dự án muốn liệt kê đủ trước, **lập kế hoạch và ước lượng dev sau**.
- **Việc tiếp theo:** Chủ dự án góp ý thêm tính năng → lập kế hoạch (plan) và ước lượng → chốt phạm vi v0.1 → dựng khung dự án Electron.
- **Câu hỏi còn mở:**
  - Cần hỗ trợ token của Viettel, VNPT, FPT, Ban Cơ yếu, MISA… (chủ dự án nêu). Kết quả tra cứu ở [TOKENS.md](TOKENS.md). Vẫn cần **token thật** để thử.
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
| D11 | **Sửa chữ có sẵn** trong PDF được đưa vào lộ trình (v0.6), không còn để "Sau" | Chủ dự án yêu cầu (giống ABBYY) |
| D12 | Thêm nhóm **Lớp & gỡ watermark** (bảng lớp, xem theo loại nội dung, gỡ watermark tự động) | Chủ dự án yêu cầu |
| D13 | Làm một **"bộ máy nội dung"** dùng chung (v0.5) cho: chọn/xóa đối tượng, tẩy vùng, gỡ watermark, che thông tin mật. Sửa chữ (v0.6) xây tiếp trên nền này | Làm một lần, dùng cho nhiều tính năng |
| D14 | Watermark/header/footer/số trang do Chef PDF thêm vào phải **gắn nhãn chuẩn** (marked content `/Artifact` + `/Subtype /Watermark` hoặc `/Pagination`) | Để sau này sửa/gỡ được sạch |
| D15 | Ký số có **Studio mẫu chữ ký** đầy đủ (tham khảo Foxit): chọn dòng thông tin, định dạng ngày, lý do/nơi ký, bố cục, font, logo, biểu tượng ✓; mẫu gắn với từng chứng thư | Chủ dự án yêu cầu |
| D16 | Một **thư viện ảnh chữ ký & con dấu dùng chung** (tách nền, làm sạch, đổi màu mực, mã hóa khi lưu) cho ký số, đóng dấu ảnh, chữ ký nháy, dấu giáp lai | Tránh làm trùng; ảnh chữ ký/con dấu là dữ liệu nhạy cảm |
| D17 | Thông tin hiển thị trên chữ ký mặc định lấy từ chứng thư; người dùng được ghi đè chữ hiển thị, nhưng panel kiểm tra luôn hiện thông tin thật | Chống hiểu nhầm/giả mạo người ký |

| D18 | **Không làm tính năng AI** | Chủ dự án: chưa cần thiết. Cũng khớp với nguyên tắc offline |
| D19 | Ký số hỗ trợ **cả CA công cộng và CA chuyên dùng Chính phủ (Ban Cơ yếu)**; tin cậy cả 2 hệ Root CA; driver token quản lý bằng danh bạ dữ liệu + quét tự động + màn hình chẩn đoán | Xem [TOKENS.md](TOKENS.md) |

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

### Bộ máy nội dung, sửa chữ, gỡ watermark
- pypdfium2 truy cập được API gốc của PDFium: liệt kê page object (chữ/ảnh/vector), xóa, di chuyển, tạo text object mới. pikepdf dùng để đọc/ghi trực tiếp luồng nội dung (content stream) khi cần can thiệp sâu hơn.
- **Sửa chữ:** khó nhất là font. File PDF thường chỉ nhúng tập con (subset) font, nên hay thiếu ký tự tiếng Việt khi sửa. Cần cơ chế thay font gần giống (đóng gói sẵn vài font Unicode mở như Noto, Be Vietnam Pro…). Làm mức dòng trước, mức đoạn (gom dòng + tự xuống dòng) sau.
- **Dò watermark**, theo thứ tự độ tin cậy giảm dần:
  1. Marked content `/Artifact` có `/Subtype /Watermark` (cách Acrobat và các app chuẩn gắn).
  2. Lớp OCG có tên kiểu "watermark".
  3. Annotation có kiểu `/Watermark`.
  4. Heuristic: XObject hoặc chữ lặp lại ở cùng vị trí trên phần lớn số trang, bị xoay chéo, hoặc trong suốt (ExtGState `CA`/`ca` < 1).
  - Luôn hiện danh sách ứng viên kèm xem trước để người dùng chọn, **không tự xóa**.
- Watermark đã dính vào ảnh scan thì phải xử lý ảnh, để "Sau".
- Chức năng gỡ watermark dùng cho tài liệu người dùng có quyền chỉnh sửa (ví dụ tài liệu của chính mình hoặc công ty mình).

### Đặc thù Việt Nam
- **Dấu giáp lai:** một ảnh dấu được cắt thành N phần, mỗi phần đặt ở mép phải một trang.
- **Đánh số trang theo Nghị định 30/2020/NĐ-CP:** số Ả Rập, canh giữa trong lề trên, không hiển thị số ở trang đầu.
- **Tách nền ảnh dấu/chữ ký** chụp bằng điện thoại: lọc theo màu mực (đỏ/xanh), nền thành trong suốt.

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

- **2026-10-31 (4):** Bỏ trợ lý AI (P6). Chủ dự án cần hỗ trợ token Viettel, VNPT, FPT, Cơ yếu, MISA… Claude tra cứu và ghi vào `docs/TOKENS.md`: có 2 hệ CA (công cộng / chuyên dùng Chính phủ), token đa số là chip Feitian/SafeNet/Bit4id đóng gói lại, driver khác nhau theo từng đời token. Thêm K6–K9 (danh bạ driver, quét driver, chẩn đoán token, cảnh báo PIN). Chủ dự án: liệt kê tính năng trước, lập plan và ước lượng sau.
- **2026-10-31 (3):** Chủ dự án yêu cầu tùy chỉnh chữ ký số kiểu Foxit (ảnh ký, tách nền, người ký, ngày, nơi ký, lý do…). Claude mở rộng nhóm K thành 5 phần (K-A nguồn chứng thư, K-B Studio mẫu chữ ký, K-C ảnh chữ ký & con dấu, K-D đặt chữ ký & ký, K-E kiểm tra), **đánh lại mã nhóm K**. Đối chiếu với PDF24, Stirling-PDF, Acrobat, Smallpdf, iLovePDF, thêm: xóa trang trắng, chia đôi trang, tách thông minh, chỉnh ảnh trong PDF, giấy tiêu đề, QR/mã vạch, chữ ký nháy, chụp tài liệu bằng điện thoại qua QR, soi file, kiểm tra trước khi gửi, chuyển màu/tiết kiệm mực, web/Markdown → PDF, đổi tên hàng loạt, quy trình mẫu, trợ lý AI tùy chọn. (Không mở được trang danh sách đầy đủ của PDF24 và tài liệu Stirling-PDF vì mạng phiên bị chặn, nên tổng hợp từ kết quả tìm kiếm.)
- **2026-10-31 (2):** Chủ dự án bổ sung: sửa chữ PDF, bóc tách lớp để gỡ watermark, thêm watermark/con dấu ảnh, số trang, header/footer. Claude đối chiếu với ABBYY và thêm: chọn/sửa đối tượng, tẩy vùng, thay ảnh, tìm & thay thế, dấu giáp lai, tách nền ảnh dấu, dấu động, Bates, gỡ nền, làm đẹp bản scan, sửa file hỏng, file đính kèm, metadata, máy in ảo, quét từ máy scan. Sắp xếp lại cây thành 5 khu vực, **đánh lại mã** (bản nháp 2). Lộ trình kéo dài đến v0.7.
- **2026-10-31:** Bắt đầu dự án. Chốt tên Chef PDF, Electron, Python sidecar, bỏ OCR ở bản đầu, ưu tiên "Chuyển thành bản scan" và "Ký số". Soạn cây tính năng bản nháp 1 (`docs/FEATURES.md`), chờ chủ dự án góp ý.
