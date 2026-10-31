# Spike S2 (T1.09): Khả năng sửa nội dung PDF với thư viện giấy phép thoáng

> Ngày 2026-10-31. Ký hiệu: ✅ **đã kiểm chứng** (có script + số liệu trong `spikes/s2/out/`) · 🔶 **chưa kiểm chứng**, chỉ là nhận định.
> Chạy lại: `cd spikes && uv sync && bash s2/run_all.sh` (`SKIP_AGPL=1` để bỏ phần so sánh PyMuPDF). PyMuPDF chỉ cài vào môi trường riêng của spike (nhóm phụ thuộc `agpl`), **không** vào lõi.

## 1. Khuyến nghị

**Giữ stack giấy phép thoáng (D7 giữ nguyên): pypdfium2 + pikepdf + fontTools đủ cho v0.6/v0.7. Không cần PyMuPDF, không cần lai.**

Lý do (chi tiết ở các mục sau):
1. ✅ Mọi việc của v0.6/v0.7 đều làm được bằng PDFium + pikepdf trên bộ mẫu: chọn/di chuyển/co giãn/xóa đối tượng, gỡ watermark và logo lặp, **che thông tin mật thật sự** (chữ không trích xuất được, điểm ảnh bị xóa), sửa câu tiếng Việt khi font nhúng thiếu chữ, gom dòng/đoạn văn bản 2 cột.
2. ✅ PDFium có **nhiều cái bẫy**, nhưng mỗi cái đều có cách xử lý đã chạy được: một bước tiền xử lý bằng pikepdf, một bước ghi lại bằng qpdf, và nhận diện font theo nội dung font. Tổng cộng khoảng 250 dòng cho lõi che thông tin.
3. ✅ PyMuPDF **không** giải quyết hết. Nó gọn hơn nhiều (che thông tin chỉ khoảng 10 dòng), nhưng trên chính bộ mẫu này nó **rò rỉ nội dung đã che** qua `/ActualText`: cả poppler, PDFium lẫn PyMuPDF đều trích ra lại cụm "Tràng Tiền". Nó cũng không có hàm "sửa chữ tại chỗ". Dù dùng thư viện nào, Chef PDF vẫn phải có bộ tiền xử lý và bộ kiểm chứng riêng.
4. Tiết kiệm nếu dùng PyMuPDF ước khoảng 2–3 điểm (chủ yếu ở T6.03/T6.07). Không đáng để đổi lấy AGPL, nhất là khi vẫn phải viết lớp kiểm chứng.

Điều kiện kèm theo: **không** tin vào kết quả chỉnh sửa khi chưa kiểm chứng. Mọi operation che/tẩy phải chạy bộ kiểm tra độc lập (mục 4.3) trong test.

## 2. Bộ mẫu (`s2/make_corpus.py`)

3 trang A4, sinh bằng reportlab, có `corpus_truth.json` làm đáp án:
- Chữ tiếng Việt font **DejaVu Sans nhúng một phần** (reportlab: font TrueType *đơn giản*, mã hóa riêng).
- Một dòng địa chỉ dùng **font CID `Type0/Identity-H` nhúng một phần**, nằm trong **Form XObject** và được bọc trong `/Span <</ActualText …>>`. Dòng này đóng dấu bằng pyHanko, mô phỏng kiểu nhúng font của Word/LibreOffice và các công cụ đóng dấu.
- Logo là **cùng một Image XObject** dùng lại trên mọi trang; một ảnh chân dung ở trang 1.
- Watermark "BẢN NHÁP" xoay 45°, trong suốt (`ca 0.25`), vẽ đè lên nội dung, **không gắn nhãn**. Watermark "MẬT" **có gắn nhãn chuẩn** `/Artifact <</Type /Pagination /Subtype /Watermark>>` (kiểu D14).
- Hình vector (khung, đường kẻ, hình tròn) và thân văn bản 2 cột căn đều hai bên.

