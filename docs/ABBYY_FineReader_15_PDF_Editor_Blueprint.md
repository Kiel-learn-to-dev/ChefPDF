# Blueprint khảo sát giao diện ABBYY FineReader 15

> Tài liệu này ghi nhận cách tổ chức giao diện và tính năng của ABBYY FineReader 15 để làm đầu vào thiết kế một ứng dụng chỉnh sửa PDF. Trọng tâm là thứ tự **UI → tính năng → tính năng sâu**, đặc biệt là giao diện chỉnh sửa PDF text.

## 1. Phạm vi và cách đọc bằng chứng

Đã khảo sát trực tiếp màn hình Home, PDF Editor với tài liệu trống, OCR Editor với dự án trống, các menu trang/OCR/vùng và hộp thoại Tùy chọn. Ở lượt khảo sát mới, FineReader đang mở một PDF nhiều trang ở chế độ **Chỉnh sửa**, có khung chữ được chọn. Nội dung tài liệu đó không được trích vào ghi chú; chỉ ghi nhận bố cục và điều khiển.

Nhãn bằng chứng:

- **Đã thấy trên UI:** điều khiển hoặc trạng thái quan sát trực tiếp.
- **Có trong trợ giúp/tài nguyên:** chủ đề tính năng có trong `help.fineReader.xml` hoặc thành phần cài đặt.
- **Suy luận thiết kế:** đề xuất cho app mới, không phải khẳng định tính năng ABBYY hoạt động đúng như vậy.
- **Chưa thử:** hành vi cần tài liệu mẫu riêng để kiểm chứng, ví dụ reflow văn bản, thay font rồi lưu, undo/redo sau sửa.

Không dùng tên file/DLL đơn lẻ làm bằng chứng chắc chắn cho một tính năng. Tên ứng dụng `FineReader.exe`, `FineReaderOCR.exe`, `Comparator.exe`, `HotFolder.exe`, `ScreenshotReader.exe`, cùng trợ giúp cài đặt là dấu hiệu về các không gian làm việc được phân tách.

## 2. Bản đồ sản phẩm

FineReader chia trải nghiệm thành một màn hình Home theo tác vụ, một PDF Editor, một OCR Editor và các công cụ riêng cho so sánh, quét, xử lý hàng loạt.

| Không gian | Người dùng vào để | Bằng chứng/chắc chắn |
|---|---|---|
| Home của FineReader | Mở PDF, quét, so sánh, chuyển đổi, mở gần đây | Đã thấy trên UI |
| PDF Editor | Xem, tổ chức trang, chỉnh PDF, chú thích, bảo vệ, lưu/xuất | Đã thấy trên UI; menu và trợ giúp hỗ trợ thêm |
| OCR Editor | Nhận dạng trang, chỉnh vùng, xác minh văn bản, xuất kết quả | Đã thấy trên UI; trạng thái dự án trống hạn chế kiểm tra vùng tài liệu |
| So sánh tài liệu | So hai phiên bản, đánh dấu khác biệt và xuất kết quả | Home mô tả và ứng dụng riêng được cài |
| Quét / Hot Folder / Screenshot Reader | Nhập từ scanner, tự động xử lý thư mục hoặc lấy nội dung từ ảnh màn hình | Có ứng dụng riêng trong bộ cài; không khảo sát luồng sâu của các app này |

## 3. Home: chọn tác vụ

### 3.1 Bố cục

- Thanh tiêu đề và menu **Tệp / Chỉnh sửa / Xem / Công cụ / Trợ giúp** ở trên cùng.
- Thanh điều hướng dọc nền xanh bên trái: **Mở**, **Quét**, **So sánh**, **Gần đây**; cuối thanh có **Tùy chọn** và **Trợ giúp**.
- Vùng nội dung lớn màu trắng ở giữa thay đổi theo mục đang chọn.
- Nút/hàng tác vụ hiển thị bằng biểu tượng + nhãn; mỗi mục có tiêu đề và nhóm tác vụ rõ ràng.

### 3.2 Tác vụ và chiều sâu

