# Chef PDF: Kế hoạch bản 1.1

> Ngày 2026-11-04. **Trạng thái: đã duyệt phạm vi** (chủ dự án trả lời ngày 2026-11-04, mục 1). Mã tính năng mới đã đưa vào FEATURES.md (mức v1.1). Mọi thay đổi phạm vi sau này ghi vào NOTES và FEATURES. Đi kèm [PLAN_V1.md](PLAN_V1.md) (bản 1.0), [FEATURES.md](FEATURES.md) (mã chính thức) và [ABBYY_FineReader_15_PDF_Editor_Blueprint.md](ABBYY_FineReader_15_PDF_Editor_Blueprint.md) (chuẩn giao diện sửa chữ).

## 1. Quyết định đã chốt

| Câu hỏi | Trả lời | Hệ quả trong kế hoạch |
|---|---|---|
| 1. File từ bản cài v1 | Để trong `docs/` | Dùng làm đầu vào tái hiện B1 (mục 2). Không commit, vì là tài liệu thật |
| 2. Thay đổi `CHEF_E2E` | Tự sửa rồi commit | Đã commit `6c97168` (mục 2.4) |
| 3. So sánh chữ (P1) | Không | P1 ở "Sau 1.0" |
| 4. Quét từ máy quét (A15) | Không | Không đưa vào 1.1 |
| 5. Thanh bên | Không đổi (hiện theo ngữ cảnh) | Giữ B3 như hiện tại |
| 6. OCR | Đúng, để nhóm Q | Ngoài 1.1 |
| 7. Sửa lỗi trước, tính năng sau | Đúng | Phase 0 trước mọi tính năng |
| 8. Kiểm tay chữ ký với Adobe/Foxit (T3.08, T3.14) | Sau 1.1 | Không chặn 1.1 |
| 9. Giấy phép LGPL (img2pdf, FFmpeg) | Chấp nhận | `NOTICE` đã ghi cả hai (mục 3, N8 đóng) |
| 10. PDF/A (M12) và nén MRC | Để ngoài | U12, U13 ngoài 1.1 |
| 11. Ưu tiên sửa chữ PDF | Sửa cho đúng blueprint ABBYY | Mục 5 là hạng mục tính năng đầu tiên của 1.1 |

Hai điều chưa có trả lời được ghi ở mục 7.

## 2. Phase 0: hai lỗi báo cáo ở bản 1.0

### 2.1 Hai lỗi và cách hiểu hiện tại

Nguồn duy nhất là các chú thích "bug report 2026-11-04" trong spec và NOTES. Cách hiểu phải được chủ dự án xác nhận (mục 7, câu 1 và 2).

| Mã | Lỗi báo cáo | Cách hiểu hiện tại |
|---|---|---|
| **B1** | Chuyển thành bản scan, lưu, đóng, mở lại: file vẫn còn chữ | Sau khi mở lại, file không được còn ký tự nào |
| **B2** | Chuột không cuộn file dài mở từ dòng lệnh; và không cuộn sau lần mở thứ hai | Lăn chuột phải cuộn trang trong mọi trường hợp đó |

### 2.2 Kết quả thử ngày 2026-11-04 (bản đóng gói `chef-pdf.exe`, build 11:35)

Bản đóng gói được xác nhận chạy đúng (`process.execPath` là `win-unpacked\chef-pdf.exe`, `isPackaged = true`), dùng lõi đóng gói.

