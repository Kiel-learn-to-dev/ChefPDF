# Chef PDF: Chia việc vỏ Rust + GPUI (TASKS_RUST)

> **Mục tiêu phiên bản 1.4 = bản Rust đầu tiên, ngang với 1.3.0 Electron (D77).** "Xong 1.4" là đủ 165 mã tính năng trong phạm vi và có bản build chạy thử. Bảng M1–M9 là cách chia việc, không phải phiên bản.
>
> **Phiên bản 0.2 (2026-11-11; 0.1 ngày 2026-11-08).** Bản 0.2 đổi thứ tự làm (D86, mục "Thứ tự làm tiếp"), gỡ phụ thuộc giả và vòng, thêm R1.43 và R2.33; chi tiết ở "Thay đổi sau khi chốt". Đi kèm [BLUEPRINT_RUST.md](BLUEPRINT_RUST.md) (thiết kế, cùng số mục với BLUEPRINT.md) và [PLAN_RUST.md](PLAN_RUST.md) (thứ tự mốc). **File này là nguồn trạng thái duy nhất cho việc vỏ Rust.** PLAN_RUST chỉ trỏ về đây.
> **Cập nhật cột "Trạng thái" mỗi khi xong một task.** ⬜ chưa làm · 🔄 đang làm · ✅ xong · ⏸ tạm dừng · ❌ bỏ
> **Mã task:** `R<mốc>.<số>`, ví dụ `R1.07` là task 7 của M1. Mốc M5 chia thành 5a–5f và đánh số liền `R5.01…R5.45`. Mã `T<mốc>.<số>` trong [TASKS.md](TASKS.md) không bị ảnh hưởng.
> **Kích thước:** XS (1 file), S (1–2), M (3–5), L (5–8). Không có XL: task lớn hơn đã được tách. **Điểm (points) để trống (—)** đến khi xong M1, theo BLUEPRINT_RUST §14.
> **Lõi Python và hợp đồng JSON-RPC không đổi.** Task nào đụng `core/` hay `packages/` phải chạy thêm pytest và E2E Electron để chứng minh bản 1.3 không hỏng.

## Định nghĩa "xong" (áp dụng cho mọi task)

Đây là chuẩn chung, không lặp lại trong từng task. Điều chỉnh từ nguyên tắc 3 của [PLAN_V1.md](PLAN_V1.md).

- **(a)** Có test Rust đơn vị, hoặc E2E qua kênh debug (R1.07), cho hành vi chính và lỗi chính.
- **(b)** Nếu task chạm lõi: có E2E với lõi thật.
- **(c)** `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test`, `cargo deny check` xanh trên Windows. Nếu đụng `core/` hoặc `packages/`: thêm pytest lõi và `pnpm typecheck` xanh.
- **(d)** Quyết định mới ghi vào [NOTES.md](NOTES.md) (từ D74 trở đi).
- **(e)** Cập nhật trạng thái trong file này.
- **(f)** Task thuộc tính năng: ghi mã trong dòng "Tính năng" và đối chiếu với [FEATURES.md](FEATURES.md).

Checkpoint sau mỗi 2–3 task và cuối mỗi mốc là **điểm kiểm** để xem lại kế hoạch, không phải cổng dừng. Trong mốc M1, điểm kiểm cuối có báo cáo RAM và danh sách "đã kiểm / chưa kiểm", rồi chỉnh M2–M9 theo kết quả.

## Quyết định cần chủ dự án (không chặn M1)

| # | Câu hỏi | Chặn task | Đề xuất |
|---|---|---|---|
| CH-R1 | **Chuyển trang web sang PDF** (`web2pdfRender.ts` dùng `printToPDF` của Chromium, bản Rust không có Chromium). Chọn một: (a) giữ một tiến trình Electron nhỏ, chỉ chạy khi dùng tính năng này; (b) dùng WebView2 có sẵn của Windows qua CDP; (c) bỏ tính năng, ghi vào "Thay đổi sau khi chốt" của FEATURES | R5.16 (❌) | **Đã chốt (c), 2026-11-09:** bỏ tính năng, ghi FEATURES M5 và D78 |
| CH-R2 | Độ tương phản của token (D72): có đổi màu `--c-text-3`, `--c-success`, `--c-warning` khi chữ không đạt 4,5:1 không | Không chặn; quyết định ở M9 | Giữ nguyên, ghi nhận |
| CH-R3 | Lọc `invert` của trang đọc tối và `grayscale` trong Start (`StartScreen.css`) | R2.28, R2.16 | **Đã chốt:** đảo màu bitmap trên CPU (D79); giữ `grayscale(0.6)` và `opacity: 0.7` chỉ trên icon của ô bị vô hiệu hóa `.tile.is-disabled .tile__icon`, không lọc toàn màn hình. |
| CH-R4 | `cargo deny check` từng đỏ vì 10 cảnh báo unmaintained từ phụ thuộc bắc cầu của GPUI. Các ID đã kiểm tra lại ngày 2026-11-14; đều là advisory unmaintained, không phải vulnerability/unsound. | Không chặn tính năng; được chốt D90 | **Đã chốt 2026-11-14:** chủ dự án chọn ignore đúng 10 ID, mỗi ID có lý do trong `apps/native/deny.toml`; rà lại khi nâng GPUI hoặc advisory thay đổi (D90) |

## Việc thủ công của chủ dự án

Gom ở đây để không chặn việc tự động. Mỗi việc ghi rõ task cần nó.

| Mã | Việc | Task | Vì sao không tự động hóa được |
|---|---|---|---|
| MAN-1 | Gõ Telex bằng bộ gõ Windows và bằng Unikey/EVKey trong ô "Tìm trong tài liệu" của viewer (Ctrl+F, ô nhập R1.22; app chưa có khung ghi chú); báo đúng/sai dấu, có mất ký tự không. **Lần đầu (R1.26, R1.27) làm ngay:** ô nhập R1.22 đã có, kết quả quyết định có phải làm R1.24 và R1.25 không | R1.26, R1.27, R7.09 | Cần bộ gõ thật của máy chủ dự án. (2026-11-14) Chủ dự án hiện chưa thể thử trên Windows; chưa có kết quả để quyết định R1.24/R1.25. |
| MAN-2 | Ký thật bằng token Viettel-CA; mở bằng Adobe Reader và Foxit kiểm tra chữ ký | R6.18, R6.19 | Token vật lý, phần mềm đọc PDF bên ngoài |
| MAN-3 | Chụp bằng điện thoại qua mã QR (cùng Wi-Fi) | R8.07, R8.08 | Điện thoại thật |
| MAN-4 | Đồng ý dùng cửa sổ hiện khi R1.08 và R1.09 đều không đạt (quy tắc E2E nền trong memory) | R1.10 | Quyết định về cách chạy kiểm thử |
| MAN-5 | Xem ảnh so sánh ui-audit mỗi checkpoint (R2.02) và chốt "đạt hình họa" | Mỗi checkpoint | Phán đoán thẩm mỹ |
| MAN-6 | Nghiệm thu dùng hằng ngày: chạy bản Rust thay Electron ít nhất một tuần | R9.12 | Chỉ chủ dự án làm được |

## Tổng quan

| Mốc | Tên | Số task | XS | S | M | L | Điểm |
|---|---|---|---|---|---|---|---|
| M1 | Khung & rủi ro | 43 | 9 | 21 | 11 | 2 | — |
| M2 | Xem đầy đủ | 34 | 2 | 10 | 21 | 0 | — |
| M3 | Phiên và thao tác | 15 | 0 | 7 | 7 | 0 | — |
| M4 | Trang và chú thích | 25 | 0 | 7 | 15 | 2 | — |
| M5 | Hộp thoại và xử lý | 69 | 0 | 17 | 45 | 1 | — |
| M6 | Ký số | 30 | 1 | 7 | 19 | 2 | — |
| M7 | Sửa chữ và đoạn | 13 | 2 | 0 | 10 | 0 | — |
| M8 | Chụp và xử lý ảnh | 23 | 0 | 1 | 21 | 0 | — |
| M9 | Hoàn thiện | 17 | 1 | 6 | 8 | 0 | — |
| **Tổng** | | **269** | 15 | 76 | 157 | 7 | — |

Trong tổng có 14 task "Điểm kiểm" (kích thước —). Task ❌ (R1.09, R5.16, R7.08) vẫn được đếm. Phần lớn task là M (157): đây là điều cần hiệu chỉnh sau M1 (BLUEPRINT_RUST §14) và sau R5.02 (xem tiêu chí 5 của R5.02).

## Thứ tự làm tiếp (chốt 2026-11-11, D86)

Bảng M1–M9 vẫn là cách chia việc. Thứ tự làm dưới đây đi theo rủi ro còn lại, không theo số mốc. Điểm kiểm cuối mốc không chặn việc của mốc sau.

1. **MAN-1 ngay (R1.26, R1.27).** Khoảng 10 phút của chủ dự án. IME là rủi ro cao nhất và là việc duy nhất quyết định có phải làm R1.24, R1.25 (hai task L). Nếu đạt: R1.24 và R1.25 chuyển ❌.
2. **Lát cắt dọc M3, trước phần còn lại của M2:** R3.02 → R3.04 → R3.05 → R3.06 → R3.08 (chỉ `page.rotate`) → R3.11 → R3.12. Lý do: khoảng 170 task của M4–M8 phụ thuộc chuỗi này, và R3.06 (đổi viewer từ file gốc sang rev file) là rủi ro kiến trúc lớn nhất chưa kiểm. Demo của lát cắt: mở file, xoay một trang, viewer giữ vị trí, hoàn tác, lưu; chỉ xem thì không có tiến trình `chef-core`.
3. **Gom đuôi M1 rồi làm Điểm kiểm M1:** R2.33 (script chạy gộp E2E), R1.43 (so probe với Electron, đóng R1.13, R1.15, R1.16, R1.17, R1.19), R1.37 và R1.38 (cần lõi chạy từ bước 2 để có `coreMB`), R1.35 (bộ đếm GPU), R1.12 (tiêu chí 2), R1.32 (tiêu chí 3). R1.05 giữ 🔄 đến khi xác minh workflow/native build trên HEAD và branch protection; hiện tạm hoãn package build theo yêu cầu.
4. **Phần còn lại của M2:** R2.15, R2.22, R2.17, R2.16, R2.18, R2.20 và các task 🔄 (R2.02, R2.19, R2.21, R2.26, R2.28, R2.30, R2.31), rồi R2.32.
5. **Phần còn lại của M3:** R3.03, R3.07, R3.09, R3.13, R3.14, rồi R3.15. Sau đó M4 đến M9 theo thứ tự cũ.

---

## M1: Khung & rủi ro

**Mục tiêu:** kiểm các điều chưa biết sớm nhất (IME tiếng Việt, cửa sổ ngoài màn hình, pdfium, cache, đo RAM, font, icon, bóng), với mỗi thứ là một task kiểm có kết quả ghi lại. Không có tính năng người dùng nào ở đây.
**Demo:** cửa sổ GPUI với theme từ `tokens.css`; mở file PDF 1000 trang từ argv, cuộn 350 màn hình; kênh debug trả `state` và `screenshot`; bảng RAM có `nativeMB` và `coreMB`.
**Thứ tự:** 7 luồng có thể làm song song: (0) nền repo, (1) cửa sổ và kênh debug, (2) theme và probe hình họa, (3) IME, (4) pdfium và viewer, (5) đo RAM, (6) lõi lười, (7) codegen. Luồng (6) chạm `core/` nên mỗi task có pytest. Các luồng 2, 3, 4 phụ thuộc R1.06 và R1.07.

### M1.0 Nền repo

### R1.01 · Ghim GPUI và đọc giấy phép gpui · XS
- **Mô tả:** chọn commit của repo Zed, ghi SHA vào `apps/native/Cargo.toml`, đọc `LICENSE` của crate `gpui`.
- **Tiêu chí:** (1) `cargo metadata` phân giải được với SHA đã ghim; (2) LICENSE xác nhận Apache-2.0, ghi kết quả vào NOTES; (3) crate khác của Zed không được dùng nếu không xác nhận giấy phép.
- **Kiểm chứng:** `cargo metadata --format-version 1` không lỗi; log NOTES có SHA và giấy phép.
- **Phụ thuộc:** —
- **File:** `apps/native/Cargo.toml`, `docs/NOTES.md`
- **Tính năng:** —
- **Ghi chú:** SHA ghim v0.233.10 (350f338); gpui Apache-2.0 (Cargo.toml); cargo deny licenses/bans/sources đạt sau D75
- **Trạng thái:** ✅

### R1.02 · Workspace với 9 crate và build.rs · S
- **Mô tả:** tạo workspace theo BLUEPRINT_RUST §8.1 với các crate rỗng: `chef-app`, `chef-ui`, `chef-theme`, `chef-rpc`, `chef-pdf`, `chef-viewer`, `chef-contracts`, `chef-capture`, `chef-testkit`; `build.rs` nhúng `assets/` vào exe.
- **Tiêu chí:** (1) `cargo build` xanh; (2) `cargo fmt --check` sạch; (3) `build.rs` nhúng một file thử và đọc lại được.
- **Kiểm chứng:** `cargo build -p chef-app`; test đọc tài nguyên nhúng.
- **Phụ thuộc:** R1.01
- **File:** `apps/native/Cargo.toml`, `apps/native/crates/*/Cargo.toml`, `apps/native/build.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09) assets/ nhúng vào exe: build.rs sinh `OUT_DIR/assets.rs` (`include_bytes!` từng tệp), `assets::Embedded` là `AssetSource` của GPUI (`with_assets`). 3 test: font đọc lại đúng TTF, icon là SVG, list 153 icon. fmt và clippy `-D warnings` xanh; `cargo deny check` còn lỗi advisories (R1.03), không do thay đổi này
- **Trạng thái:** ✅

### R1.03 · Cấu hình cargo-deny · XS
- **Mô tả:** `deny.toml` với danh sách giấy phép cho phép (Apache-2.0, MIT, BSD-3-Clause, ISC, OFL-1.1, Unicode) và cấm rõ AGPL, GPL, Ghostscript, MuPDF, PyMuPDF, iText.
- **Tiêu chí:** (1) `cargo deny check licenses` xanh với workspace hiện tại; (2) một crate giả GPL bị từ chối khi thử.
- **Kiểm chứng:** chạy `cargo deny check` hai lần (sạch và có crate cấm).
- **Phụ thuộc:** R1.02
- **File:** `apps/native/deny.toml`
- **Tính năng:** —
- **Ghi chú:** deny.toml: licenses, bans, sources đạt. Đã xác nhận crate giả GPL-3.0 bị từ chối (exit 4, workspace tạm). (2026-11-14, D90) Chủ dự án chọn ignore 10 advisory `unmaintained` theo ID, mỗi mục có lý do; full `cargo deny check` xanh trên máy này. Chưa có run xanh trên HEAD hiện tại.
- **Trạng thái:** ✅

### R1.04 · Đọc giấy phép các thư viện chưa rõ · XS
- **Mô tả:** đọc `LICENSE` trên GitHub của `pdfium-render`, `typify`, `gpui-component`, và xác nhận BSD-3-Clause của pdfium.
- **Tiêu chí:** (1) bảng BLUEPRINT_RUST §9 có giấy phép đã xác nhận, không còn "chưa rõ"; (2) nếu một thư viện không đạt, ghi thay thế trong NOTES.
- **Kiểm chứng:** diff của BLUEPRINT_RUST §9 có trích dẫn đường dẫn LICENSE.
- **Phụ thuộc:** —
- **File:** `docs/BLUEPRINT_RUST.md`
- **Tính năng:** —
- **Ghi chú:** pdfium-render MIT OR Apache-2.0; gpui-component Apache-2.0; typify Apache-2.0; pdfium BSD-3-Clause (BLUEPRINT_RUST §9 đã cập nhật)
- **Trạng thái:** ✅

### R1.05 · Job "Native (Windows)" trong CI, không chặn · S
- **Mô tả:** có workflow `.github/workflows/native-builds.yml` chạy fmt, clippy, test, deny và build release. Không đặt làm required check.
- **Tiêu chí:** (1) job xanh trên nhánh; (2) job cũ (Core, JS, E2E Windows) không đổi; (3) job không nằm trong danh sách required.
- **Kiểm chứng:** run CI xanh; so sánh diff `ci.yml` chỉ thêm job mới.
- **Phụ thuộc:** R1.03
- **File:** `.github/workflows/native-builds.yml`
- **Tính năng:** —
- **Ghi chú:** (2026-11-14) Có workflow `Native Rust Builds` riêng cho nhánh `new-rust`, chạy fmt, clippy, test, deny và đóng gói Windows/macOS. Run `43575990879` xanh ở commit cũ `9266133`; không phải HEAD hiện tại. Run `43598218212` ở `ae60a2f` lỗi biên dịch Mac: app gọi RPC modules chỉ có trên Windows; phần tương thích Mac được bổ sung ở `be643d9`, nhưng các lần chạy native sau đó bị hủy theo yêu cầu tạm gác build nên chưa xác nhận bản sửa. CI thường `43599187531` trên HEAD `be643d9` đang chạy; chưa kiểm tra branch protection. Giữ 🔄.
- **Trạng thái:** 🔄

### M1.1 Cửa sổ và kênh debug

### R1.06 · Cửa sổ GPUI với khung gốc Windows · S
- **Mô tả:** mở một cửa sổ, đóng và mở lại. Giữ khung gốc (không `frame: false`) theo BLUEPRINT_RUST §6.2.
- **Tiêu chí:** (1) cửa sổ hiện và đóng sạch, không rò tiến trình; (2) có khung và nút thu/phóng gốc của Windows; (3) kích thước tối thiểu bằng `MIN_SIZE` của bản Electron (`window.ts`).
- **Kiểm chứng:** test thủ công và log thoát; screenshot ở R1.07.
- **Phụ thuộc:** R1.02
- **File:** `apps/native/crates/chef-app/src/main.rs`, `apps/native/crates/chef-app/src/window.rs`
- **Tính năng:** A1 (nền)
- **Ghi chú:** mở và đóng sạch; khung gốc Windows (nút thu, phóng, đóng); kích thước tối thiểu 800×560 client (MIN_SIZE của Electron): yêu cầu 300×200 từ ngoài bị kẹp ở 814×597 ngoài (có viền và thanh tiêu đề). Lưu ý: kích thước ban đầu là 1234×716, không phải 900×640 yêu cầu, vì GPUI thay bằng mặc định khi vị trí ngoài màn hình (xem BLUEPRINT_RUST §10.3)
- **Trạng thái:** ✅

### R1.07 · Kênh debug tối thiểu · M
- **Mô tả:** named pipe `\\.\pipe\chef-native-<pid>-<token>`, chỉ bật khi `CHEF_E2E=1` hoặc build debug. Lệnh: `state`, `screenshot` (PNG cửa sổ), `quit`. Token ngẫu nhiên mỗi lần chạy.
- **Tiêu chí:** (1) không có pipe khi không bật biến môi trường; (2) `screenshot` trả PNG khác trắng; (3) pipe từ chối khi sai token.
- **Kiểm chứng:** test Rust gọi pipe; xem `state` và PNG trong scratchpad.
- **Phụ thuộc:** R1.06
- **File:** `apps/native/crates/chef-testkit/src/debug_channel.rs`, `apps/native/crates/chef-app/src/debug.rs`
- **Tính năng:** —
- **Ghi chú:** pipe chef-native-<pid>, token 128 bit; state, quit, từ chối sai token, không mở khi thiếu CHEF_E2E đã kiểm. screenshot dùng Windows.Graphics.Capture (chụp đúng nội dung GPUI ngoài màn hình). Lệch so với tiêu chí: ảnh là BMP, chưa có PNG; BMP đủ để kiểm tra không trắng
- **Trạng thái:** ✅

### R1.08 · Cửa sổ ngoài màn hình vẫn vẽ và chụp được · S
- **Mô tả:** đặt cửa sổ ở tọa độ âm (cách bản Electron làm với `CHEF_E2E_OFFSCREEN`, `index.ts:252`), chụp qua R1.07. Ghi kết quả vào BLUEPRINT_RUST §10.3.
- **Tiêu chí:** (1) ảnh chụp không trắng và đúng nội dung; (2) số vòng vẽ mỗi giây được ghi; (3) kết quả ghi vào BLUEPRINT_RUST §10.3.
- **Kiểm chứng:** so ảnh chụp với nội dung đã vẽ.
- **Phụ thuộc:** R1.07
- **File:** `apps/native/crates/chef-app/src/window.rs`, `docs/BLUEPRINT_RUST.md`
- **Tính năng:** —
- **Ghi chú:** vị trí (−20000,−20000), không hiện trên màn hình; GPUI vẽ nội dung ngoài màn hình (ảnh WGC có dòng chữ, nền #f4f5f7). Số vòng vẽ: rảnh 0 lần trong 3 s (GPUI vẽ theo yêu cầu); ép refresh mỗi 16 ms đo được 32,3 vòng/s (trần do bộ hẹn giờ của Windows, không phải do vẽ)
- **Trạng thái:** ✅

### R1.09 · Dự phòng cho cửa sổ ngoài màn hình · S
- **Mô tả:** chỉ làm khi R1.08 không đạt. Thử cửa sổ thu nhỏ tối thiểu, rồi cửa sổ trong suốt (alpha 1). Nếu cả hai không vẽ thì đo bằng cửa sổ hiện, và xin MAN-4.
- **Tiêu chí:** (1) có một cách chạy E2E không làm lộ cửa sổ cho người dùng; (2) kết quả và cách chọn ghi vào BLUEPRINT_RUST §10.3.
- **Kiểm chứng:** chụp ảnh cho mỗi cách thử.
- **Phụ thuộc:** R1.08
- **File:** `apps/native/crates/chef-app/src/window.rs`
- **Tính năng:** —
- **Ghi chú:** bỏ: R1.08 đạt bằng Windows.Graphics.Capture, không cần phương án dự phòng
- **Trạng thái:** ❌

### R1.10 · Quyết định cách chạy E2E nền · XS
- **Mô tả:** ghi quyết định D74 về việc chạy E2E Rust: ngoài màn hình là mặc định; cửa sổ hiện chỉ khi chủ dự án đồng ý (MAN-4); chuột thật chỉ khi `CHEF_E2E_OS_INPUT=1`.
- **Tiêu chí:** (1) D74 trong NOTES; (2) khớp với quy tắc memory E2E nền.
- **Kiểm chứng:** đọc NOTES.
- **Phụ thuộc:** R1.09
- **File:** `docs/NOTES.md`
- **Tính năng:** —
- **Ghi chú:** D74 ghi trong NOTES
- **Trạng thái:** ✅

### M1.2 Theme và probe hình họa

### R1.11 · Script sinh theme từ tokens.css · S
- **Mô tả:** `scripts/gen-native-theme.mjs` đọc `tokens.css` (126 khai báo, hai theme) và sinh `chef-theme/src/generated.rs` gồm light, dark. Chế độ `--check` thoát lỗi khi lệch.
- **Tiêu chí:** (1) số khai báo sinh ra khớp 126; (2) sửa một token rồi `--check` báo lỗi; (3) màu `rgba` đổi sang 0–255 đúng.
- **Kiểm chứng:** test Node cho bộ chuyển đổi màu; `--check` trong CI.
- **Phụ thuộc:** R1.02
- **File:** `scripts/gen-native-theme.mjs`, `apps/native/crates/chef-theme/src/generated.rs`
- **Tính năng:** —
- **Ghi chú:** 126 khai báo; 6/6 test Node; --check hoạt động
- **Trạng thái:** ✅

### R1.12 · Áp theme sáng, tối, hệ thống · S
- **Mô tả:** chọn theme theo cài đặt `system/light/dark`. Theme hệ thống đọc `AppsUseLightTheme` trong registry và cập nhật khi đổi.
- **Tiêu chí:** (1) nền cửa sổ bằng `--c-bg` của theme đã chọn; (2) đổi theme hệ thống thì cửa sổ cập nhật; (3) không cần khởi động lại.
- **Kiểm chứng:** screenshot ở hai theme; đổi registry và chụp lại.
- **Phụ thuộc:** R1.11, R1.07
- **File:** `apps/native/crates/chef-theme/src/system.rs`, `apps/native/crates/chef-app/src/window.rs`
- **Tính năng:** A4 (theme)
- **Ghi chú:** bảng màu lấy từ chef-theme; chế độ hệ thống đọc AppsUseLightTheme mỗi lần vẽ. (2026-11-14) Viewer đăng ký `observe_window_appearance`, gọi render lại ở mode System; debug state có `themeDark` để so trước/sau. Windows GNU check/clippy và test compile đạt; vẫn chưa đổi theme thật trong Windows profile tạm. Nền viewer dùng --c-canvas, không phải --c-bg.
- **Trạng thái:** 🔄

### R1.13 · Probe font Be Vietnam Pro · S
- **Mô tả:** lấy TTF 400, 500, 600 từ nguồn OFL, đủ tập Latin và Latin-Extended. Nạp bằng `add_fonts` của GPUI. So chữ "Thanh toán được" 13 px với bản Electron.
- **Tiêu chí:** (1) ba độ đậm hiển thị đúng; (2) dấu tiếng Việt không thiếu glyph; (3) ghi định dạng nạp được vào BLUEPRINT_RUST §6.4 (TTF có, woff chưa).
- **Kiểm chứng:** screenshot so với Electron ở cùng cỡ chữ.
- **Phụ thuộc:** R1.06
- **File:** `apps/native/assets/fonts/`, `apps/native/crates/chef-ui/src/fonts.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09) Nạp 3 TTF qua `add_fonts` (`assets::register_fonts`). Ảnh probe: ba độ đậm khác nhau, chữ có dấu không thiếu glyph. Còn lại: so ảnh với Electron ở 13 px (cần R1.21). Định dạng ghi ở BLUEPRINT_RUST §6.4
- **Trạng thái:** 🔄

### R1.14 · Script xuất 153 icon Lucide · S
- **Mô tả:** `scripts/export-icons.mjs` đọc import Lucide trong `apps/ui` (gồm import nhiều dòng và alias `as`), lấy SVG từ gói `lucide`, ghi vào `assets/icons/`, và báo tên thiếu.
- **Tiêu chí:** (1) xuất đúng 153 tên đã đếm; (2) báo lỗi khi thiếu tên; (3) không có icon trùng.
- **Kiểm chứng:** test Node với mẫu import nhiều dòng và alias.
- **Phụ thuộc:** R1.02
- **File:** `scripts/export-icons.mjs`, `apps/native/assets/icons/`
- **Tính năng:** —
- **Ghi chú:** 153/153 icon xuất; 4/4 test Node
- **Trạng thái:** ✅

### R1.15 · Probe nét icon ở 16 và 18 px · S
- **Mô tả:** render 10 icon Lucide bằng `svg` của GPUI, so với Electron. Kiểm nét `stroke="currentColor"` có giữ không.
- **Tiêu chí:** (1) nét hiển thị liền, không mất; (2) nếu mất, thử chuyển nét thành path đầy và ghi kết quả; (3) kết quả ghi vào BLUEPRINT_RUST §6.3.
- **Kiểm chứng:** screenshot so sánh.
- **Phụ thuộc:** R1.14
- **File:** `apps/native/crates/chef-ui/src/icon.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09) Probe `CHEF_E2E_PROBE=1`: 10 icon ở 16 px và 18 px, nét 2 hiển thị liền trong ảnh. GPUI `paint_svg` tô bằng `text_color`, không cần `currentColor`; kết quả ghi ở BLUEPRINT_RUST §6.3 và §6.9. Còn lại: so với Electron (R1.21)
- **Trạng thái:** 🔄

### R1.16 · Probe bóng nhiều lớp và vòng focus · S
- **Mô tả:** dựng `--shadow-md` và `--focus-ring` bằng `BoxShadow` (spread, blur, nhiều bóng). Kiểm thứ tự vẽ của vòng focus (2px surface rồi 4px focus).
- **Tiêu chí:** (1) bóng trùng với Electron ở vùng mờ; (2) vòng focus đúng thứ tự; (3) xác nhận API trên commit đã ghim, ghi vào BLUEPRINT_RUST §6.1.
- **Kiểm chứng:** screenshot một nút ở trạng thái focus so với Electron.
- **Phụ thuộc:** R1.11, R1.06
- **File:** `apps/native/crates/chef-ui/src/shadow.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09) BoxShadow đạt: `shadow-md` và vòng focus vẽ đúng thứ tự (khe 2 px, viền 2 px). Phát hiện: blur_radius của GPUI là σ, CSS là blur/2; blur 0 không vẽ, nên vòng cứng dùng 0,5 px. Còn lại: so với Electron ở vùng mờ (R1.21). API ghi ở BLUEPRINT_RUST §6.9
- **Trạng thái:** 🔄

### R1.17 · Probe layout: flex, grid auto-fit, ellipsis, aspect-ratio · M
- **Mô tả:** dựng bốn mẫu lấy từ CSS hiện có: `docTools.css` (`repeat(auto-fit, minmax(220px,1fr))`), `TaskDialog.css` (`minmax(0,1fr) 300px`), ellipsis ở `app.css:80`, `signTemplate.css:186` (`aspect-ratio: 260/100`).
- **Tiêu chí:** (1) số cột của `auto-fit` đổi đúng khi đổi chiều rộng; (2) ellipsis cắt một dòng đúng; (3) `aspect-ratio` giữ tỉ lệ; (4) mỗi dòng của bảng §6.2 có kết quả "đạt / không đạt / cách khác".
- **Kiểm chứng:** screenshot ở ba chiều rộng so với Electron.
- **Phụ thuộc:** R1.06
- **File:** `apps/native/crates/chef-ui/src/layout_probe.rs`, `docs/BLUEPRINT_RUST.md`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09) Probe: auto-fit không có trong GPUI, thay bằng số cột tính từ chiều rộng (3, 4, 6 cột ở 800, 1184, 1484 px); ellipsis một dòng đạt; `minmax(0,1fr) 300px` đạt; aspect-ratio 260/100 đạt. Còn lại: so với Electron ở ba cỡ (R1.21). Kết quả ở BLUEPRINT_RUST §6.9
- **Trạng thái:** 🔄

### R1.18 · Probe số chữ cố định và khoảng cách chữ · XS
- **Mô tả:** kiểm `font-variant-numeric: tabular-nums` (12 chỗ dùng) và `letter-spacing` (6 chỗ).
- **Tiêu chí:** (1) số cột thẳng hàng khi tnum bật; (2) nếu GPUI không hỗ trợ, ghi cách bù và cách đã chọn.
- **Kiểm chứng:** bảng số trong screenshot.
- **Phụ thuộc:** R1.13
- **File:** `apps/native/crates/chef-ui/src/text.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09) GPUI áp `tnum` qua `font_features` (kiểm bằng Constantia: cột thẳng). Be Vietnam Pro không có GSUB `tnum` (fontTools), nên 12 chỗ `tabular-nums` không có tác dụng ở cả hai bản. Cách bù (vẽ từng chữ số trong ô cố định) chưa cần. Ghi ở BLUEPRINT_RUST §6.9
- **Trạng thái:** ✅

### R1.19 · Probe trạng thái hover, active, focus-visible, con trỏ · XS
- **Mô tả:** dựng một nút với `.hover()`, `.active()`, focus handle và `.cursor_pointer()`.
- **Tiêu chí:** (1) bốn trạng thái đổi đúng màu theo token; (2) con trỏ là bàn tay; (3) không đổi kích thước khi hover.
- **Kiểm chứng:** screenshot từng trạng thái.
- **Phụ thuộc:** R1.16
- **File:** `apps/native/crates/chef-ui/src/button_probe.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09) Bốn trạng thái đổi đúng màu: hover và active qua `mouse move` và `mouse down`; focus-visible cần lần nhập gần nhất là bàn phím (kiểm bằng `key 65`). Token hover và active là RGBA trong suốt. Còn lại: con trỏ tay chưa đo (WGC không chụp con trỏ)
- **Trạng thái:** 🔄

### R1.20 · Probe thanh cuộn tùy biến · XS
- **Mô tả:** kiểm cách đổi style thanh cuộn (3 chỗ dùng `scrollbar` trong CSS hiện có). Nếu GPUI không cho đổi, ghi lựa chọn: vẽ thanh cuộn riêng hoặc giữ mặc định.
- **Tiêu chí:** (1) kết luận ghi vào BLUEPRINT_RUST §6.2; (2) nếu vẽ riêng, có thử cuộn bằng chuột.
- **Kiểm chứng:** screenshot.
- **Phụ thuộc:** R1.06
- **File:** `docs/BLUEPRINT_RUST.md`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09) Kết luận: GPUI core không vẽ thanh cuộn và không có API đổi màu (`scrollbar_width` chỉ chừa chỗ). Thanh cuộn của dự án vẽ riêng trong chef-ui, khi có chỗ dùng đầu tiên. Ghi ở BLUEPRINT_RUST §6.9
- **Trạng thái:** ✅

### R1.21 · Chụp tham chiếu Electron cho ba màn hình mẫu · S
- **Mô tả:** chụp ba màn hình (Start, viewer, một hộp thoại) của bản Electron 1.3.0 ở DPR 1 (`--force-device-scale-factor=1`) và DPR 1,75 (DPR của máy này), hai theme. Ghi vào thư mục ngoài repo.
- **Tiêu chí:** (1) 12 ảnh; (2) manifest SHA-256 trong repo; (3) ghi DPR thật vào manifest.
- **Kiểm chứng:** kiểm kích thước ảnh tương ứng với DPR.
- **Phụ thuộc:** —
- **File:** `tests/visual/native-refs/manifest.json`
- **Tính năng:** —
- **Trạng thái:** ✅

### R1.43 · So các probe hình họa với Electron (gom đuôi) · S
- **Mô tả:** một lần chạy đóng phần "so với Electron" còn mở của R1.13 (chữ 13 px), R1.15 (nét icon), R1.16 (bóng ở vùng mờ), R1.17 (layout ở ba chiều rộng, glyph ellipsis) và R1.19 (con trỏ tay). Dùng cặp ảnh cùng probe và bộ so ảnh R2.02 (so theo ô). Con trỏ tay kiểm bằng Win32 `GetCursorInfo` khi trỏ chuột thật lên nút; cần chế độ probe hiển thị và driver đọc cursor vì WGC không chụp con trỏ.
- **Tiêu chí:** (1) mỗi probe có kết quả "đạt / lệch (số ô lệch) / chấp nhận" ghi vào BLUEPRINT_RUST §6.9; (2) năm task trên được chuyển ✅, hoặc ghi rõ phần lệch chuyển sang task nào; (3) năm dòng còn "Kiểm ở M1" trong bảng §6.2 (flex, `@keyframes`, `transition`, `user-select`, `letter-spacing`) có kết quả.
- **Kiểm chứng:** báo cáo `report.html` của R2.02 cho các cặp ảnh probe; MAN-5 xem ảnh.
- **Phụ thuộc:** R1.21, R2.02
- **File:** `apps/native/crates/chef-app/src/probe.rs`, `apps/native/crates/chef-app/src/main.rs`, `apps/native/crates/chef-app/src/debug.rs`, `scripts/capture-native-probes.ps1`, `tests/e2e/specs/native-probe-refs.spec.ts`, `docs/BLUEPRINT_RUST.md`
- **E2E:** `probe-capture`
- **Tính năng:** —
- **Ghi chú:** (2026-11-11) thêm ở bản 0.2 để năm task 🔄 không đóng lẻ từng cái. (2026-11-14) CLI R2.02 nhận manifest cặp ảnh và sinh report. Thêm `CHEF_E2E_PROBE_VISUAL_ONLY=1` để native capture chỉ vẽ đúng nhóm nút, font, icon, bóng và layout cần so; `scripts/capture-native-probes.ps1` chụp ứng viên ở ba chiều rộng, hai theme, lưu BMP/index ngoài repo và thư mục tạm. `-VisibleProbe`/`-MeasurePointer` bật cửa sổ chỉ trong probe E2E; đo cursor di chuyển chuột hệ thống lên `probe-primary`, yêu cầu `state.cursor.type == hand`, rồi phục hồi tọa độ ban đầu. `state.cursor` lấy loại/vị trí bằng Win32 `GetCursorInfo`. Thêm `tests/e2e/specs/native-probe-refs.spec.ts` tạo ảnh Electron cùng kích thước, theme, nội dung probe ở DPR 1/1,75; capture index Electron lưu cạnh ảnh ngoài repo, manifest trong repo chỉ giữ kích thước/hash. `scripts/make-native-probe-pairs.mjs` kiểm tra file/hash, ghép theo theme/kích thước/DPR, kiểm pixel dimensions rồi ghi manifest cho CLI; Node tests 2/2 đạt. E2E/UI/desktop typecheck đạt với Node 22/pnpm 10.28. `pnpm install --frozen-lockfile --ignore-scripts` không chạy lifecycle/build scripts. Chưa chụp được ảnh vì UI dist chưa có và build đang tạm gác. PowerShell parser, Windows GNU `cargo check --tests` và Clippy `-D warnings` đạt; capture Rust/Electron, cursor và comparator runtime vẫn chưa chạy trên Windows. R1.21 chỉ có màn hình Start/view/dialog; corpus `CHEF_VISUAL_REFS` cũng cần khôi phục. Đây là capture helper nên nằm ngoài `e2e-native-all.ps1`. Giữ 🔄; không suy luận kết quả so ảnh từ probe đơn lẻ.
- **Trạng thái:** 🔄

### M1.3 IME (rủi ro cao nhất)

