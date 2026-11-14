# Chef PDF: Blueprint vỏ Rust + GPUI

> Viết 2026-11-08 theo **D71** (đổi vỏ Electron sang Rust + GPUI, thay D3). Số mục giữ như [BLUEPRINT.md](BLUEPRINT.md) để so sánh song song. **BLUEPRINT.md vẫn mô tả bản Electron đang chạy** và chỉ được thay khi bản Rust đạt parity và chủ dự án chốt dùng hằng ngày. Trạng thái và thứ tự làm nằm ở [PLAN_RUST.md](PLAN_RUST.md).
>
> Ký hiệu: **Đã biết** = có trong tài liệu hoặc mã của dự án. **Kiểm ở M1** = chưa xác minh, phải kiểm trên commit GPUI đã ghim trước khi phụ thuộc vào nó.

## 1. Bối cảnh & giả định

**Mục tiêu:**
1. **RAM thấp nhất có thể.** Không có ngân sách số cứng. Mỗi mốc báo cáo tổng working set, **gồm cả lõi Python**, so với số Electron đã có.
2. **Giữ nguyên hình họa giao diện** (màu, chữ, khoảng cách, bo góc, bóng, trạng thái, bố cục) theo `tokens.css` và bộ ui-audit.
3. **Giữ nguyên lõi xử lý:** Operation, JSON-RPC và toàn bộ 1690 test pytest. Lõi có pyHanko, PKCS#11 và token Viettel-CA.
4. Windows trước (D37). Chỉ desktop.

**Số đối chiếu (NOTES, 2026-11-07, file 1000 trang chữ):**
- Electron ở 350 màn hình: **1351 MB** (đã vá pdf.js, chưa tính lõi).
- Lõi lúc mở file: **157 MB** (đã đo; khi rảnh 139 MB). Chưa đo lõi ở trạng thái cuộn.
- Tổng phải đo lại bằng `perf-memory`, vốn đã in `coreMB` cạnh `electronMB`.

**Cách hiểu các câu trả lời của chủ dự án (có thể đổi):**
- "Tối ưu nhất có thể" → không có ngân sách. Thiết kế để RAM thấp nhất đạt được, và báo cáo đối chiếu ở mỗi mốc.
- "Không cần spike, bỏ luôn" → không có cổng dừng riêng. Rủi ro lớn nhất được đưa vào **M1** (IME, off-screen, viewer, bộ đo RAM), theo nguyên tắc làm việc rủi ro cao trước của [PLAN_V1.md](PLAN_V1.md).
- "Blueprint" → chỉ viết kế hoạch. Không viết code Rust, không commit.

**Không thuộc phạm vi:** mobile; macOS và Linux (sau 1.0); ký mã; phát hành công khai (CLAUDE.md).

**Ràng buộc giữ nguyên từ CLAUDE.md:** mọi thay đổi tài liệu là một Operation trong lõi; UI Rust không sửa PDF; không dùng AGPL (MuPDF, PyMuPDF, Ghostscript, iText); bản 1.0 không OCR, không AI (trừ L20).

## 2. Kiến trúc tổng thể

```
┌──────────────────────── Chef PDF native (một tiến trình Rust, GPUI) ─────────────────────────┐
│                                                                                              │
│  UI thread (GPUI): cửa sổ, tab, thanh công cụ, hộp thoại, thumbnail, overlay, phím tắt       │
│        │                      │                                  │                           │
│        │ kênh (channel)       │ kênh                             │ kênh                      │
│  ┌─────▼──────────┐   ┌───────▼───────────┐            ┌─────────▼──────────┐                │
│  │ Render thread  │   │ RPC client        │            │ Máy chủ LAN (L5)   │  chỉ khi chụp  │
│  │ pdfium (1 DLL, │   │ JSON-RPC stdio,   │            │ HTTP tạm, token    │                │
│  │ 1 instance)    │   │ theo dõi lõi      │            │ dùng một lần       │                │
│  │ text, link,    │   └───────┬───────────┘            └────────────────────┘                │
│  │ form, bitmap   │           │ stdin/stdout, mỗi dòng một JSON                             │
│  └────────────────┘   ┌───────▼───────────────────────────────────────────┐                  │
│                       │ chef-core.exe (Python, như hiện tại, khởi động lười) │                │
│                       │ Operation · phiên · jobs · pyHanko · PKCS#11      │                  │
│                       └───────────────────────────────────────────────────┘                  │
│                                                                                              │
│  Dữ liệu: cùng userData với Electron (settings.json, sessions/, logs/, cache/) — §7           │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Nguyên tắc phân vai:**
- **UI không sửa PDF.** Mọi thay đổi là một operation xuống lõi (BLUEPRINT §3).
- **Viewer dùng pdfium trực tiếp trong Rust,** không qua JSON-RPC. Bitmap trang không đi qua stdio.
- **Lõi chỉ chạy khi cần:** thao tác sửa, ký, xuất, quy trình. Khi chỉ đọc, không có tiến trình Python.
- **pdfium chỉ có một instance** và **không an toàn luồng**, nên mọi lệnh pdfium chạy trên một luồng render duy nhất (hoặc qua mutex của `pdfium-render`). Kiểm ở M1.

### 2.1 Luồng và tiến trình

| Luồng | Việc | Ghi chú |
|---|---|---|
| UI (GPUI) | Vẽ, sự kiện, trạng thái | Không làm IO hay render nặng |
| Render | Mọi lệnh pdfium: mở tài liệu, render, text, link, form | Một luồng, nhận yêu cầu qua kênh, trả bitmap BGRA |
| RPC reader | Đọc stdout của lõi, tách dòng JSON | Một luồng |
| RPC writer | Ghi stdin, có khóa | Gộp yêu cầu theo `id` |
| Supervisor | Khởi động, `system.ping`, khởi động lại khi lõi chết | Theo `CONTRACTS.md` §2 |

- Lõi khởi động với cờ **không tạo cửa sổ console** (`CREATE_NO_WINDOW`). Electron hiện làm việc này ở đâu chưa đối chiếu; kiểm ở M3 (TASKS R3.02).
- Bitmap được pdfium render sang **BGRA**, khớp với định dạng GPUI dùng trên DirectX. Chưa xác minh việc tải lên không sao chép thừa; kiểm ở M1.

### 2.2 Thiết kế tiết kiệm RAM

Các giá trị dưới đây là **giá trị khởi điểm**, không phải ngân sách. Chỉnh sau khi đo.

| # | Cơ chế | Chi tiết |
|---|---|---|
| R1 | Cache bitmap LRU tính theo **MB** | Một cache chung cho mọi tab. Trần khởi điểm 256 MB, chỉnh được trong cài đặt. Khi vượt trần, bỏ bitmap ít dùng nhất. Ước lượng: một trang A4 fit-width ở DPR 1,75 ≈ 11 MB RGBA |
| R2 | Render đủ độ phân giải chỉ cho trang nhìn thấy ±1 | Trang ngoài vùng này: giữ thumbnail nhỏ hoặc bỏ hẳn bitmap |
| R3 | Tab nền | Bỏ toàn bộ bitmap trang, giữ metadata và thumbnail đã cap |
| R4 | Thumbnail cố định nhỏ, cap số lượng | Giữ giới hạn 60 thumbnail mỗi tài liệu như bản web (`c3496fc`) |
| R5 | Lõi lười | Khởi động khi cần; tự tắt sau một khoảng không dùng (đề xuất 10 phút, chỉnh được). Trạng thái nằm trên đĩa nên tắt và khởi động lại không mất dữ liệu (BLUEPRINT §5) |
| R6 | Import lười trong lõi | `cv2`, `onnxruntime`, `pyHanko` chỉ import khi operation cần. Đo chi phí của từng thư viện lúc rảnh bằng `python -X importtime`. Đây là một phần của 139 MB |
| R7 | Một pdfium instance | Một `Pdfium::bind` cho cả app; mỗi tab giữ handle tài liệu |
| R8 | Font theo nhu cầu | Chỉ nạp các cỡ/độ đậm đang dùng (400, 500, 600). Mỗi font nạp một lần |
| R9 | Texture GPUI | Giới hạn kích thước atlas; giải phóng texture khi bitmap bị loại. **Kiểm ở M1:** GPUI có giữ thêm bản sao không |
| R10 | Build phát hành | `lto = "thin"`, `codegen-units = 1`, `strip = true`. Không dùng `panic = "abort"` (cần `catch_unwind` cho lỗi pdfium) |
| R11 | Nhật ký có trần | Bộ đệm log trong RAM có giới hạn; ghi tiếp ra `logs/` |
| R12 | Không WebView | Không có tiến trình trình duyệt nào, nên không có nền Browser/GPU/Renderer của Chromium |

**Đo lường:** mỗi mốc phải báo cáo `nativeMB` (mọi tiến trình Chef Native) và `coreMB` (chef-core) theo cùng kịch bản với `perf-memory` (xem §10.4).

**Số đo M1.4 (2026-11-09, file 1000 trang chữ tiếng Việt, `scripts/measure-native-memory.ps1`, build debug, chạy ngoài màn hình):**
- Mở file: `nativeMB` = 99,6 MB (cache 1 lần render, 115 lần vẽ).
- Sau khi cuộn 350 màn hình (mỗi bước 150 ms): `nativeMB` = 100,3 MB; `cached` = 2 trang; không có yêu cầu nào chờ. Chính sách full-scale chỉ cho trang nhìn thấy ±1 (R2) đã giữ cache nhỏ.
- Bản release (LTO) cho cùng kết quả ở đường E2E (151 lần vẽ, cache 2).
- `coreMB` = 0: chưa có lõi nào được khởi động trong kịch bản này (lõi lười, §4). Chưa đo cùng kịch bản với Electron có lõi (R1.38), nên chưa so sánh tổng. Số Electron đã có (1351 MB ở 350 màn hình) là chỉ riêng tiến trình Electron.
- Working set không thấy bộ nhớ GPU (texture nằm ngoài working set). R1.35 sẽ ghi `Dedicated Usage` và `Shared Usage` từ `\GPU Process Memory(pid_*)` ở ba mốc của runner, tách tổng PID của Chef Native và chef-core. Trường nào không có bộ đếm hoặc PID path sẽ in `unavailable`, không coi là 0. Chưa có số GPU hay kết luận; ghi kèm phiên bản Windows và driver GPU vì Microsoft ghi nhận bộ đếm có thể sai trên một số hệ thống Windows 10 từ bản 1709 trở lên ([KB 4490156](https://learn.microsoft.com/en-us/troubleshoot/windows-client/performance/gpu-process-memory-counters-report-wrong-value)). Chỉ dùng DXGI nếu phép đo Windows cho thấy bộ nhớ GPU tăng theo số trang đã cuộn.

## 3. Lõi xử lý: mô hình thao tác (Operation)

**Không đổi** so với BLUEPRINT §3. Lõi Python giữ nguyên `Params` (Pydantic), registry, job runner và hợp đồng.

Thay đổi duy nhất ở phía Rust là **sinh kiểu Rust** từ cùng JSON Schema (§8.3). Mỗi Operation có một struct Rust `Params`, và `ops.run` nhận đúng kiểu đó. Lệch hợp đồng sẽ bị bắt ở biên dịch hoặc ở bước kiểm tra codegen trong CI.

## 4. Phiên tài liệu, lưu & hoàn tác (mô hình lười)

**Vấn đề:** BLUEPRINT §4 tạo `rev-0000.pdf` ngay khi mở file. Nếu lõi lười, việc mở file để xem không được tạo phiên.

**Mô hình ba trạng thái:**

```
[Xem]  ──(thao tác sửa đầu tiên, ký, xuất…)──▶  [Phiên]  ──(lưu)──▶ [Phiên, đã lưu]
 Rust + pdfium, đọc file gốc, không ghi gì        core session.open tạo rev-0000,
 không có tiến trình lõi                          viewer chuyển sang rev file