| Thử | Đầu vào | Kết quả |
|---|---|---|
| B1, lõi đóng gói, các bước dựng lại: chuyển bản scan (mặc định), Ctrl+S, đóng, mở lại | File của chủ dự án (5 trang, 11.509 ký tự) | **Không tái hiện**: sau khi mở lại còn 0 ký tự. File kết quả không còn annotation nào |
| B2, CDP, cuộn 800 px | `long.pdf` từ dòng lệnh | Cuộn (20 → 820) |
| B2, CDP | `scan_long.pdf` từ dòng lệnh | Cuộn (20 → 820) |
| B2, CDP, lần mở thứ hai (3 tab: Start + 2 file) | `scan_long.pdf` rồi `long.pdf` | Cuộn (20 → 820) |
| B2, **chuột thật của Windows** (`mouse_event`), cửa sổ có focus | `long.pdf`, `scan_long.pdf`, lần mở thứ hai | Cuộn cả ba |
| B2, chuột thật, **cửa sổ khác đang ở trên** | — | **Chưa chạy.** Lệnh bị bộ phân loại an toàn chặn vì sẽ đưa cửa sổ khác lên và dừng tiến trình Notepad của người dùng. Xem mục 7, câu 2 |

Kết quả ngày 2026-11-05 (bản đóng gói build lại sau commit 1.0 mới nhất, `chef-pdf.exe`):

| Thử | Kết quả |
|---|---|
| B1, dev: spec `b1-in-session` (bản sao đã ký → scan → lưu → mở lại) | 0 ký tự, đạt |
| B1, bản đóng gói: cùng spec, `CHEF_E2E_EXE` (đã kiểm: đường dẫn exe giả làm spec lỗi) | 0 ký tự, đạt |
| B1, bản đóng gói: `repro-local` với file thật của chủ dự án (không commit) | 11.509 → 0 ký tự, đạt |
| B1, dev: bản sao đã ký theo đường lệnh | chưa chạy, vì các đường trên đã đủ |
| B2 | không chạy lại (cửa sổ khác ở trên cần chủ dự án cho phép) |

Kết luận: **B1 không tái hiện trên cả dev lẫn bản đóng gói, qua cả đường bản sao đã ký lẫn file gốc.** Không đoán nguyên nhân; chờ chủ dự án trả lời câu 1 (các bước chính xác) để dựng lại đúng.

### 2.3 Quan sát về file của chủ dự án (không phải nguyên nhân đã xác nhận)

- Tên `…_daky_ban-sao.pdf` khớp với `editableCopy` (`apps/ui/src/features/pages/pageActions.ts:87`): tạo bản sao chưa ký của tài liệu đã ký bằng `page.extract` (D38). Mtime của file (12:08) cho thấy không có lần lưu nào ghi đè lên bản sao sau khi tạo.
- Bản sao vẫn giữ **5 widget chữ ký** (`/FT /Sig`, có `/V` và `/AP`) ở trang 1 và 5, dù `AcroForm` không tham chiếu. Chưa kiểm xem giao diện có hiện các khung chữ ký đó hay không. Nếu có, bản sao "chưa ký" trông như đã ký. Cần kiểm trên app (mục 5.6, kiểm tra).
- Spec hồi quy hiện có (`scan-save-reopen.spec.ts`) dùng fixture chưa ký và Ctrl+S trên tab gốc, nên không đi qua đường `editableCopy`.

### 2.4 Đã làm: harness E2E (commit `6c97168`)

- Cửa sổ test vẫn ngoài màn hình và không lấy focus (`CHEF_E2E=1`). Hai spec cuộn chuột mở cửa sổ hiển thị thật qua `LaunchOptions.visible` (`CHEF_E2E_SHOW=1`).
- Đã kiểm: `wheel` và `wheel-second-instance` 3/3 với cửa sổ hiển thị; `keyboard`, `smoke`, `integration`, `page-menu`, `capture`, `tools5-pages` 26/26 với mặc định ngoài màn hình. Typecheck, eslint, prettier sạch.
- Spec tái hiện `tests/e2e/specs/repro-local.spec.ts` **chưa commit**: đọc file của chủ dự án từ biến môi trường `CHEF_REPRO_PDF`, và chạy bản đóng gói qua `CHEF_REPRO_EXE`. Không chứa dữ liệu của chủ dự án.

### 2.5 Việc còn lại của Phase 0

