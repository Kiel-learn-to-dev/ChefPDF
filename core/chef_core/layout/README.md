# Mô hình tài liệu (layout)

Mô hình tài liệu là định dạng trung gian của bộ rã tài liệu (D21, nhóm N). `layout.analyze` ghi
mô hình ra file JSON; các bộ xuất (N4, N5, N6) đọc file này. Schema máy đọc được: `schema.json`
(sinh từ `model.py`, kiểm tra bằng `python -m chef_core.layout.schema --check`).

Quy ước chung: JSON camelCase; toạ độ theo **điểm hiển thị** (gốc trên-trái, y hướng xuống), cùng
hệ với mô hình chữ; chữ đã chuẩn hoá NFC. Mô hình chỉ phản ánh dữ liệu chữ (text layer) và đường
vẽ của PDF. Trang quét không có lớp chữ được báo cáo, không OCR.

## Cấu trúc

```
DocModel
├── version      số nguyên, hiện là 1
├── source       {name, pageCount}
├── pages[]      {index (0-based), width, height, rotation, blocks[]}
├── styles{}     tên → {font, size, bold, italic, color}; "body", "heading1".."heading6"
└── meta         {title, author, lang}   lang: "vi" nếu có dấu tiếng Việt, "und" nếu không rõ
```

Mọi khối có các trường chung:

| Trường | Ý nghĩa |
|---|---|
| `kind` | loại khối (bảng dưới). Là trường phân biệt (discriminator) |
| `bbox` | `[x0, y0, x1, y1]`, điểm hiển thị, gốc trên-trái |
| `readingOrder` | vị trí trong trang (0, 1, …), đã gồm tiêu đề đầu trang và cuối trang |
| `sourceRefs` | id của mô hình chữ: `L<trang>:<digest>:<n>` (dòng), `p<trang>:<digest>:<n>` (đối tượng) |
| `confidence` | 0–1. Quy tắc mạnh ≈ 0,9–0,95; đoán ≈ 0,5–0,7 |

Đổi `kind` của một khối (ví dụ tiêu đề thành đoạn) là tạo lại khối với các trường còn lại.

## Các loại khối

| `kind` | Trường riêng | Ghi chú |
|---|---|---|
| `heading` | `level` (1–6), `runs` | Cỡ chữ phân cụm trên toàn tài liệu: cỡ lớn nhất là cấp 1. Chữ đậm ngắn không cỡ lớn là cấp sau cùng. Có số thứ tự ("1.", "1.1", "Điều 3.", "Chương II") thì cũng là tiêu đề nếu đậm. |
| `paragraph` | `runs`, `joinedPages[]` | Đoạn văn. `joinedPages` = các trang (0-based) mà phần tiếp theo của đoạn nằm ở đó. Khối bắt đầu ở trang trước, bbox là phần đầu. |
| `list` | `ordered` (bool), `items[]` | `items[]` = `{runs, marker, children[]}`. `marker` là ký hiệu in ra ("1.", "a.", "•"). Mục con lùi vào so với mục cha là `children`. |
| `table` | `hasHeaderRow`, `columns`, `rows[][]` | `rows[r]` là danh sách ô bắt đầu ở hàng r. Ô `{rowSpan, colSpan, blocks[]}`; chỉ ô neo (góc trên-trái) được liệt kê. |
| `image` | `imageRef`, `caption` | `imageRef` là id đối tượng ảnh (`p…`). `caption` là đoạn "Hình…/Figure…" ngay sát ảnh. |
| `figure` | `renderedRef`, `caption` | Cụm nét vẽ vector (không phải bảng). `renderedRef` luôn `null` ở bước này. |
| `header` | `runs` | Đầu trang lặp lại (cùng chữ trên ≥ 60% số trang). Mặc định bỏ khi xuất. |
| `footer` | `runs` | Cuối trang lặp lại. Mặc định bỏ khi xuất. |
| `pageNumber` | `runs` | Số trang ("Trang 3", "3 / 10", "- 3 -"). Mặc định bỏ khi xuất. |
| `footnote` | `runs` | Chữ nhỏ ở chân trang, bắt đầu bằng số hoặc ký hiệu. |
| `separator` | — | Đường kẻ ngang mỏng (chiều cao ≤ 2,5 điểm). |
| `unknown` | `runs`, `reason` | Khối chưa phân loại được. Dành cho màn hình kiểm tra (N3). |

`code` (khối mã) chưa có: không có quy tắc nhận dạng ở bản này.

Trong `runs[]` mỗi đoạn:

| Trường | Ý nghĩa |
|---|---|
| `text` | chữ (NFC). Dấu cách ở đầu và cuối khối đã bỏ |
| `bold`, `italic` | theo font |
| `underline` | luôn `false` (gạch chân chưa nhận dạng) |
| `size` | cỡ chữ (điểm) |
| `font` | tên font (bỏ tiền tố subset) |
| `color` | `#rrggbb` |
| `link` | `https://…` (liên kết ngoài), `page:<n>` (trang của tài liệu, 0-based), hoặc tên đích khác |
| `sup`, `sub` | chỉ số trên / dưới (cỡ nhỏ hơn và lệch đường cơ sở) |

## Thứ tự đọc

1. Khối lặp đầu trang đứng trước; khối lặp cuối trang và số trang đứng sau.
2. Các khối rộng (≥ 60% bề rộng chữ) chia trang thành các dải theo chiều dọc.
3. Trong một dải, khối hẹp được sắp theo cột (cột là khoảng trống dọc giữa các khối hẹp), rồi từ
   trên xuống dưới.
4. Đoạn bị ngắt qua trang hoặc qua cột (không có dấu kết thúc câu, cùng cỡ và đậm, cùng lề trái)
   được nối thành một khối.

## Phạm vi và giới hạn

- Chỉ tài liệu có lớp chữ. Chữ xoay đứng bị bỏ qua và báo `ROTATED_TEXT_SKIPPED`.
- Trang không có chữ nhưng có ảnh: `PAGE_HAS_NO_TEXT_LAYER` (scan, cần OCR ở gói Q).
- Bảng: có đường kẻ (N2). Bảng không kẻ chỉ có khi bật `borderlessTables`, là suy đoán, `confidence`
  thấp (0,55).
- Chưa có: khối mã, gạch chân, đọc chữ viết phải-sang-trái, bảng lồng nhau, chữ dọc.
- Bộ kiểm thử chỉ dùng PDF tạo bằng reportlab. Tài liệu thật chưa được thử.