```

**Chi tiết:**
1. **Mở file (Xem):** Rust mở file gốc bằng pdfium, chỉ đọc. Ghi lại dấu vết để phát hiện file đổi: kích thước, mtime và hash 64 KB đầu/cuối. Không tạo thư mục phiên.
2. **Mật khẩu:** file mã hóa nhập mật khẩu một lần, được giữ trong bộ nhớ Rust (dùng `zeroize` khi đóng). pdfium dùng để mở. Mật khẩu chỉ gửi cho lõi trong `session.open`, không ghi ra đĩa.
3. **Thao tác sửa đầu tiên:** Rust kiểm tra dấu vết. Nếu file gốc đã đổi, báo người dùng và không tạo phiên tự động. Nếu khớp, gọi `session.open` (lõi tạo `rev-0000.pdf` và `meta.json`), rồi chạy operation.
4. **Chuyển viewer:** sau khi có `rev` mới, viewer mở lại tài liệu từ rev file và giữ vị trí cuộn và zoom. Chỉ tải lại các trang trong `changedPages` (BLUEPRINT §4). Bitmap các trang còn lại được giữ.
5. **Hoàn tác, làm lại, lưu, đóng:** như BLUEPRINT §4 và CONTRACTS §4. Giới hạn 50 revision; rev-0000 luôn giữ.
6. **Đóng tab khi chưa sửa:** không có gì để dọn, vì chưa có phiên.
7. **Sau khi ký:** trạng thái `signed` như BLUEPRINT §4. Thao tác làm mất chữ ký bị chặn.

**Rủi ro cần kiểm ở M3:** chuyển từ file gốc sang rev file có làm mất trạng thái hiển thị (vị trí, chọn chữ, tìm kiếm) không.

## 5. Giao tiếp giữa các tiến trình

| Kênh | Cơ chế | Ghi chú |
|---|---|---|
| UI ↔ Render | Kênh trong tiến trình; yêu cầu có `id`, trả bitmap hoặc dữ liệu chữ | Không sao chép qua IPC |
| UI ↔ RPC | Kênh trong tiến trình tới RPC client | Sự kiện từ lõi phát lại thành sự kiện UI |
| RPC ↔ lõi | JSON-RPC 2.0 qua stdin/stdout, mỗi dòng một thông điệp | Framing theo CONTRACTS §3. Không mở cổng mạng |
| Dữ liệu lớn | Ghi vào `cache/`, chỉ truyền đường dẫn | Như BLUEPRINT §5 |
| Máy chủ LAN (L5) | HTTP tạm trong tiến trình, chỉ chạy khi đang chụp | Token dùng một lần, tự tắt sau khi xong hoặc sau 10 phút. Đây là cổng mạng duy nhất của app |
| Debug channel (E2E) | Named pipe có token, chỉ bật khi `CHEF_E2E=1` hoặc build debug | Xem §10.2 |

**Vòng đời lõi:** khởi động lười, `system.ping` kiểm tra, khởi động lại khi chết (CONTRACTS §2). Thông báo `core-status` được phát cho UI như bản Electron.

## 6. Giao diện

Phần này là trọng tâm của yêu cầu giữ hình họa. Nguồn sự thật là **`tokens.css` và các file CSS hiện có**. Không thiết kế lại. Không dùng bộ sinh palette của skill ui-ux-pro-max, vì nó tạo palette mới.

### 6.1 Token là nguồn duy nhất

- `apps/ui/src/app/styles/tokens.css` có **126 khai báo** cho hai theme (`:root` và `:root[data-theme='dark']`), gồm font, cỡ chữ, khoảng cách (lưới 4 px), bo góc, kích thước điều khiển, motion, màu, bóng và focus ring.
- **Theme Rust sinh từ tokens.css** bằng một script codegen (`scripts/gen-native-theme.mjs`). Kết quả là `crates/chef-theme/src/generated.rs` gồm ba hằng số: light, dark, và chọn theo hệ thống.
- **Chống lệch:** CI chạy lại script và so sánh với file đã commit. Đúng cơ chế kiểm tra codegen contracts đang dùng.
- **Theme hệ thống:** đọc chế độ sáng/tối của Windows (registry `AppsUseLightTheme` hoặc API tương đương). Theme cài đặt `system/light/dark` như `app/theme.ts` hiện nay. **Kiểm ở M1.**

**Cách biểu diễn màu:**

| CSS | Rust | Ghi chú |
|---|---|---|
| `#rrggbb` | `rgb(0xRRGGBB)` | |
| `rgba(r,g,b,a)` | `rgba(0xRRGGBBAA)` | Chuyển alpha sang 0–255 khi sinh code |
| `--c-*` | `theme.color.<tên>` | Giữ tên đuôi để dễ đối chiếu |

