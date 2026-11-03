# Chef PDF: Kế hoạch đo kiểm và chỉnh giao diện

> Do Opus 5.5 tư vấn (2026-11-04), Haiku thực hiện theo từng lượt nhỏ. **Mục tiêu của chủ dự án: không còn nút nào lệch hàng, lệch viền, khoảng cách không đều.** Cập nhật mục "Tiến độ" ở cuối file sau mỗi lượt.

## 1. Phát hiện ban đầu (đọc code)

1. **~25 biến `var(--…)` không tồn tại** trong `apps/ui/src/app/styles/tokens.css`:
   - Có fallback màu cứng kiểu GitHub: `--color-border`, `--color-muted`, `--color-surface-2`, `--color-warning/danger/success/accent`, `--border`, `--accent`, `--danger`, `--surface`, `--surface-1/2`, `--text`, `--c-surface-3`, `--c-text-inverse`, `--text-on-dark`. Hậu quả: chế độ tối hỏng, lệch tông.
   - Không có fallback: `watch.css` (`--border-default`, `--surface`, `--text-muted`…) và `forms.css:44,64,73`: viền rơi về `currentColor` (đậm như chữ).
   - Lỗi gõ `var(--c-text-)` ở `features/sign/sign.css:148,186,249`.
   - Biến cục bộ hợp lệ, bỏ qua: `--an-c`, `--kind-c`, `--thumb-w`, `--tile-bg`, `--tile-fg`.
2. Fallback sai lệch (compress, convert, inspect): `var(--space-3, 10px)` thực ra ra 6px. Đừng tin số trong fallback.
3. **rem ở 8 file** (workflow, watch, layout/review, pagetools, inspect, security, compress, preflight): `html` không đặt font-size nên **1rem = 16px**, ra giá trị lẻ (0.35rem = 5.6px, 0.92rem = 14.72px).
4. **Lệch mép trong hộp thoại:** `watch.css:1` đặt `.dlg__body { padding: 1rem }` (16px) trong khi header/footer 24px; `workflow.css:1` đặt body padding 0.
5. `.field + .field { margin-top: 16px }` (`components.css:316`) vẫn áp dụng khi Field nằm ngang; chỉ `TaskDialog.css:28` có reset. `.ov-row` (`overlay.css:4`) dùng `align-items: flex-end`.
6. Điều khiển 28px cạnh ô nhập 32px: `.ov-color__swatch` (overlay.css:401), `.tpl__color` (signTemplate.css:115), `.outline-edit__icon` (bookmarkEditor.css:23, button tự viết radius 6px), `.topbar__search` (app.css:113), `.findbar__input` (Viewer.css:94).
7. Kích thước nhỏ hợp lệ (cần token hoặc allowlist): mục menu/select 30px, thanh trạng thái 20/22px, nút đóng tab tài liệu 20px `!important`, `.sidenav__tab` 24px, chip `.split__var` 20px, `.scan-preview__page` 24px, `.capture__tools button` 24px.
8. Hoạt ảnh `dialog-in` có `scale(0.985)`: đo lúc đang chạy sẽ sai.
9. Chân TaskDialog không có `flex-wrap`, dễ tràn ở hộp cỡ lg/màn hẹp.
10. `useUi` không lộ ra `window`; mock core không mở được tài liệu, nên bộ kiểm tra dùng **lõi Python thật** (như `start-tiles.spec.ts`, `page-menu.spec.ts`).

## 2. Bộ kiểm tra `tests/e2e/specs/ui-audit.spec.ts`

**File cần tạo:** hook 1 dòng trong `apps/ui/src/main.tsx`: `(window as unknown as { __chefUi?: typeof useUi }).__chefUi = useUi;` (không bọc điều kiện, vì e2e dùng bản dist production; ghi quyết định vào NOTES.md); `tests/e2e/fixtures/uiAudit.ts` (hàm đo chạy qua `page.evaluate`, bảng ALLOW và SCALE); `tests/e2e/ui-audit-baseline.json` (commit); `tests/e2e/ui-audit-out/` (đưa vào .gitignore; không ghi vào `test-results/` vì Playwright xóa nó mỗi lần).

