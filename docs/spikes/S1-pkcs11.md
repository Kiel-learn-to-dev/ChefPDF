# Spike S1 (T1.08): Ký số PKCS#11 bằng pyHanko

> Ngày 2026-10-31. Chạy trên Linux (container), **SoftHSM2 thay cho token thật**.
> Ký hiệu: ✅ **đã kiểm chứng** (có script và kết quả trong repo) · 🔶 **chưa kiểm chứng**, chỉ là nhận định · ❌ không làm được trong môi trường spike.

## 1. Kết luận nhanh

- ✅ **pyHanko + python-pkcs11 đủ cho toàn bộ phần ký của v0.3**: ký ẩn B-B, ký hiển thị có chữ tiếng Việt + ảnh PNG trong suốt, B-T, B-LT, B-LTA, hai người ký nối tiếp, ký chứng nhận (DocMDP), ký bằng cơ chế RSA "thô". Mọi file đều được bộ kiểm tra của pyHanko xác nhận **nguyên vẹn, hợp lệ, tin cậy** với Root CA thử nghiệm.
- ✅ Đọc lại được **MST/CCCD** từ thuộc tính `UID` (OID `0.9.2342.19200300.100.1.1`) của chứng thư, subject UTF-8 tiếng Việt không lỗi.
- ✅ Liệt kê slot/token/chứng thư **không cần PIN**; đọc được cờ `USER_PIN_COUNT_LOW / FINAL_TRY / LOCKED`.
- ✅ **Phát hiện lỗi của pyHanko 0.38**: chữ ký hiển thị dùng font TrueType (DejaVu, Arial, Times…) bị giãn chữ. Có cách vòng (đổi `unitsPerEm` về 1000 bằng fontTools). Khuyến nghị **tự vẽ giao diện chữ ký** thay vì dùng `TextStampStyle` (mục 5).
- ❌ **TSA công cộng không thử được**: proxy của môi trường spike chặn (HTTP 403) mọi máy chủ TSA ngoài. B-T/B-LT/B-LTA được kiểm chứng bằng **TSA cục bộ** (RFC 3161). Phải thử lại trên máy chủ dự án bằng `s1_token_probe.py --probe-tsa`.
- 🔶 **Rủi ro R1 vẫn còn nguyên** ở phần driver token thật (Windows/macOS/Linux) và tương thích Adobe Reader. Spike này loại bỏ rủi ro ở phần *thư viện*, chưa loại bỏ rủi ro ở phần *driver*. Việc tiếp theo là chủ dự án chạy checklist ở mục 9.

## 2. Môi trường

| Thành phần | Phiên bản |
|---|---|
| Python | 3.13 (dự án yêu cầu ≥ 3.12) |
| pyHanko / pyhanko-certvalidator | 0.38.0 / 0.33.0 |
| python-pkcs11 | 0.9.5 |
| cryptography | 50.0.2 |
| SoftHSM2 | 2.6 (Cryptoki 2.40), cài bằng `apt-get install softhsm2 opensc` |

Chạy lại: `cd spikes && uv sync && bash s1/run_all.sh`. Kết quả nằm ở `spikes/s1/out/` (`results.json`, `validation.json`, `pin_flags.json`, ảnh PNG, vài PDF đã ký và `pki/root.crt.pem`).

| Script | Việc |
|---|---|
| `s1/pki.py` | Tạo chuỗi Root CA → CA trung gian → người ký (subject tiếng Việt, `UID=MST:…`, `UID=CCCD:…`), chứng thư OCSP, TSA, một chứng thư bị thu hồi, CRL |
| `s1/hsm_setup.py` | Tạo token SoftHSM, nạp khóa + chứng thư + chuỗi CA bằng python-pkcs11 (nhãn UTF-8 "Nguyễn Văn A") |
| `s1/revocation_server.py` | Máy chủ cục bộ: CRL, OCSP, TSA RFC 3161 |
| `s1/sign_tests.py` | Các kịch bản ký (a)–(h), đo thời gian |
| `s1/validate.py` | Kiểm tra chữ ký (trực tuyến, ngoại tuyến chỉ dùng DSS, AdES-LTA), đọc MST/CCCD |
| `s1/pin_flags.py` | Liệt kê không cần PIN, thử PIN sai trên token phụ, đo cờ PIN |
| `s1_token_probe.py` | **Công cụ cho token thật** (mục 9) |

## 3. Kết quả các kịch bản ký