**Bóng và focus ring:**
- `--shadow-xs` đến `--shadow-lg` và `--c-page-shadow` là danh sách nhiều bóng. Ánh xạ sang danh sách `BoxShadow` (offset, blur, spread, màu). Trường `spread_radius` và `blur_radius` có trong API (đã thấy trong fork rgpui; **kiểm ở M1** trên `gpui` đã ghim).
- `--focus-ring: 0 0 0 2px surface, 0 0 0 4px focus` là hai bóng lan (spread) với màu khác nhau. Ánh xạ thành hai bóng đã đạt thứ tự vẽ (§6.9), với `blur_radius` 0,5 px thay cho 0 (blur 0 không vẽ). Đối chiếu với Electron còn mở (R1.21).

### 6.2 Bảng ánh xạ CSS sang GPUI

Mỗi dòng cần kiểm trên commit đã ghim trước khi M2. Cột "Đã thấy trong dự án" lấy từ đếm bằng grep.

| CSS trong dự án | Số lần | Hướng xử lý trong GPUI | Trạng thái |
|---|---|---|---|
| `display: flex`, gap, căn lề | nhiều | Layout của GPUI (dựa trên Taffy) | Kiểm ở M1 |
| `grid-template-columns` (`minmax`, `repeat(auto-fit, minmax())`, `max-content`) | 52 | GPUI không có `auto-fit`; cách khác: số cột tính từ chiều rộng khung (§6.9) | Cách khác (R1.17) |
| `text-overflow: ellipsis` | nhiều | `truncate()` cho một dòng đạt (§6.9); nhiều dòng là `line_clamp`, chưa kiểm | Đạt một dòng (R1.17) |
| `@keyframes` | 7 (`fade-in`, `dialog-in`, `toast-in`, `spin`, `indeterminate`, `thumb-shimmer`, `tedit-blink`) | Animation của GPUI, hoặc giá trị nội suy theo thời gian trong `render` | **Kiểm ở M1** |
| `transition` | 11 | Animation có thời lượng và đường cong. Đường cong `cubic-bezier(0.2,0,0,1)` cần hàm tự viết | Kiểm ở M1 |
| `@media` (thu về một cột) | 13 | Rẽ nhánh theo chiều rộng cửa sổ trong code | Đã biết |
| `aspect-ratio: 260 / 100` | 1 (`signTemplate.css`) | `aspect_ratio(260/100)` | Đạt (R1.17) |
| `repeating-linear-gradient` | 1 (`overlay.css`, thước kẻ) | Vẽ các vạch bằng quad | Đã biết |
| `filter: invert(1) hue-rotate(180deg)` | 1 (`Viewer.css`, đọc trang tối) | GPUI không có filter CSS. Đảo màu bitmap trong Rust trước khi upload, hoặc để pdfium render ngược | **Quyết định ở M2** |
| `filter: grayscale(0.6)` | 1 (`StartScreen.css`, ảnh mờ) | Tiền xử lý ảnh hoặc shader; không dùng nếu không đáng | Quyết định ở M2 |
| `transform: translate(-50%, -50%)` | 33 | Căn giữa bằng layout hoặc offset | Đã biết |
| `:hover` | nhiều | `.hover()` | Đạt (R1.19) |
| `:active` | nhiều | `.active()` | Đạt (R1.19) |
| `:focus-visible` | 12 | `focus_visible()` chỉ hiện khi lần nhập gần nhất là bàn phím (§6.9) | Đạt (R1.19) |
| `cursor: pointer` | 24 | `.cursor_pointer()` | Chưa đo con trỏ (R1.19) |
| `user-select: none` | 11 | Chọn chữ tắt cho chrome giao diện | Kiểm ở M1 |
| `font-variant-numeric` | 12 | `tnum` qua `font_features` đạt; Be Vietnam Pro không có `tnum` (§6.9) | Đạt, font không hỗ trợ (R1.18) |
| `letter-spacing` | 6 | Hỗ trợ theo phần tử | Kiểm ở M1 |
| `text-transform: uppercase` | 2 | Chuyển trong code | Đã biết |
| `::before`, `::after` | 7 | Phần tử con giả trong code | Đã biết |
| `scrollbar` (tùy biến) | 3 | GPUI không vẽ thanh cuộn, không có API màu: vẽ riêng trong chef-ui (§6.9) | Vẽ riêng (R1.20) |
| `backdrop-filter`, `clip-path`, `mix-blend-mode`, `position: sticky`, `writing-mode` | 0 | Không cần | — |
| Khung cửa sổ | `--titlebar-h` không dùng | Cửa sổ dùng khung gốc của Windows (`window.ts` không đặt `frame: false`). **Giữ khung gốc** | Đã biết |
| Thanh tab, thanh công cụ, thanh trạng thái | `--tabsbar-h 38`, `--toolbar-h 46`, `--statusbar-h 28` | Các hằng số trong code, đúng số hiện tại | Đã biết |

**Ghi chú:** tài liệu trước (PLAN_RUST.md) nói có "titlebar tùy biến 42 px". Đó là sai: `--titlebar-h` không được dùng và cửa sổ vẫn có khung gốc.

### 6.3 Icon: 153 biểu tượng Lucide

- Đếm bằng script đọc import, gồm import nhiều dòng và alias `as`: **153 tên duy nhất** (đếm bằng grep trước đó chỉ ra 103, vì bỏ sót import nhiều dòng).
- **Lucide là ISC.**
- Script `scripts/export-icons.mjs` đọc import, lấy SVG tương ứng từ gói `lucide` (không lấy từ `lucide-react`), và xuất vào `assets/icons/`. Icon được nhúng vào exe để giảm số file.
- **Kiểu nét:** Lucide dùng `stroke="currentColor"`, `fill="none"`, độ dày nét 2 trên viewBox 24. GPUI vẽ SVG như mặt nạ đơn sắc tô bằng `text_color` (`paint_svg`), nên không cần `currentColor`; icon nhiều màu không làm được bằng `svg()`. Nét 2 ở 16 và 18 px hiển thị liền trong ảnh probe (§6.9).
- Kích thước dùng trong giao diện: đọc từ CSS hiện tại, không đoán.

### 6.4 Font: Be Vietnam Pro

- Giao diện đang nạp qua `@fontsource/be-vietnam-pro` (`main.tsx`, các độ đậm 400, 500, 600). Gói này **chỉ có woff và woff2**.
- **Hướng xử lý:** lấy TTF của Be Vietnam Pro từ nguồn gốc (OFL-1.1), giữ đủ tập Latin và Latin-Extended (có ký tự tiếng Việt). Đổi woff2 sang TTF bằng `fontTools` nếu cần. OFL cho phép chuyển định dạng.
- **Đã kiểm ở M1 (R1.13):** DirectWrite nạp TTF 400, 500, 600 qua `add_fonts` (nhúng vào exe bằng build.rs, R1.02); ba độ đậm hiển thị khác nhau và chữ có dấu không thiếu glyph. woff không dùng. So với Electron còn mở (R1.21).
- **Font mono:** `--font-mono` dùng `Cascadia Code`, `Consolas`, có sẵn trên Windows.
- Chữ trên Windows (DirectWrite) và trên Chromium có khác nhau nhỏ về kết xuất. Chấp nhận, không ép khớp từng điểm ảnh.