**Chuẩn bị (`beforeAll`, `test.setTimeout(180_000)`):**
1. Sinh PDF mẫu bằng `tools5_pages_corpus.py` (như page-menu.spec.ts).
2. `launchApp({ args: [source, '--force-device-scale-factor=1'], env: { CHEF_CORE_CMD: realCoreCmd } })`, viewport 1280×820, chờ `.pdfViewer .page canvas`.
3. **Thay hộp thoại hệ thống bằng hàm giả TRƯỚC mọi thao tác** (`dialog.showOpenDialog/showSaveDialog/showMessageBox`) kẻo treo cả lượt.
4. `prepare(page)` trước mỗi lần đo: `addStyleTag` tắt animation/transition/caret (CSP chặn script inline nên chỉ dùng `page.evaluate`, KHÔNG dùng addScriptTag); chờ `document.fonts.ready`; `emulateMedia({colorScheme:'light'})` + `data-theme='light'`; `mouse.move(0,0)` và blur để tooltip không bật; chờ hết `.spinner` trong `.dlg` tối đa 10 giây (quá hạn ghi `settle-timeout` và vẫn đo).
5. Dựng chỉ mục class → CSS ở phía Node (quét `apps/ui/src/**/*.css`) để báo `cssHits`.

**Danh sách màn hình** (điều khiển bằng `__chefUi.getState()`, không bấm theo chữ tiếng Việt):
`start` (lần chạy riêng không mở tài liệu); `main:<tab>` cho 8 FUNCTION_TABS (tab `view` lặp thêm 5 sidebarTab); lớp phủ (palette, jobPanel, findbar); menu (giai đoạn 2); **mọi DialogId** (đọc `ui.ts` lúc chạy bằng regex khối `export type DialogId`; mỗi id: `closeDialog` → `openDialog(id, DIALOG_DATA[id])` → chờ `.dlg` tối đa 8 giây, không thấy thì ghi `open-failed` kèm console/pageerror → `prepare` → đo → chụp ảnh; thêm biến thể từng `[role=tab]` trong dialog và `.collapsible__trigger` đang đóng). **Không bấm nút nào khác, không nhấn Enter.** Khung phụ 960×640 cho hộp thoại, bật bằng `UI_AUDIT_VIEWPORTS=1280x820,960x640`.
`DIALOG_DATA`: `capture: {purpose:'book'}`, `merge: [source, source]`, `repair: {path: source, message:'x'}`, `stamp: {pages:[1]}`, `pdfToImages: {pages:[1]}`, `cropReview: {page:0}`, `recovery: []`; còn lại `undefined`.

**Chia test:** `describe.configure({mode:'serial'})`, mỗi màn hình một `test()` dùng chung một app. Bẫy: serial bỏ qua các test sau khi một test lỗi, nên mỗi test `try/catch` và ghi lỗi vào báo cáo; chỉ test cuối (so baseline) được fail; nếu `page.isClosed()` thì khởi chạy lại.

**Thu thập phần tử (trong `auditInPage`, tự chứa mọi helper, không import, không enum):** phạm vi `.dlg[role=dialog]` nếu có, ngược lại `#root`. Bỏ qua: `.pdfViewer, .textLayer, .annotationLayer, canvas, svg *, .tip, .menu, .select-content, [data-audit="ignore"]`. Điều khiển: `button, [role=button], input:not([type=checkbox],[type=radio],[type=range],[type=hidden],[type=color],[type=file]), [role=combobox], .select-trigger, .segmented` (không tính `.checkbox, .radio-dot, .switch, .segmented__item, .menu__item, .select-item, .ftab, [role=tab]`). Hiển thị: rect ≥ 1px, `checkVisibility(...)`, không trong `[aria-hidden=true], [inert], [hidden], .sr-only`. Phân loại: `btn`, `icon-btn` (không chữ), `input`, `select`, `segmented`, `raw-button` (button không class chuẩn).