### R1.22 · Ô nhập một dòng cơ bản · M
- **Mô tả:** ô nhập GPUI: ký tự Unicode qua `WM_CHAR`, con trỏ, chọn bằng chuột và Shift, Ctrl+A, Ctrl+C/V/X, Backspace và Delete.
- **Tiêu chí:** (1) dán chuỗi tiếng Việt có dấu giữ nguyên; (2) chọn và xóa đúng vùng; (3) con trỏ không nhảy khi gõ nhanh.
- **Kiểm chứng:** test Rust cho buffer (15 test trong chef-ui, gồm gõ nhanh, chọn ngược rồi xóa, dán NFC, chuẩn hóa nhiều dòng); E2E qua kênh debug: `scripts/e2e-native-input.ps1` (19 kiểm tra: gõ, chọn ngược, copy/cut/paste qua clipboard, dán `\r\n`, Home/End, Select All, Backspace, gõ nhanh, mũi tên và Delete). Lệnh `action` của kênh debug đưa action vào đúng đường keymap, vì PostMessage không đặt được Shift/Ctrl.
- **Phụ thuộc:** R1.07
- **File:** `apps/native/crates/chef-ui/src/text_input.rs`, `apps/native/crates/chef-ui/src/text_buffer.rs`, `apps/native/crates/chef-app/src/debug.rs`, `scripts/e2e-native-input.ps1`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09) hoàn tất. Chữ ô nhập dùng màu theme (`text` trên thanh viewer), placeholder mờ 50%. Phần IME (gõ Telex, Unikey, EVKey) không thuộc R1.22; xem R1.23 đến R1.27.
- **Trạng thái:** ✅

### R1.23 · Kiểm composition của GPUI trên Windows · S
- **Mô tả:** đọc mã Windows của commit đã ghim tìm `WM_IME_COMPOSITION`, `WM_IME_STARTCOMPOSITION`, TSF. Viết một ô thử để xem composition có đi qua không.
- **Tiêu chí:** (1) kết luận "có / không / một phần" kèm đường dẫn mã; (2) ghi vào BLUEPRINT_RUST §13.1; (3) nếu "không", R1.24 được kích hoạt.
- **Kiểm chứng:** log sự kiện IME trong ô thử.
- **Phụ thuộc:** R1.22
- **File:** `docs/BLUEPRINT_RUST.md`, `apps/native/crates/chef-ui/src/ime_probe.rs`
- **Tính năng:** —
- **Ghi chú:** một phần: gpui_windows xử lý WM_IME_STARTCOMPOSITION và WM_IME_COMPOSITION qua IMM32 (ImmGetCompositionStringW, GCS_RESULTSTR/GCS_COMPSTR). Không thấy đường TSF. Bộ gõ Telex của Windows chưa xác nhận: chờ R1.22 và MAN-1 (R1.26)
- **Trạng thái:** ✅

### R1.24 · Dự phòng TSF: đăng ký context và nhận composition · L
- **Mô tả:** chỉ làm khi R1.23 báo thiếu. Đăng ký `ITfThreadMgr` và `ITfContextOwner` cho cửa sổ GPUI, nhận chuỗi composition, đưa vào ô nhập. Đây là một đường đi đã biết, không phải điểm dừng.
- **Tiêu chí:** (1) composition đến được ô nhập; (2) commit đúng ký tự; (3) hủy composition không để lại ký tự.
- **Kiểm chứng:** gõ "Thanh toán được" bằng Telex built-in (MAN-1).
- **Phụ thuộc:** R1.23
- **File:** `apps/native/crates/chef-ui/src/tsf.rs`
- **Tính năng:** —
- **Trạng thái:** ⬜

### R1.25 · Dự phòng TSF: underline và vị trí ứng viên · L
- **Mô tả:** vẽ gạch chân composition, đặt cửa sổ ứng viên tại con trỏ, xử lý phím số trong chế độ chọn ký tự.
- **Tiêu chí:** (1) gạch chân hiển thị đúng đoạn đang gõ; (2) cửa sổ ứng viên nằm đúng chỗ; (3) không mất ký tự khi chuyển bộ gõ.
- **Kiểm chứng:** screenshot khi gõ dở; MAN-1.
- **Phụ thuộc:** R1.24
- **File:** `apps/native/crates/chef-ui/src/tsf.rs`
- **Tính năng:** —
- **Trạng thái:** ⬜

### R1.26 · Kiểm Telex built-in trong ô nhập · S
- **Mô tả:** test tự động cho phần commit (ký tự đã chốt) và MAN-1 cho phần gõ thật bằng bộ gõ Windows.
- **Tiêu chí:** (1) "Thanh toán được" và "nghi dinh" gõ Telex ra đúng dấu; (2) không lặp ký tự; (3) kết quả ghi vào BLUEPRINT_RUST §13.1.
- **Kiểm chứng:** MAN-1 kèm ảnh chụp; test tự động cho commit.
- **Phụ thuộc:** R1.22, R1.23 (hoặc R1.25 nếu được kích hoạt)
- **File:** `apps/native/crates/chef-ui/src/text_input.rs`, `docs/BLUEPRINT_RUST.md`
- **Tính năng:** —
- **Trạng thái:** ⬜

### R1.27 · Kiểm Unikey và EVKey trong khung ghi chú · XS
- **Mô tả:** MAN-1, chạy trên máy chủ dự án với Unikey hoặc EVKey, gõ trong cùng ô "Tìm trong tài liệu" của viewer (Ctrl+F) như R1.26. Cách chạy: `cargo run -p chef-app -- "D:\ChefPDF\core\token-check-out\mau.pdf"` từ `apps\native`, không đặt `CHEF_E2E`.
- **Tiêu chí:** (1) gõ Telex và VNI đúng; (2) kết quả ghi vào BLUEPRINT_RUST §13.1.
- **Kiểm chứng:** ảnh chụp kết quả.
- **Phụ thuộc:** R1.26
- **File:** `docs/BLUEPRINT_RUST.md`
- **Tính năng:** —
- **Trạng thái:** ⬜

### M1.4 pdfium và viewer

### R1.28 · Bind pdfium-render và nạp DLL của pypdfium2 · S
- **Mô tả:** nạp `pdfium.dll` từ wheel pypdfium2 đặt cạnh exe. Ghi phiên bản. Kiểm DLL không có V8 hoặc JS (BLUEPRINT_RUST §7.2).
- **Tiêu chí:** (1) `bind_to_library` thành công; (2) ghi phiên bản và kết luận dùng chung DLL được hay không; (3) kết luận JS ghi vào BLUEPRINT_RUST §7.2.
- **Kiểm chứng:** log phiên bản; test mở một PDF.
- **Phụ thuộc:** R1.02, R1.04
- **File:** `apps/native/crates/chef-pdf/src/lib.rs`
- **Tính năng:** —
- **Ghi chú:** pdfium-render 0.9.5 feature pdfium_8125; DLL chromium/8125 (scripts/fetch-pdfium.mjs). DLL pypdfium2 (8076) bị từ chối: thiếu symbol. JS/XFA: DLL có V8/XFA, viewer không khởi tạo form-fill; kiểm lại ở M4
- **Trạng thái:** ✅

### R1.29 · Luồng render duy nhất và kênh yêu cầu · M
- **Mô tả:** mọi lệnh pdfium chạy trên một luồng. Yêu cầu và trả kết quả qua kênh, có `id`.
- **Tiêu chí:** (1) 1000 yêu cầu đồng thời không crash và không trùng `id`; (2) không gọi pdfium từ luồng khác (kiểm bằng assert); (3) lỗi pdfium trả về, không panic.
- **Kiểm chứng:** test stress; test lỗi.
- **Phụ thuộc:** R1.28
- **File:** `apps/native/crates/chef-pdf/src/render_thread.rs`
- **Tính năng:** —
- **Ghi chú:** 1 luồng render sở hữu Pdfium; 1000 yêu cầu id duy nhất, trả lời đúng id (test). Lỗi trả Err, không panic (test). Không dùng assert kiểm luồng: pdfium không Send nên ràng buộc do kiểu dữ liệu
- **Trạng thái:** ✅

### R1.30 · Mở file argv và render trang 1 BGRA · M
- **Mô tả:** nhận đường dẫn file từ argv, render trang 1 ở BGRA và đưa lên GPUI. Đếm số lần sao chép dữ liệu bitmap.
- **Tiêu chí:** (1) trang 1 hiển thị đúng kích thước; (2) số lần sao chép ghi được (mục tiêu một lần, hoặc ghi lý do); (3) file không tồn tại báo lỗi tiếng Việt.
- **Kiểm chứng:** screenshot so với pypdfium2; đếm sao chép.
- **Phụ thuộc:** R1.29, R1.06
- **File:** `apps/native/crates/chef-app/src/main.rs`, `apps/native/crates/chef-viewer/src/page.rs`
- **Tính năng:** B1 (một trang)
- **Ghi chú:** argv mở file 1000 trang, hiển thị trang 1 (ảnh chụp WGC có chữ tiếng Việt). Số lần sao chép: 1 (as_raw_bytes sao chép từ bộ đệm pdfium; RgbaImage::from_raw không sao chép thêm)
- **Trạng thái:** ✅

### R1.31 · So bitmap pdfium với pypdfium2 · S
- **Mô tả:** render 3 trang mẫu ở cùng DPI bằng cả hai, so pixel. Ghi số chênh lệch trung bình.
- **Tiêu chí:** (1) kích thước khớp; (2) chênh lệch ghi thành số; (3) nếu lệch lớn, ghi nguyên nhân (anti-alias, màu nền).
- **Kiểm chứng:** script so sánh trong `chef-testkit`.
- **Phụ thuộc:** R1.30
- **File:** `apps/native/crates/chef-testkit/src/compare.rs`
- **Tính năng:** —
- **Ghi chú:** cùng kích thước 893×1263: sai lệch 0 trên mọi điểm ảnh so với pypdfium2 (DLL 8076). Trước đó so ở kích thước khác có sai lệch do resize, đã loại bỏ
- **Trạng thái:** ✅

### R1.32 · Mô hình cuộn liên tục · M
- **Mô tả:** tính tổng chiều cao tài liệu, vị trí từng trang, và tập trang nhìn thấy khi cuộn. Chỉ tập này được render.
- **Tiêu chí:** (1) cuộn đến cuối 1000 trang không lỗi; (2) tập trang nhìn thấy đúng với vị trí cuộn; (3) cuộn bằng bánh xe chuột mượt (không khung nào quá 50 ms, đo bằng log).
- **Kiểm chứng:** test đơn vị cho hình học; đo khung.
- **Phụ thuộc:** R1.30
- **File:** `apps/native/crates/chef-viewer/src/scroll.rs`
- **Tính năng:** B2 (cuộn liên tục)
- **Ghi chú:** hình học cuộn và visible ±1 có unit test. `debug.state.renderTiming` ghi GPUI `Render` body duration và khoảng giữa các lần gọi `Render`; các giá trị này không phải thời gian khung hình đã trình bày. Cần xác nhận frame/present thật trên Windows.
- **Trạng thái:** 🔄

### R1.33 · Cache LRU tính theo MB · M
- **Mô tả:** cache bitmap chung, trần cấu hình (khởi điểm 256 MB), bỏ mục ít dùng nhất khi vượt trần. Trang nền (tab khác) không giữ bitmap.
- **Tiêu chí:** (1) test: vượt trần thì bỏ đúng mục ít dùng; (2) tổng byte không vượt trần. (Tiêu chí 3 cũ, "đổi trần trong cài đặt có hiệu lực không cần khởi động lại", chuyển sang R9.01 ngày 2026-11-11: mục cài đặt này thuộc M9.)
- **Kiểm chứng:** test đơn vị; đo RSS khi cuộn.
- **Phụ thuộc:** R1.32
- **File:** `apps/native/crates/chef-viewer/src/cache.rs`
- **Tính năng:** —
- **Ghi chú:** cache LRU theo byte, test đạt (trần 256 MB, không vượt trần trừ một mục lớn hơn trần). (2026-11-11) Đóng: nối trần vào cài đặt chuyển sang R9.01 (tiêu chí 4).
- **Trạng thái:** ✅

### R1.34 · Full-scale chỉ cho trang nhìn thấy ±1 · S
- **Mô tả:** trang trong tập nhìn thấy ±1 được render full-scale. Trang xa được giải phóng hoặc giữ thumbnail nhỏ (R2).
- **Tiêu chí:** (1) sau khi cuộn 350 màn hình, số bitmap full-scale ≤ số trang nhìn thấy + 2; (2) thumbnail không vượt cap; (3) ghi số vào BLUEPRINT_RUST §2.2.
- **Kiểm chứng:** test đếm bitmap; log.
- **Phụ thuộc:** R1.33
- **File:** `apps/native/crates/chef-viewer/src/cache.rs`
- **Tính năng:** —
- **Ghi chú:** đo: sau cuộn 350 màn hình cache = 2 trang (≤ nhìn thấy + 2); số đã ghi ở BLUEPRINT_RUST §2.2. (2026-11-11) Đóng: tiêu chí 2 (cap thumbnail) đã là tiêu chí 2 của R2.22, không kiểm ở đây.
- **Trạng thái:** ✅

### R1.35 · Đo texture atlas của GPUI khi cuộn · M
- **Mô tả:** đếm texture và bộ nhớ GPU của GPUI trước và sau khi cuộn 350 màn hình, và sau khi cache giải phóng bitmap. Ghi có giữ bản sao ngoài cache không (R9).
- **Tiêu chí:** (1) có số liệu trước/sau; (2) texture được giải phóng khi bitmap bị loại, hoặc ghi lý do không được; (3) kết luận ghi vào BLUEPRINT_RUST §2.2.
- **Kiểm chứng:** bộ đếm GPU của Windows theo tiến trình (`Get-Counter "\GPU Process Memory(pid_<pid>*)\Dedicated Usage"` và `Shared Usage`) đọc trong `scripts/measure-native-memory.ps1` ở ba mốc của R1.37. Không viết mã DXGI riêng (đổi 2026-11-11): `nativeMB` đã thấp, chỉ cần một con số xác nhận texture không tăng theo số trang đã cuộn.
- **Phụ thuộc:** R1.34, R1.37
- **File:** `scripts/measure-native-memory.ps1`, `docs/BLUEPRINT_RUST.md`
- **Tính năng:** —
- **Ghi chú:** runner ghi `Dedicated Usage` và `Shared Usage` theo PID ở cả ba mốc, tách nhóm Chef Native/chef-core; nếu không có counter set hoặc PID path thì ghi `unavailable`, không giả định 0. Chưa đo GPU và chưa kết luận GPUI có giữ bản sao ngoài cache. Nếu số đo trên Windows tăng theo số trang đã cuộn thì mới đào sâu bằng DXGI.
- **Trạng thái:** 🔄

### M1.5 Đo RAM

### R1.36 · Quyết định perf-layers và perf-heap không áp dụng · XS
- **Mô tả:** hai spec này đo Chromium (LayerTree qua CDP, heap snapshot). Không có Chromium trong bản Rust nên không chuyển. Ghi D74 (hoặc số tiếp theo).
- **Tiêu chí:** (1) quyết định ghi trong NOTES; (2) bảng coverage ghi hai spec là "không áp dụng, lý do".
- **Kiểm chứng:** đọc NOTES và coverage.
- **Phụ thuộc:** R1.10
- **File:** `docs/NOTES.md`
- **E2E:** `perf-layers`, `perf-heap` (đánh dấu không áp dụng, lý do ghi ở đây)
- **Tính năng:** —
- **Ghi chú:** D74 ghi trong NOTES (perf-layers, perf-heap không áp dụng)
- **Trạng thái:** ✅

### R1.37 · Bộ đo RAM Windows: cây tiến trình · M
- **Mô tả:** đọc bảng tiến trình Windows, lấy working set của cây tiến trình Chef Native và của `chef-core`. In dòng `PERFMEM` giống định dạng cũ, thêm `nativeMB`. Dùng `perf-memory.spec.ts` làm mẫu.
- **Tiêu chí:** (1) có `nativeMB` và `coreMB` (coreMB = 0 khi không có lõi); (2) ba mốc: mở file, cuộn 350 màn hình, quay về đầu; (3) đo được khi cửa sổ ngoài màn hình.
- **Kiểm chứng:** chạy trên file 1000 trang; so với Electron ở R1.38.
- **Phụ thuộc:** R1.30
- **File:** `scripts/measure-native-memory.ps1`, `scripts/gen-perf-memory-fixture.py`
- **E2E:** `perf-memory` (viết lại), `perf-large` (viết lại)
- **Tính năng:** —
- **Ghi chú:** (2026-11-14) `scripts/measure-native-memory.ps1` đo 3 mốc `open` → cuộn từng viewport 350 bước, 150 ms/bước → `return-top`; xác nhận tọa độ cửa sổ ngoài màn hình, đợi chuỗi cuộn và render idle; tách `nativeMB`/`coreMB` theo cây process và có `-NoCore` để xác nhận `coreMB=0`. Lõi được bật mặc định qua `page.rotate`. `scripts/gen-perf-memory-fixture.py` tạo PDF 1000 trang cùng năm bản tab ngoài repo và `%TEMP%`; đã sinh ở `~/.local/share/chef-pdf/perf-fixtures` và xác minh 1000 trang bằng PyMuPDF. Cần chuyển fixture sang Windows, chạy GUI/đo RAM và ghi số đo thật trước khi chuyển ✅.
- **Trạng thái:** 🔄

### R1.38 · Đo Electron cùng kịch bản, gồm lõi · S
- **Mô tả:** chạy `perf-memory` của bản Electron 1.3 trên fixture 1000 trang ở ba mốc. Chạy nền (quy tắc E2E nền). Ghi `electronMB` và `coreMB` cạnh nhau.
- **Tiêu chí:** (1) có đủ ba mốc với cả hai số; (2) so sánh tổng với 1351 MB đã có trong NOTES và ghi chênh lệch; (3) kết quả ghi vào NOTES.
- **Kiểm chứng:** log PERFMEM; so khớp.
- **Phụ thuộc:** R1.37
- **File:** `docs/NOTES.md`
- **E2E:** `perf-memory`
- **Tính năng:** —
- **Ghi chú:** (2026-11-14) `tests/e2e/specs/perf-memory.spec.ts` đã căn kịch bản với R1.37: fixture 1000 trang, viewport 1200×860, ba mốc mở/cuộn 350 viewport mỗi 150 ms/quay về đầu; kiểm khoảng cuộn và scrollTop cuối, in viewport/DPR. Native PERFMEM cũng in DPR/viewportH. Fixture do `scripts/gen-perf-memory-fixture.py` sinh đã xác minh đủ 1000 trang; cần chuyển sang Windows. Chưa chạy trên Windows, chưa ghi `electronMB/coreMB` hoặc đối chiếu số lịch sử 1351 MB.
- **Trạng thái:** 🔄

### M1.6 Lõi lười (song song, chạm core/)

### R1.39 · Đo chi phí import của lõi lúc rảnh · S
- **Mô tả:** chạy `python -X importtime` và đo RSS sau `system.ping` trong `core/chef_core/__main__.py` và `core/chef_core/app.py`. Tách số theo nhóm: cv2, onnxruntime, pyHanko, pikepdf, Pillow.
- **Tiêu chí:** (1) bảng số MB và thời gian import theo nhóm; (2) xác nhận nhóm nào nằm trong 139 MB; (3) không đổi mã.
- **Kiểm chứng:** log; pytest lõi xanh (không đổi).
- **Phụ thuộc:** —
- **File:** `core/chef_core/app.py`, `core/chef_core/__main__.py` (chỉ đọc)
- **Tính năng:** —
- **Ghi chú:** cây tiến trình lõi rảnh 142,5 MB (python 130,9 MB); cv2, onnxruntime, pyhanko không nạp lúc khởi động
- **Trạng thái:** ✅

### R1.40 · Import lười cv2 và onnxruntime · M
- **Mô tả:** chuyển import `cv2` và `onnxruntime` vào hàm dùng đến, trong `core/chef_core/imaging/docaligner.py` và `core/chef_core/imaging/pageimg.py`.
- **Tiêu chí:** (1) pytest lõi xanh (1690 test); (2) E2E `smoke` và `scan` của Electron xanh; (3) RSS lúc rảnh giảm, số ghi trong NOTES.
- **Kiểm chứng:** pytest; E2E `smoke`, `scan`.
- **Phụ thuộc:** R1.39
- **File:** `core/chef_core/imaging/docaligner.py`, `core/chef_core/imaging/pageimg.py`
- **Tính năng:** —
- **Ghi chú:** không cần đổi mã: đo cho thấy cv2 và onnxruntime không nạp lúc khởi động
- **Trạng thái:** ✅

### R1.41 · Import lười pyHanko · M
- **Mô tả:** chuyển import pyHanko vào hàm dùng đến, trong `core/chef_core/signing/*.py` và `core/chef_core/ops/sign_common.py`, `core/chef_core/ops/sign_fields.py`.
- **Tiêu chí:** (1) pytest lõi xanh; (2) E2E `signflow` và `sigstudio` của Electron xanh; (3) RSS lúc rảnh giảm, số ghi trong NOTES.
- **Kiểm chứng:** pytest; E2E.
- **Phụ thuộc:** R1.39
- **File:** `core/chef_core/signing/pades.py`, `core/chef_core/signing/pkcs11.py`, `core/chef_core/signing/pfx.py`, `core/chef_core/ops/sign_common.py`
- **Tính năng:** —
- **Ghi chú:** không cần đổi mã: đo cho thấy pyhanko không nạp lúc khởi động
- **Trạng thái:** ✅

### M1.7 Codegen

### R1.42 · Probe typify trên JSON Schema của lõi · S
- **Mô tả:** lấy JSON Schema từ `core/chef_core/codegen.py` (hiện sinh TS vào `packages/contracts/src/generated/`). Chạy typify thử trên một operation, ví dụ `RasterizeParams` trong BLUEPRINT §3.
- **Tiêu chí:** (1) struct Rust sinh được và biên dịch; (2) giấy phép typify đã xác nhận (R1.04); (3) kết luận ghi vào BLUEPRINT_RUST §8.3.
- **Kiểm chứng:** `cargo build` của struct sinh ra.
- **Phụ thuộc:** R1.04, R1.02
- **File:** `apps/native/crates/chef-contracts/src/lib.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09w) chef-contracts/build.rs sinh struct Rust từ core/chef_core/layout/schema.json (typify 0.4; 0.10-alpha cần rustc 1.97, không dùng được). 2 test: Paragraph đọc đúng và từ chối thiếu bbox. cargo deny licenses/bans/sources đạt. Kết luận ở BLUEPRINT_RUST §8.3.
- **Trạng thái:** ✅

---

## M2: Xem đầy đủ

**Mục tiêu:** bản Rust xem được file như bản Electron: tab, tìm kiếm, chọn và copy, thumbnail, chế độ xem, theme, tiếng Việt, và thư viện thành phần thay cho Radix. Chưa sửa PDF.
**Demo:** mở và xem một file 1000 trang; chuyển tab; tìm "nghi dinh" ra "nghị định"; copy một đoạn; ui-audit các màn hình xem đạt ngưỡng (MAN-5).
**Đầu vào:** R1.21 (tham chiếu 3 màn hình) và R1.37 (bộ đo RAM).

### M2.0 Tham chiếu và so ảnh

### R2.01 · Chụp 104 màn hình ui-audit của Electron · S
- **Mô tả:** chạy `ui-audit.spec.ts` trên bản Electron 1.3.0 với DPR 1, hai theme. Lưu ảnh ngoài repo, manifest SHA-256 trong `tests/visual/native-refs/`.
- **Tiêu chí:** (1) 208 ảnh (104 × 2 theme); (2) manifest có băm và kích thước; (3) đếm theo màn hình, không theo `test`: mỗi màn hình có đúng hai ảnh (light, dark). (Tiêu chí 3 đổi 2026-11-09x: một `test` chụp nhiều màn hình, nên số `test` không dùng làm chuẩn.)
- **Kiểm chứng:** đếm ảnh; kiểm băm một mẫu.
- **Phụ thuộc:** R1.21
- **File:** `tests/visual/native-refs/manifest.json`, `tests/e2e/specs/ui-audit.spec.ts` (chỉ chạy)
- **E2E:** `ui-audit`, `ui-audit-selftest`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09w) Đã chụp 208 ảnh sạch (104 màn hình × 2 theme, DPR 1) ngoài repo ở %TEMP%\chef-visual-refs\ui-audit-{light,dark} bằng UI_AUDIT_CLEAN_DIR trong ui-audit.spec.ts (92/92 test đạt). Manifest SHA-256 và kích thước: tests/visual/native-refs/ui-audit-manifest.json. (2026-11-09x) Tiêu chí (3) đếm theo màn hình: manifest có 104 tên file, mỗi tên đúng hai lần (light, dark), 208 băm SHA-256 và 208 kích thước. Đã kiểm bằng lệnh đếm trên manifest.
- **Trạng thái:** ✅

### R2.02 · Bộ so ảnh ui-audit · M
- **Mô tả:** so từng màn hình giữa ảnh Rust và ảnh tham chiếu theo vùng (SSIM hoặc so sánh theo lưới), xuất báo cáo JSON và HTML với ảnh chồng nhau. Ngưỡng ghi trong file cấu hình.
- **Tiêu chí:** (1) báo cáo liệt kê màn hình vượt ngưỡng; (2) so ảnh giống nhau cho điểm tối đa; (3) chữ khác antialias không làm vượt ngưỡng ở một mẫu đã biết; (4) ảnh tham chiếu (R1.21, R2.01) nằm ở thư mục cố định ngoài repo, không ở `%TEMP%` (Windows có thể tự dọn), đường dẫn đọc từ biến môi trường `CHEF_VISUAL_REFS` có mặc định, và băm khớp manifest sau khi chuyển (thêm 2026-11-11).
- **Kiểm chứng:** test với ảnh giống, ảnh lệch 1 px, ảnh đổi màu; kiểm băm toàn bộ manifest sau khi chuyển thư mục.
- **Phụ thuộc:** R2.01, R1.31
- **File:** `apps/native/crates/chef-testkit/src/visual.rs`, `apps/native/crates/chef-testkit/src/bin/visual-compare.rs`
- **E2E:** `ui-audit-selftest`, `visual-compare`
- **Tính năng:** —
- **Ghi chú:** (2026-11-14) Comparator dùng lưới 16 px, mean threshold 6.0, giới hạn đồng thời `maxBadRatio` 2% và `maxBadTiles` 3; cấu hình/báo cáo JSON ghi cả hai ngưỡng. Có self-test cho ảnh giống, AA nhẹ, lệch chữ 1 px, đổi màu, sai kích thước và output báo cáo; `scripts/e2e-native-visual-selftest.ps1` kiểm manifest R1.21 ở root và manifest R2.01 theo `ui-audit-$theme/$file` (manifest có 104 file/theme nhưng basename lặp giữa light/dark). Fixture hai theme cùng tên, nội dung/hash khác đã xác nhận cả hai file riêng biệt được verify. Script kiểm hash, byte size nếu manifest ghi, kích thước PNG, path traversal, và giữ refs ngoài repo/%TEMP%; default là thư mục data user ổn định. (2026-11-14) Thêm CLI `cargo run -p chef-testkit --bin visual-compare -- pairs.json report-dir`: đọc manifest cặp ảnh, resolve đường dẫn tương đối theo manifest, tạo report JSON/HTML và diff, thoát khác 0 nếu có cặp không đạt. 8/8 test comparator cũ và 4/4 test CLI cùng clippy `-D warnings` đạt; smoke test hai cặp tạo đúng report/diff (một cặp giống, một cặp lệch), xác nhận exit 1; `e2e-native-visual-selftest.ps1 -SelfTestOnly` chạy toàn bộ và resolver fixture đạt với SDK macOS 15.4. **Còn mở:** corpus thật chưa có ở thư mục refs (lần chạy báo thiếu 220 file); chưa có ảnh Rust/Electron tương ứng, driver chụp native và MAN-5 duyệt bằng mắt. Giữ 🔄.
- **Trạng thái:** 🔄

### R2.33 · Script chạy gộp E2E native · XS
- **Mô tả:** `scripts/e2e-native-all.ps1` chạy lần lượt mọi `scripts/e2e-native-*.ps1` trong PowerShell ẩn, không bật Windows OS input, in bảng tổng (tên, số kiểm tra, số lỗi, thời gian) và thoát khác 0 khi có lỗi. Kịch bản cần phím/chuột thật chỉ chạy riêng với `CHEF_E2E_OS_INPUT=1`. Là cổng kiểm cục bộ cho định nghĩa "xong" mục (a); native build workflow là job riêng (R1.05).
- **Tiêu chí:** (1) tự tìm script theo mẫu tên, thêm script mới không phải sửa danh sách; (2) một script lỗi không dừng các script sau, và mã thoát cuối khác 0; (3) không chiếm chuột và không hiện cửa sổ (quy tắc E2E nền).
- **Kiểm chứng:** chạy với toàn bộ script hiện có (không tính runner); thử một script cố ý lỗi.
- **Phụ thuộc:** R1.07
- **File:** `scripts/e2e-native-all.ps1`
- **Tính năng:** —
- **Ghi chú:** (2026-11-11) thêm ở bản 0.2. (2026-11-14) `e2e-native-all.ps1` tự tìm script, bỏ qua chính nó, chạy tuần tự trong PowerShell ẩn, gom PASS/FAIL/thời gian, tiếp tục sau lỗi và trả exit tổng; timeout dừng cả cây tiến trình; giữ log khi có lỗi. Runner xóa `CHEF_E2E_OS_INPUT` trong môi trường child để không chiếm chuột/bàn phím; script input vật lý chỉ opt-in khi chạy riêng. Yêu cầu PowerShell 7. Parser và `-SelfTest` xanh trên Mac (5 script tạm, 10 kiểm tra; xác nhận tự loại runner, hai dạng đếm lỗi, lỗi tổng hợp, tiếp tục sau lỗi và mã thoát tổng). Chưa chạy bộ UI trên Windows.
- **Trạng thái:** 🔄

### M2.1 Thư viện thành phần (thay Radix)

### R2.03 · Button · M
- **Mô tả:** nút theo `components.css`: biến thể, trạng thái hover, active, focus, disabled, con trỏ tay, vòng focus từ R1.16. Chuyển màu trong 150 ms, đường cong `--ease` (cờ `transition` của BLUEPRINT_RUST §6.2). Mọi nút có `id` ổn định cho kênh debug.
- **Tiêu chí:** (1) bốn trạng thái khớp token; (2) Tab tới nút và thấy vòng focus; (3) nút icon-only có nhãn truy cập (`aria-label` tương ứng).
- **Kiểm chứng:** screenshot từng trạng thái; test tab order.
- **Phụ thuộc:** R1.19, R1.16
- **File:** `apps/native/crates/chef-ui/src/button.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09p) Lỗi tìm được bằng E2E click chuột: chuyển màu bằng `with_animation` có khóa theo `generation`, mà đổi khóa đổi id phần tử, nên GPUI mất trạng thái nhấn và không phát `on_click`. Đã thay bằng nội suy thủ công theo `--ease` (`changed_at`, `request_animation_frame`), cây phần tử giữ nguyên. E2E `e2e-native-button` 0 lỗi (thêm nút mở hộp thoại vào thứ tự Tab).
- **Trạng thái:** ✅

### R2.04 · Ô nhập, checkbox, switch · M
- **Mô tả:** ô nhập có nhãn (`form-labels`), checkbox với trạng thái không xác định, switch bật bằng Space và Enter (hành vi Radix `checkbox`, `switch`).
- **Tiêu chí:** (1) Space bật và tắt checkbox; (2) switch đổi trạng thái bằng Space và Enter; (3) ô nhập có nhãn đọc được qua truy cập.
- **Kiểm chứng:** test bàn phím; screenshot.
- **Phụ thuộc:** R2.03
- **File:** `apps/native/crates/chef-ui/src/form.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09p) Checkbox và switch đo bounds (lớp bọc `on_children_prepainted`), nên E2E bấm chuột được. Bấm chuột đổi trạng thái đã kiểm trong `e2e-native-form` (thêm vào sau kiểm bàn phím). Lỗi click nút (D82) không liên quan: hai điều khiển này không dùng animation.
- **Trạng thái:** ✅

### R2.05 · Radio, slider, toggle group · M
- **Mô tả:** radio group (mũi tên chọn), slider (mũi tên, PageUp/PageDown, Home/End), toggle group (roving focus).
- **Tiêu chí:** (1) mũi tên đổi lựa chọn radio; (2) slider đổi giá trị đúng bước; (3) toggle group giữ một tiêu điểm.
- **Kiểm chứng:** test bàn phím cho từng điều khiển.
- **Phụ thuộc:** R2.04
- **File:** `apps/native/crates/chef-ui/src/form.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09s) `chef-ui/src/choice.rs`: `RadioGroup` (`.radio-row`), `ToggleGroup` (`.segmented`), `Slider` (`.slider`). Roving focus: một điểm dừng Tab, là mục đang chọn hoặc mục đầu. Radio: mũi tên chuyển và chọn, có vòng lại. Nhóm nút bật: mũi tên chỉ chuyển tiêu điểm. Thanh trượt: mũi tên một bước, PageUp, PageDown và Shift+mũi tên mười bước, Home, End. Lệch: bấm chuột để đặt giá trị và kéo thanh trượt chưa làm (tiêu chí không yêu cầu; cần cho hộp thoại cài đặt nếu dùng chuột). Hàm thuần có test; E2E `e2e-native-choice` 0 lỗi. Trang thử có ba khu này (probe-radio-*, probe-toggle-*, probe-slider).
- **Trạng thái:** ✅

### R2.06 · Menu và menu chuột phải cơ bản · M
- **Mô tả:** menu bật lên, mũi tên lên và xuống, Enter chọn, Esc đóng, mục bị khóa không chọn được (hành vi Radix `dropdown-menu`, `context-menu`).
- **Tiêu chí:** (1) bàn phím đi qua mục bị khóa mà không chọn; (2) Esc trả tiêu điểm về nút đã mở; (3) chuột phải mở menu ở đúng vị trí.
- **Kiểm chứng:** test bàn phím và chuột.
- **Phụ thuộc:** R2.03
- **File:** `apps/native/crates/chef-ui/src/menu.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09t) `chef-ui/src/menu.rs`: `Menu` (`.menu`, `.menu__item`), mũi tên qua mục dùng được (mục khóa bỏ qua, có vòng lại), Enter chọn, Esc đóng qua `MenuDismiss`, bấm ra ngoài đóng, phím tắt căn phải, dấu chọn cho menu chọn một. Trang thử có menu chuột phải tại vị trí chuột (`rdown` đã thêm vào kênh debug). Trả tiêu điểm về vùng mở qua `window.defer`, vì GPUI đặt tiêu điểm theo chuột sau listener. E2E `e2e-native-menu` 0 lỗi.
- **Trạng thái:** ✅

### R2.07 · Menu: submenu, typeahead, phím tắt hiển thị · S
- **Mô tả:** gõ chữ đầu để nhảy tới mục, submenu bằng mũi tên phải, phím tắt căn phải như bản Electron.
- **Tiêu chí:** (1) typeahead nhảy đúng; (2) mũi tên phải mở submenu; (3) phím tắt hiển thị đúng chữ.
- **Kiểm chứng:** test.
- **Phụ thuộc:** R2.06
- **File:** `apps/native/crates/chef-ui/src/menu.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09t) Đã có: typeahead (gõ chữ đầu nhảy tới mục tiếp theo, có vòng lại, bỏ mục khóa; hàm thuần có test), phím tắt căn phải ("Ctrl+C"). (2026-11-09x) Submenu: `MenuEntry::submenu`, mũi tên phải, Enter hoặc bấm mở; mục con hiện ngay dưới mục cha, thụt vào; mũi tên trái hoặc Esc ở mục con đóng menu con và trả tiêu điểm về mục cha; Esc ở mục gốc đóng menu. Đạt tiêu chí 2. Lệch so với Electron: menu con là khối nội tuyến, không bật ra bên cạnh (flyout), vì bấm vào menu con không được đóng menu cha và chưa có cách đo vùng flyout qua `a11y`. Mũi tên trong menu con đi qua danh sách phẳng, nên mũi tên xuống ở mục con cuối vòng về mục đầu của menu. E2E `e2e-native-menu` 54 kiểm tra đạt, 0 lỗi. Tiêu chí 3: phím tắt đi vào trường `value` của mục (a11y, cùng cách select đưa giá trị ra), E2E kiểm "Ctrl+C" trên mục Sao chép. E2E `e2e-native-menu` 55 kiểm tra, 0 lỗi.
- **Trạng thái:** ✅