### 6.5 Chuỗi giao diện: i18n

- Hai file: `apps/ui/src/i18n/en.json` và `vi.json`. **Nạp nguyên văn**, không sửa nội dung.
- Có **30 chỗ dùng `{{…}}`** (nội suy) và **20 cặp khóa `_one`/`_other`** (số nhiều). Cần một bộ thay thế nhỏ tương thích hai cú pháp này. Cả tiếng Việt và tiếng Anh đều chỉ có `one` và `other` trong dự án này.
- Chọn ngôn ngữ theo cài đặt, như hiện nay.
- Test `i18n.test.ts` có thể dùng làm kiểm tra: mọi khóa trong `vi.json` và `en.json` phải có trong bản Rust.

- **Đã làm (R2.13):** `crates/chef-ui/src/i18n.rs`. Hai file JSON được nhúng bằng `include_str!` từ `assets/i18n/` (không đi qua build.rs). Đối chiếu với i18next bằng bộ golden sinh từ chính thư viện của dự án (`scripts/gen-native-i18n-golden.mjs`), không viết tay kỳ vọng. Trong en.json có 20 cặp `_one`/`_other`; vi.json không có hậu tố số nhiều, nên tiếng Việt luôn dùng khóa thường.

### 6.6 Thành phần giao diện

Dự án dùng **14 primitive Radix**. gpui-component có giao diện riêng, nên **không dùng để giữ hình họa**. Viết thành phần riêng dựa trên `components.css`, dùng token của §6.1.

| Primitive Radix | Dùng ở | Hành vi cần khớp |
|---|---|---|
| Dialog (2) | Mọi hộp thoại | Bẫy focus; Esc đóng; nhấn nền đóng; trả focus về nút đã mở; animation `dialog-in` |
| Dropdown menu, Context menu | Menu, menu chuột phải trang | Mũi tên lên/xuống; Enter; typeahead theo ký tự; Esc; mục bị khóa không chọn được |
| Select | Chọn ngôn ngữ, cỡ, kiểu | Mũi tên; typeahead; Enter; Esc; mở và đóng bằng bàn phím |
| Tabs (2) | Thanh chức năng | Roving focus; mũi tên trái/phải; Home/End |
| Radio group | Lựa chọn một trong nhiều | Mũi tên; Space chọn |
| Checkbox | Hộp kiểm | Space bật/tắt; trạng thái không xác định |
| Switch | Bật/tắt cài đặt | Space; Enter |
| Slider | Độ tương phản, độ sáng, ngưỡng | Mũi tên; PageUp/PageDown; Home/End |
| Toggle group | Nhóm nút bật/tắt | Roving focus |
| Tooltip | Mọi nút công cụ | Trễ 450 ms, bỏ trễ 200 ms (`App.tsx`) |
| Popover | Một số bảng nổi | Đóng khi mất focus; Esc |
| Scroll area | Danh sách, thanh bên | Thanh cuộn có style (§6.2) |
| Separator | Phân cách | Chỉ hiển thị |

**Thư viện UI:** một dự án gốc (`components/`) với `Button`, `Form`, `Dialog`, `TaskDialog`, `Misc`, `Toast` (tương ứng 80, 71, 33, 32, 30, 29 lần import). Bản Rust có một module `chef-ui` với cùng các thành phần, cùng tên, cùng class token.

### 6.7 Dark/light và trạng thái

- Bộ trạng thái chuẩn cho mỗi điều khiển: bình thường, hover (`--c-hover`), active (`--c-active`), focus (`--focus-ring`), disabled (`--c-text-disabled`), lỗi (`--c-danger-soft`).
- Thời lượng: `--dur-fast` (100 ms) và `--dur` (160 ms), đường cong `--ease`. Nằm trong khoảng 150–300 ms của skill, trừ 100 ms cho thay đổi nhỏ.
- **Giảm chuyển động:** media query `prefers-reduced-motion` trong `components.css:828` là có thật. Đọc cài đặt "hiệu ứng hoạt hình" của Windows (`SPI_GETCLIENTAREAANIMATION`) và tắt animation khi bật.
- **Hộp thoại (R2.10, `chef-ui/src/dialog.rs`):** khung `.dlg-overlay` và `.dlg` được dựng lại từ CSS. Đã làm: lớp phủ tô `--c-overlay` và chặn chuột xuống trang bên dưới; bấm ra ngoài đóng; Tab vòng trong hộp thoại; Esc đóng; đóng trả tiêu điểm về nút đã mở; nút đóng ở góc phải.
- **Lệch so với CSS (đã chấp nhận):** (a) `dialog-in` không co `scale(0,985)`, chỉ mờ dần và dịch lên 6 px trong 160 ms theo `--ease`. Khung không có co vì GPUI không có transform theo tỉ lệ cho một phần tử có nội dung chữ; hiệu ứng nhìn thấy được vẫn là mờ và dịch. (b) lớp phủ `dlg-overlay` cũng mờ dần trong cùng 160 ms, như `fade-in` của CSS. (c) Tab vòng trong không dùng `tab_group` vì GPUI ở commit đã ghim không có API này; khung tự chuyển tiêu điểm qua danh sách `tab_order`.
- **Giảm chuyển động (D83):** `chef-ui/src/motion.rs` đọc `SPI_GETCLIENTAREAANIMATION` mỗi lần dựng hộp thoại. Biến `CHEF_E2E_REDUCED_MOTION=1|0` ghi đè để E2E kiểm được cả hai đường. Khi giảm chuyển động, hộp thoại vẽ trạng thái cuối ngay. Phần đo pixel chưa làm.

### 6.8 Kiểm tra độ trung thực hình họa (chuẩn so sánh)

**Chuẩn là bản Electron hiện tại** (1.3.0, commit `a17cead`), chụp bằng bộ ui-audit:
- Bộ ui-audit có **104 màn hình** trong `tests/e2e/specs/ui-audit.spec.ts`, cỡ cửa sổ lấy từ `tests/e2e/fixtures/uiAudit.ts` (`VIEWPORT`).
- Baseline JSON (`tests/e2e/ui-audit-baseline.json`) được ghi ở **DPR 1**, không phải DPR 1,75. Chụp chuẩn ở DPR 1 để so sánh được. Thêm một bộ ở DPR 1,75 để kiểm tra màn hình độ phân giải cao.
- Chụp cả hai theme (sáng, tối).
- **So sánh:** từng màn hình, bằng độ đo cảm nhận (SSIM hoặc so sánh theo vùng) với ngưỡng. Không so từng điểm ảnh, vì DirectWrite và Chromium khử răng cưa chữ khác nhau.
- **Lưu trữ ảnh chuẩn:** không đưa vào git (kích thước lớn). Lưu ngoài repo, git chỉ giữ manifest có băm SHA-256.

**Checklist parity (từ skill ui-ux-pro-max, dùng như danh sách kiểm, không dùng để đổi màu):**
- [ ] Mọi điều khiển có focus nhìn thấy (vòng focus §6.1)
- [ ] Hover phản hồi bằng màu hoặc độ trong, không đổi kích thước (không scale làm lệch bố cục)
- [ ] Chuyển động 100–300 ms; có tắt khi giảm chuyển động
- [ ] Mọi phần tử bấm được có con trỏ bàn tay
- [ ] Điều khiển dùng biểu tượng SVG, không dùng emoji (đã đúng: dùng Lucide)
- [ ] Icon-only có nhãn truy cập được (`aria-label` tương ứng)

