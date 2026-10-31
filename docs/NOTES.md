# Chef PDF: Ghi chú thảo luận & quyết định

> File này ghi lại toàn bộ quyết định đã chốt với chủ dự án, để các phiên làm việc sau đọc và làm tiếp.
> **Cập nhật file này mỗi khi có quyết định mới.** Mục "Nhật ký" ghi mới nhất ở trên cùng.

## Trạng thái hiện tại

- **Giai đoạn:** ✅ **Đã chốt cây tính năng 1.0** ([FEATURES.md](FEATURES.md), ngày 2026-10-31). **Chưa viết code.**
- **Phạm vi đã chốt:** 190 tính năng (gồm 8 tính năng thêm sau khi chốt), trong đó:

  | Mức | Số tính năng |
  |---|---|
  | Bản 1.0 (v0.1–v0.8) | 153 |
  | Sau 1.0 | 4 |
  | Gói nâng cấp OCR/AI | 12 |
  | Ý tưởng chưa cam kết | 21 |

  **Mã tính năng trong FEATURES.md là mã chính thức**, mã ở các bản nháp trước đã bỏ.
- **Việc tiếp theo:** **Lập kế hoạch và ước lượng dev**: chia việc theo từng bản v0.1 → v0.8, ước lượng công sức, xác định rủi ro và thứ phải làm trước. Sau đó dựng khung dự án Electron cho v0.1.
- **Quy tắc sau khi chốt:** thay đổi phạm vi phải ghi vào mục "Thay đổi sau khi chốt" cuối FEATURES.md và vào nhật ký ở đây.
- **Câu hỏi còn mở:**
  - App để tự dùng hay sẽ phát hành/bán? Câu này ảnh hưởng chi phí ký mã (Apple Developer 99 USD/năm, chứng thư code signing cho Windows).
  - Cần **token thật** (Viettel, VNPT, FPT, Ban Cơ yếu, MISA…) để thử ký số. Xem [TOKENS.md](TOKENS.md).

## Mục tiêu sản phẩm

- App PDF desktop **mạnh nhưng gọn gàng**, lấy cảm hứng từ ABBYY FineReader. Chủ dự án chê các app miễn phí hiện có là rối.
- Chạy được trên **Windows, macOS, Linux**.
- **Offline hoàn toàn**, không tải file lên server.
- **Tiếng Việt là ưu tiên số 1**: giao diện, font, tìm không dấu, thể thức văn bản hành chính, chữ ký số Việt Nam.
- **Bản 1.0 không có OCR, không có AI.**

## Các quyết định đã chốt

Mã tính năng ghi trong bảng này là mã chính thức của FEATURES.md 1.0.