Thời gian đo trên container (SoftHSM là phần mềm, token thật sẽ chậm hơn ở bước ký RSA, thường 100–500 ms mỗi lần ký 🔶).

| # | Kịch bản | Kết quả | Thời gian |
|---|---|---|---|
| — | Mở session + đăng nhập PIN | ✅ | 6 ms |
| a | Ký ẩn PAdES B-B (`ETSI.CAdES.detached`, SHA-256) | ✅ hợp lệ, tin cậy | 31 ms |
| b1 | Ký hiển thị bằng `TextStampStyle` của pyHanko + font OpenType + ảnh PNG nền | ✅ sau khi sửa font (xem mục 5) | 117 ms |
| b2 | Ký hiển thị với giao diện tự vẽ bằng reportlab, nhập vào bằng `StaticStampStyle` | ✅ đẹp nhất, linh hoạt nhất | 29 ms |
| c | B-T với TSA công cộng | ❌ bị proxy chặn (DigiCert, Sectigo, FreeTSA, SSL.com, GlobalSign đều 403) | — |
| c | B-T với TSA cục bộ (RFC 3161 qua HTTP) | ✅ dấu thời gian hợp lệ, tin cậy | 198 ms |
| d | B-LT (nhúng chuỗi, OCSP, CRL vào DSS) | ✅ | 252 ms |
| d | B-LTA (thêm dấu thời gian tài liệu) | ✅ | 296 ms |
| e | Hai người ký nối tiếp vào hai ô ký tạo sẵn, ghi incremental | ✅ chữ ký 1 vẫn hợp lệ, mức thay đổi `FORM_FILLING` | 94 + 194 ms |
| f | Ký chứng nhận `FILL_FORMS` rồi người thứ hai ký duyệt | ✅ cả hai hợp lệ | 28 + 131 ms |
| f | Ký chứng nhận `NO_CHANGES` rồi ký thêm | ✅ pyHanko **từ chối** ký thêm (đúng chuẩn) | — |
| g | Chứng thư bị thu hồi | ✅ bộ kiểm tra báo `revoked=True`, `trusted=False`; pyHanko **từ chối** ký B-LT bằng chứng thư này | — |
| h | Ký bằng `CKM_RSA_PKCS` thô (băm trên máy, pyHanko tự bọc DigestInfo) | ✅ hợp lệ | 38 ms |
| — | Ký hàng loạt 10 file, đăng nhập PIN 1 lần | ✅ | 325 ms tổng |

Ghi chú: (h) quan trọng cho token đời cũ không hỗ trợ `CKM_SHA256_RSA_PKCS`. Docstring của pyHanko nói chế độ raw chỉ dành cho ECDSA, nhưng mã nguồn 0.38 đã hỗ trợ RSA PKCS#1 v1.5 và chạy đúng.

### Kiểm tra chữ ký (`s1/validate.py`)

- ✅ Kiểm tra trực tuyến (bật OCSP/CRL cục bộ, `hard-fail`): **mọi file đều `intact`, `valid`, `trusted`**; trừ file ký bằng chứng thư bị thu hồi (`revoked`).
- ✅ Kiểm tra **ngoại tuyến** (tắt máy chủ, chỉ dùng DSS nhúng trong file): B-LT và B-LTA vẫn **tin cậy**; B-B và B-T thì không (đúng kỳ vọng: không có thông tin thu hồi).
- ✅ Kiểm tra AdES-LTA (ETSI EN 319 102-1) cho file B-LTA: `PASSED`, và **giả lập 3 năm sau** (chứng thư người ký đã hết hạn) vẫn `PASSED`.
- ✅ Đọc lại MST/CCCD: `{'MST': ['0101234567'], 'CCCD': ['001234567890']}`. Cách làm: duyệt mọi thuộc tính subject, khớp mẫu `^(MST|MNS|CMND|CCCD|HC|BHXH)\s*[:=]\s*(\S+)$`. 🔶 Một số CA có thể ghi MST ở `OU`, `CN` hoặc `serialNumber`, nên hàm duyệt **mọi** thuộc tính chứ không chỉ `UID`. Cần đối chiếu với chứng thư thật.
- 🔶 API kiểm tra của pyHanko có hai tầng: hàm cũ (`validate_pdf_signature`, đơn giản) và tầng AdES mới (`ades_lta_validation`, cần dựng nhiều đối tượng chính sách). Hàm `validate_pdf_ltv_signature` của các bản cũ **đã bị bỏ** ở 0.38. T3.08 nên dùng tầng AdES cho kết luận cuối và tầng cũ cho chi tiết hiển thị.