**Phát hiện về độ tương phản (ghi nhận, không đổi màu, chủ dự án quyết định):** tính theo WCAG từ đúng giá trị trong `tokens.css`.

| Cặp | Tỷ lệ | Ngưỡng | Ghi chú |
|---|---|---|---|
| `--c-text-3` #7d8494 trên `--c-surface` #ffffff | **3,75:1** | 4,5 (chữ thường) | Dưới ngưỡng |
| `--c-text-3` trên `--c-bg` #f4f5f7 | **3,44:1** | 4,5 | Dưới ngưỡng |
| `--c-success` #1f9d61 trên trắng | **3,47:1** | 4,5 | Dưới ngưỡng nếu dùng làm chữ |
| `--c-warning` #b7791f trên trắng | **3,64:1** | 4,5 | Dưới ngưỡng nếu dùng làm chữ |
| `--c-danger` #d93d3d trên trắng | 4,48:1 | 4,5 | Sát ngưỡng |
| `--c-text-disabled` #a8aeb9 trên trắng | 2,23:1 | Miễn cho điều khiển bị tắt | |
| `--c-accent` #2f6be4 trên trắng | 4,83:1 | 4,5 | Đạt |
| Chữ tối (`--c-text`) trên trắng | 15,73:1 | 4,5 | Đạt |
| Dark: `--c-text-3` #858c99 trên #1d2027 | 4,82:1 | 4,5 | Đạt |

Đây là phát hiện trên giao diện hiện tại. Bản Rust giữ nguyên, chủ dự án quyết định có đổi không.

### 6.9 Kết quả probe hình họa (M1, R1.13–R1.20)

Trang thử: `CHEF_E2E=1 CHEF_E2E_PROBE=1` (`apps/native/crates/chef-app/src/probe.rs`), đặt ngoài màn hình, chụp bằng lệnh `screenshot`. **Chưa so với Electron:** cần ảnh tham chiếu của R1.21.

- **Bóng (R1.16):** shader của GPUI (`gpui_windows/src/shaders.hlsl`, `shadow_fragment`) dùng `blur_radius` làm σ của hàm Gauss. CSS dùng σ = blur/2, nên bóng CSS `B px` tương ứng `B/2` trong GPUI. `blur_radius = 0` cho ra NaN và không vẽ gì, nên vòng focus cứng dùng 0,5 px. Vòng `0 0 0 2px surface, 0 0 0 4px focus` đã vẽ đúng: khe 2 px màu nền, viền 2 px màu focus.
- **Chữ số cố định (R1.18):** GPUI chuyển `font_features` xuống DirectWrite, kiểm bằng Constantia (có `tnum`, chữ số mặc định không đều): cột `tnum` thẳng hàng. **Be Vietnam Pro không có `tnum`** (kiểm bằng fontTools: không có trong GSUB), nên `tabular-nums` của 12 chỗ trong CSS không có tác dụng ở cả hai bản. Nếu một cột số cần thẳng hàng, cách bù là vẽ mỗi chữ số trong một ô cố định; chưa cần làm.
- **Icon (R1.15):** `svg()` tô bằng `text_color`; xem §6.3.
- **Trạng thái nút (R1.19):** hover và active đổi đúng màu (kiểm bằng lệnh debug `mouse move` và `mouse down`). Token hover và active là RGBA trong suốt, nên phải dùng `rgba_hex`, không dùng `hex` (`hex` bỏ alpha, nút thành màu tối). `focus_visible()` chỉ áp khi tiêu điểm đang có và lần nhập gần nhất là bàn phím (`window.last_input_was_keyboard`). `state.cursor` đọc loại cursor Win32 hiện tại và tọa độ màn hình; phải hiện probe và đưa con trỏ hệ thống thật lên nút để kiểm `hand`. Chưa đo vì WGC không chụp con trỏ và E2E mặc định đặt cửa sổ ngoài màn hình.
- **Bố cục (R1.17):** `grid` của GPUI chỉ có số cột cố định (`grid_cols`), không có `auto-fit` hay `minmax(220px, 1fr)`. Cách đã chọn: số cột = ⌊(W + gap) / (220 + gap)⌋, tính từ chiều rộng khung. Đo ở ba khung: 3 cột (800 px), 4 cột (1184 px), 6 cột (1484 px). `truncate()` cắt một dòng đúng (glyph cắt trông như ba dấu chấm; so với `…` của Electron ở R1.21). `flex_1().min_w_0()` cho `minmax(0, 1fr) 300px`. `aspect_ratio(260/100)` giữ 260×100.
- **Thanh cuộn (R1.20):** GPUI core không vẽ thanh cuộn; `scrollbar_width` chỉ chừa chỗ và không có API màu. Thanh cuộn của dự án (`scrollbar-color` trong `base.css`) phải vẽ riêng trong chef-ui khi có chỗ dùng đầu tiên.

Những điều phát hiện khi làm R2.10 (áp dụng cho mọi thành phần sau này):

- **Không có `tab_group` ở commit đã ghim.** Vòng Tab trong một khu (hộp thoại, menu, bảng lệnh) phải tự làm bằng danh sách `FocusHandle` theo thứ tự hiển thị (`dialog::next_index`, `dialog::step`).
- **Action handler ở pha bubble tự dừng truyền.** `app.rs:1942`: mặc định một listener của action đã dừng việc đi lên các phần tử cha. Muốn cha cũng nhận thì gọi `cx.propagate()`. `TextInput::cancel` làm vậy để Esc trong ô nhập vẫn tới khung hộp thoại. Esc khác trong tương lai (toàn màn hình, thanh tìm) cần kiểm không bị gọi hai lần.
- **Đổi khóa `with_animation` đổi id phần tử, làm mất trạng thái nhấn và click.** Nút dùng khóa theo `generation` nên mouse down làm đổi id, và GPUI không phát `on_click` ở mouse up. Chỉ thấy khi bấm chuột thật (E2E `e2e-native-dialog`). Cách làm: giữ phần tử ổn định, nội suy màu thủ công (D82). Menu, tab và toast phải theo cách này nếu chuyển màu.
- **Bấm ngoài và popup:** khung bao nút và danh sách (select) không được coi bấm vào danh sách là bấm ngoài. Danh sách vẽ bằng `deferred` (lớp trên) và báo vùng của nó sau bố cục (`on_layout`); khung chỉ đóng khi bấm ngoài cả nút lẫn vùng danh sách.
- **Đăng ký điều khiển đến lúc layout, không phải lúc `render` của view.** Thành phần `RenderOnce` (Button, Select, Tabs…) chạy `render` trong pha layout, sau khi `render` của view đã trả về, nên không có điểm kết thúc khung đáng tin. Registry (`a11y.rs`) dùng hai bộ đệm: khung trước được công bố khi khung mới bắt đầu, hoặc khi đã yên 30 ms (kể cả khung rỗng). Không làm vậy thì lệnh `state` đọc khung vẽ dở và E2E lúc thì thiếu điều khiển.
- **Tooltip tự làm, không dùng của GPUI:** GPUI không chỉnh được trễ 450/200 ms. Thời gian chờ được chốt khi kích hoạt, không tính lại theo khung (tính lại làm 200 ms bị nhảy lên 450 ms giữa chừng).
- **Click chuột tọa độ logic:** kênh debug nhận tọa độ vật lý, nên E2E nhân `bounds` với `scale` của `state.controls` (xem `e2e-native-dialog.ps1`).

## 7. Dữ liệu, cài đặt & bảo mật

### 7.1 Dữ liệu dùng chung với Electron