| # | Quyết định | Lý do |
|---|---|---|
| D1 | Tên app: **Chef PDF** (repo vẫn tên `powerpdf`) | "Power PDF" trùng tên thương mại của Kofax/Tungsten (trước là Nuance) |
| D2 | **Bản 1.0 không làm OCR.** OCR thuộc gói nâng cấp (nhóm Q) | Chủ dự án yêu cầu |
| D3 | Vỏ app: **Electron** (không dùng Tauri, không làm webapp thuần) | Electron mang Chromium theo app nên hiển thị giống hệt trên 3 OS, thử trên 1 máy là gần đủ. Tauri dùng 3 lõi khác nhau (WebView2 / WKWebView / WebKitGTK), Linux hay lỗi canvas. **WebView2 chỉ có trên Windows.** Webapp thuần không truy cập được USB token |
| D4 | Giao diện: **React + TypeScript**, xem PDF bằng **pdf.js** | Dễ làm đẹp. UI tách khỏi vỏ để sau này có thể chuyển sang Tauri hoặc làm bản web rút gọn |
| D5 | Lõi xử lý: **Python sidecar** đóng gói kèm app (PyInstaller, chế độ onedir) | Có pyHanko, thư viện ký PDF tốt nhất |
| D6 | Thư viện lõi: **pyHanko** (ký số), **pypdfium2** (render, đối tượng trang), **pikepdf** (thao tác PDF), **Pillow + img2pdf** (ảnh), **OpenCV** (xử lý ảnh scan: nắn, khử nhiễu, tách màu, dò màu da, inpainting) | Đều có giấy phép thoáng (OpenCV 4.5+ dùng Apache-2.0) |
| D7 | **Tránh thư viện AGPL:** PyMuPDF/MuPDF, Ghostscript, iText | Giữ quyền bán app mã nguồn đóng sau này |
| D8 | Build bằng **GitHub Actions** cho 3 OS (A8) | Chủ dự án không cần có đủ 3 máy |
| D9 | Tính năng chủ lực ★: **Chuyển thành bản scan** (K), **Ký số** (I), **Quy trình tự động** (O) | Chủ dự án yêu cầu |
| D10 | Bước chuyển thành bản scan luôn đứng **trước** bước ký số; app tự sắp xếp và cảnh báo (O5, K9) | Raster hóa sau khi ký làm mất chữ ký |
| D11 | **Sửa chữ có sẵn** (D8, D9) thuộc bản 1.0 (v0.6) | Chủ dự án yêu cầu, giống ABBYY |
| D12 | Có nhóm **Lớp & gỡ watermark** (E) | Chủ dự án yêu cầu |
| D13 | Làm một **"bộ máy nội dung"** dùng chung (v0.5) cho chọn/xóa đối tượng (D4), tẩy vùng (D5), gỡ watermark (E3, E4), che thông tin mật (J6). Sửa chữ (v0.6) xây tiếp trên nền này | Làm một lần, dùng cho nhiều tính năng |
| D14 | Watermark/header/footer/số trang do Chef PDF thêm phải **gắn nhãn chuẩn**: marked content `/Artifact` với `/Subtype /Watermark` hoặc `/Pagination` (F1, F12) | Để sửa/gỡ được sạch |
| D15 | Ký số có **Studio mẫu chữ ký** (I-B), tham khảo Foxit; mẫu gắn với từng chứng thư | Chủ dự án yêu cầu |
| D16 | Một **thư viện ảnh chữ ký & con dấu dùng chung** (I-C) cho ký số, con dấu ảnh (F3), giáp lai (F4), chữ ký nháy (F6); mã hóa khi lưu | Tránh làm trùng; đây là dữ liệu nhạy cảm |
| D17 | Thông tin hiển thị trên chữ ký mặc định lấy từ chứng thư. Được ghi đè chữ hiển thị, nhưng panel kiểm tra (I34) luôn hiện thông tin thật | Chống hiểu nhầm, giả mạo người ký |
| D18 | **Không có trợ lý AI** (chat, tóm tắt, hỏi đáp) | Chủ dự án: chưa cần thiết |
| D19 | Ký số hỗ trợ **cả CA công cộng và CA chuyên dùng Chính phủ (Ban Cơ yếu)**; tin cậy cả 2 hệ Root CA (I35); quản lý driver token bằng danh bạ dữ liệu (I4), quét tự động (I5) và màn hình chẩn đoán (I6) | Xem [TOKENS.md](TOKENS.md) |
| D20 | **Rã tài liệu & tái tạo định dạng** (N) thuộc bản 1.0 cho **PDF có chữ**, dò bố cục bằng quy tắc, không dùng mô hình | Chủ dự án hỏi; phần scan cần OCR |
| D21 | Định dạng trung gian là **mô hình tài liệu JSON** (khối, vị trí, kiểu chữ, độ tin cậy). Markdown chỉ là một định dạng xuất | Markdown làm mất bố cục |
| D22 | **Gói nâng cấp nhận dạng** (Q) gồm OCR, mô hình AI chạy trên máy, hoặc API nhận dạng trả phí. Làm ở **phiên bản nâng cấp sau này**, không thuộc 1.0. Mô hình đóng thành gói tải riêng; API mặc định tắt | Chủ dự án xác nhận ngày 2026-10-31 |
| D23 | **Chốt cây tính năng 1.0** gồm 182 tính năng, 4 mức (Bản 1.0 / Sau 1.0 / Nâng cấp / Ý tưởng). Các mục từng đánh dấu 🤔 đã được xếp mức. Lập kế hoạch và ước lượng làm ở bước sau | Chủ dự án yêu cầu |
| D24 | Thêm **trình sửa ảnh trang** và **xóa ngón tay** vào bản 1.0 (L9–L14), làm bằng thuật toán xử lý ảnh cổ điển (OpenCV). Bản tự động hoàn toàn bằng mô hình nằm ở gói nâng cấp (Q11, Q12) | Chủ dự án bổ sung; đánh giá là làm được |