| UI | Tính năng | Tính năng sâu quan sát được |
|---|---|---|
| Mở | Xem/chỉnh PDF hoặc chuyển đổi | Mở PDF; mở trong OCR Editor; chuyển thành PDF, Word, Excel hoặc định dạng khác |
| Quét | Tạo tài liệu từ giấy | Quét vào OCR Editor; quét thẳng ra PDF, Word, Excel, ảnh hoặc định dạng khác |
| So sánh | So sánh hai bản | Mở ABBYY So sánh tài liệu; phần mô tả cho biết có thể đánh dấu khác biệt và lưu báo cáo/PDF có nhận xét |
| Gần đây | Quay lại công việc | Danh sách PDF và dự án OCR, có tìm kiếm |
| Menu Tệp | Lối tắt theo tài liệu | Tài liệu PDF mới, mở/quét, chuyển đổi, mở/quét vào OCR Editor, tạo/mở dự án OCR, tài liệu gần đây |

**Gợi ý thiết kế:** giữ các tác vụ lớn ở Home, nhưng đặt Recent dưới nhóm phụ hoặc giới hạn theo số lượng; ưu tiên Mở, Tạo, Quét và OCR để người mới biết điểm bắt đầu.

## 4. PDF Editor: khung làm việc và bố cục

### 4.1 Sơ đồ vùng UI

```text
┌────────────────────────────────────────────────────────────────────┐
│ Menu ứng dụng: Tệp | Chỉnh sửa | Xem | Công cụ | Trợ giúp          │
├────────────────────────────────────────────────────────────────────┤
│ Thanh PDF: mở/lưu/in, trang, thêm trang, xoay/cắt, OCR, so sánh    │
├────────────────────────────────────────────────────────────────────┤
│ Công cụ nội dung: ghi chú/vẽ/đánh dấu | chỉnh sửa/xóa | ảnh/dấu/ký │
│ Thanh định dạng chữ theo ngữ cảnh (chỉ hiện khi vào sửa chữ)       │
├─────────────┬─────────────────────────────────┬──────────────────┤
│ Panel trái  │ Canvas trang PDF                │ Panel phải tùy chọn│
│ Trang       │ cuộn, trang liên tục            │ Nhận xét/khác      │
│ Dấu trang   │ đối tượng được chọn trên trang  │                    │
│ Tìm kiếm    │                                 │                    │
│ Tệp đính kèm│                                 │                    │
│ Chữ ký số   │                                 │                    │
├─────────────┴─────────────────────────────────┴──────────────────┤
│ Thanh dưới: chế độ xem, nền OCR, zoom, trạng thái                 │
└────────────────────────────────────────────────────────────────────┘
```

### 4.2 Thành phần trực tiếp quan sát

| Vị trí | UI | Vai trò / ghi chú |
|---|---|---|
| Trên cùng | Menu ứng dụng | Nhóm lệnh phổ quát; vẫn hiện trong PDF Editor |
| Hàng công cụ thứ nhất | Tác vụ tài liệu | Mở, lưu, lưu thành, in, email, điều hướng trang, thêm trang, xoay, cắt, nhận dạng, so sánh, hoàn tác/làm lại, chọn đối tượng và công cụ cầm tay |
| Hàng công cụ thứ hai | Công cụ PDF | Ghi chú, vẽ, đánh dấu, gạch chân, chèn văn bản, gạch ngang, chỉnh sửa, xóa, ảnh, bản quyền ảnh, dấu, đầu/chân trang, chữ ký, soạn dữ liệu, mật khẩu |
| Thanh dọc trái | Bộ chọn panel | Trang, dấu trang, tìm kiếm, tệp đính kèm, chữ ký số |
| Panel trái | Danh sách trang/điều hướng | Thumbnail, thao tác trang, nút đóng panel |
| Canvas | Trang PDF | Có thể cuộn; ở chế độ chỉnh chữ, đối tượng text có khung chọn và tay nắm |
| Panel phải | Nhận xét | Có thể mở/đóng; có tìm kiếm, sắp xếp, lọc và mở rộng mục |
| Thanh dưới | Xem và phóng to | Một trang/cuộn một trang/hai trang/cuộn hai trang/toàn màn hình, kích cỡ thực, vừa chiều rộng/vừa trang, zoom; trạng thái nhận dạng nền |

### 4.3 Trạng thái panel Trang trong lượt khảo sát mới