## 4. Đăng nhập PIN, slot, token, cờ PIN (`s1/pin_flags.py`)

✅ **Liệt kê không cần PIN**: `lib.get_slots(token_present=True)` → `slot.get_token()` → `token.open()` (session công khai, không `C_Login`) → `get_objects({CLASS: CERTIFICATE})`. Thấy đủ 3 chứng thư (người ký, CA trung gian, Root) cùng nhãn UTF-8 và `CKA_ID`. Khóa riêng **không** hiện khi chưa đăng nhập (đúng chuẩn).

✅ **Cờ PIN** đọc bằng `token.flags & TokenFlag.USER_PIN_COUNT_LOW / USER_PIN_FINAL_TRY / USER_PIN_LOCKED / USER_PIN_TO_BE_CHANGED`.

Những điểm dễ sai (đều đã kiểm chứng trên SoftHSM, trừ khi ghi khác):

1. **Cờ là ảnh chụp tại thời điểm gọi.** Đối tượng `Token` của python-pkcs11 giữ cờ lúc tạo. Muốn cờ mới phải gọi lại `slot.get_token()` / `lib.get_token(...)` (tức gọi lại `C_GetTokenInfo`) **ngay trước** mỗi lần hỏi PIN.
2. **SoftHSM không khóa token**: sau 1 lần sai bật `USER_PIN_COUNT_LOW`, nhưng 12 lần sai vẫn không khóa và PIN đúng vẫn vào được. Bộ đếm chỉ nằm trong bộ nhớ của tiến trình. Vì vậy **không thể kiểm thử logic khóa token bằng SoftHSM**; phải giả lập cờ trong unit test và thử tay với token thật (🔶 token thật thường khóa sau 3–10 lần sai, tùy CA).
3. **Đăng nhập là theo ứng dụng + token, không theo session.** Mở session thứ hai kèm PIN trong cùng tiến trình → `CKR_USER_ALREADY_LOGGED_IN`; mở session không PIN thì *đã thấy* khóa riêng. ⇒ Lõi phải giữ **đúng một trạng thái đăng nhập cho mỗi token** và dùng lại cho cả lô ký (I31).
4. **Slot thay đổi khi rút/cắm token**: xóa token sau lưng một module đã nạp làm `C_GetTokenInfo` trả `CKR_GENERAL_ERROR`. ⇒ Mỗi lần liệt kê phải bắt lỗi theo từng slot, và phát hiện rút token để bỏ phiên đăng nhập.
5. SoftHSM luôn có một slot rỗng chưa khởi tạo; `C_OpenSession` trên slot đó báo `TokenNotRecognised`. ⇒ Chỉ mở session trên token có cờ `TOKEN_INITIALIZED`.
6. Nếu token có cờ `PROTECTED_AUTHENTICATION_PATH` (bàn phím trên token, hoặc driver tự hiện cửa sổ PIN) thì truyền `pkcs11.PROTECTED_AUTH` thay cho chuỗi PIN. 🔶 Chưa thử được, chưa có token loại này.
7. Tra cứu khóa/chứng thư bằng **`CKA_ID`** ổn định hơn bằng nhãn. Nhãn UTF-8 "Nguyễn Văn A" vẫn tra được (✅), nhưng 🔶 driver Việt Nam có thể ghi nhãn theo bảng mã khác.
8. ✅ Nạp **hai module PKCS#11 trong cùng một tiến trình** (SoftHSM + OpenSC) được với python-pkcs11 0.9.5. Dù vậy, công cụ dò vẫn nạp mỗi driver trong **tiến trình con có hạn giờ**, để driver lỗi không làm treo hay sập lõi.

## 5. Giao diện chữ ký: cái gì dễ, cái gì khó