1. Chủ dự án xác nhận các bước của B1 và B2 (mục 7, câu 1, 2).
2. Nếu bước đúng đã có mà vẫn không tái hiện: xin ảnh chụp màn hình lúc lỗi, rồi kiểm lại trước khi sửa.
3. Khi tái hiện được: viết test đỏ trên bản đóng gói, sửa, test xanh, chủ dự án xác nhận trên bản cài mới.

## 3. Nợ của 1.0

| Mã | Việc | Trạng thái | Ghi chú |
|---|---|---|---|
| N1 | Ký thử với Adobe Reader/Foxit, ảnh chụp (T3.14) | **Sau 1.1** (câu 8) | Chủ dự án làm tay |
| N2 | Kiểm tay panel kiểm tra chữ ký và thư viện ảnh chữ ký (T3.08) | **Sau 1.1** (câu 8) | Chủ dự án làm tay |
| N3 | Worker của process pool không chạy trong bản đóng gói | Mở | Hiện tắt pool trong bản đóng gói (D43), đo tuần tự 40 trang 200 dpi 1,0 s. Tìm nguyên nhân hoặc gỡ hẳn nhánh pool |
| N4 | Phần còn mở của xóa ngón tay: `remove_fingers` chưa nhận viền trang đã dò; bàn trắng làm vùng "trong mép" phủ cả khung | Mở | Hai lỗi cùng ngày đã sửa: `978ad4e`, `a2ee865` |
| N5 | Hai ô Đóng dấu và Nén trên Start chưa có e2e (đã sửa "Sắp có" ngày 2026-11-03) | Mở | Viết e2e đi qua hộp thoại thật |
| N6 | Xuất Markdown/HTML có ảnh vào tên đã có thư mục ảnh vẫn bị từ chối | Mở | Cho chọn thư mục khác hoặc xác nhận thay thư mục |
| N7 | Đo cuộn bằng chuột chưa có trong T11.02 (chỉ có PageDown) | Một phần | CDP đã đo (mục 2.2); đo trên bản đóng gói khi làm Phase 0 |
| N8 | Giấy phép | **Đóng** | `NOTICE` ghi img2pdf (LGPL-3.0) và opencv kèm FFmpeg (LGPL-2.1). Chủ dự án chấp nhận (câu 9). DocAligner: giấy phép mã vẫn ghi "chưa đối chiếu" trong NOTICE, nên mục này chỉ đóng phần LGPL |
| N9 | Số liệu lệch: "26 🔄" trong NOTES và PLAN_V1 | **Đóng** | Đã sửa về 116 ✅, 3 ⏸ (T3.08, T3.14, T9.08) |
| N10 | Chủ dự án "dùng hằng ngày một tuần" (5.6 PLAN_V1) | Mở | Lỗi tìm được ghi vào NOTES |
| N11 | Ghi chú cũ: Start có hai ô "Sắp có" (N5) | Mở | Gộp với N5 |

Các mục chỉ dùng được ở Linux/macOS (PLAN_V1 "Sau 1.0") vẫn để ngoài 1.1 theo D37.

## 4. Phase 2 (ngoài sửa chữ): khoảng cách so với ABBYY

Đối chiếu blueprint với FEATURES. Mã mới nối tiếp dãy FEATURES (mục 4.1). Mã quyết định D13, D14 trong NOTES là khác, không liên quan.