🔶 Giới hạn: bộ mẫu do chính spike sinh ra, sạch hơn PDF thật (Word, máy scan, văn bản hành chính). Chưa thử font Type3, chữ dọc, inline image (`BI…ID…EI`), shading, PDF có cấu trúc thẻ (MCID), file đã ký.

## 3. Kết quả từng thí nghiệm

### 3.1 Liệt kê, chọn, di chuyển, xóa đối tượng (`e1_objects.py`) ✅

| Hạng mục | Kết quả |
|---|---|
| Liệt kê trang 1 | 89 đối tượng (83 chữ, 3 path, 2 ảnh, 1 form) trong 5 ms; có loại, bao, ma trận, góc xoay, độ trong suốt, font, cỡ chữ, marked content |
| Đối tượng lồng trong Form XObject | Thấy được (level 1), nhưng **tọa độ là của form**, phải nhân ma trận form mới ra tọa độ trang |
| Chọn đối tượng tại một điểm | Phải tự viết: duyệt theo thứ tự vẽ, lấy cái trên cùng; dùng tứ giác xoay (`get_quad_points`) cho chữ xoay; **path chỉ có nét viền thì chỉ chọn khi bấm gần nét** (nếu không thì khung trang "nuốt" mọi cú bấm, đã gặp thật). Kết quả: chọn đúng dòng chữ, watermark xoay, chữ trong form, logo; vùng trống trả về rỗng |
| Di chuyển logo, phóng 1,8× hình tròn, xóa dòng CCCD, `FPDFPage_GenerateContent` | 5 ms; ảnh trước/sau: `e1_before.png`, `e1_after.png` |
| Những gì giữ nguyên | Chữ còn lại y nguyên; marked content `/Artifact /Watermark` giữ nguyên; độ trong suốt giữ nguyên; trang 2–3 **không bị đụng** (hash content stream giữ nguyên); stream cũ của trang 1 **không còn** trong file |

### 3.2 Dò và gỡ watermark/logo lặp (`e2_watermark.py`) ✅

- **Có gắn nhãn** (`/Artifact /Subtype /Watermark`): dò bằng pikepdf. PDFium chỉ cho biết tên mark (`Artifact`) và tên khóa (`Subtype`), **không đọc được giá trị kiểu name** (`/Watermark`): cả hàm String lẫn Blob đều trả về false (đã thử). Gỡ bằng pikepdf (cắt khối `BDC…EMC`) đã chạy: 3/3 trang, chữ "MẬT" hết.
- **Không gắn nhãn**: đánh dấu mỗi đối tượng (ảnh theo hash dữ liệu, chữ theo nội dung + font + cỡ + ma trận, path theo số đoạn + bao), đếm số trang xuất hiện, rồi chấm điểm. Kết quả xếp hạng: "BẢN NHÁP" (6 điểm: lặp 3/3, xoay 45°, trong suốt, chiếm 23% trang) và "MẬT" (6 điểm) đứng đầu. Logo, tiêu đề, dòng "Đơn vị…", khung trang chỉ được 1–2 điểm (chỉ "lặp lại"). Đúng như NOTES đã dự kiến: **header/logo cũng lặp lại**, nên phải để người dùng tích chọn, không tự xóa.
- Gỡ bằng PDFium (người dùng chọn "BẢN NHÁP" + logo): xóa 6 đối tượng trên 3 trang, chữ watermark còn 0, thân văn bản giữ nguyên. PDFium **tự dọn** tham chiếu `/XObject` không dùng sau `GenerateContent` (7 → 4 mục trên 3 trang). Sau khi ghi lại bằng qpdf, stream ảnh logo **biến khỏi file** (số ảnh 2 → 1).

### 3.3 Tẩy vùng / che thông tin mật thật sự (`e3_redact.py`) ✅ (sau khi xử lý các bẫy)

Ba vùng trên trang 1: số CCCD (cắt ngang một đối tượng chữ), "Tràng Tiền" (trong Form XObject, font CID, có ActualText), góc dưới phải của ảnh chân dung.

