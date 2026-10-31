# Chef PDF

App PDF desktop đa nền tảng (Windows/macOS/Linux), mạnh nhưng gọn gàng kiểu ABBYY FineReader. Repo tên `powerpdf`, nhưng tên app là **Chef PDF**.

## Đọc trước khi làm
- `docs/NOTES.md`: các quyết định đã chốt, kiến trúc, trạng thái hiện tại, câu hỏi còn mở. **Đọc đầu tiên.**
- `docs/FEATURES.md`: cây tính năng có mã (A1, I4, K21…) và phiên bản dự kiến.
- `docs/TOKENS.md`: tra cứu USB token / CA Việt Nam cho phần ký số.

## Quy ước làm việc
- Trao đổi với chủ dự án bằng **tiếng Việt**.
- Có quyết định mới thì cập nhật `docs/NOTES.md` (bảng quyết định + nhật ký). Phạm vi tính năng thay đổi thì cập nhật `docs/FEATURES.md`.
- Không dùng thư viện AGPL (PyMuPDF/MuPDF, Ghostscript, iText).
- Không làm tính năng AI.
- Stack đã chốt: Electron + React + TypeScript + pdf.js (giao diện); Python sidecar với pyHanko, pypdfium2, pikepdf, Pillow, img2pdf (lõi xử lý).