| # | Điểm blueprint | Trạng thái 1.1 | Mã |
|---|---|---|---|
| U1 | Chế độ rõ **xem / chọn / chỉnh sửa** (§5.1, §9.3) | **Trong 1.1** | B11 |
| U2 | **Chỉ báo lớp chữ** trên thanh dưới (§4.2) | **Trong 1.1** | B12 |
| U5 | **Bảng thuộc tính** theo đối tượng (§9.2) | **Trong 1.1** | D13 |
| U6 | **Hàng định dạng chữ** cố định (§5.1) | **Trong 1.1**, là phần của mục 5 | D14 |
| U3 | Panel ghi chú: tìm, sắp xếp, mở rộng, điều hướng (§6.3) | Chờ xác nhận. Đề xuất làm sau mục 5 | G4 mở rộng |
| U4 | Thanh bên có biểu tượng cố định (§4.1) | **Không làm** (câu 5) | — |
| U7 | Thanh hành động khi chọn nhiều trang; panel đổi cỡ (§6.1) | Chờ xác nhận | C15 (đề xuất) |
| U8 | Tìm trong danh sách gần đây (§3.2) | Chờ xác nhận | A1 mở rộng |
| U9 | Quét từ máy quét | **Không làm** (câu 4) | — |
| U10 | So sánh chữ (P1) | **Không làm** (câu 3) | — |
| U11 | Xem trước phạm vi trước khi che (§8.2) | Chờ kiểm trong code (J6) | J6 mở rộng nếu thiếu |
| U12 | PDF/A (M12) | **Không làm** (câu 10) | — |
| U13 | Nén MRC | **Không làm** (câu 10) | — |

### 4.1 Mã mới (đã ghi vào FEATURES.md, mức v1.1)

| Mã | Tính năng | Ghi chú |
|---|---|---|
| B11 | Chế độ Xem / Chọn / Chỉnh sửa | Trạng thái rõ trên thanh công cụ và con trỏ; khóa thao tác sửa khi đang xem |
| B12 | Chỉ báo lớp chữ | Thanh dưới: có chữ, không có chữ (bản scan), hoặc hỗn hợp. Cũng dùng để kiểm B1 |
| D13 | Bảng thuộc tính đối tượng | Panel phải: thuộc tính của đối tượng đang chọn (chữ, ảnh, ghi chú, chữ ký) |
| D14 | Hàng định dạng chữ cố định | Hàng dưới thanh công cụ PDF khi chỉnh chữ, đặc tả ở mục 5 |

## 5. Sửa chữ PDF theo blueprint ABBYY (ưu tiên 1 của 1.1)

### 5.1 Nguyên tắc

- Những gì blueprint **đã thấy trên UI** (§5.1–5.3, §9.3) phải khớp đúng.
- Những gì blueprint đánh dấu **"chưa thử"** (§5.4) không thể đặc tả từ blueprint. Giữ hành vi hiện tại của Chef và đưa vào danh sách kiểm (5.6).
- Mọi thay đổi làm trên tài liệu phải là một operation trong lõi (BLUEPRINT mục 3). Giao diện không sửa PDF trực tiếp.

### 5.2 So sánh blueprint với Chef hiện tại

| # | ABBYY (blueprint) | Chef hiện tại (mã) | Việc trong 1.1 | Loại |
|---|---|---|---|---|
| R1 | Một nút **Chỉnh sửa** trên hàng công cụ nội dung (§5.1) | Hai lệnh: `edit.textEdit` (dòng) và `edit.textParagraph` (đoạn), `commands.tsx` ~850–870, `Toolbar.tsx:269–277` | Gộp thành một chế độ Chỉnh sửa. Khung chọn là một khối (block) từ lõi | UI, quyết định Q-b |
| R2 | Khung chữ được chọn có **viền xanh và tay nắm** (§5.1) | Viền 2 px (`.tedit-box--selected`, `textedit.css:22`), không có tay nắm | Viền giữ nguyên. Tay nắm chờ quyết định Q-c | quyết định |
| R3 | **Hàng định dạng** cố định dưới hàng công cụ PDF, hiện khi chỉnh chữ (§5.1) | Hộp đoạn nổi (`ParagraphEditor`, `role="dialog"`) cạnh đoạn, chỉ khi bấm nút đoạn | Thay bằng hàng cố định. Bỏ hộp nổi | UI |
| R4 | Hàng gồm: **Thêm văn bản**, font, cỡ, tăng/giảm cỡ, đậm, nghiêng, căn lề, thụt lề/khoảng cách, màu (§5.1) | Hộp đoạn có căn lề, cỡ, đậm, nghiêng, màu, khoảng cách dòng. **Không có** ô font trong hộp đoạn; không có tăng/giảm cỡ; **không có** thụt lề trong operation. Thêm văn bản là lệnh riêng (D1) | Thêm ô font, tăng/giảm cỡ, nút Thêm văn bản vào hàng. Thêm tham số thụt lề vào operation (5.3) | UI, core |
| R5 | Ba trạng thái rõ: xem / chọn / chỉnh sửa (§9.3) | Có `tool` (chọn/cầm tay) và cờ `text.active`; không hiện trạng thái | B11 | UI |
| R6 | Chọn khung → định dạng hiện → chỉnh tại chỗ → lưu (§5.3) | Double-click hoặc Enter mở ô sửa trên dòng; Áp dụng hoặc Enter ghi (`TextEditLayer.tsx:openEditor`) | Giữ luồng. Đổi đơn vị chọn thành khối | UI |
| R7 | Chỉnh định dạng **tại chỗ** (§5.3, bước 4) | Định dạng chỉ áp khi bấm Áp dụng trong hộp đoạn (`text.styleParagraph`) | Quyết định Q-d | quyết định |