| Cách | Ưu | Nhược |
|---|---|---|
| **B1:** `TextStampStyle` của pyHanko + `GlyphAccumulatorFactory` (font OpenType, HarfBuzz) + ảnh nền | Có sẵn; chữ tiếng Việt định hình đúng; tự co nội dung cho vừa khung (`SHRINK_TO_FIT`) | ✅ **Lỗi của pyHanko 0.38**: ghi bảng độ rộng `/W` và khoảng chỉnh `TJ` theo đơn vị font gốc, ngầm cho rằng `unitsPerEm = 1000`. Font TrueType (DejaVu, Arial, Times, phần lớn font hệ thống) dùng 2048, nên chữ bị giãn rộng và tràn khung (xem `s1/out/b1_bug_2048upm.png`). **Cách vòng**: đổi font về 1000 UPM bằng `fontTools.ttLib.scaleUpem` (`common/fonts.py: font_1000_upm`), sau đó hiển thị đúng (`b1_visible_pyhanko_style.png`). Ngoài ra: **không tự xuống dòng**; chỉ có 1 ảnh nền và 1 khối chữ; căn chỉnh hạn chế |
| **B2:** tự vẽ giao diện thành PDF 1 trang (reportlab), rồi `StaticStampStyle.from_pdf_file()` | Toàn quyền bố cục: ảnh trái + chữ phải, tự xuống dòng (`simpleSplit`), **tự co cỡ chữ** (chọn 8,75 pt cho khung 240×90), dấu ✓ mờ, viền, màu, chữ đậm, PNG trong suốt (SMask). Font được reportlab nhúng dạng subset. Cùng một bản vẽ dùng được cho **xem trước** (render PNG bằng pypdfium2) | Phải tự viết bộ dàn trang (chính là T3.09). Giờ hiển thị phải chốt **trước** khi ký, nên chỉ hiện giờ máy; giờ của TSA chỉ có sau khi ký |

**Khuyến nghị cho T3.09:** dùng **B2**. Bộ vẽ mẫu chữ ký (I15–I18) là một hàm thuần `render_appearance(template, data, size) -> pdf_bytes`. Studio (T3.10) xem trước bằng chính hàm đó, sau đó render PNG. Bỏ `TextStampStyle`. Nếu vẫn dùng nó ở đâu đó thì bắt buộc đi qua `font_1000_upm`. Nên báo lỗi UPM cho upstream pyHanko.

## 6. TSA

- ❌ Từ container: DigiCert, Sectigo, FreeTSA, SSL.com, GlobalSign đều bị proxy chặn (403 ở bước CONNECT). Đây là giới hạn của môi trường spike, không phải của pyHanko.
- ✅ Với TSA cục bộ: `HTTPTimeStamper` (aiohttp) chạy đúng cho B-T, B-LT, B-LTA. pyHanko dự trữ chỗ cho chữ ký có tính sai số của TSA.
- 🔶 `HTTPTimeStamper` dùng aiohttp. aiohttp **mặc định không đọc biến môi trường proxy** (`trust_env=False`). Nếu máy chủ dự án đi Internet qua proxy công ty, T3.06 phải truyền `aiohttp.ClientSession(trust_env=True)`.
- 🔶 Chưa có URL TSA chính thức của các CA Việt Nam. `s1_token_probe.py --probe-tsa URL...` cho phép thử nhanh khi có URL (thường ghi trong tài liệu phần mềm ký của CA).

## 7. Rủi ro còn lại (cập nhật R1)

| Rủi ro | Mức sau spike | Ghi chú |
|---|---|---|
| Driver token VN không chạy trên macOS/Linux | **Cao, chưa đổi** | Chưa có token thật. Cần chạy checklist mục 9 |
| Windows: Python 64-bit không nạp được DLL 32-bit (`SysWOW64`) | Trung bình 🔶 | Công cụ dò ghi rõ Python 32/64-bit. Lõi đóng gói 64-bit nên phải dùng DLL trong `System32` |
| Driver CSP tự bật cửa sổ PIN (Viettel-CA V6) | Trung bình 🔶 | Dùng module PKCS#11 (`viettel-ca_v6.dll`), không dùng `_s.dll` (TOKENS.md) |
| Token không có `CKM_SHA256_RSA_PKCS` | **Thấp** ✅ | Đã có đường raw `CKM_RSA_PKCS` |
| Token ECDSA | Thấp 🔶 | pyHanko hỗ trợ, nhưng SoftHSM chưa thử cơ chế ECDSA có băm |
| Adobe Reader không công nhận chữ ký / giao diện | Trung bình 🔶 | Đã đưa sẵn file mẫu + `root.crt.pem` để thử sớm (mục 9, bước 8) |
| Khóa token vì app thử lại PIN | **Thấp** ✅ | Thiết kế: đọc cờ trước, hỏi PIN 1 lần, sai thì dừng; không có vòng lặp thử lại |
| pyHanko đổi API giữa các bản (đã thấy hàm LTV cũ bị bỏ) | Trung bình | Ghim phiên bản; bọc pyHanko sau một lớp `SignEngine` của Chef |