**Các luật** (ngưỡng; mức):
| Luật | Nội dung | Ngưỡng | Mức |
|---|---|---|---|
| `row-misaligned` | Ghép cặp điều khiển chồng dọc ≥ 50%, cách ngang 0..64px, tổ tiên chung ≤ 4 cấp; union-find thành hàng; cùng chiều cao so top/bottom với giá trị top phổ biến nhất, khác chiều cao so tâm dọc | top/bottom > 0.5px; tâm > 1px | error |
| `row-mixed-height` | Hàng có nhiều chiều cao (ví dụ 28 cạnh 32) | > 0.5px | warn |
| `control-height` | Chiều cao ∉ {26,32,38} theo ngữ cảnh (xem ALLOW); icon-btn không chữ thì w == h | ±0.5px | btn/input: error; còn lại warn |
| `gap-uneven` | ≥ 3 anh em cùng cha, khe giữa theo `left`; bỏ qua `space-*` và khe có phần tử không phải điều khiển | max − min > 1px | warn |
| `gap-off-scale` | `column-gap`/`row-gap` của cha flex/grid ∉ {0,2,4,6,8,12,16,20,24,32,40,56} | chính xác | warn |
| `controls-touching` | Hai điều khiển kề nhau khe 0 ≤ x < 4, trừ trong `.segmented` | < 4px | warn |
| `radius-off-scale` | Phần tử có nền/viền/shadow, góc ∉ {0,3,5,7,10,14}, trừ 999 và 50% | chính xác | warn |
| `font-off-scale` | font-size ∉ {11,12,13,15,18,24,30} | ±0.1 | warn |
| `text-overflow` | `scrollWidth > clientWidth + 1`, `overflow-x: visible` | 1px | error |
| `text-truncated` | Như trên nhưng có ellipsis | 1px | info; nút/nhãn/tiêu đề: warn |
| `label-overflow` | Chữ nút rộng hơn vùng nội dung của nút | 1px | error |
| `control-clipped` | Tổ tiên `overflow: hidden/clip` cắt khung điều khiển (auto/scroll không tính) | 0.5px | error |
| `unexpected-hscroll` | Vùng cuộn trong `.dlg` có `scrollWidth > clientWidth + 1` | 1px | error |
| `outside-dialog`/`offscreen` | Điều khiển vượt khung `.dlg` hoặc viewport (trừ trong vùng cuộn) | 0.5px | error |
| `dialog-padding-mismatch` | padding trái/phải của header/body/footer khác nhau | chính xác | warn |
| `footer-right-edge` | Mép phải điều khiển cuối ≠ `footer.right − border − padding-right` | 0.5px | error |
| `footer-wrapped`/`footer-overflow` | Điều khiển trong footer có > 1 top / `scrollWidth > clientWidth` | — | warn / error |
| `primary-not-last`, `nonstandard-control` | Nút chính không ở ngoài cùng bên phải; button tự viết | — | info |
| `open-failed`, `settle-timeout` | Từ bước mở màn hình | — | error / info |

Tránh dương tính giả: lọc phần tử ẩn, tắt hoạt ảnh, chờ font, DPR = 1; không kiểm text trên `input`/`textarea`/`[contenteditable]`; bỏ phần tử có transform; hàng bị wrap tự tách vì không chồng dọc; icon-btn không kiểm text. **Bảng ALLOW** mỗi mục bắt buộc có `reason`, chỉ thêm sau khi đã xem ảnh chụp: `.status *` {20,22}; `.doctabs *` {20}; `.sidenav__tab` {24}; `.split__var, .scan-preview__page` {20,24} (chip); `.capture__tools *` ignore; `.merge__grip` ignore (drag handle); `.workflow-dialog` bỏ `dialog-padding-mismatch` (tạm).

