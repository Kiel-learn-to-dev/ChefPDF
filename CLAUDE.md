# Chef PDF

App PDF desktop đa nền tảng (Windows/macOS/Linux), mạnh nhưng gọn gàng kiểu ABBYY FineReader. Repo tên `powerpdf`, nhưng tên app là **Chef PDF**.

## Đọc trước khi làm
- `docs/NOTES.md`: các quyết định đã chốt, kiến trúc, trạng thái hiện tại, câu hỏi còn mở. **Đọc đầu tiên.**
- `docs/FEATURES.md`: **cây tính năng 1.0 đã chốt** (196 tính năng, mã A1…Q12). Mã trong file này là mã chính thức.
- `docs/BLUEPRINT.md`: kiến trúc, quy ước code, kiểm thử, build, các mốc, rủi ro. **Đọc trước khi viết code.**
- `docs/TASKS.md`: danh sách task theo mốc, có điểm, phụ thuộc, trạng thái. **Cập nhật trạng thái khi xong task.**
- `docs/TOKENS.md`: tra cứu USB token / CA Việt Nam cho phần ký số.

## Quy ước làm việc
- Trao đổi với chủ dự án bằng **tiếng Việt**.
- Có quyết định mới thì cập nhật `docs/NOTES.md` (bảng quyết định + nhật ký). Phạm vi tính năng thay đổi thì cập nhật `docs/FEATURES.md`.
- Không dùng thư viện AGPL (PyMuPDF/MuPDF, Ghostscript, iText).
- Bản 1.0 không có OCR, không có AI (ngoại lệ duy nhất: mô hình dò viền trang L20). OCR/AI thuộc gói nâng cấp sau (nhóm Q).
- Thay đổi phạm vi sau khi chốt phải ghi vào mục "Thay đổi sau khi chốt" trong FEATURES.md.
- App chỉ để chủ dự án tự dùng: không ký mã, không phát hành.
- **Bản 1.0 ưu tiên Windows** (D37): macOS và Linux để sau; đừng sửa lỗi riêng của chúng trước 1.0. Máy chính: Windows, token Viettel-CA. Kế hoạch: `docs/PLAN_V1.md`.
- Mọi tính năng tác động lên tài liệu phải là một Operation trong lõi Python (BLUEPRINT mục 3). Không sửa PDF ở renderer.
- Stack đã chốt: Electron + React + TypeScript + pdf.js (giao diện); Python sidecar với pyHanko, pypdfium2, pikepdf, Pillow, img2pdf (lõi xử lý).