### 5.3 Lõi: operation thụt lề

- `text.styleParagraph` và `text.editParagraph` (`core/chef_core/ops/text_paragraph.py`, `_StyleFields`) đã có: `font_name`, `align`, `line_spacing`, `font_size`, `color`, `bold`, `italic`, `box_width`.
- **Thiếu: thụt lề dòng đầu** (`indent`). Lõi đã có `para.indent` nội bộ (`core/chef_core/text/paragraph.py:415`) nhưng không có tham số. Đề xuất thêm `indent` (pt, hoặc `keep`) vào `_StyleFields`, có test lõi.
- Đề xuất có kèm: ô chọn font trong hàng định dạng dùng lại `font_name` đã có (không cần lõi mới).

### 5.4 Quyết định chờ chủ dự án

- **Q-b. Một chế độ hay hai lệnh?** Đề xuất: một chế độ Chỉnh sửa; khung là khối từ lõi. Dòng đơn vẫn sửa được trong ô nhập của khung. **Đã chọn theo đề xuất (D53); chủ dự án có thể đổi.**
- **Q-c. Tay nắm khung.** Blueprint không nói tay nắm làm gì. Trợ giúp ABBYY cài trên máy chỉ có danh mục chủ đề (`help.fineReader.xml`); nội dung chủ đề là bản trực tuyến, nên không đọc được offline. **Đề xuất: không làm tay nắm trong 1.1** (không làm trang trí). **Đã chọn theo đề xuất (D54).** Chủ dự án thử ABBYY một lần: kéo tay nắm thì đổi cái gì (chiều rộng khung, cỡ chữ, hay vị trí)? Báo lại để đặc tả.
- **Q-d. Áp dụng định dạng ngay hay khi bấm Áp dụng?** Đề xuất: nút định dạng **áp dụng ngay**, mỗi lần đổi là một revision, hoàn tác bằng Ctrl+Z (D32). Nội dung chữ vẫn ghi bằng Enter hoặc Áp dụng như hiện nay. Lý do: blueprint §5.3 nói "chỉnh nội dung và định dạng tại chỗ". **Đã chọn theo đề xuất (D55); chủ dự án có thể đổi.**
- **Q-e. Thụt lề trong 1.1?** Đề xuất: có (5.3). **Đã chọn theo đề xuất (D56); chủ dự án có thể đổi.**

### 5.5 Giữ nguyên, đã có

Sửa chữ mức dòng và đoạn (D8, D9; T7.02, T7.03), tự thay font khi thiếu ký tự (T7.02), tìm và thay (D10), cảnh báo tràn và khối đè (T7.03).