### R2.08 · Select · M
- **Mô tả:** chọn một trong danh sách, mở và đóng bằng bàn phím, typeahead (hành vi Radix `select`).
- **Tiêu chí:** (1) Enter mở, Esc đóng; (2) typeahead chọn đúng mục; (3) giá trị đổi ra nhãn đúng.
- **Kiểm chứng:** test bàn phím.
- **Phụ thuộc:** R2.06
- **File:** `apps/native/crates/chef-ui/src/select.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09t) `chef-ui/src/select.rs`: nút hiện mục đang chọn, bấm hoặc Enter mở danh sách (là `Menu` của R2.06), Enter chọn, Esc đóng và trả tiêu điểm, gõ chữ đầu tới mục (typeahead), bấm nút mở và đóng. Bấm ra ngoài đóng; khung bao nút và danh sách lo việc đó, nên bấm nút không bị coi là bấm ngoài (lưu ý từ advisor đã xử lý). Lệch: mũi tên lên và xuống trên nút đang đóng chưa mở danh sách (Radix có). Trạng thái giữ trong keyed state theo id. E2E `e2e-native-menu` 0 lỗi.
- **Trạng thái:** ✅

### R2.09 · Tabs thành phần · S
- **Mô tả:** tab với roving focus, mũi tên trái và phải, Home và End (hành vi Radix `tabs`).
- **Tiêu chí:** (1) mũi tên chuyển tab và tiêu điểm đi theo; (2) Home và End đến đầu và cuối.
- **Kiểm chứng:** test bàn phím.
- **Phụ thuộc:** R2.03
- **File:** `apps/native/crates/chef-ui/src/tabs.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09v) `chef-ui/src/tabs.rs`: một điểm dừng Tab (thẻ đang chọn), mũi tên trái và phải chuyển và chọn có vòng lại, Home và End về đầu và cuối, gạch chân accent cho thẻ đang chọn. Lệch: không có thẻ tắt được (Radix không có mặc định này). E2E `e2e-native-components` 0 lỗi.
- **Trạng thái:** ✅

### R2.10 · Khung hộp thoại · M
- **Mô tả:** bẫy tiêu điểm trong hộp thoại, Esc đóng, nhấn nền đóng, trả tiêu điểm về nút đã mở, hiệu ứng `dialog-in` (160 ms). Tôn trọng giảm chuyển động (BLUEPRINT_RUST §6.7).
- **Tiêu chí:** (1) Tab không ra khỏi hộp thoại; (2) Esc đóng và trả tiêu điểm; (3) tắt chuyển động khi bật giảm chuyển động của Windows.
- **Kiểm chứng:** test; screenshot so ui-audit.
- **Phụ thuộc:** R2.03, R1.12
- **File:** `apps/native/crates/chef-ui/src/dialog.rs`
- **E2E:** `ui-audit` (màn hình hộp thoại)
- **Tính năng:** —
- **Ghi chú:** (2026-11-09p) `chef-ui/src/dialog.rs` (khung `.dlg-overlay` và `.dlg`), `motion.rs` (giảm chuyển động). Tab vòng trong `tab_order` (GPUI ở commit đã ghim không có `tab_group`, nên tự làm); Esc đóng qua action `Dismiss` (ngữ cảnh `ChefDialog`), ô nhập gửi `Cancel` và khung nhận (TextInput gọi `cx.propagate()`); bấm ra ngoài đóng qua `on_mouse_down_out`, lớp phủ `occlude`; đóng trả tiêu điểm về `return_focus`. Mở: lớp phủ và khung mờ dần và dịch 6 px trong 160 ms theo `--ease`, không co 0,985 như CSS (lệch). Tiêu chí 3: cờ lấy từ `SPI_GETCLIENTAREAANIMATION`, biến `CHEF_E2E_REDUCED_MOTION` ghi đè cho E2E; kiểm bằng `state.reducedMotion` và test đơn vị, chưa đo bằng pixel. Chưa làm: `ui-audit` (R2.01/R2.02). E2E `e2e-native-dialog` 26 kiểm tra đạt ở cả hai chế độ. Trang thử có nút `dialog-open`.
- **Trạng thái:** ✅

### R2.11 · Tooltip với trễ 450 ms và 200 ms · S
- **Mô tả:** hiện tooltip sau 450 ms, bỏ trễ 200 ms khi đã có tooltip hiện (`App.tsx` dùng `delayDuration={450}`, `skipDelayDuration={200}`).
- **Tiêu chí:** (1) đúng hai thời gian; (2) tooltip hiện theo tiêu điểm bàn phím.
- **Kiểm chứng:** đo thời gian bằng log.
- **Phụ thuộc:** R2.03
- **File:** `apps/native/crates/chef-ui/src/tooltip.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09v) `chef-ui/src/tooltip.rs`, không dùng tooltip của GPUI (không chỉnh được trễ). Thời gian chờ được chốt lúc kích hoạt: 450 ms; 200 ms khi đã có tooltip hiện hoặc vừa đóng một tooltip trong 200 ms. Hiện theo chuột hoặc tiêu điểm bàn phím. Đo bằng E2E: khoảng 470 ms khi di chuột lần đầu, khoảng 250 ms khi chuyển sang nút khác, khoảng 450 ms khi có tiêu điểm bàn phím (đo từ lúc gửi phím Tab, sau 600 ms nghỉ để không rơi vào quy tắc 200 ms). Hàm thuần có 2 test. E2E `e2e-native-components` 0 lỗi.
- **Trạng thái:** ✅

### R2.12 · Toast · S
- **Mô tả:** thông báo góc dưới, `toast-in`, tự ẩn, đóng bằng nút. Dùng chung cho Start và viewer.
- **Tiêu chí:** (1) tự ẩn sau thời gian cấu hình; (2) nhiều toast xếp chồng; (3) đọc được bằng truy cập.
- **Kiểm chứng:** screenshot; test thời gian.
- **Phụ thuộc:** R2.03
- **File:** `apps/native/crates/chef-ui/src/toast.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09v) `chef-ui/src/toast.rs` và trang thử: xếp chồng ở góc dưới phải, nút đóng, tự ẩn sau 3 s, role status cho truy cập. Lệch: hoạt ảnh `toast-in` chưa làm; thời gian ẩn là hằng số trong trang thử, chưa đọc từ cài đặt. E2E `e2e-native-components` 0 lỗi. (2026-11-09w) Toast có hoạt ảnh toast-in (160 ms, --ease, trượt 8 px và hiện dần; không chạy khi giảm chuyển động). Xếp chồng, nút đóng, tự ẩn 3 s đều kiểm trong e2e-native-components (0 lỗi).
- **Trạng thái:** ✅

### M2.2 Chuỗi, cài đặt, tab

### R2.13 · i18n: en.json, vi.json và nội suy · M
- **Mô tả:** nạp nguyên văn `apps/ui/src/i18n/en.json` và `vi.json`. Thay `{{…}}` (30 chỗ) và chọn dạng `_one` hoặc `_other` (20 cặp) theo số.
- **Tiêu chí:** (1) mọi khóa trong `vi.json` có trong bản Rust, đối chiếu tự động; (2) nội suy và số nhiều cho ra đúng chuỗi như i18next; (3) đổi ngôn ngữ không cần khởi động lại.
- **Kiểm chứng:** test lấy từ `apps/ui/src/i18n/i18n.test.ts` làm mẫu; so chuỗi với bản Electron.
- **Phụ thuộc:** R1.02
- **File:** `apps/native/crates/chef-ui/src/i18n.rs`, `apps/native/assets/i18n/`
- **Tính năng:** A4 (ngôn ngữ)
- **Trạng thái:** ✅

### R2.14 · Cài đặt: giao diện, ngôn ngữ, thư mục mặc định · M
- **Mô tả:** hộp thoại Cài đặt đọc và ghi `settings.json` ở đường dẫn userData chung (D73). Ba mục: giao diện, ngôn ngữ, thư mục mặc định. Các mục khác để M9.
- **Tiêu chí:** (1) đọc file settings của bản Electron, không mất giá trị; (2) ghi lại đúng định dạng CONTRACTS §7; (3) đổi giao diện có hiệu lực ngay.
- **Kiểm chứng:** test đọc file mẫu của Electron; so định dạng.
- **Phụ thuộc:** R2.10, R2.13, R1.12
- **File:** `apps/native/crates/chef-app/src/settings.rs`
- **E2E:** `ui-audit` (màn hình cài đặt)
- **Tính năng:** A4 (giao diện, thư mục mặc định)
- **Ghi chú:** (2026-11-09p) Phần lưu trữ xong: `chef-app/src/settings.rs`, đọc và ghi `settings.json` cùng file với Electron. Chỉ đổi `theme`, `language`, `defaultSaveDir`; khóa khác và khóa chưa biết được giữ nguyên (test trên file kiểu Electron). Ghi qua file tạm rồi đổi tên; file hỏng thì báo lỗi, không ghi đè. Thư mục userData: `CHEF_USER_DATA_DIR`, rồi chế độ E2E dùng thư mục tạm, rồi `%APPDATA%\Chef PDF`. 13 test đạt. Khi ghi, đọc lại file và chỉ vá các khóa đã đổi, nên thay đổi do Electron ghi sau lúc đọc không bị mất (có test). Electron đang chạy giữ cài đặt trong bộ nhớ và sẽ ghi đè thay đổi của Rust ở lần ghi kế tiếp; phía Rust không sửa được, nên việc đổi cài đặt chỉ an toàn khi Electron đã đóng. Chưa làm: hộp thoại. Theme là nhóm nút chọn một (R2.05, đã có). Ngôn ngữ là select (R2.08, đã có); áp theme lúc chạy và nối ngôn ngữ vào chuỗi giao diện cũng chưa làm.
- **Ghi chú:** (2026-11-09u) Hộp thoại Cài đặt mở bằng Ctrl+, (`chef-app/src/settings_dialog.rs`). Ba mục: giao diện (nhóm nút chọn, R2.05), ngôn ngữ (ô chọn, R2.08), thư mục lưu mặc định (ô nhập; Enter ghi). Thay đổi áp dụng ngay và ghi file ngay, như bản Electron. Viewer đọc settings.json lúc khởi động; file hỏng thì chỉ áp trong phiên, không ghi đè (E2E). Chuỗi giao diện của hộp thoại đổi theo ngôn ngữ. Lệch: chọn thư mục bằng hộp thoại Windows là R2.30; đổi giao diện được kiểm qua `state.settings`, chưa đo pixel. E2E `e2e-native-settings` 0 lỗi, gồm khởi động lại và file hỏng.
- **Trạng thái:** ✅

### R2.15 · Thanh tab tài liệu · M
- **Mô tả:** mở nhiều tab, đóng, chuyển bằng chuột và Ctrl+Tab. Tab nền bỏ bitmap trang (R3 của BLUEPRINT_RUST §2.2).
- **Tiêu chí:** (1) mở ba tab, chuyển được; (2) tab nền không giữ bitmap (đo bằng R1.33); (3) đóng tab đang xem chuyển sang tab kế.
- **Kiểm chứng:** E2E qua kênh debug; số bitmap trước và sau.
- **Phụ thuộc:** R2.19, R1.33
- **File:** `apps/native/crates/chef-app/src/tabs.rs`, `apps/native/crates/chef-app/src/tabs_host.rs`, `scripts/e2e-native-tabs.ps1`
- **E2E:** `keyboard` (phần tab), `e2e-native-tabs`
- **Tính năng:** A2
- **Ghi chú:** (2026-11-14) Có model thuần `chef-app/src/tabs.rs`: ID ổn định, title/path/dirty, active, cycle hai chiều và quy tắc chọn tab thay thế khi đóng; 3 unit test đạt. Host `tabs_host.rs` giữ một Viewer cho mỗi TabId, nối Ctrl+Tab/Ctrl+Shift+Tab/Ctrl+W, Ctrl+O và nút +; khi chuyển tab xả bitmap và hủy render đang chờ, giữ trạng thái tài liệu; chặn đóng khi dirty/thao tác đang chạy, đóng session trước DocId; `state.tabs` có ID/title/active/dirty/cache. (2026-11-14) Tab được đăng ký với role/bounds trong debug state. `e2e-native-tabs.ps1` kiểm cache tab nền, chặn đóng dirty, đóng tab sạch và cleanup tiến trình. Mặc định dùng debug actions; `CHEF_E2E_OS_INPUT=1` bật Ctrl+Tab/Ctrl+Shift+Tab/Ctrl+W và click tọa độ bounds thật. PowerShell parser đạt; Windows GNU `cargo check -p chef-app` và `cargo clippy -p chef-app --all-targets -- -D warnings` đạt với SDK host macOS 15.4 (cargo check có cảnh báo thiếu `pdfium.dll`, không tạo app chạy được). Không chạy app/release build. **Còn mở:** E2E Windows chưa chạy và chưa có phép đo R1.33 thực tế.
- **Trạng thái:** 🔄

### R2.16 · Start: ô nhiệm vụ và file gần đây · M
- **Mô tả:** Màn hình Start với các ô nhiệm vụ (Mở PDF, Ghép file, Tách file, Chuyển thành bản scan, Ký số, Đóng dấu, Nén…) và file gần đây. Chỉ icon của ô chưa hỗ trợ dùng `grayscale(0.6)` + `opacity: 0.7` như `.tile.is-disabled .tile__icon` trong `StartScreen.css`; không lọc grayscale toàn màn hình. Ô chưa có tính năng phải hiện trạng thái rõ, không giả làm xong. Danh sách quy trình đã lưu để M5f.
- **Tiêu chí:** (1) ô nhiệm vụ mở đúng hộp thoại đã có hoặc báo "chưa có ở bản này"; (2) file gần đây lưu trong `settings` và hiện đúng thứ tự; (3) bố cục khớp `StartScreen.css` ở ba chiều rộng.
- **Kiểm chứng:** E2E `smoke`, `start-tiles`; ui-audit màn hình Start.
- **Phụ thuộc:** R2.10, R2.14, R1.17
- **File:** `apps/native/crates/chef-app/src/start.rs`
- **E2E:** `smoke`, `start-tiles`, `start-workflows` (phần Start; phần quy trình để M5f)
- **Tính năng:** A1
- **Ghi chú:** (2026-11-14) `start.rs` hiển thị ô Mở PDF có tác dụng mở hộp thoại; các ô Ghép/Tách/Scan/Ký số/Đóng dấu/Nén được đánh dấu chưa hỗ trợ. Có RecentFiles truy cập cùng `settings.json`, sắp newest-first, chuẩn hóa dedupe đường dẫn, cap 20, ghi `openedAt` ISO-8601 và giữ khóa settings chưa biết; bấm mục gần đây mở tài liệu thành tab. Lưới khớp ngưỡng CSS min 208 px, theme lấy từ settings/system và EN/VI có khóa trạng thái. CH-R3 được chốt: chỉ icon disabled grayscale 0.6 + opacity 0.7. `e2e-native-start.ps1` kiểm thứ tự recents/dark theme, dùng thư mục temp làm `defaultSaveDir`, kiểm hủy native Open/Save As không báo lỗi; click recent mặc định qua debug pipe, `CHEF_E2E_OS_INPUT=1` bật chuột Windows thật. Parser PowerShell đạt trên Mac. **Còn mở:** E2E Windows, ui-audit/screenshot ở ba chiều rộng, kiểm trực quan theme sáng/tối.
- **Trạng thái:** 🔄

### R2.17 · Kéo thả file, argv và một phiên bản · M
- **Mô tả:** kéo file vào Start hoặc cửa sổ, nhận file từ argv, và khi mở file thứ hai thì chuyển cửa sổ đã có (single instance). Dùng named pipe nội bộ.
- **Tiêu chí:** (1) kéo thả mở đúng file; (2) mở file lần hai đưa cửa sổ cũ lên trước với file mới trong tab; (3) không mở hai cửa sổ.
- **Kiểm chứng:** E2E `scripts/e2e-native-instance.ps1` (phần chuyển cửa sổ/argv); kiểm kéo thả trong phiên Windows.
- **Phụ thuộc:** R2.15, R1.07
- **File:** `apps/native/crates/chef-app/src/instance.rs`, `apps/native/crates/chef-app/src/drop.rs`, `apps/native/crates/chef-app/src/main.rs`, `apps/native/crates/chef-app/src/tabs_host.rs`
- **E2E:** `scripts/e2e-native-instance.ps1`
- **Tính năng:** A1 (kéo thả), A5 (argv)
- **Ghi chú:** (2026-11-14) Có parser argv nhiều đường dẫn Unicode, `--` cho tên bắt đầu bằng dấu gạch; đường dẫn được chuẩn hóa; xác thực PDF/đọc được từng file, tiếp tục nhận các file tốt khi có file lỗi. GPUI `ExternalPaths` kéo thả vào host; second launch gửi JSON versioned (giới hạn 512 path/128 KiB) qua named pipe per-user, mutex tồn tại suốt đời primary, pipe dùng default DACL và từ chối remote clients. Primary thêm các tab vào cửa sổ hiện có, focus tab cuối, activate app/window. E2E hai tiến trình kiểm tra Unicode, hai PDF hợp lệ + file thiếu, thứ tự tab, foreground và second process thoát. Windows GNU check/clippy `-D warnings`/test compile, fmt/diff, PowerShell parse đạt trên Mac. **Còn mở:** chưa chạy E2E Windows và chưa thử kéo file thật từ Explorer.
- **Trạng thái:** 🔄

### R2.18 · Bảng lệnh Ctrl+K với tìm không dấu · M
- **Mô tả:** bảng lệnh đọc từ một registry lệnh; gõ không dấu ("ky so") vẫn ra "Ký số". Mỗi milestone đăng ký lệnh của mình.
- **Tiêu chí:** (1) "ky so" và "nghi dinh" ra đúng mục; (2) Enter chạy lệnh; (3) registry trả danh sách đúng khi thêm lệnh mới.
- **Kiểm chứng:** test lọc không dấu; E2E.
- **Phụ thuộc:** R2.10, R2.23 (chuẩn hóa không dấu)
- **File:** `apps/native/crates/chef-ui/src/palette.rs`, `apps/native/crates/chef-app/src/commands.rs`
- **Tính năng:** A3
- **Ghi chú:** `CommandRegistry` cung cấp thêm/thay lệnh theo ID và xếp hạng tên/keyword bằng `chef_pdf::search::fold_query` dùng chung R2.23. Host mở palette Ctrl+K, gõ không dấu, điều hướng ↑/↓, Enter chạy lệnh đang bật; danh sách rỗng chỉ tối đa 50 mục. Unit test có “Ký số”, “Số trang theo Nghị định 30”, đăng ký thêm lệnh, thay ID trùng và thứ tự tìm. `scripts/e2e-native-palette.ps1` mặc định dùng debug actions, `CHEF_E2E_OS_INPUT=1` bật bàn phím Windows thật cho Ctrl+K, truy vấn ASCII, Enter, Escape. Parser PowerShell đạt trên Mac. **Còn mở:** chưa chạy E2E giao diện trên Windows; các lệnh Ký số và Nghị định còn disabled cho tới khi có tính năng native tương ứng.
- **Trạng thái:** 🔄

### M2.3 Viewer

### R2.19 · Viewer: cuộn liên tục · M
- **Mô tả:** cuộn liên tục một cột (chế độ mặc định của Electron `Viewer.tsx`), nhảy trang bằng PageUp và PageDown, cuộn bằng bánh xe chuột thật.
- **Tiêu chí:** (1) bánh xe chuột mượt; (2) PageDown đi đúng một trang; (3) không khung nào quá 50 ms khi cuộn 350 màn hình (đo bằng R1.37).
- **Kiểm chứng:** `scripts/e2e-native-perf-scroll.ps1` kiểm mode mặc định, PageUp/Down, cuộn 350 viewport và timing; opt-in `b2-other-window-top` kiểm wheel trên Viewer khi topmost khác che strip trên, rồi control wheel trên strip bị che. OS input chỉ chạy khi `CHEF_E2E_OS_INPUT=1`.
- **Phụ thuộc:** R1.32, R1.33
- **File:** `apps/native/crates/chef-app/src/viewer.rs`, `apps/native/crates/chef-app/src/debug.rs`
- **E2E:** `scripts/e2e-native-perf-scroll.ps1` (`perf-wheel`, `b2-other-window-top`); OS input chỉ khi `CHEF_E2E_OS_INPUT=1`
- **Tính năng:** B2
- **Ghi chú:** Continuous vẫn là mode mặc định. `e2e-native-perf-scroll.ps1` kiểm PageUp/PageDown qua debug action, cuộn 350 viewport theo nhịp, và xuất max/đếm GPUI Render-body trên/qua 50 ms cùng khoảng cách giữa lần gọi Render. Opt-in `CHEF_E2E_OS_INPUT=1` gửi phím PageDown/PageUp thật và dùng fixture `b2_top_window.ps1` + `b2_os_wheel.ps1` để kiểm wheel trên Viewer khi topmost khác che strip trên, rồi control wheel trên strip bị che. Mặc định không inject input OS. Timing là proxy, không đo frame đã present. Chưa chạy Windows wheel/UI hoặc có log frame/present thật.
- **Trạng thái:** 🔄

### R2.20 · Viewer: hai trang, kiểu sách, toàn màn hình · M
- **Mô tả:** chế độ hai trang và kiểu sách (trang đầu lẻ), toàn màn hình bằng F11 (phím của bản menu cũ, D67), trình chiếu.
- **Tiêu chí:** (1) kiểu sách đặt trang đầu đứng một mình; (2) F11 vào và ra toàn màn hình; (3) trình chiếu chỉ một trang và đi bằng mũi tên.
- **Kiểm chứng:** E2E; screenshot.
- **Phụ thuộc:** R2.19
- **File:** `apps/native/crates/chef-viewer/src/spread.rs`, `apps/native/crates/chef-app/src/viewer.rs`, `apps/native/crates/chef-app/src/commands.rs`, `apps/native/crates/chef-app/src/debug.rs`
- **Tính năng:** B2
- **Ghi chú:** (2026-11-14) Thêm geometry `SpreadLayout` thuần Rust cho Continuous/TwoPage/Book/Slideshow; Viewer có nút mode, command palette, arrow navigation, Escape thoát trình chiếu và tự vào fullscreen rồi khôi phục trạng thái fullscreen trước đó. Debug state xuất mode, visible pages và fullscreen; `e2e-native-spread.ps1` mặc định dùng debug actions, `CHEF_E2E_OS_INPUT=1` bật phím mũi tên và F11 thật. Chuyển layout dùng action dispatch. Đã có unit tests cho nhóm trang, book cover, geometry/fit và slide singleton. Kiểm chứng lại 2026-11-14: `chef-viewer` 22/22 tests với SDKROOT MacOSX15.4; E2E screenshot/runtime trên Windows chưa xác nhận; giữ R2.20 🔄.
- **Trạng thái:** 🔄

### R2.21 · Zoom, vừa khổ, xoay khung nhìn · M
- **Mô tả:** zoom bằng Ctrl+=, Ctrl+−, Ctrl+0 (phím của bản Electron, D67), vừa chiều rộng, vừa trang, nhập phần trăm, xoay khung nhìn 90°.
- **Tiêu chí:** (1) vừa chiều rộng khớp Electron ở ba cỡ cửa sổ; (2) zoom giữ vị trí cuộn; (3) mở file 305 MB không chậm hơn Electron (so với `perf-large`).
- **Kiểm chứng:** E2E `perf-large` (viết lại), `keyboard`.
- **Phụ thuộc:** R2.19
- **File:** `apps/native/crates/chef-app/src/viewer.rs`, `apps/native/crates/chef-app/src/commands.rs`, `apps/native/crates/chef-app/src/debug.rs`, `apps/native/crates/chef-app/src/main.rs`
- **E2E:** `scripts/e2e-native-zoom.ps1` (`CHEF_E2E_OS_INPUT=1` bật phím Windows thật; prepared, not run)
- **Tính năng:** B1
- **Ghi chú:** (2026-11-14) Đã thêm nút vừa trang, nhập zoom phần trăm, xoay khung nhìn 90° chỉ thay đổi cách hiển thị; debug action/state và script `e2e-native-zoom.ps1` đã chuẩn bị. Mặc định dùng debug actions; `CHEF_E2E_OS_INPUT=1` bật Ctrl+=, Ctrl+−, Ctrl+0 thật; parser PowerShell đạt trên Mac. Có unit regression cho chọn trang giữa viewport khi fit từ giữa trang, giữ page id sau khi fit lại khi đổi viewport và chuyển đổi rect/point ở cả bốn góc xoay. Đã sửa zoom giữ neo giữa viewport, fit-page ghim nhóm hiện tại và geometry xoay cho render/search/text selection/hit-test. Chưa xác minh runtime, chưa so vừa chiều rộng với Electron ở ba cỡ cửa sổ và chưa đo file 305 MB; giữ 🔄.
- **Trạng thái:** 🔄

### R2.22 · Thanh bên: thumbnail ảo hóa và mục lục · M
- **Mô tả:** thumbnail chỉ render dòng nhìn thấy, cap 60 thumbnail mỗi tài liệu (`c3496fc`), chiều cao dòng tính từ kích thước trang. Mục lục từ bookmark của pdfium.
- **Tiêu chí:** (1) chỉ dòng nhìn thấy được render; (2) không quá 60 thumbnail; (3) bấm mục lục nhảy đúng trang.
- **Kiểm chứng:** đếm thumbnail; E2E `scripts/e2e-native-toc.ps1` (`toc`).
- **Phụ thuộc:** R2.21
- **File:** `apps/native/crates/chef-viewer/src/sidebar.rs`, `apps/native/crates/chef-pdf/src/render.rs`, `apps/native/crates/chef-app/src/viewer.rs`
- **E2E:** `scripts/e2e-native-toc.ps1` (`toc`)
- **Tính năng:** B3
- **Ghi chú:** (2026-11-14) Có `SidebarLayout` theo tỷ lệ trang, chỉ trả hàng giao viewport và giới hạn 60; cache thumbnail nhỏ riêng xóa ảnh/cache/pending khi ra khỏi vùng và khi tab rời foreground. Sidebar Trang/Mục lục đọc outline từ pdfium, hỗ trợ depth và destination; chọn bookmark tới đúng page index, giữ zoom. Kiểm chứng lại 2026-11-14: `chef-viewer` 22/22 tests với SDKROOT MacOSX15.4. E2E tạo PDF 500 trang rất mỏng để ép hard cap 60, có bookmark trang 9; mặc định click qua debug pipe, `CHEF_E2E_OS_INPUT=1` bật chuột Windows thật để đổi chế độ Mục lục/chọn bookmark; parser đạt trên Mac. **Còn mở:** chưa chạy runtime Windows; tiêu chí hình ảnh/click thực tế và E2E `toc` chưa xác nhận.
- **Trạng thái:** 🔄

### R2.23 · Engine tìm không dấu · M
- **Mô tả:** lấy chữ từ pdfium theo trang, chuẩn hóa bỏ dấu (NFD, bỏ dấu kết hợp, đ thành d, Đ thành D, chữ thường). Trả vị trí từng kết quả.
- **Tiêu chí:** (1) "nghi dinh" tìm ra "nghị định" và "NGHỊ ĐỊNH"; (2) vị trí trả về nằm đúng hộp chữ; (3) chuẩn hóa dùng chung với R2.18.
- **Kiểm chứng:** test đơn vị với bảng cụm từ tiếng Việt.
- **Phụ thuộc:** R1.28
- **File:** `apps/native/crates/chef-pdf/src/search.rs`
- **Tính năng:** B4
- **Ghi chú:** (2026-11-09) Bỏ dấu bằng NFD trong `chef-pdf/src/search.rs`. Test: "nghi dinh" khớp "nghị định" và "NGHỊ ĐỊNH"; vị trí khớp là hộp chữ thật (test trên PDF mẫu). Dùng chung với R2.18 khi có.
- **Trạng thái:** ✅

### R2.24 · UI tìm và tô sáng · S
- **Mô tả:** Ctrl+F mở ô tìm, tô sáng mọi kết quả, Enter và Shift+Enter đi tới, đếm "3/12".
- **Tiêu chí:** (1) tô sáng khớp `--c-highlight` và `--c-highlight-selected`; (2) đếm đúng; (3) Esc đóng và bỏ tô sáng.
- **Kiểm chứng:** E2E `keyboard`; screenshot.
- **Phụ thuộc:** R2.23
- **File:** `apps/native/crates/chef-viewer/src/find.rs`
- **E2E:** `keyboard`
- **Tính năng:** B4
- **Ghi chú:** (2026-11-09) Ô tìm trên thanh viewer; quét 1000 trang trong 8 s; tô sáng bằng `--c-highlight` và `--c-highlight-selected`; Enter, Shift+Enter có vòng lại; Esc xóa. E2E `scripts/e2e-native-find.ps1` 14/14.
- **Trạng thái:** ✅

### R2.25a · Hộp chữ và hit-test · M
- **Mô tả:** lấy hộp của từng ký tự bằng `FPDFText`, tìm ký tự dưới con trỏ, xây dựng vùng chọn theo dòng.
- **Tiêu chí:** (1) ký tự dưới con trỏ đúng; (2) vùng chọn qua nhiều dòng đúng thứ tự đọc; (3) trang không có chữ (scan) trả rỗng, không lỗi.
- **Kiểm chứng:** test với PDF có chữ và trang scan.
- **Phụ thuộc:** R1.28
- **File:** `apps/native/crates/chef-pdf/src/text.rs`
- **Tính năng:** B5
- **Ghi chú:** (2026-11-09) `chef-pdf/src/text.rs`: hộp glyph (tight) để chọn và hộp dòng (loose) để gom dòng. Hit-test chọn ký tự chứa điểm, không có thì ký tự gần nhất. Trang scan trả rỗng (test với PDF scan).
- **Trạng thái:** ✅

### R2.25b · Chọn và copy chữ · M
- **Mô tả:** kéo chuột để chọn chữ, vẽ vùng chọn, Ctrl+C đưa chữ vào clipboard (Unicode), chọn bằng Ctrl+A trong trang.
- **Tiêu chí:** (1) chuỗi copy đúng ký tự tiếng Việt; (2) vùng chọn đổi theo kéo; (3) clipboard có chuỗi Unicode, không có ký tự rác.
- **Kiểm chứng:** E2E (copy rồi đọc clipboard); test.
- **Phụ thuộc:** R2.25a
- **File:** `apps/native/crates/chef-viewer/src/selection.rs`
- **E2E:** `keyboard` (phần copy)
- **Tính năng:** B5
- **Ghi chú:** (2026-11-09) Kéo chuột chọn, Ctrl+A chọn trang nhìn thấy, Ctrl+C đưa Unicode lên clipboard, xuống dòng theo dòng thật. E2E `scripts/e2e-native-select.ps1` 5/5.
- **Trạng thái:** ✅

### R2.26 · Mở file có mật khẩu · S
- **Mô tả:** hỏi mật khẩu khi pdfium báo cần mật khẩu, không ghi mật khẩu ra đĩa, giữ trong bộ nhớ (zeroize khi đóng tab).
- **Tiêu chí:** (1) sai mật khẩu báo lại; (2) mật khẩu không xuất hiện trong log (kiểm bằng grep log); (3) đóng tab xóa mật khẩu khỏi bộ nhớ.
- **Kiểm chứng:** `scripts/e2e-native-password.ps1`; test với PDF mẫu có mật khẩu.
- **Phụ thuộc:** R2.10, R1.28
- **File:** `apps/native/crates/chef-app/src/password.rs`, `apps/native/crates/chef-pdf/src/render.rs`, `apps/native/crates/chef-pdf/Cargo.toml`, `apps/native/crates/chef-ui/src/text_input.rs`, `apps/native/crates/chef-ui/src/text_buffer.rs`, `apps/native/crates/chef-ui/Cargo.toml`, `apps/native/crates/chef-app/src/viewer.rs`, `apps/native/crates/chef-app/src/tabs_host.rs`
- **Tính năng:** B6
- **Ghi chú:** (2026-11-14) Ô mật khẩu dùng secure mode: nội dung được che khi vẽ, Ctrl+C/Ctrl+X bị chặn, `TextBuffer` zeroize khi xóa và khi `TextInput` bị drop. Viewer truyền `Zeroizing<String>` xuyên qua `Job::Open`, nên cả đường lỗi trước lúc gửi lẫn khi render thread drop job đều xóa vùng chuỗi do app sở hữu. Khi đóng tab, viewer xóa buffer và drop mật khẩu nguồn. `e2e-native-password.ps1` cô lập PDF fixture, userData và stderr cho mỗi lượt, chờ debug pipe sẵn sàng, rồi quét chính xác stderr và toàn bộ file dữ liệu app để dò mật khẩu; kiểm buffer sau mật khẩu sai, khi đóng tab lúc prompt còn chữ, và thả mật khẩu nguồn sau khi mở đúng. Parser đạt trên Mac, script chưa chạy Windows. Unit tests xác nhận buffer state sau zeroize và masking giữ offset UTF-8; đây không phải bằng chứng về toàn bộ physical-memory lifetime. Các bản sao/transient allocation bên trong GPUI hoặc pdfium và trang bộ nhớ do allocator quản lý ngoài vùng String hiện tại chưa thể chứng minh đã bị ghi đè; không khẳng định physical-memory erasure.
- **Trạng thái:** 🔄

### R2.27 · Thuộc tính tài liệu · S
- **Mô tả:** hiện tiêu đề, tác giả, số trang, khổ giấy, phiên bản PDF, dung lượng từ pdfium và file. Phần lấy từ lõi để M3.
- **Tiêu chí:** (1) số liệu khớp bản Electron với PDF mẫu; (2) không cần lõi chạy.
- **Kiểm chứng:** so với Electron.
- **Phụ thuộc:** R2.10, R1.28
- **File:** `apps/native/crates/chef-app/src/properties.rs`
- **Tính năng:** B7
- **Ghi chú:** (2026-11-09w) Hộp thoại Thuộc tính (Ctrl+D): tên, vị trí, dung lượng, phiên bản PDF, số trang, khổ trang hiện tại và 8 thẻ metadata lấy từ pdfium. E2E e2e-native-properties khớp pypdfium2 trên PDF mẫu (scripts/gen-native-props-fixture.py): phiên bản, số trang, khổ A4, metadata. Lệch: ngày PDF hiển thị dd/mm/yyyy hh:mm theo giờ ghi trong file (không đổi múi giờ như Intl của Electron); font, chữ ký, mã hóa thuộc M3.
- **Trạng thái:** ✅

### R2.28 · Đọc ban đêm và đảo màu trang · M
- **Mô tả:** chế độ đọc ban đêm đảo màu bitmap trang trong Rust (thay `invert(1) hue-rotate(180deg)` của `Viewer.css`). Ghi quyết định D79 (CH-R3).
- **Tiêu chí:** (1) màu đảo khớp bản Electron ở ảnh mẫu, sai lệch nhỏ hơn ngưỡng R2.02; (2) không tăng cache quá 10% so với bình thường; (3) D79 ghi trong NOTES.
- **Kiểm chứng:** ui-audit; đo cache.
- **Phụ thuộc:** R2.02, R1.33
- **File:** `apps/native/crates/chef-app/src/night.rs`, `apps/native/crates/chef-app/src/viewer.rs`
- **E2E:** `ui-audit` (màn hình đọc ban đêm)
- **Tính năng:** B9
- **Ghi chú:** (2026-11-14) D79 nằm ở `docs/NOTES.md` (không phải D75). Công thức CPU dùng cùng thứ tự CSS `invert(1)` rồi `hue-rotate(180deg)`, đổi tại chỗ; khi bật/tắt, Viewer evict cache ảnh trang và chuyển ảnh cũ cho GPUI giải phóng. Unit tests so màu RGB không xám với đầu ra công thức, giữ alpha/capacity và kiểm helper evict trả toàn bộ ảnh cache. State debug bổ sung `cachedBytes` từ bộ đếm byte thực của LRU. `e2e-native-night.ps1` tự tạo PDF mẫu khi không truyền fixture, chờ cache ngày/đêm ổn định, yêu cầu cùng tập trang và tính mức tăng byte cache; parser đạt trên Mac, chưa chạy Windows. Chưa có ảnh Rust/Electron theo R2.02/MAN-5 hoặc số đo runtime để xác nhận ngưỡng 10%; giữ 🔄.
- **Trạng thái:** 🔄

### R2.29 · Chip "có chữ, scan, hỗn hợp" · XS
- **Mô tả:** thanh dưới cho biết tài liệu có chữ, không có chữ (scan) hay hỗn hợp, dựa trên số ký tự của từng trang đã biết.
- **Tiêu chí:** (1) ba trạng thái đúng với PDF mẫu; (2) không đọc toàn bộ file để biết (chỉ lấy mẫu).
- **Kiểm chứng:** test với ba PDF mẫu.
- **Phụ thuộc:** R2.25a
- **File:** `apps/native/crates/chef-app/src/statusbar.rs`
- **Tính năng:** B12 (một phần; chỉ báo trên viewer)
- **Ghi chú:** (2026-11-09) Chỉ báo lấy mẫu 8 trang đều nhau (không đọc cả file). E2E `scripts/e2e-native-kind.ps1` 3/3 với PDF chữ, scan, hỗn hợp.
- **Trạng thái:** ✅

### R2.30 · Hộp chọn file mở và lưu · S
- **Mô tả:** hộp thoại mở và lưu của Windows với lọc PDF, mở nhiều file, thư mục mặc định từ cài đặt.
- **Tiêu chí:** (1) lọc PDF mặc định; (2) thư mục mặc định đúng; (3) hủy không báo lỗi.
- **Kiểm chứng:** E2E hoặc test thủ công.
- **Phụ thuộc:** R2.14
- **File:** `apps/native/crates/chef-app/src/dialogs.rs`
- **Tính năng:** A5 (hộp chọn file)
- **Ghi chú:** (2026-11-09v) `chef-app/src/dialogs.rs`: `GetOpenFileNameW` và `GetSaveFileNameW` của comdlg32, PDF là filter đầu, chọn nhiều tệp, thư mục bắt đầu lấy từ `defaultSaveDir`. Ctrl+O mở các tệp được chọn thành thẻ; hủy trả danh sách rỗng/None. (2026-11-14) Sửa `OPENFILENAMEW.nMaxFile` để khớp buffer; Save As nay đặt `.pdf` mặc định và nhắc ghi đè. Thêm test cho cờ open/save, default extension và kết quả hủy; `e2e-native-start.ps1` dùng `CHEF_E2E_CLOSE_DIALOGS=1` kiểm hủy cả Open và Save As, giữ nguyên tab và không báo lỗi. Bổ sung `state.fileDialog` chỉ trong `CHEF_E2E=1` để E2E xác nhận request thực tế mang đúng `defaultSaveDir`, filter index, buffer, multi-select, extension và mask cờ. Parser đạt trên Mac; chưa chạy Windows hoặc xác nhận giao diện native thực sự mở đúng thư mục/filter, giữ 🔄.
- **Trạng thái:** 🔄