Thuật toán: ánh xạ từng ký tự của textpage về đối tượng chữ chứa nó (`FPDFText_GetTextObject`). Với đối tượng có ký tự nằm trong vùng: xóa đi, rồi **tạo lại các ký tự giữ lại** thành đối tượng mới, mỗi từ một đối tượng, đặt đúng gốc tọa độ cũ, cùng font/cỡ/màu. Ảnh: giải mã, tô đen vùng, `FPDFImageObj_SetBitmap`. Path nằm trọn trong vùng: xóa. Cuối cùng vẽ ô đen (J6; D5 thì không vẽ), `GenerateContent`, rồi ghi lại bằng qpdf.

| Kiểm tra (trang 1) | PDFium "ngây thơ" | **PDFium + tiền xử lý pikepdf (khuyến nghị)** | PyMuPDF `apply_redactions` |
|---|---|---|---|
| CCCD không còn trích xuất được (PDFium / poppler) | ✅ / ✅ | ✅ / ✅ | ✅ / ✅ |
| "Tràng Tiền" không còn trích xuất được (PDFium / poppler) | ❌ / ✅ | ✅ / ✅ | ❌ / ❌ (**rò qua ActualText**) |
| Stream gốc của trang/form còn trong file | ❌ còn form | ✅ không còn | ✅ không còn |
| Điểm ảnh trong vùng bị xóa (giá trị trung bình) | ✅ 0 (đen) | ✅ 0 (đen) | ✅ 255 (trắng) |
| Chữ giữ lại lệch vị trí tối đa | 0,01 pt | 0,01 pt | 0,2 pt |
| Lỗi cú pháp (poppler) | ❌ `Unknown font tag 'F1'` | ✅ không có | ✅ không có |
| Thời gian | 46 ms | 49 ms | 22 ms |

Ảnh: `e3_before.png`, `e3_naive_pdfium.png`, `e3_recommended_pdfium_pikepdf.png`, `e3_pymupdf.png`.

### 3.4 Sửa chữ tiếng Việt có sẵn (`e4_text_edit.py`, `pymupdf_compare.py`) ✅

Dòng "Đơn vị: Công ty TNHH Thử Nghiệm Hà Nội" → "Đơn vị: Công ty Cổ phần Ánh Dương Mỹ Kỳ – Quỹ ẵ Ợ".

- **Dò font thiếu chữ**: đảo bảng `ToUnicode` của font (pikepdf + bộ đọc CMap nhỏ), ra 143 ký tự có sẵn, thiếu `ÁầẵỢỳỹ–`. Bảng `cmap` của font nhúng **rỗng** (font subset của reportlab), nên không dựa vào `cmap` được. Font được nhận diện theo **hash nội dung font** (`FPDFFont_GetFontData`), không theo tên: PDFium bỏ tiền tố subset của font đơn giản và trả tên font con cho font Type0, nên hai font khác nhau có thể cùng tên "DejaVuSans" (đã gặp).

| Cách | Hiển thị | Trích xuất chữ mới | Dung lượng file thêm |
|---|---|---|---|
| (a) `FPDFText_SetText` với font subset cũ | ❌ ô vuông ở 7 ký tự thiếu | ❌ | −6 KB |
| (b) `FPDFText_LoadFont` font đầy đủ (DejaVu 760 KB) | ✅ | ✅ | **+395 KB** (PDFium nhúng nguyên font) |
| (c) như (b) nhưng subset trước bằng fontTools (đủ bộ tiếng Việt, 45 KB) | ✅ | ✅ | **+17,7 KB** |
| PyMuPDF: che dòng cũ + `insert_text(fontfile)` + `subset_fonts()` | ✅ | ✅ | +3,2 KB |

Ảnh: `e4_before.png`, `e4_a_…png`, `e4_b_…png`, `e4_c_…png`, `e4_pymupdf.png`. PyMuPDF cũng **không có hàm sửa chữ tại chỗ**: cách làm cũng là "xóa rồi viết lại", giống PDFium.