## Kiến trúc dự kiến

```
Chef PDF
├── Vỏ app: Electron (Chromium, chạy giống nhau trên Win/Mac/Linux)
├── Giao diện: React + TypeScript + pdf.js
└── Lõi xử lý: Python sidecar, giao tiếp qua local API (HTTP/IPC trên localhost)
    ├── pikepdf: ghép/tách/xoay, mật khẩu, nén, content stream
    ├── pypdfium2: render trang, liệt kê/sửa đối tượng trang
    ├── pyHanko: ký số PAdES (B-B, B-T, B-LT, B-LTA), PKCS#11, PFX, TSA, kiểm tra chữ ký
    ├── Pillow + img2pdf: xử lý ảnh, tạo PDF ảnh (nhúng JPEG không nén lại)
    └── OpenCV: làm đẹp bản scan, trình sửa ảnh trang, xóa ngón tay
→ GitHub Actions build: .exe / .msi / .dmg / .AppImage / .deb / .rpm
(Gói nâng cấp Q: các mô hình OCR/bố cục tải riêng, chạy trong cùng Python sidecar)
```

Dung lượng cài đặt ước tính khoảng 150MB (Electron ~100MB + Python ~50MB), chưa tính gói nâng cấp.

## Ghi chú kỹ thuật quan trọng

### Chuyển thành bản scan (K)
- Gắn đúng DPI vào ảnh để giữ nguyên khổ giấy khi in.
- Đen trắng 1-bit dùng nén CCITT G4.
- JPEG nhúng trực tiếp, không nén lại lần hai.
- Xử lý từng trang theo luồng và song song. Một trang A4 ở 600 dpi chưa nén đã khoảng 100MB RAM.
- Ước tính dung lượng bằng cách render thử 1–2 trang.
- Cảnh báo: mất text, link, bookmark, form, chữ ký số.

### Ký số (I)
- USB token của CA Việt Nam qua PKCS#11. Ưu tiên PKCS#11 hơn CSP trên Windows, vì driver CSP của Viettel-CA V6 tự bật cửa sổ PIN riêng. Chi tiết ở [TOKENS.md](TOKENS.md).
- **Rủi ro:** driver token Việt Nam trên macOS (nhất là chip M) và Linux không đồng đều.
- Ký nhiều lần nối tiếp bằng incremental save để không phá chữ ký trước.
- Ký từ xa qua cloud (I9) để sau 1.0, vì mỗi nhà cung cấp có API riêng.

### Bộ máy nội dung, sửa chữ, gỡ watermark (D, E, J6)
- pypdfium2 truy cập được API gốc của PDFium: liệt kê page object (chữ/ảnh/vector), xóa, di chuyển, tạo text object mới. pikepdf dùng để đọc/ghi trực tiếp content stream khi cần can thiệp sâu.
- **Sửa chữ:** khó nhất là font. File PDF thường chỉ nhúng một phần bộ font (subset), hay thiếu ký tự tiếng Việt khi sửa. Cần cơ chế thay font gần giống (đóng gói sẵn vài font Unicode mở như Noto, Be Vietnam Pro…). Làm mức dòng trước, mức đoạn sau.
- **Dò watermark**, theo độ tin cậy giảm dần:
  1. Marked content `/Artifact` có `/Subtype /Watermark`.
  2. Lớp OCG có tên kiểu "watermark".
  3. Annotation kiểu `/Watermark`.
  4. Heuristic: XObject hoặc chữ lặp ở cùng vị trí trên phần lớn số trang, xoay chéo, hoặc trong suốt (ExtGState `CA`/`ca` < 1).
  - Luôn hiện danh sách ứng viên kèm xem trước, **không tự xóa**.