## 8. Đề xuất thiết kế API (T3.01, T3.06, T3.09)

Theo mô hình Operation (BLUEPRINT mục 3) và JSON-RPC (D31). PIN chỉ đi qua RPC trong bộ nhớ, không bao giờ ghi log.

**T3.01 `chef_core.signing.pkcs11` (TokenService)**
- `probe_module(path) -> ModuleInfo`: chạy trong **tiến trình con có hạn giờ**, trả về hãng, phiên bản Cryptoki, slot, token, cơ chế (`sha256_rsa`, `rsa_raw`, `ecdsa`), chứng thư. Không cần PIN.
- `list_tokens() -> [TokenRef]` (module, slot_id, serial, label, `pin_state: ok|count_low|final_try|locked|to_be_changed`, `protected_auth_path`).
- `list_certificates(token) -> [CertInfo]` (`cka_id`, subject, MST/CCCD đã tách, hạn dùng, `is_ca`, có khóa riêng tương ứng hay không). Không cần PIN.
- `login(token, pin | None) -> LoginResult`: **đọc lại cờ ngay trước khi gọi**. Nếu `locked` thì từ chối luôn. Nếu `final_try` thì UI phải có xác nhận riêng (`confirm_final_try=True`). PIN sai thì trả lỗi kèm cờ mới, **không bao giờ tự thử lại**. Mỗi token giữ một session đã đăng nhập, dùng chung cho cả lô ký. Có `logout(token)` và tự đăng xuất khi hết giờ chờ hoặc khi phát hiện rút token.
- Khóa và chứng thư xác định bằng `CKA_ID`, không dùng nhãn.

**T3.06 `SignOperation` (Params pydantic)**
- `input`, `output` (mặc định `_da-ky`), `credential` (`{kind: pkcs11, token, cka_id}` | `{kind: pfx, path}`), `level: B-B|B-T|B-LT|B-LTA`, `tsa_urls: [..]` (thử lần lượt, có dự phòng), `field: {existing_name} | {page, rect}`, `appearance: TemplateRef | None`, `reason`, `location`, `certify: None | MDPPerm`, `md: sha256`.
- Cài đặt: `IncrementalPdfFileWriter` (luôn incremental) + `PdfSigner`. `ValidationContext` có 2 hệ Root CA VN cho B-LT/B-LTA. Tự chuyển sang raw mechanism nếu token không có `SHA256_RSA_PKCS`. Ký hàng loạt dùng lại session.
- Sau khi ký thì chạy kiểm tra (`validate_pdf_signature`) và trả về tóm tắt cho panel I34.

**T3.09 Appearance renderer**
- `render_appearance(template, data, box) -> bytes(PDF 1 trang)`. Template gồm: bố cục (ảnh trái/phải/trên/nền, con dấu chồng), danh sách dòng có nhãn, font tiếng Việt đóng gói sẵn, cỡ chữ cố định hoặc tự co, màu, viền, ✓, logo. Ký thì dùng `StaticStampStyle.from_pdf_file`; xem trước thì render PNG bằng pypdfium2.

## 9. Checklist thử với token thật (chủ dự án chạy trên máy mình)