### 3.5 Gom ký tự thành dòng và đoạn (`e5_layout.py`) ✅

Ký tự lấy từ textpage của pypdfium2 (unicode, khung, gốc tọa độ, cỡ chữ, góc). Bỏ ký tự xoay và ký tự thuộc `/Artifact` (đọc qua mark của đối tượng chữ). Gom theo đường chân chữ, tách theo rãnh giữa hai cột, cắt XY đệ quy để ra cột, tách đoạn theo thụt đầu dòng hoặc khoảng cách dòng, rồi nối đoạn bị ngắt qua cột/trang.

| Chỉ số (3 trang, 6.186 ký tự) | Chef (PDFium + quy tắc) | PDFium `get_text_range` | PyMuPDF blocks (thứ tự gốc / `sort=True`) |
|---|---|---|---|
| Dòng đúng (so với đối tượng chữ) | 168/168 | — | — |
| Đoạn khớp tuyệt đối | **36/36** | — | 34/36 / 32/36 |
| Độ giống thứ tự đọc | **1,000** | 0,914 | 0,998 / 0,353 |
| Thời gian | 90 ms | — | — |

Lần chạy đầu chỉ được 35/36 đoạn: chữ "MẬT" (watermark có nhãn) xen vào thân văn bản. Lọc ký tự thuộc `/Artifact` thì hết lỗi. Thêm một lý do để Chef PDF luôn gắn nhãn chuẩn cho những gì nó tự thêm (D14). 🔶 100% là trên bộ mẫu sạch; văn bản thật (bảng, chú thích, chữ căn đều có giãn từ lớn) sẽ thấp hơn.

## 4. Những cái bẫy của PDFium đã gặp và cách xử lý (đều đã kiểm chứng)

### 4.1 Danh sách bẫy

| # | Bẫy | Hậu quả | Cách xử lý (đã chạy được) |
|---|---|---|---|
| P1 | `GenerateContent` **không ghi lại stream của Form XObject** khi đã xóa đối tượng con bằng `FPDFFormObj_RemoveObject`, mà còn **xóa `/Font` khỏi resources của form** | Nội dung bị che vẫn nằm trong file; form hiển thị lỗi | Tiền xử lý bằng pikepdf: **nhúng thẳng các Form XObject vào content của trang** (`pdf_helpers.inline_forms`: đổi tên resource, `q cm re W n … Q`), rồi `remove_unreferenced_resources` |
| P2 | Chữ nằm trong `/Span <</ActualText>>`: textpage của PDFium trả về chuỗi ActualText **không có vị trí từng ký tự**, khung ký tự lại theo **tọa độ form** | Che sai vị trí, ký tự giữ lại bị dồn một chỗ | Tiền xử lý: bỏ khối `BDC /ActualText … EMC` (giữ nội dung bên trong) |
| P3 | `FPDFText_SetText` dùng font CID subset có sẵn thì **ra mã ký tự sai** (chữ rác); với font đơn giản subset thì đúng | Chữ giữ lại bị sai | Đảo `ToUnicode` rồi gọi `FPDFText_SetCharcodes`. Đã dùng cho 20/20 cụm chữ |
| P4 | API mark của PDFium không đọc được giá trị kiểu name (`/Subtype /Watermark`) | Không phân biệt được Watermark/Pagination | Đọc thuộc tính marked content bằng pikepdf |
| P5 | Chỉ *thêm* đối tượng mới thì `GenerateContent` giữ stream cũ nhưng dọn resources, để lại `Tf /F1` không còn định nghĩa | File hợp lệ kém (poppler báo lỗi; validator PDF/A sẽ bắt) | Sau mỗi operation, kiểm tra mọi tên resource được dùng đều tồn tại (pikepdf). Phiên bản khuyến nghị (inline trước) không còn lỗi này |
| P6 | Tên font PDFium trả về không nhất quán | Gán nhầm font | Nhận diện font bằng hash `FPDFFont_GetFontData` ↔ `FontFile2/3` |
| P7 | `FPDFText_LoadFont` nhúng **nguyên** font | +395 KB mỗi font | Subset trước bằng fontTools (giữ đủ bộ chữ tiếng Việt để sửa tiếp) |
| P8 | Vòng đời đối tượng của pypdfium2: wrapper con phải được giải phóng trước `doc.close()`; không gọi `FPDFPageObj_Destroy` lên đối tượng đã `remove_obj` qua wrapper | Lỗi assert, có nguy cơ giải phóng hai lần | Bọc mỗi operation trong một hàm; dùng API thô khi tự quản lý vòng đời |
| P9 | `FPDFText_SetPositions` trả về false với lời gọi thử | — | Không cần đến: mỗi từ một đối tượng, chữ giữ lại lệch 0,01 pt |
| P10 | 🔶 Trong spike **chưa thấy** PDFium để lại đối tượng mồ côi khi lưu (e1: stream cũ được thay tại chỗ), nhưng PDFium không cam kết dọn | Có nguy cơ còn dữ liệu cũ trong file | **Luôn ghi lại bằng qpdf** (pikepdf `save`) sau khi sửa: rẻ (vài chục ms) và chắc chắn bỏ mọi thứ không còn được tham chiếu; test kiểm tra không còn stream gốc |