### R2.31 · Phím tắt viewer · S
- **Mô tả:** bảng phím tắt của viewer: Ctrl+O, Ctrl+F, Ctrl+K, Ctrl+Tab, Ctrl+=, Ctrl+−, Ctrl+0, PageUp, PageDown, F11. Theo D67.
- **Tiêu chí:** (1) mọi phím đúng hành động; (2) không trùng với phím của điều khiển đang có tiêu điểm.
- **Kiểm chứng:** E2E `keyboard`.
- **Phụ thuộc:** R2.19, R2.21, R2.24
- **File:** `apps/native/crates/chef-app/src/viewer.rs`, `tabs_host.rs`, `commands.rs`; `apps/native/crates/chef-ui/src/text_input.rs`
- **E2E:** `scripts/e2e-native-perf-scroll.ps1` (opt-in physical PageUp/PageDown), `scripts/e2e-native-keyboard.ps1` (`CHEF_E2E_OS_INPUT=1`, TextInput focus priority)
- **Tính năng:** A3 (phím tắt)
- **Ghi chú:** (2026-11-14) Binding nằm trong `viewer.rs` (Ctrl+F/A/C, Ctrl+=/−/0, PageUp/Down, F11, Ctrl+O, Ctrl+D, v.v.), `commands.rs` (Ctrl+K), và `tabs_host.rs` (Ctrl+Tab/Shift+Ctrl+Tab). Context `Viewer` chứa viewer/host; `TextInput` có binding riêng cho Ctrl+A/C/X và phím sửa văn bản; PageUp/PageDown trong TextInput đưa caret về đầu/cuối để không làm Viewer đổi trang; slider dùng chúng để chỉnh giá trị. `e2e-native-keyboard.ps1` kiểm tra hai phím này bằng input vật lý khi ô tìm focus và xác nhận trang không đổi; parser đạt, chưa chạy Windows. Script cần `CHEF_E2E_OS_INPUT=1` và được bỏ qua bởi runner gộp để tránh chiếm input. Chưa chạy E2E phím vật lý toàn ma trận cho viewer, slider và palette; action dispatch không chứng minh ưu tiên focus. Giữ 🔄 đến khi xác nhận trên Windows.
- **Trạng thái:** 🔄

### R2.32 · Điểm kiểm M2 · —
- **Mô tả:** chạy ui-audit cho màn hình xem, so ảnh (R2.02), đo RAM (R1.37) cho file 1000 trang, mở và cuộn 350 màn hình.
- **Tiêu chí:** (1) báo cáo ui-audit liệt kê màn hình vượt ngưỡng; (2) RAM ghi cạnh Electron; (3) MAN-5 đã xem ảnh so sánh.
- **Kiểm chứng:** báo cáo trong NOTES.
- **Phụ thuộc:** R2.01 đến R2.31
- **Tính năng:** —
- **Trạng thái:** ⬜

---

## M3: Phiên và thao tác

**Mục tiêu:** nối bản Rust với lõi Python qua JSON-RPC, chạy lõi lười (chỉ khi có thao tác sửa), mô hình phiên của BLUEPRINT_RUST §4, undo, lưu, khôi phục sau crash.
**Demo:** mở file, chỉ xem thì không có tiến trình `chef-core`; xoay một trang thì lõi khởi động, viewer chuyển sang rev file, giữ vị trí cuộn; undo và lưu đúng; kill app giữa chừng rồi khôi phục.
**Đầu vào:** viewer cuộn liên tục (R2.19) và hộp thoại (R2.10). Không chờ điểm kiểm M2 (đổi 2026-11-11, D86).
**Thứ tự:** lát cắt dọc đi trước: R3.02 → R3.04 → R3.05 → R3.06 → R3.08 (chỉ `page.rotate`) → R3.11 → R3.12, làm trước phần còn lại của M2. Sau lát cắt mới làm R3.03, R3.07, R3.09, R3.13, R3.14. Khi R3.02 xong, chạy lại R1.37 và R1.38 để có `coreMB`.

### M3.0 RPC và tiến trình lõi

### R3.01 · Client JSON-RPC · M
- **Mô tả:** framing mỗi dòng một JSON theo CONTRACTS §3, `id` tăng dần, thời gian chờ, thông báo (notification) đẩy về UI qua kênh. Đường đi `RpcServer` ở phía Python không đổi.
- **Tiêu chí:** (1) yêu cầu và phản hồi khớp `id`; (2) thông báo đến đúng sự kiện UI; (3) lỗi JSON hỏng không làm sập client.
- **Kiểm chứng:** test với lõi giả và với lõi thật (`system.ping`).
- **Phụ thuộc:** R1.02
- **File:** `apps/native/crates/chef-rpc/src/client.rs`, `apps/native/crates/chef-rpc/src/framing.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09w) chef-rpc: framing.rs (một object JSON mỗi dòng, id tăng dần, phân biệt phản hồi và thông báo) và client.rs (luồng đọc nền, khớp phản hồi theo id, thời gian chờ, kênh thông báo, dòng hỏng được bỏ qua và đếm). 11 test: lõi giả qua pipe (khớp id, dòng hỏng, thông báo, lỗi RPC, hết giờ, đóng) và system.ping tới lõi Python thật (core/.venv). cargo clippy sạch.
- **Trạng thái:** ✅

### R3.02 · Giám sát lõi: spawn, Job Object, ping, khởi động lại · M
- **Mô tả:** khởi động `chef-core` với `CREATE_NO_WINDOW` (BLUEPRINT_RUST §2.1), gắn vào Job Object để tự chết khi app thoát. Gửi `system.ping`. Khởi động lại khi chết và phát `core-status` (`starting`, `ready`, `crashed`, `restarting`).
- **Tiêu chí:** (1) không có cửa sổ console khi lõi chạy; (2) tắt app thì tiến trình lõi cũng mất (kiểm bằng bảng tiến trình); (3) lõi bị kill thì khởi động lại và báo UI.
- **Kiểm chứng:** test; kiểm bảng tiến trình; E2E `integration` (phần lõi).
- **Phụ thuộc:** R3.01
- **File:** `apps/native/crates/chef-rpc/src/supervisor.rs`
- **E2E:** `integration`
- **Tính năng:** —
- **Ghi chú:** (2026-11-11) `chef-rpc/src/job.rs`, `client.rs`, `supervisor.rs`. Phát hiện: `core/.venv/Scripts/python.exe` là launcher, Python base là tiến trình con (PID 484 → 17400, đo bằng CIM). Kill launcher không dừng lõi, nên Client của R3.01 để lại tiến trình mồ côi. Cách làm (D88): spawn `CREATE_SUSPENDED` và `CREATE_NO_WINDOW`, gán vào Job `KILL_ON_JOB_CLOSE`, resume các luồng (không race). Luồng chờ thoát terminate job để pipe đóng, nên yêu cầu đang chờ nhận `Closed` ngay. Stderr đọc liên tục (không làm treo lõi). Lùi dần 500 ms đến 30 s; ngừng sau 5 lần chết liên tiếp không sống đủ 60 s. Test (23 test chef-rpc, hai lần lặp đều xanh): ping lõi thật; dừng xong không PID nào còn sống; giết cả cây, giết riêng launcher, giết riêng python.exe con: mỗi lần đều chuỗi `crashed → restarting → starting → ready` và mọi PID lượt cũ chết (kể cả PID không bị giết); shutdown ngay sau start không treo (hồi quy, 20 vòng; cửa sổ race hẹp nên không chắc chắn tái hiện lỗi cũ); lõi không có cửa sổ console hiện (`GetConsoleWindow`); lùi dần và ngừng sau giới hạn. **Phát hiện khi kiểm:** job của lõi còn chứa `conhost.exe` (do `CREATE_NO_WINDOW`), nên chọn PID theo tên image, không lấy PID đầu tiên. Chuyển sang R3.03: E2E `integration` (phần lõi) và kiểm "kill app → không còn PID lõi" (cần app nối lõi).
- **Trạng thái:** ✅

### R3.03 · Khởi động lười và tự tắt · S
- **Mô tả:** lõi chỉ khởi động khi có thao tác cần nó. Tự tắt sau 10 phút không dùng (R5, chỉnh được). Chỉ đọc file thì không có tiến trình lõi.
- **Tiêu chí:** (1) mở, cuộn và chọn chữ không tạo tiến trình `chef-core` (kiểm bảng tiến trình); (2) sau 10 phút rảnh lõi tắt; (3) thao tác tiếp theo khởi động lại lõi không mất dữ liệu.
- **Kiểm chứng:** E2E thời gian ngắn (cấu hình 10 giây khi test); bảng tiến trình.
- **Phụ thuộc:** R3.02 (bỏ R2.32 ngày 2026-11-11: điểm kiểm M2 không phải phụ thuộc kỹ thuật)
- **Chuyển từ R3.02 (2026-11-11):** E2E `integration` (phần lõi) và kiểm "kill app → không còn PID lõi" bằng bảng tiến trình. Hai kiểm này cần app nối lõi, nên làm ở đây.
- **File:** `apps/native/crates/chef-rpc/src/supervisor.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-11) Ở tầng supervisor: `Supervisor::lazy` không khởi động lõi cho đến yêu cầu đầu (test: không có sự kiện, không có tiến trình trước yêu cầu). Lõi tự tắt khi rảnh quá `idle_stop` (mặc định 600 giây, tức 10 phút) và báo `stopped` (D89); test dùng 800 ms. Lý do giữ lõi: job (`job:<id>`) và phiên mở (`session:<id>`), vì `system.shutdown` xóa thư mục phiên (CONTRACTS §4) nên tắt khi còn phiên sẽ mất revision chưa lưu. `chef-app/session.rs` gọi `session_opened`. Test: tự tắt rồi khởi động lại theo yêu cầu, lõi có job hoặc phiên không tự tắt. (2026-11-14) `session_closed` hiện được gọi sau `session.close` thành công ở `tabs_host.rs` và khi đóng session từ viewer. `CHEF_E2E_IDLE_STOP_MS` chỉ điều chỉnh timeout trong chế độ E2E (1–60.000 ms; mặc định production vẫn 600 giây). `e2e-native-integration.ps1` kiểm cây tiến trình: mở PDF, cuộn, tìm và chọn chữ không khởi động `chef-core`, thao tác sửa đầu tiên mới khởi động; đóng phiên sạch khiến lõi tự dừng; mở lại tài liệu qua single-instance và sửa tiếp khiến một lõi mới khởi động; thoát app dọn PID cũ/mới. Windows GNU `cargo check --tests` và Clippy `-D warnings` trên target Windows đạt; E2E/runtime chưa chạy, giữ 🔄.
- **Trạng thái:** 🔄

### M3.1 Phiên và revision

### R3.04 · Dấu vết file gốc và cảnh báo đổi file · S
- **Mô tả:** khi mở, ghi kích thước, mtime và băm 64 KB đầu và cuối. Trước thao tác đầu, kiểm lại và cảnh báo nếu file gốc đã đổi.
- **Tiêu chí:** (1) đổi file gốc bên ngoài thì cảnh báo trước khi tạo phiên; (2) không đổi thì đi tiếp; (3) cảnh báo bằng tiếng Việt, có "xem lại" và "mở lại".
- **Kiểm chứng:** test: sửa file gốc giữa chừng.
- **Phụ thuộc:** R2.10
- **File:** `apps/native/crates/chef-app/src/source_guard.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-11) `source_guard.rs`: vân tay gồm kích thước, mtime và FNV-1a 64 bit của 64 KB đầu và cuối; `check` trả `Same`, `Changed`, `Missing` hoặc `Unreadable`; 8 unit test bao gồm file rỗng và file bị thay bằng thư mục. (2026-11-14) Viewer gọi guard trước `session.open`; cảnh báo có nút "Xem lại"/"Mở lại" và khóa i18n được đồng bộ ở `apps/ui` cùng assets native theo D87. Integration E2E chạy locale vi, đọc title/body và nhãn hai nút từ debug state lấy đúng các chuỗi của banner; thử cả hai nút và xác nhận Review chưa tạo session/revision. Bổ sung xác nhận PDFium thấy file 2 trang ban đầu, rồi nhận 3 trang sau Reopen. Script parser sạch nhưng chưa chạy trên Windows.
- **Trạng thái:** 🔄

### R3.05 · session.open lần thao tác đầu · M
- **Mô tả:** thao tác sửa đầu tiên gọi `session.open` với đường dẫn file gốc và mật khẩu (nếu có, lấy từ bộ nhớ), lõi tạo `rev-0000.pdf` và `meta.json` (CONTRACTS §4). Mật khẩu không ghi ra đĩa.
- **Tiêu chí:** (1) sau thao tác đầu có thư mục phiên và rev-0000; (2) file mã hóa mở đúng bằng mật khẩu đã nhập; (3) log không có mật khẩu.
- **Kiểm chứng:** test; kiểm thư mục phiên; grep log.
- **Phụ thuộc:** R3.02, R3.04, R2.26
- **File:** `apps/native/crates/chef-app/src/session.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-11) `session.rs`: `open` kiểm vân tay (R3.04), rồi gọi `session.open`; map `PASSWORD_REQUIRED`, `PASSWORD_INVALID`. 4 test với lõi thật và PDF mã hóa tạo bằng pikepdf: mở không mật khẩu tạo `rev-0000.pdf` và `meta.json`; thiếu hoặc sai mật khẩu báo đúng kind; đúng mật khẩu mở được, và mật khẩu không xuất hiện trong mọi file của userData lẫn nhật ký lõi; file gốc đổi thì không tạo thư mục phiên. (2026-11-14) Python `tests/test_session.py` đạt 21/21 trong môi trường tạm Python 3.14 từ `uv.lock`, bao gồm mở phiên/mã hóa; Rust app và Windows E2E vẫn chưa chạy. Hạn chế: chuỗi mật khẩu qua RPC có bản sao trong `Value` và dòng JSON, không zeroize được. Tiêu chí 1 kiểm ở mức hàm; đường UI gọi hàm này là R3.06/R3.08.
- **Trạng thái:** ✅

### R3.06 · Chuyển viewer sang rev file, giữ vị trí · M
- **Mô tả:** sau mỗi revision mới, viewer mở lại từ rev file và giữ vị trí cuộn, zoom, chọn chữ. `changedPages` của kết quả thao tác quyết định trang nào xóa bitmap. Đây là rủi ro đã nêu ở BLUEPRINT_RUST §4.
- **Tiêu chí:** (1) vị trí cuộn và zoom không đổi sau thao tác; (2) chỉ trang trong `changedPages` bị xóa bitmap, đo bằng R1.33; (3) tìm kiếm còn kết quả sau thao tác (hoặc được làm mới rõ ràng).
- **Kiểm chứng:** E2E với thao tác xoay một trang; đo bitmap.
- **Phụ thuộc:** R3.05, R2.19
- **File:** `apps/native/crates/chef-viewer/src/reload.rs`, `apps/native/crates/chef-viewer/src/spread.rs`, `apps/native/crates/chef-app/src/viewer.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-14) Có helper chụp/khôi phục trang neo và zoom; UI mở revision ở worker, chỉ bỏ bitmap trang lớn và thumbnail theo `changedPages`, giữ text selection theo page/char index, làm mới truy vấn tìm kiếm. (2026-11-14p) Sửa neo theo hàng `SpreadLayout` cho TwoPage/Book/Slideshow, giữ hàng neo, phần trăm cuộn và zoom qua các mode; sau revision tắt cả `fit_width` và `fit_page`. Kết quả transport không rõ của Rotate/Undo/Redo khóa sửa và yêu cầu nạp lại `session.state`; lỗi RPC tường minh không bị xem là mơ hồ. `chef-viewer` 22/22 test đạt, gồm iterator cache chỉ đọc không đổi LRU. (2026-11-14w) Debug state xuất page→`RenderImage.id`; audit tại lúc apply revision ghi cache trước, `changedPages`, và chính xác image ID bị remove. Integration E2E đợi trang 0/1 cache trước/sau `page.rotate`, xác nhận trang đổi bị evict + render ID mới, trang không đổi giữ ID; fixture được sửa để external mutation cho đúng ba trang. Thêm `input.focused` ack để chờ ô tìm nhận focus trước khi gõ, so tỷ lệ scroll qua đổi chiều cao trang và dùng clipboard sentinel; script kiểm source warning và Ctrl+Z/Ctrl+Y thật. (2026-11-14) Bổ sung đối chiếu PDFium: tên revision, số trang và hình học trang sau rotate/undo/redo; xác nhận focus cửa sổ foreground trước input. Windows GNU workspace clippy và compile test binaries, fmt, parser PowerShell đạt trên Mac; E2E/native Windows runtime chưa chạy, nên R3.06 giữ 🔄.
- **Trạng thái:** 🔄

### R3.07 · Codegen chef-contracts từ JSON Schema · M
- **Mô tả:** sinh struct Rust cho `Params` của mọi operation và cho `ops.run` từ JSON Schema (`core/chef_core/codegen.py`), kèm kiểm tra lệch trong CI. Dùng kết quả của R1.42.
- **Tiêu chí:** (1) struct sinh cho mọi operation, không thiếu; (2) đổi một `Params` ở lõi làm build Rust lỗi hoặc `--check` báo lệch; (3) không đổi hành vi lõi.
- **Kiểm chứng:** script `--check` trong CI; pytest lõi xanh.
- **Phụ thuộc:** R1.42
- **File:** `scripts/gen-native-contracts.mjs`, `apps/native/crates/chef-contracts/src/generated.rs`
- **Tính năng:** —
- **Trạng thái:** ⬜

### R3.08 · ops.list và ops.run với job runner · M
- **Mô tả:** gọi `ops.list` lấy danh sách, `ops.run` với `Params` kiểu Rust, nhận `jobId`, theo dõi tiến độ, hủy bằng `jobs.cancel`. Trong lát cắt dọc chỉ cần `Params` của `page.rotate`, sinh bằng đường typify của R1.42 (hoặc viết tay một struct, thay bằng bản sinh khi R3.07 xong). Codegen cho mọi operation (R3.07) không chặn task này; nó chặn R5.02.
- **Tiêu chí:** (1) chạy một operation đơn giản (`page.rotate`) và thấy trang đổi; (2) hủy giữa chừng đưa job về trạng thái hủy; (3) lỗi `invalid_params` hiện thông báo tiếng Việt.
- **Kiểm chứng:** E2E `integration`; test lõi giả.
- **Phụ thuộc:** R3.06, R1.42 (bỏ R3.07 ngày 2026-11-11)
- **File:** `apps/native/crates/chef-rpc/src/ops.rs`
- **E2E:** `integration`
- **Tính năng:** —
- **Ghi chú:** (2026-11-11) Làm trước R3.06 (lát cắt, xem nhật ký): `ops::start` (ops.run), `wait_job` (job.finished, job.failed, job.cancelled), `cancel` (jobs.cancel). 4 test với lõi thật: page.rotate chạy như job; rev-0001 có `/Rotate 90` ở trang 0 và vẫn 2 trang; góc 45 bị từ chối `INVALID_PARAMS` với khóa `errors.INVALID_PARAMS`. (2026-11-11, bổ sung) Tiêu chí 2 đạt: `page.duplicate` trên 4000 trang, hủy sau 30 ms cho `job.cancelled`, revision vẫn 0 và không có bước hoàn tác (test `cancel_stops_a_running_job_and_leaves_the_revision_alone`). Chưa có E2E `integration`: chuyển sang lúc app nối lõi (R3.03). (2026-11-14v) Supervisor giữ job hold qua timeout và giải phóng khi forwarder nhận terminal notification; xử lý terminal trước response đăng ký bằng ledger bounded, gắn registration/forwarder với run epoch và từ chối `ops.start` nếu epoch đã stale. Thêm helper tests cho terminal sau timeout, trước registration, progress/unrelated events, forwarding nguyên sự kiện, stale epoch và bảo toàn session hold. Bổ sung regression test `viewer::call_error_text` và kiểm `INVALID_PARAMS` → `errors.INVALID_PARAMS`; toàn bộ test host của `chef-rpc` đạt 14/14. Windows GNU `cargo check --tests` và Clippy `-D warnings` đạt, nên viewer regression và nhánh Windows đã biên dịch; test viewer chưa thực thi vì máy Mac thiếu Metal compiler. Chưa chạy app-level E2E `integration` và chưa thực thi regression test viewer. Vì vậy R3.08 vẫn đang làm; `wait_job` còn drop notification của job khác, phần điều phối sự kiện theo dõi ở R3.09.
- **Trạng thái:** 🔄

### R3.09 · Panel tiến trình (JobPanel) · S
- **Mô tả:** danh sách job đang chạy và vừa xong, thanh tiến độ, nút hủy, lỗi từng job. Thay `JobPanel.css`. Vòng quay `spin` và thanh `indeterminate` (keyframes trong `components.css`).
- **Tiêu chí:** (1) tiến độ cập nhật theo thông báo; (2) hủy hiện trạng thái "đã hủy"; (3) giữ lỗi của job đến khi người dùng đóng.
- **Kiểm chứng:** ui-audit; E2E.
- **Phụ thuộc:** R3.08
- **File:** `apps/native/crates/chef-ui/src/jobs_panel.rs`
- **Tính năng:** —
- **Trạng thái:** ⬜

### R3.10 · Ánh xạ lỗi sang thông báo tiếng Việt · S
- **Mô tả:** lỗi lõi có `kind` (ví dụ `PASSWORD_REQUIRED`, `PASSWORD_INVALID`) ánh xạ sang chuỗi trong `vi.json`, như `lib/errors` của bản Electron.
- **Tiêu chí:** (1) mọi `kind` đã có trong bản Electron có chuỗi tương ứng; (2) lỗi không biết vẫn hiện được, không làm sập; (3) chuỗi khớp bản Electron.
- **Kiểm chứng:** test đọc danh sách `kind`; so chuỗi.
- **Phụ thuộc:** R3.01, R2.13
- **File:** `apps/native/crates/chef-rpc/src/errors.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09w) chef-rpc/src/errors.rs: ERROR_KINDS (27 kind) khớp ErrorKinds của packages/contracts/src/rpc.ts (test đọc file TS gốc), kind_of trả UNKNOWN cho kind lạ hoặc thiếu kind, message_key ra errors.<KIND>. Test: mọi kind và UNKNOWN có chuỗi trong i18n bằng đúng chuỗi của bản Electron. cargo clippy sạch.
- **Trạng thái:** ✅

### R3.11 · Hoàn tác và làm lại · S
- **Mô tả:** Ctrl+Z và Ctrl+Y gọi `session.undo` và `session.redo`, rồi áp dụng như R3.06.
- **Tiêu chí:** (1) undo và redo đổi đúng trang; (2) giới hạn 50 revision, rev-0000 luôn có; (3) nút hoàn tác mờ khi không còn gì để hoàn tác.
- **Kiểm chứng:** E2E `keyboard`; test.
- **Phụ thuộc:** R3.06
- **File:** `apps/native/crates/chef-app/src/undo.rs`
- **E2E:** `keyboard`
- **Tính năng:** A6
- **Ghi chú:** (2026-11-11) RPC undo/redo và giới hạn 50 revision đạt unit test. Viewer có binding Ctrl+Z/Y, guard tập trung và trạng thái disabled theo `canUndo/canRedo`. `scripts/e2e-native-integration.ps1` mặc định phát debug actions; đặt `CHEF_E2E_OS_INPUT=1` để gửi Ctrl+Z/Ctrl+Y thật. E2E kiểm revision, dirty và trạng thái nút Undo/Redo; lần rà 2026-11-14 bổ sung xác nhận tên revision và hình học trang bằng PDFium sau undo/redo. RPC test còn kiểm lịch sử tối đa 50 revision và giữ `rev-0000`; Python `tests/test_session.py` đạt 21/21, bao gồm undo/redo và giới hạn revision. Parser đạt trên Mac; Windows UI/E2E chưa chạy, giữ 🔄.
- **Trạng thái:** 🔄

### R3.12 · Lưu và Lưu thành · S
- **Mô tả:** `session.save` ghi nguyên tử (ghi tạm, fsync, đổi tên), trả trạng thái `dirty: false` và cảnh báo nếu có. Lưu thành ghi ra file mới.
- **Tiêu chí:** (1) file lưu mở lại được bằng pikepdf và pdfium; (2) ghi giữa chừng bị lỗi thì file gốc không đổi; (3) cảnh báo mật khẩu owner được hiện.
- **Kiểm chứng:** E2E `scan-save-reopen` (phần lưu); test lỗi giữa chừng.
- **Phụ thuộc:** R3.06
- **File:** `apps/native/crates/chef-app/src/save.rs`
- **E2E:** `scan-save-reopen`
- **Tính năng:** —
- **Ghi chú:** (2026-11-11) `ops::save(path)` test với lõi: pikepdf đọc được, `dirty: false`, file gốc còn nguyên; lõi hiện có save nguyên tử. Viewer có Save/Save As và cảnh báo riêng khi không giữ được owner password hoặc restriction. Ba test lõi `test_save_as_and_save`, `test_failed_atomic_save_preserves_source_and_dirty_state`, `test_encrypted_round_trip` đạt 3/3 trên Mac; (2026-11-14) chạy lại toàn bộ `tests/test_session.py` trong môi trường tạm Python 3.14 từ `uv.lock`: 21/21 đạt, gồm Save As, lỗi trước `os.replace` giữ nguyên bytes/dirty/temp, và mã hóa. `scripts/e2e-native-owner-warning.ps1` kiểm warning UI sau Save As, đầu ra mã hóa đọc lại bằng pikepdf, rotation và nguyên trạng nguồn; script được bổ sung mở lại đầu ra bằng user password rồi đợi bitmap PDFium. Integration script kiểm Save As, Ctrl+S overwrite cùng đích sau revision kế tiếp, SHA-256 nguồn, metadata và native reopen. Parser PowerShell sạch trên Mac; UI/PDFium app và Windows E2E chưa chạy, giữ 🔄.
- **Trạng thái:** 🔄

### R3.13 · Khôi phục khi crash · M
- **Mô tả:** khi mở app, tìm phiên chưa đóng sạch (không có dấu đóng) và đề nghị khôi phục hoặc bỏ. Dùng `session/recovery.py` của lõi.
- **Tiêu chí:** (1) kill app giữa chừng rồi mở lại thì có hộp thoại khôi phục; (2) khôi phục đưa về revision cuối; (3) bỏ thì xóa thư mục phiên sau khi hỏi.
- **Kiểm chứng:** E2E `recovery-crash` viết lại.
- **Phụ thuộc:** R3.05, R3.12
- **File:** `apps/native/crates/chef-app/src/recovery.rs`
- **E2E:** `recovery-crash`
- **Tính năng:** A9
- **Trạng thái:** ⬜

### R3.14 · Đóng phiên và thoát an toàn · S
- **Mô tả:** đóng tab hoặc app gọi `session.close` (xóa thư mục phiên) sau khi hỏi nếu có thay đổi chưa lưu. Thoát app dừng lõi sạch.
- **Tiêu chí:** (1) hỏi trước khi bỏ thay đổi; (2) thư mục phiên bị xóa khi đóng có chủ đích; (3) không để tiến trình lõi sau khi thoát.
- **Kiểm chứng:** E2E `b1-in-session` (phần đóng); bảng tiến trình.
- **Phụ thuộc:** R3.12, R3.02
- **File:** `apps/native/crates/chef-app/src/close.rs`
- **E2E:** `b1-in-session`
- **Tính năng:** —
- **Trạng thái:** ⬜

### R3.15 · Điểm kiểm M3 · —
- **Mô tả:** đo RAM ba mốc có lõi và không có lõi; kiểm tra việc lõi chỉ chạy sau thao tác (R3.03); cập nhật R5 và R6 nếu số liệu khác dự đoán.
- **Tiêu chí:** (1) bảng RAM có `coreMB` = 0 ở mốc chỉ xem; (2) số `coreMB` sau thao tác được ghi; (3) M4–M9 được xem lại theo kết quả.
- **Kiểm chứng:** báo cáo trong NOTES.
- **Phụ thuộc:** R3.01 đến R3.14
- **Tính năng:** —
- **Trạng thái:** ⬜

---

## M4: Trang và chú thích

**Mục tiêu:** lưới trang, chọn nhiều, thao tác trang, menu chuột phải, chèn và sửa đối tượng, lớp, ghi chú và vẽ, form. Đây là phần lớn nhất đã có trong `PageOrganizer.css`, `overlay.css`, `annots.css`, `forms.css`.
**Demo:** chọn ba trang, menu chuột phải, "Tạo PDF từ các trang đã chọn"; chọn một hình ảnh và kéo đổi kích thước; tô sáng và ghi chú; điền một form và làm phẳng.
**Đầu vào:** M3 (ops và revision).

### M4.0 Lưới trang và thao tác trang

### R4.01 · Lưới thumbnail · M
- **Mô tả:** lưới trang với thumbnail nhỏ, ảo hóa, cap thumbnail như R2.22. Khung chờ có hiệu ứng `thumb-shimmer` (`PageOrganizer.css`). Lưới là một chế độ của thanh bên hoặc tab Trang (BLUEPRINT_RUST §6).
- **Tiêu chí:** (1) lưới khớp `PageOrganizer.css` ở ba chiều rộng; (2) cuộn lưới 1000 trang không tạo quá 60 thumbnail đồng thời; (3) bấm trang nhảy viewer tới trang đó.
- **Kiểm chứng:** ui-audit; đếm thumbnail.
- **Phụ thuộc:** R2.22
- **File:** `apps/native/crates/chef-viewer/src/grid.rs`
- **E2E:** `tools5-pages` (phần lưới)
- **Tính năng:** C1
- **Trạng thái:** ⬜

### R4.02 · Chọn nhiều trang · M
- **Mô tả:** Shift để chọn khoảng, Ctrl để bật tắt từng trang. Vùng chọn dùng chung giữa lưới và thanh bên (`selection.ts`). Đảo chọn, chọn trang lẻ và chẵn.
- **Tiêu chí:** (1) Shift và Ctrl hoạt động như bản Electron; (2) đảo chọn đúng; (3) chọn ở lưới và thanh bên đồng bộ.
- **Kiểm chứng:** E2E `page-menu` (phần chọn); test.
- **Phụ thuộc:** R4.01
- **File:** `apps/native/crates/chef-viewer/src/selection.rs`
- **E2E:** `page-menu`
- **Tính năng:** C14 (chọn), C13 (chọn)
- **Trạng thái:** ⬜

### R4.03 · Thao tác trang: xoay, xóa, nhân bản, trích ra · M
- **Mô tả:** gọi operation `page.*` của lõi cho xoay, xóa, nhân bản và trích ra file mới (mở ở tab mới, không đụng file gốc, như D38).
- **Tiêu chí:** (1) mỗi thao tác là một operation và có undo; (2) trích ra tạo file mới, file gốc giữ nguyên byte (kiểm SHA-256); (3) xóa nhiều trang đúng.
- **Kiểm chứng:** E2E `tools5-pages`; test SHA-256.
- **Phụ thuộc:** R4.02, R3.08
- **File:** `apps/native/crates/chef-app/src/page_ops.rs`
- **E2E:** `tools5-pages`, `page-menu`
- **Tính năng:** C2
- **Trạng thái:** ⬜

### R4.04 · Chèn trang và thay thế trang · S
- **Mô tả:** chèn trang trắng hoặc từ file khác (`page.insert`), thay trang X bằng trang từ file khác (`page.replace`).
- **Tiêu chí:** (1) vị trí chèn đúng; (2) thay trang giữ số trang còn lại; (3) có undo.
- **Kiểm chứng:** E2E `tools5-pages`; test.
- **Phụ thuộc:** R4.03
- **File:** `apps/native/crates/chef-app/src/page_ops.rs`
- **E2E:** `tools5-pages`
- **Tính năng:** C3, C6
- **Trạng thái:** ⬜

### R4.05 · Menu chuột phải trên trang đã chọn · M
- **Mô tả:** menu như `pageMenu.tsx`: mở trang, chọn tất cả, đảo chọn, chọn trang lẻ và chẵn, tạo PDF từ các trang đã chọn, xoay, nhân bản, chèn, xóa, và các mục đóng dấu, nén, xuất ảnh (phần đóng dấu và nén nối vào M5). Mục bị khóa khi file đã ký.
- **Tiêu chí:** (1) số trang trong nhãn đúng ("Tạo PDF từ 3 trang đã chọn"); (2) mục bị khóa khi file đã ký; (3) menu khớp E2E `page-menu`.
- **Kiểm chứng:** E2E `page-menu` (4 test); ui-audit.
- **Phụ thuộc:** R4.02, R2.06
- **File:** `apps/native/crates/chef-app/src/page_menu.rs`
- **E2E:** `page-menu`
- **Tính năng:** C13
- **Trạng thái:** ⬜

### R4.06 · Tạo PDF từ các trang đã chọn · S
- **Mô tả:** trích các trang đã chọn ra file mới, mở ở tab mới, không đụng file gốc (D38), có thể lưu thành file.
- **Tiêu chí:** (1) nội dung trang đúng (kiểm bằng chữ M2/M4 như spec cũ); (2) file gốc giữ nguyên byte; (3) làm được cả với file đã ký.
- **Kiểm chứng:** E2E `page-menu` (test tạo PDF).
- **Phụ thuộc:** R4.05, R4.03
- **File:** `apps/native/crates/chef-app/src/page_ops.rs`
- **E2E:** `page-menu`
- **Tính năng:** C14
- **Trạng thái:** ⬜

### R4.07 · Kéo thả đổi thứ tự trang · M
- **Mô tả:** kéo trang trong lưới để đổi thứ tự, có chỉ báo chỗ thả. Gom thành một revision (BLUEPRINT_RUST §4).
- **Tiêu chí:** (1) kéo đổi thứ tự đúng; (2) một lần kéo là một revision; (3) hủy kéo giữa chừng không đổi gì.
- **Kiểm chứng:** E2E; test.
- **Phụ thuộc:** R4.03
- **File:** `apps/native/crates/chef-ui/src/drag.rs`
- **Tính năng:** C2
- **Trạng thái:** ⬜

### M4.1 Xem song song và đối tượng

### R4.08 · Xem song song hai file hoặc hai vị trí · M
- **Mô tả:** chia đôi màn hình xem: hai file, hoặc hai vị trí của cùng file. Mỗi nửa có viewer riêng, chung cache.
- **Tiêu chí:** (1) hai nửa cuộn độc lập; (2) cache chung không vượt trần R1.33; (3) đóng một nửa không ảnh hưởng nửa kia.
- **Kiểm chứng:** E2E `b2-other-window-top` (phần chia đôi); đo cache.
- **Phụ thuộc:** R2.19, R1.33
- **File:** `apps/native/crates/chef-viewer/src/split.rs`
- **E2E:** `b2-other-window-top`
- **Tính năng:** B8
- **Trạng thái:** ⬜

### R4.09 · Chèn ảnh · S
- **Mô tả:** chọn file ảnh (PNG, JPG), đặt lên trang bằng kéo, đổi kích thước theo tỉ lệ. Operation `content.image.insert`.
- **Tiêu chí:** (1) ảnh đúng vị trí và kích thước; (2) có undo; (3) ảnh vượt trang bị cắt đúng.
- **Kiểm chứng:** E2E `objects`; test.
- **Phụ thuộc:** R4.12 (khung chọn đối tượng)
- **File:** `apps/native/crates/chef-app/src/insert_image.rs`
- **E2E:** `objects`
- **Tính năng:** D2
- **Trạng thái:** ⬜

### R4.10 · Sửa mục lục (bookmark) · M
- **Mô tả:** thêm, sửa, xóa, sắp xếp bookmark trong hộp thoại. Dùng `bookmarks.py` của lõi.
- **Tiêu chí:** (1) thứ tự kéo đúng; (2) bookmark trỏ đúng trang sau khi đổi thứ tự trang; (3) có undo.
- **Kiểm chứng:** E2E `toc` (phần sửa); test.
- **Phụ thuộc:** R3.08, R2.22
- **File:** `apps/native/crates/chef-app/src/bookmarks.rs`
- **E2E:** `toc`
- **Tính năng:** D3
- **Trạng thái:** ⬜

### R4.11 · Chọn đối tượng và hit-test · M
- **Mô tả:** vạch thước của lớp overlay (`repeating-linear-gradient` ở `overlay.css:252`, vẽ bằng quad). Click chọn chữ, ảnh, hình vẽ có sẵn trong trang. Viền khung chọn, nhích bằng mũi tên, xóa bằng Delete, đưa lên trên và xuống dưới. Danh sách đối tượng lấy từ pdfium (`FPDFPage_CountObjects`) và lớp overlay.
- **Tiêu chí:** (1) click chọn đúng đối tượng đầu tiên dưới con trỏ; (2) Delete xóa được ngay sau khi chọn (lỗi `remapSelection` đã biết ở NOTES nên có test); (3) bấm chữ thì bỏ chọn ảnh.
- **Kiểm chứng:** E2E `objects`, `overlay`; test.
- **Phụ thuộc:** R2.25a, R4.03
- **File:** `apps/native/crates/chef-viewer/src/objects.rs`
- **E2E:** `objects`, `overlay`
- **Tính năng:** D4
- **Trạng thái:** ⬜