- Gỡ watermark dùng cho tài liệu người dùng có quyền chỉnh sửa (tài liệu của mình hoặc của công ty mình).

### Trình sửa ảnh trang & xóa ngón tay (L9–L14)
- Trang scan trong PDF thường là 1 ảnh mỗi trang. Sửa xong thì thay ảnh vào đúng chỗ (cùng cơ chế với D6). Lưu ảnh gốc cùng danh sách thao tác để hoàn nguyên được.
- **Tô màu nền giấy:** ước lượng màu giấy từ vùng xung quanh (trung vị), thêm nhiễu nhẹ giống hạt giấy. Vùng nhỏ nằm sát chữ thì dùng inpainting của OpenCV (Telea / Navier-Stokes).
- **Xóa ngón tay:** ngón tay hầu như luôn nằm ở lề trang và chạm mép. Cách làm:
  1. Tìm vùng có màu da trong không gian màu YCrCb/HSV.
  2. Chỉ giữ những vùng nối liền với mép trang.
  3. Nới rộng vùng một chút (dilate) cho trùm cả bóng ngón tay.
  4. Tô bằng màu nền giấy.
  - **Dễ sai khi:** giấy ngả vàng gần màu da, ánh sáng vàng, da tối màu, có ảnh người trên trang. Vì vậy luôn **đề xuất rồi cho người dùng chỉnh**, không tự áp dụng.
  - Chữ bị ngón tay che thì không khôi phục được. vFlat cũng không làm được việc này.
- **Làm phẳng trang cong:** dò các dòng chữ, khớp một bề mặt cong rồi kéo phẳng. Đã có thuật toán mã nguồn mở theo hướng này (ví dụ dự án page-dewarp), cần kiểm tra giấy phép. Trang ít chữ hoặc cong mạnh thì cần mô hình (Q12).
- Bộ công cụ này kết hợp với chụp bằng điện thoại (L5) tạo thành quy trình **chụp sách** hoàn chỉnh. Nên xem lại việc đưa L6 (tách trang đôi) vào bản 1.0.

### Đặc thù Việt Nam
- **Dấu giáp lai (F4):** một ảnh dấu cắt thành N phần, mỗi phần đặt ở mép phải một trang.
- **Đánh số trang theo Nghị định 30/2020/NĐ-CP (F8):** số Ả Rập, canh giữa trong lề trên, không hiển thị số ở trang đầu.
- **Tách nền ảnh dấu/chữ ký (I20):** lọc theo màu mực (đỏ/xanh), nền thành trong suốt.

### Rã tài liệu (N) và gói nâng cấp (Q): thư viện ứng viên và giấy phép
Giấy phép ghi theo hiểu biết hiện tại của Claude. **Phải kiểm tra lại trước khi dùng.**
- **Bản 1.0 (N):** tự dò bố cục bằng quy tắc trên dữ liệu chữ của pypdfium2 (vị trí, font, cỡ chữ). Xuất DOCX bằng python-docx (MIT).
- **Gói nâng cấp (Q), dùng được:** Docling (IBM, MIT), PaddleOCR / PP-Structure (Apache-2.0), Tesseract (Apache-2.0, có dữ liệu `vie`), VietOCR (Apache-2.0), EasyOCR (Apache-2.0).
- **Tránh hoặc cẩn thận:** Marker và Surya (code GPL, trọng số mô hình hạn chế dùng thương mại), MinerU (từng dùng AGPL). Pandoc là GPL: chỉ gọi như chương trình riêng, hoặc tự viết bộ xuất.
- Mô hình chạy trên CPU mất khoảng vài giây mỗi trang. Có GPU thì nhanh hơn nhiều.