### 4.2 Quy trình chuẩn đề xuất cho "bộ máy nội dung" (T6.01)

```
pikepdf: inline Form XObject (trang cần sửa) + bỏ ActualText + đọc ToUnicode/marked content
   ↓
PDFium: liệt kê đối tượng, chọn, biến đổi, xóa, tạo chữ (SetCharcodes / LoadFont đã subset), sửa ảnh
   ↓
FPDFPage_GenerateContent → lưu
   ↓
pikepdf/qpdf: ghi lại toàn bộ (bỏ đối tượng mồ côi), kiểm tra resource, dọn resource thừa
   ↓
Kiểm chứng (bắt buộc với J6/D5): trích chữ bằng PDFium + poppler, stream gốc không còn, điểm ảnh
```

Ghi chú: inline form chỉ làm cho **trang đang sửa** và **form có đối tượng bị sửa**. Form dùng chung cho nhiều trang (ví dụ watermark) sẽ thành bản sao riêng cho từng trang. Dung lượng có thể tăng, nhưng đổi lại sửa được an toàn.

### 4.3 Bộ kiểm chứng che thông tin (`s2/redact_verify.py`)

Không dựa vào chính thư viện vừa sửa: (1) trích chữ bằng PDFium **và** poppler `pdftotext`; (2) tìm xem stream gốc của trang/form còn nằm ở đâu trong file không (bỏ qua stream mà trang khác dùng hợp lệ); (3) giải mã ảnh và đo điểm ảnh trong vùng; (4) liệt kê lỗi cú pháp poppler. Nên đưa nguyên bộ này vào test của T6.07. Chính nhờ bộ này mà phát hiện PyMuPDF rò ActualText.

## 5. So sánh với PyMuPDF (AGPL), chỉ để tham khảo

| Tiêu chí | pypdfium2 + pikepdf | PyMuPDF 2.0 (MuPDF 1.28.5) |
|---|---|---|
| Che thông tin | ~250 dòng tự viết + tiền xử lý; **sạch** trên bộ mẫu | ~10 dòng; **rò qua ActualText**; ảnh tô trắng; lệch 0,2 pt |
| Sửa chữ có sẵn | Không có API sẵn; xóa rồi viết lại (đã chạy) | Không có API sẵn; che rồi `insert_text` (đã chạy, gọn hơn) |
| Font mới | `LoadFont` + fontTools subset | `insert_font` + `subset_fonts()` tự động |
| Chọn đối tượng tại điểm | Tự viết | Tự viết (🔶 không thấy API chọn đối tượng) |
| Di chuyển/co giãn/xóa đối tượng tùy ý | Có API đối tượng trang (✅ đã dùng) | 🔶 Không có mô hình đối tượng trang tương đương (đọc được `get_drawings`/`get_images`/`get_texttrace`, nhưng sửa phải qua che thông tin hoặc can thiệp content stream). Spike chưa thử |
| Dò bố cục | Tự viết, 100% trên mẫu | Khối có sẵn: 34/36 đoạn theo thứ tự gốc, 32/36 với `sort=True` (✅). 🔶 Nhiều cột phức tạp cần thêm gói `pymupdf4llm`/`pymupdf-layout` |
| Giấy phép | Apache/BSD + MPL | AGPL (hoặc mua bản thương mại) |