- **Đã thấy trên UI:** panel Trang đang mở rộng khá rộng; thumbnail của tài liệu nhiều trang hiển thị dạng lưới bốn cột ở độ phân giải màn hình lớn. Trang đang chọn được viền/nền xanh và có số trang bên dưới.
- **Suy luận:** số cột thumbnail thích ứng theo chiều rộng panel; thiết kế của app nên hỗ trợ panel thay đổi kích thước, không khóa cứng một cột.
- **Đã thấy trên UI:** canvas ở bên phải hiển thị trang và có thể cuộn dọc giữa các trang; thanh trên cũng có ô số trang hiện tại/tổng số.
- **Đã thấy trên UI:** panel Nhận xét đang thu gọn; nút trên cùng hiển thị số nhận xét.

## 5. Chỉnh sửa PDF text — khảo sát trọng tâm

### 5.1 UI khi vào chế độ chỉnh sửa

**Đã thấy trên UI:** nút **Chỉnh sửa** trên hàng công cụ nội dung đang được chọn. Trên trang, khung chữ được bao quanh bởi đường viền xanh và các tay nắm chọn. Đây là tín hiệu rõ rằng thao tác hiện tại nhắm vào một đối tượng/vùng chữ cụ thể, không phải đang ở chế độ xem thuần.

Khi bật chỉnh sửa chữ, FineReader hiện một hàng điều khiển định dạng ngay bên dưới hàng công cụ PDF. Những điều khiển nhìn thấy:

- **Thêm văn bản**.
- Hộp chọn font và cỡ chữ.
- Tăng/giảm cỡ chữ.
- Đậm, nghiêng.
- Các biểu tượng căn lề.
- Điều khiển thụt lề/khoảng cách và màu chữ.

Phần căn lề, thụt lề và màu được nhận dạng từ biểu tượng trên thanh công cụ; chưa kiểm tra thay đổi và phạm vi áp dụng.

### 5.2 Cây tính năng

| UI | Tính năng | Tính năng sâu / mức xác nhận |
|---|---|---|
| Hàng công cụ nội dung → Chỉnh sửa | Chọn và chỉnh chữ trên trang | Khung chữ có viền xanh/tay nắm; thanh định dạng chữ xuất hiện theo chế độ. Chưa thử reflow, sửa cả đoạn, nối hộp chữ hoặc độ chính xác sau lưu. |
| Hàng định dạng chữ | Định dạng đoạn/đối tượng chữ | Font, cỡ, tăng/giảm cỡ, đậm/nghiêng, căn lề, thụt lề/khoảng cách, màu. Các tùy chọn cụ thể theo vùng chọn chưa được thử. |
| Hàng công cụ nội dung → Thêm văn bản | Chèn lớp chữ mới | Nút riêng “Thêm văn bản”; chưa thực hiện thao tác đặt text lên trang. |
| Hàng công cụ nội dung → Xóa | Xóa đối tượng | Có lệnh riêng cạnh chỉnh sửa; chưa thử xóa để tránh thay đổi tài liệu. |
| Hàng công cụ nội dung → Ảnh | Thêm/đặt ảnh | Công cụ ảnh riêng; thao tác thay ảnh hoặc điều chỉnh kích thước chưa thử. |
| Hàng công cụ nội dung → Bản quyền hình ảnh | Đánh dấu ảnh | Công cụ riêng; chưa khảo sát hộp thoại/đầu ra. |
| Thanh công cụ PDF → Chọn đối tượng | Chọn nội dung | Có chế độ chọn đối tượng và chế độ cầm tay để phân biệt thao tác chọn với kéo xem trang. |

### 5.3 Mô hình tương tác rút ra

1. Người dùng chọn **Chỉnh sửa**.
2. Chọn vùng chữ trên trang; khung đối tượng/tay nắm cho biết phạm vi đang tác động.
3. Thanh định dạng xuất hiện theo ngữ cảnh.
4. Chỉnh nội dung/định dạng tại chỗ.
5. Lưu hoặc lưu thành bản khác.

Các bước 1–3 được thấy trên UI. Bước 4–5 là luồng suy ra từ điều khiển; chưa thay đổi hoặc lưu nội dung PDF đang mở.

### 5.4 Hạng mục cần kiểm chứng trên bản sao tài liệu