Chuẩn bị:
1. Cài driver/phần mềm token của CA (Viettel-CA, VNPT-CA, FPT-CA, MISA-CA, Ban Cơ yếu…), cắm token, kiểm tra phần mềm của CA vẫn nhận token.
2. Cài `uv` (https://docs.astral.sh/uv/). Mở terminal tại thư mục repo: `cd spikes` rồi `uv sync`.
3. Chép một file PDF **không quan trọng** vào thư mục `spikes`, ví dụ `mau.pdf`.

Các bước:

| Bước | Lệnh | Cần ghi lại |
|---|---|---|
| 1. Dò tự động (không cần PIN) | `uv run python s1_token_probe.py` | Có tìm thấy thư viện PKCS#11 không? Đường dẫn? Token, chứng thư hiện ra? |
| 2. Nếu không thấy | Tìm file driver (Windows: `C:\Windows\System32\`, tên trong TOKENS.md, ví dụ `viettel-ca_v6.dll`; macOS: `/usr/local/lib/*.dylib`, `/Library/...`; Linux: `/usr/lib/*.so`) rồi chạy `uv run python s1_token_probe.py --lib "ĐƯỜNG_DẪN"` | Tên file đúng của driver |
| 3. Xem cờ PIN | Dòng `cờ PIN:` trong kết quả | Nếu thấy `USER_PIN_FINAL_TRY` hoặc `USER_PIN_LOCKED` thì **DỪNG**, không ký thử |
| 4. Xem cơ chế ký | `SHA256_RSA_PKCS=… RSA_PKCS(raw)=…` | Nếu `SHA256_RSA_PKCS=False` thì bước 5 thêm `--raw` |
| 5. Ký thử (hỏi PIN **1 lần**) | `uv run python s1_token_probe.py --lib "ĐƯỜNG_DẪN" --sign mau.pdf` | Thành công? Thời gian đăng nhập/ký? Driver có tự bật cửa sổ PIN riêng không? |
| 6. Thử TSA | `uv run python s1_token_probe.py --lib "ĐƯỜNG_DẪN" --probe-tsa` (thêm URL TSA của CA nếu biết) | TSA nào chạy |
| 7. Ký B-T | thêm `--tsa URL_CHẠY_ĐƯỢC` vào bước 5 | Thành công? |
| 8. Kiểm tra chéo | Mở `mau_da-ky.pdf` bằng **Adobe Acrobat Reader**, Foxit, vSignPDF | Adobe báo gì? Ảnh chụp bảng chữ ký |
| 8b. Kiểm tra giao diện (không cần token) | Mở `spikes/s1/out/b2_visible_custom_appearance.pdf`, `e2_second_signature.pdf`, `d_blta.pdf` bằng Adobe. Muốn Adobe báo "hợp lệ" thì thêm `spikes/s1/out/pki/root.crt.pem` vào danh sách tin cậy (*Preferences → Signatures → Identities & Trusted Certificates*), **chỉ trên máy thử, xóa sau khi xong** | Giao diện chữ ký hiển thị đúng tiếng Việt không? |
| 9. Gửi kết quả | File `token_probe_report.json` (MST/CCCD đã được che sẵn) + ảnh chụp bước 8 | Ghi vào TOKENS.md |

An toàn: công cụ **không bao giờ nhập lại PIN sai**. Nhập sai một lần là chương trình dừng và báo cờ mới. Không chạy lại liên tục khi không chắc PIN. Token thật thường khóa sau vài lần sai và phải nhờ CA mở khóa.

Bảng ghi kết quả (điền vào TOKENS.md):

| OS | CA | Đời token | Thư viện PKCS#11 | Liệt kê | Ký | Raw cần? | TSA chạy | Adobe |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |

## 10. Ước lượng lại v0.3

| Task | Cũ | Mới | Lý do |
|---|---|---|---|
| T3.01 Lớp PKCS#11 | 2,5 | 2,5 | API đơn giản, nhưng thêm dò driver trong tiến trình con và quản lý trạng thái đăng nhập theo token |
| T3.02 Danh bạ driver + quét | 2 | 2 | `s1_token_probe.py` đã có sẵn danh sách và logic quét để tái dùng |
| T3.03 Chẩn đoán + cảnh báo PIN | 2 | 2 | Cờ PIN đọc được; logic khóa phải thử bằng giả lập (SoftHSM không khóa) |
| T3.05 Thông tin chứng thư | 1,5 | 1 | Tách MST/CCCD đã làm xong |
| T3.06 Engine ký | 3 | 2,5 | Mọi mức PAdES đã chạy; còn TSA dự phòng + proxy + Root CA VN |
| T3.07 Certify + nhiều người ký | 1,5 | 1 | Đã chạy đúng, kể cả trường hợp từ chối |
| T3.08 Kiểm tra chữ ký | 3 | 3 | API AdES phức tạp, cần dịch kết quả sang tiếng Việt |
| T3.09 Bộ vẽ giao diện | 3 | 3 | Theo hướng B2; bỏ được phần "sửa font cho pyHanko" |
| T3.14 Kiểm chéo + token thật | 2 | **3** | Rủi ro driver/Adobe chưa giảm; thêm thời gian cho từng đời token |
| Còn lại (T3.04, T3.10–T3.13) | 11,5 | 11,5 | Không bị spike ảnh hưởng |
| **Tổng v0.3** | **32** | **31,5** | Gần như không đổi; rủi ro dời từ "thư viện" sang "driver thật" |

Phần thư viện đã ổn. Ước lượng chỉ còn phụ thuộc vào kết quả checklist mục 9: nếu driver macOS/Linux của CA chủ dự án dùng không ổn thì thêm khoảng 2–3 điểm cho đường dự phòng I8 (kho chứng thư OS), và có thể kéo I8 từ v0.4 lên sớm hơn.