Kết luận phần này: PyMuPDF **gọn hơn ở che thông tin và chèn chữ**, nhưng **yếu hơn ở thao tác đối tượng** (D4, E4), mà đây lại là lõi của v0.6. Thêm vào đó nó không loại được công việc kiểm chứng/tiền xử lý. Không đề xuất xem lại D7.

## 6. Ước lượng lại v0.6 / v0.7

| Task | Cũ | Mới | Lý do |
|---|---|---|---|
| T6.01 Content engine | 5 | **6** | Thêm tiền xử lý pikepdf (inline form, ActualText, ToUnicode, nhận diện font), ghi lại + kiểm tra resource, quản lý vòng đời |
| T6.02 UI chọn & sửa đối tượng | 2,5 | 2,5 | Logic chọn đã có nguyên mẫu |
| T6.03 Tẩy vùng | 3 | 3 | Lõi đã có nguyên mẫu; còn chữ xoay, path cắt một phần (clip), inline image, ảnh dùng chung nhiều trang |
| T6.04 Thay ảnh, chỉnh ảnh | 2 | 2 | `set_bitmap` chạy được; cẩn thận ảnh dùng chung |
| T6.05 Bảng lớp | 2 | 2 | Không thử trong spike |
| T6.06 Gỡ watermark | 3,5 | 3 | Dò + chấm điểm + gỡ (cả có nhãn lẫn không nhãn) đã chạy |
| T6.07 Che thông tin mật | 3 | 3 | Dùng lõi T6.03 + bộ kiểm chứng đã có |
| **v0.6** | **21** | **21,5** | |
| T7.01 Mô hình chữ | 4 | 4 | Gom dòng/đoạn + dò font thiếu chữ đã có nguyên mẫu, nhưng văn bản thật khó hơn |
| T7.02 Sửa mức dòng | 4 | 4 | Thay font: đóng gói Noto/Be Vietnam Pro, subset khi chèn, chọn font gần giống theo họ/độ đậm/serif |
| T7.03 Sửa mức đoạn | 5 | 5 | Không thử (cần tự xuống dòng, chữ căn đều) |
| T7.04–T7.07 | 8 | 8 | Không bị ảnh hưởng |
| **v0.7** | **21** | **21** | |

Nếu chuyển sang PyMuPDF: ước giảm khoảng 2–3 điểm ở T6.03/T6.07/T7.02, nhưng T6.01/T6.02 (thao tác đối tượng) sẽ khó hơn, và vẫn phải giữ bộ kiểm chứng.

## 7. Việc nên làm tiếp

- Tạo bộ PDF mẫu "thật" hơn cho `tests/corpus/` (xuất từ Word/LibreOffice, văn bản hành chính, PDF scan có lớp chữ) và chạy lại e3/e5 trên đó trước khi bắt đầu v0.6.
- Kiểm tra PDF có cấu trúc thẻ (MCID, `/StructTreeRoot`) sau `GenerateContent`: chưa thử 🔶.
- Báo lỗi P1/P3 cho upstream PDFium (hoặc pypdfium2) nếu muốn bỏ được bước tiền xử lý.
- Báo lỗi rò ActualText cho upstream MuPDF (không ảnh hưởng Chef PDF).