- Chọn một từ, một dòng, cả đoạn và cả khung: khung chọn thay đổi thế nào?
- Text có tự chảy lại khi thêm/bớt chữ không? Khi tràn trang thì xử lý thế nào?
- App chỉnh lớp text sẵn có, OCR text, hay chuyển cả vùng thành đối tượng mới?
- Đổi font/cỡ/căn lề có làm lệch bố cục, dấu tiếng Việt hoặc bảng không?
- Undo/redo có thể hoàn tác cả nội dung, định dạng và di chuyển đối tượng không?
- Lưu đè/lưu bản sao; PDF đầu ra có giữ tìm kiếm, copy, bookmark, tag và comment không?

## 6. Panel PDF và quản lý trang

### 6.1 Panel Trang

**UI → tính năng → sâu:** thumbnail trang → chọn/điều hướng và quản lý trang → thao tác nhiều trang, thêm từ nguồn, xoay/cắt/thay thế/xóa.

Menu ba chấm cạnh panel trang cung cấp:

- Thêm trang từ tệp hoặc máy quét.
- Thêm trang trắng.
- Tạo PDF từ trang đã chọn.
- Gửi trang đã chọn sang OCR Editor.
- Lưu dưới dạng, gửi email, in.
- Xoay, cắt, thay thế và xóa trang.

**Blueprint:** đặt thao tác cơ bản như thêm/xoay/xóa ngay cạnh thumbnail; thao tác theo lô hoặc ít dùng đặt trong menu phụ. Khi chọn nhiều thumbnail, hiện thanh hành động theo selection và giữ rõ số trang đã chọn.

### 6.2 Dấu trang, tìm kiếm, tệp đính kèm, chữ ký số

- **Dấu trang:** panel trái có thêm/xóa/đổi tên và menu tác vụ khác.
- **Tìm kiếm:** panel trái có ô nhập, điều hướng kết quả và số kết quả tìm thấy.
- **Tệp đính kèm:** panel riêng có mở, lưu, thêm, xóa, đổi tên attachment.
- **Chữ ký số:** panel riêng để rà soát chữ ký; trạng thái rỗng hiển thị rõ khi không có chữ ký.

Các mục này nằm cùng một thanh icon dọc; chọn mục thay nội dung panel chứ không thay canvas chính.

### 6.3 Nhận xét

Nút Nhận xét ở góc trên mở panel phải. Panel có ô tìm kiếm nhận xét, sắp xếp, lọc, mở rộng tất cả và điều hướng qua lại giữa mục. Tách panel nhận xét khỏi công cụ tạo nhận xét giúp vừa rà soát danh sách vừa giữ trang làm trung tâm.

## 7. OCR Editor và nhận dạng

### 7.1 Bố cục OCR Editor

- Menu riêng: **Tệp / Chỉnh sửa / Xem / Nhận dạng / Vùng / Công cụ / Trợ giúp**.
- Thanh trên: dự án mới/mở, mở file, quét, chuyển trang, nhận dạng, chọn ngôn ngữ, hoàn tác/làm lại, lưu và chọn chế độ xuất.
- Panel Trang bên trái; canvas ở giữa.
- Có nút **Xác minh** và chuyển lỗi trước/sau; các nút có thể vô hiệu hóa khi chưa có trang/kết quả.
- Các điều khiển giữ lại ảnh và đầu/chân trang nằm gần chế độ lưu.

### 7.2 OCR: tính năng sâu

**Menu Nhận dạng:** nhận dạng một trang hoặc toàn bộ; phân tích một trang hoặc toàn bộ; xác minh văn bản; chuyển đến lỗi kế tiếp/trước; đánh dấu văn bản đã xác minh; tạo tác vụ tự kiến.

**Menu Vùng:** loại vùng gồm văn bản, bảng, ảnh, ảnh nền, mã vạch và vùng nhận dạng. Có phân tích vùng, khoanh vùng, đổi loại, chia/ghép ô bảng, lưu/tải mẫu vùng.

**Tùy chọn OCR:** chế độ nhận dạng PDF; nhận dạng sâu/nhanh; loại tài liệu tự động/fax/máy đánh chữ; phát hiện đầu/chân trang, mục lục, danh sách đánh số, chú thích cuối trang; nhận dạng mã vạch; dùng mẫu có sẵn, mẫu người dùng hoặc huấn luyện ký tự/chữ dính mới.