- **Cùng thư mục userData** (đường dẫn Electron hiện dùng, xác định ở M1 từ `electron-builder.yml`). Nhờ vậy settings, sessions, library và logs được giữ nguyên.
- `settings.json` giữ nguyên định dạng (CONTRACTS §7). Bản Rust đọc và ghi cùng file.
- **Dữ liệu được mã hóa bằng `safeStorage` (mật khẩu PFX, khóa thư viện chữ ký):** Electron `safeStorage` trên Windows dùng DPAPI. Bản Rust có thể giải mã thông qua DPAPI nhưng cần đọc khóa trong `Local State`, việc này dễ lỗi. **Quyết định:** không giải mã. Người dùng nhập lại mật khẩu PFX một lần sau khi chuyển. Ghi thành D73.

### 7.2 Bảo mật

| Mối đe dọa | Biện pháp |
|---|---|
| PDF chứa JavaScript | **Kết quả kiểm M1 (2026-11-09):** DLL build 8076 và 8125 đều chứa mã V8 và XFA (chuỗi `v8…`, `XFAPacketContent`, export `FPDF_LoadXFA`). Vì vậy không thể nói "DLL không có JS". Biện pháp hiện có: viewer M1 không gọi `FPDFDOC_InitFormFillEnvironment`, nên không có môi trường form nào để chạy script; không gọi `FPDF_LoadXFA`. **Phải kiểm lại ở M4** khi làm form (R4.21): môi trường form-fill có kích hoạt JS không, và cách tắt |
| Lõi bị thay thế | Lõi chỉ chạy từ thư mục cài đặt; không nạp đường dẫn từ dữ liệu người dùng |
| Mật khẩu trong bộ nhớ | Dùng `zeroize`; không ghi log; không đưa vào tham số dòng lệnh |
| Cổng mạng | Chỉ có máy chủ L5, khi đang chụp, có token một lần. Debug channel chỉ có named pipe |
| Đường dẫn file | Tab và file mở từ Explorer phải là đường dẫn tuyệt đối, đã chuẩn hóa |
| Tiến trình con | Lõi được gắn vào Job Object để tự chết khi app đóng |

### 7.3 Cài đặt

- Cùng mục `settings.json` như bản Electron. Mục mới (ví dụ ngân sách cache, thời gian tự tắt lõi) thêm vào cùng file, có giá trị mặc định.

## 8. Cấu trúc repo

### 8.1 Bố cục mới

```
apps/native/
├── Cargo.toml                 workspace
├── crates/
│   ├── chef-app/              binary: cửa sổ, tab, định tuyến sự kiện
│   ├── chef-ui/               thành phần giao diện, phím tắt, hộp thoại dùng chung
│   ├── chef-theme/            generated.rs (sinh từ tokens.css), hằng số bố cục
│   ├── chef-rpc/              JSON-RPC client, giám sát lõi
│   ├── chef-pdf/              bọc pdfium-render: luồng render, text, link, form
│   ├── chef-viewer/           bố cục trang, cache LRU, thumbnail, mô hình cuộn
│   ├── chef-contracts/        kiểu Rust sinh từ JSON Schema
│   ├── chef-capture/          máy chủ L5
│   └── chef-testkit/          client debug channel, so sánh ảnh, đo RAM
├── assets/
│   ├── fonts/                 Be Vietnam Pro TTF (400, 500, 600)
│   ├── icons/                 SVG Lucide (153)
│   └── i18n/                  en.json, vi.json (bản sao từ apps/ui)
└── build.rs                   nhúng tài nguyên vào exe
```

Các thư mục Electron (`apps/desktop`, `apps/ui`) và `core/` không đổi, trừ việc `core/` cần đổi import lười (R6).

### 8.2 Script mới

| Script | Việc |
|---|---|
| `scripts/gen-native-theme.mjs` | `tokens.css` → `chef-theme/src/generated.rs`; chế độ `--check` cho CI |
| `scripts/export-icons.mjs` | Đọc import Lucide trong `apps/ui` → SVG trong `assets/icons/`; in danh sách thiếu |
| `scripts/gen-native-contracts.mjs` | JSON Schema từ `packages/contracts` → Rust (§8.3) |

### 8.3 Sinh kiểu Rust

- Nguồn: JSON Schema đã có trong `packages/contracts/src/generated` (sinh từ Pydantic).
- Công cụ đề xuất: **typify** (Rust), sinh struct và enum từ JSON Schema. Giấy phép cần xác minh trước khi thêm (§9).
- CI chạy lại codegen và so sánh với file đã commit (cùng cơ chế với contracts TS).
- **Kết quả probe (TASKS R1.42, 2026-11-09):** typify **0.10.0-alpha.3** không dùng được với rustc 1.94 của dự án (yêu cầu rustc 1.97). Dùng **typify 0.4** (ổn định, kéo schemars 0.8). Nguồn thử là `core/chef_core/layout/schema.json` (JSON Schema 2020-12 có `prefixItems`, typify 0.4 vẫn sinh được). `build.rs` của `chef-contracts` sinh `layout_types.rs` lúc build; test đọc `Paragraph` theo schema và từ chối khi thiếu `bbox`. Giấy phép (typify và các gói kéo theo) đạt `cargo deny check licenses bans sources`.
- Hạn chế: schema của lõi hiện là file riêng (`core/chef_core/layout/schema.json`), chưa phải toàn bộ `packages/contracts`. Khi nối toàn bộ contracts, cần kiểm lại `oneOf`/`anyOf` và kiểu số.

## 9. Công nghệ & thư viện

| Thành phần | Gói | Giấy phép | Xác minh |
|---|---|---|---|
| Khung giao diện | `gpui` (repo Zed), **ghim v0.233.10 (350f338)** | **Apache-2.0** (đã đọc `Cargo.toml` của crate, TASKS R1.01) | Đã xác nhận cho crate `gpui`; đồ thị phụ thuộc xem kết quả cargo-deny bên dưới |
| Bộ widget (tùy chọn) | `gpui-component` | **Apache-2.0** (đã đọc `LICENSE-APACHE` trên `main`, 2026-11-08; GitHub ghi "Other" vì có hai file giấy phép) | Không dùng để giữ giao diện (§6.6) |
| PDF engine | `pdfium` (Google) | **BSD-3-Clause** (đã đọc `LICENSE` upstream trên chromium/pdfium, 2026-11-08) | Đã xác nhận |
| Bọc pdfium | `pdfium-render` 0.9.5, `default-features = false`, feature `pdfium_8125` + `thread_safe` | **MIT OR Apache-2.0** (đã đọc `Cargo.toml` và `LICENSE.md`, 2026-11-08) | Đã xác nhận |
| DLL pdfium | `chromium/8125` từ bblanchon, tải bằng `scripts/fetch-pdfium.mjs` vào `apps/native/third_party/pdfium/` (không commit) | Bản build bblanchon là MIT; pdfium bên trong là BSD-3-Clause (đã đọc LICENSE upstream) | **Đã thay đổi 2026-11-09:** DLL của pypdfium2 (build 8076) bị từ chối vì pdfium-render 0.9.5 chỉ có feature `pdfium_8125`, bind thất bại với `GetProcAddress`. Bản native không dùng chung DLL với lõi; hai bản cùng tồn tại (≈7 MB). Đã kiểm: render trang 1 ở cùng kích thước 893×1263 khớp từng điểm ảnh với pypdfium2 (xem TASKS R1.31) |
| Codegen Rust | `typify` | **Apache-2.0** (đã đọc `LICENSE` trên GitHub, 2026-11-08) | Đã xác nhận |
| Windows API | `windows` (windows-rs) | MIT/Apache-2.0 | DPAPI không dùng (§7.1); dùng cho theme, Job Object, Named pipe |
| JSON | `serde`, `serde_json` | MIT/Apache-2.0 | |
| HTTP (L5) | `tiny_http` hoặc tương đương | Kiểm trước khi thêm | Chỉ dùng khi chụp |
| Font | Be Vietnam Pro | OFL-1.1 | Nguồn TTF gốc |
| Icon | Lucide | ISC | Lấy từ gói `lucide` |
| Lõi | Python, pyHanko, pypdfium2, pikepdf, Pillow, img2pdf, OpenCV, ONNX Runtime (L20) | Như hiện tại | Không đổi |