### R4.12 · Kéo khung, nắm và xoay đối tượng · M
- **Mô tả:** tám nắm góc và cạnh để đổi kích thước, nắm xoay, kéo khung di chuyển. Mỗi thao tác là một operation.
- **Tiêu chí:** (1) đổi kích thước giữ tỉ lệ khi giữ Shift; (2) xoay theo góc hiển thị; (3) kết quả lưu đúng vị trí trên file.
- **Kiểm chứng:** E2E `objects`; đọc lại file đã lưu bằng pikepdf.
- **Phụ thuộc:** R4.11
- **File:** `apps/native/crates/chef-viewer/src/handles.rs`
- **E2E:** `objects`
- **Tính năng:** D4
- **Trạng thái:** ⬜

### R4.13 · Tẩy vùng · S
- **Mô tả:** chọn vùng chữ nhật hoặc vẽ tự do, tẩy bằng màu nền hoặc màu tự chọn (operation `content.erase`).
- **Tiêu chí:** (1) vùng tẩy đúng hình; (2) màu nền giấy tự dò đúng; (3) có undo.
- **Kiểm chứng:** E2E `erase` (phần tẩy vùng trong PDF có chữ) — chú ý `erase` là spec của M8, ở đây chỉ kiểm tẩy trên PDF thường.
- **Phụ thuộc:** R4.11
- **File:** `apps/native/crates/chef-viewer/src/erase_tool.rs`
- **E2E:** `content-v06`
- **Tính năng:** D5
- **Trạng thái:** ⬜

### R4.14 · Thay ảnh và chỉnh ảnh trong PDF · M
- **Mô tả:** thay một ảnh bằng ảnh khác giữ vị trí và kích thước (D6). Cắt, xoay, lật, xóa nền, sáng và tương phản ngay trong PDF (D7). Operation `content.image.*`.
- **Tiêu chí:** (1) thay ảnh giữ vị trí; (2) cắt và xoay không mất ảnh gốc (có lịch sử); (3) chỉnh sáng đúng.
- **Kiểm chứng:** E2E `content-v06`; test.
- **Phụ thuộc:** R4.11
- **File:** `apps/native/crates/chef-app/src/image_edit.rs`
- **E2E:** `content-v06`
- **Tính năng:** D6, D7
- **Trạng thái:** ⬜

### R4.15 · Liên kết · S
- **Mô tả:** thêm, sửa, xóa liên kết trang nội bộ, web, email (operation `links.*`). Hiện vùng liên kết khi di chuột.
- **Tiêu chí:** (1) liên kết mở đúng trang hoặc URL; (2) URL không phải http, https, mailto bị từ chối; (3) có undo.
- **Kiểm chứng:** E2E `links`-liên quan (chưa có spec riêng: viết test); test từ chối URL xấu.
- **Phụ thuộc:** R4.11
- **File:** `apps/native/crates/chef-app/src/links.rs`
- **E2E:** `content-v06` (phần liên kết)
- **Tính năng:** D11
- **Trạng thái:** ⬜

### M4.2 Lớp và ghi chú

### R4.16 · Bảng lớp và xem theo loại nội dung · M
- **Mô tả:** liệt kê lớp, bật tắt, đổi tên, xóa, làm phẳng lớp. Xem theo loại: chữ, ảnh, hình vẽ, ghi chú, nền (`layers.css`).
- **Tiêu chí:** (1) bật tắt lớp đổi hiển thị ngay; (2) đổi tên lưu vào file; (3) bộ lọc loại đúng.
- **Kiểm chứng:** E2E `layers` (nếu có) và `content-v06`; test.
- **Phụ thuộc:** R4.11
- **File:** `apps/native/crates/chef-app/src/layers.rs`
- **E2E:** `content-v06`
- **Tính năng:** E1, E2
- **Trạng thái:** ⬜

### R4.17 · Đánh dấu chữ: tô sáng, gạch chân, gạch ngang · M
- **Mô tả:** chọn chữ rồi chọn kiểu đánh dấu. Tạo chú thích loại highlight, underline, strikeout (`annots.py`). Màu theo `--c-highlight`.
- **Tiêu chí:** (1) đánh dấu nằm đúng hộp chữ đã chọn; (2) mở lại file vẫn thấy; (3) đổi màu có undo.
- **Kiểm chứng:** E2E `annots`; đọc lại bằng pdfium.
- **Phụ thuộc:** R2.25b, R3.12
- **File:** `apps/native/crates/chef-app/src/annots.rs`
- **E2E:** `annots`
- **Tính năng:** G1
- **Trạng thái:** ⬜

### R4.18 · Ghi chú dán và hộp chữ bình luận · M
- **Mô tả:** tạo ghi chú dạng note, sửa nội dung, trả lời, đánh dấu đã xử lý (`annots.py`, `annots_export.py`).
- **Tiêu chí:** (1) ghi chú mở lại thấy nội dung và tác giả; (2) trả lời lưu thành chuỗi; (3) đánh dấu đã xử lý đổi trạng thái.
- **Kiểm chứng:** E2E `annots`; test.
- **Phụ thuộc:** R4.17
- **File:** `apps/native/crates/chef-app/src/notes.rs`
- **E2E:** `annots`
- **Tính năng:** G2
- **Trạng thái:** ⬜

### R4.19 · Vẽ: bút, đường thẳng, mũi tên, hình chữ nhật, elip · M
- **Mô tả:** công cụ vẽ với các hình cơ bản, màu và độ dày nét, lưu thành chú thích hình vẽ.
- **Tiêu chí:** (1) từng hình đúng kích thước khi lưu; (2) đổi màu và nét có hiệu lực; (3) mở lại thấy hình.
- **Kiểm chứng:** E2E `annots` (phần vẽ) và test; đọc lại bằng pdfium.
- **Phụ thuộc:** R4.17
- **File:** `apps/native/crates/chef-app/src/draw.rs`
- **E2E:** `annots`
- **Tính năng:** G3
- **Trạng thái:** ⬜

### R4.20 · Danh sách ghi chú và làm phẳng ghi chú · S
- **Mô tả:** bảng liệt kê ghi chú, lọc theo loại hoặc người, đánh dấu đã xử lý, xuất bảng tổng hợp CSV (phần CSV để M5e nếu dùng chung). Làm phẳng biến ghi chú thành nội dung cố định.
- **Tiêu chí:** (1) lọc đúng; (2) làm phẳng không còn chú thích và giữ nét; (3) CSV đúng cột.
- **Kiểm chứng:** E2E `annots`, `forms` (làm phẳng); test.
- **Phụ thuộc:** R4.18
- **File:** `apps/native/crates/chef-app/src/notes_list.rs`
- **E2E:** `annots`
- **Tính năng:** G4, G5
- **Trạng thái:** ⬜

### M4.3 Form

### R4.21 · Form: FFI form-fill và hiện widget · L
- **Mô tả:** khởi tạo môi trường form-fill của pdfium (`FPDFDOC_InitFormFillEnvironment`), hiện các widget (ô chữ, checkbox, radio, dropdown, ô chữ ký) và vẽ đúng. Dùng cho cả điền và làm phẳng. Có một lớp widget nằm trên viewer.
- **Tiêu chí:** (1) widget hiện đúng vị trí ở ba chiều rộng; (2) môi trường được giải phóng khi đóng tab; (3) form không JS (kiểm R1.28).
- **Kiểm chứng:** E2E `forms`; ui-audit.
- **Phụ thuộc:** R1.28, R2.19
- **File:** `apps/native/crates/chef-pdf/src/form_fill.rs`
- **E2E:** `forms`
- **Tính năng:** H1
- **Trạng thái:** ⬜

### R4.22 · Điền form và lưu · M
- **Mô tả:** nhập vào ô chữ, tích checkbox, chọn radio và dropdown. Thay đổi đi qua operation (`forms.fill`) và lưu lại.
- **Tiêu chí:** (1) giá trị lưu và đọc lại đúng; (2) có undo; (3) tab giữa các ô theo thứ tự trang.
- **Kiểm chứng:** E2E `forms`, `demo-v09` (phần điền).
- **Phụ thuộc:** R4.21, R3.08
- **File:** `apps/native/crates/chef-app/src/forms_fill.rs`
- **E2E:** `forms`, `demo-v09`
- **Tính năng:** H1
- **Trạng thái:** ⬜

### R4.23 · Tạo form · L
- **Mô tả:** thêm ô chữ, checkbox, radio, dropdown, ô chữ ký lên trang qua operation `forms.create`, đặt tên trường và thuộc tính.
- **Tiêu chí:** (1) widget tạo ra mở được trong Electron và pdfium; (2) tên trường không trùng; (3) có undo.
- **Kiểm chứng:** E2E `demo-v09` (phần tạo form); mở file bằng Electron.
- **Phụ thuộc:** R4.22
- **File:** `apps/native/crates/chef-app/src/forms_create.rs`
- **E2E:** `demo-v09`, `forms`
- **Tính năng:** H2
- **Trạng thái:** ⬜

### R4.24 · Làm phẳng form · S
- **Mô tả:** biến widget thành nội dung cố định (operation `forms.flatten`), giữ giá trị đã điền.
- **Tiêu chí:** (1) không còn widget; (2) giá trị vẫn hiện; (3) file mở được bằng pikepdf và pdfium.
- **Kiểm chứng:** E2E `forms`; đọc lại.
- **Phụ thuộc:** R4.22
- **File:** `apps/native/crates/chef-app/src/forms_flatten.rs`
- **E2E:** `forms`
- **Tính năng:** H3
- **Trạng thái:** ⬜

### R4.25 · Điểm kiểm M4 · —
- **Mô tả:** chạy ui-audit cho trang và chú thích, E2E `page-menu`, `annots`, `forms`, `objects`, `overlay`, `content-v06`, `toc`, `demo-v06`, đo RAM với file có nhiều chú thích.
- **Tiêu chí:** (1) các E2E tương đương đạt; (2) ui-audit ≤ ngưỡng; (3) RAM ghi cạnh Electron.
- **Kiểm chứng:** báo cáo.
- **Phụ thuộc:** R4.01 đến R4.24
- **Tính năng:** —
- **Trạng thái:** ⬜

---

## M5: Hộp thoại và xử lý tài liệu

**Mục tiêu:** khung hộp thoại xử lý dùng chung, renderer hộp thoại sinh từ schema, và mọi tính năng xử lý: ghép, tách, cắt, tối ưu, chuyển đổi, bản scan, đóng dấu và đánh số, bảo mật, rã tài liệu, quy trình. Đây là mốc có nhiều tính năng nhất (C4, C5, C7–C10, M1–M11, K1–K10, F1–F12, E3–E5, J1–J6, N1–N7, D12, O1–O8).
**Demo:** ghép ba file và tách theo bookmark; nén một file xuống dưới 5 MB; đóng dấu giáp lai và đánh số Bates; đặt mật khẩu; rã một PDF có bảng và xuất Word; chạy một quy trình trên một thư mục.
**Cách chia:** 6 nhóm 5a–5f, mỗi nhóm có điểm kiểm riêng. Hai nhóm 5c và 5d có thể làm song song sau 5a.
**Đầu vào:** M3 (ops và job), M4 (trang và đối tượng), R3.07 (schema).

### M5a Khung hộp thoại và trang

### R5.01 · Khung TaskDialog · M
- **Mô tả:** khung hộp thoại xử lý dùng chung, bố cục như `TaskDialog.css` (cột chính và cột phụ 300 px). Có nút chạy, tiến độ, hủy, kết quả, và xem trước.
- **Tiêu chí:** (1) bố cục khớp ui-audit ở ba chiều rộng; (2) khi chạy thì nút chạy mờ và có tiến độ; (3) đóng hộp thoại khi đang chạy hỏi hủy.
- **Kiểm chứng:** ui-audit; test.
- **Phụ thuộc:** R2.10, R3.09
- **File:** `apps/native/crates/chef-ui/src/task_dialog.rs`
- **Tính năng:** —
- **Trạng thái:** ⬜

### R5.02 · Renderer hộp thoại từ JSON Schema · M
- **Mô tả:** sinh form từ `Params` của operation: chuỗi, số, bool, enum, khoảng trang, danh sách file. Nhãn và mô tả lấy từ `vi.json`. Mục đích là giảm số hộp thoại viết tay (BLUEPRINT_RUST §6).
- **Tiêu chí:** (1) form sinh ra cho ba operation mẫu khớp với hộp thoại viết tay tương ứng; (2) kiểu sai bị chặn trước khi chạy; (3) thêm một operation mới không cần viết giao diện; (4) có bảng phân loại mọi hộp thoại xử lý trong 104 màn hình ui-audit: "sinh từ schema" (đạt ngưỡng so ảnh R2.02), "schema + phần viết tay" (xem trước, danh sách kéo thả), hoặc "viết tay hoàn toàn", để giữ yêu cầu hình họa của BLUEPRINT_RUST §6; (5) theo bảng đó, rà lại kích thước R5.03–R5.68 (task chỉ còn nối schema và E2E thì xuống S) và ghi vào "Thay đổi sau khi chốt" (4 và 5 thêm 2026-11-11).
- **Kiểm chứng:** test với ba operation; so với hộp thoại cũ.
- **Phụ thuộc:** R5.01, R3.07
- **File:** `apps/native/crates/chef-ui/src/schema_form.rs`
- **Tính năng:** —
- **Trạng thái:** ⬜

### R5.03 · Ghép file · M
- **Mô tả:** chọn nhiều PDF, kéo sắp thứ tự, tùy chọn tạo bookmark theo tên file. Operation `pdf.merge`.
- **Tiêu chí:** (1) số trang tổng đúng; (2) bookmark theo tên đúng; (3) file nguồn không đổi.
- **Kiểm chứng:** E2E `tools5`; SHA-256 nguồn.
- **Phụ thuộc:** R5.02
- **File:** `apps/native/crates/chef-app/src/merge.rs`
- **E2E:** `tools5`
- **Tính năng:** C4
- **Trạng thái:** ⬜

### R5.04 · Tách file · M
- **Mô tả:** tách theo khoảng trang, mỗi N trang, theo bookmark, theo dung lượng, trang chẵn hoặc lẻ. Operation `pdf.split`.
- **Tiêu chí:** (1) mỗi cách tách ra đúng số file và trang; (2) tên file theo mẫu; (3) file gốc không đổi.
- **Kiểm chứng:** E2E `tools5`; test.
- **Phụ thuộc:** R5.02
- **File:** `apps/native/crates/chef-app/src/split.rs`
- **E2E:** `tools5`
- **Tính năng:** C5
- **Trạng thái:** ⬜

### R5.05 · Cắt lề và đổi khổ · M
- **Mô tả:** tự dò lề trắng, đưa về A4 hoặc Letter, co nội dung. Áp cho trang PDF bằng đặt CropBox, không mất nội dung. Cắt ảnh scan thật dùng R5.23 đến R5.27 và M8.
- **Tiêu chí:** (1) CropBox đổi, nội dung còn nguyên (so chữ trước và sau); (2) khổ A4 và Letter đúng; (3) hoàn tác được.
- **Kiểm chứng:** E2E `tools5`; test.
- **Phụ thuộc:** R5.02
- **File:** `apps/native/crates/chef-app/src/crop_page.rs`
- **E2E:** `tools5`
- **Tính năng:** C7
- **Trạng thái:** ⬜

### R5.06 · Xóa trang trắng · M
- **Mô tả:** tự tìm trang trắng (thường gặp khi scan hai mặt), xem trước danh sách, rồi mới xóa.
- **Tiêu chí:** (1) không xóa khi chưa xác nhận; (2) trang có một chấm bẩn vẫn bị coi là trắng hay không được ghi rõ theo ngưỡng; (3) có undo.
- **Kiểm chứng:** test với trang trắng và trang có chữ nhỏ.
- **Phụ thuộc:** R5.02
- **File:** `apps/native/crates/chef-app/src/blank_pages.rs`
- **Tính năng:** C8
- **Trạng thái:** ⬜

### R5.07 · Chia đôi trang và lưới N phần · S
- **Mô tả:** trang A3 hoặc trang đôi thành hai trang A4, hoặc cắt trang thành lưới N phần.
- **Tiêu chí:** (1) hai nửa đúng khổ; (2) lưới N×M đúng thứ tự đọc; (3) có undo.
- **Kiểm chứng:** test.
- **Phụ thuộc:** R5.02
- **File:** `apps/native/crates/chef-app/src/split_page.rs`
- **Tính năng:** C9
- **Trạng thái:** ⬜

### R5.08 · Tách thông minh · M
- **Mô tả:** tách file mỗi khi gặp trang có tiêu đề mới, mã QR phân cách, hoặc trang trắng phân cách.
- **Tiêu chí:** (1) mỗi kiểu phân cách đúng số file; (2) trang phân cách không đưa vào file kết quả (có tùy chọn); (3) xem trước các điểm tách.
- **Kiểm chứng:** test với ba PDF mẫu.
- **Phụ thuộc:** R5.04
- **File:** `apps/native/crates/chef-app/src/smart_split.rs`
- **Tính năng:** C10
- **Trạng thái:** ⬜

### R5.09 · Đối chiếu ui-audit hộp thoại xử lý · S
- **Mô tả:** chụp và so ảnh các hộp thoại Ghép, Tách, Cắt, Xóa trang trắng, Chia đôi, Tách thông minh.
- **Tiêu chí:** (1) đạt ngưỡng R2.02; (2) khác biệt ghi trong báo cáo.
- **Kiểm chứng:** báo cáo.
- **Phụ thuộc:** R5.03 đến R5.08
- **E2E:** `tools5`
- **Tính năng:** —
- **Trạng thái:** ⬜

### R5.10 · Điểm kiểm 5a · —
- **Mô tả:** chạy E2E `tools5` và đo RAM khi ghép và tách file 300 MB.
- **Tiêu chí:** (1) E2E đạt; (2) RAM ghi cạnh Electron.
- **Kiểm chứng:** báo cáo.
- **Phụ thuộc:** R5.01 đến R5.09
- **Tính năng:** —
- **Trạng thái:** ⬜

### M5b Tối ưu, chuyển đổi và bản scan

### R5.11 · Nén PDF · M
- **Mô tả:** nén theo preset (màn hình, email, in ấn), giảm độ phân giải ảnh, bỏ đối tượng thừa, rút gọn font. Operation `pdf.compress`. Dùng `compressPresets.ts` làm mẫu cho preset.
- **Tiêu chí:** (1) từng preset cho dung lượng thấp hơn đầu vào; (2) chữ vẫn chọn được; (3) preset khớp bản Electron ở cùng file.
- **Kiểm chứng:** E2E `tools5-convert`; so dung lượng.
- **Phụ thuộc:** R5.02
- **File:** `apps/native/crates/chef-app/src/compress.rs`
- **E2E:** `tools5-convert`
- **Tính năng:** M1
- **Trạng thái:** ⬜

### R5.12 · PDF sang ảnh · M
- **Mô tả:** xuất PNG, JPG, TIFF (nhiều trang), chọn DPI. Dùng pdfium render.
- **Tiêu chí:** (1) số ảnh đúng; (2) kích thước theo DPI đúng; (3) TIFF nhiều trang mở được.
- **Kiểm chứng:** E2E `tools5-convert`.
- **Phụ thuộc:** R5.02, R1.28
- **File:** `apps/native/crates/chef-app/src/to_images.rs`
- **E2E:** `tools5-convert`
- **Tính năng:** M2
- **Trạng thái:** ⬜

### R5.13 · Ảnh sang PDF · M
- **Mô tả:** nhiều ảnh, sắp thứ tự, chọn khổ giấy, lề, tự xoay theo EXIF. Operation `image.topdf`.
- **Tiêu chí:** (1) số trang đúng; (2) xoay EXIF đúng; (3) khổ và lề đúng.
- **Kiểm chứng:** E2E `tools5-convert`; test.
- **Phụ thuộc:** R5.02
- **File:** `apps/native/crates/chef-app/src/from_images.rs`
- **E2E:** `tools5-convert`
- **Tính năng:** M3
- **Trạng thái:** ⬜

### R5.14 · Ảnh chụp màn hình và clipboard sang PDF · S
- **Mô tả:** dán ảnh từ clipboard hoặc chụp một vùng màn hình thành PDF (`clipboardImage.ts`).
- **Tiêu chí:** (1) dán ảnh có trong clipboard tạo PDF một trang; (2) không có ảnh thì báo rõ; (3) chụp vùng ghi đúng kích thước.
- **Kiểm chứng:** E2E `tools5-convert` (phần clipboard); test.
- **Phụ thuộc:** R5.13
- **File:** `apps/native/crates/chef-app/src/clipboard_image.rs`
- **Tính năng:** M4, B5 (chụp một vùng thành ảnh)
- **Trạng thái:** ⬜

### R5.15 · Markdown và HTML sang PDF · M
- **Mô tả:** sửa Markdown, xem trước, xuất PDF. HTML tĩnh đưa qua bộ dựng PDF không cần trình duyệt nếu có thể (kiểm trước khi chọn). Chờ CH-R1 cho phần web.
- **Tiêu chí:** (1) Markdown có tiêu đề, bảng và ảnh cơ bản; (2) HTML tĩnh đơn giản không cần Chromium; (3) cái nào không làm được thì ghi rõ và chuyển sang R5.16.
- **Kiểm chứng:** E2E `web2pdf` (phần Markdown); test.
- **Phụ thuộc:** R5.02
- **File:** `apps/native/crates/chef-app/src/markdown.rs`
- **E2E:** `web2pdf`
- **Tính năng:** M5 (Markdown, HTML)
- **Trạng thái:** ⬜

### R5.16 · Web sang PDF theo CH-R1 · L
- **Mô tả:** dán link trang web và xuất PDF. Cách làm theo quyết định CH-R1: WebView2 qua CDP (`printToPDF`), hoặc tiến trình Electron nhỏ chỉ chạy khi dùng. Nếu chủ dự án chọn (c), bỏ tính năng và ghi vào FEATURES.
- **Tiêu chí:** (1) trang web đơn giản xuất ra PDF đọc được; (2) không tạo tiến trình khi không dùng; (3) RAM khi không dùng vẫn bằng R3.03 (không tăng).
- **Kiểm chứng:** E2E `web2pdf`; bảng tiến trình.
- **Phụ thuộc:** CH-R1, R5.02
- **File:** `apps/native/crates/chef-app/src/web_print.rs`
- **E2E:** `web2pdf`
- **Tính năng:** M5 (web)
- **Ghi chú:** bỏ theo CH-R1 (c), 2026-11-09 (D78, FEATURES M5). Không làm.
- **Trạng thái:** ❌

### R5.17 · Chuyển đổi màu · S
- **Mô tả:** màu, xám, đen trắng 1-bit với ngưỡng và tùy chọn dithering. Operation `color.convert`.
- **Tiêu chí:** (1) đen trắng 1-bit đúng ngưỡng; (2) xám giữ chữ; (3) có undo.
- **Kiểm chứng:** E2E `tools5-convert`; test.
- **Phụ thuộc:** R5.02
- **File:** `apps/native/crates/chef-app/src/color.rs`
- **E2E:** `tools5-convert`
- **Tính năng:** M6
- **Trạng thái:** ⬜

### R5.18 · Trích xuất ảnh gốc và văn bản · S
- **Mô tả:** lấy toàn bộ ảnh gốc của PDF, lấy chữ ra `.txt`.
- **Tiêu chí:** (1) ảnh xuất ra đúng số lượng; (2) `.txt` có chữ tiếng Việt đúng dấu.
- **Kiểm chứng:** test; đọc `.txt`.
- **Phụ thuộc:** R5.02, R2.25a
- **File:** `apps/native/crates/chef-app/src/extract.rs`
- **Tính năng:** M7
- **Trạng thái:** ⬜

### R5.19 · File đính kèm · S
- **Mô tả:** xem, thêm, xóa, lưu ra các file nhúng trong PDF.
- **Tiêu chí:** (1) danh sách đúng; (2) lưu ra không ghi đè file cũ (hỏi); (3) thêm file lưu lại mở được.
- **Kiểm chứng:** test.
- **Phụ thuộc:** R5.02
- **File:** `apps/native/crates/chef-app/src/attachments.rs`
- **Tính năng:** M8
- **Trạng thái:** ⬜

### R5.20 · Sửa metadata · S
- **Mô tả:** tiêu đề, tác giả, chủ đề, từ khóa. Operation `meta.set`.
- **Tiêu chí:** (1) giá trị lưu và đọc lại đúng; (2) có undo.
- **Kiểm chứng:** test; đọc bằng pikepdf.
- **Phụ thuộc:** R5.02
- **File:** `apps/native/crates/chef-app/src/metadata.rs`
- **Tính năng:** M9
- **Trạng thái:** ⬜

### R5.21 · Tối ưu cho web · S
- **Mô tả:** linearize để mở trang đầu nhanh khi xem qua mạng.
- **Tiêu chí:** (1) file linearized đọc được bằng pdfium; (2) kiểm bằng công cụ của pikepdf.
- **Kiểm chứng:** test.
- **Phụ thuộc:** R5.02
- **File:** `apps/native/crates/chef-app/src/linearize.rs`
- **Tính năng:** M10
- **Trạng thái:** ⬜

### R5.22 · Sửa file PDF hỏng · M
- **Mô tả:** thử khôi phục file lỗi, không mở được thì báo rõ và giữ file gốc.
- **Tiêu chí:** (1) file có xref hỏng vẫn mở và lưu được ở một mẫu; (2) file không khôi phục được có thông báo tiếng Việt; (3) file gốc không đổi.
- **Kiểm chứng:** E2E `tools5` (phần sửa); test với ba file hỏng.
- **Phụ thuộc:** R5.02
- **File:** `apps/native/crates/chef-app/src/repair.rs`
- **Tính năng:** M11
- **Trạng thái:** ⬜

### R5.23 · Chuyển thành bản scan: độ phân giải, màu, nén · M
- **Mô tả:** chọn độ phân giải, chế độ màu, và nén (JPEG có chỉnh chất lượng, Flate không mất dữ liệu, CCITT G4 cho đen trắng). Operation `scan.convert` (`scan.py`).
- **Tiêu chí:** (1) từng chế độ nén cho ra file đúng; (2) văn bản nhìn được ở 200 dpi; (3) kết quả khớp bản Electron ở cùng cài đặt (so kích thước).
- **Kiểm chứng:** E2E `scan`; so kích thước.
- **Phụ thuộc:** R5.02
- **File:** `apps/native/crates/chef-app/src/scan_convert.rs`
- **E2E:** `scan`
- **Tính năng:** K1, K2, K3
- **Trạng thái:** ⬜

### R5.24 · Hiệu ứng scan thật · M
- **Mô tả:** thêm nghiêng nhẹ, hạt nhiễu, ám màu giấy, bóng mép, mờ nhẹ, lệch tương phản. Ngẫu nhiên khác nhau từng trang, có hạt giống để lặp lại.
- **Tiêu chí:** (1) cùng hạt giống thì kết quả giống nhau; (2) mỗi hiệu ứng bật tắt riêng; (3) trang khác nhau có hiệu ứng khác nhau khi không cố định hạt.
- **Kiểm chứng:** E2E `scan`; test hạt giống.
- **Phụ thuộc:** R5.23
- **File:** `apps/native/crates/chef-app/src/scan_effects.rs`
- **E2E:** `scan`
- **Tính năng:** K4
- **Trạng thái:** ⬜

### R5.25 · Xem trước và ước lượng dung lượng · M
- **Mô tả:** xem trước một trang với cài đặt hiện tại; ước lượng dung lượng cả file (cập nhật ngay khi đổi thiết lập).
- **Tiêu chí:** (1) ước lượng sai lệch dưới 15% so với file thật (đo trên ba mẫu); (2) xem trước không ghi file; (3) đổi thiết lập cập nhật trong dưới 1 giây.
- **Kiểm chứng:** E2E `scan` (xem trước); đo sai lệch.
- **Phụ thuộc:** R5.23
- **File:** `apps/native/crates/chef-app/src/scan_preview.rs`
- **E2E:** `scan`
- **Tính năng:** K5, K6
- **Trạng thái:** ⬜

### R5.26 · Phạm vi, tùy chọn và preset scan · M
- **Mô tả:** chọn trang hay cả file, các tùy chọn, preset Nhẹ, Chuẩn, Nét, Văn bản hành chính, và tự tạo preset.
- **Tiêu chí:** (1) bốn preset có sẵn khớp bản Electron; (2) preset tự tạo lưu và tải lại; (3) áp cho trang đã chọn chỉ đổi trang đó.
- **Kiểm chứng:** E2E `scan`; test lưu preset.
- **Phụ thuộc:** R5.25
- **File:** `apps/native/crates/chef-app/src/scan_presets.rs`
- **E2E:** `scan`
- **Tính năng:** K7, K8
- **Trạng thái:** ⬜

### R5.27 · Cảnh báo và giới hạn dung lượng · M
- **Mô tả:** cảnh báo khi dùng chế độ làm mất chữ (bản scan không có chữ tìm được). Giới hạn 5, 10, 25 MB: tự dò DPI và chất lượng để file dưới giới hạn, hoặc báo không đạt được.
- **Tiêu chí:** (1) cảnh báo hiện trước khi chạy; (2) file ≤ 5 MB với mẫu nhiều trang (kiểm trên fixture scan của `demo-v08`); (3) báo không đạt khi không thể.
- **Kiểm chứng:** E2E `scan`, `demo-v08` (phần dung lượng).
- **Phụ thuộc:** R5.26
- **File:** `apps/native/crates/chef-app/src/scan_limits.rs`
- **E2E:** `scan`, `demo-v08`
- **Tính năng:** K9, K10
- **Trạng thái:** ⬜

### R5.28 · Điểm kiểm 5b · —
- **Mô tả:** E2E `tools5-convert`, `scan`, `scan-save-reopen`, `web2pdf`; đo RAM khi chuyển file 305 MB sang ảnh.
- **Tiêu chí:** (1) E2E đạt, hoặc khác biệt ghi rõ; (2) RAM ghi cạnh Electron.
- **Tính năng:** —
- **Trạng thái:** ⬜

### M5c Đóng dấu, đánh số, watermark

### R5.29 · Watermark · M
- **Mô tả:** chữ hoặc ảnh, độ mờ, góc xoay, cỡ, nằm trên hoặc dưới nội dung, chọn trang. Gắn nhãn chuẩn (lớp tên "watermark") để gỡ sạch sau này. Operation `overlay.watermark`.
- **Tiêu chí:** (1) nhãn chuẩn có trong file; (2) độ mờ và góc đúng; (3) nằm dưới nội dung khi chọn "dưới".
- **Kiểm chứng:** E2E `stamps2`; đọc nhãn bằng pikepdf.
- **Phụ thuộc:** R4.11
- **File:** `apps/native/crates/chef-app/src/watermark.rs`
- **E2E:** `stamps2`
- **Tính năng:** F1
- **Trạng thái:** ⬜

### R5.30 · Con dấu chữ và con dấu ảnh · M
- **Mô tả:** con dấu chữ với font tiếng Việt đóng gói, viền, nền trong suốt; con dấu ảnh kéo thả đổi cỡ, xoay. Thư viện mẫu (ĐÃ DUYỆT, MẬT, KHẨN, BẢN SAO, ĐÃ NHẬN…).
- **Tiêu chí:** (1) chữ tiếng Việt đúng dấu trong con dấu; (2) ảnh có nền trong suốt; (3) thư viện mẫu tạo và xóa được.
- **Kiểm chứng:** E2E `stamps2`; screenshot.
- **Phụ thuộc:** R5.29
- **File:** `apps/native/crates/chef-app/src/stamps.rs`
- **E2E:** `stamps2`
- **Tính năng:** F2, F3
- **Trạng thái:** ⬜

### R5.31 · Dấu giáp lai · M
- **Mô tả:** dấu giáp lai trên mép các trang chọn, theo kiểu văn bản hành chính Việt Nam: chọn trang, vị trí dọc, số phần cắt. Dùng cho bước "Phát hành văn bản".
- **Tiêu chí:** (1) dấu nằm đúng mép phải và đều giữa các trang; (2) số phần đúng; (3) có xem trước.
- **Kiểm chứng:** E2E `stamps2`; ảnh xem trước.
- **Phụ thuộc:** R5.30
- **File:** `apps/native/crates/chef-app/src/giap_lai.rs`
- **E2E:** `stamps2`
- **Tính năng:** F4
- **Trạng thái:** ⬜

### R5.32 · Con dấu động · M
- **Mô tả:** dấu có ngày giờ, tên người và số tự điền khi đóng dấu, ví dụ "ĐÃ NHẬN – 14:30 31/10/2026 – Nguyễn A".
- **Tiêu chí:** (1) biến điền đúng; (2) định dạng ngày theo cài đặt; (3) mỗi trang có giá trị đúng nếu đánh theo trang.
- **Kiểm chứng:** E2E `stamps2`; test.
- **Phụ thuộc:** R5.30
- **File:** `apps/native/crates/chef-app/src/dynamic_stamp.rs`
- **E2E:** `stamps2`
- **Tính năng:** F5
- **Trạng thái:** ⬜

### R5.33 · Chữ ký nháy mọi trang · M
- **Mô tả:** đóng ảnh chữ ký tắt lên góc mọi trang hoặc các trang chọn. Dùng thư viện chữ ký ở M6 (R6.07); nếu chưa có thì nhận ảnh từ file.
- **Tiêu chí:** (1) ảnh xuất hiện trên đúng các trang; (2) có thể bỏ qua một trang; (3) không chặn ký số về sau.
- **Kiểm chứng:** E2E `signflow` (phần nháy); test.
- **Phụ thuộc:** R5.30, R6.07
- **File:** `apps/native/crates/chef-app/src/initials.rs`
- **E2E:** `signflow`
- **Tính năng:** F6
- **Trạng thái:** ⬜

### R5.34 · Header và footer · M
- **Mô tả:** chữ hoặc ảnh ở đầu hoặc chân trang (trái, giữa, phải), biến `{ngay}`, `{tenfile}`, `{trang}`, `{tongtrang}`, chọn trang, lưu thành preset.
- **Tiêu chí:** (1) từng biến điền đúng; (2) vị trí trái, giữa, phải đúng; (3) preset lưu và tải lại.
- **Kiểm chứng:** E2E `stamps2`; test.
- **Phụ thuộc:** R5.30
- **File:** `apps/native/crates/chef-app/src/header_footer.rs`
- **E2E:** `stamps2`
- **Tính năng:** F7
- **Trạng thái:** ⬜

### R5.35 · Đánh số trang · M
- **Mô tả:** kiểu "1", "Trang 1/10", "- 1 -", số La Mã; chọn vị trí; bỏ trang đầu; bắt đầu từ số bất kỳ. Preset theo Nghị định 30/2020/NĐ-CP (giữa lề trên, không đánh số trang đầu).
- **Tiêu chí:** (1) bốn kiểu đúng; (2) preset NĐ30 không đánh số trang đầu; (3) bắt đầu từ số đã đặt.
- **Kiểm chứng:** E2E `stamps2`; test.
- **Phụ thuộc:** R5.30 (đổi từ R5.34 ngày 2026-11-11: không dùng mã của header/footer)
- **File:** `apps/native/crates/chef-app/src/page_numbers.rs`
- **E2E:** `stamps2`
- **Tính năng:** F8
- **Trạng thái:** ⬜

### R5.36 · Đánh số Bates · M
- **Mô tả:** mã tài liệu liên tục qua nhiều file (HS-000001…), tiền tố, số bắt đầu, chọn trang. Dùng `overlay_bates.py`.
- **Tiêu chí:** (1) số liên tục qua hai file; (2) tiền tố và độ dài đúng; (3) chạy lại không đánh số lại trang đã đánh.
- **Kiểm chứng:** E2E `stamps2`; test hai file.
- **Phụ thuộc:** R5.30 (đổi từ R5.35 ngày 2026-11-11: Bates dùng `overlay_bates.py` riêng)
- **File:** `apps/native/crates/chef-app/src/bates.rs`
- **E2E:** `stamps2`
- **Tính năng:** F9
- **Trạng thái:** ⬜

### R5.37 · Mã QR và mã vạch · M
- **Mô tả:** chèn QR hoặc mã vạch chứa link, mã hồ sơ, số văn bản. Dùng được trong đánh số Bates (`overlay_code.py`).
- **Tiêu chí:** (1) QR đọc được bằng một bộ giải mã chuẩn; (2) mã vạch đúng loại; (3) trong Bates, mỗi trang mã khác nhau.
- **Kiểm chứng:** E2E `workflow-qr-code-step`; giải mã mẫu.
- **Phụ thuộc:** R5.36
- **File:** `apps/native/crates/chef-app/src/codes.rs`
- **E2E:** `workflow-qr-code-step`
- **Tính năng:** F10
- **Trạng thái:** ⬜

### R5.38 · Chồng lên giấy tiêu đề · S
- **Mô tả:** đặt nội dung lên mẫu giấy tiêu đề (một file PDF khác), áp cho trang đầu hoặc mọi trang.
- **Tiêu chí:** (1) nội dung nằm trên mẫu đúng vị trí; (2) mẫu không bị sửa.
- **Kiểm chứng:** test; SHA-256 mẫu.
- **Phụ thuộc:** R5.29
- **File:** `apps/native/crates/chef-app/src/letterhead.rs`
- **Tính năng:** F11
- **Trạng thái:** ⬜

