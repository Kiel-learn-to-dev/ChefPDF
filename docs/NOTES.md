# Chef PDF: Ghi chú thảo luận & quyết định

> File này ghi lại toàn bộ quyết định đã chốt với chủ dự án, để các phiên làm việc sau đọc và làm tiếp.
> **Cập nhật file này mỗi khi có quyết định mới.** Mục "Nhật ký" ghi mới nhất ở trên cùng.

## Trạng thái hiện tại

- **Giai đoạn:** đang triển khai và kiểm thử các mốc v0.5 đến v0.10; **bản 1.0 chỉ cam kết Windows** (D37). Kế hoạch từng bước ở [PLAN_V1.md](PLAN_V1.md).
- **Số liệu (2026-11-04):** [TASKS.md](TASKS.md) có 119 task: 87 xong, 26 đang làm, 5 chưa làm, 1 tạm dừng (T9.08). Hôm nay chạy: typecheck, lint, ruff, mypy (lõi) sạch; pytest hai file pageimg 84 đạt; giao diện 755 đạt; desktop 230 đạt (1 bỏ qua); e2e 15 đạt (demo-v08, capture, crop-review, dewarp, smoke). Bộ e2e đủ và pytest lõi đủ (1638) chưa chạy lại từ 2026-11-03; không còn `test.fixme`. CI GitHub: Core, JS, E2E Windows xanh (lượt trước); E2E Linux/macOS không chặn.
- **Ký số:** token Viettel V6 trên máy chính (Windows) đã ký thật thành công qua lõi của app (PAdES B-B); chủ dự án chấp nhận kết quả và đã trả token. Đã đóng T1.08, T3.01–T3.03. Còn: ảnh Adobe Reader/Foxit (T3.14), ký từ giao diện app và ký hàng loạt (cần token lần nữa, gộp vào một lần cuối mốc v0.9).
- **Phạm vi đã chốt:** 196 tính năng (đã tính các thay đổi sau khi chốt), trong đó:

  | Mức | Số tính năng |
  |---|---|
  | Bản 1.0 (v0.1–v0.10) | 161 |
  | Sau 1.0 | 5 |
  | Gói nâng cấp OCR/AI | 12 |
  | Ý tưởng chưa cam kết | 20 |

  **Mã tính năng trong FEATURES.md là mã chính thức**, mã ở các bản nháp trước đã bỏ.
- **Việc tiếp theo (Windows):** (1) mốc v0.8: Demo đã có và đạt (`demo-v08.spec.ts`), còn 6 task 🔄 cần giao diện (T8.01, T8.02, T8.03, T8.07, T8.08, T8.10), rồi v0.9, v0.10; (2) cuối v0.9: một lần dùng token để ký từ giao diện và ký hàng loạt; (3) cổng 1.0: hiệu năng, giấy phép, đánh bóng, hướng dẫn, dùng một tuần. Việc phụ chờ chủ dự án: ảnh Adobe Reader/Foxit, đối chiếu dấu vân tay Root CA.
- **Để sau 1.0:** macOS và Linux (kiểm thử, bộ cài, driver token), tự cập nhật. Chi tiết ở mục "Sau 1.0" của PLAN_V1.md.
- **Quy tắc sau khi chốt:** thay đổi phạm vi phải ghi vào mục "Thay đổi sau khi chốt" cuối FEATURES.md và vào nhật ký ở đây.
- **Câu hỏi còn mở:**
  - Điện thoại dùng thử trang chụp (Android hay iPhone, trình duyệt nào)?
  - Ngoài Viettel, bản 1.0 có cần thử thêm CA khác? Mặc định: không.
  - Đã đóng: CH1 (Windows, Viettel-CA), CH2 (chưa cần tự cập nhật). Thông tin token ở [TOKENS.md](TOKENS.md).

## Mục tiêu sản phẩm