**Quy tắc giấy phép:**
- Không AGPL: MuPDF, PyMuPDF, Ghostscript, iText (CLAUDE.md).
- Không copy mã của Zed editor (GPL-3.0). Chỉ dùng crate `gpui` và các crate nền của nó được xác nhận Apache-2.0.
- Thêm **cargo-deny** vào CI với danh sách giấy phép cho phép. Mọi crate mới phải qua bước này.

**Kết quả kiểm giấy phép đồ thị của gpui (cargo-deny, 2026-11-08, tag v0.233.10):** giả định "chỉ gpui là Apache-2.0" là **không đúng**. Đồ thị kéo theo các crate nội bộ của Zed:
- GPL-3.0-or-later: `zlog`, `ztracing`, `ztracing_macro` (kéo vào qua `sum_tree` → `gpui`).
- Không khai báo giấy phép: `gpui_util`, `gpui_shared_string`.
- MPL-2.0: `cbindgen` (build-dep của gpui), `dwrote` (có trong `gpui_windows`, tức là có trong binary Windows), `option-ext`.

Đã thêm vào allow (permissive, ghi nhận): `bzip2-1.0.6`, `NCSA`. Các mục trên cần quyết định của chủ dự án (xem NOTES 2026-11-08d). Không nới danh sách GPL.

## 10. Kiểm thử

### 10.1 Tầng

| Tầng | Công cụ | Phạm vi |
|---|---|---|
| Lõi | pytest (1690 test), giữ nguyên | Operation, PDF, chữ ký |
| Rust đơn vị | `cargo test` | Bố cục trang, cache LRU, framing JSON-RPC, codegen |
| Thành phần | `cargo test` + ảnh | Điều khiển, trạng thái, focus |
| Giao diện | So ảnh ui-audit (§6.8) | 104 màn hình, hai theme |
| E2E | Debug channel (§10.2) | Chuyển từ Playwright dần: ưu tiên smoke, demo-v07, demo-v08, workflow |
| Bộ nhớ | `perf-memory` viết lại (§10.4) | Mọi mốc |
| Cuộn | `perf-wheel` viết lại | Mọi mốc từ M2 |

### 10.2 Debug channel

- Named pipe `\\.\pipe\chef-native-<pid>-<token>`. Chỉ bật khi `CHEF_E2E=1` hoặc build debug. Không có trong bản phát hành.
- Lệnh: `state` (trạng thái tab, tài liệu, chế độ), `open` (đường dẫn), `op` (opId + params, qua lõi thật), `click` (theo id phần tử ổn định), `key`, `screenshot` (ảnh cửa sổ, hiện là BMP, chụp bằng Windows.Graphics.Capture; xem §10.3), `wait` (điều kiện).
- Mọi điều khiển có `id` ổn định, giống `data-testid` của bản web.
- Mục đích giống `window.__chefUi` (D40): đọc trạng thái mà không đoán từ ảnh.

### 10.3 Cửa sổ ngoài màn hình

- **Kết quả M1 (2026-11-08):** `WindowOptions` với tọa độ âm không có tác dụng: GPUI (gpui_windows, `retrieve_window_placement`) thay vị trí bằng vị trí giữa màn hình chính khi tâm vùng nằm ngoài mọi màn hình. Cách dùng: tạo cửa sổ với `show: false`, `SetWindowPos` ra (−20000,−20000), `ShowWindow(SW_SHOWNOACTIVATE)`, rồi `window.refresh()` (khung đầu tiên được vẽ khi còn ẩn). Đã kiểm: cửa sổ nằm ngoài màn hình, GPUI dựng khung sau refresh.
- **Vẽ nội dung ngoài màn hình (đã xác nhận, 2026-11-09):** GPUI (Windows) vẽ bằng swap chain DirectComposition (`CreateSwapChainForComposition`), nên `PrintWindow` chỉ thấy khung trắng. Chụp bằng **Windows.Graphics.Capture** (`GraphicsCaptureItem` từ HWND, khung hình đọc qua texture staging D3D11) cho ra đúng nội dung: dòng chữ "Chef PDF (native, M1)" trên nền #f4f5f7, cửa sổ đang ở (−20000, −20000). Đây là cách chụp của kênh debug (`apps/native/crates/chef-app/src/capture.rs`).
- **Số vòng vẽ (đo 2026-11-09):** cửa sổ rảnh không được vẽ thêm lần nào trong 3 s (GPUI vẽ theo yêu cầu). Ép `refresh()` mỗi 16 ms (`CHEF_E2E_SPIN_MS`) đo được 32,3 vòng/s; giới hạn do bộ hẹn giờ của Windows, không do vẽ. Đếm qua trường `renders` của lệnh `state`.
- **Kích thước tối thiểu (đo 2026-11-09):** `window_min_size` = 800×560 như `MIN_SIZE` của Electron. Yêu cầu 300×200 từ bên ngoài bị kẹp ở 814×597 (kể cả viền và thanh tiêu đề).
- **Kích thước ban đầu chưa đúng:** khi vị trí nằm ngoài màn hình, GPUI thay cả kích thước bằng mặc định (1234×716, không phải 900×640 yêu cầu). Cần đặt lại kích thước bằng SetWindowPos khi làm cửa sổ chính (M2).
- **Thứ tự gọi (sửa 2026-11-09):** `SetWindowPos`/`ShowWindow` không được gọi trong `window.update` và cũng không gọi đồng bộ trong closure `run()`. WM_SIZE đồng bộ gọi `bounds_changed` qua `AsyncApp`; khi App còn bị mượn thì lỗi bị nuốt và viewport giữ `CW_USEDEFAULT` (giá trị −1227133600 px), nên không khung nào được vẽ. Cách đúng: lấy HWND và scale trong `update`, rồi gọi `SetWindowPos` với kích thước thật (không `SWP_NOSIZE`, nếu không Windows không gửi WM_SIZE) trong `cx.spawn`, sau đó `window.refresh()`. Đã kiểm: viewport khớp bounds, trang vẽ được.
- **Nếu không vẽ được** ở vị trí ngoài màn hình: đây là một đường đi đã biết, không phải lý do dừng. Hướng đầu tiên là cửa sổ thu nhỏ hoặc trong suốt. Hướng thứ hai là cửa sổ hiện, chỉ khi chủ dự án đồng ý (quy tắc E2E nền trong memory). Chuột thật chỉ với `CHEF_E2E_OS_INPUT=1`.

### 10.4 Đo bộ nhớ

- Viết lại `perf-memory` cho Windows: đọc bảng tiến trình, lấy working set của cây tiến trình Chef Native và của `chef-core`.
- In một dòng `PERFMEM` giống định dạng cũ, thêm trường `nativeMB`. Ba mốc: mở file, cuộn 350 màn hình, quay về đầu.
- **Đối chiếu:** mỗi mốc phải ghi số Electron đo lại cùng kịch bản, để so sánh trực tiếp (vì số 1351 MB chưa có phần lõi).

### 10.5 CI

- Job mới **Native (Windows)**: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, `cargo deny check`, kiểm tra codegen (theme, icon, contracts), build release.
- **Chưa chặn merge** (TASKS R1.05: workflow riêng đã chạy ở commit cũ, nhưng chưa xác minh branch protection hoặc có run xanh trên HEAD hiện tại). Trong lúc package build được tạm hoãn theo yêu cầu, cổng kiểm khả dụng cục bộ là fmt, clippy, test và script gộp E2E native (TASKS R2.33). Việc đặt job thành required do chủ dự án quyết ở Điểm kiểm M1. Linux và macOS không chặn.