### R5.39 · Quản lý và gỡ dấu đã thêm · M
- **Mô tả:** sửa hoặc gỡ watermark, header, footer, số trang mà Chef PDF đã thêm, nhờ nhãn chuẩn của R5.29.
- **Tiêu chí:** (1) gỡ đúng mục đã thêm, không gỡ nội dung gốc; (2) sửa một mục không làm mất các mục khác; (3) có undo.
- **Kiểm chứng:** E2E `stamps2`; đọc lại nhãn.
- **Phụ thuộc:** R5.29, R5.34, R5.35
- **File:** `apps/native/crates/chef-app/src/overlay_manage.rs`
- **E2E:** `stamps2`
- **Tính năng:** F12
- **Trạng thái:** ⬜

### R5.40 · Gỡ watermark tự động · M
- **Mô tả:** tìm ứng viên watermark (nhãn chuẩn, lớp tên "watermark", ghi chú kiểu watermark, đối tượng lặp cùng vị trí, đối tượng xoay chéo hoặc trong suốt), hiện danh sách kèm xem trước để tích chọn. Không tự xóa.
- **Tiêu chí:** (1) danh sách có đủ năm loại ứng viên; (2) không xóa khi chưa tích; (3) gỡ đúng các mục đã tích.
- **Kiểm chứng:** E2E `content-v06` (phần gỡ); test với mẫu có watermark.
- **Phụ thuộc:** R5.39, R4.16
- **File:** `apps/native/crates/chef-app/src/watermark_detect.rs`
- **E2E:** `content-v06`
- **Tính năng:** E3
- **Trạng thái:** ⬜

### R5.41 · Gỡ đối tượng giống thế này · M
- **Mô tả:** chọn một đối tượng (ví dụ logo chìm), gỡ nó trên mọi trang. So khớp theo nội dung và kích thước.
- **Tiêu chí:** (1) logo gỡ khỏi mọi trang chứa nó; (2) trang không có logo không đổi; (3) có undo.
- **Kiểm chứng:** E2E `content-v06`; test.
- **Phụ thuộc:** R4.11
- **File:** `apps/native/crates/chef-app/src/remove_similar.rs`
- **E2E:** `content-v06`
- **Tính năng:** E4
- **Trạng thái:** ⬜

### R5.42 · Gỡ hoặc đổi nền trang · M
- **Mô tả:** xóa màu nền hoặc ảnh nền, đặt nền mới (ảnh hoặc màu). Operation `content.background`.
- **Tiêu chí:** (1) nền cũ biến mất; (2) nền mới đúng phủ kín trang; (3) chữ và ảnh không đổi.
- **Kiểm chứng:** E2E `content-v06`; test.
- **Phụ thuộc:** R4.11
- **File:** `apps/native/crates/chef-app/src/background.rs`
- **E2E:** `content-v06`
- **Tính năng:** E5
- **Trạng thái:** ⬜

### R5.43 · Điểm kiểm 5c · —
- **Mô tả:** E2E `stamps2`, `workflow-qr-code-step`, `content-v06`; kiểm tra số đánh và dấu trên file ký (phần M6).
- **Tiêu chí:** (1) E2E đạt; (2) báo cáo ghi.
- **Tính năng:** —
- **Trạng thái:** ⬜

### M5d Bảo mật

### R5.44 · Đặt mật khẩu · M
- **Mô tả:** mật khẩu mở file, giới hạn quyền in, copy, sửa, mã hóa AES-256. Operation `security.encrypt`.
- **Tiêu chí:** (1) file mở được bằng mật khẩu đã đặt; (2) quyền bị giới hạn đúng (kiểm bằng pikepdf); (3) mật khẩu không vào log.
- **Kiểm chứng:** E2E `tools5`; đọc bằng pikepdf.
- **Phụ thuộc:** R5.02
- **File:** `apps/native/crates/chef-app/src/encrypt.rs`
- **E2E:** `tools5`
- **Tính năng:** J1
- **Trạng thái:** ⬜

### R5.45 · Gỡ mật khẩu · S
- **Mô tả:** gỡ mật khẩu khi đã biết mật khẩu. Không có cách bẻ mật khẩu.
- **Tiêu chí:** (1) đúng mật khẩu gỡ được; (2) sai mật khẩu báo lỗi, không tự thử; (3) file sau khi gỡ mở không cần mật khẩu.
- **Kiểm chứng:** test.
- **Phụ thuộc:** R5.44
- **File:** `apps/native/crates/chef-app/src/decrypt.rs`
- **Tính năng:** J2
- **Trạng thái:** ⬜

### R5.46 · Gỡ dữ liệu ẩn · M
- **Mô tả:** xóa metadata, JavaScript, file đính kèm, lớp ẩn, ghi chú, lịch sử sửa. Operation `security.scrub`.
- **Tiêu chí:** (1) từng loại được xóa, kiểm bằng pikepdf; (2) chữ và ảnh không đổi; (3) cho chọn từng loại.
- **Kiểm chứng:** E2E `redact`; test.
- **Phụ thuộc:** R5.02
- **File:** `apps/native/crates/chef-app/src/scrub.rs`
- **E2E:** `redact`
- **Tính năng:** J3
- **Trạng thái:** ⬜

### R5.47 · Soi file · M
- **Mô tả:** xem metadata, khổ giấy, font, phiên bản PDF, số trang, dung lượng, lớp, file đính kèm, JavaScript, link ra ngoài, form, chữ ký, font chưa nhúng, lớp ẩn.
- **Tiêu chí:** (1) số liệu khớp với pikepdf trên mẫu; (2) từng mục có mô tả tiếng Việt; (3) không sửa file.
- **Kiểm chứng:** E2E `redact` (phần soi); so với pikepdf.
- **Phụ thuộc:** R2.27
- **File:** `apps/native/crates/chef-app/src/inspect.rs`
- **E2E:** `redact`
- **Tính năng:** J4
- **Trạng thái:** ⬜

### R5.48 · Kiểm tra trước khi gửi · M
- **Mô tả:** một nút chạy danh sách kiểm: metadata, ghi chú còn sót, form chưa làm phẳng, dung lượng vượt giới hạn (5, 10, 25 MB), chữ ký còn hợp lệ. Bấm để sửa từng mục. Xuất kết quả ra PDF (phần xuất ở M5e nếu dùng chung).
- **Tiêu chí:** (1) từng mục có kết quả đạt hoặc không; (2) bấm mục đưa đến chỗ sửa; (3) file không đổi khi chỉ kiểm tra.
- **Kiểm chứng:** E2E `redact`; test.
- **Phụ thuộc:** R5.47, R5.27
- **File:** `apps/native/crates/chef-app/src/preflight.rs`
- **E2E:** `redact`
- **Tính năng:** J5
- **Trạng thái:** ⬜

### R5.49 · Che thông tin mật · M
- **Mô tả:** chọn vùng chữ hoặc ảnh, tìm và che hàng loạt (CCCD, số điện thoại, email, số tài khoản), xóa hẳn nội dung bên dưới. Khác với tẩy vùng (D5).
- **Tiêu chí:** (1) nội dung dưới vùng che không còn khi trích chữ (kiểm bằng pdfium và pikepdf); (2) tìm đúng CCCD và số điện thoại; (3) ô đen hiện đúng.
- **Kiểm chứng:** E2E `redact`; trích chữ sau khi che.
- **Phụ thuộc:** R2.23, R4.11
- **File:** `apps/native/crates/chef-app/src/redact.rs`
- **E2E:** `redact`
- **Tính năng:** J6
- **Trạng thái:** ⬜

### R5.50 · Điểm kiểm 5d · —
- **Mô tả:** E2E `redact`, `tools5`; kiểm không còn nội dung sau khi che bằng hai cách đọc khác nhau.
- **Tiêu chí:** (1) E2E đạt; (2) hai cách đọc đều không thấy nội dung đã che.
- **Tính năng:** —
- **Trạng thái:** ⬜

### M5e Rã tài liệu và xuất

### R5.51 · Rã PDF có chữ · M
- **Mô tả:** lấy chữ kèm font, cỡ, đậm, nghiêng, gom dòng thành đoạn, nhận tiêu đề theo cỡ chữ, danh sách, link, tách ảnh, thứ tự đọc (kể cả nhiều cột), bỏ header, footer, số trang lặp. Dùng lõi `layout/`.
- **Tiêu chí:** (1) đoạn và tiêu đề đúng trên mẫu hai cột; (2) header lặp bị bỏ; (3) thứ tự đọc đúng.
- **Kiểm chứng:** E2E `tools5-docs`, `document-export`; so với bản Electron.
- **Phụ thuộc:** R5.02
- **File:** `apps/native/crates/chef-app/src/layout_extract.rs`
- **E2E:** `tools5-docs`, `document-export`
- **Tính năng:** N1
- **Trạng thái:** ⬜

### R5.52 · Bảng đơn giản · M
- **Mô tả:** bảng có đường kẻ trong PDF có chữ thành bảng (Markdown, HTML, Excel). Bảng không kẻ, ô gộp, bảng trong bản scan để sau (N2 nâng cao).
- **Tiêu chí:** (1) bảng kẻ đủ dòng và cột; (2) xuất Excel mở được; (3) bảng không kẻ được đánh dấu chưa hỗ trợ.
- **Kiểm chứng:** E2E `tools5-docs`; mở Excel-định dạng bằng XLSX reader.
- **Phụ thuộc:** R5.51
- **File:** `apps/native/crates/chef-app/src/tables.rs`
- **E2E:** `tools5-docs`
- **Tính năng:** N2
- **Trạng thái:** ⬜

### R5.53 · Màn hình kiểm tra và sửa: bố cục đối chiếu · M
- **Mô tả:** bản gốc một bên, kết quả một bên, bấm chỗ nào nhảy tới chỗ đó. Tô vàng chữ đáng ngờ (phần OCR để gói Q).
- **Tiêu chí:** (1) hai khung cuộn đồng bộ; (2) bấm đoạn nhảy đúng trang và vị trí; (3) bố cục khớp `review.css`.
- **Kiểm chứng:** E2E `layout-review`; ui-audit.
- **Phụ thuộc:** R5.51
- **File:** `apps/native/crates/chef-app/src/review_view.rs`
- **E2E:** `layout-review`
- **Tính năng:** N3 (bố cục)
- **Trạng thái:** ⬜

### R5.54 · Màn hình kiểm tra và sửa: sửa và đổi loại vùng · M
- **Mô tả:** sửa chữ trong đoạn, đổi loại vùng (đoạn, tiêu đề, bảng, hình), bỏ vùng không cần.
- **Tiêu chí:** (1) sửa chữ lưu vào mô hình; (2) đổi loại đổi cách xuất; (3) có undo.
- **Kiểm chứng:** E2E `layout-review`; test.
- **Phụ thuộc:** R5.53
- **File:** `apps/native/crates/chef-app/src/review_edit.rs`
- **E2E:** `layout-review`
- **Tính năng:** N3
- **Trạng thái:** ⬜

### R5.55 · Xuất định dạng · M
- **Mô tả:** Markdown (kèm thư mục ảnh), DOCX, HTML, EPUB, ODT, TXT, XLSX (chỉ bảng), JSON. Dùng `export/`.
- **Tiêu chí:** (1) từng định dạng mở được ở trình xem tương ứng; (2) ảnh đi kèm đúng thư mục; (3) XLSX chỉ có bảng.
- **Kiểm chứng:** E2E `document-export`; mở từng file.
- **Phụ thuộc:** R5.54
- **File:** `apps/native/crates/chef-app/src/export.rs`
- **E2E:** `document-export`
- **Tính năng:** N4
- **Trạng thái:** ⬜

### R5.56 · Hai chế độ xuất Word · M
- **Mô tả:** chế độ sửa được (văn bản chảy, style Heading) và chế độ giữ bố cục (khung định vị, cột). Quốc hiệu và thể thức văn bản hành chính (Q6) để sau.
- **Tiêu chí:** (1) chế độ sửa được: đoạn chảy, sửa được trong Word; (2) chế độ giữ bố cục: khung đặt đúng; (3) mở cả hai bằng Word-reader.
- **Kiểm chứng:** E2E `document-export`; mở hai file.
- **Phụ thuộc:** R5.55
- **File:** `apps/native/crates/chef-app/src/export_word.rs`
- **E2E:** `document-export`
- **Tính năng:** N5
- **Trạng thái:** ⬜

### R5.57 · Làm mới tài liệu · M
- **Mô tả:** dàn trang lại thành PDF sạch, font đẹp từ mô hình tài liệu.
- **Tiêu chí:** (1) PDF mở được; (2) font tiếng Việt đúng; (3) số trang gần với gốc (sai lệch có giải thích).
- **Kiểm chứng:** E2E `tools5-docs`; so trang.
- **Phụ thuộc:** R5.54
- **File:** `apps/native/crates/chef-app/src/refresh.rs`
- **E2E:** `tools5-docs`
- **Tính năng:** N6
- **Trạng thái:** ⬜

### R5.58 · Rã hàng loạt · S
- **Mô tả:** rã cả thư mục, dùng làm một bước trong quy trình (M5f).
- **Tiêu chí:** (1) mỗi file ra một kết quả; (2) lỗi một file không dừng cả lô; (3) báo tiến độ.
- **Kiểm chứng:** E2E `tools5-docs`; test.
- **Phụ thuộc:** R5.51, R3.09
- **File:** `apps/native/crates/chef-app/src/batch_extract.rs`
- **E2E:** `tools5-docs`
- **Tính năng:** N7
- **Trạng thái:** ⬜

### R5.59 · Tự tạo mục lục · S
- **Mô tả:** tạo bookmark từ tiêu đề đã rã (N1) hoặc theo mẫu. Dùng `toc.py`.
- **Tiêu chí:** (1) mục lục khớp tiêu đề; (2) bookmark trỏ đúng trang; (3) có undo.
- **Kiểm chứng:** E2E `toc`; test.
- **Phụ thuộc:** R5.51, R4.10
- **File:** `apps/native/crates/chef-app/src/toc_build.rs`
- **E2E:** `toc`
- **Tính năng:** D12
- **Trạng thái:** ⬜

### R5.60 · Điểm kiểm 5e · —
- **Mô tả:** E2E `tools5-docs`, `document-export`, `layout-review`, `toc`, `demo-v10`.
- **Tiêu chí:** (1) E2E đạt; (2) ghi khác biệt.
- **Tính năng:** —
- **Trạng thái:** ⬜

### M5f Quy trình và hàng loạt

### R5.61 · Trình tạo quy trình · M
- **Mô tả:** ghép các bước thành chuỗi (ví dụ: Ghép, Đánh số trang, Dấu giáp lai, Bản scan 200 dpi xám, Ký số, Lưu). Lưu và chia sẻ dưới dạng file. Dùng `workflow.py` và `workflow.ts` làm mẫu.
- **Tiêu chí:** (1) thêm, bớt, đổi thứ tự bước; (2) lưu rồi mở lại giữ nguyên bước; (3) file quy trình đọc được bằng bản Electron.
- **Kiểm chứng:** E2E `workflow`; so định dạng file.
- **Phụ thuộc:** R5.02, R3.08
- **File:** `apps/native/crates/chef-app/src/workflow_editor.rs`
- **E2E:** `workflow`
- **Tính năng:** O1
- **Trạng thái:** ⬜

### R5.62 · Chạy hàng loạt · M
- **Mô tả:** áp quy trình cho nhiều file, thanh tiến độ, báo lỗi từng file, không dừng cả lô khi một file lỗi.
- **Tiêu chí:** (1) lỗi một file không dừng lô; (2) báo từng file; (3) hủy được.
- **Kiểm chứng:** E2E `workflow-batch-crop-step`; test.
- **Phụ thuộc:** R5.61
- **File:** `apps/native/crates/chef-app/src/workflow_run.rs`
- **E2E:** `workflow-batch-crop-step`, `workflow-task-step`, `workflow-background-step`
- **Tính năng:** O2
- **Trạng thái:** ⬜

### R5.63 · Thư mục tự động · M
- **Mô tả:** thả file vào thư mục là app chạy quy trình. Dùng `watch.py` và `watch.spec` (`watch.ts`).
- **Tiêu chí:** (1) file mới trong thư mục được xử lý một lần; (2) file đang chép chưa xong không bị xử lý; (3) tắt theo dõi được.
- **Kiểm chứng:** E2E `watch`; test.
- **Phụ thuộc:** R5.62
- **File:** `apps/native/crates/chef-app/src/watch.rs`
- **E2E:** `watch`
- **Tính năng:** O3
- **Trạng thái:** ⬜

### R5.64 · Quy tắc đặt tên đầu ra · S
- **Mô tả:** mẫu `{ten}_{ngay}_da-ky.pdf`, và các biến khác. Dùng `naming.py`.
- **Tiêu chí:** (1) mẫu thay biến đúng; (2) ký tự không hợp lệ trên Windows được thay; (3) tên trùng được đánh số thêm.
- **Kiểm chứng:** test.
- **Phụ thuộc:** R5.62
- **File:** `apps/native/crates/chef-app/src/naming.rs`
- **Tính năng:** O4
- **Trạng thái:** ⬜

### R5.65 · Tự sắp xếp thứ tự an toàn · S
- **Mô tả:** sắp xếp file trong lô theo tên hoặc ngày, không làm mất file (dùng `ordering.py`).
- **Tiêu chí:** (1) số file không đổi; (2) thứ tự khớp tiêu chí; (3) tên có số được sắp đúng (2 trước 10).
- **Kiểm chứng:** test.
- **Phụ thuộc:** R5.62
- **File:** `apps/native/crates/chef-app/src/ordering.rs`
- **Tính năng:** O5
- **Trạng thái:** ⬜

### R5.66 · Đổi tên file hàng loạt · S
- **Mô tả:** đổi tên theo mẫu, xem trước danh sách mới trước khi chạy.
- **Tiêu chí:** (1) xem trước đúng; (2) hoàn tác được bằng nhật ký; (3) không ghi đè.
- **Kiểm chứng:** E2E `rename`.
- **Phụ thuộc:** R5.64
- **File:** `apps/native/crates/chef-app/src/rename.rs`
- **E2E:** `rename`
- **Tính năng:** O6
- **Trạng thái:** ⬜

### R5.67 · Quy trình mẫu có sẵn · S
- **Mô tả:** các quy trình mẫu: Nhẹ, Chuẩn, Nét, Văn bản hành chính, Nộp hồ sơ online, Phát hành văn bản, Chụp sách (phần chụp sách chờ M8).
- **Tiêu chí:** (1) mỗi mẫu chạy được trên file mẫu; (2) mẫu khớp bản Electron.
- **Kiểm chứng:** E2E `start-workflows`, `workflow-task-step`.
- **Phụ thuộc:** R5.61
- **File:** `apps/native/crates/chef-app/src/workflow_samples.rs`
- **E2E:** `start-workflows`
- **Tính năng:** O7
- **Trạng thái:** ⬜

### R5.68 · Kéo thả file lên quy trình · S
- **Mô tả:** kéo file vào một quy trình ở màn hình Start là chạy.
- **Tiêu chí:** (1) kéo một file chạy đúng quy trình; (2) kéo nhiều file chạy một lô.
- **Kiểm chứng:** E2E `start-workflows`.
- **Phụ thuộc:** R5.62, R2.17
- **File:** `apps/native/crates/chef-app/src/drop_workflow.rs`
- **E2E:** `start-workflows`
- **Tính năng:** O8
- **Trạng thái:** ⬜

### R5.69 · Điểm kiểm M5 · —
- **Mô tả:** E2E toàn bộ M5 (`tools5`, `tools5-convert`, `tools5-docs`, `scan`, `stamps2`, `redact`, `workflow*`, `watch`, `rename`, `web2pdf`); đo RAM khi chạy lô 20 file.
- **Tiêu chí:** (1) E2E đạt hoặc khác biệt ghi rõ; (2) RAM lô ghi cạnh Electron; (3) M6–M9 xem lại.
- **Tính năng:** —
- **Trạng thái:** ⬜

---

## M6: Ký số