**Báo cáo:** `ui-audit-out/report.json` (meta: commit, date, viewport, dpr, theme, distBuiltAt, srcNewestAt, staleDist; summary: total/bySeverity/byRule/byScreen/topCssFiles; screens[].findings[] với rule, severity, message, measured, expected, elements[{path,text,rect,classes,cssHits}], hint) + `report.md` (bảng luật × số lượng; 20 file CSS nhiều phát hiện nhất = thứ tự sửa; mỗi màn hình một mục) + ảnh chụp có khung đỏ đánh số khớp phát hiện. **Cảnh báo dist cũ** nếu file mới nhất trong `apps/ui/src` mới hơn `apps/ui/dist/index.html` (chế độ strict thì fail).

**Chế độ (biến môi trường):** mặc định chỉ báo cáo; `UI_AUDIT_STRICT=1` so số lượng theo `(screen, rule)` với baseline (ratchet theo số lượng, không theo selector), `UI_AUDIT_UPDATE=1` ghi lại baseline; `UI_AUDIT_ONLY=watch,merge` chạy một phần; `UI_AUDIT_SNAPSHOT=1` dùng `expect.soft(page).toHaveScreenshot(...)` (animations disabled, caret hide, `maxDiffPixels` mặc định 0; thư mục snapshot vào .gitignore) để kiểm "không đổi điểm ảnh"; `UI_AUDIT_THEME=dark` chỉ chụp ảnh. Lệnh: `pnpm --filter @chef/ui build && pnpm --filter @chef/e2e exec playwright test ui-audit`. Chỉ bật strict trên máy Windows của chủ dự án (font khác nhau làm số đo khác).

## 3. Chiến lược sửa

**Nguyên tắc:** không đổi giá trị token hiện có, chỉ THÊM token. Thay giá trị theo thứ tự: khớp chính xác trước (không đổi điểm ảnh) → xấp xỉ ±1px (commit riêng) → lệch ≥ 2px hoặc hòa khoảng cách thì ghi vào danh sách quyết định cho chủ dự án, KHÔNG tự quyết. Mỗi commit một loại thay đổi trên tối đa 2 file, tiếng Anh, thể mệnh lệnh (`UI polish: tokenize spacing in watch.css`).