### 5.6 Danh sách kiểm (blueprint "chưa thử", giữ hành vi hiện tại)

Kiểm trên bản sao PDF của chủ dự án, không sửa file gốc:

1. Chọn một từ, một dòng, cả đoạn, cả khung: khung thay đổi thế nào?
2. Thêm hoặc bớt chữ có tự chảy lại không? Khi tràn trang thì sao?
3. Chữ có phải là lớp chữ có sẵn, OCR, hay một khối mới?
4. Đổi font, cỡ, căn lề có làm lệch bố cục, dấu tiếng Việt hoặc bảng không?
5. Hoàn tác có hoàn tác được nội dung, định dạng và di chuyển không?
6. Lưu đè và lưu bản sao có giữ tìm kiếm, copy, bookmark, tag, comment không?
7. **Bản sao từ "Tạo bản sao để sửa" còn các widget chữ ký (mục 2.3) không? Khung chữ ký có hiện trên app không?**
8. **Đoạn một dòng không có căn lề đọc được** (D58): hàng định dạng hiện "Căn lề" chưa biết, không hiện "Trái". Cần cách lưu căn lề thật nếu muốn hiện lại.

### 5.7 Demo v1.1 (sửa chữ)

Trên bản cài 1.1, với một PDF có chữ:

1. Bấm **Chỉnh sửa** một lần. Trạng thái hiện là Chỉnh sửa; thanh dưới hiện "có chữ".
2. Bấm một đoạn: khung xanh; hàng định dạng hiện đủ điều khiển của R4.
3. Đổi cỡ chữ, căn giữa, in đậm; Ctrl+Z hoàn tác từng bước.
4. Sửa một câu tiếng Việt có dấu, Enter; lưu; mở lại: câu đúng, dấu đúng.
5. `ui-audit` phủ hàng định dạng (D41).

Kiểm bằng e2e với lõi thật (bản đóng gói ở cổng 1.1).

## 6. Định nghĩa xong và cổng 1.1

Giữ định nghĩa xong của PLAN_V1 (mục 3): (a) test lõi hoặc giao diện cho hành vi chính và lỗi chính; (b) ít nhất một e2e với lõi đóng gói cho mỗi lỗi báo cáo và mỗi tính năng mới; (c) typecheck, lint, ruff, mypy, test xanh trên Windows; (d) quyết định mới vào NOTES; (e) TASKS cập nhật, thay đổi phạm vi vào FEATURES.

**Demo v1.1 tổng:** mục 5.7, cộng: (i) B1 và B2 đóng bằng test hồi quy trên bản đóng gói (mục 2.5); (ii) B11, B12, D13, D14 đạt tiêu chí của chúng.

## 7. Câu hỏi còn mở

1. **B1, các bước chính xác:** bạn bấm gì để chuyển (mặc định hay chọn trang, bấm Ctrl+S hay nút Lưu), đóng bằng cách nào, mở lại bằng cách nào (Explorer, danh sách gần đây, hay lần mở tiếp theo của app), và chữ "còn" ở đâu: tìm được bằng Ctrl+F, copy được, hay chỉ thấy trên hình?
2. **B2, trạng thái cửa sổ lúc lỗi:** cửa sổ Chef đang ở trên hay đang ở dưới app khác? Bạn có cho phép tôi chạy thử kịch bản "cửa sổ khác đang ở trên" không? Lần chạy này sẽ đưa Notepad lên và di chuyển chuột, nên cần bạn cho phép rõ ràng và tốt nhất là đang ngồi trước máy.
3. **Q-c (tay nắm):** bạn thử ABBYY một lần và cho biết kéo tay nắm khung làm gì.
4. **Q-b, Q-d, Q-e:** đã chọn theo đề xuất ở 5.4 (D53, D55, D56). Chủ dự án có thể đổi.
5. **U3, U7, U8, U11:** có đưa vào 1.1 không? Mặc định: không, làm sau mục 5.