- App PDF desktop **mạnh nhưng gọn gàng**, lấy cảm hứng từ ABBYY FineReader. Chủ dự án chê các app miễn phí hiện có là rối.
- Chạy được trên **Windows, macOS, Linux**; **bản 1.0 ưu tiên và chỉ cam kết Windows** (D37), macOS và Linux sau 1.0.
- **Offline hoàn toàn**, không tải file lên server.
- **Tiếng Việt là ưu tiên số 1**: giao diện, font, tìm không dấu, thể thức văn bản hành chính, chữ ký số Việt Nam.
- **Bản 1.0 không có OCR, không có AI.** Ngoại lệ duy nhất: mô hình dò viền trang loại nhỏ (L20).

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
| D11 | **Sửa chữ có sẵn** (D8, D9) thuộc bản 1.0 (v0.7 sau khi chia lại mốc) | Chủ dự án yêu cầu, giống ABBYY |
| D12 | Có nhóm **Lớp & gỡ watermark** (E) | Chủ dự án yêu cầu |
| D13 | Làm một **"bộ máy nội dung"** dùng chung (v0.6 sau khi chia lại mốc) cho chọn/xóa đối tượng (D4), tẩy vùng (D5), gỡ watermark (E3, E4), che thông tin mật (J6). Sửa chữ (v0.7) xây tiếp trên nền này | Làm một lần, dùng cho nhiều tính năng |
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
| D25 | Thêm **tự dò viền trang & cắt** (L15–L19) vào bản 1.0, làm bằng thuật toán OpenCV. Bản dùng mô hình ở gói nâng cấp (ban đầu là Q13, nay đã thành L20, xem D26). Phân biệt rõ: cắt trang PDF thường thì đặt lại CropBox (C7); cắt ảnh scan thì cắt điểm ảnh thật (L15–L19) | Chủ dự án bổ sung; đánh giá là làm được |
| D26 | **Ngoại lệ AI duy nhất ở bản 1.0:** mô hình dò viền trang loại nhỏ (**L20**, vài MB, ONNX Runtime trên CPU, đi kèm bản cài). Chạy song song với thuật toán L15, lấy kết quả tin cậy hơn. Mã Q13 bỏ | Chủ dự án đồng ý; mô hình nhẹ mà khắc phục đúng điểm yếu của thuật toán |
| D27 | **L6 (tách trang đôi)** vào bản 1.0 (v0.8 sau khi chia lại mốc). Thêm quy trình mẫu **"Chụp sách"** vào O7 | Chủ dự án đồng ý; để đủ quy trình chụp sách |
| D28 | **App chỉ để chủ dự án tự dùng**, không phát hành. Hệ quả: không ký mã, không notarize (bỏ qua cảnh báo khi cài); tự cập nhật trên macOS chỉ báo có bản mới; AGPL không còn là rào cản pháp lý, vẫn giữ D7 nhưng được xem lại nếu spike S2 cho thấy cần PyMuPDF | Chủ dự án trả lời ngày 2026-10-31 |
| D29 | **Chia lại mốc** thành v0.1 → v0.10 → 1.0 (11 mốc), theo BLUEPRINT mục 13. Nhãn "Mức" trong FEATURES.md đã cập nhật | v0.4 cũ có 43 tính năng, quá nặng |
| D30 | Kiến trúc **mô hình thao tác (Operation)**: mỗi tính năng tác động lên tài liệu là một operation có Params dạng pydantic (sinh JSON Schema và kiểu TS). UI, hàng loạt, quy trình và dòng lệnh dùng chung | Chi tiết ở BLUEPRINT mục 3 |
| D31 | Main ↔ lõi Python giao tiếp bằng **JSON-RPC 2.0 qua stdin/stdout** (không mở cổng mạng). Dữ liệu lớn truyền bằng đường dẫn file | BLUEPRINT mục 5 |
| D35 | **Máy chính: Windows; token: Viettel-CA** (module PKCS#11 `viettel-ca_v6.dll` hoặc đời cũ, xem TOKENS.md). Windows là nền kiểm thử tay chính; macOS và Linux kiểm thử bằng CI | Chủ dự án trả lời CH1 |
| D36 | **Tự cập nhật (A10, T9.08) làm sau 1.0**; bản 1.0 cập nhật bằng cách cài bản mới. CH2 đóng | Chủ dự án trả lời CH2 |
| D38 | **Tạo PDF từ trang đã chọn** là `page.extract` ra file mới rồi mở file đó ở tab mới (như "Lưu bản sao" của file đã ký), không dùng tài liệu tạm chưa lưu. Được làm cả với file đã ký vì không sửa file gốc. Menu chuột phải chỉ ở lưới trang: thanh bên thumbnail chưa có chọn nhiều | Phiên T11.06, 2026-11-03 |
| D39 | **Chụp sách: cắt trước, tách trang đôi sau**, rồi nghiêng và làm trắng. Máy chủ chụp giữ giới hạn 5 yêu cầu/giây; máy khách (điện thoại) thử lại khi nhận 429 theo `Retry-After`. Làm phẳng và xóa ngón tay không nằm trong luồng chụp (chạy trên trang sau khi tạo PDF) | Khe gáy chỉ tìm được khi ảnh đã cắt đúng quyển sách (ảnh có nền bàn không tìm thấy khe). Lỗi lộ ra ở Demo v0.8 |
| D37 | **Bản 1.0 ưu tiên Windows.** macOS và Linux để sau 1.0: code vẫn giữ chạy được và CI vẫn chạy nhưng E2E Linux/macOS không chặn; lỗi riêng của chúng không sửa trước 1.0. Thay D35 phần "macOS và Linux kiểm thử bằng CI" | Chủ dự án, 2026-11-03 |
| D32 | **Phiên tài liệu** dùng bản sao làm việc và các bản sửa trên đĩa; không động vào file gốc tới khi Lưu; hoàn tác bằng bản sửa | BLUEPRINT mục 4 |
| D33 | **Giữ stack giấy phép thoáng (D7)** cho sửa đối tượng/chữ: pypdfium2 + pikepdf + fontTools. Không dùng PyMuPDF | Spike S2: đủ sức; PyMuPDF còn làm lộ chữ đã che qua `/ActualText` trong mẫu thử |
| D34 | Giao diện chữ ký số **tự vẽ bằng reportlab** rồi nhúng vào, không dùng bộ vẽ chữ của pyHanko. Giữ **một phiên đăng nhập cho mỗi token**; đọc lại cờ PIN ngay trước mỗi lần hỏi PIN | Spike S1: pyHanko 0.38 giãn chữ sai với font TrueType; đăng nhập lần 2 trong cùng tiến trình bị lỗi |
| D40 | **Hook test giao diện:** `apps/ui/src/main.tsx` lộ `useUi` ra `window.__chefUi` (một dòng, không bọc điều kiện) để bộ đo giao diện (`ui-audit.spec.ts`) mở hộp thoại và tab bằng `getState()`/`openDialog()`. Bản e2e chạy trên dist production nên không thể dùng cờ dev | Kế hoạch [UI_AUDIT.md](UI_AUDIT.md) mục 2; không lộ hàm đổi trạng thái ra ngoài ngoài test |

## Kiến trúc dự kiến

Chi tiết đầy đủ ở [BLUEPRINT.md](BLUEPRINT.md). Tóm tắt:

```
Chef PDF
├── Vỏ app: Electron (Chromium, chạy giống nhau trên Win/Mac/Linux)
├── Giao diện: React + TypeScript + pdf.js
└── Lõi xử lý: Python sidecar, giao tiếp qua local API (HTTP/IPC trên localhost)
    ├── pikepdf: ghép/tách/xoay, mật khẩu, nén, content stream
    ├── pypdfium2: render trang, liệt kê/sửa đối tượng trang
    ├── pyHanko: ký số PAdES (B-B, B-T, B-LT, B-LTA), PKCS#11, PFX, TSA, kiểm tra chữ ký
    ├── Pillow + img2pdf: xử lý ảnh, tạo PDF ảnh (nhúng JPEG không nén lại)
    ├── OpenCV: làm đẹp bản scan, trình sửa ảnh trang, xóa ngón tay, dò viền trang
    └── ONNX Runtime (MIT): chạy mô hình dò viền trang L20
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

### Tự dò viền trang & cắt (L15–L19)
- **Bản scan máy:** dò viền tối hoặc vùng bóng quanh tờ giấy bằng ngưỡng màu và hình chiếu theo hàng/cột. Dễ, độ chính xác cao.
- **Ảnh chụp điện thoại:** dò cạnh (Canny) → tìm đường thẳng (Hough/LSD) → tạo các tứ giác ứng viên → **chấm điểm theo độ tương phản giữa trong và ngoài viền** → chọn tứ giác tốt nhất → nắn phối cảnh. Dropbox mô tả quy trình tương tự (dò cạnh + Hough) cho app scan của họ; có một bài báo đề xuất chấm điểm tứ giác theo độ tương phản để giảm lỗi khi nền gần màu giấy.
- **Dễ hỏng khi:** giấy và nền cùng màu, nền nhiều họa tiết, cạnh giấy bị ngón tay che hoặc đứt đoạn, trang sách cong. Cách xử lý: điểm tin cậy thấp thì không tự cắt mà đánh dấu để người dùng sửa (L18); sửa tay bằng kéo 4 góc (L17).
- **Mô hình (L20, thuộc bản 1.0 theo D26):** ứng viên DocAligner (DocsaidLab) dò 4 góc bằng mô hình nhẹ chạy ONNX trên CPU; trang tổng hợp ghi giấy phép Apache-2.0, **cần kiểm tra giấy phép cả code lẫn trọng số mô hình**. Nếu giấy phép không ổn thì phải tìm mô hình khác hoặc tự huấn luyện. ONNX Runtime làm bản cài nặng thêm khoảng vài chục MB.
- Dùng chung với chụp bằng điện thoại (L5): dò viền ngay khi ảnh về máy.

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
- App tự dùng (D28) nên **không ký mã**. Khi cài trên Windows bấm "More info → Run anyway"; trên macOS chuột phải → Open, hoặc `xattr -dr com.apple.quarantine "/Applications/Chef PDF.app"`.

## Nguyên tắc giao diện (để "gọn gàng như ABBYY")
- Màn hình Start dạng **ô nhiệm vụ** cộng các quy trình đã lưu.
- **Một** thanh công cụ thay đổi theo ngữ cảnh, không dùng ribbon chi chít nút.
- Tab: Xem · Trang · Chỉnh sửa · Ghi chú · Form · Ký & Bảo mật · Xuất · Quy trình.
- Mặc định chỉ hiện 3–4 lựa chọn, phần còn lại ẩn sau "▸ Nâng cao".
- Hộp thoại xử lý luôn có **xem trước**, và **ước tính kết quả** nếu có thể.
- Tab nhiều file, file gần đây, chế độ tối, bảng lệnh `Ctrl+K`.

## Nhật ký

- **2026-11-04 (đo giao diện, lượt A3–A7 và sửa checkbox):** Bộ đo giao diện đã đủ: `tests/e2e/specs/ui-audit.spec.ts` đi qua 97 màn hình (start, 8 tab, 5 tab bên, 3 lớp phủ, 64 hộp thoại, cộng biến thể cho tab và mục "Nâng cao"). Luật đo nằm ở `fixtures/uiAuditRules.ts` (hai nhóm: theo phần tử và theo quan hệ), đối chứng dương ở `ui-audit-selftest.spec.ts` (mọi luật đều bắt được lỗi cài sẵn). Baseline số lượng ở `tests/e2e/ui-audit-baseline.json`, snapshot pixel ở `tests/e2e/ui-audit-snapshots/` (gitignore). Lệch khỏi kế hoạch: đưa `input[type=color]` vào điều khiển, vì acceptance A4 yêu cầu bắt `.tpl__color` và `.ov-color__swatch` (đều là color input). Sửa lỗi thật do chủ dự án báo: **dấu tích checkbox lệch** (`apps/ui/src/components/components.css`): nút mặc định có padding 6px làm dấu tích lệch 5px ngang, và icon inline bị đẩy lên; đã đo lại, tâm trùng nhau. Danh sách 11 mục quyết định thẩm mỹ chờ chủ dự án nằm ở [UI_AUDIT.md](UI_AUDIT.md) mục "Danh sách D". **Chưa làm:** B1–B9 (token, alias màu, `--fix` của `css-audit.mjs`) và C; cần quyết định D trước.
- **2026-11-04 (đo giao diện, lượt A1):** Thêm hook test `window.__chefUi` (quyết định D40, `main.tsx`). Kế hoạch đo và chỉnh giao diện ở [UI_AUDIT.md](UI_AUDIT.md).

- **2026-11-04 (Demo v0.8, đóng 4 task):** Thêm `demo-v08.spec.ts` và ba fixture: `demo_v08_photos.py` sinh 20 ảnh tổng hợp (18 trang đơn gồm trang nghiêng, một trang cong, một trang có ngón tay, một trang tương phản thấp, và 2 trang đôi); `demo_v08_check.py` đo lại từ pixel (khổ, độ nghiêng, nền trắng, da ở mép, mực); `demo_v08_core.py` chạy các bước lõi không có giao diện. Chạy đúng Demo: HTTP client đóng vai điện thoại gửi 20 ảnh qua máy chủ chụp, hộp thoại tạo PDF với cắt, tách, nghiêng và làm trắng: 22 trang; trang đơn có khổ A4 đứng, trang tương phản thấp giữ nguyên khổ ảnh (900×1200), các trang thẳng (trừ trang cong) có độ nghiêng ≤ 0,5°, góc trang ≥ 220. Làm phẳng trang cong bằng lõi: lượt 1 sửa 12,4 px, lượt 2 còn sót 4,5 px (không ép bằng 0, thuật toán một lượt chưa khớp hoàn toàn). Xóa ngón tay: đề xuất phủ 0,87% trang, xóa xong không còn màu da ở mép, chữ còn nguyên. **Lỗi thật lộ ra và đã sửa:** (1) thứ tự chụp sách: tách trang đôi chạy trước cắt nên không tìm thấy khe gáy trên ảnh có nền bàn (mọi trang LOW_CONFIDENCE); đổi thành cắt → tách → nghiêng → làm trắng (`captureModel.ts`, có test cập nhật). (2) dò khe gáy: ngưỡng mực `paper - 60` coi bóng gáy sâu là mực, nên cột tối nhất bị loại; sửa thành `min(paper - 60, 0.6 × paper)` (`imaging/pageimg.py`), có test hồi quy `test_split_spread_with_a_deep_binding_shadow_is_still_found` (đỏ với mã cũ, xanh với mã mới). (3) máy chủ chụp 5 yêu cầu/giây: e2e thử lại theo `Retry-After` như điện thoại thật; không đổi máy chủ. **Lỗi lõi lộ ra từ Demo, đã sửa (cùng ngày, lõi Python, 3 test hồi quy xanh):** (a) xóa ngón tay tô màu giấy lên cả phần bàn, gây chỗ trắng lồi ra ngoài trang: phần ngón trong mép giấy (`_sheet_hull`: vùng sáng lớn nhất, bao lồi) nhận màu giấy, phần ngón qua mép nhận màu bàn, không bao giờ màu giấy (`imaging/pageimg.py`, `remove_fingers`); (b) dò viền khi một cạnh nằm trên viền ảnh: độ tin cậy nhân 0,6 nên không còn vượt ngưỡng một cách tự tin (`detect_page_quad`, `_side_on_frame`), trang được đánh dấu cần xem lại; (c) ngón tay trên mép giấy bị coi là mép trang: lõi xóa ngón tay trước khi dò góc, phần bàn của ngón cũng được tô màu bàn để không đánh lừa dò viền (test dò lại mép đúng dưới sai số `PHOTO_TOL`). Commit: `978ad4e` (a), `a2ee865` (b), `e6cd77d` (test c), `d8d6104` (docstring). **Còn mở:** (a) vùng "trong mép" dựa trên độ sáng chứ chưa dùng viền trang đã dò được truyền vào (remove_fingers chưa nhận viền); một bàn trắng sẽ làm hull phủ cả khung (như trước); (b) mới kiểm bằng ảnh tổng hợp, chưa đo trên ảnh sách thật; Demo không đổi: vẫn xóa ngón tay trên trang chưa cắt (`demo-v08.spec.ts`), và comment ở đó còn nhắc lỗi cũ (chưa cập nhật, không ảnh hưởng kiểm tra). **Chưa thử:** điện thoại thật và ảnh sách thật (ảnh là tổng hợp, đúng như quy ước); xóa ngón tay chưa có giao diện (Demo gọi lõi trực tiếp); làm phẳng có giao diện riêng (`dewarp.spec.ts`), Demo gọi lõi; tách trang đôi chưa có tay chỉnh khe. **Đóng 4 task:** T8.04, T8.06, T8.09, T8.11 (T8.09 và T8.11 ghi chú chưa thử trên ảnh sách thật và điện thoại thật). **Giữ 🔄 kèm lý do:** T8.01 (chưa có trình sửa ảnh canvas), T8.02 (chưa có Levels/Curves, khử nhiễu, đổi DPI trên giao diện), T8.03 (chưa có tẩy vùng và xóa vết màu trên giao diện), T8.07 (duyệt nhanh và kính lúp cho hàng loạt), T8.08 (chỉnh tay khe gáy), T8.10 (đề xuất, chỉnh cọ, tô nền trên giao diện). **Kiểm thử Windows:** typecheck, lint, ruff, mypy (lõi) sạch; ruff format lõi sạch; pytest `test_pageimg_core.py` và `test_pageimg_ops.py` 84 đạt; giao diện 755 đạt; desktop 230 đạt (1 bỏ qua); e2e 15 đạt (`demo-v08`, `capture`, `crop-review`, `dewarp`, `smoke`). Chưa chạy lại bộ e2e đủ và pytest lõi đủ hôm nay.

- **2026-11-03 (đóng mốc v0.7):** Thêm `demo-v07.spec.ts` (fixture `demo_v07_corpus.py`, `demo_v07_check.py`): hợp đồng 4 trang tiếng Việt, 'Công ty ABC' 6 lần trên 4 trang, và file khác đi kèm. Chạy đúng Demo với lõi thật: (a) sửa câu 'Thanh toán trong vòng 30 ngày…' thành câu có ư, ớ mà font con không có; chip cảnh báo hiện, văn bản đúng, mọi chữ của câu có glyph trong font nhúng (đọc cmap bằng fontTools), các dòng khác không đổi; (b) tìm thay 6 chỗ trên 4 trang, văn bản mỗi trang bằng văn bản gốc với đúng hai thay đổi; (c) tô sáng câu mới, ghi chú dán, trả lời; lưu, pixel vàng có trong file; lọc theo 'Tô sáng' rồi xuất CSV (chỉ có highlight, không có ghi chú); mở lại thấy đủ; (d) làm phẳng: không còn annotation, chữ và pixel vàng giữ nguyên; file lưu mở được bằng pikepdf và pdfium; file khác và file gốc giữ nguyên SHA-256. **Lỗi do chính spec, không phải lõi:** chọn câu bằng `span` chứa '2026' lấy nhầm tiêu đề 'số 07/2026' đứng trước, vùng chọn ngược và rỗng; sửa thành 'năm 2026'. Không có lỗi lõi hay giao diện nào cần sửa. Kiểm thử Windows: e2e đủ 109/109 đạt (trước khi có spec demo, gồm textedit, annots, smoke), `demo-v07` 1/1 đạt; lõi 137 test (text edit, text model, text find, text paragraph, text registry, annots, links, export text, forms create/flatten) đạt; giao diện 755 đạt; desktop 230 đạt (1 bỏ qua); typecheck, lint, prettier, eslint, ruff (fixture) sạch. Mypy không chạy trên fixture e2e vì cấu hình mypy chỉ phủ `core/`. **Đóng 6 task:** T7.01, T7.02, T7.04, T7.05, T7.06, T7.07. Ghi chú: 'vẽ' của T7.06 (bút vẽ, hình vẽ) có test lõi (`test_annots.py`) và test giao diện nhưng chưa có e2e riêng; đường chính (highlight, note) đã có e2e. Các mục chưa làm: chưa có e2e cho ghi chú kiểu gạch chân/gạch ngang/sóng.

- **2026-11-03 (gỡ nhãn "Sắp có" sót):** Chủ dự án thấy Đóng dấu và Nén ghi "Sắp có". Nguyên nhân: hai ô trên màn hình Start chưa được nối vào hộp thoại (phần sót từ lúc làm khung), và bảng lệnh Ctrl+K còn ba mục giữ chỗ "Sắp có" (Ký số, Sửa chữ, Xuất sang Word) dù tính năng thật đã có. Đã nối hai ô vào hộp thoại Đóng dấu và Nén (hỏi chọn PDF trước nếu chưa mở file, như ô Tách file) và xóa ba mục giữ chỗ. Chưa có e2e cho hai ô này; typecheck, lint, 755 test giao diện đạt.

- **2026-11-03 (T11.06 đóng: menu chuột phải ở thanh bên):** `ThumbnailList` nay chọn nhiều dùng chung vùng chọn với lưới trang (cùng `pageStore`, theo từng tài liệu): click chọn một và nhảy tới trang như cũ, Ctrl/Cmd+click bật/tắt, Shift+click chọn khoảng; chuột phải vào trang ngoài vùng chọn thì chọn riêng trang đó trước (`contextSelect`), rồi mở `pageMenuEntries` như lưới. Thumbnail đã chọn có nền accent (`.thumbs__item.is-selected`). Phím mũi tên giữ hành vi cũ (chỉ nhảy trang). Hàm mới trong `selection.ts`: `mouseModifiers` (lưới cũng dùng) và `contextSelect`, có unit test. Kiểm thử Windows: giao diện 755 đạt (752 + 3); lint, typecheck đạt; e2e với lõi thật `page-menu.spec.ts` 4/4 (test mới: Ctrl+click 2 trang ở thanh bên, chuột phải, tạo PDF đúng M2/M4, file gốc giữ nguyên byte), `tools5-pages` 4/4, `smoke` 10/10, `integration` 6/6, `workflow-task-step` 3/3. Các ghi chú "thanh bên chưa có" của mục 2026-11-03 bên dưới là lịch sử tại thời điểm đó.

- **2026-11-03 (T11.06, menu chuột phải trên trang đã chọn):** Tách menu trang thành `features/pages/pageMenu.tsx` (hàm `pageMenuEntries`, lưới trang dùng). Thêm: **Tạo PDF từ N trang đã chọn** (đứng đầu menu; thay mục "Trích ra" cũ ở lưới, mục này chỉ báo toast; "Trích trang" trong bảng lệnh và Thuộc tính vẫn giữ nguyên); Chọn tất cả, Đảo chọn, Chọn trang lẻ, Chọn trang chẵn (hàm `invertSelection`, `selectByParity` trong `selection.ts`, có unit test); **Đóng dấu các trang đã chọn…** (mở hộp thoại Con dấu với khoảng trang đặt sẵn qua `dialogData`, bị khóa khi file đã ký); **Nén các trang đã chọn…** (trích ra file mới, mở ở tab mới, rồi mở hộp thoại Nén cho tab đó; file gốc không đổi; được làm cả với file đã ký); **Xuất các trang đã chọn thành ảnh…** (hộp thoại PDF→ảnh nhận khoảng trang đặt sẵn; chỉ thêm đọc `dialogData` nên làm được ngay). Nhãn đếm trang: "Tạo PDF từ 3 trang đã chọn". Không đổi lõi: không có op mới, dùng lại `page.extract`. Kiểm thử: giao diện 752 đạt (738 + 14 mới: chọn và menu, gồm mục bị khóa khi file đã ký và khi chọn hết trang); lint, typecheck, ruff đạt; e2e `page-menu.spec.ts` (3 test: tạo PDF từ 2 trang đúng nội dung M2/M4 và file gốc giữ nguyên byte, đóng dấu mở đúng khoảng `1,3`, nén mở tab mới) cùng `tools5-pages` (4) và `smoke` (10) đều đạt với lõi thật trên Windows. Không chạy lại toàn bộ e2e hay pytest lõi. **Hạn chế:** (1) thanh bên thumbnail không có chọn nhiều nên chưa có menu ở đó, dù C13 ghi "thanh bên"; cần làm thêm chọn nhiều trong `ThumbnailList` rồi dùng chung `pageMenuEntries`; (2) mục bị khóa khi ký chỉ có unit test, chưa có e2e với file ký thật; (3) chưa có e2e cho đầu ra của đóng dấu và xuất ảnh, chỉ kiểm hộp thoại mở đúng phạm vi.

- **2026-11-03 (menu chuột phải trang):** Chủ dự án yêu cầu thêm đóng dấu và nén vào lộ trình v1, và menu chuột phải khi chọn nhiều trang kiểu ABBYY, trong đó có "Tạo PDF từ các trang đã chọn". Đóng dấu (F2–F5, T4.05–T4.06) và nén (M1, K10, T5.04, T2.07) vốn đã có trong bản 1.0 và đã xong, nên chỉ thêm lối tắt vào menu cho đúng các trang đã chọn. Thêm C13 (menu) và C14 (tạo PDF từ trang đã chọn), task T11.06; bản 1.0 thành 161 tính năng, tổng 198. Lưới thumbnail đã có menu chuột phải (trích trang, xoay, nhân bản, chèn, xóa) nhưng chưa có đóng dấu, nén, đảo chọn, và trích trang chưa mở file mới.

- **2026-11-03 (đóng mốc v0.6):** Gỡ `test.fixme` của watermark lõi: không tái hiện được lỗi nêu trong chú thích. Detector `content/watermark.py` đã liệt kê watermark do ChefOverlay tạo (tier 4, độ tin cậy 100%), vì form object mang nhãn của chính Do (`content/engine.py`); test lõi `test_watermark_chef.py` đã phủ việc này. Không có lỗi để sửa, nên không đổi detector; chỉ bỏ chú thích sai và bật test. Thêm 2 spec e2e với lõi thật: `demo-v06.spec.ts` (đúng câu Demo: logo chìm trên cả 3 trang được gỡ, tẩy một vùng trang 1, che CCCD trang 2, file lưu không còn dấu ChefOverlay ở trang nào và không còn chữ bị tẩy/che) và `content-v06.spec.ts` (gỡ đối tượng giống nhau trên 3 trang; đảo màu và thay ảnh trong PDF). `redact_check.py` có chế độ `pages`. Đóng 5 task: T6.03 (tẩy vùng), T6.04 (thay và chỉnh ảnh), T6.05 (bảng lớp, xem theo loại), T6.06 (gỡ watermark, gỡ đối tượng giống nhau, gỡ nền), T6.07 (che thông tin mật; mẫu SĐT, email, STK có test lõi). Kết quả Windows: e2e đầy đủ 104 đạt, 1 đỏ: `smoke.spec.ts` 'the core is restarted after a crash' (chờ RPC `mock.crash` bị từ chối); chạy riêng đạt, chạy lại cả file 2/2 đạt, nên ghi là chập chờn, chưa tìm nguyên nhân. Lõi đầy đủ không chạy lại trong phiên này (chạy quá lâu, dừng ở 21%); chạy 132 test liên quan đều đạt, và lõi không đổi từ lần chạy đủ ở 216a873. Chưa có e2e cho đổi màu nền (E5 'đổi nền'), chỉ có test lõi; e2e gỡ nền đã có trong redact.spec.ts.

- **2026-11-03 (đóng task v0.5):** Chạy đủ bộ kiểm tra trên Windows: lõi 1638, giao diện 738, desktop 230, typecheck, lint, ruff, mypy sạch, e2e Electron + lõi thật 100 đạt, 1 bỏ qua. Đóng 10 task: T4.03, T5.01–T5.04, T5.07–T5.11 (đủ test lõi, test giao diện và e2e đường chính). **T5.05 giữ 🔄:** M4 mới có dán ảnh từ clipboard, chưa có chụp màn hình trực tiếp; hộp thoại Ảnh→PDF chưa có e2e qua giao diện (e2e hiện gọi thẳng RPC). Hộp thoại 'Thuộc tính & tiện ích' thiếu `htmlFor` ở nhãn ô (T11.05). Test `test.fixme` còn lại: gỡ watermark của lõi (redact.spec.ts), thuộc v0.6.

- **2026-11-03 (e2e M2, M11, J2 và một lỗi thật):** Thêm `tools5-convert.spec.ts`, 3 e2e với lõi thật: PDF sang ảnh (2 trang thành 2 file PNG 612 x 792 ở 72 dpi), sửa file hỏng từ màn hình Start (file cắt mất bảng xref cho ra bản sạch đọc được không cần phục hồi, file gốc không đổi), gỡ mật khẩu (file lưu xong mở được không cần mật khẩu). **Lỗi tìm ra và đã sửa (T5.05):** xuất PDF sang ảnh đặt tên theo bản làm việc nội bộ (`rev-0000_1.png`) thay vì tên tài liệu, vì hộp thoại đọc revision hiện tại; nay giao diện điền `{name}` bằng tên tài liệu trước khi gọi lõi, có test đơn vị. Ghi chú: mặc định hộp thoại này chỉ xuất trang đang xem, người dùng phải chọn 'Tất cả'. Các e2e chính của v0.5 nay đã đủ; việc còn lại của v0.5 là rà đóng từng task.

- **2026-11-03 (e2e C6, C7, C9):** Thêm `tools5-pages.spec.ts`, 4 e2e với lõi thật: thay trang 2 bằng trang của file khác (nguồn không đổi), cắt lề 10 mm bốn phía (khung hiển thị 555 x 735 pt, chữ còn nguyên), đổi khổ Letter sang A4, chia đôi trang thành lưới 1 x 2 (2 trang thành 4 trang rộng 306 pt). Còn thiếu e2e cho v0.5: PDF sang ảnh trong giao diện (M2), sửa file hỏng (M11), gỡ mật khẩu (J2).

- **2026-11-03 (e2e M7–M10):** Thêm `tools5-docs.spec.ts`, 4 e2e với lõi thật cho hộp thoại 'Thuộc tính & tiện ích': sửa tiêu đề rồi lưu (M9), đính kèm xem/lưu ra/thêm/xóa (M8), trích ảnh và trích chữ (M7), tối ưu cho web cho ra file linearized (M10). Phát hiện nhỏ chưa sửa (thuộc T11.05): nhãn các ô trong hộp thoại này không gắn với ô nhập (thiếu `htmlFor`), nên trình đọc màn hình không đọc được tên ô. Còn thiếu e2e cho v0.5: PDF→ảnh trong giao diện (M2), sửa file hỏng (M11), thay trang (C6), cắt lề/đổi khổ (C7), chia đôi trang (C9), gỡ mật khẩu (J2).

- **2026-11-03 (e2e Demo v0.5):** Thêm 3 e2e với lõi thật còn thiếu so với Demo v0.5: kiểm tra trước khi gửi (T5.03: cảnh báo trang trắng, bấm Sửa, kiểm tra lại sạch), nén theo dung lượng (T5.04: file quét 3 trang trên 2 MB lưu xuống ≤ 2 MB, vẫn mở được) và tách thông minh theo trang trắng (T5.09: 5 trang thành 2 file 3 + 2 trang, file nguồn không đổi). Hộp thoại chọn thư mục của hệ điều hành được thay bằng stub trong test. Cả 9 test của `tools5.spec.ts` đạt trên Windows. Chưa đóng task nào: còn phải rà từng task v0.5 theo định nghĩa 'xong' (PLAN_V1 mục 2).

- **2026-11-03 (chấp nhận kết quả ký):** Chủ dự án xem kết quả ký bằng token Viettel và chấp nhận, đã trả token. Đóng T1.08, T3.01, T3.02, T3.03; T3.14 chuyển 🔄 (chưa có ảnh Adobe/Foxit). Chuyển sang đóng mốc v0.5. Lần dùng token kế tiếp chỉ cần khi giao diện ký và ký hàng loạt đã sẵn sàng, gom vào một lần.

- **2026-11-03 (ưu tiên Windows):** Chủ dự án chốt làm bản Windows trước, macOS và Linux để sau (D37). Viết lại "Trạng thái hiện tại" và PLAN_V1.md theo hướng này; CI đặt E2E Linux/macOS ở chế độ không chặn; T11.01 chỉ còn kiểm thử trên Windows; hướng dẫn cài đặt ghi rõ bản 1.0 là Windows. Các lỗi nền tảng đã tìm ra khi chạy CI (Python 3.15 trên macOS, đường dẫn Windows trong cài đặt trên Linux, mở file hai lần bằng Ctrl+O, lỗi sửa file hỏng) đã được sửa vì chúng đều là lỗi thật hoặc test sai; phần còn lại của Linux/macOS chuyển sang "Sau 1.0".

- **2026-11-03 (ký thử bằng token thật):** Chủ dự án nhập PIN và chạy `scripts/token_sign_check.py`: ký PAdES B-B bằng token Viettel V6 qua lõi của app thành công, kiểm tra lại cho chữ ký toàn vẹn. Hai lỗi của bộ kiểm tra được tìm ra và sửa: (1) chứng thư Viettel dùng RSA 1024 bit nên chính sách mặc định của pyHanko (≥ 2048) làm chuỗi "chưa tin cậy"; nay chấp nhận từ 1024 bit và thêm cảnh báo `WEAK_KEY`; (2) CRL của Root CA Việt Nam ở dạng PEM nên bị bỏ qua, trạng thái thu hồi của chứng thư trung gian luôn "chưa biết"; nay đọc cả PEM và DER (pyHanko vẫn nhận DER). Có test hồi quy cho cả hai. **Chưa làm:** mở file bằng Adobe Reader/Foxit (T3.14), đưa Root CA vào kho đi kèm sau khi đối chiếu dấu vân tay.

- **2026-11-03 (token Viettel thật, bước 1.1):** Cắm token Viettel-CA V6 (HYP2003) trên Windows 11 và chạy thử không cần PIN. Script spike và lõi của app (`sign.driverScan`, `sign.listTokens`, `sign.diagnoseToken`) đều nhận đúng driver `viettel-ca_v6.dll` (64-bit), liệt kê 2 chứng thư ký (một đã hết hạn 2026-09-12, một đến 2027-09-15), cờ PIN bình thường, chẩn đoán đạt 7/7 bước (bước ký thử bỏ qua vì chưa có PIN). Chi tiết ở TOKENS.md. **Chưa ký thử:** cần chủ dự án nhập PIN bằng `scripts/token_sign_check.py` (ký bằng chính lõi của app rồi kiểm tra). Phát hiện: thư mục Root CA đi kèm vẫn trống nên chữ ký Viettel sẽ báo chưa tin cậy; chuỗi là người ký ← Viettel-CA SHA2 ← Vietnam National Root CA, cần chủ dự án đối chiếu dấu vân tay với trang chính thức rồi mới đặt vào `core/chef_core/resources/certs` (I35).

- **2026-11-03 (CH1, CH2):** Chủ dự án trả lời: máy chính Windows, token Viettel-CA (D35); chưa cần tự cập nhật (D36). A10 chuyển sang "Sau 1.0", bản 1.0 còn 159 tính năng, T9.08 tạm dừng, CH2 đóng. Kế hoạch đến 1.0 ở `docs/PLAN_V1.md`.

- **2026-11-03 (rà chất lượng trước commit):** Chủ dự án chọn hai thay đổi sau khi rà. (1) T6.07: nền hình chữ nhật đơn giản (một `re`, không xoay) chứa trọn vùng che chỉ còn cảnh báo thay vì làm hỏng cả lệnh che, vì hình này không mang thông tin của vùng che; mọi vector khác (đường cong, đa giác, hình chữ nhật mà vùng che chỉ cắt một phần) vẫn bị từ chối. Trước đó trang có nền tô kín cả trang không che được. (2) T10.05: `export.document` và `export.refresh` có cờ `replaceExisting` (mặc định tắt), chỉ giao diện bật sau khi hộp thoại lưu của hệ điều hành đã hỏi ghi đè; chỉ đúng `outputPath` đó được thay, bản nguồn và revision hiện tại không bao giờ được thay, quy trình tự động vẫn chọn tên không trùng. Hạn chế còn lại: xuất Markdown/HTML có ảnh vào tên đã có thư mục ảnh đi kèm vẫn bị từ chối (không xóa thư mục của người dùng). `pageimg.crop` giờ từ chối tứ giác bị chéo giống bản xem trước; lỗi mô hình DocAligner chuyển sang bộ dò cổ điển và ghi log.

- **2026-11-03 (che ảnh dùng chung):** T6.07 từ chối che một phần ảnh nếu ảnh gốc còn được tham chiếu ở vị trí hoặc cấu trúc khác, kể cả resource trong appearance của annotation: nếu không, ảnh gốc vẫn có thể trích xuất. Tẩy thông thường giữ hành vi cũ. Cách kiểm tra bảo thủ có thể từ chối cả tham chiếu không hiển thị và có chi phí duyệt đối tượng PDF; đã có test hồi quy cho các trường hợp dùng chung và alias.

- **2026-11-03 (khôi phục khi lõi dừng):** T5.10 khôi phục các session đang mở từ bản revision sau khi sidecar khởi động lại, thay vì mở lại file nguồn và bỏ qua thay đổi chưa lưu. Thông báo chịu được trạng thái `starting` giữa `restarting` và `ready`; session lỗi được giữ lại để thử lại. E2E dùng lõi thật dừng đột ngột sau khi nhân đôi trang, khôi phục và lưu lại hai trang; nguồn vẫn nguyên trước khi lưu. T5.09 từ chối CropBox/MediaBox kích thước không quá 1 pt và giữ nguyên revision khi lỗi. Hai task vẫn đang thực hiện.

- **2026-11-03 (T9.03):** Hộp thoại dò viền và cắt hàng loạt có thể lưu `pageimg.autoCrop` làm bước quy trình; bước giữ ngưỡng tin cậy, khổ giấy và trang đã chọn (mặc định mọi trang). Đã build UI và kiểm thử Electron với lõi thật từ lưu bước, kiểm tra workflow đến chạy trên PDF ảnh; T9.03 vẫn đang làm vì còn các hộp thoại khác chưa nối.

- **2026-11-03 (an toàn che và form):** T6.07 dừng và giữ nguyên phiên nếu vùng che chỉ được giấu bằng clipping vector hoặc có đối tượng không xử lý được. Widget bị che được gỡ khỏi AcroForm, xóa giá trị mặc định và hình thức liên quan; nếu có widget cùng trường trên trang khác, giá trị và hình thức dùng chung cũng bị xóa và có cảnh báo. Việc giữ annotation chồng vùng che bị từ chối; verifier kiểm tra thêm các chuỗi PDF còn tham chiếu. T9.01 khôi phục `/DV` khi đặt lại dropdown, checkbox, radio và danh sách chọn nhiều. Các trường hợp này có kiểm thử hồi quy; hai task vẫn đang thực hiện.

- **2026-11-03 (tiếp tục rà và workflow):** T10.03 thêm xem trước mô hình cạnh trang gốc, cập nhật theo nội dung và loại vùng được sửa; bảng và ảnh vẫn chỉ hiển thị nhãn đại diện, định dạng cuối phụ thuộc chế độ xuất. T9.03 cho lưu bước gỡ/đổi nền từ dialog vào workflow. Hai luồng đã được thử bằng Electron và lõi thật; các task vẫn đang thực hiện.

- **2026-11-03 (ghép hồ sơ):** T9.07 bổ sung chế độ ghép các PDF đầu vào theo thứ tự trước khi chạy workflow một lần; nguồn được giữ nguyên, PDF tạm được dọn sau khi chạy hoặc hủy. Có mật khẩu riêng cho từng file, cảnh báo chữ ký và trường form không được giữ lại, chặn chế độ ghi đè và nói rõ giới hạn của chạy thử. Tên đầu ra mặc định lấy từ file đầu tiên. Kiểm thử lõi gồm PDF mã hóa, hủy và quy trình ký PFX; E2E Electron kiểm tra đổi thứ tự, nội dung và giữ nguyên nguồn. Task còn cần kiểm thử và hoàn thiện tổng thể.

- **2026-11-03 (xoay tinh và xuất Word):** T8.06 bổ sung xoay tinh từng bước 0,1° trong hộp cắt; xem trước và áp dụng dùng cùng góc, giữ kích thước ảnh và có thể cắt nội dung ở góc. Đã kiểm thử lõi và Electron với góc hợp lệ/không hợp lệ. T10.05: ảnh hỏng khi xuất DOCX được thay bằng chỉ báo không trích được, tránh làm mất văn bản và bảng còn lại; chưa thể khôi phục nội dung ảnh hỏng. Các task vẫn đang thực hiện, chưa coi là hoàn tất.

- **2026-11-03 (giới hạn hồ sơ):** T9.07 có operation `compress.toSize` áp nén đạt mục tiêu hoặc dừng trước khi ký; mẫu nộp hồ sơ nhắm 4.000.000 byte trước ký và kiểm tra tối đa 5.000.000 byte sau ký. Nếu vượt sau ký, workflow báo lỗi và giữ đường dẫn file đã tạo; chưa ghép nhiều file. Trần được giữ khi UI ghi đè quy tắc đầu ra. Đã kiểm thử lõi ký và trường hợp vượt trần; E2E riêng qua hộp thoại file native chưa đạt.

- **2026-11-03 (bám viền):** T8.06 bổ sung bám khung chữ nhật vào biên của vùng đã dò khi kéo trong phạm vi 8 pixel màn hình; phím mũi tên vẫn chỉnh không bám để có thể tinh chỉnh. E2E Electron + lõi thật kiểm tra kéo cạnh sát viền dò. T9.01 giữ XFA khi chỉ làm phẳng một phần form, cảnh báo khi dữ liệu XFA vẫn còn và giữ nguyên file chỉ có XFA khi không có widget để làm phẳng; có kiểm thử hồi quy.

- **2026-11-03 (an toàn rà bố cục):** Không cho đổi vùng bảng/hình sang `unknown` vì định dạng trung gian hiện chưa giữ payload của các vùng đó, sẽ khiến xuất thiếu nội dung; đã bổ sung test từ chối. T10.03 vẫn cần thiết kế và hỗ trợ sửa vùng phi văn bản không làm mất dữ liệu.

- **2026-11-03 (cắt & form):** T8.06 thêm chế độ khung chữ nhật với bốn tay nắm góc, bốn tay nắm cạnh và khóa tỉ lệ preset khi kéo hoặc dùng phím; vẫn có chế độ kéo bốn góc độc lập. E2E Electron + lõi thật kiểm tra tám tay nắm, điều chỉnh cạnh và tỉ lệ A4; bám viền tự động vẫn chưa làm. T9.01: làm phẳng form tạo appearance còn thiếu nếu hỗ trợ, giữ nguyên trường không thể làm phẳng và báo cảnh báo; không thay appearance tùy chỉnh của widget khác, giữ /NeedAppearances khi cần và giới hạn thao tác theo trang chọn. Có kiểm thử hồi quy, task vẫn đang làm.

- **2026-11-03 (rà bố cục):** T10.03 thêm sửa nội dung khối chữ đã nhận dạng; model đã duyệt được dùng khi xuất. E2E lõi thật kiểm tra sửa chữ, đổi loại khối và xuất Markdown. Các vùng bảng/hình và kiểm thử tài liệu thực vẫn cần hoàn thiện.

- **2026-11-03 (quy trình mẫu):** T9.07 sửa mẫu nộp hồ sơ dùng raster hóa xám 200 dpi và nén thật trước ký; engine vẫn chưa ghép nhiều PDF hay bảo đảm trần 5 MB. Mẫu chụp sách bổ sung tách và làm phẳng trang, không tự xóa ngón tay: phải duyệt/chỉnh mask riêng. Trang confidence thấp trong auto-crop/tách/làm phẳng được đưa vào cảnh báo workflow và toast trên Start; có test lõi và E2E với ảnh confidence thấp.

- **2026-11-03 (tiếp tục v1):** T9.07 hiển thị quy trình mẫu trên Start; thả PDF lên quy trình đủ điều kiện sẽ chạy, còn bước cần bí mật, mật khẩu, cảnh báo hoặc ghi đè sẽ mở hộp cấu hình với file đã chọn. E2E lõi thật tạo DOCX từ file thả, và xác minh quy trình ký yêu cầu cấu hình thay vì tự ký. T9.03 nối thêm số trang, watermark và header/footer vào trình tạo workflow, có e2e chạy thực tế. T8.06 thêm tỉ lệ khung ban đầu và kích thước đầu ra mm, kiểm tra giới hạn ảnh ở UI và lõi, preview thu nhỏ trước khi nắn; chưa có 8 tay nắm và bám viền. T10.05 giữ tọa độ từng mục danh sách để giảm chồng khung Word; tài liệu cũ thiếu tọa độ vẫn dùng ước lượng và chưa thử bằng Word/LibreOffice.

- **2026-11-03 (tiếp):** T5.11 có chế độ đảo màu trang và khung xem thứ hai độc lập, chọn cùng file hoặc file khác đang mở; e2e Electron + lõi thật kiểm tra chuyển trang độc lập và file nguồn không đổi. T8.06 có kính lúp theo góc đang kéo hoặc chỉnh bằng bàn phím và xem trước nắn phối cảnh không tạo revision; khung chữ nhật, tỉ lệ và mm vẫn cần làm. T9.03: tab Quy trình đã có nút mở trình tạo và thư mục tự động; lưu bước đã nối cho chuyển màu, scan và nén; e2e xác thực và chạy workflow với lõi thật, các task dialog khác chưa nối. Máy chủ chụp được bổ sung bảo vệ yêu cầu đồng thời và kiểm thử hồi quy. Script kiểm tra độ phủ chạy được và báo 160/160 tính năng có task (không có nghĩa các task đã hoàn thành).

- **2026-11-03 (khôi phục):** T5.10 thử lại quét phiên khôi phục khi lõi báo sẵn sàng sau lỗi khởi động; khi sự kiện đến trong lúc lượt quét còn chạy, chỉ thử thêm một lần nếu lượt đó thất bại. Có test cho các tình huống cạnh tranh; task còn cần kiểm thử crash thật.

- **2026-11-03 (hướng dẫn):** Bắt đầu T11.04 tại [HUONG_DAN_SU_DUNG.md](HUONG_DAN_SU_DUNG.md), gồm cài đặt và giới hạn hiện biết. Cần tiếp tục bổ sung theo các chức năng hoàn thiện và đối chiếu trên thiết bị thực tế.

- **2026-11-03:** Rà soát phần thay đổi chưa commit và tiếp tục T8.11/T9.02: sửa luồng chụp sách để lưu các bước xử lý ảnh vào PDF đầu ra trước khi báo hoàn tất; kiểm thử Electron + lõi thật đọc lại pixel của PDF sau bước làm trắng. Sửa chạy thử workflow không có bước xuất để báo đúng đường dẫn ghi đè, không tạo thư mục đầu ra khi chạy thử; có kiểm thử hồi quy. Windows: lõi 1580 test đạt, 3 bỏ qua; desktop 221 đạt, 1 bỏ qua; UI 711 đạt; typecheck và e2e chụp đạt. Script kiểm tra độ phủ được TASKS nhắc tới chưa tồn tại. Chụp trên điện thoại thật và phần còn lại của các task vẫn cần kiểm thử/hoàn thiện.

- **2026-11-01 (24):** T8.07 có màn hình dò và cắt hàng loạt: hiển thị confidence và khổ giấy ước đoán, chỉ chọn tự động trang đạt ngưỡng, mở trang cần sửa sang màn hình cắt tay. E2E với hai trang ảnh kiểm tra trang confidence thấp giữ nguyên. Các mục kính lúp/tỉ lệ/mm và quy trình duyệt ảnh số lượng lớn vẫn cần hoàn thiện. T9.06 đã bổ sung thẻ `{firstline}` lấy dòng chữ đầu trang 1; trang không có lớp chữ dùng tên file cũ, có test tiếng Việt và workflow.

- **2026-11-01 (23):** T8.06 có màn hình cắt một trang: dò viền trên ảnh nhúng, xem ảnh thật và kéo bốn góc hoặc dùng phím mũi tên, kiểm tra tứ giác lồi, cảnh báo việc dựng lại trang trước khi áp dụng. Operation `pageimg.quadPreview` không thay revision; e2e đã chỉnh góc, cắt và lưu PDF. T8.06/T8.07 còn đang làm: chưa có duyệt/cắt hàng loạt và kính lúp/tỉ lệ/mm.

- **2026-11-01 (22):** Thêm giao diện đổi tên hàng loạt: chọn file, xem trước tên, áp dụng đúng ánh xạ đã duyệt và hoàn tác các file đổi thành công; file đang mở trong app được loại khỏi lựa chọn. E2E với lõi thật đã đổi tên và hoàn tác hai file, kiểm tra nội dung còn nguyên. T9.06 vẫn đang làm vì phần quy tắc đầu ra trong giao diện quy trình đang được nối.

- **2026-11-01 (21):** T8.05 tích hợp DocAligner LCNet100 offline; trọng số chính thức Apache-2.0 kèm nguồn/hash và giấy phép runtime, kiểm tra hash khi nạp. Đã build lõi PyInstaller trên Windows và chạy inference thực qua RPC trong bản đóng gói; model được chọn trên một ảnh mẫu chính thức, ảnh confidence thấp được giữ nguyên và có fallback khi thiếu model. Chưa kiểm thử bộ ảnh thực đa dạng hoặc build macOS/Linux; để tiếp tục ở T11.01/T11.03. Giao diện rà bố cục có thêm nút đánh dấu vị trí khối trên trang, chọn cấp tiêu đề; e2e xuất Markdown từ mô hình đã duyệt đạt.

- **2026-11-01 (20):** T10.03 có màn hình so sánh trang PDF với các khối nhận diện, đổi loại khối chữ, lưu mô hình đã duyệt qua `layout.review` và đưa mô hình đó sang màn hình xuất. E2E Electron + lõi thật xác minh đổi tiêu đề thành đoạn và Markdown xuất ra phản ánh thay đổi; mô hình ngoài phiên bị từ chối. Vẫn cần hoàn thiện thao tác cho các vùng không phải chữ và kiểm thử tài liệu thực tế nên task còn đang làm.

- **2026-11-01 (19):** Bổ sung giao diện xuất tài liệu một file và hàng loạt; đã thử Electron + lõi thật với Markdown, một file hợp lệ và một file lỗi. T10.08 có thao tác chèn mục lục có liên kết và giao diện xem tiêu đề trước khi chèn; e2e lưu PDF, đọc lại trang và liên kết đạt. T8.09 đã có thuật toán thử nghiệm cho cong nhẹ theo chiều ngang, operation xem trước/áp dụng và giao diện; e2e trên ảnh cong tổng hợp đạt, trang ít bằng chứng được giữ nguyên. Chưa kiểm thử đủ ảnh sách thực tế nên T8.09 vẫn đang làm. Tích hợp ONNX và workflow export đang được hoàn thiện; chưa đánh dấu các mục này xong. Các thay đổi vẫn chưa commit.

- **2026-11-01 (18):** Tiếp tục T8.05: [kho DocAligner chính thức](https://github.com/DocsaidLab/DocAligner) ghi giấy phép mã Apache-2.0; [trang mô hình chính thức](https://docsaid.org/fr/models/docaligner) nói trọng số chính thức được dùng miễn phí, kể cả thương mại, còn dữ liệu huấn luyện theo điều kiện của nhà cung cấp. Cần lưu LICENSE, nguồn và SHA-256 của **đúng file trọng số được chọn**, kiểm tra điều khoản đi kèm file trước khi đóng gói; hiện chưa tải hay tích hợp mô hình. Trang quickstart nói thư viện tự tải mô hình từ máy chủ nếu thiếu, nên không được dựa vào cơ chế đó cho app offline.

- **2026-11-01 (17):** Hoàn thành kiểm thử T7.03 trên Windows: sửa nội dung đoạn tiếng Việt và đổi cỡ chữ qua Electron + lõi thật, đọc lại văn bản và cỡ chữ trong PDF đã lưu. Sửa lỗi hộp thoại sửa đoạn bị kẹt khi thao tác thất bại; thêm hai test tái hiện. Các thay đổi giao diện/chụp vẫn chưa commit; trang chụp chưa thử bằng điện thoại thật.

- **2026-11-01 (16):** Tiếp tục phần giao diện chưa commit sau khi phiên Claude bị ngắt. Đã sửa lỗi nhấn nút lưu ghi chú bị lớp vẽ nhận nhầm, và lỗi kiểm tra font khi sửa dòng dùng số thứ tự cũ. Trên Windows: build, typecheck và lint đạt; desktop 221 test đạt, 1 bỏ qua; UI 681 test đạt; 6 e2e đạt (liên kết, ghi chú/highlight và làm phẳng, chụp ảnh, sửa dòng và tìm/thay). Chế độ sửa đoạn đã có code và unit test nhưng **chưa có e2e**; trang chụp chưa thử bằng điện thoại thật. Các thay đổi giao diện/chụp vẫn chưa commit; T8.05, T8.09 và các công việc khác trong TASKS vẫn chưa hoàn tất.

- **2026-11-01 (15):** Build tiếp từ v0.2 với các sub-agent haiku, mỗi task qua vòng test trước, code sau, chạy lại toàn bộ test, rồi commit riêng. **v0.2 xong phần code** (T2.01–T2.08): `scan.rasterize` (xám/màu/đen trắng, JPEG nhúng thẳng, CCITT G4), hiệu ứng scan có seed, xem trước, ước tính, preset, `scan.fitSize` (nén còn ≤ X MB), dialog UI, test ảnh chuẩn. Đo thật trên máy chủ dự án: 500 trang 600 dpi xám mất 43,6 giây, RAM đỉnh 1,3 GB. **v0.3 phần code gần xong**: PFX, thông tin chứng thư (MST/CCCD), engine PAdES B-B…B-LTA, ký chứng nhận, nhiều người ký, ô ký trống, giao diện chữ ký tự vẽ bằng reportlab (chữ Việt thật), kiểm tra chữ ký (kho tin cậy, OCSP/CRL), ký hàng loạt, thư viện ảnh chữ ký mã hóa AES-GCM, đặt chữ ký theo chữ mốc, lớp PKCS#11 + danh bạ driver + chẩn đoán token. **v0.4 phần lõi xong**: engine lớp phủ có gắn nhãn và sổ đăng ký để gỡ lại (F12), thêm chữ/ảnh, watermark, giấy tiêu đề, header/footer, đánh số trang (preset NĐ 30), Bates, QR/mã vạch, sửa mục lục, con dấu, giáp lai, chữ ký nháy, ký kèm đóng dấu một lần, báo cáo kiểm tra hàng loạt CSV/Excel. **Chưa làm được, cần chủ dự án:** token USB thật (T1.08, T3.01, T3.14), kiểm tra chéo Adobe Reader/Foxit (T3.14), bản cài Windows/macOS do CI build, thả file Root CA Việt Nam vào `core/chef_core/resources/certs/` (hiện chưa có chứng thư gốc nào, chữ ký Việt Nam sẽ hiện 'chưa tin cậy' cho tới khi thêm), chọn font viết tay OFL cho chữ ký gõ. **Kết quả test ở commit xanh gần nhất:** lõi 797, desktop 121, UI 192, e2e 23. **Quyết định/ghi chú mới:** (1) revision lưu với `deterministic_id` để cùng đầu vào ra cùng byte; (2) ghi đè file đầu vào khi ghép trên Windows phải đóng nguồn trước khi đổi tên; (3) `scan.preview`/`scan.fitSize` là session op; (4) trần 50 triệu pixel mỗi trang khi raster hóa (A4 tối đa khoảng 720 dpi); (5) mọi op ghi nội dung đều `destructive`, nên bị chặn trên file đã ký; (6) token chỉ thử bằng backend giả, chưa thử phần cứng. **Rủi ro đã thấy:** `session.save` có thể làm hỏng chữ ký khi file mở bằng mật khẩu và đã có chữ ký (cần kiểm tra ở v0.5); thăm dò driver token nạp trong cùng tiến trình nên một driver treo có thể treo lõi; đường OCSP mới chỉ thử với máy chủ cục bộ. **Đang dở khi dừng (chưa commit, đã chạy tới giới hạn 5 giờ của tài khoản):** v0.5 lõi (bảo mật/mã hóa, soi file, kiểm tra trước khi gửi, khôi phục phiên, nén PDF) và giao diện luồng ký v0.3 (dialog ký, đặt ô ký, ký hàng loạt).
- **2026-10-31 (14):** **Hoàn thành code v0.1.** Ghép nhánh UI; bổ sung cầu nối `files.pathForFile` (kéo thả file) và `openDialog({directory})`; sửa lỗi thumbnail cũ hiện sai vị trí ngay sau khi xóa/chèn trang; thêm test tích hợp **lõi thật + UI thật** (`tests/e2e/specs/integration.spec.ts`). Kết quả: lõi 101 test, desktop 72, UI 71, e2e 14 (gồm 4 test lõi thật), lint/typecheck/mypy/ruff sạch. Đóng gói Linux với lõi PyInstaller thật: AppImage 156MB, deb 127MB, rpm 113MB; bản đóng gói hiện trang đầu sau ~0,8s. **Tốc độ:** v0.1 (42 điểm) xong trong một phiên làm việc với 4 agent song song. Bộ cài Windows/macOS sẽ do CI build.
- **2026-10-31 (13):** Ghép spike. **S1** (SoftHSM2): ký ẩn, ký hiển thị tiếng Việt + ảnh trong suốt, B-T/B-LT/B-LTA, 2 người ký, certify đều hợp lệ; đọc lại được MST/CCCD; 10 file một lần PIN mất 0,3s. Mọi TSA công khai bị proxy chặn nên thử bằng TSA cục bộ. **S2**: stack giấy phép thoáng đủ sức, giữ D7 (D33). Thêm D34. Ước lượng: v0.3 31,5; v0.6 21,5.
- **2026-10-31 (12):** Ghép nhánh desktop: T1.02, T1.06, T1.21 xong; phần main/CI của T1.07, T1.15 xong (72 unit test, 10 e2e). Hạ TypeScript từ 7.0 xuống **6.0.3** vì typescript-eslint chưa hỗ trợ TS 7. UI chạy dưới scheme `chef-app://ui/`. CI thêm bước kiểm tra codegen. Bộ cài Linux (chưa có UI, lõi giả): AppImage ~132MB; khởi động nguội ~0,5s.
- **2026-10-31 (11):** Bắt đầu code v0.1 với 4 sub agent song song (core, desktop, UI, spike). T1.01 xong (khung monorepo + `docs/CONTRACTS.md`). Ghép nhánh core: T1.03–T1.05, T1.23 xong; phần lõi của T1.20, T1.25, T1.07 xong (101 test). Bổ sung hợp đồng: `OpResult.state` có thể null (op standalone), `session.save` trả thêm `warnings`, bảng mã lỗi chi tiết. **Quyết định mặc định:** file đã có chữ ký thì chặn các thao tác ghi lại tài liệu (`BLOCKED_BY_SIGNATURE`), cho phép trích/tách/ghép.
- **2026-10-31 (10):** Chủ dự án: app **tự dùng** (D28). Chuyển sang lập kế hoạch. Claude viết `docs/BLUEPRINT.md` (bối cảnh, kiến trúc, mô hình operation, phiên tài liệu, IPC, giao diện, dữ liệu & bảo mật, cấu trúc repo, công nghệ, kiểm thử, build, quy trình làm việc, mốc, ước lượng, rủi ro) và `docs/TASKS.md` (118 task, 262 điểm, đủ 160 tính năng). Chia lại mốc thành 11 mốc (D29). Thêm D30–D32. Câu hỏi mới: CH1, CH2.
- **2026-10-31 (9):** Chủ dự án đồng ý: (1) mô hình dò viền nhẹ vào bản 1.0, thành **L20**, mã Q13 bỏ (D26); (2) **L6** tách trang đôi lên v0.7, thêm quy trình mẫu "Chụp sách" (D27). Thêm ONNX Runtime vào kiến trúc. Bản 1.0 hiện có 160 tính năng, tổng 196.
- **2026-10-31 (8):** Thêm sau khi chốt: tự dò viền trang & tự cắt, cắt thủ công, cắt hàng loạt, tự nhận khổ giấy → L15–L19 (v0.7); dò viền bằng mô hình → Q13. Thêm D25. Tổng 196 tính năng. Hỏi chủ dự án: đưa L6 vào 1.0? Cho mô hình dò viền nhẹ làm ngoại lệ ở 1.0?
- **2026-10-31 (7):** Thêm sau khi chốt: trình sửa ảnh trang kiểu ABBYY OCR Editor và xóa ngón tay kiểu vFlat Scan → L9–L14 (v0.7), Q11–Q12 (nâng cấp). Thêm OpenCV vào thư viện lõi (D6), thêm D24. Tổng còn 190 tính năng.
- **2026-10-31 (6):** Chủ dự án xác nhận: mô hình AI chạy trên máy hoặc API nhận dạng trả phí để dành cho phiên bản nâng cấp sau; chưa cần chạy thử file mẫu. Yêu cầu tổng hợp thành cây tính năng chuẩn và chốt. Claude viết lại FEATURES.md thành **bản 1.0 đã chốt**: 7 khu vực, 17 nhóm A–Q, **đánh lại toàn bộ mã** cho liền mạch, xếp mọi mục 🤔 vào một trong 4 mức, tách phần OCR/AI thành nhóm Q (gói nâng cấp). Tổng 182 tính năng. Viết lại NOTES.md (D2, D20, D22 cập nhật; thêm D23). Bước tiếp theo: lập kế hoạch và ước lượng.
- **2026-10-31 (5):** Chủ dự án hỏi về tính năng rã PDF thành Markdown rồi tái tạo ra định dạng khác. Claude đánh giá theo mức khó và đề xuất dùng mô hình tài liệu JSON làm định dạng trung gian.
- **2026-10-31 (4):** Bỏ trợ lý AI. Chủ dự án cần hỗ trợ token Viettel, VNPT, FPT, Cơ yếu, MISA… Claude tra cứu và ghi vào `docs/TOKENS.md`. Thêm danh bạ driver, quét driver, chẩn đoán token, cảnh báo PIN. Chủ dự án muốn liệt kê tính năng trước, lập kế hoạch sau.
- **2026-10-31 (3):** Chủ dự án yêu cầu tùy chỉnh chữ ký số kiểu Foxit. Claude mở rộng nhóm ký số thành 5 phần; đối chiếu với PDF24, Stirling-PDF, Acrobat, Smallpdf, iLovePDF để bổ sung tính năng. (Không mở được trang danh sách đầy đủ của PDF24 và tài liệu Stirling-PDF vì mạng phiên bị chặn, nên tổng hợp từ kết quả tìm kiếm.)
- **2026-10-31 (2):** Chủ dự án bổ sung: sửa chữ PDF, bóc tách lớp để gỡ watermark, watermark/con dấu ảnh, số trang, header/footer. Claude đối chiếu với ABBYY và thêm nhiều tính năng.
- **2026-10-31 (1):** Bắt đầu dự án. Chốt tên Chef PDF, Electron, Python sidecar, bỏ OCR ở bản đầu, ưu tiên "Chuyển thành bản scan" và "Ký số".