**Script tĩnh `scripts/css-audit.mjs`** (Node thuần, kèm unit test các ca `calc()`, `@keyframes`, shorthand nhiều giá trị, giá trị âm, `inset`):
- Chế độ báo cáo (mặc định, `--json`): theo file/dòng liệt kê px ngoài thang theo loại thuộc tính, rem, `var()` không định nghĩa (so với tokens.css, trừ biến khai báo cục bộ), fallback thừa/sai, font-size px, `!important`.
- `--fix=exact`: chỉ dòng khai báo `prop: value;`; bỏ qua comment, `@keyframes`, `@media`, `calc()`, `box-shadow`, `transform`, `grid-template-*`, `width`, `top/left`, giá trị 0, 1px, %. Khoảng cách (`gap`, `row-gap`, `column-gap`, `padding*`, `margin*`): 2→`--space-1`, 4→`-2`, 6→`-3`, 8→`-4`, 12→`-5`, 16→`-6`, 20→`-7`, 24→`-8`, 32→`-9`, 40→`-10`, 56→`-11` (giá trị âm sửa tay). Bo góc: 3→xs, 5→sm, 7→md, 10→lg, 14→xl, 999px→`--radius-full`. font-size: 11/12/13/15/18/24/30 → `--text-xs/sm/md/lg/xl/2xl/3xl`. height/min-height điều khiển: 26/32/38 → `--control-h-sm/--control-h/--control-h-lg`. rem nhân 16, chỉ đổi khi ra số nguyên trong thang, còn lại sửa tay. `var(--defined, x)` → `var(--defined)`.
- `--fix=approx`: bo góc 4→xs, 6→sm, 8→md, 12→lg (hòa làm tròn xuống); khoảng cách ±1px.
- `--fix=alias`: `--color-border|--border|--border-default|--border-subtle` → `--c-border`; `--color-muted|--text-muted` → `--c-text-3`; `--surface|--surface-1` → `--c-surface`; `--color-surface-2|--surface-2|--surface-subtle` → `--c-surface-2`; `--color-warning|--text-warning` → `--c-warning` (tương tự danger/success/accent); `--text` → `--c-text`; `--c-surface-3`, `--text-on-dark`, `--c-text-inverse` → token mới `--c-inverse-bg/--c-inverse-text` (lấy từ `.tip`: #22262f / #f1f3f6); `--c-text-` → `--c-text-3` (xem tay). Thay thì bỏ luôn fallback.
- Giữ kiểu xuống dòng CRLF/LF của từng file; sau khi chạy `pnpm prettier --write <files>`.

**Thứ tự sửa, thành phần chung trước:**
1. `tokens.css` chỉ thêm: `--control-h-xs: 22px` (thanh trạng thái, tab tài liệu), `--menu-item-h: 30px`, `--chip-h: 20px` (chờ chủ dự án duyệt), `--c-inverse-bg`, `--c-inverse-text` (sáng và tối).
2. `components.css`: menu/select dùng `--menu-item-h`; `.tip` dùng `--c-inverse-*`; giới hạn `.field + .field` bằng `:is(.field__row,.form-row,.ov-row,.ov-position__fields) > .field + .field { margin-top: 0 }`; thêm `.form-row` (flex, wrap, `gap: var(--space-5)`, `align-items: flex-start`).
3. Dialog/TaskDialog: `.dlg__footer { flex-wrap: wrap; row-gap: var(--space-4) }` (chỉ khi ở 960px có `footer-overflow`); bỏ hai chỗ ghi đè `.dlg__body` (watch, workflow).
4. `app.css`: thanh trạng thái và `.doctab__close` dùng `--control-h-xs`, bỏ `!important`; `.topbar__search` 28 → `--control-h-sm` (cần chủ dự án duyệt).
5. Sửa alias màu theo nhóm file: (a) watch, forms, layout/review, sign; (b) nhóm `--color-*`; (c) nhóm `--surface-*`, `--text-on-dark`, `--accent`, `--danger`, `--border`. Chụp sáng và tối, xem tay; commit nêu rõ đây là thay đổi cố ý (watch.css hiện vẽ viền màu chữ).
6. CSS tính năng theo thứ tự `topCssFiles` (số dòng px thô: textedit 18, annots 17, redact 16, inspect 13, capture 11, forms 9, bookmarkEditor 8, security 8, overlay 8, docTools 8, preflight 7, layers 7…; rem: workflow chia 2 lượt, watch, review, pagetools).
7. Điều khiển tự viết: `.outline-edit__icon` → `IconButton size="sm"`; `.ov-color__swatch`, `.tpl__color` → `height: var(--control-h)`; hàng Field + Button → đặt Button vào `.field__row` bên trong Field.

## 4. Các lượt (mỗi lượt ≤ ~30 phút, một commit; làm theo thứ tự)

**Chuẩn bị:** A1 hook `__chefUi` + ghi NOTES; A2 `css-audit.mjs` chế độ báo cáo (+ unit test); A3 khung spec (khởi chạy, prepare, liệt kê màn hình, mở từng DialogId, ảnh chụp, `open-failed`, report.json tối thiểu); A4 luật theo từng phần tử (control-height, radius, font, text-overflow, label-overflow, clipped, hscroll, outside-dialog); A5 luật theo quan hệ (union-find hàng, row-misaligned, mixed-height, gap-*, dialog padding, footer); A6 cssHits, report.md, khung đỏ trên ảnh, baseline + strict, snapshot, phát hiện dist cũ; A7 chạy toàn bộ, xem 10 màn hình nhiều phát hiện nhất, bổ sung ALLOW có lý do, commit baseline.
**Thành phần chung:** B1 token mới (không đổi điểm ảnh); B2 `--fix=exact` cho `components/` và `app/` (diff snapshot phải bằng 0); B3 bỏ fallback thừa toàn bộ file (diff 0); B4–B6 alias màu 3 nhóm (chụp sáng/tối, xem tay); B7 giới hạn `.field + .field` + `.form-row`; B8 footer wrap + bỏ ghi đè `.dlg__body`; B9 token thanh trạng thái/tab/menu.
**Tính năng:** C1…Cn với 1–2 file mỗi lượt: `exact` (diff 0) → commit → `approx` (diff chỉ ở vùng dự kiến) → commit → sửa các phát hiện error của file đó. D: lập danh sách quyết định cho chủ dự án (các giá trị 10px, 14px, chip, ô tìm kiếm 28px, dải rem lẻ), ghi vào NOTES.md.

**Checklist mỗi lượt:** (1) `git status` sạch; (2) build UI rồi chụp "trước": `UI_AUDIT_SNAPSHOT=1 UI_AUDIT_ONLY=<màn> playwright test ui-audit --update-snapshots`; (3) sửa; (4) **build lại UI**; (5) chạy lại snapshot + audit; (6) lượt `exact` phải 0 diff, lượt khác chỉ diff ở chỗ dự kiến, số phát hiện không tăng; (7) `node scripts/css-audit.mjs <file>`; (8) `pnpm lint && pnpm --filter @chef/ui test`; (9) `UI_AUDIT_UPDATE=1` ghi baseline; (10) commit.
**Cách sửa lỗi hay gặp:** `row-misaligned`: cha là flex `align-items:center` hoặc `.field__row`, không dùng inline-block; `control-height`: dùng `Button`/`IconButton`/`TextInput` với `size`, không đặt height thủ công; `gap-*`: dùng `gap` trên cha, bỏ margin ở con; `footer-*`: footer chỉ chứa `DialogSpacer` và Button; `text-overflow`: rút gọn chuỗi i18n hoặc `min-width:0` + ellipsis + `title`.

## 5. Rủi ro và bẫy

1. e2e chạy bản dist: quên build lại UI thì đo bản cũ. Spec phải cảnh báo/fail khi dist cũ.
2. rem = 16px: đừng suy kích thước từ fallback.
3. Sửa alias màu cố ý đổi giao diện: xem cả chế độ tối, nêu rõ trong commit.
4. Một số hộp thoại có thể chạm thiết bị thật (certs, tokenWizard, scan, signDoc: dò USB token, máy quét): timeout dài, ghi `settle-timeout`, tuyệt đối không bấm Run; hộp thoại hệ thống phải được thay bằng hàm giả.
5. Chế độ serial dừng ở lỗi đầu: dùng try/catch hoặc `expect.soft`.
6. Không dùng hàm ngoài trong `page.evaluate`; CSP chặn `addScriptTag` inline.
7. Đo trong lúc hoạt ảnh `scale(0.985)` hoặc trước khi font tải xong là sai; DPR 125–150% trên Windows cho số lẻ, nên ép `--force-device-scale-factor=1`.
8. Tooltip Radix bật khi focus làm bẩn ảnh: blur và đưa chuột về (0,0).
9. Thay hàng loạt bằng regex dễ phá `calc()`, `@keyframes`, shorthand, giá trị âm, `inset`: script phải có unit test.
10. Đừng sửa layout chỉ để tắt cảnh báo; xem ảnh trước; thứ cố ý (canvas, thumbnail, overlay ảnh) đưa vào ALLOW kèm lý do.
11. Đặc hiệu CSS (`.watch-actions > button`, `!important` ở `.doctab__close`, `.btn:focus-visible`): đổi class/thành phần có thể làm mất override.
12. Baseline theo selector dễ gãy: dùng số lượng; font khác giữa các hệ điều hành: strict chỉ trên Windows.
13. Thay `.field + .field` toàn cục có thể dịch chuyển ~63 hộp thoại: chỉ giới hạn theo container ngang, rồi so snapshot toàn bộ.
14. Quyết định thẩm mỹ cần chủ dự án duyệt (hòa 6/8/10/12px, chip 20/24, ô tìm kiếm 28px): agent KHÔNG tự quyết.

## Tiến độ

| Lượt | Trạng thái |
|---|---|
| A1–A7 | ⬜ |
| B1–B9 | ⬜ |
| C (từng file) | ⬜ |
| D (danh sách quyết định) | ⬜ |