**Tùy chọn xử lý ảnh:** bật nhận dạng nền trong PDF Editor; chọn ngôn ngữ; tự xử lý ảnh khi thêm vào OCR Editor; tách trang đối diện; chỉnh hướng trang; dùng thiết lập đề xuất.

### 7.3 Luồng OCR đề xuất cho app mới

```text
Nhập/Quét → Tiền xử lý ảnh → Chọn ngôn ngữ → Nhận dạng
    → Rà vùng/kết quả và sửa lỗi → Chọn cấu trúc đầu ra → Xuất
```

Trong blueprint, phân biệt rõ **nhận dạng nền để tìm kiếm/copy** với **OCR tạo tài liệu có thể xuất**. Đây là hai mục đích khác nhau và FineReader cũng trình bày như các thiết lập/lệnh riêng.

## 8. Xuất, bảo vệ và so sánh

### 8.1 Xuất

Home có lối tắt xuất PDF, Word, Excel và định dạng khác. Danh sách trong Tùy chọn định dạng gồm PDF, DOC(X)/RTF/ODT, XLS(X), PPTX, CSV, TXT, HTML, EPUB/FB2, DjVu.

Thiết lập PDF nhìn thấy trong hộp thoại Tùy chọn:

- Chất lượng hình ảnh; PDF/A; PDF/UA (yêu cầu OCR).
- Bảo vệ bằng mật khẩu; xóa đối tượng/dữ liệu.
- Cỡ giấy thống nhất; nén MRC; tùy chọn xử lý scan.
- PDF có thể tìm kiếm và vị trí lớp chữ.
- Bookmark từ tiêu đề; thẻ PDF; phông chữ.
- Giữ/chỉnh metadata.

### 8.2 Bảo vệ và dấu

Hàng công cụ nội dung có mật khẩu, chữ ký, dấu, đầu/chân trang, watermark và công cụ xóa/che nội dung. Trợ giúp cài đặt có chủ đề bảo mật PDF, redaction, chữ ký hình ảnh/chữ, dấu và Bates stamping.

**Lưu ý thiết kế:** tách “che trực quan” khỏi “redaction vĩnh viễn”; trước khi áp dụng redaction nên có bước xác nhận phạm vi và preview. Đây là khuyến nghị, không phải hành vi được thử trong phiên khảo sát.

### 8.3 So sánh

Home mô tả so sánh phiên bản tài liệu, làm nổi bật khác biệt và lưu báo cáo/PDF có nhận xét; công cụ chạy thành ứng dụng riêng. Nếu đưa vào app, nên có trạng thái chọn hai nguồn, màn hình kết quả song song, điều hướng từng khác biệt và xuất báo cáo.

## 9. Blueprint đề xuất cho ứng dụng PDF mới

### 9.1 Kiến trúc thông tin

1. **Home:** Mở file, tài liệu mới, quét/OCR, ghép/sắp trang, gần đây.
2. **Workspace PDF:** xem/chỉnh PDF, panel trang, nội dung, chú thích và bảo vệ.
3. **Workspace OCR:** tiền xử lý, nhận dạng, vùng, xác minh và xuất.
4. **Compare:** chọn hai bản, xem sai khác, ghi chú và xuất báo cáo.
5. **Export:** chọn định dạng và thiết lập chất lượng/bảo mật/metadata.

### 9.2 Sơ đồ màn hình Editor

```text
┌───────────────────────────────────────────────────────────────────┐
│ Tên tài liệu / menu / lưu trạng thái                              │
├───────────────────────────────────────────────────────────────────┤
│ Thanh chung: Mở | Lưu | Undo/Redo | In | Chia sẻ | Trang          │
├───────────────────────────────────────────────────────────────────┤
│ Tab công cụ: Trang | Chỉnh sửa | Chú thích | OCR | Bảo vệ | Xuất  │
├───────────────┬────────────────────────────┬──────────────────────┤
│ Icon điều hướng│ Thumbnail / nội dung panel│ Canvas trang         │
│ Trang          │ có thể đổi kích thước     │                      │
│ Bookmark       │                            │                      │
│ Tìm kiếm       │                            │                      │
│ Comment        │                            │ Bảng thuộc tính      │
│ Attachment     │                            │ theo đối tượng       │
├───────────────┴────────────────────────────┴──────────────────────┤
│ Trang hiện tại | zoom | bố cục xem | trạng thái OCR/đang lưu      │
└───────────────────────────────────────────────────────────────────┘
```