### Phân phối
- macOS cần notarize (tài khoản Apple Developer 99 USD/năm), nếu không Gatekeeper sẽ chặn app.
- Windows cần chứng thư code signing, nếu không SmartScreen sẽ cảnh báo.

## Nguyên tắc giao diện (để "gọn gàng như ABBYY")
- Màn hình Start dạng **ô nhiệm vụ** cộng các quy trình đã lưu.
- **Một** thanh công cụ thay đổi theo ngữ cảnh, không dùng ribbon chi chít nút.
- Tab: Xem · Trang · Chỉnh sửa · Ghi chú · Form · Ký & Bảo mật · Xuất · Quy trình.
- Mặc định chỉ hiện 3–4 lựa chọn, phần còn lại ẩn sau "▸ Nâng cao".
- Hộp thoại xử lý luôn có **xem trước**, và **ước tính kết quả** nếu có thể.
- Tab nhiều file, file gần đây, chế độ tối, bảng lệnh `Ctrl+K`.

## Nhật ký

- **2026-10-31 (7):** Thêm sau khi chốt: trình sửa ảnh trang kiểu ABBYY OCR Editor và xóa ngón tay kiểu vFlat Scan → L9–L14 (v0.7), Q11–Q12 (nâng cấp). Thêm OpenCV vào thư viện lõi (D6), thêm D24. Tổng còn 190 tính năng.
- **2026-10-31 (6):** Chủ dự án xác nhận: mô hình AI chạy trên máy hoặc API nhận dạng trả phí để dành cho phiên bản nâng cấp sau; chưa cần chạy thử file mẫu. Yêu cầu tổng hợp thành cây tính năng chuẩn và chốt. Claude viết lại FEATURES.md thành **bản 1.0 đã chốt**: 7 khu vực, 17 nhóm A–Q, **đánh lại toàn bộ mã** cho liền mạch, xếp mọi mục 🤔 vào một trong 4 mức, tách phần OCR/AI thành nhóm Q (gói nâng cấp). Tổng 182 tính năng. Viết lại NOTES.md (D2, D20, D22 cập nhật; thêm D23). Bước tiếp theo: lập kế hoạch và ước lượng.
- **2026-10-31 (5):** Chủ dự án hỏi về tính năng rã PDF thành Markdown rồi tái tạo ra định dạng khác. Claude đánh giá theo mức khó và đề xuất dùng mô hình tài liệu JSON làm định dạng trung gian.
- **2026-10-31 (4):** Bỏ trợ lý AI. Chủ dự án cần hỗ trợ token Viettel, VNPT, FPT, Cơ yếu, MISA… Claude tra cứu và ghi vào `docs/TOKENS.md`. Thêm danh bạ driver, quét driver, chẩn đoán token, cảnh báo PIN. Chủ dự án muốn liệt kê tính năng trước, lập kế hoạch sau.
- **2026-10-31 (3):** Chủ dự án yêu cầu tùy chỉnh chữ ký số kiểu Foxit. Claude mở rộng nhóm ký số thành 5 phần; đối chiếu với PDF24, Stirling-PDF, Acrobat, Smallpdf, iLovePDF để bổ sung tính năng. (Không mở được trang danh sách đầy đủ của PDF24 và tài liệu Stirling-PDF vì mạng phiên bị chặn, nên tổng hợp từ kết quả tìm kiếm.)
- **2026-10-31 (2):** Chủ dự án bổ sung: sửa chữ PDF, bóc tách lớp để gỡ watermark, watermark/con dấu ảnh, số trang, header/footer. Claude đối chiếu với ABBYY và thêm nhiều tính năng.
- **2026-10-31 (1):** Bắt đầu dự án. Chốt tên Chef PDF, Electron, Python sidecar, bỏ OCR ở bản đầu, ưu tiên "Chuyển thành bản scan" và "Ký số".
