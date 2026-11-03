# Chef PDF: Blueprint kỹ thuật & kế hoạch

> **Phiên bản 1.0 (2026-10-31).** Đi kèm [FEATURES.md](FEATURES.md) (làm *cái gì*) và [TASKS.md](TASKS.md) (chia việc *làm thế nào, theo thứ tự nào*).
> Blueprint mô tả kiến trúc, quy ước và kế hoạch. Khi thay đổi kiến trúc thì cập nhật file này và ghi quyết định vào [NOTES.md](NOTES.md).

## Mục lục

1. [Bối cảnh & giả định](#1-bối-cảnh--giả-định)
2. [Kiến trúc tổng thể](#2-kiến-trúc-tổng-thể)
3. [Lõi xử lý: mô hình thao tác (Operation)](#3-lõi-xử-lý-mô-hình-thao-tác-operation)
4. [Phiên tài liệu, lưu & hoàn tác](#4-phiên-tài-liệu-lưu--hoàn-tác)
5. [Giao tiếp giữa các tiến trình](#5-giao-tiếp-giữa-các-tiến-trình)
6. [Giao diện](#6-giao-diện)
7. [Dữ liệu, cài đặt & bảo mật](#7-dữ-liệu-cài-đặt--bảo-mật)
8. [Cấu trúc thư mục repo](#8-cấu-trúc-thư-mục-repo)
9. [Công nghệ & thư viện](#9-công-nghệ--thư-viện)
10. [Kiểm thử](#10-kiểm-thử)
11. [Build, phát hành & cập nhật](#11-build-phát-hành--cập-nhật)
12. [Quy trình làm việc](#12-quy-trình-làm-việc)
13. [Các mốc phát triển](#13-các-mốc-phát-triển)
14. [Ước lượng](#14-ước-lượng)
15. [Rủi ro & cách giảm](#15-rủi-ro--cách-giảm)

---

## 1. Bối cảnh & giả định

| Mục | Nội dung |
|---|---|
| Người dùng | **Chỉ chủ dự án tự dùng**, không phát hành, không bán (D28) |
| Nền tảng | Windows, macOS, Linux. Kiểm thử chính trên máy của chủ dự án, hai OS còn lại kiểm bằng CI và máy ảo |
| Phạm vi | 161 tính năng thuộc bản 1.0 trong FEATURES.md |
| Đội ngũ | Chủ dự án (định hướng, review, test thực tế) và Claude (thiết kế, viết code, viết test) |
| Nguyên tắc | Offline; gọn gàng kiểu ABBYY; tiếng Việt trước; không OCR/AI ở bản 1.0 (ngoại lệ L20) |

**Hệ quả của việc tự dùng (D28):**
- **Không cần** ký mã (code signing) và notarize. Khi cài thì bỏ qua cảnh báo: Windows bấm "More info → Run anyway"; macOS chuột phải → Open, hoặc chạy `xattr -dr com.apple.quarantine "/Applications/Chef PDF.app"`.
- **Tự cập nhật trên macOS bị giới hạn**, vì cơ chế cập nhật của macOS yêu cầu app đã ký. Trên macOS, A10 sẽ chỉ báo có bản mới và mở link tải. Windows và Linux cập nhật tự động bình thường.
- **Giấy phép AGPL không còn là rào cản pháp lý**, vì không phân phối app cho ai. Vẫn giữ D7 (tránh AGPL) để mở đường nếu sau này muốn chia sẻ. Nhưng nếu một spike cho thấy thư viện giấy phép thoáng không đủ sức (rủi ro R2: sửa chữ), thì **được phép xem lại** và dùng PyMuPDF.

---

## 2. Kiến trúc tổng thể

```
┌──────────────────────────────── Chef PDF (một app Electron) ────────────────────────────────┐
│                                                                                              │
│  ┌───────────────────────── Renderer (React + TypeScript) ─────────────────────────┐         │
│  │  App shell · Start · Tabs · Toolbar · Sidebar · Task dialogs · Job panel         │         │
│  │  Viewer: pdf.js (render trong Web Worker, ảo hóa trang)                          │         │
│  │  Editor overlays: chọn đối tượng, kéo khung ký, khung cắt, cọ tẩy…               │         │
│  └───────────────────────────────┬───────────────────────────────────────────────────┘        │
│                                  │  window.chef.*  (contextBridge, có kiểu TypeScript)       │
│  ┌───────────────────────────────▼──────────── Preload ─────────────────────────────┐        │
│  └───────────────────────────────┬───────────────────────────────────────────────────┘        │
│                                  │  ipcRenderer.invoke / events                               │
│  ┌───────────────────────────────▼──────────── Main process (Node) ─────────────────┐        │
│  │  Cửa sổ, menu, hộp thoại file, mở file từ OS, một phiên bản app duy nhất          │        │
│  │  Quản lý sidecar (khởi động, theo dõi, tự khởi động lại)                         │        │
│  │  Cầu nối JSON-RPC · Cài đặt · safeStorage · Cập nhật · Máy chủ LAN tạm (L5)      │        │
│  └───────────────────────────────┬───────────────────────────────────────────────────┘        │
│                                  │  JSON-RPC 2.0 qua stdin/stdout (không mở cổng mạng)        │
│  ┌───────────────────────────────▼──────────── Core sidecar (Python) ───────────────┐        │
│  │  Operation registry · Job runner (tiến độ, hủy) · Phiên tài liệu & bản sửa       │        │
│  │  pdf/ (pikepdf, pypdfium2) · imaging/ (Pillow, OpenCV, ONNX) · signing/ (pyHanko) │        │
│  │  layout/ (rã tài liệu) · export/ (docx, md, html…)                                │        │
│  └───────────────────────────────────────────────────────────────────────────────────┘        │
│                                                                                              │
│  Dữ liệu cục bộ: userData/{settings.json, sessions/, library/, logs/, cache/}               │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Nguyên tắc phân vai:**
- **Renderer chỉ lo hiển thị và tương tác.** Không tự sửa file PDF. Mọi thay đổi đều gửi thành một thao tác (operation) xuống lõi.
- **Main process là cầu nối và giữ quyền hệ thống**: file, cửa sổ, kho bảo mật, mạng LAN tạm.
- **Lõi Python là nơi duy nhất đọc/ghi PDF.** Nhờ vậy UI, xử lý hàng loạt, quy trình tự động (O) và dòng lệnh sau này (O9) đều dùng chung một chỗ.
- **pdf.js chỉ để xem** (nhanh, chọn chữ được, có sẵn công cụ ghi chú). **PDFium (pypdfium2) để xử lý** (raster hóa cho bản scan, đối tượng trang).

---

## 3. Lõi xử lý: mô hình thao tác (Operation)

Đây là quyết định kiến trúc quan trọng nhất. **Mỗi tính năng có tác động lên tài liệu là một Operation** được đăng ký trong registry.

```python
# Minh họa (không phải code cuối cùng)
@operation(id="scan.rasterize", title="Chuyển thành bản scan", group="K")
class RasterizeParams(BaseModel):            # pydantic → tự sinh JSON Schema → tự sinh kiểu TypeScript
    dpi: int = 200
    color: Literal["color", "gray", "bw"] = "gray"
    jpeg_quality: int = 75
    effects: ScanEffects | None = None
    pages: PageRange = "all"

def run(ctx: OpContext, doc: DocHandle, p: RasterizeParams) -> OpResult:
    for i, page in ctx.progress(doc.pages(p.pages)):   # báo tiến độ, kiểm tra lệnh hủy
        ...
    return OpResult(changed_pages="all", warnings=[...])
```

| Thành phần | Vai trò |
|---|---|
| `id` | Tên ổn định, dạng `nhóm.việc`: `page.rotate`, `scan.rasterize`, `sign.pades`, `stamp.seam` (dấu giáp lai)… |
| `Params` | Model pydantic. Là **hợp đồng duy nhất** giữa UI, quy trình và lõi. Sinh JSON Schema và kiểu TypeScript bằng codegen |
| `run()` | Thực thi trên phiên tài liệu. Nhận `ctx` để báo tiến độ, kiểm tra hủy, ghi log |
| `preview()` *(tùy chọn)* | Chạy thử trên 1–2 trang để xem trước và ước tính (K5, K6, mọi task dialog) |
| `OpResult` | Trang nào đã đổi (để viewer chỉ vẽ lại trang đó), cảnh báo, file đầu ra |
| Thuộc tính | `destructive` (làm mất chữ ký, ví dụ raster hóa), `finalizing` (ký số), `batchable` |

**Lợi ích:**
- **Quy trình tự động (O1) = một danh sách `{op, params}`.** Chạy hàng loạt, thư mục tự động và dòng lệnh đều dùng cùng danh sách đó.
- **Thứ tự an toàn (O5, D10)** được kiểm tra một cách tổng quát: thao tác có cờ `destructive` không được đứng sau thao tác `finalizing`.
- **Kiểm thử dễ**: mỗi operation có test riêng với file PDF mẫu.

**Job runner:** mỗi lời gọi operation là một job có `jobId`. Tiến độ và cảnh báo được đẩy về UI qua sự kiện. Hủy được giữa chừng. Việc nặng (raster hóa 500 trang, rã tài liệu) chạy trong process pool để tận dụng nhiều nhân CPU.

---

## 4. Phiên tài liệu, lưu & hoàn tác

```
userData/sessions/<sessionId>/
├── meta.json            file gốc, thời điểm mở, trạng thái (đã ký? đã sửa?)
├── rev-0000.pdf         bản sao lúc mở
├── rev-0001.pdf         sau thao tác 1
├── rev-0002.pdf         ...
└── journal.jsonl        danh sách thao tác đã chạy {op, params, rev}
```

- **Không bao giờ sửa file gốc** cho tới khi người dùng bấm Lưu. "Lưu" ghi đè an toàn: ghi ra file tạm rồi đổi tên. "Lưu thành" ghi ra file mới.
- **Hoàn tác / Làm lại (A6)** bằng cách quay về bản sửa trước. Giữ tối đa N bản sửa (mặc định 50), bản cũ hơn thì gộp lại. Thao tác nhẹ như kéo đổi thứ tự trang được gom thành một bản sửa.
- **Khôi phục khi crash (A9):** khi mở app, phiên nào chưa đóng sạch sẽ được đề nghị khôi phục.
- **Sau khi ký số:** phiên chuyển sang trạng thái `signed`. Thao tác nào làm mất chữ ký sẽ bị chặn và có cảnh báo. Thao tác an toàn (ký thêm, thêm ghi chú nếu mức certify cho phép) thì ghi kiểu incremental.
- Viewer tải lại đúng các trang có trong `changed_pages` của bản sửa mới, không tải lại cả file.

---

## 5. Giao tiếp giữa các tiến trình

| Kênh | Cơ chế | Ghi chú |
|---|---|---|
| Renderer ↔ Main | `ipcRenderer.invoke` + sự kiện, qua `contextBridge` | API có kiểu: `chef.ops.run(id, params)`, `chef.files.open()`, `chef.jobs.on(...)` |
| Main ↔ Core | **JSON-RPC 2.0 qua stdin/stdout**, mỗi dòng một thông điệp | Không mở cổng mạng nên không phải xử lý tường lửa hay xác thực |
| Dữ liệu lớn (ảnh xem trước, file kết quả) | Ghi vào `userData/cache/`, chỉ truyền đường dẫn | Tránh đẩy base64 dung lượng lớn qua stdio |
| Chụp bằng điện thoại (L5) | Máy chủ HTTP tạm trong Main process, chỉ chạy khi đang chụp | Mã QR chứa token dùng một lần; tự tắt khi xong hoặc sau 10 phút |

**Vòng đời sidecar:** Main khởi động sidecar khi mở app, gửi `ping` để kiểm tra. Nếu sidecar chết thì tự khởi động lại và báo lỗi lên UI. Phiên tài liệu nằm trên đĩa nên không mất dữ liệu.

---

## 6. Giao diện

### Bố cục

```
┌────────────────────────────────────────────────────────────────────────────┐
│ ☰  Chef PDF   [hopdong.pdf ×] [baocao.pdf ×] [+]                 🔍 Ctrl+K │  ← tab tài liệu
├────────────────────────────────────────────────────────────────────────────┤
│ Xem │ Trang │ Chỉnh sửa │ Ghi chú │ Form │ Ký & Bảo mật │ Xuất │ Quy trình │  ← tab chức năng
│ [nút công cụ của tab đang chọn: tối đa ~8 nút, phần còn lại trong ▾]       │  ← toolbar ngữ cảnh
├──────────┬──────────────────────────────────────────────────┬──────────────┤
│ Thumbnail│                                                  │ Thuộc tính / │
│ Mục lục  │                Vùng xem trang                    │ tùy chọn của │
│ Lớp      │                                                  │ công cụ đang │
│ Chữ ký   │                                                  │ dùng         │
├──────────┴──────────────────────────────────────────────────┴──────────────┤
│ Trang 3/24 · 100% · ✅ 1 chữ ký hợp lệ                     ⏳ 2 việc đang chạy │  ← thanh trạng thái + job
└────────────────────────────────────────────────────────────────────────────┘
```

### Mẫu "Task dialog" (dùng cho mọi tính năng xử lý)

```
┌─ <Tên việc> ───────────────────────────────────────────┐
│ Preset: [ ▾ ]                                           │
│ 3–4 tùy chọn chính                                      │
│ ▸ Nâng cao                                              │
│ ┌─ Xem trước ─────────────┐  Ước tính: 2,4 MB · 8 giây  │
│ │  gốc | kết quả          │  ⚠ Cảnh báo (nếu có)        │
│ └─────────────────────────┘                             │
│ Áp dụng cho: ● File này  ○ Nhiều file…    [Hủy] [Làm]   │
└─────────────────────────────────────────────────────────┘
```

Mỗi task dialog cũng có nút **"Lưu thành bước quy trình"**, nhờ cơ chế operation ở mục 3.

### Hệ thống thiết kế
- **Design token** (màu, khoảng cách, bo góc, cỡ chữ) cho giao diện sáng và tối; mặc định theo hệ thống.
- **Thành phần nền:** Radix UI (truy cập bàn phím tốt) cùng style riêng; icon Lucide.
- **Font giao diện:** font tiếng Việt đóng gói sẵn (ví dụ Be Vietnam Pro, giấy phép OFL), không phụ thuộc font của máy.
- **Đa ngôn ngữ:** i18next, mặc định tiếng Việt. Chuỗi hiển thị không viết cứng trong code.
- **Trạng thái:** Zustand cho trạng thái UI; trạng thái tài liệu lấy từ lõi (lõi là nguồn sự thật duy nhất).

---

## 7. Dữ liệu, cài đặt & bảo mật

| Dữ liệu | Nơi lưu | Ghi chú |
|---|---|---|
| Cài đặt | `userData/settings.json` | Có số phiên bản để nâng cấp cấu trúc sau này |
| Mật khẩu PFX, khóa thư viện chữ ký | Electron `safeStorage` (dùng kho bảo mật của OS) | Không bao giờ ghi ra file dạng rõ |
| Thư viện ảnh chữ ký & con dấu (I-C) | `userData/library/`, mã hóa AES-GCM | Khóa nằm trong safeStorage. Tùy chọn hỏi Windows Hello / Touch ID (I23) |
| Mẫu chữ ký, preset, quy trình | `userData/library/*.json` | Xuất/nhập được |
| Phiên tài liệu | `userData/sessions/` | Tự dọn phiên cũ hơn 7 ngày |
| Log | `userData/logs/`, xoay vòng | Không ghi nội dung tài liệu, PIN hay mật khẩu |
| Tài nguyên đi kèm | `resources/`: font, Root CA, danh bạ driver token, danh sách TSA, preset, mô hình ONNX | Danh bạ driver và TSA cập nhật được (I4) |

**Bảo mật Electron:** bật `contextIsolation`, `sandbox`, tắt `nodeIntegration`, đặt Content Security Policy chặt, không nạp nội dung từ mạng vào cửa sổ chính. File PDF có JavaScript **không bao giờ được chạy**. Riêng pdf.js tắt hẳn scripting.

**PIN token:** chỉ giữ trong bộ nhớ trong một phiên ký. Không lưu PIN, không tự thử lại khi sai (I7).

---

## 8. Cấu trúc thư mục repo

```
powerpdf/
├── apps/
│   ├── desktop/                 Electron main + preload (TypeScript)
│   │   ├── src/main/            window, menu, sidecar, rpc-bridge, settings, updater, lan-capture
│   │   ├── src/preload/         contextBridge API
│   │   └── electron-builder.yml
│   └── ui/                      Renderer React (Vite + TypeScript)
│       └── src/
│           ├── app/             shell, routing, tabs, theme, i18n
│           ├── components/      design system
│           ├── features/        mỗi nhóm tính năng một thư mục: viewer, pages, scan, sign, stamp…
│           └── lib/             rpc client, kiểu sinh tự động, tiện ích
├── core/                        Python sidecar
│   ├── chef_core/
│   │   ├── rpc/                 JSON-RPC server, job runner
│   │   ├── session/             phiên tài liệu, bản sửa, journal
│   │   ├── ops/                 mỗi nhóm một module: page.py, scan.py, sign.py, stamp.py…
│   │   ├── pdf/                 lớp bọc pikepdf/pypdfium2, content engine
│   │   ├── imaging/             xử lý ảnh, OpenCV, ONNX
│   │   ├── signing/             PKCS#11, PAdES, appearance, validation
│   │   ├── layout/              rã tài liệu (N)
│   │   └── export/              docx, md, html, epub…
│   ├── tests/
│   └── pyproject.toml
├── packages/
│   └── contracts/               JSON Schema + kiểu TS sinh từ Params của operation
├── resources/                   fonts/ certs/ drivers/ tsa/ presets/ models/
├── scripts/                     dev, build, codegen, tạo bộ PDF mẫu
├── tests/
│   ├── corpus/                  PDF mẫu (sinh bằng script, không chứa tài liệu thật)
│   └── e2e/                     Playwright cho Electron
├── docs/                        NOTES, FEATURES, BLUEPRINT, TASKS, TOKENS
└── .github/workflows/           ci.yml, release.yml
```

---

## 9. Công nghệ & thư viện

Phiên bản cụ thể sẽ **chốt và ghim lại khi dựng khung** (T1.01), lấy bản ổn định mới nhất lúc đó.

| Lớp | Công nghệ | Giấy phép |
|---|---|---|
| Vỏ app | Electron, electron-builder, electron-updater | MIT |
| Giao diện | React, TypeScript, Vite, Zustand, Radix UI, Lucide, i18next | MIT / ISC |
| Xem PDF | pdf.js (`pdfjs-dist`) | Apache-2.0 |
| Quản lý gói | pnpm (Node), uv (Python) | MIT / Apache-2.0 |
| Lõi | Python 3.12+, pydantic | PSF / MIT |
| PDF | pikepdf (qpdf), pypdfium2 (PDFium) | MPL-2.0 / Apache-2.0, BSD |
| Ký số | pyHanko, python-pkcs11 (qua pyHanko), cryptography | MIT / MIT / Apache-2.0, BSD |
| Ảnh | Pillow, img2pdf, OpenCV (headless), ONNX Runtime | HPND / LGPL-3.0 / Apache-2.0 / MIT |
| Mã QR, mã vạch | segno, python-barcode | BSD / MIT |
| Xuất tài liệu | python-docx, openpyxl | MIT |
| Đóng gói lõi | PyInstaller (chế độ onedir) | GPL kèm ngoại lệ cho app đóng gói |
| Vẽ giao diện chữ ký, font | reportlab, fontTools | BSD / MIT |
| Kiểm thử | pytest, Vitest, Playwright, SoftHSM2 (token giả lập) | MIT / MIT / Apache-2.0 / BSD |
| Chất lượng code | ruff, mypy, ESLint, Prettier | MIT |

---

## 10. Kiểm thử

| Loại | Công cụ | Phạm vi |
|---|---|---|
| Unit test lõi | pytest | Mỗi operation có test trên bộ PDF mẫu. Mục tiêu: mọi operation đều có test |
| Ảnh chuẩn (golden) | pytest + so sánh ảnh có ngưỡng | Raster hóa, con dấu, chữ ký hiển thị, làm đẹp bản scan: so ảnh kết quả với ảnh chuẩn |
| Ký số | pytest + **SoftHSM2** + CA thử nghiệm tự tạo | Ký và kiểm tra lại bằng pyHanko trong CI, không cần token thật. Token thật thử bằng tay theo checklist |
| Kiểm tra chéo | Bằng tay | Mở file đã ký bằng Adobe Reader, Foxit, vSignPDF |
| Unit test UI | Vitest + Testing Library | Logic hiển thị, store, các tiện ích |
| End-to-end | Playwright cho Electron | Kịch bản chính của từng mốc (mục 13), chạy trên CI cho cả 3 OS |
| Hiệu năng | Script đo | File 1000 trang, file 300MB: thời gian mở, RAM, thời gian raster hóa |

**Bộ PDF mẫu** (`tests/corpus/`) được sinh bằng script: chữ tiếng Việt với nhiều font (có font chỉ nhúng một phần), nhiều cột, bảng, ảnh scan giả, form, file có mật khẩu, file đã ký, file hỏng có chủ đích. **Không đưa tài liệu thật** của chủ dự án vào repo.

---

## 11. Build, phát hành & cập nhật

- **CI (`ci.yml`)** chạy mỗi lần push: lint, kiểm tra kiểu, unit test lõi và UI trên Ubuntu; e2e trên cả 3 OS.
- **Release (`release.yml`)** chạy khi gắn tag `vX.Y.Z`. Build trên Windows, macOS (Intel và Apple Silicon), Linux:
  1. PyInstaller đóng gói lõi.
  2. electron-builder đóng gói app kèm lõi trong `resources/core/`.
  3. Đẩy bộ cài lên GitHub Releases.
- **Không ký mã** (D28). README ghi cách bỏ qua cảnh báo khi cài.
- **Tự cập nhật (A10):** Windows và Linux dùng electron-updater. macOS chỉ báo có bản mới và mở link tải. Repo đang để private nên cần quyết cách app đọc được release mà không phải nhét token GitHub vào app (xem câu hỏi CH2 ở TASKS.md).
- **Phiên bản:** đánh số theo SemVer. Mỗi mốc ở mục 13 là một bản minor: `0.1.0`, `0.2.0`…

---

## 12. Quy trình làm việc

- **Nhánh:** `main` luôn chạy được. Mỗi mốc có nhánh `milestone/v0.X`; mỗi task làm trên nhánh riêng rồi gộp vào nhánh mốc. *(Trong các phiên làm với Claude Code, có thể có nhánh do hệ thống chỉ định; khi đó tuân theo nhánh đó.)*
- **Commit:** tiếng Anh, thể mệnh lệnh, ghi mã task, ví dụ `T2.03: add scan effects`.
- **Definition of Done của một task:**
  1. Code có test.
  2. CI xanh.
  3. Chuỗi hiển thị có đủ tiếng Việt và tiếng Anh.
  4. Đã cập nhật trạng thái trong TASKS.md.
  5. Nếu có quyết định mới thì ghi vào NOTES.md.
- **Definition of Done của một mốc:**
  1. Mọi task xong.
  2. Kịch bản demo của mốc (mục 13) chạy được trên máy chủ dự án.
  3. Có bộ cài cho 3 OS.
  4. Chủ dự án dùng thử và đồng ý.
- **Hiệu chỉnh ước lượng:** sau mỗi mốc, so ước lượng với thực tế để điều chỉnh các mốc sau (mục 14).

---

## 13. Các mốc phát triển

Đã **chia lại các mốc** so với nhãn ban đầu trong FEATURES.md. Lý do: v0.4 cũ dồn 43 tính năng, quá nặng cho một mốc. Nhãn "Mức" trong FEATURES.md đã cập nhật theo bảng dưới (D29).

| Mốc | Tên | Tính năng | Kịch bản demo khi xong mốc |
|---|---|---|---|
| **v0.1** | Nền móng, xem & sắp xếp | A1–A8, B1–B7, C1–C5 | Cài app trên 3 OS. Mở PDF có mật khẩu, tìm "nghi dinh" ra "nghị định", ghép 3 file, kéo đổi thứ tự trang, xóa trang, hoàn tác, lưu |
| **v0.2** | ★ Bản scan | K1–K10 | File 50 trang chuyển thành bản scan 200 dpi xám có hiệu ứng, xem trước, file ra ≤ 5MB |
| **v0.3** | ★ Ký số | I1–I7, I10–I21, I23, I25–I32, I34, I35 | Cắm token thật, chẩn đoán xanh, tạo mẫu chữ ký có ảnh đã tách nền, ký theo chữ mốc "GIÁM ĐỐC" cho 10 file, Adobe Reader báo chữ ký hợp lệ |
| **v0.4** | Đóng dấu & đánh số | D1–D3, F1–F12, I8, I22, I33, I36 | Đánh số theo NĐ 30, đóng dấu giáp lai + chữ ký nháy + ký số trong một lần bấm, gỡ lại watermark đã thêm |
| **v0.5** | Bảo mật, tối ưu & chuyển đổi | A9, B8, B9, C6–C10, J1–J5, M1–M11 | Soi file, kiểm tra trước khi gửi, nén còn ≤ 2MB, tách thông minh theo trang trắng, app crash giữa chừng vẫn khôi phục được |
| **v0.6** | Bộ máy nội dung | D4–D7, E1–E5, J6 | Gỡ logo chìm trên mọi trang, tẩy một vùng, che số CCCD và kiểm chứng không copy ra được chữ bên dưới |
| **v0.7** | Sửa chữ & ghi chú | D8–D11, G1–G5 | Sửa một câu tiếng Việt trong hợp đồng, thay tên công ty toàn tài liệu, highlight và ghi chú |
| **v0.8** | Ảnh scan & chụp sách | L1–L6, L9–L20 | Chụp 20 trang sách bằng điện thoại qua QR, tự dò viền, tách trang đôi, làm phẳng, xóa ngón tay, ra PDF đẹp |
| **v0.9** | Form & quy trình tự động | A10, H1–H3, O1–O8 | Tạo quy trình "Nộp hồ sơ online", thả 20 file vào thư mục tự động, lấy kết quả đã ký |
| **v0.10** | Rã tài liệu | D12, N1–N7 | Rã một báo cáo 2 cột có bảng thành Word "giữ bố cục" và Markdown |
| **v1.0** | Ổn định & hoàn thiện | (không thêm tính năng) | Dùng hằng ngày một tuần không gặp lỗi nghiêm trọng |

```
v0.1 ──► v0.2 ──► v0.3 ──► v0.4 ──► v0.5 ──► v0.6 ──► v0.7 ──► v0.8 ──► v0.9 ──► v0.10 ──► v1.0
nền móng  scan    ký số    đóng dấu  bảo mật  nội dung  sửa chữ  ảnh scan quy trình rã tài liệu ổn định
```

**Phụ thuộc chính:**
- v0.4 cần thư viện ảnh của v0.3 (I-C) cho con dấu ảnh và giáp lai, và cần engine ký cho I33.
- v0.6 là nền cho v0.7. Spike S2 ở v0.1 sẽ giảm rủi ro sớm.
- v0.9 (quy trình) cần các operation của v0.2–v0.8 đã có.
- v0.10 dùng lại mô hình chữ của v0.7.

---

## 14. Ước lượng

**Đơn vị: điểm công sức. 1 điểm ≈ 1 ngày làm của một lập trình viên có kinh nghiệm.** Claude viết phần lớn code nên thời gian lịch thực tế có thể ngắn hơn. Nhưng review, chạy thử và sửa theo phản hồi vẫn mất thời gian, nên **dùng điểm để so sánh độ nặng giữa các phần**, và sau v0.1 sẽ đo tốc độ thật để quy ra lịch.

| Mốc | Điểm | Ghi chú |
|---|---|---|
| v0.1 | 42 | Gồm toàn bộ nền móng (kiến trúc, đóng gói 3 OS, test) |
| v0.2 | 10,5 | |
| v0.3 | 31,5 | Rủi ro cao nhất: token, driver, tương thích Adobe. Cộng 2–3 điểm nếu driver token không chạy trên macOS/Linux |
| v0.4 | 24 | |
| v0.5 | 21,5 | |
| v0.6 | 21,5 | Spike S2: thư viện giấy phép thoáng đủ sức, có vài bẫy cần xử lý |
| v0.7 | 21 | Rủi ro: font tiếng Việt khi sửa chữ |
| v0.8 | 32 | Nhiều thuật toán ảnh |
| v0.9 | 19,5 | |
| v0.10 | 24,5 | |
| v1.0 | 14 | |
| **Tổng** | **262** | Cộng dự phòng 20% thì khoảng **315 điểm**. Sau spike: v0.3 −0,5, v0.6 +0,5 |

Chi tiết từng task ở [TASKS.md](TASKS.md).

---

## 15. Rủi ro & cách giảm

| # | Rủi ro | Ảnh hưởng | Khả năng | Cách giảm |
|---|---|---|---|---|
| R1 | Driver USB token Việt Nam không chạy trên macOS/Linux, hoặc PKCS#11 có hành vi lạ | Cao | Cao | Spike S1 với SoftHSM2: pyHanko làm được mọi kiểu ký cần thiết ([báo cáo](spikes/S1-pkcs11.md)). **Còn chờ thử token thật** bằng `spikes/s1_token_probe.py`. Màn hình chẩn đoán (I6); đường dự phòng qua kho chứng thư OS (I8) |
| R2 | pypdfium2/pikepdf không đủ sức cho sửa đối tượng và sửa chữ | Cao | ~~Trung bình~~ **Thấp** | ✅ **Spike S2 đã kiểm chứng**: sửa/xóa đối tượng, gỡ watermark, che thông tin mật thật, sửa chữ thiếu glyph (fontTools) đều chạy. Giữ D7. Xem [spike S2](spikes/S2-content-editing.md) |
| R3 | Sửa chữ tiếng Việt thiếu glyph trong font đã nhúng | Trung bình | Cao | Thay font gần giống; đóng gói font Unicode; báo rõ cho người dùng |
| R4 | Adobe Reader không công nhận chữ ký / giao diện chữ ký | Cao | Trung bình | Kiểm tra chéo ở mỗi bản (T3.14); bám chuẩn PAdES; dùng bộ kiểm tra của pyHanko |
| R5 | Bộ cài nặng, sidecar khởi động chậm | Thấp | Trung bình | PyInstaller onedir; nạp thư viện nặng (OpenCV, ONNX) khi cần mới nạp; đo ở T1.06 |
| R6 | Hiệu năng với file lớn (1000+ trang) | Trung bình | Trung bình | Ảo hóa viewer; xử lý theo luồng; process pool; benchmark ở v1.0 |
| R7 | Giấy phép mô hình DocAligner không phù hợp | Thấp | Trung bình | Kiểm tra ở T8.05; nếu không ổn thì chỉ dùng thuật toán L15 |
| R8 | Phạm vi phình to (đã thêm nhiều tính năng sau khi chốt) | Trung bình | Cao | Mọi thay đổi ghi vào "Thay đổi sau khi chốt"; ước lượng lại trước khi nhận thêm |
| R9 | Tự cập nhật macOS không chạy vì app không ký | Thấp | Chắc chắn | Đã chấp nhận: macOS chỉ báo có bản mới (D28) |