**Mục tiêu:** toàn bộ phần ký số qua lõi: chứng thư file và token (PKCS#11), chẩn đoán, studio mẫu chữ ký, ảnh chữ ký, đặt và ký, kiểm tra chữ ký. Ký thật với token Viettel-CA là việc có kiểm tra của chủ dự án (MAN-2).
**Demo:** cắm token Viettel-CA, chẩn đoán xanh, tạo mẫu chữ ký có ảnh tách nền, ký theo chữ mốc cho 10 file, Adobe Reader báo chữ ký hợp lệ.
**Đầu vào:** M3 (ops và job), M5f (quy trình ký) và R1.41 (import lười pyHanko).
**Ghi chú:** việc ký và kiểm tra chạy trong lõi Python (pyHanko, PKCS#11). Rust chỉ hiện giao diện và gửi operation. Mật khẩu PFX nhập lại một lần (D73).

### M6.0 Chứng thư và token

### R6.01 · Ops token và chứng thư: liệt kê · M
- **Mô tả:** operation liệt kê token đang cắm và chứng thư của token, gọi `sign_token.py` và `sign_common.py`. Không ký ở bước này.
- **Tiêu chí:** (1) không có token thì báo rõ, không lỗi; (2) có token thì liệt kê chứng thư; (3) không gửi PIN đi khi chỉ liệt kê.
- **Kiểm chứng:** test với lõi giả; trên máy chủ dự án với token thật (MAN-2).
- **Phụ thuộc:** R3.08, R1.41
- **File:** `apps/native/crates/chef-app/src/sign_list.rs`
- **E2E:** `certs`
- **Tính năng:** I1
- **Trạng thái:** ⬜

### R6.02 · Chứng thư file .pfx và .p12 · S
- **Mô tả:** chọn file chứng thư, nhập mật khẩu một lần (D73), tùy chọn ghi nhớ mật khẩu vào kho bảo mật của hệ điều hành (ở bản Rust, không dùng DPAPI-giải-mã từ Electron).
- **Tiêu chí:** (1) mật khẩu sai báo lại; (2) mật khẩu không vào log; (3) "ghi nhớ" lưu bằng cơ chế mới và không đọc được từ bản Electron.
- **Kiểm chứng:** E2E `certs`; test với PFX mẫu.
- **Phụ thuộc:** R6.01
- **File:** `apps/native/crates/chef-app/src/pfx.rs`
- **E2E:** `certs`
- **Tính năng:** I2
- **Trạng thái:** ⬜

### R6.03 · Thông tin chứng thư và nhắc hết hạn · S
- **Mô tả:** chủ sở hữu, đơn vị cấp, hạn dùng, MST hoặc CCCD. Nhắc trước khi hết hạn (mặc định 30 ngày).
- **Tiêu chí:** (1) thông tin khớp chứng thư mẫu; (2) chứng thư sắp hết hạn có nhắc; (3) đã hết hạn có cảnh báo đỏ.
- **Kiểm chứng:** E2E `certs`; test với chứng thư có hạn giả.
- **Phụ thuộc:** R6.01
- **File:** `apps/native/crates/chef-app/src/cert_info.rs`
- **E2E:** `certs`
- **Tính năng:** I3
- **Trạng thái:** ⬜

### R6.04 · Danh bạ driver token · M
- **Mô tả:** file dữ liệu CA → đời token → hệ điều hành → đường dẫn thư viện PKCS#11. Cập nhật được mà không cần bản app mới (`sign_trust` và `docs/TOKENS.md` làm nguồn).
- **Tiêu chí:** (1) danh bạ đọc được và khớp `docs/TOKENS.md` cho Viettel V6; (2) thêm một CA không đổi mã; (3) file hỏng báo lỗi, không dừng app.
- **Kiểm chứng:** test; so với `docs/TOKENS.md`.
- **Phụ thuộc:** R6.01
- **File:** `apps/native/crates/chef-app/src/driver_db.rs`
- **E2E:** `certs`
- **Tính năng:** I4
- **Trạng thái:** ⬜

### R6.05 · Quét driver và kho chứng thư hệ điều hành · M
- **Mô tả:** nút "Quét tìm driver" thử nạp thư viện trong thư mục hệ thống. Kho chứng thư Windows là đường dự phòng cho token chỉ có driver CSP.
- **Tiêu chí:** (1) quét không treo app; (2) tìm thấy driver của Viettel V6 trên máy chủ dự án; (3) kho Windows liệt kê được chứng thư.
- **Kiểm chứng:** MAN-2 cho token; test cho kho.
- **Phụ thuộc:** R6.04
- **File:** `apps/native/crates/chef-app/src/driver_scan.rs`
- **E2E:** `certs`
- **Tính năng:** I5, I8
- **Trạng thái:** ⬜

### R6.06 · Chẩn đoán token năm bước · M
- **Mô tả:** kiểm từng bước: thấy token → nạp driver → có chứng thư → còn hạn → tin cậy. Mỗi lỗi kèm hướng dẫn tiếng Việt và link tải driver đúng CA. Cảnh báo khi token sắp bị khóa vì nhập sai PIN; không bao giờ tự thử lại PIN sai.
- **Tiêu chí:** (1) năm bước đúng trên token thật (MAN-2); (2) mỗi lỗi có hướng dẫn; (3) PIN sai không được thử lại tự động (test bằng lõi giả đếm số lần thử).
- **Kiểm chứng:** MAN-2; test đếm số lần thử PIN.
- **Phụ thuộc:** R6.04, R6.05
- **File:** `apps/native/crates/chef-app/src/diagnose.rs`
- **E2E:** `certs`
- **Tính năng:** I6, I7
- **Trạng thái:** ⬜

### M6.1 Ảnh chữ ký và thư viện

### R6.07 · Tạo ảnh chữ ký · M
- **Mô tả:** vẽ bằng chuột, bút cảm ứng, bảng vẽ; gõ tên với font viết tay. Chụp bằng điện thoại qua QR để ở M8 (R8.07).
- **Tiêu chí:** (1) nét vẽ mượt ở 60 khung; (2) font viết tay hiển thị đúng dấu tiếng Việt; (3) ảnh lưu thành PNG trong suốt.
- **Kiểm chứng:** E2E `sigstudio`; screenshot.
- **Phụ thuộc:** R2.03
- **File:** `apps/native/crates/chef-app/src/sig_draw.rs`
- **E2E:** `sigstudio`
- **Tính năng:** I19
- **Trạng thái:** ⬜

### R6.08 · Tách nền tự động · M
- **Mô tả:** bỏ nền giấy, giữ nét mực trong suốt, chỉnh độ nhạy, xem trước trên nền caro, tự nhận màu mực. Operation `signature.clean` (lõi, `pageimg`).
- **Tiêu chí:** (1) nền giấy thành trong suốt ở mẫu chụp; (2) nét mực giữ nguyên; (3) xem trước đúng trên caro.
- **Kiểm chứng:** E2E `sigstudio`; so ảnh mẫu.
- **Phụ thuộc:** R6.07
- **File:** `apps/native/crates/chef-app/src/sig_clean.rs`
- **E2E:** `sigstudio`
- **Tính năng:** I20
- **Trạng thái:** ⬜

### R6.09 · Làm sạch và chỉnh ảnh chữ ký · M
- **Mô tả:** cắt sát nét mực, xoay, xóa chấm bẩn, đổi màu mực, làm đậm hoặc mảnh nét, chỉnh độ mờ.
- **Tiêu chí:** (1) cắt sát đúng khung nét; (2) đổi màu mực không đổi độ trong suốt; (3) đậm và mảnh nét đúng hướng.
- **Kiểm chứng:** E2E `sigstudio`.
- **Phụ thuộc:** R6.08
- **File:** `apps/native/crates/chef-app/src/sig_adjust.rs`
- **E2E:** `sigstudio`
- **Tính năng:** I21
- **Trạng thái:** ⬜

### R6.10 · Bảo vệ thư viện chữ ký · M
- **Mô tả:** mã hóa ảnh chữ ký khi lưu. Hỏi mật khẩu của app trước khi dùng. Windows Hello là mục sau, vì cần API riêng (ghi trong NOTES khi làm).
- **Tiêu chí:** (1) file ảnh trên đĩa không đọc được như PNG; (2) mật khẩu sai không mở được; (3) khóa lại khi đóng app.
- **Kiểm chứng:** test; đọc file thô.
- **Phụ thuộc:** R6.07
- **File:** `apps/native/crates/chef-app/src/sig_vault.rs`
- **Tính năng:** I23
- **Trạng thái:** ⬜

### M6.2 Studio mẫu chữ ký

### R6.11 · Studio: quản lý mẫu · M
- **Mô tả:** tạo, sửa, nhân bản, xóa mẫu chữ ký; chọn mẫu mặc định. Thay `sigLibrary.css`.
- **Tiêu chí:** (1) nhân bản giữ cấu hình, không giữ ảnh chung; (2) xóa mẫu đang mặc định hỏi trước; (3) bố cục khớp ui-audit.
- **Kiểm chứng:** E2E `sigstudio`; ui-audit.
- **Phụ thuộc:** R6.07, R5.01
- **File:** `apps/native/crates/chef-app/src/sig_studio.rs`
- **E2E:** `sigstudio`
- **Tính năng:** I10
- **Trạng thái:** ⬜

### R6.12 · Studio: gắn mẫu với chứng thư, xuất và nhập · S
- **Mô tả:** gắn mẫu mặc định với từng chứng thư; xuất và nhập mẫu ra file.
- **Tiêu chí:** (1) chọn chứng thư thì mẫu tự đổi; (2) file mẫu nhập lại khớp; (3) mẫu gắn chứng thư không bị lẫn giữa hai chứng thư.
- **Kiểm chứng:** E2E `sigstudio`.
- **Phụ thuộc:** R6.11, R6.02
- **File:** `apps/native/crates/chef-app/src/sig_studio_io.rs`
- **E2E:** `sigstudio`
- **Tính năng:** I10
- **Trạng thái:** ⬜

### R6.13 · Nguồn dữ liệu và thông tin hiển thị · M
- **Mô tả:** tích chọn từng dòng: Người ký, Đơn vị, Chức vụ, Email, MST/CCCD, Ngày ký, Lý do, Nơi ký, Liên hệ, Doanh nghiệp, dòng tùy ý. Lấy dữ liệu từ chứng thư, cho ghi đè chữ hiển thị. Panel kiểm tra (R6.27) luôn hiện thông tin thật.
- **Tiêu chí:** (1) dòng chọn bật tắt đổi được; (2) ghi đè không đổi thông tin thật trong chữ ký; (3) panel kiểm tra hiện thông tin thật.
- **Kiểm chứng:** E2E `sigstudio`; kiểm chữ ký bằng R6.27.
- **Phụ thuộc:** R6.03, R6.11
- **File:** `apps/native/crates/chef-app/src/sig_fields_ui.rs`
- **E2E:** `sigstudio`
- **Tính năng:** I11, I12
- **Trạng thái:** ⬜

### R6.14 · Định dạng ngày giờ, lý do và nơi ký · S
- **Mô tả:** `dd/MM/yyyy HH:mm:ss`, "Ngày 31 tháng 10 năm 2026", có hoặc không múi giờ, giờ máy hoặc giờ TSA. Danh sách lý do có sẵn, tự nhớ lý do đã nhập, nơi ký mặc định.
- **Tiêu chí:** (1) từng định dạng ra đúng chuỗi; (2) giờ TSA khác giờ máy được ghi rõ; (3) lý do đã nhập được gợi ý lần sau.
- **Kiểm chứng:** test định dạng; E2E `sigstudio`.
- **Phụ thuộc:** R6.13
- **File:** `apps/native/crates/chef-app/src/sig_datetime.rs`
- **E2E:** `sigstudio`
- **Tính năng:** I13, I14
- **Trạng thái:** ⬜

### R6.15 · Bố cục mẫu chữ ký · M
- **Mô tả:** ảnh trái và chữ phải, ảnh trên và chữ dưới, chỉ ảnh, chỉ chữ, ảnh mờ làm nền, chữ ký và con dấu chồng nhau; chỉnh tỉ lệ, lề, căn lề.
- **Tiêu chí:** (1) sáu bố cục hiển thị đúng; (2) chỉnh tỉ lệ giữ tỉ lệ ảnh; (3) xem trước khớp kết quả khi ký.
- **Kiểm chứng:** E2E `sigstudio`; ui-audit; so xem trước với PDF đã ký.
- **Phụ thuộc:** R6.13
- **File:** `apps/native/crates/chef-app/src/sig_layout.rs`
- **E2E:** `sigstudio`
- **Tính năng:** I15
- **Trạng thái:** ⬜

### R6.16 · Kiểu chữ, màu, biểu tượng hợp lệ, logo · M
- **Mô tả:** font tiếng Việt đóng gói, cỡ, màu, đậm nghiêng; biểu tượng hợp lệ kiểu "Signature Valid" (dấu ✓ của hóa đơn điện tử); logo công ty bên cạnh hoặc làm nền mờ.
- **Tiêu chí:** (1) dấu tiếng Việt đúng trong mẫu; (2) biểu tượng hiển thị đúng ở ba cỡ; (3) logo đặt đúng vị trí.
- **Kiểm chứng:** E2E `sigstudio`; screenshot.
- **Phụ thuộc:** R6.15
- **File:** `apps/native/crates/chef-app/src/sig_style.rs`
- **E2E:** `sigstudio`
- **Tính năng:** I16, I17, I18
- **Trạng thái:** ⬜

### M6.3 Đặt chữ ký và ký

### R6.17 · Đặt chữ ký: kéo khung, ký ẩn, ô sẵn, vị trí cố định · L
- **Mô tả:** kéo thả khung ký lên trang, ký ẩn (không hiện khung), ký vào ô ký có sẵn trong file, vị trí cố định theo tọa độ. Tách thành hai nhóm: đặt khung (kéo, ô sẵn) và vị trí cố định.
- **Tiêu chí:** (1) khung đặt đúng trang và vị trí; (2) ký vào ô sẵn đúng ô; (3) vị trí cố định không đổi khi đổi khổ trang (ghi rõ).
- **Kiểm chứng:** E2E `signflow`; đọc vị trí bằng pikepdf.
- **Phụ thuộc:** R6.16, R5.01
- **File:** `apps/native/crates/chef-app/src/sig_place.rs`
- **E2E:** `signflow`
- **Tính năng:** I25, I27
- **Trạng thái:** ⬜

### R6.18 · Ký thật bằng token qua lõi · L
- **Mô tả:** PAdES B-B với SHA-256 qua PKCS#11. Nhập PIN trong hộp thoại của app, PIN không đi qua log. Dùng `sign_token.py`, `pades.py`.
- **Tiêu chí:** (1) file đã ký mở được bằng pikepdf và pdfium; (2) PIN không xuất hiện trong log (grep); (3) PIN sai báo một lần, không thử lại tự động (R6.06).
- **Kiểm chứng:** MAN-2 (token Viettel-CA thật).
- **Phụ thuộc:** R6.06, R6.17
- **File:** `apps/native/crates/chef-app/src/sign_run.rs`
- **E2E:** `signflow`
- **Tính năng:** I25 (ký)
- **Trạng thái:** ⬜

### R6.19 · Kiểm tra chữ ký trên Adobe Reader và Foxit · XS
- **Mô tả:** MAN-2: mở file đã ký bằng Adobe Reader và Foxit, báo chữ ký hợp lệ, và ghi kết quả vào TOKENS.md.
- **Tiêu chí:** (1) cả hai báo hợp lệ; (2) ảnh chụp lưu ngoài repo; (3) ghi vào TOKENS.md.
- **Kiểm chứng:** ảnh chụp và ghi chú.
- **Phụ thuộc:** R6.18
- **File:** `docs/TOKENS.md`
- **Tính năng:** —
- **Trạng thái:** ⬜

### R6.20 · Đặt theo chữ mốc · M
- **Mô tả:** tìm cụm chữ ("NGƯỜI KÝ", "GIÁM ĐỐC") rồi đặt chữ ký ngay dưới hoặc cạnh nó. Dùng `sign_anchor.py`.
- **Tiêu chí:** (1) tìm đúng cụm có dấu và không dấu; (2) chữ ký nằm ngay dưới cụm; (3) không tìm thấy thì báo, không đặt bừa.
- **Kiểm chứng:** E2E `signflow`; test với mẫu.
- **Phụ thuộc:** R6.18, R2.23
- **File:** `apps/native/crates/chef-app/src/sig_anchor.rs`
- **E2E:** `signflow`
- **Tính năng:** I26
- **Trạng thái:** ⬜

### R6.21 · Tùy chọn kỹ thuật · S
- **Mô tả:** tùy chọn SHA-256, cấp độ PAdES, máy chủ TSA (danh sách TSA Việt Nam, có dự phòng), và các thiết lập của chữ ký trong file.
- **Tiêu chí:** (1) TSA chính lỗi thì dùng dự phòng; (2) tùy chọn lưu theo mẫu; (3) cấp độ đúng trong file.
- **Kiểm chứng:** E2E `signflow`; đọc bằng pikepdf.
- **Phụ thuộc:** R6.18
- **File:** `apps/native/crates/chef-app/src/sig_options.rs`
- **E2E:** `signflow`
- **Tính năng:** I28
- **Trạng thái:** ⬜

### R6.22 · Ký chứng nhận (certify) · M
- **Mô tả:** ký certify cho phép hoặc không cho phép sửa tiếp. Ràng buộc với mức quyền (I32).
- **Tiêu chí:** (1) mức quyền sau ký đúng; (2) sửa bị chặn đúng theo mức; (3) cảnh báo khi người dùng chọn mức không cho sửa.
- **Kiểm chứng:** E2E `signflow`; kiểm bằng pikepdf.
- **Phụ thuộc:** R6.18
- **File:** `apps/native/crates/chef-app/src/sig_certify.rs`
- **E2E:** `signflow`
- **Tính năng:** I29
- **Trạng thái:** ⬜

### R6.23 · Nhiều người ký · M
- **Mô tả:** ký nối tiếp không phá chữ ký trước; tạo ô ký trống cho người khác.
- **Tiêu chí:** (1) người thứ hai ký không làm chữ ký trước thành không hợp lệ; (2) ô ký trống hiện đúng; (3) thứ tự ký được ghi.
- **Kiểm chứng:** E2E `signflow`; kiểm bằng R6.27.
- **Phụ thuộc:** R6.18, R6.22
- **File:** `apps/native/crates/chef-app/src/sig_multi.rs`
- **E2E:** `signflow`
- **Tính năng:** I30
- **Trạng thái:** ⬜

### R6.24 · Ký hàng loạt · M
- **Mô tả:** ký nhiều file trong một lần, nhập PIN một lần, kết hợp với quy trình. Báo lỗi từng file.
- **Tiêu chí:** (1) PIN nhập một lần cho cả lô; (2) lỗi một file không dừng lô; (3) mỗi file có kết quả.
- **Kiểm chứng:** E2E `signflow` (lô); test lô 10 file.
- **Phụ thuộc:** R6.18, R5.62
- **File:** `apps/native/crates/chef-app/src/sign_batch.rs`
- **E2E:** `signflow`
- **Tính năng:** I31
- **Trạng thái:** ⬜

### R6.25 · Sau khi ký · S
- **Mô tả:** phiên chuyển sang trạng thái `signed`. Thao tác làm mất chữ ký bị chặn có cảnh báo. Ký thêm và ghi chú (nếu cấp độ cho phép) thì ghi kiểu incremental.
- **Tiêu chí:** (1) xóa trang bị chặn sau khi ký; (2) ký thêm không đổi chữ ký cũ; (3) cảnh báo bằng tiếng Việt.
- **Kiểm chứng:** E2E `signflow`; test.
- **Phụ thuộc:** R6.18, R3.05
- **File:** `apps/native/crates/chef-app/src/signed_state.rs`
- **E2E:** `signflow`
- **Tính năng:** I32
- **Trạng thái:** ⬜

### R6.26 · Ký kèm đóng dấu · M
- **Mô tả:** một lần bấm: ký số, dấu giáp lai (R5.31) và chữ ký nháy mọi trang (R5.33).
- **Tiêu chí:** (1) ba thao tác đều có; (2) thứ tự đúng: dấu trước, ký sau; (3) hủy giữa chừng không để file nửa vời.
- **Kiểm chứng:** E2E `signflow`.
- **Phụ thuộc:** R6.18, R5.31, R5.33
- **File:** `apps/native/crates/chef-app/src/sign_combo.rs`
- **E2E:** `signflow`
- **Tính năng:** I33
- **Trạng thái:** ⬜

### M6.4 Kiểm tra chữ ký

### R6.27 · Panel kiểm tra chữ ký · M
- **Mô tả:** ✅ hợp lệ, ⚠️ đã bị sửa, ❌ không tin cậy. Chuỗi chứng thư, OCSP và CRL, xem phiên bản tài liệu lúc ký. Dùng `verify.py`.
- **Tiêu chí:** (1) ba trạng thái đúng với mẫu; (2) chuỗi chứng thư hiện đủ; (3) xem phiên bản đúng.
- **Kiểm chứng:** E2E `signflow`; so với Adobe (R6.19).
- **Phụ thuộc:** R6.18
- **File:** `apps/native/crates/chef-app/src/verify_panel.rs`
- **E2E:** `signflow`
- **Tính năng:** I34
- **Trạng thái:** ⬜

### R6.28 · Kho tin cậy · S
- **Mô tả:** nạp sẵn hai hệ Root CA Việt Nam (NEAC và Ban Cơ yếu Chính phủ), thêm hoặc xóa chứng thư tin cậy. Dùng `trust.py`.
- **Tiêu chí:** (1) hai hệ nạp sẵn; (2) thêm và xóa đúng; (3) chứng thư không nằm trong kho báo không tin cậy.
- **Kiểm chứng:** E2E `signflow`; test.
- **Phụ thuộc:** R6.27
- **File:** `apps/native/crates/chef-app/src/trust_store.rs`
- **E2E:** `signflow`
- **Tính năng:** I35
- **Trạng thái:** ⬜

### R6.29 · Kiểm tra chữ ký hàng loạt · M
- **Mô tả:** kiểm tra cả thư mục, xuất bảng kết quả ra Excel và CSV, xuất kết quả kiểm tra ra PDF.
- **Tiêu chí:** (1) số file đúng với thư mục; (2) bảng có đủ cột; (3) PDF kết quả mở được.
- **Kiểm chứng:** E2E `signflow` (lô kiểm); test.
- **Phụ thuộc:** R6.27, R5.62
- **File:** `apps/native/crates/chef-app/src/verify_batch.rs`
- **E2E:** `signflow`
- **Tính năng:** I36
- **Trạng thái:** ⬜

### R6.30 · Điểm kiểm M6 · —
- **Mô tả:** E2E `certs`, `sigstudio`, `signflow`; MAN-2 đã làm (R6.18, R6.19); đo RAM lúc ký (lõi chạy, pyHanko đã import lười).
- **Tiêu chí:** (1) E2E đạt; (2) MAN-2 có kết quả; (3) RAM lúc ký ghi cạnh Electron.
- **Tính năng:** —
- **Trạng thái:** ⬜

---

## M7: Sửa chữ và đoạn

**Mục tiêu:** chế độ Chỉnh sửa với sửa chữ theo dòng, đoạn, và hàng định dạng. Đây là tính năng khó nhất về hành vi: bôi đen rồi Sửa (D70), viền đứt quanh đoạn (D69), phiên đoạn (D62), font gốc hoặc font thay thế (D66). IME tiếng Việt được kiểm lại ở đây.
**Demo:** bôi đen một câu, Sửa, đổi thành câu có ư và ớ; sửa đoạn ba dòng và đổi cỡ; tìm và thay một cụm; cảnh báo font hiện khi thiếu ký tự.
**Đầu vào:** M2 (viewer và chọn chữ), M4 (đối tượng), M3 (ops text.*), R1.26 (IME).

### M7.0 Chế độ và chọn

### R7.01 · Chế độ Xem, Chọn, Chỉnh sửa · M
- **Mô tả:** một chế độ Chỉnh sửa thay cho nhiều nút (D66). Thanh dưới cho biết chế độ hiện tại. Ở chế độ Xem, các thao tác sửa bị khóa.
- **Tiêu chí:** (1) đổi chế độ bằng một nút; (2) ở Xem, sửa bị khóa và có thông báo; (3) trạng thái hiển thị đúng ở thanh dưới.
- **Kiểm chứng:** E2E `text-merged` (phần chế độ); ui-audit.
- **Phụ thuộc:** R2.19, R2.22
- **File:** `apps/native/crates/chef-app/src/edit_mode.rs`
- **E2E:** `text-merged`
- **Tính năng:** B11
- **Trạng thái:** ⬜

### M7.1 Sửa dòng và đoạn

### R7.02 · Bôi đen rồi Sửa chọn đúng vùng · M
- **Mô tả:** chọn chữ bằng kéo chuột, bấm Sửa thì ô nhập ẩn nhận đúng vùng bôi đen, gõ thay thế vùng đó (D70). Không nối thêm chữ.
- **Tiêu chí:** (1) gõ thay thế đúng vùng (E2E `replaces it` làm mẫu lỗi cũ); (2) con trỏ không nằm cuối khi có vùng; (3) Esc hủy không đổi gì.
- **Kiểm chứng:** E2E `text-merged` (phần thay thế); test.
- **Phụ thuộc:** R7.01, R2.25b, R1.22
- **File:** `apps/native/crates/chef-app/src/text_replace.rs`
- **E2E:** `text-merged`, `textedit`
- **Tính năng:** D8
- **Trạng thái:** ⬜

### R7.03 · Sửa mức dòng · M
- **Mô tả:** con trỏ nhấp nháy `tedit-blink` của khung sửa (`textedit.css`). Bấm vào dòng chữ để sửa, dùng lại font gốc khi còn đủ ký tự. Đoạn đang mở có khung liền riêng; các đoạn khác có viền đứt xanh quanh vùng đoạn, không viền giữa các từ (D69).
- **Tiêu chí:** (1) viền đứt chỉ quanh đoạn, không quanh từng từ; (2) đoạn đang mở có khung liền; (3) sửa dòng lưu đúng vị trí.
- **Kiểm chứng:** E2E `textedit`, `text-merged` (viền đoạn); ui-audit.
- **Phụ thuộc:** R7.02
- **File:** `apps/native/crates/chef-app/src/text_line.rs`
- **E2E:** `textedit`, `text-merged`
- **Tính năng:** D8
- **Trạng thái:** ⬜

### R7.04 · Gom dòng thành đoạn và tự xuống dòng · M
- **Mô tả:** gom các dòng thành đoạn, sửa và tự xuống dòng lại theo lề. Dùng `text_paragraph.py` và `text_edit.py` của lõi. Justified cần ba dòng (ghi trong lõi).
- **Tiêu chí:** (1) đoạn ba dòng xuống dòng lại đúng; (2) căn đều cần đủ ba dòng; (3) sửa không làm đoạn khác dịch.
- **Kiểm chứng:** E2E `paragraph-session`; test lõi.
- **Phụ thuộc:** R7.03, R3.08
- **File:** `apps/native/crates/chef-app/src/text_paragraph.rs`
- **E2E:** `paragraph-session`
- **Tính năng:** D9
- **Trạng thái:** ⬜

### R7.05 · Hàng định dạng chữ · M
- **Mô tả:** hàng dưới thanh công cụ khi chỉnh chữ: Thêm văn bản, font, cỡ, tăng và giảm cỡ, đậm, nghiêng, căn lề, thụt lề, khoảng cách dòng, màu. Thay `TextFormatBar`. Ghi chú của khung đưa lên hàng định dạng (D66).
- **Tiêu chí:** (1) từng nút đổi đúng đoạn đang mở; (2) bố cục khớp `format-row` ở ba chiều rộng; (3) cảnh báo font nằm trong hàng định dạng.
- **Kiểm chứng:** E2E `format-row`; ui-audit.
- **Phụ thuộc:** R7.04
- **File:** `apps/native/crates/chef-app/src/format_bar.rs`
- **E2E:** `format-row`
- **Tính năng:** D14, D9
- **Trạng thái:** ⬜

### R7.06 · Font gốc hoặc font thay thế, cảnh báo ký tự · M
- **Mô tả:** dùng font gốc nếu còn đủ ký tự; thiếu (hay gặp với tiếng Việt) thì thay bằng font gần giống và báo một lần (`substitution_note` của lõi). Ký tự vô hình hiện U+XXXX. `fontTo` vẫn là id (CONTRACTS).
- **Tiêu chí:** (1) font gốc giữ khi đủ ký tự; (2) thiếu ký tự thì thay và báo đúng một lần; (3) chuỗi cảnh báo khớp `vi.json`.
- **Kiểm chứng:** E2E `demo-v07` (câu có ư, ớ mà font con không có); test chuỗi cảnh báo.
- **Phụ thuộc:** R7.04
- **File:** `apps/native/crates/chef-app/src/font_fallback.rs`
- **E2E:** `demo-v07`
- **Tính năng:** D8, D9
- **Trạng thái:** ⬜

### M7.2 Thêm chữ, tìm thay thế, thuộc tính

### R7.07 · Thêm văn bản · M
- **Mô tả:** hộp chữ mới, hỗ trợ đầy đủ tiếng Việt, nhúng font Unicode. Esc hủy không ghi gì. Khung nháp lấy tiêu điểm đúng lúc (lỗi đã biết ở D66).
- **Tiêu chí:** (1) chữ tiếng Việt đúng dấu khi lưu; (2) khung đặt đúng điểm đã bấm (sai số 4 px ngang, 12 px dọc, như E2E cũ); (3) Esc không ghi.
- **Kiểm chứng:** E2E `text-merged`; test.
- **Phụ thuộc:** R7.05, R1.26
- **File:** `apps/native/crates/chef-app/src/text_add.rs`
- **E2E:** `text-merged`
- **Tính năng:** D1
- **Trạng thái:** ⬜

### R7.08 · Gõ tiếng Việt trong khung nháp · XS
- **Mô tả:** MAN-1 trong khung nháp của Thêm văn bản và sửa đoạn: Telex và VNI, bộ gõ Windows và Unikey hoặc EVKey.
- **Tiêu chí:** (1) gõ đúng trong cả hai khung; (2) ghi kết quả vào BLUEPRINT_RUST §13.1.
- **Kiểm chứng:** MAN-1.
- **Phụ thuộc:** R7.07, R1.27
- **File:** `docs/BLUEPRINT_RUST.md`
- **Tính năng:** —
- **Ghi chú:** (2026-11-11) gộp vào R7.09: hai task là cùng một lần MAN-1 trong khung nháp. Giữ mã để không đổi số.
- **Trạng thái:** ❌

### R7.09 · Gõ tiếng Việt trong khung nháp (MAN-1, bản đoạn) · XS
- **Mô tả:** MAN-1 cho cả hai khung nháp, làm trong một lần: khung Thêm văn bản (R7.07) và khung sửa đoạn (R7.04). Gõ Telex và VNI, nhiều dòng, xuống dòng, dấu tiếng Việt, qua bộ gõ Windows và Unikey hoặc EVKey. Đây là điểm kiểm IME lần hai, trong môi trường phức tạp hơn R1.26. (2026-11-11: nhận phần của R7.08.)
- **Tiêu chí:** (1) gõ đúng dấu trong cả hai khung, kể cả nhiều dòng; (2) không mất ký tự khi xuống dòng; (3) ghi kết quả vào BLUEPRINT_RUST §13.1.
- **Kiểm chứng:** MAN-1 kèm ảnh chụp.
- **Phụ thuộc:** R7.04, R7.07, R1.27
- **File:** `docs/BLUEPRINT_RUST.md`
- **Tính năng:** —
- **Trạng thái:** ⬜

### R7.10 · Tìm và thay thế chữ · M
- **Mô tả:** tìm một cụm trên toàn tài liệu và thay thế, có tìm không dấu. Thay trên cả file bằng một operation (`text.replace`), có đếm số chỗ.
- **Tiêu chí:** (1) "nghi dinh" thay đúng "nghị định" trên sáu chỗ của demo; (2) văn bản mỗi trang khác đúng hai thay đổi (như `demo-v07`); (3) có undo.
- **Kiểm chứng:** E2E `demo-v07` (phần tìm thay); test.
- **Phụ thuộc:** R2.23, R3.08
- **File:** `apps/native/crates/chef-app/src/text_replace_all.rs`
- **E2E:** `demo-v07`
- **Tính năng:** D10
- **Trạng thái:** ⬜

### R7.11 · Bảng thuộc tính đối tượng · M
- **Mô tả:** panel phải hiện thuộc tính của đối tượng đang chọn: chữ (font, cỡ, màu), ảnh, ghi chú, chữ ký. Thay một phần của `objects.css`.
- **Tiêu chí:** (1) thuộc tính đúng với từng loại; (2) đổi giá trị đi qua operation; (3) bảng đổi khi chọn đối tượng khác.
- **Kiểm chứng:** E2E `objects`, `demo-v11`; ui-audit.
- **Phụ thuộc:** R4.11, R7.05
- **File:** `apps/native/crates/chef-app/src/props_panel.rs`
- **E2E:** `objects`, `demo-v11`
- **Tính năng:** D13
- **Trạng thái:** ⬜

### R7.12 · Phiên sửa đoạn: ghi đoạn và lưu đúng thứ tự · M
- **Mô tả:** khi đóng phiên sửa đoạn, ghi đoạn trước, rồi lưu. Lưu chạy đua với ghi đoạn là lỗi đã biết (NOTES 2026-11-05f), nên lưu phải chờ phiên đóng. Chữ vừa thêm vẫn nằm trong danh sách đối tượng sau khi sửa (điểm chưa xác minh trong NOTES).
- **Tiêu chí:** (1) lưu luôn có nội dung đoạn đã sửa; (2) không có lưu chạy đua trong 20 lần lặp; (3) chữ vừa thêm có trong danh sách đối tượng.
- **Kiểm chứng:** E2E `paragraph-session`; lặp 20 lần.
- **Phụ thuộc:** R7.04, R3.12
- **File:** `apps/native/crates/chef-app/src/paragraph_session.rs`
- **E2E:** `paragraph-session`
- **Tính năng:** D9
- **Trạng thái:** ⬜

### R7.13 · Điểm kiểm M7 · —
- **Mô tả:** E2E `text-merged`, `textedit`, `paragraph-session`, `format-row`, `demo-v07`, `demo-v11`; MAN-1 đã làm (R7.08, R7.09); đo RAM khi sửa đoạn trong file 300 trang.
- **Tiêu chí:** (1) E2E đạt; (2) MAN-1 có kết quả; (3) RAM ghi cạnh Electron.
- **Tính năng:** —
- **Trạng thái:** ⬜

---

## M8: Chụp và xử lý ảnh

**Mục tiêu:** toàn bộ chụp và làm đẹp bản scan: trình sửa ảnh trang (không phá hủy), cắt và nắn, làm trắng, tách trang đôi, xóa ngón tay, tự dò viền (kèm mô hình nhẹ L20), chụp bằng điện thoại qua LAN.
**Demo:** chụp 5 trang bằng điện thoại qua QR; tự cắt và nắn; tách sách đôi; xóa ngón tay; làm phẳng trang cong nhẹ; xuất bản scan 200 dpi xám ≤ 5 MB.
**Đầu vào:** M5b (chuyển bản scan), M6 (ảnh chữ ký), R1.40 (import lười cv2 và onnxruntime).
**Ghi chú:** L20 là ngoại lệ AI duy nhất ở 1.0 (CLAUDE.md). ONNX chạy trên CPU, nằm trong bản cài.

### M8.0 Trình sửa ảnh trang

### R8.01 · Trình sửa ảnh trang không phá hủy · M
- **Mô tả:** chế độ sửa ảnh riêng cho trang scan. Luôn giữ ảnh gốc, có lịch sử thao tác, hoàn nguyên được. Áp cho trang hiện tại, các trang chọn, hoặc mọi trang. Gom L1–L4, L10–L14 vào đây.
- **Tiêu chí:** (1) hoàn nguyên đưa về ảnh gốc từng byte (kiểm SHA-256 của ảnh gốc trong file); (2) lịch sử có thể lùi nhiều bước; (3) áp cho trang chọn không đổi trang khác.
- **Kiểm chứng:** E2E `adjust`; test SHA-256.
- **Phụ thuộc:** R4.02, R3.08
- **File:** `apps/native/crates/chef-app/src/page_image_editor.rs`
- **E2E:** `adjust`
- **Tính năng:** L9
- **Trạng thái:** ⬜

### R8.02 · Chỉnh nghiêng · M
- **Mô tả:** tự xoay thẳng trang theo dòng chữ, xoay tinh từng 0,1°. Xem trước và áp dụng dùng cùng góc, giữ kích thước ảnh, có thể cắt nội dung ở góc (T8.06 đã làm).
- **Tiêu chí:** (1) tự xoay về dưới 0,5° với mẫu nghiêng; (2) xoay tinh 0,1° đúng; (3) xem trước khớp kết quả.
- **Kiểm chứng:** E2E `adjust`, `demo-v08` (phần nghiêng).
- **Phụ thuộc:** R8.01
- **File:** `apps/native/crates/chef-app/src/deskew.rs`
- **E2E:** `adjust`, `demo-v08`
- **Tính năng:** L1
- **Trạng thái:** ⬜

### R8.03 · Nắn phối cảnh · M
- **Mô tả:** nắn trang chụp xiên thành hình chữ nhật từ bốn góc. Kết hợp với R8.02.
- **Tiêu chí:** (1) bốn góc đúng ra hình chữ nhật; (2) kết quả không cắt chữ; (3) xem trước đúng.
- **Kiểm chứng:** E2E `crop-review`, `demo-v08`.
- **Phụ thuộc:** R8.02
- **File:** `apps/native/crates/chef-app/src/perspective.rs`
- **E2E:** `crop-review`, `demo-v08`
- **Tính năng:** L2
- **Trạng thái:** ⬜

### R8.04 · Làm trắng nền · M
- **Mô tả:** nền ngả vàng hoặc xám thành trắng, chữ rõ hơn. Bỏ bóng đổ khi chụp (L3).
- **Tiêu chí:** (1) nền ngả vàng thành trắng ở mẫu; (2) chữ không mất; (3) ngưỡng chỉnh được.
- **Kiểm chứng:** E2E `demo-v08` (phần làm trắng); so ảnh.
- **Phụ thuộc:** R8.01
- **File:** `apps/native/crates/chef-app/src/whiten.rs`
- **E2E:** `demo-v08`
- **Tính năng:** L3
- **Trạng thái:** ⬜

### R8.05 · Khử nhiễu và chỉnh sáng · M
- **Mô tả:** chỉnh sáng và tương phản, khử nhiễu, xóa chấm bẩn.
- **Tiêu chí:** (1) chỉnh sáng đúng chiều; (2) khử nhiễu không làm mờ chữ ở 200 dpi; (3) có xem trước.
- **Kiểm chứng:** E2E `adjust`; so ảnh.
- **Phụ thuộc:** R8.01
- **File:** `apps/native/crates/chef-app/src/denoise.rs`
- **E2E:** `adjust`
- **Tính năng:** L4
- **Trạng thái:** ⬜

### R8.06 · Levels, Curves, đảo màu, đổi DPI · M
- **Mô tả:** Levels và Curves, đảo màu (âm bản), đổi độ phân giải (giảm hoặc tăng DPI).
- **Tiêu chí:** (1) Levels đổi đúng điểm đen và trắng; (2) đảo màu hai lần trả về ảnh cũ; (3) đổi DPI đúng kích thước pixel.
- **Kiểm chứng:** E2E `adjust`; test.
- **Phụ thuộc:** R8.01
- **File:** `apps/native/crates/chef-app/src/levels.rs`
- **E2E:** `adjust`
- **Tính năng:** L12
- **Trạng thái:** ⬜

### M8.1 Chụp bằng điện thoại

### R8.07 · Máy chủ LAN tạm và mã QR · M
- **Mô tả:** máy chủ HTTP tạm trong tiến trình, chỉ chạy khi đang chụp, cùng Wi-Fi, không qua internet. Mã QR chứa token dùng một lần. Tự tắt sau khi xong hoặc sau 10 phút (BLUEPRINT_RUST §5). Thay `capture.ts`.
- **Tiêu chí:** (1) máy chủ không mở khi không chụp (kiểm bảng cổng); (2) token dùng một lần, lần hai bị từ chối; (3) tự tắt sau 10 phút.
- **Kiểm chứng:** E2E `capture`; kiểm cổng; MAN-3.
- **Phụ thuộc:** R3.02
- **File:** `apps/native/crates/chef-capture/src/server.rs`, `apps/native/crates/chef-capture/src/qr.rs`
- **E2E:** `capture`
- **Tính năng:** L5
- **Trạng thái:** ⬜

### R8.08 · Nhận ảnh chụp và tự cắt nắn · M
- **Mô tả:** điện thoại gửi ảnh, máy tính nhận và tự cắt và nắn (L2, L15). Điện thoại thật qua MAN-3 (chụp qua QR). Dùng `captureModel.ts` và `demo-v08` làm chuẩn.
- **Tiêu chí:** (1) ảnh nhận về đúng số trang; (2) tự cắt và nắn ra khổ đúng; (3) MAN-3 đạt trên điện thoại thật.
- **Kiểm chứng:** E2E `capture`, `demo-v08` (phần máy chủ chụp); MAN-3.
- **Phụ thuộc:** R8.07, R8.16
- **File:** `apps/native/crates/chef-capture/src/receive.rs`
- **E2E:** `capture`, `demo-v08`
- **Tính năng:** L5
- **Trạng thái:** ⬜

### M8.2 Tách trang và sửa trang

### R8.09 · Tách trang đôi · M
- **Mô tả:** ảnh chụp hai trang sách mở thành hai trang riêng: tự dò khe gáy (vùng tối và cong ở giữa), cho chỉnh tay đường cắt, thứ tự trái rồi phải. Là bước của quy trình chụp sách. Dùng `spine.spec` làm chuẩn.
- **Tiêu chí:** (1) khe gáy dò đúng với bóng gáy sâu (test hồi quy `test_split_spread_with_a_deep_binding_shadow_is_still_found`); (2) chỉnh tay đường cắt có hiệu lực; (3) thứ tự trái phải đúng.
- **Kiểm chứng:** E2E `spine`; test lõi `pageimg`.
- **Phụ thuộc:** R8.01
- **File:** `apps/native/crates/chef-app/src/spine.rs`
- **E2E:** `spine`
- **Tính năng:** L6
- **Trạng thái:** ⬜

### R8.10 · Tẩy và tô · M
- **Mô tả:** cọ tẩy, chọn vùng chữ nhật hoặc vẽ tự do. Tô bằng màu nền giấy tự dò (có thêm hạt giấy để vùng tô không lộ) hoặc màu tự chọn.
- **Tiêu chí:** (1) vùng tô có hạt giấy, không lộ khối phẳng; (2) màu tự dò khớp nền ở mẫu; (3) có undo.
- **Kiểm chứng:** E2E `erase`; so ảnh.
- **Phụ thuộc:** R8.01
- **File:** `apps/native/crates/chef-app/src/erase_paint.rs`
- **E2E:** `erase`
- **Tính năng:** L10
- **Trạng thái:** ⬜

### R8.11 · Xóa vết màu · M
- **Mô tả:** xóa nét bút bi, bút dạ quang, con dấu theo màu. Chọn màu bằng ống hút. Dùng chung công cụ tách màu với R8.12.
- **Tiêu chí:** (1) bút dạ quang vàng biến mất khỏi chữ đen; (2) chọn màu bằng ống hút đúng; (3) chữ đen giữ nguyên.
- **Kiểm chứng:** E2E `erase`; so ảnh.
- **Phụ thuộc:** R8.01 (sửa 2026-11-11: trước ghi R8.12, tạo phụ thuộc vòng với R8.12; công cụ tách màu chung làm ở task này, R8.12 dùng lại)
- **File:** `apps/native/crates/chef-app/src/color_remove.rs`
- **E2E:** `erase`
- **Tính năng:** L11
- **Trạng thái:** ⬜

### R8.12 · Tách chữ ký và con dấu theo màu · M
- **Mô tả:** ảnh có chữ ký xanh đè lên con dấu đỏ thành hai ảnh riêng. Dùng công cụ tách màu chung với R8.11. Đây là mục I22 (thuộc M6 về nghiệp vụ, làm ở đây vì là công cụ ảnh).
- **Tiêu chí:** (1) hai ảnh tách ra đúng màu; (2) phần chồng nhau được xử lý rõ (ghi cách); (3) kết quả dùng được ở thư viện chữ ký R6.07.
- **Kiểm chứng:** E2E `sigstudio` (phần tách); test màu.
- **Phụ thuộc:** R8.11, R6.07
- **File:** `apps/native/crates/chef-app/src/color_split.rs`
- **E2E:** `sigstudio`
- **Tính năng:** I22
- **Trạng thái:** ⬜

### R8.13 · Làm phẳng trang cong: dò dòng chữ · M
- **Mô tả:** dò các dòng chữ trên trang cong để lập lưới biến dạng. Làm cơ bản (L13): trang cong nhẹ. Trang cong mạnh để Q12 (ngoài 1.0).
- **Tiêu chí:** (1) dòng chữ dò đúng trên mẫu cong nhẹ; (2) trang không có chữ báo không làm được; (3) lưới ghi được.
- **Kiểm chứng:** E2E `dewarp` (phần dò).
- **Phụ thuộc:** R8.01
- **File:** `apps/native/crates/chef-app/src/dewarp_detect.rs`
- **E2E:** `dewarp`
- **Tính năng:** L13
- **Trạng thái:** ⬜

### R8.14 · Làm phẳng trang cong: kéo và áp dụng · M
- **Mô tả:** kéo lưới cho thẳng, xem trước, áp dụng. Thay `dewarp.css`.
- **Tiêu chí:** (1) sau áp dụng dòng chữ thẳng (sai số dưới 4 px khi đo); (2) xem trước khớp kết quả; (3) có undo.
- **Kiểm chứng:** E2E `dewarp`; đo sai số.
- **Phụ thuộc:** R8.13
- **File:** `apps/native/crates/chef-app/src/dewarp_apply.rs`
- **E2E:** `dewarp`
- **Tính năng:** L13
- **Trạng thái:** ⬜

### R8.15 · Xóa ngón tay bán tự động · M
- **Mô tả:** dò vùng da chạm mép trang (ngón tay giữ giấy khi chụp), đề xuất vùng xóa. Người dùng chỉnh bằng cọ, rồi tô bằng màu nền giấy. Không khôi phục được chữ nằm dưới ngón tay (ghi cảnh báo).
- **Tiêu chí:** (1) đề xuất đúng ở mẫu có ngón tay (phủ khoảng 0,87% trang như `demo-v08`); (2) chỉnh bằng cọ có hiệu lực; (3) cảnh báo chữ dưới ngón tay.
- **Kiểm chứng:** E2E `finger`, `demo-v08`.
- **Phụ thuộc:** R8.10
- **File:** `apps/native/crates/chef-app/src/finger.rs`
- **E2E:** `finger`, `demo-v08`
- **Tính năng:** L14
- **Trạng thái:** ⬜

### M8.3 Tự dò viền và cắt

### R8.16 · Dò viền trang: thuật toán · M
- **Mô tả:** tìm bốn góc tờ giấy: dò cạnh, tìm đường thẳng, chấm điểm các tứ giác theo độ tương phản trong và ngoài. Hai trường hợp: bản scan (cắt viền nắp máy) và ảnh điện thoại (nắn phối cảnh). Mỗi trang có điểm tin cậy. Dùng `pageimg` của lõi.
- **Tiêu chí:** (1) bốn góc sai dưới `PHOTO_TOL` trên mẫu; (2) mẫu bàn trắng báo điểm thấp; (3) mép bị ngón tay che vẫn có điểm, không tin hoàn toàn.
- **Kiểm chứng:** E2E `crop-review`; test lõi.
- **Phụ thuộc:** R8.03, R1.40
- **File:** `apps/native/crates/chef-app/src/autocrop.rs`
- **E2E:** `crop-review`
- **Tính năng:** L15
- **Trạng thái:** ⬜

### R8.17 · Dò viền: giao diện và điểm tin cậy · M
- **Mô tả:** tự dò mọi trang, hiện lưới thumbnail có khung đè lên, trang dò kém được đánh dấu để chỉ sửa tay vài trang. Hoặc một khung cắt cho mọi trang, riêng trang chẵn và lẻ (khi chụp sách).
- **Tiêu chí:** (1) trang dò kém được đánh dấu; (2) một khung cho trang chẵn và lẻ riêng hoạt động; (3) khung kéo được.
- **Kiểm chứng:** E2E `crop-review`; ui-audit.
- **Phụ thuộc:** R8.16
- **File:** `apps/native/crates/chef-app/src/autocrop_view.rs`
- **E2E:** `crop-review`
- **Tính năng:** L15
- **Trạng thái:** ⬜

### R8.18 · Cắt thủ công: khung chữ nhật và kéo bốn góc · M
- **Mô tả:** khung chữ nhật với tám nắm, kính lúp khi kéo góc, tỉ lệ có sẵn (A4, A5, Letter, CCCD, tự do, giữ tỉ lệ khổ giấy), nhập số đo bằng mm. Khung tự hít vào viền đã dò trong 8 px (T8.06). Kéo bốn góc độc lập và xem trước.
- **Tiêu chí:** (1) tám nắm kéo đúng; (2) hít viền trong 8 px; (3) kính lúp hiện khi kéo góc.
- **Kiểm chứng:** E2E `crop-review`; ui-audit.
- **Phụ thuộc:** R8.17
- **File:** `apps/native/crates/chef-app/src/crop_manual.rs`
- **E2E:** `crop-review`
- **Tính năng:** L16, L17
- **Trạng thái:** ⬜

### R8.19 · Cắt hàng loạt và duyệt nhanh · M
- **Mô tả:** áp một khung cho nhiều trang, duyệt nhanh bằng lưới, kính lúp cho trang đã chọn. Dùng trong quy trình.
- **Tiêu chí:** (1) áp khung cho nhiều trang đúng; (2) duyệt nhanh đi qua trang bằng phím; (3) trang đã cắt được đánh dấu.
- **Kiểm chứng:** E2E `crop-review`, `workflow-batch-crop-step`.
- **Phụ thuộc:** R8.18, R5.62
- **File:** `apps/native/crates/chef-app/src/crop_batch.rs`
- **E2E:** `crop-review`, `workflow-batch-crop-step`
- **Tính năng:** L18
- **Trạng thái:** ⬜

### R8.20 · Tự nhận khổ giấy · S
- **Mô tả:** đoán khổ theo tỉ lệ cạnh (A4, A5, Letter, CCCD…) và đặt đúng kích thước trang PDF, hoặc giữ kích thước thật.
- **Tiêu chí:** (1) đoán đúng ba khổ mẫu; (2) có tùy chọn giữ kích thước thật; (3) đặt kích thước trang đúng.
- **Kiểm chứng:** test.
- **Phụ thuộc:** R8.19
- **File:** `apps/native/crates/chef-app/src/paper_size.rs`
- **Tính năng:** L19
- **Trạng thái:** ⬜

### R8.21 · Mô hình dò viền L20: giấy phép và đóng gói · M
- **Mô tả:** kiểm giấy phép của DocAligner và trọng số mô hình (BLUEPRINT §L20: cả code lẫn trọng số). Nếu không ổn, tìm mô hình khác hoặc tự huấn luyện. Đóng gói ONNX Runtime CPU vào bản cài (vài chục MB).
- **Tiêu chí:** (1) giấy phép code và trọng số ghi trong NOTES; (2) mô hình chạy trên CPU với mẫu; (3) kích thước tăng ghi lại.
- **Kiểm chứng:** test; đo kích thước.
- **Phụ thuộc:** R8.16
- **File:** `core/chef_core/imaging/docaligner.py`, `docs/NOTES.md`
- **Tính năng:** —
- **Trạng thái:** ⬜

### R8.22 · Chạy hai cách và chọn kết quả tin cậy hơn · M
- **Mô tả:** chạy thuật toán L15 và mô hình L20 song song, chọn kết quả có điểm tin cậy cao hơn. Xử lý giấy trắng trên bàn trắng, nền lộn xộn, góc bị ngón tay che, ánh sáng xấu. Mã Q13 để sau (không thuộc 1.0).
- **Tiêu chí:** (1) chọn đúng kết quả trên bốn mẫu khó; (2) mô hình không chạy khi không cần (tiết kiệm RAM, ghi số); (3) RAM tăng không quá giới hạn ghi trong R8.21.
- **Kiểm chứng:** E2E `crop-review`; test bốn mẫu khó.
- **Phụ thuộc:** R8.21, R8.17
- **File:** `apps/native/crates/chef-app/src/autocrop_pick.rs`
- **E2E:** `crop-review`
- **Tính năng:** L20
- **Trạng thái:** ⬜

### R8.23 · Điểm kiểm M8 · —
- **Mô tả:** E2E `capture`, `dewarp`, `crop-review`, `erase`, `finger`, `spine`, `adjust`, `demo-v08`, `scan` (phần xử lý ảnh); MAN-3 đã làm; đo RAM khi chụp 20 trang và tự dò viền.
- **Tiêu chí:** (1) E2E đạt hoặc khác biệt ghi rõ; (2) MAN-3 có kết quả; (3) RAM ghi cạnh Electron, kể cả khi mô hình L20 chạy.
- **Tính năng:** —
- **Trạng thái:** ⬜

---

## M9: Hoàn thiện và thay thế Electron

**Mục tiêu:** phần còn lại của vỏ (cài đặt đầy đủ, mở bằng app PDF, in, bộ cài, cập nhật thủ công, tab Giới thiệu), di chuyển dữ liệu, nghiệm thu dùng hằng ngày, rồi quyết định gỡ Electron.
**Demo:** cài bằng bộ cài Windows; đặt Chef PDF làm app PDF mặc định; in ra máy in ảo; chủ dự án dùng bản Rust một tuần (MAN-6).
**Đầu vào:** M1–M8 đã đạt, và báo cáo RAM của từng mốc.
**Điều kiện gỡ Electron:** chỉ khi R9.12 đạt và chủ dự án chốt bằng quyết định mới trong NOTES. Trước đó `apps/desktop` và `apps/ui` vẫn có.

### R9.01 · Cài đặt đầy đủ và preset mặc định · M
- **Mô tả:** phần còn lại của Cài đặt: preset mặc định cho nén, scan, đóng dấu; các mục mới như ngân sách cache (R1.33) và thời gian tự tắt lõi (R3.03), có giá trị mặc định.
- **Tiêu chí:** (1) mọi mục cài đặt của bản Electron có trong bản Rust; (2) mục mới không làm hỏng file settings cũ; (3) preset áp dụng đúng; (4) đổi trần cache trong cài đặt có hiệu lực không cần khởi động lại (chuyển từ R1.33 ngày 2026-11-11).
- **Kiểm chứng:** test đọc file settings của Electron; ui-audit.
- **Phụ thuộc:** R2.14
- **File:** `apps/native/crates/chef-app/src/settings.rs`
- **Tính năng:** A4
- **Trạng thái:** ⬜

### R9.02 · Mở bằng app PDF và đặt làm mặc định · M
- **Mô tả:** đăng ký ProgID và "Open with" trong `HKCU\Software\Classes` (không cần quyền quản trị). Đặt làm app PDF mặc định qua cơ chế của Windows (hộp thoại chọn ứng dụng).
- **Tiêu chí:** (1) chuột phải file PDF có "Mở bằng Chef PDF"; (2) đặt mặc định không cần quyền quản trị; (3) gỡ đăng ký khi gỡ cài đặt.
- **Kiểm chứng:** test registry; thao tác thủ công trên máy chủ dự án.
- **Phụ thuộc:** R9.04
- **File:** `apps/native/crates/chef-app/src/file_assoc.rs`
- **Tính năng:** A5
- **Trạng thái:** ⬜

### R9.03 · In ra máy in · M
- **Mô tả:** hộp thoại in của Windows, chọn trang, in từ app bất kỳ ra PDF (qua máy in PDF của Windows). Giữ phạm vi như A7.
- **Tiêu chí:** (1) hộp thoại in mở đúng; (2) in khoảng trang đúng số trang; (3) in ra PDF bằng máy in ảo mở được.
- **Kiểm chứng:** test thủ công với máy in ảo; đếm trang của file in.
- **Phụ thuộc:** R2.30
- **File:** `apps/native/crates/chef-app/src/print.rs`
- **Tính năng:** A7
- **Trạng thái:** ⬜

### R9.04 · Bộ cài Windows · M
- **Mô tả:** bộ cài Windows cho bản Rust (1.0 chỉ Windows, D37). Cài đặt vào thư mục người dùng hoặc hệ thống, có gỡ cài đặt, tạo lối tắt, đăng ký file (R9.02).
- **Tiêu chí:** (1) cài và gỡ sạch; (2) lối tắt và gỡ đăng ký đúng; (3) bộ cài có `pdfium.dll` và thư mục `core/`.
- **Kiểm chứng:** cài và gỡ trên máy chủ dự án; kiểm bảng tiến trình sau gỡ.
- **Phụ thuộc:** R9.05, R3.02
- **File:** `apps/native/packaging/installer.nsi`
- **Tính năng:** A8 (Windows)
- **Trạng thái:** ⬜

### R9.05 · Chọn công cụ đóng gói · S
- **Mô tả:** chọn giữa NSIS trực tiếp và cargo-packager (BLUEPRINT_RUST §11). Ghi quyết định và lý do.
- **Tiêu chí:** (1) công cụ đã chọn chạy được trên Windows; (2) giấy phép đạt cargo-deny; (3) quyết định ghi vào NOTES.
- **Kiểm chứng:** build thử.
- **Phụ thuộc:** R1.03
- **File:** `docs/BLUEPRINT_RUST.md`, `docs/NOTES.md`
- **Tính năng:** —
- **Trạng thái:** ⬜

### R9.06 · Tab Giới thiệu · S
- **Mô tả:** nút tab sau các tài liệu, màn hình thay Start hoặc tài liệu. Hiện phiên bản app và lõi (`system.ping`), môi trường (Rust, pdfium, GPUI theo commit ghim), ghi chú dùng cá nhân, NOTICE, hai nút mở thư mục nhật ký và dữ liệu (D68).
- **Tiêu chí:** (1) phiên bản app và lõi đúng; (2) hai nút mở đúng thư mục; (3) mở tài liệu thì tab Giới thiệu đóng (D68).
- **Kiểm chứng:** E2E `about-menu`; ui-audit màn hình `about`.
- **Phụ thuộc:** R2.15, R9.10
- **File:** `apps/native/crates/chef-app/src/about.rs`
- **E2E:** `about-menu`
- **Tính năng:** —
- **Trạng thái:** ⬜

### R9.07 · Không có thanh menu, giữ phím tắt · XS
- **Mô tả:** không có thanh menu trên Windows (D67). Các phím của mục menu cũ vẫn có: Ctrl+O, Ctrl+=, Ctrl+−, Ctrl+0, F11 (đã làm ở R2.31); Ctrl+Shift+I và Ctrl+R chỉ khi phát triển.
- **Tiêu chí:** (1) không hiện thanh menu; (2) các phím đúng; (3) không có phím phát triển trong bản phát hành.
- **Kiểm chứng:** E2E `keyboard`; kiểm bản phát hành.
- **Phụ thuộc:** R2.31
- **File:** `apps/native/crates/chef-app/src/keys.rs`
- **E2E:** `keyboard`
- **Tính năng:** —
- **Trạng thái:** ⬜

### R9.08 · Kiểm tra bản mới thủ công · M
- **Mô tả:** thay electron-updater. Không tự cập nhật (CH2 đã trả lời: chưa cần, D36). App kiểm tra phiên bản mới khi người dùng bấm, và mở link tải. Đường đọc release của repo private xử lý sau (TASKS CH2).
- **Tiêu chí:** (1) bấm kiểm tra báo "đã mới nhất" hoặc "có bản mới" đúng; (2) không có token GitHub trong app; (3) lỗi mạng báo rõ.
- **Kiểm chứng:** test với phiên bản giả; thử khi mất mạng.
- **Phụ thuộc:** R9.06
- **File:** `apps/native/crates/chef-app/src/update_check.rs`
- **Tính năng:** —
- **Trạng thái:** ⬜

### R9.09 · Di chuyển dữ liệu từ Electron · M
- **Mô tả:** dùng chung thư mục userData (D73). Đọc `settings.json`, giữ `sessions/` (rev file là PDF thường, mở được), `library/`. Không đọc `secrets.json` (ciphertext của safeStorage): báo người dùng nhập lại mật khẩu PFX và khóa thư viện chữ ký.
- **Tiêu chí:** (1) cài đặt cũ có hiệu lực ngay; (2) phiên dở của Electron mở được và khôi phục (R3.13); (3) `secrets.json` không bị đọc, có thông báo rõ.
- **Kiểm chứng:** test với thư mục userData mẫu từ bản Electron.
- **Phụ thuộc:** R2.14, R3.13, R6.02
- **File:** `apps/native/crates/chef-app/src/migrate.rs`
- **Tính năng:** A4
- **Trạng thái:** ⬜

### R9.10 · Nhật ký có trần và thư mục dữ liệu · S
- **Mô tả:** ghi nhật ký ra `logs/`, bộ đệm trong RAM có trần (R11), xoay vòng file. Mở thư mục nhật ký và thư mục dữ liệu từ tab Giới thiệu.
- **Tiêu chí:** (1) bộ đệm không vượt trần; (2) file nhật ký xoay vòng; (3) không có mật khẩu trong nhật ký (grep).
- **Kiểm chứng:** test; grep.
- **Phụ thuộc:** R1.02
- **File:** `apps/native/crates/chef-app/src/logging.rs`
- **Tính năng:** —
- **Ghi chú:** (2026-11-09w) chef-app/src/logging.rs: ghi <userData>/logs/chef-native.log, xoay vòng khi quá 512 KB (giữ 3 file cũ), bộ đệm RAM trần 64 KB. Test đơn vị: trần RAM, xoay vòng đúng số file, ghi và xoay khi đầy. E2E e2e-native-password quét nhật ký thật của các lượt chạy: không có mật khẩu. Lệch: mục mở thư mục nhật ký từ tab Giới thiệu chờ R9.06 (chưa có tab Giới thiệu).
- **Trạng thái:** ✅

### R9.11 · Rà parity theo 165 mã tính năng · M
- **Mô tả:** chạy script đối chiếu mã trong FEATURES với tasks (mục "Kiểm tra độ phủ" trong file này). Liệt kê mã chưa đạt, mã còn "một phần", và mã chuyển sang sau 1.0 nếu có quyết định.
- **Tiêu chí:** (1) mọi mã trong phạm vi có ít nhất một task đạt; (2) mã "một phần" có ghi rõ phần còn thiếu; (3) danh sách ghi vào NOTES; (4) CH-R2 (độ tương phản của token) đã có quyết định, giữ hoặc đổi, ghi trong NOTES.
- **Kiểm chứng:** script đối chiếu; báo cáo.
- **Phụ thuộc:** R9.01 đến R9.10
- **Tính năng:** —
- **Trạng thái:** ⬜

### R9.12 · Nghiệm thu dùng hằng ngày (MAN-6) · —
- **Mô tả:** chủ dự án chạy bản Rust thay Electron ít nhất một tuần cho công việc thật. Ghi các lỗi và thiếu sót vào TASKS_RUST.
- **Tiêu chí:** (1) một tuần dùng liên tục; (2) danh sách lỗi có mức độ; (3) không còn lỗi mức chặn.
- **Kiểm chứng:** nhật ký dùng và danh sách lỗi.
- **Phụ thuộc:** R9.11
- **Tính năng:** —
- **Trạng thái:** ⬜

### R9.13 · Đo kích thước và RAM cuối · S
- **Mô tả:** đo kích thước bộ cài, kích thước lõi giải nén (so với 303 MB của Electron), và RAM các kịch bản chuẩn so với Electron cùng kịch bản.
- **Tiêu chí:** (1) bảng kích thước; (2) bảng RAM ba mốc với `nativeMB` và `coreMB`; (3) số ghi vào BLUEPRINT_RUST §11 và NOTES.
- **Kiểm chứng:** báo cáo.
- **Phụ thuộc:** R9.04, R1.37
- **Tính năng:** —
- **Trạng thái:** ⬜

### R9.14 · Quyết định gỡ Electron · S
- **Mô tả:** khi R9.12 đạt, viết quyết định mới (D tiếp theo) cho phép gỡ `apps/desktop` và `apps/ui`. Chưa xóa mã trong task này; xóa là R9.16.
- **Tiêu chí:** (1) quyết định trong NOTES có điều kiện đã đạt; (2) chủ dự án ký nhận (câu trả lời rõ trong chat).
- **Kiểm chứng:** NOTES.
- **Phụ thuộc:** R9.12
- **Tính năng:** —
- **Trạng thái:** ⬜

### R9.15 · Cập nhật BLUEPRINT và CLAUDE.md sau parity · S
- **Mô tả:** thay BLUEPRINT.md bằng nội dung của BLUEPRINT_RUST (giữ mục theo số); CONTRACTS (vai trò main chuyển sang Rust); dòng "Stack" và "Vỏ app" của CLAUDE.md; xóa con trỏ "đang chuyển".
- **Tiêu chí:** (1) không còn tài liệu nói Electron là bản chính; (2) CONTRACTS khớp mã; (3) TASKS.md cũ được đánh dấu lịch sử.
- **Kiểm chứng:** tìm chuỗi "Electron" trong tài liệu chính, còn lại chỉ ở mục lịch sử.
- **Phụ thuộc:** R9.14
- **Tính năng:** —
- **Trạng thái:** ⬜

### R9.16 · Gỡ mã Electron · M
- **Mô tả:** xóa `apps/desktop`, `apps/ui` và các mục liên quan (electron-builder, Playwright cho Electron, pdf.js patch trong `patches/`), sau khi R9.14 và R9.15 xong. Giữ lịch sử trong git.
- **Tiêu chí:** (1) `pnpm` không còn package Electron; (2) pytest lõi xanh; (3) CI không còn job Electron.
- **Kiểm chứng:** CI xanh; pytest.
- **Phụ thuộc:** R9.15
- **Tính năng:** —
- **Trạng thái:** ⬜

### R9.17 · Điểm kiểm M9 và kết thúc · —
- **Mô tả:** báo cáo cuối: RAM ba mốc, số mã tính năng đạt, các mục sau 1.0, bài học về ước lượng (điểm cho M1–M9).
- **Tiêu chí:** (1) báo cáo ghi trong NOTES; (2) TASKS_RUST cập nhật đủ trạng thái; (3) chủ dự án duyệt.
- **Tính năng:** —
- **Trạng thái:** ⬜


---

## Kiểm tra độ phủ

Đối chiếu bằng cách đọc chính file này và `docs/FEATURES.md` (không lưu script trong repo). Lặp lại được khi thêm task.

**Kết quả hiện tại:**
- **Mã tính năng trong phạm vi:** 165/165 có ít nhất một task. Phạm vi = các mã có mốc v0.1–v0.10, v1.0, v1.1 trong FEATURES.md (161 + 4). Không có mã ngoài phạm vi được gán nhầm. Nhóm P (so sánh tài liệu) và các mã "Sau 1.0", "Nâng cấp", "Ý tưởng" không thuộc phạm vi này.
- **Spec E2E:** 63/63 có ít nhất một task. Hai spec `perf-heap` và `perf-layers` được đánh dấu "không áp dụng" ở R1.36 (đo Chromium).
- **Cờ kiểm chứng trong BLUEPRINT_RUST:** 32 cờ (`Kiểm ở M…`, `Quyết định ở M…`) đều có task, bảng dưới.
- **Task:** 269 (kể cả 14 điểm kiểm; thêm R1.43 và R2.33 ngày 2026-11-11). Không có ID trùng. Không còn phụ thuộc vòng (R8.11 ↔ R8.12 đã gỡ).

**Feature → task** (mỗi mã trong phạm vi, theo mục FEATURES.md):

- **A. Khung ứng dụng:** A1 → R1.06, R2.16, R2.17; A2 → R2.15; A3 → R2.18, R2.31; A4 → R1.12, R2.13, R2.14, R9.01, R9.09; A5 → R2.17, R2.30, R9.02; A6 → R3.11; A7 → R9.03; A8 → R9.04; A9 → R3.13
- **B. Xem & điều hướng:** B1 → R1.30, R2.21; B2 → R1.32, R2.19, R2.20; B3 → R2.22; B4 → R2.23, R2.24; B5 → R2.24, R2.25a, R2.25b, R5.14; B6 → R2.26; B7 → R2.27; B8 → R4.08; B9 → R2.28; B11 → R7.01; B12 → R2.29
- **C. Sắp xếp trang:** C1 → R4.01; C2 → R4.03, R4.07; C3 → R4.04; C4 → R5.03; C5 → R5.04; C6 → R4.04; C7 → R5.05; C8 → R5.06; C9 → R5.07; C10 → R5.08; C13 → R4.02, R4.05; C14 → R4.02, R4.06
- **D. Chỉnh sửa chữ & đối tượng:** D1 → R7.07; D2 → R4.09; D3 → R4.10; D4 → R4.11, R4.12; D5 → R4.13; D6 → R4.14; D7 → R4.14; D8 → R7.02, R7.03, R7.06; D9 → R7.04, R7.05, R7.06, R7.12; D10 → R7.10; D11 → R4.15; D12 → R5.59; D13 → R7.11; D14 → R7.05
- **E. Lớp & gỡ watermark:** E1 → R4.16; E2 → R4.16; E3 → R5.40; E4 → R5.41; E5 → R5.42
- **F. Watermark, con dấu & đánh số:** F1 → R5.29; F2 → R5.30; F3 → R5.30; F4 → R5.31; F5 → R5.32; F6 → R5.33; F7 → R5.34; F8 → R5.35; F9 → R5.36; F10 → R5.37; F11 → R5.38; F12 → R5.39
- **G. Ghi chú:** G1 → R4.17; G2 → R4.18; G3 → R4.19; G4 → R4.20; G5 → R4.20
- **H. Form:** H1 → R4.21, R4.22; H2 → R4.23; H3 → R4.24
- **I-A. Chứng thư & USB token:** I1 → R6.01; I2 → R6.02; I3 → R6.03; I4 → R6.04; I5 → R6.05; I6 → R6.06; I7 → R6.06; I8 → R6.05
- **I-B. Studio mẫu chữ ký:** I10 → R6.11, R6.12; I11 → R6.13; I12 → R6.13; I13 → R6.14; I14 → R6.14; I15 → R6.15; I16 → R6.16; I17 → R6.16; I18 → R6.16
- **I-C. Ảnh chữ ký & con dấu:** I19 → R6.07; I20 → R6.08; I21 → R6.09; I22 → R8.12; I23 → R6.10
- **I-D. Đặt chữ ký & ký:** I25 → R6.17, R6.18; I26 → R6.20; I27 → R6.17; I28 → R6.21; I29 → R6.22; I30 → R6.23; I31 → R6.24; I32 → R6.25; I33 → R6.26
- **I-E. Kiểm tra chữ ký:** I34 → R6.27; I35 → R6.28; I36 → R6.29
- **J. Bảo mật:** J1 → R5.44; J2 → R5.45; J3 → R5.46; J4 → R5.47; J5 → R5.48; J6 → R5.49
- **K. Chuyển thành bản scan:** K1 → R5.23; K2 → R5.23; K3 → R5.23; K4 → R5.24; K5 → R5.25; K6 → R5.25; K7 → R5.26; K8 → R5.26; K9 → R5.27; K10 → R5.27
- **L. Làm đẹp bản scan & chụp tài liệu:** L1 → R8.02; L2 → R8.03; L3 → R8.04; L4 → R8.05; L5 → R8.07, R8.08; L6 → R8.09; L9 → R8.01; L10 → R8.10; L11 → R8.11; L12 → R8.06; L13 → R8.13, R8.14; L14 → R8.15; L15 → R8.16, R8.17; L16 → R8.18; L17 → R8.18; L18 → R8.19; L19 → R8.20; L20 → R8.22
- **M. Tối ưu, chuyển đổi & sửa lỗi:** M1 → R5.11; M2 → R5.12; M3 → R5.13; M4 → R5.14; M5 → R5.15, R5.16; M6 → R5.17; M7 → R5.18; M8 → R5.19; M9 → R5.20; M10 → R5.21; M11 → R5.22
- **N. Rã tài liệu & tái tạo định dạng:** N1 → R5.51; N2 → R5.52; N3 → R5.53, R5.54; N4 → R5.55; N5 → R5.56; N6 → R5.57; N7 → R5.58
- **O. Quy trình & xử lý hàng loạt:** O1 → R5.61; O2 → R5.62; O3 → R5.63; O4 → R5.64; O5 → R5.65; O6 → R5.66; O7 → R5.67; O8 → R5.68

**Cờ kiểm chứng của BLUEPRINT_RUST → task:**

| Mục | Cờ | Task |
|---|---|---|
| §2.1 | Luồng render duy nhất (pdfium không an toàn luồng) | R1.29 |
| §2.1 | `CREATE_NO_WINDOW` cho lõi | R3.02 |
| §2.1 | Bitmap BGRA, không sao chép thừa | R1.30 |
| §2.2 R9 | Texture atlas GPUI giữ thêm bản sao? | R1.35 |
| §4 | Chuyển file gốc sang rev mất trạng thái hiển thị | R3.06 |
| §6.1 | Theme hệ thống (registry) | R1.12 |
| §6.1 | `BoxShadow` (spread, blur), vòng focus hai lớp | R1.16 |
| §6.2 | flex, grid `auto-fit`, ellipsis, `aspect-ratio` | R1.17 |
| §6.2 | `@media` (thu về một cột; đã biết) | R1.17 (ba chiều rộng) |
| §6.2 | 7 `@keyframes` | R2.10, R2.12, R3.09, R4.01, R7.03 |
| §6.2 | `transition` và đường cong `--ease` | R2.03 |
| §6.2 | `filter: invert` (đọc trang tối) | R2.28, CH-R3 |
| §6.2 | `filter: grayscale` (Start) | R2.16, CH-R3 |
| §6.2 | `repeating-linear-gradient` (overlay) | R4.11 |
| §6.2 | `:hover`, `:active`, `:focus-visible`, con trỏ | R1.19, R2.03 |
| §6.2 | `tnum`, `letter-spacing` | R1.18 |
| §6.2 | Thanh cuộn tùy biến | R1.20 |
| §6.2 | Khung cửa sổ gốc (không có `--titlebar-h`) | R1.06 |
| §6.3 | Nét icon Lucide ở 16–18 px | R1.15 |
| §6.4 | TTF với DirectWrite; woff chưa rõ | R1.13 |
| §6.6 | Hành vi Radix | R2.03–R2.12 |
| §6.7 | Giảm chuyển động của Windows | R2.10 |
| §6.8 | Chụp tham chiếu ở DPR 1 và 1,75; ui-audit | R1.21, R2.01, R2.02 |
| §7.2 | pdfium không chạy JavaScript | R1.28 |
| §9 | Giấy phép `gpui` | R1.01 |
| §9 | Giấy phép `pdfium-render`, `typify`, `gpui-component` | R1.04 |
| §10.3 | Cửa sổ ngoài màn hình vẽ và chụp được | R1.08, R1.09 |
| §11 | Công cụ đóng gói (NSIS hoặc cargo-packager) | R9.05 |
| §13.1 | IME Telex, TSF | R1.23, R1.26, R1.27 (MAN-1); dự phòng R1.24, R1.25 |
| §14 | Ước lượng sau M1 | Điểm kiểm M1 |
| §15 | Thời gian học Rust/GPUI | Điểm kiểm M1 |

**Việc thủ công (MAN) → task:** MAN-1 → R1.26, R1.27, R7.09 (R7.08 đã gộp vào R7.09); MAN-2 → R6.18, R6.19; MAN-3 → R8.07, R8.08; MAN-4 → R1.10; MAN-5 → R2.02 và mỗi điểm kiểm; MAN-6 → R9.12.

**Quyết định (CH) → task:** CH-R1 → R5.16; CH-R2 → R9.11; CH-R3 → R2.16, R2.28.


## Thay đổi sau khi chốt

Ghi thay đổi task, phụ thuộc hoặc phạm vi (ngày, ID, thay đổi, lý do).

| Ngày | ID | Thay đổi | Lý do |
|---|---|---|---|
| 2026-11-08 | — | Tạo file, phiên bản 0.1 | Phân rã BLUEPRINT_RUST và PLAN_RUST |
| 2026-11-11 | — | Phiên bản 0.2: thêm mục "Thứ tự làm tiếp" (MAN-1 ngay, lát cắt dọc M3 trước phần còn lại của M2, gom đuôi M1) | D86. Rủi ro còn lại lớn nhất là IME và R3.06; khoảng 170 task của M4–M8 phụ thuộc chuỗi R3.02 → R3.08 |
| 2026-11-11 | R3.03 | Bỏ phụ thuộc R2.32 | Điểm kiểm không phải phụ thuộc kỹ thuật |
| 2026-11-11 | R3.08 | Bỏ phụ thuộc R3.07, thêm R1.42; lát cắt chỉ cần `Params` của `page.rotate` | Codegen đầy đủ chỉ chặn R5.02 |
| 2026-11-11 | R1.43 (mới) | Gom phần "so với Electron" của R1.13, R1.15, R1.16, R1.17, R1.19 và năm dòng "Kiểm ở M1" còn lại của BLUEPRINT_RUST §6.2 | R1.21 đã xong; năm đuôi cùng một cách kiểm |
| 2026-11-11 | R2.33 (mới) | Script chạy gộp E2E native | 16 script lẻ, native CI được theo dõi riêng ở R1.05 |
| 2026-11-11 | R1.33, R1.34 | Chuyển ✅; tiêu chí 3 của R1.33 sang R9.01 (tiêu chí 4); tiêu chí 2 của R1.34 đã có ở R2.22 | Phần còn lại thuộc mốc sau, giữ 🔄 ở M1 không có ích |
| 2026-11-11 | R1.35 | Đo bằng bộ đếm GPU của Windows, không viết mã DXGI | `nativeMB` đã thấp; chỉ cần số xác nhận |
| 2026-11-11 | R2.02 | Thêm tiêu chí 4: ảnh tham chiếu ra khỏi `%TEMP%` | Windows có thể tự dọn `%TEMP%` |
| 2026-11-11 | R5.02 | Thêm tiêu chí 4 (bảng phân loại hộp thoại) và 5 (rà lại kích thước R5.03–R5.68) | Renderer từ schema là đòn bẩy của M5 (69 task), nhưng phải giữ hình họa |
| 2026-11-11 | R5.35, R5.36 | Phụ thuộc đổi sang R5.30 | Chuỗi R5.34 → R5.35 → R5.36 là phụ thuộc giả. R5.37 giữ phụ thuộc R5.36 (tiêu chí 3 dùng Bates) |
| 2026-11-11 | R7.08, R7.09 | R7.08 ❌, gộp vào R7.09 | Hai task là cùng một lần MAN-1 |
| 2026-11-11 | R8.11 | Phụ thuộc đổi từ R8.12 sang R8.01 | Gỡ phụ thuộc vòng R8.11 ↔ R8.12 |
| 2026-11-14 | CH-R4 / D90 | Chốt bỏ qua đúng 10 advisory `unmaintained` theo ID, mỗi mục có lý do trong deny.toml | Chủ dự án chọn; ID được xác minh lại bằng cargo-deny 0.20.2 trên đồ thị hiện tại |
| 2026-11-14 | R3.06 | Chuyển ⬜ → 🔄 | Có nền helper và UI reload revision; tiêu chí E2E Windows chưa xác nhận |
| 2026-11-14 | R2.33 | Chuyển ⬜ → 🔄 | Runner và self-test có; chưa chạy bộ E2E giao diện Windows |
| 2026-11-14 | R1.43 | Ghi nhận phụ thuộc còn thiếu | Manifest có băm nhưng ảnh Electron không nằm trong repo/thư mục `CHEF_VISUAL_REFS`; chưa có driver chụp probe native cho R2.02. Giữ mở, không đánh dấu so ảnh khi thiếu cặp ảnh và report |
| 2026-11-14 | R1.37 | Cập nhật runner đo RAM | Ba mốc, 350 bước cuộn có nhịp, tách core/native, xác minh off-screen và cleanup đã có; chỉ biên dịch tĩnh trên Mac, chưa có số đo Windows |
| 2026-11-14 | R1.38 | Căn kịch bản Electron với R1.37 | `perf-memory.spec.ts` dùng 350 bước × 150 ms, ba mốc mở/cuộn/về đầu; chưa chạy và chưa có số đo Windows |
| 2026-11-14 | R1.35 | Thêm GPU counters vào PERFMEM | Đọc Dedicated/Shared Usage theo PID, tách native/core; không có counter thì `unavailable`. Chưa đo Windows, giữ 🔄 |
| 2026-11-14 | R1.12, R1.32 | Ghi trạng thái đuôi M1 | R1.12 có observer và debug themeDark nhưng thiếu đổi theme thật trên Windows; R1.32 vẫn thiếu frame-time đo khi cuộn bánh xe |
| 2026-11-14 | R2.15 | Chuyển ⬜ → 🔄; cập nhật tiến độ | Model 3 test; host GPUI, Viewer/session/cache, debug state và script E2E có; Windows runtime, tổ hợp phím/chuột thật, đo R1.33 còn thiếu |
| 2026-11-14 | R2.22 | Chuyển ⬜ → 🔄 | Sidebar ảo hóa/cap 60, bookmark và E2E fixture có; click chuột thật là opt-in, chưa chạy Windows runtime |
| 2026-11-14 | R2.17 | Chuyển ⬜ → 🔄 | argv/drop/IPC/second-instance có và E2E hai tiến trình có; chưa chạy Windows, chưa thử Explorer drop |
| 2026-11-14 | R2.15 | Tăng phạm vi E2E tab | Script mặc định dùng debug actions, `CHEF_E2E_OS_INPUT=1` bật phím/chuột thật; tab có bounds; runtime Windows còn thiếu |
| 2026-11-14 | R2.16 | Tăng phạm vi E2E Start | Mặc định mở recent qua debug mouse, có opt-in chuột thật; parser đạt, Windows UI/audit ba chiều rộng còn thiếu |
| 2026-11-14 | R2.18 | Tăng phạm vi E2E palette | Mặc định dùng debug actions, có opt-in Ctrl+K/nhập/Enter/Escape thật; parser đạt, Windows UI còn thiếu |
| 2026-11-14 | R2.20 | Tăng phạm vi E2E trình chiếu | Mặc định dùng debug actions, có opt-in phím mũi tên/F11 thật; parser đạt, Windows UI/screenshot còn thiếu |
| 2026-11-14 | R2.21 | Tăng phạm vi E2E zoom | Mặc định dùng debug actions, có opt-in Ctrl+=/Ctrl+−/Ctrl+0 thật; parser đạt, Windows UI/Electron perf compare còn thiếu |
| 2026-11-14 | R2.31 | Ngăn PageUp/PageDown đổi trang khi TextInput focus | Hai phím map về Home/End trong TextInput; thêm E2E `e2e-native-keyboard.ps1`, 54 test chef-ui và parser đạt; Windows runtime/toàn ma trận còn thiếu |
| 2026-11-14 | R2.33 | Giữ suite gộp không chiếm input | Runner xóa `CHEF_E2E_OS_INPUT` cho tiến trình con; các script input vật lý có opt-in riêng, keyboard E2E được skip trong suite mặc định |
| 2026-11-14 | R2.26 | Cô lập log và dữ liệu kiểm tra mật khẩu | Mỗi lượt dùng userData/stderr riêng, chờ pipe thay vì sleep cố định, quét đúng file của lượt chạy; parser đạt, Windows runtime còn thiếu |
| 2026-11-14 | R2.28 | Đo cache trang theo byte | Thêm `cachedBytes` vào state và so cùng tập trang ngày/đêm trong E2E; parser đạt, Windows runtime/Electron ảnh còn thiếu |
| 2026-11-14 | R2.30 | Củng cố hộp thoại mở/lưu | Save As đặt `.pdf` mặc định; thêm unit checks cờ/kết quả hủy và E2E tự đóng Open/Save As để kiểm cancel; Windows runtime/filter/initial dir còn thiếu |
| 2026-11-14 | R2.30 | Kiểm tra cấu hình request hộp thoại qua E2E state | Thêm telemetry chỉ bật trong E2E và assertion Start cho `defaultSaveDir`, filter, buffer, multi-select, `.pdf`, mask flags; cần chạy trên Windows để xác nhận runtime |
| 2026-11-14 | R3.03 | Mở rộng kiểm idle-stop/restart qua app trong M3 integration E2E | Timeout nhanh chỉ trong E2E; kiểm đóng session → lõi dừng → single-instance mở lại → sửa khởi động lõi mới và giữ nội dung lưu; Windows runtime chưa chạy |
| 2026-11-14 | R3.08 | Thêm regression test viewer và assertion kind cho `INVALID_PARAMS` | `chef-rpc` host tests đạt 14/14; Windows GNU `cargo check --tests`/Clippy đạt và viewer test cross-biên dịch được; chưa chạy test viewer trên host do thiếu Metal hoặc E2E Windows |
| 2026-11-14 | R3.08 | Chuyển ✅ → 🔄 sau khi rà tiêu chí xong | App-level integration E2E chưa chạy và regression test viewer mới chỉ cross-compile; test lõi thật vẫn có bằng chứng cũ |
| 2026-11-14 | R3.05, R3.11, R3.12 | Chạy lại test phiên lõi theo `uv.lock` | Môi trường tạm Python 3.14 ngoài repo; `core/tests/test_session.py` đạt 21/21, gồm mã hóa, undo/redo, giới hạn revision, Save As và lỗi lưu nguyên tử; app/E2E Windows còn thiếu |
| 2026-11-14 | R3.02–R3.12 | Cross-check mã Rust và test trên Windows GNU | `cargo check --target x86_64-pc-windows-gnu -p chef-app --tests` và `cargo clippy --target x86_64-pc-windows-gnu -p chef-app --all-targets -- -D warnings` đạt; đây là kiểm tra biên dịch, chưa chạy app/E2E |
| 2026-11-14 | R1.43, R2.02 | Chạy comparator visual và resolver self-test | `chef-testkit` đạt 8/8 test, CLI đạt 4/4; `e2e-native-visual-selftest.ps1 -SelfTestOnly` đạt, gồm manifest hai theme cùng tên; ảnh tham chiếu Electron/capture Windows vẫn thiếu |
| 2026-11-14 | R1.43 | Xác nhận loại tham chiếu cần cho so probe | R1.21 chỉ chứa màn hình Start/view/dialog, không có trang probe tương ứng; cần capture Electron cùng probe trước khi lập manifest cặp, ngoài việc cần khôi phục corpus refs |
| 2026-11-14 | R1.43 | Sửa mô tả phép đo cursor theo mã hiện có | Không tìm thấy `GetCursorInfo` trong debug; probe hiện luôn off-screen, nên cần thêm chế độ hiển thị và driver đọc cursor thật trước khi xác nhận `cursor: pointer` |
| 2026-11-14 | R1.43 | Thêm nền telemetry và driver kiểm tra cursor | `CHEF_E2E_PROBE_VISIBLE=1` chỉ trong probe; `state.cursor` đọc type/position bằng GetCursorInfo, `-MeasurePointer` kiểm tra nút thật và phục hồi vị trí chuột. Windows GNU check/Clippy và PowerShell parser đạt; chưa chạy UI/runtime Windows |
| 2026-11-14 | R1.43 | Tách capture visual-only và thêm trang tham chiếu Electron | Native probe giữ nhóm nút/font/icon/bóng/layout; thêm spec chụp cùng probe ở 800/1184/1484 px, light/dark, DPR 1/1,75. E2E/UI/desktop typecheck, Rust Windows cross-check đạt; chưa chụp vì UI dist chưa có và build tạm dừng |
| 2026-11-14 | CH-R3 / R2.16 | Chốt lọc icon disabled theo CSS; chuyển R2.16 ⬜ → 🔄 | Start, RecentFiles và E2E script đã có; còn Windows runtime, ui-audit ba chiều rộng và kiểm trực quan sáng/tối |
| 2026-11-14 | R2.02 | Bổ sung ngưỡng ô lệch tuyệt đối, self-test và xác minh manifest | Đã thêm selftest và script hash/size/path; chưa có refs external hoặc cặp Rust/Electron, chưa chạy MAN-5 |
| 2026-11-14 | R2.02 | Thêm CLI nhận manifest cặp ảnh, ghi JSON/HTML/diff và trả mã lỗi khi lệch | Unit test và smoke test CLI đạt; còn thiếu corpus và driver capture R1.43 |
| 2026-11-14 | R1.43 | Chuyển ⬜ → 🔄, thêm driver capture ứng viên native | Parser PowerShell đạt; còn thiếu chạy Windows, Electron reference mapping/corpus, so sánh và kiểm con trỏ |
| 2026-11-14 | R1.43 | Thêm capture index Electron và ghép manifest cho comparator | Pair builder kiểm hash, ghép theme/kích thước/DPR, kiểm pixel dimensions; Node tests 2/2 đạt. Chưa có ảnh capture thật, build tạm gác và MAN-5 chưa duyệt |
| 2026-11-14 | R2.33 | Chạy lại runner self-test | `pwsh scripts/e2e-native-all.ps1 -SelfTest` đạt: 5 script fixture, 10 kiểm tra, xác nhận tiếp tục sau lỗi và mã thoát tổng; bộ UI Windows vẫn chưa chạy |
| 2026-11-14 | R1.37 | Đồng bộ file triển khai trong task với runner hiện có | R1.37 dùng `scripts/measure-native-memory.ps1`, không có module `chef-testkit/src/memory.rs`; PowerShell parser của memory/capture/runner đạt. Số liệu tiến trình vẫn cần Windows và fixture 1000 trang |
| 2026-11-14 | R1.37/R1.38 | Tạo fixture benchmark lặp lại được | `scripts/gen-perf-memory-fixture.py` sinh `pages1000.pdf` và `tab1..5.pdf` ngoài repo; PyMuPDF xác nhận đúng 1000 trang, PDF 689 KiB. Chưa chạy đo GUI trên Windows |
| 2026-11-14 | R3.04 | Chạy độc lập unit tests của source guard trên Mac | Biên dịch riêng module thuần bằng `rustc --test`; 8/8 test đạt. E2E cảnh báo/reopen tích hợp vẫn cần Windows |
| 2026-11-14 | R3.06 | Chạy unit tests viewer trên SDK macOS 15.4 | `cargo test -p chef-viewer --offline` đạt 22/22, gồm neo/trang/zoom khi reload spread. E2E revision thật trong app vẫn cần Windows; app test target không biên dịch được vì thiếu `xcrun metal` |

### Điểm kiểm M1 (cuối mốc)

- [ ] Bảng RAM: `nativeMB` và `coreMB` cạnh số Electron (R1.38), có ghi tổng và chênh lệch
- [ ] R1.43 xong: năm probe hình họa đã so với Electron; năm dòng "Kiểm ở M1" của BLUEPRINT_RUST §6.2 có kết quả
- [x] CH-R4 đã chốt (`cargo deny` advisories) theo D90; full `cargo deny check` chạy lại ngày 2026-11-14 và xanh (advisories, bans, licenses, sources)
- [ ] Danh sách "đã kiểm / chưa kiểm": IME (R1.26), cửa sổ ngoài màn hình (R1.08/R1.09), texture (R1.35), DPR (R1.21), font, icon, bóng, layout
- [ ] Đọc lại M2–M9, sửa task theo kết quả đo, ghi thay đổi vào NOTES
- [ ] Ước lượng điểm cho M2–M9 (BLUEPRINT_RUST §14), dựa trên số giờ thực tế của M1 và số task đã xong; ghi tốc độ học Rust/GPUI (BLUEPRINT_RUST §15)
- [ ] MAN-1 đã làm (R1.27)
- [ ] Điểm kiểm không phải cổng dừng: nếu một việc không đạt, ghi lại và đưa vào mốc sau, không dừng cả dự án