## 11. Build, phát hành & cập nhật

- **Đầu ra build:** `chef-pdf.exe` (fonts và icons đã nhúng), `pdfium.dll` (cạnh exe), thư mục `core/` (PyInstaller, như hiện nay).
- **Bộ cài:** dùng NSIS như hiện tại. Công cụ đóng gói cho Rust: **kiểm ở M9** (cargo-packager hoặc NSIS trực tiếp). Không phụ thuộc electron-builder.
- **Cập nhật tự động:** electron-updater không có tương đương sẵn. Giai đoạn đầu cài bản mới bằng tay. Tự cập nhật thêm sau khi parity; repo private nên cần cách đọc release (CH2 trong TASKS.md).
- **Ký mã:** không (CLAUDE.md).
- **Kích thước:** đo ở M9 và báo cáo cùng số Electron (bộ cài 222,5 MB, lõi giải nén 303 MB).

## 12. Quy trình làm việc

- Tiếng Việt với chủ dự án. Tài liệu kỹ thuật viết tiếng Việt như hiện nay; hợp đồng và mã nguồn giữ tiếng Anh như CONTRACTS.
- Mỗi task xong: cập nhật TASKS, quyết định mới vào NOTES (từ D74 trở đi; D71–D73 đã ghi).
- Mỗi mốc: một dòng báo cáo RAM (§10.4) trong NOTES.
- Commit chỉ khi chủ dự án yêu cầu.

## 13. Các mốc

Thứ tự theo rủi ro. Từ 2026-11-11 (D86) thứ tự làm không đi thẳng theo số mốc: lát cắt dọc của M3 (một thao tác thật qua lõi, gồm đổi viewer sang rev file của §4) làm trước phần còn lại của M2; xem [PLAN_RUST.md](PLAN_RUST.md). Mỗi mốc có **Demo** và **báo cáo RAM**. Số task và ước lượng để sau M1, khi đã có tốc độ thực tế.

| Mốc | Nội dung | Việc rủi ro được giải quyết | Demo nghiệm thu |
|---|---|---|---|
| **M1 Khung và rủi ro** | Cửa sổ; theme từ tokens; ô nhập nhận IME; viewer pdfium một file với cache LRU; bộ đo RAM; cửa sổ ngoài màn hình; debug channel; lõi lười (chỉ khởi động stub) | IME tiếng Việt (§13.1); off-screen (§10.3); pdfium chung DLL (§9); font TTF (§6.4); cache (R1–R2) | Gõ Telex đúng dấu trong ô nhập (Unikey hoặc bộ gõ Windows). File 1000 trang: cuộn 350 màn hình, báo `nativeMB` và `coreMB` (lõi chưa chạy) |
| **M2 Xem đầy đủ** | Tab; mở/lưu file bằng hộp thoại; thumbnail (R4); tìm kiếm; liên kết; chọn và copy chữ; zoom, vừa khổ; theme sáng/tối/hệ thống; i18n; toàn bộ icon; chế độ đọc trang tối (§6.2) | Hình họa viewer; chọn chữ | Ảnh ui-audit viewer trong ngưỡng; copy đúng chuỗi |
| **M3 Phiên và thao tác** | Chuyển mô hình lười (§4); `session.open`; `ops.run`; undo/redo; lưu; giám sát lõi; panel job | Chuyển file gốc sang rev (§4); lõi lười (R5) | Smoke và demo-v07 (phần không sửa chữ); lõi chỉ chạy sau thao tác đầu |
| **M4 Trang và chú thích** | Lưới trang; menu chuột phải; chọn nhiều; ghi chú, tô sáng, vẽ; form qua FFI của pdfium | FFI form-fill (rủi ro trung bình) | E2E `page-menu`, `annots`, `forms` tương đương |
| **M5 Hộp thoại và quy trình** | Khung TaskDialog; renderer hộp thoại từ schema (§8.3); mọi hộp thoại xử lý; workflow (O) | Codegen Rust (§8.3) | Mọi hộp thoại mở đúng tham số; `workflow-task-step` |
| **M6 Ký số** | Danh sách chứng thư; ký; PIN; kiểm tra; mẫu chữ ký | Ký thật với token Viettel-CA | Ký thật, kiểm tra hợp lệ; danh sách kiểm tay (TOKENS.md) |
| **M7 Sửa chữ và đoạn** | Chế độ Sửa chữ, đoạn; các quyết định D62, D66, D69, D70. Gõ tiếng Việt trong khung nháp | IME lần hai, trong môi trường phức tạp hơn | E2E `text-merged`, `paragraph-session`, `format-row` tương đương |
| **M8 Chụp và xử lý ảnh** | L5 (máy chủ LAN); QR; ScanDialog; cắt, tách trang, khử ngón tay, làm phẳng | Máy chủ HTTP trong Rust | `capture`, `dewarp`, `crop-review`, `demo-v08` tương đương |
| **M9 Hoàn thiện** | Tab Giới thiệu; cài đặt; nhật ký; bộ cài; cập nhật thủ công; di chuyển userData; rà parity theo mã FEATURES | Kích thước và RAM cuối cùng | Chủ dự án dùng hằng ngày. Báo cáo RAM so với Electron |

### 13.1 IME: đường đi đã biết

- **Trạng thái (R1.23, 2026-11-09):** "một phần". `gpui_windows` xử lý `WM_IME_STARTCOMPOSITION` và `WM_IME_COMPOSITION` qua IMM32 (`ImmGetCompositionStringW`); không thấy đường TSF. Chưa xác nhận bằng bộ gõ thật: MAN-1 (R1.26, R1.27) là việc đầu tiên trong thứ tự làm tiếp (D86).
- **Nếu không đạt:** đường đi đã biết là **hiện thực TSF composition trong lớp nền Windows** của GPUI đã ghim (phần đọc và đặt composition string, vị trí ứng viên, underline). Việc này nằm trong M1 như một mục việc, không phải điểm dừng. Ước lượng công sức chỉ làm sau khi M1 đo được mức độ thiếu.
- Trường nhập văn bản dùng trong toàn app (Sửa chữ, khung ghi chú, ô tìm kiếm) đều cần đường này.

## 14. Ước lượng

Chưa ước lượng. Sau M1 có số task và tốc độ thực tế, mới đưa ra mốc thời gian cho M2–M9.

## 15. Rủi ro

| Rủi ro | Mức | Xử lý trong kế hoạch |
|---|---|---|
| IME tiếng Việt không hoạt động trong GPUI trên Windows | Cao | M1; đường đi §13.1 |
| GPUI thay đổi API liên tục | Cao | Ghim commit; cập nhật có kế hoạch; mỗi lần nâng cấp chạy lại M1 |
| Cửa sổ ngoài màn hình không vẽ | Trung bình | M1; §10.3 |
| Cache bitmap không đạt mức RAM mong muốn | Trung bình | R1–R2; đo ở mỗi mốc |
| GPUI giữ thêm texture ngoài cache | Trung bình | R9; kiểm ở M1 |
| FFI form-fill của pdfium phức tạp hơn pdf.js | Trung bình | M4 |
| Hành vi Radix khó khớp hoàn toàn | Trung bình | §6.6; kiểm từng hành vi |
| `filter` CSS (invert, grayscale) | Thấp | §6.2; quyết định ở M2 |
| Mất electron-updater; repo private | Trung bình | M9; cập nhật thủ công trước |
| Mật khẩu PFX phải nhập lại | Thấp | §7.1; ghi thành D73 |
| Lõi Python vẫn là sàn ~139 MB khi đang sửa hoặc ký | Chấp nhận | R5, R6 giảm xuống khi không dùng |
| Thời gian làm và học Rust/GPUI | Chưa đo | Đo ở M1 |