### 9.3 Hành vi UI nên ưu tiên

- Giữ canvas ổn định; mở/đóng panel không làm mất trang hoặc vùng đang chọn.
- Thanh chữ chỉ hiện khi chọn/chỉnh text; thuộc tính đổi theo loại đối tượng (text, ảnh, comment, chữ ký).
- Đánh dấu rành mạch trạng thái **xem / chọn / chỉnh sửa** để tránh người dùng vô tình sửa.
- Thumbnail có lưới thích ứng chiều rộng; hỗ trợ chọn nhiều trang và kéo sắp xếp.
- Công cụ trang ít dùng đặt trong menu phụ; lệnh thường dùng hiện trực tiếp.
- Khi lưu/xuất có chỉ báo tiến trình, kết quả và đường quay lại tài liệu.
- Phân biệt lớp chữ native, lớp OCR và hình ảnh scan ở mức trạng thái; cung cấp cách xử lý phù hợp cho từng loại.

## 10. Ưu tiên MVP và mở rộng

| Giai đoạn | Tính năng | Lý do |
|---|---|---|
| MVP | Mở/xem PDF, thumbnail, điều hướng, xoay/xóa/thêm trang, tìm kiếm, chú thích cơ bản, lưu/lưu thành | Các tác vụ nền tảng và thường xuyên |
| MVP | Chọn text/object, sửa text cơ bản, thêm text, undo/redo, zoom/chế độ xem | Cốt lõi của trình chỉnh sửa; cần kiểm soát rõ chọn vs sửa |
| MVP | Xuất PDF và Word; cảnh báo khi lớp chữ/OCR không sẵn có | Hoàn tất luồng công việc chính |
| Giai đoạn 2 | OCR theo trang/toàn tài liệu, chọn ngôn ngữ, tiền xử lý, rà lỗi | Hữu ích với PDF scan và chuyển đổi |
| Giai đoạn 2 | Bookmark, attachment, chữ ký, bảo vệ bằng mật khẩu, redaction thật | Mở rộng quy trình rà soát và chia sẻ |
| Nâng cao | So sánh, Bates, watermark, Hot Folder, tác vụ tự động, nhiều định dạng xuất | Phục vụ người dùng chuyên sâu và quy trình số lượng lớn |

## 11. Những điểm chưa xác nhận

- Hành vi chỉnh sửa đoạn chữ, tự xuống dòng, thay font và bảo toàn bố cục sau lưu.
- Hành vi khi chọn text thật so với chọn khung OCR; khả năng nối/chia text block.
- Độ trung thực của các công cụ ảnh, bảng, liên kết và lớp chữ scan.
- Hộp thoại xuất cuối, các mặc định theo giấy phép và hành vi khi file có mật khẩu.
- So sánh trực tiếp, scanner, Hot Folder và Screenshot Reader chưa được khảo sát sâu.

Muốn kiểm tra các điểm này an toàn, dùng một PDF mẫu không nhạy cảm hoặc bản sao được phép chỉnh sửa; ghi lại trạng thái trước/sau, menu, hộp thoại và kết quả xuất.

## 12. Nguồn khảo sát

- Giao diện cài đặt ABBYY FineReader 15 trên máy, tiếng Việt.
- Thư mục cài đặt: `C:\Program Files (x86)\ABBYY FineReader 15`.
- Bản đồ chủ đề trợ giúp: [help.fineReader.xml](</C:/Program Files (x86)/ABBYY FineReader 15/help.fineReader.xml>), có các chủ đề như `workwithpdf`, `workwithocr`, `batchwork`, `redaction`, `pdf_security`, `comparedocuments`, `taskmanager`, `watermarks` và `batesstamping`.
- Phiên bản thực thi FineReader được ghi nhận trong thuộc tính file ở lượt trước: 15.0.18.1494.

